#!/usr/bin/env bash
# =============================================================================
# Polkadex Explorer — SQLite online backup
# =============================================================================
#
# Runs SQLite's online backup against the live explorer.db, integrity-checks
# the copy, gzips it, and rotates old backups by age. WAL-safe — the indexer
# can keep writing while this runs.
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
LOCKFILE="${LOCKFILE:-/var/lock/pdexplorer-backup.lock}"
# Set FORCE=1 to bypass the interval check (e.g. to take an ad-hoc snapshot
# right before a risky operation).
FORCE="${FORCE:-0}"
# I/O throttling. The .backup copy + integrity_check + compression are all
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
        log "Skipping — next backup in ~$(( MIN_INTERVAL_HOURS - AGE_HOURS ))h. Set FORCE=1 to override."
        exit 0
    fi
fi

# ---- Take the backup -------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$DEST/explorer-$TS.db"

log "Starting online backup: $SRC -> $TMP"
START=$(date +%s)

# `.backup` uses SQLite's online backup API: WAL-safe, page-by-page copy,
# brief shared locks per page, leaves the source DB untouched. Run under the
# idle I/O class so it never starves the live indexer/serving.
${IONICE}sqlite3 "$SRC" ".backup '$TMP'"

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
        ${IONICE}gzip -9 "$TMP"
        FINAL="$TMP.gz"
        ;;
    zstd)
        ${IONICE}zstd -q -19 --rm "$TMP" -o "$TMP.zst"
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
if [ "$REMOTE_ENABLED" = "1" ]; then
    if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_USER" ]; then
        log "REMOTE_ENABLED=1 but REMOTE_HOST/REMOTE_USER unset — skipping off-box push"
        REMOTE_OK=0
    else
        # BatchMode=yes: never prompt (cron-safe) — key auth is required.
        # accept-new: trust-on-first-use for the host key, no interactive prompt.
        SSH_CMD="ssh -p $REMOTE_PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
        [ -n "$SSH_KEY" ] && [ -r "$SSH_KEY" ] && SSH_CMD="$SSH_CMD -i $SSH_KEY"
        [ -n "$SSH_EXTRA_OPTS" ] && SSH_CMD="$SSH_CMD $SSH_EXTRA_OPTS"
        REMOTE_DEST="$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/"

        log "Pushing $(basename "$FINAL") to $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH"
        # Ensure the remote dir exists (best-effort; rsync also creates the leaf).
        $SSH_CMD "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'" 2>/dev/null || true
        # --partial keeps a half-sent file for resume on the next run; the file
        # is already compressed so we don't add rsync -z. Throttled with ionice.
        if ${IONICE}rsync -a --partial --timeout=900 -e "$SSH_CMD" "$FINAL" "$REMOTE_DEST"; then
            log "Off-box push ok"
            # Remote rotation: keep newest REMOTE_MAX_BACKUPS (best-effort — needs
            # SSH command exec). List → filter to our strict filename pattern →
            # drop the newest N → delete the rest. The grep guarantees only our
            # own timestamped backups are ever passed to rm.
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
        else
            log "Off-box push FAILED — local backup is intact; check SSH key / host / path"
            REMOTE_OK=0
        fi
    fi
fi

# ---- Summary --------------------------------------------------------------
COUNT=$(find "$DEST" -maxdepth 1 -type f -name 'explorer-*.db*' ! -name '*.CORRUPT' | wc -l)
TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
log "Done. $COUNT backup(s) on disk, total $TOTAL"
[ "$REMOTE_OK" = "1" ] || { log "WARNING: off-box push did not complete."; exit 3; }
