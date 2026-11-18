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

import { layoutFromRegistry, checkLayout } from './session-keys.js';
import { readKeyOwners, keysToMap } from './validator-status-chain.js';
import { buildSetupTx, signTimeProblems, setupApplied } from './validator-setup.js';

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

// buildTx for submitSignedTx (design 4.6): right before the wallet is asked,
// read the limits, the stash state, the balance, the batch fee and every
// KeyOwner again, and refuse in plain words when anything moved since review.
export async function buildCheckedSetupTx(api, review) {
    const setKeys = (review.steps || []).find(s => s.kind === 'setKeys');
    const [limits, state, owners] = await Promise.all([
        readSetupLimits(api),
        readSetupState(api, review.stash),
        setKeys && review.keys ? readKeyOwners(api, review.keys, review.stash) : null
    ]);
    const tx = buildSetupTx(api, review.steps);
    const fee = await feeOf(tx, review.stash);
    const problems = signTimeProblems({ limits, state, owners, balance: state.balance, ed: state.ed, fee }, review);
    if (problems.length) throw new Error(problems.join(' '));
    return tx;
}

// 'applied' only when the chain shows every planned step; anything else,
// including a read that fails, is 'pending'.
export async function verifySetup(api, review) {
    try {
        const after = await readSetupState(api, review.stash);
        return setupApplied(after, review).applied ? 'applied' : 'pending';
    } catch (e) {
        return 'pending';
    }
}

export async function readSetupApplied(api, review) {
    const after = await readSetupState(api, review.stash);
    return setupApplied(after, review);
}
