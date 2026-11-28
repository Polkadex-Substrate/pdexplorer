// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, section 6.3): the preview scenes of the
// pages and modals WP1 changes, built by tools/preview-scenes.mjs (set "site", files site-<scene>-<width>.html at 1280
// and 375) from the REAL page (index.html and script.js in happy-dom, the real lib views mounted where the page needs a
// chain), then read back here. Each scene: no .staking-download-btn anywhere; at most one primary drawn; no colour,
// background or border written in markup inside the part WP1 changed (the focus; the rest of a page is WP2 and WP3);
// the focus is drawn.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { RULES, mediaApplies, declared, undrawn, px } from './helpers/phone-width.js';

const TOOL = fileURLToPath(new URL('../tools/preview-scenes.mjs', import.meta.url));
// [scene, focus: the part WP1 changed, what the scene must show]
const SCENES = [
    // Amended in sprint 11 WP3b (Q3, spec 5.1 rows 9, 10, 12): the sign and Subscribe buttons are the gradient primary, no .is-solid
    // and no .modal-submit-btn.
    ['modal-withdraw-candidacy', '#council-withdraw-modal', '#council-withdraw-sign.validate-primary:not(.is-solid)'],
    ['modal-propose-spend-review', '#treasury-spend-modal', '#treasury-spend-review .ca-args, #treasury-spend-review .gd-args'],
    ['modal-referendum-vote-aye', '#referendum-vote-modal', '#referendum-vote-side-aye[aria-pressed="true"]'],
    ['modal-council-vote', '#council-vote-modal', '#council-vote-available-list .council-vote-row'],
    ['modal-candidacy', '#council-candidacy-modal', '#submit-candidacy-tx-btn.validate-primary'],
    ['email-alerts-modal', '#email-subscribe-modal', '#email-subscribe-submit.validate-primary:not(.is-solid)'],
    ['storage-notice', '#storage-notice-dismiss', '#storage-notice-banner a.validate-text-btn[href="/privacy"]'],
    ['rewards-result', '.staking-toolbar-actions', '#staking-dl-csv.validate-secondary'],
    ['chain-state-result', '#cs-export', '#cs-dl-json.validate-secondary'],
    ['discussions-failed', '#discussions-content', '#discussions-retry-btn.validate-secondary'],
    ['democracy-failed', '#democracy-content', '#democracy-retry-btn.validate-secondary'],
    ['treasury-failed', '#treasury-content', '#treasury-retry-btn.validate-secondary'],
    ['account-labels-signed-out', '#account-label-signin', '#account-label-signin.ui-action'],
    ['watchlist-items', '#watchlist-clear-all', '#watchlist-clear-all.validate-text-btn.is-danger'],
    ['tx-not-found', '#tx-recover-btn', '#tx-details-container a.validate-secondary[href^="/search"]'],
    // WP3 (spec 6.3): the rest of the site set.
    ['validators-syncing', '#validators-table', '#validators-table .ui-state.is-wait'],
    ['transactions-failed', '#full-transactions-table', '#full-transactions-table .ui-state.is-failed'],
    ['blocks-loaded', '#full-blocks-table', '#full-blocks-table table.data-table'],
    ['search-nothing-found', '#search-results-container', '#search-results-container .ui-state.is-empty'],
    ['search-deep-failed', '#search-results-container', '#search-results-container .ui-state.is-failed'],
    ['account-summary', '#account-details-container', '#account-details-container .ui-kv-wrap .js-copy-address.validate-text-btn'],
    ['tx-found', '#tx-details-container', '#tx-details-container .ui-chip.is-positive'],
    ['validator-commission-alert', '#validator-details-container', '#validator-details-container .ui-panel.is-error'],
    ['rewards-empty', '#staking-rewards-results', '#staking-rewards-results .ui-state'],
    ['thread-composer', '#discussions-content', '#discuss-post-btn.ui-action'],
    ['analytics', '.page-section[data-page="analytics"]', '.page-section[data-page="analytics"] .ui-page-head'],
    ['watchlist-empty', '.page-section[data-page="watchlist"]', '.page-section[data-page="watchlist"] .ui-tile.is-lg.is-neutral'],
    ['cookies', '.page-section[data-page="cookies"]', '.page-section[data-page="cookies"] .legal-body'],
    ['tour-first-slide', '#onboarding-tour-modal', '#onboarding-tour-next.validate-primary'],
    // WP3b (spec 6.3, Q3): a primary in the top bar, in a dialog and in a page head.
    ['topbar-no-wallet', 'header.topbar', 'header.topbar #connect-wallet-btn:not(.is-connected):not(.is-outline)'],
    ['modal-send', '#send-modal', '#submit-send-tx-btn.validate-primary'],
    ['council-head', '.council-page-header', '#council-vote-btn.validate-primary']
];
const PRIMARY = '.validate-primary, .wallet-option-row.is-primary, .modal-submit-btn';
// WP3 (spec 6.3): the scene check also runs at 320 on the same markup; and the check-on-device items get a 320 file.
const ON_DEVICE_320 = ['wp1-wallet-switch-current', 'wp2-keys-ok', 'wp2-keys-conflict', 'wp3-wizard-review-multisig'];
const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
const hidden = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.hasAttribute('hidden') || /display:\s*none/.test(e.getAttribute('style') || '')) return true; } return false; };

let dir = null, files = [], run = null;
before(() => {
    dir = mkdtempSync(join(tmpdir(), 's11-scenes-'));
    try {
        // WP3: also the sections scenes (stacked Recent Transactions) and the packages of the four check-on-device items.
        for (const wp of ['site', 'sections', '1', '2', '3', 'stake']) execFileSync(process.execPath, ['--experimental-sqlite', TOOL, '--wp', wp, '--out', dir], { stdio: 'pipe', timeout: 400000, maxBuffer: 1 << 26 });
        files = readdirSync(dir);
    } catch (e) { run = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'); }
}, { timeout: 560000 });
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const sceneDoc = (name) => {
    const html = readFileSync(join(dir, name), 'utf8');
    const inner = /srcdoc="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = (/<body[^>]*>([\s\S]*)<\/body>/.exec(inner) || [])[1] || '';
    return win.document;
};

describe('the site scenes of WP1 (tools/preview-scenes.mjs --wp site)', () => {
    test('the tool builds the set without refusing', () => assert.equal(run, null, `the tool refused:\n${run}`));
    for (const [id, focus, must] of SCENES) {
        for (const width of [1280, 375]) {
            test(`site-${id}-${width}: built; ${must} shown; no legacy class; at most one primary; no colour in markup inside ${focus}`, () => {
                const name = `site-${id}-${width}.html`;
                assert.ok(files.includes(name), `no ${name}`);
                const doc = sceneDoc(name);
                assert.equal(doc.querySelectorAll('.staking-download-btn').length, 0, 'a .staking-download-btn in the scene');
                // Amended in sprint 11 WP3b (Q3): a dialog is its own view (spec 1.0). With the Council page's Vote now a primary, the
                // page behind an open dialog draws one too; the count is of the open dialog, else of the page.
                const view = Array.from(doc.querySelectorAll('.modal')).filter(e => !hidden(e)).pop() || doc;
                const shown = Array.from(view.querySelectorAll(PRIMARY)).filter(e => !hidden(e));
                assert.ok(shown.length <= 1, `${shown.length} primaries drawn: ${shown.map(e => e.id || e.className).join(', ')}`);
                const root = doc.querySelector(focus);
                assert.ok(root && !hidden(root), `${focus} is not drawn`);
                const el = doc.querySelector(must);
                assert.ok(el && !hidden(el), `${must} is not drawn`);
                const bad = [root, ...root.querySelectorAll('[style]')].filter(e => e.hasAttribute('style') && COLOUR.test(';' + e.getAttribute('style'))).map(e => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} style="${e.getAttribute('style').slice(0, 80)}">`);
                assert.deepEqual(bad, [], 'a colour written in markup');
            });
        }
    }
});

// ── WP3 (spec 6.3): the whole page of every site scene, at 375 and at 320 ──
// A visible element whose declared width or min-width is over the scene width (the stylesheet cascade at that width).
function overWide(doc, width) {
    const bad = new Set();
    for (const r of RULES) {
        if (!mediaApplies(r.media, width)) continue;
        for (const p of ['width', 'min-width']) {
            const n = px(r.decls[p]);
            if (n == null || n <= width) continue;
            for (const sel of r.selectors) {
                if (sel.includes('::')) continue;
                let found = [];
                try { found = Array.from(doc.querySelectorAll(sel)); } catch (e) { continue; }
                if (found.some(el => declared(el, p, width) === r.decls[p] && !undrawn(el, width))) bad.add(`${sel} { ${p}: ${r.decls[p]} }`);
            }
        }
    }
    for (const el of Array.from(doc.querySelectorAll('[style]'))) for (const m of (el.getAttribute('style') || '').matchAll(/(?:^|;)\s*(min-width|width)\s*:\s*([\d.]+)px/g)) if (Number(m[2]) > width && !undrawn(el, width)) bad.add(`inline ${m[1]}: ${m[2]}px`);
    return Array.from(bad);
}
describe('WP3 and WP3b: every site scene as a whole page (spec 6.3)', () => {
    for (const [id] of SCENES) {
        test(`site-${id}: no colour written in markup anywhere on the page; every drawn primary is the gradient .validate-primary; nothing wider than 375 or 320`, () => {
            const name = `site-${id}-375.html`;
            assert.ok(files.includes(name), `no ${name}`);
            const doc = sceneDoc(name);
            const bad = Array.from(doc.querySelectorAll('[style]')).filter(e => COLOUR.test(';' + e.getAttribute('style'))).map(e => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} style="${e.getAttribute('style').slice(0, 80)}">`);
            assert.deepEqual(bad, [], 'a colour written in markup');
            assert.deepEqual(Array.from(doc.querySelectorAll('.modal-submit-btn, .is-solid')).map(e => e.id || e.className), [], 'a solid primary is left');
            for (const width of [375, 320]) assert.deepEqual(overWide(doc, width), [], `wider than ${width} px`);
        });
    }
});
describe('WP3 (spec 4.1): Recent Transactions stack in the My Account scenes; the 320 scene', () => {
    test('sections-default-320 is built', () => assert.ok(files.includes('sections-default-320.html'), files.filter(f => /^sections-/.test(f)).join(', ')));
    for (const id of ['default', 'send-included', 'proxy-removed', 'updating', 'could-not-refresh']) {
        test(`sections-${id}: #wallet-recent-tx-table holds table.data-table.is-stacked with a data-label on every body cell; it is not display: table at 375 or 320`, () => {
            const name = `sections-${id}-375.html`;
            assert.ok(files.includes(name), `no ${name}`);
            const doc = sceneDoc(name);
            const t = doc.querySelector('#wallet-recent-tx-table table.data-table');
            assert.ok(t && t.classList.contains('is-stacked'), t ? t.className : 'no table');
            const tds = Array.from(t.querySelectorAll('tbody td'));
            assert.ok(tds.length >= 4 && tds.every(td => td.hasAttribute('data-label') || td.classList.contains('table-empty-row')), 'a body cell without data-label');
            assert.deepEqual(Array.from(t.querySelector('tbody tr').children).map(td => td.className), ['is-lead', 'is-tag', '', 'is-end']);
            for (const width of [375, 320]) assert.notEqual(declared(t, 'display', width) || 'table', 'table', `display: table at ${width}`);
            for (const width of [375, 320]) assert.deepEqual(overWide(doc, width), [], `wider than ${width} px`);
        });
    }
});
describe('WP3 (spec 4.2): the check-on-device items get a 320 file and fit it', () => {
    test('every stake-advanced scene and the four named scenes are built at 320 too', () => {
        const adv = files.filter(f => /^stake-advanced-.*-375\.html$/.test(f));
        assert.ok(adv.length >= 6, `only ${adv.length} stake-advanced scenes`);
        const want = [...adv.map(f => f.replace(/-375\.html$/, '-320.html')), ...ON_DEVICE_320.map(id => `${id}-320.html`)];
        assert.deepEqual(want.filter(f => !files.includes(f)), []);
    });
    for (const id of ON_DEVICE_320) {
        test(`${id}-320: nothing is wider than 320 px`, () => {
            assert.ok(files.includes(`${id}-320.html`), `no ${id}-320.html`);
            assert.deepEqual(overWide(sceneDoc(`${id}-320.html`), 320), []);
        });
    }
    test('wp3-wizard-review-multisig at 320: the call review stacks (no .ca-args row is display: table-row; the head is clipped)', () => {
        const doc = sceneDoc('wp3-wizard-review-multisig-375.html');
        const rows = Array.from(doc.querySelectorAll('.ca-args tr'));
        assert.ok(rows.length >= 2, 'no call review rows');
        for (const r of rows) assert.equal(declared(r, 'display', 320), 'block');
        for (const h of Array.from(doc.querySelectorAll('.ca-args thead'))) assert.equal(declared(h, 'position', 320), 'absolute');
    });
    test('wp2-keys-ok at 320: the keys table header cells wrap', () => {
        const ths = Array.from(sceneDoc('wp2-keys-ok-375.html').querySelectorAll('.validate-keys-table th.table-th'));
        assert.ok(ths.length >= 3);
        for (const th of ths) assert.equal(declared(th, 'white-space', 320), 'normal');
    });
});
