// ?wcdebug=1: what to tell support when a phone wallet's signature fails the
// explorer's check (lib/walletconnect-signer.js). Signatures and transaction
// payloads are public data; the WalletConnect session (topic, keys) is never
// part of a report: the source adds only the wallet's public metadata.
//
//   buildDebugReport(...)   the payload sent, the exact bytes verified, the
//                           reply, the metadata hash, and which variants the
//                           signature does verify against
//   signatureVariants(...)  "mode0|mode1+hash" (also with nonce -1, +1, +2)
//                           or "signedTransaction fields (...)"
//                           x "standard|unhashed|blake2" x scheme x
//                           "prefixed|bare64", only those that verify
//   debugReportText(report) a header line, then the report as JSON
//
// "standard" is the rule wallets and polkadot.js use: the SCALE payload,
// blake2-256 hashed when longer than 256 bytes.
//
// Tested in test/walletconnect-signature.test.js.

import { hexToU8a, isHex, u8aToHex } from '@polkadot/util';
import { blake2AsU8a, decodeAddress, sr25519Verify, ed25519Verify, secp256k1Verify } from '@polkadot/util-crypto';

const RULES = {
    standard: (u8a) => (u8a.length > 256 ? blake2AsU8a(u8a, 256) : u8a),
    unhashed: (u8a) => u8a,
    blake2: (u8a) => blake2AsU8a(u8a, 256)
};
const VERIFY = {
    sr25519: (m, s, k) => sr25519Verify(m, s, k),
    ed25519: (m, s, k) => ed25519Verify(m, s, k),
    ecdsa: (m, s, k) => secp256k1Verify(m, s, k, 'blake2', true)
};

function payloadBytes(registry, payload) {
    return registry.createType('ExtrinsicPayload', payload, { version: payload.version }).toU8a({ method: true });
}

function decodeTx(registry, signedTransaction) {
    if (!signedTransaction) return null;
    try {
        const ext = registry.createType('Extrinsic', signedTransaction);
        return ext.isSigned ? ext : null;
    } catch (e) {
        return null;
    }
}
const modeOf = (ext) => (ext.mode ? Number(ext.mode.toString()) : 0);

export function signedTransactionFields(registry, signedTransaction) {
    if (!signedTransaction) return null;
    try {
        const ext = registry.createType('Extrinsic', signedTransaction);
        return {
            signed: ext.isSigned,
            version: ext.version,
            signer: ext.isSigned ? ext.signer.toString() : null,
            method: ext.method.toHex(),
            era: ext.era.toHex(),
            nonce: ext.nonce.toNumber(),
            tip: ext.tip.toString(),
            mode: modeOf(ext),
            assetId: ext.assetId && ext.assetId.isSome ? ext.assetId.toHex() : null,
            signature: ext.isSigned ? ext.inner.signature.multiSignature.toHex() : null
        };
    } catch (e) {
        return { error: (e && e.message) || String(e) };
    }
}

// The labels of every variant the signature verifies against, or [].
export function signatureVariants({ registry, sent, metadataHash, signature, signedTransaction }) {
    if (typeof signature !== 'string' || !isHex(signature)) return [];
    let key;
    try { key = decodeAddress(sent.address); } catch (e) { return []; }
    const bytes = hexToU8a(signature);
    let raw, form;
    if ((bytes.length === 65 && bytes[0] <= 1) || (bytes.length === 66 && bytes[0] === 2)) { raw = bytes.subarray(1); form = 'prefixed'; }
    else if (bytes.length === 64) { raw = bytes; form = 'bare64'; }
    else return [];
    const schemes = raw.length === 65 ? ['ecdsa'] : ['sr25519', 'ed25519'];

    const bases = [['mode0', { ...sent, mode: 0, metadataHash: null }]];
    if (metadataHash) bases.push(['mode1+hash', { ...sent, mode: 1, metadataHash }]);
    const payloads = [...bases];
    // Nearby nonces: Nova Android signs with the nonce it reads itself
    // (LeafSigner.setSignerDataForSubmission), not the payload's.
    let nonce = null;
    try { nonce = registry.createType('Compact<Index>', sent.nonce).toNumber(); } catch (e) { nonce = null; }
    if (nonce != null) {
        for (const [label, base] of bases) {
            for (const n of [nonce - 1, nonce + 1, nonce + 2]) {
                if (n >= 0) payloads.push([`${label} nonce ${n}`, { ...base, nonce: n }]);
            }
        }
    }
    const ext = decodeTx(registry, signedTransaction);
    if (ext) {
        const mode = modeOf(ext);
        payloads.push([`signedTransaction fields (mode ${mode}, nonce ${ext.nonce.toNumber()})`, {
            ...sent, era: ext.era.toHex(), nonce: ext.nonce.toHex(), tip: ext.tip.toHex(), mode, metadataHash: mode ? (metadataHash || null) : null
        }]);
    }

    const hits = [];
    for (const [label, payload] of payloads) {
        let u8a;
        try { u8a = payloadBytes(registry, payload); } catch (e) { continue; }
        for (const [rule, make] of Object.entries(RULES)) {
            const message = make(u8a);
            for (const scheme of schemes) {
                let ok = false;
                try { ok = VERIFY[scheme](message, raw, key); } catch (e) { ok = false; }
                if (ok) hits.push(`${label} ${rule} ${scheme} ${form}`);
            }
        }
    }
    return hits;
}

// reply: what the wallet answered. message: the exact bytes verified.
export function buildDebugReport({ registry, sent, message, reply = {}, metadataHash = null, error, hashError = '' }) {
    let length = 0;
    try { length = payloadBytes(registry, sent).length; } catch (e) { length = 0; }
    const fields = signedTransactionFields(registry, reply.signedTransaction);
    const signature = (fields && fields.signature) || reply.signature;
    return {
        error: String(error || ''),
        payloadSent: sent,
        verifiedBytes: message ? u8aToHex(message) : null,
        verifiedBytesRule: length > 256 ? `blake2-256 of the payload (${length} bytes)` : `payload as is (${length} bytes)`,
        signature: reply.signature == null ? null : reply.signature,
        signedTransaction: reply.signedTransaction == null ? null : reply.signedTransaction,
        signedTransactionFields: fields,
        metadataHash: metadataHash || null,
        metadataHashError: hashError || null,
        variants: signatureVariants({ registry, sent, metadataHash, signature, signedTransaction: reply.signedTransaction })
    };
}

export function debugReportText(report) {
    return 'WalletConnect signature check failed. Support details (public data only: payload, bytes, signature):\n'
        + JSON.stringify(report, null, 2);
}
