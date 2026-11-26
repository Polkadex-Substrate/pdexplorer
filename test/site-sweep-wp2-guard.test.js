// Sprint 11 site sweep, WP2 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, 2.6 and 8): the site-wide inline-colour guard
// at the ceilings WP2 leaves it: script.js and lib/ down to the named exemptions only (0), index.html down to what WP3 still
// owns, G3 for script.js at 0 and lib/ at the chart-configs lines no work package of this sprint owns. Proved failing on the
// parent commit, where the ceilings are 252, 32 and 113 (G2) and 50 and 21 (G3).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkSite, repoReader, G2_CEILING, G3_CEILING, EXEMPT } from '../scripts/check-ui-legacy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const rd = repoReader(ROOT);
const run = (opts) => checkSite(rd, opts);
const BIG = 1e9;
// What WP3 still owns in index.html: its pages (spec 8). WP2 takes only the two buttons rows I20 and I44 name there.
const INDEX_OWNED = 111;

describe('G2 (inline colour): the ceilings WP2 leaves', () => {
    test('script.js and lib/ are at 0: the only lines left are the named exemptions of 2.5, each with its reason', () => {
        assert.equal(G2_CEILING['script.js'], 0, 'the script.js ceiling is ' + G2_CEILING['script.js']);
        assert.equal(G2_CEILING['lib/'], 0, 'the lib/ ceiling is ' + G2_CEILING['lib/']);
        assert.equal(G2_CEILING.other, 0);
        assert.ok(EXEMPT.every(e => e.why && e.why.trim()));
    });
    test('index.html is at what WP3 owns (113 at the parent, 111 after rows I20 and I44), and the ceiling equals the measured lines', () => {
        const r = run({ g2: { ...G2_CEILING }, g3: { 'script.js': BIG, 'index.html': BIG, 'lib/': BIG, other: BIG, 'styles.css': BIG }, g4: BIG });
        assert.equal(G2_CEILING['index.html'], INDEX_OWNED);
        assert.equal(r.counts.g2['index.html'], INDEX_OWNED);
    });
    test('the repository is within the new ceilings: no colour, background or border written in script.js or lib/ outside the exemptions', () => {
        const r = run({ g2: { 'script.js': 0, 'lib/': 0, 'index.html': INDEX_OWNED, other: 0 }, g3: { 'script.js': BIG, 'index.html': BIG, 'lib/': BIG, other: BIG, 'styles.css': BIG }, g4: BIG });
        const g2 = r.errors.filter(e => /^G2 /.test(e));
        assert.deepEqual(g2.map(e => e.slice(0, 1400)), []);
    });
    test('a colour written in script.js or in lib/ after this commit is refused at the real ceilings (proved failing)', () => {
        for (const [p, bucket] of [['script.js', 'script.js'], ['lib/discussion-links.js', 'lib/']]) {
            const files = new Map(); for (const f of rd.list()) files.set(f, rd.read(f));
            files.set(p, 'const x = `<p style="color: var(--text-secondary)">x</p>`;\n' + files.get(p));
            const r = checkSite({ read: (f) => (files.has(f) ? files.get(f) : null), list: () => Array.from(files.keys()) });
            const e = r.errors.find(x => new RegExp(`^G2 inline colour: .* lines in ${bucket.replace('/', '\\/')} `).test(x));
            assert.ok(e, `${p}: refused with ${r.errors.map(x => x.slice(0, 120)).join(' | ')}`);
            assert.match(e, new RegExp(`${p.replace('.', '\\.')}:1 `));
            assert.match(e, /Move the colour into a class/);
        }
    });
});

describe('G3 (hue): the ceilings WP2 leaves', () => {
    test('script.js is at 0 (analytics series, status and spike colours, the banner and the deep search button leave their hues); lib/ keeps only lib/chart-configs.js and the Legend colour', () => {
        assert.equal(G3_CEILING['script.js'], 0, 'the script.js ceiling is ' + G3_CEILING['script.js']);
        assert.ok(G3_CEILING['lib/'] <= 17, 'the lib/ ceiling is ' + G3_CEILING['lib/']);
    });
    test('the repository holds no hue in a script.js string outside the exemptions, and lib/ is within its ceiling', () => {
        const r = run({ g2: { 'script.js': BIG, 'index.html': BIG, 'lib/': BIG, other: BIG }, g3: { 'script.js': 0, 'index.html': G3_CEILING['index.html'], 'lib/': 17, other: 0, 'styles.css': G3_CEILING['styles.css'] }, g4: BIG });
        const g3 = r.errors.filter(e => /^G3 /.test(e));
        assert.deepEqual(g3.map(e => e.slice(0, 1400)), []);
    });
});
