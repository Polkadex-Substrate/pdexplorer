// The "Get a wallet" view of the Connect wallet page: a short path from
// nothing to a working wallet.
//
// Computer: the three recommended extensions with official install links (each
// opens a new tab), one line about the seed phrase, then "Check again", which
// looks for a new extension without a reload (the page also looks by itself
// when the tab regains focus). Phone: extensions do not exist there, so the
// view shows the wallet app cards (they carry the store links) and the guide.
//
// What used to be explained here (allow the site, the Polkadex address
// format) lives in the help topic set-up-a-wallet: it explains, it does not
// help choose. All copy is constant and every URL comes from lib/wallet-links.js.
// Spec: cto-team/plans/2026-11-16-connect-wallet-redesign.md b5, b6.

import { escapeHtml } from './html-escape.js';
import { DESKTOP_EXTENSIONS, HELP_SLUG, CREATE_WALLET_URL } from './wallet-links.js';
import { tileHtml } from './wallet-picker.js';

export const NO_WALLET_LINE = 'No wallet found in this browser.';
export const GET_LEAD = 'Install one, create an account, then come back.';
export const SEED_NOTE = 'Write your seed phrase on paper. Never share it.';
export const STILL_MISSING = 'Still no wallet found. Some browsers only load a new extension after the page reloads.';
// Quoted by the help topic set-up-a-wallet, no longer shown on the page.
export const ALLOW_LINE = 'Your wallet will ask whether Polkadex Explorer may see your accounts. Choose Allow.';
export const FORMAT_LINE = 'Polkadex addresses use format 88 and start with "e". The same account works on every network; only its look changes.';

const installRow = (e) => `<li class="wallet-option"><a class="wallet-option-row" href="${escapeHtml(e.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(`Install ${e.name}, opens in a new tab`)}">
        ${tileHtml(e.id, escapeHtml, { lg: true })}<span class="wallet-option-main"><span class="wallet-option-name">${escapeHtml(e.name)}</span><span class="wallet-option-sub">${escapeHtml(e.blurb)}</span></span>
        <span class="wallet-option-action">Install</span><i class='bx bx-link-external' aria-hidden="true"></i>
    </a></li>`;

const guideLink = `<a class="wallet-get-guide" href="/help/${HELP_SLUG}">Set up a wallet, step by step</a>`;
const createLine = `<p class="wallet-get-create">New to Polkadex? <a href="${CREATE_WALLET_URL}" target="_blank" rel="noopener">Create a wallet</a></p>`;

// retried: "Check again" was pressed and still nothing was found.
export function buildGetWalletHtml({ onMobile = false, retried = false } = {}) {
    if (onMobile) {
        return `<p class="wallet-get-note">${SEED_NOTE}</p>
        <div class="wallet-get-actions">${guideLink}</div>
        ${createLine}`;
    }
    const still = retried
        ? `<p class="wallet-onboarding-note" role="status" tabindex="-1">${STILL_MISSING}</p><button type="button" class="wallet-onboarding-reload">Reload page</button>`
        : '';
    return `<ul class="wallet-option-list" role="list" aria-labelledby="wallet-picker-sub">${DESKTOP_EXTENSIONS.map(installRow).join('')}</ul>
        <p class="wallet-get-note">${SEED_NOTE}</p>
        <div class="wallet-get-actions"><button type="button" class="wallet-get-check">Check again</button> ${guideLink}</div>
        ${still}
        ${createLine}`;
}
