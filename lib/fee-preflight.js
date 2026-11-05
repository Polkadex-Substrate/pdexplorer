// Can this account pay the network fee? Asked before the wallet is, for every
// signed action (lib/tx-submit.js runs it in send()). Tested in
// test/fee-preflight.test.js.
//
// The fee (spec 392). Polkadex charges it through CurrencyAdapter
// (polkadex-node runtimes/mainnet/src/lib.rs, OnChargeTransaction), that is
// Currency::withdraw(fee, KeepAlive) on pallet-balances. It is payable iff
//   free - fee >= frozen                      (all of frozen; reserved does
//                                              not reduce it), and
//   free - fee >= existential deposit         when free >= ED (an account
//                                              already below ED may spend to
//                                              zero).
// Reserved PDEX (deposits, the council candidacy bond) never pays a fee, and
// an account at exactly the existential deposit can pay nothing.
//
// Why the UI hung (3 Nov 2026): the pool's validity check (can_withdraw_fee)
// tests only free >= fee and the locks, not the ED. So an account held at the
// ED by the fee alone is ACCEPTED into the pool, then fails at block
// authoring every time and is never included: no error ever comes back. The
// message says so for that case.
//
// The transfer amount follows the fungible reducible rule after the fee:
//   untouchable = frozen - reserved (saturating), and at least ED for a
//   transferKeepAlive; spendable = free - fee - untouchable. With Keep alive
//   off (transferAllowDeath) the ED still applies while anything is locked or
//   reserved (transferKeep below).
//
// When the fee cannot be estimated (the node refuses paymentInfo, the balance
// read fails or hangs), the wallet still gets to try, with a warning.

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

// What free must still hold after the fee: Currency::withdraw(KeepAlive)
// keeps all of frozen, and the ED unless the account is already below it.
// Shared with lib/balance-locks.js (the Transferable card), so the panel and
// this check cannot disagree about whether a fee is payable.
export function feeFloor({ free, frozen = 0n, ed = 0n }) {
    const fr = big(free), fz = big(frozen), ex = big(ed);
    return fr >= ex ? max(fz, ex) : fz;
}

// The fee the balance panel assumes when it has no estimate (it reads no
// paymentInfo): 0.05 PDEX, the same buffer script.js keeps back for the fee
// (SEND_FEE_BUFFER). A typical signed call costs about 0.015 PDEX.
export const FEE_MARGIN = 5n * 10n ** 10n;

// What a transfer must leave in free: pallet-balances 46 reducible_balance
// (Polite). untouchable = frozen - reserved, raised to the ED for a keep-alive
// transfer (Preserve) and, with Keep alive off (Expendable), whenever the
// account cannot be reaped: can_dec_provider is false while it has consumers,
// and a non-zero frozen or reserved balance is one (one provider assumed).
// Shared with lib/balance-locks.js (Transferable for each toggle).
export function transferKeep({ frozen = 0n, reserved = 0n, ed = 0n, keepAlive = true }) {
    const fz = big(frozen), res = big(reserved), ex = big(ed);
    const untouchable = sub0(fz, res);
    return keepAlive || fz > 0n || res > 0n ? max(untouchable, ex) : untouchable;
}

// null when the account can pay; otherwise what it needs.
export function feeShortfall({ fee, amount = 0n, keepAlive = true, free, reserved = 0n, frozen = 0n, ed = 0n }) {
    const f = big(fee), a = big(amount), fr = big(free), res = big(reserved), ex = big(ed), fz = big(frozen);
    const feeNeeds = f + feeFloor({ free: fr, frozen: fz, ed: ex });
    // The amount: the fungible reducible balance left after the fee.
    const amountNeeds = a === 0n ? 0n : f + a + transferKeep({ frozen: fz, reserved: res, ed: ex, keepAlive });
    const needed = max(feeNeeds, amountNeeds);
    if (fr >= needed) return null;
    // The pool accepts it (free covers the fee and the locks) but the ED check
    // at block authoring refuses it every time: never included, no error.
    const neverIncluded = fr < feeNeeds && fr >= f + fz && fr >= ex;
    return { needed, free: fr, reserved: res, locked: fz, amount: a, fee: f, topUp: needed - fr, neverIncluded };
}

export function feeShortText(s) {
    const what = s.amount > 0n ? `send ${formatPlanck(s.amount)} PDEX and pay the network fee` : 'pay the network fee';
    return `This account needs at least ${ceil4(s.needed)} PDEX free to ${what}. It has ${formatPlanck(s.free)} PDEX free`
        + (s.reserved > 0n ? `; ${formatPlanck(s.reserved)} PDEX is reserved (deposits, bonds) and cannot pay fees` : '')
        + (s.locked > 0n ? `; ${formatPlanck(s.locked)} PDEX is locked (staking, votes, vesting) and cannot pay fees` : '')
        + '.'
        + (s.neverIncluded ? ' As it is, the network would accept the transaction but it would never be included.' : '')
        + ` Send at least ${ceil4(s.topUp)} PDEX to this account and try again.`;
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

export const FEE_UNKNOWN_WARNING = 'The explorer could not estimate the network fee, so it could not check that this account has enough free PDEX to pay it. Your wallet will show the fee. If the account cannot pay, the transaction will not go through and nothing is charged.';
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
