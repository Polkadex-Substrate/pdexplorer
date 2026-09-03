#!/bin/bash
#
# ---- Audit F-024: this script now ISSUES a certificate ----------------------
#
# It was called init-letsencrypt.sh and it never ran `certonly`. All it did was
# `openssl req -x509` — a 365-day SELF-SIGNED file — and then print "Certificate
# Generated!". Round 1 left it that way and added warnings elsewhere; the
# auditors correctly refused to close on a warning.
#
# Why a self-signed origin cert is not a cosmetic problem here: this deployment
# sits behind Cloudflare in **Full (Strict)** mode, which validates the origin's
# certificate chain. A self-signed cert fails that validation and Cloudflare
# returns **526** to every visitor. The site is down, the origin logs look
# healthy (nginx started, it has a cert), and nothing in the provision output
# said "this is not a real certificate" loudly enough to notice. That is the
# disaster-recovery shape of this bug: a fresh provision of a lost host ends
# with a green-looking run and a dead site.
#
# The distinction this script now makes explicit:
#
#   ORIGIN_CERT_MODE=letsencrypt           (DEFAULT)
#       Bootstrap a placeholder only long enough for nginx to start, run a real
#       `certonly --webroot`, then VERIFY the result is not self-signed and
#       exit non-zero if it is. Never ends on a placeholder.
#
#   ORIGIN_CERT_MODE=self-signed-bootstrap (explicit opt-in)
#       Write the placeholder and stop. This is legitimate for exactly two
#       situations — a GREY-CLOUDED (DNS-unproxied) host where you will issue
#       via DNS-01 by hand afterwards, and the moments during provisioning
#       where nginx must start before any issuance can happen at all. It is
#       never a finished state for a public, orange-clouded host, so it must be
#       asked for by name and it prints a banner saying so.
#
# Production runs a Cloudflare Origin CA certificate (15-year, installed by
# `provision-ubuntu.sh cf-origin-cert`), not Let's Encrypt. That path does not
# come through this script at all — which is precisely why this script must not
# quietly overwrite it, and why the "existing data" guard below defaults to
# KEEPING what is there.

# Source variables from .env
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
else
  echo "Error: .env file missing. Cannot proceed."
  exit 1
fi

# Accept either DOMAIN (preferred, matches docker-compose convention and
# provision-ubuntu.sh) or the legacy DOMAIN_NAME from earlier .env files.
DOMAIN_VALUE="${DOMAIN:-${DOMAIN_NAME:-}}"
if [ -z "$DOMAIN_VALUE" ]; then
  echo "Error: neither DOMAIN nor DOMAIN_NAME is set in .env."
  exit 1
fi
domains=($DOMAIN_VALUE)
rsa_key_size=4096
# Must match the CERTBOT_PATH used by docker-compose.yml, or certbot writes
# certs to one directory while nginx mounts another — nginx then fails to start
# and Cloudflare serves 521. Defaults to ./certbot for backwards compatibility.
data_path="${CERTBOT_PATH:-./certbot}"
email="$LETSENCRYPT_EMAIL" # Adding a valid address is strongly recommended
staging=0 # Set to 1 if you're testing your setup to avoid hitting request limits

# Audit F-197. This used to test `[ -d "$data_path" ]` — the bind-mount PARENT.
#
# docker-compose creates that directory as an empty bind mount before anything
# is issued into it, so on a FIRST deploy the guard sees a directory, announces
# "keeping existing certificate", and exits 0. Nothing is issued, deploy.sh
# reports success, nginx has no cert, and Cloudflare answers 521 — while the log
# says the certificate was kept. It also meant RUN_LETSENCRYPT=1 could never
# replace a bad cert, because the directory always exists by then.
#
# The question the guard is trying to ask is "is there a usable certificate
# here", so it now asks that: a real fullchain.pem for this domain. An empty or
# half-populated certbot tree is NOT a kept certificate.
cert_live="$data_path/conf/live/${domains[0]}/fullchain.pem"
if [ -s "$cert_live" ]; then
  # Non-interactive safety: when run from automation (deploy.sh, provision, cron,
  # CI) there's no TTY to answer the prompt — default to KEEPING the existing
  # certs and exiting cleanly rather than blocking forever. Set NONINTERACTIVE=1
  # or FORCE=1 to override without a prompt.
  if [ "${FORCE:-0}" = "1" ]; then
    :
  elif [ "${NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    echo "Existing certificate found at $cert_live and no TTY — keeping it (set FORCE=1 to replace)."
    exit 0
  else
    read -p "Existing certificate found for ${domains[0]}. Continue and replace it? (y/N) " decision
    if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
      exit
    fi
  fi
fi

if [ ! -e "$data_path/conf/options-ssl-nginx.conf" ] || [ ! -e "$data_path/conf/ssl-dhparams.pem" ]; then
  echo "### Downloading recommended TLS parameters ..."
  mkdir -p "$data_path/conf"

  # These downloads were previously `curl -s URL > file` with no -f and no
  # validation. `curl -s` still exits 0 on an HTTP 404 and writes the error
  # body to the target file, so an upstream path change silently produced a
  # junk options-ssl-nginx.conf. nginx then died at startup with
  #   [emerg] unexpected end of file, expecting ";" or "}" in
  #   /etc/letsencrypt/options-ssl-nginx.conf:1
  # which took the whole site down (Cloudflare 521) with no obvious cause.
  #
  # Now: -f makes curl fail on HTTP errors, we download to a temp file, sanity
  # check the CONTENT, and only then move it into place. A failed download
  # leaves any existing good file untouched and aborts loudly.
  fetch_verified() {
    url="$1"; dest="$2"; must_contain="$3"; tmp="$dest.tmp.$$"
    if ! curl -fsS --retry 3 --retry-delay 2 "$url" -o "$tmp"; then
      rm -f "$tmp"
      echo "ERROR: failed to download $(basename "$dest") from $url" >&2
      return 1
    fi
    if [ ! -s "$tmp" ] || ! grep -q "$must_contain" "$tmp"; then
      rm -f "$tmp"
      echo "ERROR: downloaded $(basename "$dest") failed validation (expected to contain '$must_contain')." >&2
      echo "       Refusing to install it — nginx would fail to start." >&2
      return 1
    fi
    mv "$tmp" "$dest"
    echo "  ok: $(basename "$dest")"
  }

  fetch_verified \
    "https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf" \
    "$data_path/conf/options-ssl-nginx.conf" \
    "ssl_protocols" || exit 1

  fetch_verified \
    "https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem" \
    "$data_path/conf/ssl-dhparams.pem" \
    "BEGIN DH PARAMETERS" || exit 1
  echo
fi

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

path="/etc/letsencrypt/live/$domains"
host_live="$data_path/conf/live/$domains"

# Audit F-024. A certificate is self-signed when its issuer equals its subject.
# That is the only property that matters to Cloudflare Full (Strict), and it is
# checkable locally without a network round-trip — unlike "is there a file at
# fullchain.pem", which is what every path in this repo used to check and which
# a placeholder satisfies perfectly. Unreadable/absent counts as self-signed:
# the caller is asking "may I treat this as a real origin cert", and the safe
# answer to "I cannot tell" is no.
is_self_signed() {
  local pem="$1" issuer subject
  [ -s "$pem" ] || return 0
  issuer="$(openssl x509 -in "$pem" -noout -issuer 2>/dev/null)" || return 0
  subject="$(openssl x509 -in "$pem" -noout -subject 2>/dev/null)" || return 0
  [ "${issuer#issuer=}" = "${subject#subject=}" ]
}

write_self_signed_placeholder() {
  echo "### Writing a SELF-SIGNED BOOTSTRAP certificate for $domains ..."
  mkdir -p "$host_live"
  sudo $DC run --rm --entrypoint "\
    openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 365\
      -keyout '$path/privkey.pem' \
      -out '$path/fullchain.pem' \
      -subj '/CN=$domains'" certbot
  echo
}

ORIGIN_CERT_MODE="${ORIGIN_CERT_MODE:-letsencrypt}"

case "$ORIGIN_CERT_MODE" in
  self-signed-bootstrap)
    write_self_signed_placeholder
    # Loud on purpose. The old script's closing line was "Self-Signed
    # Certificate Generated!" followed by a note about browser warnings, which
    # reads as success and describes the wrong failure — nobody browses the
    # origin directly, Cloudflare does, and Cloudflare does not warn, it 526s.
    echo "############################################################"
    echo "## THIS IS NOT AN ORIGIN CERTIFICATE."
    echo "## It exists so nginx can start. Cloudflare Full (Strict)"
    echo "## will answer 526 to every visitor until it is replaced."
    echo "##"
    echo "## Finish with ONE of:"
    echo "##   sudo bash provision-ubuntu.sh cf-origin-cert   (production path)"
    echo "##   ORIGIN_CERT_MODE=letsencrypt bash $0           (ACME HTTP-01;"
    echo "##       requires the DNS record to be GREY-clouded)"
    echo "############################################################"
    exit 0
    ;;
  letsencrypt) ;;
  *)
    echo "Error: ORIGIN_CERT_MODE='$ORIGIN_CERT_MODE' is not recognised." >&2
    echo "       Use 'letsencrypt' (default) or 'self-signed-bootstrap'." >&2
    exit 2
    ;;
esac

# ---- letsencrypt mode ------------------------------------------------------

if [ -z "$email" ]; then
  echo "Error: LETSENCRYPT_EMAIL is not set in .env." >&2
  echo "       Let's Encrypt needs it for expiry notices; without one an" >&2
  echo "       unnoticed renewal failure becomes a hard outage at day 90." >&2
  exit 1
fi

# nginx has to be serving :80 before HTTP-01 can succeed, and nginx will not
# start without a certificate file — so the placeholder is a genuine
# prerequisite here, not a fallback. The difference from the old behaviour is
# that we do not STOP here.
if is_self_signed "$host_live/fullchain.pem"; then
  write_self_signed_placeholder
  echo "### Starting frontend so the ACME challenge can be answered ..."
  sudo $DC up -d frontend || true
  # certbot refuses to take over a live/ directory it did not create (it
  # expects symlinks into archive/). Removing the placeholder lineage is the
  # documented prerequisite; it is only ever done when we just established the
  # existing material is self-signed, so a real cert is never deleted here.
  # Belt-and-braces on the path: an empty $data_path or $domains would make
  # this an `rm -rf` of something much larger than a lineage directory.
  if [ -n "$data_path" ] && [ -n "$domains" ] && [ -d "$host_live" ]; then
    sudo rm -rf "$host_live"
    placeholder_removed=1
  fi
fi

echo "### Requesting a certificate for $domains from Let's Encrypt (HTTP-01) ..."
staging_arg=""
if [ "$staging" != "0" ]; then staging_arg="--staging"; fi

domain_args=""
for d in "${domains[@]}"; do domain_args="$domain_args -d $d"; done

# shellcheck disable=SC2086
if ! sudo $DC run --rm certbot certonly --webroot -w /var/www/certbot \
      $staging_arg $domain_args \
      --email "$email" --agree-tos --no-eff-email --non-interactive; then
  # Put the placeholder back before bailing out. We deleted the lineage above
  # so certbot would accept the directory; without this, a failed issuance
  # leaves NO certificate at all and nginx cannot start — turning a "TLS is
  # wrong" incident into a "nothing is listening" one (Cloudflare 521 instead
  # of 526). The exit status below still reports failure; the box just stays
  # reachable enough to fix from.
  if [ "${placeholder_removed:-0}" = "1" ]; then
    echo "### certonly failed — restoring the bootstrap placeholder so nginx can start." >&2
    write_self_signed_placeholder
  fi
  echo >&2
  echo "ERROR: certbot certonly failed for $domains." >&2
  echo "       The most common cause here is the Cloudflare proxy: HTTP-01" >&2
  echo "       validation cannot reach an ORANGE-clouded origin, because" >&2
  echo "       'Always Use HTTPS' redirects the challenge before it arrives." >&2
  echo "       Either grey-cloud the record for the duration, or use the" >&2
  echo "       production path: sudo bash provision-ubuntu.sh cf-origin-cert" >&2
  exit 1
fi

# Audit F-024 — the close condition. Do NOT relax this to a file-exists check:
# "there is a fullchain.pem" was true for the entire life of the bug this
# replaces. Exiting non-zero matters because provision/deploy treat a zero exit
# as "TLS is done".
if is_self_signed "$host_live/fullchain.pem"; then
  echo >&2
  echo "ERROR: $host_live/fullchain.pem is still self-signed after certonly." >&2
  echo "       Refusing to report success: Cloudflare Full (Strict) would 526." >&2
  exit 1
fi

echo
echo "### Certificate issued for $domains"
openssl x509 -in "$host_live/fullchain.pem" -noout -issuer -enddate 2>/dev/null || true
echo
