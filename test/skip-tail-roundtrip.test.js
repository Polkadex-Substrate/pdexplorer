// F-010 — the skip tail against a REAL database.
//
// WHY THIS FILE EXISTS
//
// test/skip-tail.test.js covers lib/skip-tail.js exhaustively: 22 tests, every
// merge and drain edge case. All of them pass against pure functions, and none
// of them touch SQLite. That is the same test shape that let F-044 ship broken
// — unit tests on the builder, source tests on the caller, nothing asserting
// the round trip through persistence — so this file exists specifically to
// close that gap for F-010 before an audit round finds it.
//
// It found one immediately: the drain was calling recordScanFailure(), which
// does `attempts = attempts + 1` on conflict. Since addTail()'s bounding step
// deliberately over-approximates, the drain can touch heights that already have
// real failure rows — pushing them toward the retirement cap without ever
// attempting a fetch. getScanFailures() filters `attempts < maxAttempts`, so
// those heights would silently stop being retried while the status line went on
// counting them as known and handled.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { addTail, takeFromTail, tailSize, normalizeTail } from '../lib/skip-tail.js';

const dirs = [];
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-tail-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// The production drain, transcribed. server.js cannot be imported (it opens a
// DB, a socket and an RPC connection at module load), so the logic is mirrored
// and the source assertions at the bottom pin the two together.
function drain(indexer, perTick) {
    const key = `skip:tail:${indexer}`;
    const ranges = normalizeTail((db.getKv(key) || {}).ranges || []);
    if (!ranges.length) return { drained: 0, queued: 0 };
    const { heights, rest } = takeFromTail(ranges, perTick);
    let queued = 0;
    for (const n of heights) {
        if (db.queueScanFailureIfAbsent(indexer, n, 'skip tail: queued after SKIP_RECORD_MAX truncation (F-010)')) queued++;
    }
    db.setKv(key, { ranges: rest, updatedAt: Date.now() });
    return { drained: heights.length, queued };
}

describe('F-010 — the ledger survives the KV round trip', () => {
    test('ranges written as JSON come back usable', () => {
        // The F-044 failure mode was a shape that did not survive persistence.
        freshDb();
        const ranges = addTail([], { lo: 500, hi: 900 });
        db.setKv('skip:tail:governance', { ranges, updatedAt: Date.now() });

        const back = (db.getKv('skip:tail:governance') || {}).ranges;
        assert.deepEqual(back, [{ lo: 500, hi: 900 }]);
        assert.equal(tailSize(back), 401, 'the ledger lost its size through JSON');
    });

    test('the key the writer uses is the key the reader reads', () => {
        // F-196 was exactly this: the purge wrote `backfillCursor` while the
        // scanner read `txBackfillCursor`, so the reset was a silent no-op.
        freshDb();
        db.setKv('skip:tail:staking_rewards', { ranges: [{ lo: 1, hi: 3 }], updatedAt: 1 });
        assert.ok(db.getKv('skip:tail:staking_rewards'), 'the tail key does not round-trip');
        assert.equal(db.getKv('skip:tail:governance'), null, 'indexers are sharing one tail');
    });
});

describe('F-010 — draining queues heights the retry machinery can see', () => {
    test('drained heights become retriable scan_failures', () => {
        freshDb();
        db.setKv('skip:tail:governance', { ranges: [{ lo: 100, hi: 104 }], updatedAt: Date.now() });
        const r = drain('governance', 500);
        assert.equal(r.drained, 5);
        assert.equal(r.queued, 5);

        // The whole point: the ordinary retry path must pick them up.
        const pending = db.getScanFailures('governance', 50);
        assert.deepEqual(pending.map(p => p.block).sort((a, b) => a - b), [100, 101, 102, 103, 104],
            'drained heights are not visible to getScanFailures — they were queued nowhere useful');
    });

    test('drained heights pin the contiguous watermark', () => {
        // A hole that does not move the watermark is a hole the status line
        // lies about, which is the F-004/F-010 family in one sentence.
        freshDb();
        db.setKv('skip:tail:governance', { ranges: [{ lo: 700, hi: 702 }], updatedAt: Date.now() });
        drain('governance', 500);
        assert.equal(db.getLowestScanFailure('governance'), 700,
            'the watermark does not see the drained tail, so status can still say Synced over it');
    });

    test('the ledger shrinks by exactly what was drained, and empties', () => {
        freshDb();
        db.setKv('skip:tail:governance', { ranges: [{ lo: 1, hi: 25 }], updatedAt: Date.now() });
        let guard = 0, total = 0;
        while (tailSize((db.getKv('skip:tail:governance') || {}).ranges || []) > 0) {
            total += drain('governance', 7).drained;
            assert.ok(++guard < 100, 'the drain did not terminate');
        }
        assert.equal(total, 25);
        assert.equal(db.getScanFailures('governance', 100).length, 25, 'a height was lost between ticks');
    });

    test('each indexer drains its own tail only', () => {
        freshDb();
        db.setKv('skip:tail:governance', { ranges: [{ lo: 10, hi: 11 }], updatedAt: 1 });
        db.setKv('skip:tail:staking_rewards', { ranges: [{ lo: 90, hi: 91 }], updatedAt: 1 });
        drain('governance', 500);
        assert.deepEqual(db.getScanFailures('governance', 50).map(p => p.block).sort((a, b) => a - b), [10, 11]);
        assert.equal(db.getScanFailures('staking_rewards', 50).length, 0,
            'draining one indexer queued another indexer\'s heights');
    });
});

describe('F-010 — the drain must not retire blocks it never tried', () => {
    test('an existing failure row keeps its attempt count', () => {
        // THE BUG THIS FILE FOUND. recordScanFailure increments on conflict.
        // A height at 9 real failures would be pushed to 10 by a bookkeeping
        // write, and getScanFailures (attempts < 10) would stop returning it.
        freshDb();
        for (let i = 0; i < 9; i++) db.recordScanFailure('governance', 555, 'real fetch failure');
        const before = db.getScanFailures('governance', 10).find(p => p.block === 555);
        assert.equal(before.attempts, 9);

        db.setKv('skip:tail:governance', { ranges: [{ lo: 555, hi: 555 }], updatedAt: Date.now() });
        const r = drain('governance', 500);
        assert.equal(r.drained, 1);
        assert.equal(r.queued, 0, 'the drain claimed to queue a height that already had a row');

        const after = db.getScanFailures('governance', 10).find(p => p.block === 555);
        assert.ok(after, 'block 555 was retired by a write that attempted nothing');
        assert.equal(after.attempts, 9, 'the drain incremented a real attempt counter');
    });

    test('the existing error message is not overwritten', () => {
        // The real error is what requeueTransientScanFailures matches on to
        // decide whether a height is rescuable. Clobbering it with the
        // bookkeeping string would make a genuine transport casualty
        // unrescuable — the mistake recordChainScanFailures warns about.
        freshDb();
        db.recordScanFailure('governance', 777, 'rpc not ready (disconnected mid-fetch)');
        db.setKv('skip:tail:governance', { ranges: [{ lo: 777, hi: 777 }], updatedAt: Date.now() });
        drain('governance', 500);
        const row = db.getScanFailures('governance', 10).find(p => p.block === 777);
        assert.match(row.lastError, /disconnected mid-fetch/,
            'the drain overwrote the real error, so the transient requeue can no longer match it');
    });

    test('a genuinely new height starts at zero attempts', () => {
        // It was never tried, so it must get the full retry budget.
        freshDb();
        db.setKv('skip:tail:governance', { ranges: [{ lo: 888, hi: 888 }], updatedAt: Date.now() });
        drain('governance', 500);
        const row = db.getScanFailures('governance', 10).find(p => p.block === 888);
        assert.equal(row.attempts, 0, 'a never-attempted height was queued with attempts already spent');
    });

    test('draining the same height twice is idempotent', () => {
        // The tail over-approximates by design, so repeat drains happen.
        freshDb();
        db.setKv('skip:tail:governance', { ranges: [{ lo: 42, hi: 42 }], updatedAt: Date.now() });
        drain('governance', 500);
        db.setKv('skip:tail:governance', { ranges: [{ lo: 42, hi: 42 }], updatedAt: Date.now() });
        drain('governance', 500);
        const rows = db.getScanFailures('governance', 10).filter(p => p.block === 42);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].attempts, 0, 'a repeat drain spent an attempt');
    });
});

describe('F-010 — production uses the non-incrementing write', () => {
    test('drainSkipTail calls queueScanFailureIfAbsent, not recordScanFailure', () => {
        const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        const at = srv.indexOf('function drainSkipTail');
        const next = srv.slice(at + 1).search(/\n(async )?function /);
        const fn = next === -1 ? srv.slice(at) : srv.slice(at, at + 1 + next);
        assert.match(fn, /db\.queueScanFailureIfAbsent\(indexer, n,/);
        assert.ok(!/db\.recordScanFailure\(/.test(fn),
            'the drain increments attempts again — it can retire blocks it never tried');
    });

    test('queueScanFailureIfAbsent does not increment on conflict', () => {
        const dbSrc = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
        const at = dbSrc.indexOf('export function queueScanFailureIfAbsent');
        const fn = dbSrc.slice(at, dbSrc.indexOf('\n}', at));
        assert.match(fn, /ON CONFLICT\(indexer, block\) DO NOTHING/);
        assert.ok(!/attempts\s*=\s*attempts\s*\+\s*1/.test(fn));
        assert.match(fn, /VALUES \(\?, \?, 0,/, 'a new row must start at zero attempts');
    });
});
