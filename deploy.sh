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

# 4.5 Ensure .env exists
if [ ! -f .env ]; then
    echo "--> .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "PLEASE EDIT .env file with your actual domain and email if different, then re-run deploy.sh."
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

echo "--> Building and starting full Docker stack..."
# Pass -p explicitly rather than exporting the variable: `sudo` strips the
# environment by default, so an exported COMPOSE_PROJECT_NAME would not reach
# the compose process and the bug would silently return.
sudo $DC -p "$COMPOSE_PROJECT" down || true
sudo $DC -p "$COMPOSE_PROJECT" up -d --build

# 6. Cleanup unused docker images
echo "--> Cleaning up dangling images to save space..."
sudo docker image prune -f

echo "========================================"
echo " Deployment Complete!"
echo "========================================"
echo "The application is now running securely on HTTPS!"
echo "You can check the backend logs using:"
echo "  sudo docker logs pdexplorer-backend -f"
