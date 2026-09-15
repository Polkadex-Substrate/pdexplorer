// The suite must run on the Node version we actually ship.
//
// WHAT HAPPENED
//
// CI was red for ten days on a failure that could not reproduce locally, and
// the reason is a three-line story:
//
//   * node:sqlite ARRIVED in Node 22.5.0 behind --experimental-sqlite, and was
//     unflagged in 22.13.0.
//   * The Dockerfiles and ci.yml pin 22.11 — inside that window, so the flag is
//     REQUIRED there.
//   * `npm test` was `node --test …` with no flag. On a developer machine
//     running >=22.13 that is fine. On 22.11 every one of the 16 test files
//     that opens a database dies with ERR_UNKNOWN_BUILTIN_MODULE.
//
// So the suite was green everywhere except the one environment that matches
// production. The comment in ci.yml even warned about this class of mismatch —
// while stating the version rule backwards ("behind a flag BEFORE 22.5"), which
// is precisely why nobody added the flag.
//
// The mutation harnesses had it worse. They shell out to the same flagless
// command and treat "tests did not print '# fail 0'" as "mutant killed". On
// 22.11 the baseline itself fails, so EVERY mutant reports killed — a harness
// that can only return success, reporting 90/90 while proving nothing.
//
// This file is the guard. It cannot run Node 22.11 to check behaviour, so it
// asserts the contract instead: every path that runs tests passes the flag, and
// the pinned version is still inside the window where that matters.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// node:sqlite: added in this version, behind the flag…
const SQLITE_ADDED = [22, 5, 0];
// …and usable without it from this one.
const SQLITE_UNFLAGGED = [22, 13, 0];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const parse = (v) => String(v).replace(/[^0-9.]/g, '').split('.').map(Number).concat([0, 0]).slice(0, 3);

function pinnedVersions() {
    const out = {};
    const df = read('Dockerfile.backend') + read('Dockerfile.frontend');
    for (const m of df.matchAll(/FROM node:(\d+\.\d+)/g)) out[`Dockerfile ${m[1]}`] = m[1];
    for (const m of read('.github/workflows/ci.yml').matchAll(/node-version:\s*'([\d.]+)'/g)) out[`ci.yml ${m[1]}`] = m[1];
    return out;
}

describe('the pinned Node version decides whether the flag is needed', () => {
    test('something is actually pinned', () => {
        const v = pinnedVersions();
        assert.ok(Object.keys(v).length >= 2,
            'no Node version found in the Dockerfiles or ci.yml — this guard is checking nothing');
    });

    test('Dockerfiles and CI agree on the version', () => {
        // A CI that tests a different Node than the image runs is the mismatch
        // ci.yml exists to prevent.
        const vals = new Set(Object.values(pinnedVersions()));
        assert.equal(vals.size, 1, `Node versions disagree: ${[...vals].join(' vs ')}`);
    });

    test('every pinned version is at or above the version that introduced node:sqlite', () => {
        for (const [where, v] of Object.entries(pinnedVersions())) {
            assert.ok(cmp(parse(v), SQLITE_ADDED) >= 0,
                `${where} predates node:sqlite (22.5.0) — the suite cannot run there at all`);
        }
    });
});

describe('every path that runs tests passes --experimental-sqlite', () => {
    const pkg = JSON.parse(read('package.json'));

    test('the npm test script passes it', () => {
        assert.match(pkg.scripts.test, /--experimental-sqlite/,
            'npm test omits the flag: on the pinned Node every DB test fails at import (CI red, local green)');
    });

    test('the server scripts pass it too', () => {
        // These were always right; asserted so the pair cannot drift apart.
        for (const s of ['start', 'server']) {
            assert.match(pkg.scripts[s], /--experimental-sqlite/, `npm ${s} omits the flag`);
        }
    });

    test('every mutation harness passes it', () => {
        // The dangerous one: a flagless harness reports every mutant KILLED,
        // because "no '# fail 0' in the output" is how it detects a kill and a
        // crashed baseline also prints no '# fail 0'.
        const dir = new URL('../tools/', import.meta.url);
        const harnesses = fs.readdirSync(dir).filter(f => /^mutation-.*\.mjs$/.test(f));
        assert.ok(harnesses.length >= 7, `expected the mutation harnesses, found ${harnesses.length}`);
        for (const h of harnesses) {
            const src = fs.readFileSync(new URL(h, dir), 'utf8');
            assert.ok(!/node --test /.test(src),
                `${h} shells out to a flagless \`node --test\` — on the pinned Node it reports every mutant killed`);
            assert.match(src, /node --experimental-sqlite --test /,
                `${h} does not pass --experimental-sqlite`);
        }
    });

    test('CI does not re-add a flagless test invocation', () => {
        const ci = read('.github/workflows/ci.yml');
        assert.ok(!/run:\s*node --test/.test(ci),
            'ci.yml runs node --test directly without the flag');
    });

    test('ci.yml states the version rule the right way round', () => {
        // The original comment said node:sqlite was "behind a flag before 22.5",
        // which is backwards and is why the flag was never added. A wrong
        // comment that prevents a fix is worse than no comment.
        // The correction QUOTES the old wrong claim in order to explain it, so
        // a bare substring search matches the fix itself — the self-match trap
        // this suite keeps relearning. Require any line carrying the phrase to
        // also mark it as historical.
        const ci = read('.github/workflows/ci.yml');
        const stated = ci.split('\n').filter(l => /behind a flag before 22\.5/.test(l))
                                     .filter(l => !/used to say/.test(l));
        assert.deepEqual(stated, [],
            'ci.yml asserts (rather than quotes) the backwards version claim: ' + stated.join(' | '));
        assert.match(ci, /unflagged in 22\.13\.0/,
            'ci.yml no longer records when the flag stops being required');
    });
});

describe('the flag stays necessary — and this guard stays honest', () => {
    test('if the pin ever moves to >=22.13 this test says so', () => {
        // Not a failure, a prompt: past 22.13 the flag is harmless but no longer
        // load-bearing, and this whole file can be simplified. Asserting the
        // CURRENT state means the day someone bumps Node, they are told why
        // these assertions existed instead of deleting them blind.
        const vals = Object.values(pinnedVersions());
        const stillNeedsFlag = vals.every(v => cmp(parse(v), SQLITE_UNFLAGGED) < 0);
        assert.equal(stillNeedsFlag, true,
            'The pinned Node is now >= 22.13, where node:sqlite needs no flag. ' +
            'Nothing is broken — but re-read test/node-version-contract.test.js ' +
            'and decide deliberately whether to keep these assertions.');
    });
});
