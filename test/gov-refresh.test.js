// Event-driven governance refresh on the server (lib/gov-refresh.js and its
// wiring in server.js). The democracy and treasury snapshots used to renew
// only on their slow timers, so a new referendum, a vote or a treasury
// approval took minutes to reach the page. The per-block hook now starts the
// democracy, treasury and council syncs as soon as a fresh block carries a
// governance event. These check which events count, that one block starts
// each sync at most once, that two runs of one sync never overlap, and that a
// trigger arriving during a run is not lost.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOV_TRIGGER_SECTIONS, govSyncsForEvents, makeSyncRunner, isFreshRequest } from '../lib/gov-refresh.js';
import { CACHE_TIERS } from '../lib/api-reference.js';

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ev = (section, method = 'X') => ({ section, method });

describe('which events start a governance refresh', () => {
    test('democracy, council, technical committee, elections and treasury are all triggers', () => {
        for (const s of ['democracy', 'council', 'councilCollective', 'generalCouncil', 'technicalCommittee',
            'elections', 'phragmenElection', 'electionsPhragmen', 'treasury']) {
            assert.ok(GOV_TRIGGER_SECTIONS.includes(s), s + ' is not a trigger');
        }
    });

    test('any governance event refreshes democracy, treasury and council', () => {
        for (const s of ['democracy', 'council', 'elections', 'phragmenElection', 'treasury', 'technicalCommittee']) {
            const got = govSyncsForEvents([ev('balances'), ev(s)]);
            for (const want of ['democracy', 'treasury', 'council']) assert.ok(got.includes(want), `${s} -> ${want}`);
        }
    });

    test('the technical committee sync runs only for its own events', () => {
        assert.ok(govSyncsForEvents([ev('technicalCommittee')]).includes('technicalCommittee'));
        assert.ok(!govSyncsForEvents([ev('council')]).includes('technicalCommittee'));
    });

    test('section names match case-insensitively, as the old hook did', () => {
        assert.deepEqual(govSyncsForEvents([ev('Democracy')]).sort(), ['council', 'democracy', 'treasury']);
    });

    test('treasury.Deposit (fee share, nearly every block) is not a trigger', () => {
        // Transaction fees are split into the treasury, so a Deposit event
        // lands in most blocks with any transaction. Triggering on it would run
        // all three syncs back to back for ever.
        assert.deepEqual(govSyncsForEvents([ev('treasury', 'Deposit'), ev('balances', 'Withdraw')]), []);
        assert.deepEqual(govSyncsForEvents([ev('Treasury', 'deposit')]), []);
        assert.ok(govSyncsForEvents([ev('treasury', 'Deposit'), ev('treasury', 'Proposed')]).includes('treasury'));
        assert.ok(govSyncsForEvents([ev('treasury', 'Awarded')]).includes('democracy'));
    });

    test('a block with no governance event starts nothing', () => {
        assert.deepEqual(govSyncsForEvents([ev('balances'), ev('system'), ev('staking')]), []);
        assert.deepEqual(govSyncsForEvents([]), []);
        assert.deepEqual(govSyncsForEvents(null), []);
        assert.deepEqual(govSyncsForEvents([null, {}, { section: 42 }]), []);
    });

    test('many governance events in one block name each sync once', () => {
        const got = govSyncsForEvents([ev('democracy'), ev('democracy'), ev('council'), ev('treasury'), ev('technicalCommittee'), ev('technicalCommittee')]);
        assert.equal(got.length, new Set(got).size);
        assert.equal(got.length, 4);
    });
});

describe('sync runner: no overlap, triggers coalesce', () => {
    const deferred = () => { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; };

    test('a second trigger during a run does not start a parallel run', async () => {
        const runner = makeSyncRunner();
        let active = 0, maxActive = 0, calls = 0;
        const gate = deferred();
        const fn = async () => { calls++; active++; maxActive = Math.max(maxActive, active); if (calls === 1) await gate.p; active--; };
        const a = runner.run('democracy', fn);
        const b = runner.run('democracy', fn);
        const c = runner.run('democracy', fn);
        assert.equal(calls, 1, 'only one run while the first is in flight');
        assert.ok(runner.busy('democracy'));
        gate.resolve();
        await Promise.all([a, b, c]);
        assert.equal(maxActive, 1, 'two runs of the same sync overlapped');
        assert.equal(calls, 2, 'the triggers during the run collapse into ONE follow-up run');
        assert.ok(!runner.busy('democracy'));
    });

    test('the follow-up run is not lost: it reads state after the trigger', async () => {
        const runner = makeSyncRunner();
        let chain = 1; const seen = [];
        const gate = deferred();
        const fn = async () => { const v = chain; if (!seen.length) await gate.p; seen.push(v); };
        const first = runner.run('treasury', fn);
        chain = 2;                       // the block that triggers lands mid-run
        runner.run('treasury', fn);
        gate.resolve();
        await first;
        assert.deepEqual(seen, [1, 2]);
    });

    test('different syncs run independently', async () => {
        const runner = makeSyncRunner();
        const gate = deferred();
        let council = 0;
        const d = runner.run('democracy', () => gate.p);
        await runner.run('council', async () => { council++; });
        assert.equal(council, 1, 'council waited for democracy');
        gate.resolve();
        await d;
    });

    test('a throwing sync is reported and does not wedge the runner', async () => {
        const errors = [];
        const runner = makeSyncRunner({ onError: (name, e) => errors.push(name + ':' + e.message) });
        await runner.run('council', async () => { throw new Error('rpc down'); });
        assert.deepEqual(errors, ['council:rpc down']);
        assert.ok(!runner.busy('council'));
        let ran = false;
        await runner.run('council', async () => { ran = true; });
        assert.ok(ran);
    });

    test('a synchronous throw is handled the same way', async () => {
        const errors = [];
        const runner = makeSyncRunner({ onError: (n) => errors.push(n) });
        await runner.run('x', () => { throw new Error('boom'); });
        assert.deepEqual(errors, ['x']);
    });
});

describe('?fresh=1', () => {
    test('isFreshRequest', () => {
        assert.equal(isFreshRequest({ fresh: '1' }), true);
        assert.equal(isFreshRequest({ fresh: 'true' }), true);
        assert.equal(isFreshRequest({}), false);
        assert.equal(isFreshRequest(null), false);
        assert.equal(isFreshRequest({ fresh: '' }), false);
        assert.equal(isFreshRequest({ fresh: '0' }), false);
    });
});

// --- server.js wiring ------------------------------------------------------
const routeBody = (path) => {
    const start = serverSrc.indexOf(`app.get('${path}'`);
    assert.ok(start !== -1, path + ' route not found');
    return serverSrc.slice(start, serverSrc.indexOf('\n});', start));
};

describe('server.js wiring', () => {
    test('the per-block hook asks govSyncsForEvents and runs each named sync', () => {
        const at = serverSrc.indexOf('const forward = await scanChainRange(');
        const hook = serverSrc.slice(at, serverSrc.indexOf('if (forward.failedNumbers', at));
        assert.match(hook, /govSyncsForEvents\(forward\.events\)/);
        assert.match(hook, /runGovSync\(/);
        assert.ok(!/syncCouncil\(\)\.catch/.test(hook), 'the old direct council call is still there');
    });

    test('every governance sync goes through the shared runner', () => {
        for (const [fn, key] of [['syncDemocracy', 'democracy'], ['syncTreasury', 'treasury'], ['syncCouncil', 'council'], ['syncTechnicalCommittee', 'technicalCommittee']]) {
            assert.match(serverSrc, new RegExp(`function ${fn}\\(\\) \\{ return govSyncRunner\\.run\\('${key}', ${fn}Pass\\); \\}`), fn);
            assert.match(serverSrc, new RegExp(`async function ${fn}Pass\\(\\)`), fn + 'Pass');
        }
    });

    for (const path of ['/api/democracy', '/api/treasury', '/api/council', '/api/technical-committee']) {
        test(`${path}: short tier, no-store on ?fresh=1`, () => {
            const body = routeBody(path);
            assert.match(body, /if \(isFreshRequest\(req\.query\)\) res\.set\('Cache-Control', 'no-store'\); else cacheShort\(res\);/);
            assert.ok(!/cacheLong\(res\)|cacheMedium\(res\)/.test(body), path + ' still has a slower tier');
        });
    }

    test('the /developers cache table agrees', () => {
        const tierOf = (r) => CACHE_TIERS.find(t => t.routes.includes(r));
        assert.equal(tierOf('/api/democracy').name, 'Short');
        assert.equal(tierOf('/api/treasury').name, 'Short');
    });
});
