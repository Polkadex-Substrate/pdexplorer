// WalletConnect v2 ("Connect with your phone"): a phone wallet (Nova, SubWallet)
// signs for the explorer over the WalletConnect relay. On for everyone via
// FEATURE_FLAGS.walletConnect; a browser opts out with ?wc=0 (?wc=1 undoes it).
// Research: cto-team/plans/2026-11-14-walletconnect-research.md.
//
// Layers under test:
//   1. lib/walletconnect-config.js   projectId, chain id, relay, app metadata
//   2. lib/walletconnect-gate.js     the flag and the lazy loader (eager bundle, no WC code)
//   3. lib/walletconnect-session.js  pairing, restore, expiry, accounts (provider mocked)
//   4. lib/walletconnect-signer.js   a @polkadot/api Signer over polkadot_sign*
//   5. lib/walletconnect-view.js     the pairing panel (QR drawn locally) and "Approve on your phone"
//   6. lib/walletconnect-source.js   the three above as one wallet source
//   7. the picker, script.js wiring, tx-submit end to end, the CSP
//
// Addresses are synthetic (32 bytes of one repeated value) or come from a
// mnemonic generated for this run. They belong to no one.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { Window } from 'happy-dom';
import { of } from 'rxjs';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import { createSubmittable } from '@polkadot/api/submittable';
import { toPromiseMethod } from '@polkadot/api/promise';
import { Keyring } from '@polkadot/keyring';
import { encodeAddress, decodeAddress, cryptoWaitReady, mnemonicGenerate, signatureVerify, blake2AsU8a } from '@polkadot/util-crypto';
import { hexToU8a, u8aToHex, u8aToString, u8aWrapBytes, stringToU8a, u8aConcat } from '@polkadot/util';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { installPolkadotFixes } from '../lib/tx-extensions.js';
import { trackSignedTx, WALLET_CHANGED_SIGNED } from '../lib/tx-submit.js';
import { trackingSigner } from '../lib/signer-tracking.js';
import { buildTxModel, SIGNING_CAP_MS } from '../lib/tx-status.js';
import { registryFromMetadata, remarkCall } from './helpers/extrinsic-builders.js';
import { escapeHtml } from '../lib/html-escape.js';
import { closeControlHtml } from '../lib/close-control.js';
import { sourceLabel, groupBySource, buildOptionRowsHtml } from '../lib/wallet-picker.js';
import { mountChooser, fakeWallet, acct as chooserAcct } from './helpers/chooser-world.js';
import { createWalletSession } from '../lib/wallet-session.js';
import { FEATURE_FLAGS } from '../lib/wallet-links.js';
import { makeProfile, openTab, fakeExtension, settle, addr as worldAddr } from './helpers/wallet-world.js';
import { bodyOf } from './helpers/source.js';

import * as config from '../lib/walletconnect-config.js';
import { walletConnectEnabled, createWalletConnectGate } from '../lib/walletconnect-gate.js';
import { createWalletConnectSession, WC_NO_POLKADEX_ACCOUNT } from '../lib/walletconnect-session.js';
import * as signerModule from '../lib/walletconnect-signer.js';
const { createWalletConnectSigner, normaliseSignature, payloadMessage, rawMessage, CANCELLED, TIMEOUT_TEXT, SIGN_TIMEOUT_MS, SESSION_ENDED_TEXT, DIFFERENT_TX } = signerModule;
import { mountPairingPanel, showPendingNotice } from '../lib/walletconnect-view.js';
import { createWalletConnectSource } from '../lib/walletconnect-source.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SCRIPT = read('script.js');
const CAIP2 = 'polkadot:3920bcb4960a1eef5580cd5367ff3f43';
const GENESIS = '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c';
const synth = (n, prefix) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
const valid = (a) => { try { decodeAddress(a); return true; } catch (e) { return false; } };
const short = (a) => String(a).slice(0, 8) + '...' + String(a).slice(-6);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1)); };
const URI = 'wc:' + 'a'.repeat(64) + '@2?relay-protocol=irn&symKey=' + 'b'.repeat(64) + '&expiryTimestamp=1731600000&methods=wc_sessionPropose';

function memStorage() {
    const m = new Map();
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

// A session as the sign client stores it.
function wcSession(accounts, { topic = 'topic-1', peer = 'Test Wallet', chains } = {}) {
    return {
        topic,
        namespaces: { polkadot: { accounts, methods: ['polkadot_signTransaction', 'polkadot_signMessage'], events: [], chains } },
        peer: { metadata: { name: peer, url: 'https://wallet.test' } }
    };
}

// A stand-in for @walletconnect/universal-provider's UniversalProvider class:
// what lib/walletconnect-session.js uses of it, recorded.
function mockProvider({ existing = null, approve, reply } = {}) {
    const log = { init: [], connect: [], requests: [], disconnects: 0, registerCalls: 0 };
    let instance = null;
    class P {
        static async init(opts) { log.init.push(opts); instance = new P(); return instance; }
        constructor() {
            this.listeners = {};
            this.session = existing || undefined;
            const clientListeners = {};
            this.clientListeners = clientListeners;
            this.client = {
                core: { verify: { register: async () => { log.registerCalls++; return 'attestation'; } } },
                on: (e, f) => { (clientListeners[e] = clientListeners[e] || []).push(f); },
                request: async (args) => { log.requests.push(args); return reply ? reply(args) : { signature: '0x' }; }
            };
        }
        on(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
        off(e, f) { this.listeners[e] = (this.listeners[e] || []).filter(x => x !== f); }
        removeListener(e, f) { this.off(e, f); }
        emit(e, d) { for (const f of (this.listeners[e] || []).slice()) f(d); }
        emitClient(e, d) { for (const f of (this.clientListeners[e] || []).slice()) f(d); }
        async connect(opts) {
            log.connect.push(opts);
            this.emit('display_uri', URI);
            const s = await (approve ? approve(opts) : wcSession([`${CAIP2}:${synth(1, 0)}`]));
            this.session = s;
            return s;
        }
        async disconnect() { log.disconnects++; this.session = undefined; }
        async cleanupPendingPairings() {}
    }
    return { P, log, instance: () => instance };
}

const sessionFor = (mock, extra = {}) => createWalletConnectSession({ loadProvider: async () => mock.P, ...extra });

let registry, pair, edPair, ecPair;
before(async () => {
    await cryptoWaitReady();
    registry = registryFromMetadata(substrateMetadata);
    pair = new Keyring({ type: 'sr25519', ss58Format: 88 }).addFromMnemonic(mnemonicGenerate());
    edPair = new Keyring({ type: 'ed25519', ss58Format: 88 }).addFromMnemonic(mnemonicGenerate());
    ecPair = new Keyring({ type: 'ecdsa', ss58Format: 88 }).addFromMnemonic(mnemonicGenerate());
});

// ─────────────────────────────────────────────────────────────────────────────
describe('config: one place for the project id, the chain and the app metadata', () => {
    test('project id, Polkadex mainnet CAIP-2 from the genesis hash, relay, methods', () => {
        assert.equal(config.WC_PROJECT_ID, 'b87e50ee46c399e8a602ebab081e9125');
        assert.equal(config.POLKADEX_GENESIS, GENESIS);
        assert.equal(config.POLKADEX_CAIP2, CAIP2);
        assert.equal(config.caip2FromGenesis(GENESIS), CAIP2);
        assert.equal(config.WC_RELAY_URL, 'wss://relay.walletconnect.org');
        assert.deepEqual([...config.WC_METHODS], ['polkadot_signTransaction', 'polkadot_signMessage']);
        assert.equal(config.WC_SOURCE, 'walletconnect');
    });

    test('metadata names the explorer, its real origin and an icon the site serves', () => {
        const m = config.WC_METADATA;
        assert.equal(m.name, 'Polkadex Explorer');
        assert.equal(m.url, 'https://explorer.polkadex.ee');
        assert.equal(m.icons.length, 1);
        assert.match(m.icons[0], /^https:\/\/explorer\.polkadex\.ee\/[a-z0-9_\-/]+\.png$/);
        const file = m.icons[0].replace('https://explorer.polkadex.ee/', '');
        const shipped = readdirSync(new URL('../public/', import.meta.url)).includes(file) || readdirSync(new URL('../', import.meta.url)).includes(file);
        assert.ok(shipped, 'icon file is in the repo: ' + file);
    });

    test('the config module is frozen data with no imports', () => {
        const src = read('lib/walletconnect-config.js');
        assert.ok(!/^\s*import\s/m.test(src), 'config imports nothing');
        assert.ok(Object.isFrozen(config.WC_METADATA));
        assert.ok(Object.isFrozen(config.WC_METHODS));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('flag gating: on for everyone, ?wc=0 opts this browser out, ?wc=1 is harmless', () => {
    test('the shipped flag is on', () => {
        assert.equal(FEATURE_FLAGS.walletConnect, true);
    });

    test('shipped flag, no param, nothing stored: on', () => {
        assert.equal(walletConnectEnabled({ flag: FEATURE_FLAGS.walletConnect, storage: memStorage(), search: '' }), true);
    });

    test('with the flag off (rollback), no param and nothing stored: off', () => {
        assert.equal(walletConnectEnabled({ flag: false, storage: memStorage(), search: '' }), false);
    });

    test('?wc=0 opts this browser out and remembers it; a later visit without the param stays off', () => {
        const s = memStorage();
        assert.equal(walletConnectEnabled({ flag: true, storage: s, search: '?wc=0' }), false);
        assert.equal(s.getItem(config.WC_FLAG_KEY), '0');
        assert.equal(walletConnectEnabled({ flag: true, storage: s, search: '?tab=x' }), false);
    });

    test('?wc=1 after an opt-out turns it back on; with the flag on it is harmless', () => {
        const s = memStorage();
        walletConnectEnabled({ flag: true, storage: s, search: '?wc=0' });
        assert.equal(walletConnectEnabled({ flag: true, storage: s, search: '?wc=1' }), true);
        assert.equal(walletConnectEnabled({ flag: true, storage: s, search: '' }), true);
        assert.equal(walletConnectEnabled({ flag: true, storage: memStorage(), search: '?wc=1' }), true);
    });

    test('with the flag off, ?wc=1 still opts this browser in and ?wc=0 out', () => {
        const s = memStorage();
        assert.equal(walletConnectEnabled({ flag: false, storage: s, search: '?wc=1' }), true);
        assert.equal(walletConnectEnabled({ flag: false, storage: s, search: '?tab=x' }), true);
        assert.equal(walletConnectEnabled({ flag: false, storage: s, search: '?wc=0' }), false);
    });

    test('the code flag turns it on for everyone', () => {
        assert.equal(walletConnectEnabled({ flag: true, storage: memStorage(), search: '' }), true);
    });

    test('a storage that throws (Safari private mode) is not fatal', () => {
        const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
        assert.equal(walletConnectEnabled({ flag: false, storage: bad, search: '?wc=1' }), false);
        assert.equal(walletConnectEnabled({ flag: true, storage: bad, search: '?wc=0' }), true);
    });

    test('gate off: the WalletConnect module is never loaded, there are no providers, connect refuses', async () => {
        let loads = 0;
        const gate = createWalletConnectGate({ enabled: false, storage: memStorage(), load: async () => { loads++; return {}; } });
        assert.deepEqual(gate.providers(), {});
        assert.equal(gate.isConnected(), false);
        assert.deepEqual(await gate.restore(), []);
        await assert.rejects(gate.connect({}), /not enabled/);
        assert.equal(loads, 0);
    });

    test('gate on, no session remembered: nothing loads on page load (no relay contact)', async () => {
        let loads = 0;
        const gate = createWalletConnectGate({ enabled: true, storage: memStorage(), load: async () => { loads++; return {}; } });
        assert.deepEqual(await gate.restore(), []);
        assert.equal(loads, 0);
    });

    test('gate on, session remembered: the module loads and restores it', async () => {
        const s = memStorage();
        s.setItem(config.WC_SESSION_HINT_KEY, '1');
        const accounts = [{ address: synth(4, 88), name: 'x' }];
        let loads = 0, seen = null;
        const fakeSource = { restore: async () => accounts, isConnected: () => true, provider: { enable() {} }, peerName: () => 'P', disconnect: async () => {} };
        const gate = createWalletConnectGate({
            enabled: true, storage: s, onAccounts: (a) => { seen = a; },
            load: async () => { loads++; return { createWalletConnectSource: () => fakeSource }; }
        });
        assert.deepEqual(await gate.restore(), accounts);
        assert.equal(loads, 1);
        assert.deepEqual(seen, accounts);
        assert.deepEqual(Object.keys(gate.providers()), ['walletconnect']);
    });

    test('gate on, remembered session gone (expired while away): the hint is cleared and onEnded runs', async () => {
        const s = memStorage();
        s.setItem(config.WC_SESSION_HINT_KEY, '1');
        let ended = 0;
        const fakeSource = { restore: async () => [], isConnected: () => false, provider: {}, peerName: () => '', disconnect: async () => {} };
        const gate = createWalletConnectGate({ enabled: true, storage: s, onEnded: () => { ended++; }, load: async () => ({ createWalletConnectSource: () => fakeSource }) });
        await gate.restore();
        assert.equal(ended, 1);
        assert.equal(s.getItem(config.WC_SESSION_HINT_KEY), null);
    });

    test('a failed load can be retried', async () => {
        let n = 0;
        const fakeSource = { connect: async () => [{ address: synth(5, 88) }], isConnected: () => true, provider: {}, peerName: () => '', disconnect: async () => {} };
        const gate = createWalletConnectGate({ enabled: true, storage: memStorage(), load: async () => { if (n++ === 0) throw new Error('chunk failed'); return { createWalletConnectSource: () => fakeSource }; } });
        await assert.rejects(gate.connect({}), /chunk failed/);
        assert.equal((await gate.connect({})).length, 1);
    });

    test('the gate reaches WalletConnect only through a dynamic import', () => {
        const src = read('lib/walletconnect-gate.js');
        assert.match(src, /import\(\s*'\.\/walletconnect-source\.js'\s*\)/);
        assert.ok(!/^\s*import\s[^(]*walletconnect-(session|signer|source|view)/m.test(src));
        assert.ok(!/@walletconnect/.test(src.replace(/\/\/.*$/gm, '')));
    });

    test('nothing in the eager bundle imports WalletConnect code statically', () => {
        const eager = ['script.js', 'lib/wallet-picker-view.js', 'lib/wallet-picker.js', 'lib/wallet-onboarding.js', 'lib/wallet-session.js',
            'lib/walletconnect-gate.js', 'lib/walletconnect-config.js', 'lib/tx-submit.js', 'lib/signer-tracking.js'];
        for (const f of eager) {
            const statics = [...read(f).matchAll(/^\s*import\s+[^;]*?from\s+'([^']+)'/gms)].map(m => m[1]);
            for (const s of statics) {
                assert.ok(!/@walletconnect|@reown|walletconnect-(session|signer|source|view)/.test(s), `${f} statically imports ${s}`);
            }
        }
        assert.ok(!/@reown|@walletconnect\/modal|appkit/i.test(read('package.json')), 'no AppKit or modal');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('session: pairing, restore, expiry and accounts (provider mocked)', () => {
    test('init: project id, relay, metadata; telemetry and the provider ping off', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        const o = mock.log.init[0];
        assert.equal(o.projectId, config.WC_PROJECT_ID);
        assert.equal(o.relayUrl, config.WC_RELAY_URL);
        assert.deepEqual(o.metadata, config.WC_METADATA);
        // The real SDK assigns metadata.icons (utils populateAppMetadata) and threw
        // on the frozen config object in a no-network smoke run: a writable copy.
        assert.notEqual(o.metadata, config.WC_METADATA);
        assert.ok(!Object.isFrozen(o.metadata) && !Object.isFrozen(o.metadata.icons));
        assert.equal(o.telemetryEnabled, false);
        assert.equal(o.disableProviderPing, true);
        assert.equal(mock.log.init.length, 1);
    });

    test('connect asks for the polkadot namespace: the Polkadex chain, the two sign methods, no events', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        const req = mock.log.connect[0];
        const ns = req.optionalNamespaces.polkadot;
        assert.deepEqual(ns.chains, [CAIP2]);
        assert.deepEqual(ns.methods, ['polkadot_signTransaction', 'polkadot_signMessage']);
        assert.deepEqual(ns.events, []);
        assert.deepEqual(Object.keys(req.optionalNamespaces), ['polkadot']);
        assert.ok(!req.namespaces && !req.requiredNamespaces, 'nothing required, so a wallet that does not know the chain can still answer');
    });

    test('the pairing URI reaches onUri', async () => {
        const mock = mockProvider();
        const seen = [];
        await sessionFor(mock).connect({ onUri: (u) => seen.push(u) });
        assert.deepEqual(seen, [URI]);
    });

    test('accounts come from the session as Polkadex (format 88) addresses', async () => {
        const raw0 = synth(1, 0), raw42 = synth(2, 42);
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${raw0}`, `${CAIP2}:${raw42}`]) });
        const s = sessionFor(mock);
        const accs = await s.connect({ onUri() {} });
        assert.deepEqual(accs.map(a => a.address), [synth(1, 88), synth(2, 88)]);
        accs.forEach(a => assert.ok(a.address.startsWith('e')));
        assert.deepEqual(s.accounts().map(a => a.address), [synth(1, 88), synth(2, 88)]);
        assert.equal(s.peerName(), 'Test Wallet');
        assert.equal(s.isConnected(), true);
    });

    test('accounts on other chains are ignored; malformed entries are skipped', async () => {
        const mock = mockProvider({ approve: () => wcSession([
            `polkadot:91b171bb158e2d3848fa23a9f1c25182:${synth(3, 0)}`, `${CAIP2}:not-an-address`, `${CAIP2}:${synth(4, 0)}`, 'garbage'
        ]) });
        const accs = await sessionFor(mock).connect({ onUri() {} });
        assert.deepEqual(accs.map(a => a.address), [synth(4, 88)]);
    });

    test('a session without the Polkadex chain is rejected and ended', async () => {
        const mock = mockProvider({ approve: () => wcSession([`polkadot:91b171bb158e2d3848fa23a9f1c25182:${synth(3, 0)}`]) });
        const s = sessionFor(mock);
        await assert.rejects(s.connect({ onUri() {} }), (e) => e.message === WC_NO_POLKADEX_ACCOUNT);
        assert.equal(mock.log.disconnects, 1);
        assert.equal(s.isConnected(), false);
        assert.deepEqual(s.accounts(), []);
    });

    test('restore: an existing session on load comes back without pairing', async () => {
        const mock = mockProvider({ existing: wcSession([`${CAIP2}:${synth(6, 0)}`]) });
        const s = sessionFor(mock);
        const accs = await s.restore();
        assert.deepEqual(accs.map(a => a.address), [synth(6, 88)]);
        assert.equal(mock.log.connect.length, 0);
        assert.equal(s.isConnected(), true);
    });

    test('restore: nothing stored is no accounts, no pairing', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        assert.deepEqual(await s.restore(), []);
        assert.equal(mock.log.connect.length, 0);
    });

    test('restore: a stored session without Polkadex is ended, not used', async () => {
        const mock = mockProvider({ existing: wcSession([`polkadot:91b171bb158e2d3848fa23a9f1c25182:${synth(6, 0)}`]) });
        const s = sessionFor(mock);
        assert.deepEqual(await s.restore(), []);
        assert.equal(mock.log.disconnects, 1);
    });

    test('session_delete from the phone clears the session and reports it', async () => {
        const mock = mockProvider();
        const changes = [];
        const s = sessionFor(mock, { onChange: (c) => changes.push(c) });
        await s.connect({ onUri() {} });
        mock.instance().session = undefined;
        mock.instance().emit('session_delete', { topic: 'topic-1' });
        assert.equal(s.isConnected(), false);
        assert.deepEqual(s.accounts(), []);
        assert.deepEqual(changes.map(c => c.reason), ['ended']);
    });

    test('session_expire reported by the sign client clears the session too', async () => {
        const mock = mockProvider();
        const changes = [];
        const s = sessionFor(mock, { onChange: (c) => changes.push(c) });
        await s.connect({ onUri() {} });
        mock.instance().emitClient('session_expire', { topic: 'topic-1' });
        assert.equal(s.isConnected(), false);
        assert.deepEqual(changes.map(c => c.reason), ['ended']);
    });

    test('an expiry for some other topic is ignored', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        mock.instance().emitClient('session_expire', { topic: 'other' });
        assert.equal(s.isConnected(), true);
    });

    test('session_update with new accounts is reported', async () => {
        const mock = mockProvider();
        const changes = [];
        const s = sessionFor(mock, { onChange: (c) => changes.push(c) });
        await s.connect({ onUri() {} });
        mock.instance().session = wcSession([`${CAIP2}:${synth(7, 0)}`]);
        mock.instance().emit('session_update', { topic: 'topic-1' });
        assert.deepEqual(changes.map(c => c.reason), ['accounts']);
        assert.deepEqual(changes[0].accounts.map(a => a.address), [synth(7, 88)]);
    });

    test('disconnect ends the session at the wallet and clears it here', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        await s.disconnect();
        assert.equal(mock.log.disconnects, 1);
        assert.equal(s.isConnected(), false);
        await s.disconnect();   // twice is harmless
    });

    test('disconnect survives a provider that throws (relay down)', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        mock.instance().disconnect = async () => { throw new Error('socket closed'); };
        await s.disconnect();
        assert.equal(s.isConnected(), false);
    });

    test('request goes to the session topic on the Polkadex chain', async () => {
        const mock = mockProvider({ reply: () => ({ signature: '0xab' }) });
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        const r = await s.request('polkadot_signMessage', { address: 'x', data: '0x00', type: 'bytes' });
        assert.deepEqual(r, { signature: '0xab' });
        assert.deepEqual(mock.log.requests[0], { topic: 'topic-1', chainId: CAIP2, request: { method: 'polkadot_signMessage', params: { address: 'x', data: '0x00', type: 'bytes' } } });
    });

    test('request addresses go out in the encoding the wallet shared (strict wallets match strings)', async () => {
        const raw = synth(14, 0);
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${raw}`]), reply: () => ({ signature: '0x' }) });
        const s = sessionFor(mock);
        await s.connect({ onUri() {} });
        await s.request('polkadot_signTransaction', { address: synth(14, 88), transactionPayload: { address: synth(14, 42), method: '0x00' } });
        const sent = mock.log.requests[0].request.params;
        assert.equal(sent.address, raw);
        assert.equal(sent.transactionPayload.address, raw);
        assert.equal(sent.transactionPayload.method, '0x00');
        await s.request('polkadot_signMessage', { address: synth(15, 88), data: '0x00', type: 'bytes' });
        assert.equal(mock.log.requests[1].request.params.address, synth(15, 88), 'an address the wallet did not share is left alone');
    });

    test('request with no session refuses clearly', async () => {
        const s = sessionFor(mockProvider());
        await assert.rejects(s.request('polkadot_signMessage', {}), /not connected/i);
    });

    test('the Verify iframe is not attempted (CSP has no frame-src for it): register answers empty at once', async () => {
        const mock = mockProvider();
        await sessionFor(mock).connect({ onUri() {} });
        assert.equal(await mock.instance().client.core.verify.register({ id: 'x', decryptedId: 'y' }), '');
        assert.equal(mock.log.registerCalls, 0);
    });

    test('cancelConnect stops waiting for the wallet', async () => {
        let release;
        const mock = mockProvider({ approve: () => new Promise((r) => { release = r; }) });
        const s = sessionFor(mock);
        const p = s.connect({ onUri() {} });
        await flush();
        s.cancelConnect();
        await assert.rejects(p, (e) => e.message === CANCELLED);
        release(wcSession([`${CAIP2}:${synth(1, 0)}`]));
    });

    test('the provider is created once and shared by restore and connect', async () => {
        const mock = mockProvider();
        const s = sessionFor(mock);
        await s.restore();
        await s.connect({ onUri() {} });
        assert.equal(mock.log.init.length, 1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A JSON payload exactly as @polkadot/api hands it to signPayload.
function payloadFor(address, data = '0x1234') {
    const method = registry.createType('Call', remarkCall(registry, data)).toHex();
    return {
        address, blockHash: '0x' + '11'.repeat(32), blockNumber: '0x00000007', era: '0x00', genesisHash: '0x' + '22'.repeat(32),
        method, nonce: '0x00000005', signedExtensions: registry.signedExtensions, specVersion: '0x00000001', tip: '0x00000000000000000000000000000000',
        transactionVersion: '0x00000001', version: 4
    };
}
const signPayloadWith = (p, payload) => registry.createType('ExtrinsicPayload', payload, { version: payload.version }).sign(p).signature;
// What a wallet that drops the type byte would return: 64 bytes.
const bare = (sigHex) => u8aToHex(hexToU8a(sigHex).slice(1));
// The signed extrinsic a wallet would return for a payload, signed by p, with
// some fields swapped for others (and signed as swapped).
function signedTxFor(p, payload, override = {}) {
    const used = { ...payload, ...override };
    const ext = registry.createType('Extrinsic', registry.createType('Call', used.method), { version: 4 });
    ext.addSignature(p.address, signPayloadWith(p, used), used);
    return ext.toHex();
}
// The MultiSignature inside a signed extrinsic (sr25519 signatures are
// randomised, so a fresh signature of the same payload never equals it).
const sigInside = (tx) => registry.createType('Extrinsic', tx).inner.signature.multiSignature.toHex();

describe('signer: a @polkadot/api Signer over polkadot_signTransaction and polkadot_signMessage', () => {
    test('signPayload sends { address, transactionPayload } (withSignedTransaction false) and returns { id, signature }', async () => {
        const payload = payloadFor(pair.address);
        const calls = [];
        const signer = createWalletConnectSigner({
            request: async (method, params) => { calls.push({ method, params }); return { signature: signPayloadWith(pair, payload) }; },
            getRegistry: () => registry
        });
        const r = await signer.signPayload(payload);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'polkadot_signTransaction');
        // withSignedTransaction false: the wallet signs exactly this payload
        // (test/walletconnect-signature.test.js has why: Nova rebuilds it otherwise).
        assert.deepEqual(calls[0].params, { address: pair.address, transactionPayload: { ...payload, withSignedTransaction: false } });
        assert.equal(typeof r.id, 'number');
        assert.equal(hexToU8a(r.signature).length, 65);
    });

    test('ids are unique and increasing across calls and signers', async () => {
        const payload = payloadFor(pair.address);
        const sig = signPayloadWith(pair, payload);
        const mk = () => createWalletConnectSigner({ request: async () => ({ signature: sig }), getRegistry: () => registry });
        const a = mk(), b = mk();
        const ids = [(await a.signPayload(payload)).id, (await b.signPayload(payload)).id, (await a.signPayload(payload)).id];
        assert.ok(ids[0] < ids[1] && ids[1] < ids[2], ids.join(','));
        assert.ok(ids.every(i => i > 0), 'never 0 or -1 (the api reads -1 as no id)');
    });

    test('a signedTransaction that is exactly our transaction is passed on, its signature taken from it', async () => {
        const payload = payloadFor(pair.address);
        const tx = signedTxFor(pair, payload);
        const signer = createWalletConnectSigner({ request: async () => ({ signedTransaction: tx }), getRegistry: () => registry });
        const r = await signer.signPayload(payload);
        assert.equal(r.signedTransaction, tx);
        assert.equal(r.signature, sigInside(tx), 'the MultiSignature inside the returned transaction');
        assert.ok(signatureVerify(payloadMessage(registry, payload), r.signature, pair.address).isValid);
    });

    test('signedTransaction wins over a stray signature field: the signature returned is the one in the transaction', async () => {
        const payload = payloadFor(pair.address);
        const tx = signedTxFor(pair, payload);
        const stray = signPayloadWith(pair, payloadFor(pair.address, '0x99'));
        const signer = createWalletConnectSigner({ request: async () => ({ signature: stray, signedTransaction: tx }), getRegistry: () => registry });
        assert.equal((await signer.signPayload(payload)).signature, sigInside(tx));
        assert.notEqual(sigInside(tx), stray);
    });

    test('a signedTransaction that differs from what we built is refused: signer, call, era, nonce, tip', async () => {
        const payload = payloadFor(pair.address);
        const cases = {
            signer: signedTxFor(edPair, { ...payload, address: edPair.address }),
            call: signedTxFor(pair, payload, { method: payloadFor(pair.address, '0x9999').method }),
            era: signedTxFor(pair, payload, { era: registry.createType('ExtrinsicEra', { current: 7, period: 64 }).toHex() }),
            nonce: signedTxFor(pair, payload, { nonce: '0x00000006' }),
            tip: signedTxFor(pair, payload, { tip: '0x00000000000000000000000000000001' })
        };
        for (const [what, tx] of Object.entries(cases)) {
            const signer = createWalletConnectSigner({ request: async () => ({ signature: signPayloadWith(pair, payload), signedTransaction: tx }), getRegistry: () => registry });
            await assert.rejects(signer.signPayload(payload), (e) => e.message === DIFFERENT_TX, `different ${what} must be refused`);
        }
        assert.equal(DIFFERENT_TX, 'The wallet returned a different transaction; nothing was sent.');
    });

    test('a signedTransaction that is unsigned or not a transaction at all is refused', async () => {
        const payload = payloadFor(pair.address);
        const unsigned = registry.createType('Extrinsic', registry.createType('Call', payload.method), { version: 4 }).toHex();
        for (const tx of [unsigned, '0xfeed', 'not hex']) {
            const signer = createWalletConnectSigner({ request: async () => ({ signature: signPayloadWith(pair, payload), signedTransaction: tx }), getRegistry: () => registry });
            await assert.rejects(signer.signPayload(payload), (e) => e.message === DIFFERENT_TX, String(tx).slice(0, 20));
        }
    });

    test('a signedTransaction with our fields but a signature that does not verify for them is refused', async () => {
        const payload = payloadFor(pair.address);
        const ext = registry.createType('Extrinsic', registry.createType('Call', payload.method), { version: 4 });
        ext.addSignature(pair.address, signPayloadWith(pair, payloadFor(pair.address, '0x99')), payload);
        const signer = createWalletConnectSigner({ request: async () => ({ signedTransaction: ext.toHex() }), getRegistry: () => registry });
        await assert.rejects(signer.signPayload(payload), /does not match/);
    });

    test('the signer has no update(): nothing to relay after signAsync, trackingSigner passes it through untouched', () => {
        const signer = createWalletConnectSigner({ request: async () => ({}), getRegistry: () => registry });
        assert.equal(typeof signer.update, 'undefined');
        const t = trackingSigner(signer);
        assert.equal(t.signer, signer);
        assert.doesNotThrow(() => t.relay({ status: {} }));
    });

    test('signRaw sends polkadot_signMessage { address, data, type: bytes } with the message wrapped in <Bytes>', async () => {
        const calls = [];
        const text = 'Sign in to Polkadex Explorer: nonce 42';
        const signer = createWalletConnectSigner({
            request: async (method, params) => { calls.push({ method, params }); return { signature: u8aToHex(pair.sign(hexToU8a(params.data), { withType: true })) }; },
            getRegistry: () => registry
        });
        const r = await signer.signRaw({ address: pair.address, data: text, type: 'bytes' });
        assert.equal(calls[0].method, 'polkadot_signMessage');
        assert.equal(calls[0].params.address, pair.address);
        assert.equal(calls[0].params.type, 'bytes');
        assert.equal(u8aToString(hexToU8a(calls[0].params.data)), '<Bytes>' + text + '</Bytes>');
        assert.deepEqual(calls[0].params, { address: pair.address, data: calls[0].params.data, type: 'bytes', message: calls[0].params.data }, 'the bytes as both data and message');
        assert.equal(typeof r.id, 'number');
        // What the server checks (server.js /api/auth/verify): either form verifies.
        assert.ok(signatureVerify(u8aWrapBytes(stringToU8a(text)), r.signature, pair.address).isValid);
    });

    test('the signMessage params carry a comment citing the Reown reference and why message repeats data', () => {
        const src = read('lib/walletconnect-signer.js');
        const at = src.indexOf('async signRaw');
        assert.ok(at > 0);
        const before = src.slice(Math.max(0, at - 1200), at);
        assert.match(before, /docs\.reown\.com/);
        assert.match(before, /`message`/);
        assert.match(before, /`data`/);
    });

    test('rawMessage: hex input is decoded, already-wrapped input is not wrapped twice', () => {
        assert.equal(u8aToString(rawMessage('0x' + Buffer.from('hi').toString('hex'))), '<Bytes>hi</Bytes>');
        assert.equal(u8aToString(rawMessage('<Bytes>hi</Bytes>')), '<Bytes>hi</Bytes>');
        assert.equal(u8aToString(rawMessage('hi')), '<Bytes>hi</Bytes>');
    });

    test('payloadMessage: the bytes a wallet signs, hashed above 256 bytes', () => {
        const small = payloadFor(pair.address, '0x12');
        const u8a = registry.createType('ExtrinsicPayload', small, { version: 4 }).toU8a({ method: true });
        assert.deepEqual(payloadMessage(registry, small), u8a);
        const big = payloadFor(pair.address, '0x' + 'ab'.repeat(400));
        const bigU8a = registry.createType('ExtrinsicPayload', big, { version: 4 }).toU8a({ method: true });
        assert.deepEqual(payloadMessage(registry, big), blake2AsU8a(bigU8a, 256));
    });
});

describe('signature normalisation: MultiSignature out, never a silent guess', () => {
    test('a prefixed sr25519 signature (65 bytes, 0x01) is kept', () => {
        const payload = payloadFor(pair.address);
        const sig = signPayloadWith(pair, payload);
        assert.equal(hexToU8a(sig)[0], 1);
        assert.equal(normaliseSignature(sig, { message: payloadMessage(registry, payload), address: pair.address }), sig);
    });

    test('an unprefixed 64-byte sr25519 signature gets 0x01, after it verifies as sr25519 for this account', () => {
        const payload = payloadFor(pair.address);
        const sig = signPayloadWith(pair, payload);
        const out = normaliseSignature(bare(sig), { message: payloadMessage(registry, payload), address: pair.address });
        assert.equal(out, sig);
    });

    test('an unprefixed 64-byte ed25519 signature gets 0x00, not 0x01', () => {
        const payload = payloadFor(edPair.address);
        const sig = signPayloadWith(edPair, payload);
        assert.equal(hexToU8a(sig)[0], 0);
        const out = normaliseSignature(bare(sig), { message: payloadMessage(registry, payload), address: edPair.address });
        assert.equal(out, sig);
    });

    test('64 bytes that do not verify for this account and message: a clear error, nothing prefixed', () => {
        const payload = payloadFor(pair.address);
        const other = signPayloadWith(edPair, payloadFor(edPair.address));
        assert.throws(() => normaliseSignature(bare(other), { message: payloadMessage(registry, payload), address: pair.address }), /does not match/);
    });

    test('a wrong length is an error naming the length', () => {
        for (const n of [0, 32, 63, 67, 128]) {
            assert.throws(() => normaliseSignature('0x' + '01'.repeat(n), { message: new Uint8Array(1), address: pair.address }), new RegExp(`${n} bytes`));
        }
    });

    test('65 bytes with an unknown type byte, or 66 bytes that are not ecdsa, are errors', () => {
        assert.throws(() => normaliseSignature('0x07' + 'aa'.repeat(64), { message: new Uint8Array(1), address: pair.address }), /65 bytes/);
        assert.throws(() => normaliseSignature('0x01' + 'aa'.repeat(65), { message: new Uint8Array(1), address: pair.address }), /66 bytes/);
    });

    test('a prefixed ecdsa signature (66 bytes, 0x02) is kept only when it verifies for this account', () => {
        const payload = payloadFor(ecPair.address);
        const sig = signPayloadWith(ecPair, payload);
        assert.equal(hexToU8a(sig).length, 66);
        assert.equal(normaliseSignature(sig, { message: payloadMessage(registry, payload), address: ecPair.address }), sig);
        assert.throws(() => normaliseSignature('0x02' + 'cd'.repeat(65), { message: payloadMessage(registry, payload), address: ecPair.address }), /does not match/);
    });

    test('every prefixed signature is verified: one over some other payload is refused', () => {
        const payload = payloadFor(pair.address);
        const other = signPayloadWith(pair, payloadFor(pair.address, '0x99'));
        assert.equal(hexToU8a(other).length, 65);
        assert.throws(() => normaliseSignature(other, { message: payloadMessage(registry, payload), address: pair.address }), /does not match/);
    });

    test('every prefixed signature is verified: one by another account is refused', () => {
        const payload = payloadFor(pair.address);
        const theirs = signPayloadWith(edPair, payloadFor(edPair.address));
        assert.throws(() => normaliseSignature(theirs, { message: payloadMessage(registry, payload), address: pair.address }), /does not match/);
    });

    test('a type byte that names the wrong scheme is refused, not corrected', () => {
        const payload = payloadFor(pair.address);
        const sig = hexToU8a(signPayloadWith(pair, payload));
        const lied = u8aToHex(u8aConcat(new Uint8Array([0]), sig.slice(1)));
        assert.throws(() => normaliseSignature(lied, { message: payloadMessage(registry, payload), address: pair.address }), /does not match/);
    });

    test('a transaction signature must be over the exact payload bytes: one over <Bytes>payload</Bytes> is refused', async () => {
        const payload = payloadFor(pair.address);
        const wrapped = u8aToHex(pair.sign(u8aWrapBytes(payloadMessage(registry, payload)), { withType: true }));
        const signer = createWalletConnectSigner({ request: async () => ({ signature: wrapped }), getRegistry: () => registry });
        await assert.rejects(signer.signPayload(payload), /does not match/);
    });

    test('a signMessage reply by another account, or over other bytes, is refused', async () => {
        const byOther = createWalletConnectSigner({ request: async (m, params) => ({ signature: u8aToHex(edPair.sign(hexToU8a(params.data), { withType: true })) }), getRegistry: () => registry });
        await assert.rejects(byOther.signRaw({ address: pair.address, data: 'hello', type: 'bytes' }), /does not match/);
        const otherBytes = createWalletConnectSigner({ request: async () => ({ signature: u8aToHex(pair.sign(rawMessage('goodbye'), { withType: true })) }), getRegistry: () => registry });
        await assert.rejects(otherBytes.signRaw({ address: pair.address, data: 'hello', type: 'bytes' }), /does not match/);
    });

    test('no signature, or not hex: an error', () => {
        for (const bad of [undefined, null, '', 'zz', 42, {}]) {
            assert.throws(() => normaliseSignature(bad, { message: new Uint8Array(1), address: pair.address }), /no usable signature/);
        }
    });

    test('through the signer: an unprefixed reply to signPayload comes back prefixed; a bad one rejects', async () => {
        const payload = payloadFor(pair.address);
        const sig = signPayloadWith(pair, payload);
        const ok = createWalletConnectSigner({ request: async () => ({ signature: bare(sig) }), getRegistry: () => registry });
        assert.equal((await ok.signPayload(payload)).signature, sig);
        const bad = createWalletConnectSigner({ request: async () => ({ signature: '0x' + '00'.repeat(30) }), getRegistry: () => registry });
        await assert.rejects(bad.signPayload(payload), /30 bytes/);
    });

    test('an unprefixed 64-byte signMessage reply (as in the Reown example) comes back prefixed', async () => {
        const signer = createWalletConnectSigner({
            request: async (m, params) => ({ signature: u8aToHex(pair.sign(hexToU8a(params.data))) }),
            getRegistry: () => registry
        });
        const r = await signer.signRaw({ address: pair.address, data: 'hello', type: 'bytes' });
        assert.equal(hexToU8a(r.signature).length, 65);
        assert.equal(hexToU8a(r.signature)[0], 1);
    });

    test('no registry yet (chain not connected): signPayload refuses clearly instead of guessing', async () => {
        const payload = payloadFor(pair.address);
        const signer = createWalletConnectSigner({ request: async () => ({ signature: bare(signPayloadWith(pair, payload)) }), getRegistry: () => null });
        await assert.rejects(signer.signPayload(payload), /chain connection/i);
    });
});

describe('pending state, timeout and cancel', () => {
    test('while the phone decides, onPending is told; it is closed when the answer comes', async () => {
        const payload = payloadFor(pair.address);
        let release;
        const events = [];
        const signer = createWalletConnectSigner({
            request: () => new Promise((r) => { release = r; }), getRegistry: () => registry,
            onPending: (p) => { events.push(['open', p.kind]); return () => events.push(['close']); }
        });
        const pr = signer.signPayload(payload);
        await flush();
        assert.deepEqual(events, [['open', 'transaction']]);
        release({ signature: signPayloadWith(pair, payload) });
        await pr;
        assert.deepEqual(events, [['open', 'transaction'], ['close']]);
    });

    test('a request that never answers times out with a clear message, and the notice closes', async () => {
        let closed = 0;
        const signer = createWalletConnectSigner({ request: () => new Promise(() => {}), getRegistry: () => registry, timeoutMs: 20, onPending: () => () => { closed++; } });
        await assert.rejects(signer.signRaw({ address: pair.address, data: 'x' }), (e) => e.message === TIMEOUT_TEXT);
        assert.match(TIMEOUT_TEXT, /phone/i);
        assert.match(TIMEOUT_TEXT, /Nothing was signed/);
        assert.equal(closed, 1);
    });

    test('Cancel rejects with "Cancelled" (what extensions say), and a late answer is ignored', async () => {
        let cancel, release;
        const signer = createWalletConnectSigner({ request: () => new Promise((r) => { release = r; }), getRegistry: () => registry, onPending: (p) => { cancel = p.cancel; return () => {}; } });
        const pr = signer.signPayload(payloadFor(pair.address));
        await flush();
        cancel();
        await assert.rejects(pr, (e) => e.message === CANCELLED);
        release({ signature: '0x00' });   // no unhandled error
        await flush();
    });

    test('a rejection on the phone reads as a cancel', async () => {
        const signer = createWalletConnectSigner({ request: async () => { throw { code: 5000, message: 'User rejected.' }; }, getRegistry: () => registry });
        await assert.rejects(signer.signRaw({ address: pair.address, data: 'x' }), (e) => e.message === CANCELLED);
    });

    test('any other wallet error is passed on with its message', async () => {
        const signer = createWalletConnectSigner({ request: async () => { throw new Error('Unsupported chain'); }, getRegistry: () => registry });
        await assert.rejects(signer.signRaw({ address: pair.address, data: 'x' }), /Unsupported chain/);
    });

    test('the default timeout is the tx card\'s signing cap: one shared constant (SIGNING_CAP_MS, 180 s)', () => {
        assert.equal(SIGNING_CAP_MS, 180000);
        assert.equal(SIGN_TIMEOUT_MS, SIGNING_CAP_MS);
        const src = read('lib/walletconnect-signer.js');
        assert.match(src, /import \{[^}]*\bSIGNING_CAP_MS\b[^}]*\} from '\.\/tx-status\.js'/);
        assert.match(src, /SIGN_TIMEOUT_MS = SIGNING_CAP_MS/);
        assert.match(TIMEOUT_TEXT, /3 minutes/);
        assert.ok(!/5 minutes/.test(TIMEOUT_TEXT));
    });

    test('cancelAll ends every pending request with the session-ended text and closes each notice; late answers are ignored', async () => {
        const releases = [];
        let closed = 0;
        const signer = createWalletConnectSigner({ request: () => new Promise((r) => { releases.push(r); }), getRegistry: () => registry, onPending: () => () => { closed++; } });
        const a = signer.signRaw({ address: pair.address, data: 'x' });
        const b = signer.signPayload(payloadFor(pair.address));
        await flush();
        signer.cancelAll();
        await assert.rejects(a, (e) => e.message === SESSION_ENDED_TEXT);
        await assert.rejects(b, (e) => e.message === SESSION_ENDED_TEXT);
        assert.equal(closed, 2);
        assert.match(SESSION_ENDED_TEXT, /Nothing was signed/);
        for (const r of releases) r({ signature: '0x00' });
        await flush();
        signer.cancelAll();   // nothing pending: harmless
    });
});

// ─────────────────────────────────────────────────────────────────────────────
function domWindow(t, url = 'https://explorer.test/wallet') {
    const window = new Window({ url, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    t.after(() => window.happyDOM.close());
    return window;
}

// The vendored qrcodejs, evaluated against a happy-dom document with every
// network door wired to fail the test.
function realQr(window) {
    const net = { calls: 0 };
    const deny = () => { net.calls++; throw new Error('network used'); };
    window.fetch = deny;
    window.XMLHttpRequest = function () { deny(); };
    window.WebSocket = function () { deny(); };
    const ctx = { document: window.document, navigator: window.navigator, window, fetch: deny, XMLHttpRequest: window.XMLHttpRequest, WebSocket: window.WebSocket };
    vm.createContext(ctx);
    vm.runInContext(read('node_modules/qrcodejs/qrcode.min.js') + '\n;this.QRCode = QRCode;', ctx);
    window.QRCode = ctx.QRCode;
    return net;
}

describe('pairing panel: QR drawn locally, copy, open in wallet on a phone', () => {
    test('the QR is drawn in the page by the vendored qrcodejs, with no network use', async (t) => {
        const window = domWindow(t);
        const net = realQr(window);
        const el = window.document.createElement('div');
        window.document.body.appendChild(el);
        const panel = mountPairingPanel(el, { uri: URI, onMobile: false, clipboard: { writeText: async () => {} } });
        const qr = el.querySelector('.wc-qr');
        assert.ok(qr, 'QR box present');
        assert.ok(qr.querySelectorAll('td').length > 400 || qr.querySelector('canvas') || qr.querySelector('img'), 'QR drawn');
        assert.equal(qr.getAttribute('role'), 'img');
        assert.ok(/pairing/i.test(qr.getAttribute('aria-label')));
        assert.equal(net.calls, 0);
        assert.ok(!/https?:\/\//.test(qr.innerHTML), 'no remote image');
        panel.close();
    });

    test('the URI is offered to copy; Copy writes it to the clipboard', async (t) => {
        const window = domWindow(t);
        realQr(window);
        const el = window.document.createElement('div');
        const copied = [];
        mountPairingPanel(el, { uri: URI, onMobile: false, clipboard: { writeText: async (s) => { copied.push(s); } } });
        assert.equal(el.querySelector('input.wc-uri').value, URI);
        el.querySelector('.wc-copy').click();
        await flush();
        assert.deepEqual(copied, [URI]);
    });

    test('on a phone, "Open wallet" links to the wc: URI itself; on a computer there is no such link', async (t) => {
        const window = domWindow(t);
        realQr(window);
        const phone = window.document.createElement('div');
        mountPairingPanel(phone, { uri: URI, onMobile: true, clipboard: {} });
        const open = phone.querySelector('a.wc-open');
        assert.ok(open);
        assert.equal(open.getAttribute('href'), URI);
        assert.equal(open.textContent.trim(), 'Open wallet');
        const desk = window.document.createElement('div');
        mountPairingPanel(desk, { uri: URI, onMobile: false, clipboard: {} });
        assert.equal(desk.querySelector('a.wc-open'), null);
    });

    test('a URI that is not a wc: URI is never put in a link', async (t) => {
        const window = domWindow(t);
        realQr(window);
        const el = window.document.createElement('div');
        mountPairingPanel(el, { uri: 'javascript:alert(1)', onMobile: true, clipboard: {} });
        assert.equal(el.querySelector('a.wc-open'), null);
        assert.ok(!el.innerHTML.includes('javascript:'));
    });

    test('Cancel calls onCancel; setStatus shows text; close empties the panel', async (t) => {
        const window = domWindow(t);
        realQr(window);
        const el = window.document.createElement('div');
        let cancelled = 0;
        const p = mountPairingPanel(el, { uri: URI, onMobile: false, clipboard: {}, onCancel: () => { cancelled++; } });
        el.querySelector('.wc-cancel').click();
        assert.equal(cancelled, 1);
        p.setStatus('Connected.');
        assert.match(el.textContent, /Connected\./);
        p.close();
        assert.equal(el.innerHTML, '');
    });

    test('without qrcodejs the panel still works: a note instead of the code, copy and open remain', async (t) => {
        const window = domWindow(t);
        const el = window.document.createElement('div');
        mountPairingPanel(el, { uri: URI, onMobile: true, clipboard: {} });
        assert.match(el.querySelector('.wc-qr').textContent, /QR code unavailable/);
        assert.ok(el.querySelector('a.wc-open'));
    });

    test('"Approve on your phone": a polite status with a Cancel button that cancels and closes', async (t) => {
        const window = domWindow(t);
        let cancelled = 0;
        const close = showPendingNotice(window.document, { kind: 'transaction', cancel: () => { cancelled++; } });
        const n = window.document.querySelector('.wc-pending');
        assert.ok(n);
        assert.equal(n.getAttribute('role'), 'status');
        assert.match(n.textContent, /Approve on your phone/);
        n.querySelector('button').click();
        assert.equal(cancelled, 1);
        close();
        assert.equal(window.document.querySelector('.wc-pending'), null);
        close();   // twice is harmless
    });

    test('the copy has no em or en dashes', () => {
        for (const f of ['lib/walletconnect-view.js', 'lib/walletconnect-signer.js', 'lib/walletconnect-session.js', 'lib/walletconnect-source.js', 'lib/walletconnect-gate.js', 'lib/walletconnect-config.js']) {
            assert.ok(!/[–—]|&mdash;|&ndash;/.test(read(f)), f);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('source: session + signer + panel as one wallet source', () => {
    function sourceWith(t, mock, extra = {}) {
        const window = domWindow(t);
        realQr(window);
        const ended = [], accounts = [];
        const src = createWalletConnectSource({
            loadProvider: async () => mock.P, doc: window.document, getRegistry: () => registry, isMobile: () => false,
            clipboard: { writeText: async () => {} },
            onEnded: (r) => ended.push(r), onAccounts: (a) => accounts.push(a), ...extra
        });
        return { window, src, ended, accounts };
    }

    test('enable() looks like an injected extension: accounts.get and a signer', async (t) => {
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${synth(8, 0)}`], { peer: 'Nova Wallet' }) });
        const { window, src } = sourceWith(t, mock);
        const panel = window.document.createElement('div');
        await src.connect(panel);
        const ext = await src.provider.enable('Polkadex Explorer');
        const accs = await ext.accounts.get();
        assert.deepEqual(accs, [{ address: synth(8, 88), name: 'Nova Wallet account' }]);
        assert.equal(typeof ext.signer.signPayload, 'function');
        assert.equal(typeof ext.signer.signRaw, 'function');
        assert.equal(src.peerName(), 'Nova Wallet');
    });

    test('connect shows the QR in the given panel, then says to choose an account', async (t) => {
        const mock = mockProvider();
        const { window, src } = sourceWith(t, mock);
        const panel = window.document.createElement('div');
        let seenQr = false;
        mock.P.prototype.connect = async function (opts) {
            mock.log.connect.push(opts);
            this.emit('display_uri', URI);
            seenQr = !!panel.querySelector('.wc-qr');
            this.session = wcSession([`${CAIP2}:${synth(1, 0)}`]);
            return this.session;
        };
        await src.connect(panel);
        assert.ok(seenQr, 'QR on screen while waiting');
        assert.equal(panel.querySelector('.wc-qr'), null, 'QR removed after approval');
        assert.match(panel.textContent, /Choose an account/);
    });

    test('a rejected session leaves a readable error in the panel', async (t) => {
        const mock = mockProvider({ approve: () => wcSession([`polkadot:91b171bb158e2d3848fa23a9f1c25182:${synth(3, 0)}`]) });
        const { window, src } = sourceWith(t, mock);
        const panel = window.document.createElement('div');
        await assert.rejects(src.connect(panel));
        assert.match(panel.textContent, /Polkadex/);
    });

    test('the signer goes through the session: a signRaw reaches the phone as polkadot_signMessage', async (t) => {
        const mock = mockProvider({
            approve: () => wcSession([`${CAIP2}:${pair.address}`]),
            reply: (args) => ({ signature: u8aToHex(pair.sign(hexToU8a(args.request.params.data), { withType: true })) })
        });
        const { window, src } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        const ext = await src.provider.enable();
        const r = await ext.signer.signRaw({ address: pair.address, data: 'hello', type: 'bytes' });
        assert.equal(mock.log.requests[0].request.method, 'polkadot_signMessage');
        assert.equal(mock.log.requests[0].chainId, CAIP2);
        assert.ok(signatureVerify(u8aWrapBytes(stringToU8a('hello')), r.signature, pair.address).isValid);
        assert.equal(window.document.querySelector('.wc-pending'), null, 'pending notice closed');
    });

    test('while signing, "Approve on your phone" is on screen', async (t) => {
        let release;
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${pair.address}`]), reply: () => new Promise((r) => { release = r; }) });
        const { window, src } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        const ext = await src.provider.enable();
        const p = ext.signer.signRaw({ address: pair.address, data: 'x' });
        await flush();
        assert.ok(window.document.querySelector('.wc-pending'));
        release({ signature: u8aToHex(pair.sign(rawMessage('x'), { withType: true })) });
        await p;
        assert.equal(window.document.querySelector('.wc-pending'), null);
    });

    test('a session ended on the phone reaches onEnded', async (t) => {
        const mock = mockProvider();
        const { window, src, ended } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        mock.instance().emit('session_delete', { topic: 'topic-1' });
        assert.equal(ended.length, 1);
        assert.equal(src.isConnected(), false);
    });

    test('a session ended on the phone while a signature waits: the request is cancelled and the notice removed', async (t) => {
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${pair.address}`]), reply: () => new Promise(() => {}) });
        const { window, src, ended } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        const ext = await src.provider.enable();
        const p = ext.signer.signRaw({ address: pair.address, data: 'x' });
        await flush();
        assert.ok(window.document.querySelector('.wc-pending'));
        mock.instance().emit('session_delete', { topic: 'topic-1' });
        await assert.rejects(p, (e) => e.message === SESSION_ENDED_TEXT);
        assert.equal(window.document.querySelector('.wc-pending'), null, '"Approve on your phone" removed');
        assert.equal(ended.length, 1);
    });

    test('a session that expires while a signature waits: the request is cancelled and the notice removed', async (t) => {
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${pair.address}`]), reply: () => new Promise(() => {}) });
        const { window, src } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        const ext = await src.provider.enable();
        const p = ext.signer.signPayload(payloadFor(pair.address));
        await flush();
        mock.instance().emitClient('session_expire', { topic: 'topic-1' });
        await assert.rejects(p, (e) => e.message === SESSION_ENDED_TEXT);
        assert.equal(window.document.querySelector('.wc-pending'), null);
    });

    test('our own disconnect while a signature waits cancels it too, without reporting an end from the phone', async (t) => {
        const mock = mockProvider({ approve: () => wcSession([`${CAIP2}:${pair.address}`]), reply: () => new Promise(() => {}) });
        const { window, src, ended } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        const ext = await src.provider.enable();
        const p = ext.signer.signRaw({ address: pair.address, data: 'x' });
        await flush();
        await src.disconnect();
        await assert.rejects(p, (e) => e.message === SESSION_ENDED_TEXT);
        assert.equal(window.document.querySelector('.wc-pending'), null);
        assert.deepEqual(ended, []);
    });

    test('our own disconnect does not report itself as ended from the phone', async (t) => {
        const mock = mockProvider();
        const { window, src, ended } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        mock.instance().disconnect = async function () { mock.log.disconnects++; this.session = undefined; this.emit('session_delete', { topic: 'topic-1' }); };
        await src.disconnect();
        assert.deepEqual(ended, []);
    });

    test('account changes reach onAccounts', async (t) => {
        const mock = mockProvider();
        const { window, src, accounts } = sourceWith(t, mock);
        await src.connect(window.document.createElement('div'));
        mock.instance().session = wcSession([`${CAIP2}:${synth(9, 0)}`]);
        mock.instance().emit('session_update', { topic: 'topic-1' });
        assert.deepEqual(accounts.at(-1).map(a => a.address), [synth(9, 88)]);
    });

    test('the source module reaches the provider package only through a dynamic import', () => {
        const src = read('lib/walletconnect-source.js');
        assert.match(src, /import\(\s*'@walletconnect\/universal-provider'\s*\)/);
        assert.ok(!/^\s*import\s[^(]*@walletconnect/m.test(src));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('picker: the phone row is live when the flag is on (the chooser, 2026-11-16)', () => {
    // Pairing, its Back, failure and End connection are tested in full in
    // test/connect-chooser.test.js; here, what the WalletConnect source needs.
    test('no wallet in the browser: the phone row starts pairing in the pairing view\'s panel', async (t) => {
        const w = mountChooser(t, { phone: true });
        await w.picker.ready;
        const row = w.action('phone');
        assert.ok(row);
        assert.equal(row.disabled, false);
        assert.ok(!/Coming soon/.test(row.textContent));
        row.click();
        await flush();
        assert.equal(w.phone.connects, 1);
        const panel = w.phone.panels[0];
        assert.ok(panel && panel.classList.contains('wallet-wc-panel'));
        assert.equal(w.q('#wallet-picker-pairing').hidden, false);
    });

    test('after pairing the phone accounts appear under the phone group head, picked like any extension\'s', async (t) => {
        const w = mountChooser(t, { phone: { accounts: [chooserAcct(10, 'Nova Wallet account')] } });
        await w.picker.ready;
        w.action('phone').click();
        await flush();
        w.phone.approve();
        await w.settle();
        const head = w.q('.wallet-account-group[data-source="walletconnect"] .wallet-group-head');
        assert.ok(head);
        assert.match(head.textContent, /Phone wallet: Nova Wallet/);
        assert.ok(head.querySelector('.wallet-ext-tile.tile-icon .bx-mobile'), 'the neutral phone tile (brand audit C11)');
        w.q('.wallet-account-btn[data-source="walletconnect"]').click();
        assert.deepEqual(w.calls.select, [[synth(10, 88), 'walletconnect']]);
    });

    test('extensions installed: the phone row is still offered, once', async (t) => {
        const w = mountChooser(t, { phone: true, wallets: [fakeWallet('polkadot-js', [chooserAcct(11, 'Ext')])] });
        await w.picker.ready;
        assert.equal(w.qa('.wallet-option-row[data-action="phone"]').length, 1);
    });

    test('a connected phone shows its name and the account count; its group offers End connection', async (t) => {
        const w = mountChooser(t, { phone: { connected: true } });
        await w.picker.ready;
        assert.match(w.action('phone').textContent, /Nova Wallet connected/);
        w.action('phone').click();
        await w.settle();
        const end = w.q('.wallet-wc-disconnect');
        assert.equal(end.textContent.trim(), 'End connection');
        end.click();
        await w.settle();
        assert.equal(w.phone.disconnects, 1);
    });

    test('a failed pairing shows its message with Try again; Cancelled shows nothing and goes back', async (t) => {
        const w = mountChooser(t, { phone: true });
        await w.picker.ready;
        w.action('phone').click();
        await flush();
        w.phone.fail('The relay could not be reached.');
        await w.settle();
        assert.match(w.q('#wallet-picker-pairing').textContent, /The relay could not be reached\./);
        w.q('.wallet-wc-retry').click();
        await flush();
        w.phone.fail(CANCELLED);
        await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.ok(!/Cancelled/.test(w.root.textContent));
    });

    test('flag off: no phone row, no mention', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('polkadot-js', [chooserAcct(11, 'Ext')])] });
        await w.picker.ready;
        assert.equal(w.action('phone'), null);
        assert.ok(!/WalletConnect/.test(w.root.textContent));
    });

    test('source label and tile', () => {
        assert.equal(sourceLabel('walletconnect'), 'WalletConnect');
        const g = groupBySource([{ address: synth(1, 88), name: 'a', source: 'walletconnect' }]);
        assert.equal(g[0].label, 'WalletConnect');
        // Brand audit C11: no blue WC monogram; the phone group head is the neutral phone icon.
        assert.ok(!/'walletconnect': 'WC'/.test(read('lib/wallet-picker.js')));
    });

    test('the option rows render a live phone row when given one', () => {
        const html = buildOptionRowsHtml({ sources: [], phone: { connected: false }, esc: escapeHtml });
        assert.match(html, /data-action="phone"/);
        assert.ok(!/disabled/.test(html));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('wallet session: a WalletConnect account behaves like an extension account', () => {
    test('connect, switch to an extension, disconnect: the usual reasons fire', () => {
        const storage = memStorage();
        const changes = [];
        const s = createWalletSession({ storage, toAddress: (a) => a, isSame: same, isValid: valid });
        s.onActiveAccountChange((c) => changes.push(c.reason));
        s.select(synth(12, 88), 'walletconnect');
        assert.equal(s.source(), 'walletconnect');
        s.select(synth(12, 88), 'polkadot-js');
        s.select(synth(13, 88), 'walletconnect');
        s.disconnect();
        assert.deepEqual(changes, ['connect', 'switch-extension', 'switch-account', 'disconnect']);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// script.js's real wallet functions (test/helpers/wallet-world.js) with a
// WalletConnect gate stand-in.
function fakeWcGate(accounts, { peer = 'Nova Wallet' } = {}) {
    const g = {
        enabled: true, connected: true, disconnects: 0, signer: { wc: true, signPayload: async () => ({ id: 1, signature: '0x' }), signRaw: async () => ({ id: 2, signature: '0x' }) },
        providers() {
            if (!g.connected) return {};
            return { walletconnect: { enable: async () => ({ accounts: { get: async () => accounts.map(a => ({ ...a })) }, signer: g.signer }) } };
        },
        isConnected: () => g.connected, peerName: () => peer,
        connect: async () => accounts, disconnect: async () => { g.disconnects++; g.connected = false; }, restore: async () => accounts
    };
    return g;
}

describe('script.js wiring (real functions, fake extensions and a fake gate)', () => {
    test('allInjected merges extensions and the WalletConnect source; getInjectedAccounts lists the paired phone, and no extension nobody chose', async () => {
        const phone = { address: worldAddr(20, 0), name: 'Nova Wallet account' };
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [{ address: worldAddr(21, 42), name: 'Ext' }])] });
        profile.wcGate = fakeWcGate([phone]);
        const tab = openTab(profile);
        const accs = await tab.fn('getInjectedAccounts')({ retries: 1, retryDelayMs: 1 });
        assert.deepEqual(JSON.parse(JSON.stringify(accs.map(a => a.source).sort())), ['walletconnect']);
        assert.equal(profile.extensions[0].enableCalls, 0, 'the extension was asked without a click (lazy enable)');
        assert.ok(tab.fn('allInjected')()['polkadot-js'], 'the extension is still detected');
        assert.ok(accs.find(a => a.source === 'walletconnect').address.startsWith('e'));
        tab.close();
    });

    test('phone only, no extension: the accounts are still found (not "no wallet")', async () => {
        const profile = makeProfile();
        profile.wcGate = fakeWcGate([{ address: worldAddr(22, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        const accs = await tab.fn('getInjectedAccounts')({ retries: 1, retryDelayMs: 1 });
        assert.equal(accs.length, 1);
        assert.equal(accs[0].source, 'walletconnect');
        tab.close();
    });

    test('resolveWalletSigner hands back the WalletConnect signer for a WalletConnect account', async () => {
        const phone = { address: worldAddr(23, 0), name: 'Nova Wallet account' };
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [{ address: worldAddr(24, 42), name: 'Ext' }])] });
        profile.wcGate = fakeWcGate([phone]);
        const tab = openTab(profile);
        tab.ctx.globalApi = { registry: {}, runtimeVersion: { specVersion: { toNumber: () => 393 } } };
        tab.ctx.liveRuntimeError = () => null;
        tab.call('selectWallet', worldAddr(23, 88), 'walletconnect');
        await settle();
        const w = await tab.fn('resolveWalletSigner')((m) => { throw new Error(m); });
        assert.ok(w, 'a signer was found');
        assert.equal(w.signer.wc, true);
        assert.equal(w.account.source, 'walletconnect');
        tab.close();
    });

    test('getWalletSigner (discussion sign-in) finds the WalletConnect signer too', async () => {
        const profile = makeProfile();
        profile.wcGate = fakeWcGate([{ address: worldAddr(25, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        const signer = await tab.fn('getWalletSigner')(worldAddr(25, 88));
        assert.equal(signer && signer.wc, true);
        tab.close();
    });

    test('Disconnect on a WalletConnect account also ends the phone session', async () => {
        const profile = makeProfile();
        profile.wcGate = fakeWcGate([{ address: worldAddr(26, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        tab.call('selectWallet', worldAddr(26, 88), 'walletconnect');
        await settle();
        tab.call('disconnectWallet');
        await settle();
        assert.equal(profile.wcGate.disconnects, 1);
        assert.equal(tab.read('pdex_wallet_address'), null);
        tab.close();
    });

    test('Disconnect on an extension account leaves the phone session alone', async () => {
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [{ address: worldAddr(27, 42), name: 'Ext' }])] });
        profile.wcGate = fakeWcGate([{ address: worldAddr(28, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        tab.call('selectWallet', worldAddr(27, 88), 'polkadot-js');
        await settle();
        tab.call('disconnectWallet');
        await settle();
        assert.equal(profile.wcGate.disconnects, 0);
        tab.close();
    });

    test('the phone ends the session: an active WalletConnect account is disconnected like an extension', async () => {
        const profile = makeProfile();
        profile.wcGate = fakeWcGate([{ address: worldAddr(29, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        tab.call('selectWallet', worldAddr(29, 88), 'walletconnect');
        await settle();
        profile.wcGate.connected = false;
        tab.call('onWalletConnectEnded');
        await settle();
        assert.equal(tab.read('pdex_wallet_address'), null);
        assert.equal(tab.read('pdex_wallet_disconnected'), '1');
        tab.close();
    });

    test('the phone ends the session while an extension account is active: nothing changes', async () => {
        const profile = makeProfile({ extensions: [fakeExtension('polkadot-js', [{ address: worldAddr(30, 42), name: 'Ext' }])] });
        profile.wcGate = fakeWcGate([{ address: worldAddr(31, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        tab.call('selectWallet', worldAddr(30, 88), 'polkadot-js');
        await settle();
        tab.call('onWalletConnectEnded');
        await settle();
        assert.equal(tab.read('pdex_wallet_address'), worldAddr(30, 88));
        tab.close();
    });

    test('the phone stops sharing the active account: disconnected; still shared: kept', async () => {
        const profile = makeProfile();
        profile.wcGate = fakeWcGate([{ address: worldAddr(32, 0), name: 'Nova Wallet account' }]);
        const tab = openTab(profile);
        tab.call('selectWallet', worldAddr(32, 88), 'walletconnect');
        await settle();
        tab.call('onWalletConnectAccounts', [{ address: worldAddr(32, 88) }]);
        await settle();
        assert.equal(tab.read('pdex_wallet_address'), worldAddr(32, 88));
        tab.call('onWalletConnectAccounts', [{ address: worldAddr(33, 88) }]);
        await settle();
        assert.equal(tab.read('pdex_wallet_address'), null);
        tab.close();
    });

    test('the picker gets the controller only when the gate is enabled', async () => {
        const profile = makeProfile();
        const tab = openTab(profile);
        assert.equal(tab.call('walletConnectController'), false);
        tab.close();
        const p2 = makeProfile();
        p2.wcGate = fakeWcGate([]);
        const t2 = openTab(p2);
        const c = t2.call('walletConnectController');
        assert.equal(typeof c.connect, 'function');
        assert.equal(c.peerName(), 'Nova Wallet');
        t2.close();
    });

    test('script.js: the gate is built from the flag, restored on load, and passed to the picker', () => {
        assert.match(SCRIPT, /walletConnectEnabled\(\{\s*flag: FEATURE_FLAGS\.walletConnect, storage: localStorage, search: window\.location\.search/);
        assert.match(SCRIPT, /wcGate\.restore\(\)/);
        assert.match(bodyOfName('renderWalletConnectPanel'), /walletConnect: walletConnectController\(\)/);
        assert.match(bodyOfName('disconnectWallet'), /wcGate\.disconnect\(\)/);
        for (const f of ['getInjectedAccounts', 'getWalletSigner', 'resolveWalletSigner', 'hasInjectedWalletNow']) {
            assert.ok(!/window\.injectedWeb3/.test(bodyOfName(f)), `${f} still reads window.injectedWeb3 directly`);
            assert.match(bodyOfName(f), /allInjected\(\)/, f);
        }
    });

    test('script.js stays under its 15,000 line ceiling', () => {
        assert.ok(SCRIPT.split('\n').length < 15000, 'script.js lines: ' + SCRIPT.split('\n').length);
    });
});

function bodyOfName(name) {
    assert.ok(SCRIPT.includes(`function ${name}(`), `${name} exists in script.js`);
    return bodyOf(SCRIPT, name);
}

// ─────────────────────────────────────────────────────────────────────────────
// The real @polkadot/api Submittable, a fake api, and the WalletConnect signer
// over a fake phone that signs and drops the type byte.
function fakeApi() {
    const submitted = [];
    const listeners = {};
    const api = {
        registry, extrinsicType: 4, hasSubscriptions: true,
        genesisHash: registry.createType('Hash', '0x' + '22'.repeat(32)),
        runtimeVersion: registry.createType('RuntimeVersion', { specVersion: 1, transactionVersion: 1 }),
        call: {},
        derive: { tx: { signingInfo: () => of({ header: null, mortalLength: 64, nonce: registry.createType('Index', 5) }) } },
        rpc: {
            system: {},
            chain: { getHeader: () => Promise.resolve({ number: { toNumber: () => 7 } }) },
            author: { submitAndWatchExtrinsic: (ext) => { submitted.push(typeof ext === 'string' ? ext : ext.toHex()); return of(registry.createType('ExtrinsicStatus', 'Ready')); } }
        },
        on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); },
        off: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); }
    };
    return { api, submitted };
}
const submittable = (api) => createSubmittable('promise', api, toPromiseMethod, registry)(registry.createType('Call', remarkCall(registry, '0x1234')));
const phoneSigner = (onSign = () => {}) => createWalletConnectSigner({
    getRegistry: () => registry,
    request: async (method, params) => {
        onSign(method, params);
        const p = params.transactionPayload;
        return { signature: bare(signPayloadWith(pair, p)) };
    }
});

describe('tx-submit end to end with the WalletConnect signer', () => {
    test('signAsync, check, send: the submitted extrinsic is signed by the account with a valid MultiSignature', async () => {
        const { api, submitted } = fakeApi();
        const errors = [], shown = [];
        const run = trackSignedTx({
            api, action: { id: 'a', key: 'system.remark', params: {} },
            show: (a, st, ev, err, ex) => { const m = buildTxModel(a, st, ev, err, ex); shown.push(m); return m; },
            onError: (t) => errors.push(t)
        });
        run.start();
        let asked = null;
        await run.send(submittable(api), pair.address, phoneSigner((m, p) => { asked = { m, p }; }), { stillValid: () => true, assetId: 0 });
        await flush();
        assert.deepEqual(errors, []);
        assert.equal(asked.m, 'polkadot_signTransaction');
        assert.ok(same(asked.p.address, pair.address), 'the payload is for this account (any SS58 format)');
        assert.equal(submitted.length, 1);
        const back = registry.createType('Extrinsic', submitted[0]);
        assert.equal(back.isSigned, true);
        assert.equal(back.signer.toString(), registry.createType('Address', pair.publicKey).toString());
        assert.ok(back.signature.toU8a().length >= 64);
        assert.ok(shown.some(m => m.stage === 'broadcast'));
    });

    test('a phone that returns the signed transaction: exactly those bytes are submitted', async () => {
        const { api, submitted } = fakeApi();
        const errors = [];
        let sent = null;
        const run = trackSignedTx({ api, action: { id: 'd', key: 'system.remark', params: {} }, show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex), onError: (t) => errors.push(t) });
        run.start();
        const signer = createWalletConnectSigner({ getRegistry: () => registry, request: async (m, params) => { sent = signedTxFor(pair, params.transactionPayload); return { signedTransaction: sent }; } });
        await run.send(submittable(api), pair.address, signer, { stillValid: () => true, assetId: 0 });
        await flush();
        assert.deepEqual(errors, []);
        assert.deepEqual(submitted, [sent]);
    });

    test('a phone that returns a different signed transaction (another nonce): nothing is sent', async () => {
        const { api, submitted } = fakeApi();
        const errors = [];
        const run = trackSignedTx({ api, action: { id: 'e', key: 'system.remark', params: {} }, show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex), onError: (t) => errors.push(t) });
        run.start();
        const signer = createWalletConnectSigner({ getRegistry: () => registry, request: async (m, params) => ({ signedTransaction: signedTxFor(pair, params.transactionPayload, { nonce: '0x00000063' }) }) });
        await run.send(submittable(api), pair.address, signer, { stillValid: () => true, assetId: 0 });
        await flush();
        assert.equal(submitted.length, 0);
        assert.ok(errors.some(e => e.includes(DIFFERENT_TX)), errors.join(' | '));
    });

    test('the wallet changes while the phone is signing: nothing is sent', async () => {
        const { api, submitted } = fakeApi();
        const errors = [];
        let valid = true;
        const run = trackSignedTx({ api, action: { id: 'b', key: 'system.remark', params: {} }, show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex), onError: (t) => errors.push(t) });
        run.start();
        await run.send(submittable(api), pair.address, phoneSigner(() => { valid = false; }), { stillValid: () => valid, assetId: 0 });
        await flush();
        assert.equal(submitted.length, 0);
        assert.ok(errors.some(e => e.includes(WALLET_CHANGED_SIGNED)), errors.join(' | '));
    });

    test('a cancel on the phone ends the card as failed, nothing sent, the button usable again', async () => {
        const { api, submitted } = fakeApi();
        const errors = [];
        const run = trackSignedTx({ api, action: { id: 'c', key: 'system.remark', params: {} }, show: (a, st, ev, err, ex) => buildTxModel(a, st, ev, err, ex), onError: (t) => errors.push(t) });
        run.start();
        const signer = createWalletConnectSigner({ getRegistry: () => registry, request: async () => { throw { code: 5000, message: 'User rejected.' }; } });
        await run.send(submittable(api), pair.address, signer, { stillValid: () => true, assetId: 0 });
        await flush();
        assert.equal(submitted.length, 0);
        assert.equal(errors.length, 1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CSP: the relay is reachable, nothing else of WalletConnect is', () => {
    const conf = read('nginx.conf');
    const policies = [...conf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map(m => m[1]);
    const connect = (p) => (/connect-src ([^;]+)/.exec(p) || [])[1] || '';

    test('both server blocks allow wss://relay.walletconnect.org (the only relay dialled) in connect-src, not .com, and stay identical', () => {
        assert.equal(policies.length, 2);
        for (const p of policies) {
            assert.match(connect(p), /(^|\s)wss:\/\/relay\.walletconnect\.org(\s|$)/);
            assert.ok(!/walletconnect\.com/.test(p), 'relay.walletconnect.com is never dialled (config uses .org), so it is not allowed');
            assert.match(p, /connect-src 'self' wss:\/\/rpc\.polkadex\.ee/);
        }
        assert.equal(policies[0], policies[1]);
    });

    test('no telemetry, verify, modal, RPC proxy or push endpoints, and no frame-src', () => {
        for (const p of policies) {
            for (const bad of ['pulse.walletconnect', 'verify.walletconnect', 'web3modal', 'rpc.walletconnect', 'echo.walletconnect', 'push.walletconnect', 'notify.walletconnect', 'keys.walletconnect', 'secure.walletconnect', 'coinbase', 'walletlink', 'reown']) {
                assert.ok(!p.includes(bad), `${bad} in the policy`);
            }
            assert.ok(!/frame-src/.test(p), 'no frame-src');
            assert.ok(!/connect-src[^;]*https:\/\/[^ ;]*walletconnect/.test(p), 'no https WalletConnect endpoint');
            assert.match(p, /script-src 'self' 'wasm-unsafe-eval';/, 'script-src untouched');
        }
    });

    test('the nginx comment explains the relay entry; neither it nor the README lists .com as allowed', () => {
        assert.match(conf, /relay\.walletconnect\.org[^\n]*\n?[^\n]*/);
        assert.match(conf, /WalletConnect/);
        assert.ok(!conf.includes('relay.walletconnect.com'));
        assert.ok(!read('README.md').includes('wss://relay.walletconnect.com'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('privacy and storage inventory', () => {
    const html = read('index.html');
    test('/cookies documents the two WalletConnect keys and the SDK storage', () => {
        assert.ok(html.includes(config.WC_FLAG_KEY));
        assert.ok(html.includes(config.WC_SESSION_HINT_KEY));
        assert.match(html, /wc@2/);
    });
    test('the privacy page names the WalletConnect relay as a third party used only when chosen', () => {
        assert.match(html, /WalletConnect/);
        assert.match(html, /relay\.walletconnect/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('third-party notices: the WalletConnect Community License', () => {
    const NOTICES = 'public/THIRD-PARTY-NOTICES.txt';
    const wcDir = new URL('../node_modules/@walletconnect/', import.meta.url);
    // The packages of ours that ship under that license (the rest are MIT).
    const licensed = readdirSync(wcDir).filter(d => {
        try { return /SEE LICENSE IN LICENSE\.md/.test(JSON.parse(readFileSync(new URL(d + '/package.json', wcDir), 'utf8')).license || ''); } catch (e) { return false; }
    });

    test('the notices file carries the attribution the license requires', () => {
        const txt = read(NOTICES);
        assert.ok(txt.includes('Portions \u00a9 2025 Reown, Inc. All Rights Reserved'), 'the exact notice from section 2(a)');
        assert.match(txt, /@walletconnect\/universal-provider/);
        assert.ok(!/[\u2013\u2014]/.test(txt), 'no en or em dashes');
    });

    test('the notices file carries the license text verbatim, as installed (not fetched), for every package under it', () => {
        const txt = read(NOTICES);
        assert.ok(licensed.includes('universal-provider'), licensed.join(','));
        for (const d of licensed) {
            const lic = readFileSync(new URL(d + '/LICENSE.md', wcDir), 'utf8');
            assert.ok(txt.includes(lic.trim()), `@walletconnect/${d} LICENSE.md not copied verbatim (re-copy it after a version bump)`);
            assert.match(txt, new RegExp('@walletconnect/' + d + '\\b'), `@walletconnect/${d} named`);
        }
    });

    test('the installed version is the one the notices file names', () => {
        const ver = JSON.parse(read('package.json')).devDependencies['@walletconnect/universal-provider'];
        assert.ok(read(NOTICES).includes(ver), ver);
    });

    test('it starts with a UTF-8 byte order mark, so browsers read the \u00a9 and quotes right (nginx sends text/plain without a charset)', () => {
        assert.equal(read(NOTICES).charCodeAt(0), 0xfeff);
    });

    test('Vite ships it at /THIRD-PARTY-NOTICES.txt (public/), the footer links it, and the SPA router lets the link through', () => {
        const html = read('index.html');
        const footer = html.slice(html.indexOf('<footer class="site-footer">'), html.indexOf('</footer>'));
        assert.match(footer, /<a href="\/THIRD-PARTY-NOTICES\.txt"[^>]*>[^<]*Licen/);
        assert.match(SCRIPT, /const isRealFile = \/\\\.\[a-z0-9\]\{2,12\}\$\/i\.test\(path\)/);
        assert.ok(/\.[a-z0-9]{2,12}$/i.test('/THIRD-PARTY-NOTICES.txt'));
    });
});
