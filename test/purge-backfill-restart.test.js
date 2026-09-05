// F-203 — after a purge, the genesis walk must actually RUN.
//
// WHY THIS FILE EXISTS
//
// F-196 was a writer/reader key mismatch: the purge wrote `backfillCursor` and
// the scanner read `txBackfillCursor`, so the reset was a silent no-op. The fix
// made the names agree. The test for it asserted the names agree.
//
// F-203 is what that test could not see: the names now agree and the agreed
// value is *itself* a no-op. There are TWO defects behind it, and the audit
// named one.
//
// (a) What the audit described. `txBackfillCursor: null` was meant to send
//     syncTransactions into its first-run branch —
//
//         txBackfillCursor = Math.max(TX_MIN_BLOCK - 1, oldestScannedBlock - 1);
//         txBackfillComplete = txBackfillCursor < TX_MIN_BLOCK;
//
//     — which is right in general (coverage already at genesis means nothing
//     left to walk) and wrong after a purge, because a host that finished the
//     F-008 walk has oldestScannedBlock === 1, so the cursor is 0 and the walk
//     is declared complete.
//
// (b) What transcribing the arithmetic into this file exposed, and the audit
//     got wrong. That branch was never reached at all. The cursor was read as
//     `Number.isFinite(Number(state.txBackfillCursor)) ? Number(...) : null`,
//     and `Number(null)` is 0 — which IS finite. So a stored JSON null came
//     back as the number 0, `=== null` was false, and the first-run branch was
//     dead code for precisely the case it existed to handle. The real
//     behaviour was not "complete flips true" but cursor 0 with complete
//     staying FALSE: the walk never runs and the status line reports "deriving
//     historical transfers, next chunk ends at block 0" for ever.
//
// Same `Number(null) === 0` trap as estimatedApy in lib/apy.js, eight hours
// apart, in unrelated code. Reject the absent values BEFORE coercing.
//
// Either way the outcome is the one that matters: the purge deleted legacy rows
// at every height, only the 20k head recrawl replaced any of them, and a
// visitor sees a Synced transfer list permanently missing the rest.
//
// So this file asserts the STATE TRANSITION through a real database, then
// replays the reader's own arithmetic against it. Name-matching is what let
// F-203 through; this asserts the value does work.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';

const TX_MIN_BLOCK = 1;                       // server.js default
const dirs = [];
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-purge-'));
    dirs.push(dir);
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// syncTransactions' first-run branch, transcribed from server.js. If the reader
// changes, the source assertion at the bottom fails and this must be revisited.
function readerFirstRun({ txBackfillCursor, txBackfillComplete, oldestScannedBlock }) {
    // Mirrors the FIXED read in server.js. The original was
    // `Number.isFinite(Number(x)) ? Number(x) : null`, and Number(null) is 0 —
    // finite — so a stored null became 0 and the first-run branch below was
    // dead code. Transcribing it here is what exposed that.
    let cursor = (txBackfillCursor === null || txBackfillCursor === undefined)
        ? null
        : (Number.isFinite(Number(txBackfillCursor)) ? Number(txBackfillCursor) : null);
    let complete = !!txBackfillComplete;
    if (cursor === null && !complete) {
        cursor = Math.max(TX_MIN_BLOCK - 1, oldestScannedBlock - 1);
        complete = cursor < TX_MIN_BLOCK;
    }
    return { cursor, complete, willWalk: !complete && cursor >= TX_MIN_BLOCK };
}

describe('F-203 — the catch-up hands over a cursor that walks', () => {
    test('on a host whose walk already reached genesis', () => {
        // The exact production shape the finding describes.
        const dir = freshDir();
        db.initDb(dir, false, { awaitMigrator: false });
        db.setSyncState('transactions', {
            oldestScannedBlock: 1,               // walk previously finished
            latestScannedBlock: 12_000_000,
            txBackfillComplete: true,
            scannerVersion: 2
        });
        db.setKv('migration:purge-legacy-tx-rows', { deleted: 5, total: 100, completedAt: Date.now() });

        // Re-open with seedCounts so the F-196 catch-up branch runs.
        db.initDb(dir, true, { awaitMigrator: false });

        const st = db.getSyncState('transactions');
        assert.equal(st.txBackfillComplete, false, 'the walk was not restarted at all');
        assert.notEqual(st.txBackfillCursor, null,
            'the cursor is null again — first-run will mark the walk complete before it runs (F-203)');

        const run = readerFirstRun({ ...st, oldestScannedBlock: st.oldestScannedBlock });
        assert.equal(run.willWalk, true,
            'the reader still declines to walk: this is the F-203 no-op, with matching key names');
        assert.ok(run.cursor >= TX_MIN_BLOCK);
    });

    test('the null cursor really would have been a no-op', () => {
        // Pins the mechanism, so the fix cannot be "simplified" back later.
        const bad = readerFirstRun({ txBackfillCursor: null, txBackfillComplete: false, oldestScannedBlock: 1 });
        assert.equal(bad.cursor, 0);
        assert.equal(bad.complete, true);
        assert.equal(bad.willWalk, false,
            'if this ever walks, the premise of F-203 changed and this file needs rereading');
    });

    test('first-run is still correct for a genuinely fresh install', () => {
        // The fix must not force a pointless full walk where coverage really is
        // only the head window. Nothing purged, cursor stays null, first-run
        // starts just below live coverage exactly as before.
        const fresh = readerFirstRun({
            txBackfillCursor: null, txBackfillComplete: false, oldestScannedBlock: 11_980_000
        });
        assert.equal(fresh.cursor, 11_979_999);
        assert.equal(fresh.willWalk, true);
    });

    test('the cursor starts at the TOP of coverage, not the bottom', () => {
        // The purge deleted legacy rows at ANY height, so resuming from
        // oldestScannedBlock would skip everything above it.
        const dir = freshDir();
        db.initDb(dir, false, { awaitMigrator: false });
        db.setSyncState('transactions', {
            oldestScannedBlock: 1, latestScannedBlock: 9_000_000, txBackfillComplete: true
        });
        db.setKv('migration:purge-legacy-tx-rows', { deleted: 3, total: 50, completedAt: Date.now() });
        db.initDb(dir, true, { awaitMigrator: false });
        assert.equal(db.getSyncState('transactions').txBackfillCursor, 9_000_000,
            'the walk resumes below the deleted rows and never re-derives them');
    });

    test('the catch-up is marked done so it cannot loop', () => {
        const dir = freshDir();
        db.initDb(dir, false, { awaitMigrator: false });
        db.setSyncState('transactions', { oldestScannedBlock: 1, latestScannedBlock: 5_000, txBackfillComplete: true });
        db.setKv('migration:purge-legacy-tx-rows', { deleted: 2, total: 10, completedAt: Date.now() });
        db.initDb(dir, true, { awaitMigrator: false });
        const marker = db.getKv('migration:purge-legacy-tx-rows');
        assert.ok(marker.resetVersion, 'the catch-up did not stamp resetVersion and will re-fire every boot');

        // Second boot must be a no-op, not another reset.
        db.setSyncState('transactions', { ...db.getSyncState('transactions'), txBackfillCursor: 42 });
        db.initDb(dir, true, { awaitMigrator: false });
        assert.equal(db.getSyncState('transactions').txBackfillCursor, 42,
            'the catch-up re-fired and clobbered live backfill progress');
    });

    test('a purge that deleted nothing does not restart the walk', () => {
        const dir = freshDir();
        db.initDb(dir, false, { awaitMigrator: false });
        db.setSyncState('transactions', { oldestScannedBlock: 1, latestScannedBlock: 7_000, txBackfillComplete: true });
        db.setKv('migration:purge-legacy-tx-rows', { deleted: 0, total: 10, completedAt: Date.now() });
        db.initDb(dir, true, { awaitMigrator: false });
        assert.equal(db.getSyncState('transactions').txBackfillComplete, true,
            'a no-op purge triggered a full re-walk for nothing');
    });
});

describe('F-203 — the reader arithmetic this file models is still the real one', () => {
    test('server.js first-run matches the transcription above', () => {
        // If syncTransactions changes shape, readerFirstRun is stale and every
        // assertion above is about a function that no longer exists. This is
        // the F-044 lesson: a model of the code is only as good as its pin.
        const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        assert.match(srv, /txBackfillCursor = Math\.max\(TX_MIN_BLOCK - 1, oldestScannedBlock - 1\);/);
        assert.match(srv, /txBackfillComplete = txBackfillCursor < TX_MIN_BLOCK;/);
        assert.match(srv, /if \(txBackfillCursor === null && !txBackfillComplete\) \{/);
        // And that a stored null can actually REACH that branch — the second
        // half of F-203. If this reverts, the branch is dead again.
        assert.match(srv, /\(state\.txBackfillCursor === null \|\| state\.txBackfillCursor === undefined\)/,
            'a stored null coerces to 0 again, so the first-run branch is unreachable');
    });

    test('the purge writers hand over an explicit height', () => {
        const dbSrc = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
        // Comment-stripped: db.js explains the old null behaviour in prose, and
        // counting raw matches self-matches on that explanation.
        const code = dbSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
        const nulls = (code.match(/txBackfillCursor: null/g) || []).length;
        assert.equal(nulls, 0, 'a purge writer still hands over null — first-run will no-op it (F-203)');
        assert.equal((dbSrc.match(/txBackfillCursor: postPurgeBackfillCursor\(st\)/g) || []).length, 2,
            'both purge paths (v1 catch-up and the live purge) must set an explicit cursor');
    });

    test('the helper is at module scope', () => {
        // F-199: a function-local declaration is invisible to its callers and
        // fails at runtime on a path nobody loaded in testing.
        const dbSrc = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
        assert.match(dbSrc, /^function postPurgeBackfillCursor\(st\) \{/m);
    });
});
