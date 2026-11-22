// Work Package 3 of the validate redesign (cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// section 5 and 8): every state the setup wizard, the separate steps view and the manage panel can show,
// driven on fake chains through the REAL mount functions, and the node guide. Shared by
// test/wp3-freeze.test.js (the frozen text), test/validate-wp3.test.js (the role classes) and
// tools/preview-scenes.mjs (the WP3 scenes). Never shipped.
//
// frozenText(el): what a person reads in a view, as one string: every text node and every aria-label,
// whitespace collapsed, element boundaries as spaces. The parts the spec ADDS in WP3 are left out, by
// name, so the snapshot taken before the restyle still holds after it: the compact path strip
// (.validate-path, spec 5.1 and 5.4), step markers (.ui-step, their number is the list position and
// "done" is for screen readers), .sr-only, and the two new words of section 5, "Before you sign" and
// "Pending", only as a panel title or a chip.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { Window } from 'happy-dom';
import { encodeAddress, blake2AsHex } from '@polkadot/util-crypto';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { mountValidatorSetup } from '../../lib/validator-setup-view.js';
import { mountValidatorManage } from '../../lib/validator-manage-view.js';
import { renderNodeGuide } from '../../lib/validator-node-guide.js';
import { EXPECTED_LAYOUT } from '../../lib/session-keys.js';
import { normalizeMultisig } from '../../lib/multisig.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { renderCallHtml } from '../../lib/call-args-format.js';
import { callToTree } from '../../lib/call-tree.js';
import { registryFromMetadata, loadFixture } from './extrinsic-builders.js';

// ── the frozen text ──
export const ADDED_SELECTORS = '.validate-path, .ui-step, .sr-only, script, style';
export const ADDED_WORDS = Object.freeze(['Before you sign', 'Pending']);
export function frozenText(root) {
    const out = [];
    const walk = (n) => {
        if (n.nodeType === 3) { out.push(n.nodeValue); return; }
        if (n.nodeType !== 1) return;
        if (n.matches(ADDED_SELECTORS)) return;
        if (n.matches('.ui-panel-title, .ui-chip') && ADDED_WORDS.includes(n.textContent.trim())) return;
        const al = n.getAttribute('aria-label');
        if (al) out.push(al);
        for (const c of Array.from(n.childNodes)) walk(c);
    };
    walk(root);
    return out.join(' ').replace(/\s+/g, ' ').trim();
}
// The fields and the actions of a view, in order (spec test 16).
export const fieldsOf = (root) => Array.from(root.querySelectorAll('input, textarea, select')).map(i => i.id || `${i.name}=${i.value}`);
export const actionsOf = (root) => Array.from(root.querySelectorAll('[data-setup-action], [data-manage-action]')).map(b => b.getAttribute('data-setup-action') || b.getAttribute('data-manage-action'));
export const snapshotOf = (root) => ({ text: frozenText(root), fields: fieldsOf(root), actions: actionsOf(root) });

// ── shared ──
export const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
export const STASH = addr(151), OTHER = addr(153), PAYEE = addr(154), PROXY = addr(155), CTRL = addr(156);
const SA = addr(161), SB = addr(162), SC = addr(163);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
export const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const NEWKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const blob = (k) => '0x' + EXPECTED_LAYOUT.map(l => k[l.name].slice(2)).join('');
export const BLOB = blob(KEYS), NEWBLOB = blob(NEWKEYS);
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
const deferred = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
export const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const helpIcon = (slug, label) => `<a href="/help/${slug}" class="help-inline-icon" title="${escapeHtml(label || '')}" aria-label="${escapeHtml(label || '')}"><i class='bx bx-help-circle'></i></a>`;
const shortAddr = (a) => a.slice(0, 8) + '...' + a.slice(-6);

let chains = {};
function chain(name) {
    if (!chains[name]) {
        const registry = registryFromMetadata(loadFixture(name).metadata);
        chains[name] = { registry, ex: decorateExtrinsics(registry, registry.metadata, 15) };
    }
    return chains[name];
}

// A page: the real shell when one is given (the preview scenes), else a bare div.
function page(shell, url, width) {
    const window = new Window({ url, width: width || 1280, height: 900, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = window.document;
    let el;
    if (shell) { doc.body.innerHTML = shell; el = doc.getElementById('validate-root'); }
    else { el = doc.createElement('div'); doc.body.appendChild(el); }
    return { window, doc, el };
}
function actions(window, el) {
    const click = async (sel) => { const b = el.querySelector(sel); if (!b) throw new Error('missing ' + sel); b.click(); await settle(); };
    const type = async (sel, v) => { const i = el.querySelector(sel); if (!i) throw new Error('missing ' + sel); i.value = v; i.dispatchEvent(new window.Event('input', { bubbles: true })); await settle(); };
    const check = async (sel, on = true) => { const i = el.querySelector(sel); if (!i) throw new Error('missing ' + sel); i.checked = on; i.dispatchEvent(new window.Event('change', { bubbles: true })); await settle(); };
    return { click, type, check };
}

// ── the wizard and the separate steps (spec 394 codecs, as test/validator-setup-steps-view.test.js) ──
const FEES = { setKeys: 3n * 10n ** 10n, bond: 2n * 10n ** 10n, bondExtra: 2n * 10n ** 10n, validate: 1n * 10n ** 10n, batchAll: 2n * 10n ** 10n };
function setupApi(o = {}) {
    const { registry, ex } = chain('metadata-mainnet-394.json');
    const st = { stash: STASH, minBond: 100n * PDEX, minComm: 30_000_000, bonded: false, controller: null, active: 0n, validating: false, nextKeys: null, owners: {}, free: 1000n * PDEX, spec: 394, nonce: 0, nextIndex: 0, holdAccount: null, noms: null, noLayout: false, ...o };
    const validators = async () => ({});
    validators.size = async (a) => num(String(a) === st.stash && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(FEES[m] != null ? FEES[m] : 10n ** 10n) }); return c; } }) });
    return {
        st, tx,
        get registry() { return st.noLayout ? {} : registry; },
        get runtimeVersion() { return { specVersion: num(st.spec), transactionVersion: num(2) }; },
        consts: { balances: { existentialDeposit: num(PDEX) }, session: { keyDeposit: num(0) }, staking: { bondingDuration: num(28), sessionsPerEra: num(6) } },
        query: {
            system: { account: async () => { if (st.holdAccount) await st.holdAccount; return { nonce: num(st.nonce), data: { free: num(st.free), reserved: num(0), frozen: num(st.active) } }; } },
            staking: {
                minValidatorBond: async () => num(st.minBond), minCommission: async () => num(st.minComm),
                maxValidatorsCount: async () => opt(num(250)), counterForValidators: async () => num(217),
                bonded: async (a) => opt(String(a) === st.stash && st.bonded ? (st.controller || st.stash) : null),
                ledger: async (c) => opt(st.bonded && String(c) === (st.controller || st.stash) ? { stash: st.stash, total: num(st.active), active: num(st.active) } : null),
                validators, nominators: async () => opt(st.noms ? { targets: st.noms } : null)
            },
            session: {
                nextKeys: async (a) => opt(String(a) === st.stash && st.nextKeys ? keysCodec(st.nextKeys) : null),
                queuedKeys: async () => [],
                keyOwner: async ([, key]) => opt(st.owners[String(key)] || null)
            }
        },
        rpc: { system: { accountNextIndex: async () => num(st.nextIndex) } }
    };
}
const SETUP_PARAMS = { specVersion: 394, sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off', medianCommission: 50_000_000, lowestElectedTotal: String(5000n * PDEX) };
const TELEMETRY = { feed: 'ok', name: 'alpha-validator', count: 1, head: 8_000_000, nodes: [{ networkId: '12D3KooWExampleExampleExample', best: 7_999_998, finalized: 7_999_996, peers: 12, version: '0.4.1', secondsAgo: 3 }], release: { state: 'pending' } };

// o: { account, api (state over), ms (multisig stash), noApi, shell, width }
export async function setupWorld(o = {}) {
    const p = page(o.shell, 'http://localhost/validate/setup', o.width);
    const api = setupApi({ ...(o.api || {}), ...(o.ms ? { stash: o.ms.address } : {}) });
    const stash = o.ms ? o.ms.address : STASH;
    const submits = [];
    const d = {
        account: o.account || { status: 'connected', address: stash },
        getApi: () => (o.noApi ? null : api), isMultisig: (a) => !!o.ms && a === o.ms.address, findMultisig: (a) => (o.ms && a === o.ms.address ? o.ms : null),
        fetchJson: async (u) => { if (u === '/api/validator/params') return SETUP_PARAMS; if (u.startsWith('/api/telemetry/node')) return TELEMETRY; throw new Error('unexpected ' + u); },
        esc: escapeHtml, helpIcon, shortAddr, isAddress: (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || '')), isSame: (a, b) => a === b,
        revision: () => 'r1', submit: (x) => { submits.push(x); },
        renderCall: (call) => renderCallHtml(callToTree(call), {}, { raw: false }), apiWaitMs: 30
    };
    await mountValidatorSetup(p.el, d);
    await settle();
    return { ...p, ...actions(p.window, p.el), d, api, submits, view: 'wizard' };
}
const heading = (w) => (w.el.querySelector('#validate-step-title') || { textContent: '' }).textContent.trim();
async function toReview(w, { bond = '500', commission = '5', payee = null } = {}) {
    if (heading(w) === 'Start with a running node') await w.click('[data-setup-action="next"]');
    if (w.el.querySelector('#validate-setup-keys')) { await w.type('#validate-setup-keys', BLOB); await w.click('[data-setup-action="use-keys"]'); }
    else if (w.el.querySelector('[data-setup-action="keep-keys"]')) await w.click('[data-setup-action="keep-keys"]');
    if (w.el.querySelector('#validate-setup-bond')) await w.type('#validate-setup-bond', bond);
    if (payee) { await w.check('input[name="validate-setup-payee"][value="account"]'); await w.type('#validate-setup-payee-account', payee); }
    if (heading(w) === 'Bond from your stash') await w.click('[data-setup-action="next"]');
    if (w.el.querySelector('#validate-setup-commission')) { await w.type('#validate-setup-commission', commission); await w.click('[data-setup-action="next"]'); }
}
const MS = normalizeMultisig({ signers: [SA, SB, SC], threshold: 2, name: 'Validator stash' });
const openStepper = async (w) => { await toReview(w); await w.click('[data-setup-action="stepwise"]'); };
const signStep = async (w) => { await w.check('#validate-setup-ack'); await w.click('[data-setup-action="step-sign"]'); };
// Through step 1 (keys) confirmed, to S4.
async function stepOneDone(w) {
    await openStepper(w); await signStep(w);
    w.api.st.nextKeys = KEYS;
    const s = w.submits[w.submits.length - 1]; s.onStage('broadcast', {}); s.onStage('inBlock', { stageText: 'In block #42' }); s.onSuccess(); await settle();
}
async function stepTwoDone(w, active = 500n * PDEX) {
    await stepOneDone(w);
    await w.click('[data-setup-action="step-sign"]');
    Object.assign(w.api.st, { bonded: true, active });
    const s = w.submits[w.submits.length - 1]; s.onStage('broadcast', {}); s.onStage('inBlock', { stageText: 'In block #43', outcome: { bonded: String(active) } }); s.onSuccess(); await settle();
}
async function allDone(w, active) {
    await stepTwoDone(w, active);
    await w.click('[data-setup-action="step-sign"]');
    w.api.st.validating = true;
    const s = w.submits[w.submits.length - 1]; s.onStage('broadcast', {}); s.onStage('inBlock', { stageText: 'In block #44' }); s.onSuccess(); await settle();
}
const lastSubmit = (w) => w.submits[w.submits.length - 1];
const BONDED_KEYS = { bonded: true, active: 500n * PDEX, nextKeys: KEYS };

// id, view, world options, drive. The view states of spec 5.1 and 5.2, and the restore, refusal and error states.
export const SETUP_STATES = [
    ['wiz-restoring', { account: { status: 'restoring' } }],
    ['wiz-no-wallet', { account: { status: 'none', address: '' } }],
    ['wiz-chain-down', { noApi: true }],
    ['wiz-refusal', { api: { bonded: true, controller: CTRL, active: 500n * PDEX } }],
    ['wiz-done-already', { api: { ...BONDED_KEYS, validating: true } }],
    ['wiz-step1', {}],
    ['wiz-step1-node-empty', {}, (w) => w.click('[data-setup-action="check-node"]')],
    ['wiz-step1-node-found', {}, async (w) => { await w.type('#validate-setup-node', 'alpha-validator'); await w.click('[data-setup-action="check-node"]'); }],
    ['wiz-step2', {}, (w) => w.click('[data-setup-action="next"]')],
    ['wiz-step2-invalid', {}, async (w) => { await w.click('[data-setup-action="next"]'); await w.type('#validate-setup-keys', '0x1234'); }],
    ['wiz-step2-parsed', {}, async (w) => { await w.click('[data-setup-action="next"]'); await w.type('#validate-setup-keys', BLOB); }],
    ['wiz-step2-conflict', { api: { owners: { [KEYS.mixnet]: OTHER } } }, async (w) => { await w.click('[data-setup-action="next"]'); await w.type('#validate-setup-keys', BLOB); await w.click('[data-setup-action="use-keys"]'); }],
    ['wiz-step2-mismatch', { api: { noLayout: true } }, (w) => w.click('[data-setup-action="next"]')],
    ['wiz-step2-keep', { api: { nextKeys: KEYS } }, (w) => w.click('[data-setup-action="back"]')],
    ['wiz-step2-replace', { api: { nextKeys: KEYS } }, async (w) => { await w.click('[data-setup-action="back"]'); await w.click('[data-setup-action="replace-keys"]'); }],
    ['wiz-step3', { api: { nextKeys: KEYS } }],
    ['wiz-step3-error', { api: { nextKeys: KEYS } }, async (w) => { await w.type('#validate-setup-bond', '1'); await w.click('[data-setup-action="next"]'); }],
    ['wiz-step3-payee', { api: { nextKeys: KEYS } }, async (w) => { await w.type('#validate-setup-bond', '500'); await w.check('input[name="validate-setup-payee"][value="account"]'); await w.type('#validate-setup-payee-account', 'e-not-an-address'); await w.click('[data-setup-action="next"]'); }],
    ['wiz-step3-bonded', { api: BONDED_KEYS }, (w) => w.click('[data-setup-action="back"]')],
    ['wiz-step4', { api: BONDED_KEYS }],
    ['wiz-step4-error', { api: BONDED_KEYS }, async (w) => { await w.type('#validate-setup-commission', '1'); await w.click('[data-setup-action="next"]'); }],
    ['wiz-step4-warn', { api: BONDED_KEYS }, (w) => w.type('#validate-setup-commission', '25')],
    ['wiz-review', {}, (w) => toReview(w)],
    ['wiz-review-ack', {}, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); }],
    ['wiz-review-payee', {}, (w) => toReview(w, { payee: PAYEE })],
    ['wiz-review-resume', { api: BONDED_KEYS }, (w) => toReview(w)],
    ['wiz-review-multisig', { ms: MS }, (w) => toReview(w)],
    ['wiz-signing', {}, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); await w.click('[data-setup-action="sign"]'); }],
    ['wiz-sign-error', {}, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); await w.click('[data-setup-action="sign"]'); lastSubmit(w).onError('Cancelled in the wallet.', { stage: 'cancelled', key: 'wallet.Cancelled' }); await settle(); }],
    ['wiz-result-applied', {}, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); await w.click('[data-setup-action="sign"]'); Object.assign(w.api.st, { bonded: true, active: 500n * PDEX, nextKeys: KEYS, validating: true }); lastSubmit(w).onStage('inBlock', { stageText: 'In block #8,123,456' }); lastSubmit(w).onSuccess(); await settle(); }],
    ['wiz-result-short', {}, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); await w.click('[data-setup-action="sign"]'); Object.assign(w.api.st, { bonded: true, active: 420n * PDEX, nextKeys: KEYS, validating: true }); lastSubmit(w).onStage('inBlock', { stageText: 'In block #8,123,456', outcome: { bonded: String(420n * PDEX) } }); lastSubmit(w).onSuccess(); await settle(); }],
    ['wiz-result-missing', {}, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); await w.click('[data-setup-action="sign"]'); lastSubmit(w).onSuccess(); await settle(); }],
    ['wiz-result-approval', { ms: MS }, async (w) => { await toReview(w); await w.check('#validate-setup-ack'); await w.click('[data-setup-action="sign"]'); lastSubmit(w).onMultisigEnd('approved'); await settle(); }],
    // The separate steps, S0 to S10 (spec 2026-11-20 section 3.2).
    ['steps-S0', {}, openStepper],
    ['steps-S0-ack', {}, async (w) => { await openStepper(w); await w.check('#validate-setup-ack'); }],
    ['steps-S1', {}, async (w) => { await openStepper(w); await signStep(w); }],
    ['steps-S2', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); await settle(); }],
    ['steps-S3', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); lastSubmit(w).onStage('waiting', { stage: 'waiting' }); await settle(); const h = deferred(); w.api.st.holdAccount = h.p; w.release = h.release; await w.click('[data-setup-action="step-check"]'); }],
    ['steps-S4', {}, stepOneDone],
    ['steps-S4-bonded', {}, (w) => stepTwoDone(w)],
    ['steps-S5', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onError('Cancelled.', { stage: 'cancelled', key: 'wallet.Cancelled' }); await settle(); }],
    ['steps-S6', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); lastSubmit(w).onError('The keys are invalid.', { stage: 'failed', key: 'session.InvalidProof', text: 'The keys are invalid.' }); await settle(); }],
    ['steps-S6-blocked', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); w.api.st.owners[KEYS.mixnet] = OTHER; lastSubmit(w).onError('Refused.', { stage: 'failed', key: 'session.InvalidProof' }); await settle(); }],
    ['steps-S7', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); lastSubmit(w).onStage('waiting', { stage: 'waiting' }); await settle(); }],
    ['steps-S7-repeat', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); lastSubmit(w).onStage('waiting', { stage: 'waiting' }); await settle(); await w.click('[data-setup-action="step-check"]'); }],
    ['steps-S8', {}, async (w) => { await openStepper(w); await signStep(w); lastSubmit(w).onStage('broadcast', {}); lastSubmit(w).onSuccess(); await settle(); }],
    ['steps-S8-add-bond', {}, (w) => stepTwoDone(w, 80n * PDEX)],
    ['steps-S9', {}, (w) => stepTwoDone(w, 400n * PDEX)],
    ['steps-S10', {}, (w) => allDone(w, 500n * PDEX)],
    ['steps-S10-short', {}, (w) => allDone(w, 400n * PDEX)]
];

// ── the manage panel (spec 393 codecs, as test/validator-manage-view.test.js) ──
function manageApi(o = {}) {
    const { registry, ex } = chain('metadata-testnet-393.json');
    const st = { stash: STASH, minBond: 123n * PDEX, minComm: 30_000_000, bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] },
        validating: true, commission: 50_000_000, blocked: false, payee: 'Staked', nextKeys: KEYS, owners: {}, proxies: [], free: 1000n * PDEX, frozen: 500n * PDEX, fee: 2n * 10n ** 10n, noLayout: false, pending: [], ...o };
    const validators = async () => ({ commission: num(st.commission), blocked: { isTrue: !!st.blocked } });
    validators.size = async (a) => num(String(a) === st.stash && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => Object.assign((...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(st.fee) }); return c; }, { meta: p[m] && p[m].meta }) }) });
    return {
        st, tx, runtimeVersion: { specVersion: num(393) },
        get registry() { return st.noLayout ? {} : registry; },
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
            multisig: { multisigs: Object.assign(async () => ({ isNone: true }), { entries: async () => st.pending }) }
        }
    };
}
const MANAGE_PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, medianCommission: 50_000_000,
    sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off', sessionsPerEra: 6 };
const MODEL = (state = 'active', over = {}) => ({ address: STASH, state, rows: [{ id: 'online', word: 'Heartbeat received' }], era: { active: 500, current: 500, endsIn: 5 * 3600 }, session: { index: 3000, progress: 0.5, nextIn: 2 * 3600 }, ...over });
const MS_LEDGER = { stash: MS.address, bonded: MS.address, ledger: { controller: MS.address, stash: MS.address, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] } };
function msPending() {
    const { registry, ex } = chain('metadata-testnet-393.json');
    const chill = ex.staking.chill();
    const hash = blake2AsHex(registry.createType('Call', chill.toHex()).toU8a());
    return { chill, pending: [[{ args: [{ toString: () => MS.address }, { toHex: () => hash }] }, opt({ when: { height: num(900), index: num(2) }, approvals: [SB], depositor: SB, deposit: num(1) })]] };
}

// o: { api (state over), account, model, noApi, ms, shell, width, slot }
export async function manageWorld(o = {}) {
    const p = page(o.shell, 'http://localhost/validate', o.width);
    let el = p.el;
    if (o.slot) { el = o.slot(p); }
    const api = manageApi({ ...(o.ms ? MS_LEDGER : {}), ...(o.api || {}) });
    const stash = o.ms ? MS.address : STASH;
    const submits = [];
    const d = {
        account: o.account || { status: 'connected', address: stash },
        getApi: () => (o.noApi ? null : api), isMultisig: (a) => !!o.ms && a === MS.address, findMultisig: (a) => (o.ms && a === MS.address ? MS : null),
        multisigReview: () => {}, recoverCall: o.recoverCall,
        fetchJson: async (u) => { if (u === '/api/validator/params') return MANAGE_PARAMS; throw new Error('unexpected ' + u); },
        esc: escapeHtml, helpIcon, shortAddr, isAddress: (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || '')), isSame: (a, b) => a === b,
        revision: () => 'r1', submit: (x) => { submits.push(x); },
        renderCall: (call) => renderCallHtml(callToTree(call), {}, { raw: false }), apiWaitMs: 30
    };
    await mountValidatorManage(el, d, { stash, model: o.model || MODEL('active') });
    await settle();
    return { ...p, el, ...actions(p.window, el), d, api, submits, view: 'manage' };
}
const mReview = async (w, kind, value) => { await w.click(`[data-manage-action="${kind}"]`); if (value != null) await w.type(kind === 'keys' ? '#validate-manage-keys' : kind === 'commission' ? '#validate-manage-commission' : '#validate-manage-amount', value); await w.click('[data-manage-action="review"]'); };
const PROXIED = { account: { status: 'connected', address: PROXY }, api: { proxies: [{ delegate: PROXY, type: 'Staking' }] } };

export const MANAGE_STATES = [
    ['man-idle', {}],
    ['man-offline', { model: MODEL('active', { rows: [{ id: 'online', word: 'Offline' }] }) }],
    ['man-unbonding', { api: { ledger: { controller: STASH, stash: STASH, active: 400n * PDEX, total: 500n * PDEX, unlocking: [{ value: 100n * PDEX, era: 520 }] } } }],
    ['man-legacy', { api: { bonded: CTRL, ledger: { controller: CTRL, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] } } }],
    ['man-chain-down', { noApi: true }],
    ['man-disabled', { model: MODEL('disabled') }],
    ['man-commission', {}, (w) => w.click('[data-manage-action="commission"]')],
    ['man-commission-error', {}, (w) => mReview(w, 'commission', '1')],
    ['man-commission-100', {}, (w) => mReview(w, 'commission', '100')],
    ['man-commission-review', {}, (w) => mReview(w, 'commission', '25')],
    ['man-keys', {}, (w) => w.click('[data-manage-action="keys"]')],
    ['man-keys-conflict', { api: { owners: { [NEWKEYS.mixnet]: OTHER } } }, (w) => mReview(w, 'keys', NEWBLOB)],
    ['man-keys-review', {}, (w) => mReview(w, 'keys', NEWBLOB)],
    ['man-keys-mismatch', { api: { noLayout: true } }, (w) => w.click('[data-manage-action="keys"]')],
    ['man-bond-more', {}, (w) => w.click('[data-manage-action="bondExtra"]')],
    ['man-bond-more-error', {}, (w) => mReview(w, 'bondExtra', '999999')],
    ['man-bond-more-review', {}, (w) => mReview(w, 'bondExtra', '10')],
    ['man-payee', {}, (w) => w.click('[data-manage-action="payee"]')],
    ['man-payee-review', {}, async (w) => { await w.click('[data-manage-action="payee"]'); await w.check('input[name="validate-manage-payee"][value="account"]'); await w.type('#validate-manage-payee-account', PAYEE); await w.click('[data-manage-action="review"]'); }],
    ['man-rebond', { api: { ledger: { controller: STASH, stash: STASH, active: 400n * PDEX, total: 500n * PDEX, unlocking: [{ value: 100n * PDEX, era: 520 }] } } }, (w) => mReview(w, 'rebond', '50')],
    ['man-chill', {}, (w) => w.click('[data-manage-action="chill"]')],
    ['man-sign-error', {}, async (w) => { await mReview(w, 'commission', '25'); await w.click('[data-manage-action="sign"]'); lastSubmit(w).onError('Cancelled in the wallet.'); await settle(); }],
    ['man-result-done', {}, async (w) => { await mReview(w, 'commission', '25'); await w.click('[data-manage-action="sign"]'); w.api.st.commission = 250_000_000; lastSubmit(w).onStage('inBlock', { stageText: 'In block #8,123,999' }); lastSubmit(w).onSuccess(); await settle(); }],
    ['man-result-waiting', {}, async (w) => { await mReview(w, 'commission', '25'); await w.click('[data-manage-action="sign"]'); lastSubmit(w).onSuccess(); await settle(); }],
    ['man-proxy', PROXIED],
    ['man-proxy-review', PROXIED, (w) => mReview(w, 'commission', '25')],
    ['man-proxy-delay', { account: PROXIED.account, api: { proxies: [{ delegate: PROXY, type: 'Staking', delay: 10 }] } }],
    ['man-ms-review', { ms: true }, (w) => w.click('[data-manage-action="chill"]')],
    ['man-ms-approval', { ms: true }, async (w) => { await w.click('[data-manage-action="chill"]'); await w.click('[data-manage-action="sign"]'); lastSubmit(w).onMultisigEnd('approved'); await settle(); }],
    ['man-ms-pending', { ms: true, pending: true }]
];

// ── the node guide (a pure render; the release pending and published) ──
// A published release on the reserved .invalid host (RFC 2606): it never resolves.
const RELEASE = { version: '7.0.1', releaseNotesUrl: 'https://example.invalid/release-notes', binaryUrl: 'https://example.invalid/polkadex-node', binarySha256: 'a'.repeat(64), chainSpecUrl: 'https://example.invalid/customSpecRaw.json', chainSpecSha256: 'b'.repeat(64), image: 'example.invalid/polkadex-node:7.0.1@sha256:' + 'c'.repeat(64) };
export function guideWorld(o = {}) {
    const p = page(o.shell, 'http://localhost/validate/node', o.width);
    const html = renderNodeGuide({ esc: escapeHtml, helpIcon, ...(o.published ? { release: RELEASE } : {}) });
    p.el.innerHTML = html;
    return { ...p, view: 'guide' };
}

// Every state: { id, view, world }. Runs the drives in order (each on its own page).
export async function buildState(id, extra = {}) {
    const s = SETUP_STATES.find(x => x[0] === id);
    if (s) { const w = await setupWorld({ ...s[1], ...extra }); if (s[2]) await s[2](w); return w; }
    const m = MANAGE_STATES.find(x => x[0] === id);
    if (m) {
        const o = { ...m[1], ...extra };
        if (o.ms === true) o.ms = MS;
        if (o.pending) { const pp = msPending(); o.api = { ...(o.api || {}), pending: pp.pending }; o.recoverCall = async () => pp.chill.toHex(); }
        const w = await manageWorld(o);
        if (m[2]) await m[2](w);
        return w;
    }
    if (id === 'guide-pending') return guideWorld(extra);
    if (id === 'guide-published') return guideWorld({ ...extra, published: true });
    throw new Error('no WP3 state ' + id);
}
export const ALL_STATE_IDS = [...SETUP_STATES.map(s => s[0]), ...MANAGE_STATES.map(s => s[0])];
