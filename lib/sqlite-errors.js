// Is this SQLite failure worth dying over?
//
// Audit F-181 (round 2), which is an OVER-CORRECTION of F-022.
//
// F-022 was right: `initDb` used to log a failure and let the process continue
// to `app.listen`, so a worker with no database served 500s while looking
// healthy. The fix — die loudly, let the supervisor restart us — is correct for
// the failure it was written for (a bad DATA_DIR, a corrupt file, no disk).
//
// It is exactly wrong for the OTHER kind of failure. `process.exit(1)` on a
// transient `SQLITE_BUSY` turns a five-second lock into a crash loop:
//
//   1. the indexer takes the write lock for the hash-id migration;
//   2. another worker's `busy_timeout` (5s) expires → SQLITE_BUSY;
//   3. F-022's catch calls exit(1);
//   4. the primary reforks it (F-145 backs off to 30s);
//   5. the replacement runs the same DDL and hits the same lock.
//
// Indexing stops until a quiet window happens to appear, while `/api/blocks`
// keeps serving yesterday's rows and every health signal says fine. "Dying
// loudly beats limping" is a good rule; it needs the corollary that a lock is
// not a death.
//
// So: retry the contended failures, keep exiting on the structural ones. The
// distinction is what this module encodes, and it is deliberately CONSERVATIVE
// — anything not recognised as transient is treated as fatal, because the cost
// of retrying a corrupt database forever is worse than the cost of one restart.

// Contention and interruption. These mean "someone else is using it" or "try
// again", never "the data is wrong".
const TRANSIENT = [
    'SQLITE_BUSY',            // another connection holds the write lock
    'SQLITE_LOCKED',          // a table in this connection is locked
    'SQLITE_PROTOCOL',        // WAL contention during recovery
    'SQLITE_INTERRUPT',       // a query was cancelled
    'database is locked',     // the message form node:sqlite surfaces
    'database table is locked',
    'cannot start a transaction within a transaction'  // lost a BEGIN race
];

// Structural. Retrying these is a busy-loop against a problem that will not
// resolve on its own, and hides it from the operator.
const FATAL = [
    'SQLITE_CORRUPT',
    'SQLITE_NOTADB',          // the file is not a database
    'SQLITE_CANTOPEN',        // path/permissions
    'SQLITE_READONLY',        // filesystem or file mode
    'SQLITE_FULL',            // disk full
    'SQLITE_IOERR',
    'SQLITE_PERM',
    'EACCES',
    'ENOENT',
    'ENOSPC'
];

function haystack(err) {
    if (!err) return '';
    // node:sqlite puts the SQLITE_* token in `code` on some paths and only in
    // the message on others, so check both rather than trusting one.
    return `${err.code || ''} ${err.errcode || ''} ${err.message || String(err)}`;
}

export function isFatalSqliteError(err) {
    const h = haystack(err);
    return FATAL.some(t => h.includes(t));
}

// True only for failures that a later attempt could plausibly survive.
//
// Order matters: a message can mention both (an IO error reported while a lock
// was held), and in that case the structural signal wins. Ambiguity resolves
// toward "stop", not "retry forever".
export function isTransientSqliteError(err) {
    if (!err) return false;
    if (isFatalSqliteError(err)) return false;
    const h = haystack(err);
    return TRANSIENT.some(t => h.includes(t));
}

// Run `fn`, retrying while the failure looks transient.
//
//   attempts   — total tries, including the first
//   baseDelayMs— doubles each attempt, capped at maxDelayMs
//   onRetry    — (err, attempt, delayMs) => void, for logging
//
// Synchronous on purpose: node:sqlite is synchronous, and this wraps boot-time
// work that must complete before `app.listen`. A promise here would let the
// process advance past a database that is not ready, which is the F-022 bug.
// The sleep is a deliberate blocking wait — at boot, with nothing else to
// serve, that is the correct trade.
export function retryTransient(fn, {
    attempts = 6, baseDelayMs = 500, maxDelayMs = 8000, onRetry = null,
    sleep = defaultSleep
} = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            return fn();
        } catch (err) {
            lastErr = err;
            if (!isTransientSqliteError(err) || i === attempts) throw err;
            const delay = Math.min(baseDelayMs * Math.pow(2, i - 1), maxDelayMs);
            if (onRetry) onRetry(err, i, delay);
            sleep(delay);
        }
    }
    throw lastErr;
}

// Blocking sleep. Atomics.wait on a throwaway buffer is the only way to block
// the main thread without spinning a core, which a `while (Date.now() < end)`
// loop would do for up to 8 seconds.
function defaultSleep(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* SharedArrayBuffer unavailable */ }
    }
}
