// The payout part of the wallet page after a payout (UX spec sections 2, 4, 5, 7; design R1): the
// Unpaid Rewards tile, the Pay Out button and the payout modal, painted IN PLACE from what the block
// proved, end to end through the real tracker, the real core and a happy-dom page.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readRepo } from './helpers/source.js';
import { harness, flush, READY, IN1, IN2 } from './helpers/tx-harness.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { createPayoutRefresh, payoutModel, payoutSignSet, pairKey, PAYOUT_DOMAIN } from '../lib/payout-refresh.js';
import { STRINGS } from '../lib/refresh-ui.js';
import { escapeHtml } from '../lib/html-escape.js';
import { ME, OTHER, PAIRS, keyOf, REGISTRY, paidItem, otherPageItem, skippedItem, forceBatch, walletWith } from './helpers/payout-events.js';

// The trackers arm real caps (90 s, 120 s); fake them so the file ends when its tests do.
beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => mock.timers.reset());

const fmt = { pdex: (v) => Number(v || 0).toFixed(4), number: (n) => String(n), short: (a) => String(a).slice(0, 6) + '...', esc: escapeHtml };
function memStorage() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; }
function clock(t = 5_000_000) { const c = () => c.t; c.t = t; return c; }

// One page: the wallet card (tile and action bar, from the module's own markup), a typed input
// elsewhere, a scroll container, and the payout modal as index.html has it.
function page({ storage = memStorage(), now = clock(), wallet = walletWith(), listen = null } = {}) {
    const window = new Window();
    const doc = window.document;
    const known = createKnownResults({ storage, now, same: (a, b) => a === b, listen });
    const core = createPostAction({ effects: effectsFor, known, now, log: () => {} });
    const state = { wallet };
    const pr = createPayoutRefresh({ doc, known, post: core, data: () => state.wallet, same: (a, b) => a === b, fmt, now });
    doc.body.innerHTML = `<main id="scroller" style="height:120px;overflow:auto"><div id="wallet-dashboard"><div class="list-container glass" id="card">
        <div class="list-header"><h2>My Account</h2></div>
        <div class="staking-summary-grid"><div class="staking-summary-card"><div class="label">Total Balance</div><div class="value">1.0000 PDEX</div></div>${pr.tileHtml(wallet)}</div>
        <div id="wallet-actions-slot"><div class="wallet-action-bar" id="wallet-action-bar">${pr.buttonHtml(wallet)}</div></div></div>
        <input id="add-proxy-delegate"><div style="height:2000px"></div></div></main>
        <div id="payout-modal" class="modal" style="display: none;"><div class="glass"><h3>Pay Out Rewards</h3>
        <div class="payout-summary"><div><span>Unclaimed entries</span><strong id="payout-count">--</strong></div><div><span>Total to claim</span><strong id="payout-total">--</strong></div></div>
        <div id="payout-entries" class="payout-entries"></div><div id="payout-modal-error" class="staking-error" style="display: none;"></div>
        <button id="submit-payout-tx-btn" class="modal-submit-btn">Sign and pay out</button></div></div>`;
    const q = (s) => doc.querySelector(s);
    return { window, doc, known, core, pr, state, q, storage, now };
}
async function pay(p, pairs, events, { retract = null } = {}) {
    const action = { id: 'p1', key: 'staking.payout', params: { k: pairs.length, remaining: 0, account: ME, pairs } };
    const h = harness({ action, registry: REGISTRY, core: p.core });
    h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY);
    await h.emit(IN1, events);
    if (retract) await retract(h);
    await flush();
    return h;
}
const btn = (p) => p.q('#wallet-act-payout');
const sub = (p) => btn(p).querySelector('span').textContent;
const tileValue = (p) => p.q('#wallet-unpaid-value').textContent.trim();
const live = (p) => (p.q('#post-action-live') ? p.q('#post-action-live').textContent : '');

describe('after inclusion, in place', () => {
    test('the paid rows leave, the total drops, Pay Out offers only the rest; nothing is remounted', async () => {
        const p = page();
        const card = p.q('#card'), button = btn(p), tile = p.q('#wallet-unpaid-tile');
        p.q('#add-proxy-delegate').value = 'typed by the user';
        p.q('#scroller').scrollTop = 60;
        const before = p.q('#scroller').scrollTop;
        assert.equal(tileValue(p), '6.7500 PDEX');
        assert.equal(sub(p), '3 unclaimed entries');
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        assert.equal(tileValue(p), '3.0000 PDEX');
        assert.equal(sub(p), '1 unclaimed entry');
        assert.equal(btn(p).getAttribute('aria-disabled'), null);
        assert.equal(btn(p).disabled, false);
        assert.deepEqual(p.pr.signable(p.state.wallet).map(pairKey), [keyOf(PAIRS[2])], 'the modal would sign a paid pair again');
        assert.equal(p.q('#card'), card, 'the card was remounted');
        assert.equal(btn(p), button, 'the button node was replaced (focus would be lost)');
        assert.equal(p.q('#wallet-unpaid-tile'), tile);
        assert.equal(p.q('#add-proxy-delegate').value, 'typed by the user');
        assert.equal(p.q('#scroller').scrollTop, before);
        assert.equal(live(p), 'Unpaid rewards updated: 2 paid, 1 left.');
        assert.ok(p.q('#wallet-unpaid-value').classList.contains('is-value-changed'), 'no T5 wash on the changed figure');
    });
    test('every entry proven paid: the empty look and words at once, aria-disabled (not disabled), and nothing to sign', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(x => paidItem(x))));
        assert.equal(tileValue(p), '0.0000 PDEX');
        assert.equal(sub(p), '0 unclaimed entries');
        assert.equal(btn(p).getAttribute('aria-disabled'), 'true');
        assert.equal(btn(p).disabled, false, 'disabled would drop focus (U4)');
        assert.equal(btn(p).getAttribute('title'), 'No unclaimed rewards to pay out.');
        assert.deepEqual(p.pr.signable(p.state.wallet), []);
        assert.equal(p.pr.model(p.state.wallet).button, 'empty');
        assert.equal(live(p), 'Unpaid rewards updated: 3 paid, 0 left.');
    });
    test('no Rewarded for this account (paged): rows are not removed and not called paid; Checking holds them out of the next payout', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(otherPageItem)));
        assert.equal(tileValue(p), '6.7500 PDEX', 'an unproven row changed the total');
        assert.equal(sub(p), 'Checking 3 entries');
        assert.equal(btn(p).getAttribute('aria-disabled'), 'true');
        assert.equal(btn(p).getAttribute('title'), STRINGS.S10t);
        const why = p.doc.getElementById(btn(p).getAttribute('aria-describedby'));
        assert.equal(why && why.textContent, STRINGS.S10t);
        assert.deepEqual(p.pr.signable(p.state.wallet), [], 'a held pair would be signed again inside the hold');
        assert.equal(live(p), '3 entries are being checked.');
        assert.ok(!/Paid/.test(p.q('#card').textContent), 'an unproven row says Paid');
    });
    test('the hold ends at its bound: the rows are offered again, the tile says May be behind, the modal opens with S15', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(otherPageItem)));
        p.now.t += p.known.holdMs;
        p.pr.paint({ reason: 'deadline' });
        assert.equal(sub(p), '3 unclaimed entries');
        assert.equal(btn(p).getAttribute('aria-disabled'), null);
        assert.equal(p.pr.signable(p.state.wallet).length, 3, 'a payout that is really due stayed blocked');
        const mark = p.q('#wallet-unpaid-label .ui-chip.is-wait.is-bare');
        assert.ok(mark, 'no bare May be behind mark');
        assert.equal(mark.textContent.trim(), STRINGS.S14);
        assert.ok(mark.querySelector('.bx-error'));
        const m = p.pr.model(p.state.wallet);
        assert.equal(m.state, 'could-not-refresh');
        p.pr.modalLine(m);
        const line = p.q('#payout-modal .ui-panel.is-warn.is-line');
        assert.ok(line && line.textContent.includes(STRINGS.S15), 'no S15 line in the modal');
        assert.ok(line.compareDocumentPosition(p.q('.payout-summary')) & 4, 'S15 is not the first line of the modal');
        p.now.t += p.known.maxAgeMs;
        p.pr.paint({ reason: 'resume' });
        assert.equal(p.q('#wallet-unpaid-label .ui-chip'), null, 'the mark outlived its age bound');
        p.pr.modalLine(p.pr.model(p.state.wallet));
        assert.equal(p.q('#payout-modal .ui-panel'), null);
    });
    test('U8: one paid, one skipped, one unproven: the paid row leaves, the other two are Checking; one merged announcement', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(paidItem(PAIRS[0]), skippedItem(), otherPageItem(PAIRS[2])));
        assert.equal(tileValue(p), '5.2500 PDEX');
        assert.equal(sub(p), 'Checking 2 entries');
        assert.equal(live(p), 'Unpaid rewards updated: 1 paid, 2 left. 2 entries are being checked.');
        assert.ok(!p.q('.ui-chip.is-error') && !p.q('.ui-panel.is-error'), 'red for a skipped item (U8: nothing failed for the user)');
    });
    test('a failed payout changes nothing on the page', async () => {
        const p = page();
        const html = p.q('#card').innerHTML;
        await pay(p, PAIRS, forceBatch(skippedItem(), skippedItem(), skippedItem()));
        assert.equal(p.q('#card').innerHTML, html);
        assert.equal(live(p), '');
    });
    test('a button blocked by a failed refresh is never re-enabled by a paint', async () => {
        const p = page();
        btn(p).disabled = true;
        btn(p).title = 'Refresh failed, actions are blocked.';
        await pay(p, PAIRS.slice(0, 1), forceBatch(paidItem(PAIRS[0])));
        p.pr.paint({ reason: 'deadline' });
        assert.equal(btn(p).disabled, true);
        assert.equal(btn(p).title, 'Refresh failed, actions are blocked.');
    });
});

describe('reorg', () => {
    test('Retracted: the rows return, S17 at the top of the card, Pay Out says S18 aria-disabled, A6 once; back in a block settles again', async () => {
        const p = page();
        const events = forceBatch(...PAIRS.map(x => paidItem(x)));
        await pay(p, PAIRS, events, { retract: async (h) => {
            await h.emit({ type: 'Retracted' }); await flush();
            assert.equal(tileValue(p), '6.7500 PDEX');
            const line = p.q('#card .ui-panel.is-warn.is-line');
            assert.ok(line, 'no S17 line');
            assert.equal(line.textContent.trim(), 'The block with your payout was replaced by the network. It is being sent again, so the items below are listed until it is back in a block.');
            assert.ok(line.compareDocumentPosition(p.q('.staking-summary-grid')) & 4, 'S17 is not above the figures');
            assert.equal(sub(p), STRINGS.S18);
            assert.equal(btn(p).getAttribute('aria-disabled'), 'true');
            assert.deepEqual(p.pr.signable(p.state.wallet), [], 'a payout being re-sent could be signed again');
            assert.match(live(p), /The payout is not confirmed any more\. The items are listed again while it is sent again\./);
            assert.equal(p.q('#wallet-unpaid-label .ui-chip'), null, 'two accents on one component (U14)');
            await h.emit(IN2, events); await flush();
        } });
        assert.equal(p.q('#card .ui-panel'), null, 'S17 stayed after re-inclusion');
        assert.equal(tileValue(p), '0.0000 PDEX');
        assert.equal(sub(p), '0 unclaimed entries');
    });
    test('Retracted, then dropped by the pool: S17 leaves, the rows are normal again', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(x => paidItem(x))), { retract: async (h) => { await h.emit({ type: 'Retracted' }); await h.emit({ type: 'Dropped' }); } });
        assert.equal(p.q('#card .ui-panel'), null);
        assert.equal(sub(p), '3 unclaimed entries');
        assert.equal(btn(p).getAttribute('aria-disabled'), null);
    });
});

describe('reload, second tab, wallet switch', () => {
    test('a reload in between: the stale server list is drawn with the overlay from the first paint', async () => {
        const storage = memStorage(), now = clock();
        const a = page({ storage, now });
        await pay(a, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        const b = page({ storage, now });   // fresh load, server still returns all three
        assert.equal(tileValue(b), '3.0000 PDEX');
        assert.equal(sub(b), '1 unclaimed entry');
        assert.deepEqual(b.pr.signable(b.state.wallet).map(pairKey), [keyOf(PAIRS[2])]);
        assert.equal(live(b), '', 'a fresh load announced');
    });
    test('the modal re-opened after the payout lists and counts only the unpaid pair, keyed', async () => {
        const p = page();
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        const m = p.pr.model(p.state.wallet);
        assert.equal(m.button, 'enabled');
        p.q('#payout-entries').innerHTML = p.pr.rowsHtml(m.payable);
        const rows = Array.from(p.doc.querySelectorAll('#payout-entries .payout-entry'));
        assert.deepEqual(rows.map(r => r.getAttribute('data-key')), [keyOf(PAIRS[2])]);
        assert.equal(m.payableTotal, 3);
    });
    test('a second tab with the modal open: rows leave in place, the count and total follow, nothing is announced', async () => {
        const storage = memStorage(), now = clock();
        const listeners = [];
        const b = page({ storage, now, listen: (f) => listeners.push(f) });
        const m0 = b.pr.model(b.state.wallet);
        b.q('#payout-entries').innerHTML = b.pr.rowsHtml(m0.payable);
        b.q('#payout-count').textContent = '3';
        b.q('#payout-modal').style.display = 'flex';
        const keep = b.q(`#payout-entries [data-key="${keyOf(PAIRS[2])}"]`);
        const a = page({ storage, now });
        await pay(a, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        listeners.forEach(f => f({ key: 'pdex_known_results' }));
        const rows = Array.from(b.doc.querySelectorAll('#payout-entries .payout-entry'));
        assert.deepEqual(rows.map(r => r.getAttribute('data-key')), [keyOf(PAIRS[2])]);
        assert.equal(rows[0], keep, 'the remaining row was rebuilt');
        assert.equal(b.q('#payout-count').textContent, '1');
        assert.equal(b.q('#payout-total').textContent, '3.0000 PDEX');
        assert.equal(sub(b), '1 unclaimed entry');
        assert.equal(live(b), '', 'the other tab announced (U10)');
    });
    test('a wallet switch: nothing from account A is drawn on account B', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(x => paidItem(x))));
        p.state.wallet = walletWith(undefined, OTHER);
        p.pr.paint({ reason: 'render' });
        assert.equal(tileValue(p), '6.7500 PDEX');
        assert.equal(sub(p), '3 unclaimed entries');
        assert.equal(p.pr.signable(p.state.wallet).length, 3);
        p.state.wallet = walletWith();
        assert.equal(p.pr.signable(p.state.wallet).length, 0, 'A\'s result was lost on the way back');
    });
    test('storage that throws (private mode): the same result in memory, no error', async () => {
        const p = page({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        assert.equal(sub(p), '1 unclaimed entry');
    });
});

describe('markup and model', () => {
    const norm = (s) => s.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
    test('with nothing known the button and the tile are today\'s markup', () => {
        const p = page();
        const w = walletWith();
        assert.equal(norm(p.pr.buttonHtml(w)), norm(`<button class="wallet-action-btn" id="wallet-act-payout"><i class='bx bx-gift'></i><div><strong>Pay out rewards</strong><span>3 unclaimed entries</span></div></button><span id="wallet-payout-why" class="sr-only"></span>`));
        const none = walletWith([]);
        assert.equal(norm(p.pr.buttonHtml(none)), norm(`<button class="wallet-action-btn" id="wallet-act-payout" disabled title="No unclaimed rewards to pay out."><i class='bx bx-gift'></i><div><strong>Pay out rewards</strong><span>0 unclaimed entries</span></div></button><span id="wallet-payout-why" class="sr-only"></span>`));
        assert.equal(norm(p.pr.tileHtml(w)), norm(`<div class="staking-summary-card" id="wallet-unpaid-tile"><div class="label" id="wallet-unpaid-label">Unpaid Rewards</div><div class="value" id="wallet-unpaid-value" style="color:var(--brand-primary);">6.7500 PDEX</div></div>`));
        const computing = { ...w, rewards: { ...w.rewards, unclaimedFresh: false } };
        // Fidelity review R4: the faint "computing..." note became the bare S1 mark in the label row; the value is the figure alone.
        assert.equal(norm(p.pr.tileHtml(computing)), norm(`<div class="staking-summary-card" id="wallet-unpaid-tile"><div class="label" id="wallet-unpaid-label">Unpaid Rewards<span class="ui-chip is-wait is-bare"><i class="bx bx-loader-alt bx-spin" aria-hidden="true"></i>Updating</span></div><div class="value" id="wallet-unpaid-value" style="color:var(--brand-primary);">6.7500 PDEX</div></div>`));
    });
    test('the model: counts from unpaidCount (the list is capped at 200), totals by subtraction', () => {
        const rewards = { unpaidTotal: 100, unpaidCount: 250, unpaidEntries: PAIRS.map(x => ({ ...x, amount: 1 })) };
        const applied = { removed: [{ key: keyOf(PAIRS[0]), block: 9 }], held: [{ key: keyOf(PAIRS[1]) }], expired: [], reorg: null };
        const m = payoutModel(rewards, applied);
        assert.equal(m.count, 249);
        assert.equal(m.payableCount, 248);
        assert.equal(m.total, 99);
        assert.deepEqual(m.payable.map(pairKey), [keyOf(PAIRS[2])]);
        assert.equal(m.button, 'enabled');
        assert.equal(PAYOUT_DOMAIN, 'rewards.unpaid');
    });
    test('index.html carries the one shared live region', () => {
        assert.match(readRepo('index.html', import.meta.url), /<div id="post-action-live" class="sr-only" aria-live="polite" aria-atomic="true"><\/div>/);
    });
});

// Review follow-up F2: what is signed is never more than the modal lists. Decision (one that cannot surprise
// the user): sign the rows the modal SHOWS that are still signable, in the order shown. A row signable now
// but not shown (a hold that ended while the modal was open) is never added; a shown row that is no longer
// signable (proven paid since) is left out, so it cannot fail AlreadyClaimed and add fee.
describe('F2: payoutSignSet signs only what the modal shows', () => {
    const E = PAIRS.map((x, i) => ({ ...x, amount: i + 1 }));
    const k = (i) => keyOf(PAIRS[i]);
    const CASES = [
        ['shown equals signable', [E[0], E[1]], [k(0), k(1)], [k(0), k(1)]],
        ['a hold ended while open: signable has an extra row, not signed', [E[0], E[1], E[2]], [k(0), k(1)], [k(0), k(1)]],
        ['a shown row was proven paid since: left out', [E[1]], [k(0), k(1)], [k(1)]],
        ['nothing shown: nothing signed', [E[0], E[1]], [], []],
        ['no shown list at all: nothing signed', [E[0]], null, []],
        ['nothing signable: nothing signed', [], [k(0)], []],
        ['the order is the order shown', [E[0], E[1], E[2]], [k(2), k(0)], [k(2), k(0)]],
        ['a key shown twice is signed once', [E[0]], [k(0), k(0)], [k(0)]]
    ];
    for (const [name, signable, shown, want] of CASES) {
        test(name, () => {
            const got = payoutSignSet(signable, shown);
            assert.deepEqual(got.map(pairKey), want);
            assert.ok(got.length <= (shown || []).length, 'signed more than the modal lists');
        });
    }
});

describe('review minors: the May be behind tile and the mark', () => {
    test('while S14 shows, the tile value is in --text-primary; back to --brand-primary when it goes', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(otherPageItem)));
        p.now.t += p.known.holdMs;
        p.pr.paint({ reason: 'deadline' });
        const value = p.q('#wallet-unpaid-value');
        assert.match(value.getAttribute('style'), /var\(--text-primary\)/, 'a figure that may be behind keeps the brand colour');
        assert.match(p.pr.tileHtml(p.state.wallet), /id="wallet-unpaid-value" style="color:var\(--text-primary\);"/);
        p.now.t += p.known.maxAgeMs;
        p.pr.paint({ reason: 'resume' });
        assert.match(value.getAttribute('style'), /var\(--brand-primary\)/);
    });
    test('a mark left with another role is swapped in place (setChip): role, icon and word together', async () => {
        const p = page();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(otherPageItem)));
        p.now.t += p.known.holdMs;
        p.q('#wallet-unpaid-label').insertAdjacentHTML('beforeend', '<span class="ui-chip is-positive is-bare"><i class="bx bx-check" aria-hidden="true"></i>Old</span>');
        p.pr.paint({ reason: 'deadline' });
        const marks = p.q('#wallet-unpaid-label').querySelectorAll('.ui-chip');
        assert.equal(marks.length, 1);
        assert.ok(marks[0].classList.contains('is-wait') && !marks[0].classList.contains('is-positive'), 'the old role stayed');
        assert.ok(marks[0].classList.contains('is-bare'));
        assert.ok(marks[0].querySelector('.bx-error') && !marks[0].querySelector('.bx-check'));
        assert.equal(marks[0].textContent.trim(), STRINGS.S14);
    });
});

// R2: the server says how far it has indexed (lib/freshness.js). The payout component re-reads /api/wallet on
// each poll attempt (through the page's refetch, here a fake server), and what the server says decides when
// the Checking holds end, when the proven-paid overlay ends, and when the page must say it may be behind.
describe('R2: freshness and polling', () => {
    const WALLET_DOMAINS = ['balance', 'staking.ledger', 'staking.nominations', 'rewards.unpaid', 'rewards.claimed', 'tx.recent'];
    const fresh = (chain, extra = {}) => ({ v: 1, chainHead: 999, indexed: { chain, rewards: 999, tx: 999 }, since: { chain: 1, rewards: 1, tx: 1 },
        kv: { council: null, democracy: null, treasury: null }, pending: [], intervalMs: { chain: 12_000, rewards: 60_000, tx: 30_000 }, ...extra });
    // The page with the R2 core (caughtUp injected, timers recorded) and a server the test moves by hand.
    async function polled({ listed = PAIRS, chain = 10 } = {}) {
        const { caughtUp, pollDeadlineMs } = await import('../lib/freshness.js');
        const now = clock();
        const window = new Window();
        const doc = window.document;
        const known = createKnownResults({ storage: memStorage(), now });
        const timers = [];
        const core = createPostAction({ effects: effectsFor, known, now, log: () => {}, caughtUp, deadlineMs: pollDeadlineMs,
            setTimer: (f, ms) => { const t = { f, at: now.t + ms, live: true }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; } });
        const srv = { chain, listed, reads: [] };
        const payload = () => ({ ...walletWith(srv.listed.map((p, i) => ({ ...p, amount: [1.5, 2.25, 3][PAIRS.indexOf(p)] ?? 1 }))), freshness: fresh(srv.chain) });
        const state = { wallet: payload() };
        const refetch = (address) => { srv.reads.push(address); state.wallet = payload(); return Promise.resolve(state.wallet.freshness); };
        const pr = createPayoutRefresh({ doc, known, post: core, data: () => state.wallet, same: (a, b) => a === b, fmt, now, refetch });
        doc.body.innerHTML = `<div id="wallet-dashboard"><div class="list-container glass" id="card"><div class="staking-summary-grid">${pr.tileHtml(state.wallet)}</div>
            <div class="wallet-action-bar" id="wallet-action-bar">${pr.buttonHtml(state.wallet)}</div></div></div>
            <div id="payout-modal" class="modal" style="display: none;"><div class="glass"><div class="payout-summary"><strong id="payout-count">--</strong><strong id="payout-total">--</strong></div>
            <div id="payout-entries"></div><button id="submit-payout-tx-btn">Sign and pay out</button></div></div>`;
        const q = (s) => doc.querySelector(s);
        const step = async () => { const t = timers.filter(x => x.live).sort((a, b) => a.at - b.at)[0]; assert.ok(t, 'no poll armed'); t.live = false; now.t = Math.max(now.t, t.at); t.f(); await flush(); await flush(); };
        const armed = () => timers.filter(x => x.live).length;
        return { doc, q, known, core, pr, state, srv, now, step, armed, timers, WALLET_DOMAINS };
    }
    const mark = (p) => p.q('#wallet-unpaid-label .ui-chip');

    test('a payout In block re-reads the wallet at once (no 2.5 s timer), then backs off until the server has the block', async () => {
        const p = await polled();
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        await flush();
        assert.deepEqual(p.srv.reads, [ME], 'the first read is not at inclusion');
        assert.equal(p.armed(), 1);
        p.srv.chain = 42; p.srv.listed = [PAIRS[2]];
        await p.step();
        assert.equal(p.srv.reads.length, 2);
        assert.equal(p.armed(), 0, 'still polling after the server caught up');
    });
    test('the overlay ends on catch-up: the server has the block and dropped the paid rows; no mark, state current', async () => {
        const p = await polled();
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        assert.equal(p.pr.model(p.state.wallet).state, 'known-result');
        p.srv.chain = 42; p.srv.listed = [PAIRS[2]];
        await p.step();
        const m = p.pr.model(p.state.wallet);
        assert.equal(m.state, 'current');
        assert.equal(m.removedRows.length, 0);
        assert.equal(mark(p), null);
        assert.equal(p.q('#wallet-act-payout span').textContent, '1 unclaimed entry');
    });
    test('F7 lag: the server has the block and STILL lists a proven-paid row: never offered, never silent (S14 on the tile, S15 in the modal)', async () => {
        const p = await polled();
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        p.srv.chain = 42;                                   // caught up, but the list still has all three
        await p.step();
        const m = p.pr.model(p.state.wallet);
        assert.deepEqual(m.signable.map(pairKey), [keyOf(PAIRS[2])], 'a proven-paid pair is offered again');
        assert.equal(m.state, 'could-not-refresh');
        assert.ok(mark(p) && mark(p).textContent.trim() === STRINGS.S14, 'the tile does not say May be behind');
        assert.equal(p.q('#wallet-act-payout span').textContent, '1 unclaimed entry');
        p.pr.modalLine(m);
        assert.ok(p.q('#payout-modal .ui-panel.is-warn.is-line').textContent.includes(STRINGS.S15));
        assert.ok(!/Paid in block/.test(p.q('#card').textContent), 'the page claims the lagging row was paid');
        p.srv.listed = [PAIRS[2]];                          // the server drops them: the mark goes
        p.core.notify({ account: ME, domains: ['rewards.unpaid'], block: 42, reason: 'inBlock' });
        await flush(); await flush();
        assert.equal(p.pr.model(p.state.wallet).state, 'current');
        assert.equal(mark(p), null);
    });
    test('Checking ends as soon as the server answers at or beyond the inclusion block: a still-listed row is a normal unpaid row (S19)', async () => {
        const p = await polled();
        await pay(p, PAIRS, forceBatch(...PAIRS.map(otherPageItem)));
        assert.equal(p.q('#wallet-act-payout span').textContent, 'Checking 3 entries');
        p.srv.chain = 42;
        await p.step();
        const m = p.pr.model(p.state.wallet);
        assert.equal(m.button, 'enabled');
        assert.equal(m.payable.length, 3);
        assert.equal(m.state, 'current', 'a row the server confirms unpaid is not "may be behind"');
        assert.equal(p.q('#wallet-act-payout span').textContent, '3 unclaimed entries');
        assert.equal(p.q('#wallet-act-payout').getAttribute('aria-disabled'), null);
        assert.equal(mark(p), null);
    });
    test('could-not-refresh when polling gives up: the server never reaches the block in 180 s; proven rows stay out, the tile says S14', async () => {
        const p = await polled();
        await pay(p, PAIRS.slice(0, 2), forceBatch(paidItem(PAIRS[0]), paidItem(PAIRS[1])));
        while (p.armed()) await p.step();
        assert.ok(p.now.t - 5_000_000 >= 180_000);
        const m = p.pr.model(p.state.wallet);
        assert.equal(m.state, 'could-not-refresh');
        assert.deepEqual(m.signable.map(pairKey), [keyOf(PAIRS[2])]);
        assert.ok(mark(p) && mark(p).textContent.trim() === STRINGS.S14);
    });
    test('the component subscribes to every domain /api/wallet serves; only a poll attempt re-reads (a repaint does not)', async () => {
        const p = await polled({ chain: 999 });
        for (const d of p.WALLET_DOMAINS) {
            p.core.notify({ account: ME, domains: [d], block: null, reason: 'recheck' });
        }
        await flush();
        assert.deepEqual(p.srv.reads, [], 'a repaint re-read the server');
        p.core.notify({ account: ME, domains: ['tx.recent'], block: 42, reason: 'inBlock' });
        await flush();
        assert.deepEqual(p.srv.reads, [ME], 'tx.recent is not served by this component');
    });
});
