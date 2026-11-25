// Scroll position across SPA navigations (cto-team/plans/2026-11-18-mobile-scroll-top.md).
//
// The window is the page's scroller, and navigateTo() calls preventDefault() on
// the link, which also suppresses the browser's "a new page starts at the top".
// So a tap at the bottom of a long list opened the next page at the bottom.
//
// This module owns two things:
//   1. the decision: a pushed navigation without a #fragment goes to the top,
//      at once and again in the next frame (the render can change the height);
//      with a #fragment it goes to that element (else the top); a replace
//      (legacy hops, /wallet -> /wallet/<addr>) never scrolls;
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
    const STORE_KEY = 'pdex-scroll-v1', KEEP = 50;
    const positions = new Map();
    // A reload or a bfcache restore keeps the entries (and their scrollKeys), so the positions are kept too.
    try {
        const raw = win.sessionStorage && win.sessionStorage.getItem(STORE_KEY);
        for (const [k, y] of JSON.parse(raw || '[]')) if (typeof k === 'string' && Number.isFinite(y)) positions.set(k, y);
    } catch (e) { /* storage blocked or garbled: start empty */ }
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
        persist();
    }
    function persist() {
        try { if (win.sessionStorage) win.sessionStorage.setItem(STORE_KEY, JSON.stringify([...positions].slice(-KEEP))); } catch (e) { /* ignore */ }
    }
    const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'];
    // The reader took over: a pending restore or retry must not move the page again.
    const userTookOver = (e) => { if (e.type !== 'keydown' || SCROLL_KEYS.includes(e.key)) ticket++; };
    function namedAnchor() {
        try {
            const h = win.location.hash;
            if (!h || h.length < 2) return false;
            let id = h.slice(1);
            try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
            return !!(win.document && win.document.getElementById(id));
        } catch (e) { return false; }
    }

    return {
        // bootSeoRouter: once, before the first route. Never scrolls.
        boot() {
            try { if (win.history && 'scrollRestoration' in win.history) win.history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
            current = keyNow();
            if (typeof win.addEventListener === 'function') {
                for (const t of ['wheel', 'touchstart', 'touchmove', 'keydown']) win.addEventListener(t, userTookOver, { passive: true });
                win.addEventListener('pagehide', () => { remember(current); });
            }
        },
        // navigateTo, before pushState/replaceState: saves the entry being left and
        // returns the state to push (null for a replace, as before).
        beforeNavigate({ replace = false } = {}) {
            ticket++;   // a pending Back retry must not fire on the new page
            if (replace) {
                // keep what the entry already carries, its scrollKey above all
                let st = null;
                try { st = win.history && win.history.state; } catch (e) { /* ignore */ }
                return st && typeof st === 'object' ? st : null;
            }
            remember(keyNow());
            return { scrollKey: base + '-' + (++seq) };
        },
        // navigateTo, after routeTo.
        afterNavigate(target, { replace = false } = {}) {
            current = keyNow();
            const t = String(target || '');
            // A pushed navigation to a #fragment: the anchor if the page has it (it may arrive with the render, so
            // once more in the next frame), the top if not. A replace never scrolls.
            if (!replace && t.includes('#')) {
                const mine = ticket;
                const land = () => {
                    let id = t.slice(t.indexOf('#') + 1);
                    try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
                    let el = null;
                    try { el = id && win.document ? win.document.getElementById(id) : null; } catch (e) { /* ignore */ }
                    if (el && typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ block: 'start' }); return; } catch (e) { /* fall to the top */ } }
                    to(0);
                };
                land();
                nextFrame(() => { if (mine === ticket) land(); });
                return;
            }
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
            const mine = ++ticket;
            // a Back/Forward between #anchor entries: the smooth anchor scroll owns the page
            if (namedAnchor()) return;
            const want = positions.get(current) || 0;
            to(want);
            nextFrame(() => { if (mine === ticket) to(want); });
            if (want > 0) later(() => { if (mine === ticket && scrollY() < want) to(want); }, retryMs);
        },
        size() { return positions.size; }
    };
}
