// Every outside URL the wallet onboarding sends a user to, in one place.
//
// A user who has no wallet is about to install software that holds money. A
// wrong link here is a phishing link, so the rule is enforced by a test
// (test/wallet-onboarding.test.js): every URL below is https and its host is in
// OFFICIAL_HOSTS. Add a wallet by adding its vendor's own domain to that list
// in the same change, never a download aggregator, mirror or search result.

// The only hosts an onboarding link may point at: the wallet vendors' own
// sites, the two app stores, and Polkadex.
export const OFFICIAL_HOSTS = [
    'polkadot.js.org',        // Polkadot.js extension
    'talisman.xyz',           // Talisman
    'subwallet.app',          // SubWallet
    'novawallet.io',          // Nova Wallet
    'app.novawallet.io',      // Nova's published universal link
    'apps.apple.com',         // Apple App Store
    'play.google.com',        // Google Play
    'polkadex.ee',            // wallet guide
    'explorer.polkadex.ee'    // this site
];

// Desktop extensions we recommend, in the order shown. `blurb` is the one line
// under the link.
export const DESKTOP_EXTENSIONS = [
    { id: 'polkadot-js', name: 'Polkadot.js', url: 'https://polkadot.js.org/extension/', blurb: 'The reference extension. Simple and reliable.' },
    { id: 'talisman', name: 'Talisman', url: 'https://talisman.xyz/download', blurb: 'Easy to use, and shows your tokens clearly.' },
    { id: 'subwallet-js', name: 'SubWallet', url: 'https://subwallet.app', blurb: 'Works in the browser and has a phone app too.' }
];

// Phone wallets. They run the explorer in their own in-app browser, which
// injects accounts the same way a desktop extension does.
//
// `deeplink` is set only where the wallet's own documentation publishes a way
// to open a web page in its browser. Nova documents the universal link below.
// SubWallet's URL scheme was in this file before and could not be confirmed
// against their documentation, so it is null: the page gives plain steps
// instead. Set it again only with a link to the docs in this comment.
//
// NOVA_DAPP_CATALOG_LISTED: Nova's documentation says the app link
// https://app.novawallet.io/open/dapp?url={YOUR_DAPP_URL} only works for dApps
// listed in Nova Wallet's DApp Catalog. explorer.polkadex.ee is not known to be
// listed, so the "Open in Nova" button stays hidden and the page shows plain
// steps. Set this true only after the explorer appears in the catalog. The link
// then carries the bare origin (EXPLORER_ORIGIN), never the page path or query.
export const NOVA_DAPP_CATALOG_LISTED = false;

// The dApp URL handed to a wallet: origin only, no path, query or hash.
export const EXPLORER_ORIGIN = 'https://explorer.polkadex.ee';

export const MOBILE_WALLETS = [
    {
        id: 'nova',
        name: 'Nova Wallet',
        inAppBrowser: true,
        deeplink: (url) => 'https://app.novawallet.io/open/dapp?url=' + encodeURIComponent(url),
        appStore: 'https://apps.apple.com/app/nova-polkadot-kusama-wallet/id1597119355',
        playStore: 'https://play.google.com/store/apps/details?id=io.novafoundation.nova.market',
        site: 'https://novawallet.io',
        tagline: 'Polkadot & Kusama native, Apple/Android'
    },
    {
        id: 'subwallet',
        name: 'SubWallet',
        inAppBrowser: true,
        deeplink: null,
        appStore: 'https://apps.apple.com/app/subwallet-polkadot-wallet/id1633050285',
        playStore: 'https://play.google.com/store/apps/details?id=app.subwallet.mobile',
        site: 'https://subwallet.app',
        tagline: 'Multi-chain wallet with a built-in browser, Apple/Android'
    },
    {
        id: 'talisman',
        name: 'Talisman',
        deeplink: null,
        appStore: null,
        playStore: null,
        site: 'https://talisman.xyz/download',
        tagline: 'Browser extension, desktop today'
    }
];

export const CREATE_WALLET_URL = 'https://polkadex.ee/wallet';

// The in-app "Set up a wallet" help article (lib/help-topics.js).
export const HELP_SLUG = 'set-up-a-wallet';

// Features that ship dark. walletConnect: the "Connect with your phone
// (WalletConnect)" slot. No WalletConnect code exists yet; turning this on only
// shows a disabled placeholder.
export const FEATURE_FLAGS = { walletConnect: false };

// Every URL above, flat, for the guard test.
export function allWalletUrls() {
    const urls = [CREATE_WALLET_URL];
    for (const e of DESKTOP_EXTENSIONS) urls.push(e.url);
    for (const w of MOBILE_WALLETS) {
        for (const u of [w.appStore, w.playStore, w.site]) if (u) urls.push(u);
        if (w.deeplink) urls.push(w.deeplink(EXPLORER_ORIGIN));
    }
    return urls;
}
