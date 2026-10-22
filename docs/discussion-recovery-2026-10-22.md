# Discussion board: "the old discussion is lost" (2026-10-22)

## Resolution (read this first)

**Nothing was lost. Do not run the restore steps below.**

- **Data intact (confirmed on the box).** Thread `motion-0x27be...8033` holds both posts (ids 1 and 2) and `GET /api/discussions/<id>` on the box returns them.
- **The page showed a stale copy of that response, not the database (most likely cause, not proven).** The thread was created at 19:11:13 UTC and its first post written at 19:12:58, so a copy of the thread fetched in between has no posts. `GET /api/discussions/:id` sent no `Cache-Control` header (`server.js`, route at `6ab51d8:5996`) and no `Last-Modified`, so browser heuristic caching does not apply; the only plausible cache layer is a Cloudflare rule (a "Cache Everything" rule applies its own default TTL when the origin sends no header), which could keep serving that empty copy after the posts existed. Otherwise the page was opened before the first post at 19:12:58 UTC and never reloaded. Either way it showed "No posts yet" with the thread "Open".
- **The front end renders correctly.** `test/discussion-render.test.js` runs the real `fetchDiscussionThread` and `renderThread` from `script.js` against this payload (4000 and 3492 character posts, `editedAt` null and absent, signed in as the author, as someone else, and signed out). Both posts render on the deployed code too.
- **Fix (branch `fix/discussion-posts-render`).** The route now sends `Cache-Control: no-store`, the browser fetches the thread with `cache: 'no-store'`, and a thread whose `postCount` is above zero never shows "No posts yet": an empty list or a post that fails to render shows an inline error and logs the reason to the console.
- **Not verified:** whether the explorer's Cloudflare zone has a cache rule covering `/api/*`. After the fix is deployed, run this on your Mac twice: `curl -sI https://explorer.polkadex.ee/api/discussions/motion-0x27befa0fdbb72a238099f9c63668789ceaebbd3cdad7d471c177510bc5208033 | grep -i -E "cache-control|cf-cache-status"`. It must show `no-store` and never `cf-cache-status: HIT`. A HIT means a cache rule overrides the origin header and must be changed in Cloudflare.

The rest of this file is the earlier investigation, kept for the record.

Report: after deploying `6ab51d8` (merge of PR #16, post editing) to production, the old discussion was reported as lost.

## What the code says

**No code path deletes discussion data.** Searched `db.js`, `server.js`, `lib/`, `tools/`, `backup.sh`, `deploy.sh` and `provision-ubuntu.sh`. There is no `DELETE FROM discussion_*`, no `DROP TABLE`, and no rebuild or copy of these tables. The migration in `6ab51d8` only adds a column:

- `db.js:445` adds `['discussion_posts', 'edited_at', 'INTEGER DEFAULT NULL']` to `ADDITIVE_MIGRATIONS`. `applyDdl()` (`db.js:521`) runs `CREATE TABLE IF NOT EXISTS` plus `ALTER TABLE ... ADD COLUMN`. The fingerprint change (`db.js:483`) only decides which process runs that DDL. There is no "fresh DB" fallback.
- I tested this: a database with the pre-edit table shapes was run through `initDb`, and every thread and post survived (`test/discussion-threads.test.js`, "a pre-edit database ... keeps every thread and post"). A 3-worker server against that file served the same rows from `/api/discussions`.
- `deploy.sh` runs `git pull`, then build, `down`, `up`. The data is a host bind mount (`docker-compose.yml:73`, `${DATA_PATH:-./data}:/app/data`), so `down` does not touch it. The front end (`lib/discussion-edit.js`, `script.js` `renderThread`) renders every post the API returns, including posts in closed threads.

**The one code path that changes what readers see** is the thread reconcile. It can lock live discussions and drop them from the open list:

- `server.js:6052-6062` (`reconcileProposalThreads`, at `6ab51d8`) closed **every** open proposal thread that was missing from **one** `democracy.publicProps()` read (`server.js:7255`). It never checked that the read was current. The node's own `publicPropCount` was fetched in the same call but never compared. The council side is gated only on read errors (`server.js:6600`), not on staleness.
- `db.js:1858` `closeThread` is one-way. `db.js:1839` `createThreadIfMissing` never touches an existing row, so a wrongly closed thread stayed closed for good. Its reason read "Proposal tabled and moved to a referendum (voting)."
- The first democracy sync runs 8 s after every backend start (`server.js:10502`). The backend reads through `rpc.polkadex.ee`, a load balancer over several nodes. If a restart's first read lands on a node that is behind, every live proposal thread gets locked.

**Deleted or hidden?** Hidden: closed and locked, never deleted. The posts in a closed thread can still be read at `/discussions` (Status filter: Closed). The diagnostic below confirms which of these happened on the box: data present but closed, data present and open (in which case the report is about navigation, because a tabled proposal loses its "Discuss" link on the Democracy page), or rows really missing. Rows can only really be missing if the database file was replaced or the bind mount points somewhere else. Both can be checked below.

## The fix (branch `fix/discussion-loss-and-links`)

- `lib/discussion-threads.js`: a close needs a read that is provably current. Its block must not be behind the last trusted read (stored in kv `discussion:reconcile-block`). For proposals, the node's `publicPropCount` must also cover every proposal we already hold a thread for. An untrusted read may create threads but never closes or reopens one.
- Self-heal: if a thread was closed with the automatic reason but its item is active on chain again, it is reopened on the next trusted read. This repairs threads that production has already closed, with no manual DB edit. Threads closed for any other reason are left alone.
- `test/discussion-threads.test.js` has two kinds of test. The behavioural tests exercise the new module `lib/discussion-threads.js`, so they cannot run against the old code (the old logic lived in closures in `server.js`). The source-check test that asserts `server.js` uses the module fails at `e27c9de^` and passes after the fix.
- Known behaviours: the first trusted read after a deploy can reopen a thread that a later trusted read closes again (a one-tick flap), and a council motion re-proposed with the same call hash reopens its old thread with its old posts (intended).

## Diagnose on the explorer box (read-only)

The diagnostic section reads the database only; it writes scratch files under `/var/tmp`. It uses the host `sqlite3` (installed for `backup.sh`) with `-readonly`.

**Step 1. Which database file is the backend actually using?** Run this on the explorer box, after `ssh explorer`:

```
cd /opt/pdexplorer
sudo docker inspect pdexplorer-backend --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
sudo docker inspect pdexplorer-backend --format 'backend started {{.State.StartedAt}}'
sudo ls -la --time-style=full-iso data/
sudo stat data/explorer.db
```

The line ending in `-> /app/data` must show `/opt/pdexplorer/data`. If it shows a different source, the backend is using another database, and that is the cause. Note the "backend started" time: it is the deploy time used below. In `stat`, a `Birth` time at the deploy means the file was recreated.

**Step 2. Count threads and posts, and see when threads were closed.** Run this on the explorer box:

```
cd /opt/pdexplorer
sudo sqlite3 -readonly -header -column data/explorer.db "SELECT kind, status, closed_reason, COUNT(*) AS threads FROM discussion_threads GROUP BY 1,2,3;"
sudo sqlite3 -readonly -header -column data/explorer.db "SELECT COUNT(*) AS posts, MIN(id) AS min_id, MAX(id) AS max_id, datetime(MIN(created_at)/1000,'unixepoch') AS first_post, datetime(MAX(created_at)/1000,'unixepoch') AS last_post FROM discussion_posts;"
sudo sqlite3 -readonly -header -column data/explorer.db "SELECT name, seq FROM sqlite_sequence WHERE name = 'discussion_posts';"
sudo sqlite3 -readonly -header -column data/explorer.db "SELECT t.id, t.status, datetime(t.closed_at/1000,'unixepoch') AS closed_utc, t.closed_reason, COUNT(p.id) AS posts FROM discussion_threads t LEFT JOIN discussion_posts p ON p.thread_id = t.id GROUP BY t.id ORDER BY t.closed_at DESC LIMIT 40;"
```

**Step 2b. Decisive log check.** Run this on the explorer box (read-only):

```
sudo docker logs pdexplorer-backend 2>&1 | grep "Democracy indexer" | tail -n 50
```

A line such as `Democracy indexer: N referenda, 0 active proposals.` around the deploy time confirms the cause: a lagging node returned an empty proposal list and the old code closed every thread. If there is no such line, the cause is unconfirmed and the operator should send this output.

**Step 3. Compare with the newest backup taken before the deploy.** Run this on the explorer box. Pick the newest file in the listing whose timestamp is before the "backend started" time from step 1, and put its name in `BAK`:

```
ls -la --time-style=full-iso /var/backup/explorer-*.db.gz
BAK=/var/backup/explorer-YYYYMMDDTHHMMSSZ.db.gz
sudo mkdir -p /var/tmp/disc-check
sudo gunzip -c "$BAK" | sudo tee /var/tmp/disc-check/before.db > /dev/null
sudo sqlite3 -readonly -header -column /var/tmp/disc-check/before.db "SELECT kind, status, COUNT(*) AS threads FROM discussion_threads GROUP BY 1,2; SELECT COUNT(*) AS posts, MAX(id) AS max_id FROM discussion_posts;"
```

**How to read the results**

| What you see | Meaning | What to do |
|---|---|---|
| Live post count is at least the backup's, and many threads have `closed_utc` within minutes of the deploy with reason "Proposal tabled and moved to a referendum (voting)." | **Present but hidden.** The reconcile defect locked them. | Deploy the fix. Threads whose proposal or motion is still active reopen on the first trusted sync, about 8 s after start. Nothing to restore. |
| Live counts match the backup and threads are open | **Present and visible.** Nothing was lost. | Most likely the proposal was tabled, so its "Discuss" link left the Democracy page. The thread is at `/discussions`. |
| Live post count is below the backup's, or `sqlite_sequence` seq is far below the backup's `max_id` | **Data gone from this file.** The file was replaced or the bind mount moved (see step 1). No application code deletes these rows. | Restore the discussion tables only, as below. |

When finished, remove the scratch copy. Run this on the explorer box: `sudo rm -rf /var/tmp/disc-check`

## Restore the discussion tables only (only if "data gone")

This keeps the live chain index and any posts made since the deploy. It adds back only the missing discussion rows from the backup. It does not replace the whole database.

**Step R1. Stop the backend and take a pre-restore copy.** Run this on the explorer box:

```
cd /opt/pdexplorer
sudo docker compose -p pdexplorer stop backend
sudo sqlite3 data/explorer.db "VACUUM INTO '/var/backup/explorer-pre-discussion-restore.db'"
sudo sqlite3 -readonly /var/backup/explorer-pre-discussion-restore.db "PRAGMA integrity_check;"
```

The last line must print `ok`. Do not continue if it does not. If `VACUUM INTO` says the file already exists (from an earlier attempt), move that file aside first, because VACUUM INTO will not overwrite.

**Step R2. Unpack the chosen backup (from step 3).** Run this on the explorer box:

```
BAK=/var/backup/explorer-YYYYMMDDTHHMMSSZ.db.gz
sudo gunzip -c "$BAK" | sudo tee /var/backup/explorer-restore-source.db > /dev/null
sudo sqlite3 -readonly /var/backup/explorer-restore-source.db "PRAGMA integrity_check; SELECT COUNT(*) FROM discussion_posts;"
```

**Step R3. Copy in the missing threads and posts.** Run this on the explorer box. It is one transaction:

```
cd /opt/pdexplorer
sudo sqlite3 data/explorer.db "ATTACH '/var/backup/explorer-restore-source.db' AS bak; BEGIN; INSERT OR IGNORE INTO main.discussion_threads (id, kind, ref_key, title, status, created_at, closed_at, closed_reason) SELECT id, kind, ref_key, title, status, created_at, closed_at, closed_reason FROM bak.discussion_threads; INSERT OR IGNORE INTO main.discussion_posts (id, thread_id, author, author_name, content, created_at) SELECT id, thread_id, author, author_name, content, created_at FROM bak.discussion_posts; INSERT INTO main.discussion_posts (thread_id, author, author_name, content, created_at) SELECT b.thread_id, b.author, b.author_name, b.content, b.created_at FROM bak.discussion_posts b WHERE NOT EXISTS (SELECT 1 FROM main.discussion_posts m WHERE m.thread_id = b.thread_id AND m.author = b.author AND m.created_at = b.created_at AND m.content = b.content); COMMIT; DETACH bak;"
```

The first post insert keeps the original post ids, so old links keep working. The second insert only catches posts whose id was already taken by a newer post on the live database. Those get a new id, and nothing is duplicated.

**Step R4. Check, then start the backend.** Run this on the explorer box:

```
cd /opt/pdexplorer
sudo sqlite3 -readonly -header -column data/explorer.db "PRAGMA integrity_check; SELECT COUNT(*) AS threads FROM discussion_threads; SELECT COUNT(*) AS posts FROM discussion_posts;"
sudo docker compose -p pdexplorer start backend
sleep 15
curl -s http://127.0.0.1:3001/api/discussions | head -c 600
```

**Undo (only if R3 went wrong).** Run this on the explorer box. It puts back the copy from R1:

```
cd /opt/pdexplorer
sudo docker compose -p pdexplorer stop backend
sudo cp /var/backup/explorer-pre-discussion-restore.db data/explorer.db
sudo rm -f data/explorer.db-wal data/explorer.db-shm
sudo chown 1000:1000 data/explorer.db
sudo docker compose -p pdexplorer start backend
```

When everything is confirmed, delete `/var/backup/explorer-restore-source.db`. Keep the pre-restore copy until the next scheduled backup has run.
