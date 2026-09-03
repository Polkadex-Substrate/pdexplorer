// The heights a scanner SKIPPED but could not afford to record. (Audit F-010)
//
// THE BUG THIS EXISTS FOR
//
// `recordSkippedRange` writes at most SKIP_RECORD_MAX (2000) scan_failures for
// a skipped span, then logs:
//
//     "...recorded the oldest 2000 (SKIP_RECORD_MAX) — the rest remain
//      discoverable by the gap scan"
//
// That sentence is true for exactly one of its three callers. `chain_index` has
// a LEAD gap scan over the `blocks` table, so an unrecorded hole there really is
// found later. `governance` and `staking_rewards` have no such scan — there is
// no table of "every governance height that should exist" to diff against. For
// those two, every height past the 2000th was silently abandoned: not queued,
// not scanned, not repairable, and not counted in the trust mark that tells
// users the index is complete. A long outage produced a permanent hole that the
// status badge reported as Synced.
//
// The cap itself is right and stays: writing 12 million scan_failures rows in
// one synchronous loop would stall the indexer for minutes. What was missing is
// that the REMAINDER has to be remembered somewhere, and drained over
// subsequent ticks. This module is the arithmetic for that ledger, kept pure so
// the merge/drain edge cases are unit-testable without a database — the same
// treatment as lib/watermark.js and lib/gap-scheduling.js.
//
// Ranges are INCLUSIVE [lo, hi] and kept sorted, disjoint and non-adjacent.

// How many disjoint ranges to keep before coalescing lossily. Each range is
// ~30 bytes of JSON in one KV row; 64 is far more than a healthy indexer ever
// accumulates, and bounds the row if something pathological happens.
export const MAX_TAIL_RANGES = 64;

function norm(r) {
    const lo = Math.min(Number(r.lo), Number(r.hi));
    const hi = Math.max(Number(r.lo), Number(r.hi));
    return { lo, hi };
}

function valid(r) {
    return r && Number.isFinite(Number(r.lo)) && Number.isFinite(Number(r.hi))
        && Number(r.lo) >= 0 && Number(r.hi) >= 0;
}

/** Sort, drop junk, and coalesce overlapping OR adjacent ranges. */
export function normalizeTail(ranges) {
    const list = (Array.isArray(ranges) ? ranges : []).filter(valid).map(norm)
        .sort((a, b) => a.lo - b.lo);
    const out = [];
    for (const r of list) {
        const last = out[out.length - 1];
        // `<= last.hi + 1` merges ADJACENT ranges too: [1,5] and [6,9] are one
        // span [1,9]. Without the +1 a long outage drained in chunks would
        // fragment into hundreds of touching ranges and hit MAX_TAIL_RANGES.
        if (last && r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi);
        else out.push({ lo: r.lo, hi: r.hi });
    }
    return out;
}

/**
 * Add a skipped span to the ledger.
 *
 * When the ledger would exceed MAX_TAIL_RANGES, merge the two ranges separated
 * by the SMALLEST gap. That over-approximates — it re-queues some heights that
 * were never skipped — which is safe (a scanner re-fetching a height it already
 * has is wasted work, not corruption) and is the cheapest way to stay bounded
 * while losing the least. Dropping the oldest range instead would silently
 * recreate exactly the permanent hole this module exists to prevent.
 */
export function addTail(ranges, span) {
    if (!valid(span)) return normalizeTail(ranges);
    let out = normalizeTail([...(Array.isArray(ranges) ? ranges : []), norm(span)]);
    while (out.length > MAX_TAIL_RANGES) {
        let bestAt = 0, bestGap = Infinity;
        for (let i = 0; i < out.length - 1; i++) {
            const gap = out[i + 1].lo - out[i].hi;
            if (gap < bestGap) { bestGap = gap; bestAt = i; }
        }
        out[bestAt] = { lo: out[bestAt].lo, hi: Math.max(out[bestAt].hi, out[bestAt + 1].hi) };
        out.splice(bestAt + 1, 1);
    }
    return out;
}

/**
 * Take up to `limit` heights off the front of the ledger.
 *
 * Front-first — i.e. LOWEST heights first — deliberately. The oldest skipped
 * heights are the ones least likely to still be reachable from a pruned node,
 * so they are the ones worth attempting soonest; and draining from a stable end
 * means a tail that keeps growing at the top still makes progress at the
 * bottom rather than starving.
 *
 * Returns { heights, rest }. `heights` is capped at `limit`, so one tick can
 * never write an unbounded number of scan_failures rows — the very thing
 * SKIP_RECORD_MAX was protecting against.
 */
export function takeFromTail(ranges, limit) {
    const n = Number(limit);
    const list = normalizeTail(ranges);
    if (!Number.isFinite(n) || n <= 0) return { heights: [], rest: list };
    const heights = [];
    const rest = [];
    for (const r of list) {
        if (heights.length >= n) { rest.push(r); continue; }
        const room = n - heights.length;
        const span = r.hi - r.lo + 1;
        if (span <= room) {
            for (let h = r.lo; h <= r.hi; h++) heights.push(h);
        } else {
            for (let h = r.lo; h < r.lo + room; h++) heights.push(h);
            rest.push({ lo: r.lo + room, hi: r.hi });
        }
    }
    return { heights, rest };
}

/** Total heights still owed. What the status line should report. */
export function tailSize(ranges) {
    return normalizeTail(ranges).reduce((sum, r) => sum + (r.hi - r.lo + 1), 0);
}
