// Claimed-vs-unclaimed reconciliation for staking rewards.
//
// Audit F-002. `/api/staking-rewards/:address` returns two lists from two
// different sources of truth:
//
//   claimed   — rows the indexer scraped from `staking.Rewarded` events
//   unclaimed — `derive.staking.stakerRewards()` output, CACHED with a TTL
//
// Neither list is wrong on its own, but the overlap was never reconciled at
// read time. Two independent defects produced double counting:
//
//  1. STALE CACHE. The only dedup lived inside recomputeUnclaimed(), which by
//     definition does not run while the cache is fresh. Claim a payout and the
//     era appears under `claimed` immediately (the indexer sees the event
//     within a tick) while the cached `unclaimed` set still lists it for up to
//     UNCLAIMED_TTL. `summary.totalAmount` added both.
//
//  2. UNATTRIBUTED CLAIMS. A `utility.batch` paying several validators used to
//     store validator = null, so the claimed key `"1234|"` could never match
//     the unclaimed key `"1234|<validator>"`. See lib/reward-attribution.js
//     for the indexer-side fix; rows written before it exists still carry null,
//     hence `unattributedEras` below.
//
// Reconciliation direction: the chain wins on "is this still owed" for an
// attributed pair, and the claimed row wins on any exact match. This module is
// pure so the arithmetic is unit-testable without a database or an RPC node.

export function claimedRewardKey(era, validator) {
    return `${Number(era)}|${validator ? String(validator) : ''}`;
}

// Index the claimed rows once, so filtering N unclaimed rows stays O(N).
export function buildClaimedIndex(claimedRows) {
    const exact = new Set();
    const unattributedEras = new Set();
    for (const row of (claimedRows || [])) {
        if (!row || row.era == null) continue;
        const era = Number(row.era);
        if (!Number.isFinite(era)) continue;
        if (row.validator) exact.add(claimedRewardKey(era, row.validator));
        // A claimed payout whose validator we could not determine. We cannot
        // match it against a specific unclaimed pair, so it suppresses the
        // whole era rather than double-counting it. This loses a genuinely
        // unpaid sibling validator in the same era — strictly better than
        // reporting money as both received and owed, and only reachable for
        // rows indexed before the attribution fix landed.
        else unattributedEras.add(era);
    }
    return { exact, unattributedEras };
}

// Drop unclaimed entries that the claimed rows already account for.
export function filterUnclaimed(unclaimedRows, index) {
    const idx = index || { exact: new Set(), unattributedEras: new Set() };
    const kept = [];
    const suppressed = [];
    for (const row of (unclaimedRows || [])) {
        if (!row) continue;
        const era = row.era == null ? null : Number(row.era);
        if (era != null && Number.isFinite(era) &&
            (idx.unattributedEras.has(era) || idx.exact.has(claimedRewardKey(era, row.validator)))) {
            suppressed.push(row);
            continue;
        }
        kept.push(row);
    }
    return { kept, suppressed };
}

const sumAmounts = rows => (rows || []).reduce((total, r) => total + (Number(r && r.amount) || 0), 0);

// The summary block the API returns. Computed from the RECONCILED unclaimed
// list, which is the whole point of the finding: totalAmount must never be
// claimed + unclaimed over an overlapping era.
export function summarizeRewards(claimedRows, unclaimedRows) {
    const claimed = claimedRows || [];
    const index = buildClaimedIndex(claimed);
    const { kept, suppressed } = filterUnclaimed(unclaimedRows, index);

    const claimedTotal = sumAmounts(claimed);
    const unclaimedTotal = sumAmounts(kept);

    const eras = new Set();
    for (const row of [...claimed, ...kept]) {
        if (row && row.era != null) eras.add(Number(row.era));
    }

    return {
        unclaimed: kept,
        suppressed,
        summary: {
            claimedTotal,
            claimedCount: claimed.length,
            unclaimedTotal,
            unclaimedCount: kept.length,
            totalAmount: claimedTotal + unclaimedTotal,
            eraCount: eras.size,
            // Non-zero means the cached unclaimed set was behind the index —
            // visible in the payload rather than silently corrected.
            reconciledCount: suppressed.length
        }
    };
}
