// Wallet dashboard "Recent Transactions": the newest 10 as before, then a "Load 50 more" bar that reuses the
// account page's Load older component (lib/account-load-older.js) against /api/account/:address/history.
// Spec: cto-team/plans/2026-11-16-wallet-recent-tx-more.md. Kept out of script.js (line ceiling) and import-free
// of the browser so node can test it.

import { cursorPage } from './tx-paging.js';
import { mountAccountLoadOlder } from './account-load-older.js';

export const FIRST_PAGE = 10;
export const MORE_PAGE = 50;
const LIMIT_ERROR = `limit must be between 1 and ${MORE_PAGE}.`;

// The history route's optional ?limit: absent means `fallback`; otherwise a whole number 1..50, never clamped.
export function parseHistoryLimit(value, fallback) {
    if (value === undefined) return { limit: fallback };
    const limit = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : 0;
    return limit >= 1 && limit <= MORE_PAGE ? { limit } : { error: LIMIT_ERROR };
}

// The three wallet payload fields: the first page, the cursor below it, and the indexed total.
export function walletRecentFields(db, address, raw) {
    const page = cursorPage(db.getTransactionsByAddress(address, FIRST_PAGE, raw), FIRST_PAGE);
    return {
        recentTransactions: page.rows,
        recentTransactionsNext: page.next,
        recentTransactionsTotal: db.countTransactionsByAddress(address, raw)
    };
}

// Fresh first page, then the stored rows that are not in it (older ones that were loaded or have since slid
// out of the first ten), so a refresh that brings a new transaction shows it once, at the top.
// If nothing in `stored` is in `fresh`, more than ten transactions landed in between: the stored rows would sit
// below a gap, so they are dropped and the caller starts again from the fresh page and its cursor.
export function mergeRecent(fresh, stored) {
    const seen = new Set(fresh.map(r => r.hash));
    if (!stored.some(r => seen.has(r.hash))) return { rows: fresh, reset: true };
    return { rows: fresh.concat(stored.filter(r => !seen.has(r.hash))), reset: false };
}

// Build the table and, on a live render, the bar under it.
//   store     { address, rows, next } owned by script.js, outside the render: loaded pages survive a re-render
//   live      false on the cache paint: its cursor may be old, so no bar and the store is left alone
//   buildTable(rows) -> makeTable instance      fetchJson: fetchApiJson      isCurrent(): still this wallet's fetch
export function mountWalletRecentTx({ container, data, store, live = true, buildTable, fetchJson, isCurrent = () => true }) {
    const address = data.address;
    const tag = t => ({ ...t, direction: t.from === address ? 'Sent' : 'Received' });
    const fresh = (data.recentTransactions || []).map(tag);
    const total = data.recentTransactionsTotal ?? null;
    let rows = fresh, next = data.recentTransactionsNext || null;
    const carried = store.address === address && store.rows.length ? mergeRecent(fresh, store.rows) : null;
    if (carried && !carried.reset) {
        rows = carried.rows;
        // The cache paint keeps the loaded rows on screen so the live render does not swap ten for sixty; it
        // never takes the cursor (no bar) and never writes the store.
        if (live) next = store.next;
    }
    if (live) {
        if (!carried) store.address = address;
        store.rows = rows;
        store.next = next;
    }
    const table = buildTable(rows);
    if (live && container.parentElement) {
        mountAccountLoadOlder(container.parentElement, {
            address, list: 'transactions', noun: 'transactions', table, rows, next, total, fetchJson, isCurrent,
            label: `Load ${MORE_PAGE} more`, pageSize: MORE_PAGE, mapRow: tag, controls: container.id,
            errorMessage: () => 'Could not load older transactions. Check your connection and retry.',
            doneLink: { href: `/account/${encodeURIComponent(address)}`, text: 'Open the account page for events, transfers and filters' },
            onAppend: (all, cursor) => { if (store.address === address) { store.rows = all; store.next = cursor; } }
        });
    }
    return { table, rows, next };
}
