// Phone-width fixes (cto-team/plans/2026-11-25-phone-width-fixes.md, section 5): the My Account head stacks at 640 px
// and below, the proxy rows stack, the copy control copies text only, and no scene has a box or an unbroken run wider
// than the phone. Stylesheet checks read the real styles.css through test/helpers/phone-width.js; markup checks render
// the real lib/wallet-sections.js in happy-dom; scene checks parse the files tools/preview-scenes.mjs writes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { escapeHtml } from '../lib/html-escape.js';
import { declsAt, declsIn, declared, inherited, px, undrawn, RULES, mediaApplies, scenesAt375, walletScene } from './helpers/phone-width.js';

const S = await import('../lib/wallet-sections.js').then((m) => m, () => ({}));
const need = (name) => { assert.equal(typeof S[name], 'function', `lib/wallet-sections.js does not export ${name}`); return S[name]; };
const ME = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const D1 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const D2 = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
const M640 = '@media (max-width: 640px)';
const fmt = { pdex: (v) => Number(v || 0).toFixed(4), number: (n) => String(n), esc: escapeHtml, short: (a) => String(a).slice(0, 6) + '...', duration: (ms) => `${ms}ms` };
const dom = (html = '') => {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return { win, doc: win.document };
};
const frame = (over = {}) => {
    const sections = need('createWalletSections')({ doc: dom().doc, post: { subscribe: () => () => {} }, known: { list: () => [] }, data: () => null, setData() {}, fmt,
        payout: { tileHtml: () => '<div class="staking-summary-card" id="wallet-unpaid-tile"></div>' }, multisigName: () => null });
    const html = sections.frameHtml({ address: ME, identity: 'Alice', balance: { total: 1 }, staking: {}, rewards: {}, network: {} },
        { isOwn: true, help: '<span class="help-mark">?</span>', historyLink: `<a href="/staking-rewards/${ME}" class="item-link wallet-history-link">Full reward history</a>`, canSwitch: true, viewing: '', usd: '',
            bar: '<div id="wallet-action-bar"></div>', price: { history: [] }, latestPrice: null, ...over });
    return dom(`<div id="wallet-dashboard">${html}</div>`).doc;
};
const wait = () => new Promise(r => setTimeout(r, 0));

describe('T1 to T4: the stylesheet at 640 px and 360 px', () => {
    for (const width of [640, 360]) {
        test(`T1 at ${width}: the head stacks; the actions wrap; every control is 44 px tall`, () => {
            assert.equal(declsAt('#wsec-head .list-header', width)['flex-direction'], 'column', 'the head row does not stack');
            assert.equal(declsAt('.wallet-head-actions', width)['flex-wrap'], 'wrap', 'the actions do not wrap');
            // Switch wallet and Disconnect are now the secondary tier (spec 2026-11-25-multisig-and-advanced-cards.md, sweep rows 1, 2).
            assert.equal(declsAt('.wallet-head-actions .validate-secondary', width)['min-height'], '44px', 'Switch wallet and Disconnect are not 44 px');
            assert.equal(declsAt('.wallet-head-copy', width)['min-height'], '44px', 'Copy address is not 44 px');
        });
        test(`T3 at ${width}: the proxy table stacks into rows`, () => {
            assert.equal(declsAt('.proxy-table thead', width).display, 'none');
            assert.equal(declsAt('.proxy-table tr', width).display, 'grid');
            assert.equal(declsAt('.proxy-table tbody td', width).display, 'block');
            assert.equal(declsAt('.proxy-table .proxy-remove-btn', width).width, '100%');
            assert.equal(declsAt('.proxy-table .ui-chip', width)['white-space'], 'normal');
            assert.equal(declsAt('.proxy-label', width).display, 'block', 'the Type and Delay labels are not shown');
        });
    }
    test('T1b: the head does not stack above 640 px (desktop keeps one row)', () => {
        assert.notEqual(declsAt('#wsec-head .list-header', 641)['flex-direction'], 'column');
        assert.ok(declsIn('#wsec-head .list-header', M640)['flex-direction'], 'the stacking rule is not inside the 640 px block');
        assert.ok(declsIn('.wallet-head-actions', '').display, 'no base rule for .wallet-head-actions');
    });
    test('T2: the address wraps at every width (overflow-wrap: anywhere, no media)', () => {
        assert.equal(declsIn('.wallet-head-addr', '')['overflow-wrap'], 'anywhere');
    });
    test('T3b: the Type and Delay labels are hidden outside the 640 px block', () => {
        assert.equal(declsIn('.proxy-label', '').display, 'none');
        assert.equal(declsIn('.proxy-label', M640).display, 'block');
    });
    test('T4: no rule inside a max-width 640 px block gives a wallet-scene element a width or min-width above 375 px', () => {
        const scenes = scenesAt375().filter(s => s.id.startsWith('sections-'));
        assert.ok(scenes.length >= 4, 'the sections scenes were not built');
        const bad = [];
        for (const r of RULES) {
            if (!/^@media \(max-width: 640px\)$/.test(r.media)) continue;
            for (const p of ['width', 'min-width']) {
                const n = px(r.decls[p]);
                if (n == null || n <= 375) continue;
                for (const sel of r.selectors) for (const s of scenes) { try { if (s.doc.querySelector(sel)) bad.push(`${sel} { ${p}: ${r.decls[p]} } (${s.id})`); } catch (e) { /* a selector happy-dom cannot parse */ } }
            }
        }
        assert.deepEqual(bad, []);
    });
});

describe('T5 and T6: the head markup (frameHtml)', () => {
    test('T5: .wallet-head-actions holds the history link, Switch wallet, Disconnect, in that order; no inline style on it or the address block', () => {
        const doc = frame();
        const box = doc.querySelector('#wsec-head .list-header > .wallet-head-actions');
        assert.ok(box, 'no .wallet-head-actions directly inside .list-header');
        assert.deepEqual(Array.from(box.children).map(c => c.id || c.className), ['item-link wallet-history-link', 'wallet-switch-btn', 'wallet-disconnect-btn']);
        assert.ok(doc.querySelector('#wsec-head .list-header').classList.contains('wallet-head'));
        assert.equal(box.hasAttribute('style'), false, 'the actions wrapper keeps its inline style');
        const addr = doc.querySelector('#wsec-head .wallet-head-address');
        assert.ok(addr, 'no .wallet-head-address block');
        assert.equal(addr.hasAttribute('style'), false, 'the address block keeps its inline style');
        assert.equal(doc.querySelector('#wsec-head [style]'), null, 'an element in the head keeps an inline style');
        assert.ok(doc.querySelector('#wallet-viewing-slot'), 'the viewing slot went');
    });
    test('T5b: the history link is drawn full width on a phone by a rule that matches the real link', () => {
        const doc = frame();
        const link = doc.querySelector('.wallet-head-actions .wallet-history-link');
        assert.ok(link, 'no history link in the actions');
        assert.equal(declared(link, 'min-height', 360), '44px');
        assert.equal(declared(link, 'flex', 360), '1 0 100%');
    });
    test('T6: the address is shown in full as a link; the Copy address button sits beside it in a [data-address] row', () => {
        const doc = frame();
        const a = doc.querySelector('#wsec-head a.wallet-head-addr');
        assert.ok(a, 'no a.wallet-head-addr');
        assert.equal(a.textContent, ME);
        assert.equal(a.getAttribute('href'), `/account/${ME}`);
        assert.ok(a.classList.contains('item-link'));
        const btn = doc.getElementById('wallet-head-copy');
        assert.ok(btn, 'no #wallet-head-copy');
        assert.equal(btn.tagName, 'BUTTON');
        assert.equal(btn.getAttribute('type'), 'button');
        assert.ok(btn.closest(`[data-address="${ME}"]`), 'the button is not inside a [data-address] element');
        assert.equal(btn.querySelector('.wallet-head-copy-word').textContent, 'Copy address');
        assert.ok(btn.querySelector('.bx-copy'), 'no copy icon');
        // The neutral control is the secondary tier now (spec 2026-11-25, sweep row 3); the download-button class is gone.
        assert.ok(btn.classList.contains('validate-secondary') && !btn.classList.contains('staking-download-btn'), 'Copy address is not the neutral control');
        assert.equal(doc.querySelector('#wsec-head .list-header #wallet-head-copy'), null, 'the copy button is inside .list-header');
    });
});

describe('T7: bindHeadCopy copies text only', () => {
    const setup = (write) => {
        const doc = frame();
        const btn = doc.getElementById('wallet-head-copy');
        assert.ok(btn, 'no #wallet-head-copy to bind');
        const word = btn.querySelector('.wallet-head-copy-word');
        const icon = btn.querySelector('.bx');
        const said = [], writes = [], timers = [];
        need('bindHeadCopy')(btn, { write: (t) => { writes.push(t); return write(t); }, setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; }, announce: (t) => said.push(t) });
        return { btn, word, icon, said, writes, timers };
    };
    test('a click writes the full address, shows Copied for 1500 ms keeping the icon node, announces Address copied once, then restores', async () => {
        const w = setup(async () => {});
        w.btn.click();
        await wait();
        assert.deepEqual(w.writes, [ME]);
        assert.equal(w.word.textContent, 'Copied');
        assert.ok(w.btn.querySelector('.bx') === w.icon, 'the icon node was replaced');
        assert.ok(w.btn.querySelector('.wallet-head-copy-word') === w.word, 'the word node was replaced');
        assert.deepEqual(w.said, ['Address copied']);
        assert.equal(w.timers.length, 1);
        assert.equal(w.timers[0].ms, 1500);
        w.timers[0].f();
        assert.equal(w.word.textContent, 'Copy address');
        assert.deepEqual(w.said, ['Address copied']);
    });
    test('a rejected write changes nothing: the word, no announcement, no timer', async () => {
        const w = setup(async () => { throw new Error('denied'); });
        w.btn.click();
        await wait();
        assert.deepEqual(w.writes, [ME]);
        assert.equal(w.word.textContent, 'Copy address');
        assert.deepEqual(w.said, []);
        assert.equal(w.timers.length, 0);
    });
    test('a write that throws at once (no clipboard) changes nothing either', async () => {
        const w = setup(() => { throw new TypeError('no clipboard'); });
        w.btn.click();
        await wait();
        assert.equal(w.word.textContent, 'Copy address');
        assert.deepEqual(w.said, []);
    });
});

describe('T8: the proxy list markup (proxyListHtml)', () => {
    const payload = { proxies: [{ delegate: D1, proxyType: 'Staking', delay: 0 }, { delegate: D2, proxyType: 'Any', delay: 5 }], deposit: 2.5 };
    const list = (o) => dom(`<div id="l">${need('proxyListHtml')(payload, { ...fmt, ...o })}</div>`).doc;
    test('proxy-table, four proxy-cell-* cells per row, labels Type and Delay, no style attribute anywhere', () => {
        const doc = list({ isOwn: true });
        assert.ok(doc.querySelector('table.data-table.proxy-table'));
        assert.ok(doc.querySelector('.proxy-deposit'));
        const rows = Array.from(doc.querySelectorAll('tbody tr'));
        assert.equal(rows.length, 2);
        for (const r of rows) {
            assert.deepEqual(Array.from(r.children).map(c => c.className), ['proxy-cell-delegate', 'proxy-cell-type', 'proxy-cell-delay', 'proxy-cell-action']);
            assert.equal(r.querySelector('.proxy-cell-type > .proxy-label').textContent, 'Type');
            assert.equal(r.querySelector('.proxy-cell-delay > .proxy-label').textContent, 'Delay');
        }
        assert.equal(doc.querySelector('#l [style]'), null, 'an inline style is left');
        assert.ok(doc.querySelector('thead th.proxy-cell-delay'));
    });
    test('a settled row holds the Removed chip and no Remove button', () => {
        const doc = list({ isOwn: true, settling: new Map([[need('proxyKey')(D2, 'Any', 5), 4210377]]) });
        const row = doc.querySelectorAll('tbody tr')[1];
        const chip = row.querySelector('.ui-chip.is-positive');
        assert.match(chip.textContent.replace(/\s+/g, ' ').trim(), /^Removed in block #[\d,]+$/);
        assert.equal(row.querySelector('.proxy-remove-btn'), null);
    });
    test('a looked-up account: the action cell has no child nodes, so :empty holds', () => {
        const doc = list({ isOwn: false });
        for (const td of Array.from(doc.querySelectorAll('.proxy-cell-action'))) assert.equal(td.childNodes.length, 0, `action cell holds "${td.innerHTML}"`);
        assert.ok(doc.querySelector('.proxy-cell-action:empty'));
    });
});

describe('T10 to T13: every scene the tool builds', () => {
    test('T10: no visible element declares a width or min-width over the viewport, at 375 and at 320', () => {
        const scenes = scenesAt375();
        assert.ok(scenes.length >= 100, `only ${scenes.length} scenes were built`);
        const bad = new Map();
        for (const width of [375, 320]) {
            for (const r of RULES) {
                if (!mediaApplies(r.media, width)) continue;
                for (const p of ['width', 'min-width']) {
                    const n = px(r.decls[p]);
                    if (n == null || n <= width) continue;
                    for (const sel of r.selectors) {
                        if (sel.includes('::')) continue;
                        for (const s of scenes) {
                            let found = [];
                            try { found = Array.from(s.doc.querySelectorAll(sel)); } catch (e) { continue; }
                            if (found.some(el => declared(el, p, width) === r.decls[p] && !undrawn(el, width))) bad.set(`${width}px: ${sel} { ${p}: ${r.decls[p]} }`, (bad.get(`${width}px: ${sel} { ${p}: ${r.decls[p]} }`) || 0) + 1);
                        }
                    }
                }
            }
            for (const s of scenes) for (const el of Array.from(s.doc.querySelectorAll('[style]'))) {
                const st = el.getAttribute('style') || '';
                for (const m of st.matchAll(/(?:^|;)\s*(min-width|width)\s*:\s*([\d.]+)px/g)) if (Number(m[2]) > width && !undrawn(el, width)) bad.set(`${width}px: inline ${m[1]}: ${m[2]}px on <${el.tagName.toLowerCase()}> (${s.id})`, 1);
            }
        }
        assert.deepEqual(Array.from(bad.keys()), []);
    });
    const exempt = (el, width) => {
        for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
            if (['anywhere', 'break-word'].includes(declared(e, 'overflow-wrap', width)) || declared(e, 'word-wrap', width) === 'break-word') return true;
            if (['break-all', 'break-word'].includes(declared(e, 'word-break', width))) return true;
            if (declared(e, 'text-overflow', width) === 'ellipsis') return true;
            if (e.tagName === 'PRE' && ['auto', 'scroll'].includes(declared(e, 'overflow-x', width) || declared(e, 'overflow', width))) return true;
        }
        return false;
    };
    test('T11: no visible text holds an unbroken run of 30 characters or more unless it is allowed to wrap', () => {
        const hits = new Map();
        for (const width of [375, 320]) for (const s of scenesAt375()) {
            const walk = (node) => {
                if (node.nodeType === 3) {
                    const run = /\S{30,}/.exec(node.textContent);
                    const el = node.parentElement;
                    if (run && el && !['SCRIPT', 'STYLE', 'TITLE'].includes(el.tagName) && !undrawn(el, width) && !exempt(el, width)) {
                        const chain = [];
                        for (let e = el; e && e.nodeType === 1 && chain.length < 3; e = e.parentElement) chain.unshift(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''));
                        const key = `${width}px: ${chain.join(' > ')}  "${run[0].slice(0, 24)}..."`;
                        hits.set(key, (hits.get(key) || []).concat(s.id));
                    }
                    return;
                }
                for (const c of Array.from(node.childNodes)) walk(c);
            };
            walk(s.doc.body);
        }
        assert.deepEqual(Array.from(hits.entries()).map(([k, v]) => `${k}  [${v.length} scenes: ${v.slice(0, 3).join(', ')}]`), []);
    });
    test('T12: in the sections scenes no table inside #wallet-proxy-list resolves to display: table at 375', () => {
        const scenes = scenesAt375().filter(s => s.id.startsWith('sections-'));
        assert.ok(scenes.length >= 4);
        for (const s of scenes) {
            const tables = Array.from(s.doc.querySelectorAll('#wallet-proxy-list table'));
            assert.ok(tables.length >= 1, `${s.id}: no proxy table`);
            for (const t of tables) assert.notEqual(declared(t, 'display', 375) || 'table', 'table', `${s.id}: the proxy table is still display: table`);
        }
    });
    test('T13: #wsec-head exists in every wallet scene, account-*, r1-* and sections-* included', () => {
        const scenes = scenesAt375().filter(s => walletScene(s.id));
        assert.ok(scenes.length >= 12, `only ${scenes.length} wallet scenes`);
        const missing = scenes.filter(s => !s.doc.getElementById('wsec-head')).map(s => s.id);
        assert.deepEqual(missing, [], 'scenes drawn from a hand-written head, not the real frame');
    });
});
