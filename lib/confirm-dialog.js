// A small in-app confirm for the unsent-text prompt, replacing window.confirm:
// role="alertdialog", focus trapped between its two buttons, Escape = keep
// editing, and the answer comes back as a promise (lib/close-control.js
// accepts either a boolean or a promise from its confirmFn).
//
// Deliberately NOT a ".modal": the page-level Escape / Tab handler treats every
// open .modal as a dialog to close, and this one must answer for itself.

let seq = 0;

export function createConfirmDialog(doc, { title = 'Discard what you typed?', confirmLabel = 'Discard', cancelLabel = 'Keep editing' } = {}) {
    let pending = null;

    return function ask(message) {
        if (pending) return pending;
        const id = 'confirm-dialog-' + (++seq);
        const opener = doc.activeElement || null;

        const backdrop = doc.createElement('div');
        backdrop.setAttribute('class', 'confirm-dialog-backdrop');
        const box = doc.createElement('div');
        box.setAttribute('class', 'confirm-dialog');
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', id + '-title');
        box.setAttribute('aria-describedby', id + '-msg');
        const h = doc.createElement('h2'); h.setAttribute('id', id + '-title'); h.textContent = title;
        const p = doc.createElement('p'); p.setAttribute('id', id + '-msg'); p.textContent = String(message || '');
        const row = doc.createElement('div'); row.setAttribute('class', 'confirm-dialog-actions');
        const cancel = doc.createElement('button');
        cancel.setAttribute('type', 'button'); cancel.setAttribute('data-confirm', 'cancel'); cancel.textContent = cancelLabel;
        const ok = doc.createElement('button');
        ok.setAttribute('type', 'button'); ok.setAttribute('data-confirm', 'confirm'); ok.setAttribute('class', 'confirm-dialog-danger'); ok.textContent = confirmLabel;
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(h); box.appendChild(p); box.appendChild(row);
        backdrop.appendChild(box);
        doc.body.appendChild(backdrop);

        pending = new Promise((resolve) => {
            const done = (answer) => {
                pending = null;
                backdrop.remove();
                if (opener && doc.contains(opener)) { try { opener.focus(); } catch (_) { /* gone */ } }
                resolve(answer);
            };
            cancel.addEventListener('click', () => done(false));
            ok.addEventListener('click', () => done(true));
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
            backdrop.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault(); e.stopPropagation();   // not also the page-level Escape
                    done(false);
                } else if (e.key === 'Tab') {
                    // Two buttons: keep focus on them and wrap. Stopped so the
                    // page-level modal trap does not pull focus into the .modal behind.
                    e.stopPropagation();
                    const active = doc.activeElement;
                    const first = cancel, last = ok;
                    if (e.shiftKey && (active === first || active !== last)) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && (active === last || active !== first)) { e.preventDefault(); first.focus(); }
                }
            });
        });
        cancel.focus();   // the safe choice
        return pending;
    };
}
