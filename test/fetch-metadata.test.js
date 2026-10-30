// scripts/fetch-metadata.mjs end to end, against a local JSON-RPC WebSocket
// serving a fake mainnet: spec 373 up to block UPGRADE - 1, spec 392 from
// UPGRADE. metadata-392.json is the current runtime (finalized head, spec 392
// or later, or nothing is written); metadata-373.json is history, read at a
// fixed block from an archive node, and refused if that block is not 373.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const UPGRADE = 1000;
const hashOf = (n) => '0x' + n.toString(16).padStart(64, '0');
const numOf = (h) => parseInt(h.slice(2), 16);
// One extrinsic per block: bare v5 (0x05) under 392, signed v4 (0x84) under 373.
const extrinsicFor = (spec) => (spec >= 392 ? '0x0c050000' : '0x0c840000');

function mockNode({ head, upgradeAt = UPGRADE, headSpec = null }) {
    const methods = [];
    const specOf = (n) => (headSpec !== null ? headSpec : n >= upgradeAt ? 392 : 373);
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => ws.on('message', (raw) => {
        const { id, method, params = [] } = JSON.parse(String(raw));
        methods.push(method);
        const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
        const error = (message) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }));
        const at = (i) => (params[i] ? numOf(params[i]) : head);
        switch (method) {
            case 'chain_getFinalizedHead': return reply(hashOf(head));
            case 'chain_getBlockHash': return reply(params[0] <= head ? hashOf(params[0]) : null);
            case 'chain_getHeader': return reply({ number: '0x' + at(0).toString(16) });
            case 'state_getRuntimeVersion': {
                const s = specOf(at(0));
                return reply({ specName: 'node', specVersion: s, transactionVersion: s >= 392 ? 3 : 2 });
            }
            case 'state_getMetadata': return reply('0x6d657461' + specOf(at(0)).toString(16));
            case 'state_call': {
                // Metadata_metadata_versions: Vec<u32> [14, 15]; at_version: Some(bytes)
                if (params[0] === 'Metadata_metadata_versions') return reply('0x080e0000000f000000');
                if (params[0] === 'Metadata_metadata_at_version') return reply('0x010c0f0f0f');
                return error('unknown runtime api ' + params[0]);
            }
            case 'chain_getBlock': {
                const n = at(0);
                return reply({ block: { header: { parentHash: hashOf(n - 1), number: '0x' + n.toString(16) }, extrinsics: [extrinsicFor(specOf(n))] } });
            }
            default: return error('unknown method ' + method);
        }
    }));
    return new Promise((ok) => wss.on('listening', () => ok({ url: `ws://127.0.0.1:${wss.address().port}`, methods, close: () => wss.close() })));
}

function runScript(args) {
    const script = fileURLToPath(new URL('../scripts/fetch-metadata.mjs', import.meta.url));
    return new Promise((ok) => {
        const p = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => ok({ code, out, err }));
    });
}

describe('scripts/fetch-metadata.mjs end to end', () => {
    test('metadata-392.json comes from the mainnet head, which must be on 392 or later', async () => {
        const node = await mockNode({ head: 1200 });
        const out = mkdtempSync(join(tmpdir(), 'pdex-fx-'));
        try {
            const r = await runScript(['--only', '392', '--mainnet', node.url, '--blocks', '5', '--out', out]);
            assert.equal(r.code, 0, r.err + r.out);
            assert.match(r.out, /\[mainnet\] ws:\/\/127\.0\.0\.1/);
            assert.match(r.out, /finalized #1200 .*node spec 392 tx 3/);
            const fx = JSON.parse(readFileSync(join(out, 'metadata-392.json'), 'utf8'));
            assert.equal(fx.specVersion, 392);
            assert.equal(fx.blockNumber, 1200);
            assert.ok(fx.extrinsics.length > 0 && fx.extrinsics.every(x => x.format === 'v5-bare'));
            assert.equal(existsSync(join(out, 'metadata-373.json')), false, '--only 392 writes one file');
            assert.equal(node.methods.includes('chain_getFinalizedHead'), true);
        } finally { node.close(); rmSync(out, { recursive: true, force: true }); }
    });

    test('a node still on 373 at its head is refused and nothing is written', async () => {
        const node = await mockNode({ head: 1200, headSpec: 373 });
        const out = mkdtempSync(join(tmpdir(), 'pdex-fx-'));
        try {
            const r = await runScript(['--only', '392', '--mainnet', node.url, '--blocks', '5', '--out', out]);
            assert.equal(r.code, 1);
            assert.match(r.err, /FAILED: the node reports spec 373 at its finalized head, below 392: it is out of date or not mainnet\. Nothing written/);
            assert.equal(existsSync(join(out, 'metadata-392.json')), false);
        } finally { node.close(); rmSync(out, { recursive: true, force: true }); }
    });

    test('metadata-373.json is history: read at a fixed pre-upgrade block from the archive node', async () => {
        const node = await mockNode({ head: 1200 });
        const out = mkdtempSync(join(tmpdir(), 'pdex-fx-'));
        try {
            const r = await runScript(['--only', '373', '--archive', node.url, '--at373', '990', '--samples', '3', '--out', out]);
            assert.equal(r.code, 0, r.err + r.out);
            assert.match(r.out, /block #990 .*node spec 373 tx 2/);
            const fx = JSON.parse(readFileSync(join(out, 'metadata-373.json'), 'utf8'));
            assert.equal(fx.specVersion, 373);
            assert.equal(fx.blockNumber, 990);
            assert.equal(fx.extrinsics.length, 3);
            assert.ok(fx.extrinsics.every(x => x.format === 'v4-signed' && x.specVersion === 373 && x.block <= 990));
            assert.equal(node.methods.includes('chain_getFinalizedHead'), false, 'the 373 fixture never reads the head');
        } finally { node.close(); rmSync(out, { recursive: true, force: true }); }
    });

    test('a 373 block that is really 392 is refused and nothing is written', async () => {
        const node = await mockNode({ head: 1200 });
        const out = mkdtempSync(join(tmpdir(), 'pdex-fx-'));
        try {
            const r = await runScript(['--only', '373', '--archive', node.url, '--at373', '1100', '--out', out]);
            assert.equal(r.code, 1);
            assert.match(r.err, /FAILED: block #1100 runs spec 392, not 373\. Nothing written; pick a block before the 392 upgrade with --at373/);
            assert.equal(existsSync(join(out, 'metadata-373.json')), false);
        } finally { node.close(); rmSync(out, { recursive: true, force: true }); }
    });

    test('only current, non-deprecated JSON-RPC methods are used', async () => {
        const node = await mockNode({ head: 1200 });
        const out = mkdtempSync(join(tmpdir(), 'pdex-fx-'));
        try {
            await runScript(['--mainnet', node.url, '--archive', node.url, '--at373', '990', '--blocks', '5', '--samples', '2', '--out', out]);
            const used = [...new Set(node.methods)].sort();
            assert.deepEqual(used, ['chain_getBlock', 'chain_getBlockHash', 'chain_getFinalizedHead', 'chain_getHeader',
                'state_call', 'state_getMetadata', 'state_getRuntimeVersion']);
        } finally { node.close(); rmSync(out, { recursive: true, force: true }); }
    });

    test('a bad --at373 is a usage error', async () => {
        const r = await runScript(['--only', '373', '--at373', 'soon']);
        assert.equal(r.code, 2);
        assert.match(r.err, /--at373 must be a positive block number/);
    });
});
