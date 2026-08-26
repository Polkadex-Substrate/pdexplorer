#!/usr/bin/env node
// Standalone one-shot transaction backfill for the Polkadex Explorer.
//
// Rebuilds the `transactions` table from the already-indexed `events` table —
// WITHOUT crawling the chain. Every `balances.Transfer` event the chain
// indexer has already stored is turned into an event-derived transaction row,
// so the all-time "Indexed transactions" count finally reflects real history
// instead of just the recent rolling window scanned by syncTransactions().
//
// WHY THIS EXISTS
//   The combined chain indexer (syncChainIndex in server.js) backfills BLOCKS
//   and EVENTS all the way to genesis, but it only ever calls insertBlocks /
//   insertEvents — never insertTransactions. The transactions table is
//   populated by a SEPARATE indexer (syncTransactions) that only scans the
//   most recent TX_INITIAL_SCAN_BLOCKS (~20k) blocks once and then rolls
//   forward. Result: `SELECT COUNT(*) FROM transactions` (the value behind the
//   "Indexed transactions" KPI) was a tiny recent-window number, not all-time.
//   Since events are already fully indexed, we can derive the full transaction
//   history locally with zero RPC.
//
// WHAT COUNTS AS A TRANSACTION HERE
//   Exactly what the live event-derived path produces
//   (buildFinancialTransactionFromEvent in server.js): one row per
//   `balances.Transfer` event. This captures transfers from every call
//   variant (transfer, transferKeepAlive, transferAllowDeath, transferAll,
//   forceTransfer) because they all emit the same Transfer event.
//
// HASH / IDEMPOTENCY
//   Each row's primary key is `event-<blockHash>-<eventIndex>` (audit F-021 —
//   hash-keyed so fork rows can't collide with canonical ones), byte-for-byte
//   the same id the live indexer assigns via lib/tx-from-event.js. Inserts
//   use INSERT OR IGNORE, so (a) re-running this script is safe, and (b) rows
//   the forward indexer already wrote are left untouched — no duplicates.
//
// USAGE
//   # Inside the running backend container (recommended — this script is on
//   # the Dockerfile.backend COPY line, and the DB is at /app/data):
//   docker compose exec backend node --experimental-sqlite \
//       backfill-transactions-from-events.mjs
//
//   # Against a DB path on the host:
//   node --experimental-sqlite backfill-transactions-from-events.mjs \
//       --db /opt/pdexplorer/data/explorer.db
//
//   # Preview without writing:
//   node --experimental-sqlite backfill-transactions-from-events.mjs --dry-run
//
// SAFETY
//   Read-mostly: a single streaming pass over the events table plus batched
//   INSERT OR IGNORE into transactions. A 30s busy_timeout lets it coexist
//   with the running indexer (SQLite serialises the writers). The forward
//   syncTransactions indexer is untouched and keeps appending new transfers.

import { DatabaseSync } from 'node:sqlite';
// Parsing + id scheme shared with the live indexer (lib/tx-from-event.js).
// This script used to carry its own copies; after F-008 made the indexer do
// the same derivation, two implementations of "what is this transfer worth"
// was a disagreement waiting to happen — and after F-021 the id scheme is a
// correctness surface, not a convention.
import { parseTransfer, formatAmountDisplay, eventTxId } from './lib/tx-from-event.js';
import fs from 'node:fs';
import process from 'node:process';

// ---- CLI args ----
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i > -1 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}
const hasFlag = name => process.argv.includes(`--${name}`);

const DB_PATH = arg('db', process.env.TX_BACKFILL_DB_PATH || process.env.PRICE_BACKFILL_DB_PATH || '/app/data/explorer.db');
const BATCH_SIZE = Number(arg('batch-size', 2000));   // rows per write transaction
const DRY_RUN = hasFlag('dry-run');

// Chain token scale. Polkadex uses 12 decimals (matches formatPDEX in
// server.js: Number(balance) / 10 ** 12).
const PDEX_DECIMALS = 12;
const PLANCK_PER_PDEX = 10n ** BigInt(PDEX_DECIMALS);

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    console.error(`Tip: pass --db <path> or set TX_BACKFILL_DB_PATH.`);
    console.error(`     Inside the backend container the default is /app/data/explorer.db.`);
    process.exit(2);
}

console.log(`[tx-backfill] DB:         ${DB_PATH}`);
console.log(`[tx-backfill] Batch size: ${BATCH_SIZE} rows/write txn`);
console.log(`[tx-backfill] Mode:       ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);

// ---- amount parsing ----
//
// The events table stores `data` as JSON of `event.data.toHuman()`. For a
// balances.Transfer event that decodes (under V14+ metadata, where the amount
// field is a concrete u128) to a positional array:
//   ["<from-ss58>", "<to-ss58>", "12,345,678,900,000"]   // comma-grouped planck
// Older runtimes that typed the field as the abstract `Balance` class instead
// SI-format it ("12.3456 PDEX", "1.5000 kPDEX", "640.0000 mPDEX"). Some
// toHuman variants emit a named object {from,to,amount}. We handle all three
// so numeric_amount (which drives the analytics volume series) stays correct.

// (Transfer parsing lives in lib/tx-from-event.js — see import above.)

// ---- DB ----
function openDb(dbPath) {
    const db = new DatabaseSync(dbPath);
    // Wait, don't crash, if the running indexer holds the write lock.
    db.exec('PRAGMA busy_timeout = 30000');
    const tbls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','transactions')").all();
    const names = new Set(tbls.map(t => t.name));
    if (!names.has('events')) { console.error('[tx-backfill] no `events` table — nothing to backfill from'); process.exit(2); }
    if (!names.has('transactions')) { console.error('[tx-backfill] no `transactions` table — run the server once to create the schema'); process.exit(2); }
    return db;
}

function run() {
    const db = openDb(DB_PATH);

    const totalTransferEvents = db.prepare(
        "SELECT COUNT(*) AS c FROM events WHERE section='balances' AND method='Transfer'"
    ).get().c;
    const txBefore = db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
    console.log(`[tx-backfill] transfer events in index: ${totalTransferEvents.toLocaleString('en-US')}`);
    console.log(`[tx-backfill] transactions table before:  ${txBefore.toLocaleString('en-US')}`);

    const insert = db.prepare(
        `INSERT OR IGNORE INTO transactions
           (hash, from_addr, to_addr, block, method, amount, numeric_amount, value, status, timestamp, event_index, block_hash, event_derived)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`
    );

    // Page through the transfer events by rowid so we never hold the whole
    // (potentially huge) result set in memory. We deliberately avoid
    // StatementSync.iterate() — it was added to node:sqlite AFTER Node 22.11,
    // which is what the backend container pins, so it throws there. Paging on
    // `rowid > ?` seeks straight into the table b-tree on each call, so the
    // whole run is still a single linear pass over events (not a re-scan).
    const READ_PAGE = Math.max(BATCH_SIZE, 5000);
    const page = db.prepare(
        `SELECT rowid AS rid, block, event_index AS eventIndex, data, timestamp, block_hash AS blockHash, status
           FROM events
          WHERE section='balances' AND method='Transfer' AND rowid > ?
          ORDER BY rowid
          LIMIT ?`
    );

    let scanned = 0, parsed = 0, unparseable = 0, inserted = 0;
    let batch = [];

    const flush = () => {
        if (!batch.length || DRY_RUN) { batch = []; return; }
        db.exec('BEGIN IMMEDIATE')  /* F-137: take the write lock up front */;
        try {
            for (const r of batch) {
                const res = insert.run(
                    r.hash, r.from, r.to, r.block, 'balances.Transfer',
                    r.amountDisplay, r.amountPdex, '-', r.status, r.timestamp,
                    r.eventIndex, r.blockHash
                );
                inserted += res.changes; // 0 if the row already existed
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        batch = [];
    };

    // Inserting into `transactions` never touches `events` rowids, so paging
    // the source table stays stable while we write.
    let lastRid = 0;
    for (;;) {
        const rows = page.all(lastRid, READ_PAGE);
        if (!rows.length) break;
        for (const ev of rows) {
            lastRid = ev.rid;
            scanned++;
            const t = parseTransfer(ev.data);
            if (!t) { unparseable++; continue; }
            parsed++;
            batch.push({
                // F-021: hash-keyed (falls back to the legacy number key
                // only when the event row genuinely has no hash).
                hash: eventTxId(ev.blockHash, ev.block, ev.eventIndex),
                from: t.from,
                to: t.to,
                block: ev.block,
                amountDisplay: formatAmountDisplay(t.amountPdex),
                amountPdex: t.amountPdex,
                status: ev.status || 'success',
                timestamp: ev.timestamp,
                eventIndex: ev.eventIndex,
                blockHash: ev.blockHash || '',
            });
            if (batch.length >= BATCH_SIZE) flush();
            if (scanned % 100000 === 0) {
                console.log(`[tx-backfill]   scanned ${scanned.toLocaleString('en-US')} transfer events, inserted ${inserted.toLocaleString('en-US')} so far`);
            }
        }
    }
    flush();

    const txAfter = DRY_RUN ? txBefore : db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c;
    db.close();

    console.log('');
    console.log('=== Transaction backfill summary ===');
    console.log(`Transfer events scanned:        ${scanned.toLocaleString('en-US')}`);
    console.log(`Parsed OK:                      ${parsed.toLocaleString('en-US')}`);
    console.log(`Unparseable (skipped):          ${unparseable.toLocaleString('en-US')}`);
    if (DRY_RUN) {
        console.log(`Would insert (new event-rows):  ${parsed.toLocaleString('en-US')} candidates (dedup applied on real run)`);
    } else {
        console.log(`Newly inserted into DB:         ${inserted.toLocaleString('en-US')}`);
        console.log(`Already present (no-op):        ${(parsed - inserted).toLocaleString('en-US')}`);
    }
    console.log(`transactions row count: ${txBefore.toLocaleString('en-US')} -> ${txAfter.toLocaleString('en-US')}`);
    console.log('');
    if (!DRY_RUN) {
        console.log(`The "Indexed transactions" KPI reads a cached count that the indexer`);
        console.log(`worker refreshes every ANALYTICS_COUNTS_REFRESH_MS (default 5 min),`);
        console.log(`so the dashboard will reflect the new total within a few minutes.`);
    }
}

try {
    run();
} catch (err) {
    console.error('[tx-backfill] FAILED:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
}
