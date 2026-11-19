// Validator onboarding, Sprint 5: the chain side of acting for a stash through
// a proxy or a multisig. Rules in lib/validator-delegate.js; the manage panel
// (lib/validator-manage-view.js) and the multisig review (lib/multisig-view.js
// callGuard) call these. The api is passed in; tested in
// test/validator-delegate.test.js against a hand-built api and the spec 393 codecs.
//
// Storage read (spec 393; polkadot-sdk polkadot-stable2512-3):
//   Proxy.Proxies(real): (BoundedVec<ProxyDefinition { delegate, proxy_type, delay }>, deposit)
//   Multisig.Multisigs(multisig, call_hash): Multisig { when, deposit, depositor, approvals }
//   SafeMode.EnteredUntil, TxPause.PausedCalls((pallet, call)) through
//   lib/validator-setup-chain.js readPausesFor, and the Sprint 3 and 4 reads.

import { readPausesFor, readSetupLimits, readSetupState } from './validator-setup-chain.js';
import { readManageLimits, readManageState, buildCheckedManageTx } from './validator-manage-chain.js';
import { readKeyOwners } from './validator-status-chain.js';
import { parseSessionKeys } from './session-keys.js';
import { pauseProblems, pausableCalls, signTimeProblems } from './validator-setup.js';
import { KIND_CALLS, manageSignTimeProblems, unbondProblem } from './validator-manage.js';
import { sameAccount, pendingMultisig, decodeMultisigCall, recoverMultisigCall } from './multisig.js';
import { buildProxyCall, proxyTypesOf, proxyTypesProblem, stepsFromCall, pendingValidatorOps } from './validator-delegate.js';

const num = (x) => { if (x == null) return null; const v = Number(typeof x.toNumber === 'function' ? x.toNumber() : x.toString()); return Number.isFinite(v) ? v : null; };

export async function readProxyDefs(api, real) {
    const q = api.query && api.query.proxy;
    if (!q || typeof q.proxies !== 'function') return [];
    const r = await q.proxies(String(real));
    const defs = r && r[0] ? Array.from(r[0]) : [];
    return defs.map(p => ({ delegate: String(p.delegate), type: String(p.proxyType), delay: num(p.delay) || 0 }));
}

// buildTx for submitSignedTx when the connected account is a proxy of the
// stash. review: the manage review (lib/validator-manage-view.js) plus
// proxy { real, type, delegate }. First the Sprint 4 sign-time checks on the
// inner call (limits, stash state, keys, SafeMode and TxPause for the inner
// call), then TxPause for proxy.proxy, the proxy types and the proxy
// definition read again; then the wrap. The signer, and so the fee payer, is
// the proxy (expectedWallet in the view).
export async function buildCheckedProxyTx(api, review) {
    const p = review.proxy;
    const inner = await buildCheckedManageTx(api, review);
    const paused = pauseProblems(await readPausesFor(api, [['Proxy', 'proxy']]));
    if (paused.length) throw new Error(paused.join(' '));
    const typesProblem = proxyTypesProblem(proxyTypesOf(api));
    if (typesProblem) throw new Error(typesProblem);
    const defs = await readProxyDefs(api, p.real);
    const d = defs.find(x => sameAccount(x.delegate, p.delegate) && x.type === p.type);
    if (!d) throw new Error(`The proxy for this stash changed since you reviewed this: this account is no longer a ${p.type} proxy of it. Nothing was signed. Start again.`);
    if (d.delay > 0) throw new Error(`The proxy for this stash changed since you reviewed this: it now has an announcement delay of ${d.delay} blocks, and the explorer does not make announced proxy calls. Nothing was signed.`);
    return buildProxyCall(api, p.real, p.type, inner);
}

// The final approval of a multisig stash (lib/multisig-view.js callGuard):
// the Sprint 3 and 4 refusals, run again on the decoded call with the chain as
// it is now. Returns plain-language problems; [] for a call that is not a
// validator operation.
//
// It is wired into every multisig final approval, also on the live site with
// the validate flag off, so (Fable round 1):
//   - the validator rules apply only when the stash is a validator now
//     (Staking.Validators has it), or when the call is a validator setup (a
//     setup batch, or staking.validate on a stash that is not validating, which
//     gets the Sprint 3 rules). Anything else, a nominator multisig's
//     bondExtra, chill or unbond, is left to the chain exactly as before;
//   - the signatory pays the multisig fee, so the stash keeps no fee and no
//     working reserve in the bond checks (fee 0, reserve 0);
//   - a read that fails passes the call for a stash that is not a validator
//     (the chain decides); for a validator it refuses with a try-again message.
const READ_AGAIN = 'The explorer could not read this stash\'s staking state again before the last approval, so it could not check the validator rules. Nothing was signed. Try again.';
async function isValidatorNow(api, stash) {
    try {
        const v = api.query.staking.validators;
        if (!v || typeof v.size !== 'function') return null;
        const n = num(await v.size(String(stash)));
        return n == null ? null : n > 0;
    } catch (e) {
        return null;
    }
}
// The note the review shows when the guard cannot tell whether the stash
// validates (the read failed): the guard stays open, the chain decides.
export const VALIDATOR_CHECK_NOTE = 'Could not check validator rules; the chain will decide.';
export async function validatorCallNote(api, call, stash) {
    if (!stepsFromCall(call)) return '';
    return (await isValidatorNow(api, stash)) == null ? VALIDATOR_CHECK_NOTE : '';
}
export async function validatorCallGuard(api, call, stash) {
    const x = stepsFromCall(call);
    if (!x) return [];
    const validator = await isValidatorNow(api, stash);
    if (validator == null) return [];
    const setupValidate = !validator && x.manage && x.manage.kind === 'commission';
    if (!validator && !x.setup && !setupValidate) return [];
    // Only a batch with staking.validate or session.setKeys is a validator setup (round 2).
    if (!validator && x.setup && !x.setup.steps.some(s => s.kind === 'validate' || s.kind === 'setKeys')) return [];
    try {
        return await guardRules(api, x, stash, { validator, setupValidate });
    } catch (e) {
        return validator ? [READ_AGAIN] : [];
    }
}
const NO_FEES = { fee: 0n, reserve: 0n };
async function guardRules(api, x, stash, { validator, setupValidate }) {
    const keysOf = (hex, limits) => {
        const lay = limits.layout;
        const r = lay && lay.ok && lay.layout ? parseSessionKeys(hex, { layout: lay.layout }) : null;
        return r && r.ok ? r.keys : null;
    };
    if (validator && x.unbond) {
        const paused = pauseProblems(await readPausesFor(api, [['Staking', 'unbond']]));
        if (paused.length) return paused;
        const [limits, state] = await Promise.all([readManageLimits(api), readManageState(api, stash)]);
        const p = unbondProblem(x.unbond.value, { active: state.active, total: state.total, unlocking: state.unlocking, validating: state.validating,
            nominating: state.nominating, minValidatorBond: limits.minValidatorBond, minNominatorBond: limits.minNominatorBond, ed: state.ed,
            maxUnlockingChunks: limits.maxUnlockingChunks, currentEra: state.currentEra });
        return p ? [p] : [];
    }
    if (validator && x.manage) {
        const paused = pauseProblems(await readPausesFor(api, [KIND_CALLS[x.manage.kind]]));
        if (paused.length) return paused;
        const [limits, state] = await Promise.all([readManageLimits(api), readManageState(api, stash)]);
        const keys = x.manage.kind === 'keys' ? keysOf(x.manage.keysHex, limits) : null;
        const owners = keys ? await readKeyOwners(api, keys, stash) : null;
        const step = x.manage.kind === 'payee' ? { ...x.manage, payee: state.payee } : x.manage;
        return manageSignTimeProblems({ limits, state, owners, ...NO_FEES }, { kind: step.kind, stash, step, state, limits });
    }
    // A validator setup: the batch, or staking.validate on a stash not validating.
    const setup = x.setup || { steps: [{ kind: 'validate', commission: x.manage.commission }], bond: 0n, extra: 0n, commission: x.manage.commission };
    const calls = setupValidate ? [['Staking', 'validate']] : pausableCalls(setup.steps);
    const paused = pauseProblems(await readPausesFor(api, calls));
    if (paused.length) return paused;
    const [limits, state] = await Promise.all([readSetupLimits(api), readSetupState(api, stash)]);
    // A legacy controller of a different stash: not this account's setup, the chain decides (round 2).
    if (!validator && state.controllerOf) return [];
    if (!validator && (limits.minValidatorBond == null || limits.minCommission == null)) return [];
    const setKeys = setup.steps.find(s => s.kind === 'setKeys');
    const keys = setKeys ? keysOf(setKeys.keysHex, limits) : null;
    const owners = keys ? await readKeyOwners(api, keys, stash) : null;
    return signTimeProblems({ limits, state, owners, balance: state.balance, ed: state.ed, ...NO_FEES },
        { stash, steps: setup.steps, state, bond: setup.bond, extra: setup.extra, commission: setup.commission });
}

// The open multisig operations of a multisig stash, with the call recovered
// from the first approval's block (lib/multisig.js recoverMultisigCall) or
// this browser's saved copy, decoded with the current runtime and checked
// against its hash. Returns lib/validator-delegate.js pendingValidatorOps.
export async function readPendingValidatorOps(api, multisig, { recover = recoverMultisigCall, saved = () => '', isSame = sameAccount } = {}) {
    const q = api.query && api.query.multisig;
    if (!q || !q.multisigs || typeof q.multisigs.entries !== 'function') return { ops: [], others: 0 };
    const entries = await q.multisigs.entries(multisig.address);
    const rows = [];
    for (const [key, value] of entries) {
        const hash = key.args[1].toHex();
        const pending = pendingMultisig(value);
        if (!pending) continue;
        let hex = '';
        try { hex = saved(hash) || ''; } catch (e) { hex = ''; }
        if (!hex) { try { hex = await recover(api, pending, hash); } catch (e) { hex = ''; } }
        let call = null;
        if (hex) { try { call = decodeMultisigCall(api, hex, hash).call; } catch (e) { call = null; } }
        rows.push({ hash, pending, call });
    }
    return pendingValidatorOps(rows, multisig, { isSame });
}

// The wallet dashboard card: Staking.Validators (size) and Session.NextKeys
// for the account; null when either cannot be read (the card is then left out).
export async function readWalletValidator(api, address) {
    try {
        const q = api.query;
        const [sz, keys] = await Promise.all([q.staking.validators.size(String(address)), q.session.nextKeys(String(address))]);
        return { validating: (num(sz) || 0) > 0, hasKeys: !!(keys && keys.isSome), address: String(address) };
    } catch (e) {
        return null;
    }
}
