// Audit F-103 / F-151 / F-109 / F-150 / F-167 / F-168.
//
// Dependency and deployment-config assertions. `npm audit` is not run from here
// — it needs the network and would make the suite flaky and slow — so instead
// the LOCKFILE is asserted directly, which is the artefact that actually ships
// and the thing a `npm ci` in Docker will install.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg  = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const nginxSrc   = read('nginx.conf');
const composeSrc = read('docker-compose.yml');
const provision  = read('provision-ubuntu.sh');
const htmlSrc    = read('index.html');
const dockerBack = read('Dockerfile.backend');
const dockerFront= read('Dockerfile.frontend');

// Every resolved version of `name` in the lockfile.
function lockedVersions(name) {
    const out = [];
    for (const [path, meta] of Object.entries(lock.packages || {})) {
        if (!meta || !meta.version) continue;
        if (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) {
            out.push(meta.version);
        }
    }
    return out;
}

// Compare dotted versions numerically. "8.9.0" must not sort above "8.21.3".
function gte(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return true;
}

describe('F-103 — the production tree has no known-vulnerable ws', () => {
    test('every resolved ws is >= 8.21.3', () => {
        const versions = lockedVersions('ws');
        assert.ok(versions.length > 0, 'ws vanished from the lockfile — did the tree change?');
        for (const v of versions) {
            assert.ok(gte(v, '8.21.3'),
                `ws ${v} is in the lockfile; GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure) needs >= 8.21.3`);
        }
    });

    test('the override that pins it is still declared', () => {
        // ws is transitive via @polkadot/api → rpc-provider → x-ws. Without an
        // override, a lockfile regeneration silently reverts to 8.20.0.
        assert.ok(pkg.overrides, 'package.json has no overrides block');
        // A review catch: these were unbounded `>=` ranges, and npm happily
        // crossed a MAJOR — nanoid resolved to 6.0.1, which is ESM-only, while
        // postcss does `require('nanoid/non-secure')`. Node 22.11 (the image
        // Node) predates require(esm) being on by default, so the FRONTEND
        // DOCKER BUILD died. It passed locally only because this machine runs
        // Node 22.23. Caret-bound every override.
        assert.equal(pkg.overrides.ws, '^8.21.3');
        for (const [name, range] of Object.entries(pkg.overrides)) {
            assert.match(range, /^\^/,
                `override "${name}": "${range}" is unbounded — npm can cross a major version and break the build`);
        }
    });

    test('@polkadot/api is STILL pinned to exactly 10.13.1', () => {
        // The whole point of fixing ws by override rather than by upgrade.
        // 10.13.1 + the manual CheckMetadataHash signed extension is what makes
        // wallet signing work at all; `npm audit fix --force` would have moved
        // it and broken every signed extrinsic.
        assert.equal(pkg.dependencies['@polkadot/api'], '10.13.1');
        assert.deepEqual(lockedVersions('@polkadot/api'), ['10.13.1']);
    });
});

describe('F-151 — the build-time highs are gone too', () => {
    test('vite is >= 6.4.3', () => {
        for (const v of lockedVersions('vite')) {
            assert.ok(gte(v, '6.4.3'), `vite ${v} still carries the advisory`);
        }
    });

    test('vite stayed on 6.x — a major bump is a separate decision', () => {
        // 8.x is available. Taking it to close a LOW build-time advisory would
        // risk the one thing this repo cannot afford to break silently, which
        // is the bundle that signs transactions.
        assert.match(pkg.devDependencies.vite, /^6\./,
            'vite crossed a major version; re-verify the built bundle signs correctly before accepting this');
    });

    test('nanoid and postcss are overridden to patched versions', () => {
        assert.ok(gte(pkg.overrides.nanoid.replace('^', ''), '3.3.18'));
        assert.ok(gte(pkg.overrides.postcss.replace('^', ''), '8.5.23'));
        for (const v of lockedVersions('nanoid')) {
            assert.ok(gte(v, '3.3.18'), `nanoid ${v}`);
            // The blocker: nanoid 4+ is ESM-only and postcss requires it with
            // CJS `require()`, which Node 22.11 cannot do. `gte` alone was
            // happy with 6.0.1 — it asserted the broken state.
            assert.match(v, /^3\./,
                `nanoid ${v} crossed a major; postcss require()s it and the Node 22.11 image cannot load ESM that way`);
        }
        for (const v of lockedVersions('postcss')) {
            assert.match(v, /^8\./, `postcss ${v} crossed a major`);
        }
    });

    test('body-parser and qs are patched', () => {
        for (const v of lockedVersions('body-parser')) {
            assert.ok(gte(v, '2.3.0'), `body-parser ${v}`);
        }
        for (const v of lockedVersions('qs')) {
            assert.ok(gte(v, '6.15.2'), `qs ${v}`);
        }
    });
});

describe('F-109 — one Cloudflare IP list, not two', () => {
    test('provisioning writes the nginx snippet from the same fetch as UFW', () => {
        const phase = provision.slice(provision.indexOf('local cf_dir=/etc/cloudflare'));
        const fetchAt = phase.indexOf('cloudflare.com/ips-v4');
        const genAt = phase.indexOf('nginx-real-ip.conf');
        assert.ok(fetchAt !== -1 && genAt !== -1, 'the snippet generator is gone');
        assert.ok(fetchAt < genAt, 'the snippet must be generated from the fetched files');
        assert.match(phase, /echo "set_real_ip_from \$cidr;"/);
    });

    test('it reads BOTH the v4 and v6 lists', () => {
        const gen = provision.slice(
            provision.indexOf('Generating the nginx real-IP snippet'),
            provision.indexOf('Replacing generic UFW 80/443 rules')
        );
        assert.match(gen, /ips-v4/);
        assert.match(gen, /ips-v6/, 'IPv6 Cloudflare ranges would be untrusted');
    });

    test('the WEEKLY refresh regenerates it too, not just the one-shot phase', () => {
        // A review catch, and the one that mattered: the provisioning phase
        // runs once, on day one. The `cloudflare-ufw-refresh` script installed
        // by it is the ONLY thing that runs afterwards — and its first version
        // re-fetched both lists, rewrote UFW and DOCKER-USER, and never touched
        // nginx-real-ip.conf. So the exact drift F-109 describes survived on
        // the automated path, which is the only path that matters after setup.
        //
        // Whatever regenerates one list must regenerate both.
        // Scope to the heredoc that BECOMES the weekly script, so the one-shot
        // provisioning generator earlier in the file cannot satisfy this.
        const start = provision.indexOf("cat >/usr/local/sbin/cloudflare-ufw-refresh <<'EOF'");
        assert.ok(start !== -1, 'the refresh script heredoc is gone');
        const refresh = provision.slice(start, provision.indexOf('\nEOF', start));
        assert.ok(refresh.length > 0);

        // The whole pipeline, not just the strings appearing somewhere. A
        // mutation that redirected the generator to /dev/null while leaving the
        // echo lines in place used to pass every assertion here.
        assert.match(refresh, /\} > "\$cf_dir\/nginx-real-ip\.conf\.new"/,
            'the generator no longer writes to the snippet file');
        assert.match(refresh, /mv "\$cf_dir\/nginx-real-ip\.conf\.new" "\$cf_dir\/nginx-real-ip\.conf"/,
            'the new file is never moved into place — nginx keeps reading the old one');
        assert.match(refresh, /docker exec pdexplorer-frontend nginx -s reload/,
            'a regenerated file that nginx never reloads changes nothing until the next restart');

        // And that the write is atomic: writing in place would let nginx read a
        // half-written config if a reload raced the generator.
        const writeAt = refresh.indexOf('nginx-real-ip.conf.new"');
        const mvAt = refresh.indexOf('mv "$cf_dir/nginx-real-ip.conf.new"');
        const reloadAt = refresh.indexOf('nginx -s reload');
        assert.ok(writeAt < mvAt && mvAt < reloadAt,
            'write → atomic move → reload, in that order');
    });

    test('both generators write the same directive from the same two files', () => {
        // Two copies of this loop is itself a drift risk; pin that they agree.
        const writes = provision.match(/echo "set_real_ip_from \$cidr;"/g) || [];
        assert.equal(writes.length, 4,
            `expected 4 set_real_ip_from emitters (v4+v6 × one-shot+refresh), found ${writes.length}`);
        // Both generators must read BOTH address families.
        const start = provision.indexOf("cat >/usr/local/sbin/cloudflare-ufw-refresh <<'EOF'");
        const refresh = provision.slice(start, provision.indexOf('\nEOF', start));
        const oneShot = provision.slice(
            provision.indexOf('Generating the nginx real-IP snippet'), start);
        for (const [name, block] of [['weekly refresh', refresh], ['one-shot phase', oneShot]]) {
            assert.equal((block.match(/echo "set_real_ip_from \$cidr;"/g) || []).length, 2,
                `the ${name} generator does not emit for both ips-v4 and ips-v6`);
        }
    });

    test('nginx includes the generated snippet', () => {
        assert.match(nginxSrc, /include \/etc\/nginx\/cloudflare\/\*\.conf;/);
    });

    test('the include is a WILDCARD, so an unprovisioned host still boots', () => {
        // nginx treats a missing explicit include as a fatal config error. A
        // wildcard that matches nothing is fine. Getting this wrong means a
        // fresh host fails to start nginx at all — Cloudflare 521, whole site
        // down, from a fix meant to improve rate limiting.
        // The DIRECTIVE, not the comment above it that names the same path.
        const line = nginxSrc.split('\n')
            .find(l => l.trim().startsWith('include') && l.includes('/etc/nginx/cloudflare'));
        assert.ok(line, 'the include directive is gone');
        assert.ok(line.includes('*'), 'a non-wildcard include is fatal when the file is absent');
    });

    test('the literal fallback list is kept', () => {
        // Belt and braces: the mounted file can only ADD ranges.
        const count = (nginxSrc.match(/^set_real_ip_from /gm) || []).length;
        assert.ok(count >= 20, `only ${count} literal ranges remain — the fallback was gutted`);
    });

    test('compose mounts the directory read-only', () => {
        assert.match(composeSrc, /\$\{CLOUDFLARE_IPS_PATH:-\/etc\/cloudflare\}:\/etc\/nginx\/cloudflare:ro/);
    });

    test('the docs no longer claim nginx needs an image rebuild to refresh', () => {
        assert.ok(!/does NOT update this baked-in nginx list/.test(nginxSrc),
            'the stale instruction survives and will send someone rebuilding an image for nothing');
    });
});

describe('F-150 — image pinning', () => {
    // Cannot be CLOSED here: resolving a digest needs registry access. What can
    // be asserted is that the requirement is still documented at the exact line
    // someone would edit, rather than quietly dropped.
    test('both Dockerfiles still carry the digest-pinning instruction', () => {
        for (const [name, src] of [['Dockerfile.backend', dockerBack], ['Dockerfile.frontend', dockerFront]]) {
            assert.match(src, /F-150/, `${name} lost the digest-pinning note`);
            assert.match(src, /sha256/, `${name} no longer shows the digest form`);
        }
    });

    test('the base images are still the expected ones', () => {
        assert.match(dockerBack, /^FROM node:22\.11-alpine/m);
        assert.match(dockerFront, /^FROM nginxinc\/nginx-unprivileged:1\.27-alpine/m);
    });
});

describe('F-167 — no feed link that is not a feed', () => {
    test('nothing advertises an RSS feed', () => {
        const code = htmlSrc.split('\n').filter(l => !l.trim().startsWith('<!--')).join('\n');
        assert.ok(!/rel="alternate"[^>]*application\/rss\+xml/.test(code),
            'an RSS alternate link is back; it must point at a real feed or not exist');
    });
});

describe('F-168 — the PWA claim matches what is shipped', () => {
    test('there is still no service worker', () => {
        // If one is ever added it must be same-origin and reviewed against the
        // CSP — a stale cached bundle that can sign transactions is a bad
        // failure mode on a wallet origin.
        assert.ok(!/serviceWorker\.register/.test(read('script.js')),
            'a service worker was registered — re-read F-168 and the CSP before shipping it');
    });

    test('the manifest claims installability, not offline use', () => {
        const manifest = JSON.parse(read('public/manifest.webmanifest'));
        assert.equal(manifest.display, 'standalone');
        assert.ok(!/offline/i.test(JSON.stringify(manifest)),
            'the manifest promises offline capability that no service worker delivers');
    });

    test('the reasoning is recorded next to the meta tags', () => {
        assert.match(htmlSrc, /F-168/,
            'the "installable, not offline-capable" decision must stay written down');
    });
});
