#!/usr/bin/env node
// Copy third-party browser scripts out of node_modules into public/vendor/ so
// Vite ships them from OUR origin.
//
// Audit F-029. index.html used to load executable JavaScript straight from
// jsDelivr and cdnjs on every page — including /wallet, where the same origin
// runs `signAndSend`. Worse, Chart.js was requested as
// `https://cdn.jsdelivr.net/npm/chart.js` with no version at all: whatever
// jsDelivr resolved `latest` to that minute got wallet-origin script execution.
// A surprise publish or a CDN compromise was a wallet compromise.
//
// Why copy from node_modules rather than commit blobs or add SRI hashes:
//   - the version is pinned by package-lock.json, so `npm ci` reproduces the
//     exact bytes and Dependabot/npm audit can actually see the dependency
//   - no minified vendor blobs in git, and no hash to forget to update
//   - same-origin is the precondition for a `script-src 'self'` CSP (F-039);
//     SRI alone would still leave a third-party origin in the policy
//
// Runs automatically: `npm run build` triggers the `prebuild` script, and
// Dockerfile.frontend does `npm ci` before `npm run build`, so the container
// build populates public/vendor without any extra step. public/vendor is
// gitignored — it is a build artifact, not source.

import { mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// UMD/classic builds on purpose: both are loaded by a plain <script> tag and
// assign a global (window.Chart / window.QRCode) that script.js already uses.
// Importing them as ES modules instead would scope those names to the module
// and silently break every chart and the donate-page QR code.
const ASSETS = [
    { from: 'node_modules/chart.js/dist/chart.umd.js', to: 'public/vendor/chart.umd.js' },
    { from: 'node_modules/qrcodejs/qrcode.min.js', to: 'public/vendor/qrcode.min.js' }
];

let copied = 0;
for (const asset of ASSETS) {
    const src = resolve(root, asset.from);
    const dest = resolve(root, asset.to);
    try {
        statSync(src);
    } catch {
        // Fail the build loudly. A missing vendor file means index.html would
        // 404 on a script it needs, and a silently chartless dashboard is
        // exactly the kind of regression that reaches production.
        console.error(`[vendor-assets] MISSING ${asset.from}`);
        console.error('[vendor-assets] run `npm ci` (or `npm install`) first — these come from package-lock.json.');
        process.exit(1);
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`[vendor-assets] ${asset.from} -> ${asset.to}`);
    copied++;
}
console.log(`[vendor-assets] ${copied} asset(s) vendored into public/vendor/`);
