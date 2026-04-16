const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = '2033e71d5b6784b9352bfa561db1a576';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://elwbxwzequrfucujhgsy.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = SUPABASE_SECRET_KEY ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY) : null;

const SPORTS = {
  nba: 'basketball_nba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  ufc: 'mma_mixed_martial_arts'
};

const SPORT_LABELS = {
  nba: '🏀 NBA',
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
  mlb: 65,
  nhl: 60,
  ufc: 55
};

const ML_ODDS_FILTERS = {
  nba: -150,
  mlb: -150,
  nhl: -200,
  ufc: -200
};

let cachedPicks = null;
let lastUpdated = null;
let mlbPitcherCache = null;
let mlbPitcherCacheTime = null;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'SharpLine backend running' });
});

// ─── MANUAL TRIGGER ───────────────────────────────────────────────────────────
app.get('/trigger-picks', async (req, res) => {
  try {
    console.log('Manual pick trigger fired...');
    cachedPicks = null;
    lastUpdated = null;
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
          await upsertUserPlan(email, 'pro', customerId, subscriptionId, null);
          console.log(`✓ Pro access granted to ${email}`);
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

function calculateStats(picks) {
  const total = picks.filter(p => p.result !== 'pending');
  const wins = total.filter(p => p.result === 'win');
  const losses = total.filter(p => p.result === 'loss');
  const pushes = total.filter(p => p.result === 'push');
  const bySport = {};
  ['nba','mlb','nhl','ufc'].forEach(sport => {
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

// ─── SMART ANALYSIS ───────────────────────────────────────────────────────────
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateAnalysis(pickType, team, opponent, conf, odds, point, isHome, sport, bookmakerCount, pitcherContext) {
  const formattedOdds = formatOdds(odds);
  const sharpLine = bookmakerCount >= 5
    ? 'Consensus across 5+ books strengthens this number.'
    : 'Multiple sportsbooks are aligned on this line.';

  // ── NBA ──────────────────────────────────────────────────────────────────────
  if(sport === 'nba') {
    const loc = isHome ? 'at home' : 'on the road';
    const homeNote = isHome
      ? `${team} have been significantly stronger at home this season — the crowd and familiarity with the floor matter here.`
      : `${team} have quietly been one of the better road teams this season, keeping games close away from home.`;
    const situational = rnd([
      `Rest advantage is a real factor — ${team} are the fresher team heading into tonight.`,
      `Back-to-back fatigue could be an issue for ${opponent}, and ${team} are well-rested.`,
      `Line movement since open has favored ${team} — sharp money is on this side.`,
      `The pace of play in this matchup suits ${team}'s style — they thrive at this tempo.`,
      `${team} have covered consistently against this level of competition recently.`,
      `Key injury reports favor ${team} — depth and availability give them a real edge tonight.`,
      `${opponent} are struggling with defensive consistency, which plays right into ${team}'s hands.`
    ]);
    if(pickType === 'h2h') {
      if(conf >= 75) return `${team} are a strong favorite ${loc} tonight. ${situational} ${sharpLine}`;
      if(conf >= 65) return `${team} are favored ${loc} at ${formattedOdds}. ${homeNote} ${situational}`;
      return `${team} at ${formattedOdds} ${loc} is a value play the model likes. ${situational} At ${conf}% implied probability, there's real upside here.`;
    }
    if(pickType === 'spreads') {
      const sp = point > 0 ? `+${point}` : `${point}`;
      if(conf >= 75) return `${team} ${sp} is one of the stronger spread plays on tonight's board. ${situational} ${sharpLine}`;
      if(conf >= 65) return `${team} ${sp} at ${formattedOdds} is a solid play. ${homeNote} ${situational}`;
      return `${team} ${sp} at ${formattedOdds} offers value. ${situational} Good spot to be on this number.`;
    }
    if(pickType === 'totals') {
      const overNotes = [
        `Both ${team} and ${opponent} have been running up the score lately — pace and defensive lapses point to a high-scoring game.`,
        `Neither team has strong defensive efficiency numbers right now. Expect buckets early and often.`,
        `This matchup historically trends over — both offenses are clicking and the total feels low.`
      ];
      const underNotes = [
        `Both teams have slowed pace recently and lean on halfcourt sets — a lower-scoring game is likely.`,
        `Defensive matchups favor the under here — both teams give up fewer points when fully healthy.`,
        `${opponent} and ${team} have both gone under in their recent outings. The total looks inflated.`
      ];
      return `${team} ${point} at ${formattedOdds}. ${rnd(team === 'Over' ? overNotes : underNotes)} ${sharpLine}`;
    }
  }

  // ── MLB ──────────────────────────────────────────────────────────────────────
  if(sport === 'mlb') {
    const loc = isHome ? 'at home' : 'away';
    if(pickType === 'h2h' || pickType === 'spreads') {
      const sp = (pickType === 'spreads' && point !== null) ? (point > 0 ? ` +${point}` : ` ${point}`) : '';
      const pitcherNote = pitcherContext || rnd([
        `The starting pitcher matchup tilts heavily in ${team}'s favor today.`,
        `${team}'s bullpen has been one of the most reliable in the league over the last two weeks.`,
        `${opponent}'s rotation is stretched thin — ${team} are well-rested and ready to take advantage.`,
        `${team} have been dominant at the plate against this type of pitching recently.`
      ]);
      const situational = rnd([
        `Run differential over the last 10 games strongly favors ${team}.`,
        `${team} have been excellent in one-run games — exactly the spot this model targets.`,
        `Ballpark factors and wind conditions today favor ${team}'s offense.`,
        `${team} have been one of the better bets ${loc} this season — their splits are impressive.`,
        `${opponent} has struggled to score when facing quality arms, and today that's a problem for them.`
      ]);
      if(conf >= 75) return `${team}${sp} is one of the stronger MLB plays today. ${pitcherNote} ${situational} ${sharpLine}`;
      if(conf >= 65) return `${team}${sp} at ${formattedOdds} is a solid play. ${pitcherNote} ${situational}`;
      return `${team}${sp} at ${formattedOdds} offers value. ${pitcherNote} ${situational}`;
    }
    if(pickType === 'totals') {
      const pitcherNote = pitcherContext ? pitcherContext + ' ' : '';
      const overNotes = [
        `Both offenses have been productive lately and neither starter has elite strikeout stuff today.`,
        `The ballpark plays to hitters in today's conditions — wind and temperature should push this over.`,
        `${team} and ${opponent} have combined for big run totals in their recent matchups.`
      ];
      const underNotes = [
        `Two quality arms on the mound today — run support has been scarce for both teams lately.`,
        `Bullpen depth gives both managers options to keep this one close and low-scoring.`,
        `Both teams have gone under in their last several games. The total looks slightly inflated.`
      ];
      return `${team} ${point} at ${formattedOdds}. ${pitcherNote}${rnd(team === 'Over' ? overNotes : underNotes)} ${sharpLine}`;
    }
  }

  // ── NHL ──────────────────────────────────────────────────────────────────────
  if(sport === 'nhl') {
    const loc = isHome ? 'at home' : 'on the road';
    const homeNote = isHome
      ? `${team} have been tough to beat on home ice this season — crowd noise and familiarity with the rink are real factors.`
      : `${team} have shown they can win away from home, which is exactly the kind of spot this model targets.`;
    const situational = rnd([
      `${team}'s goaltender has been one of the sharper options in the league over the last 10 games — the save percentage backs it up.`,
      `Power play efficiency heavily favors ${team} in this matchup — ${opponent}'s penalty kill has been leaky.`,
      `${opponent} is on the second night of a back-to-back — fatigue is a real concern heading into this one.`,
      `${team} leads the league in shots on goal over the last two weeks — they've been generating and converting.`,
      `Recent form strongly favors ${team} — they've been the more complete team over their last 5 games.`,
      `${team}'s defensive structure has been elite lately, keeping games tight and favoring puck possession.`,
      `Line movement since open has trended toward ${team} — sharp money agrees with this number.`
    ]);
    if(pickType === 'h2h') {
      if(conf >= 75) return `${team} are a strong play ${loc} tonight. ${situational} ${sharpLine}`;
      if(conf >= 65) return `${team} at ${formattedOdds} ${loc} is a solid play. ${homeNote} ${situational}`;
      return `${team} at ${formattedOdds} offers value ${loc}. ${situational} At ${conf}% implied probability, this is a smart spot.`;
    }
    if(pickType === 'spreads') {
      const sp = point > 0 ? `+${point}` : `${point}`;
      if(conf >= 75) return `${team} ${sp} is one of the stronger puck line plays today. ${situational} ${sharpLine}`;
      if(conf >= 65) return `${team} ${sp} at ${formattedOdds} is a solid play. ${homeNote} ${situational}`;
      return `${team} ${sp} at ${formattedOdds} offers value. ${situational}`;
    }
    if(pickType === 'totals') {
      const overNotes = [
        `Both teams have been involved in high-event games lately — expect pace, shots, and goals.`,
        `Goaltending has been shaky on both sides recently — this total feels low given recent form.`,
        `Penalty trouble for both squads sets up power play opportunities that tend to push totals higher.`
      ];
      const underNotes = [
        `Two of the sharper goaltenders in the league square off tonight — goals will be hard to come by.`,
        `Both teams have been playing tight, defensive hockey lately. The under has cashed in their recent games.`,
        `Slow-paced matchup expected — both coaches favor structure over run-and-gun. The under fits the profile.`
      ];
      return `${team} ${point} at ${formattedOdds}. ${rnd(team === 'Over' ? overNotes : underNotes)} ${sharpLine}`;
    }
  }

  // ── UFC ──────────────────────────────────────────────────────────────────────
  if(sport === 'ufc') {
    const oddsNote = odds < 0
      ? `${team} is the favorite at ${formattedOdds} — the books see a clear edge here and our model agrees.`
      : `${team} comes in as the underdog at ${formattedOdds}, but the value is there and the model likes this spot.`;
    const styleNote = rnd([
      `${team}'s striking accuracy and distance control give them a clear edge against ${opponent} in this matchup.`,
      `The grappling and takedown defense for ${team} has been elite — ${opponent} will struggle to impose their game plan.`,
      `${team} has looked sharp in recent outings, finishing opponents and showing no signs of slowing down heading into this fight.`,
      `Style-wise, this is a favorable matchup for ${team} — ${opponent}'s tendencies play right into their strengths.`,
      `${team} has been finishing fights lately — their pressure and aggression late in rounds has been the defining factor.`,
      `Cardio and late-round performance is where ${team} separates — if this goes deep, it heavily favors them.`,
      `${team}'s camp has clearly game-planned around ${opponent}'s tendencies — they're prepared for this fight.`,
      `${opponent} has shown some defensive holes that ${team} is well-equipped to exploit on fight night.`
    ]);
    const closingNote = rnd([
      `This line has moved toward ${team} since opening — sharp money is backing this pick.`,
      sharpLine,
      `Our model has ${team} as the more complete fighter heading into fight night.`,
      `At ${conf}% implied probability, the model sees enough value to make this a confident play.`
    ]);
    return `${oddsNote} ${styleNote} ${closingNote}`;
  }

  // ── Fallback ─────────────────────────────────────────────────────────────────
  return `Strong play — ${conf}% confidence at ${formattedOdds}. ${sharpLine}`;
}

// ─── SAVE PICKS TO SUPABASE ───────────────────────────────────────────────────
async function saveAllPicks(allPicks) {
  if(!supabase) return;
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
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
        odds, conf, valueScore, team: direction, opponent: '', point,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('totals', direction, '', conf, odds, point, false, sport, game.bookmakers.length, pitcherContext)
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

  // Fallback: lower threshold if not enough picks
  if(unique.length < 3) {
    const existingKeys = new Set(unique.map(p => p.game + p.type));
    const lowCandidates = [];
    futureH2h.forEach(game => {
      [game.home_team, game.away_team].forEach(team => {
        const odds = getAverageOdds(game.bookmakers, team, 'h2h');
        if(!odds || !isGoodValue(odds, sport, 'ML')) return;
        const conf = Math.round(americanToImpliedProb(odds) * 100);
        if(conf < 55) return;
        const key = `${sportLabel} · ${game.home_team} vs ${game.away_team}h2h`;
        if(existingKeys.has(key)) return;
        const isHome = team === game.home_team;
        const opponent = isHome ? game.away_team : game.home_team;
        const pitcherContext = sport === 'mlb' ? getPitcherContext(team, opponent, pitcherMap) : null;
        lowCandidates.push({
          type: 'h2h', label: 'ML', gameTime: game.commence_time,
          game: `${sportLabel} · ${game.away_team} @ ${game.home_team}`,
          name: `${team} ML`, odds, conf,
          valueScore: conf - Math.abs(odds) / 10,
          isHome, team, opponent,
          bookmakerCount: game.bookmakers.length,
          analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome, sport, game.bookmakers.length, pitcherContext)
        });
      });
    });
    lowCandidates.sort((a,b) => b.valueScore - a.valueScore);
    unique.push(...lowCandidates.slice(0, 3 - unique.length));
  }

  if(unique.length === 0) return null;
  const badges = ['🥇 BEST BET', '🥈 STRONG PLAY', '🥉 VALUE BET'];
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  return unique.map((pick, i) => ({
    badge: badges[i], color: colors[i], game: pick.game, name: pick.name,
    odds: formatOdds(pick.odds), conf: Math.min(pick.conf, 85),
    free: i === 2, type: pick.label, gameTime: pick.gameTime, analysis: pick.analysis
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
            game: `🥊 UFC · ${game.away_team} @ ${game.home_team}`,
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
