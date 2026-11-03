// A broadcast must always end: the status subscription is not the only source
// of truth. CEO report, 3 Nov 2026: "Leave council" in a mobile wallet's
// in-app browser on iOS stayed on "Broadcasting" with "Sent to the network"
// and never moved on.
//
// The tracker (lib/tx-submit.js) followed only the author_submitAndWatch
// subscription and a 90 s wall-clock timer. Nothing ever asked the chain. An
// iOS in-app browser that is backgrounded or locked while the transaction is
// in the pool suspends JavaScript and drops the socket; polkadot-js does not
// resubscribe author_* subscriptions after a reconnect, so no further status
// can arrive, and the 90 s timer only counts time the page is awake. And if
// reading the In block result threw, `reading` stayed set, the 90 s cap was
// ignored for good, and the button said "Broadcasting" forever.
//
// Now: a watchdog asks the chain every WATCHDOG_MS after Sent, on page wake
// (visibilitychange, pageshow, online) and on reconnect. An action-specific
// check (verify) that sees the effect on chain ends it "Confirmed on chain";
// the account nonce moving past the transaction's nonce ends it "processed"
// (outcome not confirmed, check your account). A drop before inclusion keeps
// checking instead of failing when there is a way to check. A wallet that never
// answers releases the button after SIGNING_CAP_MS.
//
// Run: npm test

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../lib/tx-status.js';
import * as S from '../lib/tx-submit.js';
import { createCouncilCandidacyUI } from '../lib/council-candidacy-view.js';
import { readRepo, stripComments } from './helpers/source.js';

const HASH = '0x' + 'cd'.repeat(32);
const ADDR = 'esqZraiLVupqVqpTxGjsH9tdpqGy5a2f9eqTSr7ZLNHSXHDZ4';
const ok = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const READY = { type: 'Ready' };
const IN1 = { type: 'InBlock', asInBlock: '0xb1' };

function steps(events) {
    let t = T.initialTxTrack();
    const acts = [];
    for (const ev of events) { const r = T.txStep(t, ev); t = r.state; acts.push(r); }
    return { acts: acts.map(a => a.act), last: acts[acts.length - 1], t };
}
const st = (type) => ({ type: 'status', status: { type } });

describe('txStep: chain checks decide a silent broadcast', () => {
    test('exports the watchdog and signing caps', () => {
        assert.equal(typeof T.WATCHDOG_MS, 'number');
        assert.ok(T.WATCHDOG_MS > 0 && T.WATCHDOG_MS < T.PRE_INBLOCK_CAP_MS, 'the watchdog must run before the 90 s cap');
        assert.equal(typeof T.SIGNING_CAP_MS, 'number');
        assert.ok(T.SIGNING_CAP_MS >= 60000);
    });

    test('applied on chain after Sent ends confirmed, first success', () => {
        const r = steps([st('Ready'), { type: 'check', found: 'applied' }]);
        assert.equal(r.last.act, 'confirmed');
        assert.equal(r.last.firstOk, true);
        assert.equal(r.t.done, true);
    });

    test('nonce moved on without the effect ends processed, never a success', () => {
        const r = steps([st('Ready'), { type: 'check', found: 'processed' }]);
        assert.equal(r.last.act, 'processed');
        assert.ok(!r.last.firstOk);
        assert.equal(r.t.done, true);
    });

    test('pending, before Sent, while reading, after In block and after the end are ignored', () => {
        assert.equal(steps([st('Ready'), { type: 'check', found: 'pending' }]).last.act, 'ignore');
        assert.equal(steps([{ type: 'check', found: 'applied' }]).last.act, 'ignore');
        assert.equal(steps([st('Ready'), st('InBlock'), { type: 'check', found: 'applied' }]).last.act, 'ignore');
        assert.equal(steps([st('Ready'), st('InBlock'), { type: 'outcome', stage: 'inBlock', ok: true }, { type: 'check', found: 'applied' }]).last.act, 'ignore');
        assert.equal(steps([st('Ready'), { type: 'preCap' }, { type: 'check', found: 'applied' }]).last.act, 'ignore');
    });

    test('a drop before inclusion keeps checking when the chain can be asked, and still fails when it cannot', () => {
        const can = steps([st('Ready'), { type: 'disconnected', canCheck: true }]);
        assert.equal(can.last.act, 'lost');
        assert.equal(can.t.done, false);
        assert.equal(steps([st('Ready'), { type: 'disconnected', canCheck: true }, { type: 'check', found: 'applied' }]).last.act, 'confirmed');
        assert.equal(steps([st('Ready'), { type: 'disconnected' }]).last.act, 'fail');
    });

    test('a failed result read can no longer leave the tracker reading forever', () => {
        // The 90 s cap that arrives while the In block result is being read
        // used to be dropped for good.
        const r = steps([st('Ready'), st('InBlock'), { type: 'preCap' }, { type: 'readError' }]);
        assert.equal(r.last.act, 'waiting');
        assert.equal(r.t.done, true);
        const early = steps([st('Ready'), st('InBlock'), { type: 'readError' }]);
        assert.equal(early.last.act, 'ignore');
        assert.equal(early.t.reading, false);
        assert.equal(early.t.done, false);
    });

    test('a wallet that never answers ends after the signing cap; once sent the cap is ignored', () => {
        const silent = steps([{ type: 'signingCap' }]);
        assert.equal(silent.last.act, 'walletSilent');
        assert.equal(silent.t.done, true);
        assert.equal(steps([st('Ready'), { type: 'signingCap' }]).last.act, 'ignore');
    });
});

describe('buildTxModel: the confirmed, processed and silent-wallet cards', () => {
    const action = { id: 'w1', key: 'elections.withdraw', params: { role: 'Member' } };

    test('confirmed on chain uses the success copy, green, with the account link', () => {
        const m = T.buildTxModel({ id: 'g1', key: 'system.remark', params: {} }, 'confirmed', null, null, { txHash: HASH, address: ADDR });
        assert.equal(m.stage, 'confirmed');
        assert.equal(m.tone, 'ok');
        assert.equal(m.stageText, 'Confirmed on chain');
        assert.ok(m.links.some(l => l.href === `/account/${ADDR}`));
    });

    // Fable review: the withdrawal check only sees that the seat is gone. An
    // election can remove it while the withdrawal sits in the pool, so the card
    // must not claim this transaction did it.
    test('a council seat gone while the withdrawal was pending says it is no longer held, not "Confirmed"', () => {
        const m = T.buildTxModel(action, 'confirmed', null, null, { txHash: HASH, address: ADDR });
        assert.equal(m.stage, 'confirmed');
        assert.equal(m.title, 'Your seat is no longer held (withdrawn or lost at an election)');
        assert.doesNotMatch(m.stageText, /confirmed/i);
        assert.doesNotMatch(m.title + ' ' + m.body, /relinquished/i);
        assert.match(m.body, /election/i);
        assert.ok(m.links.some(l => l.href === `/account/${ADDR}`));
        for (const role of ['Candidate', 'RunnerUp']) {
            const c = T.buildTxModel({ ...action, params: { role } }, 'confirmed', null, null, { address: ADDR });
            assert.match(c.title, /no longer held/);
            assert.match(c.title, /election/);
            assert.doesNotMatch(c.stageText, /confirmed/i);
        }
    });

    test('processed is neutral, says the result is not confirmed and links the account', () => {
        const m = T.buildTxModel(action, 'processed', null, null, { txHash: HASH, address: ADDR, sentBlock: 100 });
        assert.equal(m.stage, 'processed');
        assert.equal(m.tone, 'neutral');
        assert.equal(m.title, 'Withdrawing your council candidacy');
        assert.match(m.body, /could not confirm/i);
        assert.match(m.body, /check your account/i);
        assert.ok(m.links.some(l => l.href === `/account/${ADDR}`));
        assert.ok(m.links.some(l => l.href === `/tx/100/${HASH}`));
        assert.equal(m.stageText, 'Processed, result not confirmed');
    });

    test('a silent wallet gets its own waiting text', () => {
        const m = T.buildTxModel(action, 'waiting', null, null, { walletSilent: true });
        assert.equal(m.stage, 'waiting');
        assert.match(m.body, /wallet has not answered/i);
    });
});

// --- The tracker ----------------------------------------------------------------
const fakeButton = () => ({ disabled: false, attrs: {}, innerHTML: 'Leave', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
function harness(opts = {}) {
    const listeners = {};
    let nonce = opts.nonce ?? 7;
    const api = {
        registry: {},
        on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
        off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); },
        rpc: {
            chain: { getHeader: () => Promise.resolve({ number: { toNumber: () => 42 } }) },
            // The pool-aware next index: counts transactions still waiting in
            // the pool, so it must never decide "processed" (Fable review).
            system: { accountNextIndex: async () => ({ toNumber: () => opts.poolNextIndex ?? nonce }) }
        },
        // The on-chain nonce: what the watchdog compares with the signed nonce.
        query: { system: { account: opts.account || (async () => ({ nonce: { toNumber: () => nonce }, data: null })) } }
    };
    const shown = [];
    const show = opts.show || ((a, s, ev, err, ex) => { const m = T.buildTxModel(a, s, ev, err, ex); shown.push(m); return m; });
    const button = fakeButton();
    const calls = { onError: [], onSuccess: 0, stages: [], unsub: 0, verify: 0 };
    let cb = null;
    const tx = { nonce: opts.txNonce === undefined ? { toNumber: () => 7 } : opts.txNonce,
        signAndSend: (addr, o, f) => { cb = f; return opts.signAndSend ? opts.signAndSend() : Promise.resolve(() => { calls.unsub++; }); } };
    let verdict = opts.verdict || 'pending';
    const run = S.trackSignedTx({
        api, button, show, idleText: 'Sign & leave council',
        action: { id: 'w1', key: 'elections.withdraw', params: { role: 'Member' } },
        verify: opts.noVerify ? undefined : async () => { calls.verify++; if (verdict instanceof Error) throw verdict; return verdict; },
        onError: (t) => calls.onError.push(t), onSuccess: () => { calls.onSuccess++; }, onStage: (s) => calls.stages.push(s)
    });
    const emit = async (status, events) => { cb({ status, events, txHash: { toHex: () => HASH } }); await flush(); };
    return { run, tx, emit, shown, button, calls, listeners,
        last: () => shown[shown.length - 1],
        setVerdict: v => { verdict = v; }, setNonce: n => { nonce = n; },
        fire: async (e) => { (listeners[e] || []).slice().forEach(f => f()); await flush(); } };
}
async function tick(ms) { mock.timers.tick(ms); await flush(); }

describe('the tracker never leaves a silent broadcast spinning', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('the reported case: Sent, then silence; the chain shows the seat gone, so it ends confirmed', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        assert.equal(h.button.disabled, true);
        assert.match(h.button.innerHTML, /Broadcasting/);
        await tick(T.WATCHDOG_MS);
        assert.ok(h.calls.verify >= 1, 'the watchdog did not ask the chain');
        assert.equal(h.button.disabled, true, 'pending on chain must keep watching');
        h.setVerdict('applied');
        await tick(T.WATCHDOG_MS);
        assert.equal(h.last().stage, 'confirmed');
        assert.match(h.last().title, /no longer held/);
        assert.equal(h.calls.onSuccess, 1);
        assert.deepEqual(h.calls.onError, []);
        assert.equal(h.button.disabled, false);
        assert.equal(h.button.textContent, 'Sign & leave council');
        assert.equal(h.calls.stages[h.calls.stages.length - 1], 'confirmed');
        assert.equal(h.calls.unsub, 1, 'the dead subscription was not released');
        const n = h.shown.length;
        await tick(T.PRE_INBLOCK_CAP_MS);
        assert.equal(h.shown.length, n, 'a timer fired after the end');
    });

    test('the nonce moving past the transaction without the effect ends processed, not success, not error', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        h.setNonce(8);
        await tick(T.WATCHDOG_MS);
        assert.equal(h.last().stage, 'processed');
        assert.equal(h.calls.onSuccess, 0);
        assert.deepEqual(h.calls.onError, []);
        assert.equal(h.button.disabled, false);
    });

    test('a transaction still in the pool is not "processed": the pool-aware next index is not the on-chain nonce', async () => {
        // accountNextIndex already counts this transaction while it waits in
        // the pool (8 > 7), but the chain has not processed it (nonce 7).
        const h = harness({ noVerify: true, poolNextIndex: 8 });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        await tick(T.WATCHDOG_MS);
        await tick(T.WATCHDOG_MS);
        assert.notEqual(h.last().stage, 'processed', 'pool-pending was reported as processed');
        assert.equal(h.button.disabled, true, 'still in the pool: keep watching');
        h.setNonce(8);
        await tick(T.WATCHDOG_MS);
        assert.equal(h.last().stage, 'processed');
    });

    test('the watchdog reads the on-chain nonce, not rpc.system.accountNextIndex', () => {
        const src = stripComments(readFileSync(new URL('../lib/tx-submit.js', import.meta.url), 'utf8'));
        assert.doesNotMatch(src, /accountNextIndex/);
        assert.match(src, /query\.system\.account/);
    });

    test('without an action check the nonce alone settles it', async () => {
        const h = harness({ noVerify: true });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        h.setNonce(9);
        await tick(T.WATCHDOG_MS);
        assert.equal(h.last().stage, 'processed');
    });

    test('page wake asks the chain at once, without waiting for a timer (iOS resume)', async () => {
        const h = harness({ verdict: 'applied' });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        assert.equal(typeof S.recheckSignedTxs, 'function');
        S.recheckSignedTxs();
        await flush();
        assert.equal(h.last().stage, 'confirmed');
        assert.equal(h.calls.onSuccess, 1);
    });

    test('a reconnect asks the chain; a drop before inclusion is not a failure while it can still check', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        await h.fire('disconnected');
        assert.deepEqual(h.calls.onError, [], 'a drop with a way to check reported failure');
        h.setVerdict('applied');
        await h.fire('connected');
        assert.equal(h.last().stage, 'confirmed');
    });

    test('a check that throws or hangs leaves it watching, and the 90 s cap still ends it', async () => {
        const h = harness({ account: () => new Promise(() => {}) });
        h.setVerdict(new Error('RPC down'));
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        await tick(T.WATCHDOG_MS);
        await tick(T.HEADER_READ_MS);
        assert.equal(h.button.disabled, true);
        await tick(T.PRE_INBLOCK_CAP_MS);
        await tick(T.HEADER_READ_MS);
        assert.equal(h.last().stage, 'waiting');
        assert.equal(h.button.disabled, false);
        assert.deepEqual(h.calls.onError, []);
    });

    test('the 90 s cap asks the chain one last time before saying "still waiting"', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        // A suspended page: no watchdog tick ran, then the cap is due.
        h.setVerdict('applied');
        await tick(T.PRE_INBLOCK_CAP_MS);
        assert.equal(h.last().stage, 'confirmed');
    });

    test('an exception while reading the In block result no longer freezes the button', async () => {
        let n = 0;
        const show = (a, s, ev, err, ex) => {
            const m = T.buildTxModel(a, s, ev, err, ex);
            if (s && s.type === 'InBlock' && n++ === 0) throw new TypeError('boom');
            return m;
        };
        const h = harness({ show });
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        await h.emit(IN1, ok);
        h.setVerdict('applied');
        await tick(T.WATCHDOG_MS);
        assert.equal(h.button.disabled, false, 'the button stayed on Broadcasting');
        assert.equal(h.calls.onSuccess, 1);
    });

    test('a wallet that never answers releases the button after the signing cap', async () => {
        const h = harness({ signAndSend: () => new Promise(() => {}) });
        h.run.start();
        h.run.send(h.tx, ADDR, {});
        await flush();
        assert.equal(h.button.disabled, true);
        await tick(T.SIGNING_CAP_MS);
        assert.equal(h.button.disabled, false);
        assert.equal(h.last().stage, 'waiting');
        assert.match(h.last().body, /wallet has not answered/i);
        assert.equal(h.calls.stages[h.calls.stages.length - 1], 'waiting');
    });

    test('the clean path is unchanged: no chain checks once In block arrives', async () => {
        const h = harness();
        h.run.start();
        await h.run.send(h.tx, ADDR, {});
        await h.emit(READY);
        await h.emit(IN1, ok);
        const v = h.calls.verify;
        await tick(T.WATCHDOG_MS * 3);
        assert.equal(h.calls.verify, v);
        assert.equal(h.calls.onSuccess, 1);
    });
});

// --- The council dialog -----------------------------------------------------------
function dialog(role = 'Member') {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const nodes = new Map([...html.matchAll(/id="((?:council-withdraw|close-council-withdraw|cancel-council-withdraw)[^"]*)"/g)].map(([, id]) => [id, {
        style: {}, textContent: '', innerHTML: '', disabled: false, checked: false, handlers: {},
        addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {}, setAttribute() {}, removeAttribute() {},
        async fire(type = 'click') { await this.handlers[type]?.({ target: this }); }
    }]));
    const state = { role };
    const api = {
        genesisHash: { toHex: () => '0xg' }, runtimeVersion: { specVersion: { toString: () => '392' } },
        query: { elections: { members: () => {}, runnersUp: () => {}, candidates: () => {} } },
        tx: { elections: { renounceCandidacy: r => ({ r }) } },
        rpc: { chain: { getBlockHash: async () => '0xh' } },
        at: async () => ({ query: { elections: {
            members: async () => state.role === 'Member' ? [{ who: ADDR }] : [],
            runnersUp: async () => [], candidates: async () => [] } } })
    };
    const submitted = [];
    let rechecks = 0;
    const ui = createCouncilCandidacyUI({ api: () => api, selected: () => ADDR, isMultisig: () => false,
        document: { getElementById: id => nodes.get(id) }, submit: async o => { submitted.push(o); await o.buildTx(api); },
        refresh: () => {}, connectPrompt: () => '', recheck: () => { rechecks++; } });
    return { ui, get: id => nodes.get(id), submitted, state, api, get rechecks() { return rechecks; } };
}

describe('the council withdrawal dialog', () => {
    test('passes a chain check: the role gone is applied, still a member is pending', async () => {
        const d = dialog();
        await d.ui.open();
        d.get('council-withdraw-ack').checked = true;
        await d.get('council-withdraw-ack').fire('change');
        await d.get('council-withdraw-sign').fire();
        const verify = d.submitted[0].verify;
        assert.equal(typeof verify, 'function');
        assert.equal(await verify(d.api), 'pending');
        d.state.role = null;
        assert.equal(await verify(d.api), 'applied');
    });

    test('confirmed and processed are terminal: the dialog is released and says what to do', async () => {
        for (const stage of ['confirmed', 'processed']) {
            const d = dialog();
            await d.ui.open();
            d.get('council-withdraw-ack').checked = true;
            await d.get('council-withdraw-ack').fire('change');
            await d.get('council-withdraw-sign').fire();
            d.submitted[0].onStage(stage, {});
            assert.equal(d.get('council-withdraw-retry').disabled, false, stage);
            await d.ui.open();
            assert.doesNotMatch(d.get('council-withdraw-effect').textContent, /already in progress/, stage);
        }
    });

    test('reopening while a withdrawal is in flight asks the chain now', async () => {
        const d = dialog();
        await d.ui.open();
        d.get('council-withdraw-ack').checked = true;
        await d.get('council-withdraw-ack').fire('change');
        await d.get('council-withdraw-sign').fire();
        d.ui.close();
        await d.ui.open();
        assert.match(d.get('council-withdraw-effect').textContent, /already in progress/);
        assert.equal(d.rechecks, 1);
    });
});

describe('script.js wiring', () => {
    const src = stripComments(readRepo('script.js', import.meta.url));
    test('page wake re-checks in-flight transactions', () => {
        assert.match(src, /recheckSignedTxs/);
        assert.match(src, /addEventListener\(\s*['"]visibilitychange['"][\s\S]{0,200}recheckSignedTxs/);
        assert.match(src, /addEventListener\(\s*['"]pageshow['"][\s\S]{0,80}recheckSignedTxs/);
    });
    test('submitSignedTx hands verify to the tracker and the council dialog gets recheck', () => {
        assert.match(src, /async function submitSignedTx\(\{[^}]*\bverify\b/);
        assert.match(src, /trackSignedTx\(\{[^}]*\bverify\b/);
        assert.match(src, /createCouncilCandidacyUI\(\{[\s\S]{0,400}recheck:\s*recheckSignedTxs/);
    });
});
