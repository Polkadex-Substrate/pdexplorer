// Work Package 3 of the validate redesign (cto-team/plans/2026-11-21-validate-redesign-and-colour-roles.md,
// sections 5, 7 and 8, and the fidelity rulings of 2026-11-22): the setup wizard, the separate steps view,
// the manage panel and the node guide take the colour roles. Visual only: test/wp3-freeze.test.js holds
// the words, fields, actions and logic.
//
// Roles: violet structures (step markers, the current edge, manage icons), green is done (marker, check,
// chip), amber is attention (warnings, pending, waiting), blue is guidance (stash notes, timing, if you
// stop here), red is failure (alerts, Failed on chain, Blocked, invalid fields). One primary per state,
// no accent on an action, every coloured element carries an icon or a word.
//
// Every state is the real mount on a fake chain (test/helpers/wp3-world.js). Synthetic accounts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { buildState, closeWorld, SETUP_STATES, MANAGE_STATES } from './helpers/wp3-world.js';
import { parseRules } from './helpers/css-rules.js';
import { VALIDATE_STATEMENT } from '../lib/validator-status-view.js';
import { SW, STEP_WORDS } from '../lib/validator-setup-steps.js';
import { ROTATE_RULE, PURGE_NOTE } from '../lib/validator-manage.js';
import { MULTISIG_CHANGE_WARNING } from '../lib/validator-delegate.js';
import { nodeCheckModel } from '../lib/node-check.js';
import { renderNodeCheckResult } from '../lib/node-check-view.js';
import { escapeHtml } from '../lib/html-escape.js';
import { PAGE_PRIMARY_SELECTOR, headerLook } from '../lib/ui-parts.js';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const RULES = parseRules(CSS);
// Each state is built on its own page, copied as markup into one shared document and its page closed, so
// eighty happy-dom windows are never alive at once.
const SHARED = new Window({ url: 'http://localhost/validate' });
const cache = new Map();
async function state(id) {
    if (!cache.has(id)) {
        const w = await buildState(id);
        if (w.release) w.release();
        const el = SHARED.document.createElement('div');
        el.innerHTML = w.el.innerHTML;
        await closeWorld(w);
        cache.set(id, { el });
    }
    return cache.get(id);
}
const qa = (el, sel) => Array.from(el.querySelectorAll(sel));
const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
const hasIcon = (n, name) => !!n.querySelector(name ? `.bx.${name}` : '.bx');
// Never hand a DOM node to assert as the actual value: inspecting a happy-dom node walks the whole window.
// Rules whose selector list holds sel (exactly, whitespace collapsed); media '' for the plain stylesheet.
const rulesFor = (sel, media = null) => RULES.filter(r => r.selectors.includes(sel) && (media == null || (media === '' ? !r.media : media instanceof RegExp ? media.test(r.media) : r.media.includes(media))));
const decl = (sel, prop, media = '') => { const r = rulesFor(sel, media).filter(x => x.decls[prop] != null); return r.length ? r[r.length - 1].decls[prop] : undefined; };

// ── one primary per state (R3 and the fallback spec tables): the expected count of every state ──
const ZERO = new Set(['wiz-restoring', 'wiz-chain-down', 'wiz-refusal', 'wiz-step2-mismatch', 'wiz-result-missing', 'wiz-result-approval',
    'steps-S3', 'steps-S6-blocked', 'steps-S7', 'steps-S8',
    'man-idle', 'man-unbonding', 'man-legacy', 'man-chain-down', 'man-disabled', 'man-keys-mismatch', 'man-result-done', 'man-result-waiting', 'man-proxy', 'man-proxy-delay', 'man-ms-approval', 'man-ms-pending',
    // C-1 (CEO approval 2026-11-25): the Stop validating confirm step signs from a secondary, so it has no primary.
    'man-chill', 'man-ms-review']);
const ALL = [...SETUP_STATES.map(s => s[0]), ...MANAGE_STATES.map(s => s[0])];

describe('WP3: one primary per view state, never an accent on an action', () => {
    test('every wizard step, every stepper state S0 to S10 and every manage state shows the primary count of the spec', async () => {
        const bad = [];
        for (const id of ALL) {
            const w = await state(id);
            const n = qa(w.el, '.validate-primary').length;
            const want = ZERO.has(id) ? 0 : 1;
            if (n !== want) bad.push(`${id}: ${n} primaries, the spec wants ${want}`);
        }
        assert.deepEqual(bad, []);
    });
    test('the node guide has exactly one primary, "Set up a validator", whether the release is pending or published', async () => {
        for (const id of ['guide-pending', 'guide-published']) {
            const w = await state(id);
            const p = qa(w.el, '.validate-primary');
            assert.deepEqual(p.map(b => [txt(b), b.getAttribute('href')]), [['Set up a validator', '/validate/setup']], id);
        }
    });
    test('no button or link carries a role colour class, a chip or a panel class (green, amber, blue and red never act)', async () => {
        const bad = [];
        for (const id of [...ALL, 'guide-pending', 'guide-published']) {
            const w = await state(id);
            for (const b of qa(w.el, 'button, a')) if (/\b(is-positive|is-wait|is-info|is-error|ui-chip|ui-panel|ui-tile)\b/.test(b.className)) bad.push(`${id}: <${b.tagName.toLowerCase()} class="${b.className}">${txt(b).slice(0, 30)}`);
        }
        assert.deepEqual(bad, []);
    });
    test('every coloured element has an icon and a word: chips, status words, panels; done markers say done to a screen reader', async () => {
        const bad = [];
        for (const id of [...ALL, 'guide-pending', 'guide-published']) {
            const w = await state(id);
            for (const c of qa(w.el, '.ui-chip, .validate-word, .ui-panel, .validate-alert')) {
                const coloured = /\b(is-positive|is-wait|is-info|is-step|is-error|is-warn|is-ok)\b/.test(c.className) || c.classList.contains('validate-alert');
                if (!coloured) continue;
                if (!hasIcon(c)) bad.push(`${id}: no icon in .${c.className.split(' ').join('.')} "${txt(c).slice(0, 40)}"`);
                if (!txt(c)) bad.push(`${id}: no word in .${c.className.split(' ').join('.')}`);
                for (const i of qa(c, '.bx')) if (!i.closest('a') && i.getAttribute('aria-hidden') !== 'true') bad.push(`${id}: an icon in "${txt(c).slice(0, 30)}" is not aria-hidden`);
            }
            for (const m of qa(w.el, '.ui-step.is-done')) if (!hasIcon(m, 'bx-check') || txt(m.querySelector('.sr-only')) !== 'done') bad.push(`${id}: a done marker without the check and "done"`);
            for (const t of qa(w.el, '.ui-tile')) if (t.getAttribute('aria-hidden') !== 'true' || !hasIcon(t)) bad.push(`${id}: a tile that is not a hidden glyph`);
        }
        assert.deepEqual(bad, []);
    });
});

describe('WP3 5.1: the setup wizard', () => {
    test('the card has the hairline and the compact path, step 2 current, Run a node and Set up as links', async () => {
        const w = await state('wiz-step1');
        const card = w.el.querySelector('.validate-setup');
        assert.ok(card.classList.contains('ui-hairline'));
        const path = card.querySelector('.validate-path.is-compact');
        assert.ok(path, 'the compact path strip');
        const cur = path.querySelector('[aria-current="step"]');
        assert.match(txt(cur), /Set up/);
        assert.deepEqual(qa(path, 'a.validate-path-link').map(a => a.getAttribute('href')), ['/validate/node']);   // M1: Set up is the current page, no self-link
        assert.ok(card.querySelector('.list-header + .validate-path, .list-header ~ .validate-path'), 'the path sits above the body');
    });
    test('the step list: markers from the position; current solid violet, done green with a check and "Done on chain", later muted', async () => {
        const w = await state('wiz-step3');
        const lis = qa(w.el, 'ol.validate-steps > li');
        assert.equal(lis.length, 5);
        assert.deepEqual(lis.map(li => li.querySelector('.ui-step') && li.querySelector('.ui-step').className.replace('ui-step ', '')), ['is-done', 'is-done', 'is-current', 'is-later', 'is-later']);
        assert.deepEqual(lis.map(li => txt(li.querySelector('.ui-step:not(.is-done)'))), ['', '', '3', '4', '5']);
        const done = lis[1].querySelector('.validate-step-done');
        assert.ok(hasIcon(done, 'bx-check') && /Done on chain/.test(txt(done)));
        assert.equal(decl('.validate-step-done', 'color'), 'var(--accent-green)');
        assert.equal(decl('.validate-step.is-current', 'border-left-color'), 'var(--accent-violet)');
        assert.ok(!/content:\s*counter/.test(decl('.validate-step::before', 'content') || ''), 'the CSS counter is gone; the marker holds the number');
        const w2 = await state('wiz-step2');
        assert.equal(qa(w2.el, 'ol.validate-steps > li')[0].querySelector('.ui-step').className, 'ui-step is-open', 'a step behind the current one, not done on chain, is open');
    });
    test('the phone progress line keeps its text and gains a five-segment bar labelled by it', async () => {
        const w = await state('wiz-step3');
        const p = w.el.querySelector('.validate-setup-progress');
        assert.equal(txt(p), 'Step 3 of 5: Stash and bond');
        const bar = w.el.querySelector('.validate-setup-bar');
        assert.ok(bar && bar.getAttribute('role') === 'progressbar' && bar.getAttribute('aria-labelledby') === p.id && p.id);
        assert.deepEqual([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemin'), bar.getAttribute('aria-valuemax')], ['3', '1', '5']);
        assert.deepEqual(qa(bar, 'span').map(s => s.className), ['is-done', 'is-done', 'is-current', 'is-later', 'is-later']);
        assert.equal(decl('.validate-setup-bar > .is-done', 'background'), 'var(--accent-green)');
        assert.equal(decl('.validate-setup-bar > .is-current', 'background'), 'var(--accent-violet)');
        assert.equal(decl('.validate-setup-bar > .is-later', 'background'), 'rgba(255, 255, 255, 0.12)');
        assert.equal(decl('.validate-setup-bar > span', 'height'), '4px');
    });
    test('step 1: the statement is a trust row, verbatim; no pink edge', async () => {
        const w = await state('wiz-step1');
        assert.ok(!w.el.querySelector('.validate-statement'), 'absent');
        const t = w.el.querySelector('.ui-trust');
        assert.ok(t && t.querySelector('.ui-tile.is-green .bx-shield-quarter'));
        assert.equal(txt(t), VALIDATE_STATEMENT);
    });
    test('step 3: the two stash notes are one blue info panel', async () => {
        const w = await state('wiz-step3');
        const p = qa(w.el, '.ui-panel.is-info:not(.is-line)');
        assert.equal(p.length, 1);
        assert.match(txt(p[0]), /^Use a stash whose key stays offline.*A proxy cannot set up a validator: setup needs the stash itself, or its multisig\.$/);
        assert.equal(qa(p[0], 'p').length, 2);
        assert.ok(hasIcon(p[0], 'bx-info-circle'));
    });
    test('review: the warnings are an amber panel titled "Before you sign", list and checkbox inside; timing is a blue line; call names violet', async () => {
        const w = await state('wiz-review');
        const warn = w.el.querySelector('.validate-warnings');
        assert.ok(warn.classList.contains('ui-panel') && warn.classList.contains('is-warn'));
        assert.equal(txt(warn.querySelector('.ui-panel-title')), 'Before you sign');
        assert.ok(warn.querySelector('ul > li') && warn.querySelector('#validate-setup-ack'));
        assert.ok(hasIcon(warn, 'bx-error'));
        const timing = qa(w.el, '.ui-panel.is-info.is-line').map(txt);
        assert.ok(timing.some(t => /^A new validator/.test(t) || /era/.test(t)), 'the timing line is a blue info line');
        assert.equal(decl('.validate-review code.mono', 'color'), 'var(--accent-violet-text)');
        const marker = rulesFor('.validate-review > li::before')[0];
        assert.ok(marker && /counter/.test(marker.decls.content) && marker.decls.width === '24px' && marker.decls.background === 'transparent' && /violet-line/.test(marker.decls.border), 'review numbers are 24 px outlined violet markers (S3)');
    });
    test('the multisig review: the change warning is an amber panel', async () => {
        const w = await state('wiz-review-multisig');
        const p = qa(w.el, '.ui-panel.is-warn').find(x => txt(x) === MULTISIG_CHANGE_WARNING);
        assert.ok(p, 'MULTISIG_CHANGE_WARNING in an amber panel');
    });
    test('keys: the mismatch is an amber panel; the conflict alert has its icon; result words are chips with icons', async () => {
        const m = await state('wiz-step2-mismatch');
        const mm = m.el.querySelector('.validate-mismatch');
        assert.ok(mm.classList.contains('ui-panel') && mm.classList.contains('is-warn') && mm.getAttribute('role') === 'status');
        const w = await state('wiz-step2-conflict');
        assert.ok(hasIcon(w.el.querySelector('.validate-alert[role="alert"]'), 'bx-error-circle'));
        const words = qa(w.el, '.validate-keys-table .validate-word').map(s => [txt(s), s.classList.contains('is-positive') ? 'positive' : s.classList.contains('is-error') ? 'error' : 'other', !!s.querySelector('.bx')]);
        assert.ok(words.length === 6);
        for (const [word, role, icon] of words) {
            assert.equal(role, word === 'Another account' ? 'error' : 'positive', word);
            assert.ok(icon, word + ' has an icon');
        }
    });
    test('the confirmed result is a green panel titled Validator set up (Q36), verbatim, with the one primary Open validator status', async () => {
        const w = await state('wiz-result-applied');
        const ok = w.el.querySelector('.ui-panel.is-ok');
        assert.ok(ok && ok.querySelector('[role="status"]') && /^Submitted and confirmed in block #\d+/.test(txt(ok.querySelector('[role="status"]'))));
        assert.equal(txt(ok.querySelector('.ui-panel-title')), 'Validator set up');
        assert.ok(hasIcon(ok, 'bx-check-circle'));
        assert.deepEqual(qa(w.el, '.validate-primary').map(txt), ['Open validator status']);
    });
    test('an invalid field takes the red line, never the pink hover border (wizard and manage)', () => {
        for (const sel of ['.validate-setup-step input[aria-invalid="true"]', '.validate-setup-step textarea[aria-invalid="true"]', '.validate-manage-panel input[aria-invalid="true"]', '.validate-manage-panel textarea[aria-invalid="true"]']) {
            assert.equal(decl(sel, 'border-color'), 'var(--accent-red-line)', sel);
        }
        const pink = RULES.filter(r => r.selectors.some(s => /aria-invalid/.test(s)) && /--border-hover/.test(r.decls['border-color'] || ''));
        assert.deepEqual(pink.map(r => r.selectors.join(', ')), []);
    });
});

describe('WP3 5.2: the separate steps view', () => {
    const CHIP = { [STEP_WORDS.waiting]: ['is-neutral', null], [STEP_WORDS.ready]: ['is-step', 'bx-right-arrow-alt'], [STEP_WORDS.wallet]: ['is-wait', 'bx-loader-alt'], [STEP_WORDS.sent]: ['is-wait', 'bx-loader-alt'],
        [STEP_WORDS.checking]: ['is-wait', 'bx-loader-alt'], [STEP_WORDS.done]: ['is-positive', 'bx-check'], [STEP_WORDS.notSigned]: ['is-neutral', null], [STEP_WORDS.notConfirmed]: ['is-wait', 'bx-help-circle'],
        [STEP_WORDS.failed]: ['is-error', 'bx-error-circle'], [STEP_WORDS.blocked]: ['is-error', 'bx-error-circle'] };
    const STEPS = SETUP_STATES.map(s => s[0]).filter(id => id.startsWith('steps-'));
    test('every status word maps to its chip class and icon (SW-20 to SW-29), and all ten words are seen', async () => {
        const seen = new Set(), bad = [];
        for (const id of STEPS) {
            const w = await state(id);
            for (const s of qa(w.el, 'ol.validate-stepwise > li .validate-word')) {
                const word = txt(s);
                seen.add(word);
                const [cls, icon] = CHIP[word] || [];
                if (!cls) { bad.push(`${id}: unknown word ${word}`); continue; }
                if (!s.classList.contains(cls)) bad.push(`${id}: "${word}" is ${s.className}, the spec wants ${cls}`);
                if (icon && !hasIcon(s, icon)) bad.push(`${id}: "${word}" lacks ${icon}`);
            }
        }
        assert.deepEqual(bad, []);
        assert.deepEqual([...seen].sort(), Object.values(STEP_WORDS).sort(), 'every word of SW-20 to SW-29 is rendered by some state');
    });
    test('numbers are step markers; the aria-current row has the 2 px violet edge', async () => {
        const w = await state('steps-S4');
        const lis = qa(w.el, 'ol.validate-stepwise > li');
        assert.deepEqual(lis.map(li => li.querySelector('.ui-step').className.replace('ui-step ', '')), ['is-done', 'is-current', 'is-later']);
        assert.equal(txt(lis[1].querySelector('.ui-step')), '2');
        const edge = decl('.validate-stepwise-step[aria-current="step"]', 'box-shadow');
        assert.equal(edge, 'inset 2px 0 0 var(--accent-violet)');
    });
    test('the not-all-or-nothing panel is amber with SW-13 as its title; after a confirmation SW-14 alone stays a plain note', async () => {
        const w = await state('steps-S0');
        const p = w.el.querySelector('.validate-stepwise-panel');
        assert.ok(p.classList.contains('ui-panel') && p.classList.contains('is-warn') && hasIcon(p, 'bx-error'));
        assert.equal(txt(p.querySelector('.ui-panel-title')), SW.panelTitle);
        const w4 = await state('steps-S4');
        assert.ok(!w4.el.querySelector('.validate-stepwise-panel'), 'absent');
        const note = qa(w4.el, '.validate-setup-note').find(n => txt(n) === SW.panelStay);
        assert.ok(note && !note.closest('.ui-panel'));
    });
    test('the status line names its state; S9 is an amber line; S10 sits in a green panel, the timing a blue line after it; the others are plain', async () => {
        for (const id of STEPS) {
            const w = await state(id);
            const st = w.el.querySelector('#validate-stepwise-status');
            // Check again after S7 with the step still missing comes back signable: S0 with SW-46b, not a second S7.
            const s = id === 'steps-S7-repeat' ? 'S0' : id.replace(/^steps-/, '').replace(/-.*/, '');
            assert.equal(st.getAttribute('data-state'), s, id);
            if (s === 'S9') assert.ok(st.classList.contains('ui-panel') && st.classList.contains('is-warn') && st.classList.contains('is-line'), id);
            else if (s === 'S10') {
                const ok = st.closest('.ui-panel.is-ok');
                assert.ok(ok && hasIcon(ok, 'bx-check-circle'), id);
                assert.ok(ok.nextElementSibling.classList.contains('is-info') && ok.nextElementSibling.classList.contains('is-line'), 'the timing is a blue line after the panel (S5)');
            } else assert.ok(!st.closest('.ui-panel'), id + ' is plain');
        }
    });
    test('"If you stop here" is a blue line, text and link verbatim; the S8 block keeps its alert with the icon', async () => {
        const w = await state('steps-S4-bonded');
        const stop = qa(w.el, '.ui-panel.is-info.is-line').find(p => /^If you stop here/.test(txt(p)));
        assert.ok(stop && stop.querySelector('a[href="/wallet"]'), 'the stop line and its link');
        const b = await state('steps-S8');
        assert.ok(hasIcon(b.el.querySelector('.validate-alert[role="alert"]'), 'bx-error-circle'));
    });
});

describe('WP3 5.3: the manage panel', () => {
    test('its own card: a violet tile with bx-slider-alt beside the unchanged title', async () => {
        const w = await state('man-idle');
        const h = w.el.querySelector('#validate-manage-title');
        assert.ok(h.querySelector('.ui-tile.is-violet .bx-slider-alt'));
        assert.equal(txt(h), 'Manage this validator');
    });
    test('action buttons: secondary, a leading icon each, a 2 by 2 grid, 44 px; Stop validating out of the grid as a neutral text button (C-1)', async () => {
        const w = await state('man-unbonding');
        const ICON = { commission: 'bx-purchase-tag', keys: 'bx-key', bondExtra: 'bx-plus-circle', payee: 'bx-wallet', rebond: 'bx-revision' };
        const bs = qa(w.el, '.validate-manage-actions button');
        assert.deepEqual(bs.map(b => b.getAttribute('data-manage-action')), ['commission', 'keys', 'bondExtra', 'payee', 'rebond']);
        const stop = qa(w.el, '.validate-manage-stop button');
        assert.equal(stop.length, 1);
        assert.ok(stop[0].classList.contains('validate-text-btn') && !stop[0].classList.contains('validate-secondary'));
        assert.ok(stop[0].firstElementChild && stop[0].firstElementChild.classList.contains('bx-pause-circle'));
        assert.equal(decl('.validate-manage-stop .validate-text-btn .bx', 'color'), 'var(--text-secondary)');
        for (const b of bs) {
            const k = b.getAttribute('data-manage-action');
            assert.ok(b.classList.contains('validate-secondary'), k);
            assert.ok(b.firstElementChild && b.firstElementChild.classList.contains(ICON[k]), `${k} leads with ${ICON[k]}`);
        }
        assert.equal(decl('.validate-manage-actions .validate-secondary .bx', 'color'), 'var(--accent-violet-text)');
        assert.equal(decl('.validate-manage-actions', 'display'), 'grid');
        assert.match(decl('.validate-manage-actions', 'grid-template-columns'), /repeat\(2,/);
        assert.deepEqual(RULES.filter(r => r.selectors.includes('.validate-manage-actions') && /repeat\(3,/.test(r.decls['grid-template-columns'] || '')).map(r => r.media), [], 'never three columns');
        assert.equal(decl('.validate-manage-actions', 'grid-template-columns', '480px'), '1fr');
        assert.equal(decl('.validate-manage-actions .validate-secondary', 'min-height'), '44px');
    });
    test('disabled reasons and the proxy intro are blue lines; the disabled-validator note is a red panel', async () => {
        const w = await state('man-legacy');
        const why = qa(w.el, '[id^="validate-manage-why-"]');
        assert.ok(why.length >= 1);
        for (const p of why) assert.ok(p.classList.contains('ui-panel') && p.classList.contains('is-info') && p.classList.contains('is-line') && hasIcon(p, 'bx-info-circle'));
        const px = await state('man-proxy');
        assert.ok(qa(px.el, '.ui-panel.is-info.is-line').some(p => /^You are connected as a Staking proxy/.test(txt(p))));
        const d = await state('man-disabled');
        const e = d.el.querySelector('.ui-panel.is-error');
        assert.ok(e && /^This validator is disabled for the rest of this era/.test(txt(e)) && hasIcon(e, 'bx-error-circle'));
    });
    test('timing texts in a review are blue lines', async () => {
        const w = await state('man-commission-review');
        assert.ok(qa(w.el, '.ui-panel.is-info.is-line').some(p => /era/.test(txt(p))), 'the commission timing line');
        const p = await state('man-payee-review');
        assert.ok(qa(p.el, '.ui-panel.is-info.is-line').length >= 1);
    });
    test('rotate keys: ROTATE_RULE in an amber panel, still bold; PURGE_NOTE plain', async () => {
        const w = await state('man-keys-review');
        const rule = qa(w.el, '.ui-panel.is-warn').find(p => txt(p) === ROTATE_RULE);
        assert.ok(rule && rule.querySelector('strong.validate-manage-rule'));
        const purge = qa(w.el, 'p').find(p => txt(p) === PURGE_NOTE);
        assert.ok(purge && !purge.closest('.ui-panel'));
    });
    test('stop validating: the facts list in an amber panel; the button is a neutral secondary with the pause icon (C-1), no primary', async () => {
        const w = await state('man-chill');
        const facts = w.el.querySelector('.validate-manage-facts');
        assert.ok(facts.closest('.ui-panel.is-warn'));
        const sign = w.el.querySelector('[data-manage-action="sign"]');
        assert.ok(sign.classList.contains('validate-secondary') && !/is-error/.test(sign.className));
        assert.ok(sign.firstElementChild && sign.firstElementChild.classList.contains('bx-pause-circle'));
        assert.equal(qa(w.el, '.validate-primary').length, 0);
    });
    test('pending multisig changes: amber tile, a Pending chip per change, the warning in an amber panel', async () => {
        const w = await state('man-ms-pending');
        const sec = w.el.querySelector('.validate-manage-pending');
        assert.ok(sec.querySelector('#validate-manage-pending-title .ui-tile.is-amber .bx-time-five'));
        const ops = qa(sec, '.validate-manage-actions > li');
        assert.ok(ops.length >= 1);
        for (const li of ops) { const c = li.querySelector('.ui-chip.is-wait'); assert.ok(c && txt(c) === 'Pending' && hasIcon(c, 'bx-time-five')); }
        assert.ok(qa(sec, '.ui-panel.is-warn').some(p => txt(p) === MULTISIG_CHANGE_WARNING));
        for (const p of qa(sec, '.validate-setup-note')) if (/checked/.test(txt(p))) assert.ok(p.closest('.ui-panel.is-warn.is-line'), 'NOT_RECHECKED as an amber line');
    });
    test('review, result, keys: the conflict alert has its icon, the done result is a green panel', async () => {
        const c = await state('man-keys-conflict');
        assert.ok(hasIcon(c.el.querySelector('.validate-alert'), 'bx-error-circle'));
        const d = await state('man-result-done');
        assert.ok(d.el.querySelector('.ui-panel.is-ok [role="status"]'));
        const m = await state('man-keys-mismatch');
        assert.ok(m.el.querySelector('.validate-mismatch.ui-panel.is-warn'));
    });
});

describe('WP3 5.4: the node guide', () => {
    test('top: hairline, violet book tile, compact path with step 1 current, the statement as a trust row', async () => {
        const w = await state('guide-pending');
        const card = w.el.querySelector('.validate-guide');
        assert.ok(card.classList.contains('ui-hairline'));
        assert.ok(card.querySelector('.list-header h2 .ui-tile.is-violet .bx-book-open'));
        const path = card.querySelector('.validate-path.is-compact');
        assert.match(txt(path.querySelector('[aria-current="step"]')), /Run a node/);
        assert.ok(!card.querySelector('.validate-statement'), 'absent');
        assert.equal(txt(card.querySelector('.ui-trust')), VALIDATE_STATEMENT);
    });
    test('section headings carry an open violet marker with the number', async () => {
        const w = await state('guide-pending');
        const hs = qa(w.el, '.validate-guide-h3');
        assert.equal(hs.length, 6);
        hs.forEach((h, i) => { const m = h.querySelector('.ui-step.is-open'); assert.ok(m && txt(m) === String(i + 1), txt(h)); assert.ok(!/^\d+\./.test(txt(h))); });
    });
    test('release pending: an amber panel with the Pending chip; published: Release notes is a secondary with the external icon, never a primary', async () => {
        const w = await state('guide-pending');
        const p = w.el.querySelector('.validate-pending');
        assert.ok(p.classList.contains('ui-panel') && p.classList.contains('is-warn'));
        const chip = p.querySelector('.ui-chip.is-wait');
        assert.ok(chip && txt(chip) === 'Pending' && hasIcon(chip, 'bx-time-five'));
        const r = await state('guide-published');
        const notes = qa(r.el, 'a').find(a => txt(a) === 'Release notes');
        assert.ok(notes.classList.contains('validate-secondary') && hasIcon(notes, 'bx-link-external'));
        for (const a of qa(r.el, 'a.validate-primary')) assert.ok(!/^https?:/.test(a.getAttribute('href')), 'no primary on an external link');
    });
    test('Copy buttons gain bx-copy and keep the word; the checklist ticks are green; the footer card holds the one primary', async () => {
        const w = await state('guide-pending');
        const copies = qa(w.el, '[data-copy]');
        assert.ok(copies.length > 3);
        for (const b of copies) assert.ok(hasIcon(b, 'bx-copy') && txt(b) === 'Copy');
        assert.equal(decl('.validate-checklist input', 'accent-color'), 'var(--accent-green)');
        const foot = w.el.querySelector('.validate-guide-next');
        assert.ok(foot && foot.classList.contains('list-container'));
        assert.equal(txt(foot.querySelector('p')), 'Next: set up your validator.');
        assert.ok(foot.querySelector('a.validate-primary[href="/validate/setup"][data-spa-link="true"]'));
    });
    test('the header follows the outline rule: no wallet and the guide primary means an outline Connect Wallet', async () => {
        const w = await state('guide-pending');
        assert.ok(w.el.querySelector(PAGE_PRIMARY_SELECTOR));
        assert.equal(headerLook({ connected: false, pagePrimary: !!w.el.querySelector(PAGE_PRIMARY_SELECTOR) }), 'outline');
    });
    test('node check words follow the tone table: In sync green with a check circle, Behind amber with a clock', () => {
        const base = { feed: 'ok', name: 'alpha', head: 1000, release: { state: 'pending' }, count: 1 };
        const behind = nodeCheckModel({ ...base, nodes: [{ best: 900, peers: 8 }] });
        assert.equal(behind.word, 'Behind');
        assert.equal(behind.tone, 'wait');
        const hb = renderNodeCheckResult({ ...base, nodes: [{ best: 900, peers: 8 }] }, { esc: escapeHtml });
        assert.match(hb, /class="validate-word is-wait"><i class="bx bx-time-five" aria-hidden="true"><\/i>Behind</);
        const hs = renderNodeCheckResult({ ...base, nodes: [{ best: 999, peers: 8 }] }, { esc: escapeHtml });
        assert.match(hs, /class="validate-word is-positive"><i class="bx bx-check-circle" aria-hidden="true"><\/i>In sync</);
    });
});

describe('WP3 7: tap targets at 375 (CSS)', () => {
    test('manage buttons, primaries in the wizard, stepper and guide, the wizard lookup button and compact path links are 44 px high at 640 and below', () => {
        const want = [
            ['.validate-manage-actions .validate-secondary', ''],
            ['.validate-setup-actions .validate-primary', '640px'],
            ['.validate-guide-next .validate-primary', '640px'],
            ['.validate-setup-step .validate-lookup-row > button', '640px'],
            ['.validate-path.is-compact .validate-path-link', '640px'],
            ['.validate-stepwise-actions .validate-primary', /max-width: (640|768)px/]
        ];
        const bad = want.filter(([sel, media]) => decl(sel, 'min-height', media) !== '44px').map(([sel, media]) => `${sel} @${String(media) || 'all'}: ${decl(sel, 'min-height', media)}`);
        assert.deepEqual(bad, []);
    });
});
