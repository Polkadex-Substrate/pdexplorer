// Mutation harness for the round-2 server.js PARTIAL residuals.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const M = [
  ['email.js', 'maskEmail(opts.to)}', 'opts.to}', 'F-090 disabled-provider line logs the raw address again'],
  ['email.js', "return 'sha256:' + createHash('sha256')", "return v.slice(0, 6) + '…'; return 'sha256:' + createHash('sha256')", 'F-090 mask becomes a truncation, which is still identifying'],
  ['server.js', 'catch (err) {\n        return null;\n    }\n}\n\n// Compress polkadot', 'catch (err) {\n        return Date.now();\n    }\n}\n\n// Compress polkadot', 'F-114 fabricated timestamp is back'],
  ['server.js', "if (!EVENTS_STRICT) return { rewards: [], ok: true };\n            db.recordScanFailure('staking_rewards', blockNumber,\n                'events could not be decoded at this height (F-006)');\n            return { rewards: [], ok: false };", "return { rewards: [], ok: true };", 'F-006 reward scanner calls an undecoded block clean again'],
  ['server.js', 'code: \'PRUNED_STATE\'', 'code: \'INTERNAL\'', 'F-084 pruned case loses its distinct code'],
  ['server.js', "            error: `Block ${at.block} is outside this node's pruning window. Historical state requires an archive node — see /developers for how to point a client at one.`,", "            error: msg,", 'F-084 raw err.message back on the wire'],
  ['db.js', "return { validators, totalCount: s.totalCount ?? validators.length, lastSync: s.lastSync ?? 0, status: s.status ?? 'Initializing' };", "return { validators, totalCount: s.totalCount ?? validators.length, lastSync: s.lastSync ?? 0, status: s.status ?? 'Initializing', error: s.error };", 'F-084 indexer error back on a cached 200'],
  ['server.js', 'if (cached && Array.isArray(cached.series) && cached.series.length) {', 'if (cached && cached.series) {', 'F-081 empty series cached at the edge again'],
  ['server.js', 'const asked = Number(params[1]);', 'const asked = Number(params[0]);', 'F-077 clamp reads the prefix instead of the count'],
  ['server.js', 'params[1] = RPC_MAX_PAGE;\n                clampedPageSize = RPC_MAX_PAGE;', 'clampedPageSize = RPC_MAX_PAGE;', 'F-077 clamp computed but not applied'],
  ['server.js', "db.consumeRateLimit('label-write', signer", "db.consumeRateLimit('label-write', String(Math.random())", 'F-075 label cooldown keyed on nothing'],
  ['server.js', 'balanceReserved: reserved, balanceFrozen: frozen,', 'balanceReserved: reserved, balanceFrozen: reserved,', 'F-136 frozen aliased to reserved again'],
  ['server.js', 'const gated = gateAddressParams(req, res, \'address\');\n    if (!gated) return;\n    try {\n        const address = gated.address;', 'try {\n        const address = req.params.address.trim();', 'F-082 validator route takes the raw param again'],
  ['server.js', 'const restartPath = WORKERS > 1', 'const restartPath = false', 'F-144 watchdog promises the wrong restart path'],
  ['lib/api-reference.js', 'the nonce is NOT sent', 'submit { address, signature, nonce }', 'F-152 docs ask for a field the server ignores'],
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
