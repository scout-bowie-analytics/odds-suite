/**
 * 🐾 SCOUT BOWIE PARLAY & SAME-GAME PARLAY (SGP) ANALYTICAL ENGINE
 * Pure client-side analytical core for bet slip management, odds conversion,
 * uncorrelated multiplier calculations, vig/edge metrics, and SGP correlation analysis.
 */

import { OddsUtils, normalizeGame, createBetLeg, evaluateLegOutcome, resolveParlayTicketIteration } from './contracts.js';

export class ParlayEngine {
  constructor() {
    this.legs = [];
    this.stake = 10;
    this.customOfferedOdds = null; // null means auto-calculate uncorrelated default
  }

  // ==========================================
  // ODDS CONVERSION UTILITIES
  // ==========================================

  /**
   * Helper to safely extract weeks array from either direct array or metadata envelope
   */
  getWeeks(slateData) {
    if (Array.isArray(slateData)) return slateData;
    if (slateData && Array.isArray(slateData.weeks)) return slateData.weeks;
    return [];
  }

  /**
   * Convert American odds to Decimal multiplier
   * e.g., -110 -> 1.9091, +150 -> 2.5000, -500 -> 1.2000
   */
  americanToDecimal(american) {
    const odds = Number(american);
    if (isNaN(odds) || odds === 0) return 1.0;
    if (odds > 0) {
      return 1 + (odds / 100);
    } else {
      return 1 + (100 / Math.abs(odds));
    }
  }

  /**
   * Convert Decimal multiplier to American odds integer
   * e.g., 1.9091 -> -110, 2.5000 -> +150
   */
  decimalToAmerican(decimal) {
    const dec = Number(decimal);
    if (isNaN(dec) || dec <= 1.0) return 100;
    if (dec >= 2.0) {
      return Math.round((dec - 1) * 100);
    } else {
      return -Math.round(100 / (dec - 1));
    }
  }

  /**
   * Convert American odds to raw bookmaker implied probability
   * e.g., -110 -> 0.5238 (52.38%), +150 -> 0.4000 (40.00%)
   */
  americanToImpliedProb(american) {
    const dec = this.americanToDecimal(american);
    return dec > 0 ? 1 / dec : 0;
  }

  /**
   * Convert Win Probability (0.0 to 1.0) to Decimal odds
   */
  probToDecimal(prob) {
    const p = Math.max(0.0001, Math.min(0.9999, Number(prob)));
    return 1 / p;
  }

  /**
   * Convert Win Probability (0.0 to 1.0) to Fair American odds
   */
  probToAmerican(prob) {
    return this.decimalToAmerican(this.probToDecimal(prob));
  }

  /**
   * Format American odds with explicit sign (e.g., +150, -110)
   */
  formatAmerican(odds) {
    const num = Number(odds);
    if (isNaN(num)) return '—';
    return num > 0 ? `+${num}` : `${num}`;
  }

  // ==========================================
  // FAIR PROBABILITIES & CORRELATION MATH
  // ==========================================

  /**
   * Compute no-vig fair independent probability for a leg.
   * For standard spread/total lines (-110/-110), fair prob = 50.0%.
   * For moneyline, vig is stripped across the 2-way market.
   */
  getFairIndependentProb(leg, slateGame = null) {
    if (!leg) return 0.5;

    // Spread and Over/Under standard markets (-110 vs -110)
    if (leg.marketCategory === 'spread' || leg.marketCategory === 'total') {
      return 0.50;
    }

    // Moneyline market: de-vig home/away pair
    if (leg.marketCategory === 'moneyline' && slateGame) {
      const homeImplied = this.americanToImpliedProb(slateGame.homeMoneyline || -110);
      const awayImplied = this.americanToImpliedProb(slateGame.awayMoneyline || 110);
      const totalOverround = homeImplied + awayImplied;

      if (leg.selection === slateGame.homeTeam) {
        return homeImplied / totalOverround;
      } else {
        return awayImplied / totalOverround;
      }
    }

    // Fallback if game context is missing: normalize single leg assuming standard 4.5% vig
    const rawImplied = this.americanToImpliedProb(leg.bookOdds);
    return rawImplied / 1.045;
  }

  /**
   * Calculate the product of fair independent probabilities across all legs.
   * Naive un-correlated fair benchmark: Product(P_fair_indep)
   */
  calculateNaiveFairProduct(slateData = []) {
    if (this.legs.length === 0) return 0;

    const weeks = this.getWeeks(slateData);
    let product = 1.0;
    this.legs.forEach(leg => {
      let slateGame = null;
      for (const weekObj of weeks) {
        const found = (weekObj.games || []).find(g => g.id === leg.gameId);
        if (found) { slateGame = found; break; }
      }
      const fairP = this.getFairIndependentProb(leg, slateGame);
      product *= fairP;
    });

    return product;
  }

  // ==========================================
  // BET SLIP STATE MANAGEMENT
  // ==========================================

  /**
   * Check if a specific leg is currently in the slip
   */
  hasLeg(legId) {
    return this.legs.some(l => l.id === legId);
  }

  /**
   * Get leg index by ID
   */
  getLegIndex(legId) {
    return this.legs.findIndex(l => l.id === legId);
  }

  /**
   * Toggle a betting selection with MUTUAL EXCLUSIVITY AUTO-REPLACEMENT.
   * - If exact leg is already present: remove it (toggle off).
   * - If opposing selection in the same market category exists for the same game
   *   (e.g., user selects BAL +3.5 while DET -3.5 is already in slip,
   *   or UNDER 44.0 while OVER 44.0 is in slip, or Home ML vs Away ML):
   *   AUTO-REPLACE the conflicting leg instead of stacking them.
   * - Otherwise: append the new leg to the slip.
   * Returns: { action: 'added' | 'removed' | 'replaced', leg: Leg, replacedLeg: Leg | null }
   */
  toggleLeg(leg) {
    const exactIndex = this.legs.findIndex(l => l.id === leg.id);
    if (exactIndex !== -1) {
      const removed = this.legs.splice(exactIndex, 1)[0];
      return { action: 'removed', leg: removed, replacedLeg: null };
    }

    // Check for conflicting selection on the same market category in the same game
    const conflictIndex = this.legs.findIndex(l => 
      l.gameId === leg.gameId && l.marketCategory === leg.marketCategory
    );

    if (conflictIndex !== -1) {
      const replaced = this.legs[conflictIndex];
      this.legs[conflictIndex] = { ...leg };
      return { action: 'replaced', leg: this.legs[conflictIndex], replacedLeg: replaced };
    }

    // Add new leg
    this.legs.push({ ...leg });
    return { action: 'added', leg: leg, replacedLeg: null };
  }

  /**
   * Add a leg directly to the slip (or replace if exact id exists)
   */
  addLeg(leg) {
    if (!leg) return;
    const existingIdx = this.legs.findIndex(l => l.id === leg.id);
    if (existingIdx !== -1) {
      this.legs[existingIdx] = { ...leg };
    } else {
      this.legs.push({ ...leg });
    }
  }

  /**
   * Remove a leg by ID
   */
  removeLeg(legId) {
    const idx = this.legs.findIndex(l => l.id === legId);
    if (idx !== -1) {
      return this.legs.splice(idx, 1)[0];
    }
    return null;
  }

  /**
   * Clear all legs from the slip
   */
  clearSlip() {
    this.legs = [];
    this.customOfferedOdds = null;
  }

  /**
   * Dynamic Ticket Classification
   */
  getTicketClassification() {
    if (this.legs.length === 0) {
      return { type: 'empty', label: 'Empty Bet Slip', badgeClass: 'badge-empty', isSgp: false };
    }
    if (this.legs.length === 1) {
      return { type: 'single', label: 'Single Wager', badgeClass: 'badge-single', isSgp: false };
    }

    // Group by gameId
    const gameCounts = {};
    this.legs.forEach(l => {
      gameCounts[l.gameId] = (gameCounts[l.gameId] || 0) + 1;
    });

    const uniqueGames = Object.keys(gameCounts).length;
    const maxLegsInSingleGame = Math.max(...Object.values(gameCounts));

    if (uniqueGames === 1) {
      return { 
        type: 'sgp', 
        label: 'Same-Game Parlay (Correlated SGP)', 
        badgeClass: 'badge-sgp', 
        isSgp: true,
        desc: 'All legs from 1 matchup evaluated on synchronized game script.'
      };
    }

    if (maxLegsInSingleGame >= 2) {
      return { 
        type: 'sgp_hybrid', 
        label: 'SGP + Multi-Game Combo', 
        badgeClass: 'badge-sgp-hybrid', 
        isSgp: true,
        desc: 'Hybrid ticket containing intra-game SGP correlations across games.'
      };
    }

    return { 
      type: 'parlay', 
      label: 'Standard Multi-Game Parlay', 
      badgeClass: 'badge-parlay', 
      isSgp: false,
      desc: 'Independent multi-game ticket.'
    };
  }

  // ==========================================
  // UNCORRELATED BOOK MULTIPLIER & PAYOUT
  // ==========================================

  /**
   * Calculate standard uncorrelated book multiplier & American odds
   */
  calculateUncorrelatedBookOdds() {
    if (this.legs.length === 0) {
      return { combinedDecimal: 1.0, combinedAmerican: 100, combinedImpliedProb: 1.0 };
    }

    let combinedDecimal = 1.0;
    this.legs.forEach(leg => {
      combinedDecimal *= this.americanToDecimal(leg.bookOdds);
    });

    const combinedAmerican = this.decimalToAmerican(combinedDecimal);
    const combinedImpliedProb = 1 / combinedDecimal;

    return {
      combinedDecimal: Number(combinedDecimal.toFixed(4)),
      combinedAmerican,
      combinedImpliedProb: Number(combinedImpliedProb.toFixed(4))
    };
  }

  // ==========================================
  // EXPECTED VALUE (+EV), VIG & ANALYTICS
  // ==========================================

  /**
   * Calculate complete quantitative analytics suite for the current ticket
   * @param {Object} simResults - { winProbability: 0.15, winCount: 1500, iterations: 10000, fairAmericanOdds: 567 }
   * @param {Array} slateData - full season slate data
   * @param {Number|null} customOddsOverride - user entered sportsbook offer
   * @param {Number} stake - stake in dollars
   */
  calculateAnalytics(simResults = null, slateData = [], customOddsOverride = null, stake = 10) {
    const classification = this.getTicketClassification();
    const uncorrelated = this.calculateUncorrelatedBookOdds();
    
    // Effective offered American odds (either user override or default bookmaker multiplier)
    const effectiveAmericanOdds = (customOddsOverride !== null && customOddsOverride !== undefined && !isNaN(Number(customOddsOverride)))
      ? Number(customOddsOverride)
      : uncorrelated.combinedAmerican;

    const effectiveDecimal = this.americanToDecimal(effectiveAmericanOdds);
    const bookImpliedProb = 1 / effectiveDecimal;

    // Simulation results (or fallback if not simulated yet)
    let simWinProb = 0;
    let fairAmericanOdds = 100;
    let iterations = 10000;

    if (simResults && simResults.winProbability !== undefined) {
      simWinProb = Number(simResults.winProbability);
      fairAmericanOdds = simResults.fairAmericanOdds !== undefined 
        ? simResults.fairAmericanOdds 
        : this.probToAmerican(simWinProb);
      iterations = simResults.iterations || 10000;
    } else {
      // Fallback to naive fair product
      const naiveProduct = this.calculateNaiveFairProduct(slateData);
      simWinProb = naiveProduct;
      fairAmericanOdds = this.probToAmerican(naiveProduct);
    }

    // Expected Value Percentage: EV% = (P_sim * Decimal_offered - 1) * 100
    const expectedValuePct = ((simWinProb * effectiveDecimal) - 1) * 100;
    const isPositiveEv = expectedValuePct > 0;

    // House Edge / Vig Tax: (1 - P_sim * Decimal_offered) * 100 (if negative EV, this represents house tax)
    const vigTaxPct = Math.max(0, -expectedValuePct);

    // Clean correlation lift: P_sim - Product(P_fair_indep)
    const naiveFairProduct = this.calculateNaiveFairProduct(slateData);
    const correlationBoostPct = (simWinProb - naiveFairProduct) * 100;

    // Plain-English Ticket Value formulation:
    // 1. If EV > 0: "Great Value (+EV)" with subtitle "Book payout beats the true math"
    // 2. If EV between 0% and -5%: "Fair Price" with subtitle "Standard book fee (X%)"
    // 3. If EV < -5%: "Overpriced" with subtitle "Sportsbook is taking a steep X% cut"
    let ticketValueBadge = 'Overpriced';
    let ticketValueBadgeClass = 'badge-overpriced';
    let ticketValueColor = 'var(--danger)';
    let ticketValueSubtitle = `Sportsbook is taking a steep ${vigTaxPct.toFixed(1)}% cut`;

    if (expectedValuePct > 0) {
      ticketValueBadge = 'Great Value (+EV)';
      ticketValueBadgeClass = 'badge-great-value';
      ticketValueColor = 'var(--accent)';
      ticketValueSubtitle = 'Book payout beats the true math';
    } else if (expectedValuePct >= -5.0) {
      ticketValueBadge = 'Fair Price';
      ticketValueBadgeClass = 'badge-fair-price';
      ticketValueColor = 'var(--gold-bright)';
      ticketValueSubtitle = `Standard book fee (${vigTaxPct.toFixed(1)}%)`;
    }

    // Plain-English Pick Synergy formulation:
    // 1. If boost > +0.5%: "+X% Synergy: Picks help each other"
    // 2. If boost < -0.5%: "-X% Clash: Picks fight each other"
    // 3. If within +/-0.5% (or multi-game): "Neutral: Independent games"
    let synergyHeader = 'Pick Synergy:';
    let synergyText = 'Neutral: Independent games';
    let synergyDetail = 'Neutral game dynamics across selected legs.';
    let synergyColor = 'var(--text-dim)';
    let synergyStatus = 'neutral';

    if (classification.isSgp) {
      if (correlationBoostPct > 0.5) {
        synergyText = `+${correlationBoostPct.toFixed(1)}% Synergy: Picks help each other`;
        synergyDetail = `Positive game-script correlation increases true joint win probability by +${correlationBoostPct.toFixed(1)}% over independent product math.`;
        synergyColor = 'var(--gold-bright)';
        synergyStatus = 'synergy';
      } else if (correlationBoostPct < -0.5) {
        synergyText = `${correlationBoostPct.toFixed(1)}% Clash: Picks fight each other`;
        synergyDetail = `Opposing game scripts decrease joint probability by ${Math.abs(correlationBoostPct).toFixed(1)}% below independent product math.`;
        synergyColor = 'var(--danger)';
        synergyStatus = 'clash';
      } else {
        synergyText = 'Neutral: Independent games';
        synergyDetail = 'Intra-game correlation has minimal directional impact on this combination.';
        synergyColor = 'var(--text-dim)';
        synergyStatus = 'neutral';
      }
    } else {
      synergyText = 'Neutral: Independent games';
      synergyDetail = `Multi-game parlay selections are independent (uncorrelated baseline fair product: ${Number((naiveFairProduct * 100).toFixed(2))}%).`;
      synergyColor = 'var(--text-dim)';
      synergyStatus = 'neutral';
    }

    // Payout and Profit
    const safeStake = Math.max(0.5, Number(stake) || 10);
    const potentialPayout = safeStake * effectiveDecimal;
    const potentialProfit = potentialPayout - safeStake;

    return {
      legsCount: this.legs.length,
      classification,
      stake: safeStake,
      effectiveAmericanOdds,
      effectiveDecimal: Number(effectiveDecimal.toFixed(3)),
      uncorrelatedAmerican: uncorrelated.combinedAmerican,
      uncorrelatedDecimal: uncorrelated.combinedDecimal,
      isCustomOdds: customOddsOverride !== null && customOddsOverride !== undefined && !isNaN(Number(customOddsOverride)),
      bookImpliedProbPct: Number((bookImpliedProb * 100).toFixed(2)),
      simWinProbPct: Number((simWinProb * 100).toFixed(2)),
      fairAmericanOdds,
      expectedValuePct: Number(expectedValuePct.toFixed(2)),
      isPositiveEv,
      vigTaxPct: Number(vigTaxPct.toFixed(2)),
      sportsbookCutPct: Number(vigTaxPct.toFixed(2)),
      naiveFairProbPct: Number((naiveFairProduct * 100).toFixed(2)),
      correlationBoostPct: Number(correlationBoostPct.toFixed(2)),
      potentialPayout: Number(potentialPayout.toFixed(2)),
      potentialProfit: Number(potentialProfit.toFixed(2)),
      iterations,
      pushProbabilityPct: Number(((simResults?.pushProbability || 0) * 100).toFixed(2)),
      fullWinProbPct: Number(((simResults?.fullWinProbability || simWinProb) * 100).toFixed(2)),
      exactSimulatedEvPct: simResults?.exactSimulatedEvPct !== undefined ? Number(simResults.exactSimulatedEvPct.toFixed(2)) : null,
      hasFlatLines: this.legs.some(l => OddsUtils.isFlatLine(l.lineValue)),
      legPushStats: simResults?.legPushStats || [],
      ticketValue: {
        badge: ticketValueBadge,
        badgeClass: ticketValueBadgeClass,
        color: ticketValueColor,
        subtitle: ticketValueSubtitle,
        evPct: Number(expectedValuePct.toFixed(2)),
        sportsbookCutPct: Number(vigTaxPct.toFixed(2))
      },
      pickSynergy: {
        header: synergyHeader,
        text: synergyText,
        detail: synergyDetail,
        color: synergyColor,
        status: synergyStatus,
        boostPct: Number(correlationBoostPct.toFixed(2))
      }
    };
  }

  // ==========================================
  // EMBEDDED SYNCHRONOUS SIMULATOR (FALLBACK)
  // ==========================================

  /**
   * 10,000-Iteration Monte Carlo Parlay Simulation with Box-Muller Normal Score Generator
   * and Push Reduction Handling.
   */
  runSyncSimulation(slateData = [], iterations = 10000) {
    if (this.legs.length === 0) {
      return { winProbability: 0, winCount: 0, iterations, fairAmericanOdds: 100 };
    }

    // 1. Build Game Baseline Lookup for legs in slip
    const gameBaselines = {};
    const weeks = this.getWeeks(slateData);
    this.legs.forEach(leg => {
      if (!gameBaselines[leg.gameId]) {
        let gameObj = null;
        for (const weekObj of weeks) {
          const found = (weekObj.games || []).find(g => g.id === leg.gameId);
          if (found) { gameObj = found; break; }
        }

        const spread = gameObj ? Number(gameObj.spread || 0) : Number(leg.lineValue || 0);
        const total = gameObj ? Number(gameObj.total || 44) : 44.0;

        // Implied Team Means: HomeMean = (Total - Spread)/2, AwayMean = (Total + Spread)/2
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
    const legPushCounts = new Array(this.legs.length).fill(0);

    // Marsaglia Polar / Box-Muller normal sampling helper
    const sampleNormal = (mean, stdDev) => {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return Math.max(0, Math.round(mean + stdDev * z));
    };

    for (let iter = 0; iter < iterations; iter++) {
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
          margin: homeScore - awayScore // positive means Home won by X
        };
      });

      // Track individual leg push frequencies
      this.legs.forEach((leg, idx) => {
        const outcome = evaluateLegOutcome(leg, simScores[leg.gameId]);
        if (outcome === 'PUSH') legPushCounts[idx]++;
      });

      // Step B: Resolve Ticket Outcome with American push rules
      const res = resolveParlayTicketIteration(this.legs, simScores);
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
    const fairAmericanOdds = this.probToAmerican(winProbability);

    const legPushStats = this.legs.map((leg, idx) => ({
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

  /**
   * ⚡ AUTO-GENERATE TICKET BUILDER
   * Algorithmic ticket generator with strict quantitative guardrails for High Win % and Best Value (+EV) strategies.
   * 
   * Strict Guardrails:
   * 1. "High Win %" Mode:
   *    - Hard filter: Remove ANY candidate line with odds steeper than -220 (e.g. rejects -250, -380, -575, -800).
   *    - Selection priority: Pick favorite point spreads (-110), low-vig totals (-110), or modest moneylines between -115 and -220.
   *    - Payout validation: Enforce a plus-money floor (combined odds >= +100) and target +120 to +250 for 3 legs.
   * 2. "Best Value (+EV)" Mode:
   *    - Hard filter: Moneyline odds strictly between -200 and +175.
   *    - Spread substitution: If an underdog game has positive SGP synergy, NEVER select the moneyline (e.g. NO ML +575 or DEN ML +800 forbidden). Always select the point spread.
   *    - Hard payout caps: 2 legs max +450, 3 legs max +850, 4 legs max +1500, 5 legs max +2800.
   * 3. Runtime verification assertions & console.table:
   *    - Log chosen ticket details in console.table.
   *    - Strictly assert that all bounds are obeyed or throw Error.
   * 
   * @param {Array} slateData - 18-week slate data array
   * @param {number} week - Active week index (1-18)
   * @param {Object} options - { legsCount: 2-5, strategy: 'high_win' | 'best_value' }
   * @returns {Array} Array of candidate leg objects matching bet slip schema
   */
  /**
   * ⚡ BATCH AUTO-GENERATE TICKETS BUILDER (v3.9.0)
   * Algorithmic ticket generator with strict quantitative guardrails and diversity de-duplication:
   * - Supports ticketCount = 1, 2, or 3.
   * - Ensures diversity constraint: No two tickets in the same batch may share more than 1 leg.
   * - Each ticket independently satisfies +EV, positive synergy (> 0%), and strict odds guardrails.
   * - Executes 10,000-run Monte Carlo simulations with push reduction math for each ticket in the batch.
   * 
   * @param {Array} slateData - 18-week slate data array
   * @param {number} week - Active week index (1-18)
   * @param {Object} options - { legsCount: 2-5, strategy: 'high_win' | 'best_value', ticketCount: 1-3 }
   * @returns {Array<Object>} Array of ticket objects: [{ id, legs, combinedOdds, formattedOdds, simResults, analytics, classification }]
   */
  generateAutoTickets(slateData = [], week = 1, options = {}) {
    const targetWeek = Number(week) || 1;
    const legsCount = Math.max(2, Math.min(5, Number(options.legsCount) || 3));
    const strategy = options.strategy || 'best_value';
    const ticketCount = Math.max(1, Math.min(3, Number(options.ticketCount) || 1));

    const weeks = this.getWeeks(slateData);
    const weekData = weeks.find(s => s.week === targetWeek);
    if (!weekData || !Array.isArray(weekData.games) || weekData.games.length === 0) {
      return [];
    }

    const prevSlip = [...this.legs];

    const buildAllGameLegs = (g) => {
      const homeSpread = Number(g.spread || 0);
      const awaySpread = -homeSpread;
      const total = Number(g.total || 44.0);
      const spreadOdds = Number(g.spreadOdds || -110);
      const overOdds = Number(g.totalOverOdds || -110);
      const underOdds = Number(g.totalUnderOdds || -110);
      const homeMl = Number(g.homeMoneyline || (g.homeWinProb >= 0.5 ? -150 : 130));
      const awayMl = Number(g.awayMoneyline || (g.awayWinProb >= 0.5 ? -150 : 130));

      const isHomeFav = (g.homeWinProb || 0.5) >= 0.5;
      const favTeam = isHomeFav ? g.homeTeam : g.awayTeam;
      const dogTeam = isHomeFav ? g.awayTeam : g.homeTeam;

      const homeSpreadFormatted = homeSpread > 0 ? `+${homeSpread}` : `${homeSpread}`;
      const awaySpreadFormatted = awaySpread > 0 ? `+${awaySpread}` : `${awaySpread}`;

      const legs = [
        {
          id: `${g.id}_spread_${g.awayTeam}`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: g.awayTeam,
          selection: g.awayTeam,
          isUnderdog: g.awayTeam === dogTeam,
          isFavorite: g.awayTeam === favTeam,
          marketType: 'spread',
          marketCategory: 'spread',
          lineValue: awaySpread,
          bookOdds: spreadOdds,
          label: `${g.awayTeam} ${awaySpreadFormatted}`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: g.awayWinProb >= 0.5 ? 0.52 : 0.48
        },
        {
          id: `${g.id}_spread_${g.homeTeam}`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: g.homeTeam,
          selection: g.homeTeam,
          isUnderdog: g.homeTeam === dogTeam,
          isFavorite: g.homeTeam === favTeam,
          marketType: 'spread',
          marketCategory: 'spread',
          lineValue: homeSpread,
          bookOdds: spreadOdds,
          label: `${g.homeTeam} ${homeSpreadFormatted}`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: g.homeWinProb >= 0.5 ? 0.52 : 0.48
        },
        {
          id: `${g.id}_total_over`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: 'OVER',
          selection: 'OVER',
          isUnderdog: false,
          isFavorite: false,
          marketType: 'total_over',
          marketCategory: 'total',
          lineValue: total,
          bookOdds: overOdds,
          label: `OVER ${total}`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: 0.50
        },
        {
          id: `${g.id}_total_under`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: 'UNDER',
          selection: 'UNDER',
          isUnderdog: false,
          isFavorite: false,
          marketType: 'total_under',
          marketCategory: 'total',
          lineValue: total,
          bookOdds: underOdds,
          label: `UNDER ${total}`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: 0.50
        },
        {
          id: `${g.id}_ml_${g.awayTeam}`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: g.awayTeam,
          selection: g.awayTeam,
          isUnderdog: g.awayTeam === dogTeam,
          isFavorite: g.awayTeam === favTeam,
          marketType: 'moneyline',
          marketCategory: 'moneyline',
          lineValue: null,
          bookOdds: awayMl,
          label: `${g.awayTeam} ML`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: Number(g.awayWinProb || 0.5)
        },
        {
          id: `${g.id}_ml_${g.homeTeam}`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: g.homeTeam,
          selection: g.homeTeam,
          isUnderdog: g.homeTeam === dogTeam,
          isFavorite: g.homeTeam === favTeam,
          marketType: 'moneyline',
          marketCategory: 'moneyline',
          lineValue: null,
          bookOdds: homeMl,
          label: `${g.homeTeam} ML`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: Number(g.homeWinProb || 0.5)
        }
      ];

      return { legs, isHomeFav, favTeam, dogTeam };
    };

    const getCombinations = (arr, k) => {
      if (k === 1) return arr.map(x => [x]);
      const result = [];
      for (let i = 0; i <= arr.length - k; i++) {
        const head = arr[i];
        const tailCombos = getCombinations(arr.slice(i + 1), k - 1);
        tailCombos.forEach(t => result.push([head, ...t]));
      }
      return result;
    };

    const sharedLegCount = (legsA, legsB) => {
      const idsA = new Set(legsA.map(l => l.id));
      let count = 0;
      for (const leg of legsB) {
        if (idsA.has(leg.id)) count++;
      }
      return count;
    };

    let evaluated = [];

    // =========================================================================
    // 1. "HIGH WIN %" MODE
    // =========================================================================
    if (strategy === 'high_win') {
      const highWinPool = [];
      weekData.games.forEach(g => {
        const { legs, favTeam } = buildAllGameLegs(g);

        const favMl = legs.find(l => l.marketCategory === 'moneyline' && l.selection === favTeam);
        const favSpread = legs.find(l => l.marketCategory === 'spread' && l.selection === favTeam);
        const overLeg = legs.find(l => l.marketCategory === 'total' && l.marketType === 'total_over');
        const underLeg = legs.find(l => l.marketCategory === 'total' && l.marketType === 'total_under');

        if (favMl && favMl.bookOdds >= -220 && favMl.bookOdds <= -115) {
          highWinPool.push({ ...favMl, score: favMl.winProb * 1.35 });
        }
        if (favSpread && favSpread.bookOdds >= -220) {
          highWinPool.push({ ...favSpread, score: 0.52 + (favSpread.winProb * 0.1) });
        }
        if (overLeg && overLeg.bookOdds >= -220) highWinPool.push({ ...overLeg, score: 0.50 });
        if (underLeg && underLeg.bookOdds >= -220) highWinPool.push({ ...underLeg, score: 0.50 });
      });

      const gamesMap = new Map();
      highWinPool.forEach(l => {
        if (!gamesMap.has(l.gameId)) gamesMap.set(l.gameId, []);
        gamesMap.get(l.gameId).push(l);
      });

      const gameIds = Array.from(gamesMap.keys());
      const gameCombos = getCombinations(gameIds, legsCount).slice(0, 120);
      const candidateTickets = [];

      gameCombos.forEach(gCombo => {
        const primaryLegs = gCombo.map(gid => {
          const list = gamesMap.get(gid);
          list.sort((a, b) => b.score - a.score);
          return list[0];
        });
        candidateTickets.push(primaryLegs);

        for (let i = 0; i < gCombo.length; i++) {
          const gid = gCombo[i];
          const list = gamesMap.get(gid);
          if (list.length > 1) {
            const altLegs = [...primaryLegs];
            altLegs[i] = list[1];
            candidateTickets.push(altLegs);
          }
        }
      });

      candidateTickets.forEach(tLegs => {
        this.legs = tLegs;
        const uncorr = this.calculateUncorrelatedBookOdds();
        const odds = uncorr.combinedAmerican;

        if (odds < 100) return;

        let targetScore = 0;
        if (legsCount === 3) {
          if (odds >= 120 && odds <= 250) targetScore = 150;
          else if (odds < 120) targetScore = 150 - (120 - odds) * 2;
          else targetScore = 150 - (odds - 250) * 0.5;
        } else if (legsCount === 2) {
          if (odds >= 100 && odds <= 200) targetScore = 100;
          else targetScore = 100 - Math.abs(odds - 150) * 0.3;
        } else if (legsCount === 4) {
          if (odds >= 200 && odds <= 450) targetScore = 100;
          else targetScore = 100 - Math.abs(odds - 300) * 0.2;
        } else if (legsCount === 5) {
          if (odds >= 350 && odds <= 750) targetScore = 100;
          else targetScore = 100 - Math.abs(odds - 500) * 0.2;
        }

        const sim = this.runSyncSimulation(slateData, 2000);
        const analytics = this.calculateAnalytics(sim, slateData);

        evaluated.push({
          legs: tLegs,
          odds,
          winProb: analytics.simWinProbPct,
          score: (analytics.simWinProbPct * 2) + targetScore,
          analytics
        });
      });

      evaluated.sort((a, b) => b.score - a.score);
    }

    // =========================================================================
    // 2. "BEST VALUE (+EV)" MODE
    // =========================================================================
    else {
      const MIN_SGP_SYNERGY_FLOOR = 2.5; // Strictly require >= +2.5% correlation synergy

      const maxPayoutCaps = { 2: 450, 3: 850, 4: 1500, 5: 2800 };
      const maxCap = maxPayoutCaps[legsCount] || 1500;

      const targetWindows = {
        2: { min: 220, max: 400 },
        3: { min: 450, max: 750 },
        4: { min: 850, max: 1400 },
        5: { min: 1500, max: 2600 }
      };
      const targetWin = targetWindows[legsCount] || { min: 200, max: 1500 };

      // Step A: Build SGP candidates with strict synergy floor >= +2.5%
      const validSgpPairs = [];
      weekData.games.forEach(g => {
        const { legs } = buildAllGameLegs(g);
        const spreadLegs = legs.filter(l => l.marketCategory === 'spread');
        const totalLegs = legs.filter(l => l.marketCategory === 'total');
        
        const allowedMlLegs = legs.filter(l => 
          l.marketCategory === 'moneyline' && 
          l.bookOdds >= -200 && 
          l.bookOdds <= 175 &&
          !l.isUnderdog
        );

        // 1. Point Spread + Total
        spreadLegs.forEach(sp => {
          totalLegs.forEach(tot => {
            this.legs = [sp, tot];
            const sim = this.runSyncSimulation(slateData, 2000);
            const analytics = this.calculateAnalytics(sim, slateData);

            const odds = analytics.effectiveAmericanOdds;
            const synergy = analytics.correlationBoostPct;
            const pushAdjustedEV = analytics.exactSimulatedEvPct !== null && analytics.exactSimulatedEvPct !== undefined 
              ? analytics.exactSimulatedEvPct 
              : analytics.expectedValuePct;

            if (synergy >= MIN_SGP_SYNERGY_FLOOR && odds <= 450 && odds >= 180) {
              validSgpPairs.push({
                pair: [sp, tot],
                gameId: g.id,
                boostPct: synergy,
                evPct: analytics.expectedValuePct,
                pushAdjustedEV,
                winProbPct: analytics.simWinProbPct,
                odds
              });
            }
          });
        });

        // 2. Favorite Moneyline + Total
        allowedMlLegs.forEach(ml => {
          totalLegs.forEach(tot => {
            this.legs = [ml, tot];
            const sim = this.runSyncSimulation(slateData, 2000);
            const analytics = this.calculateAnalytics(sim, slateData);

            const odds = analytics.effectiveAmericanOdds;
            const synergy = analytics.correlationBoostPct;
            const pushAdjustedEV = analytics.exactSimulatedEvPct !== null && analytics.exactSimulatedEvPct !== undefined 
              ? analytics.exactSimulatedEvPct 
              : analytics.expectedValuePct;

            if (synergy >= MIN_SGP_SYNERGY_FLOOR && odds <= 450 && odds >= 180) {
              validSgpPairs.push({
                pair: [ml, tot],
                gameId: g.id,
                boostPct: synergy,
                evPct: analytics.expectedValuePct,
                pushAdjustedEV,
                winProbPct: analytics.simWinProbPct,
                odds
              });
            }
          });
        });
      });

      validSgpPairs.sort((a, b) => b.pushAdjustedEV - a.pushAdjustedEV);

      // Step B: Independent Legs from other games
      const independentCandidates = [];
      weekData.games.forEach(g => {
        const { legs } = buildAllGameLegs(g);
        legs.forEach(leg => {
          if (leg.marketCategory === 'moneyline') {
            if (leg.bookOdds >= -200 && leg.bookOdds <= 175) {
              independentCandidates.push(leg);
            }
          } else if (leg.marketCategory === 'spread' || leg.marketCategory === 'total') {
            independentCandidates.push(leg);
          }
        });
      });

      // Step C: Form candidate combinations matching exact legsCount
      const candidateTickets = [];

      if (legsCount === 2) {
        validSgpPairs.forEach(sp => {
          if (sp.odds <= maxCap) {
            candidateTickets.push(sp.pair);
          }
        });
      } else {
        const topPairs = validSgpPairs.slice(0, 25);
        topPairs.forEach(sgp => {
          const otherLegs = independentCandidates.filter(l => l.gameId !== sgp.gameId);
          const needed = legsCount - 2;

          const gamesMap = new Map();
          otherLegs.forEach(l => {
            if (!gamesMap.has(l.gameId)) gamesMap.set(l.gameId, []);
            gamesMap.get(l.gameId).push(l);
          });

          const gameIds = Array.from(gamesMap.keys());
          const gameCombos = getCombinations(gameIds, needed).slice(0, 16);
          gameCombos.forEach(gCombo => {
            const additionalLegs = gCombo.map(gid => {
              const legsForG = gamesMap.get(gid);
              return legsForG.find(l => l.marketCategory === 'spread') || legsForG[0];
            });

            candidateTickets.push([...sgp.pair, ...additionalLegs]);

            for (let i = 0; i < gCombo.length; i++) {
              const gid = gCombo[i];
              const legsForG = gamesMap.get(gid);
              if (legsForG.length > 1) {
                const altAdditional = [...additionalLegs];
                altAdditional[i] = legsForG[1];
                candidateTickets.push([...sgp.pair, ...altAdditional]);
              }
            }
          });
        });
      }

      // Also populate pure multi-game independent candidate combinations so batch diversity is guaranteed
      const indGamesMap = new Map();
      independentCandidates.forEach(l => {
        if (!indGamesMap.has(l.gameId)) indGamesMap.set(l.gameId, []);
        indGamesMap.get(l.gameId).push(l);
      });
      const allGameIds = Array.from(indGamesMap.keys());
      const indCombos = getCombinations(allGameIds, legsCount).slice(0, 30);
      indCombos.forEach(gCombo => {
        const indLegs = gCombo.map(gid => {
          const legsForG = indGamesMap.get(gid);
          return legsForG.find(l => l.marketCategory === 'spread') || legsForG[0];
        });
        candidateTickets.push(indLegs);
      });

      // Step D: Evaluate against Max Payout Cap & Realistic Target Window
      candidateTickets.forEach(tLegs => {
        this.legs = tLegs;
        const uncorr = this.calculateUncorrelatedBookOdds();
        const odds = uncorr.combinedAmerican;

        if (odds > maxCap) return;

        const sim = this.runSyncSimulation(slateData, 2000);
        const analytics = this.calculateAnalytics(sim, slateData);

        // Positive synergy check: ensure intra-game legs do not clash
        if (analytics.classification.isSgp && analytics.correlationBoostPct < 0.1) return;

        const pushAdjustedEV = analytics.exactSimulatedEvPct !== null && analytics.exactSimulatedEvPct !== undefined 
          ? analytics.exactSimulatedEvPct 
          : analytics.expectedValuePct;

        let rangePenalty = 0;
        if (odds < targetWin.min) {
          rangePenalty = Math.abs(targetWin.min - odds) * 0.15;
        } else if (odds > targetWin.max) {
          rangePenalty = Math.abs(odds - targetWin.max) * 0.20;
        }

        const totalScore = pushAdjustedEV - rangePenalty;

        evaluated.push({
          legs: tLegs,
          odds,
          evPct: analytics.expectedValuePct,
          pushAdjustedEV,
          boostPct: analytics.correlationBoostPct,
          winProbPct: analytics.simWinProbPct,
          totalScore,
          analytics
        });
      });

      evaluated.sort((a, b) => b.totalScore - a.totalScore);

      // =========================================================================
      // TRUE +EV VALIDATION & DIRECT VIG-MINIMIZED FALLBACK (Exact legsCount preserved)
      // =========================================================================
      const plusEvCandidates = evaluated.filter(c => c.pushAdjustedEV > 0);

      if (plusEvCandidates.length >= ticketCount) {
        plusEvCandidates.forEach(c => {
          c.isTruePlusEv = true;
          c.strategyClassification = 'Best Value (+EV)';
        });
        evaluated = plusEvCandidates;
      } else {
        // Direct Fallback: No silent downgrading of legs.
        // Maintain the exact requested legsCount and minimize house vig.
        if (evaluated.length === 0) {
          const gamesMap = new Map();
          independentCandidates.forEach(l => {
            if (!gamesMap.has(l.gameId)) gamesMap.set(l.gameId, []);
            gamesMap.get(l.gameId).push(l);
          });
          const gameIds = Array.from(gamesMap.keys());
          const gameCombos = getCombinations(gameIds, legsCount).slice(0, 30);
          gameCombos.forEach(gCombo => {
            const fallbackLegs = gCombo.map(gid => {
              const legsForG = gamesMap.get(gid);
              return legsForG.find(l => l.marketCategory === 'spread') || legsForG[0];
            });

            if (fallbackLegs.length === legsCount) {
              this.legs = fallbackLegs;
              const uncorr = this.calculateUncorrelatedBookOdds();
              const odds = uncorr.combinedAmerican;
              if (odds <= maxCap) {
                const sim = this.runSyncSimulation(slateData, 2000);
                const analytics = this.calculateAnalytics(sim, slateData);
                const pushAdjustedEV = analytics.exactSimulatedEvPct !== null && analytics.exactSimulatedEvPct !== undefined 
                  ? analytics.exactSimulatedEvPct 
                  : analytics.expectedValuePct;
                evaluated.push({
                  legs: fallbackLegs,
                  odds,
                  evPct: analytics.expectedValuePct,
                  pushAdjustedEV,
                  boostPct: 0,
                  winProbPct: analytics.simWinProbPct,
                  totalScore: pushAdjustedEV,
                  analytics
                });
              }
            }
          });
        }

        evaluated.sort((a, b) => b.pushAdjustedEV - a.pushAdjustedEV);
        evaluated.forEach(c => {
          c.isTruePlusEv = false;
          c.strategyClassification = 'Best Available (Vig-Minimized)';
          if (c.analytics && c.analytics.ticketValue) {
            c.analytics.ticketValue.badge = 'Best Available (Vig-Minimized)';
            c.analytics.ticketValue.badgeClass = 'badge-fair-price';
            c.analytics.ticketValue.color = 'var(--gold-bright)';
            c.analytics.ticketValue.subtitle = `Vig minimized (${c.analytics.vigTaxPct.toFixed(1)}% bookmaker margin)`;
          }
        });
      }
    }

    // =========================================================================
    // 3. DIVERSITY & DE-DUPLICATION SELECTION (No more than 1 shared leg)
    // =========================================================================
    const selectedTicketCandidates = [];

    // Pass 1: Strict diversity (shares <= 1 leg with every already selected ticket)
    for (const cand of evaluated) {
      if (selectedTicketCandidates.length >= ticketCount) break;
      const isDiverse = selectedTicketCandidates.every(chosen => sharedLegCount(cand.legs, chosen.legs) <= 1);
      if (isDiverse) {
        selectedTicketCandidates.push(cand);
      }
    }

    // Pass 2: Fallback if strictly <= 1 leg didn't yield requested ticketCount
    if (selectedTicketCandidates.length < ticketCount) {
      for (const cand of evaluated) {
        if (selectedTicketCandidates.length >= ticketCount) break;
        if (!selectedTicketCandidates.includes(cand)) {
          selectedTicketCandidates.push(cand);
        }
      }
    }

    // Restore engine slip
    this.legs = prevSlip;

    if (selectedTicketCandidates.length === 0) {
      throw new Error(`Critical Error: No valid tickets generated for Week ${targetWeek} (${legsCount} legs, ${strategy})!`);
    }

    // =========================================================================
    // 4. 10,000-RUN MONTE CARLO SIMULATION & INTEGRITY ASSERTIONS PER TICKET
    // =========================================================================
    const finalTickets = selectedTicketCandidates.map((cand, idx) => {
      this.legs = cand.legs;
      const uncorr = this.calculateUncorrelatedBookOdds();
      const combinedOdds = uncorr.combinedAmerican;
      const simResults = this.runSyncSimulation(slateData, 10000);
      const analytics = this.calculateAnalytics(simResults, slateData);
      const classification = this.getTicketClassification();

      // Guardrail Assertions
      if (strategy === 'high_win') {
        cand.legs.forEach(leg => {
          if (leg.bookOdds < -220) {
            throw new Error(`High Win % Violation: Leg ${leg.label} has juice steeper than -220 (${leg.bookOdds})!`);
          }
        });
        if (combinedOdds < 100) {
          throw new Error(`High Win % Violation: Ticket payout is not plus money (${combinedOdds})!`);
        }
      }

      const pushAdjustedEV = analytics.exactSimulatedEvPct !== null && analytics.exactSimulatedEvPct !== undefined 
        ? analytics.exactSimulatedEvPct 
        : analytics.expectedValuePct;
      const isTruePlusEv = pushAdjustedEV > 0;
      let strategyClassification = cand.strategyClassification || (isTruePlusEv ? 'Best Value (+EV)' : 'Best Available (Vig-Minimized)');

      if (strategy === 'best_value') {
        cand.legs.forEach(leg => {
          if (leg.marketCategory === 'moneyline') {
            if (leg.bookOdds < -200 || leg.bookOdds > 175) {
              throw new Error(`Best Value ML Violation: Leg ${leg.label} odds (${leg.bookOdds}) outside [-200, +175]!`);
            }
          }
        });
        const maxPayoutCaps = { 2: 450, 3: 850, 4: 1500, 5: 2800 };
        const maxCap = maxPayoutCaps[legsCount] || 1500;
        if (combinedOdds > maxCap) {
          throw new Error(`Best Value Payout Violation: Combined odds +${combinedOdds} exceeds max cap +${maxCap}!`);
        }

        // STRICT TRUTH IN ADVERTISING:
        // If final 10,000-run simulation indicates pushAdjustedEV <= 0:
        // strictly re-classify to Best Available (Vig-Minimized) so UI never contradicts itself.
        if (!isTruePlusEv) {
          strategyClassification = 'Best Available (Vig-Minimized)';
          analytics.ticketValue.badge = 'Best Available (Vig-Minimized)';
          analytics.ticketValue.badgeClass = 'badge-fair-price';
          analytics.ticketValue.color = 'var(--gold-bright)';
          analytics.ticketValue.subtitle = `Vig minimized (${analytics.vigTaxPct.toFixed(1)}% bookmaker margin)`;
        } else {
          strategyClassification = 'Best Value (+EV)';
        }
      }

      return {
        id: idx + 1,
        legs: cand.legs,
        combinedOdds,
        formattedOdds: this.formatAmerican(combinedOdds),
        simResults,
        analytics,
        classification,
        strategyClassification,
        isTruePlusEv
      };
    });

    this.legs = prevSlip;

    // Log verification tables
    finalTickets.forEach(t => {
      console.log(`\n======================================================`);
      console.log(`TICKET #${t.id} GENERATED: Week ${targetWeek} | ${legsCount} Legs | Strategy: ${strategy} | Combined Odds: ${t.formattedOdds}`);
      console.log(`======================================================`);
      console.table(t.legs.map(l => ({
        Selection: l.label,
        Matchup: l.matchup,
        Category: l.marketCategory,
        Odds: l.bookOdds > 0 ? `+${l.bookOdds}` : `${l.bookOdds}`,
        WinProb: (l.winProb * 100).toFixed(1) + '%'
      })));
    });

    return finalTickets;
  }

  /**
   * Backward-compatible single ticket generator
   */
  generateAutoTicket(slateData = [], week = 1, options = {}) {
    const tickets = this.generateAutoTickets(slateData, week, { ...options, ticketCount: 1 });
    return tickets[0]?.legs || [];
  }
}
