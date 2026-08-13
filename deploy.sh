#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "========================================"
echo " Starting Polkadex Explorer Deployment"
echo "========================================"

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Cannot detect OS. /etc/os-release not found."
    exit 1
fi

echo "--> Detected OS: $OS"

# 1. Update system packages and install prerequisites
echo "--> Updating system packages..."
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    sudo apt-get update -y
    sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common git
elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    sudo yum update -y
    sudo yum install -y yum-utils git
else
    echo "Unsupported OS: $OS. Please install Docker and Git manually."
    exit 1
fi

# 2. Install Docker if not installed
if ! command -v docker &> /dev/null
then
    echo "--> Docker not found. Installing Docker..."
    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        # Modern keyring method. `apt-key` was removed in Ubuntu 24.04 /
        # Debian 12+, so the old `apt-key add` path fails on any current box.
        sudo install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/$OS/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        sudo chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS $(lsb_release -cs) stable" \
            | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
        sudo apt-get update -y
        sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
        sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi
    
    sudo systemctl enable docker
    sudo systemctl start docker
    # Add current user to docker group (requires logout/login to take effect for non-sudo)
    sudo usermod -aG docker $USER
    echo "--> Docker installed successfully."
else
    echo "--> Docker is already installed."
fi

# 3. Ensure Docker Compose is available. Prefer the v2 plugin (`docker compose`,
#    installed above via docker-compose-plugin); fall back to the legacy
#    standalone binary only if neither is present.
if docker compose version &> /dev/null; then
    echo "--> Docker Compose plugin present (docker compose)."
elif command -v docker-compose &> /dev/null; then
    echo "--> Legacy docker-compose binary present."
else
    echo "--> Installing Docker Compose plugin..."
    sudo apt-get install -y docker-compose-plugin 2>/dev/null || {
        echo "--> Plugin unavailable; installing standalone docker-compose binary."
        sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
    }
fi

# 4. Clone or pull the repository into ONE canonical, ABSOLUTE location.
#
# This used to be a RELATIVE `REPO_DIR="pdexscan"`, which made the deployment
# location depend on your shell's cwd. Running the script from inside an
# existing checkout at /opt/pdexplorer found no ./pdexscan and cloned a SECOND
# full copy at /opt/pdexplorer/pdexscan. Two checkouts meant two certbot
# directories, two .env files, and a Compose project name that changed with cwd
# — between them the cause of a container-name conflict, a cert-path mixup, and
# a 521 outage, all in one day.
#
# DEPLOY_DIR is absolute and overridable; the script always operates there
# regardless of where it is invoked from.
REPO_URL="${REPO_URL:-https://github.com/polkadexaj/pdexscan.git}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pdexplorer}"

if [ -d "$DEPLOY_DIR/.git" ]; then
    echo "--> Repository exists at $DEPLOY_DIR. Pulling latest changes..."
    cd "$DEPLOY_DIR"
    git pull origin main
elif [ -e "$DEPLOY_DIR" ] && [ -n "$(ls -A "$DEPLOY_DIR" 2>/dev/null)" ]; then
    # Non-empty but not a git checkout — refuse rather than clone into it or
    # clone a nested copy beside it. Both are how the duplicate arose.
    echo "ERROR: $DEPLOY_DIR exists, is not empty, and is not a git checkout."
    echo "       Refusing to guess. Either make it a checkout of $REPO_URL,"
    echo "       or set DEPLOY_DIR=/path/to/checkout and re-run."
    exit 1
else
    echo "--> Cloning repository into $DEPLOY_DIR..."
    git clone "$REPO_URL" "$DEPLOY_DIR"
    cd "$DEPLOY_DIR"
fi

# 4.5 Require a REAL .env — never fall back to example defaults.
#
# This used to `cp .env.example .env` and carry on. That converted a
# misconfiguration into a SILENT one: a fresh checkout received a template
# .env and the whole stack came up looking perfectly healthy while
#   * EMAIL_PROVIDER / POSTMARK_TOKEN sat commented out, so governance email
#     alerts stopped going out with no error anywhere, and
#   * ALLOWED_ORIGINS lacked the production origins, so polkadex.ee was
#     CORS-blocked from calling the API.
# Nothing crashed, so nothing got noticed. Failing loudly at deploy time is far
# cheaper than discovering it from user reports days later.
if [ ! -f .env ]; then
    echo "ERROR: no .env found in $(pwd) — refusing to start with example defaults."
    echo
    echo "  A template lives at .env.example. Create a real config with:"
    echo "      cp .env.example .env && \${EDITOR:-nano} .env"
    echo
    echo "  At minimum set: DOMAIN, LETSENCRYPT_EMAIL, DATA_PATH, ALLOWED_ORIGINS."
    echo "  DATA_PATH matters most: pointing it at the wrong directory makes the"
    echo "  backend re-index the entire chain from scratch."
    exit 1
fi

# An UNEDITED copy of the template is the same failure wearing a disguise —
# the file exists, so the check above passes, but every value is a default.
if [ -f .env.example ] && cmp -s .env .env.example; then
    echo "ERROR: .env is byte-identical to .env.example — refusing to start with example defaults."
    echo "       Edit .env with this deployment's real values first"
    echo "       (DOMAIN, DATA_PATH, ALLOWED_ORIGINS, email provider credentials)."
    exit 1
fi

# 5. Build and deploy Docker containers
echo "--> Initializing Let's Encrypt certificates..."
# ---- TLS certificates ------------------------------------------------------
# Only bootstrap certs when there ISN'T already a usable one.
#
# This deployment serves a CLOUDFLARE ORIGIN certificate, installed by the
# `cf-origin-cert` phase of provision-ubuntu.sh — certbot never runs. Executing
# init-letsencrypt.sh on top of that is destructive in two ways:
#   1. it re-downloads options-ssl-nginx.conf + ssl-dhparams.pem from certbot's
#      repo. Those URLs now 404, and the old `curl -s` wrote the literal body
#      "404: Not Found" over the good files provision had generated — nginx
#      then died with `[emerg] unexpected end of file` and the site returned
#      Cloudflare 521;
#   2. answering "y" at its prompt replaces the origin cert with a SELF-SIGNED
#      placeholder, which Cloudflare Full (Strict) rejects with 526.
# Neither is recoverable by re-running the deploy, so skip the whole step when
# a certificate is already in place. Set RUN_LETSENCRYPT=1 to force it.
#
# Invoked via `bash` rather than `chmod +x && ./script`: the file is committed
# mode 100644, so chmod flipped it to 100755, which git counts as a local
# modification and which aborted the NEXT `git pull` — running the deploy made
# the next deploy impossible.
CERT_GLOB="${CERTBOT_PATH:-./certbot}/conf/live/*/fullchain.pem"
if [ "${RUN_LETSENCRYPT:-0}" != "1" ] && compgen -G "$CERT_GLOB" >/dev/null 2>&1; then
    echo "--> Existing certificate found — skipping init-letsencrypt.sh."
    echo "    (Cloudflare Origin cert setup. Use RUN_LETSENCRYPT=1 to force Let's Encrypt bootstrap.)"
else
    echo "--> No certificate found; bootstrapping..."
    bash ./init-letsencrypt.sh
fi

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

# ---- Compose project identity ---------------------------------------------
# Compose derives its project name from the DIRECTORY it runs in, but our
# services pin explicit container_name values (pdexplorer-backend, ...), which
# are GLOBAL to the Docker daemon. Run this script from a different path than
# the original deployment and Compose decides it is a brand-new project: it
# creates a fresh network, then collides on the container names it doesn't
# think it owns —
#     Conflict. The container name "/pdexplorer-backend" is already in use
# and the `down` above silently tears down the new empty project instead of
# the real stack. Pinning the project name makes down/up always target the
# SAME stack regardless of where this script is invoked from.
#
# If your running stack used a different project name, override it:
#   COMPOSE_PROJECT_NAME=<name> ./deploy.sh
# Find the current one with:
#   docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' pdexplorer-backend
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-pdexplorer}"
echo "--> Compose project: $COMPOSE_PROJECT (pinned; independent of cwd)"

# ---- Build provenance ------------------------------------------------------
# Stamp the image with the exact tree it was built from, so the running site can
# be asked what it is and the answer compared to this checkout. `-dirty` marks
# uncommitted changes, in which case the SHA alone does not identify the code.
GIT_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    GIT_SHA="${GIT_SHA}-dirty"
    echo "--> WARNING: working tree has uncommitted changes; tagging build as $GIT_SHA"
fi
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "--> Building $GIT_SHA at $BUILD_TIME"

echo "--> Building and starting full Docker stack..."
# Pass -p and the build args explicitly rather than exporting them: `sudo`
# strips the environment by default, so exported variables would not reach the
# compose process and the stamp would silently read "unknown".
sudo $DC -p "$COMPOSE_PROJECT" down || true
sudo GIT_SHA="$GIT_SHA" BUILD_TIME="$BUILD_TIME" $DC -p "$COMPOSE_PROJECT" up -d --build

# ---- Verify what actually came up ------------------------------------------
# A deploy that "succeeded" while leaving the old code running is the failure
# mode this whole mechanism exists to catch, so check rather than assume.
echo "--> Verifying deployed build..."
DEPLOYED=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    DEPLOYED="$(curl -s --max-time 3 http://127.0.0.1:3001/api/version 2>/dev/null \
        | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p')"
    [ -n "$DEPLOYED" ] && break
    sleep 2
done

if [ -z "$DEPLOYED" ]; then
    echo "    ! Backend did not answer /api/version — check: sudo docker logs pdexplorer-backend --tail 50"
elif [ "$DEPLOYED" = "$GIT_SHA" ]; then
    echo "    ✓ backend is running $DEPLOYED (matches this checkout)"
else
    echo "    ! MISMATCH: backend reports '$DEPLOYED' but this checkout built '$GIT_SHA'"
    echo "      The old container is probably still running. Try:"
    echo "        sudo $DC -p $COMPOSE_PROJECT up -d --build --force-recreate backend"
fi
# Frontend check hits nginx locally, bypassing Cloudflare — otherwise a cached
# edge response would tell you about a build from hours ago.
FE_VER="$(curl -sk --max-time 3 https://127.0.0.1/version.json 2>/dev/null \
    | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p')"
if [ -z "$FE_VER" ]; then
    FE_VER="$(curl -s --max-time 3 http://127.0.0.1/version.json 2>/dev/null \
        | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p')"
fi
if [ -z "$FE_VER" ]; then
    echo "    ! Frontend did not serve /version.json — check: sudo docker logs pdexplorer-frontend --tail 30"
elif [ "$FE_VER" = "$GIT_SHA" ]; then
    echo "    ✓ frontend is running $FE_VER (matches this checkout)"
else
    echo "    ! MISMATCH: frontend reports '$FE_VER' but this checkout built '$GIT_SHA'"
fi

DOMAIN_HINT="$(grep -E '^DOMAIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'"' | tr -d ' ')"
echo "    Public check (may lag until Cloudflare is purged):"
echo "      curl -s https://${DOMAIN_HINT:-your-domain}/api/version | jq -r .gitSha"
echo "      curl -s https://${DOMAIN_HINT:-your-domain}/version.json | jq -r .gitSha"

# 6. Cleanup unused docker images
echo "--> Cleaning up dangling images to save space..."
sudo docker image prune -f

echo "========================================"
echo " Deployment Complete!"
echo "========================================"
echo "The application is now running securely on HTTPS!"
echo "You can check the backend logs using:"
echo "  sudo docker logs pdexplorer-backend -f"
