// Shared test-runner for the tools/mutation-*.mjs harnesses.
//
// Each harness used to run the WHOLE suite after every mutant, and a mutant
// that is caught (the normal, wanted outcome) only needs ONE failing test. With
// about 90 mutants and a suite of 100+ files that was the entire cost of the
// CI "mutation" job.
//
// Same verdicts as before, reached faster:
//   0. Files run in parallel and the run stops at the first red file.
//   1. Run only the test files that mention the mutated file (by path, or by
//      module name for lib/ files). If any of them fails, the mutant is KILLED.
//      A failure in a subset is a failure in the full suite, so this can only
//      ever return a kill that the full run would also return.
//   2. If that subset stays green, fall back to the FULL suite before calling
//      the mutant a survivor. A test that catches a mutation without naming the
//      mutated file (a shell-out, a fixture, a doc check) is still found, so no
//      survivor is ever declared on the strength of the subset alone.
//
// THE FLAG IS LOAD-BEARING. node:sqlite arrived in Node 22.5.0 behind
// --experimental-sqlite and was unflagged in 22.13.0. The Dockerfiles and CI
// pin 22.11, where it is REQUIRED. Without it every test run dies at import,
// the grep for '# fail 0' never matches, and EVERY mutant is reported KILLED -
// a harness that can only return success. Verified against a real 22.11.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

import { restoreStaleBackups } from './restore-bak.mjs';

const FIRST_FAIL = new URL('./first-fail.mjs', import.meta.url).pathname;

// Local escape hatch only (CI never sets it): a regex of test paths to leave out,
// for a machine whose Node differs from the pinned 22.11, e.g.
//   MUTATION_EXCLUDE_TESTS=node-version-contract node tools/mutation-wallet.mjs
const EXCLUDE = process.env.MUTATION_EXCLUDE_TESTS ? new RegExp(process.env.MUTATION_EXCLUDE_TESTS) : null;

function listTests(dir = 'test') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTests(p));
    else if (e.name.endsWith('.test.js') && !(EXCLUDE && EXCLUDE.test(p))) out.push(p);
  }
  return out;
}

let cache = null;
function testsMentioning(file) {
  if (!cache) cache = listTests().map((p) => [p, readFileSync(p, 'utf8')]);
  const base = basename(file);
  const needles = file.startsWith('lib/') ? [file, base.replace(/\.js$/, '')] : [file, base];
  return cache.filter(([, src]) => needles.some((n) => src.includes(n))).map(([p]) => p);
}

// Throws when the suite does not pass cleanly (mutant killed); returns when it
// does (mutant survived).
export function suiteMustPass(mutatedFile) {
  const run = (files) => {
    try { return execFileSync('node', [FIRST_FAIL, ...files], { stdio: 'pipe' }); }
    catch (e) {
      // The child died from a signal (Ctrl-C, CI cancel): this is not a kill.
      // Put the tree back and stop, never record a verdict.
      if (e && (e.signal === 'SIGINT' || e.signal === 'SIGTERM')) {
        restoreStaleBackups();
        process.exit(e.signal === 'SIGINT' ? 130 : 143);
      }
      throw e;
    }
  };
  const subset = testsMentioning(mutatedFile);
  if (subset.length) run(subset);
  run(listTests());
}

// A previous run that was killed mid-mutant leaves <file>.bak holding the
// ORIGINAL. Restore it before anything copies the (mutated) file over it, then
// install handlers so this run cannot leave a mutated tree either.
restoreStaleBackups();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreStaleBackups(); process.exit(sig === 'SIGINT' ? 130 : 143); });
}
process.on('uncaughtException', (e) => { console.error(e); restoreStaleBackups(); process.exit(1); });
process.on('exit', () => restoreStaleBackups());

// A red baseline makes every mutant look KILLED (the trap described above,
// reached by a different road). ES imports run before the harness body, so
// this checks the UNMUTATED tree once, before the first file is rewritten.
try {
  execFileSync('node', [FIRST_FAIL, ...listTests()], { stdio: 'pipe' });
} catch {
  console.error('BASELINE RED: the unmutated suite fails, so every mutant verdict would be meaningless.');
  process.exit(2);
}
