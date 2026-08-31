// Two different questions, one field — audit F-004 / F-009 / F-010 (round 2).
//
// Every scanner persisted a single `latestScannedBlock` and used it to answer
// two questions that stop agreeing the moment a fetch fails:
//
//   "where do I resume the forward pass?"   → must be the highest height we
//                                             have already ATTEMPTED, or we
//                                             re-fetch the whole span each tick
//   "how far is the index trustworthy?"     → must be the highest height below
//                                             which nothing is missing
//
// Round 1 answered both with `head`, recorded the skipped heights in
// `scan_failures`, and left a comment justifying the jump: moving the watermark
// backwards would re-fetch blocks we already hold. That reasoning is right about
// the RESUME question and wrong about the TRUST question, and because one field
// carried both, the trust answer lost. The round-2 audit's verdict is exactly
// this: "recovery around the jump, not removal of the jump."
//
// The cost is not theoretical. On 2026-08-22 a four-hour RPC outage left a
// 1,213-block hole while `/api/blocks` reported "Synced", because the watermark
// said those heights had been scanned. A visitor searching for a transaction in
// that range was told it did not exist.
//
// So the two questions get two fields:
//
//   headSeen             the top of the CLAIMED span — how far forward we have
//                        reached. Only ever moves up. Drives resume, and is the
//                        upper bound `getEdgeGaps` compares MAX(number) against.
//   latestScannedBlock   the top of the VERIFIED span — the highest height with
//                        no known hole at or below it. Derived, never assigned.
//
// Deriving the second rather than assigning it is what makes this self-healing:
// the watermark is a function of the outstanding failure queue, so repairing a
// hole lets it advance on the very next tick with no separate bookkeeping to
// get out of step.

// The highest height we can honestly claim is fully indexed.
//
//   headSeen                  top of the claimed span
//   lowestOutstandingFailure  lowest height with a scan_failures row, or null
//   floor                     bottom of the claimed span (oldestScannedBlock)
//
// A hole at height F means everything from F upward is unverified, so the
// answer is F-1 — regardless of how many blocks above F are safely stored.
// That is deliberately pessimistic: a watermark is a promise about a RANGE, and
// one hole voids the promise for the whole range above it. The blocks above F
// are still served; they are just not covered by the "everything below here is
// present" claim, which is the only claim this value makes.
export function contiguousWatermark({
    headSeen = 0, lowestOutstandingFailure = null, floor = 0
} = {}) {
    const top = numeric(headSeen, 0);
    const bottom = numeric(floor, 0);
    const fail = lowestOutstandingFailure == null ? null : numeric(lowestOutstandingFailure, NaN);

    let mark = top;
    if (fail != null && Number.isFinite(fail)) mark = Math.min(mark, fail - 1);

    // Never below "the claimed range is empty". A failure at or under the floor
    // means coverage is broken at its own bottom edge — a prefix hole, which
    // getEdgeGaps reports separately. Letting `mark` run negative there would
    // turn one missing block into a nonsense watermark.
    const empty = bottom > 0 ? bottom - 1 : 0;
    if (mark < empty) mark = empty;
    return mark < 0 ? 0 : mark;
}

// True when the scanner may honestly describe itself as caught up: the claimed
// span reaches the chain head AND nothing inside it is outstanding.
//
// Kept next to the watermark because the two were also conflated — round 1
// could report 'Synced' with a non-empty skip queue, which is F-010's residual
// verbatim ("End-of-tick status can still be 'Synced' with a skip queue").
export function isCaughtUp({ headSeen = 0, head = 0, lowestOutstandingFailure = null } = {}) {
    if (numeric(headSeen, 0) < numeric(head, 0)) return false;
    return lowestOutstandingFailure == null || !Number.isFinite(numeric(lowestOutstandingFailure, NaN));
}

// Read a persisted span-top, tolerating state written before headSeen existed.
//
// Load-bearing for the deploy, not a nicety. Production `sync:chain_index` has
// a `latestScannedBlock` near 12.8M and no `headSeen`. A plain `Number(x) || 0`
// would start the forward pass at 0 and re-walk the entire chain from genesis
// on the first tick after the upgrade — millions of RPC calls against
// rpc.polkadex.ee, which is the public endpoint browsers dial.
export function readHeadSeen(state) {
    if (!state) return 0;
    const fresh = numeric(state.headSeen, NaN);
    if (Number.isFinite(fresh) && fresh > 0) return fresh;
    // Pre-upgrade rows: the old single field WAS the claimed span top, since it
    // jumped to head. Adopting it is exactly right.
    const legacy = numeric(state.latestScannedBlock, NaN);
    return Number.isFinite(legacy) && legacy > 0 ? legacy : 0;
}

function numeric(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
