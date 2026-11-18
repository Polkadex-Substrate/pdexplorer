// The setup wizard, Sprint 3 (lib/validator-setup-view.js): /validate/setup.
// Five steps (design 5.3), opened at the first step the chain does not show
// done, one primary per view, a review that lists each call with
// human-readable amounts and the slashing panel, signing through the shared
// submitSignedTx path (fee preflight, wallet-session revision captured at the
// review, buildTx that reads everything again), multisig and legacy
// controller detection, flag gating in the real page, accessibility basics
// and a brand lint.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { mountValidatorSetup, SETUP_STEPS } from '../lib/validator-setup-view.js';
import { VALIDATE_STATEMENT } from '../lib/validator-status-view.js';
import { ctaFor } from '../lib/validator-status.js';
import { SETUP_WARNINGS, SLASH_ACK } from '../lib/validator-setup.js';
import { EXPECTED_LAYOUT, SECRET_TEXT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { renderCallHtml } from '../lib/call-args-format.js';
import { callToTree } from '../lib/call-tree.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(101), CTRL = addr(102), OTHER = addr(103), PAYEE = addr(104);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const BLOB = '0x' + EXPECTED_LAYOUT.map(l => KEYS[l.name].slice(2)).join('');

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function fakeApi(o = {}) {
    const st = { minBond: 123n * PDEX, minComm: 30_000_000, bonded: null, ledger: null, validating: false, nextKeys: null, nominators: null, owners: {}, free: 1000n * PDEX, fee: 2n * 10n ** 10n, ...o };
    const validators = async () => ({ commission: num(0), blocked: { isTrue: false } });
    validators.size = async (a) => num(String(a) === STASH && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); if (sec === 'utility') c.paymentInfo = async () => ({ partialFee: num(st.fee) }); return c; } }) });
    return {
        st, registry, tx, runtimeVersion: { specVersion: num(393) },
        consts: { balances: { existentialDeposit: num(PDEX) } },
        query: {
            system: { account: async () => ({ nonce: num(0), data: { free: num(st.free), reserved: num(0), frozen: num(0) } }) },
            staking: {
                minValidatorBond: async () => num(st.minBond), minCommission: async () => num(st.minComm),
                maxValidatorsCount: async () => opt(num(250)), counterForValidators: async () => num(217),
                bonded: async (a) => opt(String(a) === STASH ? st.bonded : null),
                ledger: async (c) => opt(st.ledger && String(c) === st.ledger.controller ? { stash: st.ledger.stash, total: num(st.ledger.active), active: num(st.ledger.active) } : null),
                validators, nominators: async () => opt(st.nominators ? { targets: st.nominators } : null)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === STASH && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => opt(st.owners[String(key)] || null)
            }
        }
    };
}
const PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, lowestElectedTotal: String(5000n * PDEX), medianCommission: 50_000_000,
    sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off' };

function dom() {
    const w = new Window({ url: 'http://localhost/validate/setup' });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const flush = (n = 5) => new Promise(r => setTimeout(r, n));
async function settle() { for (let i = 0; i < 8; i++) await flush(); }
function deps(over = {}) {
    const submits = [];
    let rev = 'r1';
    const d = {
        submits,
        setRevision: (r) => { rev = r; },
        account: { status: 'connected', address: STASH },
        getApi: () => d.api, api: fakeApi(),
        isMultisig: () => false,
        fetchJson: async (u) => { if (u === '/api/validator/params') return PARAMS; if (u.startsWith('/api/telemetry/node')) return { feed: 'ok', name: 'alpha', count: 0, nodes: [], similar: [] }; throw new Error('unexpected ' + u); },
        esc: escapeHtml, helpIcon: (s, t) => `<a href="/help/${s}" aria-label="${t}">?</a>`, shortAddr: (a) => a.slice(0, 8) + '...' + a.slice(-6),
        isAddress: (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || '')),
        revision: () => rev,
        submit: (o) => { submits.push(o); },
        renderCall: (call) => renderCallHtml(callToTree(call), {}, { raw: false }),
        navigate: () => {},
        apiWaitMs: 50,
        ...over
    };
    if (over.api) d.api = over.api;
    return d;
}
const primaries = (el) => Array.from(el.querySelectorAll('.validate-primary'));
const heading = (el) => el.querySelector('#validate-step-title').textContent.trim();
const click = async (el, sel) => { const b = el.querySelector(sel); assert.ok(b, 'missing ' + sel); b.click(); await settle(); };
const type = async (el, sel, v) => { const i = el.querySelector(sel); assert.ok(i, 'missing ' + sel); i.value = v; i.dispatchEvent(new i.ownerDocument.defaultView.Event('input', { bubbles: true })); await settle(); };
async function toReview(el, { bond = '500', commission = '5' } = {}) {
    await click(el, '[data-setup-action="next"]');               // 1: node ready
    await type(el, '#validate-setup-keys', BLOB);
    await click(el, '[data-setup-action="use-keys"]');           // 2: keys
    if (el.querySelector('#validate-setup-bond')) await type(el, '#validate-setup-bond', bond);
    await click(el, '[data-setup-action="next"]');               // 3: bond
    await type(el, '#validate-setup-commission', commission);
    await click(el, '[data-setup-action="next"]');               // 4: commission
}

describe('the wizard opens at the first unsatisfied step; one primary per view', () => {
    test('a fresh account: step 1, the statement verbatim, the step list with aria-current', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps()); await settle();
        assert.equal(heading(el), 'Start with a running node');
        assert.ok(el.textContent.includes(VALIDATE_STATEMENT));
        assert.match(el.textContent, /The explorer takes your word for this step\./);
        const items = Array.from(el.querySelectorAll('ol.validate-steps > li'));
        assert.deepEqual(items.map(li => li.querySelector('.validate-step-name').textContent), SETUP_STEPS);
        assert.equal(items[0].getAttribute('aria-current'), 'step');
        assert.equal(el.querySelectorAll('[aria-current="step"]').length, 1);
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['My node is ready']);
        assert.match(el.querySelector('.validate-setup-progress').textContent, /^Step 1 of 5: Your node$/);
        assert.ok(el.querySelector('a[href="/validate/node"]'));
    });
    test('keys and bond already on chain: opens at Commission, the satisfied steps say "Done on chain"', async () => {
        const api = fakeApi({ bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX }, nextKeys: KEYS });
        const { el } = dom(); await mountValidatorSetup(el, deps({ api })); await settle();
        assert.equal(heading(el), 'Set your commission');
        const items = Array.from(el.querySelectorAll('ol.validate-steps > li'));
        assert.match(items[1].textContent, /Done on chain/);
        assert.match(items[2].textContent, /Done on chain/);
        assert.doesNotMatch(items[3].textContent, /Done on chain/);
    });
    test('already validating with keys: nothing to sign, one primary to the status', async () => {
        const api = fakeApi({ bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX }, nextKeys: KEYS, validating: true });
        const { el } = dom(); await mountValidatorSetup(el, deps({ api })); await settle();
        assert.match(el.textContent, /This stash already validates\./);
        assert.deepEqual(primaries(el).map(b => [b.textContent.trim(), b.getAttribute('href')]), [['Open validator status', '/validate']]);
    });
    test('no wallet: one primary, Connect wallet, returning here', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps({ account: { status: 'none', address: '' } })); await settle();
        assert.deepEqual(primaries(el).map(b => [b.textContent.trim(), b.getAttribute('href')]), [['Connect wallet', '/wallet?returnTo=%2Fvalidate%2Fsetup']]);
    });
    test('a multisig wallet is detected and told this comes later (Sprint 5); nothing to sign', async () => {
        const d = deps({ isMultisig: () => true });
        const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        assert.match(el.textContent, /multisig or through a proxy is not available yet/);
        assert.equal(el.querySelector('#validate-setup-keys'), null);
        assert.equal(primaries(el).length, 0);
    });
    test('a legacy controller is refused with the controller address', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps({ api: fakeApi({ bonded: CTRL }) })); await settle();
        assert.match(el.textContent, new RegExp(`controlled by ${CTRL} \\(an older setup\\)`));
        assert.equal(el.querySelector('#validate-setup-keys'), null);
    });
    test('the chain unreachable: says so, with a secondary Retry', async () => {
        const d = deps(); d.api = null; d.getApi = () => null;
        const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await flush(80);
        assert.match(el.textContent, /The explorer cannot reach the chain right now\. Your validator is not affected\./);
        const retry = el.querySelector('[data-setup-action="retry"]');
        assert.ok(retry && !retry.classList.contains('validate-primary'));
    });
});

describe('step 2: session keys, checked against the live layout and KeyOwner', () => {
    test('the field: monospace, no autocomplete or spellcheck, described by its message, paste kind hex', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps()); await settle();
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Paste your node\'s session keys');
        const t = el.querySelector('#validate-setup-keys');
        assert.deepEqual(['autocomplete', 'spellcheck', 'data-input-kind', 'aria-describedby'].map(a => t.getAttribute(a)), ['off', 'false', 'hex', 'validate-setup-keys-msg']);
        assert.match(el.querySelector('label[for="validate-setup-keys"]').textContent, /Session keys \(0x, 388 characters\)/);
        assert.equal(el.querySelector('#validate-setup-keys-msg').getAttribute('aria-live'), 'polite');
        const use = el.querySelector('[data-setup-action="use-keys"]');
        assert.ok(use.classList.contains('validate-primary'));
        assert.equal(use.disabled, true, 'disabled until valid');
        assert.match(el.textContent, /author_rotateKeys/);
    });
    test('a secret phrase is refused in the browser, never sent', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps()); await settle();
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-keys', 'bottom drive obey lake curtain smoke basket hold race lonely fit walk');
        assert.equal(el.querySelector('#validate-setup-keys-msg').textContent, SECRET_TEXT);
        assert.equal(el.querySelector('[data-setup-action="use-keys"]').disabled, true);
    });
    test('a key registered to another account blocks with role=alert; the wizard stays on step 2', async () => {
        const api = fakeApi(); api.st.owners[KEYS.babe] = OTHER;
        const { el } = dom(); await mountValidatorSetup(el, deps({ api })); await settle();
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-keys', BLOB);
        await click(el, '[data-setup-action="use-keys"]');
        assert.equal(heading(el), 'Paste your node\'s session keys');
        const alert = el.querySelector('[role="alert"]');
        assert.ok(alert);
        assert.match(alert.textContent, new RegExp(`Key 2 \\(babe\\) is already registered to ${OTHER}`));
    });
    test('keys already registered: Keep them (primary) or Replace them (text link that shows the field)', async () => {
        const api = fakeApi({ nextKeys: KEYS });
        const { el } = dom(); await mountValidatorSetup(el, deps({ api })); await settle();
        // keys on chain, not bonded: opens at step 3; go back to 2
        assert.equal(heading(el), 'Bond from your stash');
        await click(el, '[data-setup-action="back"]');
        assert.match(el.textContent, /This stash already has session keys registered\./);
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Keep them']);
        assert.equal(el.querySelector('#validate-setup-keys'), null);
        await click(el, '[data-setup-action="replace-keys"]');
        assert.ok(el.querySelector('#validate-setup-keys'));
    });
    test('a layout the explorer does not know: no form, registration off', async () => {
        const d = deps({ fetchJson: async (u) => (u === '/api/validator/params' ? { ...PARAMS, layout: { ok: false } } : {}) });
        const api = fakeApi(); api.registry = { metadata: { pallets: [] }, lookup: { getSiType: () => null } };
        d.api = api;
        const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await click(el, '[data-setup-action="next"]');
        assert.equal(el.querySelector('#validate-setup-keys'), null);
        assert.match(el.textContent, /session key format is different/);
        assert.equal(primaries(el).length, 0);
    });
});

describe('step 3: bond, against the live MinValidatorBond and what can be bonded', () => {
    async function atBond(api = fakeApi()) {
        const { el } = dom(); const d = deps({ api }); await mountValidatorSetup(el, d); await settle();
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-keys', BLOB);
        await click(el, '[data-setup-action="use-keys"]');
        return { el, d };
    }
    test('the fields: amount (paste kind amount), Max, the live minimum and lowest elected, three payee choices', async () => {
        const { el } = await atBond();
        assert.equal(heading(el), 'Bond from your stash');
        assert.equal(el.querySelector('#validate-setup-bond').getAttribute('data-input-kind'), 'amount');
        assert.match(el.textContent, /Minimum to validate: 123 PDEX\. Lowest elected backing this era: 5,000 PDEX\./);
        const radios = Array.from(el.querySelectorAll('input[type="radio"][name="validate-setup-payee"]'));
        assert.deepEqual(radios.map(r => r.value), ['staked', 'stash', 'account']);
        assert.equal(el.querySelector('#validate-setup-payee-account').getAttribute('data-input-kind'), 'address');
        assert.match(el.textContent, /Setting up through a proxy or a multisig is not available yet/);
    });
    test('Max fills what can be bonded after the fee and the kept PDEX', async () => {
        const { el } = await atBond();
        await click(el, '[data-setup-action="max"]');
        assert.equal(el.querySelector('#validate-setup-bond').value, '997.98');
    });
    test('above what can be bonded is refused here (the chain would clamp it)', async () => {
        const { el } = await atBond();
        await type(el, '#validate-setup-bond', '999');
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Bond from your stash');
        assert.match(el.querySelector('#validate-setup-bond-msg').textContent, /That is more than this account can bond\./);
        assert.equal(el.querySelector('#validate-setup-bond').getAttribute('aria-invalid'), 'true');
    });
    test('below the live minimum is refused with the chain value', async () => {
        const { el } = await atBond(fakeApi({ minBond: 321n * PDEX }));
        await type(el, '#validate-setup-bond', '300');
        await click(el, '[data-setup-action="next"]');
        assert.equal(el.querySelector('#validate-setup-bond-msg').textContent, 'Validating needs at least 321 PDEX bonded.');
    });
    test('rewards to another account needs a Polkadex address', async () => {
        const { el } = await atBond();
        await type(el, '#validate-setup-bond', '500');
        const r = el.querySelector('input[name="validate-setup-payee"][value="account"]'); r.checked = true; r.dispatchEvent(new r.ownerDocument.defaultView.Event('change', { bubbles: true })); await settle();
        await type(el, '#validate-setup-payee-account', 'not-an-address');
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Bond from your stash');
        assert.match(el.querySelector('#validate-setup-bond-msg').textContent, /Polkadex address/);
    });
});

describe('step 4: commission against the live MinCommission', () => {
    test('below the minimum is refused; above 20% warns with the median', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps()); await settle();
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-keys', BLOB);
        await click(el, '[data-setup-action="use-keys"]');
        await type(el, '#validate-setup-bond', '500');
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Set your commission');
        assert.match(el.textContent, /Minimum: 3%\. Median of active validators: 5%\./);
        assert.equal(el.querySelector('#validate-setup-commission').getAttribute('data-input-kind'), 'amount');
        await type(el, '#validate-setup-commission', '2');
        await click(el, '[data-setup-action="next"]');
        assert.equal(el.querySelector('#validate-setup-commission-msg').textContent, 'The minimum commission on Polkadex is 3%.');
        await type(el, '#validate-setup-commission', '25');
        assert.match(el.querySelector('#validate-setup-commission-warn').textContent, /The median commission of active validators is 5%/);
    });
});

describe('step 5: review and sign', () => {
    test('each call in order, with plain words, the call name and human-readable amounts; fee, atomicity, warnings, timing', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps()); await settle();
        await toReview(el);
        assert.equal(heading(el), 'Review');
        const items = Array.from(el.querySelectorAll('ol.validate-review > li'));
        assert.deepEqual(items.map(li => li.querySelector('.validate-review-text').textContent), ['Bond 500 PDEX, rewards: added to the bond', 'Register 6 session keys', 'Ask to validate at 5% commission']);
        assert.deepEqual(items.map(li => li.querySelector('code').textContent), ['staking.bond', 'session.setKeys', 'staking.validate']);
        assert.match(items[0].textContent, /500 PDEX/);
        assert.match(el.textContent, /Estimated network fee: 0\.02 PDEX\. One signature\. If any step fails, none of them apply\./);
        for (const w of SETUP_WARNINGS) assert.ok(el.textContent.includes(w), w);
        assert.match(el.textContent, /The first era you can be elected for is era 501\./);
    });
    test('the checkbox is a real labelled checkbox; Sign and submit (the only primary) is disabled until it is ticked', async () => {
        const { el } = dom(); await mountValidatorSetup(el, deps()); await settle();
        await toReview(el);
        const box = el.querySelector('input[type="checkbox"]#validate-setup-ack');
        assert.equal(el.querySelector('label[for="validate-setup-ack"]').textContent.trim(), SLASH_ACK);
        const sign = el.querySelector('[data-setup-action="sign"]');
        assert.deepEqual(primaries(el), [sign]);
        assert.equal(sign.disabled, true);
        box.checked = true; box.dispatchEvent(new box.ownerDocument.defaultView.Event('change', { bubbles: true })); await settle();
        assert.equal(sign.disabled, false);
    });
    test('signing goes through submitSignedTx with the setup action, the stash, the revision taken at review, verify, and a buildTx that reads again', async () => {
        const d = deps();
        const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toReview(el);
        d.setRevision('r2');   // a later change must not be adopted by the request
        const box = el.querySelector('#validate-setup-ack'); box.checked = true; box.dispatchEvent(new box.ownerDocument.defaultView.Event('change', { bubbles: true })); await settle();
        await click(el, '[data-setup-action="sign"]');
        assert.equal(d.submits.length, 1);
        const o = d.submits[0];
        assert.equal(o.action.key, 'validator.setup');
        assert.deepEqual(o.action.params.expectEvents, ['utility.BatchCompleted', 'staking.Bonded', 'staking.ValidatorPrefsSet']);
        assert.equal(o.expectedWallet, STASH);
        assert.equal(o.expectedRevision, 'r1', 'the revision from when the review was shown');
        assert.equal(typeof o.verify, 'function');
        const tx = await o.buildTx(d.api);
        assert.equal(`${tx.section}.${tx.method}`, 'utility.batchAll');
        d.api.st.owners[KEYS.mixnet] = OTHER;
        await assert.rejects(o.buildTx(d.api), /Key 5 \(mixnet\) is already registered to/);
    });
    test('success is shown only once the chain shows the keys and the Validators entry', async () => {
        const d = deps();
        const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toReview(el);
        const box = el.querySelector('#validate-setup-ack'); box.checked = true; box.dispatchEvent(new box.ownerDocument.defaultView.Event('change', { bubbles: true })); await settle();
        await click(el, '[data-setup-action="sign"]');
        const o = d.submits[0];
        o.onStage('inBlock', { stageText: 'In block #42' });
        o.onSuccess();   // the events checked clean, the chain does not show it yet
        await settle();
        assert.doesNotMatch(el.textContent, /You are now waiting for election/);
        assert.match(el.textContent, /the chain does not show/);
        Object.assign(d.api.st, { bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX }, nextKeys: KEYS, validating: true });
        await click(el, '[data-setup-action="recheck"]');
        assert.match(el.textContent, /Submitted and confirmed in block #42\. You are now waiting for election\./);
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Open validator status']);
    });
    test('resume: keys identical to the registered ones and bonded: the review lists validate only', async () => {
        const api = fakeApi({ bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX }, nextKeys: KEYS });
        const { el } = dom(); await mountValidatorSetup(el, deps({ api })); await settle();
        await type(el, '#validate-setup-commission', '5');
        await click(el, '[data-setup-action="next"]');
        const items = Array.from(el.querySelectorAll('ol.validate-review > li'));
        assert.deepEqual(items.map(li => li.querySelector('code').textContent), ['staking.validate']);
        assert.match(el.textContent, /One signature\./);
    });
    test('focus moves to the step heading on every step change', async () => {
        const { el, doc } = dom(); await mountValidatorSetup(el, deps()); await settle();
        await click(el, '[data-setup-action="next"]');
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-step-title');
    });
});

describe('wiring and brand', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('the status page offers setup: "Set up a validator" for an unbonded account, "Continue setup" midway', () => {
        assert.deepEqual(ctaFor('not-bonded', { connected: true }), { label: 'Set up a validator', href: '/validate/setup' });
        assert.deepEqual(ctaFor('bonded-no-keys', { connected: true }), { label: 'Continue setup', href: '/validate/setup' });
        assert.deepEqual(ctaFor('keys-not-validating', { connected: true }), { label: 'Continue setup', href: '/validate/setup' });
        for (const s of ['waiting', 'elected-next', 'active', 'active-leaving', 'disabled']) assert.equal(ctaFor(s, { connected: true }), null, s);
        assert.equal(ctaFor('not-bonded', { connected: true, own: false }), null, 'never for another account');
    });
    test('script.js: /validate/setup mounts the wizard through submitSignedTx; under 15,000 lines', () => {
        assert.match(script, /import \{ mountValidatorSetup \} from '\.\/lib\/validator-setup-view\.js'/);
        assert.match(script, /if \(address === 'setup'\) return mountValidatorSetup\(/);
        assert.match(script, /submit: \(o\) => submitSignedTx\(o\)/);
        assert.match(script, /isMultisig: \(a\) => !!multisigStore\.find\(a\)/);
        assert.match(script, /revision: \(\) => walletSession\.revision\(\)/);
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });
    test('help: the "Set up a validator" topic, flagged, no dashes', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'validator-setup');
        assert.ok(t);
        assert.equal(t.flag, 'validate');
        assert.ok(!/[–—]/.test(t.title + t.body));
        for (const w of ['/validate/setup', 'batch', 'slashed', 'never asks for a seed']) assert.ok(t.body.includes(w), w);
    });
    test('no en or em dashes in the new modules', () => {
        for (const f of ['lib/validator-setup.js', 'lib/validator-setup-chain.js', 'lib/validator-setup-view.js']) assert.ok(!/[–—]/.test(readRepo(f, import.meta.url)), f);
    });
    test('brand: the wizard styles add no colour of their own; no inline styles; green only on the done tick', () => {
        const css = readRepo('styles.css', import.meta.url).replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }))
            .filter(r => /\.validate-(setup|step|review|warnings|ack)/.test(r.sel));
        assert.ok(rules.length >= 8, 'the wizard styles exist');
        for (const r of rules) {
            const allowed = /\.validate-step-done/.test(r.sel) ? /--brand-secondary|#[0-9a-f]{3,8}\b|--error/i : /--success|--brand-secondary|--error|#[0-9a-f]{3,8}\b|rgba?\(\s*(20|255)\s*,\s*(241|77)/i;
            assert.doesNotMatch(r.body, allowed, r.sel);
        }
        assert.doesNotMatch(stripComments(readRepo('lib/validator-setup-view.js', import.meta.url)), /style="/);
    });
    test('the explorer never asks for a seed: no secret-taking field, no author_ calls outside the guide text', () => {
        const src = stripComments(readRepo('lib/validator-setup-view.js', import.meta.url)) + stripComments(readRepo('lib/validator-setup-chain.js', import.meta.url)) + stripComments(readRepo('lib/validator-setup.js', import.meta.url));
        assert.doesNotMatch(src, /type="password"|mnemonic|seed phrase/i);
        assert.doesNotMatch(src.replace(/ROTATE_KEYS|author_rotateKeys against|run author_rotateKeys/g, ''), /author_(rotateKeys|insertKey|hasSessionKeys)/);
    });
});

// ── the real page ──
const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify({ api: { '/api/validator/params': PARAMS }, probe: ['#validate-root .validate-setup', '#nav-validate'], ...scenario })], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}
describe('/validate/setup in the real page', () => {
    test('flag off: the not-found page, no wizard', async () => {
        const r = await page({ path: 'validate/setup' });
        assert.equal(r.page, 'not-found');
        assert.equal(r.probe['#validate-root .validate-setup'].count, 0);
    });
    test('flag on: the wizard', async () => {
        const r = await page({ path: 'validate/setup', seed: { pdex_validate_enabled: '1' }, steps: [{ wait: 200 }] });
        assert.equal(r.page, 'validate');
        assert.equal(r.probe['#validate-root .validate-setup'].count, 1);
        assert.deepEqual(r.errors, []);
    });
});
