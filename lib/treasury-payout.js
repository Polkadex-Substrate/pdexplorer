// Approved treasury spends and what anyone can do with them now: the rules
// behind the Treasury page's Spends tab (lib/treasury-payout-view.js) and GET
// /api/treasury/spends (lib/treasury-payout-api.js). Tests:
// test/treasury-payout.test.js.
//
// A council motion or referendum that runs treasury.spend stores a spend in
// treasury.spends(index): { assetKind, amount, beneficiary, validFrom,
// expireAt, status: Pending | Attempted { id } | Failed }. Nothing is paid
// until someone calls payout. From pallet-treasury 44.0.0
// (polkadot-stable2512-3, substrate/frame/treasury/src/lib.rs):
//   payout(index), Must be signed:
//     ensure!(now >= spend.valid_from, Error::<T, I>::EarlyPayout);
//     ensure!(spend.expire_at > now, Error::<T, I>::SpendExpired);
//     ensure!(matches!(spend.status, PaymentState::Pending | PaymentState::Failed), AlreadyAttempted);
//     Paymaster::pay(...) (an error is PayoutError), then status = Attempted { id },
//     expire_at = now + PayoutPeriod, event Paid. It returns DispatchResult,
//     so the fee is charged and kept.
//   check_status(index), Must be signed:
//     if now > spend.expire_at && !matches!(spend.status, Attempted { .. }):
//         removed, SpendProcessed, Ok(Pays::No.into())
//     not Attempted: NotAttempted. Attempted: Paymaster::check_payment(id):
//         Failure: status Failed, PaymentFailed, Ok(Pays::Yes.into())
//         Success | Unknown: removed, SpendProcessed, Ok(Pays::No.into())
//         InProgress: Inconclusive
//   void_spend(index) is RejectOrigin only, so it is not offered here.
// `now` is T::BlockNumberProvider::current_block_number(), and the runtime's
// provider returns System::block_number(): the block the transaction executes
// in, which is the best head + 1 when it is signed. Every check below is made
// for that block.
//
// The runtime (polkadex-node, branch mainnet, runtimes/mainnet/src/lib.rs,
// spec 393, impl pallet_treasury::Config):
//   type AssetKind = ();
//   type Paymaster = PayFromAccount<Balances, TreasuryAccount>;
//   type PayoutPeriod = SpendPeriod;          (24 * DAYS: 172,800 blocks)
// PayFromAccount (frame-support traits/tokens/pay.rs) pays with a Balances
// transfer inside payout itself and its check_payment always returns
// Success. So on Polkadex an Attempted spend is a paid spend, check_status on
// it always clears it with the fee refunded, and Failed never happens
// (handled anyway: payout accepts it again inside the window).

import { formatPlanck } from './tx-status.js';

export const PAYOUT_FEE_TEXT = 'Anyone can submit a payout from any connected wallet; the submitter pays the network fee, and it is not refunded.';
export const CHECK_FEE_TEXT = 'Anyone can submit Check status from any connected wallet; the fee is refunded when the spend is cleared (paid or expired).';

const ACTIONS = { payout: 'payout', checkStatus: 'checkStatus' };
const num = (x) => (x == null || x === '' ? NaN : Number(x));
const blockText = (n) => Number(n).toLocaleString('en-US');

// What the spend allows in block `now` (the block a transaction would run in).
// opts.eta(block) gives the estimated date of a block, or ''.
// Returns { phase, statusText, action: 'payout' | 'checkStatus' | null, actionLabel, note }.
export function classifySpend(spend, now, opts = {}) {
    const none = (phase, statusText, note) => ({ phase, statusText, action: null, actionLabel: '', note });
    if (!spend) return none('unknown', 'Unknown', 'This spend is no longer on chain.');
    const status = String(spend.status || '');
    const from = num(spend.validFrom), expire = num(spend.expireAt), n = num(now);
    if (status === 'Attempted') {
        return { phase: 'paid', statusText: 'Paid', action: ACTIONS.checkStatus, actionLabel: 'Check status',
            note: 'Paid. Check status clears the record; its fee is refunded.' };
    }
    if (status !== 'Pending' && status !== 'Failed') return none('unknown', status || 'Unknown', 'Unknown spend status.');
    const statusText = status === 'Failed' ? 'Payment failed' : 'Approved, not paid';
    if (!Number.isFinite(n) || !Number.isFinite(from) || !Number.isFinite(expire)) return none('unknown', statusText, 'The current block is not known yet.');
    if (n < from) {
        const eta = typeof opts.eta === 'function' ? opts.eta(from) : '';
        return none('scheduled', statusText, `Payable from block ${blockText(from)}${eta ? ` (~${eta})` : ''}`);
    }
    if (n < expire) return { phase: 'payable', statusText, action: ACTIONS.payout, actionLabel: status === 'Failed' ? 'Retry payout' : 'Pay out', note: '' };
    const expired = { phase: 'expired', statusText: 'Expired', note: 'Expired: can no longer be paid' };
    return n > expire ? { ...expired, action: ACTIONS.checkStatus, actionLabel: 'Clear (fee refunded)' } : { ...expired, action: null, actionLabel: '' };
}

// Planck to "1,500 PDEX" with every decimal kept (trailing zeros dropped).
export function formatSpendAmount(planck, decimals = 12) {
    const s = String(planck == null ? '' : planck);
    if (!/^\d+$/.test(s)) return '-';
    return `${formatPlanck(s, decimals, decimals)} PDEX`;
}

// The estimated time (ms) of block `target`, counted from a block seen at time `at`.
export function blockEta(target, { block, at, blockMs }) {
    const t = num(target), b = num(block), a = num(at), ms = num(blockMs);
    if (![t, b, a].every(Number.isFinite) || !(ms > 0)) return null;
    return a + (t - b) * ms;
}

// treasury.payout(index) or treasury.checkStatus(index).
export function buildSpendTx(api, action, index) {
    if (action !== ACTIONS.payout && action !== ACTIONS.checkStatus) throw new Error(`Unknown spend action: ${action}`);
    const tx = api && api.tx && api.tx.treasury && api.tx.treasury[action];
    if (typeof tx !== 'function') throw new Error('Treasury spends are not available on this runtime.');
    return tx(Number(index));
}

// One storage value as plain data: planck string, block numbers, status variant.
export function spendFromChain(index, v) {
    return {
        index: Number(index), amount: String(v.amount), beneficiary: String(v.beneficiary),
        validFrom: v.validFrom.toNumber(), expireAt: v.expireAt.toNumber(), status: String(v.status.type)
    };
}

const optional = (o) => (o && typeof o.isSome === 'boolean' ? (o.isSome ? o.unwrap() : null) : o || null);
const toNum = (x) => (x && typeof x.toNumber === 'function' ? x.toNumber() : Number(x));
function spendsQuery(api) {
    const t = api && api.query && api.query.treasury;
    if (!t || typeof t.spends !== 'function' || typeof t.spends.entriesPaged !== 'function' || typeof t.spendCount !== 'function') {
        throw new Error('Treasury spends are not available on this runtime.');
    }
    return t;
}

// Every spend in storage, newest first, read in pages of pageSize and at most
// maxEntries; truncated says there may be more. Each row carries its phase and
// action for the next block. Spends leave storage once processed, so the live
// set is small; the cap bounds a runtime that never clears them.
export async function readSpends(api, { pageSize = 100, maxEntries = 500, normalize = (a) => a } = {}) {
    const t = spendsQuery(api);
    const [head, count] = await Promise.all([api.query.system.number(), t.spendCount()]);
    const block = toNum(head), nextBlock = block + 1;
    const spends = [];
    let startKey, truncated = false;
    while (spends.length < maxEntries) {
        const page = await t.spends.entriesPaged({ args: [], pageSize, startKey });
        for (const [key, value] of page) {
            const v = optional(value);
            if (v && spends.length < maxEntries) spends.push(spendFromChain(toNum(key.args[0]), v));
        }
        if (page.length < pageSize) break;
        if (spends.length >= maxEntries) { truncated = true; break; }
        startKey = page[page.length - 1][0].toHex();
    }
    spends.sort((a, b) => b.index - a.index);
    const consts = api.consts || {};
    const blockTime = consts.babe && consts.babe.expectedBlockTime ? toNum(consts.babe.expectedBlockTime) : 12000;
    const period = consts.treasury && consts.treasury.payoutPeriod ? toNum(consts.treasury.payoutPeriod) : null;
    return {
        block, nextBlock, spendCount: toNum(count), payoutPeriod: period, blockTimeMs: blockTime,
        decimals: Number(api.registry && api.registry.chainDecimals && api.registry.chainDecimals[0]) || 12,
        truncated,
        spends: spends.map(s => { const c = classifySpend(s, nextBlock); return { ...s, beneficiary: normalize(s.beneficiary), phase: c.phase, action: c.action }; })
    };
}

// One spend (or null) and the block a transaction signed now would run in.
export async function readSpend(api, index) {
    const t = spendsQuery(api);
    const [head, value] = await Promise.all([api.query.system.number(), t.spends(Number(index))]);
    const v = optional(value);
    return { next: toNum(head) + 1, spend: v ? spendFromChain(index, v) : null };
}

// For the tx watchdog (lib/tx-submit.js verify): is the effect of the action on chain?
// A payout leaves the spend Attempted (or already cleared); check_status removes it.
export function spendVerdict(action, spend) {
    if (action === ACTIONS.payout) return !spend || spend.status === 'Attempted' ? 'applied' : 'pending';
    return spend ? 'pending' : 'applied';
}
