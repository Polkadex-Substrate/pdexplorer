// Which hole does the gap-fill pass repair this tick?
//
// Audit F-046. The old answer was always `gaps[0]` — the NEWEST hole — and the
// scan that produced `gaps` usually only looked at the last CHAIN_GAP_SCAN_WINDOW
// (5000) heights. Two consequences, both of which show up as "the explorer says
// Repairing forever":
//
//   STARVATION. A hole that cannot be filled — heights the RPC has pruned, a
//   height that fails to decode — is still the newest hole on the next tick,
//   and the one after that. The repair budget goes to the same unfillable
//   range indefinitely while every older hole waits behind it.
//
//   INVISIBILITY. A hole below the window is not in `gaps` at all except on the
//   hourly full scan, and even then only `gaps[0]` gets worked. With a stuck
//   recent hole, a deep hole is never reached at all.
//
// The fix is a rotation with a failure memory, kept here as pure arithmetic so
// the starvation property can be asserted directly rather than inferred from a
// running indexer. The caller does the SQL and the RPC.
//
// Design note on why this is not simply "always take the oldest": newly-created
// holes near the head are the ones a visitor is most likely to notice, and they
// are also the ones most likely to be fillable (the RPC definitely has them).
// Preferring them is right — the bug was preferring them UNCONDITIONALLY.

// How many consecutive failed attempts before a gap is set aside.
//
// Not "forever": a gap that stops being attempted can never be observed to be
// fillable again after, say, the RPC is repointed at an archive node. The
// caller is expected to clear attempt counts on a cooldown; see shouldRetire.
export const DEFAULT_MAX_GAP_ATTEMPTS = 5;

// Pick the gap to repair.
//
//   gaps      — [{ gapStart, gapEnd, gapSize }], newest first (as
//               db.getBlockGaps returns them)
//   attempts  — Map<gapKey, number> of consecutive failures per gap
//   tick      — a monotonically increasing counter; alternating on it is what
//               guarantees the oldest hole is reached even when the newest is
//               permanently stuck
//   maxAttempts
//
// Returns the chosen gap, or null when every gap is exhausted.
export function chooseGap(gaps, { attempts = new Map(), tick = 0, maxAttempts = DEFAULT_MAX_GAP_ATTEMPTS } = {}) {
    const list = Array.isArray(gaps) ? gaps.filter(g => g && g.gapStart != null && g.gapEnd != null) : [];
    if (list.length === 0) return null;

    // Drop the ones we have given up on for now.
    const live = list.filter(g => (attempts.get(gapKey(g)) || 0) < maxAttempts);

    // Everything is exhausted. Return null rather than the least-bad option:
    // the caller should report this as "cannot repair" (F-004's honest status)
    // instead of burning another RPC round on a range that has failed
    // maxAttempts times running.
    if (live.length === 0) return null;

    // Newest first from getBlockGaps, so index 0 is newest and the last is
    // oldest. Alternate. The odd/even split matters more than the exact ratio:
    // any fixed preference for one end starves the other.
    //
    // IMPORTANT LIMIT, and a review was right to name it: "oldest" here means
    // oldest in the list we were HANDED, not oldest in the database. The
    // caller's non-full scans pass `sinceBlock = head - CHAIN_GAP_SCAN_WINDOW`
    // and a row limit, so on most ticks `live` contains only recent holes and
    // both ends of the rotation are recent. This function cannot fix that —
    // the scan window is the caller's decision — but the rotation still does
    // the thing that matters within whatever it is given: it stops ONE
    // unfillable hole from consuming every tick. Reaching genuinely deep holes
    // depends on the caller's periodic full scan (CHAIN_FULL_GAP_SCAN_MS)
    // returning more than one gap, which is why CHAIN_GAP_COUNT_LIMIT exists.
    return (tick % 2 === 0) ? live[0] : live[live.length - 1];
}

// Stable identity for a gap across ticks.
//
// A gap SHRINKS as it is filled, so its key must not be its size — otherwise a
// partially-repaired gap looks like a brand new one and its attempt count
// resets, which is precisely how an unfillable range gets retried forever.
// gapStart is stable while the fill works downward from gapEnd.
export function gapKey(gap) {
    return `${gap.gapStart}`;
}

// Fold this tick's outcome into the attempt map.
//
//   filled — how many heights the fill actually wrote
//
// Any progress at all resets the counter: a gap that is shrinking is not stuck,
// however slowly it moves. Zero progress increments.
export function recordAttempt(attempts, gap, filled) {
    if (!gap) return attempts;
    const key = gapKey(gap);
    if (filled > 0) attempts.delete(key);
    else attempts.set(key, (attempts.get(key) || 0) + 1);
    return attempts;
}

// Should the whole attempt map be cleared?
//
// Exhausted gaps must become eligible again eventually — an operator repointing
// RPC at an archive node is exactly the case where yesterday's unfillable hole
// becomes today's fillable one, and nothing in-process can observe that. A
// periodic amnesty is the cheapest correct answer.
export function shouldRetire(lastResetAt, now, cooldownMs) {
    return (now - (lastResetAt || 0)) >= cooldownMs;
}

// Are there holes we have stopped attempting?
//
// The caller surfaces this in the index status so "Repairing" does not imply
// "making progress" when it is not.
export function exhaustedGapCount(gaps, attempts, maxAttempts = DEFAULT_MAX_GAP_ATTEMPTS) {
    if (!Array.isArray(gaps)) return 0;
    return gaps.filter(g => g && g.gapStart != null
        && (attempts.get(gapKey(g)) || 0) >= maxAttempts).length;
}
