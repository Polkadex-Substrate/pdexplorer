// SQLite data layer for the Polkadex explorer.
// Uses Node's built-in node:sqlite (run the backend with --experimental-sqlite).
// Replaces the previous whole-file JSON caches: every write is an indexed
// INSERT/UPSERT and every read is an indexed query, so caches can hold full
// historical data without the cost of rewriting/parsing a growing file.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
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
        console.warn(`ensureColumn(${table}.${column}) failed: ${e.message}`);
    }
}

export function initDb(dataDir, seedCounts = false) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(path.join(dataDir, 'explorer.db'));

    // ---- Performance PRAGMAs ----
    // SQLite's defaults target embedded use. For a multi-GB server-side
    // index that's read-heavy with a single writer, these knobs matter:
    //   * journal_mode=WAL — unlimited concurrent readers alongside the
    //     indexer's writes; the indexer is the only writer.
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
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA cache_size = -65536');
    db.exec('PRAGMA mmap_size = 268435456');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA wal_autocheckpoint = 1000');

    db.exec(SCHEMA);

    // ---- Additive schema migrations ----
    // `CREATE TABLE IF NOT EXISTS` doesn't touch existing tables, so when we
    // add a column to a table that's already in the wild we have to apply
    // the change ourselves. Each call is a no-op when the column is already
    // present. Keep this list append-only; never DROP a column here (data
    // loss). For a destructive change use a one-time migration function.
    ensureColumn('address_labels', 'vetoed_at', 'INTEGER DEFAULT NULL');
    // Multi-provider price feed: tag each price_history row with the upstream
    // that produced it ('cmc' | 'ascendex' | ...). Existing rows predate the
    // column — backfill them as 'cmc' since CMC was the sole provider until
    // June 2026. The companion index lets getLatestPriceBySource scan the
    // most-recent-per-source row in O(log n).
    ensureColumn('price_history', 'source', "TEXT DEFAULT NULL");
    try {
        db.exec("UPDATE price_history SET source = 'cmc' WHERE source IS NULL");
        db.exec('CREATE INDEX IF NOT EXISTS idx_price_source_ts ON price_history(source, timestamp DESC)');
    } catch (e) {
        console.warn('price_history source backfill failed:', e.message);
    }

    try { migrateFromJson(dataDir); }
    catch (e) { console.warn('JSON -> SQLite migration skipped:', e.message); }

    // Seed the O(1) row counters once (writer/indexer worker only, to avoid N
    // workers each running the same expensive COUNT(*) at startup). This is the
    // only place a full COUNT(*) on events/transactions runs; thereafter the
    // triggers keep the numbers exact. Runs before the indexer loops start, so
    // no inserts can slip in between the COUNT and the first trigger fire.
    if (seedCounts) {
        // Indexer-only heavy migrations, built once by the sole writer so N
        // workers don't race to CREATE INDEX on a multi-GB table at startup.
        // These timestamp indexes power the analytics daily aggregates — without
        // them getDailyAnalytics's `WHERE timestamp >= ?` is a full table scan
        // that gets progressively slower as the chain grows. First build on a
        // large existing DB can take a while; it's a one-time startup cost.
        for (const ddl of [
            'CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)',
        ]) {
            try {
                const t0 = Date.now();
                db.exec(ddl);
                const ms = Date.now() - t0;
                if (ms > 1000) console.log(`[db] ${ddl.match(/idx_\w+/)[0]} built in ${ms}ms`);
            } catch (e) {
                console.warn('[db] analytics index build failed:', e.message);
            }
        }
        for (const t of ['events', 'transactions']) {
            try {
                const has = db.prepare('SELECT 1 FROM table_counts WHERE name = ?').get(t);
                if (!has) {
                    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
                    db.prepare('INSERT OR IGNORE INTO table_counts(name, n) VALUES(?, ?)').run(t, c);
                    console.log(`[db] seeded ${t} row counter = ${c}`);
                }
            } catch (e) {
                console.warn(`[db] count seed for ${t} failed:`, e.message);
            }
        }
    }

    // Gather index/table statistics so the query planner makes good choices
    // after the DB grows. Cheap to run, only meaningful on startup.
    try { db.exec('PRAGMA optimize'); } catch (_) { /* ignore on first boot */ }

    return db;
}

// Run a function inside a transaction so bulk writes commit in one fsync.
function runTx(fn) {
    db.exec('BEGIN');
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
    const row = db.prepare('SELECT rank FROM holders WHERE address = ?').get(address);
    return row ? row.rank : 0;
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
export function getTransactionsByAddress(address, limit) {
    return db.prepare(`SELECT ${TX_COLS} FROM transactions WHERE from_addr = ? OR to_addr = ? ORDER BY block DESC LIMIT ?`).all(address, address, limit);
}
export function countTransactions() {
    // O(1) via the trigger-maintained counter; falls back to a real scan only
    // if the counter hasn't been seeded yet (e.g. an HTTP-only worker that
    // started before the indexer seeded it).
    const row = db.prepare("SELECT n FROM table_counts WHERE name = 'transactions'").get();
    return row && row.n != null ? row.n : db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
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
    // O(1) via the trigger-maintained counter (see table_counts); falls back to
    // a full scan only if the counter hasn't been seeded yet.
    const row = db.prepare("SELECT n FROM table_counts WHERE name = 'events'").get();
    return row && row.n != null ? row.n : db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
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
export function getPriceHistory(sinceTs) {
    return db.prepare('SELECT timestamp, price, market_cap AS marketCap, volume_24h AS volume24h, pct_change_24h AS pctChange24h, source FROM price_history WHERE timestamp >= ? ORDER BY timestamp ASC').all(sinceTs ?? 0);
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
const TREASURY_STATUS_RANK = { proposed: 0, approved: 1, awarded: 2, rejected: 2 };
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
export function countTreasuryProposals() {
    return db.prepare('SELECT COUNT(*) AS c FROM treasury_proposals').get().c;
}

// --- council motions (full history, crawled from chain events) ---
const MOTION_STATUS_RANK = { proposed: 0, closed: 1, approved: 2, disapproved: 2, executed: 3 };
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
    db.exec('BEGIN');
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
    if (!row.confirmedAt) {
        db.prepare('UPDATE email_subscribers SET confirmed_at = ?, unsubscribed_at = NULL, updated_at = ? WHERE id = ?')
            .run(Date.now(), Date.now(), row.id);
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
