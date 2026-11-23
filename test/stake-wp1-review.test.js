// Stake card WP1 review fixes (design 2026-11-22-stake-card-simple-and-advanced.md;
// review of WP1, 2026-11-23). Each block names its finding:
//   1 the full unstake signs chill and unbond in one atomic utility.batchAll,
//     never forceBatch, and is refused on a runtime without batchAll
//   2 a multisig staking batch is "Set up the validator" only when it sets keys
//     or validates
//   3 the success card says what the plan signed: an add-only stake never
//     claims nominations
//   4 current validators are matched by public key, not by address text
//   5 a failed ledger read is reported, and the stake plan then signs nothing;
//     a stash whose controller is another account is refused before signing
//     nominate
//   6 the rewards line fills {destination}
//
// The modal tests run the REAL submitStakeTx, submitUnstakeTx and
// submitSignedTx from script.js in a wallet-world tab, with a REAL ApiPromise
// booted from the mainnet 394 metadata; only the transaction watcher is a
// recorder. The route test runs the real /api/wallet handler over a seeded
// temp database with a fake chain. Accounts are filler bytes and belong to
// no one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { ApiPromise } from '@polkadot/api';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { makeProfile, openTab, fakeExtension, A as ME, B as SOMEONE } from './helpers/wallet-world.js';
import { bodyOf } from './helpers/source.js';
import { loadFixture, registryFromMetadata } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import * as stakePlan from '../lib/stake-plan.js';
import { planStakeCalls, planProblemMessage, buildStakeTx, stakeCopy } from '../lib/stake-plan.js';
import { reviewNominations, proposeReplacement, returnEstimate, pickValidators } from '../lib/stake-pick.js';
import { describeValidatorCall } from '../lib/validator-delegate.js';
import { successCopy, ERROR_COPY, PENDING_TITLE } from '../lib/tx-status.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';
import { pdexToPlanck, isPositiveNumberInput } from '../lib/wallet-safety.js';
import { maxNominationsFrom } from '../lib/stake-picker-view.js';
import * as db from '../db.js';
import { summarizeRewards } from '../lib/reward-dedup.js';
import { balanceBreakdown, accountBalances } from '../lib/balance-locks.js';
import { walletRecentFields } from '../lib/wallet-recent-tx.js';
import { buildFreshness, lowestTailFrom } from '../lib/freshness.js';
import { isFreshRequest } from '../lib/gov-refresh.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const [V1, V2, V3] = [21, 22, 23].map(n => addr(n));
const PDEX = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1)); };

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

const decode = (tx) => api.registry.createType('Call', tx.method.toHex());
const name = (c) => `${c.section}.${c.method}`;
const ss58 = (x) => encodeAddress(decodeAddress(x.toString()), 88);

// The same api with utility.batchAll taken away (forceBatch and batch stay).
function withoutBatchAll(real) {
    const tx = new Proxy(real.tx, { get(t, k) {
        if (k !== 'utility') return t[k];
        return { batch: t.utility.batch, forceBatch: t.utility.forceBatch };
    } });
    return new Proxy(real, { get(t, k) { return k === 'tx' ? tx : t[k]; } });
}

// One tab with the Stake and Unstake modals open for `data`.
async function world({ data, selected = [], typed = '', unstakeTyped = '', fullUnbond = null, chain = api }) {
    const ext = fakeExtension('polkadot-js', [{ address: ME, name: 'One' }]);
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', ME);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    const tab = openTab(profile, { path: '/wallet/' + data.address });
    const doc = tab.root.ownerDocument;
    doc.body.insertAdjacentHTML('beforeend', `<div id="stake-modal" style="display:flex">
        <input type="number" id="stake-amount-input"><div id="stake-modal-error" style="display:none"></div><button id="submit-stake-tx-btn">Sign and stake</button></div>
        <div id="unstake-modal" style="display:flex"><input type="number" id="unstake-amount-input">
        <div id="unstake-modal-error" style="display:none"></div><button id="submit-unstake-tx-btn">Sign and unstake</button></div>`);
    doc.getElementById('stake-amount-input').value = typed;
    doc.getElementById('unstake-amount-input').value = unstakeTyped;
    const sent = [], built = [], reviews = [];
    Object.assign(tab.ctx, stakePlan, {
        FEE_MARGIN, pdexToPlanck, isPositiveNumberInput, maxNominationsFrom, validatorsCache: { meta: { maxNominations: 16 } }, stakeQuotaWarned: false,
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), formatDuration: () => '1 day', parseFloat, Math, Number,
        planckToPdexString: (p) => String(p), decodeUnstakeError: (raw) => String((raw && raw.message) || raw), refreshWalletDashboardFor: () => {},
        unstakeFullUnbondIntent: !!fullUnbond, unstakeMaxPlanck: fullUnbond,
        currentWalletData: data, stakeSelected: new Map(selected.map(a => [a, { address: a, name: null }])),
        globalApi: chain, liveRuntimeError: () => null,
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

const staker = (over = {}, stakingOver = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 },
    staking: { totalStaked: 200, activeStaked: 200, activeStakedPlanck: String(200n * PDEX), nominating: [{ address: V1, name: 'Validator A' }, { address: V2, name: 'Validator B' }], ...stakingOver },
    network: { minStake: 100, eraDurationMs: 86_400_000 }, ...over });

describe('finding 1: the full unstake is one atomic utility.batchAll[chill, unbond]', () => {
    test('Max then Sign: utility.batchAll[staking.chill(), staking.unbond(all)] through submitSignedTx, never forceBatch', async () => {
        const all = String(200n * PDEX);
        const w = await world({ data: staker(), unstakeTyped: '200', fullUnbond: all });
        await w.fn('submitUnstakeTx')();
        await flush();
        assert.equal(w.errorOf('unstake-modal-error'), '');
        assert.equal(w.sent.length, 1, 'one transaction handed to the watcher');
        const c = decode(w.sent[0].tx);
        assert.equal(name(c), 'utility.batchAll', 'chill without unbond would stop earning and keep the PDEX bonded');
        assert.deepEqual(c.args[0].map(name), ['staking.chill', 'staking.unbond'], 'chill first, then unbond');
        assert.equal(c.args[0][1].args[0].toBigInt(), 200n * PDEX, 'the exact planck from the server');
        // One builder: the same plan built by buildStakeTx.
        assert.equal(w.sent[0].tx.method.toHex(), buildStakeTx(api, stakePlan.planFullUnbond(all)).method.toHex());
        w.close();
    });
    test('a runtime without utility.batchAll is refused before signing; no fall back to forceBatch or batch', async () => {
        const w = await world({ data: staker(), unstakeTyped: '200', fullUnbond: String(200n * PDEX), chain: withoutBatchAll(api) });
        await w.fn('submitUnstakeTx')();
        await flush();
        assert.equal(w.sent.length, 0, 'nothing was handed to the wallet');
        assert.equal(w.built.length, 1, 'the builder refused');
        assert.equal(w.built[0].message, 'This runtime has no utility.batchAll; do the steps one at a time from your wallet app.');
        w.close();
    });
    test('payouts stay on forceBatch: each claim stands alone', () => {
        const body = bodyOf(SCRIPT, 'batchTx');
        assert.match(body, /utility\.forceBatch\) return api\.tx\.utility\.forceBatch\(calls\)/);
        assert.ok(bodyOf(SCRIPT, 'submitPayoutTx').includes('batchTx('), 'payouts build through batchTx');
    });
});

describe('finding 2: a multisig staking batch is labelled by what it holds', () => {
    let registry, ex;
    before(() => {
        registry = registryFromMetadata(loadFixture('metadata-mainnet-394.json').metadata);
        ex = decorateExtrinsics(registry, registry.metadata, 15);
    });
    const call = (tx) => registry.createType('Call', tx.toHex());
    const KEYS = '0x' + '11'.repeat(32 * 5) + '02' + '66'.repeat(32);
    test('bondExtra and setPayee: the existing staking title, not "Set up the validator"', () => {
        const label = describeValidatorCall(call(ex.utility.batchAll([ex.staking.bondExtra(5n * PDEX), ex.staking.setPayee('Stash')])));
        assert.equal(label, `${PENDING_TITLE['staking.bondNominate']}: bond 5 PDEX more, change where rewards go`);
        assert.equal(label, 'Updating your stake: bond 5 PDEX more, change where rewards go');
    });
    test('chill and unbond (the full unstake): the staking title', () => {
        // The parts are the file's existing words, lower-cased as they always were
        // ("unbond 5 pdex"); only the title before the colon is this finding.
        assert.match(describeValidatorCall(call(ex.utility.batchAll([ex.staking.chill(), ex.staking.unbond(5n * PDEX)]))),
            /^Updating your stake: stop validating, unbond 5 /);
        assert.equal(describeValidatorCall(call(ex.utility.batch([ex.staking.bondExtra(5n * PDEX), ex.staking.setPayee('Staked')]))),
            'Updating your stake: bond 5 PDEX more, change where rewards go', 'utility.batch the same');
    });
    test('a batch with validate or setKeys stays "Set up the validator"', () => {
        assert.equal(describeValidatorCall(call(ex.utility.batchAll([ex.staking.bondExtra(5n * PDEX), ex.staking.validate({ commission: 50_000_000, blocked: false })]))),
            'Set up the validator: bond 5 PDEX more, commission 5%');
        assert.equal(describeValidatorCall(call(ex.utility.batchAll([ex.staking.bond(200n * PDEX, 'Staked'), ex.session.setKeys(KEYS, '0x')]))),
            'Set up the validator: bond 200 PDEX, register session keys');
        assert.equal(describeValidatorCall(call(ex.utility.batchAll([ex.session.setKeys(KEYS, '0x'), ex.staking.chill()]))),
            'Set up the validator: register session keys, stop validating');
    });
    test('a batch with a call outside the validator calls stays unlabelled (bond and nominate, as before)', () => {
        assert.equal(describeValidatorCall(call(ex.utility.batchAll([ex.staking.bond(200n * PDEX, 'Staked'), ex.staking.nominate([V1])]))), null);
    });
    test('the WP3 freeze records the new hash of lib/validator-delegate.js (the label rule is its only change)', () => {
        const got = createHash('sha256').update(readFileSync(new URL('../lib/validator-delegate.js', import.meta.url))).digest('hex');
        const freeze = readFileSync(new URL('./wp3-freeze.test.js', import.meta.url), 'utf8');
        assert.ok(freeze.includes(`'lib/validator-delegate.js': '${got}'`), `wp3-freeze.test.js does not hold ${got}`);
    });
});

describe('finding 3: the success card says what was signed', () => {
    const result = (w) => { const a = w.sent[0].action; return successCopy(a.key, a.params, {}); };
    test('add only (bondExtra signed alone): SC-131 and SC-134, no nomination claimed', async () => {
        const w = await world({ data: staker(), selected: [V2, V1], typed: '5' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(name(decode(w.sent[0].tx)), 'staking.bondExtra');
        const r = result(w);
        assert.equal(r.body, '5 PDEX added to your stake. Your validators are unchanged.');
        assert.equal(r.body, stakeCopy('SC-131', { amount: '5' }));
        assert.equal(r.next, stakeCopy('SC-134', { era: '1 day' }));
        assert.ok(!/nominat/i.test(r.body + r.next), `claims a nomination: ${r.body} ${r.next}`);
        w.close();
    });
    test('first stake: the amount and the validators signed', async () => {
        const w = await world({ data: staker({}, { totalStaked: 0, activeStaked: 0, nominating: [] }), selected: [V1, V2], typed: '150' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(result(w).body, '150 PDEX bonded and 2 validators nominated.');
        w.close();
    });
    test('validators only (bare nominate): no amount', async () => {
        const w = await world({ data: staker(), selected: [V1, V3, V2], typed: '' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(name(decode(w.sent[0].tx)), 'staking.nominate');
        assert.equal(result(w).body, '3 validators nominated.');
        w.close();
    });
    test('add and change validators: both', async () => {
        const w = await world({ data: staker(), selected: [V1, V3], typed: '5' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.deepEqual(decode(w.sent[0].tx).args[0].map(name), ['staking.bondExtra', 'staking.nominate']);
        assert.equal(result(w).body, '5 PDEX bonded and 2 validators nominated.');
        w.close();
    });
});

describe('finding 4: current validators are matched by public key', () => {
    const isSameAddress = vm.runInNewContext(bodyOf(SCRIPT, 'isSameAddress') + '; isSameAddress', { decodeAddress });
    const ERA = 500;
    const META = { activeEra: ERA, pageSize: 256, full: true };
    const val = (n, apr = 10) => ({ address: addr(n), name: `Validator ${n}`, active: true, commission: 5, blocked: false, selfStake: 1000, totalStake: 50000,
        exposurePages: 1, exposureNominators: 20, backers: 20, identity: { hasIdentity: false, verified: false, parent: null }, slashEras: [],
        commissionHistory: { raisedRecently: false, pendingRaise: false }, perf: { 28: { status: 'ok', apr, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100 } } });
    const list = () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => val(n, 10 + n));
    const generic = [1, 2, 3].map(n => addr(n, 42));   // the same keys, prefix 42 as a wallet or the chain may give them
    test('the comparison: two encodings of one key are the same account, another key is not', () => {
        assert.notEqual(generic[0], addr(1));
        assert.equal(isSameAddress(generic[0], addr(1)), true);
        assert.equal(isSameAddress(generic[0], addr(2)), false);
    });
    for (const [how, opts] of [['by default', {}], ['with isSameAddress from script.js', { same: isSameAddress }]]) {
        test(`reviewNominations finds prefix 42 validators in a prefix 88 snapshot (${how})`, () => {
            const by = new Map(list().map(v => [v.address, v]));
            const r = reviewNominations(generic, by, { median: 12, activeEra: ERA, ...opts });
            assert.deepEqual(r.rows.map(x => x.state), ['ok', 'ok', 'ok'], 'every healthy validator would show as Removed');
            assert.equal(r.unhealthy, 0);
        });
        test(`proposeReplacement offers nothing when the same healthy validators are encoded differently (${how})`, () => {
            const p = proposeReplacement([8, 9, 10].map(n => addr(n, 42)), list(), META, opts);
            assert.equal(p.offer, false, 'a full replacement was offered for healthy validators');
            assert.deepEqual(p.removed, []);
        });
        test(`pickValidators keeps a prefix 42 address as kept (${how})`, () => {
            const r = pickValidators(list(), META, { keep: [addr(10, 42)], ...opts });
            assert.equal(r.picks[0].address, addr(10));
            assert.equal(r.picks[0].kept, true);
            assert.equal(r.picks.filter(p => p.address === addr(10)).length, 1);
        });
    }
    test('returnEstimate counts prefix 42 validators', () => {
        const by = new Map(list().map(v => [v.address, v]));
        const r = returnEstimate(generic, by);
        assert.equal(r.counted, 3);
        assert.equal(r.low, 11);
        assert.equal(r.high, 13);
    });
});

describe('finding 5: an unknown stake plans nothing; a different controller is refused before nominate', () => {
    test('planStakeCalls: hasBond null (the ledger could not be read) plans no bond and nothing else', () => {
        for (const amountPlanck of [150n * PDEX, null]) {
            const p = planStakeCalls({ hasBond: null, amountPlanck, targets: [V1] });
            assert.deepEqual(p.calls, [], 'bond would fail AlreadyBonded on a staked account, for a fee');
            assert.deepEqual(p.problems, ['bonded-unknown']);
            assert.equal(planProblemMessage(p), 'Wallet data is not loaded.');
            assert.throws(() => buildStakeTx(api, p));
        }
    });
    test('the modal: a failed ledger read signs nothing and shows the existing message', async () => {
        const w = await world({ data: staker({}, { totalStaked: 0, activeStaked: 0, nominating: [], ledgerRead: 'failed' }), selected: [V1], typed: '150' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(w.sent.length + w.built.length + w.reviews.length, 0, 'a bond was built for an account whose stake is unknown');
        assert.equal(w.errorOf('stake-modal-error'), 'Wallet data is not loaded.');
        w.close();
    });
    test('the modal: a stash whose controller is another account is refused before signing nominate (existing controller message)', async () => {
        const w = await world({ data: staker({}, { controller: SOMEONE }), selected: [V1, V3], typed: '' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(w.sent.length + w.built.length + w.reviews.length, 0, 'nominate would fail NotController for a fee');
        assert.equal(w.errorOf('stake-modal-error'), ERROR_COPY['staking.NotController']);
        w.close();
    });
    test('the modal: the same stash adding PDEX only still signs bondExtra (a stash call)', async () => {
        const w = await world({ data: staker({}, { controller: SOMEONE }), selected: [V1, V2], typed: '5' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(w.errorOf('stake-modal-error'), '');
        assert.equal(name(decode(w.sent[0].tx)), 'staking.bondExtra');
        w.close();
    });
    test('the modal: a controller that is the stash in another encoding signs nominate', async () => {
        const w = await world({ data: staker({}, { controller: encodeAddress(decodeAddress(ME), 42) }), selected: [V1, V3], typed: '' });
        await w.fn('submitStakeTx')();
        await flush();
        assert.equal(name(decode(w.sent[0].tx)), 'staking.nominate');
        assert.deepEqual(decode(w.sent[0].tx).args[0].map(ss58), [V1, V3]);
        w.close();
    });
});

describe('finding 5: /api/wallet reports a failed ledger read and the controller (real handler, seeded database)', () => {
    const at88 = (a) => encodeAddress(decodeAddress(a), 88);
    const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
    const num = (n) => ({ toNumber: () => Number(n), toString: () => String(n), toBigInt: () => BigInt(n) });
    const fakeRes = () => { const r = { headers: {}, statusCode: 200, body: undefined, set(k, v) { r.headers[k.toLowerCase()] = v; return r; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = JSON.parse(JSON.stringify(b)); return r; } }; return r; };
    function routeSource(p) {
        const start = SERVER.indexOf(`app.get('${p}'`);
        assert.ok(start !== -1, `route ${p} not found`);
        let i = SERVER.indexOf('=> {', start) + 3, depth = 0;
        for (; i < SERVER.length; i++) {
            if (SERVER[i] === '{') depth++;
            else if (SERVER[i] === '}' && --depth === 0) break;
        }
        return SERVER.slice(start, SERVER.indexOf(';', i) + 1);
    }
    let dir;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-stake-wp1-'));
        db.initDb(dir, true, { awaitMigrator: false });
        db.setSyncState('chain_index', { headSeen: 990, latestScannedBlock: 990, status: 'Synced' });
        db.setSyncState('staking_rewards', { headSeen: 960, latestScannedBlock: 960, status: 'Synced' });
    });
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
    async function call({ bonded = null, ledger }) {
        const chain = {
            rpc: { chain: { getHeader: async () => ({ number: num(1000) }) } },
            query: {
                system: { account: async () => ({ data: { free: num(500n * PDEX), reserved: num(0), frozen: num(0) } }) },
                staking: { bonded: async () => opt(bonded), nominators: async () => opt(null), activeEra: async () => opt({ index: num(10) }), ledger },
                session: { validators: async () => [] }
            },
            consts: { balances: { existentialDeposit: num(PDEX) }, staking: {}, babe: {} }
        };
        const handlers = {};
        const ctx = {
            console: { warn() {}, log() {}, error() {} }, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object, Error, setTimeout, clearTimeout,
            app: { get: (p, fn) => { handlers[p] = fn; } },
            globalApi: chain, db, summarizeRewards, balanceBreakdown, accountBalances, walletRecentFields, buildFreshness, lowestTailFrom, isFreshRequest,
            isValidAddress: (a) => { try { decodeAddress(a); return true; } catch { return false; } },
            normalizeAddress: (a) => at88(a), requireRpc: () => true, isRpcReady: () => true,
            getIdentity: async () => 'Unknown', balanceToPDEX: (v) => Number(String(v)) / 1e12,
            UNCLAIMED_TTL: 20 * 60 * 1000, computingUnclaimed: new Set(), recomputeUnclaimed: () => {},
            getNetworkInfo: async () => null, getMinNominatorBondCached: async () => 1,
            serverError: (res, err) => { res.status(500).json({ error: String(err && err.message) }); },
            computeRealizedApr: () => null, CHAIN_INDEX_INTERVAL_MS: 12_000, STAKING_REWARDS_INTERVAL_MS: 60_000, THIRTY_SECONDS: 30_000,
            process: { env: {} }, DEV_API_TIMEOUT_MS: 30_000
        };
        vm.createContext(ctx);
        const optLine = (start) => { const i = SERVER.indexOf(start); return i === -1 ? '' : SERVER.slice(i, SERVER.indexOf('\n', i)); };
        vm.runInContext([optLine('const FRESHNESS_HEAD_TIMEOUT_MS'), optLine('const FRESHNESS_HEAD_MEMO_MS'), optLine('const freshnessHeadMemo'), bodyOf(SERVER, 'withTimeout'),
            bodyOf(SERVER, 'lowestHoleFrom'), 'async ' + bodyOf(SERVER, 'freshnessHead'), 'async ' + bodyOf(SERVER, 'routeFreshness'), bodyOf(SERVER, 'freshnessNow'),
            routeSource('/api/wallet/:address')].join('\n'), ctx);
        const res = fakeRes();
        await handlers['/api/wallet/:address']({ params: { address: ME }, query: {}, path: '/api/wallet/:address' }, res);
        return res;
    }
    const ledgerOf = (total) => opt({ total: num(total), active: num(total), unlocking: [] });
    test('a ledger read that throws is reported as failed, not as an unstaked account', async () => {
        const r = await call({ bonded: ME, ledger: async () => { throw new Error('node gone'); } });
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        assert.equal(r.body.staking.ledgerRead, 'failed', 'the failure was swallowed as 0 staked');
        assert.equal(r.body.staking.controller, at88(ME));
    });
    test('a read that works says ok; the controller is the Bonded entry, null when not bonded', async () => {
        const ok = await call({ bonded: SOMEONE, ledger: async () => ledgerOf(200n * PDEX) });
        assert.equal(ok.body.staking.ledgerRead, 'ok');
        assert.equal(ok.body.staking.totalStaked, 200);
        assert.equal(ok.body.staking.controller, at88(SOMEONE));
        const none = await call({ bonded: null, ledger: async () => opt(null) });
        assert.equal(none.body.staking.ledgerRead, 'ok');
        assert.equal(none.body.staking.controller, null);
        assert.equal(none.body.staking.totalStaked, 0);
    });
});

describe('finding 6: the rewards line fills {destination}', () => {
    const line = (payee) => planStakeCalls({ hasBond: true, currentTargets: [V1], targets: [V1], currentPayee: { kind: 'staked' }, payee }).lines[0];
    test('each destination reads as words or the address, never a literal placeholder', () => {
        const other = addr(99);
        const cases = [[{ kind: 'stash' }, 'Send rewards to this account'], [{ kind: 'account', account: other }, `Send rewards to ${other}`]];
        for (const [payee, want] of cases) {
            const l = line(payee);
            assert.equal(l.id, 'SC-80e');
            const text = stakeCopy(l.id, l.params);
            assert.ok(!/[{}]/.test(text), `a literal placeholder: ${text}`);
            assert.equal(text, want);
        }
        const toStake = planStakeCalls({ hasBond: true, currentTargets: [V1], targets: [V1], currentPayee: { kind: 'stash' }, payee: 'staked' }).lines[0];
        assert.equal(stakeCopy(toStake.id, toStake.params), 'Send rewards to your stake');
    });
});
