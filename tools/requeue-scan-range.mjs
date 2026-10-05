#!/usr/bin/env node
//
// Queue a block range (or a list of blocks) for an indexer's gap-fill pass to
// re-scan. The operator repair path for data an indexer silently skipped —
// e.g. everything the governance, rewards and transfers scanners dropped while
// the RPC node was down (see deferTransientScan in server.js).
//
// Nothing is scanned here. Rows go into scan_failures at attempts = 0, and the
// RUNNING backend picks them up on its next ticks, SCAN_GAP_FILL_BATCH per
// indexer per tick (default 20). For a big range, raise it for the repair:
// SCAN_GAP_FILL_BATCH=500 in .env, `docker compose up -d backend`, and put it
// back afterwards.
//
// Safe to repeat: heights already queued keep their attempt count and error.
// Same SQL as the indexer itself (lib/scan-queue.js).
//
// Usage (inside the backend container, so it sees the same DATA_DIR):
//   docker compose exec backend node --experimental-sqlite tools/requeue-scan-range.mjs \
//       --indexer governance --from 13135000 --to 13170000 [--dry-run]
//   docker compose exec backend node --experimental-sqlite tools/requeue-scan-range.mjs \
//       --indexer governance --blocks 13141046,13146180
//
//   --indexer   governance | staking_rewards | transactions | chain_index
//   --from/--to inclusive range (max 200,000 heights per run)
//   --blocks    comma-separated heights instead of a range
//   --data-dir  defaults to $DATA_DIR, then ./data

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { queueRangeIfAbsent, queueOneIfAbsent, QUEUEABLE_INDEXERS } from '../lib/scan-queue.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const eq = argv.find(a => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1) || fallback;
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);
const die = (msg) => { console.error(msg); process.exit(1); };

if (has('--help') || has('-h')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n')
        .filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
    process.exit(0);
}

const MAX_RANGE = 200_000;
const indexer = flag('--indexer');
const dataDir = flag('--data-dir', process.env.DATA_DIR || './data');
const dryRun = has('--dry-run');
const dbPath = path.join(dataDir, 'explorer.db');

if (!QUEUEABLE_INDEXERS.includes(indexer)) die(`--indexer must be one of: ${QUEUEABLE_INDEXERS.join(', ')}`);
if (!fs.existsSync(dbPath)) die(`No database at ${dbPath}. Pass --data-dir, or set DATA_DIR.`);

const blocksArg = flag('--blocks');
const fromArg = flag('--from');
const toArg = flag('--to');
const isHeight = (s) => /^\d+$/.test(String(s)) && Number(s) >= 1 && Number.isSafeInteger(Number(s));

let list = null, from = null, to = null;
if (blocksArg) {
    list = blocksArg.split(',').map(s => s.trim()).filter(Boolean);
    const bad = list.filter(s => !isHeight(s));
    if (bad.length) die(`--blocks: not block heights: ${bad.join(', ')}`);
    list = [...new Set(list.map(Number))].sort((a, b) => a - b);
} else {
    if (!isHeight(fromArg) || !isHeight(toArg)) die('give --from and --to (block heights), or --blocks');
    from = Math.min(Number(fromArg), Number(toArg));
    to = Math.max(Number(fromArg), Number(toArg));
    if (to - from + 1 > MAX_RANGE) die(`range is ${to - from + 1} heights; max ${MAX_RANGE} per run — split it`);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 30000');   // the backend holds the writer lock in short bursts
const reason = `operator requeue (tools/requeue-scan-range.mjs) at ${new Date().toISOString()}`;
const count = (n) => n.toLocaleString('en-US');

const before = db.prepare('SELECT COUNT(*) AS c FROM scan_failures WHERE indexer = ?').get(indexer).c;
const what = list ? `${list.length} block(s)` : `${count(to - from + 1)} heights #${count(from)}–#${count(to)}`;

if (dryRun) {
    console.log(`[dry-run] would queue ${what} for ${indexer}; ${count(before)} row(s) already queued for it.`);
    process.exit(0);
}

let added = 0, already = 0;
if (list) {
    for (const b of list) queueOneIfAbsent(db, indexer, b, reason) ? added++ : already++;
} else {
    ({ added, alreadyQueued: already } = queueRangeIfAbsent(db, indexer, from, to, reason));
}
const after = db.prepare('SELECT COUNT(*) AS c FROM scan_failures WHERE indexer = ?').get(indexer).c;
console.log(`Queued ${what} for ${indexer}: ${count(added)} new, ${count(already)} already queued. Queue now ${count(after)}.`);
console.log(`The running backend drains ${process.env.SCAN_GAP_FILL_BATCH || 20} per tick for this indexer; watch "gap-fill:" lines in its log.`);
db.close();
