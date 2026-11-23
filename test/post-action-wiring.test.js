// R1 wiring in script.js (design 2.1, 4 "Pay again" and "Reload during the lag window", section 7 budget):
// the payout modal and the submit read the list through the known results, the dashboard (live and
// snapshot paint) draws the tile and the button from the module, and script.js stays under its ceiling.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const code = stripComments(SCRIPT);
const body = (sig) => { const i = code.indexOf(sig); assert.ok(i >= 0, 'no ' + sig); const j = code.indexOf('\n}\n', i); return code.slice(i, j); };

describe('R1 wiring', () => {
    test('the core, the store and the payout view are created once, with the storage event and the address rule', () => {
        assert.match(code, /from '\.\/lib\/post-action\.js'/);
        assert.match(code, /from '\.\/lib\/known-results\.js'/);
        assert.match(code, /from '\.\/lib\/action-effects\.js'/);
        assert.match(code, /from '\.\/lib\/payout-refresh\.js'/);
        assert.equal((code.match(/createKnownResults\(\{/g) || []).length, 1);
        assert.equal((code.match(/createPostAction\(\{/g) || []).length, 1);
        assert.equal((code.match(/createPayoutRefresh\(\{/g) || []).length, 1);
        assert.match(code, /createKnownResults\(\{[^\n]*same: isSameAddress[^\n]*addEventListener\('storage'/);
    });
    test('openPayoutModal lists only what may be signed and does nothing while entries are checked or paid', () => {
        const open = body('function openPayoutModal(');
        assert.match(open, /payoutRefresh\.model\(data\)/);
        assert.match(open, /const entries = m\.payable;/);
        assert.match(open, /payoutRefresh\.rowsHtml\(entries\)/);
        assert.match(open, /payoutRefresh\.modalLine\(m\)/);
        assert.ok(!/unpaidEntries/.test(open), 'the modal reads the raw server list');
    });
    test('submitPayoutTx signs only signable pairs and hands the batch pairs and the account to the effects', () => {
        const submit = body('async function submitPayoutTx(');
        assert.match(submit, /const entries = payoutRefresh\.signable\(data\);/);
        assert.match(submit, /account: data\.address, pairs: batch\.map\(e => \(\{ era: e\.era, validator: e\.validator \}\)\)/);
        assert.ok(!/unpaidEntries/.test(submit), 'the submit reads the raw server list');
    });
    test('the dashboard (live render and the saved snapshot paint) and the action-bar swap draw the tile and button from the module', () => {
        const render = body('function renderWalletDashboard(');
        assert.match(render, /\$\{payoutRefresh\.tileHtml\(data\)\}/);
        assert.match(render, /\$\{payoutRefresh\.buttonHtml\(data\)\}/);
        assert.match(render, /payoutRefresh\.paint\(\{ reason: 'render' \}\);/);
        assert.match(body('function buildWalletActionBarMarkup('), /\$\{payoutRefresh\.buttonHtml\(data\)\}/);
        assert.ok(!/id="wallet-act-payout"/.test(code), 'a second copy of the payout button markup is left in script.js');
        assert.match(body('async function fetchWalletDashboard('), /renderWalletDashboard\(cached\.wallet/);
    });
    test('the page catches up on return to the tab', () => {
        assert.match(code, /visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) postAction\.resume\(\); \}\);/);
    });
    test('the cookie notice lists the new storage key', () => {
        assert.match(readRepo('index.html', import.meta.url), /<code[^>]*>pdex_known_results<\/code>/);
    });
    test('script.js stays under its ceiling and within the R1 budget (+19 over 14,713)', () => {
        const n = SCRIPT.split('\n').length;
        assert.ok(n <= 15000, 'script.js lines: ' + n);
        assert.ok(n <= 14713 + 19 + 1, 'over the R1 budget: ' + n);
    });
});
