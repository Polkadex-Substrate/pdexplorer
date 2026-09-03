// The /developers section bodies — ONE copy, rendered by both the SPA and the
// server-side page. (Audit F-060)
//
// WHY THIS FILE EXISTS
//
// /developers is rendered twice: script.js builds it in the browser, and
// server.js server-renders it for crawlers and no-JS loads (it is the only
// route this backend server-renders). Round 1 extracted the OUTLINE — the
// section list and order — into lib/api-reference.js. The BODIES stayed as two
// hand-maintained maps, and they drifted, exactly as two copies of anything in
// this repo do (F-133, F-198, and F-044's five copies of one number).
//
// Measured before this extraction, comparing the eight sections both maps
// defined, whitespace-normalised:
//
//     overview    similarity 0.34    server 431 chars   vs script 1687
//     cors        similarity 0.08    server 972         vs script 1109
//     examples    similarity 0.16    server 136         vs script 916
//     contact     similarity 0.31    server 149         vs script 296
//     addresses   similarity 0.55  |  inspect 0.68  |  errors 0.70  |  schema 0.95
//
// Not one of the eight matched. The server map also omitted TEN sections the
// SPA had, so a crawler fetching /developers saw roughly a quarter of the
// overview and none of the chain, accounts, labels, analytics, price,
// governance, email, discussions, auth or meta documentation. For a page whose
// entire audience is machines and people with JS disabled, the server copy was
// the one that mattered and the one that had rotted.
//
// The SPA text is taken as canonical here because it is what readers actually
// saw and what was kept current.
//
// SITE_URL: the SPA hardcoded absolute URLs in its curl examples while the
// server interpolated SITE_URL. Parameterised — the default reproduces the
// SPA's literal exactly, and server.js passes its configured origin, so a
// staging deployment stops printing production URLs in copy-paste examples.

import { RPC_NOT_READY, renderCacheTiers, renderSection, rpcNotReadyExample } from './api-reference.js';
import { MAX_APY_BASE } from './apy.js';
import { escapeHtml } from './html-escape.js';

export function developersBodies({ siteUrl = 'https://explorer.polkadex.ee' } = {}) {
    return {
    overview: `            <p>This explorer is a client-rendered single-page app: HTML pages are a shell that JavaScript fills in inside the browser. A non-browser client that fetches an HTML page will <strong>not</strong> see the data. Don't scrape the HTML — call the JSON API below, which returns plain JSON. Every figure on the site comes from an <code>/api/*</code> endpoint.</p>
            <p>Two things trip up automated clients, and how to handle them:</p>
            <div class="developers-table-wrap">
                <table class="developers-table">
                    <thead><tr><th>Behavior</th><th>What to do</th></tr></thead>
                    <tbody>
                        <tr><td><strong>The site sits behind Cloudflare.</strong> Requests from cloud/datacenter IP ranges are sometimes challenged, so a call from a CI runner or hosted backend can come back empty where the same call from a laptop succeeds.</td><td>It's an edge policy, not an API restriction — a plain <code>curl</code> gets HTTP 200. Send a descriptive <code>User-Agent</code>, respect the <code>Cache-Control</code> headers, and ask the operator to allowlist your range if you're calling from a data centre.</td></tr>
                        <tr><td><strong>The API itself is open to non-browser clients.</strong> CORS is a browser-only mechanism, so a caller that sends no <code>Origin</code> header (native app, server, script, AI agent) is always allowed.</td><td>Call the API directly from servers and native apps with no configuration. Only browser callers from other web origins need to be added to <code>ALLOWED_ORIGINS</code>.</td></tr>
                    </tbody>
                </table>
            </div>
            <p>A concise machine-readable index of the whole API — including the exact <code>/api/network-info</code> schema — lives at <a href="/llms.txt" class="item-link">/llms.txt</a>.</p>`,

    cors: `            <p>The CORS policy in <code>server.js</code> allows three caller categories:</p>
            <div class="developers-table-wrap">
                <table class="developers-table">
                    <thead><tr><th>Caller</th><th>Why it works</th></tr></thead>
                    <tbody>
                        <tr><td><strong>Native mobile apps</strong> (iOS, Android, React Native — anything not running inside a browser)</td><td>CORS is a browser-only mechanism; native HTTP clients don't send an <code>Origin</code> header, so the server's <em>"if no Origin, allow"</em> branch fires.</td></tr>
                        <tr><td><strong>Server-side proxies</strong> (your backend calling ours)</td><td>Same — no <code>Origin</code> header.</td></tr>
                        <tr><td><strong>Web apps</strong> at origins listed in the <code>ALLOWED_ORIGINS</code> env var (defaults to <code>explorer.polkadex.ee</code> + <code>localhost:3000</code>)</td><td>Explicitly allowed.</td></tr>
                    </tbody>
                </table>
            </div>
            <p>A web app at a different origin will be blocked by the browser's CORS check until its origin is added to <code>ALLOWED_ORIGINS</code> (operator change, requires a backend restart). Native mobile apps need no configuration at all.</p>`,

    caching: renderCacheTiers({ tableClass: 'developers-table' }),

    chain: `            ${renderSection('chain', { listClass: 'developers-endpoints' })}`,

    inspect: `            <p>Generic access to runtime metadata, storage and constants at <strong>any block</strong> — the endpoints behind <a href="/chain-state" class="item-link">/chain-state</a>. Backed by an archive node, so historical queries work.</p>
            ${renderSection('inspect', { listClass: 'developers-endpoints' })}
            <p><strong>Read-only by construction.</strong> Only <code>api.query</code>, <code>api.consts</code> and allowlisted read RPCs are reachable — nothing here can submit an extrinsic.</p>
            <p><strong>Send storage keys as strings.</strong> A u64 key such as <code>9223372036854775808</code> (2⁶³) is past JavaScript's <code>MAX_SAFE_INTEGER</code>, so a client that parses it as a number silently queries <code>9223372036854776000</code> — a different key whose empty result looks like confirmation. Responses echo <code>args</code> back so you can verify nothing was coerced.</p>
            <p><strong>Check <code>hex</code>, not <code>human</code>.</strong> <code>toHuman()</code> abbreviates hashes (an all-zero H256 renders as <code>0x0000…0000</code>, indistinguishable from a mostly-zero one) and group-separates large integers. Every response therefore carries human, JSON and hex together, plus a <code>count</code> for Vec-valued results.</p>
            <p>Note that <code>ValueQuery</code> maps return a <em>default-constructed</em> value for an absent key, so <code>isEmpty</code> can be <code>false</code> for a key that was never set — judge emptiness from the decoded contents.</p>
            <pre><code>curl '${siteUrl}/api/decode/12250870?method=submit_snapshot'
curl '${siteUrl}/api/state/ocex/validatorSetId?at=12250870'
curl '${siteUrl}/api/state/ocex/authorities?args=6280&amp;at=12250870'</code></pre>`,

    schema: `            <p>The home-page network panel in one call. Top-level response:</p>
            <pre><code>{
  "networkInfo": {
    "activeEra": number,              // current staking era index
    "avgValidatorCommission": number, // mean active-validator commission, %
    "avgApy": number,                 // headline AVG APY %, commission-adjusted
    "avg_apy": number,                // snake_case alias of avgApy
    "validators":  { "active": number, "total": number },
    "nominators":  { "active": number, "total": number },
    "maxActiveStake": number,         // largest active-validator total stake, PDEX
    "minStake": number,               // minimum active stake, PDEX
    "averageStake": number,           // mean active-validator stake, PDEX
    "avgStakePerAccount": number,     // total bonded / staking accounts, PDEX
    "totalIssuance": number,          // total PDEX issuance
    "totalBonding": number,           // total PDEX bonded for staking
    "totalBondingPercent": number,    // totalBonding / totalIssuance, %
    "totalUnbonding": number,         // total PDEX currently unbonding
    "totalStakeChange": number,       // net stake change vs previous era, PDEX
    "lastEraRewardsTotal": number     // total rewards paid last era, PDEX
  },
  "lastSync": number,                 // epoch ms when networkInfo was computed
  "status": "Synced" | "Stale" | "Initializing" | "Error",
  "chainHead": {
    "value": number,                  // best block number
    "lastAdvanceAt": number,          // epoch ms the head last advanced
    "staleSeconds": number,           // seconds since the head last advanced
    "isStale": boolean                // true if the head looks stuck
  }
}</code></pre>
            <p><strong>AVG APY</strong> is now returned directly (<code>avgApy</code>, and the <code>avg_apy</code> alias) so you don't have to recompute it. It's derived as <code>avgApy = ${MAX_APY_BASE} × (1 − avgValidatorCommission / 100)</code>, where ${MAX_APY_BASE}% is the chain's nominal maximum APY at its target staking ratio.</p>`,

    accounts: `            ${renderSection('accounts', { listClass: 'developers-endpoints' })}`,

    labels: `            ${renderSection('labels', { listClass: 'developers-endpoints' })}`,

    analytics: `            ${renderSection('analytics', { listClass: 'developers-endpoints' })}`,

    price: `            ${renderSection('price', { listClass: 'developers-endpoints' })}
            <p>CoinGecko is keyless (optional <code>COINGECKO_API_KEY</code> for higher limits); CoinMarketCap needs <code>CMC_API_KEY</code>.</p>`,

    governance: `            ${renderSection('governance', { listClass: 'developers-endpoints' })}`,

    email: `            ${renderSection('email', { listClass: 'developers-endpoints' })}`,

    discussions: `            ${renderSection('discussions', { listClass: 'developers-endpoints' })}`,

    auth: `            ${renderSection('auth', { listClass: 'developers-endpoints' })}`,

    meta: `            ${renderSection('meta', { listClass: 'developers-endpoints' })}`,

    errors: `            <p>Most failures return a 4xx/5xx status with <code>{ "error": "&lt;message&gt;" }</code>. The <code>error</code> string is written for display — <strong>do not match on it</strong>; it is reworded freely between releases.</p>
            <p>RPC-dependent endpoints surface <strong>503</strong> during chain RPC outages, carrying a stable <code>code</code> alongside the prose plus <code>Retry-After: 5</code> and <code>Cache-Control: no-store</code>:</p>
            <pre><code>${escapeHtml(rpcNotReadyExample())}</code></pre>
            <p>Branch on <code>code === "${RPC_NOT_READY.code}"</code> (or on the 503 status) and retry with backoff. <strong>Audit F-155:</strong> this section used to promise a short fixed <code>error</code> string that the server has never sent — clients matching it treated every outage as an unknown error. It is now rendered from the same constant the 503 handler uses.</p>`,

    addresses: `            <p>All paths that take an <code>:address</code> expect Polkadex-format SS58 (prefix 88, addresses start with <code>e…</code>). The server normalizes via <code>toPolkadexAddress()</code> so wallet-native prefixes (42, 0) usually also resolve, but consistency is recommended.</p>`,

    examples: `            <p>Network info (home-page summary):</p>
            <pre><code>curl ${siteUrl}/api/network-info</code></pre>
            <p>Latest PDEX price:</p>
            <pre><code>curl ${siteUrl}/api/price-latest</code></pre>
            <p>30-day price history (each row tagged with its data source):</p>
            <pre><code>curl '${siteUrl}/api/price-history?days=30'</code></pre>
            <p>Wallet summary for a Polkadex address (replace with a real <code>e…</code> address):</p>
            <pre><code>curl ${siteUrl}/api/wallet/esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew</code></pre>
            <p>Search — block number, block hash, or account. Audit F-086: this line used to promise extrinsic hits too; <code>/api/search</code> is a live-RPC probe that does not resolve extrinsic hashes. Use <code>/api/extrinsic-by-hash/:txHash</code> for those:</p>
            <pre><code>curl ${siteUrl}/api/search/12000000</code></pre>`,

    contact: `            <p>Open an issue at <a href="https://github.com/Polkadex-Substrate" target="_blank" rel="noopener" class="item-link">github.com/Polkadex-Substrate</a>, or reach the team via the channels listed at <a href="https://polkadex.ee" target="_blank" rel="noopener" class="item-link">polkadex.ee</a>.</p>`};
}
