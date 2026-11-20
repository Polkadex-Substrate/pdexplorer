// Validator setup in separate steps: the stepper's markup (wizard step 5,
// w.mode = 'stepwise' in lib/validator-setup-view.js, which runs it). DOM-free:
// one function from a view model to HTML, so every state S0 to S10 of the spec
// (cto-team/plans/2026-11-20-validator-setup-three-step-fallback.md, 3.2 and 7)
// is rendered the same way in the page, the tests and the static preview.
//
// Brand: one primary per state (Sign, Add to the bond, or the status link),
// every status a word (validate-word), "Done on chain" neutral with no green,
// is-error only for "Failed on chain" and "Blocked". No inline styles; Boxicons.

import { SW, STEP_WORDS, stepText } from './validator-setup-steps.js';
import { reviewItems, SLASH_ACK, timingText } from './validator-setup.js';

const WORD_OF = { S0: 'ready', S4: 'ready', S9: 'ready', S1: 'wallet', S2: 'sent', S3: 'checking', S5: 'notSigned', S6: 'failed', S7: 'notConfirmed', S8: 'blocked' };
const BUSY = { S1: 'Waiting for wallet', S2: 'Broadcasting' };
export const SIGNABLE_STATES = Object.freeze(['S0', 'S4', 'S5', 'S9']);

// The status line for a state (always names the step number, section 7).
export function stepwiseStatus(v) {
    const { s, k, plan } = v;
    const next = v.gate && v.gate.next ? stepText(v.gate.next, v.shortAddr) : '';
    const keysLine = v.gate && v.gate.next && v.gate.next.kind === 'setKeys' ? ' ' + SW.keysHint : '';
    // SW-46b replaces SW-40 or SW-42 for the paint after Check again found the sent step still missing.
    if ((s === 'S0' || s === 'S4') && v.sentAgain) return SW.sentNotOnChain(k) + keysLine;
    if (s === 'S0') return SW.ready(next) + keysLine;
    if (s === 'S1') return `Step ${k}: ${STEP_WORDS.wallet}.`;
    if (s === 'S2') return `Step ${k}: ${STEP_WORDS.sent}.`;
    if (s === 'S3') return SW.checking(k);
    // Never "Step 0 is confirmed": with no step before this one the view is S0 (review finding 2).
    const prev = v.prevK || k - 1;
    if (s === 'S4' && prev < 1) return stepwiseStatus({ ...v, s: 'S0' });
    if (s === 'S4') return (v.blockNo ? SW.nextAfter(prev, v.blockNo, next) : SW.nextAfterNoBlock(prev, next)) + keysLine;
    if (s === 'S5') return SW.notSigned(k);
    if (s === 'S6') return SW.failedOnChain(k, v.reason);
    if (s === 'S7') return SW.notConfirmed(k) + (v.repeatS7 ? ' ' + SW.stillNotOnChain : '');
    if (s === 'S9') return v.gate ? v.gate.notice : '';
    if (s === 'S10') return v.gate && v.gate.short ? SW.doneShort(plan.steps.length, v.gate.short) : SW.done(plan.steps.length);
    return '';
}

// v: { plan, s, k, gate, ack, D, reason, block, blockNo, prevK, confirmedAny, repeatS7, sentAgain, keysTable (html),
//      error (a wallet message for S5), params, stop: { text, link } }
export function stepwiseHtml(v, esc) {
    const { plan, s } = v;
    const n = plan.steps.length;
    const k = v.k || 1;
    const remaining = new Set(((v.gate && v.gate.remaining) || plan.steps).map(x => x.kind));
    const items = reviewItems(plan.steps, { shortAddr: v.shortAddr });
    const rows = plan.steps.map((step, i) => {
        const cur = i + 1 === k && s !== 'S10';
        const done = s === 'S10' || (!remaining.has(step.kind) && !cur);
        const key = done ? 'done' : cur ? WORD_OF[s] || 'waiting' : 'waiting';
        const err = key === 'failed' || key === 'blocked';
        const icon = key === 'done' ? '<i class=\'bx bx-check\' aria-hidden="true"></i> ' : key === 'wallet' || key === 'sent' || key === 'checking' ? '<i class=\'bx bx-loader-alt\' aria-hidden="true"></i> '
            : err ? '<i class=\'bx bx-error-circle\' aria-hidden="true"></i> ' : '';
        return `<li class="validate-stepwise-step"${cur ? ' aria-current="step"' : ''}><span class="validate-review-text">${esc(items[i].text)}</span> <code class="mono">${esc(items[i].call)}</code> `
            + `<span class="validate-word ${err ? 'is-error' : 'is-neutral'}">${icon}${esc(STEP_WORDS[key])}</span></li>`;
    }).join('');
    const has = (kind) => plan.steps.some(x => x.kind === kind);
    const bondIdx = plan.steps.findIndex(x => x.kind === 'bond' || x.kind === 'bondExtra');
    const keysIdx = plan.steps.findIndex(x => x.kind === 'setKeys');
    let panel;
    if (v.confirmedAny || s === 'S10') panel = `<p class="validate-setup-note">${esc(SW.panelStay)}</p>`;
    else {
        const lines = [SW.panelStay];
        if (keysIdx >= 0 && bondIdx > keysIdx) lines.push(SW.panelKeys);
        if (bondIdx >= 0 && has('validate')) lines.push(SW.panelBond(plan.bond > 0n ? plan.bond : plan.extra, v.D));
        lines.push(SW.panelReturn);
        panel = '<div class="validate-warnings validate-stepwise-panel">' + (n > 1 ? `<p class="validate-stepwise-panel-title">${esc(SW.panelTitle)}</p>` : '')
            + '<ul>' + lines.map(t => `<li>${esc(t)}</li>`).join('') + '</ul></div>';
    }
    const busy = s === 'S1' || s === 'S2';
    const locked = busy || s === 'S3';
    const status = s === 'S8' ? '' : stepwiseStatus(v);
    const alert = s === 'S8' ? (v.block || '') : s === 'S6' && v.gate && v.gate.block ? v.gate.block : '';
    const showKeys = v.keysTable && !locked && v.gate && v.gate.next && v.gate.next.kind === 'setKeys' || (v.keysTable && locked && plan.steps[k - 1] && plan.steps[k - 1].kind === 'setKeys');
    const signBtn = (enabled) => `<button type="button" class="validate-primary" data-setup-action="step-sign"${busy ? ' aria-busy="true"' : ''}${enabled ? '' : ' disabled'}>`
        + (busy ? `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i> ${esc(BUSY[s])}` : esc(SW.sign(k, n))) + '</button>';
    const back = (enabled) => `<button type="button" class="validate-text-btn" data-setup-action="step-back"${enabled ? '' : ' disabled'}>${esc(SW.back)}</button>`;
    const check = '<button type="button" class="validate-secondary" data-setup-action="step-check">' + esc(SW.checkAgain) + '</button>';
    const actions = [];
    if (s === 'S0') actions.push(signBtn(!!v.ack), back(true));
    else if (busy) actions.push(signBtn(false), back(false));
    else if (s === 'S3') actions.push(back(false));
    else if (s === 'S4' || s === 'S5') actions.push(signBtn(true), back(true));
    else if (s === 'S6') { if (v.gate && v.gate.next && v.gate.k === k && !v.gate.block && !v.gate.unconfirmed) actions.push(signBtn(true)); actions.push(check, back(true)); }
    else if (s === 'S7') actions.push(check);
    else if (s === 'S8') {
        if (v.gate && v.gate.blockId === 'SW-49') actions.push(`<button type="button" class="validate-primary" data-setup-action="step-add-bond">${esc(SW.addBond)}</button>`);
        if (v.retry) actions.push(check);
        actions.push(back(true));
    } else if (s === 'S9') actions.push(signBtn(true), `<button type="button" class="validate-text-btn" data-setup-action="step-add-bond">${esc(SW.addRest)}</button>`);
    else if (s === 'S10') actions.push('<a href="/validate" class="validate-primary" data-spa-link="true">Open validator status</a>');
    const ackBox = !v.confirmedAny && (s === 'S0' || (s === 'S1' && k === 1))
        ? `<p class="validate-ack"><input type="checkbox" id="validate-setup-ack"${v.ack ? ' checked' : ''}${busy ? ' disabled' : ''}> <label for="validate-setup-ack">${esc(SLASH_ACK)}</label></p>` : '';
    const stop = s !== 'S10' && v.stop ? `<p class="validate-setup-note">${esc(v.stop.text)}</p>`
        + (v.stop.link ? `<a href="/wallet" class="item-link" data-spa-link="true">${esc(SW.walletLink)}</a>` : '') : '';
    const [pre, post] = SW.stashLine('\u0000').split('\u0000');
    return `<p class="validate-stepwise-stash">${esc(pre)}<span class="mono">${esc(plan.stash)}</span>${esc(post)}</p>`
        + `<p>${esc(SW.intro(n, v.totalFee))}</p>`
        + panel
        + `<ol class="validate-stepwise">${rows}</ol>`
        + (showKeys ? v.keysTable : '')
        + `<p id="validate-stepwise-status" class="validate-stepwise-status" aria-live="polite" tabindex="-1">${esc(status)}</p>`
        + (s === 'S5' && v.error ? `<p class="validate-msg">${esc(v.error)}</p>` : '')
        + (alert ? `<div class="validate-alert" role="alert">${esc(alert)}</div>` : '')
        + (s === 'S10' ? `<p>${esc(timingText(v.params || {}))}</p>` : '')
        + stop
        + ackBox
        + `<div class="validate-setup-actions validate-stepwise-actions">${actions.join(' ')}</div>`;
}
