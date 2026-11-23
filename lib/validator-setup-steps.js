// Validator setup in separate steps (the fallback for a wallet or device that
// cannot sign one utility.batchAll): the order, the frozen plan, the gate run
// before every signature and the state table. Pure; the chain reads are in
// lib/validator-setup-chain.js (buildStepwisePlan, readStepwiseFresh,
// buildCheckedSetupStepTx) and the page in lib/validator-setup-steps-view.js.
// Spec: cto-team/plans/2026-11-20-validator-setup-three-step-fallback.md.
// Tested in test/validator-setup-steps.test.js against the spec 394 codecs.
//
// Order: session.setKeys, then staking.bond (or bondExtra), then
// staking.validate. setKeys works before the stash is bonded because the
// session ValidatorIdOf is ConvertInto (polkadex-node mainnet runtime, spec
// 394: `type ValidatorIdOf = sp_runtime::traits::ConvertInto;`, and
// `type KeyDeposit = ();`). If that ever changes, flip stepwiseOrder.
//
// The next step comes from the chain (planSetup on a fresh read), never from a
// counter. The one exception is bondExtra, which the chain alone cannot show
// as done: it is dropped once this visit's Bonded event is in hand or the
// ledger grew by the extra since the plan, and is never offered twice.

import { formatPlanck } from './call-args-format.js';
import { FEE_MARGIN, feeShortfall, feeShortText } from './fee-preflight.js';
import { planSetup, controllerRefusal, maxBondable, clampText, signTimeProblems, pauseProblems, reviewItems,
    setupSummary, minBondChangedText, KEYS_CHANGED_TEXT, bondShortText } from './validator-setup.js';

const big = (x) => { try { return x == null || x === '' ? 0n : BigInt(String(x)); } catch (e) { return 0n; } };
const pdex = (v) => formatPlanck(big(v)) ?? '0';

export const STEPWISE_ACTION = 'validator.setupStep';
const ORDER = { setKeys: 0, bond: 1, bondExtra: 1, validate: 2 };
const CALL_NAMES = { bond: ['Staking', 'bond'], bondExtra: ['Staking', 'bond_extra'], setKeys: ['Session', 'set_keys'], validate: ['Staking', 'validate'] };

// ── strings (section 4 of the spec, verbatim) ──
export const STEP_WORDS = Object.freeze({
    waiting: 'Waiting', ready: 'Ready to sign', wallet: 'Waiting for your wallet', sent: 'Sent, waiting for a block',
    checking: 'Checking the chain', done: 'Done on chain', notSigned: 'Not signed', failed: 'Failed on chain',
    notConfirmed: 'Not confirmed', blocked: 'Blocked'
});
const doneLine = (k) => (k <= 1 ? '' : k === 2 ? 'Step 1 stays on chain.' : `Steps 1 to ${k - 1} stay on chain.`);
const withLine = (t, line) => (line ? `${t} ${line}` : t);
export const SW = Object.freeze({
    entry: 'Sign in separate steps',
    entryNote: 'For a wallet or hardware device that cannot sign all the steps as one transaction. Each step is then its own transaction with its own fee.',
    afterAttempt: 'If your wallet or device cannot sign this as one transaction, use Sign in separate steps below.',
    multisig: 'Separate steps are not offered for a multisig stash, because each step would need its own round of approvals. The multisig signs the setup as one transaction.',
    resume: (n) => `This setup was started earlier. ${n} of its steps are left.`,
    heading: 'Sign in separate steps',
    stashLine: (a) => `Stash: ${a}. Every step is signed by this account.`,
    intro: (n, f) => (n > 1
        ? `Your wallet will ask you ${n} times, once for each step below. Each step is a separate transaction and pays its own network fee, about ${pdex(f)} PDEX in total.`
        : `Your wallet will ask you once, for the step below. Estimated network fee: ${pdex(f)} PDEX.`),
    panelTitle: 'This is not all-or-nothing',
    panelStay: 'Steps you have signed stay on chain even if a later step fails or you stop.',
    panelKeys: 'After the keys step alone, nothing is locked. Stopping there costs only that step\'s fee.',
    panelBond: (a, d) => `After the bond step, ${pdex(a)} PDEX is bonded and earns nothing until the last step is confirmed. Getting bonded PDEX back takes ${d}.`,
    panelReturn: 'You can close this page and come back. The explorer reads the chain and continues from the first step that is missing. You will enter the commission again.',
    sign: (k, n) => `Sign step ${k} of ${n}`,
    back: 'Back to the review',
    checkAgain: 'Check again',
    addBond: 'Add to the bond',
    addRest: 'Add the rest first',
    ready: (text) => `Nothing has been signed yet. Step 1 is next: ${text}.`,
    // SW-41 (revision 2026-11-21): the table stays above the status line.
    keysHint: 'Your device may show the keys as six separate values over several screens. Compare the first and last characters of each with the keys table above before you approve.',
    nextAfter: (k, b, text) => `Step ${k} is confirmed in block #${b}. Step ${k + 1} is next: ${text}.`,
    // Not in the spec: SW-42 when no block number is known (confirmed by Check again).
    nextAfterNoBlock: (k, text) => `Step ${k} is confirmed on chain. Step ${k + 1} is next: ${text}.`,
    checking: (k) => `Step ${k} is in a block. Checking the chain before the next step.`,
    notSigned: (k) => withLine(`Step ${k} was not signed, so nothing changed and no fee was charged.`, doneLine(k)) + ' Press the button when you are ready.',
    failedOnChain: (k, reason) => withLine(`Step ${k} was included but the chain refused it: ${String(reason || '').trim()} Its fee was charged and nothing else changed.`, doneLine(k)),
    notConfirmed: (k) => `The explorer could not confirm step ${k}. It may still go through. Do not sign it again yet. Press Check again to read the chain.`,
    // SW-46a: added to SW-46 when Check again finds a top-up still not on chain. Top-up only.
    stillNotOnChain: 'Still not on chain. If it does not appear in about 15 minutes it was not included. Reload this page; the setup continues from the chain.',
    // SW-46b: setKeys, bond or validate sent this visit, still not on chain after Check again, Sign back.
    sentNotOnChain: (k) => `Step ${k} was sent but is still not on chain. You can sign it again. If the first one is still waiting for a block, the explorer stops before your wallet opens and nothing is signed. A second copy cannot bond twice; at worst it costs one more fee.`,
    // SW-59: the pool still holds a transaction from the stash; both signing paths.
    pending: 'Another transaction from this account is still waiting for a block. Nothing was signed. Wait for it to be included, then try again.',
    // SW-06: the review after Back dropped a top-up sent with no verdict.
    topUpUnconfirmed: (e) => `Your top-up of ${pdex(e)} PDEX was sent but the explorer could not confirm it. It may still be included in a block, so this review leaves it out rather than send it twice. To check, reload this page in about 15 minutes: the Stash and bond step shows the bonded amount. If it has not gone up, the top-up was not included and you can add it again there.`,
    // SW-08 (final review): the one-signature review when submitting throws or rejects after broadcast.
    sentUnconfirmed: 'Your setup was sent but the explorer could not confirm it. It may still be included in a block. Do not sign it again yet. Reload this page in a minute; the setup continues from the chain.',
    // SW-07: the one-signature review when submitting throws or rejects before broadcast.
    notStarted: 'The explorer could not start the signature, so nothing was signed and no fee was charged. Check that your wallet is unlocked and this account is selected, then press Sign and submit again.',
    notShown: (k, what) => `Step ${k} went through, but the chain does not show ${what} for this stash yet. It can take a block.`,
    shortCanContinue: (x, a, total, m) => `Bonded ${pdex(x)} PDEX of the ${pdex(a)} PDEX you reviewed. The balance changed before the block. ${pdex(total)} PDEX is above the minimum of ${pdex(m)} PDEX, so you can sign the last step now or add the rest first.`,
    shortBlocked: (x, a, m, need) => `Bonded ${pdex(x)} PDEX of the ${pdex(a)} PDEX you reviewed. The balance changed before the block. Validating needs at least ${pdex(m)} PDEX bonded, so the last step would fail. Add at least ${pdex(need)} PDEX to the bond first.`,
    feeShort: (k, shortText, bonded) => `Step ${k} cannot be paid for yet. ${shortText} Then press Check again.` + (bonded != null ? ` Your bond of ${pdex(bonded)} PDEX is not affected and stays bonded meanwhile.` : ''),
    feesTooHigh: (f, max) => `Signing in separate steps costs about ${pdex(f)} PDEX in network fees, so the most you can bond is ${pdex(max)} PDEX. Lower the amount or add PDEX to this stash.`,
    runtimeChanged: (was, now) => `The network was upgraded while you were between steps (spec ${was}, now ${now}). Nothing was signed. Steps already confirmed stay on chain. Go back to the review so the remaining steps are checked against the new rules.`,
    keysDiffer: KEYS_CHANGED_TEXT,
    alreadyOnChain: 'The chain already shows this step, so nothing was signed.',
    callDiffers: 'This step no longer matches what you reviewed, so nothing was signed. Go back to the review.',
    walletChanged: (short) => `Your wallet changed, so the setup in separate steps was stopped. Steps already confirmed stay on chain. Connect the stash ${short} again to continue from where it stopped.`,
    done: (n) => `All ${n} steps are confirmed. This stash is bonded, its keys are registered and it is asking to validate. You are now waiting for election.`,
    doneShort: (n, short) => `All ${n} steps are confirmed. ${bondShortText(short, { validating: true })}`,
    stopNothing: 'If you stop here: nothing has changed.',
    stopKeys: 'If you stop here: your keys stay registered to this stash and nothing is locked. Keys on an account that does not validate do nothing. If you later use this node with a different stash, generate new keys on the node first.',
    stopBonded: (x, d) => `If you stop here: ${pdex(x)} PDEX stays bonded and earns nothing. To finish, come back and sign the remaining step. To get it back, use Unstake on your wallet page: unbonding takes ${d}, then you withdraw it.`,
    // SW-64 and SW-65: a nominating stash once a step is confirmed this visit.
    stopNominating: (x) => `If you stop here: your keys stay registered to this stash. Your bond of ${pdex(x)} PDEX is untouched and keeps nominating, and nothing new is locked. Keys on an account that does not validate do nothing. If you later use this node with a different stash, generate new keys on the node first.`,
    stopNominatingToppedUp: (x, e, d) => `If you stop here: your keys stay registered to this stash and your bond, now ${pdex(x)} PDEX with the ${pdex(e)} PDEX you added, keeps nominating. To get the added PDEX back, use Unstake on your wallet page: unbonding takes ${d}, then you withdraw it.`,
    walletLink: 'Open your wallet page',
    cardPending: (k, n) => `Setting up your validator, step ${k} of ${n}`,
    help: 'If your wallet or hardware device cannot sign the setup as one transaction, the review offers Sign in separate steps. The keys are registered first, then the bond, then the request to validate. Each is its own transaction with its own fee, and each stays on chain if a later one fails. A multisig stash and a proxy cannot use it.'
});

// ── order and plan ──
export function stepwiseOrder(steps) {
    return (steps || []).map((s, i) => [s, i]).sort((a, b) => (ORDER[a[0].kind] - ORDER[b[0].kind]) || (a[1] - b[1])).map(x => x[0]);
}

const keysBlob = (map, names) => (map && names && names.length && names.every(n => map[n])
    ? '0x' + names.map(n => String(map[n]).toLowerCase().replace(/^0x/, '')).join('') : null);

// review: the wizard's review (lib/validator-setup-view.js toReview).
// calls and fees: by step kind (hex of the bare call, paymentInfo partialFee or null).
// baseActive: Ledger.active read when the plan is built, the baseline for a
// bondExtra that the ledger shows done (review finding 8); else the review's.
export function stepwisePlan({ review, calls = {}, fees = {}, spec = {}, revision = null, keyDeposit = 0n, keyNames = [], baseActive = null }) {
    const steps = stepwiseOrder(review.steps).map(s => Object.freeze({ ...s }));
    const payee = review.payee || ((review.steps || []).find(s => s.kind === 'bond') || {}).payee || { kind: 'staked', account: '' };
    const input = Object.freeze({ bond: big(review.bond), extra: big(review.extra), payee, keys: review.keys || null, keysHex: review.keysHex || '', commission: Number(review.commission) });
    return Object.freeze({
        stash: String(review.stash), steps: Object.freeze(steps),
        callHex: Object.freeze(steps.map(s => String(calls[s.kind] || ''))),
        fees: Object.freeze(steps.map(s => (fees[s.kind] == null ? null : big(fees[s.kind])))),
        bond: input.bond, extra: input.extra, payee, commission: input.commission,
        keys: review.keys || null, keysHex: review.keysHex ? String(review.keysHex).toLowerCase() : '',
        keptKeysHex: keysBlob(review.state && review.state.nextKeys, keyNames),
        keyNames: Object.freeze([...keyNames]),
        spec: Object.freeze({ specVersion: spec.specVersion == null ? null : Number(spec.specVersion), transactionVersion: spec.transactionVersion == null ? null : Number(spec.transactionVersion) }),
        revision, keyDeposit: big(keyDeposit), state: review.state || {}, limits: review.limits || {}, input,
        baseActive: baseActive == null ? big((review.state || {}).active) : big(baseActive)
    });
}

const feeOr = (f) => (f == null ? FEE_MARGIN : big(f));
export function stepwiseTotalFee(plan) {
    return plan.fees.reduce((t, f) => t + feeOr(f), 0n) + (plan.steps.some(s => s.kind === 'setKeys') ? big(plan.keyDeposit) : 0n);
}
const kIndex = (plan, kind) => plan.steps.findIndex(s => s.kind === kind) + 1;
export const stepPausableCalls = (step) => (step && CALL_NAMES[step.kind] ? [CALL_NAMES[step.kind]] : []);
export const stepText = (step, shortAddr) => reviewItems([step], { shortAddr })[0].text;

// ── the gate (section 3.1) ──
// fresh: { state, limits, pauses, owners, fees: { kind: fee|null }, spec, keyDeposit }.
// ctx: { bondedEvent: this visit's Bonded amount for a bond step, extraSent:
// a bondExtra was broadcast this visit with no definite failure, justDone: the
// kind whose inclusion was just reported clean }.
export function stepwiseGate(fresh, plan, ctx = {}) {
    const out = (o) => ({ remaining: [], next: null, k: null, done: false, block: null, blockId: null, notice: null, noticeId: null,
        unconfirmed: false, retry: false, addBond: null, short: null, extraDropped: false, ...o });
    const now = fresh.state || {}, L = fresh.limits || {};
    // A fee read now, else the plan's; null when neither is known.
    const fee = (kind) => {
        const f = fresh.fees && Object.prototype.hasOwnProperty.call(fresh.fees, kind) ? fresh.fees[kind] : plan.fees[kIndex(plan, kind) - 1];
        return f == null ? null : big(f);
    };
    const keyDeposit = fresh.keyDeposit == null ? big(plan.keyDeposit) : big(fresh.keyDeposit);
    // 1. runtime
    const sp = fresh.spec || {};
    if (Number(sp.specVersion) !== plan.spec.specVersion || Number(sp.transactionVersion) !== plan.spec.transactionVersion) {
        return out({ block: SW.runtimeChanged(plan.spec.specVersion, sp.specVersion), blockId: 'SW-52' });
    }
    // 2. controller
    const refusal = controllerRefusal(now);
    if (refusal) return out({ block: refusal, blockId: 'controller' });
    // 3. remaining, every one in the plan; keys on chain as planned or kept
    const p = planSetup(now, plan.input);
    if (p.refusal) return out({ block: SW.keysDiffer, blockId: 'SW-53' });
    let remaining = stepwiseOrder(p.steps);
    if (remaining.some(s => kIndex(plan, s.kind) === 0)) return out({ block: SW.callDiffers, blockId: 'SW-55' });
    const chainKeys = keysBlob(now.nextKeys, plan.keyNames);
    if (chainKeys && chainKeys !== plan.keysHex && chainKeys !== plan.keptKeysHex) return out({ block: SW.keysDiffer, blockId: 'SW-53' });
    // 4. the silent clamp, and bondExtra done
    const min = big(L.minValidatorBond);
    const validateLeft = () => remaining.some(s => s.kind === 'validate');
    let notice = null, noticeId = null, addBond = null, short = null, block = null, blockId = null, extraDropped = false;
    const shortCheck = (x, a, total) => {
        if (x >= a) return;
        short = { bonded: x, requested: a };
        if (!validateLeft()) return;
        if (total >= min) { notice = SW.shortCanContinue(x, a, total, min); noticeId = 'SW-48'; addBond = a - x; }
        else { block = SW.shortBlocked(x, a, min, min - total); blockId = 'SW-49'; addBond = min - total; }
    };
    if (plan.steps.some(s => s.kind === 'bond') && now.bonded) shortCheck(big(now.active), plan.bond, big(now.active));
    if (remaining.some(s => s.kind === 'bondExtra')) {
        // The baseline is the ledger when the plan was built (finding 8), not the wizard load.
        const base = plan.baseActive != null ? big(plan.baseActive) : big(plan.state.active);
        const grew = big(now.active) >= base + plan.extra;
        if (ctx.bondedEvent != null || grew) { remaining = remaining.filter(s => s.kind !== 'bondExtra'); extraDropped = true; }
        else if (ctx.extraSent) return out({ remaining, unconfirmed: true, k: kIndex(plan, 'bondExtra') });
        if (ctx.bondedEvent != null) shortCheck(big(ctx.bondedEvent), plan.extra, big(now.active));
    }
    if (block) return out({ remaining, next: remaining[0] || null, k: remaining[0] ? kIndex(plan, remaining[0].kind) : null, block, blockId, addBond, short, retry: false, extraDropped });
    // the step just reported clean is not on chain yet
    if (ctx.justDone && remaining.some(s => s.kind === ctx.justDone)) {
        const what = { setKeys: 'these keys', bond: 'the bond', bondExtra: 'the bond', validate: 'the validator entry' }[ctx.justDone];
        return out({ remaining, next: null, k: kIndex(plan, ctx.justDone), block: SW.notShown(kIndex(plan, ctx.justDone), what), blockId: 'SW-47', retry: true, extraDropped });
    }
    // 5. done
    if (!remaining.length) {
        const keysOk = chainKeys && (chainKeys === plan.keysHex || chainKeys === plan.keptKeysHex);
        if (now.validating && keysOk) return out({ done: true, short, extraDropped });
        return out({ block: SW.keysDiffer, blockId: 'SW-53' });
    }
    const next = remaining[0], k = kIndex(plan, next.kind);
    const res = (o) => out({ remaining, next, k, notice, noticeId, addBond, short, extraDropped, ...o });
    const bal = now.balance || {};
    const bondedNow = now.bonded ? big(now.active) : null;
    const payable = (f, deposit = 0n) => (f == null ? null : feeShortfall({ fee: f, deposit, free: bal.free, reserved: bal.reserved, frozen: bal.frozen, ed: now.ed }));
    const oneStep = (steps, extra = {}) => signTimeProblems({ limits: L, state: now, owners: fresh.owners || null, balance: null }, { stash: plan.stash, steps, state: now, commission: plan.commission, bond: 0n, extra: 0n, ...extra });
    // 6. setKeys
    if (next.kind === 'setKeys') {
        const probs = oneStep([next]);
        if (probs.length) return res({ block: probs[0], blockId: 'limits' });
        const s = payable(fee('setKeys'), keyDeposit);
        if (s) return res({ block: SW.feeShort(k, feeShortText(s), bondedNow), blockId: 'SW-50', retry: true });
        const bondStep = remaining.find(x => x.kind === 'bond' || x.kind === 'bondExtra');
        if (bondStep) {
            const total = feeOr(fee('setKeys')) + feeOr(fee(bondStep.kind)) + (validateLeft() ? feeOr(fee('validate')) : 0n) + keyDeposit;
            const max = maxBondable({ ...bal, ed: now.ed, fee: total });
            if (big(bondStep.value) > max) return res({ block: SW.feesTooHigh(total, max), blockId: 'SW-51', max });
        }
    }
    // 7. bond or bondExtra: what fits now, and the validate rules it is for
    if (next.kind === 'bond' || next.kind === 'bondExtra') {
        const max = maxBondable({ ...bal, ed: now.ed, fee: feeOr(fee(next.kind)) + (validateLeft() ? feeOr(fee('validate')) : 0n) });
        if (big(next.value) > max) return res({ block: 'Your balance changed since you reviewed this. ' + clampText(max), blockId: 'clamp' });
        const total = (now.bonded ? big(now.active) : 0n) + big(next.value);
        if (L.minValidatorBond == null) return res({ block: 'The explorer could not read the minimum bond and commission again before signing. Try again.', blockId: 'limits' });
        if (validateLeft() && total < min) return res({ block: minBondChangedText(min), blockId: 'limits' });
        if (validateLeft()) {
            // The validate rules this bond is for, checked before money is locked
            // (the bond itself is checked against the minimum just above).
            const probs = oneStep([{ kind: 'validate', commission: plan.commission, blocked: false }])
                .filter(t => t !== minBondChangedText(L.minValidatorBond) && t !== KEYS_CHANGED_TEXT);
            if (probs.length) return res({ block: probs[0], blockId: 'limits' });
        }
    }
    // 8. validate
    if (next.kind === 'validate') {
        const probs = oneStep([next]).filter(t => t !== KEYS_CHANGED_TEXT);
        if (probs.length) return res({ block: probs[0], blockId: 'limits' });
        if (!chainKeys) return res({ block: SW.keysDiffer, blockId: 'SW-53' });
        const s = payable(fee('validate'));
        if (s) return res({ block: SW.feeShort(k, feeShortText(s), bondedNow), blockId: 'SW-50', retry: true });
    }
    // 9. safe mode, a paused bare call
    const pz = fresh.pauses || {};
    const name = CALL_NAMES[next.kind].join('.');
    const paused = pauseProblems({ safeModeUntil: pz.safeModeUntil, paused: (pz.paused || []).filter(c => c === name) });
    if (paused.length) return res({ block: paused[0], blockId: 'pause', retry: true });
    return res({});
}

// ── the state table (section 3.3) ──
const SIGNABLE = ['S0', 'S4', 'S5', 'S9'];
const IDLE = ['S0', 'S4', 'S5', 'S6', 'S8', 'S9'];
const ALL = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
export const STEPWISE_TRANSITIONS = Object.freeze([
    [['review'], 'open', 'S0'], [['review'], 'openBlocked', 'S8'],
    [SIGNABLE, 'sign', 'S1'], [SIGNABLE, 'refused', 'S8'],
    [['S1'], 'refused', 'S8'], [['S1'], 'sent', 'S2'], [['S1'], 'notSigned', 'S5'],
    [['S2'], 'included', 'S3'], [['S2'], 'failedOnChain', 'S6'], [['S2'], 'noVerdict', 'S7'], [['S2'], 'verified', 'S3'],
    [['S3'], 'gateNext', 'S4'], [['S3'], 'gateShort', 'S9'], [['S3'], 'gateNotShown', 'S8'], [['S3'], 'gateBlock', 'S8'],
    [['S3'], 'gateDone', 'S10'], [['S3'], 'gateUnconfirmed', 'S7'],
    // S6 shows the gate's verdict in place: Sign only when it allows.
    [['S6'], 'gateNext', 'S6'],
    [['S6', 'S7', 'S8'], 'checkAgain', 'S3'],
    [IDLE, 'back', 'review'],
    [['S8', 'S9'], 'addBond', 'bond'],
    [ALL, 'walletChanged', 'remount']
]);
export function stepwiseNext(from, event) {
    const row = STEPWISE_TRANSITIONS.find(([f, e]) => e === event && f.includes(from));
    return row ? row[2] : null;
}

// What the tracker's callbacks mean for the state table. kind 'error'
// (onError's model) or 'stage' (onStage's stage and model). sent: a broadcast
// was seen for this attempt. Before broadcast, an explorer guard or the fee
// preflight ('preflight') blocks; anything else (cancel, wallet error, pool
// refusal of the signature, silent wallet) is "not signed", except a lost link
// (net.*): the transaction may have reached a node before the first status, so
// it is "not confirmed" (review finding 3). After broadcast, only an error
// decoded from the chain is a failure on chain; a pool drop, a lost link or an
// unreported event is "not confirmed".
const ON_CHAIN_KEY = /^(?!pool\.|net\.|wallet\.|validator\.)[a-z][A-Za-z]*\.[A-Za-z]+$/;
export function stepOutcome(kind, m = {}, { sent = false } = {}) {
    if (kind === 'error') {
        const key = m && m.key;
        if (!sent) return key === 'preflight' ? 'refused' : /^net\./.test(String(key || '')) ? 'noVerdict' : 'notSigned';
        return key && ON_CHAIN_KEY.test(String(key)) ? 'failedOnChain' : 'noVerdict';
    }
    const stage = m && m.stage;
    if (stage === 'broadcast') return sent ? null : 'sent';
    if (stage === 'waiting') return sent ? 'noVerdict' : 'notSigned';
    if (stage === 'processed' || stage === 'unverified' || stage === 'unconfirmed' || stage === 'stalled') return 'noVerdict';
    return null;
}

// ── the per-step submit (section 3.4) ──
export function stepExpectEvents(kind) {
    if (kind === 'bond' || kind === 'bondExtra') return ['staking.Bonded'];
    if (kind === 'validate') return ['staking.ValidatorPrefsSet'];
    return [];
}
export function stepAction(plan, kind) {
    const k = kIndex(plan, kind), n = plan.steps.length;
    const step = plan.steps[k - 1];
    const params = { n: k, of: n, last: k === n, summary: setupSummary([step]), stash: plan.stash, expectEvents: stepExpectEvents(kind) };
    if (kind === 'bond' && plan.bond > 0n) params.bondRequested = String(plan.bond);
    if (kind === 'bondExtra' && plan.extra > 0n) params.bondRequested = String(plan.extra);
    return { key: STEPWISE_ACTION, params };
}

// "If you stop here", from the chain state first (section 6, review finding 7):
// a resume with the bond already on chain is SW-62 before anything is signed.
// A nominating stash earns from its nominations, so it never gets SW-62: once a
// step is confirmed this visit it gets SW-64, or SW-65 and the wallet link once
// this visit's top-up is confirmed (revision 2026-11-21); before that, SW-60.
// While this visit's top-up is sent and unconfirmed (v.extraUnconfirmed) a nominating stash gets no
// stop line: the spec has no line that is true whether or not the top-up lands (final review).
// v: { confirmedAny, toppedUp, extraUnconfirmed, extra (the Bonded event amount, else the plan's) }.
export function stopLine(plan, state, remaining, d, v = {}) {
    const st = state || {};
    if (st.bonded && !st.validating && Number(st.nominations) > 0) {
        if (v.extraUnconfirmed && !v.toppedUp) return null;
        if (v.toppedUp) return { text: SW.stopNominatingToppedUp(st.active, v.extra != null ? v.extra : plan.extra, d), link: true };
        const keysNow = plan.steps.some(s => s.kind === 'setKeys') && !!plan.keysHex && keysBlob(st.nextKeys, plan.keyNames) === plan.keysHex;
        if (v.confirmedAny || keysNow) return { text: SW.stopNominating(st.active) };
        return { text: SW.stopNothing };
    }
    if (st.bonded && !st.validating) return { text: SW.stopBonded(st.active, d), link: true };
    if (st.nextKeys && !st.bonded) return { text: SW.stopKeys };
    return { text: SW.stopNothing };
}

// {D}: the unbonding time, from the live BondingDuration and the era length.
export function unbondDays(bondingDuration, eraSeconds) {
    const n = Number(bondingDuration), s = Number(eraSeconds);
    if (!(n > 0) || !(s > 0)) return 'the chain\'s bonding duration';
    const days = Math.round((n * s) / 86400);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
}
