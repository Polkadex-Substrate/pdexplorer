// The Actions panel on the governance item pages (lib/gov-actions.js, wired in
// lib/gov-detail-view.js and script.js): which actions are available for each
// item type and state, the double-submit guard, the in-flight status, escaping,
// and that the panel runs the list pages' own signing functions rather than a
// second signing path.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { govActionModel, renderGovActions, govItemKey, decodeAccountBalance, fanStage } from '../lib/gov-actions.js';
import { createGovDetailPage, renderGovDetailSummary } from '../lib/gov-detail-view.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { HELP_TOPICS } from '../lib/help-topics.js';

const M1 = '0x' + 'aa'.repeat(32);
const MEMBER = 'eMemberAddressForTestsOnly00000000000000000000001';
const OTHER = 'eOtherAddressForTestsOnly000000000000000000000002';
const THIRD = 'eThirdAddressForTestsOnly000000000000000000000003';
const h = { esc: escapeHtml, num: (n) => String(n), pdex: (n) => String(n), shortAddr: (a) => String(a).slice(0, 6), fmtDate: (ms) => `T${ms}` };

const ref = (over = {}) => ({ kind: 'referendum', id: '2', index: 2, title: 'Referendum #2', status: 'Ongoing', endBlock: 1200, threshold: 'SimpleMajority',
    tally: { ayes: 0, nays: 0, turnout: 0, known: true }, electorate: 1000, currentBlock: 1000, timeline: [], thread: null, sources: { chain: true }, ...over });
const prop = (over = {}) => ({ kind: 'proposal', id: '5', index: 5, title: 'Public Proposal #5', status: 'Queued', seconds: 1, deposit: 100,
    proposer: null, timeline: [], thread: null, sources: { chain: true }, ...over });
const ext = (over = {}) => ({ kind: 'external', id: M1, proposalHash: M1, title: 'External', status: 'Queued', timeline: [], thread: null, sources: { chain: true }, ...over });
const motion = (over = {}) => ({ kind: 'motion', collective: 'council', id: M1, hash: M1, index: 8, title: 'Council Motion #8', status: 'proposed',
    threshold: 2, seats: 3, ayes: 0, nays: 0, ayeVoters: [], nayVoters: [], endBlock: 1300, currentBlock: 1000,
    members: [{ address: MEMBER, name: null, vote: null }, { address: OTHER, name: null, vote: null }, { address: THIRD, name: null, vote: null }],
    related: [], timeline: [], thread: null, sources: { chain: true }, ...over });
const btn = (m, act) => m.buttons.find(b => b.act === act);
const enabled = (m) => m.buttons.filter(b => b.enabled).map(b => b.act);

describe('availability matrix', () => {
    test('referendum: signed in, ongoing, with balance: Aye and Nay', () => {
        const m = govActionModel(ref(), { account: MEMBER, balance: { free: 50, transferable: 50 } });
        assert.deepEqual(enabled(m), ['aye', 'nay']);
        assert.equal(m.reason, '');
        assert.match(m.note, /lock periods/);
        assert.match(m.note, /Free balance: 50 PDEX/);
    });
    test('referendum: not signed in, finished, no free balance: disabled with the reason', () => {
        const none = govActionModel(ref(), {});
        assert.deepEqual(enabled(none), []);
        assert.equal(none.reason, 'Connect a wallet to take part.');
        assert.equal(none.connect, true);
        const done = govActionModel(ref({ status: 'Passed' }), { account: MEMBER });
        assert.deepEqual(enabled(done), []);
        assert.equal(done.reason, 'Voting has closed: this referendum is passed.');
        assert.equal(done.connect, false);
        const broke = govActionModel(ref(), { account: MEMBER, balance: { free: 0, transferable: 0 } });
        assert.deepEqual(enabled(broke), []);
        assert.match(broke.reason, /no free PDEX/);
        assert.equal(btn(broke, 'aye').reason, broke.reason, 'the button carries the reason as its title');
    });
    test('referendum: balance not loaded yet does not block (the chain still checks)', () => {
        assert.deepEqual(enabled(govActionModel(ref(), { account: MEMBER, balance: null })), ['aye', 'nay']);
    });
    test('referendum: the current vote is shown and a new vote replaces it', () => {
        const m = govActionModel(ref(), { account: MEMBER, myVote: { aye: false, balance: 12, conviction: 'Locked2x' } });
        assert.equal(m.mine, 'Your current vote: Nay, 12 PDEX at Locked2x.');
        assert.match(m.note, /replaces your current vote/);
        assert.match(govActionModel(ref(), { account: MEMBER, myVote: { split: true, ayeBalance: 1, nayBalance: 2 } }).mine, /split, 1 aye \/ 2 nay/);
    });
    test('public proposal: Second with the deposit; off when not queued, not signed in or short of the deposit', () => {
        const m = govActionModel(prop(), { account: MEMBER, balance: { free: 500, transferable: 500 } });
        assert.deepEqual(enabled(m), ['second']);
        assert.equal(btn(m, 'second').label, 'Second (deposit 100 PDEX)');
        const live = govActionModel(prop(), { account: MEMBER, deposit: 120 });
        assert.equal(btn(live, 'second').label, 'Second (deposit 120 PDEX)', 'the live deposit wins');
        assert.equal(govActionModel(prop(), {}).reason, 'Connect a wallet to take part.');
        assert.equal(govActionModel(prop({ status: 'Tabled' }), { account: MEMBER }).reason, 'Seconding has closed: this proposal is tabled as a referendum.');
        const short = govActionModel(prop(), { account: MEMBER, balance: { free: 500, transferable: 40 } });
        assert.deepEqual(enabled(short), []);
        assert.equal(short.reason, 'Seconding reserves 100 PDEX; this account has 40 PDEX available.');
    });
    test('external proposal: no user action, Council and Technical Committee only', () => {
        for (const ctx of [{}, { account: MEMBER }]) {
            const m = govActionModel(ext(), ctx);
            assert.deepEqual(m.buttons, []);
            assert.match(m.note, /^Council and Technical Committee only\./);
        }
        assert.ok(!/data-gd-act/.test(renderGovActions(govActionModel(ext(), {}), h)), 'no fast-track button: the explorer has no such action');
    });
    test('council motion: members vote; non-members and signed-out visitors are told why', () => {
        const members = [MEMBER, OTHER, THIRD];
        const m = govActionModel(motion(), { account: MEMBER, members });
        assert.deepEqual(enabled(m), ['aye', 'nay'], 'close waits for a decision');
        assert.equal(btn(m, 'close').reason, 'Available once the vote is decided or has ended.');
        const out = govActionModel(motion(), { account: 'eSomeoneElse', members });
        assert.deepEqual(enabled(out), []);
        assert.equal(out.reason, 'Only members of the Council can vote on or close its motions. Your connected account does not hold a seat.');
        const tc = govActionModel(motion({ collective: 'technicalCommittee' }), { account: 'eSomeoneElse', members });
        assert.match(tc.reason, /members of the Technical Committee/);
        assert.equal(govActionModel(motion(), { members }).reason, 'Connect a wallet to take part.');
        assert.equal(govActionModel(motion(), { account: MEMBER, members: null }).reason, 'Checking membership...');
        assert.deepEqual(enabled(govActionModel(motion({ status: 'executed' }), { account: MEMBER, members })), []);
    });
    test('council motion: the member\'s vote disables that side; Close once decided or ended', () => {
        const members = [MEMBER, OTHER, THIRD];
        const voted = govActionModel(motion({ ayes: 1, ayeVoters: [{ address: MEMBER }] }), { account: MEMBER, members });
        assert.equal(btn(voted, 'aye').label, 'Voted Aye');
        assert.deepEqual(enabled(voted), ['nay']);
        assert.match(voted.mine, /Your current vote: Aye/);
        const decided = govActionModel(motion({ ayes: 2, ayeVoters: [{ address: OTHER }, { address: THIRD }] }), { account: MEMBER, members });
        assert.ok(btn(decided, 'close').enabled);
        assert.match(decided.note, /any member can close/);
        const ended = govActionModel(motion({ currentBlock: 1300 }), { account: MEMBER, members });
        assert.ok(btn(ended, 'close').enabled, 'voting period over');
        const sameKey = govActionModel(motion({ ayes: 1, ayeVoters: [{ address: 'eMEMBER' }] }), { account: 'emember', members: ['eMEMBER'], same: (a, b) => a.toLowerCase() === b.toLowerCase() });
        assert.equal(btn(sameKey, 'aye').label, 'Voted Aye', 'addresses compared with the injected same()');
    });
});

describe('in flight: double-submit guard and status', () => {
    test('a pending transaction disables every button; the pressed one shows its stage', () => {
        const m = govActionModel(ref(), { account: MEMBER, pending: { kind: 'aye', stage: 'inBlock' } });
        assert.deepEqual(enabled(m), []);
        assert.equal(btn(m, 'aye').label, 'In block');
        assert.equal(btn(m, 'aye').pressed, true);
        assert.equal(btn(m, 'nay').label, 'Vote Nay');
        assert.equal(m.chip, 'Your Aye is being recorded');
        assert.equal(govActionModel(prop(), { account: MEMBER, pending: { kind: 'second', stage: 'signing' } }).chip, 'Your second is being recorded');
        assert.equal(govActionModel(motion(), { account: MEMBER, members: [MEMBER], pending: { kind: 'close', stage: 'broadcast' } }).chip, 'Closing this motion');
    });
    test('clicked but no stage yet: still disabled', () => {
        const m = govActionModel(prop(), { account: MEMBER, clicking: true });
        assert.deepEqual(enabled(m), []);
        assert.equal(m.chip, 'Waiting for your confirmation');
    });
    test('a failure re-enables the buttons and shows the reason', () => {
        const m = govActionModel(ref(), { account: MEMBER, pending: { kind: 'aye', stage: 'failed', error: 'Insufficient balance to vote with.' } });
        assert.deepEqual(enabled(m), ['aye', 'nay']);
        assert.equal(m.error, 'Insufficient balance to vote with.');
        assert.match(renderGovActions(m, h), /<div class="motion-tx-error" role="alert">Insufficient balance to vote with\.<\/div>/);
    });
});

describe('rendering and escaping', () => {
    test('buttons, reason, connect prompt', () => {
        const html = renderGovActions(govActionModel(ref(), {}), { ...h, connectPrompt: () => '<a href="/wallet?returnTo=%2Fx">Connect a wallet</a>' });
        assert.match(html, /<h2 id="gd-actions-h" class="gd-h">Actions/);
        assert.match(html, /data-gd-act="aye" disabled title="Connect a wallet to take part\."/);
        assert.match(html, /href="\/wallet\?returnTo=%2Fx"/);
    });
    test('every text is escaped', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const html = renderGovActions(govActionModel(ref({ status: evil }), { account: MEMBER, myVote: { aye: true, balance: 1, conviction: evil } }), h);
        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img'));
        const err = renderGovActions(govActionModel(ref(), { account: MEMBER, pending: { kind: 'aye', stage: 'failed', error: evil } }), h);
        assert.ok(!err.includes('<img') && err.includes('&lt;img'));
        const pdexEvil = renderGovActions(govActionModel(prop(), { account: MEMBER, pdex: () => evil }), h);
        assert.ok(!pdexEvil.includes('<img'));
    });
    test('the panel sits under the vote chart of the item page', () => {
        const html = renderGovDetailSummary(ref(), h, { actions: { account: MEMBER } });
        assert.ok(html.indexOf('gd-votes-h') < html.indexOf('gd-actions-h'), 'after the votes');
        assert.ok(html.indexOf('gd-actions-h') < html.indexOf('Lifecycle') || !html.includes('Lifecycle'));
    });
});

describe('helpers', () => {
    test('govItemKey matches the list pages\' keys', () => {
        assert.equal(govItemKey(ref()), 'ref:2');
        assert.equal(govItemKey(prop()), 'prop:5');
        assert.equal(govItemKey(motion()), 'council:' + M1);
        assert.equal(govItemKey(motion({ collective: 'technicalCommittee' })), 'technicalCommittee:' + M1);
        assert.equal(govItemKey(ext()), null);
        assert.equal(govItemKey(ref({ index: null })), null, 'no index, no key (never ref:0)');
        assert.equal(govItemKey(ref({ index: '' })), null);
    });
    test('decodeAccountBalance: free, and transferable after the largest freeze', () => {
        assert.deepEqual(decodeAccountBalance({ data: { free: '5000000000000', frozen: '2000000000000' } }), { free: 5, transferable: 3 });
        assert.deepEqual(decodeAccountBalance({ data: { free: '5000000000000', miscFrozen: '1000000000000', feeFrozen: '4000000000000' } }), { free: 5, transferable: 1 });
        assert.deepEqual(decodeAccountBalance({ data: { free: '1000000000000', frozen: '9000000000000' } }), { free: 1, transferable: 0 });
        assert.equal(decodeAccountBalance(null), null);
    });
    test('fanStage calls every callback even when one throws, then reports it', () => {
        const seen = [];
        const f = fanStage((s) => { seen.push('a' + s); throw new Error('boom'); }, null, (s) => seen.push('b' + s));
        assert.throws(() => f('inBlock', {}), /boom/);
        assert.deepEqual(seen, ['ainBlock', 'binBlock']);
    });
});

// ---- the page controller -------------------------------------------------------

function nativeLike(impl) {
    return function (...args) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        return impl(...args);
    };
}
// A summary element whose [data-gd-act] buttons can be clicked.
function fakeEl() {
    const kids = {};
    const e = {
        _html: '', buttons: [],
        get innerHTML() { return this._html; },
        set innerHTML(v) {
            this._html = v;
            for (const k of Object.keys(kids)) delete kids[k];
            this.buttons = Array.from(String(v).matchAll(/<button[^>]*data-gd-act="([a-z]+)"([^>]*)>/g)).map(m => {
                const b = { act: m[1], disabled: /\sdisabled[\s>]|\sdisabled$/.test(m[2] + '>'), listeners: [] };
                b.getAttribute = (k) => (k === 'data-gd-act' ? b.act : null);
                b.addEventListener = (t, fn) => { if (t === 'click') b.listeners.push(fn); };
                b.click = () => { if (!b.disabled) b.listeners.forEach(fn => fn()); };
                return b;
            });
        },
        querySelector(sel) {
            if (!this._html.includes(sel === '#discussion' ? 'id="discussion"' : sel.replace(/^\[|\]$/g, ''))) return null;
            return kids[sel] || (kids[sel] = fakeEl());
        },
        querySelectorAll(sel) { return sel === '[data-gd-act]' ? this.buttons : []; }
    };
    return e;
}
function world({ body, api = null, account = MEMBER, actions } = {}) {
    const root = fakeEl();
    const calls = { fetch: [], actions: [] };
    let current = body;
    let who = account;
    const fetchFn = nativeLike(async (url) => { calls.fetch.push(url); return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(current)) }; });
    const log = (name) => (...args) => { calls.actions.push([name, ...args]); return actions && actions[name] ? actions[name](...args) : undefined; };
    const page = createGovDetailPage({
        root: () => root, h, fetchFn, visible: () => true,
        timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} },
        setSeo: () => {}, getApi: () => api, toAddress: (a) => a, account: () => who, same: (a, b) => a === b,
        location: () => ({ search: '', hash: '', origin: 'https://explorer.example' }), env: {},
        actions: { vote: log('vote'), second: log('second'), motionVote: log('motionVote'), motionClose: log('motionClose') }
    });
    const summary = () => root.querySelector('[data-gd-summary]');
    const button = (act) => summary().buttons.find(b => b.act === act);
    return { page, root, calls, summary, button, setBody: (b) => { current = b; }, setAccount: (a) => { who = a; } };
}
const flush = () => new Promise(r => setImmediate(r));

describe('the item page runs the list pages\' actions', () => {
    test('referendum: Vote Aye opens the democracy vote form for this referendum', async () => {
        const w = world({ body: ref() });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        w.button('aye').click();
        assert.deepEqual(w.calls.actions, [['vote', 2, 'aye']]);
    });
    test('signed out: the buttons are disabled and a click does nothing', async () => {
        const w = world({ body: ref(), account: null });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        assert.equal(w.button('aye').disabled, true);
        assert.equal(w.page.act('aye'), false);
        assert.deepEqual(w.calls.actions, []);
    });
    test('second: one call per click; a second click while it runs is refused', async () => {
        let release;
        const w = world({ body: prop(), actions: { second: () => new Promise(r => { release = r; }) } });
        w.page.open('democracy/proposal/5');
        await flush(); await flush();
        w.button('second').click();
        assert.deepEqual(w.calls.actions, [['second', 5, 1]]);
        assert.equal(w.button('second').disabled, true, 'disabled at once, before the wallet answers');
        assert.equal(w.page.act('second'), false, 'double-submit guard');
        assert.equal(w.calls.actions.length, 1);
        release();
        await flush();
        assert.equal(w.button('second').disabled, false, 'cancelled in the wallet: usable again');
    });
    test('motion: Aye goes to councilMotionVote with the hash, index and collective', async () => {
        const w = world({ body: motion({ collective: 'technicalCommittee' }) });
        w.page.open('council/tc-motion/8');
        await flush(); await flush();
        w.button('aye').click();
        assert.deepEqual(w.calls.actions[0], ['motionVote', M1, 8, true, 'technicalCommittee']);
    });
    test('motion: Close only once closeable', async () => {
        const w = world({ body: motion({ ayes: 2, ayeVoters: [{ address: OTHER }, { address: THIRD }] }) });
        w.page.open('council/motion/8');
        await flush(); await flush();
        w.button('close').click();
        assert.deepEqual(w.calls.actions[0], ['motionClose', M1, 8, 'council']);
        const early = world({ body: motion() });
        early.page.open('council/motion/8');
        await flush(); await flush();
        assert.equal(early.page.act('close'), false);
    });
});

describe('the item page follows the transaction', () => {
    test('stages: signing disables, in block refetches fresh, the live vote settles it', async () => {
        let deliverVoting = null;
        const api = { query: { democracy: {
            referendumInfoOf() { return Promise.resolve(() => {}); },
            votingOf(who, cb) { assert.equal(who, MEMBER); deliverVoting = cb; return Promise.resolve(() => {}); }
        } } };
        const w = world({ body: ref(), api });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        const onStage = w.page.stage('ref:2', 'aye');
        onStage('signing', {});
        assert.equal(w.button('aye').disabled, true);
        assert.equal(w.button('nay').disabled, true);
        assert.match(w.summary().innerHTML, /Waiting for wallet/);
        const before = w.calls.fetch.length;
        onStage('inBlock', {});
        await flush();
        assert.match(w.calls.fetch.at(-1), /\?fresh=1$/, 'the page asks for a fresh copy');
        assert.ok(w.calls.fetch.length > before);
        assert.match(w.summary().innerHTML, /Your Aye is being recorded/);
        deliverVoting({ isDelegating: false, isDirect: true, asDirect: { votes: [[2, { isStandard: true, asStandard: { vote: { isAye: true, conviction: 'Locked1x' }, balance: '3000000000000' } }]] } });
        assert.ok(!/being recorded/.test(w.summary().innerHTML), 'settled once the chain shows the vote');
        assert.match(w.summary().innerHTML, /Your current vote: Aye, 3 PDEX at Locked1x/);
        assert.equal(w.button('nay').disabled, false);
    });
    test('a failure shows the plain-language reason; another item\'s stages are ignored', async () => {
        const w = world({ body: ref() });
        w.page.open('democracy/referendum/2');
        await flush(); await flush();
        w.page.stage('ref:3', 'aye')('signing', {});
        assert.equal(w.button('aye').disabled, false, 'not this referendum');
        w.page.stage('ref:2', 'nay')('failed', { text: 'You do not have enough free PDEX for this vote.' });
        assert.match(w.summary().innerHTML, /role="alert">You do not have enough free PDEX for this vote\./);
        assert.equal(w.button('nay').disabled, false, 'free to try again');
        w.page.stage('ref:2', 'nay')('cancelled', {});
        assert.ok(!/role="alert"/.test(w.summary().innerHTML));
    });
    test('motion: the live voting record settles a vote; membership and balance are read live', async () => {
        let deliver = null, deliverMembers = null;
        const api = { query: { council: {
            proposals() {}, members(cb) { deliverMembers = cb; return Promise.resolve(() => {}); },
            voting: Object.assign((hash, cb) => { deliver = cb; return Promise.resolve(() => {}); }, { multi() {} })
        } } };
        const w = world({ body: motion(), api });
        w.page.open('council/motion/8');
        await flush(); await flush();
        assert.equal(w.button('aye').disabled, false);
        deliverMembers([OTHER, THIRD]);
        assert.equal(w.button('aye').disabled, true, 'seat lost: read live');
        assert.match(w.summary().innerHTML, /does not hold a seat/);
        deliverMembers([MEMBER, OTHER, THIRD]);
        const onStage = w.page.stage('council:' + M1, 'aye');
        onStage('inBlock', {});
        assert.match(w.summary().innerHTML, /Your Aye is being recorded/);
        deliver({ isNone: false, isSome: true, unwrap: () => ({ index: 8, threshold: 2, end: 1300, ayes: [MEMBER], nays: [] }) });
        assert.ok(!/being recorded/.test(w.summary().innerHTML));
        assert.match(w.summary().innerHTML, /Voted Aye/);
    });
    test('proposal: a short balance disables Second; a wallet change re-reads it', async () => {
        const subs = [];
        const api = { query: { democracy: { depositOf() { return Promise.resolve(() => {}); } },
            system: { account(who, cb) { subs.push(who); cb({ data: { free: who === MEMBER ? '10000000000000' : '900000000000000', frozen: '0' } }); return Promise.resolve(() => {}); } } } };
        const w = world({ body: prop(), api });
        w.page.open('democracy/proposal/5');
        await flush(); await flush();
        assert.equal(w.button('second').disabled, true);
        assert.match(w.summary().innerHTML, /Seconding reserves 100 PDEX; this account has 10 PDEX available\./);
        w.setAccount(OTHER);
        w.page.accountChanged();
        assert.deepEqual(subs, [MEMBER, OTHER]);
        assert.equal(w.button('second').disabled, false);
    });
});

// ---- script.js: the same functions, not a second signing path ------------------------

describe('script.js wiring', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    const govInit = /const govDetailPage = createGovDetailPage\(\{[\s\S]*?\}\);\n/.exec(script)[0];
    test('the item page\'s actions are the list pages\' functions', () => {
        assert.match(govInit, /vote: \(i, side\) => openReferendumVoteModal\(i, side\)/);
        assert.match(govInit, /second: \(i, seconds\) => secondPublicProposal\(i, seconds\)/);
        assert.match(govInit, /return councilMotionVote\(hash, i, aye, key\)/);
        assert.match(govInit, /return councilMotionClose\(hash, i, key\)/);
        assert.match(govInit, /connectPrompt: \(\) => buildWalletConnectPrompt\(\)/);
        assert.match(govInit, /same: \(a, b\) => isSameAddress\(a, b\)/);
    });
    test('and the list pages call the same ones', () => {
        assert.match(script, /if \(refIndex != null\) openReferendumVoteModal\(refIndex, side\);/);
        assert.match(script, /democracy-second-btn[\s\S]{0,300}secondPublicProposal\(Number\(b\.getAttribute\('data-prop-index'\)\)/);
        const wire = bodyOf(script, 'wireMotionActionButtons');
        assert.match(wire, /councilMotionVote\(/);
        assert.match(wire, /councilMotionClose\(/);
    });
    test('each of those signs through submitSignedTx and reports to both pages', () => {
        for (const [fn, re] of [
            ['submitReferendumVote', /onStage: fanStage\(democracyView\.stage\('ref:' \+ refIndex[^)]*\), govDetailPage\.stage\('ref:' \+ refIndex/],
            ['secondPublicProposal', /onStage: fanStage\(democracyView\.stage\('prop:' \+ idx, 'second'\), govDetailPage\.stage\('prop:' \+ idx, 'second'\)\)/],
            ['councilMotionVote', /onStage: fanStage\(motionStage\(view, hash, [^)]*\), govDetailPage\.stage\(view\.key \+ ':' \+ hash/],
            ['councilMotionClose', /onStage: fanStage\(motionStage\(view, hash, 'close'\), govDetailPage\.stage\(view\.key \+ ':' \+ hash, 'close'\)\)/]
        ]) {
            const body = bodyOf(script, fn);
            assert.match(body, /submitSignedTx\(\{/, `${fn} signs through submitSignedTx`);
            assert.match(body, re, `${fn} reports its stages to the item page`);
            assert.ok(!/signAndSend|web3FromAddress|\.signer\b/.test(body), `${fn} has no signing of its own`);
        }
        assert.match(bodyOf(script, 'councilMotionVote'), /return submitSignedTx\(/, 'the page knows when it is over');
        assert.match(bodyOf(script, 'councilMotionClose'), /return submitSignedTx\(/);
        assert.match(bodyOf(script, 'secondPublicProposal'), /return submitSignedTx\(/);
        assert.match(bodyOf(script, 'secondPublicProposal'), /if \(!\/\^\\d\+\$\/\.test\(String\(idx\)\)\) return showTxNotice/, 'index digit-checked (F-118)');
    });
    test('the panel modules have no signing path at all', () => {
        for (const f of ['lib/gov-actions.js', 'lib/gov-detail-view.js']) {
            const src = stripComments(readRepo(f, import.meta.url));
            assert.ok(!/signAndSend|submitSignedTx|signer|web3Enable|injectedWeb3|\.tx\[|api\.tx/.test(src), `${f} must not sign`);
        }
    });
    test('a wallet change reaches the item page', () => {
        assert.match(bodyOf(script, 'setStoredWallet'), /if \(getStoredWallet\(\) !== before\) govDetailPage\.accountChanged\(\);/);
    });
    test('script.js stays under its ceiling', () => {
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length < 15000);
    });
});

describe('help', () => {
    test('the item pages article covers the Actions panel', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'governance-item-pages');
        assert.match(t.body, /<h3>Voting from the page<\/h3>/);
        assert.match(t.body, /Council and the Technical Committee/);
        assert.match(t.keywords, /\bactions\b/);
        assert.ok(!/[\u2013\u2014]/.test(t.body), 'no en or em dashes');
    });
});
