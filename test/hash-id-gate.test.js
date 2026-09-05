// F-182 — the hash-keyed id rewrite must not ambush a boot.
//
// The rewrite is one BEGIN IMMEDIATE per table, so on a database with real
// legacy history it holds the SQLite write lock for the whole pass — at indexer
// boot, before the indexer may start, with no way to decline. On a fresh
// install it is zero rows and invisible. The code had no way to tell those
// apart because it never counted first.
//
// Same trade as the analytics indexes (F-088/F-138): under the ceiling, do it
// inline and say nothing; over it, DON'T, record why, and hand the operator a
// command for a window they choose. The indexer still starts either way — a
// deferred migration is a degraded index, not a dead site, and refusing to boot
// would turn a maintenance task into an outage.
//
// The other half of the finding was that the documented operator command could
// not work: `docker compose exec backend node … tools/migrate-hash-ids.mjs`
// runs inside an image that never COPYed tools/. Documenting a path that errors
// is worse than documenting none, because the operator stops looking.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { countHashKeyedIdCandidates } from '../lib/id-migration.js';

const dirs = [];
function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-hid-'));
    dirs.push(dir);
    return dir;
}
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// Minimal shape: just the columns the predicates touch.
function dbWith({ legacyTx = 0, modernTx = 0, legacyRewards = 0, modernRewards = 0 }) {
    const d = new DatabaseSync(path.join(scratch(), 't.db'));
    d.exec(`CREATE TABLE transactions (hash TEXT PRIMARY KEY, block_hash TEXT, event_index INTEGER, event_derived INTEGER)`);
    d.exec(`CREATE TABLE staking_rewards (id TEXT PRIMARY KEY, block_hash TEXT, event_index INTEGER)`);
    const tx = d.prepare('INSERT INTO transactions(hash,block_hash,event_index,event_derived) VALUES(?,?,?,?)');
    for (let i = 0; i < legacyTx; i++) tx.run(`event-${1000 + i}-0`, '0x' + 'a'.repeat(64), i, 1);
    for (let i = 0; i < modernTx; i++) tx.run(`event-0x${'b'.repeat(64)}-${i}`, '0x' + 'b'.repeat(64), i, 1);
    const rw = d.prepare('INSERT INTO staking_rewards(id,block_hash,event_index) VALUES(?,?,?)');
    for (let i = 0; i < legacyRewards; i++) rw.run(`${2000 + i}-0-${i}`, '0x' + 'c'.repeat(64), i);
    for (let i = 0; i < modernRewards; i++) rw.run(`0x${'d'.repeat(64)}-${i}`, '0x' + 'd'.repeat(64), i);
    return d;
}

describe('F-182 — the size gate counts what the migration would rewrite', () => {
    test('a clean database has nothing pending', () => {
        const c = countHashKeyedIdCandidates(dbWith({ modernTx: 25, modernRewards: 25 }));
        assert.deepEqual(c, { transactions: 0, stakingRewards: 0, total: 0 });
    });

    test('legacy rows are counted, modern ones are not', () => {
        const c = countHashKeyedIdCandidates(dbWith({ legacyTx: 7, modernTx: 3, legacyRewards: 5, modernRewards: 2 }));
        assert.deepEqual(c, { transactions: 7, stakingRewards: 5, total: 12 });
    });

    test('an empty database is zero, not an error', () => {
        assert.equal(countHashKeyedIdCandidates(dbWith({})).total, 0);
    });

    test('the count predicates match the migration predicates EXACTLY', () => {
        // This is the load-bearing assertion. If the counter sizes a different
        // population than the rewriter touches, the gate defers work that is
        // small or runs work that is huge — and both look fine in a log.
        const src = fs.readFileSync(new URL('../lib/id-migration.js', import.meta.url), 'utf8');
        const norm = (s) => s.replace(/\s+/g, ' ').trim();

        const counter = norm(src.slice(src.indexOf('export function countHashKeyedIdCandidates'),
                                      src.indexOf('export function migrateHashKeyedIds')));
        const migrator = norm(src.slice(src.indexOf('export function migrateHashKeyedIds')));

        for (const clause of [
            "event_derived = 1 AND block_hash LIKE '0x%' AND event_index IS NOT NULL AND hash LIKE 'event-%' AND hash NOT LIKE 'event-0x%'",
            "block_hash LIKE '0x%' AND event_index IS NOT NULL AND id NOT LIKE '0x%'"
        ]) {
            assert.ok(counter.includes(clause), `the counter lost the predicate: ${clause}`);
            assert.ok(migrator.includes(clause), `the migration no longer uses: ${clause}`);
        }
    });

    test('counting takes no write lock', () => {
        // It runs at boot on every database, including huge ones. A write lock
        // here would recreate the stall the gate exists to avoid.
        const src = fs.readFileSync(new URL('../lib/id-migration.js', import.meta.url), 'utf8');
        const fn = src.slice(src.indexOf('export function countHashKeyedIdCandidates'),
                             src.indexOf('export function migrateHashKeyedIds'));
        for (const w of ['UPDATE', 'DELETE', 'INSERT', 'BEGIN']) {
            assert.ok(!fn.includes(w), `the counter performs a ${w} — it must be read-only`);
        }
    });
});

describe('F-182 — boot defers instead of stalling', () => {
    const dbSrc = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');

    test('boot counts before it rewrites', () => {
        assert.match(dbSrc, /const pending = countHashKeyedIdCandidates\(db\);/);
        const at = dbSrc.indexOf('const pending = countHashKeyedIdCandidates(db);');
        const migrateAt = dbSrc.indexOf('const r = migrateHashKeyedIds(db, {');
        assert.ok(at > 0 && migrateAt > at, 'the rewrite still runs before anything is counted');
    });

    test('over the ceiling it does NOT migrate', () => {
        assert.match(dbSrc, /if \(pending\.total > HASH_ID_INLINE_MAX\) \{/);
        const at = dbSrc.indexOf('if (pending.total > HASH_ID_INLINE_MAX) {');
        const branch = dbSrc.slice(at, dbSrc.indexOf('} else {', at));
        assert.ok(!branch.includes('migrateHashKeyedIds('),
            'the deferral branch still calls the migration — chunked-on-boot is explicitly not the close test');
    });

    test('the deferral is recorded and readable, not just logged', () => {
        assert.match(dbSrc, /setKv\('migration:hash-keyed-ids:deferred', state\)/);
        const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        assert.match(srv, /db\.getKv\('migration:hash-keyed-ids:deferred'\)/,
            '/api/diag/schema does not report the deferral, so nobody can ask');
        assert.match(srv, /hashKeyedIdMigration: hashIds \|\| \{ deferred: false \}/);
    });

    test('the deferral names the command AND the consequence', () => {
        const at = dbSrc.indexOf("setKv('migration:hash-keyed-ids:deferred'");
        const block = dbSrc.slice(at - 900, at + 1600);
        assert.match(block, /tools\/migrate-hash-ids\.mjs/, 'the operator is not told what to run');
        assert.match(block, /a reorg at those heights is not detected/,
            'the operator is not told what deferring costs them');
    });

    test('the marker is cleared once the migration completes', () => {
        // Otherwise a database that was deferred and later migrated keeps
        // reporting outstanding work for ever.
        assert.match(dbSrc, /setKv\('migration:hash-keyed-ids:deferred', null\)/);
    });

    test('the ceiling is at module scope and configurable', () => {
        // F-199: a function-local const is invisible to its callers.
        assert.match(dbSrc, /^const HASH_ID_INLINE_MAX = Number\(process\.env\.HASH_ID_INLINE_MAX\)/m);
    });
});

describe('F-182 — the documented operator path can actually run', () => {
    test('the backend image ships tools/', () => {
        // The command in INSTALL runs inside THIS image. Without this COPY it
        // fails with a missing-module error, the operator gives up, the flag
        // stays unset, and the next boot does the full-table rewrite anyway —
        // which is the exact outcome the documentation was meant to prevent.
        const df = fs.readFileSync(new URL('../Dockerfile.backend', import.meta.url), 'utf8');
        assert.match(df, /^COPY --chown=node:node tools \.\/tools$/m,
            'the backend image does not contain tools/, so the documented command cannot work');
    });

    test('INSTALL documents the command that image can run', () => {
        const install = fs.readFileSync(new URL('../INSTALL.md', import.meta.url), 'utf8');
        assert.match(install, /docker compose exec backend node --experimental-sqlite tools\/migrate-hash-ids\.mjs/);
    });

    test('the script imports the same module the indexer uses', () => {
        // "Imported, not reimplemented" — a second copy of the migration is how
        // F-060/F-133/F-198 each happened. The relative path only resolves
        // because tools/ and lib/ are siblings in the image.
        const tool = fs.readFileSync(new URL('../tools/migrate-hash-ids.mjs', import.meta.url), 'utf8');
        assert.match(tool, /import \{ migrateHashKeyedIds \} from '\.\.\/lib\/id-migration\.js';/);
    });

    test('--chunk accepts both argument forms', () => {
        // `--chunk=100000` silently fell back to the default. In a maintenance
        // window, on a migration, with no error.
        const tool = fs.readFileSync(new URL('../tools/migrate-hash-ids.mjs', import.meta.url), 'utf8');
        assert.match(tool, /const eq = argv\.find\(a => a\.startsWith\(name \+ '='\)\);/);
    });
});
