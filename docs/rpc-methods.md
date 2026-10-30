# Substrate JSON-RPC methods the explorer uses

Inventory taken 2026-10-29, after mainnet enacted runtime spec 392. Every
`api.rpc.*` call and every raw JSON-RPC call in `server.js`, `script.js`,
`lib/`, `tools/` and `scripts/`, classified as current, replaced, or unsafe.
`test/rpc-methods.test.js` fails if a deprecated or aliased method (as
@polkadot/types lists them) comes back in any of these files, or in what a
booted api sends.

Sources, per row: **lib** means @polkadot/types 17.0.2 `rpcDefinitions`
(its `deprecated` and `alias` fields); **sdk** means polkadot-sdk's
`sc-rpc-api` definitions, from knowledge of the stable releases, NOT checked
against the Polkadex node's own `rpc_methods` (no network from where this was
written); **meta** means the runtime API is in the Polkadex metadata fixtures
(`test/fixtures/metadata-373.json`, `metadata-392.json`). One indirect check
on the live node does exist: @polkadot/api deletes `api.rpc.<section>.<method>`
at start-up when the node's `rpc_methods` does not list
`<section>_<method>` (`api/base/Decorate.js`, `_filterRpcMethods`), so every
`api.rpc` method the explorer calls successfully today is listed by the node.

## Replaced

| Was | Now | Where | Source |
|---|---|---|---|
| `chain_subscribeNewHead` / `chain_unsubscribeNewHead` (the alias @polkadot/api 17.0.2 sends for `api.rpc.chain.subscribeNewHeads`) | `chain_subscribeNewHeads` / `chain_unsubscribeNewHeads` (canonical) | `script.js` `subscribeNewBlocks`, via `ApiPromise.create({ rpc: canonicalRpc() })` in `script.js` and `server.js` (`lib/rpc-methods.js`) | lib (alias), sdk (canonical); the node lists `chain_subscribeNewHeads` (indirect check above) |
| `payment_queryInfo` (RPC console allowlist) | `transactionPaymentApi_queryInfo`: the `TransactionPaymentApi_query_info` runtime API through `api.call` (and `api.at(hash).call` with a block hash), same parameters `[extrinsicHex, atBlockHash?]` | `server.js` `POST /api/rpc/call` (`lib/rpc-methods.js`) | lib (deprecated, "use api.call.transactionPaymentApi.queryInfo"), meta (TransactionPaymentApi v4 with query_info in 373 and 392) |

## Current (kept)

| Method | Call sites | Notes |
|---|---|---|
| `chain_getBlock` | server.js 3, script.js 1 | `.raw` once in `getBlockTolerant` (server.js) |
| `chain_getBlockHash` | server.js 5, tools/link-motion-threads.mjs 1, scripts/fetch-metadata.mjs 2, tools/rpc-health.mjs 2 | |
| `chain_getHeader` | server.js 9, lib/tx-submit.js 1, scripts/fetch-metadata.mjs 1, tools/rpc-health.mjs 2 | |
| `chain_getFinalizedHead` | server.js 1, scripts/fetch-metadata.mjs 1, tools/rpc-health.mjs 1 | canonical (the alias is `chain_getFinalisedHead`) |
| `state_getRuntimeVersion` | server.js 1, scripts/fetch-metadata.mjs 2, tools/rpc-health.mjs 2 | canonical (the alias is `chain_getRuntimeVersion`, used nowhere) |
| `state_getStorage` | script.js 1 (`readEventsAt`) | deliberately a raw read at a block hash instead of `api.query.system.events.at()`, which would rebuild the whole decorated api per new head in every tab; documented at the call site |
| `state_getMetadata`, `state_call` (`Metadata_metadata_versions`, `Metadata_metadata_at_version`) | scripts/fetch-metadata.mjs 1 + 2 | manual SCALE on purpose: the fixture script uses no @polkadot/api so a library bug cannot shape the fixture that tests the library |
| `system_chain`, `system_health` | server.js 1 + 1, tools/rpc-health.mjs 1 + 1 | |
| `system_version`, `system_localPeerId` | tools/rpc-health.mjs 1 + 1 | `system_localPeerId` identifies which backend a load-balanced connection landed on; believed safe (sdk does not gate it as unsafe, from knowledge), unverified against the node |
| RPC console allowlist (`POST /api/rpc/call`), 17 entries | server.js | read-only by construction: `chain_getBlock`, `chain_getBlockHash`, `chain_getFinalizedHead`, `chain_getHeader`, `state_getRuntimeVersion`, `state_getStorage`, `state_getKeysPaged` (page size clamped), `state_getStorageHash`, `state_getStorageSize`, `system_chain`, `system_chainType`, `system_health`, `system_name`, `system_properties`, `system_version`, `system_syncState`, and the runtime API entry above |

Sent by the library on the explorer's behalf, all current: the api's own
start-up (`chain_getBlockHash`, `state_getRuntimeVersion`, `system_chain`,
`system_properties`, `rpc_methods`, `state_call` for metadata, or
`state_getMetadata`, `state_subscribeRuntimeVersion`), `api.query.*`
(`state_getStorage`, `state_queryStorageAt`, `state_getKeysPaged`; the
deprecated `state_getKeys` / `state_getPairs` are never used), `api.at(hash)`,
`tx.signAndSend` (`author_submitAndWatchExtrinsic`), and `tx.paymentInfo`
(server.js and script.js), which in @polkadot/api 17.0.2 is the
`TransactionPaymentApi_query_info` runtime API, not `payment_queryInfo`
(`submittable/createClass.js`; pinned by a test).

Outside the shipped code: `debug-transactions.js` (a local debugging script,
not in either image) calls `chain_getBlockHash` and `chain_getBlock`, both
current.

## Unsafe

None. No `author_*` method other than `author_submitAndWatchExtrinsic` (via
`signAndSend`, in the browser), no `offchain_*`, no keystore or peer
management, and the console allowlist is an allowlist, not a denylist.
