// R6 follow-up (Checker gap): test/no-refresh-timers.test.js covers setTimeout only, so a new fixed-interval
// poll (`setInterval(() => refreshX(), 5000)`) that re-reads a section could slip back in. A page follows an
// action on EVIDENCE (lib/post-action.js), never on a fixed-interval poll.
//
// Every code line in script.js and lib/*.js that calls setInterval must be on the INTERVALS list below, by name,
// with a one-line reason. Anything new fails with the file, the line and the reason; when it re-reads or
// re-renders (fetch, refresh, reload, render, mount, load, repaint, recheck) the message says it is a fixed
// poll. Aliases fail too: a `setInterval` that is not called on the spot (`const t = setInterval;`,
// `T.setInterval` handed around, `globalThis['setInterval']`, `window["set" + "Interval"]`). An entry that
// matches nothing fails, so the list cannot rot. Matching follows no-refresh-timers.test.js: `has` is matched
// against the setInterval line and the four after it, up to the next setInterval line; `n` is how many lines
// an entry may cover.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readRepo } from './helpers/source.js';

const REREAD = /\b(fetch\w*|refresh\w*|reload\w*|render\w*|mount\w*|load|repaint\w*|recheck\w*|poll\w*)\s*\(|\b(refresh\w*|poll\w*)\b/;
const isComment = (l) => { const t = l.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };
const MENTION = /\bsetInterval\b|['"`]set['"`]\s*\+\s*['"`]Interval|\[\s*['"`]setInt/;
const CALLED = /\bsetInterval\s*\(/;

export function intervalOffenders(sources, allow) {
    const used = allow.map(() => 0);
    const out = [];
    for (const { file, text } of sources) {
        const lines = String(text).split('\n');
        lines.forEach((line, i) => {
            if (isComment(line) || !MENTION.test(line)) return;
            const next = lines.slice(i + 1, i + 5).findIndex(l => !isComment(l) && MENTION.test(l));
            const window = lines.slice(i, next === -1 ? i + 5 : i + 1 + next).filter(l => !isComment(l)).join('\n');
            const k = allow.findIndex((e, j) => e.file === file && e.has.test(window) && used[j] < (e.n || 1));
            if (k !== -1) { used[k]++; return; }
            const alias = !CALLED.test(line);
            const reason = alias
                ? 'an alias or computed reference to setInterval: call it directly so the guard can see what it drives, or list it with its reason'
                : REREAD.test(window)
                    ? 'a fixed-interval poll that re-reads or re-renders: follow the evidence (postAction.notify or a subscription), never a fixed poll; if it is not after an action, list it in test/no-refresh-intervals.test.js with its reason'
                    : 'a setInterval that is not on the list: add it to test/no-refresh-intervals.test.js with its reason if it is not a re-read';
            out.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}  <- ${reason}`);
        });
    }
    allow.forEach((e, j) => { if (used[j] === 0) out.push(`interval list entry for ${e.file} (${e.has}) matches no setInterval line any more: remove it`); });
    return out;
}

// Each entry: why this interval is NOT a post-action refresh. None follows a wallet action; each is a page-level
// live feed or a decoration, and none runs for a wallet section the evidence core owns.
export const INTERVALS = [
    { file: 'script.js', has: /setInterval\(refreshRecentViews, RECENT_REFRESH_MS\)/, why: 'feed: the public home, blocks, transactions and events lists re-read every 12 s (chain data for everyone, not a wallet section)' },
    { file: 'script.js', has: /governancePollTimer = setInterval\(pollGovernanceLatest/, why: 'feed: the home governance banner polls /api/governance/latest every 60 s' },
    { file: 'script.js', has: /councilPollTimer = setInterval/, why: 'feed: the council page polls its lists every 30 s while the tab is visible (page load poll, not after an action)' },
    { file: 'script.js', has: /priceTickerTimer = setInterval\(pollPriceTicker/, why: 'feed: the sidebar PDEX price ticker, 60 s' },
    { file: 'script.js', has: /const timer = setInterval\(\(\) => \{\n\s*if \(idx >= steps\.length - 1\)/, why: 'ui: the wallet loading screen steps through its labels (reads nothing)' },
    { file: 'script.js', has: /^setInterval\(\(\) => \{\n\s*renderBlocks\(\);/, why: 'clock: re-renders the live blocks and transactions feed from memory every 10 s so relative ages tick (no fetch)' },
    { file: 'lib/democracy-view.js', has: /setInterval: \(\.\.\.a\) => setInterval\(\.\.\.a\)/, why: 'scheduler: the timer wrappers the view is given (tests inject fakes)' },
    { file: 'lib/democracy-view.js', has: /poll = T\.setInterval/, why: 'feed: the referenda page polls every 30 s while visible, quiet, the live-feed catch-up the R4 review allowed (page load, not an action)' },
    { file: 'lib/gov-detail-view.js', has: /setInterval: \(\.\.\.a\) => setInterval\(\.\.\.a\)/, why: 'scheduler: the timer wrappers the view is given (tests inject fakes)' },
    { file: 'lib/gov-detail-view.js', has: /poll = T\.setInterval/, why: 'feed: the item page polls every 30 s while visible, quiet (page load, not an action)' }
];

const SOURCES = ['script.js', ...readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).sort().map(f => 'lib/' + f)]
    .map(file => ({ file, text: readRepo(file, import.meta.url) }));

describe('R6 guard: no fixed-interval re-read polls in script.js and lib/ beyond the named feeds', () => {
    test('every setInterval in script.js and lib/ is on the list with its reason, and every entry is still used', () => {
        const err = intervalOffenders(SOURCES, INTERVALS);
        assert.deepEqual(err, [], '\n' + err.join('\n'));
    });
    test('the scan is not vacuous: it sees the intervals it lists', () => {
        const seen = SOURCES.reduce((n, s) => n + s.text.split('\n').filter(l => !isComment(l) && MENTION.test(l)).length, 0);
        assert.ok(seen >= INTERVALS.length, `only ${seen} setInterval lines seen`);
        assert.ok(INTERVALS.every(e => typeof e.why === 'string' && e.why.length > 10), 'an entry has no reason');
    });
    test('self-test: a fixed 5 s re-read poll fails with the file, the line and the reason', () => {
        const err = intervalOffenders([{ file: 'script.js', text: 'function x() {\n    setInterval(() => refreshAccountSection(address), 5000);\n}' }], []);
        assert.equal(err.length, 1, err.join('\n'));
        assert.match(err[0], /^script\.js:2: setInterval\(\(\) => refreshAccountSection\(address\), 5000\);  <- a fixed-interval poll that re-reads or re-renders/);
    });
    test('self-test: an unlisted non-refresh interval, an alias and a computed reference fail; a stale entry fails; comments are not code', () => {
        const src = [
            'setInterval(() => { tick++; }, 1000);',
            'const si = setInterval;',
            "globalThis['setInterval'](() => fetchAll(), 3000);",
            '// setInterval(() => refreshAll(), 1)'
        ].join('\n');
        const err = intervalOffenders([{ file: 'lib/x.js', text: src }], [{ file: 'lib/x.js', has: /gone/, why: 'feed: gone' }]);
        assert.equal(err.length, 4, err.join('\n'));
        assert.match(err[0], /^lib\/x\.js:1: .*not on the list/);
        assert.match(err[1], /^lib\/x\.js:2: .*alias or computed reference/);
        assert.match(err[2], /^lib\/x\.js:3: .*alias or computed reference/);
        assert.match(err[3], /interval list entry for lib\/x\.js .* matches no setInterval line any more/);
    });
    test('self-test: a second copy of a listed interval is not allowed silently', () => {
        const src = 'setInterval(tick, 1000);\nsetInterval(tick, 1000);';
        const err = intervalOffenders([{ file: 'script.js', text: src }], [{ file: 'script.js', has: /setInterval\(tick/, why: 'clock: a clock' }]);
        assert.equal(err.length, 1, err.join('\n'));
        assert.match(err[0], /^script\.js:2:/);
    });
});
