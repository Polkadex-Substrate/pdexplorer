// Sprint 7 B1: test/walletconnect.test.js exits on its own, so plain `npm test`
// ends without --test-force-exit.
//
// The cause was two end-to-end tests that leave a tracked transaction at
// "broadcast" (the fake node answers Ready and nothing more): lib/tx-submit.js
// keeps its 90 s pre-inclusion cap and its 18 s chain-check watchdog running
// until the transaction settles, so the file held the process open for 90 s and
// more after its last test. The fake api now has a close() that fires its
// 'disconnected' listeners, as a real connection does when the explorer closes
// it, and each test closes its api when it ends.
//
// Run as a child process without --test-force-exit; it must exit by itself,
// well inside the cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('./walletconnect.test.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIMIT_MS = 45_000;

test('test/walletconnect.test.js exits on its own, all tests passing, well before the 90 s cap', async () => {
    const started = Date.now();
    // Its own run, not a subtest of this one: without NODE_TEST_CONTEXT, with the TAP reporter.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--experimental-sqlite', '--test', '--test-reporter=tap', FILE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; if (out.length > 200_000) out = out.slice(-100_000); });
    child.stderr.on('data', () => {});
    const result = await new Promise((resolve) => {
        const kill = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, timedOut: true }); }, LIMIT_MS);
        child.on('exit', (code) => { clearTimeout(kill); resolve({ code, timedOut: false }); });
    });
    const took = Date.now() - started;
    assert.equal(result.timedOut, false, `still running after ${LIMIT_MS} ms: an open handle (timer, socket or provider) keeps the process alive`);
    assert.equal(result.code, 0, 'the file failed:\n' + out.split('\n').filter(l => /^# (tests|pass|fail)|^not ok/.test(l)).join('\n'));
    assert.match(out, /^# fail 0$/m);
    assert.ok(took < LIMIT_MS, `took ${took} ms`);
});
