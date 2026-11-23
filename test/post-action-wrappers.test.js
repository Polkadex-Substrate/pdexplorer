// Design 2.1: the post-action core watches every submission through two wrappers added at ONE line of
// script.js submitSignedTx, with nothing changed in lib/tx-submit.js. This file proves the wrappers are
// transparent: every lifecycle scenario of test/tx-submit.test.js (plus the payout warn, the verify and
// the nonce ends) is run unwrapped, wrapped, and wrapped around a core that throws everywhere, and the
// recorded sequence of (button state, card stage, onError, onSuccess, onStage) must be identical.
// Also: show returns the very same model object, lib/tx-submit.js imports none of the new modules, and
// script.js wires the core exactly at the trackSignedTx line.

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';
import { harness, fakeButton, flush, ok, bad, READY, IN1, IN2, FIN1 } from './helpers/tx-harness.js';
import { PRE_INBLOCK_CAP_MS, FINALITY_CAP_MS, HEADER_READ_MS, WATCHDOG_MS } from '../lib/tx-status.js';
import { createPostAction } from '../lib/post-action.js';
import { createKnownResults } from '../lib/known-results.js';
import { effectsFor } from '../lib/action-effects.js';
import { ME, PAIRS, REGISTRY, paidItem, skippedItem, forceBatch } from './helpers/payout-events.js';

const PAYOUT = { id: 'p1', key: 'staking.payout', params: { k: 3, remaining: 0, account: ME, pairs: PAIRS } };
const heldHeader = () => { const held = []; return { held, getHeader: (h) => (h === undefined ? Promise.resolve({ number: { toNumber: () => 99 } }) : new Promise((res, rej) => held.push({ res, rej }))) }; };

// Each scenario: harness options (made fresh per run) and the steps.
const SCENARIOS = {
    'clean path to Finalized': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.emit(FIN1, ok); await h.drop(); }],
    'M1 drop after a clean In block': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.drop(); mock.timers.tick(FINALITY_CAP_MS); }],
    'drop before inclusion': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.drop(); }],
    'L4 Retracted then the next block': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.emit({ type: 'Retracted' }); await h.emit(IN2, ok); }],
    'Retracted then a dropped link': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.emit({ type: 'Retracted' }); await h.drop(); }],
    'drop during the header read': [() => { const hh = heldHeader(); return { getHeader: hh.getHeader, hh }; }, async (h, o) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.drop(); o.hh.held[0].res({ number: { toNumber: () => 42 } }); await flush(); }],
    'header read dies with the link': [() => { const hh = heldHeader(); return { getHeader: hh.getHeader, hh }; }, async (h, o) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.drop(); o.hh.held[0].rej(new Error('disconnected')); await flush(); }],
    'header read cut off after HEADER_READ_MS': [() => { const hh = heldHeader(); return { getHeader: hh.getHeader, hh }; }, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); await h.drop(); mock.timers.tick(HEADER_READ_MS); await flush(); }],
    'stalled at the finality cap': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, ok); mock.timers.tick(FINALITY_CAP_MS); await flush(); }],
    'L5 waiting after 90 s': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); mock.timers.tick(PRE_INBLOCK_CAP_MS); await flush(); await h.emit(IN1, ok); }],
    'failed events at In block': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, bad); }],
    'M2 a buildTx guard': [{}, async (h) => { h.run.start(); h.run.buildFailed(new Error('The treasury pallet is not available on this runtime.')); }],
    'M2 the wallet throws': [{}, async (h) => { h.run.start(); await h.run.send({ signAndSend: () => Promise.reject(new Error('Unable to retrieve keypair for this account')) }, ME, {}); }],
    'the wallet refuses (cancelled)': [{}, async (h) => { h.run.start(); await h.run.send({ signAndSend: () => Promise.reject(new Error('Cancelled')) }, ME, {}); }],
    'pool rejects: Usurped': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit({ type: 'Usurped' }); }],
    'pool rejects: Dropped': [{}, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit({ type: 'Dropped' }); }],
    'payout: partial batch (warn success) to Finalized': [{ action: PAYOUT, registry: REGISTRY }, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); const ev = forceBatch(paidItem(PAIRS[0]), skippedItem(), paidItem(PAIRS[2])); await h.emit(IN1, ev); await h.emit(FIN1, ev); }],
    'payout: all items failed': [{ action: PAYOUT, registry: REGISTRY }, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); await h.emit(IN1, forceBatch(skippedItem(), skippedItem(), skippedItem())); }],
    'payout: Retracted, back in a block, Finalized': [{ action: PAYOUT, registry: REGISTRY }, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); const ev = forceBatch(...PAIRS.map(p => paidItem(p))); await h.emit(IN1, ev); await h.emit({ type: 'Retracted' }); await h.emit(IN2, ev); await h.emit({ type: 'Finalized', asFinalized: '0xb2' }, ev); }],
    'confirmed by verify when the updates stop': [{ verify: async () => 'applied' }, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); mock.timers.tick(WATCHDOG_MS); await flush(); }],
    'processed by the nonce when the updates stop': [{ nonce: 5, query: { system: { account: async () => ({ nonce: 6 }) } } }, async (h) => { h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY); mock.timers.tick(WATCHDOG_MS); await flush(); }]
};

function makeCore(kind) {
    if (kind === 'plain') return null;
    if (kind === 'real') return createPostAction({ effects: effectsFor, known: createKnownResults({ storage: null }), log: () => {} });
    // Every collaborator throws: the core must swallow all of it.
    const boom = () => { throw new Error('core failure'); };
    const known = { add: boom, withdraw: boom, apply: boom, list: boom, onChange: boom, holdMs: 1 };
    const core = createPostAction({ effects: boom, known, log: () => {} });
    core.subscribe('rewards.unpaid', { account: boom, reload: boom });
    return core;
}

async function runScenario(name, kind) {
    const [o, steps] = SCENARIOS[name];
    const opts = typeof o === 'function' ? o() : { ...o };
    const h = harness({ ...opts, core: makeCore(kind) });
    let escaped = null;
    const onUnhandled = (e) => { escaped = e; };
    process.on('uncaughtException', onUnhandled);
    process.on('unhandledRejection', onUnhandled);
    try { await steps(h, opts); await flush(); } finally {
        process.off('uncaughtException', onUnhandled);
        process.off('unhandledRejection', onUnhandled);
    }
    return { record: JSON.parse(JSON.stringify(h.record)), escaped, h };
}

describe('the wrappers are transparent', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    for (const name of Object.keys(SCENARIOS)) {
        test(`${name}: identical sequence unwrapped, wrapped, and wrapped around a throwing core`, async () => {
            const plain = await runScenario(name, 'plain');
            const real = await runScenario(name, 'real');
            const hostile = await runScenario(name, 'hostile');
            assert.ok(plain.record.length >= 2, 'the scenario recorded nothing');
            assert.deepEqual(real.record, plain.record);
            assert.deepEqual(hostile.record, plain.record);
            assert.equal(real.escaped, null, String(real.escaped));
            assert.equal(hostile.escaped, null, 'a core failure reached the signing pipeline: ' + String(hostile.escaped));
        });
    }

    test('the scenarios reach the ends they are named for (not vacuous)', async () => {
        const stagesOf = async (n) => (await runScenario(n, 'plain')).record.filter(r => r.at === 'onStage').map(r => r.stage);
        assert.ok((await stagesOf('confirmed by verify when the updates stop')).includes('confirmed'));
        assert.ok((await stagesOf('processed by the nonce when the updates stop')).includes('processed'));
        assert.ok((await stagesOf('stalled at the finality cap')).includes('stalled'));
        assert.ok((await stagesOf('payout: Retracted, back in a block, Finalized')).includes('resent'));
        assert.ok((await stagesOf('L5 waiting after 90 s')).includes('waiting'));
        const warn = (await runScenario('payout: partial batch (warn success) to Finalized', 'plain')).record.find(r => r.at === 'show' && r.stage === 'inBlock');
        assert.equal(warn.tone, 'warn');
    });

    test('show returns the very same model object; stage returns what the inner stage returns', () => {
        const core = createPostAction({ effects: effectsFor, known: createKnownResults({ storage: null }), log: () => {} });
        const seen = core.observe(PAYOUT);
        const model = { stage: 'signing' };
        const wrapped = seen.show(() => model);
        assert.equal(wrapped(PAYOUT, 'signing'), model);
        assert.equal(seen.stage(() => 'inner result')('signing', model), 'inner result');
        const args = [];
        seen.show((...a) => { args.push(a.length); return model; })(PAYOUT, 'signing');
        assert.deepEqual(args, [2], 'the wrapper changed the number of arguments');
    });

    test('an inner stage that throws still throws (the wrapper adds no catch of its own)', () => {
        const core = createPostAction({ effects: effectsFor, known: createKnownResults({ storage: null }), log: () => {} });
        const seen = core.observe(PAYOUT);
        assert.throws(() => seen.stage(() => { throw new Error('inner'); })('signing', {}), /inner/);
        assert.throws(() => seen.show(() => { throw new Error('inner show'); })(PAYOUT, 'signing'), /inner show/);
    });

    test('the core runs after the existing success point: onSuccess before the core sees inBlock', async () => {
        const order = [];
        const known = createKnownResults({ storage: null });
        const core = createPostAction({ effects: (ctx) => { order.push('core:' + ctx.stage); return effectsFor(ctx); }, known, log: () => {} });
        const h = harness({ action: PAYOUT, registry: REGISTRY, core });
        const origSuccess = h.calls;
        h.run.start(); await h.run.send(h.tx, ME, {}); await h.emit(READY);
        const ev = forceBatch(...PAIRS.map(p => paidItem(p)));
        await h.emit(IN1, ev);
        const idxSuccess = h.record.findIndex(r => r.at === 'onSuccess');
        assert.ok(idxSuccess >= 0 && origSuccess.onSuccess === 1);
        assert.deepEqual(order, ['core:inBlock']);
    });
});

describe('source guards', () => {
    const TXSUBMIT = stripComments(readRepo('lib/tx-submit.js', import.meta.url));
    const SCRIPT = readRepo('script.js', import.meta.url);
    test('lib/tx-submit.js imports none of the new modules', () => {
        for (const m of ['post-action', 'known-results', 'action-effects', 'payout-refresh', 'refresh-ui']) {
            assert.ok(!TXSUBMIT.includes(m), `lib/tx-submit.js mentions ${m}`);
        }
    });
    test('self-test: the guard sees an import when there is one', () => {
        const broken = TXSUBMIT + "\nimport { createPostAction } from './post-action.js';\n";
        assert.ok(broken.includes('post-action'));
    });
    test('script.js wires the core at the one trackSignedTx line, nothing else in it changed', () => {
        assert.match(SCRIPT, /\n {4}const seen = postAction\.observe\(action\);\n {4}const run = trackSignedTx\(\{ api: globalApi, action, button, idleText, onError, onSuccess, onStage: seen\.stage\(stage\), show: seen\.show\(showTxStatus\), verify \}\);\n/);
        assert.equal((SCRIPT.match(/trackSignedTx\(\{/g) || []).length, 1);
        assert.equal((SCRIPT.match(/postAction\.observe\(/g) || []).length, 1);
    });
});
