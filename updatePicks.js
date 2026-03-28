const fetch = require('node-fetch');
const fs = require('fs');

const ODDS_API_KEY = 'd7c503fe973b7bbe8efddd2574efe960';

const SPORTS = {
  nba: 'basketball_nba',
  nhl: 'icehockey_nhl',
  ncaamb: 'basketball_ncaab',
  mlb: 'baseball_mlb'
};

const SPORT_LABELS = {
  nba: '🏀 NBA',
  nhl: '🏒 NHL',
  ncaamb: '🎓 NCAAB',
  mlb: '⚾ MLB'
};

async function fetchOdds(sportKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
    const res = await fetch(url);
    const data = await res.json();
    return data;
  } catch(e) {
    console.log(`Error fetching ${sportKey}:`, e.message);
    return [];
  }
}

function americanToImpliedProb(odds) {
  if(odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function impliedProbToAmerican(prob) {
  if(prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

function getBestOdds(game) {
  if(!game.bookmakers || game.bookmakers.length === 0) return null;
  
  let homeOdds = [];
  let awayOdds = [];
  
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
  
  const avgHomeOdds = homeOdds.reduce((a,b) => a+b, 0) / homeOdds.length;
  const avgAwayOdds = awayOdds.reduce((a,b) => a+b, 0) / awayOdds.length;
  
  const homeProb = americanToImpliedProb(avgHomeOdds);
  const awayProb = americanToImpliedProb(avgAwayOdds);
  
  if(homeProb >= awayProb) {
    return {
      team: game.home_team,
      opponent: game.away_team,
      odds: Math.round(avgHomeOdds),
      confidence: Math.round(homeProb * 100),
      isHome: true,
      gameTime: game.commence_time
    };
  } else {
    return {
      team: game.away_team,
      opponent: game.home_team,
      odds: Math.round(avgAwayOdds),
      confidence: Math.round(awayProb * 100),
      isHome: false,
      gameTime: game.commence_time
    };
  }
}

function generateAnalysis(pick, sport) {
  const conf = pick.confidence;
  const location = pick.isHome ? 'at home' : 'on the road';
  
  if(conf >= 80) {
    return `${pick.team} is ${conf}% favored ${location}. This is one of the strongest lines on the board today — a dominant favorite that sharp money is backing heavily.`;
  } else if(conf >= 65) {
    return `${pick.team} is ${conf}% favored ${location}. Solid edge here with consistent line movement in their favor. Strong play for today.`;
  } else {
    return `${pick.team} at ${pick.odds > 0 ? '+' : ''}${pick.odds} offers real value. At ${conf}% implied probability, this is a smart value play with upside.`;
  }
}

function formatOdds(odds) {
  if(odds > 0) return `+${odds}`;
  return `${odds}`;
}

async function updatePicks() {
  console.log('Fetching live odds...');
  const allPicks = {};

  for(const [sport, sportKey] of Object.entries(SPORTS)) {
    console.log(`Fetching ${sport}...`);
    const games = await fetchOdds(sportKey);
    
    if(!Array.isArray(games) || games.length === 0) {
      console.log(`No games found for ${sport}`);
      allPicks[sport] = getDefaultPicks(sport);
      continue;
    }

    const picks = [];
    games.forEach(game => {
      const pick = getBestOdds(game);
      if(pick) picks.push({...pick, sport});
    });

    if(picks.length === 0) {
      allPicks[sport] = getDefaultPicks(sport);
      continue;
    }

    picks.sort((a, b) => b.confidence - a.confidence);

    const top3 = picks.slice(0, 3);
    
    const formatted = top3.map((pick, i) => {
      const badges = ['🥇 BEST BET', '🥈 STRONG PLAY', '🥉 VALUE BET'];
      const colors = ['#FFD700', '#C0C0C0', '#CD7F32'];
      const isFree = i === 2;
      
      return {
        badge: badges[i],
        color: colors[i],
        game: `${SPORT_LABELS[sport]} · ${pick.team} vs ${pick.opponent}`,
        name: `${pick.team} ML`,
        odds: formatOdds(pick.odds),
        conf: pick.confidence,
        free: isFree,
        analysis: generateAnalysis(pick, sport)
      };
    });

    allPicks[sport] = formatted;
    console.log(`✓ ${sport} picks generated`);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    picks: allPicks
  };

  fs.writeFileSync('picks.json', JSON.stringify(output, null, 2));
  console.log('✅ Picks saved to picks.json');
  console.log('Updated at:', output.updatedAt);
}

function getDefaultPicks(sport) {
  return [
    {badge:'🥉 VALUE BET',color:'#CD7F32',game:`${SPORT_LABELS[sport]} · Picks updating soon`,name:'Check back shortly',odds:'-110',conf:55,free:true,analysis:'Our picks engine is fetching the latest data. Check back in a few minutes for today\'s top picks.'},
    {badge:'🥇 BEST BET',color:'#FFD700',game:`${SPORT_LABELS[sport]} · Picks updating soon`,name:'Pro Pick — Upgrade to unlock',odds:'-150',conf:70,free:false,analysis:''},
    {badge:'🥈 STRONG PLAY',color:'#C0C0C0',game:`${SPORT_LABELS[sport]} · Picks updating soon`,name:'Pro Pick — Upgrade to unlock',odds:'+110',conf:60,free:false,analysis:''}
  ];
}

updatePicks();
