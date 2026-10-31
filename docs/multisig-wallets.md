# Using multisig wallets

1. Open **My Account** and select your individual signing account. Below the balance summary and action bar, **Multisig wallets** automatically checks recent indexed activity. Choose **Open wallet** on a match. Its full address and approval threshold are shown before opening it.
2. If it is not found, expand **Add an existing multisig** on that page or in **Switch wallet**. Enter a name, the existing multisig address, every signer address, and the required approval count. The explorer verifies the derived address before saving. Opening or importing a wallet does not send a transaction. Definitions persist in this browser; import the same public information on other browsers if discovery does not find it.
3. Select the saved multisig. Its dashboard shows balances and pending transactions. Allow the explorer to see your individual signing account in your wallet extension.
4. Use **Send PDEX**, the existing staking/governance actions, or the advanced encoded-call form. Review the full call and choose the individual signer. The review distinguishes **Record approval** from **Execute transaction**, and shows the estimated signer fee and refundable signer deposit. Transferred funds come from the multisig; fees and the multisig deposit come from the individual signer.
5. Another signer imports and selects the same multisig, opens its pending transaction, reviews it, and signs. For a 2-of-3 wallet, the second approval executes the call. For a threshold-one wallet, the first signer executes immediately.
6. Only the original depositor can cancel a pending transaction. The review checks this against current on-chain storage.

The first approval includes full call data in `multisig.asMulti`. Other browsers try to recover that data from its originating block and verify its hash. For older hash-only proposals or unavailable historical blocks, use **Copy call data for other signers** or obtain the full encoded call from the proposer and paste it into the review. A call hash alone is insufficient. Each signer must inspect the decoded call before approving it.

## Automatic discovery limits

The chain does not store a complete signer-to-multisig registry. Discovery checks up to 1,000 recent indexed account events (five pages) and 20 associated blocks. It reads the original calls, reconstructs their effective signer through supported batch/proxy/multisig wrappers, and verifies the derived address against the indexed multisig event. Results must include the selected account in their full signer list. Discovered definitions are saved only when opened; existing wallet names are preserved. Repeated dashboard refreshes share the current search and cache successful results in memory for one minute.

This is a best-effort search, not a complete historical index of all memberships. Older or unindexed activity, unavailable archive blocks, unsupported call wrappers, threshold-one calls without multisig events, wallets where the account has never participated, and wallets that have only received funds can be missed. An empty search result does not mean the account has no multisigs. Use manual import in those cases. A persistent **Discovery limits** note explains the manual-import fallback, including while loading and after errors. The UI also reports search limits and unavailable blocks, and offers **Refresh discovery** to retry. A complete membership search would require a dedicated historical multisig index.

The explorer stores public multisig definitions in `pdex_multisigs_v1` and locally reviewed call data under `pdex_multisig_call:<genesis>:<address>:<hash>`. No private key or extension signer is stored. Call caches are scoped to the chain and runtime version. Clearing browser storage removes these saved definitions and call caches; it does not remove an on-chain multisig or pending proposal.

## Implementation and verification

- `lib/multisig.js` validates definitions, derives accounts, decodes and verifies call data, recovers call data from the originating block, and builds runtime-metadata-driven extrinsics from live storage.
- `lib/multisig-discovery.js` performs the bounded, read-only history search; `test/multisig-discovery.test.js` covers origins, address derivation, pagination, bounds, unavailable blocks, and stale fork rows with real SCALE calls.
- `lib/multisig-view.js` imports accounts, displays pending calls, and reviews the individual signer, call, fees, deposit, and execution intent. It rechecks live state before signing; changed approvals, timepoints, runtime, wallet, or materially increased fees require another review.
- `submitSignedTx` routes saved multisigs through that review and retains the existing single-account path. Multisig inner dispatch failures are handled by the existing transaction-status lifecycle.
- `test/multisig.test.js` tests real SCALE call encoding with mocked chain storage, including 2-of-3, 3-of-3, threshold one, cancellation, preimage recovery, mismatched call hashes, and inner errors.
- `test/multisig-wallet.test.js` runs the actual SPA functions with fake extensions to check account persistence, correct signer selection, account-switch races, and ordinary-wallet compatibility.

Run `npm ci`, `npm test`, and `npm run build` using Node 22. On a test network, verify a small 2-of-3 transfer with separate browser profiles: first approval must leave the destination unchanged, second approval must transfer, and only the depositor must be able to cancel a separate pending proposal. Test wallet rejection and a failed inner call as well. Automated tests do not submit live transactions.
