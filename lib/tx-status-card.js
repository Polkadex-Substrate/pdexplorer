// The transaction status card: the browser half of lib/tx-status.js.
//
// Replaces every alert() in the signing flows. Non-blocking, bottom-right on
// desktop and full width on narrow screens (styles.css, .tx-card), above the
// governance toasts and modals. One card per submission, updated in place by
// id; at most three are shown and the oldest finished card goes first.
// Success cards close themselves 8 s after Finalized (not while hovered or
// focused); failures, stalls and notices stay until the user closes them.
//
// Browser only (touches document), but holds no chain objects: everything it
// shows comes from buildTxModel, which is pure and tested.

import { escapeHtml } from './html-escape.js';
import { buildTxModel, txCardHtml } from './tx-status.js';

const MAX_CARDS = 3;
const DISMISS_MS = 8000;
const FINISHED = new Set(['finalized', 'failed', 'cancelled', 'stalled', 'notice']);
const cards = new Map();   // id -> { el, model, debug, timer, hold }
let seq = 0;

function zone() {
    let z = document.getElementById('tx-status-zone');
    if (!z) {
        z = document.createElement('div');
        z.id = 'tx-status-zone';
        z.setAttribute('aria-live', 'polite');
        z.setAttribute('aria-relevant', 'additions text');
        document.body.appendChild(z);
    }
    if (!z.dataset.wired) {
        z.dataset.wired = '1';
        z.addEventListener('keydown', (e) => {
            const card = e.key === 'Escape' && e.target.closest && e.target.closest('.tx-card');
            if (card) dismissTxStatus(card.getAttribute('data-tx-id'));
        });
    }
    return z;
}

export function dismissTxStatus(id) {
    const c = cards.get(String(id));
    if (!c) return;
    clearTimeout(c.timer);
    cards.delete(String(id));
    if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
}

function schedule(c) {
    clearTimeout(c.timer);
    if (c.model.stage === 'finalized' && c.model.tone === 'ok' && !c.hold) {
        c.timer = setTimeout(() => dismissTxStatus(c.model.id), DISMISS_MS);
    }
}

function prune() {
    if (cards.size <= MAX_CARDS) return;
    const entries = Array.from(cards.values());
    const victim = entries.find(c => FINISHED.has(c.model.stage)) || entries[0];
    dismissTxStatus(victim.model.id);
}

// action = { id, key, label, params }; see buildTxModel for the rest.
// Returns the model so the caller can act on the decoded outcome.
export function showTxStatus(action, status, events, error, extra = {}) {
    const a = { ...(action || {}) };
    if (!a.id) a.id = 'tx-' + Date.now().toString(36) + '-' + (++seq);
    const m = buildTxModel(a, status, events, error, extra);
    m.id = String(a.id);
    const debug = { id: m.id, key: m.key || a.key || null, stage: m.stage,
        statusType: (status && status.type) || (typeof status === 'string' ? status : null),
        txHash: extra.txHash || null, blockNumber: extra.blockNumber || null, code: m.code,
        events: Array.isArray(events) ? events.map(r => r && r.event ? r.event.section + '.' + r.event.method : '?') : undefined };
    try { console.debug('[tx-status]', debug); } catch (_) { /* logging must never block */ }
    if (typeof document === 'undefined') return m;

    const z = zone();
    let c = cards.get(m.id);
    if (!c) {
        c = { el: document.createElement('div'), model: m, timer: null, hold: false };
        c.el.className = 'tx-card-slot';
        c.el.addEventListener('click', (e) => {
            if (e.target.closest('.tx-card-close')) return dismissTxStatus(c.model.id);
            if (e.target.closest('.tx-card-copy')) {
                const txt = JSON.stringify(c.debug, null, 2);
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {});
                const b = e.target.closest('.tx-card-copy');
                b.textContent = 'Copied';
            }
        });
        const hold = (on) => () => { c.hold = on; schedule(c); };
        c.el.addEventListener('mouseenter', hold(true));
        c.el.addEventListener('mouseleave', hold(false));
        c.el.addEventListener('focusin', hold(true));
        c.el.addEventListener('focusout', hold(false));
        cards.set(m.id, c);
        z.appendChild(c.el);
    }
    c.model = m;
    c.debug = debug;
    c.el.innerHTML = txCardHtml(m, escapeHtml);
    schedule(c);
    prune();
    return m;
}

// A plain message in the same place, for the pre-flight checks that used to
// be alert()s ("Wallet data is not loaded yet." and the like). Stays until
// closed. Returns nothing so `return showTxNotice(...)` reads like the alert
// it replaced.
export function showTxNotice(message) {
    showTxStatus({ id: 'notice-' + Date.now().toString(36) + '-' + (++seq) }, 'notice', null, message);
}
