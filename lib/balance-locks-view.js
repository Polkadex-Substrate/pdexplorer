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
import { lockDisplay, LOCK_COPY, diffRows, focusAfterLeave, rowMessage } from './lock-rows.js';
import { icon, chipHtml, setChip, linePanelHtml } from './ui-parts.js';
import { STRINGS, REFRESH_UI } from './refresh-ui.js';

const fill = (t, vars = {}) => String(t).replace(/\{([^{}]+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));

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
// leftover lock) decides what the row says, not the event alone.
// deps.hold(on) holds every action in the panel from submit until the
// re-read repaints it, or until the action ends without one (failed, a
// "waiting" card, a failed chain check, or a multisig review that was closed
// or only recorded an approval). No button goes to submit (spec F5): the panel
// shows the pressed one as busy itself. deps.report(event) tells the panel what
// happened, for the row's message: { type: 'refused' | 'stage' | 'failed' |
// 'multisig' | 'success' | 'checking' | 'check', text, stage, ok }.
// A click on a confirm strip's action this soon after the strip opened is the rest of the gesture that
// opened it (a double click), never a confirmation: it is ignored.
export const CONFIRM_GUARD_MS = 400;
const ENDS = new Set(['failed', 'cancelled', 'waiting', 'unconfirmed', 'processed', 'confirmed']);
export async function runLockAction(kind, { model, address, msg = null, ref = null, deps = {} } = {}) {
    const say = (text, tone) => { if (msg) { msg.textContent = text; msg.className = `lock-actions-msg${tone ? ' ' + tone : ''}`; } };
    const report = (e) => { if (typeof deps.report === 'function') { try { deps.report(e); } catch (_) { /* the panel's, never the action's */ } } };
    const hold = typeof deps.hold === 'function' ? deps.hold : () => {};
    const connected = typeof deps.connected === 'function' ? deps.connected() : null;
    const spec = lockActionSpec(kind, model, address, { connected, isSame: deps.isSame, ref });
    if (spec.error) { say(spec.error, 'error'); report({ type: 'refused', text: spec.error }); return; }
    say('', '');
    let succeeded = false;
    const release = () => { if (!succeeded) hold(false); };
    const refreshed = () => { if (deps.refresh) deps.refresh(); else hold(false); };
    hold(true);
    try {
        await deps.submit({
            buildTx: spec.buildTx, label: spec.label, action: { key: spec.key, params: spec.params }, verify: spec.verify,
            onStage: (stage) => { report({ type: 'stage', stage }); if (ENDS.has(stage)) release(); },
            // A multisig wallet: the review (lib/multisig-view.js) reports how it
            // ended. 'executed' goes on through onSuccess, which keeps the hold.
            onMultisigEnd: (outcome, model) => {
                if (outcome === 'executed') return;
                release();
                if (outcome === 'approved') {
                    const text = (model && model.text) || 'Approval submitted; waiting for the other signers.';
                    say(text, 'ok');
                    report({ type: 'multisig', text });
                }
            },
            // A pre-flight refusal, a wallet that failed before signing (script.js submitSignedTx's fail(),
            // wallet.notSigned) or a declined signature: nothing was sent (M11); anything else failed after sending (M12).
            onError: (text, m) => { release(); say(text, 'error'); report({ type: m && (m.key === 'preflight' || m.key === 'wallet.notSigned' || m.stage === 'cancelled') ? 'refused' : 'failed', text }); },
            onSuccess: async () => {
                succeeded = true;
                hold(true);
                report({ type: 'success' });
                if (spec.check) {
                    report({ type: 'checking' });
                    let r;
                    try { r = await spec.check(deps.api()); } catch (_) { r = { ok: false, text: 'Included, but the locks could not be re-read. Refresh to check.' }; }
                    say(r.text, r.ok ? 'ok' : 'error');
                    report({ type: 'check', ok: !!r.ok, text: r.text });
                    if (r.ok) refreshed(); else hold(false);
                    return;
                }
                refreshed();
            }
        });
    } catch (e) { release(); throw e; }
}

// The pressed button busy (spinner, aria-busy and aria-disabled, never disabled, label unchanged); every other
// action held (aria-disabled, the title saying why). off: back to rest, the button's own icon restored.
// reduced: prefers-reduced-motion, a static clock instead of the spinner (spec 6).
export function setActionsHeld(el, pressed, on, reduced = false) {
    const all = typeof el.querySelectorAll === 'function' ? Array.from(el.querySelectorAll('.ui-action')) : [];
    for (const b of all) {
        const glyph = b.querySelector ? b.querySelector('i.bx') : null;
        if (on) {
            b.setAttribute('aria-disabled', 'true');
            if (b === pressed) {
                b.setAttribute('aria-busy', 'true');
                if (glyph) glyph.className = reduced ? 'bx bx-time-five' : 'bx bx-loader-alt bx-spin';
            } else b.setAttribute('title', LOCK_COPY.HELD);
        } else {
            b.removeAttribute('aria-disabled');
            b.removeAttribute('aria-busy');
            if (b.getAttribute('title') === LOCK_COPY.HELD) b.removeAttribute('title');
            if (glyph && b.getAttribute('data-icon')) glyph.className = `bx ${b.getAttribute('data-icon')}`;
        }
    }
}

// ── the self-updating panel (spec WP2: 4.5, 5 and 6; the R2 core lib/post-action.js) ──
// First load: two static bars, aria-busy, L1 for screen readers only. Every later read keeps the painted
// panel: rows are keyed by data-lock-key and only the rows whose markup changed are replaced, so focus, an
// open Details and a row's message survive. "Updating" shows in the card header only after T1 and stays
// at least T2. After an action the core (subscribed for domain 'locks') re-reads the panel at inclusion and
// polls until the server has caught up; a row the block released holds "Released in block #N" for T3, then
// collapses (T4) and leaves, its children with it, and focus goes to the next row's action. A row message
// stays until the next press on that row or until the row leaves. No fixed timer re-reads the panel.
const H2 = '<div class="list-header"><h2 id="balance-locks-h" tabindex="-1">Balance breakdown</h2></div>';
const SKELETON = `<section class="list-container glass balance-locks" aria-labelledby="balance-locks-h" aria-busy="true">${H2}`
    + `<div class="lock-skeleton" aria-hidden="true"><span></span><span></span></div><p class="sr-only">${esc(LOCK_COPY.L1)}</p></section>`;
const failedHtml = () => `<section class="list-container glass balance-locks" aria-labelledby="balance-locks-h">${H2}`
    + `<div class="lock-failed">${linePanelHtml('is-warn', 'bx-error', esc(LOCK_COPY.X1))}<button type="button" class="validate-secondary lock-retry" data-lock-retry="1">${esc(LOCK_COPY.RETRY)}</button></div></section>`;
const behindHtml = () => `<div class="lock-behind">${linePanelHtml('is-warn', 'bx-error', esc(STRINGS.S11))}<button type="button" class="validate-secondary lock-retry" data-lock-retry="1">${esc(STRINGS.S12)}</button></div>`;
const msgHtml = (m) => `<p class="lock-row-msg lock-msg is-${esc(m.role)}"${m.alert ? ' role="alert"' : ''}>${icon(m.icon)}<span>${esc(m.text)}</span>`
    + (m.reload ? ` <button type="button" class="validate-secondary lock-retry" data-lock-retry="1">${esc(STRINGS.S12)}</button>` : '') + '</p>';

// Per page and address, across slots: the last model painted (a dashboard repaint mounts a new slot; it paints
// this at once instead of a loading line), and each row's message.
const pages = new WeakMap();
const pageOf = (el) => { const d = el.ownerDocument; if (!pages.has(d)) pages.set(d, { models: new Map(), msgs: new Map(), flight: null }); return pages.get(d); };
const lastModelOf = (st) => pageOf(st.el).models;
const msgsOfSt = (st) => { const m = pageOf(st.el).msgs; if (!m.has(st.address)) m.set(st.address, new Map()); return m.get(st.address); };
const mounted = new WeakMap();

function clock(opts) {
    return {
        now: typeof opts.now === 'function' ? opts.now : () => Date.now(),
        set: typeof opts.setTimer === 'function' ? opts.setTimer : (f, ms) => setTimeout(f, ms),
        clear: typeof opts.clearTimer === 'function' ? opts.clearTimer : (t) => clearTimeout(t)
    };
}
function reducedMotion(el, opts) {
    if (typeof opts.reducedMotion === 'function') return !!opts.reducedMotion();
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    try { return !!(w && typeof w.matchMedia === 'function' && w.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
}
function viewOpts(address, opts) {
    const actions = opts.actions;
    const who = actions && typeof actions.connected === 'function' ? actions.connected() : null;
    const canSign = !!(who && actions.isSame && actions.isSame(who, address));
    const unstake = typeof opts.unstake === 'function' ? !!opts.unstake() : !!opts.unstake;
    return { helpIcon: opts.helpIcon, canSign, connected: who, isSame: actions && actions.isSame, page: opts.page || 'account', unstake };
}
function read(address, opts, fresh) {
    const url = `/api/account/${encodeURIComponent(address)}/locks`;
    return fresh ? opts.fetchJson(`${url}?fresh=1`, { cache: 'no-store' }) : opts.fetchJson(url);
}

// The page passes actions = { submit, api, connected, isSame } to enable the buttons; without it the panel
// is read-only. opts.post: the R2 core (subscribe, for domain 'locks'); opts.page ('wallet' or 'account');
// opts.unstake() (the action bar's Unstake is enabled) and opts.openUnstake() (B9 opens the Unstake dialog);
// opts.fresh: read with ?fresh=1 and no-store. opts.now / setTimer / clearTimer / reducedMotion for tests.
export async function mountBalanceLocks(el, address, opts = {}) {
    if (!el || !address || typeof opts.fetchJson !== 'function') return;
    // Not a DOM node (a stub): paint the markup once.
    if (typeof el.querySelector !== 'function') {
        try { el.innerHTML = renderBalanceLocks(await read(address, opts, opts.fresh), viewOpts(address, opts)); }
        catch (_) { if (el.isConnected !== false) el.innerHTML = failedHtml(); }
        return;
    }
    let st = mounted.get(el);
    if (!st || st.address !== address) {
        if (st && st.unsub) st.unsub();
        st = { el, address, opts, model: null, busy: false, pressed: null, pending: null, leaving: new Map(), unsub: null, listening: false,
            updating: { reading: 0, polling: false, timer: null, shownAt: null, hideTimer: null, wasShown: false },
            announce: { at: -Infinity, queued: null, timer: null } };
        mounted.set(el, st);
    }
    st.opts = opts;
    if (!st.listening) listen(el, st);
    if (opts.post && typeof opts.post.subscribe === 'function' && !st.unsub) {
        st.unsub = opts.post.subscribe(['locks'], { account: () => st.address, reload: (ctx) => reload(st, ctx), state: (s) => onState(st, s) });
    }
    if (!el.querySelector('section.balance-locks .staking-summary-grid')) {
        const cached = lastModelOf(st).get(address);
        if (cached) paint(st, cached, {});
        else el.innerHTML = SKELETON;
    }
    await reread(st, { fresh: !!opts.fresh });
}

// One read and repaint. ctx: { fresh, block, reason, origin }. Resolves to the server's freshness (the core polls on it).
async function reread(st, ctx = {}) {
    const el = st.el;
    const content = !!el.querySelector('section.balance-locks .staking-summary-grid');
    if (content) startUpdating(st);
    let model;
    try { model = await read(st.address, st.opts, ctx.fresh); }
    catch (_) {
        if (content) stopUpdating(st);
        if (el.isConnected === false) return null;
        if (content) {
            showBehind(st, true);
            if (st.pending && ctx.block != null) setRowMsg(st, st.pending.key, rowMessage(st.pending.kind, 'reread-failed', {}));
            say(st, fill(STRINGS.A4, { 'Section name': LOCK_COPY.SECTION }));
        } else el.innerHTML = failedHtml();
        return null;
    }
    if (content) stopUpdating(st);
    if (el.isConnected === false) return null;
    lastModelOf(st).set(st.address, model);
    showBehind(st, false);
    paint(st, model, ctx);
    return (model && model.freshness) || null;
}

// The core's reload: a re-read at inclusion (and each poll attempt), after another tab's action, on resume and
// on a wallet change. A detached slot unsubscribes.
function reload(st, ctx = {}) {
    if (st.el.isConnected === false) { if (st.unsub) { st.unsub(); st.unsub = null; } return null; }
    if (ctx.poll) { st.updating.polling = true; }
    if (st.pending && ctx.block != null && ctx.origin !== 'other-tab') st.pending.block = ctx.block;
    return reread(st, { fresh: true, block: ctx.block == null ? null : ctx.block, reason: ctx.reason, origin: ctx.origin });
}
function onState(st, s) {
    if (s === 'updating') { st.updating.polling = true; startUpdating(st); stopUpdating(st); return; }
    st.updating.polling = false;
    st.updating.reading = Math.max(0, st.updating.reading);
    stopUpdating(st, true);
    if (s === 'could-not-refresh') {
        showBehind(st, true);
        say(st, fill(STRINGS.A4, { 'Section name': LOCK_COPY.SECTION }));
    } else if (s === 'current' && st.updating.wasShown) say(st, fill(STRINGS.A1g, { 'Section name': LOCK_COPY.SECTION }));
    st.updating.wasShown = false;
    release(st);
}
function release(st) {
    if (!st.busy || pageOf(st.el).flight || (st.pending && st.pending.checking)) return;
    st.busy = false;
    setActionsHeld(st.el, st.pressed, false);
}
// A submission is in flight from the panel's hold until it ends (an error, an end stage, a multisig end, or
// onSuccess): no re-read, poll end, resume, other tab or account change releases the hold meanwhile, and every
// panel on the page stays held (also a panel mounted for another account). A repaint while held holds the new
// rows again, the pressed action's new node busy.
function holdAgain(st) {
    const el = st.el;
    let pressed = st.busy && st.pressed && el.contains(st.pressed) ? st.pressed : null;
    if (st.busy && !pressed && st.pending && st.pressed) {
        const act = st.pressed.getAttribute('data-lock-action'), ref = st.pressed.getAttribute('data-ref');
        const li = rowEl(el, st.pending.key);
        pressed = li ? Array.from(li.querySelectorAll('.ui-action')).find(x => x.getAttribute('data-lock-action') === act && x.getAttribute('data-ref') === ref) || null : null;
        if (pressed) st.pressed = pressed;
    }
    setActionsHeld(el, pressed, true, reducedMotion(el, st.opts));
}
function endFlight(st, flight) {
    const pg = pageOf(st.el);
    if (pg.flight !== flight) return;
    pg.flight = null;
    for (const card of Array.from(st.el.ownerDocument.querySelectorAll('section.balance-locks'))) {
        const other = mounted.get(card.parentElement);
        if (other && other !== st && !other.busy) setActionsHeld(other.el, null, false);
    }
}

// "Updating" (S1) in the card header: only after T1, then for at least T2 (UX U2: never a loading line over content).
function startUpdating(st) {
    const u = st.updating, c = clock(st.opts);
    u.reading++;
    if (u.hideTimer) { c.clear(u.hideTimer); u.hideTimer = null; }
    if (u.timer || u.shownAt != null) return;
    u.timer = c.set(() => { u.timer = null; if (u.reading > 0 || u.polling) showChip(st, true); }, REFRESH_UI.showDelayMs);
}
function stopUpdating(st, ended = false) {
    const u = st.updating, c = clock(st.opts);
    if (!ended) u.reading = Math.max(0, u.reading - 1);
    if (u.reading > 0 || u.polling) return;
    if (u.timer) { c.clear(u.timer); u.timer = null; }
    if (u.shownAt == null) return;
    const left = u.shownAt + REFRESH_UI.minVisibleMs - c.now();
    if (left <= 0) showChip(st, false);
    else if (!u.hideTimer) u.hideTimer = c.set(() => { u.hideTimer = null; if (!u.reading && !u.polling) showChip(st, false); }, left);
}
function showChip(st, on) {
    const head = st.el.querySelector('section.balance-locks .list-header');
    const u = st.updating;
    const old = head && head.querySelector('.lock-updating');
    if (on) {
        u.shownAt = clock(st.opts).now();
        u.wasShown = true;
        if (head && !old) head.insertAdjacentHTML('beforeend', chipHtml('is-wait lock-updating', 'bx-time-five', STRINGS.S1, esc));
    } else {
        u.shownAt = null;
        if (old) old.remove();
    }
}
function showBehind(st, on) {
    const card = st.el.querySelector('section.balance-locks');
    if (!card) return;
    const old = card.querySelector('.lock-behind');
    if (on && !old) card.querySelector('.list-header').insertAdjacentHTML('afterend', behindHtml());
    if (!on && old) old.remove();
}

// The live region (6): polite, atomic, at most one message per T7; a later one replaces a queued one.
function say(st, text) {
    const a = st.announce, c = clock(st.opts);
    const put = (t) => { const r = st.el.querySelector('.lock-actions-msg'); if (r) r.textContent = t; a.at = c.now(); };
    const wait = a.at + REFRESH_UI.announceGapMs - c.now();
    if (wait <= 0 && !a.timer) { put(text); return; }
    a.queued = text;
    if (!a.timer) a.timer = c.set(() => { a.timer = null; const t = a.queued; a.queued = null; if (t) put(t); }, Math.max(0, wait));
}

const rowEl = (el, key) => Array.from(el.querySelectorAll('li.lock-row')).find(li => li.getAttribute('data-lock-key') === key) || null;
const rowChip = (li) => li && li.querySelector('.lock-row-main > .lock-row-top > .ui-chip');
const actionKeys = (el) => Array.from(el.querySelectorAll('li.lock-row')).filter(li => !li.classList.contains('is-settled') && li.querySelector('.ui-action')).map(li => li.getAttribute('data-lock-key'));
function applyMsg(li, m) {
    const main = li.querySelector('.lock-row-main');
    const old = main && Array.from(main.children).find(x => x.classList.contains('lock-row-msg'));
    if (old) old.remove();
    if (m && main) main.insertAdjacentHTML('beforeend', msgHtml(m));
}
function setRowMsg(st, key, m) {
    const store = msgsOfSt(st);
    if (m) store.set(key, m); else store.delete(key);
    const li = rowEl(st.el, key);
    if (li) applyMsg(li, m);
}

// The keyed repaint. ctx.block with an action of this tab pending: a released row settles.
function paint(st, model, ctx = {}) {
    const el = st.el;
    st.model = model;
    const doc = el.ownerDocument;
    const tpl = doc.createElement('div');
    tpl.innerHTML = renderBalanceLocks(model, viewOpts(st.address, st.opts));
    const next = tpl.querySelector('section.balance-locks');
    next.querySelector('.lock-actions-msg').className = 'lock-actions-msg sr-only';
    next.querySelector('.lock-actions-msg').setAttribute('aria-atomic', 'true');
    const card = el.querySelector('section.balance-locks');
    const store = msgsOfSt(st);
    const ready = card && card.querySelector('.staking-summary-grid');
    if (!ready) {
        el.innerHTML = '';
        el.appendChild(next);
        for (const li of next.querySelectorAll('li.lock-row')) { li._lockHtml = li.outerHTML; const m = store.get(li.getAttribute('data-lock-key')); if (m) applyMsg(li, m); }
        afterPaint(st, model, ctx);
        return;
    }
    const reduced = reducedMotion(el, st.opts);
    // Figures: the value only, with the neutral wash on a change (T5).
    for (const v of next.querySelectorAll('[data-lock-figure]')) {
        const cur = card.querySelector(`[data-lock-figure="${v.getAttribute('data-lock-figure')}"]`);
        if (cur && cur.textContent !== v.textContent) { cur.textContent = v.textContent; wash(st, cur, reduced); }
    }
    // Notes and the summary line: replaced when their words changed.
    const olds = Array.from(card.querySelectorAll('.lock-note')), news = Array.from(next.querySelectorAll('.lock-note'));
    if (olds.map(x => x.outerHTML).join('') !== news.map(x => x.outerHTML).join('')) {
        const anchor = card.querySelector('.lock-summary') || card.querySelector('.lock-actions-msg');
        for (const o of olds) o.remove();
        for (const n of news) anchor.insertAdjacentElement('beforebegin', n);
    }
    const sumNew = next.querySelector('.lock-summary'), sumOld = card.querySelector('.lock-summary');
    if (sumNew && sumOld && sumNew.outerHTML !== sumOld.outerHTML) sumOld.replaceWith(sumNew);
    else if (sumNew && !sumOld) card.querySelector('.lock-actions-msg').insertAdjacentElement('beforebegin', sumNew);
    else if (!sumNew && sumOld) sumOld.remove();
    // Rows, by key.
    const groupsOld = card.querySelector('.lock-groups'), groupsNew = next.querySelector('.lock-groups');
    const oldRows = new Map(Array.from(groupsOld.querySelectorAll('li.lock-row')).filter(li => !li.classList.contains('is-settled')).map(li => [li.getAttribute('data-lock-key'), li]));
    const newKeys = Array.from(groupsNew.querySelectorAll('li.lock-row')).map(li => li.getAttribute('data-lock-key'));
    const diff = diffRows([...oldRows.keys()], newKeys);
    const p = st.pending;
    const settling = !!(p && ctx.block != null && ctx.origin !== 'other-tab');
    const focusKeys = actionKeys(el);
    const focused = doc.activeElement;
    const leaving = [];
    let refocusFrom = null;
    for (const key of diff.leave) {
        const li = oldRows.get(key);
        if (settling && key === p.key && !p.checking) leaving.push(li);
        else if (settling && key === p.key && p.checking) { leaving.push(li); li._waitCheck = true; }
        else { if (li.contains(focused)) refocusFrom = key; store.delete(key); }
    }
    // Each group's list from kept and new nodes.
    for (const li of Array.from(groupsNew.querySelectorAll('li.lock-row'))) {
        const key = li.getAttribute('data-lock-key');
        const old = oldRows.get(key);
        const fresh = li.outerHTML;
        if (old && old._lockHtml === fresh) { li.replaceWith(old); continue; }
        li._lockHtml = fresh;
        const m = store.get(key);
        if (m) applyMsg(li, m);
        if (!old) continue;
        const a = old.querySelector('.lock-amount'), b = li.querySelector('.lock-amount');
        if (a && b && a.textContent !== b.textContent) wash(st, b, reduced);
        const opened = old.querySelector('details[open]');
        if (opened) { const d = li.querySelector('details'); if (d) d.open = true; }
        if (old.contains(focused)) li._focusFrom = focused;
    }
    // A settling row stays where it was until it leaves.
    for (const li of leaving) {
        const g = li.closest('.lock-group'), ul = li.parentElement;
        const gid = g.getAttribute('data-lock-group');
        const prev = li.previousElementSibling;
        let target = groupsNew.querySelector(`.lock-group[data-lock-group="${gid}"] ul.lock-list`);
        if (!target) {
            const gCopy = g.cloneNode(false);
            gCopy.appendChild(g.querySelector('h3').cloneNode(true));
            target = ul.cloneNode(false);
            gCopy.appendChild(target);
            const empty = groupsNew.querySelector('.lock-empty');
            if (empty) empty.remove();
            if (gid === 'act') groupsNew.insertAdjacentElement('afterbegin', gCopy); else groupsNew.appendChild(gCopy);
        }
        const anchor = prev && Array.from(target.children).find(x => x.getAttribute('data-lock-key') === prev.getAttribute('data-lock-key'));
        if (anchor) anchor.insertAdjacentElement('afterend', li); else target.insertAdjacentElement('afterbegin', li);
    }
    groupsOld.replaceWith(groupsNew);
    for (const li of leaving) settle(st, li, li.getAttribute('data-lock-key'), ctx.block, focusKeys, reduced);
    if (refocusFrom) refocus(st, focusKeys, refocusFrom);
    // A replaced row's focused control: the same control in the new row (never body).
    for (const li of groupsNew.querySelectorAll('li.lock-row')) {
        if (!li._focusFrom) continue;
        const f = li._focusFrom;
        delete li._focusFrom;
        const act = f.getAttribute && f.getAttribute('data-lock-action');
        const target = (act && li.querySelector(`[data-lock-action="${act}"]`)) || li.querySelector('.ui-action');
        if (target) target.focus({ preventScroll: true }); else refocus(st, focusKeys, li.getAttribute('data-lock-key'));
    }
    afterPaint(st, model, ctx);
}
function wash(st, node, reduced) {
    if (reduced) return;
    node.classList.add('is-value-changed');
    clock(st.opts).set(() => node.classList.remove('is-value-changed'), REFRESH_UI.highlightMs);
}

// After the repaint: this tab's action's own message (M2 to M5) in its row, and the hold released when the
// read caught up with the block (or when there is no block to wait for).
function afterPaint(st, model, ctx) {
    if (st.busy || pageOf(st.el).flight) holdAgain(st);
    const p = st.pending;
    if (p && ctx.block != null && ctx.origin !== 'other-tab' && !p.said) {
        const li = rowEl(st.el, p.key);
        if (li && !li.classList.contains('is-settled')) {
            const row = lockDisplay(model, { canSign: true }).groups.flatMap(g => g.rows).find(r => r.key === p.key) || null;
            const m = rowMessage(p.kind, 'done', { block: ctx.block, ref: p.ref, row, unlock: p.unlock });
            if (m) { setRowMsg(st, p.key, m); p.said = true; }
        }
    }
    const f = model && model.freshness;
    const caught = ctx.block == null || !!(f && Number.isFinite(f.chainHead) && f.chainHead >= Number(ctx.block));
    if (caught && !st.updating.polling) release(st);
}

// A row this tab's action released: S8 for T3, then it collapses over T4 and leaves, focus to the next action.
// A leftover-lock row waits for its chain check (Checking) before it settles.
function settle(st, li, key, block, focusKeys, reduced) {
    const c = clock(st.opts);
    if (li._waitCheck) { li._settleArgs = [block, focusKeys, reduced]; return; }
    li.classList.add('is-settled');
    li._lockHtml = null;
    for (const a of Array.from(li.querySelectorAll('.lock-row-action, .lock-confirm'))) a.remove();
    const chip = rowChip(li);
    if (chip) { chip.classList.remove('is-bare'); setChip(chip, 'is-positive', 'bx-check', fill(STRINGS.S8, { n: block })); }
    const p = st.pending;
    applyMsg(li, p && p.checkText ? rowMessage(p.kind, 'check-ok', { text: p.checkText }) : null);
    const name = li.querySelector('.lock-name'), amount = li.querySelector('.lock-amount');
    say(st, fill(LOCK_COPY.RELEASED, { name: name ? name.textContent : '', amount: amount ? amount.textContent.replace(/ PDEX$/, '') : '', n: block }));
    st.leaving.set(key, li);
    if (p && p.key === key) st.pending = null;
    const gone = () => {
        const d = li.ownerDocument;
        const hadFocus = li.contains(d.activeElement) || d.activeElement === d.body || !d.activeElement;
        const g = li.closest('.lock-group');
        li.remove();
        st.leaving.delete(key);
        msgsOfSt(st).delete(key);
        if (g && !g.querySelector('li.lock-row')) g.remove();
        const groups = st.el.querySelector('.lock-groups');
        if (groups && !groups.querySelector('li.lock-row') && !groups.querySelector('.lock-empty')) groups.insertAdjacentHTML('beforeend', `<p class="lock-empty"><span class="ui-tile is-green is-sm" aria-hidden="true">${icon('bx-check')}</span><span>${esc(LOCK_COPY.E1)}</span></p>`);
        if (hadFocus) refocus(st, focusKeys, key);
    };
    c.set(() => {
        if (reduced) { gone(); return; }
        li.classList.add('is-leaving');
        c.set(gone, REFRESH_UI.collapseMs);
    }, REFRESH_UI.settleHoldMs);
}
function refocus(st, keys, leftKey) {
    let k = focusAfterLeave(keys, leftKey);
    let li = k ? rowEl(st.el, k) : null;
    if (!li && k) {
        // The neighbour left as well: the next one still on screen.
        const rest = keys.filter(x => x === leftKey || rowEl(st.el, x));
        k = focusAfterLeave(rest, leftKey);
        li = k ? rowEl(st.el, k) : null;
    }
    const target = (li && li.querySelector('.ui-action')) || st.el.querySelector('#balance-locks-h');
    if (target) target.focus({ preventScroll: true });
}

function listen(el, st) {
    st.listening = true;
    const restore = (strip) => {
        const row = strip.closest('li');
        const cell = row && row.querySelector('.lock-row-action[hidden]');
        strip.remove();
        if (cell) { cell.hidden = false; const b = cell.querySelector('.ui-action'); if (b) b.focus({ preventScroll: true }); }
    };
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const strip = e.target && typeof e.target.closest === 'function' ? e.target.closest('.lock-confirm') : null;
        if (strip && !st.busy) restore(strip);
    });
    el.addEventListener('click', (e) => {
        const t = e.target && typeof e.target.closest === 'function' ? e.target : null;
        if (!t) return;
        if (t.closest('[data-lock-retry]')) { reread(st, { fresh: true }); return; }
        const actions = st.opts.actions;
        if (!actions) return;
        const keep = t.closest('[data-lock-keep]');
        if (keep) { if (!st.busy) restore(keep.closest('.lock-confirm')); return; }
        const open = t.closest('[data-lock-open]');
        const held = st.busy || !!pageOf(el).flight;
        if (open) { if (!held && typeof st.opts.openUnstake === 'function') st.opts.openUnstake(); return; }
        const b = t.closest('[data-lock-action]');
        if (!b || held || !st.model) return;
        const kind = b.getAttribute('data-lock-action'), ref = b.getAttribute('data-ref');
        const li = b.closest('li.lock-row');
        const key = li ? li.getAttribute('data-lock-key') : null;
        // The rest of the gesture that opened the strip (a double click) is not a confirmation.
        const strip = b.getAttribute('data-lock-confirmed') ? b.closest('.lock-confirm') : null;
        if (strip && strip._openedAt != null && clock(st.opts).now() - strip._openedAt < CONFIRM_GUARD_MS) return;
        // A new press on this row clears its message.
        if (key) setRowMsg(st, key, null);
        // First press of an action that stops a vote: the confirm strip in its row, focus on it; once only
        // (a second click while the strip is open does nothing more).
        const opener = b.getAttribute('data-confirm') && !b.getAttribute('data-lock-confirmed');
        const cell = opener ? b.closest('.lock-row-action') : null;
        if (cell && cell.nextElementSibling && cell.nextElementSibling.classList.contains('lock-confirm')) return;
        if (opener) {
            const rows = lockDisplay(st.model, { canSign: true }).groups.flatMap(g => g.rows.flatMap(r => [r, ...(r.children || [])]));
            const a = rows.map(r => r.action).find(x => x && x.kind === kind && String(x.ref == null ? '' : x.ref) === String(ref == null ? '' : ref));
            if (!a || !a.confirm) return;
            cell.hidden = true;
            cell.insertAdjacentHTML('afterend', confirmHtml(a.confirm, kind, ref, a.icon, b.getAttribute('aria-describedby')));
            cell.nextElementSibling._openedAt = clock(st.opts).now();
            cell.nextElementSibling.focus({ preventScroll: true });
            return;
        }
        const reduced = reducedMotion(el, st.opts);
        const d = st.model.actions && st.model.actions.democracy;
        st.pending = { key, kind, ref, unlock: kind === 'democracy-unlock' ? !!(d && d.unlock) : null, block: null, checking: false, said: false };
        st.pressed = b;
        const pending = st.pending;
        const flight = { st };
        let started = false;
        // Only the panel still mounted for this account is drawn; a panel mounted since (another account) is
        // held by the flight and let go when it ends.
        const current = () => mounted.get(el) === st;
        const hold = (on) => {
            if (on) {
                if (!started) { started = true; pageOf(el).flight = flight; }
                st.busy = true;
                if (current()) setActionsHeld(el, st.pressed, true, reduced);
            } else {
                const was = st.busy;
                st.busy = false;
                endFlight(st, flight);
                if (was && current()) setActionsHeld(el, st.pressed, false);
            }
        };
        const report = (ev) => {
            if (ev.type === 'success') endFlight(st, flight);
            if (ev.type === 'refused') { setRowMsg(st, key, rowMessage(kind, 'refused', { text: ev.text })); st.pending = null; }
            else if (ev.type === 'failed') { setRowMsg(st, key, rowMessage(kind, 'failed', { text: ev.text })); st.pending = null; }
            else if (ev.type === 'stage' && (ev.stage === 'unconfirmed' || ev.stage === 'waiting')) setRowMsg(st, key, rowMessage(kind, ev.stage, {}));
            else if (ev.type === 'multisig') { setRowMsg(st, key, rowMessage(kind, 'multisig', { text: ev.text })); st.pending = null; }
            else if (ev.type === 'checking') {
                pending.checking = true;
                const chip = rowChip(rowEl(el, key));
                if (chip) { chip.classList.add('is-bare'); setChip(chip, 'is-wait', 'bx-time-five', STRINGS.S2); }
            } else if (ev.type === 'check') {
                pending.checking = false;
                const row = rowEl(el, key);
                if (ev.ok) {
                    pending.checkText = ev.text;
                    if (row && row._waitCheck) { delete row._waitCheck; settle(st, row, key, ...(row._settleArgs || [pending.block, actionKeys(el), reduced])); }
                    else if (row && pending.block != null && !row.classList.contains('is-settled')) settle(st, row, key, pending.block, actionKeys(el), reduced);
                    else if (row) applyMsg(row, rowMessage(kind, 'check-ok', { text: ev.text }));
                } else {
                    if (row) { row._lockHtml = null; delete row._waitCheck; }
                    setRowMsg(st, key, rowMessage(kind, 'check-bad', { text: ev.text }));
                    st.pending = null;
                    reread(st, { fresh: true });
                }
            }
        };
        // No core: one fresh read at once after inclusion. With the core, its reload re-reads (no fixed timer).
        const refresh = () => { if (!(st.opts.post && typeof st.opts.post.subscribe === 'function')) reread(st, { fresh: true, block: null }); };
        runLockAction(kind, { model: st.model, address: st.address, msg: null, ref, deps: { ...actions, hold, report, refresh } });
    });
}
