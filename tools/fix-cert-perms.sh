#!/usr/bin/env bash
#
# Make the TLS material readable by the unprivileged nginx uid.  (Audit F-179)
#
# The frontend runs `nginxinc/nginx-unprivileged` as uid/gid 101 (audit F-040,
# which closed the root-nginx finding). A private key that only root can read is
# therefore a key nginx cannot load — and nginx failing to load the :8443 key
# takes :8080 down with it, so the whole site becomes a Cloudflare 521.
#
# Round 1 did not surface this because nginx still ran as root. Round 2 found
# that FOUR different paths write key material and only one of them fixed the
# ownership afterwards:
#
#   deploy.sh                       chgrp -R 101   ✓
#   provision-ubuntu.sh (CF origin) install -m 0600 — UNDOES it
#   provision-ubuntu.sh (self-signed bootstrap)    — never sets it
#   certbot renew                   rewrites archive keys 0600 root
#
# So `sudo bash provision-ubuntu.sh`, the documented path, produces a site that
# does not start; and on a host where it currently works, the next renewal or
# re-issue can silently break it.
#
# A REAL EXAMPLE of why this must be explicit rather than incidental: on the
# production host the key was found as `root:lxd 640` and nginx COULD read it —
# but only because Ubuntu's `lxd` group happens to be GID 101, the same number
# nginx-unprivileged uses. Nothing designed that. A host where lxd landed on a
# different GID, or where lxd is absent, gets a dead site with no warning.
# Hence: set group 101 BY NUMBER, deliberately, from every path that writes a
# key. Never rely on a name, and never rely on luck.
#
# Idempotent and safe to run repeatedly. Usage:
#
#   tools/fix-cert-perms.sh [CERT_CONF_DIR]
#
# CERT_CONF_DIR defaults to $CERTBOT_PATH/conf, then ./certbot/conf — the same
# resolution docker-compose uses for the :ro bind mount.

set -euo pipefail

# Group 101 by NUMBER. `chgrp nginx` would resolve against the HOST's group
# database, where 101 is very often something unrelated (lxd, on Ubuntu) — the
# container's nginx group does not exist on the host at all.
NGINX_GID=101

resolve_dir() {
    if [ "${1:-}" != "" ]; then echo "$1"; return; fi
    if [ "${CERTBOT_PATH:-}" != "" ]; then echo "${CERTBOT_PATH}/conf"; return; fi
    if [ -f .env ]; then
        local p
        p=$(grep -E '^[[:space:]]*CERTBOT_PATH=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
        if [ -n "$p" ]; then echo "${p}/conf"; return; fi
    fi
    echo "./certbot/conf"
}

DIR=$(resolve_dir "${1:-}")

if [ ! -d "$DIR" ]; then
    echo "fix-cert-perms: no cert directory at $DIR — nothing to do." >&2
    exit 0
fi

# `live/` holds symlinks into `archive/`, and it is the archive files that carry
# the real mode bits. -R over the whole conf tree covers both, plus any renewal
# that has just written a new archive generation.
#
# The `|| :` is deliberate and the failure is handled below rather than by
# `set -e`. Testing this script showed why: with neither root nor a working
# sudo, the bare form aborted on sudo's own error text ("the no new privileges
# flag is set...") and never reached the verification — so the caller got a
# confusing message about sudo and no statement about whether the site would
# start. A provisioning script that fails must say what is broken.
if ! chgrp -R "$NGINX_GID" "$DIR" 2>/dev/null; then
    if ! sudo -n chgrp -R "$NGINX_GID" "$DIR" 2>/dev/null; then
        echo "fix-cert-perms: cannot chgrp $DIR to group $NGINX_GID." >&2
        echo "                Re-run as root, or: sudo chgrp -R $NGINX_GID $DIR" >&2
        echo "                Until then nginx (uid/gid 101) cannot read the private key" >&2
        echo "                and the site will return Cloudflare 521." >&2
        exit 1
    fi
fi

# Directories need +x to be traversed, not just +r.
find "$DIR" -type d -exec chmod 0750 {} + 2>/dev/null \
    || sudo -n find "$DIR" -type d -exec chmod 0750 {} + 2>/dev/null || :

# 0640: owner rw, GROUP READ, world nothing. The group read is the entire point;
# world stays excluded because this is a private key.
find "$DIR" -type f -name '*.pem' -exec chmod 0640 {} + 2>/dev/null \
    || sudo -n find "$DIR" -type f -name '*.pem' -exec chmod 0640 {} + 2>/dev/null || :

# Verify rather than assume. A silent failure here is a site outage at the next
# container start, and the whole point of this script is to stop that being
# discovered in production.
KEY=$(find "$DIR/live" -name 'privkey.pem' 2>/dev/null | head -1)
if [ -n "$KEY" ]; then
    MODE=$(stat -L -c '%a' "$KEY" 2>/dev/null || echo '?')
    GRP=$(stat -L -c '%g' "$KEY" 2>/dev/null || echo '?')
    if [ "$GRP" = "$NGINX_GID" ] && [ "${MODE:1:1}" -ge 4 ] 2>/dev/null; then
        echo "fix-cert-perms: OK — $(basename "$(dirname "$KEY")") privkey.pem is $MODE, group $GRP (nginx uid 101 can read it)"
    else
        echo "fix-cert-perms: WARNING — privkey.pem is mode $MODE group $GRP; nginx (uid/gid 101) may not be able to read it." >&2
        echo "                nginx will fail to load the :8443 key and the site will return Cloudflare 521." >&2
        exit 1
    fi
else
    echo "fix-cert-perms: no live/*/privkey.pem under $DIR yet (first run before issuance?)"
fi
