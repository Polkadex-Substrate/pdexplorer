// Sprint R3 of "pages update themselves after an action" (design cto-team/plans/2026-11-22-post-action-refresh-design.md,
// sections 3, 4, 6, 7 and 9 "R3"; UX spec 2026-11-22-post-action-refresh-ux.md, rules U1 to U6 and U13): every wallet
// action repaints only what changed, in place, without losing scroll, focus or typed input.
//
// Everything runs the REAL page code, lifted from script.js into one happy-dom page: renderWalletDashboard, the action
// bar, the six wallet actions' submit functions (send, unstake, full unstake, withdraw unbonded, set and clear
// identity), the proxy list and the add-proxy form, refreshWalletDashboardFor and submitSignedTx; the lines that create
// the known-results store, the post-action core, the payout part, the stake part and the wallet sections; the real
// tracker (lib/tx-submit.js) and status model (lib/tx-status.js). Only the chain, the wallet and the server are fakes:
// the server answers /api/wallet and /api/proxies from a state the test moves, with the freshness field of R2.
//
// Per action: the sections that must follow do, at inclusion or when the server has the block; every other section
// is not touched (no DOM mutation at all) and the dashboard's nodes are the same nodes (no remount); a typed field in
// the add-proxy form keeps its text and focus; no 2.5 s timer is armed. Nothing changes for a transaction that failed
// in its block, or was dropped, usurped or invalid before one. A replaced block takes back what it showed; a wallet
// switch during the wait draws nothing of the old account; an older server copy is not drawn over a newer one.
// Addresses are the public substrate dev accounts.

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
import * as payoutRefreshModule from '../lib/payout-refresh.js';
import * as stakeRefreshModule from '../lib/stake-refresh.js';
import { mountWalletRecentTx } from '../lib/wallet-recent-tx.js';
import { sendableBalance } from '../lib/balance-locks.js';
import { pdexToPlanck } from '../lib/wallet-safety.js';
import { escapeHtml } from '../lib/html-escape.js';
import { STRINGS, REFRESH_UI } from '../lib/refresh-ui.js';
import { ME, OTHER, V1, V2, V3, REGISTRY } from './helpers/payout-events.js';

// New in R3; missing before it.
const sectionsModule = await import('../lib/wallet-sections.js').then((m) => m, () => ({}));
const SCRIPT = readRepo('script.js', import.meta.url);
const GENESIS = '0x' + '22'.repeat(32);
const flush = async () => { for (let i = 0; i < 16; i++) await new Promise(r => setImmediate(r)); };
const between = (start, end) => { const i = SCRIPT.indexOf(start); return i < 0 ? '' : SCRIPT.slice(i, SCRIPT.indexOf(end, i) + end.length); };
const line = (start) => { const i = SCRIPT.indexOf(start); return i < 0 ? '' : SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
const lift = (name) => { const at = SCRIPT.indexOf(`function ${name}(`); if (at < 0) return ''; return (SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '') + bodyOf(SCRIPT, name); };
const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const success = () => ev('system', 'ExtrinsicSuccess');
const failed = () => ev('system', 'ExtrinsicFailed', [{ isModule: true, asModule: { index: 9, error: 14 } }, {}]);

const NETWORK = { minStake: 50, activeNominators: 10, totalNominators: 20, activeValidators: 5, totalValidators: 7, eraDurationMs: 86400000, unbondingMs: 2419200000, currentEra: 900 };
const base = () => ({
    address: ME, identity: 'Unknown',
    balance: { free: 900, reserved: 100, total: 1000, transferable: 400, transferableAllowDeath: 401 },
    staking: { isStaker: true, isNominator: true, totalStaked: 500, activeStaked: 450, unlocking: 50, ledgerRead: 'ok', controller: null,
        nominating: [{ address: V1, name: 'Val One' }, { address: V2, name: null }] },
    rewards: { claimedTotal: 12.5, unpaidTotal: 0, unpaidCount: 0, unclaimedFresh: true, unpaidEntries: [], recentClaimed: [{ era: 800, amount: 1.25, timestamp: 7 }] },
    recentTransactions: [{ hash: '0x' + 'aa'.repeat(32), block: 5, from: OTHER, to: ME, amount: '3 PDEX', timestamp: 9 }],
    network: NETWORK
});
const MODALS = `
    <div id="send-modal" style="display:flex"><input id="send-to-input"><input id="send-amount-input"><input type="checkbox" id="send-keep-alive" checked><div id="send-modal-error"></div><button id="submit-send-tx-btn">Sign and send</button></div>
    <div id="unstake-modal" style="display:flex"><input id="unstake-amount-input"><div id="unstake-modal-error"></div><button id="submit-unstake-tx-btn">Sign and unstake</button><button id="submit-withdraw-tx-btn">Withdraw unbonded funds</button></div>
    <div id="identity-modal" style="display:flex">${['display', 'legal', 'email', 'twitter', 'web', 'riot'].map(k => `<input id="identity-${k}">`).join('')}<div id="identity-modal-error"></div><button id="submit-identity-tx-btn">Save identity</button><button id="clear-identity-tx-btn">Reset (clear)</button></div>`;

// The sections a test watches: a mutation under one that is not expected to change fails the test.
const SECTIONS = {
    head: '#wallet-head-name', total: '#wallet-total-value', staked: '#wallet-staked-value', claimed: '#wallet-claimed-value', unpaid: '#wallet-unpaid-tile',
    send: '#wallet-act-send', stake: '#wallet-act-stake', payout: '#wallet-act-payout', unstake: '#wallet-act-unstake', identityBtn: '#wallet-act-identity',
    network: '#wsec-network', validators: '#wallet-my-validators', rewards: '#wallet-recent-rewards-table', apr: '#wallet-apr-body', tx: '#wallet-recent-tx-table',
    proxies: '#wallet-proxy-list', proxyForm: '#wallet-proxy-add', locks: '#wallet-locks-slot', nominations: '#wallet-nominations-slot'
};

// realBlock: the page's own stale banner and action block (F-068) instead of the recorders (the R3 review's tests).
function walletPage({ realBlock = false } = {}) {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    doc.body.innerHTML = `<div id="wallet-dashboard"></div>${MODALS}`;
    const timers = [];
    const log = { built: [], walletReads: 0, proxyReads: 0, aprReads: 0, locksMounts: 0, nominationMounts: 0, aprRenders: 0, blocked: [], banners: [], scrolled: [] };
    // fail / proxyFail: the next /api/wallet or /api/proxies answers that error (a 500)
    const srv = { head: 41, chain: 41, tx: 41, rewards: 41, state: base(), proxies: [{ delegate: V3, proxyType: 'Staking', delay: 0 }], gate: null, connected: ME, fail: null, proxyFail: null };
    const fresh = () => ({ v: 1, chainHead: srv.head, indexed: { chain: srv.chain, rewards: srv.rewards, tx: srv.tx }, since: { chain: 1, rewards: 1, tx: 1 },
        kv: { council: null, democracy: null, treasury: null }, pending: [], intervalMs: { chain: 12000, rewards: 60000, tx: 30000 } });
    const reply = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
    const refuse = (error) => ({ ok: false, status: 500, json: async () => ({ error }) });
    const fetch = async (url) => {
        url = String(url);
        if (url.startsWith('/api/wallet/')) {
            log.walletReads++;
            if (srv.fail) return refuse(srv.fail);
            const body = { ...srv.state, freshness: fresh() };   // the copy as of the moment it is asked
            if (srv.gate) await srv.gate;
            return reply(body);
        }
        if (url.startsWith('/api/proxies/')) { log.proxyReads++; if (srv.proxyFail) return refuse(srv.proxyFail); return reply({ account: ME, proxies: srv.proxies, deposit: srv.proxies.length * 2.5, freshness: fresh() }); }
        if (url.startsWith('/api/proxy-types')) return reply({ types: ['Any', 'Staking'] });
        if (url.startsWith('/api/staking-rewards/')) { log.aprReads++; return reply({ claimed: [], apr: null }); }
        return reply({});
    };
    let onStatus = null;
    const tx = (name) => (...args) => { log.built.push({ name, args }); return { signAsync: async () => ({ send: async (cb) => { onStatus = cb; return () => {}; } }) }; };
    const api = {
        registry: REGISTRY, genesisHash: { toHex: () => GENESIS }, on() {}, off() {},
        rpc: { chain: { getHeader: async (h) => ({ number: { toNumber: () => (h === '0xb1' ? 42 : h === '0xb2' ? 43 : 99) } }) } },
        tx: { balances: { transferKeepAlive: tx('balances.transferKeepAlive') }, staking: { unbond: tx('staking.unbond'), withdrawUnbonded: tx('staking.withdrawUnbonded'), chill: tx('staking.chill') },
            identity: { setIdentity: tx('identity.setIdentity'), clearIdentity: tx('identity.clearIdentity') }, proxy: { addProxy: tx('proxy.addProxy'), removeProxy: tx('proxy.removeProxy') } },
        query: { staking: { slashingSpans: async () => ({ isSome: false }) } }
    };
    win.scrollBy = (x, y) => { log.scrolled.push([x, y]); };
    const fmtPdex = (v) => Number(v || 0).toFixed(4);
    const ctx = {
        console: { log() {}, warn() {}, error() {} }, Promise, Object, JSON, Array, Map, Set, WeakMap, WeakSet, String, Number, Math, Date, Error, encodeURIComponent, parseInt, parseFloat,
        TextEncoder, TextDecoder, queueMicrotask,
        window: win, document: doc, navigator: { clipboard: { writeText: async () => {} } }, confirm: () => true, fetch,
        setTimeout: (f, ms) => { const tm = { f, ms, live: true }; timers.push(tm); return tm; }, clearTimeout: (tm) => { if (tm) tm.live = false; },
        globalApi: api, liveRuntimeError: () => null, WALLET_CHANGED_STALE, VALIDATE_ON: false, walletAprData: null, walletFetchGen: 0,
        walletSession: { signingCheck: () => () => true, revision: () => 1 },
        getStoredWallet: () => srv.connected, isSameAddress: (x, y) => x === y, readRouteFromLocation: () => 'wallet',
        multisigStore: { find: () => null }, multisigUI: { review: async () => {}, mountAccounts() {}, mountPending() {} },
        resolveWalletSigner: async () => ({ account: { address: ME }, signer: {} }),
        trackSignedTx, showTxStatus: (a, s, e, err, x) => buildTxModel(a, s, e, err, x),
        createKnownResults, createPostAction, effectsFor, caughtUp, pollDeadlineMs, samePayload, ...payoutRefreshModule, ...stakeRefreshModule, ...sectionsModule,
        mountWalletRecentTx,
        stakingFormatPDEX: fmtPdex, stakingFormatNumber: (n) => (n == null ? '-' : String(n)), stakingShortAddress: (x) => String(x).slice(0, 6) + '...', stakingEscapeHtml: escapeHtml,
        formatDuration: (ms) => (ms == null ? '-' : `${ms / 3600000}h`), formatLocalDate: (x) => `D${x}`, looksLikeTxHash: () => true,
        helpIcon: () => '', rewardHistoryLinkHtml: () => '', walletViewingSlotHtml: () => '', renderUsdSubscript: (n) => `$${Number(n || 0).toFixed(2)}`,
        buildViewOnlyCallout: () => '<div class="wallet-readonly-callout">READ-ONLY</div>', hasInjectedWalletNow: () => true,
        getStakeableBalance: (d) => Number(((d && d.balance) || {}).transferable || 0),
        makeTable: (cfg) => { cfg.container.innerHTML = `<p>TABLE ${cfg.summarySuffix} ${cfg.rows.length}</p>`; return { getState: () => ({ sortKey: 'x' }) }; },
        fetchApiJson: async (url) => { const r = await fetch(url); const d = await r.json(); if (!r.ok || (d && d.error)) throw new Error((d && d.error) || 'HTTP ' + r.status); return d; },
        bindViewOnlyCalloutHandlers() {}, applyWalletActionBlock() {}, scheduleWalletSigningRechecks() {},
        mountBalanceLocks: (el) => { log.locksMounts++; if (el) el.innerHTML = '<p>LOCKS</p>'; }, lockActionDeps: () => ({}),
        mountNominationStatus: (el) => { log.nominationMounts++; if (el) el.innerHTML = `<p>NOMINATIONS ${log.nominationMounts}</p>`; },
        refreshWalletMultisigs() {}, renderWalletAprCard: () => { log.aprRenders++; const b = doc.getElementById('wallet-apr-body'); if (b) b.innerHTML = `<p>APR ${log.aprRenders}</p>`; },
        renderWalletPriceChart() {}, readWalletValidator: () => Promise.resolve(null), walletValidatorCard: () => '', readStakeFigures: async () => { throw new Error('no chain read in R3 tests'); },
        readWalletCache: () => null, writeWalletCache() {}, renderWalletLoading: () => () => {}, maybeRunWalletEntryIntent() {}, repaintWalletPriceCard() {}, clearWalletStaleBanner() {}, clearWalletActionBlock() {},
        showWalletStaleBanner: (r, at, mode, msg) => log.banners.push(mode + ':' + msg), disableWalletActions: (why) => log.blocked.push(why),
        renderApiError() {}, renderMultisigCalculator() {}, renderMultisigPending() {}, chainDelegate: (d) => d, ss58PrefixOf: () => 88, proxyTypesOf: () => ['Any', 'Staking'],
        proxyPrefill: () => null, proxyDelegateProblem: () => null, renderRecipientRefusal() {},
        // the actions' own checks, not under test here
        signerRoles: () => ({ controllerDiffers: false }), planProblemMessage: () => 'refused', isPositiveNumberInput: (s) => Number(s) > 0,
        buildCheckedUnbondTx: (a, o) => a.tx.staking.unbond(o.value), buildStakeTx: (a) => a.tx.staking.unbond('all'), planFullUnbond: (p) => ({ p }),
        planckToPdexString: (p) => String(Number(p) / 1e12), decodeUnstakeError: (e) => String((e && e.message) || e), pdexToPlanck,
        sendRecipientProblem: () => null, sendableBalance, getExistentialDepositPDEX: () => 0, buildTransferTx: (a, to, v) => a.tx.balances.transferKeepAlive(to, v),
        showSendError: (m) => { log.sendError = m; }, clearSendError() {}, openSendModal() {}, openStakeModal() {}, openPayoutModal() {}, openUnstakeModal() {}, openIdentityModal() {},
        openWalletPicker() {}, disconnectWallet() {}
    };
    vm.createContext(ctx);
    const src = [
        'let currentWalletData = null, stakeCard = null, cachedProxyTypes = null, unstakeFullUnbondIntent = false, unstakeMaxPlanck = null, withdrawControllerAddress = null, sendLastFeePDEX = null;',
        'const walletRecentStore = { address: null, rows: [], next: null };',
        line('const IDENTITY_FIELD_KEYS = '), line('const IDENTITY_FIELD_MAX_BYTES = '), line('const SEND_FEE_BUFFER = '),
        line('const knownResults = createKnownResults('), line('const postAction = createPostAction('), line('const payoutRefresh = createPayoutRefresh('),
        line('const stakeRefresh = createStakeRefresh('), line('const walletSections = createWalletSections('),
        ...['renderWalletDashboard', 'bindWalletActionHandlers', 'buildWalletActionBarMarkup', 'mountWalletNominations', 'mountWalletRewardsTable', 'mountWalletTxTable',
            'walletRefreshFailed', 'refreshWalletDashboardFor', 'fetchWalletDashboard', 'isWalletRoute', 'submitSignedTx', 'submitSendTx', 'submitUnstakeTx', 'submitWithdrawUnbonded',
            'submitSetIdentity', 'submitClearIdentity', 'toIdData', 'showIdentityError', 'hideIdentityError', 'renderWalletAdvancedSection', 'renderProxyList', 'renderAddProxyForm'].map(lift),
        ...(realBlock ? ['let walletActionsBlockedReason = null;', between('const WALLET_ACTION_IDS = [', '];'), line('const WALLET_STALE_BANNER_ID = '),
            ...['describeAge', 'showWalletStaleBanner', 'clearWalletStaleBanner', 'disableWalletActions', 'clearWalletActionBlock', 'applyWalletActionBlock'].map(lift)] : []),
        `globalThis.__glue = { known: knownResults, data: () => currentWalletData, setData: (d) => { currentWalletData = d; },
            full: (v, m) => { unstakeFullUnbondIntent = true; unstakeMaxPlanck = m; } };`
    ].join('\n');
    vm.runInContext(src, ctx);
    const q = (s) => doc.querySelector(s);
    const p = {
        win, doc, ctx, srv, log, timers, q, glue: ctx.__glue,
        render: async (data = { ...srv.state, freshness: fresh() }) => { ctx.renderWalletDashboard(data, { history: [], configured: false }, null); await flush(); },
        emit: async (status, events) => { onStatus({ status, events, txHash: { toHex: () => '0x' + 'cd'.repeat(32) } }); await flush(); await flush(); },
        input: (sel, v) => { q(sel).value = v; },
        // the user is typing in the add-proxy form while the action runs
        typing: () => { const i = q('#proxy-add-delegate'); i.focus(); i.value = 'esTyped'; i.setSelectionRange(3, 3); return i; },
        kids: () => Array.from(doc.getElementById('wallet-dashboard').children),
        live: (ms) => timers.filter(tm => tm.live && (ms == null || tm.ms === ms)),
        // the core's next poll attempt (its back-off steps), run by hand
        // (every component's attempt due at the shortest step: they run together, as time passes for all of them)
        poll: async () => {
            const due = timers.filter(x => x.live && [2000, 4000, 8000, 16000, 30000].includes(x.ms));
            assert.ok(due.length, 'no poll armed');
            const step = Math.min(...due.map(x => x.ms));
            for (const tm of due.filter(x => x.ms === step)) { tm.live = false; tm.f(); }
            await flush(); await flush();
        },
        polling: () => timers.some(x => x.live && [2000, 4000, 8000, 16000, 30000].includes(x.ms)),
        // every watched section: a mutation recorder; seen() resolves to the names of the sections that changed
        observe() {
            const changed = new Set();
            const obs = [];
            const missing = [];
            for (const [name, sel] of Object.entries(SECTIONS)) {
                const el = q(sel);
                if (!el) { missing.push(sel); continue; }
                const mo = new win.MutationObserver((list) => { if (list.length) changed.add(name); });
                mo.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
                obs.push(mo);
            }
            return async () => {
                await flush();
                for (const mo of obs) mo.disconnect();
                assert.deepEqual(missing, [], 'sections without their own container on the page');
                return Array.from(changed).sort();
            };
        }
    };
    return p;
}
const IN_BLOCK = { type: 'InBlock', asInBlock: '0xb1' };
const no2500 = (p) => assert.ok(!p.timers.some(tm => tm.ms === 2500), 'a fixed 2.5 s dashboard reload is armed');
const sameKids = (before, after) => before.length === after.length && before.every((k, i) => k === after[i]);

// One action from the dashboard: the user's input, then the real submit function.
const ACTIONS = {
    send: async (p) => { p.input('#send-to-input', OTHER); p.input('#send-amount-input', '5'); await p.ctx.submitSendTx(); },
    unstake: async (p) => { p.input('#unstake-amount-input', '10'); await p.ctx.submitUnstakeTx(); },
    unstakeAll: async (p) => { p.glue.full(true, '450000000000000'); p.input('#unstake-amount-input', '450'); await p.ctx.submitUnstakeTx(); },
    withdraw: async (p) => { await p.ctx.submitWithdrawUnbonded(); },
    identitySet: async (p) => { p.input('#identity-display', 'New Name'); await p.ctx.submitSetIdentity(); },
    identityClear: async (p) => { await p.ctx.submitClearIdentity(); }
};
async function start(p, kind) {
    await ACTIONS[kind](p);
    await flush();
    assert.ok(p.log.built.length >= 1, `${kind}: nothing was built (${p.log.sendError || ''})`);
    await p.emit({ type: 'Ready' });
}

describe('R3: each wallet action repaints only what changed, in place', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });   // the tracker's own caps
    afterEach(() => mock.timers.reset());

    test('send: Total Balance at inclusion, Recent Transactions once indexed; nothing else; no remount; typed text and focus kept', async () => {
        const p = walletPage();
        await p.render();
        const typed = p.typing();
        const kids = p.kids();
        const seen = p.observe();
        const locks = p.log.locksMounts, noms = p.log.nominationMounts;
        await start(p, 'send');
        p.srv.head = 42;
        p.srv.state.balance = { free: 894.99, reserved: 100, total: 994.99, transferable: 394.99, transferableAllowDeath: 395.99 };
        await p.emit(IN_BLOCK, [ev('balances', 'Transfer', [ME, OTHER, '5000000000000']), success()]);
        assert.equal(t(p.q('#wallet-total-value')), '994.9900 PDEX', 'Total Balance did not follow the transfer at inclusion');
        assert.equal(p.q('#wallet-recent-tx-table').textContent, 'TABLE transactions 1', 'the list moved before the server indexed the transfer');
        p.srv.tx = 42;
        p.srv.state.recentTransactions = [{ hash: '0x' + 'bb'.repeat(32), block: 42, from: ME, to: OTHER, amount: '5 PDEX', timestamp: 10 }, ...p.srv.state.recentTransactions];
        await p.poll();
        assert.equal(p.q('#wallet-recent-tx-table').textContent, 'TABLE transactions 2', 'Recent Transactions did not follow once indexed');
        assert.equal(p.polling(), false, 'still polling after the server had the block');
        assert.ok(sameKids(kids, p.kids()), 'the dashboard was remounted');
        assert.deepEqual(await seen(), ['total', 'tx']);
        assert.equal(p.log.locksMounts, locks, 'the locks panel was remounted');
        assert.equal(p.log.nominationMounts, noms, 'the nominations card was re-read for a transfer');
        assert.ok(p.doc.activeElement === typed && typed.value === 'esTyped' && typed.selectionStart === 3, 'the add-proxy field lost its text, focus or caret');
        assert.deepEqual(p.log.scrolled.filter(([, y]) => y !== 0), [], 'the page jumped');
        no2500(p);
    });

    test('unstake (part): the page payload follows at inclusion; no section repaints because none shows a changed figure', async () => {
        const p = walletPage();
        await p.render();
        const kids = p.kids();
        const seen = p.observe();
        await start(p, 'unstake');
        p.srv.head = 42;
        p.srv.state.staking = { ...p.srv.state.staking, activeStaked: 440, unlocking: 60 };
        await p.emit(IN_BLOCK, [ev('staking', 'Unbonded', [ME, '10000000000000']), success()]);
        assert.equal(p.glue.data().staking.activeStaked, 440, 'the page kept the old bond (the Unstake dialog would offer it again)');
        assert.ok(sameKids(kids, p.kids()), 'the dashboard was remounted');
        assert.deepEqual(await seen(), []);
        assert.equal(p.q('#unstake-modal').style.display, 'none', 'the dialog stayed open');
        no2500(p);
    });

    test('unstake all (chill and unbond): Unstake closes with its title, My Validators and the nominations card follow; nothing else', async () => {
        const p = walletPage();
        await p.render();
        const kids = p.kids();
        const seen = p.observe();
        const noms = p.log.nominationMounts;
        await start(p, 'unstakeAll');
        p.srv.head = 42;
        p.srv.state.staking = { ...p.srv.state.staking, isNominator: false, activeStaked: 0, unlocking: 500, nominating: [] };
        await p.emit(IN_BLOCK, [ev('staking', 'Chilled', [ME]), ev('staking', 'Unbonded', [ME, '450000000000000']), ev('utility', 'BatchCompleted'), success()]);
        assert.equal(p.q('#wallet-act-unstake').disabled, true);
        assert.equal(p.q('#wallet-act-unstake').getAttribute('title'), 'No active bond to unstake.');
        assert.equal(t(p.q('#wallet-my-validators')), 'This wallet is not nominating any validators.');
        assert.equal(p.log.nominationMounts, noms + 1, 'the nominations card was not re-read');
        assert.ok(sameKids(kids, p.kids()), 'the dashboard was remounted');
        assert.deepEqual(await seen(), ['nominations', 'unstake', 'validators']);
        no2500(p);
    });

    test('withdraw unbonded: Total Staked follows at inclusion; nothing else', async () => {
        const p = walletPage();
        await p.render();
        const kids = p.kids();
        const seen = p.observe();
        await start(p, 'withdraw');
        p.srv.head = 42;
        p.srv.state.staking = { ...p.srv.state.staking, totalStaked: 450, unlocking: 0 };
        p.srv.state.balance = { ...p.srv.state.balance, transferable: 450 };
        await p.emit(IN_BLOCK, [ev('staking', 'Withdrawn', [ME, '50000000000000']), success()]);
        assert.equal(t(p.q('#wallet-staked-value')), '450.0000 PDEX');
        assert.ok(sameKids(kids, p.kids()), 'the dashboard was remounted');
        assert.deepEqual(await seen(), ['staked']);
        no2500(p);
    });

    test('set identity: the name shows at once from the block and stays while the server is behind; then the server agrees and the poll ends', async () => {
        const p = walletPage();
        await p.render();
        const kids = p.kids();
        const seen = p.observe();
        p.srv.gate = new Promise(() => {});   // no server answer yet: what shows comes from the block
        await start(p, 'identitySet');
        await p.emit(IN_BLOCK, [ev('identity', 'IdentitySet', [ME]), success()]);
        assert.equal(t(p.q('#wallet-head-name')), 'New Name', 'the name did not change at once');
        assert.equal(t(p.q('#wallet-act-identity strong')), 'Update identity');
        assert.equal(p.glue.data().identity, 'New Name', 'the identity dialog would still offer the old state');
        const w2 = walletPage();   // the same story with a server that answers, behind and then caught up
        await w2.render();
        const seen2 = w2.observe();
        await start(w2, 'identitySet');
        w2.srv.head = 42;   // chain read at the block, identity index (indexed.chain) behind: the old name
        await w2.emit(IN_BLOCK, [ev('identity', 'IdentitySet', [ME]), success()]);
        assert.equal(t(w2.q('#wallet-head-name')), 'New Name', 'an older server copy took the name back');
        assert.ok(w2.polling(), 'the identity is not polled until the server has the block');
        w2.srv.chain = 42; w2.srv.state.identity = 'New Name';
        await w2.poll();
        assert.equal(t(w2.q('#wallet-head-name')), 'New Name');
        assert.equal(w2.polling(), false, 'still polling after the server had the block');
        assert.deepEqual(await seen2(), ['head', 'identityBtn']);
        assert.ok(sameKids(kids, p.kids()), 'the dashboard was remounted');
        assert.deepEqual(await seen(), ['head', 'identityBtn']);
        no2500(p); no2500(w2);
    });

    test('clear identity: the name goes at once (My Account), the button says Set identity', async () => {
        const p = walletPage();
        p.srv.state.identity = 'Alice Node';
        await p.render();
        const seen = p.observe();
        await start(p, 'identityClear');
        p.srv.head = 42;
        await p.emit(IN_BLOCK, [ev('identity', 'IdentityCleared', [ME, '1000']), success()]);
        assert.equal(t(p.q('#wallet-head-name')), 'My Account');
        assert.equal(t(p.q('#wallet-act-identity strong')), 'Set identity');
        assert.deepEqual(await seen(), ['head', 'identityBtn']);
        no2500(p);
    });

    test('remove a proxy: the row settles with its word at once (the server still lists it), then leaves; the add-proxy form keeps its text', async () => {
        const p = walletPage();
        await p.render();
        const typed = p.typing();
        const seen = p.observe();
        p.q('.proxy-remove-btn').click();
        await flush();
        assert.equal(p.log.built.at(-1).name, 'proxy.removeProxy');
        await p.emit({ type: 'Ready' });
        await p.emit(IN_BLOCK, [ev('proxy', 'ProxyRemoved', [ME, V3, 'Staking', 0]), success()]);
        const chip = p.q('#wallet-proxy-list .ui-chip.is-positive');
        assert.ok(chip, 'the removed row does not settle');
        assert.equal(t(chip), STRINGS.S5.replace('{n}', '42'));
        assert.equal(p.q('#wallet-proxy-list .proxy-remove-btn'), null, 'the removed row still offers Remove');
        const hold = p.live(REFRESH_UI.settleHoldMs);
        assert.equal(hold.length, 1, 'no settle hold armed');
        hold[0].live = false; hold[0].f(); await flush();
        assert.equal(t(p.q('#wallet-proxy-list')), 'No proxies set. Use the form below to add one.', 'the proven-removed row came back from the older server copy');
        assert.ok(p.doc.activeElement === typed && typed.value === 'esTyped', 'the add-proxy form lost what was typed');
        assert.deepEqual(await seen(), ['proxies']);
        no2500(p);
    });

    test('add a proxy: the list shows the new row when the server has the block; only the delegate field is cleared', async () => {
        const p = walletPage();
        await p.render();
        const seen = p.observe();
        const fields = [p.q('#proxy-add-delegate'), p.q('#proxy-add-type'), p.q('#proxy-add-delay')];
        p.q('#proxy-add-delegate').value = V2;
        p.q('#proxy-add-type').value = 'Staking';
        p.q('#proxy-add-delay').value = '7';
        p.q('#proxy-add-submit').click();
        await flush();
        assert.equal(p.log.built.at(-1).name, 'proxy.addProxy');
        await p.emit({ type: 'Ready' });
        p.srv.head = 42;
        p.srv.proxies = [...p.srv.proxies, { delegate: V2, proxyType: 'Staking', delay: 7 }];
        await p.emit(IN_BLOCK, [ev('proxy', 'ProxyAdded', [ME, V2, 'Staking', 7]), success()]);
        assert.equal(p.doc.querySelectorAll('#wallet-proxy-list tbody tr').length, 2, 'the new proxy is not listed');
        assert.equal(p.q('#proxy-add-delegate').value, '');
        assert.equal(p.q('#proxy-add-type').value, 'Staking');
        assert.equal(p.q('#proxy-add-delay').value, '7', 'a field that was not cleared before is cleared now');
        assert.equal(p.polling(), false);
        // the form's own Add proxy button goes busy and back (the tracker); its fields are the same nodes, never repainted
        assert.deepEqual(await seen(), ['proxies', 'proxyForm']);
        assert.ok(fields.every((f, i) => f === [p.q('#proxy-add-delegate'), p.q('#proxy-add-type'), p.q('#proxy-add-delay')][i]), 'the add-proxy form was repainted');
        no2500(p);
    });
});

describe('R3: nothing changes without proof, and nothing of another account or an older copy', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    for (const [name, status, events] of [
        ['failed in its block', IN_BLOCK, [failed()]],
        ['dropped', { type: 'Dropped' }, null], ['usurped', { type: 'Usurped' }, null], ['invalid', { type: 'Invalid' }, null]
    ]) {
        for (const kind of ['send', 'identitySet', 'withdraw']) {
            test(`${kind}, ${name}: no re-read, no section touched, nothing recorded`, async () => {
                const p = walletPage();
                await p.render();
                const seen = p.observe();
                const reads = p.log.walletReads;
                await start(p, kind);
                p.srv.head = 42;
                p.srv.state.balance = { ...p.srv.state.balance, total: 1, transferable: 0 };
                p.srv.state.identity = 'Somebody Else';
                await p.emit(status, events);
                assert.equal(p.log.walletReads, reads, 'the dashboard was re-read for a transaction that did nothing');
                assert.deepEqual(await seen(), []);
                assert.equal(p.glue.known.list('identity', ME).length, 0);
                no2500(p);
            });
        }
    }

    test('a replaced block (Retracted) takes the name back; back in a block it shows again', async () => {
        const p = walletPage();
        await p.render();
        p.srv.gate = new Promise(() => {});
        await start(p, 'identitySet');
        await p.emit(IN_BLOCK, [ev('identity', 'IdentitySet', [ME]), success()]);
        assert.equal(t(p.q('#wallet-head-name')), 'New Name');
        await p.emit({ type: 'Retracted' }, null);
        assert.equal(t(p.q('#wallet-head-name')), 'My Account', 'a withdrawn block still shows its name');
        assert.equal(t(p.q('#wallet-act-identity strong')), 'Set identity');
        await p.emit({ type: 'InBlock', asInBlock: '0xb2' }, [ev('identity', 'IdentitySet', [ME]), success()]);
        assert.equal(t(p.q('#wallet-head-name')), 'New Name');
    });

    test('a wallet switch during the wait: the old account\'s answer is never drawn on the new account', async () => {
        const p = walletPage();
        await p.render();
        let release;
        p.srv.gate = new Promise(r => { release = r; });
        await start(p, 'send');
        p.srv.head = 42;
        p.srv.state.balance = { ...p.srv.state.balance, total: 994.99, transferable: 394.99 };
        await p.emit(IN_BLOCK, [ev('balances', 'Transfer', [ME, OTHER, '5000000000000']), success()]);
        // the user switches to OTHER (onWalletChanged clears the page's data), and OTHER's dashboard is drawn
        p.srv.connected = OTHER;
        p.glue.setData(null);
        p.ctx.walletFetchGen++;
        p.ctx.renderWalletDashboard({ ...base(), address: OTHER, identity: 'Other Account', balance: { free: 7, reserved: 0, total: 7, transferable: 7 } }, { history: [], configured: false }, null);
        await flush();
        const seen = p.observe();
        release();
        await flush(); await flush();
        assert.equal(t(p.q('#wallet-total-value')), '7.0000 PDEX', 'the old account\'s balance was drawn on the new account');
        assert.equal(t(p.q('#wallet-head-name')), 'Other Account');
        assert.deepEqual(await seen(), []);
    });

    test('an older server copy (a node behind the one already drawn) is not drawn over the newer one', async () => {
        const p = walletPage();
        await p.render();
        await start(p, 'send');
        p.srv.head = 42;
        p.srv.state.balance = { ...p.srv.state.balance, total: 994.99, transferable: 394.99 };
        await p.emit(IN_BLOCK, [ev('balances', 'Transfer', [ME, OTHER, '5000000000000']), success()]);
        assert.equal(t(p.q('#wallet-total-value')), '994.9900 PDEX');
        p.srv.head = 40;   // the next answer comes from a node two blocks behind, before the transfer
        p.srv.state.balance = { ...p.srv.state.balance, total: 1000, transferable: 400 };
        await p.poll();
        assert.equal(t(p.q('#wallet-total-value')), '994.9900 PDEX', 'an older copy was drawn over the newer one');
    });
});

describe('R3 guards', () => {
    test('no fixed 2.5 s re-read of the dashboard or the proxy list is left in script.js', () => {
        const code = stripComments(SCRIPT).split('\n');
        const bad = [];
        SCRIPT.split('\n').forEach((l, i) => { if (/setTimeout\(\(\) => (refreshWalletDashboardFor|renderProxyList)\b/.test(l) && code.includes(l)) bad.push(`script.js:${i + 1}: ${l.trim()}`); });
        assert.equal(bad.length, 0, `fixed refresh timers left in script.js:\n${bad.join('\n')}`);
    });
    test('the action bar is bound by one delegated listener (no per-render binding of the five buttons)', () => {
        const body = bodyOf(SCRIPT, 'bindWalletActionHandlers');
        assert.match(body, /bindWalletActions\(document\.getElementById\('wallet-dashboard'\)/);
        assert.doesNotMatch(stripComments(SCRIPT), /(sendBtn|payoutBtn|unstakeBtn|identityBtn|stakeBtn)\.addEventListener\('click'/, 'a wallet action button is still bound per render');
    });
    test('the dashboard template lives in lib/wallet-sections.js: one copy of the action bar, and script.js shrank by at least 100 lines from 14,430', () => {
        const n = SCRIPT.split('\n').length - (SCRIPT.endsWith('\n') ? 1 : 0);
        assert.ok(n <= 14430 - 100, `script.js has ${n} lines (R3 budget: at most ${14430 - 100})`);
        assert.equal((stripComments(SCRIPT).match(/id="wallet-act-send"/g) || []).length, 0, 'the action bar markup is still in script.js');
    });
});

// The R3 review (Opus, money path), one block per finding. Each reproduces the finding on the page's own code.
const BLOCK_IDS = ['wallet-act-send', 'wallet-act-stake', 'wallet-act-payout', 'wallet-act-unstake', 'wallet-act-identity'];
const BLOCKED = /^Balances could not be refreshed/;
const barButtons = (p) => BLOCK_IDS.map(id => p.doc.getElementById(id)).filter(Boolean);
const allClosed = (p, why) => {
    const btns = barButtons(p);
    assert.ok(btns.length >= 4, `the action bar is not on the page (${btns.length} buttons)`);
    for (const b of btns) assert.ok(b.disabled && BLOCKED.test(b.getAttribute('title') || ''), `${why}: ${b.id} is open (disabled ${b.disabled}, title ${b.getAttribute('title')})`);
};
const banner = (p) => p.q('#wallet-stale-banner.is-error');
// The sends of the race: what the inclusion at #42 proves, and how the page shows it.
const RACE = {
    send: { change: (s) => { s.balance = { free: 894.99, reserved: 100, total: 994.99, transferable: 394.99, transferableAllowDeath: 395.99 }; },
        events: [ev('balances', 'Transfer', [ME, OTHER, '5000000000000']), success()],
        shown: (p) => [t(p.q('#wallet-total-value')), p.glue.data().balance.transferable], after: ['994.9900 PDEX', 394.99] },
    unstake: { change: (s) => { s.staking = { ...s.staking, activeStaked: 440, unlocking: 60 }; },
        events: [ev('staking', 'Unbonded', [ME, '10000000000000']), success()],
        shown: (p) => [p.glue.data().staking.activeStaked], after: [440] },
    withdraw: { change: (s) => { s.staking = { ...s.staking, totalStaked: 450, unlocking: 0 }; s.balance = { ...s.balance, transferable: 450 }; },
        events: [ev('staking', 'Withdrawn', [ME, '50000000000000']), success()],
        shown: (p) => [t(p.q('#wallet-staked-value')), p.glue.data().balance.transferable], after: ['450.0000 PDEX', 450] }
};

describe('R3 review 1 (HIGH): an older full load in flight is not drawn over the newer copy the sections drew', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    for (const kind of Object.keys(RACE)) {
        test(`${kind}: a session-restore load answered at #40 lands after the sections drew #42: nothing older is drawn`, async () => {
            const p = walletPage();
            await p.render();
            let release;
            p.srv.gate = new Promise(r => { release = r; });
            p.srv.head = 40;   // the full load is answered by a node behind, before the action
            const full = p.ctx.refreshWalletDashboardFor(ME);
            await flush();
            p.srv.gate = null;
            await start(p, kind);
            p.srv.head = 42;
            RACE[kind].change(p.srv.state);
            await p.emit(IN_BLOCK, RACE[kind].events);
            assert.deepEqual(RACE[kind].shown(p), RACE[kind].after, 'the sections did not draw #42');
            release();
            await flush(); await full;
            assert.deepEqual(RACE[kind].shown(p), RACE[kind].after, 'the older full load was drawn over the newer copy');
        });
    }

    test('send: a cold load (snapshot on screen) answered at #40 lands after the sections drew #42: nothing older is drawn', async () => {
        const p = walletPage();
        p.ctx.readWalletCache = () => ({ wallet: { ...base(), freshness: { v: 1, chainHead: 39 } }, savedAt: 1 });
        let release;
        p.srv.gate = new Promise(r => { release = r; });
        p.srv.head = 40;
        const full = p.ctx.refreshWalletDashboardFor(ME);
        await flush();
        assert.equal(t(p.q('#wallet-total-value')), '1000.0000 PDEX', 'the snapshot was not painted');
        p.srv.gate = null;
        await start(p, 'send');
        p.srv.head = 42;
        RACE.send.change(p.srv.state);
        await p.emit(IN_BLOCK, RACE.send.events);
        assert.deepEqual(RACE.send.shown(p), RACE.send.after, 'the sections did not draw #42');
        release();
        await flush(); await full;
        assert.deepEqual(RACE.send.shown(p), RACE.send.after, 'the older full load was drawn over the newer copy');
    });

    test('a full render sets what is drawn: a later quiet copy newer than it is drawn, even when an earlier render was newer still', async () => {
        const p = walletPage();
        p.srv.head = 50;
        await p.render();   // an earlier visit at #50
        p.srv.head = 45;
        await p.render();   // the dashboard drawn again from a copy at #45 (no snapshot)
        await start(p, 'send');
        p.srv.head = 46;
        RACE.send.change(p.srv.state);
        await p.emit(IN_BLOCK, RACE.send.events);
        assert.deepEqual(RACE.send.shown(p), RACE.send.after, 'a copy newer than the one on screen was dropped');
    });

    test('guard: a snapshot is not evidence: a live copy behind the snapshot\'s head is still drawn', async () => {
        const p = walletPage();
        p.ctx.readWalletCache = () => ({ wallet: { ...base(), balance: { ...base().balance, total: 2000 }, freshness: { v: 1, chainHead: 45 } }, savedAt: 1 });
        p.srv.head = 44;
        await p.ctx.refreshWalletDashboardFor(ME);
        await flush();
        assert.equal(t(p.q('#wallet-total-value')), '1000.0000 PDEX', 'the live copy was not drawn over the snapshot');
    });
});

describe('R3 review 2 (HIGH) and 3 (MEDIUM): a failed section re-read blocks signing, a drawn read unblocks it', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());
    const failSend = async (p) => {
        await start(p, 'send');
        p.srv.fail = 'node down';
        p.srv.head = 42;
        await p.emit(IN_BLOCK, RACE.send.events);
    };

    test('guard (2): a failed re-read shows the stale banner and closes every signing button', async () => {
        const p = walletPage({ realBlock: true });
        await p.render();
        await failSend(p);
        assert.ok(banner(p), 'no stale banner after a failed re-read');
        assert.match(t(banner(p)), /node down/);
        allClosed(p, 'after a failed re-read');
    });

    test('guard (2, and 3 for a newer copy): a later read that is drawn clears the banner and re-opens the buttons', async () => {
        const p = walletPage({ realBlock: true });
        await p.render();
        await failSend(p);
        allClosed(p, 'after a failed re-read');
        p.srv.fail = null;
        RACE.send.change(p.srv.state);
        await p.poll();
        assert.equal(banner(p), null, 'the banner stayed after a drawn read');
        assert.equal(t(p.q('#wallet-total-value')), '994.9900 PDEX');
        for (const id of ['wallet-act-send', 'wallet-act-unstake', 'wallet-act-identity']) {
            const b = p.doc.getElementById(id);
            assert.ok(!b.disabled && !BLOCKED.test(b.getAttribute('title') || ''), `${id} stayed closed after a drawn read`);
        }
    });

    test('guard (2): the block is applied again after every repaint of the bar (a name from another tab, a full render)', async () => {
        const p = walletPage({ realBlock: true });
        await p.render();
        await failSend(p);
        allClosed(p, 'after a failed re-read');
        p.glue.known.add([{ account: ME, domain: 'identity', op: 'set', key: 'name', value: 'From Another Tab', block: 99, txHash: '0x' + 'ef'.repeat(32) }]);
        await flush();
        assert.equal(t(p.q('#wallet-act-identity strong')), 'Update identity', 'the bar was not synced (this test proves nothing)');
        allClosed(p, 'after the bar was synced');
        await p.render();
        allClosed(p, 'after a full render');
    });

    test('3: a failed read, then a copy from a node behind the one drawn: the banner stays and every button stays closed (no silent block)', async () => {
        const p = walletPage({ realBlock: true });
        await p.render();   // drawn at #41
        await failSend(p);
        p.srv.fail = null;
        p.srv.head = 40;
        RACE.send.change(p.srv.state);
        await p.poll();
        assert.equal(t(p.q('#wallet-total-value')), '1000.0000 PDEX', 'the older copy was drawn');
        assert.ok(banner(p), 'the buttons are closed with no banner to say why');
        allClosed(p, 'after an older copy');
    });

    test('guard (3): a failed read, then the same copy again: the banner goes and the buttons re-open', async () => {
        const p = walletPage({ realBlock: true });
        await p.render();
        await failSend(p);
        p.srv.fail = null;   // the server answers at #42 with nothing changed (it has not indexed the transfer)
        await p.poll();
        assert.equal(banner(p), null, 'the banner stayed after a drawn read');
        for (const id of ['wallet-act-send', 'wallet-act-unstake', 'wallet-act-identity']) {
            const b = p.doc.getElementById(id);
            assert.ok(!b.disabled && !BLOCKED.test(b.getAttribute('title') || ''), `${id} stayed closed with no banner`);
        }
    });
});

describe('R3 review 4 (LOW) and 5 (LOW): the proxy list', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('4: the same delegate and type at two delays: only the row removed (its delay) settles; the other keeps Remove', async () => {
        const p = walletPage();
        p.srv.proxies = [{ delegate: V3, proxyType: 'Staking', delay: 0 }, { delegate: V3, proxyType: 'Staking', delay: 7 }];
        await p.render();
        await flush();
        p.q('.proxy-remove-btn[data-delay="7"]').click();
        await flush();
        assert.deepEqual(p.log.built.at(-1).args, [V3, 'Staking', 7]);
        await p.emit({ type: 'Ready' });
        await p.emit(IN_BLOCK, [ev('proxy', 'ProxyRemoved', [ME, V3, 'Staking', 7]), success()]);
        const rows = Array.from(p.doc.querySelectorAll('#wallet-proxy-list tbody tr'));
        assert.equal(rows.length, 2);
        assert.ok(rows[1].querySelector('.ui-chip.is-positive'), 'the removed row (delay 7) does not settle');
        assert.ok(rows[0].querySelector('.proxy-remove-btn[data-delay="0"]'), 'the row at delay 0, still on chain, lost its Remove button');
        assert.equal(rows[0].querySelector('.ui-chip'), null, 'the row at delay 0 says it was removed');
    });

    test('5: the settle hold does not draw the last list over the error a failed re-read drew', async () => {
        const p = walletPage();
        p.ctx.renderApiError = (el, e) => { el.innerHTML = `<div class="api-error">Error: ${e.message}</div>`; };
        await p.render();
        p.q('.proxy-remove-btn').click();
        await flush();
        await p.emit({ type: 'Ready' });
        await p.emit(IN_BLOCK, [ev('proxy', 'ProxyRemoved', [ME, V3, 'Staking', 0]), success()]);
        assert.ok(p.q('#wallet-proxy-list .ui-chip.is-positive'), 'the removed row does not settle');
        p.srv.proxyFail = 'proxies down';
        await p.poll();
        assert.equal(t(p.q('#wallet-proxy-list')), 'Error: proxies down', 'the failed re-read drew no error');
        const hold = p.live(REFRESH_UI.settleHoldMs);
        assert.equal(hold.length, 1, 'no settle hold armed');
        hold[0].live = false; hold[0].f(); await flush();
        assert.equal(t(p.q('#wallet-proxy-list')), 'Error: proxies down', 'the settle hold drew the last list over the error');
    });
});
