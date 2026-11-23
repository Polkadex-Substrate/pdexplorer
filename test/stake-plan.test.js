// What the Stake PDEX card signs (lib/stake-plan.js): design
// 2026-11-22-stake-card-simple-and-advanced.md sections 9 and 10.1, CEO
// decisions 2026-11-23 (rewards added to the stake by default, Max leaves 1.2
// PDEX, the stake plan in one atomic utility.batchAll).
//
// Every plan row, every amount code at its boundary in planck, the view
// preference with hostile storage, the builder against a recording fake api
// and against the REAL mainnet 394 metadata (test/fixtures/metadata-mainnet-394.json).
// Accounts are filler bytes at prefix 88 and belong to no one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { ApiPromise } from '@polkadot/api';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import { planStakeCalls, buildStakeTx, stakeCalls, stakeAmountCheck, stakeAmountMessage, planProblemMessage, stakeMaxPlanck,
    parseAmountPlanck, planckToPdexText, pdexNumberToPlanck, transferablePlanckOf, loadStakeView, saveStakeView, STAKE_VIEW_KEY,
    STAKE_COPY, stakeCopy, STAKE_FEE_RESERVE_PLANCK, payeeArg } from '../lib/stake-plan.js';

const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const [A, B, C, D, ME, OTHER] = [11, 12, 13, 14, 1, 2].map(n => addr(n));
const PDEX = 10n ** 12n;
const kinds = (plan) => plan.calls.map(c => c.kind);

describe('planStakeCalls: one call per change, in the order bond or bondExtra, setPayee, nominate', () => {
    test('first stake: bond with rewards added to the stake, then nominate', () => {
        const p = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A, B] });
        assert.deepEqual(p.calls, [
            { kind: 'bond', args: { value: (150n * PDEX).toString(), payee: { kind: 'staked' } } },
            { kind: 'nominate', args: { targets: [A, B] } }
        ]);
        assert.deepEqual(p.lines, [{ id: 'SC-80a', params: { amount: '150' } }, { id: 'SC-80c', params: { n: 2 } }]);
        assert.equal(p.primary, 'SC-50');
        assert.deepEqual(p.problems, []);
    });
    test('first stake with a chosen destination bonds with it; no separate setPayee', () => {
        const p = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A], payee: { kind: 'account', account: OTHER } });
        assert.deepEqual(kinds(p), ['bond', 'nominate']);
        assert.deepEqual(p.calls[0].args.payee, { kind: 'account', account: OTHER });
    });
    test('add more: bondExtra only; the existing nominations are not re-sent, whatever the selection order', () => {
        const p = planStakeCalls({ hasBond: true, amountPlanck: 5n * PDEX, currentTargets: [A, B, C], targets: [C, A, B] });
        assert.deepEqual(p.calls, [{ kind: 'bondExtra', args: { value: (5n * PDEX).toString() } }]);
        assert.deepEqual(p.lines, [{ id: 'SC-80b', params: { amount: '5' } }]);
        assert.equal(p.primary, 'SC-50');
    });
    test('add more with the selection in another SS58 encoding: the comparator decides, nothing is re-sent', () => {
        const same = (x, y) => Buffer.from(decodeAddress(x)).equals(Buffer.from(decodeAddress(y)));
        assert.deepEqual(kinds(planStakeCalls({ hasBond: true, amountPlanck: 1n, currentTargets: [addr(11, 42)], targets: [A], same })), ['bondExtra']);
        assert.deepEqual(kinds(planStakeCalls({ hasBond: true, amountPlanck: 1n, currentTargets: [addr(11, 42)], targets: [A] })), ['bondExtra', 'nominate'], 'the default comparator is strict');
    });
    test('change validators: nominate only, the new list in the selection order', () => {
        const p = planStakeCalls({ hasBond: true, amountPlanck: null, currentTargets: [A, B], targets: [B, C] });
        assert.deepEqual(p.calls, [{ kind: 'nominate', args: { targets: [B, C] } }]);
        assert.deepEqual(p.lines, [{ id: 'SC-80d', params: { n: 2 } }]);
        assert.equal(p.primary, 'SC-51');
    });
    test('change rewards destination: setPayee only; an unchanged destination is never re-sent', () => {
        const p = planStakeCalls({ hasBond: true, currentTargets: [A], targets: [A], currentPayee: { kind: 'staked' }, payee: { kind: 'stash' } });
        assert.deepEqual(p.calls, [{ kind: 'setPayee', args: { payee: { kind: 'stash' } } }]);
        assert.equal(p.primary, 'SC-52');
        assert.deepEqual(planStakeCalls({ hasBond: true, currentTargets: [A], targets: [A], currentPayee: { kind: 'stash' }, payee: 'stash' }).calls, []);
        assert.deepEqual(planStakeCalls({ hasBond: true, currentTargets: [A], targets: [A], currentPayee: { kind: 'account', account: OTHER }, payee: { kind: 'account', account: OTHER } }).calls, []);
        assert.deepEqual(kinds(planStakeCalls({ hasBond: true, currentTargets: [A], targets: [A], currentPayee: { kind: 'account', account: OTHER }, payee: { kind: 'account', account: ME } })), ['setPayee']);
        assert.deepEqual(planStakeCalls({ hasBond: true, currentTargets: [A], targets: [A], currentPayee: { kind: 'staked' }, payee: 'current' }).calls, []);
    });
    test('combined: each pair and all three, in order', () => {
        const base = { hasBond: true, currentTargets: [A], currentPayee: { kind: 'staked' } };
        const ROWS = [
            [{ amountPlanck: PDEX, payee: 'stash', targets: [A] }, ['bondExtra', 'setPayee'], 'SC-50'],
            [{ amountPlanck: PDEX, targets: [B] }, ['bondExtra', 'nominate'], 'SC-50'],
            [{ payee: 'stash', targets: [B] }, ['setPayee', 'nominate'], 'SC-53'],
            [{ amountPlanck: PDEX, payee: 'stash', targets: [B, C] }, ['bondExtra', 'setPayee', 'nominate'], 'SC-50']
        ];
        for (const [over, want, primary] of ROWS) {
            const p = planStakeCalls({ ...base, ...over });
            assert.deepEqual(kinds(p), want, want.join(' + '));
            assert.equal(p.primary, primary, want.join(' + '));
            assert.equal(p.lines.length, want.length);
        }
    });
    test('nothing changed: no calls, no primary, no problem', () => {
        const p = planStakeCalls({ hasBond: true, amountPlanck: 0n, currentTargets: [A, B], targets: [B, A] });
        assert.deepEqual(p, { calls: [], lines: [], primary: null, problems: [] });
        assert.equal(planProblemMessage(p), 'Nothing to sign yet. Change the amount, the validators or the rewards.');
    });
    test('staked with no validators: choosing some is a nominate; adding PDEX with none chosen is refused', () => {
        const p = planStakeCalls({ hasBond: true, currentTargets: [], targets: [A, B] });
        assert.deepEqual(kinds(p), ['nominate']);
        assert.deepEqual(p.lines, [{ id: 'SC-80c', params: { n: 2 } }]);
        assert.equal(p.primary, 'SC-51');
        const more = planStakeCalls({ hasBond: true, amountPlanck: PDEX, currentTargets: [], targets: [] });
        assert.deepEqual(more.calls, [], 'more PDEX behind no validator earns nothing: not signed');
        assert.deepEqual(more.problems, ['no-validators']);
    });
    test('a first stake needs an amount and validators; any problem empties the calls', () => {
        const noAmount = planStakeCalls({ hasBond: false, amountPlanck: null, targets: [A] });
        assert.deepEqual(noAmount.calls, []);
        assert.deepEqual(noAmount.problems, ['amount-required']);
        assert.equal(planProblemMessage(noAmount), 'Enter an amount to stake.');
        const noTargets = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [] });
        assert.deepEqual(noTargets.calls, [], 'a bond with no nominate is never planned');
        assert.equal(planProblemMessage(noTargets), 'Choose at least one validator.');
        const tooMany = planStakeCalls({ hasBond: false, amountPlanck: PDEX, targets: [A, B, C], maxTargets: 2 });
        assert.deepEqual(tooMany.calls, []);
        assert.equal(planProblemMessage(tooMany, { maxTargets: 2 }), 'You can choose up to 2 validators. Remove one to add another.');
        const emptied = planStakeCalls({ hasBond: true, currentTargets: [A], targets: [] });
        assert.deepEqual(emptied.problems, ['no-validators'], 'an empty nominate is never planned');
    });
    test('a duplicate in the selection is sent once', () => {
        assert.deepEqual(planStakeCalls({ hasBond: false, amountPlanck: PDEX, targets: [A, A, B] }).calls[1].args.targets, [A, B]);
    });
});

describe('stakeAmountCheck: every code at its boundary, in planck', () => {
    // Transferable 100 PDEX and 7 planck; reserve 0.2; fee floor 0.05; minimum 50.
    const T = 100n * PDEX + 7n;
    const RES = STAKE_FEE_RESERVE_PLANCK, FLOOR = 5n * 10n ** 10n, MIN = 50n * PDEX;
    const chk = (typed, o = {}) => stakeAmountCheck({ typed, transferablePlanck: T, feeReservePlanck: RES, feeFloorPlanck: FLOOR, minStakePlanck: MIN, hasBond: false, ...o });
    test('the reserve is 0.2 PDEX, so Max leaves 1.2 PDEX free with the 1 PDEX transferable already keeps', () => {
        assert.equal(RES, 200_000_000_000n);
        assert.equal(stakeMaxPlanck({ transferablePlanck: T }), T - RES);
        assert.equal(planckToPdexText(stakeMaxPlanck({ transferablePlanck: T })), '99.800000000007');
        assert.equal(stakeMaxPlanck({ transferablePlanck: RES - 1n }), 0n);
        assert.equal(stakeMaxPlanck({ transferablePlanck: 0n }), 0n);
    });
    const ROWS = [
        ['', {}, 'empty', null],
        ['   ', {}, 'empty', null],
        ['abc', {}, 'invalid', null],
        ['1,5', {}, 'invalid', null],
        ['1e5', {}, 'invalid', null],
        ['-1', {}, 'invalid', null],
        ['+1', {}, 'invalid', null],
        ['0x10', {}, 'invalid', null],
        ['1.0000000000001', {}, 'invalid', null],
        ['0', {}, 'invalid', 0n],
        ['0', { hasBond: true, optional: true }, 'empty', 0n],
        ['0.000', { hasBond: true, optional: true }, 'empty', 0n],
        ['99.800000000007', {}, 'ok', T - RES],
        ['99.800000000008', {}, 'low-reserve', T - RES + 1n],
        ['99.950000000007', {}, 'low-reserve', T - FLOOR],
        ['99.950000000008', {}, 'over', T - FLOOR + 1n],
        ['100.000000000007', {}, 'over', T],
        ['49.999999999999', {}, 'below-min', MIN - 1n],
        ['50', {}, 'ok', MIN],
        ['1', { hasBond: true }, 'ok', PDEX],
        ['.5', { hasBond: true }, 'ok', PDEX / 2n],
        [' 7.25 ', { hasBond: true }, 'ok', 7_250_000_000_000n]
    ];
    for (const [typed, o, code, planck] of ROWS) {
        test(`${JSON.stringify(typed)}${o.hasBond ? ' (has a stake)' : ''}: ${code}`, () => {
            const r = chk(typed, o);
            assert.equal(r.code, code);
            assert.equal(r.planck, planck);
            assert.equal(r.maxPlanck, T - RES);
            if (planck != null) assert.equal(r.leftPlanck, T > planck ? T - planck : 0n);
            for (const [k, v] of Object.entries(r)) if (k !== 'code') assert.notEqual(typeof v, 'string', `${k}: the check never hands back a corrected amount`);
        });
    }
    test('over beats below-min; the fee floor counts only for over', () => {
        assert.equal(stakeAmountCheck({ typed: '10', transferablePlanck: 10n * PDEX, feeFloorPlanck: 1n, minStakePlanck: 50n * PDEX }).code, 'over');
        assert.equal(stakeAmountCheck({ typed: '10', transferablePlanck: 10n * PDEX, minStakePlanck: 0n }).code, 'low-reserve');
    });
    test('messages: the spec strings, with exact figures; low-reserve and an optional empty amount are not errors here', () => {
        assert.equal(stakeAmountMessage(chk('abc')), 'Enter an amount in PDEX, for example 250.');
        assert.equal(stakeAmountMessage(chk('100')), 'That is more than this account can stake. The most is 99.800000000007 PDEX.');
        assert.equal(stakeAmountMessage(chk('49')), 'The smallest first stake is 50 PDEX.');
        assert.equal(stakeAmountMessage(chk('')), 'Enter an amount to stake.');
        assert.equal(stakeAmountMessage(chk('', { hasBond: true, optional: true }), { optional: true }), null);
        assert.equal(stakeAmountMessage(chk('99.9')), null);
        assert.equal(stakeAmountMessage(chk('60')), null);
    });
    test('the amber notice for low-reserve (SC-104) is the spec text with the exact amount left', () => {
        const r = chk('99.9');
        assert.equal(r.code, 'low-reserve');
        assert.equal(stakeCopy('SC-104', { left: planckToPdexText(r.leftPlanck) }),
            'This leaves 0.100000000007 PDEX free. You need free PDEX to pay the fee when you claim rewards or unstake.');
    });
});

describe('planck helpers', () => {
    test('parseAmountPlanck: plain decimals up to 12 places, nothing else', () => {
        assert.equal(parseAmountPlanck('1.5'), 1_500_000_000_000n);
        assert.equal(parseAmountPlanck('340282366920938463463.374607431768'), 340282366920938463463374607431768n);
        assert.equal(parseAmountPlanck('1.'), null);
        assert.equal(parseAmountPlanck('1.1234567890123'), null);
    });
    test('pdexNumberToPlanck: down for a balance, up for a minimum, at the micro-PDEX', () => {
        assert.equal(pdexNumberToPlanck(100.5), 100_500_000_000_000n);
        assert.equal(pdexNumberToPlanck(0.3), 300_000_000_000n);
        assert.equal(pdexNumberToPlanck(1.0000004), 1_000_000_000_000n);
        assert.equal(pdexNumberToPlanck(1.0000004, 'ceil'), 1_000_001_000_000n);
        assert.equal(pdexNumberToPlanck(100, 'ceil'), 100n * PDEX);
        for (const bad of [null, undefined, NaN, -1, 0, 'x']) assert.equal(pdexNumberToPlanck(bad), 0n);
        assert.equal(transferablePlanckOf({ transferable: 12.25 }), 12_250_000_000_000n);
        assert.equal(transferablePlanckOf(null), 0n);
        assert.equal(transferablePlanckOf({}), 0n);
    });
});

describe('the view preference: simple unless the store says advanced, never throws', () => {
    test('values, a missing store and a hostile one', () => {
        const m = new Map();
        const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
        assert.equal(STAKE_VIEW_KEY, 'pdex_stake_view_v1');
        assert.equal(loadStakeView(store), 'simple');
        assert.equal(saveStakeView(store, 'advanced'), true);
        assert.equal(loadStakeView(store), 'advanced');
        assert.equal(saveStakeView(store, 'anything'), true);
        assert.equal(m.get(STAKE_VIEW_KEY), 'simple');
        for (const v of ['ADVANCED', 'advanced ', '{}', '1']) { m.set(STAKE_VIEW_KEY, v); assert.equal(loadStakeView(store), 'simple', v); }
        assert.equal(loadStakeView(null), 'simple');
        assert.equal(saveStakeView(null, 'advanced'), false);
        const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
        assert.equal(loadStakeView(hostile), 'simple');
        assert.equal(saveStakeView(hostile, 'advanced'), false);
        assert.deepEqual([...m.keys()], [STAKE_VIEW_KEY], 'nothing else is stored');
    });
});

describe('copy', () => {
    test('the strings WP1 and WP2 use, as the spec writes them; no dashes, no exclamation marks', () => {
        assert.deepEqual(Object.keys(STAKE_COPY), ['SC-01', 'SC-03', 'SC-03b', 'SC-03c', 'SC-04', 'SC-05', 'SC-10', 'SC-11', 'SC-11b', 'SC-12', 'SC-13',
            'SC-14', 'SC-14b', 'SC-14c', 'SC-14d', 'SC-14e', 'SC-20', 'SC-21', 'SC-21b', 'SC-22', 'SC-23', 'SC-24a', 'SC-24b', 'SC-25',
            'SC-30', 'SC-30b', 'SC-30c', 'SC-30d', 'SC-31', 'SC-32', 'SC-33', 'SC-35', 'SC-36', 'SC-37', 'SC-38', 'SC-39',
            'SC-50', 'SC-51', 'SC-52', 'SC-53', 'SC-55a', 'SC-55b', 'SC-60', 'SC-60t', 'SC-78b', 'SC-80a', 'SC-80b', 'SC-80c', 'SC-80d', 'SC-80e', 'SC-95',
            'SC-100', 'SC-101', 'SC-102', 'SC-104', 'SC-105', 'SC-106', 'SC-107', 'SC-108', 'SC-109', 'SC-110', 'SC-111', 'SC-112', 'SC-113', 'SC-114', 'SC-115',
            'SC-122', 'SC-130', 'SC-131', 'SC-132', 'SC-133', 'SC-134', 'SC-140', 'SC-160', 'SC-161a', 'SC-161b', 'SC-163a', 'SC-163b', 'SC-163c',
            'SC-164a', 'SC-164b', 'SC-164c', 'SC-164d', 'SC-164e', 'SC-164f']);
        assert.equal(stakeCopy('SC-32'), 'Chosen by past return, highest first, from validators that are active now, have at least 7 eras of reward history, accept new stake, take 10% commission or less with no recent raise, were not penalised in the last 84 eras, rarely miss blocks, and paid at least three quarters of the typical return. One per operator identity.');
        assert.equal(stakeCopy('SC-115', { need: '101.05', min: '100', have: '101.02' }), 'To stake you need at least 101.05 PDEX free: the smallest stake of 100 PDEX, 1 PDEX that must stay in the account, and the network fee. This account has 101.02 PDEX free.');
        assert.deepEqual(['SC-164a', 'SC-164b', 'SC-164c', 'SC-164d', 'SC-164e', 'SC-164f'].map(k => STAKE_COPY[k]),
            ['not active this era', '100% commission', 'not accepting stake', 'no reward history', 'low return', 'penalised recently'], 'in the order of UNHEALTHY');
        assert.equal(stakeCopy('SC-05', { reserve: '0.2' }), 'Max leaves 1 PDEX that must stay in the account and 0.2 PDEX for network fees.');
        assert.equal(stakeCopy('SC-50'), 'Sign and stake');
        for (const t of Object.values(STAKE_COPY)) assert.ok(!/[\u2013\u2014!]/.test(t), t);
        assert.ok(Object.isFrozen(STAKE_COPY));
        assert.throws(() => stakeCopy('SC-999'));
    });
});

// A fake api that records what is built: one object per call, so the test can
// compare the built calls with the plan call for call and argument for argument.
function recordingApi({ batchAll = true, bondArgs = 2 } = {}) {
    const mk = (section, method) => Object.assign((...args) => ({ section, method, args }), { meta: { args: Array.from({ length: method === 'bond' ? bondArgs : 1 }) } });
    const utility = { forceBatch: mk('utility', 'forceBatch'), batch: mk('utility', 'batch') };
    if (batchAll) utility.batchAll = mk('utility', 'batchAll');
    return { tx: { utility, staking: { bond: mk('staking', 'bond'), bondExtra: mk('staking', 'bondExtra'), setPayee: mk('staking', 'setPayee'), nominate: mk('staking', 'nominate') } } };
}

describe('buildStakeTx: the plan, built call for call (M6), atomic when more than one (F1)', () => {
    test('two or more calls go in utility.batchAll, never forceBatch, and equal the plan', () => {
        const plan = planStakeCalls({ hasBond: true, amountPlanck: 3n * PDEX, currentTargets: [A], targets: [B, C], currentPayee: { kind: 'staked' }, payee: { kind: 'account', account: OTHER } });
        const tx = buildStakeTx(recordingApi(), plan, { stash: ME });
        assert.equal(`${tx.section}.${tx.method}`, 'utility.batchAll');
        assert.deepEqual(tx.args[0], [
            { section: 'staking', method: 'bondExtra', args: [(3n * PDEX).toString()] },
            { section: 'staking', method: 'setPayee', args: [{ Account: OTHER }] },
            { section: 'staking', method: 'nominate', args: [[B, C]] }
        ]);
    });
    test('first stake: batchAll of bond (value, Staked) and nominate; a legacy 3-argument bond gets the stash as controller', () => {
        const plan = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A, B] });
        const tx = buildStakeTx(recordingApi(), plan, { stash: ME });
        assert.equal(`${tx.section}.${tx.method}`, 'utility.batchAll');
        assert.deepEqual(tx.args[0], [{ section: 'staking', method: 'bond', args: [(150n * PDEX).toString(), 'Staked'] }, { section: 'staking', method: 'nominate', args: [[A, B]] }]);
        const legacy = buildStakeTx(recordingApi({ bondArgs: 3 }), plan, { stash: ME });
        assert.deepEqual(legacy.args[0][0].args, [ME, (150n * PDEX).toString(), 'Staked']);
    });
    test('one call is sent bare', () => {
        const tx = buildStakeTx(recordingApi(), planStakeCalls({ hasBond: true, amountPlanck: PDEX, currentTargets: [A], targets: [A] }), { stash: ME });
        assert.deepEqual(tx, { section: 'staking', method: 'bondExtra', args: [PDEX.toString()] });
    });
    test('a runtime without batchAll is refused, even when forceBatch exists; an empty plan is refused', () => {
        const plan = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A] });
        assert.throws(() => buildStakeTx(recordingApi({ batchAll: false }), plan, { stash: ME }), /no utility\.batchAll/);
        assert.throws(() => buildStakeTx(recordingApi(), { calls: [] }, { stash: ME }), /Nothing to sign yet/);
    });
    test('payeeArg: the RewardDestination shapes; an account destination needs the address', () => {
        assert.equal(payeeArg({ kind: 'staked' }), 'Staked');
        assert.equal(payeeArg('stash'), 'Stash');
        assert.deepEqual(payeeArg({ kind: 'account', account: OTHER }), { Account: OTHER });
        assert.throws(() => payeeArg({ kind: 'account' }));
        assert.throws(() => payeeArg({ kind: 'controller' }));
    });
});

describe('the plan encodes against the real mainnet 394 metadata', () => {
    let api;
    const decode = (tx) => api.registry.createType('Call', tx.method.toHex());
    const name = (c) => `${c.section}.${c.method}`;
    const ss58 = (x) => encodeAddress(decodeAddress(x.toString()), 88);
    before(async () => {
        const fx = loadFixture('metadata-mainnet-394.json');
        const mock = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion });
        api = await ApiPromise.create({ provider: mock.provider, noInitWarn: true });
    });
    after(async () => { await api?.disconnect(); });

    test('the runtime has what the plan needs, and the plan\'s wrapper is the atomic one: batchAll(calls), bond(value, payee), bondExtra(maxAdditional), nominate(targets), setPayee(payee)', () => {
        const args = (p, m) => api.tx[p][m].meta.args.map(a => `${a.name}:${a.type}`);
        assert.deepEqual(args('utility', 'batchAll'), ['calls:Vec<Call>']);
        assert.deepEqual(args('staking', 'bond'), ['value:Compact<u128>', 'payee:PalletStakingRewardDestination']);
        assert.deepEqual(args('staking', 'bondExtra'), ['maxAdditional:Compact<u128>']);
        assert.deepEqual(args('staking', 'nominate'), ['targets:Vec<MultiAddress>']);
        assert.deepEqual(args('staking', 'setPayee'), ['payee:PalletStakingRewardDestination']);
        // The pallet's own words for batch_all: atomic, everything rolls back if one call fails.
        const docs = api.tx.utility.batchAll.meta.docs.map(d => d.toString()).join(' ');
        assert.match(docs, /atomically execute them/);
        assert.match(docs, /The whole transaction will rollback and fail if any of the calls failed/);
        const wrapper = decode(buildStakeTx(api, planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A] }), { stash: ME }));
        assert.equal(name(wrapper), 'utility.batchAll');
        assert.equal(wrapper.toU8a()[0], decode(api.tx.utility.batchAll([])).toU8a()[0], 'the utility pallet index');
        assert.equal(wrapper.toU8a()[1], decode(api.tx.utility.batchAll([])).toU8a()[1], 'the batch_all call index');
    });
    test('first stake: utility.batchAll[staking.bond(150 PDEX, Staked), staking.nominate([A, B])]', () => {
        const plan = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A, B] });
        const c = decode(buildStakeTx(api, plan, { stash: ME }));
        assert.equal(name(c), 'utility.batchAll');
        const [bond, nom] = c.args[0];
        assert.equal(name(bond), 'staking.bond');
        assert.equal(bond.args[0].toBigInt(), 150n * PDEX);
        assert.ok(bond.args[1].isStaked);
        assert.equal(name(nom), 'staking.nominate');
        assert.deepEqual(nom.args[0].map(t => ss58(t)), [A, B]);
        assert.equal(c.args[0].length, plan.calls.length, 'call for call');
    });
    test('add more: a bare staking.bondExtra, no nominate', () => {
        const c = decode(buildStakeTx(api, planStakeCalls({ hasBond: true, amountPlanck: 5n * PDEX, currentTargets: [A, B], targets: [B, A] }), { stash: ME }));
        assert.equal(name(c), 'staking.bondExtra');
        assert.equal(c.args[0].toBigInt(), 5n * PDEX);
    });
    test('change validators, change rewards, and all three together', () => {
        const nom = decode(buildStakeTx(api, planStakeCalls({ hasBond: true, currentTargets: [A], targets: [C, D] }), { stash: ME }));
        assert.equal(name(nom), 'staking.nominate');
        assert.deepEqual(nom.args[0].map(t => ss58(t)), [C, D]);
        const pay = decode(buildStakeTx(api, planStakeCalls({ hasBond: true, currentTargets: [A], targets: [A], currentPayee: { kind: 'staked' }, payee: { kind: 'account', account: OTHER } }), { stash: ME }));
        assert.equal(name(pay), 'staking.setPayee');
        assert.ok(pay.args[0].isAccount);
        assert.equal(ss58(pay.args[0].asAccount), OTHER);
        const all = decode(buildStakeTx(api, planStakeCalls({ hasBond: true, amountPlanck: PDEX, currentTargets: [A], targets: [B], currentPayee: { kind: 'staked' }, payee: 'stash' }), { stash: ME }));
        assert.equal(name(all), 'utility.batchAll');
        assert.deepEqual(all.args[0].map(name), ['staking.bondExtra', 'staking.setPayee', 'staking.nominate']);
        assert.ok(all.args[0][1].args[0].isStash);
    });
    test('stakeCalls builds through the decorated extrinsics: each re-encodes to the same bytes', () => {
        const plan = planStakeCalls({ hasBond: false, amountPlanck: 150n * PDEX, targets: [A] });
        const built = stakeCalls(api, plan, { stash: ME });
        assert.equal(built.length, 2);
        for (const tx of built) assert.equal(api.registry.createType('Call', tx.method.toHex()).toHex(), tx.method.toHex());
    });
});
