/**
 * 🐾 SCOUT BOWIE NFL SURVIVOR & PICK'EM ANALYTICAL ENGINE
 * 100% Client-Side Pure JS Math & Dynamic Lookahead Solver
 */

import { OddsUtils, normalizeGame } from './contracts.js';
import { PickemEngine } from './pickemEngine.js';

export class SurvivorEngine {
  constructor(options = {}) {
    this.defaultPoolSize = options.poolSize || 100;
    this.pickemEngine = new PickemEngine();
  }

  /**
   * Calculate Expected Pool Finish Week based on pool size
   * Small pools end early (W7-9), mid pools end W10-13, mega pools end W16-18
   */
  estimatePoolFinishWeek(poolSize = 100) {
    const n = Math.max(2, Number(poolSize) || 100);
    // Average weekly survivor retention rate is ~70-74% across national chalk
    const avgRetention = 0.72;
    // N * (avgRetention)^W <= 1 => W = ln(N) / -ln(avgRetention)
    const rawWeeks = Math.log(n) / -Math.log(avgRetention);
    const finishWeek = Math.min(18, Math.max(5, Math.round(rawWeeks) + 1));
    return finishWeek;
  }

  /**
   * Helper to safely extract weeks array from either direct array or metadata envelope
   */
  getWeeks(slateData) {
    if (Array.isArray(slateData)) return slateData;
    if (slateData && Array.isArray(slateData.weeks)) return slateData.weeks;
    return [];
  }

  /**
   * Expected Value (EV) calculation against pool size
   * Formula: EV = (pWin / max(0.01, pickShare)) * (1 - (1 - pWin)^poolSize)
   */
  calculateEV(pWin, pickShare, poolSize = 100) {
    const safeWin = Math.max(0.01, Math.min(0.99, Number(pWin) || 0.5));
    const safeShare = Math.max(0.005, Math.min(0.99, Number(pickShare) || 0.05));
    const n = Math.max(2, Number(poolSize) || 100);

    const poolLeverage = 1 - Math.pow(1 - safeWin, n);
    const ev = (safeWin / safeShare) * poolLeverage;
    return Number(ev.toFixed(3));
  }

  calculateSingleGameEV(pWin, pickShare, poolSize = 100) {
    return this.calculateEV(pWin, pickShare, poolSize);
  }

  /**
   * Future Value (FV) heuristic:
   * Sum of team's future win probabilities in games where P(Win) >= 65%
   * Only looks ahead up to the target horizon week (no wasted rationing)!
   */
  calculateFutureValue(teamCode, fromWeek, slateData, targetHorizon = 18) {
    let fv = 0;
    const maxWeek = Math.min(18, Number(targetHorizon) || 18);
    const weeks = this.getWeeks(slateData);

    for (let w = fromWeek + 1; w <= maxWeek; w++) {
      const weekData = weeks.find(s => s.week === w);
      if (!weekData || (weekData.byes && weekData.byes.includes(teamCode))) continue;

      const game = weekData.games.find(g => g.homeTeam === teamCode || g.awayTeam === teamCode);
      if (!game) continue;

      const isHome = game.homeTeam === teamCode;
      const winProb = isHome ? game.homeWinProb : game.awayWinProb;

      if (winProb >= 0.65) {
        fv += winProb;
      }
    }
    return Number(fv.toFixed(2));
  }

  /**
   * Helper to get a team's game details for a given week
   */
  getTeamGame(teamCode, week, slateData) {
    const weeks = this.getWeeks(slateData);
    const weekData = weeks.find(s => s.week === week);
    if (!weekData) return null;
    if (weekData.byes && weekData.byes.includes(teamCode)) {
      return { isBye: true, week, teamCode };
    }

    const game = weekData.games.find(g => g.homeTeam === teamCode || g.awayTeam === teamCode);
    if (!game) return null;

    const isHome = game.homeTeam === teamCode;
    const oppCode = isHome ? game.awayTeam : game.homeTeam;
    const oppName = isHome ? game.awayTeamName : game.homeTeamName;
    const winProb = isHome ? game.homeWinProb : game.awayWinProb;
    const pickPct = isHome ? game.homePickPct : game.awayPickPct;
    const spread = isHome ? game.spread : -game.spread;

    return {
      id: game.id,
      week,
      teamCode,
      teamName: isHome ? game.homeTeamName : game.awayTeamName,
      oppCode,
      oppName,
      isHome,
      spread,
      total: game.total,
      winProb,
      pickPct,
      isBye: false
    };
  }

  /**
   * 18-Week Optimal Path Finder (Horizon-Constrained & Dynamic Lookahead)
   */
  findOptimal18WeekPath(slateData, options = {}) {
    const poolSize = Math.max(10, Number(options.poolSize) || 100);
    const strategy = options.strategy || 'contrarian'; // 'survival' | 'contrarian'
    const pathTarget = options.pathTarget || 'horizon'; // 'horizon' | 'full_season'
    const targetHorizon = pathTarget === 'horizon' ? this.estimatePoolFinishWeek(poolSize) : 18;
    const lockedPicks = options.lockedPicks || {};
    const excludedTeams = new Set(options.excludedTeams || []);

    const usedTeams = new Set();
    const path = [];

    Object.entries(lockedPicks).forEach(([w, team]) => {
      if (team) usedTeams.add(team);
    });

    let cumulativeSurvival = 1.0;
    let horizonSurvival = 1.0;

    const weeks = this.getWeeks(slateData);
    for (let w = 1; w <= 18; w++) {
      const weekData = weeks.find(s => s.week === w);
      if (!weekData) continue;

      // 1. Check if user manually locked a pick for this week
      if (lockedPicks[w]) {
        const lockedTeam = lockedPicks[w];
        const game = this.getTeamGame(lockedTeam, w, slateData);
        if (game && !game.isBye) {
          const ev = this.calculateEV(game.winProb, game.pickPct, poolSize);
          const fv = this.calculateFutureValue(lockedTeam, w, slateData, targetHorizon);
          cumulativeSurvival *= game.winProb;
          if (w <= targetHorizon) horizonSurvival *= game.winProb;

          path.push({
            ...game,
            ev,
            futureValue: fv,
            isLocked: true,
            cumulativeProb: Number((cumulativeSurvival * 100).toFixed(2)),
            isBeyondHorizon: w > targetHorizon
          });
          continue;
        }
      }

      // 2. Evaluate all available candidate teams for this week
      const candidates = [];
      weekData.games.forEach(g => {
        // Home Team
        if (!usedTeams.has(g.homeTeam) && !excludedTeams.has(g.homeTeam)) {
          const ev = this.calculateEV(g.homeWinProb, g.homePickPct, poolSize);
          const fv = this.calculateFutureValue(g.homeTeam, w, slateData, targetHorizon);
          candidates.push({
            teamCode: g.homeTeam,
            teamName: g.homeTeamName,
            oppCode: g.awayTeam,
            oppName: g.awayTeamName,
            isHome: true,
            spread: g.spread,
            total: g.total,
            winProb: g.homeWinProb,
            pickPct: g.homePickPct,
            ev,
            futureValue: fv
          });
        }

        // Away Team
        if (!usedTeams.has(g.awayTeam) && !excludedTeams.has(g.awayTeam)) {
          const ev = this.calculateEV(g.awayWinProb, g.awayPickPct, poolSize);
          const fv = this.calculateFutureValue(g.awayTeam, w, slateData, targetHorizon);
          candidates.push({
            teamCode: g.awayTeam,
            teamName: g.awayTeamName,
            oppCode: g.homeTeam,
            oppName: g.homeTeamName,
            isHome: false,
            spread: -g.spread,
            total: g.total,
            winProb: g.awayWinProb,
            pickPct: g.awayPickPct,
            ev,
            futureValue: fv
          });
        }
      });

      if (candidates.length === 0) {
        path.push({
          week: w,
          teamCode: '—',
          teamName: 'No Valid Pick',
          oppCode: '—',
          winProb: 0,
          pickPct: 0,
          ev: 0,
          futureValue: 0,
          isLocked: false,
          cumulativeProb: Number((cumulativeSurvival * 100).toFixed(2)),
          isBeyondHorizon: w > targetHorizon
        });
        continue;
      }

      // Filter to legitimate favorites first (>= 55% winProb)
      let eligible = candidates.filter(c => c.winProb >= 0.55);
      if (eligible.length === 0) eligible = candidates.filter(c => c.winProb >= 0.50);
      if (eligible.length === 0) eligible = candidates;

      // Score candidates based on strategy & future lookahead up to horizon
      eligible.forEach(cand => {
        const logProb = Math.log(cand.winProb);
        const logEv = Math.log(Math.max(0.1, cand.ev));

        // Future Value penalty drops to 0 once we pass the target horizon!
        const isPastHorizon = w >= targetHorizon;
        const fvPenalty = isPastHorizon ? 0 : (w <= 6 ? 0.06 : 0.03);

        if (strategy === 'survival') {
          cand.score = logProb + (0.10 * logEv) - (fvPenalty * cand.futureValue);
        } else {
          const evWeight = poolSize >= 500 ? 0.45 : (poolSize >= 100 ? 0.35 : 0.22);
          cand.score = logProb + (evWeight * logEv) - (fvPenalty * cand.futureValue);
        }
      });

      eligible.sort((a, b) => b.score - a.score);
      const chosen = eligible[0];

      usedTeams.add(chosen.teamCode);
      cumulativeSurvival *= chosen.winProb;
      if (w <= targetHorizon) horizonSurvival *= chosen.winProb;

      path.push({
        week: w,
        ...chosen,
        isLocked: false,
        cumulativeProb: Number((cumulativeSurvival * 100).toFixed(2)),
        isBeyondHorizon: w > targetHorizon
      });
    }

    return {
      path,
      targetHorizon,
      pathTarget,
      horizonSurvivalProb: Number((horizonSurvival * 100).toFixed(2)),
      cumulativeSurvivalProb: Number((cumulativeSurvival * 100).toFixed(2)),
      strategy,
      poolSize
    };
  }

  /**
   * Weekly Recommendation Spotlight Card Generator
   */
  categorizeWeeklyPicks(week, slateData, options = {}) {
    const targetWeek = Number(week) || 1;
    const poolSize = Math.max(10, Number(options.poolSize) || 100);
    const targetHorizon = options.targetHorizon || 18;
    const weeks = this.getWeeks(slateData);
    const weekData = weeks.find(s => s.week === targetWeek);
    if (!weekData) return { leverage: null, chalk: null, trap: null, all: [] };

    const picks = [];
    weekData.games.forEach(g => {
      // Home Team
      const homeEv = this.calculateEV(g.homeWinProb, g.homePickPct, poolSize);
      const homeFv = this.calculateFutureValue(g.homeTeam, targetWeek, slateData, targetHorizon);
      picks.push({
        id: `${g.id}_home`,
        teamCode: g.homeTeam,
        teamName: g.homeTeamName,
        oppCode: g.awayTeam,
        oppName: g.awayTeamName,
        isHome: true,
        spread: g.spread,
        total: g.total,
        winProb: g.homeWinProb,
        pickPct: g.homePickPct,
        ev: homeEv,
        futureValue: homeFv
      });

      // Away Team
      const awayEv = this.calculateEV(g.awayWinProb, g.awayPickPct, poolSize);
      const awayFv = this.calculateFutureValue(g.awayTeam, targetWeek, slateData, targetHorizon);
      picks.push({
        id: `${g.id}_away`,
        teamCode: g.awayTeam,
        teamName: g.awayTeamName,
        oppCode: g.homeTeam,
        oppName: g.homeTeamName,
        isHome: false,
        spread: -g.spread,
        total: g.total,
        winProb: g.awayWinProb,
        pickPct: g.awayPickPct,
        ev: awayEv,
        futureValue: awayFv
      });
    });

    const chalkPicks = [...picks].sort((a, b) => b.winProb - a.winProb);
    const chalk = chalkPicks[0] || null;

    const leverageCandidates = picks.filter(p => p.winProb >= 0.58 && p.pickPct <= 0.22 && p.teamCode !== (chalk ? chalk.teamCode : ''));
    leverageCandidates.sort((a, b) => b.ev - a.ev);
    const leverage = leverageCandidates[0] || [...picks].sort((a, b) => b.ev - a.ev)[0];

    const trapCandidates = picks.filter(p => p.pickPct >= 0.05 && p.winProb <= 0.72 && p.teamCode !== (chalk ? chalk.teamCode : ''));
    trapCandidates.sort((a, b) => (b.pickPct / Math.max(0.40, b.winProb)) - (a.pickPct / Math.max(0.40, a.winProb)));
    let trap = trapCandidates[0] || null;

    if (!trap) {
      const altCandidates = picks.filter(p => p.pickPct >= 0.04 && p.teamCode !== (chalk ? chalk.teamCode : ''));
      altCandidates.sort((a, b) => a.winProb - b.winProb);
      trap = altCandidates[0] || null;
    }

    picks.sort((a, b) => b.ev - a.ev);

    return {
      leverage,
      chalk,
      trap,
      all: picks,
      byes: weekData.byes || []
    };
  }

  /**
   * Approximate error function (erf)
   */
  erf(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return sign * y;
  }

  /**
   * Approximate inverse error function (erfinv)
   */
  erfinv(x) {
    const a = 0.147;
    const clampedX = Math.max(-0.9999, Math.min(0.9999, x));
    const logTerm = Math.log(1 - clampedX * clampedX);
    const term1 = 2 / (Math.PI * a) + logTerm / 2;
    const innerSqrt = term1 * term1 - logTerm / a;
    const sign = clampedX < 0 ? -1 : 1;
    return sign * Math.sqrt(Math.max(0, Math.sqrt(innerSqrt) - term1));
  }

  /**
   * Calculate point spread cover probability for Home and Away, including discrete push probability on flat lines
   */
  calculateCoverProbability(homeWinProb, homeSpread) {
    const clampedProb = Math.max(0.01, Math.min(0.99, homeWinProb));
    const z = Math.SQRT2 * this.erfinv(2 * clampedProb - 1);
    const projectedHomeMargin = 13.5 * z;
    const deltaPoints = projectedHomeMargin + homeSpread;
    const zCover = deltaPoints / 13.5;
    const rawHomeCover = 0.5 * (1 + this.erf(zCover / Math.SQRT2));

    let pushProb = 0.0;
    // Flat lines (e.g. -3.0, -7.0, 0.0) account for discrete push mass around margin === -homeSpread
    if (OddsUtils.isFlatLine(homeSpread)) {
      const zPushUpper = (deltaPoints + 0.5) / 13.5;
      const zPushLower = (deltaPoints - 0.5) / 13.5;
      const rawPush = 0.5 * (this.erf(zPushUpper / Math.SQRT2) - this.erf(zPushLower / Math.SQRT2));
      // Calibrate realistic key number push rates (3, 7, 6, 10, etc.)
      pushProb = Math.max(0.02, Math.min(0.12, Math.abs(rawPush)));
    }

    const nonPushMass = 1.0 - pushProb;
    const homeCoverProb = Math.max(0.40, Math.min(0.58, rawHomeCover * nonPushMass));
    const awayCoverProb = Math.max(0.40, Math.min(0.58, (1.0 - rawHomeCover) * nonPushMass));

    return {
      homeCoverProb: Number(homeCoverProb.toFixed(4)),
      awayCoverProb: Number(awayCoverProb.toFixed(4)),
      pushProb: Number(pushProb.toFixed(4)),
      isFlatLine: pushProb > 0,
      projectedMargin: Number(projectedHomeMargin.toFixed(1)),
      deltaPoints: Number(deltaPoints.toFixed(1))
    };
  }

  /**
   * Estimate public spread consensus ticket distribution
   */
  calculatePublicSpreadConsensus(homeWinProb, homeSpread) {
    const isHomeFav = homeWinProb >= 0.50;
    const favWinProb = isHomeFav ? homeWinProb : (1 - homeWinProb);
    const favShare = 0.50 + 0.32 * ((favWinProb - 0.50) / 0.40);
    const clampedFavShare = Math.max(0.51, Math.min(0.74, favShare));
    const dogShare = 1.0 - clampedFavShare;

    return {
      homePublicATS: Number((isHomeFav ? clampedFavShare : dogShare).toFixed(4)),
      awayPublicATS: Number((isHomeFav ? dogShare : clampedFavShare).toFixed(4))
    };
  }

  /**
   * Pick'em Confidence Mode (SU & ATS) - Delegated to PickemEngine
   */
  generatePickemConfidence(week, slateData, mode = 'straight_up') {
    const sheet = this.pickemEngine.generatePickemSheet(week, slateData, { mode });
    return sheet.games;
  }

  /**
   * Format 18-week path for 1-click clipboard export
   */
  formatClipboardSurvivorPath(result, options = {}) {
    if (!result || !result.path) return '';
    const poolSize = options.poolSize || result.poolSize || 100;
    const stratName = (result.strategy === 'survival' ? 'Max Survival' : 'Contrarian Leverage');
    const horizon = result.targetHorizon || 18;

    let text = `🐾 SCOUT BOWIE SURVIVOR OPTIMAL PATH\n`;
    text += `Strategy: ${stratName} | Pool Size: ${poolSize} Entries\n`;
    text += `🎯 Expected Pool Finish: Week ${horizon} (Odds to Finish: ${result.horizonSurvivalProb}%)\n`;
    text += `------------------------------------------------------------\n`;

    result.path.forEach(p => {
      const loc = p.isHome ? 'vs' : '@';
      const spreadStr = p.spread < 0 ? `${p.spread}` : `+${p.spread}`;
      const lockMark = p.isLocked ? ' 🔒[LOCKED]' : '';
      const finishMark = p.week === horizon ? ' 🏁[EXPECTED POOL FINISH]' : '';
      text += `Week ${String(p.week).padEnd(2)}: ${p.teamCode.padEnd(4)} (${loc} ${p.oppCode}) [${spreadStr}, Win: ${(p.winProb*100).toFixed(0)}%, EV: ${p.ev}]${lockMark}${finishMark}\n`;
    });

    text += `------------------------------------------------------------\n`;
    text += `Generated via Scout Bowie Odds Suite • https://scout-bowie-analytics.github.io/sleeper-analytics-suite/odds-suite/`;
    return text;
  }

  formatClipboardPickem(confidenceList, week, mode = 'straight_up') {
    if (!confidenceList || confidenceList.length === 0) return '';
    const isATS = mode === 'ats' || (confidenceList[0] && confidenceList[0].mode === 'ats');
    let text = `🐾 SCOUT BOWIE WEEK ${week} NFL PICK'EM CONFIDENCE SHEET (${isATS ? 'AGAINST THE SPREAD - ATS' : 'STRAIGHT UP - SU'})\n`;
    text += `------------------------------------------------------------\n`;

    confidenceList.forEach(c => {
      const loc = c.isHome ? 'vs' : '@';
      const spreadStr = c.spread < 0 ? `${c.spread}` : `+${c.spread}`;
      const edgeStr = c.isLeveragePlay ? ` ⚡[${c.stratTag || 'LEVERAGE'}]` : '';
      if (isATS) {
        text += `[${String(c.confidence).padStart(2)} pts] ${c.pickedTeam.padEnd(4)} (${spreadStr.padEnd(5)}) ${loc} ${c.oppTeam.padEnd(4)} | Cover: ${(c.coverProb*100).toFixed(1)}% | Pub ATS: ${(c.publicPickPct*100).toFixed(1)}% | Edge: ${c.leverageEdge >= 0 ? '+' : ''}${c.leverageEdge}%${edgeStr}\n`;
      } else {
        text += `[${String(c.confidence).padStart(2)} pts] ${c.pickedTeam.padEnd(4)} (${loc} ${c.oppTeam}) | Spread: ${spreadStr} | Win: ${(c.winProb*100).toFixed(0)}% | Pub: ${(c.publicPickPct*100).toFixed(1)}% | Edge: ${c.leverageEdge >= 0 ? '+' : ''}${c.leverageEdge}%${edgeStr}\n`;
      }
    });

    text += `------------------------------------------------------------\n`;
    text += `Generated via Scout Bowie Odds Suite • https://scout-bowie-analytics.github.io/sleeper-analytics-suite/odds-suite/`;
    return text;
  }
}
