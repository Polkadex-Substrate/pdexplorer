// The remaining charts (price page, validator, wallet price, democracy, analytics) update in place, like the staking-rewards bars.
// CEO, 23 Nov: "update the remaining charts with the same logic". Every chart function below is the REAL one lifted from script.js
// and driven over a happy-dom page with a FAKE Chart that records construction, update and destroy (test/staking-rewards-chart.test.js
// does the same for the rewards bars). The declarations a chart owns are lifted in whichever form the source has them: the old
// `let xChart = null;` or the new slot (`const xSlot = newChartSlot();`), so the same file runs on both sides of the fix.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { readRepo, bodyOf } from './helpers/source.js';
import * as chartUpdate from '../lib/chart-update.js';
import { REFRESH_UI } from '../lib/refresh-ui.js';
import { escapeHtml } from '../lib/html-escape.js';
// The price card's empty sentence is one constant (fidelity review 2026-11-24, R1); undefined before it.
const { PRICE_COLLECTING } = await import('../lib/wallet-sections.js');
import { formatNominatorApy, nominatorApyCaption } from '../lib/nominator-apy.js';

const chartConfigs = await import('../lib/chart-configs.js').catch(() => ({}));
const SCRIPT = readRepo('script.js', import.meta.url);
const has = (src) => SCRIPT.includes(src);
const lineOf = (start) => { const i = SCRIPT.indexOf(start); return i < 0 ? '' : SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
const fn = (name, prefix = '') => (has('function ' + name + '(') ? prefix + bodyOf(SCRIPT, name) : '');
const EASE = { duration: REFRESH_UI.collapseMs };
const ADDR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ADDR2 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

function world({ reduced = false } = {}) {
    const win = new Window({ url: 'https://explorer.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    win.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this }; };
    win.matchMedia = (q) => ({ matches: reduced && /reduce/.test(q), media: q });
    const log = { made: [], updates: [], destroyed: [], collisions: 0, democracyRenders: 0 };
    const live = new Set();
    class FakeChart {
        constructor(ctx, cfg) {
            this.canvas = ctx.canvas || ctx; this.config = cfg; this.data = cfg.data; this.options = cfg.options;
            if ([...live].some(c => c.canvas === this.canvas)) log.collisions++;
            live.add(this); log.made.push(this);
        }
        update(mode) { log.updates.push({ chart: this, mode, animation: this.options.animation, labels: [...this.data.labels], data: this.data.datasets.map(d => [...d.data]) }); }
        destroy() { live.delete(this); log.destroyed.push(this); }
    }
    const ctx = {
        console, Promise, Object, JSON, Array, Map, Set, String, Number, Math, Date, encodeURIComponent, Error, isFinite: Number.isFinite,
        window: win, document: doc, Chart: FakeChart, ...chartUpdate, ...chartConfigs, REFRESH_UI, PRICE_COLLECTING,
        formatNominatorApy, nominatorApyCaption, stakingEscapeHtml: escapeHtml, stakingFormatPDEX: (v) => String(v), stakingFormatNumber: (v) => String(v),
        updateSeoMeta() {}, formatLocalDateTime: () => 'now', watchlistStarButton: () => '', renderValidatorScorecard: () => '', mountValidatorManageLink() {}, copyToClipboard() {},
        renderApiError: (c, e) => { c.textContent = 'ERR ' + e.message; },
        fetchApiJson: (...a) => ctx.__fetch(...a), parseJsonResponse: async (r) => r.body,
        renderDemocracy() { log.democracyRenders++; }, democracyView: { fetchRest: async () => ctx.__res, update() {}, data: () => null },
        PRICE_PERIODS: [{ days: 7, label: '7D' }, { days: 30, label: '30D' }],
        closeDetailView() {}, formatLocalDate: (t) => String(t)
    };
    win.Chart = FakeChart;   // the analytics draw helpers ask window.Chart
    vm.createContext(ctx);
    vm.runInContext([
        lineOf('let pricePageChart = null;'), lineOf('const pricePageSlot = newChartSlot();'), "let pricePagePeriodDays = 30;",
        lineOf('let validatorChart = null;'), lineOf('const validatorChartSlot = newChartSlot();'),
        lineOf('let walletPriceChart = null;'), lineOf('const walletPriceSlot = newChartSlot();'), 'let currentWalletData = null;',
        lineOf('let democracyVoteChart = null;'), lineOf('let democracyTurnoutChart = null;'), lineOf('let democracyTurnoutPctChart = null;'),
        lineOf('const democracySlots = '), "let democracyData = null;", "let democracyTab = 'statistics';",
        lineOf('let analyticsChartHandles = {};'), lineOf('const analyticsSlots = {};'), 'let analyticsRangeDays = 30;',
        lineOf('let routeGeneration = 0;'),
        fn('drawChart'), fn('releasePageCharts'),
        fn('renderPricePageChart'), fn('renderValidatorChart'), fn('fetchValidatorDetails', 'async '),
        fn('renderWalletPriceChart'), fn('repaintWalletPriceCard'),
        fn('renderDemocracyCharts'), fn('fetchDemocracyData', 'async '),
        fn('drawAnalyticsChart'), fn('drawAnalyticsBarChart'), fn('drawAnalyticsLineChart'), fn('analyticsChartOptions'),
        `globalThis.__s = {
            setPeriod: (d) => { pricePagePeriodDays = d; }, setWallet: (a) => { currentWalletData = a ? { address: a } : null; }, setRange: (d) => { analyticsRangeDays = d; },
            setDemocracy: (d) => { democracyData = d; }, price: (h) => renderPricePageChart(h), wallet: (p) => repaintWalletPriceCard(p),
            dem: (d) => renderDemocracyCharts(d), validator: (a) => fetchValidatorDetails(a), pollDemocracy: () => fetchDemocracyData({ quiet: true }), fetchDemocracy: () => fetchDemocracyData(),
            bar: (id, s) => drawAnalyticsBarChart(id, s, 'Transactions', '#e6007a'), line: (id, s) => drawAnalyticsLineChart(id, s, 'USD', '#f5a623'),
            release: () => releasePageCharts(), leave: () => { routeGeneration++; releasePageCharts(); }
        };`
    ].filter(Boolean).join('\n'), ctx);
    return { win, doc, ctx, log, live, s: ctx.__s };
}

const hist = (n, price) => Array.from({ length: n }, (_, i) => ({ timestamp: Date.UTC(2026, 10, 1 + i), price: price + i * 0.01 }));
const series = (n, v) => Array.from({ length: n }, (_, i) => ({ day: '2026-11-' + String(i + 1).padStart(2, '0'), value: v + i }));
const refs = (n, ayes) => Array.from({ length: n }, (_, i) => ({ refIndex: i, tallyKnown: true, ayes: ayes + i, nays: 1 + i, turnout: 10 + ayes + i, status: 'Ongoing' }));
const vdata = (address, scale) => ({ address, controller: ADDR2, identity: 'Unknown', triggers: [], scorecard: null, history: Array.from({ length: 6 }, (_, i) => ({ era: 600 - i, commission: 5 * scale, apy: 10 + i, stake: 1000 })) });

// One driver per chart. draw(w, data, subject) paints it the way its page does; n is how many Chart.js charts one draw makes.
// inPlace: the canvas survives a change of data (false for the validator page, whose one template repaints the card).
const CHARTS = [
    {
        name: 'price page chart', n: 1, inPlace: true, tooltip: true, subjects: [30, 7],
        html: '<canvas id="price-page-chart"></canvas>', data: (v) => hist(5, v ? 2 : 1),
        draw: async (w, d, subject) => { w.s.setPeriod(subject); w.s.price(d); }, canvases: (w) => [w.doc.getElementById('price-page-chart')]
    },
    {
        name: 'validator era chart', n: 1, inPlace: false, tooltip: false, subjects: [ADDR, ADDR2],
        html: '<div id="validator-details-container"></div>', data: (v, subject) => vdata(subject, v ? 2 : 1),
        draw: async (w, d, subject) => { w.ctx.__fetch = async () => d; await w.s.validator(subject); }, canvases: (w) => [w.doc.getElementById('validatorChartCanvas')]
    },
    {
        name: 'wallet price chart', n: 1, inPlace: true, tooltip: true, subjects: [ADDR, ADDR2],
        html: '<div id="wallet-price-chart-wrap"><canvas id="wallet-price-chart"></canvas></div>', data: (v) => ({ history: hist(5, v ? 2 : 1), configured: true }),
        draw: async (w, d, subject) => { w.s.setWallet(subject); w.s.wallet(d); }, canvases: (w) => [w.doc.getElementById('wallet-price-chart')]
    },
    {
        name: 'democracy charts (three)', n: 3, inPlace: true, tooltip: true, subjects: [null, 'other'],
        html: '<canvas id="dem-vote-chart"></canvas><canvas id="dem-turnout-chart"></canvas><canvas id="dem-turnoutpct-chart"></canvas>', data: (v) => ({ referenda: refs(4, v ? 50 : 5), totalIssuance: 1000 }),
        draw: async (w, d, subject) => { w.s.dem(d); }, canvases: (w) => ['dem-vote-chart', 'dem-turnout-chart', 'dem-turnoutpct-chart'].map(id => w.doc.getElementById(id)),
        noSubject: true
    },
    {
        name: 'analytics charts (bar and line)', n: 2, inPlace: true, tooltip: true, subjects: [30, 90],
        html: '<canvas id="analytics-chart-tx-count"></canvas><canvas id="analytics-chart-price"></canvas>', data: (v) => series(5, v ? 20 : 3),
        draw: async (w, d, subject) => { w.s.setRange(subject); w.s.bar('analytics-chart-tx-count', d); w.s.line('analytics-chart-price', d); }, canvases: (w) => ['analytics-chart-tx-count', 'analytics-chart-price'].map(id => w.doc.getElementById(id))
    }
];

for (const c of CHARTS) {
    const data = (v, subject) => c.data(v, subject == null ? c.subjects[0] : subject);
    const start = async (opts) => { const w = world(opts); w.doc.body.innerHTML = c.html; return w; };
    const rows = (w) => w.log.made.length;

    describe('in place: ' + c.name, () => {
        test('REPRODUCTION rule 1: the same data arriving again builds each chart once and never destroys or updates it', async () => {
            const w = await start();
            await c.draw(w, data(0), c.subjects[0]);
            const canvases = c.canvases(w);
            for (let i = 0; i < 3; i++) await c.draw(w, data(0), c.subjects[0]);
            assert.equal(rows(w), c.n, 'charts constructed');
            assert.equal(w.log.destroyed.length, 0, 'charts destroyed');
            assert.equal(w.log.updates.length, 0, 'update calls for identical data');
            c.canvases(w).forEach((cv, i) => assert.ok(cv === canvases[i] && cv.isConnected, 'canvas replaced'));
        });

        test('rule 3: first paint uses the short ease, not the library entrance', async () => {
            const w = await start();
            await c.draw(w, data(0), c.subjects[0]);
            assert.equal(rows(w), c.n);
            w.log.made.forEach(ch => assert.deepEqual(ch.options.animation, EASE));
        });

        test('rule 2: changed data ' + (c.inPlace ? 'keeps the instances and canvases; one update each, no destroy' : 'repaints the card: the old chart is destroyed before the new one is built, short ease'), async () => {
            const w = await start();
            await c.draw(w, data(0), c.subjects[0]);
            const before = [...w.log.made], canvases = c.canvases(w);
            await c.draw(w, data(1), c.subjects[0]);
            if (c.inPlace) {
                assert.equal(rows(w), c.n, 'chart rebuilt');
                assert.equal(w.log.destroyed.length, 0, 'chart destroyed');
                assert.equal(w.log.updates.length, c.n, 'one update per chart');
                c.canvases(w).forEach((cv, i) => assert.ok(cv === canvases[i], 'canvas replaced'));
                w.log.updates.forEach(u => { assert.deepEqual(u.animation, EASE, 'one short ease'); assert.ok(before.includes(u.chart), 'a new instance'); });
            } else {
                assert.equal(rows(w), 2 * c.n); assert.equal(w.log.destroyed.length, c.n); assert.equal(w.log.collisions, 0);
                assert.deepEqual(w.log.made[c.n].options.animation, EASE);
            }
            assert.equal(w.live.size, c.n, 'live charts');
        });

        test('rule 2 values: the live chart shows the new numbers after the update', async () => {
            const w = await start();
            await c.draw(w, data(0), c.subjects[0]);
            const first = JSON.stringify(w.log.made[0].data.datasets[0].data);
            await c.draw(w, data(1), c.subjects[0]);
            const shown = [...w.live].find(ch => ch.canvas === c.canvases(w)[0]);
            assert.ok(shown, 'a live chart on the canvas');
            assert.notEqual(JSON.stringify(shown.data.datasets[0].data), first, 'still the old numbers');
        });

        test('rule 4: prefers-reduced-motion read at update time: no animation on first paint or on update', async () => {
            const w = await start({ reduced: true });
            await c.draw(w, data(0), c.subjects[0]);
            w.log.made.forEach(ch => assert.equal(ch.options.animation, false));
            await c.draw(w, data(1), c.subjects[0]);
            if (c.inPlace) {
                assert.equal(w.log.updates.length, c.n, 'updated in place');
                w.log.updates.forEach(u => { assert.equal(u.animation, false); assert.equal(u.mode, 'none'); });
            } else w.log.made.forEach(ch => assert.equal(ch.options.animation, false));
        });

        if (!c.noSubject) test('rule 5: another subject (' + c.subjects.map(String).join(' / ') + ') is a full replace: old destroyed first, never two on one canvas, short ease', async () => {
            const w = await start();
            await c.draw(w, data(0, c.subjects[0]), c.subjects[0]);
            await c.draw(w, data(0, c.subjects[1]), c.subjects[1]);
            assert.equal(rows(w), 2 * c.n, 'rebuilt');
            assert.equal(w.log.destroyed.length, c.n, 'old chart destroyed');
            assert.equal(w.log.updates.length, 0, 'updated across subjects');
            assert.equal(w.log.collisions, 0, 'two charts on one canvas');
            assert.equal(w.live.size, c.n);
            w.log.made.slice(c.n).forEach(ch => assert.deepEqual(ch.options.animation, EASE));
        });

        test('Back: after a route change released the charts, the same data brings every chart back on its canvas', async () => {
            const w = await start();
            await c.draw(w, data(0), c.subjects[0]);
            w.s.leave();
            assert.equal(w.live.size, 0, 'released on leaving');
            await c.draw(w, data(0), c.subjects[0]);
            assert.equal(w.live.size, c.n, 'live charts after coming back');
            c.canvases(w).forEach(cv => assert.ok(cv && cv.isConnected && [...w.live].some(ch => ch.canvas === cv), 'a canvas with no chart drawn on it'));
            assert.equal(w.log.collisions, 0);
        });

        test('rule 6: leaving the page releases every chart', async () => {
            const w = await start();
            await c.draw(w, data(0), c.subjects[0]);
            w.s.release();
            assert.equal(w.live.size, 0, 'a chart survived the route change');
            assert.equal(w.log.destroyed.length, c.n);
            w.s.release();
            assert.equal(w.log.destroyed.length, c.n, 'released twice');
        });

        if (c.tooltip) {
            test('rule 7: the tooltip of the live chart reads the data it is handed, after an update', async () => {
                const w = await start();
                await c.draw(w, data(0), c.subjects[0]);
                await c.draw(w, data(1), c.subjects[0]);
                assert.equal(rows(w), c.n, 'instance kept (hover and tooltip state live in it)');
                const withTooltip = [...w.live].filter(ch => ch.options.plugins && ch.options.plugins.tooltip && ch.options.plugins.tooltip.callbacks);
                assert.ok(withTooltip.length >= 1);
                withTooltip.forEach(ch => assert.match(ch.options.plugins.tooltip.callbacks.label({ dataset: { label: 'L' }, parsed: { y: 7.25 } }), /7\.25/));
            });
        }
    });
}

describe('in place: the validator page paints nothing when its data has not changed', () => {
    test('REPRODUCTION: opening the same validator again with the same data keeps the card, the canvas and the chart (no "Fetching" blank)', async () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="validator-details-container"></div>';
        w.ctx.__fetch = async () => vdata(ADDR, 1);
        await w.s.validator(ADDR);
        const box = w.doc.getElementById('validator-details-container'), canvas = w.doc.getElementById('validatorChartCanvas'), card = box.firstElementChild;
        await w.s.validator(ADDR);
        assert.equal(w.log.made.length, 1); assert.equal(w.log.destroyed.length, 0);
        assert.ok(w.doc.getElementById('validatorChartCanvas') === canvas && box.firstElementChild === card, 'card replaced');
    });
    test('another validator repaints: the first chart is destroyed, the second is built on the new canvas', async () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="validator-details-container"></div>';
        w.ctx.__fetch = async () => vdata(ADDR, 1);
        await w.s.validator(ADDR);
        w.ctx.__fetch = async () => vdata(ADDR2, 1);
        await w.s.validator(ADDR2);
        assert.equal(w.log.made.length, 2); assert.equal(w.log.destroyed.length, 1); assert.equal(w.log.collisions, 0);
    });
    test('a failed fetch shows the error and releases the chart', async () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="validator-details-container"></div>';
        w.ctx.__fetch = async () => vdata(ADDR, 1);
        await w.s.validator(ADDR);
        w.ctx.__fetch = async () => { throw new Error('down'); };
        await w.s.validator(ADDR2);
        assert.equal(w.live.size, 0);
        assert.match(w.doc.getElementById('validator-details-container').textContent, /ERR down/);
    });
});

describe('in place: the wallet price card keeps its canvas across a wallet refresh', () => {
    test('REPRODUCTION: a refresh after a payout repaints the card with the same history: same canvas, one chart, no flash', () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="wallet-price-chart-wrap"><canvas id="wallet-price-chart"></canvas></div>';
        w.s.setWallet(ADDR);
        w.s.wallet({ history: hist(5, 1), configured: true });
        const canvas = w.doc.getElementById('wallet-price-chart');
        w.s.wallet({ history: hist(5, 1), configured: true });
        assert.ok(w.doc.getElementById('wallet-price-chart') === canvas, 'canvas node replaced');
        assert.equal(w.log.made.length, 1);
    });
    test('the empty state replaces the chart, and a later history brings a canvas and a chart back', () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="wallet-price-chart-wrap"><canvas id="wallet-price-chart"></canvas></div>';
        w.s.setWallet(ADDR);
        w.s.wallet({ history: hist(5, 1), configured: true });
        w.s.wallet({ history: [], configured: true });
        assert.equal(w.live.size, 0); assert.ok(!w.doc.getElementById('wallet-price-chart'));
        w.s.wallet({ history: hist(5, 1), configured: true });
        assert.equal(w.live.size, 1); assert.ok(w.doc.getElementById('wallet-price-chart'));
    });
    test('fidelity review 2026-11-24 R1: the empty card says the review\'s sentence, with no dash', () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="wallet-price-chart-wrap"><canvas id="wallet-price-chart"></canvas></div>';
        w.s.setWallet(ADDR);
        w.s.wallet({ history: [], configured: true });
        const text = w.doc.getElementById('wallet-price-chart-wrap').textContent.trim();
        assert.equal(text, 'Collecting price history. The chart fills in as data arrives.');
        assert.doesNotMatch(text, /[\u2013\u2014]/);
    });
});

describe('in place: the democracy statistics follow a quiet poll', () => {
    const ok = (d) => ({ ok: true, status: 200, body: d });
    const page = () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="democracy-content"><canvas id="dem-vote-chart"></canvas><canvas id="dem-turnout-chart"></canvas><canvas id="dem-turnoutpct-chart"></canvas></div>';
        const d1 = { referenda: refs(4, 5), totalIssuance: 1000 };
        w.s.setDemocracy(d1); w.s.dem(d1);
        return w;
    };
    test('same referenda, new tallies: the bars change in place (before: they stayed at the old numbers)', async () => {
        const w = page();
        w.ctx.__res = ok({ referenda: refs(4, 50), totalIssuance: 1000 });
        await w.s.pollDemocracy();
        assert.equal(w.log.made.length, 3); assert.equal(w.log.destroyed.length, 0);
        assert.equal(w.log.updates.length, 3, 'one update per chart');
    });
    test('same data on the poll: nothing is touched', async () => {
        const w = page();
        w.ctx.__res = ok({ referenda: refs(4, 5), totalIssuance: 1000 });
        await w.s.pollDemocracy();
        assert.equal(w.log.made.length, 3); assert.equal(w.log.updates.length, 0); assert.equal(w.log.destroyed.length, 0);
    });
    test('no referendum with a tally: the three charts are released', () => {
        const w = page();
        w.s.dem({ referenda: [], totalIssuance: 1000 });
        assert.equal(w.live.size, 0);
    });
});

describe('in place: a quiet democracy poll that lands after the user left builds nothing', () => {
    const later = () => { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; };
    const open = () => {
        const w = world();
        w.doc.body.innerHTML = '<div id="democracy-content"><canvas id="dem-vote-chart"></canvas><canvas id="dem-turnout-chart"></canvas><canvas id="dem-turnoutpct-chart"></canvas></div>';
        const d1 = { referenda: refs(4, 5), totalIssuance: 1000 };
        w.s.setDemocracy(d1); w.s.dem(d1);
        return w;
    };
    for (const quiet of [true, false]) test((quiet ? 'quiet' : 'full') + ' fetch started on Democracy, user leaves, response lands: no chart is built or kept', async () => {
        const w = open(), gate = later();
        w.ctx.__res = { ok: true, status: 200, body: { referenda: refs(4, 50), totalIssuance: 1000 } };
        w.ctx.democracyView.fetchRest = async () => { await gate.p; return w.ctx.__res; };
        const pending = quiet ? w.s.pollDemocracy() : w.s.fetchDemocracy();
        w.s.leave();
        const before = w.log.made.length;
        gate.resolve();
        await pending;
        assert.equal(w.log.made.length, before, 'charts built after leaving');
        assert.equal(w.live.size, 0, 'live charts in a section that is not on screen');
        assert.equal(w.log.democracyRenders, 0, 'the page was redrawn after leaving');
    });
    test('the same poll with the user still on the page still updates the bars in place', async () => {
        const w = open();
        w.ctx.__res = { ok: true, status: 200, body: { referenda: refs(4, 50), totalIssuance: 1000 } };
        await w.s.pollDemocracy();
        assert.equal(w.log.updates.length, 3);
    });
});

describe('in place: the route change releases the charts', () => {
    test('routeTo calls releasePageCharts, after the page scope is left', () => {
        const body = bodyOf(SCRIPT, 'routeTo');
        const at = body.indexOf('releasePageCharts()');
        assert.ok(at > body.indexOf('pageScope.leave()'), 'routeTo does not release the charts');
        assert.ok(at < body.indexOf("target = 'home'"), 'released too late');
    });
    test('the page areas that are cleared release their chart first', () => {
        assert.match(bodyOf(SCRIPT, 'renderPricePage'), /releaseChart\(pricePageSlot\)/);
        assert.match(bodyOf(SCRIPT, 'fetchAnalyticsData'), /releaseCharts\(/);
        assert.match(bodyOf(SCRIPT, 'renderDemocracy'), /releaseCharts\(/);
    });
});

describe('lib/chart-update.js paintChart: the one decision for every chart', () => {
    const cfg = (labels, data, over = {}) => ({ type: 'bar', data: { labels, datasets: [{ label: 'A', data, backgroundColor: 'red' }] }, options: { animation: over.animation } });
    function fake() {
        const log = { made: 0, destroyed: 0, updates: [] };
        class C { constructor(ctx, c) { this.canvas = ctx.canvas; this.data = c.data; this.options = c.options; log.made++; } update(m) { log.updates.push(m); } destroy() { log.destroyed++; } }
        const canvas = () => ({ getContext() { return { canvas: this }; } });
        return { log, C, canvas };
    }
    const paint = (slot, canvas, subject, build, C, reducedMotion = false) => chartUpdate.paintChart(slot, canvas, subject, build, { Chart: C, reducedMotion });
    const TABLE = [
        { name: 'first paint', steps: [['L', [1], 's']], expect: ['replace'] },
        { name: 'same labels, values and subject', steps: [['L', [1], 's'], ['L', [1], 's']], expect: ['replace', 'none'] },
        { name: 'new values', steps: [['L', [1], 's'], ['L', [2], 's']], expect: ['replace', 'update'] },
        { name: 'new labels', steps: [['L', [1], 's'], ['M', [1], 's']], expect: ['replace', 'update'] },
        { name: 'new subject, same data', steps: [['L', [1], 's'], ['L', [1], 't']], expect: ['replace', 'replace'] },
        { name: 'none, update, none again', steps: [['L', [1], 's'], ['L', [1], 's'], ['L', [3], 's'], ['L', [3], 's']], expect: ['replace', 'none', 'update', 'none'] }
    ];
    for (const row of TABLE) test(row.name, () => {
        const f = fake(), slot = chartUpdate.newChartSlot(), canvas = f.canvas(), seen = [];
        for (const [l, d, s] of row.steps) seen.push(paint(slot, canvas, s, (a) => cfg([l], d, { animation: a }), f.C));
        assert.deepEqual(seen, row.expect);
        assert.equal(f.log.made, seen.filter(x => x === 'replace').length);
        assert.equal(f.log.destroyed, Math.max(0, seen.filter(x => x === 'replace').length - 1));
        assert.equal(f.log.updates.length, seen.filter(x => x === 'update').length);
    });
    test('a different canvas for the same subject replaces and destroys the old chart first', () => {
        const f = fake(), slot = chartUpdate.newChartSlot();
        paint(slot, f.canvas(), 's', (a) => cfg(['L'], [1], { animation: a }), f.C);
        assert.equal(paint(slot, f.canvas(), 's', (a) => cfg(['L'], [1], { animation: a }), f.C), 'replace');
        assert.equal(f.log.destroyed, 1);
    });
    test('a change of the series count replaces (the chart cannot grow a series in place)', () => {
        const f = fake(), slot = chartUpdate.newChartSlot(), canvas = f.canvas();
        paint(slot, canvas, 's', (a) => cfg(['L'], [1], { animation: a }), f.C);
        const two = (a) => ({ type: 'bar', data: { labels: ['L'], datasets: [{ label: 'A', data: [1] }, { label: 'B', data: [2] }] }, options: { animation: a } });
        assert.equal(paint(slot, canvas, 's', two, f.C), 'replace');
    });
    test('a change of a series name or colour is not "unchanged": it is shown', () => {
        const f = fake(), slot = chartUpdate.newChartSlot(), canvas = f.canvas();
        paint(slot, canvas, 's', (a) => cfg(['L'], [1], { animation: a }), f.C);
        const renamed = (a) => ({ type: 'bar', data: { labels: ['L'], datasets: [{ label: 'Z', data: [1], backgroundColor: 'blue' }] }, options: { animation: a } });
        assert.notEqual(paint(slot, canvas, 's', renamed, f.C), 'none');
        assert.equal(slot.chart.data.datasets[0].label, 'Z'); assert.equal(slot.chart.data.datasets[0].backgroundColor, 'blue');
    });
    test('motion: one short ease; none under reduced motion; update mode follows', () => {
        for (const reduced of [false, true]) {
            const f = fake(), slot = chartUpdate.newChartSlot(), canvas = f.canvas();
            paint(slot, canvas, 's', (a) => cfg(['L'], [1], { animation: a }), f.C, reduced);
            assert.deepEqual(slot.chart.options.animation, reduced ? false : { duration: REFRESH_UI.collapseMs });
            paint(slot, canvas, 's', (a) => cfg(['L'], [2], { animation: a }), f.C, reduced);
            assert.deepEqual(slot.chart.options.animation, reduced ? false : { duration: REFRESH_UI.collapseMs });
            assert.deepEqual(f.log.updates, [reduced ? 'none' : undefined]);
        }
    });
    test('an option that depends on the data (axis max) follows an update, and an option-only change is not "unchanged"', () => {
        const f = fake(), slot = chartUpdate.newChartSlot(), canvas = f.canvas();
        const build = (data, max) => (a) => ({ type: 'bar', data: { labels: ['L'], datasets: [{ label: 'A', data }] }, options: { animation: a, scales: { y: { max } } } });
        paint(slot, canvas, 's', build([1], 10), f.C);
        assert.equal(paint(slot, canvas, 's', build([5], 50), f.C), 'update');
        assert.equal(slot.chart.options.scales.y.max, 50, 'axis max after new data');
        assert.equal(paint(slot, canvas, 's', build([5], 80), f.C), 'update', 'same data, new option');
        assert.equal(slot.chart.options.scales.y.max, 80, 'axis max after option-only change');
        assert.equal(paint(slot, canvas, 's', build([5], 80), f.C), 'none');
    });
    test('releaseChart destroys once and empties the slot; releaseCharts takes a list', () => {
        const f = fake(), a = chartUpdate.newChartSlot(), b = chartUpdate.newChartSlot();
        paint(a, f.canvas(), 's', (x) => cfg(['L'], [1], { animation: x }), f.C); paint(b, f.canvas(), 's', (x) => cfg(['L'], [1], { animation: x }), f.C);
        chartUpdate.releaseCharts([a, b, chartUpdate.newChartSlot()]); chartUpdate.releaseChart(a);
        assert.equal(f.log.destroyed, 2); assert.equal(a.chart, null); assert.equal(a.key, null);
        assert.equal(paint(a, f.canvas(), 's', (x) => cfg(['L'], [1], { animation: x }), f.C), 'replace');
    });
});

describe('lib/chart-configs.js: plain config builders, motion passed in', () => {
    const build = {
        pricePageChartConfig: (a) => chartConfigs.pricePageChartConfig(hist(5, 1), a),
        validatorChartConfig: (a) => chartConfigs.validatorChartConfig(vdata(ADDR, 1).history, a),
        walletPriceChartConfig: (a) => chartConfigs.walletPriceChartConfig(hist(5, 1), a),
        democracyVoteChartConfig: (a) => chartConfigs.democracyVoteChartConfig(refs(3, 5), a),
        democracyTurnoutChartConfig: (a) => chartConfigs.democracyTurnoutChartConfig(refs(3, 5), a),
        democracyTurnoutPctChartConfig: (a) => chartConfigs.democracyTurnoutPctChartConfig(refs(3, 5), 1000, a),
        analyticsChartConfig: (a) => chartConfigs.analyticsChartConfig('line', series(4, 1), 'USD', '#f5a623', a)
    };
    for (const name of Object.keys(build)) test(name + ': carries the animation it is given and the data it is given, and nothing else moves', () => {
        assert.equal(typeof chartConfigs[name], 'function');
        const a = build[name]({ duration: 240 }), b = build[name](false);
        assert.deepEqual(a.options.animation, { duration: 240 }); assert.equal(b.options.animation, false);
        assert.deepEqual(a.data, b.data);
        assert.ok(a.data.labels.length > 0 && a.data.datasets.every(d => d.data.length === a.data.labels.length));
        assert.equal(a.options.responsive, true);
    });
    test('democracy turnout % is turnout over issuance, 0 when there is no issuance', () => {
        assert.deepEqual(chartConfigs.democracyTurnoutPctChartConfig([{ refIndex: 1, turnout: 50 }], 1000, false).data.datasets[0].data, [5]);
        assert.deepEqual(chartConfigs.democracyTurnoutPctChartConfig([{ refIndex: 1, turnout: 50 }], 0, false).data.datasets[0].data, [0]);
    });
    test('fidelity review 2026-11-24 C1: the vote trend title has no dash: "Vote trend: Ayes vs Nays (PDEX)"', () => {
        const c = chartConfigs.democracyVoteChartConfig(refs(3, 5), false);
        assert.equal(c.options.plugins.title.text, 'Vote trend: Ayes vs Nays (PDEX)');
        for (const name of Object.keys(build)) assert.doesNotMatch(JSON.stringify(build[name](false).options), /[\u2013\u2014]/, name);
    });
    test('the validator chart reads the history oldest first', () => {
        const c = chartConfigs.validatorChartConfig([{ era: 3, commission: 3, apy: 3 }, { era: 2, commission: 2, apy: 2 }], false);
        assert.deepEqual(c.data.labels, ['Era 2', 'Era 3']);
    });
});

describe('script.js stays inside its budget', () => {
    test('this round does not grow script.js', () => {
        assert.ok(SCRIPT.split('\n').length <= 14711, 'script.js lines: ' + SCRIPT.split('\n').length);
    });
});
