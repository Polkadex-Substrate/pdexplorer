// The chain reads behind the setup wizard (Sprint 3), over the browser's own
// RPC connection: the live limits, the stash's staking state (to resume from
// it), the fee of the batch, the sign-time re-reads and the verify used when
// the status subscription goes quiet. The api is passed in; tested in
// test/validator-setup.test.js against a hand-built api and the spec 393 codecs.
//
// Storage read (spec 393; polkadot-sdk polkadot-stable2512-3):
//   Staking.MinValidatorBond, MinCommission (ValueQuery), MaxValidatorsCount
//   (OptionQuery), CounterForValidators: governance values, read every time.
//   Staking.Bonded(stash) -> controller; Staking.Ledger(controller) -> active;
//   Staking.Ledger(account) whose stash is another account: this account is a
//   controller, not a stash. Staking.Validators(stash).size() > 0: asking to
//   validate. Staking.Nominators(stash).targets. Session.NextKeys(stash).
//   System.Account(stash).data: free, reserved, frozen.
//   SafeMode.EnteredUntil (Option<BlockNumber>) and TxPause.PausedCalls
//   ((pallet name, call name) -> ()): read at signing when the pallets exist.

import { layoutFromRegistry, checkLayout } from './session-keys.js';
import { readKeyOwners, keysToMap } from './validator-status-chain.js';
import { buildSetupTx, buildSetupStepCall, signTimeProblems, setupApplied, pausableCalls, pauseProblems } from './validator-setup.js';
import { stepwisePlan, stepwiseGate, stepPausableCalls, SW } from './validator-setup-steps.js';

const fn = (obj, name) => (obj && typeof obj[name] === 'function' ? obj[name] : null);
const soft = (p) => Promise.resolve(p).then((v) => v, () => null);
const some = (o) => (o && typeof o.isSome === 'boolean' ? (o.isSome ? o.unwrap() : null) : (o == null ? null : o));
const num = (x) => { if (x == null) return null; const v = Number(typeof x.toNumber === 'function' ? x.toNumber() : x.toString()); return Number.isFinite(v) ? v : null; };
const bigStr = (x) => { if (x == null) return null; try { return (typeof x.toBigInt === 'function' ? x.toBigInt() : BigInt(x.toString())).toString(); } catch (e) { return null; } };

export async function readSetupLimits(api) {
    const st = api.query.staking;
    const [minBond, minComm, maxCount, counter] = await Promise.all([
        soft(st.minValidatorBond()), soft(st.minCommission()),
        fn(st, 'maxValidatorsCount') ? soft(st.maxValidatorsCount()) : null,
        fn(st, 'counterForValidators') ? soft(st.counterForValidators()) : null
    ]);
    return {
        minValidatorBond: bigStr(minBond), minCommission: num(minComm),
        maxValidatorsCount: num(some(maxCount)), counterForValidators: num(counter),
        specVersion: num(api.runtimeVersion && api.runtimeVersion.specVersion),
        layout: checkLayout(layoutFromRegistry(api.registry))
    };
}

// Throws when the chain cannot be read: the wizard says so instead of guessing.
export async function readSetupState(api, stash) {
    const q = api.query, st = q.staking;
    const a = String(stash);
    const size = st.validators && fn(st.validators, 'size');
    const [bonded, ownLedger, sz, next, noms, account] = await Promise.all([
        st.bonded(a), st.ledger(a), size ? st.validators.size(a) : null,
        q.session.nextKeys(a), fn(st, 'nominators') ? soft(st.nominators(a)) : null, q.system.account(a)
    ]);
    const controller = some(bonded) ? String(some(bonded)) : null;
    const own = some(ownLedger);
    const ledger = controller ? (controller === a ? own : some(await st.ledger(controller))) : null;
    const ownStash = own && own.stash != null ? String(own.stash) : null;
    const d = (account && account.data) || {};
    const frozen = d.frozen != null ? bigStr(d.frozen) : String(BigInt(bigStr(d.miscFrozen) || 0) > BigInt(bigStr(d.feeFrozen) || 0) ? bigStr(d.miscFrozen) : (bigStr(d.feeFrozen) || '0'));
    const n = some(noms);
    return {
        stash: a, bonded: !!controller, controller,
        controllerOf: ownStash && ownStash !== a ? ownStash : null,
        active: (ledger && bigStr(ledger.active)) || '0',
        validating: (num(sz) || 0) > 0,
        nextKeys: keysToMap(some(next)),
        nominations: n && n.targets ? Array.from(n.targets).length : 0,
        balance: { free: bigStr(d.free) || '0', reserved: bigStr(d.reserved) || '0', frozen: frozen || '0' },
        ed: bigStr(api.consts && api.consts.balances && api.consts.balances.existentialDeposit) || '0'
    };
}

const feeOf = async (tx, stash) => {
    if (!tx || typeof tx.paymentInfo !== 'function') return null;
    const info = await soft(tx.paymentInfo(stash));
    const f = info && info.partialFee != null ? bigStr(info.partialFee) : null;
    return f == null ? null : BigInt(f);
};

// The fee of this batch, or null when it cannot be estimated.
export async function estimateSetupFee(api, stash, steps) {
    try { return await feeOf(buildSetupTx(api, steps), stash); } catch (e) { return null; }
}

// Safe mode entered, and which of this batch's calls are paused. A pallet the
// runtime does not have, or a read that fails, counts as not paused.
export async function readPauses(api, steps) {
    return readPausesFor(api, pausableCalls(steps));
}
// calls: [[pallet name, call name], ...] as metadata names them (also used by
// the manage panel, lib/validator-manage-chain.js).
export async function readPausesFor(api, calls) {
    const q = api.query || {};
    const until = q.safeMode && fn(q.safeMode, 'enteredUntil') ? some(await soft(q.safeMode.enteredUntil())) : null;
    const paused = [];
    if (q.txPause && fn(q.txPause, 'pausedCalls')) {
        const hits = await Promise.all(calls.map(c => soft(q.txPause.pausedCalls(c))));
        hits.forEach((h, i) => { if (h && (typeof h.isSome === 'boolean' ? h.isSome : true)) paused.push(calls[i].join('.')); });
    }
    return { safeModeUntil: num(until), paused };
}

// buildTx for submitSignedTx (design 4.6): right before the wallet is asked,
// read the limits, the stash state, the balance, the batch fee and every
// KeyOwner again, and refuse in plain words when anything moved since review.
export async function buildCheckedSetupTx(api, review) {
    const setKeys = (review.steps || []).find(s => s.kind === 'setKeys');
    const [limits, state, owners, pauses] = await Promise.all([
        readSetupLimits(api),
        readSetupState(api, review.stash),
        setKeys && review.keys ? readKeyOwners(api, review.keys, review.stash) : null,
        readPauses(api, review.steps)
    ]);
    const paused = pauseProblems(pauses);
    if (paused.length) throw new Error(paused.join(' '));
    const tx = buildSetupTx(api, review.steps);
    const base = await feeOf(tx, review.stash);
    // Finding 5: Session.KeyDeposit (0 on spec 394) leaves free like the fee.
    const fee = base != null && setKeys ? base + keyDepositOf(api) : base;
    const problems = signTimeProblems({ limits, state, owners, balance: state.balance, ed: state.ed, fee }, review);
    if (problems.length) throw new Error(problems.join(' '));
    return tx;
}

// 'applied' only when the chain shows every planned step; anything else,
// including a read that fails, is 'pending'. A bondExtra step has no evidence
// from "already bonded" alone: it needs the Bonded event's amount
// (opts.bondedEvent) or a ledger that grew by the extra since the review.
export async function verifySetup(api, review, opts = {}) {
    try {
        const after = await readSetupState(api, review.stash);
        if (!setupApplied(after, review, opts).applied) return 'pending';
        for (const s of review.steps || []) {
            if (s.kind !== 'bondExtra') continue;
            const event = opts.bondedEvent != null ? BigInt(opts.bondedEvent) : 0n;
            const before = review.state && review.state.active != null ? BigInt(review.state.active) : null;
            const grew = before != null && BigInt(after.active || 0) >= before + BigInt(s.value != null ? s.value : 0);
            if (!(event > 0n) && !grew) return 'pending';
        }
        return 'applied';
    } catch (e) {
        return 'pending';
    }
}

// opts.bondedEvent: the staking.Bonded amount from the inclusion, when the view has it.
export async function readSetupApplied(api, review, opts = {}) {
    const after = await readSetupState(api, review.stash);
    return setupApplied(after, review, opts);
}

// ── setup in separate steps (lib/validator-setup-steps.js) ──
// Session.KeyDeposit: 0 on spec 394 (`type KeyDeposit = ();`). A runtime
// without the constant has no key deposit.
export function keyDepositOf(api) {
    const c = api && api.consts && api.consts.session && api.consts.session.keyDeposit;
    const v = c == null ? '0' : bigStr(c);
    return BigInt(v == null ? '0' : v);
}
const specOf = (api) => {
    const v = (api && api.runtimeVersion) || {};
    return { specVersion: num(v.specVersion), transactionVersion: num(v.transactionVersion) };
};
// The hex of a call, from a submittable (its method) or a bare decorated call.
export const callHexOf = (tx) => (tx && tx.method && typeof tx.method.toHex === 'function' ? tx.method.toHex() : tx.toHex());

// The frozen plan (F5): every step's bare call hex and fee, the runtime
// version and the key deposit, when the stepper opens.
export async function buildStepwisePlan(api, review, { revision = null, keyNames = [] } = {}) {
    const calls = {}, fees = {};
    await Promise.all((review.steps || []).map(async (s) => {
        const tx = buildSetupStepCall(api, s);
        calls[s.kind] = callHexOf(tx);
        fees[s.kind] = await feeOf(tx, review.stash);
    }));
    return stepwisePlan({ review, calls, fees, spec: specOf(api), revision, keyDeposit: keyDepositOf(api), keyNames });
}

// One read of everything the gate needs (section 3.1).
export async function readStepwiseFresh(api, plan) {
    const setKeys = plan.steps.find(s => s.kind === 'setKeys');
    const calls = [].concat(...plan.steps.map(stepPausableCalls));
    const [state, limits, pauses, owners, fees] = await Promise.all([
        readSetupState(api, plan.stash), readSetupLimits(api), readPausesFor(api, calls),
        setKeys && plan.keys ? readKeyOwners(api, plan.keys, plan.stash) : null,
        Promise.all(plan.steps.map(s => feeOf(buildSetupStepCall(api, s), plan.stash).catch(() => null)))
    ]);
    const byKind = {};
    plan.steps.forEach((s, i) => { byKind[s.kind] = fees[i]; });
    return { state, limits, pauses, owners, fees: byKind, spec: specOf(api), keyDeposit: keyDepositOf(api) };
}

// buildTx for one step (section 3.4): fresh reads and the gate again; the kind
// signed must be the gate's next; the built call must equal the plan's hex.
export async function buildCheckedSetupStepTx(api, plan, kind, ctx = {}) {
    const fresh = await readStepwiseFresh(api, plan);
    const g = stepwiseGate(fresh, plan, ctx);
    if (g.block) throw new Error(g.block);
    if (g.done || !g.next || g.next.kind !== kind) throw new Error(SW.alreadyOnChain);
    const i = plan.steps.findIndex(s => s.kind === kind);
    const tx = buildSetupStepCall(api, plan.steps[i]);
    if (callHexOf(tx) !== plan.callHex[i]) throw new Error(SW.callDiffers);
    return tx;
}

// verify for one step: the chain shows that step (verifySetup on a one-step review).
export function verifySetupStep(api, plan, kind, opts = {}) {
    const step = plan.steps.find(s => s.kind === kind);
    return verifySetup(api, { stash: plan.stash, steps: [step], state: plan.state, bond: plan.bond, extra: plan.extra }, opts);
}
