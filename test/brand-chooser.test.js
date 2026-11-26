// Brand audit of the Connect wallet chooser (Fable, 16 Nov:
// cto-team/plans/2026-11-16-brand-audit-open-ui.md, section 1 and section 4).
//
// The rule the audit enforces: no new colours, greens only for positive states
// (never for an action), one Primary per view, radii 8/12/16, spacing on the
// 4 px grid, Boxicons at 16/20/24/42 px, captions at 0.82rem.
//
// 1. A lint over ALL of styles.css: a green token on a button, link, row or
//    hover/focus selector fails, with the offending lines in the message. The
//    exceptions are listed by selector with the reason; a new rule anywhere is
//    checked.
// 2. The exact token fixes, selector by selector (C1 to C20).
// 3. The markup: neutral tiles, the count is a state, the QR colours, the
//    relay line on the pairing view, the support block.
// 4. The privacy and cookie pages (texts A to F, dates, names).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo } from './helpers/source.js';
import { tileHtml, buildOptionRowsHtml, buildAccountListHtml, chooseLead } from '../lib/wallet-picker.js';
import { buildGetWalletHtml } from '../lib/wallet-onboarding.js';
import { mountChooser, fakeWallet, fakePhone, acct, addr, same, short } from './helpers/chooser-world.js';
import { PHONE_SOURCE } from '../lib/wallet-sources.js';
import { mountPairingPanel, showDebugReport } from '../lib/walletconnect-view.js';
import { escapeHtml } from '../lib/html-escape.js';
import { Window } from 'happy-dom';

const CSS = readRepo('styles.css', import.meta.url);
const HTML = readRepo('index.html', import.meta.url);
const NOTICES = readRepo('public/THIRD-PARTY-NOTICES.txt', import.meta.url);

// Split a selector list on the commas outside parentheses (:is(a, b) is one selector).
function splitSelectors(head) {
    const out = []; let depth = 0, cur = '';
    for (const ch of head) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

// Every innermost rule: { line, selectors: [..], decls: { prop: value }, media }.
function parseRules(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const rules = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
        const head = m[1].trim();
        if (!head || head.startsWith('@')) continue;
        const before = clean.slice(0, m.index);
        const open = (before.match(/@media[^{]*\{/g) || []).length, depth = before.split('{').length - before.split('}').length;
        const media = depth > 0 && open ? (before.match(/@media[^{]*\{(?![\s\S]*@media)/) || [''])[0] : '';
        const decls = {};
        for (const d of m[2].split(';')) {
            const i = d.indexOf(':');
            if (i < 0) continue;
            decls[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
        }
        rules.push({ line: before.split('\n').length + (m[1].match(/^\s*/)[0].split('\n').length - 1), selectors: splitSelectors(head), decls, media });
    }
    return rules;
}
const RULES = parseRules(CSS);
// The value a selector gets for a property outside any media query (the last
// rule that names it wins, as in the cascade for equal specificity).
function decl(sel, prop) {
    let v;
    for (const r of RULES) if (!r.media && r.selectors.includes(sel) && prop in r.decls) v = r.decls[prop];
    return v;
}
const has = (sel) => RULES.some(r => r.selectors.includes(sel));

describe('lint: greens are for positive states, never for an action', () => {
    const GREEN = /var\(--brand-secondary|var\(--success|var\(--accent-green|#00e676|#14f195/i;   // amended (colour roles WP1): the new green tokens are linted too
    const COLOUR_PROPS = /^(color|background|background-color|border|border-color|border-(top|right|bottom|left)(-color)?|outline|outline-color|box-shadow|text-decoration-color|fill|stroke)$/;
    // Anything a user clicks or focuses: buttons, links, rows, the action and
    // CTA classes, and every hover/focus state.
    const ACTION = /(btn|button|-open\b|-install|-cta|-action|-link|-retry|-check\b|-cancel|-back\b|-row\b|(^|[\s>+~])a(?=$|[\s:.[>+~])|:hover|:focus)/;
    // Exceptions, by exact selector. Positive states stay green (section 0 of
    // the audit); the rest are older rules outside the chooser branch that the
    // audit leaves for a separate site-wide pass (section 5). Nothing else.
    const EXCEPT = new Map([
        ['.connect-wallet-btn.is-connected i', 'positive state: the connected tick in the header'],
        ['.lock-actions-msg.ok', 'positive state: a success message'],
        ['.council-vote-row.is-selected .council-vote-add-icon', 'positive state: the tick on a chosen candidate'],
        ['.wallet-validator-row:hover', 'outside this branch (audit section 5)'],
        ['.donate-btn', 'outside this branch (audit section 5)'],
        ['.md-body a.md-link', 'outside this branch (audit section 5)'],
        ['.md-tool:focus-visible', 'outside this branch (audit section 5)'],
        ['.md-tab:focus-visible', 'outside this branch (audit section 5)'],
        ['.gov-proposal-link', 'outside this branch (audit section 5)'],
        ['.motion-btn.aye', 'outside this branch (audit section 5)'],
        ['.stake-val-add:hover:not(:disabled)', 'outside this branch (audit section 5)'],
        ['.governance-toast-msg:hover', 'outside this branch (audit section 5)'],
        ['.gov-item-link', 'outside this branch (audit section 5)'],
        ['.close-control:focus-visible', 'outside this branch (audit section 5)'],
        ['.referendum-side-btn[data-side="aye"][aria-pressed="true"]', 'choice state: the pressed Aye of the referendum vote (spec 2026-11-26 I34, T5)']
    ]);

    test('no green token on a button, link, row, hover or focus selector anywhere in styles.css', () => {
        const found = [];
        for (const r of RULES) {
            for (const [prop, val] of Object.entries(r.decls)) {
                if (!COLOUR_PROPS.test(prop) || !GREEN.test(val)) continue;
                const bad = r.selectors.filter(s => ACTION.test(s) && !EXCEPT.has(s));
                if (bad.length) found.push(`styles.css:${r.line} ${bad.join(', ')} { ${prop}: ${val} }`);
            }
        }
        assert.deepEqual(found, [], 'green on an action (use the section 0 tokens of the audit):\n  ' + found.join('\n  '));
    });

    test('the lint itself sees what it is meant to see (a green button, link, hover and focus ring are each caught)', () => {
        const probe = parseRules('.x-btn { background: var(--brand-secondary); } .y a { color: var(--success); } .z:hover { border-color: #00E676; } .q:focus-visible { outline: 2px solid var(--brand-secondary); } .ok-badge { color: var(--brand-secondary); }');
        const caught = probe.filter(r => Object.entries(r.decls).some(([p, v]) => COLOUR_PROPS.test(p) && GREEN.test(v)) && r.selectors.some(s => ACTION.test(s))).map(r => r.selectors[0]);
        assert.deepEqual(caught, ['.x-btn', '.y a', '.z:hover', '.q:focus-visible'], 'a positive-state badge is not an action; the other four are');
    });

    test('every exception still exists (a stale exception hides nothing and must go)', () => {
        for (const sel of EXCEPT.keys()) assert.ok(has(sel), sel + ' is excepted but no longer in styles.css');
    });

    test('the three positive states keep their green (audit section 0)', () => {
        assert.match(decl('.wallet-account-badge', 'color'), /--accent-green/);   // amended (colour roles 6.1): the badge is --accent-green
        // The Current row is marked with the brand gradient (contrast pass Revision 3, 5.5); only its badge is green.
        assert.doesNotMatch(decl('.wallet-account-row', 'border'), /--brand-secondary/);
        assert.equal(decl('.wallet-account-row.is-current', 'border'), '1px solid transparent');
        assert.match(decl('.wallet-account-row.is-current', 'background'), /var\(--brand-gradient\) border-box$/);
        assert.doesNotMatch(decl('.wallet-account-row.is-current', 'background'), /--brand-secondary|--success/);
        assert.equal(decl('.wallet-account-row.is-current', 'position'), 'relative');
        assert.equal(decl('.wallet-account-row.is-current', 'overflow'), 'hidden');
        const bar = '.wallet-account-row.is-current::before';
        assert.equal(decl(bar, 'content'), "''");
        for (const [p, v] of [['position', 'absolute'], ['left', '0'], ['top', '0'], ['bottom', '0'], ['width', '3px'], ['background', 'linear-gradient(180deg, var(--brand-primary), var(--violet))'], ['box-shadow', '0 0 10px var(--brand-primary-glow)']]) assert.equal(decl(bar, p), v, bar + ' ' + p);
        assert.match(decl('.wallet-account-badge', 'border'), /--accent-green/);   // amended (colour roles 6.1)
        assert.match(decl('.connect-wallet-btn.is-connected i', 'color'), /--accent-green/);   // amended (fidelity review 6)
    });
});

describe('the chooser CSS, token by token (C1 to C20)', () => {
    const table = [
        // C1 Connect / Install labels are text; the account count is a state.
        ['.wallet-option-action', 'color', 'var(--text-primary)'],
        // amended (colour roles 6.1): the count is a green chip (.ui-chip.is-positive supplies fill and colour), 600, radius 8.
        ['.wallet-option-action.is-count', 'font-weight', '600'],
        ['.wallet-option-action.is-count', 'border-radius', 'var(--radius-sm)'],
        // C2 Open wallet: the one Primary of the phone pairing view (Revision 3: the brand gradient).
        ['.wc-open', 'background', 'var(--brand-gradient)'],
        ['.wc-open', 'color', 'var(--text-primary)'],
        ['.wc-open', 'padding', '8px 16px'],
        ['.wc-open', 'min-height', '44px'],
        // C4 Get a wallet: the one main row (Revision 3: a transparent border over the gradient border-box).
        ['.wallet-option-row.is-primary', 'border-color', 'transparent'],
        // C5 hovers.
        ['.wallet-option-row:hover', 'border-color', 'var(--border-hover)'],
        ['.wallet-option-retry:hover', 'border-color', 'var(--border-hover)'],
        ['.wallet-option-cancel:hover', 'border-color', 'var(--border-hover)'],
        ['.wallet-get-check:hover', 'border-color', 'var(--border-hover)'],
        // C6 focus rings are Primary.
        ['.wallet-picker-head h2:focus-visible', 'outline', '2px solid var(--brand-primary)'],
        ['.wallet-account-btn:focus-visible', 'outline', '2px solid var(--brand-primary)'],
        ['.wallet-option-row:focus-visible', 'outline', '2px solid var(--brand-primary)'],
        ['.wallet-picker-back:focus-visible', 'outline', '2px solid var(--brand-primary)'],
        ['.ms-compact > summary .wp-help-btn:focus-visible', 'outline', '2px solid var(--brand-primary)'],
        ['.wallet-option-row:focus-visible', 'outline-offset', '2px'],
        ['.wallet-picker-back:focus-visible', 'outline-offset', '2px'],
        ['.wallet-picker-search:focus-within', 'border-color', 'var(--brand-primary)'],
        ['.wallet-picker-search:focus-within', 'box-shadow', '0 0 0 2px rgba(230, 0, 122, 0.15)'],
        // C7 (amended, brand pass 3.0) waiting is not positive, so not green: pink is brand emphasis.
        ['.wallet-option-spin', 'color', 'var(--accent-amber)'],   // amended (colour roles 6.1)
        // C8 Approve on your phone.
        ['.wc-pending', 'background', 'var(--bg-surface)'],
        ['.wc-pending', 'border', '1px solid var(--border-hover)'],
        ['.wc-pending .bx', 'color', 'var(--brand-primary)'],
        ['.wc-pending .bx', 'font-size', '24px'],
        // C9 inline links.
        ['.wp-link', 'color', 'var(--text-primary)'],
        ['.wallet-picker-clear-link', 'color', 'var(--text-primary)'],
        ['.wallet-get-actions a', 'color', 'var(--text-primary)'],
        ['.wallet-get-actions a', 'text-decoration', 'underline'],
        ['.wallet-get-create a', 'color', 'var(--text-primary)'],
        ['.wallet-get-actions a:hover', 'color', 'var(--brand-primary)'],
        ['.wallet-empty-msg a', 'color', 'var(--text-primary)'],
        ['.wallet-empty-msg a', 'text-decoration', 'underline'],
        ['.wallet-empty-msg a:hover', 'color', 'var(--brand-primary)'],
        ['.wallet-viewing-note .item-link', 'color', 'var(--text-primary)'],
        ['.wallet-viewing-note .item-link', 'font-weight', '600'],
        ['.wallet-viewing-note .item-link', 'text-decoration', 'underline'],
        ['.wallet-connect-note .item-link', 'color', 'var(--text-primary)'],
        ['.wallet-viewing-note .item-link:hover', 'color', 'var(--brand-primary)'],
        // C12 neutral monogram tiles.
        // (amended, chooser contrast pass Revision 3, 5.3) one gradient tint for every tile, white glyph; quiet rows stay quiet.
        // amended (colour roles 6.1): tiles are typed. The base tile is the violet extension tile; the kind rules are tested in colour-roles.test.js.
        ['.wallet-ext-tile', 'background', 'var(--accent-violet-tint)'],
        ['.wallet-ext-tile', 'border', '1px solid var(--accent-violet-line)'],
        ['.wallet-ext-tile', 'color', 'var(--accent-violet-text)'],
        ['.wallet-ext-tile[data-kind="quiet"]', 'background', 'rgba(255, 255, 255, 0.08)'],
        ['.wallet-ext-tile[data-kind="quiet"]', 'border-color', 'transparent'],
        ['.wallet-ext-tile[data-kind="quiet"]', 'color', 'var(--accent-violet-text)'],
        // C13 the QR stays dark on white, on palette.
        ['.wc-qr', 'background', 'var(--text-primary)'],
        ['.wc-qr-fallback', 'color', 'var(--bg-dark)'],
        // C14 radii.
        ['.wallet-ext-tile', 'border-radius', 'var(--radius-sm)'],
        ['.wallet-ext-tile.is-lg', 'border-radius', 'var(--radius-sm)'],
        // C15 Boxicons at 16/20/24.
        ['.wp-icon-btn', 'font-size', '20px'],
        ['.wallet-account-btn .bx-chevron-right', 'font-size', '20px'],
        ['.wallet-option-row .bx-chevron-right', 'font-size', '20px'],
        ['.wallet-option-spin', 'font-size', '20px'],
        ['.wallet-ext-tile.is-lg.tile-icon', 'font-size', '20px'],
        ['.wallet-picker-empty-icon', 'font-size', '24px'],
        ['.wallet-ext-tile.tile-icon', 'font-size', '16px'],
        // C16 and C17 spacing on the 4 px grid.
        ['.wallet-option-row', 'padding', '12px 16px'],
        ['.wallet-option-main', 'gap', '4px'],
        ['.wallet-option-cancel', 'padding', '8px 12px'],
        ['.wallet-option-problem', 'padding', '8px 4px 4px 16px'],
        ['.wallet-option-retry', 'padding', '8px 16px'],
        ['.wallet-picker-back', 'margin', '-8px 0 8px -8px'],
        ['.wallet-picker-back', 'padding', '0 8px'],
        ['.wallet-onboarding-note', 'margin', '12px 0 8px'],
        ['.wallet-wc-panel', 'margin-top', '12px'],
        ['.wc-pairing', 'gap', '12px'],
        ['.wc-qr', 'padding', '12px'],
        ['.wallet-picker-more > .wallet-picker-disclosure-body', 'padding-left', '16px'],
        ['.wallet-picker-sub', 'margin', '0 0 16px'],
        ['#wallet-accounts', 'gap', '16px'],
        ['.wallet-account-group', 'gap', '8px'],
        ['.wallet-account-list', 'gap', '8px'],
        ['.wallet-account-row', 'padding', '8px 16px'],
        // C18 captions and small controls at 0.82rem.
        ['.wallet-option-action', 'font-size', '0.82rem'],
        ['.wallet-option-problem', 'font-size', '0.82rem'],
        ['.wallet-option-retry', 'font-size', '0.82rem'],
        ['.wallet-get-note', 'font-size', '0.82rem'],
        ['.wallet-get-create', 'font-size', '0.82rem'],
        ['.wallet-picker-back', 'font-size', '0.82rem'],
        ['.wc-steps', 'font-size', '0.82rem'],
        ['.wc-pending', 'font-size', '0.82rem'],
        ['.wallet-viewing-note', 'font-size', '0.82rem'],
        ['.wallet-option-name', 'font-size', '0.95rem']
    ];
    for (const [sel, prop, want] of table) {
        test(`${sel} { ${prop}: ${want} }`, () => {
            assert.equal(decl(sel, prop), want, `${sel} has ${prop}: ${decl(sel, prop)}`);
        });
    }

    test('C6 (amended, brand pass 3.0): the Back focus ring is the outline, with only the Primary halo added (no other shadow)', () => {
        assert.equal(decl('.wallet-picker-back:focus-visible', 'box-shadow'), '0 0 0 3px var(--brand-primary-glow)');
    });

    test('C3: the dead green Refresh and Install styles are deleted, not restyled', () => {
        for (const gone of ['.wallet-picker-install', '.wallet-picker-install-main', '.wallet-picker-refresh-btn.is-primary']) {
            assert.ok(!CSS.includes(gone), gone + ' is still in styles.css');
        }
    });

    test('C11, C12: no coloured monogram tiles (tile-pj, tile-ta, tile-sw, tile-pg, tile-nw, tile-fw, tile-wc)', () => {
        const coloured = RULES.filter(r => r.selectors.some(s => /\.wallet-ext-tile\.tile-(?!icon\b)/.test(s))).map(r => 'styles.css:' + r.line + ' ' + r.selectors.join(', '));
        assert.deepEqual(coloured, []);
    });

    test('C19 (amended, brand pass 3.4, Revision 3 5.6): Reload page is its own gradient rule, out of the shared neutral list, with the 44 px phone height', () => {
        const base = RULES.find(r => !r.media && r.selectors.includes('.wallet-option-retry') && 'padding' in r.decls);
        assert.ok(!base.selectors.includes('.wallet-onboarding-reload'), 'still in the neutral button list');
        assert.equal(decl('.wallet-onboarding-reload', 'background'), 'var(--brand-gradient)');
        assert.equal(decl('.wallet-onboarding-reload', 'border'), '0');
        assert.equal(decl('.wallet-onboarding-reload', 'border-color'), undefined, 'no leftover pink border-color');
        assert.equal(decl('.wallet-onboarding-reload', 'color'), 'var(--text-primary)');
        assert.equal(decl('.wallet-onboarding-reload', 'min-height'), '36px');
        assert.equal(decl('.wallet-onboarding-reload', 'border-radius'), 'var(--radius-sm)');
        assert.ok(RULES.some(r => /max-width: 640px/.test(r.media) && r.selectors.includes('.wallet-picker .wallet-onboarding-reload') && r.decls['min-height'] === '44px'), 'no 44 px on phones');
    });

    test('C20: the ?wcdebug=1 support block is styled with tokens; its buttons are the shared neutral button', () => {
        assert.equal(decl('.wc-debug', 'position'), 'fixed');
        assert.equal(decl('.wc-debug', 'background'), 'var(--bg-surface)');
        assert.equal(decl('.wc-debug', 'border'), '1px solid var(--border-color)');
        assert.equal(decl('.wc-debug', 'border-radius'), 'var(--radius-sm)');
        assert.equal(decl('.wc-debug', 'color'), 'var(--text-secondary)');
        assert.equal(decl('.wc-debug', 'font-size'), '0.82rem');
        assert.equal(decl('.wc-debug', 'padding'), '16px');
        assert.equal(decl('.wc-debug textarea', 'background'), 'var(--bg-dark)');
        assert.equal(decl('.wc-debug textarea', 'color'), 'var(--text-primary)');
        assert.equal(decl('.wc-debug textarea', 'width'), '100%');
        const base = RULES.find(r => !r.media && r.selectors.includes('.wallet-option-retry') && 'padding' in r.decls);
        for (const b of ['.wc-debug-copy', '.wc-debug-close']) assert.ok(base.selectors.includes(b), b + ' is not the neutral button');
    });

    test('the phone Disconnect line follows the 16 px row padding (C17), so it still spans the row', () => {
        const r = RULES.find(x => /max-width: 640px/.test(x.media) && x.selectors.includes('.wallet-picker .wallet-account-row .wallet-disconnect-link'));
        assert.equal(r.decls['flex-basis'], 'calc(100% + 32px)');
        assert.equal(r.decls.margin, '0 -16px -8px');
        assert.equal(r.decls.padding, '0 16px');
    });

    test('no colour comes from an undefined token: every var() in the wallet rules is in :root', () => {
        const root = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')));
        const defined = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
        const start = CSS.indexOf('/* Pages that follow the connected wallet');
        const end = CSS.indexOf('/* Human-readable call arguments');
        assert.ok(start > 0 && end > start, 'the wallet section markers moved');
        const region = CSS.slice(start, end);
        // Revision 3 row-position properties are set on the chooser li, not in :root; each must be declared in the region.
        for (const local of ['--row-border', '--row-hover', '--row-fill', '--row-edge']) {
            assert.match(region, new RegExp(local + ':\\s*(rgba\\(255, 255, 255, 0\\.\\d+\\)|var\\(--(brand-primary|violet)\\))'), local + ' is declared in the wallet rules');
            defined.add(local);
        }
        const missing = [...new Set([...region.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]).filter(t => !defined.has(t)))];
        assert.deepEqual(missing, [], 'undefined tokens render their fallback hex, a new colour');
        const rawHex = region.replace(/var\([^)]*\)/g, '').match(/#[0-9a-f]{3,8}\b/gi) || [];
        assert.deepEqual(rawHex, [], 'raw hex in the wallet rules');
    });

    test('the not-connected note (section 3): a 16 px read-only icon, and a full touch target on phones', () => {
        assert.equal(decl('.wallet-viewing-note.is-readonly .bx', 'font-size'), '16px');
        const r = RULES.find(x => /max-width: 640px/.test(x.media) && x.selectors.includes('.wallet-viewing-note.is-readonly .item-link'));
        assert.ok(r, 'no phone rule for the link');
        assert.equal(r.decls.display, 'inline-block');
        assert.equal(r.decls['min-height'], '44px');
        assert.equal(r.decls['line-height'], '44px');
        assert.ok(RULES.some(x => x.selectors.includes('#wallet-switch-btn[hidden]') && x.decls.display === 'none'), 'a hidden Switch wallet still shows (its button class sets display)');   // message reworded only (sprint 11: the class it named is deleted)
    });
});

// Brand identity pass, section 3 (cto-team/plans/2026-11-17-brand-identity-pass.md):
// the chooser shows Polkadex pink at rest. Tints, edges and halos on every row,
// Solid only where one action is the recommended one.
describe('brand pass: pink on the chooser, by selector and token', () => {
    const TINT08 = 'rgba(230, 0, 122, 0.08)', HALO = '0 0 0 3px var(--brand-primary-glow)';
    // Revision 3 (cto-team/plans/2026-11-18-chooser-contrast-pass.md): the 2 px position edge rides on every row shadow.
    const EDGE_HALO = 'inset 2px 0 0 var(--row-edge, transparent), ' + HALO;
    const OUTLINE = '1px solid rgba(255, 255, 255, 0.24)';
    const LEAD_BG = 'linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)) padding-box, linear-gradient(var(--bg-surface), var(--bg-surface)) padding-box, var(--brand-gradient) border-box';
    const table = [
        // 3.0 shared
        ['.wallet-option-row:hover', 'border-color', 'var(--border-hover)'],
        ['.wallet-option-row:hover', 'box-shadow', EDGE_HALO],
        ['.wallet-account-btn:hover', 'border-color', 'var(--border-hover)'],
        ['.wallet-account-btn:hover', 'box-shadow', EDGE_HALO],
        ['.wallet-option-row:hover .bx-chevron-right', 'color', 'var(--brand-primary)'],
        ['.wallet-account-btn:hover .bx-chevron-right', 'color', 'var(--brand-primary)'],
        ['.wallet-option-row:focus-visible .bx-chevron-right', 'color', 'var(--brand-primary)'],
        ['.wallet-account-btn:focus-visible .bx-chevron-right', 'color', 'var(--brand-primary)'],
        ['.wallet-option-row:focus-visible', 'box-shadow', EDGE_HALO],
        ['.wallet-account-btn:focus-visible', 'box-shadow', EDGE_HALO],
        ['.wallet-picker-back:focus-visible', 'box-shadow', HALO],
        ['.wallet-option-action', 'padding', '4px 12px'],
        ['.wallet-option-action', 'border-radius', '999px'],
        ['.wallet-option-action', 'background', 'transparent'],
        ['.wallet-option-action', 'border', OUTLINE],
        ['.wallet-option-row:hover .wallet-option-action:not(.is-count)', 'border-color', 'var(--brand-primary)'],
        ['.wallet-option-row:focus-visible .wallet-option-action:not(.is-count)', 'border-color', 'var(--brand-primary)'],
        ['.wallet-option-action', 'color', 'var(--text-primary)'],
        ['.wallet-option-action.is-count', 'border', '0'],
        ['.wallet-option-action.is-count', 'padding', '0 8px'],
        // amended (colour roles 6.1): waiting is amber, with no pink halo
        ['.wallet-option.is-waiting .wallet-option-row', 'border-color', 'var(--accent-amber-line)'],
        ['.wallet-option.is-waiting .wallet-option-row', 'box-shadow', 'inset 2px 0 0 var(--row-edge, transparent)'],
        // 3.1 the lead row (Revision 3, 5.4: gradient border, neutral fill, the one gradient action)
        ['.wallet-option-row.is-primary', 'border-color', 'transparent'],
        ['.wallet-option-row.is-primary', 'background', LEAD_BG],
        ['.wallet-option-row.is-primary', 'box-shadow', 'none'],
        ['.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', 'background', 'var(--brand-gradient)'],
        ['.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', 'border', '0'],
        ['.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', 'padding', '5px 13px'],
        ['.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', 'color', 'var(--text-primary)'],
        ['.wallet-option-row.is-primary[data-action="get"] .wallet-ext-tile', 'background', 'var(--brand-gradient)'],
        ['.wallet-option-row.is-primary[data-action="get"] .wallet-ext-tile', 'border', '0'],
        ['.wallet-option-row.is-primary[data-action="get"] .wallet-ext-tile', 'color', 'var(--text-primary)'],
        ['.wallet-option-row.is-primary .bx-chevron-right', 'color', 'var(--brand-primary)'],
        // 3.2 the only account
        ['.wallet-account-btn.is-primary', 'border-color', 'transparent'],
        ['.wallet-account-btn.is-primary', 'background', LEAD_BG],
        ['.wallet-account-btn.is-primary', 'box-shadow', 'none'],
        ['.wallet-account-btn.is-primary .bx-chevron-right', 'color', 'var(--brand-primary)'],
        // 3.3 pairing
        ['.wc-qr', 'box-shadow', '0 0 0 1px var(--border-hover), 0 0 24px var(--brand-primary-glow)'],
        ['.wc-steps li::marker', 'color', 'var(--accent-violet-text)'],   // amended (colour roles 6.2): violet markers
        ['.wc-steps li::marker', 'font-weight', '600'],
        ['.wc-pending', 'box-shadow', '0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 3px var(--brand-primary-glow)'],
        // 3.4 get a wallet
        ['.wallet-option-row:hover .bx-link-external', 'color', 'var(--brand-primary)'],
        ['.wallet-get-check', 'background', 'transparent'],
        ['.wallet-get-check', 'border', OUTLINE],
        ['.wallet-get-check', 'color', 'var(--text-primary)'],
        ['.wallet-get-check:hover', 'background', 'rgba(255, 255, 255, 0.06)'],
        ['.wallet-get-check:hover', 'border-color', 'var(--border-hover)'],
        ['.wallet-get-check:hover', 'box-shadow', HALO],
        // 3.6 the not-connected note
        ['.wallet-viewing-note.is-readonly', 'padding', '12px 16px'],
        ['.wallet-viewing-note.is-readonly', 'border', '1px solid var(--accent-amber-line)'],   // amended (fidelity review 7): the read-only banner is amber
        ['.wallet-viewing-note.is-readonly', 'border-radius', 'var(--radius-sm)'],
        ['.wallet-viewing-note.is-readonly', 'background', 'linear-gradient(var(--accent-amber-wash), var(--accent-amber-wash)), var(--bg-surface)'],
        ['.wallet-viewing-note.is-readonly', 'color', 'var(--text-primary)'],
        ['.wallet-viewing-note.is-readonly .bx', 'color', 'var(--accent-amber)']
    ];
    for (const [sel, prop, want] of table) {
        test(`${sel} { ${prop}: ${want} }`, () => assert.equal(decl(sel, prop), want, `${sel} has ${prop}: ${decl(sel, prop)}`));
    }

    test('primary appears on every element the spec names (a token, the gradient or a Polkadex alpha, never a missing rule)', () => {
        const PINK = /var\(--brand-primary\)|var\(--brand-gradient\)|var\(--border-hover\)|rgba\(230, 0, 122,/;
        const placements = [
            ['.wallet-option-row:hover .wallet-option-action:not(.is-count)', 'border-color'],   // amended (colour roles): the tile fill, the spinner and the pairing markers are role colours now
            ['.wallet-option-row.is-primary', 'background'], ['.wallet-account-btn.is-primary', 'background'],
            ['.wc-qr', 'box-shadow'], ['.wallet-get-check:hover', 'border-color'],
            ['.wallet-onboarding-reload', 'background'], ['.wallet-account-row.is-current', 'background'],
            ['.wallet-account-row.is-current::before', 'background'], ['.wc-open', 'background']   // amended (fidelity review 7): the read-only banner left pink for amber
        ];
        const missing = placements.filter(([s, p]) => !PINK.test(decl(s, p) || '')).map(([s, p]) => `${s} { ${p} }`);
        assert.deepEqual(missing, []);
    });

    test('Solid (a bare var(--brand-primary) fill) is only on the places the spec allows', () => {
        const ALLOWED = new Set([
            '.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', '.wallet-option-row.is-primary[data-action="get"] .wallet-ext-tile',
            '.wallet-onboarding-reload', '.wc-open', '.wallet-account-row.is-current::before'
        ]);
        const found = [];
        for (const r of RULES) {
            for (const p of ['background', 'background-color']) {
                if (r.decls[p] !== 'var(--brand-primary)') continue;
                const bad = r.selectors.filter(s => !ALLOWED.has(s) && /wallet-(option|account|ext|get|onboarding|picker|group)|\.wc-|\.wp-/.test(s));
                if (bad.length) found.push(`styles.css:${r.line} ${bad.join(', ')}`);
            }
        }
        assert.deepEqual(found, [], 'a Solid fill outside the spec:\n  ' + found.join('\n  '));
    });
});

describe('lint: pink is never the colour of small text', () => {
    // Pink on the surface is about 4.1:1, under AA for small text. Icons, markers
    // and fills may be pink; text labels stay --text-primary. A hover or focus
    // colour on a link is the older site-wide idiom and is left to the hover rule.
    // Icon-only elements (a tile that holds one Boxicon, the spinner) are icons.
    const PINK = /var\(--brand-primary\)|#e6007a/i;
    const SCOPE = /wallet-(picker|option|ext|account|group|get|onboarding|viewing|connect|wc)|\.wc-|\.wp-/;
    const iconLike = (sel) => {
        const last = sel.split(/[\s>+~]+/).pop();
        return /^(i|\.bx[\w-]*)(?![\w-])/.test(last) || /\.(tile-icon|wallet-option-spin)$/.test(last) || /^\.wallet-ext-tile\.is-lg\[data-kind="phone"\]$/.test(last)   /* amended: the 20 px phone tile glyph is pink */ || /::(marker|before|after)$/.test(last) || /:(hover|focus|focus-visible|focus-within)/.test(sel);
    };
    const offenders = (rules) => rules.filter(r => PINK.test(r.decls.color || '')).flatMap(r => r.selectors.filter(s => SCOPE.test(s) && !iconLike(s)).map(s => `styles.css:${r.line} ${s} { color: ${r.decls.color} }`));

    test('no chooser or note selector sets a pink text colour (icons, markers and hover states excepted)', () => {
        const found = offenders(RULES);
        assert.deepEqual(found, [], 'pink small text:\n  ' + found.join('\n  '));
    });

    test('the lint sees what it is meant to see (pink text is caught; a Boxicon, a marker and a hover are not)', () => {
        const probe = parseRules('.wallet-option-name { color: var(--brand-primary); } .wallet-ext-tile.tile-icon .bx { color: var(--brand-primary); } .wc-steps li::marker { color: var(--brand-primary); } .wp-link:hover { color: var(--brand-primary); } .wallet-viewing-note { color: #E6007A; }');
        assert.deepEqual(offenders(probe).map(x => x.split(' ')[1]), ['.wallet-option-name', '.wallet-viewing-note']);
    });
});

describe('brand pass: the lead row and the only account (markup)', () => {
    const esc = escapeHtml;
    const ext = (...keys) => keys.map(k => ({ key: k, name: k }));
    const rows = (o) => { const doc = new Window().document; doc.body.innerHTML = `<ul>${buildOptionRowsHtml({ esc, ...o })}</ul>`; return doc; };
    const primaries = (doc) => Array.from(doc.querySelectorAll('.is-primary')).map(e => e.getAttribute('data-source') || e.getAttribute('data-action'));

    test('chooseLead, case 1: nothing installed on a computer, the Get a wallet row (even with a phone row)', () => {
        assert.equal(chooseLead({ sources: [], phone: false, lastSource: '', onMobile: false }), 'get');
        assert.equal(chooseLead({ sources: [], phone: { connected: false }, lastSource: PHONE_SOURCE, onMobile: false }), 'get');
    });
    test('chooseLead, case 2: the wallet used last, if its row is listed', () => {
        assert.equal(chooseLead({ sources: ext('talisman', 'polkadot-js'), phone: false, lastSource: 'talisman' }), 'talisman');
        assert.equal(chooseLead({ sources: ext('talisman', 'polkadot-js'), phone: { connected: false }, lastSource: PHONE_SOURCE }), PHONE_SOURCE);
        assert.equal(chooseLead({ sources: ext('talisman', 'polkadot-js'), phone: false, lastSource: 'subwallet-js' }), '', 'a wallet that is gone leads nothing');
        assert.equal(chooseLead({ sources: ext('talisman', 'polkadot-js'), phone: false, lastSource: PHONE_SOURCE }), '', 'no phone row, no phone lead');
    });
    test('chooseLead, case 3: exactly one row that connects leads', () => {
        assert.equal(chooseLead({ sources: ext('talisman'), phone: false, lastSource: '' }), 'talisman');
        assert.equal(chooseLead({ sources: [], phone: { connected: false }, lastSource: '', onMobile: true }), PHONE_SOURCE);
    });
    test('chooseLead, case 4: several equal wallets and no history lead nothing', () => {
        assert.equal(chooseLead({ sources: ext('talisman', 'polkadot-js'), phone: false, lastSource: '' }), '');
        assert.equal(chooseLead({ sources: ext('talisman'), phone: { connected: false }, lastSource: '' }), '');
    });

    test('the lead row is the only is-primary of the list, in all four cases', () => {
        assert.deepEqual(primaries(rows({ sources: [], phone: { connected: false }, lead: 'get' })), ['get']);
        assert.deepEqual(primaries(rows({ sources: ext('talisman', 'polkadot-js'), lead: 'polkadot-js' })), ['polkadot-js']);
        assert.deepEqual(primaries(rows({ sources: ext('talisman'), lead: 'talisman' })), ['talisman']);
        assert.deepEqual(primaries(rows({ sources: [], phone: { connected: false }, lead: PHONE_SOURCE, onMobile: true })), ['phone']);
        assert.deepEqual(primaries(rows({ sources: ext('talisman', 'polkadot-js'), phone: { connected: false } })), [], 'no lead, no Solid');
    });
    test('every Connect row still carries a tinted tile and a Connect chip, lead or not', () => {
        const doc = rows({ sources: ext('talisman', 'polkadot-js'), phone: { connected: false } });
        for (const row of doc.querySelectorAll('.wallet-option-row')) {
            assert.ok(row.querySelector('.wallet-ext-tile'), 'tile');
            if (row.getAttribute('data-action') !== 'get') assert.equal(row.querySelector('.wallet-option-action').textContent.trim(), 'Connect');
        }
    });
    test('the Get a wallet row is the quiet row unless it is the lead', () => {
        const doc = rows({ sources: ext('talisman', 'polkadot-js') });
        assert.ok(doc.querySelector('[data-action="get"].is-quiet'));
        assert.equal(doc.querySelectorAll('[data-action="get"].is-primary').length, 0);
    });

    const A1 = { address: addr(1), name: 'One', source: 'talisman' }, A2 = { address: addr(2), name: 'Two', source: 'talisman' };
    const list = (o) => { const doc = new Window().document; doc.body.innerHTML = buildAccountListHtml({ isSame: same, esc, shortAddr: short, ...o }); return doc; };
    test('3.2: a wallet that shared exactly one account, in connect mode, marks that row is-primary', () => {
        assert.equal(list({ accounts: [A1], primary: true }).querySelectorAll('.wallet-account-btn.is-primary').length, 1);
    });
    test('3.2: two accounts, no Solid; the choice is the user\'s', () => {
        assert.equal(list({ accounts: [A1, A2], primary: true }).querySelectorAll('.is-primary').length, 0);
    });
    test('3.2: in switch mode (a current account) no account row is primary, whatever the count', () => {
        assert.equal(list({ accounts: [A1, A2], current: A1.address, currentSource: 'talisman', primary: false }).querySelectorAll('.wallet-account-btn.is-primary').length, 0);
        assert.equal(list({ accounts: [A1, A2], current: A1.address, currentSource: 'talisman', primary: true }).querySelectorAll('.wallet-account-btn.is-primary').length, 0, 'a current account is never beside a Solid row');
    });

    const solids = (w) => w.qa('.is-primary').filter(w.visible);
    test('view: nothing installed on a computer: the one is-primary is Get a wallet', async (t) => {
        const w = mountChooser(t, {}); await w.picker.ready;
        assert.deepEqual(solids(w).map(e => e.getAttribute('data-action')), ['get']);
    });
    test('view: one extension, no history: its row is the one is-primary', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('talisman', [acct(10, 'T')])] }); await w.picker.ready;
        assert.deepEqual(solids(w).map(e => e.getAttribute('data-source')), ['talisman']);
    });
    test('view: two extensions, no history: nothing is Solid', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('talisman', [acct(10, 'T')]), fakeWallet('polkadot-js', [acct(11, 'P')])] }); await w.picker.ready;
        assert.deepEqual(solids(w), []);
    });
    test('view: switching with another wallet remembered as last used: Use a different wallet marks no lead beside the Current row', async (t) => {
        const wallets = [fakeWallet('talisman', [acct(10, 'T')]), fakeWallet('polkadot-js', [acct(11, 'P')])];
        const w = mountChooser(t, { wallets, current: addr(11), currentSource: 'polkadot-js', lastSource: 'talisman' }); await w.picker.ready;
        w.q('#wallet-picker-different').click(); await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.deepEqual(solids(w), [], 'the Current row is on screen, so no lead row');
    });
    test('view: one account shared by the one wallet: the account row is the one is-primary', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('talisman', [acct(10, 'T')])] }); await w.picker.ready;
        w.row('talisman').click(); await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        assert.deepEqual(solids(w).map(e => e.className.includes('wallet-account-btn')), [true]);
    });
    test('view: two accounts shared: no row is Solid', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('talisman', [acct(10, 'T'), acct(12, 'U')])] }); await w.picker.ready;
        w.row('talisman').click(); await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'accounts');
        assert.deepEqual(solids(w), []);
    });

    test('3.4: after a failed check Reload page is rendered (the one Solid); before it, no reload button; three Install chips, no Solid among them', () => {
        const doc = new Window().document;
        doc.body.innerHTML = buildGetWalletHtml({ retried: true });
        assert.equal(doc.querySelectorAll('.wallet-onboarding-reload').length, 1);
        doc.body.innerHTML = buildGetWalletHtml({ retried: false });
        assert.equal(doc.querySelectorAll('.wallet-onboarding-reload').length, 0);
        assert.equal(doc.querySelectorAll('a.wallet-option-row .wallet-option-action').length, 3);
        assert.equal(doc.querySelectorAll('.is-primary').length, 0);
    });
});

describe('the chooser markup', () => {
    test('C1: the account count is a state (is-count); Connect and Install are not', () => {
        const html = buildOptionRowsHtml({ sources: [{ key: 'talisman', name: 'Talisman' }, { key: 'polkadot-js', name: 'Polkadot.js' }],
            states: { talisman: { status: 'ok', accounts: [{}, {}] } }, phone: { connected: true, count: 1 }, esc: escapeHtml });
        const doc = new Window().document;
        doc.body.innerHTML = `<ul>${html}</ul>`;
        const act = (q) => doc.querySelector(q + ' .wallet-option-action');
        assert.ok(act('[data-source="talisman"]').classList.contains('is-count'), '2 accounts');
        assert.ok(act('[data-action="phone"]').classList.contains('is-count'), '1 account on the phone row');
        assert.ok(!act('[data-source="polkadot-js"]').classList.contains('is-count'), 'Connect');
        const onboarding = readRepo('lib/wallet-onboarding.js', import.meta.url);
        assert.match(onboarding, /<span class="wallet-option-action"><i class='bx bx-link-external' aria-hidden="true"><\/i> Install<\/span>/, 'Install stays a plain action label (amended, colour roles 6.2: it carries the link icon)');
    });

    test('C11: the phone group head uses the neutral phone icon, not a blue WC monogram', () => {
        const tile = tileHtml(PHONE_SOURCE, escapeHtml);
        assert.match(tile, /class="wallet-ext-tile tile-icon"/);
        assert.match(tile, /bx-mobile/);
        assert.ok(!/>WC</.test(tile));
        assert.ok(!/'walletconnect': 'WC'/.test(readRepo('lib/wallet-picker.js', import.meta.url)));
    });

    test('C13: the QR is drawn in --bg-dark on white', () => {
        const src = readRepo('lib/walletconnect-view.js', import.meta.url);
        assert.match(src, /colorDark: '#08080C'/);
        assert.ok(!src.includes('#0d0d12'));
    });

    test('C23 / text F: the pairing view says who carries the connection, under the status line, with a link to the privacy page', () => {
        const doc = new Window().document;
        const el = doc.createElement('div');
        doc.body.appendChild(el);
        mountPairingPanel(el, { uri: 'wc:abc@2?relay-protocol=irn&symKey=00', onMobile: false, clipboard: {}, onCancel() {} });
        const note = el.querySelector('.wc-status + .wallet-get-note');
        assert.ok(note, 'no note right under the status line');
        assert.equal(note.textContent.replace(/\s+/g, ' ').trim(), 'Connects through the WalletConnect relay, run by Reown. It sees your IP address, not your keys or the contents of what you sign. Privacy');
        assert.equal(note.querySelector('a').getAttribute('href'), '/privacy');
        assert.equal(note.querySelector('a').textContent, 'Privacy');
        // A new tab: the router takes any same-tab /path click, which would leave
        // the chooser and lose the QR code halfway through pairing.
        assert.equal(note.querySelector('a').getAttribute('target'), '_blank');
        assert.equal(note.querySelector('a').getAttribute('rel'), 'noopener');
    });

    test('C20: the support block keeps its class names for the stylesheet', () => {
        const doc = new Window().document;
        const box = showDebugReport(doc, { text: 'x', clipboard: {} });
        assert.ok(box.classList.contains('wc-debug'));
        assert.ok(box.querySelector('textarea') && box.querySelector('.wc-debug-copy') && box.querySelector('.wc-debug-close'));
    });
});

describe('privacy and cookie pages (audit section 4)', () => {
    const page = (name) => {
        const start = HTML.indexOf(`data-page="${name}"`);
        return HTML.slice(start, HTML.indexOf('<!--', start + 1) > 0 ? HTML.indexOf('<!--', start + 1) : undefined);
    };
    const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const PRIVACY = page('privacy'), COOKIES = page('cookies');

    test('A: section 4, the WalletConnect bullet says exactly what the SDK sends', () => {
        const t = text(PRIVACY);
        for (const s of [
            'The WalletConnect relay (relay.walletconnect.org, run by Reown, Inc.), only if you connect a phone wallet from the Connect wallet page (the "Phone wallet" option; "Wallet app" on a phone).',
            'Your browser and your wallet app talk through this relay. The messages are end-to-end encrypted: the relay cannot read your accounts, your keys, or what you sign.',
            'It does see your IP address, that the connection comes from explorer.polkadex.ee, your browser and operating system, our project id, a random id your browser makes the first time and reuses on later connections, and the size and timing of the messages.',
            'When the explorer asks your wallet to sign, the relay also sees whether it is a transaction or a message and for which chain, and your wallet app may add the hash of the signed transaction, which matches it to that transaction once it is on chain.',
            'While your phone wallet stays connected, the explorer contacts the relay each time you open a page, so the connection keeps working. Choose "End connection" or "Disconnect" and it stops.',
            'If you never use the phone option, no WalletConnect code is loaded and your browser never contacts the relay.',
            'We have switched off the library\'s usage reporting to Reown, and our Content-Security-Policy blocks its other services.'
        ]) assert.ok(t.includes(s), 'missing: ' + s);
        assert.ok(!t.includes('the relay is never contacted unless you choose it'), 'the old sentence (false for returning users) is still there');
    });

    test('B: the short version names the one exception', () => {
        assert.ok(text(PRIVACY).includes('One exception to "nothing leaves this site": if you connect a phone wallet, your browser talks to the WalletConnect relay, run by Reown. It carries encrypted messages and sees your IP address. It is off unless you choose it. See section 4.'));
        const short = PRIVACY.slice(PRIVACY.indexOf('Short version'), PRIVACY.indexOf('1. Who we are'));
        assert.match(short, /One exception/);
    });

    test('C: section 3 does not assume an extension', () => {
        assert.ok(text(PRIVACY).includes('If you connect a wallet, the explorer reads your account\'s public address from it: from your browser extension, or from your phone wallet over WalletConnect.'));
        assert.ok(!text(PRIVACY).includes('reads your account\'s public address from your wallet extension'));
    });

    test('D: section 4 names the two hosts the CSP lets the browser connect to', () => {
        assert.ok(text(PRIVACY).includes('The same policy lets your browser open a connection to exactly two other hosts: rpc.polkadex.ee (our own node, for live blocks and for sending what you sign) and relay.walletconnect.org (only if you connect a phone wallet, as described above).'));
    });

    test('D agrees with the CSP: connect-src admits exactly those two outside hosts', () => {
        const conf = readRepo('nginx.conf', import.meta.url);
        const policies = [...conf.matchAll(/add_header Content-Security-Policy "[^"]*connect-src ([^;]+);/g)];
        assert.ok(policies.length >= 2, 'the two server blocks');
        for (const m of policies) {
            const hosts = [...new Set(m[1].trim().split(/\s+/).filter(s => /^(https?|wss?):/.test(s)).map(s => s.replace(/^\w+:\/\//, '')))].sort();
            assert.deepEqual(hosts, ['relay.walletconnect.org', 'rpc.polkadex.ee'], m[0]);
        }
    });

    test('E: the cookie notice says one bundled library contacts an outside server, with the two links', () => {
        const t = text(COOKIES);
        assert.ok(t.includes('We do not set any tracking cookies. We do not load Google Analytics, Mixpanel, Segment, advertising pixels, or any other analytics or tracking script. Every script runs from explorer.polkadex.ee; none is loaded from another site. The open-source libraries we bundle are listed under Licenses. One of them, WalletConnect, contacts an outside server, and only if you connect a phone wallet. See the Privacy Policy, section 4.'));
        assert.match(COOKIES, /<a href="\/THIRD-PARTY-NOTICES\.txt"[^>]*>Licenses<\/a>/);
        assert.match(COOKIES, /<a href="\/privacy"[^>]*>Privacy Policy<\/a>, section 4\./);
        assert.ok(!t.includes('There are no third-party scripts in the explorer\'s HTML'));
    });

    test('P6: both pages say Last updated: November 2026', () => {
        assert.match(PRIVACY, /Last updated: November 2026/);
        assert.match(COOKIES, /Last updated: November 2026/);
        assert.ok(!/Last updated: June 2026/.test(HTML));
    });

    test('P7: section 4 is a real list with no dash bullets, and Contact is section 9', () => {
        const s4 = PRIVACY.slice(PRIVACY.indexOf('4. Third-party services'), PRIVACY.indexOf('5. Email alerts'));
        assert.match(s4, /<ul[^>]*>/);
        assert.equal((s4.match(/<li[\s>]/g) || []).length, 5);
        assert.ok(!/[\u2013\u2014]/.test(s4), 'en or em dash in section 4');
        assert.match(PRIVACY, /9\. Contact/);
        assert.ok(!/8\. Contact/.test(PRIVACY));
    });

    test('P8 / C22: the pages and the licence notice name the control as it is on screen', () => {
        assert.ok(!HTML.includes('Connect with your phone'), 'index.html');
        assert.ok(!NOTICES.includes('Connect with your phone'), 'THIRD-PARTY-NOTICES.txt');
        assert.ok(NOTICES.includes('the Phone wallet option'));
        assert.ok(COOKIES.includes('the Phone wallet option'));
    });

    // Amended in sprint 11 WP3 (spec 2.2 P12): the legal pages carry no inline colour; every code in the body takes
    // .legal-body code (the violet text token of .ui-code), so none of these keys is green. The rows and the keys are pinned
    // in the markup, the colour in the stylesheet.
    test('C10: the WalletConnect rows of the cookie table name their keys in plain text, not green', () => {
        for (const key of ['pdex_wc_enabled', 'pdex_wc_debug', 'pdex_wc_session', 'wc@2:*']) {
            const m = COOKIES.match(new RegExp('<code>' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</code>'));
            assert.ok(m, key + ' row not found (a code with no style)');
        }
        assert.equal(decl('.legal-body code', 'color'), 'var(--accent-violet-text)');
    });

    test('no em or en dash in the new texts', () => {
        const s4 = PRIVACY.slice(PRIVACY.indexOf('4. Third-party services'), PRIVACY.indexOf('5. Email alerts'));
        const short = PRIVACY.slice(PRIVACY.indexOf('Short version'), PRIVACY.indexOf('1. Who we are'));
        const notStore = COOKIES.slice(COOKIES.indexOf('What we do NOT store'), COOKIES.indexOf('Sessions</h2>'));
        // Section 3's first paragraph carries text C, so the whole paragraph is held to the rule.
        const s3 = PRIVACY.slice(PRIVACY.indexOf('3. Wallet addresses and signatures'), PRIVACY.indexOf('4. Third-party services'));
        for (const [name, s] of [['section 3', s3], ['section 4', s4], ['short version', short], ['what we do not store', notStore]]) assert.ok(!/[\u2013\u2014]/.test(s), name);
    });
});

// Chooser contrast pass, Revision 3 (Fable, cto-team/plans/2026-11-18-chooser-contrast-pass.md),
// superseding Revision 2: neutral rows, the alternation as a 2 px left edge (Primary odd, Violet
// even) set once on the li as custom properties, and --brand-gradient only on the Current row, the
// lead row and the one primary action. The checks are functions of a CSS string so the
// proof-of-failure test (10) can run them against broken copies.
describe('chooser contrast pass: neutral rows, brand colour as accent (revision 3)', () => {
    const WHITE = [255, 255, 255], SECONDARY = [0x9C, 0xA3, 0xAF], PINK = [230, 0, 122], VIOLET = [103, 69, 210], GREEN = [0, 0xE6, 0x76], SURFACE = [0x12, 0x12, 0x1A];
    const GRADIENT = 'linear-gradient(47.94deg, var(--brand-primary) 0%, var(--violet) 98.88%)';
    const TILE_TINT = 'linear-gradient(47.94deg, rgba(230, 0, 122, 0.22) 0%, rgba(103, 69, 210, 0.22) 98.88%)';
    const OPT_LI = '.wallet-option-list > .wallet-option', ACC_LI = '#wallet-accounts .wallet-account-list > li';
    const POS = [
        [[OPT_LI, ACC_LI], { '--row-border': 'rgba(255, 255, 255, 0.12)', '--row-hover': 'rgba(255, 255, 255, 0.09)' }],
        // amended (colour roles 6.1, R7): option rows keep the fill step by position, their edge comes from data-kind; only account lists alternate pink and violet
        [[OPT_LI + ':nth-child(odd)'], { '--row-fill': 'rgba(255, 255, 255, 0.03)' }],
        [[OPT_LI + ':nth-child(even)'], { '--row-fill': 'rgba(255, 255, 255, 0.06)' }],
        [[ACC_LI + ':nth-child(odd)'], { '--row-fill': 'rgba(255, 255, 255, 0.03)', '--row-edge': 'var(--brand-primary)' }],
        [[ACC_LI + ':nth-child(even)'], { '--row-fill': 'rgba(255, 255, 255, 0.06)', '--row-edge': 'var(--violet)' }]
    ];
    const ROW = /\.wallet-(option-row|account-btn|account-row)(?![\w-])[^\s>+~]*$/;
    const msg = (e) => e.join('\n');
    const lineOf = (rules, sel) => { const r = rules.filter(x => !x.media && x.selectors.includes(sel)).pop(); return r ? r.line : -1; };
    const declOf = (rules, sel, prop) => { let v; for (const r of rules) if (!r.media && r.selectors.includes(sel) && prop in r.decls) v = r.decls[prop]; return v; };
    const layers = (v) => splitSelectors(v || '');

    // Check 2: the three position rules, once each, outside media queries, exactly these declarations.
    function checkPosition(css) {
        const rules = parseRules(css), err = [];
        for (const [sels, want] of POS) {
            const hit = rules.filter(r => JSON.stringify(r.selectors) === JSON.stringify(sels));
            if (hit.length !== 1) { err.push(`position rule "${sels.join(', ')}" found ${hit.length} times, wanted 1`); continue; }
            if (hit[0].media) err.push(`position rule "${sels.join(', ')}" is inside a media query`);
            if (JSON.stringify(hit[0].decls) !== JSON.stringify(want)) err.push(`position rule "${sels.join(', ')}" must declare ${JSON.stringify(want)}, has ${JSON.stringify(hit[0].decls)}`);
        }
        return err;
    }
    // Check 3: Revision 2 is gone. No :nth-child rule paints a background or a border colour, none of
    // its alphas remain, and no :where( stripe rule remains.
    function checkRemoved(css) {
        const rules = parseRules(css), err = [];
        for (const r of rules) for (const s of r.selectors) {
            // The key-value tables of the detail pages keep their row stripe as a class (spec 2026-11-26 2.1, P16); not the chooser.
            if (s === 'table.ui-kv tr:nth-child(even)') continue;
            if (/nth-child/.test(s) && ['background', 'background-color', 'border-color'].some(p => p in r.decls)) err.push(`styles.css:${r.line} "${s}" is an :nth-child rule with a background or border-color`);
            if (/:where\(/.test(s) && /wallet-(option|account)/.test(s)) err.push(`styles.css:${r.line} "${s}" is a :where( stripe rule`);
        }
        // Scoped to the chooser (other pages use these alphas for their own badges); the one exemption
        // is the Revision 3 tile tint itself, whose violet stop is 0.22 by the spec (section 4).
        const CHOOSER = /wallet-(option|account|ext|get|onboarding|picker|group)|\.wc-|\.wp-/;
        for (const gone of ['rgba(230, 0, 122, 0.10)', 'rgba(230, 0, 122, 0.16)', 'rgba(103, 69, 210, 0.14)', 'rgba(103, 69, 210, 0.22)', 'rgba(103, 69, 210, 0.32)']) {
            for (const r of rules) for (const [p, v] of Object.entries(r.decls)) {
                if (!v.includes(gone) || !r.selectors.some(s => CHOOSER.test(s))) continue;
                if (p === 'background' && v === TILE_TINT && r.selectors.length === 1 && r.selectors[0] === '.wallet-ext-tile') continue;
                err.push(`styles.css:${r.line} "${r.selectors.join(', ')}" { ${p}: ${v} } uses the Revision 2 alpha ${gone}`);
            }
        }
        return err;
    }
    // Check 4: fill guard. Every background on a row (and its hover) is the position variable, the
    // hover variable or a white alpha at or under 0.10. Exclusion list, not allowlist: only the lead
    // and Current rows may differ (tiles, the pill and the buttons are not rows).
    const WHITE_FILL = /^(none|transparent|rgba\(255, 255, 255, 0?\.(\d+)\)|var\(--row-(fill|hover), rgba\(255, 255, 255, 0?\.(\d+)\)\))$/;
    function checkFills(css) {
        const rules = parseRules(css), err = [];
        for (const r of rules) for (const s of r.selectors) {
            if (!ROW.test(s) || /\.is-(primary|current)/.test(s)) continue;
            for (const p of ['background', 'background-color']) {
                const v = r.decls[p]; if (v === undefined) continue;
                const m = v.match(WHITE_FILL);
                const a = m ? Number('0.' + (m[2] || m[4] || '0')) : NaN;
                if (!m || a > 0.10) err.push(`styles.css:${r.line} "${s}" { ${p}: ${v} } is not a neutral row fill (row-fill, row-hover or white at most 0.10)`);
            }
        }
        return err;
    }
    // Check 5: lead and Current are three layers over the opaque surface with a gradient border-box.
    const LEADS = ['.wallet-option-row.is-primary', '.wallet-account-btn.is-primary', '.wallet-account-row.is-current'];
    function checkLayers(css) {
        const rules = parseRules(css), err = [];
        for (const sel of LEADS) {
            const l = layers(declOf(rules, sel, 'background'));
            if (l.length !== 3) err.push(`"${sel}" background has ${l.length} layers, wanted 3`);
            if (l[1] !== 'linear-gradient(var(--bg-surface), var(--bg-surface)) padding-box') err.push(`"${sel}" middle layer must be the opaque --bg-surface padding-box, is ${l[1]}`);
            if (l[2] !== 'var(--brand-gradient) border-box') err.push(`"${sel}" last layer must be var(--brand-gradient) border-box, is ${l[2]}`);
            const bc = declOf(rules, sel, 'border-color'), b = declOf(rules, sel, 'border');
            if (!(bc === 'transparent' || (b === '1px solid transparent' && bc === undefined))) err.push(`"${sel}" border must be transparent (border-color ${bc}, border ${b})`);
            if (declOf(rules, sel, 'box-shadow') !== 'none') err.push(`"${sel}" must set box-shadow: none (no coloured edge on the lead or Current)`);
        }
        const bar = declOf(rules, '.wallet-account-row.is-current::before', 'background') || '';
        if (!/^linear-gradient\(180deg, var\(--brand-primary\), var\(--violet\)\)$/.test(bar)) err.push(`".wallet-account-row.is-current::before" bar must be the Primary to Violet gradient, is ${bar}`);
        return err;
    }
    // Check 6: the gradient as a foreground fill (any layer not clipped to the border-box) only on the one primary action of a view.
    // Amended in sprint 11 WP3b (Q3, approved 2026-11-26, spec 5.1 rows 1 and 17): the top bar's Connect Wallet and the confirm
    // dialog's action are the primary of their view and take the gradient.
    const PRIMARIES = ['.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', '.wallet-option-row.is-primary[data-action="get"] .wallet-ext-tile', '.wallet-onboarding-reload', '.wc-open',
        '.connect-wallet-btn', '.confirm-dialog-actions .confirm-dialog-danger',
        // Amended in sprint 11 (designer follow-up, CEO colour roles): the mobile wallet panel's call to action is the primary of that panel.
        '.mobile-wallet-cta'];
    // amended (colour roles 2.4): the gradient is also the page-header tile, the hairline and .validate-primary (the shared Primary); none is a wallet row or pill
    const NON_ACTION_GRADIENT = ['.ui-tile.is-brand', '.ui-hairline::before', '.validate-primary'];
    function checkOnePrimary(css) {
        const rules = parseRules(css), err = [];
        for (const r of rules) for (const p of ['background', 'background-image']) {
            const v = r.decls[p]; if (!v) continue;
            if (!layers(v).some(x => x.includes('var(--brand-gradient)') && !/border-box$/.test(x))) continue;
            for (const s of r.selectors) if (!PRIMARIES.includes(s) && !NON_ACTION_GRADIENT.includes(s)) err.push(`styles.css:${r.line} "${s}" fills with var(--brand-gradient), which is for the one primary action only`);
        }
        for (const s of PRIMARIES) if (declOf(rules, s, 'background') !== 'var(--brand-gradient)') err.push(`"${s}" must fill with var(--brand-gradient), has ${declOf(rules, s, 'background')}`);
        return err;
    }
    // Check 7: order. Equal specificity is decided by position.
    function checkOrder(css) {
        const rules = parseRules(css), err = [];
        const after = (a, earlier) => { const s = lineOf(rules, a); for (const sel of earlier) { const l = lineOf(rules, sel); if (s < 0 || l < 0 || s <= l) err.push(`rule "${a}" (line ${s}) must come after "${sel}" (line ${l})`); } };
        after('.wallet-option-row.is-primary', ['.wallet-option-row', '.wallet-option-row:hover', '.wallet-option-row:focus-visible']);
        after('.wallet-account-btn.is-primary', ['.wallet-account-btn', '.wallet-account-btn:hover', '.wallet-account-btn:focus-visible', '.wallet-account-list .wallet-account-btn']);
        after('.wallet-account-row.is-current', ['.wallet-account-row', '.wallet-account-list .wallet-account-btn']);
        return err;
    }

    test('1: :root declares --violet #6745D2 and --brand-gradient with the exact value, and no other new custom property', () => {
        const root = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')));
        const names = [...root.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]);
        assert.match(root, /--violet:\s*#6745D2\s*;/);
        assert.equal((root.match(/--brand-gradient:\s*([^;]+);/) || [])[1], GRADIENT);
        // amended (colour roles 2.2): the 24 role tokens are the only other custom properties; they are tested in colour-roles.test.js
        const ROLE = /^--(accent-(violet|green|amber|blue|red|pink)(-(text|tint|line|wash))?|warning)$/;
        assert.deepEqual(names.filter(n => !ROLE.test(n)).filter(n => !['--brand-primary', '--brand-secondary', '--brand-primary-glow', '--bg-dark', '--bg-surface', '--bg-glass', '--border-color', '--border-hover', '--text-primary', '--text-secondary', '--text-muted', '--success', '--error', '--radius-sm', '--radius-md', '--radius-lg', '--sidebar-width', '--transition-fast', '--transition-normal'].includes(n)), ['--violet', '--brand-gradient']);
        assert.match(root, /--violet:[^\n]*gradient endpoint and even-row edge in the wallet chooser/);
    });
    test('2: the three position rules exist outside any media query with exactly the values (odd 0.03 + Primary, even 0.06 + Violet)', () => {
        assert.deepEqual(checkPosition(CSS), [], msg(checkPosition(CSS)));
    });
    test('3: removal guard, no Revision 2 stripe or lift remains', () => {
        assert.deepEqual(checkRemoved(CSS), [], msg(checkRemoved(CSS)));
        assert.equal(declOf(RULES, '.wallet-option-row.is-quiet', 'background'), undefined);
        assert.equal(declOf(RULES, '.wallet-option-row.is-quiet', 'color'), 'var(--text-secondary)');
        assert.equal(declOf(RULES, '.wallet-option-row[data-kind="quiet"]', '--row-edge'), 'transparent', 'quiet rows keep their neutral step but no coloured edge (amended: by data-kind)');
        assert.equal(declOf(RULES, '.wallet-option-row.is-quiet .wallet-option-name', 'font-weight'), '500');
    });
    test('4: fill guard, every row background is neutral (lead and Current excepted); the rows read the position variables', () => {
        assert.deepEqual(checkFills(CSS), [], msg(checkFills(CSS)));
        const EDGE = 'inset 2px 0 0 var(--row-edge, transparent)', HALO = '0 0 0 3px var(--brand-primary-glow)';
        assert.equal(declOf(RULES, '.wallet-option-row', 'background'), 'var(--row-fill, rgba(255, 255, 255, 0.03))');
        assert.equal(declOf(RULES, '.wallet-option-row', 'border'), '1px solid var(--row-border, var(--border-color))');
        assert.equal(declOf(RULES, '.wallet-option-row', 'box-shadow'), EDGE);
        assert.equal(declOf(RULES, '.wallet-account-row', 'background'), 'var(--row-fill, rgba(255, 255, 255, 0.03))');
        assert.equal(declOf(RULES, '.wallet-account-row', 'border'), '1px solid var(--row-border, var(--border-color))');
        assert.equal(declOf(RULES, '.wallet-account-btn', 'background'), 'var(--row-fill, rgba(255, 255, 255, 0.03))');
        assert.equal(declOf(RULES, '.wallet-account-btn', 'border'), '1px solid var(--row-border, var(--border-color))');
        assert.equal(declOf(RULES, '.wallet-account-list .wallet-account-btn', 'box-shadow'), EDGE);
        assert.equal(declOf(RULES, '.wallet-account-row', 'box-shadow'), EDGE);
        for (const sel of ['.wallet-option-row:hover', '.wallet-account-btn:hover']) {
            assert.equal(declOf(RULES, sel, 'background'), 'var(--row-hover, rgba(255, 255, 255, 0.05))', sel);
            assert.equal(declOf(RULES, sel, 'border-color'), 'var(--border-hover)', sel);
            assert.equal(declOf(RULES, sel, 'box-shadow'), `${EDGE}, ${HALO}`, sel);
        }
        for (const sel of ['.wallet-option-row:focus-visible', '.wallet-account-btn:focus-visible']) assert.equal(declOf(RULES, sel, 'box-shadow'), `${EDGE}, ${HALO}`, sel);
    });
    test('5: lead and Current are three layers over the opaque surface with the gradient border-box; the Current bar runs Primary to Violet', () => {
        assert.deepEqual(checkLayers(CSS), [], msg(checkLayers(CSS)));
        assert.equal(layers(decl('.wallet-account-row.is-current', 'background'))[0], 'linear-gradient(90deg, rgba(103, 69, 210, 0.16) 0%, rgba(103, 69, 210, 0.04) 60%, rgba(103, 69, 210, 0) 100%) padding-box');
        for (const sel of ['.wallet-option-row.is-primary', '.wallet-account-btn.is-primary']) assert.equal(layers(decl(sel, 'background'))[0], 'linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05)) padding-box', sel);
        assert.equal(decl('.wallet-account-row.is-current::before', 'width'), '3px');
        assert.match(decl('.wallet-account-badge', 'color'), /--accent-green/);   // amended (colour roles 6.1)
        for (const sel of ['.wallet-option-row.is-primary', '.wallet-account-btn.is-primary']) {
            const r = RULES.find(x => !x.media && x.selectors.includes(sel + ':hover') && x.selectors.includes(sel + ':focus-visible'));
            assert.ok(r, sel + ' needs a hover and focus-visible rule');
            assert.equal(r.decls['box-shadow'], '0 0 0 3px var(--brand-primary-glow)', sel);
        }
    });
    test('6: one primary, the gradient fills only the lead pill, the lead Get tile, Reload page and Open wallet', () => {
        assert.deepEqual(checkOnePrimary(CSS), [], msg(checkOnePrimary(CSS)));
    });
    test('6b: rendered, switch mode (the Current row on screen) shows no is-primary', async (t) => {
        const w = mountChooser(t, { wallets: [fakeWallet('talisman', [acct(10, 'T'), acct(12, 'U')]), fakeWallet('polkadot-js', [acct(11, 'P')])], current: addr(10), currentSource: 'talisman', lastSource: 'talisman' });
        await w.picker.ready;
        assert.equal(w.qa('.wallet-account-row.is-current').filter(w.visible).length, 1, 'the Current row is on screen');
        assert.deepEqual(w.qa('.is-primary').filter(w.visible), []);
        w.q('#wallet-picker-different').click(); await w.settle();
        assert.equal(w.q('section.wallet-picker').getAttribute('data-view'), 'options');
        assert.equal(w.qa('.wallet-account-row.is-current').filter(w.visible).length, 1, 'the Current row is still on screen');
        assert.deepEqual(w.qa('.is-primary').filter(w.visible), [], 'no lead row beside the Current row after Use a different wallet');
    });
    test('5b: a waiting lead row lets the gradient border win: no pink border, no left edge', () => {
        const i = RULES.findIndex(r => !r.media && r.selectors.includes('.wallet-option-row.is-primary'));
        const j = RULES.findIndex(r => !r.media && r.selectors.includes('.wallet-option.is-waiting .wallet-option-row.is-primary'));
        assert.ok(j > i, 'a waiting-lead rule after the lead rule');
        assert.equal(RULES[j].decls['border-color'], 'transparent');
        assert.equal(RULES[j].decls['box-shadow'], '0 0 0 3px var(--brand-primary-glow)');
    });
    test('7: order guard, the lead rules come after their hover rules and Current after the row base', () => {
        assert.deepEqual(checkOrder(CSS), [], msg(checkOrder(CSS)));
    });
    test('7b: forced colours keep the lead, Current and the primary actions visible', () => {
        const fc = RULES.filter(r => /forced-colors: active/.test(r.media));
        const find = (sel, prop) => (fc.find(r => r.selectors.includes(sel) && prop in r.decls) || { decls: {} }).decls[prop];
        for (const sel of LEADS) { assert.equal(find(sel, 'background'), 'Canvas', sel); assert.equal(find(sel, 'border-color'), 'Highlight', sel); }
        for (const sel of ['.wallet-option-row.is-primary .wallet-option-action:not(.is-count)', '.wallet-onboarding-reload', '.wc-open']) { assert.equal(find(sel, 'background'), 'Highlight', sel); assert.equal(find(sel, 'color'), 'HighlightText', sel); }
    });
    test('8: Violet is never a text colour (and the lint sees one)', () => {
        const violetText = (rules) => rules.filter(r => /var\(--violet\)|103, 69, 210/.test(r.decls.color || '')).map(r => `styles.css:${r.line} ${r.selectors.join(', ')} { color: ${r.decls.color} }`);
        const found = violetText(RULES);
        assert.deepEqual(found, [], 'violet text:\n  ' + found.join('\n  '));
        const probe = violetText(parseRules('.wallet-option-name { color: var(--violet); } .wallet-option-sub { color: rgba(103, 69, 210, 0.9); } .wallet-ext-tile { background: var(--violet); }'));
        assert.deepEqual(probe.map(x => x.split(' ')[1]), ['.wallet-option-name', '.wallet-option-sub']);
    });
    test('9: contrast guard, recomputed over #12121A', () => {
        const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
        const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        const over = (rgb, a) => rgb.map((c, i) => c * a + SURFACE[i] * (1 - a));
        assert.equal(CSS.match(/--bg-surface:\s*(#[0-9a-fA-F]{6})/)[1].toUpperCase(), '#12121A');
        const fills = [['Row A 0.03', over(WHITE, 0.03)], ['Row B 0.06', over(WHITE, 0.06)], ['Row hover 0.09', over(WHITE, 0.09)], ['Lead 0.05', over(WHITE, 0.05)], ['Current wash violet 0.16', over(VIOLET, 0.16)]];
        const fail = [];
        for (const [name, bg] of fills) {
            if (ratio(WHITE, bg) < 4.5) fail.push(`white on ${name}: ${ratio(WHITE, bg).toFixed(2)}`);
            if (ratio(SECONDARY, bg) < 4.5) fail.push(`--text-secondary on ${name}: ${ratio(SECONDARY, bg).toFixed(2)}`);
            if (ratio(PINK, bg) < 3) fail.push(`--brand-primary on ${name}: ${ratio(PINK, bg).toFixed(2)}`);
        }
        for (const [name, rgb] of [['#E6007A', PINK], ['#6745D2', VIOLET]]) if (ratio(WHITE, rgb) < 4.5) fail.push(`white on ${name}: ${ratio(WHITE, rgb).toFixed(2)}`);
        if (ratio(GREEN, over(VIOLET, 0.16)) < 4.5) fail.push('green badge on the Current wash');
        assert.deepEqual(fail, []);
        // the spec's hand figures (section 7) agree within 0.2
        for (const [bg, want] of [[over(WHITE, 0.03), 17.5], [over(WHITE, 0.06), 16.1], [over(WHITE, 0.09), 14.8], [over(VIOLET, 0.16), 16.6]]) assert.ok(Math.abs(ratio(WHITE, bg) - want) <= 0.2, `white ${ratio(WHITE, bg).toFixed(2)} vs spec ${want}`);
        assert.ok(Math.abs(ratio(WHITE, PINK) - 4.52) <= 0.2);
        // the 0.10 ceiling of the fill guard is sound for the pink chevron
        assert.ok(ratio(PINK, over(WHITE, 0.10)) >= 3);
    });
    test('9b: rendered, every row of a list reads its position (Primary edge odd, Violet edge even); quiet rows have no edge', () => {
        const w = new Window(), d = w.document;
        d.head.innerHTML = `<style>${CSS}</style>`;
        const sources = ['talisman', 'polkadot-js', 'subwallet-js'].map(k => ({ key: k, name: k }));
        d.body.innerHTML = `<div id="wallet-accounts">${buildAccountListHtml({ accounts: Array.from({ length: 5 }, (_, i) => ({ address: addr(30 + i), name: 'Acc ' + i, source: 'talisman' })), current: null, currentSource: 'talisman', isSame: same, esc: escapeHtml, shortAddr: short, primary: false })}</div><ul class="wallet-option-list">${buildOptionRowsHtml({ sources, phone: { connected: false }, lead: 'polkadot-js', esc: escapeHtml })}</ul>`;
        const err = [];
        for (const listSel of ['#wallet-accounts .wallet-account-list', '.wallet-option-list']) {
            const lis = Array.from(d.querySelectorAll(listSel + ' > li'));
            assert.ok(lis.length >= 4, listSel);
            lis.forEach((li, i) => {
                // amended (colour roles 6.1, R7): only the account list alternates the edge by position; option rows read the fill only
                const cs = w.getComputedStyle(li), accounts = listSel.startsWith('#wallet-accounts');
                const want = accounts ? (i % 2 ? ['#6745D2', 'rgba(255, 255, 255, 0.06)'] : ['#E6007A', 'rgba(255, 255, 255, 0.03)']) : ['', i % 2 ? 'rgba(255, 255, 255, 0.06)' : 'rgba(255, 255, 255, 0.03)'];
                const got = [accounts ? cs.getPropertyValue('--row-edge').trim() : '', cs.getPropertyValue('--row-fill').trim()];
                if (JSON.stringify(got) !== JSON.stringify(want)) err.push(`${listSel} > li:nth-child(${i + 1}) has ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
            });
        }
        const quiet = Array.from(d.querySelectorAll('.wallet-option-row.is-quiet'));
        assert.ok(quiet.length >= 1, 'the options list has a quiet row');
        // amended (colour roles 6.1): a quiet row of kind quiet has no edge; the quiet Get a wallet row (kind get) has the blue one
        for (const q of quiet) { const want = q.getAttribute('data-kind') === 'quiet' ? 'transparent' : '#148FE8'; const got = w.getComputedStyle(q).getPropertyValue('--row-edge').trim(); if (got !== want) err.push(`quiet row ${q.className} (${q.getAttribute('data-kind')}) has edge "${got}", wanted ${want}`); }
        assert.deepEqual(err, [], msg(err));
    });

    test('10: the guards fail on broken copies and the message names the selector', () => {
        // (a) one Revision 2 stripe rule restored: the removal guard names it
        const stripe = ':where(.wallet-option-list > .wallet-option:nth-child(odd)) > .wallet-option-row { background: rgba(230, 0, 122, 0.10); border-color: rgba(230, 0, 122, 0.22); }';
        const a = CSS + '\n' + stripe + '\n';
        const ea = checkRemoved(a);
        assert.ok(ea.some(m => m.includes(':where(.wallet-option-list > .wallet-option:nth-child(odd)) > .wallet-option-row') && m.includes('nth-child rule')), msg(ea));
        assert.ok(ea.some(m => m.includes('rgba(230, 0, 122, 0.10)')), msg(ea));
        // (b) the opaque --bg-surface layer deleted from the lead: the layer guard names it
        const b = CSS.replace(/(\.wallet-option-row\.is-primary, \.wallet-account-btn\.is-primary \{[^}]*?)linear-gradient\(var\(--bg-surface\), var\(--bg-surface\)\) padding-box,\s*/, '$1');
        assert.notEqual(b, CSS, 'the broken copy differs');
        const eb = checkLayers(b);
        assert.ok(eb.some(m => m.includes('".wallet-option-row.is-primary"') && m.includes('layers')), msg(eb));
        assert.ok(eb.some(m => m.includes('".wallet-account-btn.is-primary"')), msg(eb));
        // (c) a pink fill on the option row hover: the fill guard names it
        const c = CSS + '\n.wallet-option-row:hover { background: rgba(230, 0, 122, 0.10); }\n';
        const ec = checkFills(c);
        assert.ok(ec.some(m => m.includes('".wallet-option-row:hover"') && m.includes('rgba(230, 0, 122, 0.10)')), msg(ec));
        // (d) the gradient as a fill on a plain Connect pill: the one-primary guard names it
        const ed = checkOnePrimary(CSS + '\n.wallet-option-action { background: var(--brand-gradient); }\n');
        assert.ok(ed.some(m => m.includes('".wallet-option-action"')), msg(ed));
        // (e) the lead rule moved before its hover rule: the order guard names both
        const lines = CSS.split('\n'), li = lines.findIndex(l => l.startsWith('.wallet-option-row.is-primary, .wallet-account-btn.is-primary {'));
        assert.ok(li >= 0, 'the shared lead rule starts a line');
        let end = li; while (!lines[end].includes('}')) end++;
        const block = lines.slice(li, end + 1), rest = lines.filter((_, i) => i < li || i > end);
        rest.splice(rest.findIndex(l => l.startsWith('.wallet-option-row {')), 0, ...block);
        const ee = checkOrder(rest.join('\n'));
        assert.ok(ee.some(m => m.includes('".wallet-option-row.is-primary"') && m.includes('".wallet-option-row:hover"')), msg(ee));
        // (f) the even position rule given the odd values: the position guard names it
        const f = CSS.replace("--row-fill: rgba(255, 255, 255, 0.06); --row-edge: var(--violet);", "--row-fill: rgba(255, 255, 255, 0.03); --row-edge: var(--brand-primary);");
        assert.notEqual(f, CSS);
        assert.ok(checkPosition(f).some(m => m.includes(':nth-child(even)')), msg(checkPosition(f)));
        // and the healthy file passes all of them
        assert.deepEqual([...checkPosition(CSS), ...checkRemoved(CSS), ...checkFills(CSS), ...checkLayers(CSS), ...checkOnePrimary(CSS), ...checkOrder(CSS)], []);
    });
});
