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

import { say, nounFor, STRINGS, REFRESH_UI } from './refresh-ui.js';
import { chipHtml, linePanelHtml } from './ui-parts.js';

export const PAYOUT_DOMAIN = 'rewards.unpaid';
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
    const behind = payable.some(e => expiredKeys.has(pairKey(e)));
    const button = reorg ? 'inProgress' : payableCount > 0 ? 'enabled' : held.length ? 'checking' : removedRows.length ? 'empty' : 'none';
    const state = reorg ? 'reorg' : behind ? 'could-not-refresh' : (removedRows.length || held.length) ? 'known-result' : 'current';
    const blocks = Object.fromEntries((applied.removed || []).map(e => [e.key, e.block]));
    return { entries, listed, payable, held, removedRows, count, payableCount, total, payableTotal, button, state, reorg, blocks,
        // what may be signed now: nothing while a replaced payout is being re-sent
        signable: reorg ? [] : payable };
}

export function createPayoutRefresh({ doc, known, post, data, same = (a, b) => a === b, fmt, now = Date.now }) {
    const { pdex, number, short, esc } = fmt;
    const applyFor = (d) => (d && d.address
        ? known.apply(PAYOUT_DOMAIN, d.address, (d.rewards && d.rewards.unpaidEntries) || [], { keyOf: pairKey })
        : { removed: [], held: [], expired: [], reorg: null });
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
    const markHtml = (m) => (m.state === 'could-not-refresh' ? chipHtml('is-wait is-bare', 'bx-error', STRINGS.S14, esc) : '');
    // Today's "computing" note, shown whenever the server does not say the unclaimed list is fresh.
    const valueHtml = (m, d) => `${pdex(m.total)} PDEX${d && d.rewards && d.rewards.unclaimedFresh ? '' : ' <span style="font-size:0.6rem;color:var(--text-muted);">computing…</span>'}`;
    function tileHtml(d) {
        const m = model(d);
        remember(d, m);
        return `<div class="staking-summary-card" id="wallet-unpaid-tile"><div class="label" id="wallet-unpaid-label">Unpaid Rewards${markHtml(m)}</div><div class="value" id="wallet-unpaid-value" style="color:var(--brand-primary);">${valueHtml(m, d)}</div></div>`;
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
        const d = data();
        if (!d || !d.address) { last = null; return null; }
        const m = model(d);
        const tile = doc.getElementById('wallet-unpaid-tile');
        const value = doc.getElementById('wallet-unpaid-value');
        if (value) {
            const html = valueHtml(m, d);
            if (value.innerHTML !== html) { value.innerHTML = html; if (info.reason && info.reason !== 'render') wash(value); }
        }
        const label = doc.getElementById('wallet-unpaid-label');
        if (label) {
            const mark = label.querySelector('.ui-chip');
            const want = markHtml(m);
            if (!want && mark) mark.remove();
            else if (want && !mark) label.insertAdjacentHTML('beforeend', want);
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

    post.subscribe(PAYOUT_DOMAIN, { account: () => { const d = data(); return d ? d.address : null; }, reload: (i) => paint(i) });

    return {
        model, buttonHtml, tileHtml, rowsHtml, modalLine, paint,
        signable: (d) => model(d).signable
    };
}
