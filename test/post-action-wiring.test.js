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
        // F2: never more than the modal lists: the signable pairs intersected with the rows shown.
        assert.match(submit, /const entries = payoutSignSet\(payoutRefresh\.signable\(data\), Array\.from\(document\.querySelectorAll\('#payout-entries \.payout-entry\[data-key\]'\)\)\.map\(r => r\.getAttribute\('data-key'\)\)\);/);
        assert.match(submit, /account: data\.address, pairs: batch\.map\(e => \(\{ era: e\.era, validator: e\.validator \}\)\)/);
        assert.ok(!/unpaidEntries/.test(submit), 'the submit reads the raw server list');
    });
    test('the dashboard (live render and the saved snapshot paint) and the action-bar swap draw the tile and button from the module', () => {
        // R3: the frame is drawn by lib/wallet-sections.js, whose summary takes the tile from the payout part (the
        // walletSections line hands it payoutRefresh), and the one action bar copy takes the button from it.
        const render = body('function renderWalletDashboard(');
        assert.match(render, /walletSections\.frameHtml\(data, /);
        assert.match(render, /buildWalletActionBarMarkup\(data\)/);
        assert.match(render, /payoutRefresh\.paint\(\{ reason: 'render' \}\);/);
        assert.match(code, /createWalletSections\(\{[^\n]*payout: payoutRefresh/);
        assert.match(stripComments(readRepo('lib/wallet-sections.js', import.meta.url)), /payout\.tileHtml\(data\)/);
        assert.match(body('function buildWalletActionBarMarkup('), /payoutButton: payoutRefresh\.buttonHtml\(data\)/);
        assert.ok(!/id="wallet-act-payout"/.test(code), 'a second copy of the payout button markup is left in script.js');
        assert.match(body('async function fetchWalletDashboard('), /renderWalletDashboard\(cached\.wallet/);
    });
    test('the page catches up on return to the tab', () => {
        assert.match(code, /visibilitychange', \(\) => \{ if \(document\.visibilityState === 'visible'\) postAction\.resume\(\); \}\);/);
    });
    test('the cookie notice lists the new storage key, in the reviewer\'s words', () => {
        const html = readRepo('index.html', import.meta.url);
        assert.match(html, /<code[^>]*>pdex_known_results<\/code>/);
        const row = html.slice(html.indexOf('>pdex_known_results<'), html.indexOf('</tr>', html.indexOf('>pdex_known_results<')));
        assert.ok(row.includes('<td style="padding: 10px 12px;">For a rewards payout you sent in the last 10 minutes: which reward entries (era and validator) it paid or is still checking, with your account address, the block number and the transaction hash.</td>'), 'the What column is not the reviewer text');
        assert.ok(row.includes('<td style="padding: 10px 12px;">So a reward that is already paid is not offered to you again, after a reload or in another tab, while the explorer catches up with the chain. Expires after 10 minutes.</td>'), 'the Why column is not the reviewer text');
    });
    test('F4: the store is scoped to the connected chain\'s genesis; the link coming up prunes and repaints', () => {
        assert.match(code, /createKnownResults\(\{[^\n]*genesis: \(\) => \(globalApi && globalApi\.genesisHash \? globalApi\.genesisHash\.toHex\(\) : null\)/);
        assert.match(body('function adoptChainApi('), /knownResults\.prune\(\); postAction\.resume\(\);/);
    });
    test('F8: the reload after an action keeps the page (no saved-snapshot paint, no banner flash)', () => {
        assert.match(body('function refreshWalletDashboardFor('), /fetchWalletDashboard\(address, \{ keepPage: true \}\);/);
    });
    test('F3: an aria-disabled action button looks and hovers like a disabled one', async () => {
        const { parseRules } = await import('./helpers/css-rules.js');
        const rules = parseRules(readRepo('styles.css', import.meta.url));
        const grey = rules.find(r => r.selectors.includes('.wallet-action-btn:disabled'));
        assert.ok(grey, 'no :disabled rule');
        assert.ok(grey.selectors.includes('.wallet-action-btn[aria-disabled="true"]'), 'aria-disabled is not greyed');
        assert.equal(grey.decls.opacity, '0.45');
        assert.equal(grey.decls.cursor, 'not-allowed');
        const hover = rules.filter(r => r.selectors.some(x => /^\.wallet-action-btn(\.primary)?:hover/.test(x)));
        assert.ok(hover.length >= 2);
        for (const r of hover) for (const x of r.selectors) assert.match(x, /:not\(\[aria-disabled="true"\]\)/, 'hover still lights an aria-disabled button: ' + x);
    });
    test('script.js stays under its ceiling and within the R1 budget (+19 over 14,713)', () => {
        const n = SCRIPT.split('\n').length;
        assert.ok(n <= 15000, 'script.js lines: ' + n);
        assert.ok(n <= 14713 + 19 + 1, 'over the R1 budget: ' + n);
    });
});
