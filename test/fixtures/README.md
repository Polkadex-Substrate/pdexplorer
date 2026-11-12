# Test fixtures: Polkadex runtime metadata

These files are committed on purpose. The real-codec suites decode with the
runtime's own metadata, and they FAIL (they do not skip) when a fixture is
missing, so CI cannot pass without them. `test/fixtures.test.js` lists any
missing file and pins each file's chain and spec version.

| File | Chain | specVersion | Block | Fetched (UTC) | Size |
|---|---|---|---|---|---|
| `metadata-mainnet-373.json` | Polkadex mainnet (`wss://rpc.polkadex.ee`) | 373 (transactionVersion 2) | 13,272,831 | 2026-10-19 | 846 KB |
| `metadata-testnet-393.json` | Polkadex TESTNET (`wss://polkadex-testnet.polkadex.ee`) | 393 (transactionVersion 3) | 57,924 | 2026-10-27 | 2.2 MB |

Both are well under 5 MB, so they are stored as plain JSON (no gzip).

Notes on what each one is:

- `metadata-mainnet-373.json` is the runtime mainnet ran before the upgrade.
  It backs the historical decode tests.
- `metadata-testnet-393.json` was previously called `metadata-392.json`, which
  was wrong twice: it is the testnet runtime (not mainnet) and it reports spec
  393 (not 392). Tests that say "spec 392" in prose mean the 392/393 runtime
  line; the only metadata they decode is this file. Mainnet has no 392 or 393
  fixture yet; add `metadata-mainnet-<spec>.json` once it is enacted.
- Other suites also use Substrate's static metadata from
  `@polkadot/types-support`; that is not stored here.

Each file holds the `state_getMetadata` hex (`metadata`), the v15/v16 metadata
where the runtime offers it (`metadataAtVersion`), and real extrinsics sampled
from blocks of the same runtime (`extrinsics`). The JSON fields `network`,
`endpoint`, `fetchedAt`, `specVersion`, `blockHash` and `blockNumber` record
the source. Read-only JSON-RPC reads; no keys are involved.

## Refreshing

Needs Node 22 and network access to the RPC.

    node scripts/fetch-metadata.mjs --only 392 --mainnet wss://polkadex-testnet.polkadex.ee
    node scripts/fetch-metadata.mjs --only 373

The script names each file from what it fetched, `metadata-<network>-<spec>.json`
(network from the genesis hash, spec from the runtime version), and writes it
straight into `test/fixtures/`. No renaming or copying. The `392` and `373`
labels only choose which fetch runs; the first command above yields
`metadata-testnet-<spec>.json` because the endpoint is the testnet. A chain
whose genesis hash is not in `lib/fixture-name.js` is refused unless you pass
`--network <name>`.

Check `git status` for the new file name. If the spec or chain changed, delete
the superseded file, update `EXPECTED` in `test/fixtures.test.js` and every
`loadFixture(...)` call, and update the table above. Run `npm test`.
