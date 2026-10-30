// The stake picker's rows, filter bar and wiring (lib/stake-picker-view.js),
// plus the cross-file promises: signing untouched, the route cached and
// documented, the help article, the cookies entry, the script.js ceiling.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    validatorRowHtml, filterBarHtml, spreadNoteHtml, updateBar, readControl, loadPickerData,
    createStakePicker, showAllState, compactNumber, aprNoteText, CHOICE_URL, FALLBACK_URL, maxNominationsFrom
} from '../lib/stake-picker-view.js';
import { FALLBACK_MAX_NOMINATIONS } from '../lib/stake-choice-sync.js';
import { DEFAULT_FILTERS, RECOMMENDED_PRESET, STORAGE_KEY, selectedGroups } from '../lib/stake-filters.js';
import { escapeHtml } from '../lib/html-escape.js';
import { HELP_TOPICS } from '../lib/help-topics.js';
import { allRoutes, CACHE_TIERS } from '../lib/api-reference.js';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';

const esc = escapeHtml;
const shortAddress = a => String(a).slice(0, 4) + '..';
const EVIL = '<img src=x onerror=alert(1)>"\'&';

const row = (o = {}) => ({
    address: 'addr1', name: 'Node One', active: true, commission: 5, blocked: false, totalStake: 1234567,
    selfStake: 1500, exposureNominators: 12, backers: 12, identity: { hasIdentity: true, verified: true, parent: null },
    slashEras: [], commissionHistory: { note: 'held 5% for 30 eras', volatility: 'stable' },
    perf: { '28': { status: 'ok', apr: 16.43625, erasUsed: 28, electedEras: 28, reliability: 96.4, missedEras: 0 } }, ...o
});

describe('row html', () => {
    test('shows APR, commission, compact stake, self-stake, reliability, backers', () => {
        const h = validatorRowHtml(row(), { esc, shortAddress, window: 28 });
        assert.match(h, /APR 16\.44%/);
        assert.match(h, /5\.0% comm/);
        assert.match(h, /1\.23M PDEX/);
        assert.match(h, /self 1500/);
        assert.match(h, /96% reliable/);
        assert.match(h, /12 backers/);
        assert.match(h, /Not a guarantee/);
        assert.match(h, /data-addr="addr1"/);
    });
    test('new and none render words with an explanation, never a number', () => {
        const n = validatorRowHtml(row({ perf: { '28': { status: 'new', apr: null, electedEras: 3 } } }), { esc, shortAddress, window: 28 });
        assert.match(n, /APR new/);
        assert.match(n, /history for only 3 of the last 28 eras; 7 are needed/);
        const none = validatorRowHtml(row({ perf: null }), { esc, shortAddress, window: 28 });
        assert.match(none, /APR n\/a/);
    });
    test('badges: waiting, blocked, raise, slashed, same identity', () => {
        const h = validatorRowHtml(row({ active: false, blocked: true, slashEras: [5], commissionHistory: { pendingRaise: true } }),
            { esc, shortAddress, window: 28, sameIdentityAsPick: true });
        for (const b of ['WAITING', 'BLOCKED', 'RAISING NOW', 'SLASHED', 'SAME IDENTITY']) assert.ok(h.includes(b), b);
        assert.ok(!validatorRowHtml(row(), { esc, shortAddress, selected: true, sameIdentityAsPick: true }).includes('SAME IDENTITY'),
            'a pick is not flagged against itself');
    });
    test('selected rows get a disabled tick', () => {
        assert.match(validatorRowHtml(row(), { esc, shortAddress, selected: true }), /disabled aria-label="Already selected"/);
    });
    test('every chain-sourced string is escaped', () => {
        const h = validatorRowHtml(row({ name: EVIL, address: EVIL, commissionHistory: { note: EVIL } }), { esc, shortAddress, window: 28 });
        assert.ok(!h.includes('<img'), 'raw tag leaked');
        assert.ok(!/onerror=alert\(1\)>"/.test(h));
        assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
    });
    test('compact numbers', () => {
        assert.equal(compactNumber(1234567), '1.23M');
        assert.equal(compactNumber(45600), '45.6K');
        assert.equal(compactNumber(980), '980');
        assert.equal(compactNumber(1.5), '1.50');
        assert.equal(compactNumber('x'), 'n/a');
    });
});

describe('filter bar html', () => {
    test('one control per filter, the why tooltips, presets and the help link', () => {
        const h = filterBarHtml(DEFAULT_FILTERS, { esc, helpIcon: (slug) => `<a href="/help/${slug}">?</a>` });
        for (const k of ['maxCommission', 'noRecentRaise', 'identity', 'reliability', 'notBlocked', 'singlePage', 'noSlash', 'spread', 'minSelfStake', 'aprWindow', 'sort']) {
            assert.ok(h.includes(`data-f="${k}"`), k);
        }
        for (const k of ['maxCommission', 'noRecentRaise', 'identity', 'reliability', 'notBlocked', 'singlePage', 'noSlash', 'spread', 'minSelfStake']) {
            assert.ok(h.includes(`data-count-for="${k}"`), `count slot ${k}`);
        }
        assert.ok((h.match(/Why this matters:/g) || []).length >= 11);
        assert.match(h, /data-preset="recommended"[^>]*>Suggested filters</);
        assert.ok(!/>Recommended</.test(h), 'the chip no longer says Recommended');
        assert.match(h, /Room on one payout page \(at most 256 backers\)/);
        assert.match(h, /data-preset="all"/);
        assert.match(h, /href="\/help\/choosing-validators"/);
        assert.match(h, /<details class="stake-filter-more" open>/);
        assert.ok(!filterBarHtml(DEFAULT_FILTERS, { esc, open: false }).includes('stake-filter-more" open'), 'folded on phones');
    });
    test('a hostile stored state cannot reach the markup', () => {
        const h = filterBarHtml({ ...DEFAULT_FILTERS, maxCommission: '"><script>', sort: '<x>' }, { esc });
        assert.ok(!h.includes('<script>'));
        assert.ok(!h.includes('<x>'));
    });
    test('the APR note says it is history', () => {
        assert.match(aprNoteText(84), /last 84 completed eras.*Past rewards, not a guarantee/);
        assert.match(aprNoteText(28), /assumes every payout page is claimed/);
    });
    test('the APR tooltip says how many eras it averages and how many were in the active set', () => {
        const h = validatorRowHtml(row({ perf: { '28': { status: 'ok', apr: 4.1, erasUsed: 28, electedEras: 7, reliability: 100, missedEras: 0 } } }), { esc, shortAddress, window: 28 });
        assert.match(h, /Based on 28 eras, 7 of them in the active set/);
    });
});

describe('spread note', () => {
    test('names the shared identity, escaped, only when two or more picks share it', () => {
        const a = row({ address: 'p', name: EVIL + ' / one' });
        const b = row({ address: 's', identity: { hasIdentity: true, parent: 'p' } });
        const c = row({ address: 'o' });
        const byAddress = new Map([a, b, c].map(x => [x.address, x]));
        const html = spreadNoteHtml(selectedGroups(['p', 's', 'o'], byAddress), byAddress, { esc, shortAddress });
        assert.match(html, /share one on-chain identity/);
        assert.match(html, /\(2\)/);
        assert.ok(!html.includes('<img'));
        assert.equal(spreadNoteHtml(selectedGroups(['p', 'o'], byAddress), byAddress, { esc, shortAddress }), '');
    });
});

describe('controls', () => {
    const ctl = (key, o) => ({ getAttribute: (n) => (n === 'data-f' ? key : null), ...o });
    test('checkbox, range, number and select values land in the state, sanitized', () => {
        let s = { ...DEFAULT_FILTERS };
        s = readControl(s, ctl('spread', { type: 'checkbox', checked: true }));
        s = readControl(s, ctl('maxCommission', { type: 'range', value: '12' }));
        s = readControl(s, ctl('minSelfStake', { type: 'number', value: '-3' }));
        s = readControl(s, ctl('aprWindow', { type: 'select-one', value: '84' }));
        s = readControl(s, ctl('identity', { type: 'select-one', value: 'verified' }));
        assert.equal(s.spread, true);
        assert.equal(s.maxCommission, 12);
        assert.equal(s.minSelfStake, 0);
        assert.equal(s.aprWindow, 84);
        assert.equal(s.identity, 'verified');
        assert.deepEqual(readControl(s, ctl('__proto__', { value: 1 })), s, 'unknown key ignored');
    });
    test('Show all clears every filter but keeps window and sort', () => {
        const s = showAllState({ ...RECOMMENDED_PRESET, aprWindow: 7, sort: 'commission' });
        assert.equal(s.status, 'all');
        assert.equal(s.maxCommission, 100);
        assert.equal(s.spread, false);
        assert.equal(s.aprWindow, 7);
        assert.equal(s.sort, 'commission');
    });
});

describe('updateBar', () => {
    test('writes counts, status, slider label and note', () => {
        const els = {};
        const mk = (attrs) => ({ textContent: '', attrs, getAttribute: k => attrs[k], setAttribute(k, val) { attrs[k] = val; }, classList: { toggle(c, on) { attrs.on = on; } } });
        const countFor = mk({ 'data-count-for': 'maxCommission' });
        const statusCount = mk({ 'data-count-status': 'waiting' });
        const statusBtn = mk({ 'data-status': 'waiting' });
        els.shown = mk({}); els.out = mk({}); els.note = mk({});
        const bar = {
            querySelectorAll: (sel) => (sel === '[data-count-for]' ? [countFor] : sel === '[data-count-status]' ? [statusCount] : sel === '[data-status]' ? [statusBtn] : []),
            querySelector: (sel) => (sel === '[data-count-shown]' ? els.shown : sel === '[data-out="maxCommission"]' ? els.out : sel === '[data-apr-note]' ? els.note : null)
        };
        updateBar(bar, { ...DEFAULT_FILTERS, status: 'waiting', maxCommission: 100, aprWindow: 7 },
            { shown: 3, total: 9, hiddenBy: { maxCommission: 2 }, status: { active: 5, waiting: 3, all: 8 } });
        assert.equal(countFor.textContent, 'hides 2');
        assert.equal(statusCount.textContent, '(3)');
        assert.equal(statusBtn.attrs['aria-pressed'], 'true');
        assert.equal(els.shown.textContent, 'showing 3 of 9');
        assert.equal(els.out.textContent, 'any');
        assert.match(els.note.textContent, /last 7 completed eras/);
    });
});

describe('loadPickerData', () => {
    test('uses the snapshot when it has validators', async () => {
        const calls = [];
        const out = await loadPickerData(async (u) => { calls.push(u); return { validators: [{ address: 'a' }], activeEra: 9, exposurePageSize: 256 }; });
        assert.deepEqual(calls, [CHOICE_URL]);
        assert.equal(out.meta.full, true);
        assert.equal(out.meta.activeEra, 9);
    });
    test('falls back to /api/validators while the snapshot is initializing or failing', async () => {
        for (const first of [{ validators: [], status: 'Initializing' }, new Error('boom')]) {
            const calls = [];
            const out = await loadPickerData(async (u) => {
                calls.push(u);
                if (u === CHOICE_URL) { if (first instanceof Error) throw first; return first; }
                return { validators: [{ address: 'a', commission: 3 }], commissionHistoryEra: 4 };
            });
            assert.deepEqual(calls, [CHOICE_URL, FALLBACK_URL]);
            assert.equal(out.meta.full, false);
            assert.equal(out.validators[0].active, true);
        }
    });
});

describe('createStakePicker wiring (stub DOM)', () => {
    function stubEl() {
        const handlers = {};
        return {
            innerHTML: '', handlers,
            addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
            querySelectorAll: () => [], querySelector: () => null
        };
    }
    test('a filter change re-renders the list and persists, adds go through onAdd only', () => {
        const store = new Map();
        const storage = { getItem: k => store.get(k) ?? null, setItem: (k, val) => store.set(k, val) };
        const bar = stubEl(), list = stubEl(), note = stubEl();
        const added = [];
        const p = createStakePicker({ barEl: bar, listEl: list, noteEl: note, storage, escapeHtml: esc, shortAddress, helpIcon: () => '', onAdd: a => added.push(a) });
        p.setData({ validators: [row({ address: 'x1', commission: 5 }), row({ address: 'x2', commission: 50 })], meta: { full: true, activeEra: 100 } });
        assert.match(bar.innerHTML, /data-f="maxCommission"/);
        p.render('', new Map());
        assert.ok(list.innerHTML.includes('data-addr="x1"') && list.innerHTML.includes('data-addr="x2"'));
        const target = { getAttribute: n => (n === 'data-f' ? 'maxCommission' : null), type: 'range', value: '10' };
        bar.handlers.change[0]({ target });
        assert.ok(list.innerHTML.includes('data-addr="x1"'));
        assert.ok(!list.innerHTML.includes('data-addr="x2"'));
        assert.equal(JSON.parse(store.get(STORAGE_KEY)).maxCommission, 10);
        assert.deepEqual(added, []);
        const btn = { getAttribute: n => (n === 'data-preset' ? 'all' : null) };
        bar.handlers.click[0]({ target: { closest: () => btn } });
        assert.ok(list.innerHTML.includes('data-addr="x2"'), 'Show all brings it back');
    });
    test('works with no storage at all', () => {
        const p = createStakePicker({ barEl: null, listEl: stubEl(), noteEl: null, storage: null, escapeHtml: esc, shortAddress, helpIcon: () => '', onAdd: () => {} });
        p.setData({ validators: [], meta: {} });
        p.render('', new Map());
        assert.deepEqual(p.getState(), { ...DEFAULT_FILTERS });
    });
});

describe('nominations limit', () => {
    test('read from the snapshot meta', () => {
        const warns = [];
        assert.equal(maxNominationsFrom({ full: true, maxNominations: 24 }, { warn: (m) => warns.push(m) }), 24);
        assert.equal(warns.length, 0);
    });
    test('falls back to 16 with a warning when the snapshot has none', () => {
        for (const meta of [null, undefined, { full: false }, { maxNominations: 0 }, { maxNominations: 'x' }, { maxNominations: 2.5 }]) {
            const warns = [];
            assert.equal(maxNominationsFrom(meta, { warn: (m) => warns.push(m) }), 16);
            assert.equal(warns.length, 1, JSON.stringify(meta));
        }
        assert.equal(FALLBACK_MAX_NOMINATIONS, 16);
    });
});

describe('cross-file promises', () => {
    const script = readRepo('script.js', import.meta.url);
    const server = readRepo('server.js', import.meta.url);
    const html = readRepo('index.html', import.meta.url);

    test('script.js stays under the 15,000-line ceiling', () => {
        assert.ok(script.split('\n').length < 15000);
    });
    test('signing is untouched: submitStakeTx still nominates the Selected box through submitSignedTx', () => {
        const body = bodyOf(script, 'submitStakeTx');
        assert.match(body, /api\.tx\.staking\.nominate\(targets\)/);
        assert.match(body, /await submitSignedTx\(\{/);
        assert.match(body, /Array\.from\(stakeSelected\.keys\(\)\)/);
        assert.ok(!/stake-picker-view|createStakePicker/.test(body));
    });
    test('the stake modal takes the nominations limit from the snapshot, not a literal 16', () => {
        const code = stripComments(script);
        for (const fn of ['addStakeValidator', 'renderStakeSelected', 'submitStakeTx']) {
            const body = bodyOf(code, fn);
            assert.ok(!/\b16\b/.test(body), `${fn} still has a literal 16`);
            assert.match(body, /stakeMaxNominations\(\)/, fn);
        }
        assert.match(bodyOf(code, 'stakeMaxNominations'), /maxNominationsFrom\(validatorsCache && validatorsCache\.meta/);
    });
    test('the picker module never builds a transaction', () => {
        const lib = stripComments(readRepo('lib/stake-picker-view.js', import.meta.url));
        assert.ok(!/api\.tx|submitSignedTx|signAndSend/.test(lib));
    });
    test('script.js hands natives over wrapped, never detached', () => {
        const code = stripComments(script);
        assert.match(code, /loadPickerData\(async \(url\) => \(await fetch\(url\)\)\.json\(\)\)/);
        assert.match(code, /window\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
        assert.ok(!/matchMedia:\s*window\.matchMedia/.test(code));
    });
    test('the route is served from KV with an explicit short cache, and documented', () => {
        const code = stripComments(server);
        const at = code.indexOf("app.get('/api/staking/validator-choice'");
        assert.ok(at > 0);
        const handler = code.slice(at, code.indexOf('app.get(', at + 10));
        assert.match(handler, /cacheShort\(res\)/);
        assert.match(handler, /db\.getKv\('validator_choice'\)/);
        assert.ok(allRoutes().some(r => r.path === '/api/staking/validator-choice'));
        assert.ok(CACHE_TIERS.find(t => t.name === 'Short').routes.includes('/api/staking/validator-choice'));
    });
    test('the snapshot is built on the indexer path only (inside syncData)', () => {
        assert.match(bodyOf(server, 'syncData'), /await syncValidatorChoice\(activeEra\)/);
    });
    test('modal hooks, cookies entry, help article and sitemap', () => {
        assert.match(html, /id="stake-filter-bar"/);
        assert.match(html, /id="stake-spread-note"/);
        assert.ok(html.includes(STORAGE_KEY), 'the localStorage key is listed on /cookies');
        const topic = HELP_TOPICS.find(t => t.slug === 'choosing-validators');
        assert.ok(topic && topic.category === 'staking');
        assert.match(topic.body, /Past rewards, not a guarantee/);
        assert.match(server, /path: '\/help\/choosing-validators'/);
    });
    test('no em or en dashes in the new modules', () => {
        for (const f of ['lib/stake-apr.js', 'lib/stake-filters.js', 'lib/stake-picker-view.js', 'lib/stake-choice-sync.js']) {
            assert.ok(!/[–—]/.test(readRepo(f, import.meta.url)), f);
        }
    });
});
