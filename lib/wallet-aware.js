// Pages that show one account's data, or sign for one account, and the
// connected wallet.
//
// Reported 11 Nov: "/staking-rewards should pick up the connected wallet as
// default. There are other pages also where the connected wallet doesn't
// automatically load ... Upon switching / disconnecting wallet, these pages
// should automatically pick up and respond." The audit is docs/wallet-aware-pages.md.
//
// The one source of truth stays lib/wallet-session.js (getActiveAccount,
// onActiveAccountChange). This file holds what a page needs around it:
//
//   createRouteScope   subscribe on mount, unsubscribe on route leave, so a
//                      page that is gone never hears a switch (routeTo leaves it)
//   createLatest       one request per page: a newer one, a switch or leaving
//                      the page makes the old response stale and aborts it
//   stakingRewardsPlan what /staking-rewards shows for (URL address, wallet)
//   viewFollowsWallet  on a switch: follow, or stay on an address the user chose
//   closeSigningModals a modal opened for the old account must not sign for the new one
//
// No imports on purpose, so the logic runs under node --test.

export function createRouteScope() {
    let subs = [];
    return {
        add(unsub) { if (typeof unsub === 'function') subs.push(unsub); return unsub; },
        leave() {
            const list = subs;
            subs = [];
            for (const u of list) { try { u(); } catch (e) { /* the next page still mounts */ } }
        },
        size: () => subs.length
    };
}

export function createLatest({ AbortCtl = globalThis.AbortController } = {}) {
    let gen = 0, ctl = null;
    const stop = () => { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } ctl = null; } };
    return {
        begin() {
            stop();
            ctl = AbortCtl ? new AbortCtl() : null;
            const mine = ++gen;
            return { signal: ctl ? ctl.signal : undefined, isCurrent: () => mine === gen };
        },
        cancel() { gen++; stop(); }
    };
}

// Routes that follow the wallet through their own subscription, so the global
// "re-render the page on a wallet change" must leave them alone: re-entering
// /staking-rewards/<old> would read as an explicit choice of the old address.
export function selfManagedRoute(route) {
    return /^(staking-rewards|validate)(\/|$)/.test(String(route || ''));
}

// account: getActiveAccount(). An address in the URL is authoritative for
// viewing; with none, the connected wallet is shown and the URL stays bare,
// so a copied link does not pin the account (a typed address does go in).
export function stakingRewardsPlan({ urlAddress, account, isSame }) {
    const wallet = (account && account.status === 'connected' && account.address) || '';
    if (urlAddress) return { mode: 'view', address: urlAddress, wallet };
    if (wallet) return { mode: 'view', address: wallet, wallet };
    return { mode: account && account.status === 'restoring' ? 'restoring' : 'connect', address: '', wallet: '' };
}

// The page was showing the wallet (nothing explicit, or the address that was
// connected until now): it follows. Otherwise the user chose that address.
export function viewFollowsWallet({ viewed, previous, isSame }) {
    if (!viewed) return true;
    return !!previous && isSame(viewed, previous);
}

// A change made in another tab, seen on a wallet route. /wallet/<old> follows
// to /wallet/<new> (or the picker on disconnect); anything else is kept.
export function walletRouteAfterChange(route, change, isSame) {
    const r = String(route || '');
    if (!r.startsWith('wallet/')) return r;
    const viewed = r.slice('wallet/'.length);
    if (!viewFollowsWallet({ viewed, previous: change.previous, isSame })) return r;
    return change.current ? 'wallet/' + change.current : 'wallet';
}

// Switch wallet from the header: the picker, then back to the page it was
// opened from. From a wallet page the picker's own landing is right. A
// self-managed page showing the wallet's own address goes back bare, or the
// old account would come back pinned as if the user had typed it.
export function pickerTarget(route, search, isWalletRoute, { wallet = '', isSame = () => false } = {}) {
    let r = String(route || 'home');
    if (isWalletRoute(r)) return 'wallet?switch=1';
    const slash = r.indexOf('/');
    if (selfManagedRoute(r) && slash !== -1 && wallet && isSame(r.slice(slash + 1), wallet)) r = r.slice(0, slash);
    const here = (r === 'home' ? '/' : '/' + r) + (search || '');
    return 'wallet?switch=1&returnTo=' + encodeURIComponent(here);
}

// "Viewing X; your wallet is Y. Show mine", or '' when nothing is connected or
// they are the same account.
export function viewingBannerHtml({ viewing, wallet, isSame, esc, shortAddr, hrefFor }) {
    if (!viewing || !wallet || isSame(viewing, wallet)) return '';
    return `<div class="wallet-viewing-note" role="status"><i class='bx bx-info-circle'></i> `
        + `Viewing <span title="${esc(viewing)}">${esc(shortAddr(viewing))}</span>; `
        + `your wallet is <span title="${esc(wallet)}">${esc(shortAddr(wallet))}</span>. `
        + `<a href="${esc(hrefFor(wallet))}" class="item-link">Show mine</a></div>`;
}

// "Viewing X, read only. No wallet is connected. Connect wallet", or '' when a
// wallet is connected. The /wallet/<address> dashboard's slot with nothing
// connected (the banner above needs a wallet, this needs none, so the two never
// show together). The link opens the chooser and comes back to this address.
export function notConnectedNoteHtml({ viewing, wallet, esc, shortAddr, returnTo = '/wallet/' + encodeURIComponent(viewing) }) {
    if (!viewing || wallet) return '';
    return `<div class="wallet-viewing-note is-readonly"><i class='bx bx-show' aria-hidden="true"></i> `
        + `Viewing <span title="${esc(viewing)}">${esc(shortAddr(viewing))}</span>, read only. No wallet is connected. `
        + `<a href="/wallet?returnTo=${encodeURIComponent(returnTo)}" class="item-link" data-spa-link="true">Connect wallet</a></div>`;
}

// Nothing connected: one link to the global connector (the header's), which
// brings the user back here once an account is picked.
export function connectNoteHtml({ returnTo, what, esc }) {
    return `<div class="wallet-connect-note"><a href="/wallet?returnTo=${encodeURIComponent(returnTo)}" class="item-link">Connect a wallet</a> `
        + `to see ${esc(what)}, or enter any address above.</div>`;
}

export function restoringNoteHtml() {
    return `<div class="wallet-connect-note"><i class='bx bx-loader-alt bx-spin'></i> Checking for a connected wallet…</div>`;
}

// Every modal that signs for the connected account. On a wallet change they
// close: the account it was opened for is not the one that would sign. The
// guard in test/wallet-aware-pages.test.js fails on a .modal in index.html
// that is in neither list.
export const SIGNING_MODAL_IDS = Object.freeze([
    'council-withdraw-modal', 'council-candidacy-modal', 'council-vote-modal', 'treasury-spend-modal',
    'referendum-vote-modal', 'stake-modal', 'payout-modal', 'multisig-review-modal', 'send-modal',
    'unstake-modal', 'identity-modal'
]);
export const NON_SIGNING_MODAL_IDS = Object.freeze(['email-subscribe-modal', 'governance-detail-modal', 'onboarding-tour-modal']);

export function closeSigningModals(doc, ids = SIGNING_MODAL_IDS) {
    const closed = [];
    if (!doc || typeof doc.getElementById !== 'function') return closed;
    for (const id of ids) {
        const el = doc.getElementById(id);
        if (!el || !el.style || !el.style.display || el.style.display === 'none') continue;
        el.style.display = 'none';
        closed.push(id);
    }
    return closed;
}

// Sprint 7 B2: the wallet dashboard's "Full reward history" link. The link
// style (.item-link), not green: green is for positive states only (BRAND.md).
export function rewardHistoryLinkHtml(address) {
    return `<a href="/staking-rewards/${encodeURIComponent(address)}" class="item-link wallet-history-link">Full reward history</a>`;
}

// Sprint 7 B3: the /wallet/<address> page's title and meta. initWalletPage
// uses it, and script.js refreshWalletPageTitle again when the session changes
// in place, so the tab says "My Account" exactly while that is true.
export function walletDashboardSeo(address, active, { isSame = (a, b) => a === b, shortAddr = (a) => a } = {}) {
    return {
        title: active && isSame(active, address) ? 'My Account - Polkadex Explorer' : 'Account ' + shortAddr(address) + ' - Polkadex Explorer',
        description: 'Your Polkadex account dashboard: balances, staking, nominations, rewards, and recent transactions.',
        canonicalPath: '/wallet/' + address,
        noindex: true
    };
}
