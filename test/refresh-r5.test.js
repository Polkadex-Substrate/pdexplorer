// R5 of the post-action refresh (design cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 2.1,
// 3 rows 27 to 30, 4, 5 and 9 "R5"; UX cto-team/plans/2026-11-22-post-action-refresh-ux.md). The validator
// status card, the multisig pending list and proxy-signed actions after an action, through the REAL views
// (lib/validator-status-view.js with its manage panel, lib/validator-setup-view.js, lib/multisig-view.js), the
// REAL core (lib/post-action.js, lib/action-effects.js, lib/known-results.js, lib/freshness.js) and the REAL
// signing tracker (lib/tx-submit.js, lib/tx-status.js) on a fake chain and a fake server:
//   - the status card follows a manage action from a memo-bypassing read (?fresh=1) once the server's head
//     reached the inclusion block; a lagging or memoised copy is never drawn as the new state; the manage
//     panel's recheck stays the evidence and is not remounted;
//   - a multisig first approval changes only the pending list, never remounts the wallet;
//   - an executed multisig applies the inner action's effects to the MULTISIG account;
//   - a proxy-signed action updates the proxied (real) account's components, not the proxy's;
//   - nothing on failure, usurped, dropped or unconfirmed; a wallet switch mid-wait; a reorg withdrawal.
// Accounts are synthetic (32 bytes of one repeated value) or the wallet-world dev addresses. DOM nodes are
// compared with assert.ok(a === b): a failing assert.equal on a happy-dom node prints the whole document.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { encodeAddress, blake2AsHex } from '@polkadot/util-crypto';
import { hexToU8a } from '@polkadot/util';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { mountValidatePage } from '../lib/validator-status-view.js';
import { mountValidatorSetup } from '../lib/validator-setup-view.js';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { caughtUp, pollDeadlineMs } from '../lib/freshness.js';
import { trackSignedTx } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';
import { WALLET_DOMAINS } from '../lib/payout-refresh.js';
import { STRINGS, say } from '../lib/refresh-ui.js';
import { escapeHtml } from '../lib/html-escape.js';
import { renderCallHtml } from '../lib/call-args-format.js';
import { callToTree } from '../lib/call-tree.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { flush, READY, IN1, IN2, FIN1, FIN2, BLOCKS, fakeButton } from './helpers/tx-harness.js';
import { makeProfile, openTab, fakeExtension, A, B, C } from './helpers/wallet-world.js';
import { createMultisigStore } from '../lib/multisig.js';
import { bodyOf, readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(171), OTHER = addr(172), PROXY = addr(175);
const PDEX = 10n ** 12n;
const same = (a, b) => a === b;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const ev = (section, method, data = []) => ({ event: { section, method, data } });
const success = () => ev('system', 'ExtrinsicSuccess');
const failure = () => ev('system', 'ExtrinsicFailed', [{ isBadOrigin: true, type: 'BadOrigin' }]);
const prefsSet = (who = STASH) => ev('staking', 'ValidatorPrefsSet', [who, { commission: 70_000_000, blocked: false }]);
const helpIcon = (s, t) => `<a href="/help/${s}" aria-label="${t}">?</a>`;
const shortAddr = (a) => a.slice(0, 8) + '...' + a.slice(-6);
const isAddress = (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || ''));

// The tracker's own caps (signing 180 s, pre-inclusion 90 s, finality 120 s, watchdog 18 s) are real timers;
// a scenario that ends before Finalized must not hold this file open for minutes. Long timers are unref'd.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => { const t = realSetTimeout(f, ms, ...a); if (Number(ms) >= 5000 && t && typeof t.unref === 'function') t.unref(); return t; };

let registry, ex;
before(() => {
    registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
    ex = decorateExtrinsics(registry, registry.metadata, 15);
});

// ── a manual clock for the core's polls and the indicator (the views' own reads use real microtasks) ──
function clockOf() {
    const c = { t: 1_000_000, q: [], seq: 0 };
    c.now = () => c.t;
    c.set = (f, ms) => { const id = ++c.seq; c.q.push({ id, at: c.t + Math.max(0, Number(ms) || 0), f }); return id; };
    c.clear = (id) => { c.q = c.q.filter(x => x.id !== id); };
    c.advance = async (ms) => {
        const end = c.t + ms;
        for (;;) {
            c.q.sort((a, b) => a.at - b.at);
            const n = c.q[0];
            if (!n || n.at > end) break;
            c.q.shift();
            c.t = n.at;
            n.f();
            await settle();
        }
        c.t = end;
        await settle();
    };
    return c;
}
const coreOf = (clock) => createPostAction({ effects: effectsFor, known: createKnownResults({ storage: null, now: clock.now }), same, now: clock.now,
    visible: () => true, setTimer: clock.set, clearTimer: clock.clear, caughtUp, deadlineMs: pollDeadlineMs });

// ── the signing path: script.js submitSignedTx's tracker line with the core's two wrappers (design 2.1) ──
function submitter(core, chainApi) {
    const runs = [];
    const listeners = {};
    const txApi = { registry: {}, on: (e, f) => { (listeners[e] ||= []).push(f); }, off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); },
        rpc: { chain: { getHeader: async (h) => ({ number: { toNumber: () => BLOCKS[h] || 41 } }) } } };
    async function submit(o) {
        const action = { ...(o.action || {}), label: o.label, id: 'tx-' + runs.length };
        const seen = core.observe(action);
        let cb = null;
        const hash = '0x' + String(runs.length + 1).repeat(64).slice(0, 64);
        const r = { action, o, emit: async (status, events) => { cb({ status, events, txHash: { toHex: () => hash } }); await flush(); await settle(); },
            drop: async () => { (listeners.disconnected || []).slice().forEach(f => f()); await flush(); await settle(); } };
        runs.push(r);
        const run = trackSignedTx({ api: txApi, action, button: o.button || fakeButton(), idleText: o.idleText || 'Sign',
            onError: (t) => { if (o.onError) o.onError(t); }, onSuccess: () => { if (o.onSuccess) o.onSuccess(); },
            onStage: seen.stage((s, m) => { if (o.onStage) o.onStage(s, m || {}); }), show: seen.show(buildTxModel), verify: o.verify });
        run.start();
        let tx;
        try { tx = await o.buildTx(chainApi); } catch (e) { run.buildFailed(e); return; }
        const signer = (o.signingAccount && o.signingAccount.address) || o.expectedWallet;
        r.tx = tx;
        await run.send({ signAndSend: (a, opts, f) => { cb = f; return Promise.resolve(() => {}); } }, signer, {});
    }
    return { submit, runs, last: () => runs[runs.length - 1] };
}

// ── the stash's chain, as the browser's node sees it (the manage panel reads it) ──
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
function manageApi(o = {}) {
    const st = { stash: STASH, minBond: 123n * PDEX, minComm: 30_000_000, bonded: STASH, ledger: { controller: STASH, stash: STASH, active: 500n * PDEX, total: 500n * PDEX, unlocking: [] },
        validating: true, commission: 50_000_000, blocked: false, payee: 'Staked', nextKeys: KEYS, owners: {}, proxies: [], free: 1000n * PDEX, frozen: 500n * PDEX, fee: 2n * 10n ** 10n, ...o };
    const validators = async () => ({ commission: num(st.commission), blocked: { isTrue: !!st.blocked } });
    validators.size = async (a) => num(String(a) === st.stash && st.validating ? 5 : 0);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => Object.assign((...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(st.fee) }); return c; }, { meta: p[m] && p[m].meta }) }) });
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
            session: { nextKeys: async (a) => opt(String(a) === st.stash && st.nextKeys ? keysCodec(st.nextKeys) : null), queuedKeys: async () => [], keyOwner: async () => opt(null) },
            proxy: { proxies: async () => [st.proxies.map(p => ({ delegate: p.delegate, proxyType: { toString: () => p.type }, delay: num(p.delay || 0) })), num(0)] },
            multisig: { multisigs: Object.assign(async () => ({ isNone: true }), { entries: async () => [] }) }
        }
    };
}
const PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, medianCommission: 50_000_000,
    sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, activeEra: 500, currentEra: 500, electionPhase: 'Off', sessionsPerEra: 6 };

// ── the explorer's server: /api/validator/:a/status with its 30 s memo, bypassed by ?fresh=1 ──
const statusModel = (a, pct, head) => ({ address: a, state: 'active', headline: 'Active this session', pill: { word: 'Active', tone: 'positive' },
    rows: [{ id: 'commission', label: 'Commission', text: `${pct}%.` }, { id: 'online', label: 'Online', word: 'Heartbeat received', text: 'Heartbeat received.' }],
    tiles: [], era: { active: 500, current: 500, endsIn: 5 * 3600 }, session: { index: 3000, progress: 0.5, nextIn: 2 * 3600 }, freshness: { v: 1, chainHead: head } });
function statusServer(clock, { head = 41, pct = {} } = {}) {
    const s = { head, pct: { [STASH]: 5, [OTHER]: 9, ...pct }, memo: new Map(), reads: [] };
    s.fetch = async (u) => {
        s.reads.push(u);
        const m = /^\/api\/validator\/([^/?]+)\/status(\?fresh=1)?$/.exec(u);
        if (m) {
            const a = decodeURIComponent(m[1]);
            const hit = s.memo.get(a);
            if (hit && !m[2] && clock.now() - hit.at < 30_000) return JSON.parse(JSON.stringify(hit.body));
            const body = statusModel(a, s.pct[a] == null ? 5 : s.pct[a], s.head);
            s.memo.set(a, { at: clock.now(), body });
            return JSON.parse(JSON.stringify(body));
        }
        if (u === '/api/validator/params') return PARAMS;
        throw Object.assign(new Error('not served here'), { status: 404 });
    };
    s.since = (n) => s.reads.slice(n);
    return s;
}

// ── /validate (the hub) for one connected account, with the manage panel ──
async function hubWorld({ account = STASH, url = '', api = manageApi(), clock = clockOf(), server = null, core = null, post = true } = {}) {
    const srv = server || statusServer(clock);
    const c = core || coreOf(clock);
    const win = new Window({ url: 'http://localhost/validate' });
    const doc = win.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    const sub = submitter(c, api);
    const acc = { status: 'connected', address: account };
    const manage = { account: acc, getApi: () => api, isMultisig: () => false, fetchJson: srv.fetch, esc: escapeHtml, helpIcon, shortAddr, isAddress, isSame: same,
        revision: () => 'r1', submit: sub.submit, renderCall: (call) => renderCallHtml(callToTree(call), {}, { raw: false }), apiWaitMs: 50 };
    const d = { manage, urlAddress: url, account: acc, isSame: same, fetchJson: srv.fetch, helpIcon, esc: escapeHtml, shortAddr, navigate() {}, isAddress,
        ...(post ? { post: c } : {}), setTimer: clock.set, clearTimer: clock.clear, now: clock.now };
    await mountValidatePage(el, d);
    await settle();
    const click = async (sel) => { const b = el.querySelector(sel); assert.ok(b, 'missing ' + sel); b.click(); await settle(); };
    const type = async (sel, v) => { const i = el.querySelector(sel); assert.ok(i, 'missing ' + sel); i.value = v; i.dispatchEvent(new win.Event('input', { bubbles: true })); await settle(); };
    const card = () => { const s = doc.getElementById('validate-status-slot'); return s ? s.textContent : ''; };
    return { win, doc, el, d, api, clock, server: srv, core: c, sub, click, type, card };
}
// Change commission to 7% through the manage panel and sign; the run is left at "sent".
async function signCommission(w) {
    await w.click('[data-manage-action="commission"]');
    await w.type('#validate-manage-commission', '7');
    await w.click('[data-manage-action="review"]');
    await w.click('[data-manage-action="sign"]');
    const r = w.sub.last();
    assert.ok(r, 'the manage panel signed through the shared path');
    await r.emit(READY);
    return r;
}
const freshReads = (reads) => reads.filter(u => /\/status\?fresh=1$/.test(u));
const plainReads = (reads, a = STASH) => reads.filter(u => u === `/api/validator/${a}/status`);

describe('R5: the validator status card follows a manage action (rows 27 to 29)', () => {
    test('a commission change: the panel shows the recheck evidence at once; the card shows 7% after the memo-bypassing read, never from the 30 s memo', async () => {
        const w = await hubWorld();
        assert.match(w.card(), /Commission\s*5%\./);
        const manageBox = w.doc.querySelector('#validate-manage-slot .validate-manage');
        assert.ok(manageBox, 'the manage panel is mounted');
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000;          // the browser's node has the change
        const n = w.server.reads.length;           // the server's node is one block behind (41), memo holds 5%
        await r.emit(IN1, [prefsSet(), success()]);
        assert.match(w.el.querySelector('#validate-manage-slot [role="status"]').textContent, /Submitted and confirmed in block #42\. Commission is now 7%\./, 'the recheck is the panel\'s evidence');
        assert.ok(w.doc.querySelector('#validate-manage-slot .validate-manage') === manageBox, 'the panel was not remounted by the card refresh');
        assert.ok(freshReads(w.server.since(n)).length >= 1, 'the card read the status with ?fresh=1 at inclusion');
        assert.deepEqual(plainReads(w.server.since(n)), [], 'no memo read after the action');
        assert.match(w.card(), /Commission\s*5%\./, 'a copy below the inclusion block is not drawn as the new state');
        w.server.head = 42; w.server.pct[STASH] = 7;
        await w.clock.advance(2000);
        assert.match(w.card(), /Commission\s*7%\./, 'the card follows once the server read reached block 42');
        assert.ok(w.doc.querySelector('#validate-manage-slot .validate-manage') === manageBox, 'still the same panel, its result kept');
        assert.match(w.el.querySelector('#validate-manage-slot [role="status"]').textContent, /Commission is now 7%/);
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('a server already at the block: the card shows 7% at inclusion, with no wait and no indicator', async () => {
        const clock = clockOf();
        const w = await hubWorld({ clock, server: statusServer(clock, { head: 42 }) });
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000; w.server.pct[STASH] = 7;
        await r.emit(IN1, [prefsSet(), success()]);
        assert.match(w.card(), /Commission\s*7%\./);
        await w.clock.advance(1000);
        assert.equal(w.doc.querySelector('.ui-chip.is-wait'), null, 'a read under T1 shows no Updating chip');
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('a lagging server: "Updating" after T1 in the card header, gone once current; the headline keeps its place', async () => {
        const w = await hubWorld();
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000;
        await r.emit(IN1, [prefsSet(), success()]);
        await w.clock.advance(700);
        const chip = w.doc.querySelector('#validate-status-slot .validate-head-line .ui-chip.is-wait');
        assert.ok(chip, 'the S1 chip in the card header');
        assert.equal(chip.textContent.trim(), STRINGS.S1);
        w.server.head = 42; w.server.pct[STASH] = 7;
        await w.clock.advance(3000);
        assert.match(w.card(), /Commission\s*7%\./);
        assert.equal(w.doc.querySelector('#validate-status-slot .ui-chip.is-wait'), null, 'the chip left after T2');
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('a server that never reaches the block: could-not-refresh (S11, S12) after the memo deadline; the old figure stays', async () => {
        const w = await hubWorld();
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000;
        await r.emit(IN1, [prefsSet(), success()]);
        await w.clock.advance(200_000);
        const line = w.doc.querySelector('.validate-dash .ui-panel.is-warn');
        assert.ok(line, 'the could-not-refresh line');
        assert.match(line.textContent, new RegExp(STRINGS.S11.replace(/\./g, '\\.')));
        assert.match(line.textContent, new RegExp(STRINGS.S12));
        assert.match(w.card(), /Commission\s*5%\./, 'the server copy stays; nothing is guessed');
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('"Back to manage" after the change reads the status with ?fresh=1: another worker\'s 30 s memo cannot draw the old rate', async () => {
        const clock = clockOf();
        const w = await hubWorld({ clock, server: statusServer(clock, { head: 42 }) });
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000; w.server.pct[STASH] = 7;
        await r.emit(IN1, [prefsSet(), success()]);
        w.server.memo.set(STASH, { at: clock.now(), body: statusModel(STASH, 5, 40) });   // another worker's memo
        const n = w.server.reads.length;
        await w.click('[data-manage-action="done"]');
        assert.deepEqual(plainReads(w.server.since(n)), [], 'no memo read while the action is recent');
        assert.match(w.card(), /Commission\s*7%\./);
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('never on failure: a failed extrinsic, a usurped one, a drop before inclusion: no fresh read, the card as it was', async () => {
        for (const end of ['failed', 'usurped', 'dropped']) {
            const w = await hubWorld();
            const r = await signCommission(w);
            const n = w.server.reads.length;
            if (end === 'failed') await r.emit(IN1, [failure()]);
            else if (end === 'usurped') await r.emit({ type: 'Usurped' });
            else await r.drop();
            await w.clock.advance(5000);
            assert.deepEqual(freshReads(w.server.since(n)), [], end + ': no fresh read');
            assert.match(w.card(), /Commission\s*5%\./, end);
            assert.equal(w.doc.querySelector('.ui-chip.is-wait'), null, end + ': no indicator');
        }
    });
    test('a wallet switch mid-wait: the old stash is not polled or drawn on the new account\'s card', async () => {
        const w = await hubWorld();
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000;
        await r.emit(IN1, [prefsSet(), success()]);
        // script.js: the session changed; the page remounts for the new wallet.
        w.core.accountChanged(OTHER);
        await mountValidatePage(w.el, { ...w.d, account: { status: 'connected', address: OTHER }, manage: { ...w.d.manage, account: { status: 'connected', address: OTHER } } });
        await settle();
        const n = w.server.reads.length;
        w.server.head = 42; w.server.pct[STASH] = 7;
        await w.clock.advance(60_000);
        assert.deepEqual(w.server.since(n).filter(u => u.includes(STASH)), [], 'the old stash is not read again');
        assert.match(w.card(), /Commission\s*9%\./, 'the new account\'s card');
        assert.doesNotMatch(w.card(), /7%/);
        assert.equal(w.doc.querySelector('.validate-dash .ui-panel.is-warn'), null, 'no line raised for the old account');
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('a reorg: the card re-reads the server with the S17 line; back in a block it follows the new block, the line leaves', async () => {
        const clock = clockOf();
        const w = await hubWorld({ clock, server: statusServer(clock, { head: 42 }) });
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000; w.server.pct[STASH] = 7;
        await r.emit(IN1, [prefsSet(), success()]);
        assert.match(w.card(), /Commission\s*7%\./);
        w.server.pct[STASH] = 5;                    // the fork without the change
        await r.emit({ type: 'Retracted', asRetracted: '0xb1' });
        assert.match(w.card(), /Commission\s*5%\./, 'the replaced block\'s result is not kept');
        const line = w.doc.querySelector('.validate-dash .ui-panel.is-warn');
        assert.ok(line, 'the reorg line');
        assert.equal(line.textContent.trim(), say('S17', { payout: 'transaction' }));
        w.server.head = 43; w.server.pct[STASH] = 7;
        await r.emit(IN2, [prefsSet(), success()]);
        assert.match(w.card(), /Commission\s*7%\./);
        assert.equal(w.doc.querySelector('.validate-dash .ui-panel.is-warn'), null, 'the line left');
        await r.emit(FIN2, [prefsSet(), success()]);
    });
    test('a proxy-signed change: the PROXIED stash\'s card follows; the proxy\'s own staking components are not reloaded', async () => {
        const clock = clockOf();
        const api = manageApi({ proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }] });
        const core = coreOf(clock);
        const proxyStaking = [];
        core.subscribe(['staking.ledger', 'staking.nominations', 'locks'], { account: () => PROXY, reload: (i) => { proxyStaking.push(i); return null; } });
        const w = await hubWorld({ clock, api, core, account: PROXY, url: STASH, server: statusServer(clock, { head: 42 }) });
        const r = await signCommission(w);
        assert.equal(r.o.expectedWallet, PROXY, 'the proxy signs');
        api.st.commission = 70_000_000; w.server.pct[STASH] = 7;
        await r.emit(IN1, [ev('proxy', 'ProxyExecuted', [{ isOk: true, isErr: false }]), prefsSet(), success()]);
        assert.match(w.card(), /Commission\s*7%\./, 'the stash\'s card');
        assert.deepEqual(proxyStaking, [], 'the proxy\'s staking components are not the ones that changed');
        await r.emit(FIN1, [prefsSet(), success()]);
    });
    test('a proxy-signed unbond (real = the stash): the stash\'s card re-reads its self stake; the proxy gets only its fee balance', async () => {
        const clock = clockOf();
        const core = coreOf(clock);
        const proxyBalance = [], proxyStaking = [];
        core.subscribe(['balance'], { account: () => PROXY, reload: (i) => { proxyBalance.push(i); return null; } });
        core.subscribe(['staking.ledger', 'staking.nominations', 'locks'], { account: () => PROXY, reload: (i) => { proxyStaking.push(i); return null; } });
        const w = await hubWorld({ clock, core, account: PROXY, url: STASH, api: manageApi({ proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }] }), server: statusServer(clock, { head: 42 }) });
        const n = w.server.reads.length;
        const s = submitter(core, w.api);
        await s.submit({ label: 'Unbond', action: { key: 'staking.unbond', params: { real: STASH, amount: '10' } }, expectedWallet: PROXY, buildTx: async () => ({}) });
        await s.last().emit(READY);
        await s.last().emit(IN1, [ev('proxy', 'ProxyExecuted', [{ isOk: true, isErr: false }]), ev('staking', 'Unbonded', [STASH, '10']), success()]);
        assert.ok(freshReads(w.server.since(n)).some(u => u.includes(STASH)), 'the stash\'s card re-read its status (self stake)');
        assert.ok(proxyBalance.length >= 1, 'the proxy\'s balance hears about its fee');
        assert.deepEqual(proxyStaking, [], 'the proxy\'s staking components did not change');
        await s.last().emit(FIN1, [success()]);
    });
    test('a proxy-signed action whose proxied call failed (ProxyExecuted Err): nothing is re-read for the stash', async () => {
        const w = await hubWorld({ account: PROXY, url: STASH, api: manageApi({ proxies: [{ delegate: PROXY, type: 'Staking', delay: 0 }] }) });
        const r = await signCommission(w);
        const n = w.server.reads.length;
        await r.emit(IN1, [ev('proxy', 'ProxyExecuted', [{ isOk: false, isErr: true, asErr: { isBadOrigin: true, type: 'BadOrigin' } }]), success()]);
        await w.clock.advance(5000);
        assert.deepEqual(freshReads(w.server.since(n)), []);
        assert.match(w.card(), /Commission\s*5%\./);
    });
    test('without the core (old deps) the hub is drawn exactly as before', async () => {
        const w = await hubWorld({ post: false });
        assert.match(w.card(), /Commission\s*5%\./);
        assert.deepEqual(freshReads(w.server.reads), []);
    });
});

describe('R5: the setup view subscribes; its recheck stays the evidence (rows 27, 28)', () => {
    test('a setup included while /validate/setup is open: the stash\'s status is read past its memo, and /validate opened next reads it fresh', async () => {
        const clock = clockOf();
        const core = coreOf(clock);
        const server = statusServer(clock, { head: 41 });
        await server.fetch(`/api/validator/${STASH}/status`);   // the memo holds the pre-setup status
        const win = new Window({ url: 'http://localhost/validate/setup' });
        const el = win.document.createElement('div');
        win.document.body.appendChild(el);
        const d = { account: { status: 'connected', address: STASH }, getApi: () => null, apiWaitMs: 20, isMultisig: () => false, revision: () => 'r1', submit() {},
            fetchJson: server.fetch, helpIcon, esc: escapeHtml, shortAddr, isAddress, isSame: same, renderCall: () => '', post: core };
        await mountValidatorSetup(el, d);
        await settle();
        const n = server.reads.length;
        // What the core does at the setup's inclusion (lib/post-action.js notify for effects row 27).
        core.notify({ account: STASH, domains: ['validator.status', 'staking.ledger', 'balance'], block: 42, reason: 'inBlock' });
        await settle();
        assert.ok(freshReads(server.since(n)).length >= 1, 'the setup page read the stash\'s status with ?fresh=1');
        // The person opens "Open validator status": /validate mounts in the same root.
        server.head = 42; server.pct[STASH] = 6;
        const m = server.reads.length;
        server.memo.set(STASH, { at: clock.now(), body: statusModel(STASH, 5, 40) });   // a worker's old memo
        await mountValidatePage(el, { manage: null, urlAddress: '', account: { status: 'connected', address: STASH }, isSame: same, fetchJson: server.fetch, helpIcon, esc: escapeHtml,
            shortAddr, navigate() {}, isAddress, post: core, setTimer: clock.set, clearTimer: clock.clear, now: clock.now });
        await settle();
        const first = server.since(m).find(u => u.includes('/status'));
        assert.equal(first, `/api/validator/${STASH}/status?fresh=1`, 'the hub\'s first read bypasses the memo');
        assert.match(win.document.getElementById('validate-status-slot').textContent, /Commission\s*6%\./);
    });
});

// ── the multisig wallet: lib/multisig-view.js in a wallet page ──
const CALL = '0x0400';
function msChain(ms) {
    const c = { head: 41, pending: [] };
    const pendingOpt = (p) => ({ isSome: true, isNone: false, unwrap: () => ({ when: { height: num(900), index: num(2) }, approvals: p.approvals, depositor: p.approvals[0], deposit: num(1) }) });
    const txOf = (name) => (...args) => ({ name, args, method: { toHex: () => '0x' + name.length.toString(16).padStart(2, '0') + '00' }, paymentInfo: async () => ({ partialFee: { toString: () => '15000000000' } }) });
    const api = {
        genesisHash: { toHex: () => '0x' + '00'.repeat(32) },
        runtimeVersion: { specVersion: { toString: () => '392' } },
        registry: { createType: (_t, hex) => ({ toHex: () => hex, toU8a: () => hexToU8a(hex), section: 'balances', method: 'transferKeepAlive', toHuman: () => ({}), args: [], meta: { args: [] } }) },
        query: { multisig: { multisigs: Object.assign(async (_a, h) => { const p = c.pending.find(x => x.hash === h); return p ? pendingOpt(p) : { isNone: true, isSome: false }; },
            { entries: async (a) => (a === ms.address ? c.pending.map(p => [{ args: [{ toString: () => ms.address }, { toHex: () => p.hash }] }, pendingOpt(p)]) : []) }) } },
        consts: { multisig: { maxSignatories: 100, depositBase: '1', depositFactor: '1' } },
        rpc: { chain: { getHeader: async () => ({ number: num(c.head) }) } }
    };
    api.tx = Object.assign(() => ({ paymentInfo: async () => ({ weight: { refTime: 1000, proofSize: 100 } }) }),
        { multisig: { asMulti: txOf('asMulti'), asMultiThreshold1: txOf('asMultiThreshold1'), approveAsMulti: txOf('approveAsMulti'), cancelAsMulti: txOf('cancelAsMulti') } });
    c.api = api;
    return c;
}
async function msWorld({ threshold = 2, signer = A, clock = clockOf(), core = null, post = true } = {}) {
    const ms = normalizeMultisig({ signers: [A, B, C], threshold, name: 'Team wallet' });
    const c = core || coreOf(clock);
    const chain = msChain(ms);
    const win = new Window({ url: 'http://localhost/wallet/' + ms.address });
    const doc = win.document;
    doc.body.innerHTML = '<div id="multisig-review-modal" class="modal" style="display:none"><div id="multisig-review-content"></div></div>'
        + '<main id="wallet-dashboard"><section id="wsec-summary"><p class="wallet-balance">100 PDEX</p></section><div id="wallet-multisig-slot"></div></main>';
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, navigator: globalThis.navigator };
    globalThis.document = doc;
    globalThis.MutationObserver = win.MutationObserver;
    const sub = submitter(c, chain.api);
    const refreshes = [];
    const ui = createMultisigUI({
        store: { find: (a) => (a === ms.address ? ms : null), list: () => [ms] }, storage: { getItem: () => null, setItem() {} }, api: () => chain.api,
        accounts: async () => [{ address: signer, name: 'Signer', source: 'talisman' }], selected: () => ms.address, select() {},
        submit: sub.submit, refresh: (a) => refreshes.push(a), fetchJson: async () => ({}), revision: () => 'r1',
        ...(post ? { post: () => c } : {}), setTimer: clock.set, clearTimer: clock.clear, now: clock.now
    });
    const slot = doc.getElementById('wallet-multisig-slot');
    await ui.mountPending(slot, ms);
    await settle();
    const wallet = [];
    c.subscribe(WALLET_DOMAINS.slice(), { account: () => ms.address, reload: (i) => { wallet.push(i); return i && i.poll ? { v: 1, chainHead: 99, indexed: { chain: 99, rewards: 99, tx: 99 }, since: { chain: 1, rewards: 1, tx: 1 }, kv: {} } : null; } });
    const restore = () => { globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver; };
    const sign = async () => { const b = doc.getElementById('multisig-review-sign'); assert.ok(b && !b.disabled, 'the review can be signed'); b.click(); await settle(); };
    return { ms, chain, ui, sub, core: c, clock, win, doc, slot, wallet, refreshes, restore, sign, list: () => doc.querySelector('.multisig-pending-list') };
}
const hashOf = (hex) => blake2AsHex(hexToU8a(hex));

describe('R5: multisig (row 30): a first approval changes only the pending list; an execution applies the inner action', () => {
    test('a first approval: the pending list shows the new row; the wallet is not remounted; no wallet component of the multisig is reloaded', async () => {
        const w = await msWorld();
        try {
            const root = w.doc.getElementById('wallet-dashboard');
            const summary = w.doc.getElementById('wsec-summary');
            const panel = w.slot.querySelector('.multisig-panel');
            assert.match(w.list().textContent, /No pending transactions/);
            await w.ui.review({ multisig: w.ms, callHex: CALL, inner: { key: 'balances.transfer', params: { to: C } } });
            await settle();
            await w.sign();
            const r = w.sub.last();
            assert.equal(r.action.params.multisig, w.ms.address, 'the action names the multisig');
            await r.emit(READY);
            w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
            w.chain.head = 42;
            await r.emit(IN1, [ev('multisig', 'NewMultisig', [A, w.ms.address, hashOf(CALL)]), success()]);
            assert.match(w.list().textContent, /1 of 2 approvals/, 'the pending list updated in place (SET)');
            assert.ok(w.doc.getElementById('wallet-dashboard') === root && w.doc.getElementById('wsec-summary') === summary, 'the wallet root and its sections are the same nodes');
            assert.ok(w.slot.querySelector('.multisig-panel') === panel, 'the multisig panel was not remounted, only its list');
            assert.deepEqual(w.refreshes, [], 'no whole-wallet remount');
            assert.deepEqual(w.wallet, [], 'the multisig\'s balance and staking were not touched by an approval');
            await r.emit(FIN1, [success()]);
        } finally { w.restore(); }
    });
    test('the final approval executes: the inner action\'s components of the MULTISIG account reload (staking after a bond); the row settles with S6 and leaves', async () => {
        const w = await msWorld({ signer: B });
        try {
            w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
            await w.ui.mountPending(w.slot, w.ms);
            await settle();
            assert.match(w.list().textContent, /1 of 2 approvals/);
            const inner = { key: 'staking.bondNominate', params: { amount: '10', n: 1 } };
            let innerDone = 0;
            await w.ui.review({ multisig: w.ms, mode: 'approve', callHash: hashOf(CALL), callHex: CALL, inner, onSuccess: () => { innerDone++; } });
            await settle();
            await w.sign();
            const r = w.sub.last();
            assert.deepEqual(r.action.params.inner, inner, 'the inner action travels with the multisig transaction');
            await r.emit(READY);
            w.chain.pending = []; w.chain.head = 42;
            await r.emit(IN1, [ev('staking', 'Bonded', [w.ms.address, '10']), ev('multisig', 'MultisigExecuted', [B, { height: 900, index: 2 }, w.ms.address, hashOf(CALL), { isOk: true, isErr: false }]), success()]);
            const polled = w.wallet.filter(i => i.poll && i.block === 42);
            assert.ok(polled.length >= 1, 'the multisig\'s wallet re-read its figures for block 42');
            assert.equal(innerDone, 1, 'the caller\'s own success still runs');
            const settled = w.list().querySelector('.ui-chip.is-positive');
            assert.ok(settled, 'the executed row holds a done chip');
            assert.equal(settled.textContent.trim(), say('S6', { n: 42 }));
            await w.clock.advance(2000);
            assert.equal(w.list().querySelector('.multisig-pending-row'), null, 'it left after the hold');
            assert.match(w.list().textContent, /No pending transactions/);
            assert.deepEqual(w.refreshes, [], 'no whole-wallet remount');
            await r.emit(FIN1, [success()]);
        } finally { w.restore(); }
    });
    test('an execution whose inner call failed (MultisigExecuted Err): no inner reload, no settle word', async () => {
        const w = await msWorld({ signer: B });
        try {
            w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
            await w.ui.mountPending(w.slot, w.ms);
            await settle();
            await w.ui.review({ multisig: w.ms, mode: 'approve', callHash: hashOf(CALL), callHex: CALL, inner: { key: 'staking.bondNominate', params: {} } });
            await settle();
            await w.sign();
            const r = w.sub.last();
            await r.emit(READY);
            await r.emit(IN1, [ev('multisig', 'MultisigExecuted', [B, { height: 900, index: 2 }, w.ms.address, hashOf(CALL), { isOk: false, isErr: true, asErr: { isBadOrigin: true, type: 'BadOrigin' } }]), success()]);
            await w.clock.advance(5000);
            assert.deepEqual(w.wallet, []);
            assert.equal(w.list().querySelector('.ui-chip.is-positive'), null);
        } finally { w.restore(); }
    });
    test('a call edited in the review is not the inner action any more: no inner effects travel with it', async () => {
        const w = await msWorld({ threshold: 1 });
        try {
            await w.ui.review({ multisig: w.ms, callHex: CALL, inner: { key: 'staking.bondNominate', params: {} } });
            await settle();
            const ta = w.doc.getElementById('multisig-review-call');
            ta.value = '0x0401';
            ta.dispatchEvent(new w.win.Event('input', { bubbles: true }));
            w.doc.getElementById('multisig-review-load').click();
            await settle();
            await w.sign();
            assert.equal(w.sub.last().action.params.inner, undefined);
        } finally { w.restore(); }
    });
    test('a first approval that failed or was dropped: the pending list is not re-read', async () => {
        for (const end of ['failed', 'dropped']) {
            const w = await msWorld();
            try {
                await w.ui.review({ multisig: w.ms, callHex: CALL, inner: { key: 'balances.transfer', params: { to: C } } });
                await settle();
                await w.sign();
                const r = w.sub.last();
                await r.emit(READY);
                w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
                if (end === 'failed') await r.emit(IN1, [failure()]); else await r.drop();
                await w.clock.advance(5000);
                assert.match(w.list().textContent, /No pending transactions/, end);
                assert.deepEqual(w.refreshes, [], end);
            } finally { w.restore(); }
        }
    });
    test('a wallet switch mid-wait: the multisig list of the old wallet is not re-read into the page', async () => {
        const w = await msWorld();
        try {
            await w.ui.review({ multisig: w.ms, callHex: CALL, inner: { key: 'balances.transfer', params: { to: C } } });
            await settle();
            await w.sign();
            const r = w.sub.last();
            await r.emit(READY);
            w.slot.remove();                       // the wallet page for another account replaced this one
            w.core.accountChanged(OTHER);
            w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
            let reads = 0;
            const entries = w.chain.api.query.multisig.multisigs.entries;
            w.chain.api.query.multisig.multisigs.entries = async (...a) => { reads++; return entries(...a); };
            await r.emit(IN1, [ev('multisig', 'NewMultisig', [A, w.ms.address, hashOf(CALL)]), success()]);
            await w.clock.advance(5000);
            assert.equal(reads, 0);
        } finally { w.restore(); }
    });
});

describe('R5: effects row 30 and the proxy variants (lib/action-effects.js)', () => {
    const MS = 'multisig-address';
    const base = (o) => ({ key: 'multisig.transaction', stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: A, ...o });
    test('executed: the inner key\'s known results and later notes apply to the multisig (a payout from a multisig)', () => {
        const pairs = [{ era: 501, validator: B }];
        const e = effectsFor(base({ params: { multisig: MS, kind: 'execute', threshold: 2, inner: { key: 'staking.payout', params: { account: MS, pairs } } },
            events: [ev('staking', 'PayoutStarted', [501, B]), ev('staking', 'Rewarded', [MS, { Staked: null }, '1']), ev('multisig', 'MultisigExecuted', []), success()],
            outcome: { ok: true, executed: 'ok' } }));
        assert.deepEqual(e.known.map(k => [k.account, k.domain, k.op, k.key]), [[MS, 'rewards.unpaid', 'remove', `501:${B}`]]);
        const bond = effectsFor(base({ params: { multisig: MS, kind: 'execute', threshold: 2, inner: { key: 'staking.bondNominate', params: {} } }, outcome: { ok: true, executed: 'ok' } }));
        assert.deepEqual(bond.later, [{ account: MS, domain: null, note: 'nextEra' }]);
        assert.ok(bond.changes.some(c => c.account === MS && c.domains.includes('staking.ledger')));
    });
    test('a first approval: no known results, no later notes, nothing for the inner key', () => {
        const e = effectsFor(base({ params: { multisig: MS, kind: 'approve', threshold: 2, inner: { key: 'staking.payout', params: { account: MS, pairs: [{ era: 501, validator: B }] } } },
            events: [ev('staking', 'Rewarded', [MS, { Staked: null }, '1']), success()], outcome: { ok: true, executed: null, approvalRecorded: true } }));
        assert.deepEqual(e.changes, [{ account: MS, domains: ['multisig.pending'] }]);
        assert.deepEqual(e.known, []);
        assert.deepEqual(e.later, []);
    });
    test('threshold 1 (no multisig event; a failed inner call fails the extrinsic): an execute is executed', () => {
        const e = effectsFor(base({ params: { multisig: MS, kind: 'execute', threshold: 1, inner: { key: 'staking.bondNominate', params: {} } }, outcome: { ok: true, executed: null, approvalRecorded: false } }));
        assert.ok(e.changes.some(c => c.account === MS && c.domains.includes('staking.ledger')));
    });
    test('threshold 2, kind execute but no MultisigExecuted (outcome not confirmed): the pending list only', () => {
        const e = effectsFor(base({ params: { multisig: MS, kind: 'execute', threshold: 2, inner: { key: 'staking.bondNominate', params: {} } }, outcome: { ok: true, executed: null, approvalRecorded: false } }));
        assert.deepEqual(e.changes, [{ account: MS, domains: ['multisig.pending'] }]);
    });
    test('executed with no inner action known (approved from the pending list): the multisig\'s chain components are re-read, nothing is claimed', () => {
        const e = effectsFor(base({ params: { multisig: MS, kind: 'execute', threshold: 2 }, outcome: { ok: true, executed: 'ok' } }));
        const doms = new Set(e.changes.filter(c => c.account === MS).flatMap(c => c.domains));
        for (const d of ['multisig.pending', 'balance', 'staking.ledger', 'staking.nominations', 'locks', 'validator.status']) assert.ok(doms.has(d), d);
        assert.deepEqual(e.known, []);
        assert.deepEqual(e.changes.filter(c => c.account !== MS), []);
    });
    test('an inner action whose proof is missing from the events claims nothing for the inner key', () => {
        const e = effectsFor(base({ params: { multisig: MS, kind: 'execute', threshold: 2, inner: { key: 'elections.withdraw', params: { role: 'Candidate' } } }, outcome: { ok: true, executed: 'ok' } }));
        assert.deepEqual(e.known, [], 'no Renounced for the multisig: no role change claimed');
    });
    test('no multisig named: never the signer\'s own components', () => {
        const e = effectsFor(base({ params: { kind: 'approve', threshold: 2 }, outcome: { ok: true, approvalRecorded: true } }));
        assert.deepEqual(e.changes.filter(c => c.account === A), []);
    });
    test('proxy variants of the R3 rows: R gets the domains, the signing proxy only its fee', () => {
        for (const key of ['staking.unbond', 'staking.withdraw', 'staking.migrateCurrency', 'democracy.unlock', 'democracy.removeVote', 'democracy.undelegate', 'validator.manage']) {
            const e = effectsFor({ key, params: { real: STASH, stash: STASH }, stage: 'inBlock', events: [success()], blockNumber: 9, txHash: '0x1', signer: PROXY, outcome: { ok: true } });
            const mine = e.changes.filter(c => c.account === PROXY).flatMap(c => c.domains);
            assert.deepEqual(mine, ['balance'], key);
            assert.ok(e.changes.some(c => c.account === STASH && c.domains.length), key);
        }
    });
});

describe('R5: the wiring in script.js (design 2.1 multisig branch and section 7)', () => {
    const script = readRepo('script.js', import.meta.url);
    test('a multisig wallet\'s action hands the action itself to the review as `inner`', async () => {
        const ms = normalizeMultisig({ signers: [A, B, C], threshold: 2, name: 'Team wallet' });
        const ext = fakeExtension('talisman', [{ address: A, name: 'Alice' }]);
        const profile = makeProfile({ extensions: [ext] });
        const tab = openTab(profile);
        const store = createMultisigStore(profile.local); store.save(ms);
        const reviewed = [];
        Object.assign(tab.ctx, {
            globalApi: {}, liveRuntimeError: () => null, multisigStore: store,
            postAction: createPostAction({ effects: effectsFor, known: createKnownResults({ storage: null }) }),
            multisigUI: { mountAccounts() {}, review: async (request) => reviewed.push(request) },
            showTxStatus: () => ({ stage: 'failed' }), trackSignedTx: () => ({ start() {}, buildFailed() {}, send: async () => {} })
        });
        vm.runInContext('async ' + bodyOf(script, 'submitSignedTx'), tab.ctx);
        tab.fn('selectWallet')(ms.address, 'multisig');
        await tab.fn('submitSignedTx')({ label: 'Stake', action: { key: 'staking.bondNominate', params: { amount: '10', n: 1 } }, buildTx: () => ({ method: { toHex: () => '0x1234' } }), onError() {} });
        assert.equal(reviewed.length, 1);
        assert.equal(reviewed[0].inner.key, 'staking.bondNominate');
        assert.deepEqual(reviewed[0].inner.params, { amount: '10', n: 1 });
    });
    test('the multisig review, the validator setup and manage deps and the hub are given the core', () => {
        const code = stripComments(script);
        assert.match(bodyOf(code, 'multisigUIDeps'), /post: \(\) => postAction/);
        assert.match(bodyOf(code, 'validateSetupDeps'), /post: postAction/);
        assert.match(bodyOf(code, 'initValidatePage'), /mountValidatePage\([^;]*post: postAction/s);
    });
    test('the manage panel\'s pending-approval review names the stash\'s validator change as its inner action', () => {
        const src = stripComments(readRepo('lib/validator-manage-view.js', import.meta.url));
        assert.match(src, /d\.multisigReview\(\{[^}]*inner: \{ key: M\.MANAGE_ACTION, params: \{ stash \} \}/);
    });
});

// ── regression guards for the five mutations that survived the Sprint R5 mutation run ──
describe('R5 guards: late and older reads never draw (validator card and multisig pending list)', () => {
    // A status fetch the test releases by hand, in any order. Reads are recorded; the body is built at release.
    function gatedFetch(w) {
        const real = w.d.fetchJson;
        const gates = [];
        w.d.fetchJson = (u) => {
            if (!/\/status\?fresh=1$/.test(u)) return real(u);
            return new Promise((resolve) => { gates.push((body) => resolve(JSON.parse(JSON.stringify(body)))); });
        };
        return gates;
    }
    // The headline holds focus after the first read, and a focused node is never replaced (a patch waits for focusout): let go of it.
    const unfocus = (w) => { const a = w.doc.activeElement; if (a && a !== w.doc.body && typeof a.blur === 'function') a.blur(); };
    const cardRefresh = async (w) => { w.core.notify({ account: STASH, domains: ['validator.status'], reason: 'failed' }); await settle(); };

    test('(mutation 1) a read below the inclusion block that carries an OLDER value than the card is not drawn', async () => {
        const w = await hubWorld();
        assert.match(w.card(), /Commission\s*5%\./);
        const r = await signCommission(w);
        w.api.st.commission = 70_000_000;
        w.server.pct[STASH] = 3;                    // the lagging server's copy (head 41, below block 42) differs from the card
        await r.emit(IN1, [prefsSet(), success()]);
        assert.ok(freshReads(w.server.reads).length >= 1, 'the card did read the server at inclusion');
        assert.match(w.card(), /Commission\s*5%\./, 'a read below the action\'s block (head 41 < 42) must not replace the card, even with a different value');
        assert.doesNotMatch(w.card(), /3%/, 'the below-block copy was drawn');
        await w.clock.advance(1500);
        assert.match(w.card(), /Commission\s*5%\./, 'still the card as it was while the server lags');
        w.server.head = 42; w.server.pct[STASH] = 7;
        await w.clock.advance(3000);
        assert.match(w.card(), /Commission\s*7%\./, 'drawn once the read reached block 42');
        await r.emit(FIN1, [prefsSet(), success()]);
    });

    test('(mutation 2) two overlapping reads resolving out of order: the older read does not replace the newer one', async () => {
        const w = await hubWorld();
        assert.match(w.card(), /Commission\s*5%\./);
        unfocus(w);
        const gates = gatedFetch(w);
        await cardRefresh(w);
        await cardRefresh(w);
        assert.equal(gates.length, 2, 'two reads of the card are in flight');
        gates[1](statusModel(STASH, 8, 43));        // the newer read resolves first
        await settle();
        assert.match(w.card(), /Commission\s*8%\./, 'the newer read is drawn');
        gates[0](statusModel(STASH, 6, 42));        // the older read lands late
        await settle();
        assert.match(w.card(), /Commission\s*8%\./, 'an older read (head 42 < drawn 43) must not replace a newer one');
        assert.doesNotMatch(w.card(), /6%/);
    });

    test('(mutation 3) the validator page is left mid-read (remounted for another account): the late read draws nowhere', async () => {
        const w = await hubWorld();
        const gates = gatedFetch(w);
        await cardRefresh(w);
        assert.equal(gates.length, 1, 'a read of the old stash is in flight');
        const oldSlot = w.doc.getElementById('validate-status-slot');
        const oldHtml = oldSlot.innerHTML;
        w.core.accountChanged(OTHER);
        await mountValidatePage(w.el, { ...w.d, fetchJson: w.server.fetch, account: { status: 'connected', address: OTHER }, manage: { ...w.d.manage, account: { status: 'connected', address: OTHER } } });
        await settle();
        assert.match(w.card(), /Commission\s*9%\./, 'the new account\'s card');
        const newHtml = w.doc.getElementById('validate-status-slot').innerHTML;
        gates[0](statusModel(STASH, 7, 50));        // the old stash's read lands late, with a newer head
        await settle();
        assert.match(w.card(), /Commission\s*9%\./, 'the old stash\'s late read was painted into the new page');
        assert.doesNotMatch(w.card(), /7%/);
        assert.equal(w.doc.getElementById('validate-status-slot').innerHTML, newHtml, 'the new page is untouched');
        assert.equal(oldSlot.innerHTML, oldHtml, 'the old page\'s nodes are untouched too');
    });

    test('(mutation 3b) the validator page is replaced by another page in the same root mid-read: the late read draws nowhere', async () => {
        const w = await hubWorld();
        const gates = gatedFetch(w);
        await cardRefresh(w);
        const oldSlot = w.doc.getElementById('validate-status-slot');
        const oldHtml = oldSlot.innerHTML;
        w.el.innerHTML = '<div id="other-page">Another page</div>';   // the SPA moved on; nothing re-mounted the hub
        gates[0](statusModel(STASH, 7, 50));
        await settle();
        assert.equal(oldSlot.innerHTML, oldHtml, 'the left page\'s card was repainted');
        assert.equal(w.el.textContent, 'Another page', 'nothing was painted into the page now shown');
    });

    function stallEntries(w) {
        const m = w.chain.api.query.multisig.multisigs;
        const real = m.entries;
        const gates = [];
        m.entries = (...a) => new Promise((resolve) => { gates.push(() => resolve(real(...a))); });
        return { gates, restore: () => { m.entries = real; } };
    }
    async function approveFirst(w) {
        await w.ui.review({ multisig: w.ms, callHex: CALL, inner: { key: 'balances.transfer', params: { to: C } } });
        await settle();
        await w.sign();
        const r = w.sub.last();
        await r.emit(READY);
        return r;
    }

    test('(mutation 4) the multisig pending list is left mid-read (slot removed): the late read does not repaint it', async () => {
        const w = await msWorld();
        try {
            const list = w.list();
            assert.match(list.textContent, /No pending transactions/);
            const r = await approveFirst(w);
            const st = stallEntries(w);
            w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
            w.chain.head = 42;
            await r.emit(IN1, [ev('multisig', 'NewMultisig', [A, w.ms.address, hashOf(CALL)]), success()]);
            assert.equal(st.gates.length, 1, 'the pending read is in flight');
            w.slot.remove();                        // the person left the wallet page
            st.gates[0]();
            await settle();
            assert.match(list.textContent, /No pending transactions/, 'the late read repainted a list the person had left');
            assert.doesNotMatch(list.textContent, /approvals/);
        } finally { w.restore(); }
    });

    test('(mutation 4b) the network (api) changes mid-read: the late read of the old api does not repaint the pending list', async () => {
        const w = await msWorld();
        try {
            const r = await approveFirst(w);
            const st = stallEntries(w);
            w.chain.pending = [{ hash: hashOf(CALL), approvals: [A] }];
            w.chain.head = 42;
            await r.emit(IN1, [ev('multisig', 'NewMultisig', [A, w.ms.address, hashOf(CALL)]), success()]);
            assert.equal(st.gates.length, 1, 'the pending read is in flight');
            const before = w.list().innerHTML;
            w.chain.api = { ...w.chain.api };       // a different node connection is now current
            st.gates[0]();
            await settle();
            assert.equal(w.list().innerHTML, before, 'a read from the previous api was painted');
        } finally { w.restore(); }
    });
});
