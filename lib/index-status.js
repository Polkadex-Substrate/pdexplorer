// Derivation of an indexer's reported status from what it actually knows.
//
// Audit F-004 / F-050. The chain indexer used to write `status: 'Synced'`
// unconditionally at the end of every tick — on the same tick that logged
// `known gaps=1`. So the API cheerfully reported a healthy index over a
// 1,213-block hole, and the only way to discover it was to run a window scan
// by hand. "Synced" has to mean "I hold every block I claim to hold";
// anything else is a different word.
//
// Pure function, in lib/ so it is unit-testable without a database. The
// caller supplies the counts it already has in hand.

// Reported statuses:
//   Initializing — nothing indexed yet
//   Backfilling  — still walking toward genesis
//   Repairing    — coverage claimed but known holes / retryable failures exist
//   Degraded     — holes we have STOPPED retrying (needs an operator)
//   Synced       — no known holes
export function deriveIndexStatus({
    initialized = false,
    backfillComplete = false,
    knownGapBlocks = 0,
    retryableFailures = 0,
    permanentFailures = 0,
    hadErrorThisTick = false
} = {}) {
    if (hadErrorThisTick) return 'Error';
    if (!initialized) return 'Initializing';
    // Permanent failures outrank repair-in-progress: retries have been
    // exhausted, so time alone will not fix it and somebody has to look.
    if (permanentFailures > 0) return 'Degraded';
    if (knownGapBlocks > 0 || retryableFailures > 0) return 'Repairing';
    if (!backfillComplete) return 'Backfilling';
    return 'Synced';
}

// One-line human explanation to sit beside the status in API payloads and
// operator logs. Deliberately concrete about counts — "Repairing" without a
// number is the same false comfort as "Synced" was.
export function describeIndexStatus({
    knownGapBlocks = 0,
    retryableFailures = 0,
    permanentFailures = 0
} = {}) {
    const parts = [];
    if (knownGapBlocks > 0)    parts.push(`${knownGapBlocks} block${knownGapBlocks === 1 ? '' : 's'} missing inside the indexed range`);
    if (retryableFailures > 0) parts.push(`${retryableFailures} block${retryableFailures === 1 ? '' : 's'} queued for retry`);
    if (permanentFailures > 0) parts.push(`${permanentFailures} block${permanentFailures === 1 ? '' : 's'} abandoned after repeated failures`);
    return parts.join('; ');
}

// Should the UI show a "still crawling" spinner instead of data?
//
// Audit F-020's second half: the SPA used to spin purely on a status string,
// which meant a stale or mis-keyed status hid rows that were present. Rows
// win: if there is data to show, show it, whatever the indexer is doing.
export function shouldShowCrawlSpinner(status, rowCount) {
    if (Number(rowCount) > 0) return false;
    // Repairing and Degraded deliberately do NOT spin. Both mean "this is as
    // good as it gets right now", and a spinner over them promises progress
    // that either is not visible yet (Repairing works one gap per tick) or is
    // not coming at all (Degraded has stopped retrying). Worse, the spinner
    // REPLACES the status badge that would have told the user there is a hole
    // — so the honest status the F-004/F-050 work exists to surface would be
    // hidden by the very state it describes. An empty list plus a "Repairing"
    // badge is the informative rendering; an empty list plus a spinner is not.
    return status === 'Initializing' || status === 'Syncing' || status === 'Backfilling';
}
