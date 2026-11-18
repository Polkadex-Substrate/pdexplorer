// Scroll position across SPA navigations (cto-team/plans/2026-11-18-mobile-scroll-top.md).
//
// The window is the page's scroller, and navigateTo() calls preventDefault() on
// the link, which also suppresses the browser's "a new page starts at the top".
// So a tap at the bottom of a long list opened the next page at the bottom.
//
// This module owns two things:
//   1. the decision: a pushed navigation without a #fragment goes to the top,
//      at once and again in the next frame (the render can change the height);
//      a replace (legacy hops, /wallet -> /wallet/<addr>) and a #fragment do not;
//   2. the memory: history.scrollRestoration is 'manual' (the browser's own
//      restore runs before the async content exists), and each history entry's
//      position is saved when it is left and restored on Back/Forward.
//
// Entries pushed through beforeNavigate() carry { scrollKey } in history.state,
// so the same URL twice in history keeps two positions. An entry without a key
// (the page the tab opened on, or one a replaceState(null) rewrote) falls back
// to its path and query.
//
// Import-free and DOM-free apart from the injected window, so it is unit tested
// in happy-dom with stubs (test/scroll-reset.test.js).

export function shouldResetScroll(target, { replace = false } = {}) {
    return !replace && !String(target || '').includes('#');
}

export function createScrollMemory({ win, max = 100, retryMs = 400 } = {}) {
    const positions = new Map();
    // win.location is read on every call; history, scrollTo, requestAnimationFrame and setTimeout are optional.
    const base = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let seq = 0, current = null, ticket = 0;

    const scrollY = () => Number(win.scrollY || win.pageYOffset || 0);
    const to = (y) => { try { win.scrollTo(0, y); } catch (e) { /* a sandboxed frame */ } };
    const later = (fn, ms) => { if (typeof win.setTimeout === 'function') win.setTimeout(fn, ms); };
    const nextFrame = (fn) => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : later(fn, 16));
    function keyNow() {
        let state = null;
        try { state = win.history && win.history.state; } catch (e) { /* ignore */ }
        if (state && typeof state.scrollKey === 'string') return 'k:' + state.scrollKey;
        return 'p:' + win.location.pathname + (win.location.search || '');
    }
    function remember(key) {
        if (!key) return;
        positions.delete(key);
        positions.set(key, scrollY());
        while (positions.size > max) positions.delete(positions.keys().next().value);
    }

    return {
        // bootSeoRouter: once, before the first route. Never scrolls.
        boot() {
            try { if (win.history && 'scrollRestoration' in win.history) win.history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
            current = keyNow();
        },
        // navigateTo, before pushState/replaceState: saves the entry being left and
        // returns the state to push (null for a replace, as before).
        beforeNavigate({ replace = false } = {}) {
            ticket++;   // a pending Back retry must not fire on the new page
            if (!replace) remember(keyNow());
            return replace ? null : { scrollKey: base + '-' + (++seq) };
        },
        // navigateTo, after routeTo.
        afterNavigate(target, { replace = false } = {}) {
            current = keyNow();
            if (!shouldResetScroll(target, { replace })) return;
            const mine = ticket;
            to(0);
            nextFrame(() => { if (mine === ticket) to(0); });
        },
        // popstate, before routeTo: the browser has already switched the entry, so
        // the position belongs to the one this module last saw.
        beforePopstate() { remember(current); },
        // popstate, after routeTo: back to where the entry was left (top if unknown),
        // again in the next frame, and once more later if the page was still too
        // short to reach it (its rows arrive with the first fetch).
        afterPopstate() {
            current = keyNow();
            const want = positions.get(current) || 0, mine = ++ticket;
            to(want);
            nextFrame(() => { if (mine === ticket) to(want); });
            if (want > 0) later(() => { if (mine === ticket && scrollY() < want) to(want); }, retryMs);
        },
        size() { return positions.size; }
    };
}
