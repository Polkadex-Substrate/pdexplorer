// R4 server side (design 2026-11-22-post-action-refresh-design.md, sections 5 and 9 "R4"): each governance
// sync records `atBlock`, the node's head read BEFORE its state queries, in its KV snapshot, and the four
// governance routes expose it as freshness.kv.X, so the page can tell when the server has caught up with the
// block its transaction landed in. A route that also serves the governance history index (council and
// technical committee motion history, treasury proposal history) is only as fresh as the lower of the
// snapshot and that index's verified watermark. Additive only: an older client reads every field it read
// before, and a snapshot written before R4 (no atBlock) answers "unknown", never caught up.
//
// The handlers and the sync passes are the real ones, lifted from server.js over a seeded temp database;
// only the chain is fake.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as db from '../db.js';
import { buildFreshness, kvMark, caughtUp } from '../lib/freshness.js';
import { isFreshRequest } from '../lib/gov-refresh.js';
import { readHeadSeen } from '../lib/watermark.js';
import { readRepo, bodyOf } from './helpers/source.js';

const SERVER = readRepo('server.js', import.meta.url);

function routeSource(p) {
    const start = SERVER.indexOf(`app.get('${p}'`);
    assert.ok(start !== -1, `route ${p} not found`);
    let i = SERVER.indexOf('=> {', start) + 3, depth = 0;
    for (; i < SERVER.length; i++) {
        if (SERVER[i] === '{') depth++;
        else if (SERVER[i] === '}' && --depth === 0) break;
    }
    return SERVER.slice(start, SERVER.indexOf(';', i) + 1);
}
const optFn = (name) => { try { return bodyOf(SERVER, name); } catch (e) { return ''; } };
const optLine = (start) => { const i = SERVER.indexOf(start); return i === -1 ? '' : SERVER.slice(i, SERVER.indexOf('\n', i)); };
const fakeRes = () => { const r = { headers: {}, statusCode: 200, body: undefined, set(k, v) { r.headers[k.toLowerCase()] = v; return r; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = JSON.parse(JSON.stringify(b)); return r; } }; return r; };
const num = (n) => ({ toNumber: () => Number(n), toString: () => String(n), toBigInt: () => BigInt(n), toJSON: () => Number(n) });
const list = (arr) => Object.assign(arr.slice(), { toJSON: () => arr.slice() });
const none = { isSome: false, isNone: true };

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-r4-routes-'));
    dirs.push(dir);
    db.initDb(dir, true, { awaitMigrator: false });
});

// One world: a fake chain that logs the order of its reads, the real routes and sync passes.
function world({ head = 1000 } = {}) {
    const order = [];
    const read = (v) => async () => { order.push('state'); return v; };
    const api = {
        rpc: { chain: { getHeader: async () => { order.push('head'); return { number: num(head) }; } } },
        query: {
            system: { number: read(num(head)), account: read({ data: { free: num(5n * 10n ** 12n) } }) },
            balances: { totalIssuance: read(num(10n ** 15n)) },
            treasury: { proposals: { entries: read([]) }, approvals: read(list([])), proposalCount: read(num(3)) },
            elections: { members: read(list([])), runnersUp: read(list([])), candidates: read(list([])) },
            council: { proposals: read(list([])), proposalOf: read(none) },
            technicalCommittee: { members: read(list([])), prime: read(none), proposals: read(list([])), proposalCount: read(num(0)) },
            democracy: { referendumCount: read(num(0)), publicPropCount: read(num(0)), publicProps: read(list([])), nextExternal: read(none),
                lowestUnbaked: read(num(0)), depositOf: read(none), referendumInfoOf: read(none) }
        },
        consts: { treasury: { spendPeriod: num(100), burn: num(0) }, elections: { termDuration: num(100), desiredMembers: num(3), desiredRunnersUp: num(1) },
            democracy: { launchPeriod: num(50) } }
    };
    const handlers = {};
    const noop = () => {};
    const ctx = {
        console: { warn: noop, log: noop, error: noop }, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object, Error, setTimeout, clearTimeout, process: { env: {} },
        app: { get: (p, fn) => { handlers[p] = fn; } },
        globalApi: api, db, buildFreshness, kvMark, isFreshRequest, readHeadSeen,
        cacheShort: (res) => res.set('Cache-Control', 'short'), isRpcReady: () => true,
        withReferendumThreads: (rows) => rows, getIdentity: async () => 'Unknown', balanceToPDEX: (v) => Number(String(v)) / 1e12,
        logSyncError: (label, err) => { ctx.syncErrors.push(`${label}: ${err && err.message}`); }, syncErrors: [],
        isSyncingTreasury: false, isSyncingCouncil: false, isSyncingDemocracy: false, TREASURY_ACCOUNT: 'treasury-account', chainSS58: 88,
        readLiveCollectiveMotions: async () => ({ motions: [], trusted: true }), upsertLiveCollectiveMotions: noop,
        reconcileGovThreads: noop, motionReadTrusted: () => false, threadHighWater: () => 0, proposalHashOf: () => null, blake2AsHex: () => '0x',
        referendumReadTrusted: () => false, proposalReadTrusted: () => false, externalReadTrusted: () => false, externalLaunchedReason: () => null,
        linkMotionThreadsFromDemocracy: noop, fallbackMotionItems: async () => [], backfillMotionProposalHashes: async () => {},
        describeProposalCall: () => null, referendumTitle: () => '', referendumThreadId: (i) => `referendum-${i}`, externalThreadId: () => 'external',
        externalTitle: () => '', getBlockHashCached: async () => '0x', DEV_API_TIMEOUT_MS: 30_000,
        dispatchGovernanceEmails: async () => {}, noteSyncError: noop
    };
    vm.createContext(ctx);
    vm.runInContext([optLine('const FRESHNESS_HEAD_TIMEOUT_MS'), optLine('const FRESHNESS_HEAD_MEMO_MS'), optLine('const freshnessHeadMemo'),
        bodyOf(SERVER, 'withTimeout'), 'async ' + bodyOf(SERVER, 'freshnessHead'), bodyOf(SERVER, 'governanceHistoryMeta'), optFn('govFreshness'),
        'let isSyncingTechnicalCommittee = false;',
        'async ' + bodyOf(SERVER, 'syncTreasuryPass'), 'async ' + bodyOf(SERVER, 'syncCouncilPass'), 'async ' + bodyOf(SERVER, 'syncTechnicalCommitteePass'), 'async ' + bodyOf(SERVER, 'syncDemocracyPass'),
        routeSource('/api/council'), routeSource('/api/technical-committee'), routeSource('/api/treasury'), routeSource('/api/democracy')].join('\n'), ctx);
    const call = async (p, query = {}) => { const res = fakeRes(); await handlers[p]({ params: {}, query, path: p }, res); return res; };
    return { api, order, call, ctx };
}

// What the pre-R4 page reads from each route (script.js fetchCouncilData, fetchTechnicalCommitteeData,
// renderTreasury, renderDemocracy at 48b0260): the older client's fixture.
const OLDER_CLIENT = {
    '/api/council': ['members', 'runnersUp', 'candidates', 'motions', 'currentBlock', 'termDuration', 'blocksRemaining', 'desiredMembers', 'desiredRunnersUp', 'pallet', 'collectivePallet', 'motionHistory', 'history'],
    '/api/technical-committee': ['members', 'prime', 'motions', 'proposalCount', 'currentBlock', 'collectivePallet', 'motionHistory', 'history'],
    '/api/treasury': ['proposals', 'approvals', 'spendPeriod', 'burn', 'blocksRemaining', 'spendableFunds', 'proposalCount', 'allProposals', 'history'],
    '/api/democracy': ['referendumCount', 'publicPropCount', 'activeReferenda', 'activeProposals', 'launchPeriod', 'currentBlock', 'lowestUnbaked', 'totalIssuance', 'publicProposals', 'externalProposal', 'referenda', 'lastSync', 'status']
};

describe('the syncs record atBlock: the head read before their state queries', () => {
    for (const [pass, kvKey] of [['syncTreasuryPass', 'treasury'], ['syncCouncilPass', 'council'], ['syncTechnicalCommitteePass', 'technicalCommittee'], ['syncDemocracyPass', 'democracy_meta']]) {
        test(`${pass} writes atBlock into the ${kvKey} snapshot`, async () => {
            db.setKv(kvKey, null);
            const w = world({ head: 1234 });
            await w.ctx[pass]();
            assert.deepEqual(w.ctx.syncErrors, [], 'the pass failed');
            const snap = db.getKv(kvKey);
            assert.ok(snap, 'no snapshot written');
            assert.equal(snap.atBlock, 1234, `${kvKey} has no atBlock`);
            assert.equal(w.order[0], 'head', `the head was not read before the state: ${w.order.slice(0, 4).join(',')}`);
        });
    }
    test('a head that cannot be read is recorded as unknown (null), and the snapshot is still written', async () => {
        db.setKv('treasury', null);
        const w = world();
        w.api.rpc.chain.getHeader = async () => { throw new Error('node gone'); };
        await w.ctx.syncTreasuryPass();
        const snap = db.getKv('treasury');
        assert.ok(snap && snap.proposalCount === 3, 'the snapshot was not written');
        assert.equal(snap.atBlock, null);
    });
});

describe('the governance routes expose freshness.kv (real handlers, seeded database)', () => {
    const seed = () => {
        db.setSyncState('governance', { latestScannedBlock: 940, headSeen: 945, status: 'Synced' });
        db.setKv('council', { members: [{ address: 'm1', name: 'M', stake: 1 }], runnersUp: [], candidates: [], motions: [], currentBlock: 950, termDuration: 100, blocksRemaining: 50,
            desiredMembers: 3, desiredRunnersUp: 1, pallet: 'elections', collectivePallet: 'council', lastSync: 1, atBlock: 950 });
        db.setKv('technicalCommittee', { members: [], prime: null, motions: [], proposalCount: 0, currentBlock: 930, collectivePallet: 'technicalCommittee', lastSync: 1, atBlock: 930 });
        db.setKv('treasury', { proposals: [], approvals: [], spendPeriod: 100, burn: 0, blocksRemaining: 4, spendableFunds: 12.5, proposalCount: 3, atBlock: 960 });
        db.setKv('democracy_meta', { referendumCount: 2, publicPropCount: 1, launchPeriod: 50, currentBlock: 955, totalIssuance: 9, lowestUnbaked: 0, activeReferenda: 0,
            activeProposals: 0, publicProposals: [], externalProposal: null, lastSync: 1, atBlock: 955 });
    };
    test('each route: its own snapshot mark, lowered to the history index where the route serves it', async () => {
        seed();
        const w = world();
        const want = { '/api/council': ['council', 940], '/api/technical-committee': ['technicalCommittee', 930], '/api/treasury': ['treasury', 940], '/api/democracy': ['democracy', 955] };
        for (const [route, [key, mark]] of Object.entries(want)) {
            const r = await w.call(route);
            assert.equal(r.statusCode, 200, route);
            const f = r.body.freshness;
            assert.ok(f, `${route} has no freshness`);
            assert.equal(f.kv[key], mark, `${route}: kv.${key}`);
            for (const other of ['council', 'democracy', 'treasury', 'technicalCommittee'].filter(k => k !== key)) assert.equal(f.kv[other], null, `${route} claims kv.${other}`);
        }
        const council = (await w.call('/api/council')).body.freshness;
        assert.equal(caughtUp('council.elections', council, 940), true);
        assert.equal(caughtUp('council.motions', council, 941), false, 'the motion history index is behind: the route is not caught up past it');
        assert.equal(w.order.length, 0, 'a route read the chain');
    });
    test('a snapshot written before R4 (no atBlock) is unknown: never caught up, and the route still answers', async () => {
        seed();
        for (const k of ['council', 'technicalCommittee', 'treasury', 'democracy_meta']) { const s = db.getKv(k); delete s.atBlock; db.setKv(k, s); }
        const w = world();
        for (const route of Object.keys(OLDER_CLIENT)) {
            const r = await w.call(route);
            assert.equal(r.statusCode, 200, route);
            assert.ok(r.body.freshness, `${route} has no freshness`);
            assert.ok(Object.values(r.body.freshness.kv).every(v => v === null), `${route}: ${JSON.stringify(r.body.freshness.kv)}`);
        }
    });
    test('no governance index yet: the routes that serve its history are unknown', async () => {
        seed();
        db.setSyncState('governance', {});
        const w = world();
        assert.equal((await w.call('/api/council')).body.freshness.kv.council, null);
        assert.equal((await w.call('/api/democracy')).body.freshness.kv.democracy, 955, 'democracy does not serve the history index');
    });
    test('additive: the older client fixture reads every field it read before, with the same value; caching unchanged', async () => {
        seed();
        const w = world();
        for (const [route, fields] of Object.entries(OLDER_CLIENT)) {
            const fresh = await w.call(route, { fresh: '1' });
            const plain = await w.call(route);
            assert.equal(fresh.headers['cache-control'], 'no-store', route);
            assert.equal(plain.headers['cache-control'], 'short', route);
            for (const k of fields) assert.ok(Object.prototype.hasOwnProperty.call(plain.body, k), `${route} lost ${k}`);
            const extra = Object.keys(plain.body).filter(k => !fields.includes(k));
            assert.ok(extra.every(k => k === 'freshness' || k === 'atBlock' || k === 'lastSync'), `${route} added ${extra.join(', ')}`);
        }
        const c = (await w.call('/api/council')).body;
        assert.deepEqual(c.members, [{ address: 'm1', name: 'M', stake: 1 }]);
        assert.equal(c.desiredMembers, 3);
        const t = (await w.call('/api/treasury')).body;
        assert.equal(t.spendableFunds, 12.5);
        const d = (await w.call('/api/democracy')).body;
        assert.equal(d.referendumCount, 2);
        assert.equal(d.currentBlock, 955);
    });
});
