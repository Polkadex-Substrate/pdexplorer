// Runs test files in parallel (one `node --test` per file, one worker per core)
// and stops at the FIRST failing file. Exit 1 on any failure, 0 if all pass.
// A killed mutant needs a single red test; there is no reason to wait for the
// other hundred files once it has appeared.
//   node tools/lib/first-fail.mjs test/a.test.js test/b.test.js ...
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const files = process.argv.slice(2);
const live = new Set();
let next = 0, failed = false, running = 0;

function done(code) {
  for (const c of live) c.kill('SIGKILL');
  process.exit(code);
}
function pump() {
  while (!failed && running < availableParallelism() && next < files.length) {
    const child = spawn('node', ['--experimental-sqlite', '--test', files[next++]], { stdio: 'ignore' });
    live.add(child); running++;
    child.on('exit', (code) => {
      live.delete(child); running--;
      if (code !== 0 && !failed) { failed = true; done(1); }
      else if (next >= files.length && running === 0) done(0);
      else pump();
    });
  }
}
if (!files.length) done(0);
pump();
