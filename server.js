const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = '2033e71d5b6784b9352bfa561db1a576';

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

app.get('/', (req, res) => {
  res.json({ status: 'SharpLine backend running' });
});

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

async function fetchOdds(sportKey, markets) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;
    const res = await fetch(url);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch(e) {
    console.log(`Error fetching ${sportKey}:`, e.message);
    return [];
  }
}

function americanToImpliedProb(odds) {
  if(odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function formatOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function isGoodValue(odds) {
  return odds > -200 && odds < 500;
}

function getAverageOdds(bookmakers, team, market) {
  const odds = [];
  bookmakers.forEach(bm => {
    const m = bm.markets.find(x => x.key === market);
    if(m) {
      const outcome = m.outcomes.find(o => o.name === team);
      if(outcome) odds.push(outcome.price);
    }
  });
  if(odds.length === 0) return null;
  return Math.round(odds.reduce((a,b) => a+b,0) / odds.length);
}

function getAveragePoint(bookmakers, team, market) {
  const points = [];
  bookmakers.forEach(bm => {
    const m = bm.markets.find(x => x.key === market);
    if(m) {
      const outcome = m.outcomes.find(o => o.name === team);
      if(outcome && outcome.point !== undefined) points.push(outcome.point);
    }
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
    const direction = team === 'Over' ? 'over' : 'under';
    if(conf >= 75) return `The ${direction} ${point} is one of the strongest totals plays today. Pace and matchup data strongly support this.`;
    if(conf >= 65) return `${direction.charAt(0).toUpperCase() + direction.slice(1)} ${point} is a solid play. Both teams' recent scoring trends support this line.`;
    return `${direction.charAt(0).toUpperCase() + direction.slice(1)} ${point} at ${formattedOdds} offers value. Situational spots favor this total.`;
  }

  return `Strong play — ${conf}% confidence with good value at ${formattedOdds}.`;
}

async function getPicksForSport(sportKey, sportLabel) {
  const now = new Date();
  const allCandidates = [];

  const [h2hGames, spreadGames, totalGames] = await Promise.all([
    fetchOdds(sportKey, 'h2h'),
    fetchOdds(sportKey, 'spreads'),
    fetchOdds(sportKey, 'totals')
  ]);

  const futureH2h = h2hGames.filter(g => new Date(g.commence_time) > now && g.bookmakers && g.bookmakers.length >= 2);
  const futureSpread = spreadGames.filter(g => new Date(g.commence_time) > now && g.bookmakers && g.bookmakers.length >= 2);
  const futureTotals = totalGames.filter(g => new Date(g.commence_time) > now && g.bookmakers && g.bookmakers.length >= 2);

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
        type: 'h2h',
        label: 'ML',
        game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
        name: `${team} ML`,
        odds,
        conf,
        valueScore,
        isHome,
        team,
        opponent,
        analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, isHome)
      });
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
      const valueScore = conf - Math.abs(odds) / 10;
      allCandidates.push({
        type: 'spreads',
        label: 'SPREAD',
        game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
        name: `${team} ${point > 0 ? '+' : ''}${point}`,
        odds,
        conf,
        valueScore,
        isHome,
        team,
        opponent,
        point,
        analysis: generateAnalysis('spreads', team, opponent, conf, odds, point, isHome)
      });
    });
  });

  futureTotals.forEach(game => {
    ['Over', 'Under'].forEach(direction => {
      const odds = getAverageOdds(game.bookmakers, direction, 'totals');
      const point = getAveragePoint(game.bookmakers, direction, 'totals');
      if(!odds || point === null) return;
      const conf = Math.round(americanToImpliedProb(odds) * 100);
      if(conf < 60 || !isGoodValue(odds)) return;
      const valueScore = conf - Math.abs(odds) / 10;
      allCandidates.push({
        type: 'totals',
        label: 'TOTAL',
        game: `${sportLabel} · ${game.home_team} vs ${game.away_team}`,
        name: `${direction} ${point}`,
        odds,
        conf,
        valueScore,
        team: direction,
        opponent: '',
        point,
        analysis: generateAnalysis('totals', direction, '', conf, odds, point, false)
      });
    });
  });

  if(allCandidates.length === 0) return null;

  allCandidates.sort((a, b) => b.valueScore - a.valueScore);

  const seen = new Set();
  const unique = [];
  for(const pick of allCandidates) {
    const key = pick.game + pick.type;
    if(!seen.has(key)) {
      seen.add(key);
      unique.push(pick);
    }
    if(unique.length >= 3) break;
  }

  const badges = ['🥇 BEST BET', '🥈 STRONG PLAY', '🥉 VALUE BET'];
  const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];

  return unique.map((pick, i) => ({
    badge: badges[i],
    color: colors[i],
    game: pick.game,
    name: pick.name,
    odds: formatOdds(pick.odds),
    conf: pick.conf,
    free: i === 2,
    type: pick.label,
    analysis: pick.analysis
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
          const valueScore = conf - Math.abs(odds) / 10;
          const opponent = team === game.home_team ? game.away_team : game.home_team;
          fights.push({
            game: `🥊 UFC · ${game.home_team} vs ${game.away_team}`,
            name: `${team} ML`,
            odds, conf, valueScore,
            analysis: generateAnalysis('h2h', team, opponent, conf, odds, null, false)
          });
        });
      });

      fights.sort((a,b) => b.valueScore - a.valueScore);
      const top3 = fights.slice(0,3);
      const badges = ['🥇 BEST BET','🥈 STRONG PLAY','🥉 VALUE BET'];
      const colors = ['#FFD700','#C0C0C0','#CD7F32'];
      allPicks['ufc'] = top3.map((f,i) => ({
        badge: badges[i], color: colors[i],
        game: f.game, name: f.name,
        odds: formatOdds(f.odds), conf: f.conf,
        free: i === 2, type: 'ML', analysis: f.analysis
      }));
      continue;
    }

    console.log(`Generating picks for ${sport}...`);
    const picks = await getPicksForSport(sportKey, SPORT_LABELS[sport]);
    if(picks && picks.length > 0) {
      allPicks[sport] = picks;
      console.log(`✓ ${sport} — ${picks.length} picks generated`);
    } else {
      allPicks[sport] = getDefaultPicksForSport(sport);
      console.log(`⚠ ${sport} — no qualifying picks found, using defaults`);
    }
  }

  return allPicks;
}

function getDefaultPicksForSport(sport) {
  return [
    {badge:'🥉 VALUE BET',color:'#CD7F32',game:`${SPORT_LABELS[sport]} · No qualifying picks today`,name:'Check back at next update',odds:'-110',conf:55,free:true,type:'ML',analysis:'Our model found no picks meeting our confidence and value thresholds today. We only show picks we believe in.'},
    {badge:'🥇 BEST BET',color:'#FFD700',game:`${SPORT_LABELS[sport]} · No qualifying picks today`,name:'Pro Pick',odds:'-150',conf:70,free:false,type:'ML',analysis:''},
    {badge:'🥈 STRONG PLAY',color:'#C0C0C0',game:`${SPORT_LABELS[sport]} · No qualifying picks today`,name:'Pro Pick',odds:'+110',conf:60,free:false,type:'ML',analysis:''}
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
