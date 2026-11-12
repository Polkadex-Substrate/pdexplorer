# Pages and the connected wallet

Audit of 11 Nov 2026, after the report that `/staking-rewards` does not pick up
the connected wallet and that other pages need the wallet connected again even
though the header already shows it.

## The one source of truth

`lib/wallet-session.js` holds the connected account (localStorage keys
`pdex_wallet_address`, `pdex_wallet_source`, `pdex_wallet_disconnected`). It now
has the page-facing API:

- `getActiveAccount()` returns `{ address, source, status }`, where `status` is
  `connected`, `none`, or `restoring` (the auto-pick on `/wallet` and `/stake`
  is asking the extension; a page shows "Checking for a connected wallet"
  instead of a Connect prompt).
- `onActiveAccountChange(cb)` returns an unsubscribe. `cb` gets
  `{ reason, previous, previousSource, current, source, status, external }`,
  with `reason` one of `connect`, `switch-account`, `switch-extension`,
  `disconnect`, `restore`. `external` is true for a change made in another tab
  (`syncExternal()`, called from the `storage` listener).
- The older `onChange` hook still runs first (it is `onWalletChanged()` in
  script.js: header, governance panels, signing modals, and a re-render of the
  page on screen); the page listeners run after it.

`lib/wallet-aware.js` has what pages use around it: `createRouteScope()`
(subscribe on mount, `routeTo()` unsubscribes on leave), `createLatest()` (a
generation token plus AbortController per page request), the page decisions,
and `closeSigningModals()`.

Restore is synchronous: a remembered account is connected before any page
mounts. The only asynchronous restore is the auto-pick on the wallet routes.

## Rules every page now follows

1. No address in the URL: the page shows the connected account.
2. An address in the URL (`/wallet/<addr>`, `/staking-rewards/<addr>`,
   `/account/<addr>`) is authoritative for viewing. When it is not the
   connected wallet the page says "Viewing X; your wallet is Y. Show mine".
3. Signing always uses the active wallet. Actions for an address that is not the
   active wallet are refused with "Connect this wallet ..." (unchanged).
4. A wallet change closes every open signing modal (`SIGNING_MODAL_IDS`). A test
   fails on any `.modal` in index.html that is not classified as signing or not.
5. The connect prompt is one link to the global connector (`/wallet?returnTo=`),
   which returns to the page. No page has its own extension connection.
6. Switch wallet from the header, opened on any non-wallet page, returns to that
   page with the new account (`?returnTo=`), and so does Keep in the picker.

## Pages

| Page | Before | After |
|---|---|---|
| `/staking-rewards` | Empty address box even with a wallet connected; ignored switch and disconnect; no stale-response guard (a slow response for an earlier address could paint over a later one). | Defaults to the connected wallet and keeps the URL bare, so a copied link does not pin the account (a typed address does go into the URL; Show mine links to the bare page). Follows switches; disconnect clears the rewards and shows the connect link. An address the user entered stays, with "Viewing X; your wallet is Y. Show mine". Subscribed through the route scope; the request is aborted and its response dropped on switch, new search or leaving the page. |
| `/wallet`, `/stake`, `/staking` | Read the session on load (redirect to `/wallet/<connected>`, auto-pick otherwise). | Unchanged, plus the auto-pick reports `restoring`. |
| `/wallet/<addr>` (dashboard, My Account) | Switch and disconnect in this tab navigate correctly. A switch in another tab re-rendered the OLD account's dashboard as view-only. Another address's dashboard did not say whose wallet is connected. | A change in another tab moves `/wallet/<old>` to `/wallet/<new>` (or the picker on disconnect); another address's dashboard is kept. "Viewing X; your wallet is Y. Show mine" on a dashboard that is not yours. In-flight dashboard fetches were already dropped (`walletFetchGen`). |
| Stake / validator picker, Unstake, Pay out, Send, Identity (dashboard modals) | Submit checked the active wallet against the dashboard address, but the modal stayed open after a switch in another tab, showing the old account's balances. | Closed on any wallet change. |
| Proxy (dashboard Advanced section) | Add and Remove only on your own dashboard, re-rendered with it, but the submit trusted that render. | Add and Remove pass `expectedWallet: address`, so the submit refuses once the wallet differs. |
| Multisig (dashboard list, review modal) | The review re-checked the selected account at signing time, but stayed open after a switch. | Review modal closed on any wallet change; its end hook releases the caller. |
| Council: vote, candidacy | Read the wallet when opened; stayed open after a switch, still naming the old account. | Closed on any wallet change. |
| Council: withdraw candidacy, motions vote and close | Withdraw modal closed by `councilCandidacyUI.accountChanged()`; motions re-render with the page. | Unchanged (fine). |
| Democracy: referendum vote | Stayed open after a switch, still naming the old account. | Closed on any wallet change. |
| Democracy: "You voted", gov item pages (vote, second, Actions panel) | `democracyView.restart()` and `govDetailPage.accountChanged()` already followed the wallet. | Unchanged (fine). |
| Democracy unlock, balance locks | On the dashboard, own account only. | Unchanged (fine). |
| Treasury: propose a spend, pay out a spend | `spendMotionUI.accountChanged()` closes the form; `spendPayoutUI.accountChanged()` re-renders. | Unchanged (fine); the spend modal is also in the closed-on-change list. |
| Discussions (post, author edit) | Re-rendered on a change; the posting session is valid only for the connected address. | Unchanged (fine). |
| `/account/<addr>` (labels: suggest or vote) | Explicit address; the label editor reads the wallet at render and is re-rendered on a change. | Unchanged (fine). |
| Watchlist | Stored per browser, not per account. | Not wallet-aware by design. |
| Calculators (multisig address calculator, `/utilities`), `/validators`, `/donate`, `/email/preferences` | No per-account data and no signer (email preferences use the token from the email link). | Not wallet-aware by design. |
| Header: Switch wallet | Went to the picker and then to the dashboard, leaving the page the user was on. | Returns to the page it was opened from. |

## Tests

`test/wallet-aware-pages.test.js`: the session events (connect, restore,
switch account, switch extension, disconnect, another tab, unsubscribe), the
route scope and request token, the page decisions, the signing-modal closer on
the real index.html (happy-dom) with the classification guard, and the real
staking-rewards functions from script.js in a vm over happy-dom: defaults to the
active account, follows a switch, clears on disconnect, explicit URL address
wins, a typed search is not undone, a stale response is dropped and aborted,
and leaving the page leaves no listener and paints nothing.

`test/wallet-change-guards.test.js`: the waits between a check and its effect.
send() re-checks the wallet after the fee check and again after the wallet
signed (signAsync, check, send), so a switch signs or broadcasts nothing;
submitSignedTx gives every caller that check. A tab restored from the
back-forward cache or woken re-reads the session. Success callbacks repaint the
dashboard only while it is still on screen. Clear identity carries the address
it was checked for across confirm(). Discussion sign-in keeps no token if the
wallet changed while it signed.
