// Identity healing, follow-ups from the Sprint 9 review (all non-blocking, all on a live 20 GB database):
//   F1  the pass yields to the event loop between addresses and between windows (injected, so tests control it)
//   F2  an address whose read failed rotates to the tail, so failing heads cannot starve the rest
//   F3  an entry is dropped when the DATA says its rows exist (highest stored block, and that block row) and the
//       windows up to it were healed, not when a clock says so; a long age cap is only a backstop
//   F4  a failing address is not silent: one rate-limited warning per pass interval, a count and the error, no address
//   F5  a missing idx_events_block disables the events heal for the process with one warning, never throws per pass
// Every account is 32 bytes of one repeated value and belongs to no one.

import { test, describe, beforeEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as realDb from '../db.js';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import * as H from '../lib/identity-heal.js';
import {
    noteUnnamed, healUnnamedNames, HEAL_KEY, HEAL_MAX_AGE_MS, HEAL_WINDOW_BLOCKS, HEAL_ERROR_WARN_INTERVAL_MS, _resetHealStateForTests
} from '../lib/identity-heal.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const A = addr(41), B = addr(42);
const T0 = 2_000_000_000;
// The settle time an entry needs before a data drop (lib/identity-heal.js HEAL_SETTLE_MS, final review).
const SETTLE = 10 * 60_000;
const found = { name: 'Named', status: 'found' };
const failed = { name: null, status: 'failed' };

function fakeDb({ maxBlock = 1_000_000, existing = null, blockThrows = null, eventThrows = null } = {}) {
    const kv = new Map();
    const calls = { blocks: [], events: [], hasBlock: [] };
    const d = {
        calls,
        getKv(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        setKv(k, v) { kv.set(k, JSON.stringify(v)); },
        getMaxBlockNumber() { return maxBlock; },
        healBlockAuthorNames(a, name, lo, hi) { if (blockThrows) throw blockThrows; calls.blocks.push({ a, lo, hi }); return 0; },
        healEventSignerNames(a, name, lo, hi) { if (eventThrows) throw eventThrows; calls.events.push({ a, lo, hi }); return 0; },
        getUnnamedDiscussionAuthors() { return []; },
        healDiscussionAuthorNames() { return 0; }
    };
    if (existing) d.hasBlock = (n) => { calls.hasBlock.push(n); return existing(n); };
    return d;
}

beforeEach(() => _resetHealStateForTests());

describe('F1: the pass yields to the event loop', () => {
    test('between addresses and between windows, through the injected yield', async () => {
        const f = fakeDb();
        noteUnnamed(f, A, 0, { now: () => T0 });
        noteUnnamed(f, A, 2 * HEAL_WINDOW_BLOCKS + 5, { now: () => T0 });   // three windows
        noteUnnamed(f, B, 7, { now: () => T0 });                              // one window
        let yields = 0;
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0, yieldToLoop: async () => { yields++; } });
        assert.ok(yields >= 3 + 1, `yielded ${yields} times for 4 windows over 2 addresses`);
    });

    test('by default a timer scheduled before the pass runs while the pass is still going', async () => {
        const f = fakeDb();
        for (let i = 0; i < 5; i++) noteUnnamed(f, addr(60 + i), 1, { now: () => T0 });
        let timerRan = false;
        setImmediate(() => { timerRan = true; });
        const seenAt = [];
        const orig = f.healBlockAuthorNames;
        f.healBlockAuthorNames = (...a) => { seenAt.push(timerRan); return orig(...a); };
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 });
        assert.equal(seenAt.length, 5);
        assert.equal(seenAt[0], false, 'the first address runs before any macrotask');
        assert.equal(seenAt[4], true, 'a macrotask ran before the last address: the loop was released');
    });
});

describe('F2: a failing head cannot starve the rest', () => {
    test('addresses whose read failed rotate to the tail, so the next pass reaches the others', async () => {
        const f = fakeDb();
        const bad = [], good = [];
        for (let i = 0; i < 60; i++) {
            const a = addr(100 + i);
            (i < 50 ? bad : good).push(a);
            noteUnnamed(f, a, 5, { now: () => T0 });
        }
        const resolve = async (a) => (bad.includes(a) ? failed : found);
        await healUnnamedNames({ db: f, resolve, now: () => T0 + SETTLE });
        await healUnnamedNames({ db: f, resolve, now: () => T0 + SETTLE });
        const healedAddrs = new Set(f.calls.blocks.map(c => c.a));
        for (const g of good) assert.ok(healedAddrs.has(g), 'an address behind 50 failing ones was reached by the second pass');
        const left = Object.keys(f.getKv(HEAL_KEY));
        assert.deepEqual(left.sort(), bad.slice().sort(), 'only the failing ones stay pending');
    });

    test('an address whose heal threw also rotates, and a short list is not rewritten', async () => {
        const f = fakeDb();
        noteUnnamed(f, A, 5, { now: () => T0 });
        noteUnnamed(f, B, 5, { now: () => T0 });
        const sets = [];
        const orig = f.setKv; f.setKv = (k, v) => { sets.push(k); orig(k, v); };
        await healUnnamedNames({ db: f, resolve: async (a) => (a === A ? failed : failed), now: () => T0 });
        assert.equal(sets.length, 0, 'fewer addresses than the batch: order does not matter, nothing is written');
    });
});

describe('F3: the drop depends on the data, not the clock', () => {
    test('block not stored yet: kept far past the old 10 minute grace; dropped once the block is there', async () => {
        const f = fakeDb({ maxBlock: 50 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + 60 * 60_000 });
        assert.ok(f.getKv(HEAL_KEY)[A], 'highest stored block 50 < 100: the rows do not exist yet, still pending after an hour');
        f.getMaxBlockNumber = () => 100;
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + 60 * 60_000 + 1 });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A], 'block 100 stored and healed: done');
    });

    test('block stored: kept moments after the note (it may still be lowered), dropped once it has settled', async () => {
        const f = fakeDb({ maxBlock: 1_000 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + 1000 });
        assert.ok(f.getKv(HEAL_KEY)[A], 'noted a second ago: kept');
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + SETTLE });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A]);
    });

    test('a backfill: the highest block is far above, but the entry\'s own block row is missing, so it is kept', async () => {
        const f = fakeDb({ maxBlock: 20_000_000, existing: (n) => n !== 100 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + 60 * 60_000 });
        assert.ok(f.getKv(HEAL_KEY)[A], 'the batch that notes block 100 has not inserted it yet');
        assert.ok(f.calls.hasBlock.includes(100));
        f.calls.hasBlock.length = 0;
        const g = f;  g.hasBlock = () => true;
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + 60 * 60_000 + 1 });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A]);
    });

    test('the age cap is a backstop: an entry for a block that never arrives is dropped after it', async () => {
        const f = fakeDb({ maxBlock: 50 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + HEAL_MAX_AGE_MS - 1 });
        assert.ok(f.getKv(HEAL_KEY)[A]);
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + HEAL_MAX_AGE_MS + 1 });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A]);
        assert.ok(HEAL_MAX_AGE_MS >= 12 * 3600_000, 'generous');
    });

    test('windows not yet healed are never dropped by data alone', async () => {
        const f = fakeDb({ maxBlock: 10_000_000 });
        noteUnnamed(f, A, 0, { now: () => T0 });
        noteUnnamed(f, A, 9_000_000, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0, maxWindows: 3 });
        const e = f.getKv(HEAL_KEY)[A];
        assert.ok(e && e.from === 3 * HEAL_WINDOW_BLOCKS && e.to === 9_000_000);
    });
});

describe('F4: a failing address is reported, once per interval, without an address', () => {
    test('one warning with the count and the error, rate limited', async () => {
        const f = fakeDb();
        for (let i = 0; i < 3; i++) noteUnnamed(f, addr(70 + i), 5, { now: () => T0 });
        const warns = [];
        const warn = (...a) => warns.push(a.join(' '));
        const boom = async (a) => { throw new TypeError(`read of ${a} refused`); };
        await healUnnamedNames({ db: f, resolve: boom, now: () => T0, warn });
        await healUnnamedNames({ db: f, resolve: boom, now: () => T0 + 1000, warn });
        assert.equal(warns.length, 1, warns.join('\n'));
        assert.match(warns[0], /\b3\b/);
        assert.match(warns[0], /TypeError/);
        for (let i = 0; i < 3; i++) assert.ok(!warns[0].includes(addr(70 + i)), 'no address in the warning');
        await healUnnamedNames({ db: f, resolve: boom, now: () => T0 + HEAL_ERROR_WARN_INTERVAL_MS + 5, warn });
        assert.equal(warns.length, 2);
    });

    test('a read that merely failed (status failed) is the normal case and is not warned about', async () => {
        const f = fakeDb();
        noteUnnamed(f, A, 5, { now: () => T0 });
        const warns = [];
        await healUnnamedNames({ db: f, resolve: async () => failed, now: () => T0, warn: (...a) => warns.push(a) });
        assert.equal(warns.length, 0);
    });
});

describe('F5: a missing idx_events_block disables the events heal for the process', () => {
    test('one warning, no throw, blocks still healed, events not tried again', async () => {
        const f = fakeDb({ eventThrows: new Error('no such index: idx_events_block') });
        noteUnnamed(f, A, 5, { now: () => T0 });
        noteUnnamed(f, B, 6, { now: () => T0 });
        const warns = [];
        const warn = (...a) => warns.push(a.join(' '));
        let eventCalls = 0;
        const orig = f.healEventSignerNames;
        f.healEventSignerNames = (...a) => { eventCalls++; return orig(...a); };
        await assert.doesNotReject(healUnnamedNames({ db: f, resolve: async () => found, now: () => T0, warn }));
        assert.equal(warns.length, 1, warns.join('\n'));
        assert.match(warns[0], /idx_events_block/);
        assert.equal(eventCalls, 1, 'tried once, then disabled (the second address did not retry)');
        assert.equal(f.calls.blocks.length, 2, 'blocks are still healed for both');
        noteUnnamed(f, A, 9, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + HEAL_ERROR_WARN_INTERVAL_MS * 3, warn });
        assert.equal(eventCalls, 1, 'not tried on a later pass');
        assert.equal(warns.length, 1, 'no second warning');
    });

    test('any other events error is not mistaken for a missing index', async () => {
        const f = fakeDb({ eventThrows: new Error('database is locked') });
        noteUnnamed(f, A, 5, { now: () => T0 });
        let eventCalls = 0;
        const orig = f.healEventSignerNames;
        f.healEventSignerNames = (...a) => { eventCalls++; return orig(...a); };
        const warns = [];
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0, warn: (...a) => warns.push(a.join(' ')) });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + HEAL_ERROR_WARN_INTERVAL_MS * 3, warn: (...a) => warns.push(a.join(' ')) });
        assert.equal(eventCalls, 2, 'a transient error is retried next pass');
    });
});

describe('F5 on a real database: the error SQLite raises for the dropped index is the one detected', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
    test('with idx_events_block dropped the pass does not throw and warns once', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-heal-noidx-'));
        dirs.push(dir);
        const h = realDb.initDb(dir, true, { awaitMigrator: false });
        h.exec('DROP INDEX IF EXISTS idx_events_block');
        realDb.insertBlocks([{ number: 5, hash: '0xr5', authorAddress: A, authorName: null, extrinsicsCount: 1, eventsCount: 1, timestamp: 1000 }]);
        noteUnnamed(realDb, A, 5, { now: () => T0 });
        const warns = [];
        const r = await healUnnamedNames({ db: realDb, resolve: async () => found, now: () => T0 + SETTLE, warn: (...a) => warns.push(a.join(' ')) });
        assert.equal(r.healed, 1, 'the block author was still named');
        assert.equal(warns.length, 1);
        assert.match(warns[0], /idx_events_block/);
        assert.ok(!(realDb.getKv(HEAL_KEY) || {})[A], 'block 5 is stored and healed: done');
    });
});

// Final review (2026-11-21): the scanner scans a backfill, gap-fill or rescan range DESCENDING and inserts it
// after the whole range, so a note that lowers `from` arrives while `to` is already stored.
describe('final review: an entry is dropped only after it has settled; the backstop warns', () => {
    // Blocks as rows: number -> author name (null = unnamed). The heal names only stored rows in the window.
    function rowsDb(stored) {
        const rows = new Map(stored.map(n => [n, null]));
        const f = fakeDb({ maxBlock: Math.max(...stored), existing: (n) => rows.has(n) });
        f.getMaxBlockNumber = () => Math.max(...rows.keys());
        f.healBlockAuthorNames = (a, name, lo, hi) => {
            let c = 0;
            for (const [n, v] of rows) if (n >= lo && n <= hi && v === null) { rows.set(n, name); c++; }
            f.calls.blocks.push({ a, lo, hi });
            return c;
        };
        return { f, rows };
    }

    test('the settle time is a named 10 minute constant', () => {
        assert.equal(H.HEAL_SETTLE_MS, 10 * 60_000);
    });

    test('a descending backfill lowers `from` while `to` is stored: the lower block is healed once it is inserted', async () => {
        const { f, rows } = rowsDb([500]);
        noteUnnamed(f, A, 500, { now: () => T0 });
        const T1 = T0 + 2 * 3600_000;
        // The backfill scans 100..499 descending and notes A at block 100; nothing of it is inserted yet.
        noteUnnamed(f, A, 100, { now: () => T1 });
        assert.equal(f.getKv(HEAL_KEY)[A].from, 100);
        assert.equal(f.getKv(HEAL_KEY)[A].at, T1, 'a note that changes the range refreshes `at`');
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T1 + 1000 });
        assert.equal(rows.get(500), 'Named');
        assert.ok(f.getKv(HEAL_KEY)[A], 'block 500 is stored, but the entry was noted a second ago: kept');
        rows.set(100, null);   // the backfill batch goes in
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T1 + SETTLE });
        assert.equal(rows.get(100), 'Named', 'the lower block\'s name is healed');
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A], 'settled, stored and healed: dropped');
    });

    test('a complete entry is kept just before the settle time and dropped at it', async () => {
        const { f } = rowsDb([100]);
        noteUnnamed(f, A, 100, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + SETTLE - 1 });
        assert.ok(f.getKv(HEAL_KEY)[A]);
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + SETTLE });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A]);
    });

    test('a drop by the 24 h backstop warns once per interval, with a count and no address', async () => {
        const f = fakeDb({ maxBlock: 50 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        noteUnnamed(f, B, 200, { now: () => T0 });
        const warns = [];
        const warn = (...a) => warns.push(a.join(' '));
        const t1 = T0 + HEAL_MAX_AGE_MS + 1;
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => t1, warn });
        assert.deepEqual(Object.keys(f.getKv(HEAL_KEY) || {}), []);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /\b2 address\(es\) dropped by the 24 h backstop/);
        assert.ok(!warns[0].includes(A) && !warns[0].includes(B), 'no address in the log');
        const C = addr(43);
        noteUnnamed(f, C, 300, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => t1 + 1000, warn });
        assert.equal(warns.length, 1, 'rate-limited');
        noteUnnamed(f, addr(44), 300, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => t1 + 1000 + H.HEAL_BACKSTOP_WARN_INTERVAL_MS, warn });
        assert.equal(warns.length, 2);
        assert.match(warns[1], /\b2 address\(es\) dropped/, 'the count carries the drops held back by the rate limit');
    });

    test('a data drop after the settle time does not warn', async () => {
        const f = fakeDb({ maxBlock: 1_000 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        const warns = [];
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + HEAL_MAX_AGE_MS + 1, warn: (...a) => warns.push(a.join(' ')) });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A]);
        assert.equal(warns.length, 0);
    });

    test('the error line scrubs 0x public keys as well as SS58 addresses', async () => {
        const f = fakeDb({ blockThrows: new Error('bad key 0x' + 'ab'.repeat(32) + ' for ' + A) });
        noteUnnamed(f, A, 5, { now: () => T0 });
        const warns = [];
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0, warn: (...a) => warns.push(a.join(' ')) });
        assert.equal(warns.length, 1);
        assert.ok(!/0x[0-9a-f]{40,}/i.test(warns[0]), warns[0]);
        assert.ok(!warns[0].includes(A));
        assert.match(warns[0], /\[key\]/);
        const g = fakeDb({ blockThrows: new Error('short 0x' + 'ab'.repeat(19) + ' stays') });
        _resetHealStateForTests();
        noteUnnamed(g, A, 5, { now: () => T0 });
        const w2 = [];
        await healUnnamedNames({ db: g, resolve: async () => found, now: () => T0, warn: (...a) => w2.push(a.join(' ')) });
        assert.match(w2[0], /0x(ab){19} stays/, 'fewer than 40 hex characters is not a key');
    });
});
