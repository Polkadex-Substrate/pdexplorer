// A @polkadot/api Signer whose wallet is a phone on the other end of a
// WalletConnect session (Reown "Polkadot RPC" reference, fetched 2026-11-15:
// docs.reown.com/advanced/multichain/rpc-reference/polkadot-rpc.md).
//
//   signPayload(payload) -> polkadot_signTransaction { address, transactionPayload: payload }
//   signRaw(raw)         -> polkadot_signMessage { address, data, type: 'bytes', message }
//                           data is the message wrapped in <Bytes>...</Bytes>
//                           and hex encoded, as the spec says the dApp must do;
//                           message repeats data (see signRaw below).
//   both return          { id, signature } (and signedTransaction when the
//                           wallet sends one), id unique and increasing.
//
// Every signature is verified before it is used, against the account and the
// bytes it must sign, and must be a MultiSignature (a type byte, then the
// signature) for @polkadot/api to put it in an extrinsic. Wallets differ: the
// Reown example reply is 64 bare bytes. So:
//   65 bytes, first 0x00 or 0x01   kept if it verifies as that scheme
//                                  (ed25519 / sr25519) for the account
//   66 bytes, first 0x02           kept if it verifies as ecdsa
//   64 bytes                       prefixed 0x01 only if it verifies as sr25519,
//                                  0x00 only if ed25519
//   anything that does not verify  an error. Never a guess.
//   anything else                  an error naming the length.
// The bytes: for a transaction, the SCALE ExtrinsicPayload, blake2-256 hashed
// above 256 bytes (as polkadot.js signs it), and exactly those bytes. For a
// message, the <Bytes>-wrapped message; like signatureVerify, and like the
// server's sign-in check, the same message unwrapped is accepted too.
//
// The payload sent (phonePayload). Nova Wallet, given withSignedTransaction
// and no metadata hash, rebuilds the transaction with CheckMetadataHash on
// (mode 1) and its own hash, and on iOS with its own nonce:
//   nova-wallet-android feature-external-sign-impl/.../polkadot/
//     PolkadotExternalSignInteractor.kt, actualMetadataHash() and
//     analyzeAndSign(); the reply PolkadotSignerResult(id, signature,
//     signedTransaction) (feature-wallet-connect-impl/.../PolkadotSignRequest.kt)
//   nova-wallet-ios DAppExtrinsicBuilderOperationFactory.swift:119-160 (nonce),
//     :224 (always returns the transaction), :240-275 (metadata hash)
// Verified against our mode 0 bytes, that failed (CEO phone test, spec 393).
// So when getMetadataHash() gives the chain's hash (lib/metadata-hash.js) we
// send mode 1 with it, and always withSignedTransaction: false, which makes
// both apps sign exactly the payload sent. Without a hash: mode 0, as before.
// A mode 1 signature is then put into a transaction here (signedTransaction),
// because @polkadot/api would otherwise rebuild it from its own mode 0 payload.
//
// A reply carrying signedTransaction is decoded with the chain's registry and
// must be, byte for byte, the transaction we sent signed with the signature
// inside it: signer, call, era, nonce, tip, fee asset, mode. Otherwise
// DIFFERENT_TX and nothing is sent. That signature is then verified as above
// against the bytes sent, so the signature returned always matches the bytes
// submitted.
//
// onVerifyFailure(report) (?wcdebug=1, lib/walletconnect-debug.js) hears about
// every failed check before the error is thrown; it cannot change the error.
//
// While the phone decides, onPending({ id, kind, cancel }) is told and the
// function it returns is called when the answer, a timeout or a cancel ends
// the wait. Cancel rejects with "Cancelled" (what extensions say); so does a
// rejection on the phone. A late answer after that is ignored.
//
// The wait is SIGNING_CAP_MS (lib/tx-status.js, 3 minutes), the same cap after
// which the transaction card gives up on the wallet, so the notice and the
// card end together. WalletConnect's own request lifetime cannot be that short
// (the sign client refuses an expiry under 5 minutes), so requests keep its
// default; an answer after our timeout is ignored. cancelAll() ends every
// pending request at once, for when the session ends (lib/walletconnect-source.js).
//
// No update(): WalletConnect has no status channel back to the wallet, so
// lib/signer-tracking.js passes this signer through and relays nothing.
//
// Tested in test/walletconnect.test.js.

import { hexToU8a, isHex, u8aToHex, u8aWrapBytes, u8aEq, stringToU8a, u8aConcat } from '@polkadot/util';
import { signatureVerify, blake2AsU8a, decodeAddress, sr25519Verify, ed25519Verify, secp256k1Verify } from '@polkadot/util-crypto';
import { SIGNING_CAP_MS } from './tx-status.js';
import { buildDebugReport } from './walletconnect-debug.js';

export const SIGN_TIMEOUT_MS = SIGNING_CAP_MS;
export const CANCELLED = 'Cancelled';
export const TIMEOUT_TEXT = `No answer from your phone wallet in ${Math.round(SIGN_TIMEOUT_MS / 60000)} minutes. Nothing was signed.`;
export const SESSION_ENDED_TEXT = 'Your phone wallet connection ended. Nothing was signed.';
export const DIFFERENT_TX = 'The wallet returned a different transaction; nothing was sent.';
const MISMATCH = 'The phone wallet\'s signature does not match this account and request. Nothing was sent.';
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

// The scheme each MultiSignature type byte names, and that scheme's verifier
// on exactly the given bytes (no <Bytes> wrapping either way).
const SCHEME = { 0: 'ed25519', 1: 'sr25519', 2: 'ecdsa' };
const EXACT = {
    ed25519: (m, sig, key) => ed25519Verify(m, sig, key),
    sr25519: (m, sig, key) => sr25519Verify(m, sig, key),
    ecdsa: (m, sig, key) => secp256k1Verify(m, sig, key, 'blake2', true)
};

// True when multi (type byte + signature) verifies for address over message
// as the scheme its type byte names. exact: no wrapped or unwrapped variant.
function verifiesAs(multi, message, address, exact) {
    const scheme = SCHEME[multi[0]];
    try {
        const r = signatureVerify(message, multi, address);
        if (!r.isValid || r.crypto !== scheme) return false;
        return !exact || EXACT[scheme](message, multi.subarray(1), decodeAddress(address));
    } catch (e) {
        return false;
    }
}

// exact: true for transactions (the chain checks those bytes and no others).
export function normaliseSignature(signature, { message, address, exact = false }) {
    if (typeof signature !== 'string' || !signature || !isHex(signature)) throw new Error('The phone wallet returned no usable signature. Nothing was sent.');
    const bytes = hexToU8a(signature);
    const n = bytes.length;
    let candidates;
    if (n === 65 && (bytes[0] === 0 || bytes[0] === 1)) candidates = [bytes];
    else if (n === 66 && bytes[0] === 2) candidates = [bytes];
    else if (n === 64) candidates = [u8aConcat(new Uint8Array([1]), bytes), u8aConcat(new Uint8Array([0]), bytes)];
    else throw new Error(`The phone wallet returned a signature of an unexpected size (${n} bytes). Nothing was sent.`);
    const hit = candidates.find(multi => verifiesAs(multi, message, address, exact));
    if (!hit) throw new Error(MISMATCH);
    return u8aToHex(hit);
}

// What the phone is asked to sign: our payload, withSignedTransaction false,
// and with a metadata hash (0x + 32 bytes) mode 1 and that hash, when the
// runtime has CheckMetadataHash.
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export function phonePayload(payload, metadataHash) {
    const sent = { ...payload, withSignedTransaction: false };
    const hasExt = Array.isArray(payload.signedExtensions) && payload.signedExtensions.includes('CheckMetadataHash');
    if (hasExt && typeof metadataHash === 'string' && HASH_RE.test(metadataHash)) {
        sent.mode = 1;
        sent.metadataHash = metadataHash.toLowerCase();
    }
    return sent;
}

// Our transaction for payload, signed with signature (a MultiSignature).
function signedFrom(registry, payload, signature) {
    const ext = registry.createType('Extrinsic', registry.createType('Call', payload.method), { version: payload.version });
    ext.addSignature(payload.address, signature, payload);
    return ext;
}

// A signedTransaction from the wallet: it must be exactly the transaction
// sent, signed with the signature inside it, and that signature must verify
// for the bytes sent. Returns that MultiSignature.
export function signatureFromSignedTransaction(registry, sent, signedTransaction, message) {
    let multi;
    try {
        const ext = registry.createType('Extrinsic', signedTransaction);
        if (!ext.isSigned) throw new Error(DIFFERENT_TX);
        multi = ext.inner.signature.multiSignature.toHex();
        if (!u8aEq(hexToU8a(signedTransaction), signedFrom(registry, sent, multi).toU8a())) throw new Error(DIFFERENT_TX);
    } catch (e) {
        throw new Error(DIFFERENT_TX);
    }
    return normaliseSignature(multi, { message, address: sent.address, exact: true });
}

const isRejection = (e) => /reject|denied|declined|cancel/i.test(String((e && e.message) || e || ''));
const asError = (e) => {
    if (isRejection(e)) return new Error(CANCELLED);
    if (e instanceof Error) return e;
    return new Error((e && e.message) || String(e));
};

// request(method, params): the session's request (lib/walletconnect-session.js).
// getMetadataHash(): the chain's CheckMetadataHash hash or null (lib/metadata-hash.js).
export function createWalletConnectSigner({ request, getRegistry, getMetadataHash, timeoutMs = SIGN_TIMEOUT_MS, onPending, onVerifyFailure }) {
    const pending = new Set();

    function ask(kind, method, params) {
        const id = nextRequestId();
        return new Promise((resolve, reject) => {
            let done = false;
            let close = null;
            const finish = (fn, value) => {
                if (done) return;
                done = true;
                pending.delete(abort);
                clearTimeout(timer);
                if (close) { try { close(); } catch (e) { /* a view bug must not hold the answer */ } }
                fn(value);
            };
            const abort = (message) => finish(reject, new Error(message));
            pending.add(abort);
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

    function registryOrRefuse() {
        const registry = getRegistry && getRegistry();
        if (!registry) throw new Error(NO_REGISTRY);
        return registry;
    }

    return {
        async signPayload(payload) {
            // Checked before the phone is asked: an answer could not be verified.
            const registry = registryOrRefuse();
            let hash = null;
            if (getMetadataHash) { try { hash = await getMetadataHash(); } catch (e) { hash = null; } }
            const sent = phonePayload(payload, hash);
            const withHash = sent.mode === 1 && sent.mode !== payload.mode;
            const message = payloadMessage(registry, sent);
            const { id, reply } = await ask('transaction', 'polkadot_signTransaction', { address: payload.address, transactionPayload: sent });
            try {
                if (reply.signedTransaction) {
                    return { id, signature: signatureFromSignedTransaction(registry, sent, reply.signedTransaction, message), signedTransaction: reply.signedTransaction };
                }
                const signature = normaliseSignature(reply.signature, { message, address: payload.address, exact: true });
                return withHash ? { id, signature, signedTransaction: signedFrom(registry, sent, signature).toHex() } : { id, signature };
            } catch (e) {
                if (onVerifyFailure) {
                    try { onVerifyFailure(buildDebugReport({ registry, sent, message, reply, metadataHash: withHash ? sent.metadataHash : null, error: e.message })); } catch (x) { /* a report must not change the answer */ }
                }
                throw e;
            }
        },
        // The params follow the Reown "Polkadot RPC" reference
        // (docs.reown.com/advanced/multichain/rpc-reference/polkadot-rpc.md):
        // a SignerPayloadRaw with the hex bytes in `data`. Some wallets read
        // the bytes from `message` instead (the field name in the reference's
        // example request), so `message` carries the same hex: either reading
        // signs the same bytes, and the signature is verified against them
        // below whichever the wallet used. (Not re-checked against the live
        // page in this change; it was offline.)
        async signRaw(raw) {
            const message = rawMessage(raw.data);
            const data = u8aToHex(message);
            const { id, reply } = await ask('message', 'polkadot_signMessage', { address: raw.address, data, type: 'bytes', message: data });
            return { id, signature: normaliseSignature(reply.signature, { message, address: raw.address }) };
        },
        // Ends every request still waiting on the phone (the session ended).
        cancelAll(message = SESSION_ENDED_TEXT) {
            for (const abort of [...pending]) abort(message);
        }
    };
}
