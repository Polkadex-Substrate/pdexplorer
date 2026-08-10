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

# 4. Clone or Pull repository
REPO_URL="https://github.com/polkadexaj/pdexscan.git"
REPO_DIR="pdexscan"

if [ -d "$REPO_DIR" ]; then
    echo "--> Repository exists. Pulling latest changes..."
    cd $REPO_DIR
    git pull origin main
else
    echo "--> Cloning repository..."
    git clone $REPO_URL $REPO_DIR
    cd $REPO_DIR
fi

# 4.5 Ensure .env exists
if [ ! -f .env ]; then
    echo "--> .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "PLEASE EDIT .env file with your actual domain and email if different, then re-run deploy.sh."
fi

# 5. Build and deploy Docker containers
echo "--> Initializing Let's Encrypt certificates..."
# Invoke via `bash` rather than chmod +x && ./script.
#
# init-letsencrypt.sh is committed mode 100644, so `chmod +x` flipped it to
# 100755 on every deploy. Git tracks the executable bit, so that counted as a
# local modification and aborted the NEXT `git pull`:
#     error: Your local changes to the following files would be overwritten by
#     merge: init-letsencrypt.sh
# i.e. running the deploy script made the next deploy impossible. Calling bash
# directly needs no exec bit and leaves the working tree clean.
bash ./init-letsencrypt.sh

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
