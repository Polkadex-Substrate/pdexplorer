// Coverage guard (design section 3, last paragraph): every action key the status card knows
// (ACTION_KEYS in lib/tx-status.js) and every key written at a submitSignedTx call site
// (`action: { key: '...'` in script.js and lib/*.js) has an EFFECTS entry, and EFFECTS has no key
// beyond ACTION_KEYS. The failure message names the missing or extra keys. Shown failing on fixture
// tables that lack a key or carry an extra one.
// R6: also per call, every `submitSignedTx({` call carries `action: { key` (callSiteOffenders), with the file
// and line of an offender in the message.

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

// R6 (design 9 "R6"): every `submitSignedTx({` call (script.js and lib/, the declaration itself excepted)
// carries `action: { key: '<key>'` in its own argument object, and every key it names has an EFFECTS entry.
// sources: [{ file, text }]. Returns one line per offending call: file:line and what is wrong.
export function callSiteOffenders(sources, effects) {
    const have = new Set(Object.keys(effects));
    const out = [];
    for (const { file, text } of sources) {
        const src = String(text).split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
        for (const m of src.matchAll(/(function\s+)?\bsubmitSignedTx\(\{/g)) {
            if (m[1]) continue;   // the declaration
            const open = m.index + m[0].length - 1;
            let depth = 0, end = open;
            for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
            const body = src.slice(open, end + 1);
            const at = `${file}:${src.slice(0, m.index).split('\n').length}`;
            const k = body.match(/\baction:\s*\{\s*key:\s*([^,}]+)/);
            if (!k) { out.push(`${at}: submitSignedTx({ without action: { key: ... } (every signing call names its action so the page can follow it)`); continue; }
            const keys = [...k[1].matchAll(/'([a-z]+\.[A-Za-z]+)'/g)].map(q => q[1]);
            if (!keys.length) { out.push(`${at}: action key is not a quoted key: ${k[1].trim()}`); continue; }
            const missing = keys.filter(q => !have.has(q));
            if (missing.length) out.push(`${at}: action key(s) with no EFFECTS entry: ${missing.join(', ')}`);
        }
    }
    return out;
}

const libSources = readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).sort().map(f => ({ file: 'lib/' + f, text: readRepo('lib/' + f, import.meta.url) }));
const SCRIPT_SOURCE = { file: 'script.js', text: readRepo('script.js', import.meta.url) };
const libFiles = libSources.map(s => s.text);
const SITES = callSiteKeys([SCRIPT_SOURCE.text, ...libFiles]);

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
    test('R6: every submitSignedTx({ call carries action: { key with an EFFECTS entry (file and line on failure)', () => {
        const err = callSiteOffenders([SCRIPT_SOURCE, ...libSources], EFFECTS);
        assert.deepEqual(err, [], '\n' + err.join('\n'));
        const calls = (stripComments(SCRIPT_SOURCE.text).match(/[^\w]submitSignedTx\(\{/g) || []).length;
        assert.ok(calls >= 15, `only ${calls} submitSignedTx({ calls seen in script.js`);
    });
    test('R6 self-test: a call without an action key, a computed key and an unknown key each fail with file and line', () => {
        const src = [
            'async function submitSignedTx({ buildTx, action: act }) {}',
            'await submitSignedTx({ buildTx: b, label: "x", onSuccess: () => { done(); } });',
            'await submitSignedTx({',
            '    buildTx: b, action: { key: spec.key, params: {} } });',
            "await submitSignedTx({ buildTx: b, action: { key: 'ghost.action', params } });",
            "await submitSignedTx({ buildTx: b, action: { key: 'staking.payout', params } });",
            "// await submitSignedTx({ buildTx: b });"
        ].join('\n');
        const err = callSiteOffenders([{ file: 'script.js', text: src }], EFFECTS);
        assert.equal(err.length, 3, err.join('\n'));
        assert.match(err[0], /^script\.js:2: submitSignedTx\(\{ without action: \{ key/);
        assert.match(err[1], /^script\.js:3: action key is not a quoted key: spec\.key/);
        assert.match(err[2], /^script\.js:5: action key\(s\) with no EFFECTS entry: ghost\.action$/);
    });
    test('self-test: the scanner reads a ternary and ignores comments', () => {
        const keys = callSiteKeys(["x({ action: { key: a ? 'treasury.payout' : 'treasury.checkStatus', params } });\n// action: { key: 'ghost.key' }"]);
        assert.deepEqual([...keys].sort(), ['treasury.checkStatus', 'treasury.payout']);
    });
});
