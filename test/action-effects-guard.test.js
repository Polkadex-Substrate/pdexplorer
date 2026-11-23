// Coverage guard (design section 3, last paragraph): every action key the status card knows
// (ACTION_KEYS in lib/tx-status.js) and every key written at a submitSignedTx call site
// (`action: { key: '...'` in script.js and lib/*.js) has an EFFECTS entry, and EFFECTS has no key
// beyond ACTION_KEYS. The failure message names the missing or extra keys. Shown failing on fixture
// tables that lack a key or carry an extra one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readRepo, stripComments } from './helpers/source.js';
import { EFFECTS } from '../lib/action-effects.js';
import { ACTION_KEYS } from '../lib/tx-status.js';

// Every quoted key inside an `action: { key: <expr>` (a ternary names two).
export function callSiteKeys(sources) {
    const keys = new Set();
    for (const src of sources) {
        for (const m of stripComments(src).matchAll(/action:\s*\{\s*key:\s*([^,}]+)/g)) {
            for (const q of m[1].matchAll(/'([a-z]+\.[A-Za-z]+)'/g)) keys.add(q[1]);
        }
    }
    return keys;
}

export function coverageOffenders(effects, actionKeys, siteKeys) {
    const have = new Set(Object.keys(effects));
    const known = new Set(actionKeys);
    const out = [];
    const missing = [...known].filter(k => !have.has(k));
    if (missing.length) out.push(`EFFECTS has no entry for action key(s) in lib/tx-status.js: ${missing.join(', ')}`);
    const extra = [...have].filter(k => !known.has(k));
    if (extra.length) out.push(`EFFECTS has key(s) that lib/tx-status.js does not know: ${extra.join(', ')}`);
    const sites = [...siteKeys].filter(k => !have.has(k));
    if (sites.length) out.push(`submitSignedTx call site key(s) with no EFFECTS entry: ${sites.join(', ')}`);
    return out;
}

const libFiles = readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => readRepo('lib/' + f, import.meta.url));
const SITES = callSiteKeys([readRepo('script.js', import.meta.url), ...libFiles]);

describe('action effects coverage guard', () => {
    test('the scanner sees the call sites (not vacuous)', () => {
        for (const k of ['staking.payout', 'balances.transfer', 'treasury.payout', 'treasury.checkStatus', 'multisig.transaction', 'elections.withdraw']) assert.ok(SITES.has(k), k);
        assert.ok(SITES.size >= 18, `only ${SITES.size} call site keys found`);
    });
    test('EFFECTS keys equal ACTION_KEYS in both directions, and cover every call site', () => {
        const err = coverageOffenders(EFFECTS, ACTION_KEYS, SITES);
        assert.deepEqual(err, [], err.join('\n'));
        assert.equal(Object.keys(EFFECTS).length, ACTION_KEYS.length);
    });
    test('self-test: a table without staking.payout fails and names it', () => {
        const { ['staking.payout']: _, ...lacking } = EFFECTS;
        const err = coverageOffenders(lacking, ACTION_KEYS, SITES);
        assert.equal(err.length, 2);
        assert.match(err[0], /no entry for action key\(s\) in lib\/tx-status\.js: staking\.payout$/);
        assert.match(err[1], /call site key\(s\) with no EFFECTS entry: staking\.payout$/);
    });
    test('self-test: an extra key and a new call site key are named', () => {
        const err = coverageOffenders({ ...EFFECTS, 'foo.bar': EFFECTS['staking.payout'] }, ACTION_KEYS, new Set([...SITES, 'new.action']));
        assert.match(err.join('\n'), /does not know: foo\.bar/);
        assert.match(err.join('\n'), /no EFFECTS entry: new\.action/);
    });
    test('self-test: the scanner reads a ternary and ignores comments', () => {
        const keys = callSiteKeys(["x({ action: { key: a ? 'treasury.payout' : 'treasury.checkStatus', params } });\n// action: { key: 'ghost.key' }"]);
        assert.deepEqual([...keys].sort(), ['treasury.checkStatus', 'treasury.payout']);
    });
});
