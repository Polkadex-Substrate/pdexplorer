// What the Stake PDEX card signs (design 2026-11-22-stake-card-simple-and-
// advanced.md, sections 9 and 10.1; CEO decisions 2026-11-23).
//
// planStakeCalls turns the card's state into the list of calls, and
// buildStakeTx builds exactly that list: the review and the transaction come
// from one source (rule M6). The plan holds a call only for what changed (M7):
// an existing staker who adds PDEX signs bondExtra alone and their validators
// are not re-sent.
//
// Two or more calls go in ONE utility.batchAll, never forceBatch (finding F1,
// approved 2026-11-23). batchAll is atomic: if nominate fails after bond, the
// whole transaction reverts, so PDEX is never left staked behind no validator.
// The 394 metadata's own doc for utility.batch_all: "Send a batch of dispatch
// calls and atomically execute them. The whole transaction will rollback and
// fail if any of the calls failed." A runtime without batchAll gets a refusal,
// not a silent fall back to a non-atomic batch.
//
// Amounts are BigInt planck throughout (rule M3, finding F2); the typed string
// is parsed, never rewritten (M4). Max leaves 1 PDEX (the existential deposit,
// already kept back by the keep-alive `transferable` figure) plus 0.2 PDEX for
// about ten later fees (decision Q4).
//
// The only import is lib/tx-status.js (itself import-free), for the existing
// controller message: runs in Node tests and in the browser.

import { ERROR_COPY } from './tx-status.js';

export const PLANCK_PER_PDEX = 10n ** 12n;
const DECIMALS = 12;
// 0.2 PDEX: about ten later fees (claim, unstake, withdraw), decision Q4.
export const STAKE_FEE_RESERVE_PLANCK = 2n * 10n ** 11n;
export const STAKE_VIEW_KEY = 'pdex_stake_view_v1';

// The card's strings that WP1 uses, by the spec's ids (section 7). WP2 adds
// the rest of the table here.
export const STAKE_COPY = Object.freeze({
    'SC-05': 'Max leaves 1 PDEX that must stay in the account and {reserve} PDEX for network fees.',
    'SC-50': 'Sign and stake',
    'SC-51': 'Sign and update validators',
    'SC-52': 'Sign and change rewards',
    'SC-53': 'Sign and update staking',
    'SC-55a': 'Enter an amount to continue.',
    'SC-55b': 'Nothing to sign yet. Change the amount, the validators or the rewards.',
    'SC-80a': 'Stake {amount} PDEX',
    'SC-80b': 'Add {amount} PDEX to your stake',
    'SC-80c': 'Choose {n} validators',
    'SC-80d': 'Replace your validators with these {n}',
    'SC-80e': 'Send rewards to {destination}',
    'SC-100': 'Enter an amount in PDEX, for example 250.',
    'SC-101': 'That is more than this account can stake. The most is {max} PDEX.',
    'SC-102': 'Use {max} PDEX',
    'SC-104': 'This leaves {left} PDEX free. You need free PDEX to pay the fee when you claim rewards or unstake.',
    'SC-105': 'The smallest first stake is {min} PDEX.',
    'SC-106': 'Enter an amount to stake.',
    'SC-107': 'Choose at least one validator.',
    'SC-108': 'You can choose up to {max} validators. Remove one to add another.',
    // Result card for an add-only stake (lib/tx-status.js 'staking.bondNominate').
    'SC-131': '{amount} PDEX added to your stake. Your validators are unchanged.',
    'SC-134': 'It starts earning from the next era (eras last {era}). Claim rewards with Pay Out on My Account.'
});

export function stakeCopy(id, params = {}) {
    const t = STAKE_COPY[id];
    if (t == null) throw new Error(`No stake card string ${id}.`);
    return t.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
}

const big = (x) => {
    if (typeof x === 'bigint') return x;
    if (x == null || x === '') return 0n;
    try { return BigInt(String(x)); } catch (e) { return 0n; }
};

// Exact planck to a PDEX string: "1.5", never "1.500000000000", never rounded.
export function planckToPdexText(planck) {
    const v = big(planck);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const whole = abs / PLANCK_PER_PDEX;
    const frac = abs % PLANCK_PER_PDEX;
    const f = frac === 0n ? '' : '.' + frac.toString().padStart(DECIMALS, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${f}`;
}

// A typed amount to planck, or null when it is not a plain decimal PDEX
// amount: digits, optionally a dot and at most 12 more digits. No sign, no
// exponent, no separators, and no silent truncation of a 13th decimal.
const AMOUNT = /^(\d+)(?:\.(\d{1,12}))?$/;
const AMOUNT_LEADING_DOT = /^\.(\d{1,12})$/;
export function parseAmountPlanck(typed) {
    const s = String(typed == null ? '' : typed).trim();
    let m = AMOUNT.exec(s);
    if (!m) { const d = AMOUNT_LEADING_DOT.exec(s); if (d) m = [s, '0', d[1]]; }
    if (!m) return null;
    return BigInt(m[1]) * PLANCK_PER_PDEX + BigInt((m[2] || '').padEnd(DECIMALS, '0') || '0');
}

// The server sends some figures as PDEX numbers. Rounded to a micro-PDEX in
// the safe direction: down for what the account has, up for a minimum.
export function pdexNumberToPlanck(n, mode = 'floor') {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return 0n;
    const micro = mode === 'ceil' ? Math.ceil(x * 1e6 - 1e-6) : Math.floor(x * 1e6);
    return BigInt(Math.max(0, micro)) * 10n ** 6n;
}

// What the account can stake on top of its stake, in planck: the server's
// keep-alive `transferable` (free minus the larger of frozen less reserved and
// the existential deposit; 0 when no fee can be paid). The route sends it as a
// PDEX number, so it is taken down to the micro-PDEX.
export function transferablePlanckOf(balance) {
    return balance ? pdexNumberToPlanck(balance.transferable, 'floor') : 0n;
}

// Max = transferable minus the fee reserve, never below zero (M3).
export function stakeMaxPlanck({ transferablePlanck, feeReservePlanck = STAKE_FEE_RESERVE_PLANCK }) {
    const t = big(transferablePlanck), r = big(feeReservePlanck);
    return t > r ? t - r : 0n;
}

// The amount check (design 10.1). Never returns a corrected string: the field
// keeps what was typed (M4).
//   empty        nothing typed (or 0 where the amount is optional)
//   invalid      not a plain PDEX amount, or 0 where an amount is required
//   over         more than the account can stake and still pay this fee
//   below-min    a first stake under the chain's minimum
//   low-reserve  payable, but above Max: less than the reserve stays free
//   ok
export function stakeAmountCheck({ typed, transferablePlanck, feeReservePlanck = STAKE_FEE_RESERVE_PLANCK, feeFloorPlanck = 0n, minStakePlanck = 0n, hasBond = false, optional = false }) {
    const transferable = big(transferablePlanck);
    const maxPlanck = stakeMaxPlanck({ transferablePlanck: transferable, feeReservePlanck });
    const minPlanck = big(minStakePlanck);
    const out = (code, planck = null) => ({ code, planck, maxPlanck, minPlanck,
        leftPlanck: planck == null ? null : (transferable > planck ? transferable - planck : 0n) });
    const s = String(typed == null ? '' : typed).trim();
    if (s === '') return out('empty');
    const planck = parseAmountPlanck(s);
    if (planck == null) return out('invalid');
    if (planck === 0n) return out(optional ? 'empty' : 'invalid', 0n);
    if (planck + big(feeFloorPlanck) > transferable) return out('over', planck);
    if (!hasBond && minPlanck > 0n && planck < minPlanck) return out('below-min', planck);
    if (planck > maxPlanck) return out('low-reserve', planck);
    return out('ok', planck);
}

// The message the existing modal shows for a check, or null (ok, low-reserve,
// and an empty optional amount sign as they are; the amber SC-104 line for
// low-reserve is rendered by the simple view, WP2).
export function stakeAmountMessage(check, { optional = false } = {}) {
    if (!check) return null;
    if (check.code === 'invalid') return stakeCopy('SC-100');
    if (check.code === 'over') return stakeCopy('SC-101', { max: planckToPdexText(check.maxPlanck) });
    if (check.code === 'below-min') return stakeCopy('SC-105', { min: planckToPdexText(check.minPlanck) });
    if (check.code === 'empty' && !optional) return stakeCopy('SC-106');
    return null;
}

// Rewards destinations: { kind: 'staked' | 'stash' | 'account', account }.
// 'current' (or null) means "leave it as it is".
const PAYEE_KINDS = new Set(['staked', 'stash', 'account']);
function normPayee(p) {
    if (p == null || p === 'current') return null;
    const kind = typeof p === 'string' ? p : p.kind;
    if (!PAYEE_KINDS.has(kind)) return null;
    return kind === 'account' ? { kind, account: String((p && p.account) || '') } : { kind };
}
// The {destination} of SC-80e: words from the spec's own strings ("your
// stake", SC-80b and SC-14; "this account", SC-14b) or the address itself.
function destinationText(p) {
    if (p.kind === 'staked') return 'your stake';
    if (p.kind === 'stash') return 'this account';
    return p.account;
}
const samePayee = (a, b, same) => !!a && !!b && a.kind === b.kind && (a.kind !== 'account' || same(a.account, b.account));

export function payeeArg(p) {
    const n = normPayee(p);
    if (!n) throw new Error('Rewards destination is not set.');
    if (n.kind === 'staked') return 'Staked';
    if (n.kind === 'stash') return 'Stash';
    if (!n.account) throw new Error('Rewards to another account need that account\'s address.');
    return { Account: n.account };
}

function sameSet(a, b, same) {
    if (a.length !== b.length) return false;
    return a.every(x => b.some(y => same(x, y))) && b.every(y => a.some(x => same(x, y)));
}

// The plan (design 10.1). Order: bond or bondExtra, setPayee, nominate.
//   hasBond         the account already has a stake
//   amountPlanck    BigInt, 0n or null for none
//   currentTargets  the validators nominated on chain now
//   targets         the selection
//   currentPayee    where rewards go now (null when unknown)
//   payee           where they should go; 'current' or null leaves it
//   maxTargets      the chain's nominations quota
//   same            address comparison (SS58 prefixes differ), default ===
//   controllerDiffers  the stash's controller is another account: nominate
//                   and setPayee must be signed by the controller (394
//                   metadata), so a plan holding either is refused here
//                   rather than failing NotController on chain for a fee
// hasBond null means the stake could not be read: bond would fail with
// AlreadyBonded on a staked account and bondExtra with NotStash on an
// unstaked one, each for a fee, so nothing is planned (problem
// 'bonded-unknown').
// Returns { calls, lines, primary, problems }. Any problem empties `calls`, so
// nothing is signed; empty calls means an inactive primary.
export function planStakeCalls({ hasBond = false, amountPlanck = null, currentTargets = [], targets = [], currentPayee = null, payee = 'current', maxTargets = null, same = (a, b) => a === b, controllerDiffers = false } = {}) {
    if (hasBond == null) return { calls: [], lines: [], primary: null, problems: ['bonded-unknown'] };
    const amount = big(amountPlanck);
    const cur = (currentTargets || []).map(String);
    const next = [];
    for (const t of targets || []) if (!next.some(x => same(x, String(t)))) next.push(String(t));
    const problems = [];
    const calls = [];
    const lines = [];
    const wantPayee = normPayee(payee);
    let nominateChanged;

    if (!hasBond) {
        if (amount <= 0n) problems.push('amount-required');
        const firstPayee = wantPayee || { kind: 'staked' };
        calls.push({ kind: 'bond', args: { value: amount.toString(), payee: firstPayee } });
        lines.push({ id: 'SC-80a', params: { amount: planckToPdexText(amount) } });
        nominateChanged = true;
    } else {
        if (amount > 0n) {
            calls.push({ kind: 'bondExtra', args: { value: amount.toString() } });
            lines.push({ id: 'SC-80b', params: { amount: planckToPdexText(amount) } });
        }
        if (wantPayee && !samePayee(wantPayee, normPayee(currentPayee), same)) {
            calls.push({ kind: 'setPayee', args: { payee: wantPayee } });
            lines.push({ id: 'SC-80e', params: { destination: destinationText(wantPayee) } });
        }
        nominateChanged = !sameSet(cur, next, same);
    }
    if (!next.length) problems.push('no-validators');
    if (maxTargets != null && Number(maxTargets) > 0 && next.length > Number(maxTargets)) problems.push('too-many');
    if (nominateChanged && next.length) {
        calls.push({ kind: 'nominate', args: { targets: next.slice() } });
        lines.push({ id: hasBond && cur.length ? 'SC-80d' : 'SC-80c', params: { n: next.length } });
    }
    if (controllerDiffers && calls.some(c => c.kind === 'nominate' || c.kind === 'setPayee')) problems.push('not-controller');
    if (problems.length) return { calls: [], lines: [], primary: null, problems };
    const kinds = new Set(calls.map(c => c.kind));
    let primary = null;
    if (kinds.has('bond') || kinds.has('bondExtra')) primary = 'SC-50';
    else if (kinds.size === 1 && kinds.has('nominate')) primary = 'SC-51';
    else if (kinds.size === 1 && kinds.has('setPayee')) primary = 'SC-52';
    else if (kinds.size > 1) primary = 'SC-53';
    return { calls, lines, primary, problems };
}

// Today's message when the account's data did not load (submitStakeTx); no
// existing string says the stake could not be read. SC-109 replaces it (WP2).
export const STAKE_NOT_LOADED = 'Wallet data is not loaded.';

// The message for a plan that cannot be signed, or for an empty one.
export function planProblemMessage(plan, { maxTargets = null } = {}) {
    const p = (plan && plan.problems) || [];
    if (p.includes('bonded-unknown')) return STAKE_NOT_LOADED;
    if (p.includes('not-controller')) return ERROR_COPY['staking.NotController'];
    if (p.includes('amount-required')) return stakeCopy('SC-106');
    if (p.includes('no-validators')) return stakeCopy('SC-107');
    if (p.includes('too-many')) return stakeCopy('SC-108', { max: maxTargets });
    if (!plan || !plan.calls || !plan.calls.length) return stakeCopy('SC-55b');
    return null;
}

// The success card's params (lib/tx-status.js 'staking.bondNominate') from
// what the plan signs, never from the form: amount only with bond or
// bondExtra, n only with nominate. An add-only plan has no n, so the card
// never says validators were nominated.
export function stakeResultParams(plan, { eraText = null } = {}) {
    const line = (ids) => ((plan && plan.lines) || []).find(l => ids.includes(l.id));
    const a = line(['SC-80a', 'SC-80b']);
    const n = line(['SC-80c', 'SC-80d']);
    return { amount: a ? a.params.amount : null, n: n ? n.params.n : null, eraText };
}

// The plan's calls through the api's own decorated extrinsics, one per entry,
// in order. staking.bond is (value, payee) on 392 to 394; a legacy runtime
// with (controller, value, payee) gets the stash as controller.
export function stakeCalls(api, plan, { stash } = {}) {
    return ((plan && plan.calls) || []).map((c) => {
        if (c.kind === 'bond') {
            const n = api.tx.staking.bond.meta && api.tx.staking.bond.meta.args ? api.tx.staking.bond.meta.args.length : 2;
            return n >= 3 ? api.tx.staking.bond(stash, c.args.value, payeeArg(c.args.payee)) : api.tx.staking.bond(c.args.value, payeeArg(c.args.payee));
        }
        if (c.kind === 'bondExtra') return api.tx.staking.bondExtra(c.args.value);
        if (c.kind === 'setPayee') return api.tx.staking.setPayee(payeeArg(c.args.payee));
        if (c.kind === 'nominate') return api.tx.staking.nominate(c.args.targets.slice());
        if (c.kind === 'chill') return api.tx.staking.chill();
        if (c.kind === 'unbond') return api.tx.staking.unbond(c.args.value);
        throw new Error(`Unknown stake call ${c.kind}.`);
    });
}

// One call bare; two or more in one atomic utility.batchAll (F1).
export function buildStakeTx(api, plan, opts = {}) {
    const calls = stakeCalls(api, plan, opts);
    if (!calls.length) throw new Error(stakeCopy('SC-55b'));
    if (calls.length === 1) return calls[0];
    if (!(api.tx.utility && typeof api.tx.utility.batchAll === 'function')) throw new Error('This runtime has no utility.batchAll; do the steps one at a time from your wallet app.');
    return api.tx.utility.batchAll(calls);
}

// The Unstake modal's full unstake: chill, then unbond the whole active stake,
// built by buildStakeTx in one atomic utility.batchAll. Under forceBatch a
// failed unbond (too many unlocking chunks, say) would leave the chill
// standing: the account stops nominating and earns nothing, the PDEX stays
// bonded, and the fee is paid. chill comes first because unbond to zero while
// still nominating fails InsufficientBond. Both are controller calls (394).
export function planFullUnbond(planck) {
    return { calls: [{ kind: 'chill', args: {} }, { kind: 'unbond', args: { value: String(planck) } }], lines: [], primary: null, problems: [] };
}

// The remembered view: 'simple' or 'advanced'; anything else, a missing
// store or a throwing one reads as 'simple'. Nothing else is stored.
export function loadStakeView(storage) {
    try {
        const v = storage && storage.getItem(STAKE_VIEW_KEY);
        return v === 'advanced' ? 'advanced' : 'simple';
    } catch (e) {
        return 'simple';
    }
}
export function saveStakeView(storage, view) {
    try {
        if (!storage) return false;
        storage.setItem(STAKE_VIEW_KEY, view === 'advanced' ? 'advanced' : 'simple');
        return true;
    } catch (e) {
        return false;
    }
}
