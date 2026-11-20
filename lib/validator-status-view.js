// The /validate page (Sprint 1, read-only): the status of one validator stash
// and the session keys checker. Wallet-aware: /validate shows the connected
// account (and follows it when it changes, through script.js), /validate/<address>
// any stash, with the "viewing another account" banner from lib/wallet-aware.js.
// The model comes from GET /api/validator/:address/status, the live limits and
// key layout from GET /api/validator/params, the key check from
// GET /api/session-keys/check. Chain text goes through esc.
//
// Brand (BRAND.md): at most one primary button per view. Sprint 1 has no
// validator actions, so the only primary is Connect wallet when nothing is
// connected; Retry, lookup and Check keys are secondary. Green only on the
// Active pill and the Heartbeat word; every state is also a word.
//
// Never a seed: the keys field takes one 0x line of public keys, a secret
// phrase is refused here in the browser and never sent anywhere.
// Tested in test/validator-status.test.js and test/validate-page.test.js.

import { stakingRewardsPlan, viewingBannerHtml, notConnectedNoteHtml, restoringNoteHtml } from './wallet-aware.js';
import { parseSessionKeys, layoutMismatchText, EXPECTED_LAYOUT, layoutTotalBytes } from './session-keys.js';
import { ctaFor, aboutDuration } from './validator-status.js';
import { nodeTelemetryRow } from './node-check.js';
import { telemetryRowHtml } from './node-check-view.js';
import { enhanceInputActions } from './input-actions.js';
import { mountAlertsControl } from './validator-alerts-view.js';
import { mountValidatorManage } from './validator-manage-view.js';
import { proxiedStashesHtml } from './proxied-stashes.js';

// States with a manage panel (design 5.2); the setup states keep the setup CTA.
const MANAGE_STATES = new Set(['waiting', 'elected-next', 'active', 'active-leaving', 'disabled']);

export const VALIDATE_STATEMENT = 'The explorer cannot reach, start or check your server. It never asks for a seed, a private key or a keystore file. You run the node; you paste one line of public keys here; you sign with your own wallet.';

const RESULT_TEXT = { free: 'Not registered', own: 'This stash', other: 'Another account' };
const looksLikeAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(String(s || ''));
const toneClass = (t) => (t === 'positive' ? 'is-positive' : t === 'error' ? 'is-error' : 'is-neutral');

function countdown(m) {
    const parts = [];
    if (m.session && m.session.index != null) parts.push(`Session ${m.session.index}, next in ${aboutDuration(m.session.nextIn)}.`);
    if (m.era && m.era.active != null && m.era.endsIn != null) parts.push(`Era ${m.era.active} ends in ${aboutDuration(m.era.endsIn)}.`);
    return parts.join(' ');
}

export function renderValidatorStatus(m, { esc, shortAddr = (a) => a } = {}) {
    const pill = m.pill || { word: '', tone: 'neutral' };
    // The word is the badge; a text that opens with the same word drops it ("Heartbeat received." once, not twice).
    const rest = (r) => (r.word && String(r.text).startsWith(r.word + '.') ? String(r.text).slice(r.word.length + 1).trim() : r.text);
    const rows = (m.rows || []).map(r => `<div class="validate-row"><dt>${esc(r.label)}</dt><dd>`
        + (r.word ? `<span class="validate-word ${toneClass(r.tone)}">${esc(r.word)}</span> ` : '')
        + `<span class="validate-text">${esc(rest(r))}</span>`
        + (r.retry ? ' <button type="button" class="validate-secondary" data-validate-action="retry">Retry</button>' : '')
        + '</dd></div>').join('');
    return '<section class="validate-status" aria-labelledby="validate-headline" aria-busy="false">'
        + '<div class="validate-head">'
        + `<span class="validate-pill ${toneClass(pill.tone)}">${esc(pill.word)}</span>`
        + `<h3 class="validate-headline" id="validate-headline" tabindex="-1">${esc(m.headline)}</h3>`
        + `<p class="validate-sub"><span class="mono" title="${esc(m.address)}">${esc(shortAddr(m.address || ''))}</span> ${esc(countdown(m))}</p>`
        + '</div>'
        + (rows ? `<dl class="validate-rows">${rows}</dl>` : '')
        + '</section>';
}

function loadingHtml() {
    return '<section class="validate-status" aria-busy="true"><div class="validate-head">'
        + '<h3 class="validate-headline" id="validate-headline">Reading the chain</h3></div>'
        + '<div class="validate-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div></section>';
}

function errorHtml(err, esc) {
    const down = err && (err.status === 503 || err.code === 'RPC_NOT_READY');
    const bad = err && err.status === 400;
    const text = bad ? 'That is not a Polkadex address.'
        : down ? 'The explorer cannot reach the chain right now. Your validator is not affected.'
            : 'The explorer could not read this validator\'s status right now. Your validator is not affected.';
    return `<section class="validate-status"><div class="validate-head"><h3 class="validate-headline" id="validate-headline" tabindex="-1">${esc(text)}</h3></div>`
        + (bad ? '' : '<button type="button" class="validate-secondary" data-validate-action="retry">Retry</button>') + '</section>';
}

function keysLayout(params) {
    const l = params && params.layout;
    return l && l.ok && Array.isArray(l.layout) && l.layout.length ? l.layout : EXPECTED_LAYOUT;
}

export function renderKeysChecker({ params, esc, helpIcon = () => '' }) {
    const head = `<div class="list-header"><h2>Check session keys before you register them ${helpIcon('session-keys', 'Session keys: generate and check them')}</h2></div>`;
    const statement = `<p class="validate-statement">${esc(VALIDATE_STATEMENT)}</p>`;
    if (params && params.layout && params.layout.ok === false) {
        return `<div class="list-container glass validate-keys">${head}<div class="validate-keys-body">${statement}`
            + `<p class="validate-mismatch" role="status">${esc(layoutMismatchText(params.specVersion))}</p></div></div>`;
    }
    const hexLength = params && params.layout && params.layout.hexLength ? params.layout.hexLength : 2 + layoutTotalBytes(EXPECTED_LAYOUT) * 2;
    return `<div class="list-container glass validate-keys">${head}<div class="validate-keys-body">${statement}`
        + '<p>Session keys are generated on your own node: run <code>author_rotateKeys</code> against <code>127.0.0.1</code> on your server and paste the line it prints. Never run it through a public RPC.</p>'
        + '<form id="validate-keys-form" class="validate-keys-form" novalidate>'
        + `<label for="validate-keys-input" class="validate-label">Session keys (0x, ${esc(hexLength)} characters)</label>`
        + '<textarea id="validate-keys-input" class="validate-keys-input mono" rows="5" data-input-kind="hex" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="validate-keys-msg"></textarea>'
        + '<div class="validate-actions"><button type="submit" class="validate-secondary">Check keys</button></div>'
        + '<p id="validate-keys-msg" class="validate-msg" aria-live="polite"></p>'
        + '<div id="validate-keys-result"></div></form></div></div>';
}

function keysTableHtml(r, esc) {
    const rows = (r.rows || []).map((k, i) => `<tr><td>${i + 1}</td><th scope="row" class="validate-key-name">${esc(k.name)}</th><td class="mono">${esc(k.preview)}</td>`
        + `<td><span class="validate-word ${k.result === 'other' ? 'is-error' : 'is-neutral'}">${esc(RESULT_TEXT[k.result] || k.result)}</span>`
        + (k.owner && k.result === 'other' ? ` <span class="mono">${esc(k.owner)}</span>` : '') + '</td></tr>').join('');
    return (r.conflict ? `<div class="validate-alert" role="alert">${esc(r.summary)}</div>` : '')
        + '<div class="balance-locks-table-wrap"><table class="data-table validate-keys-table"><thead><tr><th scope="col" class="table-th">#</th><th scope="col" class="table-th">Key</th>'
        + '<th scope="col" class="table-th">First and last 8</th><th scope="col" class="table-th">Result</th></tr></thead>'
        + `<tbody>${rows}</tbody></table></div>`
        + (r.warnings && r.warnings.length ? `<p class="validate-msg">${r.warnings.map(esc).join(' ')}</p>` : '')
        + '<p class="validate-msg">The explorer cannot check that your node holds these keys. On the server, <code>author_hasSessionKeys</code> with the same line answers that.</p>';
}

// The mount in progress per element: a newer mount (a wallet switch, a lookup)
// makes the answers of an older one land nowhere.
const current = new WeakMap();

// d: { urlAddress, account (walletSession.getActiveAccount()), isSame, fetchJson,
//      helpIcon, esc, shortAddr, navigate(route), isAddress(text), nodeName,
//      manage (Sprint 4: the deps of lib/validator-manage-view.js, from script.js) }
// nodeName (from ?node=NAME, Sprint 2): adds the "Node on telemetry" row from
// GET /api/telemetry/node under the status rows.
export async function mountValidatePage(el, d) {
    if (!el) return;
    const token = {};
    current.set(el, token);
    const live = () => current.get(el) === token;
    const esc = d.esc, help = typeof d.helpIcon === 'function' ? d.helpIcon : () => '';
    const isAddress = typeof d.isAddress === 'function' ? d.isAddress : looksLikeAddress;
    const plan = stakingRewardsPlan({ urlAddress: d.urlAddress || '', account: d.account, isSame: d.isSame });
    const viewed = plan.mode === 'view' ? plan.address : '';
    const note = plan.mode === 'restoring' ? restoringNoteHtml()
        : plan.mode === 'view' ? (plan.wallet
            ? viewingBannerHtml({ viewing: viewed, wallet: plan.wallet, isSame: d.isSame, esc, shortAddr: d.shortAddr, hrefFor: () => '/validate' })
            : notConnectedNoteHtml({ viewing: viewed, wallet: '', esc, shortAddr: d.shortAddr, returnTo: '/validate/' + encodeURIComponent(viewed) }))
            : '';
    const cta = plan.mode === 'connect' ? ctaFor('none', { connected: false }) : null;
    const empty = cta ? '<div class="validate-empty"><p>Connect the wallet that holds your stash to see its validator status, or look up any stash.</p>'
        + `<a href="${esc(cta.href)}" class="validate-primary" data-spa-link="true">${esc(cta.label)}</a> `
        + `<a href="/help/validator-status" class="item-link">What the statuses mean</a> `
        + '<a href="/validate/node" class="item-link" data-spa-link="true">Read the node guide</a></div>' : '';
    el.innerHTML = '<div class="list-container glass validate-main">'
        + `<div class="list-header"><h2>Validator status ${help('validator-status', 'Validator status: what each word means')}</h2></div>`
        + `<div class="validate-body"><div class="validate-note-slot">${note}</div>`
        + '<form id="validate-lookup-form" class="validate-lookup" role="search" novalidate>'
        + '<label for="validate-lookup-input" class="validate-label">Any validator stash</label>'
        + `<div class="validate-lookup-row"><input id="validate-lookup-input" type="text" class="mono" data-input-kind="address" autocomplete="off" spellcheck="false" aria-describedby="validate-lookup-msg" value="${esc(d.urlAddress || '')}" placeholder="Polkadex address (starts with e)">`
        + '<button type="submit" class="validate-secondary">Show status</button></div>'
        + '<p id="validate-lookup-msg" class="validate-msg" aria-live="polite"></p></form>'
        + `${empty}<div id="validate-status-slot" aria-live="polite">${viewed ? loadingHtml() : ''}</div><div id="validate-proxied-slot"></div></div></div>`
        + '<div id="validate-alerts-slot"></div>'
        + `<div id="validate-keys-slot">${renderKeysChecker({ params: null, esc, helpIcon: help })}</div>`;

    let params = null;
    const q = (sel) => el.querySelector(sel);
    enhanceInputActions(q('#validate-lookup-form'));
    const lookup = q('#validate-lookup-form');
    lookup.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = String(q('#validate-lookup-input').value || '').trim();
        const msg = q('#validate-lookup-msg');
        if (!isAddress(v)) { msg.textContent = 'That is not a Polkadex address. Polkadex addresses start with e.'; return; }
        msg.textContent = '';
        if (typeof d.navigate === 'function') d.navigate('validate/' + v);
    });

    function wireKeys() {
        const form = q('#validate-keys-form');
        if (!form) return;
        const input = q('#validate-keys-input'), msg = q('#validate-keys-msg'), out = q('#validate-keys-result');
        enhanceInputActions(form);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            out.innerHTML = '';
            const parsed = parseSessionKeys(input.value, { layout: keysLayout(params), specVersion: params ? params.specVersion : null });
            if (!parsed.ok) { msg.textContent = parsed.message; input.setAttribute('aria-invalid', 'true'); return; }
            input.removeAttribute('aria-invalid');
            msg.textContent = 'Checking the chain...';
            const keys = String(input.value).trim().toLowerCase();
            try {
                const r = await d.fetchJson(`/api/session-keys/check?keys=${encodeURIComponent(keys)}${viewed ? `&for=${encodeURIComponent(viewed)}` : ''}`);
                if (!live()) return;
                msg.textContent = r.summary || '';
                out.innerHTML = keysTableHtml(r, esc);
            } catch (err) {
                if (!live()) return;
                msg.textContent = err && err.message ? err.message : 'The check could not be completed. Try again.';
            }
        });
    }
    wireKeys();

    const loadParams = d.fetchJson('/api/validator/params').then((p) => {
        if (!live()) return;
        params = p;
        const slot = q('#validate-keys-slot');
        if (slot) { slot.innerHTML = renderKeysChecker({ params, esc, helpIcon: help }); wireKeys(); }
    }, () => { /* the checker keeps the known layout; the server still checks it */ });

    // Retry buttons (the error state, or a row that could not be read) read the status again.
    function wireRetry(slot) {
        for (const btn of slot.querySelectorAll('[data-validate-action="retry"]')) btn.addEventListener('click', () => { loadStatus(); });
    }
    // The slot is a polite live region; the headline takes focus once there is something to read.
    function focusHeadline(slot) {
        const h = slot.querySelector('#validate-headline');
        if (h && typeof h.focus === 'function') h.focus();
    }
    async function addTelemetryRow(slot) {
        let t;
        try { t = await d.fetchJson('/api/telemetry/node?name=' + encodeURIComponent(d.nodeName)); } catch (e) { t = { feed: 'down', name: d.nodeName }; }
        if (!live()) return;
        const dl = slot.querySelector('.validate-rows');
        if (dl) dl.insertAdjacentHTML('beforeend', telemetryRowHtml(nodeTelemetryRow({ ...t, name: t && t.name ? t.name : d.nodeName }), esc));
    }
    async function loadStatus() {
        const slot = q('#validate-status-slot');
        if (!viewed || !slot) return;
        slot.innerHTML = loadingHtml();
        try {
            const m = await d.fetchJson(`/api/validator/${encodeURIComponent(viewed)}/status`);
            if (!live()) return;
            slot.innerHTML = renderValidatorStatus(m, { esc, shortAddr: d.shortAddr });
            // The connected wallet's own stash: the setup wizard while setup is not finished.
            const own = !!plan.wallet && (typeof d.isSame === 'function' ? d.isSame(viewed, plan.wallet) : viewed === plan.wallet);
            const next = ctaFor(m.state, { connected: true, own });
            if (next) slot.insertAdjacentHTML('beforeend', `<p class="validate-cta"><a href="${esc(next.href)}" class="validate-primary" data-spa-link="true">${esc(next.label)}</a></p>`);
            // Sprint 4: the manage panel when a wallet is connected; it renders
            // nothing unless that wallet is the stash, its controller or a proxy.
            if (d.manage && plan.wallet && MANAGE_STATES.has(m.state)) {
                slot.insertAdjacentHTML('beforeend', '<div id="validate-manage-slot"></div>');
                mountValidatorManage(slot.querySelector('#validate-manage-slot'), d.manage, { stash: viewed, model: m, refresh: () => loadStatus() });
            }
            // Sprint 6: "Get alerts for this validator"; renders nothing unless the server has alerts switched on.
            mountAlertsControl(q('#validate-alerts-slot'), { stash: viewed, esc, fetchJson: d.fetchJson, postJson: d.postJson }).catch(() => {});
            if (d.nodeName) await addTelemetryRow(slot);
        } catch (err) {
            if (!live()) return;
            slot.innerHTML = errorHtml(err, esc);
        }
        wireRetry(slot);
        focusHeadline(slot);
    }
    // Sprint 7: on the connected wallet's own view, the stashes it is a proxy for (lib/proxied-stashes.js).
    // Quiet on failure: the list is a shortcut, the status above stands without it.
    const own = !!viewed && !!plan.wallet && (typeof d.isSame === 'function' ? d.isSame(viewed, plan.wallet) : viewed === plan.wallet);
    const loadProxied = own ? Promise.resolve().then(() => d.fetchJson('/api/proxied-stashes/' + encodeURIComponent(plan.wallet))).then((r) => {
        const slot = q('#validate-proxied-slot');
        if (live() && slot) slot.innerHTML = proxiedStashesHtml(r, { esc, shortAddr: d.shortAddr });
    }, () => {}) : null;
    await Promise.all([loadParams, loadStatus(), loadProxied]);
}
