const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const ODDS_API_KEY = '2033e71d5b6784b9352bfa561db1a576';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://elwbxwzequrfucujhgsy.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const SCORES_SPORTS = {
  nba: 'basketball_nba',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl'
};

async function checkAndUpdateResults() {
  console.log('🔍 Checking results...');
  try {
    const { data: pendingPicks } = await supabase
      .from('picks_history')
      .select('*')
      .eq('result', 'pending')
      .lt('commence_time', new Date().toISOString());

    if(!pendingPicks || pendingPicks.length === 0) {
      console.log('✅ No pending picks to check');
      return;
    }

    console.log(`Checking ${pendingPicks.length} pending picks...`);

    for(const [sport, sportKey] of Object.entries(SCORES_SPORTS)) {
      const sportPending = pendingPicks.filter(p => p.sport === sport);
      if(sportPending.length === 0) continue;

      try {
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`;
        const res = await fetch(url);
        const scores = await res.json();
        if(!Array.isArray(scores)) continue;

        for(const pick of sportPending) {
          const gameResult = findGameResult(scores, pick);
          if(gameResult) {
            const result = determineResult(pick, gameResult);
            if(result) {
              await supabase
                .from('picks_history')
                .update({ result })
                .eq('id', pick.id);
              console.log(`✓ ${pick.pick_name} — ${result.toUpperCase()}`);
            }
          }
        }
      } catch(e) {
        console.log(`Error checking ${sport}:`, e.message);
      }
    }

    console.log('✅ Results check complete');
  } catch(e) {
    console.log('Error:', e.message);
  }
}

function findGameResult(scores, pick) {
  return scores.find(score => {
    if(!score.completed) return false;
    const homeMatch = score.home_team && pick.game && pick.game.includes(score.home_team);
    const awayMatch = score.away_team && pick.game && pick.game.includes(score.away_team);
    return homeMatch && awayMatch;
  });
}

function determineResult(pick, gameResult) {
  try {
    if(!gameResult.scores || gameResult.scores.length < 2) return null;
    const homeScore = parseInt(gameResult.scores.find(s => s.name === gameResult.home_team)?.score || 0);
    const awayScore = parseInt(gameResult.scores.find(s => s.name === gameResult.away_team)?.score || 0);
    const pickName = pick.pick_name.toLowerCase();
    const betType = pick.bet_type;

    if(betType === 'ML') {
      const winner = homeScore > awayScore ? gameResult.home_team : gameResult.away_team;
      if(homeScore === awayScore) return 'push';
      return pickName.includes(winner.toLowerCase()) ? 'win' : 'loss';
    }

    if(betType === 'SPREAD') {
      const spreadMatch = pick.pick_name.match(/([+-]\d+\.?\d*)/);
      if(!spreadMatch) return null;
      const spread = parseFloat(spreadMatch[1]);
      const isHome = pickName.includes(gameResult.home_team.toLowerCase());
      const teamScore = isHome ? homeScore : awayScore;
      const oppScore = isHome ? awayScore : homeScore;
      const adjustedScore = teamScore + spread;
      if(adjustedScore === oppScore) return 'push';
      return adjustedScore > oppScore ? 'win' : 'loss';
    }

    if(betType === 'TOTAL') {
      const totalMatch = pick.pick_name.match(/(\d+\.?\d*)/);
      if(!totalMatch) return null;
      const total = parseFloat(totalMatch[1]);
      const combined = homeScore + awayScore;
      if(combined === total) return 'push';
      if(pickName.includes('over')) return combined > total ? 'win' : 'loss';
      if(pickName.includes('under')) return combined < total ? 'win' : 'loss';
    }

    return null;
  } catch(e) {
    return null;
  }
}

checkAndUpdateResults();
