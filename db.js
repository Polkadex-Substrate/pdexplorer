// SQLite data layer for the Polkadex explorer.
//
// Uses Node's built-in node:sqlite. Audit F-147: the import below is a TOP-LEVEL
// import, so on the pinned base image (node:22.11-alpine) the process cannot
// start at all without --experimental-sqlite — it is not a feature flag that
// degrades something, it is the difference between a running backend and a
// container that crash-loops on ERR_UNKNOWN_BUILTIN_MODULE while nginx happily
// keeps serving the SPA. The flag therefore has to be on every entrypoint that
// loads this file: Dockerfile.backend's CMD, package.json's `start`/`server`,
// and the ad-hoc `docker compose exec backend node --experimental-sqlite ...`
// invocations in INSTALL.md and the tools/ scripts. Dropping it from any one of
// them breaks that path only, which is why it reads as "works locally".
// The decision to keep the 22.11 pin rather than chase an unflagged Node is
// written out in full in Dockerfile.backend.
// Replaces the previous whole-file JSON caches: every write is an indexed
// INSERT/UPSERT and every read is an indexed query, so caches can hold full
// historical data without the cost of rewriting/parsing a growing file.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { rpcUnavailableLikePatterns } from './lib/rpc-errors.js';
import { migrateHashKeyedIds, deleteForkRows as deleteForkRowsImpl } from './lib/id-migration.js';
import fs from 'fs';
import path from 'path';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
-- Audit F-075: cluster-wide rate-limit counters.
--
-- The in-process Maps that used to hold these multiplied every advertised
-- limit by WORKERS (up to 8), because each worker enforced the full budget
-- against its own share of the traffic. This table is the shared counter for
-- the endpoints where the limit is a SECURITY control rather than a fairness
-- knob — auth, email signup, label writes. Those are single-digit-per-second
-- endpoints, so a row write per request costs nothing that matters.
--
-- The hits column is a JSON array of timestamps: the same sliding window the
-- Maps held, just somewhere all workers can see it. Rows are pruned
-- Rows are reclaimed by the periodic pruneRateLimits() sweep on the indexer
-- worker; nothing prunes on read (an earlier comment here claimed otherwise
-- and was simply wrong — consumeRateLimit only ever rewrites the row it
-- touched, so without the sweep this table grows by one row per (bucket, IP)
-- forever).
--
-- NOTE: no backticks anywhere in this block. SCHEMA is a JS template literal,
-- and a backtick in a SQL comment terminates it — which turns the rest of the
-- schema into JavaScript and fails at parse time, not at runtime.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  hits       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, subject)
);
CREATE TABLE IF NOT EXISTS validators (
  address TEXT PRIMARY KEY,
  name TEXT,
  total_stake REAL,
  commission REAL,
  real_apy REAL,
  avg30day_apy REAL,
  position INTEGER
);
CREATE TABLE IF NOT EXISTS holders (
  address TEXT PRIMARY KEY,
  rank INTEGER,
  name TEXT,
  balance REAL,
  share REAL
);
CREATE TABLE IF NOT EXISTS transactions (
  hash TEXT PRIMARY KEY,
  from_addr TEXT,
  to_addr TEXT,
  block INTEGER,
  method TEXT,
  amount TEXT,
  numeric_amount REAL,
  value TEXT,
  status TEXT,
  timestamp INTEGER,
  event_index INTEGER,
  block_hash TEXT,
  event_derived INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(block DESC);
CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_addr);
CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_addr);
-- Audit F-088 note: idx_tx_timestamp is NOT created here, deliberately.
-- Putting it in SCHEMA looked like the obvious fix — and a review caught that
-- db.js's own comment below (see "do NOT build indexes here") forbids it: a
-- synchronous CREATE INDEX on the live multi-million-row transactions table
-- holds the write lock for minutes, jamming every worker's db.exec(SCHEMA) so
-- none reaches app.listen. That is a site-wide outage at boot, traded for a
-- slow query. It is created lazily instead — see ensureAnalyticsIndexes().
CREATE TABLE IF NOT EXISTS blocks (
  number INTEGER PRIMARY KEY,
  hash TEXT,
  author_address TEXT,
  author_name TEXT,
  extrinsics_count INTEGER,
  events_count INTEGER,
  timestamp INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  hash TEXT PRIMARY KEY,
  tx_hash TEXT,
  block_hash TEXT,
  block INTEGER,
  event_index INTEGER,
  extrinsic_index INTEGER,
  section TEXT,
  method TEXT,
  data TEXT,
  signer_address TEXT,
  signer_name TEXT,
  timestamp INTEGER,
  status TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_block ON events(block DESC);
CREATE INDEX IF NOT EXISTS idx_events_signer ON events(signer_address);
CREATE TABLE IF NOT EXISTS validator_history (
  era INTEGER,
  address TEXT,
  commission REAL,
  stake REAL,
  apy REAL,
  PRIMARY KEY (era, address)
);
CREATE INDEX IF NOT EXISTS idx_vh_address ON validator_history(address);
CREATE TABLE IF NOT EXISTS validator_triggers (
  address TEXT,
  era INTEGER,
  prev_commission REAL,
  new_commission REAL,
  timestamp INTEGER,
  PRIMARY KEY (address, era)
);
CREATE TABLE IF NOT EXISTS staking_rewards (
  id TEXT PRIMARY KEY,
  stash TEXT,
  amount REAL,
  era INTEGER,
  validator TEXT,
  block INTEGER,
  block_hash TEXT,
  event_index INTEGER,
  timestamp INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sr_stash ON staking_rewards(stash, block DESC);
CREATE TABLE IF NOT EXISTS staking_rewards_unclaimed (
  stash TEXT,
  era INTEGER,
  validator TEXT,
  amount REAL,
  PRIMARY KEY (stash, era, validator)
);
CREATE INDEX IF NOT EXISTS idx_sru_stash ON staking_rewards_unclaimed(stash);
CREATE TABLE IF NOT EXISTS price_history (
  timestamp INTEGER PRIMARY KEY,
  price REAL,
  market_cap REAL,
  volume_24h REAL,
  pct_change_24h REAL,
  source TEXT
);
-- NOTE: the idx_price_source_ts index on (source, timestamp DESC) is
-- created in the migration block in initDb(), NOT here. Existing
-- deployments predate the source column, so creating an index that
-- references it during the SCHEMA-exec step blows up before the
-- ensureColumn migration has a chance to add the column. The migration
-- block adds the column FIRST, then creates the index.
CREATE TABLE IF NOT EXISTS democracy_referenda (
  ref_index INTEGER PRIMARY KEY,
  status TEXT,
  end_block INTEGER,
  ayes REAL,
  nays REAL,
  turnout REAL,
  tally_known INTEGER DEFAULT 0,
  proposal TEXT,
  threshold TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS discussion_threads (
  id TEXT PRIMARY KEY,
  kind TEXT,
  ref_key TEXT,
  title TEXT,
  status TEXT DEFAULT 'open',
  created_at INTEGER,
  closed_at INTEGER,
  closed_reason TEXT
);
CREATE TABLE IF NOT EXISTS discussion_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT,
  author TEXT,
  author_name TEXT,
  content TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON discussion_posts(thread_id, created_at);
CREATE TABLE IF NOT EXISTS auth_challenges (
  address TEXT PRIMARY KEY,
  nonce TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  address TEXT,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS treasury_proposals (
  id INTEGER PRIMARY KEY,
  proposer TEXT,
  proposer_name TEXT,
  beneficiary TEXT,
  beneficiary_name TEXT,
  value REAL,
  bond REAL,
  status TEXT,
  proposed_block INTEGER,
  proposed_at INTEGER,
  resolved_block INTEGER,
  resolved_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_treasury_status ON treasury_proposals(status);
CREATE TABLE IF NOT EXISTS council_motions (
  hash TEXT PRIMARY KEY,
  motion_index INTEGER,
  proposer TEXT,
  proposer_name TEXT,
  section TEXT,
  method TEXT,
  threshold INTEGER,
  status TEXT,
  ayes INTEGER,
  nays INTEGER,
  proposed_block INTEGER,
  proposed_at INTEGER,
  resolved_block INTEGER,
  resolved_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_motions_index ON council_motions(motion_index DESC);

-- Address labels. v1 = self-labels: the row's address and signer columns
-- are the same (proof of ownership via signature). Schema leaves room for
-- v2 community labels (signer != address; needs separate moderation +
-- voting). Composite PK lets v2 have multiple labels per address while v1
-- enforces one self-label per address because (address,address) collapses.
CREATE TABLE IF NOT EXISTS address_labels (
  address     TEXT NOT NULL,
  signer      TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  vetoed_at   INTEGER DEFAULT NULL,
  PRIMARY KEY (address, signer)
);
CREATE INDEX IF NOT EXISTS idx_labels_address ON address_labels(address);

-- Per-label up/down vote. PK guarantees one vote per (label, voter).
-- vote is +1 or -1; clearing a vote = DELETE the row.
CREATE TABLE IF NOT EXISTS address_label_votes (
  label_address TEXT NOT NULL,
  label_signer  TEXT NOT NULL,
  voter         TEXT NOT NULL,
  vote          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (label_address, label_signer, voter)
);
CREATE INDEX IF NOT EXISTS idx_label_votes_label ON address_label_votes(label_address, label_signer);

-- Per-label abuse report. PK guarantees one report per (label, reporter).
-- Aggregated count drives an auto-hide threshold (see REPORT_HIDE_THRESHOLD
-- in server.js / getVisibleLabels in db.js).
CREATE TABLE IF NOT EXISTS address_label_reports (
  label_address TEXT NOT NULL,
  label_signer  TEXT NOT NULL,
  reporter      TEXT NOT NULL,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (label_address, label_signer, reporter)
);
CREATE INDEX IF NOT EXISTS idx_label_reports_label ON address_label_reports(label_address, label_signer);

-- Per-indexer, per-block retry queue. When a sparse indexer (staking
-- rewards, governance, transactions) fails to scan a single block, the
-- catch block records a row here instead of silently skipping. The
-- indexer's gap-fill phase pops the oldest rows on the next tick,
-- retries them, and clears them on success. The PK guarantees one row
-- per (indexer, block) so duplicate failures just bump the attempts
-- counter via upsert.
CREATE TABLE IF NOT EXISTS scan_failures (
  indexer     TEXT NOT NULL,
  block       INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1,
  last_error  TEXT,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (indexer, block)
);
-- Lookup index for the oldest-first retry order used by getScanFailures.
CREATE INDEX IF NOT EXISTS idx_scan_failures_replay
    ON scan_failures(indexer, attempts, last_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Email alerts: subscriber list + per-event dispatch idempotency.
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per (email, source). source distinguishes home-banner vs democracy
-- vs calendar vs settings signups so we can see where users are converting
-- from. confirmed_at is the double-opt-in gate — only confirmed rows
-- receive emails. unsubscribe_token is independent of confirmation_token so
-- a leaked confirmation link can't also unsubscribe future signups.
-- event_prefs is JSON (see PREF_SHAPE doc in server.js) describing which
-- categories + thresholds the user opted into. wallet_address is non-null
-- when the user authenticated via wallet-signature instead of email-only
-- (or both — wallet auth proves address ownership for account-specific
-- events; email-only signups are still allowed for broadcast events).
CREATE TABLE IF NOT EXISTS email_subscribers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  email                TEXT    NOT NULL,
  email_lc             TEXT    NOT NULL,
  confirmation_token   TEXT    NOT NULL UNIQUE,
  unsubscribe_token    TEXT    NOT NULL UNIQUE,
  confirmed_at         INTEGER DEFAULT NULL,
  unsubscribed_at      INTEGER DEFAULT NULL,
  event_prefs          TEXT    NOT NULL,        -- JSON
  source               TEXT,                    -- 'banner'|'democracy'|'calendar'|'settings'
  wallet_address       TEXT    DEFAULT NULL,    -- non-null = wallet-signed signup
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
-- One unique row per email-address; case-insensitive via lowercased copy.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_subscribers_email
    ON email_subscribers(email_lc);
-- Fast lookup for the dispatcher's "send to all confirmed subscribers with
-- governance.newReferendum enabled" path. The 0 = not unsubscribed condition
-- can't go in the index; the dispatcher applies it as a WHERE.
CREATE INDEX IF NOT EXISTS idx_email_subscribers_confirmed
    ON email_subscribers(confirmed_at, unsubscribed_at);

-- Idempotency log: every email send is recorded BEFORE the SMTP call so a
-- crash mid-dispatch (or a duplicate watcher firing) doesn't double-send.
-- PRIMARY KEY (event_kind, event_id, subscriber_id) is the join key the
-- dispatcher checks via LEFT JOIN or INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS email_dispatches (
  event_kind     TEXT    NOT NULL, -- 'gov.new-ref' | 'gov.new-prop' | 'gov.closing-24h' | ...
  event_id       TEXT    NOT NULL, -- referendum index, proposal index, etc. (string for flexibility)
  subscriber_id  INTEGER NOT NULL,
  dispatched_at  INTEGER NOT NULL,
  provider_id    TEXT,             -- provider's message ID, for bounce tracking
  result         TEXT,              -- 'sent' | 'failed' | 'skipped-prefs'
  PRIMARY KEY (event_kind, event_id, subscriber_id),
  FOREIGN KEY (subscriber_id) REFERENCES email_subscribers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_dispatches_subscriber
    ON email_dispatches(subscriber_id, dispatched_at DESC);

-- O(1) row counters for the high-volume, ever-growing tables. A plain
-- SELECT COUNT(*) on events/transactions is a full-table scan that becomes
-- untenable as the chain (and, post-orderbook, transaction volume) grows.
-- These triggers keep an exact running count maintained by the single writer
-- (the indexer worker). Both tables insert with OR IGNORE, so AFTER INSERT
-- fires only for genuinely new rows — the counter stays exact. The count is
-- seeded once from a real COUNT(*) on startup (see initDb).
CREATE TABLE IF NOT EXISTS table_counts (
  name TEXT PRIMARY KEY,
  n    INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS trg_events_count_ai AFTER INSERT ON events
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'events'; END;
CREATE TRIGGER IF NOT EXISTS trg_events_count_ad AFTER DELETE ON events
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'events'; END;
CREATE TRIGGER IF NOT EXISTS trg_tx_count_ai AFTER INSERT ON transactions
BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'transactions'; END;
CREATE TRIGGER IF NOT EXISTS trg_tx_count_ad AFTER DELETE ON transactions
BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'transactions'; END;
`;

// ---- Additive schema migrations, as DATA (audit F-139) ----------------------
// These used to be a straight-line list of ensureColumn(...) calls inside
// initDb. They are a table now for one reason: SCHEMA_FINGERPRINT below has to
// cover them. A worker that skips the DDL step decides to do so by comparing
// this fingerprint against the one the migrator recorded — so if you add a
// column and the fingerprint does not move, every HTTP worker will happily
// conclude "schema is current", skip the ALTER, and then 500 on every query
// that touches the new column. Add columns HERE, never at the call site.
// Append-only; never DROP a column here (data loss) — use a one-time migration.
const ADDITIVE_MIGRATIONS = [
    ['address_labels', 'vetoed_at', 'INTEGER DEFAULT NULL'],
    // Multi-provider price feed: tag each price_history row with the upstream
    // that produced it ('cmc' | 'ascendex' | ...).
    ['price_history', 'source', 'TEXT DEFAULT NULL'],
];

// One-off statements that must run after SCHEMA + the ALTERs, in the same
// "exactly one process does this" step. Existing price_history rows predate the
// `source` column — backfill them as 'cmc' since CMC was the sole provider
// until June 2026. The companion index lets getLatestPriceBySource find the
// most-recent-per-source row in O(log n). Both are idempotent, and both are in
// the fingerprint for the same reason the ALTERs are.
const POST_SCHEMA_SQL = [
    "UPDATE price_history SET source = 'cmc' WHERE source IS NULL",
    'CREATE INDEX IF NOT EXISTS idx_price_source_ts ON price_history(source, timestamp DESC)',
];

// ---- F-139: one process applies the DDL, the rest wait for it ---------------
// The cluster primary forks all WORKERS at once and every one of them used to
// run PRAGMA journal_mode + db.exec(SCHEMA) + every ensureColumn against the
// same file — N processes contending for the SQLite write lock at boot to do
// idempotent work that only needs doing once.
//
// Two previous audit fixes in exactly this spot became incidents, and both are
// the reason for the shape of the code below rather than something tidier:
//   * F-088 — a CREATE INDEX added to SCHEMA held the write lock for minutes on
//     the live transactions table, so no worker's db.exec(SCHEMA) returned and
//     no worker ever reached app.listen. A slow boot here is a site-wide
//     outage, not a slow boot.
//   * F-138 — making ensureColumn throw killed boot on the benign concurrent
//     ALTER race, where the loser's "duplicate column name" error actually
//     means the column EXISTS.
// The invariant that falls out of both: an HTTP worker must never fail to start
// because of the schema step. It waits for the migrator, and if the migrator
// never shows up it does the (idempotent) DDL itself — i.e. degrades to exactly
// the behaviour that shipped before this change. There is no throw on this
// path, deliberately.
const SCHEMA_MARKER_KEY = 'schema:applied';

// Computed, never hand-maintained. A hand-bumped version constant is one
// forgotten edit away from HTTP workers skipping a migration that has not run.
const SCHEMA_FINGERPRINT = createHash('sha256')
    .update(SCHEMA).update('|')
    .update(JSON.stringify(ADDITIVE_MIGRATIONS)).update('|')
    .update(JSON.stringify(POST_SCHEMA_SQL))
    .digest('hex').slice(0, 16);

// How long a non-migrator worker waits for the migrator's marker before giving
// up and applying the DDL itself, and how often it re-checks. The wait only
// costs anything on the boot right after a schema change; on every other boot
// the marker is already there from the previous run and the check is one
// indexed kv read.
const SCHEMA_WAIT_MS = Math.max(0, parseInt(process.env.SCHEMA_WAIT_MS || '', 10) || 20000);
const SCHEMA_POLL_MS = 250;

// Blocking sleep. initDb is synchronous and runs before app.listen, so there is
// no event loop to starve and no request this worker could be serving instead —
// it has nothing to do until the schema exists. Atomics.wait on a throwaway
// SharedArrayBuffer is the only real sync sleep Node offers.
function sleepSync(ms) {
    if (!(ms > 0)) return;
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (_) { const end = Date.now() + ms; while (Date.now() < end) { /* last resort */ } }
}

// Before the migrator's first run the kv TABLE itself does not exist, so a
// throw from this read means "not ready yet", never "the database is broken".
function schemaIsCurrent() {
    try {
        const m = getKv(SCHEMA_MARKER_KEY);
        return !!(m && m.fingerprint === SCHEMA_FINGERPRINT);
    } catch (_) { return false; }
}

// Everything that mutates the schema, in one place so exactly one caller runs
// it. journal_mode lives here and NOT with the per-connection PRAGMAs in initDb
// because WAL is a property of the FILE, not of the connection: every later
// reader inherits it, and setting it from N connections at once is a needless
// way to collect SQLITE_BUSY at boot.
function applyDdl() {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    for (const [table, column, definition] of ADDITIVE_MIGRATIONS) ensureColumn(table, column, definition);
    for (const sql of POST_SCHEMA_SQL) {
        try { db.exec(sql); }
        catch (e) { console.warn(`[db] post-schema statement failed (${sql.slice(0, 40)}...):`, e.message); }
    }
}

// Records what this process did, for the boot log and for tests — the whole
// point of F-139 is unobservable from the outside otherwise.
let lastSchemaAction = null;
export function schemaInitInfo() {
    return { fingerprint: SCHEMA_FINGERPRINT, action: lastSchemaAction };
}

function ensureSchema({ isMigrator, awaitMigrator, waitMs }) {
    if (isMigrator) {
        applyDdl();
        // Written AFTER the DDL and BEFORE the slow indexer-only work below
        // (hash-keyed id migration, counter seed), so waiting HTTP workers are
        // released as soon as the schema is actually correct rather than after
        // a multi-minute full-table migration they do not care about.
        try { setKv(SCHEMA_MARKER_KEY, { fingerprint: SCHEMA_FINGERPRINT, at: Date.now(), pid: process.pid }); }
        catch (e) { console.warn('[db] could not record the schema marker — other workers will re-apply the DDL:', e.message); }
        return 'applied';
    }
    if (schemaIsCurrent()) return 'skipped';
    // No migrator is coming (single-process mode, or INDEXER_ROLE=off with
    // WORKERS<=1): waiting would just add SCHEMA_WAIT_MS to boot for nothing.
    if (!awaitMigrator) { applyDdl(); return 'applied-solo'; }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        sleepSync(SCHEMA_POLL_MS);
        if (schemaIsCurrent()) return 'waited';
    }
    // Do NOT throw. F-022 makes a failed initDb a process exit, so throwing
    // here would take every HTTP worker down whenever the indexer is slow or
    // crash-looping — turning a degraded indexer into a dead site. Re-applying
    // idempotent DDL is what every worker did before F-139; that is the floor
    // this falls back to, and it is a floor, not a failure.
    console.warn(`[db] schema marker absent after ${waitMs}ms (indexer slow, crashed, or absent) — ` +
        'applying the DDL in this worker instead. Set SCHEMA_WAIT_MS to tune the wait.');
    try {
        applyDdl();
    } catch (e) {
        // Same reasoning as ensureColumn's F-138 branch: the most likely cause
        // of a throw HERE is that we lost a race we did not need to win — the
        // migrator is holding the write lock finishing the very DDL we just
        // tried to apply, and our 5s busy_timeout expired. If the schema is in
        // fact present, that error described the outcome we wanted. Check
        // before deciding, because the OTHER cause (a genuinely broken or
        // unwritable database) must still be fatal: F-022 established that
        // serving HTTP with no usable database is worse than being down.
        const usable = schemaLooksUsable();
        if (!usable) throw new Error(`schema init failed and the database is unusable: ${e.message}`);
        console.warn('[db] fallback DDL errored but the schema is present — another worker won the race, continuing:', e.message);
        return 'applied-fallback-raced';
    }
    return 'applied-fallback';
}

// Cheap "is there a schema at all" probe for the fallback path above. Not a
// correctness check — the fingerprint is that — just enough to tell "someone
// else already built this" apart from "this file is empty or broken".
function schemaLooksUsable() {
    try {
        const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?");
        return ['kv', 'blocks', 'transactions', 'events'].every(t => !!stmt.get(t));
    } catch (_) { return false; }
}

// Idempotent ALTER TABLE ADD COLUMN — checks PRAGMA table_info first so it
// only runs once per deployment. Used for additive schema changes where the
// table is already populated in existing deployments. SQLite supports
// IF NOT EXISTS on CREATE but not on ALTER, so we have to introspect.
function ensureColumn(table, column, definition) {
    try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.some(c => c.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    } catch (e) {
        // Audit F-138: this was warn-and-continue. A failed ALTER means the
        // process then runs queries against a column that does not exist —
        // every one of them throwing at request time, which surfaces as
        // random 500s rather than as "the migration failed". Same reasoning as
        // F-022's initDb fail-fast: die at boot, where it's diagnosable.
        //
        // EXCEPT for the benign race a review caught: with WORKERS=N, all N
        // workers call initDb at once, and two can both read PRAGMA
        // table_info before either ALTERs. The loser gets "duplicate column
        // name" — which means the column EXISTS, i.e. the outcome we wanted.
        // Throwing there would fail the boot on the very upgrade path this
        // guard is meant to protect. Re-check and continue only if the column
        // is genuinely present now.
        const benign = /duplicate column name/i.test(e.message || '');
        if (benign) {
            try {
                const cols = db.prepare(`PRAGMA table_info(${table})`).all();
                if (cols.some(c => c.name === column)) {
                    console.log(`[db] ensureColumn(${table}.${column}): another worker added it first — continuing`);
                    return;
                }
            } catch (_) { /* fall through to the throw */ }
        }
        throw new Error(`schema migration failed: ensureColumn(${table}.${column}): ${e.message}`);
    }
}

// `seedCounts` has meant "this process is the indexer, i.e. the single writer"
// since F-021. F-139 gives it a second job — the same process is the migrator —
// rather than adding a parallel flag that could ever disagree with it. The name
// stays so every existing call site and comment still reads true.
//
// opts.awaitMigrator — set false when this process is the ONLY process (single
//   worker, or INDEXER_ROLE=off with WORKERS<=1). Nobody else is going to apply
//   the DDL, so waiting for a migrator that does not exist would add
//   SCHEMA_WAIT_MS to boot and change nothing. Defaults to "wait unless I am
//   the migrator", which is the safe reading for an unqualified call.
// opts.schemaWaitMs — test seam; production tunes SCHEMA_WAIT_MS in the env.
export function initDb(dataDir, seedCounts = false, opts = {}) {
    const isMigrator = !!seedCounts;
    const awaitMigrator = opts.awaitMigrator === undefined ? !isMigrator : !!opts.awaitMigrator;
    const waitMs = opts.schemaWaitMs === undefined ? SCHEMA_WAIT_MS : Math.max(0, opts.schemaWaitMs);

    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(path.join(dataDir, 'explorer.db'));

    // ---- Per-CONNECTION performance PRAGMAs ----
    // Everything below is scoped to THIS connection and has to be re-applied by
    // every worker; none of it touches the file, so none of it contends for the
    // write lock. journal_mode is the one exception and has moved into
    // applyDdl() — see the F-139 block above.
    // SQLite's defaults target embedded use. For a multi-GB server-side
    // index that's read-heavy with a single writer, these knobs matter:
    //   (journal_mode=WAL — unlimited concurrent readers alongside the
    //     indexer's writes — is set in applyDdl() instead: it is a file-level
    //     property that every later connection inherits, so it belongs with the
    //     once-per-database work, not here. See F-139.)
    //   * busy_timeout — absorbs transient lock waits during checkpointing
    //     without surfacing SQLITE_BUSY to the API layer.
    //   * cache_size=-65536 — 64 MB page cache (negative units = KB). The
    //     default 2 MB is fine for a tiny DB; once the index grows past
    //     ~1 GB every uncached query falls back to disk and latencies jump.
    //   * mmap_size — memory-map up to 256 MB of the DB so hot pages
    //     bypass the read() syscall path. Particularly effective for the
    //     wide range scans /blocks, /events, /transactions do.
    //   * synchronous=NORMAL — WAL-safe (still durable across power loss
    //     except for the last transaction); fewer fsyncs than FULL means
    //     the indexer's bulk-insert transactions finish noticeably faster.
    //   * temp_store=MEMORY — sort/GROUP BY/temp B-trees live in RAM
    //     instead of spilling to a temp file on disk.
    //   * wal_autocheckpoint=1000 — fold the WAL back into the main file
    //     every ~1000 pages (~4 MB at the default page size) so the WAL
    //     doesn't grow unbounded between explicit checkpoints. The online
    //     `sqlite3 .backup` we run from cron is also a checkpoint trigger.
    db.exec('PRAGMA busy_timeout = 5000');
    // Page cache + mmap window are env-tunable (see .env.example → "SQLite
    // storage tuning"). Both are PER connection/process, so total RAM scales
    // with the worker count. Conservative defaults keep a small VPS safe; raise
    // SQLITE_CACHE_MB / SQLITE_MMAP_MB on a well-provisioned box to serve more
    // of the DB from RAM instead of disk.
    const cacheMb = Math.max(2, parseInt(process.env.SQLITE_CACHE_MB || '128', 10) || 128);
    const mmapMb = Math.max(0, parseInt(process.env.SQLITE_MMAP_MB || '1024', 10));
    db.exec(`PRAGMA cache_size = ${-(cacheMb * 1024)}`); // negative = KiB
    db.exec(`PRAGMA mmap_size = ${mmapMb * 1024 * 1024}`);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA wal_autocheckpoint = 1000');

    // ---- Schema + additive migrations (audit F-139) ----
    // `CREATE TABLE IF NOT EXISTS` doesn't touch existing tables, so when we add
    // a column to a table that's already in the wild we have to apply the change
    // ourselves — that is what ADDITIVE_MIGRATIONS is for. Who runs it, and what
    // everyone else does meanwhile, is the whole of F-139; see the block above.
    lastSchemaAction = ensureSchema({ isMigrator, awaitMigrator, waitMs });
    console.log(`[db] schema ${lastSchemaAction} (fingerprint ${SCHEMA_FINGERPRINT}` +
        `${isMigrator ? ', migrator' : ''})`);

    // The JSON→SQLite import is a WRITE path, and it is now migrator-only for
    // the same reason the DDL is (F-139, db.js:450-453 in the audit). It used to
    // run in every worker: on a fresh install with the legacy *_cache.json files
    // still present, N workers would each read the same files and INSERT the
    // same rows concurrently, against the single-writer invariant WAL mode is
    // configured around. The indexer worker always exists wherever indexing is
    // wanted, so nothing is lost; a deliberately read-only instance
    // (INDEXER_ROLE=off) correctly declines to write.
    if (isMigrator) {
        try { migrateFromJson(dataDir); }
        catch (e) { console.warn('JSON -> SQLite migration skipped:', e.message); }
    }

    // ---- F-021: hash-keyed transaction / reward ids ----
    // Destructive-by-design (it deletes fork duplicates and fork-inconsistent
    // rows), so unlike the ensureColumn calls above it lives in
    // lib/id-migration.js with its own tests against a real database.
    // Idempotent by construction; the kv flag skips the full-table scans on
    // later boots.
    //
    // INDEXER WORKER ONLY (`seedCounts` is true exactly for that worker).
    // Review of this batch caught the alternative failing in a refork loop:
    // all N cluster workers call initDb at once, the rewrite holds the write
    // lock for the duration of a full-table pass, and every other worker's
    // 5s busy_timeout expires → SQLITE_BUSY → the throw below → exit(1) →
    // refork churn until the winner commits. HTTP workers never write these
    // tables, and reads of legacy ids during the window are harmless.
    if (seedCounts) {
        try {
            const done = getKv('migration:hash-keyed-ids');
            if (!done || !done.completedAt) {
                const r = migrateHashKeyedIds(db);
                setKv('migration:hash-keyed-ids', { ...r, completedAt: Date.now() });
                console.log(`[migration] hash-keyed ids: ${r.txRewritten} tx rewritten, ${r.txDuplicatesDeleted} tx duplicates removed, ` +
                    `${r.rewardRewritten} rewards rewritten, ${r.rewardDuplicatesDeleted} reward duplicates removed; ` +
                    `fork-inconsistent rows deleted: ${r.forkEventsDeleted} events, ${r.forkTxDeleted} tx, ${r.forkRewardsDeleted} rewards`);
            }
        } catch (e) {
            // Do NOT swallow into a warning: new-format writers against an
            // unmigrated table create the duplicate state F-021 describes.
            // Fail the boot; F-022 established that dying loudly beats limping.
            throw new Error(`hash-keyed id migration failed: ${e.message}`);
        }
    }

    // Seed the O(1) row counters once (writer/indexer worker only, to avoid N
    // workers each running the same expensive COUNT(*) at startup). This is the
    // only place a full COUNT(*) on events/transactions runs; thereafter the
    // triggers keep the numbers exact. Runs before the indexer loops start, so
    // no inserts can slip in between the COUNT and the first trigger fire.
    if (seedCounts) {
        // IMPORTANT: do NOT build indexes here. On a large existing DB a
        // synchronous CREATE INDEX holds the SQLite write lock for minutes (and
        // can spike memory enough to OOM the container). That jams every worker's
        // db.exec(SCHEMA) DDL on the write lock, so no worker ever reaches
        // app.listen — i.e. it takes the whole site down at boot. The analytics
        // timestamp indexes are built out-of-band instead, via the one-off
        // `migrate-add-indexes.mjs` script (safe to run against a live DB).
        // The count seed below is read-only (a COUNT scan holds no write lock),
        // so it can't block the other workers.
        // Audit F-088, done safely: create the analytics timestamp indexes ONLY
        // when the table is small enough that CREATE INDEX is instant. That is
        // exactly the case the finding describes — a FRESH install, which
        // otherwise full-scans millions of rows for every timestamp range query
        // until an operator remembers migrate-add-indexes.mjs. On a large
        // existing DB this is skipped and the out-of-band script remains the
        // only safe route (see the warning above).
        try {
            const FRESH_INDEX_MAX_ROWS = 200000;
            for (const [table, idx, col] of [
                ['transactions', 'idx_tx_timestamp', 'timestamp'],
                ['blocks', 'idx_blocks_timestamp', 'timestamp']
            ]) {
                const exists = db.prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(idx);
                if (exists) continue;
                const n = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
                if (n <= FRESH_INDEX_MAX_ROWS) {
                    db.exec(`CREATE INDEX IF NOT EXISTS ${idx} ON ${table}(${col})`);
                    console.log(`[db] created ${idx} (${n} rows — fresh install, instant)`);
                } else {
                    console.warn(`[db] ${idx} is MISSING and ${table} has ${n} rows — too large to build at boot. ` +
                        'Run `node --experimental-sqlite migrate-add-indexes.mjs` out-of-band; ' +
                        'timestamp range queries are full scans until you do.');
                }
            }
        } catch (e) {
            console.warn('[db] analytics index check skipped:', e.message);
        }

        for (const t of ['events', 'transactions']) seedTableCounter(t);
    }

    // Gather index/table statistics so the query planner makes good choices
    // after the DB grows. Cheap to run, only meaningful on startup.
    //
    // Migrator-only (F-139): PRAGMA optimize can decide to run ANALYZE, which
    // WRITES sqlite_stat1. The statistics live in the shared file, so one
    // process computing them serves every reader; N workers doing it at boot
    // buys nothing and puts N processes on the write lock at the worst moment.
    if (isMigrator) {
        try { db.exec('PRAGMA optimize'); } catch (_) { /* ignore on first boot */ }
    }

    return db;
}

// ---- F-140: seed the O(1) row counters, and mean it ------------------------
// This used to be one best-effort attempt whose failure was a console.warn. A
// single loss — SQLITE_BUSY behind a checkpoint, a transient I/O error — left
// table_counts permanently EMPTY for the life of that database, because nothing
// ever tried again: the seed only runs at boot, and the next boot's `if (!has)`
// check would have to win the same race. Every /api/transactions page then paid
// a full COUNT(*) over millions of rows, synchronously, forever.
//
// Retry, then VERIFY the row is actually there — the INSERT succeeding is not
// the same claim as the row existing, and the verification is what makes the
// failure log below trustworthy. Deliberately does not throw: a missing counter
// is a performance problem, and killing the indexer's boot over it (F-022 makes
// an initDb throw a process exit) would trade a slow page for no indexing.
// Exported so test/db-schema-init.test.js can drive the failure path directly:
// the retry is invisible from initDb's outside, and "we retry" is precisely the
// property F-140 asks for, so it has to be reachable to be assertable.
export function seedTableCounter(name, attempts = 5) {
    for (let i = 1; i <= attempts; i++) {
        try {
            if (db.prepare('SELECT 1 FROM table_counts WHERE name = ?').get(name)) return true;
            const c = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c;
            db.prepare('INSERT OR IGNORE INTO table_counts(name, n) VALUES(?, ?)').run(name, c);
            if (db.prepare('SELECT 1 FROM table_counts WHERE name = ?').get(name)) {
                console.log(`[db] seeded ${name} row counter = ${c}`);
                return true;
            }
        } catch (e) {
            console.warn(`[db] count seed for ${name} failed (attempt ${i}/${attempts}):`, e.message);
        }
        if (i < attempts) sleepSync(250 * i);
    }
    console.error(`[db] table_counts row for '${name}' is STILL missing after ${attempts} attempts (audit F-140). ` +
        'Row counts will be served from a cached full scan until the next restart seeds it.');
    return false;
}

// The fallback used when table_counts has no row for a table. It must not be a
// bare COUNT(*): node:sqlite is SYNCHRONOUS, so a full scan of a multi-million
// row table blocks that worker's event loop — every other request it is serving
// stalls with it — and the old code did exactly that on EVERY call, because
// nothing about the miss was remembered. An HTTP worker cannot repair the miss
// itself (only the indexer writes), so the honest thing is to pay for the scan
// at most once per TTL and serve the remembered number in between. The number
// goes slightly stale; the alternative was a self-inflicted stall per request.
const COUNTER_FALLBACK_TTL_MS = 5 * 60 * 1000;
const counterFallbackCache = new Map(); // table -> { value, at }
function countRowsCached(name) {
    const hit = counterFallbackCache.get(name);
    if (hit && (Date.now() - hit.at) < COUNTER_FALLBACK_TTL_MS) return hit.value;
    console.warn(`[db] table_counts has no '${name}' row — falling back to a full COUNT(*) ` +
        `(cached for ${COUNTER_FALLBACK_TTL_MS / 1000}s; audit F-140).`);
    const value = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c;
    counterFallbackCache.set(name, { value, at: Date.now() });
    return value;
}

// Run a function inside a transaction so bulk writes commit in one fsync.
function runTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) { } throw e; }
}

// --- key/value store (singletons + sync watermarks) ---
export function getKv(key) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch (e) { return null; }
}
export function setKv(key, value) {
    db.prepare('INSERT OR REPLACE INTO kv(key, value, updated_at) VALUES(?,?,?)')
        .run(key, JSON.stringify(value), Date.now());
}
export function getSyncState(name) { return getKv('sync:' + name) || {}; }
export function setSyncState(name, obj) { setKv('sync:' + name, obj); }

// --- validators ---
export function replaceValidators(list, meta) {
    runTx(() => {
        db.prepare('DELETE FROM validators').run();
        const stmt = db.prepare('INSERT OR REPLACE INTO validators(address,name,total_stake,commission,real_apy,avg30day_apy,position) VALUES(?,?,?,?,?,?,?)');
        list.forEach((v, i) => stmt.run(v.address, v.name ?? null, v.totalStake ?? 0, v.commission ?? 0, v.realApy ?? 0, v.avg30DayApy ?? 0, i));
    });
    setSyncState('validators', { totalCount: meta.totalCount, lastSync: meta.lastSync, status: meta.status });
}
export function getValidators() {
    const validators = db.prepare('SELECT address, name, total_stake AS totalStake, commission, real_apy AS realApy, avg30day_apy AS avg30DayApy FROM validators ORDER BY position ASC').all();
    const s = getSyncState('validators');
    return { validators, totalCount: s.totalCount ?? validators.length, lastSync: s.lastSync ?? 0, status: s.status ?? 'Initializing', error: s.error };
}

// Per-era commission history for EVERY validator, for the list view.
//
// Reported by a nominator: "every validator changes rewards amount to 1 percent
// the day after you nominate them" — and the validators list, which is what you
// pick from, showed only the CURRENT commission. So a validator that has held
// 1% for forty eras looked exactly like one that dropped to 1% yesterday.
//
// Deliberately NOT denormalised into the `validators` table. That table is
// DELETE-and-rebuild on every sync (replaceValidators), so a cached volatility
// column would be one more thing to keep in step with a source of truth that is
// right here — and this is the shape of bug the audit kept finding (F-045,
// F-109: two copies of one fact drift). validator_history is validators × eras
// tracked, i.e. hundreds to low thousands of rows on this chain, and
// /api/validators is cached for 60s at the edge, so grouping at read time costs
// nothing worth optimising.
//
// Returns a plain object keyed by address: { [address]: [{ era, commission }] }
// ordered oldest-first, ready for lib/commission-history.js.
export function getCommissionHistoryByValidator() {
    // `stake` is selected because it is the ONLY way to tell an era the
    // validator was actually elected in from one it was not.
    //
    // staking.erasValidatorPrefs is a ValueQuery double map — no Option — so
    // querying it for an era in which the validator was NOT in the active set
    // returns the DEFAULT ValidatorPrefs, and getCommissionPercent reads that
    // as 0%. The history scan loops the CURRENT validator set over the last N
    // eras, so every validator that joined the set recently has a run of
    // {commission: 0, stake: 0} rows for the eras before it joined.
    //
    // Reading those as real history turns "this validator was not elected yet"
    // into "this validator raised its commission from 0% to 1%" — a fabricated
    // accusation against a named operator on a page they cannot reply on, which
    // is precisely what lib/commission-history.js is written to avoid.
    // computeValidatorScorecard already filters `Number(h.stake) > 0` for the
    // same reason; the filtering happens in the caller so this function stays a
    // plain read.
    //
    // No ORDER BY: summarizeCommissionHistory sorts by era itself, and asking
    // SQLite for (address, era) order forced a temp B-tree on top of a
    // non-covering index scan for nothing.
    const rows = db.prepare(
        'SELECT address, era, commission, stake FROM validator_history'
    ).all();
    const out = Object.create(null);
    for (const r of rows) {
        if (!r || !r.address) continue;
        (out[r.address] || (out[r.address] = [])).push({
            era: Number(r.era),
            commission: Number(r.commission),
            stake: Number(r.stake)
        });
    }
    return out;
}

// --- holders ---
export function replaceHolders(list, meta) {
    runTx(() => {
        db.prepare('DELETE FROM holders').run();
        const stmt = db.prepare('INSERT OR REPLACE INTO holders(address,rank,name,balance,share) VALUES(?,?,?,?,?)');
        list.forEach(h => stmt.run(h.address, h.rank ?? null, h.name ?? null, h.balance ?? 0, h.share ?? 0));
    });
    setSyncState('holders', { totalCount: meta.totalCount, lastSync: meta.lastSync, status: meta.status });
}
export function getHolders() {
    const holders = db.prepare('SELECT address, rank, name, balance, share FROM holders ORDER BY rank ASC').all();
    const s = getSyncState('holders');
    return { holders, totalCount: s.totalCount ?? holders.length, lastSync: s.lastSync ?? 0, status: s.status ?? 'Initializing' };
}
export function getHolderRank(address) {
    // Audit F-053: the holders table is a top-500 snapshot, and this returned
    // 0 for everyone outside it — which the account page then printed as
    // "rank 0", i.e. better than rank 1. Unknown is null, not zero.
    const row = db.prepare('SELECT rank FROM holders WHERE address = ?').get(address);
    return row ? row.rank : null;
}

// --- transactions ---
const TX_COLS = 'hash, from_addr AS "from", to_addr AS "to", block, method, amount, numeric_amount AS numericAmount, value, status, timestamp, event_index AS eventIndex, block_hash AS blockHash, event_derived AS eventDerived';
export function insertTransactions(list) {
    if (!list || !list.length) return 0;
    let added = 0;
    runTx(() => {
        const stmt = db.prepare('INSERT OR IGNORE INTO transactions(hash,from_addr,to_addr,block,method,amount,numeric_amount,value,status,timestamp,event_index,block_hash,event_derived) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const t of list) {
            if (!t || !t.hash) continue;
            const r = stmt.run(t.hash, t.from ?? null, t.to ?? null, t.block ?? null, t.method ?? null,
                t.amount ?? null, t.numericAmount ?? 0, t.value ?? null, t.status ?? null, t.timestamp ?? null,
                t.eventIndex ?? null, t.blockHash ?? null, t.eventDerived ? 1 : 0);
            added += r.changes;
        }
    });
    return added;
}
export function getRecentTransactions(limit) {
    return db.prepare(`SELECT ${TX_COLS} FROM transactions ORDER BY block DESC, timestamp DESC LIMIT ?`).all(limit);
}
export function getTransactionsByAddress(address, limit, altAddress = null) {
    // Audit F-080: rows written before the writer normalised (and any imported
    // by the old backfill) may carry a different SS58 prefix for the same
    // AccountId. Callers pass the normalised form plus the raw one they were
    // given, so an account's history is complete during and after the
    // transition. Both are indexed columns, so the OR stays cheap.
    if (altAddress && altAddress !== address) {
        return db.prepare(`SELECT ${TX_COLS} FROM transactions
             WHERE from_addr IN (?, ?) OR to_addr IN (?, ?)
             ORDER BY block DESC LIMIT ?`).all(address, altAddress, address, altAddress, limit);
    }
    return db.prepare(`SELECT ${TX_COLS} FROM transactions WHERE from_addr = ? OR to_addr = ? ORDER BY block DESC LIMIT ?`).all(address, address, limit);
}
export function countTransactions() {
    // O(1) via the trigger-maintained counter. The miss path is a CACHED scan,
    // not a bare COUNT(*) per call — see countRowsCached (audit F-140).
    const row = db.prepare("SELECT n FROM table_counts WHERE name = 'transactions'").get();
    return row && row.n != null ? row.n : countRowsCached('transactions');
}

// --- blocks ---
export function insertBlocks(list) {
    if (!list || !list.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR REPLACE INTO blocks(number,hash,author_address,author_name,extrinsics_count,events_count,timestamp) VALUES(?,?,?,?,?,?,?)');
        for (const b of list) stmt.run(b.number, b.hash ?? null, b.authorAddress ?? null, b.authorName ?? null, b.extrinsicsCount ?? 0, b.eventsCount ?? 0, b.timestamp ?? null);
    });
}
export function getRecentBlocks(limit) {
    return db.prepare('SELECT number, hash, author_address AS authorAddress, author_name AS authorName, extrinsics_count AS extrinsicsCount, events_count AS eventsCount, timestamp FROM blocks ORDER BY number DESC LIMIT ?').all(limit);
}
export function hasBlock(number) {
    return !!db.prepare('SELECT 1 FROM blocks WHERE number = ?').get(number);
}
export function countBlocks() {
    return db.prepare('SELECT COUNT(*) AS c FROM blocks').get().c;
}

// Smallest and largest indexed block numbers (NULL on an empty table).
// Used by the chain indexer to compute coverage and decide whether to
// extend backwards (backfill) or forward (catch-up).
export function getBlocksMinMax() {
    const row = db.prepare('SELECT MIN(number) AS min, MAX(number) AS max, COUNT(*) AS count FROM blocks').get();
    return row || { min: null, max: null, count: 0 };
}

// Return ranges of missing block numbers WITHIN the indexed range. Uses
// SQLite's LEAD() window function (available since 3.25) to find every
// pair of adjacent rows whose `number` differs by more than one and reports
// the implied gap. Ordered newest-first so the gap-fill pass works on the
// freshest missing blocks first (most useful to users browsing recent
// activity), then walks back over time.
// ─── Network analytics aggregates ──────────────────────────────────────────
// Daily time-series of the on-chain activity we already index. Returned as
// an object of named series; each series is an array of { day, value } where
// `day` is an ISO date string ('YYYY-MM-DD') in UTC. The window is bounded
// by `sinceTs` so a 30-day chart doesn't have to scan the whole blocks table.
//
// Grouping math: ((timestamp / 86_400_000) | 0) gives the UTC day number
// since epoch. We expand back to a date string in JS rather than via SQLite
// strftime because chain timestamps are millis (strftime wants seconds) and
// converting once at the boundary is clearer than doing it in every query.
export function getDailyAnalytics(sinceTs) {
    const since = Number(sinceTs) || 0;
    const dayToISO = (n) => new Date(n * 86400000).toISOString().substring(0, 10);

    const txRows = db.prepare(`
        SELECT CAST(timestamp / 86400000 AS INTEGER) AS day,
               COUNT(*) AS txCount,
               COALESCE(SUM(numeric_amount), 0) AS txVolume
        FROM transactions
        WHERE timestamp >= ?
        GROUP BY day
        ORDER BY day ASC
    `).all(since);

    const blockRows = db.prepare(`
        SELECT CAST(timestamp / 86400000 AS INTEGER) AS day,
               COUNT(*) AS blockCount,
               AVG(extrinsics_count) AS avgExtrinsics,
               AVG(events_count) AS avgEvents
        FROM blocks
        WHERE timestamp >= ?
        GROUP BY day
        ORDER BY day ASC
    `).all(since);

    // Active addresses per UTC day. UNION (not UNION ALL) de-duplicates
    // address×day pairs, so an account that sent AND received on the same
    // day is counted once. SQLite's UNION builds the intermediate set in
    // memory; fine for 30-day windows of typical chain volume.
    const addrRows = db.prepare(`
        SELECT day, COUNT(DISTINCT addr) AS activeAddresses FROM (
            SELECT CAST(timestamp / 86400000 AS INTEGER) AS day, from_addr AS addr
            FROM transactions WHERE timestamp >= ? AND from_addr IS NOT NULL AND from_addr <> 'System'
            UNION
            SELECT CAST(timestamp / 86400000 AS INTEGER) AS day, to_addr AS addr
            FROM transactions WHERE timestamp >= ? AND to_addr IS NOT NULL AND to_addr <> ''
        )
        GROUP BY day
        ORDER BY day ASC
    `).all(since, since);

    // Cumulative treasury PDEX awarded (across all eras present in the
    // governance index). Falls back to an empty series if the treasury
    // crawler hasn't populated `resolved_block` yet on any rows.
    const treasuryRows = db.prepare(`
        SELECT CAST(resolved_at / 86400000 AS INTEGER) AS day,
               SUM(CAST(value AS REAL)) AS awardedPdex
        FROM treasury_proposals
        WHERE status = 'awarded' AND resolved_at >= ?
        GROUP BY day
        ORDER BY day ASC
    `).all(since);

    return {
        txCount:         txRows.map(r => ({ day: dayToISO(r.day), value: Number(r.txCount) || 0 })),
        txVolume:        txRows.map(r => ({ day: dayToISO(r.day), value: Number(r.txVolume) || 0 })),
        blocks:          blockRows.map(r => ({ day: dayToISO(r.day), value: Number(r.blockCount) || 0 })),
        avgExtrinsics:   blockRows.map(r => ({ day: dayToISO(r.day), value: Number(r.avgExtrinsics) || 0 })),
        activeAddresses: addrRows.map(r => ({ day: dayToISO(r.day), value: Number(r.activeAddresses) || 0 })),
        treasuryAwarded: treasuryRows.map(r => ({ day: dayToISO(r.day), value: Number(r.awardedPdex) || 0 }))
    };
}

// Find gaps in the indexed block range. The LEAD() window walks the blocks
// table in primary-key order, so an unbounded call is O(rows) — fine during a
// one-off audit, but far too expensive to run every indexer tick once the
// table has millions of rows. Pass `sinceBlock` to bound the scan to a recent
// window (WHERE number >= sinceBlock uses the PK index): steady-state holes only
// ever appear near the head, so that's all we need to scan most of the time.
export function getBlockGaps(limit = 50, sinceBlock = null) {
    const bounded = sinceBlock != null;
    const stmt = db.prepare(`
        SELECT (number + 1) AS gapStart,
               (next_num - 1) AS gapEnd,
               (next_num - number - 1) AS gapSize
        FROM (
            SELECT number, LEAD(number) OVER (ORDER BY number) AS next_num
            FROM blocks
            ${bounded ? 'WHERE number >= ?' : ''}
        )
        WHERE next_num IS NOT NULL AND next_num - number > 1
        ORDER BY number DESC
        LIMIT ?
    `);
    return bounded ? stmt.all(sinceBlock, limit) : stmt.all(limit);
}

// Audit F-005: getBlockGaps() uses LEAD, so it can only see a hole BETWEEN two
// stored rows. If the newest or oldest blocks of the claimed range are missing
// entirely there is no "next row" to compare against and the hole is invisible
// — the exact blind spot that lets a post-outage suffix hole go unnoticed.
//
// This reports the two edge cases explicitly, given the watermarks the indexer
// claims to have covered. Both queries are MIN/MAX on the primary key, so this
// is cheap enough to call on a normal tick (unlike the LEAD window scan).
// F-007: the stored (number, hash) pairs for a height range, so the reorg
// sweep can compare them against the chain's canonical hashes. Range reads on
// the PK — cheap at any table size.
export function getBlockHashesRange(fromNumber, toNumber) {
    return db.prepare('SELECT number, hash FROM blocks WHERE number >= ? AND number <= ?')
        .all(fromNumber, toNumber);
}

// F-007 repair: delete every row at this height that does not carry the
// canonical hash. Implementation + tests in lib/id-migration.js.
export function deleteForkRows(blockNumber, canonicalHash) {
    return deleteForkRowsImpl(db, blockNumber, canonicalHash);
}

// F-008: transfer events for a block range, feeding the transactions
// backfill. Same row shape the operator backfill script reads, so
// lib/tx-from-event.js's buildTxRowFromEventRow consumes both.
export function getTransferEventRowsRange(fromBlock, toBlock) {
    return db.prepare(`
        SELECT block, event_index AS eventIndex, data, timestamp, block_hash AS blockHash, status
          FROM events
         WHERE section = 'balances' AND method = 'Transfer'
           AND block >= ? AND block <= ?
    `).all(fromBlock, toBlock);
}

export function getEdgeGaps(oldestClaimed, latestClaimed) {
    const row = db.prepare('SELECT MIN(number) AS lo, MAX(number) AS hi FROM blocks').get();
    const out = [];
    if (!row || row.lo == null) return out;      // empty table: nothing to compare
    const lo = Number(row.lo), hi = Number(row.hi);
    if (oldestClaimed != null && Number(oldestClaimed) > 0 && lo > Number(oldestClaimed)) {
        out.push({ kind: 'prefix', gapStart: Number(oldestClaimed), gapEnd: lo - 1, gapSize: lo - Number(oldestClaimed) });
    }
    if (latestClaimed != null && hi < Number(latestClaimed)) {
        out.push({ kind: 'suffix', gapStart: hi + 1, gapEnd: Number(latestClaimed), gapSize: Number(latestClaimed) - hi });
    }
    return out;
}

// --- events ---
function mapEventRow(r) {
    let data = null;
    try { data = JSON.parse(r.data); } catch (e) { }
    return { ...r, data };
}
const EVENT_COLS = 'hash, tx_hash AS txHash, block_hash AS blockHash, block, event_index AS eventIndex, extrinsic_index AS extrinsicIndex, section, method, data, signer_address AS signerAddress, signer_name AS signerName, timestamp, status';
export function insertEvents(list) {
    if (!list || !list.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR IGNORE INTO events(hash,tx_hash,block_hash,block,event_index,extrinsic_index,section,method,data,signer_address,signer_name,timestamp,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const e of list) {
            if (!e || !e.hash) continue;
            stmt.run(e.hash, e.txHash ?? null, e.blockHash ?? null, e.block ?? null, e.eventIndex ?? null,
                e.extrinsicIndex ?? null, e.section ?? null, e.method ?? null, JSON.stringify(e.data ?? null),
                e.signerAddress ?? null, e.signerName ?? null, e.timestamp ?? null, e.status ?? null);
        }
    });
}
export function getRecentEvents(limit) {
    return db.prepare(`SELECT ${EVENT_COLS} FROM events ORDER BY block DESC, event_index DESC LIMIT ?`).all(limit).map(mapEventRow);
}
export function getEventsByAddress(address, limit) {
    return db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE signer_address = ? ORDER BY block DESC LIMIT ?`).all(address, limit).map(mapEventRow);
}
export function countEvents() {
    // O(1) via the trigger-maintained counter (see table_counts). The miss path
    // is a CACHED scan, not a bare COUNT(*) per call — see countRowsCached
    // (audit F-140).
    const row = db.prepare("SELECT n FROM table_counts WHERE name = 'events'").get();
    return row && row.n != null ? row.n : countRowsCached('events');
}

// --- validator history & triggers ---
export function upsertValidatorHistory(rows) {
    if (!rows || !rows.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR REPLACE INTO validator_history(era,address,commission,stake,apy) VALUES(?,?,?,?,?)');
        for (const r of rows) stmt.run(r.era, r.address, r.commission ?? 0, r.stake ?? 0, r.apy ?? 0);
    });
}
export function getValidatorHistory(address) {
    return db.prepare('SELECT era, commission, stake, apy FROM validator_history WHERE address = ? ORDER BY era DESC').all(address);
}
export function countValidatorHistoryEras(address) {
    return db.prepare('SELECT COUNT(*) AS c FROM validator_history WHERE address = ?').get(address).c;
}
// Audit F-115. This used to DELETE every trigger for the address and re-insert
// from whatever the caller had just computed — and the caller computes from the
// last 30 eras only, while `validator_history` is UPSERTed and keeps everything.
// So a validator who spiked commission 40 eras ago had that permanently erased
// on the next sync: the evidence was still in validator_history, and the table
// meant to summarise it had quietly dropped it.
//
// Now it MERGES. Triggers are keyed (address, era) and derived deterministically
// from history, so re-deriving the same era produces the same row and a merge is
// idempotent — while an era outside the current window is simply left alone.
//
// The name is kept because callers pass a full recomputation, but the semantics
// are "record these", not "these are now the only ones".
export function mergeValidatorTriggers(address, triggers) {
    if (!triggers || !triggers.length) return;
    runTx(() => {
        const stmt = db.prepare('INSERT OR REPLACE INTO validator_triggers(address,era,prev_commission,new_commission,timestamp) VALUES(?,?,?,?,?)');
        for (const t of triggers) stmt.run(address, t.era, t.prevCommission ?? 0, t.newCommission ?? 0, t.timestamp ?? Date.now());
    });
}

// Wipe-and-write. Retained ONLY for a caller that has genuinely recomputed from
// the complete stored history and needs to drop triggers that no longer hold
// (e.g. after a history correction). Using this with a windowed history is the
// F-115 bug.
export function replaceValidatorTriggers(address, triggers) {
    runTx(() => {
        db.prepare('DELETE FROM validator_triggers WHERE address = ?').run(address);
        const stmt = db.prepare('INSERT OR REPLACE INTO validator_triggers(address,era,prev_commission,new_commission,timestamp) VALUES(?,?,?,?,?)');
        for (const t of (triggers || [])) stmt.run(address, t.era, t.prevCommission ?? 0, t.newCommission ?? 0, t.timestamp ?? Date.now());
    });
}
export function getValidatorTriggers(address) {
    return db.prepare('SELECT era, prev_commission AS prevCommission, new_commission AS newCommission, timestamp FROM validator_triggers WHERE address = ? ORDER BY era DESC').all(address);
}

// --- staking rewards (claimed payouts) ---
export function insertStakingRewards(list) {
    if (!list || !list.length) return 0;
    let added = 0;
    runTx(() => {
        const stmt = db.prepare('INSERT OR IGNORE INTO staking_rewards(id,stash,amount,era,validator,block,block_hash,event_index,timestamp) VALUES(?,?,?,?,?,?,?,?,?)');
        for (const r of list) {
            if (!r || !r.id) continue;
            const res = stmt.run(r.id, r.stash, r.amount ?? 0, r.era ?? null, r.validator ?? null, r.block ?? null, r.blockHash ?? null, r.eventIndex ?? null, r.timestamp ?? null);
            added += res.changes;
        }
    });
    return added;
}
export function getStakingRewards(stash) {
    return db.prepare('SELECT id, stash, amount, era, validator, block, block_hash AS blockHash, event_index AS eventIndex, timestamp FROM staking_rewards WHERE stash = ? ORDER BY block DESC, event_index DESC').all(stash);
}
export function countStakingRewards() {
    return db.prepare('SELECT COUNT(*) AS c FROM staking_rewards').get().c;
}
export function countStakingRewardStashes() {
    return db.prepare('SELECT COUNT(DISTINCT stash) AS c FROM staking_rewards').get().c;
}
export function getClaimedRewardKeys(stash) {
    return db.prepare('SELECT DISTINCT era, validator FROM staking_rewards WHERE stash = ?').all(stash);
}

// --- staking rewards (unclaimed / unpaid, computed on demand) ---
export function replaceUnclaimed(stash, rows) {
    runTx(() => {
        db.prepare('DELETE FROM staking_rewards_unclaimed WHERE stash = ?').run(stash);
        const stmt = db.prepare('INSERT OR REPLACE INTO staking_rewards_unclaimed(stash,era,validator,amount) VALUES(?,?,?,?)');
        for (const r of (rows || [])) stmt.run(stash, r.era, r.validator ?? '', r.amount ?? 0);
    });
    setKv('unclaimed_at:' + stash, Date.now());
}
export function getUnclaimed(stash) {
    return db.prepare('SELECT era, validator, amount FROM staking_rewards_unclaimed WHERE stash = ? ORDER BY era DESC').all(stash);
}
export function getUnclaimedComputedAt(stash) {
    const v = getKv('unclaimed_at:' + stash);
    return typeof v === 'number' ? v : 0;
}

// --- price history ---
// Multi-provider: each row carries a `source` tag ('cmc' | 'ascendex' |
// 'coingecko-backfill' | ...) so /api/price-latest can expose the most-recent
// quote per provider and the chart can optionally filter. INSERT OR IGNORE
// preserves whichever row landed first when two providers race to the same
// millisecond (vanishingly rare in practice; the safety net is cheap).
export function insertPrice(point) {
    db.prepare('INSERT OR IGNORE INTO price_history(timestamp,price,market_cap,volume_24h,pct_change_24h,source) VALUES(?,?,?,?,?,?)')
        .run(
            point.timestamp,
            point.price ?? null,
            point.marketCap ?? null,
            point.volume24h ?? null,
            point.pctChange24h ?? null,
            point.source ?? null
        );
}
// Audit F-153: with more than one provider enabled, each writes its own row
// per poll (deliberately offset by a few ms so the timestamp PK doesn't
// collide — see PRICE_PROVIDER_TS_OFFSET). Plotting every row makes the chart
// SAWTOOTH between providers' slightly different quotes, which reads as
// volatility that never happened. Collapse to one point per poll window,
// preferring the row whose source ranks highest, so the series is a single
// coherent line. Historical backfill rows (one source, far apart) are
// unaffected.
//
// The ranking is explicit rather than "newest wins": newest-wins would flip
// between providers tick to tick, which is the same sawtooth by another route.
const PRICE_SOURCE_RANK = { coingecko: 4, cmc: 3, ascendex: 2, 'ascendex-backfill': 1, 'defillama-backfill': 1 };
const PRICE_MERGE_WINDOW_MS = 60 * 1000;

export function getPriceHistory(sinceTs) {
    const rows = db.prepare('SELECT timestamp, price, market_cap AS marketCap, volume_24h AS volume24h, pct_change_24h AS pctChange24h, source FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(sinceTs ?? 0);
    const out = [];
    for (const row of rows) {
        const prev = out[out.length - 1];
        if (prev && Math.abs(Number(row.timestamp) - Number(prev.timestamp)) <= PRICE_MERGE_WINDOW_MS) {
            const rankPrev = PRICE_SOURCE_RANK[prev.source] || 0;
            const rankRow = PRICE_SOURCE_RANK[row.source] || 0;
            if (rankRow > rankPrev) out[out.length - 1] = row;
            continue;   // same poll window — one point, not two
        }
        out.push(row);
    }
    return out;
}
export function getLatestPrice() {
    return db.prepare('SELECT timestamp, price, market_cap AS marketCap, volume_24h AS volume24h, pct_change_24h AS pctChange24h, source FROM price_history ORDER BY timestamp DESC LIMIT 1').get() || null;
}
// Most-recent row from a specific provider — used by the dashboard to show
// CMC's and AscendEX's prices side-by-side once both are healthy.
export function getLatestPriceBySource(source) {
    return db.prepare('SELECT timestamp, price, market_cap AS marketCap, volume_24h AS volume24h, pct_change_24h AS pctChange24h, source FROM price_history WHERE source = ? ORDER BY timestamp DESC LIMIT 1').get(source) || null;
}
export function countPricePoints() {
    return db.prepare('SELECT COUNT(*) AS c FROM price_history').get().c;
}
export function countPricePointsBySource(source) {
    return db.prepare('SELECT COUNT(*) AS c FROM price_history WHERE source = ?').get(source).c;
}

// --- democracy referenda ---
export function upsertDemocracyReferendum(r) {
    db.prepare('INSERT OR REPLACE INTO democracy_referenda(ref_index,status,end_block,ayes,nays,turnout,tally_known,proposal,threshold,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(r.refIndex, r.status ?? null, r.endBlock ?? null, r.ayes ?? null, r.nays ?? null, r.turnout ?? null, r.tallyKnown ? 1 : 0, r.proposal ?? null, r.threshold ?? null, Date.now());
}
export function getDemocracyReferenda() {
    return db.prepare('SELECT ref_index AS refIndex, status, end_block AS endBlock, ayes, nays, turnout, tally_known AS tallyKnown, proposal, threshold FROM democracy_referenda ORDER BY ref_index DESC').all();
}
export function countDemocracyReferenda() {
    return db.prepare('SELECT COUNT(*) AS c FROM democracy_referenda').get().c;
}

// --- discussion threads + posts ---
function mapThread(r) {
    if (!r) return null;
    return {
        id: r.id, kind: r.kind, refKey: r.ref_key, title: r.title, status: r.status,
        createdAt: r.created_at, closedAt: r.closed_at, closedReason: r.closed_reason,
        postCount: db.prepare('SELECT COUNT(*) AS c FROM discussion_posts WHERE thread_id = ?').get(r.id).c
    };
}
export function createThreadIfMissing(t) {
    const exists = db.prepare('SELECT 1 FROM discussion_threads WHERE id = ?').get(t.id);
    if (exists) return false;
    db.prepare('INSERT INTO discussion_threads(id,kind,ref_key,title,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(t.id, t.kind ?? null, t.refKey ?? null, t.title ?? null, 'open', Date.now());
    return true;
}
export function getThreads(kind) {
    const rows = kind
        ? db.prepare('SELECT * FROM discussion_threads WHERE kind = ? ORDER BY created_at DESC').all(kind)
        : db.prepare('SELECT * FROM discussion_threads ORDER BY created_at DESC').all();
    return rows.map(mapThread);
}
export function getThread(id) {
    return mapThread(db.prepare('SELECT * FROM discussion_threads WHERE id = ?').get(id));
}
export function getOpenThreadIds(kind) {
    return db.prepare("SELECT id FROM discussion_threads WHERE kind = ? AND status = 'open'").all(kind).map(r => r.id);
}
export function closeThread(id, reason) {
    db.prepare("UPDATE discussion_threads SET status = 'closed', closed_at = ?, closed_reason = ? WHERE id = ? AND status != 'closed'")
        .run(Date.now(), reason ?? null, id);
}
export function createPost(p) {
    const r = db.prepare('INSERT INTO discussion_posts(thread_id,author,author_name,content,created_at) VALUES(?,?,?,?,?)')
        .run(p.threadId, p.author, p.authorName ?? null, p.content, Date.now());
    return Number(r.lastInsertRowid);
}
export function getPosts(threadId) {
    return db.prepare('SELECT id, thread_id AS threadId, author, author_name AS authorName, content, created_at AS createdAt FROM discussion_posts WHERE thread_id = ? ORDER BY created_at ASC').all(threadId);
}
export function countThreads() {
    return db.prepare('SELECT COUNT(*) AS c FROM discussion_threads').get().c;
}

// --- wallet-signature auth ---
export function setChallenge(address, nonce) {
    db.prepare('INSERT OR REPLACE INTO auth_challenges(address,nonce,created_at) VALUES(?,?,?)').run(address, nonce, Date.now());
}
export function getChallenge(address) {
    const r = db.prepare('SELECT address, nonce, created_at AS createdAt FROM auth_challenges WHERE address = ?').get(address);
    return r || null;
}
export function deleteChallenge(address) {
    db.prepare('DELETE FROM auth_challenges WHERE address = ?').run(address);
}
export function createSession(token, address, ttlMs) {
    const now = Date.now();
    db.prepare('INSERT OR REPLACE INTO auth_sessions(token,address,created_at,expires_at) VALUES(?,?,?,?)')
        .run(token, address, now, now + ttlMs);
}
export function getSession(token) {
    const s = db.prepare('SELECT token, address, expires_at AS expiresAt FROM auth_sessions WHERE token = ?').get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token); return null; }
    return s;
}
export function deleteSession(token) {
    db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

// --- treasury proposals (full history, crawled from chain events) ---
// Status ranks ensure a partial update never downgrades a resolved proposal
// (e.g. a backfilled "proposed" event must not overwrite an "awarded" status).
// Audit F-052 adds `resolved`: "this left live chain storage, so it is no
// longer open, but we have not yet seen the event that says how it ended."
// It sits ABOVE approved (so the reconcile pass can close an approved-but-
// vanished row) and BELOW the real outcomes (so the history crawler can still
// upgrade it to awarded/rejected when it reaches that block).
const TREASURY_STATUS_RANK = { proposed: 0, approved: 1, resolved: 2, awarded: 3, rejected: 3 };
export function upsertTreasuryProposal(p) {
    if (p == null || p.id == null) return;
    const ex = db.prepare('SELECT proposer,proposer_name,beneficiary,beneficiary_name,value,bond,status,proposed_block,proposed_at,resolved_block,resolved_at FROM treasury_proposals WHERE id = ?').get(p.id);
    const keep = (v, old) => (v !== undefined && v !== null) ? v : (ex ? old : null);
    let status = ex ? ex.status : null;
    if (p.status) {
        const newRank = TREASURY_STATUS_RANK[p.status] ?? 0;
        const oldRank = status ? (TREASURY_STATUS_RANK[status] ?? 0) : -1;
        if (newRank >= oldRank) status = p.status;
    }
    db.prepare(`INSERT OR REPLACE INTO treasury_proposals
        (id,proposer,proposer_name,beneficiary,beneficiary_name,value,bond,status,proposed_block,proposed_at,resolved_block,resolved_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        p.id,
        keep(p.proposer, ex && ex.proposer),
        keep(p.proposerName, ex && ex.proposer_name),
        keep(p.beneficiary, ex && ex.beneficiary),
        keep(p.beneficiaryName, ex && ex.beneficiary_name),
        keep(p.value, ex && ex.value),
        keep(p.bond, ex && ex.bond),
        status,
        keep(p.proposedBlock, ex && ex.proposed_block),
        keep(p.proposedAt, ex && ex.proposed_at),
        keep(p.resolvedBlock, ex && ex.resolved_block),
        keep(p.resolvedAt, ex && ex.resolved_at),
        Date.now()
    );
}
export function getTreasuryProposals() {
    return db.prepare(`SELECT id, proposer, proposer_name AS proposerName, beneficiary, beneficiary_name AS beneficiaryName,
        value, bond, status, proposed_block AS proposedBlock, proposed_at AS proposedAt,
        resolved_block AS resolvedBlock, resolved_at AS resolvedAt
        FROM treasury_proposals ORDER BY id DESC`).all();
}
// ─── Audit F-075: cluster-wide rate limiting ────────────────────────────────
//
// Read-modify-write under BEGIN IMMEDIATE so two workers racing the same key
// cannot both see "under the limit" and both allow. Without the transaction
// this table would still multiply the limit — just by less, and
// nondeterministically, which is harder to reason about than the honest
// per-process version it replaces.
//
// `decide` receives the stored timestamp list and returns
// { allowed, kept, ... } — see lib/rate-limit.js checkWindow. Keeping the
// arithmetic outside means the window logic stays testable without a database.
export function consumeRateLimit(bucket, subject, decide) {
    // A review caught two defects in the first version of this, both in the
    // failure path — the path that only runs when things are already going
    // wrong, and therefore the one least likely to be exercised before it
    // matters.
    //
    // (1) `BEGIN IMMEDIATE` is itself the statement most likely to throw here:
    //     it is what waits on the write lock, so a busy indexer past
    //     busy_timeout fails RIGHT THERE, with no transaction open. The old
    //     catch then ran a bare `ROLLBACK`, which throws "cannot rollback - no
    //     transaction is active", escapes the catch, and never reaches the
    //     fail-open return. authRateGate has no try/catch of its own, so
    //     /api/auth/challenge and /api/auth/verify would have returned 500 —
    //     the rate limiter causing the outage it exists to prevent, which is
    //     exactly what the comment claimed it would not do.
    //
    // (2) The row was written even when the request was REFUSED. An attacker
    //     already over the limit could therefore keep forcing write
    //     transactions against a single-writer SQLite file at any rate they
    //     chose, contending with the indexer. A limiter must get cheaper under
    //     abuse, not more expensive.
    let began = false;
    try {
        db.exec('BEGIN IMMEDIATE');
        began = true;
        const row = db.prepare('SELECT hits FROM rate_limits WHERE bucket = ? AND subject = ?')
            .get(bucket, subject);
        let hits = [];
        if (row && row.hits) {
            try { hits = JSON.parse(row.hits) || []; } catch (_) { hits = []; }
        }
        const result = decide(hits);

        // Only write when the state actually changed — i.e. when the hit was
        // allowed and recorded. A refusal leaves the stored window untouched.
        if (result.allowed) {
            db.prepare(`
                INSERT INTO rate_limits (bucket, subject, hits, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(bucket, subject) DO UPDATE SET hits = excluded.hits, updated_at = excluded.updated_at
            `).run(bucket, subject, JSON.stringify(result.kept), Date.now());
        }
        db.exec('COMMIT');
        began = false;
        return result;
    } catch (e) {
        // Roll back ONLY if we actually started a transaction.
        if (began) {
            try { db.exec('ROLLBACK'); } catch (_) { /* already unwound */ }
        }
        // FAIL OPEN. Reached now, which it was not before.
        console.warn('[rate-limit] falling open for', bucket, e.message);
        return { allowed: true, remaining: 0, retryAfterMs: 0, kept: [] };
    }
}

// Drop buckets nobody has touched recently. Cheap, and only the indexer runs it.
export function pruneRateLimits(olderThanMs = 24 * 60 * 60 * 1000) {
    try {
        return db.prepare('DELETE FROM rate_limits WHERE updated_at < ?')
            .run(Date.now() - olderThanMs).changes;
    } catch (_) { return 0; }
}

export function countTreasuryProposals() {
    return db.prepare('SELECT COUNT(*) AS c FROM treasury_proposals').get().c;
}

// ─── Audit F-052: close out rows that quietly left chain storage ────────────
//
// Treasury proposals and council motions are DELETED from chain storage when
// they resolve. The live sync therefore sees only open items, and the history
// crawler is what normally supplies the resolving event. If that event is ever
// missed — a scan gap, an RPC failure during the block that resolved it, a
// runtime that emitted a variant we do not decode — the row keeps the last
// status anyone wrote, which is `proposed`. And because the status ranks refuse
// to downgrade, nothing later can move it. The item then shows as OPEN on
// /calendar, /treasury and /council permanently: a motion the council closed
// two years ago, still listed as awaiting votes.
//
// The live sync knows the full open set every tick, so absence from it is
// itself evidence. We record that evidence honestly as `resolved` — meaning
// "definitely not open any more, outcome unknown" — rather than guessing
// awarded/rejected. The history crawler can still upgrade it later.
//
// CALLER CONTRACT, and the reason this is a separate function rather than
// inlined in the sync: only call this with a set you know is complete. An
// empty array from a FAILED query would mark every open item resolved in one
// tick, which is a far worse lie than the one being fixed. The callers pass
// a trusted flag; see syncTreasury / syncCouncil.
// `trusted` is REQUIRED, not advisory. The first version of this pair
// documented the contract in prose and left the caller free to ignore it —
// which the council caller then did, because its live-set build is wrapped in a
// log-and-continue catch. A safety precondition that only exists in a comment
// is not a precondition. Refuse to act without it.
export function resolveMissingTreasuryProposals(liveIds, { trusted = false } = {}) {
    if (!trusted) {
        console.warn('resolveMissingTreasuryProposals called without trusted:true — refusing (F-052).');
        return 0;
    }
    if (!Array.isArray(liveIds)) return 0;
    const open = db.prepare(
        "SELECT id FROM treasury_proposals WHERE status IN ('proposed','approved')"
    ).all();
    const live = new Set(liveIds.map(Number));
    const gone = open.filter(r => !live.has(Number(r.id)));
    if (gone.length === 0) return 0;
    const upd = db.prepare(
        "UPDATE treasury_proposals SET status = 'resolved', updated_at = ? WHERE id = ?"
    );
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const r of gone) upd.run(now, r.id);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return gone.length;
}

export function resolveMissingCouncilMotions(liveHashes, { trusted = false } = {}) {
    if (!trusted) {
        console.warn('resolveMissingCouncilMotions called without trusted:true — refusing (F-052).');
        return 0;
    }
    if (!Array.isArray(liveHashes)) return 0;
    const open = db.prepare("SELECT hash FROM council_motions WHERE status = 'proposed'").all();
    const live = new Set(liveHashes.map(String));
    const gone = open.filter(r => !live.has(String(r.hash)));
    if (gone.length === 0) return 0;
    const upd = db.prepare(
        "UPDATE council_motions SET status = 'resolved', updated_at = ? WHERE hash = ?"
    );
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const r of gone) upd.run(now, r.hash);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return gone.length;
}

// --- council motions (full history, crawled from chain events) ---
const MOTION_STATUS_RANK = { proposed: 0, resolved: 1, closed: 2, approved: 3, disapproved: 3, executed: 4 };   // F-052: see TREASURY_STATUS_RANK
export function upsertCouncilMotion(m) {
    if (m == null || !m.hash) return;
    const ex = db.prepare('SELECT motion_index,proposer,proposer_name,section,method,threshold,status,ayes,nays,proposed_block,proposed_at,resolved_block,resolved_at FROM council_motions WHERE hash = ?').get(m.hash);
    const keep = (v, old) => (v !== undefined && v !== null) ? v : (ex ? old : null);
    let status = ex ? ex.status : null;
    if (m.status) {
        const newRank = MOTION_STATUS_RANK[m.status] ?? 0;
        const oldRank = status ? (MOTION_STATUS_RANK[status] ?? 0) : -1;
        if (newRank >= oldRank) status = m.status;
    }
    db.prepare(`INSERT OR REPLACE INTO council_motions
        (hash,motion_index,proposer,proposer_name,section,method,threshold,status,ayes,nays,proposed_block,proposed_at,resolved_block,resolved_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        m.hash,
        keep(m.motionIndex, ex && ex.motion_index),
        keep(m.proposer, ex && ex.proposer),
        keep(m.proposerName, ex && ex.proposer_name),
        keep(m.section, ex && ex.section),
        keep(m.method, ex && ex.method),
        keep(m.threshold, ex && ex.threshold),
        status,
        keep(m.ayes, ex && ex.ayes),
        keep(m.nays, ex && ex.nays),
        keep(m.proposedBlock, ex && ex.proposed_block),
        keep(m.proposedAt, ex && ex.proposed_at),
        keep(m.resolvedBlock, ex && ex.resolved_block),
        keep(m.resolvedAt, ex && ex.resolved_at),
        Date.now()
    );
}
export function getCouncilMotions() {
    return db.prepare(`SELECT hash, motion_index AS motionIndex, proposer, proposer_name AS proposerName,
        section, method, threshold, status, ayes, nays, proposed_block AS proposedBlock, proposed_at AS proposedAt,
        resolved_block AS resolvedBlock, resolved_at AS resolvedAt
        FROM council_motions ORDER BY motion_index DESC`).all();
}
export function countCouncilMotions() {
    return db.prepare('SELECT COUNT(*) AS c FROM council_motions').get().c;
}

// ─── Address labels (v2: community-sourced + voting) ──────────────────────
// Storage model:
//   address_labels         — one row per (address, signer); signer == address
//                            is a "self" label, signer != address is community.
//                            vetoed_at non-null = hidden by the address owner.
//   address_label_votes    — one ±1 row per (label, voter). Cleared by DELETE.
//   address_label_reports  — one row per (label, reporter). N reports auto-hide.
//
// Caller (server.js) is responsible for verifying the signer's signature
// BEFORE calling any of the write functions below.

// Insert or update a label. Works for both self and community labels — the
// signer-must-match-address check is the API layer's job, not the db's.
export function upsertAddressLabel({ address, signer, label }) {
    const now = Date.now();
    db.prepare(`
        INSERT INTO address_labels (address, signer, label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(address, signer) DO UPDATE SET
            label = excluded.label,
            updated_at = excluded.updated_at,
            vetoed_at = NULL   -- re-edit by the same signer un-vetoes their own row
    `).run(address, signer, label, now, now);
}

export function deleteAddressLabel(address, signer) {
    // Cascade the votes + reports too so we don't accumulate orphans.
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('DELETE FROM address_label_votes WHERE label_address = ? AND label_signer = ?').run(address, signer);
        db.prepare('DELETE FROM address_label_reports WHERE label_address = ? AND label_signer = ?').run(address, signer);
        db.prepare('DELETE FROM address_labels WHERE address = ? AND signer = ?').run(address, signer);
        db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Owner veto / un-veto. Only meaningful for community labels (signer != address);
// for a self-label the signer can just delete or update their own row.
export function setLabelVeto(address, signer, vetoed) {
    db.prepare(`
        UPDATE address_labels SET vetoed_at = ?
        WHERE address = ? AND signer = ?
    `).run(vetoed ? Date.now() : null, address, signer);
}

// Vote on a label. Pass `vote = 0` to clear an existing vote.
export function upsertLabelVote({ labelAddress, labelSigner, voter, vote }) {
    if (!vote || vote === 0) {
        db.prepare(`
            DELETE FROM address_label_votes
            WHERE label_address = ? AND label_signer = ? AND voter = ?
        `).run(labelAddress, labelSigner, voter);
        return;
    }
    const v = vote > 0 ? 1 : -1;
    db.prepare(`
        INSERT INTO address_label_votes (label_address, label_signer, voter, vote, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(label_address, label_signer, voter) DO UPDATE SET
            vote = excluded.vote,
            created_at = excluded.created_at
    `).run(labelAddress, labelSigner, voter, v, Date.now());
}

// Insert a report. No-op if this reporter already reported this label.
export function reportLabel({ labelAddress, labelSigner, reporter, reason }) {
    db.prepare(`
        INSERT OR IGNORE INTO address_label_reports
            (label_address, label_signer, reporter, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(labelAddress, labelSigner, reporter, (reason || '').slice(0, 200), Date.now());
}

// All labels for an address, with aggregated vote totals + report count.
// `viewer` (optional) — when set, each row carries the viewer's own vote
// (-1, 0, +1) so the frontend can render voting buttons in their current
// state without a second query. The caller decides whether to filter out
// hidden labels (over-reported / vetoed); this function returns them all.
//
// Sort order is the canonical display order:
//   1. self-labels first (signer == address)
//   2. then community labels by net score, descending
//   3. tie-break by createdAt ascending (older suggestion wins)
export function getLabelsForAddress(address, viewer = null) {
    const rows = db.prepare(`
        SELECT
            l.address,
            l.signer,
            l.label,
            l.created_at  AS createdAt,
            l.updated_at  AS updatedAt,
            l.vetoed_at   AS vetoedAt,
            (l.signer = l.address) AS isSelf,
            COALESCE((SELECT SUM(CASE WHEN v.vote > 0 THEN 1 ELSE 0 END)
                      FROM address_label_votes v
                      WHERE v.label_address = l.address AND v.label_signer = l.signer), 0) AS upvotes,
            COALESCE((SELECT SUM(CASE WHEN v.vote < 0 THEN 1 ELSE 0 END)
                      FROM address_label_votes v
                      WHERE v.label_address = l.address AND v.label_signer = l.signer), 0) AS downvotes,
            COALESCE((SELECT COUNT(*) FROM address_label_reports r
                      WHERE r.label_address = l.address AND r.label_signer = l.signer), 0) AS reportCount,
            (SELECT v.vote FROM address_label_votes v
             WHERE v.label_address = l.address AND v.label_signer = l.signer AND v.voter = ?) AS viewerVote
        FROM address_labels l
        WHERE l.address = ?
    `).all(viewer || '', address);
    // Bring booleans into JS-land and compute net score / pickable flag.
    return rows.map(r => {
        const score = (Number(r.upvotes) || 0) - (Number(r.downvotes) || 0);
        return {
            address: r.address,
            signer: r.signer,
            label: r.label,
            isSelf: !!r.isSelf,
            score,
            upvotes: Number(r.upvotes) || 0,
            downvotes: Number(r.downvotes) || 0,
            reportCount: Number(r.reportCount) || 0,
            vetoed: r.vetoedAt != null,
            viewerVote: r.viewerVote == null ? 0 : Number(r.viewerVote),
            createdAt: r.createdAt,
            updatedAt: r.updatedAt
        };
    }).sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        if (a.score !== b.score) return b.score - a.score;
        return (a.createdAt || 0) - (b.createdAt || 0);
    });
}

// Returns the SINGLE highest-priority visible label for an address, or null.
// "Visible" = not vetoed by owner AND (is_self OR (score >= 0 AND reports
// below threshold)).
//
// Used for backwards-compat with the v1 caller `getSelfLabel` (which we
// keep as an alias below) and for the bulk-decorate path.
export function getTopLabel(address, reportHideThreshold = 3) {
    const rows = getLabelsForAddress(address, null);
    for (const r of rows) {
        if (r.vetoed) continue;
        if (r.isSelf) return r;
        if (r.score >= 0 && r.reportCount < reportHideThreshold) return r;
    }
    return null;
}

// Backwards-compat shim — v1 callers asked for the self-label specifically;
// in v2 the top label may be a community one. Keep the old function name
// returning the SAME shape v1 used so existing call sites don't break.
export function getSelfLabel(address) {
    const row = db.prepare(`
        SELECT label, created_at AS createdAt, updated_at AS updatedAt, vetoed_at AS vetoedAt
        FROM address_labels WHERE address = ? AND signer = ?
        LIMIT 1
    `).get(address, address);
    if (!row || row.vetoedAt != null) return null;
    return { label: row.label, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

// Bulk decorate — used to fetch top labels for many addresses in one round
// trip (top-holders list, transactions table, etc.). Returns a
// Map<address, { label, signer, isSelf, score }>.
export function getTopLabelsBulk(addresses, reportHideThreshold = 3) {
    const result = new Map();
    if (!Array.isArray(addresses) || !addresses.length) return result;
    const unique = Array.from(new Set(addresses));
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
        const slice = unique.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        // Pull every visible row for the chunk in one query, then resolve
        // top-per-address in JS — much cheaper than N round-trips.
        const rows = db.prepare(`
            SELECT
                l.address, l.signer, l.label, l.created_at AS createdAt,
                (l.signer = l.address) AS isSelf,
                COALESCE((SELECT SUM(v.vote) FROM address_label_votes v
                          WHERE v.label_address = l.address AND v.label_signer = l.signer), 0) AS score,
                COALESCE((SELECT COUNT(*) FROM address_label_reports r
                          WHERE r.label_address = l.address AND r.label_signer = l.signer), 0) AS reportCount
            FROM address_labels l
            WHERE l.address IN (${placeholders})
              AND l.vetoed_at IS NULL
        `).all(...slice);
        // Group by address and pick the same priority rule as getTopLabel.
        const byAddress = new Map();
        for (const r of rows) {
            const arr = byAddress.get(r.address) || [];
            arr.push(r);
            byAddress.set(r.address, arr);
        }
        for (const [addr, arr] of byAddress) {
            arr.sort((a, b) => {
                if (a.isSelf !== b.isSelf) return b.isSelf - a.isSelf;
                if (a.score !== b.score) return b.score - a.score;
                return (a.createdAt || 0) - (b.createdAt || 0);
            });
            const top = arr.find(r => r.isSelf || (Number(r.score) >= 0 && Number(r.reportCount) < reportHideThreshold));
            if (top) result.set(addr, { label: top.label, signer: top.signer, isSelf: !!top.isSelf, score: Number(top.score) || 0 });
        }
    }
    return result;
}

export function countAddressLabels() {
    return db.prepare('SELECT COUNT(*) AS c FROM address_labels').get().c;
}
export function countLabelVotes() {
    return db.prepare('SELECT COUNT(*) AS c FROM address_label_votes').get().c;
}

// ─── Scan-failure retry queue ──────────────────────────────────────────────
// Per-indexer record of blocks that errored on first scan. The gap-fill
// phase in each indexer's sync function reads from here, retries each
// entry, and clears it on success. Rows that hit the retry cap stay in
// the table for operator inspection but are no longer returned by
// getScanFailures.

// Idempotent upsert. First insertion records first_at + initial error;
// subsequent failures for the same (indexer, block) increment the attempts
// counter and overwrite last_error / last_at so the operator can see the
// latest reason and oldest first_at side by side.
export function recordScanFailure(indexer, block, errMessage) {
    const now = Date.now();
    const msg = String(errMessage || '').slice(0, 500);
    db.prepare(`
        INSERT INTO scan_failures (indexer, block, attempts, last_error, first_at, last_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(indexer, block) DO UPDATE SET
            attempts   = attempts + 1,
            last_error = excluded.last_error,
            last_at    = excluded.last_at
    `).run(indexer, block, msg, now, now);
}

// Clear a single (indexer, block) entry — called after a retry succeeds.
export function clearScanFailure(indexer, block) {
    db.prepare('DELETE FROM scan_failures WHERE indexer = ? AND block = ?').run(indexer, block);
}

// NOTE: countScanFailures() already exists further down this file (it returns
// { retrying, permanent, total }); don't add a second one. Audit F-050 is
// about USING those counts — see deriveIndexStatus in lib/index-status.js.

// Reset the attempt counter on abandoned blocks so the retry queue picks them
// up again. Used after fixing the bug that caused the failures (e.g. the
// missing RPC guard that permanently dropped 3 governance blocks in June).
export function requeueScanFailures(indexer, maxAttempts = 10) {
    const info = db.prepare(
        'UPDATE scan_failures SET attempts = 0 WHERE indexer = ? AND attempts >= ?'
    ).run(indexer, maxAttempts);
    return Number(info && info.changes) || 0;
}

// Rescue blocks that were abandoned because the NODE was unavailable, not
// because the block was bad. Those attempts should never have counted (see
// lib/rpc-errors.js); this repairs the rows that predate that fix. Idempotent:
// once requeued the rows either succeed and disappear, or fail for a real
// reason and no longer match these patterns.
export function requeueTransientScanFailures(maxAttempts = 10) {
    const likes = rpcUnavailableLikePatterns();
    const clause = likes.map(() => 'LOWER(last_error) LIKE ?').join(' OR ');
    const info = db.prepare(
        `UPDATE scan_failures SET attempts = 0 WHERE attempts >= ? AND (${clause})`
    ).run(maxAttempts, ...likes);
    return Number(info && info.changes) || 0;
}

// Return up to `limit` failures for the given indexer, oldest first,
// excluding rows that have exceeded the retry cap. Caller decides what
// to do with the cap — surface the row in a UI, log it, or just leave
// it alone. Rows above the cap stay in the table forever (no auto-prune)
// since they're a signal that something is genuinely broken for that
// block.
export function getScanFailures(indexer, limit = 20, maxAttempts = 10) {
    return db.prepare(`
        SELECT block, attempts, last_error AS lastError,
               first_at AS firstAt, last_at AS lastAt
        FROM scan_failures
        WHERE indexer = ? AND attempts < ?
        ORDER BY last_at ASC
        LIMIT ?
    `).all(indexer, maxAttempts, limit);
}

// Counts split by "retrying" (under cap) vs "permanent" (at/over cap) so
// operators can quickly tell whether the queue is just busy or whether
// blocks are genuinely stuck.
export function countScanFailures(indexer, maxAttempts = 10) {
    const row = db.prepare(`
        SELECT
            SUM(CASE WHEN attempts <  ? THEN 1 ELSE 0 END) AS retrying,
            SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS permanent,
            COUNT(*) AS total
        FROM scan_failures
        WHERE indexer = ?
    `).get(maxAttempts, maxAttempts, indexer);
    return {
        retrying:  Number(row && row.retrying)  || 0,
        permanent: Number(row && row.permanent) || 0,
        total:     Number(row && row.total)     || 0
    };
}

// --- one-time migration of legacy JSON caches ---
function tableCount(table) {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}
function readJsonFile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function migrateFromJson(dataDir) {
    const j = name => path.join(dataDir, name);

    if (tableCount('validators') === 0) {
        const d = readJsonFile(j('cache.json'));
        if (d && Array.isArray(d.validators) && d.validators.length) {
            replaceValidators(d.validators, { totalCount: d.totalCount ?? d.validators.length, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced' });
            console.log('Migrated validators from JSON:', d.validators.length);
        }
    }
    if (tableCount('holders') === 0) {
        const d = readJsonFile(j('holders_cache.json'));
        if (d && Array.isArray(d.holders) && d.holders.length) {
            replaceHolders(d.holders, { totalCount: d.totalCount ?? d.holders.length, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced' });
            console.log('Migrated holders from JSON:', d.holders.length);
        }
    }
    if (tableCount('transactions') === 0) {
        const d = readJsonFile(j('transactions_cache.json'));
        if (d && Array.isArray(d.transactions) && d.transactions.length) {
            insertTransactions(d.transactions);
            setSyncState('transactions', { lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced', latestScannedBlock: d.latestScannedBlock ?? 0, oldestScannedBlock: d.oldestScannedBlock ?? 0, scannedBlocks: d.scannedBlocks ?? 0, scannerVersion: d.scannerVersion ?? 0 });
            console.log('Migrated transactions from JSON:', d.transactions.length);
        }
    }
    if (tableCount('blocks') === 0) {
        const d = readJsonFile(j('blocks_cache.json'));
        if (d && Array.isArray(d.blocks) && d.blocks.length) { insertBlocks(d.blocks); console.log('Migrated blocks from JSON:', d.blocks.length); }
    }
    if (tableCount('events') === 0) {
        const d = readJsonFile(j('events_cache.json'));
        if (d && Array.isArray(d.events) && d.events.length) { insertEvents(d.events); console.log('Migrated events from JSON:', d.events.length); }
    }
    if (tableCount('validator_history') === 0) {
        const d = readJsonFile(j('validator_history_cache.json'));
        if (d && typeof d === 'object') {
            const rows = [];
            for (const era of Object.keys(d)) {
                const eraData = d[era];
                if (!eraData || typeof eraData !== 'object') continue;
                for (const addr of Object.keys(eraData)) {
                    const v = eraData[addr] || {};
                    rows.push({ era: Number(era), address: addr, commission: v.commission, stake: v.stake, apy: v.apy });
                }
            }
            if (rows.length) { upsertValidatorHistory(rows); console.log('Migrated validator history from JSON:', rows.length); }
        }
    }
    if (tableCount('validator_triggers') === 0) {
        const d = readJsonFile(j('validator_triggers_cache.json'));
        if (d && typeof d === 'object') {
            for (const addr of Object.keys(d)) {
                if (Array.isArray(d[addr]) && d[addr].length) replaceValidatorTriggers(addr, d[addr]);
            }
        }
    }
    if (!getKv('network_info')) {
        const d = readJsonFile(j('network_info_cache.json'));
        if (d && d.networkInfo) setKv('network_info', { networkInfo: d.networkInfo, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced' });
    }
    if (tableCount('staking_rewards') === 0) {
        const d = readJsonFile(j('staking_rewards_cache.json'));
        if (d && d.rewards && typeof d.rewards === 'object') {
            const rows = [];
            for (const stash of Object.keys(d.rewards)) {
                const list = d.rewards[stash];
                if (!Array.isArray(list)) continue;
                for (const r of list) {
                    rows.push({ id: r.id || `${r.block}-${r.eventIndex}`, stash, amount: r.amount, era: r.era, validator: r.validator, block: r.block, blockHash: r.blockHash, eventIndex: r.eventIndex, timestamp: r.timestamp });
                }
            }
            if (rows.length) { insertStakingRewards(rows); console.log('Migrated staking rewards from JSON:', rows.length); }
            setSyncState('staking_rewards', {
                latestScannedBlock: d.latestScannedBlock ?? 0, oldestScannedBlock: d.oldestScannedBlock ?? 0,
                backfillCursor: d.backfillCursor ?? 0, backfillComplete: !!d.backfillComplete,
                initialized: !!d.initialized, lastSync: d.lastSync ?? 0, status: d.status ?? 'Synced'
            });
        }
    }
}

// ─── Email alert helpers ─────────────────────────────────────────────────────
// All times are epoch ms. event_prefs is stored as a JSON string and parsed
// on read for the caller's convenience.

function mapSubscriber(row) {
    if (!row) return null;
    let prefs = {};
    try { prefs = JSON.parse(row.event_prefs || '{}'); } catch (_) { prefs = {}; }
    return {
        id:                  row.id,
        email:               row.email,
        emailLower:          row.email_lc,
        confirmationToken:   row.confirmation_token,
        unsubscribeToken:    row.unsubscribe_token,
        confirmedAt:         row.confirmed_at,
        unsubscribedAt:      row.unsubscribed_at,
        eventPrefs:          prefs,
        source:              row.source,
        walletAddress:       row.wallet_address,
        createdAt:           row.created_at,
        updatedAt:           row.updated_at
    };
}

export function getEmailSubscriberByEmail(email) {
    const lc = String(email || '').trim().toLowerCase();
    if (!lc) return null;
    return mapSubscriber(db.prepare('SELECT * FROM email_subscribers WHERE email_lc = ?').get(lc));
}
// Audit F-110: confirmation tokens had no expiry column and were never
// rotated, while the subscribe modal told users the link was "valid for 24
// hours". A months-old link in a mailbox stayed a live opt-in credential.
// TOKEN_TTL is enforced in the lookup so an expired token simply does not
// resolve, and resendConfirmationToken() rotates on every resend.
export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function rotateConfirmationToken(id, newToken) {
    db.prepare('UPDATE email_subscribers SET confirmation_token = ?, updated_at = ? WHERE id = ?')
        .run(newToken, Date.now(), id);
    return getEmailSubscriberById(id);
}

// Is this confirmation token still within its TTL? Measured from the row's
// updated_at, which rotation bumps.
export function isConfirmationTokenFresh(row) {
    if (!row) return false;
    const stamp = Number(row.updatedAt || row.createdAt || 0);
    if (!Number.isFinite(stamp) || stamp <= 0) return false;
    return (Date.now() - stamp) <= CONFIRM_TOKEN_TTL_MS;
}

export function getEmailSubscriberByConfirmationToken(token) {
    if (!token) return null;
    return mapSubscriber(db.prepare('SELECT * FROM email_subscribers WHERE confirmation_token = ?').get(token));
}
export function getEmailSubscriberByUnsubscribeToken(token) {
    if (!token) return null;
    return mapSubscriber(db.prepare('SELECT * FROM email_subscribers WHERE unsubscribe_token = ?').get(token));
}
export function getEmailSubscriberById(id) {
    if (id == null) return null;
    return mapSubscriber(db.prepare('SELECT * FROM email_subscribers WHERE id = ?').get(id));
}

// Insert a brand-new (unconfirmed) subscriber. If the email already exists
// — whether confirmed or not — returns the existing row WITHOUT modifying
// it; the caller decides whether to resend the confirmation email.
export function createEmailSubscriberIfMissing({ email, confirmationToken, unsubscribeToken, eventPrefs, source, walletAddress }) {
    const now = Date.now();
    const lc = String(email || '').trim().toLowerCase();
    const existing = getEmailSubscriberByEmail(lc);
    if (existing) return { created: false, subscriber: existing };
    db.prepare(`INSERT INTO email_subscribers
        (email, email_lc, confirmation_token, unsubscribe_token, event_prefs, source, wallet_address, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        email.trim(),
        lc,
        confirmationToken,
        unsubscribeToken,
        JSON.stringify(eventPrefs || {}),
        source ?? null,
        walletAddress ?? null,
        now, now
    );
    return { created: true, subscriber: getEmailSubscriberByEmail(lc) };
}

// Mark a subscriber confirmed. Returns the (post-update) row, or null if no
// such confirmation token exists. Idempotent — re-confirming is a no-op.
export function confirmEmailSubscriber(token) {
    const row = getEmailSubscriberByConfirmationToken(token);
    if (!row) return null;
    // Audit F-042, the half that was still missing: this guarded on
    // `!row.confirmedAt`, so a subscriber who had confirmed, unsubscribed and
    // then signed up again clicked their confirmation link and NOTHING
    // happened — unsubscribed_at stayed set, getConfirmedEmailSubscribers kept
    // excluding them, and the page said "You're subscribed!". Reactivating an
    // unsubscribed row is the entire point of the resubscribe flow, so the
    // write must also run when confirmed_at is set but unsubscribed_at is too.
    if (!row.confirmedAt || row.unsubscribedAt) {
        db.prepare('UPDATE email_subscribers SET confirmed_at = ?, unsubscribed_at = NULL, updated_at = ? WHERE id = ?')
            .run(row.confirmedAt || Date.now(), Date.now(), row.id);
    }
    return getEmailSubscriberById(row.id);
}

// Unsubscribe via token (no auth needed — the token IS the auth). Idempotent.
export function unsubscribeEmailSubscriber(token) {
    const row = getEmailSubscriberByUnsubscribeToken(token);
    if (!row) return null;
    if (!row.unsubscribedAt) {
        db.prepare('UPDATE email_subscribers SET unsubscribed_at = ?, updated_at = ? WHERE id = ?')
            .run(Date.now(), Date.now(), row.id);
    }
    return getEmailSubscriberById(row.id);
}

// Update event preferences. Caller passes a fully-merged prefs object; we
// JSON.stringify and write it as-is. Used by the /api/email/preferences
// endpoint (token-based, no wallet auth needed).
export function setEmailSubscriberPrefs(token, eventPrefs) {
    const row = getEmailSubscriberByUnsubscribeToken(token);
    if (!row) return null;
    db.prepare('UPDATE email_subscribers SET event_prefs = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(eventPrefs || {}), Date.now(), row.id);
    return getEmailSubscriberById(row.id);
}

// All confirmed-and-not-unsubscribed subscribers. The dispatcher then
// filters by event_prefs in JS — keeping the SQL simple and avoiding
// JSON-path SQL gymnastics across SQLite versions.
export function getConfirmedEmailSubscribers() {
    const rows = db.prepare(
        'SELECT * FROM email_subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL'
    ).all();
    return rows.map(mapSubscriber);
}

// Dispatch idempotency: record (eventKind, eventId, subscriberId) BEFORE the
// SMTP call so a crash or duplicate watcher doesn't double-send. Returns
// `true` if the row was newly inserted (caller should send), `false` if a
// row already existed (already sent, skip).
export function reserveEmailDispatch({ eventKind, eventId, subscriberId }) {
    const r = db.prepare(`INSERT OR IGNORE INTO email_dispatches
        (event_kind, event_id, subscriber_id, dispatched_at, result)
        VALUES (?,?,?,?,?)`).run(
        String(eventKind), String(eventId), subscriberId, Date.now(), 'pending'
    );
    return r.changes > 0;
}

// Update an in-flight dispatch row with the provider's result after the
// SMTP call returns. Idempotent (won't re-update old rows).
export function recordEmailDispatchResult({ eventKind, eventId, subscriberId, providerId, result }) {
    db.prepare(`UPDATE email_dispatches
        SET provider_id = ?, result = ?
        WHERE event_kind = ? AND event_id = ? AND subscriber_id = ?`).run(
        providerId ?? null, result ?? 'sent',
        String(eventKind), String(eventId), subscriberId
    );
}

export function countEmailSubscribers() {
    return db.prepare('SELECT COUNT(*) AS c FROM email_subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL').get().c;
}
