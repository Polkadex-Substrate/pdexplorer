> **Archived 2026-10-29.** Polkadex mainnet enacted runtime spec 392 on
> 29 October 2026 (block about 13,342,584). This file is kept as the record of
> how the explorer crossed the upgrade. Its run sheet, deploy gate, checklist
> and rollback sections no longer apply: rollback to the pre-392 image is
> closed, and the explorer no longer keeps the chain head or signing working
> on spec 373.
>
> What changed when it was archived (branch `chore/retire-pre392-compat`):
>
> - The live paths assume spec 392 or later (`lib/live-runtime.js`). Browser
>   signing refuses a node that reports an older spec with one readable error
>   before the wallet is asked; the server logs one `[runtime] ... FAILED`
>   line and `/api/version` carries `liveRuntime.ok: false`.
> - Signing no longer falls back to `balances.transfer` (spec 392 removed it).
> - `scripts/find-upgrade-block.mjs` and `lib/upgrade-block.js` were removed
>   (one-shot tools for the testnet proof).
> - `scripts/fetch-metadata.mjs` now writes `metadata-392.json` from mainnet
>   (the current runtime), and `metadata-373.json` only from an archive node at
>   a block before the upgrade. Both fixtures stay: the 373 one backs the
>   historical decode tests.
> - Everything that decodes HISTORY is kept unchanged: `api.at(blockHash)`
>   registries, the per-runtime asset-fee extension types and their self-check
>   (`lib/tx-extensions.js`), v4 and v5 extrinsic decoding, `getBlockTolerant`
>   (`lib/extrinsic-decode.js`), and the preimage reads of both `StatusFor` and
>   `RequestStatusFor`.

# Explorer readiness for runtime spec 392

Deadline (noted 2026-10-27): referendum #36 enacts about 2026-10-29 18:00 UTC
(voting ends at block 13,342,284; enactment 300 blocks later). This build must
be live on the mainnet explorer before then.

Mainnet runs spec 373 until a referendum enacts 392. Testnet already runs 392
(enacted there at block 1,553,840 on 2026-10-07). One explorer build must index
and sign correctly on both runtimes and across the upgrade block, and must
decode every historical block with that block's own runtime (the explorer uses
`api.at(blockHash)`).

**Deadline: this build must be live and healthy on the mainnet explorer BEFORE
the referendum enacts 392.** The old explorer (@polkadot/api 10.13.1)
cannot decode blocks produced under 392. Rollback to the previous image is valid
only before enactment; see "Rollback" below.

## Base and status (2026-10-27)

- Branch `chore/polkadot-api-v5-r3`: `chore/polkadot-api-v5-r2` (head
  `5df54e9`, reviewed: the eleven commits of `chore/polkadot-api-v5` rebased
  onto `main` at `62b5106`, plus the round-2 commits below) with `origin/main`
  at `d76676d` (merge of PR #24) MERGED into it, not rebased, so every reviewed
  commit keeps its id. Then the round-3 commits below. It carries everything on
  `main` up to `d76676d`: governance item pages, democracy and referendum
  discussion threads, Markdown posts, item page voting, Open Graph cards.
  Explorer PR 20 is NOT in it (see the trial merge below).
- The merge had no textual conflicts (`main` did not touch `package.json` or
  `package-lock.json`; git merged `db.js`, `server.js` and `script.js`). It
  had one semantic conflict, resolved in the merge commit: both sides added
  `blake2AsHex` to `server.js`'s imports on different lines, and a duplicate
  import binding is a SyntaxError, so `server.js` would not start while every
  test passed. `test/module-link.test.js` now catches that class (round 3).
  The lock file is the branch's own (api 17.0.2), unchanged; `npm ci` from it
  works offline from a warm cache.
- `script.js` is 14,847 lines (ceiling 15,000).
- Here (Linux, Node 22.23, `npm ci --offline` from the lock), 2026-10-27:
  `npm test` exit 0, `# fail 0`. With the mainnet 373 fixture (fetched
  2026-10-19): 2247 tests, `# skipped 1` (392 missing), two runs. No
  fixtures: 2220 tests, `# skipped 2`. `npm run build` (Vite) passes and the
  new Open Graph step writes 43 section shells. A backend boot answers
  `/api/version` and the new governance item routes (RPC unreachable, as
  expected here). The real 392 fixture can only be fetched from the CEO's Mac
  (run sheet A).
- Trial merge of PR 20 (`refs/pull/20/head` at `b372776`) into this branch,
  not committed: no conflicts, `npm test` exit 0, 2287 tests, `# fail 0`,
  `# skipped 1` (392 missing), Vite build passes. If PR 20 lands on `main`
  first, merging `main` into this branch again is expected to be clean.

### Round 3 (2026-10-27, on top of the merge)

1. **Startup guard.** `test/module-link.test.js` runs `node --check` on every
   entry module, `lib/`, `scripts/`, `tools/` and `vite.config.js`, and checks
   each named import of `server.js`, `db.js`, `email.js` and `script.js`
   against the real exports of its module. Proved failing on the merge's
   duplicate import and on a misspelt export, both reported by line.
2. **New-on-main governance code checked against api 17.** The item pages'
   chain reads moved unchanged from `server.js` into `lib/gov-chain-read.js`
   and run in `test/gov-chain-read.test.js` on real codecs (Substrate's
   metadata always, the Polkadex fixtures when present): Bounded
   Inline/Lookup/Legacy proposal hashes, `referendumInfoOf` Ongoing (tally,
   delay) / Finished / None, `depositOf` and `publicProps` tuples,
   `nextExternal`, collective `voting` and `proposalOf`, the call description,
   `scheduler.Dispatched` as the indexer stores it (`toHuman`, then JSON)
   matching the referendum enactment task id, the motion-hash backfill finding
   `externalPropose*` inside `council.propose`, and the Actions panel balance
   from a real `AccountInfo`. Voting from item pages goes through the same
   `submitSignedTx` (withSignedTransaction, CheckMetadataHash) as the list
   pages; main only added stage fan-out there. Historical reads
   (`query.x.y.at`) decode with that block's own registry under api 17.
3. **One real difference, fixed: preimage length on 392.** A Legacy or
   bare-hash proposal read its preimage length only from `preimage.statusFor`,
   only as `len`. Spec 392 (pallet-preimage 45) notes new preimages in
   `RequestStatusFor`, where a Requested entry carries the length as
   `maybeLen`, so an item page would have said "not noted" for a noted
   preimage. It now reads `RequestStatusFor` first, then `StatusFor`, and
   accepts either key. The test fails on the old logic.

### Round 2 (2026-10-26, on top of the reviewed branch)

1. **Gate fix: `# skipped 0` was unreachable, and a real 392 fixture would
   have FAILED.** Metadata v14 and v15 have room for one extrinsic version and
   report 4 even on a runtime that accepts v5; only v16 lists `[4, 5]`
   (checked: Substrate's own v15 and v16 metadata in @polkadot/types-support,
   same runtime). The fixture suite skipped the v5 round trip on every v14/v15
   source (two skips for 373 alone) and asserted v5 on the 392 v15 source,
   which fails. Now a source that lists `[4]` is asserted and passes, the v5
   expectation applies to the v16 source, and a 392 fixture without v16
   metadata fails with a message. Proved with a synthetic 392 fixture built
   from the Substrate v15/v16 metadata: old test `# fail 1, # skipped 3`, new
   test `# fail 0, # skipped 0`.
2. **Self-check re-runs after a runtime upgrade.** @polkadot/api swaps the
   metadata in place at enactment (no reconnect), so `/api/version` kept the
   373 result. `assetFeeCheck` now carries `specVersion` and is re-run on the
   first `/api/version` or `/api/health` request after the spec changes.
3. **New-on-main code checked against api 17.** `lib/democracy-live.js` and
   `lib/collective-live.js` (the browser's live governance feeds) read real
   codecs: Option, enum `isOngoing`/`asOngoing`, Vec as Array, tuples,
   GenericVote `isAye`/`conviction`, SeatHolder, Call `meta.args`. Run against
   10.13.1 and 17.0.2 with the mainnet 373 metadata: identical output.
   `test/gov-live-codecs.test.js` pins this on real codecs (Substrate metadata
   always, the Polkadex fixtures when present). Nothing needed changing.
   `lib/democracy-patch.js` (`api.tx.democracy.second`, `meta.args`),
   `lib/gov-refresh.js`, `lib/discussion-*.js` and the new `server.js` paths
   use no API surface that changed. The browser bundle builds with Vite and
   contains one @polkadot version (17.0.2 / 14.0.3).
4. **`scripts/find-upgrade-block.mjs`** finds the block a chain switched to
   392 on, so the testnet proof works on any 392 endpoint (step C). The
   JSON-RPC client it shares with `fetch-metadata.mjs` moved to
   `lib/json-rpc-client.js` unchanged.

## What changed

### Library: @polkadot/api 10.13.1 to 17.0.2 (exact pins)

| package | before | after |
|---|---|---|
| @polkadot/api | 10.13.1 | 17.0.2 |
| @polkadot/types | (transitive 10.13.1) | 17.0.2, pinned directly |
| @polkadot/util, util-crypto, keyring | (transitive 12.6.2) | 14.0.3, pinned directly |

Why 17.0.2, from the upstream CHANGELOG (read at commit 81aabcc, the 17.0.2
release):

- 14.0.1: extrinsic v5 and TransactionExtension support; decodes v4 and v5
  extrinsics including bare, signed and General.
- 15.0.1: v5 adjusted to the final spec (no "signed v5"; signed stays v4).
- 15.7.1: WeightReclaim added to the known extensions (spec 392 has it).
- 16.0.1: metadata v16 (transactionExtensions, transactionExtensionsByVersion).
- 16.1.2: ExtrinsicV4 is the default for signing. The api signs with the first
  version the runtime's metadata lists, which is 4 on both 373 and 392.
- 17.0.2: "decode versioned GeneralExtrinsic extensions" (#6282), a v5 decode
  fix we need. 17.0.1's only breaking change is that nock and mock-socket are
  no longer shipped (we use neither).
- engines: node >= 18; Node 22 tested here.

Every @polkadot package resolves to exactly one copy (test/deps-ops.test.js
asserts this against package-lock.json).

### lib/tx-extensions.js: two small, tested wrappers around @polkadot/types

1. **Asset-fee extension types come from metadata, per runtime.** polkadot-js
   reads `ChargeAssetTxPayment` from a built-in table whose asset id is
   `Option<MultiLocation>` (the Asset Hub shape). Polkadex uses
   pallet_asset_conversion_tx_payment with `NativeOrWithId<u128>` (older
   runtimes in polkadex-node history used `NativeOrWithId<u32>`). With the asset
   id None both encode as `0x00`, which is why nothing broke so far; any
   extrinsic paying its fee in an asset was misread and every later field read
   at the wrong offset. The wrapper hooks `TypeRegistry.setSignedExtensions`
   (called by `setMetadata` for the tip registry AND for every `api.at(hash)`
   registry) and registers the extension's fields from THAT registry's
   metadata, plus the `TAssetConversion` alias the signer payload uses.
   The metadata's `implicit` field is not consulted: 17.0.2 loses it when it
   converts v14/v15 metadata to v16 (a `implict` typo in its converter), and
   373 is served as v14/v15. Tests cover v14, v15 and v16 metadata.
   `SkipCheckIfFeeless` never appears under its own name: the runtime forwards
   the wrapped extension's identifier and type, so the metadata calls it
   `ChargeAssetTxPayment`. The name is in the list anyway in case a runtime
   ever publishes it.
2. **v5 General re-encoding.** 17.0.2 decodes a General extrinsic correctly but
   re-encodes it with a duplicated length prefix and version byte, so
   `toHex()` and `hash` are wrong. The explorer stores `extrinsic.hash` as the
   tx hash, so every General extrinsic would get the wrong hash. The wrapper
   emits the inner encoding once. v4 is untouched.

`test/tx-extensions-stock.test.js` proves both defects exist in the stock
library (it fails once upstream fixes them, which is the signal to re-check
and drop a wrapper).

### Signing (script.js)

- The hand-declared `CheckMetadataHash` shape is removed (17.x knows it). Mode
  stays Disabled (0): the explorer never asks for mode 1, so the payload it
  builds carries mode 0 and metadataHash None. Tested.
- `lib/tx-submit.js` `signAndSendOptions` passes `withSignedTransaction: true`
  and `allowCallDataAlteration: false`. A wallet may return the whole signed
  transaction (Ledger metadata-hash flows do, with mode 1 and its own metadata
  hash); without the flag @polkadot/api 17.0.2 throws on it
  (`submittable/createClass.js:206`). With it the library requires the
  returned transaction to be signed (`:225`), refuses one whose call data
  differs from the call the explorer built (`:230`, `:265-269`; the default
  would allow it, `:194`), and submits the wallet's bytes (`:182`, `:187`).
  Tested against the real Submittable class with fake wallets: signature only,
  signed transaction, and altered call data.
- Signing stays on extrinsic v4, which v5 runtimes accept.
- Dev-only endpoint override: `VITE_POLKADEX_WS`, read only by the Vite dev
  server (`import.meta.env.DEV`). A production build always uses
  `wss://rpc.polkadex.ee`.

### Start-up self-check (server and browser)

After each `ApiPromise.create`, `checkAssetFeeExtension(api.registry)` (in
`lib/tx-extensions.js`) compares what the api will actually encode with against
the metadata: `registry.getSignedExtensionTypes().assetId` (the flat map the
library keeps; the asset id is not keyed by extension name) and the
`TAssetConversion` alias must both resolve to the metadata-derived type, not the
library's built-in `Option<MultiLocation>`. One log line either way.

- Server: `[tx-extensions] server self-check OK ...` via `console.log`; on a
  mismatch `console.error` with `FAILED`, and `/api/version` carries
  `assetFeeCheck: { ok, status, specVersion }` (`null` before the api
  exists). Re-run on every RPC reconnect, and on the first `/api/version` or
  `/api/health` request after the runtime spec changes (the api swaps
  metadata in place at enactment). Look for it in the startup log and curl
  `/api/version` after deploy: `ok` must be `true` and `specVersion` the
  chain's current spec.
- Browser: same line via `console.log`; on a mismatch `console.warn`. Open the
  console once after deploy and on the dev instance.
- Statuses: `ok`, `absent` (runtime has no asset-fee extension, fine),
  `mismatch`, `underivable` (listed in metadata, shape unreadable, library table
  in use unverified), `error` (the check itself threw). Only `ok` and `absent`
  are healthy. The check never blocks start-up.

### Indexing (server.js)

- Same CheckMetadataHash removal at the backend `ApiPromise.create`.
- `scanSingleBlock`: if `rpc.chain.getBlock` throws for a non-transport reason
  (one extrinsic the library cannot decode used to drop the whole block and all
  its events), the new `getBlockTolerant` fetches the raw block and decodes each
  extrinsic alone against the block's own registry
  (`api.getBlockRegistry`). A failure becomes a marked stub (true blake2 hash,
  signer when it is a signed v4) and its own `scan_failures` row with indexer
  `extrinsic_decode:<index>` (one row per bad extrinsic, the index also in the
  message). If every extrinsic decodes alone, the block gets one
  `block_decode_recovered` row instead, so a fault elsewhere in the block is
  still visible. Both rows carry the original whole-block error. The block and
  its events are still indexed. If the fallback fetch itself fails, the error
  recorded for the block keeps the original decode error first; transport
  errors keep the existing retry path. Nothing retries these rows
  automatically: they are an operator signal and must stay at zero. Counts are
  on `/api/blocks` and `/api/events` as
  `coverage.decodeFailures.extrinsicDecode` and
  `coverage.decodeFailures.blockDecodeRecovered` (updated each chain tick).
- `getBlockTimestamp` skips stubs.
- Not changed: `/api/decode` and the block-detail endpoints still use the
  whole-block decode, so an undecodable extrinsic shows as an error there
  instead of a partial block; staking-reward scans record a normal scan failure
  in that case.

## Tests

Always run (no network): Substrate's own runtime metadata shipped inside
@polkadot/types-support (metadata v16, extrinsic versions 4 and 5,
SkipCheckIfFeeless<ChargeAssetTxPayment> with a NativeOrWithId asset id,
CheckMetadataHash, WeightReclaim). Expected bytes are built from the metadata by
`test/helpers/extrinsic-builders.js`, not by the library under test.

Polkadex fixtures: `test/fixtures/metadata-373.json` (mainnet) and
`metadata-392.json` (testnet). They are not in the repo. Without them those
suites SKIP with a "FIXTURE MISSING" line and count under `# skipped`; the
Polkadex-specific checks are NOT verified until they exist. With them, each
metadata version the node offers (v14, and v15/v16 where available) is checked
for: the extension list, v4 signed round trip with asset id None and Some, the
extrinsic versions the metadata lists (`[4]` on v14/v15; `[4, 5]` on the 392
v16 source, which must be present), v5 General round trip on the v16 source,
the v4 signing payload against the metadata with mode Disabled, and real
extrinsics from recent blocks of that runtime decoding and re-encoding
byte-identical with the right hash (v14 and v15 registries included, so a 392
v5 sample is also decoded the way the api does after an in-place upgrade,
which loads v14 metadata). `test/gov-live-codecs.test.js` also runs the live
governance decoders on codecs built from each fixture.
`test/gov-chain-read.test.js` does the same for the governance item pages'
chain reads, enactment matching and the motion-hash backfill.
`test/module-link.test.js` (no network) fails if any entry module would not
parse or names an import its module does not export.

## CEO run sheet

In order. Each block says where it runs. Every block is plain commands for
bash 3.2 or zsh, one per line, nothing to edit except where a step says
"put the value from ... here". Paste a block, read the output against the
pass line, then go on.

### A0. The branch (on your Mac)

The `pdexplorer-wt-392` worktree was created from the CTO sandbox, so its git
links point at sandbox paths until repaired. Repair them from the main
checkout, then confirm the branch:

```
cd ~/Projects/Polkadex/pdexplorer
git worktree repair ../pdexplorer-wt-392
cd ~/Projects/Polkadex/pdexplorer-wt-392
git status -sb
git log -1 --format=%h
```

Pass: `## chore/polkadot-api-v5-r3` and the commit the reviewer cleared. The
`node_modules` there were installed on Linux; the `npm ci` in A replaces them
(Vite's esbuild binary is per platform), so do not skip it.

### A. Fixtures (on your Mac, needs network)

The 392 fixture must come from a chain running 392. The default is the public
testnet `wss://polkadex-testnet.polkadex.ee`. It is a single RPC with no
fallback and it has been down before (2026-10-08). If it does not answer, use
any other endpoint that runs 392, for example the copy of mainnet state that
was upgraded to 392 for the soak (Vivek ran it; its endpoint is not recorded
in anything we hold, so ask him). It must be an ARCHIVE node. Whatever
endpoint you use here, use the same one in step C.

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
git log -1 --format=%h
TESTNET_WS=wss://polkadex-testnet.polkadex.ee
npm ci
node scripts/fetch-metadata.mjs --testnet "$TESTNET_WS"
```

Pass:

- `[mainnet] wss://rpc.polkadex.ee`, then `node spec 373 tx 2`, `metadata
  versions offered: 14, 15` (or more), `wrote .../test/fixtures/metadata-373.json`.
- `[testnet] <your endpoint>`, then `spec 392`, `metadata versions offered:`
  a list that includes 16, a `seenFormats=` line whose `"5"` entry has
  `"total"` above 0 (the inherents every 392 block carries are bare v5, 0x05,
  so `"bare"` is above 0 and `"general"` is normally 0: nothing on Polkadex
  emits General), `wrote .../test/fixtures/metadata-392.json`.
- Last line `Done. Now run: npm test`.

Fail: any `FAILED:` line, or `fixture(s) not written`. "no v5 extrinsic" means
the recent window had no v5 traffic: run the last line again with
`--only 392 --blocks 2000` added (or larger), or send one v5 transaction on that
chain first. `WARNING: expected spec 392, the chain runs 373` means the
endpoint is not on 392: pick another. If mainnet already runs 392 (after
enactment), the 373 file records 392; that is expected then.

### B. Full test suite (on your Mac, same directory)

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
npm test > /tmp/pdex-392-test.log 2>&1
echo "npm test exit: $?"
tail -n 9 /tmp/pdex-392-test.log
```

Pass: `npm test exit: 0`, `# fail 0`, `# skipped 0`. Anything else: run
`grep -n -E "not ok|# SKIP" /tmp/pdex-392-test.log | head -n 40` and send the
output; do not deploy.

### C. Testnet proof (on your Mac, three terminals)

C1. Where did this chain switch to 392? Terminal 1:

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
TESTNET_WS=wss://polkadex-testnet.polkadex.ee
node scripts/find-upgrade-block.mjs --ws "$TESTNET_WS"
```

Pass: a last line `RESULT upgrade-block=U ... MIN_BLOCK=M WINDOW_END=E
WINDOW_BLOCKS=N`. On the public testnet U should be 1553840, M 1552840, E
1554840, N 2001. A chain that started on 392 prints `RESULT from-genesis ...
MIN_BLOCK=1`: then there is no "before" side and C3 is skipped. A `WARNING:
this chain has the MAINNET genesis hash` line (a mainnet-state copy) means:
keep the wallet's default mortal era for the C5 transactions, never sign an
immortal one. `FAILED: state at #0 unavailable` means the node is not an
archive node: use another endpoint.

C2. Start a throwaway backend against that chain. Same terminal 1. Put M from
the RESULT line in the second line. `ls data` must say "No such file"; if a
`data` directory exists from an earlier run, move it away first with
`mv data data-previous`.

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
MIN_BLOCK=1552840
TESTNET_WS=wss://polkadex-testnet.polkadex.ee
ls data
POLKADEX_WS="$TESTNET_WS" PORT=3001 SCAN_GAP_FILL_BATCH=500 BLOCKS_MIN_BLOCK=$MIN_BLOCK TX_MIN_BLOCK=$MIN_BLOCK GOV_MIN_BLOCK=$MIN_BLOCK STAKING_REWARDS_MIN_BLOCK=$MIN_BLOCK npm run server
```

Leave it running. Its log must show `[tx-extensions] server self-check OK (ok,
spec 392)` and no `Unknown signed extensions` line.

C3. Index both sides of U now instead of waiting hours for the walk back from
the head (about 17 blocks a second). Terminal 2, after terminal 1 shows
`Backend listening`. Put M and E from the RESULT line in:

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
node --experimental-sqlite tools/requeue-scan-range.mjs --indexer chain_index --from 1552840 --to 1554840
```

The backend then re-scans up to 500 of those heights every 12 seconds; the
2,001 heights take a few minutes. Then start the dev front end in the same
terminal:

```
TESTNET_WS=wss://polkadex-testnet.polkadex.ee
VITE_POLKADEX_WS="$TESTNET_WS" npm run dev
```

C4. Checks. Terminal 3. Put M and E in the first query:

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
sqlite3 data/explorer.db "SELECT COUNT(*) FROM blocks WHERE number BETWEEN 1552840 AND 1554840;"
sqlite3 data/explorer.db "SELECT indexer, COUNT(*) FROM scan_failures GROUP BY indexer;"
curl -s localhost:3001/api/blocks | grep -o '"decodeFailures":{[^}]*}'
curl -s localhost:3001/api/version
node -e 'const f=require("./test/fixtures/metadata-392.json");f.extrinsics.filter(x=>x.format.startsWith("v5-")).slice(0,3).forEach(x=>console.log(x.block,x.index,x.format))'
```

Pass:

1. The count equals N from the RESULT line (2001 on the public testnet). Rerun
   until it stops rising; if it stays below N, send it.
2. The scan_failures query prints nothing. Any `extrinsic_decode:<index>`,
   `block_decode_recovered` or `chain_index` row is a FAIL. Rows for another
   indexer: send them before deciding.
3. `"decodeFailures":{"extrinsicDecode":0,"blockDecodeRecovered":0}`.
4. `/api/version` shows `"specVersion":392`, `"rpcConnected":true` and
   `"assetFeeCheck":{"ok":true,"status":"ok","specVersion":392}`.
5. The last command prints up to three `block index format` lines of real v5
   extrinsics from that chain (from the step A fixture; `v5-bare` inherents
   are what 392 blocks carry, `v5-general` appears only if someone sent one).
   For each, with its first two numbers in place of B and I:
   `curl -s "localhost:3001/api/decode/B?index=I"` must show a `"section"`,
   a `"method"`, `"isSigned":false` and a `"hash"`, and no `"error"`.

C5. Wallet, polkadot{.js} extension only, in the browser at
http://localhost:3000 (the dev front end on the 392 chain):

- one balance transfer between two accounts: finalized, success event, and the
  explorer shows it with the same tx hash the wallet reports;
- one council vote from a council member account held in that wallet:
  finalized, `council.Voted` event, shown on the motion.

Record wallet version, tx hash and block for each. The browser console must
show `browser self-check OK` and no warning from `[tx-extensions]`. A wallet
that returns the whole signed transaction is accepted (see Signing above); one
that returns altered call data is refused with an error, which counts as a
FAIL for that wallet, not a pass. Also: no `[silenced]` announcement for "has
multiple versions" in the backend log (server.js silences that warning after
announcing it once, so look for the announcement).

Keep the dev instance for the Talisman and SubWallet checks after the deploy,
then stop all three processes (Ctrl-C).

### D. Production deploy (mainnet is on 373; it must keep working)

D1. Merge. On your Mac, push `chore/polkadot-api-v5-r3`, open a PR into
`main` on GitHub, merge it once A to C pass (a merge commit, not squash or
rebase, so the reviewed commits keep their ids). If `main` moved since
`d76676d` (PR 20, for example), the PR shows it; re-run B on the merged
result before deploying. The explorer box deploys `main`.

D2. Baseline and backup, on the explorer box (`ssh explorer`):

```
cd /opt/pdexplorer
curl -s http://127.0.0.1:3001/api/version
sudo sqlite3 -readonly data/explorer.db "SELECT indexer, COUNT(*) FROM scan_failures GROUP BY indexer;" > /tmp/scan-failures-before-392-deploy.txt
cat /tmp/scan-failures-before-392-deploy.txt
sudo bash backup.sh
```

Note the old `gitSha`. The backup must report success before you go on.

D3. Deploy, on the explorer box:

```
cd /opt/pdexplorer
sudo bash deploy.sh
```

D4. Post-deploy checks, on the explorer box, about two minutes after the
containers are up:

```
cd /opt/pdexplorer
curl -s http://127.0.0.1:3001/api/version
curl -s -o /dev/null -w "health %{http_code}\n" http://127.0.0.1:3001/api/health
sudo docker logs --since 10m pdexplorer-backend 2>&1 | grep -E "tx-extensions|Unknown signed extensions|has multiple versions"
curl -s http://127.0.0.1:3001/api/blocks | grep -o '"decodeFailures":{[^}]*}'
sudo sqlite3 -readonly data/explorer.db "SELECT indexer, COUNT(*) FROM scan_failures GROUP BY indexer;" > /tmp/scan-failures-after-392-deploy.txt
diff /tmp/scan-failures-before-392-deploy.txt /tmp/scan-failures-after-392-deploy.txt
bash tools/verify-deploy.sh
```

Pass:

1. `/api/version`: `gitSha` is the merge commit (first 12 characters of the
   `main` head), `"dirty":false`, `"specVersion":373`, `"rpcConnected":true`,
   `"assetFeeCheck":{"ok":true,"status":"ok","specVersion":373}`.
2. `health 200`.
3. The log grep shows `[tx-extensions] server self-check OK (ok, spec 373)`,
   one line per worker process (the backend runs an indexer plus HTTP workers,
   so several identical lines), and nothing else.
4. `"decodeFailures":{"extrinsicDecode":0,"blockDecodeRecovered":0}`.
5. `diff` prints nothing (no new scan_failures rows).
6. `verify-deploy.sh` ends without a FAIL line.
7. Run the `/api/version` line again a minute later: the explorer front page
   shows the head advancing in the same minute.

Then, in a browser: https://explorer.polkadex.ee, open the console once, it
must show `browser self-check OK`. The browser runs this check once per page
load, so a tab that was open across the enactment is not re-checked: after the
upgrade, tell users to reload the page (acceptable; the check is a diagnostic
and signing does not depend on it). If any check fails before enactment, roll
back (see "Rollback").

### E. Enactment day (no rollback after enactment)

Before: the referendum page on the explorer shows the enactment block. Check
D4 items 1 to 5 again an hour before it.

Watch, on the explorer box, from a few blocks before enactment until 20
minutes after (Ctrl-C to stop):

```
while true; do date -u; curl -s http://127.0.0.1:3001/api/version | grep -o -E '"specVersion":[0-9]+|"assetFeeCheck":[{][^}]*[}]'; curl -s http://127.0.0.1:3001/api/blocks | grep -o '"decodeFailures":{[^}]*}'; sleep 30; done
```

Expected: `"specVersion":373` until the enactment block, then
`"specVersion":392` and `"assetFeeCheck":{"ok":true,"status":"ok","specVersion":392}`;
`decodeFailures` stays all zeros.

Then, on the explorer box:

```
cd /opt/pdexplorer
sudo docker logs --since 30m pdexplorer-backend 2>&1 | grep -E "Runtime version updated|tx-extensions|Unknown signed extensions|extrinsic_decode|block_decode_recovered"
sudo sqlite3 -readonly data/explorer.db "SELECT indexer, COUNT(*) FROM scan_failures GROUP BY indexer;"
```

Expected: a `Runtime version updated to spec=392` line and `server self-check
OK (ok, spec 392)` (each once per worker process), no other line; the scan_failures counts equal the D4
"after" file (no `extrinsic_decode:*`, `block_decode_recovered` or new
`chain_index` rows).

On your Mac, find mainnet's upgrade block U and spot-check both sides:

```
cd ~/Projects/Polkadex/pdexplorer-wt-392
node scripts/find-upgrade-block.mjs --ws wss://rpc2.polkadex.ee
```

This one uses the archive node `rpc2` directly, not the `rpc.polkadex.ee` load
balancer: the search reads state at old block heights, and the balancer may
send a request to a node that cannot serve it.

On the explorer box, with U and U plus one in place of 13300000 and 13300001:

```
curl -s "http://127.0.0.1:3001/api/decode/13300000" | head -c 400
curl -s "http://127.0.0.1:3001/api/decode/13300001" | head -c 400
```

Both must decode (a block number and extrinsics, no `"error"`). Finally, one
transfer signed on https://explorer.polkadex.ee after enactment, polkadot{.js}
extension: finalized, shown with the wallet's tx hash.

If the new build deploys AFTER enactment (late): the old explorer cannot decode
392 blocks, so it fails each whole 392 block, stores nothing for it and queues
a `chain_index` row in `scan_failures`. Rows that burn their retries are
re-armed every 6 hours (`SCAN_AMNESTY_MS`, `server.js`), so once the new build
is live the backlog retries itself and fills in with no manual step; blocks
that were never stored have no stub rows, so no delete is needed for them
(the delete step below is only for blocks the NEW build stored with a bad
decode). To confirm after the deploy, on the explorer box:
`sudo sqlite3 -readonly /opt/pdexplorer/data/explorer.db "SELECT COUNT(*) FROM scan_failures WHERE indexer='chain_index';"`
falls over the following hours to the "before" file's number (a row may wait
up to 6 hours for the next re-arm; to skip the wait, run the `--rearm` command
from step 4 below with `--from`/`--to` for the affected range), the `/api/blocks` `decodeFailures` stay zero, and
the front page head advances. If the count does not fall, send
`sudo docker logs --since 1h pdexplorer-backend 2>&1 | grep -E "amnesty|chain_index" | tail -30`.

Fix forward (the only path after enactment):

1. Do not redeploy the old image: it cannot read 392 blocks.
2. A decode failure does not stop the indexer: the block and its events are
   still stored, the bad extrinsic becomes a marked stub and one
   `extrinsic_decode:<index>` row. Capture, on the explorer box:
   `sudo sqlite3 -readonly /opt/pdexplorer/data/explorer.db "SELECT indexer, block, last_error FROM scan_failures WHERE indexer LIKE 'extrinsic_decode:%' OR indexer IN ('block_decode_recovered','chain_index') ORDER BY block DESC LIMIT 20;"`
   and, for one of those blocks B, `curl -s "http://127.0.0.1:3001/api/decode/B"`.
   Send both.
3. The fix lands on a branch from `main` with a test built from that
   extrinsic's bytes, goes through review and the same D1 to D4 path.
4. After it is live, re-scan the affected blocks. A re-scan does NOT replace
   what is already stored: events and transactions are written with
   `INSERT OR IGNORE` (`db.js` `insertEvents`, `insertTransactions`), so the
   stub rows from the failed decode stay and the corrected rows are ignored;
   only `blocks` is written with `REPLACE`. So the stored rows of the affected
   blocks must be deleted first. Delete triggers exist on both tables
   (`trg_events_count_ad`, `trg_tx_count_ad`, `db.js`), so the O(1) counters in
   `table_counts` stay exact and nothing needs recomputing. The block list B1,B2
   is the one from step 2. All on the explorer box:

   a. Backup first (must report success): `cd /opt/pdexplorer` then
      `sudo bash backup.sh`
   b. Read-only check of what would be deleted (write the counts down):
      `sudo sqlite3 -readonly data/explorer.db "SELECT 'events', COUNT(*) FROM events WHERE block IN (B1,B2) UNION ALL SELECT 'transactions', COUNT(*) FROM transactions WHERE block IN (B1,B2);"`
      and the counters before: `sudo sqlite3 -readonly data/explorer.db "SELECT name, n FROM table_counts;"`
   c. Stop the writer so nothing re-inserts mid-delete, then delete:
      `sudo docker compose stop backend`
      `sudo sqlite3 data/explorer.db "DELETE FROM events WHERE block IN (B1,B2); DELETE FROM transactions WHERE block IN (B1,B2);"`
   d. Check the counters fell by exactly the counts from b:
      `sudo sqlite3 -readonly data/explorer.db "SELECT name, n FROM table_counts;"`
   e. Start and queue the re-scan:
      `sudo docker compose start backend`
      `sudo docker compose exec backend node --experimental-sqlite tools/requeue-scan-range.mjs --indexer chain_index --blocks B1,B2 --rearm`
   f. Check one affected extrinsic page, then delete its `extrinsic_decode:*`
      row by hand.
5. Signing broken but reading fine: wallets still sign in their own apps;
   fix `lib/tx-submit.js` the same way. A crash-looping backend: send
   `sudo docker logs --tail 200 pdexplorer-backend`.

## Gate to deploy this branch to the mainnet explorer

Mainnet is still on 373 while this gate is worked. Everything in it can be done
now, before any referendum outcome. All three must be true before the deploy:

1. Run sheet A and B on your Mac: `node scripts/fetch-metadata.mjs` (a v5
   extrinsic must be found in the 392 sample and the 392 node must offer
   metadata v16), then `npm test` shows `# fail 0` and `# skipped 0`. Until
   both fixtures exist the Polkadex-specific checks have not run and the branch
   is not cleared, whatever else has passed.
2. Run sheet C1 to C4 on a 392 chain: the indexer covers both sides of the
   upgrade block with zero scan failures, v5 extrinsics decode, and the
   self-check is OK on spec 392.
3. Run sheet C5: one balance transfer and one council vote with the
   polkadot{.js} extension, both finalized.

## Mainnet checklist

In order. The first four boxes are the deploy gate and must be done before the
referendum enacts 392; the deploy box has the same deadline.

- [ ] Run sheet A and B: `node scripts/fetch-metadata.mjs` on this branch (v5
      found in the 392 sample, v16 offered), then `npm test` shows `# fail 0`
      and `# skipped 0`.
- [ ] Run sheet C1 to C4: index both sides of the 392 upgrade block with zero
      scan failures, v5 decodes, self-check OK on spec 392.
- [ ] Run sheet C5, testnet, polkadot{.js} extension: one transfer and one council vote.
- [ ] Self-check OK on the dev instance (server log, `/api/version`, browser
      console).
- [ ] **Deploy this build to mainnet while mainnet is still on 373, and have it
      live and healthy before the referendum enacts 392.** Run sheet D: the
      `[tx-extensions] server self-check OK` line and `/api/version` showing
      `assetFeeCheck.ok: true` and the new commit, the indexer advances,
      `scan_failures` has no new rows, `coverage.decodeFailures` is all zeros,
      and `/api/health` is 200.
- [ ] Post-deploy, testnet (dev instance, or the deployed build against testnet
      if one exists): Talisman and SubWallet, each one transfer and one council
      vote, same pass rules as above. These do not gate the deploy; a failure
      is a fix-forward item for the wallet path, and the polkadot{.js} path
      already passed.
- [ ] Post-deploy, mainnet: Nova Wallet in-app browser, one balance transfer.
      Nova signs only chains in its own list and drops Polkadex staking on 25
      Oct, so it cannot be tested against testnet; this single mainnet transfer
      is its check. Use a small amount and record the tx hash and block. If
      Nova no longer offers Polkadex transfers at all, record that instead.
- [ ] Run sheet E: watch across the 392 enactment block: the indexer continues
      past it with no `extrinsic_decode:*`, `block_decode_recovered` or
      `chain_index` failures, `/api/version` moves to spec 392 with the
      self-check OK, and a transfer signed after enactment succeeds.
- [ ] After enactment, spot-check one block from before and one from after the
      upgrade in `/api/decode/<block>`: both decode with their own runtime.

## Rollback

Rollback to the previous image is valid ONLY before mainnet enacts 392. The
database schema is unchanged by this work, so that rollback needs no migration.
Before enactment: on your Mac, revert the merge commit on `main` (a revert PR),
then on the explorer box `cd /opt/pdexplorer` and `sudo bash deploy.sh`. The
revert also removes whatever else from `main` the merge brought in that was not
live yet; compare with the `gitSha` noted in D2.

After enactment it is NOT a rollback path: the previous image runs
@polkadot/api 10.13.1, which cannot decode blocks produced under 392 (it
predates extrinsic v5 and the new extension set, so it misreads or drops them).
Once 392 is enacted the only path is fix forward on this branch's successor on
`main` (run sheet E). This is why the deploy deadline above matters: a defect
found after enactment cannot be escaped by reverting.

The new `scan_failures` indexer keys (`extrinsic_decode:<index>` and
`block_decode_recovered`) are inert to the old code: it never writes or reads
them, so a rollback before enactment leaves them as harmless rows. They stay
in the table (they are an operator signal, not retried) and can be deleted by
hand if wanted.

## Verified here vs by reading only

Verified by running (Linux, Node 22.23, 2026-10-18, again 2026-10-25 on the
rebased branch, and 2026-10-27 on the merged r3 branch): `npm ci` (offline,
from the lock), `npm test`, `npm run build` (Vite, with the Open Graph shell
step), a trial merge of PR 20 with `npm test` and the build, a backend boot
(on 2026-10-27 also the five governance item routes) (workers start, `/api/version` answers, RPC unreachable
as expected in the sandbox), `scripts/fetch-metadata.mjs` end to end against a
local mock JSON-RPC server (2026-10-18; on 2026-10-25 only its connect-failure
path, after the JSON-RPC client moved to `lib/json-rpc-client.js` unchanged),
`scripts/find-upgrade-block.mjs` end to end against a local mock node, the
fixture suites against the mainnet 373 fixture fetched on 2026-10-19 and a
synthetic 392 fixture built from Substrate's v15/v16 metadata, and the live
governance decoders on 10.13.1 and 17.0.2 codecs.

By reading only: behaviour against the real Polkadex nodes (the sandbox cannot
reach them), a real 392 fixture, the browser bundle signing with a real wallet
(the signedTransaction path is tested against the real library with fake
wallets only), the `.raw` and `getBlockRegistry` fallback path in
`getBlockTolerant` against a live node (wiring is covered by source tests; the
per-extrinsic decoder itself is unit-tested), the requeue fast path in C3 (the
same `scanChainRange` the indexer uses, read not run), and the production
deploy commands in D and E (taken from `deploy.sh`, `tools/verify-deploy.sh`,
`docker-compose.yml` and `docs/discussion-recovery-2026-10-22.md`).
