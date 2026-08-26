// Does the backend image actually contain the files the backend imports?
//
// This test exists because of a real outage on 2026-08-22. server.js gained
// `import { isOpenGovStatus } from './lib/gov-status.js'`, but
// Dockerfile.backend copies an EXPLICIT file list (not `COPY . .`) and lib/
// was not on it. Result: the container crash-looped on ERR_MODULE_NOT_FOUND,
// every /api/* route went dark, and — because nginx kept serving the SPA and
// the browser's own WebSocket kept streaming blocks — the site LOOKED alive
// with every backend-derived figure blank. It took two deploys to close.
//
// `node --check` cannot catch this: it validates syntax file by file and has
// no opinion about what gets shipped. The defect lives in the gap between the
// source tree and the built artifact, so the assertion has to compare those
// two things directly — which is all this file does.
//
// It is intentionally dumb: parse the COPY lines, parse the relative imports,
// assert every import is covered. No Docker required, runs in milliseconds.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// Every path the Dockerfile copies into the image, as written.
function copiedPaths(dockerfile) {
    const out = [];
    for (const line of dockerfile.split('\n')) {
        const m = line.match(/^COPY\s+(.*)$/);
        if (!m) continue;
        // Drop flags (--chown=..., --from=...); last token is the destination.
        const parts = m[1].trim().split(/\s+/).filter(p => !p.startsWith('--'));
        if (parts.length < 2) continue;
        out.push(...parts.slice(0, -1));
    }
    return out;
}

// Relative specifiers an entrypoint imports at runtime.
function relativeImports(src) {
    return [...src.matchAll(/(?:from|import)\s+['"](\.\/[^'"]+)['"]/g)].map(m => m[1]);
}

describe('Dockerfile.backend COPY list covers backend imports', () => {
    const dockerfile = read('Dockerfile.backend');
    const copied = copiedPaths(dockerfile);

    // Not just server.js. db.js is imported by server.js and has since grown
    // its own lib/ import (./lib/rpc-errors.js), so a module missing from the
    // image one level deeper crashes the container just as hard.
    const ENTRYPOINTS = ['server.js', 'db.js', 'email.js'];

    // Collective guard, not per-file: email.js legitimately imports nothing
    // relative, so asserting per file would fail on a correct tree. What we
    // actually need to know is that the regex still finds imports SOMEWHERE —
    // otherwise the coverage assertions below all pass vacuously.
    test('the import parser still finds relative imports (guard against a no-op test)', () => {
        const total = ENTRYPOINTS.reduce((n, e) => n + relativeImports(read(e)).length, 0);
        assert.ok(total > 0, 'parser found no relative imports at all — regex probably broke');
    });

    for (const entry of ENTRYPOINTS) {
        const imports = relativeImports(read(entry));

        test(`every relative import ${entry} declares is copied into the image`, () => {
            for (const spec of imports) {
                const rel = spec.replace(/^\.\//, '');            // lib/gov-status.js
                const topDir = rel.split('/')[0];                  // lib
                const covered = copied.includes(rel) || copied.includes(topDir);
                assert.ok(covered,
                    `${entry} imports '${spec}' but Dockerfile.backend never COPYs ` +
                    `'${rel}' or '${topDir}'. The container will die at startup with ` +
                    `ERR_MODULE_NOT_FOUND and every /api/* route will go dark while ` +
                    `the SPA keeps serving. Add it to the COPY list.`);
            }
        });
    }

    test('every path the Dockerfile COPYs exists in the repo', () => {
        // The mirror-image failure: a COPY of a path that was never committed
        // fails the BUILD instead of the runtime. Same outage, different half.
        for (const p of copied) {
            if (p === './' || p === '.') continue;
            const clean = p.replace(/\*.*$/, '');              // package-lock.json* → package-lock.json
            if (!clean) continue;
            assert.ok(existsSync(path.join(ROOT, clean)),
                `Dockerfile.backend COPYs '${p}' which does not exist in the repo — ` +
                `the image build will fail. Either commit it or drop the COPY line.`);
        }
    });
});

describe('lib/ modules are self-contained', () => {
    // lib/ ships into the backend image; if a lib module imported something
    // from the repo root that ISN'T copied, we would reintroduce the same
    // outage one level deeper. Enumerated from disk rather than hand-listed so
    // a new lib module is covered the moment it is written.
    const modules = readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js'));

    test('lib/ is non-empty (guard against a no-op test)', () => {
        assert.ok(modules.length > 0, 'no lib/*.js found — has lib/ moved?');
    });

    for (const file of modules) {
        const mod = `lib/${file}`;
        test(`${mod} imports nothing outside lib/ or node_modules`, () => {
            const bad = relativeImports(read(mod)).filter(s => s.includes('..'));
            assert.deepEqual(bad, [],
                `${mod} reaches outside lib/ (${bad.join(', ')}); those files are not ` +
                `guaranteed to be in the backend image.`);
        });
    }
});

// --- Frontend build contract (audit F-029) --------------------------------
//
// index.html now loads chart.js and qrcodejs from OUR origin instead of
// jsDelivr/cdnjs. That only holds if three things stay in agreement:
// the <script src> paths, what tools/vendor-assets.mjs writes, and the npm
// deps the copies come from. Any one drifting silently re-breaks it — either
// a 404'd script (charts vanish) or a quiet return to CDN script execution on
// the same origin as signAndSend.
describe('vendored browser scripts (F-029)', () => {
    const html = read('index.html');
    const vendorScript = read('tools/vendor-assets.mjs');
    const pkg = JSON.parse(read('package.json'));

    // <script src="..."> only — stylesheets and preconnects are a separate,
    // non-executable concern tracked under F-039.
    const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map(m => m[1]);

    test('index.html loads no executable script from a third-party origin', () => {
        const remote = scriptSrcs.filter(s => /^(https?:)?\/\//.test(s));
        assert.deepEqual(remote, [],
            `index.html loads script(s) from another origin: ${remote.join(', ')}. ` +
            `Anything here runs with the same privileges as the wallet's signAndSend. ` +
            `Add it to tools/vendor-assets.mjs and reference /vendor/... instead.`);
    });

    test('index.html loads no stylesheet or font from a third-party origin (F-039)', () => {
        // The CSP says default-src 'self'; a re-introduced external
        // stylesheet would not be an aesthetic regression, it would be a
        // BLANK PAGE — the browser refuses to load it.
        const links = [...html.matchAll(/<link[^>]*\shref=["']([^"']+)["']/g)].map(m => m[1]);
        const remote = links.filter(h => /^(https?:)?\/\//.test(h) && !h.startsWith('https://explorer.polkadex.ee'));
        assert.deepEqual(remote, [],
            `index.html links to another origin: ${remote.join(', ')} — the CSP will block it.`);
    });

    test('the nginx CSP exists in BOTH server blocks and allows the chain RPC (F-039, F-041)', () => {
        const conf = read('nginx.conf');
        const csps = [...conf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map(m => m[1]);
        assert.equal(csps.length, 2,
            `expected the CSP on both server blocks (:8080 serves content on the Cloudflare Flexible path — F-041), found ${csps.length}`);
        for (const policy of csps) {
            assert.match(policy, /script-src 'self'/, 'script-src must stay self-only — that is the wallet protection');
            assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy), "script-src gained 'unsafe-inline', which defeats the policy");
            // 'unsafe-eval' reopens JS eval; only the wasm-scoped keyword is
            // acceptable, and it is REQUIRED — @polkadot/wasm-crypto compiles
            // WASM for signing, and without it the CSP breaks the wallet.
            assert.ok(!/script-src[^;]*'unsafe-eval'/.test(policy), "script-src gained 'unsafe-eval' — use 'wasm-unsafe-eval' only");
            assert.match(policy, /script-src[^;]*'wasm-unsafe-eval'/, "script-src lost 'wasm-unsafe-eval' — @polkadot signing WASM will be blocked");
            // The SPA dials the chain directly; dropping this blanks the wallet.
            assert.match(policy, /connect-src[^;]*wss:\/\/rpc\.polkadex\.ee/, 'connect-src must allow wss://rpc.polkadex.ee or the wallet goes dark');
            // qrcodejs renders the donate QR into a data: image.
            assert.match(policy, /img-src[^;]*data:/, 'img-src needs data: for the donate-page QR code');
        }
        assert.equal(csps[0], csps[1], 'the two server blocks have drifted apart — F-041 is how that starts');
    });

    test('no inline event handlers remain in index.html (CSP script-src blocks them)', () => {
        const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*["']/g)];
        assert.deepEqual(handlers.map(h => h[0]), [],
            'an inline on*= handler is back in index.html — script-src self silently disables it');
    });

    test('every /vendor/ script tag is produced by tools/vendor-assets.mjs', () => {
        const vendored = scriptSrcs.filter(s => s.startsWith('/vendor/'));
        assert.ok(vendored.length > 0, 'expected at least one /vendor/ script tag');
        for (const src of vendored) {
            const dest = `public${src}`;                        // public/vendor/chart.umd.js
            assert.ok(vendorScript.includes(dest),
                `index.html loads '${src}' but tools/vendor-assets.mjs never writes ` +
                `'${dest}'. nginx will return 404 for it and the feature that needs ` +
                `it (chart or QR code) fails silently.`);
        }
    });

    test('every asset the vendor script copies comes from a declared dependency', () => {
        // Copying from a package that is not in package.json means `npm ci` in
        // the frontend image does not install it, so the build fails — or
        // worse, succeeds against a stale node_modules on someone's laptop.
        const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const sources = [...vendorScript.matchAll(/from:\s*'node_modules\/((?:@[^/]+\/)?[^/']+)\//g)].map(m => m[1]);
        assert.ok(sources.length > 0, 'parser found no node_modules sources — regex probably broke');
        for (const name of sources) {
            assert.ok(Object.prototype.hasOwnProperty.call(declared, name),
                `tools/vendor-assets.mjs copies from node_modules/${name} but ` +
                `'${name}' is not in package.json.`);
        }
    });

    test('vendored packages are pinned to exact versions', () => {
        // The original finding was an UNVERSIONED CDN URL. A caret range here
        // would reintroduce the same problem with extra steps.
        const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const sources = [...vendorScript.matchAll(/from:\s*'node_modules\/((?:@[^/]+\/)?[^/']+)\//g)].map(m => m[1]);
        // Without this the loop below can iterate zero times and pass green if
        // the regex above ever stops matching.
        assert.ok(sources.length > 0, 'parser found no node_modules sources — regex probably broke');
        for (const name of sources) {
            // Fully anchored: '4.5.1 || 5.0.0' and '4.5.1-beta' are not pins.
            assert.match(declared[name], /^\d+\.\d+\.\d+$/,
                `'${name}' is pinned as '${declared[name]}' — use an exact version so ` +
                `the bytes served from our origin are reproducible.`);
        }
    });

    test('the build runs the vendor step automatically', () => {
        // If `prebuild` is dropped, `vite build` still succeeds and ships an
        // index.html pointing at /vendor/ files that were never created.
        const scripts = pkg.scripts || {};
        const runsVendor = /vendor/.test(scripts.prebuild || '') || /vendor/.test(scripts.build || '');
        assert.ok(runsVendor,
            'neither the `prebuild` nor the `build` script runs the vendor step, so a ' +
            'clean checkout would build an index.html referencing missing /vendor/ files.');
    });

    test('both nginx server blocks serve /vendor/ with try_files =404', () => {
        // Falling through to index.html would return HTML with a JS
        // content-type: a console syntax error and no charts, rather than an
        // obvious 404. Both server blocks need it — :8443 is the normal path,
        // :8080 serves content on Cloudflare's Flexible-SSL path.
        //
        // Matched on the location PATTERN, not on "the chunk mentions
        // /vendor/": splitting on `location` makes each chunk run to the next
        // one, so a comment about /vendor/ inside the /assets/ block used to
        // satisfy this via /assets/'s own try_files.
        const conf = read('nginx.conf');
        const blocks = [...conf.matchAll(/location\s+([^\s{]+(?:\s+[^\s{]+)?)\s*\{([^}]*)\}/g)]
            .filter(m => m[1].includes('/vendor/'));
        assert.equal(blocks.length, 2,
            `expected a /vendor/ location in both server blocks, found ${blocks.length}`);
        for (const [, pattern, body] of blocks) {
            assert.match(body, /try_files\s+\$uri\s+=404/,
                `the '${pattern}' location is missing try_files $uri =404`);
        }
    });

    test('the /vendor/ location is not restricted to .js', () => {
        // chart.umd.js ends with //# sourceMappingURL=chart.umd.js.map and the
        // map is not vendored. A `\.js$`-anchored pattern lets that request
        // fall through to the SPA and answer 200 + HTML — the exact failure the
        // location exists to prevent, just one file extension over.
        const conf = read('nginx.conf');
        const patterns = [...conf.matchAll(/location\s+([^\s{]+(?:\s+[^\s{]+)?)\s*\{/g)]
            .map(m => m[1]).filter(p => p.includes('/vendor/'));
        for (const p of patterns) {
            assert.ok(!/\\?\.js\$/.test(p),
                `'${p}' only matches .js, so /vendor/*.map falls through to the SPA fallback`);
        }
    });
});
