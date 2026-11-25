// The preview scenes of the locked balances redesign (spec section 7: prefix locks-, 1280 and 375, dark, own
// account connected, primary 0). Each scene is built in-process through tools/preview-scenes.mjs sceneWorld and
// checked here: the panel is drawn, no primary, no table, no chain id outside Details, every button an action,
// and the state the scene is for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const sceneWorld = async (id) => (await import('../tools/preview-scenes.mjs')).sceneWorld('locks', id);
const NEED = {
    'ceo-case': '[data-lock-action="elections-remove"]', 'ready-withdraw': '[data-lock-action="withdraw"]', 'democracy-unlock-now': '[data-lock-action="democracy-unlock"]',
    'democracy-mixed': '[data-lock-action="democracy-cancel"]', 'democracy-tidy': '[data-lock-action="democracy-unlock"]', delegating: '[data-lock-action="democracy-undelegate"]',
    'leftover-lock': '[data-lock-action="migrate-currency"]', 'old-and-unknown': '[data-lock-group="rest"]', 'deposits-all': '.lock-children', vesting: '[data-lock-group="rest"]',
    empty: '.lock-empty', 'first-load': '.lock-skeleton', 'read-failed': '.lock-failed', 'looked-up': '.lock-connect', 'no-wallet': '.lock-connect',
    'controller-differs': '.lock-connect', 'fee-blocked': '.ui-panel.is-warn', 'confirm-open': '.lock-confirm', busy: '.ui-action[aria-busy="true"]',
    settled: '.lock-row.is-settled', 'changed-in-place': '.lock-row-msg.is-positive', checking: '.ui-chip.is-bare', failed: '.lock-row-msg[role="alert"]',
    'not-confirmed': '.lock-row-msg.is-wait', 'could-not-refresh': '.lock-behind'
};
const CHAIN_ID = /phrelect|Staking\.Staking|democrac\b|withdrawUnbonded|removeVoter|migrateCurrency|ormlvest|zzzzzzzz|Preimage\.Preimage|\.ProposalSubmission/;

describe('locks- preview scenes', () => {
    for (const [id, need] of Object.entries(NEED)) {
        test(`${id}: the panel, no primary, no table, no chain id outside Details, the scene's state`, async () => {
            const w = await sceneWorld(id);
            const panel = w.doc.querySelector('.page-section[data-page="wallet"] #wallet-locks-slot section.balance-locks');
            assert.ok(panel, 'the Balance breakdown panel');
            assert.equal(w.doc.querySelectorAll('.validate-primary, .wallet-option-row.is-primary').length, 0, 'no primary');
            assert.equal(panel.querySelectorAll('table, [role="table"]').length, 0);
            const shown = panel.cloneNode(true);
            for (const d of shown.querySelectorAll('details')) d.remove();
            assert.doesNotMatch(shown.textContent, CHAIN_ID);
            for (const b of panel.querySelectorAll('button')) assert.ok(['ui-action', 'validate-secondary', 'validate-text-btn'].some(c => b.classList.contains(c)), b.className);
            assert.ok(w.doc.querySelector(need), `the scene shows ${need}`);
        });
    }
    test('the CEO case says the right things at a glance', async () => {
        const w = await sceneWorld('ceo-case');
        const text = w.doc.querySelector('#wallet-locks-slot').textContent.replace(/\s+/g, ' ');
        assert.match(text, /Backs 5 candidates\. Removing the vote releases 15,000 PDEX and the 13\.59 PDEX deposit together\./);
        assert.match(text, /Until about 2026-12-16/);
        // His screenshot: hold and ledger total 17,348.0818, active 17,068.0232, one chunk of 280.0586 unlocking.
        const amount = (name) => { const li = Array.from(w.doc.querySelectorAll('#wallet-locks-slot li.lock-row')).find(x => x.querySelector('.lock-name').textContent.trim() === name); return li ? li.querySelector('.lock-amount').textContent.trim() : null; };
        assert.equal(amount('Staked'), '17,068.0232 PDEX');
        assert.equal(amount('Unstaking'), '280.0586 PDEX');
        assert.equal(amount('Council vote'), '15,000 PDEX');
        assert.match(text, /\+ also 13\.59 PDEX Voting deposit/);
        assert.ok(w.doc.querySelector('header.topbar #connect-wallet-btn.is-connected'), 'own account: header drawn connected');
    });
});
