// The "Load older" bar under the account page's Events and Transfers tables.
//
// The old bar disabled the button for the length of a request and said nothing else, so with a filter set
// (say section "staking", method "Unlocked") the table kept reading "no rows match" while 200 rows quietly
// arrived and none of them matched. This bar says when it is working (disabled, "Loading...", aria-busy),
// says what it did in a live region that stays put ("Loaded 200 older events (400 of 1,462); 3 match your
// filters"), words the filtered-empty table text by how much was actually searched, and offers "Search all":
// keep loading pages until one adds a match, history ends, the user cancels or a page fails.
//
// The filters live in the table (script.js makeTable), which exposes getInfo() and setHooks().
// The address-independent pieces (messages, searchAll) are pure so node can test them.

import { escapeHtml } from './html-escape.js';

const n = v => Number(v).toLocaleString();
const ofTotal = (loaded, total) => total != null ? `${n(loaded)} of ${n(total)}` : n(loaded);
// "1 event", "2 events": the nouns are plain English plurals ("events", "transfers").
const one = (count, noun) => Number(count) === 1 ? noun.replace(/s$/, '') : noun;
const matches = (count, noun) => count === 0 ? 'none match your filters' : count === 1 ? '1 matches your filters' : `${n(count)} match your filters`;

// "Loaded 200 older events (400 of 1,462); 3 match your filters" (the clause only while filters are set).
export function loadedMessage({ added, loaded, total, noun, filtersActive = false, matched = 0 }) {
    const base = `Loaded ${n(added)} older ${one(added, noun)} (${total != null ? ofTotal(loaded, total) : `${n(loaded)} loaded`})`;
    return filtersActive ? `${base}; ${matches(matched, noun)}` : base;
}

// The table's text when filters leave no row: how far it looked, and what to do about it.
export function emptyFilteredMessage({ loaded, total, noun, complete }) {
    return complete ? `No matching ${noun} in all ${n(total ?? loaded)} ${one(total ?? loaded, noun)}` : `No matching ${noun} in the ${n(loaded)} loaded; Load older to search further`;
}

export function progressMessage({ loaded, total }) {
    return `Searched ${ofTotal(loaded, total)}`;
}

// Fetch pages from `next` until one adds a matching row.
//   fetchPage(cursor) -> { rows, next }      append(page) adds it to the caller's rows and table
//   countMatches() / loaded()                the caller's current numbers      onProgress(loaded)
//   isCancelled()                            checked after each page, so a page already in flight is kept
//   isStale()                                checked when each page lands: the user left the account, so the page
//                                            is dropped (never appended) and the loop stops
// Resolves { reason: 'found' | 'end' | 'cancelled' | 'stale' | 'error', next, error? }; `next` is where to resume.
export async function searchAll({ next, fetchPage, append, countMatches, loaded, onProgress = () => {}, isCancelled = () => false, isStale = () => false }) {
    const start = countMatches();
    while (next) {
        let page;
        try { page = await fetchPage(next); } catch (error) { return isStale() ? { reason: 'stale', next } : { reason: 'error', next, error }; }
        if (isStale()) return { reason: 'stale', next };
        append(page);
        next = page.next;
        onProgress(loaded());
        if (countMatches() > start) return { reason: 'found', next };
        if (!next) return { reason: 'end', next };
        if (isCancelled()) return { reason: 'cancelled', next };
    }
    return { reason: 'end', next };
}

const BUTTON_STYLE = 'padding: 10px 20px; color: var(--text-primary); border: 1px solid var(--brand-primary); background: rgba(229,0,122,0.1); border-radius: var(--radius-sm); cursor: pointer; transition: var(--transition-fast);';

// Appends /api/account/:address/history pages until next is null. Browser only (touches the tab element).
// `fetchJson` is script.js's fetchApiJson; `table` is a makeTable instance.
// `isCurrent()` says whether the page that mounted this bar is still the one on screen (script.js compares a
// route generation). A page that lands after the bar is detached or no longer current is dropped, so a slow
// request never renders into, or keeps fetching for, an account the user has left.
export function mountAccountLoadOlder(tab, { address, list, noun = list, table, rows, next, total, fetchJson, isCurrent = () => true }) {
    if (!tab || !next) return;
    tab.insertAdjacentHTML('beforeend', `<div class="js-older-bar" style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; align-items: center; padding: 20px;">
        <span class="js-older-count" style="color: var(--text-secondary); font-size: 13px;"></span>
        <button type="button" class="glass js-older-btn" style="${BUTTON_STYLE}">Load older</button>
        <button type="button" class="glass js-older-search" style="${BUTTON_STYLE} display: none;">Search all</button>
        <span class="js-older-done" style="display: none; color: var(--text-secondary); font-size: 13px;"></span>
        <span class="js-older-error" role="alert" style="color: var(--error); font-size: 13px;"></span>
        <span class="js-older-status" role="status" aria-live="polite" style="flex-basis: 100%; text-align: center; color: var(--text-secondary); font-size: 13px;"></span></div>`);
    const [count, button, search, done, error, status] = ['count', 'btn', 'search', 'done', 'error', 'status'].map(k => tab.querySelector(`.js-older-${k}`));
    let busy = false, cancelled = false, searching = false;
    const stale = () => tab.isConnected === false || !isCurrent();

    const info = () => table.getInfo ? table.getInfo() : { matched: rows.length, filtersActive: false };
    const setBusy = on => {
        busy = on;
        button.disabled = on;
        button.setAttribute('aria-busy', on ? 'true' : 'false');
        button.textContent = on ? 'Loading...' : 'Load older';
        search.setAttribute('aria-busy', searching ? 'true' : 'false');
    };
    const showCount = () => { count.textContent = `Showing ${rows.length.toLocaleString()}` + (total != null ? ` of ${total.toLocaleString()} ${one(total, noun)}` : ''); };
    const showSearch = () => { search.style.display = searching || (next && info().filtersActive) ? 'inline-block' : 'none'; };
    const finishIfDone = () => {
        if (next) return;
        button.style.display = 'none';
        search.style.display = 'none';
        done.textContent = `All ${total != null ? n(total) + ' ' : ''}${total != null ? one(total, noun) : noun} loaded`;
        done.style.display = 'inline';
    };
    const fail = e => {
        error.innerHTML = escapeHtml(e.message);
        button.textContent = 'Retry';
    };
    // One fetch + append, shared by the button and Search all. Throws on failure, leaving rows and next alone.
    const fetchPage = async cursor => fetchJson(`/api/account/${encodeURIComponent(address)}/history?list=${encodeURIComponent(list)}&before=${encodeURIComponent(cursor)}`);
    const append = page => {
        rows = rows.concat(page.rows);
        next = page.next;
        table.setData(rows);
        showCount();
    };

    if (table.setHooks) table.setHooks({
        filteredEmpty: () => emptyFilteredMessage({ loaded: rows.length, total, noun, complete: !next }),
        onRender: showSearch
    });

    button.addEventListener('click', async () => {
        if (busy) return;
        setBusy(true);
        error.innerHTML = '';
        try {
            const before = rows.length;
            const page = await fetchPage(next);
            if (stale()) return;
            append(page);
            const { matched, filtersActive } = info();
            status.textContent = loadedMessage({ added: rows.length - before, loaded: rows.length, total, noun, filtersActive, matched });
            setBusy(false);
            finishIfDone();
        } catch (e) { if (stale()) return; setBusy(false); fail(e); }
        showSearch();
    });

    search.addEventListener('click', async () => {
        if (searching) { cancelled = true; return; }
        if (busy) return;
        searching = true;
        cancelled = false;
        error.innerHTML = '';
        search.textContent = 'Cancel';
        setBusy(true);
        const out = await searchAll({
            next, fetchPage, append,
            countMatches: () => info().matched,
            loaded: () => rows.length,
            onProgress: loaded => { status.textContent = progressMessage({ loaded, total }); },
            isCancelled: () => cancelled || stale(),
            isStale: stale
        });
        searching = false;
        if (out.reason === 'stale' || stale()) return;
        search.textContent = 'Search all';
        setBusy(false);
        const { matched } = info();
        if (out.reason === 'found') status.textContent = `Found ${n(matched)} matching ${one(matched, noun)} after searching ${ofTotal(rows.length, total)}`;
        else if (out.reason === 'end') status.textContent = `Searched all ${n(rows.length)} ${one(rows.length, noun)}; ${matches(matched, noun)}`;
        else if (out.reason === 'cancelled') status.textContent = `Search cancelled at ${ofTotal(rows.length, total)}`;
        else fail(out.error);
        finishIfDone();
        showSearch();
    });

    showCount();
    setBusy(false);
}
