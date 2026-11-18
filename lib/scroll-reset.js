// Scroll position across SPA navigations (cto-team/plans/2026-11-18-mobile-scroll-top.md).
export function shouldResetScroll() { return false; }
export function createScrollMemory() {
    return { boot() {}, beforeNavigate() { return null; }, afterNavigate() {}, beforePopstate() {}, afterPopstate() {} };
}
