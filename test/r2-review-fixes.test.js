// R2 review fixes (the reviewer's FIX FIRST list), each reproduced on the real code over a real temp database:
//
//   1. the reorg repair must mark a stash stale even when the fork EMPTIED its unclaimed cache (no row left
//      for an EXISTS to find), and must still never create a kv row for a stash nobody cached;
//   2. a forward-pass height the node could not serve (transient) is queued, so freshness never reports it,
//      or anything above it, as indexed until it is really scanned; the queue is bounded, and a remainder
//      past the bound pins freshness through the skip tail;
//   3. a recompute of the unpaid list that read chain state before the forward pass deleted a paid pair does
//      not write that pair back and does not stamp the cache fresh (a per-stash counter in kv, read before the
//      chain state and checked again in the write transaction; visible across connections);
//   4. the head read on each poll is memoised for about a second per worker and has a short timeout; a timed
//      out read is null, and null is never caught up;
//   5. behaviour tests for what were source-text scans: the reorg ordering (the real repair over a seeded
//      database) and the locks route's freshness wiring (the server's own registration line, real handler).
//
// The functions are lifted from server.js (bodyOf) and run in a vm context; only the chain is fake.
// Addresses are the public substrate dev accounts (test/helpers/payout-events.js).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { rewardNotesForBlock, storedRewardStash, REWARD_NOTES_MAX_PER_BLOCK } from '../lib/reward-events.js';
import { buildFreshness, lowestTailFrom, caughtUp } from '../lib/freshness.js';
import { buildClaimedIndex, claimedRewardKey } from '../lib/reward-dedup.js';
import { mergeUnclaimed } from '../lib/unclaimed-rewards.js';
import { contiguousWatermark, isCaughtUp, readHeadSeen } from '../lib/watermark.js';
import { addTail, takeFromTail, tailSize, normalizeTail } from '../lib/skip-tail.js';
import { deriveIndexStatus, describeIndexStatus } from '../lib/index-status.js';
import { isFreshRequest } from '../lib/gov-refresh.js';
import { registerBalanceLocksRoute } from '../lib/balance-locks-api.js';
import { readRepo, bodyOf } from './helpers/source.js';
import { ME, OTHER, V1, V2, V3 } from './helpers/payout-events.js';

const SERVER = readRepo('server.js', import.meta.url);
const at88 = (a) => encodeAddress(decodeAddress(a), 88);
const STRANGER = at88('5HpG9w8EBLe5XCrbczpwq5TSXvedjrBGCwqxK1iQ7qUsSWFc');
const TTL = 20 * 60 * 1000;
const isFresh = (stash) => db.getUnclaimedComputedAt(stash) > Date.now() - TTL;
const cached = (stash) => db.getUnclaimed(stash).map(r => `${r.era}:${r.validator}`).sort();
const num = (n) => ({ toNumber: () => Number(n), toString: () => String(n), toBigInt: () => BigInt(n) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const quiet = { warn() {}, log() {}, error() {} };

// One line of server.js that starts with `start`, or '' when it is not there (so a test fails on behaviour,
// not on a missing line).
function optLine(start) {
    const i = SERVER.indexOf(start);
    return i === -1 ? '' : SERVER.slice(i, SERVER.indexOf('\n', i));
}
const optBody = (name, prefix = '') => { try { return prefix + bodyOf(SERVER, name); } catch { return ''; } };

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
// A real database in a temp directory, WITHOUT the optional indexes.
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-r2-review-'));
    dirs.push(dir);
    const h = db.initDb(dir, true, { awaitMigrator: false });
    for (const idx of ['idx_tx_timestamp', 'idx_blocks_timestamp', 'idx_events_signer_block']) h.exec(`DROP INDEX IF EXISTS ${idx}`);
    return { h, dir };
}

// --- the reorg repair (server.js repairReorgedBlock, with the real noteReorgedRewards) ---
function reorgWorld() {
    const ctx = {
        console: quiet, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object,
        db, storedRewardStash, REWARD_NOTES_MAX_PER_BLOCK, encodeAddress, decodeAddress, chainSS58: 88,
        blockHashCache: { evict() {} },
        scanSingleBlock: async (n) => ({ block: { number: n, hash: '0xcanonical', authorAddress: at88(V1), authorName: 'n', extrinsicsCount: 1, eventsCount: 0, timestamp: 1 }, events: [] }),
        scanBlockForRewards: async () => ({ ok: true, rewards: [] }), toRewardRow: (r) => r, deriveTransactionsFromLocalEvents() { return 0; }
    };
    vm.createContext(ctx);
    vm.runInContext([bodyOf(SERVER, 'normalizeAddress'), bodyOf(SERVER, 'noteReorgedRewards'), 'async ' + bodyOf(SERVER, 'repairReorgedBlock'),
        'globalThis.__r = { repairReorgedBlock, noteReorgedRewards };'].join('\n'), ctx);
    return ctx.__r;
}
// The fork as the forward pass stored it: its block row and its Rewarded event for `stash`.
function storeFork(n, stash) {
    db.insertBlocks([{ number: n, hash: '0xfork', authorAddress: at88(V1), authorName: 'n', extrinsicsCount: 2, eventsCount: 1, timestamp: 1 }]);
    db.insertEvents([{ hash: `0xfork-${n}-0`, txHash: '0xt', blockHash: '0xfork', block: n, eventIndex: 0, extrinsicIndex: 1, section: 'staking', method: 'Rewarded',
        data: { stash, dest: 'Staked', amount: '1' }, signerAddress: stash, signerName: 'n', timestamp: 1, status: 'success' }]);
}

describe('finding 1: the reorg repair marks the stash stale even when the fork emptied its cache', () => {
    before(() => { freshDb(); });
    test('one unpaid pair, paid on a fork (the pair is deleted, no row left), the fork abandoned: the cache is stale after the repair', async () => {
        db.replaceUnclaimed(at88(ME), [{ era: 501, validator: at88(V1), amount: 1 }]);
        db.noteRewardedPairs({ pairs: [{ stash: at88(ME), era: 501, validator: at88(V1) }], stale: [] });   // the fork's forward pass
        assert.deepEqual(cached(at88(ME)), [], 'fixture: the fork did not empty the cache');
        assert.ok(isFresh(at88(ME)), 'fixture: the cache is not fresh before the repair');
        storeFork(3000, ME);
        const r = reorgWorld();
        await r.repairReorgedBlock(3000, '0xcanonical', '0xfork');
        assert.equal(isFresh(at88(ME)), false, 'the cache is still fresh: a really unpaid reward is hidden with no pending flag');
        assert.equal(db.getUnclaimedComputedAt(at88(ME)), 0);
    });
    test('a fork reward for a stash with no cache entry at all creates no kv row (regression guard)', async () => {
        storeFork(3001, STRANGER);
        const r = reorgWorld();
        await r.repairReorgedBlock(3001, '0xcanonical', '0xfork');
        assert.equal(db.getKv('unclaimed_at:' + STRANGER), null, 'a kv row was created for a stash nobody cached');
        assert.equal(db.getKv('unclaimed_gen:' + STRANGER), null, 'a counter row was created for a stash nobody cached');
    });
});

describe('finding 5: the reorg repair reads the fork\'s rewards before it deletes the fork rows (behaviour)', () => {
    before(() => { freshDb(); });
    test('the stash keeps another cached pair; after the real repair it is marked stale and the fork rows are gone (regression guard)', async () => {
        db.replaceUnclaimed(at88(OTHER), [{ era: 501, validator: at88(V1), amount: 1 }, { era: 502, validator: at88(V2), amount: 2 }]);
        db.noteRewardedPairs({ pairs: [{ stash: at88(OTHER), era: 501, validator: at88(V1) }], stale: [] });
        assert.deepEqual(cached(at88(OTHER)), [`502:${at88(V2)}`]);
        storeFork(3100, OTHER);
        const r = reorgWorld();
        await r.repairReorgedBlock(3100, '0xcanonical', '0xfork');
        assert.equal(isFresh(at88(OTHER)), false, 'the fork\'s rewarded stash was not marked stale: its rows were deleted before they were read');
        assert.deepEqual(db.getForkRewardEventData(3100, '0xcanonical'), [], 'the fork rows were not deleted');
    });
});

// --- the forward pass over a node that cannot serve some heights (server.js syncChainIndex, real) ---
function chainWorld({ head, failing, skipRecordMax = 2000 }) {
    const state = { head, failing: new Set(failing), scanned: [] };
    const errors = [];
    const ctx = {
        console: quiet, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object, Error,
        db, contiguousWatermark, isCaughtUp, readHeadSeen, addTail, takeFromTail, tailSize, normalizeTail, deriveIndexStatus, describeIndexStatus,
        buildFreshness, lowestTailFrom,
        isSyncingChain: false, lastRecentGapScanAt: Date.now(), lastFullGapScanAt: Date.now(), gapAttempts: new Map(), gapsExhausted: 0, gapRotationTick: 0, gapAttemptsResetAt: Date.now(),
        BLOCKS_FORWARD_MAX: 500, BLOCKS_BACKFILL_CHUNK: 200, BLOCKS_MIN_BLOCK: 1, BLOCKS_FETCH_CONCURRENCY: 8, BLOCKS_GAP_FILL_CHUNK: 50,
        SCAN_GAP_FILL_BATCH: 20, SCAN_MAX_ATTEMPTS: 10, SKIP_RECORD_MAX: skipRecordMax, SKIP_DRAIN_PER_TICK: 500,
        CHAIN_GAP_SCAN_MS: 1e12, CHAIN_FULL_GAP_SCAN_MS: 1e12, CHAIN_GAP_SCAN_WINDOW: 5000, CHAIN_FULL_SCAN_WINDOW: 500000, GAP_SCAN_SLICE: 5000, GAP_SCAN_SLOW_MS: 1e9,
        GAP_ATTEMPT_RESET_MS: 1e12, DEFAULT_MAX_GAP_ATTEMPTS: 5, CHAIN_INDEX_INTERVAL_MS: 12_000, STAKING_REWARDS_INTERVAL_MS: 60_000, THIRTY_SECONDS: 30_000,
        isRpcReady: () => true, inBackoff: () => false, recordChainHead() {}, noteSyncError() {},
        logSyncError: (label, err) => { errors.push(err); },
        isRpcUnavailableError: (err) => !!(err && err.transient),
        shortErrorMessage: (err) => String(err && err.message),
        scanSingleBlock: async (n) => {
            if (state.failing.has(n)) throw Object.assign(new Error('No response received from RPC endpoint in 60s'), { transient: true });
            state.scanned.push(n);
            return { block: { number: n, hash: '0x' + n.toString(16).padStart(64, '0'), authorAddress: at88(V1), authorName: 'n', extrinsicsCount: 1, eventsCount: 0, timestamp: 1 }, events: [] };
        },
        deriveTransactionsFromLocalEvents() { return 0; }, govSyncsForEvents: () => [], runGovSync() {},
        scanGapsYielding: async () => ({ gaps: [], longestMs: 0, slices: 0 }), chooseGap: () => null, exhaustedGapCount: () => 0, shouldRetire: () => false, recordAttempt() {},
        reorgSweep: async () => {},
        globalApi: { rpc: { chain: { getHeader: async () => ({ number: num(state.head) }) } } }
    };
    vm.createContext(ctx);
    vm.runInContext([
        'async ' + bodyOf(SERVER, 'scanChainRange'), bodyOf(SERVER, 'recordChainScanFailures'), bodyOf(SERVER, 'recordSkippedRange'), bodyOf(SERVER, 'drainSkipTail'),
        optBody('deferTransientChainHeights'), 'async ' + bodyOf(SERVER, 'syncChainIndex'), bodyOf(SERVER, 'lowestHoleFrom'), bodyOf(SERVER, 'freshnessNow'),
        'globalThis.__c = { syncChainIndex, freshnessNow };'
    ].join('\n'), ctx);
    const tick = async () => { await ctx.__c.syncChainIndex(); assert.deepEqual(errors, [], 'the tick threw: ' + errors.map(e => e && e.message).join('; ')); };
    const indexedChain = () => ctx.__c.freshnessNow({ chainHead: state.head }).indexed.chain;
    return { state, tick, indexedChain };
}
const seedChain = (top) => {
    const rows = [];
    for (let n = 1; n <= top; n++) rows.push({ number: n, hash: '0x' + n.toString(16).padStart(64, '0'), authorAddress: at88(V1), authorName: 'n', extrinsicsCount: 1, eventsCount: 0, timestamp: 1 });
    db.insertBlocks(rows);
    db.setSyncState('chain_index', { initialized: true, headSeen: top, latestScannedBlock: top, oldestScannedBlock: 1, backfillCursor: 0, backfillComplete: true, status: 'Synced' });
};

describe('finding 2: a height the node could not serve in the forward pass is never reported as indexed until it is scanned', () => {
    test('node fails for 104..106 while head moves 100 -> 110 -> 111, then recovers at 112', async () => {
        freshDb();
        seedChain(100);
        const w = chainWorld({ head: 110, failing: [104, 105, 106] });
        await w.tick();
        assert.equal(db.getSyncState('chain_index').headSeen, 110, 'fixture: the forward pass did not reach the head');
        assert.ok(w.indexedChain() !== null && w.indexedChain() < 104, `freshness reports ${w.indexedChain()} indexed over the unscanned block 104`);
        assert.equal(w.indexedChain(), 103);
        w.state.head = 111;
        await w.tick();   // still failing: the repair pass retries and the node still cannot serve them
        assert.equal(w.indexedChain(), 103, 'a retry that failed again let freshness pass the hole');
        const rows = db.getScanFailures('chain_index', 100, 10).map(r => Number(r.block)).sort((a, b) => a - b);
        assert.deepEqual(rows, [104, 105, 106], 'the deferred heights are not in the retry queue');
        w.state.failing.clear();
        w.state.head = 112;
        await w.tick();   // recovered: the existing failure-queue pass scans them
        for (const n of [104, 105, 106]) assert.ok(w.state.scanned.includes(n), `block ${n} was never scanned`);
        assert.equal(w.indexedChain(), 112, 'the hole was repaired but freshness did not advance');
        assert.equal(db.getLowestScanFailure('chain_index'), null);
    });
    test('the deferral never counts an attempt (a long outage cannot retire a block)', async () => {
        freshDb();
        seedChain(200);
        const w = chainWorld({ head: 205, failing: [203] });
        await w.tick();
        for (let i = 0; i < 12; i++) { w.state.head++; await w.tick(); }
        const row = db.getScanFailures('chain_index', 100, 10).find(r => Number(r.block) === 203);
        assert.ok(row, 'block 203 left the retry queue (retired or never queued) while still unscanned');
        assert.equal(Number(row.attempts), 0, 'a node outage counted attempts');
        assert.ok(w.indexedChain() < 203);
    });
    test('bounded: past the bound the rest are owed through the skip tail, freshness stays pinned, and recovery drains them', async () => {
        freshDb();
        seedChain(300);
        const failing = [];
        for (let n = 302; n <= 309; n++) failing.push(n);
        const w = chainWorld({ head: 312, failing, skipRecordMax: 3 });
        await w.tick();
        const rows = db.getScanFailures('chain_index', 1000, 10).map(r => Number(r.block)).sort((a, b) => a - b);
        assert.ok(rows.length <= 3, `${rows.length} rows queued in one go, over the bound of 3`);
        assert.equal(w.indexedChain(), 301, `freshness reports ${w.indexedChain()} over the unscanned block 302`);
        w.state.failing.clear();
        for (let i = 0; i < 6 && w.indexedChain() !== w.state.head; i++) {
            w.state.head++;
            await w.tick();
            const unscanned = failing.filter(n => !w.state.scanned.includes(n));
            if (unscanned.length) assert.ok(w.indexedChain() < Math.min(...unscanned), `freshness reports ${w.indexedChain()} over the unscanned block ${Math.min(...unscanned)}`);
        }
        for (const n of failing) assert.ok(w.state.scanned.includes(n), `block ${n} was never scanned`);
        assert.equal(w.indexedChain(), w.state.head);
    });
});

// --- the unpaid-list recompute (server.js recomputeUnclaimed, real) racing the forward pass ---
function recomputeWorld({ owed, during = null, dbFor = db }) {
    const ctx = {
        console: quiet, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object,
        db: dbFor, buildClaimedIndex, claimedRewardKey, mergeUnclaimed, balanceToPDEX: (v) => Number(v),
        normalizeAddress: (a) => at88(a), computingUnclaimed: new Set(), unclaimedEraIndexCache: new Map(),
        globalApi: { query: { staking: { activeEra: async () => ({ isSome: true, unwrap: () => ({ index: num(510) }) }), erasValidatorReward: async () => null } }, consts: { staking: { historyDepth: num(84) } } },
        // The chain read. The forward pass (or a reorg repair) runs WHILE it is in flight, after the state was read.
        computeStashUnclaimed: async () => { const rows = owed.map(o => ({ ...o })); await Promise.resolve(); if (during) await during(); return { rows, emptyEras: [] }; }
    };
    vm.createContext(ctx);
    vm.runInContext(['async ' + bodyOf(SERVER, 'recomputeUnclaimed'), 'globalThis.__u = { recomputeUnclaimed };'].join('\n'), ctx);
    return ctx.__u;
}
const OWED = () => [{ era: 501, validator: at88(V1), amount: 1 }, { era: 502, validator: at88(V2), amount: 2 }];

describe('finding 3: a recompute that read chain state before the forward pass paid a pair', () => {
    let dir;
    before(() => { dir = freshDb().dir; });
    test('no interleaving: the recompute writes its rows and stamps the cache fresh (regression guard)', async () => {
        const s = at88(V3);
        const u = recomputeWorld({ owed: OWED() });
        await u.recomputeUnclaimed(s);
        assert.deepEqual(cached(s), [`501:${at88(V1)}`, `502:${at88(V2)}`]);
        assert.ok(isFresh(s));
    });
    test('recompute starts, the forward pass deletes the paid pair, the recompute writes: the pair is not listed and the cache is not fresh', async () => {
        const s = at88(ME);
        db.replaceUnclaimed(s, OWED());
        db.setKv('unclaimed_at:' + s, 0);   // stale: the next read recomputes
        const u = recomputeWorld({ owed: OWED(), during: () => db.noteRewardedPairs({ pairs: [{ stash: s, era: 501, validator: at88(V1) }], stale: [] }) });
        await u.recomputeUnclaimed(s);
        assert.ok(!cached(s).includes(`501:${at88(V1)}`), 'the recompute wrote the paid pair back: a paid reward is offered for signing');
        assert.equal(isFresh(s), false, 'the cache was stamped fresh over the forward pass, so freshness says caught up');
    });
    test('the same race on a stash with no cache yet (its first recompute): the pair is not listed and the cache is not fresh', async () => {
        const s = at88(OTHER);
        assert.deepEqual(cached(s), []);
        const u = recomputeWorld({ owed: OWED(), during: () => db.noteRewardedPairs({ pairs: [{ stash: s, era: 501, validator: at88(V1) }], stale: [] }) });
        await u.recomputeUnclaimed(s);
        assert.ok(!cached(s).includes(`501:${at88(V1)}`), 'the first recompute listed a pair the forward pass saw paid');
        assert.equal(isFresh(s), false);
    });
    test('across processes: the forward pass on ANOTHER connection (a second db.js instance on the same file) is seen by the recompute', async () => {
        const db2 = await import('../db.js?forward-pass-connection');
        db2.initDb(dir, false, { awaitMigrator: false });
        const s = at88(V1);
        db.replaceUnclaimed(s, OWED());
        db.setKv('unclaimed_at:' + s, 0);
        const u = recomputeWorld({ owed: OWED(), during: () => db2.noteRewardedPairs({ pairs: [{ stash: s, era: 501, validator: at88(V1) }], stale: [] }) });
        await u.recomputeUnclaimed(s);
        assert.ok(!cached(s).includes(`501:${at88(V1)}`), 'the pair deleted by the other connection was written back');
        assert.equal(isFresh(s), false, 'stamped fresh although another connection paid a pair meanwhile');
    });
    test('a reorg repair during the recompute (the recompute read the fork) leaves the cache stale', async () => {
        const s = at88(V2);
        db.replaceUnclaimed(s, [{ era: 502, validator: at88(V2), amount: 2 }]);
        db.setKv('unclaimed_at:' + s, 0);
        storeFork(3200, V2);
        const r = reorgWorld();
        // The recompute read the fork's state (501:V1 paid there, so not owed); the repair abandons the fork meanwhile.
        const u = recomputeWorld({ owed: [{ era: 502, validator: at88(V2), amount: 2 }], during: () => r.repairReorgedBlock(3200, '0xcanonical', '0xfork') });
        await u.recomputeUnclaimed(s);
        assert.equal(isFresh(s), false, 'a recompute that read the abandoned fork stamped the cache fresh');
    });
    test('bounded: one counter row per stash with a cache, none for a stranger, and no growth per block', () => {
        const s = at88(ME);
        const before = db.getKv('unclaimed_gen:' + s);
        for (let i = 0; i < 5; i++) db.noteRewardedPairs({ pairs: [{ stash: s, era: 600 + i, validator: at88(V1) }, { stash: STRANGER, era: 600 + i, validator: at88(V1) }], stale: [{ stash: STRANGER, era: null }] });
        assert.equal(db.getKv('unclaimed_gen:' + STRANGER), null, 'a counter row was created for a stash nobody cached');
        assert.equal(db.getKv('unclaimed_at:' + STRANGER), null);
        const rows = db.getKv('unclaimed_gen:' + s);
        assert.ok(typeof rows === 'number' && typeof before === 'number' && rows > before, 'the forward pass did not move the counter of a cached stash');
    });
});

describe('finding 3: query plans of the new statements (a database without the optional indexes)', () => {
    test('every new or changed statement is a primary-key or index lookup, never a scan', () => {
        const { h } = freshDb();
        const sqls = Object.entries(db).filter(([k, v]) => typeof v === 'string' && /^UNCLAIMED_/.test(k));
        const names = sqls.map(([k]) => k).sort();
        for (const k of ['UNCLAIMED_GEN_BUMP_SQL', 'UNCLAIMED_GEN_INIT_SQL', 'UNCLAIMED_GEN_READ_SQL', 'UNCLAIMED_REORG_STALE_SQL', 'UNCLAIMED_PAIR_DELETE_SQL', 'UNCLAIMED_STASH_DELETE_SQL', 'UNCLAIMED_STALE_SQL']) {
            assert.ok(names.includes(k), `db.js does not export ${k} (exports: ${names.join(', ')})`);
        }
        for (const [k, sql] of sqls) {
            const n = (sql.match(/\?/g) || []).length;
            const plan = h.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 'x'))).map(r => r.detail).join(' | ');
            assert.doesNotMatch(plan, /\bSCAN\b/, `${k}: ${plan}`);
            if (/^\s*(UPDATE kv|SELECT value FROM kv)/i.test(sql)) assert.match(plan, /SEARCH kv USING INDEX sqlite_autoindex_kv_1 \(key=\?\)/, `${k}: ${plan}`);
            if (/FROM staking_rewards_unclaimed WHERE stash = \?/.test(sql)) assert.match(plan, /SEARCH staking_rewards_unclaimed USING (COVERING )?INDEX (sqlite_autoindex_staking_rewards_unclaimed_1|idx_sru_stash) \(stash=\?/, `${k}: ${plan}`);
        }
    });
});

// --- the head read on each poll (server.js freshnessHead, real) ---
function headWorld({ getHeader, clock = null }) {
    const calls = { n: 0 };
    const fakeDate = clock ? { now: () => clock.t } : Date;
    const ctx = {
        console: quiet, Number, String, Array, Math, JSON, Promise, Object, Error, Date: fakeDate, setTimeout, clearTimeout, process: { env: {} },
        isRpcReady: () => true, DEV_API_TIMEOUT_MS: 30_000,
        globalApi: { rpc: { chain: { getHeader: (...a) => { calls.n++; return getHeader(...a); } } } }
    };
    vm.createContext(ctx);
    vm.runInContext([optLine('const FRESHNESS_HEAD_TIMEOUT_MS'), optLine('const FRESHNESS_HEAD_MEMO_MS'), optLine('const freshnessHeadMemo'),
        bodyOf(SERVER, 'withTimeout'), 'async ' + bodyOf(SERVER, 'freshnessHead'), 'globalThis.__h = { freshnessHead };'].join('\n'), ctx);
    return { calls, freshnessHead: ctx.__h.freshnessHead };
}

describe('finding 4: the poll\'s head read is memoised per worker and has a short timeout', () => {
    test('memo: polls within about a second share one getHeader; a later poll reads again', async () => {
        const clock = { t: 1_000_000 };
        let head = 500;
        const w = headWorld({ getHeader: async () => ({ number: num(head) }), clock });
        assert.equal(await w.freshnessHead(), 500);
        clock.t += 300;
        head = 501;
        assert.equal(await w.freshnessHead(), 500, 'a poll 300 ms later read the node again');
        const both = await Promise.all([w.freshnessHead(), w.freshnessHead()]);
        assert.deepEqual(both, [500, 500]);
        assert.equal(w.calls.n, 1, `${w.calls.n} getHeader calls for polls inside one second`);
        clock.t += 2000;
        assert.equal(await w.freshnessHead(), 501, 'the memo outlived its second');
        assert.equal(w.calls.n, 2);
    });
    test('concurrent first polls share one in-flight read', async () => {
        const waiting = [];
        const w = headWorld({ getHeader: () => new Promise(r => { waiting.push(() => r({ number: num(7) })); }) });
        const a = w.freshnessHead(), b = w.freshnessHead();
        await sleep(5);
        for (const release of waiting) release();
        assert.deepEqual(await Promise.race([Promise.all([a, b]), sleep(3000).then(() => 'hung')]), [7, 7]);
        assert.equal(w.calls.n, 1, 'two concurrent polls made two RPCs');
    });
    test('timeout: a node that never answers gives null within a few seconds, and null is never caught up', async () => {
        const w = headWorld({ getHeader: () => new Promise(() => {}) });
        const started = Date.now();
        const out = await Promise.race([w.freshnessHead(), sleep(5000).then(() => 'hung')]);
        assert.notEqual(out, 'hung', 'the head read has no timeout: the route waits for ever');
        assert.equal(out, null);
        assert.ok(Date.now() - started < 4000, 'the timeout is not short');
        assert.equal(caughtUp('balance', { v: 1, chainHead: out, indexed: {}, since: {}, pending: [] }, 1), false);
        assert.equal(caughtUp('locks', { v: 1, chainHead: out, indexed: {}, since: {}, pending: [] }, 1), false);
    });
    test('a failed read is not memoised: the next poll reads again', async () => {
        let fail = true;
        const w = headWorld({ getHeader: async () => { if (fail) throw new Error('node gone'); return { number: num(9) }; } });
        assert.equal(await w.freshnessHead(), null);
        fail = false;
        assert.equal(await w.freshnessHead(), 9);
    });
});

// --- the locks route as server.js registers it (finding 5) ---
describe('finding 5: /api/account/:a/locks carries freshness through the server\'s own registration (real handler)', () => {
    let server, base;
    before(async () => {
        freshDb();
        db.setSyncState('chain_index', { headSeen: 4321, latestScannedBlock: 4321, status: 'Synced' });
        const app = express();
        const ac = (v) => ({ toString: () => String(v), toBigInt: () => BigInt(v), toNumber: () => Number(v) });
        const ctx = {
            console: quiet, Number, String, Array, Math, JSON, Promise, Object, Error, Date, setTimeout, clearTimeout, process: { env: {} },
            app, db, buildFreshness, lowestTailFrom, registerBalanceLocksRoute, isFreshRequest, isRpcReady: () => true, DEV_API_TIMEOUT_MS: 30_000,
            CHAIN_INDEX_INTERVAL_MS: 12_000, STAKING_REWARDS_INTERVAL_MS: 60_000, THIRTY_SECONDS: 30_000,
            globalApi: {
                rpc: { chain: { getHeader: async () => ({ number: num(4400) }) } },
                query: { system: { account: async () => ({ data: { free: ac(10n ** 13n), reserved: ac(0), frozen: ac(0) } }) }, balances: {} },
                consts: { balances: { existentialDeposit: ac(10n ** 12n) } }
            },
            requireRpc: () => true, gateAddressParams: (req) => ({ address: req.params.address }),
            cacheShort: (res) => res.set('Cache-Control', 'public, max-age=5'), serverError: (res, err) => res.status(500).json({ error: String(err && err.message) })
        };
        vm.createContext(ctx);
        const reg = SERVER.slice(SERVER.indexOf('registerBalanceLocksRoute(app, {'), SERVER.indexOf('\n', SERVER.indexOf('registerBalanceLocksRoute(app, {')));
        vm.runInContext([optLine('const FRESHNESS_HEAD_TIMEOUT_MS'), optLine('const FRESHNESS_HEAD_MEMO_MS'), optLine('const freshnessHeadMemo'), bodyOf(SERVER, 'withTimeout'),
            bodyOf(SERVER, 'lowestHoleFrom'), 'async ' + bodyOf(SERVER, 'freshnessHead'), bodyOf(SERVER, 'freshnessNow'), 'async ' + bodyOf(SERVER, 'routeFreshness'), reg].join('\n'), ctx);
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    test('the response carries the server\'s freshness: the node head and the chain watermark (regression guard)', async () => {
        const r = await fetch(`${base}/api/account/${ME}/locks?fresh=1`);
        const body = await r.json();
        assert.equal(r.status, 200, JSON.stringify(body));
        assert.ok(body.freshness, 'the locks route as server.js registers it has no freshness');
        assert.equal(body.freshness.chainHead, 4400);
        assert.equal(body.freshness.indexed.chain, 4321);
        assert.equal(caughtUp('locks', body.freshness, 4400), true);
    });
});
