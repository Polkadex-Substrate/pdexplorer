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
#   sudo bash provision-ubuntu.sh                # everything, Cloudflare included
#   sudo bash provision-ubuntu.sh all            # same thing, spelled out
#
# Audit F-192: `all` INCLUDES the Cloudflare firewall phase and the Cloudflare
# Origin CA install. It has since F-098; these two lines used to say it did not
# and pointed at `all+cf` as the way to add Cloudflare. That was worse than
# redundant — the `all+cf` arm never called setup_cf_origin_cert, so following
# the old instruction downgraded a correct run into one that leaves a
# self-signed origin cert and a Cloudflare 526. `all+cf` is now an alias of
# `all`, kept only so old runbooks and shell history keep working.
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
# DOMAIN/CERTBOT_PATH defaults are applied further down, AFTER the deployment's
# own .env has been consulted (audit F-189). Capture what the caller passed
# first — once `${DOMAIN:-default}` has run there is no way to tell an explicit
# value from the fallback, and the two need different precedence against .env.
_DOMAIN_ARG="${DOMAIN:-}"
_CERTBOT_PATH_ARG="${CERTBOT_PATH:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-business@polkadex.ee}"
# Audit F-030: canonical remote, not the personal fork — a fresh VPS clones
# and later hard-resets to whatever this URL serves.
REPO_URL="${REPO_URL:-https://github.com/Polkadex-Substrate/pdexplorer.git}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pdexplorer}"
SSH_PORT="${SSH_PORT:-22}"
ALLOW_PASSWORD_SSH="${ALLOW_PASSWORD_SSH:-no}"

# ---- Audit F-189: ONE cert path, read from the same file compose reads ------
#
# There were three writers of "where the certificates live" and they agreed only
# by coincidence:
#
#   1. docker-compose.yml interpolates ${CERTBOT_PATH:-./certbot} from .env and
#      bind-mounts $CERTBOT_PATH/conf onto /etc/letsencrypt inside the frontend
#      container;
#   2. this script hard-coded $DEPLOY_DIR/certbot everywhere, ignoring .env;
#   3. deploy.sh referenced ${CERTBOT_PATH:-./certbot} but never sourced .env,
#      so it always took the ./certbot branch.
#
# On the default box all three resolve to /opt/pdexplorer/certbot, so nothing
# ever looked wrong. Set CERTBOT_PATH to anything else and the failure is the
# nastiest shape there is: this script writes a perfectly valid certificate,
# reports success, and nginx mounts a DIFFERENT, empty directory — it cannot
# open fullchain.pem, exits, and Cloudflare serves 521 while every check you
# run says "cert already present".
#
# Precedence is deliberate: an explicit CERTBOT_PATH in the environment wins,
# then whatever the deployment's own .env says (that is the file compose reads,
# so it is the authority), then the default. Read with a grep rather than by
# sourcing .env — that file holds credentials and must never be executed.
env_value() {
    # env_value <file> <KEY> — prints the value or nothing. Strips surrounding
    # quotes and whitespace; ignores commented-out lines.
    [ -f "$1" ] || return 0
    sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -1 | sed 's/^["'\'']//;s/["'\'']$//' | tr -d ' '
}
CERTBOT_PATH="$_CERTBOT_PATH_ARG"
[ -n "$CERTBOT_PATH" ] || CERTBOT_PATH="$(env_value "$DEPLOY_DIR/.env" CERTBOT_PATH)"
[ -n "$CERTBOT_PATH" ] || CERTBOT_PATH="$DEPLOY_DIR/certbot"
# Same treatment for DOMAIN: a box provisioned once with DOMAIN=x and re-run
# without it would otherwise fall back to the compiled-in default and install
# the next certificate under a live/ name that neither nginx nor the previous
# run uses — a working site turned into a 521 by a no-argument re-run.
DOMAIN="$_DOMAIN_ARG"
[ -n "$DOMAIN" ] || DOMAIN="$(env_value "$DEPLOY_DIR/.env" DOMAIN)"
[ -n "$DOMAIN" ] || DOMAIN="explorer.polkadex.ee"

# The container-side path is FIXED and is not the host path. docker-compose.yml
# mounts $CERTBOT_PATH/conf (host) onto /etc/letsencrypt (container, read-only
# for nginx), so:
#
#     host       $CERTBOT_PATH/conf/live/$DOMAIN/privkey.pem
#     container  /etc/letsencrypt/live/$DOMAIN/privkey.pem
#
# There is NO /etc/letsencrypt on the host. Every operator instruction below
# names one or the other explicitly, because "check /etc/letsencrypt" sends
# somebody `ls`ing a directory that does not exist on the box they are on.
CERT_LIVE_HOST="$CERTBOT_PATH/conf/live/$DOMAIN"
CERT_LIVE_CONTAINER="/etc/letsencrypt/live/$DOMAIN"

# Audit F-097: pin the Compose project name to the SAME default deploy.sh uses.
# Compose otherwise derives it from the basename of the directory it is invoked
# from, so provisioning from /opt/pdexplorer and later deploying from
# /root/pdexplorer produced TWO independent stacks — duplicate containers
# fighting over ports 80/443, which is how the 521 outage happened. Exported so
# every `docker compose` call below (and anything this script shells out to)
# agrees without needing a `-p` flag on each one.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pdexplorer}"
export COMPOSE_PROJECT_NAME

# ---- Helpers ---------------------------------------------------------------
log()  { printf '\n\033[1;34m[provision]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
    [ "$(id -u)" -eq 0 ] || die "Run as root or via sudo."
}

# ---- Audit F-189: reconcile the live/ name with what nginx actually opens ----
#
# nginx.conf carries a LITERAL certificate path — `ssl_certificate
# /etc/letsencrypt/live/explorer.polkadex.ee/fullchain.pem` — and it is baked
# into the frontend image at build time (Dockerfile.frontend COPYs it into
# conf.d/). So it does not follow $DOMAIN, and a deployment with any other
# DOMAIN installs its certificate into live/<its-domain>/ where nginx never
# looks. The container then fails to start and the site is a Cloudflare 521,
# with the provision log cheerfully reporting a certificate was installed.
#
# Templating nginx.conf would be the tidy fix, but it changes how the running
# production frontend gets its config, and a mistake there is an outage on a
# live mainnet explorer. Instead: read the name out of nginx.conf (so this can
# never drift from the file it is about) and, when it differs from $DOMAIN,
# point it at the real directory with a symlink inside the same mounted tree.
# Additive by construction — on the default box the names match and nothing is
# created.
_nginx_cert_name() {
    # Prints the live/<name> segment nginx.conf opens, or nothing if the
    # directive is missing//unrecognised.
    local conf="$DEPLOY_DIR/nginx.conf"
    [ -f "$conf" ] || conf="$(dirname "$0")/nginx.conf"
    [ -f "$conf" ] || return 0
    sed -n 's#^[[:space:]]*ssl_certificate[[:space:]]\+/etc/letsencrypt/live/\([^/]\+\)/.*#\1#p' "$conf" | head -1
}

_align_nginx_cert_name() {
    # Audit F-189 (round 3): this logic used to live here only, so deploy.sh —
    # the other path that stands a site up — never performed the alias and a
    # deployment whose DOMAIN differs from the name baked into nginx.conf could
    # not start. Extracted to tools/align-cert-name.sh so both callers share one
    # copy rather than two that drift.
    local helper="${DEPLOY_DIR:-.}/tools/align-cert-name.sh"
    [ -f "$helper" ] || helper="./tools/align-cert-name.sh"
    if [ -f "$helper" ]; then
        bash "$helper" "$DOMAIN" "$CERTBOT_PATH" "${DEPLOY_DIR:-.}/nginx.conf" || true
    else
        warn "tools/align-cert-name.sh missing — cannot verify nginx's cert path matches DOMAIN."
    fi
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

    # Audit F-098: refuse to lock out password auth when NO key can get back
    # in. The old order disabled password SSH and restarted sshd first, then
    # never checked authorized_keys — a one-liner run without a key lost SSH
    # to the box permanently (console recovery only).
    if [ "$ALLOW_PASSWORD_SSH" = "no" ]; then
        _has_key=0
        for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
            [ -s "$f" ] && _has_key=1 && break
        done
        if [ "$_has_key" -eq 0 ]; then
            die "No non-empty authorized_keys found and ALLOW_PASSWORD_SSH=no — hardening would lock you out. Add an SSH key first, or run with ALLOW_PASSWORD_SSH=yes."
        fi
    fi

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
    # Apply it. Ubuntu 22.10+/24.04 use SOCKET ACTIVATION: ssh.socket is the
    # listener and ssh.service stays inactive, so `systemctl reload ssh` errors
    # with "not active" — AND the Port we set above is ignored, because under
    # socket activation the listening port comes from ssh.socket, not sshd_config.
    # Make ssh.service the authoritative listener so both the port and the
    # hardening take effect. Established SSH sessions survive a restart, and UFW
    # already allows $SSH_PORT, so new logins keep working.
    if systemctl list-unit-files ssh.socket >/dev/null 2>&1; then
        systemctl disable --now ssh.socket >/dev/null 2>&1 || true
    fi
    systemctl enable ssh.service >/dev/null 2>&1 || systemctl enable sshd.service >/dev/null 2>&1 || true
    if systemctl restart ssh.service 2>/dev/null || systemctl restart sshd.service 2>/dev/null; then
        ok "SSH locked down (port $SSH_PORT, key-only, no root password)"
    else
        warn "SSH config written and validated (sshd -t passed), but the SSH unit"
        warn "could not be (re)started automatically. Your current session is safe."
        warn "Apply manually: sudo systemctl restart ssh"
    fi

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
#
# Audit F-097 — deploy_app() PREPARES; deploy.sh DEPLOYS. They are no longer two
# implementations of the same thing.
#
# The finding was that these two scripts disagreed on git policy, .env policy,
# TLS bootstrap, the Compose project name and the GIT_SHA stamp — five ways for
# a box to end up in a state that depended on which script last ran on it.
# Round 1 aligned the project name and the SHA stamp and wrote the remaining
# differences down. Writing a divergence down does not stop it diverging
# further, so round 2 removed the overlap instead:
#
#   deploy_app()  = the things that must exist before a build is POSSIBLE on a
#                   bare box. It may create; it no longer destroys.
#   deploy.sh     = the build, the start and the verification. Every time,
#                   including the first. It refuses to guess.
#
# | Concern        | deploy_app() (here)                  | deploy.sh                       |
# |----------------|--------------------------------------|---------------------------------|
# | git            | clones when absent; otherwise leaves | `git pull origin main` (fails   |
# |                | the tree alone. `reset --hard` only  | loudly on a conflict, so a      |
# |                | under PROVISION_DESTROY_LOCAL_EDITS  | hand-patched box is safe)       |
# | .env           | WRITES one from the template if      | REFUSES to start without a real |
# |                | absent; preserves an existing file   | .env, and refuses one that is   |
# |                |                                      | byte-identical to .env.example  |
# | TLS            | bootstraps a cert (init-letsencrypt, | SKIPS cert bootstrap when one   |
# |                | else a self-signed placeholder) so   | already exists — re-running it  |
# |                | nginx can start at all               | over a Cloudflare Origin cert   |
# |                |                                      | is what caused the 521/526      |
# | Compose project| pinned via COMPOSE_PROJECT_NAME      | pinned via `-p "$COMPOSE_..."`  |
# |                | export at the top of this file,      | — same default, `pdexplorer`    |
# |                | passed through to deploy.sh          |                                 |
# | build + start  | NONE — delegates to deploy.sh        | the only `docker compose up` in |
# |                |                                      | the repo; stamps GIT_SHA        |
#
# Consequences worth knowing before you run either one:
#   * `provision-ubuntu.sh app` is now SAFE to re-run on a box you have edited.
#     It will not discard your changes; deploy.sh's `git pull` will refuse to
#     merge over them, which is the loud failure you want.
#   * To deliberately throw local edits away, say so:
#         PROVISION_DESTROY_LOCAL_EDITS=1 ./provision-ubuntu.sh app
#   * For a routine redeploy of an already-provisioned box, deploy.sh alone is
#     still the shorter path. `provision-ubuntu.sh app` now ends by calling it,
#     so the two produce the same artefact rather than merely similar ones.
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

    log "Ensuring a checkout of $REPO_URL at $DEPLOY_DIR"
    if [ -d "$DEPLOY_DIR/.git" ]; then
        # Audit F-097 (round 2): this used to be an unconditional
        # `fetch --all --prune` + `reset --hard origin/HEAD`, and that is the
        # single most destructive line either deploy script contained.
        #
        # The justification was "deploy_app() is the FIRST deploy on a bare
        # box, so there is nothing to destroy" — but this branch is, by
        # definition, the branch where the box is NOT bare. `provision-ubuntu.sh
        # app` is exactly what an operator reaches for when the stack is unhappy
        # and they want to "redeploy properly", frequently right after hot-
        # patching a file on the box to diagnose the problem. The hard reset
        # discarded that patch silently, before it printed anything about it,
        # and there is no reflog entry for a working-tree change that was never
        # committed. It is unrecoverable, and it looked like a routine re-run.
        #
        # Updating is now delegated to deploy.sh (see the end of this function),
        # which does `git pull origin main` and FAILS on a conflict instead of
        # resolving it by deletion. Losing local edits is still available, but
        # it now has to be asked for by name, and the name says what it does.
        if [ "${PROVISION_DESTROY_LOCAL_EDITS:-0}" = "1" ]; then
            warn "PROVISION_DESTROY_LOCAL_EDITS=1 — discarding all local changes in $DEPLOY_DIR"
            git -C "$DEPLOY_DIR" fetch --all --prune
            git -C "$DEPLOY_DIR" reset --hard origin/HEAD
        else
            ok "$DEPLOY_DIR is already a checkout — leaving the working tree alone"
            ok "  (deploy.sh will 'git pull origin main' below; set"
            ok "   PROVISION_DESTROY_LOCAL_EDITS=1 to hard-reset instead)"
        fi
    else
        install -d -m 0755 "$(dirname "$DEPLOY_DIR")"
        # NOT --depth 1: deploy.sh runs `git pull origin main` immediately
        # afterwards and a shallow clone makes that a special case for no gain
        # on a repo this size.
        git clone "$REPO_URL" "$DEPLOY_DIR"
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
    # F-189: $CERTBOT_PATH, not a second hard-coded $DEPLOY_DIR/certbot. These
    # are the HOST directories compose bind-mounts onto the container's
    # /etc/letsencrypt and /var/www/certbot.
    install -d -m 0755 "$CERTBOT_PATH/conf"
    install -d -m 0755 "$CERTBOT_PATH/www"

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

# ---- Cert path (audit F-023). ABSOLUTE, like DATA_PATH: compose's fallback
# is the RELATIVE ./certbot, which resolves against whatever directory compose
# is invoked from — run a deploy from a second checkout and nginx mounts an
# empty cert dir, fails on fullchain.pem, and Cloudflare returns 521.
#
# Audit F-189: this is the HOST side of a bind mount. Inside the frontend
# container the same tree is /etc/letsencrypt (read-only), which is the path
# nginx.conf names. There is no /etc/letsencrypt on the host:
#     host      $CERTBOT_PATH/conf/live/$DOMAIN/privkey.pem
#     container /etc/letsencrypt/live/$DOMAIN/privkey.pem
# provision-ubuntu.sh and deploy.sh now both READ this value back out of this
# file, so changing it here moves every writer at once.
CERTBOT_PATH=$CERTBOT_PATH

# ---- Diagnostics (audit F-038). Bearer token for /api/diag/*; leave empty
# to restrict diagnostics to loopback (operator on the box) only.
DIAG_TOKEN=

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
    # nginx.conf `include`s these from the CONTAINER's /etc/letsencrypt/. If
    # they're missing nginx fails to start with "open() options-ssl-nginx.conf
    # failed". They are normally created by certbot the first time it runs —
    # bootstrap them here so nginx can come up before certbot has any cert.
    #
    # F-189: written to $CERTBOT_PATH/conf on the HOST. These used to be
    # relative (`certbot/conf`, i.e. $DEPLOY_DIR/certbot/conf after the cd
    # above), which is a *different directory* from the one compose mounts as
    # soon as CERTBOT_PATH is not the default — files landed somewhere nginx
    # never reads and the container refused to start.
    install -d "$CERTBOT_PATH/conf"
    if [ ! -s "$CERTBOT_PATH/conf/options-ssl-nginx.conf" ]; then
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
            -o "$CERTBOT_PATH/conf/options-ssl-nginx.conf" \
            || warn "Could not download options-ssl-nginx.conf; nginx may not start"
    fi
    if [ ! -s "$CERTBOT_PATH/conf/ssl-dhparams.pem" ]; then
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
            -o "$CERTBOT_PATH/conf/ssl-dhparams.pem" \
            || warn "Could not download ssl-dhparams.pem; nginx may not start"
    fi

    log "Issuing Let's Encrypt cert for $DOMAIN (HTTP-01 challenge)"
    log "  host path:      $CERT_LIVE_HOST"
    log "  container path: $CERT_LIVE_CONTAINER  (the one nginx.conf names)"
    if [ ! -f "$CERT_LIVE_HOST/fullchain.pem" ]; then
        # Audit F-024: EXPLICIT bootstrap mode. nginx cannot start without a
        # certificate file and nothing else in this phase can run until nginx
        # is up, so a placeholder here is a genuine prerequisite — but it is
        # only ever a prerequisite. init-letsencrypt.sh's default mode now
        # issues a real certificate and exits non-zero if it cannot; asking for
        # that here would abort every provision of an orange-clouded host
        # (HTTP-01 cannot reach a proxied origin), which is why the mode is
        # named rather than defaulted. The corresponding obligation is at the
        # end of run_all: the provision as a whole must not FINISH on this.
        # F-197: was `[ -x ./init-letsencrypt.sh ]`. The file is tracked 100644,
        # so that test is false in a fresh checkout and this branch never ran —
        # provision silently fell through to the self-signed placeholder below.
        # deploy.sh already invokes it as `bash ./init-letsencrypt.sh`; match it.
        if [ -f ./init-letsencrypt.sh ]; then
            ORIGIN_CERT_MODE=self-signed-bootstrap bash ./init-letsencrypt.sh
            ok "Placeholder cert bootstrapped via init-letsencrypt.sh (NOT an origin cert)"
        else
            warn "init-letsencrypt.sh missing — issuing a self-signed placeholder so nginx can start."
            install -d "$CERT_LIVE_HOST"
            openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
                -keyout "$CERT_LIVE_HOST/privkey.pem" \
                -out "$CERT_LIVE_HOST/fullchain.pem" \
                -subj "/CN=$DOMAIN" >/dev/null 2>&1
            # F-179: openssl writes the key 0600 root. Without this the
            # self-signed BOOTSTRAP — whose entire purpose is letting nginx
            # start so certbot can reach it over HTTP-01 — produces an nginx
            # that cannot start.
            # F-189: absolute $CERTBOT_PATH, not the relative "certbot/conf" —
            # see the block at the top of the file. Same helper, same F-179
            # semantics; only the tree it is pointed at changed, to the one
            # compose actually mounts.
            _fix_cert_perms "$CERTBOT_PATH/conf"
            warn "Replace with a real cert via certbot once the stack is up:"
            warn "  docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d $DOMAIN -m $LETSENCRYPT_EMAIL --agree-tos --non-interactive"
            warn "  docker compose exec frontend nginx -s reload"
        fi
    else
        ok "Cert already present at $CERT_LIVE_HOST/ (host) = $CERT_LIVE_CONTAINER/ (container)"
    fi
    # F-189: last thing before the stack comes up — make sure the directory
    # nginx.conf opens is the directory the certificate was written to.
    _align_nginx_cert_name

    # ─── Audit F-097 (round 2): ONE compose invocation path ──────────────────
    #
    # This block used to be a second, parallel implementation of everything
    # deploy.sh does after the checkout exists: stamp GIT_SHA/BUILD_TIME,
    # `compose down`, `compose pull`, `compose up -d --build`, health-check.
    # Round 1 fixed the two places where the copies had *diverged* (the Compose
    # project name and the missing GIT_SHA stamp) but left the copies.
    #
    # Copies do not stay converged. Every future change to how the stack is
    # built — a new build arg, a `--pull` policy, an extra verification step,
    # a healthcheck timeout — has to be made in two files by someone who knows
    # the other one exists, and the round-1 divergences are proof of what
    # happens when they do not. The cost of the drift is not abstract: a
    # provision-built box and a deploy.sh-built box were different artefacts
    # answering the same URL, so "is my fix deployed?" had two answers
    # depending on which script last touched the host.
    #
    # So the split is now by RESPONSIBILITY rather than by duplication:
    #
    #   deploy_app()  owns everything that must exist BEFORE a build is
    #                 possible on a bare box — the checkout, the data
    #                 directory, .env, the TLS helper files, and a certificate
    #                 nginx can start with.
    #   deploy.sh     owns the build and everything after it, on the first
    #                 deploy and on every subsequent one. There is exactly one
    #                 `docker compose up` in this repo and it lives there.
    #
    # deploy.sh's own preconditions are satisfied by the time we get here: it
    # requires a real .env that is not byte-identical to .env.example (written
    # above), it pins the same COMPOSE_PROJECT_NAME (exported at the top of this
    # file, and it defaults to the same `pdexplorer`), and it skips cert
    # bootstrap when a certificate already exists — which one does, because the
    # step above just made sure of it. If any of that stops being true, deploy.sh
    # exits non-zero and `set -e` fails the provision here, loudly, instead of
    # bringing up a stack that differs from the one a later deploy would build.
    log "Handing the build + verify half to deploy.sh (single compose path)"
    [ -f "$DEPLOY_DIR/deploy.sh" ] || die "deploy.sh missing from $DEPLOY_DIR — cannot deploy."
    # DEPLOY_DIR/REPO_URL are passed explicitly so deploy.sh operates on the
    # tree we just prepared even if its own defaults ever change.
    DEPLOY_DIR="$DEPLOY_DIR" REPO_URL="$REPO_URL" \
        COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
        bash "$DEPLOY_DIR/deploy.sh" \
        || die "deploy.sh failed — the stack was NOT started. Fix the error above and re-run 'provision-ubuntu.sh app'."

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

# Audit F-179. Delegates to tools/fix-cert-perms.sh so provision, deploy and the
# certbot deploy-hook cannot drift apart. Defined as a shim rather than inlined
# because four separate paths write key material and only one of them used to
# fix the ownership afterwards — which is the finding.
_fix_cert_perms() {
    local dir="${1:-certbot/conf}"
    local helper="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/tools/fix-cert-perms.sh"
    if [ -x "$helper" ] || [ -f "$helper" ]; then
        bash "$helper" "$dir" || warn "cert permissions could not be set — nginx (uid 101) may fail to start"
    else
        # Helper missing (partial checkout): do the minimum inline rather than
        # skip it, because skipping means a dead site.
        chgrp -R 101 "$dir" 2>/dev/null || true
        find "$dir" -type f -name '*.pem' -exec chmod 0640 {} + 2>/dev/null || true
        find "$dir" -type d -exec chmod 0750 {} + 2>/dev/null || true
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

    # Audit F-109. The same two files now generate the nginx real-IP list.
    #
    # Before this, nginx's `set_real_ip_from` block was hand-maintained inside
    # nginx.conf and BAKED INTO THE FRONTEND IMAGE, while UFW's list came from
    # a live fetch here. So running `provision-ubuntu.sh cloudflare` refreshed
    # the firewall and silently left nginx trusting a stale list. When
    # Cloudflare adds a range, the consequence is not cosmetic: connections
    # from the new range are allowed through the firewall, but nginx does not
    # trust their CF-Connecting-IP header, so $remote_addr becomes the
    # CLOUDFLARE EDGE address. Every per-IP rate limiter — including the auth
    # gate (F-070) — then buckets thousands of unrelated visitors together, and
    # the access log attributes their traffic to Cloudflare.
    #
    # Two sources of truth for one fact is the finding; this makes it one.
    log "Generating the nginx real-IP snippet from the same Cloudflare lists"
    {
        echo "# Generated by provision-ubuntu.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) — DO NOT EDIT."
        echo "# Source: https://www.cloudflare.com/ips-v4 and /ips-v6 (audit F-109)."
        echo "# Mounted into the frontend container at /etc/nginx/cloudflare/."
        while IFS= read -r cidr; do
            [ -z "$cidr" ] && continue
            echo "set_real_ip_from $cidr;"
        done < "$cf_dir/ips-v4"
        while IFS= read -r cidr; do
            [ -z "$cidr" ] && continue
            echo "set_real_ip_from $cidr;"
        done < "$cf_dir/ips-v6"
    } > "$cf_dir/nginx-real-ip.conf"
    chmod 0644 "$cf_dir/nginx-real-ip.conf"
    ok "Wrote $(grep -c set_real_ip_from "$cf_dir/nginx-real-ip.conf") set_real_ip_from directives to $cf_dir/nginx-real-ip.conf"
    warn "Restart the frontend container for nginx to pick this up: docker compose restart frontend"

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

# Audit F-109, and a review catch on its first version: the ONE-SHOT
# provisioning phase generated this snippet, and this weekly refresh — the only
# thing that runs after day one — did not. So the exact drift F-109 describes
# survived on the automated path: UFW would learn a new Cloudflare range while
# nginx kept an old list, $remote_addr would become the Cloudflare EDGE address
# for connections from that range, and every per-IP limiter (auth included)
# would bucket thousands of unrelated visitors together.
#
# Whatever regenerates one list must regenerate both.
{
    echo "# Generated by cloudflare-ufw-refresh on $(date -u +%Y-%m-%dT%H:%M:%SZ) — DO NOT EDIT."
    echo "# Source: https://www.cloudflare.com/ips-v4 and /ips-v6 (audit F-109)."
    while IFS= read -r cidr; do
        [ -z "$cidr" ] && continue
        echo "set_real_ip_from $cidr;"
    done < "$cf_dir/ips-v4"
    while IFS= read -r cidr; do
        [ -z "$cidr" ] && continue
        echo "set_real_ip_from $cidr;"
    done < "$cf_dir/ips-v6"
} > "$cf_dir/nginx-real-ip.conf.new"
mv "$cf_dir/nginx-real-ip.conf.new" "$cf_dir/nginx-real-ip.conf"
chmod 0644 "$cf_dir/nginx-real-ip.conf"

# nginx reads this file at config load, so a refresh needs a reload to take
# effect. `nginx -s reload` is graceful (no dropped connections); the `|| true`
# keeps a refresh from failing the timer when the container is not running.
if command -v docker >/dev/null 2>&1; then
    docker exec pdexplorer-frontend nginx -s reload >/dev/null 2>&1 \
        || echo "cloudflare-ufw-refresh: could not reload nginx (container down?); the new list applies on next start"
fi

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
    # Audit F-189: $CERTBOT_PATH (which honours .env), not a second hard-coded
    # $DEPLOY_DIR/certbot. This function was the third disagreeing writer: it
    # always installed under $DEPLOY_DIR/certbot while compose mounted whatever
    # .env said. With a custom CERTBOT_PATH it wrote a valid Origin cert into a
    # directory nothing mounts, printed "Certificate + key installed", and left
    # the site on the old (or missing) cert — Cloudflare 521/526 with a
    # provision log full of green ticks.
    local dst_dir="$CERT_LIVE_HOST"
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
    # /etc/letsencrypt/live/<name>/{fullchain,privkey}.pem. The compose mount
    # maps $CERTBOT_PATH/conf (HOST) -> /etc/letsencrypt (CONTAINER), so writing
    # to $dst_cert/$dst_key on the host shows up at the LE paths in the
    # container. Do not go looking for /etc/letsencrypt on the host — it does
    # not exist there; that path is only meaningful inside the container.
    log "Installing certificate:"
    log "  host:      $dst_cert"
    log "  container: $CERT_LIVE_CONTAINER/fullchain.pem"
    install -d -m 0755 "$dst_dir"
    install -m 0644 "$src_cert" "$dst_cert"
    # Audit F-179: this was `install -m 0600`, which left the key readable by
    # root ONLY — and the frontend nginx runs as uid/gid 101. It also silently
    # undid deploy.sh's chgrp on every re-provision. 0640 plus group 101 below.
    install -m 0640 "$src_key"  "$dst_key"
    _fix_cert_perms "$(dirname "$(dirname "$dst_dir")")"
    ok "Certificate + key installed for $DOMAIN"
    # F-189: and make sure that is the name nginx.conf actually opens.
    _align_nginx_cert_name

    # ---- Generate support files nginx.conf references ----
    # The frontend nginx config does:
    #     include /etc/letsencrypt/options-ssl-nginx.conf;
    #     ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    # These are normally provided by certbot. If we never ran certbot,
    # generate sane equivalents so nginx starts.
    # F-189: same tree as the cert above — $CERTBOT_PATH, which is what compose
    # mounts. nginx `include`s these by their CONTAINER paths
    # (/etc/letsencrypt/options-ssl-nginx.conf and ssl-dhparams.pem); generating
    # them into a directory that is not mounted leaves nginx failing at boot on
    # "open() ... failed", which looks nothing like a certificate problem.
    local options_file="$CERTBOT_PATH/conf/options-ssl-nginx.conf"
    local dhparams_file="$CERTBOT_PATH/conf/ssl-dhparams.pem"

    # Validate CONTENT, not just existence. `[ -s ]` only tests "non-empty",
    # and the failure we actually hit was a 14-byte file containing the literal
    # text "404: Not Found" — written by init-letsencrypt.sh's old unchecked
    # `curl -s` after certbot moved these URLs upstream. That is non-empty, so
    # this phase reported "already present" and left nginx unable to start.
    if ! grep -q 'ssl_protocols' "$options_file" 2>/dev/null; then
        [ -s "$options_file" ] && warn "options-ssl-nginx.conf exists but looks invalid — regenerating"
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

    # Same content check as above — a "404: Not Found" body is non-empty but
    # makes nginx fail with [emerg] on the ssl_dhparam directive.
    if ! grep -q 'BEGIN DH PARAMETERS' "$dhparams_file" 2>/dev/null; then
        [ -s "$dhparams_file" ] && warn "ssl-dhparams.pem exists but is not a DH PARAMETERS file — regenerating"
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
  Backups dir     : /var/backup$([ -d /var/backup ] && echo " ($(find /var/backup -maxdepth 1 -name 'explorer-*.db*' 2>/dev/null | wc -l) file(s))" || echo " (not created yet)")
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
  6. Verify the backup ran:
       tail -n 50 /var/log/pdexplorer-backup.log
       ls -lh /var/backup/
     Note: cron fires nightly but backup.sh throttles to one run per
     MIN_INTERVAL_HOURS (default 48), so an empty result the morning
     after provisioning is expected — check the log, not the directory.
     Ship /var/backup/ off-host (set REMOTE_ENABLED=1 in backup.sh, or
     use rclone / restic) so a host failure doesn't take your only copy.

EOF
}

# ---- The default, Cloudflare-inclusive run ---------------------------------
#
# Audit F-098 + F-024: `all` includes the Cloudflare firewall phase (80/443
# restricted to CF ranges instead of Anywhere) and — when the operator has
# staged secrets/cloudflare-origin.pem — the Origin CA cert install, so the
# default path no longer ends on a self-signed placeholder that Full (Strict)
# rejects with 526. Skipping the origin cert when secrets are absent is
# deliberate: the phase would die() mid-provision otherwise, and the summary
# tells the operator what remains.
#
# ─── Audit F-192: why `all+cf` is now the same function, not a variant ───────
#
# `all+cf` predates F-098, when `all` stopped at the app and you added the
# firewall afterwards. After F-098 the two arms inverted meaning: `all` gained
# BOTH the Cloudflare firewall and the Origin CA install, while `all+cf` was
# still the old harden+docker+app+backup+cloudflare list — with no
# setup_cf_origin_cert in it. The docs still said "run all+cf to include
# Cloudflare", so an operator following them ran the arm that SKIPS the origin
# certificate, staged secrets and all, and landed on the self-signed
# placeholder — a 526 caused by doing the extra step.
#
# Making it an alias rather than deleting it keeps old runbooks, shell history
# and copy-pasted commands working instead of failing on "Usage:". If you ever
# split them again, the thing to preserve is that no arm of this case statement
# is a SUBSET of another — that asymmetry is the whole bug.
# ─── Audit F-024 (round 2): is $DOMAIN a real, public hostname? ─────────────
#
# The hard fail below must not trigger on a laptop, a CI box or a staging VM
# named `explorer.local`, because a self-signed origin is entirely correct
# there — nothing is fronting it in Full (Strict). It MUST trigger on
# explorer.polkadex.ee, where finishing on a placeholder is a 526.
#
# Deliberately a name test, not a DNS lookup. Resolution is the wrong oracle:
# provision runs on hosts with split-horizon DNS, on hosts before the record
# exists, and (during disaster recovery) on hosts whose network is not fully
# up — and every one of those would answer "not public" and silently disarm
# the guard at exactly the moment it is most needed. A name that looks public
# is treated as public; the escape hatch is explicit.
_domain_is_public() {
    local d="${1:-}"
    [ -n "$d" ] || return 1
    case "$d" in
        localhost|*.localhost|*.local|*.internal|*.test|*.invalid|*.example) return 1 ;;
        example.com|example.net|example.org|*.example.com|*.example.net|*.example.org) return 1 ;;
        # No dot at all — a single-label host name, not something a public CA
        # or Cloudflare will ever serve.
        *.*) ;;
        *) return 1 ;;
    esac
    # A bare IPv4 literal is not a hostname Cloudflare proxies.
    case "$d" in
        [0-9]*.[0-9]*.[0-9]*.[0-9]*)
            case "$d" in *[!0-9.]*) ;; *) return 1 ;; esac ;;
    esac
    return 0
}

run_all() {
    harden_system
    install_docker
    deploy_app
    setup_backups
    if [ -r "$DEPLOY_DIR/secrets/cloudflare-origin.pem" ]; then
        setup_cf_origin_cert
    elif _domain_is_public "$DOMAIN" && [ "${ALLOW_SELF_SIGNED_ORIGIN:-0}" != "1" ]; then
        # ─── Audit F-024: this used to be two warn lines ─────────────────────
        #
        # Round 1 made `all` call setup_cf_origin_cert when the secrets happened
        # to be staged, and warn otherwise. Warning-and-continuing is what kept
        # the finding open, because the failure it warns about is invisible from
        # the origin: nginx starts, the provision summary is green, `curl -k
        # https://localhost` works, and the site is 526 for the entire internet.
        # The operator has no reason to re-read scrollback.
        #
        # So: refuse to finish. This is the disaster-recovery case the finding
        # is really about — a fresh host for a public domain, provisioned in a
        # hurry, with nobody double-checking the issuer afterwards.
        #
        # `secrets/cloudflare-origin.pem` is not in git by design (it is a
        # private key's partner), so "the operator staged it" is never the
        # default and must never be assumed.
        #
        # ALLOW_SELF_SIGNED_ORIGIN=1 is the deliberate opt-out, and it is
        # legitimate for exactly one shape of deployment: a GREY-clouded origin
        # (Cloudflare proxy off, or no Cloudflare at all) where you will issue
        # via DNS-01/HTTP-01 yourself afterwards. On an orange-clouded host it
        # converts a loud stop into the silent 526 this guard exists to prevent.
        die "$(cat <<EOF
Refusing to finish: $DOMAIN has no origin certificate.

  $DEPLOY_DIR/secrets/cloudflare-origin.pem is missing, so the only thing at
  $CERT_LIVE_HOST/fullchain.pem is the self-signed BOOTSTRAP placeholder that
  lets nginx start. Cloudflare Full (Strict) validates the origin chain and
  answers 526 to every visitor for a self-signed cert — the origin looks
  perfectly healthy while the site is down.

  Finish with ONE of:

    1. Cloudflare Origin CA (what production runs):
         Cloudflare -> SSL/TLS -> Origin Server -> Create Certificate
         sudo install -d -m 700 $DEPLOY_DIR/secrets
         sudo tee $DEPLOY_DIR/secrets/cloudflare-origin.pem >/dev/null   # cert body
         sudo tee $DEPLOY_DIR/secrets/cloudflare-origin.key >/dev/null   # private key
         sudo chmod 600 $DEPLOY_DIR/secrets/cloudflare-origin.*
         sudo bash $0 cf-origin-cert

    2. Let's Encrypt, with the DNS record GREY-clouded for the duration:
         ORIGIN_CERT_MODE=letsencrypt bash $DEPLOY_DIR/init-letsencrypt.sh

    3. You genuinely want a self-signed origin (grey cloud / no Cloudflare):
         sudo ALLOW_SELF_SIGNED_ORIGIN=1 bash $0 all
EOF
)"
    else
        warn "No $DEPLOY_DIR/secrets/cloudflare-origin.pem — origin cert is the self-signed placeholder."
        warn "That is only safe with the Cloudflare proxy OFF (grey cloud) or no Cloudflare at all."
        warn "Under Full (Strict) this is a 526. Fix with: sudo bash $0 cf-origin-cert"
    fi
    setup_cloudflare_only
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
        # Audit F-098 + F-024: `all` now includes the Cloudflare firewall phase
        # (80/443 restricted to CF ranges instead of Anywhere) and — when the
        # operator has staged secrets/cloudflare-origin.pem — the Origin CA
        # cert install, so the default path no longer ends on a self-signed
        # placeholder that Full (Strict) rejects with 526. Skipping the origin
        # cert when secrets are absent is deliberate: the phase would die()
        # mid-provision otherwise; the summary tells the operator what remains.
        all|all+cf)     run_all ;;
        *)              die "Usage: $0 [harden|docker|app|backup|cloudflare|cf-origin-cert|all]  ('all+cf' is a deprecated alias of 'all')" ;;
    esac
    summary
}

main "$@"
