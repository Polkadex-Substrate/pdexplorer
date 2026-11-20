#!/bin/bash
# Sourced by deploy.sh. Small decisions, written as functions so a test can run
# them against a fake root and stub commands (test/deploy-unattended.test.js).
#
# Why these exist: deploy.sh used to decide "Docker is not installed" and "there
# is no certificate" from single tests that were wrong on the production box.
# The first ran the Docker package install on every deploy (and asked "overwrite
# the gpg key?"); the second ran init-letsencrypt.sh (and asked "replace the
# certificate?"). Each test here is deliberately generous: the cost of wrongly
# concluding "present" is a skipped step, the cost of wrongly concluding
# "absent" is a package upgrade or a replaced origin certificate.
#
# Only shell builtins are used, so the functions work with a PATH of stubs.
#
# Test seams (never set in production):
#   DETECT_ROOT  prefix for the fixed paths probed below
#   DETECT_SUDO  the sudo command to use (default: sudo)
#   DETECT_EUID  effective uid to assume (default: $EUID)

# deploy_detect_docker
#   Returns 0 if Docker is installed. Sets DOCKER_DETECT to the test that said
#   so: path:<binary>, binary:<path>, unit:<file>, or none.
deploy_detect_docker() {
    local r="${DETECT_ROOT:-}" p
    DOCKER_DETECT="none"
    if command -v docker >/dev/null 2>&1; then
        DOCKER_DETECT="path:$(command -v docker)"
        return 0
    fi
    for p in /usr/bin/docker /usr/local/bin/docker /snap/bin/docker; do
        if [ -e "$r$p" ]; then
            DOCKER_DETECT="binary:$p"
            return 0
        fi
    done
    for p in /lib/systemd/system /usr/lib/systemd/system /etc/systemd/system /run/systemd/system; do
        if [ -e "$r$p/docker.service" ]; then
            DOCKER_DETECT="unit:$p/docker.service"
            return 0
        fi
    done
    return 1
}

# deploy_sudo_state
#   Prints one of: root, passwordless, password-required, absent.
deploy_sudo_state() {
    local s="${DETECT_SUDO:-sudo}"
    if [ "${DETECT_EUID:-$EUID}" = "0" ]; then echo root; return 0; fi
    if ! command -v "$s" >/dev/null 2>&1; then echo absent; return 0; fi
    if "$s" -n true >/dev/null 2>&1; then echo passwordless; else echo password-required; fi
}

# deploy_detect_cert <certbot_path> <domain>
#   Is there a certificate we must not replace?
#   Returns 0 found, 1 not found, 2 cannot tell (the tree is not readable).
#   Sets CERT_DETECT to: exact, glob, sudo-exact, sudo-glob, unreadable, none
#   and CERT_DETECT_PATH to the file (or directory, when unreadable) it refers to.
#
#   "exact" is the very test init-letsencrypt.sh uses ([ -s live/<domain>/...]).
#   It needs only search permission on live/, while the glob needs read
#   permission as well, so the glob alone can say "none" for a cert that exists.
deploy_detect_cert() {
    local cp="$1" dom="$2" conf live glob exact s="${DETECT_SUDO:-sudo}" d parent
    conf="$cp/conf"; live="$conf/live"; glob="$live/*/fullchain.pem"
    exact=""
    [ -n "$dom" ] && exact="$live/$dom/fullchain.pem"
    CERT_DETECT="none"; CERT_DETECT_PATH="${exact:-$glob}"

    if [ -n "$exact" ] && [ -s "$exact" ]; then
        CERT_DETECT="exact"; return 0
    fi
    if compgen -G "$glob" >/dev/null 2>&1; then
        CERT_DETECT="glob"; CERT_DETECT_PATH="$glob"; return 0
    fi

    # Not visible to this user. Ask sudo, without ever allowing it to prompt.
    if command -v "$s" >/dev/null 2>&1 && "$s" -n true >/dev/null 2>&1; then
        if [ -n "$exact" ] && "$s" -n test -s "$exact" >/dev/null 2>&1; then
            CERT_DETECT="sudo-exact"; return 0
        fi
        if "$s" -n bash -c 'compgen -G "$1" >/dev/null' _ "$glob" >/dev/null 2>&1; then
            CERT_DETECT="sudo-glob"; CERT_DETECT_PATH="$glob"; return 0
        fi
        CERT_DETECT="none"; return 1
    fi

    # No sudo. Is it really absent, or can this user simply not look?
    for d in "$cp" "$conf" "$live"; do
        if [ ! -d "$d" ]; then
            case "$d" in */*) parent="${d%/*}" ;; *) parent="." ;; esac
            [ -n "$parent" ] || parent="/"
            if [ -x "$parent" ]; then CERT_DETECT="none"; return 1; fi
            CERT_DETECT="unreadable"; CERT_DETECT_PATH="$parent"; return 2
        fi
    done
    if [ -r "$live" ] && [ -x "$live" ]; then CERT_DETECT="none"; return 1; fi
    CERT_DETECT="unreadable"; CERT_DETECT_PATH="$live"; return 2
}

# deploy_env_value <file> <KEY>
#   Last non-commented assignment, quotes and spaces stripped. Parsed, never
#   sourced: .env holds tokens that must not be executed or exported.
deploy_env_value() {
    [ -f "$1" ] || return 0
    sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -1 | sed 's/^["'\'']//;s/["'\'']$//' | tr -d ' '
}

# deploy_summary_line <certbot_path> <domain>
#   One line for the operator to paste back. Expects deploy_detect_docker and
#   deploy_detect_cert to have run, and SUDO_STATE to be set.
deploy_summary_line() {
    local who="${USER:-}" dock
    if [ -z "$who" ]; then who="$(id -un 2>/dev/null || echo unknown)"; fi
    if [ "${DOCKER_DETECT:-none}" = "none" ]; then dock="not-installed"; else dock="installed(${DOCKER_DETECT})"; fi
    echo "deploy-check: user=$who uid=${DETECT_EUID:-$EUID} sudo_user=${SUDO_USER:-none} sudo=${SUDO_STATE:-unknown} docker=$dock cert=${CERT_DETECT:-unknown} certbot_path=$1 domain=${2:-unset} cert_file=${CERT_DETECT_PATH:-unknown}"
}
