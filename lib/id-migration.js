// F-021: move transaction and reward primary keys from block-NUMBER-keyed to
// block-HASH-keyed, and delete rows that belong to a discarded fork.
//
// Why the ids had to change: `event-${blockNumber}-${eventIndex}` names a
// SLOT, not an event. After a reorg the canonical chain has a different block
// in the same slot, its Transfer event lands on the same (number, eventIndex)
// coordinates, and INSERT OR IGNORE quietly drops it because the orphan
// already holds the key. The events table never had this problem — its PK is
// `${blockHash}-${eventIndex}` — which is why the audit calls the number-keyed
// tables "the same reorg identity surface" as F-007.
//
// Why a migration and not just new writers: the audit is explicit that
// "writer-only is not a migration." Change only the writer and every existing
// row keeps its number-keyed PK, so the first reorg repair would insert a
// hash-keyed canonical row NEXT TO the number-keyed orphan — a duplicate pair
// where before there was silent loss. Strictly worse.
//
// These functions take the db handle as an argument so the unit tests run the
// byte-identical SQL against an in-memory database. db.js wraps them with its
// module-level handle.

// One-time (but idempotent) PK rewrite. Strategy per table:
//
//   1. UPDATE OR IGNORE rewrites every legacy-keyed row that has a usable
//      hash. OR IGNORE means a row whose NEW id already exists is skipped —
//      and that collision has exactly one meaning: a hash-keyed twin of this
//      row was already written, so the legacy row is a duplicate.
//   2. DELETE what still matches the legacy pattern (and has a usable hash):
//      after step 1 those are precisely the collided duplicates.
//
// Rows with no stored hash keep their legacy ids — inventing a hash is worse
// than an old-style key, and the reorg repair path (deleteForkRows) treats a
// missing hash at a reorged height as "delete and rescan" anyway.
//
// Every WHERE has `event_index IS NOT NULL`: SQL string concatenation with
// NULL yields NULL, and SQLite's TEXT PRIMARY KEY — by long-standing quirk —
// ACCEPTS a NULL, so without the guard step 1 would mint rows whose primary
// key is NULL.
// BEGIN IMMEDIATE, not BEGIN (audit F-137): a deferred transaction takes the
// write lock on its FIRST write, so a reader that arrives between BEGIN and
// that write can force SQLITE_BUSY on the writer mid-migration. IMMEDIATE
// acquires it up front — the writer either starts or waits, never fails
// halfway through a multi-statement rewrite.
// Audit F-182 (round 2). The first version did all of this in ONE
// BEGIN IMMEDIATE, and the events pass alone is "roughly a minute on 12.8M
// rows" by its own comment. That is a minute of held write lock inside
// initDb — every HTTP worker's 5s busy_timeout expires against it, F-022's
// catch exits them, and F-181 turns that into a refork loop. F-088 had already
// taught this exact lesson about long writes at boot; this rewrite did not
// inherit it.
//
// Two changes, and the SQL itself is untouched:
//
//   1. Each step is its own short transaction, so the lock is released
//      between them and a reader only ever waits for one step.
//   2. The events fork-delete — by far the biggest — is CHUNKED over block
//      ranges with a commit per chunk, and records progress so an interrupted
//      run resumes instead of restarting.
//
// The result is still a single logical migration, still idempotent, still
// behind the kv flag — but there is no longer any moment where a five-second
// wait is not enough.
//
//   chunkBlocks — how many block heights per events-delete transaction
//   progress    — { get(key), set(key, value) } so a resumable run can persist
//                 its cursor; omit for the in-memory tests
//   onProgress  — (info) => void, for operator-script logging
// Delete pre-v3 transaction rows so they cannot double-count against their
// event-derived twins.
//
// Audit F-049 (round 2). Two generations of writer produced rows in this table:
//
//   before v3  keyed by EXTRINSIC hash, one row per transfer extrinsic
//   v3 onward  keyed by `event-<blockHash>-<eventIndex>`, built from the
//              balances.Transfer event (server.js buildFinancialTransaction-
//              FromEvent, lib/tx-from-event.js)
//
// The same on-chain transfer therefore has two possible primary keys, and
// nothing removed the old one. The v3 scanner-version bump re-crawls history
// and inserts the event-keyed twin beside the surviving extrinsic-keyed row, so
// an address's transfer list shows the payment twice and any total computed
// from those rows is double. `migrateHashKeyedIds` does not help: every clause
// in it is gated on `event_derived = 1`, which these rows are not, and the
// fork-delete only removes rows whose `block_hash` disagrees with `blocks.hash`
// — a legacy row on the canonical chain passes that check.
//
// Deliberately a SEPARATE function with its own kv flag rather than a third
// step inside migrateHashKeyedIds. That one is guarded by a one-shot
// `migration:hash-keyed-ids` key, so on every database that has already run it
// — which is all of them, including production — an added step would never
// execute. A migration that silently does nothing is worse than one that was
// never written, because the flag says it ran.
//
// SAFETY RAIL. This is a destructive delete against live data, and its
// correctness rests on one fact: the only two row builders in the codebase both
// set `eventDerived: true`, and insertTransactions coerces that to 1. So a row
// with anything else is legacy by construction. If that ever stopped being
// true — a new writer that forgets the flag, or a schema where the column was
// added but never backfilled — this would delete the entire table.
//
// `maxFraction` is the guard, and picking it is a real trade rather than a
// number to make large "just in case":
//
//   too LOOSE  and a mis-set flag wipes 12.8M rows unattended. Unrecoverable.
//   too TIGHT  and it refuses on a legitimate database — one that indexed a
//              long pre-v3 history — so the double-count the finding is about
//              never gets fixed, and the refusal LOOKS like the safe outcome
//              while the wrong numbers stay on the page.
//
// The default is deliberately conservative because the first failure is
// permanent and the second is not: a refusal prints why, leaves the kv flag
// unset so the next boot retries, and can be overridden once an operator has
// looked at the real ratio. That override is TX_PURGE_MAX_FRACTION, and the
// refusal message names it — a safety rail with no documented way past it just
// gets removed by whoever hits it at 2am.
export function purgeLegacyExtrinsicKeyedTx(dbh, { maxFraction = 0.25 } = {}) {
    const out = { candidates: 0, total: 0, deleted: 0, refused: null };

    const totals = dbh.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN event_derived IS NULL OR event_derived != 1 THEN 1 ELSE 0 END) AS legacy
        FROM transactions
    `).get() || {};
    out.total = Number(totals.total) || 0;
    out.candidates = Number(totals.legacy) || 0;

    if (out.candidates === 0) return out;

    // A table that is almost entirely "legacy" means the flag is not being
    // written, not that every row is stale.
    if (out.total > 0 && out.candidates / out.total > maxFraction) {
        const pct = (out.candidates / out.total) * 100;
        out.refused = `${out.candidates}/${out.total} rows (${pct.toFixed(1)}%) look legacy, above the ${Math.round(maxFraction * 100)}% ceiling — refusing to delete. Either some writer is not setting event_derived, or this database genuinely has a large pre-v3 history. Inspect a sample, then set TX_PURGE_MAX_FRACTION above ${(Math.ceil(pct) / 100).toFixed(2)} to proceed.`;
        return out;
    }

    inTx(dbh, () => {
        const r = dbh.prepare(`
            DELETE FROM transactions
             WHERE event_derived IS NULL OR event_derived != 1
        `).run();
        out.deleted = r.changes;
    });
    return out;
}

export function migrateHashKeyedIds(dbh, {
    chunkBlocks = 250_000, progress = null, onProgress = null, onForkDelete = null
} = {}) {
    const out = {
        txRewritten: 0, txDuplicatesDeleted: 0,
        rewardRewritten: 0, rewardDuplicatesDeleted: 0,
        forkEventsDeleted: 0, forkTxDeleted: 0, forkRewardsDeleted: 0,
        chunks: 0
    };

    // Step 1+2: the tx and rewards rewrites. These touch only rows matching a
    // legacy id pattern, so they are bounded by how many legacy rows exist —
    // large once, then zero forever. One transaction each.
    inTx(dbh, () => {
        let r = dbh.prepare(`
            UPDATE OR IGNORE transactions
               SET hash = 'event-' || block_hash || '-' || event_index
             WHERE event_derived = 1
               AND block_hash LIKE '0x%'
               AND event_index IS NOT NULL
               AND hash LIKE 'event-%'
               AND hash NOT LIKE 'event-0x%'
        `).run();
        out.txRewritten = r.changes;

        r = dbh.prepare(`
            DELETE FROM transactions
             WHERE event_derived = 1
               AND block_hash LIKE '0x%'
               AND event_index IS NOT NULL
               AND hash LIKE 'event-%'
               AND hash NOT LIKE 'event-0x%'
        `).run();
        out.txDuplicatesDeleted = r.changes;

        r = dbh.prepare(`
            UPDATE OR IGNORE staking_rewards
               SET id = block_hash || '-' || event_index
             WHERE block_hash LIKE '0x%'
               AND event_index IS NOT NULL
               AND id NOT LIKE '0x%'
        `).run();
        out.rewardRewritten = r.changes;

        r = dbh.prepare(`
            DELETE FROM staking_rewards
             WHERE block_hash LIKE '0x%'
               AND event_index IS NOT NULL
               AND id NOT LIKE '0x%'
        `).run();
        out.rewardDuplicatesDeleted = r.changes;
    });

    // Step 3 — HISTORICAL FORK CONSISTENCY. A batch review caught the id
        // rewrite alone quietly making things worse: heights below the reorg
        // sweep's first-run watermark can hold rows from a fork discarded
        // years ago (F-007's own premise), and after the rewrite those rows
        // carry perfectly valid hash-keyed ids — so when the F-008 backfill
        // and the v3 re-crawl insert the CANONICAL twin under its different
        // hash-keyed id, the tables go from one-wrong-row to
        // wrong-row-plus-right-row: permanent double-counted volume and
        // account history, with no pass anywhere that would ever clean it.
        //
        // So: one story per height. Any row whose block_hash disagrees with
        // blocks.hash at its own height is deleted. blocks.hash is the best
        // local truth available — where it is itself an old orphan we keep a
        // single consistent-but-stale story (exactly the pre-batch state,
        // minus the duplication), and the sweep keeps everything above its
        // watermark canonical from now on.
        //
        // The events pass touches the 12.8M-row table via an indexed
        // correlated lookup — a one-time cost of roughly a minute, paid once,
        // behind the kv flag, on the indexer worker only.
    const forkWhere = (table) => `
             WHERE ${table}.block_hash LIKE '0x%'
               AND EXISTS (
                   SELECT 1 FROM blocks b
                    WHERE b.number = ${table}.block
                      AND b.hash LIKE '0x%'
                      AND b.hash != ${table}.block_hash
               )`;

    // Bounds for the chunk walk, across ALL THREE tables.
    //
    // My first version took MIN/MAX from `events` alone, on the reasoning that
    // it is the big table. The id-migration tests caught it immediately: a
    // transaction or reward can sit at a height with no events row (an
    // incomplete scan, or the F-006 case where events were undecodable and not
    // stored), and such a row fell outside every chunk — so its fork-delete
    // silently never ran. The chunking would have quietly narrowed what the
    // migration covered, which is the worst kind of regression: a correctness
    // change disguised as a performance change.
    const bounds = dbh.prepare(`
        SELECT MIN(lo) AS lo, MAX(hi) AS hi FROM (
            SELECT MIN(block) AS lo, MAX(block) AS hi FROM events
            UNION ALL SELECT MIN(block), MAX(block) FROM transactions
            UNION ALL SELECT MIN(block), MAX(block) FROM staking_rewards
        )
    `).get() || {};
    const lo = Number(bounds.lo);
    const hi = Number(bounds.hi);

    if (Number.isFinite(lo) && Number.isFinite(hi)) {
        // Resume point, so an interrupted migration does not redo the range it
        // already cleared. Chunks are processed low → high.
        let cursor = lo;
        if (progress) {
            const saved = Number(progress.get('forkDeleteCursor'));
            if (Number.isFinite(saved) && saved > cursor) cursor = saved;
        }

        while (cursor <= hi) {
            const end = Math.min(cursor + chunkBlocks - 1, hi);
            const from = cursor, to = end;
            // Audit F-187 (round 2): the heights we are about to empty,
            // captured BEFORE the delete — afterwards nothing identifies them.
            //
            // The fork step deletes rows and nothing puts the CANONICAL data
            // back. The reorg sweep adopts the finalized head on first run and
            // never walks below it, so a height cleaned here ends up emptier
            // than it started: the fork row is gone (right) and its canonical
            // twin was never fetched (a new hole, indistinguishable from a
            // block that genuinely had no events).
            //
            // Handing the heights to the caller is what turns a delete into a
            // repair. Bounded, so a pathological range cannot build a
            // million-element array in memory.
            let touched = [];
            if (onForkDelete) {
                try {
                    touched = dbh.prepare(`
                        SELECT DISTINCT block FROM (
                            SELECT block FROM events ${forkWhere('events')} AND events.block BETWEEN ${from} AND ${to}
                            UNION SELECT block FROM transactions ${forkWhere('transactions')} AND transactions.block BETWEEN ${from} AND ${to}
                            UNION SELECT block FROM staking_rewards ${forkWhere('staking_rewards')} AND staking_rewards.block BETWEEN ${from} AND ${to}
                        ) LIMIT 5000
                    `).all().map(r => Number(r.block));
                } catch (_) { touched = []; }
            }
            // One short transaction per chunk. A reader waits for a slice of
            // the work, never the whole table.
            inTx(dbh, () => {
                out.forkEventsDeleted += dbh.prepare(
                    `DELETE FROM events ${forkWhere('events')} AND events.block BETWEEN ${from} AND ${to}`).run().changes;
                out.forkTxDeleted += dbh.prepare(
                    `DELETE FROM transactions ${forkWhere('transactions')} AND transactions.block BETWEEN ${from} AND ${to}`).run().changes;
                out.forkRewardsDeleted += dbh.prepare(
                    `DELETE FROM staking_rewards ${forkWhere('staking_rewards')} AND staking_rewards.block BETWEEN ${from} AND ${to}`).run().changes;
            });
            out.chunks++;
            // AFTER the commit: enqueueing a rescan for a delete that rolled
            // back would send the crawler at healthy heights for nothing.
            if (onForkDelete && touched.length) {
                try { onForkDelete(touched); } catch (_) { /* housekeeping must not fail the migration */ }
            }
            cursor = end + 1;
            // Persist AFTER the commit: a crash between them costs one repeat
            // chunk, which is idempotent. Persisting first could skip a chunk.
            if (progress) progress.set('forkDeleteCursor', cursor);
            if (onProgress) onProgress({ from, to, hi, ...out });
        }
    }

    return out;
}

// Run `fn` inside a short BEGIN IMMEDIATE transaction.
//
// IMMEDIATE, not deferred (audit F-137): a deferred transaction takes the write
// lock on its first write, so a reader arriving between BEGIN and that write
// can force SQLITE_BUSY on the writer mid-statement. IMMEDIATE acquires it up
// front — the writer either starts or waits, never fails halfway.
function inTx(dbh, fn) {
    dbh.exec('BEGIN IMMEDIATE');
    try {
        fn();
        dbh.exec('COMMIT');
    } catch (err) {
        try { dbh.exec('ROLLBACK'); } catch (_) { /* already unwound */ }
        throw err;
    }
}

// F-007 repair: at a height whose canonical hash we now know, delete every
// row that carries a DIFFERENT hash — the discarded fork — so the rescan can
// insert the canonical set cleanly.
//
// Rows with a NULL/empty stored hash at the disputed height are deleted too:
// they are unattributable to either fork, and the rescan reinstates whatever
// the canonical block actually contains. Rows already carrying the canonical
// hash are left alone (the rescan's INSERT OR IGNORE will skip them).
//
// The events/transactions DELETE triggers keep the table_counts counters
// consistent; the audit specifically notes counts never decreased before.
export function deleteForkRows(dbh, blockNumber, canonicalHash) {
    const n = Number(blockNumber);
    const h = String(canonicalHash || '');
    if (!Number.isFinite(n) || !h.startsWith('0x')) {
        // Refuse rather than guess: a repair keyed on a bad hash would delete
        // canonical data.
        return { events: 0, transactions: 0, rewards: 0, skipped: true };
    }

    const out = { events: 0, transactions: 0, rewards: 0, skipped: false };
    dbh.exec('BEGIN IMMEDIATE');
    try {
        out.events = dbh.prepare(
            `DELETE FROM events WHERE block = ? AND (block_hash IS NULL OR block_hash = '' OR block_hash != ?)`
        ).run(n, h).changes;
        out.transactions = dbh.prepare(
            `DELETE FROM transactions WHERE block = ? AND (block_hash IS NULL OR block_hash = '' OR block_hash != ?)`
        ).run(n, h).changes;
        out.rewards = dbh.prepare(
            `DELETE FROM staking_rewards WHERE block = ? AND (block_hash IS NULL OR block_hash = '' OR block_hash != ?)`
        ).run(n, h).changes;
        dbh.exec('COMMIT');
    } catch (err) {
        dbh.exec('ROLLBACK');
        throw err;
    }
    return out;
}
