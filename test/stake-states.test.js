// The Stake PDEX card, WP4 (design 2026-11-22-stake-card-simple-and-advanced.md, sections 6, 7, 10.2 and 10.3; UX spec
// 2026-11-22-post-action-refresh-ux.md, sections 0, 2, 5 and 9; CEO decisions of 2026-11-23), and the WP3 review leftovers.
//
// The states not built before WP4: My Account's Stake button by stake (SC-150, SC-151), /stake with no wallet (SC-120),
// /stake on a read-only account (SC-121), and the self-updating state after success (state 20): after a staking action
// is in a block, My Account's figures, the Stake button and the card follow a chain read IN PLACE (no remount), and
// nothing changes for a transaction that failed, was dropped or usurped, never reached a block or was not confirmed;
// a reorg puts the figures back. The card reopened while that action is tracked says so (SC-141), with nothing held.
//
// Everything runs the REAL page code: the stake modal markup from index.html; openStakeModal, submitStakeTx,
// submitSignedTx, renderWalletDashboard, bindWalletActionHandlers, mountWalletNominations and the line that creates
// the stake refresh, lifted from script.js into a wallet-world tab (whose fetchWalletDashboard and
// refreshWalletDashboardFor are the real ones); the real post-action core (lib/post-action.js with lib/known-results.js,
// lib/action-effects.js and lib/freshness.js) and the real payout refresh. globalApi builds transactions on a REAL
// ApiPromise booted from the mainnet 394 metadata; its storage reads are a fake chain. Only the transaction watcher is
// a recorder whose stages the tests play.
//
// Strings are checked by spec id, verbatim. Addresses are filler bytes at prefix 88; names are "Validator A" to "L".

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { ApiPromise } from '@polkadot/api';
import { makeProfile, openTab, fakeExtension, A as ME } from './helpers/wallet-world.js';
import { bodyOf, stripComments } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import * as stakePlan from '../lib/stake-plan.js';
import * as stakeCardView from '../lib/stake-card-view.js';
import * as payoutRefreshModule from '../lib/payout-refresh.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';
import { pdexToPlanck } from '../lib/wallet-safety.js';
import { createStakePicker, loadPickerData, maxNominationsFrom } from '../lib/stake-picker-view.js';
import { payeeOf } from '../lib/validator-manage.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs } from '../lib/freshness.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { escapeHtml } from '../lib/html-escape.js';

// WP4's new module; missing before WP4, so each test that needs it fails on its own assertion.
const refresh = await import('../lib/stake-refresh.js').then((m) => m, () => ({}));
// R3: the dashboard's frame and its sections (absent before R3).
const sections = await import('../lib/wallet-sections.js').then((m) => m, () => ({}));

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MODAL = HTML.slice(HTML.indexOf('<div id="stake-modal"'), HTML.indexOf('<!-- Payout Rewards Modal -->'));
const SC = stakePlan.STAKE_COPY;
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const PDEX = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 1)); };
const V = (n) => addr(40 + n);
const LETTER = (n) => String.fromCharCode(64 + n);
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

const LIFT = ['openStakeModal', 'loadStakeChoice', 'stakeCardView', 'submitStakeTx', 'fillStakeMax', 'submitSignedTx', 'showStakeError', 'clearStakeError',
    'stakeMaxNominations', 'renderStakeSelected', 'renderStakeValidatorList', 'stakePickerView', 'addStakeValidator',
    'getStakeableBalance', 'batchTx', 'buildBondOrExtra', 'formatDuration', 'renderWalletDashboard', 'bindWalletActionHandlers', 'mountWalletNominations',
    'buildWalletActionBarMarkup',
    // R3: the dashboard's table mounts and the failed-refresh line (lifted when present)
    'mountWalletRewardsTable', 'mountWalletTxTable', 'walletRefreshFailed'];
function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}
// One whole line of script.js, from its start (the page's own wiring), or nothing when it is not there.
const line = (start) => { const i = SCRIPT.indexOf(start); return i < 0 ? '' : SCRIPT.slice(i, SCRIPT.indexOf('\n', i)) + '\n'; };

let api;
before(async () => {
    const fx = loadFixture('metadata-mainnet-394.json');
    const mock = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion });
    api = await ApiPromise.create({ provider: mock.provider, noInitWarn: true });
});
after(async () => { await api?.disconnect(); });

// ── the validator snapshot ──
const ERA = 500;
const APRS = [20, 19.5, 19, 18.5, 18, 17.5, 17, 16.5, 16, 15.5, 15, 14.5];
function val(n, apr) {
    return { address: V(n), name: `Validator ${LETTER(n)}`, active: true, commission: 5, blocked: false, selfStake: 1000, totalStake: 50000,
        exposurePages: 1, exposureNominators: 20, backers: 20, identity: { hasIdentity: false, verified: false, parent: null }, slashEras: [],
        commissionHistory: { raisedRecently: false, pendingRaise: false },
        perf: { 28: { status: 'ok', apr, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100 } } };
}
const fullList = () => APRS.map((apr, i) => val(i + 1, apr));
const snapshotOf = (list) => loadPickerData(async (url) => (url.endsWith('validator-choice')
    ? { validators: list, activeEra: ERA, maxNominations: 16, exposurePageSize: 256 }
    : { validators: list.map(v => ({ address: v.address, name: v.name, commission: v.commission, totalStake: v.totalStake })), commissionHistoryEra: ERA }));
const PICKS = [1, 2, 3, 4, 5, 6, 7, 8].map(V);

// ── /api/wallet payloads ──
const NETWORK = { minStake: 100, eraDurationMs: 86_400_000, unbondingMs: 28 * 86_400_000 };
const firstTimer = () => ({ address: ME, identity: null, balance: { free: 501, reserved: 0, total: 501, transferable: 500, transferableAllowDeath: 501 },
    staking: { isStaker: false, isValidator: false, isNominator: false, totalStaked: 0, activeStaked: 0, activeStakedPlanck: '0', unlocking: 0, nominating: [], ledgerRead: 'ok', controller: null },
    rewards: { claimedTotal: 0, claimedCount: 0, unpaidTotal: 0, unpaidCount: 0, unclaimedFresh: true, recentClaimed: [], unpaidEntries: [] },
    network: NETWORK, freshness: { v: 1, chainHead: 40, indexed: { chain: 40, rewards: 40, tx: 40 }, since: { chain: 1, rewards: 1, tx: 1 }, pending: [] } });
const staker = (nominating = [1, 2], over = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 },
    staking: { totalStaked: 200, activeStaked: 200, nominating: nominating.map(n => ({ address: V(n), name: `Validator ${LETTER(n)}` })), ledgerRead: 'ok', controller: ME, ...over },
    network: NETWORK });
// The server's copy once it has the stake of 150 PDEX with the eight picks (block 42).
const serverAfter = (before) => ({ ...before,
    balance: { free: 350.98, reserved: 150, total: 500.98, transferable: 349.98, transferableAllowDeath: 350.98 },
    staking: { ...before.staking, isStaker: true, isNominator: true, totalStaked: 150, activeStaked: 150, activeStakedPlanck: String(150n * PDEX), unlocking: 0,
        nominating: PICKS.map((a, i) => ({ address: a, name: `Validator ${LETTER(i + 1)}` })), controller: ME },
    freshness: { v: 1, chainHead: 43, indexed: { chain: 40, rewards: 40, tx: 40 }, since: { chain: 1, rewards: 1, tx: 1 }, pending: [] } });

// ── a fake chain for the storage reads (the stake of 150 PDEX is a hold on 394: reserved, not free) ──
const some = (v) => ({ isSome: true, isNone: false, unwrap: () => v });
const none = () => ({ isSome: false, isNone: true, unwrap: () => { throw new Error('none'); } });
function fakeChain() {
    const st = { block: 42, free: 501n * PDEX, reserved: 0n, ledger: null, targets: [], reads: 0, fail: false };
    const query = {
        system: { account: async () => { st.reads++; if (st.fail) throw new Error('read failed'); return { nonce: 1, data: { free: st.free, reserved: st.reserved, frozen: 0n } }; }, number: async () => st.block },
        staking: {
            bonded: async () => (st.ledger ? some(ME) : none()),
            ledger: async () => (st.ledger ? some({ stash: ME, total: st.ledger, active: st.ledger, unlocking: [] }) : none()),
            nominators: async () => (st.targets.length ? some({ targets: st.targets.slice() }) : none()),
            payee: async () => none()
        }
    };
    const stake = (block = 42) => { st.block = block; st.free = 350_980_000_000_000n; st.reserved = 150n * PDEX; st.ledger = 150n * PDEX; st.targets = PICKS.slice(); };
    const unstake = () => { st.free = 501n * PDEX; st.reserved = 0n; st.ledger = null; st.targets = []; };
    // n PDEX more (or less, n negative) on the bond, seen at this block
    const more = (n, block) => { st.block = block; st.free -= BigInt(n) * PDEX; st.reserved += BigInt(n) * PDEX; st.ledger += BigInt(n) * PDEX; };
    return { st, query, stake, unstake, more };
}
const OK_EVENTS = [{ event: { section: 'staking', method: 'Bonded', data: [ME, 150n * PDEX] } }, { event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
const TX_HASH = '0x' + 'ab'.repeat(32);

// One open Stake card over My Account. flow: the dashboard is the real renderWalletDashboard on this payload, the core,
// the payout refresh and the stake refresh are the page's, and reads go to the fake chain.
async function card({ data, payee = { kind: 'staked', account: '' }, view = 'simple', flow = false, snapshots }) {
    const ext = fakeExtension('polkadot-js', [{ address: ME, name: 'One' }]);
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', ME);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    profile.local.setItem('pdex_stake_view_v1', view);
    const tab = openTab(profile, { path: '/wallet/' + data.address });
    const doc = tab.root.ownerDocument;
    doc.body.insertAdjacentHTML('beforeend', MODAL);
    tab.ctx.window.localStorage = profile.local;
    const queue = (snapshots || [await snapshotOf(fullList())]).slice();
    const sent = [], jobs = [], nominationReads = [];
    const chain = fakeChain();
    // The core's own clock and timers (its poll backoff and deadlines), run by hand.
    const clock = { t: 1_000_000, timers: [], set(f, ms) { const t = { f, ms }; this.timers.push(t); return t; }, clear(t) { const i = this.timers.indexOf(t); if (i >= 0) this.timers.splice(i, 1); },
        async run(max = 40) { for (let i = 0; i < max && this.timers.length; i++) { const t = this.timers.shift(); this.t += t.ms; t.f(); await flush(); } } };
    const known = createKnownResults({ storage: null });
    const post = flow ? createPostAction({ effects: effectsFor, known, same: (a, b) => tab.ctx.isSameAddress(a, b), now: () => clock.t, setTimer: (f, ms) => clock.set(f, ms), clearTimer: (t) => clock.clear(t), caughtUp, deadlineMs: pollDeadlineMs })
        : { observe: () => ({ stage: (f) => f, show: (f) => f }), subscribe: () => () => {}, arm() {} };
    const renders = [];
    const noop = () => '';
    Object.assign(tab.ctx, stakePlan, stakeCardView, payoutRefreshModule, refresh, sections, {
        FEE_MARGIN, pdexToPlanck, maxNominationsFrom, createStakePicker, payeeOf, Math, Number, parseFloat, BigInt, Date, queueMicrotask,
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), stakingFormatNumber: (n) => String(n), showTxNotice: () => {},
        currentWalletData: data, stakeSelected: new Map(), stakeValidators: [], stakePicker: null, stakeCard: null,
        validatorsCache: null, validatorsCacheAt: 0, VALIDATORS_CACHE_TTL: 60_000, stakeQuotaWarned: false,
        loadValidatorsForPicker: async () => { const next = queue.length > 1 ? queue.shift() : queue[0]; tab.ctx.validatorsCache = next; return next; },
        readStakePayee: async () => payee,
        globalApi: { tx: api.tx, registry: api.registry, genesisHash: api.genesisHash, runtimeVersion: api.runtimeVersion, query: chain.query, consts: { balances: { existentialDeposit: PDEX } } },
        liveRuntimeError: () => null,
        multisigStore: { find: () => null, list: () => [] }, multisigUI: { review: async () => {}, mountAccounts() {}, mountPending() {} },
        showTxStatus: () => ({ stage: 'failed' }),
        postAction: post, knownResults: known,
        trackSignedTx: (o) => ({ start() {}, buildFailed() {}, send: async (tx, who) => { sent.push({ tx, who, action: o.action }); jobs.push(o); } }),
        // the dashboard's other parts: not under test here
        hasInjectedWalletNow: () => true, readWalletValidator: () => Promise.resolve(null), VALIDATE_ON: false, walletAprData: null, walletRecentStore: null,
        mountNominationStatus: (el, a) => { nominationReads.push(a); },
        openSendModal() {}, openUnstakeModal() {}, openIdentityModal() {}, openPayoutModal() {}, openWalletPicker() {}, disconnectWallet() {}
    });
    for (const n of ['helpIcon', 'rewardHistoryLinkHtml', 'walletViewingSlotHtml', 'renderUsdSubscript', 'buildViewOnlyCallout', 'formatLocalDate',
        'makeTable', 'mountWalletRecentTx', 'fetchApiJson', 'bindViewOnlyCalloutHandlers', 'applyWalletActionBlock', 'scheduleWalletSigningRechecks',
        'mountBalanceLocks', 'lockActionDeps', 'renderWalletAdvancedSection', 'refreshWalletMultisigs', 'renderWalletAprCard',
        'renderWalletPriceChart', 'walletValidatorCard', 'looksLikeTxHash']) tab.ctx[n] = noop;
    vm.runInContext(LIFT.map(lift).join(''), tab.ctx);
    // The page's own lines: the payout refresh and the stake refresh, created as script.js creates them.
    vm.runInContext(line('const payoutRefresh = createPayoutRefresh(') + line('const stakeRefresh = createStakeRefresh(') + line('const walletSections = createWalletSections(')
        + 'globalThis.__stake = { refresh: typeof stakeRefresh === "undefined" ? null : stakeRefresh };', tab.ctx);
    if (!vm.runInContext('typeof stakeRefresh', tab.ctx).startsWith('o')) tab.ctx.stakeRefresh = { tracked: () => null, adopt: () => false };
    const real = tab.ctx.renderWalletDashboard;
    tab.ctx.renderWalletDashboard = (...a) => { renders.push(a[0]); return real(...a); };
    if (flow) { tab.ctx.renderWalletDashboard(data, { history: [], configured: false }, null); renders.length = 0; }
    await tab.fn('openStakeModal')();
    await flush();
    const q = (s) => doc.querySelector(s);
    const qa = (s) => Array.from(doc.querySelectorAll(s));
    const shown = (el) => { for (let e = el; e; e = e.parentElement) { if (e.hidden || (e.style && e.style.display === 'none')) return false; if (e.tagName === 'DETAILS' && !e.open && el !== e && !el.closest('summary')) return false; } return !!el; };
    const sc = (id) => { const els = qa(`#stake-modal [data-sc="${id}"]`).filter(shown); return els.length ? els.map(e => text(e)).join(' | ') : ''; };
    const input = () => doc.getElementById('stake-amount-input');
    const ev = (el, type) => el.dispatchEvent(new doc.defaultView.Event(type, { bubbles: true }));
    const type = async (v) => { const i = input(); i.value = v; ev(i, 'input'); await flush(); };
    const submit = async () => { await tab.fn('submitStakeTx')(); await flush(); };
    const open = () => q('#stake-modal').style.display !== 'none';
    const choosePayee = async (v) => { const r = q(`#stake-rewards input[name="stake-payee"][value="${v}"]`); assert.ok(r, `no ${v} radio`); r.checked = true; ev(r, 'change'); await flush(); };
    // The transaction's stages, as lib/tx-submit.js reports them through submitSignedTx's wrappers.
    const job = (i = jobs.length - 1) => {
        const o = jobs[i];
        assert.ok(o, 'nothing was handed to the transaction watcher');
        const action = { key: o.action.key };
        return {
            async inBlock(block = 42) { o.show(action, 'inBlock', OK_EVENTS, null, { blockNumber: block, txHash: TX_HASH, address: ME }); o.onStage('inBlock', { stage: 'inBlock', outcome: { ok: true } }); if (o.onSuccess) o.onSuccess(); await flush(); },
            async stage(s, outcome = { ok: false }) { o.show(action, s, null, null, { txHash: TX_HASH, address: ME }); o.onStage(s, { stage: s, outcome }); if (s === 'failed' && o.onError) o.onError('The transaction failed.', { stage: s }); await flush(); }
        };
    };
    const dash = {
        staked: () => doc.getElementById('wallet-staked-value'),
        total: () => doc.getElementById('wallet-total-value'),
        stakeBtn: () => doc.getElementById('wallet-act-stake'),
        unstakeBtn: () => doc.getElementById('wallet-act-unstake'),
        validators: () => qa('#wallet-my-validators .wallet-validator-row').length,
        summary: () => qa('.staking-summary-card'),
        label: (s) => { const b = doc.getElementById('wallet-act-stake'); return b ? [text(b.querySelector('strong')), text(b.querySelector('span'))] : null; }
    };
    const pending = () => tab.pending.shift();
    return { tab, doc, q, qa, sc, input, type, submit, open, sent, job, jobs, chain, clock, post, known, renders, dash, nominationReads, pending, choosePayee,
        refresh: () => tab.ctx.__stake.refresh, close: () => tab.close() };
}
const callsOf = (c, i = 0) => { const top = api.registry.createType('Call', c.sent[i].tx.method.toHex()); return `${top.section}.${top.method}` === 'utility.batchAll' ? top.args[0].map(x => `${x.section}.${x.method}`) : [`${top.section}.${top.method}`]; };

// ── state 20: the self-updating state after success ──
describe('state 20: after an included stake, My Account and the card follow in place (UX sections 0, 2, 9: SWAP, LATER)', () => {
    test('a first stake in block #42: Total Staked and Total Balance change with the wash, the button reads "Stake more", the list shows the eight; no node is replaced', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        assert.deepEqual(c.dash.label(), [SC['SC-150'], SC['SC-150s']], 'no stake yet: SC-150');
        assert.equal(text(c.dash.staked()), '0.0000 PDEX');
        const root = c.tab.root.firstElementChild, staked = c.dash.staked(), total = c.dash.total(), btn = c.dash.stakeBtn();
        const nominationReads = c.nominationReads.length;
        assert.ok(root && staked && total && btn, 'the dashboard draws the tiles and the button with their ids');
        await c.type('150');
        await c.submit();
        assert.deepEqual(callsOf(c), ['staking.bond', 'staking.nominate']);
        c.chain.stake(42);
        await c.job().inBlock(42);
        assert.equal(c.open(), false, 'the card closes at inclusion (state 19)');
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'Total Staked from the chain read');
        assert.equal(text(c.dash.total()), '500.9800 PDEX', 'Total Balance from the chain read');
        assert.ok(c.dash.staked().classList.contains('is-value-changed') && c.dash.total().classList.contains('is-value-changed'), 'the neutral wash (T5)');
        assert.deepEqual(c.dash.label(), [SC['SC-151'], SC['SC-151s']], 'the button reads "Stake more" (SC-151)');
        assert.equal(c.dash.validators(), 8, 'My Validators lists the eight');
        assert.deepEqual(c.nominationReads.slice(nominationReads), [ME], '"Your validators" reads again, once (its own LATER wording)');
        assert.equal(c.tab.root.firstElementChild, root, 'the dashboard was not remounted');
        assert.equal(c.dash.staked(), staked, 'the same Total Staked node');
        assert.equal(c.dash.stakeBtn(), btn, 'the same button node (focus stays)');
        assert.equal(c.renders.length, 0, 'renderWalletDashboard did not run');
        assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150, 'the page payload follows the chain read');
        c.close();
    });
    test('the server\'s copy arriving afterwards is taken in place: no remount, Unstake opens, the figures do not change again', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        const root = c.tab.root.firstElementChild;
        assert.equal(c.dash.unstakeBtn().disabled, true, 'nothing staked: Unstake is closed');
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        // The payout refresh's poll asked the server at inclusion (R2); its answer arrives now, caught up with block 42.
        const req = c.pending();
        assert.ok(req && req.url.startsWith('/api/wallet/'), 'the R2 poll asked the server');
        req.resolve(serverAfter(firstTimer()));
        await flush();
        assert.equal(c.renders.length, 0, 'the server\'s copy did not redraw the dashboard');
        assert.equal(c.tab.root.firstElementChild, root, 'the same dashboard node');
        assert.equal(text(c.dash.staked()), '150.0000 PDEX');
        assert.equal(c.dash.unstakeBtn().disabled, false, 'Unstake opens with the stake, in place');
        assert.equal(c.tab.ctx.currentWalletData.staking.nominating[0].name, 'Validator A', 'the names come with the server\'s copy');
        c.close();
    });
    test('opened again while the action is tracked: SC-141 above the amount, the figures of the chain read, nothing held; it goes when the server catches up', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        c.dash.stakeBtn().click();
        await flush();
        assert.equal(c.open(), true, 'the My Account button opens the card');
        assert.equal(c.sc('SC-141'), 'Your last staking action is in block #42. The figures here update in a moment.');
        const line = c.q('#stake-modal [data-sc="SC-141"]');
        assert.ok(line.compareDocumentPosition(c.input()) & 4, 'SC-141 is above the amount');
        assert.equal(c.sc('SC-03c') || c.sc('SC-03b'), SC['SC-03b'], 'the card draws an existing staker: the figures of the chain read');
        assert.equal(c.input().disabled, false, 'the amount is usable');
        assert.equal(c.q('#stake-max-btn').disabled, false, 'Max is usable');
        assert.equal(c.q('#stake-view-switch').disabled, false, 'the switch is usable');
        assert.equal(c.q('#stake-modal .stake-modal-body').getAttribute('aria-busy'), null, 'nothing is busy');
        await c.type('25');
        assert.equal(c.q('#submit-stake-tx-btn').disabled, false, 'the primary is active');
        c.pending().resolve(serverAfter(firstTimer()));
        await flush();
        assert.equal(c.sc('SC-141'), '', 'the server has the block: the line goes, in the open card');
        assert.equal(c.input().value, '25', 'the typed amount stays (M4)');
        c.close();
    });
    for (const [label, stage] of [['failed', 'failed'], ['dropped or usurped (ends failed)', 'failed'], ['never in a block (waiting)', 'waiting'],
        ['cancelled in the wallet', 'cancelled']]) {
        test(`${label}: nothing on the page changes and nothing is read; the card keeps the amount`, async () => {
            const c = await card({ data: firstTimer(), flow: true });
            const before = c.tab.root.innerHTML;
            await c.type('150');
            await c.submit();
            const reads = c.chain.st.reads;
            await c.job().stage(stage);
            assert.equal(c.chain.st.reads, reads, `a ${stage} transaction read the chain for figures`);
            assert.equal(c.tab.root.innerHTML, before, `a ${stage} transaction changed My Account`);
            assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 0);
            assert.equal(c.input().value, '150', 'the amount stays');
            c.close();
        });
    }
    test('a reorg withdraws: the figures go back with the wash, the button reads "Stake" again; back in a block they return', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        const staked = c.dash.staked();
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        assert.equal(text(staked), '150.0000 PDEX');
        staked.classList.remove('is-value-changed');
        c.chain.unstake();   // the replacing block does not have it
        await c.job().stage('resent');
        assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'the block was replaced: Total Staked is back to the last server value');
        assert.ok(c.dash.staked().classList.contains('is-value-changed'), 'with the wash (U12)');
        assert.deepEqual(c.dash.label(), [SC['SC-150'], SC['SC-150s']]);
        assert.equal(c.dash.staked(), staked, 'still the same node');
        assert.equal(c.refresh() && c.refresh().tracked(ME), null, 'not tracked while it is not in a block');
        c.chain.stake(44);
        await c.job().inBlock(44);
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'back in a block');
        assert.deepEqual(c.refresh().tracked(ME), { block: 44 });
        assert.equal(c.renders.length, 0, 'never remounted');
        c.close();
    });
    test('a read that is behind the block is not drawn; a read that fails changes nothing and the core\'s deadline marks Total Staked "May be behind"', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        await c.type('150');
        await c.submit();
        c.chain.stake(41);   // the node answers from block 41
        await c.job().inBlock(42);
        assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'a read from before the block is not drawn');
        assert.equal(text(c.q('#wallet-staked-label')), 'Total Staked', 'no mark while the core is still asking');
        c.chain.st.fail = true;
        // the core's own poll timers (2, 4, 8, 16, 30 s...), run past its 60 s chain deadline
        await c.clock.run();
        assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'a failed read changes nothing');
        const mark = c.q('#wallet-staked-label .ui-chip.is-wait.is-bare');
        assert.ok(mark && mark.querySelector('.bx-error'), 'the tile is marked when the core gives up');
        assert.equal(text(mark), 'May be behind', 'S14');
        assert.equal(c.renders.length, 0);
        c.close();
    });
    test('no timer is added in the stake block (spec state 20): the stake part of script.js, the card and the refresh arm none', () => {
        const a = SCRIPT.indexOf('// --- Stake / Nominate modal ---'), b = SCRIPT.indexOf('// --- Pay out rewards modal ---');
        assert.ok(a > 0 && b > a, 'the stake block is marked in script.js');
        const files = { 'script.js (stake block)': SCRIPT.slice(a, b), 'lib/stake-card-view.js': readFileSync(new URL('../lib/stake-card-view.js', import.meta.url), 'utf8') };
        try { files['lib/stake-refresh.js'] = readFileSync(new URL('../lib/stake-refresh.js', import.meta.url), 'utf8'); } catch (e) { files['lib/stake-refresh.js'] = 'missing'; }
        const bad = Object.entries(files).map(([f, src]) => [f, (stripComments(src).match(/\b(setTimeout|setInterval)\s*\(/g) || []).length, src]).filter(([, n, src]) => n > 0 || src === 'missing');
        assert.deepEqual(bad.map(([f, n, src]) => `${f}: ${src === 'missing' ? 'missing' : n + ' timer(s)'}`), [], 'a timer in the stake card');
    });
});

// ── the review of WP4 (2026-11-23): what a late server copy, a reorg of two actions and a re-read do ──
// The server's copy as it answers from a block (its other fields as before the stake, unless over says otherwise).
const serverAt = (block, over = {}) => ({ ...firstTimer(), freshness: { ...firstTimer().freshness, chainHead: block }, ...over });
describe('WP4 review fixes: the chain read stands until the server has the block; a reorg re-reads; processed and unverified re-read', () => {
    test('1. a server copy from block 41 after the chain read of block 42: the page keeps 150 PDEX in place, takes the freshness, and the card plans bondExtra', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        const root = c.tab.root.firstElementChild;
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the chain read');
        const req = c.pending();
        assert.ok(req && req.url.startsWith('/api/wallet/'), 'the R2 poll asked the server');
        req.resolve(serverAt(41));
        await flush();
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'a copy from block 41 put Total Staked back');
        assert.equal(text(c.dash.total()), '500.9800 PDEX', 'a copy from block 41 put Total Balance back');
        assert.deepEqual(c.dash.label(), [SC['SC-151'], SC['SC-151s']], 'the button went back to "Stake"');
        assert.equal(c.dash.validators(), 8, 'My Validators was emptied');
        assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150, 'the page payload went back to no stake');
        assert.equal(c.tab.ctx.currentWalletData.freshness.chainHead, 41, 'the copy\'s freshness is taken');
        assert.deepEqual(c.refresh().tracked(ME), { block: 42 }, 'still tracked: the server is behind the block');
        assert.equal(c.renders.length, 0, 'taken in place');
        assert.equal(c.tab.root.firstElementChild, root);
        c.dash.stakeBtn().click();
        await flush();
        assert.equal(c.sc('SC-141'), 'Your last staking action is in block #42. The figures here update in a moment.');
        assert.equal(c.sc('SC-03c') || c.sc('SC-03b'), SC['SC-03b'], 'the card draws an existing staker');
        await c.type('25');
        await c.submit();
        assert.equal(c.sent.length, 2, 'the second action was signed');
        assert.deepEqual(callsOf(c, 1), ['staking.bondExtra'], 'a bonded account planned a first stake');
        c.close();
    });
    test('1. the same copy with another change (a full renderWalletDashboard): the stake figures stay those of the chain read, Unstake stays open, the card plans bondExtra', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        c.pending().resolve(serverAt(41, { identity: 'Somebody' }));
        await flush();
        // R3: a copy that differs outside the stake is drawn section by section in place, no longer by a full render.
        assert.equal(c.renders.length, 0, 'the copy differs outside the stake: the dashboard was remounted instead of patched');
        assert.match(text(c.tab.root.querySelector('.list-header h2')), /Somebody/, 'the rest of the copy is drawn');
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the full render drew Total Staked from block 41');
        assert.equal(text(c.dash.total()), '500.9800 PDEX');
        assert.deepEqual(c.dash.label(), [SC['SC-151'], SC['SC-151s']]);
        assert.equal(c.dash.validators(), 8);
        assert.equal(c.dash.unstakeBtn().disabled, false, 'Unstake closed again');
        assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150);
        assert.equal(c.tab.ctx.currentWalletData.identity, 'Somebody');
        assert.deepEqual(c.refresh().tracked(ME), { block: 42 });
        c.dash.stakeBtn().click();
        await flush();
        assert.equal(c.sc('SC-03c') || c.sc('SC-03b'), SC['SC-03b'], 'the card draws an existing staker');
        await c.type('25');
        await c.submit();
        assert.deepEqual(callsOf(c, 1), ['staking.bondExtra'], 'a bonded account planned a first stake');
        c.close();
    });
    test('2. a reorg of the second of two actions re-reads the chain: stake 150 in #42, add 50 in #45, #45 replaced: 150 PDEX, "Stake more"', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        c.dash.stakeBtn().click();
        await flush();
        await c.type('50');
        await c.submit();
        assert.deepEqual(callsOf(c, 1), ['staking.bondExtra']);
        c.chain.more(50, 45);
        await c.job().inBlock(45);
        assert.equal(text(c.dash.staked()), '200.0000 PDEX', 'the second action drawn');
        c.chain.more(-50, 45);   // #45 is replaced by a block without it; #42 stands
        await c.job().stage('resent');
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the reorg of #45 also undid the stake of #42');
        assert.deepEqual(c.dash.label(), [SC['SC-151'], SC['SC-151s']]);
        assert.equal(c.dash.validators(), 8);
        assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150);
        assert.equal(c.refresh().tracked(ME), null, 'not tracked while it is not in a block');
        assert.equal(c.renders.length, 0, 'never remounted');
        c.close();
    });
    test('4. Unstake opens from the chain read (no wait for the server); a page blocked for stale balances stays blocked', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        assert.equal(c.dash.unstakeBtn().disabled, true);
        await c.type('150');
        await c.submit();
        c.chain.stake(42);
        await c.job().inBlock(42);
        assert.equal(c.dash.unstakeBtn().disabled, false, 'Unstake stays closed while the tile shows 150 PDEX');
        assert.equal(c.dash.unstakeBtn().getAttribute('title'), null, '"No active bond to unstake." over a bond of 150 PDEX');
        c.close();
        const b = await card({ data: firstTimer(), flow: true });
        const block = 'Balances could not be refreshed - reload before sending or staking.';
        b.dash.unstakeBtn().setAttribute('title', block);
        await b.type('150');
        await b.submit();
        b.chain.stake(42);
        await b.job().inBlock(42);
        assert.equal(b.dash.unstakeBtn().disabled, true, 'the chain read lifted the page\'s block');
        assert.equal(b.dash.unstakeBtn().getAttribute('title'), block);
        b.close();
    });
    for (const stage of ['processed', 'unverified']) {
        test(`5. ${stage}: a plain re-read (U1) that claims nothing: drawn when the chain has it, nothing changes when it does not`, async () => {
            const c = await card({ data: firstTimer(), flow: true });
            const before = c.tab.root.innerHTML;
            await c.type('150');
            await c.submit();
            const reads = c.chain.st.reads;
            await c.job().stage(stage);
            assert.ok(c.chain.st.reads > reads, `nothing re-read the chain after ${stage}`);
            assert.equal(c.tab.root.innerHTML, before, 'the chain does not have it: nothing on the page changes');
            assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 0);
            assert.equal(c.input().value, '150', 'the amount stays');
            assert.equal(c.refresh().tracked(ME), null, 'claims nothing');
            c.close();
            const d = await card({ data: firstTimer(), flow: true });
            await d.type('150');
            await d.submit();
            d.chain.stake(42);   // the chain has it, though the watcher could not confirm it
            await d.job().stage(stage);
            assert.equal(text(d.dash.staked()), '150.0000 PDEX', 'the re-read is drawn');
            assert.deepEqual(d.dash.label(), [SC['SC-151'], SC['SC-151s']]);
            assert.equal(d.refresh().tracked(ME), null, 'claims nothing: no SC-141');
            assert.equal(d.renders.length, 0, 'in place');
            d.close();
        });
    }
});

// ── the Opus review of 2026-11-23: a withdrawal is the stake's own; tracking ends when the server has the block ──
// Another action of the same account (a transfer), through the real core: in a block with clean events, then a later stage.
const OTHER_HASH = '0x' + 'cd'.repeat(32);
const TRANSFER_EVENTS = [{ event: { section: 'balances', method: 'Transfer', data: [ME, addr(9), 5n * PDEX] } }, { event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
function otherAction(c) {
    const action = { key: 'balances.transfer', params: { to: addr(9) } };
    const seen = c.post.observe(action);
    const show = seen.show(() => ({}));
    const stage = seen.stage(() => {});
    return {
        async inBlock(block) { show(action, 'inBlock', TRANSFER_EVENTS, null, { blockNumber: block, txHash: OTHER_HASH, address: ME }); stage('inBlock', { stage: 'inBlock', outcome: { ok: true } }); await flush(); },
        async stage(s) { show(action, s, null, null, { txHash: OTHER_HASH, address: ME }); stage(s, { stage: s, outcome: { ok: false } }); await flush(); }
    };
}
// The server's copy equal to the page, answering from block n (the samePayload branch of adopt).
const sameCopyAt = (c, n) => ({ ...JSON.parse(JSON.stringify(c.tab.ctx.currentWalletData)), freshness: { ...firstTimer().freshness, chainHead: n } });
// The page's payload with a little more free balance (a reward paid), from block n: differs from the page only in balance.
const moreFreeAt = (c, n) => { const d = sameCopyAt(c, n); d.balance = { ...d.balance, free: d.balance.free + 1, total: d.balance.total + 1 }; return d; };
async function stakeAt42() {
    const c = await card({ data: firstTimer(), flow: true });
    await c.type('150');
    await c.submit();
    c.chain.stake(42);
    await c.job().inBlock(42);
    assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the chain read of the stake');
    return c;
}
async function plansOnReopen(c, typed = '25') {
    c.dash.stakeBtn().click();
    await flush();
    await c.type(typed);
    await c.submit();
    return callsOf(c, c.sent.length - 1);
}
describe('Opus review 2026-11-23: only the stake\'s own reorg or failure withdraws it; tracking ends when the server has its block', () => {
    for (const [what, stage] of [['fails after its block', 'failed'], ['is reorged', 'resent']]) {
        for (const failing of [true, false]) {
            test(`the reviewer's scenario: stake 150 in #42, the server catches up at #50 with the same figures, then a transfer ${what}${failing ? ' and the chain read fails' : ''}: Total Staked stays 150 and the card plans bondExtra`, async () => {
                const c = await stakeAt42();
                c.pending().resolve(sameCopyAt(c, 50));
                await flush();
                assert.equal(c.renders.length, 0, 'the equal copy is taken in place');
                const t = otherAction(c);
                await t.inBlock(60);
                c.chain.st.fail = failing;
                const reads = c.chain.st.reads;
                await t.stage(stage);
                assert.equal(text(c.dash.staked()), '150.0000 PDEX', `the transfer's ${stage} notice withdrew the stake`);
                assert.equal(c.chain.st.reads, reads, `the transfer's ${stage} notice made the stake refresh re-read the chain`);
                assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150, 'the page payload lost the stake');
                assert.deepEqual(c.dash.label(), [SC['SC-151'], SC['SC-151s']], 'the button went back to "Stake"');
                c.chain.st.fail = false;
                assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra'], 'a bonded account planned a first stake');
                c.close();
            });
        }
        test(`while the stake is still tracked (the server has not caught up), a transfer that ${what} with a failing chain read withdraws nothing`, async () => {
            const c = await stakeAt42();
            const t = otherAction(c);
            await t.inBlock(43);
            c.chain.st.fail = true;
            await t.stage(stage);
            assert.equal(text(c.dash.staked()), '150.0000 PDEX', `the transfer's ${stage} notice withdrew the stake`);
            assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150);
            assert.deepEqual(c.refresh().tracked(ME), { block: 42 }, 'the stake is no longer tracked after another action\'s notice');
            c.chain.st.fail = false;
            assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra'], 'a bonded account planned a first stake');
            c.close();
        });
    }
    test('tracking ends when the server catches up with an equal copy (the samePayload branch): a later copy differing in balance is the caller\'s to draw', async () => {
        const c = await stakeAt42();
        c.pending().resolve(sameCopyAt(c, 50));
        await flush();
        assert.equal(c.refresh().tracked(ME), null);
        assert.equal(c.refresh().adopt(moreFreeAt(c, 51)), false, 'the stake is still tracked after the server caught up with an equal copy');
        c.close();
    });
    test('tracking ends when the server catches up with a copy drawn in full: a later copy differing in balance is the caller\'s to draw', async () => {
        const c = await stakeAt42();
        c.pending().resolve({ ...sameCopyAt(c, 50), identity: 'Somebody' });
        await flush();
        // R3: drawn in full section by section (in place), through the stake part's overlay, not by a remount.
        assert.equal(c.renders.length, 0, 'the copy differs outside the stake: the dashboard was remounted instead of patched');
        assert.match(text(c.tab.root.querySelector('.list-header h2')), /Somebody/, 'the rest of the copy is not drawn');
        assert.equal(c.refresh().adopt(moreFreeAt(c, 51)), false, 'the stake is still tracked after the server caught up in a full render');
        c.close();
    });
    for (const [what, stage] of [['reorged', 'resent'], ['failed after its block', 'failed']]) {
        test(`the stake's own ${what} with a failing chain read: the last chain figures stay (never 0 for a bonded account) and Total Staked is marked "May be behind"`, async () => {
            const c = await stakeAt42();
            c.chain.st.fail = true;
            await c.job().stage(stage);
            assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'a failed read during the withdrawal drew 0 staked');
            assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 150);
            const mark = c.q('#wallet-staked-label .ui-chip.is-wait.is-bare');
            assert.equal(mark ? text(mark) : null, 'May be behind', 'the could-not-refresh mark (S14)');
            assert.equal(c.refresh().tracked(ME), null, 'not tracked while it is not in a block');
            c.close();
        });
        test(`regression guard: the stake's own ${what}, after another action of the account was in a block, still withdraws it (the chain no longer has it: 0 PDEX, "Stake", bond and nominate)`, async () => {
            const c = await stakeAt42();
            await otherAction(c).inBlock(43);
            c.chain.unstake();
            await c.job().stage(stage);
            assert.equal(text(c.dash.staked()), '0.0000 PDEX', `the stake's own ${stage} did not withdraw it`);
            assert.equal(c.tab.ctx.currentWalletData.staking.totalStaked, 0);
            assert.deepEqual(c.dash.label(), [SC['SC-150'], SC['SC-150s']]);
            assert.equal(c.refresh().tracked(ME), null);
            assert.deepEqual(await plansOnReopen(c, '150'), ['staking.bond', 'staking.nominate']);
            c.close();
        });
    }
});

// ── the Lead's ruling of 2026-11-23: while the bonded state is uncertain, the Stake card signs nothing ──
// A withdrawal (or the core giving up) whose chain read failed leaves the page unable to tell bonded from unbonded:
// bond would fail AlreadyBonded for a fee on a bonded account, bondExtra NotStash on an unbonded one. The card refuses
// with SC-109, as for a failed ledger read, and Unstake stays closed with its title, until a successful chain or server
// read settles the bonded state; then it plans as usual.
const NO_BOND = 'No active bond to unstake.';
const hideCard = (c) => { c.q('#stake-modal').style.display = 'none'; };
const chip = (c) => text(c.q('#wallet-staked-label .ui-chip'));
async function refusesWhileUncertain(c, typed = '25', { mark = true } = {}) {
    const sent = c.sent.length;
    if (mark) assert.equal(text(c.q('#wallet-staked-label .ui-chip.is-wait.is-bare')), 'May be behind', 'Total Staked is not marked while the bonded state is uncertain');
    assert.equal(c.dash.unstakeBtn().disabled, true, 'Unstake is open while the bonded state is uncertain');
    assert.equal(c.dash.unstakeBtn().getAttribute('title'), NO_BOND, 'Unstake does not keep its existing title');
    c.dash.stakeBtn().click();
    await flush();
    assert.equal(c.open(), true, 'the My Account button opens the card');
    await c.type(typed);
    assert.equal(c.sc('SC-109'), SC['SC-109'], 'the card does not refuse with SC-109 while the bonded state is uncertain');
    assert.equal(c.q('#submit-stake-tx-btn').disabled, true, 'the primary is active while the bonded state is uncertain');
    await c.submit();
    assert.deepEqual(c.sent.length > sent ? callsOf(c, c.sent.length - 1) : [], [], 'the press signed while the bonded state is uncertain');
    hideCard(c);
}
async function addMoreAt45() {
    const c = await stakeAt42();
    assert.deepEqual(await plansOnReopen(c, '50'), ['staking.bondExtra']);
    c.chain.more(50, 45);
    await c.job().inBlock(45);
    assert.equal(text(c.dash.staked()), '200.0000 PDEX', 'the addition drawn');
    assert.equal(c.dash.unstakeBtn().disabled, false);
    return c;
}
describe('the Lead\'s ruling 2026-11-23: an uncertain bonded state signs nothing (SC-109) until a read settles it', () => {
    for (const [what, stage] of [['reorged', 'resent'], ['failed after its block', 'failed']]) {
        test(`a first stake ${what} with a failing chain read: the figures stay marked, Unstake closes, the card shows SC-109 and the press signs nothing`, async () => {
            const c = await stakeAt42();
            c.chain.st.fail = true;
            await c.job().stage(stage);
            assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the last chain figures stay');
            await refusesWhileUncertain(c, '150');
            await refusesWhileUncertain(c, '25');
            c.close();
        });
        test(`an addition ${what} with a failing chain read: Total Staked is marked, Unstake closes, the card shows SC-109 and the press signs nothing`, async () => {
            const c = await addMoreAt45();
            c.chain.st.fail = true;
            await c.job().stage(stage);
            await refusesWhileUncertain(c, '25');
            await refusesWhileUncertain(c, '150');
            c.close();
        });
    }
    test('the core gives up on the first stake\'s read (could-not-refresh): Total Staked is marked, the card shows SC-109 and signs nothing', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        await c.type('150');
        await c.submit();
        c.chain.stake(41);
        await c.job().inBlock(42);
        c.chain.st.fail = true;
        await c.clock.run();
        assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'a failed read changes nothing');
        await refusesWhileUncertain(c, '150');
        c.chain.st.fail = false;
        // A server copy older than the stake's block settles nothing: in place, or drawn in full.
        assert.equal(c.refresh().adopt(serverAt(41)), true, 'a copy older than the block, equal but for the freshness, is taken in place');
        await refusesWhileUncertain(c, '150');
        c.tab.ctx.renderWalletDashboard(serverAt(41, { identity: 'Somebody' }), { history: [], configured: false }, null);
        await refusesWhileUncertain(c, '150', { mark: false });
        c.pending().resolve(serverAfter(firstTimer()));
        await flush();
        assert.equal(chip(c), null, 'the server\'s copy settled it: no mark');
        assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra'], 'after the server\'s bonded copy');
        c.close();
    });
    test('settled by a later chain read showing it bonded (the stake back in a block): the mark goes, Unstake opens, the card plans bondExtra', async () => {
        const c = await stakeAt42();
        c.chain.st.fail = true;
        await c.job().stage('resent');
        await refusesWhileUncertain(c);
        c.chain.st.fail = false;
        c.chain.stake(44);
        await c.job().inBlock(44);
        assert.equal(chip(c), null, 'a successful chain read settled it: no mark');
        assert.equal(c.dash.unstakeBtn().disabled, false, 'Unstake opens with the bond the chain read');
        assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra']);
        c.close();
    });
    test('settled by a later server copy showing it bonded: the card plans bondExtra and Unstake opens', async () => {
        const c = await addMoreAt45();
        c.chain.st.fail = true;
        await c.job().stage('resent');
        await refusesWhileUncertain(c);
        c.chain.st.fail = false;
        c.pending().resolve({ ...serverAfter(firstTimer()), freshness: { ...firstTimer().freshness, chainHead: 50 } });
        await flush();
        assert.equal(chip(c), null, 'the server\'s copy settled it: no mark');
        assert.equal(c.dash.unstakeBtn().disabled, false);
        assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra']);
        c.close();
    });
    test('settled by a later chain read showing it unbonded (a re-read after processed): the card plans bond and nominate, Unstake stays closed', async () => {
        const c = await stakeAt42();
        c.chain.st.fail = true;
        await c.job().stage('resent');
        await refusesWhileUncertain(c);
        c.chain.st.fail = false;
        c.chain.unstake();
        await c.job().stage('processed');
        assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'the chain read is drawn');
        assert.equal(chip(c), null, 'a successful chain read settled it: no mark');
        assert.equal(c.dash.unstakeBtn().disabled, true);
        assert.deepEqual(await plansOnReopen(c, '150'), ['staking.bond', 'staking.nominate']);
        c.close();
    });
    test('settled by a later server copy showing it unbonded: the card plans bond and nominate', async () => {
        const c = await stakeAt42();
        c.chain.st.fail = true;
        await c.job().stage('failed');
        await refusesWhileUncertain(c);
        c.pending().resolve(serverAt(50));
        await flush();
        assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'the server\'s copy is drawn');
        assert.equal(chip(c), null, 'the server\'s copy settled it: no mark');
        assert.equal(c.dash.unstakeBtn().disabled, true);
        assert.deepEqual(await plansOnReopen(c, '150'), ['staking.bond', 'staking.nominate']);
        c.close();
    });
});

// ── Opus review 2 of 2026-11-23: a stake in a block that no chain read has reached is unsettled (SC-109) ──
// Between a stake's in-block notice and the first chain read at or beyond its block, the page still holds the copy
// from before the stake: a failed read, or a node behind the block (the RPC load balancer), would let the card plan
// bond on an account bonded in that block. Until a chain read at or beyond the block is drawn, or a server copy at or
// beyond it arrives, the bonded state is unsettled: the card refuses with SC-109 and signs nothing. A withdrawn stake's
// block stays the floor: a server copy older than it settles nothing. In the stuck case, re-opening the card reads the
// chain once.
async function stakeInBlockUnread(how, block = 42) {
    const c = await card({ data: firstTimer(), flow: true });
    await c.type('150');
    await c.submit();
    c.chain.stake(block);
    if (how === 'fails') c.chain.st.fail = true; else c.chain.st.block = block - 1;
    await c.job().inBlock(block);
    return c;
}
const reachBlock = (c, block = 42) => { c.chain.st.fail = false; c.chain.st.block = block; };
describe('Opus review 2 2026-11-23: a tracked stake no chain read has reached is unsettled; the withdrawn block is the floor; a re-open reads the chain', () => {
    for (const how of ['fails', 'behind']) {
        const what = how === 'fails' ? 'the chain read fails' : 'the node is behind the block';
        test(`the reviewer's probe: a first stake in #42 and ${what}: tracked, the card refuses with SC-109 and signs nothing`, async () => {
            const c = await stakeInBlockUnread(how);
            assert.deepEqual(c.refresh().tracked(ME), { block: 42 }, 'the stake is tracked');
            assert.equal(text(c.dash.staked()), '0.0000 PDEX', 'nothing is drawn before a read reaches the block');
            assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, stakePlan.LEDGER_UNSETTLED, 'the page payload is not unsettled while no read has reached the block');
            await refusesWhileUncertain(c, '150', { mark: false });
            await refusesWhileUncertain(c, '25', { mark: false });
            c.close();
        });
        test(`a server copy older than the block settles nothing (${what}); a copy at the block does`, async () => {
            const c = await stakeInBlockUnread(how);
            c.pending().resolve(serverAt(41));
            await flush();
            await refusesWhileUncertain(c, '150', { mark: false });
            c.tab.ctx.renderWalletDashboard(serverAfter(firstTimer()), { history: [], configured: false }, null);
            assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, 'ok', 'a server copy at or beyond the block did not settle it');
            assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra'], 'after the server\'s bonded copy');
            c.close();
        });
        test(`after a successful chain read at the block (${what} first), the card plans bondExtra; a read older than the block settles nothing`, async () => {
            const c = await stakeInBlockUnread(how);
            c.chain.st.fail = false;
            c.chain.st.block = 41;
            await c.clock.run(1);
            assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, stakePlan.LEDGER_UNSETTLED, 'a read older than the block settled it');
            await refusesWhileUncertain(c, '150', { mark: false });
            reachBlock(c);
            await c.clock.run(1);
            assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the read at the block is drawn');
            assert.equal(chip(c), null, 'no mark once a read reached the block');
            assert.equal(c.dash.unstakeBtn().disabled, false, 'Unstake opens with the bond the chain read');
            assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra']);
            c.close();
        });
    }
    test('the reviewer\'s second probe: a stake in #42 never read, reorged, back in #43 while reads fail: the card refuses with SC-109 and signs nothing', async () => {
        const c = await stakeInBlockUnread('fails');
        await c.job().stage('resent');
        await refusesWhileUncertain(c, '150', { mark: false });
        await c.job().inBlock(43);
        assert.deepEqual(c.refresh().tracked(ME), { block: 43 }, 'the stake is tracked in its new block');
        await refusesWhileUncertain(c, '150', { mark: false });
        await refusesWhileUncertain(c, '25', { mark: false });
        reachBlock(c, 43);
        await c.clock.run(1);
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the read at #43 is drawn');
        assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra']);
        c.close();
    });
    test('a stake read in #42, reorged with a failing read, back in #43 while reads fail: the card refuses with SC-109 and signs nothing', async () => {
        const c = await stakeAt42();
        c.chain.st.fail = true;
        await c.job().stage('resent');
        await refusesWhileUncertain(c, '150');
        await c.job().inBlock(43);
        await refusesWhileUncertain(c, '150', { mark: false });
        await refusesWhileUncertain(c, '25', { mark: false });
        c.close();
    });
    for (const [what, stage] of [['reorged', 'resent'], ['failed after its block', 'failed']]) {
        test(`the withdrawn block is the floor: the stake ${what} with a failing read, a server copy older than #42 settles nothing, one at #42 does`, async () => {
            const c = await stakeAt42();
            c.chain.st.fail = true;
            await c.job().stage(stage);
            await refusesWhileUncertain(c, '150');
            c.pending().resolve(serverAt(41));
            await flush();
            assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, stakePlan.LEDGER_UNSETTLED, 'a server copy older than the withdrawn block settled it');
            await refusesWhileUncertain(c, '150', { mark: false });
            await refusesWhileUncertain(c, '25', { mark: false });
            c.tab.ctx.renderWalletDashboard(serverAt(42), { history: [], configured: false }, null);
            assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, 'ok', 'a server copy at the withdrawn block did not settle it');
            assert.deepEqual(await plansOnReopen(c, '150'), ['staking.bond', 'staking.nominate']);
            c.close();
        });
    }
    test('the stuck case (the core gave up): re-opening the card reads the chain once, and that read settles it: bondExtra', async () => {
        const c = await stakeInBlockUnread('fails');
        await c.clock.run();
        await refusesWhileUncertain(c, '150');
        reachBlock(c, 44);
        const reads = c.chain.st.reads;
        c.dash.stakeBtn().click();
        await flush();
        assert.equal(c.chain.st.reads - reads, 1, 're-opening the card did not read the chain exactly once');
        assert.equal(text(c.dash.staked()), '150.0000 PDEX', 'the re-open read is drawn');
        assert.equal(chip(c), null, 'the re-open read settled it: no mark');
        assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, 'ok');
        await c.type('25');
        await c.submit();
        assert.deepEqual(callsOf(c, c.sent.length - 1), ['staking.bondExtra'], 'after the re-open read');
        c.close();
    });
    test('the stuck case: a re-open read older than the block settles nothing; a later server copy at the block does', async () => {
        const c = await stakeInBlockUnread('fails');
        await c.clock.run();
        c.chain.st.fail = false;
        c.chain.st.block = 41;
        const reads = c.chain.st.reads;
        await refusesWhileUncertain(c, '150');
        assert.equal(c.chain.st.reads - reads, 1, 're-opening the card did not read the chain exactly once');
        c.tab.ctx.renderWalletDashboard(serverAfter(firstTimer()), { history: [], configured: false }, null);
        assert.equal(c.tab.ctx.currentWalletData.staking.ledgerRead, 'ok', 'a server copy at or beyond the block did not settle it');
        assert.deepEqual(await plansOnReopen(c), ['staking.bondExtra']);
        c.close();
    });
});

// ── My Account's labels, /stake with no wallet, /stake read-only ──
describe('My Account by stake, and the /stake shortcut where the card cannot open (section 6 rows 14, 15; SC-120, SC-121, SC-150, SC-151)', () => {
    test('the Stake button: SC-150 with no stake, SC-151 with one (both the dashboard and the action bar a session restores)', async () => {
        const c = await card({ data: firstTimer(), flow: true });
        assert.deepEqual(c.dash.label(), ['Stake', 'Stake PDEX and earn rewards']);
        c.tab.ctx.renderWalletDashboard(staker([1, 2]), { history: [], configured: false }, null);
        assert.deepEqual(c.dash.label(), ['Stake more', 'Add to your stake or change validators']);
        const bar = (d) => { const w = new Window(); w.document.body.innerHTML = c.tab.ctx.buildWalletActionBarMarkup(d); const b = w.document.getElementById('wallet-act-stake'); const r = [text(b.querySelector('strong')), text(b.querySelector('span'))]; w.happyDOM.close(); return r; };
        assert.deepEqual(bar(firstTimer()), ['Stake', 'Stake PDEX and earn rewards']);
        assert.deepEqual(bar(staker([1])), ['Stake more', 'Add to your stake or change validators']);
        assert.ok(!/Add bond/.test(c.tab.root.innerHTML), 'the old "Add bond & choose validators" is gone');
        c.close();
    });
    test('/stake with no wallet: the connect chooser with SC-120 above it', async () => {
        const profile = makeProfile({ extensions: [] });
        const tab = openTab(profile, { path: '/wallet' });
        Object.assign(tab.ctx, refresh);
        vm.runInContext('walletEntryIntent = "stake";', tab.ctx);
        await tab.visit('/wallet');
        const note = tab.root.querySelector('[data-sc="SC-120"]');
        assert.equal(text(note), 'Connect a wallet to stake PDEX.');
        assert.ok(tab.root.querySelector('.wallet-option-row'), 'the chooser is there');
        assert.ok(note.compareDocumentPosition(tab.root.querySelector('.wallet-option-row')) & 4, 'SC-120 is above the chooser');
        vm.runInContext('walletEntryIntent = null;', tab.ctx);
        await tab.visit('/wallet');
        assert.equal(tab.root.querySelector('[data-sc="SC-120"]'), null, 'My Account without the shortcut: no line');
        tab.close();
    });
    test('/stake on an account open read-only: no card, SC-121 in the read-only callout; with a Stake button the card opens and no line', () => {
        const w = new Window({ url: 'https://explorer.test/wallet' });
        const doc = w.document;
        const opened = [];
        const ctx = { document: doc, walletEntryIntent: 'stake', openStakeModal: () => opened.push(1), openUnstakeModal: () => {}, stakingEscapeHtml: escapeHtml, ...refresh };
        vm.createContext(ctx);
        vm.runInContext(bodyOf(SCRIPT, 'maybeRunWalletEntryIntent'), ctx);
        doc.body.innerHTML = '<div id="wallet-dashboard"><div id="wallet-actions-slot"><div class="wallet-readonly-callout"><div class="wallet-readonly-head"><strong>Read-only mode</strong></div></div></div></div>';
        ctx.maybeRunWalletEntryIntent();
        assert.equal(text(doc.querySelector('.wallet-readonly-callout [data-sc="SC-121"]')), 'This account is open read-only, so it cannot stake from here. Connect its wallet to stake.');
        assert.equal(opened.length, 0, 'no card');
        ctx.walletEntryIntent = null;
        ctx.maybeRunWalletEntryIntent();
        assert.equal(doc.querySelectorAll('[data-sc="SC-121"]').length, 1, 'one-shot: the line is not added twice');
        doc.body.innerHTML = '<div id="wallet-dashboard"><div id="wallet-action-bar"><button id="wallet-act-stake"></button></div></div>';
        ctx.walletEntryIntent = 'stake';
        ctx.maybeRunWalletEntryIntent();
        assert.equal(opened.length, 1, 'a signing session: the card opens');
        assert.equal(doc.querySelector('[data-sc="SC-121"]'), null);
        w.happyDOM.close();
    });
});

// ── help (finding F3) ──
describe('help: the nominating and choosing-validators topics speak the card\'s words (finding F3; section 0)', () => {
    const topic = (slug) => HELP_TOPICS.find(t => t.slug === slug);
    test('nominating: no commission-only Est. APY as the return, no "click Stake more"; the rule, the range and the past return as the card states them', () => {
        const t = topic('nominating');
        assert.ok(t, 'the topic exists (/help/nominating stays)');
        assert.ok(!/Est\. APY<\/b> —|nominal maximum APY/.test(t.body), 'the nominating topic still explains the commission-only estimate as the return');
        assert.ok(!/click <b>Stake more<\/b>/.test(t.body), 'the nominating topic still says "click Stake more"');
        assert.ok(t.body.includes(SC['SC-32']), 'the rule of the automatic choice, verbatim (SC-32)');
        assert.ok(t.body.includes(SC['SC-25']), 'why the return is a range (SC-25)');
        assert.ok(t.body.includes(`<b>${SC['SC-150']}</b>`) && t.body.includes(`<b>${SC['SC-151']}</b>`), 'the button by its words (SC-150, SC-151)');
        assert.match(t.body, /Past return<\/b> is what the validators paid per PDEX over the last 28 eras, after commission\. Past rewards, not a guarantee\./);
        assert.ok(!/[–—]/.test(t.body), 'no em or en dash');
    });
    test('nominating (WP4 review): the card is not "one field and one button", rewards stay where an existing stake sends them, and a change can count from N+2', () => {
        const b = topic('nominating').body.replace(/\s+/g, ' ');
        const gone = ['The Stake PDEX card has one field, the amount, and one button.', 'shown behind one disclosure, and rewards are added to the stake.',
            'A stake or a change of validators made during era N counts from era N+1. '];
        assert.deepEqual(gone.filter(x => b.includes(x)), [], 'a false sentence is still in the topic');
        for (const x of ['The simple view of the Stake PDEX card has one field, the amount.',
            'By default a first stake has its rewards added to the stake; an existing stake keeps its rewards setting, which the card states.',
            'A stake or a change of validators made during era N counts from era N+1, or from N+2 if made after era N\'s election snapshot.']) assert.ok(b.includes(x), `missing: ${x}`);
    });
    test('choosing validators: "Past return" for the figure and the Advanced view by name; "No history yet" for no figure', () => {
        const t = topic('choosing-validators');
        assert.equal(t.title, 'Choosing validators: past return and filters');
        assert.ok(!/Stake &amp; Nominate|\bthe APR\b|\bnew\b<\/b>|<b>n\/a<\/b>/.test(t.body), 'the old words are still there');
        assert.ok(t.body.includes('Advanced view of the Stake PDEX card') && t.body.includes('<b>No history yet</b>') && /Past rewards, not a guarantee/.test(t.body));
    });
    test('the commission-only estimate is explained where it is shown (the Validators page), with its base and "not a measured return"', () => {
        const t = topic('validators');
        assert.match(t.body, /Est\. APY \(current commission\)<\/b>: the chain's nominal maximum APY \(\d+(\.\d+)?%\)/);
        assert.match(t.body, /not a measured return/);
        assert.match(t.body, /The Stake PDEX card does not use it/);
    });
});

// ── copy guards ──
describe('copy guards (section 10.2 WP4 guards)', () => {
    test('no duration or limit is a literal in STAKE_COPY (M12): durations come from the chain', () => {
        const bad = Object.entries(SC).filter(([, v]) => /\b\d+(\.\d+)?\s*(seconds?|minutes?|hours?|days?|weeks?)\b/i.test(v)).map(([k, v]) => `${k}: ${v}`);
        assert.deepEqual(bad, [], 'a duration literal in the copy');
    });
    test('the WP4 strings, verbatim from section 7', () => {
        assert.equal(SC['SC-120'], 'Connect a wallet to stake PDEX.');
        assert.equal(SC['SC-121'], 'This account is open read-only, so it cannot stake from here. Connect its wallet to stake.');
        assert.equal(stakePlan.stakeCopy('SC-141', { n: 7 }), 'Your last staking action is in block #7. The figures here update in a moment.');
        assert.deepEqual([SC['SC-150'], SC['SC-150s'], SC['SC-151'], SC['SC-151s']], ['Stake', 'Stake PDEX and earn rewards', 'Stake more', 'Add to your stake or change validators']);
    });
});

// ── the WP3 review leftovers ──
describe('WP3 review leftovers', () => {
    test('1. the payee is Controller and the controller is this account: "Pay to this account" is the current choice; choosing it again plans no setPayee (M7)', async () => {
        const c = await card({ data: staker([1, 2]), view: 'advanced', payee: { kind: 'controller', account: '' } });
        const checked = c.q('#stake-rewards input[name="stake-payee"]:checked');
        assert.equal(checked && checked.value, 'stash', 'the current setting shows as "Pay to this account"');
        await c.choosePayee('staked');
        await c.choosePayee('stash');
        const lines = c.qa('#stake-sign .stake-plan-lines li').map(li => text(li));
        assert.deepEqual(lines, [], `going back to the current setting is still a change: ${lines.join(' | ')}`);
        assert.equal(c.q('#submit-stake-tx-btn').disabled, true, 'nothing to sign');
        await c.type('5');
        await c.submit();
        assert.deepEqual(callsOf(c), ['staking.bondExtra'], 'setPayee(Stash) signed over Controller: a fee for nothing');
        c.close();
    });
    test('2. planStakeCalls with no address check refuses every rewards account (fail closed)', () => {
        const p = stakePlan.planStakeCalls({ hasBond: true, currentTargets: [V(1)], targets: [V(1)], currentPayee: { kind: 'staked' }, payee: { kind: 'account', account: V(9) } });
        assert.deepEqual(p.calls, [], 'an account payee was planned with no check of the address');
        assert.ok(p.problems.includes('payee-invalid'));
        const first = stakePlan.planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [V(1)], payee: { kind: 'account', account: 'not an address' } });
        assert.deepEqual(first.calls, []);
        assert.ok(stakePlan.planStakeCalls({ hasBond: true, currentTargets: [V(1)], targets: [V(1)], currentPayee: { kind: 'staked' }, payee: { kind: 'stash' } }).calls.length === 1, 'the other destinations need no address');
    });
    test('3. the payee is Controller and the payload does not say who the controller is: "could not be read" (SC-14e), not "this account"', async () => {
        const c = await card({ data: staker([1, 2], { controller: undefined }), payee: { kind: 'controller', account: '' } });
        assert.equal(c.sc('SC-14e'), SC['SC-14e'], 'the simple view claims a destination it does not know');
        assert.equal(c.sc('SC-14b'), '');
        c.close();
        const a = await card({ data: staker([1, 2], { controller: undefined }), view: 'advanced', payee: { kind: 'controller', account: '' } });
        assert.ok(a.q('#stake-rewards fieldset.stake-payee').disabled, 'Advanced offers a change over a setting it could not read');
        assert.equal(a.q('#stake-rewards input[name="stake-payee"]:checked'), null);
        assert.equal(a.sc('SC-14e'), SC['SC-14e']);
        a.close();
    });
    test('4. the press signs only the plan the review shows: an edit that did not redraw the card signs nothing, SC-39, the field kept', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        assert.ok(text(c.q('#stake-simple .stake-plan-lines')).includes('Stake 150 PDEX'), 'the review shows 150');
        c.input().value = '300';   // no input event: the review still shows 150
        await c.submit();
        assert.equal(c.sent.length, 0, `signed ${c.sent.length ? 'a plan of 300' : ''} while the review showed 150`);
        assert.equal(c.sc('SC-39'), SC['SC-39']);
        assert.equal(c.input().value, '300', 'the amount is never rewritten (M4)');
        assert.ok(text(c.q('#stake-simple .stake-plan-lines')).includes('Stake 300 PDEX'), 'the card is drawn again on what would be signed');
        await c.submit();
        assert.equal(c.sent.length, 1, 'once on screen, it signs');
        assert.deepEqual(callsOf(c), ['staking.bond', 'staking.nominate']);
        c.close();
    });
    test('6. script.js has no removeStakeValidator: nothing called it (the card removes through its own Remove)', () => {
        assert.ok(!/\bremoveStakeValidator\b/.test(SCRIPT), 'dead code: removeStakeValidator is still defined');
        assert.ok(/data-stake-action="remove"/.test(readFileSync(new URL('../lib/stake-advanced-view.js', import.meta.url), 'utf8')), 'the Remove of the selection is the card\'s');
    });
});
