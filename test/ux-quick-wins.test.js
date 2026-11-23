// The UX review's quick wins (cto-team/plans/2026-11-21-ux-review-recent-pages.md, section 4): copy cuts,
// renamed labels, a focus and a tap-target fix. One test per item or small group; the items that live in
// a view with its own test file are asserted there (Q8 to Q11 lock-texts, stale-unlock-plan and
// balance-locks; Q12 session-keys; Q17 and Q18 treasury-spend-motion; Q19 and Q20 treasury-payout;
// Q27 validator-rollout-s7). The strings come from the review verbatim, except where the code
// contradicts the review (Q1 reads the threshold from the code, Q22 leaves the council buttons alone).

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { classifyTarget, OFFLINE_PROGRESS } from '../lib/nomination-status.js';
import { successCopy } from '../lib/tx-status.js';
import { mountNodeGuide } from '../lib/validator-node-guide.js';
import { parseRules } from './helpers/css-rules.js';
import { stripComments } from './helpers/source.js';
import { escapeHtml } from '../lib/html-escape.js';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const INDEX = read('index.html');
const SCRIPT = read('script.js');
const CSS = read('styles.css');
const tgt = (over = {}) => ({ address: 'esm9mgCefMrQ2EbGGyMNXGAFA3vnRGDid7GheURpcFRTjyokX', name: null, intent: true, commission: 50_000_000, blocked: false, elected: true,
    inSession: true, heartbeat: true, blocks: 3, disabled: false, lastSlashEra: null, incidents: [], ...over });

describe('Q1: the not-seen-yet note names the real threshold', () => {
    test('85%, read from OFFLINE_PROGRESS, never 80%', () => {
        assert.equal(OFFLINE_PROGRESS, 0.85);
        const r = classifyTarget(tgt({ heartbeat: false, blocks: 0 }), { activeEra: 500, sessionProgress: 0.5, imOnline: true });
        assert.ok(r.flags.includes('not-seen-yet'));
        assert.ok(r.notes.includes('No heartbeat yet this session (normal before it is 85% through).'), r.notes.join('|'));
        assert.ok(!r.notes.some(n => /80%/.test(n)));
    });
});

describe('Q4: a validator that stopped validating says so', () => {
    test('the label is "Stopped validating", not "Chilled"', () => {
        const r = classifyTarget(tgt({ elected: false, intent: false, inSession: false, heartbeat: null, blocks: null }), { activeEra: 500, sessionProgress: 0.5, imOnline: true });
        assert.equal(r.state, 'not-validator');
        assert.equal(r.label, 'Stopped validating');
    });
});

describe('Q5, Q17, Q25: status-card copy without call names or the wrong page name', () => {
    test('Q5: after a vote, the unlock points at My Account', () => {
        const c = successCopy('democracy.vote', { ref: 4, aye: true, amount: '10', conviction: 'Locked1x', lockPeriodDays: 7 }, {});
        assert.equal(c.next, 'After the lock ends, open My Account, Balance breakdown, and press Remove votes and unlock.');
        assert.doesNotMatch(c.next, /democracy\.|wallet app/);
    });
    test('Q25: a recorded multisig approval says My Account, not My Accounts', () => {
        const c = successCopy('multisig.transaction', { kind: 'approve' }, { approvalRecorded: true });
        assert.match(c.body, /complete it from My Account\.$/);
        assert.doesNotMatch(c.body, /My Accounts/);
    });
});

describe('Q6, Q16, Q21, Q22: static copy in index.html', () => {
    test('Q6: the unstake modal intro says where the money goes next', () => {
        assert.ok(INDEX.includes('Start unbonding the amount below. It stays locked for the unbonding period, then you withdraw it here.'));
        assert.ok(!INDEX.includes('become withdrawable from your wallet extension'));
    });
    test('Q16: the spend modal intro creates a motion, no call name', () => {
        assert.ok(INDEX.includes('Creates a council motion. The spend is approved once enough members vote Aye.'));
        assert.ok(!INDEX.includes('Tables a council motion'));
    });
    test('Q21: Unstake, with the amount label tied to its input', () => {
        assert.ok(!INDEX.includes('Unstake (Unbond)'));
        assert.match(INDEX, /<h3[^>]*>Unstake <a href="\/help\/unstaking"/);
        assert.ok(INDEX.includes('<label class="stake-label" for="unstake-amount-input">Amount to unstake (PDEX)</label>'));
        assert.match(INDEX, /id="unstake-amount-input"/);
        assert.ok(!INDEX.includes('Amount to unbond'));
    });
    test('Q22: one spelling of the sign button, in the page and in the script that resets it', () => {
        for (const old of ['Sign &amp; table motion', 'Sign &amp; Submit<', 'Sign &amp; Pay Out', 'Sign &amp; Send', 'Sign &amp; Unstake']) assert.ok(!INDEX.includes(old), old);
        for (const t of ['Sign and table motion', 'Sign and stake', 'Sign and pay out', 'Sign and send', 'Sign and unstake']) assert.match(INDEX, new RegExp('>' + t + '<'), t);
        const code = stripComments(SCRIPT);
        for (const old of ["'Sign & Submit'", "'Sign & Pay Out'", "'Sign & Unstake'", "'Sign & Send'"]) assert.ok(!code.includes('idleText: ' + old), old);
        for (const t of ['Sign and stake', 'Sign and pay out', 'Sign and unstake', 'Sign and send']) assert.ok(code.includes(`idleText: '${t}'`), t);
        assert.ok(!stripComments(read('lib/treasury-spend-view.js')).includes('Sign & table motion'));
        assert.ok(read('lib/treasury-spend-view.js').includes("idleText: 'Sign and table motion'"));
    });
});

describe('Q23, Q33, Q34: My Account', () => {
    test('Q23: the heading without an identity is My Account', () => {
        assert.match(SCRIPT, /identity \? stakingEscapeHtml\(identity\) : 'My Account'/);
        assert.doesNotMatch(SCRIPT, /: 'Wallet Dashboard'/);
    });
    test('Q33: the action bar comes before the balance breakdown and the nominations', () => {
        const at = (id) => SCRIPT.indexOf(`id="${id}"`, SCRIPT.indexOf('root.innerHTML = `\n        <div class="list-container glass">\n            <div class="list-header">\n                <h2><i class=\'bx bx-wallet\''));
        assert.ok(at('wallet-actions-slot') > 0 && at('wallet-locks-slot') > 0 && at('wallet-nominations-slot') > 0);
        assert.ok(at('wallet-actions-slot') < at('wallet-locks-slot'), 'actions before the breakdown');
        assert.ok(at('wallet-actions-slot') < at('wallet-nominations-slot'), 'actions before the validators');
    });
    test('Q34: the network card is "Network staking" and no longer repeats Total Staked', () => {
        assert.ok(SCRIPT.includes('<div class="list-header"><h2>Network staking</h2></div>'));
        assert.ok(!SCRIPT.includes('<h2>Staking Overview</h2>'));
        assert.ok(!SCRIPT.includes('<div class="wallet-stat"><span>Total Staked</span>'));
        assert.ok(SCRIPT.includes('<div class="label">Total Staked</div>'), 'the summary card keeps the one Total Staked');
    });
});

describe('Q28: Copy confirms at the button that was pressed', () => {
    test('the pressed button reads Copied for 1.5 s, then Copy again; the line message stays', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const win = new Window();
        const el = win.document.createElement('div');
        win.document.body.appendChild(el);
        mountNodeGuide(el, { esc: escapeHtml, helpIcon: () => '', release: {}, fetchJson: async () => ({}), clipboard: { writeText: async () => {} } });
        const [first, second] = el.querySelectorAll('button[data-copy]');
        first.click();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        assert.match(first.textContent, /Copied/);
        assert.doesNotMatch(second.textContent, /Copied/, 'only the pressed button');
        assert.equal(el.querySelector('#node-guide-msg').textContent, 'Copied.');
        t.mock.timers.tick(1499);
        assert.match(first.textContent, /Copied/);
        t.mock.timers.tick(2);
        assert.doesNotMatch(first.textContent, /Copied/);
        assert.match(first.textContent, /Copy/);
    });
});

describe('Q35: phone tap targets', () => {
    test('under 768 px the secondary and text buttons are 44 px tall; the lock buttons (.ui-action) are 44 px at every width', () => {
        const rule = parseRules(CSS).find(r => /max-width:\s*768px/.test(r.media) && ['.validate-secondary', '.validate-text-btn'].every(s => r.selectors.includes(s)));
        assert.ok(rule, 'one rule in the 768 px query names the two classes');
        assert.equal(rule.decls['min-height'], '44px');
        const action = parseRules(CSS).filter(r => !r.media && r.selectors.includes('.ui-action') && 'min-height' in r.decls);
        assert.deepEqual(action.map(r => r.decls['min-height']), ['44px'], 'the balance breakdown buttons, outside any media query');
    });
});
