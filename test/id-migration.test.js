// Tests for lib/id-migration.js — audit F-021, run against a REAL SQLite
// database (node:sqlite in-memory) using the production schema for the three
// affected tables, including the triggers that maintain table_counts. The
// audit's exact worry is "changing only the writer duplicates rows or leaves
// orphans in place", so the scenarios below are stated in those terms.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateHashKeyedIds, deleteForkRows } from '../lib/id-migration.js';

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

    test('extrinsic-hash-keyed rows (event_derived=0) are untouched', () => {
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
        assert.deepEqual(again, {
            txRewritten: 0, txDuplicatesDeleted: 0, rewardRewritten: 0, rewardDuplicatesDeleted: 0,
            forkEventsDeleted: 0, forkTxDeleted: 0, forkRewardsDeleted: 0
        });
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
