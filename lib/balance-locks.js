// Locked, reserved and transferable PDEX, and why each part is locked.
// Pure: no chain access, no DOM. lib/balance-locks-chain.js reads the chain
// into the snapshot this takes; lib/balance-locks-view.js renders the model it
// returns. Tested in test/balance-locks.test.js.
//
// The breakdown (pallet-balances 46, spec 393):
//   Total        = free + reserved
//   Locked       = frozen (the largest lock or freeze; locks OVERLAP, they
//                  do not add up)
//   Reserved     = reserved (holds, named reserves and plain deposits)
//   Transferable = free - max(frozen - reserved, ED), never below zero,
//                  and 0 when no fee can be paid.
//   transferableAllowDeath: the same with Keep alive off. The ED drops out
//                  only when nothing is locked or reserved (an account with a
//                  lock or a hold cannot be reaped): fee-preflight transferKeep.
// Transferable is the fungible "reducible balance" for a keep-alive transfer,
// the same rule lib/fee-preflight.js applies to the transfer amount, so the
// figure shown here is exactly the most the Send dialog will accept (before
// the fee). Reserved PDEX counts toward a freeze, which is why frozen is
// reduced by reserved first. The fee follows the same rule (spec 393:
// FungibleAdapter, fungible withdraw with Preserve and Polite), so a hold
// larger than a vote lock leaves free above the ED payable. When free does
// not cover max(frozen - reserved, ED) plus FEE_MARGIN, Transferable is 0 and
// the model says how much to top up (feeTopUp: feeShortfall with FEE_MARGIN).
// "Can pay a fee" means FEE_MARGIN, the fee Max keeps back, not any fee: a
// Transferable the fee preflight would then refuse is never shown.
// Both checks come from lib/fee-preflight.js (feeFloor, feeShortfall).
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
import { lockActions } from './lock-actions.js';
import { feeShortfall, transferKeep, FEE_MARGIN } from './fee-preflight.js';

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

// system.account's data as plain planck: frozen, or (before the freeze
// rework) the larger of miscFrozen and feeFrozen. The wallet route in
// server.js passes it straight to balanceBreakdown.
export function accountBalances(data, ed) {
    const d = data || {};
    const frozen = d.frozen != null ? toBig(d.frozen) : max(toBig(d.miscFrozen), toBig(d.feeFrozen));
    return { free: toBig(d.free), reserved: toBig(d.reserved), frozen, ed: toBig(ed) };
}

export function balanceBreakdown({ free, reserved, frozen, ed }) {
    const fr = toBig(free), res = toBig(reserved), fz = toBig(frozen), ex = toBig(ed);
    const untouchable = sat(fz, res);
    const keep = (keepAlive) => transferKeep({ frozen: fz, reserved: res, ed: ex, keepAlive });
    // The same margin as Max and the top-up.
    const short = feeShortfall({ fee: FEE_MARGIN, free: fr, reserved: res, frozen: fz, ed: ex });
    const canPayFee = short === null;
    return {
        total: fr + res, free: fr, reserved: res, frozen: fz, ed: ex, locked: fz,
        transferable: canPayFee ? sat(fr, keep(true)) : 0n,
        transferableAllowDeath: canPayFee ? sat(fr, keep(false)) : 0n,
        canPayFee, feeTopUp: short ? short.topUp : null,
        // The part of free kept back only by the existential deposit, beyond what the locks already keep.
        edWithheld: ex > untouchable ? sat(min(fr, ex), untouchable) : 0n
    };
}

// The Send dialog's figure in PDEX, from the wallet route (server.js): the
// keep-alive Transferable, or with Keep alive off the transferAllowDeath one.
// A server without either: free less staked, as script.js always did.
export function sendableBalance(data, keepAlive = true) {
    const b = (data && data.balance) || {};
    if (!keepAlive && typeof b.transferableAllowDeath === 'number') return Math.max(0, b.transferableAllowDeath);
    if (typeof b.transferable === 'number') return Math.max(0, b.transferable);
    const staked = Number((data && data.staking && data.staking.totalStaked) || 0);
    return Math.max(0, Number(b.free || 0) - staked);
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
export const LOCK_PERIODS = { None: 0, Locked1x: 1, Locked2x: 2, Locked3x: 4, Locked4x: 8, Locked5x: 16, Locked6x: 32 };

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

// The button the panel shows: Remove votes and unlock while votes are recorded, else Unlock.
const STEPS = {
    remove: 'press Remove votes and unlock (democracy.removeVote for each finished referendum, then democracy.unlock for your address)',
    unlock: 'press Unlock (democracy.unlock for your address)'
};

// d: the democracy release (lib/lock-actions.js), for the prior lock's amount.
function democracyRow(row, snap, d) {
    const plan = democracyLockPlan(snap.democracy, snap.block);
    const ms = snap.blockMs;
    const steps = plan.mode === 'direct' && !plan.refs.length ? STEPS.unlock : STEPS.remove;
    row.source = 'Democracy vote';
    row.reason = 'Democracy vote lock. PDEX you voted with stays locked while the referendum runs, and for longer if you voted with conviction and your side won.';
    if (plan.mode === 'delegating') {
        row.reason = `Democracy delegation lock. Your votes are delegated at ${plan.conviction || 'a conviction'}; the delegated PDEX stays locked.`;
        row.unlock = 'Press Undelegate (democracy.undelegate), wait the conviction period, then unlock (democracy.unlock).';
    } else if (plan.mode === 'none') {
        row.unlock = `Once the lock period is over, ${steps}.`;
    } else if (plan.canUnlockNow && snap.block != null) {
        row.unlock = `The lock period is over: ${steps}.`;
    } else if (plan.ongoing) {
        row.unlock = `Wait for the referendum to end (or remove the vote now with democracy.removeVote to cancel it). Then ${steps}.`;
    } else if (snap.block != null && plan.unlockAt > Number(snap.block)) {
        // Only the prior lock waits for its end; an unlock frees the rest now.
        const held = `${pdex(d && d.lockedUntil ? d.lockedUntilAmount : row.amount)} stays locked until block ${plan.unlockAt} (${daysText(blocksToDays(plan.unlockAt - Number(snap.block), ms))})`;
        row.unlock = d && d.unlock ? `${held}; the rest can be unlocked now: ${steps}.` : `${held}. After that, ${steps}.`;
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

export const utcDay = (ms) => (ms != null && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString().slice(0, 10) : null);
// Chunks still unbonding, each with its era and estimated day (lib/lock-actions.js unbondingSchedule).
export const pendingText = (pending) => (pending || []).map(c => `${pdex(c.value)} from era ${c.era}${utcDay(c.eta) ? `, about ${utcDay(c.eta)}` : ''}`).join('; ');

// w: the withdraw release. Ready chunks can be withdrawn now; the rest say when.
function stakedText(snap, w) {
    const st = snap.staking || {};
    const days = snap.bondingDays ? `the unbonding period (${snap.bondingDays} days)` : 'the unbonding period';
    const ready = w && toBig(w.withdrawable) > 0n ? ` ${pdex(w.withdrawable)} is ready to withdraw now.` : '';
    const pending = w && w.pending.length ? ` Still unbonding: ${pendingText(w.pending)}.` : '';
    return {
        reason: `Staked (bonded) PDEX${toBig(st.total) > 0n ? `: ${pdex(st.total)} bonded` : ''}. Staked PDEX earns rewards and cannot be sent.`,
        unlock: `Unstake (wallet dashboard, Unstake), wait ${days}, then withdraw it (Withdraw unbonded).${ready}${pending}`,
        link: { href: '/help/unstaking', text: 'Unstaking' }
    };
}

function lockRow(lock, snap, actions) {
    const id = lockIdText(lock.id);
    const row = { kind: 'lock', id, amount: toBig(lock.amount).toString(), reasons: lock.reasons || '', status: 'active', source: '', reason: '', unlock: '' };
    const bonded = !!(snap.staking && snap.staking.bonded);
    if (id === 'staking ') {
        if (bonded) return { ...row, source: 'Staking', ...stakedText(snap, actions.withdraw) };
        return { ...row, status: 'orphan', source: 'Staking (leftover lock)',
            reason: 'Leftover staking lock from before the runtime upgrade that moved staking to holds. This account has nothing staked (no bond and nothing unbonding), but the old staking lock was not removed when it fully unbonded.',
            unlock: 'Press Remove leftover staking lock (staking.migrateCurrency for this account). Any account can submit it, not only this one; the fee is charged upfront and refunded when it succeeds. The PDEX still belongs to this account and counts in its total.',
            link: { href: HELP, text: 'About leftover staking locks' } };
    }
    if (id === 'democrac') return democracyRow(row, snap, actions.democracy);
    if (id === 'phrelect') {
        const v = snap.elections && snap.elections.voter;
        return { ...row, source: 'Council election vote',
            reason: v && v.votes ? `Council election vote: you back ${plural(v.votes, 'candidate', 'candidates')} with ${pdex(v.stake)}. That PDEX stays locked while the vote stands.`
                : 'Council election vote. The PDEX backing your council vote stays locked while the vote stands.',
            unlock: 'Press Remove council vote (elections.removeVoter). The lock and the voting deposit are released at once.' };
    }
    if (id === 'vesting ') {
        if (snap.pallets && snap.pallets.vesting) {
            return { ...row, source: 'Vesting', reason: 'Vesting schedule: PDEX that unlocks gradually over time.',
                unlock: 'Call vesting.vest() from your wallet app as it unlocks; each call releases what has vested so far.' };
        }
        return { ...row, status: 'legacy', source: 'Vesting (legacy)',
            reason: 'Vesting lock. The current runtime has no vesting module, so this lock cannot be released with vest().',
            unlock: `You cannot remove it yourself. ${CONTACT}`, link: { href: HELP, text: 'About legacy locks' } };
    }
    if (LEGACY[id]) {
        const name = LEGACY[id];
        return { ...row, status: 'legacy', source: `${name} (legacy)`,
            reason: `${name} lock. The ${name} module was removed from the runtime in an earlier runtime upgrade, and its locks should have been released then; this one is still present.`,
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

function holdRow(hold, snap, actions) {
    const id = String(hold.id || '');
    const row = { kind: 'hold', id, amount: toBig(hold.amount).toString(), status: 'active' };
    if (id === 'Staking.Staking') {
        if (snap.staking && snap.staking.bonded) return { ...row, source: 'Staking (hold)', ...stakedText(snap, actions.withdraw) };
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
    const actions = lockActions(snap);
    const locks = snap.locks || [], freezes = snap.freezes || [], holds = snap.holds || [], reserves = snap.reserves || [];
    const items = [];
    for (const l of locks) items.push(lockRow(l, snap, actions));
    for (const f of freezes) {
        const id = String(f.id || '');
        items.push({ kind: 'freeze', id, amount: toBig(f.amount).toString(), status: 'unknown', source: 'Freeze',
            reason: `Freeze "${id}" placed by a module.`, unlock: 'Only the module that placed it can release it.' });
    }
    for (const h of holds) items.push(holdRow(h, snap, actions));
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
            transferableAllowDeath: str(b.transferableAllowDeath),
            free: str(b.free), frozen: str(b.frozen), ed: str(b.ed), edWithheld: str(b.edWithheld),
            canPayFee: b.canPayFee, feeTopUp: b.feeTopUp == null ? null : str(b.feeTopUp) },
        items,
        overlap: locks.length + freezes.length >= 2,
        orphanStaking: items.some(i => i.status === 'orphan'),
        unattributedReserved: unattributed.toString(),
        actions,
        block: snap.block ?? null,
        bondingDays: snap.bondingDays ?? null
    };
}
