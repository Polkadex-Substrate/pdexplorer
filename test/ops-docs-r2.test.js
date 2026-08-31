// Round-2 operator findings that live in the gap between config files, shell
// scripts and prose: F-189 (one cert path), F-190 (README's origin-TLS story),
// F-191 (the env template names every knob), F-192 (`all` vs `all+cf`) and
// F-193 (the diagnostics token is header-only).
//
// Same pattern and same reason as test/infra-config.test.js and
// test/cert-perms.test.js: each of these bugs is invisible to every unit test,
// because each file is individually self-consistent and the defect is that two
// files disagree. Parse both, assert they still agree.
//
// Every "must not contain" check below runs against COMMENT-STRIPPED source.
// This repo has repeatedly shipped a guard that passed by matching its own
// explanatory comment; the comments here quote the banned strings on purpose.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// `#`-comment stripper for shell / YAML / env files.
const shCode = (src) => src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
// `//`-comment stripper for JS. Line comments first, then block comments only
// where `/*` opens a line: prose such as "the /api/diag/* endpoints" contains a
// `/*` that a naive block stripper pairs with the next genuine `*/`, deleting
// hundreds of lines of code and turning every assertion below into a tautology.
const jsCode = (src) => src.split('\n')
    .map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

const compose     = read('docker-compose.yml');
const deploySh    = read('deploy.sh');
const provision   = read('provision-ubuntu.sh');
const nginxConf   = read('nginx.conf');
const envExample  = read('.env.example');
const readme      = read('README.md');
const install     = read('INSTALL.md');
const serverJs    = read('server.js');

const deployCode    = shCode(deploySh);
const provisionCode = shCode(provision);
const serverCode    = jsCode(serverJs);

// Every knob .env.example names. Commented-out `# KEY=value` lines count —
// that is how this file documents optional settings — so the pattern accepts
// an optional leading `#`.
const documentedEnvNames = new Set(
    [...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/gm)].map(m => m[1])
);

// ─── F-189: compose, deploy, provision and nginx share one cert tree ─────────
//
// The live shape of this bug on the production host: CERTBOT_PATH is
// /opt/pdexplorer/certbot, the key is at
// /opt/pdexplorer/certbot/conf/live/explorer.polkadex.ee/privkey.pem, and there
// is NO /etc/letsencrypt on the host at all — that path exists only inside the
// frontend container, on the other side of the bind mount.
describe('one cert path from .env to nginx (F-189)', () => {
    test('compose still mounts ${CERTBOT_PATH}/conf onto /etc/letsencrypt', () => {
        assert.match(compose, /\$\{CERTBOT_PATH:-\.\/certbot\}\/conf:\/etc\/letsencrypt:ro/,
            'the frontend cert mount changed shape — the other three writers below are pinned to it');
        assert.match(compose, /\$\{CERTBOT_PATH:-\.\/certbot\}\/conf:\/etc\/letsencrypt$/m,
            'the certbot service must hold the same tree WRITABLE, or renewal writes somewhere nginx never reads');
    });

    test('deploy.sh reads CERTBOT_PATH out of .env instead of defaulting past it', () => {
        assert.match(deployCode, /CERTBOT_PATH="\$\{CERTBOT_PATH:-\$\(env_value CERTBOT_PATH\)\}"/,
            'deploy.sh no longer reads CERTBOT_PATH from .env. Compose reads it from there; if deploy ' +
            'silently falls back to ./certbot it inspects a different directory, decides no certificate ' +
            'exists, and runs init-letsencrypt.sh — which overwrites the live origin cert with a ' +
            'self-signed placeholder. Cloudflare Full (Strict) then answers 526.');
    });

    test('deploy.sh parses .env rather than sourcing it', () => {
        // .env holds POSTMARK_TOKEN, CMC_API_KEY and DIAG_TOKEN. `. ./.env`
        // executes the file and exports every secret into every child process.
        assert.ok(!/^\s*\.\s+\.\/\.env/m.test(deployCode) && !/^\s*source\s+\.\/?\.env/m.test(deployCode),
            'deploy.sh sources .env — that executes a file full of credentials and leaks them to children');
        assert.match(deployCode, /env_value\(\)/, 'deploy.sh lost its .env parser');
    });

    test('provision-ubuntu.sh honours .env and has no second hard-coded cert tree', () => {
        assert.match(provisionCode, /CERTBOT_PATH="\$\(env_value "\$DEPLOY_DIR\/\.env" CERTBOT_PATH\)"/,
            'provision no longer reads CERTBOT_PATH from the deployment .env');
        // Every writer must go through $CERTBOT_PATH. Exactly ONE mention of
        // the literal $DEPLOY_DIR/certbot is legitimate — the final fallback
        // when neither the environment nor .env supplies a value. Any second
        // one is the third disagreeing writer coming back, so this counts
        // rather than merely forbidding.
        const hardCoded = provisionCode.split('\n').filter(l => l.includes('$DEPLOY_DIR/certbot'));
        assert.deepEqual(hardCoded, ['[ -n "$CERTBOT_PATH" ] || CERTBOT_PATH="$DEPLOY_DIR/certbot"'],
            'provision-ubuntu.sh hard-codes $DEPLOY_DIR/certbot outside the single fallback assignment, ' +
            'ignoring what .env (and therefore compose) says. With a custom CERTBOT_PATH it writes a valid ' +
            'certificate into a directory nothing mounts, prints success, and leaves nginx with an empty ' +
            'cert dir — a 521 with a green provisioning log.');
    });

    test('the Cloudflare Origin cert is installed under $CERTBOT_PATH', () => {
        assert.match(provisionCode, /local dst_dir="\$CERT_LIVE_HOST"/,
            'setup_cf_origin_cert installs somewhere other than the tree compose mounts');
        assert.match(provisionCode, /CERT_LIVE_HOST="\$CERTBOT_PATH\/conf\/live\/\$DOMAIN"/);
    });

    test('provision reconciles the live/<name> nginx.conf opens with $DOMAIN', () => {
        // nginx.conf carries a literal live/<name> baked into the image at
        // build time, so it does not follow $DOMAIN. Without reconciliation a
        // non-default DOMAIN installs its cert where nginx never looks.
        assert.match(provisionCode, /_align_nginx_cert_name/,
            'the nginx live-name reconciliation is gone — a deployment whose DOMAIN differs from the ' +
            'name in nginx.conf installs its certificate into a directory nginx does not open');
        // Derived from nginx.conf, never re-typed: a second copy of the name
        // is a second thing to forget.
        assert.match(provisionCode, /ssl_certificate\[\[:space:\]\]/,
            '_nginx_cert_name no longer parses the name out of nginx.conf');
        const nginxName = /ssl_certificate\s+\/etc\/letsencrypt\/live\/([^/]+)\//.exec(nginxConf);
        assert.ok(nginxName, 'nginx.conf has no ssl_certificate /etc/letsencrypt/live/<name>/ line to parse');
        assert.match(nginxConf, new RegExp(`ssl_certificate_key\\s+/etc/letsencrypt/live/${nginxName[1]}/`),
            'ssl_certificate and ssl_certificate_key name different live/ directories');
    });

    test('host and container cert paths are documented as distinct', () => {
        // "check /etc/letsencrypt" sends an operator to a directory that does
        // not exist on the VPS, and the resulting "No such file or directory"
        // reads exactly like a missing certificate.
        for (const [name, text] of [['nginx.conf', nginxConf], ['docker-compose.yml', compose], ['README.md', readme]]) {
            assert.match(text, /host/i, `${name} does not distinguish the host path`);
            assert.ok(/container/i.test(text), `${name} does not distinguish the container path`);
        }
        assert.match(readme, /no `?\/etc\/letsencrypt`? on the host/i,
            'README no longer states that the host has no /etc/letsencrypt — that sentence is the fix');
    });
});

// ─── F-190: README's production copy matches INSTALL ────────────────────────
describe("README does not promise a Let's Encrypt cert on the default path (F-190)", () => {
    // Prose-only comparison, so strip markdown blockquotes that EXPLAIN the old
    // wording: the correction quotes the sentence it is correcting.
    const readmeBody = readme.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');

    test('the one-liner no longer claims the script issues a Let\'s Encrypt cert', () => {
        assert.ok(!/issues a Let's Encrypt cert/.test(readmeBody),
            'README tells a fresh operator that provision issues a Let\'s Encrypt certificate. On the ' +
            'default orange-cloud path it does not: HTTP-01 cannot reach the origin, so what lands is a ' +
            'self-signed placeholder and Cloudflare Full (Strict) answers 526.');
    });

    test('the fresh-server prerequisite no longer says HTTP-01 issues the cert', () => {
        assert.ok(!/HTTP-01 challenge needs this to issue the cert/.test(readmeBody),
            'the DNS prerequisite still describes HTTP-01 as the issuance path');
    });

    test('README leads with Cloudflare Origin CA for a proxied zone', () => {
        assert.match(readme, /Origin CA/,
            'README never names Cloudflare Origin CA, which is what production actually runs');
        assert.match(readme, /provision-ubuntu\.sh cf-origin-cert/,
            'README does not tell the operator how to install the Origin CA cert');
    });

    test('README and INSTALL agree on the three issuance options', () => {
        for (const [name, text] of [['README.md', readme], ['INSTALL.md', install]]) {
            assert.match(text, /Origin CA|Origin Certificate/, `${name} omits the Origin CA option`);
            assert.match(text, /DNS-01/, `${name} omits the DNS-01 option`);
            assert.match(text, /grey-cloud/i, `${name} omits the grey-cloud option`);
        }
    });

    test('the page-rule bypass is not offered as an option', () => {
        // It was option 3 in README and is fragile enough that following it
        // produces an outage the next time rules are reordered.
        assert.ok(!/^\d\.\s+\*\*Page Rule bypass/m.test(readme),
            'README lists the ACME Page Rule bypass as a numbered option again');
    });
});

// ─── F-191: the env template names every knob the runtime reads ─────────────
describe('.env.example names every env var the product reads (F-191)', () => {
    const RUNTIME_FILES = ['server.js', 'db.js', 'email.js'];
    const LIB = ['lib/rate-limit.js', 'lib/index-status.js', 'lib/gap-scheduling.js'];

    function envNamesIn(files) {
        const names = new Set();
        for (const f of files) {
            for (const m of read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
        }
        return [...names].sort();
    }

    test('every process.env name in the runtime appears in .env.example', () => {
        const missing = envNamesIn([...RUNTIME_FILES, ...LIB]).filter(n => !documentedEnvNames.has(n));
        assert.deepEqual(missing, [],
            'these knobs are readable by the process and invisible to the operator. An env template is ' +
            'the only place anyone looks for "what can I change"; a code-only knob is a knob nobody ' +
            'uses. EVENTS_STRICT (pruned nodes) and AUTH_RATE_LIMIT_PER_MIN (NATed offices locked out ' +
            'of wallet sign-in) are the two that cost real incidents.');
    });

    test('EVENTS_STRICT and AUTH_RATE_LIMIT_PER_MIN are documented with their defaults', () => {
        assert.match(envExample, /^#\s*EVENTS_STRICT=1$/m, "EVENTS_STRICT is not in the template with its code default '1'");
        assert.match(envExample, /^#\s*AUTH_RATE_LIMIT_PER_MIN=60$/m);
    });

    test('the documented WORKERS ceiling is WORKERS_MAX, not a stale literal', () => {
        // server.js clamps with Math.min(n, WORKERS_MAX), default 8. The docs
        // said 16, so WORKERS=16 silently became 8 with nothing logged.
        assert.match(serverCode, /const WORKERS_MAX = readPositiveInteger\(process\.env\.WORKERS_MAX, 8\)/,
            'WORKERS_MAX default changed — the docs assertions below are pinned to it');
        for (const [name, text] of [['.env.example', envExample], ['README.md', readme]]) {
            const prose = text.split('\n').filter(l => !/audit F-191|used to say/i.test(l)).join('\n');
            assert.ok(!/clamped to ≤\s*16/.test(prose),
                `${name} still documents a ≤16 worker clamp. The code clamps to WORKERS_MAX (default 8), ` +
                'silently, so an operator sizing a box from that sentence gets half the workers asked for.');
            assert.match(text, /WORKERS_MAX/, `${name} does not name WORKERS_MAX`);
        }
        assert.match(envExample, /^#\s*WORKERS_MAX=8$/m, '.env.example does not show the WORKERS_MAX default');
    });
});

// ─── F-192: `all` is the Cloudflare-inclusive default ──────────────────────
describe('provision `all` includes Cloudflare; `all+cf` is not a downgrade (F-192)', () => {
    test('all and all+cf run the same function', () => {
        assert.match(provisionCode, /all\|all\+cf\)\s*run_all\s*;;/,
            'all+cf is a separate arm again. It was the pre-F-098 list — harden+docker+app+backup+' +
            'cloudflare with NO setup_cf_origin_cert — while `all` gained both the firewall and the ' +
            'Origin CA install. Following the docs and running the "extra" step therefore SKIPPED the ' +
            'origin certificate and produced a Cloudflare 526.');
    });

    test('the shared run includes the origin-cert install and the firewall', () => {
        const runAll = /run_all\(\)\s*\{([\s\S]*?)\n\}/.exec(provisionCode);
        assert.ok(runAll, 'run_all() is gone');
        for (const phase of ['harden_system', 'install_docker', 'deploy_app', 'setup_backups',
                             'setup_cf_origin_cert', 'setup_cloudflare_only']) {
            assert.ok(runAll[1].includes(phase), `run_all() no longer calls ${phase}`);
        }
    });

    test('the docs no longer tell the operator to run all+cf', () => {
        for (const [name, text] of [['README.md', readme], ['INSTALL.md', install],
                                    ['provision-ubuntu.sh', provision]]) {
            // Keep only lines that INSTRUCT: a line explaining that all+cf is a
            // deprecated alias must not fail this.
            const instructions = text.split('\n')
                .filter(l => /provision-ubuntu\.sh\s+all\+cf/.test(l))
                .filter(l => !/alias|deprecated|used to|F-192/i.test(l));
            assert.deepEqual(instructions, [],
                `${name} still instructs the operator to run \`all+cf\`, which is how F-192 turned a ` +
                'correct provision into one that skips the Cloudflare Origin certificate.');
        }
    });
});

// ─── F-193: the diagnostics token never rides on a URL ─────────────────────
describe('diagGate takes the token from a header only (F-193)', () => {
    const gate = /function diagGate\(req, res\)\s*\{([\s\S]*?)\n\}/.exec(serverCode);

    test('diagGate exists and is parseable', () => {
        assert.ok(gate, 'diagGate is gone or changed shape');
    });

    test('the token is never read from the query string', () => {
        // `bearer || req.query.token` was the defect. A URL-borne secret is
        // simultaneously in Cloudflare's logs, the monitoring vendor's saved
        // config and alert emails, shell history, browser history and the
        // Referer of anything the response links to. F-091 fixed OUR nginx
        // access log only; it could not fix any of the rest.
        //
        // Asserted by ELIMINATION rather than by matching the old expression:
        // pinning the guard to the exact text `bearer || String(req.query.token`
        // is defeated by any rewrite of the same idea (a third `||` term, a
        // different spelling, `req.query['token']`). So: delete the one
        // legitimate mention — the detection that produces the 403 below — and
        // require that NOTHING reads the query string afterwards.
        const withoutDetection = gate[1]
            .replace(/req\.query && req\.query\.token !== undefined/g, '');
        assert.ok(!/req\.query/.test(withoutDetection),
            'diagGate reads the query string for something other than detecting-and-refusing a ?token=. ' +
            'A URL-borne secret is in Cloudflare\'s logs, the monitoring vendor\'s saved config and alert ' +
            'emails, shell and browser history, and the Referer of anything the response links to — none ' +
            'of which rotating the token fixes, because the next monitor URL leaks it the same way.');
    });

    test('Authorization: Bearer and X-Diag-Token are both accepted', () => {
        assert.match(gate[1], /headers\['authorization'\]/);
        assert.match(gate[1], /headers\['x-diag-token'\]/,
            'the header alternative is gone; monitors that cannot send Authorization have nowhere to go');
        assert.match(gate[1], /supplied && supplied === DIAG_TOKEN/,
            'an empty supplied token must not match an empty DIAG_TOKEN by accident');
    });

    test('a ?token= caller gets a distinct 403 that names the header', () => {
        assert.match(gate[1], /req\.query\.token !== undefined/,
            'nothing detects a query-string token, so the operator gets a generic 401 and goes off ' +
            'rotating a token that was never wrong — while it stays in the monitor URL');
        assert.match(gate[1], /res\.status\(403\)/);
        assert.match(gate[1], /X-Diag-Token/);
    });

    test('the gate never echoes the supplied token back', () => {
        assert.ok(!/error:.*\$\{\s*(supplied|bearer|header)\s*\}/.test(gate[1]),
            'the 401/403 body interpolates the supplied token — that writes it into the response, which ' +
            'is the one place it is even easier to log than the URL');
    });

    test('.env.example and README teach the header form, not ?token=', () => {
        // Matched as a URL SHAPE rather than the bare substring, for two
        // reasons: /api/email/* legitimately takes ?token= (a single-use link
        // mailed to one recipient, not a shared operator secret), and both
        // documents now carry a paragraph explaining that ?token= was removed
        // — which must not itself trip the guard.
        const diagUrlWithToken = /\/api\/diag[^\s`'"]*\?token=/;
        for (const [name, text] of [['.env.example', envExample], ['README.md', readme]]) {
            const instructions = text.split('\n').filter(l => diagUrlWithToken.test(l));
            assert.deepEqual(instructions, [],
                `${name} still documents a /api/diag URL carrying ?token=; that recipe is how the secret ` +
                "ends up in the uptime vendor's stored URL and Cloudflare's request logs.");
            assert.match(text, /X-Diag-Token|Authorization: Bearer/,
                `${name} does not show the header form at all`);
        }
        // And the removal is stated, not silent: an operator whose monitor
        // starts 403ing needs the reason in the file they will open.
        assert.match(envExample, /F-193/, '.env.example does not explain why ?token= stopped working');
    });
});
