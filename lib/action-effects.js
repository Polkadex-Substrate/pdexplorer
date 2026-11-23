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

export const DOMAINS = Object.freeze(['balance', 'staking.ledger', 'staking.nominations', 'rewards.unpaid',
    'rewards.claimed', 'tx.recent', 'locks', 'identity', 'proxies', 'multisig.pending', 'council.motions',
    'council.elections', 'democracy', 'treasury.spends', 'treasury.overview', 'validator.status',
    'discussion', 'labels', 'alerts', 'watchlist']);

// Where a domain's server copy comes from (decides when the server has caught up, design 2.3 and 5).
export const SOURCE = Object.freeze({ balance: 'chain', 'staking.ledger': 'chain', 'staking.nominations': 'chain',
    locks: 'chain', proxies: 'chain', 'multisig.pending': 'chain', 'treasury.spends': 'chain',
    'rewards.unpaid': 'indexed.chain', identity: 'indexed.chain', 'rewards.claimed': 'indexed.rewards',
    'tx.recent': 'indexed.tx', 'council.motions': 'kv.council', 'council.elections': 'kv.council',
    democracy: 'kv.democracy', 'treasury.overview': 'kv.treasury', 'validator.status': 'memo',
    discussion: 'response', labels: 'response', alerts: 'response', watchlist: 'local' });

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

// The payout's known results: one entry per batch pair, 'remove' when this account's Rewarded is inside
// that item, 'hold' otherwise.
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
    const delims = events.filter(isDelim);
    let attributable;
    if (pairs.length === 1) {
        // batchTx sends one call bare: no delimiters, and every Rewarded is that call's.
        attributable = delims.length === 0;
        if (attributable && events.some(mine)) proven.add(payoutRowKey(pairs[0].era, pairs[0].validator));
    } else {
        attributable = delims.length === pairs.length;
        if (attributable) {
            const sequence = events.map((r, i) => (isDelim(r) ? { kind: 'delimiter' } : mine(r) ? { kind: 'reward', ref: i } : null));
            for (const hit of attributeBatchRewards(pairs, sequence).values()) {
                if (hit.era != null && hit.validator) proven.add(payoutRowKey(hit.era, hit.validator));
            }
        }
    }
    return pairs.map(x => {
        const key = payoutRowKey(x.era, x.validator);
        return { account, domain: 'rewards.unpaid', op: proven.has(key) ? 'remove' : 'hold', key };
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
    'identity.set': row((ctx) => [{ account: S(ctx), domains: ['identity', 'balance'] }], ['identity', 'balance'], 'events'),
    'identity.clear': row((ctx) => [{ account: S(ctx), domains: ['identity', 'balance'] }], ['identity', 'balance'], 'events'),
    'proxy.add': row((ctx) => [{ account: S(ctx), domains: ['proxies', 'balance'] }], ['proxies', 'balance'], 'events'),
    'proxy.remove': row((ctx) => [{ account: S(ctx), domains: ['proxies', 'balance', 'locks'] }], ['proxies', 'balance', 'locks'], 'events'),
    'democracy.vote': row((ctx) => [{ account: S(ctx), domains: ['democracy', 'locks'] }], ['democracy', 'locks'], 'live'),
    'democracy.second': row((ctx) => [{ account: S(ctx), domains: ['democracy', 'locks'] }], ['democracy', 'locks'], 'live'),
    'democracy.unlock': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'democracy', 'balance'] }]), ['locks', 'democracy', 'balance'], 'events'),
    'democracy.removeVote': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'democracy', 'balance'] }]), ['locks', 'democracy', 'balance'], 'events'),
    'democracy.undelegate': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['locks', 'democracy', 'balance'] }]), ['locks', 'democracy', 'balance'], 'events'),
    'elections.removeVoter': row((ctx) => [{ account: S(ctx), domains: ['locks', 'council.elections'] }], ['locks', 'council.elections'], 'events'),
    'elections.candidacy': row((ctx) => [{ account: S(ctx), domains: ['council.elections', 'balance'] }], ['council.elections', 'balance'], 'predicate'),
    'elections.vote': row((ctx) => [{ account: S(ctx), domains: ['council.elections', 'locks'] }], ['council.elections', 'locks'], 'predicate'),
    'elections.withdraw': row((ctx) => [{ account: S(ctx), domains: ['council.elections', 'balance'] }], ['council.elections', 'balance'], 'events'),
    'council.vote': row((ctx) => [{ account: S(ctx), domains: ['council.motions'] }], ['council.motions'], 'live'),
    'council.close': row((ctx) => [{ account: S(ctx), domains: ['council.motions', 'treasury.overview', 'democracy'] }], ['council.motions', 'treasury.overview', 'democracy'], 'live'),
    'council.propose': row((ctx) => [{ account: S(ctx), domains: ['council.motions'] }], ['council.motions'], 'events'),
    'treasury.payout': row(() => [{ account: null, domains: ['treasury.spends', 'treasury.overview'] }], ['treasury.spends', 'treasury.overview'], 'events'),
    'treasury.checkStatus': row(() => [{ account: null, domains: ['treasury.spends', 'treasury.overview'] }], ['treasury.spends', 'treasury.overview'], 'events'),
    'validator.setup': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['validator.status', 'staking.ledger', 'balance'] }]),
        ['validator.status', 'staking.ledger', 'balance'], 'predicate', { later: later('nextEra') }),
    'validator.setupStep': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['validator.status', 'staking.ledger', 'balance'] }]),
        ['validator.status', 'staking.ledger', 'balance'], 'predicate', { later: later('nextEra') }),
    'validator.manage': row((ctx) => withFee(ctx, [{ account: R(ctx), domains: ['validator.status', 'staking.ledger'] }]),
        ['validator.status', 'staking.ledger'], 'predicate', { later: later('nextEra') }),
    // A first approval changes only the pending list; an executed call also changes what the inner action
    // changes, for the multisig address (design row 30; `inner` arrives with R5).
    'multisig.transaction': row((ctx) => {
        const ms = (ctx.params && ctx.params.multisig) || S(ctx);
        const inner = ctx.params && ctx.params.inner;
        const list = [{ account: ms, domains: ['multisig.pending'] }];
        if (ctx.outcome && ctx.outcome.executed === 'ok' && inner && EFFECTS[inner.key] && inner.key !== 'multisig.transaction') {
            const sub = EFFECTS[inner.key].accounts({ ...ctx, signer: ms, params: inner.params || {} });
            for (const c of sub) list.push({ account: c.account, domains: [...c.domains] });
        }
        return list;
    }, ['multisig.pending'], 'events')
});

const INCLUDED = new Set(['inBlock', 'unconfirmed']);

export function effectsFor(ctx = {}) {
    const entry = EFFECTS[ctx.key];
    if (!entry) return null;
    if (!INCLUDED.has(ctx.stage)) return null;
    if (!ctx.outcome || ctx.outcome.ok === false) return null;
    if (!Array.isArray(ctx.events)) return null;
    return {
        changes: entry.accounts(ctx).map(c => ({ account: c.account == null ? null : c.account, domains: [...c.domains] })),
        known: entry.known(ctx),
        later: entry.later(ctx)
    };
}
