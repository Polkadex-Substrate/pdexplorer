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
// - Sprint 5: a multisig stash (one of the explorer's multisig wallets) sets up
//   here too: the one batch goes to the existing multisig review through
//   submitSignedTx, and the result says when an approval is only recorded. A
//   proxy cannot set up (design D2: setup needs the stash or its multisig);
//   a legacy controller, or an account that controls another stash, is refused.
// - Never a seed: the keys field takes one 0x line of public keys and a secret
//   phrase is refused in the browser.
// - Brand: one primary per view (the button that moves forward), every state
//   a word. Colour roles (spec 2026-11-21 section 5.1, visual only): the card
//   has the hairline and the compact path (step 2 current); violet step
//   markers, "Done on chain" green with its check; the statement is the trust
//   row; stash notes and timing are blue, the review warnings and cautions
//   amber, alerts and invalid fields red, the confirmed result a green panel.
//   Every string, field, action and guard is frozen (test/wp3-freeze.test.js).
//   Inputs carry data-input-kind for the paste and clear actions.
// Tested in test/validator-setup-view.test.js.

import { VALIDATE_STATEMENT, followStatusBlocks } from './validator-status-view.js';
import { ROTATE_KEYS } from './validator-node-guide.js';
import { nodeCheckModel } from './node-check.js';
import { classifyKeyOwners, keyCheckSummary } from './session-keys.js';
import { formatPlanck } from './call-args-format.js';
import { perbillToPercent } from './validator-status.js';
import { feeFloor } from './fee-preflight.js';
import { MULTISIG_FEE_NOTE, MULTISIG_CHANGE_WARNING } from './validator-delegate.js';
import * as S from './validator-setup.js';
import { enhanceInputActions } from './input-actions.js';
import { readSetupLimits, readSetupState, estimateSetupFee, buildCheckedSetupTx, verifySetup, readSetupApplied,
    buildStepwisePlan, readStepwiseFresh, buildCheckedSetupStepTx, verifySetupStep, CHAIN_DOWN_TEXT } from './validator-setup-chain.js';
import { readKeyOwners } from './validator-status-chain.js';
import { SW as SWT, stepwiseGate, stepOutcome, stepAction, stepwiseTotalFee, stopLine, unbondDays } from './validator-setup-steps.js';
import { stepwiseHtml, SIGNABLE_STATES } from './validator-setup-steps-view.js';
import { EXPECTED_LAYOUT } from './session-keys.js';
import { FALLBACK_BONDING_DURATION, FALLBACK_SESSIONS_PER_ERA, FALLBACK_SESSION_SECONDS } from './validator-status.js';
import { icon, panelHtml, linePanelHtml, trustHtml, stepMarkerHtml, setChip, resultWord } from './ui-parts.js';
import { pathState, renderPath } from './validator-path.js';

export const SETUP_STEPS = Object.freeze(['Your node', 'Session keys', 'Stash and bond', 'Commission', 'Review']);
const TITLES = ['Start with a running node', 'Paste your node\'s session keys', 'Bond from your stash', 'Set your commission', 'Review'];
const CONNECT_HREF = '/wallet?returnTo=%2Fvalidate%2Fsetup';
// Guide links and help icons inside a step open in a new tab, so what is typed stays (CEO approval 2026-11-25, Q30).
// Never on a button that moves forward or signs.
const NEW_TAB = ' target="_blank" rel="noopener"';
const RESULT_TEXT = { free: 'Not registered', own: 'This stash', other: 'Another account' };

const big = (x) => { try { return x == null || x === '' ? 0n : BigInt(String(x)); } catch (e) { return 0n; } };
const pdex = (v) => formatPlanck(big(v)) ?? '0';

const current = new WeakMap();
// A stepper open on a page element, in memory only (F6): a remount after a
// wallet change says once that it was stopped (SW-56).
const stepperOn = new WeakMap();
// Tracker stages that end an attempt without onError or onSuccess.
const SETTLED_STAGES = ['waiting', 'unconfirmed', 'stalled', 'processed', 'unverified', 'confirmed'];

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
    const was = stepperOn.get(el);
    stepperOn.delete(el);
    const rev0 = typeof d.revision === 'function' ? d.revision() : null;
    const stoppedNote = was && was.revision !== rev0 ? SWT.walletChanged(typeof d.shortAddr === 'function' ? d.shortAddr(was.stash) : was.stash) : '';
    const live = () => current.get(el) === token;
    const esc = d.esc, help = typeof d.helpIcon === 'function' ? d.helpIcon : () => '';
    const helpNewTab = (slug, label) => String(help(slug, label) || '').replace(/^<a /, `<a${NEW_TAB} `);
    const isSame = typeof d.isSame === 'function' ? d.isSame : (a, b) => a === b;
    el.innerHTML = '<div class="list-container glass validate-setup ui-hairline"></div>';
    const box = el.firstChild;
    const header = `<div class="list-header"><h2>Set up a validator ${helpNewTab('validator-setup', 'Set up a validator: the steps and what you sign')}</h2></div>`;
    // Paste and Clear on every text box as the step paints (the shared observer is the safety net).
    const note = stoppedNote ? `<p class="validate-setup-note" role="status">${esc(stoppedNote)}</p>` : '';
    // The compact path (spec 5.1, fidelity review 1): step 2 current; step 1 done once keys are on chain.
    let keysKnown = false;
    // Once the setup is confirmed on chain (the wizard result or the stepper's S10): step 2 done, step 3 current.
    let finished = false;
    // here: this page is step 2, so it is not a link to itself; Run a node opens in a new tab (the typed keys stay).
    const path = () => renderPath(pathState(finished ? 'waiting' : keysKnown ? 'keys-not-validating' : 'not-bonded', { connected: true }), { esc, compact: true, here: 'setup', newTab: 'node' });
    const frame = (inner) => { box.innerHTML = header + path() + `<div class="validate-setup-body">${note}${inner}</div>`; enhanceInputActions(box); };
    const heading = (t) => `<h3 class="validate-headline" id="validate-step-title" tabindex="-1">${esc(t)}</h3>`;

    const account = d.account || {};
    if (account.status === 'restoring') return frame(heading('Checking for a connected wallet'));
    if (account.status !== 'connected' || !account.address) {
        return frame(`${heading('Connect your stash')}<p>Connect the wallet that holds your stash to set up a validator.</p>`
            + `<a href="${CONNECT_HREF}" class="validate-primary" data-spa-link="true">Connect wallet</a> `
            + '<a href="/validate/node" class="item-link" data-spa-link="true">Read the node guide</a>');
    }
    const stash = String(account.address);
    const ms = typeof d.isMultisig === 'function' && d.isMultisig(stash) && typeof d.findMultisig === 'function' ? d.findMultisig(stash) : null;
    // R5: a setup included while this page is open makes the stash's status current for the status page
    // (lib/validator-status-view.js followStatusBlocks); this page's recheck stays its own evidence.
    followStatusBlocks({ post: d.post, stash, live, fetchJson: d.fetchJson, same: isSame });

    const w = { step: 1, api: null, state: null, limits: null, params: null, fee: null,
        input: { nodeName: '', keysText: '', keys: null, keysHex: '', replacing: false, bondText: '', extraText: '', payee: { kind: 'staked', account: '' }, commissionText: '' },
        msg: {}, keyCheck: null, review: null, ack: false, after: null, block: null, signing: false,
        mode: 'wizard', sw: null, afterAttempt: false, topUpNote: null };

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
        if (refusal) return frame(`${heading('This account cannot run the setup')}${panelHtml('is-error validate-setup-note', 'bx-error-circle', esc(refusal), { tag: 'p' })}`
            + '<a href="/validate" class="item-link" data-spa-link="true">Open validator status</a>');
        if (w.state.bonded && w.state.validating && w.state.nextKeys) return doneView();
        await refreshFee();
        if (!live()) return;
        w.step = !keysOnChain() ? 1 : !w.state.bonded ? 3 : !w.state.validating ? 4 : 5;
        paint(true);
    }

    function doneView() {
        frame(`${heading('This stash already validates.')}<p>It is bonded, its session keys are registered and it is asking to validate. To change commission, keys or bond, use Manage this validator on the status page.</p>`
            + '<a href="/validate" class="validate-primary" data-spa-link="true">Open validator status</a>');
    }

    // ── steps ──
    // A step's look: the current one (violet), done on chain (green), behind and open, or later (muted).
    const stepDone = (i) => (doneOnChain(i) ? 'Done on chain' : (i === 0 && keysOnChain() ? 'Done' : ''));
    const stepMark = (i) => (finished ? 'done' : i + 1 === w.step ? 'current' : stepDone(i) ? 'done' : i + 1 < w.step ? 'open' : 'later');
    function stepList() {
        return '<ol class="validate-steps">' + SETUP_STEPS.map((name, i) => {
            const n = i + 1, cur = n === w.step;
            const done = stepDone(i);
            return `<li class="validate-step${cur ? ' is-current' : ''}${done ? ' is-done' : ''}"${cur ? ' aria-current="step"' : ''}>`
                + stepMarkerHtml(n, stepMark(i)) + '<span class="validate-step-main">'
                + `<span class="validate-step-name">${esc(name)}</span>`
                + (done ? ` <span class="validate-step-done"><i class='bx bx-check' aria-hidden="true"></i> ${esc(done)}</span>` : '') + '</span></li>';
        }).join('') + '</ol>';
    }
    // The phone progress line's bar (spec 5.1): one 4 px segment per step, labelled by the line itself.
    const progressBar = () => `<div class="validate-setup-bar" role="progressbar" aria-labelledby="validate-setup-progress" aria-valuemin="1" aria-valuemax="${SETUP_STEPS.length}" aria-valuenow="${w.step}">`
        + SETUP_STEPS.map((_, i) => `<span class="is-${{ current: 'current', done: 'done', open: 'open' }[stepMark(i)] || 'later'}"></span>`).join('') + '</div>';
    const back = '<button type="button" class="validate-text-btn" data-setup-action="back">Back</button>';
    const msgP = (id, text, extra = '') => `<p id="${id}" class="validate-msg" aria-live="polite"${extra}>${esc(text || '')}</p>`;
    // Roles (spec 5.1): a caution is an amber panel, timing a blue line; a key's result a chip with its icon.
    const warnNote = (text) => panelHtml('is-warn validate-setup-note', 'bx-error', esc(text), { tag: 'p' });
    // Where another amber panel shares the view (Before you sign), a caution is a line, not a second panel.
    const warnLine = (text) => linePanelHtml('is-warn validate-setup-note', 'bx-error', esc(text));
    const timingLine = () => linePanelHtml('is-info', 'bx-info-circle', esc(S.timingText(w.params || {})));

    function step1() {
        return trustHtml(esc, VALIDATE_STATEMENT, '', 'validate-setup-trust')
            + '<p>You need a server that is synced, started with --validator, and reachable on port 30333.</p>'
            + '<label for="validate-setup-node" class="validate-label">Node name (the value of --name)</label>'
            + `<div class="validate-lookup-row"><input id="validate-setup-node" type="text" class="mono" data-input-kind="text" autocomplete="off" spellcheck="false" maxlength="64" aria-describedby="validate-setup-node-result" value="${esc(w.input.nodeName)}">`
            + '<button type="button" class="validate-secondary" data-setup-action="check-node">Check my node</button></div>'
            + msgP('validate-setup-node-result', w.msg.node)
            + '<p class="validate-setup-note">Optional check. The explorer cannot see your server, so it takes your word.</p>'
            + '<div class="validate-setup-actions"><button type="button" class="validate-primary" data-setup-action="next">My node is ready</button> '
            + `<a href="/validate/node" class="item-link"${NEW_TAB}>Show me how to set one up</a></div>`;
    }

    function keysTable(r) {
        const rows = r.rows.map((k, i) => `<tr><td>${i + 1}</td><th scope="row">${esc(k.name)}</th><td class="mono">${esc(k.preview)}</td>`
            + `<td>${resultWord(k.result, esc(RESULT_TEXT[k.result] || k.result))}`
            + (k.result === 'other' ? ` <span class="mono">${esc(k.owner)}</span>` : '') + '</td></tr>').join('');
        return (r.conflict ? `<div class="validate-alert" role="alert">${icon('bx-error-circle')}${esc(r.summary)}</div>` : '')
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
            return panelHtml('is-warn validate-mismatch', 'bx-error', `${esc(S.keysForSetup('', { layout: null }).message)} Key registration is switched off here; existing keys are not affected.`, { tag: 'p', attrs: ' role="status"' })
                + `<div class="validate-setup-actions">${back}</div>`;
        }
        const parsed = w.input.keysText ? S.keysForSetup(w.input.keysText, { layout: layout(), specVersion: w.limits.specVersion }) : null;
        return intro
            + `<label for="validate-setup-keys" class="validate-label">Session keys (0x, ${esc(hexLength())} characters)</label>`
            + `<textarea id="validate-setup-keys" class="validate-keys-input mono" rows="5" data-input-kind="hex" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="validate-setup-keys-msg"${parsed && !parsed.ok ? ' aria-invalid="true"' : ''}>${esc(w.input.keysText)}</textarea>`
            + msgP('validate-setup-keys-msg', w.msg.keys || (parsed && !parsed.ok ? parsed.message : ''))
            + (w.keyCheck ? keysTable(w.keyCheck) : '')
            + `<p class="validate-msg">The explorer cannot check that your node holds these keys. <a href="/validate/node" class="item-link"${NEW_TAB}>The node guide</a> shows how to check that on the server.</p>`
            + `<div class="validate-setup-actions">${back}<button type="button" class="validate-primary" data-setup-action="use-keys"${parsed && parsed.ok ? '' : ' disabled'}>Use these keys</button></div>`;
    }

    function step3() {
        const s = w.state;
        const transferable = (() => { const t = big(s.balance.free) - feeFloor({ frozen: big(s.balance.frozen), reserved: big(s.balance.reserved), ed: big(s.ed) }); return t > 0n ? t : 0n; })();
        const lowest = w.params && w.params.lowestElectedTotal;
        const limitsLine = `Minimum to validate: ${pdex(w.limits.minValidatorBond)} PDEX.` + (lowest ? ` Lowest elected backing this era: ${pdex(lowest)} PDEX.` : '');
        const notes = S.planSetup(s, { keys: null, keysHex: '' }).notes;
        // The bond message sits directly under the amount row and its limits (CEO approval 2026-11-25, Q31).
        const bondMsg = msgP('validate-setup-bond-msg', w.msg.bond);
        let amount;
        if (!s.bonded) {
            const p = w.input.payee;
            const radio = (v, label) => `<label class="validate-setup-choice"><input type="radio" name="validate-setup-payee" value="${v}"${p.kind === v ? ' checked' : ''}> ${esc(label)}</label>`;
            amount = '<label for="validate-setup-bond" class="validate-label">Amount to bond (PDEX)</label>'
                + `<div class="validate-lookup-row"><input id="validate-setup-bond" type="text" inputmode="decimal" class="mono" data-input-kind="amount" data-amount-strict autocomplete="off" aria-describedby="validate-setup-bond-msg validate-setup-bond-limits" value="${esc(w.input.bondText)}"${w.msg.bondField ? ' aria-invalid="true"' : ''}>`
                + '<button type="button" class="validate-text-btn" data-setup-action="max">Max</button></div>'
                + `<p id="validate-setup-bond-limits" class="validate-msg">${esc(limitsLine)}</p>`
                + bondMsg
                + '<fieldset class="validate-setup-payee"><legend class="validate-label">Where rewards go</legend>'
                + radio('staked', 'Add rewards to my bond') + radio('stash', 'Pay rewards to this stash, unbonded') + radio('account', 'Pay rewards to another account')
                + '<label for="validate-setup-payee-account" class="validate-label">Rewards account</label>'
                + `<input id="validate-setup-payee-account" type="text" class="mono" data-input-kind="address" autocomplete="off" spellcheck="false" value="${esc(p.account)}"${p.kind === 'account' ? '' : ' hidden'} aria-describedby="validate-setup-bond-msg">`
                + '</fieldset>';
        } else {
            amount = `<p>Bonded: ${esc(pdex(s.active))} PDEX.</p>`
                + '<label for="validate-setup-extra" class="validate-label">Add to bond (optional, PDEX)</label>'
                + `<div class="validate-lookup-row"><input id="validate-setup-extra" type="text" inputmode="decimal" class="mono" data-input-kind="amount" data-amount-strict autocomplete="off" aria-describedby="validate-setup-bond-msg validate-setup-bond-limits" value="${esc(w.input.extraText)}"${w.msg.bondField ? ' aria-invalid="true"' : ''}>`
                + '<button type="button" class="validate-text-btn" data-setup-action="max">Max</button></div>'
                + `<p id="validate-setup-bond-limits" class="validate-msg">${esc(limitsLine)}</p>`
                + bondMsg;
        }
        return `<p>Stash: <span class="mono">${esc(stash)}</span>. Transferable: ${esc(pdex(transferable))} PDEX.</p>`
            + panelHtml('is-info validate-stash-notes', 'bx-info-circle', `<p class="validate-setup-note">Use a stash whose key stays offline as much as possible: a Ledger, a multisig or an air-gapped signer. For routine changes, add a separate Staking proxy later. ${helpNewTab('validator-setup', 'Why a separate stash and proxy')}</p>`
                + '<p class="validate-setup-note">A proxy cannot set up a validator: setup needs the stash itself, or its multisig.</p>')
            + amount
            + notes.map(n => `<p class="validate-setup-note">${esc(n)}</p>`).join('')
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
            + `<input id="validate-setup-commission" type="text" inputmode="decimal" class="mono" data-input-kind="amount" data-amount-strict autocomplete="off" aria-describedby="validate-setup-commission-msg validate-setup-commission-limits" value="${esc(w.input.commissionText)}"${w.msg.commission ? ' aria-invalid="true"' : ''}>`
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
        const signedBy = ms ? `<p>Signed by the multisig ${esc(ms.name)} <span class="mono">${esc(stash)}</span>, which becomes the validator. It needs ${ms.threshold} of ${ms.signers.length} approvals from its signers, in the multisig review that opens next.</p>`
            + `<p class="validate-setup-note">${esc(MULTISIG_FEE_NOTE)}</p>${warnLine(MULTISIG_CHANGE_WARNING)}`
            : `<p>Signed by the stash <span class="mono">${esc(stash)}</span>, which becomes the validator.</p>`;
        const lock = w.signing ? ' disabled' : '';
        const started = (keysOnChain() || w.state.bonded) && r.steps.length ? `<p class="validate-setup-note">${esc(SWT.resume(r.steps.length))}</p>` : '';
        const separate = ms ? `<p class="validate-setup-note">${esc(SWT.multisig)}</p>`
            : `<div class="validate-setup-actions"><button type="button" class="validate-text-btn" data-setup-action="stepwise"${lock}>${esc(SWT.entry)}</button></div>`
            + `<p class="validate-setup-note">${esc(SWT.entryNote)}</p>`;
        const signMsg = [w.msg.sign, w.afterAttempt && !ms ? SWT.afterAttempt : ''].filter(Boolean).join(' ');
        // Finding 7 of section 9, second half: the rewards account in full, not only the short form in the list.
        const payeeStep = r.steps.find(s => s.kind === 'bond' && s.payee && s.payee.kind === 'account');
        const payeeFull = payeeStep ? `<p class="validate-stepwise-stash">Rewards go to <span class="mono">${esc(payeeStep.payee.account)}</span>.</p>` : '';
        // SW-06: a top-up Back left out because it was sent with no verdict, where its row would be.
        const topUp = w.topUpNote != null ? `<p class="validate-setup-note">${esc(SWT.topUpUnconfirmed(w.topUpNote))}</p>` : '';
        return started + signedBy
            + `<ol class="validate-review" role="list">${items}</ol>`
            + topUp
            + payeeFull
            + (r.notes || []).map(n => `<p class="validate-setup-note">${esc(n)}</p>`).join('')
            + `<p>${esc(fee + ' ' + S.atomicText(r.steps.length))}</p>`
            + timingLine()
            + `<div class="validate-warnings ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body"><p class="ui-panel-title">Before you sign</p><ul>` + S.setupWarnings({ unbond: unbondD(), validatorCount: S.offlineValidatorCount(w.params || {}) }).map(t => `<li>${esc(t)}</li>`).join('') + '</ul>'
            + `<p class="validate-ack"><input type="checkbox" id="validate-setup-ack"${w.ack ? ' checked' : ''}${lock}> <label for="validate-setup-ack">${esc(S.SLASH_ACK)}</label></p></div></div>`
            + msgP('validate-setup-sign-msg', signMsg)
            + `<div class="validate-setup-actions">${w.signing ? back.replace('>Back<', ' disabled>Back<') : back}<button type="button" class="validate-primary" data-setup-action="sign"${w.ack && !w.signing ? '' : ' disabled'}>Sign and submit</button></div>`
            + separate;
    }

    function resultHtml() {
        const a = w.after;
        if (a.approval) {
            return `<p role="status">Approval recorded. The setup needs ${ms.threshold} of ${ms.signers.length} approvals: the other signers approve it from their own wallets, and the last approval runs it.</p>`
                + warnNote(MULTISIG_CHANGE_WARNING)
                + '<a href="/validate" class="item-link" data-spa-link="true">Open validator status</a>';
        }
        if (a.applied) {
            const done = `Submitted and confirmed${w.block ? ` in block #${esc(w.block)}` : ''}.`;
            const short = a.bondShort ? ' ' + esc(S.bondShortText(a.bondShort, { validating: w.review.steps.some(s => s.kind === 'validate') })) : '';
            return panelHtml('is-ok', 'bx-check-circle', `<p role="status">${done}${short || ' You are now waiting for election.'}</p>`, { title: 'Validator set up', esc })
                + timingLine()
                + '<a href="/validate" class="validate-primary" data-spa-link="true">Open validator status</a>';
        }
        const what = { bond: 'the bond', keys: 'these keys', validate: 'the validator entry' };
        return linePanelHtml('is-warn', 'bx-time-five', `The transaction went through, but the chain does not show ${esc(a.missing.map(m => what[m] || m).join(', ') || 'every step')} for this stash yet. It can take a block.`, ' role="status"')
            + '<button type="button" class="validate-secondary" data-setup-action="recheck">Check again</button> '
            + '<a href="/validate" class="item-link" data-spa-link="true">Open validator status</a>';
    }

    function paint(moved) {
        if (!live()) return;
        const stepwise = w.mode === 'stepwise' && w.step === 5 && w.sw;
        const body = stepwise ? stepwiseBody() : [step1, step2, step3, step4, step5][w.step - 1]();
        keysKnown = keysOnChain();
        finished = !!(w.after && w.after.applied) || (stepwise && w.sw.s === 'S10');
        frame(`<p class="validate-setup-progress" id="validate-setup-progress">Step ${w.step} of ${SETUP_STEPS.length}: ${esc(SETUP_STEPS[w.step - 1])}</p>`
            + progressBar()
            + stepList()
            + `<section class="validate-setup-step" aria-labelledby="validate-step-title">${heading(stepwise ? SWT.heading : TITLES[w.step - 1])}${body}</section>`);
        if (moved) focusHeading();
    }
    // A wizard step is never the stepper (review finding 5): going anywhere leaves it.
    const go = (n) => { if (w.mode !== 'wizard') { w.mode = 'wizard'; w.sw = null; stepperOn.delete(el); } w.step = n; w.msg = {}; paint(true); };

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
            // Finding 7: the stash itself is the "this stash" choice (the manage panel refuses it too).
            if (isSame(a, stash)) return { error: 'That is this stash. Choose "Pay rewards to this stash, unbonded" instead.', payee: true };
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
        w.after = null;   // finding 1: a later review never shows an earlier result
        w.afterAttempt = false;
        if (input.extra > 0n) w.topUpNote = null;   // SW-06 is gone once a top-up is entered again
        w.review = { stash, steps: plan.steps, notes: [b.warning].concat(plan.notes).filter(Boolean), keys: input.keys, keysHex: input.keysHex,
            bond: input.bond, extra: input.extra, payee: input.payee, commission, state: w.state, limits: w.limits, fee, calls,
            revision: typeof d.revision === 'function' ? d.revision() : null };
        w.ack = false;
        go(5);
    }

    async function recheck() {
        try { w.after = await readSetupApplied(w.api, w.review, { bondedEvent: w.bondedEvent }); } catch (e) { w.after = { applied: false, missing: [] }; }
        if (live()) paint(false);
    }

    // Finding 1: the lock is set on the click and cleared on every terminal
    // outcome; while it is set, Sign, Back, the checkbox and the separate-steps
    // link are disabled in place (the tracker owns the Sign button meanwhile).
    function lockReview(on) {
        w.signing = on;
        if (!live() || w.step !== 5 || w.mode !== 'wizard' || w.after) return;
        for (const sel of ['[data-setup-action="back"]', '#validate-setup-ack', '[data-setup-action="stepwise"]']) { const c = q(sel); if (c) c.disabled = on; }
        if (!on) { const s = q('[data-setup-action="sign"]'); if (s) s.disabled = !w.ack; }
    }
    function sign(button) {
        const r = w.review;
        if (!r || !w.ack || w.signing) return;
        const attempt = {};
        w.attempt = attempt;
        lockReview(true);
        if (button) button.disabled = true;
        w.msg.sign = '';
        w.afterAttempt = false;
        w.bondedEvent = null;   // this signature's own Bonded event, set by onStage
        let sent = false;
        const mine = () => w.attempt === attempt;
        const end = () => { if (mine() && w.signing) lockReview(false); };
        const showMsg = () => { const p = q('#validate-setup-sign-msg'); if (p) p.textContent = [w.msg.sign, w.afterAttempt && !ms ? SWT.afterAttempt : ''].filter(Boolean).join(' '); };
        // Item b: the tracker fires "confirmed" or "unconfirmed" and then
        // onSuccess in the same turn (lib/tx-submit.js checkChain and onResult),
        // so those two stages release the lock one microtask later, and only
        // when onSuccess has not taken it over to paint the result.
        let succeeded = false;
        const endUnlessSuccess = () => Promise.resolve().then(() => { if (!succeeded) end(); });
        const asked = big(r.state && r.state.bonded ? r.extra : r.bond);
        const msEnd = ms ? { onMultisigEnd: (outcome) => {
            end();
            if (!live()) return;
            if (outcome === 'approved') { w.after = { approval: true }; return paint(true); }
            if (outcome === 'closed') { w.msg.sign = 'The multisig review closed without recording an approval. Sign again when you are ready.'; showMsg(); }
        } } : {};
        const opts = {
            ...msEnd,
            buildTx: (api) => buildCheckedSetupTx(api, r),
            label: 'Set up validator',
            action: { key: S.SETUP_ACTION, params: { expectEvents: S.expectedSetupEvents(r.steps), summary: S.setupSummary(r.steps), stash, ...(asked > 0n ? { bondRequested: String(asked) } : {}) } },
            button, idleText: 'Sign and submit',
            expectedWallet: stash, expectedRevision: r.revision,
            verify: (api) => verifySetup(api, r, { bondedEvent: w.bondedEvent }),
            onStage: (stage, m) => {
                const b = /#(\d+)/.exec(String((m && m.stageText) || '')); if (b) w.block = b[1];
                // The Bonded event's amount (lib/tx-status.js outcome.bonded): what was bonded, slash or not.
                if (m && m.outcome && m.outcome.bonded != null) w.bondedEvent = m.outcome.bonded;
                if (stage === 'broadcast') sent = true;
                if (SETTLED_STAGES.includes(stage)) {
                    // A silent wallet ends before broadcast: offer separate steps (SW-03).
                    if (stage === 'waiting' && !sent && mine()) { w.afterAttempt = true; showMsg(); }
                    if (stage === 'confirmed' || stage === 'unconfirmed') endUnlessSuccess();
                    else end();
                }
            },
            onError: (text, m) => {
                if (!live()) return;
                if (mine() && !sent && !(m && m.key === 'preflight')) w.afterAttempt = true;
                w.msg.sign = text; showMsg(); end();
            },
            // Finding 6: the lock holds until the result is painted.
            onSuccess: async () => { succeeded = true; await recheck(); end(); }
        };
        // Item h: a submit that throws or rejects ends the attempt. Before
        // broadcast nothing was signed (SW-07, then SW-03 for a direct signer);
        // after it, it is not confirmed, like the tracker's no-verdict stages.
        // The thrown text goes to the log, never on the page.
        const crashed = (e) => {
            console.warn('[validator-setup] submit', (e && e.message) || e);
            if (!live() || !mine() || !w.signing) return;
            if (!sent) { w.msg.sign = SWT.notStarted; w.afterAttempt = true; }
            else { w.msg.sign = SWT.sentUnconfirmed; w.afterAttempt = false; }
            showMsg();
            end();
        };
        let run;
        try { run = d.submit(opts); } catch (e) { return crashed(e); }
        if (run && typeof run.then === 'function') run.then(null, crashed);
    }

    // ── sign in separate steps (lib/validator-setup-steps.js) ──
    const swState = () => w.sw;
    function unbondD() {
        const c = (w.api && w.api.consts && w.api.consts.staking) || {};
        const n = c.bondingDuration != null ? Number(c.bondingDuration.toString()) : FALLBACK_BONDING_DURATION;
        const spe = c.sessionsPerEra != null ? Number(c.sessionsPerEra.toString()) : FALLBACK_SESSIONS_PER_ERA;
        const p = w.params || {};
        const sess = p.epochDuration > 0 && p.blockTimeMs > 0 ? (p.epochDuration * p.blockTimeMs) / 1000 : FALLBACK_SESSION_SECONDS;
        return unbondDays(n, sess * spe);
    }
    // This visit's top-up is confirmed: its Bonded event is in hand, or the gate dropped it.
    const toppedUp = (sw) => sw.plan.steps.some(x => x.kind === 'bondExtra') && (sw.ctx.bondedEvent != null || sw.extraDone);
    function stepwiseBody() {
        const sw = swState();
        const plan = sw.plan;
        let keys = '';
        if (plan.keys) {
            const r = classifyKeyOwners(plan.keys, { ...((sw.fresh && sw.fresh.owners) || {}), stash, isSame });
            r.summary = keyCheckSummary(r, plan.keys);
            keys = keysTable(r);
        }
        const fresh = sw.fresh || {};
        return stepwiseHtml({ ...sw, plan, ack: w.ack, D: unbondD(), totalFee: stepwiseTotalFee(plan), keysTable: keys, params: w.params, shortAddr: d.shortAddr,
            stop: stopLine(plan, fresh.state || w.state, sw.gate ? sw.gate.remaining : plan.steps, unbondD(), {
                confirmedAny: sw.confirmedAny || !!sw.prevK, toppedUp: toppedUp(sw),
                extraUnconfirmed: !!sw.ctx.extraSent && sw.ctx.bondedEvent == null && !sw.extraDone, extra: sw.ctx.bondedEvent != null ? sw.ctx.bondedEvent : plan.extra }) }, esc);
    }
    // After a repaint caused by an outcome: the primary when enabled, else the
    // status line. In S5, S6 and S9 the status line first, so SW-44, SW-45 and
    // SW-48 are read (the paragraph is rebuilt on every paint; review finding 10).
    function swPaint(moved) {
        paint(moved);
        if (moved) return;
        const sw = swState();
        const first = sw && ['S5', 'S6', 'S9'].includes(sw.s);
        const p = first ? null : q('[data-setup-action="step-sign"]:not([disabled])') || q('.validate-stepwise-actions .validate-primary:not([disabled])');
        const t = p || q('#validate-stepwise-status');
        if (t && typeof t.focus === 'function') t.focus();
    }
    // The gate on a fresh read; reason 'open' when the stepper opens.
    async function runGate(reason) {
        const sw = swState();
        let fresh;
        try { fresh = await readStepwiseFresh(w.api, sw.plan); } catch (e) { fresh = null; }
        if (!live() || swState() !== sw) return;
        if (!fresh) {
            Object.assign(sw, { s: 'S8', block: CHAIN_DOWN_TEXT, retry: true, repeatS7: false });
            return swPaint(reason === 'open');
        }
        const g = stepwiseGate(fresh, sw.plan, sw.ctx);
        sw.fresh = fresh;
        const was = sw.s;
        const fromS7 = sw.checkFrom === 'S7';
        sw.checkFrom = null;
        // A top-up the gate shows done stays done for this visit (finding 1).
        if (g.extraDropped) sw.extraDone = true;
        sw.gate = g;
        if (reason === 'open') sw.initial = g.remaining.length;
        // A step this visit signed is now on chain (after a clean inclusion,
        // or found by Check again after "not confirmed").
        const at = sw.attempt;
        if (at && !at.counted && !g.block && !g.unconfirmed && !g.remaining.some(x => x.kind === at.kind)) { at.counted = true; sw.prevK = at.k; }
        if (sw.ctx.justDone && !g.remaining.some(x => x.kind === sw.ctx.justDone)) sw.ctx.justDone = null;
        if (!g.block && g.remaining.length < sw.initial) sw.confirmedAny = true;
        if (was !== 'S6' && (g.next || g.done)) sw.k = g.done ? sw.plan.steps.length : g.k;
        if (reason === 'open') {
            if (g.blockId === 'SW-51') {
                // Back to Bond with the amount marked (3.3).
                leaveStepper();
                w.step = 3; w.msg = { bond: g.block, bondField: true };
                return paint(true);
            }
            sw.s = g.block ? 'S8' : 'S0';
        } else if (was === 'S6') {
            sw.s = 'S6';
        } else if (g.unconfirmed) { sw.s = 'S7'; sw.k = g.k; }
        else if (g.done) { sw.s = 'S10'; stepperOn.delete(el); }
        else if (g.block) sw.s = 'S8';
        else if (g.noticeId === 'SW-48') sw.s = 'S9';
        // Nothing confirmed this visit and step 1 is next: S0 with SW-40 and the checkbox (finding 2).
        else if (g.k === 1 && !sw.confirmedAny && !sw.prevK) sw.s = 'S0';
        else sw.s = 'S4';
        // Finding 4: Check again from S7 that finds it still not on chain says how to get out.
        sw.repeatS7 = sw.s === 'S7' && fromS7;
        // SW-46b (item g): a setKeys, bond or validate sent this visit and still
        // missing comes back signable; that paint says so instead of SW-40 or SW-42.
        const again = fromS7 && (sw.s === 'S0' || sw.s === 'S4') && !!at && !at.counted && !!g.next && g.next.kind === at.kind;
        sw.sentAgain = again && !!at.sent;
        // Final review: the link dropped before broadcast, so it was never called sent; that paint keeps "Not confirmed".
        sw.unsentAgain = again && !at.sent;
        sw.block = g.block; sw.retry = g.retry;
        if (sw.s === 'S8' && g.k) sw.k = g.k;
        swPaint(reason === 'open');
    }
    async function openStepper() {
        if (w.signing || ms || !w.review) return;
        const r = w.review;
        w.signing = true;
        lockReview(true);
        let plan;
        try { plan = await buildStepwisePlan(w.api, r, { revision: r.revision, keyNames: EXPECTED_LAYOUT.map(l => l.name) }); } catch (e) { plan = null; }
        if (!live()) return;
        if (!plan) { lockReview(false); w.msg.sign = 'The explorer could not prepare the separate steps. Try again.'; return paint(false); }
        w.mode = 'stepwise';
        w.ack = false;
        const sw = { plan, s: 'S0', k: 1, gate: null, fresh: null, ctx: { bondedEvent: null, extraSent: false, justDone: null }, confirmedAny: false, attempt: null,
            chainMoved: false, extraDone: false, repeatS7: false, checkFrom: null };
        w.sw = sw;
        stepperOn.set(el, { stash, revision: r.revision });
        // Finding 5: the lock holds until the stepper (or its block) is painted,
        // so Back, an edit and Continue cannot run under a frozen plan. Item e:
        // a throw cannot leave it on; the review comes back with the prepare text.
        try {
            await runGate('open');
        } catch (e) {
            console.warn('[validator-setup] open separate steps', (e && e.message) || e);
            if (live() && swState() === sw) {
                leaveStepper();
                w.msg.sign = 'The explorer could not prepare the separate steps. Try again.';
                paint(false);
            }
        } finally {
            if (live() && (swState() === sw || swState() === null)) w.signing = false;
        }
    }
    function leaveStepper() {
        w.mode = 'wizard'; w.sw = null; w.signing = false;
        stepperOn.delete(el);
    }
    function stepSign(button) {
        const sw = swState();
        if (!sw || w.signing || !sw.gate || !sw.gate.next) return;
        const okState = SIGNABLE_STATES.includes(sw.s) || (sw.s === 'S6' && !sw.gate.block && !sw.gate.unconfirmed);
        if (!okState || (sw.s === 'S0' && !w.ack)) return;
        w.signing = true;   // G6: set on the click
        if (button) button.disabled = true;
        const plan = sw.plan, kind = sw.gate.next.kind, k = sw.gate.k, n = plan.steps.length;
        const attempt = { kind, k, sent: false, over: false };
        sw.attempt = attempt; sw.k = k; sw.s = 'S1'; sw.reason = ''; sw.error = ''; sw.blockNo = null; sw.sentAgain = false; sw.unsentAgain = false;
        paint(false);
        const btn = q('[data-setup-action="step-sign"]');
        const mine = () => live() && swState() === sw && sw.attempt === attempt && !attempt.over;
        const finish = (s, extra = {}) => {
            if (!mine()) return;
            attempt.over = true;
            w.signing = false;
            if (s === 'S7') {
                // It may have reached a node (finding 3): Back re-reads, and a top-up is never offered again unseen.
                sw.chainMoved = true;
                if (kind === 'bondExtra') sw.ctx.extraSent = true;
            }
            Object.assign(sw, extra, { s, repeatS7: false });
            swPaint(false);
        };
        // Finding 9: a submit that throws or rejects ends the attempt.
        const crashed = (e) => finish(attempt.sent ? 'S7' : 'S5', attempt.sent ? {} : { error: String((e && e.message) || e || '') });
        let run;
        try { run = d.submit({
            buildTx: (api) => buildCheckedSetupStepTx(api, plan, kind, sw.ctx),
            label: `Validator setup, step ${k} of ${n}`,
            action: stepAction(plan, kind),
            button: btn, idleText: SWT.sign(k, n),
            expectedWallet: plan.stash, expectedRevision: plan.revision,
            verify: (api) => verifySetupStep(api, plan, kind, { bondedEvent: sw.ctx.bondedEvent }),
            onStage: (stage, m) => {
                if (!mine()) return;
                const b = /#(\d+)/.exec(String((m && m.stageText) || '')); if (b) sw.blockNo = b[1];
                if (m && m.outcome && m.outcome.bonded != null && (kind === 'bond' || kind === 'bondExtra')) sw.ctx.bondedEvent = m.outcome.bonded;
                const ev = stepOutcome('stage', { ...(m || {}), stage }, { sent: attempt.sent });
                if (ev === 'sent') {
                    attempt.sent = true;
                    sw.chainMoved = true;
                    if (kind === 'bondExtra') sw.ctx.extraSent = true;
                    sw.s = 'S2';
                    // In place: the tracker owns the button until it ends.
                    const word = q('ol.validate-stepwise > li[aria-current="step"] .validate-word');
                    if (word) setChip(word, 'is-wait', 'bx-loader-alt', 'Sent, waiting for a block');
                    const st = q('#validate-stepwise-status'); if (st) { st.textContent = `Step ${k}: Sent, waiting for a block.`; st.setAttribute('data-state', 'S2'); }
                } else if (ev === 'notSigned') finish('S5');
                else if (ev === 'noVerdict') finish('S7');
            },
            onError: (text, m) => {
                if (!mine()) return;
                const ev = stepOutcome('error', m || {}, { sent: attempt.sent });
                // Nothing was signed; Check again re-reads (SW-54: the gate then advances).
                if (ev === 'refused') return finish('S8', { block: text, retry: true });
                if (ev === 'notSigned') return finish('S5', { error: text });
                if (ev === 'failedOnChain') {
                    // Definite: nothing of this step happened, so a bondExtra may be offered again.
                    if (kind === 'bondExtra') sw.ctx.extraSent = false;
                    attempt.over = true; w.signing = false;
                    sw.s = 'S6'; sw.reason = text;
                    return runGate('failed');
                }
                finish('S7');
            },
            onSuccess: () => {
                if (!mine()) return;
                attempt.over = true; w.signing = false;
                sw.ctx.justDone = kind;
                sw.s = 'S3';
                paint(false);
                runGate('after');
            }
        }); } catch (e) { return crashed(e); }
        if (run && typeof run.then === 'function') run.then(null, crashed);
    }
    function stepCheck() {
        const sw = swState();
        if (!sw || w.signing || !['S6', 'S7', 'S8'].includes(sw.s)) return;
        sw.checkFrom = sw.s;
        sw.s = 'S3';
        paint(false);
        runGate('check');
    }
    async function stepBack() {
        const sw = swState();
        if (!sw || w.signing || !['S0', 'S4', 'S5', 'S6', 'S8', 'S9'].includes(sw.s)) return;
        // Finding 1: anything sent this visit may have changed the chain, so the
        // review is planned from a fresh read; and a top-up confirmed this visit
        // (its Bonded event, or the gate dropped it) is never planned again.
        const reread = sw.confirmedAny || sw.chainMoved || sw.extraDone;
        const hasExtra = sw.plan.steps.some(x => x.kind === 'bondExtra');
        if (hasExtra && (sw.ctx.bondedEvent != null || sw.extraDone || sw.ctx.extraSent)) w.input.extraText = '';
        // SW-06 (item a): a top-up sent with no verdict is left out, and the review says why.
        w.topUpNote = hasExtra && sw.ctx.extraSent && sw.ctx.bondedEvent == null && !sw.extraDone ? sw.plan.extra : null;
        leaveStepper();
        if (reread) {
            try {
                const [state, limits] = await Promise.all([readSetupState(w.api, stash), readSetupLimits(w.api)]);
                if (!live()) return;
                Object.assign(w, { state, limits });
                await refreshFee();
            } catch (e) { if (live()) errorView(); return; }
            if (!live()) return;
        }
        w.step = 5;
        await toReview();
    }
    async function stepAddBond() {
        const sw = swState();
        if (!sw || w.signing || !sw.gate || sw.gate.addBond == null) return;
        const diff = sw.gate.addBond;
        leaveStepper();
        await load();
        if (!live() || !w.state || !w.state.bonded) return;
        w.input.extraText = S.planckToInput(diff);
        go(3);
    }

    // ── wiring (one listener per mount, on this mount's own box) ──
    box.addEventListener('click', async (e) => {
        const t = e.target && e.target.closest ? e.target.closest('[data-setup-action]') : null;
        if (!t || !live()) return;
        const a = t.getAttribute('data-setup-action');
        if (a === 'retry') return load();
        if (a === 'back') { if (w.signing) return; let n = w.step - 1; if (n === 4 && w.state.validating) n = 3; return go(Math.max(1, n)); }
        if (a === 'keep-keys') return go(3);
        if (a === 'replace-keys') { w.input.replacing = true; return paint(false); }
        if (a === 'use-keys') return useKeys();
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
        if (a === 'stepwise') return openStepper();
        if (a === 'step-sign') return stepSign(t);
        if (a === 'step-check') return stepCheck();
        if (a === 'step-back') return stepBack();
        if (a === 'step-add-bond') return stepAddBond();
        if (w.signing) return;   // nothing else moves while a wallet request is open
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
            const f = q('#validate-setup-payee-account'); if (f) { if (t.value === 'account') f.removeAttribute('hidden'); else f.setAttribute('hidden', ''); enhanceInputActions(f); }
        } else if (t.id === 'validate-setup-ack') {
            if (w.signing) { t.checked = w.ack; return; }
            w.ack = !!t.checked;
            const s = q('[data-setup-action="sign"]'); if (s) s.disabled = !w.ack || w.signing;
            const st = q('[data-setup-action="step-sign"]'); if (st && w.sw && w.sw.s === 'S0') st.disabled = !w.ack;
        }
    });

    await load();
}
