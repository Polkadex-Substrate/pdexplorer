// Sprint 11 site sweep, WP2 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 2.2 P1 to P11, P15, P16, 2.3 rows
// I11 to I15, I17 to I30, I32, I36 to I44, I47, 3.3, 7 S1 to S7, and 6.2 T9, T11): the pages script.js draws, read back from
// the REAL page (test/helpers/full-page.js: index.html plus the real script.js in happy-dom, one child process per page,
// fetch answered by the scenario). Each pattern is asserted on a page that draws it: no colour written in markup by
// script.js, and the kit class present. Test names start with the pattern or row id, so a failure names its pattern.
//
// "Written by script.js": the page is loaded with tagStatic, which marks every element index.html draws (and its style)
// before script.js runs. index.html's own inline colours belong to WP3 and are not read here; an element with no mark, or
// a mark whose style has changed, was written by script.js.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { runPage, accountApi, ACCOUNT as ME, councilApi } from './helpers/head-page.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';
import { escapeHtml } from '../lib/html-escape.js';
import { panelHtml, icon } from '../lib/ui-parts.js';

const SRC = stripComments(readRepo('script.js', import.meta.url));
const O1 = encodeAddress(new Uint8Array(32).fill(21), 88), O2 = encodeAddress(new Uint8Array(32).fill(22), 88);
const A = encodeAddress(new Uint8Array(32).fill(31), 88), B = encodeAddress(new Uint8Array(32).fill(32), 88);
const H = '0x' + 'ab'.repeat(32);
const NOW = 1790000000000;
const FAR = Date.now() + 5 * 86400000;
const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
const docOf = (html) => {
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return win.document;
};
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
// Never hand a happy-dom node to assert.equal or deepEqual: a failing assertion inspects it, and that can exhaust memory.
const describeEl = (e) => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).trim().split(/\s+/).join('.') : ''} style="${e.getAttribute('style')}"> ${text(e).slice(0, 40)}`;
const colourStyle = (e) => e.hasAttribute('style') && COLOUR.test(';' + e.getAttribute('style'));
const written = (root) => Array.from(root.querySelectorAll('[style]')).filter(e => COLOUR.test(';' + e.getAttribute('style'))
    && (!e.hasAttribute('data-static') || e.getAttribute('style') !== e.getAttribute('data-static-style')));
const LABELS = { labels: [
    { signer: O1, label: 'Exchange wallet', score: 2, viewerVote: 0, reportCount: 0, vetoed: false, createdAt: 1700000000000 },
    { signer: O2, label: 'Old name', score: 0, viewerVote: 0, reportCount: 1, vetoed: true, createdAt: 1700000000000 },
    { signer: ME, label: 'My label', score: 1, viewerVote: 1, reportCount: 0, vetoed: false, createdAt: 1700000000000 }] };
const WALLET = { pdex_wallet_address: ME, pdex_wallet_source: 'polkadot-js' };
const tx = (hash, status, n) => ({ hash, block: 100 - n, from: A, to: B, amount: `${n}.0000 PDEX`, numericAmount: n, value: `$${n}`, timestamp: NOW, ...(status ? { status } : {}) });
const COUNCIL_MOTION = '0x' + '11'.repeat(32);
const councilWith = () => ({
    '/api/council': { members: [{ address: A, name: 'Alice' }], runnersUp: [{ address: B, name: 'Bob', stake: 5 }], candidates: [], desiredMembers: 3, termDuration: 100, blocksRemaining: 50, pallet: 'elections', collectivePallet: 'council', currentBlock: 100,
        motions: [{ hash: COUNCIL_MOTION, index: 0, threshold: 2, end: 200, ayes: [A], nays: [B], section: 'treasury', method: 'approveProposal', args: [] }],
        motionHistory: [{ hash: COUNCIL_MOTION, motionIndex: 0, proposer: A, proposerName: 'Alice', status: 'proposed', section: 'treasury', method: 'approveProposal' },
            { hash: '0x' + '22'.repeat(32), motionIndex: 1, proposer: B, proposerName: 'Bob', status: 'executed', section: 'treasury', method: 'rejectProposal' }] },
    '/api/technical-committee': { members: [{ address: B, name: 'Bob', isPrime: true }], motions: [], proposalCount: 3, motionHistory: [], collectivePallet: 'technicalCommittee' }
});

const SCENARIOS = {
    // lists
    'val-loading': { path: 'validators', api: { '/api/validators': { __hang: true } } },
    'val-sync': { path: 'validators', api: { '/api/validators': { status: 'Syncing', validators: [] } } },
    'val-error': { path: 'validators', api: { '/api/validators': { __throw: true } } },
    'val-ok': { path: 'validators', api: { '/api/validators': { status: 'Synced', totalCount: 3, stakeDataOk: true, validators: [
        { address: A, name: 'Alpha', totalStake: 1000, commission: 60, estimatedNominatorApy: 12.5, commissionHistory: { volatility: 'volatile', note: 'Changed 3 times', raisedRecently: false } },
        { address: B, name: 'Beta', totalStake: null, commission: 5, commissionHistory: { volatility: 'unknown' } },
        { address: O1, name: 'Gamma', totalStake: 5, commission: 1, commissionHistory: { volatility: 'stable', note: 'Never changed' } }] } } },
    'holders-ok': { path: 'holders', api: { '/api/holders': { status: 'Synced', holders: [{ rank: 1, address: A, name: 'Alice', balance: 1000, share: 1.5 }] } } },
    'holders-sync': { path: 'holders', api: { '/api/holders': { status: 'Syncing', holders: [] } } },
    'holders-error': { path: 'holders', api: { '/api/holders': { __throw: true } } },
    'txs-ok': { path: 'transactions', api: { '/api/transactions': { status: 'Synced', transactions: [tx(H, 'success', 1), tx('0x' + 'cd'.repeat(32), 'failed', 2), tx('0x' + 'ef'.repeat(32), null, 3)] } } },
    'txs-sync': { path: 'transactions', api: { '/api/transactions': { status: 'Syncing', transactions: [] } } },
    'txs-error': { path: 'transactions', api: { '/api/transactions': { __throw: true } } },
    'blocks-ok': { path: 'blocks', api: { '/api/blocks': { status: 'Synced', blocks: [
        { number: 100, hash: H, timestamp: NOW, authorAddress: A, authorName: 'Alice', extrinsicsCount: 2, eventsCount: 5 },
        { number: 99, hash: '0x' + 'cd'.repeat(32), timestamp: NOW, authorAddress: '', extrinsicsCount: null, eventsCount: null }] } } },
    'blocks-sync': { path: 'blocks', api: { '/api/blocks': { status: 'Syncing', blocks: [] } } },
    'blocks-error': { path: 'blocks', api: { '/api/blocks': { __throw: true } } },
    'events-ok': { path: 'events', api: { '/api/events': { status: 'Synced', events: [
        { block: 100, hash: '0xev-1', txHash: H, section: 'balances', method: 'Transfer', signerName: 'Alice', signerAddress: A, timestamp: NOW, status: 'success' },
        { block: 99, hash: '0xev-2', section: 'staking', method: 'Rewarded', signerName: 'Unknown', signerAddress: B, timestamp: NOW, status: 'unknown' }] } } },
    'events-sync': { path: 'events', api: { '/api/events': { status: 'Syncing', events: [] } } },
    'events-error': { path: 'events', api: { '/api/events': { __throw: true } } },
    // detail pages
    'tx-found': { path: 'tx/100/' + H, api: { '/api/extrinsic/': { hash: H, block: 100, correctedFrom: 98, event: 'balances.transfer', from: A, to: B, status: 'success', time: NOW, extrinsic: {}, events: [], call: null } } },
    'tx-failed': { path: 'tx/100/' + H, api: { '/api/extrinsic/': { hash: H, block: 100, event: 'balances.transfer', from: A, to: B, status: 'failed', time: NOW, extrinsic: {}, events: [] } } },
    'tx-notfound': { path: 'tx/100/' + H, api: { '/api/extrinsic/': { __status: 404, error: 'Extrinsic not found in block' } } },
    'tx-badhash': { path: 'tx/123/not-a-hash' },
    'block': { path: 'block/100', api: { '/api/block/': { hash: H, date: NOW, block: { header: { number: 100 }, extrinsics: [] } } } },
    'validator': { path: 'validator/' + A, clipboard: true, steps: [{ click: '#validator-details-container .js-copy-address' }, { dump: '#validator-details-container' }],
        api: { '/api/validator/': { address: A, controller: B, identity: 'Alpha', history: [{ era: 1, commission: 60, stake: 1000000, timestamp: NOW }, { era: 2, commission: 5, stake: 1000000, timestamp: NOW }],
            triggers: [{ era: 1, prevCommission: 5, newCommission: 60, timestamp: NOW }], nominators: [],
            scorecard: { totalEras: 30, activeEras: 10, activeEraRate: 0.3, avgCommission: 5, minCommission: 1, maxCommission: 60, commissionSpikeCount: 2, estimatedNominatorApy: 10 } } } },
    'account': { path: 'account/' + ME, clipboard: true, steps: [{ click: '#account-details-container .js-copy-address' }, { dump: '#account-details-container' }],
        api: { '/api/account/': { account: ME, display: 'Alice', balanceTotal: 1, balanceFree: 1, balanceReserved: 0, balanceFrozen: 0, roles: 'none', rank: '0', status: 'Synced', events: [],
            transactions: [{ hash: H, block: 1, from: A, to: ME, amount: '1.2345 PDEX', numericAmount: 1, value: '$1', timestamp: NOW, status: 'success', method: 'balances.transfer' }] } } },
    'labels-owner': { path: 'account/' + ME, api: { ...accountApi(), '/api/labels/': LABELS }, wallets: { 'polkadot-js': [ME] }, seed: { ...WALLET, pdex_discuss_session: JSON.stringify({ v: 3, token: 'tok', address: ME, expiresAt: FAR }) }, steps: [{ wait: 400 }] },
    'labels-out': { path: 'account/' + ME, api: { ...accountApi(), '/api/labels/': LABELS }, wallets: { 'polkadot-js': [ME] }, seed: WALLET, steps: [{ wait: 400 }] },
    // search
    'search-prompt': { path: 'search' },
    'search-nothing': { path: 'search', steps: [{ type: '#inline-search-input', value: 'zzzz' }, { click: '#inline-search-submit-btn' }, { dump: '#search-results-container' }] },
    'search-deep-fail': { path: 'search', api: { '/api/search/': { __status: 500, error: 'upstream down' } },
        steps: [{ type: '#inline-search-input', value: 'zzzz' }, { click: '#inline-search-submit-btn' }, { click: '#deep-search-btn' }, { dump: '#search-results-container' }] },
    'search-deep-ok': { path: 'search', api: { '/api/search/': { type: 'account', data: { address: A, name: 'Alice', balance: 1 } } },
        steps: [{ type: '#inline-search-input', value: 'zzzz' }, { click: '#inline-search-submit-btn' }, { click: '#deep-search-btn' }, { dump: '#search-results-container' }, { dump: '#deep-search-btn' }] },
    // staking rewards
    'rewards-ok': { path: 'staking-rewards/' + ME, api: { '/api/staking-rewards/': { address: ME, identity: 'Alice', summary: { claimedTotal: 12.5, unclaimedTotal: 3, totalRewards: 15.5 }, index: { backfillComplete: true },
        claimed: [{ era: 100, validator: O1, amount: 1.25, blockNumber: 10, timestamp: 1700000000000, claimed: true }], unclaimed: [{ era: 101, validator: O2, amount: 1, claimed: false }] } } },
    'rewards-empty': { path: 'staking-rewards/' + ME, api: { '/api/staking-rewards/': { address: ME, identity: 'Alice', summary: { claimedTotal: 0, unclaimedTotal: 0, totalRewards: 0 }, index: { backfillComplete: true }, claimed: [], unclaimed: [] } } },
    'rewards-error': { path: 'staking-rewards/' + ME, api: { '/api/staking-rewards/': { error: 'boom' } } },
    // other pages
    'analytics': { path: 'analytics', api: { '/api/analytics/snapshot': { lastSync: NOW, indexedBlocks: 10, indexedTransactions: 5, validatorCount: 3, totalValidators: 4, nominatorCount: 5, totalNominators: 6, activeEra: 9, totalStaked: 100, totalIssuance: 1000, stakingRatio: 0.1, countsReady: true },
        '/api/analytics/timeseries': { series: { txCount: [], txVolume: [], activeAddresses: [], blocks: [], avgExtrinsics: [], treasuryAwarded: [] } } } },
    'watch': { path: 'watchlist', seed: { pdex_watchlist_v1: JSON.stringify({ ['address:' + A]: { kind: 'address', id: A, label: 'Alice', addedAt: NOW } }) },
        steps: [{ click: '#watchlist-content .watchlist-star' }, { dump: '#watchlist-content' }] },
    'watch-empty': { path: 'watchlist' },
    'email-prefs': { path: 'email-preferences?token=tok', api: { '/api/email/preferences': { email: 'a@b.co', validators: [A], events: { commission: true } } } },
    'email-prefs-none': { path: 'email-preferences' },
    'brand': { path: 'brand' },
    'price': { path: 'price' },
    'tour': { path: '?tour=1', steps: [{ wait: 1000 }, { dump: '#onboarding-tour-modal' }, { click: '#onboarding-tour-next' }, { dump: '#onboarding-tour-modal' }] },
    // governance
    'discussions': { path: 'discussions', api: { '/api/discussions': { threads: [{ id: 7, kind: 'referendum', title: 'Ref 7', postCount: 2, closedReason: 'Closed', earlierPostCount: 3, lastPostAt: NOW }] } } },
    'thread': { path: 'discussions/7', api: { '/api/discussions/7': { thread: { id: 7, kind: 'referendum', title: 'Ref 7', status: 'open' }, posts: [] } } },
    'thread-error': { path: 'discussions/7', api: { '/api/discussions/7': { error: 'boom' } } },
    'democracy': { path: 'democracy', api: { '/api/democracy': { referenda: [], publicProposals: [], referendumCount: 0, status: 'Synced', currentBlock: 100, launchPeriod: 50 } },
        steps: [{ dump: '#democracy-content' }, { click: '[data-demtab="referenda"]' }, { dump: '#democracy-content' }, { click: '[data-demtab="proposals"]' }, { dump: '#democracy-content' }, { click: '[data-demtab="statistics"]' }, { dump: '#democracy-content' }] },
    'council': { path: 'council', api: councilWith() },
    'council-error': { path: 'council', api: { '/api/council': { __status: 500, error: 'x' }, '/api/technical-committee': { __status: 500, error: 'x' } } },
    'council-empty': { path: 'council', api: councilApi() },
    'treasury': { path: 'treasury', api: { '/api/treasury': { proposals: [], approvals: [], allProposals: [], spendableFunds: 1250, proposalCount: 87, status: 'Synced' } },
        steps: [{ click: '[data-treastab="proposals"]' }, { dump: '#treasury-content' }, { click: '[data-treastab="approved"]' }, { dump: '#treasury-content' }, { click: '[data-treastab="history"]' }, { dump: '#treasury-content' }] }
};

const R = {};
before(async () => {
    // Three pages at a time: each child holds the whole explorer in happy-dom (the sandbox has 4 GB and no swap).
    // The documents are parsed after the last child has answered: a happy-dom window open in this process while children run
    // was seen to leave a child's callback never called (the hook then ended with nothing left in the event loop).
    const queue = Object.entries(SCENARIOS), done = [];
    await Promise.all([0, 1, 2].map(async () => {
        while (queue.length) {
            const [k, s] = queue.shift();
            done.push([k, await runPage({ ...s, tagStatic: true, dumpHtml: true })]);
        }
    }));
    for (const [k, r] of done) R[k] = { r, doc: docOf(r.appHtml || ''), dumps: (r.dumps || []).map(d => (d ? docOf(d) : null)) };
}, { timeout: 560000 });

const root = (k, d) => { const x = d == null ? R[k].doc : R[k].dumps[d]; assert.ok(x, `${k}: no ${d == null ? 'page' : 'dump ' + d}`); return x; };
const one = (k, sel, d) => root(k, d).querySelector(sel);
const all = (k, sel, d) => Array.from(root(k, d).querySelectorAll(sel));
const need = (k, sel, d) => { const e = one(k, sel, d); assert.ok(e, `${k}: nothing matches ${sel}`); return e; };
const PG = Object.fromEntries(['holders', 'transactions', 'blocks', 'events', 'validators'].map(n => [n, `.page-section[data-page="${n}"]`]));
const S5 = 'This list could not be loaded. Reload to try again.';
const WAIT = { 'val-sync': 'Indexer is syncing data from Polkadex node, please wait…', 'holders-sync': 'Indexer is syncing data from Polkadex node, please wait…', 'txs-sync': 'Indexer is crawling historical blocks, please wait…', 'blocks-sync': 'Indexer is crawling historical blocks, please wait…', 'events-sync': 'Indexer is crawling historical events, please wait...' };

describe('T9: no colour written in markup by script.js, on every page that draws (spec 6.2)', () => {
    for (const k of Object.keys(SCENARIOS)) {
        test(`${k}: the page threw nothing and script.js wrote no colour, background or border`, () => {
            assert.deepEqual(R[k].r.errors, [], `the ${k} page threw`);
            const offs = [written(R[k].doc), ...R[k].dumps.filter(Boolean).map(written)].flat().map(describeEl);
            assert.deepEqual(offs, []);
        });
    }
});

describe('P1, P2, P3: list states are stateHtml (loading, wait, failed), with their icon, role and words', () => {
    test('P1 validators: the fetch in flight is .ui-state.is-loading, role=status, a spinner, the same words', () => {
        const s = all('val-loading', '.ui-state.is-loading').find(e => /Fetching from backend indexer/.test(text(e)));
        assert.ok(s, 'no .ui-state.is-loading');
        assert.equal(s.getAttribute('role'), 'status');
        assert.ok(s.querySelector('.bx-loader-alt.bx-spin'));
        assert.equal(text(s), 'Fetching from backend indexer…');
    });
    for (const k of Object.keys(WAIT)) {
        test(`P2 ${k}: "Indexer is syncing/crawling" is .ui-state.is-wait with a clock and the same words`, () => {
            const s = all(k, '.ui-state.is-wait').find(e => text(e) === WAIT[k]);
            assert.ok(s, `${k}: no .ui-state.is-wait with the words; found ${all(k, '.ui-state').map(text).join(' | ')}`);
            assert.equal(s.getAttribute('role'), 'status');
            assert.ok(s.querySelector('.bx-time-five'));
        });
    }
    for (const k of ['val-error', 'holders-error', 'txs-error', 'events-error', 'blocks-error']) {
        test(`P3 / S5, S6 ${k}: a list that could not be read is .ui-state.is-failed (amber, role=alert) reading "${S5}"`, () => {
            const s = all(k, '.ui-state.is-failed').find(e => text(e) === S5);
            assert.ok(s, `${k}: found ${all(k, '.ui-state').map(text).join(' | ')}`);
            assert.equal(s.getAttribute('role'), 'alert');
            assert.ok(s.querySelector('.bx-error'));
        });
    }
});

describe('I13, I17, P4, P6: the validators table', () => {
    test('I13 / S1: "HIGH RISK" is a chip, "High risk", with the error icon; no solid red .badge', () => {
        const chip = all('val-ok', '.ui-chip.is-error').find(e => /High risk/.test(text(e)));
        assert.ok(chip, 'no .ui-chip.is-error "High risk"');
        assert.ok(chip.querySelector('.bx-error-circle'));
        assert.equal(text(chip), 'High risk');
        assert.ok(!all('val-ok', '.badge').some(e => /HIGH RISK/i.test(text(e))), 'the solid red badge is still there');
    });
    test('I13: the commission note is .ui-caption, amber (.is-warn) only when volatile; unknown history is a plain caption', () => {
        const notes = all('val-ok', '.ui-caption').map(e => [text(e), e.classList.contains('is-warn')]);
        assert.deepEqual(notes.find(n => n[0] === 'Changed 3 times'), ['Changed 3 times', true]);
        assert.deepEqual(notes.find(n => n[0] === 'Never changed'), ['Never changed', false]);
        assert.deepEqual(notes.find(n => n[0] === 'history not yet indexed'), ['history not yet indexed', false]);
    });
    test('I17: a positive APY is .ui-positive; unavailable stake and a missing APY are .ui-quiet', () => {
        assert.ok(all('val-ok', '.ui-positive').length >= 1, 'no .ui-positive');
        assert.ok(all('val-ok', '.ui-quiet').some(e => text(e) === 'unavailable'), 'unavailable is not .ui-quiet');
        assert.ok(all('val-ok', '.ui-quiet').some(e => text(e) === '—'), 'the dash is not .ui-quiet');
    });
});

describe('I14, P6, I18, P9, P4: the status chips and the cells of the transaction, block, event and holder tables', () => {
    test('I14 transactions: Success, Failed and unknown are chips (is-positive, is-error, is-neutral) with their icons', () => {
        const chips = all('txs-ok', PG.transactions + ' tbody .ui-chip').map(e => [e.className.replace('ui-chip ', ''), text(e)]);
        assert.deepEqual(chips.sort(), [['is-error', 'Failed'], ['is-neutral', 'unknown'], ['is-positive', 'Success']]);
        assert.equal(all('txs-ok', '.ui-chip.is-positive .bx-check').length, 1);
        assert.equal(all('txs-ok', '.ui-chip.is-error .bx-x').length, 1);
        assert.match(need('txs-ok', '.ui-chip.is-neutral').getAttribute('title') || '', /dispatch result has not been read yet/);
    });
    test('P6 transactions: the date and the value are .ui-quiet', () => {
        const rows = all('txs-ok', PG.transactions + ' tbody tr');
        assert.ok(rows.length >= 3);
        assert.ok(rows[0].querySelectorAll('.ui-quiet').length >= 2, rows[0].innerHTML.slice(0, 600));
    });
    test('P6 blocks: age and date are .ui-quiet; an unknown author, extrinsic count and event count are a quiet dash', () => {
        const quiet = all('blocks-ok', PG.blocks + ' tbody .ui-quiet').map(text);
        assert.ok(quiet.filter(t => t === '—').length >= 3, quiet.join('|'));
        assert.ok(quiet.length >= 6, quiet.join('|'));
    });
    test('P9, P4, I14, P6 events: the tx link is a plain .item-link, the event id is .ui-caption, the status is a chip, the date is .ui-quiet', () => {
        const tx1 = all('events-ok', PG.events + ' tbody a.item-link').find(a => /^tx:/.test(text(a)));
        assert.ok(tx1 && !tx1.hasAttribute('style'));
        assert.ok(all('events-ok', PG.events + ' tbody .ui-caption').some(e => /^event:/.test(text(e))));
        assert.deepEqual(all('events-ok', PG.events + ' tbody .ui-chip').map(text).sort(), ['Success', 'unknown']);
        assert.ok(all('events-ok', PG.events + ' tbody .ui-quiet').length >= 2);
    });
    test('I18 holders: the share column is .ui-strong (pink is never text under 18 px)', () => {
        assert.ok(all('holders-ok', PG.holders + ' tbody .ui-strong').some(x => text(x) === '1.5000%'), all('holders-ok', PG.holders + ' tbody td').map(text).join('|'));
    });
});

describe('I12, I14, I23, I24, I25, I26, I27, I28, P5, P10, P15, P16: the transaction, block, validator and account pages', () => {
    test('I12: the correction note is a one-line info panel, words unchanged', () => {
        const p = need('tx-found', '.ui-panel.is-info.is-line');
        assert.ok(p.querySelector('.bx-info-circle'));
        assert.match(text(p), /^The link pointed at block #98, but the transaction is actually in block #100\./);
    });
    test('P15, P16, I14: the head carries .is-ruled; the key and value table is table.ui-kv with no row style; the status is a chip "Success"', () => {
        assert.ok(need('tx-found', '#tx-details-container .list-header').classList.contains('is-ruled'));
        const t = need('tx-found', '#tx-details-container table.ui-kv');
        assert.equal(t.querySelectorAll('[style]').length, 0, 'a row or cell still has an inline style');
        assert.equal(text(t.querySelector('.ui-chip.is-positive')), 'Success');
    });
    test('I14: a failed transaction is the chip "Failed" (is-error)', () => {
        assert.equal(text(need('tx-failed', '#tx-details-container table.ui-kv .ui-chip.is-error')), 'Failed');
    });
    test('I25, P5, P10: the not-found card: the icon is a neutral tile, the sentence is .ui-lede, names are code.ui-code, the status line is .ui-lede', () => {
        const c = need('tx-notfound', '#tx-details-container');
        assert.ok(c.querySelector('.ui-tile.is-lg.is-neutral .bx-search-alt'));
        assert.ok(c.querySelector('p.ui-lede'));
        assert.ok(c.querySelectorAll('code.ui-code').length >= 1);
        assert.ok(c.querySelector('#tx-recover-status.ui-lede'));
        assert.equal(written(c).length, 0);
    });
    test('P10: every name in the invalid-format card is code.ui-code', () => {
        assert.ok(all('tx-badhash', '#tx-details-container code.ui-code').length >= 2);
        assert.equal(all('tx-badhash', '#tx-details-container code:not(.ui-code)').length, 0);
    });
    test('P15, P6: the block page head is .is-ruled; the date is .ui-quiet', () => {
        assert.ok(need('block', '#block-details-container .list-header').classList.contains('is-ruled'));
        assert.ok(all('block', '#block-details-container .ui-quiet').some(e => /2026/.test(text(e))));
    });
    test('I27, I26, P4, I28, P16: the validator page: the commission alert is an error panel with a text button, a data table log, a quiet scorecard, a chart box', () => {
        const c = need('validator', '#validator-details-container');
        const alert = c.querySelector('.ui-panel.is-error');
        assert.ok(alert && alert.querySelector('.bx-error-circle'), 'no error panel');
        const toggle = c.querySelector('button#toggle-trigger-events');
        assert.ok(toggle && toggle.classList.contains('validate-text-btn') && !toggle.hasAttribute('style'));
        assert.ok(c.querySelector('#trigger-events-log table.data-table'));
        assert.ok(c.querySelector('#trigger-events-log.ui-ruled-top'));
        assert.ok(c.querySelectorAll('.staking-summary-card .ui-caption').length >= 3, 'the scorecard sub lines are not .ui-caption');
        assert.ok(c.querySelector('.staking-summary-card .value.is-wait'), 'spikes > 0 is .is-wait');
        assert.ok(c.querySelector('.ui-chart-box'));
        assert.ok(c.querySelector('table.ui-kv'));
        assert.ok(c.querySelector('.list-header.is-ruled'));
    });
    test('I23, S2: the word after an address is a text button "Copy" (a span with a click handler was not reachable by keyboard)', () => {
        for (const [k, sel] of [['validator', '#validator-details-container .js-copy-address'], ['account', '#account-details-container .js-copy-address'], ['council', '#council-members-list .js-copy-address']]) {
            const b = need(k, sel);
            assert.equal(b.tagName, 'BUTTON', `${k}: ${b.tagName}`);
            assert.equal(b.getAttribute('type'), 'button');
            assert.ok(b.classList.contains('validate-text-btn'));
            assert.equal(b.hasAttribute('style'), false);
            assert.equal(text(b), 'Copy');
        }
    });
    test('I23, S3, T12: a click swaps the word to "Copied", still a button, no inline colour', () => {
        for (const k of ['validator', 'account']) {
            const b = need(k, '.js-copy-address', 0);
            assert.equal(b.tagName, 'BUTTON');
            assert.equal(text(b), 'Copied', `${k}: ${text(b)}`);
            assert.equal(b.hasAttribute('style'), false, `${k}: ${b.getAttribute('style')}`);
        }
    });
    test('P16, I24, P4: the account summary is table.ui-kv in .ui-kv-wrap; the display name is .ui-strong; units are .ui-caption', () => {
        const c = need('account', '#account-details-container');
        assert.ok(c.querySelector('.ui-kv-wrap > table.ui-kv'));
        assert.equal(c.querySelector('table.ui-kv').querySelectorAll('tr[style], td[style]').length, 0);
        assert.ok(c.querySelector('table.ui-kv .ui-strong'));
        assert.ok(c.querySelectorAll('table.ui-kv .ui-caption').length >= 4);
        assert.ok(c.querySelector('.list-header.is-ruled'));
    });
    test('I39: the star beside an address is .watchlist-star with aria-pressed and no inline style', () => {
        for (const k of ['validator', 'account']) {
            const s = need(k, '.watchlist-star', 0);
            assert.equal(s.getAttribute('aria-pressed'), 'false');
            assert.equal(s.hasAttribute('style'), false);
        }
    });
});

describe('I37, P4, P7, P9: the account labels card', () => {
    test('I37 signed out: the heading is .ui-section-title, the empty and sign-in lines are captions', () => {
        const c = need('labels-out', '#account-details-container');
        assert.ok(c.querySelector('.ui-section-title'), 'no .ui-section-title');
        assert.ok(c.querySelectorAll('.ui-caption').length >= 1);
        assert.equal(written(c).length, 0);
    });
    test('I37 signed in as the owner: vote arrows are .label-vote-btn with aria-pressed and data-vote, the report count is a chip, rows keep no inline colour', () => {
        const rows = all('labels-owner', '.label-row');
        assert.ok(rows.length >= 3, `${rows.length} label rows`);
        const votes = all('labels-owner', '.label-vote-btn');
        assert.ok(votes.length >= 6);
        for (const v of votes) {
            assert.ok(['true', 'false'].includes(v.getAttribute('aria-pressed')), 'aria-pressed');
            assert.ok(['1', '-1'].includes(v.getAttribute('data-vote')));
            assert.equal(colourStyle(v), false);
        }
        assert.equal(all('labels-owner', `.label-row[data-signer="${ME}"] .label-vote-btn[data-vote="1"]`)[0].getAttribute('aria-pressed'), 'true', 'my up vote is pressed');
        assert.deepEqual(all('labels-owner', '.label-row .ui-chip.is-error').map(text), ['1 report']);
        assert.equal(all('labels-owner', '.label-row .ui-chip.is-error .bx-flag').length, 1);
        for (const r of rows) assert.equal(colourStyle(r), false);
    });
    test('I37: the status line under the form is a caption and takes its state from data-state, not a colour', () => {
        const s = need('labels-owner', '#account-label-status');
        assert.equal(colourStyle(s), false);
        assert.ok(s.classList.contains('ui-caption'));
    });
});

describe('P1, P3, P4, P5, I19, I20, I21: search', () => {
    test('P5, P4, I19: the prompt: the sentence is .ui-lede, the tip is .ui-caption, kbd carries no style', () => {
        assert.ok(need('search-prompt', '#search-results-container p.ui-lede'));
        assert.ok(need('search-prompt', '#search-results-container p.ui-caption'));
        assert.equal(need('search-prompt', '#search-results-container kbd').hasAttribute('style'), false);
    });
    test('P1: nothing found is an empty state (not orange): .ui-state.is-empty, the same words', () => {
        assert.equal(text(need('search-nothing', '.ui-state.is-empty', 0)), 'No results found in recent local history. Try deep search.');
    });
    test('P3, I20: a deep search that failed is .ui-state.is-failed with its words; the button is .ui-action (not .glass)', () => {
        assert.match(text(need('search-deep-fail', '.ui-state.is-failed', 0)), /^Deep Search Failed: /);
        const btn = need('search-deep-fail', '#deep-search-btn');
        assert.equal(btn.classList.contains('ui-action'), true);
        assert.equal(btn.classList.contains('validate-secondary'), false);
        assert.equal(btn.classList.contains('glass'), false);
    });
    test('I20: after a result the deep search button is .validate-secondary and no longer .ui-action, "Back to search"; no inline colour', () => {
        const btn = need('search-deep-ok', '#deep-search-btn', 1);
        assert.deepEqual(['ui-action', 'validate-secondary'].filter(c => btn.classList.contains(c)), ['validate-secondary']);
        assert.equal(text(btn), 'Back to search');
        assert.equal(colourStyle(btn), false);
    });
    test('I21: the deep search result heading is h3.ui-section-title.ui-ruled', () => {
        assert.equal(text(need('search-deep-ok', '#search-results-container h3.ui-section-title.ui-ruled', 0)), 'Account Detail (Deep Search)');
    });
});

describe('I30, P1, P3, P4, P6, P9, S7: staking rewards', () => {
    test('S7, P3: a reward history that could not be read is .ui-state.is-failed, "Could not load this. boom"', () => {
        assert.equal(text(need('rewards-error', '#staking-rewards-results .ui-state.is-failed')), 'Could not load this. boom');
    });
    test('I30, P6, P9: the result: the address is a plain span.mono, links are plain .item-link, the unpaid value has no colour, nothing is written inline', () => {
        const c = need('rewards-ok', '#staking-rewards-results');
        assert.equal(written(c).length, 0, written(c).map(describeEl).join('\n'));
        assert.ok(c.querySelector('span.mono'), 'the address is not span.mono');
        const unpaid = Array.from(c.querySelectorAll('.staking-summary-card')).find(e => /Unpaid Rewards/.test(text(e)));
        assert.ok(unpaid && !unpaid.querySelector('.value').hasAttribute('style'));
        assert.ok(c.querySelectorAll('table a.item-link:not([style])').length >= 2);
    });
    test('P1: an address with no rewards draws a .ui-state', () => {
        assert.ok(need('rewards-empty', '#staking-rewards-results .ui-state'));
    });
});

describe('3.3, I38, I22, I39, P1: Analytics, Watchlist, Brand, Price', () => {
    test('3.3 Analytics: the head is pageHeadHtml (ruled, meta "Last sync ..."); sub lines are .ui-caption; "/ total" is .ui-quiet; the body is .ui-page-body', () => {
        const c = need('analytics', '#analytics-content');
        const head = c.querySelector('.list-header.ui-page-head.is-ruled');
        assert.ok(head, 'no pageHeadHtml');
        assert.match(text(head.querySelector('.ui-page-head-meta')), /^Last sync /);
        assert.ok(c.querySelectorAll('.staking-summary-card .ui-caption').length >= 6);
        assert.ok(c.querySelectorAll('.staking-summary-card .value .ui-quiet').length >= 2);
        assert.ok(c.querySelector('.ui-page-body'));
    });
    test('I38: the chart titles are .ui-section-title and the subtitles .ui-caption', () => {
        const c = need('analytics', '#analytics-content');
        assert.ok(c.querySelectorAll('.ui-section-title').length >= 6);
        assert.ok(c.querySelectorAll('.ui-caption').length >= 12);
    });
    test('3.3 Watchlist: the head is pageHeadHtml with the count as a meta item and Clear all as its action; groups are .ui-section-title with a quiet count; "added" is .ui-caption', () => {
        const c = need('watch', '#watchlist-content');
        const head = c.querySelector('.list-header.ui-page-head.is-ruled');
        assert.ok(head, 'no pageHeadHtml');
        assert.equal(text(head.querySelector('.ui-page-head-meta')), '1 item');
        assert.equal(head.querySelector('h2').textContent.includes('item'), false, 'the count left the h2');
        assert.ok(head.querySelector('.ui-page-head-actions #watchlist-clear-all'));
        assert.ok(c.querySelector('h3.ui-section-title .ui-quiet'));
        assert.ok(Array.from(c.querySelectorAll('.ui-caption')).some(e => /^added /.test(text(e))));
    });
    test('I39: the row is .watchlist-row; the star is .watchlist-star with aria-pressed and no style; a click turns it off by aria-pressed only', () => {
        assert.ok(need('watch', '#watchlist-content .watchlist-row'));
        const star = need('watch', '#watchlist-content .watchlist-star');
        assert.equal(star.getAttribute('aria-pressed'), 'true');
        assert.equal(star.hasAttribute('style'), false);
        const after = need('watch', '.watchlist-star', 0);
        assert.equal(after.getAttribute('aria-pressed'), 'false', 'the click did not turn the star off');
        assert.equal(colourStyle(after), false);
    });
    test('I39: the empty watchlist: a neutral tile holds the star, the sentence is .ui-lede, the inline star is a muted glyph', () => {
        const c = need('watch-empty', '#watchlist-content');
        assert.ok(c.querySelector('.ui-tile.is-lg.is-neutral .bx-star'));
        assert.ok(c.querySelector('p.ui-lede'));
        assert.ok(c.querySelector('.ui-glyph.is-muted.bx-star'));
    });
    test('I22: the brand page: the type sample is mono and quiet, the dark logo card is .is-dark with no inline style, the caption is .ui-caption', () => {
        const c = need('brand', '.page-section[data-page="brand"]');
        assert.ok(c.querySelector('.mono.ui-quiet'));
        assert.ok(c.querySelector('.brand-logo-card.is-dark'));
        assert.equal(c.querySelector('.brand-logo-card.is-dark').hasAttribute('style'), false);
        assert.ok(Array.from(c.querySelectorAll('.ui-caption')).some(e => /Subtitles, table headers/.test(text(e))));
    });
    test('P1: no price data is .ui-state (empty)', () => {
        const s = need('price', '.page-section[data-page="price"] .ui-state');
        assert.match(text(s), /^No price data in the selected range\./);
    });
});

describe('I29, P5, P7: email preferences', () => {
    test('I29, P7, P5: legends are .ui-section-title in a .ui-fieldset, the rule is hr.ui-hr, the intro lines are .ui-lede, the address is .ui-strong', () => {
        const c = need('email-prefs', '#email-prefs-content');
        assert.ok(c.querySelectorAll('fieldset.ui-fieldset > legend.ui-section-title').length >= 2);
        assert.ok(c.querySelector('hr.ui-hr'));
        assert.ok(c.querySelectorAll('p.ui-lede').length >= 2);
        assert.equal(text(c.querySelector('strong.ui-strong')), 'a@b.co');
    });
    test('P5: a page opened without its personal link says so in a .ui-lede', () => {
        assert.ok(need('email-prefs-none', '#email-prefs-content p.ui-lede'));
    });
});

describe('I11, I15, I40: the shell: the chain-stalled banner, the node dot, the tour', () => {
    test('I11: the stalled banner is an amber panel (.chain-stale), the lead-in is its title, the words unchanged (the real renderChainStaleBanner, given a stub document)', () => {
        const placed = [];
        const fakeDoc = { getElementById: () => null, createElement: () => ({ set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; } }), body: { insertBefore: (el) => placed.push(el), firstChild: null } };
        const render = new Function('document', 'stakingEscapeHtml', 'panelHtml', 'icon', `${bodyOf(SRC, 'renderChainStaleBanner')} return renderChainStaleBanner;`)(fakeDoc, escapeHtml, panelHtml, icon);
        render({ isStale: true, staleSeconds: 300, value: 100 });
        assert.equal(placed.length, 1);
        const b = docOf(placed[0].html);
        const p = b.querySelector('.ui-panel.is-warn.chain-stale');
        assert.ok(p && p.querySelector('.bx-error-circle'), 'no amber panel: ' + placed[0].html.slice(0, 200));
        assert.equal(text(p.querySelector('.ui-panel-title')), 'Chain may be stalled:');
        assert.match(text(p), /block #100 hasn't advanced in 5 minutes\. The data on this page may be out of date/);
        assert.equal(written(b).length, 0);
    });
    test('I15: the node dot is told its state by data-state (ok, wait or down) and has no inline background', () => {
        const dot = need('val-ok', '.status-indicator');
        assert.ok(['ok', 'wait', 'down'].includes(dot.getAttribute('data-state')), `data-state="${dot.getAttribute('data-state')}"`);
        assert.equal(dot.hasAttribute('style') && /background/.test(dot.getAttribute('style')), false);
    });
    test('I40: the tour: the icon is .tour-icon, the dots are .tour-dot (one .is-on, moved by Next), nothing is written inline', () => {
        for (const d of [0, 1]) {
            const m = need('tour', '#onboarding-tour-modal', d);
            assert.ok(m.querySelector('.tour-icon'), `dump ${d}: no .tour-icon`);
            const dots = Array.from(m.querySelectorAll('#onboarding-tour-dots .tour-dot'));
            assert.ok(dots.length >= 3, `dump ${d}: ${dots.length} dots`);
            assert.equal(dots.filter(x => x.classList.contains('is-on')).length, 1);
            assert.equal(dots.findIndex(x => x.classList.contains('is-on')), d);
            assert.equal(written(m).length, 0, written(m).map(describeEl).join('\n'));
        }
    });
});

describe('P1, P3, P4, P5, P6, P8, P9, P11, I32, I36: governance pages', () => {
    test('P5, P6, P9: the discussions list: the intro is .ui-lede, total and earlier counts are quiet or caption, links plain', () => {
        const c = need('discussions', '#discussions-content');
        assert.ok(c.querySelector('.ui-lede'));
        assert.ok(c.querySelectorAll('.ui-quiet, .ui-caption').length >= 3);
        assert.ok(c.querySelector('a.item-link:not([style])'));
        assert.equal(written(c).length, 0);
    });
    test('S7, P3: a thread that could not be read is .ui-state.is-failed, "Could not load this. boom"', () => {
        assert.equal(text(need('thread-error', '#discussions-content .ui-state.is-failed')), 'Could not load this. boom');
    });
    test('P1, P5: an empty thread is .ui-state; "Connect a wallet to comment." is a .ui-lede', () => {
        const c = need('thread', '#discussions-content');
        assert.ok(c.querySelector('.ui-state'));
        assert.ok(c.querySelector('.discussion-composer .ui-lede'));
        assert.equal(written(c).length, 0);
    });
    test('P1: the democracy tabs: "No referenda indexed yet." and "No active public proposals." are .ui-state', () => {
        assert.ok(all('democracy', '.ui-state', 1).some(e => /^No referenda indexed yet\./.test(text(e))));
        assert.ok(all('democracy', '.ui-state', 2).some(e => /^No active public proposals\./.test(text(e))));
    });
    test('P1: the treasury tabs: each empty list is .ui-state', () => {
        assert.ok(all('treasury', '.ui-state', 0).some(e => /^No open proposals/.test(text(e))));
        assert.ok(all('treasury', '.ui-state', 1).some(e => /^No approved proposals/.test(text(e))));
        assert.ok(all('treasury', '.ui-state', 2).some(e => /^No resolved proposals/.test(text(e))));
    });
    test('P3: council data that could not load is .ui-state.is-failed (amber) with the same words', () => {
        const words = all('council-error', '.ui-state.is-failed').map(text);
        for (const w of ['Failed to load council data.', 'Failed to load council motions.', 'Failed to load the technical committee.', 'Failed to load technical committee motions.']) assert.ok(words.includes(w), `${w} | ${words.join('|')}`);
    });
    test('P1, P11, P9, I23, P16: the council members: the name is .ui-strong, the Copy word a text button, rows carry no style', () => {
        const c = need('council', '#council-members-list');
        assert.ok(c.querySelector('.ui-strong'));
        assert.ok(c.querySelector('button.validate-text-btn.js-copy-address'));
        assert.equal(written(c).length, 0);
        const tc = need('council', '#tc-members-list');
        assert.ok(tc.querySelector('.ui-strong'));
        assert.ok(tc.querySelector('a.item-link:not([style])'));
        assert.equal(written(tc).length, 0);
    });
    test('P4, P8, P9, I32: the council motions: the call filter label is .ui-field-label, the role note a caption, proposer and voters plain links', () => {
        const c = need('council', '#council-motions-content');
        assert.ok(c.querySelector('label.ui-field-label'), 'the "Call type" label');
        assert.ok(c.querySelector('select.motion-call-select.ui-input'));
        assert.ok(c.querySelectorAll('.ui-caption').length >= 1);
        assert.ok(c.querySelectorAll('.motion-meta a.item-link:not([style]), .motion-voters a.item-link:not([style])').length >= 2);
        assert.equal(written(c).length, 0, written(c).map(describeEl).join('\n'));
    });
    test('I32: the technical committee note "Recovering history" is a one-line amber panel', () => {
        const tc = need('council', '#tc-motions-content');
        const p = tc.querySelector('.ui-panel.is-warn.is-line');
        assert.ok(p && p.querySelector('.bx-time-five'), 'no amber panel');
        assert.match(text(p), /^Recovering history: /);
    });
});
