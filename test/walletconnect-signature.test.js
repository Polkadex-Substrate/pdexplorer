// WalletConnect signatures on the real Polkadex runtime (spec 393 metadata),
// after the CEO's phone test (Nova Wallet, mainnet 393, democracy.vote):
// "The phone wallet's signature does not match this account and request."
//
// What Nova does with polkadot_signTransaction (read 2026-11-15):
//   Android  feature-external-sign-impl/.../PolkadotExternalSignInteractor.kt
//            actualMetadataHash(): withSignedTransaction true and no
//            metadataHash in the payload -> it builds its own metadata proof,
//            signs with CheckMetadataHash Enabled (mode 1) and returns the
//            transaction as signedTransaction (PolkadotSignRequest.kt,
//            PolkadotSignerResult(id, signature, signedTransaction)).
//   iOS      DAppExtrinsicBuilderOperationFactory.swift:240-275 the same rule,
//            and with withSignedTransaction it also takes its own nonce
//            (:119-160) and always returns signedTransaction (:224).
// The explorer asked with withSignedTransaction: true and mode 0, so Nova
// signed mode 1 + its hash, while our verifier checked the signature against
// the mode 0 bytes: the rejection above. The fix: the explorer sends mode 1
// with the chain's metadata hash itself (and withSignedTransaction: false,
// so the wallet signs exactly that payload), and verifies against exactly
// those bytes.
//
// Keys are generated from a fresh mnemonic for each run; they belong to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { of, BehaviorSubject } from 'rxjs';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import { createSubmittable } from '@polkadot/api/submittable';
import { toPromiseMethod } from '@polkadot/api/promise';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate, signatureVerify, blake2AsU8a } from '@polkadot/util-crypto';
import { hexToU8a, u8aToHex, compactAddLength, u8aConcat } from '@polkadot/util';
import { merkleizeMetadata } from '@polkadot-api/merkleize-metadata';
import { installPolkadotFixes } from '../lib/tx-extensions.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { createWalletConnectSigner, payloadMessage, DIFFERENT_TX } from '../lib/walletconnect-signer.js';
import { trackSignedTx } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import * as metadataHashModule from '../lib/metadata-hash.js';
import * as debugModule from '../lib/walletconnect-debug.js';
import * as gateModule from '../lib/walletconnect-gate.js';
import * as config from '../lib/walletconnect-config.js';
import * as viewModule from '../lib/walletconnect-view.js';
import { createWalletConnectSession } from '../lib/walletconnect-session.js';
import { createWalletConnectSource } from '../lib/walletconnect-source.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MISMATCH_RE = /signature does not match this account and request/;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1)); };
// The metadata hash of the committed testnet 393 metadata (v15), with the
// runtime's own inputs: build.rs enable_metadata_hash("PDEX", 12), SS58 88,
// spec "node" 393. Pinned so a change in the merkleize library shows up here.
const HASH_393 = '0x4d22d65c48d3b63fccfe5c1ad6e6314507c05a08b119b8069a25ac96c6969704';

let fixture, registry, pair, other, V15;
before(async () => {
    await cryptoWaitReady();
    fixture = loadFixture('metadata-testnet-393.json');
    registry = registryFromMetadata(fixture.metadata);
    V15 = hexToU8a(fixture.metadataAtVersion['15']);
    pair = new Keyring({ type: 'sr25519', ss58Format: 88 }).addFromMnemonic(mnemonicGenerate());
    other = new Keyring({ type: 'sr25519', ss58Format: 88 }).addFromMnemonic(mnemonicGenerate());
});

// democracy.vote(ref, Standard { aye, Locked1x, balance }) located through the metadata.
function voteCall(ref = 7, balance = 10n ** 12n) {
    const p = registry.metadata.pallets.find(x => x.name.toString() === 'Democracy');
    const v = registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants.find(x => x.name.toString() === 'vote');
    return registry.createType('Call', {
        callIndex: [p.index.toNumber(), v.index.toNumber()],
        args: { ref_index: ref, vote: { Standard: { vote: { aye: true, conviction: 'Locked1x' }, balance } } }
    });
}

// The JSON @polkadot/api 17 hands to signPayload for this runtime (SignerPayload.toPayload()).
function payloadFor(address, { call = voteCall(), nonce = 3, withSignedTransaction = true } = {}) {
    return registry.createType('SignerPayload', {
        address, blockHash: '0x' + '11'.repeat(32), blockNumber: 256, era: registry.createType('ExtrinsicEra', { current: 256, period: 64 }),
        genesisHash: fixture.genesisHash, method: call, nonce, tip: 0,
        runtimeVersion: { specVersion: 393, transactionVersion: 3 }, signedExtensions: registry.signedExtensions, version: 4,
        withSignedTransaction
    }).toPayload();
}
const mode1 = (payload, hash = HASH_393) => ({ ...payload, mode: 1, metadataHash: hash });
const sign = (p, payload) => registry.createType('ExtrinsicPayload', payload, { version: 4 }).sign(p).signature;
const bare = (sig) => u8aToHex(hexToU8a(sig).slice(1));
const signedTx = (p, payload) => {
    const e = registry.createType('Extrinsic', registry.createType('Call', payload.method), { version: 4 });
    e.addSignature(p.address, sign(p, payload), payload);
    return e.toHex();
};
const signerWith = (reply, extra = {}) => {
    const calls = [];
    const signer = createWalletConnectSigner({
        request: async (method, params) => { calls.push({ method, params }); return typeof reply === 'function' ? reply(params) : reply; },
        getRegistry: () => registry, ...extra
    });
    return { signer, calls };
};
const withHash = (extra = {}) => ({ getMetadataHash: async () => HASH_393, ...extra });
// What api.rpc.state.call resolves to: Bytes made from the JSON-RPC hex result
// (from hex, Bytes takes the bytes as they are; from a Uint8Array it would
// read a length prefix first).
const rpcBytes = (u8a) => registry.createType('Bytes', u8aToHex(u8a));

// ─────────────────────────────────────────────────────────────────────────────
describe('reproduction: the verifier on a real spec 393 democracy.vote payload', () => {
    test('a correctly signed mode 0 payload is accepted: prefixed, bare 64 bytes, or as a signed transaction', async () => {
        const payload = payloadFor(pair.address);
        assert.equal(payload.mode, 0);
        assert.equal(payload.metadataHash, null);
        for (const reply of [{ signature: sign(pair, payload) }, { signature: bare(sign(pair, payload)) }, { signedTransaction: signedTx(pair, payload) }]) {
            const { signer } = signerWith(reply);
            const r = await signer.signPayload(payload);
            assert.ok(signatureVerify(payloadMessage(registry, payload), r.signature, pair.address).isValid);
        }
    });

    test('the phone test, exactly: Nova\'s mode 1 transaction is now accepted, because we asked for mode 1 with that hash', async () => {
        const payload = payloadFor(pair.address);
        const { signer, calls } = signerWith((params) => ({ signature: sign(pair, params.transactionPayload), signedTransaction: signedTx(pair, params.transactionPayload) }), withHash());
        const r = await signer.signPayload(payload);
        assert.equal(calls[0].params.transactionPayload.mode, 1);
        assert.equal(typeof r.signedTransaction, 'string');
        const ext = registry.createType('Extrinsic', r.signedTransaction);
        assert.equal(ext.mode.toNumber(), 1);
        assert.ok(signatureVerify(payloadMessage(registry, mode1(payload)), r.signature, pair.address).isValid);
    });

    test('without a hash (it could not be computed) a wallet\'s own mode 1 transaction is still refused, never guessed', async () => {
        const payload = payloadFor(pair.address);
        const { signer } = signerWith({ signedTransaction: signedTx(pair, mode1(payload)) });
        await assert.rejects(signer.signPayload(payload), (e) => e.message === DIFFERENT_TX);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('metadata hash (CheckMetadataHash, RFC-78) for the connected chain', () => {
    test('PDEX, 12 decimals, SS58 88: the inputs the runtime was built with', () => {
        assert.deepEqual({ ...metadataHashModule.PDEX_METADATA_HASH_INPUTS }, { decimals: 12, tokenSymbol: 'PDEX', base58Prefix: 88 });
        assert.ok(Object.isFrozen(metadataHashModule.PDEX_METADATA_HASH_INPUTS));
        assert.match(read('lib/metadata-hash.js'), /enable_metadata_hash\("PDEX", 12\)/, 'cites build.rs');
    });

    test('metadataHashFromV15: the merkleized digest of the v15 bytes, pinned for the 393 fixture; v16 gives the same', () => {
        const h = metadataHashModule.metadataHashFromV15(merkleizeMetadata, V15, { specName: 'node', specVersion: 393 });
        assert.equal(h, HASH_393);
        const direct = u8aToHex(merkleizeMetadata(V15, { decimals: 12, tokenSymbol: 'PDEX', base58Prefix: 88, specName: 'node', specVersion: 393 }).digest());
        assert.equal(h, direct);
        const v16 = metadataHashModule.metadataHashFromV15(merkleizeMetadata, hexToU8a(fixture.metadataAtVersion['16']), { specName: 'node', specVersion: 393 });
        assert.equal(v16, HASH_393);
    });

    test('metadataHashFromV15 refuses metadata that is not the running runtime (another spec version or name)', () => {
        assert.throws(() => metadataHashModule.metadataHashFromV15(merkleizeMetadata, V15, { specName: 'node', specVersion: 392 }));
        assert.throws(() => metadataHashModule.metadataHashFromV15(merkleizeMetadata, V15, { specName: 'polkadot', specVersion: 393 }));
    });

    test('metadataV15FromCallResult: Option<Vec<u8>> from Metadata_metadata_at_version, None is null, junk throws', () => {
        // Compared by fingerprint: a failing deepEqual on 2 MB would print (and allocate) a huge diff.
        const fp = (u8a) => (u8a instanceof Uint8Array ? u8a.length + ':' + u8aToHex(blake2AsU8a(u8a)) : String(u8a));
        const some = u8aConcat(new Uint8Array([1]), compactAddLength(V15));
        assert.equal(fp(metadataHashModule.metadataV15FromCallResult(some)), fp(V15));
        assert.equal(fp(metadataHashModule.metadataV15FromCallResult(u8aToHex(some))), fp(V15));
        assert.equal(fp(metadataHashModule.metadataV15FromCallResult(rpcBytes(some))), fp(V15), 'the api returns Bytes');
        assert.equal(metadataHashModule.metadataV15FromCallResult(new Uint8Array([0])), null);
        assert.throws(() => metadataHashModule.metadataV15FromCallResult(u8aConcat(new Uint8Array([1]), compactAddLength(new Uint8Array([1, 2, 3])))));
    });

    function fakeHashApi({ spec = 393, answer } = {}) {
        const calls = [];
        const api = {
            genesisHash: registry.createType('Hash', fixture.genesisHash),
            runtimeVersion: registry.createType('RuntimeVersion', { specName: 'node', specVersion: spec, transactionVersion: 3 }),
            rpc: { state: { call: async (method, data) => { calls.push({ method, data: String(data) }); return answer ? answer() : rpcBytes(u8aConcat(new Uint8Array([1]), compactAddLength(V15))); } } }
        };
        return { api, calls };
    }

    test('createMetadataHashSource reads v15 from the node once per runtime and caches the hash', async () => {
        const { api, calls } = fakeHashApi();
        const src = metadataHashModule.createMetadataHashSource({ getApi: () => api, load: async () => ({ merkleizeMetadata }) });
        assert.equal(await src.get(), HASH_393);
        assert.equal(await src.get(), HASH_393);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { method: 'Metadata_metadata_at_version', data: '0x0f000000' });
    });

    test('a new spec version is a new hash (the cache is per runtime)', async () => {
        const a = fakeHashApi();
        let api = a.api;
        const src = metadataHashModule.createMetadataHashSource({ getApi: () => api, load: async () => ({ merkleizeMetadata }) });
        await src.get();
        const b = fakeHashApi({ spec: 394 });
        api = b.api;
        assert.equal(await src.get(), null, 'the 393 metadata is not spec 394: no hash rather than a wrong one');
        assert.equal(b.calls.length, 1);
        assert.match(src.lastError(), /Spec version/i);
    });

    test('no api, a node without v15, a failed read or a failed import: null (never throws), and the next call tries again', async () => {
        assert.equal(await metadataHashModule.createMetadataHashSource({ getApi: () => null }).get(), null);
        const none = fakeHashApi({ answer: () => rpcBytes(new Uint8Array([0])) });
        assert.equal(await metadataHashModule.createMetadataHashSource({ getApi: () => none.api, load: async () => ({ merkleizeMetadata }) }).get(), null);
        let fail = true;
        const flaky = fakeHashApi({ answer: () => { if (fail) throw new Error('link down'); return rpcBytes(u8aConcat(new Uint8Array([1]), compactAddLength(V15))); } });
        const src = metadataHashModule.createMetadataHashSource({ getApi: () => flaky.api, load: async () => ({ merkleizeMetadata }) });
        assert.equal(await src.get(), null);
        assert.match(src.lastError(), /link down/);
        fail = false;
        assert.equal(await src.get(), HASH_393);
        const noLib = metadataHashModule.createMetadataHashSource({ getApi: () => fakeHashApi().api, load: async () => { throw new Error('chunk failed'); } });
        assert.equal(await noLib.get(), null);
    });

    test('a node that never answers: null after the time limit, so signing is not held up', async () => {
        const { api } = fakeHashApi({ answer: () => new Promise(() => {}) });
        const src = metadataHashModule.createMetadataHashSource({ getApi: () => api, load: async () => ({ merkleizeMetadata }), timeoutMs: 20 });
        assert.equal(await src.get(), null);
        assert.ok(metadataHashModule.HASH_TIMEOUT_MS >= 5000 && metadataHashModule.HASH_TIMEOUT_MS <= 30000);
    });

    test('the merkleize library is loaded lazily (a dynamic import), and pinned exactly in package.json', () => {
        const src = read('lib/metadata-hash.js');
        assert.match(src, /import\(\s*'@polkadot-api\/merkleize-metadata'\s*\)/);
        assert.ok(!/^\s*import\s[^(]*merkleize/m.test(src));
        const pkg = JSON.parse(read('package.json'));
        const v = (pkg.dependencies || {})['@polkadot-api/merkleize-metadata'] || (pkg.devDependencies || {})['@polkadot-api/merkleize-metadata'];
        assert.match(String(v), /^\d+\.\d+\.\d+$/, 'exact version, no range');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('signer: we send mode 1 with the chain\'s hash, the wallet signs exactly that', () => {
    test('the payload sent: ours with mode 1, the hash, and withSignedTransaction false; nothing else changed', async () => {
        const payload = payloadFor(pair.address);
        const { signer, calls } = signerWith((params) => ({ signature: sign(pair, params.transactionPayload) }), withHash());
        await signer.signPayload(payload);
        const sent = calls[0].params.transactionPayload;
        assert.deepEqual(sent, { ...payload, mode: 1, metadataHash: HASH_393, withSignedTransaction: false });
        assert.equal(calls[0].params.address, pair.address);
    });

    test('a signature over the mode 1 bytes (prefixed or bare) is accepted, and the signed transaction we return is ours with mode 1', async () => {
        const payload = payloadFor(pair.address);
        for (const shape of [(s) => s, bare]) {
            const { signer } = signerWith((params) => ({ signature: shape(sign(pair, params.transactionPayload)) }), withHash());
            const r = await signer.signPayload(payload);
            assert.equal(typeof r.signedTransaction, 'string', '@polkadot/api must submit mode 1, so we hand it the transaction');
            const ext = registry.createType('Extrinsic', r.signedTransaction);
            assert.equal(ext.isSigned, true);
            assert.equal(ext.mode.toNumber(), 1);
            assert.equal(ext.method.toHex(), payload.method);
            assert.equal(ext.nonce.toNumber(), 3);
            assert.equal(ext.signer.toString(), registry.createType('Address', pair.publicKey).toString());
            assert.equal(ext.inner.signature.multiSignature.toHex(), r.signature);
            assert.ok(signatureVerify(payloadMessage(registry, mode1(payload)), r.signature, pair.address).isValid);
        }
    });

    test('a long call (over 256 bytes) is verified against its blake2-256 hash, as wallets sign it', async () => {
        const remarkIdx = (() => {
            const p = registry.metadata.pallets.find(x => x.name.toString() === 'System');
            const v = registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants.find(x => x.name.toString() === 'remark');
            return [p.index.toNumber(), v.index.toNumber()];
        })();
        const call = registry.createType('Call', { callIndex: remarkIdx, args: { remark: '0x' + 'ab'.repeat(400) } });
        const payload = payloadFor(pair.address, { call });
        const u8a = registry.createType('ExtrinsicPayload', mode1(payload), { version: 4 }).toU8a({ method: true });
        assert.ok(u8a.length > 256);
        assert.deepEqual(payloadMessage(registry, mode1(payload)), blake2AsU8a(u8a, 256));
        const { signer } = signerWith((params) => ({ signature: sign(pair, params.transactionPayload) }), withHash());
        await signer.signPayload(payload);
    });

    test('Nova\'s reply when it was given the hash (a signed transaction, same nonce) is passed on unchanged', async () => {
        const payload = payloadFor(pair.address);
        let tx;
        const { signer } = signerWith((params) => { tx = signedTx(pair, params.transactionPayload); return { signature: sign(pair, params.transactionPayload), signedTransaction: tx }; }, withHash());
        const r = await signer.signPayload(payload);
        assert.equal(r.signedTransaction, tx);
    });

    test('still refused: a signature over the mode 0 bytes, over another hash, or by another account', async () => {
        const payload = payloadFor(pair.address);
        const cases = {
            'mode 0 bytes': { signature: sign(pair, payload) },
            'another hash': { signature: sign(pair, mode1(payload, '0x' + 'ee'.repeat(32))) },
            'another account': { signature: sign(other, mode1(payload)) }
        };
        for (const [what, reply] of Object.entries(cases)) {
            const { signer } = signerWith(reply, withHash());
            await assert.rejects(signer.signPayload(payload), MISMATCH_RE, what);
        }
    });

    test('still refused: a signed transaction that is not exactly ours (nonce, mode, fee asset, call, signer)', async () => {
        const payload = payloadFor(pair.address);
        const m1 = mode1(payload);
        const cases = {
            nonce: signedTx(pair, { ...m1, nonce: '0x00000004' }),
            'mode 0 back': signedTx(pair, payload),
            call: signedTx(pair, { ...m1, method: voteCall(8).toHex() }),
            signer: signedTx(other, { ...m1, address: other.address })
        };
        const assetId = registry.createType('SignerPayload', { ...payload, assetId: { Native: null }, runtimeVersion: { specVersion: 393, transactionVersion: 3 } }).toPayload().assetId;
        if (assetId) cases['fee asset'] = signedTx(pair, { ...m1, assetId });
        for (const [what, tx] of Object.entries(cases)) {
            const { signer } = signerWith({ signedTransaction: tx }, withHash());
            await assert.rejects(signer.signPayload(payload), (e) => e.message === DIFFERENT_TX, what);
        }
    });

    test('a signed transaction with our fields but trailing bytes is not ours', async () => {
        const payload = payloadFor(pair.address);
        const { signer } = signerWith((params) => ({ signedTransaction: signedTx(pair, params.transactionPayload) + 'ff' }), withHash());
        await assert.rejects(signer.signPayload(payload), (e) => e.message === DIFFERENT_TX);
    });

    test('no hash available (no getMetadataHash, null, or it throws): mode 0 as before, withSignedTransaction false, no transaction built', async () => {
        const payload = payloadFor(pair.address);
        for (const extra of [{}, { getMetadataHash: async () => null }, { getMetadataHash: async () => { throw new Error('x'); } }, { getMetadataHash: async () => '0x1234' }]) {
            const { signer, calls } = signerWith((params) => ({ signature: sign(pair, params.transactionPayload) }), extra);
            const r = await signer.signPayload(payload);
            assert.deepEqual(calls[0].params.transactionPayload, { ...payload, withSignedTransaction: false });
            assert.equal(r.signedTransaction, undefined);
            assert.ok(signatureVerify(payloadMessage(registry, payload), r.signature, pair.address).isValid);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real @polkadot/api Submittable on the 393 registry, a fake api.
// The status stream stays open (Ready) until end() says Invalid, which ends
// the tracker and its 90 s timers once the test has looked.
function fakeApi() {
    const submitted = [];
    const status = new BehaviorSubject(registry.createType('ExtrinsicStatus', 'Ready'));
    const api = {
        registry, extrinsicType: 4, hasSubscriptions: true,
        genesisHash: registry.createType('Hash', fixture.genesisHash),
        runtimeVersion: registry.createType('RuntimeVersion', { specName: 'node', specVersion: 393, transactionVersion: 3 }),
        call: {},
        derive: { tx: { signingInfo: () => of({ header: null, mortalLength: 64, nonce: registry.createType('Index', 3) }) } },
        rpc: {
            system: {},
            chain: { getHeader: () => Promise.resolve({ number: { toNumber: () => 7 } }) },
            author: { submitAndWatchExtrinsic: (ext) => { submitted.push(typeof ext === 'string' ? ext : ext.toHex()); return status; } }
        },
        on() {}, off() {}
    };
    return { api, submitted, end: () => status.next(registry.createType('ExtrinsicStatus', 'Invalid')) };
}

describe('tx-submit end to end on spec 393: what reaches the node', () => {
    for (const [label, replyOf] of [
        ['a signature only (Android with the hash given)', (p) => ({ signature: bare(sign(pair, p)) })],
        ['a signed transaction (iOS style)', (p) => ({ signature: sign(pair, p), signedTransaction: signedTx(pair, p) })]
    ]) {
        test(`democracy.vote through the phone, ${label}: mode 1 is submitted and its signature verifies for those bytes`, async () => {
            const { api, submitted, end } = fakeApi();
            const errors = [];
            let sent = null;
            const run = trackSignedTx({ api, action: { id: 'v', key: 'democracy.vote', params: {} }, show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex), onError: (t) => errors.push(t) });
            run.start();
            const signer = createWalletConnectSigner({ getRegistry: () => registry, getMetadataHash: async () => HASH_393, request: async (m, params) => { sent = params.transactionPayload; return replyOf(sent); } });
            const tx = createSubmittable('promise', api, toPromiseMethod, registry)(voteCall());
            await run.send(tx, pair.address, signer, { stillValid: () => true, assetId: 0 });
            await flush();
            assert.deepEqual(errors, []);
            assert.equal(submitted.length, 1);
            const back = registry.createType('Extrinsic', submitted[0]);
            assert.equal(back.mode.toNumber(), 1);
            assert.equal(back.method.toHex(), voteCall().toHex());
            const sig = back.inner.signature.multiSignature.toHex();
            assert.ok(signatureVerify(payloadMessage(registry, sent), sig, pair.address).isValid, 'the node gets bytes whose signature checks with the hash');
            assert.equal(sent.metadataHash, HASH_393);
            end();
            await flush();
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('diagnostic mode: ?wcdebug=1', () => {
    const memStorage = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

    test('off by default; ?wcdebug=1 stores it per browser, ?wcdebug=0 clears it; a throwing storage is not fatal', () => {
        const { walletConnectDebugEnabled } = gateModule;
        assert.equal(config.WC_DEBUG_KEY, 'pdex_wc_debug');
        const s = memStorage();
        assert.equal(walletConnectDebugEnabled({ storage: s, search: '' }), false);
        assert.equal(walletConnectDebugEnabled({ storage: s, search: '?wcdebug=1' }), true);
        assert.equal(s.getItem(config.WC_DEBUG_KEY), '1');
        assert.equal(walletConnectDebugEnabled({ storage: s, search: '?x=1' }), true);
        assert.equal(walletConnectDebugEnabled({ storage: s, search: '?wcdebug=0' }), false);
        assert.equal(s.getItem(config.WC_DEBUG_KEY), null);
        const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
        assert.equal(walletConnectDebugEnabled({ storage: bad, search: '?wcdebug=1' }), false);
    });

    test('signatureVariants names what a signature does verify against: mode 0 or 1, hashing rule, scheme, prefixed or bare', () => {
        const payload = payloadFor(pair.address);
        const sent = { ...mode1(payload), withSignedTransaction: false };
        const v0 = debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: sign(pair, payload) });
        assert.ok(v0.includes('mode0 standard sr25519 prefixed'), v0.join(' | '));
        assert.ok(!v0.some(v => v.startsWith('mode1')), v0.join(' | '));
        const v1 = debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: bare(sign(pair, mode1(payload))) });
        assert.ok(v1.includes('mode1+hash standard sr25519 bare64'), v1.join(' | '));
        const raw = registry.createType('ExtrinsicPayload', payload, { version: 4 }).toU8a({ method: true });
        const vb = debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: u8aToHex(pair.sign(blake2AsU8a(raw, 256), { withType: true })) });
        assert.ok(vb.includes('mode0 blake2 sr25519 prefixed'), vb.join(' | '));
        assert.deepEqual(debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: sign(other, payload) }), []);
        assert.deepEqual(debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: 'junk' }), []);
    });

    test('signatureVariants also tries the fields of a returned signed transaction (another nonce shows up)', () => {
        const payload = payloadFor(pair.address);
        const sent = { ...mode1(payload), withSignedTransaction: false };
        const tx = signedTx(pair, { ...mode1(payload), nonce: '0x00000009' });
        const sig = registry.createType('Extrinsic', tx).inner.signature.multiSignature.toHex();
        const v = debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: sig, signedTransaction: tx });
        assert.ok(v.includes('signedTransaction fields (mode 1, nonce 9) standard sr25519 prefixed'), v.join(' | '));
    });

    test('signatureVariants tries nearby nonces too (Nova Android signs with the nonce it reads itself)', () => {
        const payload = payloadFor(pair.address);
        const sent = { ...mode1(payload), withSignedTransaction: false };
        const v = debugModule.signatureVariants({ registry, sent, metadataHash: HASH_393, signature: sign(pair, { ...mode1(payload), nonce: '0x00000004' }) });
        assert.ok(v.includes('mode1+hash nonce 4 standard sr25519 prefixed'), v.join(' | '));
        assert.ok(!v.some(x => x.startsWith('mode1+hash standard')), 'not the nonce we sent');
    });

    test('on a failed check the signer reports once: payload sent, exact bytes verified, signature, transaction, hash, variants; the error is unchanged', async () => {
        const payload = payloadFor(pair.address);
        const reports = [];
        const wrong = sign(pair, payload);
        const { signer, calls } = signerWith({ signature: wrong }, withHash({ onVerifyFailure: (r) => reports.push(r) }));
        await assert.rejects(signer.signPayload(payload), MISMATCH_RE);
        assert.equal(reports.length, 1);
        const r = reports[0];
        assert.deepEqual(r.payloadSent, calls[0].params.transactionPayload);
        assert.equal(r.verifiedBytes, u8aToHex(payloadMessage(registry, calls[0].params.transactionPayload)));
        assert.match(r.verifiedBytesRule, /as is \(\d+ bytes\)/);
        assert.equal(r.signature, wrong);
        assert.equal(r.signedTransaction, null);
        assert.equal(r.metadataHash, HASH_393);
        assert.match(r.error, MISMATCH_RE);
        assert.ok(r.variants.includes('mode0 standard sr25519 prefixed'), r.variants.join(' | '));
    });

    test('a different transaction is reported with its decoded fields; success and a cancel report nothing', async () => {
        const payload = payloadFor(pair.address);
        const reports = [];
        const tx = signedTx(pair, { ...mode1(payload), nonce: '0x00000004' });
        await assert.rejects(signerWith({ signedTransaction: tx }, withHash({ onVerifyFailure: (r) => reports.push(r) })).signer.signPayload(payload), (e) => e.message === DIFFERENT_TX);
        assert.equal(reports.length, 1);
        assert.equal(reports[0].signedTransaction, tx);
        assert.equal(reports[0].signedTransactionFields.nonce, 4);
        assert.equal(reports[0].signedTransactionFields.mode, 1);
        await signerWith((p) => ({ signature: sign(pair, p.transactionPayload) }), withHash({ onVerifyFailure: (r) => reports.push(r) })).signer.signPayload(payload);
        await assert.rejects(createWalletConnectSigner({ request: async () => { throw { message: 'User rejected' }; }, getRegistry: () => registry, onVerifyFailure: (r) => reports.push(r) }).signPayload(payload));
        assert.equal(reports.length, 1);
    });

    test('a reporter that throws does not change the error the person sees', async () => {
        const payload = payloadFor(pair.address);
        const { signer } = signerWith({ signature: sign(other, payload) }, { onVerifyFailure: () => { throw new Error('view bug'); } });
        await assert.rejects(signer.signPayload(payload), MISMATCH_RE);
    });

    test('debugReportText is plain JSON with a header line; no WalletConnect topic, key or relay secret fields', () => {
        const text = debugModule.debugReportText({ error: 'x', wallet: { name: 'Nova Wallet', url: 'https://novawallet.io' }, payloadSent: {}, variants: [] });
        assert.match(text.split('\n')[0], /WalletConnect signature check/);
        const json = JSON.parse(text.slice(text.indexOf('{')));
        assert.equal(json.wallet.name, 'Nova Wallet');
        assert.ok(!/topic|symKey|privateKey|relay/i.test(text));
    });

    function wcSession(address, topic) {
        return {
            topic, pairingTopic: 'pairing-' + topic, relay: { protocol: 'irn' }, self: { publicKey: 'selfkey-' + topic },
            namespaces: { polkadot: { accounts: [`${config.POLKADEX_CAIP2}:${address}`], methods: [...config.WC_METHODS], events: [] } },
            peer: { publicKey: 'peerkey-' + topic, metadata: { name: 'Nova Wallet', description: 'Next-gen wallet', url: 'https://novawallet.io', icons: [], version: '9.9.9' } }
        };
    }
    function providerWith(session, reply) {
        class P {
            static async init() { return new P(); }
            constructor() { this.session = session; this.client = { core: { verify: { register: async () => '' } }, on() {}, request: async (args) => reply(args) }; }
            on() {} off() {}
            async connect() { return session; }
            async disconnect() {}
        }
        return P;
    }

    test('session.peerInfo(): name, url, description and version from the peer metadata only', async () => {
        const topic = 'f'.repeat(64);
        const s = createWalletConnectSession({ loadProvider: async () => providerWith(wcSession(pair.address, topic), () => ({})) });
        await s.restore();
        assert.deepEqual(s.peerInfo(), { name: 'Nova Wallet', url: 'https://novawallet.io', description: 'Next-gen wallet', version: '9.9.9' });
    });

    test('source with debug on: a failed check logs to the console and shows a copyable support block, without session secrets', async (t) => {
        const window = new Window({ url: 'https://explorer.test/wallet' });
        t.after(() => window.happyDOM.abort());
        const topic = 'a1'.repeat(32);
        const payload = payloadFor(pair.address);
        const P = providerWith(wcSession(pair.address, topic), () => ({ signature: sign(other, payload) }));
        const logged = [];
        const copied = [];
        const origWarn = console.warn;
        console.warn = (...a) => logged.push(a.join(' '));
        t.after(() => { console.warn = origWarn; });
        const src = createWalletConnectSource({
            loadProvider: async () => P, doc: window.document, getRegistry: () => registry, getApi: () => null,
            clipboard: { writeText: async (x) => { copied.push(x); } }, debug: true
        });
        await src.restore();
        const ext = await src.provider.enable();
        await assert.rejects(ext.signer.signPayload(payload), MISMATCH_RE);
        const box = window.document.querySelector('.wc-debug');
        assert.ok(box, 'support block shown');
        const text = box.querySelector('textarea').value;
        assert.match(text, /WalletConnect signature check/);
        assert.match(text, /Nova Wallet/);
        assert.match(text, /9\.9\.9/);
        assert.ok(text.includes(payload.method), 'the payload we sent');
        for (const secret of [topic, 'pairing-' + topic, 'selfkey-', 'peerkey-']) assert.ok(!text.includes(secret), 'leaks ' + secret);
        assert.ok(logged.some(l => l.includes('WalletConnect signature check')), 'logged to the console');
        assert.ok(!logged.join('\n').includes(topic));
        box.querySelector('.wc-debug-copy').click();
        await flush();
        assert.equal(copied[0], text);
        box.querySelector('.wc-debug-close').click();
        assert.equal(window.document.querySelector('.wc-debug'), null);
    });

    test('source with debug off: the same failure shows no block and logs nothing', async (t) => {
        const window = new Window({ url: 'https://explorer.test/wallet' });
        t.after(() => window.happyDOM.abort());
        const payload = payloadFor(pair.address);
        const P = providerWith(wcSession(pair.address, 'b2'.repeat(32)), () => ({ signature: sign(other, payload) }));
        const logged = [];
        const origWarn = console.warn;
        console.warn = (...a) => logged.push(a.join(' '));
        t.after(() => { console.warn = origWarn; });
        const src = createWalletConnectSource({ loadProvider: async () => P, doc: window.document, getRegistry: () => registry, getApi: () => null, clipboard: { writeText: async () => {} } });
        await src.restore();
        await assert.rejects((await src.provider.enable()).signer.signPayload(payload), MISMATCH_RE);
        assert.equal(window.document.querySelector('.wc-debug'), null);
        assert.equal(logged.length, 0);
    });

    test('showDebugReport replaces an earlier block instead of stacking them', (t) => {
        const window = new Window({ url: 'https://explorer.test/' });
        t.after(() => window.happyDOM.abort());
        viewModule.showDebugReport(window.document, { text: 'one', clipboard: { writeText: async () => {} } });
        viewModule.showDebugReport(window.document, { text: 'two <b>x</b>', clipboard: { writeText: async () => {} } });
        const boxes = window.document.querySelectorAll('.wc-debug');
        assert.equal(boxes.length, 1);
        assert.equal(boxes[0].querySelector('textarea').value, 'two <b>x</b>');
        assert.equal(boxes[0].querySelector('b'), null, 'text, not HTML');
    });

    test('script.js passes getApi and the debug switch to the WalletConnect source', () => {
        const SCRIPT = read('script.js');
        assert.match(SCRIPT, /walletConnectDebugEnabled\(\{\s*storage: localStorage, search: window\.location\.search\s*\}\)/);
        assert.match(SCRIPT, /getApi: \(\) => globalApi/);
        assert.ok(SCRIPT.split('\n').length < 15000);
    });
});
