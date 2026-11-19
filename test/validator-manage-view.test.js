// The manage panel, Sprint 4 (lib/validator-manage-view.js) on /validate: the
// actions of design 5.4 for the connected stash (or its legacy controller),
// one view at a time with at most one primary, a review that lists the call
// with human-readable amounts, signing through the shared submitSignedTx path
// (fee preflight, the wallet-session revision taken at review, a buildTx that
// reads again), success only after the chain shows the change, proxies and
// multisig detected and deferred to Sprint 5, accessibility basics, the input
// audit kinds and a brand lint. Also the wiring in script.js: the manage deps,
// the /unstake entry and the validator rule in the existing unbond flow.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { mountValidatorManage } from '../lib/validator-manage-view.js';
import { mountValidatePage } from '../lib/validator-status-view.js';
import { ROTATE_RULE, COMMISSION_NOTE } from '../lib/validator-manage.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { renderCallHtml } from '../lib/call-args-format.js';
import { callToTree } from '../lib/call-tree.js';
import { auditSource } from './helpers/input-audit.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(121), CTRL = addr(122), OTHER = addr(123), PAYEE = addr(124), PROXY = addr(125);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const NEWKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const blob = (k) => '0x' + EXPECTED_LAYOUT.map(l => k[l.name].slice(2)).join('');
const BLOB = blob(KEYS), NEWBLOB = blob(NEWKEYS);

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function fakeApi(o = {}) {
    const st = { stash: STASH, minBond: 123n * PDEX, minComm: 30_000_000, bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] },
        validating: true, commission: 50_000_000, blocked: false, payee: 'Staked', nextKeys: KEYS, owners: {}, proxies: [], free: 1000n * PDEX, frozen: 500n * PDEX, fee: 2n * 10n ** 10n, ...o };
    const validators = async () => ({ commission: num(st.commission), blocked: { isTrue: !!st.blocked } });
    validators.size = async (a) => num(String(a) === st.stash && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => Object.assign((...args) => { const c = p[m](...args); c.paymentInfo = async (who) => { (st.feeReads ||= []).push(String(who)); return { partialFee: num(st.fee) }; }; return c; }, { meta: p[m] && p[m].meta }) }) });
    return {
        st, registry, tx, runtimeVersion: { specVersion: num(393) },
        consts: { balances: { existentialDeposit: num(PDEX) }, staking: { maxUnlockingChunks: num(32), bondingDuration: num(28), sessionsPerEra: num(6) } },
        query: {
            system: { account: async () => ({ nonce: num(0), data: { free: num(st.free), reserved: num(0), frozen: num(st.frozen) } }) },
            staking: {
                minValidatorBond: async () => num(st.minBond), minCommission: async () => num(st.minComm), minNominatorBond: async () => num(50n * PDEX),
                maxValidatorsCount: async () => opt(null), counterForValidators: async () => num(217), currentEra: async () => opt(num(500)),
                bonded: async (a) => opt(String(a) === st.stash ? st.bonded : null),
                ledger: async (c) => opt(st.ledger && String(c) === st.ledger.controller
                    ? { stash: st.ledger.stash, total: num(st.ledger.total), active: num(st.ledger.active), unlocking: st.ledger.unlocking.map(u => ({ value: num(u.value), era: num(u.era) })) } : null),
                validators, nominators: async () => opt(null),
                payee: async () => registry.createType('Option<RewardDestination>', st.payee)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === st.stash && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => opt(st.owners[String(key)] || null)
            },
            proxy: { proxies: async () => [st.proxies.map(p => ({ delegate: p.delegate, proxyType: { toString: () => p.type }, delay: num(p.delay || 0) })), num(0)] },
            multisig: { multisigs: Object.assign(async () => ({ isNone: true }), { entries: async () => st.pending || [] }) }
        }
    };
}
const PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, medianCommission: 50_000_000,
    sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off', sessionsPerEra: 6 };
const MODEL = (state = 'active', over = {}) => ({ address: STASH, state, rows: [{ id: 'online', word: 'Heartbeat received' }], era: { active: 500, current: 500, endsIn: 5 * 3600 }, session: { index: 3000, progress: 0.5, nextIn: 2 * 3600 }, ...over });

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
function dom() {
    const w = new Window({ url: 'http://localhost/validate' });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
function deps(over = {}) {
    const submits = [];
    let rev = 'r1';
    const d = {
        submits, setRevision: (r) => { rev = r; },
        account: { status: 'connected', address: STASH },
        getApi: () => d.api, api: fakeApi(),
        isMultisig: () => false,
        fetchJson: async (u) => { if (u === '/api/validator/params') return PARAMS; throw new Error('unexpected ' + u); },
        esc: escapeHtml, helpIcon: (s, t) => `<a href="/help/${s}" aria-label="${t}">?</a>`, shortAddr: (a) => a.slice(0, 8) + '...' + a.slice(-6),
        isAddress: (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || '')),
        isSame: (a, b) => a === b,
        revision: () => rev,
        submit: (o) => { submits.push(o); },
        renderCall: (call) => renderCallHtml(callToTree(call), {}, { raw: false }),
        apiWaitMs: 50,
        ...over
    };
    if (over.api) d.api = over.api;
    return d;
}
async function mount(over = {}, opts = {}) {
    const x = dom();
    const d = deps(over);
    await mountValidatorManage(x.el, d, { stash: STASH, model: MODEL(opts.state, opts.model), ...opts.mount });
    await settle();
    return { ...x, d };
}
const primaries = (el) => Array.from(el.querySelectorAll('.validate-primary'));
const click = async (el, sel) => { const b = el.querySelector(sel); assert.ok(b, 'missing ' + sel); b.click(); await settle(); };
const type = async (el, sel, v) => { const i = el.querySelector(sel); assert.ok(i, 'missing ' + sel); i.value = v; i.dispatchEvent(new i.ownerDocument.defaultView.Event('input', { bubbles: true })); await settle(); };
const check = async (el, sel, on = true) => { const i = el.querySelector(sel); assert.ok(i, 'missing ' + sel); i.checked = on; i.dispatchEvent(new i.ownerDocument.defaultView.Event('change', { bubbles: true })); await settle(); };
const reviewTexts = (el) => Array.from(el.querySelectorAll('ol.validate-review > li')).map(li => [li.querySelector('.validate-review-text').textContent, li.querySelector('code').textContent]);

describe('the menu for an active validator: secondary actions, no primary, links to the existing flows', () => {
    test('heading, the five actions as secondary buttons, no primary; unbond and withdraw link to /unstake', async () => {
        const { el } = await mount();
        assert.equal(el.querySelector('#validate-manage-title').textContent.trim(), 'Manage this validator');
        assert.deepEqual(Array.from(el.querySelectorAll('[data-manage-action]')).map(b => b.textContent.trim()), ['Change commission', 'Rotate keys', 'Bond more', 'Change payee', 'Stop validating']);
        for (const b of el.querySelectorAll('[data-manage-action]')) assert.ok(b.classList.contains('validate-secondary'), b.textContent);
        assert.deepEqual(primaries(el), []);
        assert.ok(el.querySelector('a[href="/unstake"]'));
    });
    test('offline this session: exactly one primary, Open the node checklist', async () => {
        const { el } = await mount({}, { model: { rows: [{ id: 'online', word: 'Offline' }] } });
        assert.deepEqual(primaries(el).map(a => [a.textContent.trim(), a.getAttribute('href')]), [['Open the node checklist', '/validate/node']]);
    });
    test('something unbonding: Rebond is offered', async () => {
        const api = fakeApi({ ledger: { controller: STASH, stash: STASH, active: 450n * PDEX, total: 500n * PDEX, unlocking: [{ value: 50n * PDEX, era: 520 }] } });
        const { el } = await mount({ api });
        assert.ok(el.querySelector('[data-manage-action="rebond"]'));
    });
    test('an unrelated wallet: nothing rendered', async () => {
        const { el } = await mount({ account: { status: 'connected', address: OTHER } });
        assert.equal(el.querySelector('[data-manage-action]'), null);
        assert.equal(el.textContent.trim(), '');
    });
    test('a legacy controller stash: controller actions shown disabled with the reason, stash actions enabled', async () => {
        const api = fakeApi({ bonded: CTRL, ledger: { controller: CTRL, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] } });
        const { el } = await mount({ api });
        const b = el.querySelector('[data-manage-action="commission"]');
        assert.equal(b.disabled, true);
        const why = el.querySelector('#' + b.getAttribute('aria-describedby'));
        assert.match(why.textContent, new RegExp(`This stash is controlled by ${CTRL} \\(an older setup\\)`));
        assert.equal(el.querySelector('[data-manage-action="keys"]').disabled, false);
        assert.equal(el.querySelector('[data-manage-action="bondExtra"]').disabled, false);
    });
    test('the legacy controller connected: controller actions enabled, stash actions disabled with the stash named', async () => {
        const api = fakeApi({ bonded: CTRL, ledger: { controller: CTRL, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] } });
        const { el } = await mount({ api, account: { status: 'connected', address: CTRL } });
        assert.equal(el.querySelector('[data-manage-action="chill"]').disabled, false);
        const k = el.querySelector('[data-manage-action="keys"]');
        assert.equal(k.disabled, true);
        assert.match(el.querySelector('#' + k.getAttribute('aria-describedby')).textContent, new RegExp(`signed by the stash ${STASH}`));
    });
    test('the chain unreachable: says so, with a secondary Retry', async () => {
        const { el } = await mount({ getApi: () => null });
        assert.match(el.textContent, /cannot reach the chain/);
        assert.ok(el.querySelector('[data-manage-action="retry"].validate-secondary'));
    });
});

describe('change commission: old to new, the live minimum, when it applies', () => {
    test('the panel: one primary (Review), the field described by its message, focus on the panel heading; Cancel returns focus', async () => {
        const { el, doc } = await mount();
        const trigger = el.querySelector('[data-manage-action="commission"]');
        await click(el, '[data-manage-action="commission"]');
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-manage-panel-title');
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Review']);
        const f = el.querySelector('#validate-manage-commission');
        assert.equal(f.getAttribute('data-input-kind'), 'amount');
        assert.ok(f.hasAttribute('data-amount-strict'));
        assert.match(f.getAttribute('aria-describedby'), /validate-manage-msg/);
        assert.match(el.textContent, /Current commission: 5%\./);
        assert.match(el.textContent, /Minimum: 3%\./);
        assert.ok(el.querySelector('input[type="checkbox"]#validate-manage-blocked'));
        await click(el, '[data-manage-action="cancel"]');
        assert.equal(doc.activeElement && doc.activeElement.getAttribute('data-manage-action'), 'commission');
        assert.ok(trigger);
    });
    test('below the live minimum is refused with the chain value', async () => {
        const { el } = await mount();
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '2');
        await click(el, '[data-manage-action="review"]');
        assert.equal(el.querySelector('#validate-manage-msg').textContent, 'The minimum commission on Polkadex is 3%. The chain refuses a lower rate.');
        assert.equal(el.querySelector('#validate-manage-commission').getAttribute('aria-invalid'), 'true');
        assert.equal(el.querySelector('ol.validate-review'), null);
    });
    test('100% needs the extra confirmation checkbox before the review', async () => {
        const { el } = await mount();
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '100');
        await click(el, '[data-manage-action="review"]');
        assert.match(el.querySelector('#validate-manage-msg').textContent, /At 100% your nominators earn nothing/);
        await check(el, '#validate-manage-confirm100');
        await click(el, '[data-manage-action="review"]');
        assert.deepEqual(reviewTexts(el), [['Change commission from 5% to 100%', 'staking.validate']]);
    });
    test('the review: old to new, the call and its arguments, the fee, when it applies, nominators see it; signing with the revision from review', async () => {
        const { el, d } = await mount();
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '7');
        await click(el, '[data-manage-action="review"]');
        assert.deepEqual(reviewTexts(el), [['Change commission from 5% to 7%', 'staking.validate']]);
        assert.ok(el.querySelector('.validate-review-args'), 'the call-args formatter output');
        assert.match(el.textContent, /Estimated network fee: 0\.02 PDEX\./);
        assert.match(el.textContent, /Applies from era 501, which starts in about 5 h\./);
        assert.ok(el.textContent.includes(COMMISSION_NOTE));
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Sign and submit']);
        d.setRevision('r2');
        await click(el, '[data-manage-action="sign"]');
        assert.equal(d.submits.length, 1);
        const o = d.submits[0];
        assert.equal(o.action.key, 'validator.manage');
        assert.equal(o.action.params.kind, 'commission');
        assert.deepEqual(o.action.params.expectEvents, ['staking.ValidatorPrefsSet']);
        assert.equal(o.expectedWallet, STASH);
        assert.equal(o.expectedRevision, 'r1', 'the revision from when the review was shown');
        assert.equal(typeof o.verify, 'function');
        const tx = await o.buildTx(d.api);
        assert.equal(`${tx.section}.${tx.method}`, 'staking.validate');
        d.api.st.minComm = 80_000_000;
        await assert.rejects(o.buildTx(d.api), /The minimum commission changed since you reviewed this: it is now 8%/);
    });
    test('success is shown only once the chain shows the new rate', async () => {
        const { el, d } = await mount();
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '7');
        await click(el, '[data-manage-action="review"]');
        await click(el, '[data-manage-action="sign"]');
        const o = d.submits[0];
        o.onStage('inBlock', { stageText: 'In block #42' });
        o.onSuccess();
        await settle();
        assert.doesNotMatch(el.textContent, /Commission is now 7%/);
        assert.match(el.textContent, /the chain does not show the change/);
        d.api.st.commission = 70_000_000;
        await click(el, '[data-manage-action="recheck"]');
        assert.match(el.querySelector('[role="status"]').textContent, /Submitted and confirmed in block #42\. Commission is now 7%\./);
    });
});

describe('rotate keys: checked like setup, the old-node rule before signing, never purge', () => {
    test('the field is the hex kind; keys registered to another account block with role=alert', async () => {
        const api = fakeApi({ owners: { [NEWKEYS.babe]: OTHER } });
        const { el } = await mount({ api });
        await click(el, '[data-manage-action="keys"]');
        const f = el.querySelector('textarea#validate-manage-keys');
        assert.equal(f.getAttribute('data-input-kind'), 'hex');
        assert.equal(f.getAttribute('spellcheck'), 'false');
        await type(el, '#validate-manage-keys', NEWBLOB);
        await click(el, '[data-manage-action="review"]');
        assert.match(el.querySelector('[role="alert"]').textContent, /Key 2 \(babe\) is already registered to/);
        assert.equal(el.querySelector('ol.validate-review'), null);
    });
    test('the keys already registered: nothing to sign', async () => {
        const api = fakeApi({ owners: Object.fromEntries(Object.values(KEYS).map(k => [k, STASH])) });
        const { el } = await mount({ api });
        await click(el, '[data-manage-action="keys"]');
        await type(el, '#validate-manage-keys', BLOB);
        await click(el, '[data-manage-action="review"]');
        assert.equal(el.querySelector('#validate-manage-msg').textContent, 'These keys are already registered to this stash. Nothing to sign.');
    });
    test('the review: session.setKeys, the timing, the old-node rule in bold weight, then sign; buildTx reads KeyOwner again', async () => {
        const { el, d } = await mount();
        await click(el, '[data-manage-action="keys"]');
        await type(el, '#validate-manage-keys', NEWBLOB);
        await click(el, '[data-manage-action="review"]');
        assert.deepEqual(reviewTexts(el), [['Register 6 new session keys', 'session.setKeys']]);
        assert.equal(el.querySelector('strong.validate-manage-rule').textContent, ROTATE_RULE);
        assert.match(el.textContent, /The new keys are used from session 3002, in about 6 h\./);
        await click(el, '[data-manage-action="sign"]');
        const o = d.submits[0];
        assert.deepEqual(o.action.params.expectEvents, []);
        d.api.st.owners[NEWKEYS.grandpa] = OTHER;
        await assert.rejects(o.buildTx(d.api), /Key 1 \(grandpa\) is already registered to/);
    });
});

describe('bond more, change payee, rebond', () => {
    test('bond more: above what can be bonded refused; Max fills it; the request carries bondRequested', async () => {
        const { el, d } = await mount();
        await click(el, '[data-manage-action="bondExtra"]');
        const f = el.querySelector('#validate-manage-amount');
        assert.equal(f.getAttribute('data-input-kind'), 'amount');
        assert.ok(f.hasAttribute('data-amount-strict'));
        await type(el, '#validate-manage-amount', '600');
        await click(el, '[data-manage-action="review"]');
        assert.match(el.querySelector('#validate-manage-msg').textContent, /^That is more than this account can bond\./);
        await click(el, '[data-manage-action="max"]');
        assert.equal(el.querySelector('#validate-manage-amount').value, '498.98');
        await type(el, '#validate-manage-amount', '100');
        await click(el, '[data-manage-action="review"]');
        assert.deepEqual(reviewTexts(el), [['Add 100 PDEX to the bond', 'staking.bondExtra']]);
        assert.match(el.textContent, /Bonded PDEX takes 28 eras, about 28 d, to unbond\./);
        await click(el, '[data-manage-action="sign"]');
        assert.equal(d.submits[0].action.params.bondRequested, String(100n * PDEX));
        assert.equal(d.submits[0].expectedWallet, STASH);
    });
    test('change payee: the current choice checked; unchanged refused; another account reviewed', async () => {
        const { el } = await mount();
        await click(el, '[data-manage-action="payee"]');
        assert.equal(el.querySelector('input[name="validate-manage-payee"]:checked').value, 'staked');
        await click(el, '[data-manage-action="review"]');
        assert.equal(el.querySelector('#validate-manage-msg').textContent, 'That is where rewards go now. Nothing would change.');
        await check(el, 'input[name="validate-manage-payee"][value="account"]');
        const acc = el.querySelector('#validate-manage-payee-account');
        assert.equal(acc.hasAttribute('hidden'), false);
        assert.equal(acc.getAttribute('data-input-kind'), 'address');
        await type(el, '#validate-manage-payee-account', PAYEE);
        await click(el, '[data-manage-action="review"]');
        assert.equal(reviewTexts(el)[0][1], 'staking.setPayee');
        assert.match(el.textContent, /Applies at once, to every payout made from now on/);
    });
    test('rebond: above what is unbonding refused; up to it reviewed', async () => {
        const api = fakeApi({ ledger: { controller: STASH, stash: STASH, active: 450n * PDEX, total: 500n * PDEX, unlocking: [{ value: 50n * PDEX, era: 520 }] } });
        const { el } = await mount({ api });
        await click(el, '[data-manage-action="rebond"]');
        await type(el, '#validate-manage-amount', '60');
        await click(el, '[data-manage-action="review"]');
        assert.equal(el.querySelector('#validate-manage-msg').textContent, 'Only 50 PDEX is unbonding, so that is the most you can rebond.');
        await type(el, '#validate-manage-amount', '50');
        await click(el, '[data-manage-action="review"]');
        assert.deepEqual(reviewTexts(el), [['Rebond 50 PDEX', 'staking.rebond']]);
    });
});

describe('stop validating: the confirmation says what happens and when', () => {
    test('consequences, one primary "Stop validating" (outline elsewhere, never the error colour), Unbond instead to the existing flow', async () => {
        const { el, d } = await mount();
        const menuBtn = el.querySelector('[data-manage-action="chill"]');
        assert.ok(!menuBtn.classList.contains('validate-primary'));
        await click(el, '[data-manage-action="chill"]');
        for (const s of ['You stay bonded and keep your session keys.', 'You stop being a candidate from the next era.', 'keep the node running until era 500 ends', 'Your nominators keep their nominations']) assert.ok(el.textContent.includes(s), s);
        assert.deepEqual(reviewTexts(el), [['Stop validating', 'staking.chill']]);
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Stop validating']);
        assert.equal(el.querySelector('a[href="/unstake"]').textContent.trim(), 'Unbond instead');
        await click(el, '[data-manage-action="sign"]');
        assert.deepEqual(d.submits[0].action.params.expectEvents, ['staking.Chilled']);
    });
});

describe('the status page mounts the manage panel for the connected wallet only', () => {
    function pageDeps(over = {}) {
        const md = deps(over.manage || {});
        return { urlAddress: over.urlAddress || '', account: over.account || { status: 'connected', address: STASH }, isSame: (a, b) => a === b,
            fetchJson: async (u) => { if (u === '/api/validator/params') return PARAMS; if (u.includes('/status')) return { ...MODEL('active'), headline: 'Active in era 500.', pill: { word: 'Active', tone: 'positive' }, rows: [] }; throw new Error('unexpected ' + u); },
            helpIcon: () => '', esc: escapeHtml, shortAddr: (a) => a, navigate: () => {}, isAddress: () => true, manage: md };
    }
    test('own active stash: the manage section appears under the status', async () => {
        const { el } = dom();
        await mountValidatePage(el, pageDeps());
        await settle();
        assert.ok(el.querySelector('#validate-manage-slot .validate-manage'));
    });
    test('no wallet connected: no manage section', async () => {
        const { el } = dom();
        await mountValidatePage(el, pageDeps({ account: { status: 'disconnected' }, urlAddress: STASH }));
        await settle();
        assert.equal(el.querySelector('#validate-manage-slot'), null);
    });
});

describe('wiring, inputs and brand', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('script.js passes the manage deps (submitSignedTx, revision, multisig) to the status page; under 15,000 lines', () => {
        assert.match(script, /manage: validateSetupDeps\(false\)/);
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });
    test('/unstake opens the existing Unstake modal on the wallet page (unbond and withdraw are not built twice)', () => {
        assert.match(script, /target === 'unstake'/);
        assert.match(script, /walletEntryIntent = 'unstake'/);
        assert.match(script, /intent === 'unstake'[\s\S]{0,200}openUnstakeModal\(\)/);
    });
    test('the existing partial unbond reads the validator rule at signing (buildCheckedUnbondTx)', () => {
        assert.match(script, /import \{ buildCheckedUnbondTx, readMaxUnbondWarning \} from '\.\/lib\/validator-manage-chain\.js'/);
        assert.match(script, /buildTx: \(api\) => buildCheckedUnbondTx\(api, \{ signer: data\.address, value: pdexToPlanck\(amtStr\) \}\)/);
    });
    test('every new text box declares its paste kind; amounts are strict', () => {
        const src = readRepo('lib/validator-manage-view.js', import.meta.url);
        const a = auditSource(src, 'lib/validator-manage-view.js');
        assert.deepEqual(a.offenders, []);
        assert.ok(a.tags.filter(t => t.status === 'kind').length >= 4, 'the audit sees the manage fields');
        for (const m of src.matchAll(/<input[^>]*data-input-kind="amount"[^>]*>/g)) assert.match(m[0], /data-amount-strict/);
    });
    test('brand: the manage styles add no colour of their own; no inline styles; no dashes', () => {
        const css = readRepo('styles.css', import.meta.url).replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] })).filter(r => /\.validate-manage/.test(r.sel));
        assert.ok(rules.length >= 3, 'the manage styles exist');
        for (const r of rules) assert.doesNotMatch(r.body, /--success|--brand-secondary|--error|#[0-9a-f]{3,8}\b|rgba?\(/i, r.sel);
        assert.doesNotMatch(stripComments(readRepo('lib/validator-manage-view.js', import.meta.url)), /style="/);
        for (const f of ['lib/validator-manage.js', 'lib/validator-manage-chain.js', 'lib/validator-manage-view.js']) assert.ok(!/[\u2013\u2014]/.test(readRepo(f, import.meta.url)), f);
    });
    test('the explorer never asks for a seed here either', () => {
        const src = ['lib/validator-manage.js', 'lib/validator-manage-chain.js', 'lib/validator-manage-view.js'].map(f => stripComments(readRepo(f, import.meta.url))).join('\n');
        assert.doesNotMatch(src, /type="password"|mnemonic|seed phrase/i);
    });
});

describe('review round 5: the menu follows the live chain, not the page model fetched at mount', () => {
    const labels = (el) => Array.from(el.querySelectorAll('[data-manage-action]')).map(b => b.textContent.trim());
    test('after a confirmed chill, Back to manage offers no Change commission and no Stop validating', async () => {
        const { el, d } = await mount();
        await click(el, '[data-manage-action="chill"]');
        await click(el, '[data-manage-action="sign"]');
        d.api.st.validating = false;
        d.submits[0].onSuccess();
        await settle();
        await click(el, '[data-manage-action="done"]');
        const l = labels(el);
        assert.ok(!l.includes('Change commission'), l.join());
        assert.ok(!l.includes('Stop validating'), l.join());
        assert.ok(l.includes('Rotate keys') && l.includes('Bond more') && l.includes('Change payee'), l.join());
        assert.doesNotMatch(el.textContent, /Commission: /);
    });
    test('after a confirmed commission change, the menu shows the new commission', async () => {
        const { el, d } = await mount();
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '7');
        await click(el, '[data-manage-action="review"]');
        await click(el, '[data-manage-action="sign"]');
        d.api.st.commission = 70_000_000;
        d.submits[0].onSuccess();
        await settle();
        await click(el, '[data-manage-action="done"]');
        assert.match(el.querySelector('.validate-setup-note').textContent, /Commission: 7%/);
        assert.ok(labels(el).includes('Change commission'));
    });
    test('Back to manage after a confirmed action also refreshes the status page when it can', async () => {
        let refreshed = 0;
        const x = dom();
        const d = deps();
        await mountValidatorManage(x.el, d, { stash: STASH, model: MODEL('active'), refresh: () => { refreshed++; } });
        await settle();
        await click(x.el, '[data-manage-action="chill"]');
        await click(x.el, '[data-manage-action="sign"]');
        d.api.st.validating = false;
        d.submits[0].onSuccess();
        await settle();
        await click(x.el, '[data-manage-action="done"]');
        assert.equal(refreshed, 1);
    });
    test('a waiting validator that is not validating any more gets the same trimmed menu', async () => {
        const api = fakeApi({ validating: false });
        const { el } = await mount({ api }, { state: 'waiting' });
        assert.ok(!labels(el).includes('Change commission'));
        assert.ok(!labels(el).includes('Stop validating'));
    });
    test('commission with the active bond below the live MinValidatorBond: refused in the form, with a Bond more link, nothing to sign', async () => {
        const api = fakeApi({ minBond: 600n * PDEX });
        const { el, d } = await mount({ api });
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '7');
        await click(el, '[data-manage-action="review"]');
        assert.equal(el.querySelector('[data-manage-action="sign"]'), null);
        assert.match(el.querySelector('#validate-manage-msg').textContent, /at least 600 PDEX bonded/);
        assert.match(el.querySelector('#validate-manage-msg').textContent, /Bond more/);
        assert.ok(el.querySelector('[data-manage-action="goto-bond"]'));
        await click(el, '[data-manage-action="goto-bond"]');
        assert.equal(el.querySelector('#validate-manage-panel-title').textContent.trim(), 'Bond more');
        assert.equal(d.submits.length, 0);
    });
    test('the status page hands the manage panel a refresh that reads the status again', () => {
        const src = stripComments(readRepo('lib/validator-status-view.js', import.meta.url));
        assert.match(src, /mountValidatorManage\([\s\S]{0,200}refresh:/);
    });
});

describe('review round 5: /unstake route card and the Max warning in the Unstake modal', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('Max on the Unstake modal reads whether the stash validates and shows the consequences before signing', () => {
        assert.match(script, /import \{[^}]*readMaxUnbondWarning[^}]*\} from '\.\/lib\/validator-manage-chain\.js'/);
        assert.match(script, /unstakeMax\.addEventListener\('click'[\s\S]{0,1600}readMaxUnbondWarning\(globalApi, data\.address\)/);
        assert.match(script, /unstake-modal-warning/);
        assert.match(readRepo('index.html', import.meta.url), /id="unstake-modal-warning"[^>]*role="status"/);
    });
    test('the warning is cleared when the amount is typed or the modal reopens', () => {
        assert.match(script, /unstakeAmtInputEl\.addEventListener\('input'[\s\S]{0,400}clearUnstakeWarning\(\)/);
        assert.match(script, /function openUnstakeModal\(\)[\s\S]{0,900}clearUnstakeWarning\(\)/);
    });
});

// ── Sprint 5: acting for the stash through a proxy or a multisig ──
// (intentional change: Sprint 4 showed "comes in a later release" here)
import { normalizeMultisig } from '../lib/multisig.js';
import { MULTISIG_CHANGE_WARNING, MULTISIG_FEE_NOTE, PROXY_FEE_NOTE } from '../lib/validator-delegate.js';
import { blake2AsHex } from '@polkadot/util-crypto';
const SA = addr(141), SB = addr(142), SC = addr(143);
const enabled = (el) => Array.from(el.querySelectorAll('[data-manage-action]')).filter(b => !b.disabled).map(b => b.getAttribute('data-manage-action'));
const describedBy = (el, kind) => { const b = el.querySelector(`[data-manage-action="${kind}"]`); const id = b && b.getAttribute('aria-describedby'); return id ? el.querySelector('#' + id).textContent : ''; };

describe('a Staking proxy of the stash: the allowed actions through proxy.proxy, keys greyed with the reason', () => {
    const asProxy = (o = {}) => ({ api: fakeApi({ proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }], ...o }), account: { status: 'connected', address: PROXY } });
    test('menu: commission, bond more, payee and stop validating enabled; rotate keys disabled, "Key rotation needs the stash on this runtime"', async () => {
        const { el } = await mount(asProxy());
        assert.deepEqual(enabled(el), ['commission', 'bondExtra', 'payee', 'chill']);
        const keys = el.querySelector('[data-manage-action="keys"]');
        assert.equal(keys.disabled, true);
        assert.match(describedBy(el, 'keys'), /^Key rotation needs the stash on this runtime\./);
        assert.match(describedBy(el, 'keys'), /Connect the stash/);
        assert.match(el.textContent, /You are connected as a Staking proxy of this stash/);
    });
    test('commission review: signed by the proxy for the stash, the proxy pays; submit wraps proxy.proxy(stash, Staking, staking.validate) and expects the proxy wallet', async () => {
        const { el, d } = await mount(asProxy());
        await click(el, '[data-manage-action="commission"]');
        await type(el, '#validate-manage-commission', '7');
        await click(el, '[data-manage-action="review"]');
        assert.match(el.textContent, new RegExp('Signed by your proxy account ' + PROXY + ' for the stash ' + STASH));
        assert.ok(el.textContent.includes(PROXY_FEE_NOTE));
        assert.deepEqual(reviewTexts(el)[0], ['Change commission from 5% to 7%', 'proxy.proxy > staking.validate']);
        assert.ok(d.api.st.feeReads.includes(PROXY), 'the fee shown is the proxy\'s');
        await click(el, '[data-manage-action="sign"]');
        assert.equal(d.submits.length, 1);
        const o = d.submits[0];
        assert.equal(o.expectedWallet, PROXY, 'the proxy signs and pays: the fee preflight runs on it');
        assert.equal(o.expectedRevision, 'r1');
        const tx = await o.buildTx(d.api);
        const call = registry.createType('Call', tx.toHex());
        assert.equal(`${call.section}.${call.method}`, 'proxy.proxy');
        assert.equal(call.args[1].unwrap().toString(), 'Staking');
        assert.equal(`${call.args[2].section}.${call.args[2].method}`, 'staking.validate');
        assert.deepEqual(o.action.params.expectEvents, ['staking.ValidatorPrefsSet']);
    });
    test('success needs the chain re-read too: the outer and inner events alone do not say "confirmed"', async () => {
        const { el, d } = await mount(asProxy());
        await click(el, '[data-manage-action="chill"]');
        await click(el, '[data-manage-action="sign"]');
        d.submits[0].onSuccess();
        await settle();
        assert.match(el.textContent, /Waiting for the chain/, 'the stash still validates in the fake chain');
        d.api.st.validating = false;
        await click(el, '[data-manage-action="recheck"]');
        assert.match(el.textContent, /Submitted and confirmed/);
    });
    test('an announcement delay: every action disabled with the explanation; nothing can be signed', async () => {
        const { el, d } = await mount(asProxy({ proxies: [{ delegate: PROXY, type: 'Staking', delay: 100 }] }));
        assert.deepEqual(enabled(el), []);
        assert.match(describedBy(el, 'commission'), /announcement delay of 100 blocks/);
        assert.equal(d.submits.length, 0);
    });
});

describe('a multisig stash: the existing multisig review, pending validator changes with their approvals', () => {
    const m = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
    const MS = m.address;
    // The stash is the multisig: the fake chain's stash is MS here.
    const msApi = (o = {}) => fakeApi({ stash: MS, bonded: MS, ledger: { controller: MS, stash: MS, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] }, ...o });
    const msDeps = (api, o = {}) => ({ api, account: { status: 'connected', address: MS }, isMultisig: (a) => a === MS, findMultisig: (a) => (a === MS ? m : null),
        multisigReview: (opts) => { (o.reviews || []).push(opts); }, ...o.extra });
    async function mountMs(api, o = {}) {
        const x = dom();
        const d = deps(msDeps(api, o));
        await mountValidatorManage(x.el, d, { stash: MS, model: MODEL('active'), ...o.mount });
        await settle();
        return { ...x, d };
    }
    test('the actions are offered to the multisig wallet (the multisig is the stash); the review names the signer fee and the change warning', async () => {
        const { el, d } = await mountMs(msApi());
        assert.deepEqual(enabled(el), ['commission', 'keys', 'bondExtra', 'payee', 'chill']);
        await click(el, '[data-manage-action="chill"]');
        assert.ok(el.textContent.includes(MULTISIG_FEE_NOTE));
        assert.ok(el.textContent.includes(MULTISIG_CHANGE_WARNING));
        assert.match(el.textContent, /Signed by the multisig .* 2 of 3 approvals/);
        await click(el, '[data-manage-action="sign"]');
        const o = d.submits[0];
        assert.equal(o.expectedWallet, MS, 'submitSignedTx hands a multisig wallet to the existing multisig review');
        assert.equal(typeof o.onMultisigEnd, 'function');
        const tx = await o.buildTx(d.api);
        assert.equal(`${tx.section}.${tx.method}`, 'staking.chill', 'the inner call; the review wraps it in asMulti');
    });
    test('an approval recorded: the panel says so and who still has to approve; closed: nothing was signed', async () => {
        const { el, d } = await mountMs(msApi());
        await click(el, '[data-manage-action="chill"]');
        await click(el, '[data-manage-action="sign"]');
        d.submits[0].onMultisigEnd('approved', { stage: 'approved', text: 'Approval submitted; waiting for the other signers.' });
        await settle();
        assert.match(el.textContent, /Approval recorded/);
        assert.match(el.textContent, /needs 2 of 3 approvals/);
        assert.ok(el.textContent.includes(MULTISIG_CHANGE_WARNING));
        await click(el, '[data-manage-action="done"]');
        await click(el, '[data-manage-action="chill"]');
        await click(el, '[data-manage-action="sign"]');
        d.submits[1].onMultisigEnd('closed', { stage: 'closed', text: '' });
        await settle();
        assert.match(el.querySelector('#validate-manage-sign-msg').textContent, /closed without recording an approval/);
    });
    test('pending validator changes for the multisig: the change, approvals of threshold, who approved, who has not; Review and approve opens the multisig review', async () => {
        const chill = ex.staking.chill();
        const hash = blake2AsHex(registry.createType('Call', chill.toHex()).toU8a());
        const pending = [[{ args: [{ toString: () => MS }, { toHex: () => hash }] }, { isSome: true, isNone: false, unwrap: () => ({ when: { height: num(900), index: num(2) }, approvals: [SB], depositor: SB, deposit: num(1) }) }]];
        const reviews = [];
        const api = msApi({ pending });
        const x = dom();
        const d = deps({ ...msDeps(api, { reviews }), recoverCall: async () => chill.toHex() });
        await mountValidatorManage(x.el, d, { stash: MS, model: MODEL('active') });
        await settle();
        const el = x.el;
        const list = el.querySelector('.validate-manage-pending');
        assert.ok(list, 'the pending list');
        assert.match(list.textContent, /Stop validating/);
        assert.match(list.textContent, /1 of 2 approvals/);
        assert.match(list.textContent, /Started at block #900/);
        assert.ok(list.textContent.includes(MULTISIG_CHANGE_WARNING));
        await click(el, '[data-manage-action="ms-approve"]');
        assert.equal(reviews.length, 1);
        assert.deepEqual([reviews[0].mode, reviews[0].callHash, reviews[0].callHex, reviews[0].multisig.address], ['approve', hash, chill.toHex(), MS]);
    });
});
