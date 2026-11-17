// Issue #71: Back/Cancel on the phone pairing view must be honoured at every
// stage of a WalletConnect connect attempt, not only once pairing has begun.
//
// Before the fix, lib/walletconnect-session.js connect() awaited the provider
// module load and Provider.init BEFORE it installed its cancel hook, so a
// cancelConnect() in that window did nothing: the attempt went on to call
// provider.connect() and kept the session the wallet approved. A late
// approval for an attempt cancelled after pairing began was ignored here but
// never ended at the wallet. The gate (lib/walletconnect-gate.js) had one
// shared "cancel asked" flag, so a new attempt cleared an older attempt's
// cancel.
//
// The provider is a synthetic stand-in for @walletconnect/universal-provider:
// nothing here reaches a relay or a wallet. Addresses are synthetic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import { createWalletConnectSession, WC_CANCELLED } from '../lib/walletconnect-session.js';
import { createWalletConnectGate } from '../lib/walletconnect-gate.js';
import { createWalletConnectSource } from '../lib/walletconnect-source.js';
import { WC_SESSION_HINT_KEY } from '../lib/walletconnect-config.js';

const CAIP2 = 'polkadot:3920bcb4960a1eef5580cd5367ff3f43';
const synth = (n, prefix) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const URI = 'wc:' + 'a'.repeat(64) + '@2?relay-protocol=irn&symKey=' + 'b'.repeat(64) + '&expiryTimestamp=1731600000&methods=wc_sessionPropose';

function memStorage() {
    const m = new Map();
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

const wcSession = (n, topic) => ({
    topic,
    namespaces: { polkadot: { accounts: [`${CAIP2}:${synth(n, 0)}`], methods: ['polkadot_signTransaction', 'polkadot_signMessage'], events: [] } },
    peer: { metadata: { name: 'Test Wallet', url: 'https://wallet.test' } }
});

// A provider whose init and each pairing can be held open by the test.
// Every connect() call gets its own deferred approval (log.pairings[i]).
function heldProvider({ holdInit = false } = {}) {
    const log = { init: 0, connect: 0, pairings: [], disconnects: 0, clientDisconnects: [] };
    const initGate = holdInit ? deferred() : null;
    let instance = null;
    class P {
        static async init() { log.init++; if (initGate) await initGate.promise; instance = new P(); return instance; }
        constructor() {
            this.listeners = {};
            this.session = undefined;
            this.client = {
                core: { verify: { register: async () => 'attestation' } },
                on() {},
                request: async () => ({ signature: '0x' }),
                // SignClient.disconnect({ topic, reason }): ends that one session.
                disconnect: async ({ topic }) => { log.clientDisconnects.push(topic); if (this.session && this.session.topic === topic) this.session = undefined; }
            };
        }
        on(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
        off(e, f) { this.listeners[e] = (this.listeners[e] || []).filter(x => x !== f); }
        emit(e, d) { for (const f of (this.listeners[e] || []).slice()) f(d); }
        async connect() {
            log.connect++;
            const d = deferred();
            log.pairings.push(d);
            this.emit('display_uri', URI);
            const s = await d.promise;
            this.session = s;
            return s;
        }
        async disconnect() { log.disconnects++; this.session = undefined; }
        async cleanupPendingPairings() {}
    }
    return { P, log, initGate, instance: () => instance };
}

const outcome = (p) => p.then(() => 'connected', (e) => (e && e.message) || String(e));
const endedAtWallet = (mock, topic) => mock.log.clientDisconnects.includes(topic) || (mock.log.disconnects > 0 && !(mock.instance() && mock.instance().session));

describe('#71 session: cancel before pairing starts stops the attempt', () => {
    test('cancel while the provider module is loading: provider.connect() is never called', async () => {
        const mock = heldProvider();
        const load = deferred();
        const s = createWalletConnectSession({ loadProvider: () => load.promise });
        const result = outcome(s.connect({ onUri() {} }));
        await flush();
        s.cancelConnect();
        load.resolve(mock.P);
        await flush();
        assert.equal(mock.log.connect, 0, 'provider.connect() ran after cancel');
        if (mock.log.pairings[0]) mock.log.pairings[0].resolve(wcSession(1, 'topic-1'));   // a wallet that approves anyway
        assert.equal(await result, WC_CANCELLED, 'the cancelled attempt did not end as Cancelled');
        assert.equal(s.isConnected(), false, 'a cancelled attempt kept a session');
    });

    test('cancel during Provider.init: provider.connect() is never called', async () => {
        const mock = heldProvider({ holdInit: true });
        const s = createWalletConnectSession({ loadProvider: async () => mock.P });
        const result = outcome(s.connect({ onUri() {} }));
        await flush();
        assert.equal(mock.log.init, 1, 'init has started');
        s.cancelConnect();
        mock.initGate.resolve();
        await flush();
        assert.equal(mock.log.connect, 0, 'provider.connect() ran after cancel');
        if (mock.log.pairings[0]) mock.log.pairings[0].resolve(wcSession(1, 'topic-1'));
        assert.equal(await result, WC_CANCELLED);
        assert.equal(s.isConnected(), false, 'a cancelled attempt kept a session');
    });
});

describe('#71 session: a late approval for a cancelled attempt is ended, not kept', () => {
    test('cancel after pairing started, then the wallet approves: no session here, and it is ended at the wallet', async () => {
        const mock = heldProvider();
        const s = createWalletConnectSession({ loadProvider: async () => mock.P });
        const result = outcome(s.connect({ onUri() {} }));
        await flush();
        assert.equal(mock.log.connect, 1);
        s.cancelConnect();
        assert.equal(await result, WC_CANCELLED);
        mock.log.pairings[0].resolve(wcSession(1, 'topic-late'));
        await flush();
        assert.equal(s.isConnected(), false);
        assert.ok(endedAtWallet(mock, 'topic-late'), 'the late session from the cancelled attempt was left open at the wallet');
    });

    test('a new attempt after a cancel works, and the older attempt\'s late approval neither replaces nor ends it', async () => {
        const mock = heldProvider();
        const s = createWalletConnectSession({ loadProvider: async () => mock.P });
        const first = outcome(s.connect({ onUri() {} }));
        await flush();
        s.cancelConnect();
        assert.equal(await first, WC_CANCELLED);
        const second = outcome(s.connect({ onUri() {} }));
        await flush();
        assert.equal(mock.log.connect, 2);
        mock.log.pairings[1].resolve(wcSession(2, 'topic-new'));
        assert.equal(await second, 'connected');
        mock.log.pairings[0].resolve(wcSession(1, 'topic-old'));   // the first attempt's approval arrives late
        await flush();
        assert.equal(s.isConnected(), true, 'the older completion cleared the newer session');
        assert.deepEqual(s.accounts().map(a => a.address), [synth(2, 88)], 'the older completion replaced the newer session');
        assert.ok(mock.log.clientDisconnects.includes('topic-old'), 'the stale session was not ended at the wallet');
        assert.ok(!mock.log.clientDisconnects.includes('topic-new'), 'the newer session was ended');
    });

    test('cancel during init, then a new attempt: only the new attempt pairs', async () => {
        const mock = heldProvider({ holdInit: true });
        const s = createWalletConnectSession({ loadProvider: async () => mock.P });
        const first = outcome(s.connect({ onUri() {} }));
        await flush();
        s.cancelConnect();
        const second = outcome(s.connect({ onUri() {} }));
        mock.initGate.resolve();
        await flush();
        assert.equal(mock.log.connect, 1, 'the cancelled attempt started a pairing too');
        mock.log.pairings[0].resolve(wcSession(2, 'topic-new'));
        assert.equal(await first, WC_CANCELLED);
        assert.equal(await second, 'connected');
        assert.equal(s.isConnected(), true);
    });
});

describe('#71 session: normal pairing and an explicit rejection still work', () => {
    test('normal pairing: accounts come back and the session is kept', async () => {
        const mock = heldProvider();
        const s = createWalletConnectSession({ loadProvider: async () => mock.P });
        const p = s.connect({ onUri() {} });
        await flush();
        mock.log.pairings[0].resolve(wcSession(3, 'topic-3'));
        assert.deepEqual((await p).map(a => a.address), [synth(3, 88)]);
        assert.equal(s.isConnected(), true);
        assert.deepEqual(mock.log.clientDisconnects, []);
    });

    test('the wallet rejects: the rejection is reported and a later attempt still pairs', async () => {
        const mock = heldProvider();
        const s = createWalletConnectSession({ loadProvider: async () => mock.P });
        const p = outcome(s.connect({ onUri() {} }));
        await flush();
        mock.log.pairings[0].reject(new Error('User rejected.'));
        assert.equal(await p, 'User rejected.');
        assert.equal(s.isConnected(), false);
        const again = s.connect({ onUri() {} });
        await flush();
        mock.log.pairings[1].resolve(wcSession(4, 'topic-4'));
        assert.deepEqual((await again).map(a => a.address), [synth(4, 88)]);
    });
});

describe('#71 gate: one cancel per attempt, and no session hint from a cancelled one', () => {
    // The real gate over the real source and session, on the held provider.
    function gateWorld({ holdLoad = false, holdInit = false } = {}) {
        const mock = heldProvider({ holdInit });
        const storage = memStorage();
        const loadGate = holdLoad ? deferred() : null;
        const gate = createWalletConnectGate({
            enabled: true, storage,
            load: async () => {
                if (loadGate) await loadGate.promise;
                return { createWalletConnectSource: (deps) => createWalletConnectSource({ ...deps, loadProvider: async () => mock.P }) };
            }
        });
        return { mock, storage, gate, loadGate };
    }

    test('cancel while the WalletConnect code loads, then a new attempt: the old one never pairs', async () => {
        const w = gateWorld({ holdLoad: true });
        const first = outcome(w.gate.connect(null));
        await flush();
        w.gate.cancel();
        const second = outcome(w.gate.connect(null));
        w.loadGate.resolve();
        await flush();
        assert.equal(w.mock.log.connect, 1, 'the cancelled attempt started a pairing after a newer attempt began');
        w.mock.log.pairings[0].resolve(wcSession(5, 'topic-5'));
        assert.equal(await first, 'Cancelled');
        assert.equal(await second, 'connected');
        assert.equal(w.storage.getItem(WC_SESSION_HINT_KEY), '1');
    });

    test('cancel during Provider.init through the gate: no pairing, no session hint', async () => {
        const w = gateWorld({ holdInit: true });
        const result = outcome(w.gate.connect(null));
        await flush();
        assert.equal(w.mock.log.init, 1);
        w.gate.cancel();
        w.mock.initGate.resolve();
        await flush();
        assert.equal(w.mock.log.connect, 0, 'provider.connect() ran after cancel');
        if (w.mock.log.pairings[0]) w.mock.log.pairings[0].resolve(wcSession(6, 'topic-6'));
        assert.equal(await result, 'Cancelled');
        assert.equal(w.storage.getItem(WC_SESSION_HINT_KEY), null, 'a cancelled attempt left a session hint');
        assert.equal(w.gate.isConnected(), false);
    });

    test('cancel after pairing started, late approval: no session hint, nothing connected, the session ended at the wallet', async () => {
        const w = gateWorld();
        const result = outcome(w.gate.connect(null));
        await flush();
        assert.equal(w.mock.log.connect, 1);
        w.gate.cancel();
        assert.equal(await result, 'Cancelled');
        w.mock.log.pairings[0].resolve(wcSession(7, 'topic-7'));
        await flush();
        assert.equal(w.storage.getItem(WC_SESSION_HINT_KEY), null);
        assert.equal(w.gate.isConnected(), false);
        assert.ok(endedAtWallet(w.mock, 'topic-7'), 'the late session was left open at the wallet');
    });
});
