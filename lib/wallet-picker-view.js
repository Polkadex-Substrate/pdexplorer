// The Switch wallet / Connect wallet page (/wallet?switch=1 and /wallet).
//
// One renderer for two moments, which used to print the copy for both at once.
// Now the account list is the page: a title, one line, the list (current
// account once, as a Current row with Disconnect), three collapsed lines and
// one safety footnote. Spec: cto-team/plans/2026-11-11-switch-wallet-redesign.md.
//
// Everything the page needs from the app comes in through `deps`, so the page
// runs in a happy-dom document under node --test:
//   current, currentSource, onMobile, hash
//   getAccounts()       null: no wallet in this browser; []: none shared
//   select(address, source), disconnect()
//   isSame, isValid, esc, shortAddr
//   helpHtml, closeHtml, mobileCardsHtml, currentUrl, clipboard
//   mountMultisig(el, { compact, open })
//   slowMs              when "Looking for wallets..." becomes the popup hint

import { buildPickerShellHtml, buildAccountListHtml, buildEmptyStateHtml, buildCreateWalletLineHtml, filterAccounts, EMPTY_HEADINGS, SEARCH_THRESHOLD } from './wallet-picker.js';

const LOOKING = 'Looking for wallets...';
const SLOW = 'Waiting for your wallet. Check for a popup from your wallet extension.';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function mountWalletPicker(root, deps) {
    const { current = '', currentSource = '', onMobile = false, hash = '', getAccounts, select, disconnect,
        isSame, isValid, esc, shortAddr, clipboard, slowMs = 3000 } = deps;
    root.innerHTML = buildPickerShellHtml({
        mode: current ? 'switch' : 'connect', helpHtml: deps.helpHtml, closeHtml: deps.closeHtml,
        onMobile, mobileCardsHtml: deps.mobileCardsHtml, currentUrl: deps.currentUrl, esc
    });
    const $ = (id) => root.querySelector('#' + id);
    const section = root.querySelector('section.wallet-picker');
    const listEl = $('wallet-accounts'), status = $('wallet-picker-status'), live = $('wallet-picker-live');
    const refresh = $('wallet-picker-refresh'), countLabel = $('wallet-picker-count-label');
    const searchWrap = $('wallet-picker-search-wrap'), search = $('wallet-picker-search'), searchClear = $('wallet-picker-search-clear');
    const missing = $('wallet-picker-missing'), phone = $('wallet-mobile-section'), view = $('wallet-picker-view'), footnote = $('wallet-picker-footnote');

    let accounts;            // undefined until the first answer
    let loading = null;      // the in-flight load, so ready / idle can wait on it

    // ── the list ──
    function paint() {
        const query = search.value;
        if (accounts === undefined) return;
        const total = accounts ? accounts.length : 0;
        const many = total > SEARCH_THRESHOLD;
        countLabel.textContent = many ? `Your accounts (${total})` : 'Your accounts';
        searchWrap.hidden = !many;
        searchClear.hidden = !query;
        const q = many ? query : '';
        let html = buildAccountListHtml({ accounts, current, currentSource, isSame, esc, shortAddr, query: q });
        if (accounts === null) html += buildEmptyStateHtml('none', { onMobile }).replace(/<\/div>$/, (current ? buildCreateWalletLineHtml() : '') + '</div>');
        else if (!total) html += buildEmptyStateHtml('zero');
        else if (q.trim() && !filterAccounts(accounts, q, isSame).length) {
            html += `<p class="wallet-picker-nomatch">No account matches "${esc(q.trim())}". <button type="button" class="wallet-picker-clear-link">Clear search</button></p>`;
        }
        listEl.innerHTML = html;
        if (q.trim()) live.textContent = plural(filterAccounts(accounts, q, isSame).length, 'account matches', 'accounts match');
    }

    // ── the states around the list ──
    function settleStates() {
        const none = accounts === null, zero = !!accounts && !accounts.length;
        missing.hidden = none || zero;          // the empty states already say it
        footnote.hidden = none;                 // nothing to approve yet
        phone.hidden = !(onMobile || none);
        phone.open = onMobile && none;
        if (none) view.open = true;             // the one thing the user can do right now
    }

    function setBusy(busy) {
        refresh.disabled = busy;
        refresh.setAttribute('aria-busy', busy ? 'true' : 'false');
        refresh.classList.toggle('is-spinning', busy);
    }

    async function load() {
        setBusy(true);
        status.textContent = LOOKING;
        live.textContent = LOOKING;
        // Rows stay on screen during a refresh; skeletons only before the first answer.
        if (accounts === undefined) {
            listEl.innerHTML = buildAccountListHtml({ accounts: [], current, currentSource, isSame, esc, shortAddr })
                + '<div class="wallet-skel-account" aria-hidden="true"></div><div class="wallet-skel-account" aria-hidden="true"></div>';
        }
        const slow = setTimeout(() => { if (status.textContent === LOOKING) status.textContent = SLOW; }, slowMs);
        let result;
        try { result = await getAccounts(); } catch (e) { result = []; }
        clearTimeout(slow);
        if (!root.contains(section)) return;     // re-rendered away meanwhile
        accounts = result === null ? null : (result || []);
        status.textContent = '';
        setBusy(false);
        settleStates();
        paint();
        live.textContent = accounts === null ? EMPTY_HEADINGS.none : !accounts.length ? EMPTY_HEADINGS.zero : plural(accounts.length, 'account found.', 'accounts found.');
    }
    function reload() {
        if (loading) return loading;
        loading = load().finally(() => { loading = null; });
        return loading;
    }

    // ── events, delegated so a repaint never loses them. On the section, not
    // the persistent root, so a re-render drops them with the old page. ──
    section.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        const row = t.closest('.wallet-account-btn[data-address]');
        if (row && listEl.contains(row)) { select(row.getAttribute('data-address'), row.getAttribute('data-source') || ''); return; }
        if (t.closest('#wallet-picker-disconnect')) {
            disconnect();
            // The page re-renders as first connect; put focus on its title.
            const title = root.querySelector('#wallet-picker-title');
            if (title && title.focus) title.focus();
            return;
        }
        if (t.closest('#wallet-picker-refresh') || t.closest('.wallet-picker-refresh-btn')) { reload(); return; }
        if (t.closest('.wallet-picker-clear-link') || t.closest('#wallet-picker-search-clear')) { clearSearch(); return; }
    });
    function clearSearch() {
        search.value = '';
        paint();
        live.textContent = '';
        if (search.focus && !searchWrap.hidden) search.focus();
    }
    search.addEventListener('input', paint);
    // Escape clears the search first, and only closes the page on a second
    // press. An open "(?)" popover handles its own Escape before this.
    section.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (search.value) { e.preventDefault(); clearSearch(); return; }
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' && e.target !== search && e.target.value) return;   // let a typed address be
        const close = root.querySelector('.close-control');
        if (close) { e.preventDefault(); close.click(); }
    });

    // ── View any address ──
    const manualInput = $('wallet-manual-input'), manualErr = $('wallet-manual-error');
    const submitManual = () => {
        const a = (manualInput.value || '').trim();
        if (!isValid(a)) {
            manualErr.textContent = 'That does not look like a valid Polkadex address.';
            manualErr.style.display = 'block';
            return;
        }
        select(a, '');
    };
    $('wallet-manual-btn').addEventListener('click', submitManual);
    manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitManual(); });

    // ── Copy link (phone section); falls back to selecting the text ──
    const copyBtn = $('wallet-copy-btn'), copyInput = $('wallet-copy-url');
    copyBtn.addEventListener('click', async () => {
        try {
            await clipboard.writeText(copyInput.value);
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
        } catch (e) { copyInput.select(); }
    });

    // ── Multisig: collapsed under the list, open only for #multisig ──
    if (deps.mountMultisig) deps.mountMultisig($('wallet-multisig-accounts'), { compact: true, open: hash === '#multisig' });

    const ready = reload();
    return { ready, idle: () => loading || Promise.resolve(), reload, root };
}
