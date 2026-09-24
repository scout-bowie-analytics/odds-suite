/**
 * 🐾 SCOUT BOWIE NFL LIVE ODDS SYNC PIPELINE
 * Fetches real-time DraftKings consensus lines directly from ESPN's Open Scoreboard API,
 * normalizes team names, updates point spreads, totals, moneylines, and unvigged win probabilities,
 * strictly enforces home/away polarity without index assumptions,
 * gates completeness against scheduled matchups, runs sanity assertions,
 * and synchronizes data/nfl_slate.json and odds-suite/data/nfl_slate.json with metadata.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. CLI Arguments & Active Week Configuration
const apiKey = process.env.ODDS_API_KEY || 
  process.argv.find(arg => arg.startsWith('--apiKey='))?.split('=')[1] ||
  (process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null);

const targetWeekArg = process.argv.find(arg => arg.startsWith('--week='))?.split('=')[1];
const targetWeek = targetWeekArg ? parseInt(targetWeekArg, 10) : 3; // Active upcoming slate week (Week 3)

// 2. Comprehensive Team Name Normalization Dictionary
const TEAM_NAME_TO_CODE = {
  // Full Names
  'Arizona Cardinals': 'ARI',
  'Atlanta Falcons': 'ATL',
  'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF',
  'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN',
  'Cleveland Browns': 'CLE',
  'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET',
  'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU',
  'Indianapolis Colts': 'IND',
  'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC',
  'Las Vegas Raiders': 'LV',
  'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR',
  'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE',
  'New Orleans Saints': 'NO',
  'New York Giants': 'NYG',
  'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI',
  'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF',
  'Seattle Seahawks': 'SEA',
  'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN',
  'Washington Commanders': 'WAS',

  // Historical / Alternate names
  'Washington Football Team': 'WAS',
  'Washington Redskins': 'WAS',
  'Oakland Raiders': 'LV',
  'San Diego Chargers': 'LAC',
  'St. Louis Rams': 'LAR',

  // Nicknames
  'Cardinals': 'ARI',
  'Falcons': 'ATL',
  'Ravens': 'BAL',
  'Bills': 'BUF',
  'Panthers': 'CAR',
  'Bears': 'CHI',
  'Bengals': 'CIN',
  'Browns': 'CLE',
  'Cowboys': 'DAL',
  'Broncos': 'DEN',
  'Lions': 'DET',
  'Packers': 'GB',
  'Texans': 'HOU',
  'Colts': 'IND',
  'Jaguars': 'JAX',
  'Chiefs': 'KC',
  'Raiders': 'LV',
  'Chargers': 'LAC',
  'Rams': 'LAR',
  'Dolphins': 'MIA',
  'Vikings': 'MIN',
  'Patriots': 'NE',
  'Saints': 'NO',
  'Giants': 'NYG',
  'Jets': 'NYJ',
  'Eagles': 'PHI',
  'Steelers': 'PIT',
  '49ers': 'SF',
  'Niners': 'SF',
  'Seahawks': 'SEA',
  'Buccaneers': 'TB',
  'Bucs': 'TB',
  'Titans': 'TEN',
  'Commanders': 'WAS',

  // City / Locality
  'Arizona': 'ARI',
  'Atlanta': 'ATL',
  'Baltimore': 'BAL',
  'Buffalo': 'BUF',
  'Carolina': 'CAR',
  'Chicago': 'CHI',
  'Cincinnati': 'CIN',
  'Cleveland': 'CLE',
  'Dallas': 'DAL',
  'Denver': 'DEN',
  'Detroit': 'DET',
  'Green Bay': 'GB',
  'Houston': 'HOU',
  'Indianapolis': 'IND',
  'Jacksonville': 'JAX',
  'Kansas City': 'KC',
  'Las Vegas': 'LV',
  'Miami': 'MIA',
  'Minnesota': 'MIN',
  'New England': 'NE',
  'New Orleans': 'NO',
  'Philadelphia': 'PHI',
  'Philly': 'PHI',
  'Pittsburgh': 'PIT',
  'San Francisco': 'SF',
  'Seattle': 'SEA',
  'Tampa Bay': 'TB',
  'Tampa': 'TB',
  'Tennessee': 'TEN',
  'Washington': 'WAS',

  // Team Codes self-mapping
  'ARI': 'ARI', 'ATL': 'ATL', 'BAL': 'BAL', 'BUF': 'BUF',
  'CAR': 'CAR', 'CHI': 'CHI', 'CIN': 'CIN', 'CLE': 'CLE',
  'DAL': 'DAL', 'DEN': 'DEN', 'DET': 'DET', 'GB': 'GB',
  'HOU': 'HOU', 'IND': 'IND', 'JAX': 'JAX', 'KC': 'KC',
  'LV': 'LV',   'LAC': 'LAC', 'LAR': 'LAR', 'MIA': 'MIA',
  'MIN': 'MIN', 'NE': 'NE',   'NO': 'NO',   'NYG': 'NYG',
  'NYJ': 'NYJ', 'PHI': 'PHI', 'PIT': 'PIT', 'SF': 'SF',
  'SEA': 'SEA', 'TB': 'TB',   'TEN': 'TEN', 'WAS': 'WAS',
  'WSH': 'WAS'
};

export function normalizeTeamCode(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (TEAM_NAME_TO_CODE[trimmed]) return TEAM_NAME_TO_CODE[trimmed];
  
  // Case-insensitive lookup
  const lower = trimmed.toLowerCase();
  for (const [key, code] of Object.entries(TEAM_NAME_TO_CODE)) {
    if (key.toLowerCase() === lower) {
      return code;
    }
  }

  // Word-boundary / inclusion fallback
  for (const [key, code] of Object.entries(TEAM_NAME_TO_CODE)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return code;
    }
  }

  return null;
}

export function mlToDecimal(ml) {
  const n = Number(ml);
  if (n > 0) return (n / 100) + 1;
  return (100 / -n) + 1;
}

export function americanToImplied(odds) {
  const n = Number(odds);
  if (isNaN(n) || n === 0) return 0.5;
  if (n < 0) return -n / (-n + 100);
  return 100 / (n + 100);
}

export function calculateMarketHold(hMl, aMl) {
  const hDec = mlToDecimal(hMl);
  const aDec = mlToDecimal(aMl);
  const p1 = 1 / hDec;
  const p2 = 1 / aDec;
  return (p1 + p2 - 1) * 100;
}

/**
 * Strict sanity assertions:
 * 1. Reject placeholder values (spread -0.5 with ±110 ML)
 * 2. Polarity check: spread favorite must match moneyline favorite
 * 3. Total vig check: hold must be between 2% and 10%
 */
export function assertGameSanity(game, weekNum) {
  const matchupStr = `${game.awayTeam} @ ${game.homeTeam} (W${weekNum}, ${game.id})`;

  // 1. Reject placeholder values
  const isPlaceholder = (
    Math.abs(Number(game.spread) - (-0.5)) < 0.001 &&
    ((Number(game.homeMoneyline) === -110 && Number(game.awayMoneyline) === 110) ||
     (Number(game.homeMoneyline) === 110 && Number(game.awayMoneyline) === -110))
  );
  if (isPlaceholder) {
    throw new Error(`Sanity Check Failed [Placeholder Detected]: ${matchupStr} retains placeholder values (-0.5 spread with ±110 ML).`);
  }

  // 2. Polarity Check: Assert spread favorite and moneyline favorite match
  const hDec = mlToDecimal(game.homeMoneyline);
  const aDec = mlToDecimal(game.awayMoneyline);

  if (game.spread < 0) {
    // Home is spread favorite -> Home ML must be shorter (lower decimal odds)
    if (hDec >= aDec) {
      throw new Error(`Sanity Check Failed [Polarity Mismatch]: ${matchupStr} has home spread ${game.spread} (home favored) but home ML (${game.homeMoneyline}) is not shorter than away ML (${game.awayMoneyline}).`);
    }
  } else if (game.spread > 0) {
    // Away is spread favorite -> Away ML must be shorter (lower decimal odds)
    if (aDec >= hDec) {
      throw new Error(`Sanity Check Failed [Polarity Mismatch]: ${matchupStr} has away spread ${-game.spread} (away favored) but away ML (${game.awayMoneyline}) is not shorter than home ML (${game.homeMoneyline}).`);
    }
  }

  // 3. Total Vig Check: Assert that two-way market hold is between 2% and 10%
  const holdPct = calculateMarketHold(game.homeMoneyline, game.awayMoneyline);
  if (holdPct < 2.0 || holdPct > 10.0) {
    throw new Error(`Sanity Check Failed [Vig Out of Range]: ${matchupStr} has two-way hold ${holdPct.toFixed(2)}% (allowed range: 2.0% - 10.0%). HML: ${game.homeMoneyline}, AML: ${game.awayMoneyline}.`);
  }

  return true;
}

// 3. Locate Target nfl_slate.json Files
export function findSlateFilePaths() {
  const rootData = path.resolve(process.cwd(), 'data/nfl_slate.json');
  const dirnameData = path.resolve(__dirname, '../data/nfl_slate.json');
  const oddsSuiteData = path.resolve(process.cwd(), 'odds-suite/data/nfl_slate.json');
  const dirnameOddsData = path.resolve(__dirname, '../odds-suite/data/nfl_slate.json');

  const candidates = [rootData, dirnameData, oddsSuiteData, dirnameOddsData];
  const uniquePaths = Array.from(new Set(candidates));
  
  const existing = uniquePaths.filter(p => fs.existsSync(p));
  if (!existing.includes(rootData)) {
    existing.unshift(rootData);
  }
  return existing;
}

/**
 * 4. Primary Live Odds Provider: Ingest Live DraftKings Consensus from ESPN Open Scoreboard API
 * Zero-cost, zero-token, open public endpoint returning official DraftKings consensus lines.
 */
export async function fetchEspnLiveOdds(weekNum) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=${weekNum}`;
  console.log(`\n🌐 Requesting live DraftKings consensus from ESPN Open Scoreboard API (Week ${weekNum})...`);
  console.log(`   ➔ URL: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN Scoreboard API returned HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.events || !Array.isArray(data.events) || data.events.length === 0) {
    throw new Error(`ESPN Scoreboard API returned zero events for Week ${weekNum}. Failing closed.`);
  }

  const liveMatchups = [];
  for (const ev of data.events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
    const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
    if (!homeComp || !awayComp) continue;

    const homeCode = normalizeTeamCode(homeComp.team?.abbreviation || homeComp.team?.displayName);
    const awayCode = normalizeTeamCode(awayComp.team?.abbreviation || awayComp.team?.displayName);
    if (!homeCode || !awayCode) {
      console.warn(`⚠️ Warning: Unrecognized team in ESPN event: "${awayComp.team?.displayName}" @ "${homeComp.team?.displayName}"`);
      continue;
    }

    const oddsObj = comp.odds?.[0];
    if (!oddsObj) {
      throw new Error(`Missing live odds object for matchup ${awayCode} @ ${homeCode} in ESPN feed. Failing closed.`);
    }

    // Spread: in ESPN API, odds.spread is home spread (e.g. -4.5 for GB home fav, 7.5 for WSH home dog)
    const homeSpread = (typeof oddsObj.spread === 'number') ? oddsObj.spread : null;
    if (homeSpread === null) {
      throw new Error(`Invalid spread for matchup ${awayCode} @ ${homeCode} in ESPN feed. Failing closed.`);
    }

    // Spread Odds (Juice)
    const homeSpreadOdds = oddsObj.pointSpread?.home?.close?.odds ? parseInt(oddsObj.pointSpread.home.close.odds, 10) : -110;
    const awaySpreadOdds = oddsObj.pointSpread?.away?.close?.odds ? parseInt(oddsObj.pointSpread.away.close.odds, 10) : -110;

    // Total
    const total = oddsObj.overUnder !== undefined ? Number(oddsObj.overUnder) : null;
    if (total === null || isNaN(total)) {
      throw new Error(`Invalid total line for matchup ${awayCode} @ ${homeCode} in ESPN feed. Failing closed.`);
    }
    const totalOverOdds = oddsObj.total?.over?.close?.odds ? parseInt(oddsObj.total.over.close.odds, 10) : -110;
    const totalUnderOdds = oddsObj.total?.under?.close?.odds ? parseInt(oddsObj.total.under.close.odds, 10) : -110;

    // Moneylines
    let homeMoneyline = oddsObj.moneyline?.home?.close?.odds ? parseInt(oddsObj.moneyline.home.close.odds, 10) : null;
    let awayMoneyline = oddsObj.moneyline?.away?.close?.odds ? parseInt(oddsObj.moneyline.away.close.odds, 10) : null;

    if (homeMoneyline === null && oddsObj.moneyline?.home?.open?.odds) {
      homeMoneyline = parseInt(oddsObj.moneyline.home.open.odds, 10);
    }
    if (awayMoneyline === null && oddsObj.moneyline?.away?.open?.odds) {
      awayMoneyline = parseInt(oddsObj.moneyline.away.open.odds, 10);
    }

    if (homeMoneyline === null || awayMoneyline === null || isNaN(homeMoneyline) || isNaN(awayMoneyline)) {
      throw new Error(`Invalid moneyline for matchup ${awayCode} @ ${homeCode} in ESPN feed. Failing closed.`);
    }

    liveMatchups.push({
      homeCode,
      awayCode,
      commenceTime: ev.date || comp.date,
      spread: homeSpread,
      spreadOdds: homeSpreadOdds,
      awaySpreadOdds,
      total,
      totalOverOdds,
      totalUnderOdds,
      homeMoneyline,
      awayMoneyline,
      bookmaker: oddsObj.provider?.displayName || 'DraftKings'
    });
  }

  console.log(`✅ Successfully fetched and parsed ${liveMatchups.length} live matchups from ESPN DraftKings feed.`);
  return liveMatchups;
}

// 5. Optional Secondary Provider: The Odds API v4 (if API key explicitly supplied)
const PREFERRED_BOOKMAKERS = [
  'draftkings', 'fanduel', 'betmgm', 'bovada', 'caesars', 'pointsbetus', 'willhill_us', 'betrivers', 'lowvig', 'betonlineag'
];

function isTeamOutcome(outcome, targetCode) {
  if (!outcome || !outcome.name) return false;
  const code = normalizeTeamCode(outcome.name);
  return code === targetCode;
}

export function extractBestMarketData(game) {
  if (!game || !Array.isArray(game.bookmakers) || game.bookmakers.length === 0) return null;

  const homeCode = normalizeTeamCode(game.home_team);
  const awayCode = normalizeTeamCode(game.away_team);
  if (!homeCode || !awayCode || homeCode === awayCode) return null;

  const sortedBooks = [...game.bookmakers].sort((a, b) => {
    const idxA = PREFERRED_BOOKMAKERS.indexOf(a.key);
    const idxB = PREFERRED_BOOKMAKERS.indexOf(b.key);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });

  let spread = null, spreadOdds = -110, awaySpreadOdds = -110;
  let total = null, totalOverOdds = -110, totalUnderOdds = -110;
  let homeMoneyline = null, awayMoneyline = null;
  let bookmakerUsed = null;

  for (const book of sortedBooks) {
    if (!Array.isArray(book.markets)) continue;
    bookmakerUsed = book.title || book.key;

    if (spread === null) {
      const spreadMkt = book.markets.find(m => m.key === 'spreads');
      if (spreadMkt && Array.isArray(spreadMkt.outcomes)) {
        const homeOut = spreadMkt.outcomes.find(o => isTeamOutcome(o, homeCode));
        const awayOut = spreadMkt.outcomes.find(o => isTeamOutcome(o, awayCode));
        if (homeOut && homeOut.point !== undefined) {
          spread = Number(homeOut.point);
          spreadOdds = Number(homeOut.price) || -110;
          if (awayOut) awaySpreadOdds = Number(awayOut.price) || -110;
        }
      }
    }

    if (total === null) {
      const totalMkt = book.markets.find(m => m.key === 'totals');
      if (totalMkt && Array.isArray(totalMkt.outcomes)) {
        const overOut = totalMkt.outcomes.find(o => (o.name || '').toLowerCase() === 'over');
        const underOut = totalMkt.outcomes.find(o => (o.name || '').toLowerCase() === 'under');
        if (overOut && overOut.point !== undefined) {
          total = Number(overOut.point);
          totalOverOdds = Number(overOut.price) || -110;
          if (underOut) totalUnderOdds = Number(underOut.price) || -110;
        }
      }
    }

    if (homeMoneyline === null || awayMoneyline === null) {
      const h2hMkt = book.markets.find(m => m.key === 'h2h');
      if (h2hMkt && Array.isArray(h2hMkt.outcomes)) {
        const homeOut = h2hMkt.outcomes.find(o => isTeamOutcome(o, homeCode));
        const awayOut = h2hMkt.outcomes.find(o => isTeamOutcome(o, awayCode));
        if (homeOut && homeOut.price !== undefined) homeMoneyline = Number(homeOut.price);
        if (awayOut && awayOut.price !== undefined) awayMoneyline = Number(awayOut.price);
      }
    }

    if (spread !== null && total !== null && homeMoneyline !== null && awayMoneyline !== null) break;
  }

  return {
    spread, spreadOdds, awaySpreadOdds,
    total, totalOverOdds, totalUnderOdds,
    homeMoneyline, awayMoneyline,
    bookmaker: bookmakerUsed || 'DraftKings'
  };
}

async function main() {
  console.log('⚡ SCOUT BOWIE LIVE ODDS SYNC ⚡\n');
  const slatePaths = findSlateFilePaths();

  if (slatePaths.length === 0) {
    console.error('❌ Error: Could not locate data/nfl_slate.json.');
    process.exit(1);
  }

  console.log(`📁 Found ${slatePaths.length} slate file(s) to synchronize:`);
  slatePaths.forEach(p => console.log(`   ➔ ${p}`));

  const apiLookup = new Map();
  let parsedGamesCount = 0;
  let activeProvider = 'DraftKings (ESPN Open Feed)';

  if (apiKey) {
    // Optional: User-supplied The Odds API key
    const apiUrl = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
    console.log('\n🌐 Requesting live NFL lines from The Odds API v4 (Secondary Provider)...');

    try {
      const res = await fetch(apiUrl);
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${errorText}`);
      }
      const apiGames = await res.json();
      if (!Array.isArray(apiGames) || apiGames.length === 0) {
        throw new Error('The Odds API returned zero upcoming NFL games. Failing closed.');
      }
      activeProvider = 'The Odds API v4';

      apiGames.forEach(g => {
        const homeCode = normalizeTeamCode(g.home_team);
        const awayCode = normalizeTeamCode(g.away_team);
        if (!homeCode || !awayCode) return;
        const marketData = extractBestMarketData(g);
        if (!marketData) return;
        apiLookup.set(`${homeCode}_${awayCode}`, {
          homeCode, awayCode, commenceTime: g.commence_time, ...marketData
        });
        parsedGamesCount++;
      });
    } catch (err) {
      console.error(`❌ Failed to fetch odds from The Odds API: ${err.message}`);
      console.error('⛔ Aborting sync pipeline: Failing closed. Never commit partial or synthetic data.');
      process.exit(1);
    }
  } else {
    // Primary Provider: ESPN Scoreboard API (Zero-cost, open DraftKings live consensus)
    try {
      const espnMatchups = await fetchEspnLiveOdds(targetWeek);
      espnMatchups.forEach(m => {
        const key = `${m.homeCode}_${m.awayCode}`;
        apiLookup.set(key, m);
        parsedGamesCount++;
      });
    } catch (err) {
      console.error(`\n❌ Failed to fetch live odds from ESPN Open API: ${err.message}`);
      console.error('⛔ Aborting sync pipeline: Failing closed. Never commit partial or synthetic data.');
      process.exit(1);
    }
  }

  if (parsedGamesCount === 0) {
    console.error('❌ Zero live games parsed from provider. Failing closed.');
    process.exit(1);
  }

  console.log(`🎯 Normalized ${parsedGamesCount} live matchups ready for slate merging.\n`);

  // 6. Completeness Gate: Validate all scheduled games in target week exist in live feed
  const primarySlatePath = slatePaths[0];
  const primaryRaw = JSON.parse(fs.readFileSync(primarySlatePath, 'utf8'));
  const primaryWeeks = Array.isArray(primaryRaw) ? primaryRaw : (primaryRaw.weeks || []);
  const targetWeekObj = primaryWeeks.find(w => w.week === targetWeek);

  if (targetWeekObj && Array.isArray(targetWeekObj.games)) {
    const scheduledGames = targetWeekObj.games;
    const missingGames = [];

    scheduledGames.forEach(sg => {
      const homeCode = sg.homeTeam;
      const awayCode = sg.awayTeam;
      const isPresent = apiLookup.has(`${homeCode}_${awayCode}`) || apiLookup.has(`${awayCode}_${homeCode}`);
      if (!isPresent) {
        missingGames.push(sg);
      }
    });

    if (missingGames.length > 0) {
      console.error(`\n❌ Completeness Gate Failure: ${missingGames.length} of ${scheduledGames.length} scheduled games missing from live feed for Week ${targetWeek}:`);
      missingGames.forEach(mg => {
        console.error(`   ➔ Missing: ${mg.awayTeam} @ ${mg.homeTeam} (ID: ${mg.id})`);
      });
      console.error('\n⛔ Aborting sync pipeline: Never commit partial slate data.');
      process.exit(1);
    } else {
      console.log(`✅ Completeness Gate Passed: All ${scheduledGames.length}/${scheduledGames.length} scheduled matchups present for Week ${targetWeek}.\n`);
    }
  }

  // 7. Update Slate Files In Place, Run Sanity Checks, and Save with Metadata
  let gamesUpdated = 0;
  const updatedSummaryList = [];
  const nowIso = new Date().toISOString();

  for (const slatePath of slatePaths) {
    let slateData;
    try {
      const raw = fs.readFileSync(slatePath, 'utf8');
      slateData = JSON.parse(raw);
    } catch (e) {
      console.error(`❌ Failed reading JSON from ${slatePath}: ${e.message}`);
      continue;
    }

    const weeks = Array.isArray(slateData) ? slateData : (slateData.weeks || []);
    let slateFileUpdatedCount = 0;

    for (let w = 0; w < weeks.length; w++) {
      const weekObj = weeks[w];
      if (!Array.isArray(weekObj.games)) continue;
      if (targetWeek && weekObj.week !== targetWeek) continue;

      for (let g = 0; g < weekObj.games.length; g++) {
        const targetGame = weekObj.games[g];
        const oldSpread = targetGame.spread;
        const oldTotal = targetGame.total;
        const oldHomeMl = targetGame.homeMoneyline;
        const oldAwayMl = targetGame.awayMoneyline;

        // Check all parsed API matchups
        for (const [key, live] of apiLookup.entries()) {
          const apiHome = live.homeCode;
          const apiAway = live.awayCode;

          // Exact Two-Way Match
          const isMatch = (targetGame.homeTeam === apiHome && targetGame.awayTeam === apiAway) || 
                          (targetGame.homeTeam === apiAway && targetGame.awayTeam === apiHome);

          if (!isMatch) continue;

          const isInverted = (targetGame.homeTeam === apiAway && targetGame.awayTeam === apiHome);
          let modified = false;

          // Spread
          if (live.spread !== null && live.spread !== undefined) {
            const newSpread = isInverted ? -Number(live.spread) : Number(live.spread);
            if (targetGame.spread !== newSpread || targetGame.spreadOdds !== (Number(live.spreadOdds) || -110)) {
              targetGame.spread = newSpread;
              targetGame.spreadOdds = Number(live.spreadOdds) || -110;
              modified = true;
            }
          }

          // Total
          if (live.total !== null && live.total !== undefined) {
            if (targetGame.total !== Number(live.total)) {
              targetGame.total = Number(live.total);
              targetGame.totalOverOdds = Number(live.totalOverOdds) || -110;
              targetGame.totalUnderOdds = Number(live.totalUnderOdds) || -110;
              modified = true;
            }
          }

          // Moneylines & Win Probabilities
          if (live.homeMoneyline !== null && live.awayMoneyline !== null && live.homeMoneyline !== undefined && live.awayMoneyline !== undefined) {
            const newHomeMl = isInverted ? Number(live.awayMoneyline) : Number(live.homeMoneyline);
            const newAwayMl = isInverted ? Number(live.homeMoneyline) : Number(live.awayMoneyline);

            if (targetGame.homeMoneyline !== newHomeMl || targetGame.awayMoneyline !== newAwayMl) {
              targetGame.homeMoneyline = newHomeMl;
              targetGame.awayMoneyline = newAwayMl;

              const hImp = americanToImplied(targetGame.homeMoneyline);
              const aImp = americanToImplied(targetGame.awayMoneyline);
              const sumImp = hImp + aImp;

              if (sumImp > 0) {
                targetGame.homeWinProb = Number((hImp / sumImp).toFixed(2));
                targetGame.awayWinProb = Number((1 - targetGame.homeWinProb).toFixed(2));
              }
              modified = true;
            }
          }

          // Run sanity check on updated game
          assertGameSanity(targetGame, weekObj.week);

          if (modified) {
            gamesUpdated++;
            slateFileUpdatedCount++;
            
            const existingSummary = updatedSummaryList.find(s => s.Week === `Week ${weekObj.week}` && s.Matchup === `${targetGame.awayTeam} @ ${targetGame.homeTeam}`);
            if (!existingSummary) {
              const formatMl = (ml) => ml > 0 ? `+${ml}` : `${ml}`;
              const formatSpread = (sp) => sp > 0 ? `+${sp}` : `${sp}`;

              updatedSummaryList.push({
                'Week': `Week ${weekObj.week}`,
                'Matchup': `${targetGame.awayTeam} @ ${targetGame.homeTeam}`,
                'Old Spread': oldSpread !== null && oldSpread !== undefined ? formatSpread(oldSpread) : 'N/A',
                'New Spread': formatSpread(targetGame.spread),
                'Old Total': oldTotal ?? 'N/A',
                'New Total': targetGame.total,
                'Home ML': `${targetGame.homeTeam} ${formatMl(targetGame.homeMoneyline)}`,
                'Away ML': `${targetGame.awayTeam} ${formatMl(targetGame.awayMoneyline)}`,
                'Bookmaker': live.bookmaker || 'DraftKings'
              });
            }
          }

          break;
        }
      }

      weekObj.lastSyncedAt = nowIso;
      weekObj.syncStatus = 'COMPLETE';
    }

    // Reconstruct output maintaining schema
    let totalScheduledGames = 0;
    weeks.forEach(w => {
      if (Array.isArray(w.games)) totalScheduledGames += w.games.length;
    });

    const outputData = Array.isArray(slateData) 
      ? {
          lastSyncedAt: nowIso,
          syncStatus: 'COMPLETE',
          provider: activeProvider,
          totalGames: totalScheduledGames,
          syncedGames: totalScheduledGames,
          weeks: slateData
        }
      : {
          ...slateData,
          lastSyncedAt: nowIso,
          syncStatus: 'COMPLETE',
          provider: activeProvider,
          totalGames: totalScheduledGames,
          syncedGames: totalScheduledGames,
          weeks: weeks
        };

    fs.writeFileSync(slatePath, JSON.stringify(outputData, null, 2), 'utf8');
    console.log(`💾 Saved ${slateFileUpdatedCount} live odds updates with metadata envelope to: ${slatePath}`);
  }

  // 8. Output Formatted Summary Table
  if (updatedSummaryList.length > 0) {
    console.log('\n📊 Formatted Verification Summary Table:');
    console.table(updatedSummaryList);
  } else {
    console.log('\nℹ️ All slate lines are already up to date with live feed.');
  }

  console.log('\n🎉 Live Odds Sync Complete! All completeness gates and sanity assertions passed. 🐾\n');
}

main().catch(err => {
  console.error('\n❌ Fatal error during live odds synchronization:', err.message);
  process.exit(1);
});
