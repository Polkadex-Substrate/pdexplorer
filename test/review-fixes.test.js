// Repairs made in response to the adversarial review of the round-2 batch.
//
// These are fixes to my OWN remediation, which is the class of bug hardest to
// keep fixed: the surrounding code already looks finished, so a later edit that
// reintroduces one reads as tidying. A mutation run found nine of the eleven
// properties below completely uncovered, which is exactly why this file exists.
//
// Three of them were introduced BY a fix — a correct change with a consequence
// its author (me) did not follow through:
//
//   * making an empty analytics series uncacheable turned the live-aggregate
//     fallthrough into an unauthenticated event-loop DoS;
//   * moving a cooldown to a shared counter also moved it above validation;
//   * deriving the watermark from the failure queue, including permanent rows,
//     left no way for a permanently-failed height ever to clear.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';

const server = stripComments(readRepo('server.js', import.meta.url));
const dbSrc = stripComments(readRepo('db.js', import.meta.url));
const script = stripComments(readRepo('script.js', import.meta.url));
const envExample = readRepo('.env.example', import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// The analytics DoS, introduced by the F-081 fix
// ─────────────────────────────────────────────────────────────────────────────

describe('analytics/timeseries cannot be used to stall a worker', () => {
    // Bounded by the NEXT route registration, not by a byte count. A fixed
    // 2600-char window ran past the end of this handler into the analytics
    // snapshot route, which legitimately sends no-store — so the "must not be
    // no-store" assertion failed against an unrelated route. Third time a
    // fixed-size slice has done this in one batch.
    const fn = (() => {
        const i = server.indexOf("app.get('/api/analytics/timeseries'");
        assert.ok(i !== -1, 'the timeseries route moved');
        const next = server.indexOf("app.get('", i + 10);
        return server.slice(i, next === -1 ? undefined : next);
    })();

    test('days is snapped to the pre-warmed set', () => {
        // Only 7/30/90/365 are pre-warmed. Every other value ran
        // db.getDailyAnalytics() — a GROUP BY over `blocks` and `transactions`
        // with NO index on `timestamp`, so a full scan of a 12.8M-row table,
        // synchronous in node:sqlite, blocking the whole worker.
        // `days` must be ASSIGNED from the snap, not merely near it. A mutant
        // that kept the reduce but restored `const days = askedDays` survived
        // an earlier version of this assertion — the presence of the right
        // expression says nothing about whether its result is used.
        assert.match(fn, /const days = ANALYTICS_TS_RANGES\.reduce\(/,
            'days is free-form again — 358 uncached values, each an unindexed full scan');
        assert.ok(!/const days = askedDays/.test(fn),
            'the snapped value is computed and then ignored');
        assert.ok(!/const days = Math\.min\(Math\.max\(parseInt/.test(fn),
            'the raw 1..365 clamp is back as the effective window');
        // And the value that reaches the query must be the snapped one.
        assert.match(fn, /const sinceTs = Date\.now\(\) - days \* 24/);
    });

    test('the snap actually picks a pre-warmed range', () => {
        // Reproduces the shipped expression rather than trusting the grep.
        const RANGES = [7, 30, 90, 365];
        const snap = (asked) => RANGES.reduce(
            (best, r) => Math.abs(r - asked) < Math.abs(best - asked) ? r : best, RANGES[0]);
        for (const asked of [1, 7, 8, 29, 30, 60, 91, 200, 364, 365]) {
            assert.ok(RANGES.includes(snap(asked)), `${asked} snapped outside the set`);
        }
        assert.equal(snap(91), 90);
        assert.equal(snap(1), 7);
        assert.equal(snap(365), 365);
    });

    test('the fallthrough is still cacheable', () => {
        // `no-store` here is what removed the edge's ability to absorb the
        // repeat requests. A short TTL keeps the honesty (an empty series
        // self-corrects within seconds) without handing out a free scan.
        assert.match(fn, /cacheShort\(res\)/,
            'the live-aggregate path is uncacheable again — every request re-runs the scan');
        assert.ok(!/res\.set\('Cache-Control', 'no-store'\)/.test(fn),
            'no-store is back on the analytics fallthrough');
    });

    test('the response still distinguishes empty from not-yet-indexed', () => {
        // The actual F-081 fix, which must survive the DoS repair.
        assert.match(fn, /indexIncomplete/);
        assert.match(fn, /requestedDays/, 'the caller is not told which window was answered');
    });

    test('a populated series still gets the medium TTL', () => {
        assert.match(fn, /cached\.series\.length\) \{\s*\n\s*cacheMedium\(res\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// knownGapBlocks arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('gap counts are counts, not spans', () => {
    test('the edge merge does not reassign the counting array', () => {
        // `gaps` is reduced into interiorGapBlocks and the edge total is added
        // separately, so merging in place counted every edge hole twice — and
        // the inflated value is persisted and carried forward across the 24-of-
        // 25 ticks that skip the throttled scan, so the doubling stuck.
        assert.ok(!/\bgaps = edgeForRepair\.concat\(gaps\)/.test(server),
            'edge holes are double-counted into knownGapBlocks again');
        assert.match(server, /repairCandidates = edgeForRepair\.concat\(gaps\)/);
    });

    test('the rotation reads the superset, the arithmetic reads the interior', () => {
        assert.match(server, /chooseGap\(repairCandidates,/);
        assert.match(server, /exhaustedGapCount\(repairCandidates,/);
        assert.match(server, /\? gaps\.reduce\(\(sum, g\) => sum \+ \(Number\(g\.gapSize\) \|\| 0\), 0\)/);
    });

    test('governance and staking report a queue COUNT', () => {
        // `headSeen - latestScannedBlock` is the size of the unverified span.
        // describeIndexStatus renders it as "N blocks missing inside the indexed
        // range", so ONE failed height 750k blocks back announced "750001
        // blocks missing" — the F-010 untruth, inverted.
        assert.ok(!/Math\.max\(0, headSeen - latestScannedBlock\)/.test(server),
            'a scanner reports an unverified span as a missing-block count');
        assert.match(server, /const govUnverified = govFailCounts\.total;/);
        assert.match(server, /knownGapBlocks: rewardFailCounts\.total,/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The permanently-pinned watermark
// ─────────────────────────────────────────────────────────────────────────────

describe('a permanently-failed height cannot freeze the index forever', () => {
    test('there is an amnesty for exhausted rows', () => {
        // getLowestScanFailure counts permanent rows on purpose — a block the
        // node cannot serve is still a hole. But nothing could ever clear one:
        // getScanFailures excludes them, requeueTransientScanFailures only
        // matches connection-level text, and the F-046 amnesty resets an
        // in-memory Map. "Count them but never retry them" is not a defensible
        // pair — it froze latestScannedBlock and Degraded for the life of the DB.
        assert.match(dbSrc, /export function requeueExhaustedScanFailures/,
            'no amnesty — one unreadable height pins the watermark permanently');
    });

    test('it is bounded and oldest-first', () => {
        const fn = dbSrc.slice(dbSrc.indexOf('export function requeueExhaustedScanFailures'),
                               dbSrc.indexOf('export function requeueExhaustedScanFailures') + 900);
        assert.match(fn, /ORDER BY last_at ASC/, 'a dead height could starve newer ones');
        assert.match(fn, /LIMIT \?/, 'an unbounded amnesty is itself a thundering re-scan');
        assert.match(fn, /attempts >= \? AND last_at < \?/);
    });

    test('it is actually scheduled', () => {
        // Defined-but-never-called is how pruneRateLimits and exhaustedGapCount
        // both got caught in earlier rounds.
        assert.match(server, /setInterval\(sweepExhaustedFailures, SCAN_AMNESTY_MS\)\.unref\(\)/,
            'the amnesty is defined but never runs');
        assert.match(server, /db\.requeueExhaustedScanFailures\(SCAN_MAX_ATTEMPTS, SCAN_AMNESTY_MS\)/);
    });

    test('the window is configurable and documented', () => {
        assert.match(server, /const SCAN_AMNESTY_MS = readPositiveInteger\(process\.env\.SCAN_AMNESTY_MS/);
        assert.match(envExample, /SCAN_AMNESTY_MS=21600000/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mid-tick checkpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('the mid-tick checkpoint does not wipe coverage', () => {
    test('it merges the existing state', () => {
        // setSyncState is setKv — a full replace. The mid-tick write listed
        // only the watermark fields, so knownGapBlocks, interiorGapBlocks,
        // gapsExhausted, retryableFailures, permanentFailures and detail were
        // dropped every tick. /api/blocks reads exactly those, and a restart in
        // that window made the next carry-forward read 0 — so deriveIndexStatus
        // could report Synced over an interior hole.
        const i = server.indexOf("db.setSyncState('chain_index', {");
        const block = server.slice(i, i + 700);
        assert.match(block, /\.\.\.state,/,
            'the mid-tick checkpoint replaces the row instead of merging — coverage reports zeros every tick');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cooldown ordering, page-size clamp, status rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('the label cooldown is spent on writes, not on typos', () => {
    test('the gate runs after validation', () => {
        // The Map it replaced recorded the timestamp AFTER a successful upsert,
        // so a rejected label cost nothing. consumeRateLimit spends the slot on
        // the attempt, so placing it first made a typo burn the full 60s.
        const fn = server.slice(server.indexOf("app.post('/api/labels/:address'"),
                                server.indexOf("app.post('/api/labels/:address'") + 3500);
        const checkAt = fn.indexOf('checkUserText(');
        const gateAt = fn.indexOf("consumeRateLimit('label-write'");
        assert.ok(checkAt !== -1 && gateAt !== -1, 'the label route moved');
        assert.ok(checkAt < gateAt,
            'the cooldown is consumed before the input is validated — a typo costs the full window');
    });

    test('the discussion cooldown is likewise after validation', () => {
        const fn = server.slice(server.indexOf("consumeRateLimit('discussion-post'") - 900,
                                server.indexOf("consumeRateLimit('discussion-post'") + 200);
        assert.match(fn, /Post content is required/);
        assert.match(fn, /Post is too long/);
    });
});

describe('the page-size clamp only ever reduces work', () => {
    test('a too-small count is not snapped to the ceiling', () => {
        // The first version treated `asked < 1` the same as `asked > MAX` and
        // set both to MAX, so `count: 0` — which asks for nothing — became a
        // request for the largest page allowed.
        assert.match(server, /Math\.min\(Math\.max\(Math\.trunc\(asked\), 1\), RPC_MAX_PAGE\)/,
            'the guard raises the work for its most conservative input');
    });

    test('the clamp arithmetic behaves', () => {
        const RPC_MAX_PAGE = 100;
        const clamp = (asked) => Math.min(Math.max(Math.trunc(asked), 1), RPC_MAX_PAGE);
        assert.equal(clamp(0), 1);
        assert.equal(clamp(-5), 1);
        assert.equal(clamp(1), 1);
        assert.equal(clamp(50), 50);
        assert.equal(clamp(100), 100);
        assert.equal(clamp(5000), 100);
        assert.equal(clamp(2.7), 2);
    });
});

describe('the SPA renders the statuses the server can send', () => {
    test('Repairing and Degraded have their own badges', () => {
        // deriveIndexStatus can return both, and indexerStatusBadge knew
        // neither — so every honest "there is a hole and we are working on it"
        // rendered as a red "Indexer error … it will retry automatically".
        // For Degraded that message is the opposite of true.
        assert.match(script, /if \(status === 'Repairing'\) \{/,
            'Repairing falls through to the generic error badge');
        assert.match(script, /if \(status === 'Degraded'\) \{/,
            'Degraded falls through to "it will retry automatically" — it will not');
    });

    test('Degraded does not promise an automatic retry', () => {
        // Just this branch: a wider window reaches the generic fallthrough,
        // which says "retry automatically" for a legitimately different case.
        const at = script.indexOf("if (status === 'Degraded') {");
        const fn = script.slice(at, script.indexOf('\n    }', at));
        assert.ok(!/retry automatically/.test(fn),
            'Degraded promises an automatic retry — retries have stopped');
        assert.match(fn, /will not resolve on its own/);
    });

    test('Repairing is not styled as an error', () => {
        const at = script.indexOf("if (status === 'Repairing') {");
        const fn = script.slice(at, script.indexOf('\n    }', at));
        assert.ok(!/var\(--error\)/.test(fn), 'a recoverable state is painted as a failure');
    });

    test('the spinner still excludes both', () => {
        // Deliberate and pre-existing: a spinner REPLACES the badge, so
        // spinning over Repairing would hide the very status this work exists
        // to surface. Pinned because it is easy to "fix" the wrong way.
        const idx = readRepo('lib/index-status.js', import.meta.url);
        const fn = idx.slice(idx.indexOf('export function shouldShowCrawlSpinner'));
        assert.ok(!/'Repairing'/.test(fn.slice(fn.indexOf('return status'))));
    });
});
