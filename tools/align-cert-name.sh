#!/usr/bin/env bash
#
# Make the cert directory nginx OPENS match the cert directory that exists.
# (Audit F-189)
#
# nginx.conf names its certificate by a literal path:
#
#     ssl_certificate /etc/letsencrypt/live/explorer.polkadex.ee/fullchain.pem;
#
# That literal is baked into the frontend image at build time. Certbot, and the
# Cloudflare origin-cert installer, write to `live/$DOMAIN`. On the production
# host those two names happen to be equal, which is exactly why this stayed
# invisible through two audit rounds: the bug is inert on the only deployment
# anyone looks at, and fires on the first one with a different DOMAIN — a
# staging host, a rename, a fork. nginx then cannot open its key, exits, and
# Cloudflare answers 521 with nothing in the app logs to explain it.
#
# provision-ubuntu.sh already did this. deploy.sh did not, so a deploy to a
# differently-named host produced a site that would not start. Rather than
# copying the logic — this repo has been bitten repeatedly by two copies that
# drift (F-060, F-133, F-198) — it lives here once and both callers source it.
#
# The DURABLE fix is to template the ssl_certificate lines from $DOMAIN at
# container start. That was considered and deliberately not taken here: nginx's
# envsubst templating substitutes every `$var` it sees, including nginx's own
# `$host` / `$remote_addr` / `$request_uri`, so it needs NGINX_ENVSUBST_FILTER
# to be exactly right — and the failure mode of getting it wrong is a config
# that does not parse, i.e. the whole site down, on a path that cannot be tested
# without building and running the image. A symlink is a smaller, reversible
# change with the same effect. Revisit when there is somewhere safe to test it.
#
# Usage:  bash tools/align-cert-name.sh <DOMAIN> <CERTBOT_PATH> [nginx.conf]
#
# Idempotent. Prints what it does. Never deletes a real directory.
set -uo pipefail

DOMAIN="${1:-}"
CERTBOT_PATH="${2:-}"
CONF="${3:-nginx.conf}"

[ -n "$DOMAIN" ] || { echo "align-cert-name: DOMAIN is required" >&2; exit 2; }
[ -n "$CERTBOT_PATH" ] || { echo "align-cert-name: CERTBOT_PATH is required" >&2; exit 2; }
[ -f "$CONF" ] || { echo "align-cert-name: $CONF not found — skipping." >&2; exit 0; }

# The name nginx will actually open, read out of the config rather than assumed.
want=$(sed -n 's#^[[:space:]]*ssl_certificate[[:space:]]\+/etc/letsencrypt/live/\([^/]\+\)/.*#\1#p' "$CONF" | head -1)
if [ -z "$want" ]; then
    echo "align-cert-name: no ssl_certificate live/<name> in $CONF — nothing to align." >&2
    exit 0
fi

# Already agree: the common case, and the reason this was invisible.
[ "$want" != "$DOMAIN" ] || exit 0

live_dir="$CERTBOT_PATH/conf/live"
if [ ! -d "$live_dir/$DOMAIN" ]; then
    echo "align-cert-name: nginx opens live/$want but $live_dir/$DOMAIN does not exist yet — skipping." >&2
    exit 0
fi

# A REAL directory at live/$want means this box previously ran under that name
# and still holds that certificate. `ln -sfn` against a real directory does not
# replace it — it silently creates the link INSIDE it — and even if it did,
# deleting a directory holding a private key is not a decision a deploy script
# should make unattended. Say what is wrong and let a human choose.
if [ -d "$live_dir/$want" ] && [ ! -L "$live_dir/$want" ]; then
    echo "align-cert-name: nginx.conf opens live/$want, which is a REAL directory holding its own" >&2
    echo "                 certificate, but this deployment's DOMAIN is $DOMAIN." >&2
    echo "                 Refusing to guess which certificate should win." >&2
    echo "                 Either set DOMAIN=$want, or move $live_dir/$want aside and re-run." >&2
    exit 0
fi

echo "align-cert-name: nginx.conf opens live/$want but DOMAIN is $DOMAIN;"
echo "                 linking $live_dir/$want -> $DOMAIN so the container reads the installed cert."
echo "                 Durable fix: edit the ssl_certificate lines in nginx.conf and rebuild the frontend."
# RELATIVE target. The link is resolved INSIDE the container, where the parent
# is /etc/letsencrypt/live — an absolute host path would dangle there.
ln -sfn "$DOMAIN" "$live_dir/$want"
