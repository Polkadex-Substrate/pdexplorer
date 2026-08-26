import { ApiPromise, WsProvider } from '@polkadot/api';
import { decodeAddress, encodeAddress, createKeyMulti, sortAddresses,
         blake2AsHex, xxhashAsHex, keccakAsHex, signatureVerify } from '@polkadot/util-crypto';
import { u8aToHex, hexToU8a, stringToU8a, isHex } from '@polkadot/util';
// Signing-critical helpers live in lib/ so they can be unit-tested without a
// browser — see lib/wallet-safety.js and test/wallet-safety.test.js. Do not
// re-inline these; the audit findings they encode (F-011, F-012, F-054) are
// exactly the kind that reappear when the logic is buried in this bundle.
import { pdexToPlanck, isPositiveNumberInput, isValidPolkadexAddress,
         buildTransferTx } from './lib/wallet-safety.js';
// Audit F-017 — folding REST snapshots into the live arrays instead of
// replacing them. See lib/merge-rows.js for the rules.
import { mergeRows, blockRank, txRank } from './lib/merge-rows.js';

// Polkadex chain SS58 prefix. Addresses encoded with this prefix all start
// with the character "e", which is what we want to show the user — even
// though wallet extensions hand back addresses in their own native format
// (typically prefix 0 "1…" for Polkadot or prefix 42 "5…" for generic
// Substrate). All display sites run through toPolkadexAddress() so the UI
// shows the chain-specific form consistently.
const POLKADEX_SS58 = 88;
function toPolkadexAddress(addr) {
    if (!addr) return '';
    try { return encodeAddress(decodeAddress(addr), POLKADEX_SS58); }
    catch (e) { return addr; }
}

// Utility to generate human readable relative time
function timeAgo(timestamp) {
    // F-114 made getBlockTimestamp return null for a block whose timestamp
    // couldn't be read — correct, but a review caught the interaction: with
    // the new day/month/year buckets, Date.now() - null landed in the years
    // branch and rendered a confident "56.6 years ago". An unknown time must
    // look unknown.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return '—';
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 0) return 'just now';   // clock skew between browser and chain
    if (seconds < 60) return `${seconds} secs ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
    // Audit F-127: this stopped at hours, so with the transactions table now
    // reaching back to 2021 (F-008) a four-year-old transfer read
    // "35,000 hrs ago". Say days/months/years like a person would.
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hrs ago`;
    if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)} days ago`;
    if (seconds < 365 * 86400) return `${Math.floor(seconds / (30 * 86400))} months ago`;
    return `${(seconds / (365.25 * 86400)).toFixed(1)} years ago`;
}

// Format PDEX balances (12 decimals)
function formatPDEX(balance) {
    return (Number(balance) / 10 ** 12).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatNetworkNumber(value, maximumFractionDigits = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 'Loading...';
    return number.toLocaleString('en-US', { maximumFractionDigits });
}

// --- Reusable sortable/filterable table -----------------------------------
// Renders a filter bar + sortable headers + tbody + row-count summary into a
// container <div>. Each table page (transactions, blocks, events, validators,
// holders, staking-rewards) passes its column definitions and row array; the
// helper takes care of sort state, per-column filters, global search, focus
// preservation across re-renders, and the empty-state message.
//
//   const api = makeTable({
//       container: document.getElementById('foo-table-container'),
//       columns: [
//           {
//               key:        'block',                       // field on the row
//               label:      'Block',                       // <th> text
//               sort:       (a, b) => a.block - b.block,   // optional. enables click-to-sort
//               format:     row => `<a href="...">${row.block}</a>`,  // cell HTML
//               searchable: true,                          // included in the global search box
//               filter:     { type: 'text' } | { type: 'select', options: [...] }
//           },
//           ...
//       ],
//       rows:           [...],
//       defaultSort:    { key: 'timestamp', dir: 'desc' },
//       globalSearch:   true,
//       emptyMessage:   'No rows yet.',
//       summarySuffix:  'transactions',  // appears after the count: "Showing X of Y transactions"
//       pagination:     {                // optional. omit to render every row (legacy behavior)
//           pageSize:     50,            // rows per page / show-more increment
//           showMoreMax:  200            // cumulative cap; beyond this the UI switches to
//       }                                // numbered pagination (Prev / 1 2 3 / Next) instead
//   });                                  // of growing the visible window.
//
// Pagination policy (which call sites set `pagination` and which don't):
//   ON  — tables that can plausibly grow into the thousands and would hurt
//         page performance if dumped wholesale into the DOM:
//             /transactions, /blocks, /events, /holders,
//             /staking-rewards/:addr,
//             account-details (transactions + events tabs),
//             /discussions (threads).
//   OFF — tables whose row count is structurally bounded or whose UX favors
//         scanning the whole set at once:
//             /validators (chain-capped active+candidate set),
//             treasury (proposals, approved, history — each typically <50),
//             democracy referenda + public proposals (small),
//             council motions (small, pre-filtered by status pill),
//             wallet recent-rewards + recent-tx (intentional top-~10 snapshots).
//   api.setData(newRows);   // call when the underlying data changes
//   api.refresh();          // re-render with current state (e.g. after a format change)
//
// Implementation notes:
//   * Re-rendering on every keystroke would steal focus, so we record which
//     filter input has focus + caret position before innerHTML replacement
//     and restore them afterwards.
//   * The global search matches any column flagged `searchable`. Per-column
//     filters apply on top of the global search.
//   * Sort cycle on header click: unsorted → asc → desc → unsorted.
function makeTable(config) {
    const container = config.container;
    if (!container) return { setData() {}, refresh() {} };

    const columns = config.columns || [];
    let rows = Array.isArray(config.rows) ? config.rows : [];
    let sortKey = config.defaultSort ? config.defaultSort.key : null;
    let sortDir = config.defaultSort ? (config.defaultSort.dir || 'asc') : 'asc';
    const colFilters = {};
    let globalSearch = '';

    const showGlobalSearch = config.globalSearch !== false;
    const emptyMessage = config.emptyMessage || 'No matching rows.';
    const summarySuffix = config.summarySuffix || 'rows';
    const rowClass = config.rowClass || null;       // optional fn(row) => string

    // Pagination config — when present, the table progressively reveals rows
    // instead of dumping the whole filtered set into the DOM. Two modes share
    // the same config:
    //   • Show-more  (filtered count ≤ showMoreMax): one cumulative window
    //     starting at pageSize, grows by pageSize per click, hard-capped at
    //     showMoreMax. The button disappears when there's nothing left.
    //   • Paginated  (filtered count > showMoreMax): traditional prev/page-
    //     numbers/next strip with pageSize rows per page. Resets to page 1
    //     whenever filters/search change so the user isn't stranded on page
    //     50 of an empty result set.
    const paginationCfg = config.pagination || null;
    const pageSize = paginationCfg ? Math.max(1, paginationCfg.pageSize | 0 || 50) : 0;
    const showMoreMax = paginationCfg ? Math.max(pageSize, paginationCfg.showMoreMax | 0 || pageSize * 4) : 0;
    let expandedCount = pageSize;   // visible row count in show-more mode
    let page = 1;                   // current page in paginated mode

    function resetPaginationState() {
        expandedCount = pageSize;
        page = 1;
    }

    function applyFilters(input) {
        let out = input;
        // Global search
        if (globalSearch.trim()) {
            const q = globalSearch.trim().toLowerCase();
            out = out.filter(row => columns.some(col => {
                if (!col.searchable) return false;
                const raw = row[col.key];
                return raw != null && String(raw).toLowerCase().includes(q);
            }));
        }
        // Per-column filters
        for (const col of columns) {
            const val = colFilters[col.key];
            if (!val) continue;
            if (col.filter && col.filter.type === 'text') {
                const q = String(val).toLowerCase();
                out = out.filter(row => {
                    const raw = row[col.key];
                    return raw != null && String(raw).toLowerCase().includes(q);
                });
            } else if (col.filter && col.filter.type === 'select') {
                out = out.filter(row => String(row[col.key] ?? '') === String(val));
            }
        }
        return out;
    }

    function applySort(input) {
        if (!sortKey) return input;
        const col = columns.find(c => c.key === sortKey);
        if (!col || !col.sort) return input;
        const cmp = col.sort;
        const sorted = input.slice().sort(cmp);
        if (sortDir === 'desc') sorted.reverse();
        return sorted;
    }

    function buildHeaderHTML() {
        let html = '';
        for (const col of columns) {
            const isSortKey = sortKey === col.key;
            let indicator = '';
            if (col.sort) {
                indicator = isSortKey
                    ? (sortDir === 'asc' ? ' <i class="bx bx-up-arrow-alt"></i>' : ' <i class="bx bx-down-arrow-alt"></i>')
                    : ' <i class="bx bx-sort" style="opacity:0.4;"></i>';
            }
            const classes = ['table-th'];
            if (col.sort) classes.push('sortable');
            if (isSortKey) classes.push('sorted');
            html += `<th class="${classes.join(' ')}" data-col="${stakingEscapeHtml(col.key)}">${stakingEscapeHtml(col.label || col.key)}${indicator}</th>`;
        }
        return html;
    }

    function buildFilterBarHTML() {
        const filterableCols = columns.filter(c => c.filter);
        if (!showGlobalSearch && !filterableCols.length) return '';
        const hasActiveFilter = !!globalSearch || Object.values(colFilters).some(v => v);
        let parts = [];
        if (showGlobalSearch) {
            const anySearchable = columns.some(c => c.searchable);
            if (anySearchable) {
                parts.push(`<div class="table-filter-search">
                    <i class='bx bx-search'></i>
                    <input type="text" class="table-global-search" placeholder="Search…" value="${stakingEscapeHtml(globalSearch)}" autocomplete="off">
                </div>`);
            }
        }
        for (const col of filterableCols) {
            const val = colFilters[col.key] || '';
            if (col.filter.type === 'text') {
                parts.push(`<input type="text" class="table-col-filter" data-col="${stakingEscapeHtml(col.key)}" placeholder="${stakingEscapeHtml(col.filter.placeholder || col.label)}" value="${stakingEscapeHtml(val)}" autocomplete="off">`);
            } else if (col.filter.type === 'select') {
                const opts = ['<option value="">All ' + stakingEscapeHtml(col.label) + '</option>']
                    .concat((col.filter.options || []).map(o => {
                        const v = typeof o === 'object' ? o.value : o;
                        const lab = typeof o === 'object' ? o.label : o;
                        return `<option value="${stakingEscapeHtml(v)}" ${String(val) === String(v) ? 'selected' : ''}>${stakingEscapeHtml(lab)}</option>`;
                    }));
                parts.push(`<select class="table-col-filter" data-col="${stakingEscapeHtml(col.key)}">${opts.join('')}</select>`);
            }
        }
        if (hasActiveFilter) {
            parts.push('<button type="button" class="table-filter-clear">Clear filters</button>');
        }
        return `<div class="table-filter-bar">${parts.join('')}</div>`;
    }

    function snapshotFocus() {
        const ae = document.activeElement;
        if (!ae || !container.contains(ae)) return null;
        const col = ae.getAttribute && ae.getAttribute('data-col');
        const isGlobal = ae.classList && ae.classList.contains('table-global-search');
        const caret = (typeof ae.selectionStart === 'number') ? ae.selectionStart : null;
        return { col, isGlobal, caret };
    }
    function restoreFocus(snap) {
        if (!snap) return;
        let target = null;
        if (snap.isGlobal) target = container.querySelector('.table-global-search');
        else if (snap.col) target = container.querySelector(`.table-col-filter[data-col="${snap.col}"]`);
        if (!target) return;
        target.focus();
        if (snap.caret != null && typeof target.setSelectionRange === 'function') {
            try { target.setSelectionRange(snap.caret, snap.caret); } catch (e) { /* ignore */ }
        }
    }

    // Compact "Prev 1 … 4 5 6 … 23 Next" strip used in paginated mode.
    // Always renders 1 + total and a 2-wide window around the current page,
    // collapsing the rest into ellipses so the strip stays a single row even
    // for huge result sets.
    function buildPaginationNav(current, totalPages) {
        if (totalPages <= 1) return '';
        const wanted = new Set([1, totalPages, current, current - 1, current + 1, current - 2, current + 2]);
        const list = [...wanted].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);
        const parts = [];
        parts.push(`<button type="button" class="table-pagebtn" data-page="${current - 1}"${current === 1 ? ' disabled' : ''}>‹ Prev</button>`);
        let last = 0;
        for (const p of list) {
            if (last && p - last > 1) parts.push(`<span class="table-pageellipsis">…</span>`);
            parts.push(`<button type="button" class="table-pagebtn${p === current ? ' active' : ''}" data-page="${p}">${p}</button>`);
            last = p;
        }
        parts.push(`<button type="button" class="table-pagebtn" data-page="${current + 1}"${current === totalPages ? ' disabled' : ''}>Next ›</button>`);
        return `<div class="table-pagination">${parts.join('')}</div>`;
    }

    function render() {
        const focusSnap = snapshotFocus();
        const filtered = applyFilters(rows);
        const sorted = applySort(filtered);
        const total = rows.length;
        const matched = sorted.length;

        // Decide pagination mode and slice the visible window.
        //   • mode = 'all':       no pagination config or filtered set fits.
        //   • mode = 'showmore':  cumulative reveal up to showMoreMax.
        //   • mode = 'paginated': numbered nav (when > showMoreMax).
        let mode = 'all';
        let visible = sorted;
        let firstIdx = 0;       // 1-based first row in the visible slice
        let lastIdx = matched;
        let extraHTML = '';     // "Show more" button or page-nav, appended below the table
        if (paginationCfg && matched > pageSize) {
            if (matched <= showMoreMax) {
                mode = 'showmore';
                const limit = Math.min(expandedCount, matched);
                visible = sorted.slice(0, limit);
                firstIdx = matched ? 1 : 0;
                lastIdx = limit;
                const remaining = matched - limit;
                if (remaining > 0) {
                    const step = Math.min(pageSize, remaining);
                    extraHTML = `<div class="table-showmore">
                        <button type="button" class="table-showmore-btn">Show ${step} more
                            <span class="table-showmore-remaining">(${remaining.toLocaleString()} remaining)</span>
                        </button>
                    </div>`;
                }
            } else {
                mode = 'paginated';
                const totalPages = Math.max(1, Math.ceil(matched / pageSize));
                if (page > totalPages) page = totalPages;
                if (page < 1) page = 1;
                const start = (page - 1) * pageSize;
                const end = Math.min(start + pageSize, matched);
                visible = sorted.slice(start, end);
                firstIdx = start + 1;
                lastIdx = end;
                extraHTML = buildPaginationNav(page, totalPages);
            }
        }

        const shown = visible.length;
        let bodyHTML = '';
        if (!shown) {
            bodyHTML = `<tr><td colspan="${columns.length}" class="table-empty-row">${stakingEscapeHtml(total === 0 ? emptyMessage : 'No rows match the current filters.')}</td></tr>`;
        } else {
            for (const row of visible) {
                const rc = rowClass ? rowClass(row) : '';
                bodyHTML += `<tr${rc ? ` class="${rc}"` : ''}>`;
                for (const col of columns) {
                    bodyHTML += '<td>' + (col.format ? col.format(row) : (row[col.key] != null ? stakingEscapeHtml(String(row[col.key])) : '')) + '</td>';
                }
                bodyHTML += '</tr>';
            }
        }

        const suffixEsc = stakingEscapeHtml(summarySuffix);
        const filteredFrom = (matched !== total) ? ` <span class="table-summary-muted">(filtered from ${total.toLocaleString()})</span>` : '';
        let summary;
        if (mode === 'paginated') {
            summary = `<div class="table-summary">Showing <strong>${firstIdx.toLocaleString()}–${lastIdx.toLocaleString()}</strong> of ${matched.toLocaleString()} ${suffixEsc}${filteredFrom}</div>`;
        } else if (mode === 'showmore') {
            summary = `<div class="table-summary">Showing <strong>${lastIdx.toLocaleString()}</strong> of ${matched.toLocaleString()} ${suffixEsc}${filteredFrom}</div>`;
        } else {
            summary = (matched === total)
                ? `<div class="table-summary">${total.toLocaleString()} ${suffixEsc}</div>`
                : `<div class="table-summary">Showing <strong>${matched.toLocaleString()}</strong> of ${total.toLocaleString()} ${suffixEsc}</div>`;
        }

        container.innerHTML = `
            ${buildFilterBarHTML()}
            ${summary}
            <div class="table-responsive">
                <table class="data-table">
                    <thead><tr>${buildHeaderHTML()}</tr></thead>
                    <tbody>${bodyHTML}</tbody>
                </table>
            </div>
            ${extraHTML}`;

        // Wire up handlers on freshly-rendered elements. Filter/search/sort all
        // reset pagination state so a narrowing filter doesn't strand the user
        // on a page that no longer exists.
        container.querySelectorAll('.table-th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.getAttribute('data-col');
                if (sortKey === key) {
                    if (sortDir === 'asc') sortDir = 'desc';
                    else { sortKey = null; sortDir = 'asc'; }
                } else {
                    sortKey = key; sortDir = 'asc';
                }
                // Sort change keeps the same rows but re-orders them — reset
                // page to 1 so the user always sees the new top of the list.
                page = 1;
                render();
            });
        });
        const gs = container.querySelector('.table-global-search');
        if (gs) gs.addEventListener('input', e => { globalSearch = e.target.value; resetPaginationState(); render(); });
        container.querySelectorAll('.table-col-filter').forEach(el => {
            const handler = () => { colFilters[el.getAttribute('data-col')] = el.value; resetPaginationState(); render(); };
            el.addEventListener('input', handler);
            el.addEventListener('change', handler);
        });
        const clearBtn = container.querySelector('.table-filter-clear');
        if (clearBtn) clearBtn.addEventListener('click', () => {
            globalSearch = '';
            for (const k of Object.keys(colFilters)) colFilters[k] = '';
            resetPaginationState();
            render();
        });
        const showmoreBtn = container.querySelector('.table-showmore-btn');
        if (showmoreBtn) showmoreBtn.addEventListener('click', () => {
            expandedCount = Math.min(expandedCount + pageSize, showMoreMax);
            render();
        });
        container.querySelectorAll('.table-pagebtn').forEach(btn => {
            if (btn.hasAttribute('disabled')) return;
            btn.addEventListener('click', () => {
                const p = parseInt(btn.getAttribute('data-page'), 10);
                if (!isNaN(p)) { page = p; render(); }
            });
        });

        restoreFocus(focusSnap);
    }

    render();
    return {
        // setData(rows, { resetPagination: true }) to explicitly jump back to
        // the start; by default the user's position is PRESERVED.
        //
        // This used to reset unconditionally. The recent-views poller
        // (refreshRecentViews, on a setInterval) calls setData on the
        // transactions/blocks/events tables every cycle, so anyone reading
        // page 3 was yanked back to page 1 a few seconds later — and clicking
        // "Load Older 100 Financial Tx" scrolled you to the top instead of
        // showing what you just loaded. Pagination looked broken because it
        // effectively was.
        //
        // Preserving is safe: render() already clamps `page` to totalPages and
        // caps the show-more window with Math.min(expandedCount, matched), so
        // stale state can never produce an out-of-range slice — which is the
        // problem the original reset was guarding against.
        setData(newRows, opts) {
            rows = Array.isArray(newRows) ? newRows : [];
            if (opts && opts.resetPagination) resetPaginationState();
            render();
        },
        refresh()        { render(); },
        getState()       { return { sortKey, sortDir, colFilters: { ...colFilters }, globalSearch }; }
    };
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerText = value;
}

function setHtml(id, value) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = value;
}

// DOM Elements
const blocksListEl = document.getElementById('blocks-list');
const transactionsListEl = document.getElementById('transactions-list');
const sidebar = document.querySelector('.sidebar');
const statusIndicator = document.querySelector('.status-indicator');
const networkStatusText = document.querySelector('.network-status span');

const issuanceEl = document.querySelector('.stat-card:nth-child(2) .stat-value');
const stakeEl = document.querySelector('.stat-card:nth-child(3) .stat-value');
const currentEraEl = document.getElementById('network-current-era');

const validatorsListEl = document.getElementById('validators-table');
let validatorsTableApi = null;
const validatorCountEl = document.querySelector('.validator-count');
const holdersListEl = document.getElementById('holders-table');
let holdersTableApi = null;
const holderCountEl = document.querySelector('.holder-count');
// Container <div> for the full /transactions table. makeTable owns the
// filter bar + sortable header + tbody + summary; we hand it the row array.
const fullTransactionsListEl = document.getElementById('full-transactions-table');
let transactionsTableApi = null;
const txCountEl = document.querySelector('.tx-count');
const fullBlocksListEl = document.getElementById('full-blocks-table');
let blocksTableApi = null;
const blockCountEl = document.querySelector('.block-count');
const fullEventsListEl = document.getElementById('full-events-list');
let eventsTableApi = null;
const eventCountEl = document.querySelector('.event-count');
const accountDetailsContainer = document.getElementById('account-details-container');
const blockDetailsContainer = document.getElementById('block-details-container');
const txDetailsContainer = document.getElementById('tx-details-container');

const navItems = document.querySelectorAll('.nav-item');
const pageSections = document.querySelectorAll('.page-section');

// Static-shell controls that used to be inline onclick= attributes in
// index.html. The CSP (F-039) sets script-src 'self', which blocks inline
// handlers — and these two were the only ones left in the static markup.
function wireStaticShellControls() {
    const sidebar = document.getElementById('sidebar');
    document.querySelectorAll('.js-sidebar-open').forEach(el =>
        el.addEventListener('click', () => sidebar && sidebar.classList.add('open')));
    document.querySelectorAll('.js-sidebar-close').forEach(el =>
        el.addEventListener('click', () => sidebar && sidebar.classList.remove('open')));
}
wireStaticShellControls();

// State
let blocks = [];
let fullBlocks = [];
let blocksFetched = false;
let blockDisplayLimit = 50;
let transactions = [];
let txFetched = false;
let txDisplayLimit = 50;
let olderTxBeforeBlock = null;
// F-078 / F-079 paging state: where to resume inside a partially-returned
// height, and whether the server has told us there is nothing older.
let olderTxResume = null;
let olderTxReachedGenesis = false;
let transactionCacheMeta = {};
let isLoadingOlderTx = false;
let fullEvents = [];
let eventsFetched = false;
let eventDisplayLimit = 50;
let validatorsFetched = false;
let globalApi = null;
const RECENT_REFRESH_MS = 12000;

// Upper bound on the shared `transactions` array (audit F-017).
//
// ONE constant on purpose. This started as three different numbers — the
// WebSocket handler popped at 500, the /transactions merge capped at 2000, and
// the home-page merge capped at 500 — all writing the same module-level array.
// A user who paged in 1,200 rows on /transactions and then visited home got
// truncated to 500 on the next 12s tick, while `olderTxBeforeBlock` kept its
// old watermark: clicking "Load Older 100" again resumed below the truncation
// and left a HOLE in the middle of the list. Divergent caps on shared state is
// how that happens, so there is only one.
//
// 2000 is ~20 pages of "Load Older 100" and a few MB at most.
const TX_ROW_CAP = 2000;

async function init() {
    try {
        networkStatusText.innerText = "Connecting...";
        statusIndicator.classList.remove('live');
        statusIndicator.style.background = 'orange';

        // Cloudflare LB endpoint — auto-fails over between origin nodes
        // (so.polkadex.ee, polkadex-rpc.faradaynodes.com, ...) so this single
        // URL is resilient without the frontend needing to know the topology.
        const wsProvider = new WsProvider('wss://rpc.polkadex.ee');
        globalApi = await ApiPromise.create({
            provider: wsProvider,
            // The runtime declares the CheckMetadataHash signed extension, but
            // @polkadot/api 10.13.1 predates support for it and logs
            //   "Unknown signed extensions CheckMetadataHash ... no-effect"
            // then encodes NOTHING for it. The runtime still expects a Mode
            // byte in the signed extra and an Option<[u8;32]> in the signing
            // payload, so every signed extrinsic we submitted decoded
            // misaligned on-chain and panicked inside
            // TaggedTransactionQueue_validate_transaction — surfacing to the
            // user as "wasm `unreachable` instruction executed". Declaring the
            // shape here makes 10.13.1 encode Mode::Disabled (0) + None, which
            // is exactly what a current api sends when metadata-hash checking
            // is not in use. Remove this block only when @polkadot/api is
            // upgraded to a version that knows the extension natively.
            signedExtensions: {
                CheckMetadataHash: {
                    extrinsic: { mode: 'u8' },
                    payload: { metadataHash: 'Option<[u8;32]>' }
                }
            }
        });

        networkStatusText.innerText = "Polkadex Connected";
        statusIndicator.classList.add('live');
        statusIndicator.style.background = 'var(--success)';

        fetchNetworkStats(globalApi);
        fetchNetworkInformation();
        // Paint the home-page stat cards from localStorage cache BEFORE any
        // network fetches resolve. Returning visitors see populated cells
        // immediately; cells stay at their HTML "—" placeholder for first-
        // ever visitors (no cache yet) until the live fetches below land.
        paintHomeFromCache();
        // Start the governance notification poller — runs every minute,
        // surfaces homepage banner + toast when a new referendum or proposal
        // is detected since the user's last seen index. Safe no-op if the
        // endpoint isn't reachable.
        startGovernancePolling();
        // Sidebar price ticker — polls /api/price-latest on a 60s cadence so
        // the bottom-left "PDEX Price" cell stays current. The whole row is
        // wrapped in an <a href="/price"> for click-through to the chart.
        startPriceTickerPolling();

        // Fetch initial dashboard data so it isn't empty on load
        try {
            const [txRes, bRes] = await Promise.all([
                fetch('/api/transactions').catch(() => null),
                fetch('/api/blocks').catch(() => null)
            ]);
            // Only repaint the dashboard widgets when the user is actually
            // viewing the home page — avoids flicker when they deep-linked to
            // another route.
            const onHome = () => {
                const path = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
                return path === '' || path === 'home';
            };
            if (txRes) {
                const txData = await txRes.json();
                if (txData.transactions && txData.transactions.length > 0) {
                    transactions = financialTransactionRows(txData.transactions);
                    if (onHome()) renderTransactions();
                }
            }
            if (bRes) {
                const bData = await bRes.json();
                if (bData.blocks && bData.blocks.length > 0) {
                    blocks = bData.blocks;
                    if (onHome()) renderBlocks();
                }
            }
        } catch (e) { }

        // Subscribe to new blocks
        subscribeNewBlocks(globalApi);
        setInterval(refreshRecentViews, RECENT_REFRESH_MS);

    } catch (error) {
        console.error("Failed to connect to Polkadex node", error);
        networkStatusText.innerText = "Connection Failed";
        statusIndicator.style.background = 'var(--error)';
        statusIndicator.classList.remove('live');
    }

    // Initialize routing once after data subscriptions are ready. The router
    // boot wires popstate + the delegated click handler and rewrites any
    // legacy "#X" URL to a clean "/X" URL so canonical/og:url stay accurate.
    bootSeoRouter();
    routeTo(readRouteFromLocation());
}

// Last known total-issuance value (in whole PDEX, not planck). Set by
// fetchNetworkStats; read by updateMarketCapCell so the next price poll
// can recompute marketCap = issuance × price without re-querying chain.
let lastKnownTotalIssuancePdex = 0;

// ─── Home-page cache (instant first paint) ───────────────────────────────────
// The home stat cards and network-info bar previously flashed dashes on
// cold load for the second or two until /api/network-info + chain queries
// returned. Cache the most recent values in localStorage so a returning
// visitor sees populated cells immediately, then overwrite with live data
// as it arrives. Bundled into ONE JSON blob so the writes are atomic and
// a future field addition doesn't blow out the key namespace.
//
// TTL exists so we never paint truly ancient data — if a user comes back
// after a week away, the cells fall back to dashes rather than misleading
// stale numbers. For typical day-to-day visits the cache is always fresh
// enough to be useful.
const HOME_CACHE_KEY = 'pdex_home_snapshot';
const HOME_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function readHomeCache() {
    try {
        const raw = localStorage.getItem(HOME_CACHE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return null;
        if (Date.now() - (Number(data.savedAt) || 0) > HOME_CACHE_MAX_AGE_MS) return null;
        return data;
    } catch (_) { return null; }
}
function writeHomeCache(patch) {
    try {
        const current = readHomeCache() || {};
        const merged = { ...current, ...patch, savedAt: Date.now() };
        localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(merged));
    } catch (_) {}
}
// Per-address cache of the last successful Wallet dashboard render. Keyed
// by SS58 address so multiple wallets can be cached independently. Used by
// fetchWalletDashboard to paint the dashboard instantly on returning
// visits while the live fetches run in the background. 30-min TTL —
// staking balances change slowly enough that a half-hour-old snapshot is
// a good first-paint approximation; live data overwrites within a couple
// of seconds anyway.
const WALLET_CACHE_KEY_PREFIX = 'pdex_wallet_dashboard:';
const WALLET_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
function readWalletCache(address) {
    try {
        const raw = localStorage.getItem(WALLET_CACHE_KEY_PREFIX + address);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || typeof cached !== 'object') return null;
        if (Date.now() - (Number(cached.savedAt) || 0) > WALLET_CACHE_MAX_AGE_MS) return null;
        return cached;
    } catch (_) { return null; }
}
function writeWalletCache(address, patch) {
    try {
        const current = readWalletCache(address) || {};
        const merged = { ...current, ...patch, savedAt: Date.now() };
        localStorage.setItem(WALLET_CACHE_KEY_PREFIX + address, JSON.stringify(merged));
    } catch (_) {}
}

// Hydrate every home-page cell from cache (if any). Safe to call early in
// startup — no-op when no cache exists, no-op for cells that aren't in the
// DOM yet. Each field is guarded so a partial cache (e.g. only price was
// ever written) still paints what it can without throwing.
function paintHomeFromCache() {
    const cached = readHomeCache();
    if (!cached) return;
    if (cached.totalIssuancePdex > 0) {
        lastKnownTotalIssuancePdex = cached.totalIssuancePdex;
        const el = document.querySelector('.stat-card:nth-child(2) .stat-value');
        if (el) el.innerHTML = `${formatNetworkNumber(cached.totalIssuancePdex, 0)} <span class="unit">PDEX</span>`;
    }
    if (cached.inStakePdex > 0) {
        const el = document.querySelector('.stat-card:nth-child(3) .stat-value');
        if (el) el.innerHTML = `${formatNetworkNumber(cached.inStakePdex, 0)} <span class="unit">PDEX</span> <span class="badge small">Cached</span>`;
    }
    if (Number.isFinite(cached.avgApyPercent) && cached.avgApyPercent >= 0) {
        const el = document.getElementById('home-avg-apy');
        if (el) el.textContent = cached.avgApyPercent.toFixed(2) + '%';
    }
    if (cached.priceUsd > 0) {
        lastKnownPriceUsd = cached.priceUsd;
    }
    // Market cap derives from the two values above; safe to call here.
    updateMarketCapCell();
    if (cached.currentEra) setText('network-current-era', cached.currentEra);
    if (cached.validatorsActive != null && cached.validatorsTotal != null) {
        setText('network-validators', `${cached.validatorsActive} / ${cached.validatorsTotal}`);
    }
    if (cached.nominatorsActive != null && cached.nominatorsTotal != null) {
        setText('network-nominators', `${cached.nominatorsActive} / ${cached.nominatorsTotal}`);
    }
    if (cached.maxActiveStakePdex > 0) {
        setHtml('network-max-active-stake', `${formatNetworkNumber(cached.maxActiveStakePdex, 0)} <span class="unit">PDEX</span>`);
    }
}

async function fetchNetworkStats(api) {
    try {
        // Total Issuance
        const totalIssuance = await api.query.balances.totalIssuance();
        issuanceEl.innerHTML = `${formatPDEX(totalIssuance)} <span class="unit">PDEX</span>`;
        // Stash the parsed whole-PDEX value for the market cap calculation.
        // formatPDEX returns a string; reuse the raw chain figure for math.
        let issuancePdex = 0;
        try { issuancePdex = Number(totalIssuance.toString()) / 1e12; } catch (_) {}
        if (issuancePdex > 0) {
            lastKnownTotalIssuancePdex = issuancePdex;
            writeHomeCache({ totalIssuancePdex: issuancePdex });
        }
        updateMarketCapCell();

        // Active Era
        const activeEraOption = await api.query.staking.activeEra();
        if (activeEraOption.isSome) {
            const activeEra = activeEraOption.unwrap().index.toNumber();
            currentEraEl.innerText = activeEra;
            writeHomeCache({ currentEra: activeEra });

            // Total Stake
            const totalStake = await api.query.staking.erasTotalStake(activeEra);
            stakeEl.innerHTML = `${formatPDEX(totalStake)} <span class="unit">PDEX</span> <span class="badge small">Live</span>`;
            let stakePdex = 0;
            try { stakePdex = Number(totalStake.toString()) / 1e12; } catch (_) {}
            if (stakePdex > 0) writeHomeCache({ inStakePdex: stakePdex });
        }
    } catch (err) {
        console.error("Error fetching stats:", err);
    }
}

// Home page Market Cap is computed live as totalIssuance (in whole PDEX)
// × the latest USD price from /api/price-latest. Hard-coding the value in
// the HTML caused it to read wildly wrong once CMC's PDEX listing went
// stale (showed $28.7M when the real native-chain market cap was ~$950k).
// Called from pollPriceTicker (after each price refresh) and from
// fetchNetworkStats (after each issuance fetch). Either input changing is
// enough to refresh the cell.
let lastKnownPriceUsd = 0;
function updateMarketCapCell() {
    const cell = document.getElementById('home-market-cap');
    if (!cell) return;
    if (!(lastKnownTotalIssuancePdex > 0) || !(lastKnownPriceUsd > 0)) {
        cell.textContent = '—';
        return;
    }
    const mcap = lastKnownTotalIssuancePdex * lastKnownPriceUsd;
    cell.textContent = '$' + Math.round(mcap).toLocaleString('en-US');
}

// USD-subscript helpers. Any element with a `data-pdex-amount="<n>"`
// attribute is treated as a PDEX figure whose USD-equivalent we want to
// show alongside; refreshUsdSubscripts() reads `lastKnownPriceUsd` and
// rewrites the element's textContent on each price-ticker poll so the
// subscript never drifts stale while a user is on the page.
function renderUsdSubscript(pdexAmount, priceOverride) {
    const pdex = Number(pdexAmount);
    const price = Number(priceOverride != null ? priceOverride : lastKnownPriceUsd);
    if (!Number.isFinite(pdex) || pdex <= 0 || !Number.isFinite(price) || price <= 0) {
        return '';
    }
    const usd = pdex * price;
    const maxFD = usd >= 100 ? 2 : usd >= 1 ? 3 : 4;
    return '≈ $' + usd.toLocaleString('en-US', { maximumFractionDigits: maxFD });
}
function refreshUsdSubscripts() {
    const nodes = document.querySelectorAll('[data-pdex-amount]');
    if (!nodes.length) return;
    nodes.forEach(n => {
        const amount = Number(n.getAttribute('data-pdex-amount'));
        n.textContent = renderUsdSubscript(amount);
    });
}

// Home page AVG APY. The chain's nominal max APY (before per-validator
// commission) is a constant produced by Polkadex's inflation curve at the
// current ~50% staking ratio target — captured here as MAX_APY_BASE.
// "Average" APY = MAX_APY_BASE × (1 − avgCommission/100). When commission
// data hasn't loaded yet, the cell stays as the dash placeholder.
const MAX_APY_BASE = 23.09;
function updateAvgApyCell(avgCommissionPercent) {
    const cell = document.getElementById('home-avg-apy');
    if (!cell) return;
    const c = Number(avgCommissionPercent);
    if (!Number.isFinite(c) || c < 0 || c > 100) {
        cell.textContent = '—';
        return;
    }
    const apy = MAX_APY_BASE * (1 - c / 100);
    cell.textContent = apy.toFixed(2) + '%';
}

async function fetchNetworkInformation() {
    try {
        const response = await fetch('/api/network-info');
        const data = await response.json();
        // Chain-head freshness banner. The backend's chain-head watchdog sets
        // chainHead.isStale=true when no new block has arrived in N minutes,
        // which usually means the upstream chain RPC has lost peers or
        // stalled even though it's still accepting WS connections. Surface
        // it so users aren't silently looking at stale data.
        renderChainStaleBanner(data.chainHead);
        if (!data.networkInfo) return;
        const info = data.networkInfo;

        setText('network-current-era', info.activeEra);
        setText('network-validators', `${info.validators.active} / ${info.validators.total}`);
        setText('network-nominators', `${info.nominators.active} / ${info.nominators.total}`);
        setHtml('network-max-active-stake', `${formatNetworkNumber(info.maxActiveStake, 0)} <span class="unit">PDEX</span>`);
        setText('network-avg-commission', `${formatNetworkNumber(info.avgValidatorCommission, 3)}%`);
        // AVG APY card (top stats strip). Same avg-commission figure drives
        // it via updateAvgApyCell — keeps the two cells consistent without
        // a second fetch.
        updateAvgApyCell(info.avgValidatorCommission);
        // Snapshot to localStorage so the next page load can paint these
        // cells instantly (before the live fetch returns).
        const apyForCache = (Number.isFinite(Number(info.avgValidatorCommission)) && info.avgValidatorCommission >= 0 && info.avgValidatorCommission <= 100)
            ? MAX_APY_BASE * (1 - Number(info.avgValidatorCommission) / 100)
            : null;
        writeHomeCache({
            currentEra:           info.activeEra ?? null,
            validatorsActive:     info.validators && info.validators.active != null ? info.validators.active : null,
            validatorsTotal:      info.validators && info.validators.total  != null ? info.validators.total  : null,
            nominatorsActive:     info.nominators && info.nominators.active != null ? info.nominators.active : null,
            nominatorsTotal:      info.nominators && info.nominators.total  != null ? info.nominators.total  : null,
            maxActiveStakePdex:   Number(info.maxActiveStake) || 0,
            avgApyPercent:        apyForCache,
        });
        setText('network-min-stake', `${formatNetworkNumber(info.minStake, 0)} PDEX`);
        setText('network-average-stake', `${formatNetworkNumber(info.averageStake, 1)} PDEX`);
        setText('network-avg-stake-account', `${formatNetworkNumber(info.avgStakePerAccount, 1)} PDEX`);
        setText('network-total-bonding', `${formatNetworkNumber(info.totalBonding, 0)} PDEX / ${formatNetworkNumber(info.totalBondingPercent, 0)}%`);
        setText('network-total-unbonding', `-${formatNetworkNumber(info.totalUnbonding, 0)} PDEX`);
        setText('network-last-era-rewards', `${formatNetworkNumber(info.lastEraRewardsTotal, 0)} PDEX`);
    } catch (err) {
        console.error("Error fetching network information:", err);
    }
}

// Sticky banner that warns when the chain head hasn't advanced recently.
// Mounts on every page (not just home) because the data freshness affects
// everything the explorer renders — a stale chain means stale validators,
// stale balances, stale governance state.
function renderChainStaleBanner(chainHead) {
    const ID = 'chain-stale-banner';
    let el = document.getElementById(ID);
    const stale = chainHead && chainHead.isStale;

    if (!stale) {
        if (el) el.remove();
        return;
    }

    // Build (or update) the banner. Keep it light — one row, amber, dismissible
    // only via the next non-stale fetch (so a "x" close button would just
    // come back on the next 30s tick).
    const minutesStale = chainHead.staleSeconds != null
        ? Math.max(1, Math.round(chainHead.staleSeconds / 60))
        : null;
    const headLabel = chainHead.value != null
        ? `block #${Number(chainHead.value).toLocaleString('en-US')}`
        : 'the chain';
    const detail = minutesStale != null
        ? `${headLabel} hasn't advanced in ${minutesStale} minute${minutesStale === 1 ? '' : 's'}`
        : `${headLabel} hasn't advanced in a while`;

    const html = `
        <div style="display:flex; align-items:center; gap:14px; padding:12px 22px; background: rgba(245, 166, 35, 0.12); border-bottom: 1px solid rgba(245, 166, 35, 0.45); color: #fbeac4; font-size: 0.88rem; line-height: 1.45;">
            <i class='bx bx-error-circle' style="font-size: 20px; color: #f5a623; flex-shrink: 0;"></i>
            <div style="flex: 1;">
                <strong style="color: #fff;">Chain may be stalled:</strong>
                ${stakingEscapeHtml(detail)}. The data on this page may be out of date until the upstream chain RPC recovers.
                Indicator clears automatically when blocks resume.
            </div>
        </div>`;

    if (el) {
        el.innerHTML = html;
        return;
    }
    el = document.createElement('div');
    el.id = ID;
    el.innerHTML = html;
    // Insert at the very top of <body> so it sits above the sidebar / topbar
    // on every page without competing with the storage-notice banner at the
    // bottom of the viewport.
    document.body.insertBefore(el, document.body.firstChild);
}

// ─── Governance notifications ────────────────────────────────────────────────
// Polls /api/governance/latest periodically and surfaces new democracy events
// in two ways:
//   1. Persistent banner on the homepage (under #governance-notice-zone) when
//      a new referendum or proposal index is higher than what the user has
//      seen before. One row per kind; each has a close button that dismisses
//      THIS specific index (so a later, newer event will pop back up).
//   2. Global toast in the bottom-right that auto-dismisses after 6 seconds,
//      shown when the polling cycle first detects something new while the
//      user is browsing. Toasts also have close buttons.
//
// Storage keys (documented at /cookies):
//   pdex_gov_seen_ref            number  — highest ref index user has been notified of
//   pdex_gov_seen_proposal       number  — highest proposal index seen
//   pdex_gov_banner_dismissed_ref       number — banner close state per index
//   pdex_gov_banner_dismissed_proposal  number
//
// The "seen" and "dismissed" markers diverge: dismissing the banner doesn't
// mark the event as "seen" — the next new event will still pop, this one
// just gets hidden. Visiting the referendum / proposal page (or the calendar)
// marks both kinds as seen via markGovernanceSeen().

const GOVERNANCE_POLL_INTERVAL_MS = 60 * 1000;
let governanceLastFetch = { latestReferendum: null, latestProposal: null };
let governancePollTimer = null;

function getLsNumber(key) {
    try { const v = parseInt(localStorage.getItem(key) || '0', 10); return Number.isFinite(v) ? v : 0; }
    catch (_) { return 0; }
}
function setLsNumber(key, val) {
    try { localStorage.setItem(key, String(Math.max(0, Number(val) || 0))); }
    catch (_) { /* private mode etc — silent */ }
}

function markGovernanceSeen(kind, index) {
    if (kind === 'referendum') {
        const cur = getLsNumber('pdex_gov_seen_ref');
        if (index > cur) setLsNumber('pdex_gov_seen_ref', index);
    } else if (kind === 'proposal') {
        const cur = getLsNumber('pdex_gov_seen_proposal');
        if (index > cur) setLsNumber('pdex_gov_seen_proposal', index);
    }
}

async function pollGovernanceLatest() {
    try {
        const res = await fetch('/api/governance/latest', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const seenRef       = getLsNumber('pdex_gov_seen_ref');
        const seenProp      = getLsNumber('pdex_gov_seen_proposal');
        const dismissedRef  = getLsNumber('pdex_gov_banner_dismissed_ref');
        const dismissedProp = getLsNumber('pdex_gov_banner_dismissed_proposal');

        // Detect "newly noticed" relative to the previous poll. Used for toasts;
        // banner display is purely based on seen-vs-current.
        const prev = governanceLastFetch;
        const firstPoll = prev.latestReferendum === null && prev.latestProposal === null;

        if (data.latestReferendum && data.latestReferendum.refIndex > seenRef && data.latestReferendum.refIndex > dismissedRef) {
            renderGovernanceBanner('referendum', data.latestReferendum);
            if (!firstPoll && (!prev.latestReferendum || data.latestReferendum.refIndex > prev.latestReferendum.refIndex)) {
                showGovernanceToast('New Polkadex referendum tabled: #' + data.latestReferendum.refIndex,
                    '/democracy?ref=' + data.latestReferendum.refIndex);
            }
        } else {
            removeGovernanceBanner('referendum');
        }

        if (data.latestProposal && data.latestProposal.index > seenProp && data.latestProposal.index > dismissedProp) {
            renderGovernanceBanner('proposal', data.latestProposal);
            if (!firstPoll && (!prev.latestProposal || data.latestProposal.index > prev.latestProposal.index)) {
                showGovernanceToast('New public proposal tabled: #' + data.latestProposal.index,
                    '/democracy?proposal=' + data.latestProposal.index);
            }
        } else {
            removeGovernanceBanner('proposal');
        }

        governanceLastFetch = {
            latestReferendum: data.latestReferendum,
            latestProposal:   data.latestProposal
        };
    } catch (err) {
        // Don't spam the console — polling failures are expected during reconnects.
        // The next tick will retry.
    }
}

function startGovernancePolling() {
    if (governancePollTimer) return;
    pollGovernanceLatest();
    governancePollTimer = setInterval(pollGovernanceLatest, GOVERNANCE_POLL_INTERVAL_MS);
}

function renderGovernanceBanner(kind, payload) {
    const zone = document.getElementById('governance-notice-zone');
    // Render only on the home page — the zone div is inside data-page="home".
    if (!zone) return;
    const ID = 'gov-banner-' + kind;
    let el = document.getElementById(ID);

    const label = kind === 'referendum'
        ? `Referendum #${payload.refIndex}`
        : `Public Proposal #${payload.index}`;
    const subtitle = kind === 'referendum'
        ? (payload.isActive ? 'Voting is open' : 'Recently tabled')
        : 'Awaiting seconding';
    const href = kind === 'referendum'
        ? '/democracy?ref=' + payload.refIndex
        : '/democracy?proposal=' + payload.index;
    const idx = kind === 'referendum' ? payload.refIndex : payload.index;

    const html = `
        <div class="governance-banner ${kind}" role="status">
            <i class='bx bx-bell governance-banner-icon'></i>
            <div class="governance-banner-body">
                <strong>New ${label}</strong>
                <span class="governance-banner-subtitle">${subtitle} — click to view and vote.</span>
            </div>
            <a class="governance-banner-cta" href="${href}" data-spa-link="true">View</a>
            <button type="button" class="governance-banner-cta governance-banner-cta-secondary"
                data-email-subscribe="banner" title="Get email alerts for governance events">
                <i class='bx bx-envelope'></i> Email alerts
            </button>
            <button type="button" class="governance-banner-close" aria-label="Dismiss"
                data-gov-banner-close="${kind}" data-gov-banner-idx="${idx}">
                <i class='bx bx-x'></i>
            </button>
        </div>`;

    // Build the element from the HTML string and stamp the id so we can find
    // it again to replace on the next poll. Using <template> avoids the
    // .innerHTML wrapping div that #governance-notice-zone would otherwise
    // accumulate around each banner.
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html.trim();
    const node = tmpl.content.firstChild;
    node.id = ID;
    if (el) el.replaceWith(node);
    else zone.appendChild(node);
}

function removeGovernanceBanner(kind) {
    const el = document.getElementById('gov-banner-' + kind);
    if (el) el.remove();
}

function showGovernanceToast(message, href) {
    let zone = document.getElementById('governance-toast-zone');
    if (!zone) {
        zone = document.createElement('div');
        zone.id = 'governance-toast-zone';
        document.body.appendChild(zone);
    }
    const toast = document.createElement('div');
    toast.className = 'governance-toast';
    toast.innerHTML = `
        <i class='bx bx-bell'></i>
        <a href="${href}" data-spa-link="true" class="governance-toast-msg">${message}</a>
        <button type="button" class="governance-toast-close" aria-label="Dismiss">
            <i class='bx bx-x'></i>
        </button>`;
    zone.appendChild(toast);
    const dismiss = () => {
        if (!toast.parentNode) return;
        toast.classList.add('dismissing');
        setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 250);
    };
    toast.querySelector('.governance-toast-close').addEventListener('click', dismiss);
    setTimeout(dismiss, 6000);
}

// Global click handler for governance banner close buttons + SPA links.
// Attached once at startup; data-attribute lookup is cheap.
document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-gov-banner-close]');
    if (closeBtn) {
        const kind = closeBtn.getAttribute('data-gov-banner-close');
        const idx  = parseInt(closeBtn.getAttribute('data-gov-banner-idx') || '0', 10);
        if (kind === 'referendum') setLsNumber('pdex_gov_banner_dismissed_ref', idx);
        else if (kind === 'proposal') setLsNumber('pdex_gov_banner_dismissed_proposal', idx);
        removeGovernanceBanner(kind);
        e.preventDefault();
        return;
    }
});

// ─── Email-alerts subscribe modal ────────────────────────────────────────────
// One reusable modal driven by openEmailSubscribeModal(source). source is
// recorded on the backend so we can see which CTA is converting.
//
// Two view states:
//   1. Form — email input + checkbox grid + Subscribe button.
//   2. Success — "Check your inbox" message + Close button.

function openEmailSubscribeModal(source = 'unknown') {
    const modal = document.getElementById('email-subscribe-modal');
    const content = document.getElementById('email-subscribe-content');
    if (!modal || !content) return;
    content.innerHTML = renderEmailSubscribeForm(source);
    modal.style.display = 'flex';
    // Focus the email field for quick entry.
    const inp = content.querySelector('#email-subscribe-input');
    if (inp) setTimeout(() => inp.focus(), 80);
    wireEmailSubscribeForm(source);
}

function closeEmailSubscribeModal() {
    const modal = document.getElementById('email-subscribe-modal');
    if (modal) modal.style.display = 'none';
}

function renderEmailSubscribeForm(source) {
    // Default prefs match DEFAULT_EMAIL_PREFS on the backend — all governance
    // event types on by default since that's why people sign up. Network
    // milestones default off because they're more operator-focused.
    return `
        <h2 style="margin:0 0 10px;color:var(--text-primary,#fff);font-size:1.3rem;display:flex;align-items:center;gap:8px;">
            <i class='bx bx-envelope' style="color:var(--brand-secondary,#00c4ff)"></i>
            Email me when&hellip;
        </h2>
        <p style="margin:0 0 18px;color:var(--text-secondary,rgba(255,255,255,0.65));font-size:0.9rem;line-height:1.45;">
            Get a short email when on-chain governance events happen. Double opt-in, one-click unsubscribe.
        </p>
        <div id="email-subscribe-error" style="display:none;margin-bottom:14px;padding:10px 12px;background:rgba(255,82,82,0.12);border:1px solid rgba(255,82,82,0.4);border-radius:8px;color:#ffb4b4;font-size:0.86rem;"></div>
        <form id="email-subscribe-form" novalidate>
            <label for="email-subscribe-input" style="display:block;margin-bottom:6px;color:var(--text-secondary,rgba(255,255,255,0.7));font-size:0.85rem;">Email address</label>
            <input type="email" id="email-subscribe-input" required autocomplete="email"
                placeholder="you@example.com"
                style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#fff;font-size:0.95rem;margin-bottom:18px;">

            <fieldset style="border:0;padding:0;margin:0 0 14px;">
                <legend style="color:var(--text-secondary,rgba(255,255,255,0.7));font-size:0.85rem;padding:0;margin-bottom:8px;">Governance</legend>
                <label class="email-pref"><input type="checkbox" data-pref-path="governance.newReferendum" checked> New referendum opens for voting</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="governance.newProposal" checked> New public proposal tabled</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="governance.closingReminder" checked> 24-hour reminder before a referendum closes</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="governance.referendumResult"> Referendum result (passed / failed)</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="governance.treasuryProposal"> Treasury proposal activity</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="governance.councilMotion"> Council motion activity</label>
            </fieldset>
            <fieldset style="border:0;padding:0;margin:0 0 18px;">
                <legend style="color:var(--text-secondary,rgba(255,255,255,0.7));font-size:0.85rem;padding:0;margin-bottom:8px;">Network milestones</legend>
                <label class="email-pref"><input type="checkbox" data-pref-path="network.runtimeUpgrade"> Runtime upgrade</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="network.eraBoundary"> Era boundary summary</label>
                <label class="email-pref"><input type="checkbox" data-pref-path="network.chainStalled"> Chain stalled alert (ops)</label>
            </fieldset>

            <div style="display:flex;gap:10px;align-items:center;margin-top:10px;">
                <button type="submit" id="email-subscribe-submit"
                    style="flex:1;padding:12px;background:var(--brand-primary,#E6007A);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:0.95rem;">
                    Subscribe
                </button>
                <button type="button" id="email-subscribe-cancel"
                    style="padding:12px 18px;background:transparent;color:var(--text-secondary,rgba(255,255,255,0.7));border:1px solid rgba(255,255,255,0.15);border-radius:8px;cursor:pointer;font-size:0.92rem;">
                    Cancel
                </button>
            </div>
            <p style="margin:14px 0 0;font-size:0.78rem;color:var(--text-muted,rgba(255,255,255,0.45));line-height:1.45;">
                We only use your address to send the alerts you've selected. See <a href="/privacy" data-spa-link="true" style="color:var(--brand-secondary,#00c4ff);">privacy</a> for details. One-click unsubscribe is in every email.
            </p>
        </form>
    `;
}

function wireEmailSubscribeForm(source) {
    const form = document.getElementById('email-subscribe-form');
    const cancel = document.getElementById('email-subscribe-cancel');
    if (cancel) cancel.addEventListener('click', closeEmailSubscribeModal);
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = document.getElementById('email-subscribe-error');
        const submitBtn = document.getElementById('email-subscribe-submit');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
        const email = (document.getElementById('email-subscribe-input').value || '').trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (err) { err.textContent = 'Please enter a valid email address.'; err.style.display = 'block'; }
            return;
        }
        // Collect prefs from checkboxes; merge into the nested structure
        // the backend expects.
        const prefs = { governance: {}, network: {} };
        form.querySelectorAll('input[type="checkbox"][data-pref-path]').forEach(cb => {
            const path = cb.getAttribute('data-pref-path');
            const [section, key] = path.split('.');
            if (!prefs[section]) prefs[section] = {};
            prefs[section][key] = !!cb.checked;
        });

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }
        try {
            const res = await fetch('/api/email/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, prefs, source })
            });
            const data = await parseJsonResponse(res);
            if (!res.ok || data.error) throw new Error(data.error || 'Could not subscribe');
            renderEmailSubscribeSuccess(email, data.status);
        } catch (e2) {
            if (err) { err.textContent = e2.message || String(e2); err.style.display = 'block'; }
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Subscribe'; }
        }
    });
}

function renderEmailSubscribeSuccess(email, status) {
    const content = document.getElementById('email-subscribe-content');
    if (!content) return;
    if (status === 'already-confirmed') {
        content.innerHTML = `
            <h2 style="margin:0 0 12px;color:var(--text-primary,#fff);font-size:1.3rem;">You're already subscribed</h2>
            <p style="color:var(--text-secondary,rgba(255,255,255,0.7));line-height:1.5;">
                We already have <strong>${stakingEscapeHtml(email)}</strong> on the list. You'll keep receiving the alerts you've signed up for.
            </p>
            <button type="button" id="email-subscribe-done" style="margin-top:18px;padding:11px 22px;background:var(--brand-primary,#E6007A);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Done</button>
        `;
    } else {
        content.innerHTML = `
            <h2 style="margin:0 0 12px;color:var(--text-primary,#fff);font-size:1.3rem;display:flex;align-items:center;gap:8px;">
                <i class='bx bx-mail-send' style="color:#5cf591"></i> Check your inbox
            </h2>
            <p style="color:var(--text-secondary,rgba(255,255,255,0.75));line-height:1.55;">
                We sent a confirmation link to <strong>${stakingEscapeHtml(email)}</strong>. Click it to start receiving alerts. The link is valid for 24 hours; you can request a new one any time from this modal.
            </p>
            <button type="button" id="email-subscribe-done" style="margin-top:18px;padding:11px 22px;background:var(--brand-primary,#E6007A);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Done</button>
        `;
    }
    const done = document.getElementById('email-subscribe-done');
    if (done) done.addEventListener('click', closeEmailSubscribeModal);
}

// Top-level close button + backdrop click handler.
document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'close-email-subscribe-modal') {
        closeEmailSubscribeModal();
        return;
    }
    if (e.target && e.target.id === 'email-subscribe-modal') {
        closeEmailSubscribeModal();
        return;
    }
    // Open from any data-attr trigger anywhere on the page.
    const trigger = e.target.closest && e.target.closest('[data-email-subscribe]');
    if (trigger) {
        e.preventDefault();
        openEmailSubscribeModal(trigger.getAttribute('data-email-subscribe') || 'unknown');
    }
});

function subscribeNewBlocks(api) {
    api.rpc.chain.subscribeNewHeads(async (header) => {
        const blockNumber = header.number.toNumber();
        const blockHash = header.hash.toHex();

        const newBlock = {
            number: blockNumber,
            hash: blockHash,
            extrinsics: "-",
            timestamp: Date.now()
        };

        // Fetch the full block to get extrinsics count and transactions
        api.rpc.chain.getBlock(blockHash).then(signedBlock => {
            newBlock.extrinsics = signedBlock.block.extrinsics.length;
            renderBlocks(); // re-render when we have the count

            // Extract transactions
            signedBlock.block.extrinsics.forEach((ex) => {
                const summary = getLiveExtrinsicAmountSummary(ex);
                if (summary.amount === '-') return;
                const tx = {
                    hash: ex.hash.toHex(),
                    from: ex.isSigned ? ex.signer.toString() : "System",
                    to: summary.to,
                    block: blockNumber,
                    method: summary.method,
                    amount: summary.amount,
                    numericAmount: summary.numericAmount,
                    value: '-',
                    status: 'success',
                    timestamp: Date.now()
                };
                if (!transactions.find(existing => existing.hash === tx.hash)) transactions.unshift(tx);
                if (currentTxSort.field === null) sortTransactions(); // Keeps it sorted if needed
                if (transactions.length > TX_ROW_CAP) transactions.pop();
            });
            renderTransactions();
            if (document.querySelector('.transactions-page').style.display === 'flex') {
                renderFullTransactions();
            }

            let author = "System";
            const digest = signedBlock.block.header.digest;
            const preRuntime = digest.logs.find(l => l.isPreRuntime);
            if (preRuntime) {
                author = "Validator " + String(preRuntime.value.toHex()).substring(0, 8);
            }

            const completedBlock = {
                number: blockNumber,
                hash: signedBlock.block.header.hash.toHex(),
                author: author,
                timestamp: Date.now(),
                extrinsics: signedBlock.block.extrinsics.length,
                events: 0 // <--- FIX HERE
            };

            blocks.unshift(completedBlock);
            if (blocks.length > 10) blocks.pop();
            renderBlocks();

            const newFullBlock = {
                number: blockNumber,
                hash: signedBlock.block.header.hash.toHex(),
                authorAddress: author,
                authorName: author,
                extrinsicsCount: signedBlock.block.extrinsics.length,
                eventsCount: 0, // <--- FIX HERE
                timestamp: Date.now()
            };

            fullBlocks.unshift(newFullBlock);
            if (fullBlocks.length > 200) fullBlocks.pop();
            if (document.querySelector('.blocks-page').style.display === 'flex') {
                renderFullBlocks();
            }
        }).catch(console.error);
    });
}

// Audit F-067: was Number(balance)/1e12 — a codec u128 above 2^53 planck
// (~9007 PDEX) truncates BEFORE the division, so a live whale transfer painted
// a subtly wrong amount. BigInt keeps whole tokens exact; only the sub-planck
// fraction rides a float.
function formatLivePDEX(balance) {
    try {
        const planck = BigInt(balance.toString().replace(/,/g, ''));
        const whole = planck / 1000000000000n;
        const frac = Number(planck % 1000000000000n) / 1e12;
        return Number(whole) + frac;
    } catch (e) {
        return Number(balance) / 10 ** 12;
    }
}

function getLiveExtrinsicAmountSummary(ex) {
    const method = `${ex.method.section}.${ex.method.method}`;
    const args = ex.method.args || [];
    let to = method;
    let numericAmount = 0;
    let amount = '-';

    if (ex.method.section === 'balances') {
        if (['transfer', 'transferAllowDeath', 'transferKeepAlive'].includes(ex.method.method) && args.length >= 2) {
            to = args[0].toString();
            numericAmount = formatLivePDEX(args[1]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'forceTransfer' && args.length >= 3) {
            to = args[1].toString();
            numericAmount = formatLivePDEX(args[2]);
            amount = `${numericAmount.toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX`;
        } else if (ex.method.method === 'transferAll' && args.length >= 1) {
            to = args[0].toString();
            amount = 'All';
        }
    }

    return { method, to, amount, numericAmount };
}

// --- Rendering ---

// Blocks reach this list from two sources that name the same field
// differently: the live WS path sets `extrinsics` (see newBlock above), while
// rows loaded from the indexer API set `extrinsicsCount`. Reading only the
// former rendered a literal "Extrinsics: undefined" on every API-sourced row,
// which is what the home page showed for all but the newest block.
function renderBlocks() {
    blocksListEl.innerHTML = '';
    blocks.forEach((block, index) => {
        const el = document.createElement('div');
        el.className = `list-item ${index === 0 ? 'animate-in' : ''}`;
        el.innerHTML = `
            <div class="item-main">
                <div class="item-icon"><i class='bx bx-cube-alt'></i></div>
                <div class="item-details">
                    <a href="/block/${block.number}" class="item-title">${block.number}</a>
                    <div class="item-sub">
                        Hash: <a href="/block/${block.hash}" class="item-link">${block.hash.substring(0, 10)}...</a>
                    </div>
                    <div class="item-sub">
                        Extrinsics: ${block.extrinsics ?? block.extrinsicsCount ?? '—'}
                    </div>
                </div>
            </div>
            <div class="item-meta">
                <span class="item-time">${timeAgo(block.timestamp)}</span>
            </div>
        `;
        blocksListEl.appendChild(el);
    });
}

function renderTransactions() {
    transactionsListEl.innerHTML = '';
    const financialTransactions = financialTransactionRows(transactions);
    if (financialTransactions.length === 0) {
        transactionsListEl.innerHTML = '<div style="padding: 20px; color: var(--text-muted); font-size: 0.9rem;">Waiting for financial transactions...</div>';
        return;
    }
    financialTransactions.forEach((tx, index) => {
        const el = document.createElement('div');
        el.className = `list-item ${index === 0 ? 'animate-in' : ''}`;

        const shortHash = tx.hash.substring(0, 10) + '...';
        const shortFrom = tx.from.substring(0, 8) + '...';
        let shortTo = tx.to.toString();
        if (shortTo.length > 10) shortTo = shortTo.substring(0, 8) + '...';
        // Belt-and-braces: link to /block/ if the row is event-derived OR the
        // hash isn't a real tx hash (defensive against any new sources that
        // forget to set eventDerived).
        const titleHtml = (tx.eventDerived || !looksLikeTxHash(tx.hash))
            ? `<a href="/block/${tx.block}" class="item-title">${shortHash}</a>`
            : `<a href="/tx/${tx.block}/${tx.hash}" class="item-title">${shortHash}</a>`;

        el.innerHTML = `
            <div class="item-main">
                <div class="item-icon"><i class='bx bx-transfer'></i></div>
                <div class="item-details">
                    ${titleHtml}
                    <div class="item-sub">
                        From: ${tx.from === 'System' ? shortFrom : `<a href="/account/${tx.from}" class="item-link">${shortFrom}</a>`}
                    </div>
                    <div class="item-sub">
                        To: ${tx.to === tx.amount ? shortTo : `<a href="/account/${tx.to}" class="item-link">${shortTo}</a>`}
                    </div>
                </div>
            </div>
            <div class="item-meta">
                <span class="item-amount">${tx.amount}</span>
                <span class="item-time">${timeAgo(tx.timestamp)} / Block <a href="/block/${tx.block}" class="item-link">${tx.block}</a></span>
            </div>
        `;
        transactionsListEl.appendChild(el);
    });
}

let currentValidators = [];
let validatorDisplayLimit = 50;

async function fetchValidators() {
    if (validatorsFetched) return;
    try {
        if (!validatorsTableApi) {
            validatorsListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Fetching from backend indexer…</div>';
        }

        const response = await fetch('/api/validators');
        const data = await response.json();

        if (data.status === 'Initializing' || data.status === 'Syncing' && data.validators.length === 0) {
            if (!validatorsTableApi) {
                validatorsListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: orange;">Indexer is syncing data from Polkadex node, please wait…</div>';
            }
            setTimeout(() => { validatorsFetched = false; fetchValidators(); }, 3000);
            return;
        }

        validatorCountEl.innerText = `${data.totalCount} Active`;
        currentValidators = data.validators;
        validatorsFetched = true;
        renderValidators();

    } catch (err) {
        console.error("Error fetching validators:", err);
        if (!validatorsTableApi) {
            validatorsListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</div>';
        }
    }
}

function renderValidators() {
    if (!validatorsListEl) return;
    const rows = currentValidators || [];

    if (!validatorsTableApi) {
        validatorsTableApi = makeTable({
            container: validatorsListEl,
            rows,
            defaultSort: { key: 'totalStake', dir: 'desc' },
            globalSearch: true,
            summarySuffix: 'validators',
            emptyMessage: 'No validators in the indexer yet.',
            columns: [
                {
                    key: 'address', label: 'Address', searchable: true,
                    sort: (a, b) => String(a.address || '').localeCompare(String(b.address || '')),
                    format: row => {
                        const a = row.address || '';
                        const short = a.substring(0, 8) + '…' + a.substring(a.length - 8);
                        return `<a href="/validator/${a}" class="address-cell item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'name', label: 'Identity', searchable: true,
                    sort: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
                    filter: { type: 'text', placeholder: 'Identity name…' },
                    format: row => `<a href="/validator/${row.address}" class="item-link">${stakingEscapeHtml(row.name || '')}</a>`
                },
                {
                    key: 'totalStake', label: 'Total Stake',
                    sort: (a, b) => (a.totalStake || 0) - (b.totalStake || 0),
                    format: row => `${Number(row.totalStake).toLocaleString('en-US', { maximumFractionDigits: 2 })} <span class="unit">PDEX</span>`
                },
                {
                    key: 'commission', label: 'Commission',
                    sort: (a, b) => (a.commission || 0) - (b.commission || 0),
                    format: row => {
                        let html = `${Number(row.commission).toFixed(2)}%`;
                        if (row.commission > 50) html += ` <span class="badge" style="background: var(--error);">HIGH RISK</span>`;
                        return html;
                    }
                },
                {
                    // Audit F-044: this column was labelled "Real APY (30d)"
                    // while the number is the nominal max APY adjusted for the
                    // validator's CURRENT commission — a projection, not a
                    // realized 30-day average. Label what it is.
                    key: 'avg30DayApy', label: 'Est. APY (current commission)',
                    sort: (a, b) => (a.avg30DayApy || 0) - (b.avg30DayApy || 0),
                    format: row => `<span style="color: var(--success); font-weight: 500;">${Number(row.avg30DayApy).toFixed(2)}%</span>`
                },
                {
                    key: 'realApy', label: 'Now vs Real',
                    sort: (a, b) => (a.realApy || 0) - (b.realApy || 0),
                    format: row => `${Number(row.realApy).toFixed(2)}% <span class="unit">/</span> <span style="color: var(--success);">${Number(row.avg30DayApy).toFixed(2)}%</span>`
                }
            ]
        });
    } else {
        validatorsTableApi.setData(rows);
    }

    const showMoreBtn = document.getElementById('show-more-btn');
    if (showMoreBtn) showMoreBtn.style.display = 'none';
}

let currentSort = { field: null, asc: true };

function sortValidators() {
    if (!currentSort.field) return;
    currentValidators.sort((a, b) => {
        let valA = a[currentSort.field];
        let valB = b[currentSort.field];

        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return currentSort.asc ? -1 : 1;
        if (valA > valB) return currentSort.asc ? 1 : -1;
        return 0;
    });
}

document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (currentSort.field === field) {
            currentSort.asc = !currentSort.asc;
        } else {
            currentSort.field = field;
            // Default descending for numbers (AP/Comm), ascending for strings (Identity)
            currentSort.asc = field === 'name' ? true : false;
        }

        // update icons
        document.querySelectorAll('.sortable i').forEach(i => i.className = 'bx bx-sort');
        const icon = th.querySelector('i');
        icon.className = currentSort.asc ? 'bx bx-sort-up' : 'bx bx-sort-down';

        sortValidators();
        renderValidators();
    });
});

let holdersFetched = false;
let currentHolders = [];
let holderDisplayLimit = 50;
let currentHolderSort = { field: 'rank', asc: true };

async function fetchHolders() {
    if (holdersFetched) return;
    try {
        if (!holdersListEl) return;
        if (!holdersTableApi) {
            holdersListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Fetching from backend indexer…</div>';
        }

        const response = await fetch('/api/holders');
        const data = await response.json();

        if (data.status === 'Initializing' || data.status === 'Syncing' && data.holders.length === 0) {
            if (!holdersTableApi) {
                holdersListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: orange;">Indexer is syncing data from Polkadex node, please wait…</div>';
            }
            setTimeout(() => { holdersFetched = false; fetchHolders(); }, 3000);
            return;
        }

        if (holderCountEl) holderCountEl.innerText = `${data.holders.length} Top Holders`;
        currentHolders = data.holders;
        holdersFetched = true;
        renderHolders();

    } catch (err) {
        console.error("Error fetching holders:", err);
        if (!holdersTableApi) {
            holdersListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</div>';
        }
    }
}

function renderHolders() {
    if (!holdersListEl) return;
    const rows = currentHolders || [];

    if (!holdersTableApi) {
        holdersTableApi = makeTable({
            container: holdersListEl,
            rows,
            defaultSort: { key: 'rank', dir: 'asc' },
            globalSearch: true,
            summarySuffix: 'holders',
            emptyMessage: 'No holder data in the indexer yet.',
            // Polkadex has thousands of distinct PDEX holders; paginate so the
            // page stays snappy even at the long-tail end of the ranking.
            pagination: { pageSize: 50, showMoreMax: 200 },
            columns: [
                {
                    key: 'rank', label: 'Rank',
                    sort: (a, b) => (a.rank || 0) - (b.rank || 0),
                    format: row => `#${row.rank}`
                },
                {
                    key: 'address', label: 'Address', searchable: true,
                    sort: (a, b) => String(a.address || '').localeCompare(String(b.address || '')),
                    format: row => {
                        const a = row.address || '';
                        const short = a.substring(0, 8) + '…' + a.substring(a.length - 8);
                        return `<a href="/account/${a}" class="address-cell item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'name', label: 'Identity', searchable: true,
                    sort: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
                    filter: { type: 'text', placeholder: 'Identity name…' },
                    format: row => `<a href="/account/${row.address}" class="item-link">${stakingEscapeHtml(row.name || '')}</a>`
                },
                {
                    key: 'balance', label: 'Balance',
                    sort: (a, b) => (a.balance || 0) - (b.balance || 0),
                    format: row => `${Number(row.balance).toLocaleString('en-US', { maximumFractionDigits: 2 })} <span class="unit">PDEX</span>`
                },
                {
                    key: 'share', label: 'Percentage',
                    sort: (a, b) => (a.share || 0) - (b.share || 0),
                    format: row => `<span style="color: var(--brand-primary); font-weight: 500;">${Number(row.share).toFixed(4)}%</span>`
                }
            ]
        });
    } else {
        holdersTableApi.setData(rows);
    }

    const showMoreBtn = document.getElementById('show-more-holders-btn');
    if (showMoreBtn) showMoreBtn.style.display = 'none';
}

function sortHolders() {
    if (!currentHolderSort.field) return;
    currentHolders.sort((a, b) => {
        let valA = a[currentHolderSort.field];
        let valB = b[currentHolderSort.field];

        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return currentHolderSort.asc ? -1 : 1;
        if (valA > valB) return currentHolderSort.asc ? 1 : -1;
        return 0;
    });
}

document.querySelectorAll('.sortable-holder').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (currentHolderSort.field === field) {
            currentHolderSort.asc = !currentHolderSort.asc;
        } else {
            currentHolderSort.field = field;
            currentHolderSort.asc = field === 'rank' || field === 'name';
        }

        document.querySelectorAll('.sortable-holder i').forEach(i => i.className = 'bx bx-sort');
        const icon = th.querySelector('i');
        icon.className = currentHolderSort.asc ? 'bx bx-sort-up' : 'bx bx-sort-down';

        sortHolders();
        renderHolders();
    });
});

let currentTxSort = { field: null, asc: false };

function sortTransactions() {
    if (!currentTxSort.field) return;
    transactions.sort((a, b) => {
        let valA = a[currentTxSort.field];
        let valB = b[currentTxSort.field];
        if (valA < valB) return currentTxSort.asc ? -1 : 1;
        if (valA > valB) return currentTxSort.asc ? 1 : -1;
        return 0;
    });
}

async function fetchTransactions(force = false) {
    if (txFetched && !force) return;
    try {
        if (!fullTransactionsListEl) return;
        if ((!force || transactions.length === 0) && !transactionsTableApi) {
            fullTransactionsListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Fetching from backend indexer…</div>';
        }

        const response = await fetch('/api/transactions');
        const data = await response.json();

        if (data.status === 'Initializing' || (data.status === 'Syncing' && data.transactions.length === 0)) {
            fullTransactionsListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: orange;">Indexer is crawling historical blocks, please wait…</div>';
            setTimeout(() => { txFetched = false; fetchTransactions(); }, 5000);
            return;
        }

        // F-017: merge, don't replace. refreshRecentViews calls this with
        // force=true every 12s, so a plain assignment discarded both the WS
        // heads and every row paged in by "Load Older 100".
        transactions = mergeRows({
            local: transactions,
            snapshot: financialTransactionRows(data.transactions),
            keyOf: tx => tx.hash,
            rankOf: txRank,
            cap: TX_ROW_CAP
        });
        transactionCacheMeta = {
            latestScannedBlock: data.latestScannedBlock,
            oldestScannedBlock: data.oldestScannedBlock,
            scannedBlocks: data.scannedBlocks,
            backfillComplete: !!data.backfillComplete
        };
        txFetched = true;
        sortTransactions();
        renderFullTransactions();

    } catch (err) {
        console.error("Error fetching transactions:", err);
        if (!transactionsTableApi) {
            fullTransactionsListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</div>';
        }
    }
}

function renderFullTransactions() {
    if (!fullTransactionsListEl) return;
    const rows = financialTransactionRows(transactions).map(normalizeTransactionRow);

    if (!transactionsTableApi) {
        transactionsTableApi = makeTable({
            container: fullTransactionsListEl,
            rows,
            defaultSort: { key: 'timestamp', dir: 'desc' },
            globalSearch: true,
            summarySuffix: 'transactions',
            emptyMessage: 'No recent financial transactions found.',
            // Bounded by TX_CACHE_LIMIT (500) server-side today, but the chain
            // accumulates indefinitely — show-more first, paginate above 200.
            pagination: { pageSize: 50, showMoreMax: 200 },
            columns: [
                {
                    key: 'hash', label: 'Txn Hash', searchable: true,
                    sort: (a, b) => String(a.hash || '').localeCompare(String(b.hash || '')),
                    format: row => {
                        const short = (row.hash || '').substring(0, 10) + '…';
                        // Same belt-and-braces: send event-id rows to the
                        // block, where the event actually lives.
                        return (row.eventDerived || !looksLikeTxHash(row.hash))
                            ? `<a href="/block/${row.block}" class="item-link">${stakingEscapeHtml(short)}</a>`
                            : `<a href="/tx/${row.block}/${row.hash}" class="item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'from', label: 'From', searchable: true,
                    sort: (a, b) => String(a.from || '').localeCompare(String(b.from || '')),
                    filter: { type: 'text', placeholder: 'From address…' },
                    format: row => {
                        const short = String(row.from || '').substring(0, 8) + '…';
                        return row.from === 'System'
                            ? stakingEscapeHtml(short)
                            : `<a href="/account/${row.from}" class="item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'to', label: 'To', searchable: true,
                    sort: (a, b) => String(a.to || '').localeCompare(String(b.to || '')),
                    filter: { type: 'text', placeholder: 'To address…' },
                    format: row => {
                        const t = String(row.to);
                        const short = t.length > 15 ? t.substring(0, 8) + '…' : t;
                        return row.to === row.amount
                            ? stakingEscapeHtml(short)
                            : `<a href="/account/${row.to}" class="item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'timestamp', label: 'Date',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => {
                        const d = formatLocalDateTime(row.timestamp);
                        return `<span style="color: var(--text-secondary);">${stakingEscapeHtml(timeAgo(row.timestamp))}<br><small>${stakingEscapeHtml(d)}</small></span>`;
                    }
                },
                {
                    key: 'block', label: 'Block', searchable: true,
                    sort: (a, b) => (a.block || 0) - (b.block || 0),
                    format: row => `<a href="/block/${row.block}" class="item-link">${row.block}</a>`
                },
                {
                    key: 'numericAmount', label: 'Amount',
                    sort: (a, b) => (a.numericAmount || 0) - (b.numericAmount || 0),
                    format: row => `<strong>${stakingEscapeHtml(String(row.amount || ''))}</strong>`
                },
                {
                    key: 'value', label: 'Value',
                    format: row => `<span style="color: var(--text-secondary);">${stakingEscapeHtml(String(row.value || ''))}</span>`
                },
                {
                    key: 'status', label: 'Status',
                    sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
                    filter: { type: 'select', options: ['success', 'failed'] },
                    format: row => `<span class="badge" style="background: ${row.status === 'failed' ? 'var(--error)' : 'var(--success)'};">${stakingEscapeHtml(row.status || '')}</span>`
                }
            ]
        });
    } else {
        transactionsTableApi.setData(rows);
    }

    if (txCountEl) {
        // F-008's UI half: while the genesis-ward backfill is still walking,
        // say so instead of letting a bare record count imply all-time
        // coverage. innerText — this is plain text, never markup.
        const meta = transactionCacheMeta || {};
        const coverage = meta.backfillComplete
            ? ''
            : (meta.oldestScannedBlock
                ? ` · history before block ${Number(meta.oldestScannedBlock).toLocaleString('en-US')} still indexing`
                : '');
        txCountEl.innerText = `${rows.length} Records${coverage}`;
    }
    updateOlderFinancialTxButton(rows.length === 0);
    // makeTable's filter bar replaces the need for client-side "Show More" —
    // all loaded rows are shown unless the user filters them out. Hide the
    // legacy button so it doesn't sit there with nothing to do.
    const showMoreTxBtn = document.getElementById('show-more-tx-btn');
    if (showMoreTxBtn) showMoreTxBtn.style.display = 'none';
}

function updateOlderFinancialTxButton(show) {
    const loadOlderBtn = document.getElementById('load-older-financial-tx-btn');
    if (!loadOlderBtn) return;
    // F-079: once the server reports end-of-chain there is nothing older —
    // keep the button visible but inert and say why, rather than leaving a
    // button that silently does nothing (which is what a reset cursor felt
    // like from the outside).
    if (olderTxReachedGenesis) {
        loadOlderBtn.style.display = 'inline-block';
        loadOlderBtn.disabled = true;
        loadOlderBtn.innerText = 'Reached the start of the chain';
        return;
    }
    loadOlderBtn.style.display = show ? 'inline-block' : 'none';
    loadOlderBtn.disabled = isLoadingOlderTx;
    loadOlderBtn.innerText = isLoadingOlderTx ? 'Loading older financial tx...' : 'Load Older 100 Financial Tx';
}

function normalizeTransactionRow(tx) {
    if (tx && typeof tx.amount === 'string' && tx.amount.includes('.') && (!tx.method || tx.value === 'System')) {
        return { ...tx, method: tx.method || tx.amount, to: tx.method || tx.amount, amount: '-', numericAmount: 0, value: '-' };
    }
    return tx;
}

function isFinancialTransactionRow(tx) {
    if (!tx || tx.amount === '-' || tx.amount === undefined || tx.amount === null) return false;
    if (tx.method) {
        return [
            'balances.transfer',
            'balances.transferAllowDeath',
            'balances.transferKeepAlive',
            'balances.forceTransfer',
            'balances.transferAll',
            'balances.Transfer'
        ].includes(tx.method);
    }
    return tx.amount === 'All' || (typeof tx.amount === 'string' && tx.amount.includes('PDEX'));
}

function financialTransactionRows(rows) {
    return (rows || []).map(normalizeTransactionRow).filter(isFinancialTransactionRow);
}

async function loadOlderFinancialTransactions() {
    if (isLoadingOlderTx) return;
    isLoadingOlderTx = true;
    updateOlderFinancialTxButton(true);
    try {
        const currentFinancialTx = financialTransactionRows(transactions);
        const oldestLoadedBlock = currentFinancialTx.length > 0 ? Math.min(...currentFinancialTx.map(tx => tx.block)) : null;
        // F-079 client half: `||` treats a legitimate 0 as absent. Genesis is
        // block 0, so the old chain reset the cursor to the head there.
        const firstDefined = (...vals) => vals.find(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
        const beforeBlock = firstDefined(olderTxBeforeBlock, oldestLoadedBlock, transactionCacheMeta.oldestScannedBlock);
        const query = new URLSearchParams({ limit: '100' });
        if (beforeBlock !== undefined) query.set('beforeBlock', String(beforeBlock));
        // F-078: resume inside a height the previous page only partly returned.
        if (olderTxResume && Number.isFinite(Number(olderTxResume.block))) {
            query.set('resumeBlock', String(olderTxResume.block));
            query.set('resumeCount', String(olderTxResume.count));
        }

        const response = await fetch(`/api/transactions/older?${query.toString()}`);
        const data = await parseJsonResponse(response);
        if (data.error) throw new Error(data.error);

        // End of chain: stop, and say so, instead of wrapping to the head.
        if (data.endOfChain) {
            olderTxReachedGenesis = true;
        }
        if (data.nextBeforeBlock !== null && data.nextBeforeBlock !== undefined) {
            olderTxBeforeBlock = data.nextBeforeBlock;
        }
        olderTxResume = data.resumeInBlock || null;
        const existingHashes = new Set(transactions.map(tx => tx.hash));
        const olderRows = financialTransactionRows(data.transactions).filter(tx => !existingHashes.has(tx.hash));
        // Append is right here (these rows are strictly older than what we
        // hold), but the next 12s poll used to undo it — see the merge in
        // fetchTransactions, which now keeps anything below the snapshot's
        // oldest block.
        transactions = financialTransactionRows([...transactions, ...olderRows]);
        sortTransactions();
        renderFullTransactions();

        if (olderRows.length === 0) {
            // No new rows came back — surface a transient message above the table
            // without nuking the existing rendered table (makeTable owns it now).
            const note = document.getElementById('older-tx-note');
            if (!note) {
                const n = document.createElement('div');
                n.id = 'older-tx-note';
                n.style.cssText = 'text-align:center; padding: 12px; color: var(--text-muted); font-size: 0.85rem;';
                n.textContent = `No financial transactions found in the last ${data.scannedBlocks || 0} older blocks.`;
                if (fullTransactionsListEl && fullTransactionsListEl.parentNode) {
                    fullTransactionsListEl.parentNode.insertBefore(n, fullTransactionsListEl);
                }
            }
            updateOlderFinancialTxButton(true);
        }
    } catch (err) {
        console.error("Error loading older financial transactions:", err);
        // Show the error as a toast-style note rather than wiping the table.
        const errEl = document.createElement('div');
        errEl.style.cssText = 'text-align:center; padding: 12px; color: var(--error); font-size: 0.85rem;';
        errEl.textContent = 'Error loading older financial transactions: ' + (err.message || String(err));
        if (fullTransactionsListEl && fullTransactionsListEl.parentNode) {
            fullTransactionsListEl.parentNode.insertBefore(errEl, fullTransactionsListEl);
            setTimeout(() => { try { errEl.remove(); } catch (e) {} }, 6000);
        }
    } finally {
        isLoadingOlderTx = false;
        updateOlderFinancialTxButton(financialTransactionRows(transactions).length === 0);
    }
}

async function fetchBlocks(force = false) {
    if (blocksFetched && !force) return;
    try {
        if (!fullBlocksListEl) return;
        if ((!force || fullBlocks.length === 0) && !blocksTableApi) {
            fullBlocksListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-muted);">Fetching from backend indexer…</div>';
        }

        const response = await fetch('/api/blocks');
        const data = await response.json();

        // Safety guard: Ensure data.blocks actually exists before checking length
        if (data.error || !data.blocks) throw new Error(data.error || "Blocks cache empty");

        // Audit F-020: spin ONLY while there are no rows. Status alone must
        // not hide data — the backend now reports the real chain_index state,
        // and an index that has rows is renderable regardless of its phase.
        if (data.blocks.length === 0 && (data.status === 'Initializing' || data.status === 'Syncing')) {
            fullBlocksListEl.innerHTML = '<div style="text-align:center; padding: 40px; color: orange;">Indexer is crawling historical blocks, please wait…</div>';
            setTimeout(() => { blocksFetched = false; fetchBlocks(); }, 5000);
            return;
        }

        // F-017: merge so live WS heads survive the 12s poll.
        fullBlocks = mergeRows({
            local: fullBlocks,
            snapshot: data.blocks,
            keyOf: b => b.number,
            rankOf: blockRank,
            cap: 200
        });
        blocksFetched = true;
        renderFullBlocks();

    } catch (err) {
        console.error("Error fetching blocks:", err);
        if (!blocksTableApi) {
            fullBlocksListEl.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--error);">Backend Syncing. Please refresh.</div>`;
        }
    }
}

function renderFullBlocks() {
    if (!fullBlocksListEl) return;
    const rows = fullBlocks || [];

    if (!blocksTableApi) {
        blocksTableApi = makeTable({
            container: fullBlocksListEl,
            rows,
            defaultSort: { key: 'number', dir: 'desc' },
            globalSearch: true,
            summarySuffix: 'blocks',
            emptyMessage: 'No blocks indexed yet.',
            // Chain block count grows monotonically — paginate to keep the
            // DOM bounded as the indexer backfills further into history.
            pagination: { pageSize: 50, showMoreMax: 200 },
            columns: [
                {
                    key: 'number', label: 'Block #', searchable: true,
                    sort: (a, b) => (a.number || 0) - (b.number || 0),
                    format: row => `<a href="/block/${row.number}" class="item-link">${row.number}</a>`
                },
                {
                    key: 'timestamp', label: 'Age',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => `<span style="color: var(--text-secondary);">${stakingEscapeHtml(timeAgo(row.timestamp))}</span>`
                },
                {
                    key: 'authorName', label: 'Author', searchable: true,
                    sort: (a, b) => String(a.authorName || '').localeCompare(String(b.authorName || '')),
                    filter: { type: 'text', placeholder: 'Author name/address…' },
                    format: row => {
                        const name = row.authorName;
                        const addr = row.authorAddress || '';
                        const short = addr.substring(0, 8) + '…';
                        if (name && name !== 'Unknown' && name !== 'System' && !String(name).startsWith('Validator')) {
                            return `<a href="/account/${addr}" class="item-link">${stakingEscapeHtml(name)}</a>`;
                        }
                        return `<a href="/account/${addr}" class="address-cell item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'extrinsicsCount', label: 'Extrinsics',
                    sort: (a, b) => (a.extrinsicsCount || 0) - (b.extrinsicsCount || 0),
                    format: row => `<strong>${row.extrinsicsCount}</strong>`
                },
                {
                    key: 'eventsCount', label: 'Events',
                    sort: (a, b) => (a.eventsCount || 0) - (b.eventsCount || 0),
                    format: row => `<strong>${row.eventsCount}</strong>`
                },
                {
                    key: 'hash', label: 'Hash', searchable: true,
                    format: row => {
                        const short = (row.hash || '').substring(0, 10) + '…';
                        return `<a href="/block/${row.hash}" class="address-cell item-link">${stakingEscapeHtml(short)}</a>`;
                    }
                },
                {
                    key: 'timestampDate', label: 'Date',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => row.timestamp
                        ? `<span style="color: var(--text-secondary);">${stakingEscapeHtml(formatLocalDateTime(row.timestamp))}</span>`
                        : ''
                }
            ]
        });
    } else {
        blocksTableApi.setData(rows);
    }

    if (blockCountEl) blockCountEl.innerText = `${rows.length} Records`;
    // makeTable shows everything that's loaded — legacy Show More button is moot.
    const showMoreBlocksBtn = document.getElementById('show-more-blocks-btn');
    if (showMoreBlocksBtn) showMoreBlocksBtn.style.display = 'none';
}

async function refreshDashboardLists() {
    try {
        const [txRes, bRes] = await Promise.all([
            fetch('/api/transactions').catch(() => null),
            fetch('/api/blocks').catch(() => null)
        ]);

        if (txRes) {
            const txData = await txRes.json();
            if (Array.isArray(txData.transactions)) {
                // F-017: was a straight assignment, which erased any transfer
                // the WebSocket had already shown but the indexer had not yet
                // caught up to — the row vanished ~12s after appearing.
                transactions = mergeRows({
                    local: transactions,
                    snapshot: financialTransactionRows(txData.transactions),
                    keyOf: tx => tx.hash,
                    rankOf: txRank,
                    cap: TX_ROW_CAP
                });
                transactionCacheMeta = {
                    latestScannedBlock: txData.latestScannedBlock,
                    oldestScannedBlock: txData.oldestScannedBlock,
                    scannedBlocks: txData.scannedBlocks
                };
                renderTransactions();
            }
        }
        if (bRes) {
            const bData = await bRes.json();
            if (Array.isArray(bData.blocks)) {
                blocks = mergeRows({
                    local: blocks,
                    snapshot: bData.blocks,
                    keyOf: b => b.number,
                    rankOf: blockRank,
                    cap: 10
                });
                renderBlocks();
            }
        }
    } catch (err) {
        console.error("Error refreshing dashboard lists:", err);
    }
}

function activePageName() {
    const activePage = Array.from(pageSections).find(page => page.style.display !== 'none');
    return activePage ? activePage.getAttribute('data-page') : '';
}

function refreshRecentViews() {
    const activePage = activePageName();
    if (activePage === 'home') refreshDashboardLists(); // F-132: the phantom 'dashboard' alias is gone — no such data-page ever existed
    if (activePage === 'transactions') fetchTransactions(true);
    if (activePage === 'blocks') fetchBlocks(true);
    if (activePage === 'events') fetchEvents(true);
}

async function fetchEvents(force = false) {
    if (eventsFetched && !force) return;
    try {
        if (!fullEventsListEl) return;
        if (!force || fullEvents.length === 0) {
            fullEventsListEl.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching from backend indexer...</div>';
        }

        const response = await fetch('/api/events');
        const data = await response.json();

        // Audit F-020: spin only while there are no rows (see fetchBlocks).
        if (data.events.length === 0 && (data.status === 'Initializing' || data.status === 'Syncing')) {
            fullEventsListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: orange;">Indexer is crawling historical events, please wait...</div>';
            setTimeout(() => { eventsFetched = false; fetchEvents(); }, 5000);
            return;
        }

        fullEvents = data.events;
        eventsFetched = true;
        renderFullEvents();

    } catch (err) {
        console.error("Error fetching events:", err);
        fullEventsListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--error);">Error reaching backend indexer. Is node server.js running?</div>';
    }
}

function renderFullEvents() {
    if (!fullEventsListEl) return;
    const rows = fullEvents || [];

    // Pre-compute the section + method select options from the data so the
    // user can filter to "balances/Transfer", "staking/Rewarded", etc.
    const uniqueSections = Array.from(new Set(rows.map(r => r.section).filter(Boolean))).sort();
    const uniqueMethods  = Array.from(new Set(rows.map(r => r.method).filter(Boolean))).sort();

    if (!eventsTableApi) {
        eventsTableApi = makeTable({
            container: fullEventsListEl,
            rows,
            defaultSort: { key: 'block', dir: 'desc' },
            globalSearch: true,
            summarySuffix: 'events',
            emptyMessage: 'No events indexed yet.',
            // Multiple events per block — this set outgrows /blocks fast.
            // Show-more for the first 200, page numbers beyond.
            pagination: { pageSize: 50, showMoreMax: 200 },
            columns: [
                {
                    key: 'block', label: 'Block', searchable: true,
                    sort: (a, b) => (a.block || 0) - (b.block || 0),
                    format: row => {
                        const displayHash = row.txHash || row.hash || '';
                        const shortHash = displayHash.substring(0, 15) + '…';
                        // Only render the /tx/ link when txHash is a real hash
                        // shape. Reward events without an enclosing extrinsic
                        // fall through to the event-id span.
                        const link = (row.txHash && looksLikeTxHash(row.txHash))
                            ? `<a href="/tx/${row.block}/${row.txHash}" class="item-link" style="font-size:12px; color: var(--brand-secondary); opacity:0.8;">tx: ${stakingEscapeHtml(shortHash)}</a>`
                            : `<span style="font-size:12px; color: var(--text-secondary); opacity:0.8;">event: ${stakingEscapeHtml(shortHash)}</span>`;
                        return `<a href="/block/${row.block}" class="item-link">${row.block}</a><br>${link}`;
                    }
                },
                {
                    key: 'section', label: 'Section',
                    sort: (a, b) => String(a.section || '').localeCompare(String(b.section || '')),
                    filter: { type: 'select', options: uniqueSections },
                    format: row => `<strong>${stakingEscapeHtml(row.section || '')}</strong>`
                },
                {
                    key: 'method', label: 'Method', searchable: true,
                    sort: (a, b) => String(a.method || '').localeCompare(String(b.method || '')),
                    filter: { type: 'select', options: uniqueMethods },
                    format: row => stakingEscapeHtml(row.method || '')
                },
                {
                    key: 'signerName', label: 'Signer', searchable: true,
                    sort: (a, b) => String(a.signerName || a.signerAddress || '').localeCompare(String(b.signerName || b.signerAddress || '')),
                    filter: { type: 'text', placeholder: 'Signer name/address…' },
                    format: row => {
                        const identityStr = (row.signerName && row.signerName !== 'Unknown') ? row.signerName : row.signerAddress;
                        return `<a href="/account/${row.signerAddress}" class="item-link" style="font-size:13px;">${stakingEscapeHtml(identityStr || '')}</a>`;
                    }
                },
                {
                    key: 'timestamp', label: 'Date',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => {
                        const d = formatLocalDateTime(row.timestamp);
                        return `<span style="color: var(--text-secondary);">${stakingEscapeHtml(timeAgo(row.timestamp))}<br><small>${stakingEscapeHtml(d)}</small></span>`;
                    }
                },
                {
                    key: 'status', label: 'Status',
                    sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
                    filter: { type: 'select', options: ['success', 'failed'] },
                    format: row => `<span class="badge" style="background: ${row.status === 'failed' ? 'var(--error)' : 'var(--success)'}; font-size:11px;">${stakingEscapeHtml(row.status || '')}</span>`
                },
                {
                    key: 'signerAddress', label: 'Signer Address', searchable: true,
                    sort: (a, b) => String(a.signerAddress || '').localeCompare(String(b.signerAddress || '')),
                    // Hidden by default — its data is searchable but the column
                    // is not interesting to display since the Signer column
                    // shows the identity. We could later add a column-visibility
                    // toggle; for now we omit by not declaring it.
                }
            ].filter(c => c.label !== 'Signer Address') // (placeholder for future hidden-but-searchable columns)
        });
    } else {
        eventsTableApi.setData(rows);
    }

    if (eventCountEl) eventCountEl.innerText = `${rows.length} Records`;
    const showMoreEventsBtn = document.getElementById('show-more-events-btn');
    if (showMoreEventsBtn) showMoreEventsBtn.style.display = 'none';
}

document.querySelectorAll('.sortable-tx').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        if (currentTxSort.field === field) {
            currentTxSort.asc = !currentTxSort.asc;
        } else {
            currentTxSort.field = field;
            currentTxSort.asc = false;
        }

        document.querySelectorAll('.sortable-tx i').forEach(i => i.className = 'bx bx-sort');
        const icon = th.querySelector('i');
        icon.className = currentTxSort.asc ? 'bx bx-sort-up' : 'bx bx-sort-down';

        sortTransactions();
        renderFullTransactions();
    });
});

// --- Event Listeners ---

const showMoreBtn = document.getElementById('show-more-btn');
if (showMoreBtn) {
    showMoreBtn.addEventListener('click', () => {
        validatorDisplayLimit += 50;
        renderValidators();
    });
}

const showMoreHoldersBtn = document.getElementById('show-more-holders-btn');
if (showMoreHoldersBtn) {
    showMoreHoldersBtn.addEventListener('click', () => {
        holderDisplayLimit += 50;
        renderHolders();
    });
}

const showMoreTxBtn = document.getElementById('show-more-tx-btn');
if (showMoreTxBtn) {
    showMoreTxBtn.addEventListener('click', () => {
        txDisplayLimit += 50;
        renderFullTransactions();
    });
}

const loadOlderFinancialTxBtn = document.getElementById('load-older-financial-tx-btn');
if (loadOlderFinancialTxBtn) {
    loadOlderFinancialTxBtn.addEventListener('click', loadOlderFinancialTransactions);
}

const showMoreBlocksBtn = document.getElementById('show-more-blocks-btn');
if (showMoreBlocksBtn) {
    showMoreBlocksBtn.addEventListener('click', () => {
        blockDisplayLimit += 50;
        renderFullBlocks();
    });
}

const showMoreEventsBtn = document.getElementById('show-more-events-btn');
if (showMoreEventsBtn) {
    showMoreEventsBtn.addEventListener('click', () => {
        eventDisplayLimit += 50;
        renderFullEvents();
    });
}

// Search Logic
const searchInput = document.getElementById('search-input');
const searchResultsContainer = document.getElementById('search-results-container');
const searchQueryDisplay = document.getElementById('search-query-display');
const deepSearchBtn = document.getElementById('deep-search-btn');
const searchCloseBtn = document.getElementById('search-close-btn');
let currentSearchQuery = '';

// Close-button on the search-results header. Sends the user back to the
// inline empty-state prompt with the current query pre-filled so they can
// edit it (e.g. fix a typo, change "12345" to "12346") rather than retyping
// from scratch. The topbar input keeps the query as well.
if (searchCloseBtn) {
    searchCloseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        renderSearchPrompt(undefined, currentSearchQuery);
    });
}

if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) {
                navigateTo('search');
                performSearch(query);
            }
        }
    });
}

// The deep-search button has two modes:
//   - "deep" (default): label "Deep Search Network", triggers an on-chain RPC
//     lookup via deepSearchNetwork().
//   - "back": shown after a successful deep-search result lands. Repurposes
//     the same button as "← Back to search", returning the user to the local
//     search view. The dataset attribute keeps the state on the element so
//     we don't have to swap event listeners on the fly.
function setDeepSearchButtonMode(mode) {
    if (!deepSearchBtn) return;
    if (mode === 'back') {
        deepSearchBtn.dataset.mode = 'back';
        deepSearchBtn.innerHTML = "<i class='bx bx-arrow-back' style=\"vertical-align:middle;\"></i> Back to search";
        deepSearchBtn.style.borderColor = 'var(--border-color)';
        deepSearchBtn.style.background  = 'rgba(255,255,255,0.05)';
        deepSearchBtn.style.display = '';
    } else if (mode === 'hidden') {
        // No query yet — the inline prompt below has its own Search button,
        // so a second deep-search button down here would be redundant noise.
        deepSearchBtn.dataset.mode = 'hidden';
        deepSearchBtn.style.display = 'none';
    } else {
        deepSearchBtn.dataset.mode = 'deep';
        deepSearchBtn.textContent = 'Deep Search Network';
        deepSearchBtn.style.borderColor = 'var(--brand-primary)';
        deepSearchBtn.style.background  = 'rgba(229,0,122,0.1)';
        deepSearchBtn.style.display = '';
    }
}

// Empty-state for /search: shows a prominent search box with paste + clear
// affordances, focused and ready to type into. Triggered when the user lands
// on /search via a page refresh (where currentSearchQuery has been lost),
// when they explicitly cleared a previous query, or when they close a search
// result via the header X. `note` is an optional banner above the input
// (e.g. "type a query before searching the network"). `prefillQuery` is an
// optional initial value for the input — set when the user closes a result
// page so the query stays editable instead of disappearing.
function renderSearchPrompt(note, prefillQuery) {
    if (!searchResultsContainer) return;
    if (searchQueryDisplay) searchQueryDisplay.textContent = '';
    // Hide the header text ("Search Results for: ") since there are no results.
    const header = document.querySelector('.search-page .list-header h2');
    if (header) header.style.display = 'none';
    // Hide the close button in the prompt view — there's nothing to close.
    if (searchCloseBtn) searchCloseBtn.style.display = 'none';
    setDeepSearchButtonMode('hidden');

    // Mirror the staking-rewards page layout: the input field hosts both the
    // Paste and Clear icon buttons inside its right edge (absolute-positioned
    // over the field's reserved padding-right), with the Search button as a
    // separate sibling. Reuses the existing .staking-search-bar styling so
    // visual treatment stays consistent across the app.
    searchResultsContainer.innerHTML = `
        <div style="text-align: center; padding: 32px 16px;">
            <h3 style="margin: 0 0 10px; font-size: 1.25rem;">Search the Polkadex Mainnet</h3>
            <p style="color: var(--text-secondary); margin: 0 auto 22px; font-size: 0.88rem; max-width: 540px; line-height: 1.55;">
                Look up a block number, block hash, transaction hash, or account address. The local index is checked first;
                you can also drill into the chain RPC directly with <strong>Deep Search</strong>.
            </p>
            ${note ? `<div style="color: var(--brand-secondary); font-size: 0.85rem; margin-bottom: 14px;">${stakingEscapeHtml(note)}</div>` : ''}
            <div class="staking-search-bar" style="max-width: 640px; margin: 0 auto;">
                <div style="flex: 1 1 320px; position: relative; display: flex; align-items: center;">
                    <input id="inline-search-input" type="text" inputmode="search"
                        placeholder="12345 · 0xhash · es1…address"
                        autocomplete="off" spellcheck="false"
                        style="width: 100%; padding-right: 70px;">
                    <div style="position: absolute; right: 10px; display: flex; gap: 5px;">
                        <button id="inline-search-clear-btn" type="button" title="Clear" aria-label="Clear"
                            style="background: none; border: none; padding: 5px; color: var(--text-secondary); display: none; min-width: auto; height: auto; cursor: pointer;">
                            <i class='bx bx-x' style="font-size: 20px;"></i>
                        </button>
                        <button id="inline-search-paste-btn" type="button" title="Paste" aria-label="Paste from clipboard"
                            style="background: none; border: none; padding: 5px; color: var(--text-secondary); min-width: auto; height: auto; cursor: pointer;">
                            <i class='bx bx-paste' style="font-size: 18px;"></i>
                        </button>
                    </div>
                </div>
                <button id="inline-search-submit-btn" type="button"><i class='bx bx-search'></i> Search</button>
            </div>
            <p style="color: var(--text-muted); font-size: 0.78rem; margin-top: 14px;">
                Tip: pressing <kbd style="padding: 1px 5px; border: 1px solid var(--border-color); border-radius: 3px; font-family: inherit;">Enter</kbd> submits.
            </p>
        </div>`;

    const inputEl  = document.getElementById('inline-search-input');
    const submitBtn = document.getElementById('inline-search-submit-btn');
    const pasteBtn  = document.getElementById('inline-search-paste-btn');
    const clearBtn  = document.getElementById('inline-search-clear-btn');

    // The Clear button only makes sense when there's text to clear — toggle
    // its visibility based on the input's current content. Mirrors the
    // staking-rewards page behavior.
    const syncClearVisibility = () => {
        if (clearBtn && inputEl) {
            clearBtn.style.display = inputEl.value.length > 0 ? 'inline-flex' : 'none';
        }
    };

    const submit = () => {
        const q = (inputEl && inputEl.value || '').trim();
        if (!q) { if (inputEl) inputEl.focus(); return; }
        // Sync the topbar input too so users see what they searched for.
        if (searchInput) searchInput.value = q;
        // Restore header visibility before performSearch repaints the container.
        if (header) header.style.display = '';
        performSearch(q);
    };
    if (submitBtn) submitBtn.addEventListener('click', submit);
    if (inputEl) {
        inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        inputEl.addEventListener('input', syncClearVisibility);
        // Pre-fill from the previous query when the user closed a result via
        // the header X, so they can tweak and re-submit instead of retyping.
        if (prefillQuery) inputEl.value = prefillQuery;
        syncClearVisibility();
        // Focus on next tick so the cursor lands in the field after layout settles.
        // When pre-filled, place the caret at the end of the existing text so the
        // user can immediately append or correct it.
        setTimeout(() => {
            inputEl.focus();
            if (prefillQuery) {
                const end = inputEl.value.length;
                try { inputEl.setSelectionRange(end, end); } catch (e) { /* ignore */ }
            }
        }, 30);
    }
    if (pasteBtn) pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text && inputEl) { inputEl.value = text.trim(); inputEl.focus(); syncClearVisibility(); }
        } catch (e) {
            // Clipboard API unavailable (insecure context, or user denied).
            // Fall back to selecting the field so the user can paste manually.
            if (inputEl) inputEl.focus();
        }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
        if (inputEl) { inputEl.value = ''; inputEl.focus(); syncClearVisibility(); }
    });
}

if (deepSearchBtn) {
    // Initialise to deep mode (matches the static HTML defaults).
    setDeepSearchButtonMode('deep');
    deepSearchBtn.addEventListener('click', () => {
        if (deepSearchBtn.dataset.mode === 'back') {
            // Go back to the local search view. performSearch() resets the
            // button to "deep" mode internally so it's ready for re-use.
            performSearch(currentSearchQuery);
        } else {
            deepSearchNetwork(currentSearchQuery);
        }
    });
}

// True only for something the user meant as an ACCOUNT, so search can redirect
// to /account/<addr>.
//
// isValidPolkadexAddress() alone is not enough: decodeAddress() also accepts a
// 0x-prefixed 32-byte hex string as a raw public key, so a block hash or an
// extrinsic hash would decode "successfully" and send someone searching for a
// block to a bogus account page. In this UI 0x-prefixed values are always
// hashes, and a bare number is always a block height — exclude both, and
// require the base58 length range an SS58 address actually falls in.
function isSearchableAddress(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    if (s.startsWith('0x')) return false;      // block / extrinsic hash
    if (/^\d+$/.test(s)) return false;         // block number
    if (s.length < 46 || s.length > 50) return false;
    return isValidPolkadexAddress(s);
}

async function performSearch(query) {
    currentSearchQuery = query;

    // An SS58 address goes straight to its account page.
    //
    // Local search only scans the RECENT cached transactions/blocks/events and
    // matches by exact string equality, so searching a wallet address usually
    // found nothing (or a stray hit or two) and reported "No results found in
    // recent local history" — for an address the explorer has full indexed
    // history on. /account/<addr> is that history: balances, staking, and
    // paginated transactions and events.
    //
    // The address is normalised to the Polkadex SS58 prefix (88) first, so a
    // prefix-42 or prefix-0 form of the SAME account lands on one canonical
    // URL instead of a second page that looks like a different account.
    const addrCandidate = String(query || '').trim();
    if (isSearchableAddress(addrCandidate)) {
        navigateTo(`/account/${encodeURIComponent(toPolkadexAddress(addrCandidate))}`, { replace: true });
        return;
    }

    // Always reset the deep-search button to its default state when a fresh
    // local search starts. If a previous deep-search result had left the
    // button in "Back to search" mode (or the empty-state prompt had hidden
    // it), this puts it back to "Deep Search Network" so the user can drill
    // deeper from any new query.
    setDeepSearchButtonMode('deep');
    // The empty-state prompt hides the page's H2 header; restore it.
    const header = document.querySelector('.search-page .list-header h2');
    if (header) header.style.display = '';
    // Show the close (×) button so the user can return to the prompt with
    // the query pre-filled for editing.
    if (searchCloseBtn) searchCloseBtn.style.display = '';
    if (searchQueryDisplay) searchQueryDisplay.innerText = query;
    if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Searching local indexer...</div>';

    // Ensure all data is fetched
    await Promise.all([fetchTransactions(), fetchBlocks(), fetchEvents()]);

    let html = '';
    let found = false;

    // Results are rendered as real tables (makeTable), matching every other
    // listing in the app: sortable, filterable, paginated, with links through
    // to detail pages. They used to be emitted as raw <div>/<br> blobs — a
    // wall of unlinked text that made a wallet-address search unusable.
    // Containers are laid out first, then hydrated after innerHTML lands.
    const pendingTables = [];

    // Search Blocks (by number or hash)
    const matchingBlocks = fullBlocks.filter(b => b.number.toString() === query || b.hash.toLowerCase() === query.toLowerCase());
    if (matchingBlocks.length > 0) {
        found = true;
        html += `<h3 class="search-result-heading">Matching Blocks <span class="search-result-count">${matchingBlocks.length}</span></h3>
                 <div id="search-blocks-table"></div>`;
        pendingTables.push({
            id: 'search-blocks-table',
            rows: matchingBlocks,
            columns: [
                { key: 'number', label: 'Block', searchable: true,
                  sort: (a, b) => (a.number || 0) - (b.number || 0),
                  format: r => `<a href="/block/${r.number}" class="item-link">${stakingEscapeHtml(String(r.number))}</a>` },
                { key: 'hash', label: 'Hash', searchable: true,
                  format: r => `<a href="/block/${r.hash}" class="item-link mono">${stakingEscapeHtml(String(r.hash).slice(0, 18))}…</a>` },
                { key: 'extrinsicsCount', label: 'Extrinsics',
                  sort: (a, b) => (a.extrinsicsCount || 0) - (b.extrinsicsCount || 0) },
                { key: 'eventsCount', label: 'Events',
                  sort: (a, b) => (a.eventsCount || 0) - (b.eventsCount || 0) },
                { key: 'timestamp', label: 'Time',
                  format: r => stakingEscapeHtml(r.timestamp ? timeAgo(r.timestamp) : '—') }
            ],
            defaultSort: { key: 'number', dir: 'desc' }
        });
    }

    // Search Transactions (by hash or address)
    const matchingTx = transactions.filter(t => t.hash.toLowerCase() === query.toLowerCase() || t.from.toLowerCase() === query.toLowerCase() || t.to.toLowerCase() === query.toLowerCase());
    if (matchingTx.length > 0) {
        found = true;
        html += `<h3 class="search-result-heading">Matching Transactions <span class="search-result-count">${matchingTx.length}</span></h3>
                 <div id="search-tx-table"></div>`;
        pendingTables.push({
            id: 'search-tx-table',
            rows: matchingTx,
            columns: [
                { key: 'hash', label: 'Tx hash', searchable: true,
                  format: r => r.block
                      ? `<a href="/tx/${r.block}/${r.hash}" class="item-link mono">${stakingEscapeHtml(String(r.hash).slice(0, 18))}…</a>`
                      : `<span class="mono">${stakingEscapeHtml(String(r.hash).slice(0, 18))}…</span>` },
                { key: 'from', label: 'From', searchable: true,
                  format: r => shortAddressLink(r.from) },
                { key: 'to', label: 'To', searchable: true,
                  format: r => shortAddressLink(r.to) },
                { key: 'numericAmount', label: 'Amount (PDEX)',
                  sort: (a, b) => (Number(a.numericAmount) || 0) - (Number(b.numericAmount) || 0),
                  format: r => stakingEscapeHtml(String(r.amount != null ? r.amount : r.numericAmount)) },
                { key: 'block', label: 'Block',
                  sort: (a, b) => (a.block || 0) - (b.block || 0),
                  format: r => r.block ? `<a href="/block/${r.block}" class="item-link">${stakingEscapeHtml(String(r.block))}</a>` : '—' },
                { key: 'timestamp', label: 'Time',
                  format: r => stakingEscapeHtml(r.timestamp ? timeAgo(r.timestamp) : '—') }
            ],
            defaultSort: { key: 'block', dir: 'desc' }
        });
    }

    // Search Events (by hash, address, or block)
    const matchingEvents = fullEvents.filter(e => e.hash.toLowerCase() === query.toLowerCase() || (e.txHash && e.txHash.toLowerCase() === query.toLowerCase()) || e.signerAddress.toLowerCase() === query.toLowerCase() || e.block.toString() === query);
    if (matchingEvents.length > 0) {
        found = true;
        html += `<h3 class="search-result-heading">Matching Events <span class="search-result-count">${matchingEvents.length}</span></h3>
                 <div id="search-events-table"></div>`;
        pendingTables.push({
            id: 'search-events-table',
            rows: matchingEvents,
            columns: [
                { key: 'section', label: 'Event', searchable: true,
                  format: r => `<strong>${stakingEscapeHtml(r.section)}</strong>.${stakingEscapeHtml(r.method)}` },
                { key: 'block', label: 'Block',
                  sort: (a, b) => (a.block || 0) - (b.block || 0),
                  format: r => `<a href="/block/${r.block}" class="item-link">${stakingEscapeHtml(String(r.block))}</a>` },
                { key: 'signerAddress', label: 'Signer', searchable: true,
                  format: r => (r.signerName && r.signerName !== 'Unknown')
                      ? stakingEscapeHtml(r.signerName)
                      : shortAddressLink(r.signerAddress) },
                { key: 'timestamp', label: 'Time',
                  format: r => stakingEscapeHtml(r.timestamp ? timeAgo(r.timestamp) : '—') }
            ],
            defaultSort: { key: 'block', dir: 'desc' }
        });
    }

    if (!found) {
        html = '<div style="text-align:center; padding: 20px; color: orange;">No results found in recent local history. Try deep search.</div>';
    }

    if (searchResultsContainer) {
        searchResultsContainer.innerHTML = html;
        // Hydrate after the containers exist in the DOM.
        for (const t of pendingTables) {
            const container = document.getElementById(t.id);
            if (!container) continue;
            makeTable({
                container,
                rows: t.rows,
                columns: t.columns,
                defaultSort: t.defaultSort,
                globalSearch: false,               // the page already has a search box
                pagination: { pageSize: 25, showMoreMax: 100 },
                emptyMessage: 'No matching rows.'
            });
        }
    }
}

// Address cell: short, monospaced, and linked through to the account page.
// Search results are frequently a wallet address, and a full 48-character SS58
// string rendered as bare text is both unreadable and unclickable.
function shortAddressLink(addr) {
    if (!addr) return '—';
    const s = String(addr);
    const short = s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
    return `<a href="/account/${encodeURIComponent(s)}" class="item-link mono" title="${stakingEscapeHtml(s)}">${stakingEscapeHtml(short)}</a>`;
}

// Parse a fetch Response that we *expect* to be JSON, but might not be when
// the backend is timed out / restarting / errored at the nginx (or Cloudflare)
// layer — those return their own HTML error pages on 502/504/521. Returns
// the JSON body on success, or throws a short, friendly message instead of
// the raw "Unexpected token '<'". The caller decides how to prefix it for
// display, so the message itself is just the status + hint + a sanitized
// snippet of any human-readable text.
async function parseJsonResponse(response) {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) return await response.json();

    // Non-JSON body — strip HTML (doctype, comments incl. IE conditionals, tags)
    // so a Cloudflare or nginx error page collapses to its visible text only.
    const raw = await response.text();
    const stripped = raw
        .replace(/<!doctype[^>]*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const bodyPreview = stripped.slice(0, 140);
    const hint = response.status === 502 ? 'backend is unreachable'
              : response.status === 504 ? 'backend timed out'
              : response.status === 521 ? 'origin server is down (Cloudflare)'
              : response.status === 522 ? 'connection timed out (Cloudflare)'
              : response.status === 524 ? 'a timeout occurred (Cloudflare)'
              : response.status >= 500   ? 'backend error'
              : response.status === 404  ? 'not found'
              : 'unexpected non-JSON response';
    throw new Error(`${response.status} ${response.statusText || hint} (${hint})${bodyPreview ? ' — ' + bodyPreview : ''}`);
}

// Shared "close detail view" helper used by every X-icon close button on the
// account / block / transaction / validator / staking-rewards detail pages.
// Behaviour:
//   1. If there's an in-SPA back stack (history.length > 1, OR a same-origin
//      referrer to handle browsers that under-count length across SPA pushes),
//      run history.back() — sends the user to whichever route they navigated
//      in from, regardless of whether that was the index, a list page, or a
//      sibling detail page. This is what most users actually want.
//   2. Otherwise (fresh tab opened directly on the detail URL, or shared
//      link with no back stack), navigate to the page-specific parent route
//      the caller passes as `fallbackPath`. That's '/validators' for the
//      validator page, '/blocks' for block detail, etc. — never a dead-end
//      click.
// Pass `fallbackPath` without a leading slash (e.g. 'validators', not
// '/validators') because the SPA's navigateTo strips the leading slash itself.
// Audit F-129: this used to trust `document.referrer` being same-origin as
// proof there was somewhere to go back TO. Cmd-click a detail row into a new
// tab and the referrer is same-origin while the tab's history is just this
// page — history.back() is a silent no-op and the X button does nothing. The
// only reliable signal is one we write ourselves: spaNavDepth counts pushes
// THIS tab's SPA session has made.
function closeDetailView(fallbackPath) {
    if (spaNavDepth > 0) {
        spaNavDepth = Math.max(0, spaNavDepth - 1);
        history.back();
    } else {
        navigateTo(fallbackPath || 'home');
    }
}

// Global click delegate that picks up every X-icon close button on the
// detail pages. The detail-page templates emit
//   <a href="#" data-close-detail="<fallback-route>">…X icon…</a>
// — we catch the click here once at the document level, prevent the
// default # navigation, and hand off to closeDetailView(). Centralising
// this means new detail pages only need to add the data attribute on
// their close button; no per-page wiring required.
document.addEventListener('click', (e) => {
    const trigger = e.target && e.target.closest ? e.target.closest('[data-close-detail]') : null;
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    closeDetailView(trigger.getAttribute('data-close-detail'));
});

// Centralised /api error rendering — recognises the RPC_NOT_READY transient
// state (HTTP 503 emitted by server.js `requireRpc()`) and shows a friendly
// "still connecting" panel with a Retry button instead of dumping the raw
// "Error: Cannot read properties of null (reading 'rpc')" TypeError that used
// to surface when the user clicked a block / tx / account during the brief
// window after backend boot where the WsProvider hadn't completed its
// handshake. Falls back to the original red error line for any other failure.
//
//   container — element to write the panel into
//   err       — Error object; should carry .status (HTTP code) and .code
//               ('RPC_NOT_READY' for the friendly path) when present
//   retryFn   — optional function called when the user clicks Retry
function renderApiError(container, err, retryFn) {
    if (!container) return;
    const transient = (err && (err.code === 'RPC_NOT_READY' || err.status === 503));
    const message = (err && err.message) || 'Unknown error';
    if (transient) {
        container.innerHTML = `
            <div style="padding:48px 24px;text-align:center;color:var(--text-secondary);">
                <i class='bx bx-loader-alt bx-spin' style="font-size:42px;color:var(--brand-primary);"></i>
                <h3 style="margin:14px 0 8px 0;color:var(--text-primary);">Connecting to the Polkadex node…</h3>
                <p style="max-width:520px;margin:0 auto 18px auto;font-size:0.9rem;line-height:1.5;">
                    ${stakingEscapeHtml(message)}
                </p>
                <button type="button" class="staking-download-btn" data-api-error-retry>
                    <i class='bx bx-refresh'></i> Retry
                </button>
            </div>`;
        const btn = container.querySelector('[data-api-error-retry]');
        if (btn && typeof retryFn === 'function') btn.addEventListener('click', retryFn);
    } else {
        container.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Error: ${stakingEscapeHtml(message)}</div>`;
    }
}

// Helper that wraps fetch() so the catch block in a caller can act on the
// HTTP status AND on the server-emitted error.code (e.g. 'RPC_NOT_READY')
// uniformly. On a non-2xx the returned Error carries both, ready to feed
// straight into renderApiError().
async function fetchApiJson(url, options) {
    const res = await fetch(url, options);
    const data = await parseJsonResponse(res);
    if (!res.ok || (data && data.error)) {
        const err = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status;
        if (data && data.code) err.code = data.code;
        throw err;
    }
    return data;
}

async function deepSearchNetwork(query) {
    // Guard: an empty query usually means the page was refreshed and
    // `currentSearchQuery` was reset. Calling /api/search/ with no path param
    // produces a 404 (or a Cloudflare 502 when the origin can't be reached),
    // which surfaces as a confusing error. Render the empty-state prompt
    // instead so the user can type a query.
    const q = (query || '').trim();
    if (!q) {
        renderSearchPrompt('Type a query before searching the network.');
        return;
    }

    if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Querying Deep Network RPC...</div>';
    try {
        const response = await fetch(`/api/search/${encodeURIComponent(q)}`);
        if (!response.ok) {
            // Try to read a JSON-shaped error message first; if the upstream
            // returned an nginx/Cloudflare HTML error page, parseJsonResponse
            // converts it to a readable string instead of throwing
            // "Unexpected token '<'".
            try {
                const err = await parseJsonResponse(response);
                searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep Search Failed: ${stakingEscapeHtml(err.error || 'unknown error')}</div>`;
            } catch (e) {
                searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep Search Failed: ${stakingEscapeHtml(e.message)}<br><span style="color:var(--text-secondary);font-size:0.85rem;">If this keeps happening, the chain RPC is likely timing out; try again in a minute.</span></div>`;
            }
            return;
        }

        const data = await parseJsonResponse(response);
        let html = '';

        if (data.type === 'block') {
            html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Block Detail (Deep Search)</h3>`;
            html += `<div style="padding: 10px 0;">Block <strong>${data.data.number}</strong> (${data.data.hash})<br>Author: ${data.data.authorAddress}<br>${data.data.extrinsicsCount} extrinsics, ${data.data.eventsCount} events</div>`;
        } else if (data.type === 'account') {
            html += `<h3 style="margin-top: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">Account Detail (Deep Search)</h3>`;
            html += `<div style="padding: 10px 0;">Address: <strong>${data.data.address}</strong><br>Identity: ${data.data.name}<br>Total Balance: ${data.data.balance.toFixed(4)} PDEX<br>Free: ${data.data.free.toFixed(4)} PDEX, Reserved: ${data.data.reserved.toFixed(4)} PDEX</div>`;
        }

        if (html) {
            if (searchResultsContainer) searchResultsContainer.innerHTML = html;
            // A real result is on screen — repurpose the button as "Back to search"
            // so the user has an obvious one-click way back to the local view.
            setDeepSearchButtonMode('back');
        } else {
            // The chain didn't recognise the query as a block or account.
            // Leave the button in "deep" mode so the user can refine and retry.
            if (searchResultsContainer) searchResultsContainer.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-secondary);">No matching block or account found on-chain for that query.</div>';
        }

    } catch (err) {
        searchResultsContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--error);">Deep search error: ${stakingEscapeHtml(err.message)}</div>`;
    }
}

// --- SEO router (clean URLs + per-route metadata) ----------------------------
// The app used to hash-route (#blocks, #validator/abc). Crawlers don't index
// fragment URLs as separate pages, so we now use the History API: each route
// gets a real path (/blocks, /validator/abc) that nginx falls back to
// index.html for. Old #X URLs still work — we rewrite them to clean URLs on
// boot for backward compatibility.
const SITE_ORIGIN = 'https://explorer.polkadex.ee';
const SITE_DEFAULT_OG_IMAGE = SITE_ORIGIN + '/og-image.png';
const SITE_NAME = 'Polkadex Explorer';

// Per-route SEO metadata. `title` and `description` are templates; dynamic
// routes (block/:id, validator/:addr, …) are filled in once the detail fetcher
// has real data via `updateSeoMeta()`.
const ROUTE_SEO = {
    'home':               { title: 'Polkadex Mainnet Explorer — Blocks, Validators, Staking & Governance',
                            description: 'The official Polkadex Mainnet block explorer. Browse blocks, extrinsics, events, and transactions in real time; look up any account or validator; track staking rewards; and follow on-chain governance — all from one page.' },
    'holders':            { title: 'Top PDEX Holders — Polkadex Mainnet Explorer',
                            description: 'Live ranking of the largest PDEX token holders on the Polkadex Mainnet. Sorted by balance, with share of total supply, on-chain identity, and one-click drill-down to every address.' },
    'transactions':       { title: 'Latest Transactions — Polkadex Mainnet Explorer',
                            description: 'Real-time feed of every signed transaction on the Polkadex Mainnet: PDEX transfers, staking calls, governance votes, treasury actions, and runtime extrinsics — searchable, filterable, paginated.' },
    'blocks':             { title: 'Latest Blocks — Polkadex Mainnet Explorer',
                            description: 'Every block finalized on the Polkadex Mainnet, newest first. Block author, extrinsic count, hash, parent hash, and a one-click drill-down to every extrinsic and event inside the block.' },
    'events':             { title: 'On-chain Events — Polkadex Mainnet Explorer',
                            description: 'Live event log from the Polkadex Mainnet runtime: balances, staking rewards, council motions, treasury approvals, democracy referenda — filterable by section and method.' },
    'validators':         { title: 'Validators — Polkadex Mainnet Explorer',
                            description: 'Active and waiting validators on the Polkadex Mainnet: commission, total stake (own + nominated), real 30-day APY, slash history, and identity. The data you need to pick who to nominate.' },
    'staking-rewards':    { title: 'Staking Rewards Lookup — Polkadex Mainnet Explorer',
                            description: 'Look up any Polkadex address to see full staking reward history, realized 30-day / 90-day / all-time APR, claim payouts, stake more, unstake, and export year-end tax CSV.' },
    'democracy':          { title: 'Democracy & Referenda — Polkadex Mainnet Explorer',
                            description: 'Polkadex on-chain governance: ongoing referenda with Aye/Nay vote buttons, public proposals queued for second, statistics, and full per-referendum detail. Cast a vote in two clicks.' },
    'council':            { title: 'Council & Motions — Polkadex Mainnet Explorer',
                            description: 'Polkadex Council members, runners-up, election term progress, and every council motion — past and present — with proposer, threshold, tally, and the call it dispatches.' },
    'treasury':           { title: 'Treasury Proposals — Polkadex Mainnet Explorer',
                            description: 'Polkadex Treasury balance, lifetime award totals, and every spending proposal — open, approved, or historical. Submit a new proposal directly from your connected wallet.' },
    'discussions':        { title: 'Governance Discussions — Polkadex Mainnet Explorer',
                            description: 'Off-chain debate threads attached to every Polkadex referendum, council motion, and treasury proposal. Wallet-signature sign-in; no email or password required.' },
    'analytics':          { title: 'Network Analytics — Polkadex Mainnet Explorer',
                            description: 'Polkadex Mainnet analytics dashboard: daily transactions, PDEX volume, active addresses, blocks produced, PDEX/USD price, and cumulative Treasury awards. Pick 7, 30, 90 days or a year.' },
    // Personal local-storage page — useful to crawlers as a feature
    // landing only; no per-user data is indexed.
    'watchlist':          { title: 'Watchlist — Polkadex Mainnet Explorer',
                            description: 'Your private bookmark list of Polkadex addresses, validators, referenda, council motions, and treasury proposals — stored locally in your browser, never sent to any server.',
                            noindex: true },
    // /wallet (no address) is a public connect-wallet landing page — index it
    // so it captures searches like "connect Polkadex wallet" or "send PDEX".
    // initWalletPage() flips it to noindex when an address is bound (personal).
    'wallet':             { title: 'Connect Wallet — Send PDEX, Stake & Manage Your Account · Polkadex Explorer',
                            description: 'Connect a Polkadot.js, Talisman, or SubWallet extension on desktop, or use Nova Wallet / SubWallet on mobile to send PDEX, stake, and manage your Polkadex account.' },
    // Token-bearing page reached only from an alert email. Never index it:
    // the URL IS the credential, so a crawled copy is a leaked one.
    'email-preferences':  { title: 'Email alert preferences — Polkadex Mainnet Explorer',
                            description: 'Choose which Polkadex Mainnet Explorer alert emails you receive.',
                            noindex: true },
    'not-found':          { title: 'Page not found — Polkadex Mainnet Explorer',
                            description: 'There is no page at this address.',
                            noindex: true },
    'donate':             { title: 'Support the Explorer — Polkadex Mainnet Explorer',
                            description: 'Help fund infrastructure for the Polkadex Mainnet Explorer. Donate with PDEX, BTC, ETH, USDT, USDC, or any major crypto asset. Every contribution keeps the explorer ad-free and tracker-free.' },
    'search':             { title: 'Search Results — Polkadex Mainnet Explorer',
                            description: 'Search the Polkadex Mainnet for blocks, extrinsic hashes, transaction hashes, account addresses, and validator identities — local index plus deep network fallback.',
                            noindex: true },
    'account-details':    { title: 'Account Details — Polkadex Mainnet Explorer',
                            description: 'Polkadex account details: balance breakdown (total, free, frozen), display name, on-chain identity, community labels, plus every transaction and event the address has signed or received.' },
    'validator-details':  { title: 'Validator Details — Polkadex Mainnet Explorer',
                            description: 'Polkadex validator scorecard: estimated APY, commission band, active-era rate, slash count, and current stake. Star to add to your watchlist and follow performance over time.' },
    'block-details':      { title: 'Block Details — Polkadex Mainnet Explorer',
                            description: 'Polkadex block details: every extrinsic that ran, every event emitted, the block author, timestamp, parent hash, and a direct link to each transaction inside the block.' },
    'tx-details':         { title: 'Transaction Details — Polkadex Mainnet Explorer',
                            description: 'Polkadex transaction details: signer, call data, recipient, amount, fee, status, and the full event log. Self-correcting URL when a chain reorg moves the tx between blocks.' },
    // Static legal/info pages. Targets users searching specifically for
    // "Polkadex explorer privacy", "Polkadex GDPR", "Polkadex explorer
    // cookies" — keep titles keyword-rich without keyword-stuffing.
    'privacy':            { title: 'Privacy Policy — Polkadex Explorer',
                            description: 'How the Polkadex Explorer handles your data: no tracking cookies, no third-party analytics, GDPR-compliant data subject rights.' },
    'cookies':            { title: 'Cookie & Storage Notice — Polkadex Explorer',
                            description: 'The Polkadex Explorer does not set tracking cookies. Plain-English list of every localStorage key we use, what it stores, and why.' },
    // Online help center. Per-article titles override this default via
    // updateSeoMeta() inside renderHelpArticle(). The landing description
    // doubles as fallback for /help itself.
    'help':               { title: 'Help center — Polkadex Mainnet Explorer',
                            description: 'A practical guide to the Polkadex Mainnet Explorer: browsing the chain, sending PDEX, staking, governance, watchlist, community labels, and privacy.' },
    // Brand kit cheatsheet. Public, indexable. Targets designers and devs
    // searching for "Polkadex brand colours" or "Polkadex logo download".
    'brand':              { title: 'Brand kit — Polkadex Mainnet Explorer',
                            description: 'Polkadex Mainnet Explorer brand kit: colour palette, typography, logo usage, iconography, spacing tokens, voice. Click any swatch to copy its hex value.' },
    // Governance calendar — unified timeline of referenda, treasury proposals,
    // and council motions with end-of-vote countdowns.
    'calendar':           { title: 'Governance calendar — Polkadex Mainnet Explorer',
                            description: 'Calendar view of all active and recent Polkadex on-chain governance: democracy referenda, council motions, treasury proposals, with voting end times.' },
    // Full-screen PDEX price chart — landing for anyone scanning "PDEX price"
    // intent. Surfaced from the sidebar price ticker.
    'price':              { title: 'PDEX Price Chart — Polkadex Mainnet Explorer',
                            description: 'Full PDEX price history with 24-hour, 7-day, 30-day, 90-day, 1-year, and all-time views. Live price from CoinGecko; historical native-market data is retained.' },
    // Developer-facing API reference. Targets searches like "Polkadex API",
    // "Polkadex mobile app integration", "Polkadex JSON endpoints".
    'developers':         { title: 'Developers — Polkadex Explorer API Reference',
                            description: 'JSON API reference for the Polkadex Mainnet Explorer: blocks, transactions, validators, accounts, wallets, governance, price, and email alerts. CORS rules for mobile and web. Caching tiers, error envelopes, address format.' },
    // Chain-state inspector. Targets "polkadex chain state", "query polkadex
    // storage", "polkadex historical state" — the polkadot.js Apps audience.
    'chain-state':        { title: 'Chain State — Query Polkadex Runtime Storage at Any Block',
                            description: 'Read any Polkadex Mainnet runtime storage item at the current head or any historical block. Pallet and storage dropdowns from live runtime metadata, typed keys, and Human/JSON/Hex output for reproducible on-chain verification.' },
    'decode':             { title: 'Extrinsic Decoder — Decode Any Polkadex Block',
                            description: 'Decode every extrinsic in a Polkadex Mainnet block argument by argument: names, declared SCALE types, decoded values and raw hex, plus the full encoded call. Read-only chain forensics.' },
    'runtime':            { title: 'Runtime & RPC — Polkadex Mainnet Explorer',
                            description: 'Polkadex runtime spec version at any block, on-chain constants browser, and an allowlisted read-only RPC console.' },
    'utilities':          { title: 'Developer Utilities — SS58, Hashing & Signature Verification',
                            description: 'Convert Polkadex SS58 addresses between prefixes, compute blake2 / keccak / xxhash digests, and verify sr25519 and ed25519 signatures. Runs entirely in your browser.' }
};

// Update <title>, meta[description], canonical, and Open Graph / Twitter tags
// for the current route. Detail pages call this again once they've loaded the
// concrete entity (e.g. validator name) so the metadata reflects real content.
function updateSeoMeta(mainTarget, { title, description, canonicalPath, noindex } = {}) {
    const base = ROUTE_SEO[mainTarget] || ROUTE_SEO.home;
    const finalTitle = title || base.title;
    const finalDesc = description || base.description;
    const path = canonicalPath || (window.location.pathname + window.location.search) || '/';
    const canonical = SITE_ORIGIN + (path === '/' ? '/' : path.replace(/\/+$/, '') || '/');
    const shouldNoindex = noindex === true || (noindex !== false && base.noindex === true);

    document.title = finalTitle;
    setMetaContent('name', 'description', finalDesc);
    setLinkHref('canonical', canonical);

    // robots: noindex pages (search results, personal wallet view) should not
    // surface in the SERP even though they're reachable.
    setMetaContent('name', 'robots', shouldNoindex
        ? 'noindex, nofollow'
        : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

    // Open Graph
    setMetaContent('property', 'og:title', finalTitle);
    setMetaContent('property', 'og:description', finalDesc);
    setMetaContent('property', 'og:url', canonical);
    setMetaContent('property', 'og:type', mainTarget === 'home' ? 'website' : 'article');

    // Twitter
    setMetaContent('name', 'twitter:title', finalTitle);
    setMetaContent('name', 'twitter:description', finalDesc);

    // Clear any route-scoped JSON-LD by default; routes that own one (e.g.
    // /wallet) re-inject after this call returns.
    setRouteJsonLd(null);
}

function setMetaContent(attr, key, value) {
    let el = document.head.querySelector(`meta[${attr}="${key}"]`);
    if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, key);
        document.head.appendChild(el);
    }
    el.setAttribute('content', value);
}
function setLinkHref(rel, href) {
    let el = document.head.querySelector(`link[rel="${rel}"]`);
    if (!el) {
        el = document.createElement('link');
        el.setAttribute('rel', rel);
        document.head.appendChild(el);
    }
    el.setAttribute('href', href);
}

// Swap a per-route JSON-LD block in <head>. Pass `null` to remove. The script
// is keyed by a stable id so it never duplicates and we can replace it cleanly
// when the user navigates away from the route that owns it.
function setRouteJsonLd(json) {
    const ID = 'route-jsonld';
    const existing = document.getElementById(ID);
    if (!json) { if (existing) existing.remove(); return; }
    const text = (typeof json === 'string') ? json : JSON.stringify(json);
    if (existing) { existing.textContent = text; return; }
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = ID;
    el.textContent = text;
    document.head.appendChild(el);
}

// JSON-LD WebPage schema for the static legal pages (/privacy, /cookies).
// Marks them as primary content rather than SPA boilerplate so crawlers can
// confidently surface them for direct queries like "Polkadex explorer
// privacy policy" or "Polkadex GDPR".
function injectLegalPageJsonLd(target) {
    const pageMeta = {
        privacy: {
            url: SITE_ORIGIN + '/privacy',
            name: 'Privacy Policy — Polkadex Explorer',
            description: 'How the Polkadex Explorer handles your data: no tracking cookies, no third-party analytics, GDPR-compliant data subject rights.'
        },
        cookies: {
            url: SITE_ORIGIN + '/cookies',
            name: 'Cookie & Storage Notice — Polkadex Explorer',
            description: 'The Polkadex Explorer does not set tracking cookies. Plain-English list of every localStorage key we use, what it stores, and why.'
        }
    }[target];
    if (!pageMeta) return;
    setRouteJsonLd({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': pageMeta.url,
        url: pageMeta.url,
        name: pageMeta.name,
        description: pageMeta.description,
        inLanguage: 'en',
        isPartOf: { '@type': 'WebSite', name: 'Polkadex Explorer', url: SITE_ORIGIN },
        dateModified: '2026-06-01'
    });
}

// Wire the Reset button on /cookies. Clears every pdex_* key from
// localStorage + sessionStorage (both window-scoped) and reloads the page so
// the user sees a clean state. We don't try to be cute about which keys to
// keep — the user clicked Reset, so we honour that exactly.
function wireCookiesResetButton() {
    const btn = document.getElementById('cookies-reset-btn');
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
        if (!confirm('Clear all explorer preferences? You will need to reconnect your wallet and re-confirm dismissed notices.')) return;
        try {
            // Walk a snapshot of keys since removeItem mutates the live list.
            for (const store of [localStorage, sessionStorage]) {
                const keys = [];
                for (let i = 0; i < store.length; i++) {
                    const k = store.key(i);
                    if (k && k.startsWith('pdex_')) keys.push(k);
                }
                keys.forEach(k => store.removeItem(k));
            }
        } catch (e) {
            console.warn('[cookies-reset] storage clear failed:', e && e.message);
        }
        location.reload();
    });
}

// ─── Online help center ────────────────────────────────────────────────────
// Content adapted from the PDF user guide, chunked into self-contained
// articles. Each article is its own indexable URL at /help/<slug>. The
// landing at /help shows the category grid. The data lives entirely here in
// the bundle so it works offline once the SPA is loaded — no backend round-trip.
const HELP_CATEGORIES = [
    { id: 'start',     label: 'Getting started' },
    { id: 'browse',    label: 'Browsing the chain' },
    { id: 'wallet',    label: 'Wallet & sending' },
    { id: 'staking',   label: 'Staking' },
    { id: 'gov',       label: 'Governance' },
    { id: 'tools',     label: 'Tools & extras' },
    { id: 'reference', label: 'Reference' },
];

// Each topic: { slug, title, category, keywords, body }. Body is HTML.
// Keywords are matched in the search (plus title + body fall-back). Keep
// articles short — under ~250 words — so they read on a single screen.
const HELP_TOPICS = [
    {
        slug: 'quick-start',
        title: 'Quick start',
        category: 'start',
        keywords: 'getting started first time onboarding walkthrough new user',
        body: `
            <p class="lead">Fifteen minutes from zero to a connected wallet, a first transfer, and (optionally) your first nomination.</p>
            <ol class="help-steps">
                <li><b>Open the explorer</b> at <code>explorer.polkadex.ee</code>. Browse without logging in — no wallet needed for read-only use.</li>
                <li><b>Install a wallet extension</b> — Polkadot.js, Talisman, SubWallet, or PolkaGate on desktop. On mobile, use Nova Wallet or SubWallet's in-app browser.</li>
                <li><b>Create or import an account</b> inside the wallet. Write down the seed phrase on paper. Never paste it into the explorer.</li>
                <li><b>Connect</b> by clicking <i>My Account</i>; the explorer detects your extension and lists each account.</li>
                <li><b>Send a small test transfer</b> from the Wallet Dashboard's <i>Send PDEX</i> button. Verify the recipient first.</li>
                <li><b>Optional: stake</b> — click <i>Stake more</i>, pick validators, and sign. Rewards start next era (~24 hours).</li>
                <li><b>Optional: star what matters</b> — click the star icon next to any address, validator, or proposal to bookmark it locally.</li>
            </ol>
            <p>Once you're moving, treat the rest of the help center as a reference — skim what you need.</p>
        `
    },
    {
        slug: 'installing-a-wallet',
        title: 'Installing a wallet',
        category: 'start',
        keywords: 'wallet extension polkadot.js talisman subwallet polkagate nova mobile install setup',
        body: `
            <p>To do anything that signs a transaction (send PDEX, stake, vote), you need a Substrate wallet. The explorer never sees your private key — it asks your wallet to sign on your behalf.</p>
            <h3>Desktop</h3>
            <ul>
                <li><b>Polkadot.js</b> — the official reference extension. Simple and reliable.</li>
                <li><b>Talisman</b> — feature-rich UI, supports multiple chains.</li>
                <li><b>SubWallet</b> — broad chain support, mobile companion app.</li>
                <li><b>PolkaGate</b> — focus on staking and governance UX.</li>
            </ul>
            <h3>Mobile</h3>
            <p>Install <b>Nova Wallet</b> or the <b>SubWallet</b> mobile app, then open the explorer inside the wallet's built-in browser. The explorer detects mobile-wallet WebViews and behaves accordingly.</p>
            <div class="help-callout">
                <b>About seed phrases.</b> Anyone with your seed phrase has your funds. Write it on paper. Don't take a screenshot, don't paste it anywhere online, don't store it in a cloud note.
            </div>
        `
    },
    {
        slug: 'connecting-wallet',
        title: 'Connecting your wallet',
        category: 'start',
        keywords: 'connect wallet sign in extension permission account selection my account',
        body: `
            <p>Click <b>My Account</b> in the sidebar. The explorer detects every Substrate wallet extension and shows you a status banner ("Detected Polkadot.js" etc.). Click <b>Connect</b> and your extension pops up asking for permission to share its account list.</p>
            <p>Once approved, each exposed account renders as a clickable button. Click the one you want to use — the explorer remembers your choice and routes to your <b>Wallet Dashboard</b>.</p>
            <h3>Multiple accounts</h3>
            <p>If your wallet exposes more than one account, the explorer prefers the last account you used. Use <b>Switch wallet</b> on the dashboard to return to the picker.</p>
            <h3>View-only mode</h3>
            <p>From the connect page, scroll to <i>"…or look up any address without connecting"</i>, paste a Polkadex address, and click View. The dashboard renders with all actionable buttons hidden — useful for inspecting other wallets.</p>
        `
    },
    {
        slug: 'home-dashboard',
        title: 'Home dashboard',
        category: 'browse',
        keywords: 'home dashboard landing network info stats issuance market cap',
        body: `
            <p>The home page is the whole explorer in one screen. From top to bottom:</p>
            <ul>
                <li><b>Stats strip</b> — Market Cap, Total Issuance, In Stake, AVG APY.</li>
                <li><b>Network Information</b> — current era, validators ratio, nominators ratio, max active stake.</li>
                <li><b>Recent Blocks</b> — live feed of the latest blocks finalized on chain.</li>
                <li><b>Recent Transactions</b> — live feed of recent signed financial transactions.</li>
                <li><b>Lower Network Information grid</b> — average validator commission, min stake, total bonding/unbonding, last era rewards total.</li>
            </ul>
            <p>Click any block or transaction to drill into its detail page. Use the "View all" links to jump to the dedicated <i>Blocks</i> or <i>Transactions</i> pages.</p>
        `
    },
    {
        slug: 'blocks',
        title: 'Blocks page',
        category: 'browse',
        keywords: 'blocks history list extrinsic author parent hash',
        body: `
            <p>The Blocks page lists every block our indexer has crawled, newest first. Each row shows block number, age, extrinsic count, hash, and parent hash.</p>
            <p>Use the global search box at the top to filter across all columns, or click a column header to sort. Click any row to open the block detail page, which lists every extrinsic and event in that block.</p>
            <p>Pagination shows 50 rows per page by default; "Show more" extends to 200 rows; numbered pagination handles anything beyond.</p>
        `
    },
    {
        slug: 'transactions',
        title: 'Transactions page',
        category: 'browse',
        keywords: 'transactions transfers signed extrinsic fee status',
        body: `
            <p>The Transactions page is a feed of signed financial transactions (transfers and other balance-affecting calls). Columns: hash, signer, recipient, amount, fee, age, status.</p>
            <p>The <b>Load Older 100 Financial Tx</b> button at the bottom of the list pulls older transactions from the indexer in batches once you scroll past the in-memory cache.</p>
            <h3>Transaction detail recovery</h3>
            <p>If you open a <code>/tx/&lt;block&gt;/&lt;hash&gt;</code> URL and the transaction isn't there — chain reorg, hand-edited URL, or an event ID misrouted as a tx hash — the explorer shows a recovery card with a context-aware action button: <i>View block</i> for event IDs, <i>Search recent blocks</i> for stale hashes, <i>Deep search</i> for everything else.</p>
        `
    },
    {
        slug: 'events',
        title: 'Events page',
        category: 'browse',
        keywords: 'events log section method pallet runtime emit',
        body: `
            <p>The Events page shows the raw event log of the chain, excluding transactions (which have their own page). Events are emitted by runtime modules when something happens: <i>balances.Transfer</i> when PDEX moves, <i>staking.Reward</i> when an era pays out, <i>democracy.Proposed</i> when a referendum is filed.</p>
            <p>Use the Section and Method dropdowns to narrow to a specific runtime module or event type. Pagination matches the blocks/transactions pattern.</p>
        `
    },
    {
        slug: 'validators',
        title: 'Validators page',
        category: 'browse',
        keywords: 'validators list active stake commission risk apy scorecard slashes',
        body: `
            <p>The Validators page lists every validator currently authoring blocks. Columns: address, identity, total stake (own + nominated), commission, real APY (30-day), and Now vs Real.</p>
            <h3>What to look for</h3>
            <ul>
                <li><b>HIGH RISK badge</b> — commission &gt; 50%. The validator keeps a majority of rewards. Avoid.</li>
                <li><b>Est. APY (current commission)</b> — the chain's nominal maximum APY adjusted for the validator's current commission. A projection of what nominating this validator would yield if conditions hold — not a measured historical average.</li>
                <li><b>Total stake</b> — too low risks dropping out of the active set; very high may dilute your share.</li>
            </ul>
            <p>Click a row to open the <b>Validator Detail</b> page, which adds a scorecard with estimated APY, commission band, active-era rate, slash count, and current stake. Star the validator (top-right) to add to your <b>Watchlist</b>.</p>
        `
    },
    {
        slug: 'holders',
        title: 'Top PDEX holders',
        category: 'browse',
        keywords: 'holders top rich list balance share supply',
        body: `
            <p>The Holders page ranks addresses by total balance, with each holder's percentage of the total supply. Useful for tracking treasury, exchange, and large institutional accounts.</p>
            <p>Identity is shown when set on chain; otherwise you see the short SS58 address. Click any row to open the address's full account details page.</p>
        `
    },
    {
        slug: 'accounts',
        title: 'Account details',
        category: 'browse',
        keywords: 'account address balance identity transactions events label watchlist',
        body: `
            <p>Click any address anywhere in the explorer to land on its account-details page at <code>/account/&lt;address&gt;</code>. You see:</p>
            <ul>
                <li><b>Identity table</b> — balance breakdown (total, free, frozen), display name, roles, and a community-labels panel.</li>
                <li><b>Transactions tab</b> — every signed financial transaction the address signed or received.</li>
                <li><b>Events tab</b> — every event the address appeared in (staking rewards, governance votes, etc.).</li>
                <li><b>Watchlist star</b> — toggles the address into your local watchlist.</li>
            </ul>
            <p>For your <i>own</i> wallet (richer dashboard with action buttons), use <i>My Account</i> from the sidebar — that lands you on <code>/wallet/&lt;address&gt;</code> instead.</p>
        `
    },
    {
        slug: 'search',
        title: 'Search',
        category: 'browse',
        keywords: 'search find lookup block hash address validator identity deep network',
        body: `
            <p>The search box in the top bar accepts a block number, block hash, transaction hash, address, validator identity, or extrinsic hash.</p>
            <p>The first pass runs locally against whatever the explorer has cached client-side — fast but limited. If that misses, click <b>Deep Search Network</b> at the bottom of the results to query the full server-side index and the chain RPC. On a hit, the explorer redirects to the right detail page.</p>
        `
    },
    {
        slug: 'sending-pdex',
        title: 'Sending PDEX',
        category: 'wallet',
        keywords: 'send transfer pdex recipient amount fee keep alive existential deposit',
        body: `
            <p>From the Wallet Dashboard's action bar, click <b>Send PDEX</b>. The modal opens:</p>
            <ol class="help-steps">
                <li><b>Recipient</b> — paste a Polkadex address (starts with "e"). Verify carefully.</li>
                <li><b>Amount</b> — in PDEX. The modal shows your transferable balance for reference.</li>
                <li><b>Keep account alive</b> — leave this checked unless you're intentionally draining your own account. With it on, the explorer refuses to drop your balance below the existential deposit (a fraction of a PDEX).</li>
                <li>Click <b>Send</b>. Your wallet extension pops up — review the call data and approve.</li>
            </ol>
            <p>On success, the modal closes and the dashboard refreshes within a couple of blocks.</p>
            <div class="help-callout warn">
                <b>Always test new addresses with a small amount.</b> Errors and typos in addresses are not reversible.
            </div>
            <h3>Common errors</h3>
            <ul>
                <li><b>"No wallet extension detected"</b> — install one, or open the explorer inside a mobile wallet's WebView.</li>
                <li><b>"Recipient below existential deposit"</b> — to fund a brand-new account, send at least the existential deposit.</li>
                <li><b>"Amount exceeds transferable balance"</b> — your free balance is below the requested amount after fees and locks.</li>
            </ul>
        `
    },
    {
        slug: 'switching-wallets',
        title: 'Switching wallets',
        category: 'wallet',
        keywords: 'switch wallet disconnect view only multiple accounts',
        body: `
            <p>The dashboard header has two key controls:</p>
            <ul>
                <li><b>Switch wallet</b> — returns to the connect picker so you can choose a different account from your extension.</li>
                <li><b>Disconnect</b> (topbar icon) — forgets the active wallet entirely.</li>
            </ul>
            <p>Both are local operations; the chain doesn't know or care which wallet your browser has open.</p>
            <p>If you want to peek at someone else's wallet without connecting, use the <i>"…look up any address"</i> input on the connect page. The dashboard renders in <b>view-only mode</b> — all action buttons hidden, but you see balances, validators, and recent activity.</p>
        `
    },
    {
        slug: 'identity',
        title: 'On-chain identity',
        category: 'wallet',
        keywords: 'identity display name display email twitter web matrix riot set clear reset register deposit',
        body: `
            <p class="lead">Register a display name, email, twitter handle, website, or Matrix ID on chain so other Polkadex apps see this address as a named entity — not just a raw <code>e…</code> address.</p>
            <h3>How to set it</h3>
            <ol class="help-steps">
                <li>Open your <b>Wallet Dashboard</b> and click <b>Set identity</b> (or <b>Update identity</b> if you already have one).</li>
                <li>Fill in any fields you want public. <b>Display name</b> is the one that shows up everywhere in the explorer; the rest are optional.</li>
                <li>Click <b>Save identity</b>. Your wallet pops up to sign.</li>
                <li>Within a couple of blocks, your new identity appears on the home page, validators list, holders ranking, and account-details pages.</li>
            </ol>
            <h3>About the deposit</h3>
            <p>The identity pallet locks a small refundable PDEX deposit while your identity exists. The exact amount is shown in the modal — it's a few PDEX, scaling slightly with how many fields you fill. When you clear the identity, the deposit returns to your free balance immediately.</p>
            <h3>Field limits</h3>
            <p>Each field is capped at <b>32 bytes</b> by the runtime. UTF-8 emoji and CJK characters use 3–4 bytes each, so plan accordingly. The form will truncate gracefully if you exceed.</p>
            <h3>Resetting (clearing) your identity</h3>
            <p>The same modal has a red <b>Reset (clear)</b> button when an identity already exists. Click it, confirm, and sign — your identity is removed and the deposit returns to your free balance. You can set a new one any time.</p>
            <div class="help-callout">
                <b>Identity is public.</b> Anything you put here is on chain forever — even after you clear it, indexers may keep the historical version. Don't include personal info you wouldn't want associated with your address permanently.
            </div>
            <h3>Verification / judgements</h3>
            <p>Registrars on Polkadex can attest that an identity is genuine — this shows up as a green check in some wallets and explorers. Requesting a judgement is a separate flow not yet exposed in the explorer UI; for now use <a href="https://polkadot.js.org/apps" target="_blank" rel="noopener" class="item-link">Polkadot.js Apps</a> if you need a verified identity.</p>
        `
    },
    {
        slug: 'proxies-and-multisig',
        title: 'Proxies & multisig',
        category: 'wallet',
        keywords: 'proxy multisig delegate signer threshold staking governance advanced',
        body: `
            <p>The Wallet Dashboard's <b>Advanced</b> section exposes two power-user features. Skip unless you specifically need them.</p>
            <h3>Proxies</h3>
            <p>A proxy is a delegated signer for your account, optionally restricted to a subset of calls. Examples:</p>
            <ul>
                <li><b>Staking proxy</b> — lets a hot wallet claim rewards without ever holding your stash key.</li>
                <li><b>Governance proxy</b> — delegate voting to someone you trust.</li>
            </ul>
            <p>The Proxies card lists each delegate with type and delay. <b>Remove</b> revokes a proxy; <b>Add proxy</b> authorises a new one. The proxy type dropdown is sourced from the live runtime metadata.</p>
            <div class="help-callout">
                <b>What this explorer can and cannot sign.</b> It signs <code>proxy.addProxy</code> and <code>proxy.removeProxy</code> for <em>your own</em> account — managing who may act for you. It does <b>not</b> support acting <em>as</em> someone's proxy (<code>proxy.proxy</code>): if an account has delegated to you, submit that call from <a href="https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.polkadex.ee#/extrinsics" target="_blank" rel="noopener" class="item-link">polkadot.js Apps</a>.
            </div>
            <h3>Multisig</h3>
            <p>A multisig is an address derived from a list of signers and a threshold (e.g. 2-of-3). Transactions need <b>at least threshold-of-N</b> approvals to execute. The address is deterministic — anyone with the same signer list and threshold can recompute it.</p>
            <p>The calculator turns a textarea of signer addresses + threshold into the corresponding multisig address. The <b>Pending approvals</b> table shows multisig transactions still waiting for further signatures.</p>
            <div class="help-callout">
                <b>Multisig here is read-only.</b> The calculator and the pending-approvals table are views — the explorer cannot approve, execute or cancel a multisig call (<code>multisig.asMulti</code>, <code>approveAsMulti</code>, <code>cancelAsMulti</code>). Sign those from <a href="https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.polkadex.ee#/extrinsics" target="_blank" rel="noopener" class="item-link">polkadot.js Apps</a>. Use this page to compute the address and to watch what is pending.
            </div>
            <div class="help-callout">
                <b>When to consider multisig.</b> Treasury accounts, DAOs, and high-value vaults benefit: no single key compromise loses funds. The trade-off is operational — every transaction needs several humans to coordinate signing.
            </div>
        `
    },
    {
        slug: 'how-staking-works',
        title: 'How staking works',
        category: 'staking',
        keywords: 'staking concept nominator validator era bond unbond pos nominated proof stake',
        body: `
            <p>Polkadex is a Nominated Proof-of-Stake chain. <b>Validators</b> author and verify blocks; <b>nominators</b> like you support validators with PDEX stake and earn a share of the rewards.</p>
            <p>Your PDEX moves through five states:</p>
            <ol class="help-steps">
                <li><b>Free</b> — normal balance, spendable.</li>
                <li><b>Bonded</b> — committed to staking. Not yet earning.</li>
                <li><b>Nominating</b> — backing validators. Each era (~24h) you receive a share of their rewards, minus commission.</li>
                <li><b>Unbonding</b> — you've requested some stake back. A 28-day cool-down begins.</li>
                <li><b>Withdrawable</b> — cool-down complete; one more call returns it to free.</li>
            </ol>
            <div class="help-callout">
                <b>You only earn while nominating.</b> Bonding by itself doesn't pay. You must also nominate at least one active validator. Validators outside the active set in a given era pay no rewards even if you nominate them.
            </div>
        `
    },
    {
        slug: 'nominating',
        title: 'Nominating a validator',
        category: 'staking',
        keywords: 'nominate stake bond validator pick commission slash apy',
        body: `
            <p>From the dashboard, click <b>Stake more</b>. The first time, the call is a combined <code>bond + nominate</code>; on later top-ups it's <code>bondExtra</code>. The explorer figures out which call shape your runtime accepts and handles it.</p>
            <h3>Before you nominate</h3>
            <p>Browse the Validators page. Look at:</p>
            <ul>
                <li><b>Commission</b> — the cut the validator keeps. Avoid &gt; 50% (HIGH RISK badge).</li>
                <li><b>Total stake</b> — too low risks dropping out; very high dilutes your share. Aim near the active-set median.</li>
                <li><b>Slash count</b> — non-zero means past penalties. One is usually accidental; many is a pattern.</li>
                <li><b>Real APY</b> — our rolling 30-day actual yield, after commission.</li>
            </ul>
            <h3>The stake modal</h3>
            <p>The modal pre-fills your current nominations. Use the search box to filter validators. You can nominate up to 16 at once — spread across several gives exposure even if one drops out. Type the amount and click <b>Stake</b>.</p>
            <div class="help-callout">
                <b>Rewards start next era.</b> A nomination made <i>during</i> era N takes effect from era N+1.
            </div>
        `
    },
    {
        slug: 'claiming-rewards',
        title: 'Claiming rewards',
        category: 'staking',
        keywords: 'claim payout rewards staking payoutstakers utility batch',
        body: `
            <p>Rewards are computed per era per validator and sit on chain as unclaimed entries until someone calls <code>staking.payoutStakers</code>. Any account can trigger a payout — not just you.</p>
            <p>On the dashboard, the <b>Pay out rewards</b> button shows the unclaimed entry count in parentheses. Click it. The modal lists each unpaid <i>(era, validator, amount)</i> tuple. Click <b>Claim all</b> and the explorer packages up to 30 payout calls into a single <code>utility.batch</code> transaction — sign once, get every reward in one go.</p>
            <div class="help-callout warn">
                <b>Era retention window.</b> The chain prunes payable era history after ~84 eras. If you wait too long, the unclaimed reward becomes uncollectable. The explorer flags expiring eras with an orange badge.
            </div>
        `
    },
    {
        slug: 'unstaking',
        title: 'Unstaking & unbonding',
        category: 'staking',
        keywords: 'unstake unbond withdraw cool down 28 days unlock chill min nominator bond max',
        body: `
            <p>Click <b>Unstake</b> on the dashboard. Enter the PDEX amount you want to unbond. The modal shows the current unbonding period — typically 28 days — and your existing unlocking balance (if any).</p>
            <p>After signing, the PDEX moves into the <b>unbonding</b> state. When the unbonding period elapses, one more call (<code>withdrawUnbonded</code>) returns it to your free balance. Open the <b>Unstake</b> modal on My Account — when matured funds are waiting, it shows a “Withdrawable now” row with a <b>Withdraw unbonded funds</b> button.</p>
            <p>You can have multiple in-flight unbonding chunks at once, each with its own clock.</p>
            <h3>Partial vs. full unbond</h3>
            <p>The network enforces a <b>minimum bond</b> — usually 100 PDEX. A partial unbond that would leave you below that threshold is rejected by the runtime. The modal shows the current minimum so you can size your unbond accordingly.</p>
            <p>Clicking <b>Max</b> performs a full unbond. The explorer batches a <code>chill</code> call before <code>unbond</code> in a single atomic transaction — this removes your stash from the nominator set first so the runtime accepts an active bond of zero. After a full unbond your nominations are cleared; if you later top up with <code>bond_extra</code>, you'll need to re-nominate before earning rewards again.</p>
        `
    },
    {
        slug: 'staking-rewards-page',
        title: 'Staking Rewards page',
        category: 'staking',
        keywords: 'staking rewards history apr realized csv tax export chart era',
        body: `
            <p>The page at <code>/staking-rewards/&lt;address&gt;</code> is the deep view of any address's reward history. You don't need to be signed in to inspect your own rewards.</p>
            <h3>On the page</h3>
            <ul>
                <li><b>Summary cards</b> — Claimed Rewards, Unpaid, Total, Claimed Payouts, Eras, and the <b>realized APR card</b>.</li>
                <li><b>Realized APR</b> — headline 30-day APR, with 90-day and all-time in the subtitle plus the bonded PDEX used in the calculation.</li>
                <li><b>Per-validator stacked-bar chart</b> of daily rewards.</li>
                <li><b>Filter pills</b> — All / Claimed / Unpaid.</li>
                <li><b>Reward table</b> — Era, Date, Amount, Status, Validator, Block. Sortable, paginated.</li>
                <li><b>Download buttons</b> — CSV, JSON, Tax (year…).</li>
            </ul>
            <h3 id="tax">Tax CSV</h3>
            <p>The <b>Tax (year)</b> button opens a year picker and produces a year-scoped CSV with a PDEX→USD spot price at era close on every row. Only claimed rewards are included; unclaimed eras are excluded as not-yet-realised income. A totals row sits at the bottom.</p>
            <div class="help-callout warn">
                <b>Not tax advice.</b> Your jurisdiction's treatment of staking rewards (income at receipt? at claim? at sale?) is yours to confirm with a qualified accountant.
            </div>
        `
    },
    {
        slug: 'governance-overview',
        title: 'How Polkadex is governed',
        category: 'gov',
        keywords: 'governance overview democracy council treasury referendum motion proposal',
        body: `
            <p>Polkadex is community-governed. PDEX holders propose changes, vote on referenda, and spend treasury funds. The explorer surfaces the entire lifecycle in three pages:</p>
            <ul>
                <li><b>Democracy</b> — public proposals and binding on-chain referenda.</li>
                <li><b>Council</b> — elected body that can fast-track proposals and manage treasury approvals.</li>
                <li><b>Treasury</b> — on-chain PDEX pot funded from fees + slashes; spent on community proposals.</li>
            </ul>
            <p>Off-chain debate lives at <i>Discussions</i>. Any proposal, motion, or referendum number is clickable in any table — it opens the <b>governance detail modal</b> with status, proposer, beneficiary, blocks, and call hash. Voting itself is not in the modal; use the per-row Aye/Nay buttons on the Democracy → Referenda table.</p>
        `
    },
    {
        slug: 'democracy-and-voting',
        title: 'Democracy & voting',
        category: 'gov',
        keywords: 'democracy referendum vote aye nay conviction lock public proposal',
        body: `
            <p>A <b>referendum</b> is a binding on-chain vote. Once it passes (and a short enactment delay elapses), the proposed call is dispatched automatically.</p>
            <h3>Voting</h3>
            <p>On the Democracy → Referenda tab, ongoing referenda have <b>Aye</b> / <b>Nay</b> buttons inline. Click your direction; the vote modal opens.</p>
            <ul>
                <li><b>Side toggle</b> — switch Aye/Nay before submitting.</li>
                <li><b>Lock amount</b> — how much PDEX you're locking behind the vote.</li>
                <li><b>Conviction</b> — multiplier. <code>None</code> (0.1×, no lock) up to <code>Locked6x</code> (6×, locked 32 eras after the referendum closes). Default <code>Locked1x</code>.</li>
            </ul>
            <div class="help-callout">
                <b>Conviction is a trade-off.</b> Higher conviction = more vote weight, but a longer lock on your PDEX. If you feel strongly and don't need the PDEX soon, scale conviction up.
            </div>
        `
    },
    {
        slug: 'council-and-motions',
        title: 'Council & motions',
        category: 'gov',
        keywords: 'council motion member candidacy vote elections fast-track',
        body: `
            <p>The <b>Council</b> is an elected body that can fast-track proposals, manage treasury approvals, and veto bad runtime upgrades. A <b>motion</b> is a council vote on a specific call.</p>
            <p>Two tabs:</p>
            <ul>
                <li><b>Members</b> — seat and runner-up counts, candidate count, Term Progress dial.</li>
                <li><b>Motions</b> — every council motion (active and historical) with threshold and tally. Click a motion # to see status, the call it dispatches, blocks, and on-chain proposal hash.</li>
            </ul>
            <p>The header has <b>Submit Candidacy</b> (run for a seat) and <b>Vote</b> (rank candidates in an ongoing election round) buttons.</p>
            <h3>Filtering motions</h3>
            <p>The Motions tab has a <b>status</b> pill row (Voting open, Threshold met, Rejected, Voting ended, Executed, Approved, Disapproved, Closed) and a <b>Call type</b> dropdown (e.g. <code>treasury.approveProposal</code>). Both filters apply to the open motions <i>and</i> the Resolved Motions table, and stay visible even when nothing is currently open — handy for finding, say, every treasury-approval motion the council has handled.</p>
            <h3>Proposing a motion</h3>
            <p>A <b>Propose motion</b> button is shown on the Motions tab to everyone — you don't need to connect first to see it. Tabling a motion does require a council seat: when you act, you're prompted to connect a wallet, and the submission is restricted to current council members. Use it to table a treasury <b>approve</b> or <b>reject</b> for a pending proposal: pick the call, enter the treasury proposal #, set the approval threshold (defaults to a simple majority of seats), and sign. The motion then appears under Motions for the council to vote on, and dispatches its call once it reaches threshold. This is how an "open" treasury proposal actually gets approved — there is no approve button on the proposal itself.</p>
            <p>You can also start this straight from a proposal: on the <a href="/treasury" class="item-link">Treasury</a> page, every open proposal row has a <b>Propose motion</b> button, and opening a proposal's detail (click its <code>#</code>) shows <b>Propose approval motion</b> / <b>Propose rejection motion</b>. Either opens the same dialog pre-filled with that proposal's number.</p>
        `
    },
    {
        slug: 'treasury',
        title: 'Treasury',
        category: 'gov',
        keywords: 'treasury proposal beneficiary bond approval awards',
        body: `
            <p>The Treasury is an on-chain pot of PDEX, funded from transaction fees and slashed stake. Anyone can submit a proposal asking for funds; the council and/or a referendum approve or reject.</p>
            <p>Four tabs: <b>Overview, Open, Approved, History</b>. Each lists proposals by ID, proposer, beneficiary, requested PDEX, and status.</p>
            <p>The header <b>Submit proposal</b> button opens a modal where you can post a new request. A deposit is required, and rejected proposals burn the deposit — so write carefully and discuss in <i>Discussions</i> first.</p>
        `
    },
    {
        slug: 'discussions',
        title: 'Discussions',
        category: 'gov',
        keywords: 'discussions forum thread post sign in wallet signature',
        body: `
            <p>Off-chain commentary on governance items lives at <code>/discussions</code>. Each thread is associated with a governance proposal so people can debate the merits before voting.</p>
            <h3>Reading</h3>
            <p>No sign-in needed. Browse the thread list; click any thread for the per-thread view.</p>
            <h3>Posting</h3>
            <p>Click <b>Sign in with wallet</b>. The explorer asks your wallet to sign a short challenge — no transaction, just a signature. The resulting bearer token is stored locally and lasts <b>7 days</b>, then you'll be asked to sign again. Each post shows your address and a local-time timestamp.</p>
        `
    },
    {
        slug: 'analytics',
        title: 'Network analytics',
        category: 'tools',
        keywords: 'analytics dashboard kpi charts treasury price daily transactions active addresses',
        body: `
            <p>The Analytics page at <code>/analytics</code> is the bird's-eye view of the chain — useful for monitoring health or spotting anomalies. Click the date-range pills (Last 7d / 30d / 90d / Year) to change the window.</p>
            <h3>KPI strip</h3>
            <ul>
                <li><b>Indexed blocks</b> — how many blocks we have indexed vs. chain head.</li>
                <li><b>Indexed transactions</b> — count of balances transfers held in the local transaction index.</li>
                <li><b>Validators</b> — active / total registered (with current era).</li>
                <li><b>Nominators</b> — active / total.</li>
                <li><b>Total staked</b> — total bonded PDEX (with % of issuance).</li>
                <li><b>Total issuance</b> — current supply.</li>
            </ul>
            <h3>Charts</h3>
            <p>Six time-series charts: daily transactions, daily PDEX volume, daily active addresses, daily blocks produced, PDEX/USD, and cumulative treasury awards.</p>
        `
    },
    {
        slug: 'watchlist',
        title: 'Watchlist',
        category: 'tools',
        keywords: 'watchlist star bookmark favourite address validator proposal referendum',
        body: `
            <p>The Watchlist is your private bookmark folder. Star anything that matters — an address, a validator, a referendum, a treasury proposal — and it shows up at <code>/watchlist</code>.</p>
            <p>The data lives entirely in your browser (<code>pdex_watchlist_v1</code>); no server-side personal storage. There's no cross-device sync — by design.</p>
            <h3>What you can star</h3>
            <p>Addresses, validators, referenda, council motions, treasury proposals, public proposals, blocks. Anywhere a star icon appears, click to toggle.</p>
            <p>On the Watchlist page, items are grouped by kind. Each shows its label, the date you starred it, and a star icon to unstar. A <b>Clear all</b> button at the top wipes the list.</p>
        `
    },
    {
        slug: 'community-labels',
        title: 'Community labels',
        category: 'tools',
        keywords: 'labels community vote report veto signed identity address suggest',
        body: `
            <p>Community labels turn anonymous addresses into named entities through community consensus. Anyone with a wallet can suggest a label; everyone votes; the address owner has veto power. The highest-scored label is shown everywhere that address appears.</p>
            <h3>Posting a label</h3>
            <ol class="help-steps">
                <li>Connect a wallet.</li>
                <li>Go to the Account Details page of the address.</li>
                <li>In the Labels panel, click <b>Sign in with wallet</b>. Your wallet signs a short challenge — no transaction, just a signature. The token persists for 7 days.</li>
                <li>Type your label (max 64 chars) and click <b>Suggest</b> (or <b>Set label</b> if you own the address).</li>
            </ol>
            <h3>Voting, reporting, veto</h3>
            <ul>
                <li><b>Up/down chevrons</b> — vote any non-self label. The viewer's own vote is highlighted.</li>
                <li><b>Report</b> — flag inappropriate labels. At ≥3 distinct reporters the label is auto-hidden.</li>
                <li><b>Veto</b> — only the address owner. Hides a label they don't want associated with their account.</li>
            </ul>
            <div class="help-callout">
                <b>Rate limit.</b> Each wallet can post at most one label-related write per 60 seconds, to prevent spam.
            </div>
        `
    },
    {
        slug: 'privacy',
        title: 'Privacy & data handling',
        category: 'tools',
        keywords: 'privacy gdpr data storage cookies localstorage rights tracking analytics',
        body: `
            <p>Short version: we don't track you, we don't set cookies, we don't run third-party analytics. The full <b>Privacy Policy</b> lives at <code>/privacy</code>; the localStorage inventory at <code>/cookies</code>.</p>
            <h3>What we store about you</h3>
            <ul>
                <li><b>On-chain data</b> — already public. We index it, we don't own it.</li>
                <li><b>Local storage</b> — a handful of <code>pdex_*</code> keys on your device only (wallet address, watchlist, label session, tour-seen flag, banner dismissal, APR period). Never sent to us.</li>
                <li><b>Server logs</b> — standard web-server logs (IP, user-agent, URL, response, timestamp). 30-day retention.</li>
            </ul>
            <h3>What we do NOT do</h3>
            <p>No Google Analytics, no Mixpanel, no Segment, no advertising scripts, no third-party JavaScript. Every script the explorer loads runs from <code>explorer.polkadex.ee</code>.</p>
            <h3>Your rights</h3>
            <p>Under GDPR, UK GDPR, and CCPA you can request access, correction, and deletion. Clear local storage any time via your browser settings or the <b>Reset all preferences</b> button on <code>/cookies</code>. To delete community labels, discussions, or vote rows you authored, message us with the wallet that signed them.</p>
        `
    },
    {
        slug: 'troubleshooting',
        title: 'Troubleshooting & FAQ',
        category: 'reference',
        keywords: 'troubleshoot faq help error problem issue fix',
        body: `
            <h3>"Why is my balance different here from in my wallet extension?"</h3>
            <p>They should match within a block. If they don't, the explorer is likely a few blocks behind chain head while the indexer backfills. Refresh after a minute or two.</p>
            <h3>"I sent a transaction but I cannot find it."</h3>
            <p>Wait two blocks (about 12 seconds). Or use the transaction hash in the global search bar — don't try to construct the URL by hand.</p>
            <h3>"The Pay out button is disabled."</h3>
            <p>You have no unclaimed reward entries — either you're not nominating, or someone else has already triggered the payout on your behalf.</p>
            <h3>"Why is realized APR different from the chain's theoretical APR?"</h3>
            <p>Theoretical APR is a target; realized is what you actually got after commission and active-era variability. Realized is usually a few percentage points lower.</p>
            <h3>"I see a 503 'Connecting to Polkadex node…' message."</h3>
            <p>Our backend lost its WebSocket connection to the chain RPC. It auto-reconnects within seconds. Click the Retry button. If it persists, try again later.</p>
            <h3>"How do I delete a label I posted by mistake?"</h3>
            <p>Open the address's account-details page. In the Labels panel, your own label has a <b>Remove mine</b> button. Sign in with the same wallet first if you posted from another device.</p>
        `
    },
    {
        slug: 'brand-kit',
        title: 'Brand kit',
        category: 'reference',
        keywords: 'brand kit colours colors palette typography logo design tokens identity',
        body: `
            <p class="lead">A quick-reference cheatsheet for the explorer's visual identity — colours, typography, logo usage, iconography, spacing tokens, and voice rules.</p>
            <p>The interactive version lives at <a href="/brand" class="item-link"><b>/brand</b></a>. Click any colour swatch on that page to copy its hex value. Tokens are read live from the CSS, so the page always reflects what the site is rendering.</p>
            <p>A markdown reference for engineering and design pairing lives at <code>BRAND.md</code> in the repo root.</p>
            <h3>Quick facts</h3>
            <ul>
                <li><b>Primary colour</b> is Polkadex pink <code>#E6007A</code> — reserved for the most important call to action on each screen.</li>
                <li><b>Secondary colour</b> is accent green <code>#00E676</code> — for successful actions and positive metrics.</li>
                <li><b>Typeface</b> is Inter (300/400/500/600/700), self-hosted from this origin (no Google Fonts request). Monospace stack is <code>Courier New, monospace</code> for addresses, hashes, and URLs.</li>
                <li><b>Icons</b> come from Boxicons 2.1.4, used via the <code>bx-*</code> class system.</li>
            </ul>
            <div class="help-callout">
                <b>Source of truth.</b> When the brand evolves, edit the <code>:root</code> block in <code>styles.css</code> and the <code>BRAND.md</code> file together — the <a href="/brand" class="item-link">/brand</a> page reads from CSS at render time so it stays in sync automatically.
            </div>
        `
    },
    {
        slug: 'governance-calendar',
        title: 'Governance calendar',
        category: 'gov',
        keywords: 'calendar governance referendum referenda motion treasury proposal schedule timeline',
        body: `
            <p class="lead">The Governance Calendar at <a href="/calendar" class="item-link"><b>/calendar</b></a> gives you a single view of every active and recent on-chain governance event: democracy referenda, council motions, and treasury proposals — with their tabled dates, voting end times, and current status.</p>
            <h3>What you'll see</h3>
            <ul>
                <li><b>Active events</b> float to the top with a live "X days Y hours left" countdown until voting closes.</li>
                <li><b>Recent activity</b> is sorted by most recently resolved.</li>
                <li><b>Filter pills</b> let you narrow to just referenda, motions, or treasury proposals.</li>
                <li><b>List vs Month view</b>: list view is sortable, paginated, and filterable by text. Month view is a 7-column grid with coloured dots per event — click a dot to open that proposal.</li>
            </ul>
            <h3>How end times are calculated</h3>
            <p>For events with a known wall-clock end timestamp (treasury, motions), we display that directly. For referenda that end at a future block, we estimate using the current chain head and Polkadex's ~12-second block time. Estimates drift by a few minutes over a 7-day voting period — close enough to plan around.</p>
            <h3>Related</h3>
            <p>For per-pallet detail, see the <a href="/democracy" class="item-link"><b>Democracy</b></a>, <a href="/council" class="item-link"><b>Council</b></a>, and <a href="/treasury" class="item-link"><b>Treasury</b></a> pages. The calendar is a roll-up of those.</p>
        `
    },
    {
        slug: 'price-chart',
        title: 'PDEX price chart',
        category: 'tools',
        keywords: 'price chart pdex history graph coinmarketcap cmc usd usdt 7 day 30 day 90 day all-time',
        body: `
            <p class="lead">A full-screen view of the PDEX/USD price, reached by clicking the price in the bottom-left corner of the sidebar.</p>
            <h3>What you see</h3>
            <p>The current PDEX price and 24-hour percent change sit at the top of the page, with a line chart showing the selected period below and high/low/volume/period-change stats underneath.</p>
            <h3>Choosing a time period</h3>
            <p>Pick from <strong>7D · 30D · 90D · 1Y · ALL</strong> with the pills above the chart. Your choice is remembered between visits via a small <code>pdex_price_period</code> entry in your browser's local storage (no cookies, never sent to our server — see <a href="/cookies" class="item-link">/cookies</a>).</p>
            <h3>Where the data comes from</h3>
            <p>Live price polls come from <strong>CoinGecko</strong>, which aggregates PDEX across its real markets — no API key required. (CoinMarketCap can be added as an extra source with a key.) Historical PDEX/USDT data going back to PDEX's first trading day in March 2022 is retained on disk, so the chart stays a single continuous series.</p>
            <h3>Closing</h3>
            <p>Click the <strong>×</strong> in the top-right of the chart page to return to wherever you were before opening it.</p>
        `
    },
    {
        slug: 'email-alerts',
        title: 'Email alerts',
        category: 'gov',
        keywords: 'email alerts subscription notification referendum proposal closing reminder unsubscribe',
        body: `
            <p class="lead">Get a short email when on-chain events happen on Polkadex — new referenda, public proposals, 24-hour voting reminders, and more. Double opt-in, one-click unsubscribe.</p>
            <h3>How to subscribe</h3>
            <p>Open the subscribe form from any of three places:</p>
            <ul>
                <li>The <strong>Email alerts</strong> button on the homepage banner when a new referendum is announced.</li>
                <li>The button at the top of the <a href="/calendar" class="item-link">Governance Calendar</a>.</li>
                <li>The button at the top of the <a href="/democracy" class="item-link">Democracy</a> page.</li>
            </ul>
            <p>Enter your email, pick which events you want, and submit. We'll send a one-time confirmation link — click it once and you're set.</p>
            <h3>What you can subscribe to</h3>
            <p><strong>Governance:</strong> new referendum opens for voting · new public proposal tabled · 24-hour reminder before a referendum closes · referendum result (passed/failed) · treasury proposal activity · council motion activity.</p>
            <p><strong>Network milestones:</strong> runtime upgrade · era boundary summary · chain stalled alert. These are off by default — most people only want the governance events.</p>
            <h3>Unsubscribe and preferences</h3>
            <p>Every alert email has two links in its footer. <strong>Manage preferences</strong> opens a page where you can tick and untick any of the nine alert types above and save — no login or wallet needed, because the link itself identifies you. <strong>Unsubscribe</strong> stops everything.</p>
            <p>Both links are personal to you, so treat them like a password: anyone who has the URL can change your alert settings. Neither is indexed by search engines. If you lose them, the footer of any later alert email has a fresh copy.</p>
            <p>Confirming a subscription and unsubscribing both ask you to click a button on the page rather than acting on the link itself — that is deliberate, so a corporate mail scanner following links in your inbox can't opt you in or out without you.</p>
            <h3>Privacy and data handling</h3>
            <p>Your email address is stored only to deliver the alerts you've selected. We don't sell it, hand it to other services, or use it for marketing. The <a href="/privacy" class="item-link">privacy policy</a> has the full details. We use a transactional email provider (Postmark) for delivery — they see the email content but only to send it.</p>
        `
    },
    {
        slug: 'governance-notifications',
        title: 'New-event notifications',
        category: 'gov',
        keywords: 'notification banner toast new referendum proposal alert announcement',
        body: `
            <p class="lead">The explorer surfaces new democracy events so you don't have to manually check every visit. Notifications fire when a referendum is tabled or a new public proposal is submitted on-chain.</p>
            <h3>Where you'll see them</h3>
            <ul>
                <li><b>Homepage banner</b>: a coloured row at the top of the dashboard with the event ID and a View button. Persists until you click the ✕ close button or visit the event's page.</li>
                <li><b>Toast notification</b>: a brief popup in the bottom-right when the explorer's poller first detects a new event while you're browsing. Auto-dismisses after 6 seconds; click to open, ✕ to dismiss early.</li>
            </ul>
            <h3>How "new" is decided</h3>
            <p>The explorer keeps the highest referendum and proposal index you've previously seen in your browser's local storage. When the on-chain index is higher, you get a banner. Closing the banner stops THIS index from popping up again; a later event still triggers a fresh banner.</p>
            <p>Visiting the <a href="/calendar" class="item-link">Calendar</a> page also marks events as "seen" — useful if you've reviewed today's governance and want to start fresh.</p>
            <h3>Privacy</h3>
            <p>The poll runs every 60 seconds against <code>/api/governance/latest</code> and only reads public on-chain state. No tracking. The "last seen" indices live in your browser and are documented at <a href="/cookies" class="item-link">/cookies</a>.</p>
        `
    },
    {
        slug: 'glossary',
        title: 'Glossary',
        category: 'reference',
        keywords: 'glossary terminology terms definitions',
        body: `
            <dl class="help-glossary">
                <dt>era</dt><dd>A scheduling unit on Polkadex (~24 hours). Validator rewards are computed and paid per era.</dd>
                <dt>validator</dt><dd>A node that authors and verifies blocks. Earns rewards proportional to (own + nominated) stake, minus commission.</dd>
                <dt>nominator</dt><dd>A PDEX holder who delegates stake to validators.</dd>
                <dt>bonded</dt><dd>PDEX set aside for staking; unspendable until withdrawn after the unbonding period.</dd>
                <dt>slash</dt><dd>Penalty deducted from a misbehaving validator and its nominators.</dd>
                <dt>referendum</dt><dd>A public on-chain vote that, when approved, dispatches a runtime call automatically.</dd>
                <dt>conviction</dt><dd>Multiplier on your referendum vote. Higher conviction = more weight + longer lock.</dd>
                <dt>motion</dt><dd>A council-collective proposal. Approved motions dispatch their underlying call on chain.</dd>
                <dt>council</dt><dd>Elected body of PDEX holders that can fast-track proposals and manage treasury approvals.</dd>
                <dt>treasury</dt><dd>On-chain PDEX pot funded from fees + slashes; spendable by community proposals.</dd>
                <dt>commission</dt><dd>The fraction of rewards a validator keeps before distributing the rest to its nominators.</dd>
                <dt>payout</dt><dd>On-chain claim that distributes era rewards. Anyone can trigger it.</dd>
                <dt>extrinsic</dt><dd>A signed or unsigned transaction that mutates chain state.</dd>
                <dt>event</dt><dd>A side-effect emitted by a pallet during block execution.</dd>
                <dt>pallet</dt><dd>A self-contained runtime module — staking, democracy, treasury, etc.</dd>
                <dt>SS58</dt><dd>Substrate's address encoding. Polkadex uses prefix 88; addresses start with "e".</dd>
                <dt>proxy</dt><dd>Delegated signer for another account, optionally restricted to a subset of calls.</dd>
                <dt>multisig</dt><dd>Deterministic address derived from signers + threshold. Calls need threshold-of-N approvals.</dd>
                <dt>existential deposit</dt><dd>The minimum balance the chain insists an account hold to exist.</dd>
                <dt>utility.batch</dt><dd>A call that bundles N other calls into one signed transaction.</dd>
                <dt>unbonding period</dt><dd>Cool-down (28 days) between requesting unbonded PDEX and being able to withdraw it.</dd>
                <dt>chain reorg</dt><dd>When the chain replaces a recent block with a different one. The explorer's recovery card handles small reorgs transparently.</dd>
            </dl>
        `
    },
];

// O(1) lookup
const HELP_BY_SLUG = Object.fromEntries(HELP_TOPICS.map(t => [t.slug, t]));

function renderHelpLanding(searchQuery = '') {
    const article = document.getElementById('help-article');
    const nav = document.getElementById('help-sidebar-nav');
    if (!article || !nav) return;

    const q = (searchQuery || '').trim().toLowerCase();
    const isFiltered = q.length > 0;

    // Build the category-grouped sidebar (filters in place during search).
    let sidebarHtml = '';
    for (const cat of HELP_CATEGORIES) {
        const topics = HELP_TOPICS.filter(t => {
            if (t.category !== cat.id) return false;
            if (!isFiltered) return true;
            const hay = (t.title + ' ' + (t.keywords || '') + ' ' + t.body).toLowerCase();
            return hay.includes(q);
        });
        if (!topics.length) continue;
        sidebarHtml += `<div class="help-cat"><h4>${stakingEscapeHtml(cat.label)}</h4><ul>`;
        for (const t of topics) {
            sidebarHtml += `<li><a href="/help/${stakingEscapeHtml(t.slug)}" class="help-nav-link">${stakingEscapeHtml(t.title)}</a></li>`;
        }
        sidebarHtml += '</ul></div>';
    }
    if (!sidebarHtml) {
        sidebarHtml = `<p style="padding: 10px; font-size: 0.85rem; color: var(--text-secondary);">No matches for "${stakingEscapeHtml(q)}".</p>`;
    }
    nav.innerHTML = sidebarHtml;

    // Landing card list
    let landingHtml = `<header class="help-article-header">
        <h1>Help center</h1>
        <p class="help-lead">A practical, end-to-end guide to the Polkadex Mainnet Explorer.
        Pick a topic from the sidebar, or browse by category below. Use the search box
        to find a specific concept.</p>
    </header>`;
    for (const cat of HELP_CATEGORIES) {
        const topics = HELP_TOPICS.filter(t => t.category === cat.id);
        if (!topics.length) continue;
        landingHtml += `<section class="help-cat-section">
            <h2>${stakingEscapeHtml(cat.label)}</h2>
            <div class="help-card-grid">`;
        for (const t of topics) {
            // Pull the first ~140 chars of body text as the card teaser.
            const teaser = (t.body || '')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
            landingHtml += `<a href="/help/${stakingEscapeHtml(t.slug)}" class="help-card">
                <h3>${stakingEscapeHtml(t.title)}</h3>
                <p>${stakingEscapeHtml(teaser)}…</p>
            </a>`;
        }
        landingHtml += '</div></section>';
    }
    article.innerHTML = landingHtml;
}

function renderHelpArticle(slug) {
    const article = document.getElementById('help-article');
    const nav = document.getElementById('help-sidebar-nav');
    if (!article || !nav) return;
    const topic = HELP_BY_SLUG[slug];
    if (!topic) {
        // Unknown slug — render a friendly not-found card with link to the landing.
        article.innerHTML = `<header class="help-article-header">
            <h1>Topic not found</h1>
            <p class="help-lead">We couldn't find a help article at <code>/help/${stakingEscapeHtml(slug)}</code>.
            Try the <a href="/help" class="item-link">help center landing</a> or use the search.</p>
        </header>`;
        renderHelpSidebar('');
        return;
    }

    // SEO meta — make the title and description reflect the specific article.
    updateSeoMeta('help', {
        title: topic.title + ' — Polkadex Explorer help',
        description: ((topic.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)),
        canonicalPath: '/help/' + topic.slug,
        noindex: false
    });

    // Per-article JSON-LD so search engines can surface the article directly.
    setRouteJsonLd({
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        '@id': SITE_ORIGIN + '/help/' + topic.slug,
        headline: topic.title,
        about: topic.title,
        url: SITE_ORIGIN + '/help/' + topic.slug,
        inLanguage: 'en',
        isPartOf: { '@type': 'WebSite', name: 'Polkadex Explorer', url: SITE_ORIGIN }
    });

    // Prev/next nav within the flat topic list
    const idx = HELP_TOPICS.findIndex(t => t.slug === slug);
    const prev = idx > 0 ? HELP_TOPICS[idx - 1] : null;
    const next = idx < HELP_TOPICS.length - 1 ? HELP_TOPICS[idx + 1] : null;
    const prevHtml = prev ? `<a href="/help/${stakingEscapeHtml(prev.slug)}" class="help-prevnext prev">
        <span>← Previous</span><strong>${stakingEscapeHtml(prev.title)}</strong></a>` : '<span></span>';
    const nextHtml = next ? `<a href="/help/${stakingEscapeHtml(next.slug)}" class="help-prevnext next">
        <span>Next →</span><strong>${stakingEscapeHtml(next.title)}</strong></a>` : '<span></span>';

    article.innerHTML = `<nav class="help-breadcrumb">
            <a href="/help" class="item-link">Help</a> / <span>${stakingEscapeHtml(topic.title)}</span>
        </nav>
        <header class="help-article-header">
            <h1>${stakingEscapeHtml(topic.title)}</h1>
        </header>
        <div class="help-body">${topic.body}</div>
        <footer class="help-article-footer">
            ${prevHtml}
            ${nextHtml}
        </footer>`;

    renderHelpSidebar(slug);
}

function renderHelpSidebar(activeSlug) {
    const nav = document.getElementById('help-sidebar-nav');
    if (!nav) return;
    let html = '';
    for (const cat of HELP_CATEGORIES) {
        const topics = HELP_TOPICS.filter(t => t.category === cat.id);
        if (!topics.length) continue;
        html += `<div class="help-cat"><h4>${stakingEscapeHtml(cat.label)}</h4><ul>`;
        for (const t of topics) {
            const cls = t.slug === activeSlug ? 'help-nav-link active' : 'help-nav-link';
            html += `<li><a href="/help/${stakingEscapeHtml(t.slug)}" class="${cls}">${stakingEscapeHtml(t.title)}</a></li>`;
        }
        html += '</ul></div>';
    }
    nav.innerHTML = html;
}

// Wire the in-page search input. Debounced so we don't re-render every keystroke
// for users on slower devices.
let helpSearchTimer = null;
function wireHelpSearch() {
    const input = document.getElementById('help-search');
    if (!input || input.dataset.wired === '1') return;
    input.dataset.wired = '1';
    input.addEventListener('input', () => {
        clearTimeout(helpSearchTimer);
        helpSearchTimer = setTimeout(() => {
            // Search filters the sidebar; the article area shows the landing.
            renderHelpLanding(input.value);
        }, 120);
    });
}

// Convenience: returns an inline-icon string the explorer's various features
// can paste alongside their UI to point at a specific help article. The
// resulting <a> is the contextual "?" hook the user picked over a global
// help link.
function helpIcon(slug, label) {
    const safeSlug = (slug || '').replace(/[^a-z0-9-]/gi, '');
    const tooltip = label || 'Help on this topic';
    return `<a href="/help/${safeSlug}" class="help-inline-icon" title="${stakingEscapeHtml(tooltip)}" aria-label="${stakingEscapeHtml(tooltip)}"><i class='bx bx-help-circle'></i></a>`;
}
// Expose on window so renderers across the codebase can use it without
// reaching into the module's internals.
window.helpIcon = helpIcon;

// ─── Brand kit page ────────────────────────────────────────────────────────
// Quick-reference cheatsheet at /brand. Source of truth for the brand kit
// is the CSS custom properties on :root — this function reads them at render
// time so the page can never drift from the live theme. Click any swatch to
// copy its hex value to the clipboard. The matching markdown reference lives
// at BRAND.md in the repo root.
function renderBrandPage() {
    const container = document.getElementById('brand-page-content');
    if (!container) return;

    // Resolved CSS variable values. We read from the :root computed style so
    // a designer can edit the variable list and the brand page updates in
    // lockstep. Hex colours are normalised to uppercase for display.
    const rootStyle = getComputedStyle(document.documentElement);
    const v = name => (rootStyle.getPropertyValue(name) || '').trim();
    const tokens = {
        primary:      v('--brand-primary'),
        primaryGlow:  v('--brand-primary-glow'),
        secondary:    v('--brand-secondary'),
        bgDark:       v('--bg-dark'),
        bgSurface:    v('--bg-surface'),
        bgGlass:      v('--bg-glass'),
        border:       v('--border-color'),
        borderHover:  v('--border-hover'),
        textPrimary:  v('--text-primary'),
        textSecondary:v('--text-secondary'),
        textMuted:    v('--text-muted'),
        success:      v('--success'),
        error:        v('--error'),
        radiusSm:     v('--radius-sm'),
        radiusMd:     v('--radius-md'),
        radiusLg:     v('--radius-lg'),
        sidebarWidth: v('--sidebar-width'),
        transitionFast:   v('--transition-fast'),
        transitionNormal: v('--transition-normal'),
    };

    const swatch = (label, value, onLight = false) => `
        <button type="button" class="brand-swatch" data-copy="${stakingEscapeHtml(value)}"
                style="background:${stakingEscapeHtml(value)};color:${onLight ? '#14101c' : '#fff'};">
            <span class="brand-swatch-name">${stakingEscapeHtml(label)}</span>
            <span class="brand-swatch-hex">${stakingEscapeHtml(value)}</span>
        </button>`;

    const tokenRow = (token, value) => `
        <tr>
            <td><code>${stakingEscapeHtml(token)}</code></td>
            <td><code>${stakingEscapeHtml(value)}</code></td>
        </tr>`;

    container.innerHTML = `
        <header class="brand-header">
            <div>
                <span class="brand-eyebrow">Polkadex Mainnet Explorer · Brand Kit v1.0</span>
                <h1>Brand kit</h1>
                <p class="brand-lead">A quick-reference cheatsheet for the visual identity that runs across the
                Polkadex Mainnet Explorer. Click any colour swatch to copy its hex value.
                Tokens are read live from the CSS custom properties on <code>:root</code>, so this
                page always reflects what the site is actually rendering.</p>
            </div>
            <div class="brand-header-logo">
                <img src="/logo.png" alt="Polkadex logo" class="js-brand-img" data-fallback="hide">
            </div>
        </header>

        <section class="brand-section">
            <h2>Colour palette</h2>
            <h3>Brand</h3>
            <div class="brand-swatch-row">
                ${swatch('Primary',   tokens.primary)}
                ${swatch('Secondary', tokens.secondary)}
            </div>

            <h3>Surfaces</h3>
            <div class="brand-swatch-row">
                ${swatch('Background', tokens.bgDark)}
                ${swatch('Surface',    tokens.bgSurface)}
                ${swatch('Glass',      tokens.bgGlass)}
            </div>

            <h3>Text</h3>
            <div class="brand-swatch-row">
                ${swatch('Primary',   tokens.textPrimary, true)}
                ${swatch('Secondary', tokens.textSecondary, true)}
                ${swatch('Muted',     tokens.textMuted, true)}
            </div>

            <h3>Semantic</h3>
            <div class="brand-swatch-row">
                ${swatch('Success', tokens.success, true)}
                ${swatch('Error',   tokens.error)}
            </div>

            <p class="brand-note">Use <strong>Primary</strong> for the most-important call to action on a screen
            (only one per view). <strong>Secondary</strong> highlights successful actions, growth, and confirmation.
            Keep semantic colours for their semantic role only — don't repaint a positive action red.</p>
        </section>

        <section class="brand-section">
            <h2>Typography</h2>
            <div class="brand-type-grid">
                <div class="brand-type-sample">
                    <span class="brand-type-label">Display · Inter 800, -0.01em</span>
                    <span style="font-family: 'Inter', sans-serif; font-weight: 800; font-size: 2.4rem; letter-spacing: -0.01em; line-height: 1.1;">Polkadex Explorer</span>
                </div>
                <div class="brand-type-sample">
                    <span class="brand-type-label">H1 · Inter 700</span>
                    <span style="font-family: 'Inter', sans-serif; font-weight: 700; font-size: 1.7rem; line-height: 1.2;">Real-time on-chain data</span>
                </div>
                <div class="brand-type-sample">
                    <span class="brand-type-label">H2 · Inter 700</span>
                    <span style="font-family: 'Inter', sans-serif; font-weight: 700; font-size: 1.2rem;">Section heading</span>
                </div>
                <div class="brand-type-sample">
                    <span class="brand-type-label">Body · Inter 400</span>
                    <span style="font-family: 'Inter', sans-serif; font-weight: 400; font-size: 0.95rem; line-height: 1.6;">Most paragraph content lives at this size. Comfortable on long-form pages and dense list views alike.</span>
                </div>
                <div class="brand-type-sample">
                    <span class="brand-type-label">Caption · Inter 400, muted</span>
                    <span style="font-family: 'Inter', sans-serif; font-weight: 400; font-size: 0.82rem; color: var(--text-secondary);">Subtitles, table headers, secondary metadata.</span>
                </div>
                <div class="brand-type-sample">
                    <span class="brand-type-label">Mono · Courier New</span>
                    <span style="font-family: 'Courier New', monospace; font-size: 0.9rem; color: var(--brand-secondary);">e8ab9d4fJp…  block #12338677  /api/extrinsic</span>
                </div>
            </div>
            <p class="brand-note">Primary face is <strong>Inter</strong> (self-hosted, weights 300/400/500/600/700).
            Monospace stack is system-default <code>Courier New, monospace</code> — used for addresses, hashes, URLs, and storage keys.</p>
        </section>

        <section class="brand-section">
            <h2>Logo</h2>
            <div class="brand-logo-grid">
                <div class="brand-logo-card" style="background: var(--bg-dark);">
                    <img src="/logo.png" alt="Polkadex logo on dark" class="js-brand-img" data-fallback="plain">
                    <span>On dark</span>
                </div>
                <div class="brand-logo-card" style="background: #f5f3fa;">
                    <img src="/logo.png" alt="Polkadex logo on light" class="js-brand-img" data-fallback="light">
                    <span style="color: #14101c;">On light</span>
                </div>
                <div class="brand-logo-card" style="background: var(--brand-primary);">
                    <img src="/logo.png" alt="Polkadex logo on brand" class="js-brand-img" data-fallback="plain">
                    <span>On brand</span>
                </div>
            </div>
            <p class="brand-note">Keep the logo at <strong>at least 32&nbsp;px tall</strong> on screen,
            <strong>at least 12&nbsp;mm tall</strong> in print. Maintain clear space equal to the height of the mark on all four sides.
            Don't recolour, skew, add a drop shadow, or place over busy imagery.</p>
        </section>

        <section class="brand-section">
            <h2>Iconography</h2>
            <p>Icons come from <strong>Boxicons 2.1.4</strong> (loaded via the <code>bx-*</code> class system).
            Standard sizes: <code>16px</code> inline with body text, <code>20px</code> for buttons,
            <code>24px</code> for headings. Tint with <code>currentColor</code> by default; switch to
            <code>--brand-primary</code> for emphasis or actionable affordances.</p>
            <div class="brand-icon-row">
                <span class="brand-icon-sample"><i class='bx bx-grid-alt'></i> grid-alt</span>
                <span class="brand-icon-sample"><i class='bx bx-wallet'></i> wallet</span>
                <span class="brand-icon-sample"><i class='bx bx-line-chart'></i> line-chart</span>
                <span class="brand-icon-sample"><i class='bx bx-shield-quarter'></i> shield-quarter</span>
                <span class="brand-icon-sample"><i class='bx bx-trophy'></i> trophy</span>
                <span class="brand-icon-sample"><i class='bx bx-bar-chart-alt-2'></i> bar-chart-alt-2</span>
                <span class="brand-icon-sample"><i class='bx bx-search'></i> search</span>
                <span class="brand-icon-sample"><i class='bx bx-help-circle'></i> help-circle</span>
            </div>
        </section>

        <section class="brand-section">
            <h2>Spacing, radii, motion</h2>
            <table class="brand-token-table">
                <thead><tr><th>Token</th><th>Value</th></tr></thead>
                <tbody>
                    ${tokenRow('--radius-sm', tokens.radiusSm)}
                    ${tokenRow('--radius-md', tokens.radiusMd)}
                    ${tokenRow('--radius-lg', tokens.radiusLg)}
                    ${tokenRow('--sidebar-width', tokens.sidebarWidth)}
                    ${tokenRow('--transition-fast', tokens.transitionFast)}
                    ${tokenRow('--transition-normal', tokens.transitionNormal)}
                    ${tokenRow('--border-color', tokens.border)}
                    ${tokenRow('--border-hover', tokens.borderHover)}
                </tbody>
            </table>
            <p class="brand-note">Radii follow a 4&nbsp;px modular scale (8, 12, 16). Use <code>--radius-sm</code>
            for inputs and pills, <code>--radius-md</code> for cards, <code>--radius-lg</code> for full panels and modals.
            Transition <em>fast</em> for hover/focus state changes; <em>normal</em> for layout shifts.</p>
        </section>

        <section class="brand-section">
            <h2>Voice in three lines</h2>
            <ol class="brand-voice-list">
                <li><strong>Direct.</strong> Lead with the verb. "Connect your wallet" beats "Authentication is available via wallet connection."</li>
                <li><strong>Honest.</strong> Name limitations. "We cannot delete on-chain data" is more useful than a paragraph of legalese.</li>
                <li><strong>Concrete.</strong> Show the number, not the adjective. "Backfilled to block 8,402,991" not "extensive history."</li>
            </ol>
        </section>

        <section class="brand-section">
            <h2>Don't</h2>
            <ul class="brand-dont-list">
                <li>Don't add new colours outside this palette. Extend by adjusting alpha on existing tokens.</li>
                <li>Don't use the brand primary as a body-text colour — it's reserved for actions and emphasis.</li>
                <li>Don't introduce third-party JavaScript or analytics. The privacy page promises none, and the brand follows.</li>
                <li>Don't recolour the logo. If you need a single-tone version for a constrained surface, use the all-white or all-black version.</li>
            </ul>
        </section>

        <section class="brand-section">
            <h2>Assets &amp; further reference</h2>
            <ul class="brand-asset-list">
                <li><a href="/logo.png" class="item-link" download>logo.png</a> — primary mark, full colour.</li>
                <li><a href="/favicon.png" class="item-link" download>favicon.png</a> — favicon and PWA icon.</li>
                <li><a href="/manifest.webmanifest" class="item-link">manifest.webmanifest</a> — PWA manifest, includes icon list.</li>
                <li>Markdown reference: <code>BRAND.md</code> at the repo root.</li>
                <li>Live source of truth: the <code>:root</code> block in <code>styles.css</code>.</li>
            </ul>
        </section>
    `;

    // Click-to-copy on the swatch buttons. Use the Clipboard API where available
    // and fall back to a hidden textarea + execCommand for older browsers /
    // restricted-permissions environments. Show transient feedback inline.
    // Image fallbacks — formerly inline onerror= attributes, which (a) are
    // blocked under script-src 'self' and (b) assigned innerHTML from an
    // attribute string (audit F-165's exact complaint).
    container.querySelectorAll('.js-brand-img').forEach(img => {
        img.addEventListener('error', () => {
            const mode = img.getAttribute('data-fallback');
            if (mode === 'hide') { img.style.display = 'none'; return; }
            const fb = document.createElement('div');
            fb.className = 'brand-logo-fallback';
            if (mode === 'light') fb.style.color = '#14101c';
            fb.textContent = 'logo.png';
            img.replaceWith(fb);
        });
    });

    container.querySelectorAll('.brand-swatch').forEach(btn => {
        btn.addEventListener('click', async () => {
            const value = btn.dataset.copy;
            if (!value) return;
            try {
                await navigator.clipboard.writeText(value);
            } catch (_) {
                const ta = document.createElement('textarea');
                ta.value = value; document.body.appendChild(ta);
                ta.select(); try { document.execCommand('copy'); } catch (_) {}
                document.body.removeChild(ta);
            }
            const original = btn.querySelector('.brand-swatch-hex').textContent;
            btn.querySelector('.brand-swatch-hex').textContent = 'copied!';
            setTimeout(() => {
                const lbl = btn.querySelector('.brand-swatch-hex');
                if (lbl) lbl.textContent = original;
            }, 1100);
        });
    });
}

// Storage-notice banner wiring. Shown until dismissed; dismissal preference
// is itself stored in pdex_banner_dismissed (acknowledged in the banner copy
// and the /cookies table). Auto-loads on first DOMContentLoaded.
const BANNER_KEY = 'pdex_banner_dismissed';
function initStorageNoticeBanner() {
    const el = document.getElementById('storage-notice-banner');
    if (!el) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(BANNER_KEY) === '1'; } catch (_) {}
    if (dismissed) return;
    el.style.display = 'block';
    const btn = document.getElementById('storage-notice-dismiss');
    if (btn) btn.addEventListener('click', () => {
        try { localStorage.setItem(BANNER_KEY, '1'); } catch (_) {}
        el.style.display = 'none';
    });
}
// Run after the DOM is parsed. script.js is a module, so this fires after
// HTML parsing has completed.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStorageNoticeBanner);
} else {
    initStorageNoticeBanner();
}

// Reusable HowTo + FAQ schemas for the connect-wallet page. These help search
// engines surface our connect/send flow for "how to send PDEX" / "connect
// Polkadex wallet" / "Nova Wallet PDEX" style queries.
function buildWalletConnectJsonLd() {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'HowTo',
                '@id': 'https://explorer.polkadex.ee/wallet#howto-send-pdex',
                'name': 'How to send PDEX on the Polkadex Mainnet',
                'description': 'Connect a Substrate wallet to the Polkadex Explorer and transfer PDEX to any Polkadex address.',
                'image': 'https://explorer.polkadex.ee/og-image.png',
                'totalTime': 'PT2M',
                'tool': [
                    { '@type': 'HowToTool', 'name': 'Polkadot.js, Talisman, or SubWallet browser extension (desktop)' },
                    { '@type': 'HowToTool', 'name': 'Nova Wallet or SubWallet mobile app with in-app browser (mobile)' }
                ],
                'supply': [
                    { '@type': 'HowToSupply', 'name': 'A small PDEX balance to cover the network fee (~0.05 PDEX is plenty)' }
                ],
                'step': [
                    {
                        '@type': 'HowToStep', 'position': 1,
                        'name': 'Connect your wallet',
                        'text': 'Open explorer.polkadex.ee/wallet and click Connect Wallet. On mobile, open the URL inside Nova Wallet or SubWallet\'s in-app dapp browser.',
                        'url': 'https://explorer.polkadex.ee/wallet'
                    },
                    {
                        '@type': 'HowToStep', 'position': 2,
                        'name': 'Authorise the site',
                        'text': 'Approve the connection request in your wallet so it can share account addresses with the explorer.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 3,
                        'name': 'Pick your account',
                        'text': 'Choose the Polkadex account you want to use. Your account dashboard opens with balances, staking, and recent transactions.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 4,
                        'name': 'Open the Send PDEX modal',
                        'text': 'Click the Send PDEX action on the dashboard.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 5,
                        'name': 'Enter recipient and amount',
                        'text': 'Paste the recipient\'s Polkadex address, type the amount in PDEX, and review the live network-fee estimate.'
                    },
                    {
                        '@type': 'HowToStep', 'position': 6,
                        'name': 'Sign in your wallet',
                        'text': 'Click Sign & Send and approve the transaction in your wallet extension. The transfer is included on-chain within seconds.'
                    }
                ]
            },
            {
                '@type': 'FAQPage',
                '@id': 'https://explorer.polkadex.ee/wallet#faq',
                'mainEntity': [
                    {
                        '@type': 'Question',
                        'name': 'Can I send PDEX from a mobile wallet like Nova Wallet?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Yes. Open explorer.polkadex.ee inside Nova Wallet or SubWallet\'s built-in dapp browser. Your accounts are injected automatically, just like with a desktop Polkadot.js extension, and you can sign transfers and staking actions directly in the mobile wallet.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'Which wallets work with the Polkadex Explorer?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'On desktop: Polkadot.js extension, Talisman, SubWallet, PolkaGate. On mobile: Nova Wallet and SubWallet via their in-app dapp browsers. The explorer never stores private keys — every transaction is signed by your wallet.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'How much does a PDEX transfer cost?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Network fees on Polkadex Mainnet are very small — typically a few thousandths of a PDEX. The Send PDEX modal shows a live fee estimate before you sign so there are no surprises.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'What is "Keep my account alive" on the Send PDEX modal?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Substrate chains require accounts to hold at least the existential deposit. Keep account alive uses balances.transferKeepAlive, which fails the transfer if it would leave your balance below the existential deposit (preventing accidental account reaping). Uncheck it only if you intend to empty an account completely.'
                        }
                    },
                    {
                        '@type': 'Question',
                        'name': 'Can I view my Polkadex account without connecting a wallet?',
                        'acceptedAnswer': {
                            '@type': 'Answer',
                            'text': 'Yes. Paste any Polkadex address into the "look up any address" field on the wallet page for a read-only dashboard with balances, staking, and recent activity. You only need to connect a wallet when you want to send or sign actions.'
                        }
                    }
                ]
            }
        ]
    };
}

// Parse the current address-bar URL into the route token routeTo() expects
// (e.g. "block/12345"). Pathname wins; if a legacy #X fragment is present on
// "/" we fall back to it (and the boot routine rewrites the URL).
function readRouteFromLocation() {
    const path = window.location.pathname || '/';
    const stripped = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (stripped) return stripped;
    const hash = window.location.hash.replace(/^#/, '').trim();
    return hash || 'home';
}

// Push a new history entry and route to it. All call sites that used to do
// `window.location.hash = X` now go through here so the URL bar shows a
// clean path and crawlers can index it.
// How many history entries THIS SPA session has pushed (F-129). Session-
// scoped on purpose: a fresh tab starts at 0 regardless of referrer.
let spaNavDepth = 0;

function navigateTo(target, { replace = false } = {}) {
    if (!target || target === 'home') target = '';
    // Don't push duplicate history entries for the same URL.
    const newPath = '/' + target.replace(/^\/+/, '');
    const currentPath = window.location.pathname + window.location.hash;
    if (newPath !== currentPath || window.location.hash) {
        const fn = replace ? 'replaceState' : 'pushState';
        try {
            history[fn](null, '', newPath || '/');
            if (!replace) spaNavDepth++;   // F-129
        }
        catch (e) { /* same-origin / sandboxed iframes can throw; fall back below */ }
    }
    routeTo(target || 'home');
}

// One-time wiring: clean-URL routing, popstate, click delegation, legacy
// hash-URL redirect. Called at the bottom of init.
function bootSeoRouter() {
    // Rewrite any legacy "#X" URLs people might have bookmarked into clean URLs
    // so canonical/og:url match what the user sees.
    const legacyHash = window.location.hash.replace(/^#/, '').trim();
    if (legacyHash && (window.location.pathname === '/' || window.location.pathname === '')) {
        try { history.replaceState(null, '', '/' + legacyHash); }
        catch (e) { /* ignore */ }
    }

    window.addEventListener('popstate', () => {
        // F-129: a Back consumes one of the entries this SPA pushed, so the
        // depth counter has to come down with it. A review caught the first
        // version only ever incrementing — the count could exceed the real
        // back-stack, and closeDetailView would call history.back() into
        // nothing again, which is the very no-op it was written to avoid.
        spaNavDepth = Math.max(0, spaNavDepth - 1);
        routeTo(readRouteFromLocation());
    });

    // Delegated click handler for internal links. Catches both new clean
    // URLs (href="/blocks") and any leftover legacy fragment links
    // (href="/blocks") rendered from inline HTML strings.
    document.addEventListener('click', (e) => {
        // Honor modifier keys and middle-click so "open in new tab" still works.
        if (e.defaultPrevented) return;
        if (e.button !== 0 && e.button !== undefined) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest && e.target.closest('a');
        if (!a) return;
        if (a.target && a.target !== '' && a.target !== '_self') return;
        if (a.hasAttribute('download')) return;
        const href = a.getAttribute('href');
        if (!href) return;
        // External / mailto / tel / protocol-relative.
        if (/^(https?:)?\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        let target = null;
        if (href.startsWith('#')) {
            const t = href.substring(1).trim();
            if (!t) return;
            // Audit F-016: an in-page anchor is NOT a route. This handler used
            // to treat every `href="#x"` as one, which broke the /developers
            // table of contents in two different ways: "#price" and
            // "#discussions" are also real route names, so those links left the
            // page entirely, and the other twelve (#overview, #cors, …) matched
            // no route and opened a blank pane.
            //
            // Decided by the DOM, not by a hardcoded list of exceptions: if an
            // element with that id exists on the page, the author meant "scroll
            // to it". Anything else keeps the old routing behaviour, so legacy
            // fragment links still work.
            const anchored = document.getElementById(t);
            if (anchored) {
                e.preventDefault();
                anchored.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Keep the fragment in the URL so the link is copyable and Back
                // works, but do NOT push a route — the path must stay put.
                if (window.location.hash !== `#${t}`) {
                    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}#${t}`);
                }
                return;
            }
            target = t;
        } else if (href.startsWith('/')) {
            // Audit F-059: an absolute same-origin path is USUALLY an SPA
            // route — but not always. /llms.txt, /sitemap.xml, /vendor/*.js
            // and friends are real files that nginx serves; intercepting them
            // routed users to a blank pane named "llms.txt". Anything with a
            // file extension, and the handful of extensionless real endpoints,
            // must fall through to a normal navigation.
            const path = href.split(/[?#]/)[0];
            const isRealFile = /\.[a-z0-9]{2,12}$/i.test(path)
                || path === '/robots.txt' || path.startsWith('/api/') || path.startsWith('/vendor/');
            if (isRealFile) return;
            target = href.replace(/^\/+/, '');
        } else {
            return;
        }
        e.preventDefault();
        navigateTo(target);
    });
}

// Routing Logic
// Council-page live polling. Started on route entry, stopped on any route
// change (routeTo runs for every navigation, so the stop below is the single
// choke point — no per-page cleanup to forget). 30s halves the worst-case
// staleness of the backend's 12s event-driven snapshot + short cache tier
// without adding meaningful load: it's one KV-backed GET per open tab.
let councilPollTimer = null;
function startCouncilPolling() {
    if (councilPollTimer) return;
    councilPollTimer = setInterval(() => {
        // Skip hidden tabs — no point polling a page nobody is looking at.
        if (document.visibilityState === 'visible') fetchCouncilData();
    }, 30000);
}
function stopCouncilPolling() {
    if (councilPollTimer) { clearInterval(councilPollTimer); councilPollTimer = null; }
}

function routeTo(target) {
    stopCouncilPolling();
    if (!target) target = 'home';

    // Strip query string and hash fragment before doing the route lookup. The
    // page sections are matched by `data-page="<route>"` (e.g. "treasury"),
    // not by the full URL — leaving "?proposal=85" attached would make
    // routeTo look for `data-page="treasury?proposal=85"` and find nothing,
    // showing a blank page. The query string is preserved in window.location
    // and parsed by destination pages via tryOpenFromQueryString(); the route
    // here cares only about the path component.
    const qIdx = target.indexOf('?');
    if (qIdx >= 0) target = target.substring(0, qIdx);
    const hIdx = target.indexOf('#');
    if (hIdx >= 0) target = target.substring(0, hIdx);

    let mainTarget = target;
    let detailId = null;
    let detailId2 = null;

    if (target.startsWith('account/')) {
        mainTarget = 'account-details';
        detailId = target.split('/')[1];
    } else if (target.startsWith('validator/')) {
        mainTarget = 'validator-details';
        detailId = target.split('/')[1];
    } else if (target.startsWith('block/')) {
        mainTarget = 'block-details';
        detailId = target.split('/')[1];
    } else if (target.startsWith('tx/') || target.startsWith('extrinsic/')) {
        // 'extrinsic/' is an alias: search results linked it for months while
        // only 'tx/' had a page (audit F-065), so shared links exist in the
        // wild and must keep resolving.
        mainTarget = 'tx-details';
        detailId = target.split('/')[1];
        detailId2 = target.split('/')[2];
    } else if (target.startsWith('staking-rewards/')) {
        mainTarget = 'staking-rewards';
        detailId = target.substring('staking-rewards/'.length);
    } else if (target.startsWith('wallet/')) {
        mainTarget = 'wallet';
        detailId = target.substring('wallet/'.length);
    } else if (target.startsWith('discussions/')) {
        mainTarget = 'discussions';
        detailId = target.substring('discussions/'.length);
    } else if (target === 'email/preferences' || target === 'email/preferences/') {
        // The first route where the slash is part of the page identity rather
        // than a detail id, so it collapses to a single-token data-page the
        // same way account/<addr> becomes account-details.
        mainTarget = 'email-preferences';
    } else if (target.startsWith('help/')) {
        // /help/<slug> — preserves the slug as the detail id so the dispatcher
        // can render the right article. /help by itself routes to the landing.
        mainTarget = 'help';
        detailId = target.substring('help/'.length);
    }

    // Update active nav
    navItems.forEach(n => {
        n.classList.remove('active');
        if (n.getAttribute('data-target') === mainTarget || n.getAttribute('data-target') === target) {
            n.classList.add('active');
        }
    });

    // Close sidebar on mobile
    if (typeof sidebar !== 'undefined' && sidebar) sidebar.classList.remove('open');

    // Refresh SEO metadata for the new route. Detail pages (block/validator/
    // wallet/etc.) will call updateSeoMeta() again with concrete data once the
    // fetcher resolves so titles/descriptions reflect real content.
    // Audit F-124: an unknown path used to fall through — every section
    // hidden (blank pane) while the SEO block inherited the HOMEPAGE's title
    // and index,follow, so any typo'd inbound link became a crawlable
    // duplicate of the home page. Rewrite to the explicit 404 pane instead.
    {
        const known = Array.from(pageSections).some(pg => pg.getAttribute('data-page') === mainTarget);
        if (!known) mainTarget = 'not-found';
    }
    updateSeoMeta(mainTarget, { canonicalPath: '/' + (target === 'home' ? '' : target) });

    // Show target page
    pageSections.forEach(page => {
        if (page.getAttribute('data-page') === mainTarget) {
            page.style.display = mainTarget.includes('details') ? 'block' : 'flex';
            if (mainTarget === 'home') {
                if (blocks && blocks.length > 0) renderBlocks();
                if (transactions && transactions.length > 0) renderTransactions();
            } else if (mainTarget === 'validators') {
                fetchValidators();
            } else if (mainTarget === 'holders') {
                fetchHolders();
            } else if (mainTarget === 'transactions') {
                fetchTransactions();
            } else if (mainTarget === 'blocks') {
                fetchBlocks();
            } else if (mainTarget === 'events') {
                fetchEvents();
            } else if (mainTarget === 'account-details') {
                fetchAccountDetails(detailId);
            } else if (mainTarget === 'validator-details') {
                fetchValidatorDetails(detailId);
            } else if (mainTarget === 'block-details') {
                fetchBlockDetails(detailId);
            } else if (mainTarget === 'tx-details') {
                fetchTxDetails(detailId, detailId2);
            } else if (mainTarget === 'staking-rewards') {
                initStakingRewardsPage(detailId);
            } else if (mainTarget === 'wallet') {
                initWalletPage(detailId);
            } else if (mainTarget === 'donate') {
                initDonatePage();
            } else if (mainTarget === 'discussions') {
                initDiscussionsPage(detailId);
            } else if (mainTarget === 'analytics') {
                fetchAnalyticsData();
            } else if (mainTarget === 'watchlist') {
                renderWatchlistPage();
            } else if (mainTarget === 'council') {
                fetchCouncilData();
                // Poll while the page is open. Motions are the one governance
                // surface where minutes matter — a 3-seat threshold can resolve
                // in a couple of blocks, and council members watching a live
                // vote previously saw a snapshot frozen at page entry. Paired
                // with the backend's event-driven snapshot refresh, a new vote
                // is visible here within ~15-40s of landing on-chain.
                startCouncilPolling();
            } else if (mainTarget === 'democracy') {
                initDemocracyPage();
            } else if (mainTarget === 'treasury') {
                fetchTreasuryData();
            } else if (mainTarget === 'search') {
                // /search reached without an active query — usually a page
                // refresh on the search results page, which loses the
                // in-memory `currentSearchQuery`. Render the inline prompt
                // so users have a paste-friendly box to retype into, instead
                // of staring at an empty results panel with a deep-search
                // button that has nothing to query.
                if (!currentSearchQuery) renderSearchPrompt();
            } else if (mainTarget === 'privacy' || mainTarget === 'cookies') {
                // /privacy and /cookies are fully static HTML — no fetcher.
                // Inject a route-scoped JSON-LD WebPage entry so crawlers
                // recognise these as canonical legal documents rather than
                // SPA shells. Also wire the cookies-page Reset button if
                // we're on /cookies.
                injectLegalPageJsonLd(mainTarget);
                if (mainTarget === 'cookies') wireCookiesResetButton();
            } else if (mainTarget === 'help') {
                // /help renders the landing; /help/<slug> renders a single
                // article with its own SEO + JSON-LD applied inside the renderer.
                if (detailId) {
                    renderHelpArticle(detailId);
                } else {
                    renderHelpLanding('');
                    renderHelpSidebar('');
                }
                wireHelpSearch();
            } else if (mainTarget === 'brand') {
                // /brand — static cheatsheet, no data fetch. Tokens are read
                // live from :root inside renderBrandPage.
                renderBrandPage();
            } else if (mainTarget === 'calendar') {
                // /calendar — unified governance timeline. Fetches once on
                // route entry; sorted active-first, then most-recent.
                renderCalendarPage();
                // Mark active referenda/proposals as "seen" — visiting the
                // calendar implies awareness, so future banners only pop on
                // events after this index.
                markGovernanceSeen('referendum', getLsNumber('pdex_gov_seen_ref'));
                markGovernanceSeen('proposal',   getLsNumber('pdex_gov_seen_proposal'));
            } else if (mainTarget === 'price') {
                // /price — full-screen PDEX price chart with period selector.
                // Reached by clicking the sidebar price ticker. Returns to
                // wherever the user came from via the close (X) button.
                renderPricePage();
            } else if (mainTarget === 'developers') {
                // /developers — API reference for external apps (mobile,
                // server-side proxies, third-party web apps). Static content,
                // SEO-indexable, no data fetch.
                renderDevelopersPage();
            } else if (mainTarget === 'decode') {
                // /decode — per-argument extrinsic decoder for any block.
                renderDecodePage();
            } else if (mainTarget === 'runtime') {
                // /runtime — runtime version, constants, read-only RPC console.
                renderRuntimePage();
            } else if (mainTarget === 'utilities') {
                // /utilities — offline helpers; no chain calls, so these keep
                // working even when the RPC is down.
                renderUtilitiesPage();
            } else if (mainTarget === 'chain-state') {
                // /chain-state — generic runtime storage inspector
                // (polkadot.js "Chain state" parity). Loads metadata once,
                // then queries on demand; supports ?pallet=&item=&args=&at=
                // deep links so a finding can be shared and re-verified.
                renderChainStatePage();
            } else if (mainTarget === 'email-preferences') {
                // /email/preferences?token=<t> — audit F-066. Reads its token
                // from window.location.search, not from the route token.
                renderEmailPreferencesPage();
            }
        } else {
            page.style.display = 'none';
        }
    });
}

// ─── Governance calendar ─────────────────────────────────────────────────────
// /calendar route: unified timeline of democracy referenda, council motions,
// and treasury proposals. Fetched once per page entry from /api/governance/calendar.
// Two views toggled by pill buttons:
//   - List (default): scrollable, time-sorted, kind-filterable. Uses makeTable.
//   - Month: a 7-column grid view of the current month + adjacent for context.
// Both modes are driven by the same in-memory `events` array.

let calendarEvents = [];
let calendarFilter = 'all';    // 'all' | 'referendum' | 'motion' | 'treasury'
let calendarView   = 'month';  // 'list' | 'month' — month is the default per user intent
let calendarMonthOffset = 0;   // 0 = current month, -1 = previous, +1 = next

async function renderCalendarPage() {
    const container = document.getElementById('calendar-page-content');
    if (!container) return;

    container.innerHTML = `
        <div class="calendar-header">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
                <div style="flex:1;min-width:0;">
                    <h1>Governance calendar ${helpIcon('governance-calendar', 'About this page')}</h1>
                    <p class="calendar-tagline">
                        On-chain governance at a glance — referenda, treasury proposals, and council motions
                        with their lifecycle dates and current status.
                    </p>
                </div>
                <button type="button" class="email-alerts-cta" data-email-subscribe="calendar">
                    <i class='bx bx-envelope'></i> Get email alerts ${helpIcon('email-alerts', 'About email alerts')}
                </button>
            </div>
        </div>
        <div class="calendar-controls">
            <div class="calendar-pills" role="tablist" aria-label="Filter by event type">
                <button type="button" class="pill active" data-cal-filter="all">All</button>
                <button type="button" class="pill" data-cal-filter="referendum">Referenda</button>
                <button type="button" class="pill" data-cal-filter="motion">Council motions</button>
                <button type="button" class="pill" data-cal-filter="treasury">Treasury</button>
            </div>
            <div class="calendar-view-toggle" role="tablist" aria-label="View style">
                <button type="button" class="pill" data-cal-view="list">
                    <i class='bx bx-list-ul'></i> List
                </button>
                <button type="button" class="pill active" data-cal-view="month">
                    <i class='bx bx-calendar'></i> Month
                </button>
            </div>
        </div>
        <div id="calendar-body" class="calendar-body">
            <div class="calendar-loading">Loading governance events…</div>
        </div>
    `;

    // Wire pills.
    container.querySelectorAll('[data-cal-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('[data-cal-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            calendarFilter = btn.getAttribute('data-cal-filter');
            paintCalendarBody();
        });
    });
    container.querySelectorAll('[data-cal-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('[data-cal-view]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            calendarView = btn.getAttribute('data-cal-view');
            calendarMonthOffset = 0;
            paintCalendarBody();
        });
    });

    try {
        const res = await fetch('/api/governance/calendar', { cache: 'no-store' });
        const data = await parseJsonResponse(res);
        calendarEvents = Array.isArray(data.events) ? data.events : [];
        paintCalendarBody();
    } catch (err) {
        const body = document.getElementById('calendar-body');
        if (body) body.innerHTML = `<div class="calendar-error">Couldn't load governance events: ${stakingEscapeHtml(err.message || String(err))}</div>`;
    }
}

function calendarFilteredEvents() {
    if (calendarFilter === 'all') return calendarEvents;
    return calendarEvents.filter(e => e.kind === calendarFilter);
}

function paintCalendarBody() {
    const body = document.getElementById('calendar-body');
    if (!body) return;
    const events = calendarFilteredEvents();
    if (events.length === 0) {
        body.innerHTML = `<div class="calendar-empty">No ${calendarFilter === 'all' ? '' : calendarFilter + ' '}governance events to show yet.</div>`;
        return;
    }
    if (calendarView === 'list') paintCalendarList(body, events);
    else paintCalendarMonth(body, events);
}

function paintCalendarList(body, events) {
    // Active first (already sorted server-side), then time-descending.
    body.innerHTML = '<div id="calendar-table-mount"></div>';
    makeTable({
        mount: '#calendar-table-mount',
        rows: events,
        columns: [
            { key: 'kind', label: 'Kind', sortable: true,
                render: (v) => `<span class="calendar-kind-badge kind-${v}">${stakingEscapeHtml(calendarKindLabel(v))}</span>` },
            { key: 'title', label: 'Item', sortable: true,
                render: (v, row) => `<a href="${row.link}" data-spa-link="true">${stakingEscapeHtml(v)}</a>` },
            { key: 'status', label: 'Status', sortable: true,
                render: (v, row) => `<span class="calendar-status ${row.isActive ? 'active' : 'resolved'}">${stakingEscapeHtml(v || '—')}</span>` },
            { key: 'startTime', label: 'Tabled', sortable: true,
                render: (v) => v ? formatLocalDate(new Date(v)) : '—' },
            { key: 'endTime', label: 'Ends / Ended', sortable: true,
                render: (v, row) => {
                    if (!v) return '—';
                    const when = formatLocalDate(new Date(v));
                    if (!row.isActive) return when;
                    // Active — add a countdown.
                    const remaining = v - Date.now();
                    if (remaining <= 0) return when + ' <span class="calendar-countdown soon">(closing)</span>';
                    const days = Math.floor(remaining / 86400000);
                    const hours = Math.floor((remaining % 86400000) / 3600000);
                    const label = days >= 1 ? `${days}d ${hours}h` : `${hours}h`;
                    return when + ` <span class="calendar-countdown">(${label} left)</span>`;
                } }
        ],
        defaultSort: { col: 'endTime', dir: 'desc' },
        pageSize: 25,
        filterPlaceholder: 'Filter by ID, status, proposer…'
    });
}

function calendarKindLabel(kind) {
    if (kind === 'referendum') return 'Referendum';
    if (kind === 'motion')     return 'Motion';
    if (kind === 'treasury')   return 'Treasury';
    return kind || '—';
}

function paintCalendarMonth(body, events) {
    const now = new Date();
    now.setMonth(now.getMonth() + calendarMonthOffset);
    const year  = now.getFullYear();
    const month = now.getMonth();
    const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });

    // Build a 6-row × 7-col grid starting from the Sunday on/before the 1st.
    const first = new Date(year, month, 1);
    const startSunday = new Date(first);
    startSunday.setDate(first.getDate() - first.getDay());

    // Bucket events into "day index" relative to startSunday for fast lookup.
    const buckets = new Map();
    const dayKey = (d) => Math.floor((d - startSunday) / 86400000);
    events.forEach(e => {
        const stamps = [e.startTime, e.endTime].filter(Boolean);
        stamps.forEach(t => {
            const d = new Date(t);
            const k = dayKey(d);
            if (k < 0 || k > 41) return;
            if (!buckets.has(k)) buckets.set(k, []);
            buckets.get(k).push({ event: e, isEnd: t === e.endTime });
        });
    });

    let cells = '';
    for (let i = 0; i < 42; i++) {
        const d = new Date(startSunday);
        d.setDate(startSunday.getDate() + i);
        const inMonth = d.getMonth() === month;
        const isToday = d.toDateString() === new Date().toDateString();
        const dayEvents = buckets.get(i) || [];
        const dots = dayEvents.slice(0, 4).map(({ event, isEnd }) =>
            `<a class="calendar-dot kind-${event.kind}" href="${event.link}" data-spa-link="true"
                title="${stakingEscapeHtml(event.title)} — ${isEnd ? 'ends' : 'tabled'}">
                ${stakingEscapeHtml(event.title.replace(/^[^#]*/, ''))}
             </a>`).join('');
        const overflow = dayEvents.length > 4 ? `<span class="calendar-dot-more">+${dayEvents.length - 4}</span>` : '';
        cells += `
            <div class="calendar-cell ${inMonth ? '' : 'out-of-month'} ${isToday ? 'today' : ''}">
                <div class="calendar-cell-date">${d.getDate()}</div>
                <div class="calendar-cell-events">${dots}${overflow}</div>
            </div>`;
    }

    body.innerHTML = `
        <div class="calendar-month-header">
            <button type="button" class="pill" data-cal-month-nav="-1" aria-label="Previous month">
                <i class='bx bx-chevron-left'></i>
            </button>
            <div class="calendar-month-label">${monthLabel}</div>
            <button type="button" class="pill" data-cal-month-nav="+1" aria-label="Next month">
                <i class='bx bx-chevron-right'></i>
            </button>
        </div>
        <div class="calendar-weekheader">
            ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div>${d}</div>`).join('')}
        </div>
        <div class="calendar-grid">${cells}</div>
    `;

    body.querySelectorAll('[data-cal-month-nav]').forEach(btn => {
        btn.addEventListener('click', () => {
            calendarMonthOffset += parseInt(btn.getAttribute('data-cal-month-nav'), 10);
            paintCalendarBody();
        });
    });
}

// ─── Sidebar price ticker (live polling) ─────────────────────────────────────
// The sidebar's bottom-left "PDEX Price" cell is the most-visible piece of
// data on every page, so it needs to stay fresh. Poll /api/price-latest on
// page load and every 60s thereafter, with the ticker also acting as the
// in-page CTA to the /price chart route (the whole row is wrapped in an
// <a href="/price">).
let priceTickerTimer = null;
async function pollPriceTicker() {
    const valEl = document.getElementById('sidebar-price-value');
    const chgEl = document.getElementById('sidebar-price-change');
    if (!valEl || !chgEl) return;
    try {
        const res = await fetch('/api/price-latest', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const latest = json && json.price;
        if (!latest || typeof latest.price !== 'number') {
            valEl.textContent = '—';
            chgEl.textContent = '';
            chgEl.className = 'change';
            return;
        }
        // Tiny fractions need more decimals; large prices need fewer. Pick
        // a sensible precision band so $0.04 doesn't render as "$0".
        const p = Number(latest.price);
        const maxFD = p >= 1 ? 3 : p >= 0.01 ? 4 : 6;
        valEl.textContent = '$' + p.toLocaleString('en-US', { maximumFractionDigits: maxFD });
        // Cache for the home-page market-cap recompute (which needs price ×
        // total issuance). pollPriceTicker fires every 60s, so the cell
        // stays in sync with whatever price the sidebar ticker shows.
        lastKnownPriceUsd = p;
        writeHomeCache({ priceUsd: p });
        updateMarketCapCell();
        // Repaint any USD subscripts currently in the DOM (Total Balance on
        // /wallet, plus any future PDEX-value cards that opt in with the
        // `data-pdex-amount` attribute).
        refreshUsdSubscripts();
        const pct = (latest.pctChange24h != null) ? Number(latest.pctChange24h) : null;
        if (pct == null || !Number.isFinite(pct)) {
            chgEl.textContent = '';
            chgEl.className = 'change';
        } else {
            const sign = pct >= 0 ? '+' : '';
            chgEl.textContent = sign + pct.toFixed(2) + '%';
            chgEl.className = 'change ' + (pct >= 0 ? 'positive' : 'negative');
        }
    } catch (e) {
        // Don't blank a previously-good value on a transient blip; leave the
        // last good reading on screen and try again next tick.
        if (valEl.textContent === '—') chgEl.textContent = '';
    }
}
function startPriceTickerPolling() {
    if (priceTickerTimer) return;        // idempotent — safe to call from multiple places
    pollPriceTicker();
    priceTickerTimer = setInterval(pollPriceTicker, 60_000);
}

// ─── Full-screen /price page ─────────────────────────────────────────────────
// Reached by clicking the sidebar price ticker. Shows the full PDEX/USD
// chart with a period selector, summary stats, and a close button that uses
// closeDetailView('home') — i.e., history.back() with a same-origin referrer
// fallback to home — so the user lands wherever they were before.

// Persisted period selection — survives reloads via /cookies key pdex_price_period.
const PRICE_PERIODS = [
    { label: '7D',  days: 7   },
    { label: '30D', days: 30  },
    { label: '90D', days: 90  },
    { label: '1Y',  days: 365 },
    { label: 'ALL', days: 4000 }, // ≥ full backfill window
];
let pricePagePeriodDays = 30;
let pricePageChart = null;

function getPricePeriodFromStorage() {
    try {
        const raw = localStorage.getItem('pdex_price_period');
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && PRICE_PERIODS.some(p => p.days === n)) return n;
    } catch (_) {}
    return 30;
}
function setPricePeriodInStorage(days) {
    try { localStorage.setItem('pdex_price_period', String(days)); } catch (_) {}
}

async function renderPricePage() {
    const root = document.getElementById('price-page-content');
    if (!root) return;
    pricePagePeriodDays = getPricePeriodFromStorage();

    // Initial chrome — show the header + close button immediately so the
    // page feels responsive even while the data fetch is in flight.
    root.innerHTML = `
        <div class="price-page-header">
            <div class="price-page-title">
                <h1>PDEX Price</h1>
                <div id="price-page-summary" class="price-page-summary">Loading…</div>
            </div>
            <button type="button" class="price-page-close" id="price-page-close-btn" aria-label="Close">
                <i class='bx bx-x'></i>
            </button>
        </div>
        <div class="price-page-controls">
            <div class="reward-filter" id="price-page-periods">
                ${PRICE_PERIODS.map(p => `<button type="button" class="reward-filter-btn${p.days === pricePagePeriodDays ? ' active' : ''}" data-price-period="${p.days}">${p.label}</button>`).join('')}
            </div>
            <div class="price-page-source" id="price-page-source"></div>
        </div>
        <div class="list-container glass">
            <div class="price-chart-wrap">
                <canvas id="price-page-chart"></canvas>
            </div>
        </div>
        <div class="price-page-stats" id="price-page-stats"></div>
    `;

    // Close button — return to wherever the user came from.
    const closeBtn = document.getElementById('price-page-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => closeDetailView('home'));

    // Period selector — re-fetches and re-renders without leaving the route.
    root.querySelectorAll('[data-price-period]').forEach(btn => {
        btn.addEventListener('click', () => {
            const days = parseInt(btn.getAttribute('data-price-period'), 10);
            if (!Number.isFinite(days) || days === pricePagePeriodDays) return;
            pricePagePeriodDays = days;
            setPricePeriodInStorage(days);
            root.querySelectorAll('[data-price-period]').forEach(b =>
                b.classList.toggle('active', parseInt(b.getAttribute('data-price-period'), 10) === days));
            loadPricePageData();
        });
    });

    await loadPricePageData();
}

async function loadPricePageData() {
    const summaryEl = document.getElementById('price-page-summary');
    const statsEl   = document.getElementById('price-page-stats');
    const sourceEl  = document.getElementById('price-page-source');
    try {
        const res = await fetch('/api/price-history?days=' + encodeURIComponent(pricePagePeriodDays), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const history = (json && json.history) || [];
        const latest  = (json && json.latest)  || null;

        // Summary line: current price + 24h change.
        if (latest && typeof latest.price === 'number') {
            const p = Number(latest.price);
            const maxFD = p >= 1 ? 4 : p >= 0.01 ? 5 : 7;
            const pct = latest.pctChange24h != null ? Number(latest.pctChange24h) : null;
            const pctHtml = (pct != null && Number.isFinite(pct))
                ? `<span class="price-change ${pct >= 0 ? 'positive' : 'negative'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% (24h)</span>`
                : '';
            summaryEl.innerHTML = `
                <span class="price-big">$${p.toLocaleString('en-US', { maximumFractionDigits: maxFD })}</span>
                ${pctHtml}`;
        } else {
            summaryEl.textContent = 'No price data yet.';
        }

        // Source attribution.
        if (sourceEl) {
            const providers = (json && json.bySource) || {};
            const activeNames = Object.keys(providers).filter(k => providers[k] && providers[k].count > 0);
            const labels = activeNames.map(n => (providers[n] && providers[n].label) || n);
            sourceEl.textContent = labels.length ? `Sources: ${labels.join(' + ')}` : '';
        }

        // Chart.
        renderPricePageChart(history);

        // Stats grid for the current period.
        if (statsEl) statsEl.innerHTML = buildPriceStatsHtml(history, pricePagePeriodDays);
    } catch (e) {
        if (summaryEl) summaryEl.textContent = 'Error loading price data: ' + (e.message || 'unknown');
    }
}

function renderPricePageChart(history) {
    const canvas = document.getElementById('price-page-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (pricePageChart) { pricePageChart.destroy(); pricePageChart = null; }
    if (!history.length) return;
    // Sparse x-axis labels for long ranges so they stay legible. With 1500+
    // points on the all-time view we want ~12 ticks total.
    const dateFmt = history.length > 120
        ? { month: 'short', year: '2-digit' }
        : { month: 'short', day: 'numeric' };
    pricePageChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: history.map(p => new Date(p.timestamp).toLocaleDateString('en-US', dateFmt)),
            datasets: [{
                label: 'PDEX / USD',
                data: history.map(p => p.price),
                borderColor: '#00E676',
                backgroundColor: 'rgba(0, 230, 118, 0.12)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.20,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ' $' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 6 }) } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 12, color: '#888' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: '#888', callback: v => '$' + v }, grid: { color: 'rgba(255,255,255,0.04)' } }
            }
        }
    });
}

function buildPriceStatsHtml(history, days) {
    if (!history.length) {
        return `<div class="list-container glass" style="padding:24px;text-align:center;color:var(--text-muted);">No price data in the selected range.</div>`;
    }
    const prices  = history.map(p => Number(p.price)).filter(Number.isFinite);
    const volumes = history.map(p => Number(p.volume24h)).filter(Number.isFinite);
    if (!prices.length) return '';
    const high = Math.max(...prices);
    const low  = Math.min(...prices);
    const first = prices[0];
    const last  = prices[prices.length - 1];
    const periodChange = first > 0 ? ((last - first) / first) * 100 : null;
    const totalVol = volumes.reduce((a, b) => a + b, 0);
    const periodLabel = (PRICE_PERIODS.find(p => p.days === days) || { label: days + 'D' }).label;
    const fmt = v => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 4 });
    const fmtBig = v => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const pctHtml = periodChange != null
        ? `<span class="price-change ${periodChange >= 0 ? 'positive' : 'negative'}">${periodChange >= 0 ? '+' : ''}${periodChange.toFixed(2)}%</span>`
        : '—';
    return `
        <div class="price-stats-grid">
            <div class="staking-summary-card"><div class="label">${periodLabel} change</div><div class="value">${pctHtml}</div></div>
            <div class="staking-summary-card"><div class="label">${periodLabel} high</div><div class="value">${fmt(high)}</div></div>
            <div class="staking-summary-card"><div class="label">${periodLabel} low</div><div class="value">${fmt(low)}</div></div>
            <div class="staking-summary-card"><div class="label">${periodLabel} volume</div><div class="value">${totalVol > 0 ? fmtBig(totalVol) : '—'}</div></div>
        </div>
    `;
}

// Escape a value for safe interpolation into an innerHTML template.
// The chain-state inspector renders arbitrary runtime data (storage keys,
// type names, node error strings) into HTML, and any of it can contain
// angle brackets — SCALE type names like `Vec<AccountId32>` would otherwise be
// parsed as tags and silently mangle the output, quite apart from the
// injection risk. Defined here because the codebase had no such helper.
// Audit F-133: the codebase had grown three HTML-escape helpers that could
// drift apart — and an escape helper that drifts is an XSS waiting for the
// divergence. This name survives because ~19 call sites use it, but it is now
// an alias of the canonical stakingEscapeHtml (261 call sites), not a second
// implementation.
function escapeHtml(value) {
    return stakingEscapeHtml(value);
}

// ─── /chain-state ────────────────────────────────────────────────────────────
// Generic runtime storage inspector — the explorer's replacement for
// polkadot.js Apps → Developer → Chain state.
//
// Design notes that matter for forensic use:
//   * Keys are kept as STRINGS the whole way. A u64 key like 2^63
//     (9223372036854775808) is past Number.MAX_SAFE_INTEGER, so touching it
//     with Number() silently queries a different key. The input value is sent
//     verbatim and the response echoes `args` back so it can be confirmed.
//   * Results show Human / JSON / Hex. toHuman() prettifies big integers and
//     truncates hashes, which is precisely how an anomalous value (an all-zero
//     state_hash, a 2^63 id) escapes a reviewer's notice.
//   * Every query is deep-linkable, so a finding can be pasted into a report
//     and re-run by anyone.
let chainStateMeta = null;      // cached /api/rpc/metadata payload
let chainStateBusy = false;

async function renderChainStatePage() {
    const root = document.getElementById('chain-state-page-content');
    if (!root) return;

    root.innerHTML = `
        <div class="cs-hero">
            <h1>Chain state</h1>
            <p class="cs-tagline">Read any runtime storage item, at the current head or at any historical block. Read-only.</p>
        </div>
        <div class="cs-panel glass">
            <div class="cs-controls">
                <label class="cs-field">
                    <span>Pallet</span>
                    <select id="cs-pallet"><option>Loading…</option></select>
                </label>
                <label class="cs-field">
                    <span>Storage item</span>
                    <select id="cs-item"><option>—</option></select>
                </label>
                <label class="cs-field cs-field-at">
                    <span>At block <em>(optional — blank = latest)</em></span>
                    <input id="cs-at" type="text" inputmode="numeric" placeholder="e.g. 12250870 or 0x…" autocomplete="off">
                </label>
            </div>
            <div id="cs-keys" class="cs-keys"></div>
            <div class="cs-actions">
                <button id="cs-run" class="wallet-action-btn primary" type="button">Query</button>
                <button id="cs-entries" class="wallet-action-btn" type="button" title="List the first entries of a map">List entries</button>
                <button id="cs-copy" class="wallet-action-btn" type="button">Copy link</button>
                <span class="cs-export" id="cs-export" hidden>
                    <span class="cs-export-label">Export</span>
                    <button id="cs-dl-json" class="staking-download-btn" type="button" title="Full result with provenance">JSON</button>
                    <button id="cs-dl-csv"  class="staking-download-btn" type="button" title="Flattened rows">CSV</button>
                    <button id="cs-copy-val" class="staking-download-btn" type="button" title="Copy the decoded value to the clipboard">Copy value</button>
                </span>
                <span id="cs-status" class="cs-status"></span>
            </div>
            <div id="cs-docs" class="cs-docs"></div>
        </div>
        <div id="cs-result" class="cs-result"></div>
    `;

    const $ = id => document.getElementById(id);
    const palletSel = $('cs-pallet'), itemSel = $('cs-item');

    // ---- load metadata (cached across visits) ----
    try {
        if (!chainStateMeta) {
            $('cs-status').textContent = 'Loading runtime metadata…';
            const r = await fetch('/api/rpc/metadata');
            if (!r.ok) throw new Error(`metadata ${r.status}`);
            chainStateMeta = await r.json();
        }
        $('cs-status').textContent = '';
    } catch (e) {
        $('cs-status').innerHTML = `<span class="cs-err">Could not load metadata: ${escapeHtml(e.message)}</span>`;
        return;
    }

    const pallets = (chainStateMeta.pallets || []).filter(p => p.storage && p.storage.length);
    palletSel.innerHTML = pallets.map(p => `<option value="${p.queryKey}">${escapeHtml(p.name)}</option>`).join('');

    function currentPallet() { return pallets.find(p => p.queryKey === palletSel.value); }
    function currentItem() {
        const p = currentPallet();
        return p && p.storage.find(s => s.item === itemSel.value);
    }

    function fillItems(preselect) {
        const p = currentPallet();
        if (!p) return;
        itemSel.innerHTML = p.storage.map(s => `<option value="${s.item}">${escapeHtml(s.item)}</option>`).join('');
        if (preselect && p.storage.some(s => s.item === preselect)) itemSel.value = preselect;
        fillKeys();
    }

    // Render one input per storage key, labelled with its SCALE type so the
    // user knows whether an AccountId, an EraIndex or a u64 is expected.
    function fillKeys(values) {
        const s = currentItem();
        const box = $('cs-keys');
        const docs = $('cs-docs');
        if (!s) { box.innerHTML = ''; docs.textContent = ''; return; }
        docs.innerHTML = s.docs && s.docs.length
            ? `<i class='bx bx-info-circle'></i> ${escapeHtml(s.docs.join(' '))}`
            : '';
        if (!s.keyCount) {
            box.innerHTML = `<div class="cs-nokeys">No keys — this is a plain storage value. Returns <code>${escapeHtml(s.valueType || '')}</code>.</div>`;
            return;
        }
        box.innerHTML = s.keyTypes.map((t, i) => `
            <label class="cs-field">
                <span>Key ${s.keyCount > 1 ? i + 1 : ''} <em>${escapeHtml(t)}</em></span>
                <input class="cs-key" data-i="${i}" type="text" autocomplete="off"
                       value="${values && values[i] ? escapeHtml(values[i]) : ''}"
                       placeholder="${escapeHtml(t)}">
            </label>`).join('')
            + `<div class="cs-nokeys">Returns <code>${escapeHtml(s.valueType || '')}</code></div>`;
    }

    function readKeys() {
        // Values are taken as typed. No parsing, no Number() — see the note at
        // the top of this section.
        return Array.from(document.querySelectorAll('.cs-key'))
            .map(i => i.value.trim()).filter(v => v !== '');
    }

    async function runQuery(entries) {
        if (chainStateBusy) return;
        const s = currentItem();
        if (!s) return;
        const args = readKeys();
        const at = $('cs-at').value.trim();

        if (!entries && s.keyCount && args.length !== s.keyCount) {
            $('cs-status').innerHTML = `<span class="cs-err">This item needs ${s.keyCount} key(s); ${args.length} supplied.</span>`;
            return;
        }

        const qs = new URLSearchParams();
        if (args.length) qs.set('args', args.join(','));
        if (at) qs.set('at', at);
        if (entries) qs.set('entries', '1');
        const url = `/api/state/${palletSel.value}/${itemSel.value}?${qs}`;

        chainStateBusy = true;
        $('cs-status').textContent = 'Querying…';
        $('cs-result').innerHTML = '';
        try {
            const r = await fetch(url);
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
            $('cs-status').textContent = '';
            renderChainStateResult(data);
            // Reflect the query in the URL so it can be shared/bookmarked.
            const share = new URLSearchParams({ pallet: palletSel.value, item: itemSel.value });
            if (args.length) share.set('args', args.join(','));
            if (at) share.set('at', at);
            history.replaceState({}, '', `/chain-state?${share}`);
        } catch (e) {
            $('cs-status').innerHTML = `<span class="cs-err">${escapeHtml(e.message)}</span>`;
        } finally {
            chainStateBusy = false;
        }
    }

    palletSel.addEventListener('change', () => fillItems());
    itemSel.addEventListener('change', () => fillKeys());
    $('cs-run').addEventListener('click', () => runQuery(false));
    $('cs-entries').addEventListener('click', () => runQuery(true));
    $('cs-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(window.location.href);
        $('cs-status').textContent = 'Link copied.';
        setTimeout(() => { $('cs-status').textContent = ''; }, 1500);
    });

    const flash = msg => {
        $('cs-status').textContent = msg;
        setTimeout(() => { $('cs-status').textContent = ''; }, 1800);
    };
    $('cs-dl-json').addEventListener('click', () => {
        if (!chainStateLastResult) return;
        downloadStakingBlob(
            chainStateFilename(chainStateLastResult, 'json'),
            JSON.stringify(chainStateExportPayload(chainStateLastResult), null, 2),
            'application/json');
        flash('JSON exported.');
    });
    $('cs-dl-csv').addEventListener('click', () => {
        if (!chainStateLastResult) return;
        downloadStakingBlob(
            chainStateFilename(chainStateLastResult, 'csv'),
            chainStateCsv(chainStateLastResult),
            'text/csv;charset=utf-8');
        flash('CSV exported.');
    });
    $('cs-copy-val').addEventListener('click', () => {
        if (!chainStateLastResult) return;
        const d = chainStateLastResult;
        const value = d.entries ? d.entries : (d.json !== undefined ? d.json : d.human);
        navigator.clipboard.writeText(JSON.stringify(value, null, 2));
        flash('Value copied.');
    });

    // ---- restore from query string (deep link) ----
    const params = new URLSearchParams(window.location.search || '');
    const qp = params.get('pallet'), qi = params.get('item');
    if (qp && pallets.some(p => p.queryKey === qp)) {
        palletSel.value = qp;
        fillItems(qi);
        const qargs = params.get('args');
        if (qargs) fillKeys(qargs.split(','));
        if (params.get('at')) $('cs-at').value = params.get('at');
        if (qi) runQuery(false);
    } else {
        fillItems();
    }
}

// Last result, retained so the export buttons can act on it.
let chainStateLastResult = null;

// Wrap a result with everything needed to re-run and cite it.
//
// An exported file usually ends up pasted into a report, an issue, or an email,
// separated from the UI that produced it. Without provenance the reader cannot
// tell WHICH block it was read at, which runtime decoded it, or whether the key
// was mangled on the way in — so the export records the query, the resolved
// block number AND hash, the source URL, and the retrieval time. Anyone can
// then re-run it and get the same bytes.
function chainStateExportPayload(d) {
    return {
        _provenance: {
            source: 'Polkadex Mainnet Explorer — chain state',
            site: window.location.origin,
            // Re-runnable: same pallet, item, keys and block.
            query: `${d.pallet}.${d.item}${d.args && d.args.length ? '(' + d.args.join(', ') + ')' : ''}`,
            apiUrl: `${window.location.origin}/api/state/${d.pallet}/${d.item}` +
                    `?${new URLSearchParams({
                        ...(d.args && d.args.length ? { args: d.args.join(',') } : {}),
                        ...(d.at ? { at: String(d.at.block) } : {})
                    })}`,
            pageUrl: window.location.href,
            // Keys exactly as submitted — the record that no numeric coercion
            // happened to a large u64 key.
            keysAsSubmitted: d.args || [],
            atBlock: d.at ? d.at.block : null,
            atBlockHash: d.at ? d.at.hash : null,
            atChainHead: !d.at,
            retrievedAt: new Date().toISOString()
        },
        storage: d.storage || null,
        result: d.entries
            ? { entriesReturned: d.entriesReturned, entriesTotal: d.entriesTotal, totalUnknownReason: d.totalUnknownReason, truncated: d.truncated, limit: d.limit, entries: d.entries }
            : { isEmpty: d.isEmpty, count: d.count, human: d.human, json: d.json, hex: d.hex }
    };
}

// How many entries to claim in the /chain-state result header.
//
// Audit F-018: the backend no longer walks the whole storage map, so it cannot
// report a true total — `entriesTotal` is null by design. This used to
// interpolate that field directly, which would now render "null entries".
// Say what we actually know: the number returned, and whether more exist.
function chainStateEntryCount(d) {
    const shown = Array.isArray(d.entries) ? d.entries.length : 0;
    const noun = `entr${shown === 1 ? 'y' : 'ies'}`;
    if (d.entriesTotal != null) return `${d.entriesTotal} ${noun}`;
    return d.truncated ? `${shown}+ ${noun}` : `${shown} ${noun}`;
}

function chainStateFilename(d, ext) {
    const keys = (d.args || []).join('-').replace(/[^\w.-]/g, '').slice(0, 40);
    const at = d.at ? `at${d.at.block}` : 'latest';
    return `chainstate-${d.pallet}.${d.item}${keys ? '-' + keys : ''}-${at}.${ext}`;
}

// CSV escaping: quote always, double embedded quotes. Values here include
// addresses and hex blobs, and a stray comma silently shifting columns in a
// spreadsheet is exactly the kind of quiet corruption this page exists to avoid.
function csvCell(v) {
    if (v === null || v === undefined) return '""';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
}

function chainStateCsv(d) {
    const head = ['pallet', 'item', 'keys', 'at_block', 'at_block_hash', 'retrieved_at'];
    const base = [d.pallet, d.item, (d.args || []).join(' | '),
                  d.at ? d.at.block : 'latest', d.at ? d.at.hash : '',
                  new Date().toISOString()];
    const lines = [];

    if (d.entries) {
        // Map listing: one row per entry.
        lines.push([...head, 'entry_key', 'entry_key_hex', 'value_json'].map(csvCell).join(','));
        for (const e of d.entries) {
            lines.push([...base, e.key, e.keyHex, e.value ? e.value.json : null].map(csvCell).join(','));
        }
    } else if (Array.isArray(d.json)) {
        // Vec value (e.g. a validator set): one row per element, indexed.
        lines.push([...head, 'index', 'value'].map(csvCell).join(','));
        d.json.forEach((v, i) => lines.push([...base, i, v].map(csvCell).join(',')));
    } else if (d.json && typeof d.json === 'object') {
        // Struct: one row per field, so it opens usefully in a spreadsheet.
        lines.push([...head, 'field', 'value'].map(csvCell).join(','));
        for (const [k, v] of Object.entries(d.json)) {
            lines.push([...base, k, v].map(csvCell).join(','));
        }
    } else {
        lines.push([...head, 'value', 'hex'].map(csvCell).join(','));
        lines.push([...base, d.json, d.hex].map(csvCell).join(','));
    }
    // CRLF matches the staking-rewards exports and keeps Excel happy.
    return lines.join('\r\n');
}

// Render a /api/state result. Always shows Human, JSON and Hex — never just
// the friendly rendering.
function renderChainStateResult(d) {
    const box = document.getElementById('cs-result');
    if (!box) return;

    // Retain for the export buttons, and reveal them now there's something
    // to export.
    chainStateLastResult = d;
    const exportBar = document.getElementById('cs-export');
    if (exportBar) exportBar.hidden = false;

    const atLabel = d.at
        ? `block <a href="/block/${d.at.block}" class="item-link">${d.at.block}</a> <code>${escapeHtml(String(d.at.hash).slice(0, 18))}…</code>`
        : 'latest (chain head)';

    if (d.entries) {
        box.innerHTML = `
            <div class="cs-result-head">
                <strong>${escapeHtml(d.pallet)}.${escapeHtml(d.item)}</strong> — ${chainStateEntryCount(d)} at ${atLabel}
                ${d.truncated ? `<span class="cs-warn">showing the first ${d.limit}; more exist</span>` : ''}
            </div>
            <div class="cs-entries">${d.entries.map(e => `
                <div class="cs-entry">
                    <div class="cs-entry-key"><code>${escapeHtml(JSON.stringify(e.key))}</code></div>
                    <pre>${escapeHtml(JSON.stringify(e.value.json, null, 2))}</pre>
                </div>`).join('')}</div>`;
        return;
    }

    // A Vec result's length is the headline fact ("empty" vs "200 validators"),
    // so state it plainly instead of making the user count a JSON array.
    const countLine = (d.count !== undefined && d.count !== null)
        ? `<span class="cs-count">${d.count} item${d.count === 1 ? '' : 's'}</span>` : '';
    const emptyLine = d.isEmpty
        ? `<span class="cs-warn">empty / default value</span>` : '';

    box.innerHTML = `
        <div class="cs-result-head">
            <strong>${escapeHtml(d.pallet)}.${escapeHtml(d.item)}${d.args && d.args.length ? '(' + d.args.map(escapeHtml).join(', ') + ')' : ''}</strong>
            — at ${atLabel} ${countLine} ${emptyLine}
        </div>
        ${d.args && d.args.length ? `<div class="cs-echo">Key sent verbatim: ${d.args.map(a => `<code>${escapeHtml(a)}</code>`).join(', ')}</div>` : ''}
        <div class="cs-tabs">
            <button class="cs-tab active" data-t="human">Human</button>
            <button class="cs-tab" data-t="json">JSON</button>
            <button class="cs-tab" data-t="hex">Hex</button>
        </div>
        <pre id="cs-out">${escapeHtml(JSON.stringify(d.human, null, 2))}</pre>`;

    const views = {
        human: JSON.stringify(d.human, null, 2),
        json:  JSON.stringify(d.json, null, 2),
        hex:   d.hex || '(not representable as hex)'
    };
    box.querySelectorAll('.cs-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            box.querySelectorAll('.cs-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('cs-out').textContent = views[btn.dataset.t];
        });
    });
}

// ─── /decode ─────────────────────────────────────────────────────────────────
// Per-argument extrinsic decoder for any block. The UI half of
// /api/decode/:block, and the second half of a chain-forensics workflow: read
// what a call CLAIMED (here) and what the chain STORED (/chain-state).
//
// Every argument shows name, declared type, decoded value and RAW HEX side by
// side. The hex is not decoration — toHuman() abbreviates an H256 to
// "0x0000…0000", so an all-zero hash and a mostly-zero one look identical, and
// renders 2^63 as a comfortable-looking "9,223,372,036,854,775,808".
let decodeLastResult = null;

async function renderDecodePage() {
    const root = document.getElementById('decode-page-content');
    if (!root) return;

    const params = new URLSearchParams(window.location.search || '');
    const qBlock = params.get('block') || '';
    const qMethod = params.get('method') || '';

    root.innerHTML = `
        <div class="cs-hero">
            <h1>Extrinsic decoder</h1>
            <p class="cs-tagline">Decode every extrinsic in a block, argument by argument, with raw hex alongside the decoded value. Read-only.</p>
        </div>
        <div class="cs-panel glass">
            <div class="cs-controls">
                <label class="cs-field">
                    <span>Block <em>number or hash</em></span>
                    <input id="dec-block" type="text" placeholder="e.g. 12250870 or 0x…" value="${stakingEscapeHtml(qBlock)}" autocomplete="off">
                </label>
                <label class="cs-field">
                    <span>Filter by method <em>optional</em></span>
                    <input id="dec-method" type="text" placeholder="e.g. submit_snapshot" value="${stakingEscapeHtml(qMethod)}" autocomplete="off">
                </label>
            </div>
            <div class="cs-actions">
                <button id="dec-run" class="wallet-action-btn primary" type="button">Decode</button>
                <button id="dec-copy" class="wallet-action-btn" type="button">Copy link</button>
                <span class="cs-export" id="dec-export" hidden>
                    <span class="cs-export-label">Export</span>
                    <button id="dec-dl-json" class="staking-download-btn" type="button">JSON</button>
                </span>
                <span id="dec-status" class="cs-status"></span>
            </div>
            <div class="cs-docs"><i class='bx bx-info-circle'></i> Method matching ignores case and underscores — <code>submit_snapshot</code> and <code>submitSnapshot</code> both work.</div>
        </div>
        <div id="dec-result" class="cs-result"></div>
    `;

    const $ = id => document.getElementById(id);

    async function run() {
        const block = $('dec-block').value.trim();
        if (!block) { $('dec-status').innerHTML = '<span class="cs-err">Enter a block number or hash.</span>'; return; }
        const method = $('dec-method').value.trim();
        const qs = new URLSearchParams();
        if (method) qs.set('method', method);

        $('dec-status').textContent = 'Decoding…';
        $('dec-result').innerHTML = '';
        try {
            const r = await fetch(`/api/decode/${encodeURIComponent(block)}?${qs}`);
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
            $('dec-status').textContent = '';
            decodeLastResult = data;
            $('dec-export').hidden = false;
            renderDecodeResult(data);
            const share = new URLSearchParams({ block });
            if (method) share.set('method', method);
            history.replaceState({}, '', `/decode?${share}`);
        } catch (e) {
            $('dec-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`;
        }
    }

    $('dec-run').addEventListener('click', run);
    $('dec-block').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    $('dec-method').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    $('dec-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(window.location.href);
        $('dec-status').textContent = 'Link copied.';
        setTimeout(() => { $('dec-status').textContent = ''; }, 1500);
    });
    $('dec-dl-json').addEventListener('click', () => {
        if (!decodeLastResult) return;
        const d = decodeLastResult;
        downloadStakingBlob(`extrinsics-block${d.block}.json`, JSON.stringify({
            _provenance: {
                source: 'Polkadex Mainnet Explorer — extrinsic decoder',
                site: window.location.origin,
                apiUrl: `${window.location.origin}/api/decode/${d.block}`,
                pageUrl: window.location.href,
                block: d.block, blockHash: d.blockHash,
                retrievedAt: new Date().toISOString()
            },
            extrinsics: d.extrinsics
        }, null, 2), 'application/json');
        $('dec-status').textContent = 'JSON exported.';
        setTimeout(() => { $('dec-status').textContent = ''; }, 1500);
    });

    if (qBlock) run();
}

function renderDecodeResult(d) {
    const box = document.getElementById('dec-result');
    if (!box) return;

    if (!d.extrinsics || !d.extrinsics.length) {
        // An empty filter result reads as "that call isn't here" — say which it
        // is, and list what the block does contain.
        box.innerHTML = `<div class="cs-result-head">
                <strong>Block ${d.block}</strong> — ${d.extrinsicCount} extrinsic(s), none matched the filter
            </div>
            ${d.present ? `<div class="cs-echo">Present in this block: ${d.present.map(p => `<code>${stakingEscapeHtml(p)}</code>`).join(' ')}</div>` : ''}`;
        return;
    }

    box.innerHTML = `
        <div class="cs-result-head">
            <strong>Block <a href="/block/${d.block}" class="item-link">${d.block}</a></strong>
            <code class="mono">${stakingEscapeHtml(String(d.blockHash).slice(0, 18))}…</code>
            <span class="cs-count">${d.returned} of ${d.extrinsicCount} extrinsic(s)</span>
        </div>
        ${d.extrinsics.map(x => `
            <div class="dec-ext">
                <div class="dec-ext-head">
                    <span class="dec-ext-idx">#${x.index}</span>
                    <strong>${stakingEscapeHtml(x.section)}.${stakingEscapeHtml(x.method)}</strong>
                    <span class="${x.isSigned ? 'cs-count' : 'cs-warn'}">${x.isSigned ? 'signed' : 'UNSIGNED'}</span>
                    ${x.signer ? `<span class="cs-echo">by ${shortAddressLink(x.signer)}</span>` : ''}
                </div>
                <table class="dec-args">
                    <thead><tr><th>Argument</th><th>Type</th><th>Value</th><th>Raw hex</th></tr></thead>
                    <tbody>
                    ${x.args.map(a => `
                        <tr>
                            <td><strong>${stakingEscapeHtml(a.name)}</strong></td>
                            <td class="mono">${stakingEscapeHtml(a.type || '')}</td>
                            <td>
                                ${a.count !== undefined && a.count !== null ? `<span class="cs-count">${a.count} item(s)</span><br>` : ''}
                                <pre>${stakingEscapeHtml(JSON.stringify(a.json, null, 2))}</pre>
                            </td>
                            <td><pre class="mono dec-hex">${stakingEscapeHtml(a.hex || '—')}</pre></td>
                        </tr>`).join('')}
                    </tbody>
                </table>
                <details class="dec-callhex">
                    <summary>Full SCALE-encoded call (${x.callLength} bytes)</summary>
                    <pre class="mono">${stakingEscapeHtml(x.callHex)}</pre>
                </details>
            </div>`).join('')}
    `;
}

// ─── /runtime ────────────────────────────────────────────────────────────────
// Runtime version, constants browser, and the read-only RPC console.
// Constants and runtime version accept ?at= because a historical decode is only
// meaningful against the runtime that was live at that block.
async function renderRuntimePage() {
    const root = document.getElementById('runtime-page-content');
    if (!root) return;

    root.innerHTML = `
        <div class="cs-hero">
            <h1>Runtime &amp; RPC</h1>
            <p class="cs-tagline">Runtime version, on-chain constants, and an allowlisted read-only RPC console.</p>
        </div>

        <div class="cs-panel glass">
            <h2 class="rt-h2">Runtime version</h2>
            <div class="cs-controls">
                <label class="cs-field">
                    <span>At block <em>optional — blank = latest</em></span>
                    <input id="rt-at" type="text" placeholder="e.g. 12250870" autocomplete="off">
                </label>
            </div>
            <div class="cs-actions">
                <button id="rt-run" class="wallet-action-btn primary" type="button">Fetch</button>
                <span id="rt-status" class="cs-status"></span>
            </div>
            <div id="rt-result" class="cs-result"></div>
        </div>

        <div class="cs-panel glass" style="margin-top:18px;">
            <h2 class="rt-h2">Constants</h2>
            <div class="cs-controls">
                <label class="cs-field"><span>Pallet</span><select id="rt-pallet"><option>Loading…</option></select></label>
                <label class="cs-field"><span>Constant</span><select id="rt-const"><option>—</option></select></label>
            </div>
            <div class="cs-actions">
                <button id="rt-const-run" class="wallet-action-btn primary" type="button">Read</button>
                <span id="rt-const-status" class="cs-status"></span>
            </div>
            <div id="rt-const-result" class="cs-result"></div>
        </div>

        <div class="cs-panel glass" style="margin-top:18px;">
            <h2 class="rt-h2">RPC console <span class="cs-echo">read-only</span></h2>
            <div class="cs-controls">
                <label class="cs-field"><span>Method</span><select id="rpc-method"><option>Loading…</option></select></label>
                <label class="cs-field cs-field-at">
                    <span>Params <em>JSON array</em></span>
                    <input id="rpc-params" type="text" placeholder='e.g. [12250870]' value="[]" autocomplete="off">
                </label>
            </div>
            <div class="cs-actions">
                <button id="rpc-run" class="wallet-action-btn primary" type="button">Call</button>
                <span id="rpc-status" class="cs-status"></span>
            </div>
            <div id="rpc-result" class="cs-result"></div>
        </div>
    `;

    const $ = id => document.getElementById(id);
    const show = (el, obj) => { el.innerHTML = `<pre>${stakingEscapeHtml(JSON.stringify(obj, null, 2))}</pre>`; };

    // ---- runtime version ----
    async function runRuntime() {
        const at = $('rt-at').value.trim();
        $('rt-status').textContent = 'Loading…';
        try {
            const r = await fetch(`/api/runtime${at ? `?at=${encodeURIComponent(at)}` : ''}`);
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            $('rt-status').textContent = '';
            show($('rt-result'), d);
        } catch (e) { $('rt-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`; }
    }
    $('rt-run').addEventListener('click', runRuntime);
    runRuntime();

    // ---- constants (reuses the cached metadata) ----
    try {
        if (!chainStateMeta) {
            const r = await fetch('/api/rpc/metadata');
            if (r.ok) chainStateMeta = await r.json();
        }
    } catch (e) { /* handled below */ }

    const constPallets = (chainStateMeta && chainStateMeta.pallets || []).filter(p => p.constants && p.constants.length);
    $('rt-pallet').innerHTML = constPallets.length
        ? constPallets.map(p => `<option value="${p.queryKey}">${stakingEscapeHtml(p.name)}</option>`).join('')
        : '<option value="">(metadata unavailable)</option>';

    function fillConsts() {
        const p = constPallets.find(x => x.queryKey === $('rt-pallet').value);
        $('rt-const').innerHTML = p ? p.constants.map(c => `<option value="${c}">${stakingEscapeHtml(c)}</option>`).join('') : '<option>—</option>';
    }
    fillConsts();
    $('rt-pallet').addEventListener('change', fillConsts);
    $('rt-const-run').addEventListener('click', async () => {
        const pallet = $('rt-pallet').value, item = $('rt-const').value;
        if (!pallet || !item) return;
        $('rt-const-status').textContent = 'Reading…';
        try {
            const r = await fetch(`/api/consts/${pallet}/${item}`);
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            $('rt-const-status').textContent = '';
            show($('rt-const-result'), d);
        } catch (e) { $('rt-const-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`; }
    });

    // ---- RPC console ----
    // The method list comes straight from the server's allowlist, so the UI can
    // never offer a method the backend would refuse.
    let allowed = [];
    try {
        const r = await fetch('/api/rpc/call');
        if (r.ok) {
            const body = await r.json();
            allowed = Array.isArray(body.allowed) ? body.allowed : [];
        }
    } catch (e) { /* leave empty; the picker shows "(unavailable)" */ }
    $('rpc-method').innerHTML = allowed.length
        ? allowed.map(m => `<option value="${m}">${stakingEscapeHtml(m)}</option>`).join('')
        : '<option value="">(unavailable)</option>';

    $('rpc-run').addEventListener('click', async () => {
        const method = $('rpc-method').value;
        if (!method) return;
        let params;
        try {
            params = JSON.parse($('rpc-params').value || '[]');
            if (!Array.isArray(params)) throw new Error('Params must be a JSON array, e.g. [12250870]');
        } catch (e) {
            $('rpc-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`;
            return;
        }
        $('rpc-status').textContent = 'Calling…';
        try {
            const r = await fetch('/api/rpc/call', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method, params })
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            $('rpc-status').textContent = '';
            show($('rpc-result'), d);
        } catch (e) { $('rpc-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`; }
    });
}

// ─── /utilities ──────────────────────────────────────────────────────────────
// Offline developer helpers — SS58 conversion, hashing, signature
// verification. Everything here runs in the browser; no chain calls, so these
// keep working when the RPC is down.
function renderUtilitiesPage() {
    const root = document.getElementById('utilities-page-content');
    if (!root) return;

    root.innerHTML = `
        <div class="cs-hero">
            <h1>Utilities</h1>
            <p class="cs-tagline">Address conversion, hashing and signature verification. Runs entirely in your browser — nothing is sent to the server.</p>
        </div>

        <div class="cs-panel glass">
            <h2 class="rt-h2">SS58 address converter</h2>
            <div class="cs-controls">
                <label class="cs-field"><span>Address or 0x public key</span>
                    <input id="ut-addr" type="text" placeholder="esoEt6… or 5Grwva… or 0x…" autocomplete="off"></label>
                <label class="cs-field"><span>Target prefix</span>
                    <select id="ut-prefix">
                        <option value="88">88 — Polkadex</option>
                        <option value="0">0 — Polkadot</option>
                        <option value="2">2 — Kusama</option>
                        <option value="42">42 — generic Substrate</option>
                    </select></label>
            </div>
            <div class="cs-actions"><button id="ut-addr-run" class="wallet-action-btn primary" type="button">Convert</button>
                <span id="ut-addr-status" class="cs-status"></span></div>
            <div id="ut-addr-result" class="cs-result"></div>
        </div>

        <div class="cs-panel glass" style="margin-top:18px;">
            <h2 class="rt-h2">Hashing</h2>
            <div class="cs-controls">
                <label class="cs-field cs-field-at"><span>Input <em>text, or 0x… for raw bytes</em></span>
                    <input id="ut-hash-in" type="text" placeholder="hello  or  0xdeadbeef" autocomplete="off"></label>
            </div>
            <div class="cs-actions"><button id="ut-hash-run" class="wallet-action-btn primary" type="button">Hash</button>
                <span id="ut-hash-status" class="cs-status"></span></div>
            <div id="ut-hash-result" class="cs-result"></div>
        </div>

        <div class="cs-panel glass" style="margin-top:18px;">
            <h2 class="rt-h2">Verify signature</h2>
            <div class="cs-controls">
                <label class="cs-field"><span>Signer address</span><input id="ut-vf-addr" type="text" autocomplete="off"></label>
                <label class="cs-field"><span>Message <em>text or 0x…</em></span><input id="ut-vf-msg" type="text" autocomplete="off"></label>
                <label class="cs-field"><span>Signature <em>0x…</em></span><input id="ut-vf-sig" type="text" autocomplete="off"></label>
            </div>
            <div class="cs-actions"><button id="ut-vf-run" class="wallet-action-btn primary" type="button">Verify</button>
                <span id="ut-vf-status" class="cs-status"></span></div>
            <div id="ut-vf-result" class="cs-result"></div>
        </div>
    `;

    const $ = id => document.getElementById(id);
    // Accept either a text string or 0x-prefixed raw bytes, matching what
    // wallets and runtime code actually hand you.
    const toBytes = v => (isHex(v) ? hexToU8a(v) : stringToU8a(v));

    $('ut-addr-run').addEventListener('click', () => {
        const v = $('ut-addr').value.trim();
        const prefix = parseInt($('ut-prefix').value, 10);
        try {
            const pub = decodeAddress(v);
            const out = {
                input: v,
                publicKey: u8aToHex(pub),
                converted: encodeAddress(pub, prefix),
                prefix,
                // Show the common formats at once — the same account in two
                // prefixes looks like two different accounts otherwise.
                polkadex_88: encodeAddress(pub, 88),
                substrate_42: encodeAddress(pub, 42),
                polkadot_0: encodeAddress(pub, 0)
            };
            $('ut-addr-status').textContent = '';
            $('ut-addr-result').innerHTML = `<pre>${stakingEscapeHtml(JSON.stringify(out, null, 2))}</pre>`;
        } catch (e) {
            $('ut-addr-status').innerHTML = `<span class="cs-err">Not a valid address or public key.</span>`;
            $('ut-addr-result').innerHTML = '';
        }
    });

    $('ut-hash-run').addEventListener('click', () => {
        const v = $('ut-hash-in').value;
        try {
            const bytes = toBytes(v);
            const out = {
                input: v,
                interpretedAs: isHex(v) ? 'raw bytes (hex)' : 'utf-8 text',
                blake2_256: blake2AsHex(bytes, 256),
                blake2_128: blake2AsHex(bytes, 128),
                keccak_256: keccakAsHex(bytes),
                xxhash_128: xxhashAsHex(bytes, 128),
                xxhash_64: xxhashAsHex(bytes, 64)
            };
            $('ut-hash-status').textContent = '';
            $('ut-hash-result').innerHTML = `<pre>${stakingEscapeHtml(JSON.stringify(out, null, 2))}</pre>`;
        } catch (e) {
            $('ut-hash-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`;
        }
    });

    $('ut-vf-run').addEventListener('click', () => {
        const addr = $('ut-vf-addr').value.trim();
        const msg = $('ut-vf-msg').value;
        const sig = $('ut-vf-sig').value.trim();
        try {
            const res = signatureVerify(toBytes(msg), sig, addr);
            $('ut-vf-status').textContent = '';
            $('ut-vf-result').innerHTML =
                `<div class="cs-result-head">${res.isValid
                    ? '<span class="cs-count">Signature is VALID</span>'
                    : '<span class="cs-err">Signature is NOT valid</span>'}</div>
                 <pre>${stakingEscapeHtml(JSON.stringify({ isValid: res.isValid, crypto: res.crypto }, null, 2))}</pre>`;
        } catch (e) {
            $('ut-vf-status').innerHTML = `<span class="cs-err">${stakingEscapeHtml(e.message)}</span>`;
            $('ut-vf-result').innerHTML = '';
        }
    });
}

// ─── /developers ─────────────────────────────────────────────────────────────
// Developer-facing API reference. Designed to mirror the README's "API
// reference" section so we have a single source of truth in the codebase
// for what the API exposes. SEO-indexable for "Polkadex API" / "Polkadex
// mobile app" searches.
//
// Kept as static markup in this function (rather than fetched at runtime
// from a docs API) so the content streams immediately, ships in the bundle,
// and stays diffable in code review.
function renderDevelopersPage() {
    const root = document.getElementById('developers-page-content');
    if (!root) return;
    root.innerHTML = `
        <div class="developers-hero">
            <h1>Developers</h1>
            <p class="developers-tagline">JSON API for the Polkadex Mainnet — used by this explorer and freely consumable by external apps, especially native mobile clients.</p>
        </div>

        <nav class="developers-toc" aria-label="API sections">
            <a href="#overview">Start here</a>
            <a href="#cors">CORS</a>
            <a href="#caching">Caching</a>
            <a href="#chain">Chain data</a>
            <a href="#inspect">Chain inspection</a>
            <a href="#schema">network-info schema</a>
            <a href="#price">Price feed</a>
            <a href="#governance">Governance</a>
            <a href="#email">Email alerts</a>
            <a href="#discussions">Discussions</a>
            <a href="#auth">Authenticated</a>
            <a href="#errors">Errors</a>
            <a href="#addresses">Addresses</a>
            <a href="#examples">Examples</a>
        </nav>

        <section class="developers-section" id="overview">
            <h2>Start here — use the JSON API, not the HTML</h2>
            <p>This explorer is a client-rendered single-page app: HTML pages are a shell that JavaScript fills in inside the browser. A non-browser client that fetches an HTML page will <strong>not</strong> see the data. Don't scrape the HTML — call the JSON API below, which returns plain JSON. Every figure on the site comes from an <code>/api/*</code> endpoint.</p>
            <p>Two things trip up automated clients, and how to handle them:</p>
            <div class="developers-table-wrap">
                <table class="developers-table">
                    <thead><tr><th>Behavior</th><th>What to do</th></tr></thead>
                    <tbody>
                        <tr><td><strong>The site sits behind Cloudflare.</strong> Requests from cloud/datacenter IP ranges are sometimes challenged, so a call from a CI runner or hosted backend can come back empty where the same call from a laptop succeeds.</td><td>It's an edge policy, not an API restriction — a plain <code>curl</code> gets HTTP 200. Send a descriptive <code>User-Agent</code>, respect the <code>Cache-Control</code> headers, and ask the operator to allowlist your range if you're calling from a data centre.</td></tr>
                        <tr><td><strong>The API itself is open to non-browser clients.</strong> CORS is a browser-only mechanism, so a caller that sends no <code>Origin</code> header (native app, server, script, AI agent) is always allowed.</td><td>Call the API directly from servers and native apps with no configuration. Only browser callers from other web origins need to be added to <code>ALLOWED_ORIGINS</code>.</td></tr>
                    </tbody>
                </table>
            </div>
            <p>A concise machine-readable index of the whole API — including the exact <code>/api/network-info</code> schema — lives at <a href="/llms.txt" class="item-link">/llms.txt</a>.</p>
        </section>

        <section class="developers-section" id="cors">
            <h2>CORS — who can call the API</h2>
            <p>The CORS policy in <code>server.js</code> allows three caller categories:</p>
            <div class="developers-table-wrap">
                <table class="developers-table">
                    <thead><tr><th>Caller</th><th>Why it works</th></tr></thead>
                    <tbody>
                        <tr><td><strong>Native mobile apps</strong> (iOS, Android, React Native — anything not running inside a browser)</td><td>CORS is a browser-only mechanism; native HTTP clients don't send an <code>Origin</code> header, so the server's <em>"if no Origin, allow"</em> branch fires.</td></tr>
                        <tr><td><strong>Server-side proxies</strong> (your backend calling ours)</td><td>Same — no <code>Origin</code> header.</td></tr>
                        <tr><td><strong>Web apps</strong> at origins listed in the <code>ALLOWED_ORIGINS</code> env var (defaults to <code>explorer.polkadex.ee</code> + <code>localhost:3000</code>)</td><td>Explicitly allowed.</td></tr>
                    </tbody>
                </table>
            </div>
            <p>A web app at a different origin will be blocked by the browser's CORS check until its origin is added to <code>ALLOWED_ORIGINS</code> (operator change, requires a backend restart). Native mobile apps need no configuration at all.</p>
        </section>

        <section class="developers-section" id="caching">
            <h2>Caching tiers</h2>
            <p>Hot endpoints carry <code>Cache-Control</code> headers in three tiers — clients should respect these and not poll faster than <code>max-age</code>:</p>
            <div class="developers-table-wrap">
                <table class="developers-table">
                    <thead><tr><th>Tier</th><th>Used by</th><th>Header</th></tr></thead>
                    <tbody>
                        <tr><td><strong>Short</strong></td><td>High-velocity feeds (<code>/api/blocks</code>, <code>/api/transactions</code>, <code>/api/events</code>)</td><td><code>public, max-age=5, s-maxage=10, stale-while-revalidate=30</code></td></tr>
                        <tr><td><strong>Medium</strong></td><td>Wallet dashboard, validators, network info, <code>/api/price-latest</code></td><td><code>public, max-age=30, s-maxage=60, stale-while-revalidate=300</code></td></tr>
                        <tr><td><strong>Long</strong></td><td>Historical (<code>/api/price-history</code>, <code>/api/staking-rewards/:addr</code>, holders, sitemap)</td><td><code>public, max-age=300, s-maxage=600, stale-while-revalidate=3600</code></td></tr>
                    </tbody>
                </table>
            </div>
        </section>

        <section class="developers-section" id="chain">
            <h2>Chain data (read-only, public)</h2>
            <ul class="developers-endpoints">
                <li><code>GET /api/blocks</code> — most recent blocks</li>
                <li><code>GET /api/block/:number</code> — single-block detail with extrinsics + events</li>
                <li><code>GET /api/events</code> — most recent on-chain events</li>
                <li><code>GET /api/transactions</code> — most recent transactions</li>
                <li><code>GET /api/transactions/older?before=&lt;n&gt;</code> — pagination further back</li>
                <li><code>GET /api/extrinsic/:block/:txHash</code> — single-extrinsic detail</li>
                <li><code>GET /api/validators</code> — full validator set with stake + commission</li>
                <li><code>GET /api/validator/:address</code> — per-validator era history</li>
                <li><code>GET /api/holders</code> — top-balance accounts</li>
                <li><code>GET /api/account/:address</code> — account-level summary</li>
                <li><code>GET /api/network-info</code> — home-page network metrics</li>
                <li><code>GET /api/search/:query</code> — block / extrinsic / account lookup</li>
                <li><code>GET /api/staking-rewards/:address</code> — per-address reward history</li>
                <li><code>GET /api/staking-rewards-status</code> — backfill progress</li>
                <li><code>GET /api/wallet/:address</code> — wallet dashboard payload (balances, staking incl. <strong>activeStakedPlanck</strong> — the u128 active-stake value as a string for precision-safe full-unbonds — unpaid rewards, recent activity)</li>
            </ul>
        </section>

        <section class="developers-section" id="inspect">
            <h2>Chain inspection (read-only, polkadot.js-style)</h2>
            <p>Generic access to runtime metadata, storage and constants at <strong>any block</strong> — the endpoints behind <a href="/chain-state" class="item-link">/chain-state</a>. Backed by an archive node, so historical queries work.</p>
            <ul class="developers-endpoints">
                <li><code>GET /api/rpc/metadata</code> — every pallet with its storage items (key arity + types), constants, calls, events, errors</li>
                <li><code>GET /api/state/:pallet/:item</code> — read any storage item. <code>?args=</code> keys, <code>?at=</code> block number/hash, <code>?entries=1</code> to list a map (capped)</li>
                <li><code>GET /api/consts/:pallet/:item</code> — runtime constants; <code>?at=</code> supported</li>
                <li><code>GET /api/runtime</code> — runtime spec/impl version; <code>?at=</code> supported</li>
                <li><code>GET /api/decode/:block</code> — every extrinsic decoded argument by argument (name, type, human, JSON, raw hex). Filters <code>?section=</code> <code>?method=</code> <code>?index=</code>; matching ignores case and underscores, so <code>submit_snapshot</code> and <code>submitSnapshot</code> both work</li>
                <li><code>POST /api/rpc/call</code> — allowlisted read-only RPC methods</li>
            </ul>
            <p><strong>Read-only by construction.</strong> Only <code>api.query</code>, <code>api.consts</code> and allowlisted read RPCs are reachable — nothing here can submit an extrinsic.</p>
            <p><strong>Send storage keys as strings.</strong> A u64 key such as <code>9223372036854775808</code> (2⁶³) is past JavaScript's <code>MAX_SAFE_INTEGER</code>, so a client that parses it as a number silently queries <code>9223372036854776000</code> — a different key whose empty result looks like confirmation. Responses echo <code>args</code> back so you can verify nothing was coerced.</p>
            <p><strong>Check <code>hex</code>, not <code>human</code>.</strong> <code>toHuman()</code> abbreviates hashes (an all-zero H256 renders as <code>0x0000…0000</code>, indistinguishable from a mostly-zero one) and group-separates large integers. Every response therefore carries human, JSON and hex together, plus a <code>count</code> for Vec-valued results.</p>
            <p>Note that <code>ValueQuery</code> maps return a <em>default-constructed</em> value for an absent key, so <code>isEmpty</code> can be <code>false</code> for a key that was never set — judge emptiness from the decoded contents.</p>
            <pre><code>curl 'https://explorer.polkadex.ee/api/decode/12250870?method=submit_snapshot'
curl 'https://explorer.polkadex.ee/api/state/ocex/validatorSetId?at=12250870'
curl 'https://explorer.polkadex.ee/api/state/ocex/authorities?args=6280&amp;at=12250870'</code></pre>
        </section>

        <section class="developers-section" id="schema">
            <h2>Schema — <code>GET /api/network-info</code></h2>
            <p>The home-page network panel in one call. Top-level response:</p>
            <pre><code>{
  "networkInfo": {
    "activeEra": number,              // current staking era index
    "avgValidatorCommission": number, // mean active-validator commission, %
    "avgApy": number,                 // headline AVG APY %, commission-adjusted
    "avg_apy": number,                // snake_case alias of avgApy
    "validators":  { "active": number, "total": number },
    "nominators":  { "active": number, "total": number },
    "maxActiveStake": number,         // largest active-validator total stake, PDEX
    "minStake": number,               // minimum active stake, PDEX
    "averageStake": number,           // mean active-validator stake, PDEX
    "avgStakePerAccount": number,     // total bonded / staking accounts, PDEX
    "totalIssuance": number,          // total PDEX issuance
    "totalBonding": number,           // total PDEX bonded for staking
    "totalBondingPercent": number,    // totalBonding / totalIssuance, %
    "totalUnbonding": number,         // total PDEX currently unbonding
    "totalStakeChange": number,       // net stake change vs previous era, PDEX
    "lastEraRewardsTotal": number     // total rewards paid last era, PDEX
  },
  "lastSync": number,                 // epoch ms when networkInfo was computed
  "status": "Synced" | "Stale" | "Initializing" | "Error",
  "chainHead": {
    "value": number,                  // best block number
    "lastAdvanceAt": number,          // epoch ms the head last advanced
    "staleSeconds": number,           // seconds since the head last advanced
    "isStale": boolean                // true if the head looks stuck
  }
}</code></pre>
            <p><strong>AVG APY</strong> is now returned directly (<code>avgApy</code>, and the <code>avg_apy</code> alias) so you don't have to recompute it. It's derived as <code>avgApy = 23.09 × (1 − avgValidatorCommission / 100)</code>, where 23.09% is the chain's nominal maximum APY at its target staking ratio.</p>
        </section>

        <section class="developers-section" id="price">
            <h2>Price feed (multi-provider)</h2>
            <ul class="developers-endpoints">
                <li><code>GET /api/price-latest</code> — current price, last-sync, plus a <strong>bySource</strong> map with one entry per configured provider (<code>coingecko</code> live by default). Each entry: <code>{ label, configured, lastSync, status, error, latest, count }</code>.</li>
                <li><code>GET /api/price-history?days=N</code> — daily series for the last N days (capped at 4000). Each row carries a <code>source</code> tag identifying which provider supplied it. Response also includes the same <code>bySource</code> rollup.</li>
            </ul>
            <p>Providers are pluggable via the <code>PRICE_PROVIDERS</code> env var (csv; default <code>coingecko</code>). CoinGecko is keyless (optional <code>COINGECKO_API_KEY</code> for higher limits); CoinMarketCap needs <code>CMC_API_KEY</code>.</p>
        </section>

        <section class="developers-section" id="governance">
            <h2>Governance</h2>
            <ul class="developers-endpoints">
                <li><code>GET /api/council</code> — council members, motions, runners-up</li>
                <li><code>GET /api/treasury</code> — treasury balance, proposals (open + historical)</li>
                <li><code>GET /api/democracy</code> — referenda + public proposals</li>
                <li><code>GET /api/governance/latest</code> — most-recent OPEN referendum / proposal (drives the homepage banner; only ongoing events)</li>
                <li><code>GET /api/governance/calendar</code> — unified timeline across referenda + motions + treasury</li>
            </ul>
        </section>

        <section class="developers-section" id="email">
            <h2>Email alerts</h2>
            <ul class="developers-endpoints">
                <li><code>POST /api/email/subscribe</code> — double opt-in signup (rate-limited per IP)</li>
                <li><code>GET /api/email/confirm?token=&lt;t&gt;</code> — renders a confirmation page with a button (read-only); <code>POST /api/email/confirm</code> with a <code>token</code> form field performs it</li>
                <li><code>GET /api/email/unsubscribe?token=&lt;t&gt;</code> — renders an unsubscribe page with a button (read-only); <code>POST /api/email/unsubscribe</code> performs it, and is the RFC 8058 <code>List-Unsubscribe-Post</code> target</li>
                <li><code>GET /api/email/preferences?token=&lt;t&gt;</code> — fetch current event preferences</li>
                <li><code>POST /api/email/preferences</code> — update preferences (token in body). Both back the <code>/email/preferences?token=&lt;t&gt;</code> page linked from every alert email; that route is <code>noindex</code> because the token is the credential.</li>
            </ul>
        </section>

        <section class="developers-section" id="discussions">
            <h2>Discussions</h2>
            <ul class="developers-endpoints">
                <li><code>GET /api/discussions</code> — discussion threads attached to governance items</li>
                <li><code>GET /api/discussions/:id</code> — single thread with posts</li>
            </ul>
        </section>

        <section class="developers-section" id="auth">
            <h2>Authenticated (wallet sign-in for discussion posts)</h2>
            <p>Wallet-signed nonce login. Sessions are 192-bit random tokens with a TTL.</p>
            <ul class="developers-endpoints">
                <li><code>POST /api/auth/challenge</code> — request a sign-in nonce</li>
                <li><code>POST /api/auth/verify</code> — submit <code>{ address, signature, nonce }</code>, receive a session token</li>
                <li><code>POST /api/auth/logout</code></li>
                <li><code>POST /api/discussions/:id/posts</code> — post to a discussion (rate-limited, requires session)</li>
            </ul>
        </section>

        <section class="developers-section" id="errors">
            <h2>Error envelope</h2>
            <p>Most failures return a 4xx/5xx status with <code>{ "error": "&lt;message&gt;" }</code>. RPC-dependent endpoints surface <strong>503</strong> with <code>{ "error": "rpc not connected" }</code> during chain RPC outages — treat 503 as <em>"retry with backoff"</em>, not a permanent failure.</p>
        </section>

        <section class="developers-section" id="addresses">
            <h2>Address format</h2>
            <p>All paths that take an <code>:address</code> expect Polkadex-format SS58 (prefix 88, addresses start with <code>e…</code>). The server normalizes via <code>toPolkadexAddress()</code> so wallet-native prefixes (42, 0) usually also resolve, but consistency is recommended.</p>
        </section>

        <section class="developers-section" id="examples">
            <h2>Quick examples</h2>
            <p>Network info (home-page summary):</p>
            <pre><code>curl https://explorer.polkadex.ee/api/network-info</code></pre>
            <p>Latest PDEX price:</p>
            <pre><code>curl https://explorer.polkadex.ee/api/price-latest</code></pre>
            <p>30-day price history (each row tagged with its data source):</p>
            <pre><code>curl 'https://explorer.polkadex.ee/api/price-history?days=30'</code></pre>
            <p>Wallet summary for a Polkadex address (replace with a real <code>e…</code> address):</p>
            <pre><code>curl https://explorer.polkadex.ee/api/wallet/esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew</code></pre>
            <p>Search (returns block / extrinsic / account hits):</p>
            <pre><code>curl https://explorer.polkadex.ee/api/search/12000000</code></pre>
        </section>

        <section class="developers-section" id="contact">
            <h2>Found a bug or missing endpoint?</h2>
            <p>Open an issue at <a href="https://github.com/Polkadex-Substrate" target="_blank" rel="noopener" class="item-link">github.com/Polkadex-Substrate</a>, or reach the team via the channels listed at <a href="https://polkadex.ee" target="_blank" rel="noopener" class="item-link">polkadex.ee</a>.</p>
        </section>
    `;
}

// Open the relevant governance detail modal when arriving at /democracy,
// /treasury, or /council with a query string identifying a specific item.
// Called by each governance page's fetch handler AFTER its data is loaded,
// so the lookup can succeed. returnPage='calendar' means the modal's close
// button will navigate the user back to /calendar via the existing
// closeGovernanceDetailModal logic.
//
// Supported query params:
//   /democracy?ref=N        → opens referendum #N
//   /democracy?proposal=N   → opens public proposal #N
//   /treasury?proposal=N    → opens treasury proposal #N
//   /council?motion=N       → opens council motion #N
function tryOpenFromQueryString(page) {
    let params;
    try { params = new URLSearchParams(window.location.search || ''); }
    catch (_) { return; }

    if (page === 'democracy' && typeof democracyData === 'object' && democracyData) {
        const refIdx = params.get('ref');
        if (refIdx != null && refIdx !== '') {
            const referenda = Array.isArray(democracyData.referenda) ? democracyData.referenda : [];
            const row = referenda.find(r => String(r.refIndex) === String(refIdx));
            if (row) {
                openGovernanceDetailModal({ kind: 'referendum', row, returnPage: 'history-back' });
                return;
            }
        }
        const propIdx = params.get('proposal');
        if (propIdx != null && propIdx !== '') {
            const props = Array.isArray(democracyData.publicProposals) ? democracyData.publicProposals : [];
            const row = props.find(p => String(p.index) === String(propIdx));
            if (row) {
                openGovernanceDetailModal({ kind: 'public-proposal', row, returnPage: 'history-back' });
                return;
            }
        }
    } else if (page === 'treasury' && typeof treasuryData === 'object' && treasuryData) {
        const propIdx = params.get('proposal');
        if (propIdx != null && propIdx !== '') {
            const props = Array.isArray(treasuryData.allProposals) ? treasuryData.allProposals : [];
            const row = props.find(p => String(p.id) === String(propIdx));
            if (row) {
                openGovernanceDetailModal({ kind: 'treasury', row, returnPage: 'history-back' });
                return;
            }
        }
    } else if (page === 'council' && typeof councilData === 'object' && councilData) {
        const motionIdx = params.get('motion');
        if (motionIdx != null && motionIdx !== '') {
            const motions = Array.isArray(councilData.motions) ? councilData.motions : [];
            const row = motions.find(m => String(m.motionIndex) === String(motionIdx));
            if (row) {
                openGovernanceDetailModal({ kind: 'motion', row, returnPage: 'history-back' });
                return;
            }
        }
    }
}

// Audit F-015: every string and key MUST be HTML-escaped. This tree renders
// decoded extrinsics/events on /block and /tx, and those contain arbitrary
// user-controlled bytes from the chain (system.remark, identity fields inside
// calls). Unescaped, anyone who lands a remark on-chain gets stored XSS with
// a shareable public URL. The decode page already escapes — this must too.
function renderJSONTree(obj, indent = 0) {
    if (obj === null) return '<span class="json-null">null</span>';
    if (typeof obj === 'boolean') return `<span class="json-boolean">${obj}</span>`;
    if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
    if (typeof obj === 'string') return `<span class="json-string">"${stakingEscapeHtml(obj)}"</span>`;

    if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]';
        let html = '[\n';
        const innerIndent = indent + 1;
        const spaces = '  '.repeat(innerIndent);
        obj.forEach((val, i) => {
            html += `<div class="json-indent">${spaces}${renderJSONTree(val, innerIndent)}${i < obj.length - 1 ? ',' : ''}</div>`;
        });
        html += '  '.repeat(indent) + ']';
        return html;
    }

    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) return '{}';
        let html = '{\n';
        const innerIndent = indent + 1;
        const spaces = '  '.repeat(innerIndent);
        keys.forEach((k, i) => {
            html += `<div class="json-indent">${spaces}<span class="json-key">"${stakingEscapeHtml(k)}"</span>: ${renderJSONTree(obj[k], innerIndent)}${i < keys.length - 1 ? ',' : ''}</div>`;
        });
        html += '  '.repeat(indent) + '}';
        return html;
    }
    return String(obj);
}

window.switchAccountTab = function (tabName) {
    // Toggle the .active class on the .account-tab buttons — visual treatment
    // (pink underline, hover, transitions) is handled entirely by CSS.
    document.querySelectorAll('.account-tab-btn').forEach(btn => {
        const isActive = (btn.dataset.accountTab || btn.innerText.trim().toLowerCase()) === tabName.toLowerCase();
        btn.classList.toggle('active', isActive);
    });

    document.getElementById('account-tab-transactions').style.display = tabName === 'transactions' ? 'block' : 'none';
    document.getElementById('account-tab-events').style.display = tabName === 'events' ? 'block' : 'none';
};

async function fetchAccountDetails(address) {
    if (accountDetailsContainer) accountDetailsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching account details...</div>';
    const shortAddr = address ? (address.substring(0, 8) + '…' + address.substring(address.length - 6)) : '';
    updateSeoMeta('account-details', {
        title: `Account ${shortAddr} — Polkadex Explorer`,
        description: `Polkadex account ${address}: balance, transactions, and events.`,
        canonicalPath: `/account/${address}`
    });
    try {
        const data = await fetchApiJson(`/api/account/${address}`);
        const label = (data.display && data.display !== 'Unknown') ? data.display : shortAddr;
        updateSeoMeta('account-details', {
            title: `Account ${label} — Polkadex Explorer`,
            description: `Polkadex account ${address}${data.display && data.display !== 'Unknown' ? ' (' + data.display + ')' : ''}: balance ${data.balanceTotal != null ? data.balanceTotal.toFixed ? data.balanceTotal.toFixed(2) + ' PDEX' : data.balanceTotal + ' PDEX' : ''}, transactions, and events.`,
            canonicalPath: `/account/${address}`
        });

        // Transactions + Events tables are now rendered by makeTable into
        // dedicated container divs after the outer chrome is in place. We
        // just leave placeholders in the markup here and wire them up below.
        const txEmptyMessage = data.status === 'Syncing'
            ? 'Crawling deep history (up to 30 days)… Please refresh in a minute.'
            : 'No recent transactions.';
        const evEmptyMessage = data.status === 'Syncing'
            ? 'Crawling deep history (up to 30 days)… Please refresh in a minute.'
            : 'No recent events.';

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="font-size: 18px;">Account Details</h2>
                <a href="#" data-close-detail="holders" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;" title="Close" aria-label="Close"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            <div style="background: rgba(255,255,255,0.02); margin-bottom: 20px; border-radius: 4px; border: 1px solid var(--border-color);">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
                    <tr style="background: rgba(255,255,255,0.05);">
                        <td style="padding: 12px 20px; font-weight: 600; width: 250px;">account</td>
                        <td style="padding: 12px 20px;" class="address-cell address-with-label" data-address="${stakingEscapeHtml(data.account)}">${stakingEscapeHtml(data.account)} <span class="js-copy-address" style="cursor: pointer; color: var(--brand-secondary); font-size: 13px; margin-left: 10px;">copy</span> ${watchlistStarButton('address', data.account, (data.display && data.display !== 'Unknown') ? data.display : data.account)}
                            <div id="account-label-editor"></div>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 20px; font-weight: 600;">display</td>
                        <!-- Audit F-013: data.display is pallet_identity text — anyone
                             can set it on-chain, so it MUST be escaped or an identity
                             string becomes stored XSS on /account/<addr>. -->
                        <td style="padding: 12px 20px; color: var(--brand-secondary);">${stakingEscapeHtml(data.display)}</td>
                    </tr>
                    <tr style="background: rgba(255,255,255,0.02);">
                        <td style="padding: 12px 20px; font-weight: 600;">balance total</td>
                        <td style="padding: 12px 20px;">${data.balanceTotal.toFixed(4)} <span style="font-size: 11px; color: var(--text-secondary);">(PDEX)</span></td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 20px; font-weight: 600;">balance reserved</td>
                        <td style="padding: 12px 20px;">${Number(data.balanceReserved != null ? data.balanceReserved : data.balanceFrozen).toFixed(4)} <span style="font-size: 11px; color: var(--text-secondary);">(PDEX)</span></td>
                    </tr>
                    <tr style="background: rgba(255,255,255,0.02);">
                        <td style="padding: 12px 20px; font-weight: 600;">balance free</td>
                        <td style="padding: 12px 20px;">${data.balanceFree.toFixed(4)} <span style="font-size: 11px; color: var(--text-secondary);">(PDEX)</span></td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 20px; font-weight: 600;">roles</td>
                        <td style="padding: 12px 20px;">${stakingEscapeHtml(data.roles)}</td>
                    </tr>
                    <tr style="background: rgba(255,255,255,0.02);">
                        <td style="padding: 12px 20px; font-weight: 600;">Rating(top)</td>
                        <td style="padding: 12px 20px;">${(data.rank == null || data.rank === "0") ? "outside the top 500" : '#' + stakingEscapeHtml(String(data.rank))}</td>
                    </tr>
                </table>
            </div>
            
            <div style="margin-bottom: 20px;">
                <div class="account-tabs" style="padding: 0 20px; margin-bottom: 15px;">
                    <button type="button" class="account-tab account-tab-btn active" data-account-tab="transactions">Transactions</button>
                    <button type="button" class="account-tab account-tab-btn" data-account-tab="events">Events</button>
                </div>
                
                <div id="account-tab-transactions">
                    <div id="account-tx-table"></div>
                </div>

                <div id="account-tab-events" style="display: none;">
                    <div id="account-ev-table"></div>
                </div>
            </div>
        `;
        accountDetailsContainer.innerHTML = html;

        // Audit F-122: bind copy with addEventListener and read the address
        // from the already-escaped data-address attribute. An inline
        // onclick="copyToClipboard(this, '${address}')" puts a raw string
        // inside a JavaScript-in-HTML context — a second injection sink even
        // after the visible text is escaped.
        // Tab switching — the buttons already carried data-account-tab; the
        // inline onclick= beside it is gone for the same CSP reason as above.
        accountDetailsContainer.querySelectorAll('.account-tab-btn').forEach(el => {
            el.addEventListener('click', () => window.switchAccountTab(el.getAttribute('data-account-tab')));
        });

        accountDetailsContainer.querySelectorAll('.js-copy-address').forEach(el => {
            el.addEventListener('click', function () {
                const holder = this.closest('[data-address]');
                if (holder) copyToClipboard(this, holder.getAttribute('data-address'));
            });
        });

        // Now that the container divs exist, mount the two makeTable
        // instances. Re-running fetchAccountDetails creates new instances
        // each time; that's fine because the outer DOM was replaced.
        // Pull the self-label for this address (if any) and render the
        // inline editor when the viewer is the owner. Both are async and
        // independent of the makeTable mounts below.
        ensureAddressLabel(data.account);
        renderAccountLabelEditor(data.account);
        makeTable({
            container: document.getElementById('account-tx-table'),
            rows: data.transactions || [],
            defaultSort: { key: 'timestamp', dir: 'desc' },
            globalSearch: true,
            summarySuffix: 'transactions',
            emptyMessage: txEmptyMessage,
            // Active accounts can accumulate hundreds-to-thousands of txs over
            // their lifetime; show-more first, page numbers above 200.
            pagination: { pageSize: 50, showMoreMax: 200 },
            columns: [
                {
                    key: 'hash', label: 'Txn Hash', searchable: true,
                    sort: (a, b) => String(a.hash || '').localeCompare(String(b.hash || '')),
                    format: row => {
                        const short = stakingEscapeHtml((row.hash || '').substring(0, 25)) + '…';
                        // The /api/account-details endpoint mixes real
                        // extrinsics with event-derived rows whose "hash" is
                        // 'event-<block>-<idx>'. Linking those to /tx/…
                        // produced a 400 "Invalid hash format" — route
                        // event-id rows to /block/ instead, where the event
                        // actually lives.
                        return (row.eventDerived || !looksLikeTxHash(row.hash))
                            ? `<a href="/block/${row.block}" class="item-link" style="color: var(--brand-secondary);">${short}</a>`
                            : `<a href="/tx/${row.block}/${row.hash}" class="item-link" style="color: var(--brand-secondary);">${short}</a>`;
                    }
                },
                {
                    key: 'amount', label: 'Method / Action', searchable: true,
                    sort: (a, b) => String(a.amount || '').localeCompare(String(b.amount || '')),
                    filter: { type: 'text', placeholder: 'Method…' },
                    format: row => `${stakingEscapeHtml(row.amount || 'system')}<br><span style="color: var(--text-secondary); font-size: 11px;">call</span>`
                },
                {
                    key: 'timestamp', label: 'Age',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => stakingEscapeHtml(timeAgo(row.timestamp))
                },
                {
                    key: 'timestampDate', label: 'Date',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => row.timestamp ? stakingEscapeHtml(formatLocalDateTime(row.timestamp)) : '—'
                },
                {
                    key: 'status', label: 'Status', searchable: true,
                    sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
                    filter: { type: 'select', options: ['success', 'failed'] },
                    format: row => row.status === 'success'
                        ? '<span class="badge" style="background: rgba(46, 204, 113, 0.2); color: #2ecc71;">Success</span>'
                        : '<span class="badge" style="background: rgba(231, 76, 60, 0.2); color: #e74c3c;">Failed</span>'
                }
            ]
        });

        const eventSections = Array.from(new Set((data.events || []).map(e => e.section).filter(Boolean))).sort();
        const eventMethods  = Array.from(new Set((data.events || []).map(e => e.method).filter(Boolean))).sort();
        makeTable({
            container: document.getElementById('account-ev-table'),
            rows: data.events || [],
            defaultSort: { key: 'timestamp', dir: 'desc' },
            globalSearch: true,
            summarySuffix: 'events',
            emptyMessage: evEmptyMessage,
            // Events per account outpace transactions (staking, rewards,
            // governance vote casts, etc.) — paginate on the same cadence.
            pagination: { pageSize: 50, showMoreMax: 200 },
            columns: [
                {
                    key: 'hash', label: 'Event Hash', searchable: true,
                    format: row => `<span class="address-cell" style="color: var(--brand-secondary);">${stakingEscapeHtml((row.hash || '').substring(0, 25))}…</span>`
                },
                {
                    key: 'section', label: 'Section',
                    sort: (a, b) => String(a.section || '').localeCompare(String(b.section || '')),
                    filter: { type: 'select', options: eventSections },
                    format: row => stakingEscapeHtml(row.section || '')
                },
                {
                    key: 'method', label: 'Method', searchable: true,
                    sort: (a, b) => String(a.method || '').localeCompare(String(b.method || '')),
                    filter: { type: 'select', options: eventMethods },
                    format: row => `<span style="color: var(--text-secondary); font-size: 11px;">${stakingEscapeHtml(row.method || '')}</span>`
                },
                {
                    key: 'timestamp', label: 'Age',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => stakingEscapeHtml(timeAgo(row.timestamp))
                },
                {
                    key: 'timestampDate', label: 'Date',
                    sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                    format: row => row.timestamp ? stakingEscapeHtml(formatLocalDateTime(row.timestamp)) : '—'
                }
            ]
        });
    } catch (e) {
        renderApiError(accountDetailsContainer, e, () => fetchAccountDetails(address));
    }
}

async function fetchBlockDetails(id) {
    if (blockDetailsContainer) blockDetailsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching block details...</div>';
    // Provisional SEO update — overwritten with concrete data once the fetch lands.
    updateSeoMeta('block-details', {
        title: `Block #${id} — Polkadex Explorer`,
        description: `Polkadex Mainnet block #${id}: extrinsics, events, author, and timestamp.`,
        canonicalPath: `/block/${id}`
    });
    try {
        const data = await fetchApiJson(`/api/block/${id}`);
        const blockNum = data.block && data.block.header && data.block.header.number;
        updateSeoMeta('block-details', {
            title: `Block #${blockNum || id} — Polkadex Explorer`,
            description: `Polkadex Mainnet block #${blockNum || id} (${new Date(data.date).toISOString().substring(0, 19).replace('T', ' ')} UTC): extrinsics, events, and author.`,
            canonicalPath: `/block/${id}`
        });

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2>Block ${data.block.header.number}</h2>
                <a href="#" data-close-detail="blocks" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;" title="Close" aria-label="Close"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            <div style="padding: 20px;">
                <div style="margin-bottom: 10px;"><strong>hash</strong> <span class="address-cell">${data.hash}</span></div>
                <div style="margin-bottom: 20px;"><strong>date</strong> <span style="color: var(--text-secondary);">${stakingEscapeHtml(formatLocalDateTime(data.date))}</span></div>
                <div class="json-container">
                    ${renderJSONTree({ block: data.block })}
                </div>
            </div>
        `;
        blockDetailsContainer.innerHTML = html;
    } catch (e) {
        renderApiError(blockDetailsContainer, e, () => fetchBlockDetails(id));
    }
}

// True iff the string looks like a valid 32-byte extrinsic hash. We accept
// hex with either case and an optional 0x prefix; the server's own normalizer
// canonicalises before storing. Anything else (event IDs like
// 'event-12220204-2', empty strings, short prefixes, garbage from a
// hand-edited URL) returns false so we can render the recovery card without
// ever round-tripping to the server for a guaranteed 400.
function looksLikeTxHash(s) {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    const withoutPrefix = trimmed.toLowerCase().startsWith('0x') ? trimmed.slice(2) : trimmed;
    return /^[0-9a-f]{64}$/i.test(withoutPrefix);
}

async function fetchTxDetails(block, hash) {
    // Guard rail: when the URL segment can't possibly be a tx hash (e.g., an
    // event ID copied into the tx route), skip the server round-trip and go
    // straight to the recovery card with a tailored message. Common path:
    // user clicks an event-derived row whose hash is 'event-<block>-<idx>'.
    if (!looksLikeTxHash(hash)) {
        renderTxNotFoundCard(block, hash, { reason: 'invalid-format' });
        return;
    }
    if (txDetailsContainer) txDetailsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching transaction details...</div>';
    const shortHash = (hash || '').substring(0, 12);
    updateSeoMeta('tx-details', {
        title: `Transaction ${shortHash}… — Polkadex Explorer`,
        description: `Polkadex Mainnet transaction ${hash} in block #${block}.`,
        canonicalPath: `/tx/${block}/${hash}`
    });
    try {
        const data = await fetchApiJson(`/api/extrinsic/${block}/${hash}`);

        // The backend's ±2 fallback may have located the tx in a neighbour
        // block. Quietly correct the URL via replaceState so the user can
        // share the right link without seeing a flash of "not found" first.
        // We also flag the correction in a small banner above the table so
        // they know what happened.
        let correctionBanner = '';
        if (data.correctedFrom != null && Number.isFinite(data.block) && data.block !== data.correctedFrom) {
            try { history.replaceState(null, '', '/tx/' + data.block + '/' + data.hash); } catch (_) {}
            correctionBanner = `<div style="margin: 0 20px 12px; padding: 10px 14px; background: rgba(245, 166, 35, 0.1); border: 1px solid rgba(245, 166, 35, 0.3); border-radius: 4px; font-size: 0.82rem; color: var(--text-secondary);">
                <i class='bx bx-info-circle' style="vertical-align: middle; color: #f5a623;"></i>
                The link pointed at block #${data.correctedFrom}, but the transaction is actually in block #${data.block}. The URL has been corrected — likely a chain reorg between when the link was generated and when it was opened.
            </div>`;
        }

        updateSeoMeta('tx-details', {
            title: `Transaction ${shortHash}… (${data.event || 'extrinsic'}) — Polkadex Explorer`,
            description: `Polkadex Mainnet transaction ${data.hash || hash} in block #${data.block}: ${data.event || 'extrinsic'} from ${data.from || 'unknown'} to ${data.to || 'unknown'}, status: ${data.status || 'unknown'}.`,
            canonicalPath: '/tx/' + data.block + '/' + (data.hash || hash)
        });

        let html = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2>Tx: ${data.hash}</h2>
                <a href="#" data-close-detail="transactions" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;" title="Close" aria-label="Close"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            ${correctionBanner}
            <div style="padding: 20px;">
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px; text-align: left;">
                    <tr><td style="padding: 10px; font-weight: bold; width: 150px;">Time</td><td style="padding: 10px;">${stakingEscapeHtml(formatLocalDateTime(data.time))}</td></tr>
                    <!-- Audit F-122: every chain-derived field escaped; from/to
                         also URL-encoded in the href attribute context. -->
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">event</td><td style="padding: 10px;">${stakingEscapeHtml(data.event)}</td></tr>
                    <tr><td style="padding: 10px; font-weight: bold;">from</td><td style="padding: 10px;"><a href="/account/${encodeURIComponent(data.from)}" class="item-link address-cell">${stakingEscapeHtml(data.from)}</a></td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">to</td><td style="padding: 10px;"><a href="/account/${encodeURIComponent(data.to)}" class="item-link address-cell">${stakingEscapeHtml(data.to)}</a></td></tr>
                    <tr><td style="padding: 10px; font-weight: bold;">status</td><td style="padding: 10px;"><span class="badge" style="background: ${data.status === 'success' ? 'var(--success)' : 'var(--error)'}; font-size: 11px;">${stakingEscapeHtml(data.status)}</span></td></tr>
                    <tr style="background: rgba(255,255,255,0.02);"><td style="padding: 10px; font-weight: bold;">block</td><td style="padding: 10px;"><a href="/block/${encodeURIComponent(data.block)}" class="item-link">${stakingEscapeHtml(String(data.block))}</a></td></tr>
                </table>
                <div class="json-container">
                    ${renderJSONTree({ hash: data.hash, signer: data.from, method: data.event, extrinsic: data.extrinsic, events: data.events })}
                </div>
            </div>
        `;
        txDetailsContainer.innerHTML = html;
    } catch (e) {
        // Special case: "Extrinsic not found in block" (after the backend's
        // own ±2 neighbour-block fallback already failed). Render a recovery
        // card with a button that scans recent blocks for the hash. Common
        // cause: a stale link from before a chain reorg moved the tx more
        // than 2 blocks away, or a hand-edited URL with the wrong block.
        if (e && e.status === 404 && /Extrinsic not found/i.test(e.message || '')) {
            renderTxNotFoundCard(block, hash);
            return;
        }
        // Matches the server's `hint: 'invalid-format'` 400 — same UX as the
        // client-side looksLikeTxHash guard above. Defensive: if a future
        // call path bypasses the route-level guard, the recovery card still
        // shows instead of a red error line.
        if (e && e.status === 400 && /doesn't look like a transaction hash/i.test(e.message || '')) {
            renderTxNotFoundCard(block, hash, { reason: 'invalid-format' });
            return;
        }
        renderApiError(txDetailsContainer, e, () => fetchTxDetails(block, hash));
    }
}

// Recovery UX for the "Extrinsic not found in block N" 404. Offers a button
// that calls /api/extrinsic-by-hash/:txHash to scan recent blocks. On a hit
// the user is redirected to the corrected /tx/<actual_block>/<hash> URL;
// on a miss we direct them to the deep search as a final escape.
function renderTxNotFoundCard(block, hash, opts) {
    if (!txDetailsContainer) return;
    const reason = (opts && opts.reason) || 'not-found';
    const shortHash = (hash || '').substring(0, 12);
    const blockSafe = stakingEscapeHtml(String(block));
    const hashSafe = stakingEscapeHtml(shortHash);
    const hashIsEventId = typeof hash === 'string' && /^event-/i.test(hash);

    // Compose the headline / body / primary CTA based on why we landed here.
    // Three cases:
    //   1. invalid-format + event-id  → URL came from a misrouted event row.
    //      Best action: take the user to the block, where the event lives.
    //   2. invalid-format + other     → hand-edited URL or garbled clipboard.
    //      Best action: deep search, no point scanning recent blocks.
    //   3. not-found                   → server's ±2 fallback already failed.
    //      Best action: scan recent blocks for the hash (chain reorg fallback).
    let headline, body, primaryButtonHtml, primaryAction;
    if (reason === 'invalid-format' && hashIsEventId) {
        headline = `Looking for an event, not a transaction`;
        body = `This link points to an event identifier (<code style="color: var(--brand-secondary); font-size: 0.82rem;">${hashSafe}…</code>),
            not a transaction hash. Events live inside blocks — view block #${blockSafe} to see the full list of events that ran in it.`;
        primaryButtonHtml = `<i class='bx bx-cube'></i> View block #${blockSafe}`;
        primaryAction = () => navigateTo('block/' + block);
    } else if (reason === 'invalid-format') {
        headline = `That doesn't look like a transaction hash`;
        body = `A transaction hash is 64 hexadecimal characters (with an optional <code style="color: var(--brand-secondary); font-size: 0.82rem;">0x</code> prefix).
            What we got — <code style="color: var(--brand-secondary); font-size: 0.82rem;">${hashSafe}…</code> — is the wrong shape, so it can't match any extrinsic on chain.
            The link is probably hand-edited or copied wrong.`;
        primaryButtonHtml = `<i class='bx bx-globe'></i> Try a deep search`;
        primaryAction = () => navigateTo('search?q=' + encodeURIComponent(hash || ''));
    } else {
        headline = `Transaction not in block #${blockSafe}`;
        body = `The link pointed at <code style="color: var(--brand-secondary); font-size: 0.82rem;">${hashSafe}…</code>
            in block #${blockSafe}, but no extrinsic with that hash is in that block (or in the two blocks on either side).
            This is usually a stale link from before a chain reorg moved the transaction elsewhere.`;
        primaryButtonHtml = `<i class='bx bx-search'></i> Search recent blocks for this hash`;
        primaryAction = 'scan-recent'; // sentinel — wired below
    }

    txDetailsContainer.innerHTML = `
        <div class="list-container glass" style="padding: 40px 28px;">
            <div style="text-align: center; max-width: 580px; margin: 0 auto;">
                <i class='bx bx-search-alt' style="font-size: 42px; color: var(--brand-primary); opacity: 0.7;"></i>
                <h2 style="margin: 14px 0 8px;">${headline}</h2>
                <p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.6;">${body}</p>
                <div style="display: flex; gap: 10px; justify-content: center; margin-top: 22px; flex-wrap: wrap;">
                    <button type="button" id="tx-recover-btn" class="staking-download-btn" style="padding: 10px 22px; background: var(--brand-primary); color: white; border-color: var(--brand-primary);">
                        ${primaryButtonHtml}
                    </button>
                    <a href="/search?q=${encodeURIComponent(hash || '')}" class="staking-download-btn" style="padding: 10px 22px; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
                        <i class='bx bx-globe'></i> Deep network search
                    </a>
                </div>
                <div id="tx-recover-status" style="margin-top: 16px; font-size: 0.85rem; color: var(--text-muted);"></div>
            </div>
        </div>`;

    const btn = document.getElementById('tx-recover-btn');
    const status = document.getElementById('tx-recover-status');
    if (!btn) return;

    // For the two "invalid-format" branches, the primary CTA navigates within
    // the SPA — wire that and skip the recent-blocks scan path entirely.
    if (typeof primaryAction === 'function') {
        btn.addEventListener('click', () => primaryAction());
        return;
    }
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const origHtml = btn.innerHTML;
        btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Scanning recent blocks…";
        try {
            const data = await fetchApiJson('/api/extrinsic-by-hash/' + encodeURIComponent(hash));
            if (data.found && Number.isFinite(data.block)) {
                if (status) status.innerHTML = `Found in block #${data.block}. Redirecting…`;
                // Use the SPA router so the page transitions in-app rather
                // than reloading the shell.
                navigateTo('tx/' + data.block + '/' + data.txHash);
                return;
            }
            if (status) {
                status.innerHTML = `Not found in the last ${data.scanned || 'N'} blocks (scanned ${data.fromBlock || ''} down to ${data.toBlock || ''}). ` +
                    `Try the deep network search, or paste the hash on a chain-aware archive node directly.`;
            }
            btn.disabled = false;
            btn.innerHTML = origHtml;
        } catch (err) {
            if (status) status.innerHTML = `Search failed: ${stakingEscapeHtml(err.message || 'unknown error')}.`;
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    });
}

// Kept for backward compatibility — if a third-party link still drops a "#X"
// fragment on the user, fall through to clean-URL routing.
window.addEventListener('hashchange', () => {
    const hash = window.location.hash.substring(1).trim();
    if (hash) navigateTo(hash, { replace: true });
});

window.copyToClipboard = function (element, text) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = element.innerText;
        element.innerText = 'copied!';
        element.style.color = 'var(--success)';
        setTimeout(() => {
            element.innerText = originalText;
            element.style.color = 'var(--brand-secondary)';
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
};

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        const target = item.getAttribute('data-target');
        if (!target) return;
        // The delegated click handler in bootSeoRouter() also catches these
        // anchors (since their href is "/<target>"). We keep this listener so
        // data-target-only nav items (no href) still work as expected.
        if (!item.getAttribute('href')) {
            e.preventDefault();
            navigateTo(target);
        }
    });
});

let validatorChart = null;

// ─── Validator scorecard ────────────────────────────────────────────────────
// Compact stat grid that surfaces the headline metrics a nominator needs to
// decide whether to back this validator: estimated APY, commission band,
// active-era rate, slash count, current stake. The backend computes the
// numbers (see computeValidatorScorecard in server.js) so multiple consumers
// can share the same definition.
function renderValidatorScorecard(scorecard) {
    if (!scorecard) return '';
    const pad = n => (Number.isFinite(n) ? n : 0);
    const apy = pad(scorecard.estimatedApy).toFixed(2);
    const avgComm = pad(scorecard.avgCommission).toFixed(2);
    const commBand = (scorecard.minCommission === scorecard.maxCommission)
        ? `${avgComm}%`
        : `${pad(scorecard.minCommission).toFixed(1)}% – ${pad(scorecard.maxCommission).toFixed(1)}%`;
    const activeRate = (pad(scorecard.activeEraRate) * 100).toFixed(0);
    const slashColor = scorecard.slashCount > 0 ? 'var(--error)' : 'var(--success)';
    const slashLabel = scorecard.slashCount === 0
        ? 'Clean'
        : `${scorecard.slashCount} event${scorecard.slashCount === 1 ? '' : 's'}`;
    return `
        <div style="margin-bottom: 25px;">
            <h3 style="font-size: 14px; margin-bottom: 12px; display:flex; align-items:center; gap:8px;">
                <i class='bx bx-stats' style="color:var(--brand-primary);"></i> Scorecard
                <span style="color:var(--text-muted);font-weight:400;font-size:0.78rem;">(last ${pad(scorecard.totalEras)} eras)</span>
            </h3>
            <div class="staking-summary-grid">
                <div class="staking-summary-card">
                    <div class="label">Est. APY</div>
                    <div class="value accent">${apy}%</div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">nominator return after commission</div>
                </div>
                <div class="staking-summary-card">
                    <div class="label">Commission</div>
                    <div class="value">${commBand}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">avg ${avgComm}%</div>
                </div>
                <div class="staking-summary-card">
                    <div class="label">Active eras</div>
                    <div class="value">${pad(scorecard.activeEras)} <span style="color:var(--text-muted);font-size:0.7rem;font-weight:400;">/ ${pad(scorecard.totalEras)}</span></div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">${activeRate}% in active set</div>
                </div>
                <div class="staking-summary-card">
                    <div class="label">Slash history</div>
                    <div class="value" style="color:${slashColor};">${slashLabel}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">commission-spike triggers</div>
                </div>
                <div class="staking-summary-card">
                    <div class="label">Current stake</div>
                    <div class="value">${stakingFormatPDEX(scorecard.currentStake)} <span class="unit">PDEX</span></div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">latest indexed era</div>
                </div>
            </div>
        </div>
    `;
}

async function fetchValidatorDetails(address) {
    const container = document.getElementById('validator-details-container');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center; padding: 20px;">Fetching validator history...</div>';

    const shortAddr = address ? (address.substring(0, 8) + '…' + address.substring(address.length - 6)) : '';
    updateSeoMeta('validator-details', {
        title: `Validator ${shortAddr} — Polkadex Explorer`,
        description: `Polkadex validator ${address}: era history, commission, stake, and nominators.`,
        canonicalPath: `/validator/${address}`
    });

    try {
        const data = await fetchApiJson(`/api/validator/${address}`);

        const validatorLabel = (data.identity && data.identity !== 'Unknown') ? data.identity : shortAddr;
        updateSeoMeta('validator-details', {
            title: `Validator ${validatorLabel} — Polkadex Explorer`,
            description: `Polkadex validator ${validatorLabel} (${address}): era history, commission, total stake, and nominators on the Polkadex Mainnet.`,
            canonicalPath: `/validator/${address}`
        });

        // Audit F-014: escape ONLY the identity text — it's on-chain
        // pallet_identity data anyone can set, i.e. stored XSS if inserted
        // raw. The Unknown fallback is our own static markup and must NOT be
        // escaped, or unknown validators would render a literal "<span…" on
        // screen. (The address inside it is chain-format SS58, escaped anyway
        // for uniformity.)
        const identityStr = data.identity !== "Unknown"
            ? stakingEscapeHtml(data.identity)
            : `<span class="address-cell">${stakingEscapeHtml(address.substring(0, 8))}...</span>`;

        let commissionWarning = '';
        if (data.history.length > 0) {
            const maxComm = Math.max(...data.history.map(h => h.commission));
            if (maxComm > 50) {
                let triggersHtml = '';
                let triggerActionHtml = '';
                if (data.triggers && data.triggers.length > 0) {
                    triggerActionHtml = `
                        <br><button type="button" id="toggle-trigger-events" style="border: 0; background: transparent; color: #ff6b6b; font-weight: bold; text-decoration: underline; margin-top: 5px; display: inline-block; padding: 0; cursor: pointer;">go to trigger events</button>
                    `;
                    triggersHtml = `
                        <div id="trigger-events-log" style="display: none; margin-top: 15px; border-top: 1px solid rgba(255, 50, 50, 0.2); padding-top: 15px;">
                            <strong style="display: block; margin-bottom: 10px;">Trigger Events Log:</strong>
                            <table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #ffcccc;">
                                <thead>
                                    <tr style="border-bottom: 1px solid rgba(255, 50, 50, 0.2);">
                                        <th style="padding: 5px; text-align: left;">Era</th>
                                        <th style="padding: 5px; text-align: left;">Previous Comm.</th>
                                        <th style="padding: 5px; text-align: left;">New Comm.</th>
                                        <th style="padding: 5px; text-align: left;">Time Detected</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${data.triggers.map(t => `
                                        <tr>
                                            <td style="padding: 5px;">${t.era}</td>
                                            <td style="padding: 5px;">${t.prevCommission.toFixed(2)}%</td>
                                            <td style="padding: 5px; color: #ff6b6b; font-weight: bold;">${t.newCommission.toFixed(2)}%</td>
                                            <td style="padding: 5px;">${stakingEscapeHtml(formatLocalDateTime(t.timestamp))}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    `;
                }

                commissionWarning = `
                    <div style="background: rgba(255, 50, 50, 0.1); border: 1px solid rgba(255, 50, 50, 0.3); padding: 15px; border-radius: 4px; margin-bottom: 20px;">
                        <div style="color: #ff6b6b; font-size: 13px; line-height: 1.5;">
                            Commission increase above threshold detected in validator network; max commission in 30 eras: ${maxComm.toFixed(2)}%; threshold: 50.00%
                            ${triggerActionHtml}
                        </div>
                        ${triggersHtml}
                    </div>
                `;
            }
        }

        let historyTableRows = '';
        data.history.forEach(h => {
            // Using a mock date for display purposes if not indexed properly, or calculate backwards from today
            // We'll just display Era number.
            historyTableRows += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 12px 10px;">${h.era}</td>
                    <td style="padding: 12px 10px;">${h.commission.toFixed(2)}%</td>
                    <td style="padding: 12px 10px;">${(h.stake / 1000).toFixed(4)} kPDEX</td>
                    <td style="padding: 12px 10px;">${h.apy.toFixed(2)}%</td>
                </tr>
            `;
        });

        if (data.history.length === 0) {
            historyTableRows = '<tr><td colspan="4" style="padding: 20px; text-align: center; color: var(--text-secondary);">Syncing historical eras. Check back later!</td></tr>';
        }

        container.innerHTML = `
            <div class="list-header" style="border-bottom: 1px solid var(--border-color); padding: 20px; display: flex; justify-content: space-between; align-items: center;">
                <h2 style="font-size: 18px;">Validator history - ${identityStr} ${watchlistStarButton('validator', data.address, (data.identity && data.identity !== 'Unknown') ? data.identity : data.address)}</h2>
                <a href="#" data-close-detail="validators" style="color: var(--text-secondary); text-decoration: none; cursor: pointer;" title="Close" aria-label="Close"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
            
            <div style="padding: 20px;">
                <div style="margin-bottom: 15px;">
                    <strong>Validator:</strong> ${identityStr}
                </div>
                
                ${commissionWarning}
                
                <div style="margin-bottom: 15px;" data-address="${stakingEscapeHtml(data.address)}">
                    <strong style="display: block; margin-bottom: 5px;">Address:</strong>
                    <span class="address-cell">${stakingEscapeHtml(data.address)}</span> <span class="js-copy-address" style="cursor: pointer; color: var(--brand-secondary); font-size: 13px; margin-left: 10px;">copy</span>
                </div>
                <div style="margin-bottom: 25px;" data-address="${stakingEscapeHtml(data.controller)}">
                    <strong style="display: block; margin-bottom: 5px;">Controller account:</strong>
                    <span class="address-cell">${stakingEscapeHtml(data.controller)}</span> <span class="js-copy-address" style="cursor: pointer; color: var(--brand-secondary); font-size: 13px; margin-left: 10px;">copy</span>
                </div>

                ${renderValidatorScorecard(data.scorecard)}

                <div style="margin-bottom: 25px;">
                    <h3 style="font-size: 14px; margin-bottom: 10px;">Commission trend (30 eras)</h3>
                    <div style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); border-radius: 4px; padding: 15px; height: 250px;">
                        <canvas id="validatorChartCanvas"></canvas>
                    </div>
                </div>

                <div>
                    <h3 style="font-size: 14px; margin-bottom: 10px;">Historical data</h3>
                    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
                        <thead>
                            <tr style="background: rgba(255,255,255,0.02); border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <th style="padding: 12px 10px; font-weight: 600;">Era</th>
                                <th style="padding: 12px 10px; font-weight: 600;">Commission</th>
                                <th style="padding: 12px 10px; font-weight: 600;">Stake PDEX</th>
                                <th style="padding: 12px 10px; font-weight: 600;">APY</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${historyTableRows}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // Audit F-122: copy bound via listener + escaped data-address, not an
        // inline onclick holding a raw string in a JS-in-HTML context.
        container.querySelectorAll('.js-copy-address').forEach(el => {
            el.addEventListener('click', function () {
                const holder = this.closest('[data-address]');
                if (holder) copyToClipboard(this, holder.getAttribute('data-address'));
            });
        });

        const triggerToggle = document.getElementById('toggle-trigger-events');
        const triggerLog = document.getElementById('trigger-events-log');
        if (triggerToggle && triggerLog) {
            triggerToggle.addEventListener('click', () => {
                const shouldShow = triggerLog.style.display === 'none';
                triggerLog.style.display = shouldShow ? 'block' : 'none';
                triggerToggle.innerText = shouldShow ? 'hide trigger events' : 'go to trigger events';
                if (shouldShow) triggerLog.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        }

        // Render Chart.js
        if (data.history.length > 0) {
            const ctx = document.getElementById('validatorChartCanvas');
            if (ctx) {
                // Reverse to chronological order for chart
                const chronHistory = [...data.history].reverse();
                const labels = chronHistory.map(h => `Era ${h.era}`);
                const commissions = chronHistory.map(h => h.commission);
                const apys = chronHistory.map(h => h.apy);

                if (validatorChart) validatorChart.destroy();

                validatorChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: 'Commission (%)',
                                data: commissions,
                                borderColor: '#ff6b6b',
                                backgroundColor: '#ff6b6b',
                                tension: 0.1,
                                borderWidth: 2,
                                pointRadius: 0
                            },
                            {
                                label: 'APY (%)',
                                data: apys,
                                borderColor: '#4d88ff',
                                backgroundColor: '#4d88ff',
                                tension: 0.1,
                                borderWidth: 2,
                                pointRadius: 0
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: {
                            mode: 'index',
                            intersect: false,
                        },
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: { color: '#ccc', font: { family: 'Inter', size: 12 } }
                            }
                        },
                        scales: {
                            x: {
                                ticks: { maxTicksLimit: 5, color: '#888' },
                                grid: { color: 'rgba(255,255,255,0.05)' }
                            },
                            y: {
                                ticks: {
                                    callback: function (value) { return value + '%'; },
                                    color: '#888'
                                },
                                grid: { color: 'rgba(255,255,255,0.05)' }
                            }
                        }
                    }
                });
            }
        }

    } catch (e) {
        renderApiError(container, e, () => fetchValidatorDetails(address));
    }
}

// --- Shared wallet / staking-rewards helpers ---
let stakingRewardsData = null;
let stakingRewardsChart = null;
// (Legacy `stakingRewardsDisplayLimit` removed — pagination now lives inside
// makeTable via the `pagination` config on the staking-rewards table.)
let stakingRewardFilter = 'all';
let stakingUnclaimedPolls = 0;
let walletPriceChart = null;
const WALLET_STORAGE_KEY = 'pdex_wallet_address';

// ─── /email/preferences ─────────────────────────────────────────────────────
//
// Audit F-066. This route had no page: index.html carried no matching
// `data-page`, so routeTo() matched nothing and every section stayed hidden —
// a blank pane, which reads as "the site is broken" rather than as a 404. The
// API routes existed the whole time; only the surface was missing.
//
// Three things about this page are load-bearing:
//
//  1. THE TOKEN IS THE CREDENTIAL. `?token=` is the same unsubscribe token the
//     alert emails carry. There is no login. So the page is noindex (see
//     ROUTE_SEO), robots-Disallowed, and never renders the token back into the
//     DOM or into a shareable link.
//
//  2. THE POST MUST SEND THE WHOLE OBJECT. normalizePrefs() on the server
//     merges the submitted prefs into DEFAULT_EMAIL_PREFS — not into the
//     subscriber's stored prefs. Anything omitted is therefore RESET, not left
//     alone. The subscribe modal only ever sends {governance, network}, which
//     is survivable there because it runs at signup when nothing else is set.
//     Here it would silently wipe `account.*` and `cadence`. So we keep the
//     full object the GET returned and only overwrite the checkbox fields.
//
//  3. THE LABELS MUST MATCH THE MODAL. Two vocabularies for the same nine
//     toggles is how a user ends up unable to find the alert they want to turn
//     off. EMAIL_PREF_GROUPS below is the single source; the modal should be
//     migrated onto it too.

const EMAIL_PREF_GROUPS = [
    {
        legend: 'Governance',
        items: [
            { path: 'governance.newReferendum',    label: 'New referendum opens for voting' },
            { path: 'governance.newProposal',      label: 'New public proposal tabled' },
            { path: 'governance.closingReminder',  label: '24-hour reminder before a referendum closes' },
            { path: 'governance.referendumResult', label: 'Referendum result (passed / failed)' },
            { path: 'governance.treasuryProposal', label: 'Treasury proposal activity' },
            { path: 'governance.councilMotion',    label: 'Council motion activity' }
        ]
    },
    {
        legend: 'Network milestones',
        items: [
            { path: 'network.runtimeUpgrade', label: 'Runtime upgrade' },
            { path: 'network.eraBoundary',    label: 'Era boundary summary' },
            { path: 'network.chainStalled',   label: 'Chain stalled alert (ops)' }
        ]
    }
];

// The prefs object last loaded from the server. Kept whole so the POST can
// send back everything it does not manage — see note 2 above.
let emailPrefsLoaded = null;

function emailPrefsCard(inner) {
    return `<div class="cs-hero"><h1>Email alert preferences</h1></div>
            <div class="cs-panel glass" style="max-width:640px;">${inner}</div>`;
}

async function renderEmailPreferencesPage() {
    const box = document.getElementById('email-prefs-content');
    if (!box) return;

    // Read the token from the URL, never from the route token — navigateTo()
    // drops the query string, and routeTo() strips it before matching.
    let token = '';
    try { token = (new URLSearchParams(window.location.search || '')).get('token') || ''; }
    catch (_) { token = ''; }

    if (!token) {
        box.innerHTML = emailPrefsCard(
            `<p style="color:var(--text-secondary);line-height:1.6;margin:0;">This page needs the personal link from one of your alert emails. Open the most recent one and click <strong>Manage preferences</strong>.</p>`
        );
        return;
    }

    box.innerHTML = emailPrefsCard(`<p style="color:var(--text-secondary);margin:0;">Loading your preferences…</p>`);

    let data;
    try {
        const res = await fetch(`/api/email/preferences?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (res.status === 404) {
            box.innerHTML = emailPrefsCard(
                `<p style="color:var(--text-secondary);line-height:1.6;margin:0;">This preferences link is not recognised. It may have been superseded, or the URL was cut short in transit — email clients sometimes wrap long links. Try opening it from a newer alert email.</p>`
            );
            return;
        }
        data = await parseJsonResponse(res);
        if (data.error) throw new Error(data.error);
    } catch (e) {
        box.innerHTML = emailPrefsCard(
            `<p class="staking-error" style="margin:0;display:block;">Could not load your preferences: ${stakingEscapeHtml(e.message)}</p>`
        );
        return;
    }

    emailPrefsLoaded = (data && typeof data.prefs === 'object' && data.prefs) ? data.prefs : {};

    // `eventPrefs` is raw stored JSON — rows written before a preference
    // existed simply lack the key. Read through a default so an absent key
    // renders unchecked rather than as undefined.
    const isOn = (path) => {
        const [section, key] = path.split('.');
        const group = emailPrefsLoaded[section];
        return !!(group && group[key]);
    };

    const fields = EMAIL_PREF_GROUPS.map(group => `
        <fieldset style="border:0;padding:0;margin:0 0 18px;">
            <legend style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary);padding:0;margin-bottom:8px;">${stakingEscapeHtml(group.legend)}</legend>
            ${group.items.map(item => `
                <label class="email-pref">
                    <input type="checkbox" data-pref-path="${stakingEscapeHtml(item.path)}"${isOn(item.path) ? ' checked' : ''}>
                    ${stakingEscapeHtml(item.label)}
                </label>`).join('')}
        </fieldset>`).join('');

    const unsubscribed = !!data.unsubscribed;

    box.innerHTML = emailPrefsCard(`
        <p style="color:var(--text-secondary);line-height:1.6;margin:0 0 4px;">Alerts for <strong style="color:var(--text-primary);">${stakingEscapeHtml(data.email || '')}</strong></p>
        ${unsubscribed
            ? `<p class="cs-warn" style="margin:0 0 16px;">You are currently unsubscribed, so none of these will be sent. Saving your choices here does not resubscribe you.</p>`
            : `<p style="color:var(--text-secondary);font-size:0.85rem;margin:0 0 18px;">Untick anything you would rather not receive. Changes save immediately.</p>`}
        <form id="email-prefs-form">
            ${fields}
            <div class="cs-actions" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <button type="submit" id="email-prefs-save" class="wallet-action-btn primary">Save preferences</button>
                <span id="email-prefs-status" class="cs-status"></span>
            </div>
            <div id="email-prefs-error" class="staking-error" style="display:none;"></div>
        </form>
        <hr style="border:none;border-top:1px solid var(--border-color);margin:22px 0 16px;">
        <p style="color:var(--text-secondary);font-size:0.82rem;line-height:1.6;margin:0;">
            Want to stop everything instead? Use the <strong>Unsubscribe</strong> link at the bottom of any alert email.
        </p>
    `);

    wireEmailPreferencesForm(token);
}

function wireEmailPreferencesForm(token) {
    const form = document.getElementById('email-prefs-form');
    if (!form) return;
    const btn = document.getElementById('email-prefs-save');
    const statusEl = document.getElementById('email-prefs-status');
    const errEl = document.getElementById('email-prefs-error');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        if (statusEl) statusEl.textContent = 'Saving…';
        if (btn) btn.disabled = true;

        // Start from everything the server gave us, so keys this page does not
        // render (account.*, cadence) survive the round trip. See note 2 in
        // renderEmailPreferencesPage.
        const prefs = JSON.parse(JSON.stringify(emailPrefsLoaded || {}));
        form.querySelectorAll('input[type="checkbox"][data-pref-path]').forEach(cb => {
            const [section, key] = (cb.getAttribute('data-pref-path') || '').split('.');
            if (!section || !key) return;
            if (!prefs[section] || typeof prefs[section] !== 'object') prefs[section] = {};
            prefs[section][key] = !!cb.checked;
        });

        try {
            const res = await fetch('/api/email/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, prefs })
            });
            const data = await parseJsonResponse(res);
            if (!res.ok || data.error) throw new Error(data.error || `Save failed (${res.status})`);
            // Adopt the server's normalized copy — it is the authority on what
            // was actually stored, and re-reading it keeps a second save from
            // being built on our optimistic guess.
            if (data.prefs && typeof data.prefs === 'object') emailPrefsLoaded = data.prefs;
            if (statusEl) {
                statusEl.innerHTML = '<span class="cs-count">Saved</span>';
                setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
            }
        } catch (err) {
            if (statusEl) statusEl.textContent = '';
            if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

function stakingEscapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ─── Local-timezone date helpers ────────────────────────────────────────────
// All chain timestamps land on the frontend as JS numbers (ms since epoch) in
// UTC. The historical convention in this codebase was to render them as
// "2026-06-09 14:30:45 UTC" via toISOString, which is unambiguous but forces
// every user to do timezone math in their head. These helpers render the
// SAME instant in the browser's local timezone with the IANA short name
// appended ("2026-06-09 07:30:45 PDT") so the value is both readable AND
// unambiguous. Use formatLocalDateTime for any user-facing display and
// formatLocalDate for date-only contexts (e.g. chart axis labels, wallet
// recent-rewards rows). CSV / JSON exports and SEO meta strings deliberately
// stay in UTC — they're machine-readable, not user display.
function formatLocalDateTime(ts) {
    if (ts == null || ts === '') return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timePart = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    // Append the timezone abbreviation so two users in different zones can
    // still talk about the same row without ambiguity. Wrapped in try/catch
    // because Intl.DateTimeFormat with timeZoneName is unavailable on a few
    // very old browsers — in that case we just drop the suffix.
    let tz = '';
    try {
        const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(d);
        const tzPart = parts.find(p => p.type === 'timeZoneName');
        if (tzPart && tzPart.value) tz = ' ' + tzPart.value;
    } catch (_) { /* fallback: omit tz */ }
    return `${datePart} ${timePart}${tz}`;
}
function formatLocalDate(ts) {
    if (ts == null || ts === '') return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function stakingShortAddress(addr) {
    if (!addr || addr.length < 18) return addr || '';
    return addr.substring(0, 8) + '…' + addr.substring(addr.length - 6);
}
function stakingFormatPDEX(value) {
    return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
function stakingFormatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
}
// isValidPolkadexAddress is imported from ./lib/wallet-safety.js (audit
// F-012 — rejects 0x hashes and out-of-range lengths). Kept out of this file
// so it is unit-testable; see test/wallet-safety.test.js.
// Compare two SS58 addresses by their underlying public key bytes. Wallet
// extensions often hand back addresses in the generic Substrate format
// (prefix 42) while the backend normalizes them to Polkadex's prefix 88,
// so a raw string comparison incorrectly says they differ.
function isSameAddress(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
        const ax = decodeAddress(a);
        const bx = decodeAddress(b);
        if (ax.length !== bx.length) return false;
        for (let i = 0; i < ax.length; i++) if (ax[i] !== bx[i]) return false;
        return true;
    } catch (e) { return false; }
}
function formatDuration(ms) {
    if (!ms || ms <= 0) return '—';
    const hours = ms / 3600000;
    if (hours < 48) return (Math.round(hours * 10) / 10) + ' hours';
    return (Math.round(hours / 24 * 10) / 10) + ' days';
}
function stakingCsvCell(value) {
    const s = String(value == null ? '' : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadStakingBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Staking Rewards Page ---
async function loadStakingIndexStatus() {
    const el = document.getElementById('staking-index-status');
    if (!el) return;
    try {
        const res = await fetch('/api/staking-rewards-status');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (!data.backfillComplete) {
            // Only surface the indexer state while it's still doing real work
            // (backfill in progress). Once backfill is complete the user
            // doesn't need to see operator chatter — match the convention used
            // everywhere else in the explorer (governance, treasury, council).
            el.innerHTML = `<div class="gov-index-note" style="margin-top: 10px;"><i class='bx bx-loader-alt bx-spin'></i> Indexing past staking rewards from chain history — scanned back to block ${stakingFormatNumber(data.oldestScannedBlock)}. Older staking rewards will keep appearing as the crawl progresses.</div>`;
        } else {
            el.innerHTML = '';
        }
    } catch (e) {
        // Status endpoint unreachable — stay silent rather than showing an
        // operator-facing error to a user who has no way to act on it.
        el.innerHTML = '';
    }
}

function initStakingRewardsPage(address) {
    loadStakingIndexStatus();
    const input = document.getElementById('staking-address-input');
    const errEl = document.getElementById('staking-rewards-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (address) {
        if (input) input.value = address;
        fetchStakingRewards(address);
    }
}

function submitStakingSearch() {
    const input = document.getElementById('staking-address-input');
    const errEl = document.getElementById('staking-rewards-error');
    if (!input) return;
    const addr = input.value.trim();
    if (!addr) {
        if (errEl) { errEl.textContent = 'Please enter a Polkadex wallet address.'; errEl.style.display = 'block'; }
        return;
    }
    if (!isValidPolkadexAddress(addr)) {
        if (errEl) { errEl.textContent = 'That does not look like a valid Polkadex wallet address.'; errEl.style.display = 'block'; }
        return;
    }
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    navigateTo('staking-rewards/' + addr);
}

async function fetchStakingRewards(address, isPoll) {
    const resultsEl = document.getElementById('staking-rewards-results');
    const errEl = document.getElementById('staking-rewards-error');
    if (!resultsEl) return;
    if (errEl && !isPoll) { errEl.style.display = 'none'; errEl.textContent = ''; }

    if (!isValidPolkadexAddress(address)) {
        if (errEl) { errEl.textContent = 'That does not look like a valid Polkadex wallet address.'; errEl.style.display = 'block'; }
        resultsEl.style.display = 'none';
        return;
    }

    if (!isPoll) {
        stakingRewardFilter = 'all';
        stakingUnclaimedPolls = 0;
        resultsEl.style.display = 'block';
        resultsEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-secondary);">Loading staking rewards…</div>';
    }

    try {
        const res = await fetch('/api/staking-rewards/' + encodeURIComponent(address));
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        stakingRewardsData = data;
        renderStakingRewards(data);
        // Unpaid rewards are computed in the background; poll until they are ready.
        if (data.unclaimedComputing && stakingUnclaimedPolls < 12) {
            stakingUnclaimedPolls++;
            setTimeout(() => {
                if (stakingRewardsData && stakingRewardsData.address === data.address) fetchStakingRewards(address, true);
            }, 6000);
        }
    } catch (e) {
        if (!isPoll) {
            stakingRewardsData = null;
            resultsEl.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
        }
    }
}

// Merge claimed + unclaimed reward records according to the active filter.
function getFilteredRewards(data, filter) {
    const claimed = (data.claimed || []).map(r => ({ ...r, status: 'claimed' }));
    const unclaimed = (data.unclaimed || []).map(r => ({ ...r, status: 'unclaimed' }));
    let list;
    if (filter === 'claimed') list = claimed.slice();
    else if (filter === 'unclaimed') list = unclaimed.slice();
    else list = claimed.concat(unclaimed);
    list.sort((a, b) => {
        const ea = a.era == null ? -Infinity : a.era;
        const eb = b.era == null ? -Infinity : b.era;
        if (eb !== ea) return eb - ea;
        return (b.block || 0) - (a.block || 0);
    });
    return list;
}

// ─── Wallet-dashboard APR card with period selector ─────────────────────────
// Mirrors the server's computeRealizedApr formula so we can recompute APR
// client-side for any user-chosen window without a new round trip. The
// server provides apr30d/apr90d/aprAll precomputed; we use those directly
// when the window matches and compute fresh for the other periods (7/180/365).
const WALLET_APR_PERIODS = [
    { days: 7,   label: '7d'  },
    { days: 30,  label: '30d' },
    { days: 90,  label: '90d' },
    { days: 180, label: '6m'  },
    { days: 365, label: '1y'  },
    { days: 0,   label: 'All-time' } // 0 = unbounded
];

function computeWalletApr(claimed, bondedAmount, nowTs, windowDays) {
    if (!bondedAmount || bondedAmount <= 0) return null;
    if (!Array.isArray(claimed) || !claimed.length) return null;
    const cutoff = windowDays ? (nowTs - windowDays * 86400000) : 0;
    const inWindow = claimed.filter(r => r && r.timestamp && r.timestamp >= cutoff);
    if (!inWindow.length) return null;
    const totalRewards = inWindow.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const oldest = Math.min(...inWindow.map(r => Number(r.timestamp) || nowTs));
    const spanMs = Math.max(86400000, nowTs - oldest); // floor at 1 day
    const spanDays = spanMs / 86400000;
    return {
        apr: ((totalRewards / spanDays) * 365 / bondedAmount) * 100,
        rewards: totalRewards,
        spanDays,
        rewardCount: inWindow.length
    };
}

function renderWalletAprCard() {
    const periodsHost = document.getElementById('wallet-apr-periods');
    const body = document.getElementById('wallet-apr-body');
    if (!periodsHost || !body) return;

    // Always paint the pill row first so the user sees the affordance even
    // when data is still loading or the rewards endpoint failed.
    periodsHost.innerHTML = WALLET_APR_PERIODS.map(p =>
        `<button type="button" class="reward-filter-btn${walletAprDays === p.days ? ' active' : ''}" data-apr-days="${p.days}">${p.label}</button>`
    ).join('');
    periodsHost.querySelectorAll('[data-apr-days]').forEach(btn => {
        btn.addEventListener('click', () => {
            const d = parseInt(btn.getAttribute('data-apr-days'), 10);
            if (Number.isFinite(d) && d >= 0) {
                walletAprDays = d;
                renderWalletAprCard();
            }
        });
    });

    // No payload yet (fetch failed / RPC down).
    if (!walletAprData) {
        body.innerHTML = `
            <div style="text-align:center;color:var(--text-muted);font-size:0.88rem;padding:24px 0;">
                <i class='bx bx-loader-alt bx-spin' style="font-size:24px;color:var(--brand-primary);"></i>
                <div style="margin-top:8px;">Couldn't load reward history. Refresh the page to retry.</div>
            </div>`;
        return;
    }

    const apr = walletAprData.apr || {};
    const bondedAmount = Number(apr.bondedAmount) || 0;
    const claimed = Array.isArray(walletAprData.claimed) ? walletAprData.claimed : [];

    // No bonded stake — APR is undefined regardless of the period chosen.
    if (!bondedAmount) {
        body.innerHTML = `
            <div style="text-align:center;color:var(--text-muted);font-size:0.9rem;padding:24px 0;">
                <i class='bx bx-info-circle' style="font-size:28px;color:var(--text-muted);"></i>
                <div style="margin-top:10px;">No bonded stake on this account.</div>
                <div style="margin-top:4px;font-size:0.78rem;">Stake some PDEX to start earning rewards and measure APR.</div>
            </div>`;
        return;
    }

    // For windows the server already precomputed (30/90/all), prefer the
    // server's value so users see a single canonical number across the
    // /wallet and /staking-rewards pages. For 7/180/365 we compute client-
    // side using the same formula.
    let aprPct, rewards = null, spanDays = null, rewardCount = 0;
    const nowTs = Date.now();
    if (walletAprDays === 30 && apr.apr30d != null) {
        aprPct = apr.apr30d;
        const computed = computeWalletApr(claimed, bondedAmount, nowTs, 30);
        if (computed) { rewards = computed.rewards; spanDays = computed.spanDays; rewardCount = computed.rewardCount; }
    } else if (walletAprDays === 90 && apr.apr90d != null) {
        aprPct = apr.apr90d;
        const computed = computeWalletApr(claimed, bondedAmount, nowTs, 90);
        if (computed) { rewards = computed.rewards; spanDays = computed.spanDays; rewardCount = computed.rewardCount; }
    } else if (walletAprDays === 0 && apr.aprAll != null) {
        aprPct = apr.aprAll;
        const computed = computeWalletApr(claimed, bondedAmount, nowTs, 0);
        if (computed) { rewards = computed.rewards; spanDays = computed.spanDays; rewardCount = computed.rewardCount; }
    } else {
        const computed = computeWalletApr(claimed, bondedAmount, nowTs, walletAprDays);
        if (computed) {
            aprPct = computed.apr;
            rewards = computed.rewards;
            spanDays = computed.spanDays;
            rewardCount = computed.rewardCount;
        }
    }

    const periodLabel = (WALLET_APR_PERIODS.find(p => p.days === walletAprDays) || {}).label || `${walletAprDays}d`;

    // No rewards in window → tell the user explicitly which window we
    // looked at, so they know to pick a longer one.
    if (aprPct == null || !Number.isFinite(aprPct)) {
        body.innerHTML = `
            <div style="text-align:center;color:var(--text-muted);font-size:0.9rem;padding:24px 0;">
                <i class='bx bx-info-circle' style="font-size:28px;color:var(--text-muted);"></i>
                <div style="margin-top:10px;">No claimed rewards in the last ${stakingEscapeHtml(periodLabel)} window.</div>
                <div style="margin-top:4px;font-size:0.78rem;">Pick a longer period above, or pay out unclaimed rewards from the action bar.</div>
            </div>`;
        return;
    }

    const spanSentence = spanDays != null
        ? `over ${Math.round(spanDays)} day${Math.round(spanDays) === 1 ? '' : 's'} of activity`
        : '';
    const rewardSentence = rewards != null
        ? `${stakingFormatPDEX(rewards)} PDEX rewarded (${stakingFormatNumber(rewardCount)} payout${rewardCount === 1 ? '' : 's'})`
        : '';
    const bondedSentence = `${stakingFormatPDEX(bondedAmount)} PDEX bonded`;

    body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
            <div style="font-size:0.78rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">${stakingEscapeHtml(periodLabel)} average</div>
            <div style="font-size:2.8rem;font-weight:700;color:var(--brand-primary);line-height:1;">${aprPct.toFixed(2)}<span style="font-size:1.4rem;color:var(--text-secondary);">%</span></div>
            <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:6px;text-align:center;">
                ${spanSentence ? stakingEscapeHtml(spanSentence) + ' · ' : ''}${stakingEscapeHtml(rewardSentence)}<br>
                <span style="color:var(--text-muted);font-size:0.78rem;">${stakingEscapeHtml(bondedSentence)}</span>
            </div>
        </div>`;
}

// Render the APR summary card for the staking-rewards page. Headline is the
// 30-day realized APR (most-common reference window); the subtitle adds the
// 90-day and all-time numbers alongside the current bonded amount so users
// can sanity-check that the % is being computed against the stake they
// expect. Distinct empty states for each failure mode (no RPC, no stake,
// no recent rewards) so a dash never appears without an explanation.
function renderStakingAprCard(apr) {
    // RPC-unreachable case — apr.bondedAmount is null because we couldn't
    // query staking.bonded. Showing the card with "—" plus a hint that the
    // bonded read failed is better than hiding it (the user might wonder
    // why APR is missing).
    if (!apr || apr.bondedAmount == null) {
        return `<div class="staking-summary-card">
            <div class="label">APR (30-day)</div>
            <div class="value" style="color:var(--text-muted);">—</div>
            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">bonded stake unavailable</div>
        </div>`;
    }
    // User has no bonded stake — the denominator is zero, so APR is
    // mathematically undefined. Tell them that explicitly.
    if (!apr.bondedAmount || Number(apr.bondedAmount) <= 0) {
        return `<div class="staking-summary-card">
            <div class="label">APR (30-day)</div>
            <div class="value" style="color:var(--text-muted);">—</div>
            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">no bonded stake to measure</div>
        </div>`;
    }
    const fmtPct = v => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(2) + '%';
    const headline = fmtPct(apr.apr30d);
    // Subtitle layout: "90d 4.45% · all 4.32% · 5,000 PDEX bonded"
    // Each component omitted when null/zero so the line stays clean for
    // accounts with sparse history.
    const subParts = [];
    if (apr.apr90d != null && Number.isFinite(apr.apr90d)) subParts.push('90d ' + fmtPct(apr.apr90d));
    if (apr.aprAll != null && Number.isFinite(apr.aprAll)) subParts.push('all ' + fmtPct(apr.aprAll));
    subParts.push(stakingFormatPDEX(apr.bondedAmount) + ' PDEX bonded');
    // If 30d is unavailable but longer windows exist, surface the longest
    // available number in the headline so the card isn't a useless dash.
    let headlineNote = '';
    let displayedHeadline = headline;
    if (apr.apr30d == null) {
        if (apr.apr90d != null) { displayedHeadline = fmtPct(apr.apr90d); headlineNote = ' (90d)'; }
        else if (apr.aprAll != null) { displayedHeadline = fmtPct(apr.aprAll); headlineNote = ' (all)'; }
    }
    return `<div class="staking-summary-card">
        <div class="label">APR${headlineNote || ' (30-day)'}</div>
        <div class="value accent">${displayedHeadline}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">${stakingEscapeHtml(subParts.join(' · '))}</div>
    </div>`;
}

function renderStakingRewards(data) {
    const resultsEl = document.getElementById('staking-rewards-results');
    if (!resultsEl) return;
    const summary = data.summary || {};
    const index = data.index || {};
    const identity = data.identity && data.identity !== 'Unknown' ? data.identity : null;
    const claimedCount = (data.claimed || []).length;
    const unclaimedCount = (data.unclaimed || []).length;

    if (claimedCount === 0 && unclaimedCount === 0) {
        const note = data.unclaimedComputing
            ? 'Unpaid rewards are still being computed — this can take a moment.'
            : (index.backfillComplete
                ? `No staking rewards were found for <span style="color: var(--brand-secondary);">${stakingEscapeHtml(stakingShortAddress(data.address))}</span>.`
                : 'The indexer is still backfilling older history — check back shortly.');
                
        const title = data.unclaimedComputing 
            ? 'Computing Rewards' 
            : (index.backfillComplete ? 'No Staking Rewards' : 'Coming Soon');

        const iconHtml = (data.unclaimedComputing || !index.backfillComplete) 
            ? `<i class='bx bx-time-five' style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;"></i>` 
            : '';

        resultsEl.innerHTML = `
            <div style="padding: 40px; text-align: center; color: var(--text-secondary);">
                ${iconHtml}
                <h3>${title}</h3>
                <p>${note}</p>
            </div>`;
        return;
    }

    const rewards = getFilteredRewards(data, stakingRewardFilter);
    const fbtn = (key, label) => `<button class="reward-filter-btn${stakingRewardFilter === key ? ' active' : ''}" data-filter="${key}">${label}</button>`;
    const computingNote = data.unclaimedComputing
        ? '<div style="padding: 0 24px 14px; color: var(--text-muted); font-size: 0.78rem;">Unpaid rewards are being computed in the background and will appear shortly.</div>'
        : '';

    // The pill row above already coarse-filters to all/claimed/unpaid; the
    // makeTable instance below adds sortable headers + per-column filters
    // (e.g. validator address, era/amount/block search via global search) on
    // top of that pre-filtered set. We rebuild the whole shell each render
    // since the surrounding summary cards + chart need to refresh too;
    // makeTable is cheap to re-instantiate.
    resultsEl.innerHTML = `
        <div class="list-header">
            <h2>Reward history${identity ? ' — ' + stakingEscapeHtml(identity) : ''}</h2>
            <div style="display:flex;align-items:center;gap:14px;">
                <a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color: var(--text-secondary); font-size: 0.78rem;">${stakingEscapeHtml(data.address)}</a>
                <!-- Close button — returns the user to wherever they
                     navigated in from. Same X-icon pattern as the block /
                     tx / validator detail pages so the affordance is
                     familiar. The click handler below prefers history.back
                     (so users from /wallet/:addr and from /account/:addr
                     both go back to the right place) and falls back to
                     /account/:addr for the fresh-tab case. -->
                <a href="#" data-close-detail="account/${encodeURIComponent(data.address)}" title="Close" aria-label="Close" style="color: var(--text-secondary); text-decoration: none; cursor: pointer; line-height: 1; display: inline-flex; align-items: center;"><i class='bx bx-x' style="font-size: 24px;"></i></a>
            </div>
        </div>
        <div class="staking-summary-grid">
            <div class="staking-summary-card"><div class="label">Claimed Rewards</div><div class="value accent">${stakingFormatPDEX(summary.claimedTotal)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Unpaid Rewards</div><div class="value" style="color: var(--brand-primary);">${stakingFormatPDEX(summary.unclaimedTotal)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Total Rewards</div><div class="value">${stakingFormatPDEX(summary.totalAmount)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Claimed Payouts</div><div class="value">${stakingFormatNumber(summary.claimedCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Eras</div><div class="value">${stakingFormatNumber(summary.eraCount)}</div></div>
            ${renderStakingAprCard(data.apr)}
        </div>
        <div class="staking-chart-wrap"><canvas id="staking-rewards-chart"></canvas></div>
        ${computingNote}
        <div class="staking-toolbar">
            <div class="reward-filter">${fbtn('all', 'All')}${fbtn('claimed', 'Claimed')}${fbtn('unclaimed', 'Unpaid')}</div>
            <div class="staking-toolbar-actions">
                <button class="staking-download-btn" id="staking-dl-csv"><i class='bx bx-download'></i> CSV</button>
                <button class="staking-download-btn" id="staking-dl-json"><i class='bx bx-download'></i> JSON</button>
                <button class="staking-download-btn" id="staking-dl-tax" title="Annual rewards summary with PDEX→USD price at era close"><i class='bx bx-receipt'></i> Tax (year…)</button>
            </div>
        </div>
        <div id="staking-rewards-table-container"></div>`;

    makeTable({
        container: document.getElementById('staking-rewards-table-container'),
        rows: rewards,
        defaultSort: { key: 'era', dir: 'desc' },
        globalSearch: true,
        summarySuffix: 'rewards',
        emptyMessage: 'No rewards match this filter.',
        // 50/page; expand cumulatively via "Show more" up to 200, then switch
        // to numbered pagination so long-running validators with thousands
        // of payouts stay navigable.
        pagination: { pageSize: 50, showMoreMax: 200 },
        columns: [
            {
                key: 'era', label: 'Era', searchable: true,
                sort: (a, b) => (a.era == null ? -1 : a.era) - (b.era == null ? -1 : b.era),
                format: row => row.era != null ? String(row.era) : '<span style="color:var(--text-muted);">—</span>'
            },
            {
                key: 'timestamp', label: 'Date',
                sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                format: row => row.timestamp ? `<span style="white-space:nowrap;">${stakingEscapeHtml(formatLocalDateTime(row.timestamp))}</span>` : '<span style="color:var(--text-muted);">—</span>'
            },
            {
                key: 'amount', label: 'Amount',
                sort: (a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0),
                format: row => `<span class="staking-amount">${stakingFormatPDEX(row.amount)} PDEX</span>`
            },
            {
                key: 'status', label: 'Status',
                sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
                format: row => row.status === 'claimed'
                    ? '<span class="reward-badge claimed">Claimed</span>'
                    : '<span class="reward-badge unclaimed">Unpaid</span>'
            },
            {
                key: 'validator', label: 'Validator', searchable: true,
                sort: (a, b) => String(a.validator || '').localeCompare(String(b.validator || '')),
                filter: { type: 'text', placeholder: 'Validator address…' },
                format: row => row.validator
                    ? `<a href="/validator/${encodeURIComponent(row.validator)}" class="item-link" style="color: var(--brand-secondary);">${stakingShortAddress(row.validator)}</a>`
                    : '<span style="color: var(--text-muted);">—</span>'
            },
            {
                key: 'block', label: 'Block', searchable: true,
                sort: (a, b) => (a.block || 0) - (b.block || 0),
                format: row => row.block != null
                    ? `<a href="/block/${row.block}" class="item-link" style="color: var(--brand-secondary);">${stakingFormatNumber(row.block)}</a>`
                    : '<span style="color: var(--text-muted);">—</span>'
            }
        ]
    });

    resultsEl.querySelectorAll('.reward-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            stakingRewardFilter = btn.getAttribute('data-filter');
            // makeTable owns pagination state now; switching the All/Claimed/
            // Unpaid pill triggers a full re-render which constructs a fresh
            // makeTable instance, so its internal page counter starts at 1.
            renderStakingRewards(stakingRewardsData);
        });
    });
    const csvBtn = document.getElementById('staking-dl-csv');
    if (csvBtn) csvBtn.addEventListener('click', downloadStakingRewardsCSV);
    const jsonBtn = document.getElementById('staking-dl-json');
    if (jsonBtn) jsonBtn.addEventListener('click', downloadStakingRewardsJSON);
    const taxBtn = document.getElementById('staking-dl-tax');
    if (taxBtn) taxBtn.addEventListener('click', downloadStakingRewardsTaxCSV);
    // (The X-icon close button uses data-close-detail — wired by the
    // global delegate in wireCloseDetailButtons, so no per-page handler
    // is needed here.)
    // The old client-side pagination "Show more" button is no longer needed —
    // makeTable shows all rows by default and the user can drill in via the
    // filter bar instead.

    renderStakingRewardsChart(data);
}

function renderStakingRewardsChart(data) {
    const canvas = document.getElementById('staking-rewards-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (stakingRewardsChart) { stakingRewardsChart.destroy(); stakingRewardsChart = null; }

    const claimedByEra = new Map();
    const unclaimedByEra = new Map();
    const eraSet = new Set();
    const addTo = (map, era, amt) => {
        const key = era == null ? 'Unknown' : era;
        map.set(key, (map.get(key) || 0) + amt);
        eraSet.add(key);
    };
    (data.claimed || []).forEach(r => addTo(claimedByEra, r.era, Number(r.amount) || 0));
    (data.unclaimed || []).forEach(r => addTo(unclaimedByEra, r.era, Number(r.amount) || 0));

    const eras = [...eraSet].filter(e => e !== 'Unknown').sort((a, b) => a - b);
    if (eraSet.has('Unknown')) eras.push('Unknown');
    if (eras.length === 0) return;
    const labels = eras.map(e => e === 'Unknown' ? 'Unknown' : 'Era ' + e);

    stakingRewardsChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { label: 'Claimed', data: eras.map(e => claimedByEra.get(e) || 0), backgroundColor: 'rgba(0, 230, 118, 0.6)', borderColor: '#00E676', borderWidth: 1, borderRadius: 3 },
                { label: 'Unpaid', data: eras.map(e => unclaimedByEra.get(e) || 0), backgroundColor: 'rgba(230, 0, 122, 0.55)', borderColor: '#E6007A', borderWidth: 1, borderRadius: 3 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' PDEX' } }
            },
            scales: {
                x: { stacked: true, ticks: { maxTicksLimit: 12, color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { stacked: true, ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
            }
        }
    });
}

function downloadStakingRewardsCSV() {
    if (!stakingRewardsData) return;
    const rows = getFilteredRewards(stakingRewardsData, stakingRewardFilter);
    const lines = [['Era', 'Date (UTC)', 'Amount (PDEX)', 'Status', 'Validator', 'Block', 'Block Hash'].join(',')];
    rows.forEach(r => {
        const date = r.timestamp ? new Date(r.timestamp).toISOString().replace('T', ' ').substring(0, 19) : '';
        lines.push([
            r.era != null ? r.era : '',
            date,
            Number(r.amount || 0).toFixed(6),
            r.status || '',
            r.validator || '',
            r.block != null ? r.block : '',
            r.blockHash || ''
        ].map(stakingCsvCell).join(','));
    });
    downloadStakingBlob(`staking-rewards-${stakingRewardFilter}-${stakingRewardsData.address || 'address'}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function downloadStakingRewardsJSON() {
    if (!stakingRewardsData) return;
    const payload = {
        address: stakingRewardsData.address,
        identity: stakingRewardsData.identity,
        generatedAt: new Date().toISOString(),
        summary: stakingRewardsData.summary,
        index: stakingRewardsData.index,
        claimed: stakingRewardsData.claimed,
        unclaimed: stakingRewardsData.unclaimed
    };
    downloadStakingBlob(`staking-rewards-${stakingRewardsData.address || 'address'}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

// Tax-ready annual rewards CSV — joins each CLAIMED reward row with the
// PDEX→USD spot price at the era close, then emits a year-end totals row at
// the bottom. Unclaimed rewards are intentionally excluded because they
// haven't actually been received yet (a tax authority cares about realised
// income, not theoretical entitlement).
//
// Price source: the existing /api/price-history endpoint backed by the
// CoinMarketCap sync. For the v1 we round each reward's timestamp to the
// nearest indexed price sample — chains produce rewards at era boundaries
// (Polkadex eras are 24h), so even a single price-per-day suffices for
// audit-grade accuracy.
//
// The current year is selected via a `prompt()` for v1 simplicity — a
// proper modal is v2. We default to the current calendar year in the
// user's local timezone.
async function downloadStakingRewardsTaxCSV() {
    if (!stakingRewardsData) return;
    const claimed = (stakingRewardsData.claimed || []).filter(r => r.timestamp);
    if (!claimed.length) {
        alert('No claimed rewards yet — nothing to export for tax.');
        return;
    }
    // Bracket of years actually present in the data, so the prompt suggests
    // a year the user can actually export.
    const yearsPresent = Array.from(new Set(claimed.map(r => new Date(r.timestamp).getFullYear()))).sort();
    const defaultYear = String(yearsPresent[yearsPresent.length - 1] || new Date().getFullYear());
    const yearStr = prompt(`Export claimed rewards for which tax year?\n\nYears with data: ${yearsPresent.join(', ')}`, defaultYear);
    if (yearStr === null) return; // user cancelled
    const year = parseInt(yearStr, 10);
    if (!Number.isFinite(year) || year < 2020 || year > 2100) {
        alert('That doesn\'t look like a valid year.');
        return;
    }

    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd = Date.UTC(year + 1, 0, 1);
    const inYear = claimed.filter(r => r.timestamp >= yearStart && r.timestamp < yearEnd);
    if (!inYear.length) {
        alert(`No claimed rewards in ${year}.`);
        return;
    }

    // Pull a wide enough slice of price history to cover the entire year.
    // /api/price-history caps at 365 days, which is exactly what we need.
    let history = [];
    try {
        const res = await fetch('/api/price-history?days=365');
        const data = await res.json();
        history = Array.isArray(data.history) ? data.history : [];
    } catch (_) { history = []; }
    // history is descending by time; we'll binary-pick the closest sample
    // by absolute time delta. For older eras outside the 365-day window the
    // function falls through to null → we emit a blank USD cell + flag.
    const priceForTimestamp = (ts) => {
        if (!history.length) return null;
        let best = null;
        let bestDelta = Infinity;
        for (const p of history) {
            const t = Number(p.timestamp);
            const delta = Math.abs(t - ts);
            if (delta < bestDelta) { bestDelta = delta; best = p; }
        }
        // Reject samples more than 36h away — that's beyond a single era of
        // drift on Polkadex and would mis-state cost basis.
        if (best && bestDelta < 36 * 60 * 60 * 1000) return Number(best.price);
        return null;
    };

    const header = ['Era', 'Date (UTC)', 'Amount (PDEX)', 'PDEX/USD at era close', 'USD value', 'Validator', 'Block', 'Block Hash'];
    const lines = [header.join(',')];
    let totalPdex = 0;
    let totalUsd = 0;
    let pricedRows = 0;
    let unpricedRows = 0;
    inYear.forEach(r => {
        const date = formatLocalDateTime(r.timestamp); // header still says UTC for stability; this is local — clarify below
        const amount = Number(r.amount || 0);
        totalPdex += amount;
        const price = priceForTimestamp(r.timestamp);
        let usdCell = '';
        if (price != null) {
            const usd = amount * price;
            totalUsd += usd;
            usdCell = usd.toFixed(2);
            pricedRows++;
        } else {
            unpricedRows++;
        }
        lines.push([
            r.era != null ? r.era : '',
            // Tax authorities prefer ISO-8601 in UTC for unambiguity. Override
            // the local display here despite the global helper.
            new Date(r.timestamp).toISOString().replace('T', ' ').substring(0, 19),
            amount.toFixed(6),
            price != null ? price.toFixed(6) : '',
            usdCell,
            r.validator || '',
            r.block != null ? r.block : '',
            r.blockHash || ''
        ].map(stakingCsvCell).join(','));
    });

    // Year-end totals row + provenance footer so the file is self-describing
    // when an accountant opens it months later without the explorer at hand.
    lines.push('');
    lines.push(['TOTAL', `${year}`, totalPdex.toFixed(6), '', totalUsd.toFixed(2), '', '', ''].map(stakingCsvCell).join(','));
    lines.push('');
    lines.push(`# Polkadex Staking Rewards — Tax Year ${year}`);
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push(`# Address: ${stakingRewardsData.address || ''}`);
    lines.push(`# Rows priced from CoinMarketCap-sourced PDEX/USD history: ${pricedRows}`);
    if (unpricedRows > 0) {
        lines.push(`# Rows WITHOUT a price (out of price-history window — fill manually): ${unpricedRows}`);
    }
    lines.push(`# Includes only CLAIMED rewards. Unpaid rewards are excluded — they aren't realised income.`);

    downloadStakingBlob(
        `staking-rewards-${year}-tax-${stakingRewardsData.address || 'address'}.csv`,
        lines.join('\r\n'),
        'text/csv;charset=utf-8'
    );
}

// --- Wallet Connect + Dashboard ---
function getStoredWallet() {
    try {
        const v = localStorage.getItem(WALLET_STORAGE_KEY) || '';
        if (!v) return '';
        // Legacy installs may have a generic Polkadot/Substrate address in
        // storage from before we normalised on write — coerce on read and
        // rewrite so the rest of the UI sees the Polkadex form.
        const pdex = toPolkadexAddress(v);
        if (pdex && pdex !== v) {
            try { localStorage.setItem(WALLET_STORAGE_KEY, pdex); } catch (e) { /* ignore quota */ }
            return pdex;
        }
        return v;
    } catch (e) { return ''; }
}
function setStoredWallet(addr) {
    try {
        if (addr) localStorage.setItem(WALLET_STORAGE_KEY, toPolkadexAddress(addr));
        else localStorage.removeItem(WALLET_STORAGE_KEY);
    } catch (e) { }
}

// "Last used" address — a SEPARATE memory that survives `disconnectWallet()`.
//
//   `WALLET_STORAGE_KEY`        — currently-connected address. Cleared on
//                                 disconnect.
//   `LAST_USED_ADDRESS_KEY`     — the last address the user explicitly
//                                 picked from a wallet extension. Persists
//                                 even after disconnect so the auto-pick
//                                 in `tryAutoSelectFirstWallet()` can
//                                 honour a multi-account user's preference
//                                 the next time they revisit My Account.
//
// Written by `selectWallet()` (the path manual-button-click and auto-pick
// both flow through), never written by `setStoredWallet('')`.
const LAST_USED_ADDRESS_KEY = 'pdex_last_used_wallet_address';
function getLastUsedAddress() {
    try {
        const v = localStorage.getItem(LAST_USED_ADDRESS_KEY) || '';
        if (!v) return '';
        // Same legacy coercion the stored-wallet getter does — older entries
        // may be in the generic SS58 form.
        const pdex = toPolkadexAddress(v);
        if (pdex && pdex !== v) {
            try { localStorage.setItem(LAST_USED_ADDRESS_KEY, pdex); } catch (e) { }
            return pdex;
        }
        return v;
    } catch (e) { return ''; }
}
function setLastUsedAddress(addr) {
    try {
        if (addr) localStorage.setItem(LAST_USED_ADDRESS_KEY, toPolkadexAddress(addr));
    } catch (e) { }
}
function refreshConnectWalletButton() {
    const btn = document.getElementById('connect-wallet-btn');
    const label = document.getElementById('connect-wallet-label');
    const sub = document.getElementById('connect-wallet-sub');
    const disconnectBtn = document.getElementById('disconnect-wallet-btn');
    const stored = getStoredWallet();
    if (stored) {
        // Connected: lead with "My Account" so the affordance is obvious, and
        // tuck the abbreviated address underneath as a secondary line.
        if (label) label.textContent = 'My Account';
        if (sub) { sub.textContent = stakingShortAddress(stored); sub.style.display = 'block'; }
        if (btn) {
            btn.classList.add('is-connected');
            btn.setAttribute('title', 'View your account: ' + stored);
            btn.setAttribute('aria-label', 'View my account (' + stakingShortAddress(stored) + ')');
        }
    } else {
        if (label) label.textContent = 'Connect Wallet';
        if (sub) { sub.textContent = ''; sub.style.display = 'none'; }
        if (btn) {
            btn.classList.remove('is-connected');
            btn.setAttribute('title', 'Connect your Substrate wallet to view balances and sign staking actions');
            btn.setAttribute('aria-label', 'Connect wallet');
        }
    }
    if (disconnectBtn) disconnectBtn.style.display = stored ? 'inline-flex' : 'none';
    // Reflect connected state on the sidebar item too — clearer than a generic "My Account" link.
    const navMine = document.getElementById('nav-my-account');
    if (navMine) {
        const navLabel = navMine.querySelector('span') || navMine;
        navMine.title = stored ? ('Your account: ' + stored) : 'Connect a wallet to view your account';
    }
}

// --- Mobile / in-app wallet detection --------------------------------------
// A handful of mobile wallets (Nova, SubWallet, Talisman, Math, etc.) ship an
// in-app browser that injects `window.injectedWeb3` exactly like the desktop
// Polkadot.js extension does. The existing enumeration below already picks
// those up — these helpers just let the connect panel show appropriate
// messaging and deep-link buttons.
function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
}

// Cheap synchronous check: is *any* Substrate wallet currently injecting
// accounts into this tab? Used to gate the wallet-dashboard action bar so
// users who arrived in view-only mode (typed-in address) or whose wallet
// session has ended don't see signing buttons that lead to a dead-end error.
function hasInjectedWalletNow() {
    return !!(typeof window !== 'undefined'
        && window.injectedWeb3
        && Object.keys(window.injectedWeb3).length > 0);
}

// Identify the in-app wallet browser hosting us (if any) so the panel can
// greet the user by name. `window.injectedWeb3` key names are stable identifiers
// each wallet self-declares.
function detectInjectedWalletEnv() {
    const w = (typeof window !== 'undefined' && window.injectedWeb3) || {};
    const keys = Object.keys(w);
    const has = (k) => keys.includes(k);
    if (has('subwallet-js')) return { id: 'subwallet', name: 'SubWallet' };
    if (has('talisman')) return { id: 'talisman', name: 'Talisman' };
    if (has('polkagate')) return { id: 'polkagate', name: 'PolkaGate' };
    if (has('polkadot-js')) {
        // polkadot-js is the namespace Nova Wallet and the desktop extension
        // both use. UA sniffing tells them apart for greeting purposes.
        const ua = (navigator.userAgent || '').toLowerCase();
        if (ua.includes('novawallet') || ua.includes('nova-wallet') || ua.includes('nova/')) return { id: 'nova', name: 'Nova Wallet' };
        return { id: 'polkadot-js', name: 'Polkadot.js' };
    }
    if (keys.length) return { id: keys[0], name: keys[0] };
    return null;
}

// Known mobile wallets that ship a dapp browser. Each entry tells the connect
// panel how to deep-link / app-store-link / explain itself. Deep links use the
// wallets' published universal-link domains where verified; users who don't
// have the wallet installed get the app-store fallback automatically.
const MOBILE_WALLETS = [
    {
        id: 'nova',
        name: 'Nova Wallet',
        // Nova publishes nova.app.link for opening URLs in its built-in browser.
        deeplink: (url) => 'https://app.novawallet.io/open/dapp?url=' + encodeURIComponent(url),
        appStore: 'https://apps.apple.com/app/nova-polkadot-kusama-wallet/id1597119355',
        playStore: 'https://play.google.com/store/apps/details?id=io.novafoundation.nova.market',
        site: 'https://novawallet.io',
        tagline: 'Polkadot & Kusama native — Apple/Android'
    },
    {
        id: 'subwallet',
        name: 'SubWallet',
        // SubWallet exposes subwallet:// as a URL scheme to open arbitrary dapp URLs.
        deeplink: (url) => 'subwallet://browser?url=' + encodeURIComponent(url),
        appStore: 'https://apps.apple.com/app/subwallet-polkadot-wallet/id1633050285',
        playStore: 'https://play.google.com/store/apps/details?id=app.subwallet.mobile',
        site: 'https://subwallet.app',
        tagline: 'Multi-chain dapp browser — Apple/Android'
    },
    {
        id: 'talisman',
        name: 'Talisman',
        // Talisman is browser-extension first; the deep-link is a docs hand-off.
        deeplink: null,
        appStore: null,
        playStore: null,
        site: 'https://talisman.xyz/download',
        tagline: 'Browser extension — desktop today'
    }
];

// Enumerate accounts from installed Substrate wallet extensions / mobile
// in-app browsers. The retry loop helps mobile wallets that inject
// `window.injectedWeb3` slightly after `DOMContentLoaded`.
// Each account is returned with two address fields:
//   `address`    — the Polkadex-prefixed form (starts with "e…") for display
//                  and for everything the user/UI persists.
//   (a former `rawAddress` field was removed — audit F-117: never read)
//                  needed by the wallet's `signAndSend` so the injected
//                  signer recognises the account.
async function getInjectedAccounts({ retries = 6, retryDelayMs = 250 } = {}) {
    // Wait briefly for late injection on mobile wallet in-app browsers.
    for (let i = 0; i < retries; i++) {
        if (window.injectedWeb3 && Object.keys(window.injectedWeb3).length) break;
        await new Promise(r => setTimeout(r, retryDelayMs));
    }
    const injected = window.injectedWeb3;
    if (!injected || Object.keys(injected).length === 0) return null;
    const accounts = [];
    for (const key of Object.keys(injected)) {
        try {
            const provider = injected[key];
            if (!provider || typeof provider.enable !== 'function') continue;
            const ext = await provider.enable('Polkadex Explorer');
            if (ext && ext.accounts && typeof ext.accounts.get === 'function') {
                const accs = await ext.accounts.get();
                for (const a of accs) {
                    const pdex = toPolkadexAddress(a.address);
                    // Audit F-117: a `rawAddress` field used to be stored here
                    // "for the injected signer", but nothing ever read it —
                    // every signAndSend call site passes account.address and
                    // extensions accept any SS58 encoding of a key they own.
                    accounts.push({ address: pdex, name: a.name || key, source: key });
                }
            }
        } catch (e) { /* user rejected this extension */ }
    }
    return accounts;
}

function connectWallet() {
    const stored = getStoredWallet();
    navigateTo(stored ? ('wallet/' + stored) : 'wallet');
}
function selectWallet(address) {
    if (!isValidPolkadexAddress(address)) return;
    // Always store + route with the Polkadex-prefixed form so the URL bar,
    // localStorage, and dashboard all show the chain-specific "e…" address.
    const pdex = toPolkadexAddress(address);
    setStoredWallet(pdex);
    // Record the explicit choice in the last-used memory so a future visit
    // (even after the user has disconnected and a wallet extension now
    // exposes several accounts) can prefer it over the first-in-the-list
    // default. See `tryAutoSelectFirstWallet()`.
    setLastUsedAddress(pdex);
    refreshConnectWalletButton();
    // Honour ?returnTo=<path> if the user arrived at /wallet from a
    // "Connect a wallet to <do thing>" link elsewhere in the app — e.g.
    // the account-labels "suggest or vote" prompt on /account/<addr>.
    // Without this, the user is silently teleported to the dashboard
    // after connecting and has to navigate back manually. Sanitised to
    // same-origin path-only to prevent open-redirect.
    const returnTo = readSafeReturnTo();
    if (returnTo) {
        navigateTo(returnTo.replace(/^\/+/, ''));
        return;
    }
    navigateTo('wallet/' + pdex);
}

// Build the "Please connect your wallet" prompt with an actionable link
// back to /wallet?returnTo=<currentPath>. Used by every governance modal
// (council candidacy, council vote, democracy referendum vote, treasury
// submit proposal) so the user isn't left with a dead-end "please connect"
// message — clicking the link routes them to the wallet picker, and
// selectWallet brings them back to this exact URL once they've picked
// an account.
//
// Returns an HTML string ready to inject into a warning <div>.
function buildWalletConnectPrompt() {
    // Capture the current path INCLUDING query string so a deep-linked
    // modal-opening URL (e.g. /democracy?ref=42) round-trips intact.
    const here = (window.location.pathname || '/') + (window.location.search || '');
    return `Please connect your wallet first. <a href="/wallet?returnTo=${encodeURIComponent(here)}" style="color:var(--brand-secondary);font-weight:600;text-decoration:underline;">Connect a wallet</a> and you'll be returned to this page.`;
}

// Pull ?returnTo from the current URL and validate it's a same-origin
// path (must start with "/", no scheme, no host). Returns the cleaned
// path or null. Used by selectWallet + tryAutoSelectFirstWallet to honour
// the "send me back to where I clicked Connect" intent.
function readSafeReturnTo() {
    try {
        const sp = new URLSearchParams(window.location.search || '');
        const raw = sp.get('returnTo');
        if (!raw) return null;
        // Only allow path-only same-origin destinations. Reject anything
        // that looks like a scheme (http:, javascript:) or a protocol-
        // relative URL (//evil.example.com).
        if (!raw.startsWith('/') || raw.startsWith('//')) return null;
        if (/[\r\n]/.test(raw)) return null;
        return raw;
    } catch (_) { return null; }
}
// One-shot session flag that suppresses the auto-pick in tryAutoSelectFirstWallet
// for the next /wallet visit. Set by disconnectWallet so an explicit "Switch
// wallet" / "Disconnect" click can't be immediately undone by the auto-pick
// re-selecting the same last-used address. Lives in sessionStorage so it
// doesn't outlive the browser tab.
const SKIP_AUTO_PICK_KEY = 'pdex_skip_wallet_auto_pick';

function disconnectWallet() {
    setStoredWallet('');
    refreshConnectWalletButton();
    // Tell the next initWalletPage() to skip auto-pick — without this, the
    // "Switch wallet" button silently routes back to the same address
    // because tryAutoSelectFirstWallet finds the still-remembered last-used
    // address in the extension's account list and re-selects it.
    try { sessionStorage.setItem(SKIP_AUTO_PICK_KEY, '1'); } catch (e) {}
    // If the user is currently on a wallet page, return them to the connect panel.
    const current = readRouteFromLocation();
    if (current.startsWith('wallet')) {
        if (current === 'wallet') {
            const root = document.getElementById('wallet-dashboard');
            // Reset SEO + meta in case we were on a personal wallet page.
            updateSeoMeta('wallet', { canonicalPath: '/wallet', noindex: false });
            if (root) renderWalletConnectPanel(root);
        } else {
            navigateTo('wallet');
        }
    }
}

// Read-and-clear helper for the one-shot flag. Called by both initWalletPage
// branches (immediate render and async auto-pick) so the flag is always
// consumed exactly once even if the page is re-entered quickly.
function consumeSkipAutoPickFlag() {
    try {
        const v = sessionStorage.getItem(SKIP_AUTO_PICK_KEY);
        if (v) sessionStorage.removeItem(SKIP_AUTO_PICK_KEY);
        return !!v;
    } catch (e) { return false; }
}

function initWalletPage(address) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    if (address) {
        // If the URL still contains a generic Polkadot/Substrate address from
        // an older link or a wallet extension's native format, rewrite it to
        // the Polkadex-prefixed form so the address bar (and any subsequent
        // share / bookmark) matches what the dashboard shows.
        if (isValidPolkadexAddress(address)) {
            const pdex = toPolkadexAddress(address);
            if (pdex && pdex !== address) {
                try { history.replaceState(null, '', '/wallet/' + pdex); } catch (e) { /* ignore */ }
                address = pdex;
            }
        }
        // Personal dashboard: noindex and no route JSON-LD (PII / dynamic).
        updateSeoMeta('wallet', {
            title: 'My Account — Polkadex Explorer',
            description: 'Your Polkadex account dashboard: balances, staking, nominations, rewards, and recent transactions.',
            canonicalPath: '/wallet/' + address,
            noindex: true
        });
        if (isValidPolkadexAddress(address)) fetchWalletDashboard(address);
        else root.innerHTML = '<div class="list-container glass" style="padding:32px;color:var(--error);">Invalid Polkadex address.</div>';
        return;
    }
    // No address in the URL — user clicked "My Account" from the sidebar.
    // Decide where to land them on three rules (in priority order):
    //
    //   1. If a wallet address is already remembered in localStorage
    //      (`getStoredWallet()`), navigate directly to /wallet/<addr>.
    //      replace:true so the back button still lands on the previous page,
    //      not on a transient /wallet entry.
    //
    //   2. If no stored address but the wallet extension already exposes
    //      accounts to this tab, auto-pick the FIRST account (the user's
    //      explicit preference — "use the first wallet in the list").
    //      Done async so the connect panel still paints instantly while
    //      the extension is being queried; if the auto-pick lands, it
    //      replaces the panel with the dashboard.
    //
    //   3. Otherwise show the connect panel as before (search-indexable,
    //      lists every detected extension account as a button).
    const stored = getStoredWallet();
    if (stored && isValidPolkadexAddress(stored)) {
        navigateTo('wallet/' + stored, { replace: true });
        return;
    }

    // Public connect-wallet landing: indexable + rich HowTo/FAQ structured
    // data so search engines surface us for "connect Polkadex wallet" and
    // "how to send PDEX" queries.
    updateSeoMeta('wallet', { canonicalPath: '/wallet', noindex: false });
    setRouteJsonLd(buildWalletConnectJsonLd());
    renderWalletConnectPanel(root);

    // Fire-and-forget auto-pick. Throws are swallowed (user-rejected extension
    // permission, no extension, etc.) so we never break the connect panel.
    tryAutoSelectFirstWallet();
}

// Background helper used by initWalletPage when no address is in the URL
// and nothing is stored locally. Picks one account from the wallet
// extension's injected list and selects it.
//
// Priority for which account to pick:
//   1. Last-used address (`getLastUsedAddress()`), if it's currently in
//      the extension's list. This honours a multi-account user's prior
//      choice across disconnect → reconnect cycles, so they always land
//      on "their" address rather than whichever the extension happens to
//      list first.
//   2. Otherwise, the first account in the injected list (matches the
//      user's spec: "If none were used, use the first wallet in the list").
//
// Safe to race with manual selection — re-checks `getStoredWallet()` and
// the current route after the async account fetch to avoid clobbering
// whatever the user picked manually or navigated to while we were waiting.
async function tryAutoSelectFirstWallet() {
    try {
        // Honour an explicit disconnect/switch — the user just told us they
        // want to pick a different account, so re-selecting the previously-
        // used one would be hostile. The flag is one-shot: consuming it
        // clears it, so the next /wallet visit is back to normal.
        if (consumeSkipAutoPickFlag()) return;
        // Bail early if the user clicked an account between us starting and
        // getting here — for example, while the extension's permission
        // prompt was open.
        if (getStoredWallet()) return;
        const accounts = await getInjectedAccounts();
        if (!accounts || !accounts.length) return;
        // Late-bind these gates AFTER the async wait so they're checked
        // against the freshest state, not stale captures from start time.
        if (getStoredWallet()) return;
        const here = readRouteFromLocation();
        if (here !== 'wallet') return;

        // Prefer the address the user previously picked from this same
        // extension. The `lastUsed` value may belong to a different wallet
        // or to a since-removed account — in either case we fall through
        // to the first injected account below.
        const lastUsed = getLastUsedAddress();
        let chosen = null;
        if (lastUsed) {
            chosen = accounts.find(a => isSameAddress(a.address, lastUsed)) || null;
        }
        if (!chosen) chosen = accounts[0];
        if (!chosen || !isValidPolkadexAddress(chosen.address)) return;
        // Mirror the manual-selection path: persist + navigate, so the
        // wallet topbar pill and SEO meta both update consistently.
        selectWallet(chosen.address);
    } catch (e) {
        // Permission-denied / no-extension / etc. — silently fall back to
        // the connect panel that's already on screen.
    }
}

// Build the "Open in mobile wallet" deep-link card list. Rendered as an extra
// section in the connect panel so phone users have a one-tap path into a
// wallet's in-app browser (where injectedWeb3 just works).
function renderMobileWalletCards(currentUrl) {
    const isMobile = isMobileDevice();
    const cards = MOBILE_WALLETS.map(w => {
        const link = w.deeplink ? w.deeplink(currentUrl) : null;
        // On mobile, the primary CTA is the deep-link; on desktop we point to
        // app stores so the user can install + paste the URL.
        const primary = isMobile && link
            ? `<a class="mobile-wallet-cta" href="${stakingEscapeHtml(link)}">Open in ${stakingEscapeHtml(w.name)}</a>`
            : (w.appStore || w.playStore)
                ? `<div class="mobile-wallet-storelinks">
                    ${w.appStore ? `<a href="${stakingEscapeHtml(w.appStore)}" target="_blank" rel="noopener"><i class='bx bxl-apple'></i> iOS</a>` : ''}
                    ${w.playStore ? `<a href="${stakingEscapeHtml(w.playStore)}" target="_blank" rel="noopener"><i class='bx bxl-play-store'></i> Android</a>` : ''}
                   </div>`
                : `<a class="mobile-wallet-cta secondary" href="${stakingEscapeHtml(w.site)}" target="_blank" rel="noopener">Visit ${stakingEscapeHtml(w.name)}</a>`;
        return `<div class="mobile-wallet-card">
            <div class="mobile-wallet-head">
                <strong>${stakingEscapeHtml(w.name)}</strong>
                <span>${stakingEscapeHtml(w.tagline)}</span>
            </div>
            ${primary}
        </div>`;
    }).join('');
    return `<div class="mobile-wallet-grid">${cards}</div>`;
}

async function renderWalletConnectPanel(root) {
    const env = detectInjectedWalletEnv();
    const onMobile = isMobileDevice();
    const currentUrl = (typeof location !== 'undefined') ? location.href : 'https://explorer.polkadex.ee/wallet';

    const envBanner = env
        ? `<div class="wallet-env-banner"><i class='bx bx-check-circle'></i> Detected <strong>${stakingEscapeHtml(env.name)}</strong> — pick an account below to connect.</div>`
        : '';

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header"><h2>Connect Wallet ${helpIcon('connecting-wallet', 'How to connect your wallet')}</h2></div>
            <div style="padding: 24px;">
                ${envBanner}
                <p style="color: var(--text-secondary); font-size: 0.88rem; margin-bottom: 16px; line-height: 1.6;">
                    Connect a Substrate wallet to open your dashboard. You'll be able to view your balance and
                    sign actions — send PDEX, bond more, nominate validators, pay out rewards or unbond.
                    Every transaction needs your explicit approval in the wallet; the explorer can never move
                    funds without it.
                </p>
                <div id="wallet-accounts" style="display:flex; flex-direction:column; gap:10px;">
                    <div style="color: var(--text-muted); font-size: 0.85rem;">Looking for wallets…</div>
                </div>

                <div id="wallet-mobile-section" style="display:none; margin-top: 24px;">
                    <h3 style="font-size: 0.95rem; margin-bottom: 6px;">On mobile? Use a wallet's in-app browser</h3>
                    <p style="color: var(--text-secondary); font-size: 0.82rem; margin-bottom: 12px; line-height: 1.5;">
                        Browser extensions don't run on phones. Open the explorer inside a mobile wallet's built-in
                        dapp browser — your accounts inject automatically, just like with a desktop extension.
                    </p>
                    ${renderMobileWalletCards(currentUrl)}
                    <div class="mobile-wallet-copyrow">
                        <input id="wallet-copy-url" type="text" readonly value="${stakingEscapeHtml(currentUrl)}">
                        <button id="wallet-copy-btn" type="button"><i class='bx bx-copy'></i> Copy URL</button>
                    </div>
                </div>

                <div style="margin-top: 22px; border-top: 1px solid var(--border-color); padding-top: 18px;">
                    <p style="color: var(--text-secondary); font-size: 0.82rem; margin-bottom: 10px;">…or look up any address without connecting (view-only):</p>
                    <div class="staking-search-bar">
                        <input type="text" id="wallet-manual-input" placeholder="Polkadex address" autocomplete="off" spellcheck="false">
                        <button id="wallet-manual-btn"><i class='bx bx-search'></i> View</button>
                    </div>
                    <div id="wallet-manual-error" class="staking-error" style="display:none;"></div>
                </div>
            </div>
        </div>`;

    const manualBtn = document.getElementById('wallet-manual-btn');
    const manualInput = document.getElementById('wallet-manual-input');
    const manualErr = document.getElementById('wallet-manual-error');
    const submitManual = () => {
        const addr = (manualInput.value || '').trim();
        if (!isValidPolkadexAddress(addr)) {
            manualErr.textContent = 'That does not look like a valid Polkadex address.';
            manualErr.style.display = 'block';
            return;
        }
        selectWallet(addr);
    };
    if (manualBtn) manualBtn.addEventListener('click', submitManual);
    if (manualInput) manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitManual(); });

    // Copy-URL helper for mobile users; falls back to selecting the input
    // when navigator.clipboard isn't available (older WebViews).
    const copyBtn = document.getElementById('wallet-copy-btn');
    const copyInput = document.getElementById('wallet-copy-url');
    if (copyBtn && copyInput) copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(copyInput.value);
            copyBtn.innerHTML = "<i class='bx bx-check'></i> Copied!";
            setTimeout(() => { copyBtn.innerHTML = "<i class='bx bx-copy'></i> Copy URL"; }, 1500);
        } catch (e) {
            copyInput.select();
            try { document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
        }
    });

    // Show the mobile-wallet section by default on mobile; on desktop, only
    // surface it if no wallet was detected (it's still useful info for users
    // who keep their stash on a phone-only wallet like Nova).
    const mobileSection = document.getElementById('wallet-mobile-section');
    const accountsEl = document.getElementById('wallet-accounts');

    const accounts = await getInjectedAccounts();
    if (accounts === null) {
        accountsEl.innerHTML = onMobile
            ? `<div class="wallet-empty-msg">
                No wallet is exposing accounts to this browser tab. If you're on a phone, open this URL inside a
                mobile wallet's in-app browser using one of the options below. On desktop, install
                <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener">Polkadot.js</a>,
                Talisman or SubWallet.
               </div>`
            : `<div class="wallet-empty-msg">
                No Substrate wallet extension detected. Install
                <a href="https://polkadot.js.org/extension/" target="_blank" rel="noopener">Polkadot.js</a>,
                Talisman or SubWallet — or, if your stash lives on your phone, use a mobile wallet's in-app
                browser (see below).
               </div>`;
        if (mobileSection) mobileSection.style.display = 'block';
        return;
    }
    if (accounts.length === 0) {
        accountsEl.innerHTML = `<div class="wallet-empty-msg">
            ${env ? stakingEscapeHtml(env.name) + ' is connected, but no accounts were shared.' : 'No accounts were shared.'}
            Authorise this site in your wallet and try again.
           </div>`;
        if (mobileSection) mobileSection.style.display = onMobile ? 'block' : 'none';
        return;
    }
    accountsEl.innerHTML = accounts.map(a => `
        <button class="wallet-account-btn" data-address="${stakingEscapeHtml(a.address)}">
            <span class="wallet-account-name">${stakingEscapeHtml(a.name)}</span>
            <span class="wallet-account-addr">${stakingShortAddress(a.address)}</span>
        </button>`).join('');
    accountsEl.querySelectorAll('.wallet-account-btn').forEach(btn => {
        btn.addEventListener('click', () => selectWallet(btn.getAttribute('data-address')));
    });
    if (mobileSection) mobileSection.style.display = onMobile ? 'block' : 'none';
}

// Animated, stepped loading state shown while the wallet dashboard is fetched.
// Returns a cleanup function that stops the message-cycling timer.
function renderWalletLoading(root, address) {
    const steps = [
        { icon: 'bx-link-alt', label: 'Verify address', msg: 'Verifying your address on the Polkadex chain…' },
        { icon: 'bx-coin-stack', label: 'Balances & staking', msg: 'Fetching your balances and staking positions…' },
        { icon: 'bx-gift', label: 'Reward history', msg: 'Reading your on-chain reward history…' },
        { icon: 'bx-bar-chart-alt-2', label: 'Build dashboard', msg: 'Almost there — assembling your dashboard…' }
    ];
    const stepPill = (s, i, state) => {
        const icon = state === 'done' ? 'bx-check'
            : state === 'active' ? 'bx-loader-alt spin'
            : s.icon;
        return `<div class="wallet-step ${state}" data-step="${i}"><i class='bx ${icon}'></i>${s.label}</div>`;
    };
    root.innerHTML = `
        <div class="wallet-loading">
            <div class="list-container glass">
                <div class="wallet-loading-banner">
                    <div class="wallet-spinner"><i class='bx bx-wallet'></i></div>
                    <div class="wallet-loading-text">
                        <div class="wallet-loading-title">Loading your wallet dashboard</div>
                        <div class="wallet-loading-msg" id="wallet-loading-msg">${steps[0].msg}</div>
                        <div class="wallet-loading-steps" id="wallet-loading-steps">
                            ${steps.map((s, i) => stepPill(s, i, i === 0 ? 'active' : 'pending')).join('')}
                        </div>
                    </div>
                </div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2><i class='bx bx-wallet'></i> ${stakingEscapeHtml(stakingShortAddress(address))}</h2></div>
                <div class="wallet-skel-summary">
                    ${[0, 1, 2, 3].map(() => '<div class="wallet-skel-card"><div class="skel line-sm"></div><div class="skel line-lg"></div></div>').join('')}
                </div>
            </div>
            <div class="wallet-grid">
                ${[0, 1].map(() => `<div class="list-container glass"><div class="wallet-skel-rows">${[0, 1, 2, 3, 4].map(() => '<div class="skel wallet-skel-row"></div>').join('')}</div></div>`).join('')}
            </div>
        </div>`;
    let idx = 0;
    const msgEl = document.getElementById('wallet-loading-msg');
    const stepsEl = document.getElementById('wallet-loading-steps');
    const timer = setInterval(() => {
        if (idx >= steps.length - 1) return; // hold on the final step until data arrives
        const prev = stepsEl && stepsEl.querySelector(`[data-step="${idx}"]`);
        if (prev) { prev.className = 'wallet-step done'; prev.innerHTML = `<i class='bx bx-check'></i>${steps[idx].label}`; }
        idx++;
        const cur = stepsEl && stepsEl.querySelector(`[data-step="${idx}"]`);
        if (cur) { cur.className = 'wallet-step active'; cur.innerHTML = `<i class='bx bx-loader-alt spin'></i>${steps[idx].label}`; }
        if (msgEl) {
            msgEl.textContent = steps[idx].msg;
            msgEl.classList.remove('swap');
            void msgEl.offsetWidth; // restart the fade animation
            msgEl.classList.add('swap');
        }
    }, 1500);
    return () => clearInterval(timer);
}

async function fetchWalletDashboard(address) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;

    // ─── Cache-first paint ──────────────────────────────────────────────
    // If we have a recent snapshot for THIS address, render it immediately.
    // The user sees their dashboard at first paint instead of staring at a
    // skeleton + animated "Building dashboard" message for the duration of
    // the slowest of three RPC-bound HTTP calls.
    const cached = readWalletCache(address);
    let didPaintFromCache = false;
    if (cached && cached.wallet) {
        try {
            renderWalletDashboard(cached.wallet, cached.price || { history: [], configured: false }, cached.rewards || null);
            didPaintFromCache = true;
        } catch (_) { /* cache shape drift — fall back to loading skeleton */ }
    }
    const stopLoading = didPaintFromCache ? () => {} : renderWalletLoading(root, address);

    // ─── Three fetches in parallel, each settles independently ─────────
    // Previously `Promise.all([wallet, price, rewards])` blocked the entire
    // dashboard render on the slowest of the three. On a cold first load
    // with chain RPC contention, that could be 30-60s. Now each promise
    // updates its part of the dashboard as it lands; the user sees the
    // balance + nominations as soon as /api/wallet returns (typically
    // 1-3s), and the chart + APR card fill in moments later.
    let latestWallet = null;
    let latestPrice  = { history: [], configured: false };
    let latestRewards = null;

    const walletPromise = fetch('/api/wallet/' + encodeURIComponent(address))
        .then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }));
    const pricePromise = fetch('/api/price-history?days=30')
        .then(r => r.json())
        .catch(() => ({ history: [], configured: false }));
    const rewardsPromise = fetch('/api/staking-rewards/' + encodeURIComponent(address))
        .then(r => r.json())
        .catch(() => null);

    // Wallet payload — main render path.
    walletPromise.then(result => {
        if (!result.ok || (result.data && result.data.error)) {
            stopLoading();
            if (!didPaintFromCache) {
                const msg = (result.data && result.data.error) || ('Request failed (' + result.status + ')');
                root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(msg)}</div>`;
            }
            return;
        }
        latestWallet = result.data;
        stopLoading();
        // Re-render with the live wallet payload and whichever of price/
        // rewards has already landed. Anything still in-flight will paint
        // into the rendered DOM via the targeted handlers below.
        renderWalletDashboard(latestWallet, latestPrice, latestRewards);
        writeWalletCache(address, { wallet: latestWallet, price: latestPrice, rewards: latestRewards });
    }).catch(err => {
        stopLoading();
        if (!didPaintFromCache) {
            root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(err.message || String(err))}</div>`;
        }
    });

    // Price-history payload — repaint just the price chart slot.
    pricePromise.then(price => {
        latestPrice = price || { history: [], configured: false };
        // Only do the targeted repaint if the wallet payload has already
        // rendered the dashboard (otherwise the chart slot doesn't exist
        // yet — the upcoming wallet render will pick up latestPrice).
        if (latestWallet) {
            repaintWalletPriceCard(latestPrice);
            writeWalletCache(address, { wallet: latestWallet, price: latestPrice, rewards: latestRewards });
        }
    });

    // Staking-rewards payload — repaint just the APR card.
    rewardsPromise.then(rewards => {
        latestRewards = rewards;
        walletAprData = rewards || null;
        if (latestWallet) {
            renderWalletAprCard();
            writeWalletCache(address, { wallet: latestWallet, price: latestPrice, rewards: latestRewards });
        }
    });
}

// Targeted repaint for just the PDEX price chart slot inside the wallet
// dashboard. Lets us render the rest of the dashboard immediately (while
// /api/price-history is still in flight) and slot the chart in later.
function repaintWalletPriceCard(price) {
    const wrap = document.getElementById('wallet-price-chart-wrap');
    if (!wrap) return;
    const history = (price && price.history) || [];
    const configured = !!(price && price.configured);
    if (history.length) {
        wrap.innerHTML = '<canvas id="wallet-price-chart"></canvas>';
        renderWalletPriceChart(history);
    } else {
        wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem;text-align:center;padding:0 20px;">${configured ? 'Collecting price history — the chart fills in as data is polled.' : 'Price feed not configured.'}</div>`;
    }
    // Refresh the headline price badge in the list-header too.
    const headerPrice = document.getElementById('wallet-price-header-price');
    const latest = price && price.latest;
    if (headerPrice && latest && typeof latest.price === 'number') {
        headerPrice.textContent = '$' + Number(latest.price).toLocaleString('en-US', { maximumFractionDigits: 4 });
    } else if (headerPrice) {
        headerPrice.textContent = '';
    }
}

// State for the wallet-dashboard APR period selector.
//   walletAprData     — full staking-rewards payload (claimed array + apr.*)
//   walletAprDays     — currently selected period in days (0 = all-time)
let walletAprData = null;
let walletAprDays = 30;

function renderWalletDashboard(data, price, rewardsPayload) {
    const root = document.getElementById('wallet-dashboard');
    if (!root) return;
    currentWalletData = data;
    // Stash the staking-rewards payload so the APR card's period pills
    // can recompute against the cached claimed array without re-fetching
    // every time the user clicks a different period.
    walletAprData = rewardsPayload || null;
    const isOwnWallet = isSameAddress(getStoredWallet(), data.address);
    const identity = data.identity && data.identity !== 'Unknown' ? data.identity : null;
    const staking = data.staking || {};
    const rewards = data.rewards || {};
    const network = data.network || {};
    const balance = data.balance || {};

    const validatorsHtml = (staking.nominating && staking.nominating.length)
        ? staking.nominating.map(v => `
            <a href="/validator/${encodeURIComponent(v.address)}" class="wallet-validator-row item-link">
                <span>${v.name && v.name !== 'Unknown' ? stakingEscapeHtml(v.name) : stakingShortAddress(v.address)}</span>
                <i class='bx bx-chevron-right'></i>
            </a>`).join('')
        : '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 0;">This wallet is not nominating any validators.</div>';

    // Recent transactions + recent rewards tables are rendered by makeTable
    // into placeholder divs after the outer dashboard chrome lands. Tag each
    // row in `recentTransactions` with a `direction` so the column can sort
    // and filter on it without recomputing per-row.
    const recentTx = (data.recentTransactions || []).map(t => ({
        ...t,
        direction: t.from === data.address ? 'Sent' : 'Received'
    }));
    const recentClaimed = rewards.recentClaimed || [];

    const priceConfigured = price && price.configured;
    const priceHistory = (price && price.history) || [];
    const latestPrice = data.price || (price && price.latest) || null;

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2><i class='bx bx-wallet'></i> ${identity ? stakingEscapeHtml(identity) : 'Wallet Dashboard'} ${helpIcon('switching-wallets', 'About the wallet dashboard')}</h2>
                <div style="display:flex; gap:14px; align-items:center;">
                    <a href="/staking-rewards/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">Full reward history</a>
                    <button id="wallet-switch-btn" class="staking-download-btn">Switch wallet</button>
                </div>
            </div>
            <div style="padding: 12px 24px 0;">
                <a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--text-secondary);font-size:0.78rem;">${stakingEscapeHtml(data.address)}</a>
            </div>
            <div class="staking-summary-grid">
                <div class="staking-summary-card">
                    <div class="label">Total Balance</div>
                    <div class="value accent">${stakingFormatPDEX(balance.total)} PDEX</div>
                    <!-- USD subscript. data-pdex-amount lets pollPriceTicker
                         refresh the figure live as the sidebar ticker polls,
                         so it doesn't drift stale while the user is on the
                         page. Initial value uses the price embedded in the
                         wallet payload (or whatever pollPriceTicker has
                         already cached). -->
                    <div class="value-usd" data-pdex-amount="${balance.total}">${renderUsdSubscript(balance.total, latestPrice && latestPrice.price)}</div>
                </div>
                <div class="staking-summary-card"><div class="label">Total Staked</div><div class="value">${stakingFormatPDEX(staking.totalStaked)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Claimed Rewards</div><div class="value">${stakingFormatPDEX(rewards.claimedTotal)} PDEX</div></div>
                <div class="staking-summary-card"><div class="label">Unpaid Rewards</div><div class="value" style="color:var(--brand-primary);">${stakingFormatPDEX(rewards.unpaidTotal)} PDEX${rewards.unclaimedFresh ? '' : ' <span style="font-size:0.6rem;color:var(--text-muted);">computing…</span>'}</div></div>
            </div>
        </div>

        ${isOwnWallet ? `
        <div id="wallet-actions-slot">
            ${hasInjectedWalletNow() ? `
            <div class="wallet-action-bar" id="wallet-action-bar">
                <button class="wallet-action-btn primary" id="wallet-act-send"${(getStakeableBalance(data) > 0) ? '' : ' disabled title="No transferable balance available."'}>
                    <i class='bx bx-paper-plane'></i>
                    <div><strong>Send PDEX</strong><span>Transfer to any Polkadex address</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-stake">
                    <i class='bx bx-plus-circle'></i>
                    <div><strong>Stake more</strong><span>Add bond &amp; choose validators</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-payout"${(rewards.unpaidCount || 0) ? '' : ' disabled title="No unclaimed rewards to pay out."'}>
                    <i class='bx bx-gift'></i>
                    <div><strong>Pay out rewards</strong><span>${stakingFormatNumber(rewards.unpaidCount || 0)} unclaimed entr${(rewards.unpaidCount || 0) === 1 ? 'y' : 'ies'}</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-unstake"${((staking.activeStaked || 0) > 0) ? '' : ' disabled title="No active bond to unstake."'}>
                    <i class='bx bx-minus-circle'></i>
                    <div><strong>Unstake</strong><span>Begin the unbonding period</span></div>
                </button>
                <button class="wallet-action-btn" id="wallet-act-identity">
                    <i class='bx bx-id-card'></i>
                    <div><strong>${data.identity && data.identity !== 'Unknown' ? 'Update identity' : 'Set identity'}</strong><span>Display name, email, twitter</span></div>
                </button>
            </div>` : buildViewOnlyCallout()}
        </div>` : ''}

        <div class="wallet-grid">
            <div class="list-container glass">
                <div class="list-header"><h2>PDEX Price (30d)</h2><span id="wallet-price-header-price" style="color:var(--brand-secondary);font-size:0.85rem;">${latestPrice ? `$${Number(latestPrice.price).toLocaleString('en-US', { maximumFractionDigits: 4 })}` : ''}</span></div>
                <div class="staking-chart-wrap" id="wallet-price-chart-wrap" style="height:220px;">
                    ${priceHistory.length ? '<canvas id="wallet-price-chart"></canvas>' : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem;text-align:center;padding:0 20px;">${priceConfigured ? 'Collecting price history — the chart fills in as data is polled.' : 'Price feed not configured.'}</div>`}
                </div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2>Staking Overview</h2></div>
                <div class="wallet-stat-list">
                    <div class="wallet-stat"><span>Total Staked</span><strong>${stakingFormatPDEX(staking.totalStaked)} PDEX</strong></div>
                    <div class="wallet-stat"><span>Minimum Stake</span><strong>${stakingFormatPDEX(network.minStake)} PDEX</strong></div>
                    <div class="wallet-stat"><span>Active Nominators</span><strong>${stakingFormatNumber(network.activeNominators)} / ${stakingFormatNumber(network.totalNominators)}</strong></div>
                    <div class="wallet-stat"><span>Active Validators</span><strong>${stakingFormatNumber(network.activeValidators)} / ${stakingFormatNumber(network.totalValidators)}</strong></div>
                    <div class="wallet-stat"><span>Staking Period (era)</span><strong>${formatDuration(network.eraDurationMs)}</strong></div>
                    <div class="wallet-stat"><span>Unstaking Period</span><strong>${formatDuration(network.unbondingMs)}</strong></div>
                    <div class="wallet-stat"><span>Current Era</span><strong>${stakingFormatNumber(network.currentEra)}</strong></div>
                </div>
            </div>
        </div>

        <div class="wallet-grid">
            <div class="list-container glass">
                <div class="list-header"><h2>My Validators</h2><span style="color:var(--text-secondary);font-size:0.78rem;">${(staking.nominating || []).length} nominated</span></div>
                <div style="padding: 8px 24px 20px;">${validatorsHtml}</div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2>Recent Staking Rewards</h2><a href="/staking-rewards/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View all</a></div>
                <div id="wallet-recent-rewards-table"></div>
            </div>
        </div>

        <!-- Average APR over a user-selected window. Card sits on its own
             row so the period pills + result get the visual weight they
             deserve as a primary metric on the My Account page. Populated
             by renderWalletAprCard() after the dashboard innerHTML lands. -->
        <div class="list-container glass" id="wallet-apr-card">
            <div class="list-header">
                <h2><i class='bx bx-line-chart' style="vertical-align:middle;color:var(--brand-secondary);"></i> Average APR</h2>
                <div class="reward-filter" id="wallet-apr-periods"></div>
            </div>
            <div id="wallet-apr-body" style="padding:24px;"></div>
        </div>

        <div class="list-container glass">
            <div class="list-header"><h2>Recent Transactions</h2><a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View account</a></div>
            <div id="wallet-recent-tx-table"></div>
        </div>
        <div id="wallet-advanced-section"></div>`;

    // Mount the two small tables. These are typically short snapshots
    // (top ~10 rows), but giving them the same filter/sort affordances as
    // the long-form tables keeps the explorer's UX consistent.
    makeTable({
        container: document.getElementById('wallet-recent-rewards-table'),
        rows: recentClaimed,
        defaultSort: { key: 'era', dir: 'desc' },
        globalSearch: false,
        summarySuffix: 'rewards',
        emptyMessage: 'No claimed rewards indexed yet.',
        columns: [
            {
                key: 'era', label: 'Era',
                sort: (a, b) => (a.era == null ? -1 : a.era) - (b.era == null ? -1 : b.era),
                format: row => row.era != null ? String(row.era) : '—'
            },
            {
                key: 'amount', label: 'Amount',
                sort: (a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0),
                format: row => `<span class="staking-amount">${stakingFormatPDEX(row.amount)} PDEX</span>`
            },
            {
                key: 'timestamp', label: 'Date',
                sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                format: row => `<span style="white-space:nowrap;">${row.timestamp ? stakingEscapeHtml(formatLocalDate(row.timestamp)) : '—'}</span>`
            }
        ]
    });

    makeTable({
        container: document.getElementById('wallet-recent-tx-table'),
        rows: recentTx,
        defaultSort: { key: 'timestamp', dir: 'desc' },
        globalSearch: false,
        summarySuffix: 'transactions',
        emptyMessage: 'No recent transactions.',
        columns: [
            {
                key: 'hash', label: 'Hash',
                format: row => {
                    const short = stakingEscapeHtml(stakingShortAddress(row.hash));
                    // Same defence as the account-details table: event-derived
                    // rows have synthetic 'event-…' hashes — link to block.
                    return (row.eventDerived || !looksLikeTxHash(row.hash))
                        ? `<a href="/block/${row.block}" class="item-link" style="color:var(--brand-secondary);">${short}</a>`
                        : `<a href="/tx/${row.block}/${row.hash}" class="item-link" style="color:var(--brand-secondary);">${short}</a>`;
                }
            },
            {
                key: 'direction', label: 'Direction',
                sort: (a, b) => String(a.direction || '').localeCompare(String(b.direction || '')),
                filter: { type: 'select', options: ['Sent', 'Received'] },
                format: row => `<span class="reward-badge ${row.direction === 'Sent' ? 'unclaimed' : 'claimed'}">${stakingEscapeHtml(row.direction)}</span>`
            },
            {
                key: 'amount', label: 'Amount',
                sort: (a, b) => String(a.amount || '').localeCompare(String(b.amount || '')),
                format: row => stakingEscapeHtml(row.amount || '—')
            },
            {
                key: 'timestamp', label: 'Date',
                sort: (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
                format: row => `<span style="white-space:nowrap;">${row.timestamp ? stakingEscapeHtml(formatLocalDate(row.timestamp)) : '—'}</span>`
            }
        ]
    });

    const switchBtn = document.getElementById('wallet-switch-btn');
    if (switchBtn) switchBtn.addEventListener('click', disconnectWallet);
    if (isOwnWallet) {
        bindWalletActionHandlers();
        bindViewOnlyCalloutHandlers();
        // Mobile wallet WebViews sometimes inject `window.injectedWeb3` a
        // beat after the page settles. If we rendered the view-only callout
        // because nothing was injected at first paint, schedule a couple of
        // re-checks that swap the action bar in once injection lands. We
        // also do the reverse — if the user's wallet session has gone away
        // while the page is open, swap the action bar out for the callout.
        scheduleWalletSigningRechecks(data);
    }
    if (priceHistory.length) renderWalletPriceChart(priceHistory);
    // Mount the Advanced section (proxies + multisig). Fires regardless of
    // ownership — proxies that delegate FROM this address are public chain
    // state, and the multisig calculator works without an active session.
    // Add/Remove proxy buttons are gated on isOwnWallet inside the renderer.
    renderWalletAdvancedSection(data.address || data.account, isOwnWallet);
    // Average APR card — runs after the rest of the dashboard so the
    // ranked widget order on slow connections is: balance/staking →
    // validators/recent → APR. The renderer reads `walletAprData`
    // populated by fetchWalletDashboard and tolerates a null payload
    // (renders an unavailable state).
    renderWalletAprCard();
}

// Wire up the four wallet action buttons. Idempotent — re-binding after a
// re-render of the action bar is safe because each new node has fresh listeners.
function bindWalletActionHandlers() {
    const sendBtn = document.getElementById('wallet-act-send');
    const stakeBtn = document.getElementById('wallet-act-stake');
    const payoutBtn = document.getElementById('wallet-act-payout');
    const unstakeBtn = document.getElementById('wallet-act-unstake');
    const identityBtn = document.getElementById('wallet-act-identity');
    if (sendBtn && !sendBtn.disabled) sendBtn.addEventListener('click', openSendModal);
    if (stakeBtn) stakeBtn.addEventListener('click', openStakeModal);
    if (payoutBtn && !payoutBtn.disabled) payoutBtn.addEventListener('click', openPayoutModal);
    if (unstakeBtn && !unstakeBtn.disabled) unstakeBtn.addEventListener('click', openUnstakeModal);
    if (identityBtn) identityBtn.addEventListener('click', openIdentityModal);
}

// Wire up the "copy URL" affordance inside the read-only callout. The mobile
// wallet deep-link cards are plain anchors so they don't need handlers.
function bindViewOnlyCalloutHandlers() {
    const copyBtn = document.getElementById('wallet-readonly-copy-btn');
    const copyInput = document.getElementById('wallet-readonly-copy-url');
    if (copyBtn && copyInput) copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(copyInput.value);
            copyBtn.innerHTML = "<i class='bx bx-check'></i> Copied!";
            setTimeout(() => { copyBtn.innerHTML = "<i class='bx bx-copy'></i> Copy URL"; }, 1500);
        } catch (e) {
            copyInput.select();
            try { document.execCommand('copy'); } catch (e2) { /* nothing more to try */ }
        }
    });
}

// Build the "read-only mode" callout shown in place of the action bar when
// the dashboard belongs to the user but no wallet extension / mobile wallet
// is currently injecting accounts. Surfaces the same mobile-wallet deep
// links the connect panel uses so the user can hop into a wallet's in-app
// browser in one tap and come back signing-capable.
function buildViewOnlyCallout() {
    const onMobile = isMobileDevice();
    const currentUrl = (typeof location !== 'undefined') ? location.href : 'https://explorer.polkadex.ee/wallet';
    const intro = onMobile
        ? `You're viewing this account in <strong>read-only</strong> mode. To send PDEX, stake, claim rewards, or unbond, open this page inside a mobile wallet's in-app browser so it can sign transactions.`
        : `You're viewing this account in <strong>read-only</strong> mode. To send PDEX, stake, claim rewards, or unbond, connect a Substrate browser extension (Polkadot.js, Talisman, SubWallet) — or open this page in a mobile wallet's in-app browser.`;
    return `<div class="wallet-readonly-callout">
        <div class="wallet-readonly-head">
            <i class='bx bx-show'></i>
            <div>
                <strong>Read-only mode</strong>
                <p>${intro}</p>
            </div>
        </div>
        ${renderMobileWalletCards(currentUrl)}
        <div class="mobile-wallet-copyrow" style="margin-top:8px;">
            <input id="wallet-readonly-copy-url" type="text" readonly value="${stakingEscapeHtml(currentUrl)}">
            <button id="wallet-readonly-copy-btn" type="button"><i class='bx bx-copy'></i> Copy URL</button>
        </div>
    </div>`;
}

// Re-check whether a wallet is currently injected and, if the on-screen state
// is stale, swap the action bar in/out without re-rendering the rest of the
// dashboard. Runs a small bounded sequence of checks so we cover the typical
// 100–1500 ms window in which mobile WebViews inject late.
let _walletSigningRecheckTimer = null;
function scheduleWalletSigningRechecks(data) {
    if (_walletSigningRecheckTimer) { clearTimeout(_walletSigningRecheckTimer); _walletSigningRecheckTimer = null; }
    const delays = [400, 1000, 2000];
    let i = 0;
    const tick = () => {
        const slot = document.getElementById('wallet-actions-slot');
        // If the dashboard was navigated away from, stop polling.
        if (!slot || !isSameAddress(getStoredWallet(), data.address)) return;
        const hasInjection = hasInjectedWalletNow();
        const hasBar = !!document.getElementById('wallet-action-bar');
        const needsBar = hasInjection && !hasBar;
        const needsCallout = !hasInjection && hasBar;
        if (needsBar) {
            slot.innerHTML = buildWalletActionBarMarkup(data);
            bindWalletActionHandlers();
        } else if (needsCallout) {
            slot.innerHTML = buildViewOnlyCallout();
            bindViewOnlyCalloutHandlers();
        }
        if (i < delays.length) {
            _walletSigningRecheckTimer = setTimeout(tick, delays[i++]);
        }
    };
    _walletSigningRecheckTimer = setTimeout(tick, delays[i++]);
}

// Build only the action-bar HTML (used by scheduleWalletSigningRechecks when
// it needs to swap the slot's contents). Mirrors the inline markup in
// renderWalletDashboard so layout/copy stays consistent.
function buildWalletActionBarMarkup(data) {
    const staking = data.staking || {};
    const rewards = data.rewards || {};
    const stakeable = getStakeableBalance(data);
    const unpaid = rewards.unpaidCount || 0;
    const active = staking.activeStaked || 0;
    return `<div class="wallet-action-bar" id="wallet-action-bar">
        <button class="wallet-action-btn primary" id="wallet-act-send"${stakeable > 0 ? '' : ' disabled title="No transferable balance available."'}>
            <i class='bx bx-paper-plane'></i>
            <div><strong>Send PDEX</strong><span>Transfer to any Polkadex address</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-stake">
            <i class='bx bx-plus-circle'></i>
            <div><strong>Stake more</strong><span>Add bond &amp; choose validators</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-payout"${unpaid ? '' : ' disabled title="No unclaimed rewards to pay out."'}>
            <i class='bx bx-gift'></i>
            <div><strong>Pay out rewards</strong><span>${stakingFormatNumber(unpaid)} unclaimed entr${unpaid === 1 ? 'y' : 'ies'}</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-unstake"${active > 0 ? '' : ' disabled title="No active bond to unstake."'}>
            <i class='bx bx-minus-circle'></i>
            <div><strong>Unstake</strong><span>Begin the unbonding period</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-identity">
            <i class='bx bx-id-card'></i>
            <div><strong>${data.identity && data.identity !== 'Unknown' ? 'Update identity' : 'Set identity'}</strong><span>Display name, email, twitter</span></div>
        </button>
    </div>`;
}

function renderWalletPriceChart(history) {
    const canvas = document.getElementById('wallet-price-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (walletPriceChart) { walletPriceChart.destroy(); walletPriceChart = null; }
    walletPriceChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: history.map(p => new Date(p.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
            datasets: [{
                label: 'PDEX / USD',
                data: history.map(p => p.price),
                borderColor: '#00E676',
                backgroundColor: 'rgba(0, 230, 118, 0.12)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.25
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ' $' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 6 }) } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 8, color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: '#888', callback: v => '$' + v }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

// --- Wallet staking actions: stake more, pay out rewards, unstake ---
// `currentWalletData` is the most recently rendered wallet payload; it's the
// data backing each modal so users see live numbers without an extra fetch.
let currentWalletData = null;
let validatorsCache = null;
let validatorsCacheAt = 0;
const VALIDATORS_CACHE_TTL = 60 * 1000;
let stakeSelected = new Map(); // address -> { address, name }
let stakeValidators = [];

async function loadValidatorsForPicker() {
    if (validatorsCache && Date.now() - validatorsCacheAt < VALIDATORS_CACHE_TTL) return validatorsCache;
    const res = await fetch('/api/validators');
    const data = await res.json();
    validatorsCache = Array.isArray(data.validators) ? data.validators.slice() : [];
    // Sort by total stake desc so the top validators surface first.
    validatorsCache.sort((a, b) => (Number(b.totalStake) || 0) - (Number(a.totalStake) || 0));
    validatorsCacheAt = Date.now();
    return validatorsCache;
}

// pdexToPlanck and isPositiveNumberInput are imported from
// ./lib/wallet-safety.js — decimal-string BigInt conversion (audit F-011),
// unit-tested in test/wallet-safety.test.js.

// Some Substrate runtimes use batch / batchAll / forceBatch under utility.
// Audit F-055: this used to PREFER utility.batchAll, which is atomic — one
// inner failure reverts every call in the batch. For reward payouts that is
// the wrong semantics: payoutStakers(validator, era) pairs are independent,
// and a single AlreadyClaimed (someone else triggered that validator's payout
// minutes ago — anyone can) would revert 29 perfectly good claims and charge
// the user a fee for nothing. forceBatch executes every call and reports
// per-item failures; batch stops at the first failure but keeps what already
// executed. batchAll is now the LAST resort, not the first.
function batchTx(api, calls) {
    if (calls.length === 1) return calls[0];
    if (api.tx.utility && api.tx.utility.forceBatch) return api.tx.utility.forceBatch(calls);
    if (api.tx.utility && api.tx.utility.batch) return api.tx.utility.batch(calls);
    if (api.tx.utility && api.tx.utility.batchAll) return api.tx.utility.batchAll(calls);
    throw new Error('utility.batch / batchAll is not available on this runtime.');
}

// staking.bond signature varies: legacy is (controller, value, payee), modern
// is (value, payee). Detect from extrinsic metadata.
function buildBondOrExtra(api, planckStr, stash, hasBond) {
    if (hasBond) return api.tx.staking.bondExtra(planckStr);
    const argCount = (api.tx.staking.bond && api.tx.staking.bond.meta && api.tx.staking.bond.meta.args) ? api.tx.staking.bond.meta.args.length : 2;
    if (argCount >= 3) return api.tx.staking.bond(stash, planckStr, 'Staked');
    return api.tx.staking.bond(planckStr, 'Staked');
}

// Newer staking pallets only expose payoutStakersByPage; older only payoutStakers.
function buildPayoutCall(api, validator, era) {
    if (api.tx.staking.payoutStakers) return api.tx.staking.payoutStakers(validator, era);
    if (api.tx.staking.payoutStakersByPage) return api.tx.staking.payoutStakersByPage(validator, era, 0);
    throw new Error('staking.payoutStakers is not available on this runtime.');
}

// Available balance for staking: `free` from the API includes already-bonded
// tokens (they're locked, not reserved), so we subtract `totalStaked` to get
// the amount the user can actually bond on top of their existing stake.
// Prefers the server-computed `transferable` when present, falls back to
// computing it client-side for resilience.
function getStakeableBalance(data) {
    if (!data || !data.balance) return 0;
    if (typeof data.balance.transferable === 'number') return Math.max(0, data.balance.transferable);
    const free = Number(data.balance.free || 0);
    const staked = Number((data.staking && data.staking.totalStaked) || 0);
    return Math.max(0, free - staked);
}

// --- Stake / Nominate modal ---
function showStakeError(msg) {
    const el = document.getElementById('stake-modal-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function clearStakeError() {
    const el = document.getElementById('stake-modal-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
}

async function openStakeModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    const modal = document.getElementById('stake-modal');
    if (!modal) return;
    clearStakeError();
    const amtInput = document.getElementById('stake-amount-input');
    if (amtInput) amtInput.value = '';

    // Use `transferable` (free - totalStaked) so the hint reflects what's
    // actually available to bond, not the raw free balance which still
    // counts tokens already locked in staking.
    const stakeableBalance = getStakeableBalance(data);
    document.getElementById('stake-available').textContent = stakingFormatPDEX(stakeableBalance);
    document.getElementById('stake-current').textContent = stakingFormatPDEX(data.staking && data.staking.totalStaked) + ' PDEX';
    document.getElementById('stake-minimum').textContent = stakingFormatPDEX(data.network && data.network.minStake) + ' PDEX';

    // Pre-fill selected with the current nominations so the user can curate.
    stakeSelected = new Map();
    for (const v of (data.staking && data.staking.nominating) || []) {
        stakeSelected.set(v.address, { address: v.address, name: v.name });
    }
    renderStakeSelected();
    modal.style.display = 'flex';

    const listEl = document.getElementById('stake-validator-list');
    if (listEl) listEl.innerHTML = '<div class="stake-empty">Loading validators…</div>';
    try {
        stakeValidators = await loadValidatorsForPicker();
    } catch (e) {
        if (listEl) listEl.innerHTML = '<div class="stake-empty">Could not load validators.</div>';
        return;
    }
    renderStakeValidatorList('');
    const searchEl = document.getElementById('stake-validator-search');
    if (searchEl) {
        searchEl.value = '';
        searchEl.oninput = () => renderStakeValidatorList(searchEl.value);
    }
}

function renderStakeValidatorList(filterStr) {
    const listEl = document.getElementById('stake-validator-list');
    if (!listEl) return;
    const f = (filterStr || '').trim().toLowerCase();
    const filtered = stakeValidators.filter(v => {
        if (!f) return true;
        return (v.name || '').toLowerCase().includes(f) || (v.address || '').toLowerCase().includes(f);
    });
    if (!filtered.length) {
        listEl.innerHTML = '<div class="stake-empty">No matching validators.</div>';
        return;
    }
    listEl.innerHTML = filtered.map(v => {
        const isSelected = stakeSelected.has(v.address);
        const name = v.name && v.name !== 'Unknown' ? v.name : stakingShortAddress(v.address);
        const commission = (Number(v.commission) || 0).toFixed(1);
        return `<div class="stake-validator-item${isSelected ? ' selected' : ''}" data-addr="${stakingEscapeHtml(v.address)}">
            <div class="stake-val-info">
                <div class="stake-val-name">${stakingEscapeHtml(name)}</div>
                <div class="stake-val-meta">${stakingFormatPDEX(v.totalStake)} PDEX &middot; ${commission}% comm</div>
            </div>
            <button type="button" class="stake-val-add" ${isSelected ? 'disabled aria-label="Already selected"' : 'aria-label="Add to selection"'}>${isSelected ? '✓' : '+'}</button>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.stake-validator-item').forEach(item => {
        const addr = item.getAttribute('data-addr');
        const addBtn = item.querySelector('.stake-val-add');
        if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); addStakeValidator(addr); });
        item.addEventListener('click', () => addStakeValidator(addr));
    });
}

function addStakeValidator(address) {
    if (stakeSelected.has(address)) return;
    if (stakeSelected.size >= 16) { showStakeError('You can nominate at most 16 validators per transaction.'); return; }
    const v = stakeValidators.find(x => x.address === address) || { address, name: null };
    stakeSelected.set(address, { address, name: v.name });
    renderStakeSelected();
    const searchEl = document.getElementById('stake-validator-search');
    renderStakeValidatorList(searchEl ? searchEl.value : '');
    clearStakeError();
}
function removeStakeValidator(address) {
    stakeSelected.delete(address);
    renderStakeSelected();
    const searchEl = document.getElementById('stake-validator-search');
    renderStakeValidatorList(searchEl ? searchEl.value : '');
}

function renderStakeSelected() {
    const el = document.getElementById('stake-selected-list');
    const countEl = document.getElementById('stake-selected-count');
    const headerCountEl = document.getElementById('stake-chosen-count');
    const n = stakeSelected.size;
    if (countEl) countEl.textContent = `${n} / 16`;
    if (headerCountEl) headerCountEl.textContent = `${n} / 16`;
    if (!el) return;
    if (!n) { el.innerHTML = '<div class="stake-empty">Pick validators from the list on the left.</div>'; return; }
    el.innerHTML = Array.from(stakeSelected.values()).map(v => {
        const name = v.name && v.name !== 'Unknown' ? v.name : stakingShortAddress(v.address);
        return `<div class="stake-validator-item selected" data-addr="${stakingEscapeHtml(v.address)}">
            <div class="stake-val-info">
                <div class="stake-val-name">${stakingEscapeHtml(name)}</div>
                <div class="stake-val-meta">${stakingShortAddress(v.address)}</div>
            </div>
            <button type="button" class="stake-val-remove" aria-label="Remove">×</button>
        </div>`;
    }).join('');
    el.querySelectorAll('.stake-val-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const addr = btn.closest('.stake-validator-item').getAttribute('data-addr');
            removeStakeValidator(addr);
        });
    });
}

async function submitStakeTx() {
    clearStakeError();
    const data = currentWalletData;
    if (!data) return showStakeError('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return showStakeError('Connect this wallet to perform staking actions.');

    const amtStr = (document.getElementById('stake-amount-input').value || '').trim();
    const targets = Array.from(stakeSelected.keys());
    const hasAmount = amtStr !== '' && parseFloat(amtStr) > 0;

    if (!targets.length) return showStakeError('Select at least one validator before submitting.');
    if (targets.length > 16) return showStakeError('At most 16 validators can be nominated.');

    const available = getStakeableBalance(data);
    const hasBond = ((data.staking && data.staking.totalStaked) || 0) > 0;

    if (hasAmount) {
        const amt = parseFloat(amtStr);
        if (!Number.isFinite(amt) || amt <= 0) return showStakeError('Enter a valid amount.');
        // 1e-6 PDEX tolerance absorbs parseFloat / toFixed(4) precision drift
        // so a user who types the displayed balance manually doesn't get a
        // false "exceeds available" rejection. The 0.01 fee buffer below is
        // orders of magnitude larger than this tolerance, so it's still safe.
        const balanceTolerance = 1e-6;
        if (amt > available + balanceTolerance) return showStakeError(`Amount exceeds your available balance (${stakingFormatPDEX(available)} PDEX).`);
        if (amt > available - 0.01 + balanceTolerance) return showStakeError(`Keep at least 0.01 PDEX free for the transaction fee. Try ${stakingFormatPDEX(Math.max(0, available - 0.01))} PDEX or less.`);
        if (!hasBond) {
            const minStake = Number((data.network && data.network.minStake) || 0);
            if (minStake > 0 && amt < minStake) {
                return showStakeError(`A first-time bond must be at least the minimum stake (${stakingFormatPDEX(minStake)} PDEX).`);
            }
        }
    } else if (!hasBond) {
        return showStakeError('You have no existing bond — enter an amount to bond as well.');
    }

    await submitSignedTx({
        buildTx: (api) => {
            const calls = [];
            if (hasAmount) calls.push(buildBondOrExtra(api, pdexToPlanck(amtStr), data.address, hasBond));
            calls.push(api.tx.staking.nominate(targets));
            return batchTx(api, calls);
        },
        label: 'Stake & nominate',
        button: document.getElementById('submit-stake-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Submit',
        onError: showStakeError,
        onSuccess: () => {
            const modal = document.getElementById('stake-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// --- Pay out rewards modal ---
function openPayoutModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    const entries = (data.rewards && data.rewards.unpaidEntries) || [];
    const total = (data.rewards && data.rewards.unpaidTotal) || 0;
    document.getElementById('payout-count').textContent = stakingFormatNumber(entries.length);
    document.getElementById('payout-total').textContent = stakingFormatPDEX(total) + ' PDEX';
    const errEl = document.getElementById('payout-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const listEl = document.getElementById('payout-entries');
    const submitBtn = document.getElementById('submit-payout-tx-btn');
    if (!entries.length) {
        listEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem;">No unclaimed rewards available to pay out. The indexer recomputes unpaid rewards in the background; try again in a minute.</div>';
        if (submitBtn) submitBtn.disabled = true;
    } else {
        listEl.innerHTML = entries.map(e => `<div class="payout-entry">
            <div><span class="payout-era">Era ${stakingFormatNumber(e.era)}</span> <a href="/validator/${encodeURIComponent(e.validator)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">${stakingShortAddress(e.validator)}</a></div>
            <div class="payout-amt">${stakingFormatPDEX(e.amount)} PDEX</div>
        </div>`).join('');
        if (submitBtn) submitBtn.disabled = false;
    }
    document.getElementById('payout-modal').style.display = 'flex';
}

async function submitPayoutTx() {
    const errEl = document.getElementById('payout-modal-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; errEl.style.color = ''; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const data = currentWalletData;
    if (!data) return fail('Wallet data is not loaded.');
    const entries = (data.rewards && data.rewards.unpaidEntries) || [];
    if (!entries.length) return fail('Nothing to claim right now.');
    // Cap at 30 per tx to stay well under per-block weight limits; user can re-trigger.
    const batch = entries.slice(0, 30);
    const truncated = entries.length > batch.length;
    // F-055: say so BEFORE signing, where the decision is made — the tx label
    // alone only tells the user after the fact.
    // NOTE the fail() below resets colour — a review caught this grey staying
    // on a subsequent real error.
    if (truncated && errEl) {
        errEl.style.display = 'block';
        errEl.style.color = 'var(--text-secondary)';
        errEl.textContent = `Claiming the first ${batch.length} of ${entries.length} entries — run Pay Out again afterwards for the rest.`;
    }
    await submitSignedTx({
        buildTx: (api) => batchTx(api, batch.map(e => buildPayoutCall(api, e.validator, e.era))),
        label: 'Payout rewards' + (truncated ? ` (${batch.length} of ${entries.length})` : ''),
        button: document.getElementById('submit-payout-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Pay Out',
        onError: fail,
        onSuccess: () => {
            const modal = document.getElementById('payout-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// --- Unstake modal ---
// When the user clicks Max, we record their intent here AND store the exact
// active-stake planck (a string, u128) from the backend. submitUnstakeTx
// reads this and passes the EXACT planck to staking.unbond(), batched with a
// staking.chill() so the InsufficientBond check at the end of pallet_staking's
// unbond() doesn't reject the call. (Without chill, the runtime sees
// active=0 < MinNominatorBond and traps with WASM unreachable — even though
// "post-unbond active is zero" looks like the user's intent on the surface.
// chill() is idempotent: safe to include even if the stash isn't nominating.)
// Any user keystroke in the input field clears the intent because the user
// has chosen a custom amount.
let unstakeFullUnbondIntent = false;
let unstakeMaxPlanck = null;

function openUnstakeModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    const errEl = document.getElementById('unstake-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    // Reset Max-intent state every time the modal is opened so a previous
    // session's flag doesn't leak into a fresh partial-unbond.
    unstakeFullUnbondIntent = false;
    unstakeMaxPlanck = null;
    const amtInput = document.getElementById('unstake-amount-input');
    if (amtInput) amtInput.value = '';
    const s = data.staking || {};
    document.getElementById('unstake-active').textContent = stakingFormatPDEX(s.activeStaked) + ' PDEX';
    document.getElementById('unstake-unlocking').textContent = stakingFormatPDEX(s.unlocking) + ' PDEX';
    document.getElementById('unstake-period').textContent = formatDuration(data.network && data.network.unbondingMs);
    // Surface the network's minNominatorBond constraint so users see why a
    // "leave a sliver bonded" amount won't be accepted. The chain rejects
    // any partial unbond that would leave a non-zero residue below this
    // threshold; the Max button is the safest way to unbond everything.
    const minBond = Number((data.network && data.network.minStake) || 0);
    const minBondEl = document.getElementById('unstake-min-bond');
    if (minBondEl) minBondEl.textContent = minBond > 0
        ? stakingFormatPDEX(minBond) + ' PDEX'
        : '—';
    document.getElementById('unstake-modal').style.display = 'flex';

    // F-057: check whether any unbond chunks have MATURED. Unbonding is a
    // two-step operation on Substrate — staking.unbond starts the clock, and
    // staking.withdrawUnbonded is what actually releases the funds once the
    // bonding duration passes. The explorer only ever signed step one, while
    // the help page claimed it would "prompt you to withdraw": funds sat
    // withdrawable forever for anyone who took that on faith. Fire-and-forget;
    // the row stays hidden unless the chain confirms something is claimable.
    refreshWithdrawableUnbonded(data.address).catch(() => {});
}

// Read the staking ledger and current era directly from the chain, compute
// which unlocking chunks have matured, and reveal the withdraw button when
// the answer is more than zero.
// The account the staking ledger says must sign withdrawUnbonded (F-057).
let withdrawControllerAddress = null;

async function refreshWithdrawableUnbonded(address) {
    withdrawControllerAddress = null;
    const row = document.getElementById('unstake-withdrawable-row');
    const valEl = document.getElementById('unstake-withdrawable');
    const btn = document.getElementById('submit-withdraw-tx-btn');
    // Hide FIRST, then bail. A review caught the guard preceding the hide:
    // reopening the modal for a different account while the RPC was
    // reconnecting left the previous account's withdrawable amount and an
    // enabled button on screen, labelled as this account's.
    if (row) row.style.display = 'none';
    if (btn) btn.style.display = 'none';
    if (!row || !valEl || !btn || !globalApi) return;

    const bondedOpt = await globalApi.query.staking.bonded(address);
    const controller = (bondedOpt && bondedOpt.isSome) ? bondedOpt.unwrap().toString() : address;
    const ledgerOpt = await globalApi.query.staking.ledger(controller);
    if (!ledgerOpt || !ledgerOpt.isSome) return;
    const ledger = ledgerOpt.unwrap();
    // Remember whose key the runtime will demand. staking.withdrawUnbonded is
    // a CONTROLLER call; on modern unified stash/controller setups they are
    // the same account, but on a split setup signing with the stash fails with
    // NotController — after the row had already told the user funds were
    // ready. A review caught this.
    withdrawControllerAddress = controller;

    // A review caught this reading activeEra. pallet_staking's
    // withdraw_unbonded calls consolidate_unlocked(Self::current_era()), and
    // current_era >= active_era (current is set at session planning), so a
    // chunk maturing at current_era is withdrawable on chain while an
    // active_era test still hides the button — for up to a whole era, which is
    // exactly the "we'll prompt you" promise F-057 is about. Prefer
    // currentEra; fall back to activeEra only if the query is unavailable.
    let currentEra = null;
    try {
        const cur = await globalApi.query.staking.currentEra();
        if (cur && cur.isSome) currentEra = cur.unwrap().toNumber();
    } catch (e) { /* fall through */ }
    if (currentEra === null) {
        const eraOpt = await globalApi.query.staking.activeEra();
        if (!eraOpt || !eraOpt.isSome) return;
        currentEra = eraOpt.unwrap().index.toNumber();
    }

    let withdrawablePlanck = 0n;
    for (const chunk of (ledger.unlocking || [])) {
        if (chunk.era.toNumber() <= currentEra) {
            withdrawablePlanck += BigInt(chunk.value.toString());
        }
    }
    if (withdrawablePlanck <= 0n) return;

    // BigInt split, not Number(planck)/1e12 — the very bug F-043/F-067 fixed
    // elsewhere in this batch, which a review caught me reintroducing here.
    const whole = withdrawablePlanck / 1000000000000n;
    const frac = Number(withdrawablePlanck % 1000000000000n) / 1e12;
    valEl.textContent = stakingFormatPDEX(Number(whole) + frac) + ' PDEX';
    row.style.display = '';
    btn.style.display = '';
    btn.textContent = 'Withdraw unbonded funds';
}

async function submitWithdrawUnbonded() {
    const errEl = document.getElementById('unstake-modal-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; errEl.style.color = ''; } };
    // Clear any stale message first (submitUnstakeTx does; this didn't).
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const data = currentWalletData;
    if (!data) return fail('Wallet data is not loaded.');

    // withdrawUnbonded takes the stash's slashing-span count; passing a low
    // number when spans exist fails with IncorrectSlashingSpans, so read it.
    let spans = 0;
    try {
        const spansOpt = await globalApi.query.staking.slashingSpans(data.address);
        if (spansOpt && spansOpt.isSome) spans = spansOpt.unwrap().prior.length + 1;
    } catch (e) { /* keep 0 — correct for a never-slashed stash */ }

    // F-057: refuse rather than sign a call the runtime will reject. The
    // connected wallet must BE the controller; when stash and controller
    // differ, say which key is needed instead of failing with NotController
    // after the user has already approved a signature.
    const connected = getStoredWallet();
    if (withdrawControllerAddress && connected && !isSameAddress(withdrawControllerAddress, connected)) {
        return fail(`This stash's controller is a different account (${String(withdrawControllerAddress).slice(0, 12)}…). ` +
            'Connect the controller account to withdraw — the runtime only accepts withdrawUnbonded from it.');
    }

    await submitSignedTx({
        buildTx: (api) => api.tx.staking.withdrawUnbonded(spans),
        label: 'Withdraw unbonded',
        button: document.getElementById('submit-withdraw-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Withdraw unbonded funds',
        onError: fail,
        onSuccess: () => {
            const modal = document.getElementById('unstake-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

async function submitUnstakeTx() {
    const errEl = document.getElementById('unstake-modal-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const data = currentWalletData;
    if (!data) return fail('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return fail('Connect this wallet to perform staking actions.');
    const amtStr = (document.getElementById('unstake-amount-input').value || '').trim();
    if (!isPositiveNumberInput(amtStr)) return fail('Enter an amount greater than zero.');

    // Full-unbond fast path: user clicked Max and the backend supplied the
    // exact planck u128. Skip the float-based checks entirely (they were
    // never meaningful for the maximum case) and pass the precise string
    // straight into the unbond call.
    //
    // We MUST batch a staking.chill() before staking.unbond() because the
    // pallet's unbond() runs an InsufficientBond check at the end:
    //     ensure!(ledger.active >= MinNominatorBond, InsufficientBond)
    // when the stash is in Nominators::contains_key. After a full unbond
    // ledger.active is 0, so 0 >= 100 fails and the runtime traps. chill()
    // removes the stash from the Nominators set first, so the post-check
    // computes min_active_bond = 0 and the ensure! passes.
    //
    // utility.batchAll is atomic — either both succeed or both revert, so
    // the user never ends up chilled-but-not-unbonded.
    if (unstakeFullUnbondIntent && unstakeMaxPlanck && /^[0-9]+$/.test(String(unstakeMaxPlanck))) {
        const planckStr = String(unstakeMaxPlanck);
        // Marker so we can confirm from the browser console that the new
        // chill-then-unbond fast-path is actually running. If a user reports
        // "same error", checking the console for this line tells us whether
        // the deployed JS matches the source.
        console.log('[unstake] full-unbond fast-path (chill + unbond) firing, planck=' + planckStr);
        await submitSignedTx({
            buildTx: (api) => {
                if (!api.tx.staking || !api.tx.staking.chill) {
                    throw new Error('Runtime does not expose staking.chill — cannot perform full unbond. Please upgrade the runtime or use a partial unbond.');
                }
                if (!api.tx.staking.unbond) {
                    throw new Error('Runtime does not expose staking.unbond.');
                }
                // batchTx falls back batchAll → batch → single-call so we
                // tolerate runtimes that lack utility.batchAll. Atomicity is
                // best-effort — batch (non-all) keeps going on inner failure
                // but our chill is idempotent so a chill that already-chilled
                // is fine.
                return batchTx(api, [
                    api.tx.staking.chill(),
                    api.tx.staking.unbond(planckStr),
                ]);
            },
            label: 'Unstake',
            button: document.getElementById('submit-unstake-tx-btn'),
            busyText: 'Signing…',
            idleText: 'Sign & Unstake',
            onError: (err) => {
                console.warn('[unstake] full-unbond fast-path errored:', err && (err.message || err));
                fail(decodeUnstakeError(err, {
                    active: Number(data.staking.activeStaked) || 0,
                    amt: Number(data.staking.activeStaked) || 0,
                    minBond: Number((data.network && data.network.minStake) || 0),
                    isFullUnbond: true,
                }));
            },
            onSuccess: () => {
                const modal = document.getElementById('unstake-modal');
                if (modal) modal.style.display = 'none';
                setTimeout(() => fetchWalletDashboard(data.address), 2500);
            }
        });
        return;
    }

    const amt = parseFloat(amtStr);
    const active = Number((data.staking && data.staking.activeStaked) || 0);
    if (active <= 0) return fail('You have no active bonded stake to unbond.');
    // 1e-6 tolerance absorbs the parseFloat-of-toFixed precision drift so a
    // value that visually matches the displayed active stake (e.g. someone
    // typed it from the screen) doesn't get rejected as "exceeds active".
    const exceedsTolerance = 1e-6;
    if (amt > active + exceedsTolerance) return fail(`Amount exceeds your active bonded stake (${stakingFormatPDEX(active)} PDEX).`);

    // Guard against the "leave a sliver bonded" failure mode. The runtime
    // requires the post-unbond residue to be either zero (full unbond, which
    // works in our flow because the Max fast-path batches a chill() before
    // unbond — see above) or at least minNominatorBond. Anything in between
    // gets rejected — and on some runtime versions the rejection surfaces as
    // a WASM trap rather than a clean InvalidTransaction error, which looks
    // scary to users. Catching it here gives them a one-sentence fix instead
    // of a stack trace.
    //
    // Use a small floating-point tolerance for the "full unbond" comparison
    // because parseFloat("165.1328") may round-trip to 165.13279999... etc.
    const minBond = Number((data.network && data.network.minStake) || 0);
    const remaining = active - amt;
    const fullUnbondTolerance = 1e-9;
    if (minBond > 0 && remaining > fullUnbondTolerance && remaining < minBond) {
        return fail(
            `That amount would leave only ${stakingFormatPDEX(remaining)} PDEX bonded — ` +
            `below the network minimum of ${stakingFormatPDEX(minBond)} PDEX. ` +
            `Click Max to unbond everything (${stakingFormatPDEX(active)} PDEX), ` +
            `or enter a smaller amount so that at least ${stakingFormatPDEX(minBond)} PDEX stays bonded.`
        );
    }
    // When the network minimum isn't known (the backend couldn't fetch it, so
    // data.network.minStake is 0 or missing), we can't do the precise check
    // above. Warn the user so a partial unbond doesn't go to chain and trap.
    // The Max button is still safe to use — the fast-path batches chill() +
    // unbond() atomically, so it succeeds regardless of minNominatorBond.
    if (!(minBond > 0) && remaining > fullUnbondTolerance) {
        return fail(
            `The network minimum bond couldn't be read from the chain, so we can't ` +
            `safely validate a partial unbond — the chain may reject it with a runtime ` +
            `error. Click Max to unbond everything (${stakingFormatPDEX(active)} PDEX), ` +
            `or try again in a moment.`
        );
    }

    await submitSignedTx({
        buildTx: (api) => api.tx.staking.unbond(pdexToPlanck(amtStr)),
        label: 'Unstake',
        button: document.getElementById('submit-unstake-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Unstake',
        onError: (err) => fail(decodeUnstakeError(err, { active, amt, minBond })),
        onSuccess: () => {
            const modal = document.getElementById('unstake-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// Translate the scariest runtime errors into one-sentence user guidance.
// The chain returns a WASM unreachable trap when staking.unbond is rejected
// during validate_transaction (e.g., the residue would be below
// minNominatorBond, or post-unbond active=0 while the stash is still in
// Nominators::contains_key). Surfacing the raw stack trace makes users
// think the explorer is broken; this turns it into actionable advice.
function decodeUnstakeError(rawErr, ctx) {
    const msg = (rawErr && (rawErr.message || String(rawErr))) || '';
    // WASM trap from TaggedTransactionQueue_validate_transaction:
    if (/wasm.*unreachable|TaggedTransactionQueue|Verification Error.*1002|InsufficientBond/i.test(msg)) {
        if (ctx && ctx.isFullUnbond) {
            // Max was already used and we already batched chill() + unbond().
            // If this still trapped, the chain state moved under us (e.g., a
            // slash, or the active bond changed between dashboard load and
            // submit). Tell the user to refresh and try again.
            return (
                `The chain rejected this unbond even though the full active bond was ` +
                `requested. Your on-chain stake may have changed since this page loaded — ` +
                `please refresh and try Max again.`
            );
        }
        const lines = [
            `The chain rejected this unbond. The usual cause is that the post-unbond ` +
            `remainder would fall below the network's minNominatorBond.`
        ];
        if (ctx && ctx.active > 0) {
            lines.push(
                `Click Max to unbond everything (${stakingFormatPDEX(ctx.active)} PDEX) — ` +
                `the Max flow automatically chills your nomination first so the runtime ` +
                `accepts a full unbond.`
            );
        }
        return lines.join(' ');
    }
    // Otherwise return the raw message — it's almost always already user-readable.
    return msg || 'Unstake failed. Please try again or refresh the page.';
}

// --- Set / Clear on-chain identity -----------------------------------------
// pallet_identity lets an account register a display name, email, twitter
// handle, etc. Setting identity locks a refundable deposit (basicDeposit +
// fieldDeposit * fields-set). Clearing identity returns the deposit.
//
// Each field is a `Data` enum on chain — { Raw: bytes } for filled, { None }
// for empty. We coerce in `toIdData()` below. The 32-byte field-length cap
// is enforced both client-side (maxlength on the input) and by the runtime.
const IDENTITY_FIELD_KEYS = ['display', 'legal', 'email', 'twitter', 'web', 'riot'];
const IDENTITY_FIELD_MAX_BYTES = 32;

function toIdData(rawStr) {
    const s = (rawStr == null ? '' : String(rawStr)).trim();
    if (!s) return { None: null };
    // Truncate at the byte-length the runtime accepts. UTF-8 bytes !== chars,
    // so we use TextEncoder and truncate by byte count.
    const encoded = new TextEncoder().encode(s);
    if (encoded.length <= IDENTITY_FIELD_MAX_BYTES) return { Raw: s };
    // Truncate to the byte limit and decode back, dropping any partial codepoint.
    const truncated = encoded.slice(0, IDENTITY_FIELD_MAX_BYTES);
    return { Raw: new TextDecoder().decode(truncated) };
}

function showIdentityError(msg) {
    const el = document.getElementById('identity-modal-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function hideIdentityError() {
    const el = document.getElementById('identity-modal-error');
    if (el) { el.style.display = 'none'; el.textContent = ''; }
}

async function openIdentityModal() {
    const address = getStoredWallet();
    if (!address) return alert('Please connect a wallet first.');
    const modal = document.getElementById('identity-modal');
    if (!modal) return;

    // Reset UI to a known state.
    hideIdentityError();
    IDENTITY_FIELD_KEYS.forEach(k => {
        const el = document.getElementById('identity-' + k);
        if (el) el.value = '';
    });
    const pill = document.getElementById('identity-modal-status-pill');
    const depositLine = document.getElementById('identity-modal-deposit');
    const parentWarn = document.getElementById('identity-modal-parent-warning');
    const clearBtn = document.getElementById('clear-identity-tx-btn');
    const submitBtn = document.getElementById('submit-identity-tx-btn');
    if (pill) { pill.textContent = 'Loading…'; pill.style.background = 'rgba(255,255,255,0.08)'; pill.style.color = 'var(--text-secondary)'; }
    if (depositLine) depositLine.textContent = '';
    if (parentWarn) parentWarn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    if (submitBtn) submitBtn.textContent = 'Save identity';

    modal.style.display = 'flex';

    // Fetch current identity + deposit constants. Pre-fill if the address
    // already has one set.
    try {
        const data = await fetchApiJson('/api/identity/' + encodeURIComponent(address));
        // Cache for the deposit calculator
        window._identityDeposit = {
            basicDeposit: Number(data.basicDeposit) || 0,
            fieldDeposit: Number(data.fieldDeposit) || 0,
            existingDeposit: Number(data.deposit) || 0
        };
        // Status pill
        if (pill) {
            if (data.hasIdentity) {
                pill.textContent = 'Identity set';
                pill.style.background = 'rgba(0,230,118,0.15)';
                pill.style.color = '#00E676';
            } else {
                pill.textContent = 'Not set';
                pill.style.background = 'rgba(255,255,255,0.08)';
                pill.style.color = 'var(--text-secondary)';
            }
        }
        // Pre-populate fields from existing identity.
        if (data.hasIdentity && data.info) {
            IDENTITY_FIELD_KEYS.forEach(k => {
                const el = document.getElementById('identity-' + k);
                if (el && data.info[k]) el.value = data.info[k];
            });
            if (clearBtn) clearBtn.style.display = 'inline-block';
            if (submitBtn) submitBtn.textContent = 'Update identity';
        }
        // Sub-identity warning (rare but real).
        if (data.hasParent && parentWarn) {
            parentWarn.style.display = 'block';
            parentWarn.innerHTML = '<b>This account is a sub-identity</b> of a parent. Setting a fresh identity here will overwrite the sub-link, and your address will no longer inherit the parent\'s display name.';
        }
        // Initial deposit estimate.
        updateIdentityDepositEstimate();
    } catch (e) {
        showIdentityError('Could not read current identity: ' + (e && e.message ? e.message : 'unknown error'));
    }
}

function updateIdentityDepositEstimate() {
    const meta = window._identityDeposit;
    const depositLine = document.getElementById('identity-modal-deposit');
    if (!meta || !depositLine) return;
    // Substrate's identity pallet calculates the deposit as:
    //   basicDeposit + fieldDeposit * (additional-fields-count)
    // Here "additional" specifically means fields beyond display. The pallet
    // also treats each non-empty struct field as adding to the byte cost — we
    // approximate by counting non-empty fields beyond display.
    let extraFields = 0;
    IDENTITY_FIELD_KEYS.forEach(k => {
        if (k === 'display') return;
        const el = document.getElementById('identity-' + k);
        if (el && el.value.trim()) extraFields++;
    });
    const estimate = meta.basicDeposit + meta.fieldDeposit * extraFields;
    const verb = meta.existingDeposit > 0 ? 'Currently locked' : 'Deposit';
    depositLine.textContent = `${verb}: ${stakingFormatPDEX(meta.existingDeposit || estimate)} PDEX (refundable on clear)`;
}

async function submitSetIdentity() {
    hideIdentityError();
    const data = currentWalletData;
    if (!data) return showIdentityError('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return showIdentityError('Connect this wallet to set its identity.');

    // Build the info object. The pallet rejects an all-None info object, so we
    // require at least one filled field.
    const info = {};
    let anyFilled = false;
    IDENTITY_FIELD_KEYS.forEach(k => {
        const el = document.getElementById('identity-' + k);
        const val = el ? el.value : '';
        const enc = toIdData(val);
        if (enc.Raw !== undefined) anyFilled = true;
        info[k] = enc;
    });
    // pallet_identity also requires `image` and `additional` (we always send None / []).
    info.image = { None: null };
    info.additional = [];
    if (!anyFilled) return showIdentityError('Fill at least one field — a display name is the most useful.');

    // Light client-side validation on the formats people most often get wrong.
    const email = document.getElementById('identity-email')?.value?.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showIdentityError("That doesn't look like a valid email address.");
    const web = document.getElementById('identity-web')?.value?.trim();
    if (web && !/^https?:\/\//i.test(web)) return showIdentityError('Website should start with http:// or https://');

    // Normalise the twitter handle: strip a leading "@" because the convention
    // varies; chain consumers usually expect the handle without it.
    const twitterEl = document.getElementById('identity-twitter');
    if (twitterEl && twitterEl.value) {
        const v = twitterEl.value.trim().replace(/^@+/, '');
        info.twitter = toIdData(v);
    }

    await submitSignedTx({
        buildTx: (api) => api.tx.identity.setIdentity(info),
        label: 'Set identity',
        button: document.getElementById('submit-identity-tx-btn'),
        busyText: 'Signing…',
        idleText: data && data.identity && data.identity !== 'Unknown' ? 'Update identity' : 'Save identity',
        onError: (m) => showIdentityError(m),
        onSuccess: () => {
            const modal = document.getElementById('identity-modal');
            if (modal) modal.style.display = 'none';
            // Bust the server-side identity cache by re-fetching the dashboard
            // — getIdentity() in server.js memoises but the cache won't have
            // our new value, so the visible name will refresh on next paint.
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

async function submitClearIdentity() {
    hideIdentityError();
    const data = currentWalletData;
    if (!data) return showIdentityError('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return showIdentityError('Connect this wallet to clear its identity.');
    if (!confirm('Clear your on-chain identity and reclaim the deposit? You can set a new identity at any time.')) return;
    await submitSignedTx({
        buildTx: (api) => api.tx.identity.clearIdentity(),
        label: 'Clear identity',
        button: document.getElementById('clear-identity-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Reset (clear)',
        onError: (m) => showIdentityError(m),
        onSuccess: () => {
            const modal = document.getElementById('identity-modal');
            if (modal) modal.style.display = 'none';
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// Wire close + submit + clear + live deposit recalc. Idempotent: callers can
// invoke this multiple times (e.g. after the wallet page is re-rendered) and
// only the first call attaches handlers.
function wireIdentityModalHandlers() {
    const modal = document.getElementById('identity-modal');
    if (!modal || modal.dataset.wired === '1') return;
    modal.dataset.wired = '1';
    const closeBtn = document.getElementById('close-identity-modal');
    if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => {
        // Click outside the inner panel dismisses, matching the other modals.
        if (e.target === modal) modal.style.display = 'none';
    });
    const submitBtn = document.getElementById('submit-identity-tx-btn');
    if (submitBtn) submitBtn.addEventListener('click', submitSetIdentity);
    const clearBtn = document.getElementById('clear-identity-tx-btn');
    if (clearBtn) clearBtn.addEventListener('click', submitClearIdentity);
    // Recalc the deposit estimate as the user types.
    IDENTITY_FIELD_KEYS.forEach(k => {
        const el = document.getElementById('identity-' + k);
        if (el) el.addEventListener('input', updateIdentityDepositEstimate);
    });
}
// Wire once at module load so the modal works even before the user opens it.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireIdentityModalHandlers);
} else {
    wireIdentityModalHandlers();
}

// --- Send / Transfer modal -------------------------------------------------
// Token transfer for the connected wallet. Uses balances.transferKeepAlive by
// default (so the user can't accidentally reap their own account by undershooting
// the existential deposit) and balances.transferAllowDeath if they explicitly
// uncheck "Keep account alive". Falls back to balances.transfer on older
// runtimes that don't expose the split variants. The fee is estimated via
// `tx.paymentInfo(sender)` and refreshed as the recipient/amount changes.
const SEND_FEE_BUFFER = 0.05; // PDEX held back from "Max" to cover fee + slippage.
let sendFeeDebounce = null;
let sendLastFeePDEX = null;     // last estimated fee in PDEX
let sendFeeEstimateFailed = false; // F-116: true while paymentInfo is failing

// F-116: the Sign button follows the estimator's health. Disabled only for an
// estimator FAILURE — an idle/empty form is handled by validation on submit.
function updateSendSignGate() {
    const btn = document.getElementById('submit-send-tx-btn');
    if (!btn) return;
    btn.disabled = sendFeeEstimateFailed;
    btn.title = sendFeeEstimateFailed
        ? 'Fee estimation is failing — the node is not responding. Edit any field to retry.'
        : '';
}
let sendValidRecipient = false; // cached so we don't re-validate on every keystroke

function showSendError(msg) {
    const el = document.getElementById('send-modal-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function clearSendError() {
    const el = document.getElementById('send-modal-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
}

// buildTransferTx is imported from ./lib/wallet-safety.js — keep-alive intent
// binds the method (audit F-054), unit-tested in test/wallet-safety.test.js.

// Existential deposit (in PDEX) read from chain constants.
function getExistentialDepositPDEX() {
    try {
        const ed = globalApi && globalApi.consts && globalApi.consts.balances && globalApi.consts.balances.existentialDeposit;
        if (!ed) return 0;
        return Number(BigInt(ed.toString())) / 1e12;
    } catch (e) { return 0; }
}

// Re-estimate the network fee for the current recipient + amount and paint it
// into the modal's summary row. Debounced so we don't spam the chain on every
// keystroke. Falls back to a sensible buffer if estimation isn't available.
// Monotonic token so a slow paymentInfo that resolves (or rejects) AFTER a
// newer estimate started cannot write its result over the current state. A
// review caught the debounce only cancelling pending TIMERS: an in-flight
// request rejecting late would set sendFeeEstimateFailed on an already-cleared
// form, disabling Sign with no matching fee text.
let sendFeeRequestSeq = 0;

function refreshSendFeeEstimate() {
    if (sendFeeDebounce) clearTimeout(sendFeeDebounce);
    const mySeq = ++sendFeeRequestSeq;
    sendFeeDebounce = setTimeout(async () => {
        const data = currentWalletData;
        const feeEl = document.getElementById('send-fee');
        const amountPreviewEl = document.getElementById('send-amount-preview');
        const recvPreviewEl = document.getElementById('send-recv-preview');
        const toEl = document.getElementById('send-to-input');
        const amtEl = document.getElementById('send-amount-input');
        const keepAliveEl = document.getElementById('send-keep-alive');
        if (!data || !globalApi || !feeEl) return;
        const to = (toEl && toEl.value || '').trim();
        const amtStr = (amtEl && amtEl.value || '').trim();
        const amt = parseFloat(amtStr);
        const validAmt = Number.isFinite(amt) && amt > 0;
        if (amountPreviewEl) amountPreviewEl.textContent = validAmt ? (stakingFormatPDEX(amt) + ' PDEX') : '—';

        if (!sendValidRecipient || !validAmt) {
            feeEl.textContent = '—';
            if (recvPreviewEl) recvPreviewEl.textContent = '—';
            sendLastFeePDEX = null;
            sendFeeEstimateFailed = false;
            updateSendSignGate();
            return;
        }
        try {
            const tx = buildTransferTx(globalApi, to, pdexToPlanck(amtStr), !!(keepAliveEl && keepAliveEl.checked));
            const info = await tx.paymentInfo(data.address);
            const feePlanck = info && info.partialFee ? BigInt(info.partialFee.toString()) : 0n;
            const feePDEX = Number(feePlanck) / 1e12;
            if (mySeq !== sendFeeRequestSeq) return;   // superseded — F-116
            sendLastFeePDEX = feePDEX;
            sendFeeEstimateFailed = false;
            updateSendSignGate();
            feeEl.textContent = feePDEX > 0 ? (stakingFormatPDEX(feePDEX) + ' PDEX') : '~0';
            if (recvPreviewEl) recvPreviewEl.textContent = stakingFormatPDEX(amt) + ' PDEX';
        } catch (e) {
            // Audit F-116: this used to paint "≈ 0.05 PDEX (est.)" — a number
            // we invented — and leave Sign enabled, so a user could authorise
            // a transfer whose fee nobody had measured, against a node that
            // was demonstrably not answering. Say what actually happened and
            // gate the button; the estimate retries on the next input event,
            // and the user can retry by touching any field.
            if (mySeq !== sendFeeRequestSeq) return;   // superseded — F-116
            feeEl.textContent = 'unavailable — node not responding';
            sendLastFeePDEX = null;
            sendFeeEstimateFailed = true;
            updateSendSignGate();
            if (recvPreviewEl) recvPreviewEl.textContent = '—';
        }
    }, 250);
}

function validateSendRecipient() {
    const toEl = document.getElementById('send-to-input');
    const hintEl = document.getElementById('send-to-hint');
    if (!toEl) return;
    const v = (toEl.value || '').trim();
    if (!v) {
        sendValidRecipient = false;
        if (hintEl) { hintEl.textContent = 'Paste a valid Polkadex (SS58 prefix 88) address.'; hintEl.style.color = ''; }
        return;
    }
    if (!isValidPolkadexAddress(v)) {
        sendValidRecipient = false;
        if (hintEl) { hintEl.textContent = 'That address is not valid on Polkadex.'; hintEl.style.color = 'var(--error)'; }
        return;
    }
    const data = currentWalletData;
    if (data && isSameAddress(v, data.address)) {
        sendValidRecipient = false;
        if (hintEl) { hintEl.textContent = 'Cannot send to yourself.'; hintEl.style.color = 'var(--error)'; }
        return;
    }
    sendValidRecipient = true;
    if (hintEl) { hintEl.textContent = 'Address looks good.'; hintEl.style.color = 'var(--success, #2ecc71)'; }
}

function openSendModal() {
    const data = currentWalletData;
    if (!data) return alert('Wallet data is not loaded yet.');
    if (!isSameAddress(getStoredWallet(), data.address)) return alert('Connect this wallet to send PDEX.');
    const modal = document.getElementById('send-modal');
    if (!modal) return;
    clearSendError();
    sendValidRecipient = false;
    sendLastFeePDEX = null;

    const toEl = document.getElementById('send-to-input');
    const amtEl = document.getElementById('send-amount-input');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    const hintEl = document.getElementById('send-to-hint');
    if (hintEl) { hintEl.textContent = 'Paste a valid Polkadex (SS58 prefix 88) address.'; hintEl.style.color = ''; }

    const available = getStakeableBalance(data);
    const availEl = document.getElementById('send-available');
    if (availEl) availEl.textContent = stakingFormatPDEX(available);
    const feeEl = document.getElementById('send-fee');
    if (feeEl) feeEl.textContent = '—';
    // F-116: a previous failure must not leave Sign disabled on a fresh open.
    sendFeeEstimateFailed = false;
    updateSendSignGate();
    const previewEl = document.getElementById('send-amount-preview');
    if (previewEl) previewEl.textContent = '—';
    const recvEl = document.getElementById('send-recv-preview');
    if (recvEl) recvEl.textContent = '—';

    modal.style.display = 'flex';
    // Focus the recipient field for fast keyboard entry.
    setTimeout(() => { if (toEl) toEl.focus(); }, 50);
}

async function submitSendTx() {
    clearSendError();
    const data = currentWalletData;
    if (!data) return showSendError('Wallet data is not loaded.');
    if (!isSameAddress(getStoredWallet(), data.address)) return showSendError('Connect this wallet to send PDEX.');

    const to = (document.getElementById('send-to-input').value || '').trim();
    const amtStr = (document.getElementById('send-amount-input').value || '').trim();
    const keepAlive = !!document.getElementById('send-keep-alive').checked;

    if (!to) return showSendError('Enter a recipient address.');
    if (!isValidPolkadexAddress(to)) return showSendError('That recipient address is not valid on Polkadex.');
    if (isSameAddress(to, data.address)) return showSendError('You cannot send to your own address.');
    if (!isPositiveNumberInput(amtStr)) return showSendError('Enter an amount greater than zero.');
    const amt = parseFloat(amtStr);
    if (!Number.isFinite(amt) || amt <= 0) return showSendError('Enter a valid amount.');

    const available = getStakeableBalance(data);
    const feeBuffer = (sendLastFeePDEX != null) ? Math.max(sendLastFeePDEX * 1.2, SEND_FEE_BUFFER / 5) : SEND_FEE_BUFFER;
    // Float-tolerance pad: the displayed "available" balance is a float that
    // can drift by a few ULPs from the on-chain u128. A user who types the
    // displayed value back in shouldn't get a false "exceeds balance"
    // rejection. The fee buffer below is dynamically computed and orders of
    // magnitude larger than this pad, so it's still safe.
    const balanceTolerance = 1e-6;
    if (amt > available + balanceTolerance) return showSendError(`Amount exceeds your transferable balance (${stakingFormatPDEX(available)} PDEX).`);
    if (amt > available - feeBuffer + balanceTolerance) return showSendError(`Keep at least ~${stakingFormatPDEX(feeBuffer)} PDEX free for the network fee. Try ${stakingFormatPDEX(Math.max(0, available - feeBuffer))} PDEX or less.`);

    // Warn the user if sending below the existential deposit to a recipient
    // that probably doesn't exist yet — the runtime will reject the transfer.
    const ed = getExistentialDepositPDEX();
    if (ed > 0 && amt < ed) {
        return showSendError(`Amount must be at least the existential deposit (${stakingFormatPDEX(ed)} PDEX) when funding a new account.`);
    }

    await submitSignedTx({
        buildTx: (api) => buildTransferTx(api, to, pdexToPlanck(amtStr), keepAlive),
        label: 'Transfer',
        button: document.getElementById('submit-send-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Send',
        onError: showSendError,
        onSuccess: () => {
            const modal = document.getElementById('send-modal');
            if (modal) modal.style.display = 'none';
            // Refresh dashboard a beat later so the chain has finalized the
            // new balances by the time we re-query.
            setTimeout(() => fetchWalletDashboard(data.address), 2500);
        }
    });
}

// One-time wiring of the static modal controls (close buttons, max buttons, submit).
(function wireWalletStakingModals() {
    const closeOn = (modalId, btnId) => {
        const modal = document.getElementById(modalId);
        const btn = document.getElementById(btnId);
        if (btn && modal) btn.addEventListener('click', () => { modal.style.display = 'none'; });
        if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    };
    closeOn('stake-modal', 'close-stake-modal');
    closeOn('payout-modal', 'close-payout-modal');
    closeOn('unstake-modal', 'close-unstake-modal');
    closeOn('send-modal', 'close-send-modal');

    const stakeMax = document.getElementById('stake-max-btn');
    if (stakeMax) stakeMax.addEventListener('click', () => {
        const data = currentWalletData;
        if (!data) return;
        // Max button should propose the transferable balance (free minus
        // already-bonded tokens), keeping a small fee buffer.
        const available = getStakeableBalance(data);
        const usable = Math.max(0, available - 0.01);
        const amtInput = document.getElementById('stake-amount-input');
        if (amtInput) amtInput.value = usable.toFixed(4);
    });
    const stakeClear = document.getElementById('stake-clear-btn');
    if (stakeClear) stakeClear.addEventListener('click', () => {
        stakeSelected.clear();
        renderStakeSelected();
        const searchEl = document.getElementById('stake-validator-search');
        renderStakeValidatorList(searchEl ? searchEl.value : '');
    });
    const stakeSubmit = document.getElementById('submit-stake-tx-btn');
    if (stakeSubmit) stakeSubmit.addEventListener('click', submitStakeTx);

    const unstakeMax = document.getElementById('unstake-max-btn');
    if (unstakeMax) unstakeMax.addEventListener('click', () => {
        const data = currentWalletData;
        if (!data) return;
        const active = Number((data.staking && data.staking.activeStaked) || 0);
        const amtInput = document.getElementById('unstake-amount-input');
        if (amtInput) amtInput.value = active.toFixed(4);
        // Record full-unbond intent + the precise u128 planck the backend
        // returned. submitUnstakeTx will use these to build the unbond call
        // directly from planck, bypassing the float round-trip that breaks
        // both the "amount exceeds active" check and the minNominatorBond
        // residue check when the active stake's planck doesn't divide
        // cleanly into 4-decimal PDEX.
        unstakeFullUnbondIntent = true;
        unstakeMaxPlanck = (data.staking && data.staking.activeStakedPlanck) || null;
    });
    // Any keystroke in the amount field means the user has picked a custom
    // amount — clear the full-unbond intent so submitUnstakeTx falls back to
    // the partial-unbond code path (with its residue check).
    const unstakeAmtInputEl = document.getElementById('unstake-amount-input');
    if (unstakeAmtInputEl) unstakeAmtInputEl.addEventListener('input', () => {
        unstakeFullUnbondIntent = false;
        unstakeMaxPlanck = null;
    });
    const unstakeSubmit = document.getElementById('submit-unstake-tx-btn');
    if (unstakeSubmit) unstakeSubmit.addEventListener('click', submitUnstakeTx);
    // F-057: the second half of unbonding.
    const withdrawBtn = document.getElementById('submit-withdraw-tx-btn');
    if (withdrawBtn) withdrawBtn.addEventListener('click', submitWithdrawUnbonded);

    const payoutSubmit = document.getElementById('submit-payout-tx-btn');
    if (payoutSubmit) payoutSubmit.addEventListener('click', submitPayoutTx);

    // Send modal: Max, submit, live validation, live fee estimate.
    const sendMax = document.getElementById('send-max-btn');
    if (sendMax) sendMax.addEventListener('click', () => {
        const data = currentWalletData;
        if (!data) return;
        // Reserve a small fee buffer — refined to the actual estimated fee
        // (×1.2 for safety) when paymentInfo has returned at least once.
        const available = getStakeableBalance(data);
        const buffer = (sendLastFeePDEX != null) ? Math.max(sendLastFeePDEX * 1.2, SEND_FEE_BUFFER / 5) : SEND_FEE_BUFFER;
        const usable = Math.max(0, available - buffer);
        const amtInput = document.getElementById('send-amount-input');
        if (amtInput) {
            amtInput.value = usable.toFixed(4);
            refreshSendFeeEstimate();
        }
    });
    const sendSubmit = document.getElementById('submit-send-tx-btn');
    if (sendSubmit) sendSubmit.addEventListener('click', submitSendTx);
    const sendTo = document.getElementById('send-to-input');
    if (sendTo) sendTo.addEventListener('input', () => { validateSendRecipient(); refreshSendFeeEstimate(); });
    const sendAmt = document.getElementById('send-amount-input');
    if (sendAmt) sendAmt.addEventListener('input', refreshSendFeeEstimate);
    const sendKeep = document.getElementById('send-keep-alive');
    if (sendKeep) sendKeep.addEventListener('change', refreshSendFeeEstimate);
})();

// --- Donate Page ---
const DONATION_ADDRESSES = [
    { category: 'Coins', asset: 'BTC', network: 'Bitcoin', address: 'bc1qlugkf7vv94yrr4vm54xrjx2zwj9q0cs76pz200', uri: 'bitcoin:' },
    { category: 'Coins', asset: 'ETH', network: 'Ethereum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a', uri: 'ethereum:' },
    { category: 'Coins', asset: 'SOL', network: 'Solana', address: 'H4LTvHcqhP9bqXpEkM1JFBvnh9f8HAfMe66r6pBWD7E7', uri: 'solana:' },
    { category: 'Coins', asset: 'BNB', network: 'BNB Smart Chain', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Coins', asset: 'TRX', network: 'Tron', address: 'TEnrQfBoVpT8q5cscRAYTzA2bqA9b5qWwA', uri: 'tron:' },
    { category: 'Coins', asset: 'DOT', network: 'Polkadot', address: '13wPMFBWzDyNY3DJutMN7b6PJai5PRmW9aTSuS4oDMqnzumL' },
    { category: 'Coins', asset: 'POL', network: 'Polygon', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Coins', asset: 'ETH', network: 'Arbitrum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Coins', asset: 'ADA', network: 'Cardano', address: 'addr1q9szq9mef3wlvdgu95lqgqcvjjeuv998u4nfpeuf4cmlsx9vl55478r077m3v6677thhy6zjdc6hrmaum9nx4l49wtrsn5wq7q' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Tron', address: 'TEnrQfBoVpT8q5cscRAYTzA2bqA9b5qWwA' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Ethereum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Solana', address: 'H4LTvHcqhP9bqXpEkM1JFBvnh9f8HAfMe66r6pBWD7E7' },
    { category: 'Stablecoins', asset: 'USDT', network: 'BNB Smart Chain', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Base', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Arbitrum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Polygon', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Ethereum', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Solana', address: 'H4LTvHcqhP9bqXpEkM1JFBvnh9f8HAfMe66r6pBWD7E7' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Base', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'BNB Smart Chain', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDC', network: 'Polygon', address: '0x12c29206E2c2a9a2EC58cA9F52b1ACF7C36dec8a' },
    { category: 'Stablecoins', asset: 'USDT', network: 'Crypto.org', address: 'cro1sz7rjpwmfyqdsyvhpnpe5ttlczgwn62kzxeuum' }
];
let donatePageRendered = false;

function initDonatePage() {
    const root = document.getElementById('donate-content');
    if (!root || donatePageRendered) return;

    const donateCard = d => {
        const addr = stakingEscapeHtml(d.address);
        const openLink = d.uri
            ? `<a class="donate-open" href="${d.uri}${addr}"><i class='bx bx-wallet'></i> Open in wallet</a>`
            : '';
        return `
        <div class="donate-card">
            <div class="donate-card-head">
                <span class="donate-asset">${stakingEscapeHtml(d.asset)}</span>
                <span class="donate-network">${stakingEscapeHtml(d.network)}</span>
            </div>
            <div class="donate-qr" data-address="${addr}"></div>
            <div class="donate-address" title="${addr}">${addr}</div>
            <div class="donate-actions">
                <button class="donate-copy" data-address="${addr}"><i class='bx bx-copy'></i> Copy address</button>
                ${openLink}
            </div>
        </div>`;
    };

    const coins = DONATION_ADDRESSES.filter(d => d.category === 'Coins');
    const stables = DONATION_ADDRESSES.filter(d => d.category === 'Stablecoins');

    root.innerHTML = `
        <div class="list-container glass donate-hero">
            <h1>Support the Polkadex Explorer</h1>
            <p>This explorer is a free, community-run window into the Polkadex network — no ads, no trackers, no paywalls. Behind the scenes, though, archive RPC nodes, servers, price feeds and continuous development all cost real money and time to keep running.</p>
            <p>If it has ever helped you check a transaction, track a validator or understand your staking rewards, please consider chipping in. A contribution of any size — in any coin, on any network — keeps the data flowing, the project independent, and the explorer free and open for the whole community. Thank you for your support; it means a great deal.</p>
            <p class="donate-note">To donate, scan a QR code with your wallet app or copy the address for the coin and network you use. Pick whichever of the 20+ supported networks below is easiest for you.</p>
        </div>
        <div class="donate-section-title">Coins</div>
        <div class="donate-grid">${coins.map(donateCard).join('')}</div>
        <div class="donate-section-title">Stablecoins &mdash; USDT &amp; USDC</div>
        <div class="donate-grid">${stables.map(donateCard).join('')}</div>
        <div class="donate-disclaimer"><i class='bx bx-info-circle'></i> Always double-check the asset, address and network before sending. Funds sent to the wrong network may be unrecoverable.</div>`;

    // Render a QR code for every address.
    root.querySelectorAll('.donate-qr').forEach(el => {
        const addr = el.getAttribute('data-address');
        if (typeof QRCode !== 'undefined') {
            try {
                new QRCode(el, {
                    text: addr,
                    width: 116,
                    height: 116,
                    colorDark: '#0d0d12',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
            } catch (e) {
                el.innerHTML = '<span class="donate-qr-fallback">QR unavailable</span>';
            }
        } else {
            el.innerHTML = '<span class="donate-qr-fallback">QR unavailable</span>';
        }
    });

    // Copy-to-clipboard buttons.
    root.querySelectorAll('.donate-copy').forEach(btn => {
        btn.addEventListener('click', () => {
            const addr = btn.getAttribute('data-address');
            const done = () => {
                const original = btn.innerHTML;
                btn.innerHTML = "<i class='bx bx-check'></i> Copied!";
                btn.classList.add('copied');
                setTimeout(() => { btn.innerHTML = original; btn.classList.remove('copied'); }, 1600);
            };
            // Audit F-130: this used to be clipboard-API-or-nothing — on a
            // browser where the API is missing or the promise rejects, the
            // button did NOTHING, and a donor could believe an address was
            // copied when it wasn't. That is how funds get sent into the void.
            // Fall back to execCommand, and if BOTH fail say so out loud.
            const fallbackCopy = () => {
                const ta = document.createElement('textarea');
                ta.value = addr;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                let ok = false;
                try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
                document.body.removeChild(ta);
                if (ok) done();
                else {
                    const original = btn.innerHTML;
                    btn.innerHTML = "<i class='bx bx-error-circle'></i> Copy failed — select it manually";
                    setTimeout(() => { btn.innerHTML = original; }, 2600);
                }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(addr).then(done).catch(fallbackCopy);
            } else {
                fallbackCopy();
            }
        });
    });

    donatePageRendered = true;
}

// --- Discussion Board ---
const DISCUSS_TOKEN_KEY = 'pdex_discuss_session';

function getDiscussSession() {
    try {
        const raw = localStorage.getItem(DISCUSS_TOKEN_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.token || !s.address) return null;
        const connected = getStoredWallet();
        if (connected && connected !== s.address) return null;
        return s;
    } catch (e) { return null; }
}

function initDiscussionsPage(threadId) {
    if (threadId) fetchDiscussionThread(threadId);
    else fetchDiscussionThreads();
}

async function fetchDiscussionThreads() {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading discussions…</div>';
    try {
        const res = await fetch('/api/discussions');
        // parseJsonResponse converts an upstream HTML error page (502 / 504)
        // to a clean message instead of "Unexpected token '<'".
        const data = await parseJsonResponse(res);
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        renderThreadList(data.threads || []);
    } catch (e) {
        root.innerHTML = `
            <div class="list-container glass" style="padding:40px;text-align:center;">
                <h3 style="color:var(--error);margin-bottom:8px;">Couldn't load discussions</h3>
                <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:14px;">${stakingEscapeHtml(e.message)}</p>
                <p style="color:var(--text-muted);font-size:0.82rem;">The backend is likely restarting or timing out. Try again in a moment.</p>
                <button id="discussions-retry-btn" class="staking-download-btn" style="margin-top:18px;"><i class='bx bx-refresh'></i> Retry</button>
            </div>`;
        const retry = document.getElementById('discussions-retry-btn');
        if (retry) retry.addEventListener('click', fetchDiscussionThreads);
    }
}

function renderThreadList(threads) {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    root.innerHTML = `
        <div class="list-container glass" style="margin-bottom:20px;">
            <div class="list-header"><h2>Discussions</h2></div>
            <div style="padding:18px 24px;color:var(--text-secondary);font-size:0.88rem;line-height:1.6;">
                A discussion thread opens automatically for every public proposal and council motion. Each thread locks for new posts once its proposal moves to a referendum (voting) or its motion concludes. Sign in with your Substrate wallet to take part.
            </div>
        </div>
        <div class="list-container glass">
            <div class="list-header">
                <h2>Threads</h2>
                <span style="color:var(--text-secondary);font-size:0.8rem;">${threads.length} total</span>
            </div>
            <div id="discussions-threads-table"></div>
        </div>`;

    // makeTable lets users filter by kind (proposal vs motion), status
    // (open vs closed), or title — the previous "two separate sections"
    // layout split that for them statically; this gives them control.
    makeTable({
        container: document.getElementById('discussions-threads-table'),
        rows: threads,
        defaultSort: { key: 'status', dir: 'asc' },  // 'closed' < 'open' alphabetically, but a stable secondary by title gives a deterministic order
        globalSearch: true,
        summarySuffix: 'threads',
        emptyMessage: 'No threads yet — one is created automatically when a proposal or motion appears on-chain.',
        // Threads accumulate one-per-on-chain-proposal-or-motion over time;
        // paginate so the page stays usable as governance history grows.
        pagination: { pageSize: 50, showMoreMax: 200 },
        columns: [
            {
                key: 'title', label: 'Title', searchable: true,
                sort: (a, b) => String(a.title || a.id || '').localeCompare(String(b.title || b.id || '')),
                filter: { type: 'text', placeholder: 'Title…' },
                format: row => `<a href="/discussions/${encodeURIComponent(row.id)}" class="item-link" style="color:var(--brand-secondary);font-weight:500;">${stakingEscapeHtml(row.title || row.id)}</a>`
            },
            {
                key: 'kind', label: 'Kind', searchable: true,
                sort: (a, b) => String(a.kind || '').localeCompare(String(b.kind || '')),
                filter: { type: 'select', options: [
                    { value: 'proposal', label: 'Public Proposal' },
                    { value: 'motion',   label: 'Council Motion' }
                ] },
                format: row => row.kind === 'motion'
                    ? '<span style="color:var(--text-secondary);">Council Motion</span>'
                    : '<span style="color:var(--text-secondary);">Public Proposal</span>'
            },
            {
                key: 'status', label: 'Status',
                sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
                filter: { type: 'select', options: ['open', 'closed'] },
                format: row => row.status === 'open'
                    ? '<span class="reward-badge claimed">Open</span>'
                    : '<span class="reward-badge unclaimed">Closed</span>'
            },
            {
                key: 'postCount', label: 'Posts',
                sort: (a, b) => (a.postCount || 0) - (b.postCount || 0),
                format: row => stakingFormatNumber(row.postCount || 0)
            },
            {
                key: 'closedReason', label: 'Closed reason', searchable: true,
                sort: (a, b) => String(a.closedReason || '').localeCompare(String(b.closedReason || '')),
                format: row => row.closedReason
                    ? `<span style="color:var(--text-muted);font-size:0.85rem;">${stakingEscapeHtml(row.closedReason)}</span>`
                    : '<span style="color:var(--text-muted);">—</span>'
            }
        ]
    });
}

async function fetchDiscussionThread(id) {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading discussion…</div>';
    try {
        const res = await fetch('/api/discussions/' + encodeURIComponent(id));
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        renderThread(data.thread, data.posts || []);
    } catch (e) {
        root.innerHTML = `<div class="list-container glass" style="padding:40px;text-align:center;color:var(--error);">Error: ${stakingEscapeHtml(e.message)}</div>`;
    }
}

function renderThread(thread, posts) {
    const root = document.getElementById('discussions-content');
    if (!root) return;
    const session = getDiscussSession();
    const postsHtml = posts.length
        ? posts.map(p => `
            <div class="discussion-post">
                <div class="discussion-post-head">
                    <a href="/account/${encodeURIComponent(p.author)}" class="item-link" style="color:var(--brand-secondary);font-weight:600;">${stakingEscapeHtml(p.authorName && p.authorName !== 'Unknown' ? p.authorName : stakingShortAddress(p.author))}</a>
                    <span style="color:var(--text-muted);font-size:0.75rem;">${stakingEscapeHtml(formatLocalDateTime(p.createdAt))}</span>
                </div>
                <div class="discussion-post-body">${stakingEscapeHtml(p.content).replace(/\n/g, '<br>')}</div>
            </div>`).join('')
        : '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.86rem;">No posts yet — be the first to comment.</div>';

    let composer;
    if (thread.status === 'closed') {
        composer = `<div class="discussion-closed-note"><i class='bx bx-lock-alt'></i> ${stakingEscapeHtml(thread.closedReason || 'This discussion is closed.')}</div>`;
    } else if (!session) {
        composer = `<div class="discussion-composer">
            <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:10px;">Sign in with your Substrate wallet to join this discussion. You will sign a short message — no transaction, no fees.</p>
            <button id="discuss-signin-btn" class="staking-download-btn"><i class='bx bx-log-in'></i> Sign in with wallet</button>
            <div id="discuss-post-error" class="staking-error" style="display:none;"></div>
        </div>`;
    } else {
        composer = `<div class="discussion-composer">
            <div style="color:var(--text-secondary);font-size:0.78rem;margin-bottom:8px;">Posting as <span style="color:var(--brand-secondary);">${stakingShortAddress(session.address)}</span></div>
            <textarea id="discuss-post-input" class="discussion-textarea" placeholder="Share your thoughts…" maxlength="4000"></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
                <button id="discuss-post-btn" class="staking-download-btn" style="background:var(--brand-primary);color:#fff;border-color:var(--brand-primary);"><i class='bx bx-send'></i> Post</button>
            </div>
            <div id="discuss-post-error" class="staking-error" style="display:none;"></div>
        </div>`;
    }

    const badge = thread.status === 'open'
        ? '<span class="reward-badge claimed">Open</span>'
        : '<span class="reward-badge unclaimed">Closed</span>';
    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2 style="display:flex;align-items:center;gap:10px;">${stakingEscapeHtml(thread.title || thread.id)} ${badge}</h2>
                <a href="/discussions" class="item-link" style="color:var(--text-secondary);font-size:0.8rem;">All discussions</a>
            </div>
            <div class="discussion-posts">${postsHtml}</div>
            ${composer}
        </div>`;

    const signinBtn = document.getElementById('discuss-signin-btn');
    if (signinBtn) signinBtn.addEventListener('click', async () => {
        signinBtn.disabled = true;
        signinBtn.innerHTML = "<i class='bx bx-loader-alt'></i> Check your wallet…";
        const ok = await discussSignIn();
        if (ok) fetchDiscussionThread(thread.id);
        else { signinBtn.disabled = false; signinBtn.innerHTML = "<i class='bx bx-log-in'></i> Sign in with wallet"; }
    });
    const postBtn = document.getElementById('discuss-post-btn');
    if (postBtn) postBtn.addEventListener('click', () => submitDiscussionPost(thread.id));
}

// Locate an extension signer that can sign for the given address.
async function getWalletSigner(address) {
    const injected = window.injectedWeb3;
    if (!injected) return null;
    for (const key of Object.keys(injected)) {
        try {
            const provider = injected[key];
            if (!provider || typeof provider.enable !== 'function') continue;
            const ext = await provider.enable('Polkadex Explorer');
            if (ext && ext.accounts && ext.accounts.get && ext.signer && ext.signer.signRaw) {
                const accs = await ext.accounts.get();
                if (accs.some(a => isSameAddress(a.address, address))) return ext.signer;
            }
        } catch (e) { /* user rejected this extension */ }
    }
    return null;
}

async function discussSignIn() {
    const address = getStoredWallet();
    if (!address) { alert('Connect your wallet first using the button in the top-right.'); return false; }
    try {
        const challRes = await fetch('/api/auth/challenge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address })
        });
        const chall = await challRes.json();
        if (!challRes.ok || chall.error) throw new Error(chall.error || 'Could not start sign-in.');
        const signer = await getWalletSigner(address);
        if (!signer) throw new Error('Could not reach a wallet extension that holds this address.');
        const signed = await signer.signRaw({ address, data: chall.message, type: 'bytes' });
        const verRes = await fetch('/api/auth/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, signature: signed.signature })
        });
        const ver = await verRes.json();
        if (!verRes.ok || ver.error) throw new Error(ver.error || 'Verification failed.');
        localStorage.setItem(DISCUSS_TOKEN_KEY, JSON.stringify({ token: ver.token, address }));
        return true;
    } catch (e) {
        alert('Sign-in failed: ' + e.message);
        return false;
    }
}

async function submitDiscussionPost(threadId) {
    const input = document.getElementById('discuss-post-input');
    const errEl = document.getElementById('discuss-post-error');
    const btn = document.getElementById('discuss-post-btn');
    if (!input) return;
    const content = input.value.trim();
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
    if (!content) { showErr('Write something before posting.'); return; }
    const session = getDiscussSession();
    if (!session) { showErr('Your session has expired — please sign in again.'); fetchDiscussionThread(threadId); return; }
    if (btn) btn.disabled = true;
    if (errEl) errEl.style.display = 'none';
    try {
        const res = await fetch('/api/discussions/' + encodeURIComponent(threadId) + '/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (res.status === 401) { localStorage.removeItem(DISCUSS_TOKEN_KEY); throw new Error('Session expired — please sign in again.'); }
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to post.');
        renderThread(data.thread, data.posts || []);
    } catch (e) {
        showErr(e.message);
        if (btn) btn.disabled = false;
    }
}

// --- Democracy Page ---
let democracyData = null;
let democracyTab = 'overview';
let democracyVoteChart = null;
let democracyTurnoutChart = null;
let democracyTurnoutPctChart = null;
// Per-tab quick-filter pills. These survive tab switches so a user who
// filters Referenda to "Ongoing", switches to Statistics, and comes back to
// Referenda still sees their filter applied.
let democracyReferendaFilter = 'all';
let democracyProposalsSortKey = 'index';

// Map raw indexer status strings to a label + accent color for the corner
// badge on the Democracy/Treasury/Council pages. An unrecognised value
// (most commonly "Error" when the indexer ticks errored) lands in the
// "warn" bucket with the underlying message in a tooltip — much friendlier
// than the bare word "Error" floating in the header.
function indexerStatusBadge(rawStatus, errorMessage) {
    const status = String(rawStatus || 'Unknown');
    if (status === 'Synced') {
        return `<span title="Indexer is up-to-date" style="display:inline-flex;align-items:center;gap:6px;color:var(--success);font-size:0.78rem;">
            <i class='bx bx-check-circle'></i> Synced</span>`;
    }
    if (status === 'Initializing' || status === 'Syncing' || status === 'Backfilling') {
        return `<span title="${stakingEscapeHtml(status)}" style="display:inline-flex;align-items:center;gap:6px;color:#f5a623;font-size:0.78rem;">
            <i class='bx bx-loader-alt bx-spin'></i> ${stakingEscapeHtml(status)}</span>`;
    }
    // 'Error' and any other unrecognised value — clearer wording + tooltip.
    return `<span title="${stakingEscapeHtml(errorMessage || 'Indexer encountered an error on the last tick. It will retry automatically.')}" style="display:inline-flex;align-items:center;gap:6px;color:var(--error);font-size:0.78rem;cursor:help;">
        <i class='bx bx-error-circle'></i> Indexer error</span>`;
}

function initDemocracyPage() {
    democracyTab = 'overview';
    fetchDemocracyData();
}

async function fetchDemocracyData() {
    const root = document.getElementById('democracy-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading democracy data…</div>';
    try {
        const res = await fetch('/api/democracy');
        // Use parseJsonResponse so an upstream HTML error page (Cloudflare
        // 502 / nginx 504 when the indexer is restarting) becomes a clean
        // "backend is unreachable" message instead of the raw "Unexpected
        // token '<'" you'd get from a naïve .json() call.
        const data = await parseJsonResponse(res);
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        democracyData = data;
        renderDemocracy();
        // Deep-link: if we arrived from /calendar with ?ref=N or ?proposal=N,
        // open the matching detail modal now that data is loaded.
        tryOpenFromQueryString('democracy');
    } catch (e) {
        root.innerHTML = `
            <div class="list-container glass" style="padding:40px;text-align:center;">
                <h3 style="color:var(--error);margin-bottom:8px;">Couldn't load democracy data</h3>
                <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:14px;">${stakingEscapeHtml(e.message)}</p>
                <p style="color:var(--text-muted);font-size:0.82rem;">The chain indexer is likely restarting or timing out. Try again in a moment.</p>
                <button id="democracy-retry-btn" class="staking-download-btn" style="margin-top:18px;">
                    <i class='bx bx-refresh'></i> Retry
                </button>
            </div>`;
        const retry = document.getElementById('democracy-retry-btn');
        if (retry) retry.addEventListener('click', fetchDemocracyData);
    }
}

function renderDemocracy() {
    const root = document.getElementById('democracy-content');
    if (!root || !democracyData) return;
    const d = democracyData;
    const tabBtn = (key, label) => `<button class="account-tab${democracyTab === key ? ' active' : ''}" data-demtab="${key}">${label}</button>`;
    let body;
    if (democracyTab === 'referenda') body = renderDemocracyReferenda(d);
    else if (democracyTab === 'proposals') body = renderDemocracyProposals(d);
    else if (democracyTab === 'statistics') body = renderDemocracyStatisticsBody(d);
    else body = renderDemocracyOverview(d);

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header" style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:10px;">
                    <h2 style="margin:0;">Democracy</h2>
                    ${indexerStatusBadge(d.status, d.error)}
                </div>
                <button type="button" class="email-alerts-cta" data-email-subscribe="democracy">
                    <i class='bx bx-envelope'></i> Get email alerts ${helpIcon('email-alerts', 'About email alerts')}
                </button>
            </div>
            <div class="account-tabs" style="margin:0 24px;">
                ${tabBtn('overview', 'Overview')}${tabBtn('referenda', 'Referenda')}${tabBtn('proposals', 'Public Proposals')}${tabBtn('statistics', 'Statistics')}
            </div>
            <div style="padding:24px;">${body}</div>
        </div>`;

    // Mount the sortable tables for the active tab now that the placeholder
    // div is in the DOM.
    if (democracyTab === 'referenda')      mountDemocracyReferendaTable(d.referenda || []);
    else if (democracyTab === 'proposals') mountDemocracyProposalsTable(d.publicProposals || []);

    root.querySelectorAll('[data-demtab]').forEach(btn => {
        btn.addEventListener('click', () => { democracyTab = btn.getAttribute('data-demtab'); renderDemocracy(); });
    });
    // Pill-filter handlers for Referenda / Proposals tabs.
    root.querySelectorAll('[data-demreffilter]').forEach(btn => {
        btn.addEventListener('click', () => {
            democracyReferendaFilter = btn.getAttribute('data-demreffilter');
            renderDemocracy();
        });
    });
    root.querySelectorAll('[data-demproposalsort]').forEach(btn => {
        btn.addEventListener('click', () => {
            democracyProposalsSortKey = btn.getAttribute('data-demproposalsort');
            renderDemocracy();
        });
    });
    if (democracyTab === 'statistics') renderDemocracyCharts(d);
}

function renderDemocracyOverview(d) {
    const lp = Number(d.launchPeriod) || 0;
    const into = lp > 0 ? (d.currentBlock % lp) : 0;
    const remaining = lp > 0 ? (lp - into) : 0;
    const pct = lp > 0 ? Math.floor(into / lp * 100) : 0;
    const remSecs = remaining * 12;
    const remDays = Math.floor(remSecs / 86400);
    const remHrs = Math.floor((remSecs % 86400) / 3600);
    const ext = d.externalProposal;
    return `
        <div class="staking-summary-grid">
            <div class="staking-summary-card"><div class="label">Referenda (total)</div><div class="value accent">${stakingFormatNumber(d.referendumCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Public Proposals (total)</div><div class="value">${stakingFormatNumber(d.publicPropCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Active Referenda</div><div class="value">${stakingFormatNumber(d.activeReferenda)}</div></div>
            <div class="staking-summary-card"><div class="label">Active Proposals</div><div class="value">${stakingFormatNumber(d.activeProposals)}</div></div>
            <div class="staking-summary-card"><div class="label">Launch Period</div><div class="value">${pct}%</div></div>
        </div>
        <div class="wallet-stat-list" style="padding:14px 0 0;">
            <div class="wallet-stat"><span>Launch period length</span><strong>${stakingFormatNumber(lp)} blocks</strong></div>
            <div class="wallet-stat"><span>Next referendum launch in</span><strong>~${remDays}d ${remHrs}h &middot; ${stakingFormatNumber(remaining)} blocks</strong></div>
            <div class="wallet-stat"><span>Current block</span><strong>${stakingFormatNumber(d.currentBlock)}</strong></div>
            <div class="wallet-stat"><span>External proposal</span><strong>${ext ? 'Queued' + (ext.threshold ? ' (' + stakingEscapeHtml(ext.threshold) + ')' : '') : 'None'}</strong></div>
        </div>`;
}

function democracyStatusBadge(s) {
    if (s === 'Ongoing') return '<span class="reward-badge claimed">Ongoing</span>';
    if (s === 'Passed') return '<span class="reward-badge claimed">Passed</span>';
    return '<span class="reward-badge unclaimed">Not Passed</span>';
}

function renderDemocracyReferenda(d) {
    const refs = d.referenda || [];
    if (!refs.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No referenda indexed yet.</div>';
    // The indexer writes one of exactly three status values (server.js:
    // democracy sync): 'Ongoing', 'Passed', 'NotPassed'. Pill keys MUST match
    // those casing-and-spelling exactly — earlier versions used lowercase
    // 'rejected'/'cancelled' here, which silently zeroed every counter and
    // hid all finalised-and-failed referenda from the filter UI.
    const c = { all: refs.length, Ongoing: 0, Passed: 0, NotPassed: 0 };
    for (const r of refs) if (c.hasOwnProperty(r.status)) c[r.status]++;
    const pill = (key, label) =>
        `<button class="reward-filter-btn${democracyReferendaFilter === key ? ' active' : ''}" data-demreffilter="${key}">${label}${c[key] != null ? ` (${stakingFormatNumber(c[key])})` : ''}</button>`;
    return `
        <div class="staking-toolbar" style="margin-bottom:14px;">
            <div class="reward-filter">
                ${pill('all', 'All')}${pill('Ongoing', 'Ongoing')}${pill('Passed', 'Passed')}${pill('NotPassed', 'Not passed')}
            </div>
        </div>
        <div id="dem-referenda-table"></div>`;
}
function mountDemocracyReferendaTable(refs) {
    const el = document.getElementById('dem-referenda-table');
    if (!el) return;
    // Apply the pill filter before handing rows to makeTable. The column
    // filter on Status still works on top of that for fine-grained queries.
    const filtered = democracyReferendaFilter === 'all'
        ? refs
        : refs.filter(r => r.status === democracyReferendaFilter);
    const dash = '<span style="color:var(--text-muted);">—</span>';
    // Map the raw backend status to a human-friendly label for empty-state
    // messaging ("No not-passed referenda" reads wrong).
    const friendlyStatus = {
        Ongoing: 'ongoing',
        Passed: 'passed',
        NotPassed: 'not-passed'
    };
    makeTable({
        container: el, rows: filtered,
        defaultSort: { key: 'refIndex', dir: 'desc' },
        globalSearch: true, summarySuffix: 'referenda',
        emptyMessage: democracyReferendaFilter === 'all'
            ? 'No referenda indexed yet.'
            : `No ${friendlyStatus[democracyReferendaFilter] || democracyReferendaFilter} referenda.`,
        columns: [
            {
                key: 'refIndex', label: 'Referendum', searchable: true,
                sort: (a, b) => (a.refIndex || 0) - (b.refIndex || 0),
                // Clickable — opens the governance-detail modal with the
                // referendum's proposal hash + tally + end block.
                format: row => `<button type="button" class="gov-proposal-link" data-kind="referendum" data-id="${stakingEscapeHtml(String(row.refIndex))}">#${stakingEscapeHtml(String(row.refIndex))}</button>`
            },
            {
                key: 'status', label: 'Status',
                sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
                // Option values match the raw `r.status` stored by the indexer.
                // The label/value form (supported by makeTable) lets the
                // dropdown display "Not Passed" while filtering on 'NotPassed'.
                filter: { type: 'select', options: [
                    'Ongoing',
                    'Passed',
                    { value: 'NotPassed', label: 'Not Passed' }
                ] },
                format: row => democracyStatusBadge(row.status)
            },
            {
                key: 'ayes', label: 'Ayes / Nays (PDEX)',
                sort: (a, b) => (Number(a.ayes) || 0) - (Number(b.ayes) || 0),
                format: row => row.tallyKnown ? `${stakingFormatPDEX(row.ayes)} / ${stakingFormatPDEX(row.nays)}` : dash
            },
            {
                key: 'turnout', label: 'Turnout',
                sort: (a, b) => (Number(a.turnout) || 0) - (Number(b.turnout) || 0),
                format: row => row.tallyKnown ? stakingFormatPDEX(row.turnout) : dash
            },
            {
                key: 'endBlock', label: 'End Block',
                sort: (a, b) => (a.endBlock || 0) - (b.endBlock || 0),
                format: row => stakingFormatNumber(row.endBlock)
            },
            {
                // Voting actions — only meaningful while the referendum is
                // Ongoing. For Passed/NotPassed rows we just render a dash so
                // the column stays aligned. The buttons emit a small data
                // payload; a global delegate (see wireReferendumVoteModal)
                // opens the vote modal with the right side preselected.
                key: '__vote', label: 'Vote',
                format: row => {
                    if (row.status !== 'Ongoing') return '<span style="color:var(--text-muted);">—</span>';
                    return `<div style="display:flex;gap:4px;white-space:nowrap;">
                        <button type="button" class="referendum-vote-trigger reward-filter-btn" data-ref-index="${row.refIndex}" data-side="aye" style="padding:4px 10px;font-size:0.78rem;color:var(--success);border-color:rgba(46,204,113,0.4);" title="Vote Aye">Aye</button>
                        <button type="button" class="referendum-vote-trigger reward-filter-btn" data-ref-index="${row.refIndex}" data-side="nay" style="padding:4px 10px;font-size:0.78rem;color:#e74c3c;border-color:rgba(231,76,60,0.4);" title="Vote Nay">Nay</button>
                    </div>`;
                }
            }
        ]
    });
}

function renderDemocracyProposals(d) {
    const props = d.publicProposals || [];
    if (!props.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No active public proposals. Proposals appear here while they await tabling to a referendum.</div>';
    // Sort pills — Public Proposals don't have multiple statuses (they're all
    // pending tabling), so the prominent filter is "sort by X" instead of
    // "show only status Y". Pills sort by the most useful axes at a glance:
    // newest first (index), most-supported (seconds), biggest deposit.
    const pill = (key, label) =>
        `<button class="reward-filter-btn${democracyProposalsSortKey === key ? ' active' : ''}" data-demproposalsort="${key}">${label}</button>`;
    return `
        <div class="staking-toolbar" style="margin-bottom:14px;">
            <div class="reward-filter">
                ${pill('index', 'Newest')}${pill('seconds', 'Most supported')}${pill('deposit', 'Largest deposit')}
            </div>
        </div>
        <div id="dem-proposals-table"></div>`;
}
function mountDemocracyProposalsTable(props) {
    const el = document.getElementById('dem-proposals-table');
    if (!el) return;
    // Translate the pill into the makeTable defaultSort so its visible state
    // matches the pill selection.
    const defaultSort = democracyProposalsSortKey === 'index'
        ? { key: 'index', dir: 'desc' }
        : democracyProposalsSortKey === 'seconds'
            ? { key: 'seconds', dir: 'desc' }
            : { key: 'deposit', dir: 'desc' };
    makeTable({
        container: el, rows: props,
        defaultSort,
        globalSearch: true, summarySuffix: 'proposals',
        emptyMessage: 'No active public proposals.',
        columns: [
            {
                key: 'index', label: 'Proposal', searchable: true,
                sort: (a, b) => (a.index || 0) - (b.index || 0),
                // Clickable — opens the governance-detail modal with the
                // pre-referendum proposal's hash + deposit + seconds count.
                format: row => `<button type="button" class="gov-proposal-link" data-kind="public-proposal" data-id="${stakingEscapeHtml(String(row.index))}">#${stakingEscapeHtml(String(row.index))}</button>`
            },
            {
                key: 'proposerName', label: 'Proposer', searchable: true,
                sort: (a, b) => String(a.proposerName || a.proposer || '').localeCompare(String(b.proposerName || b.proposer || '')),
                filter: { type: 'text', placeholder: 'Proposer…' },
                format: row => {
                    const who = row.proposerName && row.proposerName !== 'Unknown' ? row.proposerName : stakingShortAddress(row.proposer);
                    return `<a href="/account/${encodeURIComponent(row.proposer)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(who)}</a>`;
                }
            },
            {
                key: 'deposit', label: 'Deposit',
                sort: (a, b) => (Number(a.deposit) || 0) - (Number(b.deposit) || 0),
                format: row => `${stakingFormatPDEX(row.deposit)} PDEX`
            },
            {
                key: 'seconds', label: 'Seconds',
                sort: (a, b) => (Number(a.seconds) || 0) - (Number(b.seconds) || 0),
                format: row => stakingFormatNumber(row.seconds)
            },
            {
                key: 'discussion', label: 'Discussion',
                format: row => `<a href="/discussions/proposal-${row.index}" class="item-link" style="color:var(--brand-secondary);">Discuss</a>`
            }
        ]
    });
}

function renderDemocracyStatisticsBody(d) {
    const known = (d.referenda || []).filter(r => r.tallyKnown).length;
    const note = known === 0
        ? '<div style="padding:0 0 16px;color:var(--text-muted);font-size:0.83rem;line-height:1.6;">Vote tallies are still being collected. Tallies for ongoing referenda are captured live; historical tallies are recovered when the node serves archive state.</div>'
        : '';
    return note + `
        <div class="staking-chart-wrap" style="height:300px;padding:10px 0 0;"><canvas id="dem-vote-chart"></canvas></div>
        <div class="wallet-grid" style="margin-top:18px;">
            <div>
                <div style="color:var(--text-secondary);font-size:0.8rem;font-weight:600;margin-bottom:4px;">Turnout per Referendum (PDEX)</div>
                <div class="staking-chart-wrap" style="height:230px;padding:6px 0 0;"><canvas id="dem-turnout-chart"></canvas></div>
            </div>
            <div>
                <div style="color:var(--text-secondary);font-size:0.8rem;font-weight:600;margin-bottom:4px;">Turnout % of Total Issuance</div>
                <div class="staking-chart-wrap" style="height:230px;padding:6px 0 0;"><canvas id="dem-turnoutpct-chart"></canvas></div>
            </div>
        </div>`;
}

function renderDemocracyCharts(d) {
    if (typeof Chart === 'undefined') return;
    [democracyVoteChart, democracyTurnoutChart, democracyTurnoutPctChart].forEach(c => { if (c) c.destroy(); });
    democracyVoteChart = democracyTurnoutChart = democracyTurnoutPctChart = null;

    const refs = (d.referenda || []).filter(r => r.tallyKnown).slice().sort((a, b) => a.refIndex - b.refIndex);
    if (!refs.length) return;
    const labels = refs.map(r => '#' + r.refIndex);
    const axis = (extra) => Object.assign({
        ticks: { color: '#888', maxTicksLimit: 14 }, grid: { color: 'rgba(255,255,255,0.05)' }
    }, extra || {});

    const voteCanvas = document.getElementById('dem-vote-chart');
    if (voteCanvas) {
        democracyVoteChart = new Chart(voteCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Ayes', data: refs.map(r => r.ayes || 0), backgroundColor: 'rgba(0,230,118,0.6)', borderColor: '#00E676', borderWidth: 1 },
                    { label: 'Nays', data: refs.map(r => r.nays || 0), backgroundColor: 'rgba(230,0,122,0.55)', borderColor: '#E6007A', borderWidth: 1 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } },
                    title: { display: true, text: 'Vote Trend — Ayes vs Nays (PDEX)', color: '#ccc' }
                },
                scales: { x: axis({ stacked: true }), y: axis({ stacked: true, beginAtZero: true, maxTicksLimit: 8 }) }
            }
        });
    }
    const turnoutCanvas = document.getElementById('dem-turnout-chart');
    if (turnoutCanvas) {
        democracyTurnoutChart = new Chart(turnoutCanvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Turnout', data: refs.map(r => r.turnout || 0), backgroundColor: 'rgba(124,108,255,0.6)', borderColor: '#7c6cff', borderWidth: 1 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: axis({ maxTicksLimit: 12 }), y: axis({ beginAtZero: true, maxTicksLimit: 6 }) }
            }
        });
    }
    const pctCanvas = document.getElementById('dem-turnoutpct-chart');
    if (pctCanvas) {
        const issuance = Number(d.totalIssuance) || 0;
        democracyTurnoutPctChart = new Chart(pctCanvas.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Turnout %', data: refs.map(r => issuance > 0 ? (r.turnout / issuance * 100) : 0), backgroundColor: 'rgba(124,108,255,0.6)', borderColor: '#7c6cff', borderWidth: 1 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.parsed.y.toFixed(3) + '%' } } },
                scales: { x: axis({ maxTicksLimit: 12 }), y: axis({ beginAtZero: true, maxTicksLimit: 6, ticks: { color: '#888', callback: v => v + '%' } }) }
            }
        });
    }
}

// --- Event wiring: staking rewards + wallet connect ---
const stakingSearchBtn = document.getElementById('staking-search-btn');
if (stakingSearchBtn) stakingSearchBtn.addEventListener('click', submitStakingSearch);
const stakingAddressInput = document.getElementById('staking-address-input');
const stakingClearBtn = document.getElementById('staking-clear-btn');
const stakingPasteBtn = document.getElementById('staking-paste-btn');

if (stakingAddressInput) {
    stakingAddressInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitStakingSearch();
    });
    stakingAddressInput.addEventListener('input', () => {
        if (stakingClearBtn) {
            stakingClearBtn.style.display = stakingAddressInput.value.length > 0 ? 'inline-block' : 'none';
        }
    });
}

if (stakingClearBtn) {
    stakingClearBtn.addEventListener('click', () => {
        if (stakingAddressInput) {
            stakingAddressInput.value = '';
            stakingClearBtn.style.display = 'none';
            stakingAddressInput.focus();
        }
    });
}

if (stakingPasteBtn) {
    stakingPasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (stakingAddressInput) {
                stakingAddressInput.value = text.trim();
                if (stakingClearBtn) stakingClearBtn.style.display = 'inline-block';
                stakingAddressInput.focus();
            }
        } catch (err) {
            console.error('Failed to read clipboard contents: ', err);
            alert('Failed to access clipboard. Please paste manually.');
        }
    });
}
const connectWalletBtn = document.getElementById('connect-wallet-btn');
if (connectWalletBtn) connectWalletBtn.addEventListener('click', connectWallet);
const disconnectWalletBtn = document.getElementById('disconnect-wallet-btn');
if (disconnectWalletBtn) disconnectWalletBtn.addEventListener('click', disconnectWallet);
refreshConnectWalletButton();

setInterval(() => {
    renderBlocks();
    if (transactions.length > 0) renderTransactions();
}, 10000);

// --- Council Module Logic ---
let councilPalletName = 'elections'; // overridden by the /api/council response
let councilData = null;
// Per-tab filter state for the Motions tab — sticky across re-renders.
// Status keys are namespaced so open and resolved buckets never collide:
//   open_voting | open_approved | open_rejected | open_expired
//   res_executed | res_approved | res_disapproved | res_closed | (or 'all')
let councilMotionsFilter = 'all';
// Call-type filter (e.g. 'treasury.approveProposal'), 'unknown', or 'all'.
let councilCallFilter = 'all';

async function fetchCouncilData() {
    try {
        const response = await fetch('/api/council');
        // Survive HTML error pages from nginx/Cloudflare with a clean message
        // instead of "Unexpected token '<'".
        const data = await parseJsonResponse(response);
        if (data.error) throw new Error(data.error);
        if (data.pallet) councilPalletName = data.pallet;
        councilData = data;

        const members = Array.isArray(data.members) ? data.members : [];
        const runnersUp = Array.isArray(data.runnersUp) ? data.runnersUp : [];
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        const termDuration = Number(data.termDuration) || 0;
        const blocksRemaining = Number(data.blocksRemaining) || 0;

        document.getElementById('council-seats-count').innerText = `${members.length}/${data.desiredMembers || 0}`;
        document.getElementById('council-runnersup-count').innerText = runnersUp.length;
        document.getElementById('council-candidates-count').innerText = candidates.length;

        // Term progress (guarded against a zero/missing term duration).
        const pct = termDuration > 0
            ? Math.min(100, Math.max(0, Math.floor(((termDuration - blocksRemaining) / termDuration) * 100)))
            : 0;
        document.getElementById('council-progress-pct').innerText = `${pct}%`;
        document.getElementById('council-progress-arc').style.strokeDasharray = `${pct}, 100`;

        // Polkadex block time is ~12s
        const remainingSeconds = blocksRemaining * 12;
        const days = Math.floor(remainingSeconds / (24 * 3600));
        const hours = Math.floor((remainingSeconds % (24 * 3600)) / 3600);
        document.getElementById('council-term-remaining').innerText = `${days} days ${hours} hrs`;

        const renderList = (list, elementId) => {
            const el = document.getElementById(elementId);
            if (!el) return;
            if (!list || list.length === 0) {
                el.innerHTML = '<tr><td colspan="2" style="text-align:center; padding:20px;">No accounts found</td></tr>';
                return;
            }
            el.innerHTML = list.map(item => {
                const addr = stakingEscapeHtml(item.address);
                return `
                <tr style="background: rgba(255,255,255,0.02);">
                    <td>
                        <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">${stakingEscapeHtml(item.name || 'Unknown')}</div>
                        <div class="address-cell" data-address="${addr}" style="font-size: 13px;">${addr} <span class="js-copy-address" style="cursor: pointer; color: var(--brand-secondary); margin-left: 8px;">copy</span></div>
                    </td>
                    <td style="text-align: right; font-weight: 600;">
                        ${Number(item.stake || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })} PDEX
                    </td>
                </tr>`;
            }).join('');
            // Audit F-122 (same class, site not listed in the report): copy
            // via listener + escaped data-address, no inline onclick.
            el.querySelectorAll('.js-copy-address').forEach(span => {
                span.addEventListener('click', function () {
                    const holder = this.closest('[data-address]');
                    if (holder) copyToClipboard(this, holder.getAttribute('data-address'));
                });
            });
        };

        renderList(members, 'council-members-list');
        renderList(runnersUp, 'council-runnersup-list');
        renderList(candidates, 'council-candidates-list');
        renderCouncilMotions(data);
        // Deep-link: if we arrived from /calendar with ?motion=N, open the
        // matching motion detail modal now that data is loaded.
        tryOpenFromQueryString('council');
    } catch (err) {
        console.error('Failed to fetch council data', err);
        const failMsg = '<tr><td colspan="2" style="text-align:center; padding:20px; color: var(--error);">Failed to load council data.</td></tr>';
        ['council-members-list', 'council-runnersup-list', 'council-candidates-list'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = failMsg;
        });
        const motionsEl = document.getElementById('council-motions-content');
        if (motionsEl) motionsEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--error);">Failed to load council motions.</div>';
    }
}

// --- Council Motions: rendering + on-chain actions ---
function councilMotionStatus(m, currentBlock) {
    const ayes = (m.ayes || []).length;
    const nays = (m.nays || []).length;
    const threshold = Number(m.threshold) || 0;
    if (threshold && ayes >= threshold) return { key: 'approved', label: 'Threshold met', badge: 'claimed', closeable: true };
    if (threshold && nays >= threshold) return { key: 'rejected', label: 'Rejected', badge: 'unclaimed', closeable: true };
    if (m.end && currentBlock && currentBlock >= m.end) return { key: 'expired', label: 'Voting ended', badge: 'neutral', closeable: true };
    return { key: 'voting', label: 'Voting open', badge: 'neutral', closeable: false };
}

function renderCouncilMotions(data = councilData) {
    const root = document.getElementById('council-motions-content');
    if (!root || !data) return;
    const motions = Array.isArray(data.motions) ? data.motions : [];
    const members = Array.isArray(data.members) ? data.members : [];
    const currentBlock = Number(data.currentBlock) || 0;
    const stored = getStoredWallet();
    const isCouncilMember = !!stored && members.some(m => isSameAddress(m.address, stored));

    if (!data.collectivePallet) {
        root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">Council motions are not available on this runtime.</div>';
        return;
    }

    const summary = `
        <div class="staking-summary-grid" style="margin-bottom:20px;">
            <div class="staking-summary-card"><div class="label">Active Motions</div><div class="value accent">${stakingFormatNumber(motions.length)}</div></div>
            <div class="staking-summary-card"><div class="label">Council Seats</div><div class="value">${stakingFormatNumber(members.length)}</div></div>
            <div class="staking-summary-card"><div class="label">Your Role</div><div class="value" style="font-size:1rem;">${isCouncilMember ? 'Council member' : (stored ? 'Observer' : 'Not connected')}</div></div>
        </div>`;

    // Shared call-type key/label helpers — both open and resolved motions
    // carry section/method, so a single dropdown can filter across both.
    const callKeyOf = (m) => (m.section && m.method) ? `${m.section}.${m.method}` : 'unknown';
    const callLabelOf = (key) => key === 'unknown' ? 'Other / unknown call' : key;

    // Annotate open + resolved into one model so the status and call-type
    // filters span both sections. Status keys are namespaced (open_/res_) so
    // an open "Threshold met" never collides with a resolved "Approved".
    const annotatedOpen = motions.map(m => {
        const st = councilMotionStatus(m, currentBlock);
        return { ...m, __status: st, __statusKey: 'open_' + st.key, __call: callKeyOf(m) };
    });
    const resolved = (Array.isArray(data.motionHistory) ? data.motionHistory : [])
        .filter(m => m.status && m.status !== 'proposed')
        .map(m => ({ ...m, __statusKey: 'res_' + m.status, __call: callKeyOf(m) }));

    // CTA to table a new motion (e.g. a treasury approval). Shown to everyone
    // for discoverability; the modal + submit path prompt to connect and
    // enforce council membership at action time.
    const proposeBtn = `<button type="button" class="reward-filter-btn" id="open-propose-motion-btn" style="border-color:var(--brand-primary);color:var(--brand-primary);font-weight:600;"><i class='bx bx-plus-circle'></i> Propose motion</button>${helpIcon('council-and-motions', 'How to propose, vote on, and close motions')}`;

    // Nothing on chain at all — still surface the Propose action so a council
    // member can open the first motion (the common "empty page" case).
    if (annotatedOpen.length + resolved.length === 0) {
        root.innerHTML = summary
            + (proposeBtn ? `<div class="staking-toolbar" style="margin-bottom:14px;"><div class="reward-filter">${proposeBtn}</div></div>` : '')
            + governanceIndexNote(data.history, 'motions')
            + '<div style="padding:28px;text-align:center;color:var(--text-muted);">No motions are currently open before the council.</div>';
        wireMotionControls(root);
        return;
    }

    // Build the status-pill set (only buckets that actually have rows) and the
    // call-type <select> options, counting across the combined set.
    const STATUS_ORDER = ['open_voting', 'open_approved', 'open_rejected', 'open_expired', 'res_executed', 'res_approved', 'res_disapproved', 'res_closed'];
    const STATUS_LABELS = {
        open_voting: 'Voting open', open_approved: 'Threshold met', open_rejected: 'Rejected', open_expired: 'Voting ended',
        res_executed: 'Executed', res_approved: 'Approved', res_disapproved: 'Disapproved', res_closed: 'Closed'
    };
    const combined = annotatedOpen.concat(resolved);
    const statusCounts = {}, callCounts = {};
    for (const m of combined) {
        statusCounts[m.__statusKey] = (statusCounts[m.__statusKey] || 0) + 1;
        callCounts[m.__call] = (callCounts[m.__call] || 0) + 1;
    }
    // If a previously-selected filter no longer matches anything (data moved
    // on), silently fall back to 'all' so the user never sees a dead view.
    if (councilMotionsFilter !== 'all' && !statusCounts[councilMotionsFilter]) councilMotionsFilter = 'all';
    if (councilCallFilter !== 'all' && !callCounts[councilCallFilter]) councilCallFilter = 'all';

    const statusPills = ['all'].concat(STATUS_ORDER.filter(k => statusCounts[k]))
        .map(k => {
            const label = k === 'all' ? 'All' : STATUS_LABELS[k];
            const count = k === 'all' ? combined.length : statusCounts[k];
            return `<button class="reward-filter-btn${councilMotionsFilter === k ? ' active' : ''}" data-motionfilter="${k}">${label} (${count})</button>`;
        }).join('');

    const callKeys = Object.keys(callCounts).sort((a, b) => {
        if (a === 'unknown') return 1;
        if (b === 'unknown') return -1;
        return a.localeCompare(b);
    });
    const callOptions = `<option value="all"${councilCallFilter === 'all' ? ' selected' : ''}>All calls (${combined.length})</option>`
        + callKeys.map(k => `<option value="${stakingEscapeHtml(k)}"${councilCallFilter === k ? ' selected' : ''}>${stakingEscapeHtml(callLabelOf(k))} (${callCounts[k]})</option>`).join('');

    const toolbar = `
        <div class="staking-toolbar" style="margin-bottom:14px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
            <div class="reward-filter">${statusPills}</div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <label for="motion-call-filter" style="font-size:0.8rem;color:var(--text-muted);">Call type</label>
                <select id="motion-call-filter" class="motion-call-select" style="padding:6px 10px;border-radius:var(--radius-sm);background:rgba(0,0,0,0.3);color:var(--text-primary);border:1px solid var(--border-color);font-size:0.82rem;">${callOptions}</select>
                ${proposeBtn}
            </div>
        </div>`;

    const roleNote = isCouncilMember
        ? '<div style="margin-bottom:16px;color:var(--text-secondary);font-size:0.82rem;">You are a council member — you can propose, vote on, and close motions.</div>'
        : `<div style="margin-bottom:16px;color:var(--text-muted);font-size:0.82rem;">Anyone can view and explore motions. Proposing, voting and closing require a council seat — ${stored ? 'your connected wallet does not hold one.' : 'connect your council wallet to act.'}</div>`;

    // A motion is visible when it passes BOTH the status and call-type filters.
    const matches = (m) => (councilMotionsFilter === 'all' || m.__statusKey === councilMotionsFilter)
        && (councilCallFilter === 'all' || m.__call === councilCallFilter);

    const visibleMotions = annotatedOpen.filter(matches);
    const visibleResolved = resolved.filter(matches);

    const cards = visibleMotions.map(m => {
        const st = m.__status;
        const ayes = (m.ayes || []).length;
        const nays = (m.nays || []).length;
        const threshold = Number(m.threshold) || 0;
        const ayePct = threshold ? Math.min(100, Math.round(ayes / threshold * 100)) : 0;
        const nayPct = threshold ? Math.min(100, Math.round(nays / threshold * 100)) : 0;
        const votedAye = !!stored && (m.ayes || []).includes(stored);
        const votedNay = !!stored && (m.nays || []).includes(stored);
        const idxLabel = (m.index === null || m.index === undefined) ? '—' : ('#' + m.index);

        const argsHtml = (m.args && m.args.length)
            ? `<details class="motion-details"><summary>Call arguments (${m.args.length})</summary>
                 <div class="motion-args">${m.args.map(a => `<div><span>${stakingEscapeHtml(a.name)}</span><code>${stakingEscapeHtml(String(a.value).slice(0, 220))}${String(a.value).length > 220 ? '…' : ''}</code></div>`).join('')}</div>
               </details>`
            : '';

        const voterList = (label, addrs) => {
            if (!addrs || !addrs.length) return '';
            return `<details class="motion-details"><summary>${label} (${addrs.length})</summary>
                <div class="motion-voters">${addrs.map(a => `<a href="/account/${encodeURIComponent(a)}" class="item-link" style="color:var(--brand-secondary);">${stakingShortAddress(a)}</a>`).join('')}</div>
            </details>`;
        };

        // Actions are shown to everyone for discoverability. councilMotionVote /
        // councilMotionClose prompt to connect and enforce council membership at
        // click time, so a non-member simply gets a clear message.
        const actions = `<div class="motion-actions">
                <button class="motion-btn aye motion-aye-btn" data-hash="${m.hash}" data-index="${m.index}" ${votedAye ? 'disabled' : ''}>${votedAye ? 'Voted Aye' : 'Vote Aye'}</button>
                <button class="motion-btn nay motion-nay-btn" data-hash="${m.hash}" data-index="${m.index}" ${votedNay ? 'disabled' : ''}>${votedNay ? 'Voted Nay' : 'Vote Nay'}</button>
                <button class="motion-btn close motion-close-btn" data-hash="${m.hash}" data-index="${m.index}" ${st.closeable ? '' : 'disabled'} title="${st.closeable ? 'Finalize this motion' : 'Available once the vote is decided or has ended'}">Close motion</button>
            </div>`;

        return `<div class="motion-card">
            <div class="motion-card-head">
                <div>
                    ${m.hash
                        ? `<button type="button" class="gov-proposal-link motion-index" data-kind="motion" data-id="${stakingEscapeHtml(m.hash)}" title="View motion details">${stakingEscapeHtml(idxLabel)}</button>`
                        : `<span class="motion-index">${stakingEscapeHtml(idxLabel)}</span>`}
                    <span class="motion-title">${stakingEscapeHtml(m.title || 'Council Motion')}</span>
                </div>
                <span class="reward-badge ${st.badge}">${st.label}</span>
            </div>
            <div class="motion-hash">${stakingEscapeHtml(m.hash)}</div>
            <div class="motion-tally">
                <div class="motion-tally-row"><span>Ayes</span><span>${ayes} / ${threshold} threshold</span></div>
                <div class="motion-bar"><div class="motion-bar-fill aye" style="width:${ayePct}%;"></div></div>
                <div class="motion-tally-row"><span>Nays</span><span>${nays} / ${threshold} threshold</span></div>
                <div class="motion-bar"><div class="motion-bar-fill nay" style="width:${nayPct}%;"></div></div>
            </div>
            <div class="motion-meta">Voting ends at block ${stakingFormatNumber(m.end)}${currentBlock ? ` &middot; current block ${stakingFormatNumber(currentBlock)}` : ''}</div>
            ${argsHtml}
            ${voterList('Aye voters', m.ayes)}
            ${voterList('Nay voters', m.nays)}
            ${actions}
        </div>`;
    }).join('');

    const openSection = visibleMotions.length ? `<div class="motion-list">${cards}</div>` : '';
    const resolvedSection = renderResolvedMotions(visibleResolved);
    const nothingVisible = (visibleMotions.length + visibleResolved.length) === 0
        ? `<div style="padding:28px;text-align:center;color:var(--text-muted);">No motions match the current filters.</div>`
        : '';

    root.innerHTML = summary + toolbar + governanceIndexNote(data.history, 'motions') + roleNote
        + openSection + nothingVisible + resolvedSection;

    wireMotionControls(root);
}

// Wire the filter controls, Propose button, and per-motion action buttons.
// Shared by every render path (including the empty state) so the Propose
// action is always live for council members.
function wireMotionControls(root) {
    root.querySelectorAll('[data-motionfilter]').forEach(btn => {
        btn.addEventListener('click', () => {
            councilMotionsFilter = btn.getAttribute('data-motionfilter');
            renderCouncilMotions();
        });
    });
    const callSel = root.querySelector('#motion-call-filter');
    if (callSel) callSel.addEventListener('change', () => {
        councilCallFilter = callSel.value;
        renderCouncilMotions();
    });
    const proposeBtn = root.querySelector('#open-propose-motion-btn');
    if (proposeBtn) proposeBtn.addEventListener('click', () => openProposeMotionModal());
    root.querySelectorAll('.motion-aye-btn').forEach(b => b.addEventListener('click', () => councilMotionVote(b.getAttribute('data-hash'), b.getAttribute('data-index'), true)));
    root.querySelectorAll('.motion-nay-btn').forEach(b => b.addEventListener('click', () => councilMotionVote(b.getAttribute('data-hash'), b.getAttribute('data-index'), false)));
    root.querySelectorAll('.motion-close-btn').forEach(b => b.addEventListener('click', () => councilMotionClose(b.getAttribute('data-hash'), b.getAttribute('data-index'))));
}

// Resolved (historical) council motions, crawled from chain events.
function resolvedMotionBadge(status) {
    if (status === 'executed') return '<span class="reward-badge claimed">Executed</span>';
    if (status === 'approved') return '<span class="reward-badge claimed">Approved</span>';
    if (status === 'disapproved') return '<span class="reward-badge unclaimed">Disapproved</span>';
    return '<span class="reward-badge neutral">Closed</span>';
}

// Renders the already-filtered list of resolved motions (the caller applies
// the status + call-type filters so this table stays in sync with the open
// cards above it). Returns '' when nothing matches.
function renderResolvedMotions(resolved) {
    if (!Array.isArray(resolved) || !resolved.length) return '';
    const rows = resolved.map(m => {
        // The motion # is keyed by the hash (not motionIndex), because that's
        // what the global click delegate uses to look up the row from
        // councilData.motionHistory — motionIndex can be null on older
        // motions, but hash is always present.
        const idxLabel = (m.motionIndex === null || m.motionIndex === undefined) ? '—' : ('#' + m.motionIndex);
        const idx = m.hash
            ? `<button type="button" class="gov-proposal-link" data-kind="motion" data-id="${stakingEscapeHtml(m.hash)}">${stakingEscapeHtml(idxLabel)}</button>`
            : idxLabel;
        const call = (m.section && m.method) ? `${m.section}.${m.method}` : 'Council Motion';
        const proposer = m.proposer
            ? `<a href="/account/${encodeURIComponent(m.proposer)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(treasuryPartyName(m.proposerName, m.proposer))}</a>`
            : '<span style="color:var(--text-muted);">—</span>';
        const tally = (m.ayes == null && m.nays == null) ? '—' : `${m.ayes || 0} / ${m.nays || 0}`;
        return `<tr>
            <td>${idx}</td>
            <td><span class="motion-title" style="font-size:0.82rem;">${stakingEscapeHtml(call)}</span></td>
            <td>${proposer}</td>
            <td style="text-align:right;">${m.threshold == null ? '—' : m.threshold}</td>
            <td style="text-align:right;">${tally}</td>
            <td style="text-align:right;">${stakingFormatNumber(m.resolvedBlock)}</td>
            <td style="text-align:right;">${resolvedMotionBadge(m.status)}</td>
        </tr>`;
    }).join('');
    return `<div style="margin-top:26px;">
        <h3 style="font-size:0.95rem;color:var(--text-primary);margin-bottom:12px;">Resolved Motions <span style="color:var(--text-muted);font-weight:400;font-size:0.8rem;">(${resolved.length})</span></h3>
        <div class="table-responsive"><table class="data-table">
            <thead><tr><th>Motion</th><th>Call</th><th>Proposer</th><th style="text-align:right;">Threshold</th><th style="text-align:right;">Ayes / Nays</th><th style="text-align:right;">Resolved Block</th><th style="text-align:right;">Outcome</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>
    </div>`;
}

function councilMotionVote(hash, index, approve) {
    if (!councilData || !councilData.collectivePallet) return alert('Council data is not ready yet.');
    if (!requireWallet('vote on council motions')) return;
    const stored = getStoredWallet();
    if (!(councilData.members || []).some(m => isSameAddress(m.address, stored)))
        return alert('Only council members can vote on motions. Your connected wallet does not hold a council seat.');
    // Validate the index BEFORE building the call.
    //
    // `index` arrives as a DOM attribute string, and the backend leaves it null
    // whenever council.voting() returns None (a closed motion, or a stale
    // snapshot). Rendered into the attribute that becomes the literal "null" or
    // "undefined". Passing those through to polkadot-js is dangerous in two
    // different ways, both verified:
    //   Number("null") -> NaN        -> Compact<u32> THROWS (loud, harmless)
    //   null/undefined -> encodes as 0 -> a vote silently cast on motion #0
    // The second is the dangerous one: a governance vote landing on the wrong
    // motion with no error at all. Refuse anything that isn't a real index.
    // Note the empty-string case: Number("") === 0, which is a VALID index, so
    // a blank attribute would sail through a numeric check and cast a real vote
    // on motion #0. Require the raw value to look like digits before converting.
    const rawIndex = String(index == null ? '' : index).trim();
    const idx = /^\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;
    if (!Number.isInteger(idx) || idx < 0) {
        return alert(`This motion has no on-chain vote index available, so a vote can't be cast safely.\n\n` +
                     `That usually means the motion just closed, or the page data is stale — reload and try again.\n\n` +
                     `(Refusing rather than guessing: an unset index would encode as 0 and cast your vote on motion #0.)`);
    }
    if (!confirm(`Cast a ${approve ? 'AYE' : 'NAY'} vote on council motion #${idx}?`)) return;
    const pallet = councilData.collectivePallet;
    submitSignedTx({
        buildTx: (api) => {
            const tx = api.tx[pallet].vote(hash, idx, approve);
            // Log what we actually encode. When a submission fails at the node
            // (e.g. a validate_transaction panic) this is the only way to tell
            // "the explorer built a bad call" apart from "this node rejected a
            // good call" — paste it beside the same vote from polkadot.js and
            // the bytes either match or they don't.
            //
            // signedExtensions is logged too, and matters as much as the call:
            // a correct call inside a malformed envelope still panics the
            // runtime, and that is exactly how the CheckMetadataHash bug hid
            // for weeks — the call hex was perfect every time. If the runtime
            // declares an extension that is missing from this list, the
            // envelope is wrong, not the call.
            try {
                console.info('[council.vote] pallet=%s hash=%s index=%s approve=%s\n  call=%s\n  endpoint=%s\n  runtime=%s/%s\n  signedExtensions=%s',
                    pallet, hash, idx, approve,
                    tx.method.toHex(),
                    (api._options && api._options.provider && api._options.provider.endpoint) || 'unknown',
                    api.runtimeVersion.specName.toString(), api.runtimeVersion.specVersion.toString(),
                    (api.registry.signedExtensions || []).join(','));
            } catch (e) { /* diagnostics must never block a vote */ }
            return tx;
        },
        label: `Motion #${idx} ${approve ? 'aye' : 'nay'} vote`,
        onSuccess: () => setTimeout(fetchCouncilData, 2500)
    });
}

function councilMotionClose(hash, index) {
    if (!councilData || !councilData.collectivePallet) return alert('Council data is not ready yet.');
    if (!requireWallet('close council motions')) return;
    const stored = getStoredWallet();
    if (!(councilData.members || []).some(m => isSameAddress(m.address, stored)))
        return alert('Only council members can close motions. Your connected wallet does not hold a council seat.');
    const idx = Number(index);
    const motion = (councilData.motions || []).find(m => m.hash === hash);
    if (!motion) return alert('Motion details are no longer available — refresh the page.');
    if (!confirm(`Close council motion #${idx}?\n\nThis finalizes the vote and, if it passed, dispatches the proposed call.`)) return;
    const pallet = councilData.collectivePallet;
    const weightBound = { refTime: motion.weightRefTime || '10000000000', proofSize: motion.weightProofSize || '500000' };
    submitSignedTx({
        buildTx: (api) => api.tx[pallet].close(hash, idx, weightBound, motion.lengthBound || 0),
        label: `Motion #${idx} close`,
        onSuccess: () => setTimeout(fetchCouncilData, 2500)
    });
}

// --- Propose a council motion -------------------------------------------------
// The collective takes a *call* to dispatch if the motion passes. We currently
// support the two treasury approvals a council most often tables — approve and
// reject a pending treasury proposal — built as treasury.approveProposal(id) /
// treasury.rejectProposal(id) and wrapped in <pallet>.propose(threshold, call,
// lengthBound). Threshold defaults to a simple majority of the current seats.
function councilSimpleMajority() {
    const seats = (councilData && Array.isArray(councilData.members)) ? councilData.members.length : 0;
    return seats ? Math.floor(seats / 2) + 1 : 1;
}

function openProposeMotionModal(prefill) {
    const modal = document.getElementById('council-propose-modal');
    if (!modal) return;
    // Guard against being passed a DOM Event when used directly as a click
    // handler — only a plain {callType, proposalId} object is treated as prefill.
    const pf = (prefill && typeof prefill === 'object' && !(prefill instanceof Event)) ? prefill : null;
    const stored = getStoredWallet();
    const members = (councilData && Array.isArray(councilData.members)) ? councilData.members : [];
    const isMember = !!stored && members.some(m => isSameAddress(m.address, stored));

    const warn = document.getElementById('propose-modal-wallet-warning');
    if (warn) {
        if (!stored) { warn.innerHTML = buildWalletConnectPrompt(); warn.style.display = 'block'; }
        else if (!isMember) { warn.textContent = 'Only council members can propose a motion.'; warn.style.display = 'block'; }
        else { warn.style.display = 'none'; warn.textContent = ''; }
    }
    const activeEl = document.getElementById('propose-active-wallet');
    if (activeEl) activeEl.textContent = stored || '--';

    const thInput = document.getElementById('propose-threshold');
    if (thInput && !thInput.value) thInput.value = String(councilSimpleMajority());
    const seatHint = document.getElementById('propose-threshold-hint');
    if (seatHint) seatHint.textContent = members.length ? `Council has ${members.length} seats — simple majority is ${councilSimpleMajority()}.` : '';

    // Prefill from a treasury proposal ("convert to motion") if provided.
    if (pf && pf.callType) {
        const sel = document.getElementById('propose-call-type');
        if (sel) sel.value = pf.callType;
    }
    if (pf && pf.proposalId != null && pf.proposalId !== '') {
        const idEl = document.getElementById('propose-proposal-id');
        if (idEl) idEl.value = String(pf.proposalId);
    }

    const errEl = document.getElementById('propose-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    modal.style.display = 'flex';
}

async function submitProposeMotion() {
    const errEl = document.getElementById('propose-modal-error');
    const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    if (!councilData || !councilData.collectivePallet) return showErr('Council data is not ready yet — try again in a moment.');
    const stored = getStoredWallet();
    const members = Array.isArray(councilData.members) ? councilData.members : [];
    if (!stored) return showErr('Please connect your wallet first.');
    if (!members.some(m => isSameAddress(m.address, stored))) return showErr('Only council members can propose a motion.');

    const callType = (document.getElementById('propose-call-type') || {}).value || 'treasury.approveProposal';
    const proposalId = parseInt((document.getElementById('propose-proposal-id') || {}).value, 10);
    const threshold = parseInt((document.getElementById('propose-threshold') || {}).value, 10);

    if (!Number.isInteger(proposalId) || proposalId < 0) return showErr('Enter a valid treasury proposal # (a whole number).');
    if (!Number.isInteger(threshold) || threshold < 1) return showErr('Approval threshold must be a whole number of at least 1.');
    const seats = members.length;
    if (seats && threshold > seats) return showErr(`Threshold can't exceed the ${seats} council seats.`);

    const pallet = councilData.collectivePallet;
    await submitSignedTx({
        buildTx: (api) => {
            if (!api.tx.treasury || (!api.tx.treasury.approveProposal && !api.tx.treasury.rejectProposal)) {
                throw new Error('The treasury pallet is not available on this runtime.');
            }
            const inner = callType === 'treasury.rejectProposal'
                ? api.tx.treasury.rejectProposal(proposalId)
                : api.tx.treasury.approveProposal(proposalId);
            // length_bound must be >= the SCALE-encoded length of the proposed
            // call. Pass the Call (inner.method), not the wrapping extrinsic.
            const proposalCall = inner.method;
            return api.tx[pallet].propose(threshold, proposalCall, proposalCall.encodedLength);
        },
        label: `Propose ${callType}(#${proposalId})`,
        button: document.getElementById('submit-propose-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Submit Motion',
        onError: showErr,
        onSuccess: () => {
            const modal = document.getElementById('council-propose-modal');
            if (modal) modal.style.display = 'none';
            const idEl = document.getElementById('propose-proposal-id');
            if (idEl) idEl.value = '';
            setTimeout(fetchCouncilData, 2500);
        }
    });
}

(function wireProposeMotionModal() {
    const modal = document.getElementById('council-propose-modal');
    if (!modal) return;
    const closeBtn = document.getElementById('close-propose-modal');
    const submitBtn = document.getElementById('submit-propose-tx-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    if (submitBtn) submitBtn.addEventListener('click', submitProposeMotion);
})();

// Tab switching
const councilTabs = document.querySelectorAll('.council-page .account-tab');
councilTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        councilTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const targetId = tab.getAttribute('data-tab');
        document.querySelectorAll('.council-page .account-tab-content').forEach(c => {
            c.classList.remove('active');
            c.style.display = 'none';
        });
        const activeContent = document.getElementById(targetId);
        if (activeContent) {
            activeContent.classList.add('active');
            activeContent.style.display = 'block';
        }
    });
});

// Modals
const candidacyModal = document.getElementById('council-candidacy-modal');
const voteModal = document.getElementById('council-vote-modal');

if (document.getElementById('council-submit-candidacy-btn')) {
    document.getElementById('council-submit-candidacy-btn').addEventListener('click', () => {
        candidacyModal.style.display = 'flex';
        checkWalletForCouncil('candidacy');
    });
}
if (document.getElementById('close-candidacy-modal')) {
    document.getElementById('close-candidacy-modal').addEventListener('click', () => {
        candidacyModal.style.display = 'none';
    });
}

if (document.getElementById('council-vote-btn')) {
    document.getElementById('council-vote-btn').addEventListener('click', () => {
        openCouncilVoteModal();
    });
}
if (document.getElementById('close-vote-modal')) {
    document.getElementById('close-vote-modal').addEventListener('click', () => {
        voteModal.style.display = 'none';
    });
}

// ─── Council vote: dual-list candidate picker ──────────────────────────────
// State for the picker. Keyed by Polkadex SS58 so the lookup matches what
// /api/council returns. Cleared on each modal open so a previous session's
// selection doesn't leak into a new vote.
let councilVoteCandidates = [];                 // full pool: members + runners-up + candidates
const councilVoteSelected = new Map();          // address -> { address, name, stake, role }
let councilVoteSearchTerm = '';

async function openCouncilVoteModal() {
    voteModal.style.display = 'flex';
    checkWalletForCouncil('vote');
    // Reset state. We intentionally do NOT preserve the previous selection
    // because the candidate pool may have changed since the last open
    // (election round rolled over, new candidates joined).
    councilVoteSelected.clear();
    councilVoteSearchTerm = '';
    const searchEl = document.getElementById('council-vote-search');
    if (searchEl) searchEl.value = '';
    const stakeInputEl = document.getElementById('vote-stake-input');
    if (stakeInputEl) stakeInputEl.value = '';
    const votableEl = document.getElementById('council-vote-votable');
    if (votableEl) votableEl.innerHTML = 'Available: <strong style="color: var(--text-secondary);">—</strong> PDEX';
    renderCouncilVoteSelected();

    const availList = document.getElementById('council-vote-available-list');
    if (availList) availList.innerHTML = '<div class="council-vote-empty">Loading candidates…</div>';

    const connectedAddress = getStoredWallet();

    try {
        // Fan out three reads in parallel:
        //   - /api/council            → candidate pool + pallet name
        //   - electionsPallet.voting  → user's existing vote (if connected)
        //   - system.account          → user's free balance (if connected)
        // Each chain query is optional and is wrapped in a catch so the
        // picker still works if the user isn't connected or chain RPC has
        // a blip on this particular query.
        const councilPromise = fetch('/api/council', { cache: 'no-store' }).then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
        const votingPromise = (connectedAddress && globalApi && globalApi.query && globalApi.query[councilPalletName] && globalApi.query[councilPalletName].voting)
            ? globalApi.query[councilPalletName].voting(connectedAddress).then(v => v).catch(() => null)
            : Promise.resolve(null);
        const accountPromise = (connectedAddress && globalApi && globalApi.query && globalApi.query.system && globalApi.query.system.account)
            ? globalApi.query.system.account(connectedAddress).then(a => a).catch(() => null)
            : Promise.resolve(null);

        const [data, voting, accountInfo] = await Promise.all([councilPromise, votingPromise, accountPromise]);

        // Combine all three pools with role tags. A voter can vote for any
        // current member (to re-elect), runner-up, or new candidate — chain
        // doesn't care which bucket the target is in, only that it's a
        // registered candidate for the current election round.
        const taggedMembers   = (data.members   || []).map(c => ({ ...c, role: 'member' }));
        const taggedRunnersUp = (data.runnersUp || []).map(c => ({ ...c, role: 'runner-up' }));
        const taggedCandidates= (data.candidates|| []).map(c => ({ ...c, role: 'candidate' }));
        // De-dupe by address — an address can only appear in one bucket at
        // a time on chain, but guard against an edge case where the API
        // briefly reports overlap during a round transition.
        const seen = new Set();
        councilVoteCandidates = [...taggedMembers, ...taggedRunnersUp, ...taggedCandidates]
            .filter(c => {
                const a = String(c.address || '');
                if (!a || seen.has(a)) return false;
                seen.add(a);
                return true;
            });

        // ─── Pre-populate the right panel from the user's existing vote ──
        // electionsPallet.voting returns a Voter struct: { votes: Vec<AccountId>,
        // stake: Balance, deposit: Balance }. Empty (votes.length == 0) means
        // the user hasn't voted in this election round.
        if (voting) {
            try {
                const existingVotes = voting.votes ? voting.votes.toArray().map(a => a.toString()) : [];
                const existingStake = voting.stake ? voting.stake.toString() : '0';
                for (const addr of existingVotes) {
                    // Try to resolve role + name from the live candidate pool.
                    // If the user previously voted for someone who has since
                    // withdrawn, we keep them in the picker as 'ex-candidate'
                    // so the user can see + remove them — voting again
                    // without removing means the chain silently ignores those
                    // votes, which is unfriendly. Better to surface it.
                    const pooled = councilVoteCandidates.find(c => c.address === addr);
                    if (pooled) {
                        councilVoteSelected.set(addr, pooled);
                    } else {
                        councilVoteSelected.set(addr, { address: addr, name: 'Unknown', stake: 0, role: 'ex-candidate' });
                    }
                }
                // Pre-fill the backing stake with what's currently locked so
                // the user sees what they previously chose. Convert planck
                // (u128 string) → whole PDEX via 1e12 divisor (PDEX = 12 decimals).
                if (existingStake !== '0' && stakeInputEl) {
                    try {
                        const stakePdex = Number(BigInt(existingStake)) / 1e12;
                        if (stakePdex > 0) stakeInputEl.value = String(stakePdex);
                    } catch (_) {}
                }
            } catch (_e) { /* shape drift — silently skip pre-population */ }
        }

        // ─── Votable balance ─────────────────────────────────────────────
        // Show the free balance — that's the cap the elections pallet will
        // accept for the vote. Substrate's LockableCurrency uses the LARGER
        // of overlapping locks (staking + voting), so we don't need to
        // subtract the existing staking lock from this figure.
        if (accountInfo && votableEl) {
            try {
                const freePlanck = accountInfo.data && accountInfo.data.free ? accountInfo.data.free.toString() : '0';
                const freePdex = Number(BigInt(freePlanck)) / 1e12;
                votableEl.innerHTML = `Available: <strong style="color: var(--text-secondary);">${stakingFormatPDEX(freePdex)}</strong> PDEX`;
            } catch (_e) { /* leave dash */ }
        } else if (!connectedAddress && votableEl) {
            votableEl.innerHTML = '<span style="color: var(--text-muted);">Connect a wallet to see your votable balance.</span>';
        }

        renderCouncilVoteAvailable();
        renderCouncilVoteSelected();
    } catch (err) {
        if (availList) availList.innerHTML = `<div class="council-vote-empty" style="color:var(--error);">Could not load candidates: ${stakingEscapeHtml(err.message)}</div>`;
    }
}

function councilVoteFilteredPool() {
    const q = (councilVoteSearchTerm || '').trim().toLowerCase();
    if (!q) return councilVoteCandidates;
    return councilVoteCandidates.filter(c => {
        const addr = String(c.address || '').toLowerCase();
        const name = String(c.name || '').toLowerCase();
        return addr.includes(q) || name.includes(q);
    });
}

function renderCouncilVoteAvailable() {
    const list = document.getElementById('council-vote-available-list');
    const counter = document.getElementById('council-vote-available-count');
    if (!list) return;
    const filtered = councilVoteFilteredPool();
    if (counter) counter.textContent = String(filtered.length);
    if (!filtered.length) {
        list.innerHTML = `<div class="council-vote-empty">${councilVoteSearchTerm ? 'No candidates match your search.' : 'No candidates available right now.'}</div>`;
        return;
    }
    list.innerHTML = filtered.map(c => {
        const selected = councilVoteSelected.has(c.address);
        const displayName = c.name && c.name !== 'Unknown' ? c.name : stakingShortAddress(c.address);
        const roleClass = c.role === 'member' ? 'role-member'
            : c.role === 'runner-up' ? 'role-runner-up'
            : c.role === 'ex-candidate' ? 'role-ex-candidate'
            : 'role-candidate';
        return `
        <button type="button" class="council-vote-row ${selected ? 'is-selected' : ''}" data-council-add="${stakingEscapeHtml(c.address)}" ${selected ? 'disabled aria-label="Already selected"' : 'aria-label="Add to votes"'}>
            <div class="council-vote-row-main">
                <div class="council-vote-row-name">${stakingEscapeHtml(displayName)}</div>
                <div class="council-vote-row-meta">
                    <span class="council-vote-role ${roleClass}">${c.role}</span>
                    ${Number(c.stake) > 0 ? `<span>${stakingFormatPDEX(c.stake)} PDEX backing</span>` : ''}
                </div>
            </div>
            <span class="council-vote-add-icon" aria-hidden="true">${selected ? '✓' : '+'}</span>
        </button>`;
    }).join('');
    list.querySelectorAll('[data-council-add]').forEach(btn => {
        btn.addEventListener('click', () => {
            const addr = btn.getAttribute('data-council-add');
            const cand = councilVoteCandidates.find(c => c.address === addr);
            if (!cand) return;
            if (councilVoteSelected.size >= 16) {
                alert('You can vote for at most 16 candidates.');
                return;
            }
            councilVoteSelected.set(addr, cand);
            renderCouncilVoteSelected();
            renderCouncilVoteAvailable();
        });
    });
}

function renderCouncilVoteSelected() {
    const list = document.getElementById('council-vote-selected-list');
    const count = document.getElementById('council-vote-selected-count');
    const clearBtn = document.getElementById('council-vote-clear');
    if (!list) return;
    if (count) count.textContent = String(councilVoteSelected.size);
    if (clearBtn) clearBtn.style.display = councilVoteSelected.size > 0 ? 'inline-block' : 'none';
    if (!councilVoteSelected.size) {
        list.innerHTML = '<div class="council-vote-empty">No candidates selected yet — click rows on the left to add them.</div>';
        return;
    }
    list.innerHTML = Array.from(councilVoteSelected.values()).map(c => {
        const displayName = c.name && c.name !== 'Unknown' ? c.name : stakingShortAddress(c.address);
        const roleClass = c.role === 'member' ? 'role-member'
            : c.role === 'runner-up' ? 'role-runner-up'
            : c.role === 'ex-candidate' ? 'role-ex-candidate'
            : 'role-candidate';
        return `
        <div class="council-vote-row is-picked">
            <div class="council-vote-row-main">
                <div class="council-vote-row-name">${stakingEscapeHtml(displayName)}</div>
                <div class="council-vote-row-meta">
                    <span class="council-vote-role ${roleClass}">${c.role}</span>
                </div>
            </div>
            <button type="button" class="council-vote-remove" data-council-remove="${stakingEscapeHtml(c.address)}" aria-label="Remove from votes">×</button>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-council-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
            const addr = btn.getAttribute('data-council-remove');
            councilVoteSelected.delete(addr);
            renderCouncilVoteSelected();
            renderCouncilVoteAvailable();
        });
    });
}

// Wire the search + clear-all once at boot. The picker rebuilds itself on
// every modal open, so handlers attached to elements that exist for the
// page's lifetime are safe.
(function wireCouncilVotePickerOnce() {
    const search = document.getElementById('council-vote-search');
    if (search) {
        search.addEventListener('input', () => {
            councilVoteSearchTerm = search.value || '';
            renderCouncilVoteAvailable();
        });
    }
    const clearBtn = document.getElementById('council-vote-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            councilVoteSelected.clear();
            renderCouncilVoteSelected();
            renderCouncilVoteAvailable();
        });
    }
})();

function checkWalletForCouncil(modalType) {
    const address = getStoredWallet();
    const activeDivId = modalType === 'candidacy' ? 'candidacy-active-wallet' : '';
    const warningId = modalType === 'candidacy' ? 'candidacy-modal-wallet-warning' : 'vote-modal-wallet-warning';
    const warnEl = document.getElementById(warningId);

    if (!address) {
        // Replace the static "Please connect" text with an actionable link
        // that carries ?returnTo=<currentPath> so the user lands back on
        // /council after picking an account in the wallet flow.
        if (warnEl) {
            warnEl.innerHTML = buildWalletConnectPrompt();
            warnEl.style.display = 'block';
        }
        if (activeDivId) document.getElementById(activeDivId).innerText = '--';
        return;
    }

    if (warnEl) warnEl.style.display = 'none';
    if (activeDivId) document.getElementById(activeDivId).innerText = address;
}

// Audit F-056: this used to run its own private signAndSend that watched
// ONLY status.isInBlock — a candidacy rejected by the runtime (for example
// elections.InsufficientCandidateFunds) still alerted "Transaction included"
// and closed the modal, because a failed extrinsic is still included in a
// block; inclusion and success are different facts. submitSignedTx watches
// dispatchError and says which one happened.
async function submitCouncilCandidacy() {
    const btn = document.getElementById('submit-candidacy-tx-btn');
    let candidateCount = 0;
    try {
        const response = await fetch('/api/council');
        const data = await parseJsonResponse(response);
        candidateCount = (data.candidates || []).length;
    } catch (e) {
        return alert('Could not read the current candidate count: ' + (e && e.message ? e.message : e));
    }
    await submitSignedTx({
        buildTx: (api) => api.tx[councilPalletName].submitCandidacy(candidateCount),
        label: 'Council candidacy',
        button: btn,
        busyText: 'Signing...',
        idleText: 'Sign & Submit Candidacy',
        onSuccess: () => { if (candidacyModal) candidacyModal.style.display = 'none'; }
    });
}

if (document.getElementById('submit-candidacy-tx-btn')) {
    document.getElementById('submit-candidacy-tx-btn').addEventListener('click', submitCouncilCandidacy);
}

async function submitCouncilVote() {
    const address = getStoredWallet();
    if (!address) return alert('Please connect your wallet first');

    // Read from the in-memory picker state instead of a comma-separated
    // text input. The Map is keyed by the same Polkadex SS58 address the
    // chain's elections pallet expects, so addresses pass straight through
    // to api.tx[electionsPallet].vote(...).
    const candidates = Array.from(councilVoteSelected.keys());
    if (candidates.length === 0) return alert('Pick at least one candidate from the list on the left.');
    if (candidates.length > 16) return alert('You can vote for at most 16 candidates.');

    const stakeInput = document.getElementById('vote-stake-input').value;
    if (!stakeInput) return alert('Enter a backing stake.');
    if (!isPositiveNumberInput(stakeInput)) return alert('Invalid stake amount.');
    // Audit F-011: convert via decimal-string BigInt math, never Number*1e12.
    // parseFloat(x)*1e12 loses precision on decimals ("1.1" → one planck
    // short) and silently corrupts anything ≥ ~9007 PDEX — the user would
    // sign a stake that differs from what they typed.
    const stakePlanck = pdexToPlanck(stakeInput);

    // F-056 — same fix as submitCouncilCandidacy: a vote the runtime rejects
    // must not report "included" as if it were success.
    await submitSignedTx({
        buildTx: (api) => api.tx[councilPalletName].vote(candidates, stakePlanck.toString()),
        label: 'Council vote',
        button: document.getElementById('submit-vote-tx-btn'),
        busyText: 'Signing...',
        idleText: 'Sign & Submit Vote',
        onSuccess: () => { if (voteModal) voteModal.style.display = 'none'; }
    });
}

if (document.getElementById('submit-vote-tx-btn')) {
    document.getElementById('submit-vote-tx-btn').addEventListener('click', submitCouncilVote);
}

// --- Shared signed-transaction helper ---
// Resolves the connected wallet, requests a signer from the extension, signs and
// sends a transaction, and reports success/failure. Used by Treasury and Council.
// Click-time wallet gate for action buttons. Governance actions are now shown
// to everyone (for discoverability); when the user actually clicks one without
// a connected wallet, this prompts them to connect and routes to the wallet
// picker with a returnTo so they come back to where they were. Returns true
// when a wallet is already connected (caller proceeds), false otherwise.
function requireWallet(actionPhrase) {
    if (getStoredWallet()) return true;
    const msg = `Connect a wallet to ${actionPhrase || 'continue'}.`;
    if (confirm(`${msg}\n\nGo to wallet connection now?`)) {
        const here = (window.location.pathname || '/') + (window.location.search || '');
        navigateTo('wallet?returnTo=' + encodeURIComponent(here));
    }
    return false;
}

async function submitSignedTx({ buildTx, label, button, busyText, idleText, onError, onSuccess }) {
    const fail = (m) => { if (onError) onError(m); else alert(m); };
    const address = getStoredWallet();
    if (!address) return fail('Please connect your wallet first.');
    if (!globalApi) return fail('Blockchain connection is not ready yet. Please wait a moment and try again.');

    let injected;
    try { injected = await getInjectedAccounts(); }
    catch (e) { return fail('Could not access your wallet extension.'); }
    if (!injected || !injected.length) {
        return fail(isMobileDevice()
            ? "You're in read-only mode — no wallet is connected to this browser tab. Open this page inside Nova Wallet or SubWallet's in-app browser to sign transactions, then come back to this action."
            : 'No Substrate wallet extension found. Install Polkadot.js, Talisman or SubWallet (desktop) — or open this page in a mobile wallet\'s in-app browser.');
    }

    // Match by underlying public key so an SS58-prefix mismatch between the
    // extension (often prefix 42) and the stored address (Polkadex prefix 88)
    // doesn't make the account look missing.
    const account = injected.find(a => isSameAddress(a.address, address));
    if (!account) return fail("This account isn't available in your connected wallet. Switch to the right account in your wallet extension (or reconnect) and try again.");

    let signer;
    try {
        const provider = window.injectedWeb3[account.source];
        const ext = await provider.enable('Polkadex Explorer');
        signer = ext.signer;
    } catch (e) { return fail('Wallet extension authorization was rejected.'); }

    const setBusy = () => { if (button) { button.disabled = true; if (busyText) button.textContent = busyText; } };
    const restore = () => { if (button) { button.disabled = false; if (idleText) button.textContent = idleText; } };

    setBusy();
    try {
        const tx = buildTx(globalApi);
        // Sign with the extension's address (its native SS58 format) so the
        // injected signer recognizes the account.
        const unsub = await tx.signAndSend(account.address, { signer }, (result) => {
            const { status, dispatchError } = result;
            if (dispatchError) {
                let msg = dispatchError.toString();
                if (dispatchError.isModule) {
                    try {
                        const meta = globalApi.registry.findMetaError(dispatchError.asModule);
                        msg = `${meta.section}.${meta.name}`;
                    } catch (e) { }
                }
                fail((label || 'Transaction') + ' failed: ' + msg);
                restore();
                if (typeof unsub === 'function') unsub();
                return;
            }
            if (status.isInBlock || status.isFinalized) {
                restore();
                if (typeof unsub === 'function') unsub();
                alert((label || 'Transaction') + ' was included on-chain.');
                if (onSuccess) onSuccess();
            }
        });
    } catch (e) {
        fail((label || 'Transaction') + ' failed: ' + (e && e.message ? e.message : String(e)));
        restore();
    }
}

// --- Treasury Module Logic ---
let treasuryData = null;
let treasuryTab = 'overview';

async function fetchTreasuryData() {
    treasuryTab = 'overview';
    const root = document.getElementById('treasury-content');
    if (!root) return;
    root.innerHTML = '<div class="list-container glass" style="padding:40px;text-align:center;color:var(--text-secondary);">Loading treasury data…</div>';
    try {
        const res = await fetch('/api/treasury');
        const data = await parseJsonResponse(res);
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        treasuryData = data;
        renderTreasury();
        // Deep-link: if we arrived from /calendar with ?proposal=N, open the
        // matching treasury proposal modal now that data is loaded.
        tryOpenFromQueryString('treasury');
    } catch (e) {
        root.innerHTML = `
            <div class="list-container glass" style="padding:40px;text-align:center;">
                <h3 style="color:var(--error);margin-bottom:8px;">Couldn't load treasury data</h3>
                <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:14px;">${stakingEscapeHtml(e.message)}</p>
                <p style="color:var(--text-muted);font-size:0.82rem;">The chain indexer is likely restarting or timing out. Try again in a moment.</p>
                <button id="treasury-retry-btn" class="staking-download-btn" style="margin-top:18px;"><i class='bx bx-refresh'></i> Retry</button>
            </div>`;
        const retry = document.getElementById('treasury-retry-btn');
        if (retry) retry.addEventListener('click', fetchTreasuryData);
    }
}

function renderTreasury() {
    const root = document.getElementById('treasury-content');
    if (!root || !treasuryData) return;
    const d = treasuryData;
    const all = Array.isArray(d.allProposals) ? d.allProposals : [];
    const openProposals = all.filter(p => p.status === 'proposed');
    const approvedProposals = all.filter(p => p.status === 'approved');
    const historyProposals = all.filter(p => p.status === 'awarded' || p.status === 'rejected');

    const tabBtn = (key, label) => `<button class="account-tab${treasuryTab === key ? ' active' : ''}" data-treastab="${key}">${label}</button>`;
    let body;
    if (treasuryTab === 'proposals') body = renderTreasuryProposals(openProposals);
    else if (treasuryTab === 'approved') body = renderTreasuryApproved(approvedProposals);
    else if (treasuryTab === 'history') body = renderTreasuryHistory(historyProposals);
    else body = renderTreasuryOverview(d, openProposals.length, approvedProposals.length, historyProposals);

    root.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2>Treasury</h2>
                <div style="display:flex;gap:14px;align-items:center;">
                    <span style="color:var(--text-secondary);font-size:0.78rem;">${stakingFormatNumber(d.proposalCount)} lifetime proposals</span>
                    <button id="treasury-submit-btn" class="staking-download-btn"><i class='bx bx-plus-circle'></i> Submit proposal</button>
                </div>
            </div>
            <div class="account-tabs" style="margin:0 24px;">
                ${tabBtn('overview', 'Overview')}${tabBtn('proposals', `Open (${openProposals.length})`)}${tabBtn('approved', `Approved (${approvedProposals.length})`)}${tabBtn('history', `History (${historyProposals.length})`)}
            </div>
            <div style="padding:24px;">${governanceIndexNote(d.history, 'proposals')}${body}</div>
        </div>`;

    // Tables are mounted AFTER the outer innerHTML lands so their container
    // divs exist in the DOM. Each mount-* is a no-op when its target div isn't
    // in the current tab.
    if (treasuryTab === 'proposals')      mountTreasuryProposalsTable(openProposals);
    else if (treasuryTab === 'approved')  mountTreasuryApprovedTable(approvedProposals);
    else if (treasuryTab === 'history')   mountTreasuryHistoryTable(historyProposals);

    root.querySelectorAll('[data-treastab]').forEach(btn => {
        btn.addEventListener('click', () => { treasuryTab = btn.getAttribute('data-treastab'); renderTreasury(); });
    });
    const submitBtn = document.getElementById('treasury-submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', openTreasurySubmitModal);
}

// Banner shown while the governance history crawler is still backfilling.
function governanceIndexNote(history, noun) {
    if (!history || history.backfillComplete || !history.status || history.status === 'Initializing') return '';
    return `<div class="gov-index-note"><i class='bx bx-loader-alt bx-spin'></i> Indexing past ${noun} from chain history — scanned back to block ${stakingFormatNumber(history.oldestScannedBlock)}. Older ${noun} will keep appearing as the crawl progresses.</div>`;
}

function renderTreasuryOverview(d, openCount, approvedCount, historyList) {
    const spendable = Number(d.spendableFunds) || 0;
    const spendPeriod = Number(d.spendPeriod) || 0;
    const blocksRemaining = Number(d.blocksRemaining) || 0;
    const pct = spendPeriod > 0
        ? Math.min(100, Math.max(0, Math.floor(((spendPeriod - blocksRemaining) / spendPeriod) * 100)))
        : 0;
    const remSecs = blocksRemaining * 12;
    const remDays = Math.floor(remSecs / 86400);
    const remHrs = Math.floor((remSecs % 86400) / 3600);
    const burnFraction = (Number(d.burn) || 0) / 1e6; // burn is a Permill
    const burnAmount = spendable * burnFraction;
    const awardedCount = historyList.filter(p => p.status === 'awarded').length;
    const rejectedCount = historyList.filter(p => p.status === 'rejected').length;
    const indexed = (Array.isArray(d.allProposals) ? d.allProposals.length : 0);
    return `
        <div class="staking-summary-grid">
            <div class="staking-summary-card"><div class="label">Treasury Balance</div><div class="value accent">${stakingFormatPDEX(spendable)} PDEX</div></div>
            <div class="staking-summary-card"><div class="label">Open Proposals</div><div class="value">${stakingFormatNumber(openCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Approved (awaiting payout)</div><div class="value">${stakingFormatNumber(approvedCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Paid Out</div><div class="value">${stakingFormatNumber(awardedCount)}</div></div>
            <div class="staking-summary-card"><div class="label">Rejected</div><div class="value">${stakingFormatNumber(rejectedCount)}</div></div>
        </div>
        <div class="wallet-stat-list" style="padding:14px 0 0;">
            <div class="wallet-stat"><span>Lifetime proposals (on-chain counter)</span><strong>${stakingFormatNumber(d.proposalCount)}</strong></div>
            <div class="wallet-stat"><span>Proposals indexed locally</span><strong>${stakingFormatNumber(indexed)}</strong></div>
            <div class="wallet-stat"><span>Next burn</span><strong>${stakingFormatPDEX(burnAmount)} PDEX (${(burnFraction * 100).toFixed(2)}%)</strong></div>
            <div class="wallet-stat"><span>Spend period length</span><strong>${stakingFormatNumber(spendPeriod)} blocks</strong></div>
            <div class="wallet-stat"><span>Next spend payout in</span><strong>~${remDays}d ${remHrs}h &middot; ${stakingFormatNumber(blocksRemaining)} blocks (${pct}%)</strong></div>
        </div>`;
}

function treasuryPartyName(name, address) {
    if (name && name !== 'Unknown' && name !== address) return name;
    if (address) return stakingShortAddress(address);
    return '—';
}

function treasuryStatusBadge(status) {
    if (status === 'awarded') return '<span class="reward-badge claimed">Paid out</span>';
    if (status === 'rejected') return '<span class="reward-badge unclaimed">Rejected</span>';
    if (status === 'approved') return '<span class="reward-badge claimed">Approved</span>';
    return '<span class="reward-badge neutral">Open</span>';
}

function treasuryPartyCell(name, address) {
    if (!address) return '<span style="color:var(--text-muted);">—</span>';
    return `<a href="/account/${encodeURIComponent(address)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(treasuryPartyName(name, address))}</a>`;
}

// Shared makeTable column factory for treasury proposals. `showStatus` adds
// a Status / Outcome column at the right edge for Approved and History tabs.
function buildTreasuryColumns(showStatus, opts = {}) {
    return [
        {
            key: 'id', label: 'Proposal', searchable: true,
            sort: (a, b) => (a.id || 0) - (b.id || 0),
            // Clickable — opens the governance-detail modal. The global delegate
            // in wireGovernanceDetailModal looks the row up by id from
            // treasuryData and snapshots the active tab for restore-on-close.
            format: row => `<button type="button" class="gov-proposal-link" data-kind="treasury" data-id="${stakingEscapeHtml(String(row.id))}">#${stakingEscapeHtml(String(row.id))}</button>`
        },
        {
            key: 'beneficiaryName', label: 'Beneficiary', searchable: true,
            sort: (a, b) => String(a.beneficiaryName || a.beneficiary || '').localeCompare(String(b.beneficiaryName || b.beneficiary || '')),
            filter: { type: 'text', placeholder: 'Beneficiary…' },
            format: row => treasuryPartyCell(row.beneficiaryName, row.beneficiary)
        },
        {
            key: 'proposerName', label: 'Proposer', searchable: true,
            sort: (a, b) => String(a.proposerName || a.proposer || '').localeCompare(String(b.proposerName || b.proposer || '')),
            filter: { type: 'text', placeholder: 'Proposer…' },
            format: row => treasuryPartyCell(row.proposerName, row.proposer)
        },
        {
            key: 'bond', label: 'Bond',
            sort: (a, b) => (Number(a.bond) || 0) - (Number(b.bond) || 0),
            format: row => row.bond == null ? '—' : stakingFormatPDEX(row.bond) + ' PDEX'
        },
        {
            key: 'value', label: 'Requested',
            sort: (a, b) => (Number(a.value) || 0) - (Number(b.value) || 0),
            format: row => row.value == null ? '—' : `<strong>${stakingFormatPDEX(row.value)} PDEX</strong>`
        },
        ...(showStatus ? [{
            key: 'status', label: showStatus === 'outcome' ? 'Outcome' : 'Status',
            sort: (a, b) => String(a.status || '').localeCompare(String(b.status || '')),
            filter: { type: 'select', options: ['proposed', 'approved', 'awarded', 'rejected'] },
            format: row => treasuryStatusBadge(row.status)
        }] : []),
        // Optional per-row council action (open proposals tab). Visible to all;
        // the delegated handler prompts to connect and the modal enforces
        // council membership. Only meaningful for still-open ('proposed') rows.
        ...(opts.proposeAction ? [{
            key: '__propose', label: 'Action',
            format: row => row.status === 'proposed'
                ? `<button type="button" class="treasury-propose-row-btn reward-filter-btn" data-proposal-id="${stakingEscapeHtml(String(row.id))}" style="padding:4px 10px;font-size:0.76rem;border-color:var(--brand-primary);color:var(--brand-primary);white-space:nowrap;"><i class='bx bx-plus-circle'></i> Propose motion</button>`
                : '<span style="color:var(--text-muted);">—</span>'
        }] : [])
    ];
}

// Mount points returned for the three tabs; each renderTreasury*() returns a
// placeholder div, and the caller calls mount...Table after setting innerHTML
// so the makeTable instance can find its container in the DOM.
function renderTreasuryProposals(list) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No open proposals are currently awaiting council approval.</div>';
    return '<div id="treasury-proposals-table"></div>';
}
function renderTreasuryApproved(list) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No approved proposals are awaiting payout.</div>';
    return '<div id="treasury-approved-table"></div>';
}
function renderTreasuryHistory(list) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No resolved proposals indexed yet. Past proposals are crawled from chain history in the background.</div>';
    return '<div id="treasury-history-table"></div>';
}
function mountTreasuryProposalsTable(list) {
    const el = document.getElementById('treasury-proposals-table');
    if (!el) return;
    makeTable({
        container: el, rows: list,
        defaultSort: { key: 'id', dir: 'desc' },
        globalSearch: true, summarySuffix: 'proposals',
        emptyMessage: 'No open proposals.',
        columns: buildTreasuryColumns(false, { proposeAction: true })
    });
}
function mountTreasuryApprovedTable(list) {
    const el = document.getElementById('treasury-approved-table');
    if (!el) return;
    makeTable({
        container: el, rows: list,
        defaultSort: { key: 'id', dir: 'desc' },
        globalSearch: true, summarySuffix: 'proposals',
        emptyMessage: 'No approved proposals.',
        columns: buildTreasuryColumns('status')
    });
}
function mountTreasuryHistoryTable(list) {
    const el = document.getElementById('treasury-history-table');
    if (!el) return;
    makeTable({
        container: el, rows: list,
        defaultSort: { key: 'id', dir: 'desc' },
        globalSearch: true, summarySuffix: 'proposals',
        emptyMessage: 'No resolved proposals indexed yet.',
        columns: buildTreasuryColumns('outcome')
    });
}

function openTreasurySubmitModal() {
    const modal = document.getElementById('treasury-submit-modal');
    if (!modal) return;
    const stored = getStoredWallet();
    const warn = document.getElementById('treasury-modal-wallet-warning');
    const activeEl = document.getElementById('treasury-active-wallet');
    const errEl = document.getElementById('treasury-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (warn) {
        if (stored) {
            warn.style.display = 'none';
        } else {
            // Inject the actionable connect-wallet link with returnTo so
            // the user lands back on /treasury after connecting.
            warn.innerHTML = buildWalletConnectPrompt();
            warn.style.display = 'block';
        }
    }
    if (activeEl) activeEl.textContent = stored || '--';
    modal.style.display = 'flex';
}

async function submitTreasuryProposal() {
    const errEl = document.getElementById('treasury-modal-error');
    const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    const amtInput = document.getElementById('treasury-amount-input');
    const benInput = document.getElementById('treasury-beneficiary-input');
    const amtStr = (amtInput ? amtInput.value : '').trim();
    const beneficiary = (benInput ? benInput.value : '').trim();

    if (!isPositiveNumberInput(amtStr)) return showErr('Enter a valid PDEX amount greater than zero.');
    if (!beneficiary) return showErr('Enter a beneficiary address.');
    if (!isValidPolkadexAddress(beneficiary)) return showErr('That beneficiary address is not a valid Polkadex address.');

    // Audit F-011: decimal-string conversion — Number*1e12 signs a planck
    // value that can differ from what the proposer typed.
    const valuePlanck = pdexToPlanck(amtStr);
    await submitSignedTx({
        buildTx: (api) => api.tx.treasury.proposeSpend(valuePlanck, beneficiary),
        label: 'Treasury proposal',
        button: document.getElementById('submit-treasury-tx-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Submit Proposal',
        onError: showErr,
        onSuccess: () => {
            const modal = document.getElementById('treasury-submit-modal');
            if (modal) modal.style.display = 'none';
            if (amtInput) amtInput.value = '';
            if (benInput) benInput.value = '';
            setTimeout(fetchTreasuryData, 2000);
        }
    });
}

(function wireTreasuryModal() {
    const modal = document.getElementById('treasury-submit-modal');
    const closeBtn = document.getElementById('close-treasury-modal');
    const submitTxBtn = document.getElementById('submit-treasury-tx-btn');
    if (closeBtn && modal) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    if (submitTxBtn) submitTxBtn.addEventListener('click', submitTreasuryProposal);
})();

// ─────────────────────────────────────────────────────────────────────────────
// Governance detail modal — unified view for treasury proposals, council
// motions, and democracy referenda. Triggered by clicking a proposal/motion/
// referendum number in any of the governance tables. The modal is a layered
// overlay (no URL change), so the underlying page state is preserved verbatim
// while it's open. The close handler additionally snaps the parent page back
// to the exact tab the user clicked from — see governanceDetailReturnState.
// ─────────────────────────────────────────────────────────────────────────────

// Snapshot of which tab to restore when the modal closes. Captured at open()
// time. Set to null whenever the modal isn't displayed.
let governanceDetailReturnState = null;

function formatGovTime(ts) {
    if (!ts) return '<span style="color:var(--text-muted);">—</span>';
    const formatted = formatLocalDateTime(ts);
    return formatted ? stakingEscapeHtml(formatted) : '<span style="color:var(--text-muted);">—</span>';
}
function formatGovBlockLink(blockNumber) {
    if (blockNumber == null) return '<span style="color:var(--text-muted);">—</span>';
    return `<a href="/block/${blockNumber}" class="item-link" style="color:var(--brand-secondary);">${stakingFormatNumber(blockNumber)}</a>`;
}
function formatGovAccountLink(address, displayName) {
    if (!address) return '<span style="color:var(--text-muted);">—</span>';
    const label = (displayName && displayName !== 'Unknown') ? displayName : stakingShortAddress(address);
    return `<a href="/account/${encodeURIComponent(address)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(label)}</a>`;
}
function formatGovHash(hash) {
    if (!hash) return '<span style="color:var(--text-muted);">—</span>';
    return `<span class="address-cell" style="word-break:break-all;color:var(--brand-secondary);">${stakingEscapeHtml(hash)}</span>`;
}

// Generic 2-column row used inside the detail body so every kind has the same
// look without re-implementing the styling at each site.
function govDetailRow(label, value) {
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
        <span style="color:var(--text-secondary);font-size:0.85rem;min-width:140px;">${stakingEscapeHtml(label)}</span>
        <span style="text-align:right;font-size:0.9rem;flex:1;word-break:break-all;">${value}</span>
    </div>`;
}

function renderTreasuryDetail(row) {
    // Treasury proposals don't carry an extrinsic hash directly — the chain's
    // identifier is the proposal index. The "transaction details" the user
    // can pivot to live at the proposed/resolved block links.
    const heading = `Treasury Proposal #${stakingEscapeHtml(String(row.id))}`;

    // "Convert to motion" — a standing open (status 'proposed') treasury
    // proposal is approved/rejected by the council via a motion, not directly.
    // We surface that action on every open proposal (for ALL viewers, so the
    // path is discoverable) — the Propose Motion modal prompts to connect and
    // enforces council membership at submit, so it's safe to show broadly.
    // Opens the modal pre-filled with this proposal's id and the chosen call.
    const isOpen = row.status === 'proposed';
    const proposeActions = isOpen ? `
        <div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--border-color);">
            <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:10px;">Council action ${helpIcon('council-and-motions', 'How treasury proposals are approved via council motions')}</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button type="button" class="treasury-propose-motion-btn" data-proposal-id="${stakingEscapeHtml(String(row.id))}" data-call="treasury.approveProposal" style="padding:10px 16px;background:var(--brand-primary);color:#fff;border:none;border-radius:var(--radius-sm);font-weight:600;cursor:pointer;"><i class='bx bx-check-circle'></i> Propose approval motion</button>
                <button type="button" class="treasury-propose-motion-btn" data-proposal-id="${stakingEscapeHtml(String(row.id))}" data-call="treasury.rejectProposal" style="padding:10px 16px;background:rgba(255,255,255,0.05);color:var(--text-primary);border:1px solid var(--border-color);border-radius:var(--radius-sm);font-weight:600;cursor:pointer;"><i class='bx bx-x-circle'></i> Propose rejection motion</button>
            </div>
        </div>` : '';

    return `<h2 style="margin:0 0 8px 0;font-size:1.4rem;">${heading}</h2>
        <div style="margin-bottom:18px;color:var(--text-muted);font-size:0.85rem;">
            On-chain treasury spend request. Click the block links below to view the extrinsic that proposed or resolved it.
        </div>
        ${govDetailRow('Status', treasuryStatusBadge(row.status))}
        ${govDetailRow('Proposer', formatGovAccountLink(row.proposer, row.proposerName))}
        ${govDetailRow('Beneficiary', formatGovAccountLink(row.beneficiary, row.beneficiaryName))}
        ${govDetailRow('Requested', row.value == null ? '<span style="color:var(--text-muted);">—</span>' : `<strong>${stakingFormatPDEX(row.value)} PDEX</strong>`)}
        ${govDetailRow('Bond', row.bond == null ? '<span style="color:var(--text-muted);">—</span>' : stakingFormatPDEX(row.bond) + ' PDEX')}
        ${govDetailRow('Proposed at block', formatGovBlockLink(row.proposedBlock))}
        ${govDetailRow('Proposed at', formatGovTime(row.proposedAt))}
        ${govDetailRow('Resolved at block', formatGovBlockLink(row.resolvedBlock))}
        ${govDetailRow('Resolved at', formatGovTime(row.resolvedAt))}
        ${proposeActions}`;
}

function renderMotionDetail(row) {
    // Motions carry a real call hash (the SCALE-encoded extrinsic the council
    // is voting on). Display it prominently as the "Proposal Hash".
    const idxLabel = (row.motionIndex === null || row.motionIndex === undefined) ? '' : ` #${row.motionIndex}`;
    const tally = (row.ayes == null && row.nays == null)
        ? '<span style="color:var(--text-muted);">—</span>'
        : `${row.ayes || 0} aye / ${row.nays || 0} nay`;
    const callLabel = (row.section && row.method) ? `${row.section}.${row.method}` : 'Council Motion';
    const statusBadge = (typeof resolvedMotionBadge === 'function' && row.status && row.status !== 'proposed')
        ? resolvedMotionBadge(row.status)
        : `<span class="reward-badge neutral">${stakingEscapeHtml(row.status || 'Open')}</span>`;
    return `<h2 style="margin:0 0 8px 0;font-size:1.4rem;">Council Motion${idxLabel}</h2>
        <div style="margin-bottom:18px;color:var(--text-muted);font-size:0.85rem;">
            Council vote on a privileged on-chain call. The proposal hash uniquely identifies the underlying extrinsic; the resolved block is where the council finalized the vote.
        </div>
        ${govDetailRow('Status', statusBadge)}
        ${govDetailRow('Call', `<code style="font-size:0.85rem;">${stakingEscapeHtml(callLabel)}</code>`)}
        ${govDetailRow('Proposal hash', formatGovHash(row.hash))}
        ${govDetailRow('Proposer', formatGovAccountLink(row.proposer, row.proposerName))}
        ${govDetailRow('Threshold', row.threshold == null ? '<span style="color:var(--text-muted);">—</span>' : String(row.threshold))}
        ${govDetailRow('Tally', tally)}
        ${govDetailRow('Proposed at block', formatGovBlockLink(row.proposedBlock))}
        ${govDetailRow('Proposed at', formatGovTime(row.proposedAt))}
        ${govDetailRow('Resolved at block', formatGovBlockLink(row.resolvedBlock))}
        ${govDetailRow('Resolved at', formatGovTime(row.resolvedAt))}`;
}

function renderReferendumDetail(row) {
    // Referenda also carry a proposal hash (the call to dispatch on enact).
    const heading = `Referendum #${stakingEscapeHtml(String(row.refIndex))}`;
    const tally = row.tallyKnown
        ? `${stakingFormatPDEX(row.ayes)} aye PDEX / ${stakingFormatPDEX(row.nays)} nay PDEX`
        : '<span style="color:var(--text-muted);">tally not indexed</span>';
    return `<h2 style="margin:0 0 8px 0;font-size:1.4rem;">${heading}</h2>
        <div style="margin-bottom:18px;color:var(--text-muted);font-size:0.85rem;">
            Public referendum on a runtime call. The proposal hash is the SCALE-encoded extrinsic the chain will dispatch if the referendum passes.
        </div>
        ${govDetailRow('Status', democracyStatusBadge(row.status))}
        ${govDetailRow('Proposal hash', formatGovHash(row.proposal))}
        ${govDetailRow('Tally', tally)}
        ${govDetailRow('Turnout', row.tallyKnown ? stakingFormatPDEX(row.turnout) + ' PDEX' : '<span style="color:var(--text-muted);">—</span>')}
        ${govDetailRow('Threshold', row.threshold ? `<code style="font-size:0.82rem;">${stakingEscapeHtml(row.threshold)}</code>` : '<span style="color:var(--text-muted);">—</span>')}
        ${govDetailRow('End block', formatGovBlockLink(row.endBlock))}`;
}

function renderPublicProposalDetail(row) {
    // Active proposals waiting to be tabled — pre-referendum stage. They have
    // an index, deposit, seconds count, and a proposal hash.
    const heading = `Public Proposal #${stakingEscapeHtml(String(row.index))}`;
    return `<h2 style="margin:0 0 8px 0;font-size:1.4rem;">${heading}</h2>
        <div style="margin-bottom:18px;color:var(--text-muted);font-size:0.85rem;">
            A public proposal pending tabling to a referendum. Anyone can "second" it to push it up the queue.
        </div>
        ${govDetailRow('Proposal hash', formatGovHash(row.proposal))}
        ${govDetailRow('Proposer', formatGovAccountLink(row.proposer, row.proposerName))}
        ${govDetailRow('Deposit', row.deposit == null ? '<span style="color:var(--text-muted);">—</span>' : stakingFormatPDEX(row.deposit) + ' PDEX')}
        ${govDetailRow('Seconds', row.seconds == null ? '<span style="color:var(--text-muted);">—</span>' : stakingFormatNumber(row.seconds))}`;
}

function openGovernanceDetailModal({ kind, row, returnPage, returnTab }) {
    const modal = document.getElementById('governance-detail-modal');
    const content = document.getElementById('governance-detail-content');
    if (!modal || !content || !row) return;

    governanceDetailReturnState = { returnPage, returnTab };

    // Render + (re)wire the modal body. Pulled into a closure so we can re-run
    // it after council data loads (see below) without duplicating the wiring.
    const renderBody = () => {
        let body = '';
        if (kind === 'treasury')              body = renderTreasuryDetail(row);
        else if (kind === 'motion')           body = renderMotionDetail(row);
        else if (kind === 'referendum')       body = renderReferendumDetail(row);
        else if (kind === 'public-proposal')  body = renderPublicProposalDetail(row);
        else body = '<div style="color:var(--text-muted);">Unknown proposal kind.</div>';
        content.innerHTML = body;

        // Wire the council-member "convert to motion" buttons on treasury
        // detail. Close this modal (without a page re-render — we're staying
        // put) and open the Propose Motion modal pre-filled with the id + call.
        content.querySelectorAll('.treasury-propose-motion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const proposalId = btn.getAttribute('data-proposal-id');
                const callType = btn.getAttribute('data-call');
                closeGovernanceDetailModal({ restorePage: false });
                openProposeMotionModal({ proposalId, callType });
            });
        });
    };

    renderBody();
    modal.style.display = 'flex';
}

function closeGovernanceDetailModal({ restorePage = true } = {}) {
    const modal = document.getElementById('governance-detail-modal');
    if (modal) modal.style.display = 'none';
    const state = governanceDetailReturnState;
    governanceDetailReturnState = null;
    // When the modal is closing because the user clicked a link that navigates
    // AWAY from the governance page (e.g. `<a href="/block/123">`), skip the
    // tab-restore re-render — the SPA router is about to replace the whole
    // page anyway, and re-rendering treasury/democracy here would do wasted
    // work and briefly flash the old page underneath the navigation.
    if (!state || !restorePage) return;
    // Restore the tab the user clicked from. Treasury and Democracy each
    // maintain a single JS-state tab variable; Council is DOM-driven via the
    // .account-tab buttons, so we synthesize a click on the matching one.
    if (state.returnPage === 'treasury' && state.returnTab && typeof renderTreasury === 'function') {
        treasuryTab = state.returnTab;
        renderTreasury();
    } else if (state.returnPage === 'democracy' && state.returnTab && typeof renderDemocracy === 'function') {
        democracyTab = state.returnTab;
        renderDemocracy();
    } else if (state.returnPage === 'council' && state.returnTab) {
        const tabBtn = document.querySelector(`.council-page .account-tab[data-tab="${state.returnTab}"]`);
        if (tabBtn) tabBtn.click();
    } else if (state.returnPage === 'history-back') {
        // Deep-link open (banner CTA, calendar click, shared URL). We don't
        // know where the user came from at registration time — but the
        // browser does. history.back() returns them to whichever SPA route
        // pushed /democracy?ref=N or /treasury?proposal=N onto the stack
        // (e.g., /home for the banner, /calendar for the calendar). Falls
        // back to /home for direct-paste of share links where there's no
        // prior in-app history entry.
        const sameOriginReferrer = document.referrer && document.referrer.startsWith(location.origin);
        if (history.length > 1 || sameOriginReferrer) history.back();
        else navigateTo('home');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Referendum voting modal — cast a Standard Aye/Nay vote on an ongoing
// democracy referendum. Posts `democracy.vote(refIndex, { Standard: { vote,
// balance } })` via the existing submitSignedTx flow (which handles wallet
// selection, fee estimation, and error surface). After a successful tx we
// re-fetch democracy data so the row's tally updates.
// ─────────────────────────────────────────────────────────────────────────────
let pendingReferendumVote = null;   // { refIndex, side: 'aye'|'nay' }

function openReferendumVoteModal(refIndex, side) {
    const modal = document.getElementById('referendum-vote-modal');
    if (!modal) return;
    // Audit F-118: council motions digit-check their index; referenda did not.
    // Number('') is 0 and Number(null) is NaN-or-0 depending on the path, and
    // a Compact<u32> will happily SCALE-encode 0 — the user would sign a vote
    // on referendum #0 instead of the one they clicked.
    if (!/^\d+$/.test(String(refIndex))) {
        alert('Invalid referendum index.');
        return;
    }
    pendingReferendumVote = { refIndex: Number(refIndex), side: side === 'nay' ? 'nay' : 'aye' };

    const idxLabel = document.getElementById('referendum-vote-modal-idx');
    if (idxLabel) idxLabel.textContent = '#' + pendingReferendumVote.refIndex;

    // Preselect the side button the user clicked. Pure styling toggle.
    document.querySelectorAll('.referendum-side-btn').forEach(b => {
        const isActive = b.getAttribute('data-side') === pendingReferendumVote.side;
        if (isActive) {
            if (pendingReferendumVote.side === 'aye') {
                b.style.background = 'rgba(46, 204, 113, 0.1)';
                b.style.borderColor = 'var(--success)';
                b.style.color = 'var(--success)';
            } else {
                b.style.background = 'rgba(231, 76, 60, 0.1)';
                b.style.borderColor = '#e74c3c';
                b.style.color = '#e74c3c';
            }
        } else {
            b.style.background = 'rgba(255,255,255,0.02)';
            b.style.borderColor = 'var(--border-color)';
            b.style.color = 'var(--text-secondary)';
        }
    });

    const stored = getStoredWallet();
    const warn = document.getElementById('referendum-vote-modal-wallet-warning');
    const active = document.getElementById('referendum-vote-active-wallet');
    const errEl = document.getElementById('referendum-vote-error');
    if (warn) {
        if (stored) {
            warn.style.display = 'none';
        } else {
            // Actionable connect prompt with returnTo so the user comes
            // back to /democracy (with the ?ref=N query string preserved
            // when they arrived via a deep link) after picking an account.
            warn.innerHTML = buildWalletConnectPrompt();
            warn.style.display = 'block';
        }
    }
    if (active) active.textContent = stored || '--';
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    // Reset the amount field on each open so a stale value doesn't carry over
    // from an earlier proposal. Conviction default stays at Locked1x (the
    // most common case for an engaged voter).
    const amt = document.getElementById('referendum-vote-amount');
    if (amt) amt.value = '';
    const conv = document.getElementById('referendum-vote-conviction');
    if (conv) conv.value = 'Locked1x';

    modal.style.display = 'flex';
}

function closeReferendumVoteModal() {
    const modal = document.getElementById('referendum-vote-modal');
    if (modal) modal.style.display = 'none';
    pendingReferendumVote = null;
}

async function submitReferendumVote() {
    if (!pendingReferendumVote) return;
    const errEl = document.getElementById('referendum-vote-error');
    const showErr = m => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    const amtInput = document.getElementById('referendum-vote-amount');
    const convInput = document.getElementById('referendum-vote-conviction');
    const amtStr = (amtInput ? amtInput.value : '').trim();
    const conviction = convInput ? convInput.value : 'Locked1x';

    if (!isPositiveNumberInput(amtStr)) return showErr('Enter a positive PDEX amount to lock behind your vote.');
    if (parseFloat(amtStr) > 1e15) return showErr('That amount exceeds plausible balances — double-check the value.');

    // Audit F-011: decimal-string conversion — Number*1e12 signs a planck
    // value that can differ from what the voter typed.
    const balancePlanck = pdexToPlanck(amtStr);
    const aye = pendingReferendumVote.side === 'aye';
    const refIndex = pendingReferendumVote.refIndex;

    await submitSignedTx({
        // democracy.vote takes a Compact<u32> referendum index and an
        // AccountVote enum. We always emit the Standard variant — Split votes
        // (separate aye/nay balances) are an advanced feature for v2.
        buildTx: api => api.tx.democracy.vote(refIndex, {
            Standard: {
                vote: { aye, conviction },
                balance: balancePlanck
            }
        }),
        label: `Referendum #${refIndex} ${aye ? 'aye' : 'nay'} vote`,
        button: document.getElementById('submit-referendum-vote-btn'),
        busyText: 'Signing…',
        idleText: 'Sign & Submit Vote',
        onError: showErr,
        onSuccess: () => {
            closeReferendumVoteModal();
            // Refetch after a short delay so the chain has time to include
            // and the indexer has time to pick up the new tally.
            setTimeout(fetchDemocracyData, 2500);
        }
    });
}

(function wireReferendumVoteModal() {
    const modal = document.getElementById('referendum-vote-modal');
    const closeBtn = document.getElementById('close-referendum-vote-modal');
    const submitBtn = document.getElementById('submit-referendum-vote-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeReferendumVoteModal);
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeReferendumVoteModal(); });
    if (submitBtn) submitBtn.addEventListener('click', submitReferendumVote);
    // Aye/Nay side toggle inside the modal (lets the user change their mind
    // without closing and re-opening).
    document.querySelectorAll('.referendum-side-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!pendingReferendumVote) return;
            pendingReferendumVote.side = btn.getAttribute('data-side');
            openReferendumVoteModal(pendingReferendumVote.refIndex, pendingReferendumVote.side);
        });
    });
    // Escape closes.
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal && modal.style.display === 'flex') closeReferendumVoteModal();
    });
    // Event delegation for the per-row Aye/Nay buttons rendered into the
    // referenda table by mountDemocracyReferendaTable. We attach to the
    // document so it works regardless of when the table is (re)rendered.
    document.addEventListener('click', e => {
        const btn = e.target && e.target.closest ? e.target.closest('.referendum-vote-trigger') : null;
        if (!btn) return;
        e.preventDefault();
        const refIndex = btn.getAttribute('data-ref-index');
        const side = btn.getAttribute('data-side');
        if (refIndex != null) openReferendumVoteModal(refIndex, side);
    });
})();

(function wireGovernanceDetailModal() {
    const modal = document.getElementById('governance-detail-modal');
    const closeBtn = document.getElementById('close-governance-detail-modal');
    if (closeBtn) closeBtn.addEventListener('click', () => closeGovernanceDetailModal());
    // Click-outside-to-close: only fire when the click landed on the backdrop
    // itself, not on the panel or its children. We also auto-close the modal
    // when the user clicks an internal navigation link inside it (e.g. one
    // of the "block X" links in the detail body) — without this, the SPA
    // router routes to the new page but our overlay stays painted on top
    // and hides whatever the user was trying to see. We close with
    // `restorePage: false` because the SPA router is about to replace the
    // page that the source tab lived on, so the tab-restore re-render would
    // be wasted work (and could briefly flash the wrong page underneath).
    if (modal) modal.addEventListener('click', (e) => {
        if (e.target === modal) { closeGovernanceDetailModal(); return; }
        const link = e.target && e.target.closest ? e.target.closest('a') : null;
        if (link) {
            const href = link.getAttribute('href');
            // Same-origin SPA route — close before the router takes over.
            if (href && href.startsWith('/')) closeGovernanceDetailModal({ restorePage: false });
        }
    });
    // Escape to close.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.style.display === 'flex') closeGovernanceDetailModal();
    });

    // Event delegation for proposal-link clicks. Cells in makeTable / the
    // resolved-motions table render an inline <button class="gov-proposal-link"
    // data-kind="…" data-id="…"> per row; we look up the matching record from
    // the cached data so the modal always gets the full row regardless of
    // makeTable's internal pagination / sort state.
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.gov-proposal-link') : null;
        if (!btn) return;
        e.preventDefault();
        const kind = btn.getAttribute('data-kind');
        const id = btn.getAttribute('data-id');
        if (!kind || id == null) return;
        let row = null;
        let returnPage = null;
        let returnTab = null;
        if (kind === 'treasury' && treasuryData) {
            const all = Array.isArray(treasuryData.allProposals) ? treasuryData.allProposals : [];
            row = all.find(p => String(p.id) === String(id));
            returnPage = 'treasury';
            returnTab = treasuryTab;
        } else if (kind === 'motion' && councilData) {
            // Either an open motion (matched by hash) or a resolved one (by hash too).
            const open = Array.isArray(councilData.motions) ? councilData.motions : [];
            const history = Array.isArray(councilData.motionHistory) ? councilData.motionHistory : [];
            row = open.find(m => m.hash === id) || history.find(m => m.hash === id);
            returnPage = 'council';
            const activeTab = document.querySelector('.council-page .account-tab.active');
            returnTab = activeTab ? activeTab.getAttribute('data-tab') : null;
        } else if (kind === 'referendum' && democracyData) {
            const refs = Array.isArray(democracyData.referenda) ? democracyData.referenda : [];
            row = refs.find(r => String(r.refIndex) === String(id));
            returnPage = 'democracy';
            returnTab = democracyTab;
        } else if (kind === 'public-proposal' && democracyData) {
            const props = Array.isArray(democracyData.publicProposals) ? democracyData.publicProposals : [];
            row = props.find(p => String(p.index) === String(id));
            returnPage = 'democracy';
            returnTab = democracyTab;
        }
        if (!row) return;
        openGovernanceDetailModal({ kind, row, returnPage, returnTab });
    });

    // Delegated handler for the per-row "Propose motion" button on the open
    // treasury proposals table. Opens the Propose Motion modal pre-filled with
    // the proposal id (defaulting to an approval); the modal handles connect +
    // council-membership gating.
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.treasury-propose-row-btn') : null;
        if (!btn) return;
        e.preventDefault();
        const proposalId = btn.getAttribute('data-proposal-id');
        openProposeMotionModal({ proposalId, callType: 'treasury.approveProposal' });
    });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Advanced — Proxies + Multisig
//
// Two read+act features that exist on every Substrate runtime but are
// historically buried in Polkadot.js Apps. Surfacing them in the explorer
// keeps users from having to leave for routine ops.
//
//   Proxies. Read /api/proxies/<addr>, render rows. Add via `proxy.addProxy
//   (delegate, type, delay)`; remove via `proxy.removeProxy`. Proxy types
//   come from /api/proxy-types (read off chain metadata).
//
//   Multisig. v1 ships read-only:
//     - Address calculator. Given a list of signers + threshold, derives
//       the deterministic multisig address client-side via createKeyMulti.
//     - Pending approvals viewer. Renders entries from
//       /api/multisigs/<addr> so a depositor can see what's outstanding.
//   Approve / cancel signing flows are v2 (need timepoint/threshold
//   tracking and call-decode UX).
// ─────────────────────────────────────────────────────────────────────────────

async function renderWalletAdvancedSection(address, isOwnWallet) {
    const slot = document.getElementById('wallet-advanced-section');
    if (!slot || !address) return;
    // Render the static shell first so the user sees something immediately;
    // the proxy + multisig fetches populate their respective sub-cards.
    slot.innerHTML = `
        <div class="list-container glass" style="margin-top: 20px;">
            <div class="list-header">
                <h2><i class='bx bx-shield-quarter' style="vertical-align:middle;color:var(--brand-secondary);"></i> Advanced</h2>
                <span style="color:var(--text-muted);font-size:0.78rem;">Delegate signing &amp; coordinate multisig</span>
            </div>

            <div style="padding: 20px;">
                <h3 style="font-size:0.95rem;margin:0 0 12px 0;">
                    <span class="glossary-term" data-term="proxy">Proxies</span>
                    <span style="color:var(--text-muted);font-weight:400;font-size:0.78rem;">delegates that can sign for this account</span>
                </h3>
                <div id="wallet-proxy-list" style="margin-bottom: 14px;">
                    <div style="color:var(--text-muted);font-size:0.85rem;">Loading proxies…</div>
                </div>
                ${isOwnWallet ? `<div id="wallet-proxy-add" style="border-top:1px solid var(--border-color);padding-top:14px;margin-top:6px;"></div>` : ''}
            </div>

            <div style="padding: 20px; border-top: 1px solid var(--border-color);">
                <h3 style="font-size:0.95rem;margin:0 0 12px 0;">
                    <span class="glossary-term" data-term="multisig">Multisig</span>
                    <span style="color:var(--text-muted);font-weight:400;font-size:0.78rem;">derive the address &amp; view pending calls</span>
                </h3>
                <div id="wallet-multisig-calc"></div>
                <div id="wallet-multisig-pending" style="margin-top: 18px;"></div>
            </div>
        </div>`;

    renderProxyList(address, isOwnWallet);
    if (isOwnWallet) renderAddProxyForm(address);
    renderMultisigCalculator();
    renderMultisigPending(address);
}

// ── Proxies ─────────────────────────────────────────────────────────────────

async function renderProxyList(address, isOwnWallet) {
    const el = document.getElementById('wallet-proxy-list');
    if (!el) return;
    try {
        const data = await fetchApiJson('/api/proxies/' + encodeURIComponent(address));
        const list = Array.isArray(data.proxies) ? data.proxies : [];
        if (!list.length) {
            el.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;padding:8px 0;">No proxies set. ${isOwnWallet ? 'Use the form below to add one.' : ''}</div>`;
            return;
        }
        const rows = list.map(p => `<tr>
            <td style="padding:8px 4px;"><a href="/account/${encodeURIComponent(p.delegate)}" class="item-link address-cell" style="color:var(--brand-secondary);font-size:0.82rem;">${stakingEscapeHtml(stakingShortAddress(p.delegate))}</a></td>
            <td style="padding:8px 4px;"><code style="font-size:0.78rem;color:var(--text-secondary);">${stakingEscapeHtml(p.proxyType)}</code></td>
            <td style="padding:8px 4px;text-align:right;font-size:0.78rem;color:var(--text-secondary);">${stakingFormatNumber(p.delay)} blocks</td>
            <td style="padding:8px 4px;text-align:right;">
                ${isOwnWallet ? `<button type="button" class="staking-download-btn proxy-remove-btn" data-delegate="${stakingEscapeHtml(p.delegate)}" data-proxy-type="${stakingEscapeHtml(p.proxyType)}" data-delay="${p.delay}" style="padding:4px 10px;font-size:0.72rem;color:var(--error);border-color:rgba(231,76,60,0.4);">Remove</button>` : ''}
            </td>
        </tr>`).join('');
        el.innerHTML = `
            <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:6px;">Deposit reserved: ${stakingFormatPDEX(data.deposit)} PDEX</div>
            <div class="table-responsive"><table class="data-table" style="margin:0;">
                <thead><tr><th>Delegate</th><th>Type</th><th style="text-align:right;">Delay</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
        // Remove handlers — each row's button fires proxy.removeProxy(delegate, type, delay).
        if (isOwnWallet) {
            el.querySelectorAll('.proxy-remove-btn').forEach(btn => btn.addEventListener('click', () => {
                const delegate = btn.getAttribute('data-delegate');
                const proxyType = btn.getAttribute('data-proxy-type');
                const delay = parseInt(btn.getAttribute('data-delay'), 10) || 0;
                if (!confirm(`Remove proxy ${stakingShortAddress(delegate)} (${proxyType})?`)) return;
                submitSignedTx({
                    buildTx: api => api.tx.proxy.removeProxy(delegate, proxyType, delay),
                    label: `Remove ${proxyType} proxy`,
                    button: btn,
                    busyText: 'Signing…',
                    idleText: 'Remove',
                    onSuccess: () => setTimeout(() => renderProxyList(address, isOwnWallet), 2500)
                });
            }));
        }
    } catch (e) {
        // 501 from the backend when the runtime has no proxy pallet → hide
        // gracefully rather than rendering a scary error.
        if (e && e.status === 501) {
            el.innerHTML = `<div style="color:var(--text-muted);font-size:0.85rem;">Proxy pallet is not available on this runtime.</div>`;
        } else {
            renderApiError(el, e, () => renderProxyList(address, isOwnWallet));
        }
    }
}

let cachedProxyTypes = null;

async function renderAddProxyForm(address) {
    const el = document.getElementById('wallet-proxy-add');
    if (!el) return;
    try {
        if (!cachedProxyTypes) {
            const data = await fetchApiJson('/api/proxy-types');
            cachedProxyTypes = Array.isArray(data.types) && data.types.length ? data.types : ['Any', 'NonTransfer', 'Governance', 'Staking', 'IdentityJudgement', 'CancelProxy'];
        }
    } catch (_) {
        cachedProxyTypes = ['Any', 'NonTransfer', 'Governance', 'Staking', 'IdentityJudgement', 'CancelProxy'];
    }
    el.innerHTML = `
        <h4 style="font-size:0.82rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px 0;">Add a proxy</h4>
        <div style="display:grid;grid-template-columns:1fr 180px 100px auto;gap:8px;align-items:center;">
            <input type="text" id="proxy-add-delegate" placeholder="Delegate address (es…)" autocomplete="off" spellcheck="false" style="padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);color:var(--text-primary);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;">
            <select id="proxy-add-type" style="padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);color:var(--text-primary);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;">
                ${cachedProxyTypes.map(t => `<option value="${stakingEscapeHtml(t)}">${stakingEscapeHtml(t)}</option>`).join('')}
            </select>
            <input type="number" id="proxy-add-delay" placeholder="Delay" min="0" value="0" title="Delay in blocks before this proxy can sign" style="padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);color:var(--text-primary);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;">
            <button type="button" id="proxy-add-submit" class="staking-download-btn" style="padding:8px 16px;font-size:0.82rem;background:var(--brand-primary);color:white;border-color:var(--brand-primary);">Add proxy</button>
        </div>
        <div id="proxy-add-error" class="staking-error" style="display:none;margin-top:8px;font-size:0.78rem;"></div>`;

    const submitBtn = document.getElementById('proxy-add-submit');
    if (submitBtn) submitBtn.addEventListener('click', () => {
        const errEl = document.getElementById('proxy-add-error');
        const showErr = m => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
        const delegateInput = document.getElementById('proxy-add-delegate');
        const typeInput = document.getElementById('proxy-add-type');
        const delayInput = document.getElementById('proxy-add-delay');
        const delegate = (delegateInput && delegateInput.value || '').trim();
        const proxyType = (typeInput && typeInput.value || 'Any').trim();
        const delay = parseInt(delayInput && delayInput.value || '0', 10) || 0;
        if (!isValidPolkadexAddress(delegate)) return showErr('Delegate address is not a valid Polkadex address.');
        if (delay < 0 || delay > 10_000_000) return showErr('Delay looks unreasonable.');
        if (errEl) errEl.style.display = 'none';
        submitSignedTx({
            buildTx: api => api.tx.proxy.addProxy(delegate, proxyType, delay),
            label: `Add ${proxyType} proxy`,
            button: submitBtn,
            busyText: 'Signing…',
            idleText: 'Add proxy',
            onError: showErr,
            onSuccess: () => {
                if (delegateInput) delegateInput.value = '';
                setTimeout(() => renderProxyList(address, true), 2500);
            }
        });
    });
}

// ── Multisig calculator (client-side, pure derivation) ──────────────────────

function renderMultisigCalculator() {
    const el = document.getElementById('wallet-multisig-calc');
    if (!el) return;
    el.innerHTML = `
        <h4 style="font-size:0.82rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px 0;">Multisig address calculator</h4>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px;">Paste one address per line and pick a threshold. The address below is the deterministic <span class="glossary-term" data-term="multisig">multisig</span> account for those signers.</div>
        <textarea id="multisig-signers" rows="4" placeholder="es… (one per line)" spellcheck="false" style="width:100%;padding:10px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);color:var(--text-primary);border-radius:var(--radius-sm);font-family:monospace;font-size:0.82rem;resize:vertical;"></textarea>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <label style="font-size:0.82rem;color:var(--text-secondary);">Threshold</label>
            <input type="number" id="multisig-threshold" min="1" value="2" style="width:80px;padding:6px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);color:var(--text-primary);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;">
            <button type="button" id="multisig-calc-go" class="staking-download-btn" style="padding:6px 14px;font-size:0.78rem;">Derive address</button>
        </div>
        <div id="multisig-result" style="margin-top:10px;font-size:0.85rem;"></div>`;
    const goBtn = document.getElementById('multisig-calc-go');
    if (goBtn) goBtn.addEventListener('click', () => {
        const result = document.getElementById('multisig-result');
        if (!result) return;
        const textarea = document.getElementById('multisig-signers');
        const thrInput = document.getElementById('multisig-threshold');
        const lines = ((textarea && textarea.value) || '')
            .split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
        const threshold = parseInt(thrInput && thrInput.value || '0', 10);
        if (lines.length < 2) { result.innerHTML = `<span style="color:var(--error);">Add at least two signer addresses.</span>`; return; }
        if (!Number.isFinite(threshold) || threshold < 1 || threshold > lines.length) {
            result.innerHTML = `<span style="color:var(--error);">Threshold must be between 1 and ${lines.length}.</span>`;
            return;
        }
        // Validate every line is a real address before passing into the
        // crypto routine — otherwise decodeAddress throws and the user
        // sees an opaque error.
        for (const addr of lines) {
            if (!isValidPolkadexAddress(addr)) { result.innerHTML = `<span style="color:var(--error);">Not a valid Polkadex address: ${stakingEscapeHtml(stakingShortAddress(addr))}</span>`; return; }
        }
        try {
            // createKeyMulti expects sorted public keys; sortAddresses returns
            // the address strings sorted by their underlying public-key bytes.
            const sorted = sortAddresses(lines, POLKADEX_SS58);
            const multisigPubKey = createKeyMulti(sorted, threshold);
            const multisigAddr = encodeAddress(multisigPubKey, POLKADEX_SS58);
            result.innerHTML = `
                <div style="padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border-color);border-radius:var(--radius-sm);">
                    <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">Multisig address (${threshold}-of-${lines.length})</div>
                    <div class="address-cell" data-address="${stakingEscapeHtml(multisigAddr)}" style="word-break:break-all;color:var(--brand-secondary);font-weight:600;">${stakingEscapeHtml(multisigAddr)} <span class="js-copy-address" style="cursor:pointer;color:var(--text-muted);font-size:0.78rem;margin-left:8px;">copy</span></div>
                    <div style="margin-top:6px;"><a href="/account/${encodeURIComponent(multisigAddr)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">View on-chain</a></div>
                </div>`;
            // Audit F-122: listener + escaped data-address, no inline onclick.
            result.querySelectorAll('.js-copy-address').forEach(el => {
                el.addEventListener('click', function () {
                    const holder = this.closest('[data-address]');
                    if (holder) copyToClipboard(this, holder.getAttribute('data-address'));
                });
            });
        } catch (e) {
            result.innerHTML = `<span style="color:var(--error);">Derivation failed: ${stakingEscapeHtml(e.message || String(e))}</span>`;
        }
    });
}

// ── Multisig pending approvals (read-only viewer) ───────────────────────────

async function renderMultisigPending(address) {
    const el = document.getElementById('wallet-multisig-pending');
    if (!el) return;
    try {
        const data = await fetchApiJson('/api/multisigs/' + encodeURIComponent(address));
        const list = Array.isArray(data.pending) ? data.pending : [];
        el.innerHTML = `
            <h4 style="font-size:0.82rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px 0;">Pending multisig calls <span style="color:var(--text-muted);font-weight:400;font-size:0.72rem;text-transform:none;letter-spacing:0;">(if this address is a multisig)</span></h4>
            ${list.length === 0
                ? `<div style="color:var(--text-muted);font-size:0.82rem;padding:6px 0;">No pending multisig approvals against this address.</div>`
                : `<div class="table-responsive"><table class="data-table" style="margin:0;">
                    <thead><tr><th>Call hash</th><th>Approvals</th><th style="text-align:right;">Depositor</th><th style="text-align:right;">When</th></tr></thead>
                    <tbody>${list.map(p => `<tr>
                        <td style="padding:8px 4px;"><code style="font-size:0.78rem;color:var(--brand-secondary);word-break:break-all;">${stakingEscapeHtml(stakingShortAddress(p.callHash || '') || '—')}</code></td>
                        <td style="padding:8px 4px;font-size:0.82rem;">${(p.approvals || []).length}</td>
                        <td style="padding:8px 4px;text-align:right;"><a href="/account/${encodeURIComponent(p.depositor || '')}" class="item-link address-cell" style="color:var(--brand-secondary);font-size:0.78rem;">${stakingEscapeHtml(stakingShortAddress(p.depositor || '') || '—')}</a></td>
                        <td style="padding:8px 4px;text-align:right;font-size:0.78rem;color:var(--text-secondary);">${p.when ? `block ${stakingFormatNumber(p.when.height)}` : '—'}</td>
                    </tr>`).join('')}</tbody>
                </table></div>
                <div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px;">Approve / cancel signing is coming in a future update — for now, sign via Polkadot.js Apps with the call hash above.</div>`
            }`;
    } catch (e) {
        if (e && e.status === 501) {
            el.innerHTML = `<div style="color:var(--text-muted);font-size:0.82rem;">Multisig pallet is not available on this runtime.</div>`;
        } else {
            renderApiError(el, e, () => renderMultisigPending(address));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Address labels (v2: community-sourced + voting)
//
// Anyone signed in (via the existing wallet-signature flow) can suggest a
// label for any address. The address's owner gets a sticky "self-label"
// that always outranks community suggestions. Other suggestions are ranked
// by net vote score and filtered by the chain's standard threshold for
// reports/vetoes.
//
// Two caches:
//   addressTopLabelCache  — address → { label, signer, isSelf } | null | Promise
//                           Drives the inline .addr-label pill across the explorer.
//   addressLabelsCache    — address → array of full label rows.
//                           Drives the account-details panel (votes + reports).
//
// Both caches invalidate on any local write (suggest/vote/report/veto) so
// the next render sees fresh data without a hard reload.
// ─────────────────────────────────────────────────────────────────────────────
const addressTopLabelCache = new Map();
const addressLabelsCache   = new Map();

function invalidateAddressLabelCache(address) {
    addressTopLabelCache.delete(address);
    addressLabelsCache.delete(address);
}

// Returns just the top label (used by the inline pill). Cached as a string
// or {label, signer, isSelf} object — callers that need the source pass
// `{ withSource: true }`.
async function fetchAddressLabel(address, opts = {}) {
    if (!address) return null;
    const withSource = !!opts.withSource;
    if (addressTopLabelCache.has(address)) {
        const v = addressTopLabelCache.get(address);
        const resolved = v && typeof v.then === 'function' ? await v : v;
        if (!resolved) return null;
        return withSource ? resolved : resolved.label;
    }
    const p = (async () => {
        try {
            const data = await fetchLabelsJson(address);
            const top = data && data.topLabel ? {
                label: data.topLabel.label,
                signer: data.topLabel.signer,
                isSelf: !!data.topLabel.isSelf
            } : null;
            addressTopLabelCache.set(address, top);
            // Opportunistically populate the full-list cache too so the
            // account-details panel can render without another round trip.
            if (data && Array.isArray(data.labels)) addressLabelsCache.set(address, data.labels);
            return top;
        } catch (_) {
            addressTopLabelCache.set(address, null);
            return null;
        }
    })();
    addressTopLabelCache.set(address, p);
    const resolved = await p;
    if (!resolved) return null;
    return withSource ? resolved : resolved.label;
}

// Authed GET — when a session token is available, attaches it so the
// returned rows include `viewerVote`. Falls back to anonymous read.
async function fetchLabelsJson(address) {
    const session = getDiscussSession();
    const headers = {};
    if (session && session.token) headers['Authorization'] = 'Bearer ' + session.token;
    const res = await fetch('/api/labels/' + encodeURIComponent(address), { headers });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error((txt && txt.slice(0, 120)) || ('HTTP ' + res.status));
    }
    return await res.json();
}

// Apply the top label to every container element on the page that opted in
// via `class="address-with-label" data-address="<addr>"`. Idempotent — won't
// double-stamp the pill. A community label gets the `community` modifier
// class so its CSS can render differently from a self-label.
function applyAddressLabelToDom(address, top) {
    if (!address || !top || !top.label) return;
    const nodes = document.querySelectorAll(`.address-with-label[data-address="${CSS.escape(address)}"]`);
    nodes.forEach(node => {
        const existing = node.querySelector('.addr-label');
        if (existing) existing.remove();
        const tag = document.createElement('span');
        tag.className = 'addr-label' + (top.isSelf ? '' : ' community');
        tag.textContent = top.label;
        tag.title = top.isSelf
            ? 'Self-set label (signed by the address owner)'
            : 'Community-suggested label · click the address to see other suggestions';
        node.insertBefore(tag, node.firstChild);
    });
}

// Helper used by every list page to lazily decorate addresses with their
// top label. Safe to spam — the cache deduplicates.
async function ensureAddressLabel(address) {
    if (!address) return;
    const top = await fetchAddressLabel(address, { withSource: true });
    if (top && top.label) applyAddressLabelToDom(address, top);
}

// ─── Account-details labels panel (v2) ──────────────────────────────────────
// One self-label row at the top (if any), then a vote-sorted list of
// community suggestions, plus a "Suggest a label" form when signed in.
async function renderAccountLabelEditor(address) {
    const slot = document.getElementById('account-label-editor');
    if (!slot || !address) return;
    const session = getDiscussSession();
    const isOwner = !!(session && session.address === address);

    // Fetch fresh — labels can be voted/reported by anyone else at any time.
    let data;
    try { data = await fetchLabelsJson(address); }
    catch (e) {
        slot.innerHTML = `<div style="margin-top:10px;color:var(--text-muted);font-size:0.78rem;">Couldn't load labels: ${stakingEscapeHtml(e.message)}</div>`;
        return;
    }
    const labels = Array.isArray(data.labels) ? data.labels : [];
    addressLabelsCache.set(address, labels);
    const selfRow = labels.find(l => l.isSelf) || null;
    const community = labels.filter(l => !l.isSelf);

    // ─ Row renderer ───────────────────────────────────────────────────────
    const renderLabelRow = (l) => {
        const myVote = Number(l.viewerVote) || 0;
        const hiddenByReports = l.reportCount >= 3;
        const isMine = session && session.address === l.signer;
        return `<div class="label-row ${l.vetoed || hiddenByReports ? 'hidden-label' : ''}" data-signer="${stakingEscapeHtml(l.signer)}" style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid rgba(255,255,255,0.04);">
            ${ l.isSelf
                ? '' // self-labels don't get vote arrows (the score doesn't drive their ranking)
                : (() => {
                    // Buttons are enabled whenever the user has a connected
                    // wallet — the action handler transparently signs in if
                    // there's no session yet (see ensureLabelSession). Only
                    // truly-anonymous visitors get a disabled state with a
                    // tooltip pointing to the connect flow.
                    const canVote = !!(session || getStoredWallet());
                    const tip = session ? 'Vote' : (getStoredWallet() ? 'Sign in to vote (one-time signature)' : 'Connect a wallet to vote');
                    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:32px;">
                    <button type="button" class="label-vote-btn" data-vote="1"  title="${stakingEscapeHtml(tip)}" ${canVote ? '' : 'disabled'} style="background:none;border:none;cursor:${canVote?'pointer':'not-allowed'};color:${myVote===1?'var(--success)':'var(--text-muted)'};padding:0;font-size:1.1rem;line-height:1;"><i class='bx bx-chevron-up'></i></button>
                    <span style="font-size:0.82rem;font-weight:600;color:var(--text-primary);min-width:24px;text-align:center;">${l.score > 0 ? '+' : ''}${l.score}</span>
                    <button type="button" class="label-vote-btn" data-vote="-1" title="${stakingEscapeHtml(tip)}" ${canVote ? '' : 'disabled'} style="background:none;border:none;cursor:${canVote?'pointer':'not-allowed'};color:${myVote===-1?'var(--error)':'var(--text-muted)'};padding:0;font-size:1.1rem;line-height:1;"><i class='bx bx-chevron-down'></i></button>
                </div>`;
                })()
            }
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <strong style="color:var(--text-primary);">${stakingEscapeHtml(l.label)}</strong>
                    ${l.isSelf ? `<span class="reward-badge claimed" style="font-size:0.7rem;padding:1px 8px;">verified owner</span>` : ''}
                    ${l.vetoed ? `<span class="reward-badge unclaimed" style="font-size:0.7rem;padding:1px 8px;">vetoed</span>` : ''}
                    ${hiddenByReports ? `<span class="reward-badge unclaimed" style="font-size:0.7rem;padding:1px 8px;">hidden (reports)</span>` : ''}
                </div>
                <div style="color:var(--text-muted);font-size:0.72rem;margin-top:2px;">
                    by <a href="/account/${encodeURIComponent(l.signer)}" class="item-link" style="color:var(--brand-secondary);">${stakingEscapeHtml(stakingShortAddress(l.signer))}</a>
                    · ${stakingEscapeHtml(formatLocalDateTime(l.createdAt || 0))}
                    ${l.reportCount > 0 ? ` · <span style="color:var(--error);">${l.reportCount} report${l.reportCount === 1 ? '' : 's'}</span>` : ''}
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
                ${isMine ? `<button type="button" class="label-delete-btn staking-download-btn" style="padding:4px 10px;font-size:0.72rem;color:var(--error);border-color:rgba(231,76,60,0.4);">Remove mine</button>` : ''}
                ${!isMine && !l.isSelf && session ? `<button type="button" class="label-report-btn staking-download-btn" style="padding:4px 10px;font-size:0.72rem;color:var(--text-muted);">Report</button>` : ''}
                ${isOwner && !l.isSelf ? `<button type="button" class="label-veto-btn staking-download-btn" style="padding:4px 10px;font-size:0.72rem;color:${l.vetoed ? 'var(--success)' : 'var(--error)'};border-color:rgba(231,76,60,0.4);">${l.vetoed ? 'Un-veto' : 'Veto'}</button>` : ''}
            </div>
        </div>`;
    };

    // ─ Suggest form ───────────────────────────────────────────────────────
    // Three CTA states:
    //   1. Signed in              → full suggest form
    //   2. Wallet connected, no session → "Sign in" button (signs a challenge
    //      with the connected wallet — no reconnection needed). This was a
    //      common user-confusion case: people saw "Connect your wallet" even
    //      after connecting, because labels need a session token, not just
    //      an address.
    //   3. No wallet at all       → "Connect a wallet" link to /wallet.
    const connectedAddress = getStoredWallet();
    const mineLabel = session ? (community.find(c => c.signer === session.address) || (selfRow && selfRow.signer === session.address ? selfRow : null)) : null;
    let suggestForm;
    if (session) {
        suggestForm = `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-color);">
                <h4 style="font-size:0.82rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px 0;">${isOwner ? 'Set your label' : 'Suggest a label'}</h4>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <input type="text" id="account-label-input" maxlength="64" placeholder="${isOwner ? 'Foundation Wallet, Cold Storage #1, …' : 'Binance hot wallet, Polkadex Sudo, …'}" value="${stakingEscapeHtml(mineLabel ? mineLabel.label : '')}" style="flex:1;min-width:220px;padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);color:var(--text-primary);border-radius:var(--radius-sm);font-family:inherit;font-size:0.85rem;">
                    <button type="button" id="account-label-save" class="staking-download-btn" style="padding:8px 16px;font-size:0.82rem;background:var(--brand-primary);color:white;border-color:var(--brand-primary);">${mineLabel ? 'Update' : (isOwner ? 'Set label' : 'Suggest')}</button>
                </div>
                <div id="account-label-status" style="margin-top:8px;font-size:0.78rem;color:var(--text-muted);">${isOwner
                    ? 'Owner labels (verified by signature) always outrank community suggestions.'
                    : 'Your suggestion will appear in this list. The community votes on it; the address owner can veto.'}
                    Signed in as <code style="font-size:0.72rem;">${stakingEscapeHtml(stakingShortAddress(session.address))}</code>.</div>
            </div>`;
    } else if (connectedAddress) {
        suggestForm = `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-color);">
                <h4 style="font-size:0.82rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 8px 0;">Sign in to suggest &amp; vote</h4>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button type="button" id="account-label-signin" class="staking-download-btn" style="padding:8px 18px;font-size:0.82rem;background:var(--brand-primary);color:white;border-color:var(--brand-primary);"><i class='bx bx-log-in'></i> Sign in with wallet</button>
                    <span style="color:var(--text-muted);font-size:0.78rem;">connected as <code style="font-size:0.72rem;">${stakingEscapeHtml(stakingShortAddress(connectedAddress))}</code></span>
                </div>
                <div style="margin-top:8px;color:var(--text-muted);font-size:0.78rem;">One-time signature proves you own this address — no transaction, no gas. The same session also lets you post on the discussion board.</div>
            </div>`;
    } else {
        // returnTo brings the user back to the current /account/<addr> page
        // after the wallet connect picker resolves. Without it the connect
        // flow silently navigates to the My Account dashboard, leaving the
        // labels editor invisible — confusing for someone who just wanted
        // to vote.
        const returnTo = `/account/${encodeURIComponent(address)}`;
        suggestForm = `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border-color);color:var(--text-muted);font-size:0.82rem;">
                <a href="/wallet?returnTo=${encodeURIComponent(returnTo)}" class="item-link" style="color:var(--brand-secondary);">Connect a wallet</a> to suggest or vote on labels.
           </div>`;
    }

    // ─ Layout ─────────────────────────────────────────────────────────────
    slot.innerHTML = `
        <div style="margin-top:14px;">
            <h4 style="font-size:0.82rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 4px 0;">Labels ${helpIcon('community-labels', 'About community labels')} <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--text-muted);">(${labels.length})</span></h4>
            ${selfRow ? renderLabelRow(selfRow) : ''}
            ${community.length
                ? community.map(renderLabelRow).join('')
                : (selfRow ? '' : `<div style="color:var(--text-muted);font-size:0.82rem;padding:10px 0;">No labels yet. ${session ? 'Be the first to suggest one!' : ''}</div>`)}
            ${suggestForm}
        </div>`;

    // ─ Wire row buttons ───────────────────────────────────────────────────
    slot.querySelectorAll('.label-row').forEach(row => {
        const signer = row.getAttribute('data-signer');
        if (!signer) return;
        row.querySelectorAll('.label-vote-btn').forEach(btn => btn.addEventListener('click', () => labelVote(address, signer, parseInt(btn.getAttribute('data-vote'), 10), btn)));
        const delBtn = row.querySelector('.label-delete-btn');
        if (delBtn) delBtn.addEventListener('click', () => labelDeleteMine(address, signer, delBtn));
        const reportBtn = row.querySelector('.label-report-btn');
        if (reportBtn) reportBtn.addEventListener('click', () => labelReport(address, signer, reportBtn));
        const vetoBtn = row.querySelector('.label-veto-btn');
        if (vetoBtn) vetoBtn.addEventListener('click', () => labelVeto(address, signer, vetoBtn));
    });

    // ─ Wire "Sign in with wallet" button — visible only when a wallet
    //   address is in localStorage but no discussion-board session exists.
    //   Runs the same one-time signature flow the discussion board uses,
    //   then re-renders the panel so the suggest form replaces the button.
    const signinBtn = document.getElementById('account-label-signin');
    if (signinBtn) signinBtn.addEventListener('click', async () => {
        signinBtn.disabled = true;
        const origHtml = signinBtn.innerHTML;
        signinBtn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Check your wallet…";
        const ok = await discussSignIn();
        if (ok) {
            renderAccountLabelEditor(address);
        } else {
            signinBtn.disabled = false;
            signinBtn.innerHTML = origHtml;
        }
    });

    // ─ Wire suggest form ──────────────────────────────────────────────────
    const saveBtn = document.getElementById('account-label-save');
    const statusEl = document.getElementById('account-label-status');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const input = document.getElementById('account-label-input');
        const label = (input && input.value || '').trim();
        if (!label) { if (statusEl) { statusEl.textContent = 'Enter a label first.'; statusEl.style.color = 'var(--error)'; } return; }
        saveBtn.disabled = true;
        try {
            const res = await fetch('/api/labels/' + encodeURIComponent(address), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
                body: JSON.stringify({ label })
            });
            const data = await res.json();
            if (res.status === 401) { localStorage.removeItem(DISCUSS_TOKEN_KEY); throw new Error('Session expired — please sign in again.'); }
            if (res.status === 429) throw new Error(data.error || 'Slow down — try again in a minute.');
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to save label.');
            invalidateAddressLabelCache(address);
            if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = 'var(--success)'; }
            renderAccountLabelEditor(address);
            ensureAddressLabel(address);
        } catch (e) {
            if (statusEl) { statusEl.textContent = e.message; statusEl.style.color = 'var(--error)'; }
        } finally {
            saveBtn.disabled = false;
        }
    });
}

// Returns a live discussion-board session, signing in transparently if a
// wallet is connected but no session exists yet. The label action buttons
// (vote/report/veto) all call this so a connected user can click an up-arrow
// without first realising they also need to sign a challenge. Returns null
// if there's no wallet at all (caller should silently no-op in that case).
async function ensureLabelSession() {
    const existing = getDiscussSession();
    if (existing) return existing;
    if (!getStoredWallet()) return null;
    const ok = await discussSignIn();
    return ok ? getDiscussSession() : null;
}

// ─── Row actions (vote / delete / report / veto) ────────────────────────────
async function labelVote(address, signer, vote, btn) {
    const session = await ensureLabelSession();
    if (!session) return;
    btn.disabled = true;
    try {
        // Toggle: clicking the same arrow again clears the vote.
        const labels = addressLabelsCache.get(address) || [];
        const row = labels.find(l => l.signer === signer);
        const desired = (row && Number(row.viewerVote) === vote) ? 0 : vote;
        const res = await fetch(`/api/labels/${encodeURIComponent(address)}/${encodeURIComponent(signer)}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
            body: JSON.stringify({ vote: desired })
        });
        const data = await res.json();
        if (res.status === 401) { localStorage.removeItem(DISCUSS_TOKEN_KEY); throw new Error('Session expired — please sign in again.'); }
        if (!res.ok || data.error) throw new Error(data.error || 'Vote failed.');
        invalidateAddressLabelCache(address);
        renderAccountLabelEditor(address);
        ensureAddressLabel(address);
    } catch (e) {
        alert(e.message);
    } finally {
        btn.disabled = false;
    }
}

async function labelDeleteMine(address, signer, btn) {
    const session = getDiscussSession();
    if (!session || session.address !== signer) return;
    if (!confirm('Remove your label for this address?')) return;
    btn.disabled = true;
    try {
        const res = await fetch('/api/labels/' + encodeURIComponent(address), {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + session.token }
        });
        if (res.status === 401) { localStorage.removeItem(DISCUSS_TOKEN_KEY); throw new Error('Session expired — please sign in again.'); }
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Delete failed.');
        invalidateAddressLabelCache(address);
        renderAccountLabelEditor(address);
        document.querySelectorAll(`.address-with-label[data-address="${CSS.escape(address)}"] .addr-label`).forEach(n => n.remove());
        ensureAddressLabel(address);
    } catch (e) {
        alert(e.message);
        btn.disabled = false;
    }
}

async function labelReport(address, signer, btn) {
    const session = await ensureLabelSession();
    if (!session) return;
    const reason = prompt('Briefly, why is this label inappropriate? (optional)') || '';
    btn.disabled = true;
    try {
        const res = await fetch(`/api/labels/${encodeURIComponent(address)}/${encodeURIComponent(signer)}/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
            body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Report failed.');
        invalidateAddressLabelCache(address);
        renderAccountLabelEditor(address);
    } catch (e) {
        alert(e.message);
    } finally {
        btn.disabled = false;
    }
}

async function labelVeto(address, signer, btn) {
    const session = await ensureLabelSession();
    if (!session || session.address !== address) return;
    const labels = addressLabelsCache.get(address) || [];
    const row = labels.find(l => l.signer === signer);
    const desired = row ? !row.vetoed : true;
    if (!confirm(desired
        ? 'Hide this community label on your address?'
        : 'Restore this previously-vetoed label?')) return;
    btn.disabled = true;
    try {
        const res = await fetch(`/api/labels/${encodeURIComponent(address)}/${encodeURIComponent(signer)}/veto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
            body: JSON.stringify({ vetoed: desired })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Veto failed.');
        invalidateAddressLabelCache(address);
        renderAccountLabelEditor(address);
        ensureAddressLabel(address);
    } catch (e) {
        alert(e.message);
        btn.disabled = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics dashboard — KPI cards + 4 daily time-series charts driven by the
// /api/analytics/{snapshot,timeseries} endpoints.
//
// Chart.js instances are tracked in `analyticsChartHandles` so subsequent
// re-renders (date-range change, refresh) destroy the old canvas before
// creating a new one — Chart.js leaks canvas + listeners otherwise.
// ─────────────────────────────────────────────────────────────────────────────
let analyticsChartHandles = {};
let analyticsRangeDays = 30;

async function fetchAnalyticsData() {
    const el = document.getElementById('analytics-content');
    if (!el) return;
    // Layout-matching skeleton (KPI cards + chart grid) so the page has shape
    // instantly and doesn't jump when data lands — better perceived load than a
    // bare spinner. The real data usually arrives from the pre-warmed cache.
    const skelKpis = Array(6).fill('<div class="skel skel-kpi"></div>').join('');
    const skelCharts = Array(6).fill('<div class="skel skel-chart"></div>').join('');
    el.innerHTML =
        '<div class="list-container glass analytics-skeleton" aria-busy="true">' +
            '<div class="list-header"><h2>Network Analytics</h2>' +
                '<span style="color:var(--text-muted);font-size:0.78rem;">Loading…</span></div>' +
            '<div class="skel-kpis">' + skelKpis + '</div>' +
            '<div style="padding:14px 24px;"><div class="skel" style="height:32px;width:280px;max-width:70%;"></div></div>' +
            '<div class="skel-charts">' + skelCharts + '</div>' +
        '</div>';

    try {
        // Price history lives behind a separate endpoint (it predates the
        // analytics aggregator and is reused by the wallet dashboard chart).
        // We fetch it in parallel and tolerate a 404/unconfigured CMC key —
        // the analytics page still renders the rest of the charts even when
        // the price feed is dark.
        const [snapshot, ts, priceData] = await Promise.all([
            fetchApiJson('/api/analytics/snapshot'),
            fetchApiJson('/api/analytics/timeseries?days=' + analyticsRangeDays),
            fetchApiJson('/api/price-history?days=' + analyticsRangeDays).catch(() => ({ history: [] }))
        ]);
        renderAnalyticsPage(snapshot, ts, priceData);
    } catch (e) {
        renderApiError(el, e, () => fetchAnalyticsData());
    }
}

function renderAnalyticsPage(snapshot, ts, priceData) {
    const el = document.getElementById('analytics-content');
    if (!el) return;
    const series = (ts && ts.series) || {};

    // Normalize the price-history response into the same { day, value }
    // shape the other series use, so we can feed it through the same
    // chart helpers. `priceData.history` is descending by timestamp;
    // reverse to ascending so the x-axis reads left-to-right oldest→newest.
    const priceSeries = ((priceData && priceData.history) || [])
        .slice()
        .reverse()
        .map(p => ({ day: formatLocalDate(p.timestamp), value: Number(p.price) || 0 }));
    const latestPrice = priceSeries.length ? priceSeries[priceSeries.length - 1].value : null;
    // Audit F-035: the card below hardcoded "CoinMarketCap" and told users to
    // set CMC_API_KEY. The default provider has been keyless CoinGecko since
    // AscendEX shut down (Jul 2026), so that advice sent operators chasing an
    // API key they do not need. Every price_history row carries its own
    // `source` tag — read it instead of naming a provider in the UI.
    const latestPriceSource = (() => {
        const newest = (priceData && priceData.history && priceData.history[0]) || null;
        const tag = newest && newest.source;
        if (!tag) return '';
        const labels = (priceData && priceData.bySource) || {};
        return (labels[tag] && labels[tag].label) || tag;
    })();

    // Same normalization for treasury awards — the v1 dashboard plumbed
    // this through `getDailyAnalytics()` but never rendered it. The series
    // is already in { day, value } shape; we only need the cumulative sum
    // so the chart shows the running total trending up over time.
    const treasuryDaily = Array.isArray(series.treasuryAwarded) ? series.treasuryAwarded : [];
    let cumulativePdex = 0;
    const treasuryCumulative = treasuryDaily.map(p => {
        cumulativePdex += Number(p.value) || 0;
        return { day: p.day, value: cumulativePdex };
    });
    const treasuryTotal = cumulativePdex;

    // KPI strip — the headline numbers the user expects "above the fold"
    // before scrolling into the charts. All from the snapshot endpoint.
    const totalIssuance = Number(snapshot.totalIssuance) || 0;
    const totalStaked = Number(snapshot.totalStaked) || 0;
    const stakingPct = (Number(snapshot.stakingRatio) || 0) * 100;

    const kpiCard = (label, value, sub) =>
        `<div class="staking-summary-card">
            <div class="label">${stakingEscapeHtml(label)}</div>
            <div class="value">${value}</div>
            ${sub ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">${sub}</div>` : ''}
        </div>`;

    // Pill row for changing the date range. Re-uses the existing reward-filter
    // styling so the look stays consistent with other tunable filters.
    const rangePill = (days, label) =>
        `<button class="reward-filter-btn${analyticsRangeDays === days ? ' active' : ''}" data-analytics-range="${days}">${label}</button>`;

    el.innerHTML = `
        <div class="list-container glass">
            <div class="list-header">
                <h2>Network Analytics</h2>
                <span style="color:var(--text-muted);font-size:0.78rem;">Last sync ${stakingEscapeHtml(formatLocalDateTime(snapshot.lastSync) || '—')}</span>
            </div>
            <div style="padding:20px;">
                <div class="staking-summary-grid">
                    ${kpiCard('Indexed blocks',       stakingFormatNumber(snapshot.indexedBlocks), 'blocks in the local index')}
                    ${kpiCard('Indexed transactions', stakingFormatNumber(snapshot.indexedTransactions), 'transfers in the local index')}
                    ${kpiCard(
                        'Validators',
                        `${stakingFormatNumber(snapshot.validatorCount)} <span style="color:var(--text-muted);font-size:0.7rem;font-weight:400;">/ ${stakingFormatNumber(snapshot.totalValidators || snapshot.validatorCount)}</span>`,
                        `active / registered · era #${snapshot.activeEra}`
                    )}
                    ${kpiCard(
                        'Nominators',
                        `${stakingFormatNumber(snapshot.nominatorCount)} <span style="color:var(--text-muted);font-size:0.7rem;font-weight:400;">/ ${stakingFormatNumber(snapshot.totalNominators || snapshot.nominatorCount)}</span>`,
                        'active / registered'
                    )}
                    ${kpiCard('Total staked',         `${stakingFormatPDEX(totalStaked)} <span class="unit">PDEX</span>`, `${stakingPct.toFixed(2)}% of issuance`)}
                    ${kpiCard('Total issuance',       `${stakingFormatPDEX(totalIssuance)} <span class="unit">PDEX</span>`, 'circulating + locked')}
                </div>

                <div class="staking-toolbar" style="margin-top:20px;">
                    <div class="reward-filter">
                        ${rangePill(7,  'Last 7 days')}
                        ${rangePill(30, 'Last 30 days')}
                        ${rangePill(90, 'Last 90 days')}
                        ${rangePill(365,'Last year')}
                    </div>
                </div>

                <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(360px, 1fr));gap:18px;margin-top:18px;">
                    ${analyticsChartCard('Daily transactions',  'analytics-chart-tx-count',   `${series.txCount?.length || 0} day(s) of data`)}
                    ${analyticsChartCard('Daily PDEX volume',   'analytics-chart-tx-volume', 'sum of transfer amounts per day')}
                    ${analyticsChartCard('Daily active addresses', 'analytics-chart-addrs', 'distinct addresses involved per day')}
                    ${analyticsChartCard('Daily blocks produced', 'analytics-chart-blocks', `avg ${series.avgExtrinsics?.length ? Number(series.avgExtrinsics[series.avgExtrinsics.length-1].value).toFixed(1) : '—'} extrinsics/block recently`)}
                    ${analyticsChartCard(
                        'PDEX / USD',
                        'analytics-chart-price',
                        priceSeries.length
                            ? `latest ${latestPrice != null ? '$' + Number(latestPrice).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'}${latestPriceSource ? ' · ' + escapeHtml(latestPriceSource) : ''}`
                            : 'no price data yet — the feed fills in as it polls'
                    )}
                    ${analyticsChartCard(
                        'Treasury awards (cumulative)',
                        'analytics-chart-treasury',
                        treasuryTotal > 0
                            ? `${stakingFormatPDEX(treasuryTotal)} PDEX awarded across the window`
                            : 'no treasury payouts in this window'
                    )}
                </div>
            </div>
        </div>
    `;

    // Destroy any prior Chart.js instances before re-mounting so canvases
    // don't leak on date-range toggles.
    Object.values(analyticsChartHandles).forEach(c => { try { c.destroy(); } catch (_) {} });
    analyticsChartHandles = {};

    drawAnalyticsBarChart('analytics-chart-tx-count',   series.txCount,         'Transactions',   '#e6007a');
    drawAnalyticsLineChart('analytics-chart-tx-volume',  series.txVolume,        'PDEX volume',    '#00d4ff');
    drawAnalyticsLineChart('analytics-chart-addrs',      series.activeAddresses, 'Active addresses','#2ecc71');
    drawAnalyticsBarChart('analytics-chart-blocks',     series.blocks,          'Blocks',         '#9b59b6');
    // Price line — drawn once the configured provider (CoinGecko by default)
    // has returned data. The helper no-ops if the canvas is missing or the
    // series is empty.
    drawAnalyticsLineChart('analytics-chart-price',     priceSeries,            'USD',            '#f5a623');
    // Treasury cumulative line — climbs with every awarded proposal.
    // Shown even when the day list is empty so the empty-state subtitle
    // explains the situation.
    drawAnalyticsLineChart('analytics-chart-treasury',  treasuryCumulative,     'PDEX awarded',   '#9b59b6');

    // Range pill click handlers — re-fetch with the new day count.
    el.querySelectorAll('[data-analytics-range]').forEach(btn => {
        btn.addEventListener('click', () => {
            const d = parseInt(btn.getAttribute('data-analytics-range'), 10);
            if (Number.isFinite(d) && d > 0) {
                analyticsRangeDays = d;
                fetchAnalyticsData();
            }
        });
    });
}

function analyticsChartCard(title, canvasId, subtitle) {
    return `<div class="glass" style="padding:16px;border-radius:var(--radius-sm);">
        <div style="margin-bottom:10px;">
            <div style="font-size:0.95rem;font-weight:600;color:var(--text-primary);">${stakingEscapeHtml(title)}</div>
            ${subtitle ? `<div style="font-size:0.72rem;color:var(--text-muted);">${stakingEscapeHtml(subtitle)}</div>` : ''}
        </div>
        <div style="height:220px;position:relative;"><canvas id="${stakingEscapeHtml(canvasId)}"></canvas></div>
    </div>`;
}

function drawAnalyticsBarChart(canvasId, series, label, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !Array.isArray(series) || !window.Chart) return;
    analyticsChartHandles[canvasId] = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: series.map(p => p.day),
            datasets: [{
                label,
                data: series.map(p => p.value),
                backgroundColor: color,
                borderColor: color,
                borderWidth: 0
            }]
        },
        options: analyticsChartOptions()
    });
}

function drawAnalyticsLineChart(canvasId, series, label, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !Array.isArray(series) || !window.Chart) return;
    analyticsChartHandles[canvasId] = new Chart(canvas, {
        type: 'line',
        data: {
            labels: series.map(p => p.day),
            datasets: [{
                label,
                data: series.map(p => p.value),
                borderColor: color,
                backgroundColor: color + '33',
                fill: true,
                tension: 0.3,
                pointRadius: 2,
                pointHoverRadius: 4
            }]
        },
        options: analyticsChartOptions()
    });
}

// Shared Chart.js options — single source so all the analytics charts
// look identical (dark grid, no legend, compact ticks).
function analyticsChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    label: ctx => ' ' + (ctx.dataset.label || '') + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 4 })
                }
            }
        },
        scales: {
            x: {
                ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: 7 },
                grid:  { color: 'rgba(255,255,255,0.04)' }
            },
            y: {
                beginAtZero: true,
                ticks: {
                    color: '#888',
                    callback: v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
                },
                grid:  { color: 'rgba(255,255,255,0.04)' }
            }
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Watchlist — localStorage-backed star/unstar across the explorer.
//
// Storage shape (single key, JSON-encoded):
//   {
//     "<kind>:<id>": { kind, id, label, addedAt },
//     ...
//   }
// kinds: 'address' | 'validator' | 'referendum' | 'motion' | 'treasury' |
//        'public-proposal' | 'block'
//
// Why a single map rather than per-kind arrays: cheap O(1) lookup at every
// star-icon render to decide whether to show the filled or outline icon, and
// trivial to atomically rewrite on add/remove.
// ─────────────────────────────────────────────────────────────────────────────
const WATCHLIST_STORAGE_KEY = 'pdex_watchlist_v1';

function getWatchlist() {
    try {
        const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) { return {}; }
}
function setWatchlist(map) {
    try { localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(map)); }
    catch (_) { /* storage full / disabled — silently ignore */ }
}
function watchlistKey(kind, id) { return `${kind}:${id}`; }
function isWatched(kind, id) {
    const m = getWatchlist();
    return Object.prototype.hasOwnProperty.call(m, watchlistKey(kind, id));
}
function addToWatchlist(kind, id, label) {
    const m = getWatchlist();
    m[watchlistKey(kind, id)] = { kind, id: String(id), label: String(label || id), addedAt: Date.now() };
    setWatchlist(m);
    // Notify any open page (e.g. /watchlist) so it can re-render.
    document.dispatchEvent(new CustomEvent('watchlist:change'));
}
function removeFromWatchlist(kind, id) {
    const m = getWatchlist();
    delete m[watchlistKey(kind, id)];
    setWatchlist(m);
    document.dispatchEvent(new CustomEvent('watchlist:change'));
}
function toggleWatchlist(kind, id, label) {
    if (isWatched(kind, id)) removeFromWatchlist(kind, id);
    else addToWatchlist(kind, id, label);
}

// Star button renderer — drop this into any cell/header that should be
// toggleable. The data-* attributes drive a single global click delegate
// (see wireWatchlistStars) so the icon works no matter when its container
// is mounted into the DOM.
function watchlistStarButton(kind, id, label) {
    const filled = isWatched(kind, id);
    const icon = filled ? 'bxs-star' : 'bx-star';
    const color = filled ? 'var(--brand-primary)' : 'var(--text-muted)';
    const title = filled ? 'Remove from watchlist' : 'Add to watchlist';
    return `<button type="button" class="watchlist-star" data-watch-kind="${stakingEscapeHtml(kind)}" data-watch-id="${stakingEscapeHtml(String(id))}" data-watch-label="${stakingEscapeHtml(String(label || id))}" title="${title}" aria-label="${title}" style="background:none;border:none;padding:2px 4px;cursor:pointer;color:${color};vertical-align:middle;line-height:1;font-size:1rem;"><i class='bx ${icon}'></i></button>`;
}

// Render the dedicated /watchlist page — grouped sections by kind, each with
// the addedAt timestamp and a quick-link to the underlying detail page.
function renderWatchlistPage() {
    const container = document.getElementById('watchlist-content');
    if (!container) return;
    const map = getWatchlist();
    const items = Object.values(map).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (!items.length) {
        container.innerHTML = `
            <div class="glass" style="padding:48px 24px;text-align:center;">
                <i class='bx bx-star' style="font-size:48px;color:var(--text-muted);"></i>
                <h2 style="margin:16px 0 8px 0;">Your watchlist is empty</h2>
                <p style="color:var(--text-secondary);max-width:520px;margin:0 auto;">
                    Click the <i class='bx bx-star' style="color:var(--text-muted);"></i> star next to any address, validator, referendum, motion, or treasury proposal to keep it here. The list lives in your browser only — clearing site data resets it.
                </p>
            </div>`;
        return;
    }

    // Group by kind. The label sort order below is deliberate — addresses/
    // validators (frequent re-checks) come before governance items (slow-
    // moving). Each kind links into its existing detail page so the user
    // doesn't need a new lookup endpoint.
    const groups = {
        validator:        { label: 'Validators',           pathFor: id => `/validator/${encodeURIComponent(id)}` },
        address:          { label: 'Accounts',             pathFor: id => `/account/${encodeURIComponent(id)}` },
        referendum:       { label: 'Referenda',            pathFor: () => `/democracy` },
        motion:           { label: 'Council Motions',      pathFor: () => `/council` },
        treasury:         { label: 'Treasury Proposals',   pathFor: () => `/treasury` },
        'public-proposal':{ label: 'Public Proposals',     pathFor: () => `/democracy` },
        block:            { label: 'Blocks',               pathFor: id => `/block/${encodeURIComponent(id)}` }
    };
    let html = `<div class="list-container glass">
        <div class="list-header"><h2>Watchlist ${helpIcon('watchlist', 'About the watchlist')} <span style="color:var(--text-muted);font-weight:400;font-size:0.85rem;">(${items.length} item${items.length === 1 ? '' : 's'})</span></h2>
            <button type="button" id="watchlist-clear-all" class="staking-download-btn" style="padding:6px 14px;font-size:0.78rem;"><i class='bx bx-trash'></i> Clear all</button>
        </div>`;
    for (const [kind, meta] of Object.entries(groups)) {
        const ofKind = items.filter(i => i.kind === kind);
        if (!ofKind.length) continue;
        html += `<div style="padding:14px 20px;border-top:1px solid var(--border-color);">
            <h3 style="font-size:0.85rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;margin:0 0 10px 0;">${stakingEscapeHtml(meta.label)} <span style="color:var(--text-muted);font-weight:400;">(${ofKind.length})</span></h3>
            <div style="display:flex;flex-direction:column;gap:6px;">
                ${ofKind.map(it => `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:6px;">
                    <div style="min-width:0;flex:1;">
                        <a href="${meta.pathFor(it.id)}" class="item-link" style="color:var(--brand-secondary);font-weight:500;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${stakingEscapeHtml(it.label || it.id)}</a>
                        <div style="color:var(--text-muted);font-size:0.72rem;margin-top:2px;">added ${stakingEscapeHtml(formatLocalDateTime(it.addedAt))}</div>
                    </div>
                    ${watchlistStarButton(it.kind, it.id, it.label)}
                </div>`).join('')}
            </div>
        </div>`;
    }
    html += `</div>`;
    container.innerHTML = html;

    const clearBtn = document.getElementById('watchlist-clear-all');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        if (!confirm('Remove every item from your watchlist? This can\'t be undone.')) return;
        setWatchlist({});
        renderWatchlistPage();
    });
}

(function wireWatchlistStars() {
    // Global click delegate so every star icon, regardless of when the
    // page that contains it was rendered, toggles the right entry.
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.watchlist-star') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const kind = btn.getAttribute('data-watch-kind');
        const id = btn.getAttribute('data-watch-id');
        const label = btn.getAttribute('data-watch-label') || id;
        if (!kind || !id) return;
        toggleWatchlist(kind, id, label);
        // Update only this icon in place so we don't blow away surrounding
        // table state (sort/filter/pagination). The new state is read
        // straight from localStorage.
        const filled = isWatched(kind, id);
        const i = btn.querySelector('i');
        if (i) {
            i.classList.toggle('bxs-star', filled);
            i.classList.toggle('bx-star', !filled);
        }
        btn.style.color = filled ? 'var(--brand-primary)' : 'var(--text-muted)';
        btn.title = filled ? 'Remove from watchlist' : 'Add to watchlist';
        btn.setAttribute('aria-label', btn.title);
    });

    // Live-refresh the /watchlist page when the localStorage changes (either
    // via toggles on the same page, or via another tab — the 'storage'
    // event fires across tabs).
    document.addEventListener('watchlist:change', () => {
        if (document.querySelector('.watchlist-page')?.style.display !== 'none') renderWatchlistPage();
    });
    window.addEventListener('storage', (e) => {
        if (e.key === WATCHLIST_STORAGE_KEY) {
            if (document.querySelector('.watchlist-page')?.style.display !== 'none') renderWatchlistPage();
        }
    });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding tour + glossary tooltips
//
// First-visit tour: 5 slides intro'ing the explorer's distinctive features
// (in-line wallet actions, governance with voting, scorecard, watchlist,
// tax export). Auto-shown once per browser, dismissable, re-triggerable
// from the footer link or `?tour=1` in the URL.
//
// Glossary: any element with class `glossary-term` and a `data-term` attr
// gets an underlined dotted style + a popover on hover/focus/click. Terms
// are defined inline in GLOSSARY below; touching new terms is one entry.
// ─────────────────────────────────────────────────────────────────────────────

const TOUR_STORAGE_KEY = 'pdex_tour_seen_v1';

const TOUR_SLIDES = [
    {
        icon: 'bx-grid-alt',
        title: 'Welcome to the Polkadex Explorer',
        body: `<p>This is a full-featured explorer for the Polkadex Mainnet — blocks, transactions, validators, holders, governance, and staking all in one place.</p>
            <p style="margin-top: 10px;">Unlike most chain explorers, you can <strong>act</strong> on what you see here: send PDEX, stake, claim rewards, and vote on governance proposals — all by connecting a wallet extension.</p>`
    },
    {
        icon: 'bx-wallet',
        title: 'Connect your wallet',
        body: `<p>Click <strong>My Account</strong> in the sidebar to connect Polkadot.js, Talisman, SubWallet, or Nova Wallet. The explorer then unlocks signing actions across every page.</p>
            <p style="margin-top: 10px;">Mobile users: open the explorer inside the Nova Wallet or SubWallet in-app browser and the connect flow just works.</p>`
    },
    {
        icon: 'bx-coin-stack',
        title: 'Staking, simplified',
        body: `<p>Visit <strong>Staking Rewards</strong> to view payout history, claim unclaimed rewards, stake more PDEX, or unbond — all from one page.</p>
            <p style="margin-top: 10px;">The new <strong>Validator scorecard</strong> shows APY, commission band, active-era rate, and slash history at a glance so you can pick nominees confidently.</p>`
    },
    {
        icon: 'bx-book-content',
        title: 'Governance you can act on',
        body: `<p><strong>Democracy</strong>, <strong>Council</strong>, and <strong>Treasury</strong> tabs show every proposal, motion, and referendum. Click any proposal number to see its lifecycle, on-chain hash, and resolving blocks.</p>
            <p style="margin-top: 10px;">For ongoing referenda, hit <strong>Aye</strong> or <strong>Nay</strong> right in the table to cast a Standard vote with conviction.</p>`
    },
    {
        icon: 'bx-star',
        title: 'Stay on top of what matters',
        body: `<p>Star any address, validator, or proposal — the <strong>Watchlist</strong> page collects everything you're tracking.</p>
            <p style="margin-top: 10px;">Need year-end staking numbers? The <strong>Tax (year…)</strong> button on your staking-rewards page exports a CSV with USD prices joined at each era close.</p>
            <p style="margin-top: 10px;">Anything underlined like <span class="glossary-term" data-term="era">this</span> opens a quick definition.</p>`
    }
];

let tourCurrentSlide = 0;

function openOnboardingTour() {
    tourCurrentSlide = 0;
    renderTourSlide();
    const modal = document.getElementById('onboarding-tour-modal');
    if (modal) modal.style.display = 'flex';
}
function closeOnboardingTour(markSeen = true) {
    const modal = document.getElementById('onboarding-tour-modal');
    if (modal) modal.style.display = 'none';
    if (markSeen) {
        try { localStorage.setItem(TOUR_STORAGE_KEY, '1'); } catch (_) { /* private mode etc. */ }
    }
}
function renderTourSlide() {
    const slide = TOUR_SLIDES[tourCurrentSlide];
    if (!slide) return;
    const content = document.getElementById('onboarding-tour-content');
    if (content) {
        content.innerHTML = `
            <div style="text-align:center;margin-bottom:16px;">
                <i class='bx ${slide.icon}' style="font-size:42px;color:var(--brand-primary);"></i>
            </div>
            <h2 style="margin:0 0 12px 0;font-size:1.4rem;text-align:center;">${stakingEscapeHtml(slide.title)}</h2>
            <div style="color:var(--text-secondary);font-size:0.92rem;line-height:1.6;">${slide.body}</div>
        `;
    }
    // Dot indicator row.
    const dots = document.getElementById('onboarding-tour-dots');
    if (dots) {
        dots.innerHTML = TOUR_SLIDES.map((_, i) =>
            `<span style="width:8px;height:8px;border-radius:50%;background:${i === tourCurrentSlide ? 'var(--brand-primary)' : 'rgba(255,255,255,0.15)'};transition:background var(--transition-fast);"></span>`
        ).join('');
    }
    const backBtn = document.getElementById('onboarding-tour-back');
    const nextBtn = document.getElementById('onboarding-tour-next');
    if (backBtn) backBtn.style.visibility = tourCurrentSlide === 0 ? 'hidden' : 'visible';
    if (nextBtn) nextBtn.textContent = (tourCurrentSlide === TOUR_SLIDES.length - 1) ? 'Get started' : 'Next →';
}

(function wireOnboardingTour() {
    const closeBtn = document.getElementById('close-onboarding-tour-modal');
    const backBtn = document.getElementById('onboarding-tour-back');
    const nextBtn = document.getElementById('onboarding-tour-next');
    const modal = document.getElementById('onboarding-tour-modal');
    if (closeBtn) closeBtn.addEventListener('click', () => closeOnboardingTour(true));
    if (backBtn) backBtn.addEventListener('click', () => {
        if (tourCurrentSlide > 0) { tourCurrentSlide--; renderTourSlide(); }
    });
    if (nextBtn) nextBtn.addEventListener('click', () => {
        if (tourCurrentSlide < TOUR_SLIDES.length - 1) { tourCurrentSlide++; renderTourSlide(); }
        else closeOnboardingTour(true);
    });
    // Click outside the panel to dismiss. Escape too.
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeOnboardingTour(true); });
    document.addEventListener('keydown', e => {
        if (modal && modal.style.display === 'flex' && e.key === 'Escape') closeOnboardingTour(true);
    });

    // Auto-show on first visit, OR when ?tour=1 is in the URL (anyone can
    // re-trigger the tour by sharing such a link). Defer to after init() so
    // the SPA router has already painted the home page underneath.
    setTimeout(() => {
        const params = new URLSearchParams(window.location.search);
        const forceShow = params.has('tour');
        let seen = false;
        try { seen = localStorage.getItem(TOUR_STORAGE_KEY) === '1'; } catch (_) { seen = false; }
        if (forceShow || !seen) openOnboardingTour();
    }, 800);

    // Expose `?` as a keyboard shortcut to re-open the tour. Skipped when
    // focus is inside an input/textarea so search bars keep working.
    document.addEventListener('keydown', e => {
        if (e.key !== '?' || e.shiftKey === false) return;
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        openOnboardingTour();
    });
    // Footer "Take the tour" link.
    const replayLink = document.getElementById('footer-replay-tour');
    if (replayLink) replayLink.addEventListener('click', e => {
        e.preventDefault();
        openOnboardingTour();
    });
})();

// ─── Glossary ─────────────────────────────────────────────────────────────
// Curated definitions for terms a casual user might encounter on the
// explorer. Keep entries punchy — they're tooltip popovers, not articles.
// Add a new term: insert here, then mark any occurrence in the UI with
//   <span class="glossary-term" data-term="bonded">bonded</span>
const GLOSSARY = {
    era:           'A scheduling unit on Polkadex (~24 hours). Validator rewards are computed and payable per era.',
    validator:     'A node operator that produces blocks and validates the chain. Validators earn rewards in proportion to their stake (own + nominated) and commission.',
    nominator:     'A PDEX holder who delegates their stake to one or more validators to earn rewards without running a node.',
    controller:    'A separate account some stakers used to authorise day-to-day staking calls without exposing the stash. Many Substrate runtimes have removed the controller/stash split.',
    stash:         'The account that holds the bonded balance. With newer Substrate runtimes, the stash is the controller — there is no separate signing key.',
    bonded:        'Funds set aside for staking. Bonded funds back nominations but are unlocked only after an unbonding period.',
    nomination:    'A stake-weighted vote for a validator. Each era the chain picks the highest-stake validators from across all nominations.',
    slash:         'A penalty deducted from a validator (and their nominators) for misbehaviour such as equivocation or extended downtime.',
    referendum:    'A public vote on a runtime change or treasury action. Outcomes are binding once enacted.',
    conviction:    'A multiplier you attach to a referendum vote. Higher conviction = more voting weight, in exchange for a longer post-enactment lock.',
    motion:        'A proposal voted on by the Council collective. If approved, the underlying call is dispatched.',
    council:       'A small body of elected accounts that can fast-track proposals, manage the treasury, and veto runtime changes.',
    treasury:      'An on-chain pot of PDEX funded by transaction fees and slashed stake. Spent on community proposals approved by Council and (sometimes) public referenda.',
    commission:    'The percentage of staking rewards a validator keeps before distributing the remainder to nominators.',
    payout:        'The on-chain claim that distributes accrued era rewards to a validator and its nominators. Anyone can trigger it via `staking.payoutStakers`.',
    extrinsic:     'A signed (or unsigned) transaction that mutates chain state. Calls like transfer, stake, vote, propose are all extrinsics.',
    ss58:          'The encoding scheme Substrate uses for human-readable addresses. Polkadex addresses use SS58 prefix 88 and start with "e".',
    pallet:        'A self-contained module of runtime logic (e.g. `staking`, `democracy`, `treasury`). The chain\'s metadata enumerates them all.',
    proxy:         'A delegated signer that can act on behalf of another account, optionally restricted to a subset of calls (e.g. Staking-only).',
    multisig:      'A deterministic address derived from a set of signers + threshold. Calls execute only after threshold-of-N have approved.'
};

// Wrap a free-floating piece of text in a glossary-term span. Useful when
// building cell content from server data — pass the surrounding sentence and
// the term key, and the function returns the same string with the matching
// word marked up. (Not used in this batch but exposed for future markup.)
function glossarize(text, termKey) {
    return `<span class="glossary-term" data-term="${stakingEscapeHtml(termKey)}">${stakingEscapeHtml(text)}</span>`;
}

function positionGlossaryPopover(targetEl) {
    const pop = document.getElementById('glossary-popover');
    if (!pop || !targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const popWidth = Math.min(320, window.innerWidth - 24);
    // Prefer above; flip below when the trigger is near the top edge.
    let top = rect.top + window.scrollY - pop.offsetHeight - 8;
    if (top < window.scrollY + 8) top = rect.bottom + window.scrollY + 8;
    // Center horizontally around the trigger; clamp to viewport.
    let left = rect.left + window.scrollX + rect.width / 2 - popWidth / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - popWidth - 12 + window.scrollX));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.style.maxWidth = popWidth + 'px';
}

let glossaryPinnedTrigger = null;  // sticky-open when the user clicked the term

(function wireGlossary() {
    const pop = document.getElementById('glossary-popover');
    if (!pop) return;
    const termEl = document.getElementById('glossary-popover-term');
    const bodyEl = document.getElementById('glossary-popover-body');

    function show(target) {
        const term = target.getAttribute('data-term');
        if (!term) return;
        const def = GLOSSARY[term.toLowerCase()];
        if (!def) return;
        if (termEl) termEl.textContent = term;
        if (bodyEl) bodyEl.textContent = def;
        pop.style.display = 'block';
        // Position AFTER display:block so offsetHeight is correct.
        positionGlossaryPopover(target);
    }
    function hide(force = false) {
        if (!force && glossaryPinnedTrigger) return;
        pop.style.display = 'none';
        glossaryPinnedTrigger = null;
    }

    // Hover / focus → show. mouseout/blur → hide unless click-pinned.
    document.addEventListener('mouseover', e => {
        const t = e.target && e.target.closest ? e.target.closest('.glossary-term') : null;
        if (!t || glossaryPinnedTrigger) return;
        show(t);
    });
    document.addEventListener('mouseout', e => {
        const t = e.target && e.target.closest ? e.target.closest('.glossary-term') : null;
        if (!t || glossaryPinnedTrigger) return;
        hide();
    });
    document.addEventListener('focusin', e => {
        const t = e.target && e.target.closest ? e.target.closest('.glossary-term') : null;
        if (t) show(t);
    });
    document.addEventListener('focusout', e => {
        const t = e.target && e.target.closest ? e.target.closest('.glossary-term') : null;
        if (t && !glossaryPinnedTrigger) hide();
    });

    // Click toggles a pinned (sticky) state — useful on mobile / for screen
    // readers, since hover isn't accessible there.
    document.addEventListener('click', e => {
        const t = e.target && e.target.closest ? e.target.closest('.glossary-term') : null;
        if (t) {
            e.preventDefault();
            if (glossaryPinnedTrigger === t) { hide(true); return; }
            glossaryPinnedTrigger = t;
            show(t);
            return;
        }
        // Click outside any pinned term hides the popover.
        if (glossaryPinnedTrigger && !pop.contains(e.target)) hide(true);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && pop.style.display === 'block') hide(true);
    });
    // Re-position on scroll / resize while open.
    const reposition = () => {
        if (pop.style.display !== 'block') return;
        const t = glossaryPinnedTrigger || document.querySelector('.glossary-term:hover, .glossary-term:focus');
        if (t) positionGlossaryPopover(t);
    };
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition);
})();

init();
