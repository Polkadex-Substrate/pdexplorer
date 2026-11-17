// The Connect wallet / Switch wallet page's markup, kept apart from the page
// so it can be tested.
//
// The first screen is a short list of HOW to connect (one row per wallet
// extension, the phone, "No wallet? Get one"); accounts are the second step,
// grouped under the wallet they came from, with the connected account shown
// once as a Current row with Disconnect. A problem is one line under the row
// that caused it.
// Specs: cto-team/plans/2026-11-16-connect-wallet-redesign.md (the chooser)
// and 2026-11-11-switch-wallet-redesign.md (account rows, Current row, search).

import { DESKTOP_EXTENSIONS, CREATE_WALLET_URL } from './wallet-links.js';
import { sourceLabel, PHONE_SOURCE } from './wallet-sources.js';

export { sourceLabel };

// Group headers carry a small tile. The repo ships no wallet logos and nothing
// is fetched at runtime, so extensions get a two-letter monogram on the one
// neutral tile (brand audit C12: a coloured square is not the wallet's mark);
// the phone gets the phone icon and the other groups a boxicon.
const TILES = {
    'polkadot-js': 'PJ', 'talisman': 'TA', 'subwallet-js': 'SW', 'polkagate': 'PG', 'nova': 'NW', 'fearless-wallet': 'FW'
};
export function tileHtml(source, esc, { lg = false, icon: forced = '' } = {}) {
    const size = lg ? ' is-lg' : '';
    if (!forced && TILES[source]) return `<span class="wallet-ext-tile${size} tile-${esc(TILES[source].toLowerCase())}" aria-hidden="true">${TILES[source]}</span>`;
    const icon = forced || (!source ? 'bx-show' : source === 'multisig' ? 'bx-group' : source === PHONE_SOURCE ? 'bx-mobile' : 'bx-wallet');
    return `<span class="wallet-ext-tile${size} tile-icon" aria-hidden="true"><i class='bx ${icon}'></i></span>`;
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

function rowHtml(a, { esc, shortAddr, primary = false }) {
    const shortA = shortAddr(a.address);
    return `<li><button type="button" class="wallet-account-btn${primary ? ' is-primary' : ''}" data-address="${esc(a.address)}" data-source="${esc(a.source || '')}" aria-label="${esc(`Switch to ${a.name}, ${shortA}, ${sourceLabel(a.source)}`)}">
        <span class="wallet-account-main"><span class="wallet-account-name">${esc(a.name)}</span><span class="wallet-account-addr">${esc(shortA)}</span></span>
        <i class='bx bx-chevron-right' aria-hidden="true"></i>
    </button></li>`;
}

// `accounts` is what the wallet shared (null or [] is fine: the current
// account still gets its row). `query` filters rows, the current row included.
// Groups with no row left disappear. `heads` puts extra controls on a group's
// head, by source: { html, label } (the refresh icon, End connection).
// `primary`: connect mode, where the wallet's one account is the one action (is-primary).
// With a current account (switch mode) no row is ever primary.
export function buildAccountListHtml({ accounts, current, currentSource, isSame, esc, shortAddr, query = '', heads = {}, primary = false }) {
    const all = accounts || [];
    const solo = primary && !current && all.length === 1;
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
                rows.push(a === cur ? currentRowHtml({ address: a.address, name: a.name, source: a.source, esc, shortAddr }) : rowHtml(a, { esc, shortAddr, primary: solo }));
            }
        }
        if (!rows.length) return '';
        const id = `wallet-group-${i}`;
        const n = g.accounts.length;
        const extra = !g.synthetic && heads[g.source] ? heads[g.source] : {};
        return `<div class="wallet-account-group" role="group" aria-labelledby="${id}" data-source="${esc(g.source)}">
        <div class="wallet-group-head"><span class="wallet-group-name" id="${id}">${tileHtml(g.source, esc)}${esc(extra.label || g.label)}${counts && n ? ` (${n})` : ''}</span>${extra.html || ''}</div>
        <ul class="wallet-account-list" role="list">${rows.join('')}</ul></div>`;
    }).join('');
}

// One secondary line for anyone who has no wallet yet: points at the official
// step-by-step guide on polkadex.ee.
export function buildCreateWalletLineHtml(extraAttrs = '') {
    return `<p class="wallet-empty-msg wallet-create-line"${extraAttrs ? ' ' + extraAttrs : ''}>New to Polkadex? <a href="${CREATE_WALLET_URL}" target="_blank" rel="noopener">Create a wallet</a></p>`;
}

export const POLKADOT_JS_URL = DESKTOP_EXTENSIONS[0].url;
export const TALISMAN_URL = DESKTOP_EXTENSIONS[1].url;
export const SUBWALLET_URL = DESKTOP_EXTENSIONS[2].url;
export { CREATE_WALLET_URL };

const refreshBtn = (label) => `<button type="button" class="wallet-picker-refresh-btn"><i class='bx bx-refresh' aria-hidden="true"></i> ${label}</button>`;

// The refresh icon on the shown wallet's group head (id kept for the app).
export const REFRESH_ICON_HTML = `<button type="button" id="wallet-picker-refresh" class="wp-icon-btn" aria-label="Refresh accounts" title="Refresh accounts" aria-busy="false"><i class='bx bx-refresh' aria-hidden="true"></i></button>`;

// ── the options view: how to connect ──

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const accountCount = (n) => plural(n, 'account', 'accounts');

// The one line under a row that did not work, and its one action.
export const PROBLEM_LINES = {
    rejected: (name) => `${name} did not allow this site. Allow Polkadex Explorer in the extension.`,
    empty: (name) => `${name} shared no accounts. Allow one in the extension.`,
    missing: (name) => `${name} is no longer available in this browser.`
};
// `line` replaces the standard sentence (the phone's own "no account" line);
// `id` lets the row name the line as part of its description.
export function buildOptionProblemHtml(kind, name, { key = '', esc = (s) => s, line = '', id = '' } = {}) {
    const text = line || (PROBLEM_LINES[kind] || PROBLEM_LINES.rejected)(name);
    const retry = kind === 'missing' ? '' : `<button type="button" class="wallet-option-retry" data-source="${esc(key)}">Try again</button>`;
    return `<div class="wallet-option-problem"><p${id ? ` id="${id}"` : ''}>${esc(text)}</p> ${retry}</div>`;
}

// An id prefix for a row, from its wallet key (keys are self-declared by
// extensions, so anything outside [A-Za-z0-9_-] is replaced).
const rowId = (key) => 'wallet-opt-' + String(key).replace(/[^A-Za-z0-9_-]/g, '_');

const chevron = `<i class='bx bx-chevron-right' aria-hidden="true"></i>`;
// A row with a fixed `label` (its name) keeps the changing text audible as its
// description: the waiting line, the account count, the problem line under it.
function optionRow({ attrs, tile, name, sub = '', action = '', busy = false, cls = '', label = '', id = '', problemId = '' }) {
    const desc = [...(id ? [sub ? id + '-sub' : '', !busy && action && action !== 'Connect' ? id + '-act' : ''] : []), problemId].filter(Boolean);
    return `<button type="button" class="wallet-option-row${cls ? ' ' + cls : ''}" ${attrs}${label ? ` aria-label="${label}"` : ''}${desc.length ? ` aria-describedby="${desc.join(' ')}"` : ''}${busy ? ' aria-busy="true"' : ''}>
        ${tile}<span class="wallet-option-main"><span class="wallet-option-name">${name}</span>${sub ? `<span class="wallet-option-sub"${id ? ` id="${id}-sub"` : ''}>${sub}</span>` : ''}</span>
        ${busy ? `<i class='bx bx-loader-alt wallet-option-spin' aria-hidden="true"></i>` : (action ? `<span class="wallet-option-action${action !== 'Connect' ? ' is-count' : ''}"${id ? ` id="${id}-act"` : ''}>${action}</span>` : '')}${busy ? '' : chevron}
    </button>`;
}

// The one row that is Solid (brand pass 3.1), in this order: Get a wallet when
// nothing is installed on a computer; the wallet used last, if it has a row;
// the only row that connects; otherwise none (several equal wallets and no
// history: none is recommended). Returns 'get', a source key, PHONE_SOURCE or ''.
export function chooseLead({ sources = [], phone = false, lastSource = '', onMobile = false }) {
    if (!sources.length && !onMobile) return 'get';
    if (lastSource && (sources.some(s => s.key === lastSource) || (lastSource === PHONE_SOURCE && phone))) return lastSource;
    if (sources.length + (phone ? 1 : 0) === 1) return sources.length ? sources[0].key : PHONE_SOURCE;
    return '';
}

// sources: [{ key, name }] installed extensions, in order.
// states: { key: { status, accounts, slow, problem } } as the view keeps them;
//   status 'waiting' while the wallet is asked, 'ok' once it shared accounts.
// phone: false, or { connected, peer, count, problem, problemLine } for the
//   phone row (problemLine: the phone's own sentence for that problem).
// switching: a wallet is connected (no Get row unless nothing is installed).
// lead: the Solid row, from chooseLead ('get', a source key, PHONE_SOURCE or '').
export function buildOptionRowsHtml({ sources = [], states = {}, onMobile = false, phone = false, switching = false, lead = '', esc }) {
    const items = [];
    for (const s of sources) {
        const st = states[s.key] || {};
        const name = esc(s.name);
        let sub = '', action = 'Connect';
        const busy = st.status === 'waiting';
        if (busy) sub = st.slow ? `Still waiting. Look for a ${name} popup, or open the extension.` : `Approve the request in ${name}.`;
        else if (st.status === 'ok') action = accountCount((st.accounts || []).length);
        const id = rowId(s.key), problemId = st.problem ? id + '-problem' : '';
        const row = optionRow({ attrs: `data-source="${esc(s.key)}"`, tile: tileHtml(s.key, esc, { lg: true }), name, sub, action, busy, cls: lead === s.key ? 'is-primary' : '', label: `Connect with ${name}`, id, problemId });
        const cancel = busy ? `<button type="button" class="wallet-option-cancel" data-source="${esc(s.key)}">Cancel</button>` : '';
        const problem = st.problem ? buildOptionProblemHtml(st.problem, s.name, { key: s.key, esc, id: problemId }) : '';
        items.push(`<li class="wallet-option${busy ? ' is-waiting' : ''}" data-source="${esc(s.key)}">${row}${cancel}${problem}</li>`);
    }
    const none = !sources.length;
    const getFirst = none && !onMobile;
    const getRow = () => getFirst
        ? `<li class="wallet-option">${optionRow({ attrs: 'data-action="get"', tile: tileHtml('', esc, { lg: true, icon: 'bx-plus' }), name: 'Get a wallet', sub: 'Install a browser extension. Takes two minutes.', cls: lead === 'get' ? 'is-primary' : '' })}</li>`
        : `<li class="wallet-option">${optionRow({ attrs: 'data-action="get"', tile: tileHtml('', esc, { lg: true, icon: 'bx-plus' }), name: 'No wallet? Get one', cls: 'is-quiet' })}</li>`;
    const showGet = !switching || none;
    if (getFirst && showGet) items.push(getRow());
    if (phone) {
        const paired = !!phone.connected;
        const sub = paired ? `${esc(phone.peer || 'Your phone')} connected` : (onMobile ? 'Nova Wallet or SubWallet, without leaving this page.' : 'Scan a code with Nova Wallet or SubWallet.');
        const name = onMobile && !paired ? 'Wallet app' : 'Phone wallet';
        const action = paired ? accountCount(phone.count || 0) : 'Connect';
        const problemId = phone.problem ? rowId(PHONE_SOURCE) + '-problem' : '';
        const p = phone.problem ? buildOptionProblemHtml(phone.problem, 'Your phone wallet', { key: PHONE_SOURCE, esc, line: phone.problemLine || '', id: problemId }) : '';
        items.push(`<li class="wallet-option" data-source="${PHONE_SOURCE}">${optionRow({ attrs: 'data-action="phone"', tile: tileHtml(PHONE_SOURCE, esc, { lg: true, icon: 'bx-mobile' }), name, sub, action, problemId, cls: lead === PHONE_SOURCE ? 'is-primary' : '' })}${p}</li>`);
    }
    if (onMobile && none) {
        items.push(`<li class="wallet-option">${optionRow({ attrs: 'data-action="apps"', tile: tileHtml('', esc, { lg: true, icon: 'bx-log-in' }), name: 'Open in your wallet app', sub: 'Use the browser inside Nova Wallet or SubWallet.' })}</li>`);
    }
    if (!getFirst && showGet) items.push(getRow());
    return items.join('');
}

// The quiet row under the account list in switch mode.
export const DIFFERENT_WALLET_HTML = `<button type="button" id="wallet-picker-different" class="wallet-option-row is-quiet"><span class="wallet-ext-tile is-lg tile-icon" aria-hidden="true"><i class='bx bx-transfer-alt'></i></span><span class="wallet-option-main"><span class="wallet-option-name">Use a different wallet</span></span>${chevron}</button>`;

// "Don't see your account?", naming the wallet on screen.
export function missingAccountBodyHtml(name, esc = (s) => s) {
    return `<p>Your wallet only shows the accounts you allowed for this site. Allow the account in ${esc(name)}, then refresh.</p>
            ${refreshBtn('Refresh accounts')}`;
}
export function buildMissingAccountHtml() {
    return `<details id="wallet-picker-missing" class="wallet-picker-disclosure" hidden>
        <summary>Don't see your account?</summary>
        <div class="wallet-picker-disclosure-body" id="wallet-picker-missing-body">${missingAccountBodyHtml('your wallet')}</div>
    </details>`;
}

export const SAFETY_LINE = 'Polkadex Explorer never moves funds on its own. Every transaction needs your approval in your wallet.';

// Multisig and View any address. First connect: inside one collapsed "More
// options". Switch mode: the two collapsed lines below a divider, as before,
// because signers come to that screen for them.
function secondaryHtml(switching) {
    const inner = `<div id="wallet-multisig-accounts"></div>
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
            </details>`;
    return switching
        ? `<div id="wallet-picker-more" class="wallet-picker-more is-flat">${inner}</div>`
        : `<details id="wallet-picker-more" class="wallet-picker-disclosure wallet-picker-more"><summary>More options</summary><div class="wallet-picker-disclosure-body">${inner}</div></details>`;
}

// The page skeleton. The X comes first in the markup so it is first in the tab
// order (the stylesheet moves it to the right). The view fills the parts that
// depend on which view is showing; ids the rest of the app relies on are kept.
export function buildPickerShellHtml({ mode, helpHtml, closeHtml, onMobile, mobileCardsHtml, currentUrl, esc }) {
    const switching = mode === 'switch';
    return `<section class="list-container glass wallet-picker${onMobile ? ' is-mobile' : ''}" aria-labelledby="wallet-picker-title" data-mode="${switching ? 'switch' : 'connect'}" data-view="options">
        <div class="list-header wallet-picker-head">${closeHtml || ''}<div class="wallet-picker-titlebox"><h2 id="wallet-picker-title" tabindex="-1">${switching ? 'Switch wallet' : 'Connect wallet'}</h2> ${helpHtml || ''}</div></div>
        <div class="wallet-picker-body">
            <button type="button" id="wallet-picker-back" class="wallet-picker-back" hidden><i class='bx bx-chevron-left' aria-hidden="true"></i>Back</button>
            <p class="wallet-picker-sub" id="wallet-picker-sub"></p>
            <div id="wallet-picker-search-wrap" class="wallet-picker-search" hidden>
                <i class='bx bx-search' aria-hidden="true"></i>
                <input type="search" id="wallet-picker-search" inputmode="search" placeholder="Search by name or address" aria-label="Search by name or address" autocomplete="off" spellcheck="false">
                <button type="button" id="wallet-picker-search-clear" class="wp-icon-btn" aria-label="Clear search" hidden><i class='bx bx-x' aria-hidden="true"></i></button>
            </div>
            <div id="wallet-picker-live" class="sr-only" aria-live="polite"></div>
            <div id="wallet-accounts"></div>
            <ul id="wallet-picker-options" class="wallet-option-list" role="list" aria-labelledby="wallet-picker-sub"></ul>
            <div id="wallet-picker-pairing" hidden></div>
            <div id="wallet-picker-get" hidden></div>
            <p id="wallet-picker-status" class="wallet-picker-status"></p>
            <div id="wallet-picker-different-wrap" class="wallet-picker-different" hidden>${DIFFERENT_WALLET_HTML}</div>
            ${buildMissingAccountHtml()}
            <hr class="wallet-picker-divider"${switching ? '' : ' hidden'}>
            ${secondaryHtml(switching)}
            <details id="wallet-mobile-section" class="wallet-picker-disclosure" hidden>
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
            <p id="wallet-picker-footnote" class="wallet-picker-footnote">${SAFETY_LINE}</p>
        </div>
    </section>`;
}
