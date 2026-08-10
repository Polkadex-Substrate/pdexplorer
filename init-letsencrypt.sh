#!/bin/bash

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

if [ -d "$data_path" ]; then
  # Non-interactive safety: when run from automation (deploy.sh, provision, cron,
  # CI) there's no TTY to answer the prompt — default to KEEPING the existing
  # certs and exiting cleanly rather than blocking forever. Set NONINTERACTIVE=1
  # or FORCE=1 to override without a prompt.
  if [ "${FORCE:-0}" = "1" ]; then
    :
  elif [ "${NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    echo "Existing cert data found and no TTY — keeping existing certificate (set FORCE=1 to replace)."
    exit 0
  else
    read -p "Existing data found for $domains. Continue and replace existing certificate? (y/N) " decision
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

echo "### Creating Self-Signed certificate for $domains ..."
path="/etc/letsencrypt/live/$domains"
mkdir -p "$data_path/conf/live/$domains"

sudo $DC run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 365\
    -keyout '$path/privkey.pem' \
    -out '$path/fullchain.pem' \
    -subj '/CN=$domains'" certbot
echo

echo "### Self-Signed Certificate Generated!"
echo "Note: Your browser will display a security warning because this is a self-signed certificate."
echo
