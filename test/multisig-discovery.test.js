import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import metadata from '@polkadot/types-support/metadata/static-substrate';
import { mockProvider } from './helpers/mock-provider.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { discoverMultisigs, multisigsFromExtrinsic } from '../lib/multisig-discovery.js';

const [A, B, C, D] = [1, 2, 3, 4].map(n => encodeAddress(new Uint8Array(32).fill(n), 88));
const m = normalizeMultisig({ signers: [A, B, C], threshold: 2 });
const hash = '0x' + 'ab'.repeat(32);
let chain;
before(async () => { chain = await ApiPromise.create({ provider: mockProvider({ metadataHex: metadata }).provider, noInitWarn: true }); });
after(async () => { await chain?.disconnect(); });
const event = (more = {}) => ({ section: 'multisig', method: 'NewMultisig', data: { approving: A, multisig: m.address },
    block: 100, blockHash: hash, extrinsicIndex: 0, ...more });
const proposal = () => chain.tx.multisig.asMulti(2, [B, C], null, chain.tx.balances.transferKeepAlive(D, 123).method, { refTime: 100000, proofSize: 0 });
const signed = (tx = proposal(), signer = A) => ({ isSigned: true, signer, method: tx.method });

test('recovers a multisig from a real SCALE call and validates its derived address', () => {
    const ext = signed();
    assert.deepEqual(multisigsFromExtrinsic(ext, [event()]), [m]);
    assert.deepEqual(multisigsFromExtrinsic(ext, [event({ data: { approving: A, multisig: D } })]), []);
    assert.deepEqual(multisigsFromExtrinsic({ ...ext, isSigned: false }, [event()]), []);
    assert.deepEqual(multisigsFromExtrinsic(signed(proposal(), D), [event()]), []);
});

test('batches and proxies use the effective signer, not the fee-paying outer signer', () => {
    const proxy = chain.tx.proxy.proxy(A, null, proposal());
    const batch = chain.tx.utility.batchAll([proxy, proxy]);
    assert.deepEqual(multisigsFromExtrinsic(signed(batch, D), [event(), event()]), [m]);
    const announced = chain.tx.proxy.proxyAnnounced(D, A, null, proposal());
    assert.deepEqual(multisigsFromExtrinsic(signed(announced, D), [event()]), [m]);
    assert.deepEqual(multisigsFromExtrinsic(signed(batch, D), []), [], 'unexecuted calls without matching events are not listed');
});

test('hash-only approvals, cancellation and legacy array events reveal the same signer set', () => {
    const approve = chain.tx.multisig.approveAsMulti(2, [B, C], { height: 99, index: 0 }, hash, { refTime: 100000, proofSize: 0 });
    const cancel = chain.tx.multisig.cancelAsMulti(2, [B, C], { height: 99, index: 0 }, hash);
    for (const [tx, method] of [[approve, 'MultisigApproval'], [cancel, 'MultisigCancelled']]) {
        assert.deepEqual(multisigsFromExtrinsic(signed(tx), [event({ method, data: JSON.stringify([A, { height: 99, index: 0 }, m.address, hash]) })]), [m]);
    }
});

function world(pages = [{ rows: [event()], next: null }]) {
    const urls = [], blocks = [], heights = [];
    const api = { rpc: { chain: {
        getBlockHash: async n => { heights.push(n); return { toHex: () => hash }; },
        getBlock: async h => { blocks.push(h); return { block: { extrinsics: [signed()] } }; }
    } } };
    const fetchJson = async url => { urls.push(url); return pages[urls.length - 1]; };
    return { api, urls, blocks, heights, run: (more = {}) => discoverMultisigs({ api, fetchJson, address: A, ...more }) };
}

test('follows history pages, reuses each block and filters wallets to the requested member', async () => {
    const pages = [{ rows: [event()], next: '100:2' }, { rows: [event()], next: null }];
    const w = world(pages);
    const result = await w.run();
    assert.deepEqual(result, { wallets: [m], scannedEvents: 2, limited: false, unavailableBlocks: 0 });
    assert.equal(w.blocks.length, 1);
    assert.match(w.urls[1], /before=100%3A2/);
    assert.deepEqual((await world().run({ address: D })).wallets, []);
    const alt = encodeAddress(new Uint8Array(32).fill(1), 42);
    assert.deepEqual((await world().run({ address: alt })).wallets, [m]);
});

test('bounds automatic history search and reports partial results', async () => {
    const w = world(Array.from({ length: 6 }, (_, i) => ({ rows: Array.from({ length: 200 }, () => event()), next: `${100 - i}:1` })));
    const result = await w.run();
    assert.equal(w.urls.length, 5);
    assert.equal(result.scannedEvents, 1000);
    assert.equal(result.limited, true);
    const many = world([{ rows: Array.from({ length: 21 }, (_, i) => event({ block: i, blockHash: '0x' + i.toString(16).padStart(64, '0') })), next: null }]);
    many.api.rpc.chain.getBlockHash = async n => ({ toHex: () => '0x' + n.toString(16).padStart(64, '0') });
    assert.equal((await many.run()).limited, true);
    assert.equal(many.blocks.length, 20);
});

test('stale fork rows and unavailable historical blocks never become discovered wallets', async () => {
    const fork = world();
    fork.api.rpc.chain.getBlockHash = async () => ({ toHex: () => '0x' + 'cd'.repeat(32) });
    assert.deepEqual((await fork.run()).wallets, []);
    assert.equal(fork.blocks.length, 0);
    const pruned = world();
    pruned.api.rpc.chain.getBlock = async () => { throw new Error('pruned'); };
    assert.deepEqual(await pruned.run(), { wallets: [], scannedEvents: 1, limited: false, unavailableBlocks: 1 });
});

test('invalid index responses fail visibly; malformed event rows do not trigger RPC', async () => {
    await assert.rejects(world([{ error: 'offline' }]).run(), /history could not/);
    await assert.rejects(world([{ rows: [], next: 'invalid' }]).run(), /cursor is invalid/);
    await assert.rejects(world([{ rows: [], next: '1:1' }, { rows: [], next: '1:1' }]).run(), /cursor is invalid/);
    const w = world([{ rows: [event({ blockHash: 'bad' }), event({ extrinsicIndex: -1 }), event({ block: null })], next: null }]);
    assert.deepEqual((await w.run()).wallets, []);
    assert.equal(w.heights.length, 0);
});

test('aborting discovery prevents subsequent requests', async () => {
    const controller = new AbortController();
    controller.abort();
    const w = world();
    await assert.rejects(w.run({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(w.urls.length, 0);
});
