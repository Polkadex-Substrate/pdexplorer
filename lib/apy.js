// The one definition of the APY base, and the one honest name for what the
// explorer computes from it. (Audit F-044)
//
// WHY THIS FILE EXISTS
//
// `23.09` was written out as a bare literal in five places — three in
// server.js, one in script.js, and once more inside a docs string — while TWO
// separate `const MAX_APY_BASE = 23.09` declarations also existed, one per
// file. The server's was declared at brace depth 3, inside getNetworkInfo, so
// the other server-side call sites could not reach it even if they had tried;
// that is the same shape as F-199, where a function-local const produced a
// ReferenceError at runtime on a page nobody had loaded in testing.
//
// Five copies of a number that changes when the chain's inflation curve or its
// staking-ratio target changes. F-060, F-133 and F-198 are each in this audit
// because two copies of something drifted apart; this is five. When Polkadex
// retunes the curve, whoever updates this has to find all five, and the ones
// they miss keep printing the old figure next to the new one with no error.
//
// WHAT THE NUMBER IS, AND WHAT IT IS NOT
//
// It is the chain's NOMINAL MAXIMUM APY at its target staking ratio (~50%):
// the return a validator with 0% commission would earn if the ratio sat exactly
// on target. It is not measured, it is not realised, and it is not what any
// particular nominator received. It is a published parameter of the inflation
// curve, hardcoded because the explorer has no on-chain source for it — see
// the caveat below, which is the honest version of that admission.
export const MAX_APY_BASE = 23.09;

// Naming, which is the actual F-044 finding. The audit's words: "Do not call
// 23.09% 'real'." Round 1 renamed the validators-table COLUMN and left the API
// field alone; round 2 deleted a second column that printed the same number
// twice; the field name `realApy` survived both. A field called `realApy` tells
// an integrator the explorer measured something. It did not. It multiplied a
// hardcoded constant by one minus today's commission — an arithmetic
// projection off a single current-prefs read, which changes the instant the
// validator changes commission and has no memory of what anyone actually
// earned.
//
// `estimatedApyAtCurrentCommission` is long on purpose. A name that has to be
// read is harder to mistake for a measurement than `realApy`, and this value
// crosses a public API where the reader cannot see the formula.
export const APY_FIELD = 'estimatedApyAtCurrentCommission';

// Deprecated aliases, kept because removing a field from a public API breaks
// integrators silently — their code reads `undefined`, computes NaN, and
// renders an empty cell rather than throwing. They are listed here rather than
// spelled out at each call site so that the day they are dropped is one edit.
export const APY_DEPRECATED_ALIASES = Object.freeze([
    'realApy',        // never was real
    'currentApy',     // accurate but ambiguous — current *what*
    'avg30DayApy'     // never was an average, and never was over 30 days
]);

// The single caveat string, so the API, the help article and the developers
// page cannot describe this number three different ways.
export const APY_CAVEAT =
    'Projection, not a measured return: the chain\'s nominal maximum APY at its ' +
    'target staking ratio, multiplied by (1 − the validator\'s current ' +
    'commission). It changes the moment the validator changes commission, and ' +
    'it does not reflect what any nominator actually received.';

/**
 * The explorer's APY projection for one commission percentage.
 *
 * Returns null rather than a number for input that is not a usable commission.
 * That is deliberate: the previous inline expression was
 * `23.09 * (1 - (commissionPct / 100))`, which returns NaN for undefined and a
 * NEGATIVE apy for a commission above 100 — and a negative APY rendered with
 * `.toFixed(2)` looks like a real, alarming number rather than missing data.
 * A null forces the caller to decide what to show, which is the dash
 * placeholder everywhere in this codebase.
 */
export function estimatedApy(commissionPercent, base = MAX_APY_BASE) {
    // Reject the ABSENT values before coercing. `Number(null)` is 0, and
    // `Number('')` and `Number([])` are 0 too — so a missing commission would
    // sail through a Number.isFinite check and project base * (1 - 0) = the
    // FULL nominal maximum. That is worse than the NaN this replaced: NaN
    // renders as the string "NaN" and is visibly broken, whereas 23.09%
    // renders as a plausible, wrong, and flattering number on a validator
    // whose commission simply failed to load. Caught by the regression test
    // for this function rather than by review.
    if (commissionPercent === null || commissionPercent === undefined) return null;
    if (typeof commissionPercent === 'string' && commissionPercent.trim() === '') return null;
    if (typeof commissionPercent === 'boolean' || Array.isArray(commissionPercent)) return null;
    const c = Number(commissionPercent);
    if (!Number.isFinite(c) || c < 0 || c > 100) return null;
    return base * (1 - c / 100);
}

/**
 * Build the APY fields for an API payload: the honest key, plus every
 * deprecated alias mirroring it. One helper so a future alias removal does not
 * have to find each `realApy:` by hand.
 */
export function apyFields(commissionPercent, base = MAX_APY_BASE) {
    const value = estimatedApy(commissionPercent, base);
    const out = { [APY_FIELD]: value };
    for (const alias of APY_DEPRECATED_ALIASES) out[alias] = value;
    return out;
}
