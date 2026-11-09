// The Treasury page's Spends tab: the approved spends from GET
// /api/treasury/spends in a makeTable, and the one action each allows now
// (lib/treasury-payout.js classifySpend): Pay out (treasury.payout) or Check
// status (treasury.checkStatus), signed by any connected wallet through
// submit (script.js submitSignedTx: fee preflight, status card, watchdog).
//
// At signing the spend and the head are read again and the action must still
// be the one clicked, so a list that went stale (the spend expired, someone
// else paid it) is refused before the wallet is asked. A spend's button is
// held from the click until the list has been read again after the result,
// so the same spend cannot be submitted twice. Success is the card's call:
// lib/tx-status.js reads Paid, PaymentFailed and SpendProcessed for this index.
// Tests: test/treasury-payout.test.js.
import { escapeHtml as esc } from './html-escape.js';
import { sameAccount } from './multisig.js';
import { formatPlanck } from './tx-status.js';
import { classifySpend, formatSpendAmount, blockEta, buildSpendTx, readSpend, spendVerdict, PAYOUT_FEE_TEXT, CHECK_FEE_TEXT } from './treasury-payout.js';
import { SPENDS_ROUTE } from './treasury-payout-api.js';

const CHAIN = { readSpend, build: buildSpendTx };
const short = (a) => { const s = String(a || ''); return s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s; };
const blockText = (n) => Number(n).toLocaleString('en-US');
const big = (x) => (/^\d+$/.test(String(x)) ? BigInt(String(x)) : 0n);
const BADGE = { payable: 'neutral', scheduled: 'neutral', paid: 'claimed', expired: 'unclaimed', unknown: 'neutral' };
const muted = (t) => `<span style="color:var(--text-muted);font-size:0.78rem;">${t}</span>`;

// The makeTable columns. deps: { connected, held: Set of indices, data (the
// API response), fetchedAt (ms), formatTime(ms) }.
export function spendColumns({ connected, held, data, fetchedAt, formatTime }) {
    const eta = (b) => { const ms = blockEta(b, { block: data.block, at: fetchedAt, blockMs: data.blockTimeMs }); return ms == null ? '' : formatTime(ms); };
    const blockCell = (b) => {
        const n = Number(b);
        if (!Number.isFinite(n)) return '-';
        const text = esc(blockText(n));
        const when = eta(n);
        return (n <= Number(data.block) ? `<a href="/block/${esc(String(n))}" class="item-link">${text}</a>` : text) + (when ? `<br>${muted(`~${esc(when)}`)}` : '');
    };
    const state = (row) => classifySpend(row, data.nextBlock, { eta });
    const actionCell = (row) => {
        const c = state(row);
        const note = c.note ? muted(esc(c.note)) : '';
        if (!c.action) return note;
        const off = !connected || held.has(Number(row.index)) ? ' disabled' : '';
        return `<button type="button" class="reward-filter-btn" data-spend-action="${esc(c.action)}" data-spend-index="${esc(String(row.index))}"${off}>${esc(c.actionLabel)}</button>${note ? `<br>${note}` : ''}`;
    };
    return [
        { key: 'index', label: 'Spend', searchable: true, sort: (a, b) => a.index - b.index, format: row => `#${esc(String(row.index))}` },
        { key: 'beneficiary', label: 'Beneficiary', searchable: true, filter: { type: 'text', placeholder: 'Beneficiary…' },
          format: row => `<a href="/account/${esc(encodeURIComponent(String(row.beneficiary)))}" class="item-link" title="${esc(String(row.beneficiary))}" style="color:var(--brand-secondary);">${esc(short(row.beneficiary))}</a>` },
        { key: 'amount', label: 'Amount', sort: (a, b) => { const x = big(a.amount), y = big(b.amount); return x < y ? -1 : x > y ? 1 : 0; },
          format: row => `<strong>${esc(formatSpendAmount(row.amount, data.decimals))}</strong>` },
        { key: 'validFrom', label: 'Valid from', sort: (a, b) => a.validFrom - b.validFrom, format: row => blockCell(row.validFrom) },
        { key: 'expireAt', label: 'Expires', sort: (a, b) => a.expireAt - b.expireAt, format: row => blockCell(row.expireAt) },
        { key: 'status', label: 'Status', format: row => { const c = state(row); return `<span class="reward-badge ${BADGE[c.phase] || 'neutral'}">${esc(c.statusText)}</span>`; } },
        { key: 'action', label: 'Action', format: actionCell }
    ];
}

export function createSpendPayoutUI({ selected, isMultisig, submit, fetchJson, makeTable, formatTime, helpIcon = () => '', chain = CHAIN }) {
    let el = null, data = null, fetchedAt = 0, error = null, generation = 0;
    const held = new Set();
    const table = () => el && el.querySelector('.treasury-spends-table');

    async function load(fresh) {
        const g = ++generation;
        try {
            const d = await fetchJson(SPENDS_ROUTE + (fresh ? '?fresh=1' : ''));
            if (g !== generation) return;
            if (!d || !Array.isArray(d.spends)) throw new Error('Unexpected response.');
            data = d; fetchedAt = Date.now(); error = null;
        } catch (e) { if (g === generation) error = e && e.message ? e.message : String(e); }
    }

    function render() {
        if (!el) return;
        const head = `<p style="color:var(--text-secondary);font-size:0.82rem;margin:0 0 12px;">${esc(PAYOUT_FEE_TEXT)} ${esc(CHECK_FEE_TEXT)} ${helpIcon('treasury', 'Paying out a treasury spend')}</p>`
            + (selected() ? '' : `<p style="color:var(--text-muted);font-size:0.82rem;margin:0 0 12px;">Connect a wallet to pay out or check a spend.</p>`);
        const box = (t) => `<div style="padding:24px;text-align:center;color:var(--text-muted);">${t}</div>`;
        if (error) { el.innerHTML = head + box(`Could not load the spends: ${esc(error)}`); return; }
        if (!data) { el.innerHTML = head + box('Loading the approved spends…'); return; }
        if (!data.spends.length) { el.innerHTML = head + box('No approved spends are waiting for a payout.'); return; }
        const more = data.truncated ? `<p style="color:var(--text-muted);font-size:0.82rem;">Showing the first ${esc(String(data.spends.length))} spends in storage; there may be more.</p>` : '';
        el.innerHTML = head + more + '<div class="treasury-spends-table"></div>';
        makeTable({
            container: table(), rows: data.spends, defaultSort: { key: 'index', dir: 'desc' },
            globalSearch: true, summarySuffix: 'spends', emptyMessage: 'No matching spends.',
            columns: spendColumns({ connected: !!selected(), held, data, fetchedAt, formatTime })
        });
    }

    // Read the list again, then let the spend's button go.
    async function settle(index) { await load(true); held.delete(index); render(); }
    function release(index) { held.delete(index); render(); }

    async function act(index, action, clicked) {
        const address = selected();
        if (!address || held.has(index) || !data || (action !== 'payout' && action !== 'checkStatus')) return;
        const row = data.spends.find(s => s.index === index);
        if (!row) return;
        const c = classifySpend(row, data.nextBlock);
        if (c.action !== action) return;
        held.add(index);
        render();
        const t = table();
        const live = (t && typeof t.querySelector === 'function' && t.querySelector(`[data-spend-index="${index}"][data-spend-action="${action}"]`)) || clicked;
        const decimals = Number(data.decimals) || 12;
        try {
            await submit({
                expectedWallet: address,
                buildTx: async (api) => {
                    const now = await chain.readSpend(api, index);
                    if (!sameAccount(selected(), address)) throw new Error('The wallet changed. Open the action again.');
                    if (!now.spend) throw new Error(`Spend #${index} is no longer on chain: it was already cleared. Refresh the list.`);
                    const s = classifySpend(now.spend, now.next);
                    if (s.action !== action) throw new Error(`Spend #${index} cannot be ${action === 'payout' ? 'paid out' : 'checked'} now: ${s.note || s.statusText}. Refresh the list.`);
                    return chain.build(api, action, index);
                },
                label: action === 'payout' ? `Pay out treasury spend #${index}` : `Check treasury spend #${index}`,
                action: { key: action === 'payout' ? 'treasury.payout' : 'treasury.checkStatus', params: { index, amount: formatPlanck(row.amount, decimals, decimals), beneficiary: row.beneficiary } },
                button: live, idleText: c.actionLabel,
                verify: (api) => chain.readSpend(api, index).then(r => spendVerdict(action, r.spend)),
                onStage: (stage) => { if (stage === 'waiting' || stage === 'processed') settle(index); },
                onError: () => release(index),
                onSuccess: () => { settle(index); }
            });
        } catch (e) { release(index); }
        finally { if (isMultisig(address)) settle(index); }
    }

    function onClick(e) {
        const btn = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-spend-action]') : null;
        if (!btn || btn.disabled) return;
        return act(Number(btn.getAttribute('data-spend-index')), btn.getAttribute('data-spend-action'), btn);
    }

    async function mount(target) {
        if (!target) { el = null; return; }
        if (target !== el) target.addEventListener('click', onClick);
        el = target;
        render();
        await load(false);
        render();
    }

    return { mount, refresh: () => load(true).then(render), accountChanged: render };
}
