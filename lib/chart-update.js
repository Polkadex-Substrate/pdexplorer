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
export function rewardsChartConfig(series, animation) {
    const [claimed, unpaid] = series.datasets;
    return {
        type: 'bar',
        data: {
            labels: series.labels,
            datasets: [
                { label: 'Claimed', data: claimed.data, backgroundColor: 'rgba(0, 230, 118, 0.6)', borderColor: '#00E676', borderWidth: 1, borderRadius: 3 },
                { label: 'Unpaid', data: unpaid.data, backgroundColor: 'rgba(230, 0, 122, 0.55)', borderColor: '#E6007A', borderWidth: 1, borderRadius: 3 }
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
                x: { stacked: true, ticks: { maxTicksLimit: 12, color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { stacked: true, ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
            }
        }
    };
}
