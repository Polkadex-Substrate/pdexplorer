// The walk-back loop of scripts/fetch-metadata.mjs, with a fake `call` (no network, no node):
//   - state pruned on the very first block: the error is thrown (nothing to keep)
//   - state pruned after N blocks: the scan stops there and keeps what it has
//   - any other error, at any point, is thrown
//   - a spec change ends the scan (that block is not counted)
//   - the --blocks cap is respected
//   - a block is counted whole or not at all (no half-counted block)
//   - v5 runtimes scan the whole window; older ones stop once enough signed samples are in

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { walkBackSamples } from '../lib/walk-blocks.js';

const BARE_V5 = '0x0c050000', SIGNED_V4 = '0x0c840000', GENERAL_V5 = '0x0c450000';
const hashOf = (n) => `h${n}`;
const numOf = (h) => Number(String(h).slice(1));
const PRUNED = () => new Error('Api called for an unknown Block: State already discarded for h1');

// extrinsicsOf(n) -> hex[]; specOf(n); prunedBelow: state calls under this block fail like a pruned node;
// failAt: a block whose state call throws a different error.
function fake({ extrinsicsOf = () => [BARE_V5], specOf = () => 392, prunedBelow = 0, failAt = null } = {}) {
    const calls = [];
    const call = async (method, params = []) => {
        calls.push([method, params[0]]);
        const n = numOf(params[0]);
        if (method === 'chain_getBlock') return { block: { header: { parentHash: hashOf(n - 1) }, extrinsics: extrinsicsOf(n) } };
        if (method === 'state_getRuntimeVersion') {
            if (failAt !== null && n === failAt) throw new Error('connection reset');
            if (n < prunedBelow) throw PRUNED();
            return { specVersion: specOf(n) };
        }
        throw new Error('unexpected ' + method);
    };
    return { call, calls, blocksFetched: () => calls.filter(c => c[0] === 'chain_getBlock').length };
}
const walk = (f, o = {}) => walkBackSamples({ call: f.call, blockHash: hashOf(100), blockNumber: 100, specVersion: 392, maxWalk: 400, samples: 12, ...o });
const total = (tally) => Object.values(tally).reduce((a, v) => a + Object.values(v).reduce((x, y) => x + y, 0), 0);

describe('walkBackSamples', () => {
    test('state pruned on the very first block: the error is thrown', async () => {
        const f = fake({ prunedBelow: 1000 });
        await assert.rejects(walk(f), /State already discarded/);
    });

    test('state pruned after N blocks: stops, keeps the samples, says so', async () => {
        const logs = [];
        const f = fake({ prunedBelow: 95 });      // blocks 100..95 readable, 94 pruned: six blocks
        const r = await walk(f, { log: (m) => logs.push(m) });
        assert.equal(r.walked, 6);
        assert.equal(r.stoppedAtPrunedState, true);
        assert.equal(r.extrinsics.length, 6);
        assert.deepEqual(r.extrinsics.map(e => e.block), [100, 99, 98, 97, 96, 95]);
        assert.equal(r.have['v5-bare'], 6);
        assert.equal(total(r.seenFormats), 6, 'the tally holds exactly the six counted blocks');
        assert.ok(logs.some(m => /pruned beyond 6 blocks/.test(m)), logs.join('\n'));
    });

    test('any other error is thrown, even after some blocks were read', async () => {
        const f = fake({ failAt: 97 });
        await assert.rejects(walk(f), /connection reset/);
    });

    test('a spec change ends the scan, and the block of the other spec is not counted', async () => {
        const f = fake({ specOf: (n) => (n >= 97 ? 392 : 373) });
        const r = await walk(f);
        assert.equal(r.walked, 4);                 // 100, 99, 98, 97
        assert.equal(r.stoppedAtPrunedState, false);
        assert.deepEqual(r.extrinsics.map(e => e.block), [100, 99, 98, 97]);
        assert.ok(r.extrinsics.every(e => e.specVersion === 392));
        assert.equal(total(r.seenFormats), 4);
    });

    test('the --blocks cap is respected', async () => {
        const f = fake();
        const r = await walk(f, { maxWalk: 7 });
        assert.equal(r.walked, 7);
        assert.equal(f.blocksFetched(), 7);
        assert.equal(r.stoppedAtPrunedState, false);
    });

    test('the walk never goes below block 1', async () => {
        const f = fake();
        const r = await walkBackSamples({ call: f.call, blockHash: hashOf(3), blockNumber: 3, specVersion: 392, maxWalk: 400, samples: 12 });
        assert.equal(r.walked, 3);
    });

    test('no half-counted block: the block whose state is pruned adds no samples and no tally', async () => {
        const f = fake({ prunedBelow: 98, extrinsicsOf: () => [BARE_V5, GENERAL_V5, SIGNED_V4] });
        const r = await walk(f);
        assert.equal(r.walked, 3);                 // 100, 99, 98
        assert.equal(f.blocksFetched(), 4, 'block 97 was fetched, then its state refused');
        assert.equal(r.extrinsics.length, 9);
        assert.equal(total(r.seenFormats), 9);
        assert.ok(r.extrinsics.every(e => e.block >= 98));
    });

    test('a v5 runtime scans the whole window; samples per kind are capped, the tally is not', async () => {
        const f = fake();
        const r = await walk(f, { maxWalk: 30, samples: 2 });
        assert.equal(r.walked, 30);
        assert.equal(r.have['v5-bare'], 2);
        assert.equal(r.extrinsics.length, 2);
        assert.equal(total(r.seenFormats), 30);
    });

    test('an older runtime stops as soon as enough signed samples are in', async () => {
        const f = fake({ extrinsicsOf: () => [SIGNED_V4], specOf: () => 373 });
        const r = await walk(f, { specVersion: 373, samples: 3 });
        assert.equal(r.walked, 3);
        assert.equal(r.have['v4-signed'], 3);
        assert.equal(r.extrinsics.length, 3);
    });

    test('samples carry block, hash, index, spec and format', async () => {
        const f = fake({ extrinsicsOf: () => [BARE_V5, GENERAL_V5] });
        const r = await walk(f, { maxWalk: 1 });
        assert.deepEqual(r.extrinsics.map(({ block, blockHash, index, specVersion, format }) => ({ block, blockHash, index, specVersion, format })), [
            { block: 100, blockHash: 'h100', index: 0, specVersion: 392, format: 'v5-bare' },
            { block: 100, blockHash: 'h100', index: 1, specVersion: 392, format: 'v5-general' }
        ]);
    });
});
