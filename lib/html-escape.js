// One HTML escaper, shared by the server and the SPA.
//
// Audit F-133. There were three of these. Round 1 collapsed the two in
// script.js — `escapeHtml` is now a one-line forward to `stakingEscapeHtml` —
// and left server.js's `htmlEscape` as an independent twin. Two
// implementations of the same five-character substitution, maintained by hand,
// already disagreed on the apostrophe (`&#39;` client-side, `&#039;` on the
// server). Both are valid HTML5, so nothing broke; that is exactly why nobody
// noticed them drifting.
//
// The apostrophe was the harmless difference. The dangerous version of the same
// drift is one copy learning about a character the other has not — and this is
// an XSS boundary, so "the two escapers disagree about what needs escaping" is
// a vulnerability rather than an inconsistency. Round 1's own finding list has
// four separate XSS entries (F-013, F-014, F-015, F-122) that came from
// unescaped interpolation; the fix for those is only as good as the escaper
// they call, and there is now one of it.
//
// The set is the standard five. `&` MUST be substituted first, which the single
// regex pass guarantees for free — a sequential `.replace(/&/…)` chain does too,
// but only because it is written in the right order, and that ordering is a
// silent correctness dependency the next editor cannot see. One pass over a
// character class has no order to get wrong.
//
// Not escaped: `/`, backtick, and the non-breaking characters some escapers add.
// They are unnecessary for text and attribute-value contexts with quoted
// attributes, which is every call site here. If a caller ever needs to
// interpolate into an unquoted attribute or a <script> body, escaping is the
// wrong tool — that call site needs restructuring, not a bigger character class.
const REPLACEMENTS = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => REPLACEMENTS[c]);
}

// The characters this escaper handles, exported so a test can assert the two
// call-site wrappers agree without restating the list a third time.
export const ESCAPED_CHARS = Object.keys(REPLACEMENTS);
