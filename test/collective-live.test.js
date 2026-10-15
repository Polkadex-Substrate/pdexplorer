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
