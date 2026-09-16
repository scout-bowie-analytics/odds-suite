/**
 * 🐾 SCOUT BOWIE UNIFIED DATA CONTRACTS & UTILITIES (v3.8.0)
 * Centralized data normalization, schemas, odds conversions, and push settlement
 * shared across Survivor, Pick'em, and Parlay engines.
 */

// ==========================================
// 1. ODDS CONVERSION & FORMATTING UTILITIES
// ==========================================

export const OddsUtils = {
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
  },

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
  },

  /**
   * Convert American odds to implied probability
   */
  americanToImpliedProb(american) {
    const dec = this.americanToDecimal(american);
    return dec > 0 ? 1 / dec : 0;
  },

  /**
   * Convert Probability (0.0 to 1.0) to Decimal odds
   */
  probToDecimal(prob) {
    const p = Math.max(0.0001, Math.min(0.9999, Number(prob)));
    return 1 / p;
  },

  /**
   * Convert Probability to Fair American odds
   */
  probToAmerican(prob) {
    return this.decimalToAmerican(this.probToDecimal(prob));
  },

  /**
   * Format American odds with explicit plus sign
   */
  formatAmerican(odds) {
    const num = Number(odds);
    if (isNaN(num)) return '—';
    return num > 0 ? `+${num}` : `${num}`;
  },

  /**
   * Format point spread with explicit sign
   */
  formatSpread(spread) {
    const num = Number(spread);
    if (isNaN(num)) return '—';
    return num > 0 ? `+${num}` : `${num}`;
  },

  /**
   * Check if a line value is a flat whole number (push-eligible)
   */
  isFlatLine(lineValue) {
    const num = Number(lineValue);
    if (isNaN(num)) return false;
    return Math.abs(num % 1) === 0;
  }
};

// ==========================================
// 2. UNIFIED GAME CONTRACT NORMALIZER
// ==========================================

/**
 * Standardizes a raw game object from nfl_slate.json into a strictly typed contract
 */
export function normalizeGame(rawGame, week = 1) {
  if (!rawGame) return null;

  const targetWeek = Number(week) || Number(rawGame.week) || 1;
  const homeTeam = String(rawGame.homeTeam || '').trim();
  const awayTeam = String(rawGame.awayTeam || '').trim();
  const homeTeamName = String(rawGame.homeTeamName || homeTeam).trim();
  const awayTeamName = String(rawGame.awayTeamName || awayTeam).trim();

  const spread = Number(rawGame.spread || 0);
  const awaySpread = -spread;
  const total = Number(rawGame.total || 44.0);

  const homeWinProb = Math.max(0.01, Math.min(0.99, Number(rawGame.homeWinProb ?? 0.50)));
  const awayWinProb = Math.max(0.01, Math.min(0.99, Number(rawGame.awayWinProb ?? (1 - homeWinProb))));

  const isHomeFav = homeWinProb >= 0.50;
  const favTeam = isHomeFav ? homeTeam : awayTeam;
  const dogTeam = isHomeFav ? awayTeam : homeTeam;

  const homeMoneyline = Number(rawGame.homeMoneyline ?? (isHomeFav ? -150 : 130));
  const awayMoneyline = Number(rawGame.awayMoneyline ?? (isHomeFav ? 130 : -150));

  const spreadOdds = Number(rawGame.spreadOdds ?? -110);
  const totalOverOdds = Number(rawGame.totalOverOdds ?? -110);
  const totalUnderOdds = Number(rawGame.totalUnderOdds ?? -110);

  const homePickPct = Number(rawGame.homePickPct ?? 0.05);
  const awayPickPct = Number(rawGame.awayPickPct ?? 0.05);

  const isFlatSpread = OddsUtils.isFlatLine(spread);
  const isFlatTotal = OddsUtils.isFlatLine(total);

  return {
    id: rawGame.id || `${targetWeek}_${awayTeam}_${homeTeam}`,
    week: targetWeek,
    homeTeam,
    awayTeam,
    homeTeamName,
    awayTeamName,
    matchup: `${awayTeam} @ ${homeTeam}`,
    // Spreads
    spread,
    awaySpread,
    spreadFormatted: OddsUtils.formatSpread(spread),
    awaySpreadFormatted: OddsUtils.formatSpread(awaySpread),
    isFlatSpread,
    spreadOdds,
    // Totals
    total,
    isFlatTotal,
    totalOverOdds,
    totalUnderOdds,
    // Moneylines & Probabilities
    homeMoneyline,
    awayMoneyline,
    homeWinProb,
    awayWinProb,
    homePickPct,
    awayPickPct,
    isHomeFav,
    favTeam,
    dogTeam,
    byes: Array.isArray(rawGame.byes) ? rawGame.byes : []
  };
}

// ==========================================
// 3. UNIFIED BET SLIP LEG FACTORY
// ==========================================

/**
 * Creates a standardized bet slip leg object for spreads, totals, or moneylines
 */
export function createBetLeg(game, category, selection, customProps = {}) {
  const normGame = normalizeGame(game, game.week);
  if (!normGame) return null;

  const { id: gameId, week, homeTeam, awayTeam, spread, awaySpread, total, spreadOdds, totalOverOdds, totalUnderOdds, homeMoneyline, awayMoneyline, homeWinProb, awayWinProb, favTeam, dogTeam } = normGame;

  let legId = '';
  let marketType = '';
  let lineValue = null;
  let bookOdds = -110;
  let label = '';
  let winProb = 0.50;
  let isFlatLine = false;

  switch (category) {
    case 'spread': {
      const isHome = selection === homeTeam;
      const effectiveSpread = isHome ? spread : awaySpread;
      const formattedSpread = isHome ? normGame.spreadFormatted : normGame.awaySpreadFormatted;
      legId = `${gameId}_spread_${selection}`;
      marketType = 'spread';
      lineValue = effectiveSpread;
      bookOdds = spreadOdds;
      label = `${selection} ${formattedSpread}`;
      winProb = (isHome ? homeWinProb : awayWinProb) >= 0.5 ? 0.52 : 0.48;
      isFlatLine = OddsUtils.isFlatLine(effectiveSpread);
      break;
    }

    case 'total': {
      const isOver = selection.toUpperCase() === 'OVER';
      legId = `${gameId}_total_${isOver ? 'over' : 'under'}`;
      marketType = isOver ? 'total_over' : 'total_under';
      lineValue = total;
      bookOdds = isOver ? totalOverOdds : totalUnderOdds;
      label = `${isOver ? 'OVER' : 'UNDER'} ${total}`;
      winProb = 0.50;
      isFlatLine = OddsUtils.isFlatLine(total);
      break;
    }

    case 'moneyline': {
      const isHome = selection === homeTeam;
      legId = `${gameId}_ml_${selection}`;
      marketType = 'moneyline';
      lineValue = null;
      bookOdds = isHome ? homeMoneyline : awayMoneyline;
      label = `${selection} ML`;
      winProb = isHome ? homeWinProb : awayWinProb;
      isFlatLine = false;
      break;
    }

    default:
      throw new Error(`Unsupported market category: ${category}`);
  }

  const isUnderdog = selection === dogTeam;
  const isFavorite = selection === favTeam;

  return {
    id: legId,
    gameId,
    week,
    homeTeam,
    awayTeam,
    team: selection,
    selection,
    isUnderdog,
    isFavorite,
    marketType,
    marketCategory: category,
    lineValue,
    bookOdds,
    label,
    matchup: normGame.matchup,
    winProb,
    isFlatLine,
    ...customProps
  };
}

// ==========================================
// 4. MULTI-OUTCOME PUSH SETTLEMENT ENGINE
// ==========================================

/**
 * Evaluate an individual leg against a simulated scoreline
 * Returns: 'WIN' | 'PUSH' | 'LOSS'
 */
export function evaluateLegOutcome(leg, simScore) {
  if (!simScore) return 'LOSS';

  switch (leg.marketCategory) {
    case 'spread': {
      const isHome = leg.selection === leg.homeTeam;
      const effectiveSpread = Number(leg.lineValue);
      const teamScore = isHome ? simScore.homeScore : simScore.awayScore;
      const oppScore = isHome ? simScore.awayScore : simScore.homeScore;
      const finalDiff = (teamScore + effectiveSpread) - oppScore;

      if (finalDiff > 0) return 'WIN';
      if (finalDiff === 0) return 'PUSH';
      return 'LOSS';
    }

    case 'moneyline': {
      const isHome = leg.selection === leg.homeTeam;
      const teamScore = isHome ? simScore.homeScore : simScore.awayScore;
      const oppScore = isHome ? simScore.awayScore : simScore.homeScore;

      if (teamScore > oppScore) return 'WIN';
      if (teamScore === oppScore) return 'PUSH'; // Tie
      return 'LOSS';
    }

    case 'total': {
      const totalLine = Number(leg.lineValue);
      const diff = simScore.totalScore - totalLine;

      if (leg.marketType === 'total_over') {
        if (diff > 0) return 'WIN';
        if (diff === 0) return 'PUSH';
        return 'LOSS';
      } else {
        if (diff < 0) return 'WIN';
        if (diff === 0) return 'PUSH';
        return 'LOSS';
      }
    }

    default:
      return 'WIN';
  }
}

/**
 * Resolve an entire parlay ticket across an iteration with realistic American push rules:
 * - Any LOSS -> Ticket returns 0.0x (total loss)
 * - All PUSH -> Ticket refunds 1.0x (original stake returned)
 * - Pushes + Wins -> Parlay payout reduces to product of winning legs' multipliers
 * - All WIN -> Full parlay multiplier payout
 */
export function resolveParlayTicketIteration(legs, simScores) {
  if (!Array.isArray(legs) || legs.length === 0) {
    return { outcome: 'FULL_WIN', returnMultiplier: 1.0, winCount: 0, pushCount: 0, lossCount: 0 };
  }

  let winCount = 0;
  let pushCount = 0;
  let lossCount = 0;
  let reducedDecimalOdds = 1.0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const outcome = evaluateLegOutcome(leg, simScores[leg.gameId]);

    if (outcome === 'LOSS') {
      lossCount++;
      return {
        outcome: 'LOSS',
        returnMultiplier: 0.0,
        winCount,
        pushCount,
        lossCount
      };
    } else if (outcome === 'PUSH') {
      pushCount++;
      // Pushed leg multiplier is 1.0 (refund / no juice added)
    } else if (outcome === 'WIN') {
      winCount++;
      reducedDecimalOdds *= OddsUtils.americanToDecimal(leg.bookOdds);
    }
  }

  // All legs pushed: 100% stake refund
  if (pushCount === legs.length) {
    return {
      outcome: 'ALL_PUSH',
      returnMultiplier: 1.0,
      winCount: 0,
      pushCount,
      lossCount: 0
    };
  }

  // Some legs won and some pushed: reduced parlay
  if (pushCount > 0 && winCount > 0) {
    return {
      outcome: 'REDUCED_WIN',
      returnMultiplier: reducedDecimalOdds,
      winCount,
      pushCount,
      lossCount: 0
    };
  }

  // All legs won
  return {
    outcome: 'FULL_WIN',
    returnMultiplier: reducedDecimalOdds,
    winCount,
    pushCount: 0,
    lossCount: 0
  };
}
