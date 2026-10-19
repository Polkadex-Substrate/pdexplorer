# Explorer readiness for runtime spec 392

Mainnet runs spec 373 until a referendum enacts 392. Testnet already runs 392;
the testnet proof below must index past block 1,553,840. One explorer build must index and sign correctly
on both runtimes and across the upgrade block, and must decode every historical
block with that block's own runtime (the explorer uses `api.at(blockHash)`).

**Deadline: this build must be live and healthy on the mainnet explorer BEFORE
the referendum enacts 392 on mainnet.** The old explorer (@polkadot/api 10.13.1)
cannot decode blocks produced under 392. Rollback to the previous image is valid
only before enactment; see "Rollback" below.

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
  `assetFeeCheck: { ok, status }` (`null` before the api exists). Re-run on
  every RPC reconnect. Look for it in the startup log and curl `/api/version`
  after deploy: `ok` must be `true`.
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
`metadata-392.json` (testnet). They are not in the repo yet. Without them those
suites SKIP with a "FIXTURE MISSING" line and count under `# skipped`; the
Polkadex-specific checks are NOT verified until they exist. With them, each
metadata version the node offers (v14, and v15/v16 where available) is checked
for: the extension list, v4 signed round trip with asset id None and Some, v5
General round trip where the runtime declares v5, the v4 signing payload
against the metadata with mode Disabled, and real extrinsics from recent blocks
of that runtime decoding and re-encoding byte-identical with the right hash.

On your Mac, from the repo root on this branch:

```
npm ci
node scripts/fetch-metadata.mjs
npm test
```

Expected: `# fail 0` and `# skipped 0`. The fetch script is read-only JSON-RPC
(no keys, nothing submitted). If mainnet has already moved past 373 it warns and
records the real spec in the file.

For the 392 sample the script scans the recent blocks (400 by default) for
extrinsic format versions and prints, for example:

```
seenFormats={"4":{"total":812,"bare":300,"signed":512,"general":0},"5":{"total":3,"bare":0,"signed":0,"general":3}}
```

The split is read from the version byte (0x04 bare v4, 0x84 signed v4, 0x05 bare
v5, 0x45 general v5). If no v5 extrinsic is found the script exits non-zero with
a message and does NOT write `metadata-392.json` (a file with no v5 sample would
let the v5 checks skip silently). Widen the window with `--blocks 2000` (or more)
and re-run. Testnet may simply have had no v5 traffic in the window; that is a
reason to widen or to send one v5 transaction there, not to skip the check.

## Gate to deploy this branch to the mainnet explorer

Mainnet is still on 373 while this gate is worked. Everything in it can be done
now, before any referendum outcome. All three must be true before the deploy:

1. On your Mac, on this branch: `node scripts/fetch-metadata.mjs` (a v5 extrinsic
   must be found in the 392 sample; widen with `--blocks N` if not), then
   `npm test` shows `# fail 0` and `# skipped 0`. Until both fixtures exist the
   Polkadex-specific checks have not run and the branch is not cleared, whatever
   else has passed.
2. Testnet dev-instance criteria (procedure below): the indexer is past block
   1,553,840 with zero scan failures of any kind.
3. Testnet, with the polkadot{.js} extension: one balance transfer and one
   council vote, both finalized (details below).

### Testnet dev-instance procedure

Run a throwaway dev instance against testnet, from a separate checkout so its
`data/` directory is its own. On your Mac:

```
git worktree add ../pdexplorer-392 chore/polkadot-api-v5
cd ../pdexplorer-392
npm ci
POLKADEX_WS=wss://polkadex-testnet.polkadex.ee PORT=3001 BLOCKS_MIN_BLOCK=1553000 TX_MIN_BLOCK=1553000 GOV_MIN_BLOCK=1553000 STAKING_REWARDS_MIN_BLOCK=1553000 npm run server
```

In a second terminal, same directory:

```
VITE_POLKADEX_WS=wss://polkadex-testnet.polkadex.ee npm run dev
```

Pass criteria for the deploy gate:

1. The indexer walks from the head back past block 1,553,840 to 1,553,000: `/api/blocks` shows heights on both sides, and
   ```
   sqlite3 data/explorer.db "SELECT COUNT(*) FROM blocks WHERE number BETWEEN 1553000 AND 1554000;"
   ```
   returns 1001.
2. Zero scan failures of any kind, including `extrinsic_decode:<index>` and
   `block_decode_recovered`:
   ```
   sqlite3 data/explorer.db "SELECT indexer, COUNT(*) FROM scan_failures GROUP BY indexer;"
   ```
   returns no rows, and `curl -s localhost:3001/api/blocks` shows
   `"decodeFailures":{"extrinsicDecode":0,"blockDecodeRecovered":0}`.
3. Wallet, polkadot{.js} extension only, in the browser at http://localhost:3000
   (dev server, testnet WS):
   - one balance transfer between two testnet accounts: finalized, success
     event, and the explorer shows it with the same tx hash the wallet reports;
   - one council vote from a testnet council member account held in that
     wallet: finalized, `council.Voted` event, shown on the motion.

   Record wallet version, tx hash and block for each.
4. The self-check passes: the backend log has `[tx-extensions] server
   self-check OK`, `curl -s localhost:3001/api/version` shows
   `"assetFeeCheck":{"ok":true,...}`, and the browser console shows `browser
   self-check OK` with no warn. Also: no "Unknown signed extensions" line in the
   backend log, and no "[silenced]" announcement for "has multiple versions"
   (server.js silences that warning after announcing it once, so look for the
   announcement).

A wallet that returns the whole signed transaction is accepted (see Signing
above); one that returns altered call data is refused with an error, which
counts as a FAIL for that wallet, not a pass.

Keep the dev instance running for the post-deploy checks below, then remove it:
stop both processes, `cd ..` and `git worktree remove pdexplorer-392`.

## Mainnet checklist

In order. The first four boxes are the deploy gate and must be done before the
referendum enacts 392; the deploy box has the same deadline.

- [ ] `node scripts/fetch-metadata.mjs` on this branch (v5 found in the 392
      sample), then `npm test` shows `# fail 0` and `# skipped 0`.
- [ ] Testnet dev instance: index past block 1,553,840 with zero scan failures.
- [ ] Testnet, polkadot{.js} extension: one transfer and one council vote.
- [ ] Self-check OK on the dev instance (server log, `/api/version`, browser
      console).
- [ ] **Deploy this build to mainnet while mainnet is still on 373, and have it
      live and healthy before the referendum enacts 392.** Check: the
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
      is its check. Use a small amount and record the tx hash and block.
- [ ] Watch across the 392 enactment block: the indexer continues past it with
      no `extrinsic_decode:*`, `block_decode_recovered` or `chain_index`
      failures, and a transfer signed after enactment succeeds.
- [ ] After enactment, spot-check one block from before and one from after the
      upgrade in `/api/decode/<block>`: both decode with their own runtime.

## Rollback

Rollback to the previous image is valid ONLY before mainnet enacts 392. The
database schema is unchanged by this work, so that rollback needs no migration.

After enactment it is NOT a rollback path: the previous image runs
@polkadot/api 10.13.1, which cannot decode blocks produced under 392 (it
predates extrinsic v5 and the new extension set, so it misreads or drops them).
Once 392 is enacted the only path is fix forward on this branch. This is why the
deploy deadline above matters: a defect found after enactment cannot be
escaped by reverting.

The new `scan_failures` indexer keys (`extrinsic_decode:<index>` and
`block_decode_recovered`) are inert to the old code: it never writes or reads
them, so a rollback before enactment leaves them as harmless rows. They stay
in the table (they are an operator signal, not retried) and can be deleted by
hand if wanted.

## Verified here vs by reading only

Verified by running (Linux, Node 22.23): full `npm ci`, `npm test`,
`npx vite build`, a backend boot (workers start, RPC unreachable as expected in
the sandbox), and `scripts/fetch-metadata.mjs` end to end against a local mock
JSON-RPC server, with its output fed through the fixture suites. The format scan and
the "no v5 found" exit were run end to end against a local mock JSON-RPC server
(v5 present, absent, and outside a narrow `--blocks` window).

By reading only: behaviour against the real Polkadex nodes (the sandbox cannot
reach them), the browser bundle signing with a real wallet (the
signedTransaction path is tested against the real library with fake wallets
only), and the
`.raw` and `getBlockRegistry` fallback path in `getBlockTolerant` against a live
node (wiring is covered by source tests; the per-extrinsic decoder itself is
unit-tested).
