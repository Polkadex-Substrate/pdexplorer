// The guard for Paste and Clear in every text box (CEO request, 2026-11-17: "ensure that
// the paste (from clipboard) and clear icon is available in each and every text box";
// spec cto-team/plans/2026-11-17-input-paste-clear.md, 4.4).
//
// npm test fails when a text-like <input> or <textarea> is added to index.html, script.js
// or lib/*.js without data-input-kind or a data-no-input-actions reason. The auditor is
// proved failing on a fixture first, and a blindness check trips if a refactor hides the
// markup from it instead of letting it pass on nothing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { Window } from 'happy-dom';
import { auditSource, AUDIT_KINDS, FIX_SENTENCE } from './helpers/input-audit.js';
import { readRepo, stripComments } from './helpers/source.js';
import { INPUT_KINDS, isTextLike } from '../lib/input-actions.js';

const LIB = readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => 'lib/' + f);
const FILES = ['index.html', 'script.js', ...LIB];
const audits = FILES.map(f => auditSource(readRepo(f, import.meta.url), f));
const tags = audits.flatMap(a => a.tags);
const textTags = tags.filter(t => t.status !== 'not-text');
const offenders = audits.flatMap(a => a.offenders);

describe('the auditor is proved failing first', () => {
    const fixture = [
        '<input type="text" id="x">',
        '<div>',
        '<input',
        '    type="text"',
        '    id="y"',
        '>',
        '<input type="number" id="z" data-no-input-actions="">',
        '<input type="search" id="k" data-input-kind="banana">',
        '<input type="checkbox" id="c">',
        '<input type="text" id="ok" data-input-kind="address">',
        '<input type="text" id="ro" readonly value="${a > b ? 1 : 2}">',
        "const t = doc.createElement('textarea');",
        "const u = doc.createElement('input'); // input-actions: exempt (fixture copy buffer)"
    ].join('\n');
    const r = auditSource(fixture, 'fixture.html');

    test('a bare input, a multi-line tag, an empty opt-out, an unknown kind and an unmarked createElement are all reported', () => {
        assert.equal(r.offenders.length, 5, r.offenders.join('\n'));
        assert.match(r.offenders[0], /^fixture\.html:1 <input type="text" id="x"> \(no data-input-kind\)\. Add data-input-kind=\.\.\. or data-no-input-actions="reason"$/);
        assert.match(r.offenders[1], /^fixture\.html:3 <input type="text" id="y" > \(no data-input-kind\)\./);
        assert.match(r.offenders[2], /^fixture\.html:7 .*\(empty data-no-input-actions reason\)\./);
        assert.match(r.offenders[3], /^fixture\.html:8 .*\(unknown data-input-kind "banana"\)\./);
        assert.match(r.offenders[4], /^fixture\.html:12 .*createElement without an opt-out/);
        for (const o of r.offenders.slice(0, 4)) assert.ok(o.includes(FIX_SENTENCE), o);
    });

    test('a checkbox is not a text box, a kind passes, readonly passes, a marked createElement passes', () => {
        const by = Object.fromEntries(r.tags.map(t => [t.id, t.status]));
        assert.equal(by.c, 'not-text');
        assert.equal(by.ok, 'kind');
        assert.equal(by.ro, 'readonly', 'the > inside ${ } did not end the tag early');
        assert.deepEqual(r.sites.map(s => s.ok), [false, true]);
    });

    test('a commented-out input is not audited, and line numbers stay the file\'s own', () => {
        const c = auditSource('// <input type="text" id="gone">\n<input type="text" id="here">', 'c.js');
        assert.equal(c.tags.length, 1);
        assert.equal(c.offenders.length, 1);
        assert.match(c.offenders[0], /^c\.js:2 /);
    });
});

describe('every text box on main declares its kind or why it has none', () => {
    test('no offenders in index.html, script.js or lib/*.js', () => {
        assert.deepEqual(offenders, [], '\n' + offenders.join('\n'));
    });

    test('blindness check: at least 60 text-like tags, exactly 5 opt-outs and exactly 4 readonly fields', () => {
        assert.ok(textTags.length >= 60, `only ${textTags.length} text-like tags found: the auditor has gone blind`);
        const outs = textTags.filter(t => t.status === 'opt-out');
        const ro = textTags.filter(t => t.status === 'readonly');
        assert.equal(outs.length, 5, outs.map(t => `${t.file}:${t.line}`).join(', '));
        assert.equal(ro.length, 4, ro.map(t => `${t.file}:${t.line}`).join(', '));
        assert.equal(textTags.filter(t => t.status === 'kind').length, textTags.length - 9);
    });

    test('the opt-outs are the five numeric steppers from the spec, each with a reason', () => {
        const outs = textTags.filter(t => t.status === 'opt-out');
        const where = outs.map(t => t.id || (t.tag.match(/name="(\w+)"/) || [])[1]).sort();
        assert.deepEqual(where, ['multisig-threshold', 'proxy-add-delay', 'threshold', 'threshold', 'treasury-spend-threshold']);
        for (const t of outs) assert.ok(t.reason.length >= 5, t.reason);
    });

    test('the one clear-only field is the min self-stake filter', () => {
        const clearOnly = textTags.filter(t => t.actions === 'clear');
        assert.equal(clearOnly.length, 1);
        assert.match(clearOnly[0].tag, /data-f="minSelfStake"/);
        assert.equal(clearOnly[0].kind, 'amount');
    });

    test('the readonly fields are the four copy sources', () => {
        const ro = textTags.filter(t => t.status === 'readonly').map(t => t.id || t.tag.match(/class="([^"]+)"/)[1]).sort();
        assert.deepEqual(ro, ['wallet-copy-url', 'wallet-readonly-copy-url', 'wc-debug-text', 'wc-uri']);
    });

    test('kinds follow the spec audit table for the fields people paste into most', () => {
        const kindOf = (id) => (textTags.find(t => t.id === id) || {}).kind;
        const expect = {
            'search-input': 'search', 'staking-address-input': 'address', 'send-to-input': 'address', 'send-amount-input': 'amount',
            'stake-amount-input': 'amount', 'unstake-amount-input': 'amount', 'treasury-spend-beneficiary': 'address',
            'treasury-spend-amount': 'amount', 'treasury-spend-valid-from': 'integer', 'identity-email': 'text',
            'help-search': 'search', 'inline-search-input': 'search', 'cs-at': 'ref', 'rpc-params': 'code', 'ut-addr': 'address',
            'ut-hash-in': 'text', 'ut-vf-sig': 'hex', 'discuss-post-input': 'text', 'proxy-add-delegate': 'address',
            'multisig-signers': 'address-list', 'account-label-input': 'text', 'multisig-review-call': 'hex',
            'wallet-manual-input': 'address', 'wallet-picker-search': 'search', 'email-subscribe-input': 'text'
        };
        for (const [id, kind] of Object.entries(expect)) assert.equal(kindOf(id), kind, id);
    });

    test('every createElement(input | textarea) site is opted out (the temporary copy buffers)', () => {
        const sites = audits.flatMap(a => a.sites);
        assert.ok(sites.length >= 3, `only ${sites.length} createElement sites found`);
        assert.ok(sites.every(s => s.ok));
    });

    test('the auditor and the component agree on the kinds and on what is text-like', () => {
        assert.deepEqual([...INPUT_KINDS].sort(), [...AUDIT_KINDS].sort());
        for (const type of ['text', 'search', 'email', 'url', 'tel', 'number', '']) assert.equal(isTextLike('input', type), true, type);
        for (const type of ['checkbox', 'radio', 'range', 'hidden', 'file', 'color', 'date', 'submit', 'button', 'image']) assert.equal(isTextLike('input', type), false, type);
        assert.equal(isTextLike('textarea'), true);
        assert.equal(isTextLike('select'), false);
    });
});

describe('rendered index.html: every editable text box is declared', () => {
    test('happy-dom sees the same 21 fields, each with a kind or a reason', async (t) => {
        const window = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
        t.after(() => window.happyDOM.close());
        const html = readRepo('index.html', import.meta.url);
        window.document.body.innerHTML = html.slice(html.indexOf('<body') + html.slice(html.indexOf('<body')).indexOf('>') + 1, html.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
        const fields = Array.from(window.document.querySelectorAll('input, textarea'))
            .filter(el => isTextLike(el.tagName, el.getAttribute('type') || '') && !el.hasAttribute('readonly'));
        assert.equal(fields.length, 21);
        const bad = fields.filter(el => !(INPUT_KINDS.includes(el.getAttribute('data-input-kind')) || (el.getAttribute('data-no-input-actions') || '').trim()));
        assert.deepEqual(bad.map(el => el.id), []);
    });
});

describe('migrations: the bespoke copies are gone', () => {
    const all = FILES.map(f => [f, stripComments(readRepo(f, import.meta.url))]);
    for (const needle of ['staking-paste-btn', 'staking-clear-btn', 'inline-search-paste-btn', 'inline-search-clear-btn', 'wallet-picker-search-clear', "alert('Failed to access clipboard"]) {
        test(`no ${needle}`, () => {
            const hits = all.filter(([, src]) => src.includes(needle)).map(([f]) => f);
            assert.deepEqual(hits, []);
        });
    }

    test('script.js starts the shared component once, and the modal Tab trap skips tabindex=-1 buttons', () => {
        const code = stripComments(readRepo('script.js', import.meta.url));
        assert.match(code, /import \{[^}]*startInputActionsObserver[^}]*\} from '\.\/lib\/input-actions\.js';/);
        assert.equal(code.match(/startInputActionsObserver\(document\)/g).length, 1);
        const sel = code.match(/const FOCUSABLE_SELECTOR = \[([\s\S]*?)\]\.join/);
        assert.ok(sel, 'FOCUSABLE_SELECTOR not found');
        for (const part of ["'button:not([disabled])", "'input:not([disabled])", "'textarea:not([disabled])"]) {
            const entry = sel[1].split(',').map(s => s.trim()).find(s => s.startsWith(part));
            assert.ok(entry && entry.includes(':not([tabindex="-1"])'), `${part} does not skip tabindex=-1: ${entry}`);
        }
    });
});
