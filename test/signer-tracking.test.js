// Signer.update relay for the split signAsync, re-check, send path.
//
// signAndSend used to call the injected signer's optional update(id, result)
// for every status of the transaction (@polkadot/api createClass.ts
// #updateSigner, skipped when the id is -1). lib/tx-submit.js now signs with
// signAsync, re-checks the wallet, then calls send(cb); on that path the api
// drops the signing id and never calls update. lib/signer-tracking.js puts it
// back: a per-transaction wrapper records the id the wallet's signPayload or
// signRaw returned, and send()'s status callback relays each result to
// inner.update(id, result). A wallet's update can never break or delay the
// submission. Research: cto-team plans, 2026-11-11 signer update tracking.
//
// Run: npm test

import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// Namespace import so a missing module export fails its own test.
import * as ST from '../lib/signer-tracking.js';
import { trackSignedTx, signAndSendOptions } from '../lib/tx-submit.js';
import { buildTxModel } from '../lib/tx-status.js';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const tracking = (inner) => {
    assert.equal(typeof ST.trackingSigner, 'function', 'lib/signer-tracking.js exports trackingSigner');
    return ST.trackingSigner(inner);
};

// A wallet signer as an extension injects it: a class instance, so update
// must be called as a method (this === the signer).
class FakeSigner {
    constructor({ ids = [1], raw = false, payload = true, update = true, throws = false } = {}) {
        this.ids = ids.slice(); this.updates = []; this.thisOk = true;
        if (payload) this.signPayload = async (p) => ({ id: this.ids.shift(), signature: '0xsig', payload: p });
        if (raw) this.signRaw = async (p) => ({ id: this.ids.shift(), signature: '0xraw', raw: p });
        if (update) {
            this.update = function (id, status) {
                if (this !== self) self.thisOk = false;
                self.updates.push([id, status]);
                if (throws) throw new Error('wallet update broke');
            };
        }
        const self = this;
    }
}

describe('trackingSigner (lib/signer-tracking.js)', () => {
    test('defines only the sign methods the inner signer has, never update', () => {
        const both = tracking(new FakeSigner({ raw: true })).signer;
        assert.equal(typeof both.signPayload, 'function');
        assert.equal(typeof both.signRaw, 'function');
        assert.equal('update' in both, false, 'an update on the wrapper would let a fixed api call it twice');

        const payloadOnly = tracking(new FakeSigner()).signer;
        assert.equal(typeof payloadOnly.signPayload, 'function');
        assert.equal('signRaw' in payloadOnly, false);

        const rawOnly = tracking(new FakeSigner({ raw: true, payload: false })).signer;
        assert.equal('signPayload' in rawOnly, false, 'api picks signPayload first when it exists');
        assert.equal(typeof rawOnly.signRaw, 'function');
    });

    test('delegates signPayload: same argument in, the wallet result out unchanged', async () => {
        const inner = new FakeSigner({ ids: [7] });
        const t = tracking(inner);
        const p = { method: '0x00' };
        const r = await t.signer.signPayload(p);
        assert.equal(r.payload, p);
        assert.deepEqual(r, { id: 7, signature: '0xsig', payload: p });
    });

    test('keeps a returned signedTransaction as the wallet gave it', async () => {
        const inner = new FakeSigner();
        inner.signPayload = async () => ({ id: 3, signature: '0xs', signedTransaction: '0xfeed' });
        const t = tracking(inner);
        assert.deepEqual(await t.signer.signPayload({}), { id: 3, signature: '0xs', signedTransaction: '0xfeed' });
        t.relay('Ready');
        assert.deepEqual(inner.updates, [[3, 'Ready']]);
    });

    test('relays each status to inner.update with the signing id, as a method call', async () => {
        const inner = new FakeSigner({ ids: [5] });
        const t = tracking(inner);
        await t.signer.signPayload({});
        const a = { status: 'Ready' }, b = { status: 'InBlock' };
        t.relay(a); t.relay(b);
        assert.deepEqual(inner.updates, [[5, a], [5, b]]);
        assert.equal(inner.updates[0][1], a, 'the same result object, not a copy');
        assert.equal(inner.thisOk, true);
    });

    test('id 0 is a real id', async () => {
        const inner = new FakeSigner({ ids: [0] });
        const t = tracking(inner);
        await t.signer.signPayload({});
        t.relay('Ready');
        assert.deepEqual(inner.updates, [[0, 'Ready']]);
    });

    test('id -1 (the api\'s "no id") and a missing id are never relayed', async () => {
        for (const id of [-1, undefined]) {
            const inner = new FakeSigner({ ids: [id] });
            const t = tracking(inner);
            await t.signer.signPayload({});
            t.relay('Ready');
            assert.deepEqual(inner.updates, [], `id ${id} was relayed`);
        }
    });

    test('nothing is relayed before anything was signed', () => {
        const inner = new FakeSigner();
        tracking(inner).relay('Ready');
        assert.deepEqual(inner.updates, []);
    });

    test('signed more than once: the last id is used', async () => {
        const inner = new FakeSigner({ ids: [1, 2] });
        const t = tracking(inner);
        await t.signer.signPayload({});
        await t.signer.signPayload({});
        t.relay('Ready');
        assert.deepEqual(inner.updates, [[2, 'Ready']]);
    });

    test('a signRaw-only signer: the raw id is relayed', async () => {
        const inner = new FakeSigner({ raw: true, payload: false, ids: [9] });
        const t = tracking(inner);
        const r = await t.signer.signRaw({ data: '0x01' });
        assert.deepEqual(r, { id: 9, signature: '0xraw', raw: { data: '0x01' } });
        t.relay('Ready');
        assert.deepEqual(inner.updates, [[9, 'Ready']]);
    });

    test('a rejected signature propagates and records nothing', async () => {
        const inner = new FakeSigner({ ids: [4] });
        inner.signPayload = async () => { throw new Error('Cancelled'); };
        const t = tracking(inner);
        await assert.rejects(t.signer.signPayload({}), /Cancelled/);
        t.relay('Ready');
        assert.deepEqual(inner.updates, []);
    });

    test('an update that throws is swallowed', async () => {
        const inner = new FakeSigner({ throws: true });
        const t = tracking(inner);
        await t.signer.signPayload({});
        assert.doesNotThrow(() => t.relay('Ready'));
        assert.equal(inner.updates.length, 1);
    });

    test('an update that returns a rejecting promise is not awaited and does not go unhandled', async () => {
        const unhandled = [];
        const onUnhandled = (e) => unhandled.push(e);
        process.on('unhandledRejection', onUnhandled);
        try {
            const inner = new FakeSigner();
            inner.update = () => Promise.reject(new Error('async update broke'));
            const t = tracking(inner);
            await t.signer.signPayload({});
            assert.equal(t.relay('Ready'), undefined, 'relay returns nothing to await');
            await flush();
            assert.deepEqual(unhandled, []);
        } finally { process.off('unhandledRejection', onUnhandled); }
    });

    test('an update that never settles does not hold anything up', async () => {
        const inner = new FakeSigner();
        inner.update = () => new Promise(() => {});
        const t = tracking(inner);
        await t.signer.signPayload({});
        assert.equal(t.relay('Ready'), undefined);
    });

    test('a signer without update: the signer is passed through as it is, relay does nothing', async () => {
        const inner = new FakeSigner({ update: false });
        const t = tracking(inner);
        assert.equal(t.signer, inner, 'wallets without update are not wrapped at all');
        await t.signer.signPayload({});
        assert.doesNotThrow(() => t.relay('Ready'));
    });

    test('no signer (the api\'s own signer is used): passed through, relay does nothing', () => {
        for (const s of [undefined, null]) {
            const t = tracking(s);
            assert.equal(t.signer, s);
            assert.doesNotThrow(() => t.relay('Ready'));
        }
    });

    test('each transaction gets its own wrapper: ids never cross', async () => {
        const inner = new FakeSigner({ ids: [1, 2] });
        const t1 = tracking(inner), t2 = tracking(inner);
        await t1.signer.signPayload({});
        await t2.signer.signPayload({});
        t1.relay('a'); t2.relay('b');
        assert.deepEqual(inner.updates, [[1, 'a'], [2, 'b']]);
    });
});

// trackSignedTx.send on the checked path (stillValid), with a fake
// transaction whose signAsync asks the signer it was given, as the api does.
function world({ validAfterSign = true, validBeforeSign = true, raw = false } = {}) {
    let phase = 'before';
    const calls = { send: 0, onError: [], signOptions: null };
    let statusCb = null;
    const api = {
        registry: {}, on() {}, off() {},
        consts: { balances: { existentialDeposit: 1n } },
        query: { system: { account: async () => ({ nonce: 0, data: { free: 10n ** 20n, reserved: 0n, frozen: 0n } }) } },
        rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 9 } }) } }
    };
    const signed = { nonce: 4, send: (cb) => { calls.send++; statusCb = cb; return Promise.resolve(() => {}); } };
    const tx = {
        paymentInfo: async () => ({ partialFee: 1n }),
        signAsync: async (_addr, o) => {
            calls.signOptions = o;
            const s = o.signer;
            if (typeof s.signPayload === 'function') await s.signPayload({ method: '0x00' });
            else await s.signRaw({ data: '0x00' });
            phase = 'after';
            return signed;
        }
    };
    const shown = [];
    const run = trackSignedTx({
        api, action: { id: 'a', key: 'multisig.approveAsMulti', params: {} },
        show: (a, st, ev, err, ex) => { const m = buildTxModel(a, st, ev, err, ex); shown.push(m); return m; },
        onError: (t) => calls.onError.push(t)
    });
    const stillValid = () => (phase === 'before' ? validBeforeSign : validAfterSign);
    const result = (type) => ({ status: { type, [`is${type}`]: true }, txHash: { toHex: () => '0x01' } });
    return {
        run, tx, calls, shown, stillValid,
        emit: async (type) => { const r = result(type); statusCb(r); await flush(); return r; }
    };
}

describe('send() relays statuses to the wallet\'s update (lib/tx-submit.js)', () => {
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => mock.timers.reset());

    test('a signer with update gets every status, with its signing id and the result object', async () => {
        const w = world();
        const inner = new FakeSigner({ ids: [11] });
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        assert.notEqual(w.calls.signOptions.signer, inner, 'signAsync got the tracking wrapper');
        assert.equal(w.calls.signOptions.withSignedTransaction, true);
        assert.equal(w.calls.signOptions.allowCallDataAlteration, false);
        const ready = await w.emit('Ready');
        const bc = await w.emit('Broadcast');
        assert.deepEqual(inner.updates, [[11, ready], [11, bc]]);
        assert.equal(inner.updates[0][1], ready);
        assert.equal(inner.thisOk, true);
        assert.equal(w.shown.at(-1).stage, 'broadcast');
    });

    test('a signer without update: signed with the signer itself and the lifecycle runs as before', async () => {
        const w = world();
        const inner = new FakeSigner({ update: false });
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        assert.deepEqual(w.calls.signOptions, signAndSendOptions(inner));
        assert.equal(w.calls.signOptions.signer, inner);
        await w.emit('Ready');
        assert.equal(w.shown.at(-1).stage, 'broadcast');
        assert.deepEqual(w.calls.onError, []);
    });

    test('an update that throws breaks nothing: sent once, the card moves on, no error', async () => {
        const w = world();
        const inner = new FakeSigner({ throws: true });
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        await w.emit('Ready');
        assert.equal(w.calls.send, 1);
        assert.equal(inner.updates.length, 1);
        assert.equal(w.shown.at(-1).stage, 'broadcast');
        assert.deepEqual(w.calls.onError, []);
    });

    test('id 0 is relayed through send()', async () => {
        const w = world();
        const inner = new FakeSigner({ ids: [0] });
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        const r = await w.emit('Ready');
        assert.deepEqual(inner.updates, [[0, r]]);
    });

    test('id -1 is never relayed through send()', async () => {
        const w = world();
        const inner = new FakeSigner({ ids: [-1] });
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        await w.emit('Ready');
        assert.equal(w.calls.send, 1);
        assert.deepEqual(inner.updates, []);
    });

    test('a signRaw-only signer: signed with signRaw, its id relayed', async () => {
        const w = world();
        const inner = new FakeSigner({ raw: true, payload: false, ids: [6] });
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        assert.equal('signPayload' in w.calls.signOptions.signer, false);
        const r = await w.emit('Ready');
        assert.deepEqual(inner.updates, [[6, r]]);
    });

    test('the wallet changed after signing: nothing sent, update never called', async () => {
        const w = world({ validAfterSign: false });
        const inner = new FakeSigner();
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        await flush();
        assert.equal(w.calls.send, 0);
        assert.deepEqual(inner.updates, []);
        assert.deepEqual(w.calls.onError, ['Your wallet changed after signing; nothing was sent.']);
    });

    test('the wallet changed before signing: never signed, update never called', async () => {
        const w = world({ validBeforeSign: false });
        const inner = new FakeSigner();
        w.run.start();
        await w.run.send(w.tx, 'addr', inner, { stillValid: w.stillValid });
        await flush();
        assert.equal(w.calls.signOptions, null);
        assert.deepEqual(inner.updates, []);
    });

    test('the unchecked path (signAndSend) still hands the api the wallet signer itself', async () => {
        let seen = null;
        const run = trackSignedTx({ api: { registry: {}, on() {}, off() {} }, action: { key: 'x' }, show: () => ({ stage: 'signing' }) });
        const inner = new FakeSigner();
        await run.send({ signAndSend: (addr, opts) => { seen = opts; return Promise.resolve(() => {}); } }, 'addr', inner);
        assert.equal(seen.signer, inner, 'the api calls update itself on this path');
    });
});
