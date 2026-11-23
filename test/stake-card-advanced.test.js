// The Stake PDEX card's advanced view (WP3 of design 2026-11-22-stake-card-simple-and-advanced.md,
// sections 5, 6, 7, 8, 9, 10.2 and 10.3; CEO decisions of 2026-11-23).
//
// Everything here runs the REAL page code, as test/stake-card-simple.test.js does: the stake modal markup
// is sliced out of index.html, the REAL openStakeModal, submitStakeTx, the picker glue and submitSignedTx
// are lifted from script.js into a wallet-world tab, and the view is lib/stake-card-view.js over the real
// lib/stake-picker-view.js, lib/stake-pick.js and lib/stake-plan.js. globalApi is a REAL ApiPromise booted
// from the mainnet 394 metadata; only the transaction watcher is a recorder.
//
// One state, two views (section 2): the amount, the selection and the rewards setting are the same state
// in both; Advanced edits all three. The rewards destination is new signing surface (setPayee): it is
// signed only when changed in Advanced and shown in the review (M7, M8, M9).
//
// Strings are checked by spec id, verbatim (data-sc). Addresses are filler bytes at prefix 88; the names
// are "Validator A" to "Validator T". None belongs to anyone.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { ApiPromise } from '@polkadot/api';
import { makeProfile, openTab, fakeExtension, A as ME, B as SOMEONE } from './helpers/wallet-world.js';
import { bodyOf, stripComments } from './helpers/source.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { mockProvider } from './helpers/mock-provider.js';
import * as stakePlan from '../lib/stake-plan.js';
import * as stakeCardView from '../lib/stake-card-view.js';
import { FEE_MARGIN } from '../lib/fee-preflight.js';
import { pdexToPlanck } from '../lib/wallet-safety.js';
import { createStakePicker, loadPickerData, maxNominationsFrom } from '../lib/stake-picker-view.js';
import { payeeOf } from '../lib/validator-manage.js';
import { describeValidatorCall } from '../lib/validator-delegate.js';
import { callToTree } from '../lib/call-tree.js';
import { renderCallHtml } from '../lib/call-args-format.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MODAL = HTML.slice(HTML.indexOf('<div id="stake-modal"'), HTML.indexOf('<!-- Payout Rewards Modal -->'));
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const PDEX = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 1)); };
const V = (n) => addr(40 + n);
const LETTER = (n) => String.fromCharCode(64 + n);
const OTHER = addr(7);
const NOT_88 = encodeAddress(new Uint8Array(32).fill(7), 42);

const LIFT = ['openStakeModal', 'loadStakeChoice', 'stakeCardView', 'submitStakeTx', 'fillStakeMax', 'submitSignedTx', 'showStakeError', 'clearStakeError',
    'stakeMaxNominations', 'renderStakeSelected', 'renderStakeValidatorList', 'stakePickerView', 'addStakeValidator', 'removeStakeValidator',
    'getStakeableBalance', 'batchTx', 'buildBondOrExtra', 'formatDuration', 'maybeRunWalletEntryIntent'];
function lift(name) {
    const at = SCRIPT.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const pre = SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '';
    return pre + bodyOf(SCRIPT, name) + '\n';
}

let api;
before(async () => {
    const fx = loadFixture('metadata-mainnet-394.json');
    const mock = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion });
    api = await ApiPromise.create({ provider: mock.provider, noInitWarn: true });
});
after(async () => { await api?.disconnect(); });

const decode = (tx) => api.registry.createType('Call', tx.method.toHex());
const name = (c) => `${c.section}.${c.method}`;
const ss58 = (x) => encodeAddress(decodeAddress(x.toString()), 88);

// ── the validator snapshot ──
const ERA = 500;
const APRS = [20, 19.5, 19, 18.5, 18, 17.5, 17, 16.5, 16, 15.5, 15, 14.5];
function val(n, apr, over = {}) {
    return { address: V(n), name: `Validator ${LETTER(n)}`, active: true, commission: 5, blocked: false, selfStake: 1000, totalStake: 50000,
        exposurePages: 1, exposureNominators: 20, backers: 20, identity: { hasIdentity: false, verified: false, parent: null }, slashEras: [],
        commissionHistory: { raisedRecently: false, pendingRaise: false },
        perf: { 28: { status: 'ok', apr, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100 } }, ...over };
}
const fullList = (over = {}) => APRS.map((apr, i) => val(i + 1, apr, over[i + 1] || {}));
async function snapshotOf(list, { full = true, quota = 16 } = {}) {
    return loadPickerData(async (url) => (url.endsWith('validator-choice')
        ? (full ? { validators: list, activeEra: ERA, maxNominations: quota, exposurePageSize: 256 } : { status: 'Initializing', validators: [] })
        : { validators: list.map(v => ({ address: v.address, name: v.name, commission: v.commission, totalStake: v.totalStake })), commissionHistoryEra: ERA }));
}

// ── wallet payloads (/api/wallet) ──
const NETWORK = { minStake: 100, eraDurationMs: 86_400_000, unbondingMs: 28 * 86_400_000 };
const firstTimer = (balance = { free: 501, transferable: 500 }, stakingOver = {}) => ({ address: ME, balance,
    staking: { totalStaked: 0, activeStaked: 0, nominating: [], ledgerRead: 'ok', controller: null, ...stakingOver }, network: NETWORK });
const staker = (nominating = [1, 2], stakingOver = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 },
    staking: { totalStaked: 200, activeStaked: 200, nominating: nominating.map(n => ({ address: V(n), name: `Validator ${LETTER(n)}` })), ledgerRead: 'ok', controller: ME, ...stakingOver },
    network: NETWORK });

// One open Stake card, in Advanced unless view says otherwise (the remembered view, section 2).
async function card({ data, snapshots, payee = { kind: 'staked', account: '' }, keep, connected = ME, view = 'advanced', storage = {}, multisig = null, help = false }) {
    const ext = fakeExtension('polkadot-js', [{ address: ME, name: 'One' }]);
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', connected);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    if (view) profile.local.setItem('pdex_stake_view_v1', view);
    for (const [k, v] of Object.entries(storage)) profile.local.setItem(k, v);
    const tab = openTab(profile, { path: '/wallet/' + data.address });
    const doc = tab.root.ownerDocument;
    doc.body.insertAdjacentHTML('beforeend', MODAL);
    tab.ctx.window.localStorage = profile.local;
    const queue = (snapshots || [await snapshotOf(fullList())]).slice();
    const sent = [], built = [], reviews = [];
    Object.assign(tab.ctx, stakePlan, stakeCardView, {
        FEE_MARGIN, pdexToPlanck, maxNominationsFrom, createStakePicker, payeeOf, Math, Number, parseFloat, BigInt,
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), stakingFormatNumber: (n) => String(n), showTxNotice: () => {},
        currentWalletData: data, stakeSelected: new Map(), stakeValidators: [], stakePicker: null, stakeCard: null,
        validatorsCache: null, validatorsCacheAt: 0, VALIDATORS_CACHE_TTL: 60_000, stakeQuotaWarned: false, walletEntryIntent: null,
        loadValidatorsForPicker: async () => {
            const next = queue.length > 1 ? queue.shift() : queue[0];
            if (next instanceof Error) throw next;
            tab.ctx.validatorsCache = next;
            return next;
        },
        readStakePayee: async () => payee,
        refreshWalletDashboardFor: () => {},
        globalApi: api, liveRuntimeError: () => null,
        multisigStore: { find: () => multisig },
        multisigUI: { review: async (o) => { reviews.push(o); } },
        showTxStatus: () => ({ stage: 'failed' }),
        postAction: { observe: () => ({ stage: (f) => f, show: (f) => f }) },
        trackSignedTx: (o) => ({ start() {}, buildFailed(e) { built.push(e); }, send: async (tx, who) => { sent.push({ tx, who, action: o.action }); } })
    });
    if (help) tab.ctx.helpIcon = (slug) => `<a href="/help/${slug}" class="help-inline-icon">?</a>`;
    vm.runInContext(LIFT.map(lift).join(''), tab.ctx);
    await tab.fn('openStakeModal')(keep);
    await flush();
    const q = (s) => doc.querySelector('#stake-modal ' + s);
    const qa = (s) => Array.from(doc.querySelectorAll('#stake-modal ' + s));
    const shown = (el) => { for (let e = el; e; e = e.parentElement) { if (e.hidden || (e.style && e.style.display === 'none')) return false; if (e.tagName === 'DETAILS' && !e.open && el !== e && !el.closest('summary')) return false; } return !!el; };
    const sc = (id) => { const els = qa(`[data-sc="${id}"]`).filter(shown); return els.length ? els.map(e => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ') : ''; };
    const input = () => doc.getElementById('stake-amount-input');
    const primary = () => doc.getElementById('submit-stake-tx-btn');
    const ev = (el, type) => el.dispatchEvent(new doc.defaultView.Event(type, { bubbles: true }));
    const type = async (v) => { const i = input(); i.value = v; ev(i, 'input'); await flush(); };
    const click = async (sel) => { const el = q(sel); assert.ok(el, `no ${sel} in the card`); el.click(); await flush(); };
    const errorText = () => { const e = doc.getElementById('stake-modal-error'); return !e || e.style.display === 'none' ? '' : e.textContent; };
    const submit = async () => { await tab.fn('submitStakeTx')(); await flush(); };
    const primaries = () => qa('.validate-primary').filter(shown).length;
    // The rewards radio group (section 5.2) and its address field.
    const radio = (v) => q(`#stake-rewards input[name="stake-payee"][value="${v}"]`);
    const choosePayee = async (v) => { const r = radio(v); assert.ok(r, `no ${v} radio`); r.checked = true; ev(r, 'change'); await flush(); };
    const typeAccount = async (v) => { const i = q('#stake-payee-account'); assert.ok(i, 'no rewards account field'); i.value = v; ev(i, 'input'); await flush(); };
    const lines = () => qa('#stake-sign .stake-plan-lines li').filter(shown).map(li => li.textContent.trim());
    const selected = () => qa('#stake-selected-list .stake-validator-item[data-addr]').map(e => e.getAttribute('data-addr'));
    const listRows = () => qa('#stake-validator-list .stake-validator-item[data-addr]').map(e => e.getAttribute('data-addr'));
    const addFromList = async (a) => { const r = q(`#stake-validator-list .stake-validator-item[data-addr="${a}"]`); assert.ok(r, `no list row ${a}`); r.click(); await flush(); };
    const removePick = async (a) => { const b = q(`#stake-selected-list .stake-validator-item[data-addr="${a}"] .stake-val-remove`); assert.ok(b, `no remove for ${a}`); b.click(); await flush(); };
    const reason = () => { const r = doc.getElementById('stake-primary-reason'); return r && !r.hidden ? r.textContent : ''; };
    return { tab, doc, q, qa, sc, shown, ev, input, primary, type, click, errorText, submit, primaries, sent, built, reviews, profile, radio, choosePayee, typeAccount,
        lines, selected, listRows, addFromList, removePick, reason, close: () => tab.close() };
}
const signedCalls = (c, i = 0) => { const top = decode(c.sent[i].tx); return name(top) === 'utility.batchAll' ? top.args[0] : [top]; };
const nothingSent = (c) => c.sent.length;

const SC = stakePlan.STAKE_COPY;

describe('getting there and the frame (sections 5.1, 7, 8)', () => {
    test('the switch is pressed, SC-02 under the title, the four headings, the figures of 5.2', async () => {
        const c = await card({ data: firstTimer() });
        assert.equal(c.q('#stake-view-switch').getAttribute('aria-pressed'), 'true');
        assert.equal(c.sc('SC-02'), 'Change only what you want. The review lists exactly what you will sign.');
        assert.equal(c.sc('SC-61'), 'Amount');
        assert.equal(c.sc('SC-62'), 'Rewards');
        assert.equal(c.sc('SC-63'), 'Validators');
        assert.equal(c.sc('SC-73'), 'All validators');
        assert.equal(c.sc('SC-75'), 'Remove all');
        const fig = (label) => { const row = c.qa('#stake-summary > div').find(d => d.querySelector('span')?.textContent.trim() === label); return row ? row.querySelector('strong').textContent.trim() : null; };
        assert.equal(fig('Currently staked'), '0 PDEX');
        assert.equal(fig('Smallest first stake'), '100 PDEX');
        assert.equal(fig('You can stake up to'), '499.8 PDEX');
        assert.ok(!/Nominations chosen|Selected|Available validators|Pick validators from the list/.test(c.q('.stake-modal-body').textContent), 'the old words are gone');
        assert.ok(!/nominat/i.test(c.sc('SC-02') + c.sc('SC-74') + c.sc('SC-76')), 'vocabulary: no "nominate" outside Call details');
        c.close();
    });
    test('every element that says it carries a spec string carries it verbatim', async () => {
        const c = await card({ data: staker([1, 2]) });
        const plain = ['SC-02', 'SC-61', 'SC-62', 'SC-63', 'SC-65', 'SC-66', 'SC-67', 'SC-68', 'SC-69', 'SC-73', 'SC-75'];
        for (const id of plain) assert.equal(c.qa(`[data-sc="${id}"]`).length > 0 ? c.q(`[data-sc="${id}"]`).textContent.trim() : null, SC[id], id);
        for (const el of c.qa('[data-sc]')) assert.ok(el.getAttribute('data-sc') in SC, `${el.getAttribute('data-sc')} is not in STAKE_COPY`);
        c.close();
    });
    test('the view is the only thing a browser keeps: no amount, no address, no selection', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('12.5');
        await c.choosePayee('account');
        await c.typeAccount(OTHER);
        await c.addFromList(V(5));
        await c.click('#stake-view-switch');
        const keys = [];
        for (let i = 0; i < c.profile.local.length; i++) keys.push(c.profile.local.key(i));
        const stakeKeys = keys.filter(k => /stake/.test(k)).sort();
        assert.deepEqual(stakeKeys, ['pdex_stake_view_v1'], `stored: ${stakeKeys.join(', ')}`);
        for (const k of keys) { const v = c.profile.local.getItem(k) || ''; assert.ok(!v.includes(OTHER) && !v.includes('12.5') && !v.includes(V(5)), `${k} holds card state`); }
        c.close();
    });
});

describe('nothing disappears: the 23 capabilities of section 5.3, in Advanced', () => {
    test('1. first stake: bond and nominate in one transaction', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        assert.deepEqual(c.lines(), ['Stake 150 PDEX', 'Choose 8 validators']);
        assert.equal(c.primary().textContent.trim(), 'Sign and stake');
        await c.submit();
        assert.equal(name(decode(c.sent[0].tx)), 'utility.batchAll');
        assert.deepEqual(signedCalls(c).map(name), ['staking.bond', 'staking.nominate']);
        assert.ok(signedCalls(c)[0].args[1].isStaked, 'rewards added to the stake by default (decision Q3)');
        c.close();
    });
    test('2. add to the stake: bondExtra alone, the validators not re-sent', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('25');
        assert.deepEqual(c.lines(), ['Add 25 PDEX to your stake']);
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra']);
        assert.equal(signedCalls(c)[0].args[0].toBigInt(), 25n * PDEX);
        c.close();
    });
    test('3. change validators only, the amount left empty', async () => {
        const c = await card({ data: staker([1, 2, 3]) });
        await c.removePick(V(3));
        assert.deepEqual(c.lines(), ['Replace your validators with these 2']);
        assert.equal(c.primary().textContent.trim(), 'Sign and update validators');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.nominate']);
        assert.deepEqual(signedCalls(c)[0].args[0].map(ss58), [V(1), V(2)]);
        c.close();
    });
    test('4. add and change in one transaction', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('10');
        await c.addFromList(V(5));
        assert.deepEqual(c.lines(), ['Add 10 PDEX to your stake', 'Replace your validators with these 3']);
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra', 'staking.nominate']);
        assert.deepEqual(signedCalls(c)[1].args[0].map(ss58), [V(1), V(2), V(5)]);
        c.close();
    });
    test('5. Max writes the figure only when pressed', async () => {
        const c = await card({ data: firstTimer() });
        assert.equal(c.input().value, '');
        await c.click('#stake-max-btn');
        assert.equal(c.input().value, '499.8');
        c.close();
    });
    test('6. the current validators are the starting selection', async () => {
        const c = await card({ data: staker([1, 2, 3]) });
        assert.deepEqual(c.selected(), [V(1), V(2), V(3)]);
        assert.equal(c.sc('SC-74'), 'Your selection, 3 of 16');
        assert.equal(c.primary().disabled, true, 'nothing changed');
        assert.equal(c.reason(), SC['SC-55b']);
        c.close();
    });
    test('7. "Change validators" with a keep list: Advanced opens with the keep list selected (as today)', async () => {
        const c = await card({ data: staker([1, 2, 3]), keep: [V(1), V(2)] });
        assert.deepEqual(c.selected(), [V(1), V(2)]);
        assert.deepEqual(c.lines(), ['Replace your validators with these 2']);
        await c.click('#stake-view-switch');
        assert.equal(c.sc('SC-30b'), '2 validators chosen by you', 'the same state in Simple');
        c.close();
    });
    test('8. search by name or address', async () => {
        const c = await card({ data: firstTimer() });
        const s = c.q('#stake-validator-search');
        assert.equal(s.getAttribute('placeholder'), 'Search by name or address');
        s.value = 'Validator C';
        c.ev(s, 'input');
        await flush();
        assert.deepEqual(c.listRows(), [V(3)]);
        s.value = V(4);
        c.ev(s, 'input');
        await flush();
        assert.deepEqual(c.listRows(), [V(4)]);
        c.close();
    });
    test('9. Suggested filters and Show all', async () => {
        const c = await card({ data: firstTimer() });
        await c.click('[data-preset="recommended"]');
        assert.deepEqual(c.listRows(), [], 'the preset asks for an on-chain identity; none of these has one');
        assert.match(c.q('#stake-validator-list').textContent, /No validator matches these filters\. Loosen one, or press Show all\./);
        await c.click('[data-preset="all"]');
        assert.equal(c.listRows().length, 12);
        c.close();
    });
    test('10. Active, Waiting and All, with counts', async () => {
        const c = await card({ data: firstTimer(), snapshots: [await snapshotOf(fullList({ 12: { active: false } }))] });
        const count = (s) => c.q(`[data-count-status="${s}"]`).textContent;
        assert.deepEqual([count('active'), count('waiting'), count('all')], ['(11)', '(1)', '(12)']);
        await c.click('[data-status="waiting"]');
        assert.deepEqual(c.listRows(), [V(12)]);
        c.close();
    });
    test('11. the return window: "Past return over" 7, 28 or 84 eras', async () => {
        const c = await card({ data: firstTimer() });
        const sel = c.q('select[data-f="aprWindow"]');
        assert.match(sel.closest('label').textContent, /^\s*Past return over/);
        assert.deepEqual(Array.from(sel.options).map(o => o.value), ['7', '28', '84']);
        sel.value = '7';
        c.ev(sel, 'change');
        await flush();
        const row = c.q(`#stake-validator-list .stake-validator-item[data-addr="${V(5)}"]`);
        assert.ok(row.querySelector('[data-chip="nohistory"]'), 'no 7-era figure: "No history yet"');
        assert.ok(!/% a year/.test(row.textContent));
        c.close();
    });
    test('12. six sorts, "Highest past return" first', async () => {
        const c = await card({ data: firstTimer() });
        const sel = c.q('select[data-f="sort"]');
        assert.deepEqual(Array.from(sel.options).map(o => o.textContent), ['Highest past return', 'Lowest commission', 'Most total stake', 'Most self-stake', 'Most reliable', 'Name A to Z']);
        sel.value = 'name';
        c.ev(sel, 'change');
        await flush();
        assert.deepEqual(c.listRows(), [...APRS.keys()].map(i => V(i + 1)));
        c.close();
    });
    test('13. nine filters, each with its reason, "hides N" and "showing x of y"', async () => {
        const c = await card({ data: firstTimer(), snapshots: [await snapshotOf(fullList({ 4: { blocked: true } }))] });
        for (const k of ['maxCommission', 'noRecentRaise', 'identity', 'reliability', 'notBlocked', 'singlePage', 'noSlash', 'spread', 'minSelfStake']) {
            const ctl = c.q(`#stake-filter-bar [data-f="${k}"]`);
            assert.ok(ctl, k);
            assert.ok(ctl.closest('label').querySelector('.stake-why'), `${k} has its reason`);
        }
        assert.equal(c.q('[data-count-for="notBlocked"]').textContent, 'hides 1');
        assert.equal(c.q('[data-count-shown]').textContent, 'showing 11 of 12');
        c.close();
    });
    test('14. row data and the commission note', async () => {
        const c = await card({ data: firstTimer(), snapshots: [await snapshotOf(fullList({ 9: { commissionHistory: { note: 'held 5% for 30 eras', volatility: 'stable' }, identity: { hasIdentity: true, verified: true, parent: null } } }))] });
        const row = c.q(`#stake-validator-list .stake-validator-item[data-addr="${V(9)}"]`).textContent.replace(/\s+/g, ' ');
        for (const part of ['Validator I', '16.00% a year', '5.0% commission', '50.0K PDEX', 'own stake 1000', '100% reliable', '20 stakers', 'verified identity', 'held 5% for 30 eras']) {
            assert.ok(row.includes(part), `${part} in "${row}"`);
        }
        assert.ok(!/APR|comm\b|backers|self \d/.test(row), `old row words: ${row}`);
        c.close();
    });
    test('15. add, remove and Remove all', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.addFromList(V(6));
        assert.deepEqual(c.selected(), [V(1), V(2), V(6)]);
        await c.removePick(V(1));
        assert.deepEqual(c.selected(), [V(2), V(6)]);
        await c.click('#stake-clear-btn');
        assert.deepEqual(c.selected(), []);
        assert.equal(c.sc('SC-76'), 'No validators selected. Add from the list, or use the automatic choice.');
        assert.equal(c.reason(), SC['SC-107'], 'no validators: nothing to sign');
        c.close();
    });
    test('16. the pick counter against the chain quota', async () => {
        const c = await card({ data: staker([1, 2, 3]), snapshots: [await snapshotOf(fullList(), { quota: 3 })] });
        assert.equal(c.sc('SC-74'), 'Your selection, 3 of 3');
        await c.addFromList(V(4));
        assert.deepEqual(c.selected(), [V(1), V(2), V(3)]);
        assert.equal(c.errorText(), 'You can choose up to 3 validators. Remove one to add another.', 'SC-108');
        c.close();
    });
    test('17. the shared-identity note, and the chip on the sibling', async () => {
        const fam = { identity: { hasIdentity: true, verified: false, parent: V(1) } };
        const c = await card({ data: staker([1, 2]), snapshots: [await snapshotOf(fullList({ 1: { identity: { hasIdentity: true, verified: false, parent: null } }, 2: fam, 3: fam }))] });
        assert.match(c.q('#stake-spread-note').textContent, /Several picks share one on-chain identity/);
        const sib = c.q(`#stake-validator-list .stake-validator-item[data-addr="${V(3)}"] [data-chip="same"]`);
        assert.ok(sib, 'Same identity chip on the unpicked sibling');
        assert.equal(sib.textContent.trim(), 'Same identity');
        c.close();
    });
    test('18. Currently staked and the smallest first stake as figures', async () => {
        const c = await card({ data: staker([1]) });
        assert.equal(c.q('#stake-current').textContent.trim(), '200 PDEX');
        assert.equal(c.q('#stake-minimum').textContent.trim(), '100 PDEX');
        c.close();
    });
    test('19. remembered filters (pdex_stake_filters_v1, unchanged)', async () => {
        const c = await card({ data: firstTimer() });
        const sel = c.q('select[data-f="sort"]');
        sel.value = 'commission';
        c.ev(sel, 'change');
        await flush();
        const saved = c.profile.local.getItem('pdex_stake_filters_v1');
        c.close();
        const d = await card({ data: firstTimer(), storage: { pdex_stake_filters_v1: saved } });
        assert.equal(d.q('select[data-f="sort"]').value, 'commission');
        d.close();
    });
    test('20. help links: the title row and the filter bar', async () => {
        const c = await card({ data: firstTimer(), help: true });
        assert.ok(c.q('.stake-title-row a[href="/help/nominating"]'));
        assert.ok(c.q('#stake-filter-bar a[href="/help/choosing-validators"]'));
        c.close();
    });
    test('21. the /stake intent and the My Account button open the card (in the remembered view)', async () => {
        const c = await card({ data: firstTimer() });
        c.doc.getElementById('stake-modal').style.display = 'none';
        c.doc.body.insertAdjacentHTML('beforeend', '<button id="wallet-act-stake">Stake</button>');
        // walletEntryIntent is the tab's own top-level binding (test/helpers/wallet-world.js declares it with let), so it
        // is set and read in the tab's scope, not as a property of the context object.
        c.tab.fn("walletEntryIntent = 'stake'");
        c.tab.fn('maybeRunWalletEntryIntent')();
        await flush();
        assert.equal(c.doc.getElementById('stake-modal').style.display, 'flex');
        assert.equal(c.q('#stake-view-switch').getAttribute('aria-pressed'), 'true');
        assert.equal(c.tab.fn('walletEntryIntent'), null);
        c.close();
    });
    test('22. the fallback list while the snapshot is cold: the picker works without returns', async () => {
        const c = await card({ data: staker([1, 2, 3]), snapshots: [await snapshotOf(fullList(), { full: false })] });
        assert.equal(c.listRows().length, 12);
        assert.ok(!/% a year|No history yet|Low return/.test(c.q('#stake-validator-list').textContent), 'no return claims from a list without them');
        assert.equal(c.sc('SC-114'), SC['SC-114']);
        await c.removePick(V(3));
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.nominate']);
        c.close();
    });
    test('23. fee check, multisig review, wallet-changed guard and status card: the same submitSignedTx path', async () => {
        const ms = await card({ data: staker([1, 2]), multisig: { address: ME, threshold: 2, signatories: [ME, SOMEONE] } });
        await ms.type('5');
        await ms.choosePayee('stash');
        await ms.submit();
        assert.equal(ms.reviews.length, 1, 'the plan goes to the multisig review');
        const call = api.registry.createType('Call', ms.reviews[0].callHex);
        assert.deepEqual(call.args[0].map(name), ['staking.bondExtra', 'staking.setPayee']);
        ms.close();
        const other = await card({ data: staker([1, 2]), connected: SOMEONE });
        await other.type('5');
        await other.submit();
        assert.equal(nothingSent(other), 0);
        assert.equal(other.errorText(), SC['SC-110']);
        other.close();
        const c = await card({ data: staker([1, 2]) });
        await c.choosePayee('stash');
        await c.submit();
        assert.equal(c.sent[0].action.key, 'staking.bondNominate', 'the status card');
        assert.equal(c.sent[0].action.params.destination, 'this account');
        c.close();
    });
});

describe('the rewards destination: signed only when changed in Advanced, exactly as reviewed (5.2; M7, M8, M9)', () => {
    test('a first stake starts on "Add to my stake" (decision Q3); the other two bond with the chosen destination and say so', async () => {
        const c = await card({ data: firstTimer() });
        assert.equal(c.sc('SC-65'), 'Where rewards go');
        assert.deepEqual(['staked', 'stash', 'account'].map(v => c.radio(v).checked), [true, false, false]);
        assert.equal(c.q('.stake-payee-account').hidden, true, 'no address field until asked for');
        await c.type('150');
        await c.choosePayee('stash');
        assert.deepEqual(c.lines(), ['Stake 150 PDEX', 'Send rewards to this account', 'Choose 8 validators']);
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bond', 'staking.nominate']);
        assert.ok(signedCalls(c)[0].args[1].isStash);
        c.close();
    });
    test('existing staker: the current setting is shown, nothing is signed for it until it changes', async () => {
        const c = await card({ data: staker([1, 2]), payee: { kind: 'stash', account: '' } });
        assert.deepEqual(['staked', 'stash', 'account'].map(v => c.radio(v).checked), [false, true, false]);
        assert.equal(c.primary().disabled, true);
        await c.choosePayee('staked');
        assert.deepEqual(c.lines(), ['Send rewards to your stake']);
        assert.equal(c.primary().textContent.trim(), 'Sign and change rewards', 'SC-52');
        await c.choosePayee('stash');
        assert.deepEqual(c.lines(), [], 'back to the current setting: an unchanged setting is never re-sent (M7)');
        assert.equal(c.primary().disabled, true);
        await c.choosePayee('staked');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.setPayee']);
        assert.ok(signedCalls(c)[0].args[0].isStaked);
        c.close();
    });
    test('Stash: setPayee(Stash), and with an amount and validators, all three in the order of the plan', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('3');
        await c.choosePayee('stash');
        await c.addFromList(V(7));
        assert.deepEqual(c.lines(), ['Add 3 PDEX to your stake', 'Send rewards to this account', 'Replace your validators with these 3']);
        assert.equal(c.primary().textContent.trim(), 'Sign and stake');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra', 'staking.setPayee', 'staking.nominate']);
        assert.ok(signedCalls(c)[1].args[0].isStash);
        c.close();
    });
    test('another account: a valid Polkadex address is echoed, SC-70 shows next to the primary, setPayee(Account) is signed', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.choosePayee('account');
        assert.equal(c.q('.stake-payee-account').hidden, false);
        assert.equal(c.sc('SC-69'), 'Rewards account');
        assert.equal(c.q('#stake-payee-account').getAttribute('data-input-kind'), 'address', 'the existing paste and clear field');
        assert.equal(c.primary().disabled, true, 'no address yet');
        assert.equal(c.reason(), 'Enter a valid Polkadex address.');
        await c.typeAccount(OTHER);
        assert.equal(c.q('#stake-payee-msg').textContent.trim(), c.tab.ctx.stakingShortAddress(OTHER), 'the short address echoed');
        assert.deepEqual(c.lines(), [`Send rewards to ${OTHER}`]);
        assert.equal(c.sc('SC-70'), 'Rewards will go to an account that is not this one. Check that you control it.');
        assert.ok(c.q('[data-sc="SC-70"]').closest('#stake-sign'), 'SC-70 sits in the review, next to the primary (M9)');
        await c.submit();
        const call = signedCalls(c)[0];
        assert.equal(name(call), 'staking.setPayee');
        assert.ok(call.args[0].isAccount);
        assert.equal(ss58(call.args[0].asAccount), OTHER);
        assert.equal(c.sent[0].action.params.destination, OTHER);
        c.close();
    });
    test('an invalid other-account address is refused before signing: SC-71, nothing built or sent', async () => {
        for (const bad of ['', 'not an address', OTHER.slice(0, -2), NOT_88, '0x' + '11'.repeat(32)]) {
            const c = await card({ data: staker([1, 2]) });
            await c.choosePayee('account');
            await c.typeAccount(bad);
            assert.equal(c.primary().disabled, true, `"${bad}" lets the primary act`);
            assert.equal(c.reason(), 'Enter a valid Polkadex address.');
            if (bad) assert.equal(c.sc('SC-71'), 'Enter a valid Polkadex address.');
            assert.deepEqual(c.lines(), []);
            await c.submit();
            assert.equal(nothingSent(c), 0, `"${bad}" was sent`);
            assert.equal(c.built.length, 0);
            assert.equal(c.errorText(), 'Enter a valid Polkadex address.');
            c.close();
        }
    });
    test('the field is never rewritten: the typed address stays through a view switch and back', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.choosePayee('account');
        await c.typeAccount('  ' + OTHER + ' ');
        await c.click('#stake-view-switch');
        await c.click('#stake-view-switch');
        assert.equal(c.q('#stake-payee-account').value, '  ' + OTHER + ' ');
        assert.ok(c.radio('account').checked);
        await c.submit();
        assert.equal(ss58(signedCalls(c)[0].args[0].asAccount), OTHER);
        c.close();
    });
    test('the rewards account is the current one: shown, and not re-sent', async () => {
        const c = await card({ data: staker([1, 2]), payee: { kind: 'account', account: OTHER } });
        assert.ok(c.radio('account').checked);
        assert.equal(c.q('#stake-payee-account').value, OTHER);
        assert.equal(c.primary().disabled, true);
        await c.typeAccount(OTHER + ' ');
        assert.deepEqual(c.lines(), []);
        c.close();
    });
    test('a current setting that could not be read is never offered for change (no silent replacement)', async () => {
        for (const payee of ['failed', null]) {
            const c = await card({ data: staker([1, 2]), payee });
            assert.equal(c.q('#stake-rewards fieldset').disabled, true, `${payee}: the radios are inactive`);
            assert.deepEqual(['staked', 'stash', 'account'].map(v => c.radio(v).checked), [false, false, false], 'no destination the user did not choose');
            assert.equal(c.sc('SC-14e'), 'Could not read where your rewards go. This action does not change it.');
            // A forced change event (a script, an old browser) still plans nothing about rewards.
            await c.choosePayee('stash');
            await c.type('5');
            await c.submit();
            assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra'], `${payee}: rewards were signed`);
            c.close();
        }
    });
    test('none set (amber in simple): no radio is checked until the user picks one', async () => {
        const c = await card({ data: staker([1, 2]), payee: { kind: 'none', account: '' } });
        assert.deepEqual(['staked', 'stash', 'account'].map(v => c.radio(v).checked), [false, false, false]);
        assert.equal(c.primary().disabled, true);
        await c.choosePayee('staked');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.setPayee']);
        c.close();
    });
    test('the simple view never signs setPayee (M8); the choice made in Advanced is kept for Advanced', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('5');
        await c.choosePayee('stash');
        await c.click('#stake-view-switch');
        assert.equal(c.sc('SC-14'), 'Rewards are added to your stake, so they earn too.', 'Simple states the chain setting');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra']);
        await c.click('#stake-view-switch');
        assert.ok(c.radio('stash').checked, 'switching never loses the rewards setting');
        c.close();
    });
});

describe('switching views keeps the amount, the selection and the rewards setting both ways (5.1, M4, M5)', () => {
    test('Advanced to Simple to Advanced, with a hand selection', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        await c.removePick(V(8));
        await c.removePick(V(7));
        await c.choosePayee('stash');
        const sel = c.selected();
        await c.click('#stake-view-switch');
        assert.equal(c.q('#stake-view-switch').getAttribute('aria-pressed'), 'false');
        assert.equal(c.input().value, '150');
        assert.equal(c.sc('SC-30b'), '6 validators chosen by you');
        c.q('#stake-view-switch').focus();
        await c.click('#stake-view-switch');
        assert.equal(c.input().value, '150');
        assert.deepEqual(c.selected(), sel);
        assert.ok(c.radio('stash').checked);
        assert.equal(c.doc.activeElement && c.doc.activeElement.id, 'stake-view-switch', 'switching keeps focus on the switch');
        c.close();
    });
    test('Simple to Advanced: the automatic picks arrive selected and marked "Chosen for you"', async () => {
        const c = await card({ data: firstTimer(), view: 'simple' });
        await c.type('150');
        await c.click('#stake-view-switch');
        assert.deepEqual(c.selected(), [1, 2, 3, 4, 5, 6, 7, 8].map(V));
        for (const a of c.selected()) assert.ok(c.q(`#stake-selected-list [data-addr="${a}"] [data-chip="chosen"]`), `${a} not marked`);
        assert.ok(c.q(`#stake-validator-list [data-addr="${V(1)}"] [data-chip="chosen"]`), 'marked in the list too');
        assert.equal(c.q(`#stake-validator-list [data-addr="${V(9)}"] [data-chip="chosen"]`), null);
        assert.equal(c.input().value, '150');
        c.close();
    });
});

describe('"Use the automatic choice" asks before it discards a hand selection (SC-40 to SC-43; M5)', () => {
    test('a hand selection: the confirmation, "Keep my selection" changes nothing, "Replace my selection" puts the rule\'s picks', async () => {
        const c = await card({ data: firstTimer() });
        await c.click('#stake-clear-btn');
        await c.addFromList(V(10));
        await c.addFromList(V(11));
        await c.click('[data-stake-action="auto"]');
        assert.equal(c.sc('SC-43'), 'Use the automatic choice');
        assert.equal(c.sc('SC-40'), 'This replaces your own selection of 2 validators with 8 chosen for you.');
        assert.deepEqual(c.selected(), [V(10), V(11)], 'nothing changes before the answer');
        assert.equal(c.doc.activeElement && c.doc.activeElement.getAttribute('data-stake-action'), 'auto-keep', 'focus on the safe answer');
        await c.click('[data-stake-action="auto-keep"]');
        assert.equal(c.sc('SC-40'), '');
        assert.deepEqual(c.selected(), [V(10), V(11)]);
        await c.click('[data-stake-action="auto"]');
        assert.equal(c.sc('SC-41'), 'Replace my selection');
        assert.equal(c.sc('SC-42'), 'Keep my selection');
        await c.click('[data-stake-action="auto-replace"]');
        assert.deepEqual(c.selected(), [1, 2, 3, 4, 5, 6, 7, 8].map(V));
        assert.ok(c.q(`#stake-selected-list [data-addr="${V(1)}"] [data-chip="chosen"]`));
        assert.ok(!c.q(`#stake-validator-list [data-addr="${V(10)}"] .stake-val-add`).disabled, 'the list follows the selection');
        c.close();
    });
    test('an empty selection takes the rule\'s picks without asking', async () => {
        const c = await card({ data: firstTimer() });
        await c.click('#stake-clear-btn');
        await c.click('[data-stake-action="auto"]');
        assert.equal(c.sc('SC-40'), '');
        assert.equal(c.selected().length, 8);
        c.close();
    });
    test('an existing staker\'s own validators are asked for too, and the replacement is reviewed as one', async () => {
        const c = await card({ data: staker([10, 11, 12]) });
        await c.click('[data-stake-action="auto"]');
        assert.equal(c.sc('SC-40'), 'This replaces your own selection of 3 validators with 8 chosen for you.');
        await c.click('[data-stake-action="auto-replace"]');
        assert.deepEqual(c.lines(), ['Replace your validators with these 8']);
        c.close();
    });
});

describe('Call details: the calls buildStakeTx builds, decoded from the built transaction (5.2, M6; known item 3)', () => {
    const shownCalls = (c) => c.qa('#stake-sign .stake-calls > li[data-call]').map(li => ({ call: li.getAttribute('data-call'), text: li.textContent.replace(/\s+/g, ' ').trim() }));
    test('every state of the plan: the disclosure lists exactly the signed calls, arguments as built, the wrapper named', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('3');
        await c.choosePayee('account');
        await c.typeAccount(OTHER);
        await c.addFromList(V(7));
        const cd = c.q('#stake-sign details.stake-call-details');
        assert.equal(cd.querySelector('summary').textContent.trim(), 'Call details');
        assert.equal(cd.open, false);
        assert.equal(c.q('#stake-sign .stake-calls').getAttribute('data-wrapper'), 'utility.batchAll');
        const shown = shownCalls(c);
        assert.deepEqual(shown.map(s => s.call), ['staking.bondExtra', 'staking.setPayee', 'staking.nominate']);
        assert.match(shown[0].text, /3000000000000 \(3 PDEX\)/);
        assert.match(shown[1].text, new RegExp(`Account ${OTHER}`));
        assert.deepEqual(c.qa('#stake-sign .stake-calls > li[data-call="staking.nominate"] [data-addr]').map(e => e.getAttribute('data-addr')), [V(1), V(2), V(7)]);
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), shown.map(s => s.call), 'what is signed is what Call details listed');
        c.close();
    });
    test('guard: when the built transaction differs from the plan, Call details shows the built one', async () => {
        const c = await card({ data: staker([1, 2]) });
        // An api whose bondExtra builds 1 PDEX more than asked: the plan says 3, the transaction 4.
        const staking = new Proxy(api.tx.staking, { get: (t, k) => (k === 'bondExtra' ? (v) => t.bondExtra(BigInt(v) + PDEX) : t[k]) });
        c.tab.ctx.globalApi = { tx: { staking, utility: api.tx.utility }, registry: api.registry };
        await c.type('3');
        assert.deepEqual(c.lines(), ['Add 3 PDEX to your stake'], 'the plan line');
        const shown = shownCalls(c);
        assert.equal(shown.length, 1);
        assert.match(shown[0].text, /4000000000000 \(4 PDEX\)/, `Call details re-describes the plan: ${shown[0].text}`);
        c.close();
    });
    test('the simple view\'s Call details come from the same built transaction', async () => {
        const c = await card({ data: staker([1, 2]), view: 'simple' });
        const staking = new Proxy(api.tx.staking, { get: (t, k) => (k === 'bondExtra' ? (v) => t.bondExtra(BigInt(v) + PDEX) : t[k]) });
        c.tab.ctx.globalApi = { tx: { staking, utility: api.tx.utility }, registry: api.registry };
        await c.type('3');
        const li = c.q('#stake-simple .stake-calls > li[data-call="staking.bondExtra"]');
        assert.ok(li, 'no bondExtra in the simple Call details');
        assert.match(li.textContent, /4000000000000 \(4 PDEX\)/);
        c.close();
    });
});

describe('the multisig co-signer sees the payee change (known item 1)', () => {
    test('the review of a stake batch with setPayee lists the payee change, decoded', async () => {
        const plan = stakePlan.planStakeCalls({ hasBond: true, amountPlanck: 5n * PDEX, currentTargets: [V(1)], targets: [V(1)], currentPayee: { kind: 'staked' }, payee: { kind: 'account', account: OTHER } });
        const tx = stakePlan.buildStakeTx(api, plan, { stash: ME });
        const call = api.registry.createType('Call', tx.method.toHex());
        // What the multisig review modal draws under "Call to run" (lib/multisig-view.js).
        const html = renderCallHtml(callToTree(call), {});
        assert.match(html, /setPayee|set_payee/);
        assert.ok(html.includes(OTHER) || html.includes(decodeAddress(OTHER).toString()), 'the destination account is in the review');
        // The pending-operation label (lib/validator-delegate.js, frozen) names it as well.
        assert.equal(describeValidatorCall(call), 'Updating your stake: bond 5 PDEX more, change where rewards go');
    });
});

describe('Your selection: past return, warnings and chips (5.2, states 5 to 7; SC-90 to SC-95; known item 2)', () => {
    const list = () => [...fullList({
        1: { identity: { hasIdentity: true, verified: false, parent: null } },
        3: { perf: { 28: { status: 'new', apr: null, erasUsed: 3, electedEras: 3, reliability: 100 } } },
        4: { active: false },
        5: { blocked: true },
        6: { perf: { 28: { status: 'ok', apr: 5, erasUsed: 28, electedEras: 28, missedEras: 0, reliability: 100 } } },
        7: { exposurePages: 2 },
        8: { slashEras: [480] },
        9: { commission: 100 },
        10: { commissionHistory: { raisedRecently: true, pendingRaise: false } },
        11: { commissionHistory: { raisedRecently: false, pendingRaise: true } }
    })];
    test('the range of the selection with its basis; SC-91 names the ones without history', async () => {
        const c = await card({ data: staker([1, 2, 3]), snapshots: [await snapshotOf(list())] });
        assert.equal(c.sc('SC-20'), 'Past return');
        assert.equal(c.sc('SC-21'), '19.5% to 20.0% a year');
        assert.equal(c.sc('SC-22'), 'What these 2 validators paid per PDEX over the last 28 eras, after commission. Past rewards, not a guarantee.');
        assert.equal(c.sc('SC-91'), '1 have no reward history yet and are not in the past return figure.');
        c.close();
    });
    test('SC-91 in the simple view too, where the range excludes them (state 7)', async () => {
        const c = await card({ data: staker([1, 2, 3]), snapshots: [await snapshotOf(list())], view: 'simple' });
        assert.equal(c.sc('SC-91'), '1 have no reward history yet and are not in the past return figure.');
        c.close();
    });
    test('not active, low return, blocked: SC-90, SC-92 and the red SC-93', async () => {
        const c = await card({ data: staker([1, 4, 5, 6]), snapshots: [await snapshotOf(list())] });
        assert.equal(c.sc('SC-90'), '1 of your 4 validators are not active this era and earn nothing until they are elected.');
        assert.equal(c.sc('SC-92'), 'Validator F paid well below the typical validator over the last 28 eras.');
        assert.equal(c.sc('SC-93'), 'Validator E does not accept new stake. The network will most likely reject this, and the fee is still charged.');
        assert.ok(c.q('[data-sc="SC-93"]').closest('.is-error'), 'SC-93 is red');
        assert.ok(c.q('[data-sc="SC-90"]').closest('.is-warn'), 'SC-90 is amber');
        c.close();
    });
    test('no estimate when none has history: SC-24a, and no range', async () => {
        const c = await card({ data: staker([3]), snapshots: [await snapshotOf(list())] });
        assert.equal(c.sc('SC-24a'), SC['SC-24a']);
        assert.equal(c.sc('SC-21'), '');
        c.close();
    });
    test('the chip map of 5.2: each chip once, its role, its icon and its word; never on an action', async () => {
        const c = await card({ data: staker([1, 2]), snapshots: [await snapshotOf([...list(), val(13, 18, { identity: { hasIdentity: true, verified: false, parent: V(1) } }), val(14, 18, { perf: null })])] });
        await c.click('[data-status="all"]');
        const sel = c.q('select[data-f="maxCommission"]') || c.q('input[data-f="maxCommission"]');
        sel.value = '100';
        c.ev(sel, 'input');
        await flush();
        for (const k of ['notBlocked', 'noSlash']) { const b = c.q(`input[data-f="${k}"]`); b.checked = false; c.ev(b, 'change'); await flush(); }
        const chip = (a, key) => c.q(`#stake-validator-list .stake-validator-item[data-addr="${a}"] [data-chip="${key}"]`);
        const want = [
            [V(4), 'waiting', 'is-wait', 'bx-time-five', 'Waiting'],
            [V(5), 'blocked', 'is-error', 'bx-block', 'Blocked'],
            [V(10), 'raised', 'is-wait', 'bx-trending-up', 'Raised recently'],
            [V(11), 'raising', 'is-wait', 'bx-trending-up', 'Raising now'],
            [V(8), 'slashed', 'is-error', 'bx-error-circle', 'Slashed'],
            [V(9), 'commission100', 'is-error', 'bx-error-circle', '100% commission'],
            [V(6), 'low', 'is-wait', 'bx-trending-down', 'Low return'],
            [V(7), 'pages', 'is-wait', 'bx-layer', 'Many payout pages'],
            [V(3), 'nohistory', 'is-neutral', 'bx-dots-horizontal-rounded', 'No history yet'],
            [V(14), 'nohistory', 'is-neutral', 'bx-dots-horizontal-rounded', 'No history yet'],
            [V(13), 'same', 'is-info', 'bx-link', 'Same identity'],
            [V(1), 'chosen', null, null, null]
        ];
        for (const [a, key, role, ic, word] of want) {
            if (key === 'chosen') { assert.equal(chip(a, key), null, 'the current set is not "chosen for you"'); continue; }
            const el = chip(a, key);
            assert.ok(el, `no ${key} chip on ${a}`);
            assert.ok(el.classList.contains('ui-chip') && el.classList.contains(role), `${key}: ${el.className}`);
            assert.ok(el.querySelector(`.bx.${ic}[aria-hidden="true"]`), `${key}: icon`);
            assert.equal(el.textContent.trim(), word);
        }
        assert.equal(chip(V(6), 'low').getAttribute('title'), SC['SC-94']);
        assert.equal(chip(V(7), 'pages').getAttribute('title'), SC['SC-95']);
        assert.ok(!/WAITING|BLOCKED|SLASHED|RAISING NOW|RAISED RECENTLY|SAME IDENTITY/.test(c.q('#stake-validator-list').textContent), 'the upper-case badges are gone');
        for (const b of c.qa('button').filter(c.shown)) {
            if (b.classList.contains('validate-primary')) continue;
            assert.ok(!/\bis-(positive|wait|info|ok|warn|error|step|neutral)\b/.test(b.className), `a coloured action ${b.className}`);
        }
        c.close();
    });
    test('selection rows show each validator\'s past return or "No history yet" before signing (M2)', async () => {
        const c = await card({ data: staker([1, 3]), snapshots: [await snapshotOf(list())] });
        const row = (a) => c.q(`#stake-selected-list .stake-validator-item[data-addr="${a}"]`).textContent.replace(/\s+/g, ' ');
        assert.match(row(V(1)), /Validator A.*20\.00% a year/);
        assert.match(row(V(3)), /Validator C.*No history yet/);
        c.close();
    });
});

describe('one primary per state, and no accent on an action (sections 6, 8)', () => {
    test('every advanced state shows exactly one .validate-primary, or none where the spec says none', async () => {
        const inactive = Object.fromEntries(APRS.map((_, i) => [i + 1, { active: false }]));
        const states = [
            ['1 first, empty', { data: firstTimer() }, null, 1],
            ['1 first, amount', { data: firstTimer() }, '150', 1],
            ['2 existing, add', { data: staker() }, '5', 1],
            ['3 existing, unchanged', { data: staker() }, null, 1],
            ['5 unhealthy', { data: staker([1, 20]), snapshots: [await snapshotOf([...fullList(), val(20, 18, { active: false })])] }, null, 1],
            ['8 staked, none chosen', { data: staker([]) }, null, 1],
            ['9 cannot stake', { data: firstTimer({ free: 101.02, transferable: 100.02 }) }, null, 0],
            ['10 over', { data: firstTimer() }, '499.99', 1],
            ['11 low reserve', { data: firstTimer() }, '499.9', 1],
            ['12 below the minimum', { data: firstTimer() }, '50', 1],
            ['13 list failed', { data: firstTimer(), snapshots: [new Error('x')] }, null, 1],
            ['13 none eligible', { data: firstTimer(), snapshots: [await snapshotOf(fullList(inactive))] }, null, 1]
        ];
        for (const [label, o, typed, want] of states) {
            const c = await card(o);
            if (typed) await c.type(typed);
            assert.equal(c.primaries(), want, `${label}: ${c.primaries()} primaries`);
            c.close();
        }
    });
    test('state 8 and state 9 panels show in Advanced; state 13 shows SC-112 in the list', async () => {
        const a = await card({ data: staker([]) });
        assert.equal(a.sc('SC-140'), SC['SC-140']);
        a.close();
        const b = await card({ data: firstTimer({ free: 101.02, transferable: 100.02 }) });
        assert.match(b.sc('SC-115'), /^To stake you need at least/);
        b.close();
        const d = await card({ data: firstTimer(), snapshots: [new Error('x')] });
        assert.equal(d.q('#stake-validator-list').textContent.trim().startsWith(SC['SC-112']), true, d.q('#stake-validator-list').textContent);
        d.close();
    });
});

describe('layout: the order a keyboard and a phone meet (section 8)', () => {
    test('focus order in Advanced: amount, Max, rewards, search, presets, status, selects, filters, list, selection, Call details, primary', async () => {
        const c = await card({ data: staker([1, 2]) });
        await c.type('2');
        const order = ['#stake-amount-input', '#stake-max-btn', '#stake-rewards input[name="stake-payee"]', '#stake-validator-search', '[data-preset="recommended"]',
            '[data-status="active"]', 'select[data-f="aprWindow"]', 'input[data-f="noRecentRaise"]', '#stake-validator-list .stake-validator-item', '#stake-selected-list .stake-val-remove',
            '#stake-sign details.stake-call-details summary', '#submit-stake-tx-btn'];
        const all = Array.from(c.doc.querySelectorAll('#stake-modal *'));
        const at = order.map(s => all.indexOf(c.q(s)));
        assert.ok(at.every(i => i >= 0), `missing: ${order.filter((s, i) => at[i] < 0).join(', ')}`);
        assert.deepEqual(at.slice().sort((x, y) => x - y), at, `DOM order: ${order.join(' > ')}`);
        c.close();
    });
    test('styles: two columns at 1280 (360 px left), one column at 640 and below with Your selection before the filters', () => {
        const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
        assert.match(css, /\.stake-modal-body\.is-advanced\s*\{[^}]*grid-template-columns:\s*360px/);
        const mobile = css.slice(css.lastIndexOf('@media (max-width: 640px)'));
        assert.match(css, /\.stake-modal-body\.is-advanced [^{]*#stake-selection[^{]*\{[^}]*order:\s*\d/);
        assert.ok(mobile.length > 0);
        assert.match(css, /\.stake-val-apr\s*\{[^}]*color:\s*var\(--text-primary\)/, 'row figures in --text-primary; green stays on the one summary figure');
    });
});

describe('cross-file promises', () => {
    test('script.js stays under its line ceiling; the stake files never read the commission-only estimate (M10)', () => {
        const lines = (SCRIPT.match(/\n/g) || []).length;
        assert.ok(lines < 14697, `script.js has ${lines} lines`);
        for (const f of ['lib/stake-card-view.js', 'lib/stake-advanced-view.js', 'lib/stake-picker-view.js']) {
            const src = stripComments(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
            assert.ok(!/apy\.js|estimatedApy|realApy|currentApy/.test(src), f);
            for (const id of new Set(src.match(/SC-\d+[a-z]?\b/g) || [])) assert.ok(id in SC, `${f}: ${id} is not in STAKE_COPY`);
            assert.ok(!/[–—]/.test(src), `${f} has a dash`);
        }
    });
    test('submitStakeTx plans with the card\'s rewards choice; the card builds Call details with buildStakeTx on the live api', () => {
        const body = bodyOf(stripComments(SCRIPT), 'submitStakeTx');
        assert.match(body, /planOptions\(\)/);
        assert.match(bodyOf(stripComments(SCRIPT), 'stakeCardView'), /api: \(\) => globalApi/);
    });
});
