// The preview scenes of the self-updating wallet sections (fidelity review 2026-11-24, P1: "add scenes for R3"; the CEO's
// request: send just included, proxy removed, updating, could not refresh), built in-process through
// tools/preview-scenes.mjs sceneWorld from the REAL lib/wallet-sections.js frame and indicators on the real shell, and S12:
// the scene tool serialises a radio's checked state, so the rewards scene does not show two choices at once.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, say } from '../lib/refresh-ui.js';

const tool = await import('../tools/preview-scenes.mjs');
const sceneWorld = async (id) => {
    try { return await tool.sceneWorld('sections', id); } catch (e) { assert.fail(`no "sections" scene "${id}" in tools/preview-scenes.mjs: ${e.message}`); }
};
const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

describe('sections- preview scenes (the wallet page that updates itself)', () => {
    const common = (w) => {
        assert.ok(w.doc.querySelector('aside.sidebar .nav-item.active#nav-my-account'), 'My Account is not the active page');
        for (const id of ['wsec-head', 'wsec-summary', 'wsec-rewards', 'wallet-apr-card', 'wsec-recent-tx']) assert.ok(w.doc.getElementById(id), `no #${id}: not the real frame`);
        assert.ok(w.doc.querySelector('header.topbar #connect-wallet-btn.is-connected'), 'own account: the header is drawn connected');
    };
    test('send-included: the new balance with its wash at once, "Updating" on Recent Transactions only', async () => {
        const w = await sceneWorld('send-included');
        common(w);
        assert.ok(w.doc.querySelector('#wallet-total-value.is-value-changed'), 'the balance is not washed');
        assert.equal(t(w.doc.querySelector('#wsec-recent-tx .list-header .ui-chip.is-wait')), STRINGS.S1);
        assert.equal(w.doc.querySelector('#wsec-rewards .list-header .ui-chip'), null);
        assert.equal(w.doc.querySelector('#wallet-claimed-label .ui-chip'), null);
    });
    test('proxy-removed: the row says "Removed in block #N" and offers nothing', async () => {
        const w = await sceneWorld('proxy-removed');
        common(w);
        const chip = w.doc.querySelector('#wallet-proxy-list .ui-chip.is-positive');
        assert.ok(chip, 'no settled row');
        assert.match(t(chip), /^Removed in block #[\d,]+$/);
        assert.equal(chip.closest('tr').querySelector('.proxy-remove-btn'), null);
        assert.ok(w.doc.querySelector('#wallet-proxy-list .proxy-remove-btn.ui-action'), 'the other rows keep "Remove proxy"');
    });
    test('updating: the three cards carry "Updating" in the header, the Claimed Rewards tile the bare mark', async () => {
        const w = await sceneWorld('updating');
        common(w);
        for (const c of ['#wsec-recent-tx', '#wsec-rewards', '#wallet-apr-card']) assert.equal(t(w.doc.querySelector(`${c} .list-header .ui-chip.is-wait`)), STRINGS.S1, c);
        const mark = w.doc.querySelector('#wallet-claimed-label .ui-chip.is-wait.is-bare');
        assert.equal(t(mark), STRINGS.S1);
        assert.equal(w.doc.querySelectorAll('.ui-panel.is-warn.is-line').length, 0);
    });
    test('could-not-refresh: S11 and S12 first in each card, S14 on the tile, no chip', async () => {
        const w = await sceneWorld('could-not-refresh');
        common(w);
        for (const c of ['#wsec-recent-tx', '#wsec-rewards', '#wallet-apr-card']) {
            const line = w.doc.querySelector(`${c} > .ui-panel.is-warn.is-line`);
            assert.ok(line, `${c}: no line`);
            assert.ok(line.previousElementSibling.classList.contains('list-header'), `${c}: not the first line of the body`);
            assert.equal(t(line.querySelector('.gov-refresh-text')), STRINGS.S11);
            assert.equal(t(line.querySelector('button.validate-secondary')), STRINGS.S12);
            assert.equal(w.doc.querySelector(`${c} .list-header .ui-chip`), null, `${c}: a chip beside the line (U14)`);
        }
        const mark = w.doc.querySelector('#wallet-claimed-label .ui-chip.is-wait.is-bare');
        assert.equal(t(mark), STRINGS.S14);
        assert.ok(mark.querySelector('.bx-error'));
        assert.ok(t(w.doc.getElementById('post-action-live')).includes(say('A4', { 'Section name': 'Recent transactions' })));
    });
});

describe('S12: the scene tool writes a radio\'s checked state as the attribute', () => {
    // The scene is markup: a radio checked by a click after render carries no attribute, so the file showed the first
    // choice selected beside the field of the second (scene stake-advanced-rewards-other-account).
    test('formStateAsMarkup: the checked property becomes the attribute, on radios and checkboxes, and nowhere else', async () => {
        const { Window } = await import('happy-dom');
        const w = new Window();
        const doc = w.document;
        doc.body.innerHTML = '<input type="radio" name="p" value="staked" checked><input type="radio" name="p" value="account"><input type="checkbox" id="c"><input type="text" id="x" value="a">';
        doc.querySelector('input[value="account"]').checked = true;
        doc.getElementById('c').checked = true;
        assert.equal(typeof tool.formStateAsMarkup, 'function', 'the scene tool has no formStateAsMarkup');
        tool.formStateAsMarkup(doc);
        const html = doc.body.innerHTML;
        assert.ok(!/value="staked" checked/.test(html), `the old choice still says checked: ${html}`);
        assert.match(html, /<input type="radio" name="p" value="account" checked="">/);
        assert.match(html, /<input type="checkbox" id="c" checked="">/);
        assert.match(html, /<input type="text" id="x" value="a">/);
        await w.happyDOM.close();
    });
});
