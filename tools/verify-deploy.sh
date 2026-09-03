#!/usr/bin/env bash
#
# Post-deploy verification.  (v3)
#
# Usage:  bash tools/verify-deploy.sh [expected-sha]
#         expected-sha defaults to `git rev-parse --short=12 HEAD`.
#
# Audit F-200 fixed two things that made v2 dangerous rather than merely wrong:
#
#   1. FAILURES DID NOT PROPAGATE. The script runs `set -uo pipefail` without
#      `-e`, and failure was signalled by `fail()` setting FAILED=1. Two of the
#      embedded python3 blocks printed a red FAIL line and never touched FAILED
#      — a subprocess cannot assign to its parent's shell variable, and one of
#      them additionally `sys.exit(0)`'d. So the footer printed a green "All
#      automated checks passed" over a real failure. An unattended probe that
#      is green when the feature it checks is ABSENT is worse than no probe.
#
#      Every embedded block now exits NON-ZERO on failure and the shell checks
#      that exit status, so propagation is structural rather than a convention
#      each block has to remember.
#
#   2. THE SHA WAS BAKED INTO THE FILENAME. Pinned to f4ea9037d598, so on every
#      later deploy it reported a permanent red SHA mismatch — and an operator
#      who learns to ignore one red line will ignore the next one too.
#
# Run ON THE HOST (root@explorer1:/opt/pdexplorer). Uses 127.0.0.1 throughout so
# Cloudflare is out of the path — the edge blocks non-browser /api/* requests.
#
# v1 had three bugs of its own, all fixed here and worth naming because two of
# them produced FAILs that were not real:
#   * `python3 - <<'PY' <<<"$V"` has TWO stdin redirects. The herestring wins, so
#     python received the JSON as its SOURCE and died on `true`. The validator
#     check never ran at all.
#   * the SQLite file is explorer.db, not pdexplorer.db.
#   * knownGapBlocks / gapsExhausted are nested under `coverage`, not top level.
#   * the cache probe asserted no-store on a 404 — but 404 is DELIBERATELY
#     cacheable (a missing block is stably missing), so that FAIL was the script
#     being wrong, not the server. It now asserts the property that matters:
#     no error response may carry a PUBLIC cache directive.

set -uo pipefail
API=http://127.0.0.1:3001
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
FAILED=0

# Run an embedded python3 check. The block prints its own detail and exits
# non-zero to signal failure; this converts that into FAILED=1.
#
# F-200: the blocks used to print a red FAIL themselves and return 0, which the
# shell could not see. Nothing enforces that a python block calls fail() — but
# an exit status is checked here, once, for all of them.
pycheck() {
    local label="$1"; shift
    if python3 "$@"; then :; else fail "$label"; fi
}

EXPECTED_SHA="${1:-$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
if [ "$EXPECTED_SHA" = "unknown" ]; then
    fail "no expected SHA: pass one as \$1 or run inside the git checkout"
fi

find_db() {
    local p
    p=$(grep -E '^[[:space:]]*DATA_PATH=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
    for c in "${p:-}/explorer.db" ./data/explorer.db /opt/pdexplorer/data/explorer.db \
             /opt/pdexplorer-data/explorer.db; do
        [ -n "$c" ] && [ -f "$c" ] && { echo "$c"; return; }
    done
    docker exec pdexplorer-backend sh -c 'ls -1 /app/data/*.db 2>/dev/null | head -1' 2>/dev/null
}
DB=$(find_db)
SQL() { [ -n "$DB" ] && { [ -f "$DB" ] && sqlite3 "$DB" "$1" 2>/dev/null || docker exec pdexplorer-backend sqlite3 "$DB" "$1" 2>/dev/null; }; }

echo
echo "=== 1. Build identity ==="
BE=$(curl -fsS --max-time 10 "$API/api/version" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("gitSha","?"))' 2>/dev/null || echo unreachable)
FE=$(curl -fsS --max-time 10 http://127.0.0.1/version.json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("gitSha","?"))' 2>/dev/null || echo unreachable)
info "backend=$BE frontend=$FE   db=${DB:-<not found>}"
[ "$BE" = "$EXPECTED_SHA" ] && pass "backend is $EXPECTED_SHA" || fail "backend reports $BE, expected $EXPECTED_SHA"
[ "$FE" = "$EXPECTED_SHA" ] && pass "frontend is $EXPECTED_SHA" || fail "frontend reports $FE, expected $EXPECTED_SHA"

echo
echo "=== 2. Commission history (the feature this deploy is for) ==="
curl -fsS --max-time 60 "$API/api/validators" -o /tmp/vals.json 2>/dev/null
if [ ! -s /tmp/vals.json ]; then
    fail "/api/validators returned nothing"
else
pycheck "validator commission enrichment" - /tmp/vals.json <<'PY'
import sys, json, collections
d = json.load(open(sys.argv[1]))
vs = d.get('validators') or []
G, R, N = '\033[32m', '\033[31m', '\033[0m'
print(f"        {len(vs)} validators; commissionHistoryEra={d.get('commissionHistoryEra')}")

have = [v for v in vs if isinstance(v.get('commissionHistory'), dict)]
if not have:
    print(f"  {R}FAIL{N}  no validator carries commissionHistory — the enrichment is not running")
    sys.exit(1)   # F-200: must be non-zero, or the footer prints green over this
print(f"  {G}PASS{N}  commissionHistory present on {len(have)}/{len(vs)} validators")

vol = collections.Counter(v['commissionHistory'].get('volatility') for v in have)
tracked = [v['commissionHistory'].get('erasTracked', 0) for v in have]
print(f"        volatility: {dict(vol)}")
print(f"        erasTracked: min={min(tracked)} max={max(tracked)}")

if d.get('commissionHistoryEra') is None:
    print(f"  {R}FAIL{N}  commissionHistoryEra is null — recency checking is OFF (cold network_info)")
    sys.exit(1)
else:
    print(f"  {G}PASS{N}  activeEra resolved, so raisedRecently is live")

if vol.get('unknown', 0) == len(have):
    print("        NOTE  every validator is 'unknown' — expected on a cold index.")
    print("              syncData fills this in hourly; re-run in ~2h.")

flagged = [v for v in have if v['commissionHistory'].get('raisedRecently')]
pending = [v for v in have if v['commissionHistory'].get('pendingRaise')]
print(f"        raisedRecently={len(flagged)}  pendingRaise={len(pending)}")
for v in (flagged + pending)[:6]:
    h = v['commissionHistory']
    nm = (v.get('name') or v.get('address') or '?')[:26]
    print(f"          {nm:26} now={v.get('commission')}%  {h.get('note')}")

# The blocker the review caught: unelected eras read as 0% and manufacture a
# fake "raised from 0%". If the filter is working, no validator with a recorded
# change should have a 0% floor.
bad = [v for v in have
       if v['commissionHistory'].get('min') == 0
       and v['commissionHistory'].get('changes', 0) > 0]
if bad:
    print(f"  {R}FAIL{N}  {len(bad)} validator(s) show min=0% with a change — unelected eras are leaking in")
    sys.exit(1)
    for v in bad[:3]:
        print(f"          {(v.get('name') or v['address'])[:26]}  {v['commissionHistory'].get('note')}")
else:
    print(f"  {G}PASS{N}  no validator shows a phantom 0% commission floor")

# Sanity: the note must never be shown for an 'unknown' history.
noisy = [v for v in have
         if v['commissionHistory'].get('volatility') == 'unknown'
         and v['commissionHistory'].get('note')]
if noisy:
    print(f"  {R}FAIL{N}  {len(noisy)} 'unknown' validator(s) carry a note — that claims knowledge we lack")
    sys.exit(1)
else:
    print(f"  {G}PASS{N}  'unknown' histories stay quiet")
PY
fi

echo
echo "=== 3. New schema (rate_limits) applied to the live database ==="
if [ -n "$DB" ]; then
    T=$(SQL "SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits';")
    [ "$T" = "rate_limits" ] && pass "rate_limits table exists" \
        || fail "rate_limits missing — the F-075 limiter falls open on every request"
    info "schema marker: $(SQL "SELECT value FROM kv WHERE key='schema:applied';" | head -c 100)"
else
    fail "could not locate explorer.db"
fi

echo
echo "=== 4. Validator history is advancing (review BLOCKER-2) ==="
if [ -n "$DB" ]; then
    read -r MAXERA ROWS < <(SQL "SELECT IFNULL(MAX(era),0), COUNT(*) FROM validator_history;" | tr '|' ' ')
    ACTIVE=$(curl -fsS --max-time 15 "$API/api/network-info" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("activeEra","?"))' 2>/dev/null || echo '?')
    info "validator_history MAX(era)=$MAXERA rows=$ROWS   chain activeEra=$ACTIVE"
    if [ "$ACTIVE" != "?" ] && [ -n "$MAXERA" ]; then
        LAG=$(( ACTIVE - MAXERA ))
        if [ "$LAG" -le 1 ]; then pass "history is current (lag ${LAG} era)"
        elif [ "$LAG" -le 3 ]; then pass "history lag ${LAG} eras — acceptable, syncData runs hourly"
        else info "history lag ${LAG} eras — expected right after deploy; must SHRINK. Re-run in ~2h."
        fi
    fi
    info "re-run later:  sqlite3 $DB 'SELECT MAX(era), COUNT(*) FROM validator_history;'"
fi

echo
echo "=== 5. No error response is publicly cacheable (F-087 / F-076) ==="
OK200=$(curl -fsS -o /dev/null -D - --max-time 10 "$API/api/blocks" 2>/dev/null | grep -i '^cache-control:' | tr -d '\r')
info "200 /api/blocks -> ${OK200:-<none>}"
echo "$OK200" | grep -qi 'public' && pass "a healthy 200 is still cacheable" \
    || fail "a 200 lost its public cache header — CDN offload is gone"
BADPUB=0
for U in "/api/state/nosuchpallet/nosuchitem" "/api/wallet/notanaddress" "/api/block/999999999999" "/api/validator/notanaddress"; do
    H=$(curl -s -o /dev/null -D - --max-time 10 "$API$U" 2>/dev/null | tr -d '\r')
    CODE=$(echo "$H" | head -1 | awk '{print $2}')
    CC=$(echo "$H" | grep -i '^cache-control:' | cut -d' ' -f2-)
    info "$CODE $U -> ${CC:-<no cache-control>}"
    echo "$CC" | grep -qi 'public' && { fail "$U returns $CODE with a PUBLIC cache directive"; BADPUB=1; }
done
[ "$BADPUB" -eq 0 ] && pass "no error path advertises public caching"

echo
echo "=== 6. Access log carries no tokens (F-091) ==="
L=$(docker logs pdexplorer-frontend 2>&1 | tail -400)
TOK=$(printf '%s' "$L" | grep -c 'token=' || true)
RT=$(printf '%s' "$L" | grep -c 'rt=' || true)
[ "${TOK:-0}" -eq 0 ] && pass "no token= in the last 400 frontend log lines" \
    || fail "$TOK log line(s) contain token= — the noquery format is not in effect"
[ "${RT:-0}" -gt 0 ] && pass "the noquery format is live (${RT}/400 lines carry rt=)" \
    || info "no rt= marker seen — low traffic, or the format did not apply"

echo
echo "=== 7. Index coverage, including the new gapsExhausted (F-046) ==="
curl -fsS --max-time 15 "$API/api/blocks" -o /tmp/blocks.json 2>/dev/null
pycheck "index coverage fields" - /tmp/blocks.json <<'PY'
import sys, json
try: d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"  \033[31mFAIL\033[0m  could not read /api/blocks: {e}")
    sys.exit(1)   # F-200: an unreadable endpoint is a failure, not a skip
c = d.get('coverage') or {}
print(f"        status = {d.get('status')}")
for k in ('knownGapBlocks','gapsExhausted','retryableFailures','permanentFailures'):
    print(f"        {k} = {c.get(k)}")
if c.get('detail'): print(f"        detail = {c['detail']}")
if c.get('gapsExhausted'):
    print("        NOTE  some gaps are no longer retried this round — is the RPC an archive node?")
if 'gapsExhausted' not in c:
    print("  \033[31mFAIL\033[0m  gapsExhausted absent — the F-046 honesty signal did not ship")
    sys.exit(1)
PY

echo
echo "=== 8. Boot health ==="
BL=$(docker logs pdexplorer-backend 2>&1 | tail -400)
ERR=$(printf '%s' "$BL" | grep -ciE 'fatal|unrecoverable|SQLITE_BUSY|refusing' || true)
[ "${ERR:-0}" -eq 0 ] && pass "no fatal/busy lines in the last 400 backend log lines" \
    || fail "$ERR concerning line(s): docker logs pdexplorer-backend | tail -400"
printf '%s' "$BL" | grep -iE 'schema (applied|skipped)|clamping|enrichment skipped|falling open|gap attempt' | tail -6 | sed 's/^/        /'

echo
if [ "$FAILED" -eq 0 ]; then printf '\033[32mAll automated checks passed.\033[0m\n'
else printf '\033[31mSome checks failed — see FAIL lines above.\033[0m\n'; fi
# F-200: exit status too. A wrapper or cron job cannot read the colour.
[ "$FAILED" -eq 0 ] || exit 1
cat <<'EOT'

Only a browser can verify these three:
  1. /validators — the Commission column should show a second line under the
     percentage. "history not yet indexed" is correct on a cold index.
  2. Open the Commission filter and pick EVERY option in turn. If any selection
     blanks the table and it stays blank, stop and tell me — that is the
     Object.prototype class of bug and it would affect every filtered table.
  3. DevTools console on a hard reload: zero CSP violations, and one wallet
     signature must complete (sr25519 needs 'wasm-unsafe-eval').
EOT
