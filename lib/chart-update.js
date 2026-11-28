// Chart updates without a replay (CEO report 22 Nov: the staking-rewards bars kept refreshing).
// Pure decisions only: no DOM, no Chart.js. script.js owns the wiring; test/chart-update.test.js owns the table.
// The one ease is the spec's T4 (lib/refresh-ui.js, designer spec 2026-11-22 section 6): short, and none under reduced motion.
import { REFRESH_UI } from './refresh-ui.js';

// The stacked per-era series of the staking-rewards chart; null when there is nothing to draw.
export function rewardsSeries(data) {
    const claimed = new Map(), unclaimed = new Map(), eraSet = new Set();
    const add = (map, era, amt) => { const k = era == null ? 'Unknown' : era; map.set(k, (map.get(k) || 0) + amt); eraSet.add(k); };
    ((data && data.claimed) || []).forEach(r => add(claimed, r.era, Number(r.amount) || 0));
    ((data && data.unclaimed) || []).forEach(r => add(unclaimed, r.era, Number(r.amount) || 0));
    const eras = [...eraSet].filter(e => e !== 'Unknown').sort((a, b) => a - b);
    if (eraSet.has('Unknown')) eras.push('Unknown');
    if (eras.length === 0) return null;
    return {
        labels: eras.map(e => e === 'Unknown' ? 'Unknown' : 'Era ' + e),
        datasets: [{ label: 'Claimed', data: eras.map(e => claimed.get(e) || 0) }, { label: 'Unpaid', data: eras.map(e => unclaimed.get(e) || 0) }]
    };
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function sameSeries(a, b) {
    if (!a || !b) return !a && !b;
    return sameList(a.labels, b.labels) && a.datasets.length === b.datasets.length
        && a.datasets.every((d, i) => d.label === b.datasets[i].label && sameList(d.data, b.datasets[i].data));
}

// Identity of everything the page shows: the same data and filter paint the same page, so a repeat paints nothing.
export function renderKey(data, filter) { return JSON.stringify([data, filter]); }

// prev: the series on screen (or null); next: the series that arrived; canvasKept: the chart still owns the canvas in the page.
export function planChartUpdate(prev, next, { reducedMotion = false, canvasKept = false } = {}) {
    const animation = reducedMotion ? false : { duration: REFRESH_UI.collapseMs };
    const updateMode = reducedMotion ? 'none' : 'default';
    if (!prev || !canvasKept) return { action: 'replace', animation, updateMode };
    if (sameSeries(prev, next)) return { action: 'none', animation: null, updateMode: null };
    return { action: 'update', animation, updateMode };
}

// Write the new values into the live chart's own objects (styling and callbacks stay).
export function applySeries(chartData, series) {
    chartData.labels = series.labels;
    series.datasets.forEach((d, i) => { if (chartData.datasets[i]) chartData.datasets[i].data = d.data; });
    return chartData;
}

// The bar chart's Chart.js config for a series (plain data: styling, tooltip text, stacked axes).
// A colour is a stylesheet token read when the chart is drawn; tint appends a hex alpha to a hex token.
const token = (name) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'currentColor'; } catch (_) { return 'currentColor'; } };
const tint = (colour, alpha) => (/^#[0-9a-f]{6}$/i.test(colour) ? colour + alpha : colour);
export function rewardsChartConfig(series, animation) {
    const [claimed, unpaid] = series.datasets;
    const okTone = token('--accent-green'), brandTone = token('--brand-primary'), tick = token('--text-secondary'), grid = token('--border-color');
    return {
        type: 'bar',
        data: {
            labels: series.labels,
            datasets: [
                { label: 'Claimed', data: claimed.data, backgroundColor: tint(okTone, '99'), borderColor: okTone, borderWidth: 1, borderRadius: 3 },
                { label: 'Unpaid', data: unpaid.data, backgroundColor: tint(brandTone, '8c'), borderColor: brandTone, borderWidth: 1, borderRadius: 3 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' PDEX' } }
            },
            scales: {
                x: { stacked: true, ticks: { maxTicksLimit: 12, color: tick }, grid: { color: grid } },
                y: { stacked: true, ticks: { color: tick }, grid: { color: grid }, beginAtZero: true }
            }
        }
    };
}

// ---- Every other chart: one slot per chart, one decision (CEO 23 Nov: "update the remaining charts with the same logic") ----
// A slot is what a page keeps for one chart: the live instance, what it is about (subject) and what it shows (key).
export const newChartSlot = () => ({ chart: null, subject: null, key: null, type: null });

export function releaseChart(slot) {
    if (!slot) return;
    if (slot.chart) { try { slot.chart.destroy(); } catch (_) { /* its canvas is already gone */ } }
    slot.chart = slot.subject = slot.key = slot.type = null;
}
export const releaseCharts = (slots) => slots.forEach(releaseChart);

// Paint a chart into `canvas` and say what was done: 'none' (what is drawn is what arrived), 'update' (same chart,
// values written in place, one short ease) or 'replace' (new canvas or another subject: old chart destroyed first).
// build(animation) returns a plain Chart.js config; what the key covers is the type, the data and the plain options.
export function paintChart(slot, canvas, subject, build, { Chart, reducedMotion = false } = {}) {
    const animation = reducedMotion ? false : { duration: REFRESH_UI.collapseMs };
    const cfg = build(animation), key = JSON.stringify([cfg.type, cfg.data, cfg.options]);   // functions do not serialise: data-dependent options (axis max, title) do
    const chart = slot.chart;
    if (chart && chart.canvas === canvas && slot.subject === subject) {
        if (slot.key === key) return 'none';
        if (slot.type === cfg.type && chart.data.datasets.length === cfg.data.datasets.length) {
            chart.data.labels = cfg.data.labels;
            cfg.data.datasets.forEach((d, i) => Object.assign(chart.data.datasets[i], d));
            chart.options = cfg.options;   // the freshly built options, animation included
            slot.key = key;
            chart.update(reducedMotion ? 'none' : undefined);
            return 'update';
        }
    }
    releaseChart(slot);
    slot.chart = new Chart(canvas.getContext('2d'), cfg);
    slot.subject = subject; slot.key = key; slot.type = cfg.type;
    return 'replace';
}
