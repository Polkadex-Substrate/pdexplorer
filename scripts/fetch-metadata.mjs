#!/usr/bin/env node
// Saves the Polkadex runtime metadata fixtures used by test/tx-extensions.test.js.
//
//   node scripts/fetch-metadata.mjs                 both fixtures
//   node scripts/fetch-metadata.mjs --only 373      mainnet only
//   node scripts/fetch-metadata.mjs --only 392      testnet only
//   --mainnet <wss url>  --testnet <wss url>  --samples <n>  --out <dir>
//   --blocks <n>    how many recent blocks to scan (default 400)
//
// For the 392 target the script scans the whole window for extrinsic format
// versions and prints seenFormats ({"4": {...}, "5": {...}} with the
// bare/signed/general split read from the version byte: 0x04, 0x84, 0x05,
// 0x45). If no v5 extrinsic is found it exits non-zero WITHOUT writing the
// file; widen the window with --blocks.
//
// Writes test/fixtures/metadata-373.json (mainnet, wss://rpc.polkadex.ee) and
// test/fixtures/metadata-392.json (testnet, wss://polkadex-testnet.polkadex.ee).
// Each file holds the metadata from state_getMetadata (v14), the v15/v16
// metadata where the runtime offers it, and a handful of real signed or
// general extrinsics from recent blocks of the SAME runtime, so the tests
// decode genuine chain bytes and not only bytes the tests built.
//
// Read-only: JSON-RPC reads only, no keys, nothing is submitted. Needs Node 22
// (global WebSocket). Plain JSON-RPC on purpose, so a library bug cannot
// shape the fixture that is meant to test the library.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newFormatTally, tallyExtrinsic, sampleLabel, v5MissingMessage } from '../lib/extrinsic-formats.js';
import { rpcClient } from '../lib/json-rpc-client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const TARGETS = [
    { label: '373', file: 'metadata-373.json', url: opt('mainnet', 'wss://rpc.polkadex.ee'), expectSpec: 373, network: 'mainnet' },
    { label: '392', file: 'metadata-392.json', url: opt('testnet', 'wss://polkadex-testnet.polkadex.ee'), expectSpec: 392, network: 'testnet' }
];
const ONLY = opt('only', null);
const SAMPLES = Number(opt('samples', '12'));
const MAX_WALK = Number(opt('blocks', '400'));
if (!Number.isInteger(MAX_WALK) || MAX_WALK < 1) {
    console.error('--blocks must be a positive integer.');
    process.exit(2);
}
const OUT = resolve(opt('out', join(ROOT, 'test', 'fixtures')));

if (typeof WebSocket !== 'function') {
    console.error('This script needs a global WebSocket (Node 22 or newer). Found Node ' + process.version + '.');
    process.exit(2);
}

function hexToBytes(hex) {
    const s = hex.replace(/^0x/, '');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}
function bytesToHex(u8a) { return '0x' + Buffer.from(u8a).toString('hex'); }
function readCompact(u8a, at = 0) {
    const b = u8a[at], mode = b & 3;
    if (mode === 0) return [1, b >> 2];
    if (mode === 1) return [2, (b | (u8a[at + 1] << 8)) >> 2];
    if (mode === 2) return [4, ((b | (u8a[at + 1] << 8) | (u8a[at + 2] << 16)) + u8a[at + 3] * 0x1000000) / 4];
    const n = (b >> 2) + 4;
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(u8a[at + 1 + i]);
    return [1 + n, Number(v)];
}
function u32le(n) { return '0x' + [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].map(x => x.toString(16).padStart(2, '0')).join(''); }

async function metadataVersions(call, at) {
    try {
        const u8a = hexToBytes(await call('state_call', ['Metadata_metadata_versions', '0x', at]));
        const [off, len] = readCompact(u8a);
        const out = [];
        for (let i = 0; i < len; i++) {
            const p = off + i * 4;
            out.push(u8a[p] | (u8a[p + 1] << 8) | (u8a[p + 2] << 16) | (u8a[p + 3] << 24));
        }
        return out;
    } catch (_) {
        return [14];
    }
}

async function metadataAtVersion(call, version, at) {
    const u8a = hexToBytes(await call('state_call', ['Metadata_metadata_at_version', u32le(version), at]));
    if (u8a[0] !== 1) return null;                  // Option::None
    const [off, len] = readCompact(u8a, 1);
    return bytesToHex(u8a.subarray(1 + off, 1 + off + len));
}

function formatByte(hex) {
    const u8a = hexToBytes(hex);
    const [off] = readCompact(u8a);
    return u8a[off];
}

async function fetchTarget(t) {
    console.log(`\n[${t.network}] ${t.url}`);
    const { call, close } = rpcClient(t.url);
    try {
        const blockHash = await call('chain_getFinalizedHead');
        const header = await call('chain_getHeader', [blockHash]);
        const blockNumber = parseInt(header.number, 16);
        const rv = await call('state_getRuntimeVersion', [blockHash]);
        const genesisHash = await call('chain_getBlockHash', [0]);
        console.log(`  finalized #${blockNumber} ${blockHash}, ${rv.specName} spec ${rv.specVersion} tx ${rv.transactionVersion}`);
        if (rv.specVersion !== t.expectSpec) {
            console.warn(`  WARNING: expected spec ${t.expectSpec}, the chain runs ${rv.specVersion}. Saving it anyway; the file name is a label, the content records the real spec.`);
        }
        const metadata = await call('state_getMetadata', [blockHash]);
        const versions = await metadataVersions(call, blockHash);
        const atVersion = {};
        for (const v of versions.filter(v => v >= 15)) {
            try { atVersion[v] = await metadataAtVersion(call, v, blockHash); } catch (e) { console.warn(`  metadata v${v}: ${e.message}`); }
        }
        console.log(`  metadata versions offered: ${versions.join(', ')}`);

        // Real signed (0x84), bare v5 (0x05, the inherents) and general (0x45)
        // extrinsics from the same runtime, up to SAMPLES of each kind. A v5 target (392) scans the whole window
        // so seenFormats counts every extrinsic; the others stop as soon as
        // enough signed samples are in.
        const wantV5 = t.expectSpec >= 392 || rv.specVersion >= 392;
        const extrinsics = [];
        const have = { 'v4-signed': 0, 'v5-general': 0, 'v5-bare': 0 };
        const seenFormats = newFormatTally();
        let hash = blockHash, n = blockNumber, walked = 0;
        while (walked < MAX_WALK && n > 0) {
            if (!wantV5 && have['v4-signed'] >= SAMPLES) break;
            const blk = await call('chain_getBlock', [hash]);
            const v = (await call('state_getRuntimeVersion', [hash])).specVersion;
            if (v !== rv.specVersion) break;
            blk.block.extrinsics.forEach((hex, index) => {
                const { version, kind } = tallyExtrinsic(seenFormats, hex);
                const label = sampleLabel({ version, kind });
                if (label && have[label] < SAMPLES) {
                    have[label] += 1;
                    extrinsics.push({ block: n, blockHash: hash, index, specVersion: v, format: label, hex });
                }
            });
            hash = blk.block.header.parentHash;
            n -= 1;
            walked += 1;
        }
        console.log(`  extrinsic samples: ${extrinsics.length} from ${walked} blocks (v4-signed ${have['v4-signed']}, v5-bare ${have['v5-bare']}, v5-general ${have['v5-general']})`);
        console.log(`  seenFormats=${JSON.stringify(seenFormats)}`);
        if (wantV5) {
            const missing = v5MissingMessage(seenFormats, { blocks: walked, spec: rv.specVersion, widen: MAX_WALK });
            if (missing) throw new Error(missing);
        }

        const out = {
            note: 'Written by scripts/fetch-metadata.mjs. Test fixture; regenerate rather than edit.',
            network: t.network, endpoint: t.url, fetchedAt: new Date().toISOString(),
            specName: rv.specName, specVersion: rv.specVersion, transactionVersion: rv.transactionVersion,
            genesisHash, blockHash, blockNumber,
            metadata, metadataVersions: versions, metadataAtVersion: atVersion,
            extrinsics
        };
        mkdirSync(OUT, { recursive: true });
        const file = join(OUT, t.file);
        writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
        console.log(`  wrote ${file}`);
        return true;
    } finally {
        close();
    }
}

let failed = 0;
for (const t of TARGETS) {
    if (ONLY && ONLY !== t.label) continue;
    try { await fetchTarget(t); } catch (e) { failed++; console.error(`  FAILED: ${e.message}`); }
}
if (failed) { console.error(`\n${failed} fixture(s) not written.`); process.exit(1); }
console.log('\nDone. Now run: npm test');
