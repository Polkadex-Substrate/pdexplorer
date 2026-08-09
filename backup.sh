#!/usr/bin/env bash
# =============================================================================
# Polkadex Explorer — SQLite online backup
# =============================================================================
#
# Takes a consistent snapshot of the live explorer.db via `VACUUM INTO`,
# integrity-checks the copy, compresses it, keeps the newest N locally, and
# (optionally) pushes a copy off-box. WAL-safe — the indexer keeps writing
# while this runs, and unlike the `.backup` online-backup API, VACUUM INTO does
# NOT restart when the source is written, so it actually finishes on a busy DB.
#
# Cadence: by default the script will only TAKE a fresh backup if at least
# MIN_INTERVAL_HOURS (default 48 = every other day) have elapsed since the
# most recent successful backup. Cron can therefore run this daily and the
# script will naturally enforce the "every other day" cadence — no scheduler
# tweaks needed. Set MIN_INTERVAL_HOURS=0 to take a backup on every invocation.
#
# Usage:
#   sudo /opt/pdexplorer/backup.sh                # one-shot, uses defaults below
#   sudo SRC=/var/lib/foo.db DEST=/mnt/bak ./backup.sh   # override paths
#   sudo MIN_INTERVAL_HOURS=24 ./backup.sh        # back up daily instead
#   sudo FORCE=1 ./backup.sh                      # bypass the interval check
#
# Designed to be invoked by cron — see /etc/cron.d/pdexplorer-backup, written
# by the `backup` phase of provision-ubuntu.sh.
#
# Off-box storage (recommended): after the verified local copy, push it to an
# external storage box via rsync over SSH. Configure in
# /etc/default/pdexplorer-backup (sourced automatically):
#     REMOTE_ENABLED=1
#     REMOTE_HOST=storage.example.com
#     REMOTE_USER=pdexbackup            # non-root SSH user on the storage box
#     REMOTE_PATH=pdexplorer-backups
#     SSH_KEY=/root/.ssh/pdex_backup_ed25519   # passphrase-less, key auth only
#     REMOTE_MAX_BACKUPS=14                     # keep newest N off-box
# Retention is count-based (keep newest MAX_BACKUPS locally / REMOTE_MAX_BACKUPS
# off-box) — the DB is a rebuildable chain index, so a few recent generations
# is all you need; lower the counts to save more storage.
# One-time key setup:
#     ssh-keygen -t ed25519 -N '' -f /root/.ssh/pdex_backup_ed25519
#     ssh-copy-id -i /root/.ssh/pdex_backup_ed25519.pub -p 22 pdexbackup@storage.example.com
#
# Restore (with the stack stopped) — from the local copy, or pull from remote:
#   # (remote) rsync -e 'ssh -i /root/.ssh/pdex_backup_ed25519' \
#   #     pdexbackup@storage.example.com:pdexplorer-backups/explorer-*.db.gz /var/backup/
#   docker compose -f /opt/pdexplorer/docker-compose.yml down
#   gunzip -c /var/backup/explorer-YYYYMMDDTHHMMSSZ.db.gz \
#       > /opt/pdexplorer/data/explorer.db
#   rm -f /opt/pdexplorer/data/explorer.db-wal \
#         /opt/pdexplorer/data/explorer.db-shm
#   chown -R 1000:1000 /opt/pdexplorer/data
#   docker compose -f /opt/pdexplorer/docker-compose.yml up -d backend
#
# Exit codes:
#   0   success, OR skipped because a recent backup already exists
#   1   misconfiguration (missing sqlite3, source DB, or write perms on DEST)
#   2   backup ran but integrity_check failed — old backups retained, new
#       backup left in place under a .CORRUPT suffix for inspection
#   3   local backup succeeded but the off-box push failed (on-disk copy is
#       intact; check SSH key / host / path). Surfaces to monitoring.
# =============================================================================

set -euo pipefail

# ---- Site overrides --------------------------------------------------------
# Optional per-host config, sourced with auto-export so a plain `KEY=value`
# file works for both the cron job and manual runs. Put DEST (e.g. a dedicated
# backup volume), MIN_INTERVAL_HOURS, INTEGRITY_CHECK, IO_NICE, etc. here so you
# never have to edit the cron entry. Root-owned 0644.
if [ -f /etc/default/pdexplorer-backup ]; then
    set -a; . /etc/default/pdexplorer-backup; set +a
fi

# ---- Configuration (override via env) --------------------------------------
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pdexplorer}"
SRC="${SRC:-$DEPLOY_DIR/data/explorer.db}"
# Backups land OUTSIDE the deploy directory by default so they don't end up
# inside the Docker build context, the repo, or anything that gets pruned by
# accident. /var/backup is the conventional Linux location for system backups.
DEST="${DEST:-/var/backup}"
# Retention is COUNT-based, not age-based. The explorer DB is a derived index
# of on-chain data (the chain is the source of truth), so backups exist to
# restore FAST after disk failure / corruption / a bad deploy — not to keep
# deep point-in-time history. Keep the newest N generations: enough to roll
# back if the latest backup itself captured a corrupted DB, without hoarding
# months of copies. Lower it to save more storage; 1 is discouraged (no
# fallback if the newest backup is bad).
MAX_BACKUPS="${MAX_BACKUPS:-7}"       # local generations to keep (newest N)
# Minimum hours between successful backups. The default of 48 hours implements
# the "every other day" rotation: a daily cron invocation will take a backup
# only on alternating days. Set to 0 to disable the throttle.
MIN_INTERVAL_HOURS="${MIN_INTERVAL_HOURS:-48}"
COMPRESS="${COMPRESS:-gzip}"          # gzip | zstd | none
# Compression level. The old -9 / -19 defaults cost enormous CPU time for a few
# percent of size on a multi-GB snapshot — gzip -9 on a 19 GB DB is tens of
# minutes, single-threaded, every single night. 6 is the sane trade. Note the
# script prefers `pigz` (parallel gzip, byte-identical .gz output) and passes
# zstd -T0, so this work uses all cores when the tools are available.
COMPRESS_LEVEL="${COMPRESS_LEVEL:-6}"
LOCKFILE="${LOCKFILE:-/var/lock/pdexplorer-backup.lock}"
# Set FORCE=1 to bypass the interval check (e.g. to take an ad-hoc snapshot
# right before a risky operation).
FORCE="${FORCE:-0}"
# I/O throttling. The snapshot copy + integrity_check + compression are all
# heavy sequential/random I/O; on a shared or slow volume they can starve the
# live indexer/serving (this actually took the site down once — a 33h
# integrity_check pinned a SATA disk). IO_NICE=1 runs them in the idle I/O
# class (ionice -c3) + lowest CPU priority so they yield to everything else.
IO_NICE="${IO_NICE:-1}"
# integrity_check on the copy: on|off. It re-reads the entire backup, which is
# minutes on SSD but hours on a slow disk. Default on; set off (and verify
# out-of-band / on the SSD backup host) if the source volume can't absorb it.
INTEGRITY_CHECK="${INTEGRITY_CHECK:-on}"

# ---- Off-box copy to external storage over SSH/rsync -----------------------
# After the verified local backup is written it is pushed to an external
# storage box (e.g. a storage VPS) with rsync over SSH — the mature backup
# target: encrypted, resumable (--partial), incremental, and scriptable. Set
# these in /etc/default/pdexplorer-backup. Auth MUST be key-based (BatchMode)
# so cron never blocks on a password prompt.
REMOTE_ENABLED="${REMOTE_ENABLED:-0}"                  # 1 = push off-box
REMOTE_HOST="${REMOTE_HOST:-}"                         # storage box host / IP
REMOTE_USER="${REMOTE_USER:-}"                         # non-root SSH user on the box
REMOTE_PATH="${REMOTE_PATH:-pdexplorer-backups}"       # dir on the box (rel. to home, or absolute)
REMOTE_PORT="${REMOTE_PORT:-22}"
SSH_KEY="${SSH_KEY:-/root/.ssh/pdex_backup_ed25519}"   # dedicated key, no passphrase
REMOTE_MAX_BACKUPS="${REMOTE_MAX_BACKUPS:-14}"         # off-box generations to keep (newest N)
SSH_EXTRA_OPTS="${SSH_EXTRA_OPTS:-}"                   # any extra `ssh` flags

# Build the throttling prefix once (empty if disabled or tools absent).
IONICE=""
if [ "$IO_NICE" = "1" ]; then
    command -v ionice >/dev/null 2>&1 && IONICE="ionice -c3 "
    command -v nice   >/dev/null 2>&1 && IONICE="${IONICE}nice -n19 "
fi

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "FATAL: $*" >&2; exit 1; }

# ---- Pre-flight ------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not installed (apt install sqlite3)"
[ -r "$SRC" ] || die "Source DB unreadable: $SRC"
mkdir -p "$DEST" || die "Cannot create backup dir: $DEST"
[ -w "$DEST" ] || die "Backup dir not writable: $DEST"

case "$COMPRESS" in
    gzip|zstd|none) ;;
    *) die "Unknown COMPRESS='$COMPRESS' (expected gzip|zstd|none)" ;;
esac
if [ "$COMPRESS" = "zstd" ]; then
    command -v zstd >/dev/null 2>&1 || die "zstd not installed but COMPRESS=zstd"
fi

# Only one backup at a time. flock auto-releases when this shell exits.
exec 9>"$LOCKFILE"
flock -n 9 || { log "Another backup is already running — exiting."; exit 0; }

# ---- Off-box push (rsync over SSH) ----------------------------------------
# Pushes EVERY local backup the remote doesn't already have — not just the one
# this run produced. Rationale: if a push ever fails (bad key, box offline, dir
# missing), that copy would otherwise be stranded forever, because the interval
# throttle below exits before the push on every subsequent run. Syncing the
# whole local set makes each run self-healing. rsync skips files already present
# with matching size+mtime, so the steady-state cost is one cheap file-list
# exchange, not a re-upload.
#
# Returns 0 on success (or when deliberately disabled), 1 on failure — the
# caller maps that to exit 3 so monitoring notices while the local copy stays
# intact.
push_offbox() {
    if [ "$REMOTE_ENABLED" != "1" ]; then
        log "Off-box push disabled (REMOTE_ENABLED=0) — backups exist ONLY on this machine."
        log "To enable: set REMOTE_ENABLED=1 plus REMOTE_HOST/REMOTE_USER in /etc/default/pdexplorer-backup"
        return 0
    fi
    if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_USER" ]; then
        log "REMOTE_ENABLED=1 but REMOTE_HOST/REMOTE_USER unset — cannot push off-box"
        return 1
    fi
    # A .pub file is the PUBLIC key; `ssh -i` needs the PRIVATE key. Pointing
    # SSH_KEY at the .pub is an easy mistake AND a silent one — the file is
    # readable, so it sails past the check below and ssh then fails auth under
    # BatchMode with a confusing error. Correct it here and say so.
    case "$SSH_KEY" in
        *.pub)
            if [ -r "${SSH_KEY%.pub}" ]; then
                log "NOTE: SSH_KEY pointed at the PUBLIC key ($SSH_KEY) — using the private key ${SSH_KEY%.pub} instead."
                log "      Fix /etc/default/pdexplorer-backup: SSH_KEY=${SSH_KEY%.pub}"
                SSH_KEY="${SSH_KEY%.pub}"
            else
                log "WARNING: SSH_KEY=$SSH_KEY is a PUBLIC key and no private key exists at ${SSH_KEY%.pub}"
                log "         ssh -i needs the PRIVATE key. Authentication will fail."
            fi
            ;;
    esac
    if [ -n "$SSH_KEY" ] && [ ! -r "$SSH_KEY" ]; then
        log "WARNING: SSH_KEY=$SSH_KEY missing or unreadable by $(id -un) — falling back to default keys."
        log "         With BatchMode=yes this fails unless another key already authenticates."
    fi

    # Newest N only — matches the off-box retention, so we never upload copies
    # the remote rotation is about to delete.
    mapfile -t PUSH_FILES < <(find "$DEST" -maxdepth 1 -type f \
        \( -name 'explorer-*.db' -o -name 'explorer-*.db.gz' -o -name 'explorer-*.db.zst' \) \
        ! -name '*.CORRUPT' | sort -r | head -n "$REMOTE_MAX_BACKUPS")
    if [ "${#PUSH_FILES[@]}" -eq 0 ]; then
        log "No local backups to push"
        return 0
    fi

    # BatchMode=yes: never prompt (cron-safe) — key auth is required.
    # accept-new: trust-on-first-use for the host key, no interactive prompt.
    SSH_CMD="ssh -p $REMOTE_PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
    [ -n "$SSH_KEY" ] && [ -r "$SSH_KEY" ] && SSH_CMD="$SSH_CMD -i $SSH_KEY"
    [ -n "$SSH_EXTRA_OPTS" ] && SSH_CMD="$SSH_CMD $SSH_EXTRA_OPTS"
    REMOTE_DEST="$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/"

    log "Pushing ${#PUSH_FILES[@]} backup(s) to $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH (port $REMOTE_PORT)"

    # Ensure the remote dir exists. Managed storage boxes frequently refuse
    # arbitrary SSH command exec, so prefer rsync's own --mkpath (rsync >=
    # 3.2.3) which creates the path over the rsync protocol, and fall back to
    # a best-effort mkdir.
    # NB: capture the help text into a variable rather than piping it to
    # `grep -q`. Under `set -o pipefail`, grep -q closes the pipe on its first
    # match, rsync dies with SIGPIPE (141), and the pipeline reports failure
    # even though the option IS supported — which would silently disable
    # --mkpath, the very thing that creates the remote dir on a box whose
    # shell won't run mkdir.
    MKPATH=""
    RSYNC_HELP="$(rsync --help 2>/dev/null || true)"
    if [ -n "$RSYNC_HELP" ] && [ "${RSYNC_HELP#*--mkpath}" != "$RSYNC_HELP" ]; then
        MKPATH="--mkpath"
    else
        $SSH_CMD "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'" >/dev/null 2>&1 \
            || log "Note: could not mkdir '$REMOTE_PATH' over SSH (restricted shell?) — it must already exist on the box"
    fi

    # --partial-dir keeps resumable chunks OUT of the final filename, so an
    # interrupted transfer never leaves a truncated file that later looks
    # complete to --ignore-existing style checks or to a restore.
    if ${IONICE}rsync -a --partial-dir=.pdex-partial $MKPATH --timeout=900 \
            -e "$SSH_CMD" "${PUSH_FILES[@]}" "$REMOTE_DEST"; then
        log "Off-box push ok"
    else
        rc=$?
        log "Off-box push FAILED (rsync exit $rc) — local backup is intact."
        log "  Check: (1) key auth works as $(id -un): $SSH_CMD $REMOTE_USER@$REMOTE_HOST true"
        log "         (2) port $REMOTE_PORT is correct for this host"
        log "         (3) '$REMOTE_PATH' exists and is writable on the box"
        return 1
    fi

    # Remote rotation: keep newest REMOTE_MAX_BACKUPS (best-effort — needs SSH
    # command exec, which some storage boxes disallow). List → filter to our
    # strict filename pattern → drop the newest N → delete the rest. The grep
    # guarantees only our own timestamped backups are ever passed to rm.
    REMOTE_DEL="$($SSH_CMD "$REMOTE_USER@$REMOTE_HOST" "ls -1 '$REMOTE_PATH' 2>/dev/null" 2>/dev/null \
        | grep -E '^explorer-[0-9]{8}T[0-9]{6}Z\.db(\.gz|\.zst)?$' \
        | sort -r | tail -n +"$((REMOTE_MAX_BACKUPS + 1))" || true)"
    if [ -n "$REMOTE_DEL" ]; then
        if printf '%s\n' "$REMOTE_DEL" | $SSH_CMD "$REMOTE_USER@$REMOTE_HOST" "cd '$REMOTE_PATH' && xargs -r rm -f --" 2>/dev/null; then
            log "Remote rotation ok (removed $(printf '%s\n' "$REMOTE_DEL" | grep -c .) beyond newest $REMOTE_MAX_BACKUPS)"
        else
            log "Remote rotation skipped (SSH command exec not permitted?) — prune on the box"
        fi
    else
        log "Remote rotation: nothing to prune (<= $REMOTE_MAX_BACKUPS off-box)"
    fi
    return 0
}

# ---- Interval throttle (every-other-day cadence by default) ---------------
# `find ... -mmin -N` returns files modified in the last N minutes. If any
# existing backup is younger than MIN_INTERVAL_HOURS, skip — cron will retry
# tomorrow and the elapsed time will exceed the threshold.
if [ "$FORCE" != "1" ] && [ "$MIN_INTERVAL_HOURS" -gt 0 ]; then
    INTERVAL_MIN=$(( MIN_INTERVAL_HOURS * 60 ))
    RECENT="$(find "$DEST" -maxdepth 1 -type f \
        \( -name 'explorer-*.db' -o -name 'explorer-*.db.gz' -o -name 'explorer-*.db.zst' \) \
        ! -name '*.CORRUPT' \
        -mmin -"$INTERVAL_MIN" -print -quit 2>/dev/null || true)"
    if [ -n "$RECENT" ]; then
        AGE_HOURS=$(( ( $(date +%s) - $(stat -c %Y "$RECENT" 2>/dev/null || stat -f %m "$RECENT") ) / 3600 ))
        log "Recent backup exists (${AGE_HOURS}h old): $(basename "$RECENT")"
        log "Skipping new snapshot — next backup in ~$(( MIN_INTERVAL_HOURS - AGE_HOURS ))h. Set FORCE=1 to override."
        # Still attempt the off-box push before exiting. A previous run may have
        # written a local backup whose upload failed; without this the throttle
        # would exit first on every subsequent run and that copy would never be
        # retried — so one transient SSH error could mean weeks of backups that
        # exist only on the machine being backed up.
        if push_offbox; then
            exit 0
        else
            log "WARNING: off-box push did not complete."
            exit 3
        fi
    fi
fi

# ---- Take the backup -------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$DEST/explorer-$TS.db"

log "Starting online backup: $SRC -> $TMP"
START=$(date +%s)

# Use VACUUM INTO, NOT the `.backup` online-backup API. `.backup` RESTARTS the
# copy from scratch whenever another connection writes the source — and the
# indexer writes every ~12s, so `.backup` thrashes and can take hours or never
# finish on a busy multi-GB DB. VACUUM INTO reads ONE consistent WAL snapshot
# (writers proceed uninterrupted), never restarts, and emits a compacted,
# single-file copy (no -wal/-shm to ship). Requires SQLite >= 3.27 (2019).
# Run under the idle I/O class so it never starves serving.
${IONICE}sqlite3 "$SRC" "VACUUM INTO '$TMP'"

ELAPSED=$(( $(date +%s) - START ))
SIZE_HUMAN=$(du -h "$TMP" | cut -f1)
log "Backup written in ${ELAPSED}s ($SIZE_HUMAN)"

# ---- Verify ---------------------------------------------------------------
if [ "$INTEGRITY_CHECK" != "off" ]; then
    log "Running integrity_check on the copy"
    RESULT="$(${IONICE}sqlite3 "$TMP" 'PRAGMA integrity_check;' || true)"
    if [ "$RESULT" != "ok" ]; then
        mv "$TMP" "$TMP.CORRUPT"
        log "integrity_check FAILED: $RESULT"
        log "Bad copy retained at: $TMP.CORRUPT (no rotation performed)"
        exit 2
    fi
    log "integrity_check ok"
else
    log "integrity_check skipped (INTEGRITY_CHECK=off) — verify a copy out-of-band"
fi

# ---- Compress -------------------------------------------------------------
case "$COMPRESS" in
    gzip)
        # pigz is a drop-in parallel gzip producing byte-identical .gz output,
        # so it's safe to prefer transparently — on a multi-core box it turns
        # tens of minutes into a couple, and `gunzip` still restores it.
        if command -v pigz >/dev/null 2>&1; then
            ${IONICE}pigz -"$COMPRESS_LEVEL" "$TMP"
        else
            ${IONICE}gzip -"$COMPRESS_LEVEL" "$TMP"
        fi
        FINAL="$TMP.gz"
        ;;
    zstd)
        # -T0 = use all cores.
        ${IONICE}zstd -q -T0 -"$COMPRESS_LEVEL" --rm "$TMP" -o "$TMP.zst"
        FINAL="$TMP.zst"
        ;;
    none)
        FINAL="$TMP"
        ;;
esac
log "Compressed: $FINAL ($(du -h "$FINAL" | cut -f1))"

# ---- Rotate (keep newest MAX_BACKUPS) -------------------------------------
# Count-based: list backups newest-first (the embedded UTC timestamp sorts
# lexically = chronologically) and delete everything past MAX_BACKUPS. The
# newest is always retained; missed cron runs never over-prune because we key
# off count, not age.
mapfile -t ALL_LOCAL < <(find "$DEST" -maxdepth 1 -type f \
    \( -name 'explorer-*.db' -o -name 'explorer-*.db.gz' -o -name 'explorer-*.db.zst' \) \
    ! -name '*.CORRUPT' -printf '%f\n' | sort -r)
DELETED=0
if [ "${#ALL_LOCAL[@]}" -gt "$MAX_BACKUPS" ]; then
    for f in "${ALL_LOCAL[@]:$MAX_BACKUPS}"; do
        rm -f -- "$DEST/$f" && DELETED=$((DELETED + 1))
    done
fi
log "Rotation: kept newest $(( ${#ALL_LOCAL[@]} - DELETED )) of ${#ALL_LOCAL[@]} (MAX_BACKUPS=$MAX_BACKUPS), removed $DELETED"

# ---- Push to external storage (rsync over SSH) ----------------------------
# The local copy above is the fast-restore tier; this pushes a verified copy
# off-box for durability. A remote failure does NOT fail the local backup —
# it exits 3 so monitoring notices while the on-disk backup stays intact.
REMOTE_OK=1
push_offbox || REMOTE_OK=0

# ---- Summary --------------------------------------------------------------
COUNT=$(find "$DEST" -maxdepth 1 -type f -name 'explorer-*.db*' ! -name '*.CORRUPT' | wc -l)
TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
log "Done. $COUNT backup(s) on disk, total $TOTAL"
[ "$REMOTE_OK" = "1" ] || { log "WARNING: off-box push did not complete."; exit 3; }
