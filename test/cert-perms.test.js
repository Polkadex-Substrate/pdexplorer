// Audit F-179 (round 2) — the TLS key must be readable by nginx uid 101.
//
// The frontend runs nginx-unprivileged as uid/gid 101 (that was F-040's fix).
// A key only root can read is a key nginx cannot load, and failing to load the
// :8443 key takes :8080 down too — the whole site becomes a Cloudflare 521.
//
// What makes this worth a test rather than a one-line patch: FOUR separate
// paths write key material, and round 1 fixed exactly one of them. The property
// is not "deploy.sh does a chgrp", it is "no path leaves the key unreadable".
// So these tests enumerate the paths.
//
// Verified on the production host while writing this, and the result is the
// reason the helper sets the group BY NUMBER: the live key was `root:lxd 640`
// and nginx could read it only because Ubuntu's `lxd` group happens to be
// GID 101. The site was working by coincidence, not by design.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const helper    = read('tools/fix-cert-perms.sh');
// Comments stripped for the "must not contain" checks: this file explains at
// length WHY `chgrp nginx` is wrong, and a naive grep matches the explanation.
// (Third time this trap has appeared in these suites — hence the shared helper.)
const code = (src) => src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
const helperCode = code(helper);
const deploySh  = read('deploy.sh');
const provision = read('provision-ubuntu.sh');

describe('the helper itself', () => {
    test('exists and is executable', () => {
        const p = new URL('../tools/fix-cert-perms.sh', import.meta.url);
        assert.ok(existsSync(p), 'tools/fix-cert-perms.sh is gone');
        // 0o111 — any execute bit. deploy.sh invokes it via `bash`, so this is
        // belt-and-braces, but an operator will run it directly.
        assert.ok((statSync(p).mode & 0o111) !== 0, 'the helper is not executable');
    });

    test('sets the group by NUMBER, never by name', () => {
        // `chgrp nginx` resolves against the HOST group database, where 101 is
        // usually something unrelated and "nginx" often does not exist at all.
        assert.match(helper, /NGINX_GID=101/);
        assert.ok(!/chgrp\s+(-R\s+)?nginx/.test(helperCode),
            'the helper resolves the group by name — that depends on the host, not the container');
    });

    test('the key ends up group-readable but not world-readable', () => {
        assert.match(helper, /chmod 0640/, 'keys must be group-readable');
        assert.ok(!/chmod 0644 \{\} \+/.test(helperCode), 'a private key must not be world-readable');
        assert.match(helper, /chmod 0750/, 'directories need +x to be traversed');
    });

    test('it VERIFIES rather than assuming, and fails loudly', () => {
        // A silent failure here surfaces as a site outage at the next container
        // start. The whole point is to find out now.
        assert.match(helper, /stat -L -c '%a'/);
        assert.match(helper, /Cloudflare 521/, 'the failure message must say what breaks');
        assert.match(helper, /exit 1/);
    });

    test('a missing cert directory is a clean no-op, not a failure', () => {
        // Called from provisioning before issuance; must not abort the run.
        assert.match(helper, /nothing to do\." >&2\n\s*exit 0/);
    });

    test('an un-privileged failure explains itself instead of leaking sudo errors', () => {
        // Found by running it: with no root and no usable sudo, the bare
        // `|| sudo chgrp` form aborted under `set -e` on sudo's own message and
        // never reached the verification.
        assert.match(helper, /sudo -n chgrp/, 'use sudo -n so a password prompt cannot hang provisioning');
        assert.match(helper, /cannot chgrp/);
    });
});

describe('every path that writes key material calls it', () => {
    test('deploy.sh', () => {
        assert.match(deploySh, /tools\/fix-cert-perms\.sh/);
        // And no longer hand-rolls its own copy.
        assert.ok(!/chgrp -R 101 "\$CERT_CONF_DIR"/.test(deploySh),
            'deploy.sh has its own chgrp again — that is the drift F-179 is about');
    });

    test('provision-ubuntu.sh defines one shim and uses it more than once', () => {
        assert.match(provision, /_fix_cert_perms\(\) \{/);
        const uses = (provision.match(/^\s*_fix_cert_perms /gm) || []).length;
        assert.ok(uses >= 2,
            `only ${uses} call site(s) — the CF-origin install and the self-signed bootstrap both write keys`);
    });

    test('the CF-origin install no longer writes the key 0600', () => {
        // This was the line that UNDID deploy.sh's chgrp on every re-provision.
        assert.ok(!/install -m 0600 "\$src_key"/.test(provision),
            'the origin-cert install writes an owner-only key again');
        assert.match(provision, /install -m 0640 "\$src_key"/);
    });

    test('the self-signed bootstrap fixes permissions after openssl', () => {
        // openssl writes 0600 root. The bootstrap exists precisely so nginx can
        // START; a key it cannot read defeats the entire purpose.
        const block = provision.slice(
            provision.indexOf('openssl req -x509'),
            provision.indexOf('openssl req -x509') + 900
        );
        assert.match(block, /_fix_cert_perms/,
            'the self-signed bootstrap leaves a key nginx cannot read, so nginx never starts');
    });

    test('the shim degrades gracefully if the helper file is missing', () => {
        // A partial checkout must not mean a dead site.
        const shim = provision.slice(
            provision.indexOf('_fix_cert_perms() {'),
            provision.indexOf('setup_cloudflare_only() {')
        );
        assert.match(shim, /chgrp -R 101/, 'no inline fallback when the helper is absent');
    });
});

describe('the mount path the container actually reads', () => {
    test('compose mounts CERTBOT_PATH/conf read-only at /etc/letsencrypt', () => {
        // Confirmed live: the host has no /etc/letsencrypt at all — the certs
        // live under CERTBOT_PATH and are bind-mounted. Anyone debugging this
        // by stat-ing the container path on the host gets "No such file".
        const compose = read('docker-compose.yml');
        assert.match(compose, /\$\{CERTBOT_PATH:-\.\/certbot\}\/conf:\/etc\/letsencrypt:ro/);
    });

    test('nginx.conf reads the key from the mounted path', () => {
        assert.match(read('nginx.conf'),
            /ssl_certificate_key \/etc\/letsencrypt\/live\/explorer\.polkadex\.ee\/privkey\.pem/);
    });
});
