// The designer's review of Work Package 3 and the quick wins (must-fixes M1 to M3, should-fixes S1 to S12).
// Visual and wiring only: test/wp3-freeze.test.js still holds the words, fields and actions of the money paths.
//
// Every state is the real mount on a fake chain (test/helpers/wp3-world.js). Synthetic accounts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { buildState, closeWorld } from './helpers/wp3-world.js';
import { parseRules } from './helpers/css-rules.js';
import { pathState, renderPath } from '../lib/validator-path.js';
import { setChip, resultWord } from '../lib/ui-parts.js';
import { renderBalanceLocks } from '../lib/balance-locks-view.js';
import { describeAccountLocks } from '../lib/balance-locks.js';
import { mountNodeGuide } from '../lib/validator-node-guide.js';
import { MULTISIG_CHANGE_WARNING } from '../lib/validator-delegate.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments } from './helpers/source.js';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const RULES = parseRules(CSS);
const INDEX = readRepo('index.html', import.meta.url);
const SCRIPT = readRepo('script.js', import.meta.url);

const SHARED = new Window({ url: 'http://localhost/validate' });
const cache = new Map();
async function state(id) {
    if (!cache.has(id)) {
        const w = await buildState(id);
        if (w.release) w.release();
        const el = SHARED.document.createElement('div');
        el.innerHTML = w.el.innerHTML;
        await closeWorld(w);
        cache.set(id, el);
    }
    return cache.get(id);
}
const qa = (el, sel) => Array.from(el.querySelectorAll(sel));
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const rule = (sel, media = null) => RULES.find(r => r.selectors.includes(sel) && (media === null ? !r.media : new RegExp(media).test(r.media)));

describe('M1: the path never links a page to itself', () => {
    test('renderPath with here: that step is a current item with no link, exact markup', () => {
        const doc = new Window().document;
        doc.body.innerHTML = renderPath(pathState('not-bonded', { connected: true }), { esc: escapeHtml, compact: true, here: 'setup' });
        const li = qa(doc, 'ol.validate-path > li');
        assert.equal(li[1].outerHTML, '<li class="validate-path-card is-current" aria-current="step"><span class="ui-step is-current">2</span><span class="validate-path-name">Set up</span></li>');
        assert.equal(li[1].querySelector('a'), null);
        assert.ok(li[0].querySelector('a[href="/validate/node"]'), 'the other link stays');
    });
    test('without here (the hub) the compact path is unchanged: Set up is a link', () => {
        const doc = new Window().document;
        doc.body.innerHTML = renderPath(pathState('active', { connected: true, own: true }), { esc: escapeHtml, compact: true });
        assert.deepEqual(qa(doc, 'a.validate-path-link').map(a => a.getAttribute('href')), ['/validate/node', '/validate/setup']);
        assert.equal(qa(doc, 'a[target]').length, 0);
    });
    test('the wizard: Set up is not a link, Run a node opens in a new tab', async () => {
        const el = await state('wiz-step1');
        const path = el.querySelector('.validate-path.is-compact');
        const cur = path.querySelector('[aria-current="step"]');
        assert.match(txt(cur), /Set up/);
        assert.equal(cur.querySelector('a'), null);
        assert.equal(path.querySelector('a[href="/validate/setup"]'), null, 'no link to the page itself');
        const run = path.querySelector('a[href="/validate/node"]');
        assert.equal(run.getAttribute('target'), '_blank');
        assert.equal(run.getAttribute('rel'), 'noopener');
    });
    test('the node guide: Run a node is current and not a link; Set up still links', async () => {
        const el = await state('guide-pending');
        const path = el.querySelector('.validate-path.is-compact');
        const cur = path.querySelector('[aria-current="step"]');
        assert.match(txt(cur), /Run a node/);
        assert.equal(cur.querySelector('a'), null);
        assert.equal(path.querySelector('a[href="/validate/node"]'), null);
        assert.ok(path.querySelector('a[href="/validate/setup"]'));
        assert.equal(path.querySelector('a[target]'), null, 'only the wizard opens a new tab');
    });
});

describe('M2: the alert icon has a gap', () => {
    test('.validate-alert .bx has margin-right 8px', () => {
        assert.equal(rule('.validate-alert .bx').decls['margin-right'], '8px');
    });
});

describe('M3: the manage panel is scrolled to from the link', () => {
    test('lib/validator-status-view.js scrolls the title into view after the mount (behaviour: test/validator-manage-view.test.js)', () => {
        const code = stripComments(readRepo('lib/validator-status-view.js', import.meta.url));
        assert.match(code, /scrollIntoView\(/);
        assert.match(code, /#validate-manage-title/);
    });
});

describe('S1 to S3, S6, S8: styles', () => {
    test('S1: consecutive paragraphs in a panel body are 8px apart', () => {
        assert.equal(rule('.ui-panel-body > p + p').decls['margin-top'], '8px');
    });
    test('S3: review markers are outlined violet, not the solid current look', () => {
        const r = rule('.validate-review > li::before');
        assert.equal(r.decls.background, 'transparent');
        assert.equal(r.decls.border, '1px solid var(--accent-violet-line)');
        assert.equal(r.decls.color, 'var(--accent-violet-text)');
    });
    test('S6: a passed step that is not on chain is a violet segment of the phone bar', () => {
        assert.equal(rule('.validate-setup-bar > .is-open').decls.background, 'var(--accent-violet-line)');
    });
    test('S8: the compact path is hidden under 768px in the wizard', () => {
        const r = RULES.find(x => /768px/.test(x.media) && x.selectors.includes('.validate-setup > .validate-path.is-compact') && x.decls.display === 'none');
        assert.ok(r, 'a display none rule in the 768 query');
        assert.ok(!r.selectors.includes('.validate-guide > .validate-path.is-compact'), 'the guide keeps its path');
    });
});

describe('S2: the lists keep their semantics', () => {
    test('the review list and the stepper list carry role="list"', async () => {
        assert.equal((await state('wiz-review')).querySelector('ol.validate-review').getAttribute('role'), 'list');
        assert.equal((await state('steps-S0')).querySelector('ol.validate-stepwise').getAttribute('role'), 'list');
        assert.equal((await state('man-commission-review')).querySelector('ol.validate-review').getAttribute('role'), 'list');
    });
});

describe('S4: the multisig warning is a line where another amber panel shares the view', () => {
    test('wizard review and manage review', async () => {
        for (const id of ['wiz-review-multisig', 'man-ms-review']) {
            const el = await state(id);
            const w = qa(el, '.ui-panel.is-warn').filter(p => txt(p).includes(MULTISIG_CHANGE_WARNING));
            assert.equal(w.length, 1, id);
            assert.ok(w[0].classList.contains('is-line'), `${id}: .is-warn.is-line`);
        }
        const wiz = await state('wiz-review-multisig');
        assert.ok(wiz.querySelector('.validate-warnings.is-warn:not(.is-line)'), 'the Before you sign panel stays a panel');
    });
});

describe('S5: S10 keeps the green panel and the timing is a blue line', () => {
    test('the timing sits outside the done panel, directly after it', async () => {
        const el = await state('steps-S10');
        const done = el.querySelector('.validate-stepwise-done');
        assert.ok(done && done.classList.contains('is-ok'));
        const line = done.nextElementSibling;
        assert.ok(line.classList.contains('is-info') && line.classList.contains('is-line'), 'a blue line follows the panel');
        assert.ok(txt(line).length > 20);
        assert.ok(!txt(done).includes(txt(line)), 'the timing is not inside the panel');
    });
});

describe('S7: a finished setup shows every step done', () => {
    for (const id of ['wiz-result-applied', 'steps-S10']) {
        test(id, async () => {
            const el = await state(id);
            const marks = qa(el, 'ol.validate-steps > li > .ui-step');
            assert.equal(marks.length, 5);
            assert.ok(marks.every(m => m.classList.contains('is-done')), 'every step marker is done');
            const bar = qa(el, '.validate-setup-bar > span');
            assert.equal(bar.length, 5);
            assert.ok(bar.every(s => s.classList.contains('is-done')), 'the phone bar is all green');
            const path = qa(el, '.validate-path.is-compact > li');
            assert.ok(path[1].querySelector('.ui-step').classList.contains('is-done'), 'path step 2 done');
            assert.equal(path[1].querySelector('a'), null);
            assert.equal(path[2].getAttribute('aria-current'), 'step');
            assert.ok(path[2].querySelector('.ui-step').classList.contains('is-current'), 'path step 3 current');
        });
    }
    test('S6: before the end, a passed step that is not on chain is open in the bar', async () => {
        const el = await state('wiz-review');
        assert.deepEqual(qa(el, '.validate-setup-bar > span').map(s => s.className), ['is-open', 'is-open', 'is-open', 'is-open', 'is-current']);
    });
});

describe('S9: the unlock text matches what is on screen', () => {
    const PD = 10n ** 12n;
    const model = describeAccountLocks({
        free: String(100n * PD), reserved: '0', frozen: String(10n * PD), ed: String(PD), block: 1_000_000, blockMs: 12000, bondingDays: 28,
        locks: [{ id: 'democrac', amount: String(10n * PD), reasons: 'All' }, { id: 'phrelect', amount: String(5n * PD), reasons: 'All' }],
        freezes: [], holds: [], reserves: [], staking: { bonded: false, total: '0', active: '0', unlocking: '0' },
        democracy: { delegating: false, lockingPeriod: 216000, votes: [{ index: 7, aye: true, conviction: 'Locked1x', balance: String(10n * PD) }], prior: { until: 0, amount: '0' },
            referenda: { 7: { finished: true, approved: true, end: 900_000 } } },
        elections: { voter: { stake: String(5n * PD), deposit: String(PD), votes: 3 }, candidacy: null },
        identity: null, proxy: null, pallets: { vesting: false, ormlVesting: false }
    });
    const cells = (html) => { const d = new Window().document; d.body.innerHTML = html; return qa(d, 'tbody tr td:last-child').map(txt).join(' | '); };
    test('with a signing account the text points below, where the buttons are', () => {
        const t = cells(renderBalanceLocks(model, { helpIcon: () => '', canSign: true }));
        assert.match(t, /use Remove votes and unlock below/);
        assert.match(t, /Use Remove council vote below/);
        assert.doesNotMatch(t, /onnect this account/);
    });
    test('without one (a looked-up account, no wallet) it says to connect, naming each button', () => {
        const t = cells(renderBalanceLocks(model, { helpIcon: () => '', canSign: false }));
        assert.match(t, /connect this account, then use Remove votes and unlock\b(?! below)/);
        assert.match(t, /Connect this account, then use Remove council vote\./);
        assert.doesNotMatch(t, /Remove votes and unlock below|Remove council vote below/);
    });
    test('delegating and ongoing rows name buttons, not calls', () => {
        const base = { free: String(100n * PD), reserved: '0', frozen: String(PD), ed: String(PD), block: 2000, blockMs: 12000, bondingDays: 28, locks: [{ id: 'democrac', amount: String(PD), reasons: 'All' }],
            freezes: [], holds: [], reserves: [], staking: { bonded: false, total: '0', active: '0', unlocking: '0' }, elections: null, identity: null, proxy: null, pallets: {} };
        const del = describeAccountLocks({ ...base, democracy: { delegating: true, target: 'x', conviction: 'Locked3x', balance: String(PD), prior: { until: 0, amount: '0' }, lockingPeriod: 216000 } });
        const ong = describeAccountLocks({ ...base, democracy: { delegating: false, lockingPeriod: 216000, votes: [{ index: 3, aye: true, conviction: 'Locked1x', balance: String(PD) }], prior: { until: 0, amount: '0' }, referenda: { 3: { ongoing: true, end: 5000 } } } });
        for (const m of [del, ong]) assert.doesNotMatch(m.items.find(i => i.id === 'democrac').unlock, /democracy\.[a-zA-Z]+/);
        assert.match(del.items.find(i => i.id === 'democrac').unlock, /^Use Undelegate below\./);
        assert.match(cells(renderBalanceLocks(del, { helpIcon: () => '', canSign: false })), /^Connect this account, then use Undelegate\./);
    });
});

describe('S10: Copy restores the literal word after a double click', () => {
    test('two clicks inside 1.5 s, and after the timers the button reads Copy', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const win = new Window();
        const el = win.document.createElement('div');
        win.document.body.appendChild(el);
        mountNodeGuide(el, { esc: escapeHtml, helpIcon: () => '', release: {}, fetchJson: async () => ({}), clipboard: { writeText: async () => {} } });
        const first = el.querySelector('button[data-copy]');
        first.click();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        t.mock.timers.tick(500);
        first.click();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        assert.match(first.textContent, /Copied/);
        t.mock.timers.tick(5000);
        assert.equal(first.textContent.trim(), 'Copy');
    });
});

describe('S11: setChip swaps the role, the icon and the word together', () => {
    test('setChip', () => {
        const doc = new Window().document;
        doc.body.innerHTML = '<span class="validate-word is-step"><i class="bx bx-right-arrow-alt" aria-hidden="true"></i> Ready to sign</span>';
        const el = doc.body.firstChild;
        setChip(el, 'is-wait', 'bx-loader-alt', 'Sent <b>now</b>');
        assert.equal(el.className, 'validate-word is-wait');
        assert.equal(el.querySelectorAll('i.bx').length, 1);
        assert.ok(el.querySelector('i').classList.contains('bx-loader-alt'));
        assert.equal(el.querySelector('i').getAttribute('aria-hidden'), 'true');
        assert.equal(txt(el), 'Sent <b>now</b>', 'the word is text, never markup');
        setChip(el, 'is-neutral', null, 'Waiting');
        assert.equal(el.className, 'validate-word is-neutral');
        assert.equal(el.querySelector('i'), null);
        assert.equal(txt(el), 'Waiting');
    });
    test('the stepper updates the current word in place with setChip: no stale role class', async () => {
        const el = await state('steps-S2');
        const w = el.querySelector('ol.validate-stepwise > li[aria-current="step"] .validate-word');
        assert.ok(w.classList.contains('is-wait'));
        assert.ok(!w.classList.contains('is-step'), 'the old Ready to sign class is gone');
        assert.ok(w.querySelector('i.bx-loader-alt'));
    });
    test('resultWord lives in ui-parts once', () => {
        assert.match(resultWord('other', 'x'), /is-error/);
        assert.match(resultWord('free', 'x'), /is-positive/);
        assert.match(resultWord('zzz', 'x'), /is-neutral/);
        for (const f of ['lib/validator-setup-view.js', 'lib/validator-manage-view.js']) assert.ok(!/const resultWord\s*=/.test(stripComments(readRepo(f, import.meta.url))), f);
    });
});

describe('S12: the leftover wording', () => {
    test('Q22: the candidacy, withdraw and vote sign buttons say "Sign and ..."', () => {
        for (const t of ['Sign and withdraw candidacy', 'Sign and submit candidacy', 'Sign and submit vote']) assert.match(INDEX, new RegExp('>' + t + '<'), t);
        for (const old of ['Sign &amp; withdraw candidacy', 'Sign & Submit Candidacy', 'Sign &amp; Submit Vote']) assert.ok(!INDEX.includes(old), old);
        const code = stripComments(SCRIPT);
        assert.ok(code.includes("idleText: 'Sign and submit candidacy'"));
        assert.equal(code.split("idleText: 'Sign and submit vote'").length - 1, 2);
        assert.ok(!code.includes("'Sign & Submit"));
        assert.ok(!stripComments(readRepo('lib/council-candidacy-view.js', import.meta.url)).includes('`Sign & '));
    });
    test('Q23: the loading line says account', () => {
        assert.ok(SCRIPT.includes('Loading your account'));
        assert.ok(!SCRIPT.includes('Loading your wallet dashboard'));
    });
});
