// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 1, 2.2 P13 P14, 2.3 rows I5,
// I6, I16, I34, I35, I45, and 6.2 T7, T8, T10): every one of the 34 legacy buttons on its tier, the class gone from
// every page, one primary per view, and the signing modals' markup on the kit, class changes only.
//
// Rendered, not scanned: index.html's body is parsed into happy-dom for the static rows and the modals; the rows
// script.js draws come from the REAL page (test/helpers/full-page.js: index.html plus the real script.js in happy-dom,
// one child process per page, fetch answered by the scenario); the lib rows call the real lib functions.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { escapeHtml } from '../lib/html-escape.js';
import { runPage, INDEX_HTML, ACCOUNT as ME, accountApi } from './helpers/head-page.js';
import { discussComposerHtml } from '../lib/discussion-auth.js';
import { wireEditing } from '../lib/discussion-edit.js';
import { renderGovDetailSummary } from '../lib/gov-detail-view.js';
import { democracyCells } from '../lib/democracy-patch.js';

const O1 = encodeAddress(new Uint8Array(32).fill(21), 88), O2 = encodeAddress(new Uint8Array(32).fill(22), 88);
const TIERS = ['validate-primary', 'ui-action', 'validate-secondary', 'validate-text-btn'];
const PRIMARY = '.validate-primary, .wallet-option-row.is-primary, .modal-submit-btn';
const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const docOf = (html) => {
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return win.document;
};
const BODY = INDEX_HTML.slice(INDEX_HTML.indexOf('<body'), INDEX_HTML.lastIndexOf('</body>') + 7).replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '').replace(/<script[\s\S]*?<\/script>/g, '');
// Parsed in before(), after the pages: a happy-dom window open in this process while full-page.js children run
// was seen to leave a child's callback never called (the hook then ended with nothing left in the event loop).
let STATIC = null;
// Never hand a happy-dom node to assert.equal or deepEqual: a failing assertion inspects it, and that can exhaust memory.
// Drawn: no [hidden] and no inline display: none on it or an ancestor (scripts toggle modals and pages by style).
const drawn = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.hasAttribute('hidden') || /display:\s*none/.test(e.getAttribute('style') || '')) return false; } return true; };
const inlineColour = (root) => Array.from(root.querySelectorAll('[style]')).concat(root.hasAttribute && root.hasAttribute('style') ? [root] : [])
    .filter(e => COLOUR.test(';' + e.getAttribute('style'))).map(e => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} style="${e.getAttribute('style')}">`);

// [row, where, selector, tier, icon (null: none required, false: none allowed), label, extra classes, more checks]
const ROWS = [
    [1, 'static', '#council-withdraw-copy-address', 'validate-secondary', 'bx-copy', 'Copy address'],
    [2, 'static', '#council-withdraw-retry', 'validate-secondary', 'bx-refresh', 'Refresh review'],
    [3, 'static', '#cancel-council-withdraw', 'validate-text-btn', null, 'Cancel'],
    [4, 'static', '#council-withdraw-sign', 'validate-primary', null, 'Sign and withdraw candidacy', ['is-solid'], (el) => assert.equal(el.hasAttribute('disabled'), true, 'row 4 keeps disabled')],
    [5, 'static', '#treasury-spend-edit', 'validate-secondary', 'bx-edit-alt', 'Edit'],
    [6, 'static', '#treasury-spend-check', 'ui-action', 'bx-search-alt', 'Review motion', [], (el) => assert.equal(el.hasAttribute('disabled'), true, 'row 6 keeps disabled')],
    [7, 'static', '#treasury-spend-sign', 'validate-primary', null, 'Sign and table motion', ['is-solid'], (el) => assert.equal(el.hasAttribute('disabled'), true, 'row 7 keeps disabled')],
    [8, 'static', '#onboarding-tour-back', 'validate-secondary', false, 'Back', [], (el) => assert.equal(el.hasAttribute('style'), false, 'row 8: the inline padding and size go')],
    [9, 'static', '#cookies-reset-btn', 'ui-action', 'bx-refresh', 'Reset all preferences', [], (el) => { assert.equal(el.hasAttribute('style'), false, 'row 9: the inline style goes'); assert.ok(el.closest('.legal-page'), 'row 9 sits in .legal-page (its margin comes from .legal-page .ui-action)'); }],
    [10, 'static', '#storage-notice-banner a[href="/privacy"]', 'validate-text-btn', null, 'Learn more', [], (el) => assert.equal(el.tagName, 'A')],
    [11, 'static', '#storage-notice-dismiss', 'validate-secondary', null, 'OK, got it'],
    [12, 'cs', '#cs-dl-json', 'validate-secondary', 'bx-download', 'JSON', [], (el) => assert.equal(el.getAttribute('title'), 'Full result with provenance')],
    [13, 'cs', '#cs-dl-csv', 'validate-secondary', 'bx-download', 'CSV', [], (el) => assert.equal(el.getAttribute('title'), 'Flattened rows')],
    [14, 'cs', '#cs-copy-val', 'validate-secondary', 'bx-copy', 'Copy value', [], (el) => assert.equal(el.getAttribute('title'), 'Copy the decoded value to the clipboard')],
    [15, 'dec', '#dec-dl-json', 'validate-secondary', 'bx-download', 'JSON'],
    [16, 'tx', '#tx-recover-btn', 'ui-action', 'bx-globe', 'Try a deep search'],
    [17, 'tx', '#tx-details-container a[href="/search?q=not-a-hash"]', 'validate-secondary', 'bx-globe', 'Deep network search', [], (el) => assert.equal(el.tagName, 'A')],
    [18, 'rew', '#staking-dl-csv', 'validate-secondary', 'bx-download', 'CSV'],
    [19, 'rew', '#staking-dl-json', 'validate-secondary', 'bx-download', 'JSON'],
    [20, 'rew', '#staking-dl-tax', 'validate-secondary', 'bx-receipt', 'Tax (year…)', [], (el) => assert.equal(el.getAttribute('title'), 'Annual rewards summary with PDEX→USD price at era close')],
    [21, 'disc', '#discussions-retry-btn', 'validate-secondary', 'bx-refresh', 'Try again'],
    [22, 'dem', '#democracy-retry-btn', 'validate-secondary', 'bx-refresh', 'Try again'],
    [23, 'tre', '#treasury-retry-btn', 'validate-secondary', 'bx-refresh', 'Try again'],
    [24, 'owner', `.label-row[data-signer="${ME}"] .label-delete-btn`, 'validate-text-btn', null, 'Remove mine', ['is-danger']],
    [25, 'owner', `.label-row[data-signer="${O1}"] .label-report-btn`, 'validate-text-btn', null, 'Report', [], (el) => assert.ok(!el.classList.contains('is-danger'))],
    [26, 'owner', `.label-row[data-signer="${O1}"] .label-veto-btn`, 'validate-text-btn', null, 'Veto', ['is-danger']],
    ['26b', 'owner', `.label-row[data-signer="${O2}"] .label-veto-btn`, 'validate-text-btn', null, 'Un-veto', [], (el) => assert.ok(!el.classList.contains('is-danger'), 'Un-veto is not destructive')],
    [27, 'owner', '#account-label-save', 'ui-action', 'bx-check', 'Update'],
    [28, 'signin', '#account-label-signin', 'ui-action', 'bx-log-in', 'Sign in with wallet'],
    [29, 'watch', '#watchlist-clear-all', 'validate-text-btn', 'bx-trash', 'Clear all', ['is-danger']],
    [30, 'lib', '#discuss-connect-btn', 'ui-action', 'bx-wallet', 'Connect wallet', [], (el) => { assert.equal(el.tagName, 'A'); assert.equal(el.getAttribute('href'), '/wallet?returnTo=%2Fdiscussions%2F7'); }],
    [31, 'lib', '#discuss-post-btn', 'ui-action', 'bx-send', 'Post'],
    [32, 'lib', '.discussion-edit-cancel', 'validate-text-btn', null, 'Cancel'],
    [33, 'lib', '.discussion-edit-save', 'ui-action', 'bx-check', 'Save'],
    [34, 'lib', '.gd-copy', 'validate-secondary', 'bx-link', 'Copy link', [], (el) => assert.equal(el.getAttribute('data-gd-copy'), '/democracy/referendum/2')]
];

// The script.js pages, each loaded once, as a browser loads it.
const far = Date.now() + 5 * 86400000;
const LABELS = { labels: [
    { signer: O1, label: 'Exchange wallet', score: 2, viewerVote: 0, reportCount: 0, vetoed: false, createdAt: 1700000000000 },
    { signer: O2, label: 'Old name', score: 0, viewerVote: 0, reportCount: 1, vetoed: true, createdAt: 1700000000000 },
    { signer: ME, label: 'My label', score: 1, viewerVote: 1, reportCount: 0, vetoed: false, createdAt: 1700000000000 }] };
const WALLET = { pdex_wallet_address: ME, pdex_wallet_source: 'polkadot-js' };
const SCENARIOS = {
    cs: { path: 'chain-state' },
    dec: { path: 'decode' },
    tx: { path: 'tx/123/not-a-hash' },
    rew: { path: 'staking-rewards/' + ME, api: { '/api/staking-rewards/': { address: ME, identity: 'Alice', summary: { claimedTotal: 12.5, unclaimedTotal: 0, totalRewards: 12.5 }, index: { backfillComplete: true },
        claimed: [{ era: 100, validator: O1, amount: 1.25, blockNumber: 10, timestamp: 1700000000000, claimed: true }], unclaimed: [] } } },
    disc: { path: 'discussions', api: { '/api/discussions': { error: 'Indexer offline' } }, steps: [{ click: '#discussions-retry-btn' }] },
    dem: { path: 'democracy', api: { '/api/democracy': { error: 'Indexer offline' } }, steps: [{ click: '#democracy-retry-btn' }] },
    tre: { path: 'treasury', api: { '/api/treasury': { error: 'Indexer offline' } }, steps: [{ click: '#treasury-retry-btn' }] },
    owner: { path: 'account/' + ME, api: { ...accountApi(), '/api/labels/': LABELS }, wallets: { 'polkadot-js': [ME] }, seed: { ...WALLET, pdex_discuss_session: JSON.stringify({ v: 3, token: 'tok', address: ME, expiresAt: far }) }, steps: [{ wait: 400 }] },
    signin: { path: 'account/' + ME, api: { ...accountApi(), '/api/labels/': LABELS }, wallets: { 'polkadot-js': [ME] }, seed: WALLET, steps: [{ wait: 400 }] },
    val: { path: 'validate' },
    watch: { path: 'watchlist', seed: { pdex_watchlist_v1: JSON.stringify({ ['address:' + ME]: { kind: 'address', id: ME, label: 'Alice', addedAt: 1700000000000 } }) } }
};
const PAGES = {};
const LIB = {};

before(async () => {
    // Three pages at a time: each child holds the whole explorer in happy-dom (the sandbox has 4 GB and no swap).
    const queue = Object.entries(SCENARIOS), done = [];
    await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const [k, s] = queue.shift(); done.push([k, await runPage({ ...s, dumpHtml: true })]); } }));
    for (const [k, r] of done) PAGES[k] = { r, doc: docOf(r.appHtml || '') };
    STATIC = docOf(BODY);
    // The lib rows, drawn by the real functions.
    LIB.connect = docOf(discussComposerHtml({ thread: null, wallet: null, session: null, esc: escapeHtml, shortAddr: (a) => a.slice(0, 6), returnTo: '/discussions/7' }));
    LIB.post = docOf(discussComposerHtml({ thread: null, wallet: ME, session: null, esc: escapeHtml, shortAddr: (a) => a.slice(0, 6), composer: '<textarea></textarea>' }));
    LIB.edit = docOf('<div id="root"><div class="discussion-post" data-post-id="5"><div class="discussion-post-body">Hello</div><button type="button" data-edit-post="5">Edit</button></div></div>');
    wireEditing(LIB.edit.getElementById('root'), { esc: escapeHtml, posts: [{ id: 5, content: 'Hello' }], getSession: () => null, fetchFn: async () => ({}), threadId: 7 });
    // lib/discussion-edit.js builds the form with the page's global document.
    globalThis.document = LIB.edit;
    try { LIB.edit.querySelector('[data-edit-post="5"]').click(); } finally { delete globalThis.document; }
    const h = { esc: escapeHtml, num: String, pdex: String, shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };
    LIB.gov = docOf(renderGovDetailSummary({ id: '2', index: 2, title: 't', status: 'Ongoing', call: null, timeline: [], thread: null, sources: {}, kind: 'referendum', tally: { known: false } }, h));
}, { timeout: 240000 });
const docFor = (where) => (where === 'static' ? STATIC : where === 'lib' ? null : PAGES[where].doc);
const libFind = (sel) => [LIB.connect, LIB.post, LIB.edit, LIB.gov].map(d => d.querySelector(sel)).find(Boolean) || null;

describe('T7: the 34 legacy buttons, each on its tier (section 1.1)', () => {
    test('the table holds the 34 rows (plus the Un-veto state of row 26)', () => {
        assert.equal(new Set(ROWS.map(r => String(r[0]).replace('b', ''))).size, 34);
    });
    for (const [row, where, sel, tier, iconName, label, extra = [], more] of ROWS) {
        test(`row ${row}: ${sel} is ${tier}${extra.length ? '.' + extra.join('.') : ''}${iconName ? ' with ' + iconName : ''}, reads "${label}"`, () => {
            if (where !== 'static' && where !== 'lib') assert.deepEqual(PAGES[where].r.errors, [], `the ${where} page threw`);
            const el = where === 'lib' ? libFind(sel) : docFor(where).querySelector(sel);
            assert.ok(el, `row ${row}: no ${sel} on the page`);
            assert.ok(!el.classList.contains('staking-download-btn'), `row ${row}: still .staking-download-btn (${el.className})`);
            assert.deepEqual(TIERS.filter(t => el.classList.contains(t)), [tier], `row ${row}: classes "${el.className}"`);
            for (const c of extra) assert.ok(el.classList.contains(c), `row ${row}: no .${c}`);
            if (iconName) assert.ok(el.querySelector(`.bx.${iconName}`), `row ${row}: no ${iconName} icon`);
            if (iconName === false) assert.equal(el.querySelector('.bx') === null, true, `row ${row}: an icon`);
            assert.equal(text(el), label);
            assert.deepEqual(inlineColour(el), [], `row ${row}: a colour written in markup`);
            if (more) more(el);
        });
    }
    test('rows 21 to 23: Try again reads the page again (one load, one click, two reads)', () => {
        // Amended in the second red commit: the h3 check read the whole app (other pages keep inline h3 until WP2 and
        // WP3); it now reads the page that failed to load.
        for (const [k, api, root] of [['disc', '/api/discussions', '#discussions-content'], ['dem', '/api/democracy', '#democracy-content'], ['tre', '/api/treasury', '#treasury-content']]) {
            const n = PAGES[k].r.fetched.filter(u => u.includes(api)).length;
            assert.ok(n >= 2, `${k}: ${api} read ${n} times`);
            const box = PAGES[k].doc.querySelector(root);
            assert.ok(box && box.querySelector('.ui-panel.is-warn'), `${k}: the failure is not an amber panel`);
            assert.equal(box.querySelector('h3[style], [style*="color"]') === null, true, `${k}: the red h3 or another inline colour is still there`);
        }
    });
    test('rows 1 and 5 keep their display state (style="display:none" is state, toggled by script)', () => {
        for (const id of ['council-withdraw-copy-address', 'treasury-spend-edit']) assert.match(STATIC.getElementById(id).getAttribute('style') || '', /^display:\s*none;?$/);
    });
});

describe('T10 and T8: no legacy class anywhere, one primary per view', () => {
    test('the static page (every modal and the storage notice): no .staking-download-btn', () => {
        assert.deepEqual(Array.from(STATIC.querySelectorAll('.staking-download-btn')).map(e => e.id || e.textContent.trim()), []);
    });
    for (const k of Object.keys(SCENARIOS)) {
        test(`page ${SCENARIOS[k].path}: no .staking-download-btn; at most one primary drawn`, () => {
            const doc = PAGES[k].doc;
            assert.ok(doc.querySelector('.page-section'), `${k}: the page did not render`);
            assert.deepEqual(Array.from(doc.querySelectorAll('.staking-download-btn')).map(e => e.id || e.className), []);
            const shown = Array.from(doc.querySelectorAll(PRIMARY)).filter(drawn);
            assert.ok(shown.length <= 1, `${k}: ${shown.length} primaries drawn: ${shown.map(e => e.id || e.className).join(', ')}`);
        });
    }
    test('the sort glyph carries no inline opacity (3.1: .table-th .bx-sort gives 0.7)', () => {
        const sorts = Object.values(PAGES).flatMap(p => Array.from(p.doc.querySelectorAll('.bx-sort')));
        assert.ok(sorts.length >= 1, 'no sortable table on the pages loaded');
        assert.deepEqual(sorts.filter(e => e.hasAttribute('style')).map(e => e.getAttribute('style')), []);
    });
});

// ── the WP1 modals in index.html ──
const MODALS = {
    'council-withdraw-modal': { sign: '#council-withdraw-sign', primary: 1, kit: false },
    'council-candidacy-modal': { sign: '#submit-candidacy-tx-btn', label: 'Sign and submit candidacy', primary: 1 },
    'council-vote-modal': { sign: '#submit-vote-tx-btn', label: 'Sign and submit vote', primary: 1, card: 'is-picker' },
    'treasury-spend-modal': { sign: '#treasury-spend-sign', primary: 1 },
    'referendum-vote-modal': { sign: '#submit-referendum-vote-btn', label: 'Sign and submit vote', primary: 1 },
    'email-subscribe-modal': { primary: 0 },
    'governance-detail-modal': { primary: 0 },
    'onboarding-tour-modal': { primary: 0, shellOnly: true, shell: 'is-tour', card: 'is-wide' }
};
describe('P13, P14, I5, I6, I34, I45: the modals of WP1 on the kit (index.html)', () => {
    for (const [id, m] of Object.entries(MODALS)) {
        test(`${id}: ${m.kit === false ? 'its own classes' : '.ui-modal > .ui-modal-card, .modal-close-btn'}; no colour written in markup; ${m.primary} primary`, () => {
            const root = STATIC.getElementById(id);
            assert.ok(root, 'no #' + id);
            assert.match(root.getAttribute('style') || '', /^display:\s*none;?$/, 'the shell keeps only its display state inline');
            if (m.kit !== false) {
                assert.ok(root.classList.contains('modal') && root.classList.contains('ui-modal'), root.className);
                if (m.shell) assert.ok(root.classList.contains(m.shell), `no .${m.shell} on the shell`);
                const card = root.firstElementChild;
                assert.ok(card.classList.contains('ui-modal-card') && card.classList.contains('glass'), card.className);
                if (m.card) assert.ok(card.classList.contains(m.card), `no .${m.card} on the card`);
                assert.equal(card.hasAttribute('style'), false, 'the card keeps an inline style');
                const close = card.querySelector(':scope > button[aria-label]');
                assert.ok(close && close.classList.contains('modal-close-btn'), 'the close button is not .modal-close-btn');
                assert.equal(close.hasAttribute('style'), false);
                if (m.shellOnly) return;
            }
            assert.deepEqual(inlineColour(root), [], 'a colour, background or border written in markup');
            const primaries = Array.from(root.querySelectorAll(PRIMARY));
            assert.equal(primaries.length, m.primary, primaries.map(e => e.id).join(', '));
            if (m.sign && m.label) {
                const b = root.querySelector(m.sign);
                assert.ok(b.classList.contains('modal-submit-btn'), `${m.sign} is not .modal-submit-btn (I45)`);
                assert.equal(text(b), m.label);
                assert.ok(!b.classList.contains('glass'));
            }
        });
    }
    test('P14: the stake, amount and conviction fields are .ui-input', () => {
        for (const id of ['vote-stake-input', 'referendum-vote-amount', 'referendum-vote-conviction']) assert.ok(STATIC.getElementById(id).classList.contains('ui-input'), id);
    });
    test('P8: every label in the candidacy, council vote and referendum modals is .ui-field-label', () => {
        for (const id of ['council-candidacy-modal', 'council-vote-modal', 'referendum-vote-modal']) {
            for (const l of STATIC.getElementById(id).querySelectorAll('label')) assert.ok(l.classList.contains('ui-field-label'), `${id}: "${text(l)}"`);
        }
    });
    test('P5: the intro lines are p.ui-section-caption; the spend effect line is .ui-lede', () => {
        for (const id of ['council-candidacy-modal', 'council-vote-modal', 'treasury-spend-modal', 'referendum-vote-modal']) {
            const p = STATIC.getElementById(id).querySelector('.ui-modal-card > p');
            assert.ok(p && p.classList.contains('ui-section-caption'), `${id}: ${p && p.outerHTML.slice(0, 80)}`);
        }
        assert.ok(STATIC.getElementById('treasury-spend-effect').classList.contains('ui-lede'));
    });
    test('P4, P6: the vote hints are .ui-caption; the votable figure is .ui-quiet', () => {
        assert.ok(STATIC.getElementById('council-vote-votable').classList.contains('ui-caption'));
        assert.ok(STATIC.querySelector('#council-vote-votable strong').classList.contains('ui-quiet'));
        assert.ok(STATIC.getElementById('vote-stake-input').nextElementSibling.classList.contains('ui-caption'), 'the stake hint under the field');
        assert.ok(STATIC.getElementById('referendum-vote-conviction').nextElementSibling.classList.contains('ui-caption'), 'the conviction hint under the field');
    });
    test('I5: the active wallet boxes are .ui-readout (ids and content unchanged)', () => {
        for (const id of ['candidacy-active-wallet', 'referendum-vote-active-wallet']) {
            const el = STATIC.getElementById(id);
            assert.ok(el.classList.contains('ui-readout'), id);
            assert.equal(el.textContent, '--');
        }
    });
    test('I6: "Please connect your wallet first." is an amber one-line panel with its icon (same ids, still hidden at load)', () => {
        for (const id of ['candidacy-modal-wallet-warning', 'vote-modal-wallet-warning', 'referendum-vote-modal-wallet-warning']) {
            const el = STATIC.getElementById(id);
            assert.ok(['ui-panel', 'is-warn', 'is-line'].every(c => el.classList.contains(c)), `${id}: ${el.className}`);
            assert.ok(el.querySelector(':scope > .bx.bx-error'), `${id}: no icon`);
            assert.equal(text(el.querySelector('.ui-panel-body')), 'Please connect your wallet first.');
            assert.match(el.getAttribute('style') || '', /^display:\s*none;?$/);
        }
    });
    test('I34: the Aye and Nay buttons carry aria-pressed and a check, no inline colour', () => {
        const aye = STATIC.getElementById('referendum-vote-side-aye'), nay = STATIC.getElementById('referendum-vote-side-nay');
        assert.equal(aye.getAttribute('aria-pressed'), 'true');
        assert.equal(nay.getAttribute('aria-pressed'), 'false');
        for (const b of [aye, nay]) { assert.equal(b.hasAttribute('style'), false); assert.ok(b.querySelector('.bx.bx-check')); assert.ok(b.classList.contains('referendum-side-btn')); }
        assert.deepEqual([text(aye), text(nay)], ['Aye', 'Nay']);
    });
});

describe('I35: the referenda table triggers (lib/democracy-patch.js)', () => {
    const h = { pdex: (v) => Number(v || 0).toFixed(4), num: (v) => String(Number(v || 0)), esc: escapeHtml, pending: () => null, myVote: () => null, canSecond: () => true };
    test('Aye and Nay: .referendum-vote-trigger.is-aye and .is-nay, no style, same index, side, title and label', () => {
        const doc = docOf(democracyCells(h).cell('ref', { refIndex: 2, status: 'Ongoing', ayes: 1, nays: 0, turnout: 1, tallyKnown: 1 }, 'vote'));
        const aye = doc.querySelector('[data-side="aye"]'), nay = doc.querySelector('[data-side="nay"]');
        for (const [b, side, label] of [[aye, 'aye', 'Aye'], [nay, 'nay', 'Nay']]) {
            assert.ok(b.classList.contains('referendum-vote-trigger') && b.classList.contains('is-' + side), b.className);
            assert.equal(b.hasAttribute('style'), false, `${side}: ${b.getAttribute('style')}`);
            assert.equal(b.getAttribute('data-ref-index'), '2');
            assert.equal(b.getAttribute('title'), 'Vote ' + label);
            assert.equal(text(b), label);
        }
    });
});
