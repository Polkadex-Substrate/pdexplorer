// Event fixtures for a staking payout, in the shape lib/tx-submit.js hands to show():
// [{ event: { section, method, data } }]. Addresses are the public substrate dev accounts
// (Alice, Bob, Charlie, Dave, Eve): they belong to no one.
//
// Runtime 392 pays rewards in pages: payoutStakers(validator, era) pays the NEXT unpaid page,
// which need not hold this nominator. So a PayoutStarted for (era, validator) proves nothing
// about this account; only a staking.Rewarded { stash = this account } inside that batch item does.

export const ME = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
export const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
export const V1 = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
export const V2 = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';
export const V3 = '5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw';

const ev = (section, method, data = []) => ({ event: { section, method, data } });
export const success = () => ev('system', 'ExtrinsicSuccess');
export const payoutStarted = (era, validator) => ev('staking', 'PayoutStarted', [era, validator]);
// Runtime 392: Rewarded { stash, dest, amount }; data[0] is the stash.
export const rewarded = (stash, amount = '1000000000000') => ev('staking', 'Rewarded', [stash, { Staked: null }, amount]);
export const itemCompleted = () => ev('utility', 'ItemCompleted');
export const ALREADY_CLAIMED = { isModule: true, asModule: { index: 9, error: 14 } };
export const itemFailed = (err = ALREADY_CLAIMED) => ev('utility', 'ItemFailed', [err]);
export const batchCompletedWithErrors = () => ev('utility', 'BatchCompletedWithErrors');
export const batchCompleted = () => ev('utility', 'BatchCompleted');
export const feePaid = (who = ME) => ev('transactionPayment', 'TransactionFeePaid', [who, '1000', '0']);
// A registry that decodes ALREADY_CLAIMED the way the chain metadata would.
export const REGISTRY = { findMetaError: () => ({ section: 'staking', name: 'AlreadyClaimed', docs: ['Rewards for this era have already been claimed for this validator.'] }) };

export const PAIRS = [{ era: 501, validator: V1 }, { era: 501, validator: V2 }, { era: 502, validator: V3 }];
export const keyOf = (p) => `${p.era}:${p.validator}`;

// One forceBatch item that paid this account: the validator's page, this nominator inside it.
export const paidItem = (p, stash = ME) => [payoutStarted(p.era, p.validator), rewarded(p.validator), rewarded(stash), itemCompleted()];
// An item that ran but paid a page this account is not on.
export const otherPageItem = (p) => [payoutStarted(p.era, p.validator), rewarded(p.validator), rewarded(OTHER), itemCompleted()];
export const skippedItem = () => [itemFailed()];

export const forceBatch = (...items) => [...items.flat(), batchCompletedWithErrors(), feePaid(), success()];

// The wallet payload's rewards block (server.js /api/wallet), amounts in PDEX.
export function walletWith(entries = PAIRS.map((p, i) => ({ ...p, amount: [1.5, 2.25, 3][i] })), address = ME) {
    const unpaidTotal = entries.reduce((t, e) => t + e.amount, 0);
    return { address, rewards: { claimedTotal: 10, unpaidTotal, unpaidCount: entries.length, unclaimedFresh: true, unpaidEntries: entries } };
}
