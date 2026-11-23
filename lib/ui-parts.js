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
