// F-202 — a queued height must be able to ESCALATE, against a real database.
//
// WHY THIS FILE EXISTS
//
// The F-010 fix taught the indexer to queue never-attempted skip-tail heights
// at `attempts = 0`. Governance is the crawler that was written for. But
// `scanBlockForGovernance` returned bare `null` when a block's events could not
// be decoded, and the gap-fill's `else stillFailing++` did not touch the row.
// So attempts stayed 0 for ever, and the consequence was not "a hole" but a
// system with no way out:
//
//   * getLowestScanFailure kept returning that height, so contiguousWatermark
//     stayed pinned at F-1;
//   * deriveIndexStatus reported Repairing permanently — never Synced, and
//     never Degraded either, because Degraded needs PERMANENT failures and
//     permanent needs attempts >= the cap;
//   * requeueExhaustedScanFailures, the operator's 6-hour amnesty, only matches
//     rows at or past the cap, so the unstick tool could never see it.
//
// F-010 traded "Synced over a hole" for "never Synced, never Degraded, never
// amnestied". The first is a wrong answer; the second is a stuck system.
//
// The property under test is the ESCALATION CHAIN, end to end against SQLite:
// queued at 0 → retried → permanent → amnestied. Every link is what makes the
// watermark able to move again. A source assertion that governance "calls
// recordScanFailure" would not have caught the original bug, because the bug
// was that it called nothing.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { contiguousWatermark } from '../lib/watermark.js';
import { deriveIndexStatus } from '../lib/index-status.js';

const CAP = 10;                                  // SCAN_MAX_ATTEMPTS default
const dirs = [];
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-esc-'));
    dirs.push(dir);
    db.initDb(dir, false, { awaitMigrator: false });
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('F-202 — a skip-tail height can escalate out of Repairing', () => {
    test('the full chain: queued at 0 -> permanent -> amnestied', () => {
        freshDb();
        // 1. The drain queues a never-attempted height (F-010).
        assert.equal(db.queueScanFailureIfAbsent('governance', 500, 'skip tail (F-010)'), true);
        assert.equal(db.getScanFailures('governance', 10, CAP)[0].attempts, 0);

        // 2. Retries that cannot decode events must COUNT. This is the link
        //    that was missing: governance returned null and recorded nothing.
        for (let i = 0; i < CAP; i++) {
            db.recordScanFailure('governance', 500, 'events could not be decoded at this height (F-006)');
        }

        // 3. At the cap the row is PERMANENT, which is what lets
        //    deriveIndexStatus say Degraded instead of Repairing for ever.
        const counts = db.countScanFailures('governance', CAP);
        assert.equal(counts.permanent, 1, 'the height never became permanent — status stays Repairing for ever');
        assert.equal(counts.retrying, 0);

        // 4. And the operator's amnesty can now see it. The amnesty requires
        //    last_at STRICTLY older than the cutoff, and requeueExhausted
        //    clamps a negative window to 0 — so a real (tiny) elapsed gap is
        //    needed rather than olderThanMs = 0 against a just-written row.
        const t0 = Date.now();
        while (Date.now() === t0) { /* advance the clock by >=1ms */ }
        const requeued = db.requeueExhaustedScanFailures(CAP, 0, 25);
        assert.ok(requeued > 0, 'requeueExhaustedScanFailures cannot see the row — the operator has no recourse');
        assert.equal(db.getScanFailures('governance', 10, CAP)[0].attempts, 0, 'amnesty did not reset attempts');
    });

    test('a row stuck at attempts=0 is invisible to amnesty', () => {
        // The original bug, asserted directly, so the mechanism is documented
        // by a test rather than only by a comment.
        freshDb();
        db.queueScanFailureIfAbsent('governance', 700, 'skip tail (F-010)');
        assert.equal(db.requeueExhaustedScanFailures(CAP, 0, 25), 0,
            'amnesty matched an attempts=0 row; the escalation chain is not what pins the watermark');
        assert.equal(db.countScanFailures('governance', CAP).permanent, 0);
    });

    test('while it is stuck, the watermark cannot move', () => {
        // The user-visible consequence: latestScannedBlock sits at the skip
        // floor and governance never reports Synced.
        freshDb();
        db.queueScanFailureIfAbsent('governance', 900, 'skip tail (F-010)');
        const lowest = db.getLowestScanFailure('governance');
        assert.equal(lowest, 900);
        const mark = contiguousWatermark({ headSeen: 12_000_000, lowestOutstandingFailure: lowest });
        assert.equal(mark, 899, 'the watermark is not pinned by the queued height');
    });

    test('once cleared, the watermark is released', () => {
        freshDb();
        db.queueScanFailureIfAbsent('governance', 900, 'skip tail (F-010)');
        db.clearScanFailure('governance', 900);
        assert.equal(db.getLowestScanFailure('governance'), null);
        assert.equal(contiguousWatermark({ headSeen: 12_000_000, lowestOutstandingFailure: null }), 12_000_000);
    });

    test('permanent failures read as Degraded, not Repairing for ever', () => {
        // Repairing says "working on it"; Degraded says "a human is needed".
        // A row that can never reach the cap can never say the second thing.
        freshDb();
        db.queueScanFailureIfAbsent('governance', 500, 'skip tail (F-010)');
        for (let i = 0; i < CAP; i++) db.recordScanFailure('governance', 500, 'undecodable (F-006)');
        const counts = db.countScanFailures('governance', CAP);
        // Field names read from lib/index-status.js rather than assumed — a
        // wrong key here silently yields 'Initializing' and the assertion
        // passes for the wrong reason.
        const status = deriveIndexStatus({
            initialized: true,
            backfillComplete: true,
            knownGapBlocks: 0,
            retryableFailures: counts.retrying,
            permanentFailures: counts.permanent
        });
        assert.equal(status, 'Degraded',
            'a height that exhausted its retries must read Degraded — Repairing says "working on it" for ever');

        // And the inverse: while it is still retryable it is Repairing, not
        // Degraded. Both directions, so the escalation is what changes it.
        assert.equal(deriveIndexStatus({
            initialized: true, backfillComplete: true,
            knownGapBlocks: 0, retryableFailures: 1, permanentFailures: 0
        }), 'Repairing');
    });
});

describe('F-202 — the error text must not be self-defeating', () => {
    test('the recorded reason avoids the transient-amnesty keywords', () => {
        // requeueTransientScanFailures matches on rpc / websocket /
        // disconnected / socket / econn. If the undecodable-events reason
        // contained one, that amnesty would reset attempts on every pass and
        // recreate the exact stuck state F-202 is about — a fix that undoes
        // itself. Assert against the string the code actually writes.
        freshDb();
        db.recordScanFailure('governance', 42, 'events could not be decoded at this height (F-006)');
        const row = db.getScanFailures('governance', 10, CAP)[0];
        for (const word of ['rpc', 'websocket', 'disconnected', 'socket', 'econn']) {
            assert.ok(!row.lastError.toLowerCase().includes(word),
                `the reason contains "${word}", so the transient amnesty will reset attempts for ever`);
        }
    });

    test('a genuinely transient reason IS still rescuable', () => {
        // The other half: a real disconnect must keep its escape hatch, or
        // avoiding those keywords above would have broken F-050.
        freshDb();
        db.recordScanFailure('governance', 43, 'rpc not ready (disconnected mid-fetch)');
        const row = db.getScanFailures('governance', 10, CAP)[0];
        assert.match(row.lastError, /disconnected/);
    });
});

describe('F-202 — governance records on every exit path', () => {
    const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const at = srv.indexOf('async function scanBlockForGovernance');
    const next = srv.slice(at + 1).search(/\n(async )?function /);
    const fn = next === -1 ? srv.slice(at) : srv.slice(at, at + 1 + next);

    test('the bare `return null` on undecodable events is gone', () => {
        assert.ok(!/if \(!events\) return null;/.test(fn),
            'undecodable events return null again, recording nothing — the watermark will stick');
    });

    test('it records a failure and returns ok:false', () => {
        // Assert the SHAPE of the whole block, not that a substring appears.
        //
        // A mutation of `void (0) && db.recordScanFailure(...)` survived the
        // first version of this test: the call never executes, but the string
        // being grepped for is still in the file. Same trap as the
        // `SELECT 1 -- INSERT INTO scan_failures` mutant that survived in the
        // round-2 harness — a searched-for string can sit inside the very
        // construct that disables it.
        //
        // So: slice the `if (!events)` block, strip comments and whitespace,
        // and compare against the exact statements expected. Any prefix,
        // guard, or short-circuit changes this string and fails.
        const at = fn.indexOf('if (!events) {');
        assert.ok(at > 0, 'the !events branch is gone');
        const block = fn.slice(at, fn.indexOf('\n        }', at));
        const code = block.split('\n')
            .filter(l => !l.trim().startsWith('//'))
            .join(' ').replace(/\s+/g, ' ').trim();
        assert.equal(code,
            "if (!events) { if (!EVENTS_STRICT) return { treasury: [], motions: [], ok: true }; " +
            "db.recordScanFailure('governance', blockNumber, " +
            "'events could not be decoded at this height (F-006)'); " +
            "return { treasury: [], motions: [], ok: false };",
            'the !events branch is not exactly: strict escape hatch, record, return ok:false');
    });

    test('EVENTS_STRICT=0 keeps the pruned-node escape hatch', () => {
        // Same contract as transactions and rewards. Without it, a pruned node
        // queues every height it cannot decode and fills the table.
        assert.match(fn, /if \(!EVENTS_STRICT\) return \{ treasury: \[\], motions: \[\], ok: true \};/);
    });

    test('gap-fill ages the row even if the scan returns nothing', () => {
        const gap = srv.slice(srv.indexOf('for (const f of govFailures)'), srv.indexOf('for (const f of govFailures)') + 1400);
        assert.match(gap, /if \(!r\) \{\s*\n\s*db\.recordScanFailure\('governance', f\.block,/,
            'a retry that returns nothing leaves attempts untouched, which is indistinguishable from no retry');
    });
});
