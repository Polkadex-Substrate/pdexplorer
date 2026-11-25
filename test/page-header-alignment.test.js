// Page head and tabs on one left edge (plan cto-team/plans/2026-11-25-page-header-alignment.md): the shared
// pageHeadHtml and tabsHtml (lib/ui-parts.js), the ui-page-head CSS, and the pages that use them: Treasury,
// Democracy, Council, Active Validators and the Account details tab row. T1 to T15 of section 5 of the plan, a
// reproduction of the "Spends looks white" report (a hovered inactive tab), the reveal of the active tab at 375, and
// the `heads` preview scenes. Pages are the real script.js and index.html (test/helpers/full-page.js), the cascade is
// the real styles.css read through test/helpers/phone-width.js. No strings change.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAddress } from '@polkadot/util-crypto';
import { SPEND_RULE_TEXT } from '../lib/treasury-spend.js';
import { createSpendMotionUI } from '../lib/treasury-spend-view.js';
import * as UI from '../lib/ui-parts.js';
import { RULES, declsAt, declared, px } from './helpers/phone-width.js';
import { runPage, parse, withHoverTwins, treasuryApi, democracyApi, councilApi, accountApi, tabSteps, ACCOUNT, INDEX_HTML, STYLES_CSS } from './helpers/head-page.js';
import { readRepo, bodyOf, stripComments } from './helpers/source.js';

const SCRIPT = stripComments(readRepo('script.js', import.meta.url));
const kids = (el) => Array.from(el.children);
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const settle = { setScroll: 0, wait: 150 };

// One page load per page, shared by the tests below. dumps[] holds what each { dump } step captured, in order.
const pages = {};
before(async () => {
    const [treasury, democracy, council, account, validatorsOff, validatorsOn] = await Promise.all([
        // 0: #treasury-content, 1: the card, then the tab row after a click on each of five tabs
        runPage({ path: 'treasury', api: treasuryApi(), steps: [settle, { dump: '#treasury-content' }, { dump: '#treasury-content .list-container' },
            ...tabSteps(['proposals', 'approved', 'history', 'spends', 'overview'], 'data-treastab', '#treasury-content .account-tabs')] }),
        // 0: the card, 1: the tab row at load, then after a click on each of four tabs
        runPage({ path: 'democracy', api: democracyApi(), steps: [settle, { dump: '#democracy-content .list-container' }, { dump: '#democracy-content .account-tabs' },
            ...tabSteps(['referenda', 'proposals', 'statistics', 'overview'], 'data-demtab', '#democracy-content .account-tabs')] }),
        runPage({ path: 'council', api: councilApi(), steps: [settle, { dump: '.council-page .account-tabs' },
            ...tabSteps(['council-motions', 'council-tc', 'council-members'], 'data-tab', '.council-page .account-tabs')] }),
        runPage({ path: 'account/' + ACCOUNT, api: accountApi(), steps: [settle, { dump: '#account-details-container .account-tabs' },
            ...tabSteps(['events', 'transactions'], 'data-account-tab', '#account-details-container .account-tabs')] }),
        runPage({ path: 'validators', probe: ['.validators-page .ui-page-head-actions'], steps: [settle] }),
        runPage({ path: 'validators', seed: { pdex_validate_enabled: '1' }, probe: ['.validators-page .ui-page-head-actions'], steps: [settle] })
    ]);
    Object.assign(pages, { treasury, democracy, council, account, validatorsOff, validatorsOn });
});

// The tab rows of each page: the one at load, then the one after each click.
const tabRows = {
    Treasury: () => [parse(pages.treasury.dumps[0]).document.querySelector('.account-tabs').outerHTML, ...pages.treasury.dumps.slice(2)],
    Democracy: () => pages.democracy.dumps.slice(1),
    Council: () => pages.council.dumps,
    Account: () => pages.account.dumps
};
const card = () => parse(pages.treasury.dumps[1]).document.querySelector('.list-container');   // the real Treasury card
const head = (doc) => doc.querySelector('.list-header');

// ── 5.1 the parsed stylesheet ──
describe('the stylesheet: one head, one edge, quiet tabs', () => {
    test('T1: .ui-page-head is a left aligned column at 1280 and 375; nothing space-between reaches the Treasury head', () => {
        const h = head(card().ownerDocument);
        assert.ok(h.classList.contains('ui-page-head'), 'Treasury: the card head has no class ui-page-head: ' + h.className);
        for (const w of [1280, 375]) {
            assert.equal(declared(h, 'flex-direction', w), 'column', `Treasury head at ${w}: flex-direction`);
            assert.equal(declared(h, 'align-items', w), 'flex-start', `Treasury head at ${w}: align-items`);
            assert.notEqual(declared(h, 'justify-content', w), 'space-between', `Treasury head at ${w}: justify-content`);
        }
    });

    // The left edge of each part, from the declarations: padding-left, with var(--page-gutter) read from the nearest ancestor that sets it.
    const gutter = (el, w) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const v = declared(e, '--page-gutter', w); if (v != null) return v; } return null; };
    const len = (v) => (String(v).trim() === '0' ? 0 : px(v));
    const padLeft = (el, w) => {
        const resolve = (v) => (/^var\(--page-gutter\)$/.test(String(v).trim()) ? len(gutter(el, w)) : len(v));
        const long = declared(el, 'padding-left', w);
        if (long != null) return resolve(long);
        const sh = declared(el, 'padding', w);
        if (sh == null) return 0;
        const t = sh.trim().split(/\s+/);
        return resolve(t.length === 1 ? t[0] : t.length === 4 ? t[3] : t[1]);
    };
    const inlineMarginLeft = (el, w) => {
        const m = /(?:^|;)\s*margin\s*:\s*([^;]+)/.exec(el.getAttribute('style') || '');
        if (m) { const t = m[1].trim().split(/\s+/); return len(t.length === 1 ? t[0] : t.length === 4 ? t[3] : t[1]); }
        return len(declared(el, 'margin-left', w) || '0') || 0;
    };
    for (const w of [1280, 375]) {
        test(`T2: at ${w} the head, the first tab label and the body start on one edge, and a tab has no side padding`, () => {
            const c = card();
            const h = head(c.ownerDocument), tabs = c.querySelector('.account-tabs'), tab = c.querySelector('.account-tab'), body = c.lastElementChild;
            const label = padLeft(tabs, w) + padLeft(tab, w) + inlineMarginLeft(tabs, w);
            assert.equal(padLeft(tab, w), 0, `Treasury tab "${txt(tab)}" at ${w}: padding-left`);
            assert.equal(padLeft(h, w), label, `Treasury at ${w}: the head starts at ${padLeft(h, w)} px, the first tab label at ${label} px`);
            assert.equal(padLeft(body, w), padLeft(h, w), `Treasury at ${w}: the body starts at ${padLeft(body, w)} px, the head at ${padLeft(h, w)} px`);
        });
    }

    test('T3: hover never changes a tab label colour; the hover rules sit inside (hover: hover) and skip the selected tab', () => {
        const hover = RULES.filter(r => r.selectors.some(s => /\.account-tab(?![-\w])/.test(s) && /:hover/.test(s)));
        assert.ok(hover.length > 0, 'no hover rule for .account-tab at all (expected a neutral underline)');
        for (const r of hover) {
            assert.equal(r.decls.color, undefined, `styles.css line ${r.line}: ${r.selectors.join(', ')} sets color on hover`);
            assert.match(r.media, /@media \(hover: hover\)/, `styles.css line ${r.line}: ${r.selectors.join(', ')} is outside (hover: hover)`);
            assert.ok(r.selectors.every(s => s.includes(':not(.active)')), `styles.css line ${r.line}: ${r.selectors.join(', ')} also hits the selected tab`);
            assert.match(String(r.decls['border-bottom-color']), /^rgba\(255, ?255, ?255, ?0?\.24\)$/, `styles.css line ${r.line}: the hover underline is not the neutral one`);
        }
    });

    test('T4: the selected tab is white text with the pink underline; no .account-tab rule paints text pink', () => {
        const a = declsAt('.account-tab.active', 1280);
        assert.equal(a.color, 'var(--text-primary)', '.account-tab.active color');
        assert.equal(a['border-bottom-color'], 'var(--brand-primary)', '.account-tab.active border-bottom-color');
        for (const r of RULES) for (const s of r.selectors) {
            if (/(^|[\s>])\.account-tab(?![-\w])/.test(s)) assert.notEqual(r.decls.color, 'var(--brand-primary)', `styles.css line ${r.line}: ${s} paints the label pink`);
        }
    });

    test('T5: a tab is 44 px high and the tab row scrolls sideways at 375', () => {
        assert.equal(declsAt('.account-tab', 1280)['min-height'], '44px', '.account-tab min-height');
        assert.equal(declsAt('.account-tabs', 375)['overflow-x'], 'auto', '.account-tabs overflow-x at 375');
    });

    test('T6: the new rules name no --text-muted and no colour outside the kit', () => {
        assert.ok(RULES.some(r => r.selectors.includes('.ui-page-head')), 'no .ui-page-head rule: the block is missing');
        assert.ok(RULES.some(r => r.selectors.includes('.ui-page-head-meta')), 'no .ui-page-head-meta rule');
        assert.ok(RULES.some(r => r.selectors.some(s => s.startsWith('.ui-action.is-unavailable'))), 'no .ui-action.is-unavailable rule');
        const mine = RULES.filter(r => r.selectors.some(s => /ui-page-head|ui-page-body|\.account-tab|\.ui-action\.is-unavailable/.test(s)));
        for (const r of mine) for (const [prop, v] of Object.entries(r.decls)) {
            assert.ok(!/--text-muted/.test(v), `styles.css line ${r.line}: ${r.selectors.join(', ')} { ${prop} } uses --text-muted`);
            if (/mask/.test(prop)) continue;
            const hues = (v.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || []).filter(c => !/^rgba\(255, ?255, ?255, ?[\d.]+\)$/.test(c));
            assert.deepEqual(hues, [], `styles.css line ${r.line}: ${r.selectors.join(', ')} { ${prop} } has a colour outside the kit`);
        }
    });

    test('T7: an unavailable action is outlined at full opacity and the rule comes after the 0.55 dim', () => {
        const dim = RULES.find(r => r.selectors.includes('.ui-action[aria-disabled="true"]:not([aria-busy="true"])'));
        const un = RULES.find(r => r.selectors.includes('.ui-action.is-unavailable[aria-disabled="true"]'));
        assert.ok(un, 'no rule for .ui-action.is-unavailable[aria-disabled="true"]');
        assert.equal(un.decls.opacity, '1');
        assert.ok(un.order > dim.order, `the unavailable rule (line ${un.line}) comes before the dim (line ${dim.line}) and loses`);
    });
});

// ── the "Spends looks white" report, reproduced in a hover scene ──
describe('a hovered inactive tab is not a second selected tab (the CEO report)', () => {
    const win = () => parse(pages.treasury.dumps[0], { css: withHoverTwins(STYLES_CSS) });
    const colour = (w, el) => w.getComputedStyle(el).color;
    test('Treasury, Overview selected, pointer on Spends: every inactive tab keeps one colour', () => {
        const w = win();
        const tabs = Array.from(w.document.querySelectorAll('#treasury-content .account-tab'));
        tabs.find(t => t.getAttribute('data-treastab') === 'spends').classList.add('pv-hover');
        const inactive = tabs.filter(t => !t.classList.contains('active'));
        const colours = inactive.map(t => `${t.getAttribute('data-treastab')}=${colour(w, t)}`);
        assert.equal(new Set(inactive.map(t => colour(w, t))).size, 1, 'an inactive tab differs from the other inactive tabs: ' + colours.join(' '));
    });
    test('the selected tab label is --text-primary with the pink underline', () => {
        const w = win();
        const sel = Array.from(w.document.querySelectorAll('#treasury-content .account-tab')).find(t => t.classList.contains('active'));
        assert.equal(colour(w, sel).toUpperCase(), '#FFFFFF', 'Treasury: the selected tab label is not --text-primary: ' + colour(w, sel));
        assert.equal(w.getComputedStyle(sel).borderBottomColor.toUpperCase(), '#E6007A', 'Treasury: the selected tab underline');
    });
});

// ── 5.2 rendered markup ──
describe('Treasury head', () => {
    test('T8: the head is the shared part, in order, with the help link beside the title and no inline style', () => {
        const c = card();
        const h = c.firstElementChild;
        assert.ok(h.classList.contains('list-header') && h.classList.contains('ui-page-head'), 'Treasury: the card\'s first child is not .list-header.ui-page-head: ' + h.className);
        assert.deepEqual(kids(h).map(k => k.className.split(' ')[0] + (k.id ? '#' + k.id : '')), ['ui-page-head-title', 'ui-page-head-meta', 'ui-page-head-actions#treasury-spend-action'], 'Treasury head children');
        const title = h.querySelector('.ui-page-head-title');
        assert.equal(txt(title.querySelector('h2')), 'Treasury');
        const help = title.querySelector('a[href="/help/treasury"]');
        assert.ok(help && !title.querySelector('h2').contains(help) && !h.querySelector('.ui-page-head-meta').contains(help), 'Treasury: the help link is not a sibling of the h2 in the title row');
        assert.deepEqual(kids(h.querySelector('.ui-page-head-meta')).map(txt), ['87 lifetime proposals', SPEND_RULE_TEXT]);
        assert.equal(h.querySelectorAll('[style]').length + c.querySelectorAll('.account-tabs [style], .account-tabs[style]').length, 0, 'Treasury: a style attribute in the head or the tab row');
    });
    test('T9: the two hooks gov-post-action.js uses still resolve', () => {
        const doc = parse(pages.treasury.dumps[0]).document;
        assert.equal(txt(doc.querySelector('#treasury-content .list-header h2')), 'Treasury');
        assert.ok(doc.querySelector('#treasury-content .list-container').firstElementChild.classList.contains('list-header'));
    });
});

describe('Propose a spend', () => {
    const A = encodeAddress(new Uint8Array(32).fill(1), 88), B = encodeAddress(new Uint8Array(32).fill(2), 88), OUT = encodeAddress(new Uint8Array(32).fill(8), 88);
    const tick = () => new Promise(r => setImmediate(r));
    const API = { registry: { chainDecimals: [12] } };
    async function world({ selected = A, api = API, read }) {
        const win = parse('');
        win.document.write(INDEX_HTML);
        const doc = win.document;
        const slot = doc.createElement('div'); doc.body.appendChild(slot);
        const ui = createSpendMotionUI({ api: () => api, selected: () => selected, isMultisig: () => false, submit: async () => {}, connectPrompt: () => '<a>Connect wallet</a>', document: doc,
            motion: { readSeats: read, readHead: async () => 1000, build: () => ({}), decode: () => ({}) } });
        ui.mount(slot); await tick(); await tick();
        return { doc, slot, btn: slot.querySelector('#treasury-spend-open'), modal: doc.getElementById('treasury-spend-modal') };
    }
    const seats = (members) => async () => ({ pallet: 'council', members });
    const STATES = [
        ['no wallet', { selected: null, read: seats([A]) }, 'Connect the wallet of a council member to propose a spend.'],
        ['no node connection', { api: null, read: seats([A]) }, 'Waiting for the node connection.'],
        ['checking the seat', { read: () => new Promise(() => {}) }, 'Checking your council seat…'],
        ['seats unreadable', { read: async () => { throw new Error('node unreachable'); } }, 'Could not read the council seats: node unreachable'],
        ['no seat', { selected: OUT, read: seats([A, B]) }, 'Only council members can propose a spend; this account holds no council seat.']
    ];
    for (const [name, o, why] of STATES) {
        test(`T10: ${name}: a secondary .ui-action that stays focusable, with its reason in a line panel`, async () => {
            const w = await world(o);
            assert.ok(w.btn.classList.contains('ui-action'), `Treasury "Propose a spend" (${name}): not a .ui-action: ${w.btn.className}`);
            assert.ok(!w.btn.classList.contains('reward-filter-btn'), `Treasury "Propose a spend" (${name}): still the filter chip class`);
            assert.ok(w.btn.classList.contains('is-unavailable'), `Treasury "Propose a spend" (${name}): not .is-unavailable`);
            assert.equal(w.btn.getAttribute('aria-disabled'), 'true', `Treasury "Propose a spend" (${name}): aria-disabled`);
            assert.ok(!w.btn.hasAttribute('disabled'), `Treasury "Propose a spend" (${name}): has the disabled attribute, so it leaves the tab order`);
            const reason = w.doc.getElementById(w.btn.getAttribute('aria-describedby'));
            assert.ok(reason && reason.matches('.ui-panel.is-info.is-line'), `Treasury "Propose a spend" (${name}): aria-describedby names no .ui-panel.is-info.is-line`);
            assert.equal(txt(reason), why, `Treasury (${name}): the reason text`);
            assert.equal(w.btn.getAttribute('aria-busy'), name === 'checking the seat' ? 'true' : null, `Treasury (${name}): aria-busy`);
            w.btn.click(); await tick(); await tick();
            assert.notEqual(w.modal.style.display, 'flex', `Treasury (${name}): a click on the unavailable action opened the dialog`);
        });
    }
    test('T10: a seat holder gets the plain secondary action, no reason, and a click opens the dialog', async () => {
        const w = await world({ read: seats([A, B]) });
        assert.ok(w.btn.classList.contains('ui-action') && !w.btn.classList.contains('reward-filter-btn'), 'Treasury "Propose a spend" (seat holder): class ' + w.btn.className);
        for (const a of ['aria-disabled', 'aria-busy', 'disabled', 'aria-describedby']) assert.ok(!w.btn.hasAttribute(a), `Treasury "Propose a spend" (seat holder): has ${a}`);
        assert.ok(!w.btn.classList.contains('is-unavailable'));
        assert.equal(w.slot.querySelector('.ui-panel'), null, 'Treasury (seat holder): a reason is shown');
        w.btn.click(); await tick(); await tick();
        assert.equal(w.modal.style.display, 'flex', 'Treasury (seat holder): the dialog did not open');
    });
    test('the page slot is the actions row and announces the change from "Checking" to the result', () => {
        assert.equal(card().querySelector('#treasury-spend-action').getAttribute('aria-live'), 'polite', 'Treasury #treasury-spend-action: aria-live');
    });
});

// ── T11 ──
describe('every tab row', () => {
    const ROWS = {
        Treasury: { keys: ['overview', 'proposals', 'approved', 'history', 'spends'], attr: 'data-treastab', cls: 'account-tab' },
        Democracy: { keys: ['overview', 'referenda', 'proposals', 'statistics'], attr: 'data-demtab', cls: 'account-tab' },
        Council: { keys: ['council-members', 'council-motions', 'council-tc'], attr: 'data-tab', cls: 'account-tab' },
        Account: { keys: ['transactions', 'events'], attr: 'data-account-tab', cls: 'account-tab account-tab-btn' }
    };
    for (const [name, R] of Object.entries(ROWS)) {
        test(`T11: ${name}: a tablist of buttons, exactly one selected, every other tab identical in class, each tab selected once`, () => {
            const rows = tabRows[name]();
            assert.ok(rows.length >= R.keys.length, `${name}: ${rows.length} tab rows captured`);
            const seen = new Set();
            rows.forEach((html, i) => {
                assert.ok(html, `${name}: tab row ${i} was not on the page`);
                const row = parse(html).document.querySelector('.account-tabs');
                assert.equal(row.getAttribute('role'), 'tablist', `${name}: .account-tabs role`);
                const tabs = kids(row);
                assert.equal(tabs.length, R.keys.length, `${name}: tab count`);
                for (const t of tabs) {
                    assert.equal(t.getAttribute('role'), 'tab', `${name} tab "${txt(t)}": role`);
                    assert.equal(t.getAttribute('type'), 'button', `${name} tab "${txt(t)}": type`);
                }
                const active = tabs.filter(t => t.classList.contains('active'));
                assert.equal(active.length, 1, `${name} row ${i}: ${active.length} tabs are .active`);
                assert.equal(tabs.filter(t => t.getAttribute('aria-selected') === 'true').length, 1, `${name} row ${i}: aria-selected="true" count`);
                assert.equal(active[0].getAttribute('aria-selected'), 'true', `${name} tab "${txt(active[0])}": the active tab is not aria-selected`);
                seen.add(active[0].getAttribute(R.attr));
                for (const t of tabs.filter(x => x !== active[0])) {
                    assert.equal(t.getAttribute('class'), R.cls, `${name} tab "${txt(t)}" (inactive, ${t.getAttribute(R.attr)}): class list "${t.getAttribute('class')}"`);
                    assert.equal(t.getAttribute('aria-selected'), 'false', `${name} tab "${txt(t)}": aria-selected`);
                }
            });
            assert.deepEqual([...seen].sort(), R.keys.slice().sort(), `${name}: every tab was the selected one once`);
        });
    }
});

describe('Democracy head', () => {
    test('T12: the shared head, an email action that is not a nested control, and a chip for the indexer', () => {
        const h = parse(pages.democracy.dumps[0]).document.querySelector('.list-header');
        assert.ok(h.classList.contains('ui-page-head'), 'Democracy: the head has no class ui-page-head: ' + h.className);
        assert.equal(h.querySelectorAll('button a, button button, a button, a a').length, 0, 'Democracy: an interactive element inside another one in the head');
        const email = h.querySelector('[data-email-subscribe="democracy"]');
        assert.ok(email && email.tagName === 'BUTTON' && email.classList.contains('ui-action'), 'Democracy: the email button is not a .ui-action button');
        assert.equal(txt(email), 'Get email alerts');
        assert.ok(h.querySelector('.ui-page-head-actions a[href="/help/email-alerts"]'), 'Democracy: the help link is not in the actions row');
        const chip = h.querySelector('.ui-page-head-title .ui-chip');
        assert.ok(chip && chip.querySelector('i.bx') && txt(chip) === 'Synced', 'Democracy: the status is not an icon and a word in a .ui-chip');
        assert.equal(h.querySelectorAll('[style]').length, 0, 'Democracy: a style attribute in the head');
    });
    // The badge function as script.js has it, run on every status the server can send.
    const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const badge = new Function('chipHtml', 'stakingEscapeHtml', `${bodyOf(SCRIPT, 'indexerStatusBadge')}; return indexerStatusBadge;`)(UI.chipHtml, escapeText);
    const CASES = [['Synced', 'is-positive', 'bx-check-circle', 'Synced'], ['Initializing', 'is-wait', 'bx-loader-alt', 'Initializing'], ['Syncing', 'is-wait', 'bx-loader-alt', 'Syncing'],
        ['Backfilling', 'is-wait', 'bx-loader-alt', 'Backfilling'], ['Repairing', 'is-wait', 'bx-wrench', 'Repairing'], ['Degraded', 'is-error', 'bx-error', 'Degraded'],
        ['Error', 'is-error', 'bx-error-circle', 'Indexer error'], ['Something else', 'is-neutral', 'bx-error-circle', 'Indexer error']];
    for (const [status, role, icon, word] of CASES) {
        test(`T12: indexer status "${status}" is a ${role} chip with ${icon} and the word "${word}", and keeps a title`, () => {
            const el = parse(badge(status, '')).document.body.firstElementChild;
            assert.ok(el && el.classList.contains('ui-chip') && el.classList.contains(role), `Democracy status ${status}: ${el && el.className}`);
            assert.ok(el.querySelector('i.' + icon), `Democracy status ${status}: icon ${icon}`);
            assert.equal(txt(el), word, `Democracy status ${status}: word`);
            assert.ok((el.getAttribute('title') || '').length > 0, `Democracy status ${status}: the title tooltip is gone`);
            assert.equal(el.hasAttribute('style'), false, `Democracy status ${status}: inline style`);
        });
    }
});

describe('Council head', () => {
    test('T13: index.html: the head is the shared part, outside the card, with the three buttons in order and no inline style on tabs or bodies', () => {
        const d = parse(INDEX_HTML).document;
        const h = d.querySelector('.council-page-header');
        assert.ok(h.classList.contains('ui-page-head') && h.classList.contains('is-outside'), 'Council: the head classes are ' + h.className);
        const row = h.querySelector('.ui-page-head-actions');
        assert.ok(row, 'Council: no .ui-page-head-actions');
        assert.deepEqual(kids(row).map(b => b.id), ['council-submit-candidacy-btn', 'council-withdraw-btn', 'council-vote-btn'], 'Council: action order');
        assert.equal(txt(h.querySelector('h2')), 'Council');
        const tabs = d.querySelector('.council-page .account-tabs');
        assert.equal(tabs.hasAttribute('style'), false, 'Council: inline style on .account-tabs');
        assert.equal(tabs.getAttribute('role'), 'tablist', 'Council: .account-tabs role');
        for (const id of ['council-members', 'council-motions', 'council-tc']) assert.equal(d.getElementById(id).hasAttribute('style'), false, `Council #${id}: inline style on the tab body`);
        assert.ok(d.getElementById('council-vote-btn').classList.contains('council-vote-button'), 'Council: Vote keeps its look');
        for (const id of ['council-submit-candidacy-btn', 'council-withdraw-btn']) assert.ok(d.getElementById(id).classList.contains('ui-action'), `Council #${id}: not a .ui-action`);
    });
});

describe('Active Validators head', () => {
    test('T14: ruled, the count in the meta line, and the two links in an actions row that follows the flag', () => {
        const d = parse(INDEX_HTML).document;
        const h = d.querySelector('.validators-page .list-header');
        assert.ok(h.classList.contains('ui-page-head') && h.classList.contains('is-ruled'), 'Active Validators: head classes ' + h.className);
        assert.ok(h.querySelector('.ui-page-head-meta .validator-count'), 'Active Validators: .validator-count is not in the meta line');
        const row = h.querySelector('.ui-page-head-actions');
        assert.ok(row && row.classList.contains('validate-flag-link'), 'Active Validators: the actions row does not carry validate-flag-link');
        assert.equal(row.querySelectorAll('a.item-link').length, 2, 'Active Validators: link count in the actions row');
        assert.ok(row.hasAttribute('hidden'), 'Active Validators: the actions row is not hidden in the shell');
        assert.equal(pages.validatorsOff.probe['.validators-page .ui-page-head-actions'].shown, 0, 'Active Validators: the links row is shown with the flag off');
        assert.equal(pages.validatorsOn.probe['.validators-page .ui-page-head-actions'].shown, 1, 'Active Validators: the links row stays hidden with the flag on');
    });
});

describe('no tab row carries inline spacing', () => {
    test('T15: .account-tabs has no inline margin or padding in index.html or in any rendered page', () => {
        const rows = [...Array.from(parse(INDEX_HTML).document.querySelectorAll('.account-tabs')).map(r => ['index.html', r.outerHTML]),
            ...['Treasury', 'Democracy', 'Council', 'Account'].flatMap(p => tabRows[p]().map(html => [p, html]))];
        assert.ok(rows.length >= 15, 'only ' + rows.length + ' tab rows were found');
        for (const [where, html] of rows) {
            const style = parse(html).document.querySelector('.account-tabs').getAttribute('style') || '';
            assert.ok(!/margin|padding/.test(style), `${where}: .account-tabs has style="${style}"`);
        }
        const card = parse(pages.democracy.dumps[0]).document;
        assert.ok(!/margin|padding/.test(card.querySelector('.account-tabs').getAttribute('style') || ''), 'Democracy card: .account-tabs inline spacing');
    });
});

// ── the selected tab is brought into view at 375 (horizontal only: a re-render must not move the page) ──
describe('revealActiveTab', () => {
    test('a pure helper: how far the row scrolls to show the selected tab', () => {
        assert.equal(typeof UI.tabRowScroll, 'function', 'lib/ui-parts.js has no tabRowScroll');
        assert.equal(UI.tabRowScroll({ tabLeft: 0, tabWidth: 80, viewLeft: 0, viewWidth: 300, pad: 24 }), 0, 'already visible');
        assert.equal(UI.tabRowScroll({ tabLeft: 400, tabWidth: 100, viewLeft: 0, viewWidth: 300, pad: 24 }), 224, 'beyond the right edge: the end of the tab 24 px inside');
        assert.equal(UI.tabRowScroll({ tabLeft: 40, tabWidth: 100, viewLeft: 200, viewWidth: 300, pad: 24 }), 40, 'beyond the left edge: the start of the tab');
    });
    test('script.js reveals the selected tab after Treasury and Democracy draw, on a Council click and on an Account switch', () => {
        for (const fn of ['renderTreasury', 'renderDemocracy']) assert.match(bodyOf(SCRIPT, fn), /revealActiveTab\(root\)/, `${fn}: no revealActiveTab(root)`);
        assert.match(SCRIPT, /councilTabs\.forEach\(tab => \{[\s\S]*?revealActiveTab\(/, 'Council tab click: no revealActiveTab');
        assert.match(SCRIPT.slice(SCRIPT.indexOf('window.switchAccountTab')), /^[\s\S]{0,1500}?revealActiveTab\(/, 'Account switchAccountTab: no revealActiveTab');
    });
    test('revealActiveTab sets scrollLeft on the row from the tab geometry and never calls scrollIntoView', () => {
        assert.equal(typeof UI.revealActiveTab, 'function', 'lib/ui-parts.js has no revealActiveTab');
        const w = parse('<div id="r"><div class="account-tabs"><button class="account-tab">A</button><button class="account-tab active">B</button></div></div>');
        const row = w.document.querySelector('.account-tabs'), tab = w.document.querySelector('.account-tab.active');
        let into = 0; tab.scrollIntoView = () => { into++; };
        Object.defineProperty(row, 'clientWidth', { value: 300 }); Object.defineProperty(tab, 'offsetLeft', { value: 400 }); Object.defineProperty(tab, 'offsetWidth', { value: 100 });
        UI.revealActiveTab(w.document.getElementById('r'));
        assert.equal(row.scrollLeft, 224);
        assert.equal(into, 0, 'scrollIntoView can move the page vertically on every poll');
        UI.revealActiveTab(null);   // nothing to reveal: no throw
    });
});

// ── 5.3 the `heads` scenes ──
describe('the heads preview scenes', () => {
    const IDS = ['treasury-header', 'treasury-header-no-wallet', 'treasury-header-member', 'treasury-header-spends-tab', 'treasury-tabs-hover', 'council-header', 'council-header-motions',
        'democracy-header', 'democracy-header-referenda', 'validators-header', 'account-tabs'];
    let dir, files = [], tried = 'not run';
    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'heads-'));
        try { execFileSync(process.execPath, ['--experimental-sqlite', fileURLToPath(new URL('../tools/preview-scenes.mjs', import.meta.url)), '--out', dir, '--wp', 'heads'], { stdio: 'pipe', timeout: 240000, maxBuffer: 1 << 26 }); tried = 'ok'; }
        catch (e) { tried = String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '); }
        files = readdirSync(dir);
    });
    test('11 scenes, at 1280 and 375, and treasury-header also at 1000', () => {
        assert.equal(tried, 'ok', 'the preview tool refused the heads package: ' + tried);
        const want = IDS.flatMap(id => [`heads-${id}-1280.html`, `heads-${id}-375.html`].concat(id === 'treasury-header' ? [`heads-${id}-1000.html`] : []));
        assert.deepEqual(files.slice().sort(), want.sort());
    });
    test('every scene: the shared head, no inline style in head or tab row, one selected tab, no primary', () => {
        assert.ok(files.length > 0, 'no heads scene was written');
        for (const f of files) {
            const html = readFileSync(join(dir, f), 'utf8');
            const inner = (/srcdoc="([^"]*)"/.exec(html) || [])[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const d = parse((/<body[^>]*>([\s\S]*)<\/body>/.exec(inner) || [])[1]).document;
            const h = Array.from(d.querySelectorAll('.list-header')).find(x => x.classList.contains('ui-page-head'));
            // The Account details head (title and close control) is one row and is not part of this change; its tab row is.
            if (!/^heads-account-tabs-/.test(f)) assert.ok(h, `${f}: no .list-header.ui-page-head on the page`);
            if (h) assert.equal(h.querySelectorAll('[style]').length, 0, `${f}: a style attribute inside the head`);
            for (const row of Array.from(d.querySelectorAll('.account-tabs'))) {
                assert.ok(!/margin|padding/.test(row.getAttribute('style') || ''), `${f}: inline spacing on a tab row`);
                if (row.querySelector('.account-tab')) assert.equal(row.querySelectorAll('.account-tab.active').length, 1, `${f}: ${row.querySelectorAll('.account-tab.active').length} selected tabs in a row`);
            }
            assert.equal(d.querySelectorAll('.validate-primary').length, 0, `${f}: a .validate-primary on a head scene`);
        }
    });
    test('the hover scene has the pointer on Spends and focus on History', () => {
        assert.ok(files.includes('heads-treasury-tabs-hover-1280.html'), 'no hover scene');
        const html = readFileSync(join(dir, 'heads-treasury-tabs-hover-1280.html'), 'utf8').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        assert.match(html, /<button[^>]*class="account-tab pv-hover"[^>]*data-treastab="spends"/, 'Spends is not .pv-hover');
        assert.match(html, /<button[^>]*class="account-tab pv-focus"[^>]*data-treastab="history"/, 'History is not .pv-focus');
        rmSync(dir, { recursive: true, force: true });
    });
});
