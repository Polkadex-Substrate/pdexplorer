// Nobody may add `--test-force-exit` to the test command of package.json or to a CI workflow.
//
// Why: `node --test --test-force-exit` ends the run as soon as the last file reports, and in our sandbox
// runs it cut a test file short and still exited 0 (test/identity-cache.test.js: 49 of its 69 tests ran in
// some runs). A green run that skipped tests is worse than a red one. `npm test` and CI run WITHOUT the
// flag, so they wait for every test and a handle that keeps the process alive shows up as a hang, which
// is the signal to fix the leak (see test/walletconnect-exits.test.js), not to force the exit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = /--test-force-exit\b/;
export const WHY = 'node --test --test-force-exit can end the run before every test file has reported, and still exit 0 '
    + '(test/identity-cache.test.js ran 49 of its 69 tests in some runs). Run the suite WITHOUT it, as `npm test` does; '
    + 'if the process hangs, find the handle that stays open instead of forcing the exit.';

// Offences in package.json text: any string under "scripts" that carries the flag.
export function findInPackageJson(text) {
    const pkg = JSON.parse(text);
    return Object.entries(pkg.scripts || {})
        .filter(([, cmd]) => FLAG.test(String(cmd)))
        .map(([name, cmd]) => `package.json script "${name}": ${cmd}`);
}
// Offences in a workflow file: any non-comment line that carries the flag.
export function findInWorkflow(text, name = 'workflow') {
    const out = [];
    text.split('\n').forEach((line, i) => {
        const code = line.replace(/(^|\s)#.*$/, '');
        if (FLAG.test(code)) out.push(`${name}:${i + 1}: ${line.trim()}`);
    });
    return out;
}

describe('no --test-force-exit in the test command or in CI', () => {
    test('package.json scripts', () => {
        const found = findInPackageJson(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        assert.deepEqual(found, [], `${found.join('\n')}\n${WHY}`);
    });

    const dir = path.join(ROOT, '.github/workflows');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)) : [];
    test('there is at least one workflow to scan (the guard is not scanning nothing)', () => {
        assert.ok(files.length >= 1);
    });
    for (const f of files) {
        test(`.github/workflows/${f}`, () => {
            const found = findInWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'), f);
            assert.deepEqual(found, [], `${found.join('\n')}\n${WHY}`);
        });
    }

    test('the guard can fail: each place it scans, on a bad sample, and what it must allow', () => {
        assert.equal(findInPackageJson('{"scripts":{"test":"node --test --test-force-exit \\"test/*.test.js\\""}}').length, 1);
        assert.equal(findInPackageJson('{"scripts":{"a":"node --test","ci":"NODE_OPTIONS=x node --test --test-force-exit"}}').length, 1);
        assert.deepEqual(findInPackageJson('{"scripts":{"test":"node --experimental-sqlite --test \\"test/*.test.js\\""}}'), []);
        assert.equal(findInWorkflow('      - run: node --test --test-force-exit test/\n').length, 1);
        assert.equal(findInWorkflow('      - run: |\n          node --test \\\n            --test-force-exit test/\n').length, 1);
        assert.deepEqual(findInWorkflow('      # never add --test-force-exit here\n      - run: npm test\n'), []);
        assert.match(WHY, /WITHOUT it/);
    });

    test('the README testing section says why', () => {
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        assert.match(readme, /--test-force-exit/);
        assert.match(readme, /test\/no-force-exit\.test\.js/);
    });
});
