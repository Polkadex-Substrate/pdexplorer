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
# Restore (with the stack stopped):
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
KEEP_DAYS="${KEEP_DAYS:-14}"          # delete *.db.gz older than this
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

# ---- Rotate ---------------------------------------------------------------
# Rotate by file age, not count — survives missed cron runs without
# accidentally pruning recent backups.
log "Rotating backups older than $KEEP_DAYS days from $DEST"
DELETED=$(find "$DEST" \
    -maxdepth 1 -type f \
    \( -name 'explorer-*.db' \
       -o -name 'explorer-*.db.gz' \
       -o -name 'explorer-*.db.zst' \) \
    -mtime +"$KEEP_DAYS" -print -delete | wc -l)
log "Rotated $DELETED file(s)"

# ---- Summary --------------------------------------------------------------
COUNT=$(find "$DEST" -maxdepth 1 -type f -name 'explorer-*.db*' ! -name '*.CORRUPT' | wc -l)
TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
log "Done. $COUNT backup(s) on disk, total $TOTAL"
