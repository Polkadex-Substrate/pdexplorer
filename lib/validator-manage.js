// Validator manage, Sprint 4 (money path): the rules behind the manage panel on
// /validate (design sections 2.3, 4.3, 4.6, 5.2 and 5.4). Pure:
// lib/validator-manage-chain.js reads the chain, lib/validator-manage-view.js
// renders. Tested in test/validator-manage.test.js against the spec 393
// metadata (real codecs).
//
// One single call per action, never a batch (a Staking proxy cannot batch on
// this runtime, design 1.10; proxy and multisig signing are Sprint 5,
// lib/validator-delegate.js):
//   change commission, block nominations  staking.validate({ commission, blocked })
//   rotate keys                           session.setKeys(keys, 0x)
//   bond more                             staking.bondExtra(max_additional)
//   change payee                          staking.setPayee(Staked | Stash | Account)
//   stop validating                       staking.chill()
//   rebond                                staking.rebond(value)
// Unbond and withdraw stay in the existing Unstake modal on the wallet page
// (design 2.3: link, not a second copy); this module adds the validator rule
// that modal was missing (unbondProblem, applied at signing by
// lib/validator-manage-chain.js buildCheckedUnbondTx).
//
// Sources (polkadot-sdk polkadot-stable2512-3, polkadex-node mainnet spec 393):
//   staking validate, chill, set_payee, rebond, unbond, withdraw_unbonded:
//     "The dispatch origin for this call must be _Signed_ by the controller";
//     bond_extra: "must be _Signed_ by the stash, not the controller"; and
//     session set_keys registers keys to the signer (ValidatorIdOf =
//     ConvertInto), so it is the stash.
//   validate: ensure!(prefs.commission >= MinCommission::<T>::get(),
//     CommissionTooLow); deposits ValidatorPrefsSet. The prefs are copied to
//     ErasValidatorPrefs when an era is planned, so a change applies from the
//     next era to be planned.
//   chill: chill_stash deposits Chilled only when it removed a validator or
//     nominator.
//   set_payee: no event; Controller is refused (ControllerDeprecated).
//   bond_extra: additional.min(free_to_stake) (clamps silently); Bonded.
//   rebond: NoUnlockChunk when nothing unbonds; ledger.active >= ED or
//     InsufficientBond; Bonded { amount: rebonded_value }.
//   do_unbond (impls.rs): when unlocking is full it first withdraws matured
//     chunks, then ensure!(ledger.unlocking.len() < MaxUnlockingChunks,
//     NoMoreChunks); a remainder below ED is unbonded too; then
//       min_active_bond = MinNominatorBond if Nominators contains the stash,
//       else MinValidatorBond if Validators contains it, else zero;
//       ensure!(ledger.active >= min_active_bond, InsufficientBond)
//     "If a user runs into this error, they should chill first." unbond with
//     value >= ledger.total calls chill_stash first.
//   session purge_keys: takes NextKeys and every KeyOwner at once; the next
//     session change then skips the stash ("failed to load session key"), so
//     an active validator drops out. Never called here.
// MinCommission, MinValidatorBond and MinNominatorBond are storage set by
// governance; MaxUnlockingChunks and BondingDuration are runtime constants.
// All come in as arguments from live reads and are never written here.

import { formatPlanck } from './call-args-format.js';
import { perbillToPercent, aboutDuration, FALLBACK_SESSIONS_PER_ERA, FALLBACK_SESSION_SECONDS } from './validator-status.js';
import { maxBondable, clampText, payeeArg, PERBILL, COMMISSION_WARN_PERBILL } from './validator-setup.js';
import { parseSessionKeys, classifyKeyOwners, EXPECTED_LAYOUT } from './session-keys.js';
import { proxyAction } from './validator-delegate.js';

export const MANAGE_ACTION = 'validator.manage';
// Metadata pallet and call names, for TxPause.PausedCalls.
export const KIND_CALLS = Object.freeze({
    commission: ['Staking', 'validate'], keys: ['Session', 'set_keys'], bondExtra: ['Staking', 'bond_extra'],
    payee: ['Staking', 'set_payee'], chill: ['Staking', 'chill'], rebond: ['Staking', 'rebond']
});
const STASH_KINDS = new Set(['keys', 'bondExtra']);

const big = (x) => { try { return x == null || x === '' ? 0n : BigInt(String(x)); } catch (e) { return 0n; } };
const pdex = (v) => formatPlanck(big(v)) ?? '0';
const R = (ok, message = '') => ({ ok, message });

// ── the menu (design 5.2) ──
const LABELS = { commission: 'Change commission', keys: 'Rotate keys', bondExtra: 'Bond more', payee: 'Change payee', chill: 'Stop validating', rebond: 'Rebond' };
// Commission is not offered once the stash stopped asking to validate:
// staking.validate would make it a candidate again.
const MENU = {
    active: ['commission', 'keys', 'bondExtra', 'payee', 'chill'],
    'elected-next': ['commission', 'keys', 'bondExtra', 'payee', 'chill'],
    waiting: ['bondExtra', 'commission', 'keys', 'chill'],
    'active-leaving': ['keys', 'bondExtra', 'payee']
};
// The page model is fetched at mount and goes stale after a chill: a stash that
// no longer asks to validate keeps its set membership for the era but must not
// be offered commission or Stop validating (staking.validate would make it a
// candidate again).
export function liveMenuState(state, validating) {
    if (validating || !MENU[state] || !MENU[state].includes('commission')) return state;
    return 'active-leaving';
}
export function manageMenu(state, { unlocking = false, offline = false } = {}) {
    const kinds = MENU[state] || [];
    if (!kinds.length) return { primary: null, actions: [], links: [] };
    const actions = kinds.concat(unlocking ? ['rebond'] : []).map(kind => ({ kind, label: state === 'waiting' && kind === 'bondExtra' ? 'Add to your bond' : LABELS[kind] }));
    return {
        primary: offline && state === 'active' ? { label: 'Open the node checklist', href: '/validate/node' } : null,
        actions,
        links: [{ label: 'Unbond or withdraw', href: '/unstake' }]
    };
}

// ── who signs (design 1.6, 1.10) ──
export function signerFor(kind, state) {
    return STASH_KINDS.has(kind) ? state.stash : (state.controller || state.stash);
}
export function roleOf(state, connected, { isSame = (a, b) => a === b } = {}) {
    if (!connected || !state) return { role: null };
    if (isSame(connected, state.stash)) return { role: 'stash' };
    if (state.controller && isSame(connected, state.controller)) return { role: 'controller' };
    const p = (state.proxies || []).find(x => isSame(x.delegate, connected));
    return p ? { role: 'proxy', type: String(p.type) } : { role: null };
}
export const WATCHED_TEXT = 'Connect the wallet that holds this account to make changes.';
// A proxy of the stash (Sprint 5): the actions its type allows on this
// runtime, with no announcement delay (lib/validator-delegate.js proxyAction);
// the rest are refused with the reason. typesProblem: the runtime's proxy
// types differ from the table (proxyTypesProblem).
export function signerProblem(kind, state, connected, { isSame = (a, b) => a === b, typesProblem = null } = {}) {
    const r = roleOf(state, connected, { isSame });
    if (!r.role) return WATCHED_TEXT;
    if (r.role === 'proxy') { const p = proxyAction(kind, { state, me: connected, isSame, typesProblem }); return p.ok ? null : p.reason; }
    if (isSame(connected, signerFor(kind, state))) return null;
    if (STASH_KINDS.has(kind)) return `Bonding more and registering session keys are signed by the stash ${state.stash}. Connect it to do this.`;
    return `This stash is controlled by ${state.controller} (an older setup). Connect that account to change commission or stop validating, or sign 'merge controller into stash' from the stash.`;
}

// ── time (the status model's era and session, the params' durations) ──
export function timeFacts(model = {}, params = {}) {
    const p = params || {}, m = model || {};
    const sessionSeconds = p.epochDuration > 0 && p.blockTimeMs > 0 ? (p.epochDuration * p.blockTimeMs) / 1000 : 4 * 3600;
    const sessionsPerEra = Number(p.sessionsPerEra) || FALLBACK_SESSIONS_PER_ERA;
    const n = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
    return {
        activeEra: n(m.era && m.era.active != null ? m.era.active : p.activeEra), currentEra: n(m.era && m.era.current != null ? m.era.current : p.currentEra),
        eraEndsIn: n(m.era && m.era.endsIn), sessionIndex: n(m.session && m.session.index), nextSessionIn: n(m.session && m.session.nextIn),
        sessionSeconds, eraSeconds: sessionSeconds * sessionsPerEra
    };
}
const eraSecondsOf = (t = {}) => Number(t.eraSeconds) || 86400;

// ── what the live chain state rules out ──
export function notValidatingProblem(kind, validating) {
    if (validating || (kind !== 'commission' && kind !== 'chill')) return null;
    return 'This stash is not asking to validate now, so there is no commission to change and nothing to stop. You can still rotate keys, bond more or change payee.';
}
// staking.validate checks ledger.active >= MinValidatorBond for a sitting validator too.
export function commissionBondProblem({ active, minValidatorBond } = {}) {
    if (minValidatorBond == null) return null;
    const a = big(active), min = big(minValidatorBond);
    if (a >= min) return null;
    return `The chain now requires at least ${pdex(min)} PDEX bonded to change commission, and this stash has ${pdex(a)} PDEX bonded. Use Bond more to add ${pdex(min - a)} PDEX first, then change commission.`;
}
export function maxUnbondWarning(t = {}) {
    const c = chillText(t, { inSet: true });
    return `Max unbonds your whole bond, which also stops this stash validating. ${c[1]} ${c[2]}`;
}

// ── commission (design 4.3, 5.4) ──
export const COMMISSION_NOTE = 'Your nominators see this change. The explorer keeps a commission history for every validator.';
export const BLOCKED_NOTE = 'Blocking new nominations applies at once. Nominators who already nominate you stay.';
export const FULL_COMMISSION_TEXT = 'At 100% your nominators earn nothing and the explorer flags your validator to them. To stop new nominations instead, use Block new nominations.';
export const CONFIRM_100 = 'I want a 100% commission: my nominators earn nothing.';

export function commissionChange(perbill, { current = null, currentBlocked = false, blocked = false, minCommission, median = null, confirmed = false } = {}) {
    const out = (ok, message = '', warning = '', needsConfirm = false) => ({ ok, message, warning, needsConfirm });
    if (minCommission == null) return out(false, 'The explorer could not read the minimum commission from the chain. Try again.');
    const c = Number(perbill);
    if (c < Number(minCommission)) return out(false, `The minimum commission on Polkadex is ${perbillToPercent(minCommission)}. The chain refuses a lower rate.`);
    if (current != null && c === Number(current) && !!blocked === !!currentBlocked) return out(false, 'That is the current commission. Nothing would change.');
    if (c >= PERBILL && !confirmed) return out(false, FULL_COMMISSION_TEXT, '', true);
    if (c > COMMISSION_WARN_PERBILL) {
        return out(true, '', median == null ? 'Nominators sort by commission, so a high commission attracts fewer nominators.'
            : `The median commission of active validators is ${perbillToPercent(median)}. Nominators sort by commission.`);
    }
    return out(true);
}

export function commissionText(next, prev = {}) {
    const n = perbillToPercent(next.commission), p = perbillToPercent(prev.commission == null ? next.commission : prev.commission);
    const head = n === p ? `Keep commission at ${p}` : `Change commission from ${p} to ${n}`;
    if (!!next.blocked === !!prev.blocked) return head;
    return head + (next.blocked ? ' and block new nominations' : ' and accept new nominations again');
}

// Prefs reach ErasValidatorPrefs when an era is planned: the next era, or the
// one after it when the next is already planned (CurrentEra > ActiveEra).
export function commissionTimingText(t = {}) {
    if (t.activeEra == null) return 'Applies from the next era. Rewards until then use the current rate.';
    const planned = t.currentEra != null && t.currentEra > t.activeEra;
    const era = (planned ? t.currentEra : t.activeEra) + 1;
    const inS = t.eraEndsIn == null ? null : t.eraEndsIn + (planned ? eraSecondsOf(t) : 0);
    return `Applies from era ${era}${inS == null ? '' : `, which starts in ${aboutDuration(inS)}`}. Rewards until then use the current rate.`;
}

// ── keys (design 4.2, 5.4) ──
export const ROTATE_RULE = 'Keep the old node running with the old keys until the dashboard says the new keys are in use. Then stop the old node. Never run both with the same keys.';
export const PURGE_NOTE = 'The explorer only registers new keys and never removes keys: removing them from an active validator drops it out of the validator set from the session after next.';
export function keysTimingText(t = {}) {
    const tail = ' Until then the chain uses the keys registered now.';
    if (t.sessionIndex == null || t.nextSessionIn == null) return 'The new keys are used from the session after next, between 4 and 8 hours from now.' + tail;
    return `The new keys are used from session ${t.sessionIndex + 2}, in ${aboutDuration(t.nextSessionIn + (Number(t.sessionSeconds) || FALLBACK_SESSION_SECONDS))}.` + tail;
}
// c: classifyKeyOwners(...) for the pasted keys.
export function rotateKeysProblem(c) {
    const other = c.rows.find(r => r.result === 'other');
    if (other) return other.message;
    if (c.sameAsNext || (c.rows.length && c.rows.every(r => r.result === 'own'))) return 'These keys are already registered to this stash. Nothing to sign.';
    return null;
}

// ── bond more ──
export function maxBondMore(state, fee, reserve) {
    return maxBondable({ ...(state.balance || {}), ed: state.ed, fee, ...(reserve != null ? { reserve } : {}) });
}
export function bondMoreCheck(amount, { max = null } = {}) {
    const a = big(amount);
    if (a <= 0n) return R(false, 'Enter an amount to add.');
    if (max != null && a > big(max)) return R(false, clampText(max));
    return R(true);
}
export function unbondingText(limits = {}, t = {}) {
    const n = limits.bondingDuration;
    if (n == null) return 'Bonded PDEX takes the chain\'s bonding duration to unbond.';
    const eraS = Number(t.eraSeconds) || (Number(t.sessionSeconds) || FALLBACK_SESSION_SECONDS) * (Number(limits.sessionsPerEra) || FALLBACK_SESSIONS_PER_ERA);
    return `Bonded PDEX takes ${n} eras, ${aboutDuration(n * eraS)}, to unbond.`;
}

// ── payee (design 1.6) ──
export const PAYEE_TIMING = 'Applies at once, to every payout made from now on, including eras not paid out yet.';
export function payeeOf(codec) {
    let v = codec;
    if (v && typeof v.isSome === 'boolean') { if (!v.isSome) return null; v = v.unwrap(); }
    if (v == null) return null;
    if (typeof v.isStaked === 'boolean') {
        if (v.isStaked) return { kind: 'staked', account: '' };
        if (v.isStash) return { kind: 'stash', account: '' };
        if (v.isController) return { kind: 'controller', account: '' };
        if (v.isAccount) return { kind: 'account', account: v.asAccount.toString() };
        return { kind: 'none', account: '' };
    }
    if (typeof v === 'string') return { kind: v.toLowerCase(), account: '' };
    const acc = v.Account || v.account;
    return acc ? { kind: 'account', account: String(acc) } : null;
}
export function payeeChange(next, current, { isAddress = () => true, isSame = (a, b) => a === b, stash = '' } = {}) {
    const kind = next && next.kind;
    if (!['staked', 'stash', 'account'].includes(kind)) return R(false, `Rewards destination "${kind}" is not offered.`);
    const a = String((next && next.account) || '').trim();
    if (kind === 'account') {
        if (!isAddress(a)) return R(false, 'Enter a Polkadex address for the rewards account. Polkadex addresses start with e.');
        if (stash && isSame(a, stash)) return R(false, 'That is this stash. Choose "Pay rewards to this stash, unbonded" instead.');
    }
    if (current && current.kind === kind && (kind !== 'account' || isSame(current.account, a))) return R(false, 'That is where rewards go now. Nothing would change.');
    return R(true);
}
export function payeeLabel(p, shortAddr = (a) => a) {
    if (!p) return 'not set';
    if (p.kind === 'staked') return 'added to the bond';
    if (p.kind === 'stash') return 'paid to this stash, unbonded';
    if (p.kind === 'account') return `paid to ${shortAddr(String(p.account))}`;
    if (p.kind === 'controller') return 'paid to the controller (an older setting)';
    return 'not paid to anyone';
}

// ── chill (design 1.7, 5.4) ──
export function chillText(t = {}, { inSet = true } = {}) {
    const out = ['You stay bonded and keep your session keys.', 'You stop being a candidate from the next era.'];
    if (inSet) {
        const planned = t.currentEra != null && t.activeEra != null && t.currentEra > t.activeEra;
        const era = planned ? t.currentEra : t.activeEra;
        const inS = t.eraEndsIn == null ? null : t.eraEndsIn + (planned ? eraSecondsOf(t) : 0);
        out.push(era == null ? 'You remain responsible for this era: keep the node running until it ends.'
            : `You remain responsible for this era: keep the node running until era ${era} ends${inS == null ? '' : `, in ${aboutDuration(inS)}`}.`);
    }
    out.push('Your nominators keep their nominations; they earn nothing from you while you are not validating.');
    return out;
}

// ── rebond ──
export function unlockingTotal(state) {
    return (state && state.unlocking ? state.unlocking : []).reduce((n, u) => n + big(u.value), 0n);
}
export function rebondCheck(amount, { state } = {}) {
    const a = big(amount), tot = unlockingTotal(state);
    if (a <= 0n) return R(false, 'Enter an amount to rebond.');
    if (a > tot) return R(false, `Only ${pdex(tot)} PDEX is unbonding, so that is the most you can rebond.`);
    if (big(state.active) + a < big(state.ed)) return R(false, `The bond after rebonding must be at least the existential deposit, ${pdex(state.ed)} PDEX.`);
    return R(true);
}

// ── unbond: the pallet rule (do_unbond), for the existing Unstake modal ──
// ctx: { active, total, unlocking: [{ value, era }], validating, nominating,
//        minValidatorBond, minNominatorBond, ed, maxUnlockingChunks, currentEra }
export function unbondProblem(value, ctx = {}) {
    const v0 = big(value);
    if (v0 <= 0n) return 'Enter an amount to unbond.';
    const unl = ctx.unlocking || [];
    const max = ctx.maxUnlockingChunks == null ? null : Number(ctx.maxUnlockingChunks);
    if (max != null && unl.length >= max) {
        const matured = ctx.currentEra == null ? 0 : unl.filter(u => Number(u.era) <= Number(ctx.currentEra)).length;
        if (unl.length - matured >= max) {
            return `This stash already has ${unl.length} unbonding amounts, the most the chain allows. Withdraw the ones that have finished, or wait until one finishes, then unbond again.`;
        }
    }
    const active = big(ctx.active), total = big(ctx.total), ed = big(ctx.ed);
    if (v0 >= total) return null;   // unbond chills first (value >= ledger.total)
    let v = v0 < active ? v0 : active;
    let rem = active - v;
    if (rem < ed) { v = active; rem = 0n; }
    const role = ctx.nominating ? 'nominates' : ctx.validating ? 'validates' : null;
    if (!role) return null;
    const min = big(role === 'nominates' ? ctx.minNominatorBond : ctx.minValidatorBond);
    if (rem >= min) return null;
    const most = active > min ? active - min : 0n;
    return `This stash ${role}, so it must keep at least ${pdex(min)} PDEX bonded. Unbonding ${pdex(v0)} PDEX leaves ${pdex(rem)} PDEX, and the chain refuses it. `
        + `${role === 'validates' ? 'Stop validating' : 'Stop nominating'} first, or unbond at most ${pdex(most)} PDEX.`;
}

// ── the call, the review, the events ──
export function buildManageCall(api, s) {
    const st = api.tx.staking;
    if (s.kind === 'commission') return st.validate({ commission: Number(s.commission), blocked: !!s.blocked });
    if (s.kind === 'keys') return api.tx.session.setKeys(String(s.keysHex).toLowerCase(), '0x');
    if (s.kind === 'bondExtra') return st.bondExtra(big(s.value));
    if (s.kind === 'payee') return st.setPayee(payeeArg(s.payee));
    if (s.kind === 'chill') return st.chill();
    if (s.kind === 'rebond') return st.rebond(big(s.value));
    throw new Error(`Unknown validator action ${s.kind}.`);
}

const CALL = { commission: 'staking.validate', keys: 'session.setKeys', bondExtra: 'staking.bondExtra', payee: 'staking.setPayee', chill: 'staking.chill', rebond: 'staking.rebond' };
export function reviewItem(s, { shortAddr = (a) => a, prefs = null } = {}) {
    let text;
    if (s.kind === 'commission') text = commissionText(s, prefs || { commission: s.commission, blocked: s.blocked });
    else if (s.kind === 'keys') text = `Register ${s.count || 6} new session keys`;
    else if (s.kind === 'bondExtra') text = `Add ${pdex(s.value)} PDEX to the bond`;
    else if (s.kind === 'payee') text = s.payee.kind === 'staked' ? 'Add rewards to the bond' : s.payee.kind === 'stash' ? 'Pay rewards to this stash, unbonded' : `Pay rewards to ${shortAddr(String(s.payee.account))}`;
    else if (s.kind === 'chill') text = 'Stop validating';
    else text = `Rebond ${pdex(s.value)} PDEX`;
    return { call: CALL[s.kind], text };
}

const EVENTS = { commission: ['staking.ValidatorPrefsSet'], bondExtra: ['staking.Bonded'], rebond: ['staking.Bonded'], chill: ['staking.Chilled'], keys: [], payee: [] };
export function expectedManageEvents(s) { return (EVENTS[s.kind] || []).slice(); }
const SUMMARY = { commission: 'Commission set.', keys: 'New session keys registered.', bondExtra: 'Added to the bond.', payee: 'Rewards destination changed.', chill: 'Stopped validating.', rebond: 'Rebonded.' };
export function manageSummary(s) { return SUMMARY[s.kind] || ''; }

// ── after inclusion: does the chain show the change? ──
const keysBlob = (map, names) => (map && names && names.length && names.every(n => map[n])
    ? '0x' + names.map(n => String(map[n]).toLowerCase().replace(/^0x/, '')).join('') : null);
const NAMES = EXPECTED_LAYOUT.map(l => l.name);
const samePayee = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== 'account' || String(a.account) === String(b.account));

export function manageApplied(after, review) {
    const s = review.step, was = review.state || {};
    if (s.kind === 'commission') return { applied: !!after.validating && !!after.prefs && Number(after.prefs.commission) === Number(s.commission) && !!after.prefs.blocked === !!s.blocked };
    if (s.kind === 'keys') return { applied: keysBlob(after.nextKeys, s.names || NAMES) === String(s.keysHex).toLowerCase() };
    if (s.kind === 'payee') return { applied: samePayee(after.payee, s.payee) };
    if (s.kind === 'chill') return { applied: !after.validating };
    const delta = big(after.active) - big(was.active), asked = big(s.value);
    if (delta <= 0n) return { applied: false };
    return delta < asked ? { applied: true, short: { bonded: delta, requested: asked } } : { applied: true };
}

export function appliedText(review, after, { t = {}, shortAddr = (a) => a } = {}) {
    const s = review.step;
    if (s.kind === 'commission') return `Commission is now ${perbillToPercent(s.commission)}${s.blocked ? ', and new nominations are blocked' : ''}. ${commissionTimingText(t)}`;
    if (s.kind === 'keys') return `New keys registered. ${keysTimingText(t)} ${ROTATE_RULE}`;
    if (s.kind === 'payee') return `Rewards are now ${payeeLabel(s.payee, shortAddr)}.`;
    if (s.kind === 'chill') return 'This stash no longer asks to validate. ' + chillText(t, { inSet: !!review.inSet }).slice(2).join(' ');
    const r = manageApplied(after, review);
    const now = `Bonded is now ${pdex(after.active)} PDEX.`;
    return r.short ? `Bonded ${pdex(r.short.bonded)} PDEX of the ${pdex(r.short.requested)} PDEX you asked for. The balance changed before the block. ${now}` : now;
}

// ── sign time (design 4.6): read again right before the wallet is asked ──
// fresh = { limits, state, owners (readKeyOwners, keys only), fee (bondExtra only) }.
export function manageSignTimeProblems(fresh, review) {
    const L = fresh.limits || {}, now = fresh.state || {}, was = review.state || {}, s = review.step;
    if (!now.bonded) return ['This stash is no longer bonded. Open validator status.'];
    if ((now.controller || null) !== (was.controller || null) || !!now.validating !== !!was.validating) {
        return ['This stash\'s staking state changed since you reviewed this. Start again.'];
    }
    const out = [];
    const idle = notValidatingProblem(s.kind, now.validating);
    if (idle) return [idle];
    if (s.kind === 'commission') {
        const bondProblem = commissionBondProblem({ active: now.active, minValidatorBond: L.minValidatorBond });
        if (bondProblem) return [bondProblem];
        if (L.minCommission == null) return ['The explorer could not read the minimum commission again before signing. Try again.'];
        if (Number(s.commission) < Number(L.minCommission)) out.push(`The minimum commission changed since you reviewed this: it is now ${perbillToPercent(L.minCommission)}. Enter a new rate.`);
        const wp = was.prefs || {}, np = now.prefs || {};
        if (Number(wp.commission) !== Number(np.commission) || !!wp.blocked !== !!np.blocked) out.push(`The commission changed since you reviewed this: it is now ${perbillToPercent(np.commission)}. Start again.`);
    } else if (s.kind === 'keys') {
        const lay = L.layout;
        const reparsed = lay && lay.ok && lay.layout ? parseSessionKeys(s.keysHex, { layout: lay.layout }) : null;
        if (!reparsed || !reparsed.ok || lay.hexLength !== String(s.keysHex).length) {
            out.push('The session key format changed since you reviewed this. Generate new keys on your node and paste them again.');
        } else {
            if (fresh.owners) {
                const other = classifyKeyOwners(reparsed.keys, { ...fresh.owners, stash: review.stash }).rows.find(r => r.result === 'other');
                if (other) out.push(other.message);
            }
            const names = s.names || NAMES;
            if (keysBlob(now.nextKeys, names) !== keysBlob(was.nextKeys, names)) out.push('The registered keys changed since you reviewed this. Start again.');
        }
    } else if (s.kind === 'bondExtra') {
        const max = maxBondMore(now, fresh.fee, fresh.reserve);
        if (big(s.value) > max) out.push('Your balance changed since you reviewed this. ' + clampText(max, { noFees: fresh.reserve != null && big(fresh.reserve) === 0n }));
    } else if (s.kind === 'payee') {
        if (!samePayee(now.payee, was.payee) && !(now.payee == null && was.payee == null)) out.push('Where rewards go changed since you reviewed this. Start again.');
    } else if (s.kind === 'rebond') {
        const tot = unlockingTotal(now);
        if (big(s.value) > tot) out.push(`The unbonding amount changed since you reviewed this: ${pdex(tot)} PDEX is unbonding now. Enter a new amount.`);
    }
    return out;
}
