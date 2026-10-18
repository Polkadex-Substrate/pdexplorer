// lib/extrinsic-decode.js: one undecodable extrinsic must not cost the block.
//
// Before: scanSingleBlock called api.rpc.chain.getBlock(hash), which decodes
// every extrinsic eagerly, so one bad extrinsic threw for the whole block and
// all of its events were lost with it. Now the indexer falls back to the raw
// block and decodes extrinsics one at a time; a failure becomes a marked stub
// and a scan_failures row ('extrinsic_decode'), and the block is still indexed.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto';
import { compactAddLength, hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { installPolkadotFixes } from '../lib/tx-extensions.js';
import {
    decodeExtrinsicsTolerant, undecodedExtrinsic, extrinsicFormat, signerBytesFromV4, timestampFromExtrinsics,
    recoverBlockDecode, extrinsicDecodeIndexer, EXTRINSIC_DECODE, BLOCK_DECODE_RECOVERED
} from '../lib/extrinsic-decode.js';
import { isRpcUnavailableError } from '../lib/rpc-errors.js';
import { registryFromMetadata, buildSignedV4, buildGeneralV5, remarkCall, ALICE_PUBLIC } from './helpers/extrinsic-builders.js';
import { stripComments } from './helpers/source.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

const IMMORTAL = new Uint8Array([0x00]);
const values = { CheckMortality: IMMORTAL, CheckNonce: 1, ChargeAssetTxPayment: { tip: 0, assetId: null }, CheckMetadataHash: { mode: 'Disabled' } };
const opts = { hashHex: (hex) => blake2AsHex(hexToU8a(hex)), encodeAddress: (u8a) => encodeAddress(u8a, 88) };

describe('decodeExtrinsicsTolerant', () => {
    let registry, good4, good5, badCall4, garbage;
    before(() => {
        registry = registryFromMetadata(substrateMetadata);
        const call = remarkCall(registry);
        good4 = buildSignedV4(registry, { values, call });
        good5 = buildGeneralV5(registry, { values, call });
        // A signed v4 whose call index does not exist: signer readable, call not.
        badCall4 = buildSignedV4(registry, { values, call: new Uint8Array([0xfe, 0xfe, 0x00]) });
        // A future format byte the library has never heard of.
        garbage = u8aToHex(compactAddLength(u8aConcat(new Uint8Array([0x46]), new Uint8Array(10).fill(9))));
    });

    test('decodes v4 and v5 normally and stubs only the bad ones, in order', () => {
        const { extrinsics, failures } = decodeExtrinsicsTolerant(
            [good4, badCall4, good5, garbage], hex => registry.createType('Extrinsic', hex), opts);
        assert.equal(extrinsics.length, 4);
        assert.equal(extrinsics[0].method.method, 'remark');
        assert.equal(extrinsics[2].method.method, 'remark');
        assert.equal(extrinsics[1].undecoded, true);
        assert.equal(extrinsics[3].undecoded, true);
        assert.deepEqual(failures.map(f => f.index), [1, 3]);
        for (const f of failures) assert.ok(f.error.length > 0 && f.error.length <= 300);
    });

    test('a stub carries the true extrinsic hash and, for signed v4, the signer', () => {
        const stub = undecodedExtrinsic(badCall4, 1, new Error('boom'), opts);
        assert.equal(stub.hash.toHex(), blake2AsHex(hexToU8a(badCall4)));
        assert.equal(stub.isSigned, true);
        assert.equal(stub.signer.toString(), encodeAddress(ALICE_PUBLIC, 88));
        assert.equal(stub.method, null);
        assert.deepEqual(stub.format, { version: 4, kind: 'signed', byte: 0x84 });
    });

    test('an unknown format gives an unsigned stub, never a guessed signer', () => {
        const stub = undecodedExtrinsic(garbage, 3, new Error('x'), opts);
        assert.equal(stub.isSigned, false);
        assert.equal(stub.signer, null);
        assert.equal(stub.format.version, 6);
    });

    test('format and signer readers', () => {
        assert.deepEqual(extrinsicFormat(good5), { version: 5, kind: 'general', byte: 0x45 });
        assert.equal(signerBytesFromV4(good5), null);
        assert.equal(extrinsicFormat('0xzz'), null);
        assert.equal(signerBytesFromV4('0x'), null);
    });

    test('timestampFromExtrinsics skips stubs', () => {
        const ts = { method: { section: 'timestamp', method: 'set', args: [{ toNumber: () => 1700000000000 }] } };
        assert.equal(timestampFromExtrinsics([undecodedExtrinsic(garbage, 0, 'x'), ts]), 1700000000000);
        assert.equal(timestampFromExtrinsics([undecodedExtrinsic(garbage, 0, 'x')]), null);
    });
});

// What getBlockTolerant does once the whole-block decode has failed: one
// scan_failures row per bad extrinsic (its own key, its index in the text),
// one 'block_decode_recovered' row when every extrinsic decodes alone, and the
// ORIGINAL error kept when the fallback fetch itself fails.
describe('recoverBlockDecode', () => {
    let registry, good4, good5, badCall4, garbage;
    before(() => {
        registry = registryFromMetadata(substrateMetadata);
        const call = remarkCall(registry);
        good4 = buildSignedV4(registry, { values, call });
        good5 = buildGeneralV5(registry, { values, call });
        badCall4 = buildSignedV4(registry, { values, call: new Uint8Array([0xfe, 0xfe, 0x00]) });
        garbage = u8aToHex(compactAddLength(u8aConcat(new Uint8Array([0x46]), new Uint8Array(10).fill(9))));
    });
    const CAUSE = new Error('createType(SignedBlock):: Struct: failed on block: Vec<Extrinsic>');
    const decodeAll = (list) => async () => ({
        header: { number: 9 },
        ...decodeExtrinsicsTolerant(list, hex => registry.createType('Extrinsic', hex), opts)
    });
    const recorder = () => {
        const rows = [];
        return { rows, record: (indexer, block, msg) => rows.push({ indexer, block, msg }) };
    };

    test('every extrinsic decodes alone: ONE block_decode_recovered row carrying the original error', async () => {
        const r = recorder();
        const out = await recoverBlockDecode({ blockNumber: 77, cause: CAUSE, fetchAndDecode: decodeAll([good4, good5]), record: r.record });
        assert.equal(out.block.extrinsics.length, 2);
        assert.equal(out.block.header.number, 9);
        assert.equal(r.rows.length, 1);
        assert.equal(r.rows[0].indexer, BLOCK_DECODE_RECOVERED);
        assert.equal(r.rows[0].indexer, 'block_decode_recovered');
        assert.equal(r.rows[0].block, 77);
        assert.match(r.rows[0].msg, /Vec<Extrinsic>/);
    });

    test('two bad extrinsics in one block: two rows, one per extrinsic, each with its index', async () => {
        const r = recorder();
        const out = await recoverBlockDecode({ blockNumber: 78, cause: CAUSE, fetchAndDecode: decodeAll([good4, badCall4, good5, garbage]), record: r.record });
        assert.equal(out.block.extrinsics.length, 4);
        assert.deepEqual(r.rows.map(x => x.indexer), [extrinsicDecodeIndexer(1), extrinsicDecodeIndexer(3)]);
        assert.deepEqual(r.rows.map(x => x.indexer), ['extrinsic_decode:1', 'extrinsic_decode:3']);
        assert.ok(r.rows.every(x => x.block === 78));
        assert.match(r.rows[0].msg, /^extrinsic 1 /);
        assert.match(r.rows[1].msg, /^extrinsic 3 /);
        assert.ok(r.rows.every(x => x.indexer.startsWith(EXTRINSIC_DECODE + ':')));
        assert.ok(!r.rows.some(x => x.indexer === BLOCK_DECODE_RECOVERED), 'recovered is only for a block with no bad extrinsic');
    });

    test('the second fetch throws: the thrown error keeps the ORIGINAL decode error and the new one', async () => {
        const r = recorder();
        await assert.rejects(
            recoverBlockDecode({ blockNumber: 79, cause: CAUSE, fetchAndDecode: async () => { throw new Error('Unable to retrieve header'); }, record: r.record }),
            (err) => {
                assert.match(err.message, /Vec<Extrinsic>/, 'original error lost');
                assert.match(err.message, /Unable to retrieve header/);
                assert.ok(err.message.indexOf('Vec<Extrinsic>') < err.message.indexOf('Unable to retrieve'), 'original first, so a 200-char reason keeps it');
                assert.equal(isRpcUnavailableError(err), false);
                return true;
            });
        assert.equal(r.rows.length, 0);
    });

    test('a transport failure on the second fetch is still classed as transport (attempt not counted)', async () => {
        await assert.rejects(
            recoverBlockDecode({ blockNumber: 80, cause: CAUSE, fetchAndDecode: async () => { throw new Error('rpc not ready (disconnected mid-fetch)'); }, record: () => {} }),
            (err) => { assert.equal(isRpcUnavailableError(err), true); assert.match(err.message, /Vec<Extrinsic>/); return true; });
    });

    test('the node returns no block the second time: an error with the original, not a bare null', async () => {
        await assert.rejects(
            recoverBlockDecode({ blockNumber: 81, cause: CAUSE, fetchAndDecode: async () => null, record: () => {} }),
            /Vec<Extrinsic>/);
    });

    test('a failing record() does not lose the block', async () => {
        const warned = [];
        const out = await recoverBlockDecode({
            blockNumber: 82, cause: CAUSE, fetchAndDecode: decodeAll([badCall4]),
            record: () => { throw new Error('database is locked'); }, warn: (m) => warned.push(m)
        });
        assert.equal(out.block.extrinsics.length, 1);
        assert.ok(warned.some(m => /database is locked/.test(m)));
    });
});

describe('server.js wiring', () => {
    const src = stripComments(readFileSync(new URL('../server.js', import.meta.url), 'utf8'));
    const scan = src.slice(src.indexOf('async function scanSingleBlock('), src.indexOf('async function scanChainRange('));

    test('both @polkadot fixes are installed before any ApiPromise is created', () => {
        const at = src.indexOf('installPolkadotFixes({ TypeRegistry, GenericExtrinsic })');
        assert.ok(at > 0, 'server.js does not install lib/tx-extensions.js');
        assert.ok(at < src.indexOf('ApiPromise.create('));
    });

    test('scanSingleBlock falls back to per-extrinsic decoding, and only for non-transport errors', () => {
        assert.match(scan, /getBlockTolerant\(/);
        assert.match(scan, /isRpcUnavailableError\(/);
    });

    test('an undecodable extrinsic is recorded, not silently skipped', () => {
        const fn = src.slice(src.indexOf('async function getBlockTolerant('), src.indexOf('async function scanChainRange('));
        assert.match(fn, /recoverBlockDecode\(/);
        assert.match(fn, /decodeExtrinsicsTolerant\(/);
        assert.match(fn, /record:\s*\(indexer, block, msg\)\s*=>\s*db\.recordScanFailure\(indexer, block, msg\)/);
        assert.doesNotMatch(fn, /recordScanFailure\('extrinsic_decode'/, 'one fixed key collapses several bad extrinsics into one row');
    });

    test('the chain tick persists the decode counts and /api/blocks + /api/events expose them', () => {
        assert.match(src, /const decodeFailures = db\.countDecodeFailures\(\)/);
        assert.match(src, /setSyncState\('chain_index', \{[\s\S]{0,1500}decodeFailures[,\s]/);
        assert.match(src, /import \{[^}]*coverageOf[^}]*\} from '\.\/lib\/index-status\.js'/);
        assert.doesNotMatch(src, /function coverageOf\(/, 'one coverageOf, the tested one in lib/index-status.js');
        const blocks = src.slice(src.indexOf("app.get('/api/blocks'"), src.indexOf("app.get('/api/events'"));
        const events = src.slice(src.indexOf("app.get('/api/events'"), src.indexOf("app.get('/api/events'") + 600);
        assert.match(blocks, /coverage: coverageOf\(state\)/);
        assert.match(events, /coverage: coverageOf\(state\)/);
    });

    test('getBlockTimestamp tolerates stubs', () => {
        const fn = src.slice(src.indexOf('function getBlockTimestamp('), src.indexOf('function getExtrinsicStatus('));
        assert.match(fn, /timestampFromExtrinsics|!ex\.method/);
    });

    test('the hand-declared CheckMetadataHash shape is gone (17.x knows it natively)', () => {
        assert.doesNotMatch(src, /signedExtensions:\s*\{\s*CheckMetadataHash/);
    });
});

describe('script.js wiring', () => {
    const src = stripComments(readFileSync(new URL('../script.js', import.meta.url), 'utf8'));
    test('the browser installs the same fixes before its ApiPromise', () => {
        const at = src.indexOf('installPolkadotFixes({ TypeRegistry, GenericExtrinsic })');
        assert.ok(at > 0);
        assert.ok(at < src.indexOf('ApiPromise.create('));
        assert.doesNotMatch(src, /signedExtensions:\s*\{\s*CheckMetadataHash/);
    });
    test('the WS endpoint override exists only in the dev server', () => {
        assert.match(src, /import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_POLKADEX_WS/);
    });
});
