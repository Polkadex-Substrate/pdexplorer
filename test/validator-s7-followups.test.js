// Validator onboarding, Sprint 7 (launch readiness), group B: follow-ups from
// earlier reviews. B4 and B5 live in test/wallet-session-followups.test.js
// (its wallet-world harness), B1 in test/walletconnect-exits.test.js, B8 is
// test/multisig-review-note.test.js (already on main).
//
//   B2  the wallet dashboard's "Full reward history" link uses the link
//       style, not green (green is for positive states only, BRAND.md);
//   B3  the browser tab title follows the wallet session when it changes
//       in place (a /wallet/<address> page that becomes, or stops being,
//       "My Account" without a route change);
//   B6  a bondExtra resume: a slash between review and inclusion no longer
//       shows a false "Bonded X of Y"; the Bonded event amount is compared
//       with the amount asked for;
//   B7  with nothing connected, while the Connect wallet chooser is open,
//       the header "Connect Wallet" button is an outline (one primary).
//
// Addresses are synthetic; nothing is signed or sent.

import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { rewardHistoryLinkHtml, walletDashboardSeo } from '../lib/wallet-aware.js';
import * as S from '../lib/validator-setup.js';
import { mountValidatorSetup } from '../lib/validator-setup-view.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { renderCallHtml } from '../lib/call-args-format.js';
import { callToTree } from '../lib/call-tree.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { bodyOf, readRepo } from './helpers/source.js';
import { makeProfile, openTab, fakeExtension, addr } from './helpers/wallet-world.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const A = addr(1), B = addr(2);

// ── B2 ──
describe('B2: "Full reward history" on the wallet dashboard is a link, not green', () => {
    test('the link has the link class and no colour of its own', () => {
        const w = new Window();
        w.document.body.innerHTML = rewardHistoryLinkHtml(A);
        const a = w.document.querySelector('a');
        assert.equal(a.textContent, 'Full reward history');
        assert.equal(a.getAttribute('href'), '/staking-rewards/' + encodeURIComponent(A));
        assert.ok(a.classList.contains('item-link'));
        assert.doesNotMatch(a.getAttribute('style') || '', /color/i);
        assert.doesNotMatch(rewardHistoryLinkHtml(A), /brand-secondary|--success/);
    });
    test('the dashboard header renders it from the helper, with no green inline style left', () => {
        const body = bodyOf(SCRIPT, 'renderWalletDashboard');
        assert.match(body, /rewardHistoryLinkHtml\(data\.address\)/);
        assert.doesNotMatch(body, /color:var\(--brand-secondary\)[^>]*>Full reward history/);
    });
    test('its size comes from the stylesheet, not green', () => {
        const css = readRepo('styles.css', import.meta.url);
        const rule = /\.wallet-history-link\s*\{([^}]*)\}/.exec(css);
        assert.ok(rule, 'no .wallet-history-link rule');
        assert.doesNotMatch(rule[1], /color|--brand-secondary|--success/);
    });
});

// ── B3 ──
describe('B3: the tab title follows the wallet session in place', () => {
    const short = (a) => String(a).slice(0, 6) + '...' + String(a).slice(-4);
    test('walletDashboardSeo: "My Account" for the connected wallet, else the short address', () => {
        const same = (a, b) => a === b;
        assert.equal(walletDashboardSeo(A, A, { isSame: same, shortAddr: short }).title, 'My Account - Polkadex Explorer');
        assert.equal(walletDashboardSeo(A, B, { isSame: same, shortAddr: short }).title, 'Account ' + short(A) + ' - Polkadex Explorer');
        const s = walletDashboardSeo(A, '', { isSame: same, shortAddr: short });
        assert.equal(s.title, 'Account ' + short(A) + ' - Polkadex Explorer');
        assert.equal(s.canonicalPath, '/wallet/' + A);
        assert.equal(s.noindex, true);
    });

    const tabs = [];
    afterEach(() => { while (tabs.length) { try { tabs.pop().close(); } catch (e) { /* closed */ } } });
    function tabOn(path) {
        const ext = fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }, { address: addr(2, 42), name: 'Two' }]);
        const tab = openTab(makeProfile({ extensions: [ext] }), { path });
        tabs.push(tab);
        const seo = [];
        tab.ctx.updateSeoMeta = (target, o) => { seo.push({ target, ...(o || {}) }); };
        return { tab, seo };
    }
    test('on /wallet/B, the session switches to B in place: the title becomes My Account; back to A: Account B', () => {
        const { tab, seo } = tabOn('/wallet/' + B);
        const session = tab.fn('walletSession');
        session.select(B, 'polkadot-js');
        assert.ok(seo.length >= 1, 'the title was not refreshed on the session change');
        assert.equal(seo.at(-1).target, 'wallet');
        assert.equal(seo.at(-1).title, 'My Account - Polkadex Explorer');
        session.select(A, 'polkadot-js');
        assert.match(seo.at(-1).title, /^Account .* - Polkadex Explorer$/);
        assert.doesNotMatch(seo.at(-1).title, /My Account/);
    });
    test('on another page the wallet title is left alone', () => {
        const { tab, seo } = tabOn('/validators');
        tab.fn('walletSession').select(B, 'polkadot-js');
        assert.ok(!seo.some(s => s.target === 'wallet'));
    });
    test('initWalletPage uses the same title rule', () => {
        assert.match(bodyOf(SCRIPT, 'initWalletPage'), /walletDashboardSeo\(address, getStoredWallet\(\)/);
    });
});

// ── B7 ──
describe('B7: while the chooser is open, the header Connect Wallet button is an outline', () => {
    const tabs = [];
    afterEach(() => { while (tabs.length) { try { tabs.pop().close(); } catch (e) { /* closed */ } } });
    test('nothing connected, /wallet shows the chooser: outline; leaving the page: solid again', async () => {
        const ext = fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }]);
        const tab = openTab(makeProfile({ extensions: [ext] }), { path: '/wallet' });
        tabs.push(tab);
        const btn = tab.header['connect-wallet-btn'];
        assert.equal(btn.classList.contains('is-outline'), false, 'precondition');
        await tab.visit('/wallet');
        assert.equal(btn.classList.contains('is-connected'), false, 'nothing is connected');
        assert.equal(btn.classList.contains('is-outline'), true, 'the header is a second solid primary next to the chooser');
        tab.ctx.pageScope.leave();   // the router leaves the page
        assert.equal(btn.classList.contains('is-outline'), false);
    });
    test('connecting from the chooser: the connected look, not the outline', async () => {
        const ext = fakeExtension('polkadot-js', [{ address: addr(1, 42), name: 'One' }]);
        const tab = openTab(makeProfile({ extensions: [ext] }), { path: '/wallet' });
        tabs.push(tab);
        await tab.visit('/wallet');
        tab.fn('selectWallet')(A, 'polkadot-js');
        await tab.settle();
        const btn = tab.header['connect-wallet-btn'];
        assert.equal(btn.classList.contains('is-connected'), true);
        assert.equal(btn.classList.contains('is-outline'), false);
    });
    test('the outline look: transparent, a border in the primary colour, never green', () => {
        const css = readRepo('styles.css', import.meta.url);
        const rule = /\.connect-wallet-btn\.is-outline\s*\{([^}]*)\}/.exec(css);
        assert.ok(rule, 'no .connect-wallet-btn.is-outline rule');
        assert.match(rule[1], /background:\s*transparent/);
        assert.match(rule[1], /border:\s*1px solid var\(--brand-primary\)/);
        assert.doesNotMatch(rule[1], /--brand-secondary|--success/);
    });
});

// ── B6 ──
const PDEX = 10n ** 12n;
describe('B6: a bondExtra resume compares the Bonded event amount with the amount asked for', () => {
    const STASH = encodeAddress(new Uint8Array(32).fill(101), 88);
    const state = { bonded: true, controller: STASH, active: String(500n * PDEX), validating: false };
    const review = { stash: STASH, steps: [{ kind: 'bondExtra', value: 100n * PDEX }], state, bond: 0n, extra: 100n * PDEX };
    test('slashed by 10 between review and inclusion, the event says 100 of 100: no short bond', () => {
        const after = { ...state, active: String(590n * PDEX) };
        assert.deepEqual(S.setupApplied(after, review, { bondedEvent: String(100n * PDEX) }), { applied: true, missing: [] });
    });
    test('the event says 60 of 100: short, with the event amount', () => {
        const after = { ...state, active: String(560n * PDEX) };
        assert.deepEqual(S.setupApplied(after, review, { bondedEvent: String(60n * PDEX) }), { applied: true, missing: [], bondShort: { bonded: 60n * PDEX, requested: 100n * PDEX } });
    });
    test('no event in hand (a later re-check): a bondExtra makes no short claim from the ledger', () => {
        const after = { ...state, active: String(590n * PDEX) };
        assert.deepEqual(S.setupApplied(after, review), { applied: true, missing: [] });
    });
    test('a first bond without the event still reads the ledger (nothing was bonded before, a slash cannot hide in it)', () => {
        const fresh = { stash: STASH, steps: [{ kind: 'bond', value: 500n * PDEX }], state: { bonded: false }, bond: 500n * PDEX, extra: 0n };
        assert.deepEqual(S.setupApplied({ bonded: true, active: String(400n * PDEX) }, fresh), { applied: true, missing: [], bondShort: { bonded: 400n * PDEX, requested: 500n * PDEX } });
    });
});

describe('B6: the wizard passes the Bonded event from the inclusion to the result', () => {
    let registry, ex;
    before(() => {
        registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        ex = decorateExtrinsics(registry, registry.metadata, 15);
    });
    const STASH = encodeAddress(new Uint8Array(32).fill(101), 88);
    const rep = (b, n) => b.repeat(n);
    const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
    const BLOB = '0x' + EXPECTED_LAYOUT.map(l => KEYS[l.name].slice(2)).join('');
    const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
    const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
    const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
    function fakeApi(st) {
        const validators = async () => ({ commission: num(0), blocked: { isTrue: false } });
        validators.size = async (a) => num(String(a) === STASH && st.validating ? 5 : 0);
        const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(2n * 10n ** 10n) }); return c; } }) });
        return {
            st, registry, tx, runtimeVersion: { specVersion: num(393) }, consts: { balances: { existentialDeposit: num(PDEX) } },
            query: {
                system: { account: async () => ({ nonce: num(0), data: { free: num(1000n * PDEX), reserved: num(0), frozen: num(0) } }) },
                staking: {
                    minValidatorBond: async () => num(123n * PDEX), minCommission: async () => num(30_000_000),
                    maxValidatorsCount: async () => opt(num(250)), counterForValidators: async () => num(217),
                    bonded: async (a) => opt(String(a) === STASH ? STASH : null),
                    ledger: async (c) => opt(String(c) === STASH ? { stash: STASH, total: num(st.active), active: num(st.active) } : null),
                    validators, nominators: async () => opt(null)
                },
                session: { nextKeys: async (a) => opt(String(a) === STASH ? keysCodec(KEYS) : null), queuedKeys: async () => [], keyOwner: async () => opt(null) }
            }
        };
    }
    const PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, lowestElectedTotal: String(5000n * PDEX), medianCommission: 50_000_000,
        sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off' };
    const flush = (n = 5) => new Promise(r => setTimeout(r, n));
    async function settle() { for (let i = 0; i < 8; i++) await flush(); }

    test('bond more on resume, a slash before the block: the result does not say "Bonded 90 of 100"', async () => {
        const st = { active: 500n * PDEX, validating: false };
        const api = fakeApi(st);
        const submits = [];
        const d = { account: { status: 'connected', address: STASH }, getApi: () => api, isMultisig: () => false,
            fetchJson: async (u) => { if (u === '/api/validator/params') return PARAMS; throw new Error('unexpected ' + u); },
            esc: escapeHtml, helpIcon: () => '', shortAddr: (a) => a.slice(0, 8), isAddress: () => true, revision: () => 'r1',
            submit: (o) => { submits.push(o); }, renderCall: (call) => renderCallHtml(callToTree(call), {}, { raw: false }), navigate: () => {}, apiWaitMs: 50 };
        const w = new Window({ url: 'http://localhost/validate/setup' });
        const el = w.document.createElement('div'); w.document.body.appendChild(el);
        await mountValidatorSetup(el, d); await settle();
        // Bonded with the keys registered: the wizard opens at the commission step; one step back is the bond.
        if (!el.querySelector('#validate-setup-extra')) { el.querySelector('[data-setup-action="back"]').click(); await settle(); }
        const extra = el.querySelector('#validate-setup-extra');
        assert.ok(extra, 'the resume shows the bond more field');
        extra.value = '100'; extra.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
        el.querySelector('[data-setup-action="next"]').click(); await settle();
        const c = el.querySelector('#validate-setup-commission');
        c.value = '5'; c.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
        el.querySelector('[data-setup-action="next"]').click(); await settle();
        const box = el.querySelector('#validate-setup-ack'); box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true })); await settle();
        el.querySelector('[data-setup-action="sign"]').click(); await settle();
        const o = submits[0];
        assert.ok(o, 'signed');
        assert.equal(o.action.params.bondRequested, String(100n * PDEX));
        // Included: the Bonded event says 100. A slash of 10 landed before the block, so the ledger gained 90.
        o.onStage('inBlock', { stageText: 'In block #42', outcome: { bonded: String(100n * PDEX) } });
        Object.assign(st, { active: 590n * PDEX, validating: true });
        o.onSuccess();
        await settle();
        assert.doesNotMatch(el.textContent, /Bonded 90 PDEX of the 100 PDEX/);
        assert.match(el.textContent, /You are now waiting for election/);
    });
});
