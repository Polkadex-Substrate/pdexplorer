// A "(?)" that works on touch and with a screen reader.
//
// A title attribute alone does not exist on touch and is unreliable for
// screen readers, so the "(?)" is a real button with aria-expanded and
// aria-controls that toggles a small popover on click, Enter or Space, and
// closes it on Escape, an outside click, or focus leaving both. On narrow
// screens the stylesheet renders the popover as a full-width sheet.
//
// The button may sit inside a <summary>: its click is stopped so it does not
// also open or close the disclosure.

export function helpPopoverHtml({ id, label, html }) {
    return {
        button: `<button type="button" class="wp-help-btn" aria-expanded="false" aria-controls="${id}" aria-label="${label}" title="${label}"><i class='bx bx-help-circle' aria-hidden="true"></i></button>`,
        popover: `<div class="wp-popover" id="${id}" role="note" hidden>${html}</div>`
    };
}

export function wireHelpPopover(btn, pop) {
    if (!btn || !pop) return { open() {}, close() {}, isOpen: () => false };
    const doc = btn.ownerDocument;
    const isOpen = () => btn.getAttribute('aria-expanded') === 'true';
    function set(v) {
        btn.setAttribute('aria-expanded', v ? 'true' : 'false');
        pop.hidden = !v;
    }
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        set(!isOpen());
    });
    const onKey = (e) => {
        if (e.key !== 'Escape' || !isOpen()) return;
        e.stopPropagation();
        set(false);
        if (btn.focus) btn.focus();
    };
    btn.addEventListener('keydown', onKey);
    pop.addEventListener('keydown', onKey);
    const onFocusOut = (e) => {
        const to = e.relatedTarget;
        if (to && (btn.contains(to) || pop.contains(to))) return;
        if (to) set(false);
    };
    btn.addEventListener('focusout', onFocusOut);
    pop.addEventListener('focusout', onFocusOut);
    // One listener per popover on the document; it removes itself once the
    // page that owned the popover has been re-rendered away.
    const onDocClick = (e) => {
        if (!btn.isConnected) { doc.removeEventListener('click', onDocClick, true); return; }
        if (!isOpen()) return;
        const t = e.target;
        if (t && (btn.contains(t) || pop.contains(t))) return;
        set(false);
    };
    if (doc) doc.addEventListener('click', onDocClick, true);
    return { open: () => set(true), close: () => set(false), isOpen };
}
