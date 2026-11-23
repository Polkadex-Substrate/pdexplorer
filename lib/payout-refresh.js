// The wallet page's payout part after a payout (UX spec cto-team/plans/2026-11-22-post-action-refresh-ux.md,
// sections 2, 4, 5 and 7; design R1): the Unpaid Rewards tile, the Pay Out button and the payout modal,
// drawn from the server's list with what the block PROVED applied on top (lib/known-results.js), and
// patched IN PLACE when a result arrives: no remount, the button node kept (focus), other forms untouched.
//
// DOM-light: pure markup builders and a model, plus paint(), which only touches the tile value, the
// tile's label mark, the button's aria state and sublabel, one line at the top of the card (reorg), the
// open modal's rows, and the shared live region. It never sets or clears the button's `disabled`: a button
// blocked by a failed refresh stays blocked, and a proven-done button uses aria-disabled so focus can stay
// on it (U4, U6).
//
// What the user sees, by model.button:
//   none        the server lists nothing (today's look: disabled, "0 unclaimed entries")
//   enabled     "N unclaimed entries", N counts only entries that may be signed
//   empty       every listed entry proven paid: today's empty words, aria-disabled (U6, D1)
//   checking    every remaining entry touched without proof: S10, S10t, aria-disabled (U6, U7, D2)
//   inProgress  the payout's block was replaced and it is being re-sent: S18, aria-disabled (U12)
//
// R2: the server's freshness (the wallet payload's `freshness`, lib/freshness.js) decides when the overlay
// is over. A Checking hold ends as soon as the server has caught up with its block (listed: a normal row
// again, S19). A proven-paid row the caught-up server still lists stays out and the page says it may be
// behind (S14, S15): never offered again, never silent (F7). So does a list the server has not brought up to
// the block within the poll deadline. The component subscribes to every domain /api/wallet serves, and on a
// poll attempt re-reads it through `refetch(address)` (the page's dashboard reload, which resolves to the
// new freshness); a plain repaint never re-reads.

import { say, nounFor, STRINGS, REFRESH_UI } from './refresh-ui.js';
import { chipHtml, linePanelHtml, setChip } from './ui-parts.js';
import { caughtUp, pollDeadlineMs } from './freshness.js';

export const PAYOUT_DOMAIN = 'rewards.unpaid';
// What /api/wallet serves: one re-read of it brings every one of these up to date.
export const WALLET_DOMAINS = Object.freeze(['balance', 'staking.ledger', 'staking.nominations', 'rewards.unpaid', 'rewards.claimed', 'tx.recent']);
export const pairKey = (e) => `${e.era}:${e.validator}`;
// Today's words for the button (script.js before R1), kept byte for byte.
const EMPTY_TITLE = 'No unclaimed rewards to pay out.';
const entriesWord = (n, number) => `${number(n)} unclaimed entr${n === 1 ? 'y' : 'ies'}`;
const sum = (rows) => rows.reduce((t, e) => t + (Number(e.amount) || 0), 0);

// rewards: the server's block (/api/wallet rewards); applied: known.apply(...) for this account.
export function payoutModel(rewards, applied = {}) {
    const r = rewards || {};
    const entries = Array.isArray(r.unpaidEntries) ? r.unpaidEntries : [];
    const keysOf = (list) => new Set((list || []).map(e => e.key));
    const removedKeys = keysOf(applied.removed), heldKeys = keysOf(applied.held), expiredKeys = keysOf(applied.expired);
    const removedRows = entries.filter(e => removedKeys.has(pairKey(e)));
    const listed = entries.filter(e => !removedKeys.has(pairKey(e)));
    const held = listed.filter(e => heldKeys.has(pairKey(e)));
    const payable = listed.filter(e => !heldKeys.has(pairKey(e)));
    const base = Number.isFinite(Number(r.unpaidCount)) && r.unpaidCount != null ? Number(r.unpaidCount) : entries.length;
    const count = Math.max(0, base - removedRows.length);
    const payableCount = Math.max(0, count - held.length);
    const serverTotal = Number(r.unpaidTotal) || 0;
    const total = removedRows.length ? (count === 0 ? 0 : Math.max(0, serverTotal - sum(removedRows))) : serverTotal;
    const payableTotal = held.length ? Math.max(0, total - sum(held)) : total;
    const reorg = applied.reorg || null;
    // May be behind: a hold or a proven row past its bound that the server still lists, a proven-paid row the
    // caught-up server still lists (F7), or entries whose block the server has not reached by the deadline.
    const behind = payable.some(e => expiredKeys.has(pairKey(e))) || (applied.lagging || []).length > 0 || (applied.late || []).length > 0;
    const button = reorg ? 'inProgress' : payableCount > 0 ? 'enabled' : held.length ? 'checking' : removedRows.length ? 'empty' : 'none';
    const state = reorg ? 'reorg' : behind ? 'could-not-refresh' : (removedRows.length || held.length) ? 'known-result' : 'current';
    const blocks = Object.fromEntries((applied.removed || []).map(e => [e.key, e.block]));
    return { entries, listed, payable, held, removedRows, count, payableCount, total, payableTotal, button, state, reorg, blocks,
        // what may be signed now: nothing while a replaced payout is being re-sent
        signable: reorg ? [] : payable };
}

// F2: what a click on Sign signs. Never more than the modal lists: the rows SHOWN (their data-key, in the
// order shown) that are still signable. A row signable now but not shown (a hold that ended while the modal
// was open) is never added; a shown row that is no longer signable (proven paid since, or held) is left
// out, so it cannot fail AlreadyClaimed and add fee. Chosen over refusing because refusing needs words the
// spec does not have, and this set is always a subset of what the user read.
export function payoutSignSet(signable, shownKeys) {
    const byKey = new Map((signable || []).map(e => [pairKey(e), e]));
    const out = [];
    const seen = new Set();
    for (const k of shownKeys || []) {
        if (seen.has(k) || !byKey.has(k)) continue;
        seen.add(k);
        out.push(byKey.get(k));
    }
    return out;
}

export function createPayoutRefresh({ doc, known, post, data, same = (a, b) => a === b, fmt, now = Date.now, refetch = null }) {
    const { pdex, number, short, esc } = fmt;
    const applyFor = (d) => (d && d.address
        ? known.apply(PAYOUT_DOMAIN, d.address, (d.rewards && d.rewards.unpaidEntries) || [], { keyOf: pairKey,
            freshness: d.freshness, caughtUp, lateMs: pollDeadlineMs(PAYOUT_DOMAIN, d.freshness) })
        : { removed: [], held: [], expired: [], lagging: [], late: [], reorg: null });
    const model = (d) => payoutModel(d && d.rewards, applyFor(d));

    function buttonParts(m) {
        if (m.button === 'none') return { disabled: true, aria: false, title: EMPTY_TITLE, sub: entriesWord(0, number), why: '' };
        if (m.button === 'empty') return { disabled: false, aria: true, title: EMPTY_TITLE, sub: entriesWord(0, number), why: '' };
        if (m.button === 'checking') return { disabled: false, aria: true, title: STRINGS.S10t, sub: say('S10', { n: m.held.length }), why: STRINGS.S10t };
        if (m.button === 'inProgress') return { disabled: false, aria: true, title: null, sub: STRINGS.S18, why: '' };
        return { disabled: false, aria: false, title: null, sub: entriesWord(m.payableCount, number), why: '' };
    }
    // What the page draws is what the next change is compared with (so a fresh load announces nothing).
    let last = null;   // { address, removed, held, reorg }
    const remember = (d, m) => { if (d && d.address) last = { address: d.address, removed: m.removedRows.length, held: m.held.length, reorg: !!m.reorg }; };
    function buttonHtml(d) {
        const m = model(d);
        remember(d, m);
        const p = buttonParts(m);
        const attrs = (p.disabled ? ` disabled title="${esc(p.title)}"` : '')
            + (p.aria ? ` aria-disabled="true"${p.title ? ` title="${esc(p.title)}"` : ''}` : '')
            + (p.why ? ' aria-describedby="wallet-payout-why"' : '');
        return `<button class="wallet-action-btn" id="wallet-act-payout"${attrs}>
                    <i class='bx bx-gift'></i>
                    <div><strong>Pay out rewards</strong><span>${esc(p.sub)}</span></div>
                </button><span id="wallet-payout-why" class="sr-only">${esc(p.why)}</span>`;
    }
    const behindMark = (m) => m.state === 'could-not-refresh';
    const markHtml = (m) => (behindMark(m) ? chipHtml('is-wait is-bare', 'bx-error', STRINGS.S14, esc) : '');
    // A figure that may be behind is not drawn in the brand colour (S14 shows next to it).
    const valueColour = (m) => (behindMark(m) ? 'var(--text-primary)' : 'var(--brand-primary)');
    // Today's "computing" note, shown whenever the server does not say the unclaimed list is fresh.
    const valueHtml = (m, d) => `${pdex(m.total)} PDEX${d && d.rewards && d.rewards.unclaimedFresh ? '' : ' <span style="font-size:0.6rem;color:var(--text-muted);">computing…</span>'}`;
    function tileHtml(d) {
        const m = model(d);
        remember(d, m);
        return `<div class="staking-summary-card" id="wallet-unpaid-tile"><div class="label" id="wallet-unpaid-label">Unpaid Rewards${markHtml(m)}</div><div class="value" id="wallet-unpaid-value" style="color:${valueColour(m)};">${valueHtml(m, d)}</div></div>`;
    }
    const rowHtml = (e) => `<div class="payout-entry" data-key="${esc(pairKey(e))}">
            <div><span class="payout-era">Era ${number(e.era)}</span> <a href="/validator/${encodeURIComponent(e.validator)}" class="item-link" style="color:var(--brand-secondary);font-size:0.78rem;">${short(e.validator)}</a></div>
            <div class="payout-amt">${pdex(e.amount)} PDEX</div>
        </div>`;
    const rowsHtml = (entries) => (entries || []).map(rowHtml).join('');

    // S15: the first line of a modal opened from a list that may be behind (the hold ended without an answer).
    function modalLine(m) {
        const modal = doc.getElementById('payout-modal');
        if (!modal) return;
        const old = modal.querySelector('#payout-behind-line');
        if (m.state !== 'could-not-refresh') { if (old) old.remove(); return; }
        if (old) return;
        const summary = modal.querySelector('.payout-summary');
        if (summary) summary.insertAdjacentHTML('beforebegin', linePanelHtml('is-warn', 'bx-error', esc(STRINGS.S15), ' id="payout-behind-line"'));
    }

    // The shared polite region (UX section 4): at most one message per 5 s, later ones merge.
    let lastSaid = { at: -Infinity, text: '' };
    function announce(text) {
        if (!text) return;
        let el = doc.getElementById('post-action-live');
        if (!el) {
            el = doc.createElement('div');
            el.id = 'post-action-live'; el.className = 'sr-only';
            el.setAttribute('aria-live', 'polite'); el.setAttribute('aria-atomic', 'true');
            doc.body.appendChild(el);
        }
        const t = now();
        const merged = t - lastSaid.at < REFRESH_UI.announceGapMs ? `${lastSaid.text} ${text}` : text;
        lastSaid = { at: t - lastSaid.at < REFRESH_UI.announceGapMs ? lastSaid.at : t, text: merged };
        el.textContent = merged;
    }

    function wash(el) {
        el.classList.remove('is-value-changed');
        void el.offsetWidth;   // restart the one-shot wash
        el.classList.add('is-value-changed');
    }
    function applyButton(btn, m) {
        const p = buttonParts(m);
        const span = btn.querySelector('span');
        if (span && span.textContent !== p.sub) span.textContent = p.sub;
        if (p.aria) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
        if (p.why) btn.setAttribute('aria-describedby', 'wallet-payout-why'); else btn.removeAttribute('aria-describedby');
        const why = doc.getElementById('wallet-payout-why');
        if (why && why.textContent !== p.why) why.textContent = p.why;
        if (btn.disabled) return;   // blocked by a failed refresh, or empty from the server: its title stays
        if (p.title) btn.setAttribute('title', p.title); else btn.removeAttribute('title');
    }
    function reorgLine(m, tile) {
        const card = tile && tile.closest('.list-container');
        const old = doc.getElementById('wallet-payout-reorg');
        if (!m.reorg) { if (old) old.remove(); return; }
        if (old || !card) return;
        const grid = tile.closest('.staking-summary-grid');
        const html = linePanelHtml('is-warn', 'bx-error', esc(say('S17', { payout: nounFor(m.reorg.value) })), ' id="wallet-payout-reorg"');
        if (grid) grid.insertAdjacentHTML('beforebegin', html); else card.insertAdjacentHTML('afterbegin', html);
    }
    function refreshModal(m) {
        const modal = doc.getElementById('payout-modal');
        if (!modal || modal.style.display === 'none') return;
        const submit = doc.getElementById('submit-payout-tx-btn');
        if (submit && submit.getAttribute('aria-busy') === 'true') return;   // signing the list it opened with
        const list = doc.getElementById('payout-entries');
        const want = m.signable;
        const wantKeys = want.map(pairKey);
        if (list) {
            const rows = Array.from(list.querySelectorAll('.payout-entry[data-key]'));
            const have = rows.map(r => r.getAttribute('data-key'));
            if (wantKeys.every(k => have.includes(k))) rows.forEach(r => { if (!wantKeys.includes(r.getAttribute('data-key'))) r.remove(); });
            else list.innerHTML = rowsHtml(want);
        }
        const count = doc.getElementById('payout-count');
        if (count) count.textContent = number(want.length);
        const total = doc.getElementById('payout-total');
        if (total) total.textContent = pdex(m.reorg ? 0 : m.payableTotal) + ' PDEX';
        if (submit && !want.length) submit.disabled = true;
        modalLine(m);
    }

    function paint(info = {}) {
        if (info.reason === 'render' && typeof post.arm === 'function') post.arm();   // first paint: the store's next bound
        const d = data();
        if (!d || !d.address) { last = null; return null; }
        const m = model(d);
        const tile = doc.getElementById('wallet-unpaid-tile');
        const value = doc.getElementById('wallet-unpaid-value');
        if (value) {
            const html = valueHtml(m, d);
            if (value.innerHTML !== html) { value.innerHTML = html; if (info.reason && info.reason !== 'render') wash(value); }
            if (value.style.color !== valueColour(m)) value.style.color = valueColour(m);
        }
        const label = doc.getElementById('wallet-unpaid-label');
        if (label) {
            const mark = label.querySelector('.ui-chip');
            const want = markHtml(m);
            if (!want && mark) mark.remove();
            else if (want && !mark) label.insertAdjacentHTML('beforeend', want);
            else if (want && !(mark.classList.contains('is-wait') && mark.querySelector('.bx-error') && mark.textContent.trim() === STRINGS.S14)) {
                setChip(mark, 'is-wait', 'bx-error', STRINGS.S14);   // a mark left with another role: role, icon and word together
            }
        }
        const btn = doc.getElementById('wallet-act-payout');
        if (btn) applyButton(btn, m);
        reorgLine(m, tile || value);
        refreshModal(m);
        const prev = last && same(last.address, d.address) ? last : null;
        if (info.origin !== 'other-tab' && prev) {
            if (info.reason === 'inBlock' && info.info) {
                if (m.removedRows.length > prev.removed) announce(say('A1', { n: m.removedRows.length, m: m.count }));
                if (m.held.length > prev.held) announce(say('A2', { n: m.held.length }));
            } else if (info.reason === 'reorg' && m.reorg && !prev.reorg) announce(say('A6', { payout: nounFor(m.reorg.value) }));
        }
        remember(d, m);
        return null;
    }

    // A repaint draws from the page's data and the store; a poll attempt (R2) re-reads the server first and
    // hands its freshness back to the core.
    function reload(i) {
        paint(i);
        if (!i || !i.poll || typeof refetch !== 'function') return null;
        const d = data();
        if (!d || !d.address) return null;
        let r;
        try { r = refetch(d.address); } catch (e) { return null; }
        return Promise.resolve(r).then((f) => { paint({ reason: 'poll' }); return f == null ? null : f; }, () => null);
    }
    post.subscribe(WALLET_DOMAINS.slice(), { account: () => { const d = data(); return d ? d.address : null; }, reload });

    return {
        model, buttonHtml, tileHtml, rowsHtml, modalLine, paint,
        signable: (d) => model(d).signable
    };
}
