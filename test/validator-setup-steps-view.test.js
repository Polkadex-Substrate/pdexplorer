// Validator setup in separate steps, the view (lib/validator-setup-steps-view.js
// inside lib/validator-setup-view.js, w.mode = 'stepwise'), and the
// one-signature fixes of section 9 of
// cto-team/plans/2026-11-20-validator-setup-three-step-fallback.md.
// Real mainnet spec 394 codecs; the wallet is a recorded submit whose
// callbacks the test drives (onStage, onError, onSuccess), as submitSignedTx would.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { mountValidatorSetup } from '../lib/validator-setup-view.js';
import { SLASH_ACK } from '../lib/validator-setup.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { SIGNING_MODAL_IDS } from '../lib/wallet-aware.js';
import { escapeHtml } from '../lib/html-escape.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(111), OTHER = addr(113);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const BLOB = '0x' + EXPECTED_LAYOUT.map(l => KEYS[l.name].slice(2)).join('');
const FEES = { setKeys: 3n * 10n ** 10n, bond: 2n * 10n ** 10n, bondExtra: 2n * 10n ** 10n, validate: 1n * 10n ** 10n, batchAll: 2n * 10n ** 10n };

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-mainnet-394.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function fakeApi(o = {}) {
    // nonce and nextIndex: System.Account nonce and rpc.system.accountNextIndex (pool-aware).
    // holdLimits, holdAccount: promises the reads wait on, to hold the view mid-step.
    const st = { minBond: 100n * PDEX, minComm: 30_000_000, bonded: false, active: 0n, validating: false, nextKeys: null, owners: {}, free: 1000n * PDEX, spec: 394, nonce: 0, nextIndex: 0, holdLimits: null, holdAccount: null, ...o };
    const validators = async () => ({});
    validators.size = async (a) => num(String(a) === STASH && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(FEES[m] != null ? FEES[m] : 10n ** 10n) }); return c; } }) });
    return {
        st, registry, tx,
        get runtimeVersion() { return { specVersion: num(st.spec), transactionVersion: num(2) }; },
        consts: { balances: { existentialDeposit: num(PDEX) }, session: { keyDeposit: num(0) }, staking: { bondingDuration: num(28), sessionsPerEra: num(6) } },
        query: {
            system: { account: async () => { if (st.holdAccount) await st.holdAccount; return { nonce: num(st.nonce), data: { free: num(st.free), reserved: num(0), frozen: num(st.active) } }; } },
            staking: {
                minValidatorBond: async () => { if (st.holdLimits) await st.holdLimits; return num(st.minBond); }, minCommission: async () => num(st.minComm),
                maxValidatorsCount: async () => opt(num(250)), counterForValidators: async () => num(217),
                bonded: async (a) => opt(String(a) === STASH && st.bonded ? STASH : null),
                ledger: async (c) => opt(st.bonded && String(c) === STASH ? { stash: STASH, total: num(st.active), active: num(st.active) } : null),
                validators, nominators: async () => opt(null)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === STASH && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => opt(st.owners[String(key)] || null)
            }
        },
        rpc: { system: { accountNextIndex: async () => num(st.nextIndex) } }
    };
}
const deferred = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const PARAMS = { specVersion: 394, sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off', medianCommission: 50_000_000 };

function dom() {
    const w = new Window({ url: 'http://localhost/validate/setup' });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const flush = (n = 5) => new Promise(r => setTimeout(r, n));
async function settle() { for (let i = 0; i < 10; i++) await flush(); }
function deps(over = {}) {
    const submits = [];
    let rev = 'r1';
    const d = {
        submits, setRevision: (r) => { rev = r; },
        account: { status: 'connected', address: STASH },
        getApi: () => d.api, api: fakeApi(),
        isMultisig: () => false,
        fetchJson: async (u) => { if (u === '/api/validator/params') return PARAMS; throw new Error('unexpected ' + u); },
        esc: escapeHtml, helpIcon: () => '', shortAddr: (a) => a.slice(0, 8) + '...' + a.slice(-6),
        isAddress: (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || '')),
        revision: () => rev,
        submit: (o) => { submits.push(o); },
        renderCall: () => '',
        apiWaitMs: 50,
        ...over
    };
    if (over.api) d.api = over.api;
    return d;
}
const primaries = (el) => Array.from(el.querySelectorAll('.validate-primary'));
const heading = (el) => el.querySelector('#validate-step-title').textContent.trim();
const status = (el) => (el.querySelector('#validate-stepwise-status') || { textContent: '' }).textContent.trim();
const words = (el) => Array.from(el.querySelectorAll('ol.validate-stepwise > li .validate-word')).map(w => w.textContent.trim());
const click = async (el, sel) => { const b = el.querySelector(sel); assert.ok(b, 'missing ' + sel); b.click(); await settle(); };
const type = async (el, sel, v) => { const i = el.querySelector(sel); assert.ok(i, 'missing ' + sel); i.value = v; i.dispatchEvent(new i.ownerDocument.defaultView.Event('input', { bubbles: true })); await settle(); };
const tick = async (el, sel) => { const b = el.querySelector(sel); assert.ok(b, 'missing ' + sel); b.checked = true; b.dispatchEvent(new b.ownerDocument.defaultView.Event('change', { bubbles: true })); await settle(); };
async function toReview(el, { bond = '500', commission = '5' } = {}) {
    if (el.querySelector('[data-setup-action="next"]') && heading(el) === 'Start with a running node') await click(el, '[data-setup-action="next"]');
    if (el.querySelector('#validate-setup-keys')) { await type(el, '#validate-setup-keys', BLOB); await click(el, '[data-setup-action="use-keys"]'); }
    else if (el.querySelector('[data-setup-action="keep-keys"]')) await click(el, '[data-setup-action="keep-keys"]');
    if (el.querySelector('#validate-setup-bond')) await type(el, '#validate-setup-bond', bond);
    if (heading(el) === 'Bond from your stash') await click(el, '[data-setup-action="next"]');
    if (el.querySelector('#validate-setup-commission')) { await type(el, '#validate-setup-commission', commission); await click(el, '[data-setup-action="next"]'); }
}
async function openStepper(d, el) {
    await mountValidatorSetup(el, d); await settle();
    await toReview(el);
    await click(el, '[data-setup-action="stepwise"]');
}

// ── 11. entry ──
describe('entry on the review (F1, SW-01, SW-02, SW-04)', () => {
    test('a direct signer: the text button and its note; Sign and submit stays the only primary', async () => {
        const d = deps(); const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
        const b = el.querySelector('[data-setup-action="stepwise"]');
        assert.ok(b);
        assert.equal(b.tagName, 'BUTTON');
        assert.ok(b.classList.contains('validate-text-btn'));
        assert.equal(b.textContent.trim(), 'Sign in separate steps');
        assert.match(el.textContent, /For a wallet or hardware device that cannot sign all the steps as one transaction\. Each step is then its own transaction with its own fee\./);
        assert.deepEqual(primaries(el).map(p => p.textContent.trim()), ['Sign and submit']);
    });
    test('a multisig stash: SW-04 and no button', async () => {
        const ms = { address: STASH, name: 'Validator stash', threshold: 2, signers: [OTHER, STASH, addr(99)] };
        const d = deps({ isMultisig: () => true, findMultisig: () => ms });
        const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
        assert.equal(el.querySelector('[data-setup-action="stepwise"]'), null);
        assert.match(el.textContent, /Separate steps are not offered for a multisig stash, because each step would need its own round of approvals\. The multisig signs the setup as one transaction\./);
    });
});

// ── 12. SW-03 ──
describe('SW-03 after a one-signature attempt that ended before broadcast', () => {
    const SW03 = 'If your wallet or device cannot sign this as one transaction, use Sign in separate steps below.';
    async function attempt(end) {
        const d = deps(); const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="sign"]');
        end(d.submits[0]); await settle();
        return el.querySelector('#validate-setup-sign-msg').textContent;
    }
    test('cancel, BadProof, a wallet error and a silent wallet', async () => {
        for (const end of [
            (o) => o.onError('Cancelled.', { stage: 'cancelled', key: 'wallet.Cancelled' }),
            (o) => o.onError('The network did not accept your wallet\'s signature.', { stage: 'failed', key: 'pool.BadProof' }),
            (o) => o.onError('Could not access your wallet extension.', { stage: 'failed', text: 'Could not access your wallet extension.' }),
            (o) => o.onStage('waiting', { stage: 'waiting' })
        ]) assert.ok((await attempt(end)).includes(SW03));
    });
    test('not after a guard refusal or a fee shortfall', async () => {
        assert.ok(!(await attempt((o) => o.onError('The minimum bond changed.', { stage: 'failed', key: 'preflight' }))).includes(SW03));
        assert.ok(!(await attempt((o) => o.onError('This account needs at least 1 PDEX free.', { stage: 'failed', key: 'preflight' }))).includes(SW03));
    });
});

// ── 13. states ──
describe('the stepper states S0 to S10', () => {
    test('S0: heading, stash in full, intro, panel, step list, status, stop line, checkbox, one primary disabled until ticked', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        assert.equal(heading(el), 'Sign in separate steps');
        assert.match(el.textContent, new RegExp(`Stash: ${STASH}\\. Every step is signed by this account\\.`));
        assert.match(el.textContent, /Your wallet will ask you 3 times, once for each step below\. Each step is a separate transaction and pays its own network fee, about 0\.06 PDEX in total\./);
        assert.match(el.querySelector('.validate-warnings').textContent, /This is not all-or-nothing/);
        assert.match(el.textContent, /Steps you have signed stay on chain even if a later step fails or you stop\./);
        assert.match(el.textContent, /After the keys step alone, nothing is locked\. Stopping there costs only that step's fee\./);
        assert.match(el.textContent, /After the bond step, 500 PDEX is bonded and earns nothing until the last step is confirmed\. Getting bonded PDEX back takes 28 days\./);
        assert.match(el.textContent, /You can close this page and come back\. The explorer reads the chain and continues from the first step that is missing\. You will enter the commission again\./);
        const rows = Array.from(el.querySelectorAll('ol.validate-stepwise > li'));
        assert.deepEqual(rows.map(r => r.querySelector('code').textContent), ['session.setKeys', 'staking.bond', 'staking.validate']);
        assert.deepEqual(words(el), ['Ready to sign', 'Waiting', 'Waiting']);
        assert.equal(rows[0].getAttribute('aria-current'), 'step');
        assert.equal(el.querySelectorAll('[aria-current="step"]').length, 2, 'the wizard progress step and the stepper row');
        assert.equal(status(el), 'Nothing has been signed yet. Step 1 is next: Register 6 session keys. Your device may show the keys as six separate values over several screens. Compare the first and last characters of each with the table below before you approve.');
        assert.ok(el.querySelector('.validate-keys-table'), 'the keys table while setKeys is next');
        assert.match(el.textContent, /If you stop here: nothing has changed\./);
        assert.equal(el.querySelector('label[for="validate-setup-ack"]').textContent.trim(), SLASH_ACK);
        const p = primaries(el);
        assert.deepEqual(p.map(b => b.textContent.trim()), ['Sign step 1 of 3']);
        assert.equal(p[0].disabled, true);
        await tick(el, '#validate-setup-ack');
        assert.equal(primaries(el)[0].disabled, false);
        assert.equal(el.querySelector('[data-setup-action="step-back"]').textContent.trim(), 'Back to the review');
    });
    test('S1, S2, S3, S4 and on to S10 with the chain moving', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        assert.deepEqual(words(el), ['Waiting for your wallet', 'Waiting', 'Waiting']);
        assert.equal(d.submits.length, 1);
        const o = d.submits[0];
        o.onStage('broadcast', {}); await settle();
        assert.deepEqual(words(el), ['Sent, waiting for a block', 'Waiting', 'Waiting']);
        d.api.st.nextKeys = KEYS;
        o.onStage('inBlock', { stageText: 'In block #42' });
        o.onSuccess(); await settle();
        assert.deepEqual(words(el), ['Done on chain', 'Ready to sign', 'Waiting']);
        assert.equal(status(el), 'Step 1 is confirmed in block #42. Step 2 is next: Bond 500 PDEX, rewards: added to the bond.');
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Sign step 2 of 3']);
        assert.match(el.textContent, /If you stop here: your keys stay registered to this stash and nothing is locked\./);
        await click(el, '[data-setup-action="step-sign"]');
        const o2 = d.submits[1];
        o2.onStage('broadcast', {});
        Object.assign(d.api.st, { bonded: true, active: 500n * PDEX });
        o2.onStage('inBlock', { stageText: 'In block #43', outcome: { bonded: String(500n * PDEX) } });
        o2.onSuccess(); await settle();
        assert.equal(status(el), 'Step 2 is confirmed in block #43. Step 3 is next: Ask to validate at 5% commission.');
        assert.match(el.textContent, /If you stop here: 500 PDEX stays bonded and earns nothing\. To finish, come back and sign the remaining step\. To get it back, use Unstake on your wallet page: unbonding takes 28 days, then you withdraw it\./);
        assert.equal(el.querySelector('a[href="/wallet"]').textContent.trim(), 'Open your wallet page');
        await click(el, '[data-setup-action="step-sign"]');
        const o3 = d.submits[2];
        o3.onStage('broadcast', {});
        d.api.st.validating = true;
        o3.onStage('inBlock', { stageText: 'In block #44' });
        o3.onSuccess(); await settle();
        assert.deepEqual(words(el), ['Done on chain', 'Done on chain', 'Done on chain']);
        assert.match(status(el), /^All 3 steps are confirmed\. This stash is bonded, its keys are registered and it is asking to validate\. You are now waiting for election\./);
        assert.deepEqual(primaries(el).map(b => [b.tagName, b.textContent.trim(), b.getAttribute('href')]), [['A', 'Open validator status', '/validate']]);
        assert.equal(el.querySelector('[data-setup-action="step-back"]'), null);
    });
    test('S5 not signed: SW-44, Sign again and Back', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onError('Cancelled.', { stage: 'cancelled', key: 'wallet.Cancelled' }); await settle();
        assert.deepEqual(words(el), ['Not signed', 'Waiting', 'Waiting']);
        assert.match(status(el), /^Step 1 was not signed, so nothing changed and no fee was charged\. Press the button when you are ready\.$/);
        assert.deepEqual(primaries(el).map(b => [b.textContent.trim(), b.disabled]), [['Sign step 1 of 3', false]]);
        assert.ok(el.querySelector('[data-setup-action="step-back"]'));
    });
    test('S6 failed on chain: SW-45 with the reason; Check again and Back', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {});
        d.submits[0].onError('The keys are invalid.', { stage: 'failed', key: 'session.InvalidProof', text: 'The keys are invalid.' }); await settle();
        assert.equal(words(el)[0], 'Failed on chain');
        assert.match(status(el), /^Step 1 was included but the chain refused it: The keys are invalid\. Its fee was charged and nothing else changed\./);
        assert.ok(el.querySelector('[data-setup-action="step-check"]'));
        assert.ok(el.querySelector('[data-setup-action="step-back"]'));
        assert.ok(el.querySelector('.validate-word.is-error'));
    });
    test('S7 not confirmed: SW-46, no primary, Check again only', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {});
        d.submits[0].onStage('waiting', { stage: 'waiting' }); await settle();
        assert.equal(words(el)[0], 'Not confirmed');
        assert.equal(status(el), 'The explorer could not confirm step 1. It may still go through. Do not sign it again yet. Press Check again to read the chain.');
        assert.equal(primaries(el).length, 0);
        assert.ok(el.querySelector('[data-setup-action="step-check"]'));
        assert.equal(el.querySelector('[data-setup-action="step-back"]'), null);
        d.api.st.nextKeys = KEYS;
        await click(el, '[data-setup-action="step-check"]');
        assert.deepEqual(words(el), ['Done on chain', 'Ready to sign', 'Waiting']);
        assert.equal(status(el), 'Step 1 is confirmed on chain. Step 2 is next: Bond 500 PDEX, rewards: added to the bond.', 'no block number known');
    });
    test('S8 blocked: SW-47 when the step is not shown yet; the block in role=alert; Check again', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {});
        d.submits[0].onSuccess(); await settle();
        const alert = el.querySelector('.validate-alert[role="alert"]');
        assert.equal(alert.textContent.trim(), 'Step 1 went through, but the chain does not show these keys for this stash yet. It can take a block.');
        assert.equal(words(el)[0], 'Blocked');
        assert.equal(primaries(el).length, 0);
        assert.ok(el.querySelector('[data-setup-action="step-check"]'));
        assert.ok(el.querySelector('[data-setup-action="step-back"]'));
    });
    test('S8 at signing: buildTx refuses, nothing signed, the text shown', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.api.st.owners[KEYS.mixnet] = OTHER;
        await assert.rejects(d.submits[0].buildTx(d.api), /Key 5 \(mixnet\) is already registered to/);
        d.submits[0].onError('Key 5 (mixnet) is already registered to someone.', { stage: 'failed', key: 'preflight' }); await settle();
        assert.equal(words(el)[0], 'Blocked');
        assert.match(el.querySelector('.validate-alert[role="alert"]').textContent, /Key 5 \(mixnet\) is already registered/);
        assert.ok(el.querySelector('[data-setup-action="step-check"]'), 'Check again re-reads after a sign-time refusal');
    });
    test('S10 after a short bond: SW-58 (SW-57 first sentence, then the short-bond text)', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        d.api.st.nextKeys = KEYS;
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {}); d.submits[0].onSuccess(); await settle();
        await click(el, '[data-setup-action="step-sign"]');
        Object.assign(d.api.st, { bonded: true, active: 400n * PDEX });
        d.submits[1].onStage('broadcast', {}); d.submits[1].onSuccess(); await settle();
        await click(el, '[data-setup-action="step-sign"]');
        d.api.st.validating = true;
        d.submits[2].onStage('broadcast', {}); d.submits[2].onSuccess(); await settle();
        assert.equal(status(el), 'All 3 steps are confirmed. Bonded 400 PDEX of the 500 PDEX you asked for. The balance changed before the block. Your validator entry is set with the smaller bond. To add the rest, bond more from this stash.');
    });
    test('S6: Sign is offered again only when the gate allows that same step', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {});
        d.submits[0].onError('Refused.', { stage: 'failed', key: 'session.InvalidProof' }); await settle();
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Sign step 1 of 3']);
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[1].onStage('broadcast', {});
        d.api.st.owners[KEYS.mixnet] = OTHER;
        d.submits[1].onError('Refused.', { stage: 'failed', key: 'session.InvalidProof' }); await settle();
        assert.equal(words(el)[0], 'Failed on chain');
        assert.equal(primaries(el).length, 0, 'the gate blocks, so no Sign');
        assert.match(el.querySelector('.validate-alert[role="alert"]').textContent, /Key 5 \(mixnet\) is already registered/);
    });
    test('S8 with SW-49 offers Add to the bond; S9 with SW-48 offers Add the rest first', async () => {
        for (const [active, label, primary] of [[80n * PDEX, 'Add to the bond', true], [400n * PDEX, 'Add the rest first', false]]) {
            const d = deps(); const { el } = dom(); await openStepper(d, el);
            await tick(el, '#validate-setup-ack');
            d.api.st.nextKeys = KEYS;
            await click(el, '[data-setup-action="step-sign"]');
            d.submits[0].onStage('broadcast', {}); d.submits[0].onSuccess(); await settle();
            await click(el, '[data-setup-action="step-sign"]');
            Object.assign(d.api.st, { bonded: true, active });
            d.submits[1].onStage('broadcast', {}); d.submits[1].onSuccess(); await settle();
            const add = el.querySelector('[data-setup-action="step-add-bond"]');
            assert.equal(add.textContent.trim(), label);
            assert.equal(add.classList.contains('validate-primary'), primary);
            if (!primary) assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Sign step 3 of 3']);
            await click(el, '[data-setup-action="step-add-bond"]');
            assert.equal(heading(el), 'Bond from your stash');
            assert.equal(el.querySelector('#validate-setup-extra').value, active === 80n * PDEX ? '20' : '100');
        }
    });
});

// ── 14, 19. signing lock ──
describe('the signing lock (G6, finding 1)', () => {
    test('stepper: a second click during S1 sends nothing; Back, links and the checkbox are disabled; the lock clears on every terminal outcome', async () => {
        for (const end of [
            (o) => o.onError('Cancelled.', { stage: 'cancelled', key: 'wallet.Cancelled' }),
            (o) => { o.onStage('broadcast', {}); o.onError('Bad.', { stage: 'failed', key: 'staking.Bad' }); },
            (o) => { o.onStage('broadcast', {}); o.onStage('waiting', { stage: 'waiting' }); },
            (o) => { o.onStage('broadcast', {}); o.onSuccess(); }
        ]) {
            const d = deps(); const { el } = dom(); await openStepper(d, el);
            await tick(el, '#validate-setup-ack');
            const b = el.querySelector('[data-setup-action="step-sign"]');
            b.click(); b.click(); await settle();
            const again = el.querySelector('[data-setup-action="step-sign"]'); if (again) again.click(); await settle();
            assert.equal(d.submits.length, 1);
            for (const c of el.querySelectorAll('.validate-setup-step button, .validate-setup-step input')) assert.equal(c.disabled, true, c.outerHTML.slice(0, 80));
            end(d.submits[0]); await settle();
            assert.equal(el.querySelector('[data-setup-action="step-sign"], [data-setup-action="step-check"]') != null, true);
        }
    });
    test('one signature: a double click opens one wallet request; Back is disabled while signing; the review is not replaced by an old result', async () => {
        const d = deps(); const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
        await tick(el, '#validate-setup-ack');
        const b = el.querySelector('[data-setup-action="sign"]');
        b.click(); b.click(); await settle();
        assert.equal(d.submits.length, 1, 'one request');
        assert.equal(el.querySelector('[data-setup-action="sign"]').disabled, true);
        const back = el.querySelector('[data-setup-action="back"]');
        assert.equal(back.disabled, true);
        back.click(); await settle();
        assert.equal(heading(el), 'Review');
        assert.equal(el.querySelector('#validate-setup-ack').disabled, true);
        d.submits[0].onError('Cancelled.', { stage: 'cancelled', key: 'wallet.Cancelled' }); await settle();
        assert.equal(el.querySelector('[data-setup-action="sign"]').disabled, false);
        assert.equal(el.querySelector('[data-setup-action="back"]').disabled, false);
    });
    test('one signature: the lock clears on success, on a failure after broadcast and on a silent wallet', async () => {
        for (const end of [(o) => o.onSuccess(), (o) => { o.onStage('broadcast', {}); o.onError('x', { key: 'staking.Bad' }); }, (o) => o.onStage('waiting', { stage: 'waiting' })]) {
            const d = deps(); const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
            await tick(el, '#validate-setup-ack');
            await click(el, '[data-setup-action="sign"]');
            end(d.submits[0]); await settle();
            const s = el.querySelector('[data-setup-action="sign"]');
            if (s) { s.click(); await settle(); assert.equal(d.submits.length, 2); }
        }
    });
});

// Finding 7 (section 9): rewards to "another account" that is the stash itself.
describe('the payee account cannot be the stash (finding 7)', () => {
    test('refused on the bond step with the manage panel\'s text', async () => {
        const d = deps(); const { el, w } = dom(); await mountValidatorSetup(el, d); await settle();
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-keys', BLOB); await click(el, '[data-setup-action="use-keys"]');
        await type(el, '#validate-setup-bond', '500');
        const r = el.querySelector('input[name="validate-setup-payee"][value="account"]');
        r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); await settle();
        await type(el, '#validate-setup-payee-account', STASH);
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Bond from your stash');
        assert.equal(el.querySelector('#validate-setup-bond-msg').textContent, 'That is this stash. Choose "Pay rewards to this stash, unbonded" instead.');
    });
});

// ── 15. submit shape ──
describe('the per-step submit (section 3.4)', () => {
    test('expectedWallet, one expectedRevision for all steps, verify, action key and params, label, idle text', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        d.setRevision('r2');
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        const o = d.submits[0];
        assert.equal(o.expectedWallet, STASH);
        assert.equal(o.expectedRevision, 'r1');
        assert.equal(typeof o.verify, 'function');
        assert.equal(o.label, 'Validator setup, step 1 of 3');
        assert.equal(o.idleText, 'Sign step 1 of 3');
        assert.equal(o.action.key, 'validator.setupStep');
        assert.deepEqual(o.action.params, { n: 1, of: 3, last: false, summary: 'Keys registered.', stash: STASH, expectEvents: [] });
        const tx = await o.buildTx(d.api);
        assert.equal(`${tx.section}.${tx.method}`, 'session.setKeys');
        d.api.st.nextKeys = KEYS;
        o.onStage('broadcast', {}); o.onSuccess(); await settle();
        await click(el, '[data-setup-action="step-sign"]');
        assert.equal(d.submits[1].expectedRevision, 'r1', 'one revision for the whole plan');
        assert.equal(d.submits[1].action.params.bondRequested, String(500n * PDEX));
    });
});

// ── 16. resume ──
describe('resume from chain state (SW-05)', () => {
    for (const [name, st, kinds] of [
        ['keys only', { nextKeys: KEYS }, ['staking.bond', 'staking.validate']],
        ['bond only', { bonded: true, active: 500n * PDEX }, ['session.setKeys', 'staking.validate']],
        ['keys and bond', { nextKeys: KEYS, bonded: true, active: 500n * PDEX }, ['staking.validate']]
    ]) {
        test(name, async () => {
            const d = deps({ api: fakeApi(st) }); const { el } = dom(); await mountValidatorSetup(el, d); await settle();
            await toReview(el);
            assert.equal(heading(el), 'Review');
            assert.match(el.textContent, new RegExp(`This setup was started earlier\\. ${kinds.length} of its steps are left\\.`));
            await click(el, '[data-setup-action="stepwise"]');
            assert.deepEqual(Array.from(el.querySelectorAll('ol.validate-stepwise > li code')).map(c => c.textContent), kinds);
            if (kinds.length === 1) assert.match(el.textContent, /Your wallet will ask you once, for the step below\. Estimated network fee: 0\.01 PDEX\./);
        });
    }
});

// ── 17. wallet change ──
describe('a wallet change mid-stepper (G2, SW-56)', () => {
    test('remount: SW-56 once, no stepper state survives; no new modal', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        d.setRevision('r2');
        await mountValidatorSetup(el, deps({ revision: () => 'r2', account: { status: 'connected', address: OTHER } })); await settle();
        assert.match(el.textContent, new RegExp(`Your wallet changed, so the setup in separate steps was stopped\\. Steps already confirmed stay on chain\\. Connect the stash ${STASH.slice(0, 8)}\\.\\.\\.${STASH.slice(-6)} again to continue from where it stopped\\.`));
        assert.equal(el.querySelector('ol.validate-stepwise'), null);
        await mountValidatorSetup(el, deps({ revision: () => 'r2' })); await settle();
        assert.doesNotMatch(el.textContent, /Your wallet changed, so the setup in separate steps was stopped/);
        assert.ok(!SIGNING_MODAL_IDS.some(id => /stepwise|setup/i.test(id)));
    });
});

// ── 18. focus, live region, brand, size ──
describe('focus, live region, mobile list, brand lint', () => {
    test('focus on the heading when the stepper opens; after an outcome on the primary or the status line', async () => {
        const d = deps(); const { el, doc } = dom(); await openStepper(d, el);
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-step-title');
        const s = el.querySelector('#validate-stepwise-status');
        assert.equal(s.tagName, 'P');
        assert.equal(s.getAttribute('aria-live'), 'polite');
        assert.equal(s.getAttribute('tabindex'), '-1');
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onError('Cancelled.', { stage: 'cancelled', key: 'wallet.Cancelled' }); await settle();
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-stepwise-status', 'S5: the status line first, so SW-44 is read (finding 10)');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[1].onStage('broadcast', {}); d.submits[1].onStage('waiting', { stage: 'waiting' }); await settle();
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-stepwise-status');
        assert.equal(el.querySelector('[data-setup-action="step-back"]'), null, 'S7 has no Back');
    });
    test('mobile: the stepper list is not hidden like .validate-steps; buttons are full width and 44 px under the breakpoint', () => {
        const css = readRepo('styles.css', import.meta.url);
        const mobile = css.slice(css.indexOf('@media (max-width: 768px) {\n    .validate-setup-body'));
        assert.doesNotMatch(mobile.slice(0, 600), /validate-stepwise\s*\{\s*display:\s*none/);
        assert.match(css, /\.validate-stepwise\s*\{/);
        assert.match(mobile.slice(0, 800), /\.validate-stepwise-actions \.validate-primary\s*\{[^}]*width:\s*100%[^}]*min-height:\s*44px/);
    });
    test('brand: no dashes, no exclamation marks, no inline style, no new colour in the new modules and rules', () => {
        for (const f of ['lib/validator-setup-steps.js', 'lib/validator-setup-steps-view.js']) {
            const src = readRepo(f, import.meta.url);
            assert.ok(!/[–—]/.test(src), f);
            assert.ok(!/style=/.test(stripComments(src)), f);
        }
        const css = readRepo('styles.css', import.meta.url);
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /validate-stepwise/.test(m[1]));
        assert.ok(rules.length > 0);
        for (const r of rules) assert.doesNotMatch(r[2], /#[0-9a-f]{3,8}\b|rgba?\(|--success/i, r[1]);
    });
    test('help: the validator-setup topic has the SW-80 paragraph', async () => {
        const { HELP_TOPICS } = await import('../lib/help-topics.js');
        const { SW } = await import('../lib/validator-setup-steps.js');
        const topic = HELP_TOPICS.find(x => x.slug === 'validator-setup');
        assert.ok(topic.body.includes(SW.help));
    });
    test('script.js stays under 15,000 lines and gains no stepper logic', () => {
        const s = readRepo('script.js', import.meta.url);
        assert.ok(s.split('\n').length < 15000);
        assert.doesNotMatch(s, /stepwise/);
    });
});

// ── Fable review of the fallback (2026-11-20): findings 1 to 11 and 13 ──
const reviewTexts = (el) => Array.from(el.querySelectorAll('ol.validate-review > li .validate-review-text')).map(t => t.textContent.trim());
// A bonded stash with keys resumes at Commission; Back to Bond for a top-up.
async function toTopUpReview(el, extra) {
    assert.equal(heading(el), 'Set your commission');
    await click(el, '[data-setup-action="back"]');
    assert.equal(heading(el), 'Bond from your stash');
    await type(el, '#validate-setup-extra', extra);
    await click(el, '[data-setup-action="next"]');
    await type(el, '#validate-setup-commission', '5');
    await click(el, '[data-setup-action="next"]');
    assert.equal(heading(el), 'Review');
}
const topUpApi = () => fakeApi({ nextKeys: KEYS, bonded: true, active: 150n * PDEX });

describe('finding 1: a confirmed top-up or bond is never planned again after Back', () => {
    test('top-up confirmed with its Bonded event, validate blocked (SW-52): Back gives a review without the top-up', async () => {
        const d = deps({ api: topUpApi() }); const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toTopUpReview(el, '200');
        assert.deepEqual(reviewTexts(el), ['Add 200 PDEX to the bond', 'Ask to validate at 5% commission']);
        await click(el, '[data-setup-action="stepwise"]');
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        const o = d.submits[0];
        o.onStage('broadcast', {});
        d.api.st.active = 350n * PDEX;
        o.onStage('inBlock', { stageText: 'In block #50', outcome: { bonded: String(200n * PDEX) } });
        d.api.st.spec = 395;
        o.onSuccess(); await settle();
        assert.match(el.querySelector('.validate-alert[role="alert"]').textContent, /The network was upgraded while you were between steps/);
        await click(el, '[data-setup-action="step-back"]');
        assert.equal(heading(el), 'Review');
        assert.deepEqual(reviewTexts(el), ['Ask to validate at 5% commission'], 'no second "Add 200 PDEX"');
    });
    test('top-up confirmed by the ledger only, validate blocked (SW-50): Back gives a review without the top-up', async () => {
        const d = deps({ api: topUpApi() }); const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toTopUpReview(el, '200');
        await click(el, '[data-setup-action="stepwise"]');
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        const o = d.submits[0];
        o.onStage('broadcast', {});
        Object.assign(d.api.st, { active: 350n * PDEX, free: 350n * PDEX });
        o.onSuccess(); await settle();
        assert.match(el.querySelector('.validate-alert[role="alert"]').textContent, /^Step 2 cannot be paid for yet\./);
        await click(el, '[data-setup-action="step-back"]');
        assert.equal(heading(el), 'Review');
        assert.deepEqual(reviewTexts(el), ['Ask to validate at 5% commission'], 'no second "Add 200 PDEX"');
        assert.equal(el.querySelector('[data-setup-action="sign"]') != null, true);
    });
    test('a first bond confirmed, then Back: the chain state alone keeps the bond out of the new review', async () => {
        const d = deps({ api: fakeApi({ nextKeys: KEYS }) }); const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toReview(el);
        assert.deepEqual(reviewTexts(el), ['Bond 500 PDEX, rewards: added to the bond', 'Ask to validate at 5% commission']);
        await click(el, '[data-setup-action="stepwise"]');
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {});
        Object.assign(d.api.st, { bonded: true, active: 500n * PDEX });
        d.submits[0].onSuccess(); await settle();
        assert.deepEqual(primaries(el).map(b => b.textContent.trim()), ['Sign step 2 of 2']);
        await click(el, '[data-setup-action="step-back"]');
        assert.equal(heading(el), 'Review');
        assert.deepEqual(reviewTexts(el), ['Ask to validate at 5% commission']);
    });
});

describe('finding 2: Check again that lands on step 1 with nothing confirmed is S0', () => {
    test('a refusal at signing, then Check again: SW-40 and the checkbox, never "Step 0"', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onError('Key 5 (mixnet) is already registered to someone.', { stage: 'failed', key: 'preflight' }); await settle();
        await click(el, '[data-setup-action="step-check"]');
        assert.doesNotMatch(status(el), /Step 0/);
        assert.match(status(el), /^Nothing has been signed yet\. Step 1 is next: Register 6 session keys\./);
        assert.ok(el.querySelector('#validate-setup-ack'), 'the slash checkbox is back');
        assert.deepEqual(words(el), ['Ready to sign', 'Waiting', 'Waiting']);
    });
});

describe('finding 3: a transaction that may be in flight is never offered again', () => {
    test('(A) a lost link before the first status is "Not confirmed" (S7), not "not signed, no fee"', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onError('The connection to the network was lost.', { stage: 'failed', key: 'net.ConnectionLost' }); await settle();
        assert.equal(words(el)[0], 'Not confirmed');
        assert.equal(status(el), 'The explorer could not confirm step 1. It may still go through. Do not sign it again yet. Press Check again to read the chain.');
        assert.equal(primaries(el).length, 0);
        assert.doesNotMatch(el.textContent, /no fee was charged/);
    });
    test('(B) S7 after the cap, then Check again: the step is offered, but signing refuses while the pool holds a transaction', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {}); d.submits[0].onStage('waiting', { stage: 'waiting' }); await settle();
        Object.assign(d.api.st, { nonce: 4, nextIndex: 5 });
        await click(el, '[data-setup-action="step-check"]');
        await click(el, '[data-setup-action="step-sign"]');
        await assert.rejects(d.submits[1].buildTx(d.api), { message: 'Another transaction from this account is still waiting for a block. Nothing was signed.' });
        d.api.st.nextIndex = 4;
        const tx = await d.submits[1].buildTx(d.api);
        assert.equal(`${tx.section}.${tx.method}`, 'session.setKeys');
    });
});

describe('finding 4: a top-up still not on chain says how to get out', () => {
    test('the first S7 has SW-46 only; a repeat S7 adds the reload line; no Back', async () => {
        const STILL = 'Still not on chain. If it does not appear in about 15 minutes it was not included. Reload this page; the setup continues from the chain.';
        const d = deps({ api: topUpApi() }); const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toTopUpReview(el, '200');
        await click(el, '[data-setup-action="stepwise"]');
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {}); d.submits[0].onStage('waiting', { stage: 'waiting' }); await settle();
        assert.equal(status(el), 'The explorer could not confirm step 1. It may still go through. Do not sign it again yet. Press Check again to read the chain.');
        await click(el, '[data-setup-action="step-check"]');
        assert.equal(words(el)[0], 'Not confirmed');
        assert.equal(status(el), 'The explorer could not confirm step 1. It may still go through. Do not sign it again yet. Press Check again to read the chain. ' + STILL);
        assert.equal(el.querySelector('[data-setup-action="step-back"]'), null);
        assert.equal(primaries(el).length, 0);
    });
});

describe('findings 5 and 6: the lock is held until the next view is painted', () => {
    test('(5) opening the stepper: Back stays locked until the stepper paints; an edit cannot bring back the old plan', async () => {
        const d = deps(); const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
        const hold = deferred();
        d.api.st.holdLimits = hold.p;
        el.querySelector('[data-setup-action="stepwise"]').click(); await settle();
        assert.equal(heading(el), 'Review');
        assert.equal(el.querySelector('[data-setup-action="back"]').disabled, true, 'Back is locked while the gate reads');
        el.querySelector('[data-setup-action="back"]').click(); await settle();
        assert.equal(heading(el), 'Review', 'the click does nothing');
        d.api.st.holdLimits = null; hold.release(); await settle();
        assert.equal(heading(el), 'Sign in separate steps');
    });
    test('(5) go() leaves the stepper: a wizard step never paints the stepper', async () => {
        const d = deps(); const { el } = dom(); await openStepper(d, el);
        await click(el, '[data-setup-action="step-back"]');
        assert.equal(heading(el), 'Review');
        await click(el, '[data-setup-action="back"]');
        assert.equal(heading(el), 'Set your commission');
        await type(el, '#validate-setup-commission', '7');
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Review');
        assert.deepEqual(reviewTexts(el).slice(-1), ['Ask to validate at 7% commission']);
    });
    test('(6) one signature: after success, Sign and submit stays locked until the result is shown', async () => {
        const d = deps(); const { el } = dom(); await mountValidatorSetup(el, d); await settle(); await toReview(el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="sign"]');
        const hold = deferred();
        d.api.st.holdAccount = hold.p;
        d.submits[0].onSuccess(); await settle();
        const s = el.querySelector('[data-setup-action="sign"]');
        if (s) { assert.equal(s.disabled, true); s.click(); await settle(); }
        assert.equal(d.submits.length, 1, 'no second request while the result is read');
        d.api.st.holdAccount = null; hold.release(); await settle();
        assert.ok(el.querySelector('[role="status"]'));
    });
});

describe('finding 9: a submit that rejects ends in S5 and clears the lock', () => {
    test('d.submit rejects before anything is sent', async () => {
        let calls = 0;
        const d = deps({ submit: () => { calls += 1; return Promise.reject(new Error('The wallet could not be opened.')); } });
        const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        assert.equal(words(el)[0], 'Not signed');
        assert.match(status(el), /^Step 1 was not signed, so nothing changed and no fee was charged\./);
        await click(el, '[data-setup-action="step-sign"]');
        assert.equal(calls, 2, 'the lock was cleared');
    });
    test('d.submit throws synchronously', async () => {
        const d = deps({ submit: () => { throw new Error('No signer.'); } });
        const { el } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        assert.equal(words(el)[0], 'Not signed');
        assert.equal(primaries(el)[0].disabled, false);
    });
});

describe('finding 10: S5, S6 and S9 move focus to the status line first', () => {
    test('S6 and S9', async () => {
        const d = deps(); const { el, doc } = dom(); await openStepper(d, el);
        await tick(el, '#validate-setup-ack');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[0].onStage('broadcast', {});
        d.submits[0].onError('Refused.', { stage: 'failed', key: 'session.InvalidProof' }); await settle();
        assert.equal(words(el)[0], 'Failed on chain');
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-stepwise-status');
        d.api.st.nextKeys = KEYS;
        await click(el, '[data-setup-action="step-check"]');
        await click(el, '[data-setup-action="step-sign"]');
        d.submits[1].onStage('broadcast', {});
        Object.assign(d.api.st, { bonded: true, active: 400n * PDEX });
        d.submits[1].onSuccess(); await settle();
        assert.match(status(el), /^Bonded 400 PDEX of the 500 PDEX you reviewed\./);
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-stepwise-status');
    });
});

describe('finding 7: the stop line reads the chain first', () => {
    test('a resume with the bond on chain: SW-62 from the first view, not "nothing has changed"', async () => {
        const d = deps({ api: fakeApi({ bonded: true, active: 500n * PDEX }) }); const { el } = dom(); await mountValidatorSetup(el, d); await settle();
        await toReview(el);
        await click(el, '[data-setup-action="stepwise"]');
        assert.doesNotMatch(el.textContent, /If you stop here: nothing has changed\./);
        assert.match(el.textContent, /If you stop here: 500 PDEX stays bonded and earns nothing\./);
    });
});

describe('finding 11: the review shows the rewards account in full', () => {
    test('payee "another account": the full address on the review', async () => {
        const d = deps(); const { el, w } = dom(); await mountValidatorSetup(el, d); await settle();
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-keys', BLOB); await click(el, '[data-setup-action="use-keys"]');
        await type(el, '#validate-setup-bond', '500');
        const r = el.querySelector('input[name="validate-setup-payee"][value="account"]');
        r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); await settle();
        await type(el, '#validate-setup-payee-account', OTHER);
        await click(el, '[data-setup-action="next"]');
        await type(el, '#validate-setup-commission', '5');
        await click(el, '[data-setup-action="next"]');
        assert.equal(heading(el), 'Review');
        const full = Array.from(el.querySelectorAll('.validate-setup-step .mono')).map(m => m.textContent);
        assert.ok(full.includes(OTHER), 'the rewards account in full');
        assert.match(el.textContent, new RegExp(`Rewards go to ${OTHER}\\.`));
    });
});

describe('finding 13: Back and Check again are 44 px tap targets on mobile', () => {
    test('the stepper action row under the breakpoint', () => {
        const css = readRepo('styles.css', import.meta.url);
        const mobile = css.slice(css.indexOf('@media (max-width: 768px) {\n    .validate-setup-body'));
        const block = mobile.slice(0, mobile.indexOf('\n}'));
        assert.match(block, /\.validate-stepwise-actions \.validate-secondary[^{]*\{[^}]*min-height:\s*44px/);
        assert.match(block, /\.validate-stepwise-actions \.validate-text-btn[^{]*\{[^}]*min-height:\s*44px/);
    });
});
