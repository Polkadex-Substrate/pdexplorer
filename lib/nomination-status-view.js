// "Your validators": the nominator panel on the wallet dashboard and the
// account page. One row per nominated validator with its status this era,
// and the banners from lib/nomination-status.js. "Change validators" (owner
// only) opens the staking validator picker through openPicker(keep), with
// the validators to keep prefilled and the problem ones removed. The model
// comes from GET /api/account/:address/staking-status, one call per account.
// Names come from the chain: everything printed goes through escapeHtml.
// Tested in test/nomination-status.test.js.

import { escapeHtml as esc } from './html-escape.js';

const HELP = '/help/staking-status';
const FLAG_TEXT = {
    leaving: 'Leaving', blocked: 'Blocked', commission100: '100% commission', offline: 'Offline', 'not-seen-yet': 'No heartbeat yet',
    disabled: 'Disabled', 'reported-offline': 'Reported offline', 'reported-offline-earlier': 'Reported offline earlier', slashed: 'Slashed recently'
};
const WARN = new Set(['leaving', 'commission100', 'offline', 'disabled', 'reported-offline', 'slashed']);
const short = (a) => { const s = String(a || ''); return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s; };

export function renderNominationStatus(model, { helpIcon, canChange = false } = {}) {
    if (!model || !model.nominating) return '';
    const help = typeof helpIcon === 'function' ? helpIcon : () => '';
    const banners = (model.banners || []).map(b => `<div class="nom-banner nom-banner-${esc(b.kind)}" role="status">`
        + `<b>${esc(b.title)}</b> <span>${esc(b.text)}</span>`
        + (canChange && b.action === 'change' ? ` <button type="button" class="staking-download-btn" data-nom-action="change" data-banner="${esc(b.kind)}">Change validators</button>` : '')
        + '</div>').join('');
    const rows = (model.targets || []).map(t => {
        const badges = (t.flags || []).filter(f => FLAG_TEXT[f]).map(f => `<span class="balance-locks-badge ${WARN.has(f) ? 'balance-locks-orphan' : 'balance-locks-unknown'}">${esc(FLAG_TEXT[f])}</span>`).join(' ');
        return `<tr><td><a href="/validator/${encodeURIComponent(t.address)}" class="item-link">${esc(t.name || short(t.address))}</a></td>`
            + `<td>${esc(t.label)} ${badges}</td><td>${(t.notes || []).map(esc).join(' ')}</td></tr>`;
    }).join('');
    const note = model.offline && model.offline.source === 'none' ? `<p class="balance-locks-note">${esc(model.offline.note)}</p>` : '';
    return '<div class="list-container glass nom-status">'
        + `<div class="list-header"><h2>Your validators ${help('staking-status', 'Is my stake earning? What each status means')}</h2>`
        + `<a href="${HELP}" class="item-link">What the statuses mean</a></div>`
        + banners + note
        + '<div class="balance-locks-table-wrap"><table class="data-table balance-locks-table">'
        + '<thead><tr><th class="table-th">Validator</th><th class="table-th">Status this era</th><th class="table-th">Notes</th></tr></thead>'
        + `<tbody>${rows}</tbody></table></div></div>`;
}

const mounted = new WeakMap();
export async function mountNominationStatus(el, address, opts = {}) {
    const { fetchJson, helpIcon, canChange, openPicker } = opts;
    if (!el || !address || typeof fetchJson !== 'function') return;
    try {
        const model = await fetchJson(`/api/account/${encodeURIComponent(address)}/staking-status`);
        if (el.isConnected === false) return;
        const can = typeof canChange === 'function' && !!canChange() && typeof openPicker === 'function';
        el.innerHTML = renderNominationStatus(model, { helpIcon, canChange: can });
        const first = !mounted.has(el);
        mounted.set(el, model);
        if (!first || typeof el.addEventListener !== 'function' || typeof openPicker !== 'function') return;
        el.addEventListener('click', (e) => {
            const b = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-nom-action]') : null;
            if (!b || b.getAttribute('data-nom-action') !== 'change') return;
            const m = mounted.get(el);
            const banner = m && (m.banners || []).find(x => x.kind === b.getAttribute('data-banner'));
            if (banner) openPicker(banner.keep.slice());
        });
    } catch (_) {
        // The locks panel already explains the stake; an empty slot is enough.
        if (el.isConnected !== false) el.innerHTML = '';
    }
}
