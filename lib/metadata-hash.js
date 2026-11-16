// The CheckMetadataHash hash (RFC-78 merkleized metadata) of the runtime the
// explorer is connected to, for phone wallets signing over WalletConnect.
//
// Why: given withSignedTransaction and no metadata hash, Nova Wallet builds the
// transaction itself with the hash enabled (mode 1) and its own hash
// (nova-wallet-android PolkadotExternalSignInteractor.kt actualMetadataHash();
// nova-wallet-ios DAppExtrinsicBuilderOperationFactory.swift:240-275). So the
// explorer computes the same hash and sends mode 1 with it: the wallet then
// signs exactly the payload the explorer verifies (lib/walletconnect-signer.js).
//
// Inputs: the runtime's v15 metadata (Metadata_metadata_at_version(15)), its
// spec name and version, SS58 prefix 88, and the token the runtime was built
// with: polkadex-node runtimes/mainnet/build.rs:23,
// enable_metadata_hash("PDEX", 12). The hash the chain checks is computed
// from those at build time, so ours must use the same, not the node's
// system_properties.
//
// The merkleize library (@polkadot-api/merkleize-metadata, pinned) is a
// dynamic import: it is fetched the first time a phone signs, never for an
// ordinary visit. One read and one hash per runtime (genesis + spec version),
// cached. Any failure gives null (never throws, never a guess) and is kept in
// lastError() for ?wcdebug=1; the signer then falls back to mode 0.
//
// Tested in test/walletconnect-signature.test.js.

import { compactFromU8a, hexToU8a, isHex, u8aToHex, u8aToU8a } from '@polkadot/util';

export const PDEX_METADATA_HASH_INPUTS = Object.freeze({ decimals: 12, tokenSymbol: 'PDEX', base58Prefix: 88 });
// A node slower than this to hand over ~1-2 MB of metadata: sign in mode 0
// rather than keep the person waiting before the phone is even asked.
export const HASH_TIMEOUT_MS = 20000;

const MAGIC = [0x6d, 0x65, 0x74, 0x61];   // "meta"

// The v15 metadata bytes from the Metadata_metadata_at_version result, an
// Option<Vec<u8>> (hex, Uint8Array or the api's Bytes). None is null.
export function metadataV15FromCallResult(result) {
    const raw = typeof result === 'string' ? (isHex(result) ? hexToU8a(result) : new Uint8Array()) : u8aToU8a(result);
    if (!raw.length || raw[0] === 0) return null;
    if (raw[0] !== 1) throw new Error('Metadata_metadata_at_version: not an Option');
    const [offset, length] = compactFromU8a(raw.subarray(1));
    const bytes = raw.subarray(1 + offset, 1 + offset + length.toNumber());
    if (bytes.length !== length.toNumber() || bytes.length < 5 || MAGIC.some((b, i) => bytes[i] !== b)) {
        throw new Error('Metadata_metadata_at_version: not metadata');
    }
    return bytes;
}

// merkleize: the library's merkleizeMetadata. Throws when the bytes are not
// the given runtime (the library checks spec name, version and SS58 prefix).
export function metadataHashFromV15(merkleize, metadataBytes, { specName, specVersion }) {
    const m = merkleize(metadataBytes, { ...PDEX_METADATA_HASH_INPUTS, specName, specVersion });
    return u8aToHex(m.digest());
}

function within(ms, promise) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no metadata from the node in ${Math.round(ms / 1000)} s`)), ms); })
    ]).finally(() => clearTimeout(timer));
}

// getApi(): the connected ApiPromise, or null.
export function createMetadataHashSource({ getApi, load = () => import('@polkadot-api/merkleize-metadata'), timeoutMs = HASH_TIMEOUT_MS }) {
    const cache = new Map();
    let lastError = '';

    async function compute(api) {
        const specName = api.runtimeVersion.specName.toString();
        const specVersion = api.runtimeVersion.specVersion.toNumber();
        const [lib, result] = await Promise.all([load(), api.rpc.state.call('Metadata_metadata_at_version', '0x0f000000')]);
        const bytes = metadataV15FromCallResult(result);
        if (!bytes) throw new Error('the node has no v15 metadata');
        return metadataHashFromV15(lib.merkleizeMetadata, bytes, { specName, specVersion });
    }

    return {
        // The hash as 0x-hex, or null.
        get() {
            let api, key;
            try {
                api = getApi && getApi();
                if (!api || !api.runtimeVersion || !api.rpc || !api.rpc.state || typeof api.rpc.state.call !== 'function') return Promise.resolve(null);
                key = String(api.genesisHash && api.genesisHash.toHex ? api.genesisHash.toHex() : api.genesisHash) + ':' + api.runtimeVersion.specVersion.toString();
            } catch (e) {
                lastError = (e && e.message) || String(e);
                return Promise.resolve(null);
            }
            if (!cache.has(key)) {
                cache.set(key, within(timeoutMs, Promise.resolve().then(() => compute(api))).then(
                    (hash) => { lastError = ''; return hash; },
                    (e) => { lastError = (e && e.message) || String(e); cache.delete(key); return null; }
                ));
            }
            return cache.get(key);
        },
        lastError: () => lastError
    };
}
