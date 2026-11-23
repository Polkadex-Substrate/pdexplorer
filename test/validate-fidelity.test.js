// The designer's fidelity review of Work Packages 1 and 2 (spec cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// "Revision 2026-11-22: fidelity review rulings"). The numbers in the headings are the ruling numbers.
//
// Every account is 32 bytes of one repeated value at prefix 88 and belongs to no one; every key is synthetic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { validatorStatusModel } from '../lib/validator-status.js';
import { pathState, renderPath, PATH_STEPS, STEP_CHIPS } from '../lib/validator-path.js';
import { mountValidatePage, mountKeysPage, renderKeysPage, renderValidatorStatus } from '../lib/validator-status-view.js';
import { proxiedStashesHtml, PROXIED_ALWAYS_LINE } from '../lib/proxied-stashes.js';
import { renderNodeGuide } from '../lib/validator-node-guide.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { WALLET_KEYS } from '../lib/wallet-session.js';
import { readRepo, stripComments } from './helpers/source.js';
import { parseRules } from './helpers/css-rules.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(91), OTHER = addr(92);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const BLOB = '0x' + Object.values(KEYS).map(h => h.slice(2)).join('');
const short = (a) => a.slice(0, 8) + '...' + a.slice(-6);
const snap = (over = {}) => ({
    address: STASH, bonded: true, controller: STASH, ledger: { total: String(500n * PDEX), active: String(500n * PDEX) },
    intent: true, prefs: { commission: 50_000_000, blocked: false },
    nextKeys: KEYS, queuedKeys: KEYS, inQueued: true, inSession: true,
    activeImOnlineKey: KEYS.im_online, disabled: false, imOnline: true, heartbeat: true, blocks: 2,
    activeEra: 500, currentEra: 500, sessionIndex: 3000, sessionProgress: 0.62, epochDuration: 1200, blockTimeMs: 12000, sessionsPerEra: 6, eraStartSession: 2998,
    exposure: { total: String(90_000n * PDEX), own: String(500n * PDEX), nominatorCount: 300, pageCount: 2 }, nextExposure: null,
    points: { points: 1200, rank: 10, of: 200 }, lastEra: { points: 7000, reward: String(37n * PDEX) },
    lastSlashEra: null, incidents: [], identity: { name: 'Alpha', judgements: [] }, proxies: [], bondingDuration: 28,
    ...over
});
const params = () => ({ specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, maxValidatorsCount: 250, lowestElectedTotal: String(40_000n * PDEX), medianCommission: 100_000_000 });
const STATES = {
    'not-bonded': { bonded: false, controller: null, ledger: null, intent: false, prefs: null, nextKeys: null, queuedKeys: null, inQueued: false, inSession: false, exposure: null, points: null, lastEra: null },
    'bonded-no-keys': { nextKeys: null, queuedKeys: null, inQueued: false, inSession: false, exposure: null },
    'keys-not-validating': { intent: false, prefs: null, inQueued: false, inSession: false, exposure: null },
    waiting: { inQueued: false, inSession: false, exposure: null },
    'elected-next': { inSession: false, inQueued: true, exposure: null },
    active: {},
    'active-leaving': { intent: false },
    disabled: { disabled: true }
};
const NONE = { status: 'none', address: '' };

function dom(width = 1280) {
    const w = new Window({ url: 'http://localhost/validate', width });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const flush = (n = 20) => new Promise(r => setTimeout(r, n));
const never = new Promise(() => {});
function deps(over = {}, { state = {}, status = null, alerts = false } = {}) {
    const urls = [];
    return {
        urls,
        account: { status: 'connected', address: STASH }, urlAddress: '', isSame: (a, b) => a === b,
        fetchJson: async (u) => {
            urls.push(u);
            if (u === '/api/validator/params') return params();
            if (u.startsWith('/api/proxied-stashes/')) return { address: STASH, stashes: [], capped: false, partial: false };
            if (u === '/api/validator-alerts/status') return { enabled: alerts };
            const m = /^\/api\/validator\/([^/]+)\/status$/.exec(u);
            if (m) {
                if (status === 'hang') return never;
                if (status instanceof Error) throw status;
                return { ...validatorStatusModel(snap({ address: decodeURIComponent(m[1]), ...state }), params()), address: decodeURIComponent(m[1]) };
            }
            if (u.startsWith('/api/session-keys/check')) return status;
            throw new Error('unexpected ' + u);
        },
        helpIcon: () => '', esc: escapeHtml, shortAddr: short, navigate: () => {},
        ...over
    };
}
const httpErr = (s) => Object.assign(new Error('x'), { status: s });
async function hub(o = {}, opts = {}, width = 1280) {
    const t = dom(width);
    const d = deps(o, opts);
    const p = mountValidatePage(t.el, d);
    if (opts.status === 'hang') await flush(); else { await p; await flush(); }
    return { ...t, d, hubEl: t.el.querySelector('.validate-hub') };
}
const before = (a, b) => !!(a.compareDocumentPosition(b) & 4);   // a precedes b
const words = (s) => (String(s).match(/[A-Za-z0-9][\w'.,%-]*/g) || []).length;

// ── 1: the path strip form per chain state ──
describe('1: path strip form per chain state', () => {
    const FULL = ['not-bonded', 'bonded-no-keys', 'keys-not-validating'];
    const COMPACT = ['waiting', 'elected-next', 'active', 'active-leaving', 'disabled'];
    const cases = [
        ['no wallet', { account: NONE }, {}, 'full'],
        ...FULL.map(s => [`own, ${s}`, {}, { state: STATES[s] }, 'full']),
        ...COMPACT.map(s => [`own, ${s}`, {}, { state: STATES[s] }, 'compact']),
        ['restoring', { account: { status: 'restoring', address: '' } }, {}, 'compact-later'],
        ['own, loading', {}, { status: 'hang' }, 'compact-later'],
        ['own, read failed', {}, { status: httpErr(503) }, 'compact-later'],
        ['looked-up stash', { urlAddress: OTHER }, {}, 'none']
    ];
    for (const [name, o, opts, form] of cases) {
        test(`${name}: ${form}`, async () => {
            const { el } = await hub(o, opts);
            const ol = el.querySelector('.validate-path');
            if (form === 'none') { assert.equal(ol, null); return; }
            assert.ok(ol, 'a path strip');
            assert.equal(ol.classList.contains('is-compact'), form !== 'full', `${name}: compact is ${form !== 'full'}`);
            if (form === 'full') {
                assert.equal(ol.querySelectorAll('.validate-path-sub').length, 3);
                return;
            }
            assert.equal(ol.querySelectorAll('.ui-chip').length, 0, 'no chips in the compact form');
            assert.equal(ol.querySelectorAll('.validate-path-sub').length, 0, 'no sub lines in the compact form');
            assert.ok(ol.querySelector('a[href="/validate/node"]'), 'Run a node stays a link');
            assert.ok(ol.querySelector('a[href="/validate/setup"]'), 'Set up stays a link');
            assert.equal(ol.querySelectorAll('a').length, 2, 'Manage is not a link');
            if (form === 'compact-later') assert.equal(ol.querySelectorAll('.ui-step.is-later').length, 3, 'every step later');
            if (form === 'compact') {
                const slot = el.querySelector('#validate-path-slot');
                assert.ok(slot.nextElementSibling.classList.contains('validate-dash'), 'the dashboard straight after the one line');
            }
        });
    }
    test('no wallet: the full path comes before the connect bar', async () => {
        const { el } = await hub({ account: NONE });
        assert.ok(before(el.querySelector('.validate-path'), el.querySelector('.validate-connect')));
    });
    test('renderPath compact: one ol of three markers and names, links on steps 1 and 2 only', () => {
        const { doc } = dom();
        doc.body.innerHTML = renderPath(pathState('active', { connected: true, own: true }), { esc: escapeHtml, compact: true });
        const li = Array.from(doc.querySelectorAll('ol.validate-path.is-compact > li'));
        assert.equal(li.length, 3);
        assert.deepEqual(li.map(l => (l.querySelector('a') || { getAttribute: () => null }).getAttribute('href')), ['/validate/node', '/validate/setup', null]);
        assert.deepEqual(li.map(l => l.textContent.trim()), ['Run a node', 'Set up', 'Manage'].map((n, i) => (i < 2 ? 'done' : '3') + n));
        assert.equal(li[2].getAttribute('aria-current'), 'step');
    });
});

// ── 2: the trust row is the last element of the hub; the lookup folds at 640 on an own stash ──
describe('2: trust row last, lookup behind a disclosure at 640 on an own stash', () => {
    const cases = [
        ['no wallet', { account: NONE }, {}],
        ['own, active', {}, {}],
        ['own, not-bonded', {}, { state: STATES['not-bonded'] }],
        ['looked-up stash', { urlAddress: OTHER }, {}],
        ['restoring', { account: { status: 'restoring', address: '' } }, {}],
        ['read failed', {}, { status: httpErr(503) }],
        ['bad address', { account: NONE, urlAddress: 'e-not-an-address' }, { status: httpErr(400) }]
    ];
    for (const [name, o, opts] of cases) {
        test(`${name}: the trust row is the hub's last element and not in the header`, async () => {
            const { hubEl } = await hub(o, opts);
            assert.ok(hubEl.lastElementChild.classList.contains('ui-trust'), `last is ${hubEl.lastElementChild.className}`);
            assert.equal(hubEl.querySelector('.validate-header .ui-trust'), null);
            assert.equal(hubEl.querySelectorAll('.ui-trust').length, 1);
        });
    }
    test('own stash at 375: the lookup is inside a closed details "Look up any stash"', async () => {
        const { el } = await hub({}, {}, 375);
        const det = el.querySelector('#validate-lookup-form').closest('details');
        assert.ok(det && det.classList.contains('validate-disclosure'));
        assert.equal(det.open, false);
        assert.equal(det.querySelector('summary').textContent.trim(), 'Look up any stash');
    });
    test('own stash at 1280, and no wallet at 375: the lookup is not folded away', async () => {
        for (const [o, width] of [[{}, 1280], [{ account: NONE }, 375]]) {
            const { el } = await hub(o, {}, width);
            const det = el.querySelector('#validate-lookup-form').closest('details');
            assert.ok(!det || det.open, `width ${width}: the lookup is visible`);
        }
    });
});

// ── 3: focus without scroll after the chain read; Retry keeps the scroll ──
describe('3: the headline takes focus without scrolling after the read', () => {
    const spyFocus = (w) => { const calls = []; const real = w.HTMLElement.prototype.focus; w.HTMLElement.prototype.focus = function (o) { calls.push([this.id, o]); return real.call(this, o); }; return calls; };
    test('after the chain read: focus({ preventScroll: true }) on the headline', async () => {
        const t = dom(375); const calls = spyFocus(t.w);
        await mountValidatePage(t.el, deps({}, { state: STATES['not-bonded'] })); await flush();
        const h = calls.filter(c => c[0] === 'validate-headline');
        assert.equal(h.length, 1);
        assert.deepEqual(h[0][1], { preventScroll: true });
    });
    test('Retry: the headline takes focus with the scroll', async () => {
        const t = dom(375); const calls = spyFocus(t.w);
        await mountValidatePage(t.el, deps({}, { status: httpErr(503) })); await flush();
        calls.length = 0;
        t.el.querySelector('[data-validate-action="retry"]').click(); await flush();
        const h = calls.filter(c => c[0] === 'validate-headline');
        assert.equal(h.length, 1);
        assert.ok(!h[0][1] || !h[0][1].preventScroll, 'Retry scrolls to the answer');
    });
});

// ── 4: two pinks: the header Connect Wallet is an outline when the page draws its own primary ──
const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify({ probe: ['#connect-wallet-btn.is-outline', '.validate-primary'], ...scenario })], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}
describe('4: the header button and the page primary', () => {
    test('headerLook: connected wins; no wallet and a page primary is an outline; else solid', async () => {
        const { headerLook, PAGE_PRIMARY_SELECTOR } = await import('../lib/ui-parts.js');
        assert.equal(headerLook({ connected: true, pagePrimary: true }), 'connected');
        assert.equal(headerLook({ connected: true, pagePrimary: false }), 'connected');
        assert.equal(headerLook({ connected: false, pagePrimary: true }), 'outline');
        assert.equal(headerLook({ connected: false, pagePrimary: false }), 'solid');
        assert.match(PAGE_PRIMARY_SELECTOR, /\.validate-primary/);
        assert.match(PAGE_PRIMARY_SELECTOR, /\.wallet-option-row\.is-primary/);
    });
    const ON = { pdex_validate_enabled: '1' };
    const ext = (n) => encodeAddress(new Uint8Array(32).fill(n), 42);
    const A = addr(41);
    const remembered = (a, src) => ({ [WALLET_KEYS.address]: a, [WALLET_KEYS.source]: src, [WALLET_KEYS.lastSource]: src, [WALLET_KEYS.lastUsed]: a });
    test('/validate with no wallet: the connect bar is the primary, the header is an outline', async () => {
        const r = await page({ path: 'validate', seed: ON });
        assert.equal(r.page, 'validate');
        assert.equal(r.probe['.validate-primary'].count, 1);
        assert.equal(r.probe['#connect-wallet-btn.is-outline'].count, 1);
        assert.deepEqual(r.errors, []);
    });
    test('/validate/keys with no wallet: Check keys is the primary, the header is an outline', async () => {
        const r = await page({ path: 'validate/keys', seed: ON, api: { '/api/validator/params': params() } });
        assert.equal(r.probe['#connect-wallet-btn.is-outline'].count, 1);
    });
    test('leaving /validate: the header is solid again', async () => {
        const r = await page({ path: 'validate', seed: ON, steps: [{ go: '/validators' }] });
        assert.equal(r.probe['#connect-wallet-btn.is-outline'].count, 0);
    });
    test('/validate/<address> with no wallet: no page primary, the header stays solid', async () => {
        const r = await page({ path: 'validate/' + OTHER, seed: ON, api: { '/api/validator/': { ...validatorStatusModel(snap({ address: OTHER }), params()), address: OTHER } } });
        assert.equal(r.probe['.validate-primary'].count, 0);
        assert.equal(r.probe['#connect-wallet-btn.is-outline'].count, 0);
    });
    test('connected on /validate: the connected look; after Disconnect the page draws Connect wallet and the header turns outline', async () => {
        const model = { ...validatorStatusModel(snap({ address: A, ...STATES['not-bonded'] }), params()), address: A };
        const api = { '/api/validator/': model, '/api/proxied-stashes/': { address: A, stashes: [], capped: false, partial: false } };
        const a = await page({ path: 'validate', seed: { ...ON, ...remembered(A, 'polkadot-js') }, wallets: { 'polkadot-js': [ext(41)] }, api });
        assert.equal(a.final.connectedClass, true);
        assert.equal(a.probe['#connect-wallet-btn.is-outline'].count, 0);
        const b = await page({ path: 'validate', seed: { ...ON, ...remembered(A, 'polkadot-js') }, wallets: { 'polkadot-js': [ext(41)] }, api,
            steps: [{ click: '#connect-wallet-btn' }, { click: '[data-wallet-action="disconnect"]' }] });
        assert.equal(b.final.connectedClass, false);
        assert.equal(b.probe['#connect-wallet-btn.is-outline'].count, 1, 'the wallet change re-reads the page primary');
    });
});

// ── 5, 8 and 21: the preview scenes draw the real header and real fixtures ──
describe('5, 8, 21: preview scenes', () => {
    const sceneWorld = async (wp, id) => (await import('../tools/preview-scenes.mjs')).sceneWorld(wp, id);
    const look = (w) => { const b = w.doc.querySelector('header.topbar #connect-wallet-btn'); return b.classList.contains('is-connected') ? 'connected' : b.classList.contains('is-outline') ? 'outline' : 'solid'; };
    const want = [
        [1, 'wallet-none-installed', 'outline'], [1, 'wallet-two-ext-and-phone', 'outline'], [1, 'wallet-switch-current', 'connected'],
        [2, 'hub-no-wallet', 'outline'], [2, 'hub-active', 'connected'], [2, 'hub-not-bonded', 'connected'], [2, 'keys-empty', 'outline'], [2, 'hub-lookup-bad-address', 'solid']
    ];
    for (const [wp, id, l] of want) {
        test(`5: ${id}: the header is ${l}`, async () => {
            const w = await sceneWorld(wp, id);
            assert.equal(look(w), l);
            if (l === 'connected') {
                assert.equal(w.doc.querySelector('#connect-wallet-label').textContent, 'My Account');
                assert.match(w.doc.querySelector('#connect-wallet-sub').textContent, /^\w{8}…\w{6}$/, 'the short address, as the real header draws it');
            }
        });
    }
    test('8: hub-waiting and hub-keys-not-validating show no era points or rank (not in the active set)', async () => {
        for (const id of ['hub-waiting', 'hub-keys-not-validating']) {
            const w = await sceneWorld(2, id);
            const t = w.q('#validate-root').textContent;
            assert.ok(!/4,320/.test(t) && !/Rank 7 of 22/.test(t), id);
        }
    });
    test('8: hub-active has the manage card and a help icon', async () => {
        const w = await sceneWorld(2, 'hub-active');
        assert.ok(w.q('#validate-manage-slot .validate-manage'), 'the manage card');
        assert.ok(w.q('.validate-status .help-inline-icon'), 'the help icon beside the headline');
    });
    test('21: keys-empty lists the six key names as neutral chips with a key icon', async () => {
        const w = await sceneWorld(2, 'keys-empty');
        const chips = w.qa('.validate-keys-names .ui-chip.is-neutral');
        assert.deepEqual(chips.map(c => c.textContent.trim()), EXPECTED_LAYOUT.map(l => l.name));
        assert.ok(chips.every(c => c.querySelector('.bx-key')));
        assert.match(w.q('.validate-keys-holds').textContent, /The line holds 6 public keys/);
    });
});

// ── 6, 7, 13, 18, 19, 20, 22: the stylesheet ──
describe('the stylesheet rulings', () => {
    const CSS = readRepo('styles.css', import.meta.url);
    const RULES = parseRules(CSS);
    const decl = (sel, p, media = '') => { const r = RULES.filter(x => x.selectors.includes(sel) && (media ? new RegExp(media).test(x.media) : !x.media)); return r.length ? r[r.length - 1].decls[p] : undefined; };
    test('6: the connected header button is on the kit (violet tint and line, violet hover border, green icon)', () => {
        assert.equal(decl('.connect-wallet-btn.is-connected', 'background'), 'var(--accent-violet-tint)');
        assert.equal(decl('.connect-wallet-btn.is-connected', 'border'), '1px solid var(--accent-violet-line)');
        assert.equal(decl('.connect-wallet-btn.is-connected:hover', 'border-color'), 'var(--accent-violet)');
        assert.equal(decl('.connect-wallet-btn.is-connected i', 'color'), 'var(--accent-green)');
    });
    test('7: the read-only banner is amber: line, wash over the surface, 3 px edge, amber glyph', () => {
        assert.equal(decl('.wallet-viewing-note.is-readonly', 'border'), '1px solid var(--accent-amber-line)');
        assert.equal(decl('.wallet-viewing-note.is-readonly', 'background'), 'linear-gradient(var(--accent-amber-wash), var(--accent-amber-wash)), var(--bg-surface)');
        assert.equal(decl('.wallet-viewing-note.is-readonly', 'box-shadow'), 'inset 3px 0 0 var(--accent-amber)');
        assert.equal(decl('.wallet-viewing-note.is-readonly .bx', 'color'), 'var(--accent-amber)');
    });
    test('13: the lookup field grows at 1280 and takes the full row at 640', () => {
        assert.equal(decl('.validate-lookup-row > .ia-wrap', 'flex'), '1 1 160px');
        assert.equal(decl('.validate-lookup-row > .ia-wrap > input', 'width'), '100%');
        assert.equal(decl('.validate-lookup-row > .ia-wrap', 'flex-basis', 'max-width:\\s*640px'), '100%');
    });
    test('18: the View button in "View any address" is a secondary, not a pink fill', () => {
        for (const p of ['background', 'color', 'border', 'border-radius', 'font-size', 'font-weight']) {
            assert.equal(decl('.wallet-picker-view-bar button', p), decl('.validate-secondary', p), p);
        }
    });
    test('19: hue guard over the whole file: no #f5a623, no rgba(245, 166, 35, a), no #7c3aed, no rgba(124, 58, 237, a)', () => {
        const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
        const hits = [];
        css.split('\n').forEach((l, i) => { if (/#f5a623|rgba\(\s*245\s*,\s*166\s*,\s*35\b|#7c3aed|rgba\(\s*124\s*,\s*58\s*,\s*237\b/i.test(l)) hits.push(`styles.css:${i + 1} ${l.trim()}`); });
        assert.deepEqual(hits, []);
        assert.equal(decl('.mobile-wallet-cta.secondary', 'background'), 'var(--accent-violet-tint)');
        assert.equal(decl('.mobile-wallet-cta.secondary', 'border'), '1px solid var(--accent-violet-line)');
        assert.equal(decl('.mobile-wallet-cta', 'background'), 'var(--brand-primary)');
    });
    test('19: the guard sees an off-kit amber (a broken copy is caught)', () => {
        assert.ok(/#f5a623|rgba\(\s*245\s*,\s*166\s*,\s*35\b/i.test('.x { color: #F5A623; background: rgba(245, 166, 35, 0.1); }'));
    });
    test('20: Donate folds to a 44 px icon at 600 and keeps an accessible name', () => {
        assert.equal(decl('.donate-btn', 'min-width', 'max-width:\\s*600px'), '44px');
        assert.equal(decl('.donate-btn', 'min-height', 'max-width:\\s*600px'), '44px');
        assert.match(readRepo('index.html', import.meta.url), /<a href="\/donate" id="donate-btn" class="donate-btn" title="Support the Polkadex Explorer" aria-label="Support the Polkadex Explorer">/);
    });
    test('22: .validate-alert reads the red line and wash tokens', () => {
        assert.equal(decl('.validate-alert', 'border'), '1px solid var(--accent-red-line)');
        assert.equal(decl('.validate-alert', 'background'), 'var(--accent-red-wash)');
    });
});

// ── 9: first-time hub ──
describe('9: first-time hub', () => {
    test('step 3 has no "See status" link, in the model or on any rendered hub', async () => {
        assert.equal(PATH_STEPS[2].link, null);
        for (const o of [{ account: NONE }, {}]) {
            const { el } = await hub(o, o.account ? {} : { state: STATES['not-bonded'] });
            assert.ok(!/See status/.test(el.textContent));
            assert.equal(el.querySelector('[data-validate-action="see-status"]'), null);
        }
    });
    test('the full path card for Manage has no action; Run a node and Set up keep theirs', () => {
        const { doc } = dom();
        doc.body.innerHTML = renderPath(pathState(null, { connected: false }), { esc: escapeHtml });
        const li = Array.from(doc.querySelectorAll('ol.validate-path > li'));
        assert.equal(li[2].querySelector('a'), null);
        assert.ok(li[0].querySelector('a[href="/validate/node"]') && li[1].querySelector('a[href="/validate/setup"]'));
    });
    test('fewer words before the primary than before the trust row moved (the trust line no longer sits above it)', async () => {
        const { el } = await hub({ account: NONE });
        const primary = el.querySelector('.validate-primary');
        let text = '';
        try { (function walk(n) { if (n === primary) throw 0; if (n.nodeType === 3) text += ' ' + n.textContent; if (n.nodeType === 1 && n.tagName === 'DETAILS' && !n.open) { const s = n.querySelector('summary'); if (s) walk(s); return; } for (const c of n.childNodes) walk(c); })(el); } catch (e) { if (e !== 0) throw e; }
        assert.ok(!text.includes('Never asks for a seed'), 'the trust line is not above the primary');
        assert.ok(words(text) <= 67, `words before the primary: ${words(text)} (88 with the trust row in the header)`);
    });
});

// ── 10: not-bonded is the chip and the headline ──
describe('10: not-bonded', () => {
    test('no session line, no progress block, and no alerts card', async () => {
        const { el, d } = await hub({}, { state: STATES['not-bonded'], alerts: true });
        assert.ok(el.querySelector('.validate-status .validate-pill'));
        assert.ok(el.querySelector('#validate-headline'));
        assert.equal(el.querySelector('.validate-progress'), null);
        assert.equal(el.querySelector('.validate-sub'), null);
        assert.ok(!d.urls.includes('/api/validator-alerts/status'), 'mountAlertsControl is not called');
    });
    test('an active stash still reads the alerts status and shows the progress block', async () => {
        const { el, d } = await hub({}, { alerts: true });
        assert.ok(el.querySelector('.validate-progress'));
        assert.ok(d.urls.includes('/api/validator-alerts/status'));
    });
});

// ── 11: bad address ──
describe('11: a bad address (400)', () => {
    test('the read-only banner leaves; the red line stays under the field', async () => {
        const { el } = await hub({ account: NONE, urlAddress: 'e-not-an-address' }, { status: httpErr(400) });
        const slot = el.querySelector('.validate-note-slot');
        assert.ok(!slot || slot.innerHTML === '', 'the note slot is empty');
        assert.equal(el.querySelector('.wallet-viewing-note'), null);
        assert.ok(el.querySelector('#validate-lookup-msg.is-error'));
    });
});

// ── 12: the node guide and the help topics point at the keys page ──
describe('12: the keys page links', () => {
    test('the node guide: "Paste the line into Check session keys." on /validate/keys, an SPA link', () => {
        const html = renderNodeGuide({ esc: escapeHtml });
        assert.match(html, /<p>Paste the line into <a href="\/validate\/keys" class="item-link" data-spa-link="true">Check session keys<\/a>\.<\/p>/);
        assert.ok(!/before you register them<\/a>/.test(html));
    });
    test('help topics: "on the Check session keys page", never "on the Validate page" for the checker', () => {
        const body = (slug) => HELP_TOPICS.find(t => t.slug === slug).body.replace(/<[^>]+>/g, '');
        assert.match(body('session-keys'), /on the Check session keys page/);
        assert.match(body('run-a-validator'), /on the Check session keys page/);
        assert.ok(!/Check session keys before you register them on the Validate page/.test(body('session-keys')));
    });
});

// ── 14, 15: duplicates and the invalid message ──
describe('14, 15: one Retry, one conflict sentence, an icon on an invalid line', () => {
    test('14: an unread exposure: Retry on the tile only, not in "All details"', async () => {
        const { el } = await hub({}, { state: { exposure: null } });
        assert.equal(el.querySelectorAll('.validate-tile [data-validate-action="retry"]').length, 1);
        assert.equal(el.querySelector('.validate-rows [data-validate-action="retry"]'), null);
    });
    async function keys(answer, value = BLOB) {
        const t = dom(); const d = deps({}, { status: answer });
        await mountKeysPage(t.el, d); await flush();
        t.el.querySelector('#validate-keys-input').value = value;
        t.el.querySelector('#validate-keys-form').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
        await flush();
        return t.el;
    }
    test('14: a key conflict: the alert carries the sentence, #validate-keys-msg stays empty', async () => {
        const summary = 'Key 2 (babe) is already registered to another account. The chain will reject these keys.';
        const el = await keys({ ok: true, conflict: true, bytes: 193, summary, rows: EXPECTED_LAYOUT.map((l, i) => ({ name: l.name, typeId: l.typeId, preview: 'x', result: i === 1 ? 'other' : 'free', owner: i === 1 ? OTHER : null })) });
        assert.match(el.querySelector('.validate-alert').textContent, /already registered/);
        assert.equal(el.querySelector('#validate-keys-msg').textContent.trim(), '');
    });
    test('15: an invalid line: an error message with the error icon', async () => {
        const el = await keys(null, '0x1234');
        const msg = el.querySelector('#validate-keys-msg');
        assert.ok(msg.classList.contains('is-error'));
        assert.ok(msg.querySelector('.bx-error-circle'));
        assert.ok(msg.textContent.trim().length > 0);
    });
});

// ── 16, 17: chip icons ──
describe('16, 17: chip icons', () => {
    test('16: Later is a horizontal dots icon, not a clock', () => {
        assert.equal(STEP_CHIPS.later.icon, 'bx-dots-horizontal-rounded');
    });
    test('17: /brand draws "Pink acts" with the brand tile and plain text, not a violet step chip', () => {
        const src = stripComments(readRepo('script.js', import.meta.url));
        assert.ok(!/\['Pink', 'acts[^\]]*'is-step'/.test(src), 'Pink is not an is-step chip');
        assert.match(src, /ui-tile is-brand[^`]*Pink/);
    });
});

// ── 21: the keys page names the six keys ──
describe('21: the keys page names the keys it expects', () => {
    test('"The line holds 6 public keys" and one neutral key chip per key', () => {
        const { doc } = dom();
        doc.body.innerHTML = renderKeysPage({ params: params(), esc: escapeHtml });
        assert.match(doc.querySelector('.validate-keys-holds').textContent, /^The line holds 6 public keys/);
        const chips = Array.from(doc.querySelectorAll('.validate-keys-names .ui-chip.is-neutral'));
        assert.deepEqual(chips.map(c => c.textContent.trim()), EXPECTED_LAYOUT.map(l => l.name));
        for (const c of chips) assert.ok(c.querySelector('i.bx.bx-key[aria-hidden="true"]'));
    });
});

// ── 22: the manage slot and one shared set of ui parts ──
describe('22: structure before WP3', () => {
    test('the manage panel mounts in its own slot in .validate-cards, not inside the dashboard card', async () => {
        const manage = { account: { status: 'connected', address: STASH }, esc: escapeHtml, getApi: () => null, apiWaitMs: 1, fetchJson: async () => params() };
        const { el } = await hub({ manage });
        const slot = el.querySelector('#validate-manage-slot');
        assert.ok(slot && slot.closest('.validate-cards'));
        assert.equal(el.querySelector('.validate-dash #validate-manage-slot'), null);
    });
    test('lib/ui-parts.js is the one place icon, chip, panel and the trust row are defined', () => {
        for (const f of ['lib/validator-path.js', 'lib/validator-status-view.js', 'lib/proxied-stashes.js', 'lib/validator-alerts-view.js']) {
            const src = stripComments(readRepo(f, import.meta.url));
            assert.match(src, /from '\.\/ui-parts\.js'/, f);
            assert.ok(!/const (icon|ic) = \(name\) =>/.test(src), `${f} defines its own icon helper`);
            assert.ok(!/function trustHtml/.test(src), `${f} defines its own trust row`);
        }
    });
    test('BRAND.md points to the roles section of the spec', () => {
        assert.match(readRepo('BRAND.md', import.meta.url), /2026-11-21-validate-redesign-and-colour-roles\.md[^\n]*section 2\.1/);
    });
});

// ── 23: small cuts ──
describe('23: small cuts', () => {
    test('the proxied card, limited: the info line without the "may be missing" caption', () => {
        const html = proxiedStashesHtml({ address: STASH, stashes: [], capped: false, partial: false, limited: true }, { esc: escapeHtml });
        assert.match(html, /may be incomplete/);
        assert.ok(!html.includes(PROXIED_ALWAYS_LINE));
    });
    test('a health item with no text after its word has no empty text paragraph', () => {
        const m = validatorStatusModel(snap(), params());
        const rows = m.rows.map(r => (r.id === 'keys' ? { ...r, text: r.word + '.' } : r));
        const { doc } = dom();
        doc.body.innerHTML = renderValidatorStatus({ ...m, rows }, { esc: escapeHtml });
        for (const p of doc.querySelectorAll('.validate-health-text')) assert.ok(p.textContent.trim().length > 0);
    });
});
