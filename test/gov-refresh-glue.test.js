// R4 end to end through the script.js glue (design sections 3, 4, 5, 9 "R4"; UX sections 2, 5, 9): the real
// council, treasury and democracy page functions are lifted from script.js together with the lines that create
// the known-results store, the post-action core and the governance refresh, and run in a vm context over a
// happy-dom page built from index.html, with the real tracker (lib/tx-submit.js), the real effects table and
// the real modules. Only the chain, the wallet and the server are fakes; nothing is broadcast anywhere.
//
// What is proved, per action: what updates at once (from the transaction's own events or the chain predicate),
// what follows once the server's snapshot (freshness.kv, its `atBlock`) reaches the inclusion block, that
// nothing changes on a failed or dropped transaction or off the page, that the fixed 6 s refresh timers are
// gone, that the Treasury tab the user is on is kept, a reorg withdrawal and a wallet switch mid-wait.
// Addresses are the public substrate dev accounts (test/helpers/payout-events.js).

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { readRepo, bodyOf, stripComments } from './helpers/source.js';
import { trackSignedTx, WALLET_CHANGED_STALE } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs, samePayload } from '../lib/freshness.js';
import { createGovRefresh } from '../lib/gov-post-action.js';
import { createCouncilCandidacyUI } from '../lib/council-candidacy-view.js';
import { freshPlan } from '../lib/collective-live.js';
import { escapeHtml } from '../lib/html-escape.js';
import { STRINGS, REFRESH_UI } from '../lib/refresh-ui.js';
import { ME, OTHER, V1, V2, REGISTRY } from './helpers/payout-events.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const HTML = readRepo('index.html', import.meta.url);
const GENESIS = '0x' + '22'.repeat(32);
const HASH = '0x' + 'ab'.repeat(32);
const PD = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const line = (start) => { const i = SCRIPT.indexOf(start); assert.ok(i >= 0, 'not in script.js: ' + start); return SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
// A whole top-level statement (it may span lines): from `start` to its `;` at depth 0.
const stmt = (start) => {
    const i = SCRIPT.indexOf(start);
    assert.ok(i >= 0, 'not in script.js: ' + start);
    let depth = 0;
    for (let j = i; j < SCRIPT.length; j++) {
        const c = SCRIPT[j];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth === 0) return SCRIPT.slice(i, j + 1);
    }
    throw new Error('unterminated: ' + start);
};
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const success = () => ev('system', 'ExtrinsicSuccess');
const fee = () => ev('transactionPayment', 'TransactionFeePaid', [ME, '1000', '0']);
const failedExtrinsic = () => ev('system', 'ExtrinsicFailed', [{ isModule: true, asModule: { index: 9, error: 14 } }]);
const chainList = (rows) => Object.assign(rows.slice(), { toJSON: () => rows.map(r => r.slice()) });

// The page and the world: the council page and its modals from index.html, the treasury and democracy roots.
function govPage({ route = 'council', wallet = ME, member = true } = {}) {
    const win = new Window({ url: 'https://explorer.test/' + route, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    // A browser coerces `el.innerText = 3` to "3"; happy-dom needs a string (fetchCouncilData sets counts).
    for (let pr = win.HTMLElement.prototype; pr; pr = Object.getPrototypeOf(pr)) {
        const d = Object.getOwnPropertyDescriptor(pr, 'innerText');
        if (d && d.set) { Object.defineProperty(win.HTMLElement.prototype, 'innerText', { ...d, set(v) { d.set.call(this, String(v)); } }); break; }
    }
    const a = HTML.indexOf('<div class="council-page');
    doc.body.innerHTML = HTML.slice(a, HTML.indexOf('<div id="council-vote-modal"', a)) + '<div id="treasury-content"></div><div id="democracy-content"></div>';
    // member: the connected account holds a council seat (it votes and closes motions); a candidate does not.
    const srv = { council: 30, tc: 30, treasury: 30, dem: 30, members: [{ address: V1, name: 'M1', stake: 10 }, ...(member ? [{ address: ME, name: 'Me', stake: 8 }] : [])],
        runnersUp: [{ address: V2, name: 'R1', stake: 5 }], candidates: [], pot: 10, fetches: [], chainCandidates: [] };
    const world = { route, wallet, srv, timers: [], notices: [], mounts: [], built: [] };
    const body = (path) => {
        if (path === '/api/council') return { members: srv.members, runnersUp: srv.runnersUp, candidates: srv.candidates, motions: [{ hash: HASH, index: 3, method: 'spend' }],
            desiredMembers: 3, termDuration: 100, blocksRemaining: 50, pallet: 'elections', collectivePallet: 'council', freshness: { v: 1, kv: { council: srv.council } } };
        if (path === '/api/technical-committee') return { members: [{ address: ME, name: 'Me' }], motions: [{ hash: HASH, index: 3 }], proposalCount: 1, collectivePallet: 'technicalCommittee',
            freshness: { v: 1, kv: { technicalCommittee: srv.tc } } };
        if (path === '/api/treasury') return { proposals: [], approvals: [], allProposals: [], spendableFunds: srv.pot, proposalCount: 3, freshness: { v: 1, kv: { treasury: srv.treasury } } };
        if (path === '/api/democracy') return { referenda: [], publicProposals: [], referendumCount: 1, freshness: { v: 1, kv: { democracy: srv.dem } } };
        return { error: 'no route ' + path };
    };
    const fakeFetch = async (url) => { srv.fetches.push(url); const path = String(url).split('?')[0]; const b = body(path); return { ok: !b.error, status: b.error ? 404 : 200, json: async () => JSON.parse(JSON.stringify(b)) }; };
    let onStatus = null;
    const tx = { method: { toHex: () => '0x00' }, signAsync: async () => ({ send: async (cb) => { onStatus = cb; return () => {}; } }) };
    const builder = (name) => (...args) => { world.built.push([name, ...args]); return tx; };
    const api = {
        registry: REGISTRY, genesisHash: { toHex: () => GENESIS }, runtimeVersion: { specName: { toString: () => 'x' }, specVersion: { toString: () => '392' } },
        on() {}, off() {},
        rpc: { chain: { getHeader: async (h) => ({ number: { toNumber: () => (h === '0xb1' ? 42 : h === '0xb2' ? 43 : 99) } }) } },
        query: { elections: { members: async () => [], runnersUp: async () => [], candidates: async () => chainList(srv.chainCandidates) } },
        tx: { council: { vote: builder('council.vote'), close: builder('council.close') }, technicalCommittee: { vote: builder('tc.vote'), close: builder('tc.close') },
            elections: { submitCandidacy: builder('elections.submitCandidacy') } }
    };
    const noop = () => '';
    const ctx = {
        console: { log() {}, info() {}, warn() {}, error: (...a) => { if (process.env.GLUE_DEBUG) process.stderr.write(a.map(String).join(' ') + '\n'); } }, Promise, Object, JSON, Array, Map, Set, String, Number, Math, Date, Error, encodeURIComponent,
        window: win, document: doc, navigator: { clipboard: { writeText: async () => {} } },
        setTimeout: (f, ms) => { const t = { f, ms, at: Date.now() + (Number(ms) || 0), live: true }; world.timers.push(t); return t; },
        clearTimeout: (t) => { if (t) t.live = false; },
        queueMicrotask: (f) => queueMicrotask(f),
        fetch: fakeFetch, parseJsonResponse: async (r) => r.json(),
        globalApi: api, liveRuntimeError: () => null, WALLET_CHANGED_STALE,
        walletSession: { signingCheck: () => () => true }, getStoredWallet: () => world.wallet, isSameAddress: (x, y) => x === y,
        readRouteFromLocation: () => world.route,
        multisigStore: { find: () => null }, multisigUI: { review: async () => {} },
        resolveWalletSigner: async () => ({ account: { address: world.wallet }, signer: {} }),
        trackSignedTx, showTxStatus: (act, st, ev2, err, ex) => buildTxModel(act, st, ev2, err, ex), recheckSignedTxs: () => {},
        createKnownResults, createPostAction, effectsFor, caughtUp, pollDeadlineMs, samePayload, createGovRefresh, createCouncilCandidacyUI, freshPlan,
        showTxNotice: (m) => { world.notices.push(m); }, requireWallet: () => true, confirm: () => true,
        stakingEscapeHtml: escapeHtml, stakingFormatNumber: (n) => String(n), copyToClipboard() {}, buildWalletConnectPrompt: noop, helpIcon: noop,
        renderCouncilMotions() {}, renderCollectiveMotions() {}, overlayLiveMotions: (m) => m, liveMotions: () => null,
        motionStage: () => () => {}, fanStage: (...fs) => (s, m) => fs.forEach(f => f && f(s, m)), govDetailPage: { stage: () => () => {} },
        // treasury
        SPEND_RULE_TEXT: '', governanceIndexNote: noop, tryOpenFromQueryString() {},
        renderTreasuryOverview: (d) => `<div id="treasury-pot">${d.spendableFunds}</div>`, renderTreasuryProposals: noop, renderTreasuryApproved: noop, renderTreasuryHistory: noop,
        mountTreasuryProposalsTable() {}, mountTreasuryApprovedTable() {}, mountTreasuryHistoryTable() {},
        spendMotionUI: { mount() {} }, spendPayoutUI: { mount: (el) => { world.mounts.push(el); } },
        // democracy
        democracyView: { fetchRest: (fresh) => fakeFetch(fresh ? '/api/democracy?fresh=1' : '/api/democracy'), update: () => { world.demUpdates = (world.demUpdates || 0) + 1; } },
        renderDemocracy: () => { world.demRenders = (world.demRenders || 0) + 1; doc.getElementById('democracy-content').innerHTML = '<div class="list-container glass"><div class="list-header"><h2>Democracy</h2></div><div>body</div></div>'; }
    };
    vm.createContext(ctx);
    // lib/council-candidacy-view.js defaults its document to the page's global one, as in the browser.
    globalThis.document = doc;
    const src = [
        line('let councilFreshCarry = '), line('let councilPalletName = '), line('let councilData = '), line('let tcData = '),
        "let councilMotionsFilter = 'all'; let councilCallFilter = 'all';",
        stmt('const COLLECTIVE_VIEWS = {'), line('const collectiveView = '), stmt('const freshFetch = '),
        line('const candidacyModal = '), stmt('const councilCandidacyUI = createCouncilCandidacyUI('),
        line('let treasuryData = '), line('let treasuryTab = '), line('let democracyData = '),
        line('const knownResults = createKnownResults('), line('const postAction = createPostAction('), line('const govRefresh = createGovRefresh('),
        'async ' + bodyOf(SCRIPT, 'fetchCouncilData'), 'async ' + bodyOf(SCRIPT, 'fetchTechnicalCommitteeData'),
        bodyOf(SCRIPT, 'councilMotionVote'), bodyOf(SCRIPT, 'councilMotionClose'), 'async ' + bodyOf(SCRIPT, 'submitCouncilCandidacy'),
        'async ' + bodyOf(SCRIPT, 'fetchTreasuryData'), bodyOf(SCRIPT, 'renderTreasury'), 'async ' + bodyOf(SCRIPT, 'fetchDemocracyData'),
        'async ' + bodyOf(SCRIPT, 'submitSignedTx'),
        'globalThis.__glue = { knownResults, postAction, treasuryTab: () => treasuryTab, treasuryData: () => treasuryData, councilData: () => councilData };'
    ].join('\n');
    vm.runInContext(src, ctx);
    const emit = async (status, events) => { onStatus({ status, events, txHash: { toHex: () => '0x' + 'cd'.repeat(32) } }); await flush(); };
    // Page timers (the core's polls, the indicator's T1 and T2) run when the fake clock passes them.
    const advance = async (ms) => {
        const end = Date.now() + ms;
        for (;;) {
            const due = world.timers.filter(t => t.live && t.at <= end).sort((x, y) => x.at - y.at)[0];
            if (!due) break;
            if (due.at > Date.now()) mock.timers.tick(due.at - Date.now());
            due.live = false;
            due.f();
            await flush();
        }
        if (end > Date.now()) mock.timers.tick(end - Date.now());
        await flush();
    };
    const q = (s) => doc.querySelector(s);
    const send = async (action, events, { block = '0xb1' } = {}) => {
        const p = ctx.submitSignedTx({ buildTx: () => tx, label: 'test', action });
        await flush();
        await emit({ type: 'Ready' });
        if (events) await emit({ type: 'InBlock', asInBlock: block }, events);
        return p;
    };
    const freshReads = (path) => srv.fetches.filter(u => u === path + '?fresh=1').length;
    return { win, doc, ctx, world, srv, emit, advance, q, send, freshReads, glue: ctx.__glue, sent: () => onStatus !== null };
}
const chip = (p, page) => p.doc.getElementById('gov-refresh-chip-' + page);
const govLine = (p, page) => p.doc.getElementById('gov-refresh-line-' + page);
const voted = (who = ME, section = 'council') => ev(section, 'Voted', [who, HASH, true, 1, 0]);

describe('R4 council: motions follow the snapshot, not a 6 s timer (rows 10, 11)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 }); });
    afterEach(() => mock.timers.reset());

    test('10 council.vote in block: re-read at once, "Updating" after T1 while the snapshot is behind, current once it reaches the block; no 6 s timer', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        p.srv.fetches.length = 0;
        p.ctx.councilMotionVote(HASH, '3', true, 'council');
        await flush();
        assert.ok(p.sent(), 'the vote was not sent');
        await p.emit({ type: 'Ready' });
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [voted(), fee(), success()]);
        await flush();
        assert.ok(!p.world.timers.some(t => t.ms === 6000), 'the fixed 6 s refresh after a council vote is still armed');
        assert.equal(p.freshReads('/api/council'), 1, 'the council snapshot was not re-read at inclusion');
        assert.ok(!chip(p, 'council'), 'an indicator before T1');
        await p.advance(REFRESH_UI.showDelayMs);
        assert.ok(chip(p, 'council'), 'no "Updating" while the snapshot is behind the block');
        assert.equal(chip(p, 'council').textContent.trim(), STRINGS.S1);
        assert.ok(p.q('.council-page-header h2').contains(chip(p, 'council')));
        p.srv.council = 42;
        await p.advance(2000);
        assert.equal(p.freshReads('/api/council'), 2, 'the poll did not re-read after 2 s');
        await p.advance(REFRESH_UI.minVisibleMs);
        assert.ok(!chip(p, 'council'), 'still "Updating" after the snapshot reached the block');
        const n = p.srv.fetches.length;
        await p.advance(180_000);
        assert.equal(p.srv.fetches.length, n, 'the poll kept reading after it caught up');
    });
    test('11 council.close in block: the same catch-up; no 6 s timer', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        p.ctx.councilMotionClose(HASH, '3', 'council');
        await flush();
        await p.emit({ type: 'Ready' });
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [ev('council', 'Closed', [HASH, 3, 0]), ev('council', 'Approved', [HASH]), ev('council', 'Executed', [HASH, { isErr: false, isOk: true }]), fee(), success()]);
        assert.ok(!p.world.timers.some(t => t.ms === 6000), 'the fixed 6 s refresh after a close is still armed');
        assert.equal(p.freshReads('/api/council'), 1);
        p.srv.council = 42;
        await p.advance(2000);
        await p.advance(REFRESH_UI.minVisibleMs);
        assert.ok(!chip(p, 'council'));
    });
    test('a technical committee vote waits for the technical committee snapshot, not the council one', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        await p.ctx.fetchTechnicalCommitteeData();
        p.ctx.councilMotionVote(HASH, '3', true, 'technicalCommittee');
        await flush();
        await p.emit({ type: 'Ready' });
        p.srv.council = 99;
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [voted(ME, 'technicalCommittee'), fee(), success()]);
        assert.equal(p.freshReads('/api/technical-committee'), 1, 'the technical committee was not re-read');
        await p.advance(REFRESH_UI.showDelayMs);
        assert.ok(chip(p, 'council'), 'caught up on the council snapshot although the vote was in the technical committee');
        p.srv.tc = 42;
        await p.advance(2000 + REFRESH_UI.minVisibleMs);
        assert.ok(!chip(p, 'council'));
    });
    test('never on failure or a drop: a failed vote and a dropped one re-read nothing and show nothing', async () => {
        for (const end of ['failed', 'dropped']) {
            const p = govPage();
            await p.ctx.fetchCouncilData();
            p.srv.fetches.length = 0;
            p.ctx.councilMotionVote(HASH, '3', true, 'council');
            await flush();
            await p.emit({ type: 'Ready' });
            if (end === 'failed') await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [failedExtrinsic(), fee()]);
            else await p.emit({ type: 'Dropped' });
            await p.advance(30_000);
            assert.equal(p.freshReads('/api/council'), 0, end + ': re-read the snapshot');
            assert.ok(!chip(p, 'council'), end);
            assert.ok(!govLine(p, 'council'), end);
        }
    });
    test('off the page (a governance item page): the council page does not poll', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        p.srv.fetches.length = 0;
        p.world.route = 'governance-details/motion-x';
        p.ctx.councilMotionVote(HASH, '3', true, 'council');
        await flush();
        await p.emit({ type: 'Ready' });
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [voted(), fee(), success()]);
        await p.advance(60_000);
        assert.equal(p.freshReads('/api/council'), 0);
    });
    test('the poll gives up at the deadline: one amber line with Reload this section; the content stays', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        p.ctx.councilMotionVote(HASH, '3', true, 'council');
        await flush();
        await p.emit({ type: 'Ready' });
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [voted(), fee(), success()]);
        await p.advance(181_000);
        assert.ok(govLine(p, 'council'), 'no could-not-refresh line after the deadline');
        assert.ok(govLine(p, 'council').textContent.includes(STRINGS.S11));
        assert.ok(!chip(p, 'council'));
        assert.equal(p.q('#council-seats-count').textContent, '2/3', 'the content went away');
    });
});

describe('R4 council elections: the role shows at once (rows 12, 13, 14)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 }); });
    afterEach(() => mock.timers.reset());
    const candidacy = async (p, { block = '0xb1' } = {}) => {
        const run = p.ctx.submitCouncilCandidacy();
        await flush();
        await p.emit({ type: 'Ready' });
        p.srv.chainCandidates = [[ME, '0x' + (100n * PD).toString(16)]];
        await p.emit({ type: 'InBlock', asInBlock: block }, [ev('balances', 'Reserved', [ME, String(100n * PD)]), fee(), success()]);
        return run;
    };
    const listed = (p, id) => Array.from(p.doc.querySelectorAll(`#${id} [data-address]`)).map(e => e.getAttribute('data-address'));

    test('12 candidacy in block, the chain lists it: the candidate row and count at once, before the server; no duplicate when it catches up', async () => {
        const p = govPage({ member: false });
        await p.ctx.fetchCouncilData();
        assert.equal(p.q('#council-candidates-count').textContent, '0');
        await candidacy(p);
        assert.deepEqual(p.world.built.find(b => b[0] === 'elections.submitCandidacy'), ['elections.submitCandidacy', 0], 'the signed call changed');
        assert.equal(p.q('#council-candidates-count').textContent, '1', 'the candidacy is not shown at once');
        assert.deepEqual(listed(p, 'council-candidates-list'), [ME]);
        assert.ok(p.q('#council-candidates-list').textContent.includes('100'), 'the deposit read from the chain is not shown');
        p.srv.candidates = [{ address: ME, name: 'Me', stake: 100 }];
        p.srv.council = 42;
        await p.advance(2000);
        assert.equal(p.q('#council-candidates-count').textContent, '1', 'listed twice once the server caught up');
        assert.ok(p.q('#council-candidates-list').textContent.includes('Me'), 'the server row did not replace the proven one');
    });
    test('12 the chain predicate does not hold (the node does not list it): nothing is shown', async () => {
        const p = govPage({ member: false });
        await p.ctx.fetchCouncilData();
        const run = p.ctx.submitCouncilCandidacy();
        await flush();
        await p.emit({ type: 'Ready' });
        await p.emit({ type: 'InBlock', asInBlock: '0xb1' }, [fee(), success()]);
        await p.advance(4000);
        assert.equal(p.q('#council-candidates-count').textContent, '0');
        await run;
    });
    test('13 elections.vote: no figure on the page changes, so nothing is drawn; the snapshot is still followed', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        p.srv.fetches.length = 0;
        await p.send({ key: 'elections.vote', params: { n: 1, stake: '1' } }, [fee(), success()]);
        assert.equal(p.freshReads('/api/council'), 1);
        assert.equal(p.q('#council-candidates-count').textContent, '0');
    });
    test('14 withdraw as a runner-up: Renounced takes it off the runners-up at once', async () => {
        const p = govPage();
        p.srv.runnersUp = [{ address: V2, name: 'R1', stake: 5 }, { address: ME, name: 'Me', stake: 3 }];
        p.srv.members = [{ address: V1, name: 'M1', stake: 10 }];
        await p.ctx.fetchCouncilData();
        assert.equal(p.q('#council-runnersup-count').textContent, '2');
        await p.send({ key: 'elections.withdraw', params: { role: 'RunnerUp' } }, [ev('elections', 'Renounced', [ME]), fee(), success()]);
        assert.equal(p.q('#council-runnersup-count').textContent, '1', 'still listed after Renounced');
        assert.deepEqual(listed(p, 'council-runnersup-list'), [V2]);
    });
    test('14 a member leaves: the role changes at once (Leave council is gone); the seats wait for the server, with "Updating"', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        assert.equal(p.q('#council-withdraw-btn').textContent, 'Leave council');
        await p.send({ key: 'elections.withdraw', params: { role: 'Member' } }, [ev('elections', 'Renounced', [ME]), fee(), success()]);
        assert.equal(p.q('#council-withdraw-btn').textContent, 'Withdraw candidacy', 'the member role is still offered');
        assert.equal(p.q('#council-seats-count').textContent, '2/3', 'a seat that a runner-up may have taken was guessed');
        await p.advance(REFRESH_UI.showDelayMs);
        assert.ok(chip(p, 'council'), 'the seats are behind the chain without "Updating"');
    });
    test('14 without Renounced for this account: no claim', async () => {
        const p = govPage();
        await p.ctx.fetchCouncilData();
        await p.send({ key: 'elections.withdraw', params: { role: 'Member' } }, [ev('elections', 'Renounced', [OTHER]), fee(), success()]);
        assert.equal(p.q('#council-withdraw-btn').textContent, 'Leave council');
    });
    test('reorg: the replaced block withdraws the candidacy (S17); back in a block it shows again', async () => {
        const p = govPage({ member: false });
        await p.ctx.fetchCouncilData();
        await candidacy(p);
        assert.equal(p.q('#council-candidates-count').textContent, '1');
        await p.emit({ type: 'Retracted', asRetracted: '0xb1' });
        await flush();
        assert.equal(p.q('#council-candidates-count').textContent, '0', 'the candidacy stayed after its block was replaced');
        assert.ok(govLine(p, 'council'), 'no reorg line');
        assert.ok(govLine(p, 'council').textContent.includes('The block with your transaction was replaced by the network.'));
        await p.emit({ type: 'InBlock', asInBlock: '0xb2' }, [ev('balances', 'Reserved', [ME, String(100n * PD)]), fee(), success()]);
        await flush();
        assert.equal(p.q('#council-candidates-count').textContent, '1', 'not shown again after the new block');
        assert.ok(!govLine(p, 'council'), 'the reorg line stayed');
    });
    test('wallet switch mid-wait: nothing of the old account is drawn for the new one, and its wait stops', async () => {
        const p = govPage({ member: false });
        await p.ctx.fetchCouncilData();
        await candidacy(p);
        await p.advance(REFRESH_UI.showDelayMs);
        assert.ok(chip(p, 'council'));
        p.world.wallet = OTHER;
        await p.ctx.fetchCouncilData();   // the route's re-render for the new wallet
        assert.equal(p.q('#council-candidates-count').textContent, '0', 'the old account\'s candidacy is drawn for the new one');
        assert.ok(!chip(p, 'council'), 'the old account\'s "Updating" stayed');
        const n = p.freshReads('/api/council');
        await p.advance(60_000);
        assert.equal(p.freshReads('/api/council'), n, 'the old account\'s poll went on');
        p.world.wallet = ME;
        await p.ctx.fetchCouncilData();
        assert.equal(p.q('#council-candidates-count').textContent, '1', 'back on the account: its proven candidacy applies again');
    });
});

describe('R4 treasury: the overview follows a payout, the Spends tab is kept (rows 16, 17)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 }); });
    afterEach(() => mock.timers.reset());
    const spends = async (p) => {
        await p.ctx.fetchTreasuryData();
        p.q('[data-treastab="spends"]').click();
        assert.equal(p.glue.treasuryTab(), 'spends');
        assert.equal(p.world.mounts.length, 1);
    };
    test('16 a payout in block on the Spends tab: the overview is re-read until it reaches the block; the tab and the spends table stay', async () => {
        const p = govPage({ route: 'treasury' });
        await spends(p);
        p.srv.pot = 7;
        await p.send({ key: 'treasury.payout', params: { index: 7 } }, [ev('treasury', 'Paid', [7, 1]), fee(), success()]);
        assert.equal(p.freshReads('/api/treasury'), 1, 'the overview was not re-read at inclusion');
        assert.equal(p.glue.treasuryTab(), 'spends', 'the tab went back to Overview');
        assert.equal(p.q('#treasury-content .account-tab.active').getAttribute('data-treastab'), 'spends');
        assert.equal(p.world.mounts.length, 1, 'the spends table was redrawn');
        await p.advance(REFRESH_UI.showDelayMs);
        assert.ok(chip(p, 'treasury'), 'no "Updating" while the treasury snapshot is behind');
        p.srv.treasury = 42;
        await p.advance(2000 + REFRESH_UI.minVisibleMs);
        assert.ok(!chip(p, 'treasury'));
        assert.equal(p.world.mounts.length, 1);
        p.q('[data-treastab="overview"]').click();
        assert.equal(p.q('#treasury-pot').textContent, '7', 'the overview pot did not follow the payout');
    });
    test('17 check status on the Overview tab: SpendProcessed re-reads and redraws the overview in place, tab kept', async () => {
        const p = govPage({ route: 'treasury' });
        await p.ctx.fetchTreasuryData();
        p.srv.pot = 6; p.srv.treasury = 42;
        await p.send({ key: 'treasury.checkStatus', params: { index: 7 } }, [ev('treasury', 'SpendProcessed', [7]), fee(), success()]);
        assert.equal(p.q('#treasury-pot').textContent, '6');
        assert.equal(p.glue.treasuryTab(), 'overview');
        assert.equal(p.q('#treasury-content').textContent.includes('Loading treasury data'), false);
    });
    test('a payment that failed, or a Paid for another spend: nothing re-read', async () => {
        const p = govPage({ route: 'treasury' });
        await spends(p);
        await p.send({ key: 'treasury.payout', params: { index: 7 } }, [ev('treasury', 'PaymentFailed', [7, 1]), fee(), success()]);
        await p.send({ key: 'treasury.payout', params: { index: 7 } }, [ev('treasury', 'Paid', [8, 1]), fee(), success()]);
        await p.advance(10_000);
        assert.equal(p.freshReads('/api/treasury'), 0);
    });
});

describe('R4 democracy: a vote follows the snapshot quietly (rows 18, 19)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 }); });
    afterEach(() => mock.timers.reset());
    test('18 democracy.vote in block: quiet fresh re-reads (no redraw) until the snapshot reaches the block', async () => {
        const p = govPage({ route: 'democracy' });
        await p.ctx.fetchDemocracyData();
        assert.equal(p.world.demRenders, 1);
        await p.send({ key: 'democracy.vote', params: { index: 0 } }, [fee(), success()]);
        assert.equal(p.freshReads('/api/democracy'), 1);
        assert.equal(p.world.demRenders, 1, 'the page was redrawn instead of patched');
        await p.advance(REFRESH_UI.showDelayMs);
        assert.ok(chip(p, 'democracy'));
        p.srv.dem = 42;
        await p.advance(2000 + REFRESH_UI.minVisibleMs);
        assert.ok(!chip(p, 'democracy'));
        assert.equal(p.freshReads('/api/democracy'), 2);
    });
});

describe('R4 guard: no fixed refresh timer after a governance action', () => {
    // Proved by mutation: put `onSuccess: () => setTimeout(() => view.refresh({ fresh: true }), 6000)` back into
    // councilMotionVote and this test names the line; the behaviour tests above fail too (a 6000 ms timer armed).
    test('script.js arms no setTimeout of a refresh after a council, democracy or treasury action', () => {
        const code = stripComments(SCRIPT).split('\n');
        const bad = code.map((l, i) => [i + 1, l.trim()]).filter(([, l]) => /setTimeout\(\s*\(\)\s*=>\s*[\w.]*(refresh|fetchCouncilData|fetchTreasuryData|fetchDemocracyData|fetchTechnicalCommitteeData)\(\s*\{\s*fresh:\s*true[^)]*\}\s*\)\s*,\s*\d+\s*\)/.test(l));
        assert.deepEqual(bad, [], 'fixed refresh timers in script.js:\n' + bad.map(([n, l]) => `  ${n}: ${l}`).join('\n'));
    });
});
