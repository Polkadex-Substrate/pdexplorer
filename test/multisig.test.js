import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress, decodeAddress, blake2AsHex } from '@polkadot/util-crypto';
import metadata from '@polkadot/types-support/metadata/static-substrate';
import { mockProvider } from './helpers/mock-provider.js';
import { normalizeMultisig, createMultisigStore, MULTISIG_STORAGE_KEY, decodeMultisigCall, prepareMultisig, recoverMultisigCall } from '../lib/multisig.js';
import { evaluateEvents, successCopy, buildTxModel } from '../lib/tx-status.js';

const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = addr(1), B = addr(2), C = addr(3), D = addr(4);
const multisig = normalizeMultisig({ name: 'Team', signers: [C, A, B], threshold: 2 });
const memory = () => { const m = new Map(); return { getItem: k => m.get(k), setItem: (k, v) => m.set(k, v) }; };
let chain;
before(async () => { chain = await ApiPromise.create({ provider: mockProvider({ metadataHex: metadata }).provider, noInitWarn: true }); });
after(async () => { await chain?.disconnect(); });

// Real metadata-driven calls and SCALE encoding, with only chain storage and
// fee queries stubbed. No private keys, signatures, or network submissions.
function world() {
    let pending = null;
    const fees = [];
    const withFee = tx => {
        tx.paymentInfo = async signer => { fees.push(signer); return { partialFee: 123n, weight: { refTime: '100000', proofSize: '256' } }; };
        return tx;
    };
    const tx = call => withFee(chain.tx(call));
    tx.multisig = Object.fromEntries(['approveAsMulti', 'asMulti', 'asMultiThreshold1', 'cancelAsMulti'].map(name => [name, (...args) => withFee(chain.tx.multisig[name](...args))]));
    const api = {
        tx, registry: chain.registry, genesisHash: chain.genesisHash, runtimeVersion: chain.runtimeVersion,
        consts: { multisig: { maxSignatories: 100, depositBase: 10, depositFactor: 2 } },
        query: { multisig: { multisigs: async () => ({ isNone: !pending, unwrap: () => pending }) } }
    };
    const callHex = chain.tx.balances.transferKeepAlive(D, '1000000000000').method.toHex();
    const callHash = blake2AsHex(callHex);
    return { api, fees, callHex, callHash, setPending: (approvals, depositor = A, when = { height: 25, index: 3 }) => { pending = approvals ? { approvals, depositor, when, deposit: 14 } : null; },
        prepare: (signer = A, more = {}) => prepareMultisig({ api, multisig, signer, callHex, ...more }) };
}

test('import re-derives the same account regardless of signer order and address prefix', () => {
    assert.equal(normalizeMultisig({ signers: [addr(2, 42), addr(3, 0), A], threshold: '2', address: multisig.address }).address, multisig.address);
    assert.notEqual(normalizeMultisig({ signers: [A, B, C], threshold: 3 }).address, multisig.address);
    assert.throws(() => normalizeMultisig({ ...multisig, address: D }), /do not match/);
    assert.throws(() => normalizeMultisig({ ...multisig, signers: [A, addr(1, 42)] }), /different account/);
    for (const threshold of [0, 4, 1.5, '2no', Infinity]) assert.throws(() => normalizeMultisig({ ...multisig, threshold }), /threshold/);
    assert.throws(() => normalizeMultisig({ ...multisig, signers: [A, '0x' + '11'.repeat(32)] }), /invalid/);
});

test('saved multisigs survive reload and corrupted or mismatched definitions are excluded', () => {
    const storage = memory();
    createMultisigStore(storage).save(multisig);
    assert.deepEqual(createMultisigStore(storage).find(addr(9)), null);
    assert.deepEqual(createMultisigStore(storage).find(encodeAddress(decodeAddress(multisig.address), 42)), multisig);
    createMultisigStore(storage).save({ ...multisig, name: 'Renamed' });
    assert.equal(createMultisigStore(storage).list().length, 1);
    storage.setItem(MULTISIG_STORAGE_KEY, JSON.stringify([multisig, { ...multisig, address: D }, null]));
    assert.deepEqual(createMultisigStore(storage).list(), [multisig]);
    assert.throws(() => createMultisigStore({ getItem() {}, setItem() { throw new Error(); } }).save(multisig), /could not save/);
});

test('2-of-3: first approval reserves a signer deposit; second signer executes the exact transfer', async () => {
    const w = world();
    const first = await w.prepare();
    assert.equal(first.kind, 'approve');
    assert.equal(first.tx.method.method, 'asMulti');
    assert.equal(first.tx.method.args[2].isNone, true);
    assert.equal(first.tx.method.args[3].toHex(), w.callHex);
    assert.equal(first.deposit, '14');
    assert.deepEqual(w.fees, [multisig.address, A], 'inner weight uses multisig; outer fee uses individual signer');
    assert.deepEqual(Array.from(first.tx.method.args[1], a => encodeAddress(decodeAddress(a.toString()), 88)), [B, C]);
    w.setPending([A]);
    const final = await w.prepare(B, { mode: 'approve', callHash: first.callHash });
    assert.equal(final.kind, 'execute');
    assert.equal(final.tx.method.method, 'asMulti');
    assert.deepEqual(final.tx.method.args[2].unwrap().toJSON(), { height: 25, index: 3 });
    assert.equal(final.tx.method.args[3].toHex(), w.callHex);
    assert.equal(final.deposit, '0');
    assert.deepEqual(final.tx.method.args[4].toJSON(), { refTime: 100000, proofSize: 256 });
    const decoded = chain.registry.createType('Call', final.tx.method.toHex());
    assert.equal(decoded.args[3].args[1].toString(), '1000000000000');
});

test('3-of-3: intermediate approvals do not claim to execute; duplicate approvals are rejected', async () => {
    const w = world();
    const m = normalizeMultisig({ signers: [A, B, C], threshold: 3 });
    w.setPending([A]);
    const second = await w.prepare(B, { multisig: m, mode: 'approve' });
    assert.equal(second.kind, 'approve');
    assert.equal(second.tx.method.method, 'approveAsMulti');
    await assert.rejects(w.prepare(A, { multisig: m, mode: 'approve' }), /already approved/);
    w.setPending([A, B]);
    assert.equal((await w.prepare(C, { multisig: m, mode: 'approve' })).kind, 'execute');
});

test('other signers recover exact call data from the first approval, including a batched extrinsic', async () => {
    const w = world(); const first = await w.prepare();
    w.api.rpc = { chain: {
        getBlockHash: async height => { assert.equal(height, '25'); return 'block25'; },
        getBlock: async hash => { assert.equal(hash, 'block25'); return { block: { extrinsics: [chain.tx.utility.batch([first.tx])] } }; }
    } };
    assert.equal(await recoverMultisigCall(w.api, { when: { height: '25', index: '0' } }, w.callHash), w.callHex);
    assert.equal(await recoverMultisigCall(w.api, { when: { height: '25', index: '0' } }, '0x' + '00'.repeat(32)), '');
});

test('an existing approver can execute a hash-only transaction that already has enough approvals', async () => {
    const w = world(); w.setPending([A, B]);
    assert.equal((await w.prepare(A, { mode: 'approve' })).tx.method.method, 'asMulti');
});

test('cancellation requires the depositor and uses the current timepoint without needing call data', async () => {
    const w = world(); w.setPending([A]);
    await assert.rejects(w.prepare(B, { mode: 'cancel', callHash: w.callHash }), /Only the account/);
    const cancelled = await w.prepare(A, { mode: 'cancel', callHash: w.callHash, callHex: undefined });
    assert.equal(cancelled.tx.method.method, 'cancelAsMulti');
    assert.deepEqual(cancelled.tx.method.args[2].toJSON(), { height: 25, index: 3 });
    assert.equal(cancelled.tx.method.args[3].toHex(), w.callHash);
});

test('1-of-N executes with asMultiThreshold1 and reserves no multisig deposit', async () => {
    const w = world();
    const p = await w.prepare(A, { multisig: normalizeMultisig({ signers: [A, B], threshold: 1 }) });
    assert.equal(p.tx.method.method, 'asMultiThreshold1');
    assert.equal(p.tx.method.args[1].toHex(), w.callHex);
    assert.equal(p.deposit, '0');
});

test('refuses strangers, invalid calldata, mismatched hashes, and stale pending transactions', async () => {
    const w = world();
    await assert.rejects(w.prepare(D), /Choose one/);
    await assert.rejects(w.prepare(A, { mode: 'approve' }), /no longer pending/);
    for (const hex of ['0x', 'not hex', w.callHex + '00']) assert.throws(() => decodeMultisigCall(w.api, hex), /call|data/);
    assert.throws(() => decodeMultisigCall(w.api, w.callHex, '0x' + '00'.repeat(32)), /does not match/);
    w.setPending([A]);
    await assert.rejects(w.prepare(), /already pending/);
});

test('a replacement timepoint, runtime upgrade, or approval changes invalidate the review', async () => {
    const w = world(); w.setPending([A]);
    const original = await w.prepare(B, { mode: 'approve' });
    w.setPending([A], A, { height: 26, index: 1 });
    assert.notEqual((await w.prepare(B, { mode: 'approve' })).fingerprint, original.fingerprint);
    w.setPending([A]);
    w.api.runtimeVersion = { specVersion: 999 };
    assert.notEqual((await w.prepare(B, { mode: 'approve' })).fingerprint, original.fingerprint);
});

test('outer success never hides a failed multisig inner call; approvals have distinct status copy', () => {
    const events = [
        { event: { section: 'multisig', method: 'MultisigExecuted', data: [B, {}, multisig.address, '0x00', { isErr: true, asErr: { isBadOrigin: true } }] } },
        { event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }
    ];
    assert.equal(evaluateEvents(events, chain.registry).ok, false);
    assert.equal(buildTxModel({ key: 'multisig.transaction', params: { kind: 'execute' } }, 'inBlock', events, null, { registry: chain.registry }).stage, 'failed');
    assert.match(successCopy('multisig.transaction', { kind: 'approve' }).body, /has not executed/);
    assert.match(successCopy('multisig.transaction', { kind: 'cancel' }).title, /cancelled/);
});
