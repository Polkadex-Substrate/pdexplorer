// "Get alerts for this validator" (Sprint 6): the control under the status of one
// validator stash. Mounted by lib/validator-status-view.js when a stash is shown,
// so it lives behind FEATURE_FLAGS.validate with the page itself. It also needs the
// server switch: GET /api/validator-alerts/status says whether alerts are on, and
// when they are not (the default) nothing is rendered.
//
// The copy says what is sent, to whom and how to stop, in the voice of the rest of
// the page: plain words, no promise the code does not keep. Brand tokens only (the
// .validate-* classes in styles.css); the email field declares its paste kind.
//
// d: { stash, esc, fetchJson(url), postJson(url, body) (optional; defaults to fetch) }

import { enhanceInputActions } from './input-actions.js';

export const ALERTS_HEADING = 'Get alerts for this validator';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Spec 2026-11-21 section 4: a blue bell tile, one visible line, the field and the secondary button;
// both earlier paragraphs stay verbatim behind "What is sent and stored".
export const ALERTS_LINE = 'One email each time this validator is not elected, goes offline, is disabled or slashed, or changes commission or keys.';
const ic = (name) => `<i class="bx ${name}" aria-hidden="true"></i>`;
export function renderAlertsControl({ esc, stash, maxPerEmail = 5 }) {
    return `<section class="list-container glass validate-alerts" aria-labelledby="validate-alerts-title" data-validate-stash="${esc(stash)}">`
        + `<div class="list-header validate-card-head"><span class="ui-tile is-blue" aria-hidden="true">${ic('bx-bell')}</span><h3 id="validate-alerts-title">${esc(ALERTS_HEADING)}</h3></div>`
        + '<div class="validate-body">'
        + `<p class="validate-alerts-line">${esc(ALERTS_LINE)}</p>`
        + '<form id="validate-alerts-form" class="validate-lookup" novalidate>'
        + '<label for="validate-alerts-email" class="validate-label">Your email address</label>'
        + '<div class="validate-lookup-row"><input id="validate-alerts-email" type="email" data-input-kind="text" autocomplete="email" spellcheck="false" aria-describedby="validate-alerts-msg" placeholder="you@example.com">'
        + '<button type="submit" class="validate-secondary">Get alerts</button></div>'
        + '<p id="validate-alerts-msg" class="validate-msg" aria-live="polite"></p></form>'
        + '<details class="validate-disclosure"><summary>What is sent and stored</summary>'
        + '<p class="validate-msg">Get an email when this validator is not elected for a new era, has sent no heartbeat and authored no block by 85% of a session, '
        + 'is disabled or slashed, or changes its commission or its session keys. You get one email for each occurrence and nothing else.</p>'
        + `<p class="validate-msg">We send a confirmation email first and nothing about the validator until you confirm. Every alert has an unsubscribe link that works without logging in. `
        + `You can follow up to ${esc(maxPerEmail)} validators with one address. Your address is not shared and is not used for anything else. `
        + 'See the <a href="/privacy" class="item-link" data-spa-link="true">privacy page</a> for what is stored.</p>'
        + '</details></div></section>';
}

async function defaultPost(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok || data.error) throw new Error(data.error || 'Could not set up alerts. Try again.');
    return data;
}

export async function mountAlertsControl(el, d) {
    if (!el) return;
    const esc = d.esc;
    let cfg = null;
    try { cfg = await d.fetchJson('/api/validator-alerts/status'); } catch (e) { cfg = null; }
    if (!cfg || !cfg.enabled) { el.innerHTML = ''; return; }
    el.innerHTML = renderAlertsControl({ esc, stash: d.stash, maxPerEmail: cfg.maxPerEmail || 5 });
    const form = el.querySelector('#validate-alerts-form');
    const input = el.querySelector('#validate-alerts-email');
    const msg = el.querySelector('#validate-alerts-msg');
    const btn = form.querySelector('button[type="submit"]');
    enhanceInputActions(form);
    const post = typeof d.postJson === 'function' ? d.postJson : defaultPost;
    // The result line: a green check when the server accepted, a red mark on an invalid address, else plain words.
    const say = (cls, icon, text) => { msg.className = 'validate-msg' + (cls ? ' ' + cls : ''); msg.innerHTML = (icon ? ic(icon) + ' ' : '') + esc(text); };
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = String(input.value || '').trim();
        if (!EMAIL_RE.test(email)) {
            input.setAttribute('aria-invalid', 'true');
            say('is-error', 'bx-error-circle', 'Please enter a valid email address.');
            return;
        }
        input.removeAttribute('aria-invalid');
        btn.disabled = true;
        say('', '', 'Sending the confirmation email...');
        try {
            const r = await post('/api/validator-alerts/subscribe', { email, stash: d.stash });
            // The server answers every request alike; the page adds only what is true for all of them.
            const said = r && typeof r.message === 'string' && r.message ? r.message : 'If this address can receive alerts, a confirmation email is on its way.';
            say('is-ok', 'bx-check', `${said} The link works for 24 hours, and no alerts start until you use it.`);
        } catch (err) {
            say('', '', err && err.message ? err.message : 'Could not set up alerts. Try again.');
        } finally {
            btn.disabled = false;
        }
    });
}
