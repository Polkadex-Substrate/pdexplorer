// What submitSignedTx does at each step of a submission, and what the card
// says, after the second Checker round on the council feedback branch.
//
//   M1  a dropped connection after a clean In block is not a failure: no red,
//       no onError, a neutral "finality not yet confirmed" card with the link.
//   M2  messages the explorer itself throws (buildTx guards, pre-flight
//       checks) stay readable; the generic text is only for errors with
//       nothing readable in them.
//   L4  Retracted after In block puts the card back to Sent, buttons enabled,
//       block number reset, and onSuccess does not run twice.
//   L5  never included within 90 s: "Still waiting for the network", no
//       onError, buttons enabled, link to look the transaction up.
//   L8  the card itself carries no role="status" (the zone is the live
//       region), and live motion updates patch only the changed parts.
//
// Namespace import so a missing export fails its own tests, not the file.
// Run: npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../lib/tx-status.js';
import { buildTransferTx } from '../lib/wallet-safety.js';

const HASH = '0x' + 'ab'.repeat(32);
const okEvents = [{ event: { section: 'system', method: 'ExtrinsicSuccess', data: [] } }];
const vote = { id: 'v1', key: 'council.vote', params: { aye: true, idx: 4, body: 'council' } };

// Drive txStep through a list of events; returns every act in order.
function run(events) {
    let t = T.initialTxTrack();
    const acts = [];
    for (const ev of events) { const r = T.txStep(t, ev); t = r.state; acts.push(r.act); }
    return { acts, t };
}
const st = (type) => ({ type: 'status', status: { type } });
const outcome = (stage, ok = true) => ({ type: 'outcome', stage, ok });

describe('M1: connection lost after a clean In block', () => {
    test('disconnect after the events checked clean is unconfirmed, not a failure', () => {
        const { acts, t } = run([st('Ready'), st('InBlock'), outcome('inBlock'), { type: 'disconnected' }]);
        assert.deepEqual(acts, ['sent', 'read', 'firstOk', 'unconfirmed']);
        assert.equal(t.done, true);
    });
    test('disconnect before inclusion is still a failure', () => {
        assert.deepEqual(run([st('Ready'), { type: 'disconnected' }]).acts, ['sent', 'fail']);
    });
    test('FinalityTimeout after a clean inclusion is unconfirmed too', () => {
        assert.deepEqual(run([st('Ready'), st('InBlock'), outcome('inBlock'), st('FinalityTimeout')]).acts,
            ['sent', 'read', 'firstOk', 'unconfirmed']);
    });
    test('a throw from buildTx or signAndSend fails once; after the end it is ignored', () => {
        assert.deepEqual(run([{ type: 'thrown' }, { type: 'thrown' }]).acts, ['fail', 'ignore']);
    });
    test('nothing after the end is acted on', () => {
        const { acts } = run([st('Ready'), st('InBlock'), outcome('inBlock'), { type: 'disconnected' }, st('Finalized'), { type: 'finalityCap' }]);
        assert.deepEqual(acts.slice(-2), ['ignore', 'ignore']);
    });
    test('the unconfirmed card is neutral, says so, has no support code and keeps the /tx link', () => {
        const m = T.buildTxModel(vote, 'unconfirmed', okEvents, null, { blockNumber: 42, txHash: HASH });
        assert.equal(m.stage, 'unconfirmed');
        assert.equal(m.tone, 'neutral');
        assert.equal(m.stageText, 'Included in block #42, finality not yet confirmed');
        assert.equal(m.code, null);
        assert.ok(m.links.some(l => l.href === `/tx/42/${HASH}`), JSON.stringify(m.links));
        assert.match(m.title, /Vote recorded/);
    });
});

describe('M2: messages the explorer throws stay readable', () => {
    const own = [
        'The treasury pallet is not available on this runtime.',
        'utility.batch / batchAll is not available on this runtime.',
        'Runtime does not expose staking.chill - cannot perform full unbond. Please upgrade the runtime or use a partial unbond.'
    ];
    test('classifyThrownError keeps a plain Error message', () => {
        for (const msg of own) {
            const r = T.classifyThrownError(new Error(msg));
            assert.equal(r.stage, 'failed', msg);
            assert.equal(r.text, msg);
        }
    });
    test('the keep-alive refusal from lib/wallet-safety.js reaches the card and the inline error as written', () => {
        let err;
        try { buildTransferTx({ tx: { balances: { transferAllowDeath: () => ({}) } } }, 'x', '1', true); } catch (e) { err = e; }
        assert.ok(err, 'buildTransferTx should refuse');
        const m = T.buildTxModel({ id: 'k', key: 'balances.transfer' }, 'failed', null, T.asPreflight(err));
        assert.equal(m.stage, 'failed');
        assert.equal(m.text, err.message);
        assert.equal(m.body, err.message);
        assert.equal(m.code, null, 'nothing was signed, so no support code');
    });
    test('a buildTx message with a cancel word is still a failure, not Cancelled', () => {
        const m = T.buildTxModel({ id: 'r' }, 'failed', null, T.asPreflight(new Error('treasury.rejectProposal is not available on this runtime.')));
        assert.equal(m.stage, 'failed');
        assert.equal(m.tone, 'error');
    });
    test('the model text for a thrown Error is the message (inline modal error, unstake friendly path)', () => {
        const m = T.buildTxModel({ id: 'u', key: 'staking.unbond' }, 'failed', null, new Error(own[2]));
        assert.equal(m.text, own[2]);
    });
    test('generic text only for nothing readable: non-Error, empty message, engine errors', () => {
        for (const e of [undefined, null, 42, {}, new Error(''), new Error('   '), new TypeError('Cannot read properties of undefined (reading 0)')]) {
            const r = T.classifyThrownError(e);
            assert.match(r.text, /could not tell what/, String(e && e.message));
        }
    });
    test('a readable message is still sanitised and capped', () => {
        const r = T.classifyThrownError(new Error('Bad call 0x' + 'cd'.repeat(30) + ' ' + 'x'.repeat(600)));
        assert.ok(!/0x[0-9a-f]{12,}/i.test(r.text));
        assert.ok(r.text.length <= 320, String(r.text.length));
    });
    test('the RPC and cancel patterns still win', () => {
        assert.match(T.classifyThrownError(new Error('1010: Invalid Transaction: Inability to pay some fees')).text, /network fee/);
        assert.equal(T.classifyThrownError(new Error('Rejected by user')).stage, 'cancelled');
    });
});

describe('L4: Retracted after In block', () => {
    test('card back to Sent, buttons enabled, onSuccess once, re-inclusion read again', () => {
        const { acts } = run([st('Ready'), st('InBlock'), outcome('inBlock'), st('Retracted'), st('InBlock'), outcome('inBlock'), st('Finalized'), outcome('finalized')]);
        assert.deepEqual(acts, ['sent', 'read', 'firstOk', 'resent', 'read', 'ok', 'read', 'ok']);
    });
    test('a retracted transaction is not "included": a disconnect then fails it', () => {
        const { acts } = run([st('Ready'), st('InBlock'), outcome('inBlock'), st('Retracted'), { type: 'disconnected' }]);
        assert.equal(acts[acts.length - 1], 'fail');
    });
    test('Finalized ends tracking', () => {
        const r = T.txStep(run([st('Ready'), st('InBlock'), outcome('inBlock'), st('Finalized')]).t, outcome('finalized'));
        assert.equal(r.act, 'ok');
        assert.equal(r.final, true);
        assert.equal(r.state.done, true);
    });
    test('the Retracted card reads Sent to the network with no block link', () => {
        const m = T.buildTxModel(vote, { type: 'Retracted' }, null, null, { txHash: HASH });
        assert.equal(m.stageText, 'Sent to the network');
        assert.ok(!m.links.some(l => /^\/block\//.test(l.href)));
    });
});

describe('L5: never included within the cap', () => {
    test('the cap is 90 s and arms on the first Sent only', () => {
        assert.equal(T.PRE_INBLOCK_CAP_MS, 90000);
        let t = T.initialTxTrack();
        let r = T.txStep(t, st('Future')); t = r.state;
        assert.equal(r.armPreCap, true);
        r = T.txStep(t, st('Ready'));
        assert.equal(r.act, 'sent');
        assert.ok(!r.armPreCap);
    });
    test('cap before inclusion is waiting and ends tracking; after inclusion it is ignored', () => {
        const a = run([st('Ready'), { type: 'preCap' }, st('InBlock')]);
        assert.deepEqual(a.acts, ['sent', 'waiting', 'ignore']);
        const b = run([st('Ready'), st('InBlock'), outcome('inBlock'), { type: 'preCap' }]);
        assert.equal(b.acts[3], 'ignore');
    });
    test('finality cap after a retraction that never came back is waiting, not stalled', () => {
        const { acts } = run([st('Ready'), st('InBlock'), outcome('inBlock'), st('Retracted'), { type: 'finalityCap' }]);
        assert.equal(acts[acts.length - 1], 'waiting');
        const s = run([st('Ready'), st('InBlock'), outcome('inBlock'), { type: 'finalityCap' }]);
        assert.equal(s.acts[3], 'stalled');
    });
    test('the waiting card: neutral, no support code, a link to look the transaction up', () => {
        const m = T.buildTxModel(vote, 'waiting', null, null, { txHash: HASH, sentBlock: 100 });
        assert.equal(m.stage, 'waiting');
        assert.notEqual(m.tone, 'error');
        assert.equal(m.code, null);
        assert.equal(m.stageText, 'Still waiting for the network');
        assert.match(m.body, /Still waiting for the network, check the transaction later/);
        assert.ok(m.links.some(l => l.href === `/tx/100/${HASH}`), JSON.stringify(m.links));
    });
});

describe('L8: one live region, patch only what changed', () => {
    test('the card has no role="status" of its own', () => {
        const html = T.txCardHtml(T.buildTxModel(vote, 'signing'), (s) => String(s));
        assert.ok(!/role="status"/.test(html), html);
    });
    const card = (hash, status, parts) => ({ hash, status, parts: { tally: 't', voters: 'v', badge: 'b', actions: 'a', ...parts } });
    test('same frame and statuses: only the changed parts are patched', () => {
        const prev = { frame: 'F', cards: [card('h1', 'voting'), card('h2', 'voting')] };
        const next = { frame: 'F', cards: [card('h1', 'voting'), card('h2', 'voting', { tally: 't2', voters: 'v2' })] };
        assert.deepEqual(T.motionPatchPlan(prev, next), { full: false, changed: [{ hash: 'h2', parts: ['tally', 'voters'] }] });
    });
    test('nothing changed: nothing patched', () => {
        const prev = { frame: 'F', cards: [card('h1', 'voting')] };
        assert.deepEqual(T.motionPatchPlan(prev, { frame: 'F', cards: [card('h1', 'voting')] }), { full: false, changed: [] });
    });
    test('full render for a new snapshot, a filter change, an added or removed motion, or a status change', () => {
        const prev = { frame: 'F', cards: [card('h1', 'voting')] };
        assert.equal(T.motionPatchPlan(null, prev).full, true);
        assert.equal(T.motionPatchPlan(prev, { frame: 'G', cards: [card('h1', 'voting')] }).full, true);
        assert.equal(T.motionPatchPlan(prev, { frame: 'F', cards: [card('h1', 'voting'), card('h2', 'voting')] }).full, true);
        assert.equal(T.motionPatchPlan(prev, { frame: 'F', cards: [] }).full, true);
        assert.equal(T.motionPatchPlan(prev, { frame: 'F', cards: [card('h1', 'approved')] }).full, true);
    });
});
