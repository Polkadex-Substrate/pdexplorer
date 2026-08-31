# Round-2 audit remediation — deploy checklist

One-off document for this batch. Delete it once the deploy is done and the
observations below have been recorded wherever you keep them.

The batch is large (1,061 tests, ~4,000 changed lines) but only four things in
it touch production **data or availability** on first boot. Everything else is
additive or cosmetic. Read those four, skip the rest if you are short of time.

---

## 1. Take a backup first — this batch deletes rows

`initDb` now runs a one-time purge of pre-v3, extrinsic-hash-keyed rows in
`transactions` (audit F-049). It is behind its own kv flag
(`migration:purge-legacy-tx-rows`), runs only on the indexer worker, and refuses
if more than 25% of the table looks legacy — but it is a `DELETE`, and the
existing backup path is the only undo.

```sh
# On the host, BEFORE deploying:
sqlite3 /opt/pdexplorer/data/explorer.db ".backup '/opt/pdexplorer/data/explorer.pre-round2.db'"
ls -lh /opt/pdexplorer/data/explorer.pre-round2.db
```

**What to expect in the boot log**, one of:

```
[migration] legacy tx purge (F-049): nothing to remove
[migration] legacy tx purge (F-049): removed N extrinsic-hash-keyed row(s) of M; cleared scannerVersion so the derivation re-crawls them as event-keyed rows
[migration] legacy tx purge REFUSED (F-049): N/M rows (X%) look legacy, above the 25% ceiling …
```

A **REFUSED** line is not a failure — it leaves the flag unset and retries next
boot. It means either a writer is not setting `event_derived`, or this database
genuinely has a large pre-v3 history. Check a sample before overriding:

```sh
sqlite3 /opt/pdexplorer/data/explorer.db \
  "SELECT hash, block, event_derived FROM transactions WHERE event_derived IS NULL OR event_derived != 1 LIMIT 20;"
```

Legacy rows have a `0x…` extrinsic hash as their `hash`. If that is what you
see, set `TX_PURGE_MAX_FRACTION` above the reported ratio and redeploy.

The purge also resets `scannerVersion`, `backfillCursor` and `backfillComplete`
for `sync:transactions`, so the event-derived walk re-derives the range it
deleted. **Expect the transaction backfill to run again** — that is intended,
not a regression. Without it the purge would trade a double-counted transfer for
a missing one.

---

## 2. The watermark split — verify the first tick does NOT re-walk the chain

`latestScannedBlock` is now derived; the resume cursor is a new field,
`headSeen`. `readHeadSeen()` adopts the existing `latestScannedBlock` from
pre-upgrade state — **if that adoption failed, the indexer would restart at
genesis and fire millions of RPC calls at `rpc.polkadex.ee`, which is the public
endpoint browsers dial.** There is a test and a mutant for it, but verify on the
box:

```sh
# Before deploy — record the current watermark:
sqlite3 /opt/pdexplorer/data/explorer.db \
  "SELECT json_extract(value,'\$.latestScannedBlock') FROM kv WHERE key='sync:chain_index';"

# After deploy, within ~30s — headSeen must be at/near that number, NOT 0:
sqlite3 /opt/pdexplorer/data/explorer.db \
  "SELECT json_extract(value,'\$.headSeen'), json_extract(value,'\$.latestScannedBlock') FROM kv WHERE key='sync:chain_index';"
```

The log line changed shape and now prints both:

```
[chain-index] head=12800000 reached=1-12800000 verified=12799987 (12799512 blocks), backfill=complete, status=Repairing, missing=13, retryable=13, permanent=0
```

`reached` >> `verified` means a hole is pinning the verified watermark; `missing`
and `retryable` say how many heights. That gap is the diagnosis, not a fault.

**Expect the status to change.** Previously every scanner reported `Synced`
almost always. It can now report `Repairing` (holes queued, being worked) and
`Degraded` (holes we have stopped retrying — usually a pruned RPC node). If the
explorer shows `Degraded` after this deploy, that is pre-existing damage
becoming visible, not damage this batch caused. Check what is queued:

```sh
sqlite3 /opt/pdexplorer/data/explorer.db \
  "SELECT indexer, COUNT(*), MIN(block), MAX(block) FROM scan_failures GROUP BY indexer;"
```

---

## 3. New environment variables — all optional, all defaulted

Nothing must be set for the deploy to work. Defaults are in `.env.example` with
the reasoning. Listed so the diff does not surprise anyone:

| Variable | Default | What it does |
|---|---|---|
| `SQLITE_BUSY_TIMEOUT_HTTP_MS` | 30000 | HTTP workers wait longer for the write lock than the indexer (F-089) |
| `SQLITE_BUSY_TIMEOUT_INDEXER_MS` | 5000 | unchanged from the old flat value |
| `CHAIN_FULL_SCAN_WINDOW` | 500000 | size of one hourly gap-sweep slice (F-047) |
| `SCAN_AMNESTY_MS` | 21600000 | how long an exhausted `scan_failures` row waits before its retries are restored |
| `RPC_MAX_PAGE` | 100 | ceiling on `state_getKeysPaged` page size (F-077) |
| `TX_PURGE_MAX_FRACTION` | 0.25 | ceiling for the F-049 purge (see §1) |
| `EMAIL_LOG_PLAINTEXT` | 0 | **leave at 0 in production** — 1 restores plaintext addresses in logs (F-090) |

---

## 4. Consider running the timestamp index migration

Not required by this batch, but this batch made it more relevant.
`/api/analytics/timeseries` now snaps `days` to `{7,30,90,365}` and keeps a short
cache on the fallthrough, which removes the exposure — but the underlying query
is still a `GROUP BY` on `timestamp`, and **production does not have
`idx_tx_timestamp` / `idx_blocks_timestamp`**: `initDb` creates them only when
the table is under 200k rows, precisely so it does not hold the write lock for
minutes on a 12.8M-row database.

```sh
# Check:
sqlite3 /opt/pdexplorer/data/explorer.db \
  "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%timestamp%';"

# If absent, run out-of-band (safe against a live DB):
docker compose exec backend node --experimental-sqlite migrate-add-indexes.mjs
```

---

## Smoke checks after deploy

```sh
# 1. Build stamp matches what you deployed
curl -s https://explorer.polkadex.ee/api/version | jq .

# 2. Health
curl -s https://explorer.polkadex.ee/api/health | jq .

# 3. The new coverage fields are populated (not all zeros)
curl -s https://explorer.polkadex.ee/api/blocks | jq '.coverage'

# 4. Wallet payload carries provenance + index blocks (F-085)
curl -s https://explorer.polkadex.ee/api/wallet/<an-address> | jq '.provenance, .index'

# 5. Wallet is still no-store, analytics is cacheable
curl -sI https://explorer.polkadex.ee/api/wallet/<an-address> | grep -i cache-control   # no-store
curl -sI 'https://explorer.polkadex.ee/api/analytics/timeseries?days=91' | grep -i cache-control  # public, max-age=5…

# 6. The page-size clamp discloses itself
curl -s -X POST https://explorer.polkadex.ee/api/rpc/call \
  -H 'content-type: application/json' \
  -d '{"method":"state_getKeysPaged","params":["0x26aa",5000]}' | jq '.pageSize, .pageSizeClamped'

# 7. A malformed address is 400, not 500 (F-082)
curl -s -o /dev/null -w '%{http_code}\n' https://explorer.polkadex.ee/api/validator/not-an-address   # 400

# 8. /developers has anchors and a TOC in the SERVER-RENDERED HTML (F-060)
curl -s https://explorer.polkadex.ee/developers | grep -c '<section id='   # 19
```

## Browser checks (need a human)

These are the ones no test covers:

- **`/developers`** — the TOC links scroll rather than navigating away, and the
  page looks the same whether hard-loaded or reached via in-app navigation.
- **Validators list** — the Commission filter dropdown still works. This is the
  highest-risk UI item in the batch's history: a filter option once named
  `valueOf` inherited from `Object.prototype` and wedged all twelve dropdowns.
- **Wallet → Pay out rewards** — with >30 unclaimed entries, the modal says
  "first 30 of N" **on open**, before you click Sign.
- **One real signature** — any transaction, to confirm `await buildTx` did not
  disturb the signing path. `@polkadot/api` is pinned at 10.13.1 with a manual
  `CheckMetadataHash` extension; this is the thing that breaks silently.
- **DevTools console** — no CSP violations on first load.

## Rollback

```sh
git revert <merge-sha> && bash deploy.sh
sqlite3 /opt/pdexplorer/data/explorer.db ".restore '/opt/pdexplorer/data/explorer.pre-round2.db'"
```

Note the migrations are **flag-guarded, not reversible**: reverting the code
leaves `migration:purge-legacy-tx-rows` set and the deleted rows deleted. If you
revert after the purge ran, restore the backup too, or clear the flag and let
the older code re-derive:

```sh
sqlite3 /opt/pdexplorer/data/explorer.db "DELETE FROM kv WHERE key='migration:purge-legacy-tx-rows';"
```
