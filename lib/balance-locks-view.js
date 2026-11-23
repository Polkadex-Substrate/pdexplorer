// The balance breakdown panel on the wallet dashboard and the account page:
// Total, Transferable, Locked and Reserved, each with a "?", then every locked
// amount as a list row (designer spec cto-team/plans/2026-11-22-locked-balances-redesign.md).
// lib/lock-rows.js decides the rows, their order, chips, lines and actions;
// this file draws them and runs the actions. The model comes from
// GET /api/account/:address/locks (lib/balance-locks-api.js), one call per
// account. Everything printed goes through escapeHtml: lock ids and hold names
// come from the chain. Tested in test/lock-rows.test.js and
// test/balance-locks.test.js.
//
// Every action is one .ui-action button (spec 2.1): 44 px, violet tint and a
// bright violet border, an icon and a verb with its object. A click goes
// through lockActionSpec (lib/lock-actions.js) into the submit the page
// passes in (script.js's submitSignedTx: wallet lookup, fee preflight,
// lib/tx-submit.js watchdog). The panel owns the pressed button: it is never
// `disabled` (focus stays on it) and no button is handed to submit, so
// tx-submit never rewrites its label (spec F5). Remove council vote, Cancel
// vote and Undelegate first ask once inside the row (spec 2.2).
// Dates are UTC days (YYYY-MM-DD); they are estimates from block and era lengths.

import { escapeHtml as esc } from './html-escape.js';
import { formatPlanck } from './tx-status.js';
import { LOCK_HELP_SLUG } from './balance-locks.js';
import { lockActionSpec } from './lock-actions.js';
import { lockDisplay, LOCK_COPY } from './lock-rows.js';
import { icon, chipHtml } from './ui-parts.js';

const pdex = (v) => `${esc(formatPlanck(String(v == null ? '0' : v)) || '0')} PDEX`;

const TIPS = {
    total: 'Everything this account owns: free plus reserved.',
    transferable: 'What you can send now and keep the account open: free balance minus whichever is larger, the locked part (reserved PDEX counts toward it) or the existential deposit.',
    locked: 'PDEX that stays in your free balance but cannot be sent: staking, votes, vesting. Locks overlap; the largest one applies.',
    reserved: 'PDEX set aside as a deposit or hold (identity, proxies, council bond, staking via hold). Not part of free; returned when what it pays for is removed.'
};

function card(label, value, tip, help, accent, key) {
    return `<div class="staking-summary-card"><div class="label">${esc(label)} ${help(LOCK_HELP_SLUG, tip)}</div>`
        + `<div class="value${accent ? ' accent' : ''}" data-lock-figure="${key}">${value}</div></div>`;
}

// A stable id for a row heading (aria-describedby), from its key.
export function headId(key) {
    let h = 5381;
    for (const ch of String(key)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return `lk-${h.toString(36)}`;
}
const chip = (c) => chipHtml(`is-${c.role}`, c.icon, c.word, esc);

function actionHtml(a, hid) {
    if (!a) return '';
    if (!a.kind && !a.open) return `<p class="lock-connect">${icon(a.icon)}<span>${esc(a.text)}</span></p>`;
    const data = a.open ? ` data-lock-open="${esc(a.open)}"` : ` data-lock-action="${esc(a.kind)}"${a.ref != null ? ` data-ref="${esc(a.ref)}"` : ''}${a.confirm ? ` data-confirm="${esc(a.confirm.id)}"` : ''}`;
    return `<button type="button" class="ui-action"${data} data-icon="${esc(a.icon)}" aria-describedby="${hid}">${icon(a.icon)}<span class="ui-action-label">${esc(a.label)}</span></button>`
        + (a.hint ? `<p class="lock-hint">${esc(a.hint)}</p>` : '');
}

function detailsHtml(d, name) {
    if (!d) return '';
    const parts = [];
    if (d.onChain) parts.push(`<p>${esc(d.onChain)}</p>`);
    if (d.text) parts.push(`<p>${esc(d.text)}</p>`);
    if (d.eras) parts.push(`<p>${esc(d.eras)}</p>`);
    for (const line of d.blocks || []) parts.push(`<p>${esc(line)}</p>`);
    if (d.refs && d.refs.length) parts.push(`<p>Referenda: ${d.refs.map(r => `<a href="${esc(r.href)}" class="item-link">${esc(r.text)}</a>`).join(', ')}</p>`);
    if (d.help) parts.push(`<p><a href="${esc(d.help.href)}" class="item-link">${esc(d.help.text)}</a></p>`);
    if (!parts.length) return '';
    return `<details class="validate-disclosure lock-details"><summary>${esc(LOCK_COPY.DETAILS)}<span class="sr-only">${esc(LOCK_COPY.DETAILS_FOR.replace('{name}', name))}</span></summary>${parts.join('')}</details>`;
}

const linkHtml = (l) => (l ? `<a href="${esc(l.href)}" class="item-link lock-link">${esc(l.text)} ${icon('bx-right-arrow-alt')}</a>` : '');

function childHtml(c, parentHid) {
    const hid = headId(c.key);
    const head = c.amount != null && c.name
        ? `<span class="lock-child-head" id="${hid}"><span class="lock-plus" aria-hidden="true">+</span> <span class="sr-only">${esc(LOCK_COPY.ALSO)}</span><span class="lock-amount">${pdex(c.amount)}</span> <span class="lock-name">${esc(c.name)}</span></span>`
        : '';
    return `<li class="lock-child" data-lock-key="${esc(c.key)}">${head}${chip(c.chip)}`
        + (c.line ? `<p class="lock-line">${esc(c.line)}</p>` : '')
        + (c.action ? `<div class="lock-row-action">${actionHtml(c.action, head ? hid : parentHid)}</div>` : '')
        + '</li>';
}

// One row: boxed with its tile in the 'act' group, a compact line in 'rest'.
export function rowHtml(r) {
    const hid = headId(r.key);
    const kids = r.children && r.children.length ? `<ul class="lock-children">${r.children.map(c => childHtml(c, hid)).join('')}</ul>` : '';
    const tile = r.tile ? `<span class="ui-tile is-${esc(r.tile.role)}" aria-hidden="true">${icon(r.tile.icon)}</span>` : '';
    const action = r.action ? `<div class="lock-row-action">${actionHtml(r.action, hid)}</div>` : '';
    return `<li class="lock-row ${r.group === 'act' ? 'is-act' : 'is-rest'}" data-lock-key="${esc(r.key)}">${tile}`
        + '<div class="lock-row-main">'
        + `<div class="lock-row-top"><h4 class="lock-row-head" id="${hid}"><span class="lock-amount">${pdex(r.amount)}</span> <span class="lock-name">${esc(r.name)}</span></h4>${chip(r.chip)}</div>`
        + (r.line ? `<p class="lock-line">${esc(r.line)}</p>` : '')
        + kids + linkHtml(r.link) + detailsHtml(r.details, r.name)
        + '</div>' + action + '</li>';
}

// opts: helpIcon; canSign (the connected wallet is this account), connected (any connected address), isSame,
// page ('wallet' or 'account'), unstake (the action bar's Unstake is enabled), now.
export function renderBalanceLocks(model, { helpIcon, canSign = false, connected = null, isSame, page = 'account', unstake = false, now = Date.now() } = {}) {
    const help = typeof helpIcon === 'function' ? helpIcon : () => '';
    const b = (model && model.balance) || {};
    const display = lockDisplay(model, { canSign, connected, page, unstake, now, ...(isSame ? { isSame } : {}) });
    const notes = display.notes.map(n => `<p class="ui-panel is-${n.panel}${n.panel === 'info' ? ' is-line' : ''} lock-note" data-lock-note="${n.id}">${icon(n.icon)}<span class="ui-panel-body">${esc(n.text)}</span></p>`).join('');
    const summary = display.summary ? `<p class="lock-summary">${chip(display.summary.chip)} <span>${esc(display.summary.text)}</span></p>` : '';
    const groups = display.groups.length
        ? display.groups.map(g => `<div class="lock-group is-${g.id}" data-lock-group="${g.id}"><h3 class="lock-group-head">${esc(g.heading)}</h3>`
            + `<ul class="lock-list is-${g.id}">${g.rows.map(rowHtml).join('')}</ul></div>`).join('')
        : `<p class="lock-empty"><span class="ui-tile is-green is-sm" aria-hidden="true">${icon('bx-check')}</span><span>${esc(LOCK_COPY.E1)}</span></p>`;
    return `<section class="list-container glass balance-locks" aria-labelledby="balance-locks-h">`
        + `<div class="list-header"><h2 id="balance-locks-h" tabindex="-1">Balance breakdown ${help(LOCK_HELP_SLUG, 'Why PDEX is locked and how to unlock it')}</h2></div>`
        + '<div class="staking-summary-grid">'
        + card('Total', pdex(b.total), TIPS.total, help, true, 'total')
        + card('Transferable', pdex(b.transferable), TIPS.transferable, help, false, 'transferable')
        + card('Locked', pdex(b.locked), TIPS.locked, help, false, 'locked')
        + card('Reserved / held', pdex(b.reserved), TIPS.reserved, help, false, 'reserved')
        + '</div>'
        + notes + summary
        + '<div class="lock-actions-msg" role="status" aria-live="polite"></div>'
        + `<div class="lock-groups">${groups}</div>`
        + '</section>';
}

// The confirm strip (spec 2.2): an amber caution inside the row, its sentence, the same action and a keep button.
export function confirmHtml(c, kind, ref, actionIcon, hid) {
    const id = `${hid}-c`;
    return `<div class="ui-panel is-warn lock-confirm" role="group" tabindex="-1" aria-labelledby="${id}">${icon('bx-error')}<div class="ui-panel-body">`
        + `<p id="${id}">${esc(c.text)}</p><div class="lock-confirm-actions">`
        + `<button type="button" class="ui-action" data-lock-action="${esc(kind)}" data-lock-confirmed="1"${ref != null ? ` data-ref="${esc(ref)}"` : ''} data-icon="${esc(actionIcon)}" aria-describedby="${hid}">${icon(actionIcon)}<span class="ui-action-label">${esc(c.label)}</span></button>`
        + `<button type="button" class="validate-text-btn" data-lock-keep="1">${esc(c.keep)}</button></div></div></div>`;
}

// One click: the spec, then submit. The chain check after inclusion (the
// leftover lock) decides what the status line says, not the event alone.
// deps.hold(on) holds every action in the panel from submit until the refresh
// re-renders it, or until the action ends without one (failed, a "waiting"
// card, a failed chain check, or a multisig review that was closed or only
// recorded an approval). No button goes to submit (spec F5): the panel shows
// the pressed one as busy itself.
const ENDS = new Set(['failed', 'cancelled', 'waiting', 'unconfirmed', 'processed', 'confirmed']);
export async function runLockAction(kind, { model, address, msg = null, ref = null, deps = {} } = {}) {
    const say = (text, tone) => { if (msg) { msg.textContent = text; msg.className = `lock-actions-msg${tone ? ' ' + tone : ''}`; } };
    const hold = typeof deps.hold === 'function' ? deps.hold : () => {};
    const connected = typeof deps.connected === 'function' ? deps.connected() : null;
    const spec = lockActionSpec(kind, model, address, { connected, isSame: deps.isSame, ref });
    if (spec.error) { say(spec.error, 'error'); return; }
    say('', '');
    let succeeded = false;
    const release = () => { if (!succeeded) hold(false); };
    const refreshed = () => { if (deps.refresh) deps.refresh(); else hold(false); };
    hold(true);
    try {
        await deps.submit({
            buildTx: spec.buildTx, label: spec.label, action: { key: spec.key, params: spec.params }, verify: spec.verify,
            onStage: (stage) => { if (ENDS.has(stage)) release(); },
            // A multisig wallet: the review (lib/multisig-view.js) reports how it
            // ended. 'executed' goes on through onSuccess, which keeps the hold.
            onMultisigEnd: (outcome, model) => {
                if (outcome === 'executed') return;
                release();
                if (outcome === 'approved') say((model && model.text) || 'Approval submitted; waiting for the other signers.', 'ok');
            },
            onError: (text) => { release(); say(text, 'error'); },
            onSuccess: async () => {
                succeeded = true;
                hold(true);
                if (spec.check) {
                    let r;
                    try { r = await spec.check(deps.api()); } catch (_) { r = { ok: false, text: 'Included, but the locks could not be re-read. Refresh to check.' }; }
                    say(r.text, r.ok ? 'ok' : 'error');
                    if (r.ok) refreshed(); else hold(false);
                    return;
                }
                say('Done. The breakdown refreshes in a moment.', 'ok');
                refreshed();
            }
        });
    } catch (e) { release(); throw e; }
}

// The pressed button busy (spinner, aria-busy and aria-disabled, never disabled, label unchanged); every other
// action held (aria-disabled, the title saying why). off: back to rest, the button's own icon restored.
export function setActionsHeld(el, pressed, on) {
    const all = typeof el.querySelectorAll === 'function' ? Array.from(el.querySelectorAll('.ui-action')) : [];
    for (const b of all) {
        const glyph = b.querySelector ? b.querySelector('i.bx') : null;
        if (on) {
            b.setAttribute('aria-disabled', 'true');
            if (b === pressed) {
                b.setAttribute('aria-busy', 'true');
                if (glyph) glyph.className = 'bx bx-loader-alt bx-spin';
            } else b.setAttribute('title', LOCK_COPY.HELD);
        } else {
            b.removeAttribute('aria-disabled');
            b.removeAttribute('aria-busy');
            if (b.getAttribute('title') === LOCK_COPY.HELD) b.removeAttribute('title');
            if (glyph && b.getAttribute('data-icon')) glyph.className = `bx ${b.getAttribute('data-icon')}`;
        }
    }
}

// The page passes actions = { submit, api, connected, isSame } to enable the
// buttons; without it the panel is read-only. opts.fresh: the re-read after an
// action, ?fresh=1 and no-store, so no CDN or browser copy from before it.
// opts.page ('wallet' or 'account'), opts.unstake() (the action bar's Unstake is enabled) and
// opts.openUnstake() (B9 opens the existing Unstake dialog).
const mounted = new WeakMap();
export async function mountBalanceLocks(el, address, opts = {}) {
    const { fetchJson, helpIcon, actions } = opts;
    if (!el || !address || typeof fetchJson !== 'function') return;
    el.innerHTML = '<div class="balance-locks-empty">Loading the balance breakdown...</div>';
    try {
        const url = `/api/account/${encodeURIComponent(address)}/locks`;
        const model = await (opts.fresh ? fetchJson(`${url}?fresh=1`, { cache: 'no-store' }) : fetchJson(url));
        if (el.isConnected === false) return;
        const who = actions && typeof actions.connected === 'function' ? actions.connected() : null;
        const canSign = !!(who && actions.isSame && actions.isSame(who, address));
        const unstake = typeof opts.unstake === 'function' ? !!opts.unstake() : !!opts.unstake;
        el.innerHTML = renderBalanceLocks(model, { helpIcon, canSign, connected: who, isSame: actions && actions.isSame, page: opts.page || 'account', unstake });
        if (!actions || typeof el.addEventListener !== 'function') return;
        const first = !mounted.has(el);
        mounted.set(el, { ...(mounted.get(el) || {}), model, address, opts, busy: false });
        if (!first) return;
        const st = () => mounted.get(el);
        const restore = (strip) => {
            const row = strip.closest('li');
            const cell = row && row.querySelector('.lock-row-action[hidden]');
            strip.remove();
            if (cell) { cell.hidden = false; const b = cell.querySelector('.ui-action'); if (b) b.focus({ preventScroll: true }); }
        };
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const strip = e.target && typeof e.target.closest === 'function' ? e.target.closest('.lock-confirm') : null;
            if (strip && !st().busy) restore(strip);
        });
        el.addEventListener('click', (e) => {
            const t = e.target && typeof e.target.closest === 'function' ? e.target : null;
            if (!t) return;
            const s = st();
            const keep = t.closest('[data-lock-keep]');
            if (keep) { if (!s.busy) restore(keep.closest('.lock-confirm')); return; }
            const open = t.closest('[data-lock-open]');
            if (open) { if (!s.busy && typeof s.opts.openUnstake === 'function') s.opts.openUnstake(); return; }
            const b = t.closest('[data-lock-action]');
            if (!b || s.busy) return;
            const kind = b.getAttribute('data-lock-action'), ref = b.getAttribute('data-ref');
            // First press of an action that stops a vote: the confirm strip in its row, focus on it.
            if (b.getAttribute('data-confirm') && !b.getAttribute('data-lock-confirmed')) {
                const display = lockDisplay(s.model, { canSign: true });
                const rows = display.groups.flatMap(g => g.rows.flatMap(r => [r, ...(r.children || [])]));
                const a = rows.map(r => r.action).find(x => x && x.kind === kind && String(x.ref == null ? '' : x.ref) === String(ref == null ? '' : ref));
                if (!a || !a.confirm) return;
                const cell = b.closest('.lock-row-action');
                cell.hidden = true;
                cell.insertAdjacentHTML('afterend', confirmHtml(a.confirm, kind, ref, a.icon, b.getAttribute('aria-describedby')));
                const strip = cell.nextElementSibling;
                strip.focus({ preventScroll: true });
                return;
            }
            const msg = el.querySelector('.lock-actions-msg');
            const hold = (on) => { s.busy = on; setActionsHeld(el, b, on); };
            const deps = { ...s.opts.actions, hold, refresh: () => setTimeout(() => mountBalanceLocks(el, s.address, { ...s.opts, fresh: true }), 2500) };
            runLockAction(kind, { model: s.model, address: s.address, msg, ref, deps });
        });
    } catch (_) {
        if (el.isConnected === false) return;
        el.innerHTML = '<div class="balance-locks-empty">Could not load the balance breakdown right now. Refresh to try again.</div>';
    }
}
