// The help centre's content, as data.
//
// Audit F-069: script.js is a god-file — 15,254 lines and 350 top-level
// functions at the time of writing, up from 13,701 at round 1. The audit's own
// fix direction is "record the debt, do not split these files in this audit,
// extract pure helpers behind tests first", and that is the right call for the
// BEHAVIOUR: the 185 module-level mutable variables are what actually couple
// the page modules together, and threading that state through parameters is
// the expensive, regression-prone part. Doing it in the same pass as a dozen
// behavioural fixes would make every one of them harder to review and revert.
//
// This is the exception, and the reason it is worth doing alone: it is DATA,
// not logic. A flat array of {slug, title, category, keywords, body} with no
// function calls and no reference to any module state — so the move is
// mechanical, verifiable by diffing the array, and cannot change behaviour.
// It is ~4% of the file for approximately zero risk.
//
// It also buys something the array could not have while it was buried in a
// bundle with no export surface: tests. Every `slug` is a live URL at
// /help/<slug>, so a duplicate silently shadows an article and a typo'd
// `category` drops one out of the grid entirely — neither is visible by
// reading the file, and both are now assertions.
//
// Content is adapted from the PDF user guide, chunked into self-contained
// articles. Shipping it in the bundle rather than fetching it is deliberate:
// help must work when the backend is the thing that is broken.

export const HELP_CATEGORIES = [
    { id: 'start',     label: 'Getting started' },
    { id: 'browse',    label: 'Browsing the chain' },
    { id: 'wallet',    label: 'Wallet & sending' },
    { id: 'staking',   label: 'Staking' },
    { id: 'gov',       label: 'Governance' },
    { id: 'tools',     label: 'Tools & extras' },
    { id: 'reference', label: 'Reference' },
];

// Each topic: { slug, title, category, keywords, body }. Body is HTML.
// Keywords are matched in the search (plus title + body fall-back). Keep
// articles short — under ~250 words — so they read on a single screen.
export const HELP_TOPICS = [
    {
        slug: 'quick-start',
        title: 'Quick start',
        category: 'start',
        keywords: 'getting started first time onboarding walkthrough new user',
        body: `
            <p class="lead">Fifteen minutes from zero to a connected wallet, a first transfer, and (optionally) your first nomination.</p>
            <ol class="help-steps">
                <li><b>Open the explorer</b> at <code>explorer.polkadex.ee</code>. Browse without logging in — no wallet needed for read-only use.</li>
                <li><b>Install a wallet extension</b> — Polkadot.js, Talisman, SubWallet, or PolkaGate on desktop. On mobile, use Nova Wallet or SubWallet's in-app browser.</li>
                <li><b>Create or import an account</b> inside the wallet. Write down the seed phrase on paper. Never paste it into the explorer.</li>
                <li><b>Connect</b> by clicking <i>My Account</i>; the explorer detects your extension and lists each account.</li>
                <li><b>Send a small test transfer</b> from the Wallet Dashboard's <i>Send PDEX</i> button. Verify the recipient first.</li>
                <li><b>Optional: stake</b> — click <i>Stake more</i>, pick validators, and sign. Rewards start next era (~24 hours).</li>
                <li><b>Optional: star what matters</b> — click the star icon next to any address, validator, or proposal to bookmark it locally.</li>
            </ol>
            <p>Once you're moving, treat the rest of the help center as a reference — skim what you need.</p>
        `
    },
    {
        slug: 'installing-a-wallet',
        title: 'Installing a wallet',
        category: 'start',
        keywords: 'wallet extension polkadot.js talisman subwallet polkagate nova mobile install setup',
        body: `
            <p>To do anything that signs a transaction (send PDEX, stake, vote), you need a Substrate wallet. The explorer never sees your private key — it asks your wallet to sign on your behalf.</p>
            <h3>Desktop</h3>
            <ul>
                <li><b>Polkadot.js</b> — the official reference extension. Simple and reliable.</li>
                <li><b>Talisman</b> — feature-rich UI, supports multiple chains.</li>
                <li><b>SubWallet</b> — broad chain support, mobile companion app.</li>
                <li><b>PolkaGate</b> — focus on staking and governance UX.</li>
            </ul>
            <h3>Mobile</h3>
            <p>Install <b>Nova Wallet</b> or the <b>SubWallet</b> mobile app, then open the explorer inside the wallet's built-in browser. The explorer detects mobile-wallet WebViews and behaves accordingly.</p>
            <div class="help-callout">
                <b>About seed phrases.</b> Anyone with your seed phrase has your funds. Write it on paper. Don't take a screenshot, don't paste it anywhere online, don't store it in a cloud note.
            </div>
        `
    },
    {
        slug: 'connecting-wallet',
        title: 'Connecting your wallet',
        category: 'start',
        keywords: 'connect wallet sign in extension permission account selection my account',
        body: `
            <p>Click <b>My Account</b> in the sidebar. The explorer detects every Substrate wallet extension and shows you a status banner ("Detected Polkadot.js" etc.). Click <b>Connect</b> and your extension pops up asking for permission to share its account list.</p>
            <p>Once approved, each exposed account renders as a clickable button. Click the one you want to use — the explorer remembers your choice and routes to your <b>Wallet Dashboard</b>.</p>
            <h3>Multiple accounts</h3>
            <p>If your wallet exposes more than one account, the explorer prefers the last account you used. Use <b>Switch wallet</b> on the dashboard to return to the picker.</p>
            <h3>View-only mode</h3>
            <p>From the connect page, scroll to <i>"…or look up any address without connecting"</i>, paste a Polkadex address, and click View. The dashboard renders with all actionable buttons hidden — useful for inspecting other wallets.</p>
        `
    },
    {
        slug: 'home-dashboard',
        title: 'Home dashboard',
        category: 'browse',
        keywords: 'home dashboard landing network info stats issuance market cap',
        body: `
            <p>The home page is the whole explorer in one screen. From top to bottom:</p>
            <ul>
                <li><b>Stats strip</b> — Market Cap, Total Issuance, In Stake, AVG APY.</li>
                <li><b>Network Information</b> — current era, validators ratio, nominators ratio, max active stake.</li>
                <li><b>Recent Blocks</b> — live feed of the latest blocks finalized on chain.</li>
                <li><b>Recent Transactions</b> — live feed of recent signed financial transactions.</li>
                <li><b>Lower Network Information grid</b> — average validator commission, min stake, total bonding/unbonding, last era rewards total.</li>
            </ul>
            <p>Click any block or transaction to drill into its detail page. Use the "View all" links to jump to the dedicated <i>Blocks</i> or <i>Transactions</i> pages.</p>
        `
    },
    {
        slug: 'blocks',
        title: 'Blocks page',
        category: 'browse',
        keywords: 'blocks history list extrinsic author parent hash',
        body: `
            <p>The Blocks page lists every block our indexer has crawled, newest first. Each row shows block number, age, extrinsic count, hash, and parent hash.</p>
            <p>Use the global search box at the top to filter across all columns, or click a column header to sort. Click any row to open the block detail page, which lists every extrinsic and event in that block.</p>
            <p>Pagination shows 50 rows per page by default; "Show more" extends to 200 rows; numbered pagination handles anything beyond.</p>
        `
    },
    {
        slug: 'transactions',
        title: 'Transactions page',
        category: 'browse',
        keywords: 'transactions transfers signed extrinsic fee status',
        body: `
            <p>The Transactions page is a feed of signed financial transactions (transfers and other balance-affecting calls). Columns: hash, signer, recipient, amount, fee, age, status.</p>
            <p>The <b>Load Older 100 Financial Tx</b> button at the bottom of the list pulls older transactions from the indexer in batches once you scroll past the in-memory cache.</p>
            <h3>Transaction detail recovery</h3>
            <p>If you open a <code>/tx/&lt;block&gt;/&lt;hash&gt;</code> URL and the transaction isn't there — chain reorg, hand-edited URL, or an event ID misrouted as a tx hash — the explorer shows a recovery card with a context-aware action button: <i>View block</i> for event IDs, <i>Search recent blocks</i> for stale hashes, <i>Deep search</i> for everything else.</p>
        `
    },
    {
        slug: 'events',
        title: 'Events page',
        category: 'browse',
        keywords: 'events log section method pallet runtime emit',
        body: `
            <p>The Events page shows the raw event log of the chain, excluding transactions (which have their own page). Events are emitted by runtime modules when something happens: <i>balances.Transfer</i> when PDEX moves, <i>staking.Reward</i> when an era pays out, <i>democracy.Proposed</i> when a referendum is filed.</p>
            <p>Use the Section and Method dropdowns to narrow to a specific runtime module or event type. Pagination matches the blocks/transactions pattern.</p>
        `
    },
    {
        slug: 'validators',
        title: 'Validators page',
        category: 'browse',
        keywords: 'validators list active stake commission risk apy scorecard slashes',
        body: `
            <p>The Validators page lists every validator currently authoring blocks. Columns: address, identity, total stake (own + nominated), commission, real APY (30-day), and Now vs Real.</p>
            <h3>What to look for</h3>
            <ul>
                <li><b>HIGH RISK badge</b> — commission &gt; 50%. The validator keeps a majority of rewards. Avoid.</li>
                <li><b>Est. APY (current commission)</b> — the chain's nominal maximum APY adjusted for the validator's current commission. A projection of what nominating this validator would yield if conditions hold — not a measured historical average.</li>
                <li><b>Total stake</b> — too low risks dropping out of the active set; very high may dilute your share.</li>
            </ul>
            <p>Click a row to open the <b>Validator Detail</b> page, which adds a scorecard with estimated APY, commission band, active-era rate, slash count, and current stake. Star the validator (top-right) to add to your <b>Watchlist</b>.</p>
        `
    },
    {
        slug: 'holders',
        title: 'Top PDEX holders',
        category: 'browse',
        keywords: 'holders top rich list balance share supply',
        body: `
            <p>The Holders page ranks addresses by total balance, with each holder's percentage of the total supply. Useful for tracking treasury, exchange, and large institutional accounts.</p>
            <p>Identity is shown when set on chain; otherwise you see the short SS58 address. Click any row to open the address's full account details page.</p>
        `
    },
    {
        slug: 'accounts',
        title: 'Account details',
        category: 'browse',
        keywords: 'account address balance identity transactions events label watchlist',
        body: `
            <p>Click any address anywhere in the explorer to land on its account-details page at <code>/account/&lt;address&gt;</code>. You see:</p>
            <ul>
                <li><b>Identity table</b> — balance breakdown (total, free, frozen), display name, roles, and a community-labels panel.</li>
                <li><b>Transactions tab</b> — every signed financial transaction the address signed or received.</li>
                <li><b>Events tab</b> — every event the address appeared in (staking rewards, governance votes, etc.).</li>
                <li><b>Watchlist star</b> — toggles the address into your local watchlist.</li>
            </ul>
            <p>For your <i>own</i> wallet (richer dashboard with action buttons), use <i>My Account</i> from the sidebar — that lands you on <code>/wallet/&lt;address&gt;</code> instead.</p>
        `
    },
    {
        slug: 'search',
        title: 'Search',
        category: 'browse',
        keywords: 'search find lookup block hash address validator identity deep network',
        body: `
            <p>The search box in the top bar accepts a block number, block hash, transaction hash, address, validator identity, or extrinsic hash.</p>
            <p>The first pass runs locally against whatever the explorer has cached client-side — fast but limited. If that misses, click <b>Deep Search Network</b> at the bottom of the results to query the full server-side index and the chain RPC. On a hit, the explorer redirects to the right detail page.</p>
        `
    },
    {
        slug: 'sending-pdex',
        title: 'Sending PDEX',
        category: 'wallet',
        keywords: 'send transfer pdex recipient amount fee keep alive existential deposit',
        body: `
            <p>From the Wallet Dashboard's action bar, click <b>Send PDEX</b>. The modal opens:</p>
            <ol class="help-steps">
                <li><b>Recipient</b> — paste a Polkadex address (starts with "e"). Verify carefully.</li>
                <li><b>Amount</b> — in PDEX. The modal shows your transferable balance for reference.</li>
                <li><b>Keep account alive</b> — leave this checked unless you're intentionally draining your own account. With it on, the explorer refuses to drop your balance below the existential deposit (a fraction of a PDEX).</li>
                <li>Click <b>Send</b>. Your wallet extension pops up — review the call data and approve.</li>
            </ol>
            <p>On success, the modal closes and the dashboard refreshes within a couple of blocks.</p>
            <div class="help-callout warn">
                <b>Always test new addresses with a small amount.</b> Errors and typos in addresses are not reversible.
            </div>
            <h3>Common errors</h3>
            <ul>
                <li><b>"No wallet extension detected"</b> — install one, or open the explorer inside a mobile wallet's WebView.</li>
                <li><b>"Recipient below existential deposit"</b> — to fund a brand-new account, send at least the existential deposit.</li>
                <li><b>"Amount exceeds transferable balance"</b> — your free balance is below the requested amount after fees and locks.</li>
            </ul>
        `
    },
    {
        slug: 'switching-wallets',
        title: 'Switching wallets',
        category: 'wallet',
        keywords: 'switch wallet disconnect view only multiple accounts',
        body: `
            <p>The dashboard header has two key controls:</p>
            <ul>
                <li><b>Switch wallet</b> — returns to the connect picker so you can choose a different account from your extension.</li>
                <li><b>Disconnect</b> (topbar icon) — forgets the active wallet entirely.</li>
            </ul>
            <p>Both are local operations; the chain doesn't know or care which wallet your browser has open.</p>
            <p>If you want to peek at someone else's wallet without connecting, use the <i>"…look up any address"</i> input on the connect page. The dashboard renders in <b>view-only mode</b> — all action buttons hidden, but you see balances, validators, and recent activity.</p>
        `
    },
    {
        slug: 'identity',
        title: 'On-chain identity',
        category: 'wallet',
        keywords: 'identity display name display email twitter web matrix riot set clear reset register deposit',
        body: `
            <p class="lead">Register a display name, email, twitter handle, website, or Matrix ID on chain so other Polkadex apps see this address as a named entity — not just a raw <code>e…</code> address.</p>
            <h3>How to set it</h3>
            <ol class="help-steps">
                <li>Open your <b>Wallet Dashboard</b> and click <b>Set identity</b> (or <b>Update identity</b> if you already have one).</li>
                <li>Fill in any fields you want public. <b>Display name</b> is the one that shows up everywhere in the explorer; the rest are optional.</li>
                <li>Click <b>Save identity</b>. Your wallet pops up to sign.</li>
                <li>Within a couple of blocks, your new identity appears on the home page, validators list, holders ranking, and account-details pages.</li>
            </ol>
            <h3>About the deposit</h3>
            <p>The identity pallet locks a small refundable PDEX deposit while your identity exists. The exact amount is shown in the modal — it's a few PDEX, scaling slightly with how many fields you fill. When you clear the identity, the deposit returns to your free balance immediately.</p>
            <h3>Field limits</h3>
            <p>Each field is capped at <b>32 bytes</b> by the runtime. UTF-8 emoji and CJK characters use 3–4 bytes each, so plan accordingly. The form will truncate gracefully if you exceed.</p>
            <h3>Resetting (clearing) your identity</h3>
            <p>The same modal has a red <b>Reset (clear)</b> button when an identity already exists. Click it, confirm, and sign — your identity is removed and the deposit returns to your free balance. You can set a new one any time.</p>
            <div class="help-callout">
                <b>Identity is public.</b> Anything you put here is on chain forever — even after you clear it, indexers may keep the historical version. Don't include personal info you wouldn't want associated with your address permanently.
            </div>
            <h3>Verification / judgements</h3>
            <p>Registrars on Polkadex can attest that an identity is genuine — this shows up as a green check in some wallets and explorers. Requesting a judgement is a separate flow not yet exposed in the explorer UI; for now use <a href="https://polkadot.js.org/apps" target="_blank" rel="noopener" class="item-link">Polkadot.js Apps</a> if you need a verified identity.</p>
        `
    },
    {
        slug: 'proxies-and-multisig',
        title: 'Proxies & multisig',
        category: 'wallet',
        keywords: 'proxy multisig delegate signer threshold staking governance advanced',
        body: `
            <p>The Wallet Dashboard's <b>Advanced</b> section exposes two power-user features. Skip unless you specifically need them.</p>
            <h3>Proxies</h3>
            <p>A proxy is a delegated signer for your account, optionally restricted to a subset of calls. Examples:</p>
            <ul>
                <li><b>Staking proxy</b> — lets a hot wallet claim rewards without ever holding your stash key.</li>
                <li><b>Governance proxy</b> — delegate voting to someone you trust.</li>
            </ul>
            <p>The Proxies card lists each delegate with type and delay. <b>Remove</b> revokes a proxy; <b>Add proxy</b> authorises a new one. The proxy type dropdown is sourced from the live runtime metadata.</p>
            <div class="help-callout">
                <b>What this explorer can and cannot sign.</b> It signs <code>proxy.addProxy</code> and <code>proxy.removeProxy</code> for <em>your own</em> account — managing who may act for you. It does <b>not</b> support acting <em>as</em> someone's proxy (<code>proxy.proxy</code>): if an account has delegated to you, submit that call from <a href="https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.polkadex.ee#/extrinsics" target="_blank" rel="noopener" class="item-link">polkadot.js Apps</a>.
            </div>
            <h3>Multisig</h3>
            <p>A multisig is an address derived from a list of signers and a threshold (e.g. 2-of-3). Transactions need <b>at least threshold-of-N</b> approvals to execute. The address is deterministic — anyone with the same signer list and threshold can recompute it.</p>
            <p>The calculator turns a textarea of signer addresses + threshold into the corresponding multisig address. The <b>Pending approvals</b> table shows multisig transactions still waiting for further signatures.</p>
            <div class="help-callout">
                <b>Multisig here is read-only.</b> The calculator and the pending-approvals table are views — the explorer cannot approve, execute or cancel a multisig call (<code>multisig.asMulti</code>, <code>approveAsMulti</code>, <code>cancelAsMulti</code>). Sign those from <a href="https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.polkadex.ee#/extrinsics" target="_blank" rel="noopener" class="item-link">polkadot.js Apps</a>. Use this page to compute the address and to watch what is pending.
            </div>
            <div class="help-callout">
                <b>When to consider multisig.</b> Treasury accounts, DAOs, and high-value vaults benefit: no single key compromise loses funds. The trade-off is operational — every transaction needs several humans to coordinate signing.
            </div>
        `
    },
    {
        slug: 'how-staking-works',
        title: 'How staking works',
        category: 'staking',
        keywords: 'staking concept nominator validator era bond unbond pos nominated proof stake',
        body: `
            <p>Polkadex is a Nominated Proof-of-Stake chain. <b>Validators</b> author and verify blocks; <b>nominators</b> like you support validators with PDEX stake and earn a share of the rewards.</p>
            <p>Your PDEX moves through five states:</p>
            <ol class="help-steps">
                <li><b>Free</b> — normal balance, spendable.</li>
                <li><b>Bonded</b> — committed to staking. Not yet earning.</li>
                <li><b>Nominating</b> — backing validators. Each era (~24h) you receive a share of their rewards, minus commission.</li>
                <li><b>Unbonding</b> — you've requested some stake back. A 28-day cool-down begins.</li>
                <li><b>Withdrawable</b> — cool-down complete; one more call returns it to free.</li>
            </ol>
            <div class="help-callout">
                <b>You only earn while nominating.</b> Bonding by itself doesn't pay. You must also nominate at least one active validator. Validators outside the active set in a given era pay no rewards even if you nominate them.
            </div>
        `
    },
    {
        slug: 'nominating',
        title: 'Nominating a validator',
        category: 'staking',
        keywords: 'nominate stake bond validator pick commission slash apy',
        body: `
            <p>From the dashboard, click <b>Stake more</b>. The first time, the call is a combined <code>bond + nominate</code>; on later top-ups it's <code>bondExtra</code>. The explorer figures out which call shape your runtime accepts and handles it.</p>
            <h3>Before you nominate</h3>
            <p>Browse the Validators page. Look at:</p>
            <ul>
                <li><b>Commission</b> — the cut the validator keeps. Avoid &gt; 50% (HIGH RISK badge).</li>
                <li><b>Total stake</b> — too low risks dropping out; very high dilutes your share. Aim near the active-set median.</li>
                <li><b>Slash count</b> — non-zero means past penalties. One is usually accidental; many is a pattern.</li>
                <li><b>Est. APY</b> — the chain's nominal maximum APY (23.09%) adjusted for the validator's <em>current</em> commission. It is a projection from today's commission, not a measured return, and it changes the moment the validator changes commission.</li>
            </ul>
            <h3>The stake modal</h3>
            <p>The modal pre-fills your current nominations. Use the search box to filter validators. You can nominate up to 16 at once — spread across several gives exposure even if one drops out. Type the amount and click <b>Stake</b>.</p>
            <div class="help-callout">
                <b>Rewards start next era.</b> A nomination made <i>during</i> era N takes effect from era N+1.
            </div>
        `
    },
    {
        slug: 'claiming-rewards',
        title: 'Claiming rewards',
        category: 'staking',
        keywords: 'claim payout rewards staking payoutstakers utility batch',
        body: `
            <p>Rewards are computed per era per validator and sit on chain as unclaimed entries until someone calls <code>staking.payoutStakers</code>. Any account can trigger a payout — not just you.</p>
            <p>On the dashboard, the <b>Pay out rewards</b> button shows the unclaimed entry count in parentheses. Click it. The modal lists each unpaid <i>(era, validator, amount)</i> tuple. Click <b>Sign &amp; Pay Out</b> and the explorer bundles up to 30 payout calls into one <code>utility.forceBatch</code> transaction — sign once for all of them.</p>
            <p><b>If you have more than 30 unpaid entries</b>, the modal says so before you sign, and this transaction claims the first 30. Run Pay Out again afterwards for the rest. The cap keeps a single transaction well under the per-block weight limit.</p>
            <p><b>Why <code>forceBatch</code> and not <code>batch</code>.</b> Each payout is independent, and an era that someone else has already claimed returns <code>AlreadyClaimed</code>. <code>forceBatch</code> continues past that and pays out the rest; the atomic <code>batchAll</code> would revert every payout in the transaction because of the one that was already settled, costing you a fee for nothing.</p>
            <div class="help-callout warn">
                <b>Era retention window.</b> The chain prunes payable era history after ~84 eras. If you wait too long, the unclaimed reward becomes uncollectable. The explorer flags expiring eras with an orange badge.
            </div>
        `
    },
    {
        slug: 'unstaking',
        title: 'Unstaking & unbonding',
        category: 'staking',
        keywords: 'unstake unbond withdraw cool down 28 days unlock chill min nominator bond max',
        body: `
            <p>Click <b>Unstake</b> on the dashboard. Enter the PDEX amount you want to unbond. The modal shows the current unbonding period — typically 28 days — and your existing unlocking balance (if any).</p>
            <p>After signing, the PDEX moves into the <b>unbonding</b> state. When the unbonding period elapses, one more call (<code>withdrawUnbonded</code>) returns it to your free balance. Open the <b>Unstake</b> modal on My Account — when matured funds are waiting, it shows a “Withdrawable now” row with a <b>Withdraw unbonded funds</b> button.</p>
            <p>You can have multiple in-flight unbonding chunks at once, each with its own clock.</p>
            <h3>Partial vs. full unbond</h3>
            <p>The network enforces a <b>minimum bond</b> — usually 100 PDEX. A partial unbond that would leave you below that threshold is rejected by the runtime. The modal shows the current minimum so you can size your unbond accordingly.</p>
            <p>Clicking <b>Max</b> performs a full unbond. The explorer batches a <code>chill</code> call before <code>unbond</code> in a single atomic transaction — this removes your stash from the nominator set first so the runtime accepts an active bond of zero. After a full unbond your nominations are cleared; if you later top up with <code>bond_extra</code>, you'll need to re-nominate before earning rewards again.</p>
        `
    },
    {
        slug: 'staking-rewards-page',
        title: 'Staking Rewards page',
        category: 'staking',
        keywords: 'staking rewards history apr realized csv tax export chart era',
        body: `
            <p>The page at <code>/staking-rewards/&lt;address&gt;</code> is the deep view of any address's reward history. You don't need to be signed in to inspect your own rewards.</p>
            <h3>On the page</h3>
            <ul>
                <li><b>Summary cards</b> — Claimed Rewards, Unpaid, Total, Claimed Payouts, Eras, and the <b>realized APR card</b>.</li>
                <li><b>Realized APR</b> — headline 30-day APR, with 90-day and all-time in the subtitle plus the bonded PDEX used in the calculation.</li>
                <li><b>Per-validator stacked-bar chart</b> of daily rewards.</li>
                <li><b>Filter pills</b> — All / Claimed / Unpaid.</li>
                <li><b>Reward table</b> — Era, Date, Amount, Status, Validator, Block. Sortable, paginated.</li>
                <li><b>Download buttons</b> — CSV, JSON, Tax (year…).</li>
            </ul>
            <h3 id="tax">Tax CSV</h3>
            <p>The <b>Tax (year)</b> button opens a year picker and produces a year-scoped CSV with a PDEX→USD spot price at era close on every row. Only claimed rewards are included; unclaimed eras are excluded as not-yet-realised income. A totals row sits at the bottom.</p>
            <div class="help-callout warn">
                <b>Not tax advice.</b> Your jurisdiction's treatment of staking rewards (income at receipt? at claim? at sale?) is yours to confirm with a qualified accountant.
            </div>
        `
    },
    {
        slug: 'governance-overview',
        title: 'How Polkadex is governed',
        category: 'gov',
        keywords: 'governance overview democracy council treasury referendum motion proposal',
        body: `
            <p>Polkadex is community-governed. PDEX holders propose changes, vote on referenda, and spend treasury funds. The explorer surfaces the entire lifecycle in three pages:</p>
            <ul>
                <li><b>Democracy</b> — public proposals and binding on-chain referenda.</li>
                <li><b>Council</b> — elected body that can fast-track proposals and manage treasury approvals.</li>
                <li><b>Treasury</b> — on-chain PDEX pot funded from fees + slashes; spent on community proposals.</li>
            </ul>
            <p>Off-chain debate lives at <i>Discussions</i>. Any proposal, motion, or referendum number is clickable in any table — it opens the <b>governance detail modal</b> with status, proposer, beneficiary, blocks, and call hash. Voting itself is not in the modal; use the per-row Aye/Nay buttons on the Democracy → Referenda table.</p>
        `
    },
    {
        slug: 'democracy-and-voting',
        title: 'Democracy & voting',
        category: 'gov',
        keywords: 'democracy referendum vote aye nay conviction lock public proposal',
        body: `
            <p>A <b>referendum</b> is a binding on-chain vote. Once it passes (and a short enactment delay elapses), the proposed call is dispatched automatically.</p>
            <h3>Voting</h3>
            <p>On the Democracy → Referenda tab, ongoing referenda have <b>Aye</b> / <b>Nay</b> buttons inline. Click your direction; the vote modal opens.</p>
            <ul>
                <li><b>Side toggle</b> — switch Aye/Nay before submitting.</li>
                <li><b>Lock amount</b> — how much PDEX you're locking behind the vote.</li>
                <li><b>Conviction</b> — multiplier. <code>None</code> (0.1×, no lock) up to <code>Locked6x</code> (6×, locked 32 eras after the referendum closes). Default <code>Locked1x</code>.</li>
            </ul>
            <div class="help-callout">
                <b>Conviction is a trade-off.</b> Higher conviction = more vote weight, but a longer lock on your PDEX. If you feel strongly and don't need the PDEX soon, scale conviction up.
            </div>
        `
    },
    {
        slug: 'council-and-motions',
        title: 'Council & motions',
        category: 'gov',
        keywords: 'council motion member candidacy vote elections fast-track',
        body: `
            <p>The <b>Council</b> is an elected body that can fast-track proposals, manage treasury approvals, and veto bad runtime upgrades. A <b>motion</b> is a council vote on a specific call.</p>
            <p>Two tabs:</p>
            <ul>
                <li><b>Members</b> — seat and runner-up counts, candidate count, Term Progress dial.</li>
                <li><b>Motions</b> — every council motion (active and historical) with threshold and tally. Click a motion # to see status, the call it dispatches, blocks, and on-chain proposal hash.</li>
            </ul>
            <p>The header has <b>Submit Candidacy</b> (run for a seat) and <b>Vote</b> (rank candidates in an ongoing election round) buttons.</p>
            <h3>Filtering motions</h3>
            <p>The Motions tab has a <b>status</b> pill row (Voting open, Threshold met, Rejected, Voting ended, Executed, Approved, Disapproved, Closed) and a <b>Call type</b> dropdown (e.g. <code>treasury.approveProposal</code>). Both filters apply to the open motions <i>and</i> the Resolved Motions table, and stay visible even when nothing is currently open — handy for finding, say, every treasury-approval motion the council has handled.</p>
            <h3>Proposing a motion</h3>
            <p>A <b>Propose motion</b> button is shown on the Motions tab to everyone — you don't need to connect first to see it. Tabling a motion does require a council seat: when you act, you're prompted to connect a wallet, and the submission is restricted to current council members. Use it to table a treasury <b>approve</b> or <b>reject</b> for a pending proposal: pick the call, enter the treasury proposal #, set the approval threshold (defaults to a simple majority of seats), and sign. The motion then appears under Motions for the council to vote on, and dispatches its call once it reaches threshold. This is how an "open" treasury proposal actually gets approved — there is no approve button on the proposal itself.</p>
            <p>You can also start this straight from a proposal: on the <a href="/treasury" class="item-link">Treasury</a> page, every open proposal row has a <b>Propose motion</b> button, and opening a proposal's detail (click its <code>#</code>) shows <b>Propose approval motion</b> / <b>Propose rejection motion</b>. Either opens the same dialog pre-filled with that proposal's number.</p>
        `
    },
    {
        slug: 'treasury',
        title: 'Treasury',
        category: 'gov',
        keywords: 'treasury proposal beneficiary bond approval awards',
        body: `
            <p>The Treasury is an on-chain pot of PDEX, funded from transaction fees and slashed stake. Anyone can submit a proposal asking for funds; the council and/or a referendum approve or reject.</p>
            <p>Four tabs: <b>Overview, Open, Approved, History</b>. Each lists proposals by ID, proposer, beneficiary, requested PDEX, and status.</p>
            <p>The header <b>Submit proposal</b> button opens a modal where you can post a new request. A deposit is required, and rejected proposals burn the deposit — so write carefully and discuss in <i>Discussions</i> first.</p>
        `
    },
    {
        slug: 'discussions',
        title: 'Discussions',
        category: 'gov',
        keywords: 'discussions forum thread post sign in wallet signature',
        body: `
            <p>Off-chain commentary on governance items lives at <code>/discussions</code>. Each thread is associated with a governance proposal so people can debate the merits before voting.</p>
            <h3>Reading</h3>
            <p>No sign-in needed. Browse the thread list; click any thread for the per-thread view.</p>
            <h3>Posting</h3>
            <p>Click <b>Sign in with wallet</b>. The explorer asks your wallet to sign a short challenge — no transaction, just a signature. The resulting bearer token is stored locally and lasts <b>7 days</b>, then you'll be asked to sign again. Each post shows your address and a local-time timestamp.</p>
        `
    },
    {
        slug: 'analytics',
        title: 'Network analytics',
        category: 'tools',
        keywords: 'analytics dashboard kpi charts treasury price daily transactions active addresses',
        body: `
            <p>The Analytics page at <code>/analytics</code> is the bird's-eye view of the chain — useful for monitoring health or spotting anomalies. Click the date-range pills (Last 7d / 30d / 90d / Year) to change the window.</p>
            <h3>KPI strip</h3>
            <ul>
                <li><b>Indexed blocks</b> — how many blocks we have indexed vs. chain head.</li>
                <li><b>Indexed transactions</b> — count of balances transfers held in the local transaction index.</li>
                <li><b>Validators</b> — active / total registered (with current era).</li>
                <li><b>Nominators</b> — active / total.</li>
                <li><b>Total staked</b> — total bonded PDEX (with % of issuance).</li>
                <li><b>Total issuance</b> — current supply.</li>
            </ul>
            <h3>Charts</h3>
            <p>Six time-series charts: daily transactions, daily PDEX volume, daily active addresses, daily blocks produced, PDEX/USD, and cumulative treasury awards.</p>
        `
    },
    {
        slug: 'watchlist',
        title: 'Watchlist',
        category: 'tools',
        keywords: 'watchlist star bookmark favourite address validator proposal referendum',
        body: `
            <p>The Watchlist is your private bookmark folder. Star anything that matters — an address, a validator, a referendum, a treasury proposal — and it shows up at <code>/watchlist</code>.</p>
            <p>The data lives entirely in your browser (<code>pdex_watchlist_v1</code>); no server-side personal storage. There's no cross-device sync — by design.</p>
            <h3>What you can star</h3>
            <p>Addresses, validators, referenda, council motions, treasury proposals, public proposals, blocks. Anywhere a star icon appears, click to toggle.</p>
            <p>On the Watchlist page, items are grouped by kind. Each shows its label, the date you starred it, and a star icon to unstar. A <b>Clear all</b> button at the top wipes the list.</p>
        `
    },
    {
        slug: 'community-labels',
        title: 'Community labels',
        category: 'tools',
        keywords: 'labels community vote report veto signed identity address suggest',
        body: `
            <p>Community labels turn anonymous addresses into named entities through community consensus. Anyone with a wallet can suggest a label; everyone votes; the address owner has veto power. The highest-scored label is shown everywhere that address appears.</p>
            <h3>Posting a label</h3>
            <ol class="help-steps">
                <li>Connect a wallet.</li>
                <li>Go to the Account Details page of the address.</li>
                <li>In the Labels panel, click <b>Sign in with wallet</b>. Your wallet signs a short challenge — no transaction, just a signature. The token persists for 7 days.</li>
                <li>Type your label (max 64 chars) and click <b>Suggest</b> (or <b>Set label</b> if you own the address).</li>
            </ol>
            <h3>Voting, reporting, veto</h3>
            <ul>
                <li><b>Up/down chevrons</b> — vote any non-self label. The viewer's own vote is highlighted.</li>
                <li><b>Report</b> — flag inappropriate labels. At ≥3 distinct reporters the label is auto-hidden.</li>
                <li><b>Veto</b> — only the address owner. Hides a label they don't want associated with their account.</li>
            </ul>
            <div class="help-callout">
                <b>Rate limit.</b> Each wallet can post at most one label-related write per 60 seconds, to prevent spam.
            </div>
        `
    },
    {
        slug: 'privacy',
        title: 'Privacy & data handling',
        category: 'tools',
        keywords: 'privacy gdpr data storage cookies localstorage rights tracking analytics',
        body: `
            <p>Short version: we don't track you, we don't set cookies, we don't run third-party analytics. The full <b>Privacy Policy</b> lives at <code>/privacy</code>; the localStorage inventory at <code>/cookies</code>.</p>
            <h3>What we store about you</h3>
            <ul>
                <li><b>On-chain data</b> — already public. We index it, we don't own it.</li>
                <li><b>Local storage</b> — a handful of <code>pdex_*</code> keys on your device only (wallet address, watchlist, label session, tour-seen flag, banner dismissal, APR period). Never sent to us.</li>
                <li><b>Server logs</b> — standard web-server logs (IP, user-agent, URL, response, timestamp). 30-day retention.</li>
            </ul>
            <h3>What we do NOT do</h3>
            <p>No Google Analytics, no Mixpanel, no Segment, no advertising scripts, no third-party JavaScript. Every script the explorer loads runs from <code>explorer.polkadex.ee</code>.</p>
            <h3>Your rights</h3>
            <p>Under GDPR, UK GDPR, and CCPA you can request access, correction, and deletion. Clear local storage any time via your browser settings or the <b>Reset all preferences</b> button on <code>/cookies</code>. To delete community labels, discussions, or vote rows you authored, message us with the wallet that signed them.</p>
        `
    },
    {
        slug: 'troubleshooting',
        title: 'Troubleshooting & FAQ',
        category: 'reference',
        keywords: 'troubleshoot faq help error problem issue fix',
        body: `
            <h3>"Why is my balance different here from in my wallet extension?"</h3>
            <p>They should match within a block. If they don't, the explorer is likely a few blocks behind chain head while the indexer backfills. Refresh after a minute or two.</p>
            <h3>"I sent a transaction but I cannot find it."</h3>
            <p>Wait two blocks (about 12 seconds). Or use the transaction hash in the global search bar — don't try to construct the URL by hand.</p>
            <h3>"The Pay out button is disabled."</h3>
            <p>You have no unclaimed reward entries — either you're not nominating, or someone else has already triggered the payout on your behalf.</p>
            <h3>"Why is realized APR different from the chain's theoretical APR?"</h3>
            <p>Theoretical APR is a target; realized is what you actually got after commission and active-era variability. Realized is usually a few percentage points lower.</p>
            <h3>"I see a 503 'Connecting to Polkadex node…' message."</h3>
            <p>Our backend lost its WebSocket connection to the chain RPC. It auto-reconnects within seconds. Click the Retry button. If it persists, try again later.</p>
            <h3>"How do I delete a label I posted by mistake?"</h3>
            <p>Open the address's account-details page. In the Labels panel, your own label has a <b>Remove mine</b> button. Sign in with the same wallet first if you posted from another device.</p>
        `
    },
    {
        slug: 'brand-kit',
        title: 'Brand kit',
        category: 'reference',
        keywords: 'brand kit colours colors palette typography logo design tokens identity',
        body: `
            <p class="lead">A quick-reference cheatsheet for the explorer's visual identity — colours, typography, logo usage, iconography, spacing tokens, and voice rules.</p>
            <p>The interactive version lives at <a href="/brand" class="item-link"><b>/brand</b></a>. Click any colour swatch on that page to copy its hex value. Tokens are read live from the CSS, so the page always reflects what the site is rendering.</p>
            <p>A markdown reference for engineering and design pairing lives at <code>BRAND.md</code> in the repo root.</p>
            <h3>Quick facts</h3>
            <ul>
                <li><b>Primary colour</b> is Polkadex pink <code>#E6007A</code> — reserved for the most important call to action on each screen.</li>
                <li><b>Secondary colour</b> is accent green <code>#00E676</code> — for successful actions and positive metrics.</li>
                <li><b>Typeface</b> is Inter (300/400/500/600/700), self-hosted from this origin (no Google Fonts request). Monospace stack is <code>Courier New, monospace</code> for addresses, hashes, and URLs.</li>
                <li><b>Icons</b> come from Boxicons 2.1.4, used via the <code>bx-*</code> class system.</li>
            </ul>
            <div class="help-callout">
                <b>Source of truth.</b> When the brand evolves, edit the <code>:root</code> block in <code>styles.css</code> and the <code>BRAND.md</code> file together — the <a href="/brand" class="item-link">/brand</a> page reads from CSS at render time so it stays in sync automatically.
            </div>
        `
    },
    {
        slug: 'governance-calendar',
        title: 'Governance calendar',
        category: 'gov',
        keywords: 'calendar governance referendum referenda motion treasury proposal schedule timeline',
        body: `
            <p class="lead">The Governance Calendar at <a href="/calendar" class="item-link"><b>/calendar</b></a> gives you a single view of every active and recent on-chain governance event: democracy referenda, council motions, and treasury proposals — with their tabled dates, voting end times, and current status.</p>
            <h3>What you'll see</h3>
            <ul>
                <li><b>Active events</b> float to the top with a live "X days Y hours left" countdown until voting closes.</li>
                <li><b>Recent activity</b> is sorted by most recently resolved.</li>
                <li><b>Filter pills</b> let you narrow to just referenda, motions, or treasury proposals.</li>
                <li><b>List vs Month view</b>: list view is sortable, paginated, and filterable by text. Month view is a 7-column grid with coloured dots per event — click a dot to open that proposal.</li>
            </ul>
            <h3>How end times are calculated</h3>
            <p>For events with a known wall-clock end timestamp (treasury, motions), we display that directly. For referenda that end at a future block, we estimate using the current chain head and Polkadex's ~12-second block time. Estimates drift by a few minutes over a 7-day voting period — close enough to plan around.</p>
            <h3>Related</h3>
            <p>For per-pallet detail, see the <a href="/democracy" class="item-link"><b>Democracy</b></a>, <a href="/council" class="item-link"><b>Council</b></a>, and <a href="/treasury" class="item-link"><b>Treasury</b></a> pages. The calendar is a roll-up of those.</p>
        `
    },
    {
        slug: 'price-chart',
        title: 'PDEX price chart',
        category: 'tools',
        keywords: 'price chart pdex history graph coinmarketcap cmc usd usdt 7 day 30 day 90 day all-time',
        body: `
            <p class="lead">A full-screen view of the PDEX/USD price, reached by clicking the price in the bottom-left corner of the sidebar.</p>
            <h3>What you see</h3>
            <p>The current PDEX price and 24-hour percent change sit at the top of the page, with a line chart showing the selected period below and high/low/volume/period-change stats underneath.</p>
            <h3>Choosing a time period</h3>
            <p>Pick from <strong>7D · 30D · 90D · 1Y · ALL</strong> with the pills above the chart. Your choice is remembered between visits via a small <code>pdex_price_period</code> entry in your browser's local storage (no cookies, never sent to our server — see <a href="/cookies" class="item-link">/cookies</a>).</p>
            <h3>Where the data comes from</h3>
            <p>Live price polls come from <strong>CoinGecko</strong>, which aggregates PDEX across its real markets — no API key required. (CoinMarketCap can be added as an extra source with a key.) Historical PDEX/USDT data going back to PDEX's first trading day in March 2022 is retained on disk, so the chart stays a single continuous series.</p>
            <h3>Closing</h3>
            <p>Click the <strong>×</strong> in the top-right of the chart page to return to wherever you were before opening it.</p>
        `
    },
    {
        slug: 'email-alerts',
        title: 'Email alerts',
        category: 'gov',
        keywords: 'email alerts subscription notification referendum proposal closing reminder unsubscribe',
        body: `
            <p class="lead">Get a short email when on-chain events happen on Polkadex — new referenda, public proposals, 24-hour voting reminders, and more. Double opt-in, one-click unsubscribe.</p>
            <h3>How to subscribe</h3>
            <p>Open the subscribe form from any of three places:</p>
            <ul>
                <li>The <strong>Email alerts</strong> button on the homepage banner when a new referendum is announced.</li>
                <li>The button at the top of the <a href="/calendar" class="item-link">Governance Calendar</a>.</li>
                <li>The button at the top of the <a href="/democracy" class="item-link">Democracy</a> page.</li>
            </ul>
            <p>Enter your email, pick which events you want, and submit. We'll send a one-time confirmation link — click it once and you're set.</p>
            <h3>What you can subscribe to</h3>
            <p><strong>Governance:</strong> new referendum opens for voting · new public proposal tabled · 24-hour reminder before a referendum closes · referendum result (passed/failed) · treasury proposal activity · council motion activity.</p>
            <p><strong>Network milestones:</strong> runtime upgrade · era boundary summary · chain stalled alert. These are off by default — most people only want the governance events.</p>
            <h3>Unsubscribe and preferences</h3>
            <p>Every alert email has two links in its footer. <strong>Manage preferences</strong> opens a page where you can tick and untick any of the nine alert types above and save — no login or wallet needed, because the link itself identifies you. <strong>Unsubscribe</strong> stops everything.</p>
            <p>Both links are personal to you, so treat them like a password: anyone who has the URL can change your alert settings. Neither is indexed by search engines. If you lose them, the footer of any later alert email has a fresh copy.</p>
            <p>Confirming a subscription and unsubscribing both ask you to click a button on the page rather than acting on the link itself — that is deliberate, so a corporate mail scanner following links in your inbox can't opt you in or out without you.</p>
            <h3>Privacy and data handling</h3>
            <p>Your email address is stored only to deliver the alerts you've selected. We don't sell it, hand it to other services, or use it for marketing. The <a href="/privacy" class="item-link">privacy policy</a> has the full details. We use a transactional email provider (Postmark) for delivery — they see the email content but only to send it.</p>
        `
    },
    {
        slug: 'governance-notifications',
        title: 'New-event notifications',
        category: 'gov',
        keywords: 'notification banner toast new referendum proposal alert announcement',
        body: `
            <p class="lead">The explorer surfaces new democracy events so you don't have to manually check every visit. Notifications fire when a referendum is tabled or a new public proposal is submitted on-chain.</p>
            <h3>Where you'll see them</h3>
            <ul>
                <li><b>Homepage banner</b>: a coloured row at the top of the dashboard with the event ID and a View button. Persists until you click the ✕ close button or visit the event's page.</li>
                <li><b>Toast notification</b>: a brief popup in the bottom-right when the explorer's poller first detects a new event while you're browsing. Auto-dismisses after 6 seconds; click to open, ✕ to dismiss early.</li>
            </ul>
            <h3>How "new" is decided</h3>
            <p>The explorer keeps the highest referendum and proposal index you've previously seen in your browser's local storage. When the on-chain index is higher, you get a banner. Closing the banner stops THIS index from popping up again; a later event still triggers a fresh banner.</p>
            <p>Visiting the <a href="/calendar" class="item-link">Calendar</a> page also marks events as "seen" — useful if you've reviewed today's governance and want to start fresh.</p>
            <h3>Privacy</h3>
            <p>The poll runs every 60 seconds against <code>/api/governance/latest</code> and only reads public on-chain state. No tracking. The "last seen" indices live in your browser and are documented at <a href="/cookies" class="item-link">/cookies</a>.</p>
        `
    },
    {
        slug: 'glossary',
        title: 'Glossary',
        category: 'reference',
        keywords: 'glossary terminology terms definitions',
        body: `
            <dl class="help-glossary">
                <dt>era</dt><dd>A scheduling unit on Polkadex (~24 hours). Validator rewards are computed and paid per era.</dd>
                <dt>validator</dt><dd>A node that authors and verifies blocks. Earns rewards proportional to (own + nominated) stake, minus commission.</dd>
                <dt>nominator</dt><dd>A PDEX holder who delegates stake to validators.</dd>
                <dt>bonded</dt><dd>PDEX set aside for staking; unspendable until withdrawn after the unbonding period.</dd>
                <dt>slash</dt><dd>Penalty deducted from a misbehaving validator and its nominators.</dd>
                <dt>referendum</dt><dd>A public on-chain vote that, when approved, dispatches a runtime call automatically.</dd>
                <dt>conviction</dt><dd>Multiplier on your referendum vote. Higher conviction = more weight + longer lock.</dd>
                <dt>motion</dt><dd>A council-collective proposal. Approved motions dispatch their underlying call on chain.</dd>
                <dt>council</dt><dd>Elected body of PDEX holders that can fast-track proposals and manage treasury approvals.</dd>
                <dt>treasury</dt><dd>On-chain PDEX pot funded from fees + slashes; spendable by community proposals.</dd>
                <dt>commission</dt><dd>The fraction of rewards a validator keeps before distributing the rest to its nominators.</dd>
                <dt>payout</dt><dd>On-chain claim that distributes era rewards. Anyone can trigger it.</dd>
                <dt>extrinsic</dt><dd>A signed or unsigned transaction that mutates chain state.</dd>
                <dt>event</dt><dd>A side-effect emitted by a pallet during block execution.</dd>
                <dt>pallet</dt><dd>A self-contained runtime module — staking, democracy, treasury, etc.</dd>
                <dt>SS58</dt><dd>Substrate's address encoding. Polkadex uses prefix 88; addresses start with "e".</dd>
                <dt>proxy</dt><dd>Delegated signer for another account, optionally restricted to a subset of calls.</dd>
                <dt>multisig</dt><dd>Deterministic address derived from signers + threshold. Calls need threshold-of-N approvals.</dd>
                <dt>existential deposit</dt><dd>The minimum balance the chain insists an account hold to exist.</dd>
                <dt>utility.batch</dt><dd>A call that bundles N other calls into one signed transaction.</dd>
                <dt>unbonding period</dt><dd>Cool-down (28 days) between requesting unbonded PDEX and being able to withdraw it.</dd>
                <dt>chain reorg</dt><dd>When the chain replaces a recent block with a different one. The explorer's recovery card handles small reorgs transparently.</dd>
            </dl>
        `
    },
];
