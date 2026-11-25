// My Account in sections (sprint R3 of design cto-team/plans/2026-11-22-post-action-refresh-design.md, section 6; UX spec
// 2026-11-22-post-action-refresh-ux.md, rules U2 to U5 and section 9). DOM-light: markup builders, and patches that touch
// only the nodes whose data changed.
//
// renderWalletDashboard paints the FRAME once per account and entry (frameHtml): every section has a stable container,
//   wsec-head (the name, #wallet-head-name), wsec-summary (the tiles), wallet-actions-slot (the action bar),
//   wallet-locks-slot, wallet-nominations-slot, wallet-multisig-slot, wallet-validator-slot, wsec-price, wsec-network,
//   wsec-validators, wsec-rewards, wallet-apr-card, wsec-recent-tx, wallet-advanced-section.
// After an action the page is not drawn again: refresh(address) reads /api/wallet once (no snapshot paint, no frame) and
// patches each section from the new copy, and a section whose data did not change is not touched at all. The stake
// figures and the payout part keep their own rules: the copy goes through the stake part (adopt, overlay, paint; a chain
// read newer than the copy keeps its figures) and the payout part (paint). A copy older than the one already drawn (a
// node behind) is not drawn. The locks panel, the multisig and validator cards and the price chart follow on their own.
//
// The name follows the block (UX section 9, identity: SET): an IdentitySet or IdentityCleared for this account records
// the name in the known results (lib/action-effects.js), and it is drawn at once and kept over any server copy that has
// not indexed that block. A replaced block withdraws it, and the server's name comes back.
//
// The proxy list (UX section 9, proxies): a row the block proves removed shows "Removed in block #N" (S5) for T3, then
// leaves, and stays out until the server's chain read has that block. The add-proxy form is never repainted.
//
// The action bar has one delegated listener on the dashboard (bindWalletActions), bound once, so a patched bar never
// binds twice; a closed (disabled) button opens nothing.

import { stakeButtonHtml, stakedTileHtml, myValidatorsHtml } from './stake-refresh.js';
import { LEDGER_UNSETTLED } from './stake-plan.js';
import { caughtUp, samePayload } from './freshness.js';
import { chipHtml } from './ui-parts.js';
import { say, REFRESH_UI } from './refresh-ui.js';

export const IDENTITY_KEY = 'name';
export const proxyKey = (delegate, type, delay) => `${delegate}:${type}:${delay}`;   // one row: the same delegate and type can be set at two delays
const FIELD = /^(INPUT|TEXTAREA|SELECT)$/;
const SEND_CLOSED = 'No transferable balance available.';
const UNSTAKE_CLOSED = 'No active bond to unstake.';
const MUTED = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem;text-align:center;padding:0 20px;';
const json = (v) => { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return String(v); } };

// ── the page does not jump (U3): the first section still on screen keeps its place across a patch ──
function anchorOf(root) {
    if (!root || !root.children) return null;
    for (const el of Array.from(root.children)) {
        let r = null;
        try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
        if (r && r.bottom > 0) return el;
    }
    return null;
}
export function keepScroll(fn, { win = null, root = null } = {}) {
    const anchor = anchorOf(root);
    const top = () => { try { return anchor.getBoundingClientRect().top; } catch (e) { return null; } };
    const before = anchor ? top() : null;
    const out = fn();
    if (before != null && win && typeof win.scrollBy === 'function') {
        const after = top();
        if (after != null && after !== before) win.scrollBy(0, after - before);   // Safari has no overflow-anchor
    }
    return out;
}

// One section's markup. Equal markup: nothing is touched ('same'). A section holding the focused field waits until that
// field loses focus ('deferred', U4, U5). Otherwise only this section is replaced ('replaced').
export function patchSection(el, html, { doc = el && el.ownerDocument, win = doc && doc.defaultView, root = null } = {}) {
    if (!el) return 'none';
    if (doc && typeof doc.createElement === 'function') {
        const probe = doc.createElement('div');
        probe.innerHTML = html;
        if (probe.innerHTML === el.innerHTML) return 'same';
    }
    const active = doc && doc.activeElement;
    if (active && active !== el && typeof el.contains === 'function' && el.contains(active) && FIELD.test(active.tagName || '')) {
        el._wsecPending = html;
        if (!el._wsecWaiting && typeof el.addEventListener === 'function') {
            el._wsecWaiting = true;
            const later = () => Promise.resolve().then(() => {
                const a = doc.activeElement;
                if (a && el.contains(a) && FIELD.test(a.tagName || '')) return;   // still typing in this section
                el.removeEventListener('focusout', later);
                el._wsecWaiting = false;
                const h = el._wsecPending;
                el._wsecPending = undefined;
                if (h !== undefined) patchSection(el, h, { doc, win, root });
            });
            el.addEventListener('focusout', later);
        }
        return 'deferred';
    }
    el._wsecPending = undefined;
    keepScroll(() => { el.innerHTML = html; }, { win, root: root || (doc && typeof doc.getElementById === 'function' ? doc.getElementById('wallet-dashboard') : null) });
    return 'replaced';
}

// ── the action bar ──
const bound = new WeakMap();
export function bindWalletActions(root, handlers) {
    if (!root || typeof root.addEventListener !== 'function') return false;
    const first = !bound.has(root);
    bound.set(root, handlers || {});
    if (!first) return false;
    root.addEventListener('click', (e) => {
        const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('button.wallet-action-btn[id]') : null;
        if (!btn || btn.disabled || !root.contains(btn)) return;
        const h = (bound.get(root) || {})[btn.id];
        if (typeof h === 'function') h(e);
    });
    return true;
}

// The one copy of the action bar. Unstake is closed while the bonded state is unsettled (the stake card's rule).
export function actionBarHtml(data, { esc, stakeable = 0, payoutButton = '' } = {}) {
    const staking = (data && data.staking) || {};
    const unstake = Number(staking.activeStaked || 0) > 0 && staking.ledgerRead !== LEDGER_UNSETTLED;
    const named = !!(data && data.identity && data.identity !== 'Unknown');
    return `<div class="wallet-action-bar" id="wallet-action-bar">
        <button class="wallet-action-btn primary" id="wallet-act-send"${stakeable > 0 ? '' : ` disabled title="${SEND_CLOSED}"`}>
            <i class='bx bx-paper-plane'></i>
            <div><strong>Send PDEX</strong><span>Transfer to any Polkadex address</span></div>
        </button>
        ${stakeButtonHtml(staking, esc)}
        ${payoutButton}
        <button class="wallet-action-btn" id="wallet-act-unstake"${unstake ? '' : ` disabled title="${UNSTAKE_CLOSED}"`}>
            <i class='bx bx-minus-circle'></i>
            <div><strong>Unstake</strong><span>Begin the unbonding period</span></div>
        </button>
        <button class="wallet-action-btn" id="wallet-act-identity">
            <i class='bx bx-id-card'></i>
            <div><strong>${named ? 'Update identity' : 'Set identity'}</strong><span>Display name, email, twitter</span></div>
        </button>
    </div>`;
}

// The bar follows new markup button by button: the nodes stay (focus stays, U4), only the attributes and words that
// differ change. A different set of buttons, or the read-only callout, is swapped whole.
const BAR_ATTRS = ['disabled', 'title', 'aria-disabled', 'aria-describedby'];
export function syncActionBar(slot, html, { doc = slot && slot.ownerDocument, win = null, root = null } = {}) {
    if (!slot || !doc || typeof doc.createElement !== 'function') return 'none';
    const box = doc.createElement('div');
    box.innerHTML = html;
    const want = box.querySelector('#wallet-action-bar');
    const have = slot.querySelector('#wallet-action-bar');
    const shape = (bar) => Array.from(bar.children).map(c => `${c.tagName}#${c.id}`).join(',');
    if (!want || !have || shape(want) !== shape(have)) return patchSection(slot, html, { doc, win, root }) === 'same' ? 'same' : 'replaced';
    let changed = false;
    Array.from(want.children).forEach((w, i) => {
        const h = have.children[i];
        if (w.tagName !== 'BUTTON') {
            if (h.textContent !== w.textContent) { h.textContent = w.textContent; changed = true; }
            return;
        }
        for (const a of BAR_ATTRS) {
            const v = w.getAttribute(a);
            if (v == null) { if (h.hasAttribute(a)) { h.removeAttribute(a); changed = true; } }
            else if (h.getAttribute(a) !== v) { h.setAttribute(a, v); changed = true; }
        }
        const wi = w.querySelector('div'), hi = h.querySelector('div');
        if (wi && hi && wi.innerHTML !== hi.innerHTML) { hi.innerHTML = wi.innerHTML; changed = true; }
    });
    return changed ? 'synced' : 'same';
}

// ── markup of the other sections ──
export function networkHtml(network, { pdex, number, duration }) {
    const n = network || {};
    return `
                    <div class="wallet-stat"><span>Minimum Stake</span><strong>${pdex(n.minStake)} PDEX</strong></div>
                    <div class="wallet-stat"><span>Active Nominators</span><strong>${number(n.activeNominators)} / ${number(n.totalNominators)}</strong></div>
                    <div class="wallet-stat"><span>Active Validators</span><strong>${number(n.activeValidators)} / ${number(n.totalValidators)}</strong></div>
                    <div class="wallet-stat"><span>Staking Period (era)</span><strong>${duration(n.eraDurationMs)}</strong></div>
                    <div class="wallet-stat"><span>Unstaking Period</span><strong>${duration(n.unbondingMs)}</strong></div>
                    <div class="wallet-stat"><span>Current Era</span><strong>${number(n.currentEra)}</strong></div>
                `;
}

// settling: Map of proxyKey -> block for rows proven removed and holding their settle word (S5).
export function proxyListHtml(payload, { isOwn = false, settling = null, esc, short, number, pdex } = {}) {
    const list = Array.isArray(payload && payload.proxies) ? payload.proxies : [];
    if (!list.length) return `<div style="color:var(--text-muted);font-size:0.85rem;padding:8px 0;">No proxies set. ${isOwn ? 'Use the form below to add one.' : ''}</div>`;
    const rows = list.map(p => {
        const block = settling ? settling.get(proxyKey(p.delegate, p.proxyType, p.delay)) : undefined;
        const end = block != null ? chipHtml('is-positive', 'bx-check', say('S5', { n: block }), esc)
            : isOwn ? `<button type="button" class="staking-download-btn proxy-remove-btn" data-delegate="${esc(p.delegate)}" data-proxy-type="${esc(p.proxyType)}" data-delay="${p.delay}" style="padding:4px 10px;font-size:0.72rem;color:var(--error);border-color:rgba(231,76,60,0.4);">Remove</button>` : '';
        return `<tr>
            <td style="padding:8px 4px;"><a href="/account/${encodeURIComponent(p.delegate)}" class="item-link address-cell" style="color:var(--brand-secondary);font-size:0.82rem;">${esc(short(p.delegate))}</a></td>
            <td style="padding:8px 4px;"><code style="font-size:0.78rem;color:var(--text-secondary);">${esc(p.proxyType)}</code></td>
            <td style="padding:8px 4px;text-align:right;font-size:0.78rem;color:var(--text-secondary);">${number(p.delay)} blocks</td>
            <td style="padding:8px 4px;text-align:right;">
                ${end}
            </td>
        </tr>`;
    }).join('');
    return `
            <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:6px;">Deposit reserved: ${pdex(payload.deposit)} PDEX</div>
            <div class="table-responsive"><table class="data-table" style="margin:0;">
                <thead><tr><th>Delegate</th><th>Type</th><th style="text-align:right;">Delay</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;
}

//   doc, win             the page                post, known   the post-action core and the known-results store
//   data()/setData(d)    the payload the page shows       fetchWallet(address) -> Response of /api/wallet
//   refetch(address)     the page's guarded quiet re-read (refreshWalletDashboardFor(address, true))
//   stake, payout        the stake part (adopt, overlay, paint) and the payout part (tileHtml, paint)
//   fmt { pdex, number, esc, short, duration }        multisigName(address)
//   parts { bar(d), gen(), ok(), failed(address, msg), block(), cache(address, payload), nominations(address), rewards(d), tx(d), apr(address) }
export function createWalletSections({ doc, win = null, post = null, known = null, same = (a, b) => a === b, data, setData, fetchWallet = null, refetch = null,
    stake = null, payout = null, fmt, multisigName = () => null, setTimer = null, parts = {} } = {}) {
    const sameAccount = (a, b) => { if (a == null || b == null) return false; try { return a === b || !!same(a, b); } catch (e) { return false; } };
    const call = (f, ...a) => { try { return typeof f === 'function' ? f(...a) : undefined; } catch (e) { return undefined; } };
    let server = null;   // { address, identity }: the name as the server last served it (what a withdrawal goes back to)
    let drawn = null;    // { address, head }: the newest server copy drawn for this account
    const inflight = new Map();
    const settling = new Map();   // `${address}|${delegate}:${type}:${delay}` -> block
    const lastProxies = new WeakMap();
    const watchers = new Map();

    function nameOf(d) {
        if (!d) return null;
        if (d.identity && d.identity !== 'Unknown') return d.identity;
        return call(multisigName, d.address) || null;
    }
    // The name a block proved, while the server copy has not indexed that block (undefined: none).
    function provenName(d) {
        if (!known || typeof known.list !== 'function' || !d || !d.address) return undefined;
        let list = [];
        try { list = known.list('identity', d.address).filter(e => e.op === 'set' && e.key === IDENTITY_KEY); } catch (e) { return undefined; }
        if (!list.length) return undefined;
        const e = list.reduce((a, b) => (b.savedAt > a.savedAt ? b : a));
        if (e.block != null && caughtUp('identity', d.freshness, e.block)) return undefined;
        return e.value == null ? null : String(e.value);
    }
    const headOf = (d) => (d && d.freshness && Number.isFinite(d.freshness.chainHead) ? d.freshness.chainHead : null);
    // A server copy as the page draws it: the proven name over it. Remembers the served name and the copy's head: a
    // frame (the whole dashboard drawn from this copy) sets it, a snapshot frame (live false) is no evidence, a patch raises it.
    function overlay(d, { frame = false, live = true } = {}) {
        if (!d || !d.address) return d;
        server = { address: d.address, identity: d.identity };
        const head = headOf(d);
        if (frame || !drawn || !sameAccount(drawn.address, d.address)) drawn = { address: d.address, head: live ? head : null };
        else if (head != null && (drawn.head == null || head > drawn.head)) drawn.head = head;
        const v = provenName(d);
        return v === undefined ? d : { ...d, identity: v === null ? 'Unknown' : v };
    }

    function frameHtml(data, c = {}) {
        const { pdex, number, esc } = fmt;
        const name = nameOf(data);
        const balance = data.balance || {}, staking = data.staking || {}, rewards = data.rewards || {};
        const history = (c.price && c.price.history) || [];
        const latest = c.latestPrice;
        return `
        <div class="list-container glass" id="wsec-head">
            <div class="list-header">
                <h2><i class='bx bx-wallet'></i> <span id="wallet-head-name">${name ? esc(name) : 'My Account'}</span> ${c.help || ''}</h2>
                <div style="display:flex; gap:14px; align-items:center;">
                    ${c.historyLink || ''}
                    <button id="wallet-switch-btn" class="staking-download-btn"${c.canSwitch ? '' : ' hidden'}>Switch wallet</button>
                    ${c.isOwn ? '<button id="wallet-disconnect-btn" class="staking-download-btn">Disconnect</button>' : ''}
                </div>
            </div>
            <div style="padding: 12px 24px 0;">
                <div id="wallet-viewing-slot" data-address="${esc(data.address)}">${c.viewing || ''}</div>
                <a href="/account/${encodeURIComponent(data.address)}" class="item-link" style="color:var(--text-secondary);font-size:0.78rem;">${esc(data.address)}</a>
            </div>
            <div class="staking-summary-grid" id="wsec-summary">
                <div class="staking-summary-card">
                    <div class="label">Total Balance</div>
                    <div class="value accent" id="wallet-total-value">${pdex(balance.total)} PDEX</div>
                    <div class="value-usd" data-pdex-amount="${balance.total}">${c.usd || ''}</div>
                </div>
                ${stakedTileHtml(data, { pdex, esc })}
                <div class="staking-summary-card"><div class="label">Claimed Rewards</div><div class="value" id="wallet-claimed-value">${pdex(rewards.claimedTotal)} PDEX</div></div>
                ${payout ? payout.tileHtml(data) : ''}
            </div>
        </div>
        ${c.bar != null ? `<div id="wallet-actions-slot">${c.bar}</div>` : ''}
        <div id="wallet-locks-slot"></div>
        <div id="wallet-nominations-slot"></div>

        <div id="wallet-multisig-slot"></div>
        <div id="wallet-validator-slot"></div>

        <div class="wallet-grid">
            <div class="list-container glass" id="wsec-price">
                <div class="list-header"><h2>PDEX Price (30d)</h2><span id="wallet-price-header-price" style="color:var(--brand-secondary);font-size:0.85rem;">${latest ? `$${Number(latest.price).toLocaleString('en-US', { maximumFractionDigits: 4 })}` : ''}</span></div>
                <div class="staking-chart-wrap" id="wallet-price-chart-wrap" style="height:220px;">
                    ${history.length ? '<canvas id="wallet-price-chart"></canvas>' : `<div style="${MUTED}">${c.price && c.price.configured ? 'Collecting price history — the chart fills in as data is polled.' : 'Price feed not configured.'}</div>`}
                </div>
            </div>
            <div class="list-container glass">
                <div class="list-header"><h2>Network staking</h2></div>
                <div class="wallet-stat-list" id="wsec-network">${networkHtml(data.network, fmt)}</div>
            </div>
        </div>

        <div class="wallet-grid">
            <div class="list-container glass" id="wsec-validators">
                <div class="list-header"><h2>My Validators</h2><span id="wallet-my-validators-count" style="color:var(--text-secondary);font-size:0.78rem;">${(staking.nominating || []).length} nominated</span></div>
                <div id="wallet-my-validators" style="padding: 8px 24px 20px;">${myValidatorsHtml(staking.nominating, { esc, short: fmt.short })}</div>
            </div>
            <div class="list-container glass" id="wsec-rewards">
                <div class="list-header"><h2>Recent Staking Rewards</h2><a href="/staking-rewards/${encodeURIComponent(data.address)}" class="item-link is-inline" style="font-size:0.78rem;">View all</a></div>
                <div id="wallet-recent-rewards-table"></div>
            </div>
        </div>

        <div class="list-container glass" id="wallet-apr-card">
            <div class="list-header">
                <h2><i class='bx bx-line-chart' style="vertical-align:middle;color:var(--brand-secondary);"></i> Average APR</h2>
                <div class="reward-filter" id="wallet-apr-periods"></div>
            </div>
            <div id="wallet-apr-body" style="padding:24px;"></div>
        </div>

        <div class="list-container glass" id="wsec-recent-tx">
            <div class="list-header"><h2>Recent Transactions</h2><a href="/account/${encodeURIComponent(data.address)}" class="item-link is-inline" style="font-size:0.78rem;">View all on the account page</a></div>
            <div id="wallet-recent-tx-table"></div>
        </div>
        <div id="wallet-advanced-section"></div>`;
    }

    function wash(el) {
        el.classList.remove('is-value-changed');
        void el.offsetWidth;   // restart the one-shot wash (T5)
        el.classList.add('is-value-changed');
    }
    const byId = (id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
    function paintHead(d) {
        const el = byId('wallet-head-name');
        const text = nameOf(d) || 'My Account';
        if (el && el.textContent !== text) el.textContent = text;
    }
    function paintBar(d, root) {
        const slot = byId('wallet-actions-slot');
        if (!slot || !slot.querySelector('#wallet-action-bar') || typeof parts.bar !== 'function') return;   // the read-only callout is not ours
        syncActionBar(slot, call(parts.bar, d), { doc, win, root });
        call(parts.block);   // a page blocked for stale balances stays blocked
    }
    const validators = (d) => json(((d && d.staking && d.staking.nominating) || []).map(v => (v && v.address) || v));
    const txOf = (d) => json([d.recentTransactions || [], d.recentTransactionsTotal, d.recentTransactionsNext]);
    // Each section from the new copy; a section whose data is unchanged is not touched.
    function patch(prev, next) {
        const root = byId('wallet-dashboard');
        keepScroll(() => {
            paintHead(next);
            if (stake && typeof stake.paint === 'function') call(() => stake.paint(next));
            // A copy that settles the bonded state takes the stake part's mark off, as a freshly drawn tile would; an unsettled one keeps it.
            const mark = byId('wallet-staked-label') && byId('wallet-staked-label').querySelector('.ui-chip');
            if (mark && !(next.staking && next.staking.ledgerRead === LEDGER_UNSETTLED)) mark.remove();
            const claimed = byId('wallet-claimed-value');
            const ct = `${fmt.pdex((next.rewards || {}).claimedTotal)} PDEX`;
            if (claimed && claimed.textContent !== ct) { claimed.textContent = ct; wash(claimed); }
            paintBar(next, root);
            if (payout && json(prev.rewards) !== json(next.rewards)) call(() => payout.paint({ reason: 'poll' }));
            const net = byId('wsec-network');
            if (net) patchSection(net, networkHtml(next.network, fmt), { doc, win, root });
            if (validators(prev) !== validators(next)) call(parts.nominations, next.address);
            if (json((prev.rewards || {}).recentClaimed) !== json((next.rewards || {}).recentClaimed)) call(parts.rewards, next);
            if (txOf(prev) !== txOf(next)) call(parts.tx, next);
            if ((prev.rewards || {}).claimedTotal !== (next.rewards || {}).claimedTotal) call(parts.apr, next.address);
        }, { win, root });
    }

    // One read of /api/wallet for the account on screen; resolves to the copy's freshness (the core polls on it).
    async function run(address) {
        const d0 = data();
        if (!d0 || !sameAccount(d0.address, address) || typeof fetchWallet !== 'function') return null;
        const gen = call(parts.gen);
        const still = () => call(parts.gen) === gen && !!data() && sameAccount(data().address, address);
        let payload;
        try {
            const r = await fetchWallet(address);
            const body = r && typeof r.json === 'function' ? await r.json().catch(() => ({})) : r;
            if ((r && r.ok === false) || !body || body.error) throw new Error((body && body.error) || ('Request failed (' + (r && r.status) + ')'));
            payload = body;
        } catch (e) {
            if (still()) call(parts.failed, address, e && e.message ? e.message : String(e));
            return null;
        }
        if (!still()) return null;   // another account, a navigation or a switch since: nothing of this copy is drawn (U13)
        const f = payload.freshness || null;
        if (older(payload)) return f;   // a node behind the copy drawn: not drawn, so a block (and its banner) stays
        call(parts.ok);
        const prev = data();
        const copy = overlay(payload);
        if (stake && typeof stake.adopt === 'function' && call(() => stake.adopt(copy))) {
            patch(prev, data());
        } else {
            const next = stake && typeof stake.overlay === 'function' ? stake.overlay(copy) : copy;
            if (samePayload(prev, next)) prev.freshness = next.freshness;
            else { setData(next); patch(prev, next); }
        }
        call(parts.cache, address, payload);
        return f;
    }
    // A copy whose chain head is below the one drawn for its account (a node behind): the page keeps what it drew.
    function older(d) {
        const head = headOf(d);
        return head != null && !!drawn && !!d && sameAccount(drawn.address, d.address) && drawn.head != null && head < drawn.head;
    }
    function refresh(address) {
        const k = String(address);
        if (inflight.has(k)) return inflight.get(k);
        const p = run(address).then((f) => f, () => null);
        inflight.set(k, p);
        p.then(() => inflight.delete(k));
        return p;
    }

    // The name and the identity button at once from the store (a block in, a reorg, a failure); a poll also re-reads.
    function repaintIdentity(d) {
        const served = server && sameAccount(server.address, d.address) ? { ...d, identity: server.identity } : d;
        const next = overlay(served);
        if (next.identity === d.identity) return;
        setData(next);
        paintHead(next);
        paintBar(next, byId('wallet-dashboard'));
    }
    // The store changed (a block in, a withdrawal, another tab): the name follows at once, even while a read is in flight.
    if (known && typeof known.onChange === 'function') call(() => known.onChange(() => { const d = data(); if (d && d.address) repaintIdentity(d); }));
    if (post && typeof post.subscribe === 'function') {
        post.subscribe(['identity'], {
            account: () => { const d = data(); return d ? d.address : null; },
            reload: (ctx = {}) => {
                const d = data();
                if (!d || !d.address || ctx.reason === 'account') return null;
                repaintIdentity(d);
                if (!ctx.poll || typeof refetch !== 'function') return null;
                return Promise.resolve(call(refetch, d.address)).then((f) => (f == null ? null : f), () => null);
            }
        });
    }

    // ── the proxy list ──
    const matches = (key, p) => { const [d, type, delay] = String(key).split(':'); return type === String(p.proxyType) && delay === String(p.delay) && sameAccount(d, p.delegate); };
    function paintProxies(el, o) {
        if (!el) return 'none';
        lastProxies.set(el, o);
        const list = Array.isArray(o.payload && o.payload.proxies) ? o.payload.proxies : [];
        let gone = [];
        try { gone = known && typeof known.list === 'function' ? known.list('proxies', o.address).filter(e => e.op === 'remove') : []; } catch (e) { gone = []; }
        gone = gone.filter(e => !(e.block != null && caughtUp('proxies', o.payload && o.payload.freshness, e.block)));   // the server's chain read has it: its list is the truth
        const ctx = o.ctx || {};
        const show = new Map();
        const rows = list.filter(p => {
            if (!gone.some(e => matches(e.key, p))) return true;
            const k = `${o.address}|${proxyKey(p.delegate, p.proxyType, p.delay)}`;
            if (ctx.reason === 'inBlock' && ctx.block != null && !settling.has(k)) {
                settling.set(k, ctx.block);
                if (typeof setTimer === 'function') setTimer(() => { settling.delete(k); const last = lastProxies.get(el); if (last && el.isConnected !== false) paintProxies(el, { ...last, ctx: {} }); }, REFRESH_UI.settleHoldMs);
            }
            if (!settling.has(k)) return false;
            show.set(proxyKey(p.delegate, p.proxyType, p.delay), settling.get(k));
            return true;
        });
        const out = patchSection(el, proxyListHtml({ ...o.payload, proxies: rows }, { isOwn: o.isOwn, settling: show, ...fmt }), { doc, win });
        if (out === 'replaced') call(o.bind, el);
        return out;
    }
    // An error drawn in the list's place: a settle hold that ends later draws nothing over it.
    function forgetProxies(el) { if (el) lastProxies.delete(el); }
    // A component of the page that re-reads itself for one domain while its node is on screen (one per domain).
    function watch(domain, el, address, reload) {
        const key = String(domain);
        call(watchers.get(key));
        if (!post || typeof post.subscribe !== 'function') return () => {};
        const alive = () => { const e = typeof el === 'function' ? el() : el; return !!e && e.isConnected !== false; };
        let off = null;
        const stop = () => { call(off); if (watchers.get(key) === stop) watchers.delete(key); };
        off = post.subscribe([domain], {
            account: () => (alive() ? address : null),
            reload: (ctx = {}) => { if (!alive()) { stop(); return null; } return ctx.reason === 'account' ? null : reload(ctx); }
        });
        watchers.set(key, stop);
        return stop;
    }

    return { overlay, older, name: nameOf, frameHtml, refresh, paintProxies, forgetProxies, watch };
}
