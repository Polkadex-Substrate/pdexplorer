#!/usr/bin/env bash
#
# Post-deploy verification for build f4ea9037d598.
#
# Run ON THE HOST (root@explorer1:/opt/pdexplorer). Uses 127.0.0.1 throughout so
# Cloudflare is out of the path — the edge blocks non-browser /api/* requests,
# which is why this cannot be checked from a laptop.
#
# Every check prints PASS or FAIL plus the evidence. Nothing here writes.
#
# What this deploy introduced, and therefore what is worth checking:
#   * commissionHistory on /api/validators  (the nominator complaint)
#   * a new rate_limits table               (F-075 — schema fingerprint migration)
#   * syncData on an interval               (the review's BLOCKER-2)
#   * a response-cache guard middleware     (F-087/F-076)
#   * query-stripped nginx access logs      (F-091)
#   * gapsExhausted in the index status      (F-046)

set -uo pipefail
API=http://127.0.0.1:3001
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
FAILED=0

echo
echo "=== 1. Build identity ==="
BE=$(curl -fsS --max-time 10 "$API/api/version" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("gitSha","?"))' 2>/dev/null || echo unreachable)
FE=$(curl -fsS --max-time 10 http://127.0.0.1/version.json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("gitSha","?"))' 2>/dev/null || echo unreachable)
info "backend=$BE frontend=$FE"
[ "$BE" = "f4ea9037d598" ] && pass "backend is the expected build" || fail "backend reports $BE"
[ "$FE" = "f4ea9037d598" ] && pass "frontend is the expected build" || fail "frontend reports $FE"

echo
echo "=== 2. Commission history (the feature this deploy is for) ==="
V=$(curl -fsS --max-time 30 "$API/api/validators" 2>/dev/null)
if [ -z "$V" ]; then
    fail "/api/validators returned nothing"
else
python3 - <<'PY' <<<"$V"
import sys, json, collections
d = json.load(sys.stdin)
vs = d.get('validators') or []
print(f"        {len(vs)} validators; commissionHistoryEra={d.get('commissionHistoryEra')}")
have = [v for v in vs if isinstance(v.get('commissionHistory'), dict)]
if not have:
    print("  \033[31mFAIL\033[0m  no validator carries commissionHistory — the enrichment is not running")
    sys.exit(0)
print(f"  \033[32mPASS\033[0m  commissionHistory present on {len(have)}/{len(vs)} validators")

vol = collections.Counter(v['commissionHistory'].get('volatility') for v in have)
print("        volatility:", dict(vol))
tracked = [v['commissionHistory'].get('erasTracked', 0) for v in have]
print(f"        erasTracked: min={min(tracked)} max={max(tracked)}")

if d.get('commissionHistoryEra') is None:
    print("  \033[31mFAIL\033[0m  commissionHistoryEra is null — recency checking is OFF (cold network_info)")
else:
    print("  \033[32mPASS\033[0m  activeEra resolved, so raisedRecently is live")

if vol.get('unknown', 0) == len(have):
    print("        NOTE  every validator is 'unknown' — expected on a cold index;")
    print("              syncData fills this in hourly. Re-run in ~2h.")

flagged = [v for v in have if v['commissionHistory'].get('raisedRecently')]
pending = [v for v in have if v['commissionHistory'].get('pendingRaise')]
print(f"        raisedRecently={len(flagged)}  pendingRaise={len(pending)}")
for v in (flagged + pending)[:5]:
    h = v['commissionHistory']
    print(f"          {(v.get('name') or v['address'])[:28]:28} now={v.get('commission')}% {h.get('note')}")

# The blocker the review caught: a 0% floor means unelected eras leaked in.
bad = [v for v in have if h_ok(v)] if False else [
    v for v in have
    if v['commissionHistory'].get('min') == 0 and v['commissionHistory'].get('changes', 0) > 0
]
if bad:
    print(f"  \033[31mFAIL\033[0m  {len(bad)} validator(s) show min=0% with a change — unelected eras are leaking in")
    for v in bad[:3]:
        print(f"          {(v.get('name') or v['address'])[:28]} {v['commissionHistory'].get('note')}")
else:
    print("  \033[32mPASS\033[0m  no validator shows a phantom 0% commission floor")
PY
fi

echo
echo "=== 3. New schema (rate_limits) applied to the live database ==="
DB=$(grep -E '^DATA_PATH=' .env 2>/dev/null | cut -d= -f2)
DB="${DB:-/opt/pdexplorer-data}/pdexplorer.db"
if [ -f "$DB" ]; then
    T=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits';" 2>/dev/null)
    [ "$T" = "rate_limits" ] && pass "rate_limits table exists" || fail "rate_limits table missing — the F-075 limiter will fail open on every request"
    MARK=$(sqlite3 "$DB" "SELECT value FROM kv WHERE key='schema:applied';" 2>/dev/null | head -c 120)
    info "schema:applied = ${MARK:-<unset>}"
else
    info "database not at $DB — set DATA_PATH or check manually"
fi

echo
echo "=== 4. syncData is on an interval (review BLOCKER-2) ==="
info "newest era in validator_history, now and again in ~70 minutes:"
if [ -f "$DB" ]; then
    E1=$(sqlite3 "$DB" "SELECT MAX(era) FROM validator_history;" 2>/dev/null)
    A1=$(sqlite3 "$DB" "SELECT COUNT(*) FROM validator_history;" 2>/dev/null)
    info "MAX(era)=$E1  rows=$A1"
    info "re-run:  sqlite3 $DB 'SELECT MAX(era), COUNT(*) FROM validator_history;'"
    info "MAX(era) must advance as eras turn over (~24h each); rows must grow."
fi

echo
echo "=== 5. Response-cache guard (F-087 / F-076) ==="
CT=$(curl -fsS -o /dev/null -D - --max-time 10 "$API/api/blocks" 2>/dev/null | grep -i '^cache-control:' | tr -d '\r')
info "200 /api/blocks -> ${CT:-<none>}"
echo "$CT" | grep -qi 'public' && pass "a healthy 200 is still cacheable" || fail "a 200 lost its public cache header — CDN offload is gone"
EC=$(curl -s -o /dev/null -D - --max-time 10 "$API/api/state/nosuchpallet/nosuchitem" 2>/dev/null | grep -iE '^(HTTP/|cache-control:)' | tr -d '\r' | tr '\n' ' ')
info "error path -> ${EC:-<none>}"
echo "$EC" | grep -qi 'no-store' && pass "an error response is no-store" || fail "an error response is cacheable — one blip pins at the edge for 10 min"

echo
echo "=== 6. Access log carries no tokens (F-091) ==="
LOGGED=$(docker logs pdexplorer-frontend 2>&1 | tail -400 | grep -c 'token=' || true)
[ "${LOGGED:-0}" -eq 0 ] && pass "no token= in the last 400 frontend log lines" || fail "$LOGGED log line(s) contain token= — the noquery format is not in effect"
DUP=$(docker logs pdexplorer-frontend 2>&1 | tail -200 | grep -c 'rt=' || true)
info "lines carrying the noquery marker (rt=): ${DUP:-0} of the last 200"

echo
echo "=== 7. Index status, including the new gapsExhausted (F-046) ==="
curl -fsS --max-time 15 "$API/api/blocks" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
for k in ("status","knownGapBlocks","gapsExhausted","latestScannedBlock","oldestScannedBlock","backfillComplete"):
    if k in d: print(f"        {k} = {d[k]}")
if d.get("gapsExhausted", 0):
    print("        NOTE  some gaps are no longer being retried — is the RPC an archive node?")
' 2>/dev/null || info "could not read /api/blocks"

echo
echo "=== 8. Boot health ==="
ERR=$(docker logs pdexplorer-backend 2>&1 | tail -300 | grep -ciE 'fatal|unrecoverable|SQLITE_BUSY|refusing' || true)
[ "${ERR:-0}" -eq 0 ] && pass "no fatal/busy lines in the last 300 backend log lines" || fail "$ERR concerning line(s) — inspect: docker logs pdexplorer-backend | tail -300"
docker logs pdexplorer-backend 2>&1 | tail -300 | grep -iE 'clamping|enrichment skipped|falling open|schema' | tail -6 | sed 's/^/        /'

echo
if [ "$FAILED" -eq 0 ]; then
    printf '\033[32mAll automated checks passed.\033[0m\n'
else
    printf '\033[31mSome checks failed — see FAIL lines above.\033[0m\n'
fi
cat <<'EOT'

Only a browser can verify these three:
  1. Open /validators — the Commission column should show a second line
     ("unchanged across N tracked eras" or "raised N× ..."). On a cold index
     it will say "history not yet indexed"; that is correct, not a bug.
  2. Open the Commission filter dropdown and pick each option in turn. If ANY
     selection blanks the table and it stays blank, stop and tell me — that is
     the Object.prototype.valueOf class of bug and it would affect every
     filtered table on the site.
  3. DevTools console on a hard reload: zero CSP violations, and one wallet
     signature must still complete (sr25519 needs 'wasm-unsafe-eval').
EOT
