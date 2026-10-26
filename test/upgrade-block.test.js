// lib/upgrade-block.js and scripts/find-upgrade-block.mjs: where a chain
// switched to spec 392, so the testnet proof can run on any 392 endpoint.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { findUpgradeBlock, proofWindow } from '../lib/upgrade-block.js';

const chain = (upgradeAt, head, before = 373, after = 392) => {
    const reads = [];
    return { reads, specAt: async (n) => { assert.ok(n >= 0 && n <= head, `read outside the chain: ${n}`); reads.push(n); return n >= upgradeAt ? after : before; } };
};

describe('findUpgradeBlock', () => {
    test('finds the enacting block and the first block of the new runtime', async () => {
        for (const [u, head] of [[1553840, 2000000], [1, 10], [10, 10], [5, 6], [999999, 1000000]]) {
            const c = chain(u, head);
            const r = await findUpgradeBlock({ specAt: c.specAt, head, target: 392 });
            assert.deepEqual(r, { upgraded: true, fromGenesis: false, block: u, firstNewBlock: u + 1, headSpec: 392, previousSpec: 373 }, `u=${u}`);
            assert.ok(c.reads.length <= 2 + Math.ceil(Math.log2(head + 1)) + 1, `${c.reads.length} reads for head ${head}`);
        }
    });

    test('a chain that has not upgraded yet', async () => {
        const c = chain(Infinity, 500);
        assert.deepEqual(await findUpgradeBlock({ specAt: c.specAt, head: 500, target: 392 }), { upgraded: false, headSpec: 373 });
        assert.deepEqual(c.reads, [500], 'one read, at the head');
    });

    test('a chain started on the new spec (a mainnet-state copy launched on 392)', async () => {
        const c = chain(0, 300);
        const r = await findUpgradeBlock({ specAt: c.specAt, head: 300, target: 392 });
        assert.equal(r.fromGenesis, true);
        assert.equal(r.block, 0);
        assert.deepEqual(proofWindow(r, 300), { from: 1, to: 300, blocks: 300 });
    });

    test('a later spec than the target still counts as upgraded', async () => {
        const r = await findUpgradeBlock({ specAt: async (n) => (n >= 40 ? 400 : 373), head: 100, target: 392 });
        assert.equal(r.block, 40);
        assert.equal(r.headSpec, 400);
    });

    test('rejects bad input and passes RPC errors through', async () => {
        await assert.rejects(findUpgradeBlock({ specAt: async () => 1, head: -1, target: 392 }), /head/);
        await assert.rejects(findUpgradeBlock({ specAt: async () => 1, head: 5, target: 0 }), /target/);
        await assert.rejects(findUpgradeBlock({ specAt: async (n) => { if (n === 0) throw new Error('state pruned'); return 392; }, head: 5, target: 392 }), /state pruned/);
    });
});

describe('proofWindow', () => {
    test('margin on both sides, clamped to block 1 and the head', () => {
        assert.deepEqual(proofWindow({ upgraded: true, block: 1553840 }, 2000000), { from: 1552840, to: 1554840, blocks: 2001 });
        assert.deepEqual(proofWindow({ upgraded: true, block: 50 }, 2000000, 100), { from: 1, to: 150, blocks: 150 });
        assert.deepEqual(proofWindow({ upgraded: true, block: 1990 }, 2000, 100), { from: 1890, to: 2000, blocks: 111 });
        assert.equal(proofWindow({ upgraded: false }, 10), null);
    });
});

// The script end to end, against a local JSON-RPC WebSocket that serves a
// fake chain (spec 373 up to block 1,553,839, 392 from 1,553,840).
const MAINNET_GENESIS = '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c';
function mockNode({ head, upgradeAt, prunedBelow = -1, genesis = null }) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const hashOf = (n) => '0x' + n.toString(16).padStart(64, '0');
    const numOf = (h) => parseInt(h.slice(2), 16);
    wss.on('connection', (ws) => ws.on('message', (raw) => {
        const { id, method, params = [] } = JSON.parse(String(raw));
        const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
        const error = (message) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 4003, message } }));
        if (method === 'chain_getHeader') return reply({ number: '0x' + head.toString(16) });
        if (method === 'chain_getBlockHash') return reply(params[0] === 0 && genesis ? genesis : params[0] <= head ? hashOf(params[0]) : null);
        if (method === 'state_getRuntimeVersion') {
            const n = params[0] ? numOf(params[0]) : head;
            if (n < prunedBelow) return error('State already discarded');
            return reply({ specName: 'node', specVersion: n >= upgradeAt ? 392 : 373, transactionVersion: n >= upgradeAt ? 3 : 2 });
        }
        return error('unknown method ' + method);
    }));
    return new Promise((ok) => wss.on('listening', () => ok({ url: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() })));
}

function runScript(args) {
    const script = fileURLToPath(new URL('../scripts/find-upgrade-block.mjs', import.meta.url));
    return new Promise((ok) => {
        const p = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => ok({ code, out, err }));
    });
}

describe('scripts/find-upgrade-block.mjs end to end', () => {
    test('prints the upgrade block and the dev-instance MIN_BLOCK', async () => {
        const node = await mockNode({ head: 1600000, upgradeAt: 1553840 });
        try {
            const r = await runScript(['--ws', node.url]);
            assert.equal(r.code, 0, r.err);
            assert.match(r.out, /head #1600000, node spec 392, transaction version 3/);
            assert.match(r.out, /spec 373 -> 392 or later enacted in block #1553840 .*#1553841 is the first block built with it/);
            assert.match(r.out, /RESULT upgrade-block=1553840 previous-spec=373 head-spec=392 head=1600000 MIN_BLOCK=1552840 WINDOW_END=1554840 WINDOW_BLOCKS=2001/);
            assert.match(r.out, /genesis 0x0{64}/);
            assert.doesNotMatch(r.out, /WARNING/);
        } finally { node.close(); }
    });

    test('a copy of mainnet (mainnet genesis hash) is flagged', async () => {
        // Genesis served for block 0 only; the spec lookups by hash still work
        // because the mock decodes the number from any other hash.
        const node = await mockNode({ head: 3000, upgradeAt: 0, genesis: MAINNET_GENESIS });
        try {
            const r = await runScript(['--ws', node.url]);
            assert.match(r.out, /WARNING: this chain has the MAINNET genesis hash/);
        } finally { node.close(); }
    });

    test('not upgraded: non-zero exit and a plain message', async () => {
        const node = await mockNode({ head: 5000, upgradeAt: 10000 });
        try {
            const r = await runScript(['--ws', node.url]);
            assert.equal(r.code, 1);
            assert.match(r.out, /RESULT not-upgraded: head runs spec 373/);
        } finally { node.close(); }
    });

    test('pruned state: non-zero exit that names the archive-node need', async () => {
        const node = await mockNode({ head: 5000, upgradeAt: 4000, prunedBelow: 4900 });
        try {
            const r = await runScript(['--ws', node.url]);
            assert.equal(r.code, 1);
            assert.match(r.err, /FAILED: state at #0 unavailable .*State already discarded.*archive node/);
        } finally { node.close(); }
    });

    test('usage error without --ws', async () => {
        const r = await runScript([]);
        assert.equal(r.code, 2);
        assert.match(r.err, /Usage: node scripts\/find-upgrade-block.mjs --ws/);
    });
});
