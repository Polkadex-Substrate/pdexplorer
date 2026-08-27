// Where is it safe to send the user after sign-in?
//
// Audit F-107. The previous guard was three hand-written string checks:
//
//     if (!raw.startsWith('/') || raw.startsWith('//')) return null;
//     if (/[\r\n]/.test(raw)) return null;
//
// which stops the obvious attacks (`https://evil`, `javascript:`, `//evil`)
// and misses the ones that exist precisely because browsers normalise URLs
// before they parse them:
//
//   "/\tevil.com"      TAB, LF and CR are STRIPPED from a URL by the WHATWG
//   "/\t/evil.com"     parser before parsing. `/\t/evil.com` becomes
//                      `//evil.com` — protocol-relative, cross-origin — and
//                      the `startsWith('//')` check ran against the string
//                      BEFORE that stripping happened, so it saw a safe `/`.
//                      (The old `[\r\n]` test caught two of the three
//                      characters and not TAB, which is the tell that it was
//                      written from a list rather than from the parser.)
//
//   "/\\evil.com"      In the authority position a backslash is treated as a
//   "/\/evil.com"      forward slash, so these are also `//evil.com`.
//
//   "/%09/evil.com"    Percent-encoded TAB, decoded before the same stripping.
//
// The lesson generalises past this function: any check of the form "does this
// string LOOK like a safe URL" is a re-implementation of the URL parser, and
// it will be a worse one. So this module does not pattern-match at all — it
// resolves the candidate against the real origin with the real parser and asks
// the only question that matters: did it stay here?
//
// Pure and DOM-free so it can be tested directly; `window.location` is passed
// in rather than read.

// Resolve `raw` against `origin` and return a same-origin path, or null.
//
//   raw    — the untrusted candidate (a `returnTo` query value, a stored
//            redirect, a hash fragment target)
//   origin — e.g. 'https://explorer.polkadex.ee'
//
// Returns "/path?query#hash" — always rebuilt from the PARSED url, never the
// input string, so whatever the caller gets back is what the browser would
// actually navigate to. Returning the raw input would leave the caller holding
// a string that normalises differently from the one we validated, which is the
// same class of bug one level up.
export function safeReturnPath(raw, origin) {
    if (typeof raw !== 'string' || raw === '') return null;
    let base;
    try {
        base = new URL(origin);
    } catch (_) {
        return null;
    }

    let url;
    try {
        url = new URL(raw, base);
    } catch (_) {
        return null;   // not a URL at all
    }

    // The whole check. A scheme change (javascript:, data:), a host change
    // (//evil, https://evil, and every whitespace/backslash spelling of them),
    // or a port change all move the origin.
    if (url.origin !== base.origin) return null;

    // Opaque-origin schemes (about:, blob: in some contexts, data:) serialise
    // their origin as the literal string "null", so two unrelated opaque URLs
    // compare EQUAL above. Reject them explicitly.
    //
    // A `url.protocol !== base.protocol` line used to sit here too. A mutation
    // test removed it and nothing failed, which is the correct signal: an
    // origin is (scheme, host, port), so a protocol change is already an origin
    // change and the line could never fire. Dead code in a security check is
    // worse than absent code — it reads as defence in depth and is not — so it
    // is gone rather than propped up by a test written to justify it.
    if (url.origin === 'null') return null;

    // Rebuild from parsed parts.
    const path = `${url.pathname}${url.search}${url.hash}`;

    // A resolved same-origin URL always has a pathname starting with '/'; if
    // it somehow does not, we do not want to guess.
    return path.startsWith('/') ? path : null;
}

// Convenience wrapper for the common case: read `param` out of a query string
// and return a safe path or null.
//
// Exported and tested but currently unused by script.js, which calls
// safeReturnPath directly because it already has the parsed URLSearchParams.
// Kept deliberately: it is the shape any NEW consumer should reach for, and
// having it here means the next one does not hand-roll the parse-then-validate
// pair and get the order wrong.
export function readSafeReturn(search, origin, param = 'returnTo') {
    let raw;
    try {
        raw = new URLSearchParams(search || '').get(param);
    } catch (_) {
        return null;
    }
    return safeReturnPath(raw, origin);
}
