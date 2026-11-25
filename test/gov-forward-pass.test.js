// R4 regression guard: the indexer's forward pass starts the governance syncs from a block's SIGNED CALLS,
// not only from its events. A council candidacy (elections.submitCandidacy) and a council vote (elections.vote)
// emit no event, so without the calls a block holding only one of them would never start a council sync.
// Runs the real scanSingleBlock, scanChainRange and syncChainIndex from server.js in a vm over a real temp
// database; only the chain (a fake api serving one block) and the sync starter (a recorder) are fake.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as db from '../db.js';
import { govSyncsForEvents, govCallsOf } from '../lib/gov-refresh.js';
import { contiguousWatermark, isCaughtUp, readHeadSeen } from '../lib/watermark.js';
import { addTail, takeFromTail, tailSize, normalizeTail } from '../lib/skip-tail.js';
import { deriveIndexStatus, describeIndexStatus } from '../lib/index-status.js';
import { buildFreshness, lowestTailFrom } from '../lib/freshness.js';
import { readRepo, bodyOf } from './helpers/source.js';

const SERVER = readRepo('server.js', import.meta.url);
const quiet = { warn() {}, log() {}, error() {} };
const num = (n) => ({ toNumber: () => Number(n), toString: () => String(n) });
const hex = (s) => ({ toHex: () => s, toString: () => s });
const hash64 = (n) => '0x' + n.toString(16).padStart(64, '0');
const optBody = (name, prefix = '') => { try { return prefix + bodyOf(SERVER, name); } catch { return ''; } };

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-gov-fwd-'));
    dirs.push(dir);
    return db.initDb(dir, true, { awaitMigrator: false });
}
const seedChain = (top) => {
    const rows = [];
    for (let n = 1; n <= top; n++) rows.push({ number: n, hash: hash64(n), authorAddress: 'a', authorName: 'n', extrinsicsCount: 1, eventsCount: 0, timestamp: 1 });
    db.insertBlocks(rows);
    db.setSyncState('chain_index', { initialized: true, headSeen: top, latestScannedBlock: top, oldestScannedBlock: 1, backfillCursor: 0, backfillComplete: true, status: 'Synced' });
};
// A signed extrinsic stub, as the api decodes it: the shape govCallsOf reads.
const xt = (section, method, signed = true) => ({ isSigned: signed, method: { section, method }, hash: hex('0xaa'), signer: { toString: () => '5Signer' } });

// One forward-pass tick over a head that moved one block, whose single block holds `extrinsics`.
async function tickWith(extrinsics) {
    freshDb();
    seedChain(100);
    const started = [], errors = [];
    const api = {
        rpc: { chain: {
            getHeader: async () => ({ number: num(101) }),
            getBlock: async () => ({ block: { header: { hash: hex(hash64(101)) }, extrinsics } })
        } },
        derive: { chain: { getHeader: async () => ({ author: { toString: () => '5Author' } }) } }
    };
    const ctx = {
        console: quiet, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object, Error,
        db, govSyncsForEvents, govCallsOf, contiguousWatermark, isCaughtUp, readHeadSeen, addTail, takeFromTail, tailSize, normalizeTail,
        deriveIndexStatus, describeIndexStatus, buildFreshness, lowestTailFrom,
        isSyncingChain: false, lastRecentGapScanAt: Date.now(), lastFullGapScanAt: Date.now(), gapAttempts: new Map(), gapsExhausted: 0, gapRotationTick: 0, gapAttemptsResetAt: Date.now(),
        BLOCKS_FORWARD_MAX: 500, BLOCKS_BACKFILL_CHUNK: 200, BLOCKS_MIN_BLOCK: 1, BLOCKS_FETCH_CONCURRENCY: 8, BLOCKS_GAP_FILL_CHUNK: 50,
        SCAN_GAP_FILL_BATCH: 20, SCAN_MAX_ATTEMPTS: 10, SKIP_RECORD_MAX: 2000, SKIP_DRAIN_PER_TICK: 500, EVENTS_STRICT: false,
        CHAIN_GAP_SCAN_MS: 1e12, CHAIN_FULL_GAP_SCAN_MS: 1e12, CHAIN_GAP_SCAN_WINDOW: 5000, CHAIN_FULL_SCAN_WINDOW: 500000, GAP_SCAN_SLICE: 5000, GAP_SCAN_SLOW_MS: 1e9,
        GAP_ATTEMPT_RESET_MS: 1e12, DEFAULT_MAX_GAP_ATTEMPTS: 5, CHAIN_INDEX_INTERVAL_MS: 12_000, STAKING_REWARDS_INTERVAL_MS: 60_000, THIRTY_SECONDS: 30_000,
        isRpcReady: () => true, inBackoff: () => false, recordChainHead() {}, noteSyncError() {},
        logSyncError: (label, err) => { errors.push(err); },
        isRpcUnavailableError: () => false, shortErrorMessage: (e) => String(e && e.message),
        getBlockHashCached: async (n) => hex(hash64(n)), getBlockTolerant: async () => null, getBlockTimestamp: () => 1,
        getEventsAtBlock: async () => [], warnNoHistoricalEvents() {}, noteIdentityEvents() {}, noteRewardEvents() {},
        getIdentityForStore: async () => ({ known: false, name: null }), noteUnnamed() {}, attachAccounts() {}, ACCOUNT_LINK_RULES: [],
        deriveTransactionsFromLocalEvents() { return 0; }, runGovSync: (name) => started.push(name),
        scanGapsYielding: async () => ({ gaps: [], longestMs: 0, slices: 0 }), chooseGap: () => null, exhaustedGapCount: () => 0, shouldRetire: () => false, recordAttempt() {},
        reorgSweep: async () => {},
        globalApi: api
    };
    vm.createContext(ctx);
    vm.runInContext([
        'async ' + bodyOf(SERVER, 'scanSingleBlock'), 'async ' + bodyOf(SERVER, 'scanChainRange'), bodyOf(SERVER, 'recordChainScanFailures'),
        bodyOf(SERVER, 'recordSkippedRange'), bodyOf(SERVER, 'drainSkipTail'), optBody('deferTransientChainHeights'),
        'async ' + bodyOf(SERVER, 'syncChainIndex'), bodyOf(SERVER, 'lowestHoleFrom'), bodyOf(SERVER, 'freshnessNow'),
        'globalThis.__c = { syncChainIndex };'
    ].join('\n'), ctx);
    await ctx.__c.syncChainIndex();
    assert.deepEqual(errors, [], 'the tick threw: ' + errors.map(e => e && e.message).join('; '));
    assert.equal(db.getSyncState('chain_index').headSeen, 101, 'fixture: the forward pass did not reach the new block');
    return started;
}

describe('the forward pass starts governance syncs from a block\'s signed calls (guard)', () => {
    test('a block holding only a signed elections.submitCandidacy starts the council sync', async () => {
        const started = await tickWith([xt('timestamp', 'set', false), xt('elections', 'submitCandidacy')]);
        assert.ok(started.includes('council'), 'a candidacy (no event) did not start a council sync; started: ' + started.join(','));
    });
    test('a block holding only a signed elections.vote starts the council sync', async () => {
        const started = await tickWith([xt('timestamp', 'set', false), xt('elections', 'vote')]);
        assert.ok(started.includes('council'), 'a council vote (no event) did not start a council sync; started: ' + started.join(','));
    });
    test('a block with no governance call starts no sync', async () => {
        const started = await tickWith([xt('timestamp', 'set', false), xt('balances', 'transfer')]);
        assert.deepEqual(started, []);
    });
});
