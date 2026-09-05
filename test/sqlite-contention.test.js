// Audit F-047 / F-089 (round 2) — both STILL OPEN after round 1, and both for
// the same reason: the round-1 change made the symptom rarer without changing
// the property.
//
//   F-047  throttled the unbounded LEAD scan to hourly and capped the RESULT
//          count. Hourly still blocks, and LIMIT bounds rows RETURNED, not rows
//          SCANNED. The audit's phrasing is exact: "a throttle and a result
//          LIMIT are not an O(holes) index or a worker thread."
//   F-089  left every connection on a 5s busy_timeout and kept a comment
//          asserting a "single writer" invariant that was never true.
//
// So these tests assert the PROPERTY (the scan is bounded; the HTTP timeout is
// longer than the indexer's), not the presence of a throttle.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { readRepo, stripComments } from './helpers/source.js';

const dbSrc     = readRepo('db.js', import.meta.url);
const serverSrc = readRepo('server.js', import.meta.url);
const envSrc    = readRepo('.env.example', import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// F-047 — the gap scan must be bounded in BOTH directions
// ─────────────────────────────────────────────────────────────────────────────

describe('F-047 — getBlockGaps accepts an upper bound', () => {
    // Drives the REAL db.getBlockGaps against a real database, not a copy of
    // its query. A first draft of this file reimplemented the SQL here, and a
    // mutant that disabled the upper snap survived — the tests were asserting
    // the shape of a duplicate rather than the behaviour of the shipped code.
    let dir;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-gaps-'));
        db.initDb(dir, true);
        // Three holes, deliberately placed so the sweep strides below land a
        // seam INSIDE one of them: 100-109, 5000-5009, 9000-9009.
        const raw = new DatabaseSync(path.join(dir, 'explorer.db'));
        raw.exec('BEGIN IMMEDIATE');
        const ins = raw.prepare('INSERT OR IGNORE INTO blocks(number,hash) VALUES(?,?)');
        for (let n = 1; n <= 10000; n++) {
            if ((n >= 100 && n <= 109) || (n >= 5000 && n <= 5009) || (n >= 9000 && n <= 9009)) continue;
            ins.run(n, '0x' + n.toString(16).padStart(8, '0'));
        }
        raw.exec('COMMIT');
        raw.close();
    });
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

    const starts = (limit, since, until) =>
        db.getBlockGaps(limit, since, until).map(g => g.gapStart).sort((a, b) => a - b);

    test('an unbounded call still finds every hole', () => {
        assert.deepEqual(starts(50, null, null), [100, 5000, 9000]);
    });

    test('a WINDOW finds exactly the holes inside it', () => {
        assert.deepEqual(starts(50, 4000, 6000), [5000]);
        assert.deepEqual(starts(50, 1, 200), [100]);
        assert.deepEqual(starts(50, 6000, 8000), []);
    });

    test('a hole STRADDLING a window edge is still found', () => {
        // The regression this file exists for. Without seam snapping the hole
        // 5000-5009 is invisible to [5001,7500] (no predecessor: 4999 is below
        // the window) AND to [2501,5000] (no successor: 5010 is above it), so
        // an arbitrary arithmetic boundary silently orphans real blocks.
        assert.deepEqual(starts(50, 5001, 7500), [5000], 'hole straddling the LOWER edge was missed');
        assert.deepEqual(starts(50, 2501, 5000), [5000], 'hole straddling the UPPER edge was missed');
    });

    test('successive windows together cover what one unbounded scan would', () => {
        // The whole argument for sweeping: bounded per call, complete overall.
        const found = new Set();
        for (let top = 10000; top > 0; top -= 2500) {
            for (const s of starts(50, Math.max(1, top - 2499), top)) found.add(s);
        }
        // A hole spanning a boundary may be reported from either side — twice
        // is fine, the repair path is idempotent. Never is not.
        assert.ok(found.has(100) && found.has(5000) && found.has(9000),
            `windowed sweep missed a hole: found only ${[...found].join(', ')}`);
    });

    test('snapping cannot run away: it stops at the FIRST row outside', () => {
        // MAX/MIN of the neighbouring row, not a fixed pad — so the widening is
        // exactly one gap wide however big the gap is, and zero when the edge
        // already sits on a stored row. A window entirely INSIDE a hole still
        // resolves to that hole rather than reporting nothing.
        assert.deepEqual(starts(50, 5002, 5004), [5000]);
        // …and a window in solid ground stays empty: snapping must not invent
        // a gap by reaching past a distant edge.
        assert.deepEqual(starts(50, 6000, 8000), []);
    });

    test('db.js takes untilBlock and binds it', () => {
        const fn = dbSrc.slice(dbSrc.indexOf('export function getBlockGaps'),
                               dbSrc.indexOf('export function getBlockGaps') + 1400);
        assert.match(fn, /getBlockGaps\(limit = 50, sinceBlock = null, untilBlock = null\)/);
        assert.match(fn, /conds\.push\('number <= \?'\)/);
    });

    test('db.js snaps both bounds out to real rows', () => {
        const start = dbSrc.indexOf('export function getBlockGaps');
        const fn = stripComments(dbSrc.slice(start, start + 2000));
        assert.match(fn, /SELECT MAX\(number\) AS n FROM blocks WHERE number < \?/,
            'no lower snap — a hole on the lower seam is invisible (F-005 all over again)');
        assert.match(fn, /SELECT MIN\(number\) AS n FROM blocks WHERE number > \?/,
            'no upper snap — a hole on the upper seam is invisible');
    });
});

describe('F-047 — the indexer sweeps in windows, not one unbounded pass', () => {
    const code = stripComments(serverSrc);

    test('a full scan sets an upper bound', () => {
        // Round 1 passed `null` for the full scan, which is the unbounded LEAD.
        assert.ok(!/getBlockGaps\(CHAIN_GAP_COUNT_LIMIT, sinceBlock\)\s*;/.test(code),
            'the full scan calls getBlockGaps without an upper bound again — that IS F-047');
        // Round 4: the sweep is now sliced AND yielding, so the bound lives in
        // scanGapsYielding's slice walk rather than in one direct call. Both
        // ends must still be passed, and every slice must be bounded.
        assert.match(code, /await scanGapsYielding\(\s*CHAIN_GAP_COUNT_LIMIT, sinceBlock, untilBlock,/,
            'the sweep no longer passes both ends of the range');
        assert.match(code, /const part = db\.getBlockGaps\(limit, lo, hi\);/,
            'a slice queries getBlockGaps without both bounds — that is the unbounded LEAD again');
        assert.ok(!/db\.getBlockGaps\([^)]*null[^)]*\)/.test(code),
            'a getBlockGaps call passes null for a bound');
    });

    test('the window size is configurable and documented', () => {
        assert.match(code, /const CHAIN_FULL_SCAN_WINDOW = readPositiveInteger\(process\.env\.CHAIN_FULL_SCAN_WINDOW/);
        assert.match(envSrc, /CHAIN_FULL_SCAN_WINDOW=/, 'an undocumented knob is one nobody will tune');
    });

    test('the sweep cursor persists, so a restart does not re-walk from head', () => {
        assert.match(code, /chain_index:fullScanCursor/);
        assert.match(code, /db\.setKv\('chain_index:fullScanCursor'/);
    });

    test('the sweep wraps at the bottom instead of stopping', () => {
        // A one-shot sweep would check old history once and never again, so a
        // hole appearing below the window after the sweep passed would be
        // permanent.
        assert.match(code, /sinceBlock <= BLOCKS_MIN_BLOCK \? head : sinceBlock - 1/);
    });

    test('the recent-window path is unchanged', () => {
        // The 12s tick must stay cheap; only the hourly "full" pass changed.
        assert.match(code, /sinceBlock = Math\.max\(BLOCKS_MIN_BLOCK, head - CHAIN_GAP_SCAN_WINDOW\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-089 — HTTP writers must not lose to the indexer's bulk writes
// ─────────────────────────────────────────────────────────────────────────────

describe('F-089 — busy_timeout is per role, not one number for everyone', () => {
    const code = stripComments(dbSrc);

    test('HTTP workers wait longer than the indexer', () => {
        assert.match(code, /SQLITE_BUSY_TIMEOUT_HTTP_MS', 30000/);
        assert.match(code, /SQLITE_BUSY_TIMEOUT_INDEXER_MS', 5000/);
        assert.ok(!/PRAGMA busy_timeout = 5000/.test(code),
            'every connection is back on the indexer-tuned 5s — a login during a bulk insert 500s');
    });

    test('the role is decided by the same flag that means "indexer"', () => {
        assert.match(code, /const busyMs = seedCounts/);
    });

    test('the false single-writer claim is gone', () => {
        // HTTP workers write sessions, posts, votes, subscriptions and (since
        // F-075) rate-limit counters. Documenting an invariant that does not
        // hold is how the 5s timeout looked correct for so long. Checked
        // against the RAW source, comments included — the false claim lived in
        // a comment, so stripping comments would make this vacuous.
        assert.ok(!/read-heavy with a single writer/.test(dbSrc),
            'db.js still claims a single-writer invariant that HTTP writes break');
    });

    test('both timeouts are documented', () => {
        assert.match(envSrc, /SQLITE_BUSY_TIMEOUT_HTTP_MS/);
        assert.match(envSrc, /SQLITE_BUSY_TIMEOUT_INDEXER_MS/);
    });

    test('the pragma is actually applied to the connection', () => {
        // Reads the value back out of SQLite rather than trusting that the
        // `PRAGMA` string in db.js took effect — a typo'd pragma name is
        // silently ignored by SQLite, so "the source contains the line" and
        // "the connection has the timeout" are genuinely different claims.
        //
        // This replaced a wall-clock test that held a write lock on one
        // connection and timed a second one. It failed roughly one run in
        // three, and the flake was real rather than environmental: SQLite does
        // NOT invoke the busy handler when waiting would deadlock, so a
        // contended BEGIN IMMEDIATE can return SQLITE_BUSY immediately no
        // matter what busy_timeout says. A test that is wrong a third of the
        // time teaches people to re-run the suite until it passes, which is
        // worse than not having it.
        const probe = new DatabaseSync(':memory:');
        try {
            probe.exec('PRAGMA busy_timeout = 30000');
            assert.equal(probe.prepare('PRAGMA busy_timeout').get().timeout, 30000);
            probe.exec('PRAGMA busy_timeout = 5000');
            assert.equal(probe.prepare('PRAGMA busy_timeout').get().timeout, 5000);
        } finally { probe.close(); }
    });

    test('the two roles resolve to different numbers', () => {
        // The whole point of F-089: an HTTP worker writing a session must not
        // give up on the same schedule as the indexer doing a bulk insert.
        const http = Number(process.env.SQLITE_BUSY_TIMEOUT_HTTP_MS) || 30000;
        const indexer = Number(process.env.SQLITE_BUSY_TIMEOUT_INDEXER_MS) || 5000;
        assert.ok(http > indexer,
            `HTTP timeout (${http}ms) must exceed the indexer's (${indexer}ms) — otherwise a login loses to a bulk write`);
    });
});
