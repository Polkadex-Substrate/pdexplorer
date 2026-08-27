// Boot-time database behaviour — audit F-139 (who applies the schema) and
// F-140 (the O(1) row counters). Run against a REAL node:sqlite database in a
// temp dir, because both findings are about what happens between PROCESSES at
// startup and neither is visible from a pure function.
//
// The stakes are the reason these tests exist at all. Two earlier audit fixes in
// this exact code became incidents: F-088 put a CREATE INDEX in the boot path
// and no worker reached app.listen, and F-138 made a benign concurrent-ALTER
// race fatal and killed boot on the upgrade it was meant to protect. So the
// assertions below are not just "the optimisation happened" — the load-bearing
// one is `initDb does not throw when the migrator never arrives`, which is the
// property that keeps an indexer problem from becoming a site outage.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from '../db.js';

const MARKER_KEY = 'schema:applied';

// A fresh directory per test: initDb keeps a module-level connection, so tests
// that shared a file would also share each other's mutations.
const created = [];
function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-db-init-'));
    created.push(dir);
    return dir;
}
// Each temp dir holds a real explorer.db (+ -wal/-shm); leaving a dozen behind
// per run would slowly fill the developer's /tmp.
after(() => {
    for (const dir of created) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

// A SECOND connection to the same file, used to reach behind db.js's back and
// break the schema in ways only a skipped-DDL worker would leave broken.
function raw(dir) {
    return new DatabaseSync(path.join(dir, 'explorer.db'));
}
function tableExists(dir, name) {
    const h = raw(dir);
    try {
        return !!h.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    } finally { h.close(); }
}

describe('F-139 — the migrator applies the DDL, other workers do not', () => {
    test('the migrator applies the schema and records a fingerprint marker', () => {
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });

        assert.equal(db.schemaInitInfo().action, 'applied');
        const marker = db.getKv(MARKER_KEY);
        assert.ok(marker, 'the migrator did not record a schema marker — every other worker will now re-apply the DDL');
        assert.equal(marker.fingerprint, db.schemaInitInfo().fingerprint);
        assert.ok(/^[0-9a-f]{16}$/.test(marker.fingerprint), `fingerprint looks wrong: ${marker.fingerprint}`);
    });

    test('journal_mode is WAL after the migrator runs (it moved out of the per-connection PRAGMAs)', () => {
        // WAL is a property of the FILE, so moving `PRAGMA journal_mode = WAL`
        // into the DDL step is only safe if the file really ends up in WAL.
        // Concurrent readers alongside the indexer's writes depend on it.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        try {
            assert.equal(h.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        } finally { h.close(); }
    });

    test('an HTTP worker with a current marker really does SKIP the DDL', () => {
        // The only honest way to prove a skip: break the schema behind db.js's
        // back and show the second init does not repair it. If ensureSchema ever
        // goes back to unconditionally calling applyDdl, `validators` comes back
        // and this fails.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });

        const h = raw(dir);
        h.exec('DROP TABLE validators');
        h.close();

        db.initDb(dir, false, { awaitMigrator: false });
        assert.equal(db.schemaInitInfo().action, 'skipped');
        assert.equal(tableExists(dir, 'validators'), false,
            'the HTTP worker re-created the table, i.e. it still ran the full DDL — F-139 is not closed');
    });

    test('a stale fingerprint is NOT accepted — the worker applies the DDL again', () => {
        // This is the guard that makes skipping safe. If a deploy changes SCHEMA
        // or ADDITIVE_MIGRATIONS, the recorded fingerprint no longer matches and
        // workers must stop skipping — otherwise they serve queries against
        // columns that do not exist yet.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        db.setKv(MARKER_KEY, { fingerprint: 'deadbeefdeadbeef', at: Date.now() });

        const h = raw(dir);
        h.exec('DROP TABLE validators');
        h.close();

        db.initDb(dir, false, { awaitMigrator: false });
        assert.equal(db.schemaInitInfo().action, 'applied-solo');
        assert.equal(tableExists(dir, 'validators'), true,
            'the worker skipped the DDL despite a fingerprint mismatch — a schema change would now 500 every affected query');
    });

    test('the schema fingerprint has not changed unnoticed', () => {
        // A change-detector, and the only assertion that can see WHAT the
        // fingerprint is computed from — a test can otherwise only ever compare
        // db.js's fingerprint against db.js's fingerprint.
        //
        // IF THIS FAILS: it is telling you the schema-skip key moved. That is
        // correct and expected when you edit SCHEMA, ADDITIVE_MIGRATIONS or
        // POST_SCHEMA_SQL — update the constant below and move on. What you are
        // being asked to confirm is that it moved AT ALL: if you added a
        // migration and this test still passed, the fingerprint stopped covering
        // the thing you changed, every HTTP worker will decide the schema is
        // current, skip your ALTER, and 500 on every query touching the new
        // column while the indexer looks perfectly healthy.
        const EXPECTED = '86e649605d597e6a';
        assert.equal(db.schemaInitInfo().fingerprint, EXPECTED);
    });

    test('the fingerprint covers the additive migrations, not just SCHEMA', () => {
        // ADDITIVE_MIGRATIONS lives in a table specifically so it can be
        // fingerprinted. Adding a column at a call site instead of in that table
        // would leave the fingerprint unmoved and every HTTP worker skipping the
        // ALTER. Assert the columns those migrations add are actually present,
        // which is the outcome the fingerprint is protecting.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        try {
            const cols = t => h.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            assert.ok(cols('address_labels').includes('vetoed_at'));
            assert.ok(cols('price_history').includes('source'));
        } finally { h.close(); }
    });

    test('an HTTP worker whose migrator NEVER arrives degrades, it does not crash', () => {
        // The most important assertion in this file. F-022 turns an initDb throw
        // into process.exit(1), and the cluster primary re-forks — so a worker
        // that refuses to start because the indexer is slow or crash-looping
        // takes the whole site down instead of serving stale-but-correct data.
        // The wait must end in "apply the DDL myself", never in a throw.
        const dir = tmpDir();                       // no migrator has ever run here
        const started = Date.now();
        assert.doesNotThrow(() => db.initDb(dir, false, { awaitMigrator: true, schemaWaitMs: 300 }));
        const waited = Date.now() - started;

        assert.equal(db.schemaInitInfo().action, 'applied-fallback');
        assert.ok(waited >= 250, `worker did not actually wait for the migrator (waited ${waited}ms)`);
        assert.equal(tableExists(dir, 'validators'), true,
            'the fallback did not apply the DDL, so this worker would serve requests against a schema that does not exist');
    });

    test('a worker released by the marker mid-wait reports that it waited', () => {
        // Same path, but with the marker already present the loop exits on the
        // first poll rather than at the deadline. Distinguishes "waited" from
        // "timed out and did it myself" so the boot log means something.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });   // migrator writes the marker
        db.initDb(dir, false, { awaitMigrator: true, schemaWaitMs: 5000 });
        assert.equal(db.schemaInitInfo().action, 'skipped');
    });

    test('the JSON->SQLite import is migrator-only', () => {
        // db.js:450-453 in the audit. This is a WRITE path; with WORKERS=8 every
        // worker used to read the same legacy cache files and INSERT the same
        // rows concurrently, against the single-writer invariant WAL is set up
        // for. A non-migrator worker must not import, even when the files exist.
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'blocks_cache.json'), JSON.stringify({
            blocks: [{ number: 42, hash: '0x' + 'a'.repeat(64), timestamp: 1 }]
        }));

        db.initDb(dir, false, { awaitMigrator: false });   // HTTP worker, solo
        assert.equal(db.countBlocks(), 0,
            'a non-indexer worker imported the JSON caches — that is a second writer');

        db.initDb(dir, true, { awaitMigrator: false });    // the migrator may
        assert.equal(db.countBlocks(), 1);
    });
});

describe('F-139 — server.js wires the migrator role through to initDb', () => {
    // db.js can only make the right decision if it is told whether another
    // process is coming. That wiring lives in server.js's bootstrap, which has
    // no test harness (it forks a cluster and opens an RPC socket on import), so
    // it is asserted against the source. Crude, but the alternative is that
    // reverting the call site silently reinstates the boot-time DDL stampede
    // while every behavioural test above still passes.
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

    test('initDb is told whether to wait for a migrator', () => {
        assert.match(src, /db\.initDb\(DATA_DIR,\s*!!indexer,\s*\{\s*awaitMigrator:[^}]*\}\)/,
            'server.js no longer passes awaitMigrator to initDb. A lone process would then wait ' +
            'SCHEMA_WAIT_MS at every boot for a migrator that does not exist.');
    });

    test('both bootstrap paths declare whether they are clustered', () => {
        // Lookbehind skips the `function runWorker({...})` declaration itself.
        const calls = [...src.matchAll(/(?<!function )runWorker\(\{([^}]*)\}\)/g)].map(m => m[1]);
        assert.equal(calls.length, 2, `expected 2 runWorker call sites, found ${calls.length}`);
        for (const args of calls) {
            assert.match(args, /clustered:\s*(true|false)/,
                `a runWorker call site ({${args.trim()}}) does not state clustered:, so it silently ` +
                `takes the default and the wait/apply decision is made on a guess.`);
        }
        // One of each: the single-process path is not clustered, the forked one is.
        assert.ok(calls.some(a => /clustered:\s*false/.test(a)));
        assert.ok(calls.some(a => /clustered:\s*true/.test(a)));
    });
});

describe('F-140 — table_counts is seeded, and a miss does not full-scan per call', () => {
    test('the migrator seeds both counters', () => {
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        try {
            // node:sqlite hands back null-prototype rows; re-shape so the
            // failure message is about the data and not about prototypes.
            const names = h.prepare('SELECT name, n FROM table_counts ORDER BY name')
                .all().map(r => ({ name: r.name, n: r.n }));
            assert.deepEqual(names, [{ name: 'events', n: 0 }, { name: 'transactions', n: 0 }]);
        } finally { h.close(); }
    });

    test('seeding RETRIES instead of giving up after one console.warn', () => {
        // The finding is "best-effort": one attempt, failure logged and dropped,
        // table_counts empty for the life of the database. Drive the failure path
        // directly — with table_counts gone every attempt throws — and count the
        // attempts. Reverting to a single try/catch makes this see one warning.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        // The triggers reference table_counts, so they have to go with it.
        h.exec('DROP TRIGGER trg_events_count_ai; DROP TRIGGER trg_events_count_ad; DROP TABLE table_counts');
        h.close();

        const warns = [];
        const errors = [];
        const realWarn = console.warn, realError = console.error;
        console.warn = (...a) => warns.push(a.join(' '));
        console.error = (...a) => errors.push(a.join(' '));
        let ok;
        try {
            ok = db.seedTableCounter('events', 3);
        } finally {
            console.warn = realWarn;
            console.error = realError;
        }

        assert.equal(ok, false, 'seedTableCounter claimed success against a missing table');
        const attemptWarns = warns.filter(w => /count seed for events failed \(attempt \d+\/3\)/.test(w));
        assert.equal(attemptWarns.length, 3,
            `expected 3 attempts, saw ${attemptWarns.length} — the seed is back to best-effort`);
        assert.ok(errors.some(e => /STILL missing/.test(e)),
            'a permanently unseeded counter must be logged at error level, not left silent');
    });

    test('seeding VERIFIES the row exists rather than trusting the INSERT', () => {
        // "The INSERT did not throw" is not the same claim as "the row is
        // there", and the difference is exactly what makes the error log at the
        // end of seedTableCounter trustworthy. Staged with an INSTEAD OF trigger
        // that swallows the insert: the statement succeeds, the row does not
        // appear. Without the post-insert re-check this returns true on the
        // first attempt and the counter stays missing in silence.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        h.exec(`
            DROP TRIGGER trg_events_count_ai; DROP TRIGGER trg_events_count_ad;
            DROP TRIGGER trg_tx_count_ai;     DROP TRIGGER trg_tx_count_ad;
            DROP TABLE table_counts;
            CREATE TABLE table_counts_real (name TEXT PRIMARY KEY, n INTEGER);
            CREATE VIEW table_counts AS SELECT name, n FROM table_counts_real;
            CREATE TRIGGER tc_swallow INSTEAD OF INSERT ON table_counts BEGIN SELECT 1; END;
        `);
        h.close();

        const realWarn = console.warn, realError = console.error;
        console.warn = () => { }; console.error = () => { };
        let ok;
        try { ok = db.seedTableCounter('events', 2); }
        finally { console.warn = realWarn; console.error = realError; }

        assert.equal(ok, false,
            'seedTableCounter reported success without checking that the row actually exists');
    });

    test('seeding succeeds and reports true on the ordinary path', () => {
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        h.exec("DELETE FROM table_counts WHERE name = 'events'");
        h.close();
        assert.equal(db.seedTableCounter('events', 2), true);
        const h2 = raw(dir);
        try {
            assert.ok(h2.prepare("SELECT 1 FROM table_counts WHERE name = 'events'").get());
        } finally { h2.close(); }
    });

    test('a counter miss scans ONCE and is served from cache after that', () => {
        // node:sqlite is synchronous: a COUNT(*) over a multi-million row table
        // blocks the worker's event loop and stalls every other request it is
        // serving. The old fallback did that on every single call. Observed here
        // by changing the table under the cache: a second scan would see 1.
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        const h = raw(dir);
        h.exec("DELETE FROM table_counts WHERE name = 'transactions'");
        h.close();

        const first = db.countTransactions();
        assert.equal(first, 0);

        db.insertTransactions([{ hash: '0x' + '1'.repeat(64), block: 1, method: 'transfer' }]);
        // The AFTER INSERT trigger updates zero rows (the counter row is gone),
        // so this still takes the fallback path.
        assert.equal(db.countTransactions(), first,
            'the fallback re-scanned the table — F-140 leaves a synchronous full scan on every request');
    });

    test('once the counter row exists it is used, not the cache', () => {
        const dir = tmpDir();
        db.initDb(dir, true, { awaitMigrator: false });
        db.insertTransactions([{ hash: '0x' + '2'.repeat(64), block: 2, method: 'transfer' }]);
        assert.equal(db.countTransactions(), 1);
        assert.equal(db.countEvents(), 0);
    });
});
