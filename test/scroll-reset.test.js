// Scroll position across SPA navigations (cto-team/plans/2026-11-18-mobile-scroll-top.md).
//
// The window is the page's scroller and navigateTo() suppresses the browser's
// own "new page starts at the top", so nothing reset the scroll: a link tapped at
// the bottom of a long list opened the next page at the bottom. lib/scroll-reset.js
// owns the decision and the per-entry memory; script.js wires it into navigateTo,
// popstate and bootSeoRouter.
//
// What these tests can see: the scrollTo calls, scrollRestoration and the restored
// value per history entry (happy-dom has no layout, so scrollY is a stub that the
// page "clamps" when told to). What they cannot: real layout height, iOS rubber
// banding, Safari's own restoration timing. Those are the manual iPhone checks in
// the spec.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { shouldResetScroll, createScrollMemory } from '../lib/scroll-reset.js';
import { readRepo, bodyOf, stripComments } from './helpers/source.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// A happy-dom window whose scrollTo is recorded and whose scrollY is a stub.
// `maxY` plays a page too short for the wanted position (the browser clamps).
function world(path = '/blocks') {
    const win = new Window({ url: 'http://localhost' + path });
    const calls = [];
    const s = { y: 0, maxY: Infinity };
    win.scrollTo = (x, y) => { calls.push([x, y]); s.y = Math.min(y, s.maxY); };
    Object.defineProperty(win, 'scrollY', { get: () => s.y, configurable: true });
    Object.defineProperty(win, 'pageYOffset', { get: () => s.y, configurable: true });
    const frames = [];
    win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    const flush = () => { while (frames.length) frames.shift()(); };
    const mem = createScrollMemory({ win, retryMs: 5 });
    // The router as script.js wires it.
    const go = (target, opts = {}) => {
        const state = mem.beforeNavigate(opts);
        win.history[opts.replace ? 'replaceState' : 'pushState'](state, '', '/' + target);
        mem.afterNavigate('/' + target, opts);
    };
    win.addEventListener('popstate', () => { mem.beforePopstate(); mem.afterPopstate(); });
    const back = async () => { win.history.back(); await tick(10); };
    const forward = async () => { win.history.forward(); await tick(10); };
    return { win, calls, s, flush, mem, go, back, forward };
}

describe('shouldResetScroll', () => {
    test('a pushed navigation without a fragment resets; a replace or a #fragment does not', () => {
        assert.equal(shouldResetScroll('/block/5'), true);
        assert.equal(shouldResetScroll('/blocks', { replace: false }), true);
        assert.equal(shouldResetScroll('/', {}), true);
        assert.equal(shouldResetScroll('/wallet/x', { replace: true }), false);
        assert.equal(shouldResetScroll('/developers#cors'), false);
        assert.equal(shouldResetScroll('/developers#cors', { replace: true }), false);
    });
});

describe('createScrollMemory', () => {
    test('boot sets history.scrollRestoration to manual and does not scroll', () => {
        const w = world();
        assert.equal(w.win.history.scrollRestoration, 'auto');
        w.mem.boot();
        w.flush();
        assert.equal(w.win.history.scrollRestoration, 'manual');
        assert.deepEqual(w.calls, []);
    });

    test('a pushed navigation scrolls to the top at once and again in the next frame', () => {
        const w = world(); w.mem.boot();
        w.s.y = 1800;
        w.go('block/5');
        assert.deepEqual(w.calls, [[0, 0]], 'at once, after routeTo');
        w.flush();
        assert.deepEqual(w.calls, [[0, 0], [0, 0]], 'and once more after the render settles');
    });

    test('a replace navigation (legacy hops, /wallet -> /wallet/<addr>) never scrolls', () => {
        const w = world('/wallet'); w.mem.boot();
        w.s.y = 600;
        w.go('wallet/abc', { replace: true });
        w.flush();
        assert.deepEqual(w.calls, []);
    });

    test('a navigation to a #fragment leaves the scroll to the anchor', () => {
        const w = world(); w.mem.boot();
        w.go('developers#cors');
        w.flush();
        assert.deepEqual(w.calls, []);
    });

    test('each pushed entry gets its own key; a replace keeps no key (null state, as before)', () => {
        const w = world(); w.mem.boot();
        const a = w.mem.beforeNavigate({}), b = w.mem.beforeNavigate({});
        assert.ok(a && typeof a.scrollKey === 'string' && a.scrollKey.length > 0);
        assert.notEqual(a.scrollKey, b.scrollKey);
        assert.equal(w.mem.beforeNavigate({ replace: true }), null);
    });

    test('Back restores the position the entry was left at, and Forward restores the next one', async () => {
        const w = world('/blocks'); w.mem.boot();
        w.s.y = 1200;
        w.go('block/5');                     // leaves /blocks at 1200
        w.flush();
        w.s.y = 300;                         // reads the block page down to 300
        w.calls.length = 0;
        await w.back();
        assert.equal(w.win.location.pathname, '/blocks');
        assert.deepEqual(w.calls[0], [0, 1200], 'back to the list where it was left');
        w.flush();
        assert.equal(w.s.y, 1200);
        w.calls.length = 0;
        await w.forward();
        assert.equal(w.win.location.pathname, '/block/5');
        assert.deepEqual(w.calls[0], [0, 300], 'forward to the block page where it was left');
    });

    test('the same URL twice in history keeps two positions (per entry, not per path)', async () => {
        const w = world('/blocks'); w.mem.boot();
        w.go('block/5'); w.s.y = 100;
        w.go('blocks'); w.s.y = 900;
        w.go('block/5'); w.s.y = 50;
        await w.back();                      // second /blocks entry
        assert.equal(w.s.y, 900);
        await w.back();                      // first /block/5 entry
        assert.equal(w.win.location.pathname, '/block/5');
        assert.equal(w.s.y, 100);
    });

    test('an entry with no saved position (the page the tab opened on, after a reload) goes to the top', async () => {
        const w = world('/blocks');
        w.win.history.pushState(null, '', '/block/9');   // an entry this session never saw
        w.mem.boot();
        w.s.y = 700;
        w.win.history.pushState(null, '', '/block/10');
        w.calls.length = 0;
        w.win.dispatchEvent(new w.win.PopStateEvent('popstate', { state: null }));
        assert.deepEqual(w.calls[0], [0, 0]);
    });

    test('when the page is still too short to reach the saved position, one retry follows; none after the user moves on', async () => {
        const w = world('/blocks'); w.mem.boot();
        w.s.y = 1500;
        w.go('block/5'); w.flush();
        w.s.maxY = 400;                      // the list has not loaded yet
        await w.back();
        assert.equal(w.s.y, 400, 'clamped on the first try');
        w.s.maxY = Infinity;                 // the rows arrive
        w.flush();
        await tick(20);
        assert.equal(w.s.y, 1500, 'the retry reaches the saved place');

        // A second time, but the user taps a link before the retry fires.
        w.go('block/6'); w.flush();
        w.s.maxY = 400;
        await w.back();
        w.s.maxY = Infinity;
        w.go('block/7');
        w.calls.length = 0;
        w.flush();
        await tick(20);
        assert.deepEqual(w.calls.filter(c => c[1] !== 0), [], 'no stale restore after the next navigation');
    });

    test('the memory is bounded', () => {
        const win = new Window({ url: 'http://localhost/' });
        win.scrollTo = () => {};
        win.requestAnimationFrame = () => 0;
        const mem = createScrollMemory({ win, max: 5 });
        mem.boot();
        for (let i = 0; i < 40; i++) { const st = mem.beforeNavigate({}); win.history.pushState(st, '', '/p' + i); mem.afterNavigate('/p' + i, {}); }
        assert.ok(mem.size() <= 5, 'kept ' + mem.size());
    });

    test('a window without scrollRestoration or requestAnimationFrame still works (older browsers, sandboxes)', () => {
        const calls = [];
        const timers = [];
        const win = { location: { pathname: '/a', search: '' }, history: { state: null }, scrollY: 0, scrollTo: (x, y) => calls.push([x, y]), setTimeout: (fn) => timers.push(fn) };
        const mem = createScrollMemory({ win });
        mem.boot();
        mem.afterNavigate('/b', {});
        timers.forEach(f => f());
        assert.deepEqual(calls, [[0, 0], [0, 0]]);
    });
});

// script.js wiring: navigateTo, popstate and boot use the module; the other
// routeTo callers (boot, the wallet-change re-render) must not scroll.
describe('script.js wiring', () => {
    const SCRIPT = readRepo('script.js', import.meta.url);
    const code = stripComments(SCRIPT);

    test('navigateTo asks the memory for the pushed state, routes, then resets', () => {
        const body = stripComments(bodyOf(SCRIPT, 'navigateTo'));
        assert.match(body, /scrollMemory\.beforeNavigate\(\{ replace \}\)/);
        assert.match(body, /history\[fn\]\(\w+, '', newPath \|\| '\/'\)/, 'the state from beforeNavigate is what is pushed');
        const r = body.indexOf('routeTo('), a = body.indexOf('scrollMemory.afterNavigate(newPath, { replace })');
        assert.ok(r > 0 && a > r, 'afterNavigate runs after routeTo');
    });

    test('popstate saves before routing and restores after; boot sets manual restoration first', () => {
        const boot = stripComments(bodyOf(SCRIPT, 'bootSeoRouter'));
        assert.ok(boot.indexOf('scrollMemory.boot()') >= 0 && boot.indexOf('scrollMemory.boot()') < boot.indexOf("addEventListener('popstate'"));
        const pop = boot.slice(boot.indexOf("addEventListener('popstate'"));
        const b = pop.indexOf('scrollMemory.beforePopstate()'), r = pop.indexOf('routeTo('), a = pop.indexOf('scrollMemory.afterPopstate()');
        assert.ok(b >= 0 && r > b && a > r, 'before, routeTo, after');
    });

    test('every direct routeTo caller is accounted for, and only navigateTo and popstate touch the scroll', () => {
        const callers = [...code.matchAll(/routeTo\(/g)].length;
        // function routeTo( itself, navigateTo, popstate, init's first route, onWalletChanged's re-render
        assert.equal(callers, 5, 'a new routeTo caller: decide whether it is a user navigation (go through navigateTo) or a re-render');
        assert.equal([...code.matchAll(/scrollMemory\.afterNavigate\(/g)].length, 1);
        assert.equal([...code.matchAll(/scrollMemory\.afterPopstate\(/g)].length, 1);
        assert.doesNotMatch(stripComments(bodyOf(SCRIPT, 'routeTo')), /scrollTo|scrollMemory/, 'routeTo itself never scrolls (boot, replace hops and re-renders call it)');
        assert.doesNotMatch(stripComments(bodyOf(SCRIPT, 'onWalletChanged')), /scrollTo|scrollMemory/);
    });
});

// The real page: index.html and script.js in happy-dom (test/helpers/full-page.js).
const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify(scenario)], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

describe('the real page', () => {
    test('load does not scroll; a sidebar link tapped low on the page opens the next page at the top; Back returns to the place', async () => {
        const r = await page({ path: 'blocks', scrollLog: true, steps: [{ setScroll: 2400 }, { click: 'a.nav-item[href="/validators"]' }, { setScroll: 150 }, { back: true }] });
        assert.equal(r.scroll.restoration, 'manual');
        assert.deepEqual(r.scroll.atLoad, [], 'nothing scrolled while the page booted');
        assert.equal(r.steps[1].path, '/validators');
        assert.deepEqual(r.steps[1].scrollCalls.slice(0, 2), [[0, 0], [0, 0]], 'the tap reset to the top, then once more in the next frame');
        assert.equal(r.steps[3].path, '/blocks');
        assert.deepEqual(r.steps[3].scrollCalls[0], [0, 2400], 'Back went to where the list was left');
    });
});
