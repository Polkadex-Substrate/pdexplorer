// Post-action refresh: the copy and the timings (designer spec cto-team/plans/2026-11-22-post-action-refresh-ux.md,
// sections 1, 3 and 4, hook H7). One import-free module so tests can read the numbers and freeze the words.
// Strings are verbatim with their spec ids; placeholders are {name} and are filled by say().

export const REFRESH_UI = Object.freeze({
    showDelayMs: 600,      // T1: an indicator appears only if the state has lasted this long
    minVisibleMs: 900,     // T2: once shown, an indicator stays at least this long
    settleHoldMs: 1600,    // T3: a settled row holds its green check this long before it leaves
    collapseMs: 240,       // T4: a leaving row collapses, a returning row fades in
    highlightMs: 1200,     // T5: neutral wash on a figure whose value changed
    fadeMs: 150,           // T6: indicator fade
    announceGapMs: 5000,   // T7: at most one live-region message per component per 5 s; later ones merge
    quietAnnounceMs: 5000  // T8: "up to date" only after an indicator was visible this long
});

export const STRINGS = Object.freeze({
    S1: 'Updating',
    S2: 'Checking',
    S3: 'A payout for this era is in a block. Checking whether your share was in it.',
    S4: 'Paid in block #{n}',
    S4_NONE: 'Paid',
    S5: 'Removed in block #{n}',
    S6: 'Executed in block #{n}',
    S7: 'Cancelled in block #{n}',
    S8: 'Released in block #{n}',
    S9: 'Paid out in block #{n}',
    S10: 'Checking {n} entries',
    S10_ONE: 'Checking 1 entry',
    S10t: 'A payout for these eras is in a block. The list is checking which of them paid your account.',
    S11: 'This section could not be refreshed. It may be behind the chain.',
    S12: 'Reload this section',
    S13: 'Reloading',
    S14: 'May be behind',
    S15: 'This list may be behind the chain. An era that is already paid is skipped, and you still pay the network fee.',
    S16: 'Still could not refresh. Last tried at {HH:MM}.',
    S17: 'The block with your {payout} was replaced by the network. It is being sent again, so the items below are listed until it is back in a block.',
    S18: 'Payout in progress',
    S20: 'Confirming',
    S21: 'Sent {amount} PDEX to {short address}. In block #{n}. This row is replaced when the explorer has indexed it.',
    A1: 'Unpaid rewards updated: {n} paid, {m} left.',
    A1g: '{Section name} updated.',
    A2: '{n} entries are being checked.',
    A3: '{Section name} is up to date.',
    A4: '{Section name} could not be refreshed. Use Reload this section.',
    A5: '{Section name} is up to date.',
    A6: 'The {payout} is not confirmed any more. The items are listed again while it is sent again.'
});

// {payout} in S17 and A6: the action noun from a fixed map; default "transaction".
const NOUNS = {
    'staking.payout': 'payout', 'balances.transfer': 'transfer',
    'democracy.vote': 'vote', 'council.vote': 'vote', 'elections.vote': 'vote',
    'proxy.add': 'proxy change', 'proxy.remove': 'proxy change',
    'identity.set': 'identity change', 'identity.clear': 'identity change'
};
export const nounFor = (key) => NOUNS[key] || 'transaction';

// The string for an id, placeholders filled. S4 without a block number is "Paid"; S10 for one entry is
// its own sentence.
export function say(id, vars = {}) {
    let text = STRINGS[id];
    if (id === 'S4' && (vars.n == null || vars.n === '')) text = STRINGS.S4_NONE;
    if (id === 'S10' && Number(vars.n) === 1) text = STRINGS.S10_ONE;
    if (text == null) return '';
    return text.replace(/\{([^{}]+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}
