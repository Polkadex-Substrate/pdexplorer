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
import { renderNodeGuide } from '../lib/validator-node-guide.js';
import { renderKeysPage } from '../lib/validator-status-view.js';
import { escapeHtml } from '../lib/html-escape.js';
import * as M from '../lib/validator-manage.js';

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// A happy-dom window whose scrollTo is recorded and whose scrollY is a stub.
// `maxY` plays a page too short for the wanted position (the browser clamps).
function world(path = '/blocks', retryMs = 5) {
    const win = new Window({ url: 'http://localhost' + path });
    const calls = [];
    const s = { y: 0, maxY: Infinity };
    win.scrollTo = (x, y) => { calls.push([x, y]); s.y = Math.min(y, s.maxY); };
    Object.defineProperty(win, 'scrollY', { get: () => s.y, configurable: true });
    Object.defineProperty(win, 'pageYOffset', { get: () => s.y, configurable: true });
    const frames = [];
    win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    const flush = () => { while (frames.length) frames.shift()(); };
    const mem = createScrollMemory({ win, retryMs });
    // An anchor element in the page; scrollIntoView is recorded (happy-dom has no layout).
    const shown = [];
    const anchor = (id) => {
        const el = win.document.createElement('h3'); el.id = id;
        el.scrollIntoView = (arg) => { shown.push({ id, el, arg }); };
        win.document.body.appendChild(el); return el;
    };
    // The router as script.js wires it.
    const go = (target, opts = {}) => {
        const state = mem.beforeNavigate(opts);
        win.history[opts.replace ? 'replaceState' : 'pushState'](state, '', '/' + target);
        mem.afterNavigate('/' + target, opts);
    };
    win.addEventListener('popstate', () => { mem.beforePopstate(); mem.afterPopstate(); });
    const back = async () => { win.history.back(); await tick(10); };
    const forward = async () => { win.history.forward(); await tick(10); };
    return { win, calls, s, flush, mem, go, back, forward, anchor, shown };
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

    test('a navigation to a #fragment scrolls the anchor to the top of the view and never to 0 (F1)', () => {
        const w = world(); w.mem.boot();
        w.s.y = 1800;
        const el = w.anchor('cors');
        w.go('developers#cors');
        assert.deepEqual(w.shown.map(x => [x.id, x.arg]), [['cors', { block: 'start' }]], 'the anchor is scrolled into view, block start');
        assert.deepEqual(w.calls, [], 'no scroll to the top when the anchor exists');
        w.flush();
        assert.ok(w.shown.every(x => x.el === el && x.arg.block === 'start'), 'a retry in the next frame, if any, goes to the same anchor');
        assert.deepEqual(w.calls, []);
    });

    test('a #fragment whose element is not there goes to the top, at once and again in the next frame (F1)', () => {
        const w = world(); w.mem.boot();
        w.s.y = 1800;
        w.go('validate/node#node-step-check');
        assert.deepEqual(w.calls, [[0, 0]], 'at once');
        assert.deepEqual(w.shown, []);
        w.flush();
        assert.deepEqual(w.calls, [[0, 0], [0, 0]], 'and once more after the render');
    });

    test('an anchor that the render adds after the push is found on the next frame (F1)', () => {
        const w = world(); w.mem.boot();
        w.go('validate/node#node-step-check');
        w.anchor('node-step-check');
        w.flush();
        assert.deepEqual(w.shown.map(x => x.id), ['node-step-check']);
        assert.deepEqual(w.shown[0].arg, { block: 'start' });
    });

    test('an encoded fragment is decoded before the lookup (F1)', () => {
        const w = world(); w.mem.boot();
        w.anchor('step one');
        w.go('guide#step%20one');
        assert.deepEqual(w.shown.map(x => x.id), ['step one']);
    });

    test('an empty fragment ("#") goes to the top (F1)', () => {
        const w = world(); w.mem.boot();
        w.s.y = 500;
        w.go('guide#');
        assert.deepEqual(w.calls, [[0, 0]]);
    });

    test('a replace to a #fragment never scrolls, anchor or not (F1)', () => {
        const w = world(); w.mem.boot();
        w.anchor('cors');
        w.go('developers#cors', { replace: true });
        w.flush();
        assert.deepEqual(w.calls, []);
        assert.deepEqual(w.shown, []);
    });

    test('the reader scrolling before the next frame stops the retry (F1)', () => {
        const w = world(); w.mem.boot();
        w.go('validate/node#node-step-check');
        w.win.dispatchEvent(new w.win.Event('wheel'));
        w.anchor('node-step-check');
        w.flush();
        assert.deepEqual(w.shown, []);
        assert.deepEqual(w.calls, [[0, 0]], 'only the first, immediate scroll');
    });

    test('each pushed entry gets its own key; a replace keeps the entry\'s existing state (and its key)', () => {
        const w = world(); w.mem.boot();
        const a = w.mem.beforeNavigate({}), b = w.mem.beforeNavigate({});
        assert.ok(a && typeof a.scrollKey === 'string' && a.scrollKey.length > 0);
        assert.notEqual(a.scrollKey, b.scrollKey);
        assert.equal(w.mem.beforeNavigate({ replace: true }), null, 'an entry with no state stays without');
        w.win.history.pushState(a, '', '/a');
        assert.deepEqual(w.mem.beforeNavigate({ replace: true }), a, 'a keyed entry keeps its key through a replace');
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
describe('the validator links that end in a node guide #fragment land on it (F1)', () => {
    // The two real hrefs: "Check my node" (manage panel, offline) and the keys page's "Session keys in the node guide".
    const checkHref = M.manageMenu('active', { offline: true }).primary.href;
    const keysHtml = renderKeysPage({ params: { layout: { ok: true } }, esc: escapeHtml });
    const keysHref = (/href="(\/validate\/node#[^"]+)"/.exec(keysHtml) || [])[1];
    for (const [name, href] of [['Check my node', checkHref], ['the keys page link', keysHref]]) {
        test(name + ': following it in the app scrolls the guide section into view', () => {
            assert.match(String(href), /^\/validate\/node#node-step-/, 'the href is a node guide step');
            const w = world('/validate'); w.mem.boot();
            w.s.y = 1500;
            // The guide is on the page when the link is followed; its step headings carry the ids.
            w.win.document.body.innerHTML = renderNodeGuide({ esc: escapeHtml, helpIcon: () => '' });
            const id = href.split('#')[1];
            const el = w.win.document.getElementById(id);
            assert.ok(el, 'the id exists in the guide: ' + id);
            const seen = [];
            el.scrollIntoView = (arg) => { seen.push(arg); };
            w.go(href.slice(1));
            assert.deepEqual(seen, [{ block: 'start' }], 'the section is scrolled to the top of the view');
            assert.deepEqual(w.calls, [], 'and the page is not sent to 0');
        });
    }
});

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

describe('review round: anchors, user scroll, replaceState, reload', () => {
    test('1: Back or Forward onto a #fragment entry that names an element does not restore over the smooth anchor scroll; an unknown fragment still restores', async () => {
        const w = world('/blocks'); w.mem.boot();
        w.win.document.body.innerHTML = '<h2 id="cors">x</h2>';
        w.s.y = 300; w.go('blocks#cors'); w.s.y = 800; w.go('other');
        w.calls.length = 0;
        await w.back(); w.flush();
        assert.equal(w.win.location.hash, '#cors');
        assert.deepEqual(w.calls, [], 'the anchor scroll is left alone');
        w.go('other2'); w.go('blocks#nothere'); w.s.y = 640; w.go('other3');
        w.calls.length = 0;
        await w.back(); w.flush();
        assert.deepEqual(w.calls[0], [0, 640], 'a fragment with no element is restored as before');
    });

    test('2: a pending retry is cancelled by a wheel, touch or scroll key, not by other keys', async () => {
        for (const [type, init, cancels] of [['wheel', {}, true], ['touchmove', {}, true], ['keydown', { key: 'PageDown' }, true], ['keydown', { key: 'a' }, false]]) {
            const w = world('/blocks', 80); w.mem.boot();
            w.s.y = 1000; w.go('b'); w.s.y = 0; w.s.maxY = 100;
            await w.back(); w.flush();
            w.calls.length = 0;
            w.win.dispatchEvent(type === 'keydown' ? new w.win.KeyboardEvent(type, init) : new w.win.Event(type, init));
            await tick(150);
            assert.equal(w.calls.some(c => c[1] === 1000), !cancels, type + ' ' + (init.key || ''));
        }
    });

    test('3: replaceState keeps the scroll key, so Forward after a replace still finds its position', async () => {
        const w = world('/blocks'); w.mem.boot();
        w.s.y = 700; w.go('wallet'); w.s.y = 50;
        w.go('wallet/abc', { replace: true });
        assert.ok(w.win.history.state && w.win.history.state.scrollKey, 'the key survived the replace');
        w.go('x'); await w.back(); await w.back();
        w.calls.length = 0; await w.forward(); w.flush();
        assert.deepEqual(w.calls[0], [0, 50]);
    });

    test('3b: script.js never rewrites an entry with a null state', () => {
        const src = stripComments(readRepo('script.js', import.meta.url));
        assert.doesNotMatch(src, /replaceState\(\s*null/);
        assert.doesNotMatch(src, /replaceState\(\s*\{\}/);
    });

    test('4: positions survive a reload through sessionStorage, bounded to 50, and a throwing storage is harmless', () => {
        const w = world('/blocks'); w.mem.boot();
        w.s.y = 900; w.go('b'); w.s.y = 10; w.go('c');
        const w2 = createScrollMemory({ win: w.win });
        assert.ok(w2.size() >= 2, 'a new module on the same tab starts with the saved positions');
        const many = world('/blocks'); many.mem.boot();
        for (let i = 0; i < 70; i++) { many.s.y = i; many.go('p' + i); }
        const saved = JSON.parse(many.win.sessionStorage.getItem('pdex-scroll-v1'));
        assert.equal(saved.length, 50);
        const broken = world('/blocks');
        Object.defineProperty(broken.win, 'sessionStorage', { get() { throw new Error('blocked'); } });
        const m = createScrollMemory({ win: broken.win }); m.boot(); m.beforeNavigate({}); m.beforePopstate(); m.afterPopstate();
        assert.ok(m.size() >= 0);
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
    test('the Validate routes (origin/main 9df2ee1) reset and restore like any other: sidebar in, node guide link, Back', async () => {
        const r = await page({ path: 'blocks', seed: { pdex_validate_enabled: '1' }, scrollLog: true, steps: [
            { setScroll: 2400 }, { click: '#nav-validate' }, { setScroll: 300 }, { click: 'a[href="/validate/node"]' }, { back: true }, { back: true }] });
        assert.equal(r.steps[1].path, '/validate');
        assert.deepEqual(r.steps[1].scrollCalls.slice(0, 2), [[0, 0], [0, 0]], 'into /validate at the top');
        assert.equal(r.steps[3].path, '/validate/node');
        assert.deepEqual(r.steps[3].scrollCalls.slice(0, 2), [[0, 0], [0, 0]], 'into the node guide at the top');
        assert.equal(r.steps[4].path, '/validate');
        assert.deepEqual(r.steps[4].scrollCalls[0], [0, 300], 'Back to where /validate was left');
        assert.equal(r.steps[5].path, '/blocks');
        assert.deepEqual(r.steps[5].scrollCalls[0], [0, 2400]);
    });
});
