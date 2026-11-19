// /validate/setup: the setup wizard (Sprint 3, money path, behind
// FEATURE_FLAGS.validate). Design section 5.3, five steps; CEO decision D4: one
// utility.batchAll signed by the stash. Rules in lib/validator-setup.js,
// chain reads in lib/validator-setup-chain.js.
//
// - Progress comes from the chain only (nothing stored): the wizard opens at
//   the first step the chain does not show done, and the batch holds only the
//   missing steps. Already validating with keys: nothing to sign.
// - Signing goes through script.js submitSignedTx (d.submit), unchanged: the
//   fee preflight, the wallet-session revision taken when the review is shown,
//   buildTx that reads the limits, the balance, the fee and every KeyOwner
//   again, success from the events (expectEvents) and a verify for a quiet
//   subscription. After inclusion the wizard reads the chain once more and
//   says "confirmed" only when NextKeys equals the pasted keys and the
//   Validators entry is there.
// - Multisig and proxy signing come in Sprint 5: a multisig wallet is told so;
//   a legacy controller, or an account that controls another stash, is refused.
// - Never a seed: the keys field takes one 0x line of public keys and a secret
//   phrase is refused in the browser.
// - Brand: one primary per view (the button that moves forward), every state
//   a word, and the done tick is neutral (text colour, no green). BRAND.md
//   allows green for positive states; the design (section 5.5) keeps it for
//   "Active" and "Heartbeat received" only, so a step done on chain is not one.
//   Inputs carry data-input-kind for the paste and clear actions.
// Tested in test/validator-setup-view.test.js.

import { VALIDATE_STATEMENT } from './validator-status-view.js';
import { ROTATE_KEYS } from './validator-node-guide.js';
import { nodeCheckModel } from './node-check.js';
import { classifyKeyOwners, keyCheckSummary } from './session-keys.js';
import { formatPlanck } from './call-args-format.js';
import { perbillToPercent } from './validator-status.js';
import { feeFloor } from './fee-preflight.js';
import * as S from './validator-setup.js';
import { readSetupLimits, readSetupState, estimateSetupFee, buildCheckedSetupTx, verifySetup, readSetupApplied } from './validator-setup-chain.js';
import { readKeyOwners } from './validator-status-chain.js';

export const SETUP_STEPS = Object.freeze(['Your node', 'Session keys', 'Stash and bond', 'Commission', 'Review']);
const TITLES = ['Start with a running node', 'Paste your node\'s session keys', 'Bond from your stash', 'Set your commission', 'Review'];
const CONNECT_HREF = '/wallet?returnTo=%2Fvalidate%2Fsetup';
const RESULT_TEXT = { free: 'Not registered', own: 'This stash', other: 'Another account' };

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

// d: { account, getApi, isMultisig(address), revision(), submit(opts) (submitSignedTx),
//      fetchJson, esc, helpIcon, shortAddr, isAddress, isSame, renderCall(call), apiWaitMs }
export async function mountValidatorSetup(el, d) {
    if (!el) return;
    const token = {};
    current.set(el, token);
    const live = () => current.get(el) === token;
    const esc = d.esc, help = typeof d.helpIcon === 'function' ? d.helpIcon : () => '';
    const isSame = typeof d.isSame === 'function' ? d.isSame : (a, b) => a === b;
    el.innerHTML = '<div class="list-container glass validate-setup"></div>';
    const box = el.firstChild;
    const header = `<div class="list-header"><h2>Set up a validator ${help('validator-setup', 'Set up a validator: the steps and what you sign')}</h2></div>`;
    const frame = (inner) => { box.innerHTML = header + `<div class="validate-setup-body">${inner}</div>`; };
    const heading = (t) => `<h3 class="validate-headline" id="validate-step-title" tabindex="-1">${esc(t)}</h3>`;

    const account = d.account || {};
    if (account.status === 'restoring') return frame(`${heading('Checking for a connected wallet')}<p>Checking for a connected wallet...</p>`);
    if (account.status !== 'connected' || !account.address) {
        return frame(`${heading('Connect your stash')}<p>Connect the wallet that holds your stash to set up a validator.</p>`
            + `<a href="${CONNECT_HREF}" class="validate-primary" data-spa-link="true">Connect wallet</a> `
            + '<a href="/validate/node" class="item-link" data-spa-link="true">Read the node guide</a>');
    }
    const stash = String(account.address);
    if (typeof d.isMultisig === 'function' && d.isMultisig(stash)) {
        return frame(`${heading('Multisig setup is not available yet')}<p>Setting up a validator from a multisig or through a proxy is not available yet; it comes in a later release. Connect the stash account itself to continue.</p>`
            + '<a href="/validate" class="item-link" data-spa-link="true">Open validator status</a>');
    }

    const w = { step: 1, api: null, state: null, limits: null, params: null, fee: null,
        input: { nodeName: '', keysText: '', keys: null, keysHex: '', replacing: false, bondText: '', extraText: '', payee: { kind: 'staked', account: '' }, commissionText: '' },
        msg: {}, keyCheck: null, review: null, ack: false, after: null, block: null, signing: false };

    const q = (sel) => box.querySelector(sel);
    const focusHeading = () => { const h = q('#validate-step-title'); if (h && typeof h.focus === 'function') h.focus(); };
    const layout = () => (w.limits && w.limits.layout && w.limits.layout.ok ? w.limits.layout.layout : null);
    const hexLength = () => (w.limits && w.limits.layout && w.limits.layout.hexLength) || 388;
    const keysOnChain = () => !!(w.state && w.state.nextKeys);
    const keepKeys = () => keysOnChain() && !w.input.replacing;
    const doneOnChain = (i) => (i === 1 ? keysOnChain() : i === 2 ? !!w.state.bonded : i === 3 ? !!w.state.validating : false);
    const maxBond = () => S.maxBondable({ ...w.state.balance, ed: w.state.ed, fee: w.fee });

    // The fee behind Max: the batch that will be signed for this resume state
    // (lib/validator-setup.js feeProbeSteps), estimated again once keys are chosen.
    async function refreshFee() {
        const steps = S.feeProbeSteps(w.state, { keysHex: keepKeys() ? '' : w.input.keysHex, keep: keepKeys(), hexLength: layout() ? hexLength() : 0 });
        w.fee = await estimateSetupFee(w.api, stash, steps);
    }

    function errorView() {
        frame(`${heading('The explorer cannot reach the chain right now. Your validator is not affected.')}`
            + '<button type="button" class="validate-secondary" data-setup-action="retry">Retry</button>');
    }

    async function load() {
        frame(`${heading('Reading the chain')}<div class="validate-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`);
        const api = await waitApi(d);
        if (!live()) return;
        if (!api) return errorView();
        w.api = api;
        try {
            const [state, limits, params] = await Promise.all([
                readSetupState(api, stash), readSetupLimits(api),
                Promise.resolve().then(() => d.fetchJson('/api/validator/params')).catch(() => null)
            ]);
            if (!live()) return;
            Object.assign(w, { state, limits, params });
        } catch (e) {
            if (live()) errorView();
            return;
        }
        const refusal = S.controllerRefusal(w.state);
        if (refusal) return frame(`${heading('This account cannot run the setup')}<p class="validate-setup-note">${esc(refusal)}</p>`
            + '<a href="/validate" class="item-link" data-spa-link="true">Open validator status</a>');
        if (w.state.bonded && w.state.validating && w.state.nextKeys) return doneView();
        await refreshFee();
        if (!live()) return;
        w.step = !keysOnChain() ? 1 : !w.state.bonded ? 3 : !w.state.validating ? 4 : 5;
        paint(true);
    }

    function doneView() {
        frame(`${heading('This stash already validates.')}<p>It is bonded, its session keys are registered and it is asking to validate. Changes to commission, keys and bond come with the manage panel.</p>`
            + '<a href="/validate" class="validate-primary" data-spa-link="true">Open validator status</a>');
    }

    // ── steps ──
    function stepList() {
        return '<ol class="validate-steps">' + SETUP_STEPS.map((name, i) => {
            const n = i + 1, cur = n === w.step;
            const done = doneOnChain(i) ? 'Done on chain' : (i === 0 && keysOnChain() ? 'Done' : '');
            return `<li class="validate-step${cur ? ' is-current' : ''}${done ? ' is-done' : ''}"${cur ? ' aria-current="step"' : ''}>`
                + `<span class="validate-step-name">${esc(name)}</span>`
                + (done ? ` <span class="validate-step-done"><i class='bx bx-check' aria-hidden="true"></i> ${esc(done)}</span>` : '') + '</li>';
        }).join('') + '</ol>';
    }
    const back = '<button type="button" class="validate-text-btn" data-setup-action="back">Back</button>';
    const msgP = (id, text, extra = '') => `<p id="${id}" class="validate-msg" aria-live="polite"${extra}>${esc(text || '')}</p>`;

    function step1() {
        return `<p class="validate-statement">${esc(VALIDATE_STATEMENT)}</p>`
            + '<p>You need a server that is synced, started with --validator, and reachable on port 30333.</p>'
            + '<label for="validate-setup-node" class="validate-label">Node name (the value of --name)</label>'
            + `<div class="validate-lookup-row"><input id="validate-setup-node" type="text" class="mono" data-input-kind="text" autocomplete="off" spellcheck="false" maxlength="64" aria-describedby="validate-setup-node-result" value="${esc(w.input.nodeName)}">`
            + '<button type="button" class="validate-secondary" data-setup-action="check-node">Check my node</button></div>'
            + msgP('validate-setup-node-result', w.msg.node)
            + '<p class="validate-setup-note">The explorer takes your word for this step.</p>'
            + '<div class="validate-setup-actions"><button type="button" class="validate-primary" data-setup-action="next">My node is ready</button> '
            + '<a href="/validate/node" class="item-link" data-spa-link="true">Show me how to set one up</a></div>';
    }

    function keysTable(r) {
        const rows = r.rows.map((k, i) => `<tr><td>${i + 1}</td><th scope="row">${esc(k.name)}</th><td class="mono">${esc(k.preview)}</td>`
            + `<td><span class="validate-word ${k.result === 'other' ? 'is-error' : 'is-neutral'}">${esc(RESULT_TEXT[k.result] || k.result)}</span>`
            + (k.result === 'other' ? ` <span class="mono">${esc(k.owner)}</span>` : '') + '</td></tr>').join('');
        return (r.conflict ? `<div class="validate-alert" role="alert">${esc(r.summary)}</div>` : '')
            + '<div class="balance-locks-table-wrap"><table class="data-table validate-keys-table"><caption class="validate-caption">Each key and who it is registered to</caption><thead><tr>'
            + '<th scope="col" class="table-th">#</th><th scope="col" class="table-th">Key</th><th scope="col" class="table-th">First and last 8</th><th scope="col" class="table-th">Result</th>'
            + `</tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function step2() {
        const intro = '<p>On your server, run author_rotateKeys against 127.0.0.1 and paste the line it prints. Never run it through a public RPC.</p>'
            + `<pre class="mono validate-setup-cmd" tabindex="0" aria-label="The command to run on your server">${esc(ROTATE_KEYS)}</pre>`;
        if (keepKeys()) {
            return '<p>This stash already has session keys registered.</p>'
                + `<div class="validate-setup-actions">${back}<button type="button" class="validate-primary" data-setup-action="keep-keys">Keep them</button> `
                + '<button type="button" class="validate-text-btn" data-setup-action="replace-keys">Replace them</button></div>';
        }
        if (!layout()) {
            return `<p class="validate-mismatch" role="status">${esc(S.keysForSetup('', { layout: null }).message)} Key registration is switched off here; existing keys are not affected.</p>`
                + `<div class="validate-setup-actions">${back}</div>`;
        }
        const parsed = w.input.keysText ? S.keysForSetup(w.input.keysText, { layout: layout(), specVersion: w.limits.specVersion }) : null;
        return intro
            + `<label for="validate-setup-keys" class="validate-label">Session keys (0x, ${esc(hexLength())} characters)</label>`
            + `<textarea id="validate-setup-keys" class="validate-keys-input mono" rows="5" data-input-kind="hex" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="validate-setup-keys-msg"${parsed && !parsed.ok ? ' aria-invalid="true"' : ''}>${esc(w.input.keysText)}</textarea>`
            + '<div class="validate-setup-actions"><button type="button" class="validate-text-btn" data-setup-action="paste">Paste</button></div>'
            + msgP('validate-setup-keys-msg', w.msg.keys || (parsed && !parsed.ok ? parsed.message : ''))
            + (w.keyCheck ? keysTable(w.keyCheck) : '')
            + '<p class="validate-msg">The explorer cannot check that your node holds these keys. <a href="/validate/node" class="item-link" data-spa-link="true">The node guide</a> shows how to check that on the server.</p>'
            + `<div class="validate-setup-actions">${back}<button type="button" class="validate-primary" data-setup-action="use-keys"${parsed && parsed.ok ? '' : ' disabled'}>Use these keys</button></div>`;
    }

    function step3() {
        const s = w.state;
        const transferable = (() => { const t = big(s.balance.free) - feeFloor({ frozen: big(s.balance.frozen), reserved: big(s.balance.reserved), ed: big(s.ed) }); return t > 0n ? t : 0n; })();
        const lowest = w.params && w.params.lowestElectedTotal;
        const limitsLine = `Minimum to validate: ${pdex(w.limits.minValidatorBond)} PDEX.` + (lowest ? ` Lowest elected backing this era: ${pdex(lowest)} PDEX.` : '');
        const notes = S.planSetup(s, { keys: null, keysHex: '' }).notes;
        let amount;
        if (!s.bonded) {
            const p = w.input.payee;
            const radio = (v, label) => `<label class="validate-setup-choice"><input type="radio" name="validate-setup-payee" value="${v}"${p.kind === v ? ' checked' : ''}> ${esc(label)}</label>`;
            amount = '<label for="validate-setup-bond" class="validate-label">Amount to bond (PDEX)</label>'
                + `<div class="validate-lookup-row"><input id="validate-setup-bond" type="text" inputmode="decimal" class="mono" data-input-kind="amount" autocomplete="off" aria-describedby="validate-setup-bond-msg validate-setup-bond-limits" value="${esc(w.input.bondText)}"${w.msg.bondField ? ' aria-invalid="true"' : ''}>`
                + '<button type="button" class="validate-text-btn" data-setup-action="max">Max</button></div>'
                + `<p id="validate-setup-bond-limits" class="validate-msg">${esc(limitsLine)}</p>`
                + '<fieldset class="validate-setup-payee"><legend class="validate-label">Where rewards go</legend>'
                + radio('staked', 'Add rewards to my bond') + radio('stash', 'Pay rewards to this stash, unbonded') + radio('account', 'Pay rewards to another account')
                + '<label for="validate-setup-payee-account" class="validate-label">Rewards account</label>'
                + `<input id="validate-setup-payee-account" type="text" class="mono" data-input-kind="address" autocomplete="off" spellcheck="false" value="${esc(p.account)}"${p.kind === 'account' ? '' : ' hidden'} aria-describedby="validate-setup-bond-msg">`
                + '</fieldset>';
        } else {
            amount = `<p>Bonded: ${esc(pdex(s.active))} PDEX.</p>`
                + '<label for="validate-setup-extra" class="validate-label">Add to bond (optional, PDEX)</label>'
                + `<div class="validate-lookup-row"><input id="validate-setup-extra" type="text" inputmode="decimal" class="mono" data-input-kind="amount" autocomplete="off" aria-describedby="validate-setup-bond-msg validate-setup-bond-limits" value="${esc(w.input.extraText)}"${w.msg.bondField ? ' aria-invalid="true"' : ''}>`
                + '<button type="button" class="validate-text-btn" data-setup-action="max">Max</button></div>'
                + `<p id="validate-setup-bond-limits" class="validate-msg">${esc(limitsLine)}</p>`;
        }
        return `<p>Stash: <span class="mono">${esc(stash)}</span>. Transferable: ${esc(pdex(transferable))} PDEX.</p>`
            + `<p class="validate-setup-note">Use a stash whose key stays offline as much as possible: a Ledger, a multisig or an air-gapped signer. For routine changes, add a separate Staking proxy later. ${help('validator-setup', 'Why a separate stash and proxy')}</p>`
            + '<p class="validate-setup-note">Setting up through a proxy or a multisig is not available yet: connect the stash itself.</p>'
            + amount
            + notes.map(n => `<p class="validate-setup-note">${esc(n)}</p>`).join('')
            + msgP('validate-setup-bond-msg', w.msg.bond)
            + `<p id="validate-setup-bond-warn" class="validate-msg">${esc(w.msg.bondWarn || '')}</p>`
            + `<div class="validate-setup-actions">${back}<button type="button" class="validate-primary" data-setup-action="next">Continue</button></div>`;
    }

    function commissionWarning(text) {
        const p = S.parsePercent(text);
        if (!p.ok) return '';
        return S.commissionCheck(p.perbill, { minCommission: w.limits.minCommission, median: w.params ? w.params.medianCommission : null }).warning;
    }
    function step4() {
        const median = w.params && w.params.medianCommission != null ? ` Median of active validators: ${perbillToPercent(w.params.medianCommission)}.` : '';
        const min = w.limits.minCommission == null ? 'Minimum: unknown.' : `Minimum: ${perbillToPercent(w.limits.minCommission)}.`;
        return '<p>Commission is the share of rewards you keep before the rest is split by stake between you and your nominators.</p>'
            + '<label for="validate-setup-commission" class="validate-label">Commission (%)</label>'
            + `<input id="validate-setup-commission" type="text" inputmode="decimal" class="mono" data-input-kind="amount" autocomplete="off" aria-describedby="validate-setup-commission-msg validate-setup-commission-limits" value="${esc(w.input.commissionText)}"${w.msg.commission ? ' aria-invalid="true"' : ''}>`
            + `<p id="validate-setup-commission-limits" class="validate-msg">${esc(min + median)}</p>`
            + msgP('validate-setup-commission-msg', w.msg.commission)
            + `<p id="validate-setup-commission-warn" class="validate-msg">${esc(commissionWarning(w.input.commissionText))}</p>`
            + `<div class="validate-setup-actions">${back}<button type="button" class="validate-primary" data-setup-action="next">Continue</button></div>`;
    }

    function step5() {
        const r = w.review;
        if (w.after) return resultHtml();
        const items = S.reviewItems(r.steps, { shortAddr: d.shortAddr }).map((it, i) => {
            let args = '';
            try { args = typeof d.renderCall === 'function' ? d.renderCall(r.calls[i]) : ''; } catch (e) { args = ''; }
            return `<li><span class="validate-review-text">${esc(it.text)}</span> <code class="mono">${esc(it.call)}</code>`
                + (args ? `<div class="validate-review-args">${args}</div>` : '') + '</li>';
        }).join('');
        const fee = r.fee == null ? 'The network fee could not be estimated; your wallet shows it.' : `Estimated network fee: ${pdex(r.fee)} PDEX.`;
        return `<p>Signed by the stash <span class="mono">${esc(stash)}</span>, which becomes the validator.</p>`
            + `<ol class="validate-review">${items}</ol>`
            + (r.notes || []).map(n => `<p class="validate-setup-note">${esc(n)}</p>`).join('')
            + `<p>${esc(fee + ' ' + S.atomicText(r.steps.length))}</p>`
            + `<p>${esc(S.timingText(w.params || {}))}</p>`
            + '<div class="validate-warnings"><ul>' + S.SETUP_WARNINGS.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>'
            + `<p class="validate-ack"><input type="checkbox" id="validate-setup-ack"${w.ack ? ' checked' : ''}> <label for="validate-setup-ack">${esc(S.SLASH_ACK)}</label></p></div>`
            + msgP('validate-setup-sign-msg', w.msg.sign)
            + `<div class="validate-setup-actions">${back}<button type="button" class="validate-primary" data-setup-action="sign"${w.ack && !w.signing ? '' : ' disabled'}>Sign and submit</button></div>`;
    }

    function resultHtml() {
        const a = w.after;
        if (a.applied) {
            const done = `Submitted and confirmed${w.block ? ` in block #${esc(w.block)}` : ''}.`;
            const short = a.bondShort ? ' ' + esc(S.bondShortText(a.bondShort, { validating: w.review.steps.some(s => s.kind === 'validate') })) : '';
            return `<p role="status">${done}${short || ' You are now waiting for election.'}</p>`
                + `<p>${esc(S.timingText(w.params || {}))}</p>`
                + '<a href="/validate" class="validate-primary" data-spa-link="true">Open validator status</a>';
        }
        const what = { bond: 'the bond', keys: 'these keys', validate: 'the validator entry' };
        return `<p role="status">The transaction went through, but the chain does not show ${esc(a.missing.map(m => what[m] || m).join(', ') || 'every step')} for this stash yet. It can take a block.</p>`
            + '<button type="button" class="validate-secondary" data-setup-action="recheck">Check again</button> '
            + '<a href="/validate" class="item-link" data-spa-link="true">Open validator status</a>';
    }

    function paint(moved) {
        if (!live()) return;
        const body = [step1, step2, step3, step4, step5][w.step - 1]();
        frame(`<p class="validate-setup-progress">Step ${w.step} of ${SETUP_STEPS.length}: ${esc(SETUP_STEPS[w.step - 1])}</p>`
            + stepList()
            + `<section class="validate-setup-step" aria-labelledby="validate-step-title">${heading(TITLES[w.step - 1])}${body}</section>`);
        if (moved) focusHeading();
    }
    const go = (n) => { w.step = n; w.msg = {}; paint(true); };

    // ── actions ──
    async function useKeys() {
        const parsed = S.keysForSetup(w.input.keysText, { layout: layout(), specVersion: w.limits.specVersion });
        if (!parsed.ok) { w.msg.keys = parsed.message; return paint(false); }
        w.msg.keys = 'Checking the chain...'; w.keyCheck = null; paint(false);
        try {
            const owners = await readKeyOwners(w.api, parsed.keys, stash);
            if (!live()) return;
            const r = classifyKeyOwners(parsed.keys, { ...owners, stash, isSame });
            r.summary = keyCheckSummary(r, parsed.keys);
            if (r.conflict) { w.keyCheck = r; w.msg.keys = ''; return paint(false); }
            Object.assign(w.input, { keys: parsed.keys, keysHex: parsed.keysHex });
            w.keyCheck = null;
            await refreshFee();
            if (!live()) return;
            go(3);
        } catch (e) {
            if (!live()) return;
            w.msg.keys = 'The explorer could not check these keys against the chain. Try again.';
            paint(false);
        }
    }

    function bondInputs() {
        const s = w.state;
        const lowest = w.params ? w.params.lowestElectedTotal : null;
        const ctx = { minValidatorBond: w.limits.minValidatorBond, max: maxBond(), lowestElected: lowest, ed: s.ed };
        if (s.bonded) {
            const t = String(w.input.extraText || '').trim();
            const p = t ? S.parsePdexAmount(t) : { ok: true, planck: 0n };
            if (!p.ok) return { error: p.message };
            const c = S.bondCheck(p.planck, { ...ctx, active: s.active, optional: true });
            return c.ok ? { extra: p.planck, warning: c.warning } : { error: c.message };
        }
        const p = S.parsePdexAmount(w.input.bondText);
        if (!p.ok) return { error: p.message };
        const c = S.bondCheck(p.planck, ctx);
        if (!c.ok) return { error: c.message };
        if (w.input.payee.kind === 'account') {
            const a = String(w.input.payee.account || '').trim();
            const okAddr = typeof d.isAddress === 'function' ? d.isAddress(a) : !!a;
            if (!okAddr) return { error: 'Enter a Polkadex address for the rewards account. Polkadex addresses start with e.', payee: true };
        }
        return { bond: p.planck, warning: c.warning };
    }

    function commissionInput() {
        const p = S.parsePercent(w.input.commissionText);
        if (!p.ok) return { error: p.message };
        const c = S.commissionCheck(p.perbill, { minCommission: w.limits.minCommission, median: w.params ? w.params.medianCommission : null });
        return c.ok ? { commission: p.perbill } : { error: c.message };
    }

    async function toReview() {
        const b = bondInputs();
        if (b.error) { w.step = 3; w.msg = { bond: b.error, bondField: !b.payee }; return paint(true); }
        let commission = 0;
        if (!w.state.validating) {
            const c = commissionInput();
            if (c.error) { w.step = 4; w.msg = { commission: c.error }; return paint(true); }
            commission = c.commission;
        }
        const input = { bond: b.bond || 0n, extra: b.extra || 0n, payee: { ...w.input.payee, account: String(w.input.payee.account || '').trim() },
            keys: keepKeys() ? null : w.input.keys, keysHex: keepKeys() ? '' : w.input.keysHex, commission };
        if (!keepKeys() && !w.input.keys) { w.step = 2; w.msg = {}; return paint(true); }
        const plan = S.planSetup(w.state, input);
        if (plan.refusal) { w.step = 2; w.msg = { keys: plan.refusal }; return paint(true); }
        if (plan.nothingToDo) return doneView();
        const fee = await estimateSetupFee(w.api, stash, plan.steps);
        if (!live()) return;
        // The real batch's fee can be above the probe's: an amount that no
        // longer fits goes back to Bond with the fee and the new most.
        const added = w.state.bonded ? input.extra : input.bond;
        if (fee != null && added > 0n) {
            const max = S.maxBondable({ ...w.state.balance, ed: w.state.ed, fee });
            if (added > max) { w.fee = fee; w.step = 3; w.msg = { bond: S.feeRoseText(fee, max), bondField: true }; return paint(true); }
        }
        let calls = [];
        try { calls = S.setupCalls(w.api, plan.steps); } catch (e) { calls = []; }
        // The wallet session this review was shown for: a change after this
        // point makes submitSignedTx refuse (issue #70 rule).
        w.review = { stash, steps: plan.steps, notes: [b.warning].concat(plan.notes).filter(Boolean), keys: input.keys, keysHex: input.keysHex,
            bond: input.bond, extra: input.extra, commission, state: w.state, limits: w.limits, fee, calls,
            revision: typeof d.revision === 'function' ? d.revision() : null };
        w.ack = false;
        go(5);
    }

    async function recheck() {
        try { w.after = await readSetupApplied(w.api, w.review); } catch (e) { w.after = { applied: false, missing: [] }; }
        if (live()) paint(false);
    }

    function sign(button) {
        const r = w.review;
        if (!r || !w.ack || w.signing) return;
        w.msg.sign = '';
        const asked = big(r.state && r.state.bonded ? r.extra : r.bond);
        d.submit({
            buildTx: (api) => buildCheckedSetupTx(api, r),
            label: 'Set up validator',
            action: { key: S.SETUP_ACTION, params: { expectEvents: S.expectedSetupEvents(r.steps), summary: S.setupSummary(r.steps), stash, ...(asked > 0n ? { bondRequested: String(asked) } : {}) } },
            button, idleText: 'Sign and submit',
            expectedWallet: stash, expectedRevision: r.revision,
            verify: (api) => verifySetup(api, r),
            onStage: (stage, m) => { const b = /#(\d+)/.exec(String((m && m.stageText) || '')); if (b) w.block = b[1]; },
            onError: (text) => { if (!live()) return; w.msg.sign = text; const p = q('#validate-setup-sign-msg'); if (p) p.textContent = text; },
            onSuccess: () => { recheck(); }
        });
    }

    // ── wiring (one listener per mount, on this mount's own box) ──
    box.addEventListener('click', async (e) => {
        const t = e.target && e.target.closest ? e.target.closest('[data-setup-action]') : null;
        if (!t || !live()) return;
        const a = t.getAttribute('data-setup-action');
        if (a === 'retry') return load();
        if (a === 'back') { let n = w.step - 1; if (n === 4 && w.state.validating) n = 3; return go(Math.max(1, n)); }
        if (a === 'keep-keys') return go(3);
        if (a === 'replace-keys') { w.input.replacing = true; return paint(false); }
        if (a === 'use-keys') return useKeys();
        if (a === 'paste') {
            try { w.input.keysText = await globalThis.navigator.clipboard.readText(); paint(false); const f = q('#validate-setup-keys'); if (f) f.focus(); } catch (err) { const m = q('#validate-setup-keys-msg'); if (m) m.textContent = 'The browser did not allow reading the clipboard. Paste into the field instead.'; }
            return;
        }
        if (a === 'max') {
            const f = q('#validate-setup-bond') || q('#validate-setup-extra');
            const v = S.planckToInput(maxBond());
            if (f) f.value = v;
            if (w.state.bonded) w.input.extraText = v; else w.input.bondText = v;
            return;
        }
        if (a === 'check-node') {
            const name = String(w.input.nodeName || '').trim();
            const out = q('#validate-setup-node-result');
            if (!name) { if (out) out.textContent = 'Enter the node name first.'; return; }
            let r;
            try { r = await d.fetchJson('/api/telemetry/node?name=' + encodeURIComponent(name)); } catch (err) { r = { feed: 'down', name }; }
            if (!live()) return;
            w.msg.node = nodeCheckModel({ ...r, name: r && r.name ? r.name : name }).text;
            const o = q('#validate-setup-node-result'); if (o) o.textContent = w.msg.node;
            return;
        }
        if (a === 'recheck') return recheck();
        if (a === 'sign') return sign(t);
        if (a === 'next') {
            if (w.step === 1) return go(2);
            if (w.step === 3) {
                const b = bondInputs();
                if (b.error) { w.msg = { bond: b.error, bondField: !b.payee }; return paint(false); }
                return w.state.validating ? toReview() : go(4);
            }
            if (w.step === 4) {
                const c = commissionInput();
                if (c.error) { w.msg = { commission: c.error }; return paint(false); }
                return toReview();
            }
        }
    });
    box.addEventListener('input', (e) => {
        const t = e.target;
        if (!t || !live()) return;
        if (t.id === 'validate-setup-node') w.input.nodeName = t.value;
        else if (t.id === 'validate-setup-bond') w.input.bondText = t.value;
        else if (t.id === 'validate-setup-extra') w.input.extraText = t.value;
        else if (t.id === 'validate-setup-payee-account') w.input.payee.account = t.value;
        else if (t.id === 'validate-setup-commission') {
            w.input.commissionText = t.value;
            const warn = q('#validate-setup-commission-warn'); if (warn) warn.textContent = commissionWarning(t.value);
        } else if (t.id === 'validate-setup-keys') {
            w.input.keysText = t.value;
            w.keyCheck = null;
            const r = S.keysForSetup(t.value, { layout: layout(), specVersion: w.limits.specVersion });
            const m = q('#validate-setup-keys-msg'), use = q('[data-setup-action="use-keys"]');
            if (m) m.textContent = r.ok ? `${r.keys.length} keys, ${r.keys.reduce((n, k) => n + k.bytes, 0)} bytes. Press Use these keys to check them against the chain.` : (t.value.trim() ? r.message : '');
            if (r.ok || !t.value.trim()) t.removeAttribute('aria-invalid'); else t.setAttribute('aria-invalid', 'true');
            if (use) use.disabled = !r.ok;
        }
    });
    box.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || !live()) return;
        if (t.name === 'validate-setup-payee') {
            w.input.payee.kind = t.value;
            const f = q('#validate-setup-payee-account'); if (f) { if (t.value === 'account') f.removeAttribute('hidden'); else f.setAttribute('hidden', ''); }
        } else if (t.id === 'validate-setup-ack') {
            w.ack = !!t.checked;
            const s = q('[data-setup-action="sign"]'); if (s) s.disabled = !w.ack || w.signing;
        }
    });

    await load();
}
