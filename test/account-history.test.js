// The account page stopped at the newest 200 rows. These pin the paging that reaches the rest:
// keyset pages over the per-address queries, the cursor helpers, and the Load older wiring.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../db.js';
import { cursorPage, parseCursor } from '../lib/tx-paging.js';
import { mountAccountLoadOlder } from '../lib/account-transfers.js';
import { CACHE_TIERS } from '../lib/api-reference.js';
import { readRepo, stripComments } from './helpers/source.js';

const ME = 'esMe', ALT = '5Me', OTHER = 'esOther';

// 23 rows for ME in unsorted blocks with repeats, so page edges land inside a block.
const BLOCKS = [104, 100, 102, 100, 107, 100, 103, 102, 100, 109, 101, 100, 105, 104, 100, 106, 102, 108, 100, 103, 104, 101, 110];
const txAll = [], evAll = [];
BLOCKS.forEach((block, i) => {
    // ME sends on even i and receives on odd; i = 5 is a self-transfer, still one row.
    txAll.push({ hash: `0xme${i}`, from: i % 2 && i !== 5 ? OTHER : ME, to: i % 2 ? ME : OTHER, block });
    evAll.push({ hash: `ev-me-${i}`, block, eventIndex: i, section: 'balances', method: 'Transfer', signerAddress: ME });
    // Other accounts' rows interleave the rowids; three carry ME's raw spelling (F-080).
    if (i % 3 === 0) {
        txAll.push({ hash: `0xother${i}`, from: OTHER, to: 'esThird', block });
        evAll.push({ hash: `ev-other-${i}`, block, eventIndex: 100 + i, section: 'balances', method: 'Transfer', signerAddress: OTHER });
    }
    if (i % 8 === 0) txAll.push({ hash: `0xalt${i}`, from: ALT, to: OTHER, block });
});

// What every walk must return: matching rows newest first, later inserts first inside a block (rowid order).
const expected = (all, match) => all.map((row, pos) => ({ row, pos })).filter(x => match(x.row))
    .sort((a, b) => b.row.block - a.row.block || b.pos - a.pos).map(x => x.row.hash);
const touches = (...addrs) => t => addrs.includes(t.from) || addrs.includes(t.to);

// Follow next cursors from the newest page down, as Load older does; returns hashes and page sizes.
function walk(fetchPage, limit) {
    const hashes = [], sizes = [];
    let cursor = null;
    do {
        const page = cursorPage(fetchPage(cursor), limit);
        assert.ok(page.rows.every(r => !('rowId' in r)), 'rowId reached the response');
        hashes.push(...page.rows.map(r => r.hash));
        sizes.push(page.rows.length);
        cursor = page.next && parseCursor(page.next);
    } while (cursor && sizes.length < 50);
    return { hashes, sizes };
}

const created = [];
after(() => {
    for (const dir of created) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
});

describe('per-address pages reach the whole index, each row once', () => {
    before(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-account-history-'));
        created.push(dir);
        db.initDb(dir, true, { awaitMigrator: false });
        db.insertTransactions(txAll);
        db.insertEvents(evAll);
    });

    test('transactions come back newest first and the last page is short', () => {
        const { hashes, sizes } = walk(c => db.getTransactionsByAddress(ME, 5, null, c), 5);
        assert.deepEqual(hashes, expected(txAll, touches(ME)));
        assert.deepEqual(sizes, [5, 5, 5, 5, 3]);
        assert.equal(db.countTransactionsByAddress(ME), 23);
    });

    test('a page that fills exactly is followed by an empty one', () => {
        assert.deepEqual(walk(c => db.getTransactionsByAddress(ME, 23, null, c), 23).sizes, [23, 0]);
    });

    test('the raw spelling is paged and counted too (F-080)', () => {
        const { hashes, sizes } = walk(c => db.getTransactionsByAddress(ME, 5, ALT, c), 5);
        assert.deepEqual(hashes, expected(txAll, touches(ME, ALT)));
        assert.deepEqual(sizes, [5, 5, 5, 5, 5, 1]);
        assert.equal(db.countTransactionsByAddress(ME, ALT), 26);
    });

    test('events by signer page the same way', () => {
        const { hashes, sizes } = walk(c => db.getEventsByAddress(ME, 5, c), 5);
        assert.deepEqual(hashes, expected(evAll, e => e.signerAddress === ME));
        assert.deepEqual(sizes, [5, 5, 5, 5, 3]);
        assert.equal(db.countEventsByAddress(ME), 23);
    });
});

// Without a Cache-Control header the CDN kept an account page for an hour; both routes now use the
// 10 s tier the indexer-fed feeds use, set only once the response is ready (errors stay no-store).
describe('the account routes are cached for seconds, not an hour', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const route = p => { const i = server.indexOf(`app.get('${p}'`); assert.ok(i !== -1, p); return server.slice(i, server.indexOf('\n});', i)); };

    for (const p of ['/api/account/:address', '/api/account/:address/history']) {
        test(`${p} sets cacheShort right before it responds`, () => {
            const body = route(p);
            assert.match(body, /cacheShort\(res\);\s*res\.json\(/);
            assert.ok(!/cacheMedium\(res\)|cacheLong\(res\)|no-store/.test(body), 'another tier in the handler');
        });
    }

    test('cacheShort is the 10-second tier, and the developers table lists both routes there', () => {
        assert.match(server, /function cacheShort\(res\)\s*\{ res\.set\('Cache-Control', 'public, max-age=5, s-maxage=10, stale-while-revalidate=30'\); \}/);
        const tier = CACHE_TIERS.find(t => t.name === 'Short');
        assert.ok(tier.routes.includes('/api/account/:address') && tier.routes.includes('/api/account/:address/history'));
    });
});

describe('the cursor helpers', () => {
    test('a full page points below its last row and strips rowId; a short page ends the walk', () => {
        const rows = [{ hash: 'a', block: 9, rowId: 7 }, { hash: 'b', block: 9, rowId: 3 }];
        assert.deepEqual(cursorPage(rows, 2), { rows: [{ hash: 'a', block: 9 }, { hash: 'b', block: 9 }], next: '9:3' });
        assert.equal(cursorPage(rows, 3).next, null);
    });

    test('parseCursor accepts only "<block>:<rowId>"', () => {
        assert.deepEqual(parseCursor('9:3'), { block: 9, rowId: 3 });
        for (const bad of [undefined, '', '9', '9:', ':3', '9:3:1', '-9:3', '9.5:3', 'a:b', ' 9:3', '99999999999999999999:1', ['9:3']]) {
            assert.equal(parseCursor(bad), null, `accepted ${JSON.stringify(bad)}`);
        }
    });
});

// Run mountAccountLoadOlder with the DOM, the table and fetchApiJson stubbed.
function mount({ next = '9:1', total = 3, pages = [] } = {}) {
    const el = () => ({ textContent: '', innerHTML: '', disabled: false, style: {} });
    const ui = { count: el(), button: el(), error: el(), urls: [], disabledDuringFetch: [] };
    ui.button.addEventListener = (type, fn) => { ui.click = fn; };
    const parts = { '.js-older-count': ui.count, '.js-older-btn': ui.button, '.js-older-error': ui.error };
    ui.tab = { insertAdjacentHTML(where, html) { ui.inserted = [where, html]; }, querySelector: s => parts[s] };
    ui.table = { setData(rows) { this.rows = rows; } };
    const fetchApiJson = async url => {
        ui.urls.push(url);
        ui.disabledDuringFetch.push(ui.button.disabled);
        const page = pages.shift();
        if (page instanceof Error) throw page;
        return page;
    };
    mountAccountLoadOlder(ui.tab, { address: 'es1 me', list: 'transactions', table: ui.table, rows: [{ hash: 'a' }], next, total, fetchJson: fetchApiJson });
    return ui;
}

describe('Load older under the account tables', () => {
    test('each click appends the next page and updates the count; the button goes at the end', async () => {
        const ui = mount({ pages: [{ rows: [{ hash: 'b' }], next: '8:4' }, { rows: [{ hash: 'c' }], next: null }] });
        assert.equal(ui.inserted[0], 'beforeend', 'the bar goes under the table, not over it');
        assert.match(ui.inserted[1], /Load older/);
        assert.equal(ui.count.textContent, 'Showing 1 of 3 transactions');
        await ui.click();
        assert.deepEqual(ui.table.rows.map(r => r.hash), ['a', 'b']);
        assert.equal(ui.count.textContent, 'Showing 2 of 3 transactions');
        assert.notEqual(ui.button.style.display, 'none');
        await ui.click();
        assert.deepEqual(ui.table.rows.map(r => r.hash), ['a', 'b', 'c']);
        assert.equal(ui.count.textContent, 'Showing 3 of 3 transactions');
        assert.equal(ui.button.style.display, 'none');
        assert.deepEqual(ui.urls, [
            '/api/account/es1%20me/history?list=transactions&before=9%3A1',
            '/api/account/es1%20me/history?list=transactions&before=8%3A4'
        ]);
        assert.deepEqual(ui.disabledDuringFetch, [true, true]);
        assert.equal(ui.button.disabled, false);
    });

    test('an error shows the escaped message and re-enables the button', async () => {
        const ui = mount({ pages: [new Error('<b>busy</b>'), { rows: [{ hash: 'b' }], next: null }] });
        await ui.click();
        assert.equal(ui.error.innerHTML, '&lt;b&gt;busy&lt;/b&gt;');
        assert.equal(ui.button.disabled, false);
        assert.equal(ui.table.rows, undefined, 'a failed page must not touch the table');
        await ui.click();
        assert.equal(ui.error.innerHTML, '', 'the retry clears the error');
        assert.deepEqual(ui.table.rows.map(r => r.hash), ['a', 'b']);
    });

    test('no cursor means no button, and a missing total shows just the row count', () => {
        const none = mount({ next: null });
        assert.equal(none.click, undefined);
        assert.equal(none.inserted, undefined);
        assert.equal(mount({ total: null }).count.textContent, 'Showing 1');
    });
});
