// The shared ui-* parts in markup (spec cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// section 2.4): one icon, one chip, one panel and one trust row for every view that draws them, so the
// classes and the aria-hidden on each glyph are written once. Pure strings; text goes through esc.
//
// Colour is never the only signal: a chip is an icon and a word, a panel is an icon and a sentence.

export const icon = (name) => `<i class="bx ${name}" aria-hidden="true"></i>`;

// cls: the role class ('is-positive', 'is-wait', 'is-info', 'is-step', 'is-error', 'is-neutral').
export const chipHtml = (cls, iconName, word, esc) => `<span class="ui-chip ${cls}">${icon(iconName)}${esc(word)}</span>`;

// Swap a chip or status word in place: its role class, its icon and its word together, so an update never
// leaves the old role's colour behind. The word is text (never markup); no iconName means no icon.
const ROLE_CLASSES = ['is-positive', 'is-wait', 'is-info', 'is-step', 'is-error', 'is-neutral', 'is-ok', 'is-warn'];
export function setChip(el, role, iconName, word) {
    for (const c of ROLE_CLASSES) el.classList.remove(c);
    if (role) el.classList.add(role);
    el.textContent = '';
    if (iconName) {
        el.insertAdjacentHTML('beforeend', icon(iconName));
        el.appendChild(el.ownerDocument.createTextNode(' '));
    }
    el.appendChild(el.ownerDocument.createTextNode(String(word)));
}

// A key's check result as a status word (setup wizard and manage panel): word is markup the caller escaped.
export const resultWord = (result, word) => (result === 'other' ? `<span class="validate-word is-error">${icon('bx-error-circle')}${word}</span>`
    : result === 'free' || result === 'own' ? `<span class="validate-word is-positive">${icon('bx-check')}${word}</span>` : `<span class="validate-word is-neutral">${word}</span>`);

// A one-line panel (.is-line): icon and text only. body is markup the caller has escaped.
export const linePanelHtml = (cls, iconName, body, attrs = '') => `<p class="ui-panel ${cls} is-line"${attrs}>${icon(iconName)}<span class="ui-panel-body">${body}</span></p>`;

// A block panel: the role icon, then an optional title and the body. body is markup the caller has escaped;
// attrs is extra attributes (role, id). tag: 'div' (a body of paragraphs or a list) or 'p' (one sentence).
export function panelHtml(cls, iconName, body, { title = '', attrs = '', esc = null, tag = 'div' } = {}) {
    const inner = tag === 'p' ? 'span' : 'div';
    return `<${tag} class="ui-panel ${cls}"${attrs}>${icon(iconName)}<${inner} class="ui-panel-body">`
        + (title ? `<p class="ui-panel-title">${esc ? esc(title) : title}</p>` : '') + `${body}</${inner}></${tag}>`;
}

// The trust row (spec 2.4): the short line, and the full statement verbatim behind "Details". With no
// statement the row is the line alone (the wizard and the node guide show the statement itself, verbatim).
export function trustHtml(esc, line, statement, cls = 'validate-trust') {
    return `<div class="ui-trust ${cls}"><span class="ui-tile is-green is-sm" aria-hidden="true">${icon('bx-shield-quarter')}</span>`
        + `<p>${esc(line)}</p>` + (statement ? `<details class="validate-disclosure"><summary>Details</summary><p>${esc(statement)}</p></details>` : '') + '</div>';
}

// A step marker (spec 2.4): the number, or for a done step the green check and "done" for screen readers.
export const stepMarkerHtml = (n, marker) => (marker === 'done'
    ? `<span class="ui-step is-done">${icon('bx-check')}<span class="sr-only">done</span></span>`
    : `<span class="ui-step is-${marker}">${n}</span>`);

// The shell's top-bar button counts as a primary (fidelity review 4): with no wallet connected and a page
// that draws its own primary, the header Connect Wallet steps back to an outline. Used by script.js and the
// preview scenes, so both follow one rule.
export const PAGE_PRIMARY_SELECTOR = '.validate-primary, .wallet-option-row.is-primary';
export function headerLook({ connected = false, pagePrimary = false } = {}) {
    if (connected) return 'connected';
    return pagePrimary ? 'outline' : 'solid';
}

// The page head (plan 2026-11-25-page-header-alignment): title row, meta line, actions row, one left edge.
// title is text (escaped here). titleExtra, help, each meta item and actions are markup the caller escaped.
// Keeps the class list-header: lib/gov-post-action.js finds '.list-header h2' and inserts after '.list-header'.
export function pageHeadHtml({ title, esc, titleExtra = '', help = '', meta = [], actions = '', actionsAttrs = '', outside = false, ruled = false, extraClass = '' }) {
    const cls = ['list-header', 'ui-page-head', outside ? 'is-outside' : '', ruled ? 'is-ruled' : '', extraClass].filter(Boolean).join(' ');
    return `<div class="${cls}">`
        + `<div class="ui-page-head-title"><h2>${esc(title)}</h2>${titleExtra}${help}</div>`
        + (meta.length ? `<p class="ui-page-head-meta">${meta.map(m => `<span>${m}</span>`).join('')}</p>` : '')
        + (actions || actionsAttrs ? `<div class="ui-page-head-actions"${actionsAttrs}>${actions}</div>` : '')
        + '</div>';
}

// One tab row for every page. tabs: [{ key, label }] (label is markup the caller escaped). attr: the data attribute
// each page already uses ('data-treastab', 'data-demtab'). extra: a class some pages need on each tab ('account-tab-btn').
export function tabsHtml(tabs, activeKey, attr, { label = '', extra = '' } = {}) {
    return `<div class="account-tabs" role="tablist"${label ? ` aria-label="${label}"` : ''}>`
        + tabs.map(t => `<button type="button" role="tab" class="account-tab${extra ? ' ' + extra : ''}${t.key === activeKey ? ' active' : ''}" aria-selected="${t.key === activeKey}" ${attr}="${t.key}">${t.label}</button>`).join('')
        + '</div>';
}

// Where a tab row should scroll so the selected tab shows (horizontal only: scrollIntoView could also move the page
// up or down on every redraw). pad: how far inside the right edge the end of the tab lands.
export function tabRowScroll({ tabLeft, tabWidth, viewLeft, viewWidth, pad = 24 }) {
    if (tabLeft < viewLeft) return tabLeft;
    if (tabLeft + tabWidth > viewLeft + viewWidth) return tabLeft + tabWidth + pad - viewWidth;
    return viewLeft;
}
// root: the tab row, or an element that holds one. A page without one does nothing.
export function revealActiveTab(root) {
    const row = root && root.querySelector ? (root.matches && root.matches('.account-tabs') ? root : root.querySelector('.account-tabs')) : null;
    const tab = row && row.querySelector('.account-tab.active');
    if (!tab) return;
    const left = tabRowScroll({ tabLeft: tab.offsetLeft, tabWidth: tab.offsetWidth, viewLeft: row.scrollLeft, viewWidth: row.clientWidth });
    if (left !== row.scrollLeft) row.scrollLeft = left;
}

// ── Sprint 11 site sweep (spec 2026-11-26, sections 2.1 and 2.3 I31, I48) ──

// A centred state line: loading, empty, waiting, failed or invalid. text is plain text (escaped here); the icon comes
// first and colour is never the only signal. roomy: the 40 px blocks.
const STATE_ICON = { loading: 'bx-loader-alt bx-spin', wait: 'bx-time-five', failed: 'bx-error', invalid: 'bx-error-circle' };
const STATE_ROLE = { loading: 'status', wait: 'status', failed: 'alert' };
export function stateHtml(kind, text, { roomy = false, esc } = {}) {
    const role = STATE_ROLE[kind] ? ` role="${STATE_ROLE[kind]}"` : '';
    return `<div class="ui-state is-${kind}${roomy ? ' is-roomy' : ''}"${role}>${STATE_ICON[kind] ? icon(STATE_ICON[kind]) : ''}${esc(text)}</div>`;
}

// A page that could not load at all (Discussions, Democracy, Treasury): an amber panel (an explorer-side read failure
// is not red), the title, the detail and the hint as text, and a secondary "Try again" with the given id.
export function loadFailedHtml({ title, detail, hint, retryId, esc }) {
    const body = `<p>${esc(detail)}</p>` + (hint ? `<p>${esc(hint)}</p>` : '');
    return `<div class="list-container glass ui-state is-roomy">${panelHtml('is-warn', 'bx-error', body, { title, esc })}`
        + `<button type="button" class="validate-secondary" id="${esc(retryId)}">${icon('bx-refresh')}Try again</button></div>`;
}

// A hint or message state, by data-state ('', 'note', 'ok', 'error') and never by a colour set from script: the
// stylesheet colours each state, ok and error carry their icon. text is plain text; left out, only the state changes
// (a message the caller drew, a refusal with a link, keeps its markup).
const HINT_ICON = { ok: 'bx-check', error: 'bx-error-circle' };
export function setHint(el, state, text) {
    if (!el) return;
    el.setAttribute('data-state', state || '');
    if (text === undefined) return;
    el.textContent = '';
    if (HINT_ICON[state]) el.insertAdjacentHTML('beforeend', `<i class="bx ${HINT_ICON[state]} ui-hint-icon" aria-hidden="true"></i>`);
    el.appendChild(el.ownerDocument.createTextNode(String(text)));
}
