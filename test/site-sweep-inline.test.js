// Sprint 11 site sweep, WP1 (cto-team/plans/2026-11-26-sprint11-site-sweep.md, sections 2.1, 2.3 rows I31 and I48,
// and 6.2 T12): the three new helpers of lib/ui-parts.js, rendered into happy-dom and read back as DOM.
//   stateHtml(kind, text, { roomy, esc })              the centred loading, empty, waiting, failed and invalid states
//   loadFailedHtml({ title, detail, hint, retryId, esc }) a page that could not load: an amber panel and "Try again"
//   setHint(el, state, text)                           a hint or message state by data-state, never by a colour from script

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { escapeHtml } from '../lib/html-escape.js';

const parts = await import('../lib/ui-parts.js');
const need = (name) => { assert.equal(typeof parts[name], 'function', `lib/ui-parts.js does not export ${name}`); return parts[name]; };
const dom = (html = '') => {
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    win.document.body.innerHTML = html;
    return win.document;
};
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

describe('T12: stateHtml', () => {
    const CASES = [
        ['loading', 'bx-loader-alt', 'status'], ['empty', null, null], ['wait', 'bx-time-five', 'status'],
        ['failed', 'bx-error', 'alert'], ['invalid', 'bx-error-circle', null]
    ];
    for (const [kind, iconName, role] of CASES) {
        test(`${kind}: div.ui-state.is-${kind}, ${iconName ? 'the ' + iconName + ' icon first' : 'no icon'}, ${role ? 'role ' + role : 'no role'}, the text escaped`, () => {
            const doc = dom(need('stateHtml')(kind, 'Indexer is syncing <b>now</b> & then', { esc: escapeHtml }));
            const el = doc.body.firstElementChild;
            assert.equal(el.tagName, 'DIV');
            assert.ok(el.classList.contains('ui-state') && el.classList.contains('is-' + kind), el.className);
            assert.equal(el.classList.contains('is-roomy'), false);
            assert.equal(el.getAttribute('role'), role);
            const icons = el.querySelectorAll('i.bx');
            if (iconName) {
                assert.equal(icons.length, 1);
                assert.ok(el.firstElementChild === icons[0], 'the icon comes first');
                assert.ok(icons[0].classList.contains(iconName));
                assert.equal(icons[0].getAttribute('aria-hidden'), 'true');
                if (kind === 'loading') assert.ok(icons[0].classList.contains('bx-spin'));
            } else assert.equal(icons.length, 0);
            assert.equal(el.querySelector('b') === null, true, 'the text was not escaped');
            assert.equal(text(el), 'Indexer is syncing <b>now</b> & then');
            assert.equal(el.hasAttribute('style'), false);
        });
    }
    test('roomy adds .is-roomy (the 40 px blocks)', () => {
        const el = dom(need('stateHtml')('empty', 'No validators', { roomy: true, esc: escapeHtml })).body.firstElementChild;
        assert.ok(el.classList.contains('is-roomy'));
    });
});

describe('T12: loadFailedHtml (row I48, buttons 21 to 23)', () => {
    const html = () => need('loadFailedHtml')({ title: "Couldn't load treasury data", detail: 'Indexer <offline>', hint: 'The chain indexer is likely restarting or timing out. Try again in a moment.', retryId: 'treasury-retry-btn', esc: escapeHtml });
    test('a glass card holding an amber panel (title, detail, hint) and a secondary "Try again" with the refresh icon', () => {
        const doc = dom(html());
        const card = doc.body.firstElementChild;
        assert.ok(['list-container', 'glass', 'ui-state', 'is-roomy'].every(c => card.classList.contains(c)), card.className);
        const panel = card.querySelector('.ui-panel.is-warn');
        assert.ok(panel, 'no amber panel: an explorer-side read failure is not red');
        assert.ok(panel.querySelector(':scope > .bx.bx-error'));
        assert.equal(text(panel.querySelector('.ui-panel-title')), "Couldn't load treasury data");
        assert.match(text(panel), /Indexer <offline>/);
        assert.match(text(panel), /The chain indexer is likely restarting or timing out\. Try again in a moment\./);
        assert.equal(panel.querySelector('offline') === null, true, 'the detail was not escaped');
        const btn = card.querySelector('button#treasury-retry-btn');
        assert.ok(btn, 'no retry button');
        assert.equal(btn.getAttribute('type'), 'button');
        assert.ok(btn.classList.contains('validate-secondary'));
        assert.ok(!btn.classList.contains('staking-download-btn'));
        assert.ok(btn.querySelector('.bx.bx-refresh'));
        assert.equal(text(btn), 'Try again');
        assert.equal(doc.querySelector('[style]') === null, true, 'an inline style is left');
        assert.equal(doc.querySelector('.ui-panel.is-error') === null, true);
    });
});

describe('T12: setHint (row I31)', () => {
    const STATES = [['', null], ['note', null], ['ok', 'bx-check'], ['error', 'bx-error-circle']];
    for (const [state, iconName] of STATES) {
        test(`state "${state}": data-state, ${iconName || 'no icon'}, the text exactly, no style touched`, () => {
            const doc = dom('<div id="h" class="stake-hint" style="display: block;">old <b>markup</b></div>');
            const el = doc.getElementById('h');
            need('setHint')(el, state, 'Address looks good.');
            assert.equal(el.getAttribute('data-state'), state);
            assert.equal(el.textContent, 'Address looks good.', 'the text, with nothing added around it');
            assert.equal(el.querySelector('b') === null, true);
            const icons = el.querySelectorAll('i');
            if (iconName) {
                assert.equal(icons.length, 1);
                assert.ok(icons[0].classList.contains('bx') && icons[0].classList.contains(iconName) && icons[0].classList.contains('ui-hint-icon'), icons[0].className);
                assert.equal(icons[0].getAttribute('aria-hidden'), 'true');
                assert.ok(el.firstElementChild === icons[0], 'the icon comes first');
            } else assert.equal(icons.length, 0);
            assert.equal(el.getAttribute('style'), 'display: block;', 'setHint changed the style');
        });
    }
    test('text left out: only the state changes (a refusal the caller drew keeps its markup)', () => {
        const doc = dom('<div id="h" class="stake-hint">Use <a href="/x">this</a> instead</div>');
        const el = doc.getElementById('h');
        need('setHint')(el, 'error');
        assert.equal(el.getAttribute('data-state'), 'error');
        assert.ok(el.querySelector('a[href="/x"]'));
        assert.equal(el.hasAttribute('style'), false);
    });
    test('a state change replaces the old icon (never two)', () => {
        const doc = dom('<div id="h" class="staking-error"></div>');
        const el = doc.getElementById('h');
        need('setHint')(el, 'error', 'First');
        need('setHint')(el, 'ok', 'Second');
        assert.equal(el.querySelectorAll('i').length, 1);
        assert.ok(el.querySelector('i.bx-check'));
        assert.equal(el.textContent, 'Second');
        need('setHint')(el, 'note', 'Third');
        assert.equal(el.querySelectorAll('i').length, 0);
    });
    test('no element: nothing happens', () => {
        assert.doesNotThrow(() => need('setHint')(null, 'ok', 'x'));
    });
});

// ── row I16: the email alerts modal (form and success), run from script.js in a vm on index.html's body ──
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { bodyOf } from './helpers/source.js';
const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.lastIndexOf('</body>') + 7).replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '').replace(/<script[\s\S]*?<\/script>/g, '');
const COLOUR = /(^|;)\s*(color|background(-color|-image)?|border(?!-radius)(-[a-z]+)*)\s*:/i;
function emailWorld(answer = { status: 'pending' }) {
    const doc = dom(BODY);
    const ctx = vm.createContext({ document: doc, window: doc.defaultView, setTimeout, console, JSON, Object, Error, String,
        stakingEscapeHtml: escapeHtml, fetch: async () => ({ ok: true, status: 200, json: async () => answer }), parseJsonResponse: async (r) => r.json(), ...parts });
    vm.runInContext(['openEmailSubscribeModal', 'closeEmailSubscribeModal', 'renderEmailSubscribeForm', 'wireEmailSubscribeForm', 'renderEmailSubscribeSuccess'].map(n => bodyOf(SCRIPT, n)).join('\n'), ctx);
    return { doc, ctx, content: doc.getElementById('email-subscribe-content') };
}
const coloured = (root) => Array.from(root.querySelectorAll('[style]')).filter(e => COLOUR.test(';' + e.getAttribute('style'))).map(e => `<${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} style="${e.getAttribute('style')}">`);

describe('I16: the email alerts modal on the kit (words unchanged)', () => {
    // Amended in sprint 11 WP3b (Q3, spec 5.1 row 12): Subscribe drops .is-solid and is the gradient primary.
    test('the form: one primary (Subscribe, .validate-primary, the gradient), Cancel as text, the field and groups on the kit, no colour in markup', () => {
        const w = emailWorld();
        w.ctx.openEmailSubscribeModal('democracy');
        const c = w.content;
        assert.deepEqual(coloured(c), []);
        const submit = c.querySelector('#email-subscribe-submit');
        assert.ok(submit.classList.contains('validate-primary') && !submit.classList.contains('is-solid'), submit.className);
        assert.equal(text(submit), 'Subscribe');
        assert.equal(submit.getAttribute('type'), 'submit');
        const cancel = c.querySelector('#email-subscribe-cancel');
        assert.ok(cancel.classList.contains('validate-text-btn'), cancel.className);
        assert.equal(text(cancel), 'Cancel');
        assert.equal(c.querySelectorAll('.validate-primary, .modal-submit-btn').length, 1);
        assert.ok(c.querySelector('#email-subscribe-input').classList.contains('ui-input'));
        assert.equal(c.querySelectorAll('fieldset.ui-fieldset').length, 2);
        for (const l of c.querySelectorAll('legend, label[for="email-subscribe-input"]')) assert.ok(l.classList.contains('ui-field-label'), text(l));
        assert.ok(c.querySelector('h2 > .bx-envelope.ui-glyph.is-muted'), 'the envelope icon');
        assert.ok(c.querySelector('a[href="/privacy"].item-link.is-inline'), 'the privacy link');
        const err = c.querySelector('#email-subscribe-error');
        assert.ok(['ui-panel', 'is-error', 'is-line'].every(k => err.classList.contains(k)) && err.getAttribute('role') === 'alert', err.className);
        assert.ok(err.querySelector('.bx-error-circle'));
        assert.equal(text(c), 'Email me when… Get a short email when on-chain governance events happen. Double opt-in, one-click unsubscribe. Email address Governance New referendum opens for voting New public proposal tabled 24-hour reminder before a referendum closes Referendum result (passed / failed) Treasury proposal activity Council motion activity Network milestones Runtime upgrade Era boundary summary Chain stalled alert (ops) Subscribe Cancel We only use your address to send the alerts you\'ve selected. See privacy for details. One-click unsubscribe is in every email.');
    });
    test('a bad address: the same words in the red line panel, its icon kept', async () => {
        const w = emailWorld();
        w.ctx.openEmailSubscribeModal('democracy');
        w.doc.getElementById('email-subscribe-input').value = 'nope';
        w.doc.getElementById('email-subscribe-form').dispatchEvent(new w.doc.defaultView.Event('submit', { cancelable: true }));
        await new Promise(r => setTimeout(r, 5));
        const err = w.doc.getElementById('email-subscribe-error');
        assert.equal(text(err), 'Please enter a valid email address.');
        assert.ok(err.querySelector('.bx-error-circle'), 'the message replaced the icon');
    });
    test('the success states: a green icon, the words, Done as a secondary; no colour in markup', () => {
        for (const [status, words] of [['pending', 'Check your inbox We sent a confirmation link to a@b.co. Click it to start receiving alerts. The link is valid for 24 hours; you can request a new one any time from this modal. Done'],
            ['already-confirmed', 'You\'re already subscribed We already have a@b.co on the list. You\'ll keep receiving the alerts you\'ve signed up for. Done']]) {
            const w = emailWorld();
            w.ctx.renderEmailSubscribeSuccess('a@b.co', status);
            assert.deepEqual(coloured(w.content), [], status);
            assert.equal(text(w.content), words);
            const done = w.content.querySelector('#email-subscribe-done');
            assert.ok(done.classList.contains('validate-secondary'), done.className);
            if (status === 'pending') assert.ok(w.content.querySelector('.bx-mail-send.ui-glyph.is-green'));
        }
    });
});
