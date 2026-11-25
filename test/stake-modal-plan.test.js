// The existing Stake modal signs the plan (WP1 of the stake card redesign,
// design 2026-11-22-stake-card-simple-and-advanced.md; F1 and F2 rulings of
// 2026-11-23). These run the REAL submitStakeTx, fillStakeMax and
// submitSignedTx from script.js in a wallet-world tab (real wallet session,
// real signer lookup against a fake extension), with a REAL ApiPromise booted
// from the mainnet 394 metadata as globalApi. Only the transaction watcher is a
// recorder: it keeps the transaction submitSignedTx hands it, unsigned.
//
// Names that do not exist in script.js are skipped when lifting, so the same
// file runs against the code before and after the change.
//
// Accounts are filler bytes at prefix 88 and belong to no one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { ApiPromise } from '@polkadot/api';
import { makeProfile, openTab, fakeExtension, A as ME, B as SOMEONE } from './helpers/wallet-world.js';
import { bodyOf, stripComments } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import * as stakePlan from '../lib/stake-plan.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';
import { pdexToPlanck } from '../lib/wallet-safety.js';
import { maxNominationsFrom } from '../lib/stake-picker-view.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const [V1, V2, V3] = [21, 22, 23].map(addr);
const PDEX = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1)); };

const LIFT = ['submitStakeTx', 'fillStakeMax', 'submitSignedTx', 'showStakeError', 'clearStakeError', 'stakeMaxNominations', 'batchTx', 'buildBondOrExtra', 'getStakeableBalance'];
function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}

let api;
before(async () => {
    const fx = loadFixture('metadata-mainnet-394.json');
    const mock = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion });
    api = await ApiPromise.create({ provider: mock.provider, noInitWarn: true });
});
after(async () => { await api?.disconnect(); });

const decode = (hexOrTx) => api.registry.createType('Call', typeof hexOrTx === 'string' ? hexOrTx : hexOrTx.method.toHex());
const name = (c) => `${c.section}.${c.method}`;
const ss58 = (x) => encodeAddress(decodeAddress(x.toString()), 88);

// One open Stake modal for `data` (the /api/wallet payload) with `selected` in
// the Selected box and `typed` in the amount field.
async function modal({ data, selected = [], typed = '', multisig = null, connected = ME }) {
    const ext = fakeExtension('polkadot-js', [{ address: ME, name: 'One' }]);
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', connected);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    const tab = openTab(profile, { path: '/wallet/' + data.address });
    const doc = tab.root.ownerDocument;
    doc.body.insertAdjacentHTML('beforeend', `<div id="stake-modal" style="display:flex">
        <input type="number" id="stake-amount-input"><button type="button" id="stake-max-btn">Max</button>
        <div id="stake-modal-error" style="display:none"></div><button id="submit-stake-tx-btn">Sign and stake</button></div>`);
    doc.getElementById('stake-amount-input').value = typed;
    const sent = [], built = [], reviews = [];
    Object.assign(tab.ctx, stakePlan, {
        FEE_MARGIN, pdexToPlanck, maxNominationsFrom, validatorsCache: { meta: { maxNominations: 16 } }, stakeQuotaWarned: false, stakeCard: null,
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), formatDuration: () => '1 day', parseFloat, Math, Number,
        currentWalletData: data, stakeSelected: new Map(selected.map(a => [a, { address: a, name: null }])),
        globalApi: api, liveRuntimeError: () => null,
        multisigStore: { find: () => multisig },
        multisigUI: { review: async (o) => { reviews.push(o); } },
        showTxStatus: () => ({ stage: 'failed' }),
        postAction: { observe: () => ({ stage: (f) => f, show: (f) => f }) },
        trackSignedTx: () => ({ start() {}, buildFailed(e) { built.push(e); }, send: async (tx, who) => { sent.push({ tx, who }); } })
    });
    vm.runInContext(LIFT.map(lift).join(''), tab.ctx);
    const input = doc.getElementById('stake-amount-input');
    const errorText = () => { const e = doc.getElementById('stake-modal-error'); return e.style.display === 'none' ? '' : e.textContent; };
    return { tab, input, errorText, sent, built, reviews, fn: (n) => tab.fn(n), close: () => tab.close() };
}

const firstTimer = (over = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 }, staking: { totalStaked: 0, nominating: [] }, network: { minStake: 100, eraDurationMs: 86_400_000 }, ...over });
const staker = (over = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 }, staking: { totalStaked: 200, nominating: [{ address: V1, name: 'Validator A' }, { address: V2, name: 'Validator B' }] }, network: { minStake: 100 }, ...over });

describe('the Stake modal signs the plan: one atomic batchAll for bond and nominate (F1)', () => {
    test('first stake: utility.batchAll[staking.bond(150 PDEX, Staked), staking.nominate(V1, V2)], through submitSignedTx', async () => {
        const m = await modal({ data: firstTimer(), selected: [V1, V2], typed: '150' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.errorText(), '');
        assert.equal(m.sent.length, 1, 'one transaction handed to the watcher');
        assert.equal(m.sent[0].who, ME);
        const c = decode(m.sent[0].tx);
        assert.equal(name(c), 'utility.batchAll', 'the stake plan is atomic, never forceBatch');
        assert.deepEqual(c.args[0].map(name), ['staking.bond', 'staking.nominate']);
        assert.equal(c.args[0][0].args[0].toBigInt(), 150n * PDEX);
        assert.ok(c.args[0][0].args[1].isStaked, 'rewards are added to the stake');
        assert.deepEqual(c.args[0][1].args[0].map(ss58), [V1, V2]);
        // One source (M6): what was signed is what planStakeCalls returns, built by buildStakeTx.
        const plan = stakePlan.planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [V1, V2] });
        assert.equal(m.sent[0].tx.method.toHex(), stakePlan.buildStakeTx(api, plan, { stash: ME }).method.toHex());
        assert.equal(m.input.value, '150', 'the typed amount is unchanged');
        m.close();
    });
    test('a multisig account: the review receives the same batchAll call', async () => {
        const m = await modal({ data: firstTimer(), selected: [V1], typed: '150', multisig: { address: ME, threshold: 2, signatories: [ME, SOMEONE] } });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.reviews.length, 1);
        assert.equal(m.sent.length, 0);
        const c = decode(m.reviews[0].callHex);
        assert.equal(name(c), 'utility.batchAll');
        assert.deepEqual(c.args[0].map(name), ['staking.bond', 'staking.nominate']);
        m.close();
    });
});

describe('the Stake modal signs only what changed (M7)', () => {
    test('an existing staker adding PDEX with the selection unchanged signs one bondExtra; the nominations are not touched', async () => {
        const m = await modal({ data: staker(), selected: [V2, V1], typed: '5' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.sent.length, 1);
        const c = decode(m.sent[0].tx);
        assert.equal(name(c), 'staking.bondExtra', 'no batch, no nominate');
        assert.equal(c.args[0].toBigInt(), 5n * PDEX);
        m.close();
    });
    test('an existing staker changing validators with no amount signs a bare nominate with the new list', async () => {
        const m = await modal({ data: staker(), selected: [V1, V3], typed: '' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.sent.length, 1);
        const c = decode(m.sent[0].tx);
        assert.equal(name(c), 'staking.nominate');
        assert.deepEqual(c.args[0].map(ss58), [V1, V3]);
        m.close();
    });
    test('nothing changed: nothing is signed and the card says so', async () => {
        const m = await modal({ data: staker(), selected: [V1, V2], typed: '' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.sent.length, 0);
        assert.equal(m.errorText(), 'Nothing to sign yet. Change the amount, the validators or the rewards.');
        m.close();
    });
});

describe('amounts in planck; the typed amount is never rewritten (F2, M3, M4)', () => {
    test('over the limit (99.99 of 100 transferable: no room for the fee): SC-101 with the exact Max, nothing signed, field unchanged', async () => {
        const m = await modal({ data: staker({ balance: { free: 300, transferable: 100 } }), selected: [V1, V2], typed: '99.99' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.sent.length, 0);
        assert.equal(m.errorText(), 'That is more than this account can stake. The most is 99.8 PDEX.');
        assert.equal(m.input.value, '99.99');
        m.close();
    });
    test('not a plain amount ("1,5"): SC-100, nothing signed, field unchanged', async () => {
        const m = await modal({ data: staker(), selected: [V1, V2], typed: '1,5' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.sent.length, 0);
        assert.equal(m.errorText(), 'Enter an amount in PDEX, for example 250.');
        assert.equal(m.input.value, '1,5');
        m.close();
    });
    test('above Max but payable (99.9 of 100): signs as typed, exact planck, field unchanged', async () => {
        const m = await modal({ data: staker({ balance: { free: 300, transferable: 100 } }), selected: [V1, V2], typed: '99.9' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.errorText(), '');
        assert.equal(m.sent.length, 1);
        assert.equal(name(decode(m.sent[0].tx)), 'staking.bondExtra', 'the unchanged validators are not re-sent');
        assert.equal(decode(m.sent[0].tx).args[0].toBigInt(), 99_900_000_000_000n);
        assert.equal(m.input.value, '99.9');
        m.close();
    });
    test('a first stake under the minimum: SC-105, nothing signed', async () => {
        const m = await modal({ data: firstTimer(), selected: [V1], typed: '99.999999' });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.sent.length, 0);
        assert.equal(m.errorText(), 'The smallest first stake is 100 PDEX.');
        m.close();
    });
    test('Max fills transferable less 0.2 PDEX, exact, and only when pressed', async () => {
        const m = await modal({ data: staker({ balance: { free: 300, transferable: 100.5 } }), selected: [V1, V2], typed: '7' });
        assert.equal(typeof m.tab.ctx.fillStakeMax, 'function', 'script.js has no fillStakeMax: the Max press is not wired to the planck rule');
        assert.equal(m.input.value, '7', 'nothing writes the field before the press');
        m.fn('fillStakeMax')();
        assert.equal(m.input.value, '100.3', '100.5 transferable, which already keeps the 1 PDEX deposit, less the 0.2 PDEX reserve');
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.errorText(), '');
        assert.equal(name(decode(m.sent[0].tx)), 'staking.bondExtra');
        assert.equal(decode(m.sent[0].tx).args[0].toBigInt(), 100_300_000_000_000n);
        m.close();
    });
});

describe('who can sign from the card', () => {
    test('a looked-up account that is not the connected wallet is refused with SC-110; nothing is built (no proxy path)', async () => {
        const m = await modal({ data: staker({ address: SOMEONE }), selected: [V1, V3], typed: '5', connected: ME });
        await m.fn('submitStakeTx')();
        await flush();
        assert.equal(m.errorText(), 'Connect this account\'s wallet to stake from it.');
        assert.equal(m.sent.length + m.reviews.length + m.built.length, 0);
        m.close();
    });
});

describe('the commission-only estimate never reaches the stake card (M10)', () => {
    test('no stake card file imports lib/apy.js or names its fields; the modal code path does not either', () => {
        const files = ['lib/stake-pick.js', 'lib/stake-plan.js', 'lib/stake-card-view.js', 'lib/stake-filters.js', 'lib/stake-apr.js', 'lib/stake-picker-view.js', 'lib/stake-choice-sync.js'];
        const BAD = /\/apy\.js|estimatedApy|APY_FIELD|apyFields|realApy|currentApy|avg30DayApy/;
        for (const f of files) {
            const code = stripComments(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
            assert.ok(!BAD.test(code), `${f} reads the commission-only estimate`);
        }
        const code = stripComments(SCRIPT);
        for (const fn of ['openStakeModal', 'submitStakeTx', 'fillStakeMax', 'renderStakeSelected', 'addStakeValidator']) {
            assert.ok(code.includes(`function ${fn}(`), `${fn} is missing`);
            assert.ok(!BAD.test(bodyOf(code, fn)), `${fn} reads the commission-only estimate`);
        }
    });
});
