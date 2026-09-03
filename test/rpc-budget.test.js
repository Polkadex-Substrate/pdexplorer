// F-073 — the in-flight budget must bound WORK AT THE NODE, not waiters.
//
// The finding: "inflight cap 12; timeout still does not abort". The abort half
// is impossible on the pinned @polkadot/api 10.13.1 — its provider signature is
// `send(method, params, isCacheable?, subscription?)`, with no AbortSignal and
// no cancel handle. Once a request is on the wire the node will do the work.
//
// The half that IS fixable: the budget used to receive an already-raced
// promise, so the slot was released at the TIMEOUT while the query kept running
// on the node, unaccounted. Under a brownout — every call timing out — the cap
// bounded only how many callers were waiting, which is the opposite of what a
// load cap is for, and it failed exactly when the node was already in trouble.
//
// This is concurrency behaviour, so it is tested by RUNNING it. A source-text
// assertion would pass against an implementation that releases at the wrong
// moment, which is the entire bug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';

// A faithful transcription of the production implementation. server.js cannot
// be imported (it opens a DB, a socket and an RPC connection at module load),
// so the logic is mirrored here and a source test below pins the two together
// — if server.js changes shape, that test fails and this file must be revisited.
function makeBudget({ max = 2, timeoutMs = 20, slotMaxMs = 200 } = {}) {
    let inflight = 0;
    const warnings = [];

    function withTimeout(promise, ms, label) {
        Promise.resolve(promise).catch(() => {});
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })
        ]).finally(() => { if (timer) clearTimeout(timer); });
    }

    async function withRpcBudget(label, fn, ms = timeoutMs) {
        if (inflight >= max) {
            const err = new Error(`Too many chain queries in flight (${inflight}/${max}).`);
            err.statusCode = 503;
            throw err;
        }
        inflight++;
        let released = false;
        const release = () => { if (!released) { released = true; inflight--; } };

        let underlying;
        try { underlying = Promise.resolve(fn()); }
        catch (e) { release(); throw e; }

        const valve = setTimeout(() => {
            if (!released) { warnings.push(`${label}: force-released`); release(); }
        }, slotMaxMs);
        if (valve.unref) valve.unref();
        underlying.then(() => {}, () => {}).then(() => { clearTimeout(valve); release(); });

        return await withTimeout(underlying, ms, label);
    }

    return { withRpcBudget, inflight: () => inflight, warnings };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('F-073 — a timed-out call keeps holding its slot', () => {
    test('the caller still gets a timeout error promptly', () => {
        const b = makeBudget({ max: 2, timeoutMs: 20 });
        return assert.rejects(
            b.withRpcBudget('slow', () => sleep(500)),
            /timed out after 20ms/);
    });

    test('the slot is NOT released when the caller gives up', async () => {
        // The core regression. Old behaviour: inflight drops to 0 here while
        // the query is still executing on the node.
        const b = makeBudget({ max: 2, timeoutMs: 20, slotMaxMs: 5000 });
        const p = b.withRpcBudget('slow', () => sleep(300));
        await assert.rejects(p, /timed out/);
        await sleep(20);
        assert.equal(b.inflight(), 1,
            'the slot was freed at the timeout — the node is still working on a query nothing is counting');
    });

    test('the slot IS released once the real call finishes', async () => {
        const b = makeBudget({ max: 2, timeoutMs: 20, slotMaxMs: 5000 });
        await assert.rejects(b.withRpcBudget('slow', () => sleep(120)), /timed out/);
        assert.equal(b.inflight(), 1);
        await sleep(200);
        assert.equal(b.inflight(), 0, 'the slot leaked after the underlying call settled');
    });

    test('a brownout cannot drive unbounded work at the node', async () => {
        // Every call times out. With the old accounting each caller freed its
        // slot instantly, so an attacker could start an unlimited number of
        // real queries. Now the cap holds.
        const b = makeBudget({ max: 2, timeoutMs: 10, slotMaxMs: 5000 });
        let started = 0;
        const attempts = [];
        for (let i = 0; i < 12; i++) {
            attempts.push(b.withRpcBudget('q', () => { started++; return sleep(400); }).catch(e => e));
        }
        const results = await Promise.all(attempts);
        assert.equal(started, 2, `${started} queries reached the node; the cap of 2 did not hold`);
        const refused = results.filter(r => r && r.statusCode === 503).length;
        assert.equal(refused, 10, 'the excess callers were not refused with 503');
    });

    test('a rejecting call releases its slot too', async () => {
        const b = makeBudget({ max: 2, timeoutMs: 100 });
        await assert.rejects(b.withRpcBudget('boom', () => Promise.reject(new Error('nope'))), /nope/);
        await sleep(10);
        assert.equal(b.inflight(), 0, 'a rejection leaked the slot');
    });

    test('a synchronous throw releases its slot', async () => {
        // fn() throwing before returning a promise means no work started at
        // all; waiting on a promise that does not exist would leak the slot.
        const b = makeBudget({ max: 2 });
        await assert.rejects(
            b.withRpcBudget('sync-boom', () => { throw new Error('immediate'); }),
            /immediate/);
        assert.equal(b.inflight(), 0, 'a synchronous throw leaked the slot');
    });

    test('a promise that NEVER settles cannot leak the slot forever', async () => {
        // Without the valve, one dead socket removes a slot for the life of the
        // process and the endpoints 503 until restart.
        const b = makeBudget({ max: 1, timeoutMs: 10, slotMaxMs: 60 });
        await assert.rejects(b.withRpcBudget('never', () => new Promise(() => {})), /timed out/);
        assert.equal(b.inflight(), 1, 'released too early — that is the bug being fixed');
        await sleep(120);
        assert.equal(b.inflight(), 0, 'the leak valve did not fire');
        assert.ok(b.warnings.some(w => w.includes('force-released')),
            'the forced release was silent — an operator cannot tell this happened');
    });

    test('the slot is released exactly once', async () => {
        // Both the settle handler and the valve can fire. A double decrement
        // would make inflight go negative and disable the cap entirely.
        const b = makeBudget({ max: 3, timeoutMs: 10, slotMaxMs: 30 });
        await assert.rejects(b.withRpcBudget('slow', () => sleep(60)), /timed out/);
        await sleep(200);
        assert.equal(b.inflight(), 0);
        assert.ok(b.inflight() >= 0, 'inflight went negative — the cap is now unenforceable');
    });
});

describe('F-073 — the production code has the shape this file models', () => {
    const srv = stripComments(readRepo('server.js', import.meta.url), { line: '//', block: true });

    test('the budget owns the timeout rather than receiving a raced promise', () => {
        // If a call site goes back to withRpcBudget(l, () => withTimeout(...)),
        // the slot is released at the timeout again and every behavioural test
        // above becomes irrelevant to production.
        assert.match(srv, /async function withRpcBudget\(label, fn, ms = DEV_API_TIMEOUT_MS\)/);
        assert.ok(!/withRpcBudget\([^,]+, \(\) =>\s*\n?\s*withTimeout\(/.test(srv),
            'a call site pre-races the promise again — the budget cannot see the real work');
    });

    test('release happens on the underlying settle, not the race', () => {
        assert.match(srv, /underlying\.then\(\(\) => \{\}, \(\) => \{\}\)\.then\(\(\) => \{ clearTimeout\(valve\); release\(\); \}\)/);
        assert.match(srv, /return await withTimeout\(underlying, ms, label\)/);
    });

    test('release is idempotent', () => {
        assert.match(srv, /const release = \(\) => \{ if \(!released\) \{ released = true; devRpcInflight--; \} \}/);
    });

    test('the leak valve exists, is configurable and is logged', () => {
        assert.match(srv, /DEV_RPC_SLOT_MAX_MS = readPositiveInteger\(process\.env\.DEV_RPC_SLOT_MAX_MS, 120_000\)/);
        assert.match(srv, /budget slot force-released after/);
        assert.match(readRepo('.env.example', import.meta.url), /# DEV_RPC_SLOT_MAX_MS=/);
    });

    test('the impossibility of abort is recorded with its evidence', () => {
        // So round 4 does not re-open it from theory. The pin is load-bearing
        // for wallet signing, so "just upgrade the API" is not available.
        const raw = readRepo('server.js', import.meta.url);
        assert.match(raw, /send\(method, params, isCacheable\?, subscription\?\)/);
        assert.match(raw, /no AbortSignal, no/);
    });
});
