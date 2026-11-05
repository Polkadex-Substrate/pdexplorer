// Locked, reserved and transferable PDEX, and why each part is locked.
// Pure: no chain access, no DOM. lib/balance-locks-chain.js reads the chain
// into the snapshot this takes; lib/balance-locks-view.js renders the model it
// returns. Tested in test/balance-locks.test.js.
//
// The breakdown (pallet-balances, spec 392):
//   Total        = free + reserved
//   Locked       = frozen (the largest lock or freeze; locks OVERLAP, they
//                  do not add up)
//   Reserved     = reserved (holds, named reserves and plain deposits)
//   Transferable = free - max(frozen - reserved, ED), never below zero.
// Transferable is the fungible "reducible balance" for a keep-alive transfer,
// the same rule lib/fee-preflight.js applies to the transfer amount, so the
// figure shown here is exactly the most the Send dialog will accept (before
// the fee). Reserved PDEX counts toward a freeze, which is why frozen is
// reduced by reserved first.
//
// Lock ids are 8 bytes. The ones this runtime family has used:
//   "staking "  pallet-staking (legacy lock; 392 stakes with a hold instead)
//   "democrac"  democracy votes
//   "phrelect"  council election votes (elections-phragmen PalletId)
//   "vesting "  pallet-vesting (not in the 392 runtime)
//   "ormlvest"  orml-vesting (removed at 392; its migration cleared the locks)
//   "pdexlock"  pdex-migration (removed at 392)
//   "REWARDID"  pallet-rewards (removed at 392)

import { formatPlanck } from './tx-status.js';

export const LOCK_HELP_SLUG = 'locked-balance';
const HELP = `/help/${LOCK_HELP_SLUG}`;

export function toBig(x) {
    if (x == null) return 0n;
    if (typeof x === 'bigint') return x;
    try { return BigInt(String(x.toString ? x.toString() : x).replace(/,/g, '')); } catch (_) { return 0n; }
}
const sat = (a, b) => (a > b ? a - b : 0n);
const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);
const pdex = (v) => `${formatPlanck(toBig(v).toString())} PDEX`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function balanceBreakdown({ free, reserved, frozen, ed }) {
    const fr = toBig(free), res = toBig(reserved), fz = toBig(frozen), ex = toBig(ed);
    const untouchable = sat(fz, res);
    const keep = max(untouchable, ex);
    return {
        total: fr + res, free: fr, reserved: res, frozen: fz, ed: ex, locked: fz,
        transferable: sat(fr, keep),
        // The part of free kept back only by the existential deposit, beyond what the locks already keep.
        edWithheld: ex > untouchable ? sat(min(fr, ex), untouchable) : 0n
    };
}

// A lock or reserve id as text: 8 printable ASCII bytes as a string, else hex.
export function lockIdText(id) {
    if (id == null) return '';
    let bytes = null;
    if (typeof id === 'string') {
        if (!/^0x[0-9a-f]*$/i.test(id)) return id;
        bytes = (id.slice(2).match(/../g) || []).map(h => parseInt(h, 16));
    } else if (typeof id.toU8a === 'function') {
        bytes = Array.from(id.toU8a());
    } else {
        bytes = Array.from(id);
    }
    if (bytes.length && bytes.every(b => b >= 0x20 && b < 0x7f)) return String.fromCharCode(...bytes);
    return '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function blocksToDays(blocks, blockMs) {
    const b = Number(blocks), ms = Number(blockMs);
    if (!(b > 0) || !(ms > 0)) return 0;
    return Math.round((b * ms) / 86400000 * 10) / 10;
}
const daysText = (d) => (d >= 1 ? `about ${d} days` : 'under a day');

// Lock periods per conviction (democracy pallet): 0, 1, 2, 4, 8, 16, 32.
const LOCK_PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };

// When the democracy lock can come off. A vote locks until its referendum
// ends; a Standard vote on the winning side with conviction stays locked for
// periods x VoteLockingPeriod after that. prior is a lock kept from a vote
// already removed.
export function democracyLockPlan(dem, block) {
    const now = Number(block) || 0;
    const prior = Number(dem && dem.prior && dem.prior.until) || 0;
    if (!dem) return { mode: 'none', refs: [], unlockAt: 0, ongoing: false, canUnlockNow: false };
    if (dem.delegating) {
        return { mode: 'delegating', refs: [], target: dem.target, conviction: dem.conviction, unlockAt: prior, ongoing: false, canUnlockNow: false };
    }
    const period = Number(dem.lockingPeriod) || 0;
    let unlockAt = prior, ongoing = false;
    const refs = (dem.votes || []).map(v => {
        const info = (dem.referenda || {})[v.index] || null;
        const r = { index: v.index, aye: v.aye, conviction: v.conviction, balance: v.balance, state: 'unknown', end: null, unlockAt: null };
        if (info && info.ongoing) { r.state = 'ongoing'; r.end = info.end; ongoing = true; }
        else if (info && info.finished) {
            r.state = 'finished'; r.end = info.end;
            const won = v.aye === undefined || v.aye === null ? false : (info.approved ? v.aye : !v.aye);
            const periods = won ? (LOCK_PERIODS[v.conviction] || 0) : 0;
            r.unlockAt = Number(info.end) + periods * period;
            unlockAt = Math.max(unlockAt, r.unlockAt);
        }
        return r;
    });
    const unknown = refs.some(r => r.state === 'unknown');
    return { mode: 'direct', refs, unlockAt, ongoing, canUnlockNow: !ongoing && !unknown && unlockAt <= now };
}

function democracyRow(row, snap) {
    const plan = democracyLockPlan(snap.democracy, snap.block);
    const ms = snap.blockMs;
    const steps = 'remove each vote with democracy.removeVote(referendum), then call democracy.unlock(your address) from your wallet app';
    row.source = 'Democracy vote';
    row.reason = 'Democracy vote lock. PDEX you voted with stays locked while the referendum runs, and for longer if you voted with conviction and your side won.';
    if (plan.mode === 'delegating') {
        row.reason = `Democracy delegation lock. Your votes are delegated at ${plan.conviction || 'a conviction'}; the delegated PDEX stays locked.`;
        row.unlock = 'Call democracy.undelegate, wait the conviction period, then call democracy.unlock(your address).';
    } else if (plan.mode === 'none') {
        row.unlock = `Once the lock period is over, ${steps}.`;
    } else if (plan.canUnlockNow && snap.block != null) {
        row.unlock = plan.refs.length ? `The lock period is over: ${steps}.` : 'The lock period is over: call democracy.unlock(your address) from your wallet app.';
    } else if (plan.ongoing) {
        row.unlock = `Wait for the referendum to end (or remove the vote now with democracy.removeVote to cancel it). Then ${steps}.`;
    } else if (snap.block != null && plan.unlockAt > Number(snap.block)) {
        row.unlock = `Locked until block ${plan.unlockAt} (${daysText(blocksToDays(plan.unlockAt - Number(snap.block), ms))}). After that, ${steps}.`;
    } else {
        row.unlock = `Once the lock period is over, ${steps}.`;
    }
    row.refs = plan.refs.map(r => ({
        index: r.index,
        href: `/democracy/referendum/${encodeURIComponent(String(r.index))}`,
        text: r.state === 'ongoing' ? `#${r.index}: running, ends at block ${r.end}`
            : r.state === 'finished' ? (r.unlockAt > Number(snap.block) ? `#${r.index}: ended; locked until block ${r.unlockAt}` : `#${r.index}: ended; no further lock`)
            : `#${r.index}`
    }));
    return row;
}

const LEGACY = { ormlvest: 'ORML vesting', pdexlock: 'PDEX migration', pdexmigr: 'PDEX migration', REWARDID: 'Rewards' };
const CONTACT = 'Contact the Polkadex team and mention the lock id.';

function stakedText(snap) {
    const st = snap.staking || {};
    const days = snap.bondingDays ? `the unbonding period (${snap.bondingDays} days)` : 'the unbonding period';
    const unbonding = toBig(st.unlocking) > 0n ? ` ${pdex(st.unlocking)} is already unbonding.` : '';
    return {
        reason: `Staked (bonded) PDEX${toBig(st.total) > 0n ? `: ${pdex(st.total)} bonded` : ''}. Staked PDEX earns rewards and cannot be sent.`,
        unlock: `Unstake (wallet dashboard, Unstake), wait ${days}, then withdraw it (Withdraw unbonded).${unbonding}`,
        link: { href: '/help/unstaking', text: 'Unstaking' }
    };
}

function lockRow(lock, snap) {
    const id = lockIdText(lock.id);
    const row = { kind: 'lock', id, amount: toBig(lock.amount).toString(), reasons: lock.reasons || '', status: 'active', source: '', reason: '', unlock: '' };
    const bonded = !!(snap.staking && snap.staking.bonded);
    if (id === 'staking ') {
        if (bonded) return { ...row, source: 'Staking', ...stakedText(snap) };
        return { ...row, status: 'orphan', source: 'Staking (leftover lock)',
            reason: 'Leftover staking lock from before the 392 upgrade. This account has nothing staked (no bond and nothing unbonding), but the old staking lock was not removed when it fully unbonded.',
            unlock: 'It cannot be removed by you today; the team is preparing a fix. The PDEX still belongs to this account and counts in its total.',
            link: { href: HELP, text: 'About leftover staking locks' } };
    }
    if (id === 'democrac') return democracyRow(row, snap);
    if (id === 'phrelect') {
        const v = snap.elections && snap.elections.voter;
        return { ...row, source: 'Council election vote',
            reason: v && v.votes ? `Council election vote: you back ${plural(v.votes, 'candidate', 'candidates')} with ${pdex(v.stake)}. That PDEX stays locked while the vote stands.`
                : 'Council election vote. The PDEX backing your council vote stays locked while the vote stands.',
            unlock: 'Remove your council vote with elections.removeVoter from your wallet app. The lock and the voting deposit are released at once.' };
    }
    if (id === 'vesting ') {
        if (snap.pallets && snap.pallets.vesting) {
            return { ...row, source: 'Vesting', reason: 'Vesting schedule: PDEX that unlocks gradually over time.',
                unlock: 'Call vesting.vest() from your wallet app as it unlocks; each call releases what has vested so far.' };
        }
        return { ...row, status: 'legacy', source: 'Vesting (legacy)',
            reason: 'Vesting lock. The runtime since the 392 upgrade has no vesting module, so this lock cannot be released with vest().',
            unlock: `You cannot remove it yourself. ${CONTACT}`, link: { href: HELP, text: 'About legacy locks' } };
    }
    if (LEGACY[id]) {
        const name = LEGACY[id];
        return { ...row, status: 'legacy', source: `${name} (legacy)`,
            reason: `${name} lock. The ${name} module was removed from the runtime at the 392 upgrade, and its locks should have been released then; this one is still present.`,
            unlock: `No call releases it, so you cannot remove it yourself. ${CONTACT}`, link: { href: HELP, text: 'About legacy locks' } };
    }
    return { ...row, status: 'unknown', source: 'Unknown lock',
        reason: `Lock id "${id}" is not one the explorer recognises.`,
        unlock: `Only the module that set it can release it. ${CONTACT}` };
}

const HOLDS = {
    'Preimage.Preimage': { source: 'Preimage deposit', reason: 'Deposit for storing a proposal\'s call data (a preimage) on chain.',
        unlock: 'Released when the preimage is removed with preimage.unnotePreimage: by you if it is unused, or after the proposal that uses it is enacted or dropped.' },
    'Council.ProposalSubmission': { source: 'Council motion deposit', reason: 'Deposit for submitting a council motion.',
        unlock: 'Released after the motion is closed or disapproved, with council.releaseProposalCost(motion hash).' },
    'TechnicalCommittee.ProposalSubmission': { source: 'Technical committee motion deposit', reason: 'Deposit for submitting a technical committee motion.',
        unlock: 'Released after the motion is closed or disapproved, with technicalCommittee.releaseProposalCost(motion hash).' },
    'Session.Keys': { source: 'Session keys deposit', reason: 'Deposit for registering validator session keys.', unlock: 'Released by session.purgeKeys.' },
    'DelegatedStaking.StakingDelegation': { source: 'Delegated staking', reason: 'PDEX delegated to a staking agent.',
        unlock: 'Withdraw from the agent you delegated to; it is released after the unbonding period.' },
    'SafeMode.EnterOrExtend': { source: 'Safe mode deposit', reason: 'Deposit for entering or extending safe mode.',
        unlock: 'Released (or slashed) by governance after safe mode ends.' }
};

function holdRow(hold, snap) {
    const id = String(hold.id || '');
    const row = { kind: 'hold', id, amount: toBig(hold.amount).toString(), status: 'active' };
    if (id === 'Staking.Staking') {
        if (snap.staking && snap.staking.bonded) return { ...row, source: 'Staking (hold)', ...stakedText(snap) };
        return { ...row, status: 'orphan', source: 'Staking (hold)', reason: 'Staking hold, but this account has no staking ledger.',
            unlock: 'It cannot be released by you today. Contact the Polkadex team.', link: { href: HELP, text: 'About locks and holds' } };
    }
    if (HOLDS[id]) return { ...row, ...HOLDS[id] };
    return { ...row, status: 'unknown', source: 'Unknown hold', reason: `Hold "${id}" is not one the explorer recognises.`,
        unlock: 'Only the module that placed it can release it.' };
}

function depositRows(snap) {
    const rows = [];
    const add = (amount, source, reason, unlock, link) => {
        if (toBig(amount) > 0n) rows.push({ kind: 'deposit', id: '', amount: toBig(amount).toString(), status: 'active', source, reason, unlock, ...(link ? { link } : {}) });
    };
    const idn = snap.identity;
    if (idn) {
        add(idn.deposit, 'Identity deposit', 'Refundable deposit for your on-chain identity.',
            'Released when you clear your identity (identity.clearIdentity).', { href: '/help/identity', text: 'On-chain identity' });
        add(idn.subsDeposit, 'Sub-identity deposit', `Deposit for ${plural(Number(idn.subs) || 0, 'sub-account', 'sub-accounts')}.`,
            'Released when you remove the sub-accounts (identity.removeSub, or identity.setSubs with an empty list).');
    }
    const px = snap.proxy;
    if (px) {
        add(px.deposit, 'Proxy deposit', `Deposit for ${plural(Number(px.count) || 0, 'proxy', 'proxies')}.`,
            'Released when you remove the proxies (account page, Proxies).', { href: '/help/proxies-and-multisig', text: 'Proxies' });
        add(px.announcementDeposit, 'Proxy announcement deposit', 'Deposit for announced proxy calls.',
            'Released when the announced call is executed or the announcement is removed.');
    }
    const el = snap.elections;
    if (el && el.voter) {
        add(el.voter.deposit, 'Council voting deposit', 'Deposit for having a council vote on record.',
            'Released by removing your council vote (elections.removeVoter).');
    }
    if (el && el.candidacy) {
        const c = el.candidacy;
        if (c.role === 'Candidate') {
            add(c.deposit, 'Council candidacy bond', 'Bond for standing as a council candidate.',
                'Released when you withdraw your candidacy on the Council page before the election. A candidate who loses the election loses this bond.', { href: '/council', text: 'Council' });
        } else {
            add(c.deposit, `Council ${c.role === 'Member' ? 'member' : 'runner-up'} bond`, `Bond held while you are a council ${c.role === 'Member' ? 'member' : 'runner-up'}.`,
                'Released when you renounce on the Council page, or when you leave the council and runner-up list at an election.', { href: '/council', text: 'Council' });
        }
    }
    return rows;
}

export function describeAccountLocks(snap) {
    const b = balanceBreakdown(snap);
    const locks = snap.locks || [], freezes = snap.freezes || [], holds = snap.holds || [], reserves = snap.reserves || [];
    const items = [];
    for (const l of locks) items.push(lockRow(l, snap));
    for (const f of freezes) {
        const id = String(f.id || '');
        items.push({ kind: 'freeze', id, amount: toBig(f.amount).toString(), status: 'unknown', source: 'Freeze',
            reason: `Freeze "${id}" placed by a module.`, unlock: 'Only the module that placed it can release it.' });
    }
    for (const h of holds) items.push(holdRow(h, snap));
    for (const r of reserves) {
        const id = lockIdText(r.id);
        items.push({ kind: 'reserve', id, amount: toBig(r.amount).toString(), status: 'unknown', source: 'Named reserve',
            reason: `Reserved under id "${id}".`, unlock: 'Released by the module that reserved it.' });
    }
    const deposits = depositRows(snap);
    items.push(...deposits);
    const attributed = [...holds, ...reserves, ...deposits].reduce((a, x) => a + toBig(x.amount), 0n);
    const unattributed = sat(b.reserved, attributed);
    if (unattributed > 0n) {
        items.push({ kind: 'deposit', id: '', amount: unattributed.toString(), status: 'unknown', source: 'Other deposits',
            reason: 'Reserved PDEX the explorer could not attribute: for example a multisig deposit (returned when the call executes or is cancelled), a democracy proposal deposit (returned when it becomes a referendum), or a treasury or bounty bond.',
            unlock: 'Released by the action that created it.' });
    }
    const str = (v) => v.toString();
    return {
        balance: { total: str(b.total), transferable: str(b.transferable), locked: str(b.locked), reserved: str(b.reserved),
            free: str(b.free), frozen: str(b.frozen), ed: str(b.ed), edWithheld: str(b.edWithheld) },
        items,
        overlap: locks.length + freezes.length >= 2,
        orphanStaking: items.some(i => i.status === 'orphan'),
        unattributedReserved: unattributed.toString(),
        block: snap.block ?? null,
        bondingDays: snap.bondingDays ?? null
    };
}
