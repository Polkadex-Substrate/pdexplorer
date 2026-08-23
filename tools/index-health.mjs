// Read-only index health measurement.
//
// The 2026-08 audit's indexer findings (F-004, F-005, F-046, F-050, F-006,
// F-008, F-009, F-010, F-048, F-113) all share one dependency: nobody knows
// how much data is actually missing. SQLite can report "Synced" while rows
// are absent, because the watermark can advance past heights that failed.
// This script answers "how bad is it?" so the repair work can be scoped
// instead of guessed.
//
// STRICTLY READ-ONLY. Opens the database read-only where the Node build
// supports it, runs SELECTs only, and never writes a row or a kv key.
//
// Usage (from the deploy dir, inside the backend container so the path and
// the node binary are both guaranteed to exist):
//
//     docker compose exec backend node --experimental-sqlite \
//         tools/index-health.mjs
//
// Add --gaps to also list concrete missing ranges. That query is a window
// scan over the whole blocks table (audit F-047 flags the same pattern as
// heavy) so it is opt-in, capped, and best run off-peak.
//
//     docker compose exec backend node --experimental-sqlite \
//         tools/index-health.mjs --gaps
//
// If tools/ isn't in the image yet (Dockerfile.backend copies an explicit
// file list), pipe it in instead:
//
//     docker compose exec -T backend node --experimental-sqlite - < tools/index-health.mjs

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DATA_DIR  = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH   = path.join(DATA_DIR, 'explorer.db');
const WANT_GAPS = process.argv.includes('--gaps');
const GAP_LIMIT = Number(process.env.GAP_LIMIT || 40);

// SCAN_MAX_ATTEMPTS is the point at which the indexer stops retrying a block
// and getScanFailures() drops it from the replay queue — i.e. a permanent
// hole that no longer affects the reported status (audit F-050).
const SCAN_MAX_ATTEMPTS = Number(process.env.SCAN_MAX_ATTEMPTS || 10);

// readOnly landed in a later Node 22 patch than the image may carry; fall
// back to a normal open (this script issues no writes either way).
let db;
try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch (e) {
    db = new DatabaseSync(DB_PATH);
    console.warn('note: read-only open unsupported here; opened normally (no writes are issued)\n');
}

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const n   = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
const hr  = (t) => `\n${'─'.repeat(72)}\n${t}\n`;

console.log(`Index health — ${DB_PATH}`);
console.log(`Measured at ${new Date().toISOString()}`);

// ── 1. Watermarks, per indexer ──────────────────────────────────────────────
// Every indexer stores its progress as JSON under kv key 'sync:<name>'.
// Dump them all rather than assuming which exist.
console.log(hr('1. WATERMARKS (kv "sync:*")'));
const syncRows = all(`SELECT key, value, updated_at FROM kv WHERE key LIKE 'sync:%' ORDER BY key`);
const watermarks = {};
for (const row of syncRows) {
    let v = {};
    try { v = JSON.parse(row.value || '{}'); } catch (_) { /* keep raw below */ }
    const name = row.key.replace(/^sync:/, '');
    watermarks[name] = v;
    const last = v.lastSync ? new Date(Number(v.lastSync)).toISOString() : '—';
    console.log(`  ${name}`);
    console.log(`      status              ${v.status ?? '—'}`);
    console.log(`      latestScannedBlock  ${n(v.latestScannedBlock)}`);
    console.log(`      oldestScannedBlock  ${n(v.oldestScannedBlock)}`);
    console.log(`      lastSync            ${last}`);
    if (!Object.keys(v).length) console.log(`      raw                 ${row.value}`);
}
if (!syncRows.length) console.log('  (none — fresh database?)');

// ── 2. Blocks table: is the range actually filled? ──────────────────────────
// COUNT(*) walks the primary-key index; on a large table this is the slow
// step of this script (seconds to low minutes), but it is the number the
// whole indexer discussion hinges on.
console.log(hr('2. BLOCKS TABLE vs WATERMARK'));
const b = one(`SELECT COUNT(*) AS cnt, MIN(number) AS lo, MAX(number) AS hi FROM blocks`);
console.log(`  rows stored           ${n(b.cnt)}`);
console.log(`  MIN(number)           ${n(b.lo)}`);
console.log(`  MAX(number)           ${n(b.hi)}`);

const ci = watermarks.chain_index || {};
if (b.cnt > 0 && ci.latestScannedBlock != null) {
    // The window the indexer CLAIMS to have scanned. oldestScannedBlock is
    // the backfill floor; fall back to the table's own MIN when absent.
    const lo = Number(ci.oldestScannedBlock ?? b.lo);
    const hi = Number(ci.latestScannedBlock);
    const span = hi - lo + 1;
    const missing = span - b.cnt;
    const pct = span > 0 ? (missing / span * 100) : 0;
    console.log(`\n  claimed scanned range ${n(lo)} … ${n(hi)}  (${n(span)} heights)`);
    console.log(`  rows present          ${n(b.cnt)}`);
    console.log(`  MISSING              ${missing > 0 ? n(missing) : '0'}  (${pct.toFixed(4)}% of the claimed range)`);
    if (missing > 0) {
        console.log('\n  → The watermark claims heights the table does not contain.');
        console.log('    That is audit F-004 (watermark advanced past failures) and/or');
        console.log('    F-006 (a null event set stored as success). Re-run with --gaps');
        console.log('    to see where.');
    } else if (missing < 0) {
        console.log('\n  → More rows than the claimed span: the table extends outside');
        console.log('    [oldest…latest]. Check MIN/MAX above against the watermark.');
    } else {
        console.log('\n  → No missing heights inside the claimed range.');
    }
    if (b.hi < hi) {
        console.log(`\n  NOTE: MAX(number) trails latestScannedBlock by ${n(hi - b.hi)} — the`);
        console.log('        newest claimed blocks were never stored (F-048 / F-113 anchor-at-head).');
    }
}

// ── 3. scan_failures: retryable vs permanently abandoned ────────────────────
console.log(hr(`3. SCAN FAILURES (permanent = attempts >= ${SCAN_MAX_ATTEMPTS})`));
const failSummary = all(`
    SELECT indexer,
           COUNT(*)                                        AS total,
           SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END)   AS permanent,
           MIN(block)                                      AS lo,
           MAX(block)                                      AS hi
      FROM scan_failures
     GROUP BY indexer
     ORDER BY permanent DESC, total DESC`, SCAN_MAX_ATTEMPTS);

if (!failSummary.length) {
    console.log('  none recorded.');
    console.log('  NOTE: an empty table is NOT proof of a clean index — audit F-004');
    console.log('  is precisely that failed heights were skipped WITHOUT being');
    console.log('  written here. Trust section 2 over this section.');
} else {
    for (const r of failSummary) {
        console.log(`  ${r.indexer}: ${n(r.total)} total, ${n(r.permanent)} PERMANENT, blocks ${n(r.lo)}…${n(r.hi)}`);
    }
    const worst = all(`
        SELECT indexer, block, attempts, last_error, last_at
          FROM scan_failures
         WHERE attempts >= ?
         ORDER BY attempts DESC, block ASC
         LIMIT 15`, SCAN_MAX_ATTEMPTS);
    if (worst.length) {
        console.log(`\n  Permanently abandoned (audit F-050 — silent holes while status says Synced):`);
        for (const r of worst) {
            const when = r.last_at ? new Date(Number(r.last_at)).toISOString().slice(0, 19) : '—';
            const err = String(r.last_error || '').replace(/\s+/g, ' ').slice(0, 90);
            console.log(`    ${r.indexer} #${n(r.block)}  attempts=${r.attempts}  ${when}  ${err}`);
        }
    }
}

// ── 4. Concrete gap ranges (opt-in; heavier) ────────────────────────────────
if (WANT_GAPS) {
    console.log(hr(`4. GAP RANGES (first ${GAP_LIMIT}, interior only)`));
    console.log('  Window scan over blocks — this is the expensive query.\n');
    // LEAD finds holes BETWEEN two stored rows. Audit F-005: it is blind to a
    // missing prefix or suffix, which is why sections 2 and 5 exist.
    const gaps = all(`
        WITH seq AS (
            SELECT number, LEAD(number) OVER (ORDER BY number) AS nxt FROM blocks
        )
        SELECT number + 1 AS gap_start, nxt - 1 AS gap_end, nxt - number - 1 AS gap_len
          FROM seq
         WHERE nxt IS NOT NULL AND nxt - number > 1
         ORDER BY gap_len DESC
         LIMIT ?`, GAP_LIMIT);
    if (!gaps.length) {
        console.log('  no interior gaps.');
    } else {
        let tot = 0;
        for (const g of gaps) {
            tot += g.gap_len;
            console.log(`    ${n(g.gap_start)} … ${n(g.gap_end)}   (${n(g.gap_len)} blocks)`);
        }
        console.log(`\n  ${gaps.length} largest gaps shown, ${n(tot)} blocks between them.`);
        console.log('  (Interior only — a missing PREFIX or SUFFIX is invisible here: F-005.)');
    }

    // The prefix/suffix blind spot, measured explicitly.
    console.log(hr('5. PREFIX / SUFFIX (the F-005 blind spot)'));
    if (ci.oldestScannedBlock != null && b.lo != null && Number(ci.oldestScannedBlock) < Number(b.lo)) {
        console.log(`  MISSING PREFIX: watermark floor ${n(ci.oldestScannedBlock)} < MIN(number) ${n(b.lo)}`);
        console.log(`                  → ${n(Number(b.lo) - Number(ci.oldestScannedBlock))} blocks never stored at the bottom.`);
    } else {
        console.log('  prefix: consistent with the backfill floor.');
    }
    if (ci.latestScannedBlock != null && b.hi != null && Number(ci.latestScannedBlock) > Number(b.hi)) {
        console.log(`  MISSING SUFFIX: latestScannedBlock ${n(ci.latestScannedBlock)} > MAX(number) ${n(b.hi)}`);
        console.log(`                  → ${n(Number(ci.latestScannedBlock) - Number(b.hi))} blocks never stored at the top.`);
    } else {
        console.log('  suffix: consistent with the forward watermark.');
    }
} else {
    console.log(hr('4. GAP RANGES'));
    console.log('  skipped — re-run with --gaps for concrete ranges (heavier query).');
}

db.close();
console.log(`\n${'─'.repeat(72)}`);
console.log('Read-only: no rows, kv keys, or watermarks were modified.');
