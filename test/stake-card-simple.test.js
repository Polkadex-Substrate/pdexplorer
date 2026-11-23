// The Stake PDEX card's simple view (WP2 of design 2026-11-22-stake-card-simple-and-advanced.md,
// sections 2, 3, 4.2, 6, 7, 8, 9; CEO decisions of 2026-11-23: eight picks, no automatic re-pick for an
// existing staker, rewards added to the stake, Max leaves 1.2 PDEX, one atomic batchAll).
//
// Everything here runs the REAL page code: the stake modal markup is sliced out of index.html, the
// REAL openStakeModal, submitStakeTx, fillStakeMax, the picker glue and submitSignedTx are lifted from
// script.js into a wallet-world tab (real wallet session, real signer lookup against a fake
// extension), and the view is lib/stake-card-view.js over real lib/stake-pick.js and lib/stake-plan.js.
// globalApi is a REAL ApiPromise booted from the mainnet 394 metadata; only the transaction watcher is
// a recorder (it keeps the unsigned transaction submitSignedTx hands it). The validator list is a
// snapshot run through the real loadPickerData.
//
// Strings are checked by spec id, verbatim: each element that carries a spec string says which in
// data-sc. Names that do not exist in script.js are skipped when lifting, so the file also runs
// against the code before the change. Addresses are filler bytes at prefix 88; the names are
// "Validator A" to "Validator P". None belongs to anyone.

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

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MODAL = HTML.slice(HTML.indexOf('<div id="stake-modal"'), HTML.indexOf('<!-- Payout Rewards Modal -->'));
const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const PDEX = 10n ** 12n;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 1)); };
const V = (n) => addr(40 + n);
const LETTER = (n) => String.fromCharCode(64 + n);

const LIFT = ['openStakeModal', 'loadStakeChoice', 'stakeCardView', 'submitStakeTx', 'fillStakeMax', 'submitSignedTx', 'showStakeError', 'clearStakeError',
    'stakeMaxNominations', 'renderStakeSelected', 'renderStakeValidatorList', 'stakePickerView', 'addStakeValidator', 'removeStakeValidator',
    'getStakeableBalance', 'batchTx', 'buildBondOrExtra', 'formatDuration'];
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
async function snapshotOf(list, { full = true } = {}) {
    // Not built yet: the snapshot route answers with an empty list and the picker falls back to /api/validators.
    return loadPickerData(async (url) => (url.endsWith('validator-choice')
        ? (full ? { validators: list, activeEra: ERA, maxNominations: 16, exposurePageSize: 256 } : { status: 'Initializing', validators: [] })
        : { validators: list.map(v => ({ address: v.address, name: v.name, commission: v.commission, totalStake: v.totalStake })), commissionHistoryEra: ERA }));
}

// ── wallet payloads (/api/wallet) ──
const NETWORK = { minStake: 100, eraDurationMs: 86_400_000, unbondingMs: 28 * 86_400_000 };
const firstTimer = (balance = { free: 501, transferable: 500 }, stakingOver = {}) => ({ address: ME, balance,
    staking: { totalStaked: 0, activeStaked: 0, nominating: [], ledgerRead: 'ok', controller: null, ...stakingOver }, network: NETWORK });
const staker = (nominating = [1, 2], stakingOver = {}) => ({ address: ME, balance: { free: 1000, transferable: 500 },
    staking: { totalStaked: 200, activeStaked: 200, nominating: nominating.map(n => ({ address: V(n), name: `Validator ${LETTER(n)}` })), ledgerRead: 'ok', controller: ME, ...stakingOver },
    network: NETWORK });

// One open Stake card. snapshots: what loadValidatorsForPicker returns, call by call (an Error throws;
// the last one repeats). payee: what the chain read of Staking.Payee gives ('failed' for a read error).
async function card({ data, snapshots, payee = { kind: 'staked', account: '' }, keep, connected = ME, storage = null, multisig = null }) {
    const ext = fakeExtension('polkadot-js', [{ address: ME, name: 'One' }]);
    const profile = makeProfile({ extensions: [ext] });
    profile.local.setItem('pdex_wallet_address', connected);
    profile.local.setItem('pdex_wallet_source', 'polkadot-js');
    if (storage) for (const [k, v] of Object.entries(storage)) profile.local.setItem(k, v);
    const tab = openTab(profile, { path: '/wallet/' + data.address });
    const doc = tab.root.ownerDocument;
    doc.body.insertAdjacentHTML('beforeend', MODAL);
    tab.ctx.window.localStorage = profile.local;
    const queue = (snapshots || [await snapshotOf(fullList())]).slice();
    const sent = [], built = [], reviews = [];
    let loads = 0;
    Object.assign(tab.ctx, stakePlan, stakeCardView, {
        FEE_MARGIN, pdexToPlanck, maxNominationsFrom, createStakePicker, payeeOf, Math, Number, parseFloat, BigInt,
        stakingFormatPDEX: (n) => Number(n || 0).toFixed(4), stakingFormatNumber: (n) => String(n), showTxNotice: () => {},
        currentWalletData: data, stakeSelected: new Map(), stakeValidators: [], stakePicker: null, stakeCard: null,
        validatorsCache: null, validatorsCacheAt: 0, VALIDATORS_CACHE_TTL: 60_000, stakeQuotaWarned: false,
        loadValidatorsForPicker: async () => {
            loads++;
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
    vm.runInContext(LIFT.map(lift).join(''), tab.ctx);
    await tab.fn('openStakeModal')(keep);
    await flush();
    const q = (s) => doc.querySelector('#stake-modal ' + s);
    const qa = (s) => Array.from(doc.querySelectorAll('#stake-modal ' + s));
    const shown = (el) => { for (let e = el; e; e = e.parentElement) { if (e.hidden || (e.style && e.style.display === 'none')) return false; if (e.tagName === 'DETAILS' && !e.open && el !== e && !el.closest('summary')) return false; } return !!el; };
    const sc = (id) => { const els = qa(`[data-sc="${id}"]`).filter(shown); return els.length ? els.map(e => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ') : ''; };
    const input = () => doc.getElementById('stake-amount-input');
    const primary = () => doc.getElementById('submit-stake-tx-btn');
    const type = async (v) => { const i = input(); i.value = v; i.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); await flush(); };
    const click = async (sel) => { const el = q(sel); assert.ok(el, `no ${sel} in the card`); el.click(); await flush(); };
    const errorText = () => { const e = doc.getElementById('stake-modal-error'); return !e || e.style.display === 'none' ? '' : e.textContent; };
    const submit = async () => { await tab.fn('submitStakeTx')(); await flush(); };
    const primaries = () => qa('.validate-primary').filter(shown).length;
    return { tab, doc, q, qa, sc, shown, input, primary, type, click, errorText, submit, primaries, sent, built, reviews, loads: () => loads, profile, close: () => tab.close() };
}

// The words a person reads in the card, with the closed disclosures folded and hidden parts left out.
function visibleWords(c) {
    const body = c.q('.stake-modal-body') || c.doc.getElementById('stake-modal');
    const clone = body.cloneNode(true);
    for (const e of Array.from(clone.querySelectorAll('[hidden], [style*="display: none"], [style*="display:none"], .sr-only'))) e.remove();
    for (const d of Array.from(clone.querySelectorAll('details:not([open])'))) for (const ch of Array.from(d.children)) if (ch.tagName !== 'SUMMARY') ch.remove();
    return (clone.textContent.match(/\S+/g) || []).length;
}
// The text a person reads in the simple view, without the call names and arguments ("Call details").
function readableText(c) {
    const region = c.q('#stake-simple');
    if (!region) return '';
    const clone = region.cloneNode(true);
    for (const e of Array.from(clone.querySelectorAll('.stake-call-details, [hidden]'))) e.remove();
    return clone.textContent.replace(/\s+/g, ' ');
}
const listed = (c, sel = '.stake-pick-list li[data-addr]') => c.qa(sel).map(li => li.getAttribute('data-addr'));
const signedCalls = (c, i = 0) => { const top = decode(c.sent[i].tx); return name(top) === 'utility.batchAll' ? top.args[0] : [top]; };

const SC32 = 'Chosen by past return, highest first, from validators that are active now, have at least 7 eras of reward history, accept new stake, take 10% commission or less with no recent raise, were not penalised in the last 84 eras, rarely miss blocks, and paid at least three quarters of the typical return. One per operator identity.';
const SC25 = 'Each era the network places your stake behind one or a few of your validators, so your return depends on which. That is why this is a range.';

describe('first-time staker: one field, one button, the automatic choice stated (sections 3.1, 4.1, state 1)', () => {
    test('the title row, the amount and an inactive primary that says why', async () => {
        const c = await card({ data: firstTimer() });
        assert.equal(c.doc.getElementById('stake-title')?.textContent.trim(), 'Stake PDEX', 'SC-01');
        const sw = c.q('#stake-view-switch');
        assert.ok(sw, 'no Advanced switch in the title row');
        assert.equal(sw.textContent.trim(), 'Advanced', 'SC-60');
        assert.equal(sw.getAttribute('title'), 'Choose validators, rewards and amounts yourself');
        assert.equal(sw.getAttribute('aria-pressed'), 'false');
        assert.equal(c.sc('SC-03'), 'Amount to stake (PDEX)');
        assert.equal(c.sc('SC-04'), 'You can stake up to 499.8 PDEX.', 'transferable 500 less the 0.2 PDEX reserve, exact');
        assert.equal(c.q('#stake-max-btn')?.getAttribute('title'), 'Max leaves 1 PDEX that must stay in the account and 0.2 PDEX for network fees.', 'SC-05 as the Max title');
        const fields = c.qa('input, select, textarea').filter(c.shown);
        assert.deepEqual(fields.map(f => f.id), ['stake-amount-input'], 'one required input in the simple view');
        assert.equal(c.input().getAttribute('inputmode'), 'decimal');
        assert.equal(c.primaries(), 1);
        assert.equal(c.primary().textContent.trim(), 'Sign and stake');
        assert.equal(c.primary().disabled, true, 'nothing to sign without an amount');
        assert.equal(c.sc('SC-55a'), 'Enter an amount to continue.');
        assert.equal(c.sc('SC-10'), 'What happens');
        assert.equal(c.sc('SC-12'), 'It starts earning from the next era, the network\'s reward period of about 24 hours.', 'the era length from the chain');
        assert.equal(c.sc('SC-13'), 'Getting it back takes 28 days after you unstake, and it earns nothing while it waits.', 'the unbonding period from the chain');
        assert.equal(c.sc('SC-14'), 'Rewards are added to your stake, so they earn too.');
        assert.ok(c.q('[data-sc="SC-13"]')?.closest('.ui-panel.is-warn.is-line'), 'SC-13 is the one amber line of the block');
        c.close();
    });
    test('eight validators chosen by the rule, behind one closed disclosure that states the rule', async () => {
        const c = await card({ data: firstTimer() });
        const d = c.q('details.stake-validators');
        assert.ok(d, 'no validators disclosure');
        assert.equal(d.open, false, 'the disclosure starts closed');
        assert.equal(c.sc('SC-30'), '8 validators chosen for you');
        assert.equal(c.sc('SC-31'), 'Validators run the network. Your stake backs them and shares their rewards.');
        d.open = true;
        assert.deepEqual(listed(c), [1, 2, 3, 4, 5, 6, 7, 8].map(V), 'the top eight by past return, in rank order');
        assert.equal(c.q('.stake-pick-list li[data-addr]')?.textContent.replace(/\s+/g, ' ').trim(), 'Validator A, 20.0% a year, 5% commission (the validator\'s cut)', 'SC-33');
        assert.equal(c.sc('SC-36'), `Based on the 28 eras up to era ${ERA - 1}.`);
        assert.equal(c.sc('SC-32'), SC32);
        assert.equal(c.sc('SC-25'), SC25);
        assert.equal(c.sc('SC-35'), 'Choose validators myself');
        assert.equal(c.sc('SC-20'), 'Past return');
        assert.equal(c.sc('SC-21'), '16.5% to 20.0% a year');
        assert.equal(c.sc('SC-22'), 'What these 8 validators paid per PDEX over the last 28 eras, after commission. Past rewards, not a guarantee.');
        c.close();
    });
    test('an amount makes the summary say what is locked and what it earned; the primary is active', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        assert.equal(c.sc('SC-11'), 'You stake 150 PDEX. It is locked while staked.');
        assert.equal(c.sc('SC-23'), 'On 150 PDEX that was about 24.75 to 30 PDEX a year.');
        assert.equal(c.primary().disabled, false);
        assert.equal(c.sc('SC-55a'), '', 'no reason under an active primary');
        assert.equal(c.input().value, '150');
        c.close();
    });
    test('word budget: at most 130 words with the disclosure closed, before and after an amount', async () => {
        const c = await card({ data: firstTimer() });
        const empty = visibleWords(c);
        assert.ok(empty > 60 && empty <= 130, `${empty} words before an amount`);
        await c.type('150');
        const typed = visibleWords(c);
        assert.ok(typed > empty && typed <= 130, `${typed} words with an amount`);
        c.close();
    });
    test('no "bond", "nominate", "APR" or "APY" in what a person reads (call names live in Call details)', async () => {
        for (const data of [firstTimer(), staker()]) {
            const c = await card({ data });
            await c.type('150');
            for (const d of c.qa('details')) d.open = true;
            const text = readableText(c);
            assert.ok(text.length > 200, 'the simple view rendered');
            assert.ok(!/\b(bond\w*|nominat\w*|APR|APY)\b/i.test(text), `a chain word in the simple view: ${(text.match(/\b(bond\w*|nominat\w*|APR|APY)\b/i) || [])[0]}`);
            c.close();
        }
    });
});

describe('the review is the plan, and the plan is what is signed (M2, M6)', () => {
    test('Call details lists the plan lines and the calls; signing sends exactly those calls, the picks in the order shown', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        const cd = c.q('details.stake-call-details');
        assert.ok(cd, 'no Call details');
        assert.deepEqual(c.qa('.stake-plan-lines li').map(li => li.textContent.trim()), ['Stake 150 PDEX', 'Choose 8 validators'], 'SC-80a, SC-80c');
        assert.deepEqual(c.qa('.stake-calls > li[data-call]').map(li => li.getAttribute('data-call')), ['staking.bond', 'staking.nominate']);
        assert.equal(c.q('.stake-calls')?.getAttribute('data-wrapper'), 'utility.batchAll', 'two calls go in one atomic batchAll');
        const shownTargets = c.qa('.stake-calls > li[data-call="staking.nominate"] [data-addr]').map(e => e.getAttribute('data-addr'));
        assert.deepEqual(shownTargets, listed(c), 'the call details name the validators the list shows');
        await c.submit();
        assert.equal(c.errorText(), '');
        assert.equal(c.sent.length, 1, 'one transaction handed to the watcher');
        assert.equal(name(decode(c.sent[0].tx)), 'utility.batchAll');
        const calls = signedCalls(c);
        assert.deepEqual(calls.map(name), c.qa('.stake-calls > li[data-call]').map(li => li.getAttribute('data-call')), 'the signed calls are the calls the review lists');
        assert.equal(calls[0].args[0].toBigInt(), 150n * PDEX);
        assert.ok(calls[0].args[1].isStaked, 'rewards are added to the stake');
        assert.deepEqual(calls[1].args[0].map(ss58), shownTargets, 'the signed validators are the ones the card shows, in order');
        assert.equal(c.input().value, '150');
        c.close();
    });
    test('a multisig account: the review receives the same batchAll', async () => {
        const c = await card({ data: firstTimer(), multisig: { address: ME, threshold: 2, signatories: [ME, SOMEONE] } });
        await c.type('150');
        await c.submit();
        assert.equal(c.reviews.length, 1);
        const call = api.registry.createType('Call', c.reviews[0].callHex);
        assert.equal(name(call), 'utility.batchAll');
        assert.deepEqual(call.args[0][1].args[0].map(ss58), listed(c));
        c.close();
    });
});

describe('amounts: never rewritten, checked in planck (M3, M4; states 9 to 12)', () => {
    test('Max fills 499.8 only when pressed and states the reserve; renders, blur and a list reload leave the field alone', async () => {
        const c = await card({ data: firstTimer() });
        assert.equal(c.input().value, '');
        assert.equal(c.sc('SC-05'), '', 'SC-05 shows after Max is pressed');
        await c.click('#stake-max-btn');
        assert.equal(c.input().value, '499.8');
        assert.equal(c.sc('SC-05'), 'Max leaves 1 PDEX that must stay in the account and 0.2 PDEX for network fees.');
        assert.equal(c.sc('SC-104'), '', 'Max itself never leaves too little');
        await c.type('12.5000');
        for (const ev of ['blur', 'change', 'focusout']) c.input().dispatchEvent(new c.doc.defaultView.Event(ev, { bubbles: true }));
        await flush();
        assert.equal(c.input().value, '12.5000', 'the typed amount is never reformatted');
        await c.tab.fn('loadStakeChoice')();
        await flush();
        assert.equal(c.input().value, '12.5000', 'a list reload does not touch the field');
        c.close();
    });
    test('over the limit: SC-101 with the exact limit and SC-102; the field stays; the primary is inactive; SC-102 writes the limit only when pressed', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('499.99');
        assert.equal(c.sc('SC-101'), 'That is more than this account can stake. The most is 499.8 PDEX.');
        assert.ok(c.q('[data-sc="SC-101"]')?.closest('.validate-msg.is-error'), 'a red message');
        assert.equal(c.sc('SC-102'), 'Use 499.8 PDEX');
        assert.equal(c.input().value, '499.99');
        assert.equal(c.primary().disabled, true);
        await c.click('[data-sc="SC-102"]');
        assert.equal(c.input().value, '499.8');
        assert.equal(c.sc('SC-101'), '');
        c.close();
    });
    test('payable above Max: the amber SC-104 line, the primary stays active, and it signs as typed', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('499.9');
        assert.equal(c.sc('SC-104'), 'This leaves 0.1 PDEX free. You need free PDEX to pay the fee when you claim rewards or unstake.');
        assert.ok(c.q('[data-sc="SC-104"]')?.closest('.ui-panel.is-warn.is-line'), 'an amber line, not a red message');
        assert.equal(c.primary().disabled, false);
        await c.submit();
        assert.equal(signedCalls(c)[0].args[0].toBigInt(), 499_900_000_000_000n);
        c.close();
    });
    test('below the smallest first stake and not an amount: red messages, the field unchanged', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('50');
        assert.equal(c.sc('SC-105'), 'The smallest first stake is 100 PDEX.');
        assert.equal(c.primary().disabled, true);
        await c.type('1,5');
        assert.equal(c.sc('SC-100'), 'Enter an amount in PDEX, for example 250.');
        assert.equal(c.input().value, '1,5');
        assert.equal(c.primary().disabled, true);
        c.close();
    });
    test('not enough for a first stake (state 9): SC-115 in place of the summary, the field and the primary inactive', async () => {
        const c = await card({ data: firstTimer({ free: 101.02, transferable: 100.02 }) });
        assert.equal(c.sc('SC-115'), 'To stake you need at least 101.05 PDEX free: the smallest stake of 100 PDEX, 1 PDEX that must stay in the account, and the network fee. This account has 101.02 PDEX free.');
        assert.ok(c.q('[data-sc="SC-115"]')?.closest('.ui-panel.is-warn'), 'an amber panel');
        assert.equal(c.sc('SC-10'), '', 'no summary');
        assert.equal(c.input().disabled, true);
        assert.equal(c.primaries(), 0, 'no primary in state 9');
        c.close();
    });
    test('a failed signature keeps the card, the amount and the picks', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        const before = listed(c);
        c.tab.ctx.trackSignedTx = (o) => ({ start() {}, buildFailed() {}, send: async () => { o.onError('Cancelled in the wallet.'); } });
        await c.submit();
        assert.equal(c.errorText(), 'Cancelled in the wallet.');
        assert.equal(c.input().value, '150');
        assert.deepEqual(listed(c), before);
        assert.equal(c.primary().disabled, false, 'the primary is active again');
        c.close();
    });
});

describe('the pool and the list: short, empty, not built yet, failed (states 13; section 4.1)', () => {
    const only = (k) => Object.fromEntries(APRS.map((_, i) => [i + 1, i < k ? {} : { active: false }]));
    test('three eligible: all three, and SC-37 says so', async () => {
        const c = await card({ data: firstTimer(), snapshots: [await snapshotOf(fullList(only(3)))] });
        assert.equal(c.sc('SC-30'), '3 validators chosen for you');
        assert.equal(c.sc('SC-37'), 'Only 3 validators pass every check right now, so 3 were chosen.');
        c.close();
    });
    test('none eligible: SC-38, no pick, the primary inactive with SC-122, "Choose validators myself" offered', async () => {
        const c = await card({ data: firstTimer(), snapshots: [await snapshotOf(fullList(only(0)))] });
        assert.equal(c.sc('SC-38'), 'No validator passes every check right now, so none was chosen for you.');
        await c.type('150');
        assert.equal(c.primary().disabled, true);
        assert.equal(c.sc('SC-122'), 'Validators cannot be chosen right now, so there is nothing to sign yet.');
        assert.ok(c.qa('[data-sc="SC-35"]').filter(c.shown).length >= 1, 'Choose validators myself is offered');
        c.close();
    });
    test('snapshot not built yet: SC-114 and Try again; a first stake cannot be signed', async () => {
        const c = await card({ data: firstTimer(), snapshots: [await snapshotOf(fullList(), { full: false })] });
        assert.equal(c.sc('SC-114'), 'Reward history is still being built, so past returns and some filters are not available yet.');
        assert.equal(c.sc('SC-113'), 'Try again');
        await c.type('150');
        assert.equal(c.primary().disabled, true);
        assert.equal(c.sc('SC-122'), 'Validators cannot be chosen right now, so there is nothing to sign yet.');
        c.close();
    });
    test('list failed: SC-112 and Try again, which loads again and picks', async () => {
        const c = await card({ data: firstTimer(), snapshots: [new Error('down'), await snapshotOf(fullList())] });
        assert.equal(c.sc('SC-112'), 'Could not load the validator list.');
        await c.type('150');
        await c.click('[data-sc="SC-113"]');
        assert.equal(c.sc('SC-112'), '');
        assert.equal(c.sc('SC-30'), '8 validators chosen for you');
        assert.equal(c.input().value, '150', 'Try again keeps the amount');
        assert.equal(c.primary().disabled, false);
        c.close();
    });
    test('an existing staker can still add PDEX while the list is down (the plan has no nominate)', async () => {
        const c = await card({ data: staker(), snapshots: [new Error('down')] });
        await c.type('5');
        assert.equal(c.primary().disabled, false);
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra']);
        c.close();
    });
});

describe('the pick is checked again at the press (section 4.2)', () => {
    test('a pick that left the active set since the card opened: nothing is sent, the choice is redone in the open disclosure, SC-39', async () => {
        const first = await snapshotOf(fullList());
        const later = await snapshotOf(fullList({ 3: { active: false } }));
        const c = await card({ data: firstTimer(), snapshots: [first, later] });
        await c.type('150');
        assert.ok(listed(c).includes(V(3)));
        await c.submit();
        assert.equal(c.sent.length, 0, 'nothing was sent with a pick that earns nothing');
        assert.equal(c.sc('SC-39'), 'The validator list changed while this was open. Check the new choice, then sign.');
        assert.equal(c.q('[data-sc="SC-39"]')?.getAttribute('role'), 'status');
        assert.equal(c.q('details.stake-validators')?.open, true, 'the disclosure opens on the new choice');
        assert.ok(!listed(c).includes(V(3)) && listed(c).includes(V(9)), 'the new choice drops the inactive validator');
        await c.submit();
        assert.equal(c.sent.length, 1);
        assert.deepEqual(signedCalls(c)[1].args[0].map(ss58), listed(c));
        c.close();
    });
});

describe('Simple and Advanced share one state (sections 2, 5.1; M5)', () => {
    test('"Choose validators myself" opens Advanced on the search with the amount and the picks; an edit there is "chosen by you"', async () => {
        const c = await card({ data: firstTimer() });
        await c.type('150');
        const d = c.q('details.stake-validators');
        if (d) d.open = true;
        await c.click('[data-sc="SC-35"]');
        assert.equal(c.q('#stake-view-switch')?.getAttribute('aria-pressed'), 'true');
        assert.equal(c.q('#stake-simple')?.hidden, true, 'the simple view is hidden');
        assert.equal(c.doc.activeElement && c.doc.activeElement.id, 'stake-validator-search', 'focus moves to the validator search');
        assert.equal(c.profile.local.getItem('pdex_stake_view_v1'), 'advanced', 'the view is remembered');
        assert.equal(c.input().value, '150');
        const picked = c.qa('#stake-selected-list [data-addr]').map(e => e.getAttribute('data-addr'));
        assert.deepEqual(picked, [1, 2, 3, 4, 5, 6, 7, 8].map(V), 'Advanced shows the automatic picks selected');
        c.q('#stake-selected-list [data-addr="' + V(8) + '"] .stake-val-remove').click();
        await flush();
        await c.click('#stake-view-switch');
        assert.equal(c.q('#stake-simple')?.hidden, false);
        assert.equal(c.sc('SC-30b'), '7 validators chosen by you');
        assert.equal(c.input().value, '150', 'switching never clears the amount');
        await c.submit();
        assert.deepEqual(signedCalls(c)[1].args[0].map(ss58), [1, 2, 3, 4, 5, 6, 7].map(V));
        c.close();
    });
    test('the remembered view opens Advanced; anything else opens Simple', async () => {
        const a = await card({ data: firstTimer(), storage: { pdex_stake_view_v1: 'advanced' } });
        assert.equal(a.q('#stake-view-switch')?.getAttribute('aria-pressed'), 'true');
        assert.equal(a.q('#stake-simple')?.hidden, true);
        a.close();
        const b = await card({ data: firstTimer(), storage: { pdex_stake_view_v1: 'weird' } });
        assert.equal(b.q('#stake-view-switch')?.getAttribute('aria-pressed'), 'false');
        assert.equal(b.q('#stake-simple')?.hidden, false);
        b.close();
    });
});

describe('existing stakers: never re-picked, a replacement only offered (sections 3.3, 4.2; decision Q2; M7, M8)', () => {
    test('all earning: "stay as they are", add-only wording, the rewards setting read and stated, and only bondExtra is signed', async () => {
        const c = await card({ data: staker([1, 2]), payee: { kind: 'staked', account: '' } });
        assert.equal(c.sc('SC-03b'), 'Amount to add (PDEX)');
        assert.equal(c.sc('SC-30c'), 'Your 2 validators stay as they are');
        assert.equal(c.sc('SC-14'), 'Rewards are added to your stake, so they earn too.');
        assert.equal(c.sc('SC-160'), '', 'no replacement offered when all earn');
        assert.equal(c.sc('SC-21'), '19.5% to 20.0% a year', 'the return of the staker\'s own validators');
        assert.equal(c.primary().disabled, true);
        assert.equal(c.sc('SC-55a'), 'Enter an amount to continue.');
        await c.type('5');
        assert.equal(c.sc('SC-11b'), 'You add 5 PDEX to the 200 PDEX you have staked.');
        assert.deepEqual(c.qa('.stake-plan-lines li').map(li => li.textContent.trim()), ['Add 5 PDEX to your stake']);
        assert.equal(c.primary().textContent.trim(), 'Sign and stake');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra'], 'the validators are not re-sent');
        assert.equal(signedCalls(c)[0].args[0].toBigInt(), 5n * PDEX);
        c.close();
    });
    test('the rewards line follows the chain: this account, another account, none, read failed; nothing about rewards is signed', async () => {
        const cases = [[{ kind: 'stash', account: '' }, 'SC-14b', 'Rewards are paid to this account as spendable PDEX.'],
            [{ kind: 'account', account: SOMEONE }, 'SC-14c', `Rewards are paid to another account: ${SOMEONE.slice(0, 6)}...${SOMEONE.slice(-4)}.`],
            [{ kind: 'none', account: '' }, 'SC-14d', 'Rewards are not being paid to any account. Set where they go in Advanced.'],
            ['failed', 'SC-14e', 'Could not read where your rewards go. This action does not change it.']];
        for (const [payee, id, want] of cases) {
            const c = await card({ data: staker([1, 2]), payee });
            assert.equal(c.sc(id), want, id);
            await c.type('5');
            await c.submit();
            assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra'], `${id}: setPayee is never signed from the simple view`);
            c.close();
        }
    });
    test('some not earning: SC-160 and "See a replacement"; adding PDEX before confirming signs no nominate', async () => {
        const c = await card({ data: staker([1, 20]), snapshots: [await snapshotOf([...fullList(), val(20, 18, { active: false, name: 'Validator T' })])] });
        assert.equal(c.sc('SC-160'), '1 of your 2 validators are not earning for you.');
        assert.ok(c.q('[data-sc="SC-160"]')?.closest('.ui-panel.is-warn'), 'an amber panel');
        assert.equal(c.sc('SC-161a'), 'See a replacement');
        assert.ok(c.q('[data-sc="SC-161a"]')?.classList.contains('validate-secondary'), 'a secondary, not a second primary');
        assert.equal(c.primaries(), 1);
        await c.type('5');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.bondExtra'], 'no automatic re-pick: nothing changes until the user asks');
        c.close();
    });
    test('the replacement: Kept, Removed with the reason, Added on screen; then exactly that list is signed; "Keep my validators" undoes it', async () => {
        const snap = await snapshotOf([...fullList(), val(20, 18, { active: false, name: 'Validator T' })]);
        const c = await card({ data: staker([1, 20]), snapshots: [snap] });
        await c.click('[data-sc="SC-161a"]');
        assert.deepEqual(listed(c, '[data-group="kept"] li[data-addr]'), [V(1)]);
        assert.deepEqual(listed(c, '[data-group="removed"] li[data-addr]'), [V(20)]);
        assert.equal(c.q('[data-group="removed"] li[data-addr] [data-sc="SC-164a"]')?.textContent.trim(), 'not active this era');
        assert.deepEqual(listed(c, '[data-group="added"] li[data-addr]'), [2, 3, 4, 5, 6, 7, 8].map(V));
        assert.deepEqual(['SC-163a', 'SC-163b', 'SC-163c'].map(c.sc), ['Kept', 'Removed', 'Added']);
        assert.equal(c.sc('SC-30d'), 'Replacement: keep 1, replace 1');
        assert.equal(c.sc('SC-03c'), 'Amount to add (PDEX, optional)');
        assert.equal(c.primary().disabled, false, 'the amount is optional once a replacement is shown');
        assert.equal(c.primary().textContent.trim(), 'Sign and update validators', 'SC-51');
        assert.deepEqual(c.qa('.stake-plan-lines li').map(li => li.textContent.trim()), ['Replace your validators with these 8']);
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.nominate']);
        assert.deepEqual(signedCalls(c)[0].args[0].map(ss58), [1, 2, 3, 4, 5, 6, 7, 8].map(V), 'kept, then added');
        await c.click('[data-sc="SC-161b"]');
        assert.equal(c.sc('SC-30c'), 'Your 2 validators stay as they are');
        assert.equal(c.primary().disabled, true, 'back to nothing to sign');
        c.close();
    });
    test('"Change validators" with a keep list opens on the proposal built from it', async () => {
        const snap = await snapshotOf([...fullList(), val(20, 18, { active: false, name: 'Validator T' })]);
        const c = await card({ data: staker([1, 20]), snapshots: [snap], keep: [V(1)] });
        assert.equal(c.sc('SC-30d'), 'Replacement: keep 1, replace 1');
        assert.deepEqual(listed(c, '[data-group="kept"] li[data-addr]'), [V(1)]);
        c.close();
    });
    test('a stake that could not be read (leftover c): SC-109 under the inactive primary, nothing signed', async () => {
        const c = await card({ data: staker([1, 2], { totalStaked: 0, activeStaked: 0, ledgerRead: 'failed' }) });
        await c.type('150');
        assert.equal(c.sc('SC-109'), 'Your account is still loading. Try again in a moment.');
        assert.equal(c.primary().disabled, true);
        await c.submit();
        assert.equal(c.sent.length + c.built.length + c.reviews.length, 0);
        assert.equal(c.errorText(), 'Your account is still loading. Try again in a moment.');
        c.close();
    });
    test('staked with no validators (state 8): SC-140, the rule picks, and the primary signs nominate with no amount', async () => {
        const c = await card({ data: staker([]) });
        assert.equal(c.sc('SC-140'), 'Your PDEX is staked but earns nothing yet. No validators are chosen for this account.');
        assert.ok(c.q('[data-sc="SC-140"]')?.closest('.ui-panel.is-warn'));
        assert.equal(c.sc('SC-30'), '8 validators chosen for you');
        assert.equal(c.primary().disabled, false);
        assert.equal(c.primary().textContent.trim(), 'Sign and update validators');
        await c.submit();
        assert.deepEqual(signedCalls(c).map(name), ['staking.nominate']);
        assert.deepEqual(signedCalls(c)[0].args[0].map(ss58), listed(c));
        c.close();
    });
});

describe('one primary per state, gradient, and never green, amber or blue on an action (section 8)', () => {
    test('every simple state shows exactly one .validate-primary, or none where the spec says none', async () => {
        const inactive = Object.fromEntries(APRS.map((_, i) => [i + 1, { active: false }]));
        const states = [
            ['first, empty', { data: firstTimer() }, null, 1],
            ['first, amount', { data: firstTimer() }, '150', 1],
            ['over', { data: firstTimer() }, '499.99', 1],
            ['low reserve', { data: firstTimer() }, '499.9', 1],
            ['cannot stake', { data: firstTimer({ free: 101.02, transferable: 100.02 }) }, null, 0],
            ['none eligible', { data: firstTimer(), snapshots: [await snapshotOf(fullList(inactive))] }, null, 1],
            ['list failed', { data: firstTimer(), snapshots: [new Error('x')] }, null, 1],
            ['existing', { data: staker() }, '5', 1],
            ['unhealthy', { data: staker([1, 20]), snapshots: [await snapshotOf([...fullList(), val(20, 18, { active: false })])] }, null, 1],
            ['staked, none chosen', { data: staker([]) }, null, 1]
        ];
        for (const [label, o, typed, want] of states) {
            const c = await card(o);
            if (typed) await c.type(typed);
            assert.equal(c.primaries(), want, `${label}: ${c.primaries()} primaries`);
            for (const b of c.qa('button').filter(c.shown)) {
                if (b.classList.contains('validate-primary')) continue;
                assert.ok(!/\bis-(positive|wait|info|ok|warn)\b/.test(b.className), `${label}: a coloured action ${b.className}`);
            }
            c.close();
        }
    });
});

describe('the rewards setting is read from the chain (section 3.3)', () => {
    test('readStakePayee: Staking.Payee through payeeOf; a missing entry or a read error is "failed"', async () => {
        const at = SCRIPT.indexOf('function readStakePayee(');
        assert.ok(at !== -1, 'script.js has no readStakePayee: the simple view cannot state the rewards setting');
        const run = async (payee) => {
            const ctx = vm.createContext({ payeeOf, globalApi: { query: { staking: { payee } } } });
            vm.runInContext('async ' + bodyOf(SCRIPT, 'readStakePayee'), ctx);
            return vm.runInContext('readStakePayee', ctx)(ME);
        };
        const some = (v) => async () => ({ isSome: true, unwrap: () => v });
        assert.deepEqual(await run(some({ isStaked: false, isStash: true, isController: false, isAccount: false })), { kind: 'stash', account: '' });
        assert.deepEqual(await run(some({ isStaked: false, isStash: false, isController: false, isAccount: true, asAccount: SOMEONE })), { kind: 'account', account: SOMEONE });
        assert.equal(await run(async () => ({ isSome: false })), 'failed');
        assert.equal(await run(async () => { throw new Error('node gone'); }), 'failed');
    });
});

describe('cross-file promises', () => {
    test('every spec id the view uses exists in STAKE_COPY; no stake card file reads the commission-only estimate (M10)', () => {
        const src = stripComments(readFileSync(new URL('../lib/stake-card-view.js', import.meta.url), 'utf8'));
        const ids = new Set(src.match(/SC-\d+[a-z]?\b/g) || []);
        assert.ok(ids.size > 30, `the view uses ${ids.size} spec ids`);
        for (const id of ids) assert.ok(id in stakePlan.STAKE_COPY, `${id} is not in STAKE_COPY`);
        assert.ok(!/apy\.js|estimatedApy|realApy|currentApy/.test(src), 'lib/stake-card-view.js reads the commission-only estimate');
    });
    test('script.js stays wiring: the stake card body is shorter than before and the file under the ceiling', () => {
        const lines = (SCRIPT.match(/\n/g) || []).length;
        assert.ok(lines < 14697, `script.js has ${lines} lines; WP2 must lower it (14697 before)`);
    });
});
