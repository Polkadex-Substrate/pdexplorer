// One close control for every inner page and dialog.
//
// CEO request: "extend the close button in all the newly created inner pages,
// especially the governance pages, wallet connect etc." The explorer already had
// X buttons on the older detail pages (account, block, transaction, validator)
// and on the static dialogs, each written out by hand. The newer pages
// (governance items, discussion threads, the wallet picker, help, email
// preferences) had none, so a user who arrived by a shared link had nothing to
// press but the browser's back button, which on a fresh tab leaves the site.
//
// Behaviour, in one place:
//
//   Pages     close to history.back() when THIS tab's SPA pushed an entry (the
//             caller's depth counter; document.referrer is not proof, see audit
//             F-129), otherwise to the page's parent route, so a deep link never
//             dead-ends. referendum -> Democracy, motion -> Council, thread ->
//             Discussions, wallet switch -> previous page or Home.
//   Dialogs   close; Escape does the same by pressing the dialog's own close
//             control, so its teardown (clearing errors, fee state, chain
//             subscriptions) always runs; focus goes back to the opener.
//   Guard     unsent text is never discarded silently: closing asks first and
//             declining keeps the page or dialog. A transaction already in
//             flight (a busy submit button) is the exception: its text was
//             sent, closing only hides the dialog, nothing is cancelled and the
//             tx-status card (lib/tx-status-card.js) keeps tracking it.
//
// Pure apart from the elements it is handed, so tests/close-control.test.js
// drives it with a tiny fake DOM. Imported by script.js, which is capped at
// 15,000 lines, and by lib/gov-detail-view.js.

import { escapeHtml } from './html-escape.js';

// The control a dialog is closed through. data-modal-close is the explicit
// opt-in; the class and label cover the older hand-written buttons.
const DIALOG_CLOSE = '[data-modal-close], .modal-close-btn, [aria-label="Close"], [aria-label^="Close "]';
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden', 'range', 'file', 'color']);

export const DISCARD_MESSAGE = 'Close without sending? What you typed here will be discarded.';

// Where a governance item page closes to.
export function govParentRoute(kind) {
    if (kind === 'referendum' || kind === 'proposal' || kind === 'external') return 'democracy';
    if (kind === 'motion') return 'council';   // council and Technical Committee motions both list on /council
    return 'home';
}

// The shared button. Pages pass `parent` (the SPA route without a leading
// slash); dialogs pass dialog:true. Same X icon as the existing buttons.
export function closeControlHtml({ parent, dialog = false, label = 'Close', cls = '' } = {}) {
    const attr = dialog ? 'data-modal-close' : `data-close-detail="${escapeHtml(parent || 'home')}"`;
    const klass = ['close-control', dialog ? 'close-control--dialog' : '', cls].filter(Boolean).join(' ');
    return `<button type="button" class="${escapeHtml(klass)}" ${attr} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class='bx bx-x' aria-hidden="true"></i></button>`;
}

// What a page close should do. depth = how many entries this tab's SPA pushed.
export function resolveClose(depth, parent) {
    const d = Math.max(0, Math.floor(Number(depth) || 0));
    if (d > 0) return { action: 'back', depth: d - 1 };
    return { action: 'navigate', to: parent || 'home', depth: 0 };
}

// Do it. Returns the new depth for the caller to keep.
export function closeToParent({ depth, parent, back, navigate }) {
    const r = resolveClose(depth, parent);
    if (r.action === 'back') back(); else navigate(r.to);
    return r.depth;
}

// May this close go ahead? confirmFn(message) -> boolean is the browser's confirm().
export function decideClose({ dirty, pending, confirmFn, message = DISCARD_MESSAGE }) {
    if (pending) return { close: true, reason: 'pending' };
    if (!dirty) return { close: true, reason: 'clean' };
    return confirmFn(message) ? { close: true, reason: 'confirmed' } : { close: false, reason: 'kept' };
}

function textFields(root) {
    return Array.from(root.querySelectorAll('textarea, input')).filter(el => !NOT_TEXT.has(String(el.type || '').toLowerCase()));
}

// Unsent text: a field the user typed in (the input listener marks it, so a
// value the page filled in itself never counts), still holding something.
export function isDirty(root) {
    if (!root) return false;
    return textFields(root).some(el => el.dataset && el.dataset.draft === '1' && !el.readOnly && !el.disabled && String(el.value || '').trim() !== '');
}

// A signing step in flight: tx-submit marks the submit button aria-busy.
export function isPending(root) {
    return !!root && !!root.querySelector('[aria-busy="true"]');
}

export function clearDrafts(root) {
    if (!root) return;
    textFields(root).forEach(el => { if (el.dataset) delete el.dataset.draft; });
}

// Escape: press the dialog's own close control (it carries the teardown, and
// the guard sees the click), else hide it as a last resort.
export function closeDialogElement(modal) {
    if (!modal) return;
    const btn = modal.querySelector(DIALOG_CLOSE);
    if (btn) { btn.click(); return; }
    modal.style.display = 'none';
}

export function onDialogKeydown(e, modal) {
    if (!e || e.key !== 'Escape' || !modal) return false;
    e.preventDefault();
    closeDialogElement(modal);
    return true;
}

// Who had focus before a dialog opened, so it can be handed back on close.
export function createFocusReturn(doc) {
    let saved = null;
    return {
        remember(el) { if (el) saved = el; },
        restore() {
            const el = saved;
            saved = null;
            if (!el || !doc.contains(el)) return false;   // re-rendered away while the dialog was open
            try { el.focus(); } catch (_) { return false; }
            return true;
        }
    };
}

// Delegated wiring, once per document: page controls, dialog X buttons and
// the backdrop, all behind the discard guard. Capture phase, so a blocked
// close stops before the dialog's own handler hides anything.
export function wireCloseControls(doc, { getDepth, setDepth, back, navigate, confirmFn }) {
    doc.addEventListener('input', (e) => {
        const t = e.target;
        if (t && t.dataset && textFieldTag(t)) t.dataset.draft = '1';
    }, true);

    doc.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;

        const page = t.closest('[data-close-detail]');
        if (page) {
            e.preventDefault();
            e.stopPropagation();
            const scope = page.closest('.page-section') || page.closest('.modal') || page.parent || null;
            const v = decideClose({ dirty: isDirty(scope), pending: isPending(scope), confirmFn });
            if (!v.close) return;
            clearDrafts(scope);
            setDepth(closeToParent({ depth: getDepth(), parent: page.getAttribute('data-close-detail'), back, navigate }));
            return;
        }

        const modal = t.closest('.modal');
        if (!modal) return;
        if (t !== modal && !t.closest(DIALOG_CLOSE)) return;
        const v = decideClose({ dirty: isDirty(modal), pending: isPending(modal), confirmFn });
        if (!v.close) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        clearDrafts(modal);
    }, true);
}

function textFieldTag(el) {
    const tag = String(el.tag || el.tagName || '').toLowerCase();
    return (tag === 'textarea' || tag === 'input') && !NOT_TEXT.has(String(el.type || '').toLowerCase());
}
