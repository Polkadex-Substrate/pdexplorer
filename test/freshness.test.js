// The freshness field (design cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 0, 2.2, 2.3
// and 5; sprint R2). The server builds it from the indexers' sync watermarks: per indexed domain, the
// highest block up to which that domain's data is complete with no hole, counted inside a recent window so
// an old permanent hole cannot pin it for ever (the window's bottom is published as `since`). The client
// asks caughtUp(domain, freshness, block): has the server copy of this domain reached the block the
// transaction landed in? Unknown (null, missing, non-finite, a pending domain) is never caught up.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFreshness, caughtUp, pollDeadlineMs, samePayload, lowestTailFrom, SOURCE as FRESH_SOURCE,
    FRESHNESS_WINDOW_BLOCKS, POLL_BACKOFF_MS, POLL_DEADLINE_MS } from '../lib/freshness.js';
import { SOURCE } from '../lib/action-effects.js';

const states = (map) => (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : {});
const noHoles = () => null;
const build = (o = {}) => buildFreshness({ syncState: states(o.states || {}), lowestHole: o.lowestHole || noHoles,
    chainHead: o.chainHead === undefined ? 1000 : o.chainHead, pending: o.pending, intervalMs: o.intervalMs, window: o.window });

describe('buildFreshness: from the sync watermarks', () => {
    test('each indexed domain reads its own sync state: chain_index, staking_rewards, transactions', () => {
        const f = build({ states: { chain_index: { headSeen: 990, latestScannedBlock: 990 }, staking_rewards: { headSeen: 960, latestScannedBlock: 960 }, transactions: { latestScannedBlock: 975 } } });
        assert.equal(f.chainHead, 1000);
        assert.deepEqual(f.indexed, { chain: 990, rewards: 960, tx: 975 });
        assert.deepEqual(f.kv, { council: null, democracy: null, treasury: null }, 'R4 adds the governance snapshots; unknown until then');
        assert.deepEqual(f.pending, []);
        assert.equal(f.v, 1);
    });
    test('the claimed top is headSeen when present, else the stored watermark', () => {
        const f = build({ states: { chain_index: { headSeen: 990, latestScannedBlock: 400 } } });
        assert.equal(f.indexed.chain, 990, 'a hole is read from the failure queue inside the window, not from the global watermark');
    });
    test('a hole inside the window pins the domain just below it', () => {
        const holes = { chain_index: 985, staking_rewards: null, transactions: 970 };
        const seen = [];
        const f = build({ states: { chain_index: { headSeen: 990 }, staking_rewards: { headSeen: 960 }, transactions: { latestScannedBlock: 975 } },
            lowestHole: (ix, from) => { seen.push([ix, from]); return holes[ix]; } });
        assert.deepEqual(f.indexed, { chain: 984, rewards: 960, tx: 969 });
        assert.deepEqual(seen.map(s => s[0]).sort(), ['chain_index', 'staking_rewards', 'transactions']);
        for (const [ix, from] of seen) {
            const top = { chain_index: 990, staking_rewards: 960, transactions: 975 }[ix];
            assert.equal(from, Math.max(1, top - FRESHNESS_WINDOW_BLOCKS + 1), `${ix}: the window bottom`);
        }
        assert.deepEqual(f.since, { chain: Math.max(1, 990 - FRESHNESS_WINDOW_BLOCKS + 1), rewards: Math.max(1, 960 - FRESHNESS_WINDOW_BLOCKS + 1), tx: Math.max(1, 975 - FRESHNESS_WINDOW_BLOCKS + 1) });
    });
    test('an old hole below the window does not pin a fresh domain for ever', () => {
        const top = 5_000_000;
        const f = build({ states: { chain_index: { headSeen: top, latestScannedBlock: 1_234 } }, lowestHole: (ix, from) => (from <= 1_235 ? 1_235 : null) });
        assert.equal(f.indexed.chain, top);
        assert.equal(f.since.chain, top - FRESHNESS_WINDOW_BLOCKS + 1);
    });
    test('a hole answer above the claimed top or below the window is ignored as nonsense', () => {
        const f = build({ states: { chain_index: { headSeen: 990 } }, lowestHole: () => 5000 });
        assert.equal(f.indexed.chain, 990);
    });
    test('missing sync state, zero, negative and non-finite values are unknown (null), never 0 or NaN', () => {
        for (const bad of [undefined, null, {}, { headSeen: 0 }, { latestScannedBlock: -5 }, { headSeen: NaN }, { headSeen: 'abc' }, { headSeen: Infinity }, { latestScannedBlock: '1e999' }]) {
            const f = build({ states: { chain_index: bad } });
            assert.equal(f.indexed.chain, null, JSON.stringify(bad));
            assert.equal(f.since.chain, null, JSON.stringify(bad));
        }
        for (const head of [undefined, null, NaN, -1, 'x', Infinity]) {
            assert.equal(build({ chainHead: head }).chainHead, null, String(head));
        }
    });
    test('a throwing sync state or hole lookup gives unknown for that domain only', () => {
        const f = buildFreshness({ syncState: (n) => { if (n === 'transactions') throw new Error('db'); return { headSeen: 900 }; },
            lowestHole: (ix) => { if (ix === 'staking_rewards') throw new Error('db'); return null; }, chainHead: 1000 });
        assert.equal(f.indexed.chain, 900);
        assert.equal(f.indexed.rewards, null);
        assert.equal(f.indexed.tx, null);
    });
    test('pending domains and the indexer intervals are carried as given (finite intervals only)', () => {
        const f = build({ pending: ['rewards.unpaid', 7, null], intervalMs: { chain: 12_000, rewards: 300_000, tx: NaN } });
        assert.deepEqual(f.pending, ['rewards.unpaid']);
        assert.deepEqual(f.intervalMs, { chain: 12_000, rewards: 300_000, tx: null });
    });
});

describe('lowestTailFrom: the skip tail (lib/skip-tail.js ranges) counts as a hole', () => {
    test('the lowest owed height at or above the window bottom', () => {
        assert.equal(lowestTailFrom({ ranges: [{ lo: 10, hi: 20 }, { lo: 500, hi: 600 }] }, 15), 15);
        assert.equal(lowestTailFrom({ ranges: [{ lo: 10, hi: 20 }, { lo: 500, hi: 600 }] }, 21), 500);
        assert.equal(lowestTailFrom({ ranges: [{ lo: 10, hi: 20 }] }, 21), null);
        assert.equal(lowestTailFrom(null, 1), null);
        assert.equal(lowestTailFrom({ ranges: 'x' }, 1), null);
        assert.equal(lowestTailFrom({ ranges: [{ lo: 'a', hi: 3 }, null] }, 1), null);
    });
});

describe('caughtUp(domain, freshness, block)', () => {
    const f = { chainHead: 100, indexed: { chain: 90, rewards: 80, tx: 85 }, since: { chain: 10, rewards: 10, tx: 10 }, kv: { council: 70, democracy: null, treasury: 75 }, pending: [] };
    const rows = [
        ['balance', 100, true], ['balance', 101, false], ['staking.ledger', 100, true], ['locks', 99, true], ['proxies', 101, false],
        ['rewards.unpaid', 90, true], ['rewards.unpaid', 91, false], ['identity', 90, true],
        ['rewards.claimed', 80, true], ['rewards.claimed', 81, false],
        ['tx.recent', 85, true], ['tx.recent', 86, false],
        ['council.motions', 70, true], ['council.elections', 71, false], ['democracy', 1, false], ['treasury.overview', 75, true],
        ['validator.status', 100, true], ['validator.status', 101, false],
        ['discussion', 10_000, true], ['labels', 10_000, true], ['alerts', 10_000, true], ['watchlist', 10_000, true],
        ['rewards.unpaid', 9, false], ['no.such.domain', 1, false]
    ];
    for (const [domain, block, want] of rows) {
        test(`${domain} at #${block}: ${want ? 'caught up' : 'not yet'}`, () => assert.equal(caughtUp(domain, f, block), want));
    }
    test('a pending domain is never caught up, whatever its watermark', () => {
        assert.equal(caughtUp('rewards.unpaid', { ...f, pending: ['rewards.unpaid'] }, 1), false);
        assert.equal(caughtUp('rewards.claimed', { ...f, pending: ['rewards.unpaid'] }, 1), true);
    });
    test('unknown is not caught up: no freshness (an older server), null fields, a non-finite block', () => {
        for (const bad of [undefined, null, 'x', 7, {}, { chainHead: null, indexed: { chain: null } }, { indexed: 'x' }]) {
            assert.equal(caughtUp('balance', bad, 1), false, JSON.stringify(bad));
            assert.equal(caughtUp('rewards.unpaid', bad, 1), false, JSON.stringify(bad));
        }
        for (const b of [null, undefined, NaN, 'x', Infinity]) assert.equal(caughtUp('balance', f, b), false, String(b));
    });
    test('without `since` (a server before the window) only the watermark is compared', () => {
        assert.equal(caughtUp('rewards.unpaid', { indexed: { chain: 90 } }, 5), true);
    });
});

describe('the poll timings', () => {
    test('backoff 2, 4, 8, 16, 30 s; deadlines 60 s for chain, 180 s for indexed, kv and memo (design 2.5, UX section 9)', () => {
        assert.deepEqual(POLL_BACKOFF_MS, [2000, 4000, 8000, 16000, 30000]);
        assert.deepEqual(POLL_DEADLINE_MS, { chain: 60_000, indexed: 180_000, kv: 180_000, memo: 180_000 });
        assert.equal(pollDeadlineMs('balance', null), 60_000);
        assert.equal(pollDeadlineMs('rewards.unpaid', null), 180_000);
        assert.equal(pollDeadlineMs('council.motions', null), 180_000);
        assert.equal(pollDeadlineMs('discussion', null), 0, 'a response domain is never polled');
    });
    test('Q6: an indexer slower than the default (a production override) stretches its deadline to two of its intervals, never shortens it', () => {
        assert.equal(pollDeadlineMs('rewards.claimed', { intervalMs: { rewards: 300_000 } }), 600_000);
        assert.equal(pollDeadlineMs('rewards.claimed', { intervalMs: { rewards: 60_000 } }), 180_000);
        assert.equal(pollDeadlineMs('rewards.unpaid', { intervalMs: { chain: 120_000 } }), 240_000);
        assert.equal(pollDeadlineMs('tx.recent', { intervalMs: { tx: 'x' } }), 180_000);
        assert.equal(pollDeadlineMs('balance', { intervalMs: { chain: 900_000 } }), 60_000, 'chain reads do not wait for an indexer');
    });
});

describe('samePayload: two responses that differ only in freshness are the same page', () => {
    test('freshness is ignored; any other difference is not', () => {
        const a = { address: 'x', rewards: { unpaidEntries: [{ era: 1 }] }, freshness: { chainHead: 1 } };
        assert.equal(samePayload(a, { ...a, freshness: { chainHead: 2 } }), true);
        assert.equal(samePayload(a, { ...a, rewards: { unpaidEntries: [] } }), false);
        assert.equal(samePayload(a, null), false);
        assert.equal(samePayload(null, null), false);
    });
});

describe('one source table', () => {
    test('lib/action-effects.js SOURCE is the freshness SOURCE (caughtUp and the effects table cannot drift)', () => {
        assert.equal(SOURCE, FRESH_SOURCE);
        assert.equal(Object.isFrozen(FRESH_SOURCE), true);
    });
});
