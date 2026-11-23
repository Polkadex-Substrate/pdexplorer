// The script.js glue of the payout refresh, EXECUTED (review follow-up): until now openPayoutModal,
// submitPayoutTx and the dashboard render were only text-matched. Here the real functions are lifted
// from script.js (bodyOf, as test/wallet-session-revision.test.js lifts submitSignedTx), together with
// the three lines that create the store, the core and the payout view, and run in a vm context over a
// happy-dom page with the real modules: the real tracker (lib/tx-submit.js), the real effects and the
// real known-results store. Only the chain and the wallet are fakes; nothing is broadcast anywhere.
//
// Also here: F2 (the signed set never exceeds the rows the modal lists) through the same glue, and F8
// (the reload after an action keeps the page: no saved-snapshot paint, no banner flash) on the real
// fetchWalletDashboard. Addresses are the public substrate dev accounts (test/helpers/payout-events.js).

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { readRepo, bodyOf } from './helpers/source.js';
import { trackSignedTx, WALLET_CHANGED_STALE } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs, samePayload } from '../lib/freshness.js';
import * as payoutRefreshModule from '../lib/payout-refresh.js';
import { escapeHtml } from '../lib/html-escape.js';
import { ME, V1, V2, V3, REGISTRY, paidItem, forceBatch, walletWith, keyOf } from './helpers/payout-events.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const HTML = readRepo('index.html', import.meta.url);
const GENESIS = '0x' + '11'.repeat(32);
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const line = (start) => { const i = SCRIPT.indexOf(start); assert.ok(i >= 0, 'not in script.js: ' + start); return SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };

// The page the functions run on: the wallet root and the payout modal exactly as index.html has it.
function payoutPage({ extraSrc = [], ctxOver = {} } = {}) {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    const a = HTML.indexOf('<div id="payout-modal"');
    const modal = HTML.slice(a, HTML.indexOf('<div id="multisig-review-modal"', a));
    doc.body.innerHTML = `<div id="wallet-dashboard"></div>${modal}`;
    const timers = [];
    const calls = { built: [], refresh: [], notices: [] };
    let onStatus = null;
    const api = {
        registry: REGISTRY, genesisHash: { toHex: () => GENESIS },
        on() {}, off() {},
        rpc: { chain: { getHeader: async (h) => ({ number: { toNumber: () => (h === '0xb1' ? 42 : 99) } }) } }
    };
    const tx = { signAsync: async () => ({ send: async (cb) => { onStatus = cb; return () => {}; } }) };
    const noop = () => '';
    const ctx = {
        console, Promise, Object, JSON, Array, Map, Set, String, Number, Math, Date, encodeURIComponent,
        window: win, document: doc, navigator: { clipboard: { writeText: async () => {} } },
        // Timers the page arms itself (the core's hold bound, the 2.5 s dashboard reload): recorded, run by hand.
        setTimeout: (f, ms) => { const t = { f, ms, live: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.live = false; },
        globalApi: api, liveRuntimeError: () => null, WALLET_CHANGED_STALE,
        walletSession: { signingCheck: () => () => true }, getStoredWallet: () => ME, isSameAddress: (x, y) => x === y,
        multisigStore: { find: () => null }, multisigUI: { review: async () => {} },
        resolveWalletSigner: async () => ({ account: { address: ME }, signer: {} }),
        trackSignedTx, showTxStatus: (act, st, ev, err, ex) => buildTxModel(act, st, ev, err, ex),
        createKnownResults, createPostAction, effectsFor, caughtUp, pollDeadlineMs, samePayload, ...payoutRefreshModule,
        batchTx: (_api, list) => { calls.built.push(list); return tx; },
        buildPayoutCall: (_api, validator, era) => ({ era, validator }),
        refreshWalletDashboardFor: (address) => { calls.refresh.push(address); },
        showTxNotice: (m) => { calls.notices.push(m); },
        stakingFormatPDEX: (v) => Number(v || 0).toFixed(4), stakingFormatNumber: (n) => String(n),
        stakingShortAddress: (x) => String(x).slice(0, 6) + '...', stakingEscapeHtml: escapeHtml,
        getStakeableBalance: () => 0, hasInjectedWalletNow: () => true, readWalletValidator: () => Promise.resolve(null),
        walletAprData: null, walletFetchGen: 0, walletRecentStore: null, VALIDATE_ON: false,
        openSendModal() {}, openStakeModal() {}, openUnstakeModal() {}, openIdentityModal() {}, openWalletPicker() {}, disconnectWallet() {}
    };
    Object.assign(ctx, ctxOver);
    for (const n of ['helpIcon', 'rewardHistoryLinkHtml', 'walletViewingSlotHtml', 'renderUsdSubscript', 'buildViewOnlyCallout', 'formatDuration', 'formatLocalDate',
        'makeTable', 'mountWalletRecentTx', 'fetchApiJson', 'bindViewOnlyCalloutHandlers', 'applyWalletActionBlock', 'scheduleWalletSigningRechecks',
        'mountBalanceLocks', 'lockActionDeps', 'mountNominationStatus', 'renderWalletAdvancedSection', 'refreshWalletMultisigs', 'renderWalletAprCard',
        'renderWalletPriceChart', 'walletValidatorCard', 'looksLikeTxHash']) if (!(n in ctxOver)) ctx[n] = noop;
    vm.createContext(ctx);
    const src = [
        'let currentWalletData = null;',
        line('const knownResults = createKnownResults('), line('const postAction = createPostAction('), line('const payoutRefresh = createPayoutRefresh('),
        line('const PAYOUT_BATCH_MAX = '),
        bodyOf(SCRIPT, 'renderWalletDashboard'), bodyOf(SCRIPT, 'bindWalletActionHandlers'), bodyOf(SCRIPT, 'openPayoutModal'),
        'async ' + bodyOf(SCRIPT, 'submitPayoutTx'), 'async ' + bodyOf(SCRIPT, 'submitSignedTx'),
        ...extraSrc,
        'globalThis.__glue = { knownResults, postAction, payoutRefresh, data: () => currentWalletData };'
    ].join('\n');
    vm.runInContext(src, ctx);
    const emit = async (status, events) => { onStatus({ status, events, txHash: { toHex: () => '0x' + 'cd'.repeat(32) } }); await flush(); };
    const q = (s) => doc.querySelector(s);
    const rows = () => Array.from(doc.querySelectorAll('#payout-entries .payout-entry[data-key]')).map(r => r.getAttribute('data-key'));
    return { win, doc, ctx, calls, timers, emit, q, rows, glue: ctx.__glue, sent: () => onStatus !== null };
}
const dashboard = (rewardsOf) => ({ address: ME, staking: {}, balance: { total: 100 }, rewards: rewardsOf.rewards });

describe('the payout glue in script.js, executed', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });   // the tracker's caps (90 s, 120 s)
    afterEach(() => mock.timers.reset());

    test('render, open, sign, In block with Rewarded for the account: the modal closes, the tile and button update, re-open lists only what is left', async () => {
        const p = payoutPage();
        const vs = [V1, V2, V3];
        const entries = Array.from({ length: 31 }, (_, i) => ({ era: 400 + i, validator: vs[i % 3], amount: 1 + i / 100 }));
        const wallet = dashboard(walletWith(entries));
        p.ctx.renderWalletDashboard(wallet, { history: [], configured: false }, null);
        const btn = () => p.q('#wallet-act-payout');
        assert.equal(btn().querySelector('span').textContent, '31 unclaimed entries');
        btn().click();
        assert.equal(p.q('#payout-modal').style.display, 'flex', 'the button did not open the modal');
        assert.equal(p.rows().length, 31);
        assert.equal(p.q('#payout-count').textContent, '31');

        await p.ctx.submitPayoutTx();
        await flush();
        assert.ok(p.sent(), 'nothing was sent');
        assert.equal(p.calls.built.length, 1);
        assert.deepEqual(p.calls.built[0].map(c => keyOf(c)), entries.slice(0, 30).map(keyOf), 'the batch is not the first 30 rows the modal lists');

        await p.emit({ type: 'Ready' });
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, forceBatch(...entries.slice(0, 30).map(e => paidItem(e))));
        await flush();
        assert.equal(p.q('#payout-modal').style.display, 'none', 'the modal stayed open after the payout was in a block');
        assert.equal(btn().querySelector('span').textContent, '1 unclaimed entry', 'the button still offers the paid entries');
        assert.equal(p.q('#wallet-unpaid-value').textContent.trim(), (1.30).toFixed(4) + ' PDEX', 'the tile still counts the paid entries');
        // R2: the fixed 2.5 s dashboard reload is gone; the core re-reads at inclusion and polls on evidence.
        assert.ok(!p.timers.some(t => t.ms === 2500), 'the 2.5 s dashboard reload after the payout is still armed');
        assert.deepEqual(p.calls.refresh, [ME], 'the inclusion did not re-read the dashboard at once');
        assert.equal(p.glue.knownResults.list('rewards.unpaid', ME).filter(e => e.op === 'remove').length, 30);

        btn().click();
        assert.equal(p.q('#payout-modal').style.display, 'flex');
        assert.deepEqual(p.rows(), [keyOf(entries[30])], 're-open lists paid entries again');
        assert.equal(p.q('#payout-count').textContent, '1');
    });

    test('F2: a hold ends while the modal is open (no repaint): the batch carries only the rows the modal lists', async () => {
        mock.timers.reset();
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 50_000_000 });
        const p = payoutPage();
        const entries = [{ era: 501, validator: V1, amount: 1 }, { era: 501, validator: V2, amount: 2 }, { era: 502, validator: V3, amount: 3 }];
        p.glue.knownResults.add([{ account: ME, domain: 'rewards.unpaid', op: 'hold', key: keyOf(entries[2]), txHash: '0x01', block: 7 }]);
        p.ctx.renderWalletDashboard(dashboard(walletWith(entries)), { history: [], configured: false }, null);
        p.q('#wallet-act-payout').click();
        assert.deepEqual(p.rows(), entries.slice(0, 2).map(keyOf));
        mock.timers.tick(p.glue.knownResults.holdMs + 1);   // silent expiry: the bound passes, nothing repaints the modal
        assert.equal(p.glue.payoutRefresh.signable(p.glue.data()).length, 3, 'the scenario needs a signable set larger than the list');
        await p.ctx.submitPayoutTx();
        await flush();
        assert.equal(p.calls.built.length, 1);
        assert.deepEqual(p.calls.built[0].map(c => keyOf(c)), entries.slice(0, 2).map(keyOf), 'signed an entry the modal did not list');
    });
});

describe('F8: the reload after an action keeps the page', () => {
    function fetchWorld({ dashboardShown = true } = {}) {
        const win = new Window();
        const doc = win.document;
        doc.body.innerHTML = `<div id="wallet-dashboard">${dashboardShown ? '<div class="wallet-action-bar" id="wallet-action-bar"></div>' : ''}</div>`;
        const log = { renders: [], banners: [], loading: 0 };
        const ctx = {
            console, Promise, encodeURIComponent, document: doc,
            walletFetchGen: 0, currentWalletData: dashboardShown ? { address: ME } : null, isSameAddress: (x, y) => x === y,
            readWalletCache: () => ({ wallet: { address: ME, cached: true }, savedAt: 1 }),
            renderWalletDashboard: (d, _p, _r, o) => { log.renders.push(o && o.live === false ? 'cache' : 'live'); },
            showWalletStaleBanner: (_root, _at, kind) => { log.banners.push(kind); }, clearWalletStaleBanner() {},
            renderWalletLoading: () => { log.loading++; return () => {}; },
            fetch: () => new Promise(() => {})   // the live payload is still in flight
        };
        vm.createContext(ctx);
        vm.runInContext('async ' + bodyOf(SCRIPT, 'fetchWalletDashboard'), ctx);
        return { ctx, log };
    }
    test('keepPage over the dashboard on screen: no snapshot paint, no saved-snapshot banner, no skeleton', async () => {
        const w = fetchWorld();
        await w.ctx.fetchWalletDashboard(ME, { keepPage: true });
        assert.deepEqual(w.log.renders, [], 'the reload repainted the saved snapshot over the page');
        assert.deepEqual(w.log.banners, [], 'the saved-snapshot banner flashed');
        assert.equal(w.log.loading, 0, 'the reload replaced the page with the loading skeleton');
    });
    test('a first load still paints the saved snapshot with its banner', async () => {
        const w = fetchWorld();
        await w.ctx.fetchWalletDashboard(ME);
        assert.deepEqual(w.log.renders, ['cache']);
        assert.deepEqual(w.log.banners, ['cached']);
    });
    test('keepPage when the dashboard is not on screen falls back to the snapshot paint', async () => {
        const w = fetchWorld({ dashboardShown: false });
        await w.ctx.fetchWalletDashboard(ME, { keepPage: true });
        assert.deepEqual(w.log.renders, ['cache']);
    });
});

// R2, end to end with NO 2.5 s timer: the real refreshWalletDashboardFor and fetchWalletDashboard are lifted too,
// and a fake server answers /api/wallet with a freshness field the test moves. The poll re-reads at inclusion,
// backs off, and stops when the server has indexed the inclusion block.
describe('R2: the payout flow polls the server on evidence', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());
    const entries = [{ era: 501, validator: V1, amount: 1.5 }, { era: 501, validator: V2, amount: 2.25 }, { era: 502, validator: V3, amount: 3 }];
    function world() {
        const srv = { chain: 10, listed: entries.slice(), walletReads: 0 };
        const body = () => ({ ...dashboard(walletWith(srv.listed)), freshness: { v: 1, chainHead: 999, indexed: { chain: srv.chain, rewards: 999, tx: 999 },
            since: { chain: 1, rewards: 1, tx: 1 }, kv: { council: null, democracy: null, treasury: null }, pending: [], intervalMs: { chain: 12000, rewards: 60000, tx: 30000 } } });
        const fetch = async (url) => {
            if (url.startsWith('/api/wallet/')) { srv.walletReads++; const b = body(); return { ok: true, status: 200, json: async () => b }; }
            if (url.startsWith('/api/price-history')) return { ok: true, status: 200, json: async () => ({ history: [], configured: false }) };
            return { ok: true, status: 200, json: async () => null };
        };
        const p = payoutPage({
            extraSrc: [bodyOf(SCRIPT, 'isWalletRoute'), bodyOf(SCRIPT, 'refreshWalletDashboardFor'), 'async ' + bodyOf(SCRIPT, 'fetchWalletDashboard')],
            ctxOver: { fetch, readRouteFromLocation: () => 'wallet', readWalletCache: () => null, renderWalletLoading: () => () => {},
                clearWalletStaleBanner() {}, clearWalletActionBlock() {}, writeWalletCache() {}, maybeRunWalletEntryIntent() {}, repaintWalletPriceCard() {},
                renderWalletAprCard() {}, showWalletStaleBanner() {}, disableWalletActions() {}, walletAprData: null }
        });
        return { p, srv };
    }
    const pollTimers = (p) => p.timers.filter(t => t.live && t.ms !== p.glue.knownResults.holdMs + 1);
    const runNext = async (p) => { const t = pollTimers(p).sort((a, b) => a.ms - b.ms)[0]; assert.ok(t, 'no poll armed'); t.live = false; t.f(); await flush(); await flush(); return t; };

    test('pay two of three: re-read at inclusion, poll at 2 s while the server lags, stop when it has the block; no 2.5 s timer', async () => {
        const { p, srv } = world();
        await p.ctx.fetchWalletDashboard(ME);
        await flush();
        assert.equal(p.q('#wallet-act-payout span').textContent, '3 unclaimed entries');
        p.q('#wallet-act-payout').click();
        const rows = p.rows();
        assert.equal(rows.length, 3);
        p.q('#payout-entries .payout-entry[data-key="' + keyOf(entries[2]) + '"]').remove();   // the user pays two
        await p.ctx.submitPayoutTx();
        await flush();
        await p.emit({ type: 'Ready' });
        const before = srv.walletReads;
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, forceBatch(paidItem(entries[0]), paidItem(entries[1])));
        await flush(); await flush();
        assert.equal(srv.walletReads, before + 1, 'the inclusion did not re-read /api/wallet');
        assert.ok(!p.timers.some(t => t.ms === 2500), 'the fixed 2.5 s reload is back');
        assert.equal(p.q('#wallet-act-payout span').textContent, '1 unclaimed entry', 'the overlay did not survive the re-render');
        assert.equal(pollTimers(p).length, 1);
        assert.equal(pollTimers(p)[0].ms, 2000);
        await runNext(p);
        assert.equal(srv.walletReads, before + 2);
        assert.equal(pollTimers(p)[0].ms, 4000);
        srv.chain = 42; srv.listed = [entries[2]];
        await runNext(p);
        assert.equal(srv.walletReads, before + 3);
        assert.equal(pollTimers(p).length, 0, 'still polling after the server caught up');
        const m = p.glue.payoutRefresh.model(p.glue.data());
        assert.equal(m.state, 'current');
        assert.equal(p.q('#wallet-act-payout span').textContent, '1 unclaimed entry');
    });
    test('lag: the server has the block but still lists both paid pairs: they are not offered, the tile says May be behind', async () => {
        const { p, srv } = world();
        await p.ctx.fetchWalletDashboard(ME);
        await flush();
        p.q('#wallet-act-payout').click();
        p.q('#payout-entries .payout-entry[data-key="' + keyOf(entries[2]) + '"]').remove();
        await p.ctx.submitPayoutTx();
        await flush();
        await p.emit({ type: 'Ready' });
        srv.chain = 42;
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, forceBatch(paidItem(entries[0]), paidItem(entries[1])));
        await flush(); await flush();
        assert.equal(pollTimers(p).length, 0, 'caught up at the first read');
        assert.equal(p.q('#wallet-act-payout span').textContent, '1 unclaimed entry', 'a proven-paid pair is offered again');
        const chip = p.q('#wallet-unpaid-label .ui-chip');
        assert.ok(chip && chip.textContent.trim() === 'May be behind', 'the lag is silent');
        p.q('#wallet-act-payout').click();
        assert.deepEqual(p.rows(), [keyOf(entries[2])]);
        assert.ok(p.q('#payout-behind-line'), 'the modal does not open with S15');
    });
    test('an identical payload is not re-rendered: the dashboard node survives a poll that changed only freshness', async () => {
        const { p, srv } = world();
        await p.ctx.fetchWalletDashboard(ME);
        await flush();
        const bar = p.q('#wallet-action-bar');
        await p.ctx.refreshWalletDashboardFor(ME, true);   // quiet: the poll's re-read
        await flush();
        // Identity as a boolean: on failure assert.equal(node, node) would render two happy-dom nodes (the whole
        // window graph) into its message and run the process out of memory instead of reporting.
        assert.ok(p.q('#wallet-action-bar') === bar, 'a poll with nothing new remounted the dashboard');
        await p.ctx.refreshWalletDashboardFor(ME);         // not quiet: a session change must repaint (it arms the action bar)
        await flush();
        assert.ok(p.q('#wallet-action-bar') !== bar, 'a non-poll refresh skipped the repaint');
        srv.chain = 77;
        const f = await p.ctx.refreshWalletDashboardFor(ME, true);
        assert.equal(f && f.indexed.chain, 77, 'the refresh does not hand the freshness back to the core');
        assert.equal(p.glue.data().freshness.indexed.chain, 77, 'the page kept an old freshness for the same payload');
    });
});
