#!/usr/bin/env node
// One-off, out-of-band index migration for the Polkadex Explorer SQLite DB.
//
// WHY THIS IS A SEPARATE SCRIPT (and not in initDb)
//   Building an index on a large table is a single long write transaction: it
//   holds SQLite's write lock for the whole build and (with temp_store=MEMORY)
//   can spike RAM hard. Doing that synchronously inside server startup jammed
//   every cluster worker's db.exec(SCHEMA) on the write lock so none reached
//   app.listen — i.e. it took the whole site down at boot on the 20 GB+ DB.
//   Index creation belongs off the serving path: run this once, manually.
//
// WHAT IT BUILDS
//   idx_tx_timestamp     ON transactions(timestamp)
//   idx_blocks_timestamp ON blocks(timestamp)
//   These make the analytics daily aggregates (getDailyAnalytics) index range
//   scans instead of full-table scans. Everything works without them — just
//   slower on the timeseries pre-warm — so there's no rush and no risk in
//   running it during quiet traffic.
//
// SAFETY
//   * CREATE INDEX IF NOT EXISTS — safe to re-run; a completed index is a no-op.
//   * temp_store=FILE + a bounded mmap so the build spills sort runs to disk
//     instead of ballooning RAM.
//   * It WILL hold the write lock while each index builds, which briefly pauses
//     the indexer's writes (reads/serving are unaffected under WAL). Run it when
//     the indexer isn't mid-heavy-backfill if you want to be gentle.
//
// USAGE
//   docker compose exec backend node --experimental-sqlite migrate-add-indexes.mjs
//   # or against an explicit path:
//   node --experimental-sqlite migrate-add-indexes.mjs --db /app/data/explorer.db

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import process from 'node:process';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return (i > -1 && i + 1 < process.argv.length) ? process.argv[i + 1] : fallback;
}

const DB_PATH = arg('db', process.env.INDEX_MIGRATION_DB_PATH || '/app/data/explorer.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Pass --db <path> or set INDEX_MIGRATION_DB_PATH.`);
    process.exit(2);
}

const INDEXES = [
    ['idx_tx_timestamp', 'CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp)'],
    ['idx_blocks_timestamp', 'CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)'],
];

console.log(`[index-migrate] DB: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);
// Keep the build off the RAM path — spill temp sort runs to disk.
db.exec('PRAGMA temp_store = FILE');
db.exec('PRAGMA busy_timeout = 60000');

const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
);

for (const [name, ddl] of INDEXES) {
    if (existing.has(name)) {
        console.log(`[index-migrate] ${name} already present — skipping.`);
        continue;
    }
    const t0 = Date.now();
    process.stdout.write(`[index-migrate] building ${name} … `);
    try {
        db.exec(ddl);
        console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
        console.log('FAILED');
        console.error(`[index-migrate] ${name} failed:`, e.message);
        process.exitCode = 1;
    }
}

db.close();
console.log('[index-migrate] complete.');
