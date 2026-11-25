// The Advanced card on the wallet page: Proxies, the multisig address calculator and the read-only pending viewer
// (spec cto-team/plans/2026-11-25-multisig-and-advanced-cards.md, section 4). Pure strings plus one binder, and no
// imports, so tests render it directly. script.js keeps the handlers (the add-proxy submit stays there: a test
// slices it) and calls these for every piece of markup.
//
// Markup follows the shared ui-* parts (lib/ui-parts.js): the same icon, panel and line markup, written here so the
// module stays import-free. Text goes through the caller's esc.

const icon = (name) => `<i class="bx ${name}" aria-hidden="true"></i>`;
const panel = (cls, iconName, body, title = '') => `<div class="ui-panel ${cls}">${icon(iconName)}<div class="ui-panel-body">`
    + (title ? `<p class="ui-panel-title">${title}</p>` : '') + `${body}</div></div>`;
const linePanel = (cls, iconName, body) => `<p class="ui-panel ${cls} is-line">${icon(iconName)}<span class="ui-panel-body">${body}</span></p>`;
const plain = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const ADVANCED_TEXT = Object.freeze({
    sub: 'Let another account sign for this one, and work with multisig wallets',
    loadingProxies: 'Loading proxies...',
    proxiesOff: 'Proxies are not available on this network.',
    delayRange: 'Enter a delay from 0 to 10,000,000 blocks.',
    fewSigners: 'Add at least two signer addresses.',
    range: 'Approvals needed must be between 1 and {n}.',
    badLine: 'Line {i} is not a valid Polkadex address: {short}',
    duplicate: 'This signer is listed twice. Remove the duplicate.',
    derive: 'Could not work out the address: {m}',
    resultTitle: 'Multisig address ({t} of {n})',
    copy: 'Copy address', copied: 'Copied', said: 'Address copied', holdMs: 1500,
    checking: 'Checking...',
    pendingEmpty: 'Nothing is waiting for approval on this address.',
    multisigOff: 'Multisig is not available on this network.'
});

// The card: a title row and three titled sections. The add form's slot only for the account's own wallet.
export function advancedShellHtml({ isOwn = false } = {}) {
    return `<div class="list-container glass wallet-advanced">
            <div class="list-header">
                <h2>${icon('bx-shield-quarter')} Advanced</h2>
                <p class="wallet-advanced-sub">${ADVANCED_TEXT.sub}</p>
            </div>
            <section class="ui-section" aria-labelledby="adv-proxies-title">
                <h3 class="ui-section-title" id="adv-proxies-title">Proxies</h3>
                <p class="ui-section-caption">A <span class="glossary-term" data-term="proxy">proxy</span> is another account that can sign for this one.</p>
                <div id="wallet-proxy-list"><p class="ui-empty">${ADVANCED_TEXT.loadingProxies}</p></div>
                ${isOwn ? '<div id="wallet-proxy-add"></div>' : ''}
            </section>
            <section class="ui-section" aria-labelledby="adv-calc-title"><div id="wallet-multisig-calc"></div></section>
            <section class="ui-section" aria-labelledby="adv-pending-title" id="adv-pending-section"><div id="wallet-multisig-pending"></div></section>
        </div>`;
}

export const proxyUnavailableHtml = () => `<p class="ui-empty">${ADVANCED_TEXT.proxiesOff}</p>`;

// The add-proxy form. types: the network's proxy types (escaped here through esc).
export function proxyAddFormHtml(types, esc = plain) {
    return `<h4 class="ui-field-label wallet-advanced-subtitle">Add a proxy</h4>
        <div class="proxy-add-grid">
            <div class="ui-field">
                <label class="ui-field-label" for="proxy-add-delegate">Account to add</label>
                <input type="text" class="ui-input" id="proxy-add-delegate" data-input-kind="address" placeholder="Paste its address" autocomplete="off" spellcheck="false" aria-describedby="proxy-add-error">
            </div>
            <div class="ui-field">
                <label class="ui-field-label" for="proxy-add-type">What it may sign</label>
                <select class="ui-input" id="proxy-add-type" aria-describedby="proxy-add-error">
                    ${(types || []).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
                </select>
            </div>
            <div class="ui-field">
                <label class="ui-field-label" for="proxy-add-delay">Delay in blocks</label>
                <input type="number" class="ui-input is-narrow" id="proxy-add-delay" data-no-input-actions="numeric stepper: the browser arrows already fill this narrow field" min="0" value="0" aria-describedby="proxy-add-delay-hint proxy-add-error">
                <p class="ui-field-hint" id="proxy-add-delay-hint">0 means it can sign at once.</p>
            </div>
            <button type="button" id="proxy-add-submit" class="ui-action">${icon('bx-user-plus')}Add proxy</button>
        </div>
        <p id="proxy-add-error" class="ui-field-error" role="alert" hidden></p>`;
}

// A field error: the icon and the sentence (as text) in the error node, aria-invalid on the field at fault (if any).
export function showFieldError(errEl, text, field = null) {
    if (errEl) {
        errEl.innerHTML = icon('bx-error-circle');
        errEl.appendChild(errEl.ownerDocument.createTextNode(String(text)));
        errEl.hidden = false;
    }
    if (field && field.setAttribute) field.setAttribute('aria-invalid', 'true');
}
export function clearFieldErrors(errEl, fields = []) {
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
    for (const f of fields) if (f && f.removeAttribute) f.removeAttribute('aria-invalid');
}

// ── the multisig address calculator ──
const field = ({ id, label, hint, control }) => `<div class="ui-field">
                <label class="ui-field-label" for="${id}">${label}</label>
                ${control}
                <p class="ui-field-hint" id="${id}-hint">${hint}</p>
                <p class="ui-field-error" id="${id}-error" role="alert"></p>
            </div>`;
export function calculatorHtml() {
    return `<h3 class="ui-section-title" id="adv-calc-title">Multisig address calculator</h3>
        <p class="ui-section-caption">Enter the signers and how many must approve. The same details always give the same <span class="glossary-term" data-term="multisig">multisig</span> address. Nothing is sent.</p>
        <form class="ui-form" id="multisig-calc-form" novalidate>
            ${field({ id: 'multisig-signers', label: 'Signer addresses', hint: 'One address per line. Include every signer.',
                control: '<textarea class="ui-input" id="multisig-signers" data-input-kind="address-list" rows="4" placeholder="One address per line" spellcheck="false" aria-describedby="multisig-signers-hint multisig-signers-error"></textarea>' })}
            ${field({ id: 'multisig-threshold', label: 'Approvals needed', hint: 'How many signers must approve a transaction.',
                control: `<input type="number" class="ui-input is-narrow" id="multisig-threshold" data-no-input-actions="numeric stepper: the browser arrows already fill this narrow field" min="1" value="2" aria-describedby="multisig-threshold-hint multisig-threshold-error">` })}
            <button type="submit" id="multisig-calc-go" class="ui-action">${icon('bx-calculator')}Calculate address</button>
        </form>
        <div id="multisig-result" role="status" aria-live="polite"></div>`;
}

// The result: a green panel, the address in full with Copy address, and a link to the account page.
export function calcResultHtml({ address, threshold, count }, esc = plain) {
    const a = esc(address);
    return panel('is-ok', 'bx-check-circle',
        `<div class="address-cell calc-address" data-address="${a}"><code>${a}</code>`
        + `<button type="button" class="validate-secondary js-copy-address">${icon('bx-copy')}<span class="copy-word">${ADVANCED_TEXT.copy}</span></button></div>`
        + `<p><a href="/account/${encodeURIComponent(address)}" class="item-link">Open this account</a></p>`,
        esc(ADVANCED_TEXT.resultTitle.replace('{t}', threshold).replace('{n}', count)));
}

// One handler on the form's submit (a click on Calculate address and Enter in a field both submit it).
// deps: isValid(address), derive(lines, threshold) -> address (may throw), keyOf(address) -> the account key (two
// encodings of one account are one signer), write(text) -> promise (the clipboard), announce(text), esc, short,
// setTimer(fn, ms) (the "Copied" hold; without one the word comes back at once).
export function bindCalculator(root, { isValid, derive, keyOf = (a) => a, write = null, announce = () => {}, esc = plain, short = (a) => a, setTimer = null } = {}) {
    if (!root) return;
    const q = (s) => root.querySelector(s);
    const form = q('#multisig-calc-form'), signers = q('#multisig-signers'), thr = q('#multisig-threshold'), result = q('#multisig-result');
    if (!form || !signers || !thr || !result) return;
    const fields = [signers, thr];
    const errOf = (f) => q(`#${f.id}-error`);
    const clear = () => { for (const f of fields) { f.removeAttribute('aria-invalid'); const e = errOf(f); if (e) e.textContent = ''; } };
    const fail = (f, text) => {
        f.setAttribute('aria-invalid', 'true');
        const e = errOf(f);
        if (e) e.innerHTML = icon('bx-error-circle') + esc(text);
        if (typeof f.focus === 'function') f.focus();
    };
    const run = () => {
        clear();
        result.innerHTML = '';
        const lines = (signers.value || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
        const n = parseInt(thr.value || '0', 10);
        if (lines.length < 2) return fail(signers, ADVANCED_TEXT.fewSigners);
        if (!Number.isFinite(n) || n < 1 || n > lines.length) return fail(thr, ADVANCED_TEXT.range.replace('{n}', lines.length));
        for (let i = 0; i < lines.length; i++) {
            if (!isValid(lines[i])) return fail(signers, ADVANCED_TEXT.badLine.replace('{i}', i + 1).replace('{short}', short(lines[i])));
        }
        // A duplicate gives an address no multisig on chain can have (CTO ruling 2026-11-25): refused, not derived.
        const seen = new Set();
        for (const a of lines) {
            let k;
            try { k = String(keyOf(a)); } catch (e) { k = a; }
            if (seen.has(k)) return fail(signers, ADVANCED_TEXT.duplicate);
            seen.add(k);
        }
        let address;
        try { address = derive(lines, n); } catch (e) {
            result.innerHTML = linePanel('is-error', 'bx-error-circle', esc(ADVANCED_TEXT.derive.replace('{m}', (e && e.message) || String(e))));
            return;
        }
        result.innerHTML = calcResultHtml({ address, threshold: n, count: lines.length }, esc);
        bindCopy(result.querySelector('.js-copy-address'));
    };
    const bindCopy = (btn) => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            const holder = btn.closest('[data-address]');
            const address = holder && holder.getAttribute('data-address');
            if (!address || typeof write !== 'function') return;
            const word = btn.querySelector('.copy-word');
            const ok = () => {
                if (word) word.textContent = ADVANCED_TEXT.copied;
                announce(ADVANCED_TEXT.said);
                const back = () => { if (word) word.textContent = ADVANCED_TEXT.copy; };
                if (typeof setTimer === 'function') setTimer(back, ADVANCED_TEXT.holdMs); else back();
            };
            let r;
            try { r = write(address); } catch (e) { return; }
            if (r && typeof r.then === 'function') r.then(ok, () => {}); else ok();
        });
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
    // A shown address always matches the fields above it: any edit clears the marks, the errors and the result.
    for (const f of fields) f.addEventListener('input', () => { clear(); result.innerHTML = ''; });
}

// ── the pending viewer (read-only; shown when the address is not a saved multisig) ──
const pendingHead = () => '<h3 class="ui-section-title" id="adv-pending-title">Pending multisig approvals</h3>'
    + '<p class="ui-section-caption">Shown when this address is a multisig wallet.</p>';
const pendingFrame = (body) => `${pendingHead()}<div class="adv-pending-body">${body}</div>`;
export const pendingLoadingHtml = () => pendingFrame(`<p class="ui-empty">${icon('bx-loader-alt bx-spin')}${ADVANCED_TEXT.checking}</p>`);
export const pendingUnavailableHtml = () => pendingFrame(`<p class="ui-empty">${ADVANCED_TEXT.multisigOff}</p>`);
const HEADERS = ['Call hash', 'Approvals', 'Started by', 'Block'];
// list: the server's pending entries ({ callHash, approvals, depositor, when }); fmt: { esc, short, number }.
export function pendingHtml(list, { esc = plain, short = (a) => a, number = (n) => String(n) } = {}) {
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) return pendingFrame(`<p class="ui-empty">${ADVANCED_TEXT.pendingEmpty}</p>`);
    const cell = (cls, i, html) => `<td class="${cls}" data-label="${HEADERS[i]}">${html}</td>`;
    const body = rows.map(p => '<tr>'
        + cell('ms-cell-hash', 0, `<code>${esc(short(p.callHash || '') || '-')}</code>`)
        + cell('ms-cell-approvals', 1, String((p.approvals || []).length))
        + cell('ms-cell-by', 2, `<a href="/account/${encodeURIComponent(p.depositor || '')}" class="item-link address-cell">${esc(short(p.depositor || '') || '-')}</a>`)
        + cell('ms-cell-block', 3, p.when ? `#${esc(number(p.when.height))}` : '-')
        + '</tr>').join('');
    return pendingFrame(`<div class="table-responsive"><table class="data-table ms-pending-table">
            <thead><tr>${HEADERS.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${body}</tbody>
        </table></div>
        <p class="ui-section-caption ms-pending-foot">To approve or cancel one, <a href="/wallet?switch=1#multisig" class="item-link">add this multisig wallet</a> with its signers and number of approvals.</p>`);
}
