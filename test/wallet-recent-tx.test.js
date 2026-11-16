// Wallet dashboard "Recent Transactions": 10 rows as before, then a "Load 50 more" bar that pages older rows
// through /api/account/:address/history?limit=50. Spec: cto-team/plans/2026-11-16-wallet-recent-tx-more.md.
// Addresses and hashes here are synthetic.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import * as db from '../db.js';
import { cursorPage, parseCursor } from '../lib/tx-paging.js';
import { FIRST_PAGE, MORE_PAGE, parseHistoryLimit, walletRecentFields, mountWalletRecentTx } from '../lib/wallet-recent-tx.js';
import { API_SECTIONS } from '../lib/api-reference.js';
import { readRepo, stripComments } from './helpers/source.js';

const ME = 'esWalletMe', OTHER = 'esWalletOther';

describe('limit on the history route', () => {
    test('absent means the default; 1 to 50 whole numbers pass', () => {
        assert.deepEqual(parseHistoryLimit(undefined, 200), { limit: 200 });
        assert.deepEqual(parseHistoryLimit('1', 200), { limit: 1 });
        assert.deepEqual(parseHistoryLimit('50', 200), { limit: 50 });
        assert.deepEqual(parseHistoryLimit('10', 200), { limit: 10 });
    });

    test('0, 51, non-numbers, fractions, empty and repeated values are refused, never clamped', () => {
        for (const bad of ['0', '51', '200', '-5', 'abc', '5.5', '1e1', '', ' 5', '0x10', ['5', '6'], { a: 1 }]) {
            const out = parseHistoryLimit(bad, 200);
            assert.equal(out.error, 'limit must be between 1 and 50.', `accepted ${JSON.stringify(bad)}`);
            assert.ok(!('limit' in out));
        }
    });

    test('the page sizes are 10 first and 50 per click', () => {
        assert.equal(FIRST_PAGE, 10);
        assert.equal(MORE_PAGE, 50);
    });
});

describe('wallet payload fields and paging completeness, on a real index', () => {
    const created = [];
    const rowsFor = n => Array.from({ length: n }, (_, i) => ({ hash: `0xw${n}-${i}`, from: i % 2 ? OTHER : ME, to: i % 2 ? ME : OTHER, block: 1000 + Math.floor(i / 3) }));
    after(() => { for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });
    const fresh = rows => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-wallet-recent-'));
        created.push(dir);
        db.initDb(dir, true, { awaitMigrator: false });
        db.insertTransactions(rows);
    };

    test('9 rows: no cursor, total 9', () => {
        fresh(rowsFor(9));
        const f = walletRecentFields(db, ME, null);
        assert.equal(f.recentTransactions.length, 9);
        assert.equal(f.recentTransactionsNext, null);
        assert.equal(f.recentTransactionsTotal, 9);
    });

    test('exactly 10 rows: a cursor is set and the total says there is nothing more', () => {
        fresh(rowsFor(10));
        const f = walletRecentFields(db, ME, null);
        assert.equal(f.recentTransactions.length, 10);
        assert.match(f.recentTransactionsNext, /^\d+:\d+$/);
        assert.equal(f.recentTransactionsTotal, 10);
        assert.ok(f.recentTransactions.every(r => !('rowId' in r)), 'rowId reached the payload');
    });

    test('10 then 50 then 50 then the rest: every row once, newest first, several rows in one block', () => {
        const all = rowsFor(130);
        fresh(all);
        const first = walletRecentFields(db, ME, null);
        assert.equal(first.recentTransactionsTotal, 130);
        const hashes = first.recentTransactions.map(r => r.hash);
        const sizes = [first.recentTransactions.length];
        let cursor = first.recentTransactionsNext;
        while (cursor) {
            const page = cursorPage(db.getTransactionsByAddress(ME, MORE_PAGE, null, parseCursor(cursor)), MORE_PAGE);
            hashes.push(...page.rows.map(r => r.hash));
            sizes.push(page.rows.length);
            cursor = page.next;
        }
        assert.deepEqual(sizes, [10, 50, 50, 20]);
        assert.equal(new Set(hashes).size, 130, 'a row repeated');
        const expected = all.map((r, pos) => ({ r, pos })).sort((a, b) => b.r.block - a.r.block || b.pos - a.pos).map(x => x.r.hash);
        assert.deepEqual(hashes, expected);
    });
});

// ---- the bar, in a happy-dom document with a stub table ----

const win = new Window({ url: 'http://localhost/wallet' });
const doc = win.document;
const tick = () => new Promise(r => setTimeout(r, 0));
const txRow = (n, from = ME) => ({ hash: `0xrow${n}`, from, to: OTHER, block: 5000 - n, timestamp: 1700000000000 + n });
const rows = (from, count) => Array.from({ length: count }, (_, i) => txRow(from + i, (from + i) % 2 ? OTHER : ME));

function stubTable() {
    const t = { rows: [], hooks: null, builtWith: null };
    t.setData = r => { t.rows = r; };
    t.getInfo = () => ({ matched: t.rows.length, total: t.rows.length, filtersActive: false });
    t.setHooks = h => { t.hooks = h; };
    return t;
}

function page(store, over = {}, opts = {}) {
    doc.body.innerHTML = '<div class="list-container"><div class="list-header"></div><div id="wallet-recent-tx-table"></div></div>';
    const container = doc.getElementById('wallet-recent-tx-table');
    const ui = { urls: [], table: null, container, card: container.parentElement, pending: [] };
    const data = { address: ME, recentTransactions: rows(0, 10), recentTransactionsNext: '4991:10', recentTransactionsTotal: 1462, ...over };
    ui.fetchJson = opts.fetchJson || (async url => {
        ui.urls.push(url);
        ui.disabledDuring = ui.btn && ui.btn.disabled;
        ui.busyText = ui.btn && ui.btn.textContent;
        ui.busyAttr = ui.btn && ui.btn.getAttribute('aria-busy');
        const next = ui.queue.shift();
        if (next instanceof Error) throw next;
        return next;
    });
    ui.queue = opts.queue || [];
    ui.out = mountWalletRecentTx({
        container, data, store, live: opts.live !== false,
        buildTable: r => (ui.table = Object.assign(stubTable(), { rows: r }), ui.table),
        fetchJson: ui.fetchJson, isCurrent: opts.isCurrent || (() => true)
    });
    const q = s => ui.card.querySelector(s);
    Object.defineProperties(ui, {
        bar: { get: () => q('.js-older-bar') }, btn: { get: () => q('.js-older-btn') }, count: { get: () => q('.js-older-count') },
        status: { get: () => q('.js-older-status') }, error: { get: () => q('.js-older-error') }, done: { get: () => q('.js-older-done') }
    });
    return ui;
}
const newStore = () => ({ address: null, rows: [], next: null });
const more = (from, count, next) => ({ rows: rows(from, count), next });

describe('Load 50 more bar', () => {
    test('idle: count, label, real button wired to the table, status regions', () => {
        const ui = page(newStore());
        assert.equal(ui.btn.tagName, 'BUTTON');
        assert.equal(ui.btn.getAttribute('type'), 'button');
        assert.equal(ui.btn.textContent, 'Load 50 more');
        assert.equal(ui.btn.getAttribute('aria-controls'), 'wallet-recent-tx-table');
        assert.equal(ui.count.textContent, 'Showing 10 of 1,462 transactions');
        assert.equal(ui.status.getAttribute('role'), 'status');
        assert.equal(ui.status.getAttribute('aria-live'), 'polite');
        assert.equal(ui.error.getAttribute('role'), 'alert');
        assert.equal(ui.table.rows.length, 10);
        assert.ok(ui.card.contains(ui.bar) && ui.bar.previousElementSibling === ui.container, 'the bar sits directly under the table');
    });

    test('a click loads 50 older rows with limit=50, tags direction, and says what it did', async () => {
        const ui = page(newStore(), {}, { queue: [more(10, 50, '4941:60')] });
        ui.btn.focus();
        ui.btn.click();
        await tick();
        assert.deepEqual(ui.urls, [`/api/account/${ME}/history?list=transactions&before=4991%3A10&limit=50`]);
        assert.deepEqual([ui.disabledDuring, ui.busyText, ui.busyAttr], [true, 'Loading...', 'true'], 'button state at request time');
        assert.equal(ui.table.rows.length, 60);
        assert.ok(ui.table.rows.every(r => r.direction === (r.from === ME ? 'Sent' : 'Received')), 'direction missing on a row');
        assert.equal(ui.table.rows[59].direction, 'Received');
        assert.equal(ui.count.textContent, 'Showing 60 of 1,462 transactions');
        assert.equal(ui.status.textContent, 'Loaded 50 older transactions (60 of 1,462)');
        assert.equal(ui.btn.textContent, 'Load 50 more');
        assert.equal(ui.btn.disabled, false);
        assert.equal(doc.activeElement, ui.btn, 'focus must stay on the button so Enter can be pressed again');
    });

    test('while a page is in flight the button reads Loading..., is disabled and aria-busy', async () => {
        let release;
        const ui = page(newStore(), {}, { fetchJson: () => new Promise(r => { release = r; }) });
        ui.btn.click();
        await tick();
        assert.equal(ui.btn.textContent, 'Loading...');
        assert.equal(ui.btn.disabled, true);
        assert.equal(ui.btn.getAttribute('aria-busy'), 'true');
        release(more(10, 50, '4941:60'));
        await tick();
        assert.equal(ui.btn.getAttribute('aria-busy'), 'false');
    });

    test('the last page hides the button, shows the end line with a link to the account page, and takes focus', async () => {
        const ui = page(newStore(), { recentTransactionsTotal: 62 }, { queue: [more(10, 50, '4941:60'), more(60, 2, null)] });
        ui.btn.focus();
        ui.btn.click(); await tick();
        ui.btn.click(); await tick();
        assert.equal(ui.status.textContent, 'Loaded 2 older transactions (62 of 62)');
        assert.equal(ui.btn.style.display, 'none');
        assert.match(ui.done.textContent, /^All 62 transactions loaded\b/);
        assert.equal(ui.done.getAttribute('tabindex'), '-1');
        const link = ui.done.querySelector('a');
        assert.equal(link.textContent, 'View all on the account page');
        assert.equal(link.getAttribute('href'), `/account/${ME}`);
        assert.equal(doc.activeElement, ui.done, 'focus must not drop to the top of the page');
    });

    test('an error keeps the rows, shows red alert text and Retry; the retry works', async () => {
        const ui = page(newStore(), {}, { queue: [new Error('boom'), more(10, 50, '4941:60')] });
        ui.btn.click(); await tick();
        assert.equal(ui.error.textContent, 'Could not load older transactions. Check your connection and retry.');
        assert.equal(ui.btn.textContent, 'Retry');
        assert.equal(ui.btn.disabled, false);
        assert.equal(ui.table.rows.length, 10);
        ui.btn.click(); await tick();
        assert.equal(ui.error.textContent, '');
        assert.equal(ui.table.rows.length, 60);
        assert.equal(ui.btn.textContent, 'Load 50 more');
    });

    test('the stuck-page guard still stops a page that repeats its cursor', async () => {
        const ui = page(newStore(), {}, { queue: [more(10, 50, '4991:10')] });
        ui.btn.click(); await tick();
        assert.equal(ui.table.rows.length, 10);
        assert.equal(ui.error.textContent, 'Could not load older transactions. Check your connection and retry.');
        assert.equal(ui.btn.textContent, 'Retry');
    });

    test('no bar at 10 or fewer in total, for an empty wallet, or on the cache paint', () => {
        assert.equal(page(newStore(), { recentTransactionsTotal: 10 }).bar, null);
        assert.equal(page(newStore(), { recentTransactions: rows(0, 7), recentTransactionsNext: null, recentTransactionsTotal: 7 }).bar, null);
        assert.equal(page(newStore(), { recentTransactions: [], recentTransactionsNext: null, recentTransactionsTotal: 0 }).bar, null);
        const cachePaint = page(newStore(), {}, { live: false });
        assert.equal(cachePaint.bar, null);
        assert.equal(cachePaint.table.rows.length, 10, 'the cache paint still shows the 10 rows');
    });

    test('an old payload without the new fields shows 10 rows and no bar', () => {
        const ui = page(newStore(), { recentTransactionsNext: undefined, recentTransactionsTotal: undefined });
        assert.equal(ui.bar, null);
        assert.equal(ui.table.rows.length, 10);
    });

    test('a direction filter that matches nothing words the table by how much was searched', () => {
        const ui = page(newStore());
        assert.equal(ui.table.hooks.filteredEmpty(), 'No matching transactions in the 10 loaded; Load 50 more to search further');
    });
});

describe('loaded rows survive a dashboard re-render', () => {
    test('a second render re-seeds the table and the bar from the store and carries on from its cursor', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const second = page(store, {}, { queue: [more(60, 50, '4891:110')] });
        assert.equal(second.table.rows.length, 60);
        assert.equal(second.count.textContent, 'Showing 60 of 1,462 transactions');
        second.btn.click(); await tick();
        assert.deepEqual(second.urls, [`/api/account/${ME}/history?list=transactions&before=4941%3A60&limit=50`]);
        assert.equal(second.table.rows.length, 110);
        assert.equal(new Set(second.table.rows.map(r => r.hash)).size, 110);
    });

    test('a refresh that brings a new transaction shows it once at the top, with nothing repeated', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const newest = { hash: '0xnewest', from: ME, to: OTHER, block: 6000, timestamp: 1800000000000 };
        const second = page(store, { recentTransactions: [newest, ...rows(0, 9)], recentTransactionsTotal: 1463 });
        const hashes = second.table.rows.map(r => r.hash);
        assert.equal(hashes.length, 61);
        assert.equal(hashes[0], '0xnewest');
        assert.equal(new Set(hashes).size, 61);
        assert.equal(second.count.textContent, 'Showing 61 of 1,463 transactions');
    });

    test('another wallet drops the loaded pages', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const other = page(store, { address: OTHER, recentTransactions: rows(200, 10), recentTransactionsNext: '1:1', recentTransactionsTotal: 99 });
        assert.equal(other.table.rows.length, 10);
        assert.equal(other.count.textContent, 'Showing 10 of 99 transactions');
        assert.equal(store.address, OTHER);
    });

    test('the cache paint shows the loaded rows too (no ten-row flash) but never writes the store or mounts a bar', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const painted = page(store, {}, { live: false });
        assert.equal(painted.table.rows.length, 60);
        assert.equal(new Set(painted.table.rows.map(r => r.hash)).size, 60);
        assert.equal(painted.bar, null);
        assert.equal(store.rows.length, 60);
        assert.equal(store.next, '4941:60');
    });

    test('the cache paint of another wallet shows only its own ten rows and leaves the store alone', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const other = page(store, { address: OTHER, recentTransactions: rows(200, 10) }, { live: false });
        assert.equal(other.table.rows.length, 10);
        assert.equal(store.address, ME);
        assert.equal(store.rows.length, 60);
    });

    test('more than ten new transactions between renders: no overlap, so the loaded rows and cursor reset instead of leaving a gap', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const jumped = page(store, { recentTransactions: rows(500, 10), recentTransactionsNext: '4491:510', recentTransactionsTotal: 1475 },
            { queue: [more(510, 50, '4441:560')] });
        assert.equal(jumped.table.rows.length, 10);
        assert.equal(jumped.count.textContent, 'Showing 10 of 1,475 transactions');
        assert.equal(store.rows.length, 10);
        assert.equal(store.next, '4491:510');
        assert.equal(jumped.btn.textContent, 'Load 50 more');
        jumped.btn.click(); await tick();
        assert.deepEqual(jumped.urls, [`/api/account/${ME}/history?list=transactions&before=4491%3A510&limit=50`]);
        assert.equal(jumped.table.rows.length, 60);
    });

    test('the cache paint with no overlap shows only the cached ten', async () => {
        const store = newStore();
        const first = page(store, {}, { queue: [more(10, 50, '4941:60')] });
        first.btn.click(); await tick();
        const painted = page(store, { recentTransactions: rows(500, 10) }, { live: false });
        assert.equal(painted.table.rows.length, 10);
        assert.equal(store.rows.length, 60);
    });
});

describe('a page that lands after the user left is dropped', () => {
    test('navigating away mid-request never appends or stores the rows', async () => {
        let current = true, release;
        const store = newStore();
        const ui = page(store, {}, { isCurrent: () => current, fetchJson: () => new Promise(r => { release = r; }) });
        ui.btn.click(); await tick();
        current = false;
        release(more(10, 50, '4941:60'));
        await tick();
        assert.equal(ui.table.rows.length, 10);
        assert.equal(store.rows.length, 10);
    });

    test('a detached bar (the card was rebuilt) drops its page', async () => {
        let release;
        const store = newStore();
        const ui = page(store, {}, { fetchJson: () => new Promise(r => { release = r; }) });
        const table = ui.table;
        ui.btn.click(); await tick();
        ui.card.remove();
        release(more(10, 50, '4941:60'));
        await tick();
        assert.equal(table.rows.length, 10);
        assert.equal(store.rows.length, 10);
    });
});

describe('brand audit: neutral pager, plain links (cto-team/plans/2026-11-16-brand-audit-open-ui.md R1, R2)', () => {
    const loader = stripComments(readRepo('lib/account-load-older.js', import.meta.url));
    const css = readRepo('styles.css', import.meta.url);
    const rule = sel => { const i = css.indexOf(sel + ' {'); assert.ok(i !== -1, sel); return css.slice(i, css.indexOf('}', i)); };

    test('the bar carries no inline button style, Primary outline or off-token tint', () => {
        assert.ok(!/BUTTON_STYLE/.test(loader));
        assert.ok(!/rgba\(229/.test(loader));
        assert.ok(!/brand-primary/.test(loader));
        assert.ok(!/brand-secondary/.test(loader));
    });

    test('the buttons are the neutral secondary style in styles.css', () => {
        const base = rule('.js-older-btn, .js-older-search');
        assert.match(base, /border: 1px solid var\(--border-color\)/);
        assert.match(base, /background: rgba\(255, 255, 255, 0\.05\)/);
        assert.match(base, /color: var\(--text-primary\)/);
        assert.ok(!/brand-primary|229/.test(base));
        assert.match(rule('.js-older-btn:hover, .js-older-search:hover'), /border-color: var\(--border-hover\)/);
    });

    test('Search all stays hidden until needed, and the rendered buttons have no style attribute colours', () => {
        const store = newStore();
        const ui = page(store);
        assert.equal(ui.btn.getAttribute('style'), null);
        const search = ui.card.querySelector('.js-older-search');
        assert.match(search.getAttribute('style') || '', /display: none/);
        assert.ok(!/color|border|background/.test(search.getAttribute('style') || ''));
    });

    test('both View all links use the inline link class, not green', async () => {
        const store = newStore();
        const ui = page(store, {}, { queue: [more(10, 52, null)] });
        ui.btn.click(); await tick();
        const link = ui.done.querySelector('a');
        assert.equal(link.getAttribute('class'), 'item-link is-inline');
        assert.equal(link.getAttribute('style'), null);
        const script = readRepo('script.js', import.meta.url);
        const header = script.split('\n').find(l => l.includes('View all on the account page'));
        assert.match(header, /class="item-link is-inline"/);
        assert.ok(!/brand-secondary/.test(header));
        assert.match(rule('.item-link.is-inline'), /text-decoration: underline/);
    });
});

describe('server and script wiring', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    const route = p => { const i = server.indexOf(`app.get('${p}'`); assert.ok(i !== -1, p); return server.slice(i, server.indexOf('\n});', i)); };

    test('the wallet route adds the cursor and total fields and stays no-store', () => {
        const body = route('/api/wallet/:address');
        assert.match(body, /walletRecentFields\(db, address, raw\)/);
        assert.ok(!/recentTransactions: withoutRowId/.test(body));
        assert.match(body, /no-store/);
        assert.ok(!/cacheShort\(res\)|cacheMedium\(res\)|cacheLong\(res\)/.test(body));
    });

    test('the history route validates limit and uses it for both the query and the cursor', () => {
        const body = route('/api/account/:address/history');
        assert.match(body, /parseHistoryLimit\(req\.query\.limit, ACCOUNT_PAGE\)/);
        assert.match(body, /res\.status\(400\)/);
        assert.match(body, /ACCOUNT_LISTS\[list\]\(acct, cursor, limit\)/);
        assert.match(body, /cursorPage\([^;]*, limit\)/);
        assert.match(body, /cacheShort\(res\);\s*res\.json\(/);
        assert.match(server, /transactions: \(acct, before, limit\) => db\.getTransactionsByAddress\(acct\.address, limit, acct\.raw, before\)/);
    });

    test('renderWalletDashboard mounts the shared bar once per live render, keeps the store outside, and renames the link', () => {
        const i = script.indexOf('function renderWalletDashboard(');
        const body = script.slice(i, script.indexOf('\nfunction ', i + 10));
        assert.match(body, /mountWalletRecentTx\(/);
        assert.match(body, /store: walletRecentStore/);
        assert.match(body, /View all on the account page/);
        assert.ok(!/>View account</.test(body));
        assert.match(script, /^const walletRecentStore = /m);
        assert.match(script, /renderWalletDashboard\(cached\.wallet, [^;]*\{ live: false \}\)/);
        assert.match(script, /renderWalletDashboard\(latestWallet, latestPrice, latestRewards, \{ live: true \}\)/);
        assert.ok(!/intentional top-~10 snapshots/.test(readRepo('script.js', import.meta.url).split('wallet recent-rewards')[1] || ''), 'stale comment about the tx table being a top 10 snapshot');
    });

    test('script.js stays under its ceiling', () => {
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });

    test('docs: api-reference, README and llms.txt describe limit and the new wallet fields', () => {
        const flat = JSON.stringify(API_SECTIONS);
        assert.match(flat, /history\?list=transactions\|events&before=<block>:<rowId>&limit=1\.\.50/);
        assert.match(flat, /recentTransactionsNext/);
        for (const file of ['README.md', 'public/llms.txt']) {
            const text = readRepo(file, import.meta.url);
            assert.match(text, /limit=1\.\.50/, file);
            assert.match(text, /recentTransactionsNext/, file);
            assert.match(text, /recentTransactionsTotal/, file);
        }
    });
});
