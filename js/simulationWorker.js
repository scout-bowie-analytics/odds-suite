/**
 * 🐾 SCOUT BOWIE NFL MONTE CARLO SIMULATION WORKER (v3.8.0)
 * High-performance Web Worker executing:
 * 1. Asynchronous Auto-Ticket Generation & Candidate EV Optimization
 * 2. 10,000-Iteration Same-Game Parlay (SGP) & Multi-Game Parlay Simulations with Multi-Outcome Push Settlement
 * 3. 10,000-Iteration Survivor Pool Simulations
 */

import { ParlayEngine } from './parlayEngine.js';
import { OddsUtils, evaluateLegOutcome, resolveParlayTicketIteration } from './contracts.js';

self.onmessage = function(e) {
  const data = e.data || {};

  // Action 1: Asynchronous Auto-Ticket Generation (Offloaded from Main UI Thread)
  if (data.action === 'GENERATE_AUTO_TICKET') {
    const { slateData = [], week = 1, options = {} } = data;
    try {
      const parlayEngine = new ParlayEngine();
      const generatedLegs = parlayEngine.generateAutoTicket(slateData, week, options);
      parlayEngine.legs = generatedLegs;
      const simResults = parlayEngine.runSyncSimulation(slateData, 10000);
      self.postMessage({
        type: 'auto_ticket_complete',
        generatedLegs,
        simResults
      });
    } catch (err) {
      self.postMessage({ type: 'auto_ticket_error', error: err.message });
    }
    return;
  }

  // Action 2: 10,000-Iteration Parlay & SGP Simulation with Multi-Outcome Push Settlement
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

  // Action 3: Survivor 10,000-Pool Simulation
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
      fullWinProbability: 0,
      pushProbability: 0,
      winCount: 0,
      iterations,
      fairAmericanOdds: 100,
      pushCount: 0,
      exactSimulatedEvPct: 0,
      legPushStats: []
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
  let fullWinCount = 0;
  let reducedWinCount = 0;
  let allPushCount = 0;
  let lossCount = 0;
  let totalReturn = 0;
  const legPushCounts = new Array(legs.length).fill(0);
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

    // Track individual leg pushes
    legs.forEach((leg, idx) => {
      const outcome = evaluateLegOutcome(leg, simScores[leg.gameId]);
      if (outcome === 'PUSH') legPushCounts[idx]++;
    });

    // Step B: Resolve Ticket Outcome with American push rules
    const res = resolveParlayTicketIteration(legs, simScores);
    totalReturn += res.returnMultiplier;

    if (res.outcome === 'FULL_WIN') {
      fullWinCount++;
    } else if (res.outcome === 'REDUCED_WIN') {
      reducedWinCount++;
    } else if (res.outcome === 'ALL_PUSH') {
      allPushCount++;
    } else {
      lossCount++;
    }
  }

  const totalWinCount = fullWinCount + reducedWinCount;
  const winProbability = Number((totalWinCount / iterations).toFixed(4));
  const fullWinProbability = Number((fullWinCount / iterations).toFixed(4));
  const pushProbability = Number(((reducedWinCount + allPushCount) / iterations).toFixed(4));
  const allPushProbability = Number((allPushCount / iterations).toFixed(4));
  const meanSimulatedReturn = Number((totalReturn / iterations).toFixed(4));
  const exactSimulatedEvPct = Number(((meanSimulatedReturn - 1) * 100).toFixed(2));
  const fairAmericanOdds = OddsUtils.probToAmerican(winProbability);

  const legPushStats = legs.map((leg, idx) => ({
    legId: leg.id,
    label: leg.label,
    pushCount: legPushCounts[idx],
    pushPct: Number(((legPushCounts[idx] / iterations) * 100).toFixed(1)),
    isFlatLine: OddsUtils.isFlatLine(leg.lineValue)
  }));

  return {
    winCount: totalWinCount,
    fullWinCount,
    reducedWinCount,
    allPushCount,
    lossCount,
    iterations,
    winProbability,
    fullWinProbability,
    pushProbability,
    allPushProbability,
    meanSimulatedReturn,
    exactSimulatedEvPct,
    fairAmericanOdds,
    legPushStats
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
          totalWinEquity += (1 / (1 + opponentsAlive));
          poolFinishWeek = w;
          poolEndedEarly = true;
          break;
        }
      } else if (userAlive && userSurvivesThisWeek) {
        if (survivingOpponents === 0) {
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
