// The balance breakdown as a grouped list (designer spec cto-team/plans/2026-11-22-locked-balances-redesign.md,
// sections 1 to 5). Pure: no DOM, no chain access. It takes the model GET /api/account/:address/locks serves
// (lib/balance-locks.js describeAccountLocks) and says, for every locked amount, its row: amount, name, the one
// state chip that says what can be done now, one line saying what happens, the action, and the Details.
// lib/balance-locks-view.js draws it. Every word is in LOCK_COPY under the spec's ids; tested in
// test/lock-rows.test.js.
//
// Rows with an action on this page come first, boxed (group 'act'); the rest are compact lines ('rest').
// A deposit released by another row's action is folded under that row (linkedRows). A bonded staking row is
// split into Staked, Unstaking and Finished unstaking (splitStaking). Unlock amounts are estimates and locks
// overlap, so no button carries an amount and no figure is summed (spec F7, Q2, Q3).

import { formatPlanck } from './tx-status.js';
import { utcDay, pendingText, LEGACY_LOCKS } from './balance-locks.js';

const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); };
const fill = (t, vars = {}) => String(t).replace(/\{([^{}]+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));

// Chip, tile and button words, verbatim with their spec ids. role: positive, neutral or wait.
export const LOCK_COPY = freeze({
    H2_OWN: 'You can act on these',
    H2_OTHER: 'The owner can act on these',
    H3: 'Nothing to do right now',
    E1: 'Nothing is locked or reserved on this account.',
    L1: 'Loading the balance breakdown',
    X1: 'The balance breakdown could not be loaded. Your PDEX is not affected.',
    RETRY: 'Try again',
    V1: 'Connect this account to do this.',
    V2: 'Connect any wallet to remove it. It does not have to be this account.',
    V3: 'Only the controller account {short} can withdraw. Connect it to continue.',
    DETAILS: 'Details',
    DETAILS_FOR: ' for {name}',
    ON_CHAIN: 'On chain: {kind} {id}',
    ALSO: 'also ',
    HELD: 'Another action is in progress.',
    GO_COUNCIL: 'Go to Council',
    MANAGE_PROXIES: 'Manage proxies',
    HELP: { unstaking: 'How unstaking works', leftover: 'More about leftover locks', old: 'More about old locks',
        holds: 'More about locks and holds', identity: 'On-chain identity', proxies: 'Proxies' },
    K01: { name: 'Staked', role: 'neutral', icon: 'bx-lock-alt', word: 'Staked',
        line: 'Earning staking rewards. To get it back: unstake, wait {days}, then withdraw here.' },
    K02: { name: 'Finished unstaking', role: 'positive', icon: 'bx-check', word: 'Ready to withdraw',
        line: 'The unbonding period is over. Withdraw it to move it out of staking.' },
    K03: { name: 'Unstaking', role: 'wait', icon: 'bx-time-five', word: 'Until about {date}', wordNoDate: 'Unstaking',
        line: 'You can withdraw it here from {when}.', lineMany: '{parts}.', part: '{amount} PDEX about {date}' },
    K04: { name: 'Leftover staking lock', role: 'positive', icon: 'bx-check', word: 'Can remove now',
        line: 'Nothing is staked, but an old staking lock was left behind. Removing it makes this PDEX transferable. Any account can send it, and the fee is refunded.' },
    K05: { name: 'Staking hold with no stake', role: 'wait', icon: 'bx-error', word: 'Needs the team',
        line: 'This hold has no staking record behind it, so you cannot release it today. Contact the Polkadex team.' },
    K06: { name: 'Democracy votes', nameDelegating: 'Delegated votes' },
    K09: { name: 'Council vote', role: 'neutral', icon: 'bx-lock-alt', word: 'Vote active',
        line: 'Backs {n} {candidates}. Removing the vote releases {stake} PDEX{gain}.', gain: ' and the {deposit} PDEX deposit together',
        lineNoCount: 'Locked while your council vote stands. Removing the vote releases it.' },
    K10: { name: 'Voting deposit', role: 'neutral', icon: 'bx-link', word: 'Returns with the vote',
        line: 'Deposit for having a council vote on record. Returns when the vote is removed.' },
    K11: { name: 'Vesting', role: 'wait', icon: 'bx-time-five', word: 'Unlocks over time',
        line: 'Unlocks gradually on a schedule. Releasing the unlocked part needs a wallet app; the explorer has no button for it yet.' },
    K12: { name: 'Vesting lock (old)', role: 'wait', icon: 'bx-error', word: 'Needs the team',
        line: 'The chain no longer has a vesting module, so you cannot remove this yourself. Contact the Polkadex team and mention the lock id shown in Details.' },
    K13: { name: '{name} lock (old)', role: 'wait', icon: 'bx-error', word: 'Needs the team',
        line: 'Left over from a module that was removed in an earlier upgrade. You cannot remove it yourself. Contact the Polkadex team and mention the lock id shown in Details.' },
    K14: { name: 'Unknown lock', role: 'neutral', icon: 'bx-help-circle', word: 'Not recognised',
        line: 'The explorer does not recognise this lock. Only the module that set it can release it. Contact the Polkadex team and mention the lock id shown in Details.' },
    K15: { name: 'Freeze', role: 'neutral', icon: 'bx-help-circle', word: 'Not recognised', line: 'Placed by a chain module. Only that module can release it.' },
    K16: { name: 'Proposal data deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit',
        line: 'Deposit for proposal data stored on chain. Returns when the data is removed: by you if it is unused, or after its proposal is enacted or dropped.' },
    K17: { name: 'Council motion deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit',
        line: 'Deposit for a council motion you submitted. Returns after the motion is closed or disapproved and the deposit is claimed back.' },
    K18: { name: 'Technical committee motion deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit',
        line: 'Deposit for a technical committee motion you submitted. Returns after the motion is closed or disapproved and the deposit is claimed back.' },
    K19: { name: 'Session keys deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit', line: 'Deposit for registered validator session keys. Returns when the keys are removed.' },
    K20: { name: 'Delegated staking', role: 'neutral', icon: 'bx-lock-alt', word: 'Staked', line: 'Delegated to a staking agent. Withdraw from that agent; it returns after the unbonding period.' },
    K21: { name: 'Safe mode deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit',
        line: 'Deposit for entering or extending safe mode. After safe mode ends, governance returns it or takes it as a penalty.' },
    K22: { name: 'Unknown hold', role: 'neutral', icon: 'bx-help-circle', word: 'Not recognised', line: 'The explorer does not recognise this hold. Only the module that placed it can release it.' },
    K23: { name: 'Reserved by a module', role: 'neutral', icon: 'bx-help-circle', word: 'Not recognised', line: 'Reserved by a chain module. That module releases it.' },
    K24: { name: 'Identity deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit', line: 'Deposit for your on-chain identity. Returns when you clear your identity.' },
    K25: { name: 'Sub-account deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit', childIcon: 'bx-link', childWord: 'Returns with the identity',
        line: 'Deposit for {n} {subs}. Returns when you remove them.' },
    K26: { name: 'Proxy deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit', line: 'Deposit for {n} {proxies}. Returns when you remove them.' },
    K27: { name: 'Proxy announcement deposit', role: 'neutral', icon: 'bx-lock-alt', word: 'Deposit',
        line: 'Deposit for announced proxy calls. Returns when the call is executed or the announcement is removed.' },
    K28: { name: 'Council candidacy bond', role: 'neutral', icon: 'bx-lock-alt', word: 'Bond',
        line: 'Bond for standing as a council candidate. Returns if you withdraw before the election. A candidate who loses the election loses this bond.' },
    K29: { name: 'Council {role} bond', role: 'neutral', icon: 'bx-lock-alt', word: 'Bond',
        line: 'Bond held while you are a council {role}. Returns when you renounce on the Council page, or when you leave the council and runner-up list at an election.' },
    K30: { name: 'Other deposits', role: 'neutral', icon: 'bx-help-circle', word: 'Not itemised',
        line: 'Reserved PDEX the explorer could not itemise, for example a multisig deposit, a democracy proposal deposit, or a treasury or bounty bond. Each returns through the action that created it.' },
    D1: { role: 'neutral', icon: 'bx-lock-alt', word: 'Delegated' },
    D2: { role: 'positive', icon: 'bx-check', word: 'Can unlock now' },
    D3: { role: 'wait', icon: 'bx-time-five', word: 'Until about {date}', line: 'Finished votes can be removed now. That frees nothing yet: the lock stays until about {date}.',
        lineNoDate: 'Finished votes can be removed now. That frees nothing yet.' },
    D4: { role: 'wait', icon: 'bx-error', word: 'End date unknown', line: 'The lock period could not be read, so the end date is unknown. Reload this section to see it.' },
    D5: { role: 'wait', icon: 'bx-time-five', word: 'Until about {date}', line: 'Locked by your democracy votes. It can be unlocked here after that date.',
        noDate: { role: 'neutral', icon: 'bx-lock-alt', word: 'Vote lock' }, lineNoDate: 'Locked by your democracy votes. It can be unlocked here once the lock period is over.' },
    D6: { role: 'wait', icon: 'bx-time-five', word: 'Until about {date}', line: '{amount} PDEX, earlier vote lock (conviction lock).' },
    D7: { role: 'wait', icon: 'bx-time-five', word: 'Until about {date}',
        line: '{amount} PDEX, referendum #{n}. Your side won with conviction. Remove this vote after its own lock ends; removing it earlier frees nothing.' },
    D8: { role: 'wait', icon: 'bx-time-five', word: 'Until about {date}', line: 'Referendum #{n} is still running. Your vote stays locked until it ends.' },
    SUM1: { role: 'positive', icon: 'bx-check', word: '1 ready now', text: 'Ready now: {amount} PDEX, {name}.' },
    SUM2: { role: 'positive', icon: 'bx-check', word: '{n} ready now', text: '{n} items are ready now. They are listed first.' },
    SUM3: { role: 'neutral', icon: 'bx-time-five', word: 'Nothing ready yet', text: 'Next: {amount} PDEX, about {date}.' },
    SUM4: { role: 'neutral', icon: 'bx-lock-alt', word: 'Nothing ready yet', text: 'Nothing here needs you right now.' },
    B1: { action: 'withdraw', label: 'Withdraw unstaked PDEX', icon: 'bx-down-arrow-circle', hint: 'Signed by the controller account.' },
    B2: { action: 'democracy-unlock', label: 'Unlock voted PDEX', icon: 'bx-lock-open-alt' },
    B3: { action: 'democracy-unlock', label: 'Remove votes and unlock', icon: 'bx-lock-open-alt' },
    B4: { action: 'democracy-unlock', label: 'Remove finished votes', icon: 'bx-list-minus' },
    B5: { action: 'democracy-cancel', label: 'Cancel vote on referendum #{n}', icon: 'bx-undo', confirm: 'C2' },
    B6: { action: 'democracy-undelegate', label: 'Undelegate votes', icon: 'bx-undo', confirm: 'C3' },
    B7: { action: 'elections-remove', label: 'Remove council vote', icon: 'bx-user-minus', confirm: 'C1' },
    B8: { action: 'migrate-currency', label: 'Remove leftover staking lock', icon: 'bx-lock-open-alt', hint: 'Anyone can submit this; the fee is refunded.' },
    B9: { open: 'unstake', label: 'Unstake PDEX', icon: 'bx-minus-circle' },
    C1: { text: 'Remove your council vote? Your {n} {candidates} {lose} your backing of {stake} PDEX. You can vote again later, which locks PDEX and a deposit again.',
        label: 'Remove council vote', keep: 'Keep my vote' },
    C2: { text: 'Cancel your vote on referendum #{n}? It stops counting at once.{unlock}', label: 'Cancel vote on referendum #{n}', keep: 'Keep my vote' },
    C3: { text: 'Undelegate your votes? Your delegate stops voting with your PDEX. {line}', label: 'Undelegate votes', keep: 'Keep delegating' },
    W3: 'Locks overlap; the largest one applies. Locked is {locked}, not the sum of the rows listed here, and releasing a smaller lock frees nothing while a larger one remains.'
});

const big = (v) => { try { return BigInt(String(v == null ? '0' : v).replace(/,/g, '')); } catch (_) { return 0n; } };
export const pdexText = (v) => `${formatPlanck(String(v == null ? '0' : v)) || '0'} PDEX`;
const fig = (v) => formatPlanck(String(v == null ? '0' : v)) || '0';
const plural = (n, one, many) => (Number(n) === 1 ? one : many);
const shortAddr = (a) => { const s = String(a || ''); return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s; };
const knownBlock = (b) => b != null && Number.isFinite(Number(b));
const blockNo = (b) => Number(b).toLocaleString('en-US');
const aboutDay = (ms) => (utcDay(ms) ? ` (about ${utcDay(ms)})` : '');
const until = (b, eta) => (knownBlock(b) ? `until block ${blockNo(b)}${aboutDay(eta)}` : 'until its conviction lock ends');

// "about 2026-12-16 (24 days)", "(under a day)"; null without a date. Dates are estimates (UTC day).
export function whenText(eta, now = Date.now()) {
    const day = utcDay(eta);
    if (!day) return null;
    const days = Math.round((Number(eta) - Number(now)) / 86400000);
    return `about ${day} (${days >= 1 ? `${days} ${plural(days, 'day', 'days')}` : 'under a day'})`;
}

// What an unlock adds to Transferable (an estimate), another lock that keeps part of it, and the part that
// stays staked (lib/lock-actions.js unlockGain). Plain text, verbatim from the panel before this redesign (W4).
const LOCK_NAMES = { phrelect: 'the council vote', 'vesting ': 'vesting' };
const lockName = (id) => (Object.hasOwn(LOCK_NAMES, id) ? LOCK_NAMES[id] : `the ${id} lock`);
export function unlockText(d) {
    if (!d || d.spendable == null) return '';
    const parts = [big(d.spendable) > 0n ? `About ${pdexText(d.spendable)} becomes spendable now` : 'Nothing becomes spendable now'];
    if (d.heldBy) parts.push(`${lockName(d.heldBy.id)} keeps ${pdexText(d.heldBy.amount)} locked`);
    if (big(d.staysStaked) > 0n) parts.push(`${pdexText(d.staysStaked)} stays staked until you unstake`);
    return `${parts.join('; ')}.`;
}
// Undelegate: the lock it leaves, said before the user signs (W5), verbatim.
export function undelegateText(d) {
    const u = (d && d.undelegate) || {};
    if (u.lockAmount == null) return `After undelegating, ${pdexText(d && d.lockNow)} stays locked ${until(u.lockUntil, u.lockUntilEta)}; then unlock it here.`;
    if (u.freeAtOnce) return `After undelegating, Unlock frees ${pdexText(u.lockAmount)}.`;
    return `Undelegating keeps ${pdexText(u.lockAmount)} locked ${until(u.lockUntil, u.lockUntilEta)}${u.byPrior ? ' because of an earlier vote lock' : ''}; then unlock it here.`
        + (u.betterAfter ? ` Undelegating after block ${blockNo(u.betterAfter)}${aboutDay(u.betterAfterEta)}, when that lock ends, holds only the delegated PDEX.` : '');
}

const HOLD_KINDS = { 'Preimage.Preimage': 'K16', 'Council.ProposalSubmission': 'K17', 'TechnicalCommittee.ProposalSubmission': 'K18',
    'Session.Keys': 'K19', 'DelegatedStaking.StakingDelegation': 'K20', 'SafeMode.EnterOrExtend': 'K21' };
const DEPOSIT_KINDS = { identity: 'K24', subs: 'K25', proxy: 'K26', announcements: 'K27', 'council-vote': 'K10', candidacy: 'K28',
    'council-member': 'K29', 'council-runner-up': 'K29', other: 'K30' };
// The spec's kind id (4.2) of one model item.
export function kindOf(item) {
    const i = item || {};
    if (i.kindId) return i.kindId;
    const id = String(i.id || '');
    if (i.kind === 'lock') {
        if (id === 'staking ') return i.status === 'orphan' ? 'K04' : 'K01';
        if (id === 'democrac') return 'K06';
        if (id === 'phrelect') return 'K09';
        if (id === 'vesting ') return i.status === 'legacy' ? 'K12' : 'K11';
        if (Object.hasOwn(LEGACY_LOCKS, id)) return 'K13';
        return 'K14';
    }
    if (i.kind === 'freeze') return 'K15';
    if (i.kind === 'hold') {
        if (id === 'Staking.Staking') return i.status === 'orphan' ? 'K05' : 'K01';
        return HOLD_KINDS[id] || 'K22';
    }
    if (i.kind === 'reserve') return 'K23';
    if (i.kind === 'deposit') return DEPOSIT_KINDS[i.what] || 'K30';
    return 'K14';
}

// The democracy row's state (4.3): D1 to D5, first match. The date is the latest end the lock waits for.
const dEnds = (d) => [d.prior && d.prior.eta, d.lockedUntil ? d.lockedUntilEta : null, ...(d.held || []).map(h => h.eta), ...(d.cancel || []).map(c => c.eta)]
    .filter(x => x != null && Number.isFinite(Number(x))).map(Number);
function democracyState(d) {
    const c = LOCK_COPY;
    if (d && d.mode === 'delegating') return { id: 'D1', ...c.D1 };
    if (d && d.unlock) return { id: 'D2', ...c.D2 };
    const ends = d ? dEnds(d) : [];
    const eta = ends.length ? Math.max(...ends) : null;
    if (d && d.remove && d.remove.length) {
        const at = d.lockedUntil ? d.lockedUntilEta : eta;
        return utcDay(at) ? { id: 'D3', ...c.D3, eta: at, line: fill(c.D3.line, { date: utcDay(at) }) } : { id: 'D3', ...c.D5.noDate, line: c.D3.lineNoDate };
    }
    if (d && (d.held || []).some(h => h.until == null)) return { id: 'D4', ...c.D4 };
    if (utcDay(eta)) return { id: 'D5', ...c.D5, eta };
    return { id: 'D5', ...c.D5, ...c.D5.noDate, line: c.D5.lineNoDate };
}

// The parts of the democracy lock (D6 to D8) as child rows: each with its chip and line, a running vote with B5.
export function democracyParts(d, now = Date.now()) {
    if (!d || d.mode !== 'direct') return [];
    const c = LOCK_COPY;
    const chip = (spec, eta, unknown = false) => (unknown ? { role: c.D4.role, icon: c.D4.icon, word: c.D4.word }
        : utcDay(eta) ? { role: spec.role, icon: spec.icon, word: fill(spec.word, { date: utcDay(eta) }) } : { ...c.D5.noDate });
    const out = [];
    const prior = d.prior ? { amount: d.prior.amount, eta: d.prior.eta } : d.lockedUntil ? { amount: d.lockedUntilAmount, eta: d.lockedUntilEta } : null;
    if (prior) out.push({ key: 'democrac:prior', kindId: 'D6', chip: chip(c.D6, prior.eta), line: fill(c.D6.line, { amount: fig(prior.amount) }), eta: prior.eta });
    for (const h of d.held || []) {
        out.push({ key: `democrac:held:${h.index}`, kindId: 'D7', chip: chip(c.D7, h.eta, h.until == null),
            line: fill(c.D7.line, { amount: fig(h.amount), n: h.index }), eta: h.eta });
    }
    for (const x of d.cancel || []) {
        out.push({ key: `democrac:cancel:${x.index}`, kindId: 'D8', chip: chip(c.D8, x.eta), line: fill(c.D8.line, { n: x.index }), eta: x.eta, cancel: x });
    }
    void now;
    return out;
}

// A bonded staking row as what it is for the user (3): K02 the finished chunks, K03 the chunks still
// unbonding, K01 the rest, so the parts add up to the chain figure. Not split when the two exceed the row.
export function splitStaking(item, withdraw) {
    const base = { ...item, kindId: 'K01', key: `${item.kind}:${item.id}` };
    if (!withdraw) return [base];
    const total = big(item.amount), ready = big(withdraw.withdrawable);
    const pending = withdraw.pending || [];
    const unbonding = pending.reduce((a, c) => a + big(c.value), 0n);
    if (ready + unbonding > total || ready + unbonding === 0n) return [base];
    const out = [];
    if (ready > 0n) out.push({ ...item, kindId: 'K02', key: `${base.key}:ready`, amount: ready.toString() });
    if (unbonding > 0n) out.push({ ...item, kindId: 'K03', key: `${base.key}:unstaking`, amount: unbonding.toString(), pending });
    const staked = total - ready - unbonding;
    if (staked > 0n) out.push({ ...base, amount: staked.toString() });
    return out;
}

// What can be done now for one item (4.2, 4.3): its group ('act' when the row has an action by its kind; the
// page adds B9 to Staked), the chip's role, icon and word, and the day it waits for.
export function lockRowState(item, model, now = Date.now()) {
    const k = kindOf(item);
    const a = (model && model.actions) || {};
    const c = LOCK_COPY;
    let s;
    if (k === 'K06') {
        const d = a.democracy || null;
        const st = democracyState(d);
        const hasAction = !!(d && (d.mode === 'delegating' || d.unlock || (d.remove && d.remove.length) || (d.cancel && d.cancel.length)));
        return { kindId: k, sub: st.id, group: hasAction ? 'act' : 'rest', role: st.role, icon: st.icon,
            word: fill(st.word, { date: utcDay(st.eta) }), date: utcDay(st.eta) || null, eta: utcDay(st.eta) ? st.eta : null, line: st.line || null };
    }
    if (k === 'K03') {
        const etas = (item.pending || []).map(p => p.eta).filter(x => utcDay(x));
        const eta = etas.length ? Math.min(...etas.map(Number)) : null;
        s = eta != null ? { ...c.K03, word: fill(c.K03.word, { date: utcDay(eta) }) } : { ...c.K03, word: c.K03.wordNoDate };
        return { kindId: k, group: 'rest', role: s.role, icon: s.icon, word: s.word, date: utcDay(eta), eta };
    }
    s = c[k];
    let group = 'rest';
    if (k === 'K02') group = a.withdraw && big(a.withdraw.withdrawable) > 0n ? 'act' : 'rest';
    if (k === 'K04') group = a.orphan ? 'act' : 'rest';
    if (k === 'K09' || k === 'K10') group = a.elections ? 'act' : 'rest';
    void now;
    return { kindId: k, group, role: s.role, icon: s.icon, word: s.word, date: null, eta: null };
}

// A child folded under its parent (3): the council voting deposit under the council vote, the sub-account
// deposit under the identity deposit (pallet-identity clear_identity returns both: test/lock-rows.test.js
// reads it from the runtime metadata). rows: display rows with kindId; returns the top-level rows.
const PARENT_OF = { K10: 'K09', K25: 'K24' };
export function linkedRows(rows) {
    const list = (rows || []).map(r => ({ ...r, children: [...(r.children || [])] }));
    const out = [];
    for (const r of list) {
        const parentKind = PARENT_OF[r.kindId];
        const parent = parentKind ? list.find(p => p.kindId === parentKind) : null;
        if (parent) parent.children.push({ ...r, child: true });
        else out.push(r);
    }
    return out;
}

const HELP_NAMES = { Unstaking: 'unstaking', 'About leftover staking locks': 'leftover', 'About legacy locks': 'old', 'About locks and holds': 'holds',
    'On-chain identity': 'identity', Proxies: 'proxies' };
const TILE_ROLE = { positive: 'green', wait: 'amber', neutral: 'violet' };
const GLYPH = { K01: 'bx-coin-stack', K02: 'bx-coin-stack', K03: 'bx-coin-stack', K05: 'bx-coin-stack', K04: 'bx-lock-open-alt', K06: 'bx-check-shield',
    K09: 'bx-group', K10: 'bx-group', K28: 'bx-group', K29: 'bx-group' };

function nameOf(k, item, d) {
    const c = LOCK_COPY;
    if (k === 'K06') return d && d.mode === 'delegating' ? c.K06.nameDelegating : c.K06.name;
    if (k === 'K13') return fill(c.K13.name, { name: LEGACY_LOCKS[item.id] || item.id });
    if (k === 'K29') return fill(c.K29.name, { role: item.what === 'council-member' ? 'member' : 'runner-up' });
    return c[k].name;
}

function lineOf(k, item, ctx) {
    const c = LOCK_COPY, a = ctx.actions;
    switch (k) {
    case 'K01': return fill(c.K01.line, { days: ctx.bondingDays ? `${ctx.bondingDays} days` : 'the unbonding period' });
    case 'K03': {
        const p = item.pending || [];
        if (p.length === 1) {
            const when = whenText(p[0].eta, ctx.now);
            return when ? fill(c.K03.line, { when }) : fill(c.K03.line, { when: `era ${p[0].era}` });
        }
        return fill(c.K03.lineMany, { parts: p.map(x => (utcDay(x.eta) ? fill(c.K03.part, { amount: fig(x.value), date: utcDay(x.eta) }) : `${fig(x.value)} PDEX from era ${x.era}`)).join('; ') });
    }
    case 'K06': {
        const d = a.democracy;
        const st = ctx.state;
        if (st.sub === 'D1') return undelegateText(d);
        if (st.sub === 'D2') return unlockText(d);
        if (st.sub === 'D3') return st.line ? st.line : fill(LOCK_COPY.D3.line, { date: st.date });
        if (st.sub === 'D4') return LOCK_COPY.D4.line;
        return st.line || LOCK_COPY.D5.line;
    }
    case 'K09': {
        const e = a.elections;
        if (!e || !e.votes) return c.K09.lineNoCount;
        const dep = ctx.linkedDeposit != null ? fill(c.K09.gain, { deposit: fig(ctx.linkedDeposit) }) : '';
        return fill(c.K09.line, { n: e.votes, candidates: plural(e.votes, 'candidate', 'candidates'), stake: fig(e.stake), gain: dep });
    }
    case 'K10': return item.child ? '' : c.K10.line;
    case 'K25': return fill(c.K25.line, { n: Number(item.count) || 0, subs: plural(Number(item.count) || 0, 'sub-account', 'sub-accounts') });
    case 'K26': return fill(c.K26.line, { n: Number(item.count) || 0, proxies: plural(Number(item.count) || 0, 'proxy', 'proxies') });
    case 'K29': return fill(c.K29.line, { role: item.what === 'council-member' ? 'member' : 'runner-up' });
    default: return c[k] && c[k].line ? c[k].line : '';
    }
}

function confirmOf(id, ctx, extra = {}) {
    const c = LOCK_COPY[id];
    const a = ctx.actions;
    if (id === 'C1') {
        const e = a.elections || {};
        const n = Number(e.votes) || 0;
        return { id, text: fill(c.text, { n, candidates: plural(n, 'candidate', 'candidates'), lose: plural(n, 'loses', 'lose'), stake: fig(e.stake) }), label: c.label, keep: c.keep };
    }
    if (id === 'C2') {
        const u = unlockText(extra.cancel);
        return { id, text: fill(c.text, { n: extra.cancel.index, unlock: u ? ` ${u}` : '' }), label: fill(c.label, { n: extra.cancel.index }), keep: c.keep };
    }
    return { id, text: fill(c.text, { line: undelegateText(a.democracy) }), label: c.label, keep: c.keep };
}

// The button (B1 to B9) or, for a viewer who cannot sign, the sentence that replaces it (V1 to V3).
function button(id, ctx, extra = {}) {
    const b = LOCK_COPY[id];
    const out = { id, kind: b.action || null, open: b.open || null, label: fill(b.label, { n: extra.ref }), icon: b.icon };
    if (extra.ref != null) out.ref = String(extra.ref);
    if (b.confirm) out.confirm = confirmOf(b.confirm, ctx, extra);
    if (extra.hint) out.hint = b.hint;
    return out;
}
const connectLine = (id, vars) => ({ id, text: fill(LOCK_COPY[id], vars), icon: 'bx-wallet' });

function actionOf(k, item, ctx) {
    const a = ctx.actions;
    if (k === 'K01') return ctx.page === 'wallet' && ctx.unstake && ctx.canSign ? button('B9', ctx) : null;
    if (k === 'K02') {
        const w = a.withdraw;
        if (!w || big(w.withdrawable) <= 0n) return null;
        // No connected address given: a signing viewer is this account, which signs unless the controller differs.
        const signer = ctx.connected ? ctx.isSame(ctx.connected, w.signer) : ctx.canSign && !w.controllerDiffers;
        if (signer) return button('B1', ctx, { hint: !!w.controllerDiffers });
        if (w.controllerDiffers) return connectLine('V3', { short: shortAddr(w.signer) });
        return connectLine('V1');
    }
    if (k === 'K04') {
        if (!a.orphan) return null;
        return ctx.connected || ctx.canSign ? button('B8', ctx, { hint: true }) : connectLine('V2');
    }
    if (k === 'K09' || (k === 'K10' && !item.child)) {
        if (!a.elections) return null;
        return ctx.canSign ? button('B7', ctx) : connectLine('V1');
    }
    if (k === 'K06') {
        const d = a.democracy;
        const sub = ctx.state.sub;
        if (!d) return null;
        const id = sub === 'D1' ? 'B6' : sub === 'D2' ? (d.remove.length ? 'B3' : 'B2') : sub === 'D3' ? 'B4' : null;
        if (!id) return null;
        return ctx.canSign ? button(id, ctx) : connectLine('V1');
    }
    return null;
}

// The democracy lock's parts with their blocks, for Details: the sentences the panel showed before this
// redesign, verbatim, so the exact block each lock ends at stays on the page.
const heldText = (h) => (knownBlock(h.until)
    ? `Remove the vote on referendum #${h.index} after block ${blockNo(h.until)}${aboutDay(h.eta)}, when its own lock ends.`
    : `Remove the vote on referendum #${h.index} once its own conviction lock ends; the lock period could not be read, so reload to see the date.`);
export function democracyBlocks(d) {
    if (!d || d.mode !== 'direct') return [];
    const out = [];
    const held = d.held || [];
    if (held.length) {
        if (d.prior) out.push(`Earlier vote lock: ${pdexText(d.prior.amount)} ${until(d.prior.until, d.prior.eta)}.`);
        for (const h of held) out.push(`Vote on referendum #${h.index}: ${pdexText(h.amount)} ${until(h.until, h.eta)}.`);
    }
    if (d.lockedUntil && !(held.length && d.prior)) out.push(`${pdexText(d.lockedUntilAmount)} stays locked ${until(d.lockedUntil, d.lockedUntilEta)} (conviction lock).`);
    for (const h of held) out.push(heldText(h));
    for (const c of d.cancel || []) out.push(`Referendum #${c.index} runs until block ${blockNo(c.end)}${aboutDay(c.eta)}; its vote stays locked until then.`);
    return out;
}

const HOLD_WORD = { lock: 'lock', hold: 'hold', freeze: 'freeze', reserve: 'reserve' };
function detailsOf(k, item, ctx) {
    const kindWord = HOLD_WORD[item.kind];
    const help = item.link && item.link.href && /^\/help\//.test(item.link.href) && HELP_NAMES[item.link.text]
        ? { href: item.link.href, text: LOCK_COPY.HELP[HELP_NAMES[item.link.text]] } : null;
    return {
        onChain: kindWord && item.id ? fill(LOCK_COPY.ON_CHAIN, { kind: kindWord, id: item.id }) : null,
        text: k === 'K02' || k === 'K03' ? '' : String(item.reason || ''),
        refs: Array.isArray(item.refs) ? item.refs.map(r => ({ href: r.href, text: r.text })) : [],
        eras: k === 'K03' ? `Still unbonding: ${pendingText(item.pending)}` : '',
        blocks: k === 'K06' ? democracyBlocks(ctx.actions.democracy) : [],
        help
    };
}

function linkOf(k, item, ctx) {
    if (k === 'K28' || k === 'K29') return { href: '/council', text: LOCK_COPY.GO_COUNCIL };
    if (k === 'K26' && ctx.page === 'wallet' && ctx.canSign) return { href: '#wallet-advanced-section', text: LOCK_COPY.MANAGE_PROXIES };
    return null;
}

function rowOf(item, ctx) {
    const k = kindOf(item);
    const state = lockRowState(item, ctx.model, ctx.now);
    const rctx = { ...ctx, state };
    const action = actionOf(k, item, rctx);
    const kids = k === 'K06' ? democracyParts(ctx.actions.democracy, ctx.now).map(p => ({
        key: p.key, kindId: p.kindId, amount: null, name: null, chip: p.chip, line: p.line, eta: p.eta,
        action: p.cancel ? (ctx.canSign ? button('B5', rctx, { ref: p.cancel.index, cancel: p.cancel }) : connectLine('V1')) : null,
        children: [], details: null, link: null, child: true })) : [];
    const group = action && action.id === 'B9' ? 'act' : state.group;
    return {
        key: item.key || `${item.kind}:${item.id || item.what || k}`, kindId: k, amount: String(item.amount == null ? '0' : item.amount),
        name: nameOf(k, item, ctx.actions.democracy), group, eta: state.eta, date: state.date,
        chip: { role: state.role, icon: state.icon, word: state.word },
        tile: null, line: lineOf(k, item, rctx), action, link: linkOf(k, item, ctx), children: kids, details: detailsOf(k, item, ctx), child: !!item.child, item
    };
}

// G1 order: green, neutral, amber. G2: amber by date (soonest first), then undated amber, neutral, and last the
// rows nobody can act on here (Needs the team, Not recognised, Not itemised).
const LAST_WORDS = new Set([LOCK_COPY.K05.word, LOCK_COPY.K14.word, LOCK_COPY.K30.word]);
const actRank = (r) => ({ positive: 0, neutral: 1, wait: 2 }[r.chip.role] ?? 1);
const restRank = (r) => (LAST_WORDS.has(r.chip.word) ? 3 : r.chip.role === 'wait' ? (r.eta != null ? 0 : 1) : 2);
const stable = (rows, cmp) => rows.map((r, i) => [r, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(x => x[0]);

// The summary line (1.4): a chip and one sentence, never a summed figure (F7).
export function lockSummary(display) {
    const rows = ((display && display.groups) || []).flatMap(g => g.rows);
    if (!rows.length) return null;
    const c = LOCK_COPY;
    const green = rows.filter(r => r.chip.role === 'positive');
    if (green.length === 1) return { id: 'SUM1', chip: { role: c.SUM1.role, icon: c.SUM1.icon, word: c.SUM1.word }, text: fill(c.SUM1.text, { amount: fig(green[0].amount), name: green[0].name.toLowerCase() }) };
    if (green.length > 1) return { id: 'SUM2', chip: { role: c.SUM2.role, icon: c.SUM2.icon, word: fill(c.SUM2.word, { n: green.length }) }, text: fill(c.SUM2.text, { n: green.length }) };
    const dated = rows.filter(r => r.chip.role === 'wait' && r.eta != null).sort((x, y) => x.eta - y.eta);
    if (dated.length) return { id: 'SUM3', chip: { role: c.SUM3.role, icon: c.SUM3.icon, word: c.SUM3.word }, text: fill(c.SUM3.text, { amount: fig(dated[0].amount), date: dated[0].date }) };
    return { id: 'SUM4', chip: { role: c.SUM4.role, icon: c.SUM4.icon, word: c.SUM4.word }, text: c.SUM4.text };
}

// The notes above the list (4.6): W1 cannot pay a fee, W2 the existential deposit, W3 the overlap. Verbatim.
export function lockNotes(model) {
    const b = (model && model.balance) || {};
    const notes = [];
    const ed = () => `the existential deposit (${pdexText(b.ed)})`;
    if (b.canPayFee === false) {
        const uncovered = big(b.locked) > big(b.reserved) ? big(b.locked) - big(b.reserved) : 0n;
        const why = uncovered > 0n && big(b.reserved) > 0n
            ? `${pdexText(b.locked)} is locked and reserved PDEX (${pdexText(b.reserved)}) counts toward the lock, so free PDEX must keep the other ${pdexText(uncovered.toString())}, and at least ${ed()}`
            : uncovered > 0n ? `free PDEX must keep the locked part (${pdexText(b.locked)}) and at least ${ed()}`
                : big(b.locked) > 0n ? `reserved PDEX covers the lock, but free PDEX must keep ${ed()}`
                    : `free PDEX must keep ${ed()}`;
        notes.push({ id: 'W1', panel: 'warn', icon: 'bx-error', text: `This account cannot pay a network fee: ${why}, and the free balance (${pdexText(b.free)}) does not cover that plus the fee. So nothing can be sent or signed from it. Send at least ${pdexText(b.feeTopUp)} PDEX to this account first.` });
    } else if (big(b.edWithheld) > 0n) {
        const movable = big(b.transferableAllowDeath) > big(b.transferable);
        notes.push({ id: 'W2', panel: 'info', icon: 'bx-info-circle', text: `${pdexText(b.edWithheld)} of the free balance is the existential deposit (${pdexText(b.ed)}), the minimum that keeps the account open. It is not counted as transferable; `
            + (movable ? 'Send with Keep alive off can move it too, and that closes the account.'
                : 'while anything is locked or reserved the account cannot be closed, so Send keeps it back even with Keep alive off.') });
    } else if (big(b.ed) > 0n) {
        notes.push({ id: 'W2', panel: 'info', icon: 'bx-info-circle', text: `The existential deposit (${pdexText(b.ed)}) is the minimum that keeps an account open; here the locks already cover it.` });
    }
    if (model && model.overlap) notes.push({ id: 'W3', panel: 'info', icon: 'bx-info-circle', text: fill(LOCK_COPY.W3, { locked: pdexText(b.locked) }) });
    return notes;
}

// The whole list for one model and one viewer. canSign: the connected wallet is this account; connected: the
// connected address (any account, for B8 and the controller's B1); page: 'wallet' (My Account) or 'account';
// unstake: the action bar's Unstake is enabled (B9).
export function lockDisplay(model, { canSign = false, connected = null, page = 'account', now = Date.now(), unstake = false, isSame = (x, y) => String(x) === String(y) } = {}) {
    const m = model || {};
    const actions = m.actions || {};
    const items = Array.isArray(m.items) ? m.items : [];
    const ctx = { model: m, actions, canSign: !!canSign, connected, page, now, unstake: !!unstake, isSame, bondingDays: m.bondingDays };
    const hasStakingHold = items.some(i => kindOf(i) === 'K01' && i.kind === 'hold');
    const expanded = [];
    for (const it of items) {
        const k = kindOf(it);
        if (k === 'K01' && (it.kind === 'hold' || !hasStakingHold)) expanded.push(...splitStaking(it, actions.withdraw));
        else expanded.push({ ...it, kindId: k, key: `${it.kind}:${it.id || it.what || k}` });
    }
    // Fold first, so a parent's line can name its child (and a child alone keeps its own line and action).
    const folded = linkedRows(expanded.map(it => ({ ...it, children: [] })));
    const rows = folded.map(it => {
        const kids = it.children || [];
        const dep = it.kindId === 'K09' ? kids.find(x => x.kindId === 'K10') : null;
        const row = rowOf(it, { ...ctx, linkedDeposit: dep ? dep.amount : null });
        row.children = [...row.children, ...kids.map(ch => {
            const r = rowOf({ ...ch, child: true }, ctx);
            const spec = LOCK_COPY[r.kindId];
            if (spec && spec.childIcon) r.chip = { role: spec.role, icon: spec.childIcon, word: spec.childWord };
            return { ...r, child: true, action: null, children: [] };
        })];
        return row;
    });
    for (const r of rows) r.tile = r.group === 'act' ? { role: TILE_ROLE[r.chip.role] || 'violet', icon: GLYPH[r.kindId] || 'bx-lock-alt' } : null;
    const act = stable(rows.filter(r => r.group === 'act'), (x, y) => actRank(x) - actRank(y));
    const rest = stable(rows.filter(r => r.group !== 'act'), (x, y) => (restRank(x) - restRank(y)) || (restRank(x) === 0 ? x.eta - y.eta : 0));
    const groups = [];
    if (act.length) groups.push({ id: 'act', heading: canSign ? LOCK_COPY.H2_OWN : LOCK_COPY.H2_OTHER, rows: act });
    if (rest.length) groups.push({ id: 'rest', heading: LOCK_COPY.H3, rows: rest });
    const display = { notes: lockNotes(m), groups, summary: null, canSign: !!canSign };
    display.summary = lockSummary(display);
    return display;
}

// Stubs for the red commit of WP2 (the self-updating panel): the names the tests import, with no behaviour.
export const diffRows = () => ({ leave: [], enter: [], stay: [] });
export const focusAfterLeave = () => undefined;
export const rowMessage = () => null;
