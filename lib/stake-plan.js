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

// The card's strings, by the spec's ids (section 7), verbatim. Where the spec
// gives two strings under one id ("A / B") they are a and b; SC-60t is the
// switch's title; SC-78b is the "No history yet" of SC-78; SC-161 to SC-164
// are lettered in the order the spec lists them.
export const STAKE_COPY = Object.freeze({
    'SC-01': 'Stake PDEX',
    'SC-02': 'Change only what you want. The review lists exactly what you will sign.',
    'SC-03': 'Amount to stake (PDEX)',
    'SC-03b': 'Amount to add (PDEX)',
    'SC-03c': 'Amount to add (PDEX, optional)',
    'SC-04': 'You can stake up to {max} PDEX.',
    'SC-05': 'Max leaves 1 PDEX that must stay in the account and {reserve} PDEX for network fees.',
    'SC-10': 'What happens',
    'SC-11': 'You stake {amount} PDEX. It is locked while staked.',
    'SC-11b': 'You add {amount} PDEX to the {staked} PDEX you have staked.',
    'SC-12': 'It starts earning from the next era, the network\'s reward period of about {era}.',
    'SC-13': 'Getting it back takes {unbonding} after you unstake, and it earns nothing while it waits.',
    'SC-14': 'Rewards are added to your stake, so they earn too.',
    'SC-14b': 'Rewards are paid to this account as spendable PDEX.',
    'SC-14c': 'Rewards are paid to another account: {short}.',
    'SC-14d': 'Rewards are not being paid to any account. Set where they go in Advanced.',
    'SC-14e': 'Could not read where your rewards go. This action does not change it.',
    'SC-20': 'Past return',
    'SC-21': '{low}% to {high}% a year',
    'SC-21b': 'about {x}% a year',
    'SC-22': 'What these {n} validators paid per PDEX over the last 28 eras, after commission. Past rewards, not a guarantee.',
    'SC-23': 'On {amount} PDEX that was about {a} to {b} PDEX a year.',
    'SC-24a': 'No estimate: none of these validators has 7 eras of reward history yet.',
    'SC-24b': 'No estimate: reward history is still being built.',
    'SC-25': 'Each era the network places your stake behind one or a few of your validators, so your return depends on which. That is why this is a range.',
    'SC-30': '{n} validators chosen for you',
    'SC-30b': '{n} validators chosen by you',
    'SC-30c': 'Your {n} validators stay as they are',
    'SC-30d': 'Replacement: keep {k}, replace {r}',
    'SC-31': 'Validators run the network. Your stake backs them and shares their rewards.',
    'SC-32': 'Chosen by past return, highest first, from validators that are active now, have at least 7 eras of reward history, accept new stake, take 10% commission or less with no recent raise, were not penalised in the last 84 eras, rarely miss blocks, and paid at least three quarters of the typical return. One per operator identity.',
    'SC-33': '{name}, {return}% a year, {commission}% commission (the validator\'s cut)',
    'SC-35': 'Choose validators myself',
    'SC-36': 'Based on the 28 eras up to era {n}.',
    'SC-37': 'Only {k} validators pass every check right now, so {k} were chosen.',
    'SC-38': 'No validator passes every check right now, so none was chosen for you.',
    'SC-39': 'The validator list changed while this was open. Check the new choice, then sign.',
    'SC-40': 'This replaces your own selection of {n} validators with {m} chosen for you.',
    'SC-41': 'Replace my selection',
    'SC-42': 'Keep my selection',
    'SC-43': 'Use the automatic choice',
    'SC-50': 'Sign and stake',
    'SC-51': 'Sign and update validators',
    'SC-52': 'Sign and change rewards',
    'SC-53': 'Sign and update staking',
    'SC-55a': 'Enter an amount to continue.',
    'SC-55b': 'Nothing to sign yet. Change the amount, the validators or the rewards.',
    'SC-60': 'Advanced',
    'SC-60t': 'Choose validators, rewards and amounts yourself',
    // The advanced view (WP3): headings, the rewards group, the selection, the row values of SC-78 in
    // their parts (a to e, in the spec's order) and the two control words of SC-79.
    'SC-61': 'Amount',
    'SC-62': 'Rewards',
    'SC-63': 'Validators',
    'SC-64': 'What you will sign',
    'SC-65': 'Where rewards go',
    'SC-66': 'Add to my stake, so they earn too',
    'SC-67': 'Pay to this account as spendable PDEX',
    'SC-68': 'Pay to another account',
    'SC-69': 'Rewards account',
    'SC-70': 'Rewards will go to an account that is not this one. Check that you control it.',
    'SC-71': 'Enter a valid Polkadex address.',
    'SC-73': 'All validators',
    'SC-74': 'Your selection, {n} of {max}',
    'SC-75': 'Remove all',
    'SC-76': 'No validators selected. Add from the list, or use the automatic choice.',
    'SC-78a': '{x}% a year',
    'SC-78b': 'No history yet',
    'SC-78c': '{y}% commission',
    'SC-78d': 'own stake {z}',
    'SC-78e': '{n} stakers',
    'SC-79a': 'Past return over',
    'SC-79b': 'Highest past return',
    'SC-80a': 'Stake {amount} PDEX',
    'SC-80b': 'Add {amount} PDEX to your stake',
    'SC-80c': 'Choose {n} validators',
    'SC-80d': 'Replace your validators with these {n}',
    'SC-80e': 'Send rewards to {destination}',
    'SC-90': '{k} of your {n} validators are not active this era and earn nothing until they are elected.',
    'SC-91': '{k} have no reward history yet and are not in the past return figure.',
    'SC-92': '{name} paid well below the typical validator over the last 28 eras.',
    'SC-93': '{name} does not accept new stake. The network will most likely reject this, and the fee is still charged.',
    'SC-94': 'Paid less than three quarters of the typical validator, usually because a lot of PDEX is already staked with it.',
    'SC-95': 'More than 256 stakers, so rewards are paid in parts and each part needs its own Pay Out.',
    'SC-100': 'Enter an amount in PDEX, for example 250.',
    'SC-101': 'That is more than this account can stake. The most is {max} PDEX.',
    'SC-102': 'Use {max} PDEX',
    'SC-104': 'This leaves {left} PDEX free. You need free PDEX to pay the fee when you claim rewards or unstake.',
    'SC-105': 'The smallest first stake is {min} PDEX.',
    'SC-106': 'Enter an amount to stake.',
    'SC-107': 'Choose at least one validator.',
    'SC-108': 'You can choose up to {max} validators. Remove one to add another.',
    'SC-109': 'Your account is still loading. Try again in a moment.',
    'SC-110': 'Connect this account\'s wallet to stake from it.',
    'SC-111': 'Loading validators',
    'SC-112': 'Could not load the validator list.',
    'SC-113': 'Try again',
    'SC-114': 'Reward history is still being built, so past returns and some filters are not available yet.',
    'SC-115': 'To stake you need at least {need} PDEX free: the smallest stake of {min} PDEX, 1 PDEX that must stay in the account, and the network fee. This account has {have} PDEX free.',
    'SC-120': 'Connect a wallet to stake PDEX.',
    'SC-121': 'This account is open read-only, so it cannot stake from here. Connect its wallet to stake.',
    'SC-122': 'Validators cannot be chosen right now, so there is nothing to sign yet.',
    // The success card (lib/tx-status.js 'staking.bondNominate').
    'SC-130': '{amount} PDEX staked with {n} validators.',
    'SC-131': '{amount} PDEX added to your stake. Your validators are unchanged.',
    'SC-132': 'Your validators were updated: {n} chosen.',
    'SC-133': 'Rewards now go to: {destination}.',
    'SC-134': 'It starts earning from the next era (eras last {era}). Claim rewards with Pay Out on My Account.',
    'SC-140': 'Your PDEX is staked but earns nothing yet. No validators are chosen for this account.',
    'SC-141': 'Your last staking action is in block #{n}. The figures here update in a moment.',
    // My Account's button (lib/stake-refresh.js stakeButtonHtml): the label, and its line (s).
    'SC-150': 'Stake',
    'SC-150s': 'Stake PDEX and earn rewards',
    'SC-151': 'Stake more',
    'SC-151s': 'Add to your stake or change validators',
    'SC-160': '{k} of your {n} validators are not earning for you.',
    'SC-161a': 'See a replacement',
    'SC-161b': 'Keep my validators',
    'SC-163a': 'Kept',
    'SC-163b': 'Removed',
    'SC-163c': 'Added',
    // The removal reasons, in the order of UNHEALTHY in lib/stake-pick.js.
    'SC-164a': 'not active this era',
    'SC-164b': '100% commission',
    'SC-164c': 'not accepting stake',
    'SC-164d': 'no reward history',
    'SC-164e': 'low return',
    'SC-164f': 'penalised recently'
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
//   stashDiffers    the account is only a controller (the ledger under its
//                   key belongs to another stash): bond and bondExtra must be
//                   signed by the stash, so a plan holding either is refused
//                   rather than failing NotStash for a fee
//   isAddress       the check a rewards account must pass (the card passes the SS58 88 check of
//                   lib/wallet-safety.js); one that fails plans nothing (problem 'payee-invalid'),
//                   so payeeArg never builds an account the user did not get right; with no
//                   check given, every rewards account is refused (fail closed)
// currentPayee null (or 'failed') while a change of destination is asked for means the setting
// could not be read: setPayee would replace it unseen, so nothing is planned ('payee-unknown').
// hasBond null means the stake could not be read: bond would fail with
// AlreadyBonded on a staked account and bondExtra with NotStash on an
// unstaked one, each for a fee, so nothing is planned (problem
// 'bonded-unknown').
// Returns { calls, lines, primary, problems }. Any problem empties `calls`, so
// nothing is signed; empty calls means an inactive primary.
export function planStakeCalls({ hasBond = false, amountPlanck = null, currentTargets = [], targets = [], currentPayee = null, payee = 'current', maxTargets = null, same = (a, b) => a === b, controllerDiffers = false, stashDiffers = false, isAddress = () => false } = {}) {
    if (hasBond == null) return { calls: [], lines: [], primary: null, problems: ['bonded-unknown'] };
    const amount = big(amountPlanck);
    const cur = (currentTargets || []).map(String);
    const next = [];
    for (const t of targets || []) if (!next.some(x => same(x, String(t)))) next.push(String(t));
    const problems = [];
    const calls = [];
    const lines = [];
    const wantPayee = normPayee(payee);
    if (wantPayee && wantPayee.kind === 'account') {
        wantPayee.account = wantPayee.account.trim();
        if (!isAddress(wantPayee.account)) problems.push('payee-invalid');
    }
    let nominateChanged;

    if (!hasBond) {
        if (amount <= 0n) problems.push('amount-required');
        const firstPayee = wantPayee || { kind: 'staked' };
        calls.push({ kind: 'bond', args: { value: amount.toString(), payee: firstPayee } });
        lines.push({ id: 'SC-80a', params: { amount: planckToPdexText(amount) } });
        // The bond carries the destination: one other than the default is a line of its own (5.2).
        if (firstPayee.kind !== 'staked') lines.push({ id: 'SC-80e', params: { destination: destinationText(firstPayee) } });
        nominateChanged = true;
    } else {
        if (amount > 0n) {
            calls.push({ kind: 'bondExtra', args: { value: amount.toString() } });
            lines.push({ id: 'SC-80b', params: { amount: planckToPdexText(amount) } });
        }
        if (wantPayee && (currentPayee == null || currentPayee === 'failed')) problems.push('payee-unknown');
        else if (wantPayee && !samePayee(wantPayee, normPayee(currentPayee), same)) {
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
    if (stashDiffers && calls.some(c => c.kind === 'bond' || c.kind === 'bondExtra')) problems.push('not-stash');
    if (problems.length) return { calls: [], lines: [], primary: null, problems };
    const kinds = new Set(calls.map(c => c.kind));
    let primary = null;
    if (kinds.has('bond') || kinds.has('bondExtra')) primary = 'SC-50';
    else if (kinds.size === 1 && kinds.has('nominate')) primary = 'SC-51';
    else if (kinds.size === 1 && kinds.has('setPayee')) primary = 'SC-52';
    else if (kinds.size > 1) primary = 'SC-53';
    return { calls, lines, primary, problems };
}

// The account's data, or its stake, could not be read: SC-109.
export const STAKE_NOT_LOADED = STAKE_COPY['SC-109'];
// staking.ledgerRead when the page cannot tell bonded from unbonded (lib/stake-refresh.js: a read failed after a
// stake was withdrawn, or the core gave up on it). The figures stay on the page, marked "May be behind", but nothing
// is signed (bond fails AlreadyBonded on a bonded account, bondExtra NotStash on an unbonded one), as for 'failed',
// until a successful chain or server read replaces them.
export const LEDGER_UNSETTLED = 'unsettled';

// The message for a plan that cannot be signed, or for an empty one.
export function planProblemMessage(plan, { maxTargets = null } = {}) {
    const p = (plan && plan.problems) || [];
    if (p.includes('bonded-unknown')) return STAKE_NOT_LOADED;
    if (p.includes('not-controller')) return ERROR_COPY['staking.NotController'];
    if (p.includes('not-stash')) return ERROR_COPY['staking.NotStash'];
    if (p.includes('payee-unknown')) return stakeCopy('SC-14e');
    if (p.includes('amount-required')) return stakeCopy('SC-106');
    if (p.includes('no-validators')) return stakeCopy('SC-107');
    if (p.includes('too-many')) return stakeCopy('SC-108', { max: maxTargets });
    if (p.includes('payee-invalid')) return stakeCopy('SC-71');
    if (!plan || !plan.calls || !plan.calls.length) return stakeCopy('SC-55b');
    return null;
}

// The success card's params (lib/tx-status.js 'staking.bondNominate') from
// what the plan signs, never from the form: amount only with bond or
// bondExtra, n only with nominate, destination only with setPayee. An
// add-only plan has no n, so the card never says validators were nominated.
// first: the plan is a first stake (SC-80a), the one case for SC-130.
// Who must sign what (394 metadata), from the /api/wallet staking block:
// controllerDiffers when Staking.Bonded names another account (nominate,
// setPayee, chill and unbond fail NotController from the stash); stashDiffers
// when the account has no Bonded entry but a ledger under its key, so it is
// only a controller (bond and bondExtra fail NotStash from it). controller
// undefined (an older payload) claims neither.
export function signerRoles(staking, address, same = (a, b) => a === b) {
    const s = staking || {};
    return {
        controllerDiffers: !!(s.controller && !same(s.controller, address)),
        stashDiffers: s.controller === null && s.ledgerRead !== 'failed' && Number(s.totalStaked) > 0
    };
}

// The card's plan from the wallet payload and the form, for the view (what it
// shows and whether the primary is active) and for submitStakeTx (what is
// signed): one function, so the review and the transaction cannot differ.
//   typed      the amount as typed      targets   the selection (addresses)
//   connected  the wallet's account     payee     'current' (the simple view), or the advanced choice
//   currentPayee  where rewards go now (null when unread)   isAddress  the rewards account check
// Returns { message, kind, check, plan, hasBond }: message is the refusal
// ('account', 'amount' or 'plan' in kind), null when the plan can be signed.
export function stakeFormPlan(data, { typed = '', targets = [], maxTargets = null, same = (a, b) => a === b, connected = null, feeFloorPlanck = 0n, payee = 'current', currentPayee = null, isAddress } = {}) {
    const out = (kind, message, rest = {}) => ({ kind, message, check: null, plan: null, hasBond: null, ...rest });
    if (!data) return out('account', STAKE_COPY['SC-109']);
    if (!same(connected, data.address)) return out('account', STAKE_COPY['SC-110']);
    const st = data.staking || {};
    if (st.ledgerRead === 'failed' || st.ledgerRead === LEDGER_UNSETTLED) return out('account', STAKE_COPY['SC-109']);
    const hasBond = (Number(st.totalStaked) || 0) > 0;
    const check = stakeAmountCheck({ typed, transferablePlanck: transferablePlanckOf(data.balance), feeReservePlanck: STAKE_FEE_RESERVE_PLANCK,
        feeFloorPlanck, minStakePlanck: pdexNumberToPlanck(data.network && data.network.minStake, 'ceil'), hasBond, optional: hasBond });
    const roles = signerRoles(st, data.address, same);
    const plan = planStakeCalls({ hasBond, amountPlanck: check.planck, currentTargets: (st.nominating || []).map(v => v.address), targets,
        maxTargets, same, payee, currentPayee, ...(isAddress ? { isAddress } : {}), ...roles });
    const amountMsg = stakeAmountMessage(check, { optional: hasBond });
    if (amountMsg) return out('amount', amountMsg, { check, plan, hasBond });
    const planMsg = planProblemMessage(plan, { maxTargets });
    return { kind: planMsg ? 'plan' : null, message: planMsg, check, plan, hasBond };
}

export function stakeResultParams(plan, { eraText = null } = {}) {
    const line = (ids) => ((plan && plan.lines) || []).find(l => ids.includes(l.id));
    const a = line(['SC-80a', 'SC-80b']);
    const n = line(['SC-80c', 'SC-80d']);
    const d = line(['SC-80e']);
    return { amount: a ? a.params.amount : null, n: n ? n.params.n : null, destination: d ? d.params.destination : null, first: !!line(['SC-80a']), eraText };
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
