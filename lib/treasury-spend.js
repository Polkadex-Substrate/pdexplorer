// Who may create a treasury spend. SpendOrigin in the runtime (polkadex-node,
// branch mainnet, runtimes/mainnet/src/lib.rs, impl pallet_treasury::Config)
// is Root, i.e. a referendum, with no cap; or at least 3/5 of the council
// seats (EnsureProportionAtLeast<_, CouncilCollective, 3, 5>) with
// CouncilSpendCap per spend. Neither the share nor the cap is in the metadata.
// The Treasury page's spend form (lib/treasury-spend-view.js) builds on this.
import { LIVE_COLLECTIVES, resolveCollectivePallet } from './collective-live.js';
import { sameAccount } from './multisig.js';
import { formatPlanck } from './tx-status.js';
import { isPositiveNumberInput, isPolkadexPrefixedAddress, isValidPolkadexAddress, pdexToPlanck } from './wallet-safety.js';

export const COUNCIL_SPEND_CAP_PDEX = 50_000;
export const COUNCIL_SPEND_CAP_TEXT = `${COUNCIL_SPEND_CAP_PDEX.toLocaleString('en-US')} PDEX`;
export const SPEND_RULE_TEXT = `Spends by council motion (at least 3/5 of seats, up to ${COUNCIL_SPEND_CAP_TEXT}) or referendum`;
export const SPEND_CAP_ERROR = `A spend above ${COUNCIL_SPEND_CAP_TEXT} needs a referendum; a council motion can approve up to ${COUNCIL_SPEND_CAP_TEXT} per spend.`;
const U32_MAX = 4294967295;

// A closed motion runs as Members(ayes, seats), which 3/5 accepts when
// ayes x 5 >= seats x 3, so a lower threshold can pass and still fail BadOrigin.
// A threshold below 2 runs the call at once inside propose, as Members(1, seats)
// (pallet-collective do_propose_execute): 3/5 accepts that only with one seat,
// and ceil(3 x seats / 5) is 1 only then.
export function spendThresholdRange(seats) {
    const s = Number(seats);
    return Number.isInteger(s) && s > 0 ? { min: Math.ceil(s * 3 / 5), max: s } : null;
}

export function thresholdWhy(seats) {
    const r = spendThresholdRange(seats);
    return r ? `A spend runs only with Ayes from at least three fifths of all ${seats} seats (${r.min}), and no motion can need more Ayes than there are seats.` : '';
}

// A plain positive decimal in plancks, or null (also for more decimals than the chain has).
function toPlanck(text, decimals) {
    const s = String(text == null ? '' : text).trim();
    return isPositiveNumberInput(s) && (s.split('.')[1] || '').length <= decimals ? pdexToPlanck(s, decimals) : null;
}

export const OTHER_NETWORK_ERROR = 'This is not a Polkadex address (it starts with the prefix of another network).';

// Valid-from must be a block still to come, else the spend's payout window
// (valid-from + PayoutPeriod) has started, or ended, before the motion runs.
export const validFromTooEarly = (head) => `Use block ${head + 1} or later for valid-from (the chain is currently at block ${head}), or leave it empty to make the spend claimable as soon as the motion runs.`;

// The form's text fields as call arguments, or one error per field.
// ss58Prefix is the chain's (api.registry.chainSS58); head is the current block
// number, needed only when a valid-from block is given.
export function checkSpendForm(f, { seats, decimals, ss58Prefix = 88, head }) {
    const errors = {};
    const beneficiary = String(f.beneficiary || '').trim();
    if (!isValidPolkadexAddress(beneficiary)) errors.beneficiary = 'Enter the beneficiary as a valid Polkadex address.';
    else if (!isPolkadexPrefixedAddress(beneficiary, ss58Prefix)) errors.beneficiary = OTHER_NETWORK_ERROR;
    const planck = toPlanck(f.amount, decimals);
    if (planck === null) errors.amount = `Enter a positive PDEX amount with at most ${decimals} decimals.`;
    else if (BigInt(planck) > BigInt(COUNCIL_SPEND_CAP_PDEX) * 10n ** BigInt(decimals)) errors.amount = SPEND_CAP_ERROR;
    const from = String(f.validFrom || '').trim();
    const validFrom = from === '' ? null : /^\d{1,10}$/.test(from) && Number(from) <= U32_MAX ? Number(from) : undefined;
    if (validFrom === undefined) errors.validFrom = 'Leave the valid-from block empty, or enter a whole block number.';
    else if (validFrom !== null && !Number.isInteger(head)) errors.validFrom = 'The current block is not known, so a valid-from block cannot be checked. Try again, or leave it empty.';
    else if (validFrom !== null && validFrom < head + 1) errors.validFrom = validFromTooEarly(head);
    const range = spendThresholdRange(seats), t = String(f.threshold || '').trim();
    const threshold = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!range) errors.threshold = 'The council seats are not known yet.';
    else if (!(threshold >= range.min && threshold <= range.max)) errors.threshold = `Use a threshold from ${range.min} to ${range.max}. ${thresholdWhy(seats)}`;
    const ok = Object.keys(errors).length === 0;
    return { ok, errors, values: ok ? { beneficiary, planck, validFrom, threshold } : null };
}

// The council's seats, read live, and the pallet its motions go through.
export async function readCouncilSeats(api) {
    const pallet = resolveCollectivePallet(api, LIVE_COLLECTIVES.find(c => c.key === 'council').pallets);
    if (!pallet || !api.tx[pallet] || typeof api.tx[pallet].propose !== 'function') throw new Error('Council motions are not available on this runtime.');
    return { pallet, members: Array.from(await api.query[pallet].members(), String) };
}

export const holdsSeat = (seats, address) => !!(seats && address) && seats.members.some(m => sameAccount(m, address));

// The best block number, which valid-from is checked against.
export async function readHeadNumber(api) {
    return (await api.rpc.chain.getHeader()).number.toNumber();
}

// council.propose(threshold, treasury.spend((), amount, beneficiary, validFrom), lengthBound):
// AssetKind is () on Polkadex, and the bound is the inner call's encoded length.
export function buildSpendMotion(api, pallet, v) {
    const spend = api.tx.treasury.spend(null, v.planck, { Id: v.beneficiary }, v.validFrom).method;
    return api.tx[pallet].propose(v.threshold, spend, spend.encodedLength);
}

// Argument names as polkadot-js gives them (camelCase); the beneficiary is a MultiAddress enum.
const argText = (name, v, decimals) => name === 'amount' ? `${formatPlanck(String(v), decimals, decimals)} PDEX (${v} plancks)`
    : name === 'beneficiary' && v.type === 'Id' ? String(v.value)
    : name === 'validFrom' ? (v.isSome ? `block ${v.unwrap()}` : 'none: claimable as soon as the motion runs')
    : name === 'assetKind' ? 'PDEX (the native asset)' : String(v);

// The built motion decoded back from its bytes, as rows for the review step.
export function decodeSpendMotion(api, tx, decimals) {
    const call = api.registry.createType('Call', tx.method.toHex());
    const [threshold, proposal, lengthBound] = call.args;
    const names = (c) => c.meta.args.map(a => a.name.toString());
    const [thresholdName, , boundName] = names(call);
    return {
        hash: proposal.hash.toHex(),
        motion: { section: call.section, method: call.method, args: [{ name: thresholdName, value: String(threshold) }, { name: boundName, value: String(lengthBound) }] },
        spend: { section: proposal.section, method: proposal.method, args: names(proposal).map((name, i) => ({ name, value: argText(name, proposal.args[i], decimals) })) }
    };
}
