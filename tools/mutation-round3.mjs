// Mutation harness for round 3 (F-196..F-200).
//
// Three of the five are defects in my own round-2 remediation, so these mutants
// mostly revert a fix to the exact broken form the audit found.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const M = [
  // F-196
  // F-203 changed the VALUE from null to postPurgeBackfillCursor(st), so the
  // old mutation string stopped existing and this silently became a SKIP —
  // a mutant that cannot be applied proves nothing, and the count still read
  // "0 survived". Re-pointed at the current text.
  ['db.js', 'txBackfillCursor: postPurgeBackfillCursor(st),\n                        txBackfillComplete: false',
   'backfillCursor: postPurgeBackfillCursor(st),\n                        backfillComplete: false',
   'F-196 purge resets keys the scanner does not read (the original bug)'],
  // F-203 itself: hand over null and the reader coerces it to 0, never walks.
  ['db.js', 'txBackfillCursor: postPurgeBackfillCursor(st),', 'txBackfillCursor: null,',
   'F-203 purge hands over null; first-run turns it into 0 and skips the walk'],
  // F-203 second half: the coercion that made the first-run branch dead code.
  ['server.js', '(state.txBackfillCursor === null || state.txBackfillCursor === undefined)',
   'Number.isFinite(Number(state.txBackfillCursor)) && false || false ? 0 : (false)',
   'F-203 Number(null)===0 makes the first-run branch unreachable'],
  // F-202: governance null-events recording nothing.
  ['server.js', "db.recordScanFailure('governance', blockNumber,", "void (0) && db.recordScanFailure('governance', blockNumber,",
   'F-202 governance null-events record nothing; watermark pins for ever'],
  // F-201: the Insights host-source back on the wallet origin.
  ['nginx.conf', "script-src 'self' 'wasm-unsafe-eval';",
   "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com;",
   'F-201 third-party script origin on the wallet-serving CSP'],
  ['db.js', '                        txBackfillComplete: false', '',
   'F-196 backfill-complete never cleared — deleted history not re-derived'],
  ['db.js', 'if (prior && !prior.resetVersion && Number(prior.deleted) > 0) {', 'if (false) {',
   'F-196 catch-up removed — a host the buggy build migrated is never repaired'],
  ['db.js', 'resetVersion: TX_PURGE_RESET_VERSION, repairedAt: Date.now()', 'repairedAt: Date.now()',
   'F-196 catch-up never stamps the flag — it replays on every boot'],
  // F-198
  ['lib/commission-history.js', 'return Number(row.stake) > 0;', 'return true;',
   'F-198 un-elected eras count as history again'],
  ['lib/commission-history.js', 'if (row.stake === undefined || row.stake === null) return true;', '',
   'F-198 rows without a stake column are silently dropped'],
  ['server.js', 'const commissions = activeEntries.map', 'const commissions = history.map',
   'F-198 scorecard commission stats read unfiltered history'],
  ['server.js', 'const chronologicalHistory = history.filter(wasElectedInEra).sort',
   'const chronologicalHistory = [...history].sort',
   'F-198 spike triggers fabricate a 0%→51% crossing again'],
  ['server.js', 'db.rebuildValidatorTriggers(getCommissionTriggers)', 'null',
   'F-198 stored fabricated triggers are never rebuilt'],
  // F-199
  ['server.js', 'const firstEra = Math.max(activeEra - historyDepthCap() + 1, 0);\n    const history = [];',
   'const firstEra = Math.max(activeEra - VALIDATOR_HISTORY_ERAS + 1, 0);\n    const history = [];',
   'F-199 detail-page fill walks past historyDepth again'],
  // F-197
  ['init-letsencrypt.sh', 'if [ -s "$cert_live" ]; then', 'if [ -d "$data_path" ]; then',
   'F-197 keep-existing guard tests the bind-mount parent again'],
  ['provision-ubuntu.sh', 'if [ -f ./init-letsencrypt.sh ]; then', 'if [ -x ./init-letsencrypt.sh ]; then',
   'F-197 provision gates on the executable bit (dead in a fresh checkout)'],
  // F-200
  ['tools/verify-deploy.sh', 'if python3 "$@"; then :; else fail "$label"; fi', 'python3 "$@" || true',
   'F-200 embedded check failures no longer propagate'],
  ['tools/verify-deploy.sh', '[ "$FAILED" -eq 0 ] || exit 1', '',
   'F-200 script exits 0 even when checks failed'],
  ['tools/verify-deploy.sh', '    sys.exit(1)   # F-200: must be non-zero, or the footer prints green over this',
   '    sys.exit(0)',
   'F-200 the enrichment check prints FAIL then returns success'],
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
