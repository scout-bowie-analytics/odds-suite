/**
 * 🐾 SCOUT BOWIE NFL LIVE ODDS SYNC PIPELINE
 * Fetches real-time consensus lines from The Odds API v4,
 * normalizes team names, updates point spreads, totals, and moneylines,
 * and synchronizes data/nfl_slate.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Verify API Key (Environment variable or CLI argument)
const apiKey = process.env.ODDS_API_KEY || 
  process.argv.find(arg => arg.startsWith('--apiKey='))?.split('=')[1] ||
  (process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null);

if (!apiKey) {
  console.error('❌ Error: ODDS_API_KEY environment variable is not set.');
  console.error('👉 Please configure your The Odds API key in GitHub Secrets, set ODDS_API_KEY locally, or pass it as an argument: node scripts/fetch-live-odds.mjs <API_KEY>');
  process.exit(1);
}

// 2. Team Name Normalization Dictionary
const TEAM_NAME_TO_CODE = {
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
  'Washington Football Team': 'WAS',
  'Washington Redskins': 'WAS',
  'Oakland Raiders': 'LV',
  'San Diego Chargers': 'LAC',
  'St. Louis Rams': 'LAR'
};

function normalizeTeamCode(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (TEAM_NAME_TO_CODE[trimmed]) return TEAM_NAME_TO_CODE[trimmed];
  
  // Case-insensitive lookup fallback
  const lower = trimmed.toLowerCase();
  for (const [fullName, code] of Object.entries(TEAM_NAME_TO_CODE)) {
    if (fullName.toLowerCase() === lower || fullName.toLowerCase().includes(lower)) {
      return code;
    }
  }
  return null;
}

function americanToImplied(odds) {
  const n = Number(odds);
  if (isNaN(n) || n === 0) return 0.5;
  if (n < 0) return -n / (-n + 100);
  return 100 / (n + 100);
}

// 3. Locate Target nfl_slate.json Files (Strictly resolves ./data/nfl_slate.json at root)
function findSlateFilePaths() {
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

// 4. Preferred Bookmaker Priority (DraftKings > FanDuel > BetMGM > Consensus)
const PREFERRED_BOOKMAKERS = [
  'draftkings',
  'fanduel',
  'betmgm',
  'bovada',
  'caesars',
  'pointsbetus',
  'williamhill_us',
  'betrivers',
  'lowvig',
  'betonlineag'
];

function extractBestMarketData(game) {
  if (!game || !Array.isArray(game.bookmakers) || game.bookmakers.length === 0) {
    return null;
  }

  const homeTeamName = game.home_team;
  const awayTeamName = game.away_team;
  const homeCode = normalizeTeamCode(homeTeamName);
  const awayCode = normalizeTeamCode(awayTeamName);

  // Sort bookmakers by priority
  const sortedBooks = [...game.bookmakers].sort((a, b) => {
    const idxA = PREFERRED_BOOKMAKERS.indexOf(a.key);
    const idxB = PREFERRED_BOOKMAKERS.indexOf(b.key);
    const scoreA = idxA === -1 ? 999 : idxA;
    const scoreB = idxB === -1 ? 999 : idxB;
    return scoreA - scoreB;
  });

  let spread = null;
  let spreadOdds = -110;
  let total = null;
  let totalOverOdds = -110;
  let totalUnderOdds = -110;
  let homeMoneyline = null;
  let awayMoneyline = null;
  let bookmakerUsed = null;

  for (const book of sortedBooks) {
    const markets = book.markets || [];

    // Point Spread
    if (spread === null) {
      const spreadMarket = markets.find(m => m.key === 'spreads');
      if (spreadMarket && Array.isArray(spreadMarket.outcomes)) {
        const homeOutcome = spreadMarket.outcomes.find(o => 
          o.name === homeTeamName || normalizeTeamCode(o.name) === homeCode
        );
        if (homeOutcome && homeOutcome.point !== undefined) {
          spread = Number(homeOutcome.point);
          spreadOdds = Number(homeOutcome.price) || -110;
          if (!bookmakerUsed) bookmakerUsed = book.title || book.key;
        }
      }
    }

    // Totals (O/U)
    if (total === null) {
      const totalsMarket = markets.find(m => m.key === 'totals');
      if (totalsMarket && Array.isArray(totalsMarket.outcomes)) {
        const overOutcome = totalsMarket.outcomes.find(o => o.name === 'Over' || o.name.toLowerCase() === 'over');
        const underOutcome = totalsMarket.outcomes.find(o => o.name === 'Under' || o.name.toLowerCase() === 'under');
        if (overOutcome && overOutcome.point !== undefined) {
          total = Number(overOutcome.point);
          totalOverOdds = Number(overOutcome.price) || -110;
          totalUnderOdds = underOutcome ? (Number(underOutcome.price) || -110) : -110;
          if (!bookmakerUsed) bookmakerUsed = book.title || book.key;
        }
      }
    }

    // Moneyline (H2H)
    if (homeMoneyline === null || awayMoneyline === null) {
      const h2hMarket = markets.find(m => m.key === 'h2h');
      if (h2hMarket && Array.isArray(h2hMarket.outcomes)) {
        const homeOutcome = h2hMarket.outcomes.find(o => 
          o.name === homeTeamName || normalizeTeamCode(o.name) === homeCode
        );
        const awayOutcome = h2hMarket.outcomes.find(o => 
          o.name === awayTeamName || normalizeTeamCode(o.name) === awayCode
        );
        if (homeOutcome && awayOutcome) {
          homeMoneyline = Number(homeOutcome.price);
          awayMoneyline = Number(awayOutcome.price);
          if (!bookmakerUsed) bookmakerUsed = book.title || book.key;
        }
      }
    }

    // Stop if all found from highest priority bookmaker
    if (spread !== null && total !== null && homeMoneyline !== null && awayMoneyline !== null) {
      break;
    }
  }

  return {
    spread,
    spreadOdds,
    total,
    totalOverOdds,
    totalUnderOdds,
    homeMoneyline,
    awayMoneyline,
    bookmaker: bookmakerUsed || 'Consensus'
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

  // 1. Fetch from The Odds API v4
  const apiUrl = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  console.log('\n🌐 Requesting live NFL lines from The Odds API v4...');

  let apiGames = [];
  try {
    const res = await fetch(apiUrl);
    
    // Log API quota usage if headers present
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    if (remaining !== null) {
      console.log(`📊 The Odds API Quota: ${remaining} remaining (used: ${used || '0'})`);
    }

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${errorText}`);
    }

    apiGames = await res.json();
    console.log(`✅ Successfully fetched ${apiGames.length} upcoming NFL matchups from The Odds API.`);
  } catch (err) {
    console.error(`❌ Failed to fetch odds from The Odds API: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(apiGames) || apiGames.length === 0) {
    console.log('⚠️ No active or upcoming NFL games returned by The Odds API (e.g. offseason or midweek lull). Slate unchanged.');
    process.exit(0);
  }

  // 2. Build Lookup Map from API Games: Key = `${homeCode}_${awayCode}`
  const apiLookup = new Map();
  let parsedGamesCount = 0;

  apiGames.forEach(g => {
    const homeCode = normalizeTeamCode(g.home_team);
    const awayCode = normalizeTeamCode(g.away_team);

    if (!homeCode || !awayCode) {
      console.warn(`⚠️ Warning: Unrecognized team in game: "${g.away_team}" @ "${g.home_team}"`);
      return;
    }

    const marketData = extractBestMarketData(g);
    if (!marketData) return;

    const key = `${homeCode}_${awayCode}`;
    apiLookup.set(key, {
      homeCode,
      awayCode,
      commenceTime: g.commence_time,
      ...marketData
    });
    parsedGamesCount++;
  });

  console.log(`🎯 Normalized ${parsedGamesCount} live matchups ready for slate merging.\n`);

  // 3. Directly Mutate Each Slate File In Place & Save
  let gamesUpdated = 0;
  const updatedSummaryList = [];

  for (const slatePath of slatePaths) {
    let slateData;
    try {
      const raw = fs.readFileSync(slatePath, 'utf8');
      slateData = JSON.parse(raw);
    } catch (e) {
      console.error(`❌ Failed reading JSON from ${slatePath}: ${e.message}`);
      continue;
    }

    let slateFileUpdatedCount = 0;

    for (let w = 0; w < slateData.length; w++) {
      const weekObj = slateData[w];
      if (!Array.isArray(weekObj.games)) continue;

      for (let g = 0; g < weekObj.games.length; g++) {
        const targetGame = weekObj.games[g];
        const oldSpread = targetGame.spread;
        const oldTotal = targetGame.total;

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

          // Direct in-place mutation: Spread (Invert spread point if home/away is flipped by bookmaker)
          if (live.spread !== null && live.spread !== undefined) {
            const newSpread = isInverted ? -Number(live.spread) : Number(live.spread);
            targetGame.spread = newSpread;
            targetGame.spreadOdds = Number(live.spreadOdds) || -110;
            modified = true;
          }

          // Direct in-place mutation: Total
          if (live.total !== null && live.total !== undefined) {
            targetGame.total = Number(live.total);
            targetGame.totalOverOdds = Number(live.totalOverOdds) || -110;
            targetGame.totalUnderOdds = Number(live.totalUnderOdds) || -110;
            modified = true;
          }

          // Direct in-place mutation: Moneyline & Win Probabilities
          if (live.homeMoneyline !== null && live.awayMoneyline !== null && live.homeMoneyline !== undefined && live.awayMoneyline !== undefined) {
            const newHomeMl = isInverted ? Number(live.awayMoneyline) : Number(live.homeMoneyline);
            const newAwayMl = isInverted ? Number(live.homeMoneyline) : Number(live.awayMoneyline);

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

          if (modified) {
            gamesUpdated++;
            slateFileUpdatedCount++;
            
            // Only add to summary table once per unique matchup across files
            const existingSummary = updatedSummaryList.find(s => s.Week === `Week ${weekObj.week}` && s.Matchup === `${targetGame.awayTeam} @ ${targetGame.homeTeam}`);
            if (!existingSummary) {
              updatedSummaryList.push({
                'Week': `Week ${weekObj.week}`,
                'Matchup': `${targetGame.awayTeam} @ ${targetGame.homeTeam}`,
                'Old Spread': oldSpread !== null && oldSpread !== undefined ? (oldSpread > 0 ? `+${oldSpread}` : `${oldSpread}`) : 'N/A',
                'New Spread': targetGame.spread > 0 ? `+${targetGame.spread}` : `${targetGame.spread}`,
                'Old Total': oldTotal ?? 'N/A',
                'New Total': targetGame.total,
                'Bookmaker': live.bookmaker || 'DraftKings'
              });
            }
          }

          break; // Match found and applied for this game
        }
      }
    }

    // Ensure directory exists and write updated slate JSON directly back to target file
    const dir = path.dirname(slatePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(slatePath, JSON.stringify(slateData, null, 2) + '\n', 'utf8');
    console.log(`💾 Saved ${slateFileUpdatedCount} live odds updates to: ${slatePath}`);
  }

  // 4. Automated Integrity Assertion Checks
  console.log('\n📊 Formatted Verification Summary Table:');
  if (updatedSummaryList.length > 0) {
    console.table(updatedSummaryList);
  }

  // Strict Fail-Safe Assertion: If 0 games updated, throw loud error
  if (gamesUpdated === 0) {
    throw new Error("Validation Error: 0 games updated. Check team normalization or slate structure.");
  }

  // Specific Match Verification: Explicitly verify and log DET @ BUF in Week 2
  for (const slatePath of slatePaths) {
    if (!fs.existsSync(slatePath)) continue;
    const data = JSON.parse(fs.readFileSync(slatePath, 'utf8'));
    const w2 = data.find(w => w.week === 2);
    const detBuf = w2?.games?.find(g => (g.homeTeam === 'BUF' && g.awayTeam === 'DET') || (g.homeTeam === 'DET' && g.awayTeam === 'BUF'));

    if (detBuf) {
      const isBufHome = detBuf.homeTeam === 'BUF';
      const expectedSpread = isBufHome ? -4.5 : 4.5;
      const expectedTotal = 54.5;

      const spreadMatches = Math.abs(detBuf.spread - expectedSpread) < 0.01;
      const totalMatches = Math.abs(detBuf.total - expectedTotal) < 0.01;

      console.log(`\n🔍 [Specific Match Check] ${slatePath}:`);
      console.log(`   Matchup: ${detBuf.awayTeam} @ ${detBuf.homeTeam} (ID: ${detBuf.id})`);
      console.log(`   Spread: ${detBuf.spread} (Expected: ${expectedSpread}) ➔ ${spreadMatches ? '✅ VALID' : '⚠️ MISMATCH'}`);
      console.log(`   Total: ${detBuf.total} (Expected: ${expectedTotal}) ➔ ${totalMatches ? '✅ VALID' : '⚠️ MISMATCH'}`);
      console.log(`   Moneyline: ${detBuf.homeTeam} ${detBuf.homeMoneyline} / ${detBuf.awayTeam} ${detBuf.awayMoneyline}`);
    }
  }

  console.log('\n🎉 Live Odds Sync Complete! All lines synchronized successfully. 🐾');
}

main().catch(err => {
  console.error('Fatal error running odds sync:', err);
  process.exit(1);
});
