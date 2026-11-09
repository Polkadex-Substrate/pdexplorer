// The "Load older" bar under the account Events and Transfers tables: it must say what it is doing,
// say what it did, and help when the table's filters match nothing in the pages loaded so far.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mountAccountLoadOlder, loadedMessage, emptyFilteredMessage, progressMessage, searchAll } from '../lib/account-load-older.js';
import { readRepo, stripComments } from './helpers/source.js';

describe('message wording', () => {
    test('loadedMessage reports the page, the running total and, with filters, the matches', () => {
        assert.equal(loadedMessage({ added: 200, loaded: 600, total: 1462, noun: 'events' }), 'Loaded 200 older events (600 of 1,462)');
        assert.equal(loadedMessage({ added: 600, loaded: 1200, total: 1462, noun: 'events', filtersActive: true, matched: 3 }),
            'Loaded 600 older events (1,200 of 1,462); 3 match your filters');
        assert.equal(loadedMessage({ added: 200, loaded: 400, total: 1462, noun: 'events', filtersActive: true, matched: 1 }),
            'Loaded 200 older events (400 of 1,462); 1 matches your filters');
        assert.equal(loadedMessage({ added: 200, loaded: 400, total: 1462, noun: 'events', filtersActive: true, matched: 0 }),
            'Loaded 200 older events (400 of 1,462); none match your filters');
        assert.equal(loadedMessage({ added: 200, loaded: 400, total: null, noun: 'events' }), 'Loaded 200 older events (400 loaded)');
    });

    test('emptyFilteredMessage says where it looked and what to do next', () => {
        assert.equal(emptyFilteredMessage({ loaded: 600, total: 1462, noun: 'events', complete: false }),
            'No matching events in the 600 loaded; Load older to search further');
        assert.equal(emptyFilteredMessage({ loaded: 1462, total: 1462, noun: 'events', complete: true }),
            'No matching events in all 1,462 events');
    });

    test('progressMessage', () => {
        assert.equal(progressMessage({ loaded: 1200, total: 1462 }), 'Searched 1,200 of 1,462');
        assert.equal(progressMessage({ loaded: 1200, total: null }), 'Searched 1,200');
    });
});

describe('searchAll loop', () => {
    // Pages of one row each; matches are rows with hit:true.
    const pagesOf = hits => hits.map((hit, i) => ({ rows: [{ id: i, hit }], next: i < hits.length - 1 ? `c${i}` : null }));
    const run = (hits, extra = {}, base = 0) => {
        const pages = pagesOf(hits), calls = [], progress = [];
        const fetchPage = async cursor => { calls.push(cursor); return pages[calls.length - 1]; };
        let rows = [];
        const p = searchAll({
            next: 'c-1', fetchPage,
            append: page => { rows = rows.concat(page.rows); },
            countMatches: () => base + rows.filter(r => r.hit).length,
            loaded: () => rows.length,
            onProgress: n => progress.push(n),
            ...extra
        });
        return { p, calls, progress, rows: () => rows };
    };

    test('stops at the first page that adds a match', async () => {
        const r = run([false, false, true, false]);
        assert.equal((await r.p).reason, 'found');
        assert.equal(r.calls.length, 3);
        assert.deepEqual(r.progress, [1, 2, 3]);
    });

    test('stops when history ends with no match', async () => {
        const r = run([false, false]);
        const out = await r.p;
        assert.equal(out.reason, 'end');
        assert.equal(r.calls.length, 2);
        assert.equal(out.next, null);
    });

    test('a match already loaded does not stop the search; only a new one does', async () => {
        const r = run([false, true], {}, 1);
        assert.equal((await r.p).reason, 'found');
        assert.equal(r.calls.length, 2);
    });

    test('cancel stops before the next request and keeps what was loaded', async () => {
        let cancel = false;
        const r = run([false, false, false, false], { isCancelled: () => cancel, onProgress: () => { cancel = true; } });
        const out = await r.p;
        assert.equal(out.reason, 'cancelled');
        assert.equal(r.calls.length, 1);
        assert.equal(r.rows().length, 1);
        assert.equal(out.next, 'c0');
    });

    test('a failed page stops the loop with the error and the cursor to retry from', async () => {
        const boom = new Error('busy');
        let n = 0;
        const out = await searchAll({
            next: 'c-1', fetchPage: async () => { if (n++) throw boom; return { rows: [{}], next: 'c1' }; },
            append: () => {}, countMatches: () => 0, loaded: () => 1, onProgress() {}
        });
        assert.equal(out.reason, 'error');
        assert.equal(out.error, boom);
        assert.equal(out.next, 'c1');
    });
});

// A fake DOM bar. Every selector gives a stable element; the table is a stub with makeTable's filter surface.
function mount({ next = '9:1', total = 600, loadedRows = 200, filters = false, matchFn = r => r.hit, pages = [], noun = 'events' } = {}) {
    const mk = () => {
        const attrs = {}, listeners = {};
        return { textContent: '', innerHTML: '', disabled: false, style: {}, attrs, listeners,
            setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: k => attrs[k], removeAttribute(k) { delete attrs[k]; },
            addEventListener(t, fn) { listeners[t] = fn; } };
    };
    const els = {};
    const ui = { els, urls: [], inFlight: [], el: s => els[s] || (els[s] = mk()) };
    ui.tab = { insertAdjacentHTML(where, html) { ui.inserted = [where, html]; }, querySelector: s => ui.el(s) };
    const rows = Array.from({ length: loadedRows }, (_, i) => ({ id: i, hit: false }));
    ui.table = {
        hooks: null, filters,
        setData(r) { this.rows = r; this.hooks && this.hooks.onRender && this.hooks.onRender(); },
        getInfo() { const all = this.rows || rows; return { matched: filters ? all.filter(matchFn).length : all.length, total: all.length, filtersActive: filters }; },
        setHooks(h) { this.hooks = h; }
    };
    let release = null;
    ui.gate = () => new Promise(res => { release = res; });
    ui.release = () => release && release();
    ui.hold = false;
    const fetchJson = async url => {
        ui.urls.push(url);
        ui.inFlight.push({ disabled: ui.button.disabled, busy: ui.button.attrs['aria-busy'], label: ui.button.textContent });
        if (ui.hold) await ui.gate();
        const page = pages.shift();
        if (page instanceof Error) throw page;
        return page;
    };
    mountAccountLoadOlder(ui.tab, { address: 'es1', list: 'events', noun, table: ui.table, rows, next, total, fetchJson });
    ui.button = ui.el('.js-older-btn');
    ui.status = ui.el('.js-older-status');
    ui.done = ui.el('.js-older-done');
    ui.search = ui.el('.js-older-search');
    ui.error = ui.el('.js-older-error');
    ui.click = () => ui.button.listeners.click();
    ui.searchClick = () => ui.search.listeners.click();
    return ui;
}
const page = (n, next, hit = false) => ({ rows: Array.from({ length: n }, (_, i) => ({ hit: hit && i === 0 })), next });

describe('button states', () => {
    test('idle: enabled, labelled Load older, not busy; the bar has a polite live region', () => {
        const ui = mount();
        assert.equal(ui.button.disabled, false);
        assert.equal(ui.button.textContent, 'Load older');
        assert.equal(ui.button.attrs['aria-busy'], 'false');
        assert.match(ui.inserted[1], /class="js-older-status"[^>]*role="status"/);
        assert.match(ui.inserted[1], /aria-live="polite"/);
    });

    test('loading: disabled, Loading..., aria-busy; a second click while loading sends no request', async () => {
        const ui = mount({ pages: [page(200, '8:1')] });
        ui.hold = true;
        const first = ui.click();
        ui.click();
        assert.equal(ui.urls.length, 1, 'double click made a second request');
        assert.equal(ui.button.disabled, true);
        assert.equal(ui.button.textContent, 'Loading...');
        assert.equal(ui.button.attrs['aria-busy'], 'true');
        ui.release();
        await first;
        assert.equal(ui.button.disabled, false);
        assert.equal(ui.button.textContent, 'Load older');
        assert.equal(ui.button.attrs['aria-busy'], 'false');
    });

    test('error: the message shows inline (escaped), the button becomes Retry, and a retry clears it', async () => {
        const ui = mount({ pages: [new Error('<b>busy</b>'), page(200, '8:1')] });
        await ui.click();
        assert.equal(ui.error.innerHTML, '&lt;b&gt;busy&lt;/b&gt;');
        assert.equal(ui.button.textContent, 'Retry');
        assert.equal(ui.button.disabled, false);
        assert.equal(ui.button.attrs['aria-busy'], 'false');
        await ui.click();
        assert.equal(ui.error.innerHTML, '');
        assert.equal(ui.button.textContent, 'Load older');
        assert.equal(ui.urls.length, 2);
    });

    test('done: the button is replaced by "All N events loaded"', async () => {
        const ui = mount({ total: 400, pages: [page(200, null)] });
        assert.notEqual(ui.done.style.display, 'block');
        await ui.click();
        assert.equal(ui.button.style.display, 'none');
        assert.equal(ui.done.textContent, 'All 400 events loaded');
        assert.notEqual(ui.done.style.display, 'none');
    });

    test('after a page, the status says what arrived and stays until the next action', async () => {
        const ui = mount({ total: 1462, pages: [page(200, '8:1')] });
        await ui.click();
        assert.equal(ui.status.textContent, 'Loaded 200 older events (400 of 1,462)');
    });

    test('with filters active the status includes how many loaded rows match', async () => {
        const ui = mount({ total: 1462, filters: true, pages: [page(200, '8:1', true)] });
        await ui.click();
        assert.equal(ui.status.textContent, 'Loaded 200 older events (400 of 1,462); 1 matches your filters');
    });

    test('transfers use their own noun in the messages', async () => {
        const ui = mount({ noun: 'transfers', total: 1462, pages: [page(200, '8:1')] });
        await ui.click();
        assert.equal(ui.status.textContent, 'Loaded 200 older transfers (400 of 1,462)');
    });
});

describe('filtered empty state and Search all', () => {
    test('the table is given a provider for its filtered-empty text, reflecting what is loaded', () => {
        const ui = mount({ filters: true, loadedRows: 600, total: 1462 });
        assert.equal(ui.table.hooks.filteredEmpty(), 'No matching events in the 600 loaded; Load older to search further');
    });

    test('once everything is loaded the empty text says "in all N events"', async () => {
        const ui = mount({ filters: true, loadedRows: 200, total: 400, pages: [page(200, null)] });
        await ui.click();
        assert.equal(ui.table.hooks.filteredEmpty(), 'No matching events in all 400 events');
    });

    test('Search all is offered only with filters active and older rows to fetch', () => {
        const withFilters = mount({ filters: true });
        withFilters.table.hooks.onRender();
        assert.notEqual(withFilters.search.style.display, 'none');
        const without = mount({ filters: false });
        without.table.hooks.onRender();
        assert.equal(without.search.style.display, 'none');
    });

    test('Search all keeps loading until a page adds a match, showing progress', async () => {
        const ui = mount({ filters: true, total: 1000, pages: [page(200, 'a'), page(200, 'b'), page(200, 'c', true), page(200, 'd')] });
        await ui.searchClick();
        assert.equal(ui.urls.length, 3);
        assert.match(ui.status.textContent, /^Found 1 matching events? after searching 800 of 1,000/);
        assert.equal(ui.button.disabled, false, 'controls come back when it stops');
        assert.equal(ui.search.textContent, 'Search all');
    });

    test('while searching: progress is announced, the search button reads Cancel, Load older is disabled', async () => {
        const ui = mount({ filters: true, total: 1000, pages: [page(200, 'a'), page(200, 'b')] });
        ui.hold = true;
        const run = ui.searchClick();
        assert.equal(ui.search.textContent, 'Cancel');
        assert.equal(ui.button.disabled, true);
        assert.equal(ui.search.attrs['aria-busy'], 'true');
        ui.release();
        await new Promise(r => setImmediate(r));
        assert.equal(ui.status.textContent, 'Searched 400 of 1,000');
        ui.searchClick();                      // cancel while the second request is in flight
        ui.release();
        await run;
        assert.match(ui.status.textContent, /^Search cancelled at 600 of 1,000/);
        assert.equal(ui.urls.length, 2, 'no request after the cancel');
        assert.equal(ui.search.textContent, 'Search all');
        assert.equal(ui.button.disabled, false);
    });

    test('Search all to the end of history reports no match', async () => {
        const ui = mount({ filters: true, total: 600, pages: [page(200, 'a'), page(200, null)] });
        await ui.searchClick();
        assert.equal(ui.status.textContent, 'Searched all 600 events; none match your filters');
        assert.equal(ui.done.textContent, 'All 600 events loaded');
    });

    test('a failed page during Search all shows the error and offers Retry', async () => {
        const ui = mount({ filters: true, total: 1000, pages: [new Error('timeout')] });
        await ui.searchClick();
        assert.equal(ui.error.innerHTML, 'timeout');
        assert.equal(ui.button.textContent, 'Retry');
        assert.equal(ui.search.textContent, 'Search all');
    });
});

describe('wiring in script.js', () => {
    const script = stripComments(readRepo('script.js', import.meta.url));
    test('makeTable exposes getInfo and setHooks and uses the filteredEmpty hook for the empty row', () => {
        assert.match(script, /getInfo\s*\(\)\s*\{/);
        assert.match(script, /setHooks\s*\(/);
        assert.match(script, /hooks\.filteredEmpty/);
        assert.match(script, /hooks\.onRender/);
    });
});
