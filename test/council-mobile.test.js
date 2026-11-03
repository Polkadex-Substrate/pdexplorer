// Evaluate the real HTML and CSS at phone widths. Happy DOM checks the cascade
// and containment, not pixel layout; an on-device check still covers rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { createCouncilCandidacyUI } from '../lib/council-candidacy-view.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const actionIds = ['council-submit-candidacy-btn', 'council-withdraw-btn', 'council-vote-btn'];

function councilDocument(t, width) {
    const window = new Window({ width, height: 844, settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true
    } });
    t.after(() => window.happyDOM.close());
    const { document } = window;
    document.write(html);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.querySelectorAll('.page-section').forEach(page => { page.style.display = 'none'; });
    const page = document.querySelector('.council-page');
    page.style.display = 'flex';
    return { document, page, style: element => window.getComputedStyle(element) };
}

function ancestors(element) {
    const result = [];
    for (let e = element; e; e = e.parentElement) result.push(e);
    return result;
}

for (const width of [320, 390, 430, 600, 844, 900]) {
    test(`council actions stay reachable above the member lists at ${width}px`, t => {
        const { document, page, style } = councilDocument(t, width);
        const topbar = document.querySelector('.topbar');
        for (const id of actionIds) {
            const matches = document.querySelectorAll(`#${id}`);
            assert.equal(matches.length, 1, `${id}: keep one control and its existing click handler`);
            const button = matches[0];
            assert.equal(button.tagName, 'BUTTON');
            assert.equal(button.disabled, false);
            assert.ok(ancestors(button).every(e => style(e).display !== 'none'), `${id}: visible without wallet gating`);
            const pinned = ancestors(button).find(e => ['sticky', 'fixed'].includes(style(e).position));
            assert.ok(pinned, `${id}: actions scroll out of reach with the long member lists`);
            assert.ok(page.contains(pinned), `${id}: pinned actions must disappear when leaving Council`);
            assert.ok(parseFloat(style(pinned).top) >= parseFloat(style(topbar).height), `${id}: clear the top bar`);
            assert.ok(Number(style(pinned).zIndex) > 0, `${id}: remain above the scrolling tables`);
            assert.ok(Number(style(pinned).zIndex) < Number(style(document.querySelector('.sidebar')).zIndex), `${id}: do not cover the navigation drawer`);
            assert.ok(Number(style(pinned).zIndex) < Number(style(document.querySelector('#council-withdraw-modal')).zIndex), `${id}: do not cover the signing dialog`);
            for (const parent of ancestors(pinned.parentElement)) {
                // An overflow-hidden card becomes a sticky scroll container, so
                // a sticky header inside it still scrolls away with the card.
                assert.ok(!/(hidden|auto|scroll|clip)/.test(`${style(parent).overflow} ${style(parent).overflowY}`), `${id}: ${parent.className || parent.tagName} traps the pinned actions`);
            }
            assert.ok(pinned.parentElement.contains(document.querySelector('#council-members-list')), `${id}: sticky containing block must span the member lists`);
            assert.ok(parseFloat(style(button).minHeight) >= 44, `${id}: provide a touch-sized target`);
            assert.notEqual(style(button).whiteSpace, 'nowrap', `${id}: labels must wrap on small phones`);
            assert.equal(parseFloat(style(button).minWidth), 0, `${id}: long labels must not force horizontal overflow`);
        }
        page.style.display = 'none';
        for (const id of actionIds) {
            assert.ok(ancestors(document.getElementById(id)).some(e => style(e).display === 'none'), `${id}: hidden on other pages`);
        }
    });
}

for (const width of [901, 1280]) test(`desktop council actions remain in normal document flow at ${width}px`, t => {
    const { document, style } = councilDocument(t, width);
    for (const id of actionIds) {
        assert.ok(ancestors(document.getElementById(id)).every(e => !['sticky', 'fixed'].includes(style(e).position)), `${id}: mobile pinning must not affect desktop`);
    }
});

test('mobile action buttons still open the existing council flows', t => {
    const { document, style } = councilDocument(t, 390);
    const script = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
    const start = script.indexOf('const candidacyModal =');
    const end = script.indexOf('// ─── Council vote:', start);
    assert.ok(start !== -1 && end > start, 'existing candidacy/vote event bindings');
    const checked = [];
    let votes = 0;
    runInNewContext(script.slice(start, end), {
        document,
        checkWalletForCouncil: kind => checked.push(kind),
        openCouncilVoteModal: () => { votes++; }
    });
    createCouncilCandidacyUI({ document, api: () => null, selected: () => null,
        isMultisig: () => false, submit: () => assert.fail('opening an action must not sign'),
        refresh: () => {}, connectPrompt: () => '<a href="/wallet">Connect wallet</a>' });
    document.getElementById('council-submit-candidacy-btn').click();
    assert.equal(style(document.getElementById('council-candidacy-modal')).display, 'flex');
    assert.deepEqual(checked, ['candidacy']);
    document.getElementById('close-candidacy-modal').click();
    assert.equal(style(document.getElementById('council-candidacy-modal')).display, 'none');
    document.getElementById('council-withdraw-btn').click();
    assert.equal(style(document.getElementById('council-withdraw-modal')).display, 'flex');
    assert.match(document.getElementById('council-withdraw-connect').textContent, /Connect wallet/);
    assert.equal(document.getElementById('council-withdraw-sign').disabled, true);
    document.getElementById('cancel-council-withdraw').click();
    assert.equal(style(document.getElementById('council-withdraw-modal')).display, 'none');
    document.getElementById('council-vote-btn').click();
    assert.equal(votes, 1);
});
