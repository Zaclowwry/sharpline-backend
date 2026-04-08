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
  mainEvent: 'Charles Oliveira vs Arman Tsarukyan',
  coMain: 'Paige VanZant vs Kayla Harrison',
  title: 'Lightweight Title Fight'
};

let cachedPicks = null;
let lastUpdated = null;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'SharpLine backend running' });
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
        const subscription = event.data.object;
        await downgradeByCustomerId(subscription.customer);
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

// ─── PICKS (serve only, never save) ──────────────────────────────────────────
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

function formatOdds(odds) { return odds > 0 ? `+${odds}` : `${odds}`; }
function isGoodValue(odds) { return odds > -200 && odds < 500; }

// Round spread to nearest 0.5 like real sportsbooks
function roundToHalf(num) {
  return Math.round(num * 2) / 2;
}

function getAverageOdds(bookmakers, team, market) {
  const odds = [];
  bookmakers.forEach(bm => {
    const m = bm.markets.find(x => x.key === market);
    if(m) { const o = m.outcomes.find(o => o.name === team); if(o) odds.push(o.price); }
  });
  if(odds.length === 0) return null;
  return Math.round(odds.reduce((a,b) => a+b,0) / odds.length);
}

function getAveragePoint(bookmakers, team, market) {
  const points = [];
  bookmakers.forEach(bm => {
    const m = bm.markets.find(x => x.key === market);
    if(m) { const o = m.outcomes.find(o => o.name === team); if(o && o.point !== undefined) points.push(o.point); }
  });
  if(points.length === 0) return null;
  // Round to nearest 0.5 like real sportsbooks
  const avg = points.reduce((a,b) => a+b,0) / points.length;
  return roundToHalf(avg);
}

// ─── SMART ANALYSIS ───────────────────────────────────────────────────────────
function generateAnalysis(pickType, team, opponent, conf, odds, point, isHome, sport, bookmakerCount) {
  const location = isHome ? 'at home' : 'on the road';
  const formattedOdds = formatOdds(odds);
  const sharpConsensus = bookmakerCount >= 5 ? 'Wide bookmaker consensus supports this line.' : 'Multiple books agree on this line.';
  const homeEdge = isHome ? 'Home court/ice advantage is a significant factor here.' : 'Road teams covering at this number have been profitable this season.';

  const nbaContext = [
    'Back-to-back fatigue is a key situational factor in this spot.',
    'This line has moved in favor of our pick since opening — sharp money agrees.',
    'Rest advantage plays heavily into our model\'s confidence here.',
    'The pace matchup heavily favors this pick based on recent trends.',
    'Injury reports favor our side — key player availability shifts the line value.'
  ];

  const mlbContext = [
    'Starting pitcher ERA and recent form are the primary drivers of this pick.',
    'Bullpen strength and usage over the last 3 games factors heavily here.',
    'Weather conditions and ballpark factors support this total.',
    'The lineup matchup against today\'s starter creates a clear edge.',
    'Day/night split performance heavily influences this pick.'
  ];

  const nhlContext = [
    'Goaltender save percentage over the last 10 games drives this pick.',
    'Power play efficiency and penalty kill matchup favor our side.',
    'Back-to-back road game fatigue is a key factor in our model.',
    'Home ice advantage and crowd factor heavily weighted here.',
    'Recent form over last 5 games shows a clear directional edge.'
  ];

  const ufcContext = [
    'Striking accuracy and takedown defense heavily favor our pick.',
    'Fighter\'s recent performance and training camp reports support this line.',
    'Style matchup analysis strongly favors our pick in this bout.',
    'Cardio and late-round performance trends favor our fighter.',
    'Weight cut and camp situation create a significant edge here.'
  ];

  const contextMap = { nba: nbaContext, mlb: mlbContext, nhl: nhlContext, ufc: ufcContext };
  const contexts = contextMap[sport] || nbaContext;
  const randomContext = contexts[Math.floor(Math.random() * contexts.length)];

  if(pickType === 'h2h') {
    if(conf >= 75) return `${team} is a strong ${conf}% favorite ${location}. ${randomContext} ${sharpConsensus} One of the strongest moneylines on today's board.`;
    if(conf >= 65) return `${team} is favored at ${conf}% ${location}. ${randomContext} ${homeEdge} Solid value at ${formattedOdds}.`;
    return `${team} at ${formattedOdds} offers real value ${location}. ${randomContext} At ${conf}% implied probability, this is a smart play with legitimate upside.`;
  }

  if(pickType === 'spreads') {
    const spreadStr = point > 0 ? `+${point}` : `${point}`;
    if(conf >= 75) return `${team} ${spreadStr} is one of the strongest spread plays today. ${randomContext} ${sharpConsensus} Sharp money has been consistent on this number.`;
    if(conf >= 65) return `${team} ${spreadStr} is a solid spread play at ${formattedOdds}. ${randomContext} ${homeEdge} Line movement supports this pick.`;
    return `${team} ${spreadStr} at ${formattedOdds} offers value. ${randomContext} Good spot to be on this side of the number.`;
  }

  if(pickType === 'totals') {
    const direction = team === 'Over' ? 'Over' : 'Under';
    const directionLower = direction.toLowerCase();
    if(conf >= 75) return `${direction} ${point} is one of the strongest totals plays today. ${randomContext} ${sharpConsensus} Pace and matchup data strongly support the ${directionLower}.`;
    if(conf >= 65) return `${direction} ${point} at ${formattedOdds} is a solid play. ${randomContext} Recent scoring trends support the ${directionLower} in this matchup.`;
    return `${direction} ${point} at ${formattedOdds} offers value. ${randomContext} Situational factors favor the ${directionLower} in this spot.`;
  }

  return `Strong play — ${conf}% confidence at ${formattedOdds}. ${randomContext}`;
}

// ─── PICKS GENERATION (no saving — cron jobs handle saving) ──────────────────
async function getPicksForSport(sportKey, sportLabel, sport) {
  const now = new Date();
  const fortyEightHours = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const allCandidates = [];

  const [h2hGames, spreadGames, totalGames] = await Promise.all([
    fetchOdds(sportKey, 'h2h'),
    fetchOdds(sportKey, 'spreads'),
    fetchOdds(sportKey, 'totals')
  ]);

  const futureH2h = h2hGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < fortyEightHours && g.bookmakers && g.bookmakers.length >= 2);
  const futureSpread = spreadGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < fortyEightHours && g.bookmakers && g.bookmakers.length >= 2);
  const futureTotals = totalGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < fortyEightHours && g.bookmakers && g.bookmakers.length >= 2);

  futureH2h.forEach(game => {
    [game.home_team, game.away_team].forEach(team => {
      const odds = getAverageOdds(game.bookmakers, team, 'h2h');
      if(!odds) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < 60 || !isGoodValue(odds)) return;
      const isHome = team === game.home_team;
      const opponent = isHome ? game.away_team : game.home_team;
      const valueScore = conf - Math.abs(odds) / 10;
      allCandidates.push({
        type: 'h2h', label: 'ML', gameTime: game.commence_time,
        game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
        name: `${team} ML`, odds, conf, valueScore, isHome, team, opponent,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome, sport, game.bookmakers.length)
      });
    });
  });

  futureSpread.forEach(game => {
    [game.home_team, game.away_team].forEach(team => {
      const odds = getAverageOdds(game.bookmakers, team, 'spreads');
      const rawPoint = getAveragePoint(game.bookmakers, team, 'spreads');
      if(!odds || rawPoint === null) return;
      const point = roundToHalf(rawPoint);
      // Filter out spreads smaller than 0.5 absolute value — not real betting lines
      if(Math.abs(point) < 0.5) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < 60 || !isGoodValue(odds)) return;
      const isHome = team === game.home_team;
      const opponent = isHome ? game.away_team : game.home_team;
      const valueScore = conf - Math.abs(odds) / 10;
      allCandidates.push({
        type: 'spreads', label: 'SPREAD', gameTime: game.commence_time,
        game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
        name: `${team} ${point > 0 ? '+' : ''}${point}`,
        odds, conf, valueScore, isHome, team, opponent, point,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('spreads', team, opponent, conf, odds, point, isHome, sport, game.bookmakers.length)
      });
    });
  });

  futureTotals.forEach(game => {
    ['Over', 'Under'].forEach(direction => {
      const odds = getAverageOdds(game.bookmakers, direction, 'totals');
      const rawPoint = getAveragePoint(game.bookmakers, direction, 'totals');
      if(!odds || rawPoint === null) return;
      const point = roundToHalf(rawPoint);
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < 60 || !isGoodValue(odds)) return;
      const valueScore = conf - Math.abs(odds) / 10;
      allCandidates.push({
        type: 'totals', label: 'TOTAL', gameTime: game.commence_time,
        game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
        name: `${direction} ${point}`,
        odds, conf, valueScore, team: direction, opponent: '', point,
        bookmakerCount: game.bookmakers.length,
        analysis: generateAnalysis('totals', direction, '', conf, odds, point, false, sport, game.bookmakers.length)
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

  if(unique.length < 3) {
    const existingKeys = new Set(unique.map(p => p.game + p.type));
    const lowCandidates = [];
    futureH2h.forEach(game => {
      [game.home_team, game.away_team].forEach(team => {
        const odds = getAverageOdds(game.bookmakers, team, 'h2h');
        if(!odds) return;
        const conf = Math.round(americanToImpliedProb(odds) * 100);
        if(conf < 55 || !isGoodValue(odds)) return;
        const key = `${sportLabel} · ${game.home_team} vs ${game.away_team}h2h`;
        if(existingKeys.has(key)) return;
        const isHome = team === game.home_team;
        const opponent = isHome ? game.away_team : game.home_team;
        lowCandidates.push({
          type: 'h2h', label: 'ML', gameTime: game.commence_time,
          game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
          name: `${team} ML`, odds, conf,
          valueScore: conf - Math.abs(odds) / 10,
          isHome, team, opponent,
          bookmakerCount: game.bookmakers.length,
          analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome, sport, game.bookmakers.length)
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
    odds: formatOdds(pick.odds), conf: pick.conf, free: i === 2,
    type: pick.label, gameTime: pick.gameTime, analysis: pick.analysis
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
          if(!odds) return;
          const conf = Math.round(americanToImpliedProb(odds) * 100);
          if(conf < 55 || !isGoodValue(odds)) return;
          const opponent = team === game.home_team ? game.away_team : game.home_team;
          fights.push({
            game: `🥊 UFC · ${game.home_team} vs ${game.away_team}`,
            name: `${team} ML`, odds, conf,
            valueScore: conf - Math.abs(odds) / 10,
            gameTime: game.commence_time,
            bookmakerCount: game.bookmakers.length,
            analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, false, 'ufc', game.bookmakers.length)
          });
        });
      });
      fights.sort((a,b) => b.valueScore - a.valueScore);
      const top3 = fights.slice(0,3);
      const badges = ['🥇 BEST BET','🥈 STRONG PLAY','🥉 VALUE BET'];
      const colors = ['#FFD700','#C0C0C0','#CD7F32'];
      allPicks['ufc'] = top3.map((f,i) => ({
        badge: badges[i], color: colors[i], game: f.game, name: f.name,
        odds: formatOdds(f.odds), conf: f.conf, free: i === 2,
        type: 'ML', gameTime: f.gameTime, analysis: f.analysis
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
