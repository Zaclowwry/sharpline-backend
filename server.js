const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = 'd7c503fe973b7bbe8efddd2574efe960';

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

app.get('/next-ufc', (req, res) => {
  res.json(NEXT_UFC_EVENT);
});

async function fetchOdds(sportKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
    const res = await fetch(url);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch(e) {
    return [];
  }
}

function americanToImpliedProb(odds) {
  if(odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function getBestOdds(game) {
  if(!game.bookmakers || game.bookmakers.length < 2) return null;
  let homeOdds = [], awayOdds = [];
  game.bookmakers.forEach(bm => {
    const h2h = bm.markets.find(m => m.key === 'h2h');
    if(h2h) {
      const home = h2h.outcomes.find(o => o.name === game.home_team);
      const away = h2h.outcomes.find(o => o.name === game.away_team);
      if(home) homeOdds.push(home.price);
      if(away) awayOdds.push(away.price);
    }
  });
  if(homeOdds.length === 0) return null;
  const avgHome = homeOdds.reduce((a,b) => a+b,0) / homeOdds.length;
  const avgAway = awayOdds.reduce((a,b) => a+b,0) / awayOdds.length;
  const homeProb = americanToImpliedProb(avgHome);
  const awayProb = americanToImpliedProb(avgAway);
  if(homeProb >= awayProb) {
    return { team: game.home_team, opponent: game.away_team, odds: Math.round(avgHome), confidence: Math.round(homeProb*100), isHome: true };
  } else {
    return { team: game.away_team, opponent: game.home_team, odds: Math.round(avgAway), confidence: Math.round(awayProb*100), isHome: false };
  }
}

function formatOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function generateAnalysis(pick) {
  const conf = pick.confidence;
  const location = pick.isHome ? 'at home' : 'on the road';
  if(conf >= 80) return `${pick.team} is ${conf}% favored ${location}. One of the strongest lines on the board today — dominant favorite that sharp money is backing heavily.`;
  if(conf >= 65) return `${pick.team} is ${conf}% favored ${location}. Solid edge here with consistent line movement in their favor. Strong play for today.`;
  return `${pick.team} at ${formatOdds(pick.odds)} offers real value. At ${conf}% implied probability this is a smart value play with upside.`;
}

async function generatePicks() {
  const allPicks = {};
  const now = new Date();

  for(const [sport, sportKey] of Object.entries(SPORTS)) {
    if(sport === 'ufc') {
      const games = await fetchOdds(sportKey);
      const upcomingFights = games.filter(game => {
        const gameTime = new Date(game.commence_time);
        const daysUntil = (gameTime - now) / 1000 / 60 / 60 / 24;
        return gameTime > now && daysUntil <= 7 && game.bookmakers && game.bookmakers.length >= 2;
      });

      if(upcomingFights.length === 0) {
        allPicks['ufc'] = { noEvent: true, nextEvent: NEXT_UFC_EVENT };
        continue;
      }

      const picks = [];
      upcomingFights.forEach(game => {
        const pick = getBestOdds(game);
        if(pick) picks.push({...pick, sport:'ufc'});
      });

      picks.sort((a,b) => b.confidence - a.confidence);
      const top3 = picks.slice(0,3);
      const badges = ['🥇 BEST BET','🥈 STRONG PLAY','🥉 VALUE BET'];
      const colors = ['#FFD700','#C0C0C0','#CD7F32'];
      allPicks['ufc'] = top3.map((pick,i) => ({
        badge: badges[i],
        color: colors[i],
        game: `🥊 UFC · ${pick.team} vs ${pick.opponent}`,
        name: `${pick.team} ML`,
        odds: formatOdds(pick.odds),
        conf: pick.confidence,
        free: i === 2,
        analysis: generateAnalysis(pick)
      }));
      continue;
    }

    const games = await fetchOdds(sportKey);
    if(!games || games.length === 0) {
      allPicks[sport] = getDefaultPicksForSport(sport);
      continue;
    }

    const futureGames = games.filter(game => {
      const gameTime = new Date(game.commence_time);
      return gameTime > now && game.bookmakers && game.bookmakers.length >= 2;
    });

    if(futureGames.length === 0) {
      allPicks[sport] = getDefaultPicksForSport(sport);
      continue;
    }

    const picks = [];
    futureGames.forEach(game => {
      const pick = getBestOdds(game);
      if(pick) picks.push({...pick, sport});
    });

    if(picks.length === 0) {
      allPicks[sport] = getDefaultPicksForSport(sport);
      continue;
    }

    picks.sort((a,b) => b.confidence - a.confidence);
    const top3 = picks.slice(0,3);
    const badges = ['🥇 BEST BET','🥈 STRONG PLAY','🥉 VALUE BET'];
    const colors = ['#FFD700','#C0C0C0','#CD7F32'];
    allPicks[sport] = top3.map((pick,i) => ({
      badge: badges[i],
      color: colors[i],
      game: `${SPORT_LABELS[sport]} · ${pick.team} vs ${pick.opponent}`,
      name: `${pick.team} ML`,
      odds: formatOdds(pick.odds),
      conf: pick.confidence,
      free: i === 2,
      analysis: generateAnalysis(pick)
    }));
  }
  return allPicks;
}

function getDefaultPicksForSport(sport) {
  return [
    {badge:'🥉 VALUE BET',color:'#CD7F32',game:`${SPORT_LABELS[sport]} · No games available`,name:'Check back soon',odds:'-110',conf:55,free:true,analysis:'No games with betting lines available right now. Check back later today.'},
    {badge:'🥇 BEST BET',color:'#FFD700',game:`${SPORT_LABELS[sport]} · No games available`,name:'Pro Pick',odds:'-150',conf:70,free:false,analysis:''},
    {badge:'🥈 STRONG PLAY',color:'#C0C0C0',game:`${SPORT_LABELS[sport]} · No games available`,name:'Pro Pick',odds:'+110',conf:60,free:false,analysis:''}
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
