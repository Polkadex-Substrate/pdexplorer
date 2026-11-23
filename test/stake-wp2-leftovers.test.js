// Stake card WP2: the WP1 review leftovers (design 2026-11-22-stake-card-simple-and-advanced.md).
//   a  who signs: the Unstake modal (full and partial) is refused before signing when the stash's
//      controller is another account (unbond and chill are controller calls, 394 metadata), and the
//      Stake card is refused before signing bondExtra from an account that is only a controller
//      (bond and bondExtra are stash calls); both with the existing messages
//   b  the success card for a rewards-only plan ({ amount: null, n: null }) says where rewards now go
//      (SC-133), never "null validators nominated."; SC-130 to SC-132 for the other plans
//   c  a failed ledger read is not "0 PDEX staked": the dashboard and the card say the account could
//      not be read (SC-109), and the card refuses with SC-109
//
// The modal tests run the REAL submitStakeTx, submitUnstakeTx and submitSignedTx from script.js in a
// wallet-world tab with a REAL ApiPromise booted from the mainnet 394 metadata; only the transaction
// watcher is a recorder. The dashboard test runs the REAL renderWalletDashboard over happy-dom.
// Accounts are filler bytes and belong to no one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { encodeAddress } from '@polkadot/util-crypto';
import { ApiPromise } from '@polkadot/api';
import { Window } from 'happy-dom';
import { makeProfile, openTab, fakeExtension, A as ME, B as SOMEONE } from './helpers/wallet-world.js';
import { bodyOf } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import * as stakePlan from '../lib/stake-plan.js';
import { stakeResultParams, planStakeCalls } from '../lib/stake-plan.js';
import { successCopy, ERROR_COPY } from '../lib/tx-status.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';
import { pdexToPlanck, isPositiveNumberInput } from '../lib/wallet-safety.js';
import { maxNominationsFrom } from '../lib/stake-picker-view.js';
import { escapeHtml } from '../lib/html-escape.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const [V1, V2] = [21, 22].map(addr);
const PDEX = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1)); };
const SC109 = 'Your account is still loading. Try again in a moment.';

function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}
const LIFT = ['submitStakeTx', 'submitUnstakeTx', 'submitSignedTx', 'showStakeError', 'clearStakeError', 'stakeMaxNominations', 'batchTx', 'buildBondOrExtra', 'getStakeableBalance'];

let api;
before(async () => {
    const fx = loadFixture('metadata-mainnet-394.json');
    const mock = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion });
    api = await ApiPromise.create({ provider: mock.provider, noInitWarn: true });
});
after(async () => { await api?.disconnect(); });

async function world({ data, selected = [], typed = '', unstakeTyped = '', fullUnbond = null }) {
    const ext = fakeExtension('polkadot-js', [{ address: ME, name: 'One' }]);
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', ME);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    const tab = openTab(profile, { path: '/wallet/' + data.address });
    const doc = tab.root.ownerDocument;
    doc.body.insertAdjacentHTML('beforeend', `<div id="stake-modal" style="display:flex">
        <input type="text" id="stake-amount-input"><div id="stake-modal-error" style="display:none"></div><button id="submit-stake-tx-btn">Sign and stake</button></div>
        <div id="unstake-modal" style="display:flex"><input type="text" id="unstake-amount-input">
        <div id="unstake-modal-error" style="display:none"></div><button id="submit-unstake-tx-btn">Sign and unstake</button></div>`);
    doc.getElementById('stake-amount-input').value = typed;
    doc.getElementById('unstake-amount-input').value = unstakeTyped;
    const sent = [], built = [], reviews = [];
    Object.assign(tab.ctx, stakePlan, {
        FEE_MARGIN, pdexToPlanck, isPositiveNumberInput, maxNominationsFrom, validatorsCache: { meta: { maxNominations: 16 } }, stakeQuotaWarned: false, stakeCard: null,
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), formatDuration: () => '1 day', parseFloat, Math, Number,
        planckToPdexString: (p) => String(p), decodeUnstakeError: (raw) => String((raw && raw.message) || raw), refreshWalletDashboardFor: () => {},
        unstakeFullUnbondIntent: !!fullUnbond, unstakeMaxPlanck: fullUnbond,
        currentWalletData: data, stakeSelected: new Map(selected.map(a => [a, { address: a, name: null }])),
        globalApi: api, liveRuntimeError: () => null,
        multisigStore: { find: () => null },
        multisigUI: { review: async (o) => { reviews.push(o); } },
        showTxStatus: () => ({ stage: 'failed' }),
        postAction: { observe: () => ({ stage: (f) => f, show: (f) => f }) },
        trackSignedTx: (o) => ({ start() {}, buildFailed(e) { built.push(e); }, send: async (tx, who) => { sent.push({ tx, who, action: o.action }); } })
    });
    vm.runInContext(LIFT.map(lift).join(''), tab.ctx);
    const errorOf = (id) => { const e = doc.getElementById(id); return e.style.display === 'none' ? '' : e.textContent; };
    return { tab, sent, built, reviews, errorOf, fn: (n) => tab.fn(n), close: () => tab.close() };
}
const staker = (stakingOver = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 },
    staking: { totalStaked: 200, activeStaked: 200, activeStakedPlanck: String(200n * PDEX), nominating: [{ address: V1, name: 'Validator A' }, { address: V2, name: 'Validator B' }], ledgerRead: 'ok', controller: ME, ...stakingOver },
    network: { minStake: 100, eraDurationMs: 86_400_000 } });

describe('a: who signs is checked before signing', () => {
    test('full unstake from a stash whose controller is another account: refused with the existing controller message, nothing built', async () => {
        const w = await world({ data: staker({ controller: SOMEONE }), unstakeTyped: '200', fullUnbond: String(200n * PDEX) });
        await w.fn('submitUnstakeTx')();
        await flush();
        assert.equal(w.sent.length + w.built.length + w.reviews.length, 0, 'chill and unbond would fail NotController for a fee');
        assert.equal(w.errorOf('unstake-modal-error'), ERROR_COPY['staking.NotController']);
        w.close();
    });
    test('partial unstake from that stash: refused the same way', async () => {
        const w = await world({ data: staker({ controller: SOMEONE }), unstakeTyped: '50' });
        await w.fn('submitUnstakeTx')();
        await flush();
        assert.equal(w.sent.length + w.built.length + w.reviews.length, 0, 'unbond would fail NotController for a fee');
        assert.equal(w.errorOf('unstake-modal-error'), ERROR_COPY['staking.NotController']);
        w.close();
    });
    test('the stash that is its own controller (another encoding) still unstakes', async () => {
        const w = await world({ data: staker({ controller: encodeAddress(new Uint8Array(32).fill(1), 42) }), unstakeTyped: '200', fullUnbond: String(200n * PDEX) });
        await w.fn('submitUnstakeTx')();
        await flush();
        assert.equal(w.errorOf('unstake-modal-error'), '');
        assert.equal(w.sent.length, 1);
        w.close();
    });
    test('an account that is only a controller (no Bonded entry, a ledger under its key) adding PDEX: refused before bondExtra with the existing stash message', async () => {
        const w = await world({ data: staker({ controller: null }), selected: [V1, V2], typed: '5' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(w.sent.length + w.built.length + w.reviews.length, 0, 'bondExtra from a controller fails NotStash for a fee');
        assert.equal(w.errorOf('stake-modal-error'), ERROR_COPY['staking.NotStash']);
        w.close();
    });
    test('planStakeCalls: a controller-only account plans no bond or bondExtra', () => {
        const p = planStakeCalls({ hasBond: true, amountPlanck: 5n * PDEX, currentTargets: [V1], targets: [V1], stashDiffers: true });
        assert.deepEqual(p.calls, []);
        assert.deepEqual(p.problems, ['not-stash']);
        assert.equal(stakePlan.planProblemMessage(p), ERROR_COPY['staking.NotStash']);
    });
});

describe('b: the success card says what the plan signed, never "null"', () => {
    const body = (plan) => successCopy('staking.bondNominate', stakeResultParams(plan, { eraText: '24 hours' }), {});
    test('rewards only: SC-133 with the destination, no nomination and no "null"', () => {
        const plan = planStakeCalls({ hasBond: true, currentTargets: [V1], targets: [V1], currentPayee: { kind: 'staked' }, payee: 'stash' });
        assert.deepEqual(plan.calls.map(c => c.kind), ['setPayee']);
        const params = stakeResultParams(plan);
        assert.equal(params.amount, null);
        assert.equal(params.n, null);
        const r = body(plan);
        assert.equal(r.body, 'Rewards now go to: this account.');
        assert.ok(!/null|nominat/i.test(r.title + r.body + (r.next || '')), `${r.body} ${r.next}`);
    });
    test('params with nothing at all never print "null"', () => {
        const r = successCopy('staking.bondNominate', { amount: null, n: null, eraText: null }, {});
        assert.ok(!/null|undefined/.test(r.body + (r.next || '')), r.body);
    });
    test('first stake SC-130, validators only SC-132, add only SC-131, each with SC-134', () => {
        const first = body(planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [V1, V2] }));
        assert.equal(first.body, '150 PDEX staked with 2 validators.');
        assert.equal(first.next, 'It starts earning from the next era (eras last 24 hours). Claim rewards with Pay Out on My Account.');
        const only = body(planStakeCalls({ hasBond: true, currentTargets: [V1], targets: [V1, V2, addr(23)] }));
        assert.equal(only.body, 'Your validators were updated: 3 chosen.');
        const add = body(planStakeCalls({ hasBond: true, amountPlanck: 5n * PDEX, currentTargets: [V1], targets: [V1] }));
        assert.equal(add.body, '5 PDEX added to your stake. Your validators are unchanged.');
    });
});

describe('c: a stake that could not be read is not 0', () => {
    test('the card refuses with SC-109, not "Wallet data is not loaded."', async () => {
        const w = await world({ data: staker({ totalStaked: 0, activeStaked: 0, nominating: [], ledgerRead: 'failed' }), selected: [V1], typed: '150' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(w.sent.length + w.built.length + w.reviews.length, 0);
        assert.equal(w.errorOf('stake-modal-error'), SC109);
        w.close();
    });
    test('My Account: the Total Staked tile says SC-109 instead of 0 PDEX when the ledger read failed', () => {
        const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
        const doc = win.document;
        doc.body.innerHTML = '<div id="wallet-dashboard"></div>';
        const noop = () => '';
        const ctx = {
            console, Promise, Object, JSON, Array, Map, Set, String, Number, Math, Date, encodeURIComponent, setTimeout, clearTimeout,
            window: win, document: doc, navigator: { clipboard: { writeText: async () => {} } }, ...stakePlan,
            getStoredWallet: () => ME, isSameAddress: (x, y) => x === y, currentWalletData: null, walletAprData: null, walletFetchGen: 0, walletRecentStore: null, VALIDATE_ON: false,
            stakingFormatPDEX: (v) => Number(v || 0).toFixed(4), stakingFormatNumber: (n) => String(n), stakingShortAddress: (x) => String(x).slice(0, 6) + '...', stakingEscapeHtml: escapeHtml,
            getStakeableBalance: () => 0, hasInjectedWalletNow: () => true, readWalletValidator: () => Promise.resolve(null),
            payoutRefresh: { tileHtml: () => '', buttonHtml: () => '', paint() {} }, multisigUI: { mountAccounts() {}, mountPending() {} }, multisigStore: { find: () => null, list: () => [] }, postAction: {}, knownResults: {},
            openSendModal() {}, openStakeModal() {}, openUnstakeModal() {}, openIdentityModal() {}, openWalletPicker() {}, disconnectWallet() {}
        };
        for (const n of ['helpIcon', 'rewardHistoryLinkHtml', 'walletViewingSlotHtml', 'renderUsdSubscript', 'buildViewOnlyCallout', 'formatDuration', 'formatLocalDate',
            'makeTable', 'mountWalletRecentTx', 'fetchApiJson', 'bindViewOnlyCalloutHandlers', 'applyWalletActionBlock', 'scheduleWalletSigningRechecks',
            'mountBalanceLocks', 'lockActionDeps', 'mountNominationStatus', 'renderWalletAdvancedSection', 'refreshWalletMultisigs', 'renderWalletAprCard',
            'renderWalletPriceChart', 'walletValidatorCard', 'looksLikeTxHash', 'bindWalletActionHandlers']) ctx[n] = noop;
        vm.createContext(ctx);
        vm.runInContext(bodyOf(SCRIPT, 'renderWalletDashboard'), ctx);
        const tile = () => Array.from(doc.querySelectorAll('.staking-summary-card')).find(c => c.querySelector('.label')?.textContent.trim() === 'Total Staked');
        const wallet = (staking) => ({ address: ME, balance: { total: 100, free: 100, transferable: 99 }, staking, rewards: { claimedTotal: 0, unpaidEntries: [] }, network: {} });
        ctx.renderWalletDashboard(wallet({ totalStaked: 0, nominating: [], ledgerRead: 'failed' }), { history: [], configured: false }, null);
        const failed = tile();
        assert.ok(failed, 'no Total Staked tile');
        assert.ok(!/0\.0000 PDEX/.test(failed.textContent), `a failed read shows as ${failed.querySelector('.value').textContent.trim()}`);
        assert.equal(failed.querySelector('.value').textContent.trim(), SC109);
        ctx.renderWalletDashboard(wallet({ totalStaked: 0, nominating: [], ledgerRead: 'ok' }), { history: [], configured: false }, null);
        assert.equal(tile().querySelector('.value').textContent.trim(), '0.0000 PDEX', 'a read that worked still says 0');
        win.happyDOM.close();
    });
});
