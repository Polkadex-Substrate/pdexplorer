// What the user sees of WalletConnect: the pairing panel, the "Approve on
// your phone" notice and, with ?wcdebug=1, the support block. Plain DOM, no
// network.
//
// The QR code is drawn in the page by the self-hosted qrcodejs (window.QRCode,
// /vendor/qrcode.min.js, the same one the donate page uses). It draws into a
// canvas plus a data: image, both allowed by the CSP (img-src 'self' data:).
//
// On a phone the panel also has "Open wallet", a link to the pairing URI
// itself (wc:...). That is the WalletConnect URI scheme; the phone's system
// hands it to a wallet app registered for it. Wallet-specific deep links
// (Nova, SubWallet) are not used: their WalletConnect link formats could not
// be checked against the wallets' own documentation for this change.
//
// Tested in test/walletconnect.test.js.

import { escapeHtml } from './html-escape.js';

const WC_URI = /^wc:[A-Za-z0-9@?&=:._%+\-]+$/;

function drawQr(box, text) {
    const view = box.ownerDocument && box.ownerDocument.defaultView;
    const QR = view && view.QRCode;
    if (!QR) { box.innerHTML = '<span class="wc-qr-fallback">QR code unavailable. Copy the link below into your wallet instead.</span>'; return; }
    try {
        new QR(box, { text, width: 232, height: 232, colorDark: '#0d0d12', colorLight: '#ffffff', correctLevel: QR.CorrectLevel.L });
    } catch (e) {
        box.innerHTML = '<span class="wc-qr-fallback">QR code unavailable. Copy the link below into your wallet instead.</span>';
    }
}

// el: the panel element. Returns { setStatus(text), close() }.
// When the page around the panel supplies its own Back (the Connect wallet
// page marks the panel data-back), the panel has no Cancel of its own; Back
// cancels through the controller. onCancel stays wired for the panel's Cancel.
export function mountPairingPanel(el, { uri, onMobile = false, clipboard, onCancel }) {
    const linkable = typeof uri === 'string' && WC_URI.test(uri);
    const safe = linkable ? uri : '';
    const ownCancel = !(el.hasAttribute && el.hasAttribute('data-back'));
    el.innerHTML = `<div class="wc-pairing">
        ${onMobile && linkable ? `<p><a class="wc-open" href="${escapeHtml(safe)}">Open wallet</a></p>` : ''}
        <div class="wc-pairing-main">
            <div class="wc-qr" role="img" aria-label="WalletConnect pairing code"></div>
            <ol class="wc-steps"><li>Open Nova Wallet or SubWallet.</li><li>Tap scan.</li><li>Approve.</li></ol>
        </div>
        <div class="mobile-wallet-copyrow wc-copyrow">
            <input class="wc-uri" type="text" readonly aria-label="WalletConnect pairing link" value="${escapeHtml(safe)}">
            <button type="button" class="wc-copy">Copy link</button>
        </div>
        <p class="wc-status" role="status" aria-live="polite">Waiting for your phone...</p>
        ${ownCancel ? '<button type="button" class="wc-cancel">Cancel</button>' : ''}
    </div>`;
    if (linkable) drawQr(el.querySelector('.wc-qr'), uri);
    const copy = el.querySelector('.wc-copy'), input = el.querySelector('.wc-uri');
    copy.addEventListener('click', async () => {
        try {
            await clipboard.writeText(input.value);
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy link'; }, 1500);
        } catch (e) { input.select(); }
    });
    const cancel = el.querySelector('.wc-cancel');
    if (cancel) cancel.addEventListener('click', () => { if (onCancel) onCancel(); });
    return {
        setStatus(text) { const s = el.querySelector('.wc-status'); if (s) s.textContent = text; else el.textContent = text; },
        close() { el.innerHTML = ''; }
    };
}

// A small notice at the bottom of the page while a signing request waits on
// the phone. Returns close(); calling it twice is harmless.
export function showPendingNotice(doc, { kind = 'transaction', cancel } = {}) {
    const box = doc.createElement('div');
    box.className = 'wc-pending';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.innerHTML = `<i class='bx bx-mobile' aria-hidden="true"></i>
        <span class="wc-pending-text"><strong>Approve on your phone</strong> Open your wallet app to review this ${kind === 'message' ? 'sign-in request' : 'transaction'}.</span>
        <button type="button" class="wc-pending-cancel">Cancel</button>`;
    box.querySelector('button').addEventListener('click', () => { if (cancel) cancel(); });
    (doc.body || doc.documentElement).appendChild(box);
    return () => { if (box.parentNode) box.parentNode.removeChild(box); };
}

// ?wcdebug=1: the support details of a failed signature check, as text to copy
// (lib/walletconnect-debug.js). One block at a time; a newer one replaces it.
export function showDebugReport(doc, { text, clipboard } = {}) {
    const old = doc.querySelector('.wc-debug');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const box = doc.createElement('div');
    box.className = 'wc-debug';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'WalletConnect support details');
    box.innerHTML = `<p class="wc-debug-lead"><strong>Support details</strong> Copy this and send it to the Polkadex team. It holds the transaction and signature only, nothing secret.</p>
        <textarea class="wc-debug-text" readonly rows="10" aria-label="Support details"></textarea>
        <div class="wc-debug-actions"><button type="button" class="wc-debug-copy">Copy</button> <button type="button" class="wc-debug-close">Close</button></div>`;
    const area = box.querySelector('textarea');
    area.value = String(text == null ? '' : text);
    const copy = box.querySelector('.wc-debug-copy');
    copy.addEventListener('click', async () => {
        try { await clipboard.writeText(area.value); copy.textContent = 'Copied'; } catch (e) { area.select(); }
    });
    box.querySelector('.wc-debug-close').addEventListener('click', () => { if (box.parentNode) box.parentNode.removeChild(box); });
    (doc.body || doc.documentElement).appendChild(box);
    return box;
}
