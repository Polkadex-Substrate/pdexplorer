// Who may create a treasury spend. SpendOrigin in the runtime (polkadex-node,
// branch mainnet, runtimes/mainnet/src/lib.rs, impl pallet_treasury::Config)
// is Root, i.e. a referendum, with no cap; or at least 3/5 of the council
// seats (EnsureProportionAtLeast<_, CouncilCollective, 3, 5>) with
// CouncilSpendCap per spend. Neither the share nor the cap is in the metadata.
export const COUNCIL_SPEND_CAP_PDEX = 50_000;
export const COUNCIL_SPEND_CAP_TEXT = `${COUNCIL_SPEND_CAP_PDEX.toLocaleString('en-US')} PDEX`;
export const SPEND_RULE_TEXT = `Spends by council motion (at least 3/5 of seats, up to ${COUNCIL_SPEND_CAP_TEXT}) or referendum`;
