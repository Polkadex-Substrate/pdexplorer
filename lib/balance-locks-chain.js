// The chain reads behind GET /api/account/:address/locks, turned into the
// plain snapshot lib/balance-locks.js describes (amounts as decimal strings).
// One call per account; the reads run in parallel. Tested in
// test/balance-locks.test.js, against a hand-built api and against real spec
// 392 codecs.
//
// The balance and the four balances stores are required: if one fails the
// request fails, because a breakdown without them would be wrong. The reads
// that only explain a row (democracy, elections, identity, proxy) degrade to
// null, and their PDEX then shows as "Other deposits" or without detail.
// A pallet the runtime does not have is skipped.

import { lockIdText } from './balance-locks.js';
import { slashingSpanCount } from './lock-actions.js';

const str = (x) => { try { return x == null ? '0' : BigInt(String(x.toString()).replace(/,/g, '')).toString(); } catch (_) { return '0'; } };
const num = (x) => { const n = Number(x == null ? NaN : x.toString()); return Number.isFinite(n) ? n : 0; };
const fn = (obj, name) => (obj && typeof obj[name] === 'function' ? obj[name] : null);
const soft = (p) => Promise.resolve(p).then((v) => v, () => null);
const some = (o) => (o && o.isSome ? o.unwrap() : null);
const variant = (e) => (e && typeof e.type === 'string' ? e.type : (e == null ? '' : String(e)));
const same = (who, address) => (who && typeof who.eq === 'function' ? who.eq(address) : String(who) === String(address));
const MAX_REFERENDA = 100;

function holdId(id) {
    if (id && typeof id.type === 'string') {
        const inner = id.value && typeof id.value.type === 'string' ? id.value.type : '';
        return inner ? `${id.type}.${inner}` : id.type;
    }
    try { return JSON.stringify(id && id.toJSON ? id.toJSON() : id); } catch (_) { return String(id); }
}

async function readDemocracy(q, address) {
    const votingOf = fn(q.democracy, 'votingOf');
    if (!votingOf) return null;
    const v = await votingOf(address);
    if (!v) return null;
    if (v.isDelegating) {
        const d = v.asDelegating;
        return { delegating: true, target: String(d.target), conviction: variant(d.conviction), balance: str(d.balance),
            prior: { until: num(d.prior && d.prior[0]), amount: str(d.prior && d.prior[1]) } };
    }
    if (!v.isDirect) return null;
    const d = v.asDirect;
    const votes = Array.from(d.votes || []).slice(0, MAX_REFERENDA).map(([i, av]) => {
        const index = num(i);
        if (av && av.isStandard) {
            const s = av.asStandard;
            return { index, aye: !!s.vote.isAye, conviction: variant(s.vote.conviction), balance: str(s.balance) };
        }
        if (av && av.isSplit) return { index, aye: null, conviction: 'None', balance: str(av.asSplit.aye.toBigInt() + av.asSplit.nay.toBigInt()) };
        if (av && av.isSplitAbstain) { const x = av.asSplitAbstain; return { index, aye: null, conviction: 'None', balance: str(x.aye.toBigInt() + x.nay.toBigInt() + x.abstain.toBigInt()) }; }
        return { index, aye: null, conviction: 'None', balance: '0' };
    });
    const referenda = {};
    const info = fn(q.democracy, 'referendumInfoOf');
    if (info && votes.length) {
        const idx = votes.map(x => x.index);
        const all = typeof info.multi === 'function' ? await info.multi(idx) : await Promise.all(idx.map(i => info(i)));
        all.forEach((o, k) => {
            const r = some(o);
            // No info: the referendum was cancelled (or never existed); removeVote takes it with no lock.
            if (!r) { referenda[idx[k]] = { cancelled: true }; return; }
            if (r.isOngoing) referenda[idx[k]] = { ongoing: true, end: num(r.asOngoing.end) };
            else if (r.isFinished) referenda[idx[k]] = { finished: true, approved: !!r.asFinished.approved.valueOf(), end: num(r.asFinished.end) };
        });
    }
    return { delegating: false, votes, prior: { until: num(d.prior && d.prior[0]), amount: str(d.prior && d.prior[1]) }, referenda };
}

async function readElections(q, address) {
    const sec = ['elections', 'phragmenElection', 'electionsPhragmen'].find(n => fn(q[n], 'voting'));
    if (!sec) return null;
    const e = q[sec];
    const [voting, candidates, members, runnersUp] = await Promise.all([
        e.voting(address), fn(e, 'candidates') ? e.candidates() : [], fn(e, 'members') ? e.members() : [], fn(e, 'runnersUp') ? e.runnersUp() : []
    ]);
    const votes = voting && voting.votes ? Array.from(voting.votes).length : 0;
    const voter = voting && (votes || num(voting.stake) || num(voting.deposit)) ? { votes, stake: str(voting.stake), deposit: str(voting.deposit) } : null;
    let candidacy = null;
    const cand = Array.from(candidates || []).find(c => same(c[0], address));
    if (cand) candidacy = { role: 'Candidate', deposit: str(cand[1]) };
    const seat = (list, role) => {
        const h = Array.from(list || []).find(x => same(x.who, address));
        if (h && !candidacy) candidacy = { role, deposit: str(h.deposit) };
    };
    seat(members, 'Member');
    seat(runnersUp, 'RunnerUp');
    return { voter, candidacy };
}

async function readIdentity(q, address) {
    if (!fn(q.identity, 'identityOf')) return null;
    const [reg, subs] = await Promise.all([q.identity.identityOf(address), fn(q.identity, 'subsOf') ? q.identity.subsOf(address) : null]);
    let r = some(reg);
    if (r && Array.isArray(r) && !r.deposit) r = r[0];   // newer runtimes: (Registration, Option<Username>)
    return { deposit: str(r && r.deposit), subsDeposit: str(subs && subs[0]), subs: subs && subs[1] ? Array.from(subs[1]).length : 0 };
}

async function readProxy(q, address) {
    if (!fn(q.proxy, 'proxies')) return null;
    const [p, a] = await Promise.all([q.proxy.proxies(address), fn(q.proxy, 'announcements') ? q.proxy.announcements(address) : null]);
    return { deposit: str(p && p[1]), count: p && p[0] ? Array.from(p[0]).length : 0, announcementDeposit: str(a && a[1]) };
}

// CurrentEra decides what withdrawUnbonded frees; ActiveEra and its start
// date the chunks still unbonding. Each read degrades to null.
async function readEras(q) {
    const [cur, act] = await Promise.all([
        fn(q.staking, 'currentEra') ? soft(q.staking.currentEra()) : null,
        fn(q.staking, 'activeEra') ? soft(q.staking.activeEra()) : null
    ]);
    const c = some(cur), a = some(act);
    const start = a && a.start ? some(a.start) : null;
    return { current: c == null ? null : num(c), active: a ? num(a.index) : null, start: start == null ? null : num(start) };
}

export async function readAccountLocks(api, address) {
    const q = api.query, c = api.consts || {};
    const b = q.balances || {};
    const list = (name) => (fn(b, name) ? b[name](address) : []);
    const [account, locks, freezes, holds, reserves, bondedOpt, ownLedger, number, democracy, elections, identity, proxy] = await Promise.all([
        q.system.account(address), list('locks'), list('freezes'), list('holds'), list('reserves'),
        fn(q.staking, 'bonded') ? q.staking.bonded(address) : null,
        fn(q.staking, 'ledger') ? q.staking.ledger(address) : null,
        fn(q.system, 'number') ? soft(q.system.number()) : null,
        soft(readDemocracy(q, address)), soft(readElections(q, address)), soft(readIdentity(q, address)), soft(readProxy(q, address))
    ]);
    // Ledger is keyed by controller; since the controller deprecation that is the stash itself.
    const controller = some(bondedOpt);
    let ledger = some(ownLedger);
    if (!ledger && controller && !same(controller, address) && fn(q.staking, 'ledger')) ledger = some(await q.staking.ledger(controller));
    const stash = ledger && ledger.stash ? String(ledger.stash) : (controller || ledger ? address : null);
    const era = ledger ? await readEras(q) : null;
    const d = account.data;
    const frozen = d.frozen != null ? str(d.frozen) : (BigInt(str(d.miscFrozen)) > BigInt(str(d.feeFrozen)) ? str(d.miscFrozen) : str(d.feeFrozen));
    const unlocking = ledger ? Array.from(ledger.unlocking || []).reduce((a, u) => a + BigInt(str(u.value)), 0n).toString() : '0';

    const k = (sec, name) => num(c[sec] && c[sec][name]);
    const blockMs = k('babe', 'expectedBlockTime');
    const eraMs = k('staking', 'sessionsPerEra') * k('babe', 'epochDuration') * blockMs;
    const bonding = k('staking', 'bondingDuration');
    const tx = api.tx || {};

    return {
        address: String(address), now: Date.now(), eraMs: eraMs || null,
        free: str(d.free), reserved: str(d.reserved), frozen, ed: str(c.balances && c.balances.existentialDeposit),
        block: number == null ? null : num(number), blockMs: blockMs || null,
        bondingDays: bonding && eraMs ? Math.round((bonding * eraMs) / 86400000 * 10) / 10 : null,
        locks: Array.from(locks || []).map(l => ({ id: lockIdText(l.id), amount: str(l.amount), reasons: variant(l.reasons) })),
        freezes: Array.from(freezes || []).map(f => ({ id: holdId(f.id), amount: str(f.amount) })),
        holds: Array.from(holds || []).map(h => ({ id: holdId(h.id), amount: str(h.amount) })),
        reserves: Array.from(reserves || []).map(r => ({ id: lockIdText(r.id), amount: str(r.amount) })),
        staking: { bonded: !!(ledger || controller), total: str(ledger && ledger.total), active: str(ledger && ledger.active), unlocking,
            chunks: ledger ? Array.from(ledger.unlocking || []).map(u => ({ value: str(u.value), era: num(u.era) })) : [],
            currentEra: era ? era.current : null, activeEra: era ? era.active : null, activeEraStart: era ? era.start : null,
            spans: ledger && stash && fn(q.staking, 'slashingSpans') ? slashingSpanCount(await soft(q.staking.slashingSpans(stash))) : 0,
            controller: controller ? String(controller) : (ledger ? String(address) : null), stash },
        democracy: democracy ? { ...democracy, lockingPeriod: k('democracy', 'voteLockingPeriod') } : null,
        elections, identity, proxy,
        pallets: { vesting: !!fn(tx.vesting, 'vest'), ormlVesting: !!tx.ormlVesting }
    };
}
