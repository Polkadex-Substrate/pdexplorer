// R4 review fixes on the council candidacy row (lib/gov-post-action.js):
//   - a new candidate row shows the name the page already holds for that account (nameOf), and when no name is
//     known the short address, never "Unknown" (candidateLabel);
//   - a negative chain check is never cached: a browser node that lags the inclusion block answers "not listed"
//     first, and the row must still appear on a later re-read while the entry is pending, within the poll
//     deadline (pollDeadlineMs); a positive answer stays cached.
// Addresses are the public substrate dev accounts (test/helpers/payout-events.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import * as G from '../lib/gov-post-action.js';
import { pollDeadlineMs } from '../lib/freshness.js';
import { ME, V1 } from './helpers/payout-events.js';

const same = (a, b) => a === b;
const short = (a) => String(a).slice(0, 4) + '..' + String(a).slice(-3);
const council = () => ({ members: [{ address: V1, name: 'M1', stake: 10 }], runnersUp: [], candidates: [], desiredMembers: 3 });
const entry = (o = {}) => ({ id: 'k1', account: ME, domain: G.ELECTIONS, op: 'set', key: 'role', value: { role: 'Candidate' }, block: 42, txHash: '0x42', savedAt: 1000, ...o });
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

describe('a new candidate row is named from what the page holds', () => {
    const verified = new Map([['k1', { ok: true, stake: 100 }]]);
    test('electionsOverlay puts the known name on the new row', () => {
        const out = G.electionsOverlay(council(), ME, [entry()], { same, verified, nameOf: (a) => (a === ME ? 'Alice' : null) });
        assert.equal(out.candidates.length, 1);
        assert.equal(out.candidates[0].name, 'Alice');
    });
    test('with no name known the row carries no name at all (not the word Unknown)', () => {
        const out = G.electionsOverlay(council(), ME, [entry()], { same, verified, nameOf: () => null });
        assert.ok(!out.candidates[0].name || out.candidates[0].name !== 'Unknown');
        assert.equal(typeof G.candidateLabel, 'function', 'candidateLabel is not exported');
        assert.equal(G.candidateLabel(out.candidates[0], short), short(ME));
    });
    test('candidateLabel: a name wins; an empty name or the word Unknown falls back to the short address', () => {
        assert.equal(typeof G.candidateLabel, 'function', 'candidateLabel is not exported');
        assert.equal(G.candidateLabel({ address: ME, name: 'Bob' }, short), 'Bob');
        for (const name of [undefined, null, '', 'Unknown']) assert.equal(G.candidateLabel({ address: ME, name }, short), short(ME), String(name));
    });
    test('createGovRefresh hands its nameOf to the overlay', async () => {
        const g = G.createGovRefresh({
            doc: new Window().document, post: { subscribe() {} }, known: { list: () => [entry()], holdMs: 180000 }, same, selected: () => ME, onPage: () => true,
            api: () => ({ query: { elections: { members: async () => [], candidates: async () => ({ toJSON: () => [[ME, 1e12]] }) } } }),
            pages: { council: async () => null }, setTimer: () => 1, clearTimer() {}, nameOf: () => 'Alice'
        });
        g.overlay('council', council());
        await tick();
        const out = g.overlay('council', council());
        assert.equal(out.candidates.length, 1, 'fixture: the row did not appear');
        assert.equal(out.candidates[0].name, 'Alice');
    });
});

describe('a negative candidacy check is not cached', () => {
    function world(startOnChain) {
        const w = { reads: 0, listed: startOnChain, redraws: 0, clock: 1000 };
        w.g = G.createGovRefresh({
            doc: new Window().document, post: { subscribe() {} }, known: { list: () => [entry({ savedAt: 1000 })], holdMs: 180000 }, same, selected: () => ME, onPage: () => true,
            api: () => ({ query: { elections: { members: async () => [], candidates: async () => { w.reads++; return { toJSON: () => (w.listed ? [[ME, 100e12]] : []) }; } } } }),
            pages: { council: async () => { w.redraws++; return null; } }, now: () => w.clock, setTimer: () => 1, clearTimer() {}
        });
        return w;
    }
    test('the node lags: "not listed" first, listed later, and the row shows on a later re-read', async () => {
        const w = world(false);
        w.g.overlay('council', council());
        await tick();
        assert.equal(w.reads, 1, 'fixture: the first check did not run');
        assert.equal(w.g.overlay('council', council()).candidates.length, 0, 'shown while the chain did not list it');
        w.listed = true;
        w.g.overlay('council', council());
        await tick();
        assert.ok(w.reads >= 2, 'the negative answer was cached: the chain was never asked again');
        assert.equal(w.g.overlay('council', council()).candidates.length, 1, 'the row never showed');
    });
    test('a negative answer alone does not redraw the page (no loop)', async () => {
        const w = world(false);
        for (let i = 0; i < 3; i++) { w.g.overlay('council', council()); await tick(); }
        assert.equal(w.redraws, 0);
    });
    test('a positive answer is cached: the chain is not asked again', async () => {
        const w = world(true);
        w.g.overlay('council', council());
        await tick();
        for (let i = 0; i < 3; i++) { w.g.overlay('council', council()); await tick(); }
        assert.equal(w.reads, 1);
    });
    test('bounded by the poll deadline: past it a negative entry is no longer re-asked', async () => {
        const w = world(false);
        w.g.overlay('council', council());
        await tick();
        const before = w.reads;
        w.clock = 1000 + pollDeadlineMs(G.ELECTIONS, null) + 1;
        w.g.overlay('council', council());
        await tick();
        assert.equal(w.reads, before, 'asked again after the deadline');
    });
});
