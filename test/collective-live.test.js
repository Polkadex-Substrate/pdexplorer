// Live council motion subscriptions (lib/collective-live.js), against a fake
// polkadot-js api. The page used to show a snapshot that only changed on a
// 30 s poll of a backend cache; a member's vote took up to a minute to appear.
// These check the subscription bookkeeping that replaces it: the right
// storage is watched, the voting subscription follows the open-motion list,
// and nothing is left subscribed after the page is left, including
// subscriptions that resolve after stop() was called.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startCollectiveLive, votingToRecord, resolveCollectivePallet } from '../lib/collective-live.js';

const codec = (v) => ({ toString: () => String(v), toNumber: () => Number(v) });
const someVoting = (rec) => ({
    isSome: true, isNone: false,
    unwrap: () => ({
        index: codec(rec.index), threshold: codec(rec.threshold), end: codec(rec.end),
        ayes: rec.ayes.map(codec), nays: rec.nays.map(codec)
    })
});
const NONE = { isSome: false, isNone: true };

function fakeApi({ deferUnsub = false } = {}) {
    const log = { unsubbed: [], multi: [], proposalOf: [] };
    let proposalsCb = null;
    const multiCbs = [];
    const mkUnsub = (name) => {
        const u = () => log.unsubbed.push(name);
        return deferUnsub ? new Promise(r => setTimeout(() => r(u), 5)) : Promise.resolve(u);
    };
    const council = {
        proposals: (cb) => { proposalsCb = cb; return mkUnsub('proposals'); },
        proposalOf: (h) => {
            log.proposalOf.push(h);
            return Promise.resolve({
                isSome: true,
                unwrap: () => ({ section: 'treasury', method: 'approveProposal', encodedLength: 6, args: [codec(9)], meta: { args: [{ name: 'proposal_id' }] } })
            });
        },
        voting: { multi: (hashes, cb) => { log.multi.push(hashes.slice()); multiCbs.push(cb); return mkUnsub('voting:' + hashes.join(',')); } }
    };
    return {
        api: { query: { council } },
        log,
        emitProposals: (hashes) => proposalsCb(hashes.map(codec)),
        emitVoting: (list) => multiCbs[multiCbs.length - 1](list)
    };
}
const tick = () => new Promise(r => setTimeout(r, 15));

describe('pallet resolution', () => {
    test('finds the collective by name, or nothing', () => {
        const { api } = fakeApi();
        assert.equal(resolveCollectivePallet(api, ['councilCollective', 'council']), 'council');
        assert.equal(resolveCollectivePallet(api, ['technicalCommittee']), null);
        assert.equal(resolveCollectivePallet(null, ['council']), null);
    });
});

describe('voting record decoding', () => {
    test('Option<Votes> to a plain record, addresses normalised', () => {
        const r = votingToRecord(someVoting({ index: 7, threshold: 3, end: 500, ayes: ['a1'], nays: ['n1', 'n2'] }), (a) => 'e' + a);
        assert.deepEqual(r, { index: 7, threshold: 3, end: 500, ayes: ['ea1'], nays: ['en1', 'en2'] });
        assert.equal(votingToRecord(NONE), null);
        assert.equal(votingToRecord(null), null);
    });
});

describe('subscriptions follow the open motions', () => {
    test('votes arrive through onUpdate and patch the state', async () => {
        const f = fakeApi();
        const updates = [];
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: (k, u) => updates.push([k, u.kind]) });
        await tick();
        f.emitProposals(['0xa']);
        await tick();
        assert.deepEqual(f.log.multi, [['0xa']]);
        f.emitVoting([someVoting({ index: 1, threshold: 3, end: 10, ayes: ['m1'], nays: [] })]);
        assert.deepEqual(live.state.council.votings['0xa'].ayes, ['m1']);
        f.emitVoting([someVoting({ index: 1, threshold: 3, end: 10, ayes: ['m1', 'm2'], nays: [] })]);
        assert.deepEqual(live.state.council.votings['0xa'].ayes, ['m1', 'm2']);
        assert.deepEqual(updates.filter(u => u[1] === 'voting').length, 2);
        live.stop();
    });

    test('a new motion resubscribes voting and fetches its call once', async () => {
        const f = fakeApi();
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {}, knownHashes: () => ['0xa'] });
        await tick();
        f.emitProposals(['0xa']);
        await tick();
        f.emitProposals(['0xa', '0xb']);
        await tick();
        assert.deepEqual(f.log.multi, [['0xa'], ['0xa', '0xb']]);
        assert.ok(f.log.unsubbed.includes('voting:0xa'), 'old voting subscription released');
        assert.deepEqual(f.log.proposalOf, ['0xb'], 'only the motion REST did not know');
        assert.equal(live.state.council.stubs['0xb'].method, 'approveProposal');
        assert.equal(live.state.council.stubs['0xb'].lengthBound, 6);
        live.stop();
    });

    test('a closed motion drops out of the state', async () => {
        const f = fakeApi();
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {} });
        await tick();
        f.emitProposals(['0xa', '0xb']);
        await tick();
        f.emitVoting([someVoting({ index: 1, threshold: 3, end: 10, ayes: [], nays: [] }), someVoting({ index: 2, threshold: 3, end: 10, ayes: [], nays: [] })]);
        f.emitProposals(['0xb']);
        await tick();
        assert.deepEqual(live.state.council.hashes, ['0xb']);
        assert.equal('0xa' in live.state.council.votings, false);
        live.stop();
    });

    test('stop() releases everything, including late-resolving subscriptions', async () => {
        const f = fakeApi({ deferUnsub: true });
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {} });
        live.stop();              // before proposals() has even resolved
        await tick();
        assert.ok(f.log.unsubbed.includes('proposals'), 'a subscription that resolved after stop() was left running');
    });

    test('no updates are delivered after stop()', async () => {
        const f = fakeApi();
        let n = 0;
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => { n++; } });
        await tick();
        f.emitProposals(['0xa']);
        await tick();
        const before = n;
        live.stop();
        f.emitVoting([someVoting({ index: 1, threshold: 3, end: 10, ayes: ['x'], nays: [] })]);
        assert.equal(n, before);
        assert.ok(f.log.unsubbed.includes('voting:0xa'));
    });

    test('a runtime without the collective is a no-op, not a throw', () => {
        const live = startCollectiveLive({ query: {} }, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {} });
        assert.deepEqual(Object.keys(live.state), []);
        live.stop();
    });
});

// Second Checker round. Namespace import so a missing export fails its own
// tests, not the whole file.
import * as CL from '../lib/collective-live.js';
import { overlayLiveMotions } from '../lib/tx-status.js';

// A node link that can drop and come back, like ApiPromise's events.
function fakeLink(connected = true) {
    const on = {};
    const api = {
        isConnected: connected,
        on: (ev, fn) => { (on[ev] = on[ev] || []).push(fn); },
        off: (ev, fn) => { on[ev] = (on[ev] || []).filter(f => f !== fn); }
    };
    const emit = (ev) => { api.isConnected = ev === 'connected'; for (const fn of (on[ev] || []).slice()) fn(); };
    return { api, emit, listeners: (ev) => (on[ev] || []).length };
}
function feedMaker() {
    const feeds = [];
    const start = () => { const f = { stopped: false, state: { council: { hashes: ['0xold'], votings: { '0xold': { index: 1, threshold: 3, end: 9, ayes: ['m1'], nays: [] } }, stubs: {} } }, stop() { this.stopped = true; } }; feeds.push(f); return f; };
    return { feeds, start };
}

describe('M3: while the node link is down the poll is the source of truth', () => {
    test('disconnect drops the live feed; reconnect starts a fresh one', () => {
        const L = fakeLink();
        const { feeds, start } = feedMaker();
        const changes = [];
        const ctl = CL.liveWhileConnected(L.api, start, { onChange: (why) => changes.push(why) });
        ctl.start();
        assert.equal(feeds.length, 1);
        assert.equal(ctl.current(), feeds[0]);
        L.emit('disconnected');
        assert.equal(ctl.current(), null, 'stale live state must not overlay the poll');
        assert.equal(feeds[0].stopped, true);
        L.emit('connected');
        assert.equal(feeds.length, 2, 'a fresh subscription set on reconnect');
        assert.equal(ctl.current(), feeds[1]);
        assert.deepEqual(changes, ['disconnected', 'connected']);
        ctl.stop();
        assert.equal(feeds[1].stopped, true);
        L.emit('connected');
        assert.equal(feeds.length, 2, 'no restart after the page is left');
    });
    test('null even before the disconnected event lands, and no feed until connected', () => {
        const L = fakeLink(false);
        const { feeds, start } = feedMaker();
        const ctl = CL.liveWhileConnected(L.api, start);
        ctl.start();
        assert.equal(feeds.length, 0);
        assert.equal(ctl.current(), null);
        L.emit('connected');
        assert.equal(feeds.length, 1);
        L.api.isConnected = false;          // link down, event not delivered yet
        assert.equal(ctl.current(), null);
        ctl.dispose();
        assert.equal(L.listeners('connected') + L.listeners('disconnected'), 0);
    });
    test('during the outage new motions and tallies come from the poll', () => {
        const L = fakeLink();
        const { start } = feedMaker();
        const ctl = CL.liveWhileConnected(L.api, start);
        ctl.start();
        const rest = [
            { hash: '0xold', index: 1, threshold: 3, ayes: ['m1', 'm2'], nays: [], end: 9 },
            { hash: '0xnew', index: 2, threshold: 3, ayes: [], nays: [], end: 20 }
        ];
        const live = () => { const f = ctl.current(); return (f && f.state.council) || null; };
        assert.equal(overlayLiveMotions(rest, live()).length, 1, 'premise: the stale live set hides the new motion');
        L.emit('disconnected');
        const shown = overlayLiveMotions(rest, live());
        assert.deepEqual(shown.map(m => m.hash).sort(), ['0xnew', '0xold']);
        assert.deepEqual(shown.find(m => m.hash === '0xold').ayes, ['m1', 'm2'], 'tally from the poll');
        ctl.stop();
    });
});

describe('L7: keep asking for ?fresh=1 for two more polls', () => {
    test('a fresh read carries to the next two polls of the same URL only', () => {
        const carry = {};
        assert.equal(CL.FRESH_CARRY, 2);
        assert.equal(CL.freshPlan(carry, '/api/council', false), false);
        assert.equal(CL.freshPlan(carry, '/api/council', true), true);
        assert.equal(CL.freshPlan(carry, '/api/technical-committee', false), false, 'per URL');
        assert.equal(CL.freshPlan(carry, '/api/council', false), true);
        assert.equal(CL.freshPlan(carry, '/api/council', false), true);
        assert.equal(CL.freshPlan(carry, '/api/council', false), false);
    });
    test('another fresh read restarts the carry', () => {
        const carry = {};
        CL.freshPlan(carry, '/api/council', true);
        CL.freshPlan(carry, '/api/council', false);
        CL.freshPlan(carry, '/api/council', true);
        assert.equal(CL.freshPlan(carry, '/api/council', false), true);
        assert.equal(CL.freshPlan(carry, '/api/council', false), true);
        assert.equal(CL.freshPlan(carry, '/api/council', false), false);
    });
});

// Live governance, part two: seats. A new member, a changed prime or an
// election round used to show only after the next poll of a backend snapshot
// that itself lagged the chain; the Aye/Nay buttons and "Your Role" follow
// the seat, so a new member could not vote from the page for minutes.
describe('members, prime and the elections pallet', () => {
    function seatApi({ withElections = true, omitPrime = false } = {}) {
        const f = fakeApi();
        const cbs = {};
        const subs = [];
        const mk = (name) => (...args) => { cbs[name] = args[args.length - 1]; subs.push(name); return Promise.resolve(() => f.log.unsubbed.push(name)); };
        f.api.query.council.members = mk('members');
        if (!omitPrime) f.api.query.council.prime = mk('prime');
        if (withElections) f.api.query.phragmenElection = { members: mk('e.members'), runnersUp: mk('e.runnersUp') };
        return { ...f, cbs, subs };
    }
    const seat = (who, stake) => ({ who: codec(who), stake: codec(String(BigInt(stake) * 10n ** 12n)) });

    test('members and prime are watched and land in the state', async () => {
        const f = seatApi();
        const kinds = [];
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], toAddress: (a) => 'e' + a, onUpdate: (k, u) => kinds.push(u.kind) });
        await tick();
        f.cbs.members([codec('m1'), codec('m2')]);
        f.cbs.prime({ isSome: true, unwrap: () => codec('m2') });
        assert.deepEqual(live.state.council.members, ['em1', 'em2']);
        assert.equal(live.state.council.prime, 'em2');
        f.cbs.prime({ isSome: false, isNone: true });
        assert.equal(live.state.council.prime, null);
        assert.ok(kinds.includes('members') && kinds.includes('prime'));
        live.stop();
        await tick();
        for (const s of ['members', 'prime', 'e.members', 'e.runnersUp']) assert.ok(f.log.unsubbed.includes(s), s + ' left running');
    });

    test('elections members and runners-up, both storage shapes', async () => {
        const f = seatApi();
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {} });
        await tick();
        f.cbs['e.members']([seat('m1', 100)]);
        f.cbs['e.runnersUp']([[codec('r1'), codec(String(5n * 10n ** 12n))]]);
        assert.deepEqual(live.state.council.elections, { members: [{ who: 'm1', stake: 100 }], runnersUp: [{ who: 'r1', stake: 5 }] });
        live.stop();
    });

    test('the technical committee gets members and prime but no elections', async () => {
        const f = seatApi();
        f.api.query.technicalCommittee = { ...f.api.query.council };
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'technicalCommittee', pallets: ['technicalCommittee'] }], onUpdate: () => {} });
        await tick();
        assert.ok(!f.subs.includes('e.members'));
        live.stop();
    });

    test('no prime, no elections pallet: the rest still runs', async () => {
        const f = seatApi({ withElections: false, omitPrime: true });
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {} });
        await tick();
        assert.deepEqual(f.subs, ['members']);
        assert.equal(live.state.council.elections, undefined);
        live.stop();
    });

    test('a seat subscription that throws is reported, motions still run', async () => {
        const f = fakeApi();
        f.api.query.council.members = () => { throw new Error('renamed'); };
        const errors = [];
        const live = startCollectiveLive(f.api, { collectives: [{ key: 'council', pallets: ['council'] }], onUpdate: () => {}, onError: (e) => errors.push(e.message) });
        await tick();
        f.emitProposals(['0xa']);
        await tick();
        assert.deepEqual(errors, ['renamed']);
        assert.deepEqual(f.log.multi, [['0xa']]);
        live.stop();
    });

    test('overlayLiveMembers: the live seat list wins, REST keeps stake and name', () => {
        const restMembers = [{ address: 'eA', stake: 10, name: 'Alice' }, { address: 'eGone', stake: 1 }];
        assert.equal(CL.overlayLiveMembers(restMembers, null), restMembers);
        assert.equal(CL.overlayLiveMembers(restMembers, { members: null }), restMembers);
        const out = CL.overlayLiveMembers(restMembers, { members: ['eA', 'eNew'] });
        assert.deepEqual(out, [{ address: 'eA', stake: 10, name: 'Alice' }, { address: 'eNew' }]);
        assert.deepEqual(CL.overlayLiveMembers(undefined, { members: ['eX'] }), [{ address: 'eX' }]);
    });
});
