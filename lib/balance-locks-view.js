// The balance breakdown panel on the wallet dashboard and the account page:
// Total, Transferable, Locked and Reserved, each with a "?", then one row per
// lock, freeze, hold and deposit saying why and how to release it. The model
// comes from GET /api/account/:address/locks (lib/balance-locks-api.js), one
// call per account. Everything printed goes through escapeHtml: lock ids and
// hold names come from the chain. Tested in test/balance-locks.test.js.
//
// The release buttons (test/lock-actions.test.js): "Ready to withdraw" with
// Withdraw, Remove votes and unlock, Cancel vote, Undelegate, Remove council
// vote, for the connected owner only; Remove leftover staking lock for any
// connected wallet, on both pages. A click goes through lockActionSpec
// (lib/lock-actions.js) into the submit the page passes in (script.js's
// submitSignedTx: wallet lookup, fee preflight, lib/tx-submit.js watchdog).
// Dates are UTC days (YYYY-MM-DD); they are estimates from block and era
// lengths.

import { escapeHtml as esc } from './html-escape.js';
import { formatPlanck } from './tx-status.js';
import { LOCK_HELP_SLUG } from './balance-locks.js';
import { lockActionSpec } from './lock-actions.js';

const pdex = (v) => `${esc(formatPlanck(String(v == null ? '0' : v)) || '0')} PDEX`;
const big = (v) => { try { return BigInt(String(v == null ? '0' : v)); } catch (_) { return 0n; } };
const day = (ms) => (Number.isFinite(Number(ms)) && ms != null ? new Date(Number(ms)).toISOString().slice(0, 10) : null);
const about = (ms) => (day(ms) ? ` (about ${day(ms)})` : '');
const blockNo = (b) => esc(Number(b).toLocaleString('en-US'));
const btn = (action, label, extra = '') => `<button type="button" class="staking-download-btn lock-action-btn" data-lock-action="${action}"${extra}>${esc(label)}</button>`;

const TIPS = {
    total: 'Everything this account owns: free plus reserved.',
    transferable: 'What you can send now and keep the account open: free balance minus whichever is larger, the locked part (reserved PDEX counts toward it) or the existential deposit.',
    locked: 'PDEX that stays in your free balance but cannot be sent: staking, votes, vesting. Locks overlap; the largest one applies.',
    reserved: 'PDEX set aside as a deposit or hold (identity, proxies, council bond, staking via hold). Not part of free; returned when what it pays for is removed.'
};

const BADGE = {
    orphan: 'Leftover lock',
    legacy: 'Legacy lock',
    unknown: 'Not recognised'
};

function card(label, value, tip, help, accent) {
    return `<div class="staking-summary-card"><div class="label">${esc(label)} ${help(LOCK_HELP_SLUG, tip)}</div>`
        + `<div class="value${accent ? ' accent' : ''}">${value}</div></div>`;
}

function democracyControls(d, canSign) {
    if (!d) return '';
    const out = [];
    if (d.mode === 'delegating') {
        const u = d.undelegate || {};
        out.push(`After undelegating, ${pdex(d.lockNow)} stays locked until block ${blockNo(u.lockUntil)}${about(u.lockUntilEta)}; then unlock it here.`);
        if (canSign) out.push(btn('democracy-undelegate', 'Undelegate'));
        return `<div class="lock-actions">${out.join(' ')}</div>`;
    }
    if (d.remove.length || d.unlock) {
        const label = !d.remove.length ? 'Unlock' : d.unlock ? 'Remove votes and unlock' : 'Remove finished votes';
        const what = d.unlock ? `Frees ${pdex(d.freed)} now.` : 'Records the removals; the lock stays until the date below.';
        out.push(canSign ? `${btn('democracy-unlock', label)} ${what}` : what);
    }
    if (d.lockedUntil) out.push(`${pdex(d.lockAfter)} stays locked until block ${blockNo(d.lockedUntil)}${about(d.lockedUntilEta)} (conviction lock).`);
    for (const c of d.cancel || []) {
        out.push(`Referendum #${esc(c.index)} runs until block ${blockNo(c.end)}${about(c.eta)}; its vote stays locked until then.`
            + (canSign ? ` ${btn('democracy-cancel', `Cancel vote #${c.index}`, ` data-ref="${esc(c.index)}"`)}` : ''));
    }
    return out.length ? `<div class="lock-actions">${out.map(x => `<div>${x}</div>`).join('')}</div>` : '';
}

function rowActions(i, actions, canSign) {
    if (i.id === 'staking ' && i.status === 'orphan' && actions.orphan) {
        return `<div class="lock-actions">${btn('migrate-currency', 'Remove leftover staking lock')}`
            + ' <span class="lock-actions-hint">Anyone can submit this; the fee is refunded.</span></div>';
    }
    if (i.id === 'democrac') return democracyControls(actions.democracy, canSign);
    if (i.id === 'phrelect' && actions.elections && canSign) return `<div class="lock-actions">${btn('elections-remove', 'Remove council vote')}</div>`;
    return '';
}

function row(i, actions, canSign) {
    const badge = BADGE[i.status] ? ` <span class="balance-locks-badge balance-locks-${esc(i.status)}">${esc(BADGE[i.status])}</span>` : '';
    const id = i.id ? `<div class="balance-locks-id"><code>${esc(i.id)}</code></div>` : '';
    const refs = Array.isArray(i.refs) && i.refs.length
        ? `<div class="balance-locks-refs">Referenda: ${i.refs.map(r => `<a href="${esc(r.href)}" class="item-link">${esc(r.text)}</a>`).join(', ')}</div>` : '';
    const link = i.link && i.link.href ? ` <a href="${esc(i.link.href)}" class="item-link">${esc(i.link.text || 'More')}</a>` : '';
    return `<tr class="balance-locks-row"><td class="balance-locks-amount">${pdex(i.amount)}</td>`
        + `<td>${esc(i.source)}${badge}${id}</td>`
        + `<td>${esc(i.reason)}${refs}</td>`
        + `<td>${esc(i.unlock)}${link}${rowActions(i, actions, canSign)}</td></tr>`;
}

function withdrawBlock(w, canSign) {
    if (!w) return '';
    const ready = big(w.withdrawable) > 0n;
    const head = ready
        ? `<div class="lock-withdraw-ready"><b>Ready to withdraw: ${pdex(w.withdrawable)}</b>${canSign ? ` ${btn('withdraw', 'Withdraw')}` : ''}`
            + (canSign && w.controllerDiffers ? ` <span class="lock-actions-hint">Signed by the controller account.</span>` : '') + '</div>'
        : '';
    const list = (w.pending || []).length
        ? '<div class="lock-withdraw-pending">Still unbonding: '
            + w.pending.map(c => `${pdex(c.value)} from era ${esc(c.era)}${day(c.eta) ? `, about ${esc(day(c.eta))}` : ''}`).join('; ') + '</div>'
        : '';
    return head || list ? `<div class="lock-withdraw">${head}${list}</div>` : '';
}

export function renderBalanceLocks(model, { helpIcon, canSign = false } = {}) {
    const help = typeof helpIcon === 'function' ? helpIcon : () => '';
    const b = (model && model.balance) || {};
    const items = (model && Array.isArray(model.items)) ? model.items : [];
    const actions = (model && model.actions) || {};
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
            + `<tbody>${items.map(i => row(i, actions, canSign)).join('')}</tbody></table></div>`
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
        + withdrawBlock(actions.withdraw, canSign)
        + '<div class="lock-actions-msg" role="status" aria-live="polite"></div>'
        + table
        + '</div>';
}

// One click: the spec, then submit. The chain check after inclusion (the
// leftover lock) decides what the status line says, not the event alone.
export async function runLockAction(kind, { model, address, button = null, msg = null, ref = null, deps = {} } = {}) {
    const say = (text, tone) => { if (msg) { msg.textContent = text; msg.className = `lock-actions-msg${tone ? ' ' + tone : ''}`; } };
    const connected = typeof deps.connected === 'function' ? deps.connected() : null;
    const spec = lockActionSpec(kind, model, address, { connected, isSame: deps.isSame, ref });
    if (spec.error) { say(spec.error, 'error'); return; }
    say('', '');
    await deps.submit({
        buildTx: spec.buildTx, label: spec.label, action: { key: spec.key, params: spec.params },
        button, idleText: button && button.textContent ? button.textContent : undefined, verify: spec.verify,
        onError: (text) => say(text, 'error'),
        onSuccess: async () => {
            if (spec.check) {
                let r;
                try { r = await spec.check(deps.api()); } catch (_) { r = { ok: false, text: 'Included, but the locks could not be re-read. Refresh to check.' }; }
                say(r.text, r.ok ? 'ok' : 'error');
                if (r.ok && deps.refresh) deps.refresh();
                return;
            }
            say('Done. The breakdown refreshes in a moment.', 'ok');
            if (deps.refresh) deps.refresh();
        }
    });
}

// The page passes actions = { submit, api, connected, isSame } to enable the
// buttons; without it the panel is read-only.
const mounted = new WeakMap();
export async function mountBalanceLocks(el, address, opts = {}) {
    const { fetchJson, helpIcon, actions } = opts;
    if (!el || !address || typeof fetchJson !== 'function') return;
    el.innerHTML = '<div class="balance-locks-empty">Loading the balance breakdown...</div>';
    try {
        const model = await fetchJson(`/api/account/${encodeURIComponent(address)}/locks`);
        if (el.isConnected === false) return;
        const who = actions && typeof actions.connected === 'function' ? actions.connected() : null;
        const canSign = !!(who && actions.isSame && actions.isSame(who, address));
        el.innerHTML = renderBalanceLocks(model, { helpIcon, canSign });
        if (!actions || typeof el.addEventListener !== 'function') return;
        const first = !mounted.has(el);
        mounted.set(el, { model, address, opts });
        if (!first) return;
        el.addEventListener('click', (e) => {
            const b = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-lock-action]') : null;
            const st = mounted.get(el);
            if (!b || !st) return;
            const msg = typeof el.querySelector === 'function' ? el.querySelector('.lock-actions-msg') : null;
            const deps = { ...st.opts.actions, refresh: () => setTimeout(() => mountBalanceLocks(el, st.address, st.opts), 2500) };
            runLockAction(b.getAttribute('data-lock-action'), { model: st.model, address: st.address, button: b, msg, ref: b.getAttribute('data-ref'), deps });
        });
    } catch (_) {
        if (el.isConnected === false) return;
        el.innerHTML = '<div class="balance-locks-empty">Could not load the balance breakdown right now. Refresh to try again.</div>';
    }
}
