/**
 * 🐾 SCOUT BOWIE NFL MONTE CARLO SIMULATION WORKER
 * High-performance Web Worker executing:
 * 1. 10,000-Iteration Survivor Pool Simulations
 * 2. 10,000-Iteration Same-Game Parlay (SGP) & Multi-Game Parlay Simulations
 */

self.onmessage = function(e) {
  const data = e.data || {};

  // Check action type
  if (data.action === 'SIMULATE_PARLAY') {
    const { legs = [], slateData = [], iterations = 10000 } = data;
    try {
      const results = runParlaySimulation(legs, slateData, iterations, (pct) => {
        self.postMessage({ type: 'parlay_progress', percent: pct });
      });
      self.postMessage({ type: 'parlay_complete', results });
    } catch (err) {
      self.postMessage({ type: 'parlay_error', error: err.message });
    }
    return;
  }

  // Default: Survivor 10k Simulation
  const { path: userPath, slateData, poolSize = 100, iterations = 10000, targetHorizon = 11 } = data;

  try {
    const results = runMonteCarloSimulation(userPath, slateData, poolSize, iterations, targetHorizon, (pct) => {
      self.postMessage({ type: 'progress', percent: pct });
    });
    self.postMessage({ type: 'complete', results });
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

// ==========================================
// PARLAY & SGP 10,000-ITERATION SIMULATION
// ==========================================

function runParlaySimulation(legs, slateData, iterations = 10000, progressCb) {
  if (!Array.isArray(legs) || legs.length === 0) {
    return {
      winProbability: 0,
      winCount: 0,
      iterations,
      fairAmericanOdds: 100,
      pushCount: 0
    };
  }

  // 1. Build Game Baseline Lookup for all games involved in the slip
  const gameBaselines = {};
  legs.forEach(leg => {
    if (!gameBaselines[leg.gameId]) {
      let gameObj = null;
      if (Array.isArray(slateData)) {
        for (const weekObj of slateData) {
          const found = (weekObj.games || []).find(g => g.id === leg.gameId);
          if (found) { gameObj = found; break; }
        }
      }

      const spread = gameObj ? Number(gameObj.spread || 0) : Number(leg.lineValue || 0);
      const total = gameObj ? Number(gameObj.total || 44) : 44.0;

      // Implied Team Score Baselines:
      // HomeMean = (Total - Spread)/2, AwayMean = (Total + Spread)/2
      const homeMean = (total - spread) / 2;
      const awayMean = (total + spread) / 2;

      gameBaselines[leg.gameId] = {
        id: leg.gameId,
        homeTeam: gameObj?.homeTeam || leg.homeTeam,
        awayTeam: gameObj?.awayTeam || leg.awayTeam,
        spread,
        total,
        homeMean,
        awayMean,
        stdDev: 10.5 // Standard NFL scoring variance
      };
    }
  });

  const uniqueGameIds = Object.keys(gameBaselines);
  let winCount = 0;
  let totalPushCount = 0;
  const reportInterval = Math.max(500, Math.floor(iterations / 20));

  // Marsaglia Polar / Box-Muller normal sampling helper
  const sampleNormal = (mean, stdDev) => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.max(0, Math.round(mean + stdDev * z));
  };

  for (let iter = 1; iter <= iterations; iter++) {
    if (progressCb && iter % reportInterval === 0) {
      progressCb(Math.round((iter / iterations) * 100));
    }

    // Step A: Simulate synchronized scorelines for all games in the slip
    const simScores = {};
    uniqueGameIds.forEach(gid => {
      const bg = gameBaselines[gid];
      const homeScore = sampleNormal(bg.homeMean, bg.stdDev);
      const awayScore = sampleNormal(bg.awayMean, bg.stdDev);
      simScores[gid] = {
        homeScore,
        awayScore,
        totalScore: homeScore + awayScore,
        margin: homeScore - awayScore
      };
    });

    // Step B: Evaluate each ticket leg against the simulated scoreline
    let ticketFailed = false;
    let nonPushWins = 0;
    let runPushes = 0;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const sim = simScores[leg.gameId];
      if (!sim) continue;

      let legResult = 'LOSS'; // 'WIN' | 'PUSH' | 'LOSS'

      switch (leg.marketCategory) {
        case 'spread': {
          const isHome = leg.selection === leg.homeTeam;
          const effectiveSpread = Number(leg.lineValue);
          const teamScore = isHome ? sim.homeScore : sim.awayScore;
          const oppScore = isHome ? sim.awayScore : sim.homeScore;
          const finalWithSpread = teamScore + effectiveSpread;

          if (finalWithSpread > oppScore) {
            legResult = 'WIN';
          } else if (finalWithSpread === oppScore) {
            legResult = 'PUSH'; // Whole-number push
          } else {
            legResult = 'LOSS';
          }
          break;
        }

        case 'moneyline': {
          const isHome = leg.selection === leg.homeTeam;
          if (isHome) {
            if (sim.homeScore > sim.awayScore) legResult = 'WIN';
            else if (sim.homeScore === sim.awayScore) legResult = 'PUSH';
            else legResult = 'LOSS';
          } else {
            if (sim.awayScore > sim.homeScore) legResult = 'WIN';
            else if (sim.awayScore === sim.homeScore) legResult = 'PUSH';
            else legResult = 'LOSS';
          }
          break;
        }

        case 'total': {
          const totalLine = Number(leg.lineValue);
          if (leg.marketType === 'total_over') {
            if (sim.totalScore > totalLine) legResult = 'WIN';
            else if (sim.totalScore === totalLine) legResult = 'PUSH';
            else legResult = 'LOSS';
          } else {
            if (sim.totalScore < totalLine) legResult = 'WIN';
            else if (sim.totalScore === totalLine) legResult = 'PUSH';
            else legResult = 'LOSS';
          }
          break;
        }

        default:
          legResult = 'WIN';
      }

      if (legResult === 'LOSS') {
        ticketFailed = true;
        break;
      } else if (legResult === 'WIN') {
        nonPushWins++;
      } else if (legResult === 'PUSH') {
        runPushes++;
      }
    }

    // Ticket is a simulation win if no legs lost and at least 1 leg won
    if (!ticketFailed && (nonPushWins > 0 || legs.length === 0)) {
      winCount++;
      totalPushCount += runPushes;
    }
  }

  const winProbability = Number((winCount / iterations).toFixed(4));
  
  // Fair American odds conversion
  let fairAmericanOdds = 100;
  if (winProbability > 0) {
    const dec = 1 / winProbability;
    if (dec >= 2.0) {
      fairAmericanOdds = Math.round((dec - 1) * 100);
    } else {
      fairAmericanOdds = -Math.round(100 / (dec - 1));
    }
  }

  return {
    winCount,
    iterations,
    winProbability,
    fairAmericanOdds,
    pushCount: totalPushCount
  };
}

// ==========================================
// SURVIVOR MONTE CARLO SIMULATION
// ==========================================

function runMonteCarloSimulation(userPath, slateData, poolSize, iterations, targetHorizon, progressCb) {
  const userPicksByWeek = {};
  userPath.forEach(p => {
    userPicksByWeek[p.week] = p.teamCode;
  });

  const totalPoolSize = Math.max(2, Math.min(10000, Number(poolSize) || 100));
  const numOpponents = totalPoolSize - 1;

  let totalWinEquity = 0;
  let userSurvivedHorizon = 0;
  let userSurvived18 = 0;

  const poolEndWeeks = [];
  const reportInterval = Math.max(500, Math.floor(iterations / 20));

  for (let iter = 1; iter <= iterations; iter++) {
    if (progressCb && iter % reportInterval === 0) {
      progressCb(Math.round((iter / iterations) * 100));
    }

    let userAlive = true;
    let opponentsAlive = numOpponents;
    let poolFinishWeek = 18;
    let poolEndedEarly = false;

    for (let w = 1; w <= 18; w++) {
      const weekData = slateData.find(s => s.week === w);
      if (!weekData) continue;

      // 1. Simulate game outcomes for week w
      const gameOutcomes = {};
      weekData.games.forEach(g => {
        const homeWon = Math.random() < g.homeWinProb;
        gameOutcomes[g.homeTeam] = homeWon;
        gameOutcomes[g.awayTeam] = !homeWon;
      });

      // 2. Check user pick
      const myTeam = userPicksByWeek[w];
      const userSurvivesThisWeek = (myTeam && myTeam !== '—' && gameOutcomes[myTeam] === true);

      // 3. Simulate opponent pool picks & survival
      let survivingOpponents = 0;
      if (opponentsAlive > 0) {
        const pickDistribution = [];
        let cumPct = 0;
        weekData.games.forEach(g => {
          cumPct += g.homePickPct;
          pickDistribution.push({ team: g.homeTeam, cumPct, won: gameOutcomes[g.homeTeam] });
          cumPct += g.awayPickPct;
          pickDistribution.push({ team: g.awayTeam, cumPct, won: gameOutcomes[g.awayTeam] });
        });

        for (let opp = 0; opp < opponentsAlive; opp++) {
          const r = Math.random() * (cumPct || 1.0);
          const picked = pickDistribution.find(p => r <= p.cumPct) || pickDistribution[pickDistribution.length - 1];
          if (picked && picked.won) {
            survivingOpponents++;
          }
        }
      }

      // Check if user survived through the designated target horizon
      if (w === targetHorizon && userAlive && userSurvivesThisWeek) {
        userSurvivedHorizon++;
      }

      // 4. Resolve week outcomes & pool termination
      if (userAlive && !userSurvivesThisWeek) {
        userAlive = false;
        if (survivingOpponents === 0 && opponentsAlive > 0) {
          // Everyone died in this same week: split pot
          totalWinEquity += (1 / (1 + opponentsAlive));
          poolFinishWeek = w;
          poolEndedEarly = true;
          break;
        }
      } else if (userAlive && userSurvivesThisWeek) {
        if (survivingOpponents === 0) {
          // User solo win!
          totalWinEquity += 1.0;
          poolFinishWeek = w;
          poolEndedEarly = true;
          break;
        }
      }

      opponentsAlive = survivingOpponents;

      if (!userAlive && opponentsAlive === 0) {
        poolFinishWeek = w;
        poolEndedEarly = true;
        break;
      }
    }

    if (!poolEndedEarly) {
      poolFinishWeek = 18;
      if (userAlive) {
        userSurvived18++;
        totalWinEquity += (1 / (1 + opponentsAlive));
      }
    }

    poolEndWeeks.push(poolFinishWeek);
  }

  // Calculate stats
  poolEndWeeks.sort((a, b) => a - b);
  const medianPoolEnd = poolEndWeeks[Math.floor(poolEndWeeks.length / 2)];
  const avgPoolEnd = Number((poolEndWeeks.reduce((a, b) => a + b, 0) / iterations).toFixed(1));

  const winEquityPct = Number(((totalWinEquity / iterations) * 100).toFixed(2));
  const randomBaselinePct = Number(((1 / totalPoolSize) * 100).toFixed(2));
  const edgeMultiple = Number((winEquityPct / Math.max(0.001, randomBaselinePct)).toFixed(1));

  const horizonSurvivalPct = Number(((userSurvivedHorizon / iterations) * 100).toFixed(1));
  const fullSeasonSurvivalPct = Number(((userSurvived18 / iterations) * 100).toFixed(2));

  return {
    iterations,
    poolSize: totalPoolSize,
    winEquityPct,
    randomBaselinePct,
    edgeMultiple,
    expectedPoolEndWeek: avgPoolEnd,
    medianPoolEndWeek: medianPoolEnd,
    picksNeededToWin: Math.round(avgPoolEnd),
    horizonSurvivalPct,
    fullSeasonSurvivalPct,
    targetHorizon
  };
}
