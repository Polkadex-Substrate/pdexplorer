// Transaction status: what stage a submission is in, what went wrong, and what
// to tell the user. Feeds the in-page status card (lib/tx-status-card.js) that
// replaced the browser alert() popups, and the council motion cards.
//
// WHY THIS EXISTS (Oct 2026)
//
// After tabling a council motion the CEO got the popup "Propose
// treasury.rejectProposal(#72) was included on-chain." and could not tell what
// it meant. The old helper also:
//   - reported success at InBlock and unsubscribed, so Finalized was never seen;
//   - read only result.dispatchError, so a utility.forceBatch with a failed item
//     (stake + nominate, payout) and a council motion whose inner call failed
//     (council.Executed with an Err result) both reported success;
//   - printed section.name for module errors and toString() for everything
//     else, so Token and Arithmetic errors (what modern FRAME returns for "not
//     enough balance") reached the user as raw text.
//
// Everything here is pure: no DOM, no chain connection, no imports. Chain
// objects are read through the few duck-typed properties polkadot-js exposes
// (isModule, asToken, type, ...), so test/tx-status.test.js drives it with
// plain fakes. Nothing returned for display may contain a hex blob: every
// string goes through sanitize().

export const BUTTON_STAGE_TEXT = Object.freeze({
    signing: 'Waiting for wallet', broadcast: 'Broadcasting', inBlock: 'In block', finalized: 'Finalized'
});

// unconfirmed: included with clean events, then the node link dropped (or
// FinalityTimeout) before Finalized; neutral, never red. waiting: sent but not
// in a block within PRE_INBLOCK_CAP_MS; neutral, the explorer stops watching.
const CARD_STAGES = ['signing', 'broadcast', 'inBlock', 'finalized', 'failed', 'cancelled', 'stalled', 'unconfirmed', 'waiting', 'notice'];

// polkadot-js ExtrinsicStatus.type -> stage. Retracted is deliberately NOT a
// failure: the block was reorganised away and the transaction is back in the
// pool, so an InBlock and Finalized normally follow. Marking it failed would
// flip the card to red and then back to green.
const STATUS_STAGE = {
    Future: 'broadcast', Ready: 'broadcast', Broadcast: 'broadcast', Retracted: 'broadcast',
    InBlock: 'inBlock', Finalized: 'finalized',
    Dropped: 'failed', Invalid: 'failed', Usurped: 'failed', FinalityTimeout: 'failed'
};

export const STATUS_FAILURE_TEXT = Object.freeze({
    Dropped: 'The network dropped this transaction before it was included. Nothing happened and no fee was charged. Try again.',
    Usurped: 'Another transaction from your account replaced this one before it was included. Nothing from this one happened and no fee was charged for it.',
    Invalid: 'The network marked this transaction invalid before it was included. Nothing happened and no fee was charged. Refresh the page and try again.',
    FinalityTimeout: 'The block with this transaction was not finalized in time. Check your account page before sending it again.'
});

export function stageOf(status) {
    if (status == null || status === 'signing') return 'signing';
    if (typeof status === 'string') return CARD_STAGES.includes(status) ? status : (STATUS_STAGE[status] || 'broadcast');
    const type = status.type || (status.isFinalized ? 'Finalized' : status.isInBlock ? 'InBlock' : '');
    return STATUS_STAGE[type] || 'broadcast';
}

// Never show a hex dump: hashes, call data and encoded errors mean nothing to
// a reader and look like a crash.
const HEX_BLOB = /0x[0-9a-fA-F]{12,}/g;
export const sanitize = (s) => String(s == null ? '' : s).replace(HEX_BLOB, '[data]');

export function shortAddress(a) {
    const s = String(a || '');
    return s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
}

// Planck (12 decimals) to a short PDEX string. BigInt so u128 values survive.
export function formatPlanck(planck, decimals = 12, maxFrac = 4) {
    if (planck == null || planck === '') return null;
    let v;
    try { v = BigInt(String(planck).replace(/,/g, '')); } catch (_) { return null; }
    const neg = v < 0n; if (neg) v = -v;
    const base = 10n ** BigInt(decimals);
    const int = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
    return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

export function supportCode(txHash, key) {
    return txHash ? String(txHash).slice(0, 10) : (key ? String(key) : 'no-tx');
}

// --- Dispatch errors ---------------------------------------------------------
// Keys are `${metadata section}.${error name}` exactly as findMetaError
// returns them. Names checked against the pallets in the mainnet runtime via
// the bundled @polkadot/types-augment 10.13.1; anything unmapped falls back to
// the first sentence of the error's own metadata docs.
const FEE_SHORT = 'Not enough transferable PDEX for the amount plus fees. Locked PDEX (staking, voting, vesting) cannot be sent.';
const EXPENDABLE = 'This would leave your account below the minimum balance and remove it. Send a smaller amount, or untick Keep alive to send everything.';
const BELOW_MIN = 'The amount is below the minimum balance needed to open a new account.';
const ARITH = 'The amounts in this transaction did not add up on chain. This usually means a balance is lower than the amount used. Check the amount and try again.';
export const ERROR_COPY = Object.freeze({
    'council.NotMember': 'Only current council members can do this, and this account does not hold a seat. Connect a member account.',
    'council.DuplicateVote': 'You already cast this same vote on this motion. Nothing changed.',
    'council.WrongIndex': 'The motion number no longer matches the chain; it probably closed. Reload the page and try again.',
    'council.TooEarly': 'Too early to close. The motion has not reached its threshold and the voting period has not ended.',
    'council.DuplicateProposal': 'This exact motion is already open. Vote on the existing one under Council, Motions.',
    'council.WrongProposalWeight': 'The size estimate for closing this motion was too low. Reload and press Close again.',
    'council.WrongProposalLength': 'The size estimate for closing this motion was too low. Reload and press Close again.',
    'council.ProposalMissing': 'This motion is no longer open; it was probably closed already. Reload the page.',
    'treasury.InvalidIndex': 'There is no treasury proposal with that number. It may already be paid or rejected. Check Treasury and try again.',
    'treasury.InsufficientProposersBalance': 'Not enough free PDEX for the proposal bond. Add PDEX or ask for a smaller amount.',
    'system.BadOrigin': 'This account is not allowed to do this. For a council motion that passed, it means fewer than a majority of the whole council voted Aye; the treasury only accepts more than half of all seats, whatever threshold the motion used.',
    'staking.InsufficientBond': 'The amount is below the minimum bond, or unbonding would leave less than the minimum. Use Max to unbond everything, or bond more.',
    'staking.AlreadyBonded': 'This account already has a bond. Add to your existing stake instead of creating a new one.',
    'staking.NoMoreChunks': 'Too many unbonding requests are in progress (limit 32). Withdraw matured funds first or wait for one to mature.',
    'staking.NotController': 'This action must be signed by the stake\'s controller (or stash) account. Connect that account.',
    'staking.NotStash': 'This action must be signed by the stake\'s controller (or stash) account. Connect that account.',
    'staking.AlreadyClaimed': 'Those rewards were already paid out. Refresh to see the current list.',
    'staking.EmptyTargets': 'Pick between 1 and 16 validators.',
    'staking.TooManyTargets': 'Pick between 1 and 16 validators.',
    'democracy.AlreadyVetoed': 'This account already vetoed this proposal; a member can veto a given proposal only once.',
    'democracy.InsufficientFunds': 'Not enough free PDEX to lock behind this vote. Enter a smaller amount.',
    'democracy.AlreadyDelegating': 'This account is delegating its votes. Undelegate before voting directly.',
    'democracy.ReferendumInvalid': 'This referendum has ended or does not exist. Reload.',
    'balances.InsufficientBalance': FEE_SHORT,
    'balances.Expendability': EXPENDABLE,
    'balances.ExistentialDeposit': BELOW_MIN,
    'balances.LiquidityRestrictions': 'Part of your PDEX is locked and cannot be moved.',
    'identity.StickyJudgement': 'A registrar has already judged this identity, so it cannot be cleared this way.',
    'identity.NoIdentity': 'This account has no identity set.',
    'proxy.Duplicate': 'That proxy already exists.',
    'proxy.TooMany': 'This account has reached the maximum of 32 proxies.',
    'proxy.NotFound': 'That proxy does not exist; it may already be removed.',
    'proxy.NoSelfProxy': 'You cannot make your own account a proxy.',
    'elections.InsufficientCandidateFunds': 'Not enough free PDEX for the candidacy bond or the stake.',
    'elections.LowBalance': 'Not enough free PDEX for the candidacy bond or the stake.',
    'elections.InvalidWitnessData': 'The candidate list changed while you were signing. Try again.',
    'elections.DuplicatedCandidate': 'You are already a candidate.',
    'elections.MemberSubmit': 'Current members cannot stand as candidates.',
    'utility.TooManyCalls': 'Too many actions in one transaction. Do fewer at a time.',
    'token.FundsUnavailable': FEE_SHORT,
    'token.NotExpendable': EXPENDABLE,
    'token.BelowMinimum': BELOW_MIN,
    'token.OnlyProvider': 'This account cannot be emptied while other things depend on it.',
    'token.CannotCreate': 'The receiving account cannot be created.',
    'token.UnknownAsset': 'That asset does not exist.',
    'token.Frozen': 'These funds are frozen and cannot be moved.',
    'token.Unsupported': 'This operation is not supported for this asset.',
    'token.CannotCreateHold': 'The account cannot hold more reserved funds.',
    'token.Blocked': 'This account is blocked from this operation.',
    'arithmetic.Underflow': ARITH,
    'arithmetic.Overflow': ARITH,
    'arithmetic.DivisionByZero': ARITH
});

// Collectives share pallet_collective's error enum; the elections pallet has
// several registered names. Match on the metadata section, never on the
// explorer's councilPalletName variable (that one is the elections pallet).
const COLLECTIVE_SECTION = /^(council|technicalCommittee|councilCollective|generalCouncil)$/;
const ELECTIONS_SECTION = /^(elections|phragmenElection|electionsPhragmen)$/;
function copyFor(key) {
    if (ERROR_COPY[key]) return ERROR_COPY[key];
    const dot = key.indexOf('.');
    const section = key.slice(0, dot), name = key.slice(dot + 1);
    if (COLLECTIVE_SECTION.test(section)) return ERROR_COPY['council.' + name] || null;
    if (ELECTIONS_SECTION.test(section)) return ERROR_COPY['elections.' + name] || null;
    return null;
}

function firstSentence(docs) {
    const t = sanitize(docs).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = t.match(/^.*?[.!?](?=\s|$)/);
    return (m ? m[0] : t).slice(0, 200);
}

const variantName = (x) => (x == null ? 'Unknown' : typeof x === 'string' ? x : x.type ? String(x.type) : String(x));

export function isDispatchError(e) {
    return !!e && typeof e === 'object' && (e.isModule || e.isToken || e.isArithmetic || e.isBadOrigin
        || e.isCannotLookup || e.isOther || e.isTransactional || e.isExhausted || e.isCorruption || e.isUnavailable
        || e.isConsumerRemaining || e.isNoProviders || e.isTooManyConsumers || e.isRootNotAllowed) === true;
}

export function decodeDispatchError(e, registry) {
    if (!e) return null;
    let key, docs = '';
    try {
        if (e.isModule) {
            try {
                const m = registry.findMetaError(e.asModule);
                key = `${m.section}.${m.name}`;
                docs = (m.docs || []).map(String).join(' ');
            } catch (_) { key = 'module.Unknown'; }
        } else if (e.isToken) key = 'token.' + variantName(e.asToken);
        else if (e.isArithmetic) key = 'arithmetic.' + variantName(e.asArithmetic);
        else if (e.isBadOrigin) key = 'system.BadOrigin';
        else if (e.isTransactional) key = 'transactional.' + variantName(e.asTransactional);
        else key = 'system.' + (typeof e.type === 'string' && /^[A-Za-z]+$/.test(e.type) ? e.type : 'Other');
    } catch (_) { key = 'system.Other'; }
    key = sanitize(key);
    const text = copyFor(key) || firstSentence(docs) || `The chain rejected this transaction (${key}).`;
    return { key, text: sanitize(text) };
}

// --- Errors thrown before the chain (signing, RPC validation, transport) ----
export const CANCEL_RX = /cancell?ed|reject|denied|declined/i;
const GENERIC = 'Something went wrong and we could not tell what. Nothing is lost if this card did not reach In block. Send us the support code below if it keeps happening.';
const THROWN = [
    ['pool.Payment', /Inability to pay some fees|\bPayment\b/i, (p) =>
        `Not enough PDEX to pay the network fee. This account needs a little free PDEX beyond the amount you are sending. Add PDEX to ${p.address ? shortAddress(p.address) : 'this account'} or lower the amount, then try again.`],
    // DEV NOTE carried from the spec: the metadata-hash cause is a hypothesis,
    // not confirmed. Re-test on testnet with two wallets and correct this text.
    ['pool.BadProof', /bad signature|BadProof/i, () =>
        'The network did not accept your wallet\'s signature. Nothing was sent and no fee was charged. Since the spec 392 upgrade this can mean your wallet does not support the metadata-hash check the chain now expects. Update your wallet app or extension, or try another wallet (Polkadot.js, Talisman, SubWallet, Nova), then try again. If it keeps failing, send us the support code.'],
    ['pool.Nonce', /\bStale\b|\bOutdated\b|\b1014\b|Priority is too low|temporarily banned|\bFuture\b/i, () =>
        'The network refused this transaction because another one from your account is pending or has just completed. Wait for the other one to finish (watch its card), then try again once. If you also use another wallet or tab, finish there first.'],
    ['pool.Validation', /unreachable|TaggedTransactionQueue|\b1002\b/i, () =>
        'The node could not validate this transaction. Refresh the page and try again; if it repeats, send us the support code.'],
    ['net.ConnectionLost', /disconnected|not connected|websocket|socket|connection (?:lost|closed|dropped)|abnormal closure|\b1006\b|timed? ?out/i, () =>
        'Lost connection to the node while waiting. The transaction may still have gone through. Check your account page before sending it again.']
];
// The message of an Error somebody wrote for a reader: the explorer's own
// guards (the keep-alive refusal in lib/wallet-safety.js, "The treasury pallet
// is not available on this runtime.", the batch and chill checks), a wallet,
// or polkadot-js. Engine errors (TypeError and friends) are bugs, and their
// text ("Cannot read properties of undefined") means nothing to a user, so
// they get the generic text like a non-Error or an empty message. Capped and
// sanitised: no hex blob, no wall of text.
const ENGINE_ERROR = /^(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|InternalError)$/;
const MAX_MESSAGE = 300;
export function readableMessage(err) {
    const isError = err instanceof Error || (!!err && typeof err === 'object' && typeof err.message === 'string' && typeof err.name === 'string');
    if (!isError || ENGINE_ERROR.test(String(err.name)) || ENGINE_ERROR.test(String(err.constructor && err.constructor.name))) return null;
    const t = sanitize(err.message).replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > MAX_MESSAGE ? t.slice(0, MAX_MESSAGE - 3).trimEnd() + '...' : t;
}

// What buildTx and the pre-flight guards throw, marked so buildTxModel shows
// it as written: never matched against the RPC or cancel patterns (a message
// naming treasury.rejectProposal is not a cancelled signature) and no support
// code, since nothing was signed. Anything without a readable message passes
// through unchanged and is classified as usual.
export function asPreflight(err) {
    const message = readableMessage(err);
    return message ? { preflight: true, message } : err;
}

export function classifyThrownError(err, params = {}) {
    const msg = String((err && err.message) || err || '');
    for (const [key, rx, text] of THROWN) {
        if (rx.test(msg)) return { stage: 'failed', key, text: text(params || {}), raw: msg };
    }
    if (CANCEL_RX.test(msg)) {
        return { stage: 'cancelled', key: 'wallet.Cancelled', raw: msg,
            text: 'Cancelled. You declined the signature in your wallet, so nothing was sent and no fee was charged. Press the button again when you are ready.' };
    }
    // The generic text only when there is nothing readable to show.
    const own = readableMessage(err);
    if (own) return { stage: 'failed', key: 'error', text: own, raw: msg };
    return { stage: 'failed', key: 'unknown', text: GENERIC, raw: msg };
}

// --- What the events say happened --------------------------------------------
// A failed extrinsic is still included in a block (F-056). So are a
// utility.forceBatch whose items failed and a council motion whose inner call
// failed; those two report ExtrinsicSuccess, which is how they slipped past.
const str = (x) => (x == null ? null : String(x));
const resultIn = (data) => Array.from(data || []).find(x => x && typeof x.isErr === 'boolean') || null;

export function evaluateEvents(events, registry, opts = {}) {
    const out = { ok: true, tone: 'ok', key: null, text: null, failedItems: 0, completedItems: 0,
        executed: null, approved: false, disapproved: false, withdrawn: null, payouts: 0,
        fee: null, reserved: null, unreserved: null, proposalIndex: null };
    let extrinsicErr = null, itemErr = null, interrupted = null, execErr = null;
    for (const rec of (Array.isArray(events) ? events : [])) {
        const e = rec && rec.event;
        if (!e) continue;
        const s = String(e.section), m = String(e.method), d = e.data || [];
        if (s === 'system' && m === 'ExtrinsicFailed') extrinsicErr = d[0];
        else if (s === 'utility' && m === 'ItemFailed') { out.failedItems++; itemErr = itemErr || d[0]; }
        else if (s === 'utility' && m === 'ItemCompleted') out.completedItems++;
        else if (s === 'utility' && m === 'BatchInterrupted') interrupted = { index: Number(d[0]), error: d[1] };
        else if ((COLLECTIVE_SECTION.test(s) && (m === 'Executed' || m === 'MemberExecuted')) || (s === 'multisig' && m === 'MultisigExecuted')) {
            const r = resultIn(d);
            if (r && r.isErr) { out.executed = 'err'; execErr = execErr || r.asErr; }
            else if (out.executed !== 'err') out.executed = 'ok';
        }
        else if (COLLECTIVE_SECTION.test(s) && m === 'Approved') out.approved = true;
        else if (COLLECTIVE_SECTION.test(s) && m === 'Disapproved') out.disapproved = true;
        else if (s === 'staking' && m === 'Withdrawn') out.withdrawn = str(d[1]);
        else if (s === 'staking' && m === 'PayoutStarted') out.payouts++;
        else if (s === 'transactionPayment' && m === 'TransactionFeePaid') out.fee = str(d[1]);
        else if (s === 'balances' && m === 'Reserved') out.reserved = str(d[1]);
        else if (s === 'identity' && m === 'IdentityCleared') out.unreserved = str(d[1]);
        else if (s === 'treasury' && m === 'Proposed') out.proposalIndex = str(d[0]);
    }
    const fail = (key, text) => Object.assign(out, { ok: false, tone: 'error', key, text: sanitize(text) });
    if (extrinsicErr) { const x = decodeDispatchError(extrinsicErr, registry); return fail(x.key, x.text); }
    if (interrupted) {
        const x = decodeDispatchError(interrupted.error, registry) || { key: 'utility.BatchInterrupted', text: '' };
        return fail(x.key, `Action ${interrupted.index + 1} in this transaction failed, so the actions after it did not run: ${x.text}`);
    }
    if (out.failedItems) {
        const x = decodeDispatchError(itemErr, registry) || { key: 'utility.ItemFailed', text: '' };
        const total = out.failedItems + out.completedItems;
        if (opts.actionKey === 'staking.payout' && out.completedItems > 0) {
            return Object.assign(out, { tone: 'warn', key: x.key,
                text: `${out.failedItems} of ${total} payouts were skipped, most likely already claimed.` });
        }
        return fail(x.key, `${out.failedItems} of ${total} actions in this transaction failed: ${x.text}`);
    }
    if (out.executed === 'err') {
        const x = decodeDispatchError(execErr, registry) || { key: 'collective.Executed', text: '' };
        if (opts.actionKey === 'council.propose') return fail(x.key, `The motion was recorded but the treasury call failed: ${x.text}`);
        if (opts.actionKey === 'council.close') return fail(x.key, `The motion passed but the proposed call failed: ${x.text} It is finished; table a new motion if you still want it.`);
        return fail(x.key, `The proposed call failed: ${x.text}`);
    }
    return out;
}

// --- Success copy, per action key -------------------------------------------
const L = {
    council: { href: '/council', label: 'Council motions' },
    treasury: { href: '/treasury', label: 'Treasury' },
    democracy: { href: '/democracy', label: 'Democracy' }
};
const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
const pdex = (planck) => formatPlanck(planck);
const CONVICTION_MULT = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };
const COPY = {
    'multisig.transaction': (p, o) => o.executed === 'ok' || p.kind === 'execute'
        ? { title: 'Multisig transaction executed', body: 'The call was executed from the multisig wallet.' }
        : p.kind === 'cancel'
            ? { title: 'Multisig transaction cancelled', body: 'The pending call was removed and its deposit returned to the original depositor.' }
            : { title: 'Multisig approval recorded', body: 'Your approval was recorded. The underlying call has not executed yet. Other signers can review the same call data and complete it from My Accounts.' },
    'council.propose': (p, o) => {
        const verb = /reject/i.test(p.callType || '') ? 'rejected' : 'approved';
        if (o.executed === 'ok' || Number(p.threshold) === 1) {
            return { title: 'Motion executed', body: `With a threshold of 1 the call ran as soon as you proposed it. Treasury proposal #${p.id} is now ${verb}.`, links: [L.council, L.treasury] };
        }
        // pallet_collective in current polkadot-sdk starts a motion with no
        // ayes, so the proposer is told to check rather than "your Aye counts".
        return { title: 'Motion tabled',
            body: `Treasury proposal #${p.id} will be ${verb} if ${p.threshold} of ${p.seats || 'the'} council members vote Aye. Track it under Council, Motions; if your own Aye is not listed on the card, vote Aye too.`,
            next: 'Ask the other members to vote. When the threshold is reached any member can press Close to run it; the motion lapses at the end of its voting period.',
            links: [L.council] };
    },
    'council.vote': (p) => ({ title: 'Vote recorded',
        body: `You voted ${p.aye ? 'Aye' : 'Nay'} on ${p.body || 'council'} motion #${p.idx}. Reaching the threshold does not run the motion by itself.`,
        next: 'A member must press Close after the threshold is met or the voting period ends.', links: [L.council] }),
    'council.close': (p, o) => {
        let body = 'Motion closed.';
        if (o.executed === 'ok') body = 'Motion closed and executed. The proposed call ran successfully. Check Treasury for the new status.';
        else if (o.disapproved) body = 'Motion closed without enough Ayes. Nothing was executed.';
        if (o.executed === 'ok' && p.method === 'approveProposal') body += ' The treasury proposal is approved and is paid at the next spend period if funds are available; the proposer\'s bond is returned.';
        if (o.executed === 'ok' && p.method === 'rejectProposal') body += ' The treasury proposal is rejected; the proposer\'s bond is slashed to the treasury.';
        return { title: 'Motion closed', body, links: [L.council, L.treasury] };
    },
    'elections.candidacy': (p) => ({ title: 'Candidacy submitted',
        body: `You are now a council candidate${p.bond ? ` and ${p.bond} PDEX is reserved` : ' and the candidacy bond is reserved'} until you leave the list or win a seat. Voters can back you from the Council page.`, links: [L.council] }),
    'elections.vote': (p) => ({ title: 'Votes recorded',
        body: `You backed ${plural(p.n, 'candidate', 'candidates')} with ${p.stake} PDEX. The stake stays locked while the vote stands; you can change it before the term ends.`, links: [L.council] }),
    'democracy.vote': (p) => {
        const mult = CONVICTION_MULT[p.conviction];
        const days = mult && p.lockPeriodDays ? Math.round(mult * p.lockPeriodDays) : null;
        const lock = mult === 0 ? ' Your PDEX is only locked until the referendum ends.'
            : ` Your ${p.amount} PDEX is locked until the referendum ends${days ? `, and for about ${days} days after that if your side wins` : ', and longer if your side wins'}.`;
        return { title: 'Vote recorded', body: `You voted ${p.aye ? 'Aye' : 'Nay'} on referendum #${p.ref} with ${p.amount} PDEX at ${p.conviction || 'your chosen conviction'}.${lock}`,
            next: 'After the lock ends, remove your vote and unlock from your wallet app (democracy.removeVote, then democracy.unlock).', links: [L.democracy] };
    },
    'democracy.second': (p) => ({ title: 'Proposal seconded',
        body: `You backed public proposal #${p.n}${p.deposit ? ` with a deposit of ${p.deposit} PDEX` : ''}, the same as the original proposer. The deposit is returned when the proposal becomes a referendum or is cancelled.`,
        next: 'The most-backed proposal goes to referendum at each launch period.', links: [L.democracy] }),
    'staking.bondNominate': (p) => ({ title: 'Staking updated',
        body: `${p.amount ? `${p.amount} PDEX bonded and ` : ''}${plural(p.n, 'validator', 'validators')} nominated.`,
        next: `Your nominations take effect from the next era${p.eraText ? ` (eras last ${p.eraText})` : ''}, so you earn rewards from the era after a nominated validator is elected. Claim rewards with Pay Out after each era ends.` }),
    'staking.unbond': (p) => ({ title: 'Unbonding started',
        body: `${p.amount} PDEX is now unbonding and earns no rewards.${p.full ? ' Your nominations were also stopped.' : ''}`,
        next: `It can be withdrawn after ${p.unbondingText || 'the unbonding period'}. Come back then and press Withdraw unbonded. During this time it cannot be transferred.` }),
    'staking.withdraw': (p, o) => (o.withdrawn
        ? { title: 'Funds withdrawn', body: `${pdex(o.withdrawn)} PDEX moved from unbonding to your transferable balance.` }
        : { title: 'Nothing to withdraw yet', body: 'No unbonding amount has matured, so no PDEX moved. A fee was still charged.', next: 'Check the date shown under Unstaking.' }),
    'staking.payout': (p, o) => ({ title: 'Rewards claimed',
        body: `${plural(o.payouts || p.k || 0, 'validator-era entry was', 'validator-era entries were')} paid out.${o.tone === 'warn' && o.text ? ' ' + o.text : ''}`,
        next: `Rewards go to each nominator's payee; with the default Staked payee they are added to the bond.${p.remaining ? ` Run Pay Out again for the remaining ${p.remaining}.` : ''}` }),
    'balances.transfer': (p, o) => ({ title: 'PDEX sent',
        body: `${p.amount} PDEX sent to ${shortAddress(p.to)}.${o.fee ? ` Network fee ${pdex(o.fee)} PDEX.` : ''}`,
        next: 'The recipient sees it once this card reads Finalized.' }),
    'identity.set': (p, o) => ({ title: 'Identity saved',
        body: `Your identity is on chain.${o.reserved ? ` A refundable deposit of ${pdex(o.reserved)} PDEX is reserved while it is set.` : ' A refundable deposit is reserved while it is set.'} No registrar has verified it, so it shows as unverified.`,
        next: 'It can take a minute to appear on your account page.' }),
    'identity.clear': (p, o) => ({ title: 'Identity cleared',
        body: `Your identity was removed and your deposit${o.unreserved ? ` of ${pdex(o.unreserved)} PDEX` : ''} was returned.` }),
    'treasury.propose': (p, o) => ({ title: 'Proposal submitted',
        body: `Treasury proposal${o.proposalIndex != null ? ' #' + o.proposalIndex : ''} asks for ${p.value} PDEX for ${shortAddress(p.beneficiary)}.${o.reserved ? ` A bond of ${pdex(o.reserved)} PDEX is reserved.` : ''}`,
        next: 'The council reviews it. If approved it is paid at the next spend period; if rejected the bond is lost.', links: [L.treasury] }),
    'proxy.add': (p, o) => ({ title: 'Proxy added',
        body: `${shortAddress(p.delegate)} can now act for your account as a ${p.type} proxy${Number(p.delay) ? ` after a delay of ${p.delay} blocks` : ''}.${o.reserved ? ` A deposit of ${pdex(o.reserved)} PDEX is reserved.` : ''}`,
        next: 'Only add accounts you control. Remove it any time from your account page, Proxies; the deposit is returned.' }),
    'proxy.remove': (p) => ({ title: 'Proxy removed',
        body: `${shortAddress(p.delegate)} can no longer act for you as a ${p.type} proxy. The deposit was returned.` })
};
export const ACTION_KEYS = Object.freeze(Object.keys(COPY));

// Card title while the outcome is unknown (and on failure). The call sites'
// `label` is a developer string ("Propose treasury.rejectProposal(#72)") and
// is only the fallback for an action without a key.
export const PENDING_TITLE = Object.freeze({
    'multisig.transaction': 'Submitting a multisig transaction',
    'council.propose': 'Tabling a council motion', 'council.vote': 'Recording your motion vote', 'council.close': 'Closing the motion',
    'elections.candidacy': 'Submitting your candidacy', 'elections.vote': 'Recording your council votes',
    'democracy.vote': 'Recording your referendum vote', 'democracy.second': 'Seconding the proposal',
    'staking.bondNominate': 'Updating your stake', 'staking.unbond': 'Starting to unbond', 'staking.withdraw': 'Withdrawing unbonded PDEX',
    'staking.payout': 'Claiming staking rewards', 'balances.transfer': 'Sending PDEX', 'identity.set': 'Saving your identity',
    'identity.clear': 'Clearing your identity', 'treasury.propose': 'Submitting a treasury proposal', 'proxy.add': 'Adding a proxy',
    'proxy.remove': 'Removing a proxy'
});

export function successCopy(key, params = {}, outcome = {}) {
    const fn = COPY[key];
    const c = fn ? fn(params || {}, outcome || {}) : { title: (params && params.label) || 'Transaction', body: 'The transaction went through.' };
    return { title: sanitize(c.title), body: sanitize(c.body), next: c.next ? sanitize(c.next) : '', links: c.links || [] };
}

// --- One model per card update ----------------------------------------------
// action = { id, key, label, params }; status = ExtrinsicStatus or a stage
// string ('signing', 'failed', 'stalled', 'notice'); error = thrown error,
// DispatchError, a pre-flight sentence (shown verbatim) or null.
export function buildTxModel(action = {}, status, events, error, extra = {}) {
    const p = action.params || {};
    const stage0 = stageOf(status);
    const m = { id: String(action.id || ''), stage: stage0, tone: 'pending', title: PENDING_TITLE[action.key] || action.label || '',
        body: '', next: '', links: [], code: null, key: null, text: null, raw: null, outcome: null };
    const n = extra.blockNumber;
    if (stage0 === 'notice') return Object.assign(m, { tone: 'neutral', title: '', stageText: 'Notice', body: sanitize(error) });
    const failWith = (r) => Object.assign(m, { stage: r.stage || 'failed', tone: r.stage === 'cancelled' ? 'neutral' : 'error',
        key: r.key, text: sanitize(r.text), body: sanitize(r.text), raw: r.raw || r.key,
        // Nothing was signed for a pre-flight message, so there is nothing to trace.
        code: r.key === 'preflight' ? null : supportCode(extra.txHash, r.key) });
    if (error) {
        if (typeof error === 'string') failWith({ stage: CANCEL_RX.test(error) ? 'cancelled' : 'failed', key: 'preflight', text: error });
        else if (error.preflight === true) failWith({ stage: 'failed', key: 'preflight', text: error.message, raw: error.message });
        else if (isDispatchError(error)) failWith({ ...decodeDispatchError(error, extra.registry), stage: 'failed' });
        else failWith(classifyThrownError(error, p));
    } else if (stage0 === 'failed') {
        const type = (status && status.type) || 'Dropped';
        failWith({ stage: 'failed', key: 'pool.' + type, text: STATUS_FAILURE_TEXT[type] || STATUS_FAILURE_TEXT.Dropped });
    } else if (stage0 === 'waiting') {
        // Sent, never in a block within the cap. It may still land, so this is
        // not a failure and gets no support code; the link looks it up by hash.
        Object.assign(m, { tone: 'neutral',
            body: 'Still waiting for the network, check the transaction later. It was sent but has not been put in a block yet, and it may still go through. Check before sending it again.',
            next: 'The explorer has stopped watching it. If it never appears, nothing happened and no fee was charged.' });
    } else if (stage0 === 'inBlock' || stage0 === 'finalized' || stage0 === 'stalled' || stage0 === 'unconfirmed') {
        const o = evaluateEvents(events, extra.registry, { actionKey: action.key });
        m.outcome = o;
        if (!o.ok) failWith({ stage: 'failed', key: o.key, text: o.text });
        else {
            Object.assign(m, successCopy(action.key, { ...p, label: action.label }, o));
            m.tone = stage0 === 'unconfirmed' ? 'neutral' : stage0 === 'stalled' || o.tone === 'warn' ? 'warn' : stage0 === 'finalized' ? 'ok' : 'pending';
            if (stage0 === 'stalled') m.next = `Still waiting for finality. Your transaction was included in block #${n || '?'}; you can close this card.`;
            if (stage0 === 'unconfirmed') m.next = 'The connection to the node dropped before the block was finalized. Blocks are almost always finalized within a minute; open the transaction to confirm.';
        }
    }
    const blockLink = n ? { href: `/block/${n}`, label: `Block #${n}` } : null;
    const txLink = (b) => ({ href: `/tx/${b}/${extra.txHash}`, label: 'View transaction' });
    if ((m.stage === 'finalized' || m.stage === 'unconfirmed') && n && extra.txHash) m.links = [txLink(n)].concat(m.links);
    else if ((m.stage === 'inBlock' || m.stage === 'stalled' || m.stage === 'unconfirmed' || (m.stage === 'failed' && n)) && blockLink) m.links = [blockLink].concat(m.links);
    // No block yet (or none since a Retracted, or the header read failed): the
    // block the chain was at when it was sent. The tx page looks a couple of
    // blocks either side and offers a scan by hash.
    else if ((m.stage === 'waiting' || m.stage === 'unconfirmed') && extra.txHash && extra.sentBlock) m.links = [{ href: `/tx/${extra.sentBlock}/${extra.txHash}`, label: 'Look up the transaction' }].concat(m.links);
    m.stageText = {
        signing: 'Waiting for your wallet', broadcast: 'Sent to the network',
        inBlock: n ? `In block #${n}` : 'In block', finalized: n ? `Finalized in block #${n}` : 'Finalized',
        failed: n ? `Failed in block #${n}` : 'Failed', cancelled: 'Cancelled', stalled: 'Still waiting for finality',
        unconfirmed: n ? `Included in block #${n}, finality not yet confirmed` : 'Included, finality not yet confirmed',
        waiting: 'Still waiting for the network'
    }[m.stage] || 'In progress';
    return m;
}

// --- What submitSignedTx does next ------------------------------------------
// The lifecycle of one submission as a pure step function, so the rules are
// tested (test/tx-lifecycle.test.js) instead of living only in the browser
// shell. t is the tracker state; ev is one of
//   { type: 'status', status }      an ExtrinsicStatus from signAndSend
//   { type: 'outcome', stage, ok }  the events of an InBlock/Finalized, read
//   { type: 'disconnected' }        the node link dropped
//   { type: 'preCap' }              PRE_INBLOCK_CAP_MS since the first Sent
//   { type: 'finalityCap' }         FINALITY_CAP_MS since the first clean In block
//   { type: 'thrown' }              buildTx or signAndSend threw
// and the returned act tells the shell what to do:
//   ignore       nothing (already finished, or a timer that no longer applies)
//   sent         card Sent, button busy; armPreCap on the first one
//   resent       Retracted: card back to Sent, buttons enabled, block number reset
//   fail         failed card and onError
//   read         read the block number and events, then step an 'outcome'
//   firstOk      first clean inclusion: buttons enabled, onSuccess, arm the finality cap
//   ok           a later clean update; final when Finalized
//   unconfirmed  clean inclusion, finality never confirmed: neutral, no onError, stop;
//                firstOk: true when onSuccess has not run yet and is due now
//   waiting      not included in time: neutral, buttons enabled, no onError, stop
//   stalled      clean inclusion, finality cap passed: stop
// included is true only while the transaction sits in a block whose events
// checked clean; a Retracted clears it until the next clean inclusion.
// inBlockSeen is true once onSuccess has run: after that a dropped link or a
// FinalityTimeout is never a failure, Retracted or not (no onError after
// onSuccess). reading is true between 'read' and its 'outcome'; a drop then
// waits for the outcome (the events are already in hand, only the block
// number is being read), so the card can say "included in block #N".
export const PRE_INBLOCK_CAP_MS = 90000;
export const FINALITY_CAP_MS = 120000;
// The longest the tracker waits for a block header; then it goes on without
// the number. Bounds the wait a drop during the read puts on the outcome.
export const HEADER_READ_MS = 10000;
export function initialTxTrack() {
    return { done: false, sent: false, inBlockSeen: false, included: false, reading: false, dropped: false };
}
export function txStep(t, ev) {
    const s = { ...t };
    const out = (act, more) => Object.assign({ state: s, act }, more || {});
    const end = (act, more) => { s.done = true; return out(act, more); };
    if (t.done || !ev) return out('ignore');
    if (ev.type === 'status') {
        const stage = stageOf(ev.status);
        const type = ev.status && ev.status.type;
        if (stage === 'broadcast') {
            if (t.inBlockSeen) { s.included = false; return out('resent'); }
            s.sent = true;
            return out('sent', t.sent ? null : { armPreCap: true });
        }
        if (stage === 'failed') return type === 'FinalityTimeout' && (t.included || t.inBlockSeen) ? end('unconfirmed') : end('fail');
        if (stage === 'inBlock' || stage === 'finalized') { s.reading = true; return out('read'); }
        return out('ignore');
    }
    if (ev.type === 'outcome') {
        s.reading = false;
        if (!ev.ok) { s.included = false; return end('fail'); }
        s.included = true;
        if (t.dropped) { s.inBlockSeen = true; return end('unconfirmed', t.inBlockSeen ? null : { firstOk: true }); }
        const final = ev.stage === 'finalized';
        if (final) s.done = true;
        if (!t.inBlockSeen) { s.inBlockSeen = true; return out('firstOk', { final }); }
        return out('ok', { final });
    }
    if (ev.type === 'disconnected') {
        if (t.included) return end('unconfirmed');
        if (t.reading) { s.dropped = true; return out('ignore'); }
        return t.inBlockSeen ? end('unconfirmed') : end('fail');
    }
    if (ev.type === 'thrown') return end('fail');
    if (ev.type === 'preCap') return t.inBlockSeen || t.reading ? out('ignore') : end('waiting');
    if (ev.type === 'finalityCap') return t.included ? end('stalled') : end('waiting');
    return out('ignore');
}

const STAGE_ICON = {
    signing: 'bx-loader-alt bx-spin', broadcast: 'bx-loader-alt bx-spin', inBlock: 'bx-cube', finalized: 'bx-check-circle',
    failed: 'bx-error-circle', cancelled: 'bx-minus-circle', stalled: 'bx-time-five', notice: 'bx-info-circle',
    unconfirmed: 'bx-cube', waiting: 'bx-time-five'
};
const SAFE_HREF = /^\/(?!\/)[A-Za-z0-9/_\-.?=&]*$/;

// The card markup. `esc` is the HTML escaper (lib/html-escape.js in the
// browser). Visible text is sanitised; hrefs are internal paths only. No
// role="status" here: the zone (#tx-status-zone) is the one aria-live region,
// and a live region per card made screen readers announce every update twice.
export function txCardHtml(m, esc) {
    const t = (s) => esc(sanitize(s));
    const links = (m.links || []).filter(l => l && SAFE_HREF.test(String(l.href)))
        .map(l => `<a href="${esc(String(l.href))}" class="tx-card-link">${t(l.label)}</a>`).join('');
    return `<div class="tx-card tx-${t(m.tone || 'pending')}" data-tx-id="${t(m.id)}">`
        + `<div class="tx-card-head"><i class='bx ${STAGE_ICON[m.stage] || 'bx-info-circle'}' aria-hidden="true"></i>`
        + `<span class="tx-card-stage">${t(m.stageText || '')}</span>`
        + (m.stage === 'notice' ? '' : `<a href="/help/transaction-status" class="help-inline-icon" title="What these stages mean" aria-label="What these stages mean"><i class='bx bx-help-circle' aria-hidden="true"></i></a>`)
        + `<button type="button" class="tx-card-close" aria-label="Close transaction status"><i class='bx bx-x' aria-hidden="true"></i></button></div>`
        + (m.title ? `<div class="tx-card-title">${t(m.title)}</div>` : '')
        + (m.body ? `<div class="tx-card-body">${t(m.body)}</div>` : '')
        + (m.next ? `<div class="tx-card-next">${t(m.next)}</div>` : '')
        + (links ? `<div class="tx-card-links">${links}</div>` : '')
        + (m.code ? `<div class="tx-card-foot"><span>Support code ${t(m.code)}</span><button type="button" class="tx-card-copy">Copy details</button></div>` : '')
        + '</div>';
}

// --- Council motions --------------------------------------------------------
export const THRESHOLD_ONE_WARNING = 'A threshold of 1 runs the call immediately when you propose it, with no council vote';

// A majority of the seats, or null when the seat count is unknown. Never 1 by
// default: that is a motion that runs with no vote.
export function defaultThreshold(seats) {
    const s = Number(seats);
    return Number.isInteger(s) && s > 0 ? Math.floor(s / 2) + 1 : null;
}

export function checkThreshold(raw, seats, confirmed) {
    const txt = String(raw == null ? '' : raw).trim();
    const value = /^\d+$/.test(txt) ? Number(txt) : NaN;
    const s = Number(seats) > 0 ? Number(seats) : 0;
    const r = { value, error: null, warning: null, needsConfirm: false, canSubmit: false };
    if (!Number.isInteger(value) || value < 1) r.error = 'Approval threshold must be a whole number of at least 1.';
    else if (s && value > s) r.error = `Threshold can't exceed the ${s} council seats.`;
    else if (value === 1) { r.warning = THRESHOLD_ONE_WARNING + '.'; r.needsConfirm = true; }
    else if (s && value < defaultThreshold(s)) r.warning = `Below a majority of the ${s} seats. Treasury approvals and rejections need more than half of all council seats, so this motion would likely fail when it runs.`;
    r.canSubmit = !r.error && (!r.needsConfirm || !!confirmed);
    return r;
}

// Card state from a voting record, by pallet_collective's own rules:
// approved when ayes >= threshold, disapproved when the remaining seats can no
// longer reach it (seats - nays < threshold), closeable either way or once the
// voting period has ended. Without a seat count the old nays >= threshold
// approximation is kept.
export function motionState(v, ctx = {}) {
    const ayesL = Array.isArray(v && v.ayes) ? v.ayes : [];
    const naysL = Array.isArray(v && v.nays) ? v.nays : [];
    const ayes = ayesL.length, nays = naysL.length;
    const threshold = Number(v && v.threshold) || 0;
    const seats = Number(ctx.seats) > 0 ? Number(ctx.seats) : 0;
    const end = Number(v && v.end) || 0, now = Number(ctx.currentBlock) || 0;
    const approved = threshold > 0 && ayes >= threshold;
    const disapproved = !approved && threshold > 0 && (seats ? seats - nays < threshold : nays >= threshold);
    const ended = end > 0 && now > 0 && now >= end;
    const decided = approved || disapproved;
    const base = approved ? { key: 'approved', label: 'Threshold met', badge: 'claimed' }
        : disapproved ? { key: 'rejected', label: 'Rejected', badge: 'unclaimed' }
        : ended ? { key: 'expired', label: 'Voting ended', badge: 'neutral' }
        : { key: 'voting', label: 'Voting open', badge: 'neutral' };
    const naysToReject = seats && threshold ? Math.max(1, seats - threshold + 1) : threshold;
    const same = typeof ctx.isSame === 'function' ? ctx.isSame : (a, b) => a === b;
    const you = ctx.you;
    const youVoted = !you ? null : ayesL.some(a => same(a, you)) ? 'aye' : naysL.some(a => same(a, you)) ? 'nay' : null;
    return { ...base, closeable: decided || ended, decided, ended, approved, disapproved,
        ayes, nays, threshold, naysToReject, youVoted,
        ayePct: threshold ? Math.min(100, Math.round(ayes / threshold * 100)) : 0,
        nayPct: naysToReject ? Math.min(100, Math.round(nays / naysToReject * 100)) : 0 };
}

export function pendingChipText(kind) {
    return kind === 'aye' ? 'Your Aye is being recorded' : kind === 'nay' ? 'Your Nay is being recorded' : 'Closing this motion';
}

// Is an in-flight vote or close finished from the card's point of view? A vote
// is settled only when it is in a block AND the voting record shows it (so a
// vote change from Aye to Nay is not settled by the old Aye). A close is
// settled when the motion is gone or the transaction is final.
export function pendingSettled(p, state) {
    if (!p) return true;
    if (p.error) return false;
    const landed = p.stage === 'inBlock' || p.stage === 'finalized';
    if (p.kind === 'close') return !state || p.stage === 'finalized';
    return landed && !!state && state.youVoted === p.kind;
}

// Merge live chain state into the REST motion list. live = { hashes, votings,
// stubs } from lib/collective-live.js. The live hash list is the truth for
// WHICH motions are open; live voting records are the truth for tallies; REST
// keeps everything else (call args, close weight bound). A new motion REST has
// not seen yet is shown from its stub once its voting record has arrived.
export function overlayLiveMotions(motions, live) {
    const list = Array.isArray(motions) ? motions : [];
    if (!live || !Array.isArray(live.hashes)) return list;
    const byHash = new Map(list.map(m => [m.hash, m]));
    const votings = live.votings || {}, stubs = live.stubs || {};
    const out = [];
    for (const h of live.hashes) {
        const v = votings[h];
        let m = byHash.get(h);
        if (!m) {
            if (!v) continue;
            const s = stubs[h] || {};
            m = { hash: h, section: s.section || '', method: s.method || '', args: s.args || [], lengthBound: s.lengthBound || 0,
                title: s.section && s.method ? `${s.section}.${s.method}` : '', live: true };
        }
        if (v) m = { ...m, index: v.index, threshold: v.threshold, ayes: v.ayes, nays: v.nays, end: v.end };
        out.push(m);
    }
    return out.sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0));
}

// Can a re-render of the open motions patch cards in place? prev and next are
// { frame, cards: [{ hash, status, parts: { tally, voters, badge, actions } }] }
// where frame captures everything outside the cards (the REST snapshot, the
// filters, the wallet, and the hash and status of every open motion, since a
// status change moves the filter counts). Same frame and same visible cards:
// patch just the parts whose markup changed. Anything else: render it all.
export function motionPatchPlan(prev, next) {
    if (!prev || !next || prev.frame !== next.frame) return { full: true };
    const a = prev.cards || [], b = next.cards || [];
    if (a.length !== b.length || a.some((c, i) => c.hash !== b[i].hash || c.status !== b[i].status)) return { full: true };
    const changed = [];
    b.forEach((c, i) => {
        const parts = Object.keys(c.parts || {}).filter(k => (a[i].parts || {})[k] !== c.parts[k]);
        if (parts.length) changed.push({ hash: c.hash, parts });
    });
    return { full: false, changed };
}
