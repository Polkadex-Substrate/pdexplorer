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
    return /^staking-rewards(\/|$)/.test(String(route || ''));
}

// account: getActiveAccount(). An address in the URL is authoritative for
// viewing; with none, the connected wallet is shown and written into the URL.
export function stakingRewardsPlan({ urlAddress, account, isSame }) {
    const wallet = (account && account.status === 'connected' && account.address) || '';
    if (urlAddress) return { mode: 'view', address: urlAddress, wallet, replaceUrl: false };
    if (wallet) return { mode: 'view', address: wallet, wallet, replaceUrl: true };
    return { mode: account && account.status === 'restoring' ? 'restoring' : 'connect', address: '', wallet: '', replaceUrl: false };
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
// opened from. From a wallet page the picker's own landing is right.
export function pickerTarget(route, search, isWalletRoute) {
    const r = String(route || 'home');
    if (isWalletRoute(r)) return 'wallet?switch=1';
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
