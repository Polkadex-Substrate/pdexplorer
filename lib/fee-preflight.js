// Can this account pay the network fee? Asked before the wallet is, for every
// signed action (lib/tx-submit.js runs it in send()). Tested in
// test/fee-preflight.test.js.
//
// The fee is withdrawn from FREE balance with Preservation::Preserve and
// Fortitude::Polite (pallet-transaction-payment's FungibleAdapter), so it may
// only take the reducible balance (pallet-balances, spec 392):
//   untouchable = max(frozen - reserved (saturating), existential deposit)
//   spendable   = free - untouchable
// Reserved PDEX (deposits, the council candidacy bond) never pays a fee, and
// an account at exactly the existential deposit can pay nothing. A
// transferKeepAlive also takes its amount from the same spendable balance. A
// transferAllowDeath may take the account down to its locks, but the fee
// itself still keeps the existential deposit.
//
// When the fee cannot be estimated (the node refuses paymentInfo, the balance
// read fails or hangs), the wallet still gets to try, with a warning: the pool
// is the final judge and refuses an unpayable transaction without charging.

import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { formatPlanck } from './tx-status.js';

const big = (x) => {
    if (x == null) return 0n;
    try { return BigInt(String(x.toString ? x.toString() : x).replace(/,/g, '')); } catch (_) { return 0n; }
};
const max = (a, b) => (a > b ? a : b);
const sub0 = (a, b) => (a > b ? a - b : 0n);

// Planck rounded UP to 4 decimals, so "send at least N" is always enough.
const STEP = 10n ** 8n;
const ceil4 = (v) => formatPlanck(((v + STEP - 1n) / STEP) * STEP);

// null when the account can pay; otherwise what it needs.
export function feeShortfall({ fee, amount = 0n, keepAlive = true, free, reserved = 0n, frozen = 0n, ed = 0n }) {
    const f = big(fee), a = big(amount), fr = big(free), res = big(reserved), ex = big(ed);
    const locked = sub0(big(frozen), res);
    const keep = max(locked, ex);
    const needed = keepAlive || a === 0n ? keep + f + a : max(keep + f, locked + f + a);
    if (fr >= needed) return null;
    return { needed, free: fr, reserved: res, locked, amount: a, fee: f, topUp: needed - fr };
}

export function feeShortText(s) {
    const what = s.amount > 0n ? `send ${formatPlanck(s.amount)} PDEX and pay the network fee` : 'pay the network fee';
    return `This account needs at least ${ceil4(s.needed)} PDEX free to ${what}. It has ${formatPlanck(s.free)} PDEX free`
        + (s.reserved > 0n ? `; ${formatPlanck(s.reserved)} PDEX is reserved (deposits, bonds) and cannot pay fees` : '')
        + (s.locked > 0n ? `; ${formatPlanck(s.locked)} PDEX is locked (staking, votes, vesting) and cannot pay fees` : '')
        + `. Send at least ${ceil4(s.topUp)} PDEX to this account and try again.`;
}

// The amount a top-level balances transfer takes from the signer, or null.
// A wrapper (multisig asMulti, proxy, batch) moves someone else's funds or is
// checked on chain, so only its fee is checked here.
export function transferOf(tx) {
    const m = tx && tx.method;
    if (!m || m.section !== 'balances') return null;
    if (m.method !== 'transferKeepAlive' && m.method !== 'transferAllowDeath') return null;
    const args = m.args || [];
    return { amount: big(args[1]), keepAlive: m.method === 'transferKeepAlive' };
}

export const FEE_UNKNOWN_WARNING = 'The explorer could not estimate the network fee, so it could not check that this account has enough free PDEX to pay it. Your wallet will show the fee. If the account cannot pay, the network refuses the transaction and nothing is charged.';
export const FEE_PREFLIGHT_MS = 8000;

const bounded = (ms, p) => new Promise((resolve, reject) => {
    const cut = setTimeout(() => reject(new Error('timed out')), ms);
    Promise.resolve(p).then((v) => { clearTimeout(cut); resolve(v); }, (e) => { clearTimeout(cut); reject(e); });
});

const toPolkadex = (a) => { try { return encodeAddress(decodeAddress(a), 88); } catch (_) { return String(a || ''); } };

// { status: 'ok' } | { status: 'short', text, fundAddress, shortfall }
// | { status: 'unknown', warning } | { status: 'skipped' } (nothing to ask).
export async function feePreflight(api, tx, address, { timeoutMs = FEE_PREFLIGHT_MS } = {}) {
    if (!tx || typeof tx.paymentInfo !== 'function' || !api?.query?.system?.account) return { status: 'skipped' };
    let info, account;
    try {
        [info, account] = await bounded(timeoutMs, Promise.all([tx.paymentInfo(address), api.query.system.account(address)]));
    } catch (e) {
        return { status: 'unknown', warning: FEE_UNKNOWN_WARNING };
    }
    const d = account && account.data;
    if (!info || info.partialFee == null || !d) return { status: 'unknown', warning: FEE_UNKNOWN_WARNING };
    // Pre-392 shape: miscFrozen and feeFrozen instead of frozen.
    const frozen = d.frozen != null ? big(d.frozen) : max(big(d.miscFrozen), big(d.feeFrozen));
    const ed = big(api.consts?.balances?.existentialDeposit);
    const t = transferOf(tx);
    const s = feeShortfall({ fee: big(info.partialFee), amount: t ? t.amount : 0n, keepAlive: t ? t.keepAlive : true,
        free: big(d.free), reserved: big(d.reserved), frozen, ed });
    if (!s) return { status: 'ok' };
    return { status: 'short', text: feeShortText(s), fundAddress: toPolkadex(address), shortfall: s };
}
