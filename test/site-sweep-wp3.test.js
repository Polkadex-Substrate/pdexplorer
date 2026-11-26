// Sprint 11 site sweep, WP3 and WP3b (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 2.2 P1, P4, P5, P10,
// P12, P13, P15, 2.3 rows I1 to I4, I7 to I10, I46, section 4, section 5 (Q3, approved by the CEO on 2026-11-26), 6.1 T4
// and T6, 6.2 T8, T9, T14, 7 S8, 2.6 G2 and G3 final), plus the two CEO decisions of 2026-11-26 taken from section 9:
// addresses are neutral light text with an underline on hover, and Nay uses the red role while Aye stays green.
//
// How: index.html's own markup is parsed as it ships (no script ran), and the REAL pages are loaded through
// test/helpers/full-page.js (index.html plus the real script.js in happy-dom) and read back. The stylesheet is the real
// styles.css read as a cascade (test/helpers/phone-width.js). makeTable and the two My Account tables are the REAL
// functions lifted from script.js by name. Test names start with the spec id, so a failure names its item.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { runPage } from './helpers/head-page.js';
import { bodyOf } from './helpers/source.js';
import { declsAt, declsIn, declared, RULES } from './helpers/phone-width.js';
import { escapeHtml } from '../lib/html-escape.js';
import { checkSite, repoReader, G2_CEILING, G3_CEILING, G4_SOURCE_CEILING, EXEMPT } from '../scripts/check-ui-legacy.mjs';

const ROOT = new URL('../', import.meta.url);
const HTML = readFileSync(new URL('index.html', ROOT), 'utf8');
const SCRIPT = readFileSync(new URL('script.js', ROOT), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.lastIndexOf('</body>') + 7).replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '').replace(/<script[\s\S]*?<\/script>/g, '');
const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
const PRIMARY = '.validate-primary, .wallet-option-row.is-primary, .modal-submit-btn';
const docOf = (html) => {
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return win.document;
};
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
// Never hand a happy-dom node to assert: a failing assertion inspects it, and that can exhaust memory.
const describeEl = (e) => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''} style="${(e.getAttribute('style') || '').slice(0, 70)}"> ${text(e).slice(0, 30)}`;
const coloured = (root) => [root, ...root.querySelectorAll('[style]')].filter(e => e.hasAttribute && e.hasAttribute('style') && COLOUR.test(';' + e.getAttribute('style')));
const drawn = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.hasAttribute('hidden') || /display:\s*none/.test(e.getAttribute('style') || '')) return false; } return true; };
const IDX = docOf(BODY);
const byId = (id) => { const e = IDX.getElementById(id); assert.ok(e, `index.html has no #${id}`); return e; };
const cls = (e, ...c) => c.every(x => e.classList.contains(x));

// ── T9 (static pages): index.html's own markup writes no colour, background or border ──
describe('T9: index.html writes no colour in markup, per page, per dialog and in the shell (spec 6.2, 2.6 G2 final)', () => {
    for (const sec of Array.from(IDX.querySelectorAll('.page-section[data-page]'))) {
        const name = sec.getAttribute('data-page');
        test(`page ${name}: no inline colour, background or border`, () => assert.deepEqual(coloured(sec).map(describeEl), []));
    }
    for (const m of Array.from(IDX.querySelectorAll('.modal[id]'))) {
        test(`dialog #${m.id}: no inline colour, background or border`, () => assert.deepEqual(coloured(m).map(describeEl), []));
    }
    test('the shell (sidebar, top bar, glossary popover, storage notice): no inline colour, background or border', () => {
        const shell = docOf(BODY);
        for (const e of Array.from(shell.querySelectorAll('.page-section[data-page], .modal[id]'))) e.remove();
        assert.deepEqual(coloured(shell.body).map(describeEl), []);
    });
});

// ── the rows of index.html (static) ──
describe('2.3 rows of index.html, read from the markup as it ships', () => {
    test('I1: the Council figures row is .staking-summary-grid with four .staking-summary-card (label, value); ids kept; labels verbatim, not uppercased', () => {
        const grid = byId('council-members').querySelector('.staking-summary-grid');
        assert.ok(grid, 'no .staking-summary-grid on the Council members tab');
        const cards = Array.from(grid.querySelectorAll(':scope > .staking-summary-card'));
        assert.equal(cards.length, 4);
        assert.deepEqual(cards.map(c => text(c.querySelector('.label'))), ['Seats', 'Runners Up', 'Candidates', 'Term Progress']);
        assert.deepEqual(cards.map(c => c.querySelector('.value') && c.querySelector('.value').id), ['council-seats-count', 'council-runnersup-count', 'council-candidates-count', 'council-term-remaining']);
        assert.ok(cards[3].querySelector('#council-term-progress #council-progress-arc'), 'the term progress ring left the fourth card');
        assert.notEqual(declsAt('.staking-summary-card .label', 1280)['text-transform'], 'uppercase', 'the labels are drawn in uppercase');
    });
    test('I2: the Council list headings are h3.ui-section-title.ui-ruled (Members, Runners Up, Candidates); the Technical Committee one is h3.ui-section-title', () => {
        const hs = Array.from(byId('council-members').querySelectorAll('h3'));
        assert.deepEqual(hs.map(h => [text(h), cls(h, 'ui-section-title', 'ui-ruled'), h.hasAttribute('style')]), [['Members', true, false], ['Runners Up', true, false], ['Candidates', true, false]]);
        const tc = byId('council-tc').querySelector('h3');
        assert.ok(tc && cls(tc, 'ui-section-title') && !tc.hasAttribute('style'), tc ? describeEl(tc) : 'no h3');
    });
    test('I3: both logo links take their look from .logo (white, no underline); .topbar .logo has gap 8px and weight 700', () => {
        const logos = Array.from(IDX.querySelectorAll('a.logo'));
        assert.equal(logos.length, 2);
        for (const a of logos) assert.ok(!COLOUR.test(';' + (a.getAttribute('style') || '')), describeEl(a));
        const base = declsIn('.logo', '');
        assert.equal(base.color, 'var(--text-primary)');
        assert.equal(base['text-decoration'], 'none');
        assert.deepEqual([declsIn('.topbar .logo', '').gap, declsIn('.topbar .logo', '')['font-weight']], ['8px', '700']);
    });
    test('I4: the Reward history head is .list-header.is-open (no border, no bottom padding) with no style', () => {
        const head = IDX.querySelector('.staking-rewards-page .list-header');
        assert.ok(cls(head, 'is-open') && !head.hasAttribute('style'), describeEl(head));
        assert.deepEqual([declsIn('.list-header.is-open', '')['border-bottom'], declsIn('.list-header.is-open', '')['padding-bottom']], ['0', '0']);
    });
    test('I7: the glossary popover: .glossary-popover (dark, hairline), the term .glossary-popover-term (white, bold, not pink), the body .ui-quiet', () => {
        assert.ok(cls(byId('glossary-popover'), 'glossary-popover'));
        assert.ok(cls(byId('glossary-popover-term'), 'glossary-popover-term'));
        assert.ok(cls(byId('glossary-popover-body'), 'ui-quiet'));
        const p = declsIn('.glossary-popover', ''), t = declsIn('.glossary-popover-term', '');
        assert.deepEqual([p.background, p.border], ['var(--bg-dark)', '1px solid var(--border-color)']);
        assert.deepEqual([t.color, t['font-weight']], ['var(--text-primary)', '700']);
    });
    test('I8: the search head: the query is .ui-strong (white), the close link is the shared .close-control', () => {
        assert.ok(cls(byId('search-query-display'), 'ui-strong') && !byId('search-query-display').hasAttribute('style'));
        const x = byId('search-close-btn');
        assert.ok(cls(x, 'close-control'), describeEl(x));
        assert.ok(!COLOUR.test(';' + (x.getAttribute('style') || '')), describeEl(x));
        assert.ok(cls(x.closest('.list-header'), 'is-ruled'), 'P15: the search head is not .list-header.is-ruled');
    });
    test('I9: the storage notice is .storage-notice; its icon is blue information, its text .ui-lede, its strong .ui-strong, its link .item-link.is-inline', () => {
        const b = byId('storage-notice-banner');
        assert.ok(cls(b, 'storage-notice'), describeEl(b));
        assert.ok(b.querySelector('.bx-info-circle.ui-glyph.is-blue'), 'the icon is not .ui-glyph.is-blue');
        assert.ok(b.querySelector('p.ui-lede'), 'the text is not .ui-lede');
        assert.ok(b.querySelector('p.ui-lede strong.ui-strong'));
        assert.ok(b.querySelector('a[href="/cookies"].item-link.is-inline'));
        const d = declsIn('.storage-notice', '');
        assert.deepEqual([d.background, d['border-top']], ['var(--bg-surface)', '1px solid var(--accent-blue-line)']);
    });
    test('I10: the Help search: wrapper .help-search, icon .ui-glyph.is-muted, field .ui-input (padding from .help-search > .ui-input)', () => {
        const f = byId('help-search');
        assert.ok(cls(f, 'ui-input') && cls(f.parentElement, 'help-search'), describeEl(f));
        assert.ok(f.parentElement.querySelector(':scope > .bx-search.ui-glyph.is-muted'));
        assert.equal(declsIn('.help-search > .ui-input', '')['padding-left'], '36px');
        assert.equal(declsIn('.help-search', '').position, 'relative');
    });
    test('I46: the Events and Search list footers are .list-footer (centred, ruled) with no style', () => {
        for (const sel of ['.events-page .list-container > div:last-child', '.search-page .list-container > div:last-child']) {
            const f = IDX.querySelector(sel);
            assert.ok(f && cls(f, 'list-footer') && !COLOUR.test(';' + (f.getAttribute('style') || '')), f ? describeEl(f) : sel);
        }
        assert.deepEqual(declsIn('.list-footer', ''), { padding: '20px', 'text-align': 'center', 'border-top': '1px solid var(--border-color)' });
    });
    for (const [id, words] of [['validators-table', 'Fetching validators from indexer…'], ['holders-table', 'Fetching holders from indexer…'], ['full-transactions-table', 'Fetching transactions…'],
        ['full-blocks-table', 'Fetching blocks…'], ['council-motions-content', 'Fetching council motions…'], ['tc-motions-content', 'Fetching technical committee motions…']]) {
        test(`P1: #${id} shows its loading state as stateHtml("loading", roomy): .ui-state.is-loading.is-roomy, role=status, a spinner, the same words`, () => {
            const s = byId(id).querySelector(':scope > .ui-state');
            assert.ok(s, `#${id}: no .ui-state`);
            assert.ok(cls(s, 'is-loading', 'is-roomy') && s.getAttribute('role') === 'status' && s.querySelector('.bx-loader-alt.bx-spin'), describeEl(s));
            assert.equal(text(s), words);
        });
    }
    test('P4, P5: the legal dates are span.ui-caption, the reset note p.ui-caption, the 404 line p.ui-lede', () => {
        for (const p of ['privacy', 'cookies']) {
            const d = IDX.querySelector(`.page-section[data-page="${p}"] .list-header span`);
            assert.ok(d && cls(d, 'ui-caption') && text(d) === 'Last updated: November 2026', d ? describeEl(d) : p);
        }
        const note = Array.from(IDX.querySelectorAll('.page-section[data-page="cookies"] p')).find(e => /^Equivalent to clearing site data/.test(text(e)));
        assert.ok(note && cls(note, 'ui-caption'), note ? describeEl(note) : 'no note');
        const lost = IDX.querySelector('.page-section[data-page="not-found"] p');
        assert.ok(cls(lost, 'ui-lede'), describeEl(lost));
    });
    test('P12: the two legal bodies are .legal-body; every heading, cell, row, code and strong inside has no style; the legal heads are .list-header.is-ruled', () => {
        for (const p of ['privacy', 'cookies']) {
            const sec = IDX.querySelector(`.page-section[data-page="${p}"]`);
            const body = sec.querySelector('.legal-body');
            assert.ok(body, `${p}: no .legal-body`);
            // Amended before green: the cookie table cells keep their layout-only style="padding: 10px 12px;" (spec 2.2: layout may stay
            // inline this sprint). test/post-action-wiring.test.js pins those cells as written, and a post-action test is not edited.
            // T9 still refuses any colour on them.
            const styled = Array.from(body.querySelectorAll('h2, th, tr, code, strong, table, p')).filter(e => e.hasAttribute('style') && e.id !== 'cookies-reset-btn');
            const tdStyles = new Set(Array.from(body.querySelectorAll('td[style]')).map(e => e.getAttribute('style')));
            assert.deepEqual(Array.from(tdStyles), p === 'cookies' ? ['padding: 10px 12px;'] : []);
            assert.deepEqual(styled.map(describeEl), []);
            assert.ok(cls(sec.querySelector('.list-header'), 'is-ruled'), `${p}: the head is not .is-ruled`);
        }
        assert.deepEqual(declsIn('.legal-page .legal-body', ''), { padding: '32px', 'font-size': '0.95rem', 'line-height': '1.7', color: 'var(--text-secondary)' });
        assert.deepEqual([declsIn('.legal-body h2', '').color, declsIn('.legal-body h2', '')['font-size']], ['var(--text-primary)', '1.15rem']);
        assert.equal(declsIn('.legal-body tr', '')['border-bottom'], '1px solid var(--border-color)');
        assert.equal(declsIn('.legal-body code', '').color, 'var(--accent-violet-text)');
        assert.equal(declsAt('.legal-page .legal-body', 375).padding, '16px', 'the legal body keeps 32 px of padding on a phone');
    });
    test('P13, P15: the tour footer is .ui-ruled-top; the Events head is .list-header.is-ruled', () => {
        const foot = byId('onboarding-tour-dots').parentElement;
        assert.ok(cls(foot, 'ui-ruled-top') && !COLOUR.test(';' + (foot.getAttribute('style') || '')), describeEl(foot));
        const ev = IDX.querySelector('.events-page .list-header');
        assert.ok(cls(ev, 'is-ruled') && !ev.hasAttribute('style'), describeEl(ev));
    });
});

// ── Q3: one primary per view, the gradient (static views) ──
const GRADIENT_STATIC = [
    ['staking-search-btn', 'Reward history Search (5.1 row 14)', 'Search'], ['council-vote-btn', 'Council page Vote (5.1 row 16)', 'Vote'],
    ['onboarding-tour-next', 'Tour Next (5.1 row 13)', 'Next →'],
    ['submit-stake-tx-btn', 'Stake (row 2)', 'Sign and stake'], ['submit-payout-tx-btn', 'Pay out (row 3)', 'Sign and pay out'], ['submit-send-tx-btn', 'Send (row 4)', 'Sign and send'],
    ['submit-unstake-tx-btn', 'Unstake (row 5)', 'Sign and unstake'], ['submit-identity-tx-btn', 'Identity (row 6)', 'Save identity'], ['submit-vote-tx-btn', 'Council vote (row 7)', 'Sign and submit vote'],
    ['submit-referendum-vote-btn', 'Referendum vote (row 8)', 'Sign and submit vote'], ['submit-candidacy-tx-btn', 'Submit candidacy (row 9)', 'Sign and submit candidacy'],
    ['council-withdraw-sign', 'Withdraw candidacy (row 10)', 'Sign and withdraw candidacy'], ['treasury-spend-sign', 'Propose a spend (row 11)', 'Sign and table motion']];
describe('5.1 (Q3): every view\'s one primary is the gradient .validate-primary (index.html)', () => {
    for (const [id, view, label] of GRADIENT_STATIC) {
        test(`${view}: #${id} is .validate-primary, not .is-solid and not .modal-submit-btn; label "${label}"`, () => {
            const b = byId(id);
            assert.ok(cls(b, 'validate-primary') && !cls(b, 'is-solid') && !cls(b, 'modal-submit-btn'), describeEl(b));
            assert.equal(text(b), label);
            assert.ok(!COLOUR.test(';' + (b.getAttribute('style') || '')), describeEl(b));
        });
    }
    test('#council-vote-btn keeps .council-vote-button (its tests select it) but that class gives no colour of its own', () => {
        assert.ok(cls(byId('council-vote-btn'), 'council-vote-button'));
        const own = RULES.filter(r => r.selectors.some(s => /^\.council-vote-button(?![\w-])/.test(s)));
        for (const r of own) for (const p of ['background', 'color', 'border', 'border-color']) assert.equal(r.decls[p], undefined, `styles.css:${r.line} ${r.selectors.join(', ')} { ${p}: ${r.decls[p]} }`);
    });
    test('T8: no .modal-submit-btn and no .is-solid anywhere in index.html; every dialog holds at most one primary', () => {
        assert.deepEqual(Array.from(IDX.querySelectorAll('.modal-submit-btn, .is-solid')).map(describeEl), []);
        for (const m of Array.from(IDX.querySelectorAll('.modal[id]'))) assert.ok(m.querySelectorAll(PRIMARY).length <= 1, `#${m.id}: ${m.querySelectorAll(PRIMARY).length} primaries`);
    });
    test('the dialog sign buttons sit where .ui-modal-card > .validate-primary sizes them (full width, centred, 48 px, 16 px above)', () => {
        for (const id of ['submit-payout-tx-btn', 'submit-send-tx-btn', 'submit-unstake-tx-btn', 'submit-vote-tx-btn', 'submit-referendum-vote-btn', 'submit-candidacy-tx-btn']) {
            assert.ok(byId(id).matches('.ui-modal-card > .validate-primary'), `#${id} is not a direct child of its .ui-modal-card`);
        }
        assert.deepEqual(declsIn('.ui-modal-card > .validate-primary', ''), { width: '100%', 'justify-content': 'center', 'margin-top': '16px', 'min-height': '48px' });
        assert.equal(declsIn('.identity-actions .validate-primary', '').flex, '1', 'Identity: Save no longer fills its row');
    });
});

// ── T6 and the two CEO decisions: the parsed stylesheet ──
const rulesFor = (sel) => RULES.filter(r => r.selectors.includes(sel));
describe('T6 (WP3b): the stylesheet has one primary look and no pink button that is not a primary', () => {
    test('no rule gives a button or link selector background: var(--brand-primary)', () => {
        const BUTTONISH = /(btn|button|-copy\b|-run\b|^a(?=$|[.:[])|\.pill\b|-action\b|-link\b|-cta\b)/;
        const bad = RULES.filter(r => /var\(--brand-primary\)/.test(r.decls.background || r.decls['background-color'] || '') && r.selectors.some(s => BUTTONISH.test(s.split(/[\s>+~]+/).pop())))
            .map(r => `styles.css:${r.line} ${r.selectors.join(', ')}`);
        assert.deepEqual(bad, []);
    });
    test('.modal-submit-btn, .validate-primary.is-solid and the three .staking-search-bar button rules are gone', () => {
        const gone = RULES.filter(r => r.selectors.some(s => /\.modal-submit-btn|\.is-solid|^\.staking-search-bar button/.test(s))).map(r => `styles.css:${r.line} ${r.selectors.join(', ')}`);
        assert.deepEqual(gone, []);
    });
    test('Top bar Connect Wallet (5.1 row 1): the solid state is the gradient; .is-connected and .is-outline unchanged', () => {
        assert.equal(declsIn('.connect-wallet-btn', '').background, 'var(--brand-gradient)');
        assert.equal(declsIn('.connect-wallet-btn', '').color, 'var(--text-primary)');
        assert.equal(declsIn('.connect-wallet-btn.is-connected', '').background, 'var(--accent-violet-tint)');
        assert.equal(declsIn('.connect-wallet-btn.is-outline', '').background, 'transparent');
    });
    test('Confirm dialog (5.1 row 17): .confirm-dialog-danger takes the .validate-primary look (the gradient, white text)', () => {
        const d = declsIn('.confirm-dialog-actions .confirm-dialog-danger', '');
        assert.deepEqual([d.background, d.color], ['var(--brand-gradient)', 'var(--text-primary)']);
    });
    test('My Account Send (5.1 row 18): a gradient BORDER on a neutral fill, as the chooser lead row; hover keeps the aria-disabled guard', () => {
        const d = declsIn('.wallet-action-btn.primary', '');
        assert.equal(d['border-color'], 'transparent');
        assert.match(d.background || '', /^linear-gradient\(var\(--bg-surface\), var\(--bg-surface\)\) padding-box, var\(--brand-gradient\) border-box$/);
        const hover = rulesFor('.wallet-action-btn.primary:hover:not(:disabled):not([aria-disabled="true"])');
        assert.ok(hover.length && !/230, 0, 122/.test(hover.map(r => r.decls.background || '').join('')), 'the hover still fills pink');
    });
    test('5.2 B: Donate Copy address has no pink fill and no off-kit hover (it is .validate-secondary)', () => {
        for (const r of RULES.filter(r => r.selectors.some(s => /\.donate-copy/.test(s)))) {
            assert.ok(!/brand-primary|#c80069/i.test(JSON.stringify(r.decls)), `styles.css:${r.line} ${r.selectors.join(', ')}`);
        }
    });
    test('5.2 C: the Load older bars take the .ui-action declarations (violet tint, violet line, white text)', () => {
        const u = declsIn('.ui-action', ''), o = declsIn('.js-older-btn', ''), s = declsIn('.js-older-search', '');
        for (const d of [o, s]) assert.deepEqual([d.background, d.border, d.color], [u.background, u.border, u.color]);
        const hover = declsIn('.js-older-btn:hover', '');
        assert.ok(!/230, 0, 122|brand-primary/.test(JSON.stringify(hover)), JSON.stringify(hover));
    });
    for (const sel of ['.reward-filter-btn.active', '.pill.active', '.table-pagebtn.active']) {
        test(`5.2 D: ${sel} is "you are here": the violet tokens, as .stake-seg-btn.is-on`, () => {
            const d = declsIn(sel, '');
            assert.deepEqual([d.background, d['border-color'], d.color], ['var(--accent-violet-tint)', 'var(--accent-violet-line)', 'var(--accent-violet-text)']);
            assert.ok(!/brand-primary|230, 0, 122/.test(JSON.stringify(d)), JSON.stringify(d));
        });
    }
});

describe('CEO decision (2026-11-26): addresses are neutral light text; a linked address underlines on hover', () => {
    test('.address-cell is var(--text-primary), no rule colours an address pink or green', () => {
        assert.equal(declsIn('.address-cell', '').color, 'var(--text-primary)');
        const bad = RULES.filter(r => r.selectors.some(s => /address-cell/.test(s)) && /brand-primary|brand-secondary|accent-pink|accent-green/.test(r.decls.color || '')).map(r => `styles.css:${r.line} ${r.selectors.join(', ')} { color: ${r.decls.color} }`);
        assert.deepEqual(bad, []);
    });
    test('a linked address (a.address-cell, .address-cell a) underlines on hover and stays light, over .item-link:hover', () => {
        const doc = docOf('<table><tr><td class="address-cell"><a class="item-link" href="/account/x">x</a></td></tr></table><a href="/account/y" class="item-link address-cell">y</a>');
        for (const a of Array.from(doc.querySelectorAll('a'))) {
            a.classList.add('pv-hover');
            const hovered = (prop) => { let best = null; for (const r of RULES) { if (r.media) continue; for (const s of r.selectors) { if (!/:hover/.test(s)) continue; try { if (a.matches(s.replace(/:hover/g, '.pv-hover')) && r.decls[prop]) best = r.decls[prop]; } catch (e) { /* not a selector happy-dom reads */ } } } return best; };
            assert.equal(hovered('text-decoration'), 'underline', describeEl(a));
            assert.equal(hovered('color'), 'var(--text-primary)', describeEl(a));
        }
    });
});

describe('CEO decision (2026-11-26): Nay uses the red role, Aye stays green', () => {
    test('the motion bars: Nay var(--accent-red), Aye green', () => {
        assert.equal(declsIn('.motion-bar-fill.nay', '').background, 'var(--accent-red)');
        assert.match(declsIn('.motion-bar-fill.aye', '').background, /var\(--(brand-secondary|accent-green|success)\)/);
    });
    test('the motion buttons: Nay is red text on a red line (no pink, no off-kit #ff5fae); Aye keeps its green', () => {
        const n = declsIn('.motion-btn.nay', '');
        assert.deepEqual([n.color, n['border-color'], n.background], ['var(--accent-red)', 'var(--accent-red-line)', 'var(--accent-red-tint)']);
        const all = RULES.filter(r => r.selectors.some(s => /\.motion-btn\.nay/.test(s))).map(r => JSON.stringify(r.decls)).join(' ');
        assert.ok(!/230, 0, 122|brand-primary|ff5fae/i.test(all), all);
        assert.match(declsIn('.motion-btn.aye', '').color, /var\(--(brand-secondary|accent-green|success)\)/);
    });
    test('the governance detail bars and dots: Nay var(--accent-red), Aye green', () => {
        assert.equal(declsIn('.gd-bar .gd-nay, .gd-dot.gd-nay'.split(', ')[0], '').background, 'var(--accent-red)');
        assert.match(declsIn('.gd-bar .gd-aye', '').background, /var\(--(success|accent-green)\)/);
    });
});

// ── T4: the phone rules, from the parsed stylesheet ──
describe('T4: the phone rules of section 4, at 640 and 360, and none of them at 1280', () => {
    const STACK = {
        '.data-table.is-stacked thead': { display: 'none' },
        '.data-table.is-stacked tbody tr': { display: 'grid', 'grid-template-columns': 'minmax(0, 1fr) auto', gap: '4px 12px', padding: '12px 0', 'border-bottom': '1px solid var(--border-color)' },
        '.data-table.is-stacked tbody tr:last-child': { 'border-bottom': '0' },
        '.data-table.is-stacked tbody td': { display: 'block', 'min-width': '0', padding: '0', 'border-bottom': '0' },
        '.data-table.is-stacked td[data-label]::before': { content: 'attr(data-label)', display: 'block', 'font-size': '0.75rem', color: 'var(--text-secondary)' },
        '.data-table.is-stacked td.is-lead::before': { content: 'none' },
        '.data-table.is-stacked td.is-lead .item-link': { display: 'inline-flex', 'align-items': 'center', 'min-height': '44px' },
        '.data-table.is-stacked td.is-tag': { 'align-self': 'center', 'justify-self': 'end' },
        '.data-table.is-stacked td.is-end': { 'text-align': 'right' },
        '.data-table.is-stacked td.table-empty-row': { 'grid-column': '1 / -1', padding: '16px 0', 'text-align': 'center' }
    };
    for (const width of [640, 360]) {
        test(`4.1 at ${width}: Recent Transactions stack (each rule of the block, with its value)`, () => {
            for (const [sel, want] of Object.entries(STACK)) {
                const got = declsAt(sel, width);
                for (const [p, v] of Object.entries(want)) assert.equal(got[p], v, `${sel} { ${p} } at ${width}`);
            }
            assert.equal(declsAt('.data-table.is-stacked', width).display, 'block');
        });
        test(`4.2 at ${width}: the wallet picker head and the session keys table wrap; the call review stacks its arguments`, () => {
            assert.equal(declsAt('.wallet-picker-head', width)['align-items'], 'flex-start');
            assert.deepEqual([declsAt('.wallet-picker-titlebox', width)['flex-wrap'], declsAt('.wallet-picker-titlebox', width)['min-width']], ['wrap', '0']);
            assert.equal(declsAt('.wallet-picker-titlebox .ui-chip', width)['margin-left'], '0');
            assert.equal(declsAt('.validate-keys-table th.table-th', width)['white-space'], 'normal');
            assert.equal(declsAt('.validate-keys-table th', width).padding, '10px 8px');
            assert.equal(declsAt('.ca-args thead', width).position, 'absolute');
            assert.equal(declsAt('.ca-args tr', width).display, 'block');
            assert.equal(declsAt('.ca-args td:first-child', width).color, 'var(--text-secondary)');
            assert.equal(declsAt('.ca-nested', width).padding, '8px');
        });
    }
    test('4.2 at 375: the stake filter segments wrap inside the 720 px block (SIGNING VIEW, CSS only)', () => {
        const d = declsIn('.stake-seg', '@media (max-width: 720px)');
        assert.deepEqual([d['flex-wrap'], d['row-gap'], d['min-width'], d['max-width']], ['wrap', '6px', '0', '100%']);
    });
    test('at 1280 none of the phone rules applies; .data-table.is-stacked changes no display outside its media block', () => {
        for (const sel of Object.keys(STACK)) assert.equal(declsAt(sel, 1280).display === 'grid' || declsAt(sel, 1280).content === 'attr(data-label)', false, sel);
        assert.equal(declsAt('.data-table.is-stacked thead', 1280).display, undefined);
        assert.equal(declsAt('.ca-args thead', 1280).position, undefined);
        assert.equal(declsAt('.validate-keys-table th.table-th', 1280)['white-space'], undefined);
        assert.deepEqual(RULES.filter(r => !r.media && r.selectors.some(s => /is-stacked/.test(s)) && 'display' in r.decls).map(r => r.line), []);
    });
});

// ── T14, S8: makeTable's opt-in stacked rows and the two My Account tables (the REAL functions) ──
const DASH = String.fromCharCode(0x2014);
function tableWorld() {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    doc.body.innerHTML = '<div><div id="wallet-recent-tx-table"></div></div><div id="wallet-recent-rewards-table"></div><div id="plain"></div>';
    const ctx = vm.createContext({ document: doc, window: win, console, Array, Object, String, Number, Math, Date, JSON, Map, Set, Promise, setTimeout, clearTimeout,
        stakingEscapeHtml: escapeHtml, stakingShortAddress: (a) => String(a).slice(0, 8) + '…' + String(a).slice(-6), stakingFormatPDEX: (n) => Number(n || 0).toFixed(4),
        formatLocalDate: (ts) => new Date(ts).toISOString().slice(0, 10), looksLikeTxHash: (h) => /^0x[0-9a-f]{64}$/i.test(String(h)),
        enhanceInputActions: () => {}, walletFetchGen: 1, walletRecentStore: {}, fetchApiJson: async () => ({}), mountWalletRecentTx: ({ buildTable, data }) => buildTable(data.recentTransactions) });
    vm.runInContext(['makeTable', 'mountWalletTxTable', 'mountWalletRewardsTable'].map(n => bodyOf(SCRIPT, n)).join('\n'), ctx);
    return { doc, ctx };
}
const TXH = '0x' + 'ab'.repeat(32);
const TX_ROWS = [{ hash: TXH, block: 7, direction: 'Sent', amount: '1.5000 PDEX', timestamp: 1700000000000 }, { hash: 'event-1', block: 8, direction: 'Received', amount: '', timestamp: 0, eventDerived: true }];
const PLAIN = { rows: [{ a: 'x', b: 2 }, { a: 'y', b: 1 }], columns: [{ key: 'a', label: 'A', sort: (p, q) => p.a.localeCompare(q.a), filter: { type: 'text' } }, { key: 'b', label: 'B', format: (r) => `<em>${r.b}</em>` }],
    defaultSort: { key: 'a', dir: 'asc' }, summarySuffix: 'rows' };
describe('T14 and S8: the opt-in stacked table and Recent Transactions', () => {
    test('T14: without stacked, makeTable draws byte for byte what it drew on the parent commit (fixed fixture, and the empty table)', () => {
        const w = tableWorld();
        const el = w.doc.getElementById('plain');
        w.ctx.makeTable({ container: el, ...PLAIN });
        const full = el.innerHTML;
        w.ctx.makeTable({ container: el, ...PLAIN, rows: [] });
        const want = JSON.parse(readFileSync(new URL('./snapshots/s11-maketable-plain.json', import.meta.url), 'utf8'));
        assert.deepEqual({ full, empty: el.innerHTML }, want);
    });
    test('T14: stacked: true gives table.data-table.is-stacked, data-label = the column label on every body td, and the cell class where set', () => {
        const w = tableWorld();
        const el = w.doc.getElementById('plain');
        w.ctx.makeTable({ container: el, ...PLAIN, stacked: true, columns: [{ ...PLAIN.columns[0], cell: 'is-lead' }, PLAIN.columns[1]] });
        const t = el.querySelector('table.data-table');
        assert.ok(t && cls(t, 'is-stacked'), t ? t.className : 'no table');
        for (const tr of Array.from(t.querySelectorAll('tbody tr'))) {
            const tds = Array.from(tr.children);
            assert.deepEqual(tds.map(td => td.getAttribute('data-label')), ['A', 'B']);
            assert.deepEqual(tds.map(td => td.className), ['is-lead', '']);
        }
        w.ctx.makeTable({ container: el, ...PLAIN, stacked: true, rows: [] });
        const empty = el.querySelector('tbody td');
        assert.ok(cls(empty, 'table-empty-row') && empty.getAttribute('colspan') === '2', describeEl(empty));
    });
    test('Recent Transactions (mountWalletTxTable): stacked; hash is-lead (link kept), direction is-tag, date is-end; the labels', () => {
        const w = tableWorld();
        w.ctx.mountWalletTxTable({ recentTransactions: TX_ROWS }, true);
        const t = w.doc.querySelector('#wallet-recent-tx-table table.data-table');
        assert.ok(cls(t, 'is-stacked'), t.className);
        const row = t.querySelector('tbody tr');
        assert.deepEqual(Array.from(row.children).map(td => [td.getAttribute('data-label'), td.className]), [['Hash', 'is-lead'], ['Direction', 'is-tag'], ['Amount', ''], ['Date', 'is-end']]);
        assert.equal(row.querySelector('a').getAttribute('href'), `/tx/7/${TXH}`);
    });
    test('S8: a row with no amount and no date reads "-", not a long dash', () => {
        const w = tableWorld();
        w.ctx.mountWalletTxTable({ recentTransactions: TX_ROWS }, true);
        const rows = Array.from(w.doc.querySelectorAll('#wallet-recent-tx-table tbody tr'));
        const bare = rows.find(r => r.querySelector('a[href="/block/8"]'));
        assert.ok(bare, 'no row for the event-derived transfer');
        const cells = Array.from(bare.children).map(text);
        assert.deepEqual([cells[2], cells[3]], ['-', '-']);
        assert.ok(!w.doc.getElementById('wallet-recent-tx-table').textContent.includes(DASH));
    });
    test('Recent Staking Rewards (mountWalletRewardsTable, recommended in 4.1): stacked; Era is-lead, Date is-end', () => {
        const w = tableWorld();
        w.ctx.mountWalletRewardsTable({ rewards: { recentClaimed: [{ era: 501, amount: 2.5, timestamp: 1700000000000 }] } });
        const t = w.doc.querySelector('#wallet-recent-rewards-table table.data-table');
        assert.ok(cls(t, 'is-stacked'), t.className);
        assert.deepEqual(Array.from(t.querySelector('tbody tr').children).map(td => [td.getAttribute('data-label'), td.className]), [['Era', 'is-lead'], ['Amount', ''], ['Date', 'is-end']]);
    });
});

// ── G2 and G3 at their final values ──
describe('2.6 G2 and G3 final for index.html and styles.css (proved failing at the real ceilings)', () => {
    const rd = repoReader(new URL('../', import.meta.url).pathname);
    test('the ceilings: G2 index.html 0, G3 index.html 0, G3 styles.css 0, G4 sources 0', () => {
        assert.deepEqual([G2_CEILING['index.html'], G3_CEILING['index.html'], G3_CEILING['styles.css'], G4_SOURCE_CEILING], [0, 0, 0, 0]);
    });
    test('this repository: no line of index.html writes a colour; no hue in index.html or styles.css outside the kit and the named exemptions', () => {
        const r = checkSite(rd);
        assert.deepEqual([r.counts.g2['index.html'] || 0, r.counts.g3['index.html'] || 0, r.counts.g3['styles.css'], r.counts.g4.sources], [0, 0, 0, 0]);
        assert.deepEqual(r.errors.map(e => e.slice(0, 300)), []);
    });
    test('the browser chrome colours of index.html (meta theme-color, mask-icon) are a named G3 exemption with its reason, and only kit values', () => {
        const e = EXEMPT.find(x => x.file === 'index.html');
        assert.ok(e && e.guards.includes('G3') && e.why && e.why.length > 20, 'no index.html exemption with a reason');
        for (const m of HTML.matchAll(/<(?:meta name="theme-color"|link rel="mask-icon")[^>]*?(#[0-9A-Fa-f]{6})/g)) assert.ok(['#E6007A', '#08080C'].includes(m[1].toUpperCase()), m[1]);
    });
    const mutate = (p, edit) => { const files = new Map(); for (const f of rd.list()) files.set(f, rd.read(f)); files.set(p, edit(files.get(p))); return { read: (f) => (files.has(f) ? files.get(f) : null), list: () => Array.from(files.keys()) }; };
    test('G2 proved failing: a style="color: ..." added to index.html is refused with the file, the line and the fix', () => {
        const r = checkSite(mutate('index.html', (s) => s.replace('<div class="app-container">', '<div class="app-container"><p style="color: var(--text-secondary)">x</p>')));
        const line = HTML.split('\n').findIndex(l => l.includes('<div class="app-container">')) + 1;
        const e = r.errors.find(x => /^G2 inline colour: 1 lines in index\.html /.test(x));
        assert.ok(e, r.errors.map(x => x.slice(0, 160)).join(' | '));
        assert.match(e, new RegExp(`index\\.html:${line} \\(a colour, background or border in a style attribute\\)`));
        assert.match(e, /Move the colour into a class/);
    });
    test('G3 proved failing: an off-kit hue in styles.css and in index.html is refused with the line and the value', () => {
        const r = checkSite(mutate('styles.css', (s) => s + '\n.pv-guard-probe { color: #f5a623; }\n'));
        assert.ok(r.errors.some(x => /^G3 hue: 1 lines in styles\.css hold a colour that is not a kit colour.*styles\.css:\d+ \(#f5a623\)/.test(x)), r.errors.map(x => x.slice(0, 160)).join(' | '));
        const r2 = checkSite(mutate('index.html', (s) => s.replace('<div class="app-container">', '<div class="app-container" data-x="color: orange">')));
        assert.ok(r2.errors.some(x => /^G3 hue: 1 lines in index\.html .*not a kit colour/.test(x)), r2.errors.map(x => x.slice(0, 160)).join(' | '));
    });
});

// ── T8 and T9 on the REAL pages (index.html plus script.js), and the script-drawn primaries of 5.1 and 5.2 ──
const TOUR_SEEN = { pdex_tour_seen_v1: '1' };
const PAGES = {
    home: { path: '' }, validators: { path: 'validators' }, holders: { path: 'holders' }, transactions: { path: 'transactions' }, blocks: { path: 'blocks' }, events: { path: 'events' },
    'not-found': { path: 'no-such-page' }, help: { path: 'help' }, privacy: { path: 'privacy' }, cookies: { path: 'cookies' }, search: { path: 'search' },
    'staking-rewards': { path: 'staking-rewards' }, council: { path: 'council' }, donate: { path: 'donate' },
    'chain-state': { path: 'chain-state' }, decode: { path: 'decode' }, runtime: { path: 'runtime' }, utilities: { path: 'utilities' },
    'email-preferences': { path: 'email-preferences?token=tok', api: { '/api/email/preferences': { email: 'a@b.co', validators: [], events: { commission: true } } } },
    tour: { path: '?tour=1', seed: {}, steps: [{ wait: 1000 }, { dump: '#onboarding-tour-modal' }] },
    'email-alerts': { path: 'democracy', api: { '/api/democracy': { referenda: [], publicProposals: [], referendumCount: 0, status: 'Synced', currentBlock: 100, launchPeriod: 50 } }, steps: [{ click: '[data-email-subscribe="democracy"]' }, { dump: '#email-subscribe-modal' }] }
};
const R = {};
before(async () => {
    const queue = Object.entries(PAGES), done = [];
    await Promise.all([0, 1, 2].map(async () => {
        while (queue.length) {
            const [k, s] = queue.shift();
            done.push([k, await runPage({ seed: TOUR_SEEN, api: {}, ...s, dumpHtml: true })]);
        }
    }));
    for (const [k, r] of done) R[k] = { r, doc: docOf(r.appHtml || ''), dumps: (r.dumps || []).map(d => (d ? docOf(d) : null)) };
}, { timeout: 560000 });
const page = (k) => { assert.ok(R[k] && R[k].doc, `${k}: the page did not load`); return R[k].doc; };
describe('T8, T9 on the real pages: no colour in markup anywhere on the page, at most one drawn primary and it is the gradient', () => {
    for (const k of Object.keys(PAGES)) {
        test(`${k}: no inline colour, background or border anywhere in the rendered document`, () => {
            assert.deepEqual(R[k].r.errors, [], `the ${k} page threw`);
            const offs = [page(k), ...R[k].dumps.filter(Boolean)].flatMap(d => coloured(d.body)).map(describeEl);
            assert.deepEqual(offs, []);
        });
        test(`${k}: at most one primary drawn, and every primary is .validate-primary without .is-solid (no .modal-submit-btn left)`, () => {
            const d = page(k);
            const shown = Array.from(d.querySelectorAll(PRIMARY)).filter(drawn);
            assert.ok(shown.length <= 1, `${shown.length} primaries drawn: ${shown.map(describeEl).join(', ')}`);
            assert.deepEqual(Array.from(d.querySelectorAll('.modal-submit-btn, .is-solid')).map(describeEl), []);
        });
    }
    test('5.1 row 15: Email preferences Save is .validate-primary (was the pink tint .wallet-action-btn.primary), the only primary drawn', () => {
        const b = page('email-preferences').querySelector('#email-prefs-save');
        assert.ok(b, 'no #email-prefs-save');
        assert.ok(cls(b, 'validate-primary') && !cls(b, 'wallet-action-btn'), describeEl(b));
        assert.equal(text(b), 'Save preferences');
    });
    test('5.1 row 12: Email alerts Subscribe is .validate-primary without .is-solid', () => {
        const m = R['email-alerts'].dumps[0];
        assert.ok(m, 'the email alerts dialog did not open');
        const b = m.querySelector('#email-subscribe-submit');
        assert.ok(b && cls(b, 'validate-primary') && !cls(b, 'is-solid'), b ? describeEl(b) : 'no #email-subscribe-submit');
    });
    test('5.1 rows 13, 14, 16: the tour Next, the Reward history Search and the Council Vote are drawn as the page\'s one primary', () => {
        const next = R.tour.dumps[0] && R.tour.dumps[0].querySelector('#onboarding-tour-next');
        assert.ok(next && cls(next, 'validate-primary') && !cls(next, 'is-solid'), next ? describeEl(next) : 'the tour did not open');
        for (const [k, id] of [['staking-rewards', 'staking-search-btn'], ['council', 'council-vote-btn']]) {
            const shown = Array.from(page(k).querySelectorAll(PRIMARY)).filter(drawn);
            assert.deepEqual(shown.map(e => e.id), [id], `${k}: ${shown.map(describeEl).join(', ')}`);
        }
    });
    for (const [k, ids] of [['chain-state', ['cs-run']], ['decode', ['dec-run']], ['runtime', ['rt-run', 'rt-const-run', 'rpc-run']], ['utilities', ['ut-addr-run', 'ut-hash-run', 'ut-vf-run']]]) {
        test(`5.2 A: ${k}: the run buttons (${ids.join(', ')}) are .ui-action; the page has no primary`, () => {
            for (const id of ids) {
                const b = page(k).querySelector('#' + id);
                assert.ok(b, `${k}: no #${id}`);
                assert.ok(cls(b, 'ui-action') && !cls(b, 'wallet-action-btn') && !cls(b, 'primary'), describeEl(b));
            }
            assert.equal(Array.from(page(k).querySelectorAll(PRIMARY)).filter(drawn).length, 0);
        });
    }
    test('5.2 B: Donate: every Copy address is .validate-secondary with bx-copy and keeps its data-address', () => {
        const bs = Array.from(page('donate').querySelectorAll('.donate-copy, [data-address].validate-secondary'));
        assert.ok(bs.length >= 1, 'no copy buttons on the donate page');
        for (const b of bs) assert.ok(cls(b, 'validate-secondary') && b.querySelector('.bx-copy') && b.hasAttribute('data-address') && /Copy address/.test(text(b)), describeEl(b));
    });
});
