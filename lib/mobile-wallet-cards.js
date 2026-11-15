// The "Open in mobile wallet" cards in the connect panel. Import-free of the app
// so it can be tested. A deep link is shown only where the wallet documents one
// and, for Nova, only while NOVA_DAPP_CATALOG_LISTED is true (see
// lib/wallet-links.js for the catalog requirement). Otherwise the card shows
// plain steps plus the store links.
import { MOBILE_WALLETS, NOVA_DAPP_CATALOG_LISTED, EXPLORER_ORIGIN } from './wallet-links.js';

export function mobileWalletCardsHtml({ esc, isMobile, novaListed = NOVA_DAPP_CATALOG_LISTED }) {
    const cards = MOBILE_WALLETS.map(w => {
        const usable = w.deeplink && (w.id !== 'nova' || novaListed);
        const link = usable ? w.deeplink(EXPLORER_ORIGIN) : null;
        const steps = (!link && w.inAppBrowser)
            ? `<p class="mobile-wallet-steps">Open ${esc(w.id === 'nova' ? 'Nova' : w.name)}, tap Browser, enter explorer.polkadex.ee, then Allow.</p>`
            : '';
        const stores = (w.appStore || w.playStore)
            ? `<div class="mobile-wallet-storelinks">
                    ${w.appStore ? `<a href="${esc(w.appStore)}" target="_blank" rel="noopener"><i class='bx bxl-apple'></i> iOS</a>` : ''}
                    ${w.playStore ? `<a href="${esc(w.playStore)}" target="_blank" rel="noopener"><i class='bx bxl-play-store'></i> Android</a>` : ''}
                   </div>`
            : `<a class="mobile-wallet-cta secondary" href="${esc(w.site)}" target="_blank" rel="noopener">Visit ${esc(w.name)}</a>`;
        const primary = isMobile && link
            ? `<a class="mobile-wallet-cta" href="${esc(link)}">Open in ${esc(w.name)}</a>`
            : steps + stores;
        return `<div class="mobile-wallet-card">
            <div class="mobile-wallet-head">
                <strong>${esc(w.name)}</strong>
                <span>${esc(w.tagline)}</span>
            </div>
            ${primary}
        </div>`;
    }).join('');
    return `<div class="mobile-wallet-grid">${cards}</div>`;
}
