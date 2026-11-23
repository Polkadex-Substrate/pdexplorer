// The staking-rewards page in script.js, EXECUTED: the real renderStakingRewards and renderStakingRewardsChart are
// lifted (as test/post-action-glue.test.js lifts) and run over a happy-dom page with a FAKE Chart that records calls.
// CEO report 22 Nov: "the bars keep refreshing". The page polls every 6 s while unpaid rewards are computed, and each
// poll repainted the whole shell and destroyed and re-created the chart (entrance animation from zero).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { readRepo, bodyOf } from './helpers/source.js';
import * as chartUpdate from '../lib/chart-update.js';
import { REFRESH_UI } from '../lib/refresh-ui.js';
import { escapeHtml } from '../lib/html-escape.js';

const SCRIPT = readRepo('script.js', import.meta.url);
const line = (start) => { const i = SCRIPT.indexOf(start); assert.ok(i >= 0, 'not in script.js: ' + start); return SCRIPT.slice(i, SCRIPT.indexOf('\n', i)); };
const ME = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const OTHER = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const mk = (address, claimed, unclaimed = []) => ({ address, summary: { claimedTotal: 1, unclaimedTotal: 1, totalAmount: 2, claimedCount: claimed.length, eraCount: claimed.length }, index: {}, claimed, unclaimed, apr: { bondedAmount: 5, apr30d: 4.5 } });
const eras = (n, amt = 1) => Array.from({ length: n }, (_, i) => ({ era: 100 + i, amount: amt, validator: 'V', block: 10 + i }));

function page({ reduced = false } = {}) {
    const win = new Window({ url: 'https://explorer.test/staking-rewards', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
    const doc = win.document;
    doc.body.innerHTML = '<div id="staking-rewards-results"></div>';
    win.HTMLCanvasElement.prototype.getContext = function () { return { canvas: this }; };
    win.matchMedia = (q) => ({ matches: reduced && /reduce/.test(q), media: q });
    const log = { made: [], updates: [], destroys: 0, tables: 0 };
    class FakeChart {
        constructor(ctx, cfg) { this.canvas = ctx.canvas; this.config = cfg; this.data = cfg.data; this.options = cfg.options; log.made.push({ canvas: this.canvas, animation: cfg.options.animation, chart: this }); }
        update(mode) { log.updates.push({ mode, animation: this.options.animation, labels: [...this.data.labels], data: this.data.datasets.map(d => [...d.data]) }); }
        destroy() { log.destroys++; }
    }
    const ctx = {
        console, Promise, Object, JSON, Array, Map, Set, String, Number, Math, Date, encodeURIComponent,
        window: win, document: doc, Chart: FakeChart, ...chartUpdate, REFRESH_UI,
        stakingFormatPDEX: (v) => Number(v || 0).toFixed(4), stakingFormatNumber: (n) => String(n), stakingShortAddress: (x) => String(x).slice(0, 6), stakingEscapeHtml: escapeHtml,
        formatLocalDateTime: () => 'now', downloadStakingRewardsCSV() {}, downloadStakingRewardsJSON() {}, downloadStakingRewardsTaxCSV() {},
        makeTable: (o) => { log.tables++; o.container.innerHTML = '<table><tr><td>' + o.rows.length + '</td></tr></table>'; }
    };
    vm.createContext(ctx);
    vm.runInContext([
        line('let stakingRewardsData = null;'), line('let stakingRewardsChart = null;'), line("let stakingRewardFilter = 'all';"),
        bodyOf(SCRIPT, 'getFilteredRewards'), bodyOf(SCRIPT, 'renderStakingAprCard'), bodyOf(SCRIPT, 'renderStakingRewards'), bodyOf(SCRIPT, 'renderStakingRewardsChart'),
        'globalThis.__s = { render: (d) => { stakingRewardsData = d; renderStakingRewards(d); }, setFilter: (f) => { stakingRewardFilter = f; }, chart: () => stakingRewardsChart };'
    ].join('\n'), ctx);
    const q = (s) => doc.querySelector(s);
    return { doc, ctx, log, q, s: ctx.__s };
}

describe('the staking-rewards bars (CEO report 22 Nov)', () => {
    test('REPRODUCTION: the same data arriving again and again builds the chart once and never destroys it', () => {
        const p = page();
        for (let i = 0; i < 5; i++) p.s.render(mk(ME, eras(6)));
        assert.equal(p.log.made.length, 1, 'chart constructed once');
        assert.equal(p.log.destroys, 0, 'chart never destroyed');
        assert.equal(p.log.updates.length, 0, 'no update call for identical data');
    });

    test('rule 1: identical data repaints nothing: same canvas, same cards, table not rebuilt', () => {
        const p = page();
        p.s.render(mk(ME, eras(6)));
        const canvas = p.q('#staking-rewards-chart'), grid = p.q('.staking-summary-grid'), tables = p.log.tables;
        p.s.render(mk(ME, eras(6)));
        assert.ok(p.q('#staking-rewards-chart') === canvas, 'canvas node replaced');
        assert.ok(p.q('.staking-summary-grid') === grid, 'summary cards repainted');
        assert.equal(p.log.tables, tables, 'table rebuilt');
    });

    test('rule 2: changed data keeps the instance, the canvas and the wrap; one update, no destroy; values in place', () => {
        const p = page();
        p.s.render(mk(ME, eras(6)));
        const canvas = p.q('#staking-rewards-chart'), wrap = p.q('.staking-chart-wrap'), chart = p.s.chart();
        p.s.render(mk(ME, eras(7, 2)));
        assert.equal(p.log.made.length, 1); assert.equal(p.log.destroys, 0); assert.equal(p.log.updates.length, 1);
        assert.ok(p.q('#staking-rewards-chart') === canvas, 'canvas replaced');
        assert.ok(p.q('.staking-chart-wrap') === wrap, 'wrap replaced (layout jump)');
        assert.ok(p.s.chart() === chart, 'identity changed');
        assert.equal(p.log.updates[0].labels.length, 7);
        assert.deepEqual(p.log.updates[0].data[0], [2, 2, 2, 2, 2, 2, 2]);
        assert.deepEqual(p.log.updates[0].animation, { duration: REFRESH_UI.collapseMs }, 'one short ease');
        assert.ok(p.q('.staking-chart-wrap').parentNode, 'wrap is in the page');
    });

    test('rule 3: first paint uses the short ease, not the library default entrance', () => {
        const p = page();
        p.s.render(mk(ME, eras(6)));
        assert.deepEqual(p.log.made[0].animation, { duration: REFRESH_UI.collapseMs });
    });

    test('rule 4: reduced motion: no animation on the first paint, and a changed value just changes (update mode none)', () => {
        const p = page({ reduced: true });
        p.s.render(mk(ME, eras(6)));
        assert.equal(p.log.made[0].animation, false);
        p.s.render(mk(ME, eras(6, 3)));
        assert.equal(p.log.updates.length, 1);
        assert.equal(p.log.updates[0].mode, 'none');
        assert.equal(p.log.updates[0].animation, false);
    });

    test('rule 5: the All/Claimed/Unpaid pill repaints the table but leaves the chart alone', () => {
        const p = page();
        p.s.render(mk(ME, eras(6), eras(2)));
        const canvas = p.q('#staking-rewards-chart'), tables = p.log.tables;
        p.s.setFilter('claimed');
        p.s.render(mk(ME, eras(6), eras(2)));
        assert.equal(p.log.tables, tables + 1, 'table follows the filter');
        assert.ok(p.q('#staking-rewards-chart') === canvas, 'canvas replaced by the filter pill');
        assert.equal(p.log.destroys, 0); assert.equal(p.log.updates.length, 0); assert.equal(p.log.made.length, 1);
    });

    test('rule 5: another account (the page showed Loading in between) redraws fully, still with the short ease, and the old chart is destroyed', () => {
        const p = page();
        p.s.render(mk(ME, eras(6)));
        p.q('#staking-rewards-results').innerHTML = '<div>Loading staking rewards</div>';
        p.s.render(mk(OTHER, eras(3, 5)));
        assert.equal(p.log.made.length, 2);
        assert.equal(p.log.destroys, 1, 'the stale chart is released');
        assert.deepEqual(p.log.made[1].animation, { duration: REFRESH_UI.collapseMs });
    });

    test('rule 5: a changed update does not touch the tooltip or legend configuration of the live chart', () => {
        const p = page();
        p.s.render(mk(ME, eras(6)));
        const opts = p.s.chart().options, tip = opts.plugins.tooltip, legend = opts.plugins.legend;
        p.s.render(mk(ME, eras(6, 9)));
        assert.ok(p.s.chart().options.plugins.tooltip === tip, 'identity changed');
        assert.ok(p.s.chart().options.plugins.legend === legend, 'identity changed');
    });

    test('an account that has no rewards after having some releases the chart', () => {
        const p = page();
        p.s.render(mk(ME, eras(6)));
        p.s.render(mk(ME, []));
        assert.equal(p.log.destroys, 1);
        assert.ok(p.q('#staking-rewards-chart') === null, 'canvas still in the page');
    });
});
