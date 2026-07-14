#!/usr/bin/env bash
# =============================================================================
# Polkadex Explorer — fresh Ubuntu 24.04 LTS provision + deploy
# =============================================================================
#
# Run this on a CLEAN Ubuntu 24.04 LTS VPS. It hardens the OS, installs Docker,
# clones the explorer repo, issues a TLS cert, and starts the stack. Idempotent
# — safe to re-run.
#
# Usage:
#   # Add your SSH public key to authorized_keys MANUALLY first
#   # (the script disables SSH password auth and root login).
#   sudo bash provision-ubuntu.sh                # all phases except cloudflare
#   sudo bash provision-ubuntu.sh all+cf         # all phases including cloudflare
#
#   # Or just one phase at a time:
#   sudo bash provision-ubuntu.sh harden         # OS hardening only
#   sudo bash provision-ubuntu.sh docker         # Docker install only
#   sudo bash provision-ubuntu.sh app            # App deploy only
#   sudo bash provision-ubuntu.sh backup         # Install nightly SQLite backup + cron
#                                                # (run AFTER app so backup.sh exists)
#   sudo bash provision-ubuntu.sh cloudflare     # Restrict 80/443 to Cloudflare ranges
#                                                # (run AFTER harden so UFW exists)
#   sudo bash provision-ubuntu.sh cf-origin-cert # Install a Cloudflare Origin Certificate
#                                                # for the frontend nginx, so CF's
#                                                # Full (strict) SSL mode validates the
#                                                # explorer's origin cert. See docs in
#                                                # setup_cf_origin_cert() for prerequisites.
#
# Configuration (override via env or edit at top):
#   DOMAIN              = TLS domain to issue a cert for
#   LETSENCRYPT_EMAIL   = email Let's Encrypt notifies on cert events
#   REPO_URL            = git URL for the explorer source
#   DEPLOY_DIR          = where to clone the repo
#   SSH_PORT            = if you want SSH on a non-22 port
#   ALLOW_PASSWORD_SSH  = "no" (default) | "yes" (NOT recommended)
#
# Before running:
#   1. Make sure your SSH key is in /root/.ssh/authorized_keys OR in the
#      deploy user's ~/.ssh/authorized_keys. Otherwise you'll lock yourself out.
#   2. Set the DOMAIN to point at this server's public IP first (so certbot
#      can validate it via HTTP-01).
#
# What this script will NOT do:
#   * Auto-import data from the previous (compromised) host. That's deliberate.
#     If you skip the import, the new server simply re-indexes from the
#     Polkadex RPC; the gap-fill code backfills missing history automatically
#     (slower start, but provably clean state).
#     If you DO want to seed the new server from a backup, see step 3 of the
#     post-deploy notes below — you can safely drop the explorer.db file (the
#     SQLite index of public blockchain data) into /opt/pdexplorer/data/.
#     Don't copy anything else from the old host.
#   * Migrate any /etc, /opt, or ~/ configuration files from the old server.
#     Anything beyond the .db file has to be re-verified against an
#     authoritative source (this repo on git) before you trust it.
# =============================================================================

set -euo pipefail

# ---- Configuration ---------------------------------------------------------
DOMAIN="${DOMAIN:-explorer.polkadex.ee}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-business@polkadex.ee}"
REPO_URL="${REPO_URL:-https://github.com/polkadexaj/pdexscan.git}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pdexplorer}"
SSH_PORT="${SSH_PORT:-22}"
ALLOW_PASSWORD_SSH="${ALLOW_PASSWORD_SSH:-no}"

# ---- Helpers ---------------------------------------------------------------
log()  { printf '\n\033[1;34m[provision]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
    [ "$(id -u)" -eq 0 ] || die "Run as root or via sudo."
}

require_ubuntu() {
    [ -r /etc/os-release ] || die "/etc/os-release missing — is this Ubuntu?"
    # shellcheck disable=SC1091
    . /etc/os-release
    [ "$ID" = "ubuntu" ] || die "This script targets Ubuntu only (got: $ID)."
    case "$VERSION_ID" in
        22.04|24.04) ;;
        *) warn "Tested on Ubuntu 22.04/24.04. You're on $VERSION_ID — proceed with care." ;;
    esac
}

apt_quiet() {
    DEBIAN_FRONTEND=noninteractive apt-get -qq -o=Dpkg::Use-Pty=0 "$@"
}

# ---- Phase 1: OS hardening -------------------------------------------------
harden_system() {
    log "Phase 1/3: OS hardening"

    log "Updating package index + upgrading installed packages"
    apt_quiet update
    apt_quiet -y upgrade
    apt_quiet -y install ca-certificates curl gnupg lsb-release software-properties-common \
        ufw fail2ban unattended-upgrades apt-listchanges \
        chrony watchdog jq rsync

    log "Enabling unattended-upgrades for security patches"
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
EOF
    cat >/etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
    systemctl enable --now unattended-upgrades.service >/dev/null
    ok "unattended-upgrades enabled (security only, no auto-reboot)"

    log "Configuring SSH (keys only, no root password login)"
    install -d -m 0755 /etc/ssh/sshd_config.d
    cat >/etc/ssh/sshd_config.d/00-hardening.conf <<EOF
# Hardening drop-in — overrides the defaults in /etc/ssh/sshd_config.
Port $SSH_PORT
PermitRootLogin prohibit-password
PasswordAuthentication $ALLOW_PASSWORD_SSH
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
LoginGraceTime 30
AllowAgentForwarding no
AllowTcpForwarding no
EOF
    # `sshd -t` fails with "Missing privilege separation directory: /run/sshd"
    # when that runtime dir doesn't exist yet — normal on a fresh boot before
    # ssh.service's ExecStartPre creates it. Create it so the check can run.
    install -d -m 0755 /run/sshd
    if ! sshd -t 2>/tmp/sshd-test.err; then
        cat /tmp/sshd-test.err >&2
        die "sshd config check failed — refusing to restart SSH"
    fi
    # Ubuntu 24.04 ships the unit as ssh.service (sshd is only sometimes an
    # alias); try both so the reload works regardless.
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    ok "SSH locked down (port $SSH_PORT, key-only, no root password)"

    log "Configuring UFW firewall (allow $SSH_PORT, 80, 443; deny everything else)"
    ufw --force reset >/dev/null
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow "$SSH_PORT/tcp" comment 'SSH'
    ufw allow 80/tcp  comment 'HTTP — nginx + certbot HTTP-01'
    ufw allow 443/tcp comment 'HTTPS — nginx'
    ufw --force enable >/dev/null
    ok "UFW active: $(ufw status | head -1)"

    log "Configuring fail2ban (jail SSH + nginx-noscript-buffer-overflow)"
    cat >/etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 4
backend  = systemd

[sshd]
enabled = true
port    = $SSH_PORT

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
EOF
    systemctl enable --now fail2ban >/dev/null
    ok "fail2ban enabled"

    log "Enabling persistent journald (so post-mortem logs survive reboots)"
    install -d -m 2755 -g systemd-journal /var/log/journal
    install -d -m 0755 /etc/systemd/journald.conf.d
    cat >/etc/systemd/journald.conf.d/persistent.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=500M
RuntimeMaxUse=100M
ForwardToSyslog=no
EOF
    systemctl restart systemd-journald
    ok "Journals → /var/log/journal (500M cap)"

    log "Loading softdog kernel watchdog"
    if modprobe softdog 2>/dev/null; then
        echo softdog >/etc/modules-load.d/softdog.conf
        # Configure watchdog daemon to ping /dev/watchdog.
        sed -i 's|^#\?watchdog-device.*|watchdog-device = /dev/watchdog|' /etc/watchdog.conf
        sed -i 's|^#\?max-load-1.*|max-load-1 = 24|' /etc/watchdog.conf
        systemctl enable --now watchdog
        ok "softdog + watchdog daemon active"
    else
        warn "softdog module unavailable — skipping (ask your VPS provider to expose a hardware watchdog)"
    fi

    log "Hardening /etc/fstab (add nofail to non-root mounts)"
    # If /boot or swap is on a separate device, add nofail so a slow disk on
    # boot doesn't drop us into emergency mode.
    if grep -E '^\s*UUID=.*\s+/boot\s' /etc/fstab >/dev/null && ! grep -E '^\s*UUID=.*\s+/boot\s+.*nofail' /etc/fstab >/dev/null; then
        sed -ri 's|(^\s*UUID=[a-fA-F0-9-]+\s+/boot\s+\S+\s+)(\S+)|\1\2,nofail,x-systemd.device-timeout=10s|' /etc/fstab
        ok "/boot marked nofail"
    fi
    if grep -E '\s+swap\s+' /etc/fstab >/dev/null && ! grep -E '\s+swap\s+\S*nofail' /etc/fstab >/dev/null; then
        sed -ri 's|(^\s*UUID=[a-fA-F0-9-]+\s+none\s+swap\s+)(\S+)|\1\2,nofail,x-systemd.device-timeout=10s|' /etc/fstab
        ok "swap marked nofail"
    fi
    systemctl daemon-reload

    log "Configuring emergency.service to auto-resume after 60s"
    install -d -m 0755 /etc/systemd/system/emergency.service.d
    cat >/etc/systemd/system/emergency.service.d/auto-resume.conf <<'EOF'
[Service]
# If we land in emergency, give an operator a minute to react via console,
# then reboot. Combined with nofail in /etc/fstab + softdog, the second
# boot usually succeeds and the VM self-heals.
ExecStartPost=/bin/sh -c 'sleep 60; systemctl --no-block reboot'
EOF
    systemctl daemon-reload
    ok "emergency.target auto-resumes after 60s"

    log "Enabling time sync (chrony)"
    systemctl enable --now chrony >/dev/null
    ok "Time sync active"

    log "Hardening sysctl (network + kernel)"
    cat >/etc/sysctl.d/99-explorer-hardening.conf <<'EOF'
# Network stack hardening
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.log_martians = 1

# Kernel hardening
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
kernel.yama.ptrace_scope = 2
EOF
    sysctl --quiet --system >/dev/null || warn "sysctl reload had warnings"
    ok "sysctl hardening applied"

    log "Phase 1 complete."
}

# ---- Phase 2: Docker -------------------------------------------------------
install_docker() {
    log "Phase 2/3: Docker"

    if command -v docker >/dev/null 2>&1; then
        ok "Docker already installed: $(docker --version)"
    else
        log "Installing Docker CE + Compose plugin from the official apt repo"
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
            > /etc/apt/sources.list.d/docker.list
        apt_quiet update
        apt_quiet -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        ok "Docker installed"
    fi

    log "Configuring Docker log rotation + safer defaults"
    install -d -m 0755 /etc/docker
    cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true,
  "userland-proxy": false,
  "icc": false
}
EOF
    systemctl enable --now docker >/dev/null
    systemctl restart docker
    ok "Docker daemon hardened (log rotation, no-new-privileges, ICC off)"

    log "Phase 2 complete."
}

# ---- Phase 3: App deploy ---------------------------------------------------
deploy_app() {
    log "Phase 3/3: Explorer deploy"

    [ -n "$DOMAIN" ] || die "DOMAIN is empty — refusing to deploy without a domain."
    [ -n "$LETSENCRYPT_EMAIL" ] || die "LETSENCRYPT_EMAIL is empty."

    log "Resolving $DOMAIN to confirm it points here"
    THIS_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.io || echo unknown)"
    DOMAIN_IP="$(dig +short "$DOMAIN" A | tail -1 || echo unknown)"
    if [ "$THIS_IP" != "unknown" ] && [ "$DOMAIN_IP" != "unknown" ] && [ "$THIS_IP" != "$DOMAIN_IP" ]; then
        warn "$DOMAIN currently resolves to $DOMAIN_IP, this server is $THIS_IP."
        warn "Certbot HTTP-01 will fail until DNS points here. Continuing anyway."
    fi

    log "Cloning fresh repo from $REPO_URL to $DEPLOY_DIR"
    if [ -d "$DEPLOY_DIR/.git" ]; then
        ok "$DEPLOY_DIR already exists — pulling latest"
        git -C "$DEPLOY_DIR" fetch --all --prune
        git -C "$DEPLOY_DIR" reset --hard origin/HEAD
    else
        install -d -m 0755 "$(dirname "$DEPLOY_DIR")"
        git clone --depth 1 "$REPO_URL" "$DEPLOY_DIR"
    fi
    cd "$DEPLOY_DIR"

    log "Preparing data directory (chown to uid 1000 for the rootless container)"
    # mkdir + chown rather than `install -o 1000 -g 1000` because on a fresh
    # cloud image there's usually no *named* user at uid 1000 yet, and some
    # `install` builds reject the numeric form with "invalid user: '1000'".
    # `chown 1000:1000` accepts a bare numeric id; the `+1000:+1000` fallback
    # forces the numeric interpretation on stricter chown variants.
    mkdir -p "$DEPLOY_DIR/data"
    chmod 0750 "$DEPLOY_DIR/data"
    chown 1000:1000 "$DEPLOY_DIR/data" 2>/dev/null \
        || chown '+1000:+1000' "$DEPLOY_DIR/data"
    install -d -m 0755 "$DEPLOY_DIR/certbot/conf"
    install -d -m 0755 "$DEPLOY_DIR/certbot/www"

    log "Writing .env (override DOMAIN / LETSENCRYPT_EMAIL via env or edit later)"
    if [ ! -f .env ]; then
        cat >.env <<EOF
# Generated by provision-ubuntu.sh. Edit and then:
#     docker compose up -d --build backend
# (rebuild is required for the new env to land in the running container).
# See .env.example for the full list of supported knobs.

# ---- TLS / certbot
DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL

# ---- Data path (host bind-mount → /app/data inside the backend container)
DATA_PATH=$DEPLOY_DIR/data

# ---- Chain RPC (comma-separated WS endpoints; first = primary)
# rpc.polkadex.ee is the Cloudflare Load Balancer endpoint that fronts the
# origin pool. Override with `ws://127.0.0.1:9944` if you run a local node.
POLKADEX_WS=wss://rpc.polkadex.ee

# ---- API
ALLOWED_ORIGINS=https://$DOMAIN
SITE_URL=https://$DOMAIN

# ---- Price feed (leave empty to disable). Get a free key at coinmarketcap.com.
CMC_API_KEY=

# ---- Indexer tuning (uncomment to raise per-tick batch sizes).
# Doubling these is safe with the current code — see README for guidance.
# BLOCKS_FORWARD_MAX=500
# BLOCKS_BACKFILL_CHUNK=200
# BLOCKS_GAP_FILL_CHUNK=100
# BLOCKS_FETCH_CONCURRENCY=8
# SYNC_BACKOFF_MS=60000
EOF
        chmod 0640 .env
        ok ".env created"
    else
        ok ".env already present (preserving)"
    fi

    log "Preparing TLS helper files (options-ssl-nginx.conf, ssl-dhparams.pem)"
    # nginx.conf `include`s these from /etc/letsencrypt/. If they're missing
    # nginx fails to start with "open() options-ssl-nginx.conf failed". They
    # are normally created by certbot the first time it runs — bootstrap them
    # here so nginx can come up before certbot has any cert at all.
    install -d certbot/conf
    if [ ! -s certbot/conf/options-ssl-nginx.conf ]; then
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
            -o certbot/conf/options-ssl-nginx.conf \
            || warn "Could not download options-ssl-nginx.conf; nginx may not start"
    fi
    if [ ! -s certbot/conf/ssl-dhparams.pem ]; then
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
            -o certbot/conf/ssl-dhparams.pem \
            || warn "Could not download ssl-dhparams.pem; nginx may not start"
    fi

    log "Issuing Let's Encrypt cert for $DOMAIN (HTTP-01 challenge)"
    if [ ! -f "certbot/conf/live/$DOMAIN/fullchain.pem" ]; then
        if [ -x ./init-letsencrypt.sh ]; then
            ./init-letsencrypt.sh
            ok "Cert bootstrapped via init-letsencrypt.sh"
        else
            warn "init-letsencrypt.sh missing — issuing a self-signed placeholder so nginx can start."
            install -d "certbot/conf/live/$DOMAIN"
            openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
                -keyout "certbot/conf/live/$DOMAIN/privkey.pem" \
                -out "certbot/conf/live/$DOMAIN/fullchain.pem" \
                -subj "/CN=$DOMAIN" >/dev/null 2>&1
            warn "Replace with a real cert via certbot once the stack is up:"
            warn "  docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d $DOMAIN -m $LETSENCRYPT_EMAIL --agree-tos --non-interactive"
            warn "  docker compose exec frontend nginx -s reload"
        fi
    else
        ok "Cert already present at certbot/conf/live/$DOMAIN/"
    fi

    log "Building + starting the explorer stack"
    docker compose down --remove-orphans || true
    docker compose pull --ignore-pull-failures || true
    docker compose up -d --build
    ok "Stack started"

    log "Health check"
    sleep 5
    if curl -fsS --max-time 10 "http://127.0.0.1/api/network-info" >/dev/null 2>&1; then
        ok "Backend reachable through nginx"
    else
        warn "Backend not yet responding through nginx — check 'docker compose logs backend frontend'"
    fi

    log "Cleaning up dangling images"
    docker image prune -f >/dev/null || true

    log "Phase 3 complete."
}

# ---- Phase 4 (optional): Cloudflare-only firewall --------------------------
# When the site is fronted by Cloudflare's proxy, only Cloudflare's edge nodes
# should be able to reach 80/443 on the origin. Direct hits to the VPS IP
# (bypassing Cloudflare's WAF / rate limits / DDoS protection) get dropped.

# Generate the DOCKER-USER block in /etc/ufw/after.rules from the Cloudflare
# IP lists. Idempotent — the block is replaced between BEGIN/END markers so
# repeated calls don't accumulate stale rules. Called from both the cloudflare
# phase and the periodic refresh script, so it lives at the file-scope here.
write_docker_user_block() {
    local v4_file="$1"
    local v6_file="$2"
    local after_rules=/etc/ufw/after.rules
    local marker_begin='# BEGIN cloudflare-docker-user (managed by provision-ubuntu.sh)'
    local marker_end='# END cloudflare-docker-user'

    # Build the new block into a temp file
    local tmp_block
    tmp_block=$(mktemp)
    {
        echo "$marker_begin"
        echo "*filter"
        echo ":DOCKER-USER - [0:0]"
        echo "# Allow loopback so containers can talk to host services."
        echo "-A DOCKER-USER -i lo -j RETURN"
        echo "# Allow established/related so return packets reach the original sender."
        echo "-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
        echo "# Allow inter-container traffic (default Docker bridge network)."
        echo "-A DOCKER-USER -s 172.16.0.0/12 -j RETURN"
        echo "# Per-CIDR ACCEPT for Cloudflare-only 80/443 origin access."
        while IFS= read -r cidr; do
            [ -z "$cidr" ] && continue
            echo "-A DOCKER-USER -p tcp -s $cidr -m multiport --dports 80,443 -j RETURN"
        done < "$v4_file"
        echo "# Default-drop for any other traffic targeting 80/443 on containers."
        echo "-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP"
        echo "# Everything else (other published container ports) passes through."
        echo "-A DOCKER-USER -j RETURN"
        echo "COMMIT"
        echo "$marker_end"
    } > "$tmp_block"

    # Also build the IPv6 block (separate *filter table for ip6tables).
    local tmp_block6
    tmp_block6=$(mktemp)
    {
        echo "# BEGIN cloudflare-docker-user-v6 (managed by provision-ubuntu.sh)"
        echo "*filter"
        echo ":DOCKER-USER - [0:0]"
        echo "-A DOCKER-USER -i lo -j RETURN"
        echo "-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
        while IFS= read -r cidr; do
            [ -z "$cidr" ] && continue
            echo "-A DOCKER-USER -p tcp -s $cidr -m multiport --dports 80,443 -j RETURN"
        done < "$v6_file"
        echo "-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP"
        echo "-A DOCKER-USER -j RETURN"
        echo "COMMIT"
        echo "# END cloudflare-docker-user-v6"
    } > "$tmp_block6"

    # Splice into /etc/ufw/after.rules (v4) and /etc/ufw/after6.rules (v6)
    splice_managed_block "$after_rules" "$marker_begin" "$marker_end" "$tmp_block"
    splice_managed_block /etc/ufw/after6.rules \
        '# BEGIN cloudflare-docker-user-v6 (managed by provision-ubuntu.sh)' \
        '# END cloudflare-docker-user-v6' "$tmp_block6"

    rm -f "$tmp_block" "$tmp_block6"
}

# Insert (or replace) a managed block bounded by two marker lines in a file.
# Appends the block if no existing block is found.
splice_managed_block() {
    local target="$1"
    local marker_begin="$2"
    local marker_end="$3"
    local payload="$4"

    [ -f "$target" ] || die "Target file missing: $target"

    if grep -qF "$marker_begin" "$target"; then
        # Replace the existing block in-place.
        local tmp
        tmp=$(mktemp)
        awk -v b="$marker_begin" -v e="$marker_end" -v f="$payload" '
            $0 == b { skip=1; while ((getline line < f) > 0) print line; close(f); next }
            skip && $0 == e { skip=0; next }
            !skip { print }
        ' "$target" > "$tmp"
        mv "$tmp" "$target"
    else
        # Append before COMMIT if a *filter section exists, else just append.
        printf '\n%s\n' "$(cat "$payload")" >> "$target"
    fi
}

setup_cloudflare_only() {
    log "Phase 4: Cloudflare-only firewall"

    # Pre-flight: this phase mutates UFW rules and assumes the harden phase
    # already set up the base policy (default deny + SSH/80/443 open). Running
    # it on a host without UFW would either error cryptically or leave the
    # firewall in a partial state. Refuse early with an actionable message.
    command -v ufw >/dev/null 2>&1 \
        || die "UFW not installed. Run 'sudo bash $0 harden' first."
    ufw status 2>/dev/null | grep -q 'Status: active' \
        || die "UFW is not active. Run 'sudo bash $0 harden' first."
    ufw status 2>/dev/null | grep -qE "^${SSH_PORT}/tcp +ALLOW" \
        || warn "SSH on port ${SSH_PORT} is not explicitly allowed in UFW. " \
                "Confirm you have another way in (console / session in progress) before continuing."

    local cf_dir=/etc/cloudflare
    install -d -m 0755 "$cf_dir"

    log "Fetching Cloudflare IP ranges (https://www.cloudflare.com/ips-v4 and -v6)"
    curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v4 -o "$cf_dir/ips-v4" \
        || die "Could not fetch ips-v4 — aborting (host firewall would lock you out of port 80/443)."
    curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v6 -o "$cf_dir/ips-v6" \
        || die "Could not fetch ips-v6."
    ok "Got $(wc -l <"$cf_dir/ips-v4") IPv4 + $(wc -l <"$cf_dir/ips-v6") IPv6 ranges"

    log "Replacing generic UFW 80/443 rules with Cloudflare-only allow rules"
    # Strip any existing 80/443 rules (numbered, so iterate from the bottom up
    # to keep the rule numbers stable as we delete).
    ufw status numbered 2>/dev/null \
        | awk -F'[][]' '/(^\[ *[0-9]+\] +80|^\[ *[0-9]+\] +443)/ {print $2}' \
        | sort -rn \
        | while read -r n; do yes | ufw delete "$n" >/dev/null 2>&1 || true; done

    while IFS= read -r cidr; do
        [ -z "$cidr" ] && continue
        ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy' >/dev/null
        ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy' >/dev/null
    done < "$cf_dir/ips-v4"
    while IFS= read -r cidr; do
        [ -z "$cidr" ] && continue
        ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy v6' >/dev/null
        ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy v6' >/dev/null
    done < "$cf_dir/ips-v6"
    ufw reload >/dev/null
    ok "UFW 80/443 now restricted to Cloudflare ranges only (host-bound traffic)"

    # ---- DOCKER-USER chain filtering ----
    # UFW's `ufw allow ... port 80` rules only filter traffic destined for the
    # host's INPUT chain. Traffic destined for ports published by Docker
    # containers (`docker run -p 80:80`) traverses the FORWARD/DOCKER chains
    # instead, skipping UFW entirely. Without the block below, anyone on the
    # internet can reach the nginx container directly via the origin IP,
    # bypassing Cloudflare's WAF, rate limits, and edge cache.
    #
    # The DOCKER-USER chain is processed BEFORE DOCKER's DNAT rules — exactly
    # the right insertion point. We add an explicit ACCEPT for each Cloudflare
    # CIDR, then a default DROP for 80/443. Loopback and ESTABLISHED traffic
    # are returned early so internal compose-network traffic is unaffected.
    #
    # Lives in /etc/ufw/after.rules so `ufw reload` re-applies it.
    log "Adding DOCKER-USER chain filter to /etc/ufw/after.rules (closes the Docker-bypass-UFW gap)"
    write_docker_user_block "$cf_dir/ips-v4" "$cf_dir/ips-v6"
    ufw reload >/dev/null
    ok "DOCKER-USER chain now drops non-Cloudflare traffic to 80/443"

    log "Installing weekly refresh systemd timer (Cloudflare publishes range changes occasionally)"
    cat >/usr/local/sbin/cloudflare-ufw-refresh <<'EOF'
#!/usr/bin/env bash
# Refresh UFW rules + DOCKER-USER block with Cloudflare's current IP ranges.
# Runs weekly via cloudflare-ufw-refresh.timer. Idempotent — no-op when ranges
# haven't changed.
set -euo pipefail
cf_dir=/etc/cloudflare
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v4 -o "$tmp/ips-v4"
curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v6 -o "$tmp/ips-v6"
[ -s "$tmp/ips-v4" ] && [ -s "$tmp/ips-v6" ] || { echo "empty Cloudflare lists, refusing"; exit 1; }
if diff -q "$tmp/ips-v4" "$cf_dir/ips-v4" >/dev/null 2>&1 && \
   diff -q "$tmp/ips-v6" "$cf_dir/ips-v6" >/dev/null 2>&1; then
    exit 0   # no change
fi
# Drop old Cloudflare rules.
ufw status numbered 2>/dev/null \
    | awk -F'[][]' '/Cloudflare proxy/ {print $2}' \
    | sort -rn \
    | while read -r n; do yes | ufw delete "$n" >/dev/null 2>&1 || true; done
# Add new UFW rules (host-bound traffic).
while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy' >/dev/null
    ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy' >/dev/null
done < "$tmp/ips-v4"
while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy v6' >/dev/null
    ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy v6' >/dev/null
done < "$tmp/ips-v6"
mv "$tmp/ips-v4" "$cf_dir/ips-v4"
mv "$tmp/ips-v6" "$cf_dir/ips-v6"

# Regenerate the DOCKER-USER block in /etc/ufw/after{,6}.rules so traffic
# destined for Docker-published ports is also filtered to Cloudflare-only.
# This MUST stay in sync with the host-bound UFW rules above.
rewrite_docker_user_block() {
    local v4_file="$1"
    local v6_file="$2"
    local after_rules=/etc/ufw/after.rules
    local after6_rules=/etc/ufw/after6.rules
    local marker_begin='# BEGIN cloudflare-docker-user (managed by provision-ubuntu.sh)'
    local marker_end='# END cloudflare-docker-user'
    local marker_begin6='# BEGIN cloudflare-docker-user-v6 (managed by provision-ubuntu.sh)'
    local marker_end6='# END cloudflare-docker-user-v6'

    local tmp_block tmp_block6
    tmp_block=$(mktemp); tmp_block6=$(mktemp)
    {
        echo "$marker_begin"
        echo "*filter"
        echo ":DOCKER-USER - [0:0]"
        echo "-A DOCKER-USER -i lo -j RETURN"
        echo "-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
        echo "-A DOCKER-USER -s 172.16.0.0/12 -j RETURN"
        while IFS= read -r cidr; do
            [ -z "$cidr" ] && continue
            echo "-A DOCKER-USER -p tcp -s $cidr -m multiport --dports 80,443 -j RETURN"
        done < "$v4_file"
        echo "-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP"
        echo "-A DOCKER-USER -j RETURN"
        echo "COMMIT"
        echo "$marker_end"
    } > "$tmp_block"
    {
        echo "$marker_begin6"
        echo "*filter"
        echo ":DOCKER-USER - [0:0]"
        echo "-A DOCKER-USER -i lo -j RETURN"
        echo "-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
        while IFS= read -r cidr; do
            [ -z "$cidr" ] && continue
            echo "-A DOCKER-USER -p tcp -s $cidr -m multiport --dports 80,443 -j RETURN"
        done < "$v6_file"
        echo "-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j DROP"
        echo "-A DOCKER-USER -j RETURN"
        echo "COMMIT"
        echo "$marker_end6"
    } > "$tmp_block6"

    for pair in "$after_rules|$marker_begin|$marker_end|$tmp_block" \
                "$after6_rules|$marker_begin6|$marker_end6|$tmp_block6"; do
        IFS='|' read -r target mb me pf <<< "$pair"
        if grep -qF "$mb" "$target"; then
            local out
            out=$(mktemp)
            awk -v b="$mb" -v e="$me" -v f="$pf" '
                $0 == b { skip=1; while ((getline line < f) > 0) print line; close(f); next }
                skip && $0 == e { skip=0; next }
                !skip { print }
            ' "$target" > "$out"
            mv "$out" "$target"
        else
            printf '\n%s\n' "$(cat "$pf")" >> "$target"
        fi
    done
    rm -f "$tmp_block" "$tmp_block6"
}
rewrite_docker_user_block "$cf_dir/ips-v4" "$cf_dir/ips-v6"

ufw reload >/dev/null
logger -t cloudflare-ufw-refresh "Updated UFW + DOCKER-USER with new Cloudflare ranges"
EOF
    chmod +x /usr/local/sbin/cloudflare-ufw-refresh

    cat >/etc/systemd/system/cloudflare-ufw-refresh.service <<'EOF'
[Unit]
Description=Refresh UFW with current Cloudflare IP ranges
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cloudflare-ufw-refresh
EOF
    cat >/etc/systemd/system/cloudflare-ufw-refresh.timer <<'EOF'
[Unit]
Description=Weekly refresh of Cloudflare UFW rules

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now cloudflare-ufw-refresh.timer >/dev/null
    ok "Weekly refresh timer enabled (next run: $(systemctl show -p NextElapseUSecRealtime --value cloudflare-ufw-refresh.timer 2>/dev/null || echo unknown))"

    cat <<'EOF'

  Reminder — Cloudflare-related operational notes:

  * On Cloudflare's dashboard, the DNS record for this domain must be set to
    "Proxied" (orange cloud) for this firewall posture to make sense. If it
    is "DNS only" (grey cloud), the firewall will silently block all visitors.

  * Let's Encrypt HTTP-01 challenges will NOT work while CF proxy is enabled,
    because the challenge hits Cloudflare, not the origin. Three options:
      (a) Temporarily set the DNS record to "DNS only" while certbot runs.
      (b) Use DNS-01 challenge with the Cloudflare API plugin (recommended
          for production — survives renewals unattended).
      (c) Add a Page Rule that bypasses CF cache+proxy for
          /.well-known/acme-challenge/* (works but is fragile).

  * Cloudflare SSL mode should be "Full (Strict)" so CF validates the
    origin's TLS cert. Anything else either disables encryption between CF
    and origin, or accepts invalid certs.

EOF
}

# ---- Phase 4.5 (optional): Cloudflare Origin Certificate -------------------
# Install a Cloudflare Origin Certificate for the frontend nginx so CF's
# `Full (strict)` SSL mode validates the connection from CF to origin.
#
# Background:
#   Cloudflare's `Full` mode uses HTTPS to the origin but doesn't validate the
#   cert. `Full (strict)` validates — and accepts EITHER a publicly-trusted
#   cert (Let's Encrypt) OR a CF Origin Certificate (signed by Cloudflare's
#   own CA, only valid for CF <-> origin traffic, 15-year lifetime, no
#   renewal needed). For a CF-fronted explorer where direct hits to the
#   origin are firewall-blocked anyway, CF Origin Cert is simpler than LE.
#
# Prerequisites (operator must do this BEFORE running the phase):
#   1. In Cloudflare dashboard: SSL/TLS -> Origin Server -> Create Certificate.
#      Defaults are fine (RSA, 15-year, hostnames: *.polkadex.ee, polkadex.ee).
#   2. Copy the certificate body and private key into two files on the host:
#        $DEPLOY_DIR/secrets/cloudflare-origin.pem    (certificate)
#        $DEPLOY_DIR/secrets/cloudflare-origin.key    (private key)
#      Both files should be `chmod 600` and owned by root.
#   3. Run this phase. It validates, installs to the path nginx already
#      expects (frontend container's /etc/letsencrypt/live/$DOMAIN/), and
#      restarts the frontend.
#
# Idempotent: re-runs replace existing files with whatever is in
# $DEPLOY_DIR/secrets/, so the operator can rotate certs the same way.
setup_cf_origin_cert() {
    log "Phase 4.5: Cloudflare Origin Certificate for frontend nginx"

    local secrets_dir="$DEPLOY_DIR/secrets"
    local src_cert="$secrets_dir/cloudflare-origin.pem"
    local src_key="$secrets_dir/cloudflare-origin.key"
    local dst_dir="$DEPLOY_DIR/certbot/conf/live/$DOMAIN"
    local dst_cert="$dst_dir/fullchain.pem"
    local dst_key="$dst_dir/privkey.pem"

    # ---- Pre-flight: secrets files must exist ----
    [ -r "$src_cert" ] || die "Missing $src_cert. See setup_cf_origin_cert() docs — put the CF Origin Certificate there before running this phase."
    [ -r "$src_key"  ] || die "Missing $src_key. See setup_cf_origin_cert() docs — put the CF Origin private key there before running this phase."

    # ---- Validate cert + key with openssl ----
    log "Validating cert format"
    command -v openssl >/dev/null 2>&1 || apt-get install -y -qq openssl >/dev/null
    openssl x509 -in "$src_cert" -noout >/dev/null 2>&1 \
        || die "$src_cert is not a valid PEM-encoded X.509 certificate."
    openssl rsa  -in "$src_key" -check -noout >/dev/null 2>&1 \
        || openssl pkey -in "$src_key" -noout >/dev/null 2>&1 \
        || die "$src_key is not a valid PEM-encoded private key."

    # Belt-and-braces: confirm cert and key are a matched pair (their public
    # key fingerprints must agree). Catches the embarrassing case of pasting
    # a cert from one host and a key from another.
    local cert_pub key_pub
    cert_pub=$(openssl x509 -in "$src_cert" -noout -pubkey 2>/dev/null | openssl md5)
    key_pub=$(openssl pkey -in "$src_key" -pubout 2>/dev/null | openssl md5)
    [ "$cert_pub" = "$key_pub" ] \
        || die "Certificate and key do not match (different public keys). Re-paste both from the same CF Origin certificate."

    # Confirm the cert covers $DOMAIN (so the operator catches a wildcard-mismatch
    # error here rather than from CF's monitor an hour later).
    local sans
    sans=$(openssl x509 -in "$src_cert" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')
    case "$sans" in
        *"DNS:$DOMAIN"*|*"DNS:*.${DOMAIN#*.}"*) ok "Cert covers $DOMAIN (or its parent wildcard)" ;;
        *) warn "Cert SAN does not appear to cover $DOMAIN. SANs found: $sans. Continuing — verify manually if unsure." ;;
    esac

    # Cert expiry warning (CF Origin Certs are 15 years; an unusually short
    # expiry is a sign of accidental LE-paste).
    local not_after days_left
    not_after=$(openssl x509 -in "$src_cert" -noout -enddate | cut -d= -f2)
    days_left=$(( ( $(date -d "$not_after" +%s) - $(date +%s) ) / 86400 ))
    log "Cert valid until $not_after ($days_left days from now)"
    [ "$days_left" -gt 30 ] || warn "Cert expires in $days_left days — that's unusual for a CF Origin Cert (which default to 15 years). Double-check you pasted the right content."

    # ---- Install into the path nginx already expects ----
    # The frontend container's nginx.conf hard-codes the LE-style paths
    # /etc/letsencrypt/live/$DOMAIN/{fullchain,privkey}.pem. The compose
    # mount maps $DEPLOY_DIR/certbot/conf -> /etc/letsencrypt, so writing to
    # $dst_cert/$dst_key on the host shows up at the LE paths in the container.
    log "Installing certificate at $dst_cert"
    install -d -m 0755 "$dst_dir"
    install -m 0644 "$src_cert" "$dst_cert"
    install -m 0600 "$src_key"  "$dst_key"
    ok "Certificate + key installed for $DOMAIN"

    # ---- Generate support files nginx.conf references ----
    # The frontend nginx config does:
    #     include /etc/letsencrypt/options-ssl-nginx.conf;
    #     ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    # These are normally provided by certbot. If we never ran certbot,
    # generate sane equivalents so nginx starts.
    local options_file="$DEPLOY_DIR/certbot/conf/options-ssl-nginx.conf"
    local dhparams_file="$DEPLOY_DIR/certbot/conf/ssl-dhparams.pem"

    if [ ! -s "$options_file" ]; then
        log "Generating options-ssl-nginx.conf (modern TLS defaults)"
        cat >"$options_file" <<'EOF'
# Generated by provision-ubuntu.sh (cf-origin-cert phase).
# Mirrors certbot's options-ssl-nginx.conf so nginx starts even when
# certbot has not run on this host.
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;

ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
EOF
        chmod 0644 "$options_file"
    else
        ok "options-ssl-nginx.conf already present — leaving as-is"
    fi

    if [ ! -s "$dhparams_file" ]; then
        log "Generating ssl-dhparams.pem (2048-bit; this takes ~10s)"
        openssl dhparam -dsaparam -out "$dhparams_file" 2048 2>/dev/null
        chmod 0644 "$dhparams_file"
        ok "ssl-dhparams.pem generated"
    else
        ok "ssl-dhparams.pem already present — leaving as-is"
    fi

    # ---- Restart the frontend container so nginx reloads with new cert ----
    log "Restarting frontend container to pick up new cert"
    if [ -f "$DEPLOY_DIR/docker-compose.yml" ]; then
        (cd "$DEPLOY_DIR" && docker compose restart frontend >/dev/null 2>&1) \
            || warn "Could not restart frontend container — restart manually: cd $DEPLOY_DIR && docker compose restart frontend"

        # Smoke test: is nginx in the container actually serving HTTPS now?
        sleep 3
        if docker compose -f "$DEPLOY_DIR/docker-compose.yml" exec -T frontend \
            sh -c 'nginx -t' >/dev/null 2>&1; then
            ok "nginx -t passed inside frontend container"
        else
            warn "nginx -t failed inside frontend container — inspect with: docker compose logs frontend"
        fi
    else
        warn "$DEPLOY_DIR/docker-compose.yml not found — restart the frontend manually after running the app phase."
    fi

    cat <<EOF

  Cloudflare Origin Certificate installed at:
    $dst_cert
    $dst_key

  You can now switch Cloudflare SSL mode to Full (strict) safely:
    Dashboard -> SSL/TLS -> Overview -> Full (strict)

  Verify from any host:
    curl -sI https://$DOMAIN/ | head -3

  To rotate the cert later: replace the files in $secrets_dir/ and re-run
  this phase. The frontend container will restart with the new cert.

EOF
}

# ---- Phase 5: SQLite nightly backup ---------------------------------------
# Installs sqlite3, copies backup.sh into $DEPLOY_DIR (the repo's working copy
# is what runs — symlink would let a `git pull` silently change behavior),
# creates the backups dir, and drops a cron entry that runs at 03:00 UTC
# nightly. Idempotent — re-running just updates the script and cron file.
setup_backups() {
    log "Phase 5: SQLite nightly backup"

    log "Installing sqlite3 CLI (needed for online .backup)"
    apt-get update -qq >/dev/null
    apt-get install -y -qq sqlite3 >/dev/null
    ok "sqlite3 $(sqlite3 --version | awk '{print $1}') installed"

    local script_src="$DEPLOY_DIR/backup.sh"
    local script_dst="$DEPLOY_DIR/backup.sh"
    [ -f "$script_src" ] || die "backup.sh not found in $DEPLOY_DIR — run \`app\` phase first."

    log "Ensuring backup.sh is executable"
    chmod 0750 "$script_dst"
    ok "$script_dst (mode 0750)"

    # Backups live OUTSIDE the deploy directory now (was $DEPLOY_DIR/backups
    # in older revisions). Keeping them under /var/backup means they're not in
    # the Docker build context, not in the repo, and not deleted by a stray
    # `git clean -fdx` or `docker compose down -v`. Idempotent — if the dir
    # already exists, the mode is reasserted.
    local backup_dir="/var/backup"
    log "Creating backups directory at $backup_dir"
    install -d -m 0750 "$backup_dir"
    ok "$backup_dir (mode 0750)"

    # Migrate any pre-existing backups from the legacy location to the new
    # one. Move (not copy) so storage doesn't double. Idempotent — if the
    # legacy dir doesn't exist or is empty, the loop is a no-op.
    local legacy_dir="$DEPLOY_DIR/backups"
    if [ -d "$legacy_dir" ] && [ -n "$(ls -A "$legacy_dir" 2>/dev/null)" ]; then
        log "Migrating existing backups from $legacy_dir to $backup_dir"
        mv "$legacy_dir"/* "$backup_dir/" 2>/dev/null || true
        rmdir "$legacy_dir" 2>/dev/null || log "  (legacy dir not empty after move — leaving in place)"
        ok "Migrated"
    fi

    log "Writing /etc/cron.d/pdexplorer-backup (runs nightly at 03:00 UTC)"
    cat > /etc/cron.d/pdexplorer-backup <<EOF
# Polkadex Explorer SQLite backup — written by provision-ubuntu.sh.
# Runs $script_dst at 03:00 UTC every night. Output is appended to
# /var/log/pdexplorer-backup.log; rotate via /etc/logrotate.d/pdexplorer-backup.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
0 3 * * * root $script_dst >> /var/log/pdexplorer-backup.log 2>&1
EOF
    # cron silently ignores files with the wrong perms — must be 644 and root-owned.
    chown root:root /etc/cron.d/pdexplorer-backup
    chmod 0644 /etc/cron.d/pdexplorer-backup
    ok "/etc/cron.d/pdexplorer-backup (root:root 0644)"

    log "Setting up log rotation for /var/log/pdexplorer-backup.log"
    cat > /etc/logrotate.d/pdexplorer-backup <<'EOF'
/var/log/pdexplorer-backup.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root adm
}
EOF
    ok "/etc/logrotate.d/pdexplorer-backup"

    # Touch the log file so the first cron run has somewhere to append.
    touch /var/log/pdexplorer-backup.log
    chmod 0640 /var/log/pdexplorer-backup.log

    log "Running a one-shot backup now to verify the pipeline"
    if [ -f "$DEPLOY_DIR/data/explorer.db" ]; then
        if "$script_dst" >> /var/log/pdexplorer-backup.log 2>&1; then
            ok "Initial backup succeeded — see /var/log/pdexplorer-backup.log"
        else
            warn "Initial backup failed — check /var/log/pdexplorer-backup.log"
            warn "Cron is still installed and will retry tonight at 03:00 UTC."
        fi
    else
        warn "explorer.db doesn't exist yet — skipping the one-shot run."
        warn "Cron will pick up the first real backup once the indexer has written data."
    fi

    log "Phase 5 complete."
}

# ---- Final summary ---------------------------------------------------------
summary() {
    cat <<EOF

============================================================================
  Provisioning summary
----------------------------------------------------------------------------
  Hostname        : $(hostname -f 2>/dev/null || hostname)
  Public IP       : $(curl -fsS https://api.ipify.org 2>/dev/null || echo unknown)
  SSH port        : $SSH_PORT  (key-only auth, root password login disabled)
  Firewall (UFW)  : $(ufw status | head -1 | awk '{print $2}')
  fail2ban        : $(systemctl is-active fail2ban)
  Watchdog        : $(systemctl is-active watchdog 2>/dev/null || echo n/a)
  Journal storage : $(grep -oP 'Storage=\K\S+' /etc/systemd/journald.conf.d/persistent.conf 2>/dev/null || echo volatile)
  Docker          : $(docker --version 2>/dev/null || echo not-installed)
  Backup cron     : $([ -f /etc/cron.d/pdexplorer-backup ] && echo "active (nightly 03:00 UTC)" || echo "not installed")
  Backups dir     : $DEPLOY_DIR/backups$([ -d "$DEPLOY_DIR/backups" ] && echo " ($(find "$DEPLOY_DIR/backups" -maxdepth 1 -name 'explorer-*.db*' 2>/dev/null | wc -l) file(s))" || echo " (not created yet)")
  Domain          : $DOMAIN
  Deploy dir      : $DEPLOY_DIR
============================================================================

Next steps:
  1. SSH back in on port $SSH_PORT to confirm key-only auth works BEFORE
     closing this session.
  2. Set up an external uptime monitor on https://$DOMAIN/api/network-info
     (UptimeRobot / BetterStack free tier).
  3. If you bring data over from the old (compromised) box, copy ONLY
     ./data/explorer.db (and its -shm / -wal sidecars if present) — no
     other files, dotfiles, or scripts. The cleanest way is a snapshot
     taken via:  sqlite3 explorer.db ".backup explorer.bak.db"
     Verify ownership after copying:
       chown -R 1000:1000 $DEPLOY_DIR/data
  4. Watch the backend warm up:
       docker compose -f $DEPLOY_DIR/docker-compose.yml logs -f backend
  5. Confirm certificate is valid:
       curl -sI https://$DOMAIN | head -5
  6. Verify the nightly backup ran:
       tail -n 50 /var/log/pdexplorer-backup.log
       ls -lh $DEPLOY_DIR/backups/
     Ship $DEPLOY_DIR/backups/ off-host (rclone / restic / aws s3 sync)
     so a host failure doesn't take your only copy with it.

EOF
}

# ---- Entry point -----------------------------------------------------------
main() {
    require_root
    require_ubuntu
    case "${1:-all}" in
        harden)         harden_system ;;
        docker)         install_docker ;;
        app)            deploy_app ;;
        backup)         setup_backups ;;
        cloudflare)     setup_cloudflare_only ;;
        cf-origin-cert) setup_cf_origin_cert ;;
        all)            harden_system; install_docker; deploy_app; setup_backups ;;
        all+cf)         harden_system; install_docker; deploy_app; setup_backups; setup_cloudflare_only ;;
        *)              die "Usage: $0 [harden|docker|app|backup|cloudflare|cf-origin-cert|all|all+cf]" ;;
    esac
    summary
}

main "$@"
