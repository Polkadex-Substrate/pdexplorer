// Layer (c) of the post-action core (design 2.5; sprint R2): after an inclusion, each subscribed component
// that shows an affected domain is re-read with backoff (now, then 2, 4, 8, 16, 30, 30... s) until the
// freshness it returns says the server has caught up with the inclusion block, then the poll stops. Deadlines
// 60 s for chain domains, 180 s for indexed ones; past it the component is told could-not-refresh. No attempt
// and no timer while the tab is hidden; resume() runs what is due at once. A wallet switch cancels. One
// attempt in flight per (component, account); a later inclusion merges in and the highest block wins.
// Clock and timers are injected: nothing here waits for real time.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs } from '../lib/freshness.js';
import { harness, flush, READY, IN1 } from './helpers/tx-harness.js';
import { ME, OTHER, PAIRS, REGISTRY, paidItem, forceBatch } from './helpers/payout-events.js';

const WALLET = ['balance', 'staking.ledger', 'staking.nominations', 'rewards.unpaid', 'rewards.claimed', 'tx.recent'];
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

// A server whose watermarks move only when the test says so.
function server(start = {}) {
    const s = { chainHead: 50, chain: 30, rewards: 20, tx: 25, pending: [], ...start, reads: 0 };
    s.freshness = () => ({ v: 1, chainHead: s.chainHead, indexed: { chain: s.chain, rewards: s.rewards, tx: s.tx }, since: { chain: 1, rewards: 1, tx: 1 },
        kv: { council: null, democracy: null, treasury: null }, pending: [...s.pending], intervalMs: { chain: 12_000, rewards: 60_000, tx: 30_000 } });
    return s;
}
function world({ domains = WALLET, account = ME, srv = server(), withPolling = true, reloadImpl = null } = {}) {
    const clock = { t: 1_000_000 };
    const timers = [];
    const vis = { on: true };
    const known = createKnownResults({ storage: null, now: () => clock.t });
    const core = createPostAction({ effects: effectsFor, known, now: () => clock.t, visible: () => vis.on,
        setTimer: (f, ms) => { const t = { f, ms, at: clock.t + ms, live: true }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; },
        ...(withPolling ? { caughtUp, deadlineMs: pollDeadlineMs } : {}) });
    const reloads = [];
    const states = [];
    let shown = account;
    core.subscribe(domains, {
        account: () => shown,
        reload: (info) => { reloads.push(info); if (reloadImpl) return reloadImpl(info, srv); if (info.poll) srv.reads++; return info.poll ? Promise.resolve(srv.freshness()) : null; },
        state: (s, info) => states.push({ s, ...info })
    });
    const live = () => timers.filter(t => t.live);
    // Run the next live timer: the clock jumps to its time.
    const step = async () => { const t = live().sort((a, b) => a.at - b.at)[0]; assert.ok(t, 'no timer armed'); t.live = false; clock.t = Math.max(clock.t, t.at); t.f(); await settle(); return t; };
    return { clock, timers, vis, known, core, reloads, states, srv, live, step, show: (a) => { shown = a; } };
}
const polls = (w) => w.reloads.filter(r => r.poll);
const include = async (w, block = 40, domains = ['rewards.unpaid', 'rewards.claimed', 'balance', 'staking.ledger', 'tx.recent'], account = ME) => {
    w.core.notify({ account, domains, block, reason: 'inBlock' });
    await settle();
};

describe('poll until the server has caught up, then stop', () => {
    test('stale three times, then fresh: four reads, then current, no timer left', async () => {
        const w = world({ srv: server({ chainHead: 50, chain: 30, rewards: 50, tx: 50 }) });
        await include(w, 40);
        assert.equal(polls(w).length, 1, 'the first read is at inclusion');
        assert.equal(polls(w)[0].reason, 'inBlock');
        assert.equal(polls(w)[0].block, 40);
        assert.equal(w.live().length, 1);
        assert.equal(w.live()[0].ms, 2000);
        assert.equal(w.states[0].s, 'updating');
        assert.ok(w.states[0].domains.includes('rewards.unpaid'));
        assert.ok(!w.states[0].domains.includes('balance'), 'balance was already at the block');
        assert.equal((await w.step()).ms, 2000);
        assert.equal(w.live()[0].ms, 4000);
        await w.step();
        assert.equal(w.live()[0].ms, 8000);
        w.srv.chain = 40;                       // the forward pass reaches the block
        await w.step();
        assert.equal(polls(w).length, 4);
        assert.equal(w.live().length, 0, 'still polling after the server caught up');
        assert.equal(w.states[w.states.length - 1].s, 'current');
        assert.equal(w.states.filter(s => s.s === 'updating').length, 1, 'updating is said once');
    });
    test('caught up at the first read: one read, no timer, current', async () => {
        const w = world({ srv: server({ chainHead: 50, chain: 50, rewards: 50, tx: 50 }) });
        await include(w, 40);
        assert.equal(polls(w).length, 1);
        assert.equal(w.live().length, 0);
        assert.deepEqual(w.states.map(s => s.s), ['current']);
    });
    test('the backoff caps at 30 s', async () => {
        const w = world();
        await include(w, 40);
        const gaps = [];
        for (let i = 0; i < 6; i++) gaps.push((await w.step()).ms);
        assert.deepEqual(gaps, [2000, 4000, 8000, 16000, 30000, 30000]);
    });
    test('a pending domain (the unpaid list is being recomputed) keeps the poll going at any watermark', async () => {
        const w = world({ srv: server({ chainHead: 99, chain: 99, rewards: 99, tx: 99, pending: ['rewards.unpaid'] }) });
        await include(w, 40);
        assert.equal(w.live().length, 1);
        w.srv.pending = [];
        await w.step();
        assert.equal(w.live().length, 0);
        assert.equal(w.states[w.states.length - 1].s, 'current');
    });
    test('a reload that throws or rejects counts as not caught up, never as a crash', async () => {
        let n = 0;
        const w = world({ reloadImpl: (info, srv) => { if (!info.poll) return null; n++; if (n === 1) throw new Error('boom'); if (n === 2) return Promise.reject(new Error('net')); return srv.freshness(); },
            srv: server({ chainHead: 99, chain: 99, rewards: 99, tx: 99 }) });
        await include(w, 40);
        assert.equal(w.live().length, 1);
        await w.step();
        assert.equal(w.live().length, 1);
        await w.step();
        assert.equal(w.live().length, 0);
        assert.equal(w.states[w.states.length - 1].s, 'current');
    });
    test('an older server without freshness is unknown: polled until the deadline, then could-not-refresh', async () => {
        const w = world({ reloadImpl: (info) => (info.poll ? Promise.resolve(undefined) : null) });
        await include(w, 40, ['rewards.unpaid']);
        while (w.live().length) await w.step();
        assert.equal(w.states[w.states.length - 1].s, 'could-not-refresh');
        assert.deepEqual(w.states[w.states.length - 1].gaveUp, ['rewards.unpaid']);
    });
});

describe('deadlines', () => {
    test('gives up at 180 s for an indexed domain: could-not-refresh, the polls stop, the last read is at the deadline', async () => {
        const w = world();
        await include(w, 40, ['rewards.unpaid']);
        const start = 1_000_000;
        while (w.live().length) await w.step();
        const last = w.states[w.states.length - 1];
        assert.equal(last.s, 'could-not-refresh');
        assert.deepEqual(last.gaveUp, ['rewards.unpaid']);
        assert.equal(w.clock.t - start, 180_000, 'the last attempt is not at the deadline');
        assert.ok(polls(w).length <= 12, `${polls(w).length} reads in three minutes`);
    });
    test('chain domains give up at 60 s while an indexed one keeps going', async () => {
        const w = world({ srv: server({ chainHead: 10, chain: 10, rewards: 10, tx: 10 }) });
        await include(w, 40, ['balance', 'rewards.unpaid']);
        while (w.clock.t - 1_000_000 < 60_000) await w.step();
        assert.ok(w.live().length, 'stopped at the chain deadline although rewards.unpaid has 180 s');
        w.srv.chain = 40;
        await w.step();
        const last = w.states[w.states.length - 1];
        assert.equal(last.s, 'could-not-refresh');
        assert.deepEqual(last.gaveUp, ['balance']);
        assert.equal(w.live().length, 0);
    });
    test('Q6: a slow production rewards indexer (5 min) is waited for 10 min, not called could-not-refresh at 3', async () => {
        const srv = server({ chainHead: 99, chain: 99, rewards: 10, tx: 99 });
        const base = srv.freshness;
        srv.freshness = () => ({ ...base(), intervalMs: { chain: 12_000, rewards: 300_000, tx: 30_000 } });
        const w = world({ srv });
        await include(w, 40, ['rewards.claimed']);
        while (w.clock.t - 1_000_000 < 180_000) await w.step();
        assert.ok(w.live().length, 'gave up at the default deadline');
        while (w.live().length) await w.step();
        assert.equal(w.clock.t - 1_000_000, 600_000);
        assert.equal(w.states[w.states.length - 1].s, 'could-not-refresh');
    });
});

describe('visibility', () => {
    test('hidden: no attempt and no timer; resume() runs the due attempt at once and re-arms', async () => {
        const w = world();
        await include(w, 40, ['rewards.unpaid']);
        w.vis.on = false;
        const t = w.live()[0];
        t.live = false; w.clock.t = t.at; t.f(); await settle();   // the timer fires while hidden
        assert.equal(polls(w).length, 1, 'read while hidden');
        assert.equal(w.live().length, 0, 'a timer was armed while hidden');
        w.clock.t += 50_000;
        w.vis.on = true;
        w.core.resume();
        await settle();
        assert.equal(polls(w).length, 2, 'resume did not run the due attempt');
        assert.equal(w.live().length, 1, 'not re-armed after resume');
    });
    test('hidden past the deadline: the attempt on return runs before giving up, and a caught-up answer wins', async () => {
        const w = world();
        await include(w, 40, ['rewards.unpaid']);
        w.vis.on = false;
        w.clock.t += 600_000;
        const t = w.live()[0]; t.live = false; t.f(); await settle();
        w.srv.chain = 40;
        w.vis.on = true;
        w.core.resume();
        await settle();
        assert.equal(w.states[w.states.length - 1].s, 'current');
        assert.equal(w.live().length, 0);
    });
});

describe('wallet switch and coalescing', () => {
    test('accountChanged(B) cancels the poll for A: no more reads, no state for A afterwards', async () => {
        const w = world();
        await include(w, 40, ['rewards.unpaid']);
        w.show(OTHER);
        w.core.accountChanged(OTHER);
        await settle();
        const n = polls(w).length;
        for (const t of w.live()) { t.live = false; t.f(); }
        await settle();
        assert.equal(polls(w).length, n);
        assert.equal(w.live().length, 0);
        assert.ok(!w.states.some(s => s.s === 'could-not-refresh' || s.s === 'current'));
    });
    test('the component now shows another account (no accountChanged call): the next attempt cancels instead of reading', async () => {
        const w = world();
        await include(w, 40, ['rewards.unpaid']);
        w.show(OTHER);
        await w.step();
        assert.equal(polls(w).length, 1);
        assert.equal(w.live().length, 0);
    });
    test('an inclusion for another account never polls this component', async () => {
        const w = world();
        await include(w, 40, ['rewards.unpaid'], OTHER);
        assert.equal(polls(w).length, 0);
        assert.equal(w.live().length, 0);
    });
    test('a second inclusion during a poll: one poll, the highest block wins, one read in flight', async () => {
        let resolve;
        const w = world({ reloadImpl: (info, srv) => (info.poll ? new Promise(r => { resolve = () => r(srv.freshness()); }) : null) });
        w.core.notify({ account: ME, domains: ['rewards.unpaid'], block: 40, reason: 'inBlock' });
        await settle();
        w.core.notify({ account: ME, domains: ['rewards.unpaid'], block: 45, reason: 'inBlock' });
        await settle();
        assert.equal(polls(w).length, 1, 'two reads in flight for one component');
        w.srv.chain = 42;
        resolve(); await settle();
        assert.equal(polls(w).length, 2, 'the merged inclusion was not re-read');
        assert.equal(polls(w)[1].block, 45);
        resolve(); await settle();
        assert.ok(w.live().length, '42 is not 45: still polling');
        w.srv.chain = 45;
        await w.step(); resolve(); await settle();
        assert.equal(w.states[w.states.length - 1].s, 'current');
    });
    test('a block of null (header read failed) reads once and polls nothing', async () => {
        const w = world();
        w.core.notify({ account: ME, domains: ['rewards.unpaid'], block: null, reason: 'inBlock' });
        await settle();
        assert.equal(polls(w).length, 0);
        assert.equal(w.reloads.length, 1);
        assert.equal(w.live().length, 0);
    });
    test('response domains are never polled', async () => {
        const w = world({ domains: ['discussion'] });
        await include(w, 40, ['discussion']);
        assert.equal(polls(w).length, 0);
        assert.equal(w.reloads.length, 1);
    });
    test('without caughtUp injected the core behaves as R1: one reload, no poll, no timer', async () => {
        const w = world({ withPolling: false });
        await include(w, 40);
        assert.equal(w.reloads.length, 1);
        assert.equal(polls(w).length, 0);
        assert.equal(w.live().length, 0);
    });
    test('a single-domain subscriber (R1 shape) still works', async () => {
        const w = world({ domains: 'rewards.unpaid' });
        await include(w, 40);
        assert.equal(polls(w).length, 1);
        assert.deepEqual(w.states[0].domains, ['rewards.unpaid']);
    });
});

describe('through the real tracker: a payout In block starts the poll', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());
    test('In block #42: the first read is the inclusion, then the backoff timer', async () => {
        const w = world({ srv: server({ chainHead: 99, chain: 10, rewards: 99, tx: 99 }) });
        const h = harness({ action: { id: 'p', key: 'staking.payout', params: { k: 3, remaining: 0, account: ME, pairs: PAIRS } }, registry: REGISTRY, core: w.core });
        h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY);
        await h.emit(IN1, forceBatch(...PAIRS.map(p => paidItem(p))));
        await flush(); await settle();
        assert.equal(polls(w).length, 1);
        assert.equal(polls(w)[0].block, 42);
        assert.equal(polls(w)[0].reason, 'inBlock');
        assert.equal(w.live().length, 1);
        w.srv.chain = 42;
        await w.step();
        assert.equal(w.live().length, 0);
        assert.equal(w.states[w.states.length - 1].s, 'current');
    });
});
