// Validation for the only free-text fields users can persist.
//
// Audit F-170. `POST /api/labels/:address` rejects ASCII control characters
// and angle brackets in the label, with a comment explaining why: so the UI
// never has to escape a string it received as "trusted". The sibling route
// `POST /api/labels/:address/:signer/report` accepted its `reason` with no
// validation at all — trim, hand to SQLite, slice to 200. Same table family,
// same authenticated writer, opposite treatment.
//
// Nothing renders `reason` today, which is exactly why it is worth fixing now
// rather than later: the field is dormant stored XSS waiting for the first
// moderation screen, admin export, or support email that reads it back. The
// person who writes that screen will reasonably assume the data was validated
// on the way in, because its neighbour was.
//
// Hence one shared checker rather than a second copy of the regex: two
// hand-rolled guards on the same table WILL drift, and the drift is what the
// finding is actually about.

// Characters that must never reach storage from a user-supplied string:
//   \x00-\x1f  C0 controls — NUL truncates in C string contexts, \r\n forges
//              log lines, and none of them are legitimate label/report text.
//   \x7f       DEL.
//   < >        so no consumer can produce markup by concatenation, even one
//              that forgot to escape.
const DISALLOWED = /[\x00-\x1f\x7f<>]/;

// Returns { ok: true, value } or { ok: false, error } — never throws, so a
// route can forward `error` straight to the client as a 400.
//
//   maxLength — hard cap. Enforced by REJECTION, not truncation: silently
//               storing a shortened version of what someone wrote is its own
//               small lie, and the caller can show a character counter.
//   minLength — 0 means the field is optional and '' is acceptable.
export function checkUserText(input, { minLength = 0, maxLength = 200, field = 'Text' } = {}) {
    const value = String(input == null ? '' : input).trim();

    if (value.length === 0) {
        return minLength === 0
            ? { ok: true, value: '' }
            : { ok: false, error: `${field} is required.` };
    }
    if (value.length < minLength || value.length > maxLength) {
        return {
            ok: false,
            error: minLength > 0
                ? `${field} must be ${minLength}–${maxLength} characters.`
                : `${field} must be at most ${maxLength} characters.`
        };
    }
    if (DISALLOWED.test(value)) {
        return { ok: false, error: `${field} contains disallowed characters.` };
    }
    return { ok: true, value };
}
