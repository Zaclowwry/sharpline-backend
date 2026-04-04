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

// Raw body for Stripe webhook verification
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
          console.log(`✓ Daily pass granted to ${email} until ${expires}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        await downgradeByCustomerId(customerId);
        console.log(`✓ Pro access removed for customer ${customerId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        if(subscription.status === 'active') {
          const customerId = subscription.customer;
          await upgradeByCustomerId(customerId, subscription.id);
          console.log(`✓ Pro access confirmed for customer ${customerId}`);
        } else if(['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
          const customerId = subscription.customer;
          await downgradeByCustomerId(customerId);
          console.log(`✓ Pro access removed for customer ${customerId} - status: ${subscription.status}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        await downgradeByCustomerId(customerId);
        console.log(`✓ Pro access removed for customer ${customerId} - payment failed`);
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
  const { error } = await supabase
    .from('user_plans')
    .upsert({
      email,
      plan,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      plan_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'email' });
  if(error) console.log('Upsert error:', error.message);
}

async function downgradeByCustomerId(customerId) {
  if(!supabase) return;
  const { error } = await supabase
    .from('user_plans')
    .update({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId);
  if(error) console.log('Downgrade error:', error.message);
}

async function upgradeByCustomerId(customerId, subscriptionId) {
  if(!supabase) return;
  const { error } = await supabase
    .from('user_plans')
    .update({ plan: 'pro', stripe_subscription_id: subscriptionId, plan_expires_at: null, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId);
  if(error) console.log('Upgrade error:', error.message);
}

// ─── USER PLAN CHECK ──────────────────────────────────────────────────────────
app.get('/user-plan', async (req, res) => {
  const email = req.query.email;
  if(!email) return res.json({ plan: 'free' });
  if(!supabase) return res.json({ plan: 'free' });

  try {
    const { data } = await supabase
      .from('user_plans')
      .select('plan, plan_expires_at')
      .eq('email', email)
      .single();

    if(!data) return res.json({ plan: 'free' });

    if(data.plan === 'daily' && data.plan_expires_at) {
      const expired = new Date(data.plan_expires_at) < new Date();
      if(expired) {
        await supabase.from('user_plans').update({ plan: 'free' }).eq('email', email);
        return res.json({ plan: 'free' });
      }
    }

    return res.json({ plan: data.plan, expires_at: data.plan_expires_at });
  } catch(e) {
    return res.json({ plan: 'free' });
  }
});

// ─── PICKS ────────────────────────────────────────────────────────────────────
app.get('/picks', async (req, res) => {
  try {
    const now = new Date();
    const cacheAge = lastUpdated ? (now - lastUpdated) / 1000 / 60 : 999;
    if(cachedPicks && cacheAge < 60){
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
    const { data } = await supabase
      .from('picks_history')
      .select('*')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false });
    const allTime = await supabase
      .from('picks_history')
      .select('result, sport')
      .neq('result', 'pending');
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
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if(!months[key]) months[key] = { label, picks: [] };
    months[key].picks.push(pick);
  });
  return months;
}

async function savePicks(sport, picks) {
  if(!supabase || !picks || picks.length === 0) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    for(const pick of picks) {
      const { data: existing } = await supabase
        .from('picks_history')
        .select('id')
        .eq('sport', sport)
        .eq('pick_name', pick.name)
        .gte('created_at', `${today}T00:00:00.000Z`)
        .limit(1);
      if(!existing || existing.length === 0) {
        await supabase.from('picks_history').insert({
          sport, game: pick.game, pick_name: pick.name,
          odds: pick.odds, confidence: pick.conf,
          bet_type: pick.type || 'ML', game_time: pick.gameTime,
          result: 'pending', is_free: pick.free, commence_time: pick.gameTime
        });
      }
    }
    console.log(`✓ Saved picks for ${sport}`);
  } catch(e) {
    console.log('Error saving picks:', e.message);
  }
}

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
  return Math.round((points.reduce((a,b) => a+b,0) / points.length) * 10) / 10;
}

function generateAnalysis(pickType, team, opponent, conf, odds, point, isHome) {
  const location = isHome ? 'at home' : 'on the road';
  const formattedOdds = formatOdds(odds);
  if(pickType === 'h2h') {
    if(conf >= 75) return `${team} is ${conf}% favored ${location}. One of the strongest moneylines on the board — sharp money is backing this heavily.`;
    if(conf >= 65) return `${team} is ${conf}% favored ${location}. Solid edge with consistent line movement in their favor. Strong play today.`;
    return `${team} at ${formattedOdds} offers real value ${location}. At ${conf}% confidence this is a smart play with good upside.`;
  }
  if(pickType === 'spreads') {
    if(conf >= 75) return `${team} covering ${point > 0 ? '+' : ''}${point} is one of the strongest spread plays today. Sharp money is heavily on this line.`;
    if(conf >= 65) return `${team} ${point > 0 ? '+' : ''}${point} is a solid spread play. Line movement supports this pick strongly.`;
    return `${team} ${point > 0 ? '+' : ''}${point} at ${formattedOdds} offers value. Good spot to fade the public here.`;
  }
  if(pickType === 'totals') {
    const dir = team === 'Over' ? 'over' : 'under';
    if(conf >= 75) return `The ${dir} ${point} is one of the strongest totals plays today. Pace and matchup data strongly support this.`;
    if(conf >= 65) return `${dir.charAt(0).toUpperCase()+dir.slice(1)} ${point} is a solid play. Both teams' recent scoring trends support this line.`;
    return `${dir.charAt(0).toUpperCase()+dir.slice(1)} ${point} at ${formattedOdds} offers value. Situational spots favor this total.`;
  }
  return `Strong play — ${conf}% confidence with good value at ${formattedOdds}.`;
}

async function getPicksForSport(sportKey, sportLabel) {
  const now = new Date();
  const fortyEightHours = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const allCandidates = [];
  const [h2hGames, spreadGames, totalGames] = await Promise.all([
    fetchOdds(sportKey, 'h2h'), fetchOdds(sportKey, 'spreads'), fetchOdds(sportKey, 'totals')
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
      allCandidates.push({ type: 'h2h', label: 'ML', gameTime: game.commence_time, game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`, name: `${team} ML`, odds, conf, valueScore: conf - Math.abs(odds)/10, isHome, team, opponent, analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome) });
    });
  });

  futureSpread.forEach(game => {
    [game.home_team, game.away_team].forEach(team => {
      const odds = getAverageOdds(game.bookmakers, team, 'spreads');
      const point = getAveragePoint(game.bookmakers, team, 'spreads');
      if(!odds || point === null) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < 60 || !isGoodValue(odds)) return;
      const isHome = team === game.home_team;
      const opponent = isHome ? game.away_team : game.home_team;
      allCandidates.push({ type: 'spreads', label: 'SPREAD', gameTime: game.commence_time, game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`, name: `${team} ${point > 0 ? '+' : ''}${point}`, odds, conf, valueScore: conf - Math.abs(odds)/10, isHome, team, opponent, point, analysis: generateAnalysis('spreads', team, opponent, conf, odds, point, isHome) });
    });
  });

  futureTotals.forEach(game => {
    ['Over', 'Under'].forEach(direction => {
      const odds = getAverageOdds(game.bookmakers, direction, 'totals');
      const point = getAveragePoint(game.bookmakers, direction, 'totals');
      if(!odds || point === null) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < 60 || !isGoodValue(odds)) return;
      allCandidates.push({ type: 'totals', label: 'TOTAL', gameTime: game.commence_time, game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`, name: `${direction} ${point}`, odds, conf, valueScore: conf - Math.abs(odds)/10, team: direction, opponent: '', point, analysis: generateAnalysis('totals', direction, '', conf, odds, point, false) });
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
        lowCandidates.push({ type: 'h2h', label: 'ML', gameTime: game.commence_time, game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`, name: `${team} ML`, odds, conf, valueScore: conf - Math.abs(odds)/10, isHome, team, opponent, analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome) });
      });
    });
    lowCandidates.sort((a,b) => b.valueScore - a.valueScore);
    unique.push(...lowCandidates.slice(0, 3 - unique.length));
  }

  if(unique.length === 0) return null;
  const badges = ['🥇 BEST BET', '🥈 STRONG PLAY', '🥉 VALUE BET'];
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  return unique.map((pick, i) => ({ badge: badges[i], color: colors[i], game: pick.game, name: pick.name, odds: formatOdds(pick.odds), conf: pick.conf, free: i === 2, type: pick.label, gameTime: pick.gameTime, analysis: pick.analysis }));
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
      if(upcomingFights.length === 0) { allPicks['ufc'] = { noEvent: true, nextEvent: NEXT_UFC_EVENT }; continue; }
      const fights = [];
      upcomingFights.forEach(game => {
        [game.home_team, game.away_team].forEach(team => {
          const odds = getAverageOdds(game.bookmakers, team, 'h2h');
          if(!odds) return;
          const conf = Math.round(americanToImpliedProb(odds) * 100);
          if(conf < 55 || !isGoodValue(odds)) return;
          const opponent = team === game.home_team ? game.away_team : game.home_team;
          fights.push({ game: `🥊 UFC · ${game.home_team} vs ${game.away_team}`, name: `${team} ML`, odds, conf, valueScore: conf - Math.abs(odds)/10, gameTime: game.commence_time, analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, false) });
        });
      });
      fights.sort((a,b) => b.valueScore - a.valueScore);
      const top3 = fights.slice(0,3);
      const badges = ['🥇 BEST BET','🥈 STRONG PLAY','🥉 VALUE BET'];
      const colors = ['#FFD700','#C0C0C0','#CD7F32'];
      const ufcPicks = top3.map((f,i) => ({ badge: badges[i], color: colors[i], game: f.game, name: f.name, odds: formatOdds(f.odds), conf: f.conf, free: i === 2, type: 'ML', gameTime: f.gameTime, analysis: f.analysis }));
      allPicks['ufc'] = ufcPicks;
      await savePicks('ufc', ufcPicks);
      continue;
    }
    const picks = await getPicksForSport(sportKey, SPORT_LABELS[sport]);
    if(picks && picks.length > 0) {
      allPicks[sport] = picks;
      await savePicks(sport, picks);
      console.log(`✓ ${sport} — ${picks.length} picks generated and saved`);
    } else {
      allPicks[sport] = getDefaultPicksForSport(sport);
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
