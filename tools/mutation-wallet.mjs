// Mutation harness for the F-055 / F-056 wallet-signing residuals.
// Funds-adjacent code: a survivor here means a reverted fix ships unnoticed.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const M = [
  ['script.js', 'const tx = await buildTx(globalApi);', 'const tx = buildTx(globalApi);',
   'F-056 buildTx not awaited — async builder hands a Promise to signAndSend'],
  ['script.js', 'const candidates = await api.query[councilPalletName].candidates();',
   'const candidates = [];',
   'F-056 witness count no longer read from the chain'],
  ['script.js', 'if (entries.length > PAYOUT_BATCH_MAX && errEl) {', 'if (false && errEl) {',
   'F-055 modal stops disclosing the cap before signing'],
  ['script.js', 'const PAYOUT_BATCH_MAX = 30;', 'const PAYOUT_BATCH_MAX = 1000;',
   'F-055 cap raised past the weight limit'],
  ['script.js',
   'if (api.tx.utility && api.tx.utility.forceBatch) return api.tx.utility.forceBatch(calls);\n    if (api.tx.utility && api.tx.utility.batch) return api.tx.utility.batch(calls);\n    if (api.tx.utility && api.tx.utility.batchAll) return api.tx.utility.batchAll(calls);',
   'if (api.tx.utility && api.tx.utility.batchAll) return api.tx.utility.batchAll(calls);\n    if (api.tx.utility && api.tx.utility.forceBatch) return api.tx.utility.forceBatch(calls);\n    if (api.tx.utility && api.tx.utility.batch) return api.tx.utility.batch(calls);',
   'F-055 batchAll preferred again — one AlreadyClaimed reverts every payout'],
  ['lib/help-topics.js', 'one <code>utility.forceBatch</code> transaction', 'a single <code>utility.batch</code> transaction',
   'F-055 help article back to describing utility.batch'],
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
