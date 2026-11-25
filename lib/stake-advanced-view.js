// The Stake PDEX card's advanced view (WP3 of design 2026-11-22-stake-card-simple-and-advanced.md,
// sections 5, 6, 7 and 8; CEO decisions of 2026-11-23): the rewards group, "Your selection" (its rows, its
// past return, its warnings and "Use the automatic choice"), "What you will sign" and the state panels.
//
// Pure markup and models; lib/stake-card-view.js owns the state and the events, and both views read the
// same state and the same plan (lib/stake-plan.js planStakeCalls, rule M6).
//
// "Call details" is decoded from the transaction buildStakeTx built, never re-described from the plan
// (builtCalls below): what the disclosure lists is what the wallet is asked to sign. The return shown is
// the realized 28-era figure or "No history yet" / "No estimate" (M10).

import { icon, linePanelHtml } from './ui-parts.js';
import { stakeCopy, planckToPdexGrouped } from './stake-plan.js';
import { returnEstimate, PICK_WINDOW, LOW_RETURN_RATIO } from './stake-pick.js';
import { validatorChips, chipHtml, returnHtml } from './stake-picker-view.js';
import { perfFor } from './stake-filters.js';

const t = (id, p) => stakeCopy(id, p);
const sc = (id, text, esc, tag = 'span', cls = '') => `<${tag}${cls ? ` class="${cls}"` : ''} data-sc="${id}">${esc(text)}</${tag}>`;
const pct1 = (x) => Number(x).toFixed(1);
const CALL_DETAILS = 'Call details';
const WRAPPERS = new Set(['utility.batchAll', 'utility.batch', 'utility.forceBatch']);

// ── Call details: the built transaction, decoded ──
// tx: what buildStakeTx returned (an extrinsic, or a bare call). Each argument as the runtime holds it:
// balances in planck with the PDEX figure, the rewards destination by its variant, the targets as the
// addresses the call carries. null when it is not a decodable call.
export function builtCalls(tx) {
    const top = tx && tx.method && typeof tx.method.section === 'string' ? tx.method : tx;
    if (!top || typeof top.section !== 'string' || !top.args) return null;
    const key = (c) => `${c.section}.${c.method}`;
    const wrapper = WRAPPERS.has(key(top)) ? key(top) : null;
    const list = wrapper ? Array.from(top.args[0] || []) : [top];
    return { wrapper, calls: list.map(c => ({ name: key(c), args: Array.from(c.args || []).map((a, i) => argOf(a, c.meta && c.meta.args ? c.meta.args[i] : null)) })) };
}
function argOf(a, meta) {
    const name = meta && meta.name ? meta.name.toString() : '';
    const type = meta && meta.type ? meta.type.toString() : '';
    if (a && typeof a.isStaked === 'boolean') return { name, text: a.isAccount ? `Account ${a.asAccount.toString()}` : String(a.type) };
    if (Array.isArray(a) || (a && typeof a.map === 'function' && /^Vec</.test(type))) {
        return { name, targets: Array.from(a).map(x => (x && x.isId ? x.asId.toString() : String(x))) };
    }
    if (/u128|Balance/.test(type) && a && typeof a.toBigInt === 'function') {
        const v = a.toBigInt();
        return { name, text: `${v} (${planckToPdexGrouped(v)} PDEX)` };
    }
    return { name, text: a == null ? '' : String(a) };
}
export function callsHtml(b, esc) {
    if (!b) return '';
    const arg = (a) => (a.targets
        ? ` ${esc(a.name)}<ol class="stake-call-targets">${a.targets.map(x => `<li data-addr="${esc(x)}"><code>${esc(x)}</code></li>`).join('')}</ol>`
        : ` ${esc(a.name)} ${esc(a.text)}`);
    return `<ol class="stake-calls"${b.wrapper ? ` data-wrapper="${esc(b.wrapper)}"` : ''}>`
        + b.calls.map(c => `<li data-call="${esc(c.name)}"><code>${esc(c.name)}</code>${c.args.map(arg).join(',')}</li>`).join('') + '</ol>'
        + (b.wrapper ? `<p class="stake-call-wrapper"><code>${esc(b.wrapper)}</code></p>` : '');
}
export const callDetailsHtml = (b, esc, open) => (b ? `<details class="validate-disclosure stake-call-details"${open ? ' open' : ''}><summary>${esc(CALL_DETAILS)}</summary>${callsHtml(b, esc)}</details>` : '');

// ── Rewards (5.2): the radio group and the address field ──
// r: { enabled, failed, current: 'staked' | 'stash' | 'account' | null, account }. Built once per
// setting read (the field keeps what is typed); lib/stake-card-view.js syncs the checked radio, the field
// and its message on every render.
export function rewardsHtml(r, esc) {
    const radio = (value, id) => `<label class="stake-payee-opt"><input type="radio" name="stake-payee" value="${value}"${r.enabled && r.current === value ? ' checked' : ''}>`
        + `${sc(id, t(id), esc)}</label>`;
    return sc('SC-62', t('SC-62'), esc, 'h4', 'stake-section-head')
        + (r.failed ? linePanelHtml('is-warn', 'bx-error', sc('SC-14e', t('SC-14e'), esc)) : '')
        + `<fieldset class="stake-payee"${r.enabled ? '' : ' disabled'}><legend data-sc="SC-65">${esc(t('SC-65'))}</legend>`
        + radio('staked', 'SC-66') + radio('stash', 'SC-67') + radio('account', 'SC-68')
        + `<div class="stake-payee-account"${r.enabled && r.current === 'account' ? '' : ' hidden'}>`
        + `<label class="stake-label" for="stake-payee-account" data-sc="SC-69">${esc(t('SC-69'))}</label>`
        + `<div class="stake-amount-wrap"><input type="text" id="stake-payee-account" data-input-kind="address" autocomplete="off" spellcheck="false" aria-describedby="stake-payee-msg" value="${esc(r.account || '')}"></div>`
        + '<p id="stake-payee-msg" class="stake-payee-msg" aria-live="polite"></p></div></fieldset>';
}
// The field's line: the short address echoed when it is valid, SC-71 when it is not, nothing when empty.
export function payeeMessageHtml(value, { valid, esc, short }) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (valid) return `<span class="stake-payee-echo">${esc(short(v))}</span>`;
    return `<span class="validate-msg is-error">${icon('bx-error-circle')}${sc('SC-71', t('SC-71'), esc)}</span>`;
}

// ── Your selection (5.2; states 5 to 7) ──
function find(byAddress, a, same) {
    if (!byAddress) return null;
    const hit = byAddress.get(String(a));
    if (hit) return hit;
    for (const [k, v] of byAddress) if (same(k, a)) return v;
    return null;
}
const realized28 = (v) => { const p = perfFor(v, PICK_WINDOW); return p && p.status === 'ok' && Number.isFinite(p.apr) && p.apr > 0 ? p.apr : null; };

//   targets   the selection [{ address, name }]          byAddress  the snapshot rows (null: no list)
//   full      the snapshot has returns                   median     the automatic choice's pool median
//   chosen    addresses the rule put in the selection    quota      the chain's nominations quota
//   auto      the rule's picks (addresses), or null      confirm    SC-40 is open
export function selectionModel({ targets = [], byAddress = null, full = false, median = null, same = (a, b) => a === b, short = (a) => a, chosen = new Set(), quota = null, auto = null, confirm = false }) {
    const n = targets.length;
    const rows = targets.map(r => {
        const v = find(byAddress, r.address, same);
        const label = r.name && r.name !== 'Unknown' ? r.name : v && v.name && v.name !== 'Unknown' ? v.name : short(r.address);
        return { address: r.address, name: label, v, chosen: chosen.has(r.address) };
    });
    const m = { head: t('SC-74', { n, max: quota == null ? '' : quota }), rows, empty: n ? null : t('SC-76'), ret: null, warnings: [], auto: null };
    if (full && byAddress && n) {
        const est = returnEstimate(targets.map(r => r.address), byAddress, PICK_WINDOW, same);
        if (est.none) m.ret = { none: est.none === 'no-history' ? 'SC-24a' : 'SC-24b' };
        else {
            const lo = pct1(est.low), hi = pct1(est.high);
            m.ret = { value: lo === hi ? { id: 'SC-21b', text: t('SC-21b', { x: lo }) } : { id: 'SC-21', text: t('SC-21', { low: lo, high: hi }) }, basis: t('SC-22', { n: est.counted }) };
        }
        const found = rows.filter(r => r.v);
        const inactive = found.filter(r => r.v.active === false).length;
        if (inactive) m.warnings.push({ id: 'SC-90', role: 'warn', text: t('SC-90', { k: inactive, n }) });
        const noHistory = rows.filter(r => !r.v || realized28(r.v) == null).length;
        if (noHistory && m.ret && !m.ret.none) m.warnings.push({ id: 'SC-91', role: 'warn', text: t('SC-91', { k: noHistory }) });
        if (Number(median) > 0) for (const r of found) { const x = realized28(r.v); if (x != null && x < Number(median) * LOW_RETURN_RATIO) m.warnings.push({ id: 'SC-92', role: 'warn', text: t('SC-92', { name: r.name }) }); }
        for (const r of found) if (r.v.blocked) m.warnings.push({ id: 'SC-93', role: 'error', text: t('SC-93', { name: r.name }) });
    }
    const same2 = (a, b) => a.length === b.length && a.every(x => b.some(y => same(x, y)));
    if (auto && auto.length && !same2(auto, targets.map(r => r.address))) m.auto = { confirm: confirm && n ? t('SC-40', { n, m: auto.length }) : null };
    return m;
}

export function selectionRowsHtml(m, esc, { full = false, median = null } = {}) {
    if (!m.rows.length) return `<div class="stake-empty" data-sc="SC-76">${esc(m.empty)}</div>`;
    return m.rows.map(r => {
        const ret = r.v ? returnHtml(r.v, { esc, window: PICK_WINDOW, full }) : full ? chipHtml('nohistory', esc) : '';
        const chips = r.v ? validatorChips(r.v, { window: PICK_WINDOW, full, median, selected: true, chosen: r.chosen }).filter(([k]) => k !== 'nohistory').map(([k, title]) => chipHtml(k, esc, title)) : [];
        const meta = [ret, chips.join(' ')].filter(Boolean).join(' ');   // no separator before a chip (fidelity review S9)
        return `<div class="stake-validator-item selected" data-addr="${esc(r.address)}"><div class="stake-val-info"><div class="stake-val-name">${esc(r.name)}</div>`
            + (meta ? `<div class="stake-val-meta">${meta}</div>` : '')
            + `</div><button type="button" class="stake-val-remove" data-stake-action="remove" aria-label="Remove">×</button></div>`;
    }).join('');
}

export function selectionExtraHtml(m, esc) {
    const out = [];
    if (m.ret) {
        const v = m.ret.none ? sc(m.ret.none, t(m.ret.none), esc, 'span', 'stake-return-none') : sc(m.ret.value.id, m.ret.value.text, esc, 'strong', 'stake-return-value');
        out.push(`<section class="stake-return"><div class="stake-return-head">${sc('SC-20', t('SC-20'), esc, 'span', 'stake-return-label')}${v}</div>`
            + (m.ret.basis ? sc('SC-22', m.ret.basis, esc, 'p', 'stake-return-basis') : '') + '</section>');
    }
    for (const w of m.warnings) {
        out.push(w.role === 'error' ? linePanelHtml('is-error', 'bx-error-circle', sc(w.id, w.text, esc)) : linePanelHtml('is-warn', 'bx-error', sc(w.id, w.text, esc)));
    }
    if (m.auto) {
        out.push(`<button type="button" class="validate-secondary stake-auto-btn" data-stake-action="auto" data-sc="SC-43">${icon('bx-refresh')}${esc(t('SC-43'))}</button>`);
        if (m.auto.confirm) {
            out.push(`<div class="ui-panel is-warn stake-confirm" role="group" aria-labelledby="stake-confirm-text">${icon('bx-error')}<div class="ui-panel-body">`
                + `<p id="stake-confirm-text" data-sc="SC-40">${esc(m.auto.confirm)}</p><div class="stake-confirm-actions">`
                + `<button type="button" class="validate-secondary" data-stake-action="auto-replace" data-sc="SC-41">${esc(t('SC-41'))}</button>`
                + `<button type="button" class="validate-secondary" data-stake-action="auto-keep" data-sc="SC-42">${esc(t('SC-42'))}</button></div></div></div>`);
        }
    }
    return out.join('');
}

// ── What you will sign (5.2): one plain line per call of the plan, then Call details, then SC-70 next to
// the primary when rewards go to an account that is not this one (M9). ──
export function signHtml({ lines = [], built = null, caution = false }, esc, { callsOpen = false } = {}) {
    if (!lines.length && !caution) return '';
    return sc('SC-64', t('SC-64'), esc, 'h4', 'stake-section-head')
        + (lines.length ? `<ul class="stake-plan-lines">${lines.map(l => `<li>${icon('bx-check')}${esc(l)}</li>`).join('')}</ul>` : '')
        + callDetailsHtml(lines.length ? built : null, esc, callsOpen)
        + (caution ? linePanelHtml('is-warn', 'bx-error', sc('SC-70', t('SC-70'), esc)) : '');
}

// The state panels at the top of Advanced: SC-115 (cannot stake), SC-140 (staked, no validators) and
// SC-39 (the list changed) or SC-39b (the account changed), the same panels the simple view draws.
export function notesHtml(panels, esc) {
    return (panels || []).map(p => {
        if (p.kind === 'cannot') return `<div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">${sc('SC-115', p.text, esc, 'p')}</div></div>`;
        if (p.kind === 'warn') return `<div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">${sc(p.id, p.text, esc, 'p')}</div></div>`;
        if (p.kind === 'changed') return `<p class="ui-panel is-info is-line" role="status" data-sc="${p.id || 'SC-39'}">${icon('bx-info-circle')}<span class="ui-panel-body">${esc(p.text)}</span></p>`;
        return '';
    }).join('');
}

