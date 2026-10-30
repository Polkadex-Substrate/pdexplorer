// How a validator's total stake is shown when the backend says the stake read
// is broken.
//
// /api/validators carries stakeDataOk false when every active validator read
// 0 total stake (the spec 392 incident). The validator list already showed
// "unavailable" in that state; the wallet stake picker read the same payload
// and printed "0.0000 PDEX" for every validator, which looks like data and is
// exactly what someone choosing who to nominate would act on. Both views go
// through this file so they cannot disagree again.
//
// No imports on purpose: unit-tested in test/stake-display.test.js.

// The validators to render, with totalStake null and stakeUnavailable true
// when the payload says the stake read is broken. A missing flag (older
// backend) means OK.
export function validatorsWithStakeState(data) {
    const list = data && Array.isArray(data.validators) ? data.validators : [];
    return data && data.stakeDataOk === false
        ? list.map(v => ({ ...v, totalStake: null, stakeUnavailable: true }))
        : list.slice();
}

// Picker text for a validator's stake. A null stake on its own is a waiting
// validator with no exposure this era; a null stake from a broken read says
// so instead.
export function pickerStakeText(v, formatPDEX) {
    if (v && v.stakeUnavailable) return 'stake unavailable';
    if (!v || v.totalStake == null) return 'no stake this era';
    return `${formatPDEX(v.totalStake)} PDEX`;
}
