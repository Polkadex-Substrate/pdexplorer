// The account page's Transfers table and the "Load older" bar under both of its tables.
//
// Moved out of script.js so script.js stays under its line ceiling
// (test/help-topics.test.js) and so these run in node without lifting source text.
// The address helpers they need (isSameAddress, stakingShortAddress, shortAddressLink,
// statusBadge, timeAgo) stay in script.js and are passed in, so there is one copy of each.

import { escapeHtml } from './html-escape.js';

// "YYYY-MM-DD HH:mm:ss (UTC)", or a dash when the time is unknown.
export function formatUtcDateTime(ts) {
    const d = new Date(Number(ts));
    return ts && Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 19).replace('T', ' ')} (UTC)` : '-';
}

// Value cell for "1,341.7476 PDEX": integer part plain, ".fraction" muted, unit in the brand colour; other text as is.
export function transferValueCell(amount) {
    const m = /^([\d,]+)(\.\d+)?\s*(.*)$/.exec(String(amount ?? ''));
    if (!m) return escapeHtml(amount);
    return `${escapeHtml(m[1])}<span style="color: var(--text-secondary);">${escapeHtml(m[2] || '')}</span> <span style="color: var(--brand-primary);">${escapeHtml(m[3])}</span>`;
}

// Index cell: Extrinsic #block-index to the transaction when the transfer has one, else Event #block-index to its block.
export function transferIndexCell(row) {
    const ext = row.extrinsicIndex != null && row.txHash;
    const [label, href] = ext ? [`Extrinsic #${row.block}-${row.extrinsicIndex}`, `/tx/${row.block}/${row.txHash}`] : [`Event #${row.block}-${row.eventIndex}`, `/block/${row.block}`];
    return `<a href="${escapeHtml(href)}" class="item-link">${escapeHtml(label)}</a>`;
}

// Which way a transfer went for the viewed account: 'in', 'out', 'self' (both sides) or ''.
// `same(a, b)` compares two addresses whatever their SS58 prefix.
export function transferDirection(row, account, same) {
    const out = same(row.from, account), into = same(row.to, account);
    return out && into ? 'self' : out ? 'out' : into ? 'in' : '';
}

// From / To cell: the viewed account as plain text, any other address as a link.
export function transferParty(addr, account, { same, short, link }) {
    return same(addr, account) ? `<span class="mono" title="${escapeHtml(addr)}">${escapeHtml(short(addr))}</span>` : link(addr);
}

// The makeTable columns of the Transfers tab: Index, Block, From, IN / OUT, To, Value, Time, Result.
// deps: { same, short, link, timeAgo, statusBadge }.
export function transferColumns(account, deps) {
    const { same, timeAgo, statusBadge } = deps;
    const dir = row => transferDirection(row, account, same);
    return [
        { key: 'index', label: 'Index', format: transferIndexCell },
        { key: 'block', label: 'Block', searchable: true, sort: (a, b) => (a.block || 0) - (b.block || 0), format: row => `<a href="/block/${escapeHtml(row.block)}" class="item-link">${escapeHtml(row.block)}</a>` },
        { key: 'from', label: 'From', searchable: true, format: row => transferParty(row.from, account, deps) },
        { key: 'direction', label: ' ', filter: { type: 'select', options: ['in', 'out', 'self'], derive: dir },
          format: row => { const d = dir(row); return d && `<span class="dir-pill ${d}">${d.toUpperCase()}</span>`; } },
        { key: 'to', label: 'To', searchable: true, format: row => transferParty(row.to, account, deps) },
        { key: 'amount', label: 'Value', searchable: true, sort: (a, b) => (a.numericAmount || 0) - (b.numericAmount || 0), format: row => transferValueCell(row.amount) },
        { key: 'timestamp', label: 'Time', sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
          format: row => `<span title="${escapeHtml(timeAgo(row.timestamp))}">${escapeHtml(formatUtcDateTime(row.timestamp))}</span>` },
        { key: 'status', label: 'Result', filter: { type: 'select', options: ['success', 'failed', 'unknown'] }, format: row => statusBadge(row.status, '', { icon: true }) }
    ];
}

// Load older under an account table: appends /api/account/:address/history pages until next is null.
// Browser only (touches the tab element); `fetchJson` is script.js's fetchApiJson.
export function mountAccountLoadOlder(tab, { address, list, noun = list, table, rows, next, total, fetchJson }) {
    if (!tab || !next) return;
    tab.insertAdjacentHTML('beforeend', `<div style="display: flex; gap: 10px; justify-content: center; align-items: center; padding: 20px;">
        <span class="js-older-count" style="color: var(--text-secondary); font-size: 13px;"></span><button type="button" class="glass js-older-btn" style="padding: 10px 20px; color: var(--text-primary); border: 1px solid var(--brand-primary); background: rgba(229,0,122,0.1); border-radius: var(--radius-sm); cursor: pointer; transition: var(--transition-fast);">Load older</button>
        <span class="js-older-error" style="color: var(--error); font-size: 13px;"></span></div>`);
    const [count, button, error] = ['.js-older-count', '.js-older-btn', '.js-older-error'].map(s => tab.querySelector(s));
    const showCount = () => { count.textContent = `Showing ${rows.length.toLocaleString()}` + (total != null ? ` of ${total.toLocaleString()} ${noun}` : ''); };
    button.addEventListener('click', async () => {
        button.disabled = true;
        error.innerHTML = '';
        try {
            const page = await fetchJson(`/api/account/${encodeURIComponent(address)}/history?list=${encodeURIComponent(list)}&before=${encodeURIComponent(next)}`);
            rows = rows.concat(page.rows);
            next = page.next;
            table.setData(rows);
            showCount();
            if (!next) button.style.display = 'none';
        } catch (e) { error.innerHTML = escapeHtml(e.message); }
        button.disabled = false;
    });
    showCount();
}
