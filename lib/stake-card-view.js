// The Stake PDEX card's simple view (WP2 of design 2026-11-22-stake-card-simple-and-advanced.md,
// sections 2, 3, 4.2, 6, 7 and 8; CEO decisions of 2026-11-23).
//
// One state, two views. The amount is the field as typed (never rewritten here: rule M4), the
// selection is the page's one selection (script.js stakeSelected, read and written through
// `selection`), and `origin` says where it came from: 'auto' (the rule), 'manual' (the user, in
// Advanced), 'current' (on chain, untouched) or 'proposal' (a replacement the user asked to see).
// Advanced is today's picker (WP3 restyles it); this module only switches to it and back.
//
// Everything the view says about what will be signed comes from stakeFormPlan (lib/stake-plan.js),
// the same function submitStakeTx signs from (rule M6). The simple view never adds nominate over an
// existing set unless the user pressed "See a replacement" and the difference is on screen, and it
// never plans setPayee (M8): its payee is always 'current'.
//
// The automatic choice is lib/stake-pick.js (eight by the rule, never relaxed: M1). The return shown
// is the realized 28-era figure or "No history yet" / "No estimate" (M10); this file does not read
// the commission-only estimate.

import { icon, linePanelHtml } from './ui-parts.js';
import { stakeCopy, STAKE_COPY, planckToPdexText, pdexNumberToPlanck, transferablePlanckOf, stakeMaxPlanck, STAKE_FEE_RESERVE_PLANCK,
    stakeFormPlan, loadStakeView, saveStakeView, PLANCK_PER_PDEX } from './stake-plan.js';
import { pickValidators, proposeReplacement, reviewNominations, returnEstimate, sameKey, PICK_COUNT, PICK_WINDOW } from './stake-pick.js';

const t = (id, p) => stakeCopy(id, p);
// The spec's own words outside the SC table: the "What you will sign" disclosure (section 5.2) and
// the chip for a validator whose stakers fill more than one payout page (section 5.2, title SC-95).
const CALL_DETAILS = 'Call details';
const MANY_PAGES = 'Many payout pages';
const REASON_ID = { inactive: 'SC-164a', commission100: 'SC-164b', blocked: 'SC-164c', 'no-history': 'SC-164d', 'low-return': 'SC-164e', slashed: 'SC-164f' };
const CALL_NAME = { bond: 'staking.bond', bondExtra: 'staking.bondExtra', setPayee: 'staking.setPayee', nominate: 'staking.nominate' };

const pct1 = (x) => Number(x).toFixed(1);
const num = (x) => String(+Number(x).toFixed(2));
// planck x percent, down to the 0.01 PDEX (an estimate never rounds up).
function share(planck, percent) {
    const bp = BigInt(Math.round(Number(percent) * 100));
    const v = (BigInt(planck) * bp) / 10000n;
    return v - (v % (PLANCK_PER_PDEX / 100n));
}
function findRow(byAddress, a, same) {
    if (!byAddress) return null;
    const hit = byAddress.get(String(a));
    if (hit) return hit;
    for (const [k, v] of byAddress) if (same(k, a)) return v;
    return null;
}
const realized = (v) => {
    const p = v && v.perf && v.perf[PICK_WINDOW];
    return p && p.status === 'ok' && Number.isFinite(p.apr) && p.apr > 0 ? p.apr : null;
};

// A replacement built from the keep list of "Change validators" (section 4.2): the healthy ones of
// the list stay, the rule fills the rest, and every current validator not kept is Removed.
function keepProposal(current, keep, validators, meta, opts) {
    const base = pickValidators(validators, meta, { ...opts, keep: [] });
    const byAddress = new Map(validators.map(v => [String(v.address), v]));
    const review = reviewNominations(current, byAddress, { median: base.median, activeEra: meta.activeEra, same: opts.same });
    const pick = pickValidators(validators, meta, { ...opts, count: Math.max(PICK_COUNT, keep.length), keep });
    const kept = pick.picks.filter(p => p.kept).map(p => p.address);
    const added = pick.picks.filter(p => !p.kept).map(p => p.address);
    const removed = review.rows.filter(r => !kept.some(k => opts.same(k, r.address))).map(r => ({ address: r.address, reason: r.state === 'ok' ? null : r.state }));
    return { offer: true, status: pick.status, kept, removed, added, targets: kept.concat(added) };
}

// The view model: every word and every state of the simple view, from one snapshot of the card.
//   s.data      the /api/wallet payload       s.typed    the amount as typed
//   s.targets   the selection, [{ address, name }]       s.origin   see the header
//   s.snap      { state: 'loading'|'ok'|'failed', validators, meta }
//   s.pick      pickValidators of the snapshot, s.offer the replacement on offer, s.proposal the one shown
//   s.payee     undefined (not read yet), 'failed', or { kind, account }
export function stakeSimpleModel(s) {
    const { data, same = sameKey, fmt = {} } = s;
    const duration = fmt.duration || (() => '');
    const short = fmt.short || ((a) => a);
    const targets = s.targets || [];
    const form = stakeFormPlan(data, { typed: s.typed, targets: targets.map(r => r.address), maxTargets: s.maxTargets, same, connected: s.connected, feeFloorPlanck: s.feeFloorPlanck || 0n });
    const m = { form, amount: {}, happens: null, ret: null, block: null, panels: [], review: null, primary: { show: true, enabled: false, label: t('SC-50'), reason: null } };
    const st = (data && data.staking) || {};
    const transferable = transferablePlanckOf(data && data.balance);
    const maxPlanck = stakeMaxPlanck({ transferablePlanck: transferable, feeReservePlanck: STAKE_FEE_RESERVE_PLANCK });
    const maxText = planckToPdexText(maxPlanck);
    m.amount = { labelId: 'SC-03', hint: t('SC-04', { max: maxText }), maxTitle: t('SC-05', { reserve: planckToPdexText(STAKE_FEE_RESERVE_PLANCK) }), maxText, note: null, msg: null, disabled: false };
    if (form.kind === 'account') {
        m.primary.reason = { id: form.message === STAKE_COPY['SC-110'] ? 'SC-110' : 'SC-109', text: form.message };
        return m;
    }
    const hasBond = form.hasBond;
    const current = (st.nominating || []).map(v => ({ address: v.address, name: v.name }));
    const mode = !hasBond ? 'first' : current.length ? 'existing' : 'empty';
    const origin = s.origin || (mode === 'existing' ? 'current' : 'auto');
    const check = form.check;
    const plan = form.message ? null : form.plan;
    m.mode = mode;
    m.amount.labelId = mode === 'first' ? 'SC-03' : (origin === 'proposal' || mode === 'empty') ? 'SC-03c' : 'SC-03b';
    if (s.maxPressed && String(s.typed).trim() === maxText) m.amount.note = t('SC-05', { reserve: planckToPdexText(STAKE_FEE_RESERVE_PLANCK) });

    // State 9: a first stake is out of reach (the smallest stake, the 1 PDEX that stays, a fee).
    const minPlanck = pdexNumberToPlanck(data.network && data.network.minStake, 'ceil');
    const fee = BigInt(s.feeFloorPlanck || 0n);
    if (mode === 'first' && minPlanck > 0n && transferable < minPlanck + fee) {
        m.amount.disabled = true;
        m.primary.show = false;
        m.panels.push({ kind: 'cannot', text: t('SC-115', { need: planckToPdexText(minPlanck + PLANCK_PER_PDEX + fee), min: planckToPdexText(minPlanck),
            have: planckToPdexText(pdexNumberToPlanck(data.balance && data.balance.free, 'floor')) }) });
        return m;
    }

    const valid = check && (check.code === 'ok' || check.code === 'low-reserve');
    if (check && String(s.typed).trim() !== '') {
        if (check.code === 'invalid') m.amount.msg = { role: 'error', id: 'SC-100', text: t('SC-100') };
        else if (check.code === 'over') m.amount.msg = { role: 'error', id: 'SC-101', text: t('SC-101', { max: maxText }), offer: t('SC-102', { max: maxText }) };
        else if (check.code === 'below-min') m.amount.msg = { role: 'error', id: 'SC-105', text: t('SC-105', { min: planckToPdexText(minPlanck) }) };
        else if (check.code === 'low-reserve') m.amount.msg = { role: 'warn', id: 'SC-104', text: t('SC-104', { left: planckToPdexText(check.leftPlanck) }) };
    }

    // What happens (3.1 row 3): what is locked, when it earns, how long it takes back, where rewards go.
    const lines = [];
    if (valid) lines.push(mode === 'first' ? { id: 'SC-11', icon: 'bx-lock-alt', text: t('SC-11', { amount: planckToPdexText(check.planck) }) }
        : { id: 'SC-11b', icon: 'bx-lock-alt', text: t('SC-11b', { amount: planckToPdexText(check.planck), staked: planckToPdexText(pdexNumberToPlanck(st.totalStaked, 'floor')) }) });
    const net = data.network || {};
    if (net.eraDurationMs > 0) lines.push({ id: 'SC-12', icon: 'bx-play-circle', text: t('SC-12', { era: duration(net.eraDurationMs) }) });
    if (net.unbondingMs > 0) lines.push({ id: 'SC-13', icon: 'bx-time-five', warn: true, text: t('SC-13', { unbonding: duration(net.unbondingMs) }) });
    const reward = rewardsLine(mode, s.payee, st, data.address, same, short);
    if (reward) lines.push(reward);
    m.happens = lines;

    // The validators block (3.1 row 5) and, with a list, the past return (row 4).
    const snap = s.snap || { state: 'loading' };
    const full = snap.state === 'ok' && snap.meta && snap.meta.full === true;
    const byAddress = full ? new Map(snap.validators.map(v => [String(v.address), v])) : null;
    if (mode === 'empty') m.panels.push({ kind: 'warn', id: 'SC-140', text: t('SC-140') });
    if (snap.state === 'loading') m.block = { state: 'loading', text: t('SC-111') };
    else if (snap.state === 'failed') m.block = { state: 'failed', id: 'SC-112', text: t('SC-112') };
    else if (!full) m.block = { state: 'no-data', id: 'SC-114', text: t('SC-114') };
    else if (!targets.length) m.block = { state: 'none', id: 'SC-38', text: t('SC-38') };
    else {
        const health = mode === 'existing' && origin === 'current'
            ? new Map(reviewNominations(current.map(c => c.address), byAddress, { median: s.pick && s.pick.median, activeEra: snap.meta.activeEra, same }).rows.map(r => [r.address, r.state]))
            : new Map();
        const row = (r) => rowModel(r, findRow(byAddress, r.address, same), health.get(r.address), short);
        const n = targets.length;
        const summary = origin === 'auto' ? { id: 'SC-30', text: t('SC-30', { n }) }
            : origin === 'manual' ? { id: 'SC-30b', text: t('SC-30b', { n }) }
                : origin === 'proposal' && s.proposal ? { id: 'SC-30d', text: t('SC-30d', { k: s.proposal.kept.length, r: s.proposal.removed.length }) }
                    : { id: 'SC-30c', text: t('SC-30c', { n }) };
        m.block = { state: 'list', summary, rows: targets.map(row), rule: origin === 'auto' || origin === 'proposal',
            era: snap.meta.activeEra ? t('SC-36', { n: Number(snap.meta.activeEra) - 1 }) : null,
            short: origin === 'auto' && s.pick && s.pick.status === 'short' ? t('SC-37', { k: n }) : null };
        const est = returnEstimate(targets.map(r => r.address), byAddress, PICK_WINDOW, same);
        if (est.none) m.ret = { none: est.none === 'no-history' ? { id: 'SC-24a', text: t('SC-24a') } : { id: 'SC-24b', text: t('SC-24b') } };
        else {
            const lo = pct1(est.low), hi = pct1(est.high);
            m.ret = { value: lo === hi ? { id: 'SC-21b', text: t('SC-21b', { x: lo }) } : { id: 'SC-21', text: t('SC-21', { low: lo, high: hi }) },
                basis: t('SC-22', { n: est.counted }),
                pdex: valid ? t('SC-23', { amount: planckToPdexText(check.planck), a: planckToPdexText(share(check.planck, est.low)), b: planckToPdexText(share(check.planck, est.high)) }) : null };
        }
        if (mode === 'existing' && origin === 'current' && s.offer && s.offer.offer) {
            m.panels.push({ kind: 'unhealthy', text: t('SC-160', { k: s.offer.removed.length, n: current.length }) });
        }
        if (origin === 'proposal' && s.proposal) {
            const named = (a) => findRow(byAddress, a, same) || { address: a };
            m.proposal = {
                kept: s.proposal.kept.map(a => rowModel({ address: a }, named(a), null, short)),
                removed: s.proposal.removed.map(r => rowModel({ address: r.address, name: (current.find(c => same(c.address, r.address)) || {}).name }, findRow(byAddress, r.address, same), r.reason || 'gone', short)),
                added: s.proposal.added.map(a => rowModel({ address: a }, named(a), null, short))
            };
        }
    }
    if (s.changed) m.panels.push({ kind: 'changed', id: 'SC-39', text: t('SC-39') });

    // The review: the plan's lines and calls, only for a plan that can be signed.
    if (plan && plan.calls.length) m.review = { lines: plan.lines.map(l => t(l.id, l.params)), calls: plan.calls, wrapper: plan.calls.length > 1 ? 'utility.batchAll' : null };

    // The primary (3.1 row 7) and the reason under it when it is inactive (SC-55, SC-122).
    const p = m.primary;
    p.label = t(plan && plan.primary ? plan.primary : (origin === 'proposal' || mode === 'empty') ? 'SC-51' : 'SC-50');
    p.enabled = !!(m.review && !form.message);
    const noPick = !targets.length && (mode === 'first' || mode === 'empty');
    if (p.enabled || m.amount.msg && m.amount.msg.role === 'error') p.reason = null;
    else if (noPick && snap.state !== 'loading') p.reason = { id: 'SC-122', text: t('SC-122') };
    else if (noPick) p.reason = null;
    else if (check && check.code === 'empty' && (mode === 'first' || origin === 'current')) p.reason = { id: 'SC-55a', text: t('SC-55a') };
    else if (form.kind === 'plan' && form.message !== STAKE_COPY['SC-55b']) p.reason = { id: null, text: form.message };
    else p.reason = { id: 'SC-55b', text: t('SC-55b') };
    return m;
}

function rewardsLine(mode, payee, st, address, same, short) {
    if (mode === 'first') return { id: 'SC-14', icon: 'bx-revision', text: t('SC-14') };
    if (payee === undefined) return null;
    if (payee === 'failed' || !payee) return { id: 'SC-14e', icon: 'bx-revision', text: t('SC-14e') };
    const to = payee.kind === 'account' ? payee.account : payee.kind === 'controller' ? (st.controller || address) : null;
    if (payee.kind === 'staked') return { id: 'SC-14', icon: 'bx-revision', text: t('SC-14') };
    if (payee.kind === 'stash' || (to && same(to, address))) return { id: 'SC-14b', icon: 'bx-revision', text: t('SC-14b') };
    if (to) return { id: 'SC-14c', icon: 'bx-revision', text: t('SC-14c', { short: short(to) }) };
    return { id: 'SC-14d', icon: 'bx-error', warn: true, text: t('SC-14d') };
}

// One validator row: SC-33, or the same line with "No history yet" (SC-78b) for a validator with no
// 28-era return; the reason it is not earning (SC-164) and the payout pages chip (SC-95).
function rowModel(r, v, reason, short) {
    const label = (r.name && r.name !== 'Unknown' ? r.name : v && v.name && v.name !== 'Unknown' ? v.name : short(r.address));
    const apr = realized(v);
    const commission = v && v.commission != null && Number.isFinite(Number(v.commission)) ? num(v.commission) : null;
    let text;
    if (apr != null && commission != null) text = t('SC-33', { name: label, return: pct1(apr), commission });
    else {
        const parts = [label, apr != null ? `${pct1(apr)}% a year` : STAKE_COPY['SC-78b']];
        if (commission != null) parts.push(STAKE_COPY['SC-33'].split(', ').pop().replace('{commission}', commission));
        text = parts.join(', ');
    }
    const reasonId = reason && reason !== 'ok' ? REASON_ID[reason] || null : null;
    return { address: r.address, text, reasonId, pages: !!(v && Number(v.exposurePages) > 1) };
}

// ── markup ──
function rowHtml(r, esc) {
    return `<li data-addr="${esc(r.address)}"><span class="stake-row-text">${esc(r.text)}</span>`
        + (r.reasonId ? ` <span class="ui-chip is-wait" data-sc="${r.reasonId}">${icon('bx-error')}${esc(STAKE_COPY[r.reasonId])}</span>` : '')
        + (r.pages ? ` <span class="ui-chip is-wait" title="${esc(STAKE_COPY['SC-95'])}">${icon('bx-layer')}${esc(MANY_PAGES)}</span>` : '') + '</li>';
}
function callHtml(c, esc) {
    const n = CALL_NAME[c.kind] || c.kind;
    const pay = (p) => (p.kind === 'staked' ? 'Staked' : p.kind === 'stash' ? 'Stash' : `Account ${p.account}`);
    let args = '';
    if (c.kind === 'bond') args = ` value ${esc(c.args.value)} (${esc(planckToPdexText(c.args.value))} PDEX), payee ${esc(pay(c.args.payee))}`;
    else if (c.kind === 'bondExtra') args = ` value ${esc(c.args.value)} (${esc(planckToPdexText(c.args.value))} PDEX)`;
    else if (c.kind === 'setPayee') args = ` payee ${esc(pay(c.args.payee))}`;
    else if (c.kind === 'nominate') args = ` targets<ol class="stake-call-targets">${c.args.targets.map(a => `<li data-addr="${esc(a)}"><code>${esc(a)}</code></li>`).join('')}</ol>`;
    return `<li data-call="${esc(n)}"><code>${esc(n)}</code>${args}</li>`;
}
function reviewHtml(rv, esc, open) {
    if (!rv) return '';
    return `<details class="validate-disclosure stake-call-details"${open ? ' open' : ''}><summary>${esc(CALL_DETAILS)}</summary>`
        + `<ul class="stake-plan-lines">${rv.lines.map(l => `<li>${icon('bx-check')}${esc(l)}</li>`).join('')}</ul>`
        + `<ol class="stake-calls"${rv.wrapper ? ` data-wrapper="${esc(rv.wrapper)}"` : ''}>${rv.calls.map(c => callHtml(c, esc)).join('')}</ol>`
        + (rv.wrapper ? `<p class="stake-call-wrapper"><code>${esc(rv.wrapper)}</code></p>` : '') + '</details>';
}
const sc = (id, text, esc, tag = 'span', cls = '') => `<${tag}${cls ? ` class="${cls}"` : ''} data-sc="${id}">${esc(text)}</${tag}>`;
const retryHtml = (esc) => `<button type="button" class="validate-secondary" data-stake-action="retry" data-sc="SC-113">${icon('bx-refresh')}${esc(t('SC-113'))}</button>`;
const chooseHtml = (esc) => `<button type="button" class="validate-secondary" data-stake-action="choose" data-sc="SC-35">${icon('bx-slider-alt')}${esc(t('SC-35'))}</button>`;

export function stakeSimpleHtml(m, esc, { open = false, callsOpen = false } = {}) {
    const out = [];
    for (const p of m.panels) {
        if (p.kind === 'cannot') out.push(`<div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">${sc('SC-115', p.text, esc, 'p')}</div></div>`);
        if (p.kind === 'warn') out.push(`<div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">${sc(p.id, p.text, esc, 'p')}</div></div>`);
        if (p.kind === 'changed') out.push(`<p class="ui-panel is-info is-line" role="status" data-sc="SC-39">${icon('bx-info-circle')}<span class="ui-panel-body">${esc(p.text)}</span></p>`);
    }
    if (m.happens) {
        out.push(`<section class="stake-happens" aria-labelledby="stake-happens-h"><h4 id="stake-happens-h" class="stake-block-head" data-sc="SC-10">${esc(t('SC-10'))}</h4><ul class="stake-happens-list">`
            + m.happens.map(l => (l.warn ? `<li class="ui-panel is-warn is-line">${icon(l.icon)}<span class="ui-panel-body" data-sc="${l.id}">${esc(l.text)}</span></li>`
                : `<li>${icon(l.icon)}<span data-sc="${l.id}">${esc(l.text)}</span></li>`)).join('') + '</ul></section>');
    }
    if (m.ret) {
        const v = m.ret.none ? sc(m.ret.none.id, m.ret.none.text, esc, 'span', 'stake-return-none') : sc(m.ret.value.id, m.ret.value.text, esc, 'strong', 'stake-return-value');
        out.push(`<section class="stake-return"><div class="stake-return-head">${sc('SC-20', t('SC-20'), esc, 'span', 'stake-return-label')}${v}</div>`
            + (m.ret.basis ? sc('SC-22', m.ret.basis, esc, 'p', 'stake-return-basis') : '') + (m.ret.pdex ? sc('SC-23', m.ret.pdex, esc, 'p', 'stake-return-basis') : '') + '</section>');
    }
    const b = m.block;
    if (b) {
        if (b.state === 'loading') out.push(`<p class="stake-block-status" data-sc="SC-111">${esc(b.text)}</p>`);
        else if (b.state === 'failed' || b.state === 'no-data') out.push(`<div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">${sc(b.id, b.text, esc, 'p')}${retryHtml(esc)}</div></div>`);
        else if (b.state === 'none') out.push(`<div class="stake-block-status">${sc('SC-38', b.text, esc, 'p')}${chooseHtml(esc)}</div>`);
        else {
            out.push(`<details class="stake-validators"${open ? ' open' : ''}><summary><span class="ui-tile is-violet is-sm" aria-hidden="true">${icon('bx-group')}</span>`
                + `<span class="stake-validators-sum">${sc(b.summary.id, b.summary.text, esc, 'span', 'stake-validators-title')}${sc('SC-31', t('SC-31'), esc, 'span', 'stake-validators-cap')}</span>`
                + `<i class="bx bx-chevron-down stake-chevron" aria-hidden="true"></i></summary><div class="stake-validators-body">`
                + `<ol class="stake-pick-list">${b.rows.map(r => rowHtml(r, esc)).join('')}</ol>`
                + (b.era ? sc('SC-36', b.era, esc, 'p', 'stake-data-line') : '')
                + (b.rule ? linePanelHtml('is-info', 'bx-info-circle', sc('SC-32', t('SC-32'), esc)) : '')
                + (m.ret && !m.ret.none ? linePanelHtml('is-info', 'bx-info-circle', sc('SC-25', t('SC-25'), esc)) : '')
                + chooseHtml(esc) + reviewHtml(m.review, esc, callsOpen) + '</div></details>');
            if (b.short) out.push(linePanelHtml('is-info', 'bx-info-circle', sc('SC-37', b.short, esc)));
        }
    }
    if (m.panels.some(p => p.kind === 'unhealthy')) {
        const p = m.panels.find(x => x.kind === 'unhealthy');
        out.push(`<div class="ui-panel is-warn stake-unhealthy">${icon('bx-error')}<div class="ui-panel-body">${sc('SC-160', p.text, esc, 'p', 'ui-panel-title')}`
            + `<button type="button" class="validate-secondary" data-stake-action="replace" data-sc="SC-161a">${esc(t('SC-161a'))}</button></div></div>`);
    }
    if (m.proposal) {
        const group = (key, head, rows) => `<div class="stake-proposal-group" data-group="${key}">${head}<ul class="stake-proposal-list">${rows.map(r => rowHtml(r, esc)).join('')}</ul></div>`;
        out.push(`<section class="stake-proposal" aria-label="${esc(m.block.summary.text)}">`
            + group('kept', `<span class="ui-chip is-positive" data-sc="SC-163a">${icon('bx-check')}${esc(t('SC-163a'))}</span>`, m.proposal.kept)
            + group('removed', `<span class="stake-proposal-label" data-sc="SC-163b">${esc(t('SC-163b'))}</span>`, m.proposal.removed)
            + group('added', `<span class="ui-chip is-step" data-sc="SC-163c">${icon('bx-plus')}${esc(t('SC-163c'))}</span>`, m.proposal.added)
            + `<button type="button" class="validate-secondary" data-stake-action="keep" data-sc="SC-161b">${esc(t('SC-161b'))}</button></section>`);
    }
    return out.join('');
}

// The card: state, events and painting, over the modal markup in index.html.
//   root       #stake-modal                    selection  { get: () => rows, set: (rows) }
//   fillMax    the page's Max (script.js fillStakeMax)    reload  loads the validator list again
//   onView     (view, focusSearch) after a switch         quota   () => the nominations quota
export function createStakeCard({ root, storage = null, esc, short = (a) => a, duration = () => '', same = sameKey, connected = () => null,
    feeFloorPlanck = 0n, quota = () => null, selection, fillMax = null, reload = () => {}, onView = () => {} }) {
    const doc = root.ownerDocument;
    const $ = (id) => doc.getElementById(id);
    const s = { token: 0, data: null, origin: null, keep: null, snap: { state: 'loading' }, pick: null, offer: null, proposal: null, payee: undefined,
        maxPressed: false, changed: false, view: 'simple', model: null };
    const input = () => $('stake-amount-input');
    const rows = (addrs, list) => addrs.map(a => { const v = (list || []).find(x => same(x.address, a)); return { address: a, name: v ? v.name : null }; });
    const current = () => ((s.data && s.data.staking && s.data.staking.nominating) || []).map(v => ({ address: v.address, name: v.name }));
    const metaOf = (meta) => ({ ...meta, pageSize: meta.exposurePageSize || meta.pageSize });

    function model() {
        return stakeSimpleModel({ data: s.data, typed: input() ? input().value : '', targets: selection.get(), origin: s.origin, snap: s.snap, pick: s.pick,
            offer: s.offer, proposal: s.proposal, payee: s.payee, connected: connected(), same, maxTargets: quota(), feeFloorPlanck, maxPressed: s.maxPressed,
            changed: s.changed, fmt: { duration, short } });
    }
    function render() {
        if (!s.data) return;
        const m = model();
        s.model = m;
        const label = $('stake-amount-label');
        if (label) { label.textContent = t(m.amount.labelId); label.setAttribute('data-sc', m.amount.labelId); }
        const hint = $('stake-amount-hint');
        if (hint) hint.textContent = m.amount.hint;
        const max = $('stake-max-btn');
        if (max) { max.title = m.amount.maxTitle; max.disabled = m.amount.disabled; }
        const note = $('stake-max-note');
        if (note) { note.hidden = !m.amount.note; note.textContent = m.amount.note || ''; }
        const i = input();
        if (i) { i.disabled = m.amount.disabled; if (m.amount.msg && m.amount.msg.role === 'error') i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); }
        const msg = $('stake-amount-msg');
        if (msg) {
            const a = m.amount.msg;
            msg.innerHTML = !a ? '' : a.role === 'warn' ? linePanelHtml('is-warn', 'bx-error', `<span data-sc="${a.id}">${esc(a.text)}</span>`)
                : `<p class="validate-msg is-error">${icon('bx-error-circle')}<span data-sc="${a.id}">${esc(a.text)}</span>`
                    + (a.offer ? ` <button type="button" class="validate-text-btn" data-stake-action="use-max" data-sc="SC-102">${esc(a.offer)}</button>` : '') + '</p>';
        }
        const simple = $('stake-simple');
        if (simple) {
            const d = simple.querySelector('details.stake-validators');
            const cd = simple.querySelector('details.stake-call-details');
            simple.innerHTML = stakeSimpleHtml(m, esc, { open: s.forceOpen || !!(d && d.open), callsOpen: !!(cd && cd.open) });
            s.forceOpen = false;
        }
        const btn = $('submit-stake-tx-btn');
        if (btn && btn.getAttribute('aria-busy') !== 'true') {
            // The one gradient primary of the card, set while it is open: the page behind it counts no
            // primary from a closed modal (lib/ui-parts.js PAGE_PRIMARY_SELECTOR).
            btn.classList.add('validate-primary');
            btn.textContent = m.primary.label;
            btn.disabled = !m.primary.enabled;
            btn.hidden = !m.primary.show;
        }
        const why = $('stake-primary-reason');
        if (why) {
            const r = btn && btn.getAttribute('aria-busy') === 'true' ? null : m.primary.show ? m.primary.reason : null;
            why.hidden = !r;
            why.textContent = r ? r.text : '';
            if (r && r.id) why.setAttribute('data-sc', r.id); else why.removeAttribute('data-sc');
        }
    }
    function applyView() {
        for (const el of root.querySelectorAll('[data-stake-view]')) el.hidden = el.getAttribute('data-stake-view') !== s.view;
        const body = root.querySelector('.stake-modal-body');
        if (body) { body.classList.toggle('is-simple', s.view === 'simple'); body.classList.toggle('is-advanced', s.view === 'advanced'); }
        const sw = $('stake-view-switch');
        if (sw) sw.setAttribute('aria-pressed', s.view === 'advanced' ? 'true' : 'false');
    }
    function setView(view, focusSearch = false) {
        s.view = view === 'advanced' ? 'advanced' : 'simple';
        saveStakeView(storage, s.view);
        applyView();
        render();
        onView(s.view, focusSearch);
    }
    // The rule's choice for a first stake, or the replacement on offer (or asked for with a keep list).
    function choose() {
        const snap = s.snap;
        s.pick = null; s.offer = null;
        if (snap.state !== 'ok' || !snap.meta || snap.meta.full !== true) return;
        const meta = metaOf(snap.meta);
        const opts = { quota: quota(), same };
        const cur = current();
        if (!cur.length || !(s.data.staking && Number(s.data.staking.totalStaked) > 0)) {
            s.pick = pickValidators(snap.validators, meta, opts);
            if (s.origin === 'auto') selection.set(rows(s.pick.picks.map(p => p.address), snap.validators));
            return;
        }
        s.pick = pickValidators(snap.validators, meta, opts);
        s.offer = proposeReplacement(cur.map(c => c.address), snap.validators, meta, opts);
        if (s.keep) {
            s.proposal = keepProposal(cur.map(c => c.address), s.keep, snap.validators, meta, opts);
            s.origin = 'proposal';
            s.keep = null;
            selection.set(rows(s.proposal.targets, snap.validators.concat(cur)));
        } else if (s.origin === 'proposal') {
            s.proposal = s.offer.offer ? s.offer : null;
            if (s.proposal) selection.set(rows(s.proposal.targets, snap.validators.concat(cur)));
            else { s.origin = 'current'; selection.set(cur); }
        }
    }

    root.addEventListener('click', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-stake-action], #stake-view-switch, #stake-max-btn') : null;
        if (!el || !s.data) return;
        if (el.id === 'stake-view-switch') return setView(s.view === 'advanced' ? 'simple' : 'advanced');
        if (el.id === 'stake-max-btn') {
            if (fillMax) fillMax(); else if (input()) input().value = s.model ? s.model.amount.maxText : '';
            s.maxPressed = true;
            return render();
        }
        const a = el.getAttribute('data-stake-action');
        if (a === 'use-max') { if (input() && s.model) input().value = s.model.amount.maxText; s.maxPressed = true; return render(); }
        if (a === 'choose') return setView('advanced', true);
        if (a === 'retry') return reload();
        if (a === 'replace' && s.offer && s.offer.offer) {
            s.origin = 'proposal';
            s.proposal = s.offer;
            selection.set(rows(s.offer.targets, (s.snap.validators || []).concat(current())));
            render();
            const k = root.querySelector('[data-stake-action="keep"]');
            if (k) k.focus();
            return;
        }
        if (a === 'keep') { s.origin = 'current'; s.proposal = null; selection.set(current()); render(); }
    });
    const amount = input();
    if (amount) amount.addEventListener('input', () => render());

    return {
        open({ data, keep = null }) {
            s.token++;
            s.data = data;
            const st = (data && data.staking) || {};
            const staked = Number(st.totalStaked) > 0;
            s.origin = staked && (st.nominating || []).length ? (keep ? 'manual' : 'current') : 'auto';
            s.keep = keep && keep.length ? keep.slice() : null;
            Object.assign(s, { snap: { state: 'loading' }, pick: null, offer: null, proposal: null, payee: undefined, maxPressed: false, changed: false });
            s.view = loadStakeView(storage);
            applyView();
            render();
            const h = $('stake-title');
            if (h && h.focus) h.focus({ preventScroll: true });
            return s.token;
        },
        token: () => s.token,
        setSnapshot(result, token = s.token) {
            if (token !== s.token || !s.data) return;
            s.snap = result instanceof Error ? { state: 'failed' } : result ? { state: 'ok', validators: result.validators || [], meta: result.meta || {} } : { state: 'loading' };
            choose();
            render();
        },
        setPayee(payee, token = s.token) {
            if (token !== s.token) return;
            s.payee = payee;
            render();
        },
        markManual() {
            if (!s.data) return;
            s.origin = 'manual';
            s.proposal = null;
            render();
        },
        // At the press (section 4.2): the rule's picks still active and open to new stake in the newest
        // snapshot, or nothing is sent, the choice is redone, the disclosure opens and SC-39 says why.
        async recheck(load) {
            if (!s.data || (s.origin !== 'auto' && s.origin !== 'proposal')) return true;
            const token = s.token;
            let next;
            try { next = await load(); } catch (e) { return true; }
            if (token !== s.token || !next || !next.meta || next.meta.full !== true) return true;
            const fresh = new Map((next.validators || []).map(v => [String(v.address), v]));
            const bad = selection.get().filter(r => { const v = findRow(fresh, r.address, same); return !v || !v.active || v.blocked; });
            const fromRule = s.origin === 'auto' ? bad : bad.filter(r => s.proposal && s.proposal.added.some(a => same(a, r.address)));
            if (!fromRule.length) return true;
            s.snap = { state: 'ok', validators: next.validators, meta: next.meta };
            choose();
            s.changed = true;
            s.forceOpen = true;
            render();
            return false;
        },
        render,
        view: () => s.view,
        model: () => s.model
    };
}
