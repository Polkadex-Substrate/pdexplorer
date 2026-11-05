// The balance breakdown panel on the wallet dashboard and the account page:
// Total, Transferable, Locked and Reserved, each with a "?", then one row per
// lock, freeze, hold and deposit saying why and how to release it. The model
// comes from GET /api/account/:address/locks (lib/balance-locks-api.js), one
// call per account. Everything printed goes through escapeHtml: lock ids and
// hold names come from the chain. Tested in test/balance-locks.test.js.

import { escapeHtml as esc } from './html-escape.js';
import { formatPlanck } from './tx-status.js';
import { LOCK_HELP_SLUG } from './balance-locks.js';

const pdex = (v) => `${esc(formatPlanck(String(v == null ? '0' : v)) || '0')} PDEX`;
const big = (v) => { try { return BigInt(String(v == null ? '0' : v)); } catch (_) { return 0n; } };

const TIPS = {
    total: 'Everything this account owns: free plus reserved.',
    transferable: 'What you can send now and keep the account open: free balance minus whichever is larger, the locked part (reserved PDEX counts toward it) or the existential deposit.',
    locked: 'PDEX that stays in your free balance but cannot be sent: staking, votes, vesting. Locks overlap; the largest one applies.',
    reserved: 'PDEX set aside as a deposit or hold (identity, proxies, council bond, staking via hold). Not part of free; returned when what it pays for is removed.'
};

const BADGE = {
    orphan: 'Cannot be removed by you today',
    legacy: 'Legacy lock',
    unknown: 'Not recognised'
};

function card(label, value, tip, help, accent) {
    return `<div class="staking-summary-card"><div class="label">${esc(label)} ${help(LOCK_HELP_SLUG, tip)}</div>`
        + `<div class="value${accent ? ' accent' : ''}">${value}</div></div>`;
}

function row(i) {
    const badge = BADGE[i.status] ? ` <span class="balance-locks-badge balance-locks-${esc(i.status)}">${esc(BADGE[i.status])}</span>` : '';
    const id = i.id ? `<div class="balance-locks-id"><code>${esc(i.id)}</code></div>` : '';
    const refs = Array.isArray(i.refs) && i.refs.length
        ? `<div class="balance-locks-refs">Referenda: ${i.refs.map(r => `<a href="${esc(r.href)}" class="item-link">${esc(r.text)}</a>`).join(', ')}</div>` : '';
    const link = i.link && i.link.href ? ` <a href="${esc(i.link.href)}" class="item-link">${esc(i.link.text || 'More')}</a>` : '';
    return `<tr class="balance-locks-row"><td class="balance-locks-amount">${pdex(i.amount)}</td>`
        + `<td>${esc(i.source)}${badge}${id}</td>`
        + `<td>${esc(i.reason)}${refs}</td>`
        + `<td>${esc(i.unlock)}${link}</td></tr>`;
}

export function renderBalanceLocks(model, { helpIcon } = {}) {
    const help = typeof helpIcon === 'function' ? helpIcon : () => '';
    const b = (model && model.balance) || {};
    const items = (model && Array.isArray(model.items)) ? model.items : [];
    const notes = [];
    if (big(b.edWithheld) > 0n) {
        notes.push(`${pdex(b.edWithheld)} of the free balance is the existential deposit (${pdex(b.ed)}), the minimum that keeps the account open. It is not counted as transferable; only sending everything with Keep alive off moves it.`);
    } else if (big(b.ed) > 0n) {
        notes.push(`The existential deposit (${pdex(b.ed)}) is the minimum that keeps an account open; here the locks already cover it.`);
    }
    if (model && model.overlap) {
        notes.push(`Locks overlap; the largest one applies. Locked is ${pdex(b.locked)}, not the sum of the rows below, and releasing a smaller lock frees nothing while a larger one remains.`);
    }
    const table = items.length
        ? `<div class="balance-locks-table-wrap"><table class="data-table balance-locks-table">`
            + '<thead><tr><th class="table-th">Amount</th><th class="table-th">Source</th><th class="table-th">Why</th><th class="table-th">How to unlock</th></tr></thead>'
            + `<tbody>${items.map(row).join('')}</tbody></table></div>`
        : '<div class="balance-locks-empty">Nothing is locked or reserved on this account.</div>';
    return `<div class="list-container glass balance-locks">`
        + `<div class="list-header"><h2>Balance breakdown ${help(LOCK_HELP_SLUG, 'Why PDEX is locked and how to unlock it')}</h2></div>`
        + '<div class="staking-summary-grid">'
        + card('Total', pdex(b.total), TIPS.total, help, true)
        + card('Transferable', pdex(b.transferable), TIPS.transferable, help)
        + card('Locked', pdex(b.locked), TIPS.locked, help)
        + card('Reserved / held', pdex(b.reserved), TIPS.reserved, help)
        + '</div>'
        + notes.map(n => `<p class="balance-locks-note">${n}</p>`).join('')
        + table
        + '</div>';
}

export async function mountBalanceLocks(el, address, { fetchJson, helpIcon } = {}) {
    if (!el || !address || typeof fetchJson !== 'function') return;
    el.innerHTML = '<div class="balance-locks-empty">Loading the balance breakdown...</div>';
    try {
        const model = await fetchJson(`/api/account/${encodeURIComponent(address)}/locks`);
        if (el.isConnected === false) return;
        el.innerHTML = renderBalanceLocks(model, { helpIcon });
    } catch (_) {
        if (el.isConnected === false) return;
        el.innerHTML = '<div class="balance-locks-empty">Could not load the balance breakdown right now. Refresh to try again.</div>';
    }
}
