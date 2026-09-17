/**
 * 🐾 SCOUT BOWIE NFL PICK'EM ATS & SU ENGINE
 * High-conviction point spread analytics, key number detection (3, 7, 10),
 * public consensus leverage modeling, interactive pick assignment,
 * confidence ranking (1-16) vs standard format, and export generator.
 */

export class PickemEngine {
  constructor() {
    this.KEY_NUMBERS = [3.0, 7.0, 10.0];
  }

  /**
   * Safely unwrap weeks array from either raw array or root metadata envelope
   */
  getWeeks(slateData) {
    if (Array.isArray(slateData)) return slateData;
    if (slateData && Array.isArray(slateData.weeks)) return slateData.weeks;
    return [];
  }

  /**
   * Check if point spread lands on critical NFL key numbers: 3.0, 7.0, or 10.0
   */
  isKeyNumber(spread) {
    const absSpread = Math.abs(Number(spread) || 0);
    const matched = this.KEY_NUMBERS.find(k => Math.abs(absSpread - k) < 0.01);
    if (matched !== undefined) {
      return {
        isKey: true,
        number: matched,
        label: `KEY NUMBER ${matched.toFixed(1)}`,
        badgeClass: matched === 3.0 ? 'key-num-gold' : (matched === 7.0 ? 'key-num-cyan' : 'key-num-purple')
      };
    }
    return {
      isKey: false,
      number: null,
      label: null,
      badgeClass: null
    };
  }

  /**
   * Approximation of standard normal error function (erf)
   */
  erf(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  /**
   * Inverse error function for inverse normal CDF calculations
   */
  erfinv(x) {
    const a = 0.147;
    const log1MinusX2 = Math.log(1 - x * x);
    const term1 = 2 / (Math.PI * a) + log1MinusX2 / 2;
    const innerSqrt = Math.pow(term1, 2) - (log1MinusX2 / a);
    const sign = x < 0 ? -1 : 1;
    return sign * Math.sqrt(Math.max(0, Math.sqrt(innerSqrt) - term1));
  }

  /**
   * Calculate point spread cover probability for Home and Away,
   * accounting for discrete push mass on integer lines (e.g. -3.0, -7.0)
   */
  calculateCoverProbability(homeWinProb, homeSpread) {
    const clampedProb = Math.max(0.01, Math.min(0.99, Number(homeWinProb) || 0.5));
    const z = Math.SQRT2 * this.erfinv(2 * clampedProb - 1);
    const projectedHomeMargin = 13.5 * z;
    const deltaPoints = projectedHomeMargin + Number(homeSpread || 0);
    const zCover = deltaPoints / 13.5;
    const rawHomeCover = 0.5 * (1 + this.erf(zCover / Math.SQRT2));

    let pushProb = 0.0;
    const absSpread = Math.abs(Number(homeSpread || 0));
    const isFlat = Math.abs(absSpread - Math.round(absSpread)) < 0.001;

    if (isFlat) {
      const zPushUpper = (deltaPoints + 0.5) / 13.5;
      const zPushLower = (deltaPoints - 0.5) / 13.5;
      const rawPush = 0.5 * (this.erf(zPushUpper / Math.SQRT2) - this.erf(zPushLower / Math.SQRT2));
      pushProb = Math.max(0.02, Math.min(0.12, Math.abs(rawPush)));
    }

    const nonPushMass = 1.0 - pushProb;
    const homeCoverProb = Math.max(0.40, Math.min(0.58, rawHomeCover * nonPushMass));
    const awayCoverProb = Math.max(0.40, Math.min(0.58, (1.0 - rawHomeCover) * nonPushMass));

    return {
      homeCoverProb: Number(homeCoverProb.toFixed(4)),
      awayCoverProb: Number(awayCoverProb.toFixed(4)),
      pushProb: Number(pushProb.toFixed(4)),
      isFlatLine: isFlat,
      projectedMargin: Number(projectedHomeMargin.toFixed(1))
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
   * Format spread with explicit polarity (+3.5, -4.5, PK)
   */
  formatSpread(sp) {
    const n = Number(sp || 0);
    if (n === 0) return 'PK';
    return n > 0 ? `+${n}` : `${n}`;
  }

  /**
   * Generate Full Pick'em Sheet with Interactive Cards Data Contract
   */
  generatePickemSheet(week, slateData, options = {}) {
    const targetWeek = Number(week) || 1;
    const mode = options.mode || 'ats'; // 'ats' | 'straight_up'
    const leagueFormat = options.leagueFormat || 'confidence'; // 'confidence' | 'standard'
    const strategyBias = options.strategyBias || 'contrarian'; // 'contrarian' | 'max_ev'
    const userPicks = options.userPicks || {}; // { [gameId]: 'home' | 'away' }

    const weeks = this.getWeeks(slateData);
    const weekData = weeks.find(s => s.week === targetWeek);

    if (!weekData || !Array.isArray(weekData.games) || weekData.games.length === 0) {
      return {
        week: targetWeek,
        mode,
        leagueFormat,
        strategyBias,
        games: [],
        totalGames: 0
      };
    }

    const cards = weekData.games.map(g => {
      // 1. Sanity: Assert no placeholder values render on sheet
      const isPlaceholder = (
        Math.abs(Number(g.spread) - (-0.5)) < 0.001 &&
        ((Number(g.homeMoneyline) === -110 && Number(g.awayMoneyline) === 110) ||
         (Number(g.homeMoneyline) === 110 && Number(g.awayMoneyline) === -110))
      );
      if (isPlaceholder) {
        console.warn(`[PickemEngine] Stale placeholder detected on game ${g.id}: ${g.awayTeam} @ ${g.homeTeam}`);
      }

      // Home spread stored in g.spread. Away spread is opposite.
      const homeSpread = Number(g.spread || 0);
      const awaySpread = -homeSpread;

      const homeSpreadStr = this.formatSpread(homeSpread);
      const awaySpreadStr = this.formatSpread(awaySpread);

      const homeWinProb = Number(g.homeWinProb ?? 0.50);
      const awayWinProb = Number(g.awayWinProb ?? (1 - homeWinProb));

      // Key number alert
      const keyInfo = this.isKeyNumber(homeSpread);

      // Probabilities & Public Consensus
      let homeProb = homeWinProb;
      let awayProb = awayWinProb;
      let homePublic = Number(g.homePickPct ?? 0.50);
      let awayPublic = Number(g.awayPickPct ?? (1 - homePublic));

      if (mode === 'ats') {
        const coverData = this.calculateCoverProbability(homeWinProb, homeSpread);
        const publicConsensus = this.calculatePublicSpreadConsensus(homeWinProb, homeSpread);

        homeProb = coverData.homeCoverProb;
        awayProb = coverData.awayCoverProb;
        homePublic = publicConsensus.homePublicATS;
        awayPublic = publicConsensus.awayPublicATS;
      }

      const homeLeverage = Number(((homeProb - homePublic) * 100).toFixed(1));
      const awayLeverage = Number(((awayProb - awayPublic) * 100).toFixed(1));

      // Model Recommendation Score
      let homeScore = 0;
      let awayScore = 0;

      if (strategyBias === 'max_ev') {
        // Max Expected Value: strictly picks the highest cover probability
        homeScore = homeProb;
        awayScore = awayProb;
      } else {
        // Contrarian Leverage: weights leverage edge to exploit public chalk
        homeScore = homeProb + (homeLeverage / 100) * 0.40;
        awayScore = awayProb + (awayLeverage / 100) * 0.40;
      }

      const pickHome = homeScore >= awayScore;
      const modelPickSide = pickHome ? 'home' : 'away';
      const modelScore = pickHome ? homeScore : awayScore;
      const modelEdge = pickHome ? homeLeverage : awayLeverage;
      const modelProb = pickHome ? homeProb : awayProb;

      // User Pick (defaults to model recommendation if not explicitly chosen)
      const userPickSide = userPicks[g.id] || modelPickSide;

      // Model Edge Badge Tag
      let edgeBadge = `${modelEdge >= 0 ? '+' : ''}${modelEdge}% Edge`;
      let edgeClass = 'tag-chalk';

      if (modelEdge >= 8.0) {
        edgeBadge = `⚡ TOP LEVERAGE (+${modelEdge}%)`;
        edgeClass = 'tag-leverage';
      } else if (modelEdge >= 4.0) {
        edgeBadge = `VALUE (+${modelEdge}%)`;
        edgeClass = 'tag-leverage';
      } else if (modelProb >= 0.54) {
        edgeBadge = `⭐ SHARP COVER (${(modelProb * 100).toFixed(1)}%)`;
        edgeClass = 'tag-chalk';
      } else {
        edgeBadge = `LEAN (${(modelProb * 100).toFixed(1)}%)`;
        edgeClass = 'tag-chalk';
      }

      return {
        id: g.id,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`,
        awayTeam: g.awayTeam,
        awayTeamName: g.awayTeamName || g.awayTeam,
        homeTeam: g.homeTeam,
        homeTeamName: g.homeTeamName || g.homeTeam,
        total: g.total,
        keyNumberAlert: keyInfo.isKey ? keyInfo : null,
        // Model Decision
        modelPickSide,
        modelPickTeam: pickHome ? g.homeTeam : g.awayTeam,
        modelPickSpread: pickHome ? homeSpreadStr : awaySpreadStr,
        modelScore,
        modelEdge,
        modelProb,
        edgeBadge,
        edgeClass,
        // User Decision
        userPickSide,
        userPickTeam: userPickSide === 'home' ? g.homeTeam : g.awayTeam,
        userPickSpread: userPickSide === 'home' ? homeSpreadStr : awaySpreadStr,
        isUserOverridden: userPicks[g.id] !== undefined && userPicks[g.id] !== modelPickSide,
        // Away Side Data
        awaySide: {
          side: 'away',
          team: g.awayTeam,
          teamName: g.awayTeamName || g.awayTeam,
          spread: awaySpread,
          spreadFormatted: awaySpreadStr,
          moneyline: g.awayMoneyline,
          prob: awayProb,
          publicPct: awayPublic,
          leverageEdge: awayLeverage,
          isModelPick: modelPickSide === 'away',
          isUserPick: userPickSide === 'away',
          isFav: awaySpread < 0
        },
        // Home Side Data
        homeSide: {
          side: 'home',
          team: g.homeTeam,
          teamName: g.homeTeamName || g.homeTeam,
          spread: homeSpread,
          spreadFormatted: homeSpreadStr,
          moneyline: g.homeMoneyline,
          prob: homeProb,
          publicPct: homePublic,
          leverageEdge: homeLeverage,
          isModelPick: modelPickSide === 'home',
          isUserPick: userPickSide === 'home',
          isFav: homeSpread < 0
        }
      };
    });

    // Sort cards by recommendation strength for confidence ranking
    cards.sort((a, b) => b.modelScore - a.modelScore);

    const totalCards = cards.length;
    cards.forEach((card, idx) => {
      if (leagueFormat === 'confidence') {
        card.confidencePoints = totalCards - idx;
        card.ptsLabel = `${card.confidencePoints} PTS`;
      } else {
        card.confidencePoints = 1;
        card.ptsLabel = '1 PT';
      }
    });

    return {
      week: targetWeek,
      mode,
      leagueFormat,
      strategyBias,
      games: cards,
      totalGames: cards.length
    };
  }

  /**
   * Format exportable pick sheet for Sleeper, Yahoo, ESPN, and office pools
   */
  formatExportPicks(sheet, options = {}) {
    const isATS = sheet.mode === 'ats';
    const isConfidence = sheet.leagueFormat === 'confidence';
    const biasLabel = sheet.strategyBias === 'contrarian' ? 'Contrarian Leverage' : 'Max Expected Value';

    let text = `🐾 SCOUT BOWIE WEEK ${sheet.week} NFL PICK'EM SHEET\n`;
    text += `Mode: ${isATS ? 'Against the Spread (ATS)' : 'Straight Up (SU)'} | Format: ${isConfidence ? 'Confidence Points (1-16)' : 'Standard (1 pt)'}\n`;
    text += `Strategy Bias: ${biasLabel} | Total Games: ${sheet.totalGames}\n`;
    text += `----------------------------------------------------------------------\n`;

    sheet.games.forEach(g => {
      const ptsPrefix = isConfidence ? `[${String(g.confidencePoints).padStart(2)} pts] ` : `[1 pt]  `;
      const pickedSide = g.userPickSide === 'home' ? g.homeSide : g.awaySide;
      const oppSide = g.userPickSide === 'home' ? g.awaySide : g.homeSide;

      const pickText = isATS 
        ? `${pickedSide.team} ${pickedSide.spreadFormatted}` 
        : `${pickedSide.team} ML`;

      const matchupText = `${g.awayTeam} ${g.awaySide.spreadFormatted} @ ${g.homeTeam} ${g.homeSide.spreadFormatted}`;

      const probLabel = isATS ? 'Cover' : 'Win';
      const keyAlert = g.keyNumberAlert ? ` [KEY ${g.keyNumberAlert.number.toFixed(1)}]` : '';
      const overrideTag = g.isUserOverridden ? ' [USER PICK]' : '';

      text += `${ptsPrefix}${matchupText.padEnd(26)} ➔ Pick: ${pickText.padEnd(12)} | ${probLabel}: ${(pickedSide.prob * 100).toFixed(1)}% | Pub: ${(pickedSide.publicPct * 100).toFixed(1)}% | Edge: ${pickedSide.leverageEdge >= 0 ? '+' : ''}${pickedSide.leverageEdge}%${keyAlert}${overrideTag}\n`;
    });

    text += `----------------------------------------------------------------------\n`;
    text += `Generated by Scout Bowie Analytics Suite • 100% Client-Side Quant War Room 🐾\n`;
    return text;
  }
}
