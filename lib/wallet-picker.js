// The account picker's markup, kept apart from the page so it can be tested.
//
// The page (lib/wallet-picker-view.js) is the account list and little else:
//   - say WHICH extension each account comes from, with a group per extension
//     and the current account's group first;
//   - show the connected account exactly once, as a Current row that is not a
//     button, with Disconnect on it;
//   - above 8 accounts, a search that matches name, address, or a pasted
//     address in any network format (by public key).
// Spec: cto-team/plans/2026-11-11-switch-wallet-redesign.md.

// Display names for the keys extensions self-declare on window.injectedWeb3.
const SOURCE_LABELS = {
    'multisig': 'Multisig wallet',
    'polkadot-js': 'Polkadot.js',
    'talisman': 'Talisman',
    'subwallet-js': 'SubWallet',
    'polkagate': 'PolkaGate',
    'nova': 'Nova Wallet',
    'fearless-wallet': 'Fearless Wallet'
};

export function sourceLabel(key) {
    if (!key) return 'Read-only address';
    return SOURCE_LABELS[key] || String(key);
}

// Group headers carry a small tile. The repo ships no wallet logos and nothing
// is fetched at runtime, so extensions get a two-letter monogram in a fixed
// colour; the other groups get a boxicon.
const TILES = {
    'polkadot-js': 'PJ', 'talisman': 'TA', 'subwallet-js': 'SW', 'polkagate': 'PG', 'nova': 'NW', 'fearless-wallet': 'FW'
};
function tileHtml(source, esc) {
    if (TILES[source]) return `<span class="wallet-ext-tile tile-${esc(TILES[source].toLowerCase())}" aria-hidden="true">${TILES[source]}</span>`;
    const icon = !source ? 'bx-show' : source === 'multisig' ? 'bx-group' : 'bx-wallet';
    return `<span class="wallet-ext-tile tile-icon" aria-hidden="true"><i class='bx ${icon}'></i></span>`;
}

// More accounts than this and the list gets a search field and counts.
export const SEARCH_THRESHOLD = 8;

// Group accounts by the extension they came from, keeping the order extensions
// were enumerated in. Returns [{ source, label, accounts }].
export function groupBySource(accounts) {
    const groups = [];
    const index = new Map();
    for (const a of accounts || []) {
        const key = a.source || '';
        if (!index.has(key)) {
            const g = { source: key, label: sourceLabel(key), accounts: [] };
            index.set(key, g);
            groups.push(g);
        }
        index.get(key).accounts.push(a);
    }
    return groups;
}

// Case-insensitive substring on name and address; a full address in any
// network format matches by public key (isSame), so a generic-format paste
// still finds its row.
export function filterAccounts(accounts, query, isSame) {
    const q = String(query || '').trim();
    if (!q) return (accounts || []).slice();
    const low = q.toLowerCase();
    return (accounts || []).filter(a => {
        if (String(a.name || '').toLowerCase().includes(low)) return true;
        if (String(a.address || '').toLowerCase().includes(low)) return true;
        try { return !!isSame(a.address, q); } catch (e) { return false; }
    });
}

// The connected account, if it is in the list: the one from the extension it
// was picked from (so the same key in two extensions is current once). With no
// recorded extension (an older session), the first match.
function findCurrent(accounts, current, currentSource, isSame) {
    if (!current) return null;
    const matches = accounts.filter(a => isSame(a.address, current));
    if (!currentSource) return matches[0] || null;
    return matches.find(a => (a.source || '') === currentSource) || null;
}

function currentRowHtml({ address, name, source, esc, shortAddr }) {
    const shortA = shortAddr(address);
    const label = name || shortA;
    return `<li><div class="wallet-account-row is-current" data-address="${esc(address)}" data-source="${esc(source || '')}" aria-current="true">
        <span class="wallet-account-main"><span class="wallet-account-name"><span class="wallet-account-label">${esc(label)}</span> <span class="wallet-account-badge">Current</span></span>${name ? `<span class="wallet-account-addr">${esc(shortA)}</span>` : ''}<span class="sr-only">, current account</span></span>
        <button type="button" id="wallet-picker-disconnect" class="wallet-disconnect-link" title="Disconnect this wallet from Polkadex Explorer">Disconnect</button>
    </div></li>`;
}

function rowHtml(a, { esc, shortAddr }) {
    const shortA = shortAddr(a.address);
    return `<li><button type="button" class="wallet-account-btn" data-address="${esc(a.address)}" data-source="${esc(a.source || '')}" aria-label="${esc(`Switch to ${a.name}, ${shortA}, ${sourceLabel(a.source)}`)}">
        <span class="wallet-account-main"><span class="wallet-account-name">${esc(a.name)}</span><span class="wallet-account-addr">${esc(shortA)}</span></span>
        <i class='bx bx-chevron-right' aria-hidden="true"></i>
    </button></li>`;
}

// `accounts` is everything the extensions shared (null or [] is fine: the
// current account still gets its row). `query` filters rows, the current row
// included. Groups with no row left disappear.
export function buildAccountListHtml({ accounts, current, currentSource, isSame, esc, shortAddr, query = '' }) {
    const all = accounts || [];
    const counts = all.length > SEARCH_THRESHOLD;
    const cur = findCurrent(all, current, currentSource, isSame);
    const groups = groupBySource(all);
    // A connected wallet that no extension lists (a typed address, a multisig,
    // or an extension that is now locked) still gets one row, so Disconnect
    // always has a home.
    if (current && !cur) groups.unshift({ source: currentSource || '', label: sourceLabel(currentSource), accounts: [], synthetic: true });
    const curSource = cur ? (cur.source || '') : (currentSource || '');
    const ordered = current ? [...groups.filter(g => g.source === curSource), ...groups.filter(g => g.source !== curSource)] : groups;
    const visible = new Set(filterAccounts(all, query, isSame));
    const syntheticVisible = !!current && !cur && filterAccounts([{ address: current, name: '' }], query, isSame).length === 1;
    return ordered.map((g, i) => {
        const rows = [];
        if (g.synthetic) { if (syntheticVisible) rows.push(currentRowHtml({ address: current, name: '', source: g.source, esc, shortAddr })); }
        else {
            for (const a of g.accounts) {
                if (!visible.has(a)) continue;
                rows.push(a === cur ? currentRowHtml({ address: a.address, name: a.name, source: a.source, esc, shortAddr }) : rowHtml(a, { esc, shortAddr }));
            }
        }
        if (!rows.length) return '';
        const id = `wallet-group-${i}`;
        const n = g.accounts.length;
        return `<div class="wallet-account-group" role="group" aria-labelledby="${id}" data-source="${esc(g.source)}">
        <div class="wallet-group-head" id="${id}">${tileHtml(g.source, esc)}${esc(g.label)}${counts && n ? ` (${n})` : ''}</div>
        <ul class="wallet-account-list" role="list">${rows.join('')}</ul></div>`;
    }).join('');
}

// One secondary line for anyone who has no wallet yet: points at the official
// step-by-step guide on polkadex.ee.
export const CREATE_WALLET_URL = 'https://polkadex.ee/wallet';
export function buildCreateWalletLineHtml(extraAttrs = '') {
    return `<p class="wallet-empty-msg wallet-create-line"${extraAttrs ? ' ' + extraAttrs : ''}>New to Polkadex? <a href="${CREATE_WALLET_URL}" target="_blank" rel="noopener">Create a wallet</a></p>`;
}

export const POLKADOT_JS_URL = 'https://polkadot.js.org/extension/';
export const TALISMAN_URL = 'https://talisman.xyz/download';
export const SUBWALLET_URL = 'https://subwallet.app';

const refreshBtn = (label, primary) => `<button type="button" class="wallet-picker-refresh-btn${primary ? ' is-primary' : ''}"><i class='bx bx-refresh' aria-hidden="true"></i> ${label}</button>`;

// The empty states. 'none': no wallet in this browser. 'zero': a wallet
// answered with no accounts (locked, or none allowed: indistinguishable today).
export const EMPTY_HEADINGS = { none: 'No wallet found in this browser', zero: 'Your wallet did not share any accounts' };
export function buildEmptyStateHtml(kind, { onMobile = false } = {}) {
    if (kind === 'zero') {
        return `<div class="wallet-picker-empty"><i class='bx bx-lock-alt wallet-picker-empty-icon' aria-hidden="true"></i>
            <h3>${EMPTY_HEADINGS.zero}</h3>
            <ol><li>Open your wallet extension and unlock it.</li><li>Allow Polkadex Explorer to see at least one account.</li><li>Press Refresh.</li></ol>
            ${refreshBtn('Refresh', true)}
        </div>`;
    }
    const body = onMobile
        ? '<p>Phone browsers cannot use wallet extensions. Open this page inside your wallet app instead.</p>'
        : `<p>Install a wallet extension, then refresh.</p>
            <div class="wallet-picker-install"><a class="wallet-picker-install-main" href="${POLKADOT_JS_URL}" target="_blank" rel="noopener">Get Polkadot.js</a>
            <a href="${TALISMAN_URL}" target="_blank" rel="noopener">Talisman</a>
            <a href="${SUBWALLET_URL}" target="_blank" rel="noopener">SubWallet</a></div>
            ${refreshBtn('Refresh', false)}`;
    return `<div class="wallet-picker-empty"><i class='bx bx-wallet wallet-picker-empty-icon' aria-hidden="true"></i>
        <h3>${EMPTY_HEADINGS.none}</h3>${body}</div>`;
}

export function buildMissingAccountHtml() {
    return `<details id="wallet-picker-missing" class="wallet-picker-disclosure" hidden>
        <summary>Don't see your account?</summary>
        <div class="wallet-picker-disclosure-body">
            <p>Your wallet only shows the accounts you have allowed for this site.</p>
            <ol><li>Open your wallet extension and allow Polkadex Explorer to see the account.</li><li>Press Refresh accounts.</li></ol>
            <p>Using a different wallet extension? Install or unlock it, then refresh.</p>
            ${refreshBtn('Refresh accounts', false)}
        </div>
    </details>`;
}

export const SAFETY_LINE = 'Polkadex Explorer never moves funds on its own. Every transaction needs your approval in your wallet.';

// The page skeleton. The X comes first in the markup so it is first in the tab
// order (the stylesheet moves it to the right). Everything that depends on the extension's answer is
// filled in by the view; ids the rest of the app relies on are kept.
export function buildPickerShellHtml({ mode, helpHtml, closeHtml, onMobile, mobileCardsHtml, currentUrl, esc }) {
    const switching = mode === 'switch';
    return `<section class="list-container glass wallet-picker${onMobile ? ' is-mobile' : ''}" aria-labelledby="wallet-picker-title" data-mode="${switching ? 'switch' : 'connect'}">
        <div class="list-header wallet-picker-head">${closeHtml || ''}<div class="wallet-picker-titlebox"><h2 id="wallet-picker-title" tabindex="-1">${switching ? 'Switch wallet' : 'Connect wallet'}</h2> ${helpHtml || ''}</div></div>
        <div class="wallet-picker-body">
            <p class="wallet-picker-sub">${switching ? 'Choose the account you want to use.' : 'Choose an account to open your dashboard.'}</p>
            <div class="wallet-picker-label"><span id="wallet-picker-count-label">Your accounts</span>
                <button type="button" id="wallet-picker-refresh" class="wp-icon-btn" aria-label="Refresh accounts" title="Refresh accounts" aria-busy="false"><i class='bx bx-refresh' aria-hidden="true"></i></button></div>
            <div id="wallet-picker-search-wrap" class="wallet-picker-search" hidden>
                <i class='bx bx-search' aria-hidden="true"></i>
                <input type="search" id="wallet-picker-search" inputmode="search" placeholder="Search by name or address" aria-label="Search by name or address" autocomplete="off" spellcheck="false">
                <button type="button" id="wallet-picker-search-clear" class="wp-icon-btn" aria-label="Clear search" hidden><i class='bx bx-x' aria-hidden="true"></i></button>
            </div>
            <div id="wallet-picker-live" class="sr-only" aria-live="polite"></div>
            <div id="wallet-accounts"></div>
            <p id="wallet-picker-status" class="wallet-picker-status"></p>
            ${buildMissingAccountHtml()}
            <hr class="wallet-picker-divider">
            <div id="wallet-multisig-accounts"></div>
            <details id="wallet-mobile-section" class="wallet-picker-disclosure" ${onMobile ? '' : 'hidden'}>
                <summary>Wallet on your phone?</summary>
                <div class="wallet-picker-disclosure-body">
                    <h3>Open in your wallet app</h3>
                    <p>Phone browsers cannot use wallet extensions. Open this page inside your wallet app and your accounts will appear here.</p>
                    ${mobileCardsHtml || ''}
                    <div class="mobile-wallet-copyrow">
                        <input id="wallet-copy-url" type="text" readonly aria-label="Link to this page" value="${esc(currentUrl || '')}">
                        <button id="wallet-copy-btn" type="button">Copy link</button>
                    </div>
                </div>
            </details>
            <details id="wallet-picker-view" class="wallet-picker-disclosure">
                <summary>View any address</summary>
                <div class="wallet-picker-disclosure-body">
                    <p class="wallet-picker-hint">Read only. You can look, but not sign.</p>
                    <div class="staking-search-bar wallet-picker-view-bar">
                        <input type="text" id="wallet-manual-input" placeholder="Polkadex address" aria-label="Polkadex address" autocomplete="off" spellcheck="false">
                        <button type="button" id="wallet-manual-btn">View</button>
                    </div>
                    <div id="wallet-manual-error" class="staking-error" role="alert" style="display:none;"></div>
                </div>
            </details>
            <p id="wallet-picker-footnote" class="wallet-picker-footnote">${SAFETY_LINE}</p>
            ${switching ? '' : buildCreateWalletLineHtml('id="wallet-create-line"')}
        </div>
    </section>`;
}
