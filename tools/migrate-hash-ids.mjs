#!/usr/bin/env node
//
// Operator path for the F-021 hash-keyed id migration.  (Audit F-182)
//
// The migration also runs automatically on indexer boot, and since F-182 it is
// chunked and resumable so it can no longer hold the write lock for minutes at
// a time. This script exists for the cases where you want to run it
// DELIBERATELY rather than have it happen during a deploy:
//
//   * a very large index, where you would rather spend the time in a chosen
//     maintenance window than during the first tick after a release;
//   * a run that was interrupted and you want to finish before starting the
//     backend, so the indexer boots with nothing left to do;
//   * checking what it WOULD do, with --dry-run, before touching anything.
//
// It is the same code path the indexer uses — imported, not reimplemented — so
// there is no second copy of the SQL to drift (the F-045 lesson).
//
// Usage:
//   node tools/migrate-hash-ids.mjs [--data-dir DIR] [--chunk N] [--dry-run]
//
//   --data-dir  defaults to $DATA_DIR, then ./data
//   --chunk     block heights per transaction (default 250000). Smaller = more
//               commits, shorter individual locks, slightly slower overall.
//   --dry-run   report what is pending and exit without writing.
//
// SAFETY: take a backup first. This deletes fork-inconsistent rows by design —
// see the header of lib/id-migration.js for why that is the correct behaviour
// and not data loss.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { migrateHashKeyedIds } from '../lib/id-migration.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const dataDir = flag('--data-dir', process.env.DATA_DIR || './data');
const chunkBlocks = Number(flag('--chunk', '250000'));
const dryRun = has('--dry-run');
const dbPath = path.join(dataDir, 'explorer.db');

if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Pass --data-dir, or set DATA_DIR.`);
    process.exit(1);
}
if (!Number.isFinite(chunkBlocks) || chunkBlocks < 1) {
    console.error(`--chunk must be a positive integer, got ${flag('--chunk')}`);
    process.exit(1);
}

const db = new DatabaseSync(dbPath);

// A generous timeout, because this is the deliberate path: if the indexer is
// running we would rather wait for it than fail. The in-process migration uses
// the server's own 5s and retries (F-181) instead.
db.exec('PRAGMA busy_timeout = 60000');
db.exec('PRAGMA journal_mode = WAL');

const kvGet = (key) => {
    try {
        const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
        return row && row.value ? JSON.parse(row.value) : null;
    } catch (_) { return null; }
};
const kvSet = (key, value) => {
    db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(value), Date.now());
};

const done = kvGet('migration:hash-keyed-ids');
if (done && done.completedAt) {
    console.log(`Already completed at ${new Date(done.completedAt).toISOString()}. Nothing to do.`);
    console.log(JSON.stringify(done, null, 2));
    process.exit(0);
}

// What is pending, without writing anything.
const pending = {
    legacyTx: db.prepare(`SELECT COUNT(*) c FROM transactions
        WHERE event_derived = 1 AND block_hash LIKE '0x%' AND event_index IS NOT NULL
          AND hash LIKE 'event-%' AND hash NOT LIKE 'event-0x%'`).get().c,
    legacyRewards: db.prepare(`SELECT COUNT(*) c FROM staking_rewards
        WHERE block_hash LIKE '0x%' AND event_index IS NOT NULL AND id NOT LIKE '0x%'`).get().c,
    events: db.prepare('SELECT COUNT(*) c FROM events').get().c,
    resumeFrom: (kvGet('migration:hash-keyed-ids:progress') || {}).forkDeleteCursor ?? null
};
console.log(`Database: ${dbPath}`);
console.log(`Pending:  ${pending.legacyTx} legacy tx ids, ${pending.legacyRewards} legacy reward ids`);
console.log(`Scope:    ${pending.events} event rows to check for fork consistency`);
if (pending.resumeFrom != null) console.log(`Resuming: from block ${pending.resumeFrom}`);
console.log(`Chunk:    ${chunkBlocks} block heights per transaction`);

if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    process.exit(0);
}

const started = Date.now();
let lastLog = 0;
const progress = {
    get: (k) => (kvGet('migration:hash-keyed-ids:progress') || {})[k],
    set: (k, v) => kvSet('migration:hash-keyed-ids:progress', {
        ...(kvGet('migration:hash-keyed-ids:progress') || {}), [k]: v
    })
};

try {
    const r = migrateHashKeyedIds(db, {
        chunkBlocks,
        progress,
        onProgress: (info) => {
            // One line every few seconds, not one per chunk.
            if (Date.now() - lastLog < 3000) return;
            lastLog = Date.now();
            const pct = info.hi ? Math.min(100, Math.round((info.to / info.hi) * 100)) : 0;
            console.log(`  … block ${info.to}/${info.hi} (${pct}%) — ` +
                `${info.forkEventsDeleted} events, ${info.forkTxDeleted} tx, ${info.forkRewardsDeleted} rewards removed`);
        }
    });
    kvSet('migration:hash-keyed-ids', { ...r, completedAt: Date.now() });
    kvSet('migration:hash-keyed-ids:progress', {});
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\nDone in ${secs}s over ${r.chunks} chunk(s):`);
    console.log(`  ${r.txRewritten} tx ids rewritten, ${r.txDuplicatesDeleted} duplicates removed`);
    console.log(`  ${r.rewardRewritten} reward ids rewritten, ${r.rewardDuplicatesDeleted} duplicates removed`);
    console.log(`  fork-inconsistent rows deleted: ${r.forkEventsDeleted} events, ${r.forkTxDeleted} tx, ${r.forkRewardsDeleted} rewards`);
    console.log('\nThe indexer will now skip this migration on boot.');
} catch (err) {
    console.error('\nMigration failed:', err && err.message ? err.message : err);
    console.error('Progress is saved — re-running resumes from the last committed chunk.');
    process.exit(1);
} finally {
    db.close();
}
