// Accounts an event names in its data, so an account page also lists events it did not sign: a treasury
// payout it received, a transfer sent to it, a vote or multisig operation an owner ran for it. Events an
// account signed are found by signer_address. Four rules keep the lists readable:
//   1. the signer is skipped, its signed events are listed already;
//   2. fee plumbing in a signed extrinsic is skipped: every transactionPayment event, and the
//      balances.Deposit that pays the fee to the treasury (else every extrinsic lists on the treasury page);
//   3. staking payouts are left to the staking-rewards page: PayoutStarted, Rewarded and Reward anywhere,
//      and the balances.Deposit and balances.Locked inside an extrinsic that pays a reward;
//   4. imOnline.SomeOffline names each offline validator with its whole exposure: only the validators
//      are linked, not every nominator in the exposure.

// An SS58 account as toHuman() prints it: base58 (no 0x hex), 46 to 50 characters; normalize() checks the rest.
const SS58_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/;
// Stored JSON without such a run names no account, so it is not parsed (most stored events are like that).
const SS58_RUN = /[1-9A-HJ-NP-Za-km-z]{46}/;
const PAYOUT_EVENTS = new Set(['staking.PayoutStarted', 'staking.Rewarded', 'staking.Reward']);
const REWARD_EVENTS = new Set(['staking.Rewarded', 'staking.Reward']);
const PAYOUT_BALANCE_EVENTS = new Set(['balances.Deposit', 'balances.Locked']);
// The offline validators of an imOnline.SomeOffline: { offline: [[validator, exposure], ...] }, or the legacy [[...]].
const offlineValidators = data => (Array.isArray(data) ? data[0] : data?.offline)?.map?.(t => Array.isArray(t) ? t[0] : t) ?? null;

const kindOf = e => `${e.section}.${e.method}`;
const extrinsicOf = e => `${e.block}:${e.extrinsicIndex}`;
const decoded = data => {
    if (typeof data !== 'string') return data;
    try { return SS58_RUN.test(data) ? JSON.parse(data) : null; } catch { return null; }
};

// Every address-shaped string anywhere in decoded event data: named fields, legacy arrays, nested tuples.
export function addressStrings(value, out = []) {
    if (typeof value === 'string') { if (SS58_SHAPE.test(value)) out.push(value); }
    else if (value && typeof value === 'object') for (const v of Object.values(value)) addressStrings(v, out);
    return out;
}

// Sets e.accounts (normalised, the rules above applied) on events of one or more blocks, as scanned (data
// decoded) or as stored (data JSON), and returns the events. normalize(addr) throws or is falsy for a non-account.
export function attachAccounts(events, { normalize, treasury }) {
    const seen = new Map();
    const canon = a => {
        if (!seen.has(a)) { let v = null; try { v = normalize(a) || null; } catch { /* not an account */ } seen.set(a, v); }
        return seen.get(a);
    };
    const feeTo = treasury ? canon(treasury) : null;
    const payouts = new Set(events.filter(e => e.extrinsicIndex != null && REWARD_EVENTS.has(kindOf(e))).map(extrinsicOf));
    for (const e of events) {
        const kind = kindOf(e), signed = e.extrinsicIndex != null && !!e.signerAddress && e.signerAddress !== 'System';
        const skip = PAYOUT_EVENTS.has(kind) || (signed && e.section === 'transactionPayment')
            || (PAYOUT_BALANCE_EVENTS.has(kind) && payouts.has(extrinsicOf(e)));
        const drop = [signed ? canon(e.signerAddress) : null, signed && kind === 'balances.Deposit' ? feeTo : null];
        const data = skip ? null : decoded(e.data);
        const named = addressStrings(kind === 'imOnline.SomeOffline' ? offlineValidators(data) : data);
        e.accounts = [...new Set(named.map(canon))].filter(a => a && !drop.includes(a));
    }
    return events;
}
