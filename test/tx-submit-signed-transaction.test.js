// Wallets that hand back a whole signed transaction (signPayload returning
// `signedTransaction`, as Ledger metadata-hash flows and some newer wallet
// builds do) must be accepted, and the call data in what they return must be
// the call the explorer built.
//
// @polkadot/api 17.0.2, submittable/createClass.js #signViaSigner:
//   :206 a `signedTransaction` without `withSignedTransaction: true` THROWS
//        ("may not be submitted when withSignedTransaction is disabled");
//   :225 with it, the returned extrinsic must be signed;
//   :230 + :265-269 with `allowCallDataAlteration: false` its method must
//        equal the payload's method, otherwise "call data does not match";
//   :182 / :187 the wallet's bytes are what gets submitted.
// The default for allowCallDataAlteration is true (:194), so the explorer
// passes false explicitly.
//
// These tests run the REAL Submittable class from @polkadot/api against a fake
// api (no network) and a fake wallet signer, using the exact options object
// lib/tx-submit.js passes to signAndSend.
//
// Run: npm test

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { of } from 'rxjs';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import { createSubmittable } from '@polkadot/api/submittable';
import { toPromiseMethod } from '@polkadot/api/promise';
import { Keyring } from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { installPolkadotFixes } from '../lib/tx-extensions.js';
import { trackSignedTx, signAndSendOptions } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import { registryFromMetadata, remarkCall } from './helpers/extrinsic-builders.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

const GENESIS = '0x' + '22'.repeat(32);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 1)); };

let registry, pair;

// The api surface createClass touches on the signAndSend path, plus what
// trackSignedTx touches (on/off, getHeader).
function fakeApi() {
    const submitted = [];
    const listeners = {};
    const api = {
        registry,
        extrinsicType: 4,
        hasSubscriptions: true,
        genesisHash: registry.createType('Hash', GENESIS),
        runtimeVersion: registry.createType('RuntimeVersion', { specVersion: 1, transactionVersion: 1 }),
        call: {},
        derive: { tx: { signingInfo: () => of({ header: null, mortalLength: 64, nonce: registry.createType('Index', 5) }) } },
        rpc: {
            system: {},
            chain: { getHeader: () => Promise.resolve({ number: { toNumber: () => 7 } }) },
            author: {
                submitAndWatchExtrinsic: (ext) => {
                    submitted.push(typeof ext === 'string' ? ext : ext.toHex());
                    return of(registry.createType('ExtrinsicStatus', 'Ready'));
                }
            }
        },
        on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
        off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); }
    };
    const drop = () => (listeners.disconnected || []).slice().forEach(f => f());
    return { api, submitted, drop };
}

const remark = (data) => registry.createType('Call', remarkCall(registry, data));

function submittableFor(api, data = '0x1234') {
    return createSubmittable('promise', api, toPromiseMethod, registry)(remark(data));
}

// Signs the payload it is given, like an extension does.
function signatureFor(json) {
    const raw = registry.createType('ExtrinsicPayload', json, { version: json.version });
    return u8aToHex(raw.sign(pair).signature);
}

// A wallet that returns only { id, signature }: the classic extension.
const signatureOnlySigner = () => ({
    signPayload: async (json) => ({ id: 1, signature: signatureFor(json) })
});

// A wallet that also returns the whole signed transaction (Ledger
// metadata-hash flows). `callData` lets a test return a DIFFERENT call.
function signedTxSigner({ callData } = {}) {
    const out = { returned: null };
    out.signPayload = async (json) => {
        const signature = signatureFor(json);
        const method = callData ? remark(callData).toHex() : json.method;
        const ex = registry.createType('Extrinsic', { method }, { version: 4 });
        ex.addSignature(json.address, signature, json);
        out.returned = ex.toHex();
        return { id: 2, signature, signedTransaction: out.returned };
    };
    return out;
}

before(async () => {
    await cryptoWaitReady();
    registry = registryFromMetadata(substrateMetadata);
    pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri('//Alice');
});

describe('signAndSend options (lib/tx-submit.js)', () => {
    test('accept a returned signed transaction, never altered call data', () => {
        const signer = {};
        const o = signAndSendOptions(signer);
        assert.equal(o.signer, signer);
        assert.equal(o.withSignedTransaction, true);
        assert.equal(o.allowCallDataAlteration, false);
    });

    test('trackSignedTx passes exactly those options to signAndSend', async () => {
        let seen = null;
        const run = trackSignedTx({ api: { registry: {}, on() {}, off() {} }, action: { key: 'x' }, show: () => ({ stage: 'signing' }) });
        const signer = {};
        await run.send({ signAndSend: (addr, opts) => { seen = opts; return Promise.resolve(() => {}); } }, 'addr', signer);
        assert.deepEqual(seen, signAndSendOptions(signer));
    });
});

describe('the real @polkadot/api 17.0.2 Submittable with those options', () => {
    test('stock behaviour without the option: a signedTransaction wallet is REJECTED (why the option exists)', async () => {
        const { api } = fakeApi();
        const w = signedTxSigner();
        await assert.rejects(
            submittableFor(api).signAndSend(pair.address, { signer: w }, () => {}),
            /withSignedTransaction/
        );
    });

    test('a wallet that returns signedTransaction: its bytes are what gets submitted', async () => {
        const { api, submitted } = fakeApi();
        const w = signedTxSigner();
        const unsub = await submittableFor(api).signAndSend(pair.address, signAndSendOptions(w), () => {});
        unsub();
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0], w.returned);
        const back = registry.createType('Extrinsic', submitted[0]);
        assert.equal(back.isSigned, true);
        assert.equal(back.method.toHex(), remark('0x1234').toHex());
    });

    test('the tx hash the tracker reports is the hash of the bytes the wallet returned', async () => {
        const { api } = fakeApi();
        const w = signedTxSigner();
        let reported = null;
        const unsub = await submittableFor(api).signAndSend(pair.address, signAndSendOptions(w), (r) => { reported = r.txHash.toHex(); });
        await flush();
        unsub();
        assert.equal(reported, blake2AsHex(hexToU8a(w.returned)));
    });

    test('a wallet that returns only a signature still works: the explorer-built tx is submitted', async () => {
        const { api, submitted } = fakeApi();
        const tx = submittableFor(api);
        const unsub = await tx.signAndSend(pair.address, signAndSendOptions(signatureOnlySigner()), () => {});
        unsub();
        assert.equal(submitted.length, 1);
        const back = registry.createType('Extrinsic', submitted[0]);
        assert.equal(back.isSigned, true);
        assert.equal(back.signer.toString(), registry.createType('Address', pair.publicKey).toString());
        assert.equal(back.method.toHex(), remark('0x1234').toHex());
        assert.equal(back.nonce.toNumber(), 5);
    });

    test('a wallet that returns a signed transaction with DIFFERENT call data is refused, nothing submitted', async () => {
        const { api, submitted } = fakeApi();
        const w = signedTxSigner({ callData: '0xdeadbeef' });
        await assert.rejects(
            submittableFor(api).signAndSend(pair.address, signAndSendOptions(w), () => {}),
            /call data does not match/
        );
        assert.equal(submitted.length, 0);
    });

    test('end to end through trackSignedTx: signedTransaction wallet reaches Sent, no error', async () => {
        const { api, submitted, drop } = fakeApi();
        const shown = [];
        const errors = [];
        const w = signedTxSigner();
        const run = trackSignedTx({
            api, action: { id: 'a', key: 'balances.transfer', params: {} },
            show: (a, st, ev, err, ex) => { const m = buildTxModel(a, st, ev, err, ex); shown.push(m); return m; },
            onError: (t) => errors.push(t)
        });
        run.start();
        await run.send(submittableFor(api), pair.address, w);
        await flush();
        assert.deepEqual(errors, []);
        assert.equal(submitted[0], w.returned);
        assert.ok(shown.some(m => m.stage === 'broadcast'), `stages seen: ${shown.map(m => m.stage).join(',')}`);
        drop();   // stops the pre-inclusion timer
    });

    test('end to end through trackSignedTx: altered call data is shown as a failure', async () => {
        const { api, submitted } = fakeApi();
        const errors = [];
        const run = trackSignedTx({
            api, action: { id: 'a', key: 'balances.transfer', params: {} },
            show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex),
            onError: (t) => errors.push(t)
        });
        run.start();
        await run.send(submittableFor(api), pair.address, signedTxSigner({ callData: '0xdeadbeef' }));
        assert.equal(submitted.length, 0);
        assert.equal(errors.length, 1);
    });
});
