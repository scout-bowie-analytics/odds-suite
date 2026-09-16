/**
 * 🐾 SCOUT BOWIE PARLAY & SAME-GAME PARLAY (SGP) ANALYTICAL ENGINE
 * Pure client-side analytical core for bet slip management, odds conversion,
 * uncorrelated multiplier calculations, vig/edge metrics, and SGP correlation analysis.
 */

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

    let product = 1.0;
    this.legs.forEach(leg => {
      let slateGame = null;
      if (Array.isArray(slateData)) {
        for (const weekObj of slateData) {
          const found = (weekObj.games || []).find(g => g.id === leg.gameId);
          if (found) { slateGame = found; break; }
        }
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
    this.legs.forEach(leg => {
      if (!gameBaselines[leg.gameId]) {
        let gameObj = null;
        for (const weekObj of slateData) {
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
    let winCount = 0;

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

      // Step B: Evaluate each ticket leg against the simulated scoreline
      let ticketFailed = false;
      let nonPushWins = 0;

      for (let i = 0; i < this.legs.length; i++) {
        const leg = this.legs[i];
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
        }
      }

      // Ticket is a simulation win if no legs lost and at least 1 leg won
      if (!ticketFailed && (nonPushWins > 0 || this.legs.length === 0)) {
        winCount++;
      }
    }

    const winProbability = Number((winCount / iterations).toFixed(4));
    const fairAmericanOdds = this.probToAmerican(winProbability);

    return {
      winCount,
      iterations,
      winProbability,
      fairAmericanOdds
    };
  }

  /**
   * ⚡ AUTO-GENERATE TICKET BUILDER
   * Algorithmic ticket generator with quantitative guardrails for High Win % and Best Value (+EV) strategies.
   * 
   * Guardrails for "Best Value (+EV)":
   * 1. Symmetrical Moneyline Cap: Limits moneyline candidates strictly between -200 and +175.
   * 2. Spread Substitution: Replaces extreme underdog moneylines with Point Spreads (e.g., NO +11) in correlated SGP pairs.
   * 3. Realistic Payout Targets: Calibrated target payout windows (2-Leg: +220 to +400, 3-Leg: +450 to +750, 4-Leg: +850 to +1400).
   * 
   * Guardrails for "High Win %":
   * 1. Minimum Payout Floor: Enforces that tickets must pay plus money (minimum target: +110 to +180 for 3 legs).
   * 2. Maximum Juice Cap on Individual Legs: Disallows individual legs steeper than -220.
   * 3. Smart Favorites: Prioritizes low-vig point spreads (-110) or totals for teams favored to control game script rather than eating -575 hold.
   * 
   * @param {Array} slateData - 18-week slate data array
   * @param {number} week - Active week index (1-18)
   * @param {Object} options - { legsCount: 2-5, strategy: 'high_win' | 'best_value' }
   * @returns {Array} Array of candidate leg objects matching bet slip schema
   */
  generateAutoTicket(slateData = [], week = 1, options = {}) {
    const targetWeek = Number(week) || 1;
    const legsCount = Math.max(2, Math.min(5, Number(options.legsCount) || 3));
    const strategy = options.strategy || 'best_value';

    const weekData = (slateData || []).find(s => s.week === targetWeek);
    if (!weekData || !Array.isArray(weekData.games) || weekData.games.length === 0) {
      return [];
    }

    const buildLegsForGame = (g) => {
      const homeSpread = Number(g.spread || 0);
      const awaySpread = -homeSpread;
      const total = Number(g.total || 44.0);
      const spreadOdds = Number(g.spreadOdds || -110);
      const overOdds = Number(g.totalOverOdds || -110);
      const underOdds = Number(g.totalUnderOdds || -110);
      const homeMl = Number(g.homeMoneyline || (g.homeWinProb >= 0.5 ? -150 : 130));
      const awayMl = Number(g.awayMoneyline || (g.awayWinProb >= 0.5 ? -150 : 130));

      const homeSpreadFormatted = homeSpread > 0 ? `+${homeSpread}` : `${homeSpread}`;
      const awaySpreadFormatted = awaySpread > 0 ? `+${awaySpread}` : `${awaySpread}`;

      return [
        {
          id: `${g.id}_spread_${g.awayTeam}`,
          gameId: g.id,
          week: targetWeek,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          team: g.awayTeam,
          selection: g.awayTeam,
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
          marketType: 'moneyline',
          marketCategory: 'moneyline',
          lineValue: null,
          bookOdds: homeMl,
          label: `${g.homeTeam} ML`,
          matchup: `${g.awayTeam} @ ${g.homeTeam}`,
          winProb: Number(g.homeWinProb || 0.5)
        }
      ];
    };

    const prevSlip = [...this.legs];

    // ==========================================
    // 1. STRATEGY: HIGH WIN % (PLUS MONEY FLOOR + JUICE CAP)
    // ==========================================
    if (strategy === 'high_win') {
      const highWinCandidates = [];
      weekData.games.forEach(g => {
        const gameLegs = buildLegsForGame(g);
        const isHomeFav = (g.homeWinProb || 0.5) >= 0.5;
        const favTeam = isHomeFav ? g.homeTeam : g.awayTeam;
        const favWinProb = isHomeFav ? Number(g.homeWinProb || 0.5) : Number(g.awayWinProb || 0.5);

        const favMl = gameLegs.find(l => l.marketCategory === 'moneyline' && l.selection === favTeam);
        const favSpread = gameLegs.find(l => l.marketCategory === 'spread' && l.selection === favTeam);
        const overLeg = gameLegs.find(l => l.marketCategory === 'total' && l.selection === 'OVER');
        const underLeg = gameLegs.find(l => l.marketCategory === 'total' && l.selection === 'UNDER');

        // Valid moneyline within juice cap (-220 to -105)
        if (favMl && favMl.bookOdds >= -220 && favMl.bookOdds <= -105) {
          highWinCandidates.push({ ...favMl, priority: favWinProb * 1.3 });
        }

        // Smart Favorite Spread: If moneyline is steeper than -220, use low-vig spread (-110)
        if (favSpread) {
          highWinCandidates.push({ ...favSpread, priority: 0.52 + (favWinProb * 0.1) });
        }

        // Standard Totals
        if (overLeg) highWinCandidates.push({ ...overLeg, priority: 0.50 });
        if (underLeg) highWinCandidates.push({ ...underLeg, priority: 0.50 });
      });

      const gamesMap = new Map();
      highWinCandidates.forEach(l => {
        if (!gamesMap.has(l.gameId)) gamesMap.set(l.gameId, []);
        gamesMap.get(l.gameId).push(l);
      });

      const gameIds = Array.from(gamesMap.keys());
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

      const gameCombos = getCombinations(gameIds, legsCount).slice(0, 25);
      const candidateTickets = [];

      gameCombos.forEach(gCombo => {
        const ticketLegs = gCombo.map(gid => {
          const list = gamesMap.get(gid);
          list.sort((a, b) => b.priority - a.priority);
          return list[0];
        });
        candidateTickets.push(ticketLegs);
      });

      // Enforce Minimum Payout Floor (Parlay must pay plus money: effectiveAmericanOdds >= +100)
      const evaluatedTickets = [];
      candidateTickets.forEach(tLegs => {
        this.legs = tLegs;
        const sim = this.runSyncSimulation(slateData, 2000);
        const analytics = this.calculateAnalytics(sim, slateData);

        const isPlusMoney = analytics.effectiveAmericanOdds >= 100;
        const payoutScore = isPlusMoney ? 100 : -1000;

        evaluatedTickets.push({
          legs: tLegs,
          winProb: analytics.simWinProbPct,
          odds: analytics.effectiveAmericanOdds,
          score: (analytics.simWinProbPct * 2) + payoutScore,
          analytics
        });
      });

      evaluatedTickets.sort((a, b) => b.score - a.score);
      this.legs = prevSlip;

      return evaluatedTickets[0]?.legs || [];
    }

    // ==========================================
    // 2. STRATEGY: BEST VALUE (+EV GUARDRAILS)
    // ==========================================
    const targetPayoutRanges = {
      2: { min: 220, max: 400 },
      3: { min: 450, max: 750 },
      4: { min: 850, max: 1400 },
      5: { min: 1500, max: 2800 }
    };
    const targetRange = targetPayoutRanges[legsCount] || { min: 200, max: 2000 };

    // Step A: Pre-Filtered SGP Candidate Pool
    // 1. Symmetrical Moneyline Cap: Limit ML between -200 and +175
    // 2. Spread Substitution: Prioritize Point Spreads (Favorite or Underdog) with Totals
    const validSgpPairs = [];
    weekData.games.forEach(g => {
      const gameLegs = buildLegsForGame(g);
      const spreadLegs = gameLegs.filter(l => l.marketCategory === 'spread');
      const totalLegs = gameLegs.filter(l => l.marketCategory === 'total');
      const mlLegs = gameLegs.filter(l => l.marketCategory === 'moneyline' && l.bookOdds >= -200 && l.bookOdds <= 175);

      // Primary: Point Spread (Spread Substitution) + Total
      spreadLegs.forEach(sp => {
        totalLegs.forEach(tot => {
          this.legs = [sp, tot];
          const sim = this.runSyncSimulation(slateData, 3000);
          const analytics = this.calculateAnalytics(sim, slateData);

          if (analytics.correlationBoostPct >= 0.3) {
            validSgpPairs.push({
              pair: [sp, tot],
              gameId: g.id,
              boostPct: analytics.correlationBoostPct,
              evPct: analytics.expectedValuePct,
              winProbPct: analytics.simWinProbPct,
              odds: analytics.effectiveAmericanOdds
            });
          }
        });
      });

      // Secondary: Moderate Moneyline (-200 to +175) + Total
      mlLegs.forEach(ml => {
        totalLegs.forEach(tot => {
          this.legs = [ml, tot];
          const sim = this.runSyncSimulation(slateData, 3000);
          const analytics = this.calculateAnalytics(sim, slateData);

          if (analytics.correlationBoostPct >= 0.3) {
            validSgpPairs.push({
              pair: [ml, tot],
              gameId: g.id,
              boostPct: analytics.correlationBoostPct,
              evPct: analytics.expectedValuePct,
              winProbPct: analytics.simWinProbPct,
              odds: analytics.effectiveAmericanOdds
            });
          }
        });
      });
    });

    validSgpPairs.sort((a, b) => b.evPct - a.evPct);

    // Step B: Multi-Leg Vig Minimization (Distinct Games for 3+ leg tickets)
    const independentCandidates = [];
    weekData.games.forEach(g => {
      const gameLegs = buildLegsForGame(g);
      gameLegs.forEach(leg => {
        if (leg.marketCategory === 'moneyline') {
          if (leg.bookOdds >= -200 && leg.bookOdds <= 175) {
            independentCandidates.push(leg);
          }
        } else if (leg.marketCategory === 'spread' || leg.marketCategory === 'total') {
          independentCandidates.push(leg);
        }
      });
    });

    // Step C: EV / Edge Maximization with Realistic Payout Scoring
    const candidateTickets = [];

    if (legsCount === 2) {
      validSgpPairs.forEach(sp => candidateTickets.push(sp.pair));
    } else {
      const topPairs = validSgpPairs.slice(0, 10);
      topPairs.forEach(sgp => {
        const pairGameId = sgp.gameId;
        const otherGameLegs = independentCandidates.filter(l => l.gameId !== pairGameId);
        const needed = legsCount - 2;

        const gamesMap = new Map();
        otherGameLegs.forEach(l => {
          if (!gamesMap.has(l.gameId)) gamesMap.set(l.gameId, []);
          gamesMap.get(l.gameId).push(l);
        });

        const gameIds = Array.from(gamesMap.keys());
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

        const gameCombos = getCombinations(gameIds, needed).slice(0, 8);
        gameCombos.forEach(gCombo => {
          const additionalLegs = gCombo.map(gid => {
            const legsForG = gamesMap.get(gid);
            return legsForG.find(l => l.marketCategory === 'spread') || legsForG[0];
          });

          candidateTickets.push([...sgp.pair, ...additionalLegs]);
        });
      });
    }

    const evaluatedTickets = [];
    candidateTickets.forEach(tLegs => {
      this.legs = tLegs;
      const sim = this.runSyncSimulation(slateData, 3000);
      const analytics = this.calculateAnalytics(sim, slateData);

      if (analytics.correlationBoostPct >= 0.25) {
        const odds = analytics.effectiveAmericanOdds;
        let rangePenalty = 0;
        if (odds < targetRange.min) {
          rangePenalty = Math.abs(targetRange.min - odds) * 0.15;
        } else if (odds > targetRange.max) {
          rangePenalty = Math.abs(odds - targetRange.max) * 0.15;
        }

        const totalScore = analytics.expectedValuePct - rangePenalty;

        evaluatedTickets.push({
          legs: tLegs,
          evPct: analytics.expectedValuePct,
          boostPct: analytics.correlationBoostPct,
          winProbPct: analytics.simWinProbPct,
          odds: analytics.effectiveAmericanOdds,
          totalScore,
          analytics
        });
      }
    });

    evaluatedTickets.sort((a, b) => b.totalScore - a.totalScore);
    this.legs = prevSlip;

    if (evaluatedTickets.length > 0) {
      return evaluatedTickets[0].legs;
    }

    // Fallback if no valid SGP combinations
    const fallback = [];
    const usedGames = new Set();
    for (const leg of independentCandidates) {
      if (fallback.length >= legsCount) break;
      if (!usedGames.has(leg.gameId)) {
        fallback.push(leg);
        usedGames.add(leg.gameId);
      }
    }
    return fallback;
  }
}
