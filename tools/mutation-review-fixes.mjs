// Mutation harness for the fixes made in response to the adversarial review.
//
// These are repairs to my OWN remediation — the class of bug that is easiest to
// reintroduce, because the surrounding code already looks finished.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const M = [
  ['server.js',
   'const days = ANALYTICS_TS_RANGES.reduce(',
   'const days = askedDays; const _unused = ANALYTICS_TS_RANGES.reduce(',
   'analytics: arbitrary `days` again — unindexed GROUP BY per request'],
  ['server.js', 'if (cached && hasSeriesData(cached.series)) {',
   'if (cached && Array.isArray(cached.series) && cached.series.length) {',
   'analytics: cache guard assumes an array again — pre-warm never served, every request re-derives'],
  ['lib/series-shape.js', 'if (Array.isArray(value) ? value.length > 0 : false) return true;',
   'return false;',
   'series-shape: object-of-arrays no longer recognised as data'],
  ['lib/series-shape.js', 'if (Array.isArray(series)) return series.length > 0;',
   'if (Array.isArray(series)) return true;',
   'series-shape: an empty array counts as data (the original F-081 bug)'],
  // Re-pointed: the F-081 rework moved cacheShort below the series/flag
  // computation, so the old two-line target stopped existing and this mutant
  // silently became a SKIP while the summary still read "0 survived".
  ['server.js', "        cacheShort(res);\n\n        res.json({\n            days, requestedDays: askedDays, since: sinceTs,",
   "        res.set('Cache-Control', 'no-store');\n\n        res.json({\n            days, requestedDays: askedDays, since: sinceTs,",
   'analytics: fallthrough uncacheable again (the DoS I caused)'],
  ['server.js', 'repairCandidates = edgeForRepair.concat(gaps);', 'gaps = edgeForRepair.concat(gaps);',
   'edge holes double-counted into knownGapBlocks again'],
  ['server.js', 'const govUnverified = govFailCounts.total;',
   'const govUnverified = Math.max(0, headSeen - latestScannedBlock);',
   'governance reports an unverified SPAN as a block COUNT'],
  ['server.js', '            knownGapBlocks: rewardFailCounts.total,',
   '            knownGapBlocks: Math.max(0, headSeen - latestScannedBlock),',
   'staking reports an unverified SPAN as a block COUNT'],
  ['server.js', '                ...state,\n                initialized, headSeen, oldestScannedBlock',
   '                initialized, headSeen, oldestScannedBlock',
   'mid-tick checkpoint wipes coverage fields every tick'],
  ['db.js', 'export function requeueExhaustedScanFailures', 'export function _unusedRequeueExhausted',
   'no amnesty — one dead height pins the watermark forever'],
  ['server.js', 'setInterval(sweepExhaustedFailures, SCAN_AMNESTY_MS).unref();', '',
   'amnesty defined but never scheduled'],
  ['script.js', "if (status === 'Repairing') {", 'if (false) {',
   'Repairing renders as a red "Indexer error" again'],
  ['script.js', "if (status === 'Degraded') {", 'if (false) {',
   'Degraded renders as "will retry automatically" — it will not'],
  ['server.js', 'const bounded = Math.min(Math.max(Math.trunc(asked), 1), RPC_MAX_PAGE);',
   'const bounded = RPC_MAX_PAGE;',
   'page-size guard raises work for its most conservative input'],
];

let survived = 0, skipped = 0;
for (const [file, from, to, label] of M) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) { console.log(`SKIP     ${label}`); skipped++; continue; }
  copyFileSync(file, `${file}.bak`);
  writeFileSync(file, src.replace(from, to));
  let caught = false;
  try { execSync("node --test 'test/**/*.test.js' 2>&1 | grep -q '# fail 0'", { stdio: 'pipe' }); }
  catch { caught = true; }
  copyFileSync(`${file}.bak`, file); rmSync(`${file}.bak`, { force: true });
  if (caught) console.log(`KILLED   ${label}`);
  else { console.log(`SURVIVED ${label}   <-- NOT COVERED`); survived++; }
}
console.log(`\n${M.length} mutants: ${M.length - survived - skipped} killed, ${survived} survived, ${skipped} skipped`);
process.exit(survived ? 1 : 0);
