// Identity healing, review fixes (Sprint 8 review, FIX FIRST):
//   H1  the pass never writes back a stale copy of the pending list: a noteUnnamed made while the
//       pass awaited a read survives (a new address, a range extended past the healed one)
//   H2  the events heal is driven by block window on idx_events_block, so it never depends on the
//       optional idx_events_signer_block; bounded per statement and per pass
//   M3  a re-scan with a different author never keeps the old author's name
//   M7  addresses dropped at the cap are counted in one rate-limited warning (no addresses)
//   L12 a non-finite block is rejected; the healed range is clamped to the highest stored block
//   L13 noteUnnamed never throws into the block scan, and does not rewrite an unchanged list
//   plus: an entry noted moments ago is not dropped by a pass that found no rows yet (the scanner
//   notes the address before the block and its events are inserted)
// Accounts are 32 bytes of one repeated value and belong to no one.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import {
    noteUnnamed, healUnnamedNames, HEAL_KEY, HEAL_MAX_ADDRESSES, HEAL_WINDOW_BLOCKS,
    HEAL_MAX_WINDOWS_PER_PASS, HEAL_MAX_AGE_MS, HEAL_DROP_WARN_INTERVAL_MS
} from '../lib/identity-heal.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const A = addr(31), B = addr(32), C = addr(33);
const T0 = 1_000_000_000;
const LATER = T0 + 24 * 3600_000;

// A db with only what the healing code uses: kv in memory, heal calls recorded.
function fakeDb({ maxBlock = 1_000_000, kvThrows = false } = {}) {
    const kv = new Map();
    const calls = { blocks: [], events: [], setKv: 0 };
    return {
        calls,
        getKv(k) { if (kvThrows) throw new Error('kv broken'); return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        setKv(k, v) { if (kvThrows) throw new Error('kv broken'); calls.setKv++; kv.set(k, JSON.stringify(v)); },
        getMaxBlockNumber() { return maxBlock; },
        healBlockAuthorNames(a, name, lo, hi) { calls.blocks.push({ a, lo, hi }); return 0; },
        healEventSignerNames(a, name, lo, hi) { calls.events.push({ a, lo, hi }); return 0; },
        getUnnamedDiscussionAuthors() { return []; },
        healDiscussionAuthorNames() { return 0; }
    };
}
const found = { name: 'Named', status: 'found' };

describe('H1: the pass never writes back a stale copy of the pending list', () => {
    test('an address noted while the pass awaits a read is kept, and a range extended meanwhile is not dropped', async () => {
        const f = fakeDb();
        noteUnnamed(f, A, 100, { now: () => T0 });
        noteUnnamed(f, B, 200, { now: () => T0 });
        let gate;
        const resolve = async (a) => {
            if (a === A) {
                await new Promise(r => { gate = r; setImmediate(r); });
                // the scanner runs while the read is out
                noteUnnamed(f, C, 300, { now: () => LATER });
                noteUnnamed(f, A, 900, { now: () => LATER });
            }
            return found;
        };
        await healUnnamedNames({ db: f, resolve, now: () => LATER });
        const pending = f.getKv(HEAL_KEY) || {};
        assert.ok(pending[C], 'the address noted during the await is still pending');
        assert.ok(pending[A] && pending[A].to >= 900, 'the extended range of A is still pending');
        assert.ok(!pending[B], 'B, healed and unchanged, is done');
    });

    test('a partly healed entry is shrunk only when it did not change meanwhile', async () => {
        const f = fakeDb();
        noteUnnamed(f, A, 0, { now: () => T0 });
        noteUnnamed(f, A, 10_000_000, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => LATER });
        const p = f.getKv(HEAL_KEY)[A];
        assert.ok(p.from > 0 && p.to === 10_000_000, 'shrunk from the front, end kept');
    });
});

describe('H2: the events heal is by block window, bounded per statement and per pass', () => {
    test('every statement covers at most one window, and a pass does at most the pass budget', async () => {
        const f = fakeDb({ maxBlock: 50_000_000 });
        for (let i = 0; i < 40; i++) {
            const a = addr(100 + i);
            noteUnnamed(f, a, 0, { now: () => T0 });
            noteUnnamed(f, a, 40_000_000, { now: () => T0 });
        }
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => LATER });
        assert.ok(f.calls.events.length > 0);
        assert.ok(f.calls.events.every(c => c.hi - c.lo + 1 <= HEAL_WINDOW_BLOCKS), 'one window per statement');
        assert.ok(f.calls.blocks.every(c => c.hi - c.lo + 1 <= HEAL_WINDOW_BLOCKS), 'one window per statement');
        assert.ok(f.calls.events.length <= HEAL_MAX_WINDOWS_PER_PASS, `events statements ${f.calls.events.length}`);
        assert.ok(f.calls.blocks.length <= HEAL_MAX_WINDOWS_PER_PASS, `blocks statements ${f.calls.blocks.length}`);
    });

    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });

    test('plan, on a database WITHOUT idx_events_signer_block: the block index, no full scan, not the signer index', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-heal-plan-'));
        dirs.push(dir);
        const h = db.initDb(dir, true, { awaitMigrator: false });
        h.exec('DROP INDEX IF EXISTS idx_events_signer_block');
        assert.ok(!h.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_events_signer_block'").get());
        assert.equal(typeof db.HEAL_EVENT_SIGNER_SQL, 'string');
        const plan = h.prepare(`EXPLAIN QUERY PLAN ${db.HEAL_EVENT_SIGNER_SQL}`).all('N', 10, 20, A).map(r => r.detail);
        const joined = plan.join(' | ');
        assert.ok(plan.some(d => d === 'SEARCH events USING INDEX idx_events_block (block>? AND block<?)'), joined);
        assert.doesNotMatch(joined, /SCAN events/);
        assert.doesNotMatch(joined, /idx_events_signer/);
    });

    test('on a real database the window heal names only NULL rows of the address inside the window', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-heal-win-'));
        dirs.push(dir);
        const h = db.initDb(dir, true, { awaitMigrator: false });
        h.exec('DROP INDEX IF EXISTS idx_events_signer_block');
        const ev = (n, block, signerAddress, signerName) => ({ hash: `w${n}`, txHash: null, blockHash: `0xb${block}`, block, eventIndex: n, extrinsicIndex: null, section: 's', method: 'm', data: {}, signerAddress, signerName, timestamp: 1, status: 'success' });
        db.insertEvents([ev(1, 10, A, null), ev(2, 20, A, null), ev(3, 21, A, null), ev(4, 15, B, null), ev(5, 12, A, 'Kept')]);
        assert.equal(db.healEventSignerNames(A, 'Alice', 10, 20), 2);
        const name = (n) => db.getRecentEvents(50).find(e => e.hash === `w${n}`).signerName;
        assert.equal(name(1), 'Alice'); assert.equal(name(2), 'Alice');
        assert.equal(name(3), 'Unknown', 'outside the window');
        assert.equal(name(4), 'Unknown', 'another signer');
        assert.equal(name(5), 'Kept');
    });
});

describe('M3: a re-scan with a different author never keeps the old name', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
    test('the stored name is kept only for the same author', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-heal-reorg-'));
        dirs.push(dir);
        db.initDb(dir, true);
        const blk = (number, authorAddress, authorName) => ({ number, hash: `0xr${number}${authorAddress.slice(0, 4)}`, authorAddress, authorName, extrinsicsCount: 1, eventsCount: 1, timestamp: 1000 + number });
        db.insertBlocks([blk(100, A, 'Alice'), blk(101, A, 'Alice')]);
        db.insertBlocks([blk(100, B, null), blk(101, A, null)]);
        const nameOf = (n) => db.getRecentBlocks(10).find(b => b.number === n).authorName;
        assert.equal(nameOf(100), 'Unknown', 'a new author does not inherit the old author name');
        assert.equal(nameOf(101), 'Alice', 'the same author keeps its name');
    });
});

describe('M7: the cap is reported in one rate-limited warning with a count, never an address', () => {
    test('one warning per interval, counting the dropped addresses', () => {
        const f = fakeDb();
        for (let i = 0; i < HEAL_MAX_ADDRESSES; i++) noteUnnamed(f, `x${i}`, 1, { now: () => T0 });
        const warns = [];
        const warn = (...a) => warns.push(a.join(' '));
        noteUnnamed(f, A, 1, { now: () => T0 + 1, warn });
        noteUnnamed(f, B, 1, { now: () => T0 + 2, warn });
        noteUnnamed(f, C, 1, { now: () => T0 + 3, warn });
        assert.equal(warns.length, 1, warns.join('\n'));
        noteUnnamed(f, addr(34), 1, { now: () => T0 + 4 + HEAL_DROP_WARN_INTERVAL_MS, warn });
        assert.equal(warns.length, 2);
        assert.match(warns[1], /\b3\b/, 'the second warning counts the three dropped since the first');
        for (const w of warns) for (const a of [A, B, C, addr(34)]) assert.ok(!w.includes(a), 'no address in the warning');
        assert.equal(Object.keys(f.getKv(HEAL_KEY)).length, HEAL_MAX_ADDRESSES);
    });
});

describe('L12/L13: noteUnnamed input and failure handling', () => {
    test('a non-finite block is rejected, nothing is noted', () => {
        const f = fakeDb();
        for (const b of [NaN, Infinity, undefined, 'x', -1]) noteUnnamed(f, A, b, { now: () => T0 });
        assert.equal((f.getKv(HEAL_KEY) || {})[A], undefined);
    });

    test('the healed range is clamped to the highest stored block', async () => {
        const f = fakeDb({ maxBlock: 150 });
        f.setKv(HEAL_KEY, { [A]: { from: 100, to: Number.MAX_SAFE_INTEGER } });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => LATER });
        assert.ok(f.calls.blocks.length >= 1 && f.calls.blocks.every(c => c.hi <= 150), JSON.stringify(f.calls.blocks.slice(0, 3)));
        assert.ok(f.calls.events.every(c => c.hi <= 150));
    });

    test('a broken kv store never throws into the scanner', () => {
        const f = fakeDb({ kvThrows: true });
        assert.doesNotThrow(() => noteUnnamed(f, A, 5, { now: () => T0, warn: () => {} }));
    });

    test('noting an address already covered does not rewrite the list', () => {
        const f = fakeDb();
        noteUnnamed(f, A, 5, { now: () => T0 });
        const n = f.calls.setKv;
        noteUnnamed(f, A, 5, { now: () => T0 + 1 });
        noteUnnamed(f, A, 5, { now: () => T0 + 2 });
        assert.equal(f.calls.setKv, n);
    });
});

describe('an entry noted moments ago survives a pass that found no rows yet', () => {
    test('kept while the highest stored block is below it (the clock does not decide), dropped once it is stored', async () => {
        const f = fakeDb({ maxBlock: 99 });
        noteUnnamed(f, A, 100, { now: () => T0 });
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + HEAL_MAX_AGE_MS - 1 });
        assert.ok(f.getKv(HEAL_KEY)[A], 'the block may not be inserted yet: still pending, however old the note');
        f.getMaxBlockNumber = () => 100;
        await healUnnamedNames({ db: f, resolve: async () => found, now: () => T0 + 1000 });
        assert.ok(!(f.getKv(HEAL_KEY) || {})[A], 'done as soon as the block is stored and healed');
    });
});
