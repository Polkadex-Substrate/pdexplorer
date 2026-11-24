// R6 cleanup guard (design cto-team/plans/2026-11-22-post-action-refresh-design.md, section 9 "R6"): no fixed
// refresh timers anywhere in script.js and lib/ after an action. A page follows an action on EVIDENCE (the
// core's subscriptions and its polls, lib/post-action.js), never on a fixed sleep such as the 2.5 s and 6 s
// timers R1 to R5 deleted.
//
// Every code line in script.js and lib/*.js that calls setTimeout must be on the allow list below, with its
// reason. A line that is not fails with the file, the line and the reason; when it drives a re-read or a
// re-render (fetch, refresh, reload, render, mount, load, repaint, recheck) the reason says it is a fixed
// refresh timer. An allow-list entry that matches nothing fails too, so the list cannot rot.
//
// An entry matches a setTimeout line when `has` matches the text of that line and the four after it, up to the
// next setTimeout line (so a multi-line callback is named by what it does, and never by its neighbour's text);
// `n` is how many such lines it may cover (default 1), so a second copy of an allowed timer is not allowed
// silently.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readRepo } from './helpers/source.js';

const REREAD = /\b(fetch\w*|refresh\w*|reload\w*|render\w*|mount\w*|load|repaint\w*|recheck\w*)\s*\(/;
const isComment = (l) => { const t = l.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };

// sources: [{ file, text }]. Returns the failure lines (empty when clean).
export function timerOffenders(sources, allow) {
    const used = allow.map(() => 0);
    const out = [];
    for (const { file, text } of sources) {
        const lines = String(text).split('\n');
        lines.forEach((line, i) => {
            if (isComment(line) || !/\bsetTimeout\b/.test(line)) return;
            // The line and the four after it, up to (not including) the next setTimeout line: a window never
            // borrows the next timer's text, so an allowed timer cannot hide the one above it.
            const next = lines.slice(i + 1, i + 5).findIndex(l => !isComment(l) && /\bsetTimeout\b/.test(l));
            const window = lines.slice(i, next === -1 ? i + 5 : i + 1 + next).filter(l => !isComment(l)).join('\n');
            const k = allow.findIndex((e, j) => e.file === file && e.has.test(window) && used[j] < (e.n || 1));
            if (k !== -1) { used[k]++; return; }
            const reason = REREAD.test(window)
                ? 'a fixed timer that drives a re-read or re-render: after an action, follow the evidence (postAction.notify or a subscription, design 2.5), never a fixed sleep'
                : 'a setTimeout that is not on the allow list: add it to test/no-refresh-timers.test.js with its reason if it is not a post-action refresh';
            out.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}  <- ${reason}`);
        });
    }
    allow.forEach((e, j) => { if (used[j] === 0) out.push(`allow-list entry for ${e.file} (${e.has}) matches no setTimeout line any more: remove it`); });
    return out;
}

// Each entry: why this timer is NOT a post-action refresh. Kinds: timeout (a read or a wallet that may never
// answer), ui (feedback that fades, focus after layout, a toast), debounce, retry (a load that waits for the
// indexer or a late wallet injection, never after an action), scheduler (the injected timer the evidence-driven
// core and the refresh views use for T1, T2 and backoff), catch-up (the live chain feed saw a change the server
// snapshot has not got yet: the governance catch-up the R4 review allowed), server (server-side lib).
export const ALLOW = [
    // script.js
    { file: 'script.js', has: /WS_HANDSHAKE_TIMEOUT/, why: 'timeout: the node handshake budget' },
    { file: 'script.js', has: /toast\.parentNode\.removeChild\(toast\)/, why: 'ui: the governance toast leaves after its fade' },
    { file: 'script.js', has: /setTimeout\(dismiss, 6000\)/, why: 'ui: the governance toast dismisses itself' },
    { file: 'script.js', has: /inp\.focus\(\), 80/, why: 'ui: focus after the modal paints' },
    { file: 'script.js', has: /validatorsFetched = false; fetchValidators\(\)/, why: 'retry: the validators list waits for the indexer to initialise (page load, not an action)' },
    { file: 'script.js', has: /holdersFetched = false; fetchHolders\(\)/, why: 'retry: the holders list waits for the indexer to initialise (page load, not an action)' },
    { file: 'script.js', has: /txFetched = false; fetchTransactions\(\)/, why: 'retry: the transactions list waits for the indexer to initialise (page load, not an action)' },
    { file: 'script.js', has: /errEl\.remove\(\)/, why: 'ui: a load error line fades' },
    { file: 'script.js', has: /blocksFetched = false; fetchBlocks\(\)/, why: 'retry: the blocks list waits for the indexer to initialise (page load, not an action)' },
    { file: 'script.js', has: /eventsFetched = false; fetchEvents\(\)/, why: 'retry: the events list waits for the indexer to initialise (page load, not an action)' },
    { file: 'script.js', has: /inputEl\.focus\(\)/, why: 'ui: the search box takes focus after layout' },
    { file: 'script.js', has: /helpSearchTimer = setTimeout/, why: 'debounce: help search while typing' },
    { file: 'script.js', has: /brand-swatch-hex/, why: 'ui: "copied!" on a brand swatch fades' },
    { file: 'script.js', has: /councilCatchup\[key\] = setTimeout/, why: 'catch-up: the live council feed saw a change the server snapshot lacks (8 s, allowed by the R4 review)' },
    { file: 'script.js', has: /\$\('cs-status'\)\.textContent = ''/, n: 2, why: 'ui: the call-search status line clears' },
    { file: 'script.js', has: /\$\('dec-status'\)\.textContent = ''/, n: 2, why: 'ui: the decoder status line clears' },
    { file: 'script.js', has: /element\.innerText = originalText/, why: 'ui: "copied!" fades' },
    { file: 'script.js', has: /statusEl\.textContent = ''; \}, 2500/, why: 'ui: the email preferences "Saved" line clears (no re-read)' },
    { file: 'script.js', has: /URL\.revokeObjectURL\(url\)/, why: 'ui: a CSV download URL is released' },
    { file: 'script.js', has: /fetchStakingRewards\(address, true\); \}, 6000/, why: 'retry: /staking-rewards polls only while the server says the unpaid list is still being computed (page load, max 12), not after an action' },
    { file: 'script.js', has: /setTimeout\(r, retryDelayMs\)/, why: 'retry: a wallet extension that injects late on mobile browsers' },
    { file: 'script.js', has: /Copy URL/, why: 'ui: the copy button label comes back' },
    { file: 'script.js', has: /_walletSigningRecheckTimer = setTimeout\(tick/, n: 2, why: 'retry: a wallet extension that injects after the dashboard painted (connect, not an action)' },
    { file: 'script.js', has: /createPostAction\(\{/, why: 'scheduler: the core\'s injected timer (backoff polls on evidence, design 2.5)' },
    { file: 'script.js', has: /createWalletSections\(\{/, why: 'scheduler: the wallet sections\' injected timer (T1, T2, the settle hold)' },
    { file: 'script.js', has: /createGovRefresh\(\{/, why: 'scheduler: the governance refresh views\' injected timer (T1, T2, polls on evidence)' },
    { file: 'script.js', has: /sendFeeDebounce = setTimeout/, why: 'debounce: the send fee estimate while typing' },
    { file: 'script.js', has: /toEl\.focus\(\)/, why: 'ui: focus after the send modal paints' },
    { file: 'script.js', has: /btn\.classList\.remove\('copied'\)/, why: 'ui: the copy button label comes back' },
    { file: 'script.js', has: /btn\.innerHTML = original; \}, 2600/, why: 'ui: the copy button label comes back' },
    { file: 'script.js', has: /params\.has\('tour'\)/, why: 'ui: the first-visit tour opens after the home page painted' },
    // lib/
    { file: 'lib/balance-locks-view.js', has: /opts\.setTimer/, why: 'scheduler: the locks panel\'s clock for T1, T2, T5 and the settle hold' },
    { file: 'lib/council-candidacy.js', has: /Reading your council role timed out/, why: 'timeout: a council role read' },
    { file: 'lib/democracy-view.js', has: /setTimeout: \(\.\.\.a\) => setTimeout/, why: 'scheduler: the timer wrappers the view is given' },
    { file: 'lib/democracy-view.js', has: /const later = /, why: 'catch-up: the live democracy feed saw a change the server snapshot lacks (allowed by the R4 review)' },
    { file: 'lib/discussion-links.js', has: /deps\.setTimeout \|\| setTimeout/, why: 'ui: the "Link copied" feedback clears' },
    { file: 'lib/fee-preflight.js', has: /timed out/, why: 'timeout: the fee preflight (money path, not touched)' },
    { file: 'lib/gov-detail-view.js', has: /setTimeout: \(\.\.\.a\) => setTimeout/, why: 'scheduler: the timer wrappers the view is given' },
    { file: 'lib/gov-detail-view.js', has: /refetch = T\.setTimeout/, why: 'catch-up: the item page\'s live feed saw a change the server snapshot lacks (8 s, allowed by the R4 review)' },
    { file: 'lib/gov-post-action.js', has: /setTimer = \(f, ms\) => setTimeout/, n: 2, why: 'scheduler: the governance views\' clock for T1 and T2' },
    { file: 'lib/gov-refresh.js', has: /const sleep = /, why: 'server: the governance sync runner\'s spacing' },
    { file: 'lib/identity-cache.js', has: /createIdentityResolver/, why: 'server: the identity read timeout' },
    { file: 'lib/identity-cache.js', has: /createDebouncedRefresher/, why: 'server: debounce of identity re-reads from chain events' },
    { file: 'lib/input-actions.js', has: /hintTimer = win\.setTimeout/, why: 'ui: a paste hint fades' },
    { file: 'lib/input-actions.js', has: /requestAnimationFrame/, why: 'ui: next-frame fallback' },
    { file: 'lib/json-rpc-client.js', has: /timed out/, why: 'timeout: one JSON-RPC call' },
    { file: 'lib/metadata-hash.js', has: /no metadata from the node/, why: 'timeout: the metadata read' },
    { file: 'lib/multisig-view.js', has: /setTimer = \(f, ms\) => setTimeout/, why: 'scheduler: the review\'s injected timer (head read timeout, settle hold)' },
    { file: 'lib/multisig-view.js', has: /timer = setTimeout\(\(\) => \{/, why: 'timeout: the pending list\'s head read' },
    { file: 'lib/scroll-reset.js', has: /const later = /, why: 'ui: scroll restore retry after layout' },
    { file: 'lib/telemetry-api.js', has: /HEAD_TIMEOUT_MS/, why: 'server: the telemetry head read timeout' },
    { file: 'lib/telemetry-reader.js', has: /setTimer = setTimeout/, why: 'server: the telemetry reader\'s reconnect timer' },
    { file: 'lib/telemetry-relay.js', has: /startTelemetryRelay/, why: 'server: the telemetry relay\'s timer' },
    { file: 'lib/tx-status-card.js', has: /dismissTxStatus/, why: 'ui: a finished status card dismisses itself' },
    { file: 'lib/tx-status-card.js', has: /pruneTimer = setTimeout/, why: 'ui: old status cards are pruned' },
    { file: 'lib/tx-submit.js', has: /const cut = setTimeout\(\(\) => resolve\(null\), ms\)/, why: 'timeout: a chain read inside the signing tracker (money path, not touched)' },
    { file: 'lib/tx-submit.js', has: /dogTimer = setTimeout/, why: 'timeout: the tracker\'s watchdog (money path, not touched)' },
    { file: 'lib/tx-submit.js', has: /HEADER_READ_MS/, why: 'timeout: the inclusion header read (money path, not touched)' },
    { file: 'lib/tx-submit.js', has: /PRE_INBLOCK_CAP_MS/, why: 'timeout: the pre-inclusion cap (money path, not touched)' },
    { file: 'lib/tx-submit.js', has: /FINALITY_CAP_MS/, why: 'timeout: the finality cap (money path, not touched)' },
    { file: 'lib/tx-submit.js', has: /SIGNING_CAP_MS/, why: 'timeout: the signing cap (money path, not touched)' },
    { file: 'lib/validator-manage-view.js', has: /setTimeout\(look, 25\)/, why: 'retry: waits for the node connection before the manage panel reads (bounded by apiWaitMs)' },
    { file: 'lib/validator-node-guide.js', has: /clip\.writeText/, why: 'ui: "Copied" feedback fades' },
    { file: 'lib/validator-setup-view.js', has: /setTimeout\(look, 25\)/, why: 'retry: waits for the node connection before the setup reads (bounded by apiWaitMs)' },
    { file: 'lib/validator-status-api.js', has: /getHeader\(\)/, why: 'timeout: the server\'s head read' },
    { file: 'lib/wallet-picker-view.js', has: /const wait = /, why: 'retry: wallet detection on a late injection' },
    { file: 'lib/wallet-picker-view.js', has: /const slow = setTimeout\(\(\) => \{\n/, why: 'ui: "still waiting" hint while a wallet popup is open' },
    { file: 'lib/wallet-picker-view.js', has: /Copy link/, why: 'ui: the copy button label comes back' },
    { file: 'lib/wallet-picker-view.js', has: /Still waiting\. Look for a/, why: 'ui: "still waiting" hint while a wallet popup is open' },
    { file: 'lib/walletconnect-signer.js', has: /TIMEOUT_TEXT/, why: 'timeout: the phone wallet never answered' },
    { file: 'lib/walletconnect-view.js', has: /Copy link/, why: 'ui: the copy button label comes back' }
];

const SOURCES = ['script.js', ...readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).sort().map(f => 'lib/' + f)]
    .map(file => ({ file, text: readRepo(file, import.meta.url) }));

describe('R6 guard: no fixed refresh timers after an action in script.js and lib/', () => {
    test('every setTimeout in script.js and lib/ is on the allow list with its reason, and every entry is still used', () => {
        const err = timerOffenders(SOURCES, ALLOW);
        assert.deepEqual(err, [], '\n' + err.join('\n'));
    });
    test('the scan is not vacuous: it sees the timers it allows (script.js and lib/)', () => {
        const seen = SOURCES.reduce((n, s) => n + s.text.split('\n').filter(l => !isComment(l) && /\bsetTimeout\b/.test(l)).length, 0);
        assert.ok(seen >= 70, `only ${seen} setTimeout lines seen`);
        assert.ok(ALLOW.every(e => typeof e.why === 'string' && e.why.length > 10), 'an entry has no reason');
    });
    test('self-test: a 2.5 s re-render after an action fails with the file, the line and the reason', () => {
        const src = 'async function labelSave() {\n    await save();\n    setTimeout(() => renderAccountLabelEditor(address), 2500);\n}';
        const err = timerOffenders([{ file: 'script.js', text: src }], []);
        assert.equal(err.length, 1, err.join('\n'));
        assert.match(err[0], /^script\.js:3: setTimeout\(\(\) => renderAccountLabelEditor\(address\), 2500\);  <- a fixed timer that drives a re-read or re-render/);
    });
    test('self-test: a timer that is not a refresh still has to be listed; a second copy of an allowed timer is not allowed', () => {
        const src = 'setTimeout(() => { el.textContent = ""; }, 1500);\nsetTimeout(dismiss, 6000);\nsetTimeout(dismiss, 6000);';
        const err = timerOffenders([{ file: 'script.js', text: src }], [{ file: 'script.js', has: /setTimeout\(dismiss, 6000\)/, why: 'ui' }]);
        assert.equal(err.length, 2, err.join('\n'));
        assert.match(err[0], /^script\.js:1: .*not on the allow list/);
        assert.match(err[1], /^script\.js:3: setTimeout\(dismiss, 6000\);  <- .*not on the allow list/);
    });
    test('self-test: a stale entry fails; comments are not code', () => {
        const err = timerOffenders([{ file: 'lib/x.js', text: '// setTimeout(() => fetchAll(), 2500)\n * setTimeout(reload, 1)' }], [{ file: 'lib/x.js', has: /gone/, why: 'ui: something' }]);
        assert.deepEqual(err, ['allow-list entry for lib/x.js (/gone/) matches no setTimeout line any more: remove it']);
    });
});
