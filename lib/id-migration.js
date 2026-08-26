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
export function migrateHashKeyedIds(dbh) {
    const out = {
        txRewritten: 0, txDuplicatesDeleted: 0,
        rewardRewritten: 0, rewardDuplicatesDeleted: 0,
        forkEventsDeleted: 0, forkTxDeleted: 0, forkRewardsDeleted: 0
    };

    dbh.exec('BEGIN');
    try {
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
        out.forkEventsDeleted = dbh.prepare(`DELETE FROM events ${forkWhere('events')}`).run().changes;
        out.forkTxDeleted = dbh.prepare(`DELETE FROM transactions ${forkWhere('transactions')}`).run().changes;
        out.forkRewardsDeleted = dbh.prepare(`DELETE FROM staking_rewards ${forkWhere('staking_rewards')}`).run().changes;

        dbh.exec('COMMIT');
    } catch (err) {
        dbh.exec('ROLLBACK');
        throw err;
    }
    return out;
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
    dbh.exec('BEGIN');
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
