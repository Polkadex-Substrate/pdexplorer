// The Actions panel of a governance item page (lib/gov-detail-view.js): which
// actions a connected account can take on this referendum, proposal or motion,
// why the others are off, and the in-flight state of one of its own
// transactions.
//
// No signing happens here. Every button asks script.js, through deps.actions,
// to run the SAME function the Democracy and Council pages run:
//   vote        -> openReferendumVoteModal (amount, conviction, lock wording),
//                  whose submit is submitReferendumVote
//   second      -> secondPublicProposal (the Public Proposals tab's Second)
//   motionVote  -> councilMotionVote
//   motionClose -> councilMotionClose
// and each of those reports its stages here as well as to its list page
// (govDetailPage.stage, fanned out with fanStage). test/gov-actions.test.js
// holds both sides to that.
//
// Pure functions, no DOM and no browser natives.

import { BUTTON_STAGE_TEXT, pendingChipText, motionState } from './tx-status.js';
import { planckToPdex } from './democracy-live.js';

const STATUS_WORD = {
    Passed: 'passed', NotPassed: 'not passed', Cancelled: 'cancelled', Tabled: 'tabled as a referendum', Launched: 'launched as a referendum',
    Gone: 'no longer queued', executed: 'executed', approved: 'approved', disapproved: 'disapproved', closed: 'closed', resolved: 'resolved'
};
const statusWord = (s) => STATUS_WORD[s] || String(s || 'unknown').toLowerCase();
const COLLECTIVE_NAME = { council: 'the Council', technicalCommittee: 'the Technical Committee' };

// What a Second needs beyond the deposit, in PDEX. The reserve must leave the
// existential deposit behind (the chain refuses to reap an account by a
// reserve), and the network fee comes out of the same free balance. There is
// no fee estimate here: the explorer's estimator (tx.paymentInfo, the Send
// modal) needs a built transaction and this panel builds none, so a fixed
// margin stands in for it. 0.05 PDEX is the Send modal's own fee buffer
// (SEND_FEE_BUFFER in script.js), well above a Second's fee on Polkadex.
export const SECOND_FEE_MARGIN_PDEX = 0.05;
const addPdex = (...xs) => Number(xs.reduce((a, x) => a + (Number(x) || 0), 0).toFixed(12));

// The key a transaction in flight is filed under: the same keys the list
// pages use ('ref:N', 'prop:N', '<collective>:<motion hash>').
export function govItemKey(d) {
    if (!d) return null;
    const i = d.index;
    const isIdx = (typeof i === 'number' && Number.isInteger(i) && i >= 0) || (typeof i === 'string' && /^\d+$/.test(i));
    if (d.kind === 'referendum') return isIdx ? 'ref:' + Number(i) : null;
    if (d.kind === 'proposal') return isIdx ? 'prop:' + Number(i) : null;
    if (d.kind === 'motion') return d.hash ? (d.collective === 'technicalCommittee' ? 'technicalCommittee' : 'council') + ':' + d.hash : null;
    return null;
}

// system.account(who) -> { free, transferable } in PDEX. free is what a
// democracy vote may lock (locks overlap); transferable (free less the largest
// freeze) is what a second can reserve. Old runtimes split the freeze into
// miscFrozen / feeFrozen.
export function decodeAccountBalance(info) {
    const d = info && (info.data || info);
    if (!d || d.free === undefined || d.free === null) return null;
    const big = (x) => { try { return BigInt(String(x === undefined || x === null ? 0 : x)); } catch (_) { return 0n; } };
    const free = big(d.free);
    const frozen = [d.frozen, d.miscFrozen, d.feeFrozen].map(big).reduce((m, x) => (x > m ? x : m), 0n);
    const transferable = free > frozen ? free - frozen : 0n;
    return { free: planckToPdex(free), transferable: planckToPdex(transferable) };
}

// Before a motion vote or close from an item page: re-read the collective
// (members, open motions) fresh, so councilMotionVote / councilMotionClose
// check the seat and look up the motion in current state rather than in
// whatever the Council page loaded earlier. One request per click, and only
// on a click. view: { getData(), refresh({ fresh }) }. Returns false when the
// read produced no new data (the refresh fails quietly and keeps the old
// object), so the caller refuses instead of checking the stale copy.
export async function refreshCollectiveForSubmit(view) {
    if (!view || typeof view.refresh !== 'function') return false;
    const before = view.getData();
    try { await view.refresh({ fresh: true }); } catch (_) { return false; }
    const after = view.getData();
    return !!after && after !== before;
}

// Several onStage callbacks as one; one that throws does not starve the rest.
export function fanStage(...fns) {
    const list = fns.filter(f => typeof f === 'function');
    return (stage, m) => {
        let err = null;
        for (const f of list) { try { f(stage, m); } catch (e) { if (!err) err = e; } }
        if (err) throw err;
    };
}

// ctx: {
//   account       the connected address, or null
//   same(a, b)    address equality across SS58 prefixes
//   myVote        the account's vote on this referendum (decodeVoting), or null
//   balance       decodeAccountBalance(...) or null while unknown
//   members       the collective's member addresses (live), or null while unknown
//   deposit       the proposal's current deposit in PDEX (live or REST)
//   existentialDeposit  the chain's minimum balance in PDEX, or undefined while unknown
//   pending       { kind, stage, error } of this page's transaction, or null
//   clicking      an action was started and has not reported a stage yet
//   pdex(n)       formats a PDEX amount for display
// }
// Returns { kind, buttons: [{ act, label, enabled, pressed, reason, tone }], reason, connect, mine, note, chip, error }.
export function govActionModel(d, ctx = {}) {
    const out = { kind: d ? d.kind : null, buttons: [], reason: '', connect: false, mine: '', note: '', chip: '', error: '' };
    if (!d) return out;
    const p = ctx.pending || null;
    const busy = !!ctx.clicking || (!!p && !p.error);
    const same = typeof ctx.same === 'function' ? ctx.same : (a, b) => a === b;
    const who = ctx.account || null;
    const fmt = typeof ctx.pdex === 'function' ? ctx.pdex : String;
    if (p && p.error) out.error = String(p.error);
    if (busy && p) out.chip = p.kind === 'second' ? 'Your second is being recorded' : pendingChipText(p.kind);
    else if (busy) out.chip = 'Waiting for your confirmation';

    // A button that is off for `reason` (the first reason wins).
    const make = (act, label, tone, reasons) => {
        const reason = reasons.find(Boolean) || '';
        const pressed = busy && !!p && p.kind === act;
        return { act, label: pressed ? (BUTTON_STAGE_TEXT[p.stage] || BUTTON_STAGE_TEXT.signing) : label, tone,
            enabled: !reason && !busy, pressed, reason };
    };
    const noWallet = who ? '' : 'Connect a wallet to take part.';

    if (d.kind === 'referendum') {
        const open = d.status === 'Ongoing';
        const closed = open ? '' : `Voting has closed: this referendum is ${statusWord(d.status)}.`;
        const broke = ctx.balance && !(ctx.balance.free > 0) ? 'This account has no free PDEX to vote with.' : '';
        const why = [closed, noWallet, broke];
        out.buttons = [make('aye', 'Vote Aye', 'aye', why), make('nay', 'Vote Nay', 'nay', why)];
        out.reason = why.find(Boolean) || '';
        out.connect = open && !who;
        const v = ctx.myVote;
        if (open && v) {
            out.mine = v.split ? `Your current vote: split, ${fmt(v.ayeBalance)} aye / ${fmt(v.nayBalance)} nay PDEX.`
                : `Your current vote: ${v.aye ? 'Aye' : 'Nay'}, ${fmt(v.balance)} PDEX at ${v.conviction || 'None'}.`;
            out.note = 'Voting again replaces your current vote with the new side, amount and conviction.';
        } else if (open) {
            out.note = 'You choose the amount and the conviction in the next step. Conviction multiplies the weight of your vote and sets how many lock periods your PDEX stays locked after the referendum, if your side wins; with no conviction (0.1x) nothing is locked.';
        }
        if (open && who && ctx.balance) out.note += ` Free balance: ${fmt(ctx.balance.free)} PDEX.`;
        return out;
    }

    if (d.kind === 'proposal') {
        const open = d.status === 'Queued';
        const deposit = Number(ctx.deposit !== undefined && ctx.deposit !== null ? ctx.deposit : d.deposit);
        const hasDeposit = Number.isFinite(deposit) && deposit > 0;
        const closed = open ? '' : `Seconding has closed: this proposal is ${statusWord(d.status)}.`;
        const ed = Number(ctx.existentialDeposit) > 0 ? Number(ctx.existentialDeposit) : 0;
        const needed = hasDeposit ? addPdex(deposit, ed, SECOND_FEE_MARGIN_PDEX) : 0;
        const short = ctx.balance && hasDeposit && ctx.balance.transferable < needed
            ? `Seconding reserves ${fmt(deposit)} PDEX, and the account must keep ${ed > 0 ? `${fmt(ed)} PDEX (the minimum balance) plus ` : ''}about ${fmt(SECOND_FEE_MARGIN_PDEX)} PDEX for the network fee: ${fmt(needed)} PDEX in all. This account has ${fmt(ctx.balance.transferable)} PDEX available.` : '';
        const why = [closed, noWallet, short];
        out.buttons = [make('second', hasDeposit ? `Second (deposit ${fmt(deposit)} PDEX)` : 'Second', 'second', why)];
        out.reason = why.find(Boolean) || '';
        out.connect = open && !who;
        if (open) out.note = 'Seconding backs this proposal for the next referendum launch. It reserves a deposit equal to the proposer\'s until the proposal is tabled.';
        return out;
    }

    if (d.kind === 'external') {
        out.reason = '';
        out.note = 'Council and Technical Committee only. An external proposal is queued by a council motion and can be fast-tracked by a Technical Committee motion; there is no public vote until it launches as a referendum.';
        return out;
    }

    if (d.kind === 'motion') {
        const body = COLLECTIVE_NAME[d.collective] || COLLECTIVE_NAME.council;
        const open = d.status === 'proposed';
        const closed = open ? '' : `Voting has closed: this motion is ${statusWord(d.status)}.`;
        const members = Array.isArray(ctx.members) ? ctx.members : null;
        const isMember = !!who && !!members && members.some(m => same(m, who));
        const seat = !who ? '' : !members ? 'Checking membership...' : isMember ? '' : `Only members of ${body} can vote on or close its motions. Your connected account does not hold a seat.`;
        const ayes = Array.isArray(d.ayeVoters) ? d.ayeVoters.map(v => v && v.address) : new Array(Number(d.ayes) || 0).fill(null);
        const nays = Array.isArray(d.nayVoters) ? d.nayVoters.map(v => v && v.address) : new Array(Number(d.nays) || 0).fill(null);
        const st = motionState({ ayes, nays, threshold: d.threshold, end: d.endBlock }, { seats: members ? members.length : d.seats, currentBlock: d.currentBlock, you: who, isSame: same });
        const base = [closed, noWallet, seat];
        out.buttons = [
            make('aye', st.youVoted === 'aye' ? 'Voted Aye' : 'Vote Aye', 'aye', [...base, st.youVoted === 'aye' ? 'You have voted Aye on this motion.' : '']),
            make('nay', st.youVoted === 'nay' ? 'Voted Nay' : 'Vote Nay', 'nay', [...base, st.youVoted === 'nay' ? 'You have voted Nay on this motion.' : '']),
            make('close', 'Close motion', 'close', [...base, st.closeable ? '' : 'Available once the vote is decided or has ended.'])
        ];
        out.reason = base.find(Boolean) || '';
        out.connect = open && !who;
        out.youVoted = st.youVoted;
        if (open && st.youVoted) out.mine = `Your current vote: ${st.youVoted === 'aye' ? 'Aye' : 'Nay'}. Voting the other way changes it.`;
        if (open && isMember && st.closeable) out.note = 'The vote is decided or has ended: any member can close the motion, which runs the call if it passed.';
        return out;
    }
    return out;
}

// h: { esc, connectPrompt?() -> trusted html }. Every text goes through esc.
export function renderGovActions(model, h) {
    if (!model || !model.kind) return '';
    const esc = h.esc;
    const spin = `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i> `;
    const btns = model.buttons.map(b => {
        const cls = b.tone === 'second' ? 'motion-btn gd-act-second' : `motion-btn ${b.tone}`;
        const title = b.reason ? ` title="${esc(b.reason)}"` : '';
        return `<button type="button" class="${cls}" data-gd-act="${esc(b.act)}"${b.enabled ? '' : ' disabled'}${b.pressed ? ' aria-busy="true"' : ''}${title}>${b.pressed ? spin : ''}${esc(b.label)}</button>`;
    }).join('');
    const reason = model.reason ? `<p class="gd-muted gd-act-reason">${esc(model.reason)}</p>` : '';
    const connect = model.connect && h.connectPrompt ? `<p class="gd-act-connect">${h.connectPrompt()}</p>` : '';
    const mine = model.mine ? `<p class="gd-mine">${esc(model.mine)}</p>` : '';
    const note = model.note ? `<p class="gd-muted gd-small">${esc(model.note)}</p>` : '';
    const chip = model.chip ? `<div class="motion-pending-chip" role="status">${spin}${esc(model.chip)}</div>` : '';
    const error = model.error ? `<div class="motion-tx-error" role="alert">${esc(model.error)}</div>` : '';
    return `<section class="gd-section gd-actions-panel" aria-labelledby="gd-actions-h">
        <h2 id="gd-actions-h" class="gd-h">Actions ${h.helpIcon ? h.helpIcon('governance-item-pages', 'Voting from this page') : ''}</h2>
        ${btns ? `<div class="gd-act-row">${btns}</div>` : ''}
        ${reason}${connect}${mine}${chip}${error}${note}
    </section>`;
}
