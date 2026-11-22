// The shared ui-* parts in markup (spec cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// section 2.4): one icon, one chip, one panel and one trust row for every view that draws them, so the
// classes and the aria-hidden on each glyph are written once. Pure strings; text goes through esc.
//
// Colour is never the only signal: a chip is an icon and a word, a panel is an icon and a sentence.

export const icon = (name) => `<i class="bx ${name}" aria-hidden="true"></i>`;

// cls: the role class ('is-positive', 'is-wait', 'is-info', 'is-step', 'is-error', 'is-neutral').
export const chipHtml = (cls, iconName, word, esc) => `<span class="ui-chip ${cls}">${icon(iconName)}${esc(word)}</span>`;

// A one-line panel (.is-line): icon and text only. body is markup the caller has escaped.
export const linePanelHtml = (cls, iconName, body, attrs = '') => `<p class="ui-panel ${cls} is-line"${attrs}>${icon(iconName)}<span class="ui-panel-body">${body}</span></p>`;

// The trust row (spec 2.4): the short line, and the full statement verbatim behind "Details".
export function trustHtml(esc, line, statement, cls = 'validate-trust') {
    return `<div class="ui-trust ${cls}"><span class="ui-tile is-green is-sm" aria-hidden="true">${icon('bx-shield-quarter')}</span>`
        + `<p>${esc(line)}</p><details class="validate-disclosure"><summary>Details</summary><p>${esc(statement)}</p></details></div>`;
}

// The shell's top-bar button counts as a primary (fidelity review 4): with no wallet connected and a page
// that draws its own primary, the header Connect Wallet steps back to an outline. Used by script.js and the
// preview scenes, so both follow one rule.
export const PAGE_PRIMARY_SELECTOR = '.validate-primary, .wallet-option-row.is-primary';
export function headerLook({ connected = false, pagePrimary = false } = {}) {
    if (connected) return 'connected';
    return pagePrimary ? 'outline' : 'solid';
}
