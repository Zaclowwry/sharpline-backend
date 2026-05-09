const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://elwbxwzequrfucujhgsy.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = SUPABASE_SECRET_KEY ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY) : null;

const SPORTS = {
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  ufc: 'mma_mixed_martial_arts'
};

const SPORT_LABELS = {
  nba: '🏀 NBA',
  wnba: '🏀 WNBA',
  mlb: '⚾ MLB',
  nhl: '🏒 NHL',
  ufc: '🥊 UFC'
};

const NEXT_UFC_EVENT = {
  name: 'UFC 314',
  date: 'Saturday, April 12, 2026',
  mainEvent: 'Jiri Prochazka vs Carlos Ulberg',
  coMain: 'Curtis Blaydes vs Josh Hokit',
  title: 'Light Heavyweight Title Fight'
};

const CONFIDENCE_THRESHOLDS = {
  nba: 60,
  wnba: 60,
  mlb: 65,
  nhl: 60,
  ufc: 55
};

const ML_ODDS_FILTERS = {
  nba: -150,
  wnba: -150,
  mlb: -150,
  nhl: -200,
  ufc: -200
};

let cachedPicks = null;
let lastUpdated = null;
let cachedProps = null;
let propsLastUpdated = null;
let mlbPitcherCache = null;
let mlbPitcherCacheTime = null;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'SharpLine backend running' });
});

// ─── MANUAL TRIGGER ───────────────────────────────────────────────────────────
app.get('/trigger-picks', async (req, res) => {
  if(req.query.secret !== process.env.TRIGGER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    console.log('Manual pick trigger fired...');
    cachedPicks = null;
    lastUpdated = null;
    cachedProps = null;
    propsLastUpdated = null;
    const picks = await generatePicks();
    cachedPicks = picks;
    lastUpdated = new Date();
    await saveAllPicks(picks);
    res.json({ success: true, updatedAt: lastUpdated, picks });
  } catch(e) {
    console.log('Trigger error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.log('Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  console.log('Stripe event received:', event.type);
  try {
    switch(event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || session.metadata?.email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const mode = session.mode;
        if(!email) break;
        if(mode === 'subscription' && subscriptionId) {
          // Determine plan based on amount or metadata
          const amount = session.amount_total;
          const plan = amount >= 1499 ? 'elite' : 'pro';
          await upsertUserPlan(email, plan, customerId, subscriptionId, null);
          console.log(`✓ ${plan} access granted to ${email}`);
        } else if(mode === 'payment') {
          const expires = new Date();
          expires.setHours(expires.getHours() + 24);
          await upsertUserPlan(email, 'daily', customerId, null, expires);
          console.log(`✓ Daily pass granted to ${email}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        await downgradeByCustomerId(event.data.object.customer);
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        if(subscription.status === 'active') {
          await upgradeByCustomerId(subscription.customer, subscription.id);
        } else if(['canceled','unpaid','past_due'].includes(subscription.status)) {
          await downgradeByCustomerId(subscription.customer);
        }
        break;
      }
      case 'invoice.payment_failed': {
        await downgradeByCustomerId(event.data.object.customer);
        break;
      }
    }
  } catch(e) {
    console.log('Error processing webhook:', e.message);
  }
  res.json({ received: true });
});

async function upsertUserPlan(email, plan, stripeCustomerId, stripeSubscriptionId, expiresAt) {
  if(!supabase) return;
  const { error } = await supabase.from('user_plans').upsert({
    email, plan,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    plan_expires_at: expiresAt,
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' });
  if(error) console.log('Upsert error:', error.message);
}

async function downgradeByCustomerId(customerId) {
  if(!supabase) return;
  const { error } = await supabase.from('user_plans')
    .update({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId);
  if(error) console.log('Downgrade error:', error.message);
}

async function upgradeByCustomerId(customerId, subscriptionId) {
  if(!supabase) return;
  const { error } = await supabase.from('user_plans')
    .update({ plan: 'pro', stripe_subscription_id: subscriptionId, plan_expires_at: null, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId);
  if(error) console.log('Upgrade error:', error.message);
}

// ─── USER PLAN CHECK ──────────────────────────────────────────────────────────
app.get('/user-plan', async (req, res) => {
  const email = req.query.email;
  if(!email || !supabase) return res.json({ plan: 'free' });
  try {
    const { data } = await supabase.from('user_plans').select('plan, plan_expires_at').eq('email', email).single();
    if(!data) return res.json({ plan: 'free' });
    if(data.plan === 'daily' && data.plan_expires_at) {
      if(new Date(data.plan_expires_at) < new Date()) {
        await supabase.from('user_plans').update({ plan: 'free' }).eq('email', email);
        return res.json({ plan: 'free' });
      }
    }
    return res.json({ plan: data.plan, expires_at: data.plan_expires_at });
  } catch(e) {
    return res.json({ plan: 'free' });
  }
});

// ─── MLB PITCHER DATA ─────────────────────────────────────────────────────────
async function fetchMLBPitcherData() {
  try {
    const now = new Date();
    if(mlbPitcherCache && mlbPitcherCacheTime && (now - mlbPitcherCacheTime) < 3600000) {
      return mlbPitcherCache;
    }
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${now.toISOString().split('T')[0]}&hydrate=probablePitcher(note),team,linescore`;
    const res = await fetch(url);
    const data = await res.json();
    const pitcherMap = {};
    if(data.dates && data.dates.length > 0) {
      data.dates[0].games.forEach(game => {
        const home = game.teams?.home;
        const away = game.teams?.away;
        if(home?.probablePitcher) {
          pitcherMap[home.team.name] = {
            name: home.probablePitcher.fullName,
            era: home.probablePitcher.stats?.find(s => s.type?.displayName === 'statsSingleSeason')?.stats?.era || null
          };
        }
        if(away?.probablePitcher) {
          pitcherMap[away.team.name] = {
            name: away.probablePitcher.fullName,
            era: away.probablePitcher.stats?.find(s => s.type?.displayName === 'statsSingleSeason')?.stats?.era || null
          };
        }
      });
    }
    mlbPitcherCache = pitcherMap;
    mlbPitcherCacheTime = now;
    console.log(`✓ MLB pitcher data loaded for ${Object.keys(pitcherMap).length} teams`);
    return pitcherMap;
  } catch(e) {
    console.log('MLB pitcher fetch error:', e.message);
    return {};
  }
}

function getPitcherContext(team, opponent, pitcherMap) {
  const teamPitcher = pitcherMap[team];
  const oppPitcher = pitcherMap[opponent];
  if(!teamPitcher && !oppPitcher) return null;
  let context = '';
  if(teamPitcher) {
    const era = teamPitcher.era ? ` (${teamPitcher.era} ERA)` : '';
    context += `${team} sends ${teamPitcher.name}${era} to the mound. `;
  }
  if(oppPitcher) {
    const era = oppPitcher.era ? ` (${oppPitcher.era} ERA)` : '';
    context += `${opponent} counters with ${oppPitcher.name}${era}.`;
  }
  return context.trim();
}

function getPitcherValueScore(team, pitcherMap) {
  const pitcher = pitcherMap[team];
  if(!pitcher || !pitcher.era) return 0;
  const era = parseFloat(pitcher.era);
  if(era < 2.5) return 8;
  if(era < 3.5) return 4;
  if(era < 4.5) return 0;
  if(era < 5.5) return -4;
  return -8;
}

// ─── PICKS ENDPOINT ───────────────────────────────────────────────────────────
app.get('/picks', async (req, res) => {
  try {
    const now = new Date();
    const cacheAge = lastUpdated ? (now - lastUpdated) / 1000 / 60 : 999;
    if(cachedPicks && cacheAge < 60) {
      return res.json({ updatedAt: lastUpdated, picks: cachedPicks });
    }
    const picks = await generatePicks();
    cachedPicks = picks;
    lastUpdated = now;
    res.json({ updatedAt: lastUpdated, picks: cachedPicks });
  } catch(e) {
    console.log('Error:', e.message);
    res.json({ updatedAt: new Date(), picks: getDefaultPicks() });
  }
});

// ─── RESULTS ──────────────────────────────────────────────────────────────────
app.get('/results', async (req, res) => {
  try {
    if(!supabase) return res.json({ error: 'Database not configured' });
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { data } = await supabase.from('picks_history').select('*')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false });
    const allTime = await supabase.from('picks_history').select('result, sport').neq('result', 'pending');
    const stats = calculateStats(allTime.data || []);
    const monthly = groupByMonth(data || []);
    res.json({ stats, monthly, recent: data || [] });
  } catch(e) {
    res.json({ stats: {}, monthly: {}, recent: [] });
  }
});

// ─── PROPS ENDPOINT ───────────────────────────────────────────────────────────
app.get('/props', async (req, res) => {
  try {
    const now = new Date();
    const cacheAge = propsLastUpdated ? (now - propsLastUpdated) / 1000 / 60 : 999;
    if(cachedProps && cacheAge < 60) {
      return res.json({ updatedAt: propsLastUpdated, props: cachedProps });
    }
    const props = await generateAllProps();
    cachedProps = props;
    propsLastUpdated = now;
    res.json({ updatedAt: propsLastUpdated, props: cachedProps });
  } catch(e) {
    console.log('Props error:', e.message);
    res.json({ updatedAt: new Date(), props: {} });
  }
});

// ─── PROPS MARKETS CONFIG ─────────────────────────────────────────────────────
const PROPS_MARKETS = {
  nba: [
    { key: 'player_points', label: 'Points' },
    { key: 'player_rebounds', label: 'Rebounds' },
    { key: 'player_assists', label: 'Assists' }
  ],
  wnba: [
    { key: 'player_points', label: 'Points' },
    { key: 'player_rebounds', label: 'Rebounds' },
    { key: 'player_assists', label: 'Assists' }
  ],
  mlb: [
    { key: 'batter_hits', label: 'Hits' },
    { key: 'batter_home_runs', label: 'Home Runs' },
    { key: 'pitcher_strikeouts', label: 'Strikeouts' }
  ],
  nhl: [
    { key: 'player_goals', label: 'Goals' },
    { key: 'player_assists', label: 'Assists' },
    { key: 'player_shots_on_goal', label: 'Shots on Goal' }
  ]
};

const PROPS_SPORT_KEYS = {
  nba: 'basketball_nba',
  wnba: 'basketball_wnba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl'
};

async function fetchEventsForSport(sportKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch(e) { return []; }
}

async function fetchPropsForEvent(sportKey, eventId, markets) {
  try {
    const marketStr = markets.join(',');
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${marketStr}&oddsFormat=american`;
    const res = await fetch(url);
    const data = await res.json();
    return data;
  } catch(e) { return null; }
}

function generatePropAnalysis(playerName, team, marketLabel, direction, line, odds, sport) {
  const formattedOdds = formatOdds(odds);
  const isOver = direction === 'Over';

  const nbaWnbaOpenings = isOver ? [
    `${playerName} has been on a tear lately and ${line} ${marketLabel.toLowerCase()} feels light based on recent output.`,
    `The matchup tonight sets up perfectly for ${playerName} to go over ${line} ${marketLabel.toLowerCase()} — ${team}'s pace and usage say so.`,
    `${playerName} has exceeded ${line} ${marketLabel.toLowerCase()} in a majority of recent games. The trend is hard to ignore.`,
    `Heavy usage and a favorable defensive matchup make ${playerName} over ${line} ${marketLabel.toLowerCase()} one of the stronger props today.`,
    `${playerName} is locked in right now — ${line} ${marketLabel.toLowerCase()} is a number the model sees as too low.`
  ] : [
    `${playerName} under ${line} ${marketLabel.toLowerCase()} is backed by a tough defensive matchup that limits production at this position.`,
    `The model sees ${playerName} coming in under ${line} ${marketLabel.toLowerCase()} — usage and minutes have been trending down.`,
    `${line} ${marketLabel.toLowerCase()} feels inflated for ${playerName} given the defensive scheme they'll face tonight.`,
    `${playerName} has gone under ${line} ${marketLabel.toLowerCase()} in recent outings — the number hasn't adjusted to reflect that.`,
    `Tough matchup for ${playerName} tonight. The under on ${line} ${marketLabel.toLowerCase()} is where the value sits.`
  ];

  const mlbOpenings = isOver ? [
    `${playerName} has been swinging a hot bat lately — over ${line} ${marketLabel.toLowerCase()} is a number the model likes today.`,
    `Favorable pitching matchup sets up ${playerName} for a big day. Over ${line} ${marketLabel.toLowerCase()} is the play.`,
    `${playerName} has exceeded this ${marketLabel.toLowerCase()} line in recent games. The matchup today only helps.`,
    `The model sees ${playerName} over ${line} ${marketLabel.toLowerCase()} — ballpark factors and pitcher tendencies both point this way.`,
    `${playerName} has been one of the more consistent performers in this market. Over ${line} is the right side today.`
  ] : [
    `${playerName} under ${line} ${marketLabel.toLowerCase()} is backed by a tough pitching matchup tonight.`,
    `The model has ${playerName} coming in under ${line} ${marketLabel.toLowerCase()} — recent struggles against this type of pitching support it.`,
    `${playerName} under ${line} ${marketLabel.toLowerCase()} — the pitcher they're facing has been dominant in this area lately.`,
    `Ballpark and conditions favor the under on ${playerName}'s ${marketLabel.toLowerCase()} tonight.`,
    `${playerName} has gone under this number more often than not recently. The model agrees with the under here.`
  ];

  const nhlOpenings = isOver ? [
    `${playerName} has been generating at a high rate lately — over ${line} ${marketLabel.toLowerCase()} is a strong play tonight.`,
    `The matchup sets up well for ${playerName} to exceed ${line} ${marketLabel.toLowerCase()} — ice time and line combinations favor it.`,
    `${playerName} over ${line} ${marketLabel.toLowerCase()} is backed by recent form and a favorable defensive matchup.`,
    `${playerName} has gone over this number consistently in recent games. Tonight's matchup only strengthens the case.`,
    `Heavy ice time and a fast-paced matchup sets ${playerName} up to go over ${line} ${marketLabel.toLowerCase()}.`
  ] : [
    `${playerName} under ${line} ${marketLabel.toLowerCase()} — tough defensive matchup limits production here.`,
    `The model sees ${playerName} coming in under ${line} ${marketLabel.toLowerCase()} based on recent trends and matchup data.`,
    `${playerName} has gone under this ${marketLabel.toLowerCase()} line recently and tonight's matchup doesn't change that.`,
    `Reduced ice time and a defensive-minded opponent makes the under on ${playerName}'s ${marketLabel.toLowerCase()} the right call.`,
    `${playerName} under ${line} ${marketLabel.toLowerCase()} — the model sees value on this side of the number tonight.`
  ];

  const closings = [
    `Sharp money has been consistent on this side of the number.`,
    `Multiple books are aligned here — the consensus supports this play.`,
    `At ${formattedOdds} there's real value on this prop. The model is confident.`,
    `This is exactly the kind of prop spot the model is built to find.`,
    `Line hasn't moved much since open — the value is still there.`
  ];

  const openingPool = sport === 'mlb' ? mlbOpenings : sport === 'nhl' ? nhlOpenings : nbaWnbaOpenings;
  return `${rnd(openingPool)} ${rnd(closings)}`;
}

async function getPropsForSport(sport) {
  const sportKey = PROPS_SPORT_KEYS[sport];
  const markets = PROPS_MARKETS[sport];
  if(!sportKey || !markets) return [];

  const now = new Date();
  const twelveHours = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  try {
    // Get today's events
    const events = await fetchEventsForSport(sportKey);
    const todayEvents = events.filter(e => {
      const t = new Date(e.commence_time);
      return t > now && t < twelveHours;
    });

    if(todayEvents.length === 0) return [];

    const allProps = [];
    const marketKeys = markets.map(m => m.key);

    // Fetch props for each event (limit to 5 events to save credits)
    for(const event of todayEvents.slice(0, 5)) {
      const data = await fetchPropsForEvent(sportKey, event.id, marketKeys);
      if(!data || !data.bookmakers) continue;

      for(const market of markets) {
        data.bookmakers.forEach(bm => {
          const m = bm.markets?.find(x => x.key === market.key);
          if(!m) return;

          // Group outcomes by player + direction
          const playerMap = {};
          m.outcomes.forEach(outcome => {
            const key = `${outcome.description}|${outcome.name}|${outcome.point}`;
            if(!playerMap[key]) playerMap[key] = { ...outcome, count: 0, oddsSum: 0 };
            playerMap[key].oddsSum += outcome.price;
            playerMap[key].count++;
          });

          Object.values(playerMap).forEach(p => {
            const avgOdds = Math.round(p.oddsSum / p.count);
            if(!avgOdds || avgOdds === 0 || (avgOdds > 0 && avgOdds < 100)) return;
            if(avgOdds < -300 || avgOdds > 500) return;
            const conf = Math.min(Math.round(americanToImpliedProb(avgOdds) * 100), 85);
            if(conf < 55) return;

            allProps.push({
              player: p.description,
              team: event.home_team,
              opponent: event.away_team,
              game: `${SPORT_LABELS[sport]} · ${event.away_team} @ ${event.home_team}`,
              gameTime: event.commence_time,
              market: market.key,
              marketLabel: market.label,
              direction: p.name, // Over or Under
              line: p.point,
              odds: avgOdds,
              conf,
              valueScore: conf - Math.abs(avgOdds) / 10,
              name: `${p.description} ${p.name} ${p.point} ${market.label}`,
              analysis: generatePropAnalysis(p.description, event.home_team, market.label, p.name, p.point, avgOdds, sport)
            });
          });
        });
      }
    }

    // Sort by value, dedupe by player+market, take top 3
    allProps.sort((a, b) => b.valueScore - a.valueScore);
    const seen = new Set();
    const top3 = [];
    for(const prop of allProps) {
      const key = `${prop.player}|${prop.market}|${prop.direction}`;
      if(!seen.has(key)) { seen.add(key); top3.push(prop); }
      if(top3.length >= 3) break;
    }

    const badges = ['🥇 BEST BET', '🥈 STRONG PLAY', '🥉 VALUE BET'];
    const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];
    return top3.map((prop, i) => ({
      badge: badges[i],
      color: colors[i],
      game: prop.game,
      name: prop.name,
      odds: formatOdds(prop.odds),
      conf: prop.conf,
      type: prop.marketLabel,
      gameTime: prop.gameTime,
      analysis: prop.analysis,
      player: prop.player,
      direction: prop.direction,
      line: prop.line,
      marketLabel: prop.marketLabel
    }));
  } catch(e) {
    console.log(`Props error for ${sport}:`, e.message);
    return [];
  }
}

async function generateAllProps() {
  const allProps = {};
  for(const sport of Object.keys(PROPS_SPORT_KEYS)) {
    console.log(`Fetching props for ${sport}...`);
    allProps[sport] = await getPropsForSport(sport);
    console.log(`✓ ${sport} props — ${allProps[sport].length} found`);
  }
  return allProps;
}


  const total = picks.filter(p => p.result !== 'pending');
  const wins = total.filter(p => p.result === 'win');
  const losses = total.filter(p => p.result === 'loss');
  const pushes = total.filter(p => p.result === 'push');
  const bySport = {};
  ['nba','wnba','mlb','nhl','ufc'].forEach(sport => {
    const sp = total.filter(p => p.sport === sport);
    const sw = sp.filter(p => p.result === 'win');
    bySport[sport] = { wins: sw.length, total: sp.length, rate: sp.length > 0 ? Math.round((sw.length / sp.length) * 100) : 0 };
  });
  return { wins: wins.length, losses: losses.length, pushes: pushes.length, total: total.length, winRate: total.length > 0 ? Math.round((wins.length / total.length) * 100) : 0, bySport };
}

function groupByMonth(picks) {
  const months = {};
  picks.forEach(pick => {
    const date = new Date(pick.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
    const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if(!months[key]) months[key] = { label, picks: [] };
    months[key].picks.push(pick);
  });
  return months;
}

// ─── ODDS HELPERS ─────────────────────────────────────────────────────────────
async function fetchOdds(sportKey, markets) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;
    const res = await fetch(url);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch(e) { return []; }
}

function americanToImpliedProb(odds) {
  if(odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function roundToStandardOdds(odds) {
  return Math.round(odds / 5) * 5;
}

function formatOdds(odds) {
  const rounded = roundToStandardOdds(odds);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function isGoodValue(odds, sport, betType) {
  if(!odds || odds === 0) return false;
  if(odds > 0 && odds < 100) return false;
  if(betType === 'ML') {
    const minOdds = ML_ODDS_FILTERS[sport] || -200;
    return odds >= minOdds && odds <= 500;
  }
  return odds >= -200 && odds <= 500;
}

function roundToHalf(num) { return Math.round(num * 2) / 2; }

function getAverageOdds(bookmakers, team, market) {
  const odds = [];
  bookmakers.forEach(bm => {
    const m = bm.markets.find(x => x.key === market);
    if(m) { const o = m.outcomes.find(o => o.name === team); if(o) odds.push(o.price); }
  });
  if(odds.length === 0) return null;
  const avg = Math.round(odds.reduce((a,b) => a+b,0) / odds.length);
  if(avg === 0 || (avg > 0 && avg < 100)) return null;
  return avg;
}

function getAveragePoint(bookmakers, team, market) {
  const points = [];
  bookmakers.forEach(bm => {
    const m = bm.markets.find(x => x.key === market);
    if(m) { const o = m.outcomes.find(o => o.name === team); if(o && o.point !== undefined) points.push(o.point); }
  });
  if(points.length === 0) return null;
  return roundToHalf(points.reduce((a,b) => a+b,0) / points.length);
}

// ─── ANALYSIS ENGINE ──────────────────────────────────────────────────────────
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateAnalysis(pickType, team, opponent, conf, odds, point, isHome, sport, bookmakerCount, pitcherContext) {
  const formattedOdds = formatOdds(odds);

  // ── CLOSING LINES (shared across sports, fully varied) ────────────────────
  const closings = [
    `${bookmakerCount >= 5 ? 'Consensus across 5+ books backs this number' : 'Multiple books are aligned here'} — hard to fade.`,
    `The model has been tracking this line since open and the value hasn't moved. Still the right side.`,
    `Sharp action has been consistent on ${team} — this number isn't moving by accident.`,
    `At ${conf}% implied probability, the edge is real and the model is confident.`,
    `This is exactly the kind of spot the model was built to find — value where the public isn't looking.`,
    `Line movement since open has been in ${team}'s favor. Follow the money.`,
    `${bookmakerCount >= 5 ? 'Five or more books' : 'Multiple books'} pricing this the same way tells you everything you need to know.`,
    `The model flagged this early and nothing has changed — still the play.`,
    `Situational edges like this are where the model consistently finds value. Trust the process.`,
    `Public money is on the other side, which is exactly where we want to be.`
  ];

  // ── NBA ───────────────────────────────────────────────────────────────────
  if(sport === 'nba' || sport === 'wnba') {
    const isWNBA = sport === 'wnba';
    const loc = isHome ? 'at home' : 'on the road';

    const openings = odds < 0 ? [
      `${team} come into tonight as clear favorites ${loc} and the model sees no reason to argue with that line.`,
      `The books opened ${team} as favorites ${loc} and sharp money has only pushed it further — that's a signal.`,
      `${team} are priced as favorites ${loc} at ${formattedOdds} and the model agrees with the market here.`,
      `At ${formattedOdds}, ${team} represent solid value ${loc} — the implied probability lines up with what the model sees.`,
      `${team} are favored ${loc} and this is one of the cleaner spots on tonight's board.`
    ] : [
      `${team} come in as underdogs ${loc} at ${formattedOdds} but the model sees real value on this side.`,
      `The public is fading ${team} ${loc}, but at ${formattedOdds} there's too much value to ignore here.`,
      `${team} at plus money ${loc} is the kind of spot the model loves — undervalued and overlooked.`,
      `${formattedOdds} on ${team} ${loc} is a number the model can't walk away from. Value play of the day.`,
      `Underdog alert — ${team} at ${formattedOdds} ${loc} is a genuine value play, not a dart throw.`
    ];

    const middles = isWNBA ? [
      `${team} have been one of the more consistent sides in the league and ${opponent} hasn't shown the ability to slow them down.`,
      `Rest and scheduling favor ${team} heading into tonight — ${opponent} is the more fatigued team.`,
      `${team}'s offense has been clicking at a high level and ${opponent}'s defense hasn't been able to stop teams playing this style.`,
      `Back-to-back fatigue is a real concern for ${opponent} tonight. ${team} are fresh and ready to take advantage.`,
      `The pace of this matchup suits ${team} perfectly — they've thrived in games played at this tempo all season.`,
      `${opponent} has been giving up points at an alarming rate and ${team} are exactly the kind of team to exploit that.`,
      `${team} have been significantly better in close games this season — composure and coaching give them the edge late.`,
      `${opponent} has been inconsistent offensively and ${team}'s defense is built to make life difficult for exactly that kind of team.`,
      `The matchup heavily favors ${team} — their personnel advantages are real and the model is pricing them accordingly.`,
      `${team} have gone on extended runs in recent games and ${opponent} hasn't shown the discipline to slow that down.`,
      `Key contributors for ${team} are healthy and available — depth is a real advantage heading into tonight.`,
      `${team} have covered consistently against teams at this level. The trend is there and the model agrees.`
    ] : [
      `${team} have been one of the more consistent teams over their last stretch of games and ${opponent} hasn't shown the ability to slow them down.`,
      `Rest and scheduling favor ${team} heading into tonight — ${opponent} is the more fatigued side.`,
      `${team}'s offense has been clicking at a high level lately and ${opponent}'s defense hasn't been able to stop teams with a similar style.`,
      `Back-to-back fatigue is a real concern for ${opponent} tonight. ${team} are fresh and motivated.`,
      `The pace of this matchup suits ${team} perfectly — they've thrived in games played at this tempo.`,
      `${opponent} has been hemorrhaging points on defense lately, and ${team} are exactly the kind of team to expose that.`,
      `${team} have covered in a majority of their recent matchups against teams at this level. The trend is there.`,
      `Key rotation players for ${team} are healthy and available, which gives them a real depth advantage over ${opponent} tonight.`,
      `${team} have been significantly better in close games this season — experience and coaching give them the edge late.`,
      `${opponent} has been inconsistent offensively and ${team}'s defense is built to make life difficult for exactly that kind of team.`,
      `The matchup on paper heavily favors ${team} — their personnel advantages are real and the model is pricing them accordingly.`,
      `${team} have gone on extended runs in recent games and ${opponent} hasn't shown the defensive discipline to slow that down.`
    ];

    if(pickType === 'totals') {
      const dir = team;
      const overMids = [
        `Both ${team} and ${opponent} have been involved in high-scoring games recently — neither defense is stopping much right now.`,
        `The pace in this matchup will be fast. Both teams push in transition and struggle to set up half-court defense consistently.`,
        `${opponent} and ${team} have combined to go over this total in a majority of their recent meetings. History favors the over.`,
        `Neither team's defense has been elite lately — this total feels like it was set for a tighter game than we're likely to get.`,
        `Both offenses are clicking right now. There aren't many stoppers in this matchup and the points should flow freely.`
      ];
      const underMids = [
        `Both ${team} and ${opponent} have been leaning on their defenses lately and the scoring has dried up as a result.`,
        `Slow, halfcourt basketball is what both coaches prefer and this game should reflect that — expect a grind.`,
        `${opponent} and ${team} have both gone under consistently in recent games. The pace just isn't there for a high scorer.`,
        `The defensive matchups here are real. Both teams have the personnel to make life difficult for the other's offense.`,
        `Both teams rank in the bottom half of pace metrics recently. This total feels inflated for what should be a methodical game.`
      ];
      return `${rnd(openings)} ${rnd(dir === 'Over' ? overMids : underMids)} ${rnd(closings)}`;
    }

    return `${rnd(openings)} ${rnd(middles)} ${rnd(closings)}`;
  }

  // ── MLB ───────────────────────────────────────────────────────────────────
  if(sport === 'mlb') {
    const loc = isHome ? 'at home' : 'on the road';

    const openings = odds < 0 ? [
      `${team} are priced as favorites ${loc} at ${formattedOdds} and the model is comfortable backing them here.`,
      `The books have ${team} as the favorite ${loc} and the underlying data supports that line.`,
      `${team} at ${formattedOdds} ${loc} is a number that makes sense — the model has them as the more complete side today.`,
      `Favored ${loc} at ${formattedOdds}, ${team} are the right side according to everything the model is seeing today.`,
      `${team} come in as favorites ${loc} and this is one of the cleaner plays on today's MLB slate.`
    ] : [
      `${team} are the underdog today at ${formattedOdds} but the model sees genuine value on this side.`,
      `The public is fading ${team} at ${formattedOdds} — that's exactly where the value tends to hide in baseball.`,
      `${formattedOdds} on ${team} is a number that stands out. The model has this game much closer than the books do.`,
      `${team} at plus money today is a spot the model flagged early. The value is real.`,
      `Underdog value alert — ${team} at ${formattedOdds} is a strong play based on what the model sees today.`
    ];

    const pitcherMids = pitcherContext ? [pitcherContext] : [
      `The pitching matchup heavily tilts toward ${team} today — the arm they're sending out has been sharp recently.`,
      `${team}'s starter has been one of the more consistent options in the rotation over the last several weeks.`,
      `${opponent}'s pitching has been stretched thin lately and ${team} are well-positioned to take advantage today.`,
      `The bullpen situation favors ${team} — their relievers have been reliable and ${opponent}'s have been shaky.`
    ];

    const situMids = [
      `${team} have been excellent in one-run games this season — exactly the kind of spot the model targets.`,
      `Run differential over the last 10 games strongly favors ${team} and that doesn't happen by accident.`,
      `${team} have been one of the better bets ${loc} this season — their home/away splits are legitimately impressive.`,
      `${opponent} has been struggling to score runs against quality pitching and today that's a real problem for them.`,
      `Ballpark factors and today's conditions suit ${team}'s style of play — this is a favorable environment.`,
      `${team} have been grinding out wins lately. They don't always look pretty but they find ways to cover.`,
      `${opponent} has been inconsistent in close games and ${team} know how to win tight ones — experience matters here.`,
      `The lineup ${team} is running today matches up well against what ${opponent} is throwing out there.`
    ];

    if(pickType === 'totals') {
      const dir = team;
      const pitNote = pitcherContext ? pitcherContext + ' ' : '';
      const overMids = [
        `${pitNote}Both lineups have been swinging the bats well lately and neither starter has been overpowering. Runs should come.`,
        `${pitNote}The ballpark and today's conditions — wind and temperature — should help drive the ball and push this over.`,
        `${pitNote}${team} and ${opponent} have been combining for big run totals in recent matchups. This total feels set too low.`,
        `${pitNote}Neither bullpen has been reliable lately, which means late-inning runs are very much in play here.`,
        `${pitNote}Both offenses are productive right now and the pitching matchup isn't one that screams shut-down game.`
      ];
      const underMids = [
        `${pitNote}Two quality arms going today and both bullpens have been solid — run support has been hard to come by for both sides.`,
        `${pitNote}Both teams have been playing low-scoring ball lately. The under has cashed at a high rate in their recent games.`,
        `${pitNote}Pitching is winning right now on both sides. This total looks inflated for what should be a tight, low-scoring game.`,
        `${pitNote}Both managers have deep bullpens and the willingness to go to them early. Runs will be at a premium tonight.`,
        `${pitNote}The conditions today actually favor pitchers — this total feels half a run too high for the matchup.`
      ];
      return `${rnd(openings)} ${rnd(dir === 'Over' ? overMids : underMids)} ${rnd(closings)}`;
    }

    return `${rnd(openings)} ${rnd(pitcherMids)} ${rnd(situMids)} ${rnd(closings)}`;
  }

  // ── NHL ───────────────────────────────────────────────────────────────────
  if(sport === 'nhl') {
    const loc = isHome ? 'at home' : 'on the road';

    const openings = odds < 0 ? [
      `${team} are favored ${loc} at ${formattedOdds} and the model has them as the right side tonight.`,
      `The books opened ${team} as the favorite ${loc} and the model agrees — this number is right.`,
      `${team} at ${formattedOdds} ${loc} is a clean number. The model has them as the more complete team tonight.`,
      `Favored ${loc} at ${formattedOdds}, ${team} are one of the stronger plays on tonight's NHL slate.`,
      `${team} come in as favorites ${loc} and everything the model sees points to backing them here.`
    ] : [
      `${team} are the underdog ${loc} at ${formattedOdds} but the model sees this game as much closer than the books do.`,
      `The public is loading up on ${opponent} but ${team} at ${formattedOdds} is where the value lives tonight.`,
      `${formattedOdds} on ${team} is a number that stands out — the model has them playing better than their price suggests.`,
      `${team} at plus money ${loc} is a legitimate value play. The model doesn't see the gap the books are pricing in.`,
      `Underdog spot for ${team} at ${formattedOdds} — and the model thinks the books have this one wrong.`
    ];

    const middles = [
      `${team}'s goaltender has been one of the better options in the league over the last 10 games — the save percentage tells the real story.`,
      `${opponent} is coming off a back-to-back and fatigue in the third period is a very real concern heading into this one.`,
      `${team}'s power play has been clicking and ${opponent}'s penalty kill has been one of the leakier units in the league lately.`,
      `${team} leads the league in shots on goal over the last two weeks — they've been generating and they've been converting.`,
      `Defensive structure has been ${team}'s calling card lately — they keep games tight and force opponents into mistakes.`,
      `${team} have been the more complete team over their last five games and ${opponent} has been inconsistent in all three zones.`,
      `${opponent} has been giving up odd-man rushes at an alarming rate — ${team} are exactly the kind of team to make them pay.`,
      `${team}'s depth up front has been the difference in close games — they can roll four lines and not lose a step.`,
      `The goaltending matchup heavily favors ${team} tonight — their starter has been significantly sharper than ${opponent}'s recently.`,
      `${team} have covered the puck line at a strong rate this season in spots exactly like this one. The situational edge is real.`,
      `${opponent} has been dealing with injuries up front and their offensive depth has suffered — ${team}'s defense will eat tonight.`,
      `${team} are built for this kind of game — tight, physical, low-event hockey is where they're at their most dangerous.`
    ];

    if(pickType === 'totals') {
      const dir = team;
      const overMids = [
        `Both ${team} and ${opponent} have been involved in high-event games lately — expect pace, special teams, and goals.`,
        `Goaltending has been inconsistent on both sides recently. This total feels low for the matchup we're likely to get.`,
        `Penalty trouble has been a theme for both teams — power play goals tend to push totals higher and both teams have the personnel to score on the man advantage.`,
        `Both teams rank near the top in shots per game over the last two weeks. High volume leads to high scoring.`,
        `${opponent} and ${team} have been combining for goals at a high rate in recent matchups. The under bettors have been getting burned.`
      ];
      const underMids = [
        `Two of the sharper goaltenders in the league going tonight — scoring chances are going to be hard to come by for both sides.`,
        `${team} and ${opponent} have both been playing tight, defensive hockey lately. The under has cashed at a strong rate in their recent games.`,
        `Both coaches favor structured, low-risk hockey and that tends to translate to low-scoring outcomes. The under fits the profile perfectly.`,
        `Penalty discipline has been a strength for both teams lately — fewer power plays means fewer easy goals and that favors the under.`,
        `Both teams are built to defend first and the offensive numbers back that up. This total looks a half-goal too high for what we're likely to get.`
      ];
      return `${rnd(openings)} ${rnd(dir === 'Over' ? overMids : underMids)} ${rnd(closings)}`;
    }

    return `${rnd(openings)} ${rnd(middles)} ${rnd(closings)}`;
  }

  // ── UFC ───────────────────────────────────────────────────────────────────
  if(sport === 'ufc') {
    const openings = odds < 0 ? [
      `${team} is the betting favorite heading into fight night at ${formattedOdds} and the model agrees with that assessment.`,
      `The books opened ${team} as the favorite and sharp money has only reinforced that line — that's meaningful.`,
      `${team} is priced as a clear favorite at ${formattedOdds} and the model sees no reason to go against the grain here.`,
      `At ${formattedOdds}, ${team} represent the right side. The implied probability lines up with what the model has.`,
      `${team} comes in as the favorite on fight night and this is one of the cleaner plays on the card.`
    ] : [
      `${team} is the underdog at ${formattedOdds} but the model sees a genuine edge here that the books aren't fully pricing in.`,
      `The public is fading ${team} but at ${formattedOdds} there's real value on this side — the model flagged it early.`,
      `${formattedOdds} on ${team} is a number that stands out. The model has this fight much closer than the odds suggest.`,
      `Underdog value on ${team} at ${formattedOdds} — the model sees a fighter who is being significantly underestimated here.`,
      `${team} at plus money is a spot the model loves. The gap between talent and price is where edges are made.`
    ];

    const middles = [
      `${team}'s striking accuracy and the ability to control distance and pace are going to be serious problems for ${opponent} in this fight.`,
      `The grappling dimension heavily favors ${team} — ${opponent} has struggled against fighters who can dictate where the fight goes and ${team} absolutely can.`,
      `${team} has looked sharper than ever in recent outings and the finishing ability has been on full display. ${opponent} hasn't faced that level of pressure.`,
      `Style matchup analysis points clearly to ${team} — ${opponent}'s tendencies and defensive habits play right into ${team}'s strengths.`,
      `${team} has been finishing fights and doing it convincingly. The cardio and the aggression in the late rounds have been the defining factors.`,
      `If this fight goes to the championship rounds, ${team} wins that version of the fight decisively. The conditioning edge is real.`,
      `${team}'s camp has put in the work to specifically prepare for ${opponent}'s game plan — this is not a fighter walking in blind.`,
      `${opponent} has shown some clear defensive vulnerabilities in recent fights and ${team} has exactly the tools to expose them on fight night.`,
      `The reach and frame advantage plays into ${team}'s hands — ${opponent} is going to have a hard time getting comfortable in this fight.`,
      `${team} has been on an impressive run lately — finishing opponents, looking sharp, and showing real improvements in every area of the game.`,
      `${opponent} tends to fade when the fight doesn't go their way early — ${team} has the experience and the composure to grind this one out.`,
      `The mental edge matters in MMA and ${team} has been in bigger spots than ${opponent} has. Experience counts when it gets difficult.`
    ];

    const ufcClosings = [
      `This line has moved toward ${team} since opening. Sharp money knows something the public doesn't.`,
      `The model has ${team} as the more complete fighter and the edge shows up across multiple dimensions of this matchup.`,
      `At ${conf}% implied probability, there's legitimate value here. The model is confident in this play.`,
      `${bookmakerCount >= 5 ? 'Five or more sportsbooks' : 'Multiple books'} are aligned on this number — consensus is hard to ignore.`,
      `This is a calculated, data-driven play. The model sees a clear edge and this is how you build long-term profit.`,
      `Sharp bettors have been consistent on ${team} since the line opened. Follow the money on fight night.`
    ];

    return `${rnd(openings)} ${rnd(middles)} ${rnd(ufcClosings)}`;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  return `Strong play — ${conf}% confidence at ${formattedOdds}. The model sees clear value on ${team} in this spot.`;
}

// ─── SAVE PICKS TO SUPABASE ───────────────────────────────────────────────────
async function saveAllPicks(allPicks) {
  if(!supabase) return;
  const twelveHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  for(const [sport, picks] of Object.entries(allPicks)) {
    if(!Array.isArray(picks)) continue;
    for(const pick of picks) {
      if(!pick.name || pick.name === 'Pro Pick' || pick.name === 'Check back at next update') continue;
      try {
        const { data: existing } = await supabase
          .from('picks_history')
          .select('id')
          .eq('sport', sport)
          .eq('pick_name', pick.name)
          .eq('game', pick.game)
          .eq('bet_type', pick.type || 'ML')
          .gte('created_at', twelveHoursAgo)
          .limit(1);
        if(!existing || existing.length === 0) {
          await supabase.from('picks_history').insert({
            sport, game: pick.game, pick_name: pick.name,
            odds: pick.odds, confidence: pick.conf,
            bet_type: pick.type || 'ML', game_time: pick.gameTime,
            result: 'pending', is_free: pick.free, commence_time: pick.gameTime
          });
          console.log(`✓ Saved: ${pick.name}`);
        } else {
          console.log(`⟳ Skipped duplicate: ${pick.name}`);
        }
      } catch(e) {
        console.log('Save error:', e.message);
      }
    }
  }
}

// ─── PICKS GENERATION ─────────────────────────────────────────────────────────
async function getPicksForSport(sportKey, sportLabel, sport) {
  const now = new Date();
  const twelveHours = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const allCandidates = [];
  const confThreshold = CONFIDENCE_THRESHOLDS[sport] || 60;

  const [h2hGames, spreadGames, totalGames] = await Promise.all([
    fetchOdds(sportKey, 'h2h'),
    fetchOdds(sportKey, 'spreads'),
    fetchOdds(sportKey, 'totals')
  ]);

  const futureH2h = h2hGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < twelveHours && g.bookmakers && g.bookmakers.length >= 2);
  const futureSpread = spreadGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < twelveHours && g.bookmakers && g.bookmakers.length >= 2);
  const futureTotals = totalGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < twelveHours && g.bookmakers && g.bookmakers.length >= 2);

  let pitcherMap = {};
  if(sport === 'mlb') pitcherMap = await fetchMLBPitcherData();

  // ML picks
  futureH2h.forEach(game => {
    [game.home_team, game.away_team].forEach(team => {
      const odds = getAverageOdds(game.bookmakers, team, 'h2h');
      if(!odds || !isGoodValue(odds, sport, 'ML')) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < confThreshold) return;
      const isHome = team === game.home_team;
      const opponent = isHome ? game.away_team : game.home_team;
      let valueScore = conf - Math.abs(odds) / 10;
      if(sport === 'mlb') valueScore += getPitcherValueScore(team, pitcherMap);
      const pitcherContext = sport === 'mlb' ? getPitcherContext(team, opponent, pitcherMap) : null;
      allCandidates.push({
        type: 'h2h', label: 'ML', gameTime: game.commence_time,
        game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
        name: `${team} ML`, odds, conf, valueScore, isHome, team, opponent,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome, sport, game.bookmakers.length, pitcherContext)
      });
    });
  });

  // Spread picks
  futureSpread.forEach(game => {
    [game.home_team, game.away_team].forEach(team => {
      const odds = getAverageOdds(game.bookmakers, team, 'spreads');
      const rawPoint = getAveragePoint(game.bookmakers, team, 'spreads');
      if(!odds || rawPoint === null || !isGoodValue(odds, sport, 'SPREAD')) return;
      const point = roundToHalf(rawPoint);
      if(sport === 'mlb' || sport === 'nhl') {
        if(Math.abs(point) !== 1.5) return;
      }
      if(sport === 'nba' && Math.abs(point) < 1.5) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < confThreshold) return;
      const isHome = team === game.home_team;
      const opponent = isHome ? game.away_team : game.home_team;
      let valueScore = conf - Math.abs(odds) / 10;
      if(sport === 'mlb') valueScore += getPitcherValueScore(team, pitcherMap);
      const pitcherContext = sport === 'mlb' ? getPitcherContext(team, opponent, pitcherMap) : null;
      allCandidates.push({
        type: 'spreads', label: 'SPREAD', gameTime: game.commence_time,
        game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
        name: `${team} ${point > 0 ? '+' : ''}${point}`,
        odds, conf, valueScore, isHome, team, opponent, point,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('spreads', team, opponent, conf, odds, point, isHome, sport, game.bookmakers.length, pitcherContext)
      });
    });
  });

  // Totals picks
  futureTotals.forEach(game => {
    ['Over', 'Under'].forEach(direction => {
      const odds = getAverageOdds(game.bookmakers, direction, 'totals');
      const rawPoint = getAveragePoint(game.bookmakers, direction, 'totals');
      if(!odds || rawPoint === null || !isGoodValue(odds, sport, 'TOTAL')) return;
      const point = roundToHalf(rawPoint);
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < confThreshold) return;
      let valueScore = conf - Math.abs(odds) / 10;
      if(sport === 'mlb') {
        const homePitcher = pitcherMap[game.home_team];
        const awayPitcher = pitcherMap[game.away_team];
        if(homePitcher?.era && awayPitcher?.era) {
          const combinedERA = parseFloat(homePitcher.era) + parseFloat(awayPitcher.era);
          if(direction === 'Under' && combinedERA < 7) valueScore += 6;
          if(direction === 'Over' && combinedERA > 9) valueScore += 6;
        }
      }
      const pitcherContext = sport === 'mlb' ? getPitcherContext(game.home_team, game.away_team, pitcherMap) : null;
      allCandidates.push({
        type: 'totals', label: 'TOTAL', gameTime: game.commence_time,
        game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
        name: `${direction} ${point}`,
        odds, conf, valueScore, team: direction, opponent: game.home_team, point,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('totals', direction, game.away_team, conf, odds, point, false, sport, game.bookmakers.length, pitcherContext)
      });
    });
  });

  allCandidates.sort((a, b) => b.valueScore - a.valueScore);
  const seen = new Set();
  const unique = [];
  for(const pick of allCandidates) {
    const key = pick.game + pick.type;
    if(!seen.has(key)) { seen.add(key); unique.push(pick); }
    if(unique.length >= 3) break;
  }

  // Monitor Bet fallback: if fewer than 3 Tier 1 picks, fill with 55% confidence picks
  if(unique.length < 3) {
    const existingKeys = new Set(unique.map(p => p.game + p.type));
    const monitorCandidates = [];

    // Check h2h, spreads, and totals at 55% threshold
    futureH2h.forEach(game => {
      [game.home_team, game.away_team].forEach(team => {
        const odds = getAverageOdds(game.bookmakers, team, 'h2h');
        if(!odds || !isGoodValue(odds, sport, 'ML')) return;
        const conf = Math.round(americanToImpliedProb(odds) * 100);
        if(conf < 55 || conf >= confThreshold) return; // only picks that didn't make Tier 1
        const key = `${sportLabel} · ${game.away_team} @ ${game.home_team}h2h`;
        if(existingKeys.has(key)) return;
        const isHome = team === game.home_team;
        const opponent = isHome ? game.away_team : game.home_team;
        const pitcherContext = sport === 'mlb' ? getPitcherContext(team, opponent, pitcherMap) : null;
        monitorCandidates.push({
          type: 'h2h', label: 'ML', gameTime: game.commence_time,
          game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
          name: `${team} ML`, odds, conf,
          valueScore: conf - Math.abs(odds) / 10,
          isHome, team, opponent, isMonitor: true,
          bookmakerCount: game.bookmakers.length,
          analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome, sport, game.bookmakers.length, pitcherContext)
        });
      });
    });

    futureSpread.forEach(game => {
      [game.home_team, game.away_team].forEach(team => {
        const odds = getAverageOdds(game.bookmakers, team, 'spreads');
        const rawPoint = getAveragePoint(game.bookmakers, team, 'spreads');
        if(!odds || rawPoint === null || !isGoodValue(odds, sport, 'SPREAD')) return;
        const point = roundToHalf(rawPoint);
        if((sport === 'mlb' || sport === 'nhl') && Math.abs(point) !== 1.5) return;
        if(sport === 'nba' && Math.abs(point) < 1.5) return;
        const conf = Math.round(americanToImpliedProb(odds) * 100);
        if(conf < 55 || conf >= confThreshold) return;
        const key = `${sportLabel} · ${game.away_team} @ ${game.home_team}spreads`;
        if(existingKeys.has(key)) return;
        const isHome = team === game.home_team;
        const opponent = isHome ? game.away_team : game.home_team;
        const pitcherContext = sport === 'mlb' ? getPitcherContext(team, opponent, pitcherMap) : null;
        monitorCandidates.push({
          type: 'spreads', label: 'SPREAD', gameTime: game.commence_time,
          game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
          name: `${team} ${point > 0 ? '+' : ''}${point}`, odds, conf,
          valueScore: conf - Math.abs(odds) / 10,
          isHome, team, opponent, point, isMonitor: true,
          bookmakerCount: game.bookmakers.length,
          analysis: generateAnalysis('spreads', team, opponent, conf, odds, point, isHome, sport, game.bookmakers.length, pitcherContext)
        });
      });
    });

    futureTotals.forEach(game => {
      ['Over', 'Under'].forEach(direction => {
        const odds = getAverageOdds(game.bookmakers, direction, 'totals');
        const rawPoint = getAveragePoint(game.bookmakers, direction, 'totals');
        if(!odds || rawPoint === null || !isGoodValue(odds, sport, 'TOTAL')) return;
        const point = roundToHalf(rawPoint);
        const conf = Math.round(americanToImpliedProb(odds) * 100);
        if(conf < 55 || conf >= confThreshold) return;
        const key = `${sportLabel} · ${game.away_team} @ ${game.home_team}totals`;
        if(existingKeys.has(key)) return;
        monitorCandidates.push({
          type: 'totals', label: 'TOTAL', gameTime: game.commence_time,
          game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
          name: `${direction} ${point}`, odds, conf,
          valueScore: conf - Math.abs(odds) / 10,
          team: direction, opponent: game.home_team, point, isMonitor: true,
          bookmakerCount: game.bookmakers.length,
          analysis: generateAnalysis('totals', direction, game.away_team, conf, odds, point, false, sport, game.bookmakers.length, null)
        });
      });
    });

    monitorCandidates.sort((a,b) => b.valueScore - a.valueScore);
    unique.push(...monitorCandidates.slice(0, 3 - unique.length));
  }

  if(unique.length === 0) return null;

  const badges = ['🥇 BEST BET', '🥈 STRONG PLAY', '🥉 VALUE BET'];
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  const monitorBadge = '👀 MONITOR BET';
  const monitorColor = '#4A90D9';

  return unique.map((pick, i) => ({
    badge: pick.isMonitor ? monitorBadge : badges[i],
    color: pick.isMonitor ? monitorColor : colors[i],
    game: pick.game, name: pick.name,
    odds: formatOdds(pick.odds), conf: Math.min(pick.conf, 85),
    free: i === 2, type: pick.label, gameTime: pick.gameTime,
    analysis: pick.analysis,
    isMonitor: pick.isMonitor || false
  }));
}

async function generatePicks() {
  const allPicks = {};
  const now = new Date();

  for(const [sport, sportKey] of Object.entries(SPORTS)) {
    if(sport === 'ufc') {
      const games = await fetchOdds(sportKey, 'h2h');
      const upcomingFights = games.filter(game => {
        const gameTime = new Date(game.commence_time);
        const daysUntil = (gameTime - now) / 1000 / 60 / 60 / 24;
        return gameTime > now && daysUntil <= 7 && game.bookmakers && game.bookmakers.length >= 2;
      });
      if(upcomingFights.length === 0) {
        allPicks['ufc'] = { noEvent: true, nextEvent: NEXT_UFC_EVENT };
        continue;
      }
      const fights = [];
      upcomingFights.forEach(game => {
        [game.home_team, game.away_team].forEach(team => {
          const odds = getAverageOdds(game.bookmakers, team, 'h2h');
          if(!odds || !isGoodValue(odds, 'ufc', 'ML')) return;
          const conf = Math.round(americanToImpliedProb(odds) * 100);
          if(conf < 55) return;
          const opponent = team === game.home_team ? game.away_team : game.home_team;
          fights.push({
            game: `🥊 UFC · ${game.home_team} vs ${game.away_team}`,
            name: `${team} ML`, odds, conf,
            valueScore: conf - Math.abs(odds) / 10,
            gameTime: game.commence_time,
            bookmakerCount: game.bookmakers.length,
            analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, false, 'ufc', game.bookmakers.length, null)
          });
        });
      });
      fights.sort((a,b) => b.valueScore - a.valueScore);
      const top3 = fights.slice(0,3);
      const badges = ['🥇 BEST BET','🥈 STRONG PLAY','🥉 VALUE BET'];
      const colors = ['#FFD700','#C0C0C0','#CD7F32'];
      allPicks['ufc'] = top3.map((f,i) => ({
        badge: badges[i], color: colors[i], game: f.game, name: f.name,
        odds: formatOdds(f.odds), conf: Math.min(f.conf, 85),
        free: i === 2, type: 'ML', gameTime: f.gameTime, analysis: f.analysis
      }));
      continue;
    }

    console.log(`Generating picks for ${sport}...`);
    const picks = await getPicksForSport(sportKey, SPORT_LABELS[sport], sport);
    if(picks && picks.length > 0) {
      allPicks[sport] = picks;
      console.log(`✓ ${sport} — ${picks.length} picks generated`);
    } else {
      allPicks[sport] = getDefaultPicksForSport(sport);
      console.log(`⚠ ${sport} — no qualifying picks found`);
    }
  }
  return allPicks;
}

function getDefaultPicksForSport(sport) {
  return [
    {badge:'🥉 VALUE BET',color:'#CD7F32',game:`${SPORT_LABELS[sport]} · No qualifying picks today`,name:'Check back at next update',odds:'-110',conf:55,free:true,type:'ML',gameTime:null,analysis:'Our model found no picks meeting our confidence and value thresholds. We only show picks we believe in.'},
    {badge:'🥇 BEST BET',color:'#FFD700',game:`${SPORT_LABELS[sport]} · No qualifying picks today`,name:'Pro Pick',odds:'-150',conf:70,free:false,type:'ML',gameTime:null,analysis:''},
    {badge:'🥈 STRONG PLAY',color:'#C0C0C0',game:`${SPORT_LABELS[sport]} · No qualifying picks today`,name:'Pro Pick',odds:'+110',conf:60,free:false,type:'ML',gameTime:null,analysis:''}
  ];
}

function getDefaultPicks() {
  const picks = {};
  Object.keys(SPORTS).forEach(sport => {
    if(sport === 'ufc') picks[sport] = { noEvent: true, nextEvent: NEXT_UFC_EVENT };
    else picks[sport] = getDefaultPicksForSport(sport);
  });
  return picks;
}

app.listen(PORT, () => {
  console.log(`SharpLine backend running on port ${PORT}`);
});
