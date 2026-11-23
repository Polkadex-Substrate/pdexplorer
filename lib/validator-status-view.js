// The /validate hub and the /validate/keys tool (spec 2026-11-21-validate-redesign-and-colour-roles.md,
// sections 3 and 4). Wallet-aware: /validate shows the connected account (and follows it when it
// changes, through script.js), /validate/<address> any stash, with the "viewing another account"
// banner from lib/wallet-aware.js. The model comes from GET /api/validator/:address/status, the key
// layout from GET /api/validator/params (keys page only), the key check from GET /api/session-keys/check.
// Chain text goes through esc.
//
// The hub, top to bottom (fidelity review 2026-11-22): a header card (title, purpose, compact lookup; on
// an own stash at 640 px and below the lookup folds behind "Look up any stash"), the path strip
// (lib/validator-path.js: full in the setup states and for the visitor, one compact line otherwise; not
// on a looked-up stash), the connect bar or the dashboard, the cards (manage panel, accounts you are a
// proxy for, alerts), the tools, and last the trust row.
//
// Colour roles (spec 2.1): one primary per view (the gradient .validate-primary): Connect wallet in the
// connect bar, or the setup primary on the step 2 card, or Check keys on the keys page. Green, amber,
// blue and red are states, never actions; every chip has an icon and a word.
//
// Never a seed: the keys field takes one 0x line of public keys, a secret phrase is refused here in
// the browser and never sent anywhere. Tested in test/validator-status.test.js, test/validate-page.test.js
// and test/validate-hub.test.js.

import { stakingRewardsPlan, viewingBannerHtml, notConnectedNoteHtml, restoringNoteHtml } from './wallet-aware.js';
import { parseSessionKeys, layoutMismatchText, EXPECTED_LAYOUT, layoutTotalBytes } from './session-keys.js';
import { aboutDuration } from './validator-status.js';
import { pathState, renderPath, SETUP_STATES } from './validator-path.js';
import { icon, chipHtml, trustHtml as uiTrust } from './ui-parts.js';
import { nodeTelemetryRow } from './node-check.js';
import { telemetryRowHtml } from './node-check-view.js';
import { enhanceInputActions } from './input-actions.js';
import { mountAlertsControl } from './validator-alerts-view.js';
import { mountValidatorManage } from './validator-manage-view.js';
import { proxiedStashesHtml } from './proxied-stashes.js';
import { createRefreshIndicator } from './gov-post-action.js';
import { caughtUp } from './freshness.js';
import { nounFor } from './refresh-ui.js';

// States with a manage panel (design 5.2); the setup states keep the setup CTA.
const MANAGE_STATES = new Set(['waiting', 'elected-next', 'active', 'active-leaving', 'disabled']);

export const VALIDATE_STATEMENT = 'The explorer cannot reach, start or check your server. It never asks for a seed, a private key or a keystore file. You run the node; you paste one line of public keys here; you sign with your own wallet.';
export const TRUST_LINE = 'Never asks for a seed or private key. Cannot reach your server. You sign in your own wallet.';
export const OLD_KEYS_PARAGRAPH = 'Session keys are generated on your own node: run author_rotateKeys against 127.0.0.1 on your server and paste the line it prints. Never run it through a public RPC.';
export const KEYS_PAGE_TITLE = 'Check session keys | Polkadex Mainnet Explorer';
const KEYS_LINE = 'Paste the one line your node printed. It holds public keys only.';
const KEYS_CAUTION = 'Run author_rotateKeys only against 127.0.0.1 on your own server, never through a public RPC.';
const LIMITED_LINE = 'Some figures could not be read right now. Your validator is not affected.';

const RESULT_TEXT = { free: 'Not registered', own: 'This stash', other: 'Another account' };
const RESULT_TONE = { free: 'positive', own: 'positive', other: 'error' };
const looksLikeAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(String(s || ''));

// Tone and icon of a word (spec section 4, the tone table). id: the row id, or 'headline' for the chip.
const TONE_CLASS = { positive: 'is-positive', wait: 'is-wait', info: 'is-info', error: 'is-error' };
const WORD_ICON = {
    Active: 'bx-check-circle', Elected: 'bx-check-circle', Waiting: 'bx-time-five', Leaving: 'bx-log-out-circle',
    'Not a validator': 'bx-minus-circle', 'No keys': 'bx-minus-circle', 'Not validating': 'bx-minus-circle', Disabled: 'bx-error-circle',
    Match: 'bx-check', Pending: 'bx-time-five', Queued: 'bx-time-five', Registered: 'bx-key',
    'Heartbeat received': 'bx-pulse', Online: 'bx-pulse', 'Not seen yet': 'bx-time-five', Offline: 'bx-error-circle', Unknown: 'bx-help-circle', 'Not active': 'bx-minus-circle',
    Slashed: 'bx-shield-x', 'Reported offline': 'bx-error', 'Below minimum': 'bx-error', 'Legacy controller': 'bx-error', Blocked: 'bx-info-circle'
};
export function chipFor(id, word, tone) {
    const cls = TONE_CLASS[tone] || 'is-neutral';
    let i = WORD_ICON[word];
    if (word === 'None') i = id === 'keys' ? 'bx-error' : id === 'offences' ? 'bx-check' : 'bx-minus-circle';
    if (!i) i = { positive: 'bx-check', wait: 'bx-time-five', info: 'bx-info-circle', error: 'bx-error-circle' }[tone] || 'bx-minus-circle';
    return { cls, icon: i };
}
const wordHtml = (cls, id, word, tone, esc) => { const c = chipFor(id, word, tone); return `<span class="${cls} ${c.cls}">${icon(c.icon)}${esc(word)}</span>`; };

function countdown(m) {
    const parts = [];
    if (m.session && m.session.index != null) parts.push(`Session ${m.session.index}, next in ${aboutDuration(m.session.nextIn)}.`);
    if (m.era && m.era.active != null && m.era.endsIn != null) parts.push(`Era ${m.era.active} ends in ${aboutDuration(m.era.endsIn)}.`);
    return parts.join(' ');
}

const HEALTH_IDS = ['keys', 'online', 'offences'];
// The word is the badge; a text that opens with the same word drops it ("Heartbeat received." once, not twice).
const rest = (r) => (r.word && String(r.text).startsWith(r.word + '.') ? String(r.text).slice(r.word.length + 1).trim() : r.text);
const retryBtn = '<button type="button" class="validate-secondary" data-validate-action="retry">Retry</button>';

export function renderValidatorStatus(m, { esc, shortAddr = (a) => a, helpIcon = () => '' } = {}) {
    const pill = m.pill || { word: '', tone: 'neutral' };
    const rowsList = m.rows || [];
    const rows = rowsList.map(r => `<div class="validate-row"><dt>${esc(r.label)}</dt><dd>`
        + (r.word ? wordHtml('validate-word', r.id, r.word, r.tone, esc) + ' ' : '')
        + `<span class="validate-text">${esc(rest(r))}</span>`
        + '</dd></div>').join('');   // a Retry sits on its tile only (fidelity review 14)
    const bonded = m.state !== 'not-bonded';
    // not-bonded: the chip and the headline only (fidelity review 10), no session line, no progress block.
    const progress = bonded && m.session && m.session.index != null ? Math.max(0, Math.min(100, Math.round(Number(m.session.progress || 0) * 100))) : null;
    const head = '<div class="validate-head"><div class="validate-head-main">'
        + '<div class="validate-head-line">' + wordHtml('validate-pill', 'headline', pill.word, pill.tone, esc)
        + `<h3 class="validate-headline" id="validate-headline" tabindex="-1">${esc(m.headline)}</h3>${helpIcon('validator-status', 'Validator status: what each word means')}</div>`
        + (bonded ? `<p class="validate-sub"><span class="mono" title="${esc(m.address)}">${esc(shortAddr(m.address || ''))}</span> ${esc(countdown(m))}</p>` : '') + '</div>'
        + (progress == null ? '' : `<div class="validate-progress"><span class="validate-progress-label">Session progress <strong>${progress}%</strong></span>`
            + `<div class="validate-progress-bar" role="progressbar" aria-label="Session progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></div>`)
        + '</div>';
    const health = bonded ? rowsList.filter(r => HEALTH_IDS.includes(r.id) || (r.word && (r.tone === 'wait' || r.tone === 'error'))) : [];
    const healthHtml = health.length ? '<div class="validate-health">' + health.map(r => '<div class="validate-health-item">'
        + `<p class="validate-health-label">${esc(r.label)}</p>${r.word ? wordHtml('validate-word', r.id, r.word, r.tone, esc) : ''}`
        + (String(rest(r) || '').trim() ? `<p class="validate-health-text">${esc(rest(r))}</p>` : '') + '</div>').join('') + '</div>' : '';
    const limited = bonded && (rowsList.some(r => r.word === 'Unknown') || (m.tiles || []).some(t => t.chip && t.chip.word === 'Unknown'));
    const tiles = (m.tiles || []).length ? '<div class="validate-tiles">' + m.tiles.map(t => '<div class="validate-tile">'
        + `<div class="validate-tile-head"><span class="ui-tile is-violet is-sm" aria-hidden="true">${icon(t.icon)}</span><span class="validate-tile-label">${esc(t.label)}</span></div>`
        + (t.value ? `<p class="validate-tile-value">${esc(t.value)}</p>` : '')
        + (t.note ? `<p class="validate-tile-note">${esc(t.note)}</p>` : '')
        + (t.chip || t.retry ? `<div class="validate-tile-foot">${t.chip ? wordHtml('ui-chip', t.id, t.chip.word, t.chip.tone, esc) : ''}${t.retry ? retryBtn : ''}</div>` : '')
        + '</div>').join('') + '</div>' : '';
    return '<section class="validate-status" aria-labelledby="validate-headline" aria-busy="false">'
        + head
        + (limited ? `<p class="ui-panel is-info is-line">${icon('bx-info-circle')}<span class="ui-panel-body">${esc(LIMITED_LINE)}</span></p>` : '')
        + healthHtml + tiles
        + (rows ? `<details class="validate-details"><summary>All details</summary><dl class="validate-rows">${rows}</dl></details>` : '')
        + '</section>';
}

function loadingHtml() {
    return '<section class="validate-status" aria-busy="true"><div class="validate-head"><div class="validate-head-main"><div class="validate-head-line">'
        + '<span class="validate-skel-chip" aria-hidden="true"></span><h3 class="validate-headline" id="validate-headline">Reading the chain</h3></div></div></div>'
        + '<div class="validate-skeleton" aria-hidden="true"><div class="validate-health"><span class="validate-skel-health"></span><span class="validate-skel-health"></span><span class="validate-skel-health"></span></div>'
        + '<div class="validate-tiles"><span class="validate-skel-tile"></span><span class="validate-skel-tile"></span><span class="validate-skel-tile"></span><span class="validate-skel-tile"></span></div></div></section>';
}

// 503 or a failed read: amber, not red (the validator is fine, the explorer is not). A 400 is said under the lookup field.
function errorHtml(err, esc) {
    const down = err && (err.status === 503 || err.code === 'RPC_NOT_READY');
    const text = down ? 'The explorer cannot reach the chain right now. Your validator is not affected.'
        : 'The explorer could not read this validator\'s status right now. Your validator is not affected.';
    return `<section class="validate-status"><div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">`
        + `<h3 class="validate-headline ui-panel-title" id="validate-headline" tabindex="-1">${esc(text)}</h3>${retryBtn}</div></div></section>`;
}

function keysLayout(params) {
    const l = params && params.layout;
    return l && l.ok && Array.isArray(l.layout) && l.layout.length ? l.layout : EXPECTED_LAYOUT;
}

// The trust row (spec 2.4, lib/ui-parts.js): the short line, and the full statement verbatim behind "Details".
const trust = (esc) => uiTrust(esc, TRUST_LINE, VALIDATE_STATEMENT);
// The keys the line holds (fidelity review 21): one neutral chip per key name, in the layout's order.
const keysNamesHtml = (layout, esc) => `<p class="validate-keys-holds">The line holds ${esc(layout.length)} public keys</p>`
    + `<div class="validate-keys-names">${layout.map(l => chipHtml('is-neutral', 'bx-key', l.name, esc)).join('')}</div>`;

// ── /validate/keys ──
export function renderKeysPage({ params, esc, helpIcon = () => '' }) {
    const top = `<a href="/validate" class="validate-back" data-spa-link="true">${icon('bx-chevron-left')}Validate</a>`;
    const head = `<div class="list-header validate-card-head"><span class="ui-tile is-violet" aria-hidden="true">${icon('bx-key')}</span><h2>Check session keys ${helpIcon('session-keys', 'Session keys: generate and check them')}</h2></div>`;
    const open = `${top}<div class="list-container glass ui-hairline validate-keys">${head}<div class="validate-keys-body">`;
    if (params && params.layout && params.layout.ok === false) {
        return open + `<div class="ui-panel is-warn validate-mismatch" role="status">${icon('bx-error')}<div class="ui-panel-body">${esc(layoutMismatchText(params.specVersion))}</div></div>`
            + trust(esc) + '</div></div>';
    }
    const hexLength = params && params.layout && params.layout.hexLength ? params.layout.hexLength : 2 + layoutTotalBytes(EXPECTED_LAYOUT) * 2;
    return open
        + `<p>${esc(KEYS_LINE)}</p>`
        + '<form id="validate-keys-form" class="validate-keys-form" novalidate>'
        + `<label for="validate-keys-input" class="validate-label">Session keys (0x, ${esc(hexLength)} characters)</label>`
        + '<textarea id="validate-keys-input" class="validate-keys-input mono" rows="5" data-input-kind="hex" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="validate-keys-msg"></textarea>'
        + keysNamesHtml(keysLayout(params), esc)
        + `<p class="ui-panel is-warn is-line validate-caution">${icon('bx-error')}<span class="ui-panel-body">${esc(KEYS_CAUTION)}</span></p>`
        + '<div class="validate-actions"><button type="submit" class="validate-primary">Check keys</button></div>'
        + '<p id="validate-keys-msg" class="validate-msg" aria-live="polite"></p>'
        + '<div id="validate-keys-result"></div></form>'
        + '<details class="validate-disclosure"><summary>Where does this line come from?</summary>'
        + '<p>Session keys are generated on your own node: run <code>author_rotateKeys</code> against <code>127.0.0.1</code> on your server and paste the line it prints. Never run it through a public RPC.</p>'
        + '<p><a href="/validate/node#node-step-keys" class="item-link" data-spa-link="true">Session keys in the node guide</a></p></details>'
        + trust(esc)
        + '</div></div>';
}

function keysTableHtml(r, esc) {
    const rows = (r.rows || []).map((k, i) => `<tr><td>${i + 1}</td><th scope="row" class="validate-key-name">${esc(k.name)}</th><td class="mono">${esc(k.preview)}</td>`
        + `<td>${wordHtml('validate-word', 'keys-result', RESULT_TEXT[k.result] || k.result, RESULT_TONE[k.result] || 'neutral', esc)}`
        + (k.owner && k.result === 'other' ? ` <span class="mono">${esc(k.owner)}</span>` : '') + '</td></tr>').join('');
    return (r.conflict ? `<div class="validate-alert" role="alert">${icon('bx-error-circle')} ${esc(r.summary)}</div>` : '')
        + '<div class="balance-locks-table-wrap"><table class="data-table validate-keys-table"><thead><tr><th scope="col" class="table-th">#</th><th scope="col" class="table-th">Key</th>'
        + '<th scope="col" class="table-th">First and last 8</th><th scope="col" class="table-th">Result</th></tr></thead>'
        + `<tbody>${rows}</tbody></table></div>`
        + (r.warnings && r.warnings.length ? `<div class="ui-panel is-warn">${icon('bx-error')}<div class="ui-panel-body">${r.warnings.map(esc).join(' ')}</div></div>` : '')
        + `<div class="ui-panel is-info">${icon('bx-info-circle')}<div class="ui-panel-body">The explorer cannot check that your node holds these keys. On the server, <code>author_hasSessionKeys</code> with the same line answers that.</div></div>`;
}

// The mount in progress per element: a newer mount (a wallet switch, a lookup)
// makes the answers of an older one land nowhere.
const current = new WeakMap();

// d: { fetchJson, helpIcon, esc, getAccount() (the connected wallet, read at check time; else d.account) }.
// The check names the connected wallet as the stash (for=), so its own keys read "This stash".
export async function mountKeysPage(el, d) {
    if (!el) return;
    const token = {};
    current.set(el, token);
    const live = () => current.get(el) === token;
    const esc = d.esc, help = typeof d.helpIcon === 'function' ? d.helpIcon : () => '';
    const stashFor = () => { const a = typeof d.getAccount === 'function' ? d.getAccount() : d.account; return a && a.status === 'connected' && a.address ? a.address : ''; };
    let params = null;
    const q = (sel) => el.querySelector(sel);
    const render = () => { el.innerHTML = `<div class="validate-hub">${renderKeysPage({ params, esc, helpIcon: help })}</div>`; wire(); };
    function wire() {
        const form = q('#validate-keys-form');
        if (!form) return;
        const input = q('#validate-keys-input'), msg = q('#validate-keys-msg'), out = q('#validate-keys-result');
        enhanceInputActions(form);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            out.innerHTML = '';
            msg.className = 'validate-msg';
            const parsed = parseSessionKeys(input.value, { layout: keysLayout(params), specVersion: params ? params.specVersion : null });
            if (!parsed.ok) { msg.className = 'validate-msg is-error'; msg.innerHTML = `${icon('bx-error-circle')} ${esc(parsed.message)}`; input.setAttribute('aria-invalid', 'true'); return; }
            input.removeAttribute('aria-invalid');
            msg.textContent = 'Checking the chain...';
            const keys = String(input.value).trim().toLowerCase();
            const stash = stashFor();
            try {
                const r = await d.fetchJson(`/api/session-keys/check?keys=${encodeURIComponent(keys)}${stash ? `&for=${encodeURIComponent(stash)}` : ''}`);
                if (!live()) return;
                // A conflict: the alert under the field carries the sentence, the message stays empty (fidelity review 14).
                if (r.summary && !r.conflict) { msg.className = 'validate-msg is-ok'; msg.innerHTML = `${icon('bx-check-circle')} ${esc(r.summary)}`; }
                else msg.textContent = r.conflict ? '' : (r.summary || '');
                out.innerHTML = keysTableHtml(r, esc);
            } catch (err) {
                if (!live()) return;
                msg.textContent = err && err.message ? err.message : 'The check could not be completed. Try again.';
            }
        });
    }
    render();
    try {
        const p = await d.fetchJson('/api/validator/params');
        if (!live()) return;
        params = p;
        render();
    } catch (e) { /* the checker keeps the known layout; the server still checks it */ }
}

// ── /validate and /validate/<address> ──
// d: { urlAddress, account (walletSession.getActiveAccount()), isSame, fetchJson,
//      helpIcon, esc, shortAddr, navigate(route), isAddress(text), nodeName,
//      manage (Sprint 4: the deps of lib/validator-manage-view.js, from script.js) }
// nodeName (from ?node=NAME, Sprint 2): adds the "Node on telemetry" row from
// GET /api/telemetry/node under the status rows.
// R5 (post-action refresh, design rows 27 to 29 and section 5): a stash a recent action changed. Its status is
// read with ?fresh=1 (past the server's 30 s memo, which another worker may still hold) for OWED_MS after the
// inclusion, and drawn only from a read whose head reached that block (freshness.chainHead, caughtUp). Nothing
// is drawn from the action itself: the manage and setup panels' rechecks stay their own evidence.
// Kept per core (one per page load), so two cores never share what they saw.
const OWED_MS = 180_000;
const owedBy = new WeakMap();   // core -> [{ stash, block, at }], newest last, bounded
const eqAddr = (a, b) => a === b;
export function noteStatusBlock(post, stash, block, at = Date.now()) {
    const b = Number(block);
    if (!post || typeof post !== 'object' || !stash || block == null || !Number.isFinite(b)) return;
    const owed = owedBy.get(post) || [];
    owed.push({ stash: String(stash), block: b, at });
    while (owed.length > 50) owed.shift();
    owedBy.set(post, owed);
}
export function owedStatusBlock(post, stash, at = Date.now(), same = eqAddr) {
    let best = null;
    for (const o of (post && owedBy.get(post)) || []) {
        if (at - o.at >= OWED_MS) continue;   // a clock that went back keeps it: one more fresh read, never a stale one
        let hit = false;
        try { hit = o.stash === String(stash) || !!same(o.stash, String(stash)); } catch (e) { hit = false; }
        if (hit && (best === null || o.block > best)) best = o.block;
    }
    return best;
}
const statusPath = (stash, fresh) => `/api/validator/${encodeURIComponent(stash)}/status${fresh ? '?fresh=1' : ''}`;
// The setup page (lib/validator-setup-view.js) draws no status card: it notes the block and reads the stash's
// status past the memo until the server has it, so the status page opened next is current. Ends with the page.
export function followStatusBlocks({ post, stash, live, fetchJson, same = eqAddr, now = Date.now }) {
    if (!post || typeof post.subscribe !== 'function' || !stash || typeof fetchJson !== 'function') return null;
    let unsub = null;
    unsub = post.subscribe(['validator.status'], {
        account: () => { if (live()) return stash; if (unsub) { const u = unsub; unsub = null; u(); } return null; },
        reload: (i) => {
            if (!live() || !i) return null;
            if (i.block != null) noteStatusBlock(post, stash, i.block, now());
            if (!i.poll) return null;
            return Promise.resolve().then(() => fetchJson(statusPath(stash, true))).then((m) => (m && m.freshness) || null, () => null);
        }
    });
    return unsub;
}
const STATUS_HOSTS = Object.freeze({ header: '#validate-status-slot .validate-head-line', card: '.validate-dash' });

export async function mountValidatePage(el, d) {
    if (!el) return;
    const token = {};
    current.set(el, token);
    const live = () => current.get(el) === token;
    const esc = d.esc, help = typeof d.helpIcon === 'function' ? d.helpIcon : () => '';
    const isAddress = typeof d.isAddress === 'function' ? d.isAddress : looksLikeAddress;
    const plan = stakingRewardsPlan({ urlAddress: d.urlAddress || '', account: d.account, isSame: d.isSame });
    const viewed = plan.mode === 'view' ? plan.address : '';
    const own = !!viewed && !!plan.wallet && (typeof d.isSame === 'function' ? d.isSame(viewed, plan.wallet) : viewed === plan.wallet);
    const note = plan.mode === 'restoring' ? restoringNoteHtml()
        : plan.mode === 'view' && !own ? (plan.wallet
            ? viewingBannerHtml({ viewing: viewed, wallet: plan.wallet, isSame: d.isSame, esc, shortAddr: d.shortAddr, hrefFor: () => '/validate' })
            : notConnectedNoteHtml({ viewing: viewed, wallet: '', esc, shortAddr: d.shortAddr, returnTo: '/validate/' + encodeURIComponent(viewed) }))
            : '';
    // The path strip: the visitor, a restoring wallet and the own stash; never a looked-up account.
    const showPath = plan.mode === 'connect' || plan.mode === 'restoring' || own;
    const pathFor = (state) => pathState(state, { connected: !!plan.wallet, own: true, restoring: plan.mode === 'restoring' });
    // The full strip holds a primary (the visitor, the setup states); otherwise one compact line (fidelity review 1).
    const pathHtml = (state) => renderPath(pathFor(state), { esc, compact: !(plan.mode === 'connect' || (own && SETUP_STATES.has(state))) });
    const first = showPath ? pathFor(null) : null;
    const connect = plan.mode === 'connect' && first && first.primary
        ? `<div class="validate-connect"><span class="ui-tile is-violet" aria-hidden="true">${icon('bx-user-check')}</span>`
            + '<p>Already validating? Connect the stash wallet to see its status and manage it.</p>'
            + `<a href="${esc(first.primary.href)}" class="validate-primary" data-spa-link="true">${esc(first.primary.label)}</a></div>` : '';
    const helper = own ? '<p class="validate-helper">A proxy for another stash? Look it up here if it is not listed below.</p>' : '';
    // An own stash on a phone: the lookup folds away so the dashboard comes first (fidelity review 2).
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    const fold = own && !!(view && typeof view.matchMedia === 'function' && view.matchMedia('(max-width: 640px)').matches);
    const lookupForm = '<form id="validate-lookup-form" class="validate-lookup" role="search" novalidate>'
        + `<label for="validate-lookup-input" class="validate-label${fold ? ' sr-only' : ''}">Look up any stash</label>`
        + `<div class="validate-lookup-row"><input id="validate-lookup-input" type="text" class="mono" data-input-kind="address" autocomplete="off" spellcheck="false" aria-describedby="validate-lookup-msg" value="${esc(d.urlAddress || '')}" placeholder="Polkadex address (starts with e)">`
        + '<button type="submit" class="validate-secondary">Show status</button></div>'
        + helper
        + '<p id="validate-lookup-msg" class="validate-msg" aria-live="polite"></p></form>';
    const lookup = fold ? `<details class="validate-disclosure validate-lookup-fold"><summary>Look up any stash</summary>${lookupForm}</details>` : lookupForm;
    const keysTool = showPath ? `<a href="/validate/keys" class="validate-tool" data-spa-link="true"><span class="ui-tile is-violet" aria-hidden="true">${icon('bx-key')}</span>`
        + '<span class="validate-tool-main"><span class="validate-tool-name">Check session keys</span><span class="validate-tool-sub">Paste the line your node printed. No wallet needed.</span></span>'
        + `${icon('bx-chevron-right')}</a>` : '';
    el.innerHTML = '<div class="validate-hub">'
        + '<section class="list-container glass ui-hairline validate-header">'
        + '<div class="validate-header-top"><div class="validate-header-text">'
        + `<span class="ui-tile is-brand" aria-hidden="true">${icon('bx-server')}</span>`
        + '<div><h2>Validate</h2><p class="validate-purpose">Set up a Polkadex validator and keep it healthy.</p></div></div>'
        + lookup + '</div>'
        + '</section>'
        + (note ? `<div class="validate-note-slot">${note}</div>` : '')
        + `<div id="validate-path-slot">${showPath ? pathHtml(null) : ''}</div>`
        + connect
        + `<section class="list-container glass validate-dash"${viewed ? '' : ' hidden'}><div id="validate-status-slot" aria-live="polite">${viewed ? loadingHtml() : ''}</div></section>`
        + '<div class="validate-cards"><div id="validate-manage-slot" class="list-container glass validate-manage-card"></div><div id="validate-proxied-slot"></div><div id="validate-alerts-slot"></div></div>'
        + (keysTool ? `<section class="validate-tools" aria-labelledby="validate-tools-title"><h2 class="validate-tools-title" id="validate-tools-title">Tools</h2><div class="validate-tools-grid">${keysTool}</div></section>` : '')
        + trust(esc)
        + '</div>';

    const q = (sel) => el.querySelector(sel);
    enhanceInputActions(q('#validate-lookup-form'));

    // R5: the card follows an action on the viewed stash (see followStatusBlocks above); d.post is the core.
    const post = d.post && typeof d.post.subscribe === 'function' ? d.post : null;
    const sameAddr = typeof d.isSame === 'function' ? d.isSame : eqAddr;
    const nowMs = typeof d.now === 'function' ? d.now : Date.now;
    const doc = el.ownerDocument;
    let lastHtml = null, telemetryHtml = '', drawnHead = null, pendingApply = null, unsub = null;
    const ind = post && viewed ? createRefreshIndicator({ doc, page: 'validator', name: 'Validator status', hosts: STATUS_HOSTS, account: () => (live() ? viewed : null), same: sameAddr,
        reload: () => refreshCard(null), now: nowMs, ...(typeof d.setTimer === 'function' ? { setTimer: d.setTimer } : {}), ...(typeof d.clearTimer === 'function' ? { clearTimer: d.clearTimer } : {}) }) : null;
    const headOf = (m) => { const h = m && m.freshness ? Number(m.freshness.chainHead) : NaN; return Number.isFinite(h) && h > 0 ? h : null; };
    // A newer read never gives way to an older one; a read below the action's block is not drawn as its result.
    function patchCard(slot, m) {
        const html = renderValidatorStatus(m, { esc, shortAddr: d.shortAddr, helpIcon: help });
        const apply = () => {
            if (!live() || !slot.isConnected) return;
            if (html !== lastHtml) {
                const det = slot.querySelector('.validate-details');
                const open = !!(det && det.open);
                slot.innerHTML = html;
                lastHtml = html;
                const again = open && slot.querySelector('.validate-details');
                if (again) again.open = true;
                const dl = telemetryHtml && slot.querySelector('.validate-rows');
                if (dl) dl.insertAdjacentHTML('beforeend', telemetryHtml);
                wireRetry(slot);
                if (own) setPath(m.state);
            }
            const h = headOf(m);
            if (h !== null && (drawnHead === null || h > drawnHead)) drawnHead = h;
            if (ind) ind.paint();
        };
        // U4: a focused node is never replaced; the patch waits until focus leaves the card.
        const a = doc && doc.activeElement;
        if (a && a !== doc.body && slot.contains(a)) {
            pendingApply = apply;
            slot.addEventListener('focusout', () => { const f = pendingApply; pendingApply = null; if (f) f(); }, { once: true });
            return;
        }
        apply();
    }
    async function refreshCard(block) {
        const slot = q('#validate-status-slot');
        if (!live() || !slot || !viewed) return null;
        let m;
        try { m = await d.fetchJson(statusPath(viewed, true)); } catch (e) { return null; }
        if (!live() || !m || typeof m !== 'object' || m.error) return null;
        const f = m.freshness && typeof m.freshness === 'object' ? m.freshness : null;
        if (block != null && !caughtUp('validator.status', f, block)) return f;
        const h = headOf(m);
        if (h !== null && drawnHead !== null && h < drawnHead) return f;
        patchCard(slot, m);
        return f;
    }
    function onCoreReload(i) {
        if (!live() || !i) return null;
        const r = i.reason || '';
        if (i.block != null) noteStatusBlock(post, viewed, i.block, nowMs());
        if (r === 'reorg') { if (ind) ind.reorg(nounFor(i.info && i.info.key)); return refreshCard(null); }
        if (r === 'failed') { if (ind) ind.reorg(null); return refreshCard(null); }
        if (r === 'inBlock' && ind) ind.reorg(null);
        if (i.poll) return refreshCard(i.block);
        return null;
    }
    if (post && viewed) {
        unsub = post.subscribe(['validator.status', 'staking.ledger'], {
            account: () => { if (live()) return viewed; if (unsub) { const u = unsub; unsub = null; u(); } return null; },
            reload: onCoreReload,
            state: (st, info) => { if (live() && ind) ind.set(st, info); }
        });
    }
    const lookupMsg = (text) => {
        const msg = q('#validate-lookup-msg'), input = q('#validate-lookup-input');
        if (!text) { msg.className = 'validate-msg'; msg.textContent = ''; input.removeAttribute('aria-invalid'); return; }
        msg.className = 'validate-msg is-error';
        msg.innerHTML = `${icon('bx-error-circle')} ${esc(text)}`;
        input.setAttribute('aria-invalid', 'true');
    };
    q('#validate-lookup-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = String(q('#validate-lookup-input').value || '').trim();
        if (!isAddress(v)) { lookupMsg('That is not a Polkadex address. Polkadex addresses start with e.'); return; }
        lookupMsg('');
        if (typeof d.navigate === 'function') d.navigate('validate/' + v);
    });

    const setPath = (state) => {
        const slot = q('#validate-path-slot');
        if (!slot || !showPath) return;
        slot.innerHTML = pathHtml(state);
    };

    // Retry buttons (the error state, or an item that could not be read) read the status again.
    function wireRetry(slot) {
        for (const btn of slot.querySelectorAll('[data-validate-action="retry"]')) btn.addEventListener('click', () => { loadStatus({ scroll: true }); });
    }
    // The slot is a polite live region; the headline takes focus once there is something to read. After
    // the first read it does not scroll (a phone keeps the step 2 primary in view, fidelity review 3);
    // after a Retry it does, the reader asked for that answer.
    function focusHeadline(slot, scroll) {
        const h = slot.querySelector('#validate-headline');
        if (h && typeof h.focus === 'function') { if (scroll) h.focus(); else h.focus({ preventScroll: true }); }
    }
    async function addTelemetryRow(slot) {
        let t;
        try { t = await d.fetchJson('/api/telemetry/node?name=' + encodeURIComponent(d.nodeName)); } catch (e) { t = { feed: 'down', name: d.nodeName }; }
        if (!live()) return;
        const dl = slot.querySelector('.validate-rows');
        telemetryHtml = telemetryRowHtml(nodeTelemetryRow({ ...t, name: t && t.name ? t.name : d.nodeName }), esc);
        if (dl) dl.insertAdjacentHTML('beforeend', telemetryHtml);
    }
    let scrolledToManage = false;
    async function loadStatus({ scroll = false } = {}) {
        const slot = q('#validate-status-slot');
        if (!viewed || !slot) return;
        slot.innerHTML = loadingHtml();
        lastHtml = null;
        try {
            const owe = post ? owedStatusBlock(post, viewed, nowMs(), sameAddr) : null;
            const m = await d.fetchJson(statusPath(viewed, owe !== null));
            if (!live()) return;
            lastHtml = renderValidatorStatus(m, { esc, shortAddr: d.shortAddr, helpIcon: help });
            slot.innerHTML = lastHtml;
            drawnHead = headOf(m);
            if (ind) ind.paint();
            // Behind a recent action's block: this page polls for it (the core's backoff and deadline).
            if (owe !== null && !caughtUp('validator.status', m && m.freshness, owe)) post.notify({ account: viewed, domains: ['validator.status'], block: owe, reason: 'mount' });
            // The own stash: the path strip shows its state, and the setup primary sits on the step 2 card.
            if (own) setPath(m.state);
            // Sprint 4: the manage panel when a wallet is connected, in its own card (fidelity review 22); it
            // renders nothing unless that wallet is the stash, its controller or a proxy.
            const manageSlot = q('#validate-manage-slot');
            if (d.manage && plan.wallet && MANAGE_STATES.has(m.state)) {
                // The link "Manage this validator" ends in #validate-manage-title, which stops the scroll reset, and the
                // panel mounts after the chain read: scroll to it once it is there (once per page, not on every refresh).
                Promise.resolve(mountValidatorManage(manageSlot, d.manage, { stash: viewed, model: m, refresh: () => loadStatus() })).then(() => {
                    if (!live() || scrolledToManage || !view || !view.location || view.location.hash !== '#validate-manage-title') return;
                    const title = manageSlot && manageSlot.querySelector('#validate-manage-title');
                    if (!title || typeof title.scrollIntoView !== 'function') return;
                    scrolledToManage = true;
                    // No behavior: the browser's default is instant, so reduced motion is respected too.
                    title.scrollIntoView({ block: 'start' });
                });
            }
            else if (manageSlot) manageSlot.innerHTML = '';
            // Sprint 6: "Get alerts for this validator"; renders nothing unless the server has alerts switched
            // on. Not for a stash that is not bonded: there is nothing to watch yet (fidelity review 10).
            if (m.state !== 'not-bonded') mountAlertsControl(q('#validate-alerts-slot'), { stash: viewed, esc, fetchJson: d.fetchJson, postJson: d.postJson }).catch(() => {});
            if (d.nodeName) await addTelemetryRow(slot);
        } catch (err) {
            if (!live()) return;
            if (err && err.status === 400) {
                // Not a Polkadex address: said under the lookup field; no dashboard, and no "Viewing ..., read
                // only" banner above the red line (fidelity review 11).
                slot.innerHTML = '';
                q('.validate-dash').hidden = true;
                const noteSlot = q('.validate-note-slot');
                if (noteSlot) noteSlot.innerHTML = '';
                lookupMsg('That is not a Polkadex address.');
                const input = q('#validate-lookup-input');
                if (input && typeof input.focus === 'function') input.focus();
                return;
            }
            slot.innerHTML = errorHtml(err, esc);
        }
        wireRetry(slot);
        focusHeadline(slot, scroll);
    }
    // Sprint 7: on the connected wallet's own view, the stashes it is a proxy for (lib/proxied-stashes.js).
    // Quiet on failure: the list is a shortcut, the status above stands without it.
    const loadProxied = own ? (async function load() {
        let r;
        try { r = await d.fetchJson('/api/proxied-stashes/' + encodeURIComponent(plan.wallet)); } catch (e) { return; }
        const slot = q('#validate-proxied-slot');
        if (!live() || !slot) return;
        slot.innerHTML = proxiedStashesHtml(r, { esc, shortAddr: d.shortAddr });
        const retry = slot.querySelector('[data-proxied-retry]');
        if (retry) retry.addEventListener('click', () => { retry.disabled = true; load(); });
    })() : null;
    await Promise.all([loadStatus(), loadProxied]);
}
