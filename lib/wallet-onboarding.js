// The "No wallet found in this browser" state of the Connect wallet page: a
// short path from nothing to a working wallet.
//
// Desktop: three recommended extensions with official install links, then what
// to expect (allow the explorer, the Polkadex address format), then "I
// installed it", which asks the page to look again without a reload.
// Phone: extensions do not exist there, so the path is a wallet app and its
// built-in browser.
//
// All copy is constant and every URL comes from lib/wallet-links.js. The
// WalletConnect slot ("Connect with your phone") is shown when the picker is
// given a WalletConnect controller (FEATURE_FLAGS.walletConnect or ?wc=1, see
// lib/walletconnect-gate.js); the button starts pairing in the slot's panel.

import { escapeHtml } from './html-escape.js';
import { DESKTOP_EXTENSIONS, HELP_SLUG, FEATURE_FLAGS } from './wallet-links.js';

export const NO_WALLET_HEADING = 'No wallet found in this browser';
export const ALLOW_LINE = 'Your wallet will ask whether Polkadex Explorer may see your accounts. Choose Allow.';
export const FORMAT_LINE = 'Polkadex addresses use format 88 and start with "e". The same account works on every network; only its look changes.';
export const STILL_MISSING = 'Still no wallet found. Some browsers only load a new extension after the page reloads.';

const ext = (e) => `<li><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">Install ${escapeHtml(e.name)}</a> <span class="wallet-onboarding-blurb">${escapeHtml(e.blurb)}</span></li>`;

const helpLink = `<p class="wallet-onboarding-help"><a href="/help/${HELP_SLUG}">Set up a wallet, step by step</a></p>`;

// wc: the picker's WalletConnect controller ({ isConnected(), peerName() }).
// Paired: who, and a way to end it. Not paired: the button and an empty panel
// the pairing QR is drawn in.
export function buildWalletConnectSlotHtml(wc, { onMobile = false } = {}) {
    const connected = !!(wc && typeof wc.isConnected === 'function' && wc.isConnected());
    if (connected) {
        const peer = typeof wc.peerName === 'function' ? wc.peerName() : '';
        return `<div class="wallet-onboarding-wc" data-slot="walletconnect"><p class="wallet-wc-connected"><i class='bx bx-mobile' aria-hidden="true"></i> Phone wallet connected${peer ? ': ' + escapeHtml(peer) : ''}. Its accounts are in the list.</p><button type="button" class="wallet-wc-disconnect">End phone connection</button></div>`;
    }
    const label = onMobile ? 'Connect a wallet app (WalletConnect)' : 'Connect with your phone (WalletConnect)';
    const blurb = onMobile ? 'Nova Wallet or SubWallet, without leaving this browser.' : 'Scan a code with Nova Wallet or SubWallet.';
    return `<div class="wallet-onboarding-wc" data-slot="walletconnect"><button type="button" class="wallet-wc-connect">${label}</button> <span class="wallet-onboarding-blurb">${blurb}</span><div class="wallet-wc-panel" hidden></div></div>`;
}

export function buildOnboardingHtml({ onMobile = false, retried = false, walletConnect = FEATURE_FLAGS.walletConnect } = {}) {
    const slot = walletConnect ? buildWalletConnectSlotHtml(walletConnect, { onMobile }) : '';
    const icon = `<i class='bx bx-wallet wallet-picker-empty-icon' aria-hidden="true"></i>`;
    if (onMobile) {
        return `<div class="wallet-picker-empty wallet-onboarding">${icon}
        <h3>${NO_WALLET_HEADING}</h3>
        <p>Phone browsers cannot use wallet extensions. Open this page inside your wallet app instead.</p>
        <ol class="wallet-onboarding-steps">
            <li>Install Nova Wallet or SubWallet from your app store.</li>
            <li>Open the wallet and go to its built-in browser. Type explorer.polkadex.ee.</li>
            <li>${ALLOW_LINE}</li>
        </ol>
        <p>${escapeHtml(FORMAT_LINE)}</p>
        ${helpLink}${slot}
        </div>`;
    }
    const note = retried
        ? `<p class="wallet-onboarding-note" role="status" tabindex="-1">${STILL_MISSING}</p><button type="button" class="wallet-onboarding-reload">Reload page</button>`
        : '';
    return `<div class="wallet-picker-empty wallet-onboarding">${icon}
        <h3>${NO_WALLET_HEADING}</h3>
        <p>Install a wallet extension, then refresh.</p>
        <ul class="wallet-onboarding-ext">${DESKTOP_EXTENSIONS.map(ext).join('')}</ul>
        <ol class="wallet-onboarding-steps">
            <li>Create an account in the wallet, or import one. Write the seed phrase on paper.</li>
            <li>Come back here and press I installed it.</li>
            <li>${ALLOW_LINE}</li>
        </ol>
        <p>${escapeHtml(FORMAT_LINE)}</p>
        <button type="button" class="wallet-picker-refresh-btn is-primary wallet-onboarding-installed"><i class='bx bx-refresh' aria-hidden="true"></i> I installed it</button>
        ${note}${helpLink}${slot}
        </div>`;
}
