// The "My Account" menu in the header.
//
// Until now the header button was a plain link to the dashboard, and the only
// switch control was a text button inside the dashboard header, absent while
// the page was loading or after an error. Someone who clicked My Account and
// saw nothing labelled "switch" or "log out" was right: it was not there.
//
// Connected: the button opens a menu with View account / Switch wallet /
// Disconnect. Not connected: the button does what "Connect Wallet" always did.
// DOM access is through the arguments so the behaviour is testable without a
// browser.

export function wireWalletMenu({ doc, button, menu, isConnected, onConnect, onView, onSwitch, onDisconnect }) {
    if (!button || !menu) return { close() {}, open() {}, isOpen: () => false };
    let open = false;

    function setOpen(v) {
        open = !!v;
        menu.hidden = !open;
        menu.style.display = open ? 'block' : 'none';
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    button.setAttribute('aria-haspopup', 'menu');
    setOpen(false);

    button.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (!isConnected()) { setOpen(false); onConnect(); return; }
        setOpen(!open);
    });

    const actions = { view: onView, switch: onSwitch, disconnect: onDisconnect };
    Array.from(menu.querySelectorAll('[data-wallet-action]')).forEach(item => {
        item.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            const fn = actions[item.getAttribute('data-wallet-action')];
            setOpen(false);
            if (fn) fn();
        });
    });

    // Click elsewhere or Escape closes it. Escape hands focus back to the button
    // so keyboard users are not dropped at the top of the page.
    doc.addEventListener('click', (e) => {
        if (!open) return;
        if (e && e.target && (menu.contains(e.target) || button.contains(e.target))) return;
        setOpen(false);
    });
    doc.addEventListener('keydown', (e) => {
        if (open && e && e.key === 'Escape') { setOpen(false); if (button.focus) button.focus(); }
    });

    return { close: () => setOpen(false), open: () => setOpen(true), isOpen: () => open };
}
