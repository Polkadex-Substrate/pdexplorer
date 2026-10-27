// scan_failures rows for undecodable blocks, against a real SQLite database:
// one row per bad extrinsic (the (indexer, block) key would otherwise collapse
// two bad extrinsics in one block into one row with attempts = 2), the
// counts the chain tick persists, and the coverage object /api/blocks and
// /api/events return. See recoverBlockDecode in lib/extrinsic-decode.js.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { coverageOf } from '../lib/index-status.js';
import { recoverBlockDecode, extrinsicDecodeIndexer, BLOCK_DECODE_RECOVERED } from '../lib/extrinsic-decode.js';

const dirs = [];
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-dec-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const CAUSE = new Error('Struct: failed on block');
const stub = (index) => ({ index, error: 'Unable to decode', format: { version: 4, kind: 'signed' }, hash: '0x' + String(index).repeat(64).slice(0, 64) });
const record = (indexer, block, msg) => db.recordScanFailure(indexer, block, msg);

describe('decode failure rows in scan_failures', () => {
    test('two bad extrinsics in one block are two rows, not one row with attempts 2', async () => {
        freshDb();
        await recoverBlockDecode({
            blockNumber: 500, cause: CAUSE, record,
            fetchAndDecode: async () => ({ header: {}, extrinsics: [{}, {}, {}], failures: [stub(1), stub(2)] })
        });
        const counts = db.countDecodeFailures();
        assert.deepEqual(counts, { extrinsicDecode: 2, blockDecodeRecovered: 0 });
        // Scanning the same block again (a retry) does not add rows.
        await recoverBlockDecode({
            blockNumber: 500, cause: CAUSE, record,
            fetchAndDecode: async () => ({ header: {}, extrinsics: [{}, {}, {}], failures: [stub(1), stub(2)] })
        });
        assert.deepEqual(db.countDecodeFailures(), { extrinsicDecode: 2, blockDecodeRecovered: 0 });
    });

    test('a recovered block is counted separately', async () => {
        freshDb();
        await recoverBlockDecode({ blockNumber: 600, cause: CAUSE, record, fetchAndDecode: async () => ({ header: {}, extrinsics: [{}], failures: [] }) });
        await recoverBlockDecode({ blockNumber: 601, cause: CAUSE, record, fetchAndDecode: async () => ({ header: {}, extrinsics: [{}], failures: [stub(0)] }) });
        assert.deepEqual(db.countDecodeFailures(), { extrinsicDecode: 1, blockDecodeRecovered: 1 });
    });

    test('decode rows never enter the chain_index retry queue or its watermark', async () => {
        freshDb();
        record(extrinsicDecodeIndexer(4), 700, 'x');
        record(BLOCK_DECODE_RECOVERED, 701, 'y');
        assert.deepEqual(db.countScanFailures('chain_index', 10), { retrying: 0, permanent: 0, total: 0 });
        assert.equal(db.getLowestScanFailure('chain_index'), null);
        // Rows of other indexers are not counted as decode failures.
        record('chain_index', 702, 'fetch failed');
        record('transactions', 703, 'boom');
        assert.deepEqual(db.countDecodeFailures(), { extrinsicDecode: 1, blockDecodeRecovered: 1 });
    });

    test('empty table: zeros, not null', () => {
        freshDb();
        assert.deepEqual(db.countDecodeFailures(), { extrinsicDecode: 0, blockDecodeRecovered: 0 });
    });
});

describe('coverageOf (the coverage object on /api/blocks and /api/events)', () => {
    test('exposes the decode counts the chain tick persisted', () => {
        const c = coverageOf({ knownGapBlocks: 3, retryableFailures: 1, decodeFailures: { extrinsicDecode: 5, blockDecodeRecovered: 2 } });
        assert.deepEqual(c.decodeFailures, { extrinsicDecode: 5, blockDecodeRecovered: 2 });
        assert.equal(c.knownGapBlocks, 3);
        assert.equal(c.retryableFailures, 1);
        assert.equal(c.permanentFailures, 0);
        assert.equal(c.gapsExhausted, 0);
        assert.equal(c.detail, null);
    });
    test('a state written before this field existed reads as zeros', () => {
        assert.deepEqual(coverageOf({}).decodeFailures, { extrinsicDecode: 0, blockDecodeRecovered: 0 });
        assert.deepEqual(coverageOf(undefined).decodeFailures, { extrinsicDecode: 0, blockDecodeRecovered: 0 });
    });
});
