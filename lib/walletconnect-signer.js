// A @polkadot/api Signer whose wallet is a phone on the other end of a
// WalletConnect session (Reown "Polkadot RPC" reference, fetched 2026-11-15:
// docs.reown.com/advanced/multichain/rpc-reference/polkadot-rpc.md).
//
//   signPayload(payload) -> polkadot_signTransaction { address, transactionPayload: payload }
//   signRaw(raw)         -> polkadot_signMessage { address, data, type: 'bytes' }
//                           data is the message wrapped in <Bytes>...</Bytes>
//                           and hex encoded, as the spec says the dApp must do.
//   both return          { id, signature } (and signedTransaction when the
//                           wallet sends one), id unique and increasing.
//
// The signature must be a MultiSignature (a type byte, then the signature) for
// @polkadot/api to put it in an extrinsic. Wallets differ: the Reown example
// reply is 64 bare bytes. So:
//   65 bytes, first 0x00 or 0x01   kept (ed25519 / sr25519 MultiSignature)
//   66 bytes, first 0x02           kept (ecdsa MultiSignature)
//   64 bytes                       checked against the account and the exact
//                                  bytes signed; prefixed 0x01 only if it
//                                  verifies as sr25519, 0x00 only if ed25519;
//                                  anything else is an error. Never a guess.
//   anything else                  an error naming the length.
// A reply carrying signedTransaction is passed on as it is: the api submits
// those bytes and checks their call data itself (lib/tx-submit.js).
//
// While the phone decides, onPending({ id, kind, cancel }) is told and the
// function it returns is called when the answer, a timeout or a cancel ends
// the wait. Cancel rejects with "Cancelled" (what extensions say); so does a
// rejection on the phone. A late answer after that is ignored.
//
// No update(): WalletConnect has no status channel back to the wallet, so
// lib/signer-tracking.js passes this signer through and relays nothing.
//
// Tested in test/walletconnect.test.js.

import { hexToU8a, isHex, u8aToHex, u8aWrapBytes, stringToU8a, u8aConcat } from '@polkadot/util';
import { signatureVerify, blake2AsU8a } from '@polkadot/util-crypto';

export const SIGN_TIMEOUT_MS = 5 * 60 * 1000;
export const CANCELLED = 'Cancelled';
export const TIMEOUT_TEXT = 'No answer from your phone wallet in 5 minutes. Nothing was signed.';
const NO_REGISTRY = 'The chain connection is not ready, so the phone wallet\'s signature cannot be checked. Try again in a moment.';

let lastId = 0;
export function nextRequestId() { lastId += 1; return lastId; }

// The bytes a wallet signs for a transaction payload: the SCALE payload,
// hashed with blake2-256 when it is longer than 256 bytes.
export function payloadMessage(registry, payload) {
    const u8a = registry.createType('ExtrinsicPayload', payload, { version: payload.version }).toU8a({ method: true });
    return u8a.length > 256 ? blake2AsU8a(u8a, 256) : u8a;
}

// The bytes polkadot_signMessage asks the wallet to sign: hex is taken as
// bytes, anything else as text, and the result wrapped once in <Bytes>.
export function rawMessage(data) {
    const u8a = isHex(data) ? hexToU8a(data) : stringToU8a(String(data == null ? '' : data));
    return u8aWrapBytes(u8a);
}

export function normaliseSignature(signature, { message, address }) {
    if (typeof signature !== 'string' || !signature || !isHex(signature)) throw new Error('The phone wallet returned no usable signature. Nothing was sent.');
    const bytes = hexToU8a(signature);
    const n = bytes.length;
    if (n === 65 && (bytes[0] === 0 || bytes[0] === 1)) return signature;
    if (n === 66 && bytes[0] === 2) return signature;
    if (n === 64) {
        let check = { isValid: false, crypto: 'none' };
        try { check = signatureVerify(message, bytes, address); } catch (e) { /* not valid for this account */ }
        if (check.isValid && check.crypto === 'sr25519') return u8aToHex(u8aConcat(new Uint8Array([1]), bytes));
        if (check.isValid && check.crypto === 'ed25519') return u8aToHex(u8aConcat(new Uint8Array([0]), bytes));
        throw new Error('The phone wallet\'s signature does not match this account and request. Nothing was sent.');
    }
    throw new Error(`The phone wallet returned a signature of an unexpected size (${n} bytes). Nothing was sent.`);
}

const isRejection = (e) => /reject|denied|declined|cancel/i.test(String((e && e.message) || e || ''));
const asError = (e) => {
    if (isRejection(e)) return new Error(CANCELLED);
    if (e instanceof Error) return e;
    return new Error((e && e.message) || String(e));
};

// request(method, params): the session's request (lib/walletconnect-session.js).
export function createWalletConnectSigner({ request, getRegistry, timeoutMs = SIGN_TIMEOUT_MS, onPending }) {
    function ask(kind, method, params) {
        const id = nextRequestId();
        return new Promise((resolve, reject) => {
            let done = false;
            let close = null;
            const finish = (fn, value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (close) { try { close(); } catch (e) { /* a view bug must not hold the answer */ } }
                fn(value);
            };
            const timer = setTimeout(() => finish(reject, new Error(TIMEOUT_TEXT)), timeoutMs);
            if (onPending) {
                try { close = onPending({ id, kind, cancel: () => finish(reject, new Error(CANCELLED)) }) || null; } catch (e) { close = null; }
                if (done && close) { try { close(); } catch (e) { /* ignore */ } }
            }
            Promise.resolve().then(() => request(method, params)).then(
                (reply) => finish(resolve, { id, reply: reply || {} }),
                (e) => finish(reject, asError(e))
            );
        });
    }

    return {
        async signPayload(payload) {
            const { id, reply } = await ask('transaction', 'polkadot_signTransaction', { address: payload.address, transactionPayload: payload });
            if (reply.signedTransaction) return { id, signature: reply.signature, signedTransaction: reply.signedTransaction };
            const registry = getRegistry && getRegistry();
            if (!registry) throw new Error(NO_REGISTRY);
            return { id, signature: normaliseSignature(reply.signature, { message: payloadMessage(registry, payload), address: payload.address }) };
        },
        async signRaw(raw) {
            const message = rawMessage(raw.data);
            const { id, reply } = await ask('message', 'polkadot_signMessage', { address: raw.address, data: u8aToHex(message), type: 'bytes' });
            return { id, signature: normaliseSignature(reply.signature, { message, address: raw.address }) };
        }
    };
}
