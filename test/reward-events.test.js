// The unpaid list catches up in the forward pass (design section 5, row rewards.unpaid; sprint R2; Q5: the
// 60 s rewards scan stays as it is). When the block indexer sees staking.Rewarded for (stash, era,
// validator), the matching unclaimed-cache pair is deleted at once. Era and validator are attributed exactly
// the way syncStakingRewards attributes them (the payout extrinsic's call, and for a multi-item batch the
// utility delimiters, lib/reward-attribution.js); a reward that cannot be attributed to one pair marks the
// stash's unclaimed cache stale instead (the next read recomputes it from chain state) and never deletes a
// guessed pair. Keys are normalised like lib/reward-dedup.js claimedRewardKey (Number(era), the canonical
// SS58 address). It is wrapped so a throw can never stop block indexing, it is bounded per block, idempotent
// on a re-scan, and a reorged block marks the fork's stashes stale.
//
// Addresses are the public substrate dev accounts; the events carry them in the generic format (prefix 42),
// the cache stores them in this chain's (prefix 88), so a missing normalisation fails these tests.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { rewardNotesForBlock, storedRewardStash, REWARD_NOTES_MAX_PER_BLOCK } from '../lib/reward-events.js';
import { isAttributableBatch } from '../lib/reward-attribution.js';
import { claimedRewardKey } from '../lib/reward-dedup.js';
import { readRepo, bodyOf } from './helpers/source.js';
import { ME, OTHER, V1, V2, V3 } from './helpers/payout-events.js';

const SERVER = readRepo('server.js', import.meta.url);
const at88 = (a) => encodeAddress(decodeAddress(a), 88);
const norm = (a) => at88(a);

// --- fake chain objects in the shapes @polkadot/api hands the indexer ---
const str = (v) => ({ toString: () => String(v), toNumber: () => Number(v) });
const payoutCall = (validator, era) => ({ section: 'staking', method: 'payoutStakers', args: [str(validator), str(era)] });
const batchCall = (method, calls) => ({ section: 'utility', method, args: [calls] });
const proxyCall = (inner) => ({ section: 'proxy', method: 'proxy', args: [str(ME), null, inner] });
const ext = (method, signer = ME) => ({ method, isSigned: true, signer: str(signer), hash: { toHex: () => '0x' + 'ee'.repeat(32) } });
const TIMESTAMP_EXT = { method: { section: 'timestamp', method: 'set', args: [str(1)] }, isSigned: false, hash: { toHex: () => '0x' + '00'.repeat(32) } };
const data = (arr) => Object.assign(arr.map(v => (typeof v === 'object' && v && v.toString !== Object.prototype.toString ? v : str(v))), { toHuman: () => arr.map(String) });
const rec = (exIndex, section, method, args = []) => ({
    phase: exIndex == null ? { isApplyExtrinsic: false } : { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => exIndex } },
    event: { section, method, data: data(args) }
});
const rewarded = (ex, stash, amount = '1000000000000') => rec(ex, 'staking', 'Rewarded', [stash, 'Staked', amount]);
const done = (ex) => rec(ex, 'utility', 'ItemCompleted');
const failed = (ex) => rec(ex, 'utility', 'ItemFailed', ['AlreadyClaimed']);
const started = (ex, era, v) => rec(ex, 'staking', 'PayoutStarted', [era, v]);

// The server's own parse and attribution, lifted (the forward pass must attribute as syncStakingRewards does).
function serverParts() {
    const ctx = { console, Number, String, Array, isAttributableBatch, balanceToPDEX: (v) => Number(String(v)) / 1e12, encodeAddress, decodeAddress, chainSS58: 88 };
    vm.createContext(ctx);
    vm.runInContext([bodyOf(SERVER, 'parseRewardedEvent'), bodyOf(SERVER, 'findPayoutInfo'), bodyOf(SERVER, 'extractPayoutInfo'), bodyOf(SERVER, 'normalizeAddress'),
        'globalThis.__p = { parseRewardedEvent, extractPayoutInfo, normalizeAddress };'].join('\n'), ctx);
    return ctx.__p;
}
const P = serverParts();
const notes = (records, extrinsics, opts = {}) => rewardNotesForBlock(records, { parse: P.parseRewardedEvent, payoutInfo: (i) => P.extractPayoutInfo(extrinsics[i]), normalize: P.normalizeAddress, ...opts });

describe('rewardNotesForBlock: which pair a Rewarded belongs to', () => {
    test('a bare payoutStakers: the call\'s era and validator, normalised', () => {
        const n = notes([started(1, 501, V1), rewarded(1, V1), rewarded(1, ME)], [TIMESTAMP_EXT, ext(payoutCall(V1, 501))]);
        assert.deepEqual(n.pairs, [{ stash: at88(V1), era: 501, validator: at88(V1) }, { stash: at88(ME), era: 501, validator: at88(V1) }]);
        assert.deepEqual(n.stale, []);
    });
    test('a forceBatch of direct payouts: attributed per item by the utility delimiters; a failed item attributes nothing', () => {
        const records = [rewarded(1, ME), done(1), failed(1), rewarded(1, OTHER), done(1)];
        const n = notes(records, [TIMESTAMP_EXT, ext(batchCall('forceBatch', [payoutCall(V1, 501), payoutCall(V2, 501), payoutCall(V3, 502)]))]);
        assert.deepEqual(n.pairs, [{ stash: at88(ME), era: 501, validator: at88(V1) }, { stash: at88(OTHER), era: 502, validator: at88(V3) }]);
        assert.deepEqual(n.stale, []);
    });
    test('a one-item batch keeps its validator', () => {
        const n = notes([rewarded(1, ME), done(1)], [TIMESTAMP_EXT, ext(batchCall('batch', [payoutCall(V2, 600)]))]);
        assert.deepEqual(n.pairs, [{ stash: at88(ME), era: 600, validator: at88(V2) }]);
    });
    test('a nested batch cannot be attributed: no pair is guessed, the stash is marked stale with the era it knows', () => {
        const nested = batchCall('batch', [batchCall('batch', [payoutCall(V1, 501), payoutCall(V2, 501)]), payoutCall(V3, 501)]);
        const n = notes([rewarded(1, ME), done(1), rewarded(1, ME), done(1), done(1)], [TIMESTAMP_EXT, ext(nested)]);
        assert.deepEqual(n.pairs, []);
        assert.deepEqual(n.stale, [{ stash: at88(ME), era: 501 }]);
    });
    test('a proxy-wrapped single payout is attributed through the wrapper, as syncStakingRewards does', () => {
        const n = notes([rewarded(1, ME)], [TIMESTAMP_EXT, ext(proxyCall(payoutCall(V1, 700)))]);
        assert.deepEqual(n.pairs, [{ stash: at88(ME), era: 700, validator: at88(V1) }]);
    });
    test('a Rewarded outside any extrinsic, or inside a call that is no payout: stale, era unknown', () => {
        const n = notes([rewarded(null, ME), rewarded(1, OTHER)], [TIMESTAMP_EXT, ext({ section: 'balances', method: 'transfer', args: [] })]);
        assert.deepEqual(n.pairs, []);
        assert.deepEqual(n.stale, [{ stash: at88(ME), era: null }, { stash: at88(OTHER), era: null }]);
    });
    test('duplicates collapse on the claimedRewardKey of the pair; other events are ignored', () => {
        const n = notes([rewarded(1, ME), rewarded(1, ME), rec(1, 'balances', 'Transfer', [ME, OTHER, '1'])], [TIMESTAMP_EXT, ext(payoutCall(V1, 501))]);
        assert.equal(n.pairs.length, 1);
        assert.equal(claimedRewardKey(n.pairs[0].era, n.pairs[0].validator), claimedRewardKey('501', at88(V1)));
    });
    test('an address that does not decode is skipped, never written', () => {
        const n = notes([rewarded(1, 'not-an-address')], [TIMESTAMP_EXT, ext(payoutCall(V1, 501))]);
        assert.deepEqual(n, { pairs: [], stale: [], seen: 1, truncated: false });
    });
    test('bounded: at most max rewards per block are read; the rest are counted as truncated', () => {
        const many = Array.from({ length: 10 }, () => rewarded(1, ME));
        const n = notes(many, [TIMESTAMP_EXT, ext(payoutCall(V1, 501))], { max: 3 });
        assert.equal(n.seen, 3);
        assert.equal(n.truncated, true);
        assert.ok(REWARD_NOTES_MAX_PER_BLOCK >= 512 && REWARD_NOTES_MAX_PER_BLOCK <= 10_000, `${REWARD_NOTES_MAX_PER_BLOCK}`);
    });
    test('a parse that throws on one record skips that record only', () => {
        let n = 0;
        const parse = (r) => { if (r.event.method === 'Rewarded' && n++ === 0) throw new Error('odd'); return P.parseRewardedEvent(r); };
        const out = notes([rewarded(1, OTHER), rewarded(1, ME)], [TIMESTAMP_EXT, ext(payoutCall(V1, 501))], { parse });
        assert.deepEqual(out.pairs, [{ stash: at88(ME), era: 501, validator: at88(V1) }]);
    });
    test('storedRewardStash reads the stash from the stored (toHuman) event data, named or positional', () => {
        assert.equal(storedRewardStash({ stash: ME, dest: 'Staked', amount: '1' }), ME);
        assert.equal(storedRewardStash([ME, 'Staked', '1']), ME);
        assert.equal(storedRewardStash({ who: OTHER }), OTHER);
        assert.equal(storedRewardStash(null), null);
        assert.equal(storedRewardStash('x'), null);
    });
});

// A real database in a temp directory (the schema the server runs).
const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-r2-rewards-'));
    dirs.push(dir);
    const h = db.initDb(dir, true, { awaitMigrator: false });
    for (const idx of ['idx_tx_timestamp', 'idx_blocks_timestamp', 'idx_events_signer_block']) h.exec(`DROP INDEX IF EXISTS ${idx}`);
    return h;
}
const cached = (stash) => db.getUnclaimed(stash).map(r => `${r.era}:${r.validator}`).sort();

describe('db.noteRewardedPairs on a real database', () => {
    let h;
    before(() => { h = freshDb(); });
    test('a pair deletes exactly the matching unclaimed row, and only it', () => {
        db.replaceUnclaimed(at88(ME), [{ era: 501, validator: at88(V1), amount: 1 }, { era: 501, validator: at88(V2), amount: 2 }, { era: 502, validator: at88(V1), amount: 3 }]);
        db.replaceUnclaimed(at88(OTHER), [{ era: 501, validator: at88(V1), amount: 4 }]);
        const out = db.noteRewardedPairs({ pairs: [{ stash: at88(ME), era: 501, validator: at88(V1) }], stale: [] });
        assert.equal(out.deleted, 1);
        assert.deepEqual(cached(at88(ME)), [`501:${at88(V2)}`, `502:${at88(V1)}`]);
        assert.deepEqual(cached(at88(OTHER)), [`501:${at88(V1)}`], 'another stash lost its row');
    });
    test('idempotent: the same pairs again change nothing', () => {
        const before = cached(at88(ME));
        const out = db.noteRewardedPairs({ pairs: [{ stash: at88(ME), era: 501, validator: at88(V1) }], stale: [] });
        assert.equal(out.deleted, 0);
        assert.deepEqual(cached(at88(ME)), before);
    });
    test('stale: only a stash with a cached row of that era (or any row when the era is unknown) is marked; no kv row is created', () => {
        db.replaceUnclaimed(at88(V3), [{ era: 900, validator: at88(V1), amount: 1 }]);
        assert.ok(db.getUnclaimedComputedAt(at88(V3)) > 0);
        let out = db.noteRewardedPairs({ pairs: [], stale: [{ stash: at88(V3), era: 901 }] });
        assert.equal(out.marked, 0, 'marked for an era it does not cache');
        assert.ok(db.getUnclaimedComputedAt(at88(V3)) > 0);
        out = db.noteRewardedPairs({ pairs: [], stale: [{ stash: at88(V3), era: 900 }] });
        assert.equal(out.marked, 1);
        assert.equal(db.getUnclaimedComputedAt(at88(V3)), 0, 'not stale: the next read would not recompute');
        assert.deepEqual(cached(at88(V3)), [`900:${at88(V1)}`], 'a stale mark deleted a guessed row');
        const unknown = at88('5HpG9w8EBLe5XCrbczpwq5TSXvedjrBGCwqxK1iQ7qUsSWFc');
        out = db.noteRewardedPairs({ pairs: [], stale: [{ stash: unknown, era: null }] });
        assert.equal(out.marked, 0);
        assert.equal(db.getKv('unclaimed_at:' + unknown), null, 'a kv row was created for a stash nobody cached');
    });
    test('the lowest failure at or above a height', () => {
        db.recordScanFailure('chain_index', 100, 'x');
        db.recordScanFailure('chain_index', 500, 'y');
        assert.equal(db.getLowestScanFailureFrom('chain_index', 1), 100);
        assert.equal(db.getLowestScanFailureFrom('chain_index', 101), 500);
        assert.equal(db.getLowestScanFailureFrom('chain_index', 501), null);
        assert.equal(db.getLowestScanFailureFrom('transactions', 1), null);
    });
});

describe('query plans (no full scan of blocks, events or extrinsics; a database WITHOUT the optional indexes)', () => {
    const planOf = (h, sql, args) => h.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail);
    test('every new statement uses an index', () => {
        const h = freshDb();
        const cases = [
            [db.UNCLAIMED_PAIR_DELETE_SQL, [at88(ME), 501, at88(V1)], /^SEARCH staking_rewards_unclaimed USING (INDEX|PRIMARY KEY|COVERING INDEX) sqlite_autoindex_staking_rewards_unclaimed_1 \(stash=\? AND era=\? AND validator=\?\)$/],
            [db.UNCLAIMED_STALE_SQL, [1, 'unclaimed_at:x', 'x', 501, 501], /^SEARCH kv USING INDEX sqlite_autoindex_kv_1 \(key=\?\)$/],
            [db.FORK_REWARD_EVENTS_SQL, [100, '0xabc'], /^SEARCH events USING INDEX idx_events_block \(block=\?\)$/],
            [db.LOWEST_SCAN_FAILURE_FROM_SQL, ['chain_index', 100], /^SEARCH scan_failures USING (COVERING INDEX|INDEX|PRIMARY KEY) sqlite_autoindex_scan_failures_1 \(indexer=\? AND block>\?\)$/]
        ];
        for (const [sql, args, first] of cases) {
            assert.equal(typeof sql, 'string');
            const plan = planOf(h, sql, args);
            const joined = plan.join(' | ');
            assert.match(plan[0], first, joined);
            assert.doesNotMatch(joined, /\bSCAN (blocks|events|extrinsics|staking_rewards_unclaimed|kv|scan_failures)\b/, joined);
        }
        // The stale mark's EXISTS reads the unclaimed table by its stash index, never a scan.
        const stalePlan = planOf(h, db.UNCLAIMED_STALE_SQL, [1, 'unclaimed_at:x', 'x', 501, 501]).join(' | ');
        assert.match(stalePlan, /SEARCH staking_rewards_unclaimed USING (COVERING )?INDEX (sqlite_autoindex_staking_rewards_unclaimed_1|idx_sru_stash) \(stash=\?/, stalePlan);
    });
});

// The real forward-pass function (server.js scanSingleBlock) on fake blocks, with the real reward note and
// the real database. Only the chain is fake.
function forwardPass({ failNotes = false, cap = REWARD_NOTES_MAX_PER_BLOCK } = {}) {
    const blocks = new Map();
    const ctx = {
        console: { warn: () => {}, log: () => {}, error: () => {} }, Number, String, Array, Set, Map, Math, Date, JSON, Promise,
        isAttributableBatch, rewardNotesForBlock, storedRewardStash, encodeAddress, decodeAddress, chainSS58: 88, REWARD_NOTES_MAX_PER_BLOCK: cap,
        balanceToPDEX: (v) => Number(String(v)) / 1e12,
        db: failNotes ? { ...db, noteRewardedPairs: () => { throw new Error('database is locked'); } } : db,
        isRpcReady: () => true, isRpcUnavailableError: () => false, EVENTS_STRICT: true,
        getBlockHashCached: async (n) => ({ toHex: () => blocks.get(n).hash }),
        getEventsAtBlock: async (hash) => { for (const b of blocks.values()) if (b.hash === hash.toHex()) return b.events; return null; },
        getBlockTimestamp: () => 1_700_000_000_000, warnNoHistoricalEvents() {}, noteIdentityEvents() {}, getBlockTolerant: async () => null,
        getIdentityForStore: async () => ({ known: true, name: 'n' }), noteUnnamed() {}, attachAccounts() {}, ACCOUNT_LINK_RULES: [],
        globalApi: {
            rpc: { chain: { getBlock: async (hash) => { for (const b of blocks.values()) if (b.hash === hash.toHex()) return { block: { header: { hash: { toHex: () => b.hash } }, extrinsics: b.extrinsics } }; return null; } } },
            derive: { chain: { getHeader: async () => ({ author: str(V1) }) } }
        }
    };
    vm.createContext(ctx);
    vm.runInContext([bodyOf(SERVER, 'parseRewardedEvent'), bodyOf(SERVER, 'findPayoutInfo'), bodyOf(SERVER, 'extractPayoutInfo'), bodyOf(SERVER, 'normalizeAddress'),
        bodyOf(SERVER, 'noteRewardEvents'), 'async ' + bodyOf(SERVER, 'scanSingleBlock'), bodyOf(SERVER, 'noteReorgedRewards'),
        'globalThis.__f = { scanSingleBlock, noteReorgedRewards };'].join('\n'), ctx);
    return { blocks, ...ctx.__f };
}
const payoutBlock = (n, records, call) => ({ hash: '0x' + n.toString(16).padStart(64, '0'), events: records, extrinsics: [TIMESTAMP_EXT, ext(call)] });

describe('the forward pass (server.js scanSingleBlock) notes rewards', () => {
    let h;
    before(() => { h = freshDb(); });
    const seed = () => db.replaceUnclaimed(at88(ME), [{ era: 501, validator: at88(V1), amount: 1 }, { era: 501, validator: at88(V2), amount: 2 }, { era: 502, validator: at88(V3), amount: 3 }]);
    test('a block with Rewarded for (ME, 501, V2) removes exactly that cached pair, and the block is indexed', async () => {
        seed();
        const f = forwardPass();
        f.blocks.set(1000, payoutBlock(1000, [rewarded(1, ME), done(1), rewarded(1, OTHER), done(1)], batchCall('forceBatch', [payoutCall(V2, 501), payoutCall(V1, 501)])));
        const out = await f.scanSingleBlock(1000);
        assert.equal(out.block.number, 1000);
        assert.equal(out.events.length, 4);
        assert.deepEqual(cached(at88(ME)), [`501:${at88(V1)}`, `502:${at88(V3)}`]);
    });
    test('idempotent on a re-scanned block', async () => {
        const f = forwardPass();
        f.blocks.set(1000, payoutBlock(1000, [rewarded(1, ME), done(1), rewarded(1, OTHER), done(1)], batchCall('forceBatch', [payoutCall(V2, 501), payoutCall(V1, 501)])));
        await f.scanSingleBlock(1000);
        await f.scanSingleBlock(1000);
        assert.deepEqual(cached(at88(ME)), [`501:${at88(V1)}`, `502:${at88(V3)}`]);
    });
    test('an unattributable payout marks the stash stale and deletes no guessed pair', async () => {
        seed();
        const f = forwardPass();
        const nested = batchCall('batch', [batchCall('batch', [payoutCall(V1, 501), payoutCall(V2, 501)]), payoutCall(V3, 502)]);
        f.blocks.set(1001, payoutBlock(1001, [rewarded(1, ME), done(1), done(1), done(1)], nested));
        await f.scanSingleBlock(1001);
        assert.equal(cached(at88(ME)).length, 3);
        assert.equal(db.getUnclaimedComputedAt(at88(ME)), 0);
    });
    test('a throw inside the reward note never stops the block: it is still returned whole for indexing', async () => {
        seed();
        const f = forwardPass({ failNotes: true });
        f.blocks.set(1002, payoutBlock(1002, [rewarded(1, ME)], payoutCall(V1, 501)));
        const out = await f.scanSingleBlock(1002);
        assert.ok(out && out.block && out.block.number === 1002, 'the block was not indexed');
        assert.equal(out.events.length, 1);
    });
    test('bounded work: a block with more Rewarded events than the cap deletes at most the cap', async () => {
        const stashes = Array.from({ length: 6 }, (_, i) => encodeAddress(new Uint8Array(32).fill(i + 1), 88));
        for (const s of stashes) db.replaceUnclaimed(s, [{ era: 501, validator: at88(V1), amount: 1 }]);
        const f = forwardPass({ cap: 4 });   // the forward pass reads its bound from REWARD_NOTES_MAX_PER_BLOCK
        f.blocks.set(1003, payoutBlock(1003, stashes.map(s => rewarded(1, s)), payoutCall(V1, 501)));
        const before = stashes.filter(s => db.getUnclaimed(s).length).length;
        const out = await f.scanSingleBlock(1003);
        const left = stashes.filter(s => db.getUnclaimed(s).length).length;
        assert.equal(before, 6);
        assert.equal(before - left, 4, 'the per-block bound was not applied');
        assert.equal(out.events.length, 6, 'the bound cut the block itself short');
    });
    test('a reorged block: the fork\'s rewarded stashes are marked stale, so a pair deleted on the fork comes back on the next read', async () => {
        seed();
        db.noteRewardedPairs({ pairs: [{ stash: at88(ME), era: 501, validator: at88(V1) }], stale: [] });   // the fork's forward pass
        db.insertBlocks([{ number: 2000, hash: '0xfork', authorAddress: V1, authorName: 'n', extrinsicsCount: 2, eventsCount: 1, timestamp: 1 }]);   // the fork as the forward pass stored it
        db.insertEvents([{ hash: '0xfork-0', txHash: '0xt', blockHash: '0xfork', block: 2000, eventIndex: 0, extrinsicIndex: 1, section: 'staking', method: 'Rewarded',
            data: { stash: ME, dest: 'Staked', amount: '1' }, signerAddress: ME, signerName: 'n', timestamp: 1, status: 'success' }]);
        const f = forwardPass();
        f.noteReorgedRewards(2000, '0xcanonical');
        assert.equal(db.getUnclaimedComputedAt(at88(ME)), 0, 'the stash was not marked stale after its fork reward');
        seed();
        f.noteReorgedRewards(2000, '0xfork');   // the stored block IS canonical: nothing to undo
        assert.ok(db.getUnclaimedComputedAt(at88(ME)) > 0);
    });
    test('the reorg note never throws', () => {
        const f = forwardPass({ failNotes: true });
        assert.doesNotThrow(() => f.noteReorgedRewards(2000, '0xcanonical'));
    });
});

describe('wiring in server.js', () => {
    const code = SERVER;
    test('scanSingleBlock notes rewards right after identity events; repairReorgedBlock notes the fork before deleting its rows', () => {
        const scan = bodyOf(code, 'scanSingleBlock');
        assert.ok(scan.indexOf('noteRewardEvents(allEvents, extrinsics)') > scan.indexOf('noteIdentityEvents(allEvents)'));
        const repair = bodyOf(code, 'repairReorgedBlock');
        const a = repair.indexOf('noteReorgedRewards(n, canonicalHash)'), b = repair.indexOf('db.deleteForkRows(');
        assert.ok(a !== -1 && a < b, 'the fork rows are deleted before their stashes are read');
    });
});
