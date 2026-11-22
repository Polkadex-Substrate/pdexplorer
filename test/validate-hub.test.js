// Work package 2 of the validate redesign (spec cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// sections 3, 4, 7 and 8): the Validate hub, the path strip, the status dashboard with its figure tiles,
// the session keys tool on its own route (/validate/keys), the proxied accounts card and the alerts card.
//
// Numbers in the headings are the spec's test numbers for WP2 (7 to 14).
// Every account is 32 bytes of one repeated value at prefix 88 and belongs to no one; every key is synthetic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { validatorStatusModel, ctaFor, formatPdex, perbillToPercent } from '../lib/validator-status.js';
import { pathState, renderPath, PATH_STEPS } from '../lib/validator-path.js';
import { renderValidatorStatus, mountValidatePage, mountKeysPage, renderKeysPage, chipFor, VALIDATE_STATEMENT, KEYS_PAGE_TITLE, TRUST_LINE, OLD_KEYS_PARAGRAPH } from '../lib/validator-status-view.js';
import { proxiedStashesHtml, PROXIED_ALWAYS_LINE } from '../lib/proxied-stashes.js';
import { renderAlertsControl, mountAlertsControl } from '../lib/validator-alerts-view.js';
import { validateSitemapRoutes } from '../lib/validate-gate.js';
import { parseSessionKeys, EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments } from './helpers/source.js';
import { parseRules } from './helpers/css-rules.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(91), OTHER = addr(92), S1 = addr(93), S2 = addr(94), S3 = addr(95);
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
const params = (over = {}) => ({
    specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 },
    minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, maxValidatorsCount: 250,
    lowestElectedTotal: String(40_000n * PDEX), medianCommission: 100_000_000, ...over
});
const model = (s = {}, p = {}) => validatorStatusModel(snap(s), params(p));
const row = (m, id) => m.rows.find(r => r.id === id);
const tile = (m, id) => m.tiles.find(t => t.id === id);

// The snapshots behind each headline state.
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

function dom(url = 'http://localhost/validate') {
    const w = new Window({ url });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const flush = (n = 5) => new Promise(r => setTimeout(r, n));
function deps(over = {}, { state = {}, proxied = null, status = null } = {}) {
    const urls = [];
    return {
        urls,
        account: { status: 'connected', address: STASH }, urlAddress: '', isSame: (a, b) => a === b,
        fetchJson: async (u) => {
            urls.push(u);
            if (u === '/api/validator/params') return params();
            if (u.startsWith('/api/proxied-stashes/')) { if (proxied instanceof Error) throw proxied; return proxied || { address: STASH, stashes: [], capped: false, partial: false }; }
            if (u === '/api/validator-alerts/status') return { enabled: false };
            const m = /^\/api\/validator\/([^/]+)\/status$/.exec(u);
            if (m) { if (status instanceof Error) throw status; return status || { ...validatorStatusModel(snap({ address: decodeURIComponent(m[1]), ...state }), params()), address: decodeURIComponent(m[1]) }; }
            if (u.startsWith('/api/session-keys/check')) return { ok: true, conflict: false, bytes: 193, specVersion: 393, summary: '6 keys, 193 bytes, none registered to another account.', rows: EXPECTED_LAYOUT.map(l => ({ name: l.name, typeId: l.typeId, preview: '11111111...11111111', result: 'free', owner: null })) };
            throw new Error('unexpected ' + u);
        },
        helpIcon: () => '', esc: escapeHtml, shortAddr: short, navigate: () => {},
        ...over
    };
}
const primaries = (el) => Array.from(el.querySelectorAll('.validate-primary'));
const words = (s) => (String(s).match(/[A-Za-z0-9][\w'.,%-]*/g) || []).length;
// Visible text in document order, up to a node: closed details show their summary only, hidden nodes nothing.
function visibleText(root, stopAt = null) {
    let out = '', stop = false;
    (function walk(n) {
        if (stop) return;
        if (n === stopAt) { stop = true; return; }
        if (n.nodeType === 3) { out += ' ' + n.textContent; return; }
        if (n.nodeType !== 1 || n.hidden) return;
        if (n.tagName === 'DETAILS' && !n.open) { for (const c of n.childNodes) if (c.tagName === 'SUMMARY') walk(c); return; }
        for (const c of n.childNodes) walk(c);
    })(root);
    return out;
}

// ── 7: the path strip, every row of the table in 3.3 ──
describe('7: pathState, the table of section 3.3', () => {
    const view = (ps) => ps.steps.map(s => [s.marker, s.chip ? s.chip.word : null]);
    const cases = [
        ['no wallet', null, { connected: false }, [['current', 'Start here'], ['later', 'Later'], ['later', 'Later']], 3 - 3, { label: 'Connect wallet', at: 'connect' }],
        ['own, not-bonded', 'not-bonded', { connected: true, own: true }, [['open', null], ['current', 'Next'], ['later', 'Later']], 1, { label: 'Set up a validator', at: 'step2' }],
        ['own, bonded-no-keys', 'bonded-no-keys', { connected: true, own: true }, [['open', null], ['current', 'Next'], ['later', 'Later']], 1, { label: 'Continue setup', at: 'step2' }],
        ['own, keys-not-validating', 'keys-not-validating', { connected: true, own: true, hasKeys: true }, [['done', 'Done'], ['current', 'Next'], ['later', 'Later']], 1, { label: 'Continue setup', at: 'step2' }],
        ...['waiting', 'elected-next', 'active', 'active-leaving', 'disabled'].map(s => [`own, ${s}`, s, { connected: true, own: true, hasKeys: true }, [['done', 'Done'], ['done', 'Done'], ['current', 'You are here']], 2, null]),
        ['wallet restoring', null, { connected: false, restoring: true }, [['later', null], ['later', null], ['later', null]], -1, null]
    ];
    for (const [name, state, o, steps, cur, primary] of cases) {
        test(name, () => {
            const ps = pathState(state, o);
            assert.deepEqual(view(ps), steps);
            const current = ps.steps.map((s, i) => (s.current ? i : -1)).filter(i => i >= 0);
            assert.deepEqual(current, cur >= 0 ? [cur] : [], 'exactly one highlighted step (none while restoring)');
            if (primary) assert.deepEqual({ label: ps.primary.label, at: ps.primary.at }, primary);
            else assert.equal(ps.primary, null);
        });
    }
    test('the primary is ctaFor, unchanged: same label and target', () => {
        for (const s of ['not-bonded', 'bonded-no-keys', 'keys-not-validating']) {
            const p = pathState(s, { connected: true, own: true });
            const c = ctaFor(s, { connected: true, own: true });
            assert.deepEqual([p.primary.label, p.primary.href], [c.label, c.href]);
        }
        assert.equal(pathState(null, { connected: false }).primary.href, ctaFor('none', { connected: false }).href);
    });
    test('another account (connected, not own) has no path strip', () => {
        assert.equal(pathState('active', { connected: true, own: false }), null);
    });
    test('the three steps, their icons, names, sub lines and links', () => {
        // amended (fidelity review 9): step 3 has no link; its "See status" is deleted everywhere.
        assert.deepEqual(PATH_STEPS.map(s => [s.icon, s.name, s.sub, s.link ? s.link.label : null, s.link ? s.link.href : null]), [
            ['bx-server', 'Run a node', 'Server, client, start command and session keys.', 'Open the guide', '/validate/node'],
            ['bx-rocket', 'Set up', 'Bond, register your keys and set commission.', 'Open setup', '/validate/setup'],
            ['bx-slider-alt', 'Manage', 'Status, commission, key rotation and alerts.', null, null]
        ]);
    });
    test('chips: Done is positive with a check; Next, Start here and You are here are step chips; Later is neutral; each has an icon', () => {
        const all = [pathState(null, { connected: false }), pathState('not-bonded', { connected: true, own: true }), pathState('active', { connected: true, own: true })].flatMap(p => p.steps).filter(s => s.chip);
        for (const s of all) {
            const want = { Done: 'is-positive', Next: 'is-step', 'Start here': 'is-step', 'You are here': 'is-step', Later: 'is-neutral' }[s.chip.word];
            assert.equal(s.chip.cls, want, s.chip.word);
            assert.ok(/^bx-/.test(s.chip.icon), s.chip.word);
        }
        assert.equal(all.find(s => s.chip.word === 'Done').chip.icon, 'bx-check');
    });
    test('renderPath: an ol, aria-current on the highlighted step, done markers with a screen reader word, the primary in step 2', () => {
        const { doc } = dom();
        doc.body.innerHTML = renderPath(pathState('keys-not-validating', { connected: true, own: true }), { esc: escapeHtml });
        const ol = doc.querySelector('ol.validate-path');
        assert.ok(ol);
        const li = Array.from(ol.children);
        assert.equal(li.length, 3);
        assert.deepEqual(li.map(l => l.getAttribute('aria-current')), [null, 'step', null]);
        assert.ok(li[0].querySelector('.ui-step.is-done .bx-check'));
        assert.equal(li[0].querySelector('.ui-step .sr-only').textContent, 'done');
        assert.ok(li[1].querySelector('.ui-step.is-current'));
        const p = li[1].querySelector('.validate-primary');
        assert.ok(p && p.textContent.trim() === 'Continue setup' && p.getAttribute('href') === '/validate/setup');
        assert.equal(li[1].querySelector('.validate-path-link'), null, 'the primary replaces Open setup');
        assert.equal(li[0].querySelector('.validate-path-link').getAttribute('href'), '/validate/node');
        for (const i of doc.querySelectorAll('i.bx')) assert.equal(i.getAttribute('aria-hidden'), 'true');
    });
});

// ── 8: exactly one primary per hub state, the one of 3.3 ──
describe('8: one primary per rendered hub state', () => {
    const want = { 'not-bonded': 'Set up a validator', 'bonded-no-keys': 'Continue setup', 'keys-not-validating': 'Continue setup' };
    test('no wallet: one primary, Connect wallet, in the connect bar', async () => {
        const { el } = dom(); const d = deps({ account: { status: 'none', address: '' } });
        await mountValidatePage(el, d); await flush();
        const p = primaries(el);
        assert.equal(p.length, 1);
        assert.equal(p[0].textContent.trim(), 'Connect wallet');
        assert.ok(p[0].closest('.validate-connect'));
        assert.ok(el.querySelector('.validate-connect .ui-tile.is-violet .bx-user-check'));
    });
    for (const [state, snapOver] of Object.entries(STATES)) {
        test(`own stash, ${state}`, async () => {
            const { el } = dom(); const d = deps({}, { state: snapOver });
            await mountValidatePage(el, d); await flush(20);
            const p = primaries(el);
            if (want[state]) {
                assert.equal(p.length, 1, `${state}: one primary`);
                assert.equal(p[0].textContent.trim(), want[state]);
                assert.ok(p[0].closest('.validate-path-card[aria-current="step"]'), 'on the step 2 card');
            } else assert.equal(p.length, 0, `${state}: nothing urgent, no primary`);
        });
    }
    test('restoring: no primary, all steps later without chips', async () => {
        const { el } = dom(); await mountValidatePage(el, deps({ account: { status: 'restoring', address: '' } })); await flush();
        assert.equal(primaries(el).length, 0);
        assert.equal(el.querySelectorAll('.validate-path .ui-chip').length, 0);
        assert.equal(el.querySelectorAll('.validate-path .ui-step.is-later').length, 3);
    });
});

// ── 9: the tone table of section 4, every word ──
describe('9: tones, icons and words (section 4)', () => {
    const T = (word, tone, icon, id) => ({ word, tone, icon, id });
    test('headline chips: Active and Elected green; Waiting and Leaving amber; the three not-validating words neutral; Disabled red', () => {
        const want = {
            active: T('Active', 'positive', 'bx-check-circle'), 'elected-next': T('Elected', 'positive', 'bx-check-circle'),
            waiting: T('Waiting', 'wait', 'bx-time-five'), 'active-leaving': T('Leaving', 'wait', 'bx-log-out-circle'),
            'not-bonded': T('Not a validator', 'neutral', 'bx-minus-circle'), 'bonded-no-keys': T('No keys', 'neutral', 'bx-minus-circle'),
            'keys-not-validating': T('Not validating', 'neutral', 'bx-minus-circle'), disabled: T('Disabled', 'error', 'bx-error-circle')
        };
        for (const [state, o] of Object.entries(STATES)) {
            const m = model(o);
            assert.equal(m.state, state);
            assert.deepEqual({ word: m.pill.word, tone: m.pill.tone }, { word: want[state].word, tone: want[state].tone }, state);
            assert.equal(chipFor('headline', m.pill.word, m.pill.tone).icon, want[state].icon, state);
        }
    });
    const rows = [
        ['keys', {}, 'Match', 'positive', 'bx-check'],
        ['keys', { nextKeys: { ...KEYS, im_online: '0x' + rep('77', 32) }, queuedKeys: KEYS }, 'Pending', 'wait', 'bx-time-five'],
        ['keys', { inSession: false, activeImOnlineKey: null }, 'Queued', 'wait', 'bx-time-five'],
        ['keys', { inSession: false, inQueued: false, queuedKeys: null, activeImOnlineKey: null }, 'Registered', 'neutral', 'bx-key'],
        ['keys', { nextKeys: null, queuedKeys: null, inQueued: false, inSession: false }, 'None', 'wait', 'bx-error'],
        ['online', {}, 'Heartbeat received', 'positive', 'bx-pulse'],
        ['online', { heartbeat: false, blocks: 4 }, 'Online', 'positive', 'bx-pulse'],
        ['online', { heartbeat: false, blocks: 0, sessionProgress: 0.5 }, 'Not seen yet', 'wait', 'bx-time-five'],
        ['online', { heartbeat: false, blocks: 0, sessionProgress: 0.9 }, 'Offline', 'error', 'bx-error-circle'],
        ['online', { heartbeat: null, blocks: 0 }, 'Unknown', 'neutral', 'bx-help-circle'],
        ['online', { inSession: false }, 'Not active', 'neutral', 'bx-minus-circle'],
        ['offences', { lastSlashEra: 490 }, 'Slashed', 'error', 'bx-shield-x'],
        ['offences', { incidents: [{ kind: 'imOnline.SomeOffline' }] }, 'Reported offline', 'wait', 'bx-error'],
        ['offences', {}, 'None', 'neutral', 'bx-check'],
        ['stake', { ledger: { total: '1', active: '1' } }, 'Below minimum', 'wait', 'bx-error'],
        ['access', { controller: OTHER }, 'Legacy controller', 'wait', 'bx-error'],
        ['commission', { prefs: { commission: 50_000_000, blocked: true } }, 'Blocked', 'info', 'bx-info-circle']
    ];
    for (const [id, o, word, tone, icon] of rows) {
        test(`${id}: ${word} is ${tone} with ${icon}`, () => {
            const r = row(model(o), id);
            assert.deepEqual([r.word, r.tone], [word, tone]);
            assert.equal(chipFor(id, r.word, r.tone).icon, icon);
        });
    }
    test('the class of each tone, and colour is never the only signal: every chip in the rendered dashboard has an icon and a word', () => {
        assert.deepEqual(['positive', 'wait', 'info', 'error', 'neutral'].map(t => chipFor('x', 'W', t).cls), ['is-positive', 'is-wait', 'is-info', 'is-error', 'is-neutral']);
        for (const o of [{}, { disabled: true, lastSlashEra: 490 }, { heartbeat: false, blocks: 0, sessionProgress: 0.9 }, STATES.waiting]) {
            const { doc } = dom();
            doc.body.innerHTML = renderValidatorStatus(model(o), { esc: escapeHtml, shortAddr: short });
            for (const c of doc.querySelectorAll('.validate-pill, .validate-word, .ui-chip')) {
                assert.ok(c.querySelector('i.bx[aria-hidden="true"]'), 'icon in ' + c.outerHTML);
                assert.ok(c.textContent.trim().length > 0, 'word in ' + c.outerHTML);
            }
        }
    });
    test('green, amber and red never share an icon shape', () => {
        const shapes = { positive: new Set(), wait: new Set(), error: new Set() };
        for (const [, o, word, tone] of rows) if (shapes[tone]) shapes[tone].add(chipFor('x', word, tone).icon);
        for (const a of Object.keys(shapes)) for (const b of Object.keys(shapes)) if (a !== b) for (const i of shapes[a]) assert.ok(!shapes[b].has(i), `${i} in ${a} and ${b}`);
    });
});

// ── 10: m.tiles, a pure derivation of the same snapshot ──
describe('10: m.tiles', () => {
    test('four tiles in the spec order with their icons', () => {
        assert.deepEqual(model().tiles.map(t => [t.id, t.label, t.icon]), [
            ['self', 'Self stake', 'bx-lock-alt'], ['nominators', 'Nominators', 'bx-group'], ['commission', 'Commission', 'bx-purchase-tag'], ['points', 'Era points', 'bx-trophy']]);
    });
    test('elected: values and notes, each figure also in the row sentence from the same snapshot', () => {
        const m = model();
        const self = tile(m, 'self');
        assert.deepEqual([self.value, self.note, self.chip], ['500 PDEX', 'Total backing 90,000 PDEX', null]);
        assert.ok(row(m, 'stake').text.includes(`Self stake: ${self.value}.`));
        assert.ok(row(m, 'stake').text.includes('Total: 90,000 PDEX.'));
        const n = tile(m, 'nominators');
        assert.deepEqual([n.value, n.note, n.chip], ['300', '2 payout pages', null]);
        assert.ok(row(m, 'nominators').text.startsWith('300 nominators, 2 payout pages.'));
        const c = tile(m, 'commission');
        assert.deepEqual([c.value, c.note, c.chip], ['5%', 'Minimum 3%. Median 10%.', null]);
        assert.ok(row(m, 'commission').text.startsWith('5%.'));
        const p = tile(m, 'points');
        assert.deepEqual([p.value, p.note, p.chip], ['1,200', 'Rank 10 of 200. Last era 7,000.', null]);
        assert.ok(row(m, 'points').text.includes('1,200 (rank 10 of 200)'));
    });
    test('not elected: the minimum to validate, "Not elected this era", Below minimum as a wait chip, Blocked as an info chip', () => {
        const m = model({ ...STATES.waiting, ledger: { total: String(100n * PDEX), active: String(100n * PDEX) }, prefs: { commission: 70_000_000, blocked: true } });
        const self = tile(m, 'self');
        assert.deepEqual([self.value, self.note], ['100 PDEX', `Minimum to validate ${formatPdex(String(123n * PDEX))}`]);
        assert.deepEqual(self.chip, { word: 'Below minimum', tone: 'wait' });
        assert.equal(tile(m, 'nominators').note, 'Not elected this era');
        assert.deepEqual(tile(m, 'commission').chip, { word: 'Blocked', tone: 'info' });
        assert.equal(tile(m, 'commission').value, perbillToPercent(70_000_000));
    });
    test('exposure unread while active: the nominators tile is Unknown with a retry, never a number', () => {
        const n = tile(model({ exposure: null }), 'nominators');
        assert.deepEqual(n.chip, { word: 'Unknown', tone: 'neutral' });
        assert.equal(n.retry, true);
        assert.equal(n.value, '');
    });
    test('not-bonded: no tiles; the model is otherwise unchanged by tiles (same rows, same headline)', () => {
        assert.deepEqual(model(STATES['not-bonded']).tiles, []);
        const m = model();
        const { tiles, ...rest } = m;
        assert.ok(Array.isArray(tiles));
        assert.deepEqual(Object.keys(rest).sort(), ['address', 'era', 'headline', 'limits', 'pill', 'rows', 'session', 'state'].sort());
    });
    test('pure: the same snapshot twice gives the same tiles, and the snapshot is not changed', () => {
        const s = snap(); const before = JSON.stringify(s);
        assert.deepEqual(validatorStatusModel(s, params()).tiles, validatorStatusModel(s, params()).tiles);
        assert.equal(JSON.stringify(s), before);
    });
});

// ── 11: the dashboard; all nine sentences kept inside "All details" ──
describe('11: the dashboard', () => {
    const html = (o = {}) => { const { doc } = dom(); doc.body.innerHTML = renderValidatorStatus(model(o), { esc: escapeHtml, shortAddr: short, helpIcon: () => '<button class="help-icon"></button>' }); return doc; };
    test('all nine row sentences are in the DOM inside a closed details "All details"', () => {
        const doc = html(); const m = model();
        const det = doc.querySelector('details.validate-details');
        assert.ok(det && !det.open);
        assert.equal(det.querySelector('summary').textContent.trim(), 'All details');
        const dl = det.querySelector('dl.validate-rows');
        assert.equal(dl.querySelectorAll('.validate-row').length, 9);
        for (const r of m.rows) {
            const rest = r.word && r.text.startsWith(r.word + '.') ? r.text.slice(r.word.length + 1).trim() : r.text;
            assert.ok(dl.textContent.includes(rest), r.id);
        }
    });
    test('the head: chip, headline, help icon beside the chip, countdown, session progress bar with its label', () => {
        const doc = html();
        assert.ok(doc.querySelector('.validate-head .validate-pill.is-positive .bx-check-circle'));
        assert.equal(doc.querySelector('#validate-headline').textContent, 'Active in era 500.');
        assert.ok(doc.querySelector('.validate-head .help-icon'));
        assert.match(doc.querySelector('.validate-sub').textContent, /Session 3000, next in about/);
        const bar = doc.querySelector('[role="progressbar"]');
        assert.equal(bar.getAttribute('aria-valuenow'), '62');
        assert.equal(bar.getAttribute('aria-label'), 'Session progress');
        assert.match(doc.querySelector('.validate-progress').textContent, /Session progress\s*62%/);
    });
    test('the health row: keys, online, offences; a wait or error row elsewhere is hoisted as a fourth item', () => {
        assert.deepEqual(Array.from(html().querySelectorAll('.validate-health-item .validate-health-label')).map(n => n.textContent), ['Keys', 'Online this session', 'Offences']);
        assert.deepEqual(Array.from(html({ controller: OTHER }).querySelectorAll('.validate-health-item .validate-health-label')).map(n => n.textContent), ['Keys', 'Online this session', 'Offences', 'Access']);
    });
    test('four figure tiles, each with a violet icon tile, label, value and note', () => {
        const t = Array.from(html().querySelectorAll('.validate-tile'));
        assert.equal(t.length, 4);
        for (const x of t) { assert.ok(x.querySelector('.ui-tile.is-violet i.bx')); assert.ok(x.querySelector('.validate-tile-label')); assert.ok(x.querySelector('.validate-tile-value')); }
        assert.equal(t[0].querySelector('.validate-tile-value').textContent, '500 PDEX');
    });
    test('limited: one or more Unknown items show the info line above the health row; each unknown keeps its Retry', () => {
        const doc = html({ exposure: null });
        const line = doc.querySelector('.ui-panel.is-info.is-line');
        assert.ok(line);
        assert.equal(line.textContent.trim(), 'Some figures could not be read right now. Your validator is not affected.');
        assert.ok(line.compareDocumentPosition(doc.querySelector('.validate-health')) & 4, 'above the health row');
        assert.ok(doc.querySelector('.validate-tile [data-validate-action="retry"]'));
        assert.equal(html().querySelector('.ui-panel.is-info.is-line'), null);
    });
    test('not-bonded: the chip and headline, no health row and no tiles', () => {
        const doc = html(STATES['not-bonded']);
        assert.match(doc.querySelector('.validate-pill').textContent, /Not a validator/);
        assert.equal(doc.querySelector('.validate-health'), null);
        assert.equal(doc.querySelector('.validate-tile'), null);
    });
    test('loading: a chip-sized skeleton, "Reading the chain", three health and four tile skeletons, aria-busy', async () => {
        const { el } = dom();
        let release; const gate = new Promise(r => { release = r; });
        const d = deps(); const real = d.fetchJson;
        d.fetchJson = async (u) => { if (/\/status$/.test(u)) await gate; return real(u); };
        const p = mountValidatePage(el, d); await flush();
        const sec = el.querySelector('#validate-status-slot section');
        assert.equal(sec.getAttribute('aria-busy'), 'true');
        assert.match(sec.textContent, /Reading the chain/);
        assert.ok(sec.querySelector('.validate-skel-chip'));
        assert.equal(sec.querySelectorAll('.validate-skel-health').length, 3);
        assert.equal(sec.querySelectorAll('.validate-skel-tile').length, 4);
        release(); await p;
    });
    test('chain unreachable: an amber panel with the existing sentence and a secondary Retry (not red)', async () => {
        const { el } = dom(); const e = new Error('x'); e.status = 503;
        await mountValidatePage(el, deps({}, { status: e })); await flush();
        const panel = el.querySelector('#validate-status-slot .ui-panel.is-warn');
        assert.ok(panel);
        assert.match(panel.textContent, /The explorer cannot reach the chain right now\. Your validator is not affected\./);
        assert.ok(panel.querySelector('.validate-secondary[data-validate-action="retry"]'));
        assert.equal(el.querySelector('#validate-status-slot .ui-panel.is-error'), null);
    });
    test('not a Polkadex address (400): a red line under the lookup field, the field marked invalid, no dashboard', async () => {
        const { el } = dom(); const e = new Error('x'); e.status = 400;
        await mountValidatePage(el, deps({ urlAddress: 'nope' }, { status: e })); await flush();
        const msg = el.querySelector('#validate-lookup-msg');
        assert.ok(msg.classList.contains('is-error'));
        assert.ok(msg.querySelector('.bx-error-circle'));
        assert.match(msg.textContent, /That is not a Polkadex address\./);
        assert.equal(el.querySelector('#validate-lookup-input').getAttribute('aria-invalid'), 'true');
        assert.equal(el.querySelector('#validate-status-slot .validate-headline'), null);
    });
});

// ── the hub: header, copy old to new (3.4), path, tools, words ──
describe('the hub (section 3)', () => {
    test('header: gradient tile, title Validate, purpose line, lookup "Look up any stash", trust row with the statement verbatim in Details', async () => {
        const { el } = dom(); await mountValidatePage(el, deps({ account: { status: 'none', address: '' } })); await flush();
        const head = el.querySelector('.validate-header');
        assert.ok(head.classList.contains('ui-hairline'));
        assert.ok(head.querySelector('.ui-tile.is-brand .bx-server'));
        assert.equal(head.querySelector('h2').textContent.trim(), 'Validate');
        assert.equal(head.querySelector('.validate-purpose').textContent, 'Set up a Polkadex validator and keep it healthy.');
        assert.equal(head.querySelector('label[for="validate-lookup-input"]').textContent, 'Look up any stash');
        // amended (fidelity review 2): the trust row left the header; it is the hub's last element.
        assert.equal(head.querySelector('.ui-trust'), null);
        const trust = el.querySelector('.validate-hub > .ui-trust:last-child');
        assert.ok(trust.querySelector('.ui-tile.is-green.is-sm .bx-shield-quarter'));
        assert.ok(trust.textContent.includes(TRUST_LINE));
        assert.equal(TRUST_LINE, 'Never asks for a seed or private key. Cannot reach your server. You sign in your own wallet.');
        const det = trust.querySelector('details');
        assert.equal(det.querySelector('summary').textContent.trim(), 'Details');
        assert.ok(det.textContent.includes(VALIDATE_STATEMENT), '12: VALIDATE_STATEMENT verbatim on the hub');
    });
    test('copy: the old strings are gone from the hub, the new ones are there', async () => {
        const { el } = dom(); await mountValidatePage(el, deps({ account: { status: 'none', address: '' } })); await flush();
        const t = el.textContent;
        for (const old of ['Validator status', 'Any validator stash', 'Connect the wallet that holds your stash to see its validator status, or look up any stash.', 'What the statuses mean', 'Read the node guide', 'Check session keys before you register them', 'Session keys are generated on your own node']) assert.ok(!t.includes(old), old);
        assert.ok(t.includes('Already validating? Connect the stash wallet to see its status and manage it.'));
        assert.equal(el.querySelector('.validate-statement'), null, 'no pink-edged statement');
        assert.equal(el.querySelector('#validate-keys-form'), null, 'the checker left the hub');
    });
    test('lookup helper only with a wallet on its own view', async () => {
        const HELPER = 'A proxy for another stash? Look it up here if it is not listed below.';
        const a = dom(); await mountValidatePage(a.el, deps()); await flush();
        assert.ok(a.el.textContent.includes(HELPER));
        const b = dom(); await mountValidatePage(b.el, deps({ account: { status: 'none', address: '' } })); await flush();
        assert.ok(!b.el.textContent.includes(HELPER));
    });
    test('tools: a "Check session keys" card to /validate/keys for the visitor and the own stash; not on a looked-up stash', async () => {
        const a = dom(); await mountValidatePage(a.el, deps({ account: { status: 'none', address: '' } })); await flush();
        const card = a.el.querySelector('.validate-tools a.validate-tool[href="/validate/keys"]');
        assert.ok(card);
        assert.match(card.textContent, /Check session keys/);
        assert.match(card.textContent, /Paste the line your node printed\. No wallet needed\./);
        assert.ok(card.querySelector('.ui-tile.is-violet .bx-key'));
        const b = dom(); await mountValidatePage(b.el, deps({ urlAddress: OTHER })); await flush();
        assert.equal(b.el.querySelector('a[href="/validate/keys"]'), null);
    });
    test('13: /validate/<address> renders no path strip; the own view and the visitor do', async () => {
        const a = dom(); await mountValidatePage(a.el, deps({ urlAddress: OTHER })); await flush();
        assert.equal(a.el.querySelector('.validate-path'), null);
        assert.ok(a.el.querySelector('.wallet-viewing-note'));
        const b = dom(); await mountValidatePage(b.el, deps()); await flush();
        assert.ok(b.el.querySelector('.validate-path'));
    });
    // amended (fidelity review 9): "See status" is deleted, so its focus test went with it (test/validate-fidelity.test.js).
    test('words: the first-time hub shows fewer words than before (old: 116 visible words with the keys card on the page)', async () => {
        const { el } = dom(); await mountValidatePage(el, deps({ account: { status: 'none', address: '' } })); await flush();
        const total = words(visibleText(el));
        const before = words(visibleText(el, primaries(el)[0]));
        assert.ok(total <= 116, `visible words ${total}`);
        assert.ok(before < total, `words before the primary ${before}`);
    });
});

// ── 12 and 13: the keys tool on its own route ──
describe('the keys page (/validate/keys)', () => {
    const kdeps = (over = {}) => deps({ getAccount: () => ({ status: 'none', address: '' }), ...over });
    test('the page: back link, violet key tile, title, line, field, one primary, the amber caution, the disclosure with the old paragraph verbatim, the trust row', async () => {
        const { el } = dom('http://localhost/validate/keys'); await mountKeysPage(el, kdeps()); await flush();
        const back = el.querySelector('a.validate-back[href="/validate"]');
        assert.ok(back && back.querySelector('.bx-chevron-left') && back.textContent.trim() === 'Validate');
        assert.ok(el.querySelector('.validate-keys .ui-tile.is-violet .bx-key'));
        assert.equal(el.querySelector('.validate-keys h2').textContent.trim(), 'Check session keys');
        assert.ok(el.textContent.includes('Paste the one line your node printed. It holds public keys only.'));
        assert.equal(el.querySelector('label[for="validate-keys-input"]').textContent, 'Session keys (0x, 388 characters)');
        const p = primaries(el);
        assert.equal(p.length, 1);
        assert.equal(p[0].textContent.trim(), 'Check keys');
        assert.equal(p[0].getAttribute('type'), 'submit');
        const warn = el.querySelector('.ui-panel.is-warn.is-line');
        assert.equal(warn.textContent.trim(), 'Run author_rotateKeys only against 127.0.0.1 on your own server, never through a public RPC.');
        assert.ok(warn.compareDocumentPosition(el.querySelector('#validate-keys-input')) & 2, 'under the field');
        const det = Array.from(el.querySelectorAll('details')).find(d => /Where does this line come from\?/.test(d.querySelector('summary').textContent));
        assert.ok(det, 'the disclosure');
        assert.ok(det.textContent.replace(/\s+/g, ' ').includes(OLD_KEYS_PARAGRAPH), '12: the old paragraph verbatim');
        assert.equal(OLD_KEYS_PARAGRAPH, 'Session keys are generated on your own node: run author_rotateKeys against 127.0.0.1 on your server and paste the line it prints. Never run it through a public RPC.');
        assert.ok(det.querySelector('a[href^="/validate/node"]').textContent === 'Session keys in the node guide');
        assert.ok(el.querySelector('.ui-trust'));
        assert.equal(KEYS_PAGE_TITLE, 'Check session keys | Polkadex Mainnet Explorer');
    });
    test('the same results as before for the same inputs: the browser parser is the shared one, unchanged', async () => {
        const inputs = ['', 'bottom drive obey lake curtain smoke basket hold race lonely fit walk', '0x1234', BLOB, BLOB + '00', 'not hex at all'];
        for (const v of inputs) {
            const { el, w } = dom('http://localhost/validate/keys'); const d = kdeps(); await mountKeysPage(el, d); await flush();
            el.querySelector('#validate-keys-input').value = v;
            el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
            await flush(20);
            const want = parseSessionKeys(v, { layout: EXPECTED_LAYOUT, specVersion: 393 });
            const sent = d.urls.some(u => u.startsWith('/api/session-keys/check'));
            assert.equal(sent, want.ok, JSON.stringify(v));
            if (!want.ok) { assert.equal(el.querySelector('#validate-keys-msg').textContent.trim(), want.message); assert.equal(el.querySelector('#validate-keys-input').getAttribute('aria-invalid'), 'true'); }
        }
    });
    test('a valid line: the summary with a green check, result chips, the unchanged node note inside an info panel; for= the connected wallet', async () => {
        const { el, w } = dom('http://localhost/validate/keys');
        const d = kdeps({ getAccount: () => ({ status: 'connected', address: STASH }) }); await mountKeysPage(el, d); await flush();
        el.querySelector('#validate-keys-input').value = BLOB;
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush(20);
        assert.equal(d.urls.find(u => u.startsWith('/api/session-keys/check')), `/api/session-keys/check?keys=${BLOB}&for=${encodeURIComponent(STASH)}`);
        assert.ok(el.querySelector('#validate-keys-msg .bx-check-circle'));
        assert.match(el.querySelector('#validate-keys-msg').textContent, /6 keys, 193 bytes, none registered to another account\./);
        const chips = Array.from(el.querySelectorAll('.validate-keys-table .validate-word'));
        assert.equal(chips.length, 6);
        assert.ok(chips.every(c => c.classList.contains('is-positive') && /Not registered/.test(c.textContent)));
        const info = el.querySelector('#validate-keys-result .ui-panel.is-info');
        assert.match(info.textContent, /The explorer cannot check that your node holds these keys\. On the server, author_hasSessionKeys with the same line answers that\./);
    });
    test('a conflict: the red alert with its icon and role="alert", "Another account" an error chip, "This stash" positive', async () => {
        const { el, w } = dom('http://localhost/validate/keys');
        const d = kdeps(); const real = d.fetchJson;
        d.fetchJson = async (u) => {
            if (!u.startsWith('/api/session-keys/check')) return real(u);
            const rows = EXPECTED_LAYOUT.map((l, i) => ({ name: l.name, typeId: l.typeId, preview: 'x', result: i === 0 ? 'other' : i === 1 ? 'own' : 'free', owner: i === 0 ? OTHER : null }));
            return { ok: true, conflict: true, rows, bytes: 193, summary: `Key 1 (grandpa) is already registered to ${OTHER}.` };
        };
        await mountKeysPage(el, d); await flush();
        el.querySelector('#validate-keys-input').value = BLOB;
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush(20);
        const alert = el.querySelector('.validate-alert[role="alert"]');
        assert.ok(alert && alert.querySelector('.bx-error-circle') && alert.textContent.includes(OTHER));
        const chips = Array.from(el.querySelectorAll('.validate-keys-table .validate-word'));
        assert.ok(chips[0].classList.contains('is-error') && /Another account/.test(chips[0].textContent));
        assert.ok(chips[1].classList.contains('is-positive') && /This stash/.test(chips[1].textContent));
        assert.equal(el.querySelector('#validate-keys-msg .bx-check-circle'), null, 'no green check on a conflict');
    });
    test('layout mismatch: the existing text in an amber panel, no form', () => {
        const html = renderKeysPage({ params: params({ specVersion: 394, layout: { ok: false } }), esc: escapeHtml });
        const { doc } = dom(); doc.body.innerHTML = html;
        assert.match(doc.querySelector('.ui-panel.is-warn').textContent, /session key format is different from what this checker knows/);
        assert.equal(doc.querySelector('textarea'), null);
    });
    test('13: script.js mounts the keys page on /validate/keys with its own title; the sitemap lists it with the public guide', () => {
        const script = stripComments(readRepo('script.js', import.meta.url));
        assert.match(script, /if \(address === 'keys'\) \{ updateSeoMeta\('validate', \{ title: KEYS_PAGE_TITLE, canonicalPath: '\/validate\/keys' \}\); return mountKeysPage\(document\.getElementById\('validate-root'\), \{/);
        assert.match(script, /import \{ mountValidatePage, mountKeysPage, KEYS_PAGE_TITLE \} from '\.\/lib\/validator-status-view\.js'/);
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
        assert.ok(validateSitemapRoutes(true, []).some(r => r.path === '/validate/keys'));
        assert.deepEqual(validateSitemapRoutes(false, []), []);
    });
});

// ── 14: the proxied accounts card ──
describe('14: Accounts you are a proxy for', () => {
    const one = [{ stash: S1, proxies: [{ type: 'Staking', delay: 0 }], validating: true }];
    const html = (r) => { const { doc } = dom(); doc.body.innerHTML = proxiedStashesHtml(r, { esc: escapeHtml, shortAddr: short }); return doc; };
    test('empty and complete: nothing is rendered', () => {
        assert.equal(proxiedStashesHtml({ stashes: [], capped: false, partial: false }, { esc: escapeHtml }), '');
    });
    test('limited alone: the info line, no retry', () => {
        const doc = html({ stashes: [], partial: false, limited: true, reason: 'SIGNER_INDEX_MISSING' });
        const line = doc.querySelector('.ui-panel.is-info.is-line');
        assert.equal(line.textContent.trim(), 'The proxy index is not available right now, so this list may be incomplete.');
        assert.equal(doc.querySelector('[data-proxied-retry]'), null);
        assert.equal(doc.querySelector('[data-proxied-partial]'), null);
    });
    test('partial: the existing sentence as an amber line with Try again (with or without limited)', () => {
        for (const r of [{ stashes: [], partial: true }, { stashes: one, partial: true, limited: true }]) {
            const doc = html(r);
            const line = doc.querySelector('.ui-panel.is-warn.is-line[data-proxied-partial="true"]');
            assert.ok(line && /Could not check every account\./.test(line.textContent));
            assert.ok(line.querySelector('button[data-proxied-retry="true"]'));
        }
    });
    test('a list: a card with a violet group tile and a count chip; one 44 px row per stash with chips and a link', () => {
        const doc = html({ stashes: [...one, { stash: S2, proxies: [{ type: 'Governance', delay: 0 }], validating: false }, { stash: S3, proxies: [{ type: 'Any', delay: 0 }], validating: null }], capped: false, partial: false });
        const card = doc.querySelector('section.list-container.glass.validate-proxied');
        assert.ok(card.querySelector('.ui-tile.is-violet .bx-group'));
        assert.equal(card.querySelector('h3').textContent.trim(), 'Accounts you are a proxy for');
        assert.match(card.querySelector('.list-header .ui-chip.is-step').textContent, /3/);
        const rows = Array.from(card.querySelectorAll('.validate-proxied-list > li'));
        assert.equal(rows.length, 3);
        assert.ok(rows[0].querySelector('.ui-chip.is-step') && /Staking proxy/.test(rows[0].textContent));
        assert.ok(rows[0].querySelector('.ui-chip.is-positive') && /Validating/.test(rows[0].textContent));
        assert.ok(rows[1].querySelector('.ui-chip.is-neutral') && /Not validating/.test(rows[1].textContent));
        assert.equal(rows[2].querySelectorAll('.ui-chip').length, 1, 'unknown state: no state chip');
        assert.equal(rows[0].querySelector('a').getAttribute('href'), '/validate/' + S1);
        assert.ok(rows[0].querySelector('a + .bx-chevron-right'), 'the chevron beside the link');
        assert.ok(!card.textContent.includes('This account is a proxy for the accounts below.'), 'the intro line is deleted');
        assert.equal(card.querySelector('.validate-caption-line').textContent, PROXIED_ALWAYS_LINE);
        assert.equal(PROXIED_ALWAYS_LINE, 'From indexed proxy events, so an older proxy may be missing.');
    });
});

// ── alerts card ──
describe('Get alerts for this validator', () => {
    test('blue bell tile, the one visible line, the field and a secondary button, both paragraphs verbatim in "What is sent and stored"', () => {
        const { doc } = dom(); doc.body.innerHTML = renderAlertsControl({ esc: escapeHtml, stash: S1, maxPerEmail: 5 });
        const card = doc.querySelector('.validate-alerts');
        assert.ok(card.querySelector('.ui-tile.is-blue .bx-bell'));
        assert.ok(card.textContent.includes('One email each time this validator is not elected, goes offline, is disabled or slashed, or changes commission or keys.'));
        assert.ok(card.querySelector('button.validate-secondary[type="submit"]'));
        assert.equal(card.querySelector('.validate-primary'), null);
        const det = card.querySelector('details');
        assert.equal(det.querySelector('summary').textContent.trim(), 'What is sent and stored');
        assert.ok(det.textContent.includes('Get an email when this validator is not elected for a new era, has sent no heartbeat and authored no block by 85% of a session, is disabled or slashed, or changes its commission or its session keys. You get one email for each occurrence and nothing else.'));
        assert.ok(det.textContent.includes('We send a confirmation email first and nothing about the validator until you confirm.'));
    });
    test('result: a green check when the server accepted, a red mark on an invalid address', async () => {
        const { el, w } = dom();
        await mountAlertsControl(el, { stash: S1, esc: escapeHtml, fetchJson: async () => ({ enabled: true, maxPerEmail: 5 }), postJson: async () => ({ message: 'If this address can receive alerts, a confirmation email is on its way.' }) });
        el.querySelector('input[type="email"]').value = 'nope';
        el.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        assert.ok(el.querySelector('#validate-alerts-msg.is-error .bx-error-circle'));
        el.querySelector('input[type="email"]').value = 'a@example.com';
        el.querySelector('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        assert.ok(el.querySelector('#validate-alerts-msg.is-ok .bx-check'));
        assert.match(el.querySelector('#validate-alerts-msg').textContent, /confirmation email is on its way\. The link works for 24 hours/);
    });
});

// ── the styles: roles on the hub (spec 2.1, 3, 4; R1 to R5) ──
describe('styles for the hub and the dashboard', () => {
    const CSS = readRepo('styles.css', import.meta.url);
    const RULES = parseRules(CSS);
    const has = (sel) => RULES.some(r => r.selectors.includes(sel));
    test('the new parts exist', () => {
        for (const s of ['.validate-hub', '.validate-header', '.validate-path', '.validate-path-card', '.validate-connect', '.validate-health', '.validate-tiles', '.validate-tile', '.validate-details', '.validate-progress', '.validate-tools', '.validate-tool', '.validate-cards', '.validate-back']) assert.ok(has(s), s);
    });
    test('the chip classes take the ui-chip roles: tokens only, green only on positive, amber only on wait', () => {
        const val = (sel, p) => (RULES.find(r => r.selectors.includes(sel)) || { decls: {} }).decls[p];
        assert.equal(val('.validate-pill.is-positive', 'color'), 'var(--accent-green)');
        assert.equal(val('.validate-word.is-wait', 'color'), 'var(--accent-amber)');
        assert.equal(val('.validate-word.is-info', 'color'), 'var(--accent-blue-text)');
        assert.equal(val('.validate-word.is-error', 'color'), 'var(--accent-red)');
    });
    test('the path connector: green on a done segment, neutral otherwise; path cards and tiles keep a neutral fill', () => {
        const done = RULES.filter(r => r.selectors.some(s => /validate-path-card\.is-done/.test(s)) && Object.values(r.decls).some(v => /--accent-green/.test(v)));
        assert.ok(done.length >= 1);
        for (const s of ['.validate-path-card', '.validate-tile']) assert.equal((RULES.find(r => r.selectors.includes(s)) || { decls: {} }).decls.background, 'rgba(255, 255, 255, 0.03)');
    });
    test('375: one column for the path, two for the tiles, the lookup button full width, a 16 px side gutter, every path link and tool 44 px or more', () => {
        const m = RULES.filter(r => /max-width:\s*640px/.test(r.media));
        const at = (sel, p) => (m.find(r => r.selectors.includes(sel)) || { decls: {} }).decls[p];
        assert.equal(at('.validate-path', 'grid-template-columns'), '1fr');
        assert.equal(at('.validate-tiles', 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
        assert.equal(at('.validate-page', 'padding-left'), '16px');
        assert.equal(at('.validate-page', 'padding-right'), '16px');
        assert.equal(at('.validate-lookup .validate-secondary', 'width'), '100%');
        const min = (sel) => parseInt((RULES.find(r => r.selectors.includes(sel) && !r.media) || { decls: {} }).decls['min-height'] || '0', 10);
        for (const s of ['.validate-path-card', '.validate-tool', '.validate-proxied-list > li']) assert.ok(min(s) >= 44, s);
    });
});

// ── 375 px: no horizontal overflow from the shell (the WP1 preview finding) ──
// At 375 the topbar's fixed content (menu, logo, status dot, Donate, Connect Wallet, all nowrap) is wider
// than the viewport. .main-content is a flex item, so without min-width: 0 it grows to that min-content
// width and every card under it runs past the right edge (body clips it with overflow-x: hidden).
describe('375 px: the wallet and validate cards cannot be pushed past the right edge', () => {
    const RULES = parseRules(readRepo('styles.css', import.meta.url));
    const decl = (sel, p, media = '') => { const r = RULES.filter(x => x.selectors.includes(sel) && (media ? new RegExp(media).test(x.media) : !x.media)); return r.length ? r[r.length - 1].decls[p] : undefined; };
    test('.main-content may shrink below its content (min-width: 0), so a wide child cannot widen the page', () => {
        assert.equal(decl('.main-content', 'min-width'), '0');
    });
    test('at 640 and below the wallet and validate pages keep a 16 px side gutter', () => {
        for (const s of ['.wallet-page', '.validate-page']) {
            assert.equal(decl(s, 'padding-left', 'max-width:\\s*640px'), '16px', s);
            assert.equal(decl(s, 'padding-right', 'max-width:\\s*640px'), '16px', s);
        }
    });
    test('at 600 and below the topbar fits 375: the Donate label folds to its icon (the link keeps its title)', () => {
        assert.equal(decl('.donate-btn span', 'display', 'max-width:\\s*600px'), 'none');
        assert.match(readRepo('index.html', import.meta.url), /<a href="\/donate" id="donate-btn" class="donate-btn" title="Support the Polkadex Explorer"/);
    });
    test('no wallet-* or validate-* rule sets a fixed width or min-width above 343 px (375 less the gutters) outside a wide media query', () => {
        for (const r of RULES) {
            if (!r.selectors.some(s => /\.(wallet|validate)-/.test(s)) || /min-width/.test(r.media)) continue;
            for (const p of ['width', 'min-width', 'flex-basis']) {
                const m = /^(\d+)px$/.exec(r.decls[p] || '');
                if (m) assert.ok(Number(m[1]) <= 343, `styles.css:${r.line} ${r.selectors.join(', ')} { ${p}: ${r.decls[p]} }`);
            }
        }
    });
});

// ── the real page: route, deep link, back and forward, title, nav ──
const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify({ probe: ['#validate-keys-form', '.validate-path', '#nav-validate.active'], ...scenario })], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}
describe('13: /validate/keys in the real page', () => {
    const API = { '/api/validator/params': params() };
    test('flag off: the not-found page', async () => {
        const r = await page({ path: 'validate/keys', api: API });
        assert.equal(r.page, 'not-found');
        assert.equal(r.probe['#validate-keys-form'].count, 0);
    });
    test('deep link: the keys page, its title, the nav entry active; the hub tool card goes there and Back returns to the hub', async () => {
        const r = await page({ path: 'validate/keys', seed: { pdex_validate_enabled: '1' }, api: API, steps: [{ click: 'a.validate-back' }, { click: 'a.validate-tool[href="/validate/keys"]' }, { back: true }, { go: '/validate/keys' }] });
        assert.equal(r.page, 'validate');
        assert.equal(r.steps[0].path, '/validate');
        assert.equal(r.steps[1].path, '/validate/keys');
        assert.equal(r.steps[1].dashboard.title, KEYS_PAGE_TITLE);
        assert.equal(r.steps[2].path, '/validate');
        assert.equal(r.final.path, '/validate/keys');
        assert.equal(r.probe['#validate-keys-form'].count, 1);
        assert.equal(r.probe['#nav-validate.active'].count, 1);
        assert.deepEqual(r.errors, []);
    });
});
