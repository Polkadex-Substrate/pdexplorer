// "Check my node" card (design section 3.5) and the "Node on telemetry" row of
// the validator status. The node name is kept in the URL as ?node=NAME so the
// page can be bookmarked; nothing is stored in the browser. The browser only
// ever asks the explorer's own GET /api/telemetry/node; it never contacts
// telemetry (CEO decision D3; the CSP has no telemetry host).
//
// Brand: the Check button is secondary (one primary per view at most); green
// only on the "In sync" word; every state is a word. Node names are untrusted
// text, escaped with esc. Tested in test/validator-node.test.js.

import { nodeCheckModel, NAME_MAX } from './node-check.js';

const toneClass = (t) => (t === 'positive' ? 'is-positive' : t === 'error' ? 'is-error' : 'is-neutral');
const shortId = (s) => (s && s.length > 16 ? s.slice(0, 8) + '...' + s.slice(-6) : (s || ''));
const fmt = (n) => (n == null ? '' : '#' + Number(n).toLocaleString('en-US'));

export function renderNodeCheckCard({ esc, name = '' }) {
    return '<form id="node-check-form" class="validate-node-check" role="search" novalidate>'
        + '<label for="node-check-input" class="validate-label">Node name (the value of --name)</label>'
        + `<div class="validate-lookup-row"><input id="node-check-input" type="text" maxlength="${NAME_MAX}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="node-check-msg" value="${esc(name)}">`
        + '<button type="submit" class="validate-secondary">Check node</button></div>'
        + '<p id="node-check-msg" class="validate-msg"></p>'
        + '<div id="node-check-result" class="validate-node-result" aria-live="polite"></div></form>';
}

export function renderNodeCheckResult(r, { esc }) {
    const m = nodeCheckModel(r);
    let html = `<p class="validate-node-verdict"><span class="validate-word ${toneClass(m.tone)}">${esc(m.word)}</span> <span class="validate-text">${esc(m.text)}</span></p>`;
    if (m.state === 'several') {
        html += '<div class="balance-locks-table-wrap"><table class="data-table validate-node-table"><thead><tr>'
            + '<th scope="col" class="table-th">Peer id</th><th scope="col" class="table-th">Client</th><th scope="col" class="table-th">Best block</th><th scope="col" class="table-th">Peers</th></tr></thead><tbody>'
            + m.nodes.map(n => `<tr><th scope="row" class="mono" title="${esc(n.networkId)}">${esc(shortId(n.networkId))}</th><td>${esc(n.version)}</td><td>${esc(fmt(n.best))}</td><td>${esc(n.peers == null ? '' : n.peers)}</td></tr>`).join('')
            + '</tbody></table></div>';
    }
    if (m.similar.length) {
        html += '<p class="validate-msg">Similar names reporting now: '
            + m.similar.map(s => `<button type="button" class="validate-text-btn" data-node-name="${esc(s)}">${esc(s)}</button>`).join(' ') + '</p>';
    }
    if (m.notes.length) html += '<ul class="validate-node-notes">' + m.notes.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>';
    return html;
}

// The S1 status row markup, for the "Node on telemetry" row.
export function telemetryRowHtml(row, esc) {
    return `<div class="validate-row"><dt>${esc(row.label)}</dt><dd><span class="validate-word ${toneClass(row.tone)}">${esc(row.word)}</span> <span class="validate-text">${esc(row.text)}</span></dd></div>`;
}

// d: { fetchJson, esc, setNodeParam(name) }. Runs the check at once when the
// field already holds a name (a bookmarked ?node=NAME).
export function wireNodeCheck(root, d) {
    const form = root.querySelector('#node-check-form');
    if (!form) return null;
    const input = root.querySelector('#node-check-input'), msg = root.querySelector('#node-check-msg'), out = root.querySelector('#node-check-result');
    let seq = 0;
    async function check(raw) {
        const name = String(raw || '').trim();
        if (!name) { msg.textContent = 'Enter the node name, the value of --name.'; input.setAttribute('aria-invalid', 'true'); return; }
        if (name.length > NAME_MAX) { msg.textContent = `A node name is at most ${NAME_MAX} characters.`; input.setAttribute('aria-invalid', 'true'); return; }
        input.removeAttribute('aria-invalid');
        msg.textContent = '';
        const mine = ++seq;
        out.setAttribute('aria-busy', 'true');
        out.innerHTML = '<p class="validate-msg">Reading telemetry...</p>';
        if (typeof d.setNodeParam === 'function') d.setNodeParam(name);
        let r;
        try { r = await d.fetchJson('/api/telemetry/node?name=' + encodeURIComponent(name)); } catch (e) {
            r = e && e.status === 429 ? null : { feed: 'down', name };
            if (mine !== seq) return;
            if (!r) { out.removeAttribute('aria-busy'); out.innerHTML = ''; msg.textContent = 'Too many lookups from this address. Wait a minute and try again.'; return; }
        }
        if (mine !== seq) return;
        out.removeAttribute('aria-busy');
        out.innerHTML = renderNodeCheckResult({ ...r, name: r && r.name ? r.name : name }, { esc: d.esc });
        for (const b of out.querySelectorAll('[data-node-name]')) b.addEventListener('click', () => { input.value = b.getAttribute('data-node-name'); check(input.value); });
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); check(input.value); });
    const ran = input.value.trim() ? check(input.value) : Promise.resolve();
    return { check, ran };
}
