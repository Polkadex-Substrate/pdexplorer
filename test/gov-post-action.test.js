// R4, the page side (lib/gov-post-action.js): what the council, democracy and treasury pages show after an
// action, by the UX spec (cto-team/plans/2026-11-22-post-action-refresh-ux.md, sections 1 to 5 and 9).
//   - electionsOverlay: the proven council role on top of the server's /api/council (SET pattern): a candidacy
//     adds the account to the candidates only once the chain predicate agrees (elections.candidates holds it);
//     a withdrawal removes it from the list it left (a candidate or a runner-up; a member's seat may pass to a
//     runner-up, which the events do not say, so the lists wait for the server and only the role changes).
//   - readCandidacy: that predicate, read from the browser's node.
//   - the indicator: S1 "Updating" after T1 for at least T2; S11 with "Reload this section" when the poll gives
//     up, S13 while reloading, S16 when it still cannot; one accent per card (U14).
// Addresses are the public substrate dev accounts (test/helpers/payout-events.js). DOM nodes are compared with
// assert.ok(a === b): a failing assert.equal on a happy-dom node prints the whole document and can exhaust memory.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { electionsOverlay, mergeCouncilFreshness, readCandidacy, createRefreshIndicator, ELECTIONS, GOV_PAGES } from '../lib/gov-post-action.js';
import { caughtUp } from '../lib/freshness.js';
import { STRINGS, REFRESH_UI } from '../lib/refresh-ui.js';
import { ME, OTHER, V1, V2 } from './helpers/payout-events.js';

const same = (a, b) => a === b;
const council = (o = {}) => ({ members: [{ address: V1, name: 'M1', stake: 10 }], runnersUp: [{ address: V2, name: 'R1', stake: 5 }], candidates: [], desiredMembers: 3, ...o });
const entry = (value, o = {}) => ({ id: o.id || 'k1', account: ME, domain: ELECTIONS, op: 'set', key: 'role', value, block: 42, txHash: '0x42', savedAt: o.savedAt || 1 });
const has = (rows, a) => (rows || []).some(r => r.address === a);

describe('electionsOverlay: the proven role on the server copy', () => {
    test('a candidacy shows once the predicate agrees: the account joins the candidates with its deposit', () => {
        const e = entry({ role: 'Candidate' });
        const before = council();
        assert.equal(electionsOverlay(before, ME, [e], { same, verified: new Map() }), before, 'shown before the chain predicate was read');
        assert.equal(electionsOverlay(before, ME, [e], { same, verified: new Map([['k1', { ok: false }]]) }), before, 'shown although the chain does not list it');
        const out = electionsOverlay(before, ME, [e], { same, verified: new Map([['k1', { ok: true, stake: 100 }]]) });
        assert.equal(out.candidates.length, 1);
        assert.deepEqual({ address: out.candidates[0].address, stake: out.candidates[0].stake }, { address: ME, stake: 100 });
        assert.deepEqual(before.candidates, [], 'the server copy was changed in place');
        const listed = council({ candidates: [{ address: ME, name: 'Me', stake: 100 }] });
        assert.equal(electionsOverlay(listed, ME, [e], { same, verified: new Map([['k1', { ok: true, stake: 100 }]]) }).candidates.length, 1, 'listed twice');
    });
    test('a withdrawal: a candidate or a runner-up leaves its list at once; a member only loses the role', () => {
        const asCand = electionsOverlay(council({ candidates: [{ address: ME, stake: 1 }] }), ME, [entry({ role: null, from: 'Candidate' })], { same });
        assert.equal(has(asCand.candidates, ME), false);
        assert.equal(asCand.__myRole, null);
        const asRunner = electionsOverlay(council({ runnersUp: [{ address: V2, stake: 5 }, { address: ME, stake: 3 }] }), ME, [entry({ role: null, from: 'RunnerUp' })], { same });
        assert.deepEqual(asRunner.runnersUp.map(r => r.address), [V2]);
        const seats = council({ members: [{ address: V1 }, { address: ME }] });
        const asMember = electionsOverlay(seats, ME, [entry({ role: null, from: 'Member' })], { same });
        assert.deepEqual(asMember.members, seats.members, 'a seat that may have passed to a runner-up is not guessed');
        assert.deepEqual(asMember.runnersUp, seats.runnersUp);
        assert.equal(asMember.__myRole, null, 'the role did not change at once');
    });
    test('the newest entry wins; entries of another account and other ops are ignored', () => {
        const old = entry({ role: 'Candidate' }, { id: 'a', savedAt: 1 });
        const newer = entry({ role: null, from: 'Candidate' }, { id: 'b', savedAt: 2 });
        const out = electionsOverlay(council({ candidates: [{ address: ME }] }), ME, [newer, old], { same, verified: new Map([['a', { ok: true, stake: 1 }]]) });
        assert.equal(has(out.candidates, ME), false);
        const theirs = { ...entry({ role: null, from: 'Candidate' }), account: OTHER };
        const hold = { ...entry({ role: null, from: 'Candidate' }), op: 'hold' };
        const d = council({ candidates: [{ address: ME }] });
        assert.equal(electionsOverlay(d, ME, [theirs, hold], { same }), d);
    });
    test('nothing to apply, an error payload or no account: the server copy as it is', () => {
        const d = council();
        assert.equal(electionsOverlay(d, ME, [], { same }), d);
        assert.equal(electionsOverlay(d, null, [entry({ role: null, from: 'Candidate' })], { same }), d);
        const err = { error: 'x' };
        assert.equal(electionsOverlay(err, ME, [entry({ role: null, from: 'Candidate' })], { same }), err);
    });
});

describe('mergeCouncilFreshness and the page domains', () => {
    test('the council page reads two snapshots: the technical committee mark comes from its own route', () => {
        const f = mergeCouncilFreshness({ v: 1, kv: { council: 50, democracy: null } }, { v: 1, kv: { technicalCommittee: 40 } });
        assert.deepEqual(f.kv, { council: 50, democracy: null, technicalCommittee: 40 });
        assert.equal(caughtUp('technicalCommittee.motions', f, 41), false);
        assert.equal(mergeCouncilFreshness({ kv: { council: 50 } }, null).kv.technicalCommittee, null, 'an unread technical committee is unknown');
        assert.equal(mergeCouncilFreshness(null, { kv: { technicalCommittee: 1 } }), null);
    });
    test('the pages and what they draw', () => {
        assert.deepEqual(GOV_PAGES.council, ['council.motions', 'council.elections', 'technicalCommittee.motions']);
        assert.deepEqual(GOV_PAGES.democracy, ['democracy']);
        assert.deepEqual(GOV_PAGES.treasury, ['treasury.overview']);
    });
});

describe('readCandidacy: the chain predicate (elections.candidates holds the account)', () => {
    const apiWith = (rows, pallet = 'elections') => ({ query: { [pallet]: { members: async () => [], candidates: async () => ({ toJSON: () => rows }) } } });
    test('listed: ok with the deposit in PDEX (12 decimals), hex or number', async () => {
        assert.deepEqual(await readCandidacy(apiWith([[V1, 5], [ME, '0x' + (100n * 10n ** 12n).toString(16)]]), ME, same), { ok: true, stake: 100 });
        assert.deepEqual(await readCandidacy(apiWith([[ME, 2_000_000_000_000]], 'phragmenElection'), ME, same), { ok: true, stake: 2 });
    });
    test('not listed, no elections pallet: not ok', async () => {
        assert.deepEqual(await readCandidacy(apiWith([[V1, 5]]), ME, same), { ok: false });
        assert.deepEqual(await readCandidacy({ query: {} }, ME, same), { ok: false });
    });
    test('a read that fails is not an answer: it throws, so nothing is remembered', async () => {
        const api = { query: { elections: { members: async () => [], candidates: async () => { throw new Error('node gone'); } } } };
        await assert.rejects(() => readCandidacy(api, ME, same));
    });
});

describe('the indicator (UX sections 1, 2, 5)', () => {
    let win, doc, timers, clock, said;
    const page = () => {
        doc.body.innerHTML = '<div id="treasury-content"><div class="list-container glass"><div class="list-header"><h2>Treasury</h2></div><div class="account-tabs"></div><div id="body">rows</div></div></div>';
    };
    const run = async (ms) => {
        const until = clock.now + ms;
        for (;;) {
            const due = timers.filter(t => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            clock.now = due.at; due.live = false; due.f();
            await new Promise(r => setImmediate(r));
        }
        clock.now = until;
        for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    };
    const ind = (o = {}) => createRefreshIndicator({ doc, page: 'treasury', name: 'Treasury', hosts: { header: '#treasury-content .list-header h2', card: '#treasury-content .list-container' },
        account: () => o.account ? o.account() : ME, same, check: caughtUp, reload: o.reload || (async () => null), now: () => clock.now,
        setTimer: (f, ms) => { const t = { f, at: clock.now + ms, live: true }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.live = false; } });
    const chip = () => doc.getElementById('gov-refresh-chip-treasury');
    const line = () => doc.getElementById('gov-refresh-line-treasury');
    const btn = () => doc.getElementById('gov-refresh-reload-treasury');
    beforeEach(() => { win = new Window(); doc = win.document; timers = []; clock = { now: 1_000_000 }; page(); said = () => (doc.getElementById('post-action-live') || {}).textContent || ''; });

    test('T1: a read that catches up within 600 ms shows nothing', async () => {
        const i = ind();
        i.set('updating', { block: 42, domains: ['treasury.overview'] });
        await run(REFRESH_UI.showDelayMs - 1);
        assert.ok(!chip());
        i.set('current', { block: 42 });
        await run(5000);
        assert.ok(!chip());
        assert.equal(doc.querySelector('#treasury-content h2').textContent, 'Treasury');
    });
    test('T1 then T2: "Updating" in the card header after 600 ms, kept at least 900 ms once shown; the body untouched', async () => {
        const i = ind();
        const body = doc.getElementById('body');
        i.set('updating', { block: 42, domains: ['treasury.overview'] });
        await run(REFRESH_UI.showDelayMs);
        assert.ok(chip(), 'no chip after T1');
        assert.ok(doc.querySelector('#treasury-content .list-header h2').contains(chip()), 'the chip is not in the card header');
        assert.equal(chip().textContent.trim(), STRINGS.S1);
        assert.ok(chip().classList.contains('ui-chip') && chip().classList.contains('is-wait'));
        assert.ok(chip().querySelector('.bx-loader-alt.bx-spin'));
        await run(100);
        i.set('current', { block: 42 });
        await run(REFRESH_UI.minVisibleMs - 101);
        assert.ok(chip(), 'the chip left before T2');
        await run(2);
        assert.ok(!chip(), 'the chip stayed after T2');
        assert.ok(doc.getElementById('body') === body, 'the card body was redrawn');
        assert.equal(said(), '', 'an indicator under 5 s announced "up to date"');
    });
    test('A3 only after an indicator was visible 5 s or more', async () => {
        const i = ind();
        i.set('updating', { block: 42, domains: ['treasury.overview'] });
        await run(REFRESH_UI.showDelayMs + REFRESH_UI.quietAnnounceMs);
        i.set('current', { block: 42 });
        assert.equal(said(), 'Treasury is up to date.');
    });
    test('could-not-refresh: one amber line with Reload this section as the first child of the card body; no chip', async () => {
        const i = ind();
        i.set('updating', { block: 42, domains: ['treasury.overview'] });
        await run(REFRESH_UI.showDelayMs);
        i.set('could-not-refresh', { block: 42, domains: ['treasury.overview'], gaveUp: ['treasury.overview'] });
        assert.ok(!chip(), 'two accents on one card');
        assert.ok(line(), 'no line');
        assert.ok(line().classList.contains('ui-panel') && line().classList.contains('is-warn') && line().classList.contains('is-line'));
        assert.equal(line().previousElementSibling.className, 'list-header', 'not the first child of the card body');
        assert.ok(line().textContent.includes(STRINGS.S11));
        assert.equal(btn().textContent.trim(), STRINGS.S12);
        assert.ok(btn().classList.contains('validate-secondary'));
        assert.equal(said(), 'Treasury could not be refreshed. Use Reload this section.');
        assert.equal(doc.getElementById('body').textContent, 'rows', 'the content went away');
    });
    test('Reload this section: S13 while busy (at least 400 ms); a read that is still behind says S16 with the time', async () => {
        let resolve;
        const i = ind({ reload: () => new Promise(r => { resolve = r; }) });
        i.set('could-not-refresh', { block: 42, domains: ['treasury.overview'], gaveUp: ['treasury.overview'] });
        btn().focus();
        btn().click();
        await run(0);
        assert.ok(btn().textContent.includes(STRINGS.S13));
        assert.equal(btn().getAttribute('aria-disabled'), 'true');
        resolve({ kv: { treasury: 41 } });
        await run(399);
        assert.ok(btn().textContent.includes(STRINGS.S13), 'the busy state was shorter than 400 ms');
        await run(1);
        assert.ok(line(), 'the line left although the server is still behind');
        const d = new Date(clock.now);
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        assert.ok(line().textContent.includes(`Still could not refresh. Last tried at ${hhmm}.`), line().textContent);
        assert.equal(btn().textContent.trim(), STRINGS.S12);
        assert.equal(btn().getAttribute('aria-disabled'), null);
        assert.ok(doc.activeElement === btn(), 'focus left the button');
    });
    test('Reload this section that catches up: the line leaves, focus goes to the card heading, A5', async () => {
        const i = ind({ reload: async () => ({ kv: { treasury: 42 } }) });
        i.set('could-not-refresh', { block: 42, domains: ['treasury.overview'], gaveUp: ['treasury.overview'] });
        btn().click();
        await run(400);
        assert.ok(!line());
        const h = doc.querySelector('#treasury-content .list-header h2');
        assert.equal(h.getAttribute('tabindex'), '-1');
        assert.ok(doc.activeElement === h, 'focus is not on the card heading');
        assert.ok(said().includes('Treasury is up to date.'));
    });
    test('a reorg line (S17) wins over the other accents; it leaves when the block is back', async () => {
        const i = ind();
        i.set('updating', { block: 42, domains: ['treasury.overview'] });
        await run(REFRESH_UI.showDelayMs);
        i.reorg('vote');
        assert.ok(!chip());
        assert.ok(line().textContent.includes('The block with your vote was replaced by the network.'));
        assert.equal(said(), 'The vote is not confirmed any more. The items are listed again while it is sent again.');
        i.reorg(null);
        assert.ok(!line());
    });
    test('a repaint after the header was redrawn puts the chip back; another account on screen clears it (U13)', async () => {
        let who = ME;
        const i = ind({ account: () => who });
        i.set('updating', { block: 42, domains: ['treasury.overview'] });
        await run(REFRESH_UI.showDelayMs);
        page();
        i.paint();
        assert.ok(chip(), 'the chip did not come back after a full render');
        who = OTHER;
        i.paint();
        assert.ok(!chip(), 'an indicator of the old account stayed');
        who = ME;
        i.paint();
        assert.ok(!chip(), 'the old account\'s wait came back');
    });
});
