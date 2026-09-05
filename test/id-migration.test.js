// Tests for lib/id-migration.js — audit F-021, run against a REAL SQLite
// database (node:sqlite in-memory) using the production schema for the three
// affected tables, including the triggers that maintain table_counts. The
// audit's exact worry is "changing only the writer duplicates rows or leaves
// orphans in place", so the scenarios below are stated in those terms.

import { test, describe, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateHashKeyedIds, deleteForkRows, purgeLegacyExtrinsicKeyedTx } from '../lib/id-migration.js';

const CANON = '0x' + 'c'.repeat(64);
const ORPHAN = '0x' + 'f'.repeat(64);

function freshDb() {
    const db = new DatabaseSync(':memory:');
    // The production shape for the three tables + counters (db.js SCHEMA).
    db.exec(`
        CREATE TABLE transactions (
          hash TEXT PRIMARY KEY, from_addr TEXT, to_addr TEXT, block INTEGER,
          method TEXT, amount TEXT, numeric_amount REAL, value TEXT, status TEXT,
          timestamp INTEGER, event_index INTEGER, block_hash TEXT, event_derived INTEGER
        );
        CREATE TABLE events (
          hash TEXT PRIMARY KEY, tx_hash TEXT, block_hash TEXT, block INTEGER,
          event_index INTEGER, extrinsic_index INTEGER, section TEXT, method TEXT,
          data TEXT, signer_address TEXT, signer_name TEXT, timestamp INTEGER, status TEXT
        );
        CREATE TABLE staking_rewards (
          id TEXT PRIMARY KEY, stash TEXT, amount REAL, era INTEGER, validator TEXT,
          block INTEGER, block_hash TEXT, event_index INTEGER, timestamp INTEGER
        );
        CREATE TABLE blocks (
          number INTEGER PRIMARY KEY, hash TEXT, author_address TEXT, author_name TEXT,
          extrinsics_count INTEGER, events_count INTEGER, timestamp INTEGER
        );
        CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER);
        INSERT INTO table_counts VALUES ('transactions', 0), ('events', 0);
        CREATE TRIGGER tx_ins AFTER INSERT ON transactions BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'transactions'; END;
        CREATE TRIGGER tx_del AFTER DELETE ON transactions BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'transactions'; END;
        CREATE TRIGGER ev_ins AFTER INSERT ON events BEGIN UPDATE table_counts SET n = n + 1 WHERE name = 'events'; END;
        CREATE TRIGGER ev_del AFTER DELETE ON events BEGIN UPDATE table_counts SET n = n - 1 WHERE name = 'events'; END;
    `);
    return db;
}

const insTx = (db, hash, block, eventIndex, blockHash, derived = 1) =>
    db.prepare(`INSERT INTO transactions(hash, block, event_index, block_hash, event_derived, from_addr) VALUES(?,?,?,?,?,'5X')`)
      .run(hash, block, eventIndex, blockHash, derived);
const insReward = (db, id, block, eventIndex, blockHash) =>
    db.prepare(`INSERT INTO staking_rewards(id, block, event_index, block_hash, stash) VALUES(?,?,?,?,'5S')`)
      .run(id, block, eventIndex, blockHash);
const insBlock = (db, number, hash) =>
    db.prepare('INSERT INTO blocks(number, hash) VALUES(?,?)').run(number, hash);
const insEvent = (db, hash, block, blockHash) =>
    db.prepare(`INSERT INTO events(hash, block, block_hash, section, method) VALUES(?,?,?,'balances','Transfer')`)
      .run(hash, block, blockHash);

let db;
beforeEach(() => { db = freshDb(); });

describe('migrateHashKeyedIds — the PK rewrite', () => {
    test('a legacy event-derived tx id becomes hash-keyed', () => {
        insTx(db, 'event-100-3', 100, 3, CANON);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.txRewritten, 1);
        const row = db.prepare('SELECT hash FROM transactions').get();
        assert.equal(row.hash, `event-${CANON}-3`);
    });

    test('the F-021 duplicate pair collapses to the hash-keyed row', () => {
        // The state the audit warns writer-only change creates: a number-keyed
        // orphan AND a hash-keyed canonical row for the same coordinates.
        insTx(db, 'event-100-3', 100, 3, ORPHAN);            // legacy orphan
        insTx(db, `event-${CANON}-3`, 100, 3, CANON);        // new-writer row
        // The legacy row's rewrite target would be event-<ORPHAN>-3 — no
        // collision — so build the true collision case too:
        insTx(db, 'event-200-5', 200, 5, CANON);             // legacy…
        insTx(db, `event-${CANON}-5`, 200, 5, CANON);        // …and its twin
        const out = migrateHashKeyedIds(db);
        assert.equal(out.txDuplicatesDeleted, 1, 'the collided legacy row must be deleted');
        const ids = db.prepare('SELECT hash FROM transactions ORDER BY hash').all().map(r => r.hash);
        assert.ok(!ids.includes('event-200-5'), 'legacy duplicate survived');
        assert.ok(ids.includes(`event-${CANON}-5`));
        assert.ok(ids.includes(`event-${ORPHAN}-3`), 'non-colliding legacy row should be rewritten, not deleted');
    });

    test('rows with no usable hash keep their legacy ids', () => {
        insTx(db, 'event-100-3', 100, 3, null);
        insTx(db, 'event-100-4', 100, 4, '');
        const out = migrateHashKeyedIds(db);
        assert.equal(out.txRewritten, 0);
        assert.equal(out.txDuplicatesDeleted, 0);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 2);
    });

    test('a NULL event_index cannot mint a NULL primary key', () => {
        // SQLite's TEXT PK accepts NULL (long-standing quirk), and
        // 'x' || NULL is NULL — without the guard this row's PK would BE null.
        insTx(db, 'event-100-null', 100, null, CANON);
        migrateHashKeyedIds(db);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE hash IS NULL').get().c, 0);
        assert.equal(db.prepare('SELECT hash FROM transactions').get().hash, 'event-100-null');
    });

    test('extrinsic-hash-keyed rows (event_derived=0) are not REWRITTEN', () => {
        // Still true, and still the right assertion for this function: every
        // clause in migrateHashKeyedIds is gated on event_derived = 1, so a
        // legacy row is not its business.
        //
        // That gating is also exactly why those rows survived to become F-049.
        // Deleting them is purgeLegacyExtrinsicKeyedTx's job, tested below —
        // deliberately a separate function, because this one sits behind a
        // one-shot kv flag that every existing database has already set.
        insTx(db, '0x' + 'e'.repeat(64), 100, 0, CANON, 0);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.txRewritten, 0);
    });

    test('reward ids migrate the same way', () => {
        insReward(db, '100-2', 100, 2, CANON);                 // legacy
        insReward(db, '300-7', 300, 7, CANON);                 // legacy…
        insReward(db, `${CANON}-7`, 300, 7, CANON);            // …with a twin
        insReward(db, '400-1', 400, 1, null);                  // no hash
        const out = migrateHashKeyedIds(db);
        assert.equal(out.rewardRewritten, 1);
        assert.equal(out.rewardDuplicatesDeleted, 1);
        const ids = db.prepare('SELECT id FROM staking_rewards ORDER BY id').all().map(r => r.id);
        assert.deepEqual(ids.sort(), [`${CANON}-2`, `${CANON}-7`, '400-1'].sort());
    });

    test('idempotent: a second run changes nothing', () => {
        insTx(db, 'event-100-3', 100, 3, CANON);
        insReward(db, '100-2', 100, 2, CANON);
        migrateHashKeyedIds(db);
        const again = migrateHashKeyedIds(db);
        const { chunks, ...work } = again;   // chunks counts passes, not changes
        assert.deepEqual(work, {
            txRewritten: 0, txDuplicatesDeleted: 0, rewardRewritten: 0, rewardDuplicatesDeleted: 0,
            forkEventsDeleted: 0, forkTxDeleted: 0, forkRewardsDeleted: 0
        });
        assert.ok(chunks >= 1, 'the chunk walk should still have run, finding nothing to do');
    });

    test('F-182: chunking covers every height, including tx-only ones', () => {
        // The chunk bounds must span transactions and staking_rewards, not
        // just events. My first version read MIN/MAX from `events` alone and
        // these tests caught it: a transaction at a height with NO events row
        // (an incomplete scan, or F-006's undecodable-events case) fell outside
        // every chunk, so its fork-delete silently never ran. A performance
        // change that quietly narrows correctness is the worst kind.
        insBlock(db, 900, CANON);
        insTx(db, `event-${ORPHAN}-1`, 900, 1, ORPHAN);      // fork tx, no event row
        insReward(db, `${ORPHAN}-2`, 900, 2, ORPHAN);        // fork reward, no event row
        const out = migrateHashKeyedIds(db, { chunkBlocks: 10 });
        assert.equal(out.forkTxDeleted, 1, 'a tx-only height was skipped by the chunk walk');
        assert.equal(out.forkRewardsDeleted, 1, 'a reward-only height was skipped by the chunk walk');
    });

    test('F-182: a tiny chunk size produces the same result as one big pass', () => {
        // The whole safety argument for chunking is that it changes only the
        // lock duration, never the outcome.
        insBlock(db, 1000, CANON);
        insBlock(db, 5000, CANON);
        insEvent(db, `${ORPHAN}-0`, 1000, ORPHAN);
        insTx(db, `event-${ORPHAN}-1`, 5000, 1, ORPHAN);
        const chunked = migrateHashKeyedIds(db, { chunkBlocks: 1 });
        assert.equal(chunked.forkEventsDeleted, 1);
        assert.equal(chunked.forkTxDeleted, 1);
        assert.ok(chunked.chunks > 1, 'chunkBlocks: 1 should produce many passes');
    });

    test('F-182: a resume cursor skips the range already cleared', () => {
        // An interrupted migration must not restart from the bottom. The
        // cursor is persisted AFTER each commit, so a crash costs one repeated
        // (idempotent) chunk rather than skipping one.
        insBlock(db, 2000, CANON);
        insTx(db, `event-${ORPHAN}-1`, 2000, 1, ORPHAN);
        const store = new Map([['forkDeleteCursor', 3000]]);   // already past 2000
        const progress = { get: k => store.get(k), set: (k, v) => store.set(k, v) };
        const out = migrateHashKeyedIds(db, { chunkBlocks: 100, progress });
        assert.equal(out.forkTxDeleted, 0,
            'the resume cursor was ignored and already-cleared ground was re-walked');
    });

    test('F-182: each chunk is its own transaction, so no long lock is held', () => {
        // The finding: one BEGIN IMMEDIATE around a minute of work inside
        // initDb. Every HTTP worker's 5s busy_timeout expires against it.
        const { readFileSync } = require('node:fs');
        const src = readFileSync(new URL('../lib/id-migration.js', import.meta.url), 'utf8');
        const fn = src.slice(src.indexOf('export function migrateHashKeyedIds'),
                             src.indexOf('function inTx('));
        assert.ok(!/dbh\.exec\('BEGIN IMMEDIATE'\)/.test(fn),
            'the migration opens its own long transaction again instead of using inTx per step');
        assert.match(fn, /inTx\(dbh, \(\) => \{/);
        assert.match(src, /function inTx\(dbh, fn\)[\s\S]{0,200}BEGIN IMMEDIATE/,
            'inTx must still use IMMEDIATE (F-137)');
    });

    test('table_counts stays consistent through the duplicate deletion', () => {
        insTx(db, 'event-200-5', 200, 5, CANON);
        insTx(db, `event-${CANON}-5`, 200, 5, CANON);
        migrateHashKeyedIds(db);
        const n = db.prepare("SELECT n FROM table_counts WHERE name='transactions'").get().n;
        assert.equal(n, db.prepare('SELECT COUNT(*) c FROM transactions').get().c);
    });
});

describe('migrateHashKeyedIds — step 3, historical fork consistency', () => {
    test('rows disagreeing with blocks.hash at their height are deleted', () => {
        // The reviewer-caught scenario: an old fork row below the sweep's
        // first-run watermark. After the id rewrite it holds a valid
        // hash-keyed id, and the F-008 backfill would insert the canonical
        // twin beside it — double-counted volume, forever. One story per
        // height instead.
        insBlock(db, 700, CANON);
        insEvent(db, `${ORPHAN}-0`, 700, ORPHAN);            // orphan event
        insEvent(db, `${CANON}-0`, 700, CANON);              // canonical event
        insTx(db, `event-${ORPHAN}-1`, 700, 1, ORPHAN);      // orphan tx
        insTx(db, `event-${CANON}-1`, 700, 1, CANON);        // canonical tx
        insReward(db, `${ORPHAN}-2`, 700, 2, ORPHAN);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.forkEventsDeleted, 1);
        assert.equal(out.forkTxDeleted, 1);
        assert.equal(out.forkRewardsDeleted, 1);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE block=700').get().c, 1);
        assert.equal(db.prepare('SELECT block_hash FROM transactions WHERE block=700').get().block_hash, CANON);
    });

    test('a LEGACY-keyed fork row is rewritten and then removed in the same run', () => {
        // Rewrite (step 1) gives the orphan a valid hash-keyed id;
        // consistency (step 3) then deletes it because blocks disagrees. The
        // two steps composing correctly is the whole point of running them in
        // one transaction.
        insBlock(db, 701, CANON);
        insTx(db, 'event-701-0', 701, 0, ORPHAN);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.txRewritten, 1);
        assert.equal(out.forkTxDeleted, 1);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE block=701').get().c, 0);
    });

    test('rows at heights with NO blocks row are left alone', () => {
        // No local truth to compare against — deleting on a guess is worse.
        insTx(db, `event-${ORPHAN}-1`, 800, 1, ORPHAN);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.forkTxDeleted, 0);
    });

    test('rows without a usable hash are not judged', () => {
        insBlock(db, 702, CANON);
        insTx(db, 'event-702-0', 702, 0, null);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.forkTxDeleted, 0);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE block=702').get().c, 1);
    });

    test('a blocks row with a junk hash is not local truth', () => {
        // NULL is the easy case (SQL's != already neutralizes it — and an
        // earlier version of this test used only NULL, which let a mutant
        // that dropped the guard pass). The case that needs the explicit
        // `b.hash LIKE '0x%'` guard is a NON-NULL non-hash value: without it,
        // 'corrupt' != '0xccc…' is TRUE and the canonical row gets deleted on
        // the strength of garbage.
        insBlock(db, 703, null);
        insTx(db, `event-${CANON}-9`, 703, 9, CANON);
        insBlock(db, 704, 'corrupt-not-a-hash');
        insTx(db, `event-${CANON}-8`, 704, 8, CANON);
        const out = migrateHashKeyedIds(db);
        assert.equal(out.forkTxDeleted, 0, 'a junk blocks.hash was treated as truth');
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 2);
    });
});

describe('deleteForkRows — the reorg repair', () => {
    test('removes the orphan rows and keeps the canonical ones', () => {
        insEvent(db, `${ORPHAN}-0`, 500, ORPHAN);
        insEvent(db, `${CANON}-0`, 500, CANON);
        insTx(db, `event-${ORPHAN}-1`, 500, 1, ORPHAN);
        insTx(db, `event-${CANON}-1`, 500, 1, CANON);
        insReward(db, `${ORPHAN}-2`, 500, 2, ORPHAN);
        const out = deleteForkRows(db, 500, CANON);
        assert.deepEqual(out, { events: 1, transactions: 1, rewards: 1, skipped: false });
        assert.equal(db.prepare('SELECT COUNT(*) c FROM events WHERE block=500').get().c, 1);
        assert.equal(db.prepare('SELECT block_hash FROM events WHERE block=500').get().block_hash, CANON);
    });

    test('rows at OTHER heights are never touched', () => {
        insEvent(db, `${ORPHAN}-9`, 499, ORPHAN);
        deleteForkRows(db, 500, CANON);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
    });

    test('NULL/empty-hash rows at the disputed height are cleared for rescan', () => {
        insTx(db, 'event-500-1', 500, 1, null);
        insTx(db, 'event-500-2', 500, 2, '');
        const out = deleteForkRows(db, 500, CANON);
        assert.equal(out.transactions, 2);
    });

    test('refuses to repair on a bad canonical hash', () => {
        // Deleting keyed on garbage would destroy canonical data on a node
        // hiccup — the same conservatism as hashesDiffer in lib/reorg.js.
        insEvent(db, `${CANON}-0`, 500, CANON);
        for (const bad of [null, '', '0', 'nothex', undefined]) {
            const out = deleteForkRows(db, 500, bad);
            assert.equal(out.skipped, true, `repaired with hash ${String(bad)}`);
        }
        assert.equal(deleteForkRows(db, NaN, CANON).skipped, true);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1, 'a refused repair must not delete');
    });

    test('counter triggers fire on repair deletes too', () => {
        insEvent(db, `${ORPHAN}-0`, 500, ORPHAN);
        insEvent(db, `${ORPHAN}-1`, 500, ORPHAN);
        deleteForkRows(db, 500, CANON);
        assert.equal(db.prepare("SELECT n FROM table_counts WHERE name='events'").get().n, 0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit F-049 (round 2) — pre-v3 rows double-count against their twins.
//
// Two writer generations keyed this table differently: extrinsic hash before
// v3, `event-<blockHash>-<eventIndex>` after. Nothing deleted the old rows, and
// the v3 re-crawl inserts the new twin beside them, so a transfer appears twice
// in an address's list and any total over those rows is double.
// ─────────────────────────────────────────────────────────────────────────────
describe('purgeLegacyExtrinsicKeyedTx (F-049)', () => {
    let db;
    beforeEach(() => { db = freshDb(); });

    test('deletes extrinsic-hash-keyed rows and keeps event-derived ones', () => {
        insTx(db, '0x' + 'a'.repeat(64), 100, 0, CANON, 0);   // legacy
        for (let i = 1; i <= 9; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.equal(out.deleted, 1);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 9);
        assert.equal(db.prepare("SELECT COUNT(*) c FROM transactions WHERE hash LIKE '0x%'").get().c, 0);
    });

    test('a NULL event_derived counts as legacy', () => {
        // ALTER TABLE ADD COLUMN backfills NULL, so the oldest rows have no
        // flag at all rather than 0.
        db.prepare("INSERT INTO transactions(hash, block, event_index, block_hash, from_addr) VALUES(?,?,?,?,'5X')")
          .run('0x' + 'b'.repeat(64), 100, 0, CANON);
        for (let i = 1; i <= 9; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        assert.equal(purgeLegacyExtrinsicKeyedTx(db).deleted, 1);
    });

    test('it is idempotent', () => {
        insTx(db, '0x' + 'c'.repeat(64), 100, 0, CANON, 0);
        for (let i = 1; i <= 9; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        assert.equal(purgeLegacyExtrinsicKeyedTx(db).deleted, 1);
        assert.equal(purgeLegacyExtrinsicKeyedTx(db).deleted, 0);
    });

    test('an empty table is a no-op, not a crash', () => {
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.equal(out.deleted, 0);
        assert.equal(out.candidates, 0);
        assert.equal(out.refused, null);
    });

    test('THE SAFETY RAIL: it refuses when almost everything looks legacy', () => {
        // The scenario that would destroy the table: a writer that stops
        // setting the flag, or a schema where the column was never populated.
        // The delete is correct only because both row builders set
        // eventDerived: true — if that stops being true, this must fail loudly
        // rather than delete 12M rows.
        for (let i = 0; i < 10; i++) insTx(db, `0x${String(i).padStart(64, '0')}`, 100 + i, i, CANON, 0);
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.equal(out.deleted, 0, 'it deleted the whole table');
        assert.match(out.refused, /refusing to delete/);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 10);
    });

    test('the rail has a threshold, not a blanket veto', () => {
        // 1 legacy row among 10 is plausible and must still be cleaned.
        insTx(db, '0x' + 'd'.repeat(64), 100, 0, CANON, 0);
        for (let i = 1; i < 10; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.equal(out.refused, null);
        assert.equal(out.deleted, 1);
    });

    test('the default ceiling is conservative — 25%, not 90%', () => {
        // Adversarial review: the first draft allowed deleting up to 89% of the
        // table in one unattended boot transaction. The two failure modes are
        // not symmetric — a wrongly-permitted delete is unrecoverable, a
        // wrongly-refused one prints why and retries next boot.
        for (let i = 0; i < 4; i++) insTx(db, `0x${String(i).padStart(64, '0')}`, 100 + i, i, CANON, 0);
        for (let i = 4; i < 10; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        // 4/10 = 40% > 25%
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.equal(out.deleted, 0);
        assert.match(out.refused, /40\.0%/);
    });

    test('the refusal names the override and a value that would work', () => {
        // A rail with no documented way past it gets deleted by whoever hits it
        // at 2am. The message has to be actionable on its own.
        for (let i = 0; i < 4; i++) insTx(db, `0x${String(i).padStart(64, '0')}`, 100 + i, i, CANON, 0);
        for (let i = 4; i < 10; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.match(out.refused, /TX_PURGE_MAX_FRACTION/);
        assert.match(out.refused, /0\.40/);
    });

    test('an explicit higher ceiling lets a legitimate big purge through', () => {
        // The tight default must not make the finding unfixable on a database
        // with a genuinely large pre-v3 history.
        for (let i = 0; i < 4; i++) insTx(db, `0x${String(i).padStart(64, '0')}`, 100 + i, i, CANON, 0);
        for (let i = 4; i < 10; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        const out = purgeLegacyExtrinsicKeyedTx(db, { maxFraction: 0.5 });
        assert.equal(out.refused, null);
        assert.equal(out.deleted, 4);
    });

    test('it reports what it saw, so the boot log is diagnosable', () => {
        insTx(db, '0x' + 'e'.repeat(64), 100, 0, CANON, 0);
        for (let i = 1; i < 10; i++) insTx(db, `event-${CANON}-${i}`, 100 + i, i, CANON, 1);
        const out = purgeLegacyExtrinsicKeyedTx(db);
        assert.equal(out.total, 10);
        assert.equal(out.candidates, 1);
        assert.equal(out.deleted, 1);
    });
});

describe('F-049 — the caller does the half that makes it safe', () => {
    const serverSrc = require('node:fs').readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const dbSrc = require('node:fs').readFileSync(new URL('../db.js', import.meta.url), 'utf8');

    test('the purge has its OWN kv flag', () => {
        // Bolting it onto migrateHashKeyedIds would make it dead code: that
        // migration is behind a one-shot key every existing database has set.
        assert.match(dbSrc, /migration:purge-legacy-tx-rows/);
        assert.ok(!/setKv\('migration:hash-keyed-ids'[\s\S]{0,400}purgeLegacyExtrinsicKeyedTx/.test(dbSrc),
            'the purge was folded into the already-completed migration — it will never run');
    });

    test('a refusal does NOT set the flag, so a fixed database retries', () => {
        const block = dbSrc.slice(dbSrc.indexOf('purgeLegacyExtrinsicKeyedTx(db'), dbSrc.indexOf('purgeLegacyExtrinsicKeyedTx(db') + 2000);
        const refusedAt = block.indexOf('p.refused');
        const setFlagAt = block.indexOf("setKv('migration:purge-legacy-tx-rows'");
        assert.ok(refusedAt !== -1 && setFlagAt !== -1);
        assert.ok(refusedAt < setFlagAt, 'the flag is set before the refusal is checked');
    });

    test('the re-crawl covers the range the purge deleted', () => {
        // Clearing scannerVersion alone only re-crawls TX_INITIAL_SCAN_BLOCKS
        // from head. On a DB where the backfill was already complete, nothing
        // re-derives anything below that window — so a deleted legacy row with
        // no event-derived twin was simply gone.
        //
        // Audit F-196: the names are derived from the READER, not restated
        // here. The first version of this test asserted `backfillComplete` /
        // `backfillCursor` — the same wrong names the code used — so it passed
        // while the reset wrote two keys nobody reads and the backfill never
        // restarted. A test that repeats the code's assumption cannot falsify
        // it; ask the consumer instead.
        // The reader is syncTransactions() — locate it by the sync-state key
        // it opens, not by a remembered function name. (An earlier draft of
        // this test guessed `syncFinancialTransactions`, which does not exist,
        // and failed for a reason unrelated to the bug under test.)
        const at = serverSrc.lastIndexOf("const state = db.getSyncState('transactions');");
        assert.ok(at !== -1, 'the transactions scanner moved — re-point this test');
        // Bound by the end of the function rather than +4000 — see the note in
        // round3-new.test.js; the window stopped covering the complete-field
        // read when the comment above it grew.
        const readerRest = serverSrc.slice(at);
        const readerStop = readerRest.search(/\n(async )?function /);
        const reader = readerStop === -1 ? readerRest : readerRest.slice(0, readerStop);
        const cursorField = (reader.match(/state\.(\w*[Bb]ackfillCursor)/) || [])[1];
        const completeField = (reader.match(/state\.(\w*[Bb]ackfillComplete)/) || [])[1];
        assert.ok(cursorField && completeField,
            'could not find the backfill fields syncFinancialTransactions reads');
        assert.equal(cursorField, 'txBackfillCursor');
        assert.equal(completeField, 'txBackfillComplete');

        // Sliced to the end of the setSyncState call, not a byte count — a
        // fixed window ended mid-comment once the explanation above it grew.
        // (Fourth time a fixed-size slice has done this; prefer a real
        // delimiter.)
        const purgeAt = dbSrc.indexOf('purgeLegacyExtrinsicKeyedTx(db');
        const setAt = dbSrc.indexOf("setSyncState('transactions', {", purgeAt);
        assert.ok(setAt !== -1 && setAt > purgeAt, 'the purge no longer resets the sync state at all');
        const block = dbSrc.slice(setAt, dbSrc.indexOf('});', setAt));
        // F-203: the cursor is now an explicit height, never null — a stored
        // null was read back as the NUMBER 0 (Number(null) is finite), so the
        // reader's first-run branch never fired and the walk never ran. Assert
        // the FIELD is reset, and that it is not reset to the no-op value.
        assert.ok(block.includes(`${cursorField}:`),
            `the purge resets a field the scanner does not read (writes something other than ${cursorField})`);
        assert.ok(!block.includes(`${cursorField}: null`),
            'the purge hands over null again; the reader coerces it to 0 and never walks (F-203)');
        assert.ok(block.includes(`${completeField}: false`),
            `the purge resets a field the scanner does not read (writes something other than ${completeField})`);
    });

    test('F-196 — the purge writes no un-read backfill keys', () => {
        // The mirror of the above: writing the RIGHT keys is not enough if the
        // wrong ones are still written alongside, because they sit in the row
        // forever looking meaningful.
        const purgeAt = dbSrc.indexOf('purgeLegacyExtrinsicKeyedTx(db');
        const setAt = dbSrc.indexOf("setSyncState('transactions', {", purgeAt);
        const block = dbSrc.slice(setAt, dbSrc.indexOf('});', setAt));
        assert.ok(!/\n\s+backfillCursor: null/.test(block),
            'the un-prefixed backfillCursor is still written — nothing reads it');
        assert.ok(!/\n\s+backfillComplete: false/.test(block),
            'the un-prefixed backfillComplete is still written — nothing reads it');
    });

    test('deleting rows forces a re-crawl', () => {
        // Without this the purge trades a double-counted transfer for a
        // MISSING one, which is worse: the deleted rows are real transfers the
        // event-derived writer has not necessarily re-indexed.
        const purgeAt = dbSrc.indexOf('purgeLegacyExtrinsicKeyedTx(db');
        const setAt = dbSrc.indexOf("setSyncState('transactions', {", purgeAt);
        const block = dbSrc.slice(setAt, dbSrc.indexOf('});', setAt));
        assert.match(block, /scannerVersion: null/);
    });

    test('a purge failure does not take the boot down', () => {
        // Unlike the hash-id migration above, which must be fatal. A
        // double-counted transfer is a wrong number on a page; refusing to boot
        // over it would take the explorer offline for a display bug.
        // Scoped by brace-matching rather than a byte offset: the first version
        // asserted `catchAt < 1600`, which broke the moment the block grew by a
        // few lines — a test that fails for a reason unrelated to its subject
        // is one the next person deletes.
        const start = dbSrc.indexOf("if (seedCounts && !getKv('migration:purge-legacy-tx-rows'))");
        assert.ok(start !== -1, 'the purge caller moved — re-point this test');
        let depth = 0, end = start;
        for (let i = dbSrc.indexOf('{', start); i < dbSrc.length; i++) {
            if (dbSrc[i] === '{') depth++;
            else if (dbSrc[i] === '}' && --depth === 0) { end = i; break; }
        }
        const block = dbSrc.slice(start, end + 1);
        assert.match(block, /catch \(e\)/, 'a purge failure escapes and kills the boot');
        assert.ok(!/throw new Error\(`legacy tx purge/.test(block),
            'the purge rethrows — a display bug would take the explorer offline');
        assert.match(block, /console\.warn/, 'the failure is swallowed without a log line');
    });
});
