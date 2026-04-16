const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
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
        // Use daysFrom=7 to catch any picks from the past week
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=7`;
        const res = await fetch(url);
        const scores = await res.json();
        if(!Array.isArray(scores)) {
          console.log(`No scores data for ${sport}`);
          continue;
        }

        console.log(`Found ${scores.filter(s => s.completed).length} completed ${sport} games`);

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
            } else {
              console.log(`⚠ Could not determine result for: ${pick.pick_name}`);
            }
          } else {
            console.log(`⚠ No game found for: ${pick.game}`);
          }
        }
      } catch(e) {
        console.log(`Error checking ${sport}:`, e.message);
      }
    }

    // UFC picks: mark as pending-forever note — no scores API available
    // They will remain pending until manually graded
    const ufcPending = pendingPicks.filter(p => p.sport === 'ufc');
    if(ufcPending.length > 0) {
      console.log(`ℹ ${ufcPending.length} UFC picks remain pending — no scores API available for MMA`);
    }

    console.log('✅ Results check complete');
  } catch(e) {
    console.log('Error:', e.message);
  }
}

function findGameResult(scores, pick) {
  return scores.find(score => {
    if(!score.completed) return false;

    const homeTeam = score.home_team ? score.home_team.toLowerCase() : '';
    const awayTeam = score.away_team ? score.away_team.toLowerCase() : '';
    const gameStr = pick.game ? pick.game.toLowerCase() : '';

    // Match both teams appearing in the game string
    // Works with both "Team A vs Team B" and "Team A @ Team B" formats
    const homeMatch = homeTeam && gameStr.includes(homeTeam);
    const awayMatch = awayTeam && gameStr.includes(awayTeam);

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

    console.log(`  Grading: ${pick.pick_name} | ${gameResult.home_team} ${homeScore} - ${awayScore} ${gameResult.away_team}`);

    if(betType === 'ML') {
      if(homeScore === awayScore) return 'push';
      const winner = homeScore > awayScore ? gameResult.home_team : gameResult.away_team;
      return pickName.includes(winner.toLowerCase()) ? 'win' : 'loss';
    }

    if(betType === 'SPREAD') {
      const spreadMatch = pick.pick_name.match(/([+-]\d+\.?\d*)/);
      if(!spreadMatch) return null;
      const spread = parseFloat(spreadMatch[1]);

      // Determine which team we picked
      const homeTeamLower = gameResult.home_team.toLowerCase();
      const awayTeamLower = gameResult.away_team.toLowerCase();
      const isHome = pickName.includes(homeTeamLower);
      const isAway = pickName.includes(awayTeamLower);

      if(!isHome && !isAway) return null;

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
    console.log(`  Error grading pick:`, e.message);
    return null;
  }
}

checkAndUpdateResults();
