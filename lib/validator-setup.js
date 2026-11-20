// Validator setup, Sprint 3 (money path): the rules behind /validate/setup.
// Pure: lib/validator-setup-chain.js reads the chain, lib/validator-setup-view.js
// renders. Tested in test/validator-setup.test.js against the spec 393
// metadata (real codecs).
//
// One signature (CEO decision D4, 2026-11-17), signed by the stash, whose
// account becomes the validator id (session ValidatorIdOf = ConvertInto):
//   utility.batchAll([staking.bond(value, payee), session.setKeys(keys, 0x),
//                     staking.validate({ commission, blocked: false })])
// with only the steps the chain does not show done (resume): bonded already
// gives bondExtra or nothing, keys identical to Session.NextKeys skip setKeys,
// a Staking.Validators entry skips validate.
//
// Sources (polkadot-sdk polkadot-stable2512-3; polkadex-node mainnet spec 393):
//   utility batch_all: atomic. A failing call fails the whole extrinsic
//     (ExtrinsicFailed with that call's error); success deposits
//     ItemCompleted per call and BatchCompleted.
//   staking bond(value: Compact<u128>, payee: RewardDestination): clamps
//     silently, value.min(free_to_stake) where free_to_stake is
//     reducible_balance(Preserve, Force) (staking/src/asset.rs); deposits
//     Bonded { stash, amount }. bond_extra(max_additional) deposits Bonded too.
//     Controller as payee is deprecated (set_payee refuses it; bond does not
//     check), so it is never offered; nor is None. A new bond below the
//     existential deposit fails with InsufficientBond, so it is refused here.
//   staking validate(prefs: { commission: Perbill, blocked: bool }): needs
//     ledger.active >= MinValidatorBond, commission >= MinCommission and, for
//     a new candidate, CounterForValidators < MaxValidatorsCount; deposits
//     ValidatorPrefsSet { stash, prefs }.
//   session set_keys(keys, proof: Bytes): the proof is not checked on this SDK
//     (the ownership_proof_is_valid trait default), so 0x. No event: success is
//     Session.NextKeys(stash) equal to the pasted keys.
// MinValidatorBond and MinCommission are storage set by governance: they come
// in as arguments from live reads and are never written here as numbers.

import { formatPlanck } from './call-args-format.js';
import { perbillToPercent, aboutDuration } from './validator-status.js';
import { feeFloor, FEE_MARGIN } from './fee-preflight.js';
import { parseSessionKeys, classifyKeyOwners, layoutMismatchText } from './session-keys.js';
import { offlineSlashThreshold } from './nomination-status.js';

export const SETUP_ACTION = 'validator.setup';
// PDEX kept free after bonding for later fees (design 4.4), on top of the
// existential deposit or the part of a lock that reserved PDEX does not cover.
export const WORKING_RESERVE = 10n ** 12n;
export const PERBILL = 1_000_000_000;
export const COMMISSION_WARN_PERBILL = 200_000_000;   // 20%: warn, not block (design 4.3, D5 open)

const PLANCK_DECIMALS = 12;
const big = (x) => { try { return x == null || x === '' ? 0n : BigInt(String(x)); } catch (e) { return 0n; } };
const pdex = (v) => formatPlanck(big(v)) ?? '0';

// ── input parsing (integer math, no floats) ──
const PERCENT_TEXT = 'Enter the commission in percent, for example 5 or 7.5, with at most 2 decimals, from 0 to 100.';
export function parsePercent(text) {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(text == null ? '' : text).trim());
    if (!m) return { ok: false, message: PERCENT_TEXT };
    const whole = Number(m[1]), frac = Number((m[2] || '').padEnd(2, '0'));
    if (whole > 100 || (whole === 100 && frac > 0)) return { ok: false, message: PERCENT_TEXT };
    return { ok: true, perbill: whole * 10_000_000 + frac * 100_000 };
}

const AMOUNT_TEXT = 'Enter an amount in PDEX, like 150 or 150.5, with at most 12 decimals.';
export function parsePdexAmount(text) {
    const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(String(text == null ? '' : text).trim());
    if (!m) return { ok: false, message: AMOUNT_TEXT };
    return { ok: true, planck: BigInt(m[1]) * 10n ** BigInt(PLANCK_DECIMALS) + BigInt((m[2] || '').padEnd(PLANCK_DECIMALS, '0')) };
}

// Planck as a plain decimal for an input field (no thousands separators).
export function planckToInput(v) {
    const s = big(v).toString().padStart(PLANCK_DECIMALS + 1, '0');
    const whole = s.slice(0, s.length - PLANCK_DECIMALS), frac = s.slice(-PLANCK_DECIMALS).replace(/0+$/, '');
    return whole + (frac ? '.' + frac : '');
}

// ── commission (design 4.3) ──
const result = (ok, message = '', warning = '') => ({ ok, message, warning });
export function commissionCheck(perbill, { minCommission, median = null } = {}) {
    if (minCommission == null) return result(false, 'The explorer could not read the minimum commission from the chain. Try again.');
    const c = Number(perbill);
    if (c < Number(minCommission)) return result(false, `The minimum commission on Polkadex is ${perbillToPercent(minCommission)}.`);
    if (c >= PERBILL) return result(false, 'At 100% your nominators earn nothing and the explorer flags your validator to them.');
    if (c > COMMISSION_WARN_PERBILL) {
        return result(true, '', median == null ? 'Nominators sort by commission, so a high commission attracts fewer nominators.'
            : `The median commission of active validators is ${perbillToPercent(median)}. Nominators sort by commission.`);
    }
    return result(true);
}

// ── bond (design 4.4) ──
// What can be bonded without the chain clamping it and with fees still
// payable afterwards: free - fee - max(frozen - reserved, ED) - WORKING_RESERVE.
// The fee is the batch's estimate, or the balance panel's margin without one.
// reserve 0n with fee 0n: a multisig stash, whose signatory pays the fee
// (the final-approval guard, lib/validator-delegate-chain.js).
export function maxBondable({ free, reserved = 0n, frozen = 0n, ed = 0n, fee = null, reserve = WORKING_RESERVE }) {
    const f = fee == null ? FEE_MARGIN : big(fee);
    const m = big(free) - f - feeFloor({ frozen: big(frozen), reserved: big(reserved), ed: big(ed) }) - big(reserve);
    return m > 0n ? m : 0n;
}

// noFees: the multisig case, where nothing is kept back for fees.
export function clampText(max, { noFees = false } = {}) {
    if (noFees) return `That is more than this account can bond: the most is ${pdex(max)} PDEX.`;
    return `That is more than this account can bond. After the network fee and ${pdex(WORKING_RESERVE)} PDEX kept free for later fees, the most is ${pdex(max)} PDEX.`;
}

// amount: what this signature bonds (bond, or bondExtra when already bonded:
// active > 0 and optional true, where nothing added is fine).
export function bondCheck(amount, { minValidatorBond, max, lowestElected = null, active = 0n, optional = false, ed = 0n } = {}) {
    if (minValidatorBond == null) return result(false, 'The explorer could not read the minimum bond from the chain. Try again.');
    const a = big(amount), act = big(active), min = big(minValidatorBond);
    if (a <= 0n && !optional) return result(false, 'Enter an amount to bond.');
    if (!optional && act === 0n && a < big(ed)) return result(false, `A new bond must be at least the existential deposit, ${pdex(ed)} PDEX.`);
    if (a > 0n && max != null && a > big(max)) return result(false, clampText(max));
    const total = act + (a > 0n ? a : 0n);
    if (total < min) {
        return result(false, act > 0n
            ? `Validating needs at least ${pdex(min)} PDEX bonded. This stash has ${pdex(act)} PDEX bonded, so add at least ${pdex(min - act)} PDEX.`
            : `Validating needs at least ${pdex(min)} PDEX bonded.`);
    }
    if (lowestElected != null && total < big(lowestElected)) {
        return result(true, '', `${pdex(total)} PDEX meets the minimum but the lowest elected validator has ${pdex(lowestElected)} PDEX behind it. You will wait until your own bond plus nominations exceed that.`);
    }
    return result(true);
}

// ── payee (design 1.6) ──
export function payeeArg(p) {
    const kind = p && p.kind;
    if (kind === 'staked') return 'Staked';
    if (kind === 'stash') return 'Stash';
    if (kind === 'account') {
        if (!p.account) throw new Error('Rewards to another account need that account\'s address.');
        return { Account: String(p.account) };
    }
    throw new Error(`Rewards destination "${kind}" is not offered.`);
}
export function payeeText(p, shortAddr = (a) => a) {
    if (p && p.kind === 'stash') return 'paid to this stash, unbonded';
    if (p && p.kind === 'account') return `paid to ${shortAddr(String(p.account))}`;
    return 'added to the bond';
}

// ── the plan (design 2.2, resume) ──
const keysBlob = (map, names) => (map && names && names.length && names.every(n => map[n])
    ? '0x' + names.map(n => String(map[n]).toLowerCase().replace(/^0x/, '')).join('') : null);

// The stash signs every step; a legacy controller or an account that is a
// controller of another stash cannot run this setup.
export function controllerRefusal(state) {
    if (state.controllerOf && state.controllerOf !== state.stash) {
        return `This account is the controller of the stash ${state.controllerOf}. Validators are set up from the stash: connect ${state.controllerOf} instead.`;
    }
    if (state.bonded && state.controller && state.controller !== state.stash) {
        return `This stash is controlled by ${state.controller} (an older setup). The explorer sets up validators signed by the stash itself. Connect that account to change commission or stop validating, or sign 'merge controller into stash' from the stash.`;
    }
    return null;
}

// state: lib/validator-setup-chain.js readSetupState. input: { bond, extra,
// payee, keys (parseSessionKeys .keys, or null to keep what is registered),
// keysHex, commission (Perbill) }.
export function planSetup(state, input) {
    const n = Number(state.nominations) || 0;
    const notes = n > 0 ? [`This stash nominates ${n} ${n === 1 ? 'validator' : 'validators'}. Validating replaces your nominations.`] : [];
    const refusal = controllerRefusal(state);
    if (refusal) return { steps: [], refusal, notes, nothingToDo: false };
    const steps = [];
    if (!state.bonded) steps.push({ kind: 'bond', value: big(input.bond), payee: input.payee });
    else if (big(input.extra) > 0n) steps.push({ kind: 'bondExtra', value: big(input.extra) });
    if (input.keys && input.keysHex) {
        const names = input.keys.map(k => k.name);
        if (keysBlob(state.nextKeys, names) !== String(input.keysHex).toLowerCase()) {
            steps.push({ kind: 'setKeys', keysHex: String(input.keysHex).toLowerCase(), names, count: input.keys.length });
        }
    } else if (!state.nextKeys) {
        return { steps: [], refusal: 'Paste your node\'s session keys first: this stash has no session keys registered.', notes, nothingToDo: false };
    }
    if (!state.validating) steps.push({ kind: 'validate', commission: Number(input.commission), blocked: false });
    return { steps, refusal: null, notes, nothingToDo: steps.length === 0 };
}

// The calls, in order, built through the api's own decorated extrinsics.
export function setupCalls(api, steps) {
    return (steps || []).map((s) => {
        if (s.kind === 'bond') return api.tx.staking.bond(s.value, payeeArg(s.payee));
        if (s.kind === 'bondExtra') return api.tx.staking.bondExtra(s.value);
        if (s.kind === 'setKeys') return api.tx.session.setKeys(s.keysHex, '0x');
        if (s.kind === 'validate') return api.tx.staking.validate({ commission: s.commission, blocked: false });
        throw new Error(`Unknown setup step ${s.kind}.`);
    });
}
// One step as its own bare extrinsic (the "sign in separate steps" fallback,
// lib/validator-setup-steps.js): the same builder as the batch, no wrapper.
export function buildSetupStepCall(api, step) {
    if (!step) throw new Error('Nothing to sign: the chain already shows every setup step for this stash.');
    return setupCalls(api, [step])[0];
}
// One step left (a resume): the bare call. A batch of one adds nothing and is
// the form a hardware device is most likely to refuse (spec section 9,
// finding 2); its events, pauses and verification follow (expectedSetupEvents,
// setupPausableCalls; setupApplied reads the chain either way).
export function buildSetupTx(api, steps) {
    if (!steps || !steps.length) throw new Error('Nothing to sign: the chain already shows every setup step for this stash.');
    if (steps.length === 1) return setupCalls(api, steps)[0];
    return api.tx.utility.batchAll(setupCalls(api, steps));
}

// The fee probe for Max (design 4.4): the batch that will be signed for this
// resume state, every missing call, with the pasted keys or a placeholder of
// the same length. The bond value, payee and commission take their longest
// encodings (the free balance, another account, PERBILL - 1), so the probe's
// length fee is never below the real batch's and Max never exceeds what the
// signed batch allows. The review estimates the real batch again.
export function feeProbeSteps(state, { keysHex = '', keep = false, hexLength = 0 } = {}) {
    const free = big(state && state.balance && state.balance.free);
    const value = free > 0n ? free : 1n;
    const steps = [];
    if (!state.bonded) steps.push({ kind: 'bond', value, payee: { kind: 'account', account: String(state.stash) } });
    else steps.push({ kind: 'bondExtra', value });
    const hex = keysHex ? String(keysHex).toLowerCase() : (hexLength > 2 ? '0x' + '0'.repeat(hexLength - 2) : '');
    if (!keep && hex) steps.push({ kind: 'setKeys', keysHex: hex, names: [], count: 0 });
    if (!state.validating) steps.push({ kind: 'validate', commission: PERBILL - 1, blocked: false });
    return steps;
}

// The fee and the most that can be bonded with it, when an amount no longer
// fits once the real batch is estimated (design 4.4).
export function feeRoseText(fee, max) {
    return `The network fee is ${pdex(fee)} PDEX, so the most you can bond is ${pdex(max)} PDEX.`;
}

// pallet-safe-mode and pallet-tx-pause (both in spec 393): the calls whose
// pause would make the chain refuse this batch, by metadata pallet and call name.
const CALL_NAMES = { bond: ['Staking', 'bond'], bondExtra: ['Staking', 'bond_extra'], setKeys: ['Session', 'set_keys'], validate: ['Staking', 'validate'] };
export function pausableCalls(steps) {
    return [['Utility', 'batch_all']].concat((steps || []).map(s => CALL_NAMES[s.kind]).filter(Boolean));
}
// What buildSetupTx sends for these steps: no Utility.batch_all for a bare
// call. pausableCalls stays the batch's list (a decoded multisig batch,
// lib/validator-delegate-chain.js).
export function setupPausableCalls(steps) {
    return steps && steps.length === 1 ? pausableCalls(steps).slice(1) : pausableCalls(steps);
}
// p: { safeModeUntil: block number or null, paused: ['Pallet.call', ...] }.
export function pauseProblems(p = {}) {
    if (p.safeModeUntil != null) {
        return [`The network is in safe mode until block #${Number(p.safeModeUntil).toLocaleString('en-US')}, so it would refuse this transaction. Nothing was signed. Try again after that block.`];
    }
    return (p.paused || []).map(c => `The network has paused ${c}, so it would refuse this transaction. Nothing was signed. Try again once the pause is lifted.`);
}

export function expectedSetupEvents(steps) {
    // A bare call (one step) has no utility events; a lone setKeys reports none at all.
    const out = steps.length === 1 ? [] : ['utility.BatchCompleted'];
    if (steps.some(s => s.kind === 'bond' || s.kind === 'bondExtra')) out.push('staking.Bonded');
    if (steps.some(s => s.kind === 'validate')) out.push('staking.ValidatorPrefsSet');
    return out;
}

export function setupSummary(steps) {
    const parts = steps.map(s => ({ bond: 'bonded', bondExtra: 'added to the bond', setKeys: 'keys registered', validate: 'asking to validate' }[s.kind])).filter(Boolean);
    const t = parts.join(', ');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) + '.' : '';
}

// ── the review (design 5.3, step 5) ──
export function reviewItems(steps, { shortAddr } = {}) {
    return steps.map((s) => {
        if (s.kind === 'bond') return { kind: s.kind, call: 'staking.bond', text: `Bond ${pdex(s.value)} PDEX, rewards: ${payeeText(s.payee, shortAddr)}` };
        if (s.kind === 'bondExtra') return { kind: s.kind, call: 'staking.bondExtra', text: `Add ${pdex(s.value)} PDEX to the bond` };
        if (s.kind === 'setKeys') return { kind: s.kind, call: 'session.setKeys', text: `Register ${s.count} session keys` };
        return { kind: s.kind, call: 'staking.validate', text: `Ask to validate at ${perbillToPercent(s.commission)} commission` };
    });
}
export function atomicText(n) {
    return n > 1 ? 'One signature. If any step fails, none of them apply.' : 'One signature.';
}

// Design 4.5. The offline numbers are the im-online formula with 200 seats
// (lib/nomination-status.js offlineSlashThreshold).
export const SETUP_WARNINGS = Object.freeze([
    'Bonded PDEX takes 28 days to unbond.',
    'If your node is offline for a whole session you earn nothing for it. If 22 or more of 200 validators are offline in the same session, everyone offline is slashed from 0.1% up to 7%.',
    'Two nodes running with the same keys are slashed. Never copy a keystore.',
    'Slashes also hit the people who nominate you.'
]);
// Finding 8: the same lines with the unbonding time ({D}, lib/validator-setup-steps.js
// unbondDays) and the offline threshold of the live validator count; the
// figures of today when either is unknown.
export function setupWarnings({ unbond = null, validatorCount = null } = {}) {
    const n = Number(validatorCount);
    const out = SETUP_WARNINGS.slice();
    if (unbond) out[0] = `Bonded PDEX takes ${unbond} to unbond.`;
    if (Number.isInteger(n) && n > 0) {
        out[1] = `If your node is offline for a whole session you earn nothing for it. If ${offlineSlashThreshold(n) + 1} or more of ${n} validators are offline in the same session, everyone offline is slashed from 0.1% up to 7%.`;
    }
    return out;
}
export const SLASH_ACK = 'I understand that my bond can be slashed.';

// p: GET /api/validator/params. Keys apply from the session after next; a
// validate sent once the election has started waits one more era.
export function timingText(p = {}) {
    const sessionSeconds = p.epochDuration > 0 && p.blockTimeMs > 0 ? (p.epochDuration * p.blockTimeMs) / 1000 : null;
    const keys = sessionSeconds && p.sessionProgress != null
        ? `Keys are used from the session after next (${aboutDuration((1 - p.sessionProgress) * sessionSeconds + sessionSeconds)}).`
        : 'Keys are used from the session after next, between 4 and 8 hours from now.';
    const era = p.currentEra != null ? Number(p.currentEra) : p.activeEra != null ? Number(p.activeEra) : null;
    if (era == null || !Number.isFinite(era)) return keys;
    const started = p.electionPhase && p.electionPhase !== 'Off';
    return started
        ? `${keys} The election for era ${era + 1} has started, so the first era you can be elected for is era ${era + 2}.`
        : `${keys} The first era you can be elected for is era ${era + 1}.`;
}

// ── keys input ──
export function keysForSetup(text, { layout, specVersion = null } = {}) {
    if (!layout) return { ok: false, message: layoutMismatchText(specVersion) };
    const r = parseSessionKeys(text, { layout, specVersion });
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, keys: r.keys, keysHex: '0x' + r.keys.map(k => k.hex.slice(2)).join(''), warnings: r.warnings };
}

// ── after inclusion: does the chain show every planned step? ──
// bondShort: less was bonded than was asked for (bond clamps silently when the
// balance fell between the sign-time read and inclusion). The amount bonded
// is the staking.Bonded event's (bondedEvent, from the inclusion) when it is
// in hand. Without it, only a first bond reads the ledger (nothing was bonded
// before, so the ledger is the amount); a bondExtra makes no claim, because
// the ledger's gain since the review also moves with a slash or a rebond
// in between (Sprint 7: a slash showed a false "Bonded X of Y").
export function setupApplied(after, review, { bondedEvent = null } = {}) {
    const missing = [];
    let bondShort = null;
    for (const s of review.steps || []) {
        if (s.kind === 'bond' || s.kind === 'bondExtra') {
            if (!after.bonded) { missing.push('bond'); continue; }
            const fresh = !(review.state && review.state.bonded);
            const requested = big(s.value != null ? s.value : (s.kind === 'bond' ? review.bond : review.extra));
            const bonded = bondedEvent != null ? big(bondedEvent) : fresh ? big(after.active) : null;
            if (bonded != null && requested > 0n && bonded < requested) bondShort = { bonded: bonded > 0n ? bonded : 0n, requested };
        }
        else if (s.kind === 'setKeys' && keysBlob(after.nextKeys, s.names) !== s.keysHex) missing.push('keys');
        else if (s.kind === 'validate' && !after.validating) missing.push('validate');
    }
    const out = { applied: missing.length === 0, missing };
    if (bondShort) out.bondShort = bondShort;
    return out;
}

export function bondShortText(short, { validating = false } = {}) {
    return `Bonded ${pdex(short.bonded)} PDEX of the ${pdex(short.requested)} PDEX you asked for. The balance changed before the block.`
        + (validating ? ' Your validator entry is set with the smaller bond.' : '')
        + ' To add the rest, bond more from this stash.';
}

export const minBondChangedText = (min) => `The minimum bond changed since you reviewed this: it is now ${pdex(min)} PDEX. Go back to Bond and enter a new amount.`;
// Keys on chain that are not the ones reviewed (SW-53 of the separate-steps
// spec), also used when a "keep them" review finds them changed (finding 3).
export const KEYS_CHANGED_TEXT = 'The session keys registered to this stash are not the ones you reviewed. Nothing was signed. Go back to Session keys and choose which keys to use.';
const sameKeys = (a, b) => !!a && !!b && JSON.stringify(Object.keys(a).sort().map(k => [k, String(a[k]).toLowerCase()])) === JSON.stringify(Object.keys(b).sort().map(k => [k, String(b[k]).toLowerCase()]));

// ── sign time (design 4.6): everything read again right before buildTx returns ──
// fresh = { limits, state, balance, ed, fee, owners (readKeyOwners) }.
export function signTimeProblems(fresh, review) {
    const L = fresh.limits || {};
    if (L.minValidatorBond == null || L.minCommission == null) return ['The explorer could not read the minimum bond and commission again before signing. Try again.'];
    const was = review.state || {}, now = fresh.state || {};
    if (!!now.bonded !== !!was.bonded || !!now.validating !== !!was.validating || (now.controller || null) !== (was.controller || null) || controllerRefusal(now)) {
        return ['This account\'s staking state changed since you reviewed this. Start the setup again.'];
    }
    const out = [];
    const steps = review.steps || [];
    const has = (k) => steps.some(s => s.kind === k);
    const setKeys = steps.find(s => s.kind === 'setKeys');
    if (setKeys) {
        const lay = L.layout;
        const reparsed = lay && lay.ok && lay.layout ? parseSessionKeys(setKeys.keysHex, { layout: lay.layout }) : null;
        if (!reparsed || !reparsed.ok || lay.hexLength !== setKeys.keysHex.length) {
            out.push('The session key format changed since you reviewed this. Generate new keys on your node and paste them again.');
        } else if (fresh.owners) {
            const c = classifyKeyOwners(reparsed.keys, { ...fresh.owners, stash: review.stash });
            const other = c.rows.find(r => r.result === 'other');
            if (other) out.push(other.message);
        }
    }
    // Finding 3: "Keep them" has no setKeys step, so validate would go through
    // with whatever keys are registered at inclusion: they must still be the
    // ones the review kept, and present.
    if (has('validate') && !setKeys && !sameKeys(now.nextKeys, was.nextKeys)) out.push(KEYS_CHANGED_TEXT);
    const added = was.bonded ? big(review.extra) : big(review.bond);
    if (has('validate')) {
        const total = (was.bonded ? big(now.active) : 0n) + added;
        if (total < big(L.minValidatorBond)) out.push(minBondChangedText(L.minValidatorBond));
        if (Number(review.commission) < Number(L.minCommission)) out.push(`The minimum commission changed since you reviewed this: it is now ${perbillToPercent(L.minCommission)}. Go back to Commission and enter a new rate.`);
        if (!now.validating && L.maxValidatorsCount != null && L.counterForValidators != null && Number(L.counterForValidators) >= Number(L.maxValidatorsCount)) {
            out.push(`The chain has reached its limit of ${L.maxValidatorsCount} validator candidates. Nobody can start validating until one leaves or governance raises the limit.`);
        }
    }
    if (added > 0n && fresh.balance) {
        const noFees = fresh.reserve != null && big(fresh.reserve) === 0n;
        const max = maxBondable({ ...fresh.balance, ed: fresh.ed, fee: fresh.fee, ...(fresh.reserve != null ? { reserve: fresh.reserve } : {}) });
        if (added > max) out.push('Your balance changed since you reviewed this. ' + clampText(max, { noFees }));
    }
    return out;
}
