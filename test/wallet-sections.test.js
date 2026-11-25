// Sprint R3 (design cto-team/plans/2026-11-22-post-action-refresh-design.md, section 6; UX spec
// 2026-11-22-post-action-refresh-ux.md, rules U2 to U5): the wallet dashboard's sections, one at a time.
//
// lib/wallet-sections.js in happy-dom: patchSection (an equal section is not touched, a section holding a typed
// field waits for it, the page does not jump), the one delegated listener for the action bar, the action bar synced
// button by button (nodes kept, so focus stays), the frame's stable section containers and the proxy list's rows.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { escapeHtml } from '../lib/html-escape.js';
import { LEDGER_UNSETTLED } from '../lib/stake-plan.js';
import { STRINGS } from '../lib/refresh-ui.js';

// New in R3; missing before it, so each test fails on its own assertion.
const S = await import('../lib/wallet-sections.js').then((m) => m, () => ({}));
const need = (name) => { assert.equal(typeof S[name], 'function', `lib/wallet-sections.js does not export ${name}`); return S[name]; };
const ME = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const D1 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const D2 = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';

function dom(html = '') {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return { win, doc: win.document };
}
const settle = () => new Promise(r => setTimeout(r, 0));
// Mutation records under a node, counted after the observer has delivered.
function watch(win, el) {
    const records = [];
    const mo = new win.MutationObserver((list) => records.push(...list));
    mo.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
    return async () => { await settle(); mo.disconnect(); return records.length; };
}
const fmt = { pdex: (v) => Number(v || 0).toFixed(4), number: (n) => String(n), esc: escapeHtml, short: (a) => String(a).slice(0, 6) + '...', duration: (ms) => `${ms}ms` };

describe('patchSection: a section repaints alone, and only when its markup changed', () => {
    test('equal markup is a no-op: not one DOM mutation', async () => {
        const patchSection = need('patchSection');
        const { win, doc } = dom('<div id="s"><p class="a">One <b>two</b></p></div>');
        const el = doc.getElementById('s');
        const count = watch(win, el);
        assert.equal(patchSection(el, '<p class="a">One <b>two</b></p>', { doc, win }), 'same');
        assert.equal(await count(), 0, 'an unchanged section was rewritten');
    });
    test('changed markup replaces that section only; its siblings keep their nodes', async () => {
        const patchSection = need('patchSection');
        const { win, doc } = dom('<div id="a"><p>A</p></div><div id="b"><p>B</p></div>');
        const keep = doc.querySelector('#b p');
        const count = watch(win, doc.getElementById('b'));
        assert.equal(patchSection(doc.getElementById('a'), '<p>A2</p>', { doc, win }), 'replaced');
        assert.equal(doc.getElementById('a').textContent, 'A2');
        assert.ok(doc.querySelector('#b p') === keep, 'a sibling section was rebuilt');
        assert.equal(await count(), 0);
    });
    test('a section holding the focused field waits until the field loses focus: value, focus and caret survive', async () => {
        const patchSection = need('patchSection');
        const { win, doc } = dom('<div id="s"><input id="f" value=""></div><button id="other">x</button>');
        const input = doc.getElementById('f');
        input.focus();
        input.value = 'esTyped';
        input.setSelectionRange(3, 3);
        assert.equal(patchSection(doc.getElementById('s'), '<input id="f" value=""><p>new</p>', { doc, win }), 'deferred');
        assert.ok(doc.getElementById('f') === input, 'the focused field was replaced');
        assert.equal(input.value, 'esTyped');
        assert.equal(input.selectionStart, 3);
        assert.ok(doc.activeElement === input, 'focus was lost');
        doc.getElementById('other').focus();
        await settle(); await settle();
        assert.ok(doc.querySelector('#s p'), 'the waiting markup was never applied after the field lost focus');
    });
    test('the page does not jump: the first visible section keeps its place when a section above it grows', () => {
        const patchSection = need('patchSection');
        const { win, doc } = dom('<div id="wallet-dashboard"><div id="top"><p>short</p></div><div id="read"><p>reading here</p></div></div>');
        const root = doc.getElementById('wallet-dashboard');
        const top = doc.getElementById('top'), read = doc.getElementById('read');
        let grown = false;
        top.getBoundingClientRect = () => ({ top: -400, bottom: -100, height: 300 });
        read.getBoundingClientRect = () => (grown ? { top: 180, bottom: 480, height: 300 } : { top: 120, bottom: 420, height: 300 });
        const scrolled = [];
        win.scrollBy = (x, y) => { scrolled.push([x, y]); };
        // the section above grows when its new markup is written (not before the call measures)
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(top), 'innerHTML') || Object.getOwnPropertyDescriptor(win.Element.prototype, 'innerHTML');
        Object.defineProperty(top, 'innerHTML', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); grown = true; } });
        const out = patchSection(top, '<p>much longer</p><p>rows</p>', { doc, win, root });
        assert.equal(out, 'replaced');
        assert.deepEqual(scrolled, [[0, 60]], 'the reader was pushed down by a section above the viewport');
    });
});

describe('bindWalletActions: one delegated listener for the action bar', () => {
    const BAR = (sendDisabled = false) => `<div id="wallet-action-bar"><button class="wallet-action-btn" id="wallet-act-send"${sendDisabled ? ' disabled' : ''}><i></i><div><strong>Send PDEX</strong></div></button>`
        + '<button class="wallet-action-btn" id="wallet-act-identity"><div><strong>Set identity</strong></div></button></div>';
    test('bound once: a second bind and a repainted bar still open each dialog exactly once', () => {
        const bindWalletActions = need('bindWalletActions');
        const { doc } = dom(`<div id="wallet-dashboard"><div id="wallet-actions-slot">${BAR()}</div></div>`);
        const root = doc.getElementById('wallet-dashboard');
        const calls = [];
        const handlers = { 'wallet-act-send': () => calls.push('send'), 'wallet-act-identity': () => calls.push('identity') };
        assert.equal(bindWalletActions(root, handlers), true);
        assert.equal(bindWalletActions(root, handlers), false, 'bound twice');
        doc.querySelector('#wallet-act-send strong').click();
        assert.deepEqual(calls, ['send']);
        doc.getElementById('wallet-actions-slot').innerHTML = BAR();
        doc.getElementById('wallet-act-identity').click();
        assert.deepEqual(calls, ['send', 'identity'], 'a repainted bar lost its handler or doubled it');
    });
    test('a disabled button opens nothing; an unknown button is ignored', () => {
        const bindWalletActions = need('bindWalletActions');
        const { doc } = dom(`<div id="wallet-dashboard"><div id="wallet-actions-slot">${BAR(true)}</div><button class="wallet-action-btn" id="other">o</button></div>`);
        const calls = [];
        bindWalletActions(doc.getElementById('wallet-dashboard'), { 'wallet-act-send': () => calls.push('send') });
        doc.getElementById('wallet-act-send').click();
        doc.getElementById('other').click();
        assert.deepEqual(calls, []);
    });
});

describe('syncActionBar: the bar follows the data button by button', () => {
    const data = (over = {}) => ({ address: ME, identity: 'Unknown', balance: { transferable: 5 }, staking: { totalStaked: 10, activeStaked: 10, ledgerRead: 'ok' }, ...over });
    const html = (d) => need('actionBarHtml')(d, { esc: escapeHtml, stakeable: Number((d.balance || {}).transferable || 0), payoutButton: '<button class="wallet-action-btn" id="wallet-act-payout"><div><strong>Pay out rewards</strong><span>0 unclaimed entries</span></div></button>' });
    test('the same data: nothing changes', async () => {
        const syncActionBar = need('syncActionBar');
        const { win, doc } = dom(`<div id="wallet-actions-slot">${html(data())}</div>`);
        const slot = doc.getElementById('wallet-actions-slot');
        const count = watch(win, slot);
        assert.equal(syncActionBar(slot, html(data()), { doc }), 'same');
        assert.equal(await count(), 0);
    });
    test('Send closes with its title and the identity label changes, in place: the focused button keeps focus', () => {
        const syncActionBar = need('syncActionBar');
        const { doc } = dom(`<div id="wallet-actions-slot">${html(data())}</div>`);
        const slot = doc.getElementById('wallet-actions-slot');
        const send = doc.getElementById('wallet-act-send'), unstake = doc.getElementById('wallet-act-unstake');
        unstake.focus();
        assert.equal(syncActionBar(slot, html(data({ identity: 'Alice', balance: { transferable: 0 } })), { doc }), 'synced');
        assert.ok(doc.getElementById('wallet-act-send') === send, 'the button node was replaced');
        assert.equal(send.disabled, true);
        assert.equal(send.getAttribute('title'), 'No transferable balance available.');
        assert.equal(doc.querySelector('#wallet-act-identity strong').textContent, 'Update identity');
        assert.ok(doc.activeElement === unstake, 'focus left the bar');
        syncActionBar(slot, html(data({ identity: 'Alice' })), { doc });
        assert.equal(send.disabled, false);
        assert.equal(send.hasAttribute('title'), false, 'the closed title stayed on an open button');
    });
    test('an unsettled bonded state keeps Unstake closed (the stake card\'s rule)', () => {
        const { doc } = dom(html(data({ staking: { totalStaked: 10, activeStaked: 10, ledgerRead: LEDGER_UNSETTLED } })));
        assert.equal(doc.getElementById('wallet-act-unstake').disabled, true);
        assert.equal(doc.getElementById('wallet-act-unstake').getAttribute('title'), 'No active bond to unstake.');
    });
    test('the read-only callout and the bar swap whole', () => {
        const syncActionBar = need('syncActionBar');
        const { doc } = dom('<div id="wallet-actions-slot"><div class="wallet-readonly-callout">read only</div></div>');
        const slot = doc.getElementById('wallet-actions-slot');
        assert.equal(syncActionBar(slot, html(data()), { doc }), 'replaced');
        assert.ok(doc.getElementById('wallet-act-send'));
    });
});

describe('the frame: stable section containers, in page order', () => {
    test('every section has its container, so it can repaint alone', () => {
        const create = need('createWalletSections');
        const sections = create({ doc: dom().doc, post: { subscribe: () => () => {} }, known: { list: () => [] }, data: () => null, setData() {}, fmt,
            payout: { tileHtml: () => '<div class="staking-summary-card" id="wallet-unpaid-tile"></div>' }, multisigName: () => null });
        const { doc } = dom(`<div id="wallet-dashboard">${sections.frameHtml({ address: ME, identity: 'Alice', balance: { total: 1 }, staking: {}, rewards: {}, network: {} },
            { isOwn: true, help: '', historyLink: '', canSwitch: true, viewing: '', usd: '', bar: '<div id="wallet-action-bar"></div>', price: { history: [] }, latestPrice: null })}</div>`);
        const ids = Array.from(doc.querySelectorAll('[id]')).map(e => e.id);
        const ORDER = ['wsec-head', 'wallet-head-name', 'wsec-summary', 'wallet-claimed-value', 'wallet-actions-slot', 'wallet-locks-slot', 'wallet-nominations-slot', 'wallet-multisig-slot',
            'wallet-validator-slot', 'wsec-price', 'wsec-network', 'wsec-validators', 'wsec-rewards', 'wallet-apr-card', 'wsec-recent-tx', 'wallet-advanced-section'];
        for (const id of ORDER) assert.ok(ids.includes(id), 'no container #' + id);
        const at = ORDER.map(id => ids.indexOf(id));
        assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'containers out of page order: ' + ORDER.join(', '));
        assert.equal(doc.getElementById('wallet-head-name').textContent, 'Alice');
    });
});

describe('the proxy list rows', () => {
    test('rows, the deposit, the Remove buttons; a row removed in a block holds its settle word and no button', () => {
        const proxyListHtml = need('proxyListHtml');
        const payload = { proxies: [{ delegate: D1, proxyType: 'Staking', delay: 0 }, { delegate: D2, proxyType: 'Any', delay: 5 }], deposit: 2.5 };
        const { doc } = dom(`<div id="l">${proxyListHtml(payload, { isOwn: true, settling: new Map([[need('proxyKey')(D2, 'Any', 5), 42]]), ...fmt })}</div>`);
        const rows = Array.from(doc.querySelectorAll('tbody tr'));
        assert.equal(rows.length, 2);
        assert.ok(rows[0].querySelector('.proxy-remove-btn[data-delegate="' + D1 + '"][data-proxy-type="Staking"][data-delay="0"]'));
        assert.equal(rows[1].querySelector('.proxy-remove-btn'), null, 'a removed row still offers Remove');
        assert.equal(rows[1].querySelector('.ui-chip.is-positive').textContent.trim(), STRINGS.S5.replace('{n}', '42'));
        assert.match(doc.getElementById('l').textContent, /Deposit reserved: 2\.5000 PDEX/);
    });
    test('no proxies: today\'s words, with the form hint only for the owner', () => {
        const proxyListHtml = need('proxyListHtml');
        const { doc } = dom(`<div id="a">${proxyListHtml({ proxies: [] }, { isOwn: true, ...fmt })}</div><div id="b">${proxyListHtml({ proxies: [] }, { isOwn: false, ...fmt })}</div>`);
        assert.equal(doc.getElementById('a').textContent.trim(), 'No proxies set. Use the form below to add one.');
        assert.equal(doc.getElementById('b').textContent.trim(), 'No proxies set.');
    });
});
