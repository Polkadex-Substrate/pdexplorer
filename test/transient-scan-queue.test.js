// Transient RPC failures must be QUEUED for retry, not dropped.
//
// WHAT HAPPENED (Oct 2026)
//
// While rpc1 was suspended, the node answered slowly or not at all. Each
// scanner's catch block classified those errors as "node unavailable" and,
// to avoid burning one of the block's ten retry lives, returned
// `{ ok: false, transient: true }` WITHOUT writing a scan_failures row. The
// forward/backfill passes then moved their watermarks past those heights
// anyway. governance, staking_rewards and transactions have no gap scan to
// rediscover a hole, so the blocks were simply gone: council motion #134
// (proposed #13,141,046) never reached the explorer.
//
// "Don't count the attempt" had been implemented as "don't record the block".
// These tests pin the difference, against a real database.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import * as db from '../db.js';
import { queueRangeIfAbsent, queueOneIfAbsent, QUEUEABLE_INDEXERS } from '../lib/scan-queue.js';

const dirs = [];
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-tq-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const rowsFor = (dir, indexer) => {
    const h = new DatabaseSync(path.join(dir, 'explorer.db'));
    try { return h.prepare('SELECT block, attempts, last_error AS e FROM scan_failures WHERE indexer = ? ORDER BY block').all(indexer); }
    finally { h.close(); }
};

describe('queueing does not count an attempt (real DB)', () => {
    test('a queued transient height is retrievable by the gap-fill query at attempts 0', () => {
        freshDir();
        assert.equal(db.queueScanFailureIfAbsent('governance', 13141046, 'node unavailable, deferred (attempt not counted): timeout'), true);
        const got = db.getScanFailures('governance', 20, 10);
        assert.equal(got.length, 1);
        assert.equal(got[0].block, 13141046);
        assert.equal(got[0].attempts, 0);
    });

    test('a height that already has a real failure keeps its count and error', () => {
        freshDir();
        db.recordScanFailure('governance', 500, 'events could not be decoded at this height (F-006)');
        db.recordScanFailure('governance', 500, 'events could not be decoded at this height (F-006)');
        assert.equal(db.queueScanFailureIfAbsent('governance', 500, 'node unavailable, deferred'), false);
        const [r] = db.getScanFailures('governance', 20, 10);
        assert.equal(r.attempts, 2);
        assert.match(r.lastError, /F-006/);
    });

    test('repeated transient failures of the same height never age it toward retirement', () => {
        freshDir();
        for (let i = 0; i < 25; i++) db.queueScanFailureIfAbsent('staking_rewards', 77, 'node unavailable');
        const [r] = db.getScanFailures('staking_rewards', 20, 10);
        assert.equal(r.attempts, 0, 'a node outage must not retire a block');
    });

    test('a transient row is visible to the watermark (status stays truthful)', () => {
        freshDir();
        db.queueScanFailureIfAbsent('governance', 13141046, 'node unavailable');
        assert.equal(db.getLowestScanFailure('governance'), 13141046);
    });
});

describe('lib/scan-queue range queueing (the operator repair path)', () => {
    test('queues every height once, inclusive, either order, and is repeatable', () => {
        const dir = freshDir();
        const h = new DatabaseSync(path.join(dir, 'explorer.db'));
        db.recordScanFailure('governance', 105, 'real failure');
        const first = queueRangeIfAbsent(h, 'governance', 110, 100, 'repair');
        assert.deepEqual(first, { added: 10, alreadyQueued: 1 });
        const again = queueRangeIfAbsent(h, 'governance', 100, 110, 'repair');
        assert.deepEqual(again, { added: 0, alreadyQueued: 11 });
        h.close();
        const rows = rowsFor(dir, 'governance');
        assert.equal(rows.length, 11);
        assert.deepEqual({ ...rows.find(r => r.block === 105) }, { block: 105, attempts: 1, e: 'real failure' });
        assert.ok(rows.filter(r => r.block !== 105).every(r => r.attempts === 0));
    });

    test('rejects unknown indexers and bad ranges instead of writing junk', () => {
        const dir = freshDir();
        const h = new DatabaseSync(path.join(dir, 'explorer.db'));
        assert.throws(() => queueRangeIfAbsent(h, 'governanse', 1, 2, 'x'), /unknown indexer/);
        assert.throws(() => queueRangeIfAbsent(h, 'governance', 0, 2, 'x'), /invalid range/);
        h.close();
        assert.equal(rowsFor(dir, 'governance').length, 0);
    });

    test('db.js and the tool share one statement', () => {
        const dbSrc = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
        assert.match(dbSrc, /queueOneIfAbsent\(db, indexer, block, errMessage\)/);
        assert.ok(!/VALUES \(\?, \?, 0, \?, \?, \?\)/.test(dbSrc), 'db.js has its own copy of the queue SQL again');
        assert.ok(QUEUEABLE_INDEXERS.includes('governance'));
        assert.equal(typeof queueOneIfAbsent, 'function');
    });
});

describe('tools/requeue-scan-range.mjs end to end', () => {
    const tool = new URL('../tools/requeue-scan-range.mjs', import.meta.url).pathname;
    const run = (dir, ...args) => execFileSync(process.execPath,
        ['--experimental-sqlite', '--no-warnings', tool, '--data-dir', dir, ...args], { encoding: 'utf8' });

    test('--blocks queues exactly those heights', () => {
        const dir = freshDir();
        const out = run(dir, '--indexer', 'governance', '--blocks', '13146180,13141046,13141046');
        assert.match(out, /2 new/);
        assert.deepEqual(rowsFor(dir, 'governance').map(r => r.block), [13141046, 13146180]);
    });

    test('--dry-run writes nothing', () => {
        const dir = freshDir();
        run(dir, '--indexer', 'staking_rewards', '--from', '10', '--to', '20', '--dry-run');
        assert.equal(rowsFor(dir, 'staking_rewards').length, 0);
    });

    test('a range is queued; an oversized one is refused', () => {
        const dir = freshDir();
        run(dir, '--indexer=transactions', '--from=1000', '--to=1099');
        assert.equal(rowsFor(dir, 'transactions').length, 100);
        assert.throws(() => run(dir, '--indexer', 'transactions', '--from', '1', '--to', '300000'), /max 200000|200,000|split/);
    });
});

describe('every transient branch in server.js queues the block', () => {
    // Comment-stripped, so the long explanation above deferTransientScan
    // cannot satisfy the assertion by itself (the self-match trap).
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    test('each `transient: true` return is directly preceded by deferTransientScan for the right indexer', () => {
        const lines = src.split('\n');
        const hits = [];
        lines.forEach((l, i) => { if (/return \{[^}]*transient: true/.test(l)) hits.push(i); });
        assert.ok(hits.length >= 3, `expected the three scanner transient returns, found ${hits.length}`);
        for (const i of hits) {
            const prev = lines.slice(Math.max(0, i - 3), i).join('\n');
            assert.match(prev, /deferTransientScan\('(governance|staking_rewards|transactions)', blockNumber, short\)/,
                `transient return at server.js (stripped) line ${i + 1} does not queue the block:\n${lines[i]}`);
        }
        for (const ix of ['governance', 'staking_rewards', 'transactions']) {
            assert.match(src, new RegExp(`deferTransientScan\\('${ix}'`), `${ix} scanner no longer queues transient blocks`);
        }
    });

    test('deferTransientScan queues without counting (never recordScanFailure)', () => {
        const body = src.slice(src.indexOf('function deferTransientScan'), src.indexOf('function deferTransientScan') + 600);
        assert.match(body, /queueScanFailureIfAbsent\(/);
        assert.ok(!/recordScanFailure\(/.test(body), 'transient failures must not consume retry attempts');
    });
});
