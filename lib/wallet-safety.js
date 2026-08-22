// Wallet safety primitives — the functions that decide WHAT gets signed.
//
// These live in their own module for one reason: they are the highest-
// consequence pure functions in the codebase, and they must be unit-testable
// without a browser, a DOM, or a chain connection. Every bug the 2026-08
// audit rated "fix risk: funds" was in here:
//
//   F-012  isValidPolkadexAddress accepted a 0x hash as a destination
//   F-011  amounts were converted with parseFloat * 1e12
//   F-054  a Keep-alive transfer could fall through to transferAllowDeath
//
// All three are pure logic with no I/O. They were untested because they sat
// mid-file in a 13k-line browser bundle that cannot be imported by Node.
// Anything added here must stay free of DOM and network access so the test
// suite keeps working.

import { decodeAddress } from '@polkadot/util-crypto';

// PDEX has 12 decimals.
export const PDEX_DECIMALS = 12;

// Parse a decimal PDEX string into Planck units, returned as a STRING.
//
// Audit F-011: never use Number arithmetic here. `parseFloat(x) * 1e12`
// breaks in two ways — decimals land one planck short ("1.1" → 1099999999999
// or similar), and any amount above Number.MAX_SAFE_INTEGER / 1e12 (~9007
// PDEX) silently loses integer precision. The user would sign a value other
// than the one they typed. String splitting + BigInt is exact at every
// magnitude.
export function pdexToPlanck(value) {
    const s = String(value == null ? '0' : value).trim();
    if (!s) return '0';
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const [intPart, decPart = ''] = abs.split('.');
    const decPadded = (decPart + '000000000000').slice(0, PDEX_DECIMALS);
    const result = BigInt(intPart || '0') * 1000000000000n + BigInt(decPadded || '0');
    return (neg ? -result : result).toString();
}

// Loose "is this a usable positive amount" check for form input. Deliberately
// tolerant of trailing/leading whitespace and decimal strings; the exact
// conversion is pdexToPlanck's job.
export function isPositiveNumberInput(str) {
    if (str == null || String(str).trim() === '') return false;
    const n = parseFloat(str);
    return Number.isFinite(n) && n > 0;
}

// STRICT address validation for anything that can become a signing target.
//
// Audit F-012: decodeAddress() alone also accepts a 0x-prefixed 32-byte hex
// string as a raw public key, so a pasted block hash or extrinsic hash
// "validates" and can be signed as a transfer / treasury / proxy
// destination — an account nobody holds the key for, unrecoverable. In this
// UI a 0x value is always a hash, never an account. SS58 base58 addresses
// fall in the 46-50 character range, so a truncated paste fails loudly
// instead of decoding to something unintended.
export function isValidPolkadexAddress(addr) {
    const s = String(addr == null ? '' : addr).trim();
    if (!s) return false;
    if (s.startsWith('0x')) return false;      // hash, not an account
    if (s.length < 46 || s.length > 50) return false;
    try { decodeAddress(s); return true; }
    catch (e) { return false; }
}

// Build a balances transfer, binding the user's keep-alive intent to the
// method actually used.
//
// Audit F-054: the previous implementation fell through to whichever variant
// existed — a checked "Keep-alive" box could submit transferAllowDeath and
// reap the sender's account if the runtime ever dropped transferKeepAlive.
// Intent must never be silently inverted: if the matching call is absent we
// throw and let the caller surface it. Legacy bare `transfer` carries
// allow-death semantics, so it is only an acceptable substitute when the
// user did NOT ask to keep the account alive.
export function buildTransferTx(api, dest, planckStr, keepAlive) {
    const t = api && api.tx && api.tx.balances;
    if (!t) throw new Error('balances pallet is not available on this runtime.');
    if (keepAlive) {
        if (t.transferKeepAlive) return t.transferKeepAlive(dest, planckStr);
        throw new Error('This runtime has no balances.transferKeepAlive call. Refusing to substitute a transfer that could reap the sending account — uncheck "Keep-alive" only if you accept that.');
    }
    if (t.transferAllowDeath) return t.transferAllowDeath(dest, planckStr);
    if (t.transfer) return t.transfer(dest, planckStr);
    throw new Error('No supported balances.transfer* call on this runtime.');
}
