// Validator setup in separate steps (cto-team/plans/2026-11-20-validator-setup-three-step-fallback.md):
// the pure order, plan, gate and state table (lib/validator-setup-steps.js) and
// the per-step builder (lib/validator-setup-chain.js buildCheckedSetupStepTx),
// against the REAL mainnet spec 394 codecs (test/fixtures). Every refusal is
// asserted with its exact message.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import * as S from '../lib/validator-setup.js';
import * as W from '../lib/validator-setup-steps.js';
import * as C from '../lib/validator-setup-chain.js';
import { buildTxModel, ACTION_KEYS, PENDING_TITLE } from '../lib/tx-status.js';
import { FEE_MARGIN, feeShortfall, feeShortText } from '../lib/fee-preflight.js';
import { EXPECTED_LAYOUT, parseSessionKeys } from '../lib/session-keys.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(71), OTHER = addr(73);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const OLDKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const blob = (k) => '0x' + EXPECTED_LAYOUT.map(l => k[l.name].slice(2)).join('');
const BLOB = blob(KEYS), OLDBLOB = blob(OLDKEYS);
const NAMES = EXPECTED_LAYOUT.map(l => l.name);
const MIN = 100n * PDEX;
const F = { setKeys: 3n * 10n ** 10n, bond: 2n * 10n ** 10n, bondExtra: 2n * 10n ** 10n, validate: 1n * 10n ** 10n };

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-mainnet-394.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

// ── chain state shapes (lib/validator-setup-chain.js readSetupState) ──
const unbonded = (o = {}) => ({ stash: STASH, bonded: false, controller: null, controllerOf: null, active: '0', validating: false, nextKeys: null, nominations: 0,
    balance: { free: String(1000n * PDEX), reserved: '0', frozen: '0' }, ed: String(PDEX), ...o });
const bondedState = (active, o = {}) => unbonded({ bonded: true, controller: STASH, active: String(active), balance: { free: String(1000n * PDEX), reserved: '0', frozen: String(active) }, ...o });
const LIMITS = { minValidatorBond: String(MIN), minCommission: 30_000_000, maxValidatorsCount: 250, counterForValidators: 217, specVersion: 394,
    layout: { ok: true, layout: EXPECTED_LAYOUT, bytes: 193, hexLength: 388 } };
const SPEC = { specVersion: 394, transactionVersion: 2 };

function reviewFor(state, { bond = 500n * PDEX, extra = 0n, keep = false, commission = 50_000_000, payee = { kind: 'staked', account: '' } } = {}) {
    const keys = keep ? null : parseSessionKeys(BLOB).keys;
    const input = { bond: state.bonded ? 0n : bond, extra, payee, keys, keysHex: keep ? '' : BLOB, commission };
    const p = S.planSetup(state, input);
    return { stash: STASH, steps: p.steps, keys, keysHex: input.keysHex, bond: input.bond, extra: input.extra, payee, commission, state, limits: LIMITS };
}
const callHex = (c) => (c.method && typeof c.method.toHex === 'function' ? c.method.toHex() : c.toHex());
function planOf(state, opts = {}, over = {}) {
    const review = reviewFor(state, opts);
    const calls = {}; for (const s of review.steps) calls[s.kind] = callHex(S.setupCalls({ tx: ex }, [s])[0]);
    const fees = {}; for (const s of review.steps) fees[s.kind] = F[s.kind];
    return W.stepwisePlan({ review, calls, fees, spec: SPEC, revision: 'r1', keyDeposit: 0n, keyNames: NAMES, ...over });
}
const fresh = (state, over = {}) => ({ state, limits: LIMITS, pauses: { safeModeUntil: null, paused: [] }, owners: { owners: {}, queued: [] }, fees: { ...F }, spec: SPEC, keyDeposit: 0n, ...over });

// ── 1. order ──
describe('stepwiseOrder: setKeys, then bond or bondExtra, then validate', () => {
    const k = (steps) => W.stepwiseOrder(steps).map(s => s.kind);
    test('fresh: setKeys, bond, validate', () => {
        assert.deepEqual(k(reviewFor(unbonded()).steps), ['setKeys', 'bond', 'validate']);
    });
    test('bonded and adding: setKeys, bondExtra, validate', () => {
        assert.deepEqual(k(reviewFor(bondedState(50n * PDEX), { extra: 60n * PDEX }).steps), ['setKeys', 'bondExtra', 'validate']);
    });
    test('keys kept: bond, validate', () => {
        assert.deepEqual(k(reviewFor(unbonded({ nextKeys: KEYS }), { keep: true }).steps), ['bond', 'validate']);
    });
    test('one step, and empty', () => {
        assert.deepEqual(k([{ kind: 'validate', commission: 1 }]), ['validate']);
        assert.deepEqual(k([]), []);
        assert.deepEqual(k(null), []);
    });
});

// ── 2. bare calls ──
describe('bare calls, no utility wrapper, hex equals the plan (394 codecs)', () => {
    test('each step is its own call; hex equals plan.callHex', () => {
        const plan = planOf(unbonded());
        const calls = S.setupCalls({ tx: ex }, plan.steps);
        assert.deepEqual(calls.map(c => `${c.section}.${c.method}`), ['session.setKeys', 'staking.bond', 'staking.validate']);
        calls.forEach((c, i) => assert.equal(callHex(c), plan.callHex[i]));
        const extra = planOf(bondedState(50n * PDEX), { extra: 60n * PDEX });
        assert.deepEqual(S.setupCalls({ tx: ex }, extra.steps).map(c => `${c.section}.${c.method}`), ['session.setKeys', 'staking.bondExtra', 'staking.validate']);
        for (const c of calls) assert.notEqual(c.section, 'utility');
    });
    test('the plan is frozen', () => {
        const plan = planOf(unbonded());
        assert.ok(Object.isFrozen(plan));
        assert.ok(Object.isFrozen(plan.steps));
        assert.ok(Object.isFrozen(plan.callHex));
    });
});

// ── 3. fees ──
describe('fees: single-call fees feed maxBondable; unknown uses FEE_MARGIN; key deposit is added', () => {
    test('total fee is the sum of the step fees; unknown counts as FEE_MARGIN', () => {
        assert.equal(W.stepwiseTotalFee(planOf(unbonded())), F.setKeys + F.bond + F.validate);
        const plan = planOf(unbonded(), {}, { fees: { setKeys: null, bond: F.bond, validate: F.validate } });
        assert.equal(W.stepwiseTotalFee(plan), FEE_MARGIN + F.bond + F.validate);
    });
    test('SW-51 when the reviewed amount no longer fits the three fees (and the key deposit)', () => {
        const plan = planOf(unbonded(), { bond: 999n * PDEX - (F.setKeys + F.bond + F.validate) + 1n });
        const g = W.stepwiseGate(fresh(unbonded()), plan);
        const max = S.maxBondable({ free: 1000n * PDEX, ed: PDEX, fee: F.setKeys + F.bond + F.validate });
        assert.equal(g.blockId, 'SW-51');
        assert.equal(g.block, W.SW.feesTooHigh(F.setKeys + F.bond + F.validate, max));
        assert.equal(g.block, 'Signing in separate steps costs about 0.06 PDEX in network fees, so the most you can bond is 997.94 PDEX. Lower the amount or add PDEX to this stash.');
        const ok = planOf(unbonded(), { bond: max });
        assert.equal(W.stepwiseGate(fresh(unbonded()), ok).block, null);
        // a key deposit above zero is added to the fee side (G12)
        const dep = W.stepwiseGate(fresh(unbonded(), { keyDeposit: 5n * PDEX }), ok);
        assert.equal(dep.blockId, 'SW-51');
        assert.match(dep.block, /costs about 5\.06 PDEX in network fees/);
    });
    test('an unknown fee alone never blocks the fee check of a step', () => {
        const plan = planOf(bondedState(150n * PDEX, { nextKeys: KEYS }), { keep: true });
        const st = bondedState(150n * PDEX, { nextKeys: KEYS, balance: { free: String(150n * PDEX + PDEX), reserved: '0', frozen: String(150n * PDEX) } });
        assert.equal(W.stepwiseGate(fresh(st, { fees: { validate: null } }), plan).block, null);
    });
});

// ── 4. the gate, rule by rule ──
describe('stepwiseGate: rules 1 to 9, first failing rule is the block', () => {
    test('all pass: fresh account, next is setKeys at step 1 of 3', () => {
        const plan = planOf(unbonded());
        const g = W.stepwiseGate(fresh(unbonded()), plan);
        assert.equal(g.block, null);
        assert.equal(g.next.kind, 'setKeys');
        assert.equal(g.k, 1);
        assert.deepEqual(g.remaining.map(s => s.kind), ['setKeys', 'bond', 'validate']);
        assert.equal(g.done, false);
    });
    test('rule 1: runtime changed (SW-52)', () => {
        const plan = planOf(unbonded());
        const g = W.stepwiseGate(fresh(unbonded(), { spec: { specVersion: 395, transactionVersion: 2 } }), plan);
        assert.equal(g.blockId, 'SW-52');
        assert.equal(g.block, 'The network was upgraded while you were between steps (spec 394, now 395). Nothing was signed. Steps already confirmed stay on chain. Go back to the review so the remaining steps are checked against the new rules.');
        assert.equal(W.stepwiseGate(fresh(unbonded(), { spec: { specVersion: 394, transactionVersion: 3 } }), plan).blockId, 'SW-52');
    });
    test('rule 2: legacy controller (existing text)', () => {
        const plan = planOf(unbonded());
        const st = unbonded({ bonded: true, controller: OTHER, active: String(200n * PDEX) });
        const g = W.stepwiseGate(fresh(st), plan);
        assert.equal(g.block, S.controllerRefusal(st));
    });
    test('rule 3: keys on chain neither planned nor kept (SW-53)', () => {
        const plan = planOf(unbonded());
        const st = unbonded({ nextKeys: OLDKEYS });
        const g = W.stepwiseGate(fresh(st), plan);
        assert.equal(g.blockId, 'SW-53');
        assert.equal(g.block, 'The session keys registered to this stash are not the ones you reviewed. Nothing was signed. Go back to Session keys and choose which keys to use.');
        // kept keys purged after the review
        const kept = planOf(unbonded({ nextKeys: KEYS }), { keep: true });
        assert.equal(W.stepwiseGate(fresh(unbonded()), kept).blockId, 'SW-53');
        // replacing: the old keys still on chain before setKeys is fine
        const repl = planOf(unbonded({ nextKeys: OLDKEYS }));
        assert.equal(W.stepwiseGate(fresh(unbonded({ nextKeys: OLDKEYS })), repl).block, null);
    });
    test('rule 3: a step that is not in the plan (SW-55)', () => {
        // the plan kept keys and was made for a bonded stash; the chain now shows it unbonded: a bond step appears
        const plan = planOf(bondedState(150n * PDEX, { nextKeys: KEYS }), { keep: true });
        const g = W.stepwiseGate(fresh(unbonded({ nextKeys: KEYS })), plan);
        assert.equal(g.blockId, 'SW-55');
        assert.equal(g.block, 'This step no longer matches what you reviewed, so nothing was signed. Go back to the review.');
    });
    test('rule 5: everything on chain is done only with the Validators entry and the keys byte for byte', () => {
        const plan = planOf(unbonded());
        const g = W.stepwiseGate(fresh(bondedState(500n * PDEX, { nextKeys: KEYS, validating: true })), plan);
        assert.equal(g.done, true);
        assert.equal(g.block, null);
        assert.equal(g.next, null);
    });
    test('rule 6: setKeys: KeyOwner conflict (existing text); fee not payable (SW-50)', () => {
        const plan = planOf(unbonded());
        const g = W.stepwiseGate(fresh(unbonded(), { owners: { owners: [null, null, null, null, OTHER, null], queued: [], nextKeys: null } }), plan);
        assert.equal(g.block, `Key 5 (mixnet) is already registered to ${OTHER}. The chain will reject these keys. If you copied a keystore from another node, stop: running two nodes with the same keys is slashed.`);
        const poor = unbonded({ balance: { free: String(PDEX + 10n ** 10n), reserved: '0', frozen: '0' } });
        const g2 = W.stepwiseGate(fresh(poor), planOf(unbonded(), { bond: 1n }));
        const s = feeShortfall({ fee: F.setKeys, free: PDEX + 10n ** 10n, ed: PDEX });
        assert.equal(g2.blockId, 'SW-50');
        assert.equal(g2.block, `Step 1 cannot be paid for yet. ${feeShortText(s)} Then press Check again.`);
        assert.equal(g2.retry, true);
    });
    test('rule 6: the key layout changed (existing text)', () => {
        const plan = planOf(unbonded());
        const g = W.stepwiseGate(fresh(unbonded(), { limits: { ...LIMITS, layout: { ok: false, layout: null, hexLength: null } } }), plan);
        assert.equal(g.block, 'The session key format changed since you reviewed this. Generate new keys on your node and paste them again.');
    });
    test('rule 7: bond: balance fell below the reviewed amount (existing clamp text); below the live minimum (existing text)', () => {
        const plan = planOf(unbonded(), { bond: 900n * PDEX });
        const st = unbonded({ nextKeys: KEYS, balance: { free: String(800n * PDEX), reserved: '0', frozen: '0' } });
        const g = W.stepwiseGate(fresh(st), plan);
        const max = S.maxBondable({ free: 800n * PDEX, ed: PDEX, fee: F.bond + F.validate });
        assert.equal(g.next.kind, 'bond');
        assert.equal(g.block, 'Your balance changed since you reviewed this. ' + S.clampText(max));
        const p2 = planOf(unbonded(), { bond: 150n * PDEX });
        const g2 = W.stepwiseGate(fresh(unbonded({ nextKeys: KEYS }), { limits: { ...LIMITS, minValidatorBond: String(200n * PDEX) } }), p2);
        assert.equal(g2.block, 'The minimum bond changed since you reviewed this: it is now 200 PDEX. Go back to Bond and enter a new amount.');
    });
    test('rule 8: validate: commission and candidate limit (existing texts); keys missing (SW-53); post-bond fee (SW-50 + SW-50a)', () => {
        const plan = planOf(unbonded());
        const st = bondedState(500n * PDEX, { nextKeys: KEYS });
        assert.equal(W.stepwiseGate(fresh(st), plan).next.kind, 'validate');
        assert.equal(W.stepwiseGate(fresh(st, { limits: { ...LIMITS, minCommission: 60_000_000 } }), plan).block,
            'The minimum commission changed since you reviewed this: it is now 6%. Go back to Commission and enter a new rate.');
        assert.equal(W.stepwiseGate(fresh(st, { limits: { ...LIMITS, counterForValidators: 250 } }), plan).block,
            'The chain has reached its limit of 250 validator candidates. Nobody can start validating until one leaves or governance raises the limit.');
        const kept = planOf(bondedState(500n * PDEX, { nextKeys: KEYS }), { keep: true });
        assert.equal(W.stepwiseGate(fresh(bondedState(500n * PDEX)), kept).blockId, 'SW-53');
    });
    test('rule 9: safe mode and a paused bare call (existing texts; no Utility.batch_all)', () => {
        const plan = planOf(unbonded());
        const g = W.stepwiseGate(fresh(unbonded(), { pauses: { safeModeUntil: 9000, paused: [] } }), plan);
        assert.equal(g.block, S.pauseProblems({ safeModeUntil: 9000 })[0]);
        assert.equal(g.retry, true);
        const g2 = W.stepwiseGate(fresh(unbonded(), { pauses: { safeModeUntil: null, paused: ['Session.set_keys'] } }), plan);
        assert.equal(g2.block, S.pauseProblems({ paused: ['Session.set_keys'] })[0]);
        assert.equal(W.stepwiseGate(fresh(unbonded(), { pauses: { safeModeUntil: null, paused: ['Utility.batch_all', 'Staking.bond'] } }), plan).block, null, 'only the next bare call counts');
        assert.deepEqual(W.stepPausableCalls({ kind: 'validate' }), [['Staking', 'validate']]);
    });
});

// ── 5. the silent clamp ──
describe('the bond clamp: after a fresh bond the ledger is compared with the review (G8)', () => {
    const plan = () => planOf(unbonded(), { bond: 500n * PDEX });
    test('active below reviewed and above the minimum: notice SW-48, validate still offered', () => {
        const g = W.stepwiseGate(fresh(bondedState(400n * PDEX, { nextKeys: KEYS })), plan(), { justDone: 'bond' });
        assert.equal(g.block, null);
        assert.equal(g.noticeId, 'SW-48');
        assert.equal(g.notice, 'Bonded 400 PDEX of the 500 PDEX you reviewed. The balance changed before the block. 400 PDEX is above the minimum of 100 PDEX, so you can sign the last step now or add the rest first.');
        assert.equal(g.next.kind, 'validate');
        assert.equal(g.addBond, 100n * PDEX);
    });
    test('below the minimum: block SW-49 with the difference', () => {
        const g = W.stepwiseGate(fresh(bondedState(80n * PDEX, { nextKeys: KEYS })), plan(), { justDone: 'bond' });
        assert.equal(g.blockId, 'SW-49');
        assert.equal(g.block, 'Bonded 80 PDEX of the 500 PDEX you reviewed. The balance changed before the block. Validating needs at least 100 PDEX bonded, so the last step would fail. Add at least 20 PDEX to the bond first.');
        assert.equal(g.addBond, 20n * PDEX);
    });
    test('equal: no notice', () => {
        const g = W.stepwiseGate(fresh(bondedState(500n * PDEX, { nextKeys: KEYS })), plan(), { justDone: 'bond' });
        assert.equal(g.notice, null);
        assert.equal(g.block, null);
    });
    test('bondExtra uses the event amount; a slash between review and inclusion raises no false notice', () => {
        const st0 = bondedState(150n * PDEX, { nextKeys: KEYS });
        const p = planOf(st0, { extra: 60n * PDEX, keep: true });
        // slashed by 10 after the review, extra fully bonded: ledger 200, event 60
        const g = W.stepwiseGate(fresh(bondedState(200n * PDEX, { nextKeys: KEYS })), p, { bondedEvent: 60n * PDEX, justDone: 'bondExtra' });
        assert.equal(g.notice, null);
        assert.equal(g.next.kind, 'validate');
        // event short
        const g2 = W.stepwiseGate(fresh(bondedState(190n * PDEX, { nextKeys: KEYS })), p, { bondedEvent: 40n * PDEX, justDone: 'bondExtra' });
        assert.equal(g2.noticeId, 'SW-48');
        assert.match(g2.notice, /^Bonded 40 PDEX of the 60 PDEX you reviewed\./);
    });
    test('a confirmed bondExtra is never offered twice: event in hand; ledger grew; neither (S7)', () => {
        const st0 = bondedState(150n * PDEX, { nextKeys: KEYS });
        const p = planOf(st0, { extra: 60n * PDEX, keep: true });
        assert.deepEqual(p.steps.map(s => s.kind), ['bondExtra', 'validate']);
        // before anything was sent: bondExtra is next
        assert.equal(W.stepwiseGate(fresh(st0), p).next.kind, 'bondExtra');
        // event in hand
        assert.equal(W.stepwiseGate(fresh(st0), p, { bondedEvent: 60n * PDEX, extraSent: true }).next.kind, 'validate');
        // ledger grew by the extra
        assert.equal(W.stepwiseGate(fresh(bondedState(210n * PDEX, { nextKeys: KEYS })), p, { extraSent: true }).next.kind, 'validate');
        // neither: not confirmed, no signature offered
        const g = W.stepwiseGate(fresh(st0), p, { extraSent: true });
        assert.equal(g.unconfirmed, true);
        assert.equal(g.next, null);
        assert.equal(g.block, null);
    });
});

// ── 6. post-bond fee ──
describe('the fee of validate is checked on the post-bond balance (G1)', () => {
    test('free left over the bond below the fee after a clamped bond: SW-50 with SW-50a; funded and re-checked passes', () => {
        const plan = planOf(unbonded(), { bond: 500n * PDEX });
        const left = 400n * PDEX + 5n * 10n ** 9n;
        const poor = bondedState(400n * PDEX, { nextKeys: KEYS, balance: { free: String(left), reserved: '0', frozen: String(400n * PDEX) } });
        const g = W.stepwiseGate(fresh(poor), plan, { justDone: 'bond' });
        const s = feeShortfall({ fee: F.validate, free: left, frozen: 400n * PDEX, ed: PDEX });
        assert.equal(g.blockId, 'SW-50');
        assert.equal(g.block, `Step 3 cannot be paid for yet. ${feeShortText(s)} Then press Check again. Your bond of 400 PDEX is not affected and stays bonded meanwhile.`);
        const funded = bondedState(400n * PDEX, { nextKeys: KEYS, balance: { free: String(402n * PDEX), reserved: '0', frozen: String(400n * PDEX) } });
        const g2 = W.stepwiseGate(fresh(funded), plan, {});
        assert.equal(g2.block, null);
        assert.equal(g2.next.kind, 'validate');
    });
});

// ── 7. transitions ──
describe('the state table (section 3.3): every row', () => {
    const IDLE = ['S0', 'S4', 'S5', 'S6', 'S8', 'S9'];
    const rows = [
        ['review', 'open', 'S0'], ['review', 'openBlocked', 'S8'],
        ...['S0', 'S4', 'S5', 'S9'].flatMap(s => [[s, 'sign', 'S1'], [s, 'refused', 'S8']]),
        ['S1', 'refused', 'S8'],
        ['S1', 'sent', 'S2'], ['S1', 'notSigned', 'S5'], ['S1', 'walletChanged', 'remount'],
        ['S2', 'included', 'S3'], ['S2', 'failedOnChain', 'S6'], ['S2', 'noVerdict', 'S7'], ['S2', 'verified', 'S3'],
        ['S3', 'gateNext', 'S4'], ['S3', 'gateShort', 'S9'], ['S3', 'gateNotShown', 'S8'], ['S3', 'gateBlock', 'S8'], ['S3', 'gateDone', 'S10'], ['S3', 'gateUnconfirmed', 'S7'],
        ['S6', 'checkAgain', 'S3'], ['S7', 'checkAgain', 'S3'], ['S8', 'checkAgain', 'S3'],
        ...IDLE.map(s => [s, 'back', 'review']),
        ['S8', 'addBond', 'bond'], ['S9', 'addBond', 'bond'],
        ...['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'].map(s => [s, 'walletChanged', 'remount'])
    ];
    for (const [from, ev, to] of rows) {
        test(`${from} --${ev}--> ${to}`, () => assert.equal(W.stepwiseNext(from, ev), to));
    }
    test('anything else is not a transition (no Back while signing, no Sign while sent)', () => {
        for (const [from, ev] of [['S1', 'back'], ['S2', 'back'], ['S3', 'back'], ['S7', 'back'], ['S1', 'sign'], ['S2', 'sign'], ['S3', 'sign'], ['S7', 'sign'], ['S10', 'sign'], ['S6', 'sign']]) {
            assert.equal(W.stepwiseNext(from, ev), null, `${from} ${ev}`);
        }
    });
    test('S6 offers Sign only through the gate: S6 + gateNext is S4-like (sign allowed)', () => {
        assert.equal(W.stepwiseNext('S6', 'gateNext'), 'S6');
    });
});

describe('outcomes are classified from the tracker (before or after broadcast)', () => {
    test('before broadcast: a guard or fee refusal is S8; cancel, BadProof, a wallet error, a silent wallet are S5', () => {
        assert.equal(W.stepOutcome('error', { key: 'preflight' }, { sent: false }), 'refused');
        for (const key of ['wallet.Cancelled', 'pool.BadProof', 'error', undefined]) assert.equal(W.stepOutcome('error', { key }, { sent: false }), 'notSigned', String(key));
        assert.equal(W.stepOutcome('stage', { stage: 'waiting' }, { sent: false }), 'notSigned');
    });
    test('after broadcast: a decoded chain error is S6; a pool drop, a dropped link or a missing event is S7', () => {
        assert.equal(W.stepOutcome('error', { key: 'staking.InsufficientBond' }, { sent: true }), 'failedOnChain');
        assert.equal(W.stepOutcome('error', { key: 'session.NoAssociatedValidatorId' }, { sent: true }), 'failedOnChain');
        for (const key of ['pool.Dropped', 'pool.Invalid', 'net.ConnectionLost', 'validator.setupUnreported', 'error', 'unknown']) assert.equal(W.stepOutcome('error', { key }, { sent: true }), 'noVerdict', key);
        for (const stage of ['waiting', 'processed', 'unverified']) assert.equal(W.stepOutcome('stage', { stage }, { sent: true }), 'noVerdict', stage);
        assert.equal(W.stepOutcome('stage', { stage: 'broadcast' }, { sent: false }), 'sent');
        assert.equal(W.stepOutcome('stage', { stage: 'finalized' }, { sent: true }), null);
        assert.equal(W.stepOutcome('stage', { stage: 'failed' }, { sent: true }), null, 'failures arrive through onError');
    });
});

// ── 8. buildCheckedSetupStepTx ──
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function fakeApi(o = {}) {
    const st = { minBond: MIN, minComm: 30_000_000, bonded: false, active: 0n, validating: false, nextKeys: null, owners: {}, free: 1000n * PDEX, frozen: 0n, spec: 394, txv: 2, paused: [], keyDeposit: 0n, ...o };
    const validators = async () => ({});
    validators.size = async (a) => num(String(a) === STASH && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(F[m] != null ? F[m] : F.validate) }); return c; } }) });
    return {
        st, registry, tx,
        get runtimeVersion() { return { specVersion: num(st.spec), transactionVersion: num(st.txv) }; },
        consts: { balances: { existentialDeposit: num(PDEX) }, session: { keyDeposit: num(st.keyDeposit) }, staking: { bondingDuration: num(28) } },
        query: {
            system: { account: async () => ({ nonce: num(0), data: { free: num(st.free), reserved: num(0), frozen: num(st.frozen) } }) },
            staking: {
                minValidatorBond: async () => num(st.minBond), minCommission: async () => num(st.minComm),
                maxValidatorsCount: async () => opt(num(250)), counterForValidators: async () => num(217),
                bonded: async (a) => opt(String(a) === STASH && st.bonded ? STASH : null),
                ledger: async (c) => opt(st.bonded && String(c) === STASH ? { stash: STASH, total: num(st.active), active: num(st.active) } : null),
                validators, nominators: async () => opt(null)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === STASH && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => opt(st.owners[String(key)] || null)
            },
            txPause: { pausedCalls: async (c) => (st.paused.includes(c.join('.')) ? opt(num(1)) : opt(null)) }
        }
    };
}
describe('buildCheckedSetupStepTx: fresh reads, the gate, the kind, the hex', () => {
    async function planFor(api, opts = {}) {
        const review = reviewFor(await C.readSetupState(api, STASH), opts);
        return C.buildStepwisePlan(api, review, { revision: 'r1', keyNames: NAMES });
    }
    test('passes and returns the bare call, whose hex is the plan\'s', async () => {
        const api = fakeApi();
        const plan = await planFor(api);
        assert.deepEqual(plan.fees, [F.setKeys, F.bond, F.validate]);
        assert.deepEqual(plan.spec, { specVersion: 394, transactionVersion: 2 });
        const tx = await C.buildCheckedSetupStepTx(api, plan, 'setKeys');
        assert.equal(`${tx.section}.${tx.method}`, 'session.setKeys');
        assert.equal(callHex(tx), plan.callHex[0]);
    });
    test('refuses SW-52 (runtime), SW-53 (keys), SW-54 (already on chain), SW-55 (call differs), pauses, limits', async () => {
        const api = fakeApi();
        const plan = await planFor(api);
        api.st.spec = 395;
        await assert.rejects(C.buildCheckedSetupStepTx(api, plan, 'setKeys'), { message: W.SW.runtimeChanged(394, 395) });
        api.st.spec = 394;
        api.st.nextKeys = OLDKEYS;
        await assert.rejects(C.buildCheckedSetupStepTx(api, plan, 'setKeys'), { message: W.SW.keysDiffer });
        api.st.nextKeys = KEYS;
        await assert.rejects(C.buildCheckedSetupStepTx(api, plan, 'setKeys'), { message: 'The chain already shows this step, so nothing was signed.' });
        const forged = Object.freeze({ ...plan, callHex: Object.freeze(['0x00', plan.callHex[1], plan.callHex[2]]) });
        api.st.nextKeys = null;
        await assert.rejects(C.buildCheckedSetupStepTx(api, forged, 'setKeys'), { message: W.SW.callDiffers });
        api.st.paused = ['Session.set_keys'];
        await assert.rejects(C.buildCheckedSetupStepTx(api, plan, 'setKeys'), /The network has paused Session\.set_keys/);
        api.st.paused = [];
        api.st.nextKeys = KEYS; api.st.minComm = 60_000_000;
        await assert.rejects(C.buildCheckedSetupStepTx(api, plan, 'bond'), /The minimum commission changed since you reviewed this/);
    });
    test('setKeys on an account that is not bonded is allowed (A1: ValidatorIdOf = ConvertInto on 394)', async () => {
        const api = fakeApi();
        const plan = await planFor(api);
        assert.equal(plan.steps[0].kind, 'setKeys');
        assert.equal(api.st.bonded, false);
        await C.buildCheckedSetupStepTx(api, plan, 'setKeys');
    });
});

// ── 9. per-step action ──
describe('per-step submit: expectEvents, bondRequested, action key and params', () => {
    test('expectEvents per step; setKeys has none (NextKeys re-read is the proof)', () => {
        assert.deepEqual(W.stepExpectEvents('bond'), ['staking.Bonded']);
        assert.deepEqual(W.stepExpectEvents('bondExtra'), ['staking.Bonded']);
        assert.deepEqual(W.stepExpectEvents('validate'), ['staking.ValidatorPrefsSet']);
        assert.deepEqual(W.stepExpectEvents('setKeys'), []);
    });
    test('the action: validator.setupStep with n, of, last, summary, stash, expectEvents, bondRequested on bond only', () => {
        const plan = planOf(unbonded(), { bond: 500n * PDEX });
        const a = W.stepAction(plan, 'bond');
        assert.equal(a.key, 'validator.setupStep');
        assert.deepEqual(a.params, { n: 2, of: 3, last: false, summary: 'Bonded.', stash: STASH, expectEvents: ['staking.Bonded'], bondRequested: String(500n * PDEX) });
        assert.equal(W.stepAction(plan, 'setKeys').params.bondRequested, undefined);
        assert.equal(W.stepAction(plan, 'validate').params.last, true);
        const extra = planOf(bondedState(150n * PDEX), { extra: 60n * PDEX });
        assert.equal(W.stepAction(extra, 'bondExtra').params.bondRequested, String(60n * PDEX));
    });
    test('setKeys success comes only from NextKeys equality (verify)', async () => {
        const api = fakeApi();
        const review = reviewFor(await C.readSetupState(api, STASH));
        const plan = await C.buildStepwisePlan(api, review, { revision: 'r1', keyNames: NAMES });
        assert.equal(await C.verifySetupStep(api, plan, 'setKeys'), 'pending');
        api.st.nextKeys = OLDKEYS;
        assert.equal(await C.verifySetupStep(api, plan, 'setKeys'), 'pending');
        api.st.nextKeys = KEYS;
        assert.equal(await C.verifySetupStep(api, plan, 'setKeys'), 'applied');
    });
});

// ── 10. status card copy ──
describe('tx-status copy for validator.setupStep (SW-70 to SW-73)', () => {
    const ev = (section, method, data = []) => ({ event: { section, method, data } });
    const IN1 = { type: 'InBlock', asInBlock: '0xb1' };
    const act = (params) => ({ id: 'v1', key: 'validator.setupStep', params });
    test('pending title names the step', () => {
        assert.ok(ACTION_KEYS.includes('validator.setupStep'));
        assert.ok(PENDING_TITLE['validator.setupStep']);
        assert.equal(buildTxModel(act({ n: 2, of: 3 }), 'signing').title, 'Setting up your validator, step 2 of 3');
    });
    test('not last (SW-71), last (SW-72), short bond (SW-73)', () => {
        const ok = [ev('staking', 'Bonded', [STASH, String(500n * PDEX)]), ev('system', 'ExtrinsicSuccess')];
        const m = buildTxModel(act({ n: 2, of: 3, last: false, summary: 'Bonded.', expectEvents: ['staking.Bonded'] }), IN1, ok, null, { registry, blockNumber: 7 });
        assert.equal(m.title, 'Setup step 2 of 3 included');
        assert.equal(m.body, 'Bonded. 1 more to sign on the setup page.');
        const last = buildTxModel(act({ n: 3, of: 3, last: true, summary: 'Asking to validate.', expectEvents: ['staking.ValidatorPrefsSet'] }), IN1, [ev('staking', 'ValidatorPrefsSet', [STASH, {}]), ev('system', 'ExtrinsicSuccess')], null, { registry, blockNumber: 8 });
        assert.equal(last.title, 'Last setup step included');
        assert.equal(last.body, 'Asking to validate. The explorer now checks the chain for your keys and your validator entry.');
        const short = buildTxModel(act({ n: 2, of: 3, last: false, summary: 'Bonded.', expectEvents: ['staking.Bonded'], bondRequested: String(600n * PDEX) }), IN1, ok, null, { registry, blockNumber: 7 });
        assert.equal(short.title, 'Setup step 2 of 3 included with a smaller bond');
        assert.match(short.body, /^Bonded 500 PDEX of the 600 PDEX you asked for\. The balance changed before the block\./);
    });
});

describe('style', () => {
    test('no en or em dashes, no exclamation marks in the strings', () => {
        for (const v of Object.values(W.SW)) {
            const t = typeof v === 'function' ? v(1, 2, 3, 4) : String(v);
            assert.ok(!/[–—!]/.test(t), t);
        }
    });
});
