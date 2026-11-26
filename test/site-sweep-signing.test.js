// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 0, 2.3 rows I6, I31, I33, I34,
// and 6.2 T11, T13): every signing view WP1 touches keeps its review, its call, its signer, its guards and its evidence.
// Only classes and how a colour is applied change.
//
// How: the REAL functions are run, never a copy. The script.js views (Referendum vote, Council vote, Submit candidacy,
// Pay out, Withdraw unbonded, Send) are lifted from script.js by name into a vm context whose document is index.html's
// own body in happy-dom; submitSignedTx is a spy, and the call each view hands it is built with a REAL ApiPromise from
// the mainnet 394 metadata and read back (section, method, arguments). The lib views (Withdraw candidacy, Propose a spend)
// are mounted on the same document with their real builders. What each view shows and builds is compared with
// test/snapshots/s11-signing-views.json, written from f33320f (the parent of the sweep); a difference fails.
//
// Regenerate the snapshot only on purpose:  S11_SIGNING_SNAPSHOT_WRITE=1 node --test test/site-sweep-signing.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { bodyOf } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import { escapeHtml } from '../lib/html-escape.js';
import { pdexToPlanck, isPositiveNumberInput, buildTransferTx } from '../lib/wallet-safety.js';
import { labelConvictions, lockPeriodDays } from '../lib/conviction-lock.js';
import { payoutSignSet } from '../lib/payout-refresh.js';
import { sendableBalance } from '../lib/balance-locks.js';
import { sendRecipientProblem, renderRecipientRefusal, ss58PrefixOf } from '../lib/recipient-network.js';
import { createCouncilCandidacyUI } from '../lib/council-candidacy-view.js';
import { createSpendMotionUI } from '../lib/treasury-spend-view.js';
import { buildSpendMotion, decodeSpendMotion } from '../lib/treasury-spend.js';
import * as uiParts from '../lib/ui-parts.js';

const SNAP_FILE = new URL('./snapshots/s11-signing-views.json', import.meta.url);
const WRITE = !!process.env.S11_SIGNING_SNAPSHOT_WRITE;
const SNAP = WRITE ? {} : JSON.parse(readFileSync(SNAP_FILE, 'utf8'));
const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.lastIndexOf('</body>') + 7).replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '').replace(/<script[\s\S]*?<\/script>/g, '');
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const [ME, V1, V2, V3, BEN, OTHER] = [31, 41, 42, 43, 9, 50].map(addr);
const PDEX = 10n ** 12n;
const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(1); };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const OBSERVED = {};
// One fact per key. With WRITE the facts become the snapshot; otherwise each must equal the snapshot's.
function same(key, value) {
    const v = JSON.parse(JSON.stringify(value));
    OBSERVED[key] = v;
    if (WRITE) return;
    assert.ok(Object.prototype.hasOwnProperty.call(SNAP, key), `no snapshot for ${key}`);
    assert.deepEqual(v, SNAP[key], `${key} differs from f33320f`);
}
after(() => { if (WRITE) writeFileSync(SNAP_FILE, JSON.stringify(OBSERVED, null, 2) + '\n'); });

// What a person reads and can operate in a view: the ids in order, every control (tag, id, type, label, disabled,
// shown), and the text. No class and no style: those are what WP1 changes.
function shownInline(el) { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (/display:\s*none/.test(e.getAttribute('style') || '') || (e.style && e.style.display === 'none')) return false; } return true; }
function viewSnapshot(root) {
    const ids = Array.from(root.querySelectorAll('[id]')).map(e => e.id);
    const controls = Array.from(root.querySelectorAll('button, input, select, textarea, a[href]')).map(e => [e.tagName.toLowerCase(), e.id || '', e.getAttribute('type') || '', norm(e.textContent) || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '', !!e.disabled, shownInline(e)]);
    return { ids, controls, text: norm(root.textContent) };
}

// ── the real chain codec ──
let api;
before(async () => {
    const fx = loadFixture('metadata-mainnet-394.json');
    api = await ApiPromise.create({ provider: mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion }).provider, noInitWarn: true });
});
after(async () => { await api?.disconnect(); });
const callOf = async (opts, a = api) => {
    const tx = await opts.buildTx(a);
    const m = tx.method;
    return { section: m.section, method: m.method, args: m.args.map(x => x.toJSON()), hex: m.toHex(), label: opts.label, action: opts.action,
        button: opts.button ? opts.button.id : null, busyText: opts.busyText, idleText: opts.idleText,
        signingAccount: opts.signingAccount || null, expectedWallet: opts.expectedWallet || null };
};

// ── a page with index.html's body and script.js functions lifted by name ──
function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    assert.ok(at > 0, `script.js has no function ${name}`);
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}
function page({ path = '/democracy', wallet = ME, fns = [], ctx = {}, prelude = '' } = {}) {
    const win = new Window({ url: 'https://explorer.test' + path, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    doc.body.innerHTML = BODY;
    const calls = [], notices = [];
    const context = vm.createContext({
        window: win, document: doc, location: win.location, console, setTimeout, clearTimeout, Promise, Map, Set, Array, Object, Number, String, BigInt, JSON, Math, Error, Date, parseFloat, encodeURIComponent,
        CustomEvent: win.CustomEvent, Event: win.Event,
        getStoredWallet: () => wallet, showTxNotice: (m) => notices.push(m), submitSignedTx: async (o) => { calls.push(o); },
        stakingEscapeHtml: escapeHtml, stakingShortAddress: (a) => String(a).slice(0, 8) + '…' + String(a).slice(-6),
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), stakingFormatNumber: (n) => String(n),
        pdexToPlanck, isPositiveNumberInput, buildTransferTx, labelConvictions, lockPeriodDays, payoutSignSet, sendableBalance, sendRecipientProblem, renderRecipientRefusal, ss58PrefixOf,
        ...uiParts, ...ctx
    });
    vm.runInContext(prelude + fns.map(lift).join(''), context);
    return { win, doc, context, calls, notices, fn: (n) => context[n], get: (id) => doc.getElementById(id) };
}

describe('Referendum vote (SIGNING VIEW): I6, I34, P5, P8, P14, I5, I45', () => {
    const FNS = ['openReferendumVoteModal', 'closeReferendumVoteModal', 'submitReferendumVote', 'buildWalletConnectPrompt'];
    const CTX = { fanStage: (...f) => f, democracyView: { stage: () => () => {} }, govDetailPage: { stage: () => () => {} } };
    const world = (wallet = ME) => page({ wallet, fns: FNS, ctx: { ...CTX, globalApi: api }, prelude: 'var pendingReferendumVote = null;\n' });
    test('the modal as it ships (T13)', () => same('referendum.static', viewSnapshot(world().get('referendum-vote-modal'))));
    test('open on a Nay click, then switch to Aye: aria-pressed follows, no colour is written on the buttons (T11)', () => {
        const w = world();
        w.fn('openReferendumVoteModal')('7', 'nay');
        const aye = w.get('referendum-vote-side-aye'), nay = w.get('referendum-vote-side-nay');
        same('referendum.open-nay', viewSnapshot(w.get('referendum-vote-modal')));
        assert.deepEqual([aye.getAttribute('aria-pressed'), nay.getAttribute('aria-pressed')], ['false', 'true']);
        w.fn('openReferendumVoteModal')('7', 'aye');
        assert.deepEqual([aye.getAttribute('aria-pressed'), nay.getAttribute('aria-pressed')], ['true', 'false']);
        for (const b of [aye, nay]) assert.equal(b.getAttribute('style'), null, `${b.id}: a colour written from script (${b.getAttribute('style')})`);
    });
    test('the call: democracy.vote with the typed balance and conviction, the label, the action, the button (spy)', async () => {
        const w = world();
        w.fn('openReferendumVoteModal')('7', 'aye');
        w.get('referendum-vote-amount').value = '12.5';
        w.get('referendum-vote-conviction').value = 'Locked2x';
        await w.fn('submitReferendumVote')();
        assert.equal(w.calls.length, 1, 'the view did not hand one call to submitSignedTx');
        same('referendum.call', await callOf(w.calls[0]));
    });
    test('the guards: no amount, then a wild amount, are refused with the same words; nothing is signed', async () => {
        const w = world();
        w.fn('openReferendumVoteModal')('7', 'aye');
        await w.fn('submitReferendumVote')();
        const first = norm(w.get('referendum-vote-error').textContent);
        w.get('referendum-vote-amount').value = '2000000000000000';
        await w.fn('submitReferendumVote')();
        same('referendum.guards', { first, second: norm(w.get('referendum-vote-error').textContent), calls: w.calls.length });
    });
    test('no wallet: the connect prompt fills the amber panel and its icon stays (I6)', () => {
        const w = world('');
        w.fn('openReferendumVoteModal')('7', 'aye');
        const warn = w.get('referendum-vote-modal-wallet-warning');
        same('referendum.no-wallet', { text: norm(warn.textContent), link: warn.querySelector('a') && warn.querySelector('a').getAttribute('href') });
        assert.ok(warn.querySelector(':scope > .bx.bx-error'), 'the prompt replaced the icon');
        assert.ok(warn.querySelector('.ui-panel-body a'), 'the prompt is not inside the panel body');
    });
});

describe('Council vote (SIGNING VIEW): I6, I33, P4, P6, P8, P14, I45', () => {
    const FNS = ['openCouncilVoteModal', 'renderCouncilVoteAvailable', 'renderCouncilVoteSelected', 'councilVoteFilteredPool', 'checkWalletForCouncil', 'buildWalletConnectPrompt', 'submitCouncilVote', 'planckToPdexString'];
    const COUNCIL = { members: [{ address: V1, name: 'Alpha', stake: 100 }], runnersUp: [{ address: V2, name: 'Unknown', stake: 50 }], candidates: [{ address: V3, name: 'Gamma', stake: 0 }], pallet: 'elections' };
    const world = ({ wallet = ME, fail = null } = {}) => page({ path: '/council', wallet, fns: FNS, prelude: 'var councilVoteCandidates = []; var councilVoteSearchTerm = ""; var councilPalletName = "elections"; var voteModal = document.getElementById("council-vote-modal");\n',
        ctx: { councilVoteSelected: new Map(), govRefresh: { overlay: (k, d) => d },
            fetch: async () => (fail ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => COUNCIL }),
            globalApi: { query: { elections: { voting: async () => null }, system: { account: async () => ({ data: { free: { toString: () => String(1234n * PDEX) } } }) } } } } });
    test('the modal as it ships (T13)', () => same('council-vote.static', viewSnapshot(world().get('council-vote-modal'))));
    test('open with a wallet: the lists, the counts and the votable balance (review unchanged; the figure is .ui-quiet)', async () => {
        const w = world();
        await w.fn('openCouncilVoteModal')();
        await flush();
        same('council-vote.open', viewSnapshot(w.get('council-vote-modal')));
        const strong = w.get('council-vote-votable').querySelector('strong');
        assert.ok(strong && strong.classList.contains('ui-quiet') && !strong.hasAttribute('style'), 'P6: the votable figure');
    });
    test('open with no wallet: the prompt in the amber panel, the votable line asks to connect (no inline colour)', async () => {
        const w = world({ wallet: '' });
        await w.fn('openCouncilVoteModal')();
        await flush();
        const warn = w.get('vote-modal-wallet-warning');
        same('council-vote.no-wallet', { warn: norm(warn.textContent), votable: norm(w.get('council-vote-votable').textContent) });
        assert.ok(warn.querySelector(':scope > .bx.bx-error') && warn.querySelector('.ui-panel-body a'), 'the prompt is not inside the panel body');
        assert.equal(w.get('council-vote-votable').querySelector('[style]') === null, true, 'P6: a colour written in the votable line');
    });
    test('candidates could not load: the same words, in an amber line panel (I33)', async () => {
        const w = world({ fail: true });
        await w.fn('openCouncilVoteModal')();
        await flush();
        const box = w.get('council-vote-available-list');
        same('council-vote.failed', norm(box.textContent));
        assert.ok(box.querySelector('.council-vote-empty .ui-panel.is-warn.is-line .bx-error'), 'not an amber line panel');
        assert.equal(box.querySelector('[style]') === null, true, 'a colour written in markup');
    });
    test('the call: elections.vote with the picked candidates and the typed stake (spy)', async () => {
        const w = world();
        await w.fn('openCouncilVoteModal')();
        await flush();
        for (const a of [V3, V1]) w.get('council-vote-available-list').querySelector(`[data-council-add="${a}"]`).click();
        w.get('vote-stake-input').value = '250.5';
        await w.fn('submitCouncilVote')();
        assert.equal(w.calls.length, 1);
        same('council-vote.call', await callOf(w.calls[0]));
    });
    test('the guards: nothing picked, no stake, a bad stake (same notices, nothing signed)', async () => {
        const w = world();
        await w.fn('openCouncilVoteModal')();
        await flush();
        await w.fn('submitCouncilVote')();
        w.get('council-vote-available-list').querySelector(`[data-council-add="${V1}"]`).click();
        await w.fn('submitCouncilVote')();
        w.get('vote-stake-input').value = '-5';
        await w.fn('submitCouncilVote')();
        same('council-vote.guards', { notices: w.notices, calls: w.calls.length });
    });
});

describe('Submit candidacy (SIGNING VIEW): I5, I6, P5, P8, I45', () => {
    const world = (wallet = ME) => page({ path: '/council', wallet, fns: ['checkWalletForCouncil', 'buildWalletConnectPrompt', 'submitCouncilCandidacy'],
        prelude: 'var councilPalletName = "elections"; var candidacyModal = document.getElementById("council-candidacy-modal");\n' });
    test('the modal as it ships (T13)', () => same('candidacy.static', viewSnapshot(world().get('council-candidacy-modal'))));
    test('with a wallet: the active wallet box reads the address; without: the prompt fills the amber panel', () => {
        const w = world();
        w.fn('checkWalletForCouncil')('candidacy');
        const n = world('');
        n.fn('checkWalletForCouncil')('candidacy');
        const warn = n.get('candidacy-modal-wallet-warning');
        same('candidacy.wallet', { active: w.get('candidacy-active-wallet').textContent, noneActive: n.get('candidacy-active-wallet').textContent, warn: norm(warn.textContent) });
        assert.ok(warn.querySelector(':scope > .bx.bx-error') && warn.querySelector('.ui-panel-body a'), 'the prompt is not inside the panel body');
    });
    test('the call: elections.submitCandidacy with the live candidate count (spy)', async () => {
        const w = world();
        await w.fn('submitCouncilCandidacy')();
        assert.equal(w.calls.length, 1);
        const chain = { tx: api.tx, query: { elections: { candidates: async () => [[V1, 1], [V2, 2]] } } };
        same('candidacy.call', await callOf(w.calls[0], chain));
    });
});

describe('Pay out (SIGNING VIEW): P1, I31', () => {
    const FNS = ['openPayoutModal', 'submitPayoutTx', 'batchTx', 'buildPayoutCall'];
    const entries = (n) => Array.from({ length: n }, (_, i) => ({ era: 500 + i, validator: i % 2 ? V1 : V2, amount: 1.5, key: `${500 + i}:${i % 2 ? V1 : V2}` }));
    const world = (list) => page({ path: '/wallet', fns: FNS, prelude: 'const PAYOUT_BATCH_MAX = 30;\n', ctx: {
        currentWalletData: { address: ME },
        payoutRefresh: { model: () => ({ button: 'enabled', payable: list, payableTotal: list.length * 1.5 }), signable: () => list, modalLine: () => {}, paint: () => {},
            rowsHtml: (es) => es.map(e => `<div class="payout-entry" data-key="${e.key}">${e.era}</div>`).join('') } } });
    test('the modal as it ships (T13)', () => same('payout.static', viewSnapshot(world([]).get('payout-modal'))));
    test('nothing to pay: the same sentence, as an empty state (no inline colour); Sign disabled', () => {
        const w = world([]);
        w.fn('openPayoutModal')();
        const box = w.get('payout-entries');
        same('payout.empty', { text: norm(box.textContent), disabled: w.get('submit-payout-tx-btn').disabled });
        assert.ok(box.querySelector('.ui-state.is-empty'), 'P1: not a .ui-state');
        assert.equal(box.querySelector('[style]') === null, true);
    });
    test('more than 30: the note says so before signing, as data-state="note" and no colour set from script (I31)', () => {
        const w = world(entries(33));
        w.fn('openPayoutModal')();
        const err = w.get('payout-modal-error');
        same('payout.note', { text: norm(err.textContent), shown: err.style.display });
        assert.equal(err.getAttribute('data-state'), 'note');
        assert.equal(err.style.color, '', 'a colour set from script');
    });
    test('the call: utility.batch of staking.payoutStakers for the first 30 listed pairs (spy)', async () => {
        const w = world(entries(33));
        w.fn('openPayoutModal')();
        await w.fn('submitPayoutTx')();
        assert.equal(w.calls.length, 1);
        const err = w.get('payout-modal-error');
        same('payout.call', { ...(await callOf(w.calls[0])), note: norm(err.textContent) });
        const noteState = err.getAttribute('data-state');
        w.calls[0].onError('Rejected in wallet');
        same('payout.error', norm(err.textContent));
        assert.equal(noteState, 'note');
        assert.equal(err.getAttribute('data-state'), 'error');
        assert.ok(err.querySelector('.bx-error-circle'), 'no error icon');
        assert.equal(err.style.color, '');
    });
});

describe('Withdraw unbonded (SIGNING VIEW): I31', () => {
    const world = (controller) => page({ path: '/wallet', fns: ['submitWithdrawUnbonded', 'isSameAddress'], prelude: `var withdrawControllerAddress = ${JSON.stringify(controller)};\n`, ctx: {
        currentWalletData: { address: ME }, decodeAddress: (a) => a, toPolkadexAddress: (a) => a,
        globalApi: { query: { staking: { slashingSpans: async () => ({ isSome: true, unwrap: () => ({ prior: [1, 2] }) }) } } } } });
    test('the call: staking.withdrawUnbonded with the slashing-span count (spy)', async () => {
        const w = world(ME);
        await w.fn('submitWithdrawUnbonded')();
        assert.equal(w.calls.length, 1);
        same('withdraw.call', await callOf(w.calls[0]));
    });
    test('another controller: refused before signing with the same words, as data-state="error" (I31)', async () => {
        const w = world(OTHER);
        await w.fn('submitWithdrawUnbonded')();
        const err = w.get('unstake-modal-error');
        same('withdraw.refused', { text: norm(err.textContent), calls: w.calls.length });
        assert.equal(err.getAttribute('data-state'), 'error');
        assert.equal(err.style.color, '');
    });
});

describe('Send (SIGNING VIEW): I31', () => {
    const FNS = ['openSendModal', 'validateSendRecipient', 'submitSendTx', 'clearSendError', 'showSendError', 'updateSendSignGate', 'getExistentialDepositPDEX', 'isSameAddress'];
    const world = () => page({ path: '/wallet', fns: FNS, prelude: 'var sendValidRecipient = false; var sendLastFeePDEX = null; var sendFeeEstimateFailed = false; const SEND_FEE_BUFFER = 0.05;\n', ctx: {
        currentWalletData: { address: ME, balance: { free: 100, transferable: 100, total: 100 } }, globalApi: api, multisigStore: { find: () => null } } });
    test('the modal as it ships (T13)', () => same('send.static', viewSnapshot(world().get('send-modal'))));
    test('the recipient hint: empty, a bad address, a good one (same words; data-state, no colour set from script)', () => {
        const w = world();
        w.fn('openSendModal')();
        const hint = w.get('send-to-hint');
        const seen = [[norm(hint.textContent), hint.getAttribute('data-state')]];
        w.get('send-to-input').value = 'not-an-address';
        w.fn('validateSendRecipient')();
        seen.push([norm(hint.textContent), hint.getAttribute('data-state')]);
        w.get('send-to-input').value = V1;
        w.fn('validateSendRecipient')();
        seen.push([norm(hint.textContent), hint.getAttribute('data-state')]);
        same('send.hints', seen.map(s => s[0]));
        assert.deepEqual(seen.map(s => s[1]), ['', 'error', 'ok']);
        assert.equal(hint.style.color, '', 'a colour set from script');
        assert.ok(hint.querySelector('.bx-check'), 'the good address has no check icon');
    });
    test('the call: balances.transferKeepAlive to the recipient with the typed amount (spy)', async () => {
        const w = world();
        w.fn('openSendModal')();
        w.get('send-to-input').value = V1;
        w.get('send-amount-input').value = '12.25';
        await w.fn('submitSendTx')();
        assert.equal(w.calls.length, 1, norm(w.get('send-modal-error').textContent));
        same('send.call', await callOf(w.calls[0]));
    });
});

describe('Withdraw candidacy (SIGNING VIEW, lib/council-candidacy-view.js on index.html): rows 1 to 4', () => {
    test('the modal as it ships, the review after open, and the call (spy)', async () => {
        const w = page({ path: '/council' });
        const submitted = [];
        const chain = { genesisHash: api.genesisHash, runtimeVersion: { specVersion: 394 }, tx: api.tx, query: { elections: { members() {}, runnersUp() {}, candidates() {} } },
            rpc: { chain: { getBlockHash: async () => '0x' + '22'.repeat(32) } },
            at: async () => ({ query: { elections: { members: async () => [], runnersUp: async () => [], candidates: async () => [[V1, 10], [ME, 10]] } } }) };
        same('withdraw-candidacy.static', viewSnapshot(w.get('council-withdraw-modal')));
        const ui = createCouncilCandidacyUI({ api: () => chain, selected: () => ME, isMultisig: () => false, document: w.doc, submit: async (o) => { submitted.push(o); },
            refresh: () => {}, connectPrompt: () => '<a href="/wallet">Connect wallet</a>' });
        await ui.open();
        await flush();
        same('withdraw-candidacy.open', viewSnapshot(w.get('council-withdraw-modal')));
        w.get('council-withdraw-sign').click();
        await flush();
        assert.equal(submitted.length, 1, 'Sign did not hand the call over');
        same('withdraw-candidacy.call', await callOf(submitted[0], chain));
    });
});

describe('Propose a spend (SIGNING VIEW, lib/treasury-spend-view.js on index.html): rows 5 to 7', () => {
    test('the modal as it ships, the review, and the call (spy)', async () => {
        const w = page({ path: '/treasury' });
        const submitted = [];
        const chain = api;   // the 394 registry: PDEX has 12 decimals
        same('spend.static', viewSnapshot(w.get('treasury-spend-modal')));
        const ui = createSpendMotionUI({ api: () => chain, selected: () => ME, isMultisig: () => false, submit: async (o) => { submitted.push(o); }, connectPrompt: () => '<a>Connect wallet</a>', document: w.doc,
            motion: { readSeats: async () => ({ pallet: 'council', members: [ME, V1, V2, V3, BEN] }), readHead: async () => 1000, build: buildSpendMotion, decode: decodeSpendMotion } });
        await ui.open();
        await flush();
        w.get('treasury-spend-beneficiary').value = BEN;
        w.get('treasury-spend-amount').value = '1500';
        w.get('treasury-spend-check').click();
        await flush();
        same('spend.review', viewSnapshot(w.get('treasury-spend-modal')));
        w.get('treasury-spend-sign').click();
        await flush();
        assert.equal(submitted.length, 1, 'Sign did not hand the call over');
        same('spend.call', await callOf(submitted[0], chain));
    });
});

// ── WP1 review fixes (designer): the shared #unstake-modal-error and the wrong-network refusal ──
describe('WP1 review fixes: Withdraw unbonded and Unstake share #unstake-modal-error', () => {
    const world = (controller) => page({ path: '/wallet', fns: ['submitWithdrawUnbonded', 'submitUnstakeTx', 'isSameAddress'], prelude: `var withdrawControllerAddress = ${JSON.stringify(controller)};\n`, ctx: {
        currentWalletData: { address: ME }, decodeAddress: (a) => a, toPolkadexAddress: (a) => a,
        globalApi: { query: { staking: { slashingSpans: async () => ({ isSome: true, unwrap: () => ({ prior: [1, 2] }) }) } } } } });
    test('Withdraw fails, then Unstake fails: the element shows the error state with its icon, no colour from script', async () => {
        const w = world(OTHER);
        await w.fn('submitWithdrawUnbonded')();
        const err = w.get('unstake-modal-error');
        assert.equal(err.getAttribute('data-state'), 'error');
        assert.equal(err.querySelectorAll('.ui-hint-icon').length, 1);
        w.context.currentWalletData = null;
        await w.fn('submitUnstakeTx')();
        assert.equal(norm(err.textContent), 'Wallet data is not loaded.');
        assert.equal(err.getAttribute('data-state'), 'error', 'an Unstake failure must draw as the error state');
        assert.equal(err.querySelectorAll('.ui-hint-icon').length, 1, 'an Unstake failure must carry the error icon');
        assert.ok(err.querySelector('.bx-error-circle'));
        assert.equal(err.style.color, '');
        assert.equal(w.calls.length, 0);
    });
    test('a cleared element has no data-state: Withdraw after a failed Withdraw', async () => {
        const w = world(OTHER);
        await w.fn('submitWithdrawUnbonded')();
        const err = w.get('unstake-modal-error');
        assert.equal(err.getAttribute('data-state'), 'error');
        w.context.withdrawControllerAddress = ME;
        await w.fn('submitWithdrawUnbonded')();
        assert.equal(w.calls.length, 1, 'the retry reaches signing');
        assert.equal(err.hasAttribute('data-state'), false, 'Withdraw left the old state on a cleared element');
        assert.equal(err.textContent, '');
    });
    test('Pay out: reopening after an error clears data-state', async () => {
        const list = Array.from({ length: 2 }, (_, i) => ({ era: 500 + i, validator: V1, amount: 1.5, key: `${500 + i}:${V1}` }));
        const w = page({ path: '/wallet', fns: ['openPayoutModal', 'submitPayoutTx', 'batchTx', 'buildPayoutCall'], prelude: 'const PAYOUT_BATCH_MAX = 30;\n', ctx: {
            currentWalletData: { address: ME },
            payoutRefresh: { model: () => ({ button: 'enabled', payable: list, payableTotal: list.length * 1.5 }), signable: () => list, modalLine: () => {}, paint: () => {},
                rowsHtml: (es) => es.map(e => `<div class="payout-entry" data-key="${e.key}">${e.era}</div>`).join('') } } });
        w.fn('openPayoutModal')();
        await w.fn('submitPayoutTx')();
        w.calls[0].onError('Rejected in wallet');
        const err = w.get('payout-modal-error');
        assert.equal(err.getAttribute('data-state'), 'error');
        list.length = 0;
        w.fn('openPayoutModal')();
        assert.equal(err.hasAttribute('data-state'), false, 'the reopened modal kept the error state');
    });
});

describe('WP1 review fixes: Send wrong-network refusal', () => {
    test('the refusal hint holds exactly one .ui-hint-icon, first, in the error state; the Copy button is kept', () => {
        const w = page({ path: '/wallet', fns: ['openSendModal', 'validateSendRecipient', 'clearSendError', 'updateSendSignGate', 'getExistentialDepositPDEX', 'isSameAddress'], prelude: 'var sendValidRecipient = false; var sendLastFeePDEX = null; var sendFeeEstimateFailed = false; const SEND_FEE_BUFFER = 0.05;\n', ctx: {
            currentWalletData: { address: ME, balance: { free: 100, transferable: 100, total: 100 } }, globalApi: api, multisigStore: { find: () => null } } });
        w.fn('openSendModal')();
        w.get('send-to-input').value = encodeAddress(new Uint8Array(32).fill(7), 0);
        w.fn('validateSendRecipient')();
        const hint = w.get('send-to-hint');
        assert.equal(hint.getAttribute('data-state'), 'error');
        assert.ok(hint.querySelector('.js-recipient-copy'), 'the refusal was not drawn');
        assert.equal(hint.querySelectorAll('.ui-hint-icon').length, 1);
        assert.equal(hint.firstElementChild.className.includes('ui-hint-icon'), true, 'the icon is not first');
        assert.equal(hint.firstElementChild.getAttribute('aria-hidden'), 'true');
        assert.equal(hint.querySelectorAll('.js-recipient-copy').length, 1);
        w.fn('validateSendRecipient')();
        assert.equal(hint.querySelectorAll('.ui-hint-icon').length, 1, 'a second pass doubled the icon');
    });
});
