// Mobile wallet cards: Nova's "Open in Nova" link only works for dApps listed in
// Nova's DApp Catalog, so it is gated by NOVA_DAPP_CATALOG_LISTED.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mobileWalletCardsHtml } from '../lib/mobile-wallet-cards.js';
import { NOVA_DAPP_CATALOG_LISTED, EXPLORER_ORIGIN, MOBILE_WALLETS, allWalletUrls, OFFICIAL_HOSTS } from '../lib/wallet-links.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const render = (opts) => mobileWalletCardsHtml({ esc, isMobile: true, ...opts });
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Nova DApp Catalog gate', () => {
    test('the flag ships false and the origin is bare', () => {
        assert.equal(NOVA_DAPP_CATALOG_LISTED, false);
        assert.equal(EXPLORER_ORIGIN, 'https://explorer.polkadex.ee');
    });

    test('flag false: no Open in Nova button, plain steps and store links instead', () => {
        const h = render({ novaListed: false });
        assert.ok(!/Open in Nova/.test(h));
        assert.ok(!/app\.novawallet\.io/.test(h));
        assert.match(text(h), /Open Nova, tap Browser, enter explorer\.polkadex\.ee, then Allow/);
        assert.match(text(h), /Open SubWallet, tap Browser, enter explorer\.polkadex\.ee, then Allow/);
        assert.match(h, /apps\.apple\.com\/app\/nova-polkadot/);
        assert.match(h, /play\.google\.com\/store\/apps\/details\?id=io\.novafoundation\.nova\.market/);
    });

    test('default (no override) follows the shipped flag, which is off', () => {
        assert.ok(!/Open in Nova/.test(render({})));
    });

    test('flag true on a phone: link carries the encoded bare origin, no path or query', () => {
        const h = render({ novaListed: true });
        const href = h.match(/href="(https:\/\/app\.novawallet\.io[^"]+)"/)[1].replace(/&amp;/g, '&');
        assert.equal(href, 'https://app.novawallet.io/open/dapp?url=' + encodeURIComponent('https://explorer.polkadex.ee'));
        assert.match(h, /Open in Nova Wallet/);
    });

    test('flag true: a page URL with path, query and hash cannot leak into the link', () => {
        const h = render({ novaListed: true, currentUrl: 'https://explorer.polkadex.ee/wallet?x=1#/secret' });
        assert.ok(!/wallet/.test(h.match(/href="(https:\/\/app\.novawallet[^"]+)"/)[1]));
        assert.ok(!/secret|x%3D1/.test(h));
    });

    test('flag true on desktop: no deep link, store links', () => {
        const h = render({ novaListed: true, isMobile: false });
        assert.ok(!/Open in Nova/.test(h));
        assert.match(h, /apps\.apple\.com/);
    });

    test('every rendered https link is on an official host in both modes', () => {
        for (const novaListed of [false, true]) {
            for (const m of render({ novaListed }).matchAll(/href="(https:\/\/[^"/]+)/g)) {
                assert.ok(OFFICIAL_HOSTS.includes(m[1].slice(8)), m[1]);
            }
        }
        assert.ok(allWalletUrls().length > 0 && MOBILE_WALLETS.length === 3);
    });
});
