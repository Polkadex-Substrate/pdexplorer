// Characterisation of My Account's dashboard BEFORE sprint R3 moves its template out of script.js (design
// cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 6 and 9 "R3"). Committed green against the code as it
// was, and left untouched by the move: the move must draw the same page.
//
// The real renderWalletDashboard, bindWalletActionHandlers and buildWalletActionBarMarkup run over happy-dom with the
// real payout and stake parts (lib/payout-refresh.js, lib/stake-refresh.js, created by script.js's own lines) and the
// real post-action core. What is pinned, per account fixture: the text and order of each section, the summary tiles,
// the action bar's buttons with their labels, enabled states and titles, and that each button opens its dialog.
// Helpers that draw other cards are stubs that leave a fixed mark. Lines and functions the move adds
// (lib/wallet-sections.js, the walletSections line, the table mounts) are given to the render when present.
// Addresses are the public substrate dev accounts (test/helpers/payout-events.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { readRepo, bodyOf } from './helpers/source.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs, samePayload } from '../lib/freshness.js';
import * as payoutRefreshModule from '../lib/payout-refresh.js';
import * as stakeRefreshModule from '../lib/stake-refresh.js';
import { escapeHtml } from '../lib/html-escape.js';
import { ME, OTHER, V1, V2 } from './helpers/payout-events.js';

const SCRIPT = readRepo('script.js', import.meta.url);
// Present only after the move.
const sectionsModule = await import('../lib/wallet-sections.js').then((m) => m, () => ({}));
const line = (start) => { const i = SCRIPT.indexOf(start); return i < 0 ? '' : SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
const lift = (name) => { const at = SCRIPT.indexOf(`function ${name}(`); if (at < 0) return ''; return (SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '') + bodyOf(SCRIPT, name); };
const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

function page({ connected = ME, injected = true } = {}) {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    doc.body.innerHTML = '<div id="wallet-dashboard"></div>';
    const opened = [];
    const mark = (name) => (el) => { if (el) el.innerHTML = `<p>${name}</p>`; };
    const ctx = {
        console, Promise, Object, JSON, Array, Map, Set, WeakMap, WeakSet, String, Number, Math, Date, encodeURIComponent,
        window: win, document: doc, navigator: { clipboard: { writeText: async () => {} } },
        setTimeout: () => 0, clearTimeout: () => {},
        globalApi: null, VALIDATE_ON: false, walletAprData: null, walletFetchGen: 0, walletRecentStore: { address: null, rows: [], next: null },
        walletActionsBlockedReason: null,
        createKnownResults, createPostAction, effectsFor, caughtUp, pollDeadlineMs, samePayload, ...payoutRefreshModule, ...stakeRefreshModule, ...sectionsModule,
        getStoredWallet: () => connected, isSameAddress: (x, y) => x === y, multisigStore: { find: () => null },
        hasInjectedWalletNow: () => injected,
        stakingFormatPDEX: (v) => Number(v || 0).toFixed(4), stakingFormatNumber: (n) => (n == null ? '-' : String(n)),
        stakingShortAddress: (x) => String(x).slice(0, 6) + '...', stakingEscapeHtml: escapeHtml,
        helpIcon: () => '<span class="help">?</span>', rewardHistoryLinkHtml: (a) => `<a class="wallet-history-link" href="/staking-rewards/${a}">Full reward history</a>`,
        walletViewingSlotHtml: () => '<p>VIEWING</p>', renderUsdSubscript: (n) => `$${Number(n || 0).toFixed(2)}`,
        buildViewOnlyCallout: () => '<div class="wallet-readonly-callout">READ-ONLY</div>', formatDuration: (ms) => (ms == null ? '-' : `${ms / 3600000}h`),
        formatLocalDate: (x) => `D${x}`, looksLikeTxHash: () => true,
        getStakeableBalance: (d) => Number((d.balance || {}).transferable || 0),
        makeTable: (cfg) => { cfg.container.innerHTML = `<p>TABLE ${cfg.summarySuffix} ${cfg.rows.length}: ${cfg.rows.map(r => cfg.columns.map(c => (c.format ? c.format(r) : r[c.key])).join('/')).join(' | ')}</p>`; return { getState: () => ({}) }; },
        mountWalletRecentTx: ({ data, buildTable }) => buildTable((data.recentTransactions || []).map(r => ({ ...r, direction: r.from === data.address ? 'Sent' : 'Received' }))),
        fetchApiJson: async () => ({}), bindViewOnlyCalloutHandlers() {}, applyWalletActionBlock() {}, scheduleWalletSigningRechecks() {},
        mountBalanceLocks: mark('LOCKS'), lockActionDeps: () => ({}), mountNominationStatus: mark('NOMINATIONS'),
        renderWalletAdvancedSection: () => mark('ADVANCED')(doc.getElementById('wallet-advanced-section')),
        refreshWalletMultisigs() {}, renderWalletAprCard: () => mark('APR')(doc.getElementById('wallet-apr-body')),
        renderWalletPriceChart() {}, readWalletValidator: () => Promise.resolve(null), walletValidatorCard: () => '',
        readStakeFigures: async () => { throw new Error('no chain'); },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        openSendModal: () => opened.push('send'), openStakeModal: () => opened.push('stake'), openPayoutModal: () => opened.push('payout'),
        openUnstakeModal: () => opened.push('unstake'), openIdentityModal: () => opened.push('identity'), openWalletPicker() {}, disconnectWallet() {}
    };
    vm.createContext(ctx);
    const src = [
        'let currentWalletData = null, stakeCard = null;',
        line('const knownResults = createKnownResults('), line('const postAction = createPostAction('), line('const payoutRefresh = createPayoutRefresh('),
        line('const stakeRefresh = createStakeRefresh('), line('const walletSections = createWalletSections('),
        lift('renderWalletDashboard'), lift('bindWalletActionHandlers'), lift('buildWalletActionBarMarkup'), lift('mountWalletNominations'),
        lift('mountWalletRewardsTable'), lift('mountWalletTxTable'),
        'globalThis.__render = renderWalletDashboard;'
    ].join('\n');
    vm.runInContext(src, ctx);
    return { doc, opened, render: (d) => ctx.__render(d, { history: [], configured: false, latest: { price: 2 } }, null) };
}

const NETWORK = { minStake: 50, activeNominators: 10, totalNominators: 20, activeValidators: 5, totalValidators: 7, eraDurationMs: 86400000, unbondingMs: 2419200000, currentEra: 900 };
const staker = (over = {}) => ({
    address: ME, identity: 'Alice Node', price: { price: 2 },
    balance: { free: 900, reserved: 100, total: 1000, transferable: 400, transferableAllowDeath: 401 },
    staking: { isStaker: true, isNominator: true, totalStaked: 500, activeStaked: 450, unlocking: 50, ledgerRead: 'ok', nominating: [{ address: V1, name: 'Val One' }, { address: V2, name: null }] },
    rewards: { claimedTotal: 12.5, unpaidTotal: 3.75, unpaidCount: 2, unclaimedFresh: true, unpaidEntries: [{ era: 801, validator: V1, amount: 1.5 }, { era: 802, validator: V2, amount: 2.25 }],
        recentClaimed: [{ era: 800, amount: 1.25, timestamp: 7 }, { era: 799, amount: 1, timestamp: 6 }] },
    recentTransactions: [{ hash: '0xaa', block: 5, from: ME, to: OTHER, amount: '3 PDEX', timestamp: 9 }],
    network: NETWORK, ...over
});
const empty = () => ({ address: ME, identity: 'Unknown', balance: { free: 0, reserved: 0, total: 0, transferable: 0 },
    staking: { totalStaked: 0, activeStaked: 0, ledgerRead: 'ok', nominating: [] },
    rewards: { claimedTotal: 0, unpaidTotal: 0, unpaidCount: 0, unclaimedFresh: false, unpaidEntries: [], recentClaimed: [] }, recentTransactions: [], network: NETWORK });

function signature(doc) {
    const root = doc.getElementById('wallet-dashboard');
    const firstHeader = root.querySelector('.list-header');
    const slot = root.querySelector('#wallet-actions-slot');
    const ORDER = ['wallet-viewing-slot', 'wallet-actions-slot', 'wallet-locks-slot', 'wallet-nominations-slot', 'wallet-multisig-slot', 'wallet-validator-slot',
        'wallet-price-chart-wrap', 'wallet-my-validators', 'wallet-recent-rewards-table', 'wallet-apr-card', 'wallet-recent-tx-table', 'wallet-advanced-section'];
    const all = Array.from(root.querySelectorAll('[id]')).map(e => e.id);
    return {
        heading: t(firstHeader.querySelector('h2')),
        headLinks: Array.from(firstHeader.querySelectorAll('a, button')).map(b => `${b.id || b.className}${b.hidden ? ':hidden' : ''}=${t(b)}`),
        address: t(root.querySelector('a.item-link[href^="/account/"]')),
        tiles: Array.from(root.querySelectorAll('.staking-summary-grid > .staking-summary-card')).map(c => `${t(c.querySelector('.label'))} = ${t(c.querySelector('.value'))}${c.querySelector('.value-usd') ? ' ' + t(c.querySelector('.value-usd')) : ''}`),
        actions: slot ? (slot.querySelector('#wallet-action-bar') ? Array.from(slot.querySelectorAll('#wallet-action-bar > button')).map(b => ({ id: b.id, label: `${t(b.querySelector('strong'))} | ${t(b.querySelector('span'))}`, disabled: !!b.disabled, title: b.getAttribute('title'), aria: b.getAttribute('aria-disabled') })) : t(slot)) : null,
        order: ORDER.filter(id => all.includes(id)),
        headings: Array.from(root.querySelectorAll('.list-header h2')).map(t),
        network: Array.from(root.querySelectorAll('.wallet-stat')).map(e => `${t(e.querySelector('span'))}: ${t(e.querySelector('strong'))}`),
        validators: `${t(root.querySelector('#wallet-my-validators-count'))}: ${t(root.querySelector('#wallet-my-validators'))}`,
        rewards: t(root.querySelector('#wallet-recent-rewards-table')),
        tx: t(root.querySelector('#wallet-recent-tx-table')),
        slots: ['wallet-locks-slot', 'wallet-nominations-slot', 'wallet-apr-body', 'wallet-advanced-section'].map(id => `${id}=${t(doc.getElementById(id))}`),
        price: t(root.querySelector('#wallet-price-header-price'))
    };
}

const ORDER_FULL = ['wallet-viewing-slot', 'wallet-actions-slot', 'wallet-locks-slot', 'wallet-nominations-slot', 'wallet-multisig-slot', 'wallet-validator-slot',
    'wallet-price-chart-wrap', 'wallet-my-validators', 'wallet-recent-rewards-table', 'wallet-apr-card', 'wallet-recent-tx-table', 'wallet-advanced-section'];
const HEADINGS = ['Alice Node ?', 'PDEX Price (30d)', 'Network staking', 'My Validators', 'Recent Staking Rewards', 'Average APR', 'Recent Transactions'];
const NETWORK_TEXT = ['Minimum Stake: 50.0000 PDEX', 'Active Nominators: 10 / 20', 'Active Validators: 5 / 7', 'Staking Period (era): 24h', 'Unstaking Period: 672h', 'Current Era: 900'];
const SLOTS = ['wallet-locks-slot=LOCKS', 'wallet-nominations-slot=NOMINATIONS', 'wallet-apr-body=APR', 'wallet-advanced-section=ADVANCED'];

describe('My Account before the R3 move: the dashboard as drawn', () => {
    test('a connected staker with an identity, unpaid rewards and history', () => {
        const p = page();
        p.render(staker());
        const s = signature(p.doc);
        assert.equal(s.heading, 'Alice Node ?');
        assert.deepEqual(s.headLinks, ['wallet-history-link=Full reward history', 'wallet-switch-btn=Switch wallet', 'wallet-disconnect-btn=Disconnect']);
        assert.equal(s.address, ME);
        assert.deepEqual(s.tiles, ['Total Balance = 1000.0000 PDEX $1000.00', 'Total Staked = 500.0000 PDEX', 'Claimed Rewards = 12.5000 PDEX', 'Unpaid Rewards = 3.7500 PDEX']);
        assert.deepEqual(s.actions, [
            { id: 'wallet-act-send', label: 'Send PDEX | Transfer to any Polkadex address', disabled: false, title: null, aria: null },
            { id: 'wallet-act-stake', label: 'Stake more | Add to your stake or change validators', disabled: false, title: null, aria: null },
            { id: 'wallet-act-payout', label: 'Pay out rewards | 2 unclaimed entries', disabled: false, title: null, aria: null },
            { id: 'wallet-act-unstake', label: 'Unstake | Begin the unbonding period', disabled: false, title: null, aria: null },
            { id: 'wallet-act-identity', label: 'Update identity | Display name, email, twitter', disabled: false, title: null, aria: null }
        ]);
        assert.deepEqual(s.order, ORDER_FULL);
        assert.deepEqual(s.headings, HEADINGS);
        assert.deepEqual(s.network, NETWORK_TEXT);
        assert.equal(s.validators, '2 nominated: Val One ' + V2.slice(0, 6) + '...');
        assert.equal(s.rewards, 'TABLE rewards 2: 800/1.2500 PDEX/D7 | 799/1.0000 PDEX/D6');
        assert.equal(s.tx, 'TABLE transactions 1: 0xaa.../Sent/3 PDEX/D9');
        assert.equal(p.doc.querySelector('#wallet-recent-tx-table a').getAttribute('href'), '/tx/5/0xaa');
        assert.equal(p.doc.querySelector('a.item-link[href="/staking-rewards/' + ME + '"]').textContent, 'View all');
        assert.deepEqual(s.slots, SLOTS);
        assert.equal(s.price, '$2');
        // The ids other code paints by (the stake and payout parts, the price ticker, the APR card) and the links.
        for (const id of ['wallet-total-value', 'wallet-staked-label', 'wallet-staked-value', 'wallet-unpaid-tile', 'wallet-unpaid-label', 'wallet-unpaid-value',
            'wallet-action-bar', 'wallet-payout-why', 'wallet-price-header-price', 'wallet-apr-periods', 'wallet-apr-body', 'wallet-my-validators-count']) assert.ok(p.doc.getElementById(id), 'missing #' + id);
        assert.equal(p.doc.querySelector('#wallet-total-value + .value-usd').getAttribute('data-pdex-amount'), '1000');
        assert.equal(p.doc.querySelector('a.item-link[href="/account/' + ME + '"].is-inline').textContent, 'View all on the account page');
    });
    test('each action button opens its dialog; the payout button opens the payout list', () => {
        const p = page();
        p.render(staker());
        for (const id of ['wallet-act-send', 'wallet-act-stake', 'wallet-act-payout', 'wallet-act-unstake', 'wallet-act-identity']) p.doc.getElementById(id).click();
        assert.deepEqual(p.opened, ['send', 'stake', 'payout', 'unstake', 'identity']);
    });
    test('an empty account: Send, Unstake and Pay out are closed with their titles; Stake says Stake; no identity', () => {
        const p = page();
        p.render(empty());
        const s = signature(p.doc);
        assert.equal(s.heading, 'My Account ?');
        assert.deepEqual(s.tiles, ['Total Balance = 0.0000 PDEX $0.00', 'Total Staked = 0.0000 PDEX', 'Claimed Rewards = 0.0000 PDEX', 'Unpaid RewardsUpdating = 0.0000 PDEX'], 'fidelity review R4: the bare S1 mark in the label row (the label and its chip, read as text), not "computing..." in the value');
        assert.deepEqual(s.actions, [
            { id: 'wallet-act-send', label: 'Send PDEX | Transfer to any Polkadex address', disabled: true, title: 'No transferable balance available.', aria: null },
            { id: 'wallet-act-stake', label: 'Stake | Stake PDEX and earn rewards', disabled: false, title: null, aria: null },
            { id: 'wallet-act-payout', label: 'Pay out rewards | 0 unclaimed entries', disabled: true, title: 'No unclaimed rewards to pay out.', aria: null },
            { id: 'wallet-act-unstake', label: 'Unstake | Begin the unbonding period', disabled: true, title: 'No active bond to unstake.', aria: null },
            { id: 'wallet-act-identity', label: 'Set identity | Display name, email, twitter', disabled: false, title: null, aria: null }
        ]);
        assert.equal(s.validators, '0 nominated: This wallet is not nominating any validators.');
        assert.equal(s.rewards, 'TABLE rewards 0:');
        assert.equal(s.tx, 'TABLE transactions 0:');
        for (const id of ['wallet-act-send', 'wallet-act-payout', 'wallet-act-unstake']) p.doc.getElementById(id).click();
        assert.deepEqual(p.opened, [], 'a closed button opened its dialog');
    });
    test('another account viewed: no action bar, no Disconnect, the rest as drawn', () => {
        const p = page({ connected: OTHER });
        p.render(staker());
        const s = signature(p.doc);
        assert.equal(s.actions, null);
        assert.deepEqual(s.headLinks, ['wallet-history-link=Full reward history', 'wallet-switch-btn=Switch wallet']);
        assert.deepEqual(s.order, ORDER_FULL.filter(id => id !== 'wallet-actions-slot'));
        assert.deepEqual(s.tiles, ['Total Balance = 1000.0000 PDEX $1000.00', 'Total Staked = 500.0000 PDEX', 'Claimed Rewards = 12.5000 PDEX', 'Unpaid Rewards = 3.7500 PDEX']);
    });
    test('no wallet connected: Switch wallet is hidden and there is no action bar', () => {
        const p = page({ connected: null });
        p.render(staker());
        assert.deepEqual(signature(p.doc).headLinks, ['wallet-history-link=Full reward history', 'wallet-switch-btn:hidden=Switch wallet']);
        assert.equal(signature(p.doc).actions, null);
    });
    test('own account with no wallet injected: the read-only callout stands in the action slot', () => {
        const p = page({ injected: false });
        p.render(staker());
        assert.equal(signature(p.doc).actions, 'READ-ONLY');
    });
    test('a ledger that could not be read: Total Staked says so, Stake keeps Stake more', () => {
        const p = page();
        p.render(staker({ staking: { totalStaked: 0, activeStaked: 0, ledgerRead: 'failed', nominating: [] } }));
        const s = signature(p.doc);
        assert.equal(s.tiles[1], 'Total Staked = ' + stakeRefreshModule.stakedTileHtml({ staking: { ledgerRead: 'failed' } }, { pdex: String, esc: escapeHtml }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/^Total Staked /, ''));
        assert.equal(s.actions[1].label, 'Stake more | Add to your stake or change validators');
        assert.equal(s.actions[3].disabled, true);
    });
});
