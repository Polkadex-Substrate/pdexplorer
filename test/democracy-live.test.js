// Live democracy storage subscriptions (lib/democracy-live.js), against a fake
// polkadot-js api. The Democracy page used to show the backend snapshot from
// page entry until a reload; a vote, a new referendum or a referendum ending
// was invisible while the page was open. These check the bookkeeping that
// replaces it: which storage is watched, that the watched referendum set
// follows referendumCount and lowestUnbaked, that a missing pallet or storage
// item is skipped rather than fatal (the chain upgrades soon), that leaving
// the page releases everything, and that the poll takes over while the node
// link is down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startDemocracyLive, resolveDemocracy, decodeReferendum, decodeVoting, decodeDeposit,
    watchedReferenda, planckToPdex, MAX_WATCHED_REFERENDA } from '../lib/democracy-live.js';
import { liveWhileConnected } from '../lib/collective-live.js';

const PDEX = 10n ** 12n;
const codec = (v) => ({ toString: () => String(v), toNumber: () => Number(v) });
const bal = (pdex) => codec((BigInt(pdex) * PDEX).toString());
const some = (inner) => ({ isSome: true, isNone: false, unwrap: () => inner });
const NONE = { isSome: false, isNone: true };
const ongoing = ({ end, ayes, nays, turnout, threshold = 'SuperMajorityApprove', proposal = '0xabc' }) => some({
    isOngoing: true, isFinished: false,
    asOngoing: { end: codec(end), threshold: codec(threshold), proposal: codec(proposal),
        tally: { ayes: bal(ayes), nays: bal(nays), turnout: bal(turnout) } }
});
const finished = (approved, end) => some({ isOngoing: false, isFinished: true, asFinished: { approved: { isTrue: approved }, end: codec(end) } });
// publicProps entry: (index, proposal, proposer); a Vec codec is an Array.
const prop = (i, who) => [codec(i), codec('0xbeef' + i), codec(who)];
const deposit = (seconders, pdex) => some([seconders.map(codec), bal(pdex)]);

function fakeApi({ omit = [], deferUnsub = false } = {}) {
    const log = { unsubbed: [], infoMulti: [], depositMulti: [], votingOf: [], subs: [] };
    const cbs = {};
    const multiCbs = { info: [], deposit: [] };
    const mkUnsub = (name) => {
        log.subs.push(name);
        const u = () => log.unsubbed.push(name);
        return deferUnsub ? new Promise(r => setTimeout(() => r(u), 5)) : Promise.resolve(u);
    };
    const sub = (name) => (cb) => { cbs[name] = cb; return mkUnsub(name); };
    const democracy = {
        referendumCount: sub('referendumCount'),
        lowestUnbaked: sub('lowestUnbaked'),
        publicProps: sub('publicProps'),
        referendumInfoOf: Object.assign(() => { throw new Error('one-shot read not expected'); }, {
            multi: (keys, cb) => { log.infoMulti.push(keys.slice()); multiCbs.info.push(cb); return mkUnsub('info:' + keys.join(',')); }
        }),
        depositOf: Object.assign(() => { throw new Error('one-shot read not expected'); }, {
            multi: (keys, cb) => { log.depositMulti.push(keys.slice()); multiCbs.deposit.push(cb); return mkUnsub('deposit:' + keys.join(',')); }
        }),
        votingOf: (who, cb) => { log.votingOf.push(who); cbs.votingOf = cb; return mkUnsub('votingOf'); }
    };
    for (const k of omit) delete democracy[k];
    const api = {
        query: {
            democracy,
            // The page must never watch the whole event stream in the browser.
            system: { events: () => { throw new Error('system.events subscribed'); } }
        }
    };
    return {
        api, log,
        emit: (name, v) => cbs[name](v),
        emitInfo: (list) => multiCbs.info[multiCbs.info.length - 1](list),
        emitDeposit: (list) => multiCbs.deposit[multiCbs.deposit.length - 1](list)
    };
}
const tick = () => new Promise(r => setTimeout(r, 15));

describe('decoding', () => {
    test('planck to PDEX matches the server (12 decimals, big values)', () => {
        assert.equal(planckToPdex('1500000000000'), 1.5);
        assert.equal(planckToPdex(codec('0')), 0);
        assert.equal(planckToPdex('0x' + (3n * PDEX).toString(16)), 3);
        assert.equal(planckToPdex(null), 0);
        assert.equal(planckToPdex('garbage'), 0);
    });

    test('an ongoing referendum becomes a row with its tally in PDEX', () => {
        const r = decodeReferendum(7, ongoing({ end: 900, ayes: 10, nays: 4, turnout: 14 }));
        assert.deepEqual(r, { refIndex: 7, status: 'Ongoing', endBlock: 900, ayes: 10, nays: 4, turnout: 14, tallyKnown: 1,
            threshold: 'SuperMajorityApprove', proposal: '0xabc' });
    });

    test('a finished referendum keeps the last tally seen', () => {
        const prev = { refIndex: 7, status: 'Ongoing', endBlock: 900, ayes: 10, nays: 4, turnout: 14, tallyKnown: 1 };
        const r = decodeReferendum(7, finished(true, 901), prev);
        assert.equal(r.status, 'Passed');
        assert.equal(r.endBlock, 901);
        assert.equal(r.ayes, 10);
        assert.equal(decodeReferendum(7, finished(false, 901)).status, 'NotPassed');
        assert.equal(decodeReferendum(7, finished(false, 901)).tallyKnown, 0);
    });

    test('None is null (the caller decides whether that means cancelled)', () => {
        assert.equal(decodeReferendum(1, NONE), null);
        assert.equal(decodeReferendum(1, null), null);
    });

    test('a long proposal string is clipped like the server clips it', () => {
        const r = decodeReferendum(1, ongoing({ end: 1, ayes: 0, nays: 0, turnout: 0, proposal: 'x'.repeat(400) }));
        assert.equal(r.proposal.length, 66);
    });

    test('deposits: (seconders, balance) and the older (balance, seconders)', () => {
        assert.deepEqual(decodeDeposit(deposit(['a', 'b', 'c'], 100)), { seconds: 3, deposit: 100 });
        assert.deepEqual(decodeDeposit(some([bal(50), ['a'].map(codec)])), { seconds: 1, deposit: 50 });
        assert.equal(decodeDeposit(NONE), null);
    });

    test('votingOf: direct standard votes, split votes, delegating', () => {
        const std = (aye, conviction, pdex) => ({ isStandard: true, asStandard: { vote: { isAye: aye, conviction: codec(conviction) }, balance: bal(pdex) } });
        const direct = { isDirect: true, asDirect: { votes: [[codec(3), std(true, 'Locked2x', 5)], [codec(4), std(false, 'None', 1)],
            [codec(6), { isSplit: true, asSplit: { aye: bal(2), nay: bal(3) } }]] } };
        const v = decodeVoting(direct);
        assert.equal(v.delegating, false);
        assert.deepEqual(v.votes[3], { aye: true, conviction: 'Locked2x', balance: 5 });
        assert.deepEqual(v.votes[4], { aye: false, conviction: 'None', balance: 1 });
        assert.deepEqual(v.votes[6], { split: true, aye: null, ayeBalance: 2, nayBalance: 3, balance: 5 });
        assert.deepEqual(decodeVoting({ isDelegating: true, asDelegating: {} }), { delegating: true, votes: {} });
        assert.equal(decodeVoting(null), null);
    });
});

describe('which referenda are watched', () => {
    test('lowestUnbaked..count, plus the ones REST or the feed still has open', () => {
        assert.deepEqual(watchedReferenda({ count: 5, lowestUnbaked: 3, known: [1], held: [] }), [1, 3, 4]);
        assert.deepEqual(watchedReferenda({ count: 5, lowestUnbaked: 5, known: [], held: [2] }), [2]);
    });

    test('without lowestUnbaked, the open ones plus every index REST has not seen', () => {
        assert.deepEqual(watchedReferenda({ count: 6, lowestUnbaked: null, known: [2], held: [], restCount: 4 }), [2, 4, 5]);
    });

    test('capped, newest kept', () => {
        const w = watchedReferenda({ count: 1000, lowestUnbaked: 0, known: [], held: [] });
        assert.equal(w.length, MAX_WATCHED_REFERENDA);
        assert.equal(w[w.length - 1], 999);
    });

    test('junk in the inputs is ignored', () => {
        assert.deepEqual(watchedReferenda({ count: 2, lowestUnbaked: 1, known: [null, 'x', -1, 1.5], held: undefined }), [1]);
    });
});

describe('subscriptions', () => {
    test('resolves the pallet only when the storage it needs is there', () => {
        assert.ok(resolveDemocracy(fakeApi().api));
        assert.equal(resolveDemocracy(fakeApi({ omit: ['referendumInfoOf'] }).api), null);
        assert.equal(resolveDemocracy({ query: {} }), null);
        assert.equal(resolveDemocracy(null), null);
    });

    test('watches count, lowestUnbaked, publicProps and the account; never system.events', async () => {
        const f = fakeApi();
        const feed = startDemocracyLive(f.api, { account: 'eAlice' });
        await tick();
        assert.deepEqual(f.log.subs.sort(), ['lowestUnbaked', 'publicProps', 'referendumCount', 'votingOf']);
        assert.deepEqual(f.log.votingOf, ['eAlice']);
        feed.stop();
    });

    test('no account, no votingOf subscription', async () => {
        const f = fakeApi();
        const feed = startDemocracyLive(f.api, {});
        await tick();
        assert.ok(!f.log.subs.includes('votingOf'));
        feed.stop();
    });

    test('the referendum subscription follows count and lowestUnbaked', async () => {
        const f = fakeApi();
        const updates = [];
        const feed = startDemocracyLive(f.api, { knownOpen: () => [1], onUpdate: (k) => updates.push(k) });
        f.emit('referendumCount', codec(5));
        assert.equal(f.log.infoMulti.length, 0, 'subscribed before lowestUnbaked arrived');
        f.emit('lowestUnbaked', codec(3));
        assert.deepEqual(f.log.infoMulti, [[1, 3, 4]]);
        f.emitInfo([finished(true, 50), ongoing({ end: 900, ayes: 1, nays: 0, turnout: 1 }), ongoing({ end: 950, ayes: 0, nays: 0, turnout: 0 })]);
        assert.equal(feed.state.refs[1].status, 'Passed');
        assert.equal(feed.state.refs[3].ayes, 1);
        assert.ok(updates.includes('refs'));
        // A new referendum is started.
        f.emit('referendumCount', codec(6));
        await tick();
        assert.deepEqual(f.log.infoMulti[f.log.infoMulti.length - 1], [1, 3, 4, 5]);
        assert.ok(f.log.unsubbed.includes('info:1,3,4'), 'the old referendum subscription was left running');
        // The same count again changes nothing.
        const n = f.log.infoMulti.length;
        f.emit('referendumCount', codec(6));
        assert.equal(f.log.infoMulti.length, n);
        feed.stop();
    });

    test('a referendum that ends stays watched until the feed has seen it end', async () => {
        const f = fakeApi();
        const feed = startDemocracyLive(f.api, {});
        f.emit('referendumCount', codec(3));
        f.emit('lowestUnbaked', codec(2));
        f.emitInfo([ongoing({ end: 10, ayes: 5, nays: 1, turnout: 6 })]);
        // lowestUnbaked moves past it BEFORE its Finished value arrives.
        f.emit('lowestUnbaked', codec(3));
        assert.deepEqual(f.log.infoMulti[f.log.infoMulti.length - 1], [2]);
        f.emitInfo([finished(false, 10)]);
        assert.equal(feed.state.refs[2].status, 'NotPassed');
        assert.equal(feed.state.refs[2].ayes, 5, 'the last live tally was dropped');
        await tick();
        // Now nothing is open: the subscription is released, not re-made.
        assert.ok(f.log.unsubbed.includes('info:2'));
        feed.stop();
    });

    test('a known referendum that disappears from storage is shown as ended (cancelled)', () => {
        const f = fakeApi();
        const feed = startDemocracyLive(f.api, { knownOpen: () => [4] });
        f.emit('referendumCount', codec(5));
        f.emit('lowestUnbaked', codec(5));
        f.emitInfo([NONE]);
        assert.equal(feed.state.refs[4].status, 'NotPassed');
        assert.equal(feed.state.refs[4].cancelled, true);
        feed.stop();
    });

    test('public proposals and their seconds', async () => {
        const f = fakeApi();
        const updates = [];
        const feed = startDemocracyLive(f.api, { onUpdate: (k) => updates.push(k), toAddress: (a) => 'e:' + a });
        f.emit('publicProps', [prop(2, 'bob'), prop(3, 'carol')]);
        assert.deepEqual(feed.state.props.map(p => p.index), [2, 3]);
        assert.equal(feed.state.props[0].proposer, 'e:bob');
        assert.deepEqual(f.log.depositMulti, [[2, 3]]);
        f.emitDeposit([deposit(['bob'], 10), deposit(['carol', 'dave'], 20)]);
        assert.deepEqual(feed.state.deposits[3], { seconds: 2, deposit: 20 });
        assert.ok(updates.includes('props') && updates.includes('deposits'));
        // Tabled: proposal 2 leaves the list.
        f.emit('publicProps', [prop(3, 'carol')]);
        await tick();
        assert.deepEqual(f.log.depositMulti[f.log.depositMulti.length - 1], [3]);
        assert.equal(feed.state.deposits[2], undefined);
        feed.stop();
    });

    test('the account voting record', () => {
        const f = fakeApi();
        const feed = startDemocracyLive(f.api, { account: 'eAlice' });
        f.emit('votingOf', { isDirect: true, asDirect: { votes: [[codec(9), { isStandard: true, asStandard: { vote: { isAye: true, conviction: codec('None') }, balance: bal(1) } }]] } });
        assert.equal(feed.state.voting.votes[9].aye, true);
        feed.stop();
    });

    test('stop() releases everything, including subscriptions that resolve later', async () => {
        const f = fakeApi({ deferUnsub: true });
        const feed = startDemocracyLive(f.api, { account: 'eAlice' });
        f.emit('referendumCount', codec(2));
        f.emit('lowestUnbaked', codec(0));
        f.emit('publicProps', [prop(1, 'bob')]);
        feed.stop();
        await tick();
        for (const s of f.log.subs) assert.ok(f.log.unsubbed.includes(s), s + ' left running');
    });

    test('nothing is delivered after stop()', () => {
        const f = fakeApi();
        const updates = [];
        const feed = startDemocracyLive(f.api, { onUpdate: (k) => updates.push(k) });
        f.emit('referendumCount', codec(2));
        f.emit('lowestUnbaked', codec(1));
        feed.stop();
        updates.length = 0;
        f.emitInfo([ongoing({ end: 1, ayes: 1, nays: 1, turnout: 2 })]);
        f.emit('publicProps', [prop(1, 'x')]);
        assert.deepEqual(updates, []);
        assert.deepEqual(feed.state.refs, {});
    });

    test('stop() twice is harmless', () => {
        const feed = startDemocracyLive(fakeApi().api, {});
        feed.stop();
        feed.stop();
    });
});

describe('missing pallet or storage items (runtime upgrades)', () => {
    test('no democracy pallet: an empty feed, no throw', () => {
        const feed = startDemocracyLive({ query: {} }, {});
        assert.equal(feed.state.available, false);
        feed.stop();
    });

    test('no lowestUnbaked: count plus the REST open set', () => {
        const f = fakeApi({ omit: ['lowestUnbaked'] });
        const feed = startDemocracyLive(f.api, { knownOpen: () => [2], restCount: () => 3 });
        f.emit('referendumCount', codec(4));
        assert.deepEqual(f.log.infoMulti, [[2, 3]]);
        feed.stop();
    });

    test('no depositOf, no votingOf, no publicProps: the rest still runs', () => {
        const f = fakeApi({ omit: ['depositOf', 'votingOf', 'publicProps'] });
        const feed = startDemocracyLive(f.api, { account: 'eAlice' });
        f.emit('referendumCount', codec(1));
        f.emit('lowestUnbaked', codec(0));
        assert.deepEqual(f.log.infoMulti, [[0]]);
        assert.equal(feed.state.props, null);
        feed.stop();
    });

    test('a subscription that throws synchronously is reported, not fatal', () => {
        const f = fakeApi();
        f.api.query.democracy.publicProps = () => { throw new Error('storage item renamed'); };
        const errors = [];
        const feed = startDemocracyLive(f.api, { onError: (e) => errors.push(e.message) });
        f.emit('referendumCount', codec(1));
        f.emit('lowestUnbaked', codec(0));
        assert.deepEqual(errors, ['storage item renamed']);
        assert.deepEqual(f.log.infoMulti, [[0]]);
        feed.stop();
    });

    test('a rejected subscription promise is reported', async () => {
        const f = fakeApi();
        f.api.query.democracy.lowestUnbaked = () => Promise.reject(new Error('rpc refused'));
        const errors = [];
        const feed = startDemocracyLive(f.api, { onError: (e) => errors.push(e.message) });
        await tick();
        assert.deepEqual(errors, ['rpc refused']);
        f.emit('referendumCount', codec(2));
        assert.deepEqual(f.log.infoMulti, [[0, 1]], 'a failed lowestUnbaked must not stall the referenda');
        feed.stop();
    });
});

describe('page wiring: one feed per page visit, poll while disconnected', () => {
    function eventedApi() {
        const f = fakeApi();
        const handlers = {};
        f.api.isConnected = true;
        f.api.on = (ev, h) => { (handlers[ev] = handlers[ev] || []).push(h); };
        f.api.off = (ev, h) => { handlers[ev] = (handlers[ev] || []).filter(x => x !== h); };
        f.fire = (ev) => (handlers[ev] || []).slice().forEach(h => h());
        f.handlers = handlers;
        return f;
    }

    test('starting twice (route re-entry) makes one set of subscriptions', async () => {
        const f = eventedApi();
        let started = 0;
        const ctl = liveWhileConnected(f.api, (api) => { started++; return startDemocracyLive(api, {}); });
        ctl.start();
        ctl.start();
        await tick();
        assert.equal(started, 1);
        assert.equal(f.log.subs.filter(s => s === 'referendumCount').length, 1);
        // Leave and come back: the old set is released, one new set made.
        ctl.stop();
        ctl.start();
        await tick();
        assert.equal(started, 2);
        assert.equal(f.log.unsubbed.filter(s => s === 'referendumCount').length, 1);
        ctl.dispose();
    });

    test('disconnected: no live state (the poll is the truth); reconnect: a fresh feed', async () => {
        const f = eventedApi();
        const changes = [];
        const ctl = liveWhileConnected(f.api, (api) => startDemocracyLive(api, {}), { onChange: (w) => changes.push(w) });
        ctl.start();
        assert.ok(ctl.current());
        f.api.isConnected = false;
        f.fire('disconnected');
        assert.equal(ctl.current(), null);
        f.api.isConnected = true;
        f.fire('connected');
        assert.ok(ctl.current());
        assert.deepEqual(changes, ['disconnected', 'connected']);
        ctl.stop();
        f.fire('connected');
        assert.equal(ctl.current(), null, 'a reconnect after leaving the page restarted the feed');
        ctl.dispose();
        assert.equal((f.handlers.connected || []).length, 0);
    });
});
