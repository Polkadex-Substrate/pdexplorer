// Queue block heights for an indexer's gap-fill pass WITHOUT counting an
// attempt against them.
//
// One SQL statement, shared by db.js (the running indexer) and
// tools/requeue-scan-range.mjs (the operator repair path), so the two cannot
// drift apart (the F-045 lesson).
//
// "Absent" matters: a height that already has a row keeps its attempt count
// and its real last_error. Queueing is bookkeeping ("scan this again"), not a
// claim that something was tried and failed.

export const QUEUE_IF_ABSENT_SQL = `
    INSERT INTO scan_failures (indexer, block, attempts, last_error, first_at, last_at)
    VALUES (?, ?, 0, ?, ?, ?)
    ON CONFLICT(indexer, block) DO NOTHING`;

// Give an EXISTING row its retry lives back (attempts = 0) — for a height we
// have independent evidence about, e.g. the motion locator proved from chain
// state that a motion was resolved in that block. Without this, a block that
// once burned all SCAN_MAX_ATTEMPTS (an outage, a bad batch) is "permanent"
// and every later queue attempt is a silent no-op: motion #134's close block
// sat exactly there after the Oct 2026 outage.
export const REARM_SQL = `
    UPDATE scan_failures SET attempts = 0, last_error = ?, last_at = ?
    WHERE indexer = ? AND block = ? AND attempts > 0`;

export function rearmOne(dbh, indexer, block, reason, now = Date.now()) {
    const info = dbh.prepare(REARM_SQL).run(String(reason || '').slice(0, 500), now, indexer, block);
    return Number(info && info.changes) > 0;
}

// Queue if absent, re-arm if present. Returns 'queued' | 'rearmed' | 'pending'.
export function queueOrRearm(dbh, indexer, block, reason, now = Date.now()) {
    if (queueOneIfAbsent(dbh, indexer, block, reason, now)) return 'queued';
    if (rearmOne(dbh, indexer, block, reason, now)) return 'rearmed';
    return 'pending';   // already queued at attempts 0
}

// Indexers whose gap-fill pass drains scan_failures. chain_index is included
// for completeness; it also has a LEAD gap scan that rediscovers holes itself.
export const QUEUEABLE_INDEXERS = Object.freeze(['governance', 'staking_rewards', 'transactions', 'chain_index']);

export function queueOneIfAbsent(dbh, indexer, block, reason, now = Date.now()) {
    const msg = String(reason || '').slice(0, 500);
    const info = dbh.prepare(QUEUE_IF_ABSENT_SQL).run(indexer, block, msg, now, now);
    return Number(info && info.changes) > 0;
}

// Queue every height in [from, to] (either order) in ONE transaction.
// Returns { added, alreadyQueued }.
export function queueRangeIfAbsent(dbh, indexer, from, to, reason, now = Date.now()) {
    if (!QUEUEABLE_INDEXERS.includes(indexer)) {
        throw new Error(`unknown indexer "${indexer}" (expected one of: ${QUEUEABLE_INDEXERS.join(', ')})`);
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 1) {
        throw new Error(`invalid range ${from}..${to}`);
    }
    const msg = String(reason || '').slice(0, 500);
    const st = dbh.prepare(QUEUE_IF_ABSENT_SQL);
    let added = 0;
    dbh.exec('BEGIN IMMEDIATE');
    try {
        for (let n = lo; n <= hi; n++) added += Number(st.run(indexer, n, msg, now, now).changes) || 0;
        dbh.exec('COMMIT');
    } catch (e) {
        try { dbh.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
    }
    return { added, alreadyQueued: hi - lo + 1 - added };
}
