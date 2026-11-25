// The Multisig wallets card, the Advanced card and the wallet-page sweep onto the current UX rules
// (spec cto-team/plans/2026-11-25-multisig-and-advanced-cards.md; CTO rulings 2026-11-25: duplicate signer lines are
// refused with a field error, renderApiError changes site-wide and is checked on two other pages, the long dashes in
// the identity modal labels go). T1 to T8 of section 6.1; T9 (the guard) is test/wallet-legacy-guard.test.js.
//
// Rendered behaviour wherever it can be: the REAL lib/multisig-view.js, lib/wallet-advanced-view.js and
// lib/wallet-sections.js in happy-dom, the REAL script.js functions lifted into a vm (script.js has no export
// surface), the REAL styles.css read as a cascade, and the scenes tools/preview-scenes.mjs builds.
// The signing paths (the multisig review and Add proxy) are pinned by spies: the same pallet, method and arguments.
// Addresses are synthetic (32 repeated bytes).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { createKeyMulti, sortAddresses, encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { escapeHtml } from '../lib/html-escape.js';
import { icon, panelHtml, linePanelHtml } from '../lib/ui-parts.js';
import { createMultisigUI } from '../lib/multisig-view.js';
import { normalizeMultisig } from '../lib/multisig.js';
import { isValidPolkadexAddress } from '../lib/wallet-safety.js';
import { renderNominationStatus } from '../lib/nomination-status-view.js';
import { renderRecipientRefusal, checkRecipient } from '../lib/recipient-network.js';
import { createWalletSections } from '../lib/wallet-sections.js';
import * as sectionsModule from '../lib/wallet-sections.js';
import { addr } from './helpers/wallet-world.js';
import { readRepo, bodyOf } from './helpers/source.js';
import { declsAt, declsIn, RULES, STYLES } from './helpers/phone-width.js';

const tool = await import('../tools/preview-scenes.mjs');
const V = await import('../lib/wallet-advanced-view.js').then((m) => m, () => ({}));
const need = (name) => { assert.equal(typeof V[name], 'function', `lib/wallet-advanced-view.js does not export ${name}`); return V[name]; };
const SCRIPT = readRepo('script.js', import.meta.url);
const INDEX = readRepo('index.html', import.meta.url);
const A = addr(1), B = addr(2), C = addr(3), D = addr(4), ME = addr(9);
const short = (a) => { const s = String(a || ''); return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s; };
const fmt = { esc: escapeHtml, short, number: (n) => Number(n).toLocaleString('en-US') };
const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const page = (html = '') => {
    const win = new Window({ url: 'https://explorer.test/wallet', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return { win, doc: win.document };
};
// Inline styles that write a colour, a background or a border (layout-only styles are not part of the rule).
const colourStyles = (root) => Array.from(root.querySelectorAll('[style]')).filter(e => /(^|;)\s*(color|background|border)/i.test(e.getAttribute('style'))).map(e => e.outerHTML.slice(0, 120));
const team = () => normalizeMultisig({ signers: [A, B, C], threshold: 2, name: 'Team wallet' });
const vault = () => normalizeMultisig({ signers: [A, B, C], threshold: 3, name: 'Vault' });

// ── T1: the stylesheet ──
describe('T1: the ui-field part, the sections and the 44 px rule (parsed styles.css)', () => {
    const at = (sel, w = 1280) => declsAt(sel, w);
    test('each ui-* rule of section 2 with its value', () => {
        const want = {
            '.ui-form': { display: 'grid', gap: '16px', margin: '0' },
            '.ui-field': { display: 'grid', gap: '4px', 'min-width': '0' },
            '.ui-field-label': { 'font-size': '0.82rem', 'font-weight': '600', color: 'var(--text-primary)' },
            '.ui-field-hint': { margin: '0', 'font-size': '0.82rem', 'line-height': '1.5', color: 'var(--text-secondary)' },
            '.ui-input': { width: '100%', 'box-sizing': 'border-box', 'min-height': '44px', padding: '10px 12px', background: 'var(--bg-dark)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color)', 'border-radius': 'var(--radius-sm)', font: 'inherit', 'font-size': '0.9rem' },
            'textarea.ui-input': { resize: 'vertical', 'font-family': 'monospace', 'font-size': '0.82rem', 'overflow-wrap': 'anywhere' },
            '.ui-input:focus-visible': { outline: '2px solid var(--brand-primary)', 'outline-offset': '2px' },
            '.ui-input[aria-invalid="true"]': { 'border-color': 'var(--accent-red-line)' },
            '.ui-field-error': { margin: '0', 'font-size': '0.82rem', color: 'var(--text-primary)' },
            '.ui-field-error .bx': { color: 'var(--accent-red)', 'font-size': '16px' },
            '.ui-field-error:empty': { display: 'none' },
            '.ui-input.is-narrow': { width: '96px' },
            '.ui-section': { padding: '24px', 'border-top': '1px solid var(--border-color)' },
            '.ui-section-title': { margin: '0 0 4px', 'font-size': '0.95rem', 'font-weight': '600', color: 'var(--text-primary)' },
            '.ui-section-caption': { margin: '0 0 12px', 'font-size': '0.82rem', color: 'var(--text-secondary)' },
            '.ui-empty': { margin: '0', padding: '8px 0', 'font-size': '0.9rem', color: 'var(--text-secondary)' }
        };
        const err = [];
        for (const [sel, decls] of Object.entries(want)) {
            const got = declsIn(sel, '');
            for (const [p, v] of Object.entries(decls)) if ((got[p] || '').trim() !== v) err.push(`${sel} { ${p}: ${got[p] || '(none)'} }, wanted ${v}`);
        }
        assert.deepEqual(err, []);
        assert.equal(at('.ui-input.is-narrow', 360).width, '96px', 'the number field does not stay 96 px on a phone');
        assert.equal(at('.ui-section', 640).padding, '16px');
        assert.equal(at('.ui-section:first-of-type').border || at('.ui-section:first-of-type')['border-top'], '0', 'the first section keeps a top border');
    });
    test('no uppercase label: .ui-field-label and every .wallet-advanced rule', () => {
        const bad = RULES.filter(r => r.selectors.some(s => /\.ui-field-label|\.wallet-advanced/.test(s)) && /uppercase/i.test(r.decls['text-transform'] || '')).map(r => r.selectors.join(', '));
        assert.deepEqual(bad, []);
        assert.ok(RULES.some(r => r.selectors.includes('.wallet-advanced')), 'no .wallet-advanced rule at all');
    });
    for (const width of [640, 360]) {
        test(`at ${width}: every action and secondary in both cards is 44 px and full width; the add-proxy grid is one column`, () => {
            for (const sel of ['.multisig-panel .validate-secondary', '.multisig-panel .ui-action', '.wallet-advanced .validate-secondary', '.wallet-advanced .ui-action']) {
                assert.equal(at(sel, width)['min-height'], '44px', `${sel} is not 44 px at ${width}`);
                assert.equal(at(sel, width).width, '100%', `${sel} is not full width at ${width}`);
            }
            assert.equal(at('.proxy-add-grid', width)['grid-template-columns'], 'minmax(0, 1fr)', 'the add-proxy grid is not one column');
        });
    }
    test('the add-proxy grid: four columns on desktop, two at 900 px', () => {
        assert.equal(at('.proxy-add-grid').display, 'grid');
        assert.equal(at('.proxy-add-grid')['grid-template-columns'], 'minmax(0, 1fr) 180px 120px auto');
        assert.equal(at('.proxy-add-grid', 900)['grid-template-columns'], '1fr 1fr');
    });
    test('a disabled secondary looks disabled; the Advanced header icon is violet; an empty pending section is hidden', () => {
        assert.equal(declsIn('.validate-secondary:disabled', '').opacity, '0.55');
        assert.equal(declsIn('.validate-secondary:disabled', '').cursor, 'not-allowed');
        assert.equal(declsIn('.wallet-advanced .list-header h2 .bx', '').color, 'var(--accent-violet-text)');
        assert.equal(declsIn('#adv-pending-section:has(#wallet-multisig-pending:empty)', '').display, 'none');
        assert.equal(declsIn('.wallet-advanced-sub', '').color, 'var(--text-secondary)');
    });
});

// ── T2: the hue guard on every rule of the two cards ──
const KIT = new Set(['230,0,122', '103,69,210', '20,241,149', '0,230,118', '255,165,0', '20,143,232', '255,77,77', '164,143,228', '79,171,238', '18,18,26', '8,8,12', '20,20,30', '156,163,175', '107,114,128']);
const CARD = /^(\.multisig-|\.ms-|\.wallet-advanced|\.ui-field|\.ui-input|\.ui-section|\.proxy-add)/;
const GREEN = /var\(--(accent-green[\w-]*|success|brand-secondary)\)|#14f195|#00e676/i;
function cardOffenders(rules) {
    const out = [];
    for (const r of rules) {
        const mine = r.selectors.filter(s => CARD.test(s.trim()));
        if (!mine.length) continue;
        const where = `styles.css:${r.line} "${mine.join(', ')}"`;
        for (const [p, v] of Object.entries(r.decls)) {
            for (const h of v.matchAll(/#([0-9a-fA-F]{3,8})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
                let rgb;
                if (h[1]) { const x = h[1].length === 3 ? h[1].split('').map(c => c + c).join('') : h[1].slice(0, 6); rgb = [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)); } else rgb = [h[2], h[3], h[4]].map(Number);
                if (!(rgb[0] === rgb[1] && rgb[1] === rgb[2]) && !KIT.has(rgb.join(','))) out.push(`${where} { ${p}: ${v} } is not a kit colour`);
            }
            if (/^(color|background(-color|-image)?)$/.test(p) && /var\(--brand-primary\)|gradient/i.test(v)) out.push(`${where} { ${p}: ${v} } is pink or a gradient (the page's one primary is Send)`);
            if (p === 'color' && /var\(--text-muted\)/.test(v)) out.push(`${where} { color: ${v} } is --text-muted for text people must read`);
            if (/^(color|background(-color)?)$/.test(p) && GREEN.test(v) && mine.some(s => /(button|btn|summary|\.multisig-discover|\.multisig-refresh|\.multisig-new|\.ui-action|\.validate-)/.test(s))) out.push(`${where} { ${p}: ${v} } is green on a control`);
        }
    }
    return out;
}
describe('T2: the cards draw only kit colours, and no pink, gradient or green on a control', () => {
    test('every rule whose selector starts .multisig-, .ms-, .wallet-advanced, .ui-field, .ui-input, .ui-section or .proxy-add', () => {
        const err = cardOffenders(RULES);
        assert.deepEqual(err, [], err.join('\n'));
    });
    test('no rule for .multisig-discovery-note; .multisig-panel summary is not --brand-secondary', () => {
        assert.deepEqual(RULES.filter(r => r.selectors.some(s => s.includes('.multisig-discovery-note'))).map(r => r.line), []);
        const s = declsAt('.multisig-panel summary', 1280);
        assert.notEqual(s.color, 'var(--brand-secondary)');
    });
    test('the guard is proved failing: a pink, a muted text and a green control are reported', () => {
        const fake = [{ line: 1, selectors: ['.multisig-discover'], decls: { background: 'var(--brand-primary)', color: 'var(--accent-green)' } },
            { line: 2, selectors: ['.ui-field-hint'], decls: { color: 'var(--text-muted)' } }, { line: 3, selectors: ['.ms-tag'], decls: { color: '#123456' } }];
        const err = cardOffenders(fake);
        assert.equal(err.length, 4, err.join('\n'));
    });
});

// ── T3: the Multisig wallets card (full form) ──
// The add form reads itself with new FormData(form): the page's FormData, so the test's document's (Node's own takes no form).
const NODE_FORM_DATA = globalThis.FormData;
const pageForms = (win) => { globalThis.FormData = win.FormData; };
function msCard({ discover = async () => ({ wallets: [], scannedEvents: 10 }), saved = [], fetchJson = async () => ({}), api = {}, selected = ME, address = ME, save = null } = {}) {
    const { win, doc } = page('<div id="wallet-multisig-slot"></div>');
    pageForms(win);
    const slot = doc.getElementById('wallet-multisig-slot');
    const log = { selects: [], saves: [], discovers: 0 };
    const store = { list: () => saved, find: (a) => saved.find(m => m.address === a) || null,
        save: save || ((v) => { log.saves.push(v); return { address: v.address }; }) };
    const ui = createMultisigUI({ store, storage: {}, api: () => api, accounts: async () => [], selected: () => selected, select: (a, k) => log.selects.push([a, k]),
        submit: async () => {}, refresh() {}, fetchJson, discover: (o) => { log.discovers++; return discover(o); } });
    ui.mountAccounts(slot, { address });
    const q = (s) => slot.querySelector(s);
    return { win, doc, slot, ui, log, q, status: () => q('.multisig-discovery-status'), button: () => q('.multisig-discover') };
}
const STATES = [
    ['found 1', async () => ({ wallets: [team()], scannedEvents: 606, limited: false, unavailableBlocks: 0 }), 'is-ok', 'bx-check-circle', 'Found 1 multisig wallet.', true],
    ['found 2', async () => ({ wallets: [team(), vault()], scannedEvents: 606 }), 'is-ok', 'bx-check-circle', 'Found 2 multisig wallets.', true],
    ['none', async () => ({ wallets: [], scannedEvents: 606 }), 'is-info', 'bx-info-circle', 'No multisig wallets found for this account. If yours is missing, add it below.', true],
    ['partial', async () => ({ wallets: [team()], scannedEvents: 606, limited: true }), 'is-warn', 'bx-error', 'We could not check everything, so a wallet may be missing. Check again, or add it below.', true],
    ['partial (blocks)', async () => ({ wallets: [], scannedEvents: 606, unavailableBlocks: 2 }), 'is-warn', 'bx-error', 'We could not check everything, so a wallet may be missing. Check again, or add it below.', true],
    ['failed, timeout', async () => { throw Object.assign(new Error('Discovery timed out. Retry, or add the multisig manually.'), { code: 'timeout' }); }, 'is-warn', 'bx-error', 'That took too long. Check again, or add your wallet below.', false],
    ['failed, other', async () => { throw new Error('indexer 502 at /x'); }, 'is-warn', 'bx-error', 'We could not finish checking. Check again, or add your wallet below.', false]
];
describe('T3: the Multisig wallets card, every search state (createMultisigUI().mountAccounts)', () => {
    after(() => { globalThis.FormData = NODE_FORM_DATA; });
    test('discovering: the same status node, a line with a spinner and the sentence; Check again is a disabled secondary', async () => {
        const w = msCard({ discover: () => new Promise(() => {}) });
        const st = w.status();
        assert.ok(st, 'no .multisig-discovery-status');
        assert.equal(st.getAttribute('role'), 'status');
        assert.ok(st.classList.contains('ui-panel') && st.classList.contains('is-line') && st.classList.contains('is-warn'), st.className);
        assert.ok(st.querySelector('.bx-loader-alt.bx-spin'), 'no spinner icon');
        assert.equal(t(st), 'Looking for multisig wallets...');
        const b = w.button();
        assert.ok(b.classList.contains('validate-secondary'), b.className);
        assert.ok(!b.classList.contains('staking-download-btn'));
        assert.equal(b.disabled, true);
        assert.ok(b.querySelector('.bx-refresh'));
        assert.equal(t(b), 'Check again');
        assert.ok(b.closest('.multisig-head') && w.q('.multisig-head h3'), 'the button is not in the header row beside the title');
        assert.equal(t(w.q('.multisig-head h3')), 'Multisig wallets');
    });
    for (const [name, discover, role, iconName, sentence, line] of STATES) {
        test(`${name}: ${role}, ${iconName}, "${sentence}"; Check again enabled`, async () => {
            const w = msCard({ discover });
            const st = w.status();
            await flush();
            assert.ok(w.status() === st, 'the status node was replaced');
            assert.ok(st.classList.contains('ui-panel') && st.classList.contains(role), st.className);
            assert.equal(st.classList.contains('is-line'), line, line ? 'a search state is a line' : 'a failure is a block panel, not a line');
            assert.equal(st.querySelectorAll('.bx').length, 1);
            assert.ok(st.querySelector('.' + iconName), `no ${iconName}`);
            assert.equal(t(st), sentence);
            assert.equal(w.button().disabled, false);
            assert.ok(!/indexer 502|Discovery timed out|Checked \d+ recent indexed events/.test(w.slot.textContent), 'a raw message or the old count is shown');
        });
    }
    test('failed, no node: the third failure sentence', async () => {
        const w = msCard({ api: null });
        await flush();
        assert.equal(t(w.status()), 'Not connected to the network yet. Check again in a moment.');
        assert.ok(w.status().classList.contains('is-warn') && !w.status().classList.contains('is-line'));
    });
    test('saved only and nothing: no search, no Check again, the two sentences', async () => {
        const saved = msCard({ fetchJson: null, saved: [team()] });
        assert.equal(saved.button(), null);
        assert.equal(t(saved.status()), 'Your saved multisig wallets are listed below.');
        assert.ok(saved.status().classList.contains('is-info') && saved.status().querySelector('.bx-info-circle'));
        const none = msCard({ fetchJson: null });
        assert.equal(t(none.status()), 'No multisig wallets saved yet. Add one below.');
    });
    test('the rows: name, "2 of 3" tag, full address, chevron, an aria-label; no "Open wallet", no middle dot; Selected is a chip', async () => {
        const m = team();
        const w = msCard({ discover: async () => ({ wallets: [m, vault()], scannedEvents: 12 }), selected: m.address, address: ME });
        await flush();
        const list = w.q('.multisig-saved-list');
        assert.equal(list.tagName, 'UL');
        assert.ok(list.classList.contains('wallet-account-list'));
        assert.equal(list.getAttribute('role'), 'list');
        const rows = Array.from(list.querySelectorAll('li > button.wallet-account-btn[data-multisig]'));
        assert.equal(rows.length, 2);
        assert.equal(rows[0].getAttribute('aria-label'), 'Open Team wallet, multisig, 2 of 3 approvals');
        assert.equal(t(rows[0].querySelector('.ms-tag')), '2 of 3');
        assert.equal(t(rows[0].querySelector('.wallet-account-addr')), m.address, 'the address is not in full');
        assert.ok(rows[0].querySelector('.bx-chevron-right'));
        assert.ok(!/Open wallet|·/.test(list.textContent), list.textContent);
        const chip = rows[0].querySelector('.ui-chip.is-neutral');
        assert.ok(chip && chip.querySelector('.bx-check'), 'the selected wallet carries no Selected chip');
        assert.equal(t(chip), 'Selected');
        assert.equal(rows[1].querySelector('.ui-chip'), null);
    });
    test('"Is a wallet missing?" is a disclosure with the events-checked figure; the old discovery note is gone', async () => {
        const w = msCard({ discover: async () => ({ wallets: [], scannedEvents: 606 }) });
        await flush();
        const d = Array.from(w.slot.querySelectorAll('details.validate-disclosure')).find(x => t(x.querySelector('summary')) === 'Is a wallet missing?');
        assert.ok(d, 'no "Is a wallet missing?" disclosure');
        assert.equal(t(d.querySelector('p')), "We look through this account's recent activity (606 events checked). A multisig that is older, was never used, or that this account has not signed for yet may not appear. Add it below with its signers and number of approvals.");
        assert.equal(w.q('.multisig-discovery-note'), null);
        assert.equal(t(w.q('.multisig-panel > .ui-section-caption')), 'Shared wallets this account can sign for. Open one to see its balance, send PDEX or approve a waiting transaction.');
        assert.ok(w.q('section.multisig-panel.list-container.glass'), 'the card is not a kit card');
    });
    test('Check again runs the search again; a row opens the wallet; the form saves; a refused save shows the error with an icon', async () => {
        const m = team();
        const w = msCard({ discover: async () => ({ wallets: [m], scannedEvents: 3 }) });
        await flush();
        w.button().click();
        await flush();
        assert.equal(w.log.discovers, 2, 'Check again did not search again');
        w.q('[data-multisig]').click();
        assert.deepEqual(w.log.selects.at(-1), [m.address, 'multisig']);
        const form = w.q('form.multisig-import');
        assert.ok(form.classList.contains('ui-form'));
        form.querySelector('[name="name"]').value = 'Ops';
        form.querySelector('[name="address"]').value = D;
        form.querySelector('[name="signers"]').value = `${A}\n${B}`;
        form.querySelector('[name="threshold"]').value = '2';
        form.querySelector('button[type="submit"]').click();
        assert.deepEqual(w.log.saves.at(-1), { name: 'Ops', address: D, signers: `${A}\n${B}`, threshold: '2' }, 'the form did not save what was typed');
        assert.deepEqual(w.log.selects.at(-1), [D, 'multisig']);
        const refused = msCard({ save: () => { throw new Error('These signers and approvals do not give this address.'); } });
        const rf = refused.q('form.multisig-import');
        rf.querySelector('[name="name"]').value = 'Ops';
        rf.querySelector('[name="address"]').value = D;
        rf.querySelector('[name="signers"]').value = `${A}\n${B}`;
        rf.querySelector('button[type="submit"]').click();
        const e = refused.q('.multisig-error');
        assert.ok(e.classList.contains('ui-field-error') && e.getAttribute('role') === 'alert', e.className);
        assert.ok(e.querySelector('.bx-error-circle'), 'the error has no icon');
        assert.equal(t(e), 'These signers and approvals do not give this address.');
    });
    test('the add form: four ui-fields with visible labels and the hint; Add wallet is a .ui-action; field names and kinds kept', () => {
        const w = msCard();
        const sum = Array.from(w.slot.querySelectorAll('details.validate-disclosure > summary')).map(t);
        assert.ok(sum.includes('Add a multisig wallet'), sum.join('|'));
        const form = w.q('form.multisig-import');
        const fields = Array.from(form.querySelectorAll('.ui-field'));
        assert.equal(fields.length, 4);
        assert.deepEqual(fields.map(f => t(f.querySelector('label.ui-field-label'))), ['Wallet name', 'Multisig address', 'Signer addresses', 'Approvals needed']);
        for (const f of fields) {
            const input = f.querySelector('.ui-input');
            assert.ok(input && input.id, 'a field without an input');
            assert.equal(f.querySelector('label').getAttribute('for'), input.id);
        }
        assert.deepEqual(Array.from(form.querySelectorAll('.ui-input')).map(i => i.getAttribute('name')), ['name', 'address', 'signers', 'threshold']);
        assert.equal(form.querySelector('[name="signers"]').getAttribute('data-input-kind'), 'address-list');
        assert.equal(form.querySelector('[name="address"]').getAttribute('data-input-kind'), 'address');
        assert.equal(form.querySelector('[name="threshold"]').getAttribute('data-no-input-actions'), 'numeric stepper: the browser arrows already fill this narrow field');
        assert.ok(form.querySelector('[name="threshold"]').classList.contains('is-narrow'));
        assert.equal(t(fields[2].querySelector('.ui-field-hint')), 'One per line. Include your own.');
        assert.ok(/We only check that these details match the address\. Nothing is sent\./.test(form.textContent));
        const go = form.querySelector('button[type="submit"]');
        assert.ok(go.classList.contains('ui-action') && go.querySelector('.bx-plus'));
        assert.equal(t(go), 'Add wallet');
    });
    test('no .staking-download-btn and no colour written in markup anywhere in the slot', async () => {
        const w = msCard({ discover: async () => ({ wallets: [team()], scannedEvents: 1 }) });
        await flush();
        assert.equal(w.slot.querySelectorAll('.staking-download-btn').length, 0);
        assert.equal(w.slot.querySelectorAll('[style]').length, 0);
    });
    test('a row whose save throws: the failed-other look with the message', async () => {
        const m = team();
        const w = msCard({ discover: async () => ({ wallets: [m], scannedEvents: 3 }), save: () => { throw new Error('Storage is full.'); } });
        await flush();
        w.q('[data-multisig]').click();
        assert.ok(w.status().classList.contains('is-warn') && !w.status().classList.contains('is-line'));
        assert.equal(t(w.status()), 'Storage is full.');
    });
    test('the compact form (Switch wallet page) keeps its layout; its submit is a .ui-action "Add wallet", its error a .ui-field-error', async () => {
        const { win, doc } = page('<div id="s"></div>');
        pageForms(win);
        const slot = doc.getElementById('s');
        const ui = createMultisigUI({ store: { list: () => [], find: () => null, save: () => { throw new Error('Nope.'); } }, storage: {}, api: () => ({}), accounts: async () => [], selected: () => ME, select() {}, submit: async () => {}, refresh() {}, fetchJson: async () => ({}), discover: async () => ({ wallets: [] }) });
        ui.mountAccounts(slot, { compact: true });
        await flush();
        const go = slot.querySelector('form.multisig-import button[type="submit"]');
        assert.ok(go.classList.contains('ui-action') && go.querySelector('.bx-plus'), go.className);
        assert.equal(t(go), 'Add wallet');
        const cf = slot.querySelector('form.multisig-import');
        cf.querySelector('[name="name"]').value = 'Ops';
        cf.querySelector('[name="address"]').value = D;
        cf.querySelector('[name="signers"]').value = `${A}\n${B}`;
        go.click();
        const e = slot.querySelector('.multisig-error');
        assert.ok(e.classList.contains('ui-field-error'));
        assert.ok(e.querySelector('.bx-error-circle'));
        assert.equal(t(e), 'Nope.');
        assert.equal(slot.querySelectorAll('.staking-download-btn').length, 0);
    });
});

// ── T4: the pending panel and the review modal; the signing spy ──
const num = (n) => ({ toString: () => String(n), toNumber: () => n });
const CALL = '0x0400';
function msWorld({ threshold = 2, pending = [], accounts = [{ address: A, name: 'Alice', source: 'talisman' }], askWallets = null } = {}) {
    const { win, doc } = page('<div id="multisig-review-modal" class="modal" style="display:none"><div id="multisig-review-content"></div></div><div id="wallet-multisig-slot"></div>');
    const ms = normalizeMultisig({ signers: [A, B, C], threshold, name: 'Team wallet' });
    const calls = [];
    const pendingOpt = (p) => ({ isSome: true, isNone: false, unwrap: () => ({ when: { height: num(900), index: num(2) }, approvals: p.approvals, depositor: p.approvals[0], deposit: num(1) }) });
    const txOf = (name) => (...args) => { calls.push({ name, args }); return { method: { toHex: () => '0x' + name.length.toString(16).padStart(2, '0') + '00' }, paymentInfo: async () => ({ partialFee: { toString: () => '15000000000' } }) }; };
    const api = {
        genesisHash: { toHex: () => '0x' + '00'.repeat(32) },
        runtimeVersion: { specVersion: { toString: () => '392' } },
        registry: { createType: (_t, hex) => ({ toHex: () => hex, toU8a: () => hexToU8a(hex), section: 'balances', method: 'transferKeepAlive', toHuman: () => ({}), args: [], meta: { args: [] } }) },
        query: { multisig: { multisigs: Object.assign(async (_a, h) => { const p = pending.find(x => x.hash === h); return p ? pendingOpt(p) : { isNone: true, isSome: false }; },
            { entries: async (a) => (a === ms.address ? pending.map(p => [{ args: [{ toString: () => ms.address }, { toHex: () => p.hash }] }, pendingOpt(p)]) : []) }) } },
        consts: { multisig: { maxSignatories: 100, depositBase: '1', depositFactor: '1' } },
        rpc: { chain: { getHeader: async () => ({ number: num(41) }) } }
    };
    api.tx = Object.assign(() => ({ paymentInfo: async () => ({ weight: { refTime: 1000, proofSize: 100 } }) }),
        { multisig: { asMulti: txOf('asMulti'), asMultiThreshold1: txOf('asMultiThreshold1'), approveAsMulti: txOf('approveAsMulti'), cancelAsMulti: txOf('cancelAsMulti') } });
    const submits = [];
    const copied = [];
    const ui = createMultisigUI({ store: { find: (a) => (a === ms.address ? ms : null), list: () => [ms] }, storage: { getItem: () => null, setItem() {} }, api: () => api,
        accounts: async () => accounts, selected: () => ms.address, select() {}, submit: async (o) => { submits.push(o); }, refresh() {}, fetchJson: async () => ({}),
        revision: () => 'r1', canAskWallets: () => !!askWallets, askWallets });
    const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver, nav: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
    globalThis.document = doc;
    globalThis.MutationObserver = win.MutationObserver;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (x) => { copied.push(x); } } }, configurable: true, writable: true });
    const restore = () => { globalThis.document = saved.document; globalThis.MutationObserver = saved.MutationObserver; if (saved.nav) Object.defineProperty(globalThis, 'navigator', saved.nav); };
    const modal = doc.getElementById('multisig-review-modal');
    return { win, doc, ms, api, calls, submits, copied, ui, restore, modal, slot: doc.getElementById('wallet-multisig-slot'), q: (s) => doc.querySelector(s) };
}
// Recorded from the review before this change (pallet multisig, method, then every argument): the call must not move.
const SIGNED_CALL = ['asMulti', 2, [B, C], null, { section: 'balances', method: 'transferKeepAlive', args: [], meta: { args: [] } }, { refTime: '1100', proofSize: '110' }];
const REVIEWED = JSON.stringify([SIGNED_CALL]);
const SIGNED = JSON.stringify([SIGNED_CALL, SIGNED_CALL]);
const show = (calls) => JSON.stringify(calls.map(c => [c.name, ...c.args]), (k, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'function' ? undefined : v));
describe('T4: the pending panel and the review modal (classes and strings only; the call is the same)', () => {
    test('the pending panel: Refresh list beside the h4, a labelled call-data box, Review transaction; rows Review and approve and Cancel transaction', async () => {
        const w = msWorld({ pending: [{ hash: '0x' + 'ab'.repeat(32), approvals: [B] }] });
        try {
            await w.ui.mountPending(w.slot, w.ms);
            await flush();
            const panel = w.slot.querySelector('.multisig-panel');
            const refresh = panel.querySelector('.multisig-refresh');
            assert.ok(refresh.classList.contains('validate-secondary') && refresh.querySelector('.bx-refresh'), refresh.className);
            assert.equal(t(refresh), 'Refresh list');
            assert.ok(refresh.parentElement.querySelector('h4'), 'Refresh list is not in a header row beside the h4');
            const area = panel.querySelector('textarea.multisig-new-call');
            assert.ok(area.classList.contains('ui-input'));
            const label = panel.querySelector(`label[for="${area.id}"]`);
            assert.ok(area.id && label, 'the call-data box has no visible label');
            assert.equal(t(label), 'Encoded call data');
            assert.equal(area.getAttribute('data-input-kind'), 'hex');
            const neu = panel.querySelector('.multisig-new');
            assert.ok(neu.classList.contains('ui-action') && neu.querySelector('.bx-search-alt'));
            assert.equal(t(neu), 'Review transaction');
            const approve = panel.querySelector('[data-approve]');
            assert.ok(approve.classList.contains('ui-action') && approve.querySelector('.bx-check-shield'), approve.className);
            assert.equal(t(approve), 'Review and approve');
            const cancel = panel.querySelector('[data-cancel]');
            assert.ok(cancel.classList.contains('validate-text-btn'), cancel.className);
            assert.equal(t(cancel), 'Cancel transaction');
            assert.ok(panel.querySelector('[data-pending-hash]'));
            assert.equal(panel.querySelectorAll('.validate-primary').length, 0, 'a primary in the panel');
            assert.equal(panel.querySelectorAll('.staking-download-btn').length, 0);
            assert.equal(panel.querySelectorAll('[style]').length, 0);
        } finally { w.restore(); }
    });
    test('the review: one .validate-primary (Sign), Review details is a secondary, fields are ui-fields, Copy call data keeps its icon', async () => {
        const w = msWorld();
        try {
            await w.ui.review({ multisig: w.ms, callHex: CALL });
            await flush();
            const content = w.q('#multisig-review-content');
            assert.equal(content.querySelectorAll('.validate-primary').length, 1, 'not exactly one primary in the modal');
            const sign = content.querySelector('#multisig-review-sign');
            assert.ok(sign.classList.contains('validate-primary'));
            const load = content.querySelector('#multisig-review-load');
            assert.ok(load.classList.contains('validate-secondary'), load.className);
            assert.equal(t(load), 'Review details and fee');
            for (const id of ['multisig-review-signer', 'multisig-review-call']) {
                const f = content.querySelector('#' + id);
                assert.ok(f.classList.contains('ui-input') && f.closest('.ui-field'), id);
                assert.ok(content.querySelector(`label.ui-field-label[for="${id}"]`), `${id} has no label`);
            }
            const copy = content.querySelector('#multisig-copy-call');
            assert.ok(copy.classList.contains('validate-secondary') && copy.querySelector('.bx-copy'), copy.className);
            assert.equal(t(copy), 'Copy call data for other signers');
            const glyph = copy.querySelector('.bx-copy');
            copy.click();
            await flush();
            assert.deepEqual(w.copied.length, 1);
            assert.equal(t(copy), 'Copied call data');
            assert.ok(copy.querySelector('.bx-copy') === glyph, 'the icon went');
            assert.equal(content.querySelectorAll('.staking-download-btn').length, 0);
            assert.equal(content.querySelectorAll('[style]').length, 0);
        } finally { w.restore(); }
    });
    test('no signer remembered: "Find my signer in my wallets" is a .ui-action with a search icon', async () => {
        const w = msWorld({ accounts: [], askWallets: async () => [] });
        try {
            await w.ui.review({ multisig: w.ms, callHex: CALL });
            await flush();
            const ask = w.q('#multisig-review-ask');
            assert.ok(ask.classList.contains('ui-action') && ask.querySelector('.bx-search'), ask.className);
            assert.equal(t(ask), 'Find my signer in my wallets');
        } finally { w.restore(); }
    });
    test('signing spy: the review signs the same call as before (pallet multisig, method, arguments), with the same signer, guards and evidence', async () => {
        const w = msWorld();
        try {
            await w.ui.review({ multisig: w.ms, callHex: CALL });
            await flush();
            const reviewed = show(w.calls);
            w.q('#multisig-review-sign').click();
            await flush();
            assert.equal(w.submits.length, 1);
            const o = w.submits[0];
            assert.equal(o.signingAccount.address, A);
            assert.equal(o.multisigHandled, true);
            assert.equal(o.expectedWallet, w.ms.address);
            assert.equal(o.expectedRevision, 'r1');
            assert.equal(o.label, 'Multisig transaction');
            assert.deepEqual(o.action, { key: 'multisig.transaction', params: { kind: 'approve', threshold: 2, multisig: w.ms.address, callHash: o.action.params.callHash } });
            assert.match(o.action.params.callHash, /^0x[0-9a-f]{64}$/);
            assert.ok(o.button === w.q('#multisig-review-sign'));
            await o.buildTx();
            assert.equal(reviewed, REVIEWED, 'the reviewed call changed');
            assert.equal(show(w.calls), SIGNED, 'the signed call changed');
        } finally { w.restore(); }
    });
});

// ── T5: the Advanced card markup (lib/wallet-advanced-view.js) ──
describe('T5: the Advanced card markup', () => {
    test('the module is import-free', () => {
        const src = readRepo('lib/wallet-advanced-view.js', import.meta.url);
        assert.doesNotMatch(src, /^\s*import\b/m, 'lib/wallet-advanced-view.js imports something');
    });
    const shell = (isOwn) => page(need('advancedShellHtml')({ isOwn })).doc;
    test('the shell: a kit card, three titled sections, every id kept; the add form only for the own wallet', () => {
        const doc = shell(true);
        const card = doc.querySelector('.list-container.glass.wallet-advanced');
        assert.ok(card);
        assert.ok(card.querySelector('.list-header h2 .bx-shield-quarter'));
        assert.equal(t(card.querySelector('.list-header h2')), 'Advanced');
        assert.equal(t(card.querySelector('.wallet-advanced-sub')), 'Let another account sign for this one, and work with multisig wallets');
        const secs = Array.from(card.querySelectorAll('section.ui-section'));
        assert.deepEqual(secs.map(s => s.getAttribute('aria-labelledby')), ['adv-proxies-title', 'adv-calc-title', 'adv-pending-title']);
        assert.equal(secs[2].id, 'adv-pending-section');
        assert.equal(t(doc.getElementById('adv-proxies-title')), 'Proxies');
        assert.ok(doc.getElementById('adv-proxies-title').classList.contains('ui-section-title'));
        assert.equal(t(secs[0].querySelector('.ui-section-caption')), 'A proxy is another account that can sign for this one.');
        assert.ok(secs[0].querySelector('.ui-section-caption .glossary-term[data-term="proxy"]'));
        for (const id of ['wallet-proxy-list', 'wallet-proxy-add', 'wallet-multisig-calc', 'wallet-multisig-pending']) assert.ok(doc.getElementById(id), id);
        assert.equal(t(doc.querySelector('#wallet-proxy-list .ui-empty')), 'Loading proxies...');
        assert.equal(shell(false).getElementById('wallet-proxy-add'), null, 'a looked-up account gets the add form');
        assert.equal(doc.querySelectorAll('[style]').length, 0);
        assert.equal(doc.querySelectorAll('.staking-download-btn').length, 0);
    });
    test('the add-proxy form: three labelled ui-fields in the grid, the hint, Add proxy as .ui-action, the error node hidden', () => {
        const { doc } = page(need('proxyAddFormHtml')(['Any', 'Staking <x>'], escapeHtml));
        const h = doc.querySelector('h4.ui-field-label.wallet-advanced-subtitle');
        assert.equal(t(h), 'Add a proxy');
        const grid = doc.querySelector('.proxy-add-grid');
        assert.ok(grid);
        const labels = { 'proxy-add-delegate': 'Account to add', 'proxy-add-type': 'What it may sign', 'proxy-add-delay': 'Delay in blocks' };
        for (const [id, text] of Object.entries(labels)) {
            const f = doc.getElementById(id);
            assert.ok(f && f.classList.contains('ui-input'), id);
            assert.equal(t(doc.querySelector(`label.ui-field-label[for="${id}"]`)), text);
            assert.ok(f.closest('.ui-field') && f.closest('.proxy-add-grid'), id);
        }
        assert.equal(doc.getElementById('proxy-add-delegate').getAttribute('placeholder'), 'Paste its address');
        assert.equal(doc.getElementById('proxy-add-delegate').getAttribute('data-input-kind'), 'address');
        const delay = doc.getElementById('proxy-add-delay');
        assert.equal(delay.getAttribute('data-no-input-actions'), 'numeric stepper: the browser arrows already fill this narrow field');
        assert.equal(delay.hasAttribute('title'), false, 'the delay keeps its title attribute');
        assert.equal(delay.value, '0');
        assert.equal(t(doc.getElementById(delay.getAttribute('aria-describedby').split(' ')[0])), '0 means it can sign at once.');
        assert.equal(doc.getElementById('proxy-add-type').tagName, 'SELECT');
        assert.deepEqual(Array.from(doc.querySelectorAll('#proxy-add-type option')).map(o => o.value), ['Any', 'Staking <x>']);
        const go = doc.getElementById('proxy-add-submit');
        assert.ok(go.classList.contains('ui-action') && go.querySelector('.bx-user-plus'), go.className);
        assert.equal(go.getAttribute('type'), 'button');
        assert.equal(t(go), 'Add proxy');
        const err = doc.getElementById('proxy-add-error');
        assert.ok(err.classList.contains('ui-field-error') && err.getAttribute('role') === 'alert' && err.hidden);
        assert.equal(doc.querySelectorAll('[style]').length, 0);
        for (const i of Array.from(doc.querySelectorAll('.ui-input'))) assert.ok(doc.querySelector(`label[for="${i.id}"]`), `${i.id} has no label`);
    });
    test('the calculator: one form, two labelled fields with hints, Calculate address as .ui-action submit, the result region', () => {
        const { doc } = page(need('calculatorHtml')());
        assert.equal(t(doc.getElementById('adv-calc-title')), 'Multisig address calculator');
        assert.ok(doc.getElementById('adv-calc-title').classList.contains('ui-section-title'));
        assert.equal(doc.getElementById('adv-calc-title').querySelector('.glossary-term'), null, 'a glossary term inside the heading');
        const cap = doc.querySelector('.ui-section-caption');
        assert.equal(t(cap), 'Enter the signers and how many must approve. The same details always give the same multisig address. Nothing is sent.');
        assert.ok(cap.querySelector('.glossary-term[data-term="multisig"]'));
        const form = doc.getElementById('multisig-calc-form');
        assert.ok(form.classList.contains('ui-form') && form.hasAttribute('novalidate'));
        const sig = doc.getElementById('multisig-signers');
        assert.equal(sig.tagName, 'TEXTAREA');
        assert.equal(sig.getAttribute('data-input-kind'), 'address-list');
        assert.equal(sig.getAttribute('placeholder'), 'One address per line');
        assert.equal(t(doc.querySelector('label[for="multisig-signers"]')), 'Signer addresses');
        assert.equal(t(doc.getElementById('multisig-signers-hint')), 'One address per line. Include every signer.');
        const thr = doc.getElementById('multisig-threshold');
        assert.ok(thr.classList.contains('ui-input') && thr.classList.contains('is-narrow'));
        assert.equal(thr.getAttribute('type'), 'number');
        assert.equal(thr.getAttribute('min'), '1');
        assert.equal(thr.value, '2');
        assert.equal(t(doc.querySelector('label[for="multisig-threshold"]')), 'Approvals needed');
        assert.equal(t(doc.getElementById('multisig-threshold-hint')), 'How many signers must approve a transaction.');
        for (const id of ['multisig-signers', 'multisig-threshold']) {
            assert.equal(doc.getElementById(id).getAttribute('aria-describedby'), `${id}-hint ${id}-error`);
            const e = doc.getElementById(id + '-error');
            assert.ok(e.classList.contains('ui-field-error') && e.getAttribute('role') === 'alert');
        }
        const go = doc.getElementById('multisig-calc-go');
        assert.ok(go.classList.contains('ui-action') && go.querySelector('.bx-calculator'));
        assert.equal(go.getAttribute('type'), 'submit');
        assert.ok(go.closest('#multisig-calc-form'));
        assert.equal(t(go), 'Calculate address');
        const r = doc.getElementById('multisig-result');
        assert.equal(r.getAttribute('role'), 'status');
        assert.equal(r.getAttribute('aria-live'), 'polite');
        assert.equal(doc.querySelectorAll('[style]').length, 0);
    });
});

// ── T6: the calculator's behaviour (bindCalculator) ──
function calc({ derive = (lines, n) => 'es' + 'Q'.repeat(46) + n + lines.length, write = async () => {} } = {}) {
    const { win, doc } = page('<div id="calc"></div><div id="elsewhere"><button id="other">x</button></div>');
    const root = doc.getElementById('calc');
    root.innerHTML = need('calculatorHtml')();
    const log = { derives: [], writes: [], said: [], timers: [] };
    need('bindCalculator')(root, { isValid: (a) => [A, B, C, D, addr(1, 42)].includes(a), keyOf: (a) => u8aToHex(decodeAddress(a)),
        derive: (lines, n) => { log.derives.push([lines, n]); return derive(lines, n); },
        write: (x) => { log.writes.push(x); return write(x); }, announce: (x) => log.said.push(x), esc: escapeHtml, short,
        setTimer: (f, ms) => { log.timers.push({ f, ms }); return log.timers.length; } });
    const q = (s) => doc.querySelector(s);
    const fill = (lines, n = 2) => { q('#multisig-signers').value = lines.join('\n'); q('#multisig-threshold').value = String(n); };
    return { win, doc, root, log, q, fill, go: () => q('#multisig-calc-go').click(), sig: () => q('#multisig-signers'), thr: () => q('#multisig-threshold'), result: () => q('#multisig-result') };
}
describe('T6: the calculator (bindCalculator)', () => {
    test('valid: a green panel titled "Multisig address (2 of 3)", the full address, Copy address, Open this account', () => {
        const c = calc({ derive: () => D });
        c.fill([A, B, C], 2);
        c.go();
        const p = c.result().querySelector('.ui-panel.is-ok');
        assert.ok(p, 'no green panel');
        assert.ok(p.querySelector('.bx-check-circle'));
        assert.equal(t(p.querySelector('.ui-panel-title')), 'Multisig address (2 of 3)');
        const cell = p.querySelector('.address-cell.calc-address[data-address]');
        assert.equal(cell.getAttribute('data-address'), D);
        assert.equal(t(cell.querySelector('code')), D);
        const a = p.querySelector('a.item-link');
        assert.equal(a.getAttribute('href'), `/account/${D}`);
        assert.equal(t(a), 'Open this account');
        const b = p.querySelector('button.js-copy-address.validate-secondary');
        assert.ok(b && b.querySelector('.bx-copy'));
        assert.equal(t(b.querySelector('.copy-word')), 'Copy address');
        assert.deepEqual(c.log.derives, [[[A, B, C], 2]]);
        assert.equal(c.result().querySelectorAll('[style]').length, 0);
    });
    test('copy: writes the address, "Copied" for 1500 ms keeping the icon node, announces once; a refused write changes nothing', async () => {
        const c = calc({ derive: () => D });
        c.fill([A, B, C], 2);
        c.go();
        const b = c.q('.js-copy-address');
        const glyph = b.querySelector('.bx');
        b.click();
        await flush();
        assert.deepEqual(c.log.writes, [D]);
        assert.equal(t(b.querySelector('.copy-word')), 'Copied');
        assert.ok(b.querySelector('.bx') === glyph, 'the icon node was replaced');
        assert.deepEqual(c.log.said, ['Address copied']);
        assert.equal(c.log.timers.length, 1);
        assert.equal(c.log.timers[0].ms, 1500);
        c.log.timers[0].f();
        assert.equal(t(b.querySelector('.copy-word')), 'Copy address');
        const r = calc({ derive: () => D, write: async () => { throw new Error('denied'); } });
        r.fill([A, B, C], 2);
        r.go();
        r.q('.js-copy-address').click();
        await flush();
        assert.equal(t(r.q('.js-copy-address .copy-word')), 'Copy address');
        assert.deepEqual(r.log.said, []);
        assert.equal(r.log.timers.length, 0);
    });
    const cases = [
        ['fewer than two lines', [A], 2, 'sig', 'Add at least two signer addresses.'],
        ['approvals out of range', [A, B, C], 4, 'thr', 'Approvals needed must be between 1 and 3.'],
        ['approvals zero', [A, B], 0, 'thr', 'Approvals needed must be between 1 and 2.'],
        ['a bad address', [A, 'not-an-address-at-all-xyz', 'bogus'], 2, 'sig', `Line 2 is not a valid Polkadex address: ${short('not-an-address-at-all-xyz')}`],
        ['a duplicate signer (CTO ruling)', [A, B, A], 2, 'sig', 'This signer is listed twice. Remove the duplicate.'],
        ['a duplicate in another encoding', [A, B, addr(1, 42)], 2, 'sig', 'This signer is listed twice. Remove the duplicate.']
    ];
    for (const [name, lines, n, which, sentence] of cases) {
        test(`invalid, ${name}: the field is marked, its error holds an icon and the sentence, the other is clean, no result, focus on the field`, () => {
            const c = calc();
            c.fill(lines, n);
            c.go();
            const bad = which === 'sig' ? c.sig() : c.thr(), good = which === 'sig' ? c.thr() : c.sig();
            assert.equal(bad.getAttribute('aria-invalid'), 'true');
            const err = c.q(`#${bad.id}-error`);
            assert.ok(err.querySelector('.bx-error-circle'), 'no icon in the error');
            assert.equal(t(err), sentence);
            assert.equal(good.hasAttribute('aria-invalid'), false);
            assert.equal(t(c.q(`#${good.id}-error`)), '');
            assert.equal(c.result().innerHTML.trim(), '');
            assert.ok(c.doc.activeElement === bad, 'focus is not on the field at fault');
            assert.deepEqual(c.log.derives, [], 'an invalid form was derived');
        });
    }
    test('the order of checks is kept: count, range, each address, then duplicates', () => {
        const c = calc();
        c.fill([A, A], 3);
        c.go();
        assert.equal(t(c.q('#multisig-threshold-error')), 'Approvals needed must be between 1 and 2.');
        c.fill([A, 'bogus', A], 2);
        c.go();
        assert.equal(t(c.q('#multisig-signers-error')), `Line 2 is not a valid Polkadex address: ${short('bogus')}`);
        assert.equal(c.thr().hasAttribute('aria-invalid'), false, 'the previous mark stayed');
    });
    test('derive throws: a red panel "Could not work out the address: ..."', () => {
        const c = calc({ derive: () => { throw new Error('bad key'); } });
        c.fill([A, B], 1);
        c.go();
        const p = c.result().querySelector('.ui-panel.is-error');
        assert.ok(p && p.querySelector('.bx-error-circle'));
        assert.equal(t(p), 'Could not work out the address: bad key');
    });
    test('an input event clears both marks, both errors and the result (a shown address matches the fields)', () => {
        const c = calc({ derive: () => D });
        c.fill([A], 2);
        c.go();
        c.thr().dispatchEvent(new c.win.Event('input', { bubbles: true }));
        assert.equal(c.sig().hasAttribute('aria-invalid'), false);
        assert.equal(t(c.q('#multisig-signers-error')), '');
        c.fill([A, B, C], 2);
        c.go();
        assert.ok(c.result().querySelector('[data-address]'));
        c.sig().dispatchEvent(new c.win.Event('input', { bubbles: true }));
        assert.equal(c.result().innerHTML.trim(), '');
    });
    test('the form submit (Enter in the number field submits the form) and a click each run it once', () => {
        const c = calc({ derive: () => D });
        c.fill([A, B, C], 2);
        c.go();
        assert.equal(c.log.derives.length, 1, 'a click ran it more or less than once');
        c.q('#multisig-calc-form').requestSubmit();
        assert.equal(c.log.derives.length, 2, 'a submit (Enter) did not run it once');
    });
});

// ── the REAL script.js functions, lifted into a vm with the page's own helpers ──
const lift = (name) => { const at = SCRIPT.indexOf(`function ${name}(`); assert.ok(at >= 0, `${name} not in script.js`); return (SCRIPT.slice(Math.max(0, at - 6), at) === 'async ' ? 'async ' : '') + bodyOf(SCRIPT, name); };
const line = (start) => { const i = SCRIPT.indexOf(start); assert.ok(i >= 0, start); return SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
function scriptWorld({ answer = async () => ({}), names = [], extra = {}, html = '' } = {}) {
    const { win, doc } = page(`<div id="wallet-dashboard"><div id="wallet-advanced-section"></div></div><div id="block-details"></div><div id="tx-details"></div><div id="wallet-apr-periods"></div><div id="wallet-apr-body"></div>${html}`);
    const log = { fetches: [], submits: [], watches: [], said: [], timers: [], copies: [] };
    const ctx = {
        console: { log() {}, warn() {}, error() {} }, Promise, Object, JSON, Array, Map, Set, String, Number, Math, Date, Error, encodeURIComponent, parseInt, isNaN,
        setTimeout: (f, ms) => { log.timers.push({ f, ms }); return log.timers.length; }, clearTimeout() {},
        window: win, document: doc, navigator: { clipboard: { writeText: async (x) => { log.copies.push(x); } } }, confirm: () => true,
        ...V, panelHtml, linePanelHtml, icon, clipboardWrite: sectionsModule.clipboardWrite,
        stakingEscapeHtml: escapeHtml, stakingShortAddress: short, stakingFormatNumber: (n) => Number(n).toLocaleString('en-US'), stakingFormatPDEX: (v) => Number(v || 0).toFixed(4),
        fetchApiJson: async (url) => { log.fetches.push(url); return answer(url); },
        blockDetailsContainer: doc.getElementById('block-details'), txDetailsContainer: doc.getElementById('tx-details'),
        updateSeoMeta() {}, looksLikeTxHash: () => true, renderTxNotFoundCard() {}, formatLocalDateTime: String, renderJSONTree: () => '',
        isValidPolkadexAddress, sortAddresses, createKeyMulti, encodeAddress, decodeAddress, u8aToHex, POLKADEX_SS58: 88, copyToClipboard() {},
        walletSections: { watch: (...a) => log.watches.push(a), paintProxies() {}, forgetProxies() {}, announce: (x) => log.said.push(x) },
        walletSession: { revision: () => 7 }, multisigStore: { find: () => null },
        globalApi: null, VALIDATE_ON: false, proxyPrefill: () => null, proxyTypesOf: () => ['Any', 'Staking'], ss58PrefixOf: () => 88,
        proxyDelegateProblem: (d) => (d === 'bad' ? { text: 'Delegate address is not a valid Polkadex address.' } : null), renderRecipientRefusal() {}, chainDelegate: (d) => d,
        submitSignedTx: async (o) => { log.submits.push(o); },
        walletAprData: null, walletAprDays: 30,
        ...extra
    };
    vm.createContext(ctx);
    vm.runInContext([
        'let cachedProxyTypes = null;',
        ...names.map(lift),
        'globalThis.__set = (k, v) => { if (k === "apr") walletAprData = v; };'
    ].join('\n'), ctx);
    const q = (s) => doc.querySelector(s);
    return { win, doc, ctx, log, q };
}
const httpErr = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

describe('renderApiError, site-wide (CTO ruling): an amber panel and a secondary "Try again", on two other pages too', () => {
    const pages = [
        ['the block page (fetchBlockDetails)', 'fetchBlockDetails', '#block-details', (c) => c.fetchBlockDetails(12)],
        ['the transaction page (fetchTxDetails)', 'fetchTxDetails', '#tx-details', (c) => c.fetchTxDetails(12, '0x' + 'ab'.repeat(32))]
    ];
    for (const [name, fn, sel, call] of pages) {
        test(`${name}: a failed read is a one-line amber panel "Could not load this. {msg}" and Try again reads again`, async () => {
            const w = scriptWorld({ names: ['renderApiError', fn], answer: async () => { throw httpErr(500, 'Internal error <b>'); } });
            await call(w.ctx);
            const box = w.q(sel);
            const p = box.querySelector('.ui-panel.is-warn.is-line');
            assert.ok(p, `no amber line: ${box.innerHTML.slice(0, 200)}`);
            assert.ok(p.querySelector('.bx-error'));
            assert.equal(t(p), 'Could not load this. Internal error <b>');
            assert.equal(p.querySelector('b'), null, 'the message was not escaped');
            const again = box.querySelector('button.validate-secondary[data-api-error-retry]');
            assert.ok(again && again.querySelector('.bx-refresh'), 'no secondary Try again');
            assert.equal(t(again), 'Try again');
            assert.ok(!/Error:/.test(box.textContent), 'the old "Error:" line');
            assert.equal(box.querySelectorAll('.staking-download-btn').length, 0);
            assert.deepEqual(colourStyles(box), []);
            const before = w.log.fetches.length;
            again.click();
            await flush();
            assert.equal(w.log.fetches.length, before + 1, 'Try again did not read again');
        });
        test(`${name}: the node not ready is a block amber panel with a spinner, the title and Try again`, async () => {
            const w = scriptWorld({ names: ['renderApiError', fn], answer: async () => { throw httpErr(503, 'The node is still starting.', 'RPC_NOT_READY'); } });
            await call(w.ctx);
            const box = w.q(sel);
            const p = box.querySelector('.ui-panel.is-warn');
            assert.ok(p && !p.classList.contains('is-line'), box.innerHTML.slice(0, 200));
            assert.ok(p.querySelector('.bx-loader-alt.bx-spin'));
            assert.equal(t(p.querySelector('.ui-panel-title')), 'Connecting to the Polkadex node...');
            assert.match(t(p), /The node is still starting\./);
            const again = box.querySelector('button.validate-secondary[data-api-error-retry]');
            assert.equal(t(again), 'Try again');
            assert.deepEqual(colourStyles(box), []);
        });
    }
    test('without a retry function the line has no button', () => {
        const w = scriptWorld({ names: ['renderApiError'] });
        const box = w.q('#block-details');
        w.ctx.renderApiError(box, new Error('gone'));
        assert.equal(t(box), 'Could not load this. gone');
        assert.equal(box.querySelector('button'), null);
    });
});

describe('the Advanced card in script.js (the real renderers, lifted)', () => {
    const NAMES = ['renderApiError', 'renderWalletAdvancedSection', 'renderProxyList', 'renderAddProxyForm', 'renderMultisigCalculator', 'renderMultisigPending'];
    const world = (answer, extra = {}) => scriptWorld({ names: NAMES, answer, extra });
    const PENDING = { pending: [{ callHash: '0x' + 'cd'.repeat(32), approvals: [A, B], depositor: A, when: { height: 1234, index: 1 } }, { callHash: '0x' + 'ef'.repeat(32), approvals: [C], depositor: C, when: null }] };
    const route = (over = {}) => async (url) => {
        for (const [k, v] of Object.entries(over)) if (url.includes(k)) { if (v instanceof Error) throw v; if (typeof v === 'function') return v(); return v; }
        if (url.includes('/api/proxy-types')) return { types: ['Any', 'Staking'] };
        if (url.includes('/api/multisigs/')) return { pending: [] };
        return { proxies: [] };
    };
    test('the shell is the kit card; the calculator and the pending viewer are drawn in their sections; no colour in markup', async () => {
        const w = world(route());
        await w.ctx.renderWalletAdvancedSection(A, true);
        await flush();
        const card = w.q('#wallet-advanced-section .wallet-advanced');
        assert.ok(card, 'no .wallet-advanced card');
        assert.ok(w.q('#wallet-multisig-calc #multisig-calc-form'));
        assert.ok(w.q('#wallet-multisig-pending #adv-pending-title'));
        assert.ok(w.q('#wallet-proxy-add .proxy-add-grid'));
        assert.deepEqual(colourStyles(w.q('#wallet-advanced-section')), []);
        assert.equal(w.doc.querySelectorAll('#wallet-advanced-section .staking-download-btn').length, 0);
        assert.equal(w.log.watches[0][0], 'proxies', 'the proxy list no longer follows the block');
    });
    test('a saved multisig: no pending viewer, so its section is empty (and hidden by CSS)', async () => {
        const w = world(route(), { multisigStore: { find: () => ({ address: A }) } });
        await w.ctx.renderWalletAdvancedSection(A, false);
        await flush();
        assert.equal(w.q('#wallet-multisig-pending').innerHTML, '');
        assert.equal(w.log.fetches.filter(u => u.includes('/api/multisigs/')).length, 0);
    });
    test('the pending viewer, end to end in the card: loading, list, 501, failed', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const w = world(route({ '/api/multisigs/': () => gate.then(() => PENDING) }));
        w.ctx.renderWalletAdvancedSection(A, false);
        await tick();
        const slot = w.q('#wallet-multisig-pending');
        assert.equal(t(slot.querySelector('#adv-pending-title')), 'Pending multisig approvals');
        assert.equal(t(slot.querySelector('.ui-section-caption')), 'Shown when this address is a multisig wallet.');
        const loading = slot.querySelector('.ui-empty');
        assert.ok(loading && loading.querySelector('.bx-loader-alt.bx-spin'), 'no loading line before the read');
        assert.equal(t(loading), 'Checking...');
        release();
        await flush();
        const table = slot.querySelector('table.data-table.ms-pending-table');
        assert.ok(table);
        assert.deepEqual(Array.from(table.querySelectorAll('thead th')).map(t), ['Call hash', 'Approvals', 'Started by', 'Block']);
        const cells = Array.from(table.querySelectorAll('tbody tr')[0].children);
        assert.deepEqual(cells.map(c => c.className), ['ms-cell-hash', 'ms-cell-approvals', 'ms-cell-by', 'ms-cell-block']);
        assert.deepEqual(cells.map(c => c.getAttribute('data-label')), ['Call hash', 'Approvals', 'Started by', 'Block']);
        assert.equal(t(cells[3]), '#1,234');
        assert.ok(cells[2].querySelector('a.item-link.address-cell'));
        assert.ok(cells[0].querySelector('code'));
        const foot = slot.querySelector('.ms-pending-foot');
        assert.equal(t(foot), 'To approve or cancel one, add this multisig wallet with its signers and number of approvals.');
        assert.equal(foot.querySelector('a.item-link').getAttribute('href'), '/wallet?switch=1#multisig');
        assert.deepEqual(colourStyles(slot), []);
        const none = world(route());
        await none.ctx.renderWalletAdvancedSection(A, false);
        await flush();
        assert.equal(t(none.q('#wallet-multisig-pending .ui-empty')), 'Nothing is waiting for approval on this address.');
        const off = world(route({ '/api/multisigs/': httpErr(501, 'no pallet') }));
        await off.ctx.renderWalletAdvancedSection(A, false);
        await flush();
        assert.equal(t(off.q('#wallet-multisig-pending .ui-empty')), 'Multisig is not available on this network.');
        assert.ok(off.q('#wallet-multisig-pending #adv-pending-title'), 'the 501 line lost its section title');
        const down = world(route({ '/api/multisigs/': httpErr(500, 'pending down') }));
        await down.ctx.renderWalletAdvancedSection(A, false);
        await flush();
        assert.equal(t(down.q('#wallet-multisig-pending .ui-panel.is-warn.is-line')), 'Could not load this. pending down');
        assert.ok(down.q('#wallet-multisig-pending #adv-pending-title'), 'the failed read lost its section title');
    });
    test('proxies: 501 says the network has none; a failed read is the new amber line with Try again', async () => {
        const off = world(route({ '/api/proxies/': httpErr(501, 'no pallet') }));
        await off.ctx.renderWalletAdvancedSection(A, true);
        await flush();
        const p = off.q('#wallet-proxy-list .ui-empty');
        assert.equal(t(p), 'Proxies are not available on this network.');
        const down = world(route({ '/api/proxies/': httpErr(500, 'proxies down') }));
        await down.ctx.renderWalletAdvancedSection(A, true);
        await flush();
        assert.equal(t(down.q('#wallet-proxy-list .ui-panel.is-warn.is-line')), 'Could not load this. proxies down');
        assert.equal(t(down.q('#wallet-proxy-list button[data-api-error-retry]')), 'Try again');
    });
    test('Add proxy: a bad delay marks the delay field with the new sentence; a bad delegate marks the delegate; nothing is sent', async () => {
        const w = world(route());
        await w.ctx.renderWalletAdvancedSection(A, true);
        await flush();
        const err = w.q('#proxy-add-error');
        w.q('#proxy-add-delegate').value = B;
        w.q('#proxy-add-delay').value = '20000000';
        w.q('#proxy-add-submit').click();
        await flush();
        assert.equal(err.hidden, false);
        assert.equal(err.style.display, '', 'the error is shown through style.display, not hidden');
        assert.ok(err.querySelector('.bx-error-circle'));
        assert.equal(t(err), 'Enter a delay from 0 to 10,000,000 blocks.');
        assert.equal(w.q('#proxy-add-delay').getAttribute('aria-invalid'), 'true');
        assert.equal(w.q('#proxy-add-delegate').hasAttribute('aria-invalid'), false);
        w.q('#proxy-add-delegate').value = 'bad';
        w.q('#proxy-add-delay').value = '0';
        w.q('#proxy-add-submit').click();
        await flush();
        assert.equal(w.q('#proxy-add-delegate').getAttribute('aria-invalid'), 'true');
        assert.equal(w.q('#proxy-add-delay').hasAttribute('aria-invalid'), false, 'the old mark stayed');
        assert.equal(t(err), 'Delegate address is not a valid Polkadex address.');
        assert.equal(w.log.submits.length, 0);
    });
    test('Add proxy signing spy: the same proxy.addProxy(delegate, type, delay), the same wallet and revision; the error clears', async () => {
        const w = world(route());
        await w.ctx.renderWalletAdvancedSection(A, true);
        await flush();
        w.q('#proxy-add-delegate').value = 'bad';
        w.q('#proxy-add-submit').click();
        assert.equal(w.q('#proxy-add-error').hidden, false);
        w.q('#proxy-add-delegate').value = ` ${B} `;
        w.q('#proxy-add-type').value = 'Staking';
        w.q('#proxy-add-delay').value = '7';
        w.q('#proxy-add-submit').click();
        await flush();
        assert.equal(w.log.submits.length, 1);
        const o = w.log.submits[0];
        const built = [];
        const fake = { tx: { proxy: { addProxy: (...a) => { built.push(['proxy', 'addProxy', ...a]); return 'tx'; } } } };
        assert.equal(o.buildTx(fake), 'tx');
        assert.deepEqual(built, [['proxy', 'addProxy', B, 'Staking', 7]]);
        assert.equal(o.label, 'Add Staking proxy');
        assert.deepEqual(JSON.parse(JSON.stringify(o.action)), { key: 'proxy.add', params: { delegate: B, type: 'Staking', delay: 7 } }, 'the action changed');
        assert.equal(o.expectedWallet, A);
        assert.equal(o.expectedRevision, 7);
        assert.ok(o.button === w.q('#proxy-add-submit'));
        assert.equal(o.busyText, 'Signing…');
        assert.equal(typeof o.onError, 'function');
        assert.equal(w.q('#proxy-add-error').hidden, true, 'the old error stayed');
        assert.equal(w.q('#proxy-add-delegate').hasAttribute('aria-invalid'), false, 'the old mark stayed');
        o.onError('Cancelled in the wallet.');
        assert.equal(t(w.q('#proxy-add-error')), 'Cancelled in the wallet.');
        assert.equal(w.q('#proxy-add-error').hidden, false);
    });
    test('the calculator in the page: the real derivation gives the same address as a saved multisig; copy announces through the page', async () => {
        const w = world(route());
        await w.ctx.renderWalletAdvancedSection(A, true);
        await flush();
        w.q('#multisig-signers').value = [A, B, C].join('\n');
        w.q('#multisig-threshold').value = '2';
        w.q('#multisig-calc-go').click();
        const cell = w.q('#multisig-result [data-address]');
        assert.ok(cell, w.q('#multisig-result').innerHTML.slice(0, 200));
        assert.equal(cell.getAttribute('data-address'), team().address);
        w.q('#multisig-result .js-copy-address').click();
        await flush();
        assert.deepEqual(w.log.copies, [team().address]);
        assert.deepEqual(w.log.said, ['Address copied']);
        w.q('#multisig-signers').value = [A, B, addr(1, 42)].join('\n');
        w.q('#multisig-calc-go').click();
        assert.equal(t(w.q('#multisig-signers-error')), 'This signer is listed twice. Remove the duplicate.');
    });
});

describe('T7: the pending viewer markup (lib/wallet-advanced-view.js)', () => {
    test('loading, empty, two rows, 501; no style anywhere', () => {
        const load = page(need('pendingLoadingHtml')()).doc;
        assert.equal(t(load.getElementById('adv-pending-title')), 'Pending multisig approvals');
        assert.ok(load.querySelector('.ui-empty .bx-loader-alt.bx-spin'));
        assert.equal(t(load.querySelector('.ui-empty')), 'Checking...');
        const empty = page(need('pendingHtml')([], fmt)).doc;
        assert.equal(t(empty.querySelector('.ui-empty')), 'Nothing is waiting for approval on this address.');
        const two = page(need('pendingHtml')([{ callHash: '0x' + '11'.repeat(32), approvals: [A], depositor: A, when: { height: 99 } }, { callHash: '', approvals: [], depositor: '', when: null }], fmt)).doc;
        assert.equal(two.querySelectorAll('tbody tr').length, 2);
        for (const td of Array.from(two.querySelectorAll('tbody td'))) assert.ok(td.getAttribute('data-label'), td.outerHTML);
        assert.equal(t(two.querySelector('tbody tr .ms-cell-block')), '#99');
        const off = page(need('pendingUnavailableHtml')()).doc;
        assert.equal(t(off.querySelector('.ui-empty')), 'Multisig is not available on this network.');
        for (const d of [load, empty, two, off]) assert.equal(d.querySelectorAll('[style]').length, 0);
        assert.ok(!/\u2014|\u2013/.test(need('pendingHtml')([{ callHash: '', approvals: [], depositor: '', when: null }], fmt)), 'a long dash for a missing value');
    });
});

// ── the sweep: the wallet page body (rows 1 to 17) ──
describe('sweep rows 1 to 8: the wallet frame (lib/wallet-sections.js)', () => {
    const frame = (over = {}) => {
        const sections = createWalletSections({ doc: page().doc, post: { subscribe: () => () => {} }, known: { list: () => [] }, data: () => null, setData() {}, fmt: { ...fmt, pdex: (v) => Number(v || 0).toFixed(4), duration: String },
            payout: { tileHtml: () => '<div class="staking-summary-card" id="wallet-unpaid-tile"></div>' }, multisigName: () => null });
        const html = sections.frameHtml({ address: ME, identity: 'Alice', balance: { total: 1 }, staking: { nominating: [] }, rewards: {}, network: {} },
            { isOwn: true, canSwitch: true, viewing: '', usd: '', bar: '<div id="wallet-action-bar"></div>', price: { history: [], configured: true }, latestPrice: null, ...over });
        return page(`<div id="wallet-dashboard">${html}</div>`).doc;
    };
    test('rows 1 to 3: Switch wallet, Disconnect and Copy address are secondaries with icons; no download-button class', () => {
        const doc = frame();
        const sw = doc.getElementById('wallet-switch-btn');
        assert.ok(sw.classList.contains('validate-secondary') && sw.querySelector('.bx-transfer-alt'), sw.className);
        assert.equal(t(sw), 'Switch wallet');
        const dc = doc.getElementById('wallet-disconnect-btn');
        assert.ok(dc.classList.contains('validate-secondary') && dc.querySelector('.bx-log-out'), dc.className);
        assert.equal(t(dc), 'Disconnect');
        const cp = doc.getElementById('wallet-head-copy');
        assert.ok(cp.classList.contains('validate-secondary') && cp.classList.contains('wallet-head-copy'));
        assert.equal(doc.querySelectorAll('.staking-download-btn').length, 0);
        assert.equal(declsAt('.wallet-head-actions .validate-secondary', 360)['min-height'], '44px');
        assert.equal(declsIn('.wallet-head-actions .validate-secondary[hidden]', '').display, 'none');
    });
    test('rows 5 to 8: the price, the empty chart, the validators count and the APR icon carry classes, not inline colours', () => {
        const doc = frame({ price: { history: [], configured: false } });
        const price = doc.getElementById('wallet-price-header-price');
        assert.ok(price.classList.contains('wallet-header-figure'));
        assert.ok(doc.querySelector('#wallet-price-chart-wrap .wallet-chart-empty'));
        assert.equal(t(doc.querySelector('.wallet-chart-empty')), 'Price feed not configured.');
        assert.ok(doc.getElementById('wallet-my-validators-count').classList.contains('wallet-header-note'));
        assert.ok(doc.querySelector('#wallet-apr-card .list-header h2 .bx-line-chart'));
        assert.deepEqual(colourStyles(doc), []);
        assert.equal(declsIn('.wallet-header-figure', '').color, 'var(--text-primary)');
        assert.equal(declsIn('.wallet-chart-empty', '').color, 'var(--text-secondary)');
        assert.equal(declsIn('.wallet-header-note', '').color, 'var(--text-secondary)');
        assert.equal(declsIn('#wallet-apr-card .list-header h2 .bx', '').color, 'var(--accent-violet-text)');
    });
    test('row 4: no proxies is one quiet line, "No proxies yet." (plus " Add one below." on the own wallet)', () => {
        const own = page(sectionsModule.proxyListHtml({ proxies: [] }, { isOwn: true, ...fmt })).doc;
        const p = own.querySelector('p.ui-empty');
        assert.equal(t(p), 'No proxies yet. Add one below.');
        const other = page(sectionsModule.proxyListHtml({ proxies: [] }, { isOwn: false, ...fmt })).doc;
        assert.equal(t(other.querySelector('p.ui-empty')), 'No proxies yet.');
        assert.equal(own.querySelectorAll('[style]').length, 0);
    });
});

describe('sweep rows 11 and 12: the APR body when the history failed or nothing is staked (renderWalletAprCard)', () => {
    const apr = (data) => {
        const w = scriptWorld({ names: ['renderWalletAprCard', 'computeWalletApr'], extra: { walletAprData: data } });
        const at = SCRIPT.indexOf('const WALLET_APR_PERIODS = [');
        vm.runInContext(SCRIPT.slice(at, SCRIPT.indexOf('];', at) + 2), w.ctx);
        w.ctx.renderWalletAprCard();
        return w.q('#wallet-apr-body');
    };
    test('failed: an amber line "Reward history could not be loaded. Reload to try again."; no pink spinner', () => {
        const body = apr(null);
        const p = body.querySelector('.ui-panel.is-warn.is-line');
        assert.ok(p && p.querySelector('.bx-error'), body.innerHTML.slice(0, 200));
        assert.equal(t(p), 'Reward history could not be loaded. Reload to try again.');
        assert.equal(body.querySelector('.bx-spin'), null);
        assert.deepEqual(colourStyles(body), []);
    });
    test('nothing staked: two quiet lines', () => {
        const body = apr({ apr: { bondedAmount: 0 }, claimed: [] });
        assert.deepEqual(Array.from(body.querySelectorAll('p.ui-empty')).map(t), ['No staked PDEX on this account.', 'Stake PDEX to start earning rewards.']);
        assert.deepEqual(colourStyles(body), []);
    });
    test('a figure and an empty window draw no inline colour either', () => {
        const now = Date.now();
        const figure = apr({ apr: { bondedAmount: 1000, apr30d: 12.5 }, claimed: [{ amount: 1, timestamp: now - 86400000 }] });
        assert.match(t(figure), /12\.50%/);
        assert.deepEqual(colourStyles(figure), []);
        const empty = apr({ apr: { bondedAmount: 1000 }, claimed: [] });
        assert.deepEqual(colourStyles(empty), []);
    });
});

describe('sweep rows 16 and 17: Change validators and the recipient Copy', () => {
    test('Change validators is a .ui-action with a refresh icon, attributes and label unchanged', () => {
        const { doc } = page(renderNominationStatus({ nominating: true, banners: [{ kind: 'no-rewards', title: 'You are earning no rewards this era', text: 'x', action: 'change' }], targets: [] }, { canChange: true }));
        const b = doc.querySelector('[data-nom-action="change"]');
        assert.ok(b.classList.contains('ui-action') && b.querySelector('.bx-refresh'), b.className);
        assert.equal(b.getAttribute('data-banner'), 'no-rewards');
        assert.equal(t(b), 'Change validators');
        assert.equal(doc.querySelectorAll('.staking-download-btn').length, 0);
    });
    test('the refusal Copy is a .validate-secondary with a copy icon, no inline style; the word changes, the icon stays', async () => {
        const { doc } = page('<div id="e"></div>');
        const el = doc.getElementById('e');
        const c = checkRecipient(addr(2, 42));
        renderRecipientRefusal(el, c, { clipboard: { writeText: async () => {} } });
        const b = el.querySelector('button.js-recipient-copy');
        assert.ok(b.classList.contains('validate-secondary') && !b.classList.contains('staking-download-btn'), b.className);
        assert.equal(b.hasAttribute('style'), false);
        const glyph = b.querySelector('.bx-copy');
        assert.ok(glyph);
        b.click();
        await flush();
        assert.equal(t(b), 'Copied');
        assert.ok(b.querySelector('.bx-copy') === glyph);
    });
});

// ── group C: the modals opened from the wallet page (index.html) ──
describe('sweep rows 40 and 41: the stake, payout, send, unstake and identity modals', () => {
    const body = INDEX.slice(INDEX.indexOf('<body'), INDEX.lastIndexOf('</body>') + 7).replace(/<script[\s\S]*?<\/script>/g, '');
    const doc = () => { const d = page().doc; d.body.outerHTML = body; return d; };
    const MODALS = ['stake-modal', 'payout-modal', 'send-modal', 'unstake-modal', 'identity-modal'];
    test('each is .ui-modal with only display: none inline; the card is .ui-modal-card (stake keeps its own body); no colour written in markup', () => {
        const d = doc();
        for (const id of MODALS) {
            const m = d.getElementById(id);
            assert.ok(m.classList.contains('modal') && m.classList.contains('ui-modal'), `${id}: ${m.className}`);
            assert.equal(m.getAttribute('style').replace(/\s+/g, '').replace(/;$/, ''), 'display:none', `${id} keeps more than its state inline`);
            if (id !== 'stake-modal') assert.ok(m.querySelector(':scope > .glass.ui-modal-card'), `${id} has no .ui-modal-card`);
            assert.deepEqual(colourStyles(m), [], id);
            assert.equal(m.querySelectorAll('.staking-download-btn').length, 0, id);
        }
        assert.ok(d.querySelector('#payout-modal p.ui-section-caption'));
        assert.ok(d.getElementById('payout-total').classList.length > 0, '#payout-total has no class');
    });
    test('.ui-modal and .ui-modal-card carry the dialog declarations', () => {
        const m = declsIn('.ui-modal', '');
        assert.equal(m.position, 'fixed');
        assert.equal(m.inset, '0');
        assert.equal(m['align-items'], 'center');
        assert.equal(m['justify-content'], 'center');
        assert.ok(/rgba\(0,\s*0,\s*0,\s*0?\.8\)/.test(m.background), m.background);
        assert.equal(m.display, undefined, '.ui-modal must not set display (the page toggles it inline)');
        const c = declsIn('.ui-modal-card', '');
        assert.equal(c.position, 'relative');
        assert.equal(c.width, '100%');
        assert.equal(c['border-radius'], 'var(--radius-lg)');
        assert.ok(c['max-width'] && c['max-height'] && c['overflow-y'] === 'auto', JSON.stringify(c));
    });
    test('identity: inputs are .ui-input, the notes are hint lines without long dashes, the pill is a chip, the warning an amber panel, Reset a text button', () => {
        const d = doc();
        const m = d.getElementById('identity-modal');
        for (const k of ['display', 'legal', 'email', 'twitter', 'web', 'riot']) {
            const i = d.getElementById('identity-' + k);
            assert.ok(i.classList.contains('ui-input'), k);
            assert.equal(i.hasAttribute('style'), false, k);
            assert.ok(d.querySelector(`label[for="identity-${k}"]`), k);
        }
        for (const l of Array.from(m.querySelectorAll('label'))) assert.ok(!/[\u2014\u2013]/.test(l.textContent), `a long dash in "${t(l)}"`);
        assert.ok(m.querySelectorAll('.ui-field-hint').length >= 4, 'the label notes are not hint lines');
        assert.ok(d.getElementById('identity-modal-status-pill').classList.contains('ui-chip'));
        const warn = d.getElementById('identity-modal-parent-warning');
        assert.ok(warn.classList.contains('ui-panel') && warn.classList.contains('is-warn'));
        const reset = d.getElementById('clear-identity-tx-btn');
        assert.ok(reset.classList.contains('validate-text-btn') && !reset.classList.contains('staking-download-btn'), reset.className);
        assert.equal(t(reset), 'Reset (clear)');
        assert.ok(/display:\s*none/.test(reset.getAttribute('style')), 'Reset is not hidden until an identity exists');
        assert.ok(declsIn('#clear-identity-tx-btn:hover', '').color === 'var(--accent-red)', 'Reset has no red hover');
    });
    test('identity: opening paints the pill as a chip with a role class, never an inline colour; close still toggles display', async () => {
        const d = doc();
        const w = scriptWorld({ names: ['openIdentityModal', 'showIdentityError', 'hideIdentityError', 'wireIdentityModalHandlers'], answer: async () => ({ hasIdentity: true, info: { display: 'Al' }, basicDeposit: 1, fieldDeposit: 1, deposit: 1 }),
            extra: { document: d, getStoredWallet: () => A, showTxNotice() {}, updateIdentityDepositEstimate() {}, submitSetIdentity() {}, submitClearIdentity() {} } });
        vm.runInContext(line('const IDENTITY_FIELD_KEYS = '), w.ctx);
        w.ctx.wireIdentityModalHandlers();
        await w.ctx.openIdentityModal();
        const pill = d.getElementById('identity-modal-status-pill');
        assert.ok(pill.classList.contains('ui-chip') && pill.classList.contains('is-positive'), pill.className);
        assert.equal(t(pill), 'Identity set');
        assert.equal(pill.getAttribute('style') || '', '');
        const modal = d.getElementById('identity-modal');
        assert.equal(modal.style.display, 'flex');
        d.getElementById('close-identity-modal').click();
        assert.equal(modal.style.display, 'none');
    });
});

// ── T8: the scenes (tools/preview-scenes.mjs, set "advanced") ──
const SCENES = {
    'advanced-default': ['#multisig-calc-go.ui-action'],
    'advanced-derived': ['#multisig-result .ui-panel.is-ok [data-address]'],
    'advanced-invalid': ['#multisig-signers[aria-invalid="true"]'],
    'multisig-discovering': ['.multisig-discover[disabled]', '.multisig-discovery-status .bx-spin'],
    'multisig-found': ['.multisig-discovery-status.is-ok'],
    'multisig-none': ['.multisig-discovery-status.is-info'],
    'multisig-failed': ['.multisig-discovery-status.ui-panel.is-warn:not(.is-line)', '.multisig-discover:not([disabled])']
};
describe('T8: the 14 new scenes and the four sections scenes follow the page rules', () => {
    const world = async (set, id) => { try { return await tool.sceneWorld(set, id); } catch (e) { assert.fail(`no "${set}" scene "${id}" in tools/preview-scenes.mjs: ${e.message}`); } };
    const visible = (el) => !el.closest('[hidden]');
    const pageRules = (w, id) => {
        const doc = w.doc;
        assert.equal(Array.from(doc.querySelectorAll('.wallet-action-btn.primary')).filter(visible).length, 1, `${id}: not exactly one visible primary (Send)`);
        for (const slot of ['#wallet-multisig-slot', '#wallet-advanced-section']) {
            const el = doc.querySelector(slot);
            assert.ok(el, `${id}: no ${slot}`);
            assert.equal(el.querySelectorAll('.validate-primary, .wallet-action-btn.primary').length, 0, `${id}: a primary inside ${slot}`);
            assert.equal(Array.from(el.querySelectorAll('[style]')).filter(e => /gradient/.test(e.getAttribute('style'))).length, 0);
            assert.deepEqual(colourStyles(el), [], `${id}: a colour written in markup inside ${slot}`);
        }
        assert.deepEqual(colourStyles(doc.getElementById('wsec-head')), [], `${id}: a colour in the head`);
        assert.equal(doc.body.querySelectorAll('.staking-download-btn').length, 0, `${id}: a .staking-download-btn on the page`);
    };
    for (const [id, needs] of Object.entries(SCENES)) {
        test(`${id}: ${needs.join(', ')}; the page rules`, async () => {
            const w = await world('advanced', id);
            for (const n of needs) assert.ok(w.doc.querySelector(n), `${id}: no ${n}`);
            if (id === 'advanced-invalid') assert.notEqual(t(w.doc.getElementById('multisig-signers-error')), '');
            if (id === 'multisig-found') assert.equal(w.doc.querySelectorAll('.multisig-saved-list [data-multisig]').length, 2);
            assert.ok(w.doc.querySelector('#wallet-advanced-section .wallet-advanced'), `${id}: not the real Advanced card`);
            assert.ok(w.doc.querySelector('#wallet-multisig-slot .multisig-panel'), `${id}: not the real Multisig wallets card`);
            assert.ok(w.doc.getElementById('wsec-head'), `${id}: not the real frame`);
            pageRules(w, id);
        });
    }
    for (const id of ['send-included', 'proxy-removed', 'updating', 'could-not-refresh']) {
        test(`sections-${id}: the page rules`, async () => {
            const w = await world('sections', id);
            pageRules(w, 'sections-' + id);
        });
    }
});

// ── the glossary on these cards and the help topic that describes them (spec section 7, Glossary) ──
describe('glossary: "approvals needed", not "threshold"; "calculate", not "derive"; "started by", not "depositor"', () => {
    test('the multisig glossary term the calculator caption opens says neither threshold nor derived', () => {
        const at = SCRIPT.indexOf('const GLOSSARY = {');
        const ctx = vm.createContext({});
        vm.runInContext(SCRIPT.slice(at, SCRIPT.indexOf('};', at) + 2) + ';globalThis.G = GLOSSARY;', ctx);
        assert.doesNotMatch(ctx.G.multisig, /threshold|derive/i, ctx.G.multisig);
        assert.ok(ctx.G.proxy, 'the proxy term went');
    });
    test('the help topic on proxies and multisig is brought in line', async () => {
        const { HELP_TOPICS } = await import('../lib/help-topics.js');
        const topic = HELP_TOPICS.find(x => x.slug === 'proxies-and-multisig');
        assert.ok(topic, 'no proxies-and-multisig topic');
        const text = JSON.stringify(Object.fromEntries(Object.entries(topic).filter(([k]) => k !== 'keywords')));
        for (const word of [/\bthreshold/i, /\bderived?\b/i, /\bdepositor\b/i]) assert.doesNotMatch(text, word);
    });
});
