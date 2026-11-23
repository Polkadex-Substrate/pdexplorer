// Validator onboarding, Sprint 5 (money path): acting for a validator stash
// through a proxy or a multisig. Design sections 1.10, 4.1, 4.6, 5.4 and the
// Sprint 5 plan in cto-team/plans/2026-11-17-validator-onboarding-design.md;
// CEO decision D2 (2026-11-17): the Staking proxy limit is accepted, so key
// rotation and first-time setup need the stash itself (or its multisig).
// Pure: lib/validator-delegate-chain.js reads the chain, the manage panel
// (lib/validator-manage-view.js) renders. Tested in
// test/validator-delegate.test.js against the spec 393 metadata.
//
// ── the proxy filter, copied as data ──
// Source: Polkadex-Substrate/polkadex-node, branch mainnet,
// runtimes/mainnet/src/lib.rs lines 803-862 (spec_version 394 on the branch
// as read on 2026-11-18; the explorer's fixture is 393, and the ProxyType
// enum and the filter arms used here are the same on both):
//
//   pub enum ProxyType { Any = 0, NonTransfer = 1, Governance = 2, Staking = 3 }
//   ProxyType::Any => true,
//   ProxyType::NonTransfer => !matches!(
//       c,
//       RuntimeCall::Balances(..)
//           | RuntimeCall::Indices(pallet_indices::Call::transfer { .. })
//           | RuntimeCall::Assets(..)
//           | RuntimeCall::PoolAssets(..)
//           | RuntimeCall::AssetConversion(..)
//           | RuntimeCall::Recovery(..)
//           | RuntimeCall::HyperFungibleToken(..)
//           | RuntimeCall::Ismp(pallet_ismp::Call::fund_message { .. })
//   ),
//   ProxyType::Governance => matches!(
//       c,
//       RuntimeCall::Council(..)
//           | RuntimeCall::TechnicalCommittee(..)
//           | RuntimeCall::Elections(..)
//           | RuntimeCall::Treasury(..)
//   ),
//   ProxyType::Staking => matches!(c, RuntimeCall::Staking(..)),
//
// The design (section 1.10, read on 393) listed the NonTransfer deny list
// without HyperFungibleToken and Ismp::fund_message; neither touches a
// validator call, so the capability table for the manage actions is the same.
//
// pallet-proxy (polkadot-sdk polkadot-stable2512-3, substrate/frame/proxy/src/lib.rs):
//   proxy: let def = Self::find_proxy(&real, &who, force_proxy_type)?;
//          ensure!(def.delay.is_zero(), Error::<T>::Unannounced);
//          Self::do_proxy(def, real, *call);  Ok(())
//   do_proxy: origin.add_filter(.. def.proxy_type.filter(c) ..);
//          let e = call.dispatch(origin);
//          Self::deposit_event(Event::ProxyExecuted { result: e.map(|_| ()).map_err(|e| e.error) });
// So the outer extrinsic succeeds even when the proxied call fails or is
// filtered (system.CallFiltered): success is read from ProxyExecuted.result
// (lib/tx-status.js evaluateEvents), never from the outer result. A filtered
// utility.batch is refused as a whole (the batch call itself is not Staking).
// A delay above zero needs announce, then proxy_announced after the delay: the
// explorer explains it and does not attempt either.

import { perbillToPercent } from './validator-status.js';
import { formatPlanck } from './call-args-format.js';
import { KIND_CALLS, signerFor } from './validator-manage.js';

export const PROXY_SOURCE = Object.freeze({
    repo: 'Polkadex-Substrate/polkadex-node', branch: 'mainnet', file: 'runtimes/mainnet/src/lib.rs', lines: '803-862', specVersion: 394
});

// Metadata pallet names; calls in snake_case as the runtime names them.
export const PROXY_FILTER = Object.freeze({
    Any: Object.freeze({ all: true }),
    NonTransfer: Object.freeze({
        denyPallets: Object.freeze(['Balances', 'Assets', 'PoolAssets', 'AssetConversion', 'Recovery', 'HyperFungibleToken']),
        denyCalls: Object.freeze([['Indices', 'transfer'], ['Ismp', 'fund_message']])
    }),
    Governance: Object.freeze({ onlyPallets: Object.freeze(['Council', 'TechnicalCommittee', 'Elections', 'Treasury']) }),
    Staking: Object.freeze({ onlyPallets: Object.freeze(['Staking']) })
});
export const PROXY_TYPES = Object.freeze(Object.keys(PROXY_FILTER));

export function filterPallets() {
    const out = new Set();
    for (const f of Object.values(PROXY_FILTER)) {
        for (const p of f.denyPallets || []) out.add(p);
        for (const p of f.onlyPallets || []) out.add(p);
        for (const [p] of f.denyCalls || []) out.add(p);
    }
    return [...out];
}

export function proxyAllows(type, pallet, call) {
    const f = PROXY_FILTER[String(type)];
    if (!f) return false;
    if (f.all) return true;
    if (f.onlyPallets) return f.onlyPallets.includes(pallet);
    if ((f.denyPallets || []).includes(pallet)) return false;
    return !(f.denyCalls || []).some(([p, c]) => p === pallet && c === call);
}

// The ProxyType variants of the live runtime, from the type of
// proxy.add_proxy's proxy_type argument; null when it cannot be read.
export function proxyTypesOf(api) {
    try {
        const arg = api.tx.proxy.addProxy.meta.args[1];
        const keys = api.registry.createType(arg.type.toString()).defKeys;
        return Array.isArray(keys) && keys.length ? keys.slice() : null;
    } catch (e) {
        return null;
    }
}
export function proxyTypesProblem(types) {
    if (!Array.isArray(types) || !types.length) return 'The explorer could not read the proxy types of this runtime, so acting through a proxy is switched off here. Connect the stash.';
    const same = types.length === PROXY_TYPES.length && PROXY_TYPES.every((t, i) => types[i] === t);
    return same ? null : `The chain's proxy types changed (now: ${types.join(', ')}). The explorer has not been updated for them, so acting through a proxy is switched off here. Connect the stash.`;
}

export const KEY_ROTATION_NEEDS_STASH = 'Key rotation needs the stash on this runtime.';
const CONNECT = 'Connect the stash to make this change.';
// Narrowest first: a Staking proxy is used for a staking call even when the
// same account is also an Any proxy.
const PREFERENCE = ['Staking', 'Governance', 'NonTransfer', 'Any'];

// kind: a manage action (lib/validator-manage.js). state: readManageState,
// proxies [{ delegate, type, delay }] of the stash. Returns
// { ok: true, type, real, delay: 0 } or { ok: false, reason }.
export function proxyAction(kind, { state, me, isSame = (a, b) => a === b, typesProblem = null } = {}) {
    if (typesProblem) return { ok: false, reason: typesProblem };
    const pc = KIND_CALLS[kind];
    if (!pc || !state) return { ok: false, reason: CONNECT };
    const real = signerFor(kind, state);
    if (!isSame(real, state.stash)) {
        return { ok: false, reason: `This stash is controlled by ${state.controller} (an older setup), so a proxy of the stash cannot make this change. Connect that account.` };
    }
    const defs = (state.proxies || []).filter(p => isSame(p.delegate, me));
    if (!defs.length) return { ok: false, reason: CONNECT };
    const allowing = defs.filter(p => proxyAllows(p.type, pc[0], snake(pc[1])));
    if (!allowing.length) {
        const types = [...new Set(defs.map(p => p.type))].join(' and ');
        if (kind === 'keys') return { ok: false, reason: `${KEY_ROTATION_NEEDS_STASH} A ${types} proxy cannot register session keys. Connect the stash.` };
        return { ok: false, reason: `A ${types} proxy cannot make this change on this runtime. ${CONNECT}` };
    }
    const ready = allowing.filter(p => Number(p.delay || 0) === 0)
        .sort((a, b) => PREFERENCE.indexOf(a.type) - PREFERENCE.indexOf(b.type));
    if (!ready.length) {
        const n = Math.min(...allowing.map(p => Number(p.delay)));
        return { ok: false, reason: `This proxy has an announcement delay of ${n} blocks: each call must be announced first and made after the delay. The explorer does not make announced proxy calls. Connect the stash to make this change.` };
    }
    return { ok: true, type: ready[0].type, real, delay: 0 };
}
const snake = (s) => String(s).replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

// proxy.proxy(real, Some(type), call): one single call, never a batch (a
// Staking proxy cannot batch on this runtime, design 1.10).
export function buildProxyCall(api, real, type, inner) {
    if (!PROXY_TYPES.includes(String(type))) throw new Error(`Unknown proxy type ${type}.`);
    if (!inner || inner.section === 'utility') throw new Error('A proxy sends one single call here, never a batch.');
    return api.tx.proxy.proxy(String(real), String(type), inner);
}

// ── decoded calls (pending multisig operations, the final-approval guard) ──
const big = (x) => { try { return x == null || x === '' ? 0n : BigInt(String(x)); } catch (e) { return 0n; } };
const pdex = (v) => formatPlanck(big(v)) ?? '0';
const argNum = (a) => { try { return a && typeof a.toBigInt === 'function' ? a.toBigInt() : big(a && a.toString()); } catch (e) { return 0n; } };
const isCall = (c) => !!(c && typeof c.section === 'string' && typeof c.method === 'string' && c.args);
const VALIDATOR_CALLS = new Set(['staking.validate', 'staking.chill', 'staking.bondExtra', 'staking.setPayee', 'staking.rebond', 'staking.unbond', 'staking.withdrawUnbonded', 'staking.bond', 'session.setKeys']);
const callKey = (c) => `${c.section}.${c.method}`;

function prefsOf(c) {
    const p = c.args[0];
    const commission = Number(argNum(p.commission));
    const blocked = !!(p.blocked && (p.blocked.isTrue === true || (typeof p.blocked.valueOf === 'function' && p.blocked.valueOf() === true)));
    return { commission, blocked };
}

// ctx.validating: whether the stash has a Staking.Validators entry (false: not validating yet,
// so a lone staking.validate starts validating; unknown: labelled as a commission change).
export function describeValidatorCall(call, { validating } = {}) {
    if (!isCall(call)) return null;
    const k = callKey(call);
    if (k === 'utility.batchAll' || k === 'utility.batch') {
        const items = Array.from(call.args[0] || []);
        if (!items.length || !items.every(i => isCall(i) && VALIDATOR_CALLS.has(callKey(i)))) return null;
        const parts = items.map(i => {
            const ik = callKey(i);
            if (ik === 'staking.bond') return `bond ${pdex(argNum(i.args[0]))} PDEX`;
            if (ik === 'staking.bondExtra') return `bond ${pdex(argNum(i.args[0]))} PDEX more`;
            if (ik === 'session.setKeys') return 'register session keys';
            if (ik === 'staking.validate') return `commission ${perbillToPercent(prefsOf(i).commission)}`;
            return (describeValidatorCall(i) || ik).toLowerCase();
        });
        return `Set up the validator: ${parts.join(', ')}`;
    }
    if (!VALIDATOR_CALLS.has(k)) return null;
    if (k === 'staking.validate') {
        const p = prefsOf(call);
        const head = validating === false ? `Start validating at ${perbillToPercent(p.commission)} commission` : `Change commission to ${perbillToPercent(p.commission)}`;
        return `${head}${p.blocked ? ', new nominations blocked' : ''}`;
    }
    if (k === 'staking.chill') return 'Stop validating';
    if (k === 'staking.bondExtra') return `Bond ${pdex(argNum(call.args[0]))} PDEX more`;
    if (k === 'staking.bond') return `Bond ${pdex(argNum(call.args[0]))} PDEX`;
    if (k === 'staking.setPayee') return 'Change where rewards go';
    if (k === 'staking.rebond') return `Rebond ${pdex(argNum(call.args[0]))} PDEX`;
    if (k === 'staking.unbond') return `Unbond ${pdex(argNum(call.args[0]))} PDEX`;
    if (k === 'staking.withdrawUnbonded') return 'Withdraw unbonded PDEX';
    return 'Register new session keys';
}

// The manage step or the setup review a decoded call stands for, so the
// Sprint 3 and 4 sign-time rules can run on it again; null for anything else.
export function stepsFromCall(call) {
    if (!isCall(call)) return null;
    const k = callKey(call);
    const hex = (a) => (a && typeof a.toHex === 'function' ? a.toHex() : String(a));
    if (k === 'utility.batchAll') {
        const steps = [];
        let bond = 0n, extra = 0n, commission = null;
        for (const i of Array.from(call.args[0] || [])) {
            const ik = isCall(i) ? callKey(i) : '';
            if (ik === 'staking.bond') { bond = argNum(i.args[0]); steps.push({ kind: 'bond', value: bond }); }
            else if (ik === 'staking.bondExtra') { extra = argNum(i.args[0]); steps.push({ kind: 'bondExtra', value: extra }); }
            else if (ik === 'session.setKeys') steps.push({ kind: 'setKeys', keysHex: hex(i.args[0]).toLowerCase() });
            else if (ik === 'staking.validate') { commission = prefsOf(i).commission; steps.push({ kind: 'validate', commission }); }
            else return null;
        }
        return steps.length ? { setup: { steps, bond, extra, commission } } : null;
    }
    if (k === 'staking.validate') { const p = prefsOf(call); return { manage: { kind: 'commission', commission: p.commission, blocked: p.blocked } }; }
    if (k === 'staking.chill') return { manage: { kind: 'chill' } };
    if (k === 'staking.bondExtra') return { manage: { kind: 'bondExtra', value: argNum(call.args[0]) } };
    if (k === 'staking.rebond') return { manage: { kind: 'rebond', value: argNum(call.args[0]) } };
    if (k === 'staking.unbond') return { unbond: { value: argNum(call.args[0]) } };
    if (k === 'session.setKeys') return { manage: { kind: 'keys', keysHex: hex(call.args[0]).toLowerCase() } };
    if (k === 'staking.setPayee') return { manage: { kind: 'payee', payee: null } };
    return null;
}

// Whether the final-approval guard runs the explorer's rules on this call
// again. bond, withdrawUnbonded and utility.batch are not re-checked: the
// pending list says so (NOT_RECHECKED) instead of implying a check.
export function isRechecked(call) { return stepsFromCall(call) != null; }
export const NOT_RECHECKED = 'Not re-checked by the explorer; the chain decides.';

// rows: [{ hash, pending (lib/multisig.js pendingMultisig), call (decoded, or null) }].
// validating: whether the multisig stash validates now (lib/validator-delegate-chain.js), null if unknown.
export function pendingValidatorOps(rows, multisig, { isSame = (a, b) => a === b, validating = null } = {}) {
    const ops = [];
    let others = 0;
    for (const r of rows || []) {
        const label = r && r.call ? describeValidatorCall(r.call, { validating: validating == null ? undefined : validating }) : null;
        if (!label || !r.pending) { others++; continue; }
        const approvedBy = r.pending.approvals.slice();
        ops.push({ hash: r.hash, label, approvals: approvedBy.length, threshold: multisig.threshold, approvedBy,
            waitingFor: multisig.signers.filter(s => !approvedBy.some(a => isSame(a, s))), since: String(r.pending.when.height), callHex: r.call.toHex(), rechecked: isRechecked(r.call) });
    }
    return { ops, others };
}
export function pendingOpText(op, shortAddr = (a) => a) {
    return `${op.approvals} of ${op.threshold} approvals. Approved by ${op.approvedBy.map(shortAddr).join(', ')}. Waiting for ${op.waitingFor.length ? op.waitingFor.map(shortAddr).join(' or ') : 'nobody'}.`;
}

// ── copy (design 4.1) ──
export const STAKING_PROXY_LIMITS = 'A Staking proxy cannot send your funds to another account. It can change where rewards are paid, stop you validating, and start unbonding your bond; unbonded PDEX stays in the stash. It cannot register session keys on this runtime: key rotation needs the stash.';
export const MULTISIG_CHANGE_WARNING = 'Conditions can change between approvals: the minimum bond, the minimum commission or the keys registered to other accounts. The explorer checks the validator rules again when the last approval runs the call, and refuses it if they no longer hold.';
export const MULTISIG_FEE_NOTE = 'The signer who approves pays the network fee, and the first approval reserves a refundable deposit from that signer. The multisig review shows both.';
export const PROXY_FEE_NOTE = 'Your proxy account pays the network fee. The change is made for the stash.';
export function proxyIntro(type) {
    return `You are connected as a ${type} proxy of this stash. Changes you sign here are sent as proxy.proxy for the stash. ${PROXY_FEE_NOTE}`;
}

// ── rollout (design 5.1, 5.4) ──
// The wallet dashboard card: only for an account that validates or has
// session keys; most users are not operators and see nothing.
export function walletValidatorCard(info, esc) {
    if (!info || (!info.validating && !info.hasKeys)) return '';
    const text = info.validating ? 'This account validates.' : 'This account has session keys registered but is not asking to validate.';
    return '<div class="wallet-validator-card list-container glass"><h3>Validator</h3>'
        + `<p>${esc(text)} <a href="/validate" class="item-link" data-spa-link="true">Open validator status</a></p></div>`;
}
// "Add a staking proxy" (the manage panel) opens the existing proxy form with
// ?proxy=Staking: type Staking, delay 0 and the limits copy. Only Staking: the
// explorer never proposes NonTransfer or Any as a validator hot key (4.1).
export function proxyPrefill(search) {
    let v = null;
    try { v = new URLSearchParams(search || '').get('proxy'); } catch (e) { v = null; }
    return v && v.toLowerCase() === 'staking' ? { type: 'Staking', delay: 0, note: STAKING_PROXY_LIMITS } : null;
}
