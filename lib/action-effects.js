// What each signed action changes, and what proves it (design cto-team/plans/2026-11-22-post-action-refresh-design.md,
// sections 0, 2.3, 3 and 4). Pure: no DOM, no chain access. The only import is lib/reward-attribution.js,
// itself import-free and already used by the indexer to attribute batch rewards.
//
// effectsFor(ctx) answers, for one transaction outcome:
//   changes: which (account, domains) a component showing them must reload,
//   known:   row changes the block's events PROVE (op 'remove'), or rows touched without proof that must be
//            held out of the next payout for a bounded time (op 'hold', UX U7, U8, hook H1),
//   later:   honest "takes effect later" notes (the existing wording shows them, never "Updating").
// It returns null whenever nothing may be claimed: no outcome, a failed outcome, or a stage that is not an
// inclusion with events (failed, cancelled, waiting, processed, unverified, confirmed by a predicate).
//
// The payout rule (section 0). On runtime 392 rewards are paged: payoutStakers(validator, era) pays the NEXT
// unpaid page, which need not hold this nominator. So PayoutStarted for (era, validator) proves nothing about
// this account. The proof is a staking.Rewarded { stash = this account } inside that batch item, attributed
// by position (utility ItemCompleted / ItemFailed delimiters). A batch whose delimiter count is not its item
// count cannot be attributed (nested batch, wrapper): every row is held, none removed.

import { isBatchDelimiter, attributeBatchRewards } from './reward-attribution.js';
import { SOURCE } from './freshness.js';

export const DOMAINS = Object.freeze(['balance', 'staking.ledger', 'staking.nominations', 'rewards.unpaid',
    'rewards.claimed', 'tx.recent', 'locks', 'identity', 'proxies', 'multisig.pending', 'council.motions',
    'council.elections', 'democracy', 'treasury.spends', 'treasury.overview', 'validator.status',
    'discussion', 'labels', 'alerts', 'watchlist', 'technicalCommittee.motions']);

// Where a domain's server copy comes from (decides when the server has caught up, design 2.3 and 5). One
// table, kept in lib/freshness.js beside caughtUp, so the two can never drift.
export { SOURCE };

export const PAYOUT_KEY = 'staking.payout';
export const payoutRowKey = (era, validator) => `${era}:${validator}`;

// Accounts (section 3): S the signer, R the real account of a proxy or stash action (else S), D a destination.
const S = (ctx) => ctx.signer || null;
const R = (ctx) => (ctx.params && (ctx.params.real || ctx.params.stash)) || S(ctx);
const none = () => [];
const later = (note) => (ctx) => [{ account: R(ctx), domain: null, note }];
// The fee is always the signer's: when R is someone else, S still sees its balance change.
const withFee = (ctx, list) => (S(ctx) && R(ctx) !== S(ctx) && !list.some(c => c.account === S(ctx))
    ? [...list, { account: S(ctx), domains: ['balance'] }] : list);

const row = (accounts, domains, evidence, extra = {}) => Object.freeze({ accounts, domains: Object.freeze(domains), evidence, known: none, later: none, ...extra });

const evName = (rec) => { const e = rec && rec.event; return e ? `${String(e.section)}.${String(e.method)}` : ''; };

// R4 (rows 10 to 19). Governance rows act only at an inclusion the page saw in block: never on an unconfirmed
// end (UX section 0, line 1). The rows that name events claim nothing without them (proof). A council or
// technical committee motion is served by its own snapshot, picked by the action's body.
const GOV_STAGES = new Set(['inBlock']);
const COLLECTIVE = /^(council|councilCollective|generalCouncil|technicalCommittee)$/;
const ELECTIONS_SECTION = /^(elections|phragmenElection|electionsPhragmen)$/;
const sameAs = (ctx) => (typeof ctx.same === 'function' ? ctx.same : (a, b) => a === b);
const anyEvent = (ctx, section, methods, data = () => true) => (Array.isArray(ctx.events) ? ctx.events : []).some((r) => {
    const e = r && r.event;
    if (!e || !section.test(String(e.section)) || !methods.includes(String(e.method))) return false;
    try { return !!data(e.data || []); } catch (err) { return false; }
});
const byMe = (ctx) => (d) => d[0] != null && S(ctx) != null && sameAs(ctx)(String(d[0]), S(ctx));
const motions = (ctx) => (ctx.params && ctx.params.body === 'technical committee' ? 'technicalCommittee.motions' : 'council.motions');
const spendEvent = (methods) => (ctx) => anyEvent(ctx, /^treasury$/, methods, (d) => d[0] != null && String(d[0]) === String(ctx.params && ctx.params.index));
export const ELECTIONS_ROLE = 'role';
const roleSet = (value) => (ctx) => [{ account: S(ctx), domain: 'council.elections', op: 'set', key: ELECTIONS_ROLE, value }];
// R3: the identity name a block proves; value(ctx) undefined: nothing to claim (no display name signed).
const identityKnown = (method, value) => (ctx) => {
    const v = value(ctx);
    if (v === undefined || !anyEvent(ctx, /^identity$/, [method], byMe(ctx))) return [];
    return [{ account: S(ctx), domain: 'identity', op: 'set', key: 'name', value: v }];
};

// The payout's known results: one entry per batch pair, 'remove' when this account's Rewarded is inside
// that item, 'hold' otherwise. A hold keeps its reason in `value` (review follow-up F6): 'noReward' (the
// item completed, or the single call succeeded, without a Rewarded for this account: a page it is not on),
// 'itemFailed' (utility.ItemFailed for that item: skipped, most likely already claimed), 'unattributable'
// (the delimiters do not count the items, so no item can be told apart).
function payoutKnown(ctx) {
    const p = ctx.params || {};
    const pairs = Array.isArray(p.pairs) ? p.pairs.filter(x => x && x.era != null && x.validator) : [];
    const account = p.account || S(ctx);
    if (!pairs.length || !account || pairs.length !== (p.pairs || []).length) return [];
    const same = typeof ctx.same === 'function' ? ctx.same : (a, b) => a === b;
    const events = (Array.isArray(ctx.events) ? ctx.events : []).filter(r => r && r.event);
    const isDelim = (r) => isBatchDelimiter(String(r.event.section), String(r.event.method));
    const mine = (r) => evName(r) === 'staking.Rewarded' && r.event.data && r.event.data[0] != null && same(String(r.event.data[0]), account);
    const proven = new Set();
    const failedItems = new Set();
    const delims = events.filter(isDelim);
    let attributable;
    if (pairs.length === 1) {
        // batchTx sends one call bare: no delimiters, and every Rewarded is that call's.
        attributable = delims.length === 0;
        if (attributable && events.some(mine)) proven.add(payoutRowKey(pairs[0].era, pairs[0].validator));
    } else {
        attributable = delims.length === pairs.length;
        if (attributable) {
            delims.forEach((r, i) => { if (String(r.event.method) === 'ItemFailed') failedItems.add(payoutRowKey(pairs[i].era, pairs[i].validator)); });
            const sequence = events.map((r, i) => (isDelim(r) ? { kind: 'delimiter' } : mine(r) ? { kind: 'reward', ref: i } : null));
            for (const hit of attributeBatchRewards(pairs, sequence).values()) {
                if (hit.era != null && hit.validator) proven.add(payoutRowKey(hit.era, hit.validator));
            }
        }
    }
    return pairs.map(x => {
        const key = payoutRowKey(x.era, x.validator);
        if (proven.has(key)) return { account, domain: 'rewards.unpaid', op: 'remove', key, value: null };
        const value = !attributable ? 'unattributable' : failedItems.has(key) ? 'itemFailed' : 'noReward';
        return { account, domain: 'rewards.unpaid', op: 'hold', key, value };
    });
}

export const EFFECTS = Object.freeze({
    'staking.payout': row((ctx) => [{ account: (ctx.params && ctx.params.account) || S(ctx), domains: ['rewards.unpaid', 'rewards.claimed', 'balance', 'staking.ledger', 'tx.recent'] }],
        ['rewards.unpaid', 'rewards.claimed', 'balance', 'staking.ledger', 'tx.recent'], 'events', { known: payoutKnown }),
    'staking.bondNominate': row((ctx) => [{ account: S(ctx), domains: ['balance', 'staking.ledger', 'staking.nominations', 'locks', 'tx.recent'] }],
        ['balance', 'staking.ledger', 'staking.nominations', 'locks', 'tx.recent'], 'events', { later: later('nextEra') }),
    'staking.unbond': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['staking.ledger', 'staking.nominations', 'locks', 'balance'] }]),
        ['staking.ledger', 'staking.nominations', 'locks', 'balance'], 'events', { later: later('afterUnbonding') }),
    'staking.withdraw': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['balance', 'staking.ledger', 'locks'] }]),
        ['balance', 'staking.ledger', 'locks'], 'events'),
    'staking.migrateCurrency': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'balance'] }]),
        ['locks', 'balance'], 'predicate'),
    'balances.transfer': row((ctx) => [{ account: S(ctx), domains: ['balance', 'locks', 'tx.recent'] },
        ...(ctx.params && ctx.params.to ? [{ account: ctx.params.to, domains: ['balance', 'locks', 'tx.recent'] }] : [])],
    ['balance', 'locks', 'tx.recent'], 'events'),
    // 7, 8 (R3): IdentitySet or IdentityCleared for the signer proves the name (the display name signed, or none).
    'identity.set': row((ctx) => [{ account: S(ctx), domains: ['identity', 'balance'] }], ['identity', 'balance'], 'events', { known: identityKnown('IdentitySet', (ctx) => {
        const v = ctx.params && typeof ctx.params.display === 'string' ? ctx.params.display.trim() : '';
        return v || undefined;
    }) }),
    'identity.clear': row((ctx) => [{ account: S(ctx), domains: ['identity', 'balance'] }], ['identity', 'balance'], 'events', { known: identityKnown('IdentityCleared', () => null) }),
    'proxy.add': row((ctx) => [{ account: S(ctx), domains: ['proxies', 'balance'] }], ['proxies', 'balance'], 'events'),
    // 20 (R3): ProxyRemoved { delegator = signer, delegatee, proxyType } proves that row gone.
    'proxy.remove': row((ctx) => [{ account: S(ctx), domains: ['proxies', 'balance', 'locks'] }], ['proxies', 'balance', 'locks'], 'events', { known: (ctx) => {
        const p = ctx.params || {};
        if (!p.delegate || p.type == null) return [];
        const proved = anyEvent(ctx, /^proxy$/, ['ProxyRemoved'], (d) => byMe(ctx)(d) && d[1] != null && sameAs(ctx)(String(d[1]), String(p.delegate)) && String(d[2]) === String(p.type));
        return proved ? [{ account: S(ctx), domain: 'proxies', op: 'remove', key: `${p.delegate}:${p.type}`, value: null }] : [];
    } }),
    'democracy.vote': row((ctx) => [{ account: S(ctx), domains: ['democracy', 'locks'] }], ['democracy', 'locks'], 'live', { stages: GOV_STAGES }),
    'democracy.second': row((ctx) => [{ account: S(ctx), domains: ['democracy', 'locks'] }], ['democracy', 'locks'], 'live', { stages: GOV_STAGES }),
    'democracy.unlock': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'democracy', 'balance'] }]), ['locks', 'democracy', 'balance'], 'events'),
    'democracy.removeVote': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'democracy', 'balance'] }]), ['locks', 'democracy', 'balance'], 'events'),
    'democracy.undelegate': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'democracy', 'balance'] }]), ['locks', 'democracy', 'balance'], 'events'),
    'elections.removeVoter': row((ctx) => [{ account: S(ctx), domains: ['locks', 'council.elections'] }], ['locks', 'council.elections'], 'events'),
    // 12: the pallet emits no event; the clean inclusion records the role, and the page shows it only once the
    // chain predicate (elections.candidates holds the account) agrees (lib/gov-post-action.js).
    'elections.candidacy': row((ctx) => [{ account: S(ctx), domains: ['council.elections', 'balance'] }], ['council.elections', 'balance'], 'predicate',
        { stages: GOV_STAGES, known: roleSet({ role: 'Candidate' }) }),
    // 13: no figure on any page draws the council vote from the server (the vote modal reads the chain at open).
    'elections.vote': row((ctx) => [{ account: S(ctx), domains: ['council.elections', 'locks'] }], ['council.elections', 'locks'], 'predicate', { stages: GOV_STAGES }),
    // 14: Renounced { candidate } for this account proves the role is gone, and params.role says from which list.
    'elections.withdraw': row((ctx) => [{ account: S(ctx), domains: ['council.elections', 'balance'] }], ['council.elections', 'balance'], 'events',
        { stages: GOV_STAGES, proof: (ctx) => anyEvent(ctx, ELECTIONS_SECTION, ['Renounced'], byMe(ctx)),
            known: (ctx) => roleSet({ role: null, from: (ctx.params && ctx.params.role) || null })(ctx) }),
    'council.vote': row((ctx) => [{ account: S(ctx), domains: [motions(ctx)] }], ['council.motions', 'technicalCommittee.motions'], 'live',
        { stages: GOV_STAGES, proof: (ctx) => anyEvent(ctx, COLLECTIVE, ['Voted'], byMe(ctx)) }),
    'council.close': row((ctx) => [{ account: S(ctx), domains: [motions(ctx), 'treasury.overview', 'democracy'] }], ['council.motions', 'technicalCommittee.motions', 'treasury.overview', 'democracy'], 'live',
        { stages: GOV_STAGES, proof: (ctx) => anyEvent(ctx, COLLECTIVE, ['Closed', 'Approved', 'Disapproved']) }),
    'council.propose': row((ctx) => [{ account: S(ctx), domains: ['council.motions'] }], ['council.motions'], 'events',
        { stages: GOV_STAGES, proof: (ctx) => anyEvent(ctx, COLLECTIVE, ['Proposed']) }),
    // 16, 17: public; only Paid or SpendProcessed for THIS spend moves the pot (PaymentFailed does not).
    'treasury.payout': row(() => [{ account: null, domains: ['treasury.spends', 'treasury.overview'] }], ['treasury.spends', 'treasury.overview'], 'events',
        { stages: GOV_STAGES, proof: spendEvent(['Paid', 'SpendProcessed']) }),
    'treasury.checkStatus': row(() => [{ account: null, domains: ['treasury.spends', 'treasury.overview'] }], ['treasury.spends', 'treasury.overview'], 'events',
        { stages: GOV_STAGES, proof: spendEvent(['Paid', 'SpendProcessed']) }),
    'validator.setup': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['validator.status', 'staking.ledger', 'balance'] }]),
        ['validator.status', 'staking.ledger', 'balance'], 'predicate', { later: later('nextEra') }),
    'validator.setupStep': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['validator.status', 'staking.ledger', 'balance'] }]),
        ['validator.status', 'staking.ledger', 'balance'], 'predicate', { later: later('nextEra') }),
    'validator.manage': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['validator.status', 'staking.ledger'] }]),
        ['validator.status', 'staking.ledger'], 'predicate', { later: later('nextEra') }),
    // 30 (R5): a first approval changes only the pending list of the multisig (params.multisig, never the
    // signer's own components). An executed call also changes what the inner action (params.inner, the action
    // the multisig review was opened for) changes, for the multisig address: its accounts, its proven known
    // results and its later notes, under the inner row's own stages and proof. Executed with no usable inner
    // action (an approval from the pending list): the multisig's chain components are re-read, nothing claimed.
    'multisig.transaction': row((ctx) => {
        const ms = msOf(ctx);
        if (!ms) return [];
        const list = [{ account: ms, domains: ['multisig.pending'] }];
        if (!msExecuted(ctx)) return list;
        const inner = msInner(ctx);
        if (!inner) return [{ account: ms, domains: ['multisig.pending', ...MS_CHAIN] }];
        for (const c of inner.entry.accounts(inner.ctx)) list.push({ account: c.account, domains: [...c.domains] });
        return list;
    }, ['multisig.pending'], 'events', {
        known: (ctx) => { const i = msExecuted(ctx) ? msInner(ctx) : null; return i ? i.entry.known(i.ctx) : []; },
        later: (ctx) => { const i = msExecuted(ctx) ? msInner(ctx) : null; return i ? i.entry.later(i.ctx) : []; }
    })
});

// Row 30's helpers. Executed: MultisigExecuted with an Ok result (outcome.executed), or a threshold-1 execute,
// which emits no multisig event and fails the whole extrinsic when its call fails (lib/tx-status.js copy).
const MS_CHAIN = Object.freeze(['balance', 'staking.ledger', 'staking.nominations', 'locks', 'proxies', 'validator.status', 'tx.recent']);
function msOf(ctx) { return (ctx.params && ctx.params.multisig) || null; }
function msExecuted(ctx) {
    const p = ctx.params || {}, o = ctx.outcome || {};
    if (o.executed === 'ok') return true;
    return p.kind === 'execute' && Number(p.threshold) === 1 && o.executed == null && !o.approvalRecorded;
}
function msInner(ctx) {
    const inner = ctx.params && ctx.params.inner;
    const ms = msOf(ctx);
    if (!ms || !inner || typeof inner.key !== 'string' || inner.key === 'multisig.transaction' || !Object.prototype.hasOwnProperty.call(EFFECTS, inner.key)) return null;
    const entry = EFFECTS[inner.key];
    const sub = { ...ctx, key: inner.key, signer: ms, params: inner.params && typeof inner.params === 'object' ? inner.params : {} };
    if (entry.stages && !entry.stages.has(ctx.stage)) return null;
    try { if (entry.proof && !entry.proof(sub)) return null; } catch (e) { return null; }
    return { entry, ctx: sub };
}

const INCLUDED = new Set(['inBlock', 'unconfirmed']);

export function effectsFor(ctx = {}) {
    const entry = EFFECTS[ctx.key];
    if (!entry) return null;
    if (!INCLUDED.has(ctx.stage)) return null;
    if (entry.stages && !entry.stages.has(ctx.stage)) return null;
    if (!ctx.outcome || ctx.outcome.ok === false) return null;
    if (!Array.isArray(ctx.events)) return null;
    if (entry.proof && !entry.proof(ctx)) return null;
    return {
        changes: entry.accounts(ctx).map(c => ({ account: c.account == null ? null : c.account, domains: [...c.domains] })),
        known: entry.known(ctx),
        later: entry.later(ctx)
    };
}
