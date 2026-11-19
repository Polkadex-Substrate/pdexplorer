// The manage panel on /validate (Sprint 4, money path, behind
// FEATURE_FLAGS.validate through the page itself). Design 5.2 and 5.4: under
// the status of a stash the connected wallet can sign for, the actions for its
// state; each opens one small form, then a review, then the result. Rules in
// lib/validator-manage.js, chain reads in lib/validator-manage-chain.js.
//
// - One view at a time: the menu (secondary buttons; one primary only when the
//   node is offline: Open the node checklist), or a form (primary Review), or
//   the review (primary Sign and submit, or Stop validating), or the result
//   (no primary). Cancel and Back return focus to the button that opened it.
//   The forms sit inline under the status rather than in an overlay; a wallet
//   change remounts the page (script.js), which closes them.
// - Signing goes through script.js submitSignedTx (d.submit), unchanged: the
//   fee preflight, the wallet-session revision taken when the review is shown,
//   buildTx that reads the limits, the stash state, the pauses, the keys and
//   the fee again, success from the events (expectEvents) and a verify for a
//   quiet subscription. After inclusion the panel reads the chain once more
//   and says "confirmed" only when the chain shows the change.
// - Who signs: the stash for bond more and keys, the ledger controller (the
//   stash for every new account) for the rest. A legacy controller's actions
//   are shown disabled with the account to connect. A proxy of the stash and
//   a multisig wallet are detected and told this comes in Sprint 5.
// - Unbond and withdraw are not built twice: a link to the existing Unstake
//   modal (/unstake), which reads the validator rule at signing.
// - Never a seed, never purge_keys. Inputs carry data-input-kind for the paste
//   and clear actions; amounts are the strict kind.
// Tested in test/validator-manage-view.test.js.

import * as M from './validator-manage.js';
import { readManageState, readManageLimits, estimateManageFee, buildCheckedManageTx, verifyManage, readManageApplied } from './validator-manage-chain.js';
import { readKeyOwners } from './validator-status-chain.js';
import { classifyKeyOwners, keyCheckSummary, layoutMismatchText } from './session-keys.js';
import { keysForSetup, parsePercent, parsePdexAmount, planckToInput } from './validator-setup.js';
import { perbillToPercent } from './validator-status.js';
import { formatPlanck } from './call-args-format.js';
import { enhanceInputActions } from './input-actions.js';

const TITLES = { commission: 'Change commission', keys: 'Rotate session keys', bondExtra: 'Bond more', payee: 'Change payee', chill: 'Stop validating', rebond: 'Rebond' };
const RESULT_TEXT = { free: 'Not registered', own: 'This stash', other: 'Another account' };
const IN_SET = new Set(['active', 'elected-next', 'active-leaving', 'disabled']);
const big = (x) => { try { return x == null || x === '' ? 0n : BigInt(String(x)); } catch (e) { return 0n; } };
const pdex = (v) => formatPlanck(big(v)) ?? '0';
const current = new WeakMap();

function waitApi(d) {
    const limit = d.apiWaitMs == null ? 15000 : d.apiWaitMs;
    return new Promise((resolve) => {
        const start = Date.now();
        const look = () => {
            const api = typeof d.getApi === 'function' ? d.getApi() : null;
            if (api) return resolve(api);
            if (Date.now() - start >= limit) return resolve(null);
            setTimeout(look, 25);
        };
        look();
    });
}

// d: as lib/validator-setup-view.js (script.js validateSetupDeps). o: { stash, model }
// where model is the status page's model (headline state, rows, era, session).
export async function mountValidatorManage(el, d, { stash, model = {} } = {}) {
    if (!el) return;
    const token = {};
    current.set(el, token);
    const live = () => current.get(el) === token;
    const esc = d.esc;
    const isSame = typeof d.isSame === 'function' ? d.isSame : (a, b) => a === b;
    const shortAddr = typeof d.shortAddr === 'function' ? d.shortAddr : (a) => a;
    const account = d.account || {};
    if (account.status !== 'connected' || !account.address) { el.innerHTML = ''; return; }
    const me = String(account.address);
    el.innerHTML = '<section class="validate-manage" aria-labelledby="validate-manage-title"></section>';
    const box = el.firstChild;
    const head = '<h3 class="validate-manage-title" id="validate-manage-title">Manage this validator</h3>';
    const frame = (inner) => { box.innerHTML = head + inner; enhanceInputActions(box); };
    const q = (sel) => box.querySelector(sel);
    const msgP = (id, text, extra = '') => `<p id="${id}" class="validate-msg" aria-live="polite"${extra}>${esc(text || '')}</p>`;

    const w = { api: null, state: null, limits: null, params: null, t: {}, kind: null, trigger: null, input: {}, msg: {}, needsConfirm: false,
        keyCheck: null, fee: null, review: null, after: null, block: null };

    function errorView() {
        frame('<p class="validate-setup-note">The explorer cannot reach the chain right now. Your validator is not affected.</p>'
            + '<button type="button" class="validate-secondary" data-manage-action="retry">Retry</button>');
    }

    async function load() {
        frame('<p class="validate-msg">Reading the chain</p>');
        const api = await waitApi(d);
        if (!live()) return;
        if (!api) return errorView();
        w.api = api;
        try {
            const [state, limits, params] = await Promise.all([
                readManageState(api, stash), readManageLimits(api),
                Promise.resolve().then(() => d.fetchJson('/api/validator/params')).catch(() => null)
            ]);
            if (!live()) return;
            Object.assign(w, { state, limits, params, t: M.timeFacts(model, params) });
        } catch (e) {
            if (live()) errorView();
            return;
        }
        const role = M.roleOf(w.state, me, { isSame });
        if (!role.role) { el.innerHTML = ''; return; }
        if (typeof d.isMultisig === 'function' && d.isMultisig(me)) {
            return frame('<p class="validate-setup-note">Managing a validator from a multisig or through a proxy comes in a later release. Connect the stash account itself to make changes.</p>');
        }
        if (role.role === 'proxy') return frame(`<p class="validate-setup-note">${esc(M.proxyText(role.type, 'keys'))}</p>`);
        menu(false);
    }

    // ── the menu ──
    function summaryLine() {
        const s = w.state, parts = [`Bonded: ${pdex(s.active)} PDEX.`];
        if (s.prefs) parts.push(`Commission: ${perbillToPercent(s.prefs.commission)}${s.prefs.blocked ? ', new nominations blocked' : ''}.`);
        parts.push(`Rewards: ${M.payeeLabel(s.payee, shortAddr)}.`);
        const unl = M.unlockingTotal(s);
        if (unl > 0n) parts.push(`Unbonding: ${pdex(unl)} PDEX.`);
        return parts.join(' ');
    }
    function menu(refocus) {
        if (!live()) return;
        w.kind = null; w.review = null; w.after = null;
        const offline = (model.rows || []).some(r => r && r.id === 'online' && r.word === 'Offline');
        const m = M.manageMenu(model.state, { unlocking: M.unlockingTotal(w.state) > 0n, offline });
        if (!m.actions.length) {
            if (model.state === 'disabled') return frame('<p class="validate-setup-note">This validator is disabled for the rest of this era after an offence. The Offences row above says what was reported. Changes can wait until the era ends.</p>');
            el.innerHTML = '';
            return;
        }
        const reasons = [];
        const idFor = (text) => { let i = reasons.indexOf(text); if (i < 0) { reasons.push(text); i = reasons.length - 1; } return `validate-manage-why-${i}`; };
        const buttons = m.actions.map((a) => {
            const why = M.signerProblem(a.kind, w.state, me, { isSame });
            return `<li><button type="button" class="validate-secondary" data-manage-action="${a.kind}"${why ? ` disabled aria-describedby="${idFor(why)}"` : ''}>${esc(a.label)}</button></li>`;
        }).join('');
        frame((m.primary ? `<p class="validate-cta"><a href="${esc(m.primary.href)}" class="validate-primary" data-spa-link="true">${esc(m.primary.label)}</a></p>` : '')
            + `<p class="validate-setup-note">${esc(summaryLine())}</p>`
            + `<ul class="validate-manage-actions">${buttons}</ul>`
            + reasons.map((r, i) => `<p class="validate-msg" id="validate-manage-why-${i}">${esc(r)}</p>`).join('')
            + `<p class="validate-manage-links">${m.links.map(l => `<a href="${esc(l.href)}" class="item-link" data-spa-link="true">${esc(l.label)}</a>`).join(' ')}`
            + ' <a href="/wallet" class="item-link" data-spa-link="true">Identity and proxies</a></p>');
        if (refocus && w.trigger) { const b = q(`[data-manage-action="${w.trigger}"]`); if (b && typeof b.focus === 'function') b.focus(); }
    }

    // ── a panel: one form, review or result ──
    function panel(title, inner) {
        frame(`<section class="validate-manage-panel" aria-labelledby="validate-manage-panel-title">`
            + `<h4 class="validate-headline" id="validate-manage-panel-title" tabindex="-1">${esc(title)}</h4>${inner}</section>`);
    }
    const focusPanel = () => { const h = q('#validate-manage-panel-title'); if (h && typeof h.focus === 'function') h.focus(); };
    const cancel = '<button type="button" class="validate-text-btn" data-manage-action="cancel">Cancel</button>';
    const reviewBtn = (label = 'Review') => `<button type="button" class="validate-primary" data-manage-action="review">${esc(label)}</button>`;
    const invalid = () => (w.msg.field ? ' aria-invalid="true"' : '');

    function commissionForm() {
        const s = w.state, p = s.prefs || { commission: 0, blocked: false };
        const min = w.limits.minCommission == null ? 'Minimum: unknown.' : `Minimum: ${perbillToPercent(w.limits.minCommission)}.`;
        const median = w.params && w.params.medianCommission != null ? ` Median of active validators: ${perbillToPercent(w.params.medianCommission)}.` : '';
        return `<p class="validate-setup-note">Current commission: ${esc(perbillToPercent(p.commission))}.${p.blocked ? ' New nominations are blocked.' : ''}</p>`
            + '<label for="validate-manage-commission" class="validate-label">New commission (%)</label>'
            + `<input id="validate-manage-commission" type="text" inputmode="decimal" class="mono" data-input-kind="amount" data-amount-strict autocomplete="off" aria-describedby="validate-manage-msg validate-manage-limits validate-manage-warn" value="${esc(w.input.text || '')}"${invalid()}>`
            + `<p id="validate-manage-limits" class="validate-msg">${esc(min + median)}</p>`
            + `<p class="validate-ack"><input type="checkbox" id="validate-manage-blocked"${w.input.blocked ? ' checked' : ''}> <label for="validate-manage-blocked">Block new nominations</label></p>`
            + (w.needsConfirm ? `<p class="validate-ack"><input type="checkbox" id="validate-manage-confirm100"${w.input.confirm100 ? ' checked' : ''}> <label for="validate-manage-confirm100">${esc(M.CONFIRM_100)}</label></p>` : '')
            + msgP('validate-manage-msg', w.msg.text)
            + `<p id="validate-manage-warn" class="validate-msg">${esc(w.msg.warn || '')}</p>`
            + `<div class="validate-setup-actions">${cancel}${reviewBtn()}</div>`;
    }

    function keysTable(r) {
        const rows = r.rows.map((k, i) => `<tr><td>${i + 1}</td><th scope="row">${esc(k.name)}</th><td class="mono">${esc(k.preview)}</td>`
            + `<td><span class="validate-word ${k.result === 'other' ? 'is-error' : 'is-neutral'}">${esc(RESULT_TEXT[k.result] || k.result)}</span>`
            + (k.result === 'other' ? ` <span class="mono">${esc(k.owner)}</span>` : '') + '</td></tr>').join('');
        return `<div class="validate-alert" role="alert">${esc(r.summary)}</div>`
            + '<div class="balance-locks-table-wrap"><table class="data-table validate-keys-table"><caption class="validate-caption">Each key and who it is registered to</caption><thead><tr>'
            + '<th scope="col" class="table-th">#</th><th scope="col" class="table-th">Key</th><th scope="col" class="table-th">First and last 8</th><th scope="col" class="table-th">Result</th>'
            + `</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    function keysForm() {
        const lay = w.limits.layout;
        if (!lay || !lay.ok) {
            return `<p class="validate-mismatch" role="status">${esc(layoutMismatchText(w.limits.specVersion))} Key registration is switched off here; existing keys are not affected.</p>`
                + `<div class="validate-setup-actions">${cancel}</div>`;
        }
        return '<p class="validate-setup-note">On the server of the node that will validate, run author_rotateKeys against 127.0.0.1 and paste the line it prints. Never run it through a public RPC. '
            + '<a href="/validate/node" class="item-link" data-spa-link="true">The node guide</a> has the command.</p>'
            + `<label for="validate-manage-keys" class="validate-label">New session keys (0x, ${esc(lay.hexLength)} characters)</label>`
            + `<textarea id="validate-manage-keys" class="validate-keys-input mono" rows="5" data-input-kind="hex" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="validate-manage-msg"${invalid()}>${esc(w.input.text || '')}</textarea>`
            + msgP('validate-manage-msg', w.msg.text)
            + (w.keyCheck ? keysTable(w.keyCheck) : '')
            + `<div class="validate-setup-actions">${cancel}${reviewBtn('Check and review')}</div>`;
    }
    function amountForm(intro, label) {
        return `<p class="validate-setup-note">${esc(intro)}</p>`
            + `<label for="validate-manage-amount" class="validate-label">${esc(label)}</label>`
            + `<div class="validate-lookup-row"><input id="validate-manage-amount" type="text" inputmode="decimal" class="mono" data-input-kind="amount" data-amount-strict autocomplete="off" aria-describedby="validate-manage-msg" value="${esc(w.input.text || '')}"${invalid()}>`
            + '<button type="button" class="validate-text-btn" data-manage-action="max">Max</button></div>'
            + msgP('validate-manage-msg', w.msg.text)
            + `<div class="validate-setup-actions">${cancel}${reviewBtn()}</div>`;
    }
    function payeeForm() {
        const p = w.input.payee;
        const radio = (v, label) => `<label class="validate-setup-choice"><input type="radio" name="validate-manage-payee" value="${v}"${p.kind === v ? ' checked' : ''}> ${esc(label)}</label>`;
        return `<p class="validate-setup-note">Rewards now: ${esc(M.payeeLabel(w.state.payee, shortAddr))}.</p>`
            + '<fieldset class="validate-setup-payee"><legend class="validate-label">Where rewards go</legend>'
            + radio('staked', 'Add rewards to my bond') + radio('stash', 'Pay rewards to this stash, unbonded') + radio('account', 'Pay rewards to another account')
            + '<label for="validate-manage-payee-account" class="validate-label">Rewards account</label>'
            + `<input id="validate-manage-payee-account" type="text" class="mono" data-input-kind="address" autocomplete="off" spellcheck="false" aria-describedby="validate-manage-msg" value="${esc(p.account || '')}"${p.kind === 'account' ? '' : ' hidden'}>`
            + '</fieldset>'
            + msgP('validate-manage-msg', w.msg.text)
            + `<div class="validate-setup-actions">${cancel}${reviewBtn()}</div>`;
    }
    function form() {
        const s = w.state;
        if (w.kind === 'commission') return commissionForm();
        if (w.kind === 'keys') return keysForm();
        if (w.kind === 'payee') return payeeForm();
        if (w.kind === 'bondExtra') {
            return amountForm(`Bonded: ${pdex(s.active)} PDEX. The most you can add now is ${pdex(M.maxBondMore(s, w.fee))} PDEX, keeping the network fee and 1 PDEX free for later fees.`, 'Amount to add (PDEX)');
        }
        return amountForm(`Unbonding: ${pdex(M.unlockingTotal(s))} PDEX. Bonded: ${pdex(s.active)} PDEX. Rebonding takes the most recent unbonding amounts first.`, 'Amount to rebond (PDEX)');
    }
    function paintForm(moved) {
        if (!live()) return;
        panel(TITLES[w.kind], form());
        if (moved) focusPanel();
    }

    async function open(kind) {
        const s = w.state;
        Object.assign(w, { kind, trigger: kind, msg: {}, needsConfirm: false, keyCheck: null, review: null, after: null, block: null,
            input: { text: '', blocked: !!(s.prefs && s.prefs.blocked), confirm100: false, payee: { kind: (s.payee && ['staked', 'stash', 'account'].includes(s.payee.kind)) ? s.payee.kind : 'staked', account: (s.payee && s.payee.account) || '' } } });
        if (kind === 'chill') return toReview({ kind: 'chill' });
        if (kind === 'bondExtra') {
            w.fee = await estimateManageFee(w.api, s.stash, { kind: 'bondExtra', value: big(s.balance && s.balance.free) || 1n });
            if (!live()) return;
        }
        paintForm(true);
    }

    // ── form to step ──
    const fail = (text, extra = {}) => { w.msg = { text, field: true, ...extra }; paintForm(false); return null; };
    async function stepFromForm() {
        const s = w.state, k = w.kind, text = String(w.input.text || '').trim();
        if (k === 'commission') {
            const prefs = s.prefs || { commission: 0, blocked: false };
            const p = text ? parsePercent(text) : { ok: true, perbill: Number(prefs.commission) };
            if (!p.ok) return fail(p.message);
            const c = M.commissionChange(p.perbill, { current: prefs.commission, currentBlocked: prefs.blocked, blocked: w.input.blocked, minCommission: w.limits.minCommission,
                median: w.params ? w.params.medianCommission : null, confirmed: w.input.confirm100 });
            if (!c.ok) { w.needsConfirm = w.needsConfirm || c.needsConfirm; return fail(c.message); }
            return { step: { kind: k, commission: p.perbill, blocked: !!w.input.blocked }, warning: c.warning };
        }
        if (k === 'keys') {
            const lay = w.limits.layout;
            const parsed = keysForSetup(w.input.text, { layout: lay && lay.ok ? lay.layout : null, specVersion: w.limits.specVersion });
            if (!parsed.ok) return fail(parsed.message);
            w.msg = { text: 'Checking the chain...' }; w.keyCheck = null; paintForm(false);
            let owners;
            try { owners = await readKeyOwners(w.api, parsed.keys, s.stash); } catch (e) { return fail('The explorer could not check these keys against the chain. Try again.'); }
            if (!live()) return null;
            const c = classifyKeyOwners(parsed.keys, { ...owners, stash: s.stash, isSame });
            const problem = M.rotateKeysProblem(c);
            if (problem && c.conflict) { w.keyCheck = { ...c, summary: keyCheckSummary(c, parsed.keys) }; w.msg = { field: true }; paintForm(false); return null; }
            if (problem) return fail(problem);
            return { step: { kind: k, keysHex: parsed.keysHex, names: parsed.keys.map(x => x.name), count: parsed.keys.length }, keys: parsed.keys };
        }
        if (k === 'payee') {
            const next = { kind: w.input.payee.kind, account: String(w.input.payee.account || '').trim() };
            const c = M.payeeChange(next, s.payee, { isAddress: d.isAddress, isSame, stash: s.stash });
            if (!c.ok) return fail(c.message);
            return { step: { kind: k, payee: next.kind === 'account' ? next : { kind: next.kind } } };
        }
        const a = parsePdexAmount(text);
        if (!a.ok) return fail(a.message);
        if (k === 'bondExtra') {
            const c = M.bondMoreCheck(a.planck, { max: M.maxBondMore(s, w.fee) });
            return c.ok ? { step: { kind: k, value: a.planck } } : fail(c.message);
        }
        const c = M.rebondCheck(a.planck, { state: s });
        return c.ok ? { step: { kind: k, value: a.planck } } : fail(c.message);
    }

    async function toReview(x) {
        const r0 = x && x.step ? x : { step: x };
        const step = r0.step, s = w.state;
        const signer = M.signerFor(step.kind, s);
        const fee = await estimateManageFee(w.api, signer, step);
        if (!live()) return;
        // The real call's fee can be above the one Max used.
        if (step.kind === 'bondExtra' && fee != null && step.value > M.maxBondMore(s, fee)) { w.fee = fee; return fail(M.bondMoreCheck(step.value, { max: M.maxBondMore(s, fee) }).message); }
        let call = null;
        try { call = M.buildManageCall(w.api, step); } catch (e) { call = null; }
        // The wallet session this review was shown for: a change after this
        // point makes submitSignedTx refuse (issue #70 rule).
        w.review = { kind: step.kind, stash: s.stash, signer, step, state: s, limits: w.limits, fee, call, keys: r0.keys || null, warning: r0.warning || '',
            inSet: IN_SET.has(model.state), revision: typeof d.revision === 'function' ? d.revision() : null };
        w.msg = {};
        paintReview(true);
    }

    function reviewNotes(r) {
        const k = r.kind, t = w.t;
        const P = (text) => `<p class="validate-setup-note">${esc(text)}</p>`;
        if (k === 'commission') {
            const blockedChanged = !!r.step.blocked !== !!(r.state.prefs && r.state.prefs.blocked);
            return (r.warning ? P(r.warning) : '') + P(M.commissionTimingText(t)) + (blockedChanged ? P(M.BLOCKED_NOTE) : '') + P(M.COMMISSION_NOTE);
        }
        if (k === 'keys') return P(M.keysTimingText(t)) + `<p class="validate-setup-note"><strong class="validate-manage-rule">${esc(M.ROTATE_RULE)}</strong></p>` + P(M.PURGE_NOTE);
        if (k === 'bondExtra') return P('The added bond counts toward the election for the next era.') + P(M.unbondingText(w.limits, t));
        if (k === 'payee') return P(M.PAYEE_TIMING);
        if (k === 'chill') return '<ul class="validate-manage-facts">' + M.chillText(t, { inSet: r.inSet }).map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';
        return P('Rebonded PDEX stops unbonding and is bonded again at once.');
    }
    function paintReview(moved) {
        if (!live()) return;
        const r = w.review;
        if (w.after) return paintResult();
        const it = M.reviewItem(r.step, { shortAddr, prefs: r.state.prefs });
        let args = '';
        try { args = r.call && typeof d.renderCall === 'function' ? d.renderCall(r.call) : ''; } catch (e) { args = ''; }
        const fee = r.fee == null ? 'The network fee could not be estimated; your wallet shows it.' : `Estimated network fee: ${pdex(r.fee)} PDEX.`;
        const who = isSame(r.signer, r.stash) ? 'the stash' : 'the controller';
        const chill = r.kind === 'chill';
        panel(chill ? 'Stop validating' : 'Review',
            `<p class="validate-setup-note">Signed by ${who} <span class="mono">${esc(r.signer)}</span>.</p>`
            + `<ol class="validate-review"><li><span class="validate-review-text">${esc(it.text)}</span> <code class="mono">${esc(it.call)}</code>`
            + (args ? `<div class="validate-review-args">${args}</div>` : '') + '</li></ol>'
            + reviewNotes(r)
            + `<p class="validate-setup-note">${esc(fee)}</p>`
            + msgP('validate-manage-sign-msg', w.msg.sign)
            + `<div class="validate-setup-actions"><button type="button" class="validate-text-btn" data-manage-action="${chill ? 'cancel' : 'back'}">${chill ? 'Cancel' : 'Back'}</button>`
            + `<button type="button" class="validate-primary" data-manage-action="sign">${chill ? 'Stop validating' : 'Sign and submit'}</button>`
            + (chill ? ' <a href="/unstake" class="item-link" data-spa-link="true">Unbond instead</a>' : '') + '</div>');
        if (moved) focusPanel();
    }

    function paintResult() {
        const a = w.after, r = w.review;
        if (a.applied) {
            const done = `Submitted and confirmed${w.block ? ` in block #${w.block}` : ''}.`;
            panel('Done', `<p role="status">${esc(done + ' ' + M.appliedText(r, a.after || {}, { t: w.t, shortAddr }))}</p>`
                + '<div class="validate-setup-actions"><button type="button" class="validate-secondary" data-manage-action="done">Back to manage</button></div>');
        } else {
            panel('Waiting for the chain', '<p role="status">The transaction went through, but the chain does not show the change for this stash yet. It can take a block.</p>'
                + '<div class="validate-setup-actions"><button type="button" class="validate-secondary" data-manage-action="recheck">Check again</button>'
                + '<button type="button" class="validate-text-btn" data-manage-action="done">Back to manage</button></div>');
        }
        focusPanel();
    }

    async function recheck() {
        try { w.after = await readManageApplied(w.api, w.review); } catch (e) { w.after = { applied: false }; }
        if (live()) paintResult();
    }

    function sign(button) {
        const r = w.review;
        if (!r) return;
        w.msg.sign = '';
        const amount = r.kind === 'bondExtra' || r.kind === 'rebond' ? { bondRequested: String(r.step.value) } : {};
        d.submit({
            buildTx: (api) => buildCheckedManageTx(api, r),
            label: TITLES[r.kind],
            action: { key: M.MANAGE_ACTION, params: { kind: r.kind, expectEvents: M.expectedManageEvents(r.step), summary: M.manageSummary(r.step), stash: r.stash, ...amount } },
            button, idleText: r.kind === 'chill' ? 'Stop validating' : 'Sign and submit',
            expectedWallet: r.signer, expectedRevision: r.revision,
            verify: (api) => verifyManage(api, r),
            onStage: (stage, m) => { const b = /#([\d,]+)/.exec(String((m && m.stageText) || '')); if (b) w.block = b[1]; },
            onError: (text) => { if (!live()) return; w.msg.sign = text; const p = q('#validate-manage-sign-msg'); if (p) p.textContent = text; },
            onSuccess: () => { recheck(); }
        });
    }

    // ── wiring (one listener per mount, on this mount's own box) ──
    box.addEventListener('click', async (e) => {
        const t = e.target && e.target.closest ? e.target.closest('[data-manage-action]') : null;
        if (!t || !live() || t.disabled) return;
        const a = t.getAttribute('data-manage-action');
        if (a === 'retry' || a === 'done') return load();
        if (TITLES[a] && !w.kind) return open(a);
        if (a === 'cancel') return menu(true);
        if (a === 'back') { w.review = null; w.msg = {}; return paintForm(true); }
        if (a === 'max') {
            const v = w.kind === 'bondExtra' ? M.maxBondMore(w.state, w.fee) : M.unlockingTotal(w.state);
            w.input.text = planckToInput(v);
            const f = q('#validate-manage-amount'); if (f) f.value = w.input.text;
            return;
        }
        if (a === 'review') { const x = await stepFromForm(); if (x && live()) await toReview(x); return; }
        if (a === 'sign') return sign(t);
        if (a === 'recheck') return recheck();
    });
    box.addEventListener('input', (e) => {
        const t = e.target;
        if (!t || !live()) return;
        if (t.id === 'validate-manage-commission' || t.id === 'validate-manage-amount' || t.id === 'validate-manage-keys') {
            w.input.text = t.value;
            if (t.id === 'validate-manage-keys') {
                w.keyCheck = null;
                const lay = w.limits.layout;
                const r = keysForSetup(t.value, { layout: lay && lay.ok ? lay.layout : null, specVersion: w.limits.specVersion });
                const m = q('#validate-manage-msg');
                if (m) m.textContent = r.ok ? `${r.keys.length} keys, ${r.keys.reduce((n, k) => n + k.bytes, 0)} bytes. Press Check and review to check them against the chain.` : (t.value.trim() ? r.message : '');
            } else if (t.id === 'validate-manage-commission') {
                const p = parsePercent(t.value);
                const warn = q('#validate-manage-warn');
                if (warn) warn.textContent = p.ok ? M.commissionChange(p.perbill, { minCommission: w.limits.minCommission, median: w.params ? w.params.medianCommission : null, confirmed: true }).warning : '';
            }
        } else if (t.id === 'validate-manage-payee-account') w.input.payee.account = t.value;
    });
    box.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || !live()) return;
        if (t.id === 'validate-manage-blocked') w.input.blocked = !!t.checked;
        else if (t.id === 'validate-manage-confirm100') w.input.confirm100 = !!t.checked;
        else if (t.name === 'validate-manage-payee') {
            w.input.payee.kind = t.value;
            const f = q('#validate-manage-payee-account');
            if (f) { if (t.value === 'account') f.removeAttribute('hidden'); else f.setAttribute('hidden', ''); enhanceInputActions(f); }
        }
    });

    await load();
}
