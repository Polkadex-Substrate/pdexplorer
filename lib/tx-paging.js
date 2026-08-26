// Where does the next page of "Load Older" start?
//
// Audit F-078/F-079. This arithmetic lived inline in scanFinancialTransactions
// and was wrong twice in a row, both times in ways a reviewer had to catch by
// reading rather than by running anything:
//
//   v1 — the cursor was the oldest height in the fetched BATCH, regardless of
//        where `limit` cut the results. If the limit filled mid-batch, every
//        remaining transfer in that batch's older blocks was skipped: the next
//        page started below them and those rows were permanently unreachable.
//
//   v2 — "re-serve the truncated height" via `truncatedAt + 1`. If the limit
//        filled inside the FIRST block scanned, the returned cursor equalled
//        the caller's own `beforeBlock`. The page repeated forever and its
//        leftovers were still unreachable — i.e. the exact case F-078's close
//        test names, reintroduced by its own fix.
//
// The lesson both times: a block can hold more transfers than one page, so a
// height-only cursor CANNOT express "resume in the middle of block N". The
// cursor needs a second coordinate. That is what this module models, in
// isolation, so the invariants can be asserted directly:
//
//   PROGRESS   — consecutive pages must strictly advance (no repeat, no stall)
//   COMPLETE   — every transfer is returned exactly once across all pages
//
// `plan` is pure bookkeeping over already-fetched rows; the caller does the IO.

// Decide what to emit from one descending batch, and where the next page
// resumes.
//
//   blocks   — [{ blockNumber, transactions: [...] }], any order
//   limit    — max rows for this page
//   skip     — { block, count } the caller already received from that height,
//              or null on the first page
//
// Returns { emitted, nextBeforeBlock, resumeInBlock, exhausted }.
//   resumeInBlock is non-null when a height was only partly returned; the
//   caller echoes it back and we continue at that offset.
export function planTxPage({ blocks, limit, skip = null } = {}) {
    const rows = Array.isArray(blocks) ? blocks.slice() : [];
    rows.sort((a, b) => b.blockNumber - a.blockNumber);   // newest first

    const cap = Math.max(0, Number(limit) || 0);
    const skipBlock = skip && Number.isFinite(Number(skip.block)) ? Number(skip.block) : -1;
    const skipCount = skip && Number.isFinite(Number(skip.count)) ? Number(skip.count) : 0;

    const emitted = [];
    let lastFullyDrained = null;   // height whose rows were ALL returned
    let resumeInBlock = null;

    for (const b of rows) {
        const txs = Array.isArray(b.transactions) ? b.transactions : [];
        const startAt = (b.blockNumber === skipBlock) ? skipCount : 0;

        let k = startAt;
        while (k < txs.length && emitted.length < cap) {
            emitted.push(txs[k]);
            k++;
        }

        if (k < txs.length) {
            // Leftovers remain HERE. Resume at this height, at this offset —
            // the only way to advance inside a block bigger than a page.
            resumeInBlock = { block: b.blockNumber, count: k };
            break;
        }

        lastFullyDrained = b.blockNumber;
        if (emitted.length >= cap) break;
    }

    // Where the next request should start scanning.
    //
    // When we stopped mid-block there is NO correct single-coordinate answer,
    // which is worth stating plainly because a mutation test caught this being
    // untestable-by-accident: a resume-AWARE caller uses resumeInBlock and
    // never reads this field, so its value is invisible to them. A
    // resume-UNAWARE caller — one following only `nextBeforeBlock`, which is
    // what /developers documents — gets either an infinite loop (re-scanning
    // the same height forever) or silent data loss (scanning past the
    // leftovers). We choose the recoverable failure, duplicates over loss, and
    // set `resumeRequired` so such a caller can DETECT the situation instead
    // of quietly getting one of the two wrong answers.
    const nextBeforeBlock = resumeInBlock
        ? resumeInBlock.block + 1
        : (lastFullyDrained !== null ? lastFullyDrained : null);

    return {
        emitted,
        nextBeforeBlock,
        resumeInBlock,
        // True when nextBeforeBlock alone is NOT a sufficient cursor: the
        // caller must echo resumeInBlock or it will re-read this height.
        resumeRequired: resumeInBlock !== null,
        // Nothing left in the rows we were given.
        exhausted: resumeInBlock === null && emitted.length < cap
    };
}
