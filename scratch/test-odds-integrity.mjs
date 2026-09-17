import fs from 'fs';
import path from 'path';

console.log('================================================================');
console.log('TEST SUITE: 18-WEEK ODDS INTEGRITY & STRICT COMPLETENESS GATE');
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function mlToDecimal(ml) {
  const n = Number(ml);
  if (n > 0) return (n / 100) + 1;
  return (100 / -n) + 1;
}

function calculateHold(hMl, aMl) {
  const hDec = mlToDecimal(hMl);
  const aDec = mlToDecimal(aMl);
  return ((1 / hDec) + (1 / aDec) - 1) * 100;
}

const slateFiles = [
  'data/nfl_slate.json',
  'odds-suite/data/nfl_slate.json'
];

for (const relPath of slateFiles) {
  console.log(`\n📁 Inspecting Slate File: ${relPath}`);
  assert(fs.existsSync(relPath), `File exists: ${relPath}`);
  
  const raw = JSON.parse(fs.readFileSync(relPath, 'utf8'));
  
  // 1. Metadata Envelope Assertions
  assert(typeof raw === 'object' && raw !== null, 'Slate root is an object envelope');
  assert(typeof raw.lastSyncedAt === 'string' && !isNaN(Date.parse(raw.lastSyncedAt)), `lastSyncedAt is valid ISO timestamp (${raw.lastSyncedAt})`);
  assert(raw.syncStatus === 'COMPLETE', `syncStatus is 'COMPLETE' (got: ${raw.syncStatus})`);
  assert(typeof raw.totalGames === 'number' && raw.totalGames === 272, `totalGames is 272 (got: ${raw.totalGames})`);
  assert(raw.syncedGames === raw.totalGames, `syncedGames matches totalGames (${raw.syncedGames}/${raw.totalGames})`);

  const weeks = Array.isArray(raw) ? raw : (raw.weeks || []);
  assert(weeks.length === 18, `Slate contains all 18 weeks (got: ${weeks.length})`);

  let totalGamesChecked = 0;
  let placeholderFailures = 0;
  let polarityFailures = 0;
  let vigFailures = 0;

  for (let w = 1; w <= 18; w++) {
    const weekObj = weeks.find(wk => wk.week === w);
    assert(!!weekObj, `Week ${w} exists in slate`);
    if (!weekObj) continue;

    assert(Array.isArray(weekObj.games) && weekObj.games.length > 0, `Week ${w} has active games array`);
    assert(weekObj.syncStatus === 'COMPLETE', `Week ${w} syncStatus is 'COMPLETE'`);

    weekObj.games.forEach(g => {
      totalGamesChecked++;
      const matchup = `${g.awayTeam} @ ${g.homeTeam} (W${w}, ${g.id})`;

      // Sanity Check 1: No Placeholder values (-0.5 spread with ±110 ML)
      const isPlaceholder = (
        Math.abs(Number(g.spread) - (-0.5)) < 0.001 &&
        ((Number(g.homeMoneyline) === -110 && Number(g.awayMoneyline) === 110) ||
         (Number(g.homeMoneyline) === 110 && Number(g.awayMoneyline) === -110))
      );
      if (isPlaceholder) {
        placeholderFailures++;
        console.error(`     ❌ Placeholder detected: ${matchup}`);
      }

      // Sanity Check 2: Polarity Check (Spread favorite must match ML favorite)
      const hDec = mlToDecimal(g.homeMoneyline);
      const aDec = mlToDecimal(g.awayMoneyline);

      if (g.spread < 0) {
        // Home favorite: Home ML must be shorter (lower decimal odds)
        if (hDec >= aDec) {
          polarityFailures++;
          console.error(`     ❌ Polarity mismatch: ${matchup} home spread ${g.spread} but HML ${g.homeMoneyline} >= AML ${g.awayMoneyline}`);
        }
      } else if (g.spread > 0) {
        // Away favorite: Away ML must be shorter (lower decimal odds)
        if (aDec >= hDec) {
          polarityFailures++;
          console.error(`     ❌ Polarity mismatch: ${matchup} away spread ${-g.spread} but AML ${g.awayMoneyline} >= HML ${g.homeMoneyline}`);
        }
      }

      // Sanity Check 3: Total Vig Check (Two-way hold between 2% and 10%)
      const hold = calculateHold(g.homeMoneyline, g.awayMoneyline);
      if (hold < 2.0 || hold > 10.0) {
        vigFailures++;
        console.error(`     ❌ Vig out of range: ${matchup} hold=${hold.toFixed(2)}% (HML: ${g.homeMoneyline}, AML: ${g.awayMoneyline})`);
      }
    });
  }

  assert(totalGamesChecked === 272, `Total scheduled games checked: ${totalGamesChecked} / 272`);
  assert(placeholderFailures === 0, `Zero placeholder games found across all 18 weeks (${placeholderFailures} failures)`);
  assert(polarityFailures === 0, `Zero polarity mismatches found across all 18 weeks (${polarityFailures} failures)`);
  assert(vigFailures === 0, `All 272 games have two-way vig strictly between 2.0% and 10.0% (${vigFailures} failures)`);
}

// Summary Report
console.log('\n================================================================');
console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
console.log('================================================================');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 ALL 18 WEEKS SATISFY STRICT ODDS INTEGRITY & COMPLETENESS GATES! 🐾');
}
