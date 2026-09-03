// Round-2 leftovers that round 3 still flagged: F-150, F-179, F-182, F-189.
//
// These are all ops-surface findings, and they share a shape worth naming: the
// bug is INERT on the production host and fires somewhere else. F-189's cert
// name only mismatches when DOMAIN differs from the baked literal; F-179's
// renew hook only matters ~60 days out; F-182's missing hook only matters if an
// operator follows the documented path. That is exactly why they survived two
// rounds — nobody looking at production could see them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';

const sh = (p) => stripComments(readRepo(p, import.meta.url), { line: '#', block: false });
const raw = (p) => readRepo(p, import.meta.url);

const compose = raw('docker-compose.yml');
const composeCode = sh('docker-compose.yml');
const deploySh = sh('deploy.sh');
const provision = sh('provision-ubuntu.sh');
const aligner = raw('tools/align-cert-name.sh');
const migrateScript = raw('tools/migrate-hash-ids.mjs');
const install = raw('INSTALL.md');

// ─────────────────────────────────────────────────────────────────────────────
// F-179 — certbot renew must restore the perms it destroys
// ─────────────────────────────────────────────────────────────────────────────

describe('F-179 — the renew loop fixes ownership after writing a key', () => {
    test('renew carries a deploy-hook', () => {
        // Four paths write TLS key material; the renew loop was the one that
        // never fixed ownership afterwards, so a site that works today breaks
        // at the next renewal ~60 days out — with nginx unable to read its own
        // key and Cloudflare answering 521.
        assert.match(composeCode, /certbot renew --deploy-hook "\$\$FIXPERMS"/,
            'certbot renew runs without restoring group-101 readability');
    });

    test('the hook chgrps by NUMBER, not by name', () => {
        // `chgrp nginx` resolves against the certbot container's /etc/group,
        // where 101 is something else entirely.
        assert.match(compose, /chgrp -R 101 \/etc\/letsencrypt\/live \/etc\/letsencrypt\/archive/);
        assert.ok(!/chgrp -R nginx/.test(compose));
    });

    test('the key is 0640, never 0644', () => {
        // uid 101 must READ it; the world must not.
        assert.match(compose, /-name '\*\.pem' -exec chmod 0640/);
        assert.ok(!/chmod 0644 \{\}/.test(compose),
            'a world-readable private key');
    });

    test('directories are traversable but not world-listable', () => {
        assert.match(compose, /-type d -exec chmod 0750/);
    });

    test('it covers archive/, not just live/', () => {
        // live/ is symlinks INTO archive/; fixing only live/ leaves the real
        // key unreadable.
        const at = compose.indexOf('FIXPERMS:');
        const block = compose.slice(at, at + 700);
        assert.ok((block.match(/\/etc\/letsencrypt\/archive/g) || []).length >= 3);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-189 — nginx must open a cert directory that exists
// ─────────────────────────────────────────────────────────────────────────────

describe('F-189 — the cert name is aligned by every path that deploys', () => {
    test('the helper exists and is shared', () => {
        assert.match(aligner, /^#!\/usr\/bin\/env bash/);
        assert.match(aligner, /ln -sfn "\$DOMAIN" "\$live_dir\/\$want"/);
    });

    test('deploy.sh calls it — it previously did not', () => {
        assert.match(deploySh, /bash \.\/tools\/align-cert-name\.sh "\$DOMAIN" "\$CERTBOT_PATH"/,
            'deploy.sh still skips the alias, so a deployment whose DOMAIN differs cannot start');
    });

    test('provision delegates rather than keeping a second copy', () => {
        // Two copies of this logic is how F-060, F-133 and F-198 each happened.
        assert.match(provision, /align-cert-name\.sh/);
        assert.ok(!/ln -sfn "\$DOMAIN" "\$live_dir\/\$want"/.test(provision),
            'provision has its own copy again — the two will drift');
    });

    test('the name nginx opens is READ from nginx.conf, not assumed', () => {
        assert.match(aligner, /sed -n 's#\^\[\[:space:\]\]\*ssl_certificate/);
    });

    test('the symlink target is RELATIVE', () => {
        // The link is resolved inside the container, where the parent is
        // /etc/letsencrypt/live — an absolute host path would dangle.
        assert.match(aligner, /# RELATIVE target/);
        assert.ok(!/ln -sfn "\$live_dir\/\$DOMAIN"/.test(aligner));
    });

    test('it refuses to clobber a real directory holding a key', () => {
        assert.match(aligner, /if \[ -d "\$live_dir\/\$want" \] && \[ ! -L "\$live_dir\/\$want" \]; then/);
        assert.match(aligner, /Refusing to guess which certificate should win/);
    });

    test('the rejected alternative is recorded, with its reason', () => {
        // envsubst templating would substitute nginx's own $host/$remote_addr
        // and produce a config that does not parse — the whole site down, on a
        // path that cannot be tested without building and running the image.
        assert.match(aligner, /NGINX_ENVSUBST_FILTER/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-182 — the documented path must not be worse than the accidental one
// ─────────────────────────────────────────────────────────────────────────────

describe('F-182 — the operator migration queues fork-deleted heights', () => {
    test('the script passes onForkDelete', () => {
        // The boot path queues them (F-187). The script did not, so running the
        // migration the DOCUMENTED way turned fork deletes into permanent holes.
        assert.match(migrateScript, /onForkDelete: \(heights\) => \{/,
            'the operator script still drops fork-deleted heights on the floor');
        // Assert the statement EXECUTES, not merely that the text appears. A
        // mutant that commented it out (`SELECT 1 -- INSERT INTO scan_failures`)
        // survived the first version of this, because the searched string was
        // still in the file — inside the comment that disabled it.
        const at = migrateScript.indexOf('onForkDelete:');
        const body = migrateScript.slice(at, at + 1600);
        assert.match(body, /db\.prepare\(`\s*\n\s*INSERT INTO scan_failures/,
            'the queue write is not a live prepared INSERT');
        assert.match(body, /\)\.run\(h,/, 'the statement is prepared but never run');
        assert.match(body, /VALUES \('chain_index', \?, 0, \?, \?, \?\)/);
    });

    test('it queues with attempts reset, and says why that differs from boot', () => {
        const at = migrateScript.indexOf('onForkDelete:');
        const block = migrateScript.slice(at - 1200, at + 1600);
        assert.match(block, /attempts = 0/);
        assert.match(block, /NEW obligation/,
            'the deliberate difference from recordScanFailure is undocumented');
    });

    test('one failing height does not abort the migration', () => {
        const at = migrateScript.indexOf('onForkDelete:');
        assert.match(migrateScript.slice(at, at + 1400), /catch \(e\) \{ \/\* one height must not abort/);
    });

    test('INSTALL documents the operator script', () => {
        assert.match(install, /migrate-hash-ids\.mjs/,
            'the operator path is undocumented, so nobody will take it');
        assert.match(install, /resumable/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-150 — base images float on mutable tags
// ─────────────────────────────────────────────────────────────────────────────

describe('F-150 — the digest-pinning tooling', () => {
    const pinner = raw('tools/pin-image-digests.sh');

    test('the helper exists and defaults to a dry run', () => {
        // Rewriting build files without being asked is not something a helper
        // should do on first invocation.
        assert.match(pinner, /WRITE=0/);
        assert.match(pinner, /\[ "\$\{1:-\}" = "--write" \] && WRITE=1/);
    });

    test('it reads digests from the local daemon, not the network', () => {
        // So it needs no registry credentials and can run on the deploy host.
        // `docker image inspect` reads the LOCAL daemon; `docker manifest
        // inspect` would hit the registry and need credentials. The exact
        // --format template changed when empty-RepoDigests handling was added,
        // so assert the property that matters rather than the template text.
        assert.match(pinner, /docker image inspect "\$tag"/);
        assert.ok(!/docker manifest inspect|skopeo|curl .*registry/.test(pinner),
            'the pinner now reaches out to a registry — it must work offline on the deploy host');
    });

    test('it covers every base image the build uses', () => {
        for (const img of ['node:22.11-alpine', 'nginxinc/nginx-unprivileged:1.27-alpine', 'certbot/certbot:v2.11.0']) {
            assert.ok(pinner.includes(img), `${img} is not in the pin list`);
        }
    });

    test('it will not silently re-pin something already pinned', () => {
        assert.match(pinner, /already digest-pinned/);
    });

    test('the already-pinned check ignores COMMENTS', () => {
        // The first version was a bare `grep -qF "$tag@sha256:"`. Dockerfile.backend
        // carries a comment reading:
        //     # then change this line to `FROM node:22.11-alpine@sha256:…`
        // which matched — so the script printed "already digest-pinned" and
        // skipped a file that was not pinned at all. A false OK is the worst
        // possible outcome for a supply-chain tool: it reports success while
        // leaving the hole open. Same self-match trap this suite has hit
        // repeatedly, this time in the tooling rather than the tests.
        assert.match(pinner, /is_pinned\(\) \{/);
        assert.match(pinner, /grep -Eq "\^\[\[:space:\]\]\*\(FROM\|image:\)/,
            'the pinned check is not anchored to real FROM/image: lines');
        assert.ok(!/grep -qF "\$\{tag\}@sha256:"/.test(pinner),
            'the comment-matching grep is back');
    });

    test('a tag is resolved once and reused across files', () => {
        // node:22.11-alpine appears in BOTH Dockerfiles. Resolving it twice
        // lets the two files pin different digests if the tag is retagged
        // between the calls — two copies of a pin that drift, i.e. exactly the
        // failure this script exists to prevent, reintroduced by the fix.
        assert.match(pinner, /declare -A RESOLVED/);
        assert.match(pinner, /if \[ -n "\$\{RESOLVED\[\$tag\]:-\}" \]/);
    });

    test('"present but no registry digest" is distinguished from "absent"', () => {
        // An image built locally or loaded from a tarball IS present but has an
        // empty .RepoDigests, so `{{index .RepoDigests 0}}` errors. The old
        // code swallowed that and said "not pulled locally", sending the
        // operator to docker pull for an image they already had.
        assert.match(pinner, /is not present locally/);
        assert.match(pinner, /carries no registry digest/);
    });

    test('an unresolved image makes the run FAIL, not succeed quietly', () => {
        // Otherwise a partial run reads as a complete one and the operator
        // commits a half-pinned build.
        assert.match(pinner, /NOTHING above is a complete answer/);
        assert.match(pinner, /exit 1/);
    });

    test('a TARGETS entry naming a tag no longer in the file is reported', () => {
        assert.match(pinner, /STALE/);
    });

    test('it only rewrites FROM / image: lines', () => {
        // A tag mentioned in a comment or a RUN line must stay prose.
        assert.match(pinner, /\(FROM\|image:\)/);
    });

    test('the tags it targets are the ones actually in the build files', () => {
        // The pin list restating a tag that has since been bumped is the whole
        // failure mode of a second copy — derive the check from the real files.
        const dockerfiles = raw('Dockerfile.backend') + raw('Dockerfile.frontend') + compose;
        for (const img of ['node:22.11-alpine', 'nginxinc/nginx-unprivileged:1.27-alpine', 'certbot/certbot:v2.11.0']) {
            assert.ok(dockerfiles.includes(img),
                `tools/pin-image-digests.sh targets ${img}, which no build file references any more`);
        }
    });
});
