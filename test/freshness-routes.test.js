// The routes the post-action poll reads carry `freshness` (design sections 0, 2.3, 5 and 9 R2): /api/wallet,
// /api/account/:a/locks and /api/staking-rewards/:a. Additive only: every field an older client reads keeps
// its value. The node's best block is read BEFORE the route's state queries, so chainHead is a lower bound of
// the state in the response. The unpaid list is "pending" while the stash's unclaimed cache is not fresh (it
// is being recomputed, or the forward pass marked it stale), so a client never takes it as caught up.
// Caches: /api/wallet stays no-store; ?fresh=1 is no-store on locks and staking-rewards and normal traffic
// keeps its tier; /api/proxies and /api/multisigs become no-store (design section 5).
//
// The handlers are the real ones, lifted from server.js and run over a seeded temp database; only the chain
// is fake.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import * as db from '../db.js';
import { summarizeRewards } from '../lib/reward-dedup.js';
import { balanceBreakdown, accountBalances } from '../lib/balance-locks.js';
import { walletRecentFields } from '../lib/wallet-recent-tx.js';
import { buildFreshness, lowestTailFrom, caughtUp } from '../lib/freshness.js';
import { isFreshRequest } from '../lib/gov-refresh.js';
import { registerBalanceLocksRoute } from '../lib/balance-locks-api.js';
import { payoutModel } from '../lib/payout-refresh.js';
import { readRepo, bodyOf } from './helpers/source.js';
import { ME, V1, V2 } from './helpers/payout-events.js';

const SERVER = readRepo('server.js', import.meta.url);
const at88 = (a) => encodeAddress(decodeAddress(a), 88);
const ADDR = at88(ME);

// app.get('<path>', async (req, res) => { ... }); lifted whole.
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
const fakeRes = () => { const r = { headers: {}, statusCode: 200, body: undefined, set(k, v) { r.headers[k.toLowerCase()] = v; return r; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = JSON.parse(JSON.stringify(b)); return r; } }; return r; };
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (n) => ({ toNumber: () => Number(n), toString: () => String(n), toBigInt: () => BigInt(n) });

const dirs = [];
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });

// One world: the database seeded, a fake chain that logs the order of its reads, the real handlers.
function world({ head = 1000, unclaimedFresh = true } = {}) {
    const order = [];
    const api = {
        rpc: { chain: { getHeader: async () => { order.push('head'); return { number: num(head) }; } } },
        query: {
            system: { account: async () => { order.push('state'); return { data: { free: num(5n * 10n ** 12n), reserved: num(0), frozen: num(0) } }; } },
            staking: { bonded: async () => { order.push('state'); return opt(null); }, nominators: async () => { order.push('state'); return opt(null); },
                activeEra: async () => { order.push('state'); return opt({ index: num(10) }); }, ledger: async () => { order.push('state'); return opt(null); } },
            session: { validators: async () => { order.push('state'); return []; } },
            proxy: { proxies: async () => [[], num(0)] },
            multisig: { multisigs: { entries: async () => [] } }
        },
        consts: { balances: { existentialDeposit: num(10n ** 12n) }, staking: {}, babe: {} }
    };
    const recomputed = [];
    const handlers = {};
    const ctx = {
        console: { warn() {}, log() {}, error() {} }, Number, String, Array, Set, Map, Math, Date, JSON, Promise, Object,
        app: { get: (p, fn) => { handlers[p] = fn; } },
        globalApi: api, db, summarizeRewards, balanceBreakdown, accountBalances, walletRecentFields, buildFreshness, lowestTailFrom, isFreshRequest,
        isValidAddress: (a) => { try { decodeAddress(a); return true; } catch { return false; } },
        normalizeAddress: (a) => at88(a), requireRpc: () => true, isRpcReady: () => true,
        getIdentity: async () => 'Unknown', balanceToPDEX: (v) => Number(String(v)) / 1e12,
        UNCLAIMED_TTL: 20 * 60 * 1000, computingUnclaimed: new Set(), recomputeUnclaimed: (a) => { recomputed.push(a); },
        getNetworkInfo: async () => null, getMinNominatorBondCached: async () => 1,
        serverError: (res, err) => { res.status(500).json({ error: String(err && err.message) }); },
        computeRealizedApr: () => null, CHAIN_INDEX_INTERVAL_MS: 12_000, STAKING_REWARDS_INTERVAL_MS: 60_000, THIRTY_SECONDS: 30_000,
        Error, setTimeout, clearTimeout, process: { env: {} }, DEV_API_TIMEOUT_MS: 30_000
    };
    vm.createContext(ctx);
    // The head read's memo and timeout (review finding 4) live beside freshnessHead; each world gets its own memo.
    const optLine = (start) => { const i = SERVER.indexOf(start); return i === -1 ? '' : SERVER.slice(i, SERVER.indexOf('\n', i)); };
    vm.runInContext([optLine('const FRESHNESS_HEAD_TIMEOUT_MS'), optLine('const FRESHNESS_HEAD_MEMO_MS'), optLine('const freshnessHeadMemo'), bodyOf(SERVER, 'withTimeout'),
        bodyOf(SERVER, 'lowestHoleFrom'), 'async ' + bodyOf(SERVER, 'freshnessHead'), 'async ' + bodyOf(SERVER, 'routeFreshness'), bodyOf(SERVER, 'freshnessNow'),
        routeSource('/api/wallet/:address'), routeSource('/api/staking-rewards/:address'), routeSource('/api/proxies/:address'), routeSource('/api/multisigs/:address')].join('\n'), ctx);
    const call = async (p, params, query = {}) => { const res = fakeRes(); await handlers[p]({ params, query, path: p }, res); return res; };
    return { api, order, recomputed, handlers, call, ctx };
}

describe('/api/wallet carries freshness (real handler, seeded database)', () => {
    before(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-r2-routes-'));
        dirs.push(dir);
        db.initDb(dir, true, { awaitMigrator: false });
        db.setSyncState('chain_index', { headSeen: 990, latestScannedBlock: 990, status: 'Synced' });
        db.setSyncState('staking_rewards', { headSeen: 960, latestScannedBlock: 960, status: 'Synced' });
        db.setSyncState('transactions', { latestScannedBlock: 975, status: 'Synced' });
        db.recordScanFailure('transactions', 970, 'hole');
        db.replaceUnclaimed(ADDR, [{ era: 9, validator: at88(V1), amount: 1.5 }, { era: 9, validator: at88(V2), amount: 2 }]);
    });
    test('the field: chain head read first, the three watermarks (a hole pins tx), nothing pending', async () => {
        const w = world();
        const r = await w.call('/api/wallet/:address', { address: ME });
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        const f = r.body.freshness;
        assert.ok(f, 'no freshness on /api/wallet');
        assert.equal(f.chainHead, 1000);
        assert.deepEqual(f.indexed, { chain: 990, rewards: 960, tx: 969 });
        assert.deepEqual(f.pending, []);
        assert.deepEqual(f.intervalMs, { chain: 12_000, rewards: 60_000, tx: 30_000 });
        assert.equal(w.order[0], 'head', `the head was not read before the state: ${w.order.join(',')}`);
        assert.equal(w.order.filter(x => x === 'head').length, 1);
        assert.equal(r.headers['cache-control'], 'no-store');
    });
    test('an unclaimed cache that is not fresh makes rewards.unpaid pending (never caught up), and a recompute is started as before', async () => {
        db.setKv('unclaimed_at:' + ADDR, 0);
        const w = world();
        const r = await w.call('/api/wallet/:address', { address: ME });
        assert.deepEqual(r.body.freshness.pending, ['rewards.unpaid']);
        assert.equal(caughtUp('rewards.unpaid', r.body.freshness, 1), false);
        assert.equal(caughtUp('balance', r.body.freshness, 1000), true);
        assert.deepEqual(w.recomputed, [ADDR]);
        assert.equal(r.body.rewards.unclaimedFresh, false);
        db.replaceUnclaimed(ADDR, [{ era: 9, validator: at88(V1), amount: 1.5 }, { era: 9, validator: at88(V2), amount: 2 }]);
    });
    test('a failed head read is null (unknown), never a failed route', async () => {
        const w = world();
        w.api.rpc.chain.getHeader = async () => { throw new Error('node gone'); };
        const r = await w.call('/api/wallet/:address', { address: ME });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.freshness.chainHead, null);
        assert.equal(r.body.freshness.indexed.chain, 990);
    });
    test('additive: an older client reads every field it read before, with the same meaning; the R1 payout model parses it', async () => {
        const w = world();
        const r = await w.call('/api/wallet/:address', { address: ME });
        const R1_KEYS = ['address', 'identity', 'balance', 'staking', 'rewards', 'recentTransactions', 'recentTransactionsNext', 'recentTransactionsTotal', 'provenance', 'index', 'network', 'price'];
        for (const k of R1_KEYS) assert.ok(k in r.body, `lost ${k}`);
        assert.deepEqual(Object.keys(r.body).filter(k => !R1_KEYS.includes(k)), ['freshness'], 'more than one new top-level field');
        assert.equal(r.body.rewards.unpaidCount, 2);
        assert.equal(r.body.rewards.unpaidTotal, 3.5);
        assert.equal(r.body.rewards.unclaimedFresh, true);
        assert.deepEqual(r.body.rewards.unpaidEntries.map(e => `${e.era}:${e.validator}`).sort(), [`9:${at88(V1)}`, `9:${at88(V2)}`].sort());
        const m = payoutModel(r.body.rewards, {});
        assert.equal(m.button, 'enabled');
        assert.equal(m.count, 2);
    });
});

describe('/api/staking-rewards/:address carries freshness; ?fresh=1 is no-store, normal traffic unchanged', () => {
    test('the field, and the cache headers', async () => {
        const w = world();
        const plain = await w.call('/api/staking-rewards/:address', { address: ME });
        assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
        assert.equal(plain.body.freshness.indexed.rewards, 960);
        assert.equal(plain.body.freshness.chainHead, 1000);
        assert.equal(plain.headers['cache-control'], undefined, 'normal traffic changed its cache header');
        const fresh = await w.call('/api/staking-rewards/:address', { address: ME }, { fresh: '1' });
        assert.equal(fresh.headers['cache-control'], 'no-store');
        assert.ok(Array.isArray(fresh.body.claimed) && Array.isArray(fresh.body.unclaimed), 'an older field is gone');
    });
});

describe('/api/proxies and /api/multisigs are no-store (design section 5)', () => {
    test('both routes, on success', async () => {
        const w = world();
        const p = await w.call('/api/proxies/:address', { address: ME });
        assert.equal(p.statusCode, 200, JSON.stringify(p.body));
        assert.equal(p.headers['cache-control'], 'no-store');
        const m = await w.call('/api/multisigs/:address', { address: ME });
        assert.equal(m.statusCode, 200, JSON.stringify(m.body));
        assert.equal(m.headers['cache-control'], 'no-store');
    });
    // R3: the proxy list polls on evidence (design section 5, proxies: caught up when chainHead >= the block), so the
    // route says which head it read, read BEFORE the proxy state.
    test('/api/proxies carries the freshness of its chain read (head read first)', async () => {
        const w = world({ head: 1234 });
        w.api.query.proxy.proxies = async () => { w.order.push('state'); return [[], num(0)]; };
        const p = await w.call('/api/proxies/:address', { address: ME });
        assert.equal(p.statusCode, 200, JSON.stringify(p.body));
        assert.ok(p.body.freshness, 'no freshness on /api/proxies');
        assert.equal(p.body.freshness.chainHead, 1234);
        assert.deepEqual(w.order, ['head', 'state'], `the head was not read before the proxy state: ${w.order.join(',')}`);
        assert.deepEqual(p.body.proxies, []);
    });
});

describe('/api/account/:address/locks carries freshness (lib/balance-locks-api.js, real handler over express)', () => {
    let server, base;
    const order = [];
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    before(async () => {
        const app = express();
        const ac = (v) => ({ toString: () => String(v), toBigInt: () => BigInt(v), toNumber: () => Number(v) });
        const api = { query: { system: { account: async () => { order.push('state'); return { data: { free: ac(10n ** 13n), reserved: ac(0), frozen: ac(0) } }; } }, balances: {} }, consts: { balances: { existentialDeposit: ac(10n ** 12n) } } };
        registerBalanceLocksRoute(app, {
            api: () => api, ready: () => true, gate: (req) => ({ address: req.params.address }),
            cacheShort: (res) => res.set('Cache-Control', SHORT), isFresh: isFreshRequest,
            serverError: (res, err) => res.status(500).json({ error: String(err && err.message) }),
            freshness: async () => { order.push('freshness'); return { v: 1, chainHead: 1234, indexed: { chain: 1, rewards: 1, tx: 1 } }; }
        });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    test('the field is present, read before the chain state; ?fresh=1 no-store, otherwise the short tier', async () => {
        const plain = await fetch(`${base}/api/account/${ME}/locks`);
        const body = await plain.json();
        assert.equal(plain.status, 200, JSON.stringify(body));
        assert.equal(body.freshness && body.freshness.chainHead, 1234);
        assert.equal(order[0], 'freshness', `freshness was read after the state: ${order.join(',')}`);
        assert.equal(plain.headers.get('cache-control'), SHORT);
        const fresh = await fetch(`${base}/api/account/${ME}/locks?fresh=1`);
        await fresh.json();
        assert.equal(fresh.headers.get('cache-control'), 'no-store');
    });
    test('server.js passes the freshness reader to the locks route (text guard; the behaviour test is in test/r2-review-fixes.test.js)', () => {
        assert.match(SERVER, /registerBalanceLocksRoute\(app, \{[^}]*serverError, freshness: routeFreshness \}\)/);
    });
});
