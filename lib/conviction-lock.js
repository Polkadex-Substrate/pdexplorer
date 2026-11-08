// The lock a referendum vote takes, for the vote form and the status card
// (pallet-democracy vote.rs locked_if, conviction.rs lock_periods): only the
// winning side stays locked, for lock periods x VoteLockingPeriod counted from
// the referendum's end; None (0.1x) is not locked after the end.
import { LOCK_PERIODS, blocksToDays } from './balance-locks.js';
import { CONVICTION_MULTIPLIER, DEFAULT_BLOCK_MS } from './gov-detail.js';

// Days in one lock period (democracy.voteLockingPeriod at the explorer's block
// time), or null while the constant is not loaded.
export function lockPeriodDays(api) {
    const period = api && api.consts && api.consts.democracy && api.consts.democracy.voteLockingPeriod;
    return blocksToDays(period == null ? 0 : String(period), DEFAULT_BLOCK_MS) || null;
}

// "1× weight, locked 30 days if your side wins"; lock periods while the
// period length is unknown.
export function convictionLabel(conviction, periodDays) {
    const periods = LOCK_PERIODS[conviction];
    const weight = `${CONVICTION_MULTIPLIER[conviction]}× weight`;
    if (!periods) return `${weight}, no lock`;
    const days = periodDays ? Math.round(periods * periodDays * 10) / 10 : 0;
    const lock = days ? `${days} day${days === 1 ? '' : 's'}` : `${periods} lock period${periods === 1 ? '' : 's'}`;
    return `${weight}, locked ${lock} if your side wins`;
}

// Relabels the vote form's conviction options for the loaded period.
export function labelConvictions(select, periodDays) {
    for (const o of Array.from((select && select.options) || [])) {
        if (o.value in LOCK_PERIODS) o.textContent = convictionLabel(o.value, periodDays);
    }
}
