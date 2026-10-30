// How a validator's total stake is shown when the backend says the stake read
// is broken.
//
// /api/validators carries stakeDataOk false when every active validator read
// 0 total stake (the spec 392 incident). The validator list already shows
// "unavailable" in that state; the wallet stake picker read the same payload
// and printed "0.0000 PDEX" for every validator, which looks like data and is
// exactly what someone choosing who to nominate would act on. Both views go
// through these two functions so they cannot disagree again.
//
// No imports on purpose: unit-tested in test/stake-display.test.js.

// The validators to render, with totalStake null when the payload says the
// stake read is broken. A missing flag (older backend) means OK.
export function validatorsWithStakeState(data) {
    const list = data && Array.isArray(data.validators) ? data.validators : [];
    return data && data.stakeDataOk === false
        ? list.map(v => ({ ...v, totalStake: null }))
        : list.slice();
}

// Picker meta text for a stake: "<n> PDEX", or "stake unavailable" for null.
export function stakeMetaText(totalStake, formatPDEX) {
    return totalStake == null ? 'stake unavailable' : `${formatPDEX(totalStake)} PDEX`;
}
