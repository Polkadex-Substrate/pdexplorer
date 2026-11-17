// WalletConnect v2 settings, in one place so the project id (or the relay) can
// be swapped without touching the code that uses them. Plain data: this module
// is in the eager bundle and imports nothing.
//
// Project id: public by design (it ships in the bundle; the Reown dashboard's
// domain allowlist is what protects it). CEO-provided, shared with the
// orderbook project for now: give the explorer its own when it goes live.
// Research: cto-team/plans/2026-11-14-walletconnect-research.md.

export const WC_PROJECT_ID = 'b87e50ee46c399e8a602ebab081e9125';

// Polkadex mainnet. A WalletConnect polkadot chain id is the first 32 hex
// characters of the genesis hash (CAIP-13, Reown Polkadot guide).
export const POLKADEX_GENESIS = '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c';
export function caip2FromGenesis(genesis) {
    return 'polkadot:' + String(genesis).replace(/^0x/, '').slice(0, 32).toLowerCase();
}
export const POLKADEX_CAIP2 = caip2FromGenesis(POLKADEX_GENESIS);

// The SDK default. Changing it also means changing connect-src in nginx.conf.
export const WC_RELAY_URL = 'wss://relay.walletconnect.org';

export const WC_METHODS = Object.freeze(['polkadot_signTransaction', 'polkadot_signMessage']);

// What the phone shows about who is asking.
export const WC_METADATA = Object.freeze({
    name: 'Polkadex Explorer',
    description: 'Polkadex mainnet explorer, staking and governance',
    url: 'https://explorer.polkadex.ee',
    icons: Object.freeze(['https://explorer.polkadex.ee/favicon.png'])
});

// The wallet-source key, like 'polkadot-js' or 'talisman' for extensions.
export const WC_SOURCE = 'walletconnect';

// localStorage. pdex_wc_enabled: this browser opted in with ?wc=1 (?wc=0
// clears it). pdex_wc_session: a WalletConnect session was made here, so the
// page may load the WalletConnect code on start to restore it. Without that
// hint nothing WalletConnect is loaded and the relay is never contacted.
export const WC_FLAG_KEY = 'pdex_wc_enabled';
export const WC_SESSION_HINT_KEY = 'pdex_wc_session';
// pdex_wc_debug: ?wcdebug=1 (?wcdebug=0 clears it). A failed signature check
// then shows a copyable support block and logs it (lib/walletconnect-debug.js).
export const WC_DEBUG_KEY = 'pdex_wc_debug';
