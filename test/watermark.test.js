// Audit F-004 / F-009 / F-010 (round 2) — one root cause, three scanners.
//
// All three were PARTIAL after round 1 for the same reason, and the audit's
// close test is identical for each: after a forced per-block fetch failure, the
// persisted watermark must NOT equal chain head. Round 1 recorded the skipped
// heights and built a retry queue around them but still assigned
// `latestScannedBlock = head`, which the round-2 report called "recovery around
// the jump, not removal of the jump".
//
// The tests below are written against that close test, not against the
// mechanism. The load-bearing ones are:
//
//   * a failure pins the watermark below itself
//   * clearing the failure lets it advance again WITHOUT extra bookkeeping
//   * headSeen still jumps, so the forward pass does not re-fetch
//   * readHeadSeen adopts pre-upgrade state (a deploy-day property: getting
//     this wrong re-walks 12.8M blocks against the public RPC endpoint)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { contiguousWatermark, isCaughtUp, readHeadSeen } from '../lib/watermark.js';
import { readRepo, stripComments } from './helpers/source.js';

describe('contiguousWatermark', () => {
    test('with a clean queue it equals the claimed span top', () => {
        assert.equal(contiguousWatermark({ headSeen: 12_800_000, lowestOutstandingFailure: null }), 12_800_000);
    });

    test('THE close test: one failure and the watermark is not head', () => {
        // "After a forced per-block fetch failure, json_extract on
        // sync:chain_index does not equal chain head." — verbatim, three times.
        const head = 12_800_000;
        const mark = contiguousWatermark({ headSeen: head, lowestOutstandingFailure: 12_798_787, floor: 1 });
        assert.notEqual(mark, head, 'the watermark still jumps to head — that IS F-004');
        assert.equal(mark, 12_798_786);
    });

    test('one hole pins it however many blocks sit above', () => {
        // The 2026-08-22 incident shape: a 1,213-block hole four hours back,
        // with tens of thousands of good blocks indexed above it since. Those
        // blocks are still SERVED; they are just not covered by the claim.
        const mark = contiguousWatermark({ headSeen: 12_800_000, lowestOutstandingFailure: 12_657_000 });
        assert.equal(mark, 12_656_999);
    });

    test('it advances again the moment the queue clears — no other bookkeeping', () => {
        // Self-healing is the whole reason the value is derived rather than
        // stored. If a repair had to separately "un-pin" the watermark, that
        // second step is what would rot.
        const before = contiguousWatermark({ headSeen: 900, lowestOutstandingFailure: 500 });
        const after  = contiguousWatermark({ headSeen: 900, lowestOutstandingFailure: null });
        assert.equal(before, 499);
        assert.equal(after, 900);
    });

    test('a failure ABOVE the span top cannot push it up', () => {
        // Nonsense input (a queued height we have not reached) must not inflate
        // the claim. min() both ways.
        assert.equal(contiguousWatermark({ headSeen: 100, lowestOutstandingFailure: 5000 }), 100);
    });

    test('a failure at or below the floor means "the claimed range is empty"', () => {
        // A prefix hole: coverage is broken at its own bottom edge. Reporting
        // floor-1 says "nothing verified" rather than running negative.
        assert.equal(contiguousWatermark({ headSeen: 900, lowestOutstandingFailure: 100, floor: 100 }), 99);
        assert.equal(contiguousWatermark({ headSeen: 900, lowestOutstandingFailure: 50, floor: 100 }), 99);
    });

    test('it never goes negative', () => {
        assert.equal(contiguousWatermark({ headSeen: 0, lowestOutstandingFailure: 0, floor: 0 }), 0);
        assert.equal(contiguousWatermark({ headSeen: 5, lowestOutstandingFailure: 1, floor: 0 }), 0);
    });

    test('garbage in does not produce garbage out', () => {
        for (const bad of [undefined, null, NaN, 'x', {}, [], Infinity]) {
            const v = contiguousWatermark({ headSeen: bad, lowestOutstandingFailure: bad, floor: bad });
            assert.ok(Number.isFinite(v) && v >= 0, `non-finite watermark from ${String(bad)}: ${v}`);
        }
        assert.equal(contiguousWatermark(), 0);
        assert.equal(contiguousWatermark(undefined), 0);
    });
});

describe('isCaughtUp', () => {
    test('true only when the span reaches head AND the queue is empty', () => {
        assert.equal(isCaughtUp({ headSeen: 100, head: 100, lowestOutstandingFailure: null }), true);
    });

    test('a skip queue means NOT caught up, even at head', () => {
        // F-010's residual verbatim: "End-of-tick status can still be 'Synced'
        // with a skip queue."
        assert.equal(isCaughtUp({ headSeen: 100, head: 100, lowestOutstandingFailure: 40 }), false);
    });

    test('behind head is not caught up', () => {
        assert.equal(isCaughtUp({ headSeen: 90, head: 100, lowestOutstandingFailure: null }), false);
    });

    test('past head counts as caught up (head moves between reads)', () => {
        assert.equal(isCaughtUp({ headSeen: 101, head: 100, lowestOutstandingFailure: null }), true);
    });
});

describe('readHeadSeen — the deploy-day property', () => {
    test('pre-upgrade state is adopted, not discarded', () => {
        // Production `sync:chain_index` has latestScannedBlock ≈ 12.8M and no
        // headSeen. Returning 0 here would restart the forward pass at genesis
        // and fire millions of RPC calls at rpc.polkadex.ee — the PUBLIC
        // endpoint that browsers dial.
        assert.equal(readHeadSeen({ latestScannedBlock: 12_800_000 }), 12_800_000);
    });

    test('the new field wins once it exists', () => {
        assert.equal(readHeadSeen({ headSeen: 12_800_500, latestScannedBlock: 12_798_786 }), 12_800_500);
    });

    test('a pinned legacy watermark does not drag headSeen backwards later', () => {
        // After the upgrade, latestScannedBlock is the LOWER of the two. If the
        // legacy branch ever won again the crawler would re-scan the repaired
        // range every tick, forever.
        assert.equal(readHeadSeen({ headSeen: 900, latestScannedBlock: 400 }), 900);
    });

    test('genuinely empty state is 0', () => {
        assert.equal(readHeadSeen({}), 0);
        assert.equal(readHeadSeen(null), 0);
        assert.equal(readHeadSeen({ headSeen: 0, latestScannedBlock: 0 }), 0);
        assert.equal(readHeadSeen({ headSeen: 'nonsense' }), 0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The close test, run end to end against a real database.
//
// The two halves above — a pure function and a source grep — can both pass
// while the thing they connect through is broken. A mutation run proved it:
// swapping MIN for MAX in getLowestScanFailure survived the entire suite,
// because nothing exercised that query. It would have pinned the watermark to
// the NEWEST hole instead of the oldest, so every block below a recent skip
// would be silently re-claimed as verified — the original finding, restored,
// under a fix that looked correct in both unit tests and the source.
// ─────────────────────────────────────────────────────────────────────────────

describe('F-004 close test — a real failure row, a real derivation', () => {
    let dir;
    const HEAD = 12_800_000;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-wm-'));
        db.initDb(dir, true);
    });
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

    const mark = () => contiguousWatermark({
        headSeen: HEAD,
        lowestOutstandingFailure: db.getLowestScanFailure('chain_index'),
        floor: 1
    });

    test('an empty queue reads as null, and the watermark is the span top', () => {
        assert.equal(db.getLowestScanFailure('chain_index'), null);
        assert.equal(mark(), HEAD);
    });

    test('THE close test: one recorded failure and the watermark is not head', () => {
        db.recordScanFailure('chain_index', 12_798_787, 'forced: fetch failed');
        assert.equal(db.getLowestScanFailure('chain_index'), 12_798_787);
        assert.notEqual(mark(), HEAD, 'the watermark still equals head — F-004 is not closed');
        assert.equal(mark(), 12_798_786);
    });

    test('it tracks the OLDEST hole, not the newest', () => {
        // The mutation survivor. With MAX instead of MIN the watermark would
        // sit just below the most RECENT skip and silently re-claim everything
        // beneath it — including the older hole that is still outstanding.
        db.recordScanFailure('chain_index', 11_000_000, 'forced: older hole');
        db.recordScanFailure('chain_index', 12_799_999, 'forced: newer hole');
        assert.equal(db.getLowestScanFailure('chain_index'), 11_000_000);
        assert.equal(mark(), 10_999_999,
            'the watermark followed a newer hole and re-claimed the older one');
    });

    test('permanent failures count too', () => {
        // A block the RPC will never serve is still a hole. Excluding it once
        // attempts exceed the cap would let the watermark sail past the one
        // class of gap that cannot fix itself.
        for (let i = 0; i < 20; i++) db.recordScanFailure('chain_index', 11_000_000, 'still failing');
        assert.equal(db.getLowestScanFailure('chain_index'), 11_000_000);
        assert.equal(mark(), 10_999_999);
    });

    test('clearing the rows lets it advance again, with no other bookkeeping', () => {
        for (const b of [11_000_000, 12_798_787, 12_799_999]) db.clearScanFailure('chain_index', b);
        assert.equal(db.getLowestScanFailure('chain_index'), null);
        assert.equal(mark(), HEAD);
    });

    test('the queue is per indexer', () => {
        // chain_index, staking_rewards and governance share the table; a hole
        // in one must not pin the others.
        db.recordScanFailure('governance', 500, 'forced');
        assert.equal(db.getLowestScanFailure('governance'), 500);
        assert.equal(db.getLowestScanFailure('chain_index'), null);
        assert.equal(db.getLowestScanFailure('staking_rewards'), null);
        db.clearScanFailure('governance', 500);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring. The pure function being right is worth nothing if a scanner still
// assigns the watermark directly, which is exactly what round 1 shipped.
// ─────────────────────────────────────────────────────────────────────────────

describe('all three scanners derive the watermark instead of assigning it', () => {
    const code = stripComments(readRepo('server.js', import.meta.url));

    test('nothing assigns latestScannedBlock = head any more', () => {
        assert.ok(!/latestScannedBlock = head\b/.test(code),
            'a scanner still jumps the watermark to head — that IS F-004/F-009/F-010');
    });

    test('each scanner persists a derived watermark', () => {
        const derivations = code.match(/latestScannedBlock: contiguousWatermark\(\{/g) || [];
        const locals = code.match(/const latestScannedBlock = contiguousWatermark\(\{/g) || [];
        // Three mid-tick checkpoints + three end-of-tick derivations.
        assert.equal(derivations.length, 3, `expected 3 checkpoint derivations, found ${derivations.length}`);
        assert.equal(locals.length, 3, `expected 3 end-of-tick derivations, found ${locals.length}`);
    });

    test('each scanner reads its span top through readHeadSeen', () => {
        const reads = code.match(/let headSeen = readHeadSeen\(state\)/g) || [];
        assert.equal(reads.length, 3, `expected 3 readHeadSeen calls, found ${reads.length}`);
        assert.ok(!/let latestScannedBlock = Number\(state\.latestScannedBlock\) \|\| 0;\s*\n\s*let oldestScannedBlock/.test(code),
            'a scanner still resumes from the verified watermark, so a pinned hole would make it re-scan forever');
    });

    test('edge-gap detection compares against headSeen, not the derived mark', () => {
        // Circularity trap: a suffix hole pulls the watermark below itself, so
        // comparing MAX(number) to the watermark hides the hole from the query
        // that exists to find it.
        assert.ok(!/getEdgeGaps\(oldestScannedBlock, latestScannedBlock\)/.test(code),
            'getEdgeGaps compares against the derived watermark — a suffix hole hides itself');
        assert.equal((code.match(/getEdgeGaps\(oldestScannedBlock, headSeen\)/g) || []).length, 2);
    });

    test('staking and governance no longer hardcode a healthy status', () => {
        // Scoped to the three BLOCK CRAWLERS. The snapshot syncs (treasury,
        // council, democracy, validators, holders, price) also write
        // `status: 'Synced'` and are right to: they replace their whole table
        // each pass and have no watermark, no skip queue, and no notion of a
        // hole. A blanket grep matched those and failed for the wrong reason.
        for (const scanner of ['staking_rewards', 'governance']) {
            const i = code.lastIndexOf(`db.setSyncState('${scanner}', {`);
            assert.ok(i !== -1, `no end-of-tick setSyncState for ${scanner}`);
            const block = code.slice(i, i + 900);
            assert.ok(!/status: 'Synced'/.test(block),
                `${scanner} writes status:'Synced' unconditionally — F-009/F-010 residual`);
            assert.ok(!/status: backfillComplete \? 'Synced' : 'Backfilling'/.test(block),
                `${scanner} still cannot report Repairing at all`);
        }
        // All three crawlers now go through the one ranking function, rather
        // than each having its own slightly different notion of "fine".
        assert.ok((code.match(/deriveIndexStatus\(\{/g) || []).length >= 3);
    });

    test('the forward pass resumes from the span top', () => {
        assert.equal((code.match(/if \(head > headSeen\)/g) || []).length, 3);
    });
});
