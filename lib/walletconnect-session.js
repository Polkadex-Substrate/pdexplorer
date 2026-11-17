// One WalletConnect v2 session with a phone wallet, on @walletconnect/universal-provider.
//
// Connection only: no Reown AppKit, no modal, no analytics. The provider class
// comes in through loadProvider() so tests run with a stand-in and the real
// package is only fetched by the browser when the source module asks for it.
//
//   - init: projectId, relay and app metadata from lib/walletconnect-config.js;
//     telemetryEnabled: false (no events to pulse.walletconnect.org);
//     disableProviderPing: true (the provider would otherwise ping
//     rpc.walletconnect.org for the chain's HTTP RPC, which we never use).
//   - Verify: the SDK proves our origin to the wallet with a hidden iframe from
//     verify.walletconnect.org. The CSP has no frame-src for it, so the iframe
//     could only time out (5 s before the QR and before every signing
//     request). register() is answered with '' at once, which is what the SDK
//     itself returns when verification fails. The wallet may show the request
//     as unverified.
//   - connect: the polkadot namespace as OPTIONAL (WalletConnect 2.x treats
//     required namespaces as optional anyway), the Polkadex chain only, the
//     two sign methods, no events. A session that shares no Polkadex account
//     is ended at once and refused.
//   - accounts: CAIP-10 "polkadot:<chain>:<address>" entries for the Polkadex
//     chain, re-encoded to SS58 format 88 for the explorer; requests send each
//     address back in the wallet's own encoding.
//   - restore: the provider reloads a stored session by itself; the same
//     Polkadex check applies.
//   - session_delete (phone) and session_expire (sign client) clear the
//     session and report { reason: 'ended' }; session_update reports
//     { reason: 'accounts', accounts }.
//
// Tested in test/walletconnect.test.js.

import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { WC_PROJECT_ID, WC_RELAY_URL, WC_METADATA, WC_METHODS, POLKADEX_CAIP2 } from './walletconnect-config.js';

export const WC_NO_POLKADEX_ACCOUNT = 'Your wallet did not share a Polkadex account. Check that Polkadex is enabled in the wallet, then try again.';
export const WC_CANCELLED = 'Cancelled';
const NOT_CONNECTED = 'Your phone wallet is not connected. Connect it again from the Connect wallet page.';

const toPolkadex = (raw) => {
    try { return encodeAddress(decodeAddress(raw), 88); } catch (e) { return ''; }
};

export function createWalletConnectSession({ loadProvider, chainId = POLKADEX_CAIP2, onChange = () => {}, logger = 'error' }) {
    let provider = null;
    let initP = null;
    let session = null;
    // The connect attempt in progress, or null: { cancelled, cancel(), stop }.
    let attempt = null;

    function polkadexAccounts(s) {
        const list = (s && s.namespaces && s.namespaces.polkadot && s.namespaces.polkadot.accounts) || [];
        const prefix = chainId + ':';
        const out = [];
        for (const entry of list) {
            if (typeof entry !== 'string' || !entry.startsWith(prefix)) continue;
            const raw = entry.slice(prefix.length);
            const address = toPolkadex(raw);
            if (address && !out.some(a => a.address === address)) out.push({ address, raw });
        }
        return out;
    }

    function clear() { session = null; }
    const isOurs = (e) => !!session && (!e || !e.topic || e.topic === session.topic);

    async function init() {
        if (provider) return provider;
        if (!initP) {
            initP = (async () => {
                const Provider = await loadProvider();
                const p = await Provider.init({
                    // A copy: the SDK writes to the metadata object (icons) and the config one is frozen.
                    projectId: WC_PROJECT_ID, relayUrl: WC_RELAY_URL, metadata: { ...WC_METADATA, icons: [...WC_METADATA.icons] },
                    telemetryEnabled: false, disableProviderPing: true, logger
                });
                const verify = p.client && p.client.core && p.client.core.verify;
                if (verify && typeof verify.register === 'function') verify.register = async () => '';
                p.on('session_delete', (e) => { if (!isOurs(e)) return; clear(); onChange({ reason: 'ended' }); });
                p.on('session_update', (e) => {
                    if (!isOurs(e)) return;
                    session = p.session || session;
                    onChange({ reason: 'accounts', accounts: polkadexAccounts(session).map(({ address }) => ({ address })) });
                });
                if (p.client && typeof p.client.on === 'function') {
                    p.client.on('session_expire', (e) => { if (!isOurs(e)) return; clear(); onChange({ reason: 'ended' }); });
                }
                provider = p;
                return p;
            })().catch((e) => { initP = null; throw e; });
        }
        return initP;
    }

    async function endQuietly(p) {
        try { await p.disconnect(); } catch (e) { /* relay down: the session expires on its own */ }
    }

    async function restore() {
        const p = await init();
        const s = p.session;
        if (!s) { clear(); return []; }
        const accs = polkadexAccounts(s);
        if (!accs.length) { clear(); await endQuietly(p); return []; }
        session = s;
        return accs.map(({ address }) => ({ address }));
    }

    // A session the wallet approved for an attempt that was cancelled (or
    // replaced by a newer one): ended at the wallet, by its own topic, so the
    // session of a newer attempt is never touched. Never kept here.
    async function endStale(p, s) {
        if (!s || (session && session.topic === s.topic)) return;
        try {
            if (p.client && typeof p.client.disconnect === 'function' && s.topic) {
                await p.client.disconnect({ topic: s.topic, reason: { code: 6000, message: 'User disconnected.' } });
            } else if (p.session === s) await p.disconnect();
        } catch (e) { /* relay down: the session expires on its own */ }
    }

    // Issue #71: the attempt (and its cancel) exists before the first await,
    // so Back during the module load or Provider.init is heard, and every
    // await below is followed by a look at it. Starting a new attempt cancels
    // the one before, so only one pairing runs and an older one finishing late
    // can neither clear nor replace the newer one.
    async function connect({ onUri } = {}) {
        if (attempt) attempt.cancel();
        let reject;
        const stop = new Promise((_, r) => { reject = r; });
        stop.catch(() => {});
        const mine = { cancelled: false, stop, cancel() { if (mine.cancelled) return; mine.cancelled = true; reject(new Error(WC_CANCELLED)); } };
        attempt = mine;
        let p = null, showUri = null;
        try {
            p = await Promise.race([init(), stop]);
            if (mine.cancelled) throw new Error(WC_CANCELLED);
            showUri = (uri) => { try { if (!mine.cancelled && onUri) onUri(uri); } catch (e) { /* a view bug must not break pairing */ } };
            p.on('display_uri', showUri);
            const pairing = p.connect({ optionalNamespaces: { polkadot: { chains: [chainId], methods: [...WC_METHODS], events: [] } } });
            // A late approval for this attempt, once cancelled, is ended at the wallet.
            pairing.then((s) => { if (mine.cancelled) return endStale(p, s); }, () => {});
            const s = await Promise.race([pairing, stop]);
            if (mine.cancelled) { await endStale(p, s); throw new Error(WC_CANCELLED); }
            const accs = polkadexAccounts(s);
            if (!accs.length) { clear(); await endQuietly(p); throw new Error(WC_NO_POLKADEX_ACCOUNT); }
            session = s;
            return accs.map(({ address }) => ({ address }));
        } finally {
            if (attempt === mine) attempt = null;
            if (p && showUri) {
                if (typeof p.off === 'function') p.off('display_uri', showUri);
                else if (typeof p.removeListener === 'function') p.removeListener('display_uri', showUri);
            }
        }
    }

    function cancelConnect() {
        if (attempt) attempt.cancel();
        if (provider && typeof provider.cleanupPendingPairings === 'function') provider.cleanupPendingPairings().catch(() => {});
    }

    async function disconnect() {
        const had = session;
        clear();
        if (had && provider) await endQuietly(provider);
    }

    // The address in the encoding the wallet itself shared (matched by public
    // key), in case a wallet compares address strings. Not part of the signed
    // bytes, so the signature is the same either way.
    function walletForm(address) {
        let key;
        try { key = decodeAddress(address).join(','); } catch (e) { return address; }
        const hit = polkadexAccounts(session).find(a => { try { return decodeAddress(a.raw).join(',') === key; } catch (e) { return false; } });
        return hit ? hit.raw : address;
    }
    function inWalletForm(params) {
        if (!params || typeof params !== 'object') return params;
        const out = { ...params };
        if (typeof out.address === 'string') out.address = walletForm(out.address);
        if (out.transactionPayload && typeof out.transactionPayload.address === 'string') {
            out.transactionPayload = { ...out.transactionPayload, address: walletForm(out.transactionPayload.address) };
        }
        return out;
    }

    async function request(method, params) {
        if (!session || !provider) throw new Error(NOT_CONNECTED);
        return provider.client.request({ topic: session.topic, chainId, request: { method, params: inWalletForm(params) } });
    }

    return {
        init, restore, connect, cancelConnect, disconnect, request,
        isConnected: () => !!session,
        accounts: () => polkadexAccounts(session).map(({ address }) => ({ address })),
        peerName: () => (session && session.peer && session.peer.metadata && session.peer.metadata.name) || '',
        // The wallet's public app metadata, for ?wcdebug=1. Never the topic or keys.
        peerInfo: () => {
            const m = (session && session.peer && session.peer.metadata) || {};
            const pick = (k) => (typeof m[k] === 'string' ? m[k] : '');
            return { name: pick('name'), url: pick('url'), description: pick('description'), version: pick('version') };
        }
    };
}
