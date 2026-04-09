const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const ODDS_API_KEY = '2033e71d5b6784b9352bfa561db1a576';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://elwbxwzequrfucujhgsy.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

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

// FIX 1: Proper odds validation — blocks garbage lines like 0, +40, etc.
// Valid American odds are either negative (-105 to -200) or positive (+100 to +500)
function isGoodValue(odds) {
  if (odds === 0) return false;
  if (odds < 0) return odds >= -200; // e.g. -105, -150, -200 ✓ | -300 ✗
  if (odds > 0) return odds >= 100 && odds <= 500; // e.g. +110, +250 ✓ | +40 ✗
  return false;
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
  // Extra safety: return null if averaged result is still invalid
  if (avg === 0 || (avg > 0 && avg < 100)) return null;
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

async function savePick(sport, pick) {
  if(!pick.name || pick.name === 'Pro Pick' || pick.name === 'Check back at next update') return;

  // FIX 3: Use a 48-hour rolling window instead of just today's date
  // This prevents duplicates across midnight boundaries
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  try {
    const { data: existing } = await supabase
      .from('picks_history')
      .select('id')
      .eq('sport', sport)
      .eq('pick_name', pick.name)
      .eq('game', pick.game)
      .eq('bet_type', pick.type || 'ML')   // FIX 3: also match bet_type to prevent type-level dupes
      .gte('created_at', fortyEightHoursAgo)
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

async function generateAndSavePicks() {
  console.log('Fetching live odds and saving picks...');
  const now = new Date();
  const fortyEightHours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  for(const [sport, sportKey] of Object.entries(SPORTS)) {
    console.log(`Processing ${sport}...`);
    try {
      if(sport === 'ufc') {
        const games = await fetchOdds(sportKey, 'h2h');
        const upcomingFights = games.filter(game => {
          const gameTime = new Date(game.commence_time);
          const daysUntil = (gameTime - now) / 1000 / 60 / 60 / 24;
          return gameTime > now && daysUntil <= 7 && game.bookmakers && game.bookmakers.length >= 2;
        });
        if(upcomingFights.length === 0) { console.log('No UFC event this week'); continue; }
        const fights = [];
        upcomingFights.forEach(game => {
          [game.home_team, game.away_team].forEach(team => {
            const odds = getAverageOdds(game.bookmakers, team, 'h2h');
            if(!odds || !isGoodValue(odds)) return;
            const conf = Math.round(americanToImpliedProb(odds) * 100);
            if(conf < 55) return;
            fights.push({
              game: `🥊 UFC · ${game.home_team} vs ${game.away_team}`,
              name: `${team} ML`, odds, conf,
              valueScore: conf - Math.abs(odds)/10,
              gameTime: game.commence_time, type: 'ML'
            });
          });
        });
        fights.sort((a,b) => b.valueScore - a.valueScore);
        for(let i=0; i<Math.min(3, fights.length); i++) {
          await savePick('ufc', { ...fights[i], free: i===2, odds: formatOdds(fights[i].odds) });
        }
        continue;
      }

      const [h2hGames, spreadGames, totalGames] = await Promise.all([
        fetchOdds(sportKey, 'h2h'),
        fetchOdds(sportKey, 'spreads'),
        fetchOdds(sportKey, 'totals')
      ]);

      const allCandidates = [];
      const futureH2h = h2hGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < fortyEightHours && g.bookmakers && g.bookmakers.length >= 2);
      const futureSpread = spreadGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < fortyEightHours && g.bookmakers && g.bookmakers.length >= 2);
      const futureTotals = totalGames.filter(g => new Date(g.commence_time) > now && new Date(g.commence_time) < fortyEightHours && g.bookmakers && g.bookmakers.length >= 2);

      // Confidence thresholds per sport
      const mlConfThreshold = sport === 'mlb' ? 65 : 60;
      const spreadConfThreshold = sport === 'mlb' ? 65 : 60;
      const totalConfThreshold = sport === 'mlb' ? 65 : 60;

      // ML picks
      futureH2h.forEach(game => {
        [game.home_team, game.away_team].forEach(team => {
          const odds = getAverageOdds(game.bookmakers, team, 'h2h');
          if(!odds || !isGoodValue(odds)) return;
          const conf = Math.round(americanToImpliedProb(odds) * 100);
          if(conf < mlConfThreshold) return;
          allCandidates.push({
            type: 'ML', label: 'ML',
            gameTime: game.commence_time,
            game: `${SPORT_LABELS[sport]} · ${game.home_team} vs ${game.away_team}`,
            name: `${team} ML`, odds, conf,
            valueScore: conf - Math.abs(odds)/10
          });
        });
      });

      // Spread picks
      futureSpread.forEach(game => {
        [game.home_team, game.away_team].forEach(team => {
          const odds = getAverageOdds(game.bookmakers, team, 'spreads');
          const point = getAveragePoint(game.bookmakers, team, 'spreads');
          if(!odds || point === null || !isGoodValue(odds)) return;

          // FIX 2: MLB run lines and NHL puck lines are always ±1.5 — enforce it
          if (sport === 'mlb' || sport === 'nhl') {
            if (Math.abs(point) !== 1.5) return;
          }
          // NBA: spreads should be meaningful (at least 1.5 points)
          if (sport === 'nba' && Math.abs(point) < 1.5) return;

          const conf = Math.round(americanToImpliedProb(odds) * 100);
          if(conf < spreadConfThreshold) return;
          allCandidates.push({
            type: 'SPREAD', label: 'SPREAD',
            gameTime: game.commence_time,
            game: `${SPORT_LABELS[sport]} · ${game.home_team} vs ${game.away_team}`,
            name: `${team} ${point > 0 ? '+' : ''}${point}`,
            odds, conf,
            valueScore: conf - Math.abs(odds)/10
          });
        });
      });

      // Totals picks
      futureTotals.forEach(game => {
        ['Over', 'Under'].forEach(direction => {
          const odds = getAverageOdds(game.bookmakers, direction, 'totals');
          const point = getAveragePoint(game.bookmakers, direction, 'totals');
          if(!odds || point === null || !isGoodValue(odds)) return;
          const conf = Math.round(americanToImpliedProb(odds) * 100);
          if(conf < totalConfThreshold) return;
          allCandidates.push({
            type: 'TOTAL', label: 'TOTAL',
            gameTime: game.commence_time,
            game: `${SPORT_LABELS[sport]} · ${game.home_team} vs ${game.away_team}`,
            name: `${direction} ${point}`,
            odds, conf,
            valueScore: conf - Math.abs(odds)/10
          });
        });
      });

      allCandidates.sort((a,b) => b.valueScore - a.valueScore);
      const seen = new Set();
      const top3 = [];
      for(const pick of allCandidates) {
        const key = pick.game + pick.type;
        if(!seen.has(key)) { seen.add(key); top3.push(pick); }
        if(top3.length >= 3) break;
      }

      for(let i=0; i<top3.length; i++) {
        await savePick(sport, { ...top3[i], free: i===2, odds: formatOdds(top3[i].odds) });
      }
      console.log(`✓ ${sport} done`);
    } catch(e) {
      console.log(`Error processing ${sport}:`, e.message);
    }
  }
  console.log('✅ All picks saved to Supabase');
}

generateAndSavePicks();
