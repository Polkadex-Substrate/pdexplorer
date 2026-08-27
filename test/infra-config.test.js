// Config-file invariants that no unit test can see and no code review reliably
// catches, because each one lives in the gap between two files that have to
// agree. Same pattern (and same reason) as test/dockerfile-copy.test.js: parse
// the config, parse the thing it must agree with, assert they still do.
//
// Covers audit F-096 (certbot compose service), F-143 (nginx and the developer
// API) and F-147 (the --experimental-sqlite pin).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// --- F-096: the certbot service ---------------------------------------------
//
// Two independent defects, both of which only show up at the worst possible
// moment: the renew loop silently not running (cert expiry, ~60-90 days later)
// and `certonly` silently not running (initial issuance or a domain move).
describe('certbot compose service (F-096)', () => {
    const compose = read('docker-compose.yml');

    // Crude but sufficient: split the file into per-service chunks by
    // indentation so an assertion about `certbot:` cannot be satisfied by a
    // line that belongs to `backend:`.
    function serviceBlock(name) {
        const m = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9_-]+:\\n|$)`));
        assert.ok(m, `no '${name}:' service found in docker-compose.yml`);
        return m[1];
    }

    test('every long-running service declares a restart policy', () => {
        // Compose's default is `no`. backend and frontend already had one; the
        // finding is that certbot did not, so it is asserted as a class rather
        // than for certbot alone — the next service added inherits the guard.
        for (const svc of ['backend', 'frontend', 'certbot']) {
            assert.match(serviceBlock(svc), /^\s*restart:\s*unless-stopped\s*$/m,
                `service '${svc}' has no 'restart: unless-stopped'. Compose defaults to ` +
                `'no', so if this container ever dies — OOM, host reboot, a stray ` +
                `docker restart — nothing brings it back and nothing says so.`);
        }
    });

    test('the certbot entrypoint execs certbot when it is given arguments', () => {
        // The image's own ENTRYPOINT is `certbot`, which is what makes every
        // `docker compose run certbot certonly ...` recipe on the internet work.
        // Replacing it with a bare renew loop drops those arguments on the floor
        // and runs the 12-hour loop instead: it hangs rather than failing, which
        // is why it costs an hour to diagnose the first time.
        const block = serviceBlock('certbot');
        assert.match(block, /exec certbot "\$\$@"/,
            "the certbot entrypoint no longer execs certbot with the container's arguments — " +
            '`docker compose run certbot certonly ...` will silently run the renew loop instead.');
        assert.match(block, /\[\s*"\$\$#"\s*-gt\s*0\s*\]/,
            'the entrypoint no longer branches on whether arguments were passed, so it cannot be both ' +
            'the renew service and a way to reach certbot.');
    });

    test('the certbot entrypoint still runs the renew loop with no arguments', () => {
        // The other half: making `run` work must not cost us automatic renewal.
        const block = serviceBlock('certbot');
        assert.match(block, /certbot renew/, 'the unattended renew loop is gone — certificates will expire');
        assert.match(block, /sleep 12h/, 'the renew loop lost its sleep; a hot loop will hit Let\'s Encrypt rate limits');
    });

    test('literal shell $ in the entrypoint is escaped as $$ for Compose', () => {
        // Compose interpolates `$VAR` itself. A single `$` here would be
        // substituted (to an empty string) before the shell ever sees it, which
        // turns the argument dispatch above into "always run the loop" — the
        // exact bug, restored, with the fix still visibly in the file.
        // Scoped to the entrypoint itself: `${CERTBOT_PATH:-./certbot}` in the
        // volumes above is a genuine Compose variable and must stay single-$.
        const block = serviceBlock('certbot');
        const ep = block.slice(block.indexOf('entrypoint:'));
        assert.ok(ep.startsWith('entrypoint:'), 'no entrypoint: key in the certbot service');
        for (const tok of ['$$#', '$$@', '$${!}']) {
            assert.ok(ep.includes(tok), `the certbot entrypoint no longer contains '${tok}'`);
        }
        const leftovers = ep.replace(/\$\$/g, '');
        assert.ok(!leftovers.includes('$'),
            'a single unescaped $ remains in the certbot entrypoint — Compose will substitute it away ' +
            '(to an empty string) before the shell sees it, which quietly restores the bug.');
    });

    test('the docs no longer tell operators to override the entrypoint', () => {
        // A stale `--entrypoint certbot` still works, but it documents the bug
        // as if it were the design and teaches the next operator the workaround.
        for (const f of ['INSTALL.md', 'provision-ubuntu.sh']) {
            assert.ok(!/--entrypoint\s+certbot/.test(read(f)),
                `${f} still instructs an --entrypoint certbot override; F-096 removed the need for it.`);
        }
    });
});

// --- F-143: gzip and timeouts on the developer API --------------------------
describe('nginx developer-API locations (F-143)', () => {
    const conf = read('nginx.conf');
    const server = read('server.js');

    // Every `location <pattern> { ... }` in the file, no nesting involved.
    const locations = [...conf.matchAll(/location\s+([^\s{]+(?:\s+[^\s{]+)?)\s*\{([^}]*)\}/g)]
        .map(m => ({ pattern: m[1].trim(), body: m[2] }));

    // The backend's own deadline for a dev-API RPC call. Read, never guessed:
    // the whole point of the assertion is that these two numbers are one
    // deadline expressed in two files.
    const devTimeoutMs = (() => {
        const m = server.match(/const\s+DEV_API_TIMEOUT_MS\s*=\s*readPositiveInteger\(process\.env\.DEV_API_TIMEOUT_MS,\s*(\d+)\)/);
        assert.ok(m, 'could not find DEV_API_TIMEOUT_MS in server.js — this test cannot verify anything without it');
        return parseInt(m[1], 10);
    })();

    test('global gzip still covers application/json (guard against a vacuous test)', () => {
        // If gzip_types ever stops listing application/json the assertions below
        // are about nothing, and would pass green while proving nothing.
        assert.match(conf, /gzip on;/);
        assert.match(conf, /gzip_types[\s\S]*?application\/json/);
    });

    for (const prefix of ['/api/state/', '/api/decode/']) {
        test(`${prefix} has its own location in BOTH server blocks`, () => {
            // :8443 is the normal path; :8080 serves real content on the
            // Cloudflare Flexible-SSL path (F-041), so a fix applied to one
            // block only is a fix that is off half the time.
            const matched = locations.filter(l => l.pattern.endsWith(prefix));
            assert.equal(matched.length, 2,
                `expected a '${prefix}' location in both the :8080 and :8443 server blocks, found ${matched.length}`);
        });

        test(`${prefix} disables gzip`, () => {
            for (const l of locations.filter(l => l.pattern.endsWith(prefix))) {
                assert.match(l.body, /^\s*gzip off;\s*$/m,
                    `'${l.pattern}' still gzips. These responses are megabyte-scale, uncacheable and ` +
                    `read by a handful of developers, but the CPU spent compressing them comes out of ` +
                    `the nginx worker that is serving everyone else.`);
            }
        });

        test(`${prefix} proxy_read_timeout is the OUTER bound on DEV_API_TIMEOUT_MS (${devTimeoutMs}ms)`, () => {
            // This used to assert strict EQUALITY. A review pointed out that
            // equal is a race, not a match: DEV_API_TIMEOUT_MS bounds only the
            // RPC call inside withTimeout, and serialising a megabyte
            // /api/decode payload happens after that. A request whose RPC lands
            // at 19.9s would lose the race and the caller would get nginx's
            // opaque 504 instead of the backend's own JSON — the exact failure
            // the equality was meant to prevent, caused by the equality.
            //
            // So: strictly greater, with a ceiling so it cannot drift back
            // toward nginx's 60s default and pin worker connections open.
            const MAX_SLACK_MS = 30_000;
            for (const l of locations.filter(l => l.pattern.endsWith(prefix))) {
                const m = l.body.match(/proxy_read_timeout\s+(\d+)(m?s);/);
                assert.ok(m, `'${l.pattern}' has no proxy_read_timeout, so it keeps nginx's 60s default — ` +
                    `three times as long as the backend will ever work on the request.`);
                const ms = m[2] === 'ms' ? parseInt(m[1], 10) : parseInt(m[1], 10) * 1000;
                assert.ok(ms > devTimeoutMs,
                    `'${l.pattern}' waits ${ms}ms and server.js gives up at ${devTimeoutMs}ms. nginx must be ` +
                    `the OUTER deadline, or a slow-but-successful request is cut off by the proxy and the ` +
                    `caller gets a 504 instead of the backend's JSON error.`);
                assert.ok(ms <= devTimeoutMs + MAX_SLACK_MS,
                    `'${l.pattern}' waits ${ms}ms, ${ms - devTimeoutMs}ms past the backend's own deadline. ` +
                    `That is a worker connection pinned open for nothing.`);
            }
        });

        test(`${prefix} uses ^~ so a future regex location cannot steal it`, () => {
            for (const l of locations.filter(l => l.pattern.endsWith(prefix))) {
                assert.ok(l.pattern.startsWith('^~'),
                    `'${l.pattern}' is a plain prefix match. nginx tries regex locations before settling ` +
                    `on a prefix, so a regex added later would silently take these requests and the gzip/timeout ` +
                    `settings with them.`);
            }
        });
    }

    test('the generic /api/ location is left compressed', () => {
        // Deliberate scope limit, asserted so it is a decision and not a
        // leftover: the SPA's small JSON responses benefit from gzip, and
        // turning it off for all of /api/ would be a bandwidth regression on
        // every page load.
        const generic = locations.filter(l => l.pattern === '/api/');
        assert.equal(generic.length, 2);
        for (const l of generic) {
            assert.ok(!/gzip off;/.test(l.body),
                'gzip was disabled for the whole /api/ prefix; F-143 is about two large developer endpoints, ' +
                'not about the SPA\'s own JSON.');
        }
    });
});

// --- F-147: node:sqlite needs the flag on the pinned image ------------------
describe('--experimental-sqlite is present everywhere it is load-bearing (F-147)', () => {
    const dockerfile = read('Dockerfile.backend');
    const pkg = JSON.parse(read('package.json'));
    const dbjs = read('db.js');

    const nodeTag = (() => {
        const m = dockerfile.match(/^FROM\s+node:([^\s@]+)/m);
        assert.ok(m, 'could not parse the FROM line in Dockerfile.backend');
        return m[1];                       // e.g. 22.11-alpine
    })();

    test('db.js imports node:sqlite at the TOP LEVEL (so the flag is fatal, not cosmetic)', () => {
        // This is why the flag matters at all. A lazy/conditional import would
        // make a missing flag a degraded feature; a top-level one makes it a
        // container that never starts while nginx keeps serving the SPA.
        assert.match(dbjs, /^import\s+\{\s*DatabaseSync\s*\}\s+from\s+'node:sqlite';/m,
            'db.js no longer imports node:sqlite at the top level — re-check whether this whole finding still applies.');
    });

    test('the backend image is still pinned to Node 22', () => {
        const major = parseInt(nodeTag.split('.')[0], 10);
        assert.equal(major, 22,
            `Dockerfile.backend now builds on Node ${major}. That is not a config change: @polkadot/api is ` +
            `pinned to exactly 10.13.1 with a hand-declared CheckMetadataHash signed extension, and wallet ` +
            `signing correctness depends on that pair. Re-qualify signing before changing this, and update ` +
            `the F-147 comment above CMD and the L-3 status note in SECURITY_AUDIT.md.`);
    });

    test('the Dockerfile CMD carries the flag', () => {
        const cmd = dockerfile.match(/^CMD\s+(\[.*\])\s*$/m);
        assert.ok(cmd, 'no CMD found in Dockerfile.backend');
        assert.ok(JSON.parse(cmd[1]).includes('--experimental-sqlite'),
            `node:${nodeTag} refuses to import node:sqlite without --experimental-sqlite. Without it the ` +
            `container crash-loops on ERR_UNKNOWN_BUILTIN_MODULE, every /api/* route goes dark, and nginx ` +
            `keeps serving the SPA — so it looks like "the API is broken", not "the flag is missing".`);
    });

    test('the npm entrypoints carry the flag too', () => {
        // `npm start` is how the backend runs outside Docker (bare-metal
        // installs, and the README's local dev instructions). Dropping the flag
        // here breaks exactly those paths, which is how it survives review.
        for (const name of ['start', 'server']) {
            assert.ok((pkg.scripts[name] || '').includes('--experimental-sqlite'),
                `package.json script '${name}' lost --experimental-sqlite; it will fail on Node ${nodeTag}.`);
        }
    });

    test('the Dockerfile comment names the version it is making a claim about', () => {
        // "Documented accurately" is the close test. The comment asserts
        // something about a specific Node version, so it has to name the version
        // actually pinned — otherwise a bump leaves a confident, wrong comment.
        const version = nodeTag.replace(/-.*$/, '');       // 22.11-alpine -> 22.11
        // Only the comment block IMMEDIATELY above CMD counts. Scanning the
        // whole file would let the unrelated F-150 digest-pinning comment at the
        // top satisfy this, and the F-147 rationale could then go stale unnoticed.
        const before = dockerfile.slice(0, dockerfile.search(/^CMD /m)).split('\n');
        const commentLines = [];
        for (let i = before.length - 1; i >= 0 && (before[i].startsWith('#') || before[i].trim() === ''); i--) {
            if (before[i].trim() === '' && commentLines.length) break;
            if (before[i].startsWith('#')) commentLines.unshift(before[i]);
        }
        const commentBlock = commentLines.join('\n');
        assert.ok(commentBlock.includes('F-147'),
            'the F-147 rationale directly above CMD is gone; the next person will read the flag as cargo cult and remove it.');
        assert.ok(new RegExp(`\\b${version.replace(/\./g, '\\.')}\\b`).test(commentBlock),
            `the comment above CMD does not mention ${version}, the version actually pinned in FROM. ` +
            `It makes a claim about which Node needs the flag, so it has to name the Node we ship.`);
    });

    test('SECURITY_AUDIT.md L-3 records the decision instead of leaving it open', () => {
        const audit = read('SECURITY_AUDIT.md');
        const l3 = audit.slice(audit.indexOf('### LOW L-3'), audit.indexOf('### INFO I-1'));
        assert.ok(l3.length > 0, 'could not locate the L-3 section in SECURITY_AUDIT.md');
        assert.match(l3, /accepted risk/i,
            'L-3 still reads as an open question. F-147 closes it either way; the file has to say which way.');
        assert.match(l3, /F-147/, 'the L-3 status note does not reference F-147');
    });
});
