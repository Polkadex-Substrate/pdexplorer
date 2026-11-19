// The chain reads behind the manage panel (Sprint 4), over the browser's own
// RPC connection: the live limits, the stash's staking state, the fee of one
// call, the sign-time re-reads and the verify used when the status
// subscription goes quiet. Also the validator rule for the existing Unstake
// modal (buildCheckedUnbondTx). The api is passed in; tested in
// test/validator-manage.test.js against a hand-built api and the spec 393 codecs.
//
// Storage and constants read (spec 393; polkadot-sdk polkadot-stable2512-3):
//   Staking.MinCommission, MinValidatorBond, MinNominatorBond (ValueQuery,
//   set by governance), CurrentEra; consts staking.maxUnlockingChunks (32 on
//   393), bondingDuration (28), sessionsPerEra (6). Staking.Ledger(controller):
//   active, total, unlocking [{ value, era }]. Staking.Validators(stash):
//   { commission, blocked }. Staking.Payee(stash): RewardDestination.
//   Proxy.Proxies(stash): ([{ delegate, proxyType, delay }], deposit); the delay
//   decides whether a proxy can act without an announcement (Sprint 5).
//   The rest through lib/validator-setup-chain.js readSetupState.

import { readSetupState, readPausesFor } from './validator-setup-chain.js';
import { readKeyOwners } from './validator-status-chain.js';
import { layoutFromRegistry, checkLayout } from './session-keys.js';
import { pauseProblems } from './validator-setup.js';
import { KIND_CALLS, buildManageCall, manageSignTimeProblems, manageApplied, payeeOf, unbondProblem, maxUnbondWarning } from './validator-manage.js';

const fn = (obj, name) => (obj && typeof obj[name] === 'function' ? obj[name] : null);
const soft = (p) => Promise.resolve(p).then((v) => v, () => null);
const some = (o) => (o && typeof o.isSome === 'boolean' ? (o.isSome ? o.unwrap() : null) : (o == null ? null : o));
const num = (x) => { if (x == null) return null; const v = Number(typeof x.toNumber === 'function' ? x.toNumber() : x.toString()); return Number.isFinite(v) ? v : null; };
const bigStr = (x) => { if (x == null) return null; try { return (typeof x.toBigInt === 'function' ? x.toBigInt() : BigInt(x.toString())).toString(); } catch (e) { return null; } };
const bool = (x) => (x && typeof x.isTrue === 'boolean' ? x.isTrue : !!(x && typeof x.valueOf === 'function' ? x.valueOf() : x));

export async function readManageLimits(api) {
    const st = api.query.staking, c = (api.consts && api.consts.staking) || {};
    const [minBond, minComm, minNom] = await Promise.all([
        soft(st.minValidatorBond()), soft(st.minCommission()), fn(st, 'minNominatorBond') ? soft(st.minNominatorBond()) : null
    ]);
    return {
        minValidatorBond: bigStr(minBond), minCommission: num(minComm), minNominatorBond: bigStr(minNom),
        maxUnlockingChunks: num(c.maxUnlockingChunks), bondingDuration: num(c.bondingDuration), sessionsPerEra: num(c.sessionsPerEra),
        specVersion: num(api.runtimeVersion && api.runtimeVersion.specVersion),
        layout: checkLayout(layoutFromRegistry(api.registry))
    };
}

// Throws when the chain cannot be read: the panel says so instead of guessing.
export async function readManageState(api, stash) {
    const base = await readSetupState(api, stash);
    const q = api.query, st = q.staking;
    const [ledger, prefs, payee, proxies, cur] = await Promise.all([
        base.controller ? st.ledger(base.controller) : null,
        base.validating ? st.validators(base.stash) : null,
        fn(st, 'payee') ? soft(st.payee(base.stash)) : null,
        q.proxy && fn(q.proxy, 'proxies') ? soft(q.proxy.proxies(base.stash)) : null,
        fn(st, 'currentEra') ? soft(st.currentEra()) : null
    ]);
    const l = some(ledger);
    const defs = proxies && proxies[0] ? Array.from(proxies[0]) : [];
    return {
        ...base,
        total: (l && bigStr(l.total)) || base.active,
        unlocking: l && l.unlocking ? Array.from(l.unlocking).map(u => ({ value: bigStr(u.value) || '0', era: num(u.era) })) : [],
        prefs: prefs ? { commission: num(prefs.commission) || 0, blocked: bool(prefs.blocked) } : null,
        payee: payeeOf(payee),
        proxies: defs.map(p => ({ delegate: String(p.delegate), type: String(p.proxyType), delay: num(p.delay) || 0 })),
        nominating: Number(base.nominations) > 0,
        currentEra: num(some(cur))
    };
}

const feeOf = async (tx, who) => {
    if (!tx || typeof tx.paymentInfo !== 'function') return null;
    const info = await soft(tx.paymentInfo(who));
    const f = info && info.partialFee != null ? bigStr(info.partialFee) : null;
    return f == null ? null : BigInt(f);
};

// The fee of this one call, or null when it cannot be estimated.
export async function estimateManageFee(api, signer, step) {
    try { return await feeOf(buildManageCall(api, step), signer); } catch (e) { return null; }
}

// buildTx for submitSignedTx (design 4.6): right before the wallet is asked,
// read the limits, the stash state, the pauses, every KeyOwner (rotation) and
// the fee (bond more) again, and refuse in plain words when anything moved.
export async function buildCheckedManageTx(api, review) {
    const s = review.step;
    const [limits, state, owners, pauses] = await Promise.all([
        readManageLimits(api),
        readManageState(api, review.stash),
        s.kind === 'keys' && review.keys ? readKeyOwners(api, review.keys, review.stash) : null,
        readPausesFor(api, [KIND_CALLS[s.kind]])
    ]);
    const paused = pauseProblems(pauses);
    if (paused.length) throw new Error(paused.join(' '));
    const tx = buildManageCall(api, s);
    const fee = s.kind === 'bondExtra' ? await feeOf(tx, review.signer || review.stash) : null;
    const problems = manageSignTimeProblems({ limits, state, owners, fee }, review);
    if (problems.length) throw new Error(problems.join(' '));
    return tx;
}

// 'applied' only when the chain shows the change; a read that fails is 'pending'.
export async function verifyManage(api, review) {
    try {
        const after = await readManageState(api, review.stash);
        return manageApplied(after, review).applied ? 'applied' : 'pending';
    } catch (e) {
        return 'pending';
    }
}

export async function readManageApplied(api, review) {
    const after = await readManageState(api, review.stash);
    return { after, ...manageApplied(after, review) };
}

// The Unstake modal's Max unbonds the whole bond, and unbond of value >= total
// chills the stash first: a validator stops validating. The warning text, or
// null when the stash does not validate or the read fails (fail open: the
// chain still does the right thing, the warning is only extra).
export async function readMaxUnbondWarning(api, stash) {
    try {
        const st = api.query.staking, size = st.validators && fn(st.validators, 'size');
        if (!size) return null;
        const [sz, era] = await Promise.all([soft(st.validators.size(String(stash))), fn(st, 'activeEra') ? soft(st.activeEra()) : null]);
        if (!((num(sz) || 0) > 0)) return null;
        const e = some(era), index = e ? num(e.index) : null;
        return maxUnbondWarning({ activeEra: index, currentEra: index });
    } catch (err) {
        return null;
    }
}

// The existing Unstake modal's partial unbond (script.js submitUnstakeTx):
// the do_unbond rule read from the chain at signing, so a validator is told
// to stop validating first instead of the chain refusing with InsufficientBond.
export async function buildCheckedUnbondTx(api, { signer, value }) {
    const st = api.query.staking, c = (api.consts && api.consts.staking) || {};
    const l = some(await st.ledger(String(signer)));
    if (!l) throw new Error('This account has nothing bonded to unbond. Connect the account that controls the stash.');
    const stash = String(l.stash);
    const size = st.validators && fn(st.validators, 'size');
    const [sz, noms, minVal, minNom, cur, pauses] = await Promise.all([
        size ? soft(st.validators.size(stash)) : null,
        fn(st, 'nominators') ? soft(st.nominators(stash)) : null,
        soft(st.minValidatorBond()), fn(st, 'minNominatorBond') ? soft(st.minNominatorBond()) : null,
        fn(st, 'currentEra') ? soft(st.currentEra()) : null,
        readPausesFor(api, [['Staking', 'unbond']])
    ]);
    const paused = pauseProblems(pauses);
    if (paused.length) throw new Error(paused.join(' '));
    const validating = (num(sz) || 0) > 0, nominating = some(noms) != null;
    if ((validating && minVal == null) || (nominating && minNom == null)) {
        throw new Error('The explorer could not read the minimum bond from the chain, so it cannot check this unbond. Try again.');
    }
    const problem = unbondProblem(value, {
        active: bigStr(l.active), total: bigStr(l.total),
        unlocking: l.unlocking ? Array.from(l.unlocking).map(u => ({ value: bigStr(u.value), era: num(u.era) })) : [],
        validating, nominating, minValidatorBond: bigStr(minVal), minNominatorBond: bigStr(minNom),
        ed: bigStr(api.consts && api.consts.balances && api.consts.balances.existentialDeposit) || '0',
        maxUnlockingChunks: num(c.maxUnlockingChunks), currentEra: num(some(cur))
    });
    if (problem) throw new Error(problem);
    return api.tx.staking.unbond(String(value));
}
