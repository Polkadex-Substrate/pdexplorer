// Chart.js configs for the explorer's charts, as plain data (no DOM, no Chart.js). lib/chart-update.js paintChart decides
// whether a config builds a chart, updates one or does nothing; the animation is passed in so every chart shares one ease.
// Tooltip callbacks read the point they are handed, never a variable of the build: an updated chart keeps them.
const GRID = 'rgba(255,255,255,0.05)', GRID_LIGHT = 'rgba(255,255,255,0.04)';
const usd = (digits) => (ctx) => ' $' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: digits });
const priceLine = (history, dateFmt, tension, animation, extra) => ({
    type: 'line',
    data: {
        labels: history.map(p => new Date(p.timestamp).toLocaleDateString('en-US', dateFmt)),
        datasets: [{ label: 'PDEX / USD', data: history.map(p => p.price), borderColor: '#00E676', backgroundColor: 'rgba(0, 230, 118, 0.12)', borderWidth: 2, pointRadius: 0, fill: true, tension }]
    },
    options: {
        responsive: true, maintainAspectRatio: false, animation, ...extra.top,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: usd(6) } } },
        scales: {
            x: { ticks: { maxTicksLimit: extra.ticks, color: '#888' }, grid: { color: extra.grid } },
            y: { ticks: { color: '#888', callback: v => '$' + v }, grid: { color: extra.grid } }
        }
    }
});

// Price page: sparse labels on long ranges (about 12 ticks on the all-time view).
export function pricePageChartConfig(history, animation) {
    const fmt = history.length > 120 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' };
    return priceLine(history, fmt, 0.20, animation, { top: { interaction: { mode: 'index', intersect: false } }, ticks: 12, grid: GRID_LIGHT });
}
export const walletPriceChartConfig = (history, animation) =>
    priceLine(history, { month: 'short', day: 'numeric' }, 0.25, animation, { top: {}, ticks: 8, grid: GRID });

// Validator page: commission and APY per era; the server sends newest first, the chart reads oldest first.
export function validatorChartConfig(history, animation) {
    const rows = [...history].reverse();
    const line = (label, color, data) => ({ label, data, borderColor: color, backgroundColor: color, tension: 0.1, borderWidth: 2, pointRadius: 0 });
    return {
        type: 'line',
        data: { labels: rows.map(h => `Era ${h.era}`), datasets: [line('Commission (%)', '#ff6b6b', rows.map(h => h.commission)), line('APY (%)', '#4d88ff', rows.map(h => h.nominatorApy ?? null))] },
        options: {
            responsive: true, maintainAspectRatio: false, animation, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom', labels: { color: '#ccc', font: { family: 'Inter', size: 12 } } } },
            scales: {
                x: { ticks: { maxTicksLimit: 5, color: '#888' }, grid: { color: GRID } },
                y: { ticks: { callback: (value) => value + '%', color: '#888' }, grid: { color: GRID } }
            }
        }
    };
}

// Democracy statistics: one bar chart per question, over the referenda that have a tally.
const demAxis = (extra) => Object.assign({ ticks: { color: '#888', maxTicksLimit: 14 }, grid: { color: GRID } }, extra || {});
const demBars = (refs, datasets, animation, plugins, scales) => ({
    type: 'bar',
    data: { labels: refs.map(r => '#' + r.refIndex), datasets },
    options: { responsive: true, maintainAspectRatio: false, animation, plugins, scales }
});
const PURPLE = { backgroundColor: 'rgba(124,108,255,0.6)', borderColor: '#7c6cff', borderWidth: 1 };
export const democracyVoteChartConfig = (refs, animation) => demBars(refs, [
    { label: 'Ayes', data: refs.map(r => r.ayes || 0), backgroundColor: 'rgba(0,230,118,0.6)', borderColor: '#00E676', borderWidth: 1 },
    { label: 'Nays', data: refs.map(r => r.nays || 0), backgroundColor: 'rgba(230,0,122,0.55)', borderColor: '#E6007A', borderWidth: 1 }
], animation, { legend: { position: 'bottom', labels: { color: '#ccc', font: { size: 11 } } }, title: { display: true, text: 'Vote trend: Ayes vs Nays (PDEX)', color: '#ccc' } },
{ x: demAxis({ stacked: true }), y: demAxis({ stacked: true, beginAtZero: true, maxTicksLimit: 8 }) });
export const democracyTurnoutChartConfig = (refs, animation) => demBars(refs, [{ label: 'Turnout', data: refs.map(r => r.turnout || 0), ...PURPLE }], animation,
    { legend: { display: false } }, { x: demAxis({ maxTicksLimit: 12 }), y: demAxis({ beginAtZero: true, maxTicksLimit: 6 }) });
export const democracyTurnoutPctChartConfig = (refs, issuance, animation) => demBars(refs,
    [{ label: 'Turnout %', data: refs.map(r => issuance > 0 ? (r.turnout / issuance * 100) : 0), ...PURPLE }], animation,
    { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.parsed.y.toFixed(3) + '%' } } },
    { x: demAxis({ maxTicksLimit: 12 }), y: demAxis({ beginAtZero: true, maxTicksLimit: 6, ticks: { color: '#888', callback: v => v + '%' } }) });

// Analytics: one look for the six charts (dark grid, no legend, compact ticks); kind is 'bar' or 'line'.
export function analyticsChartConfig(kind, series, label, color, animation) {
    const dataset = kind === 'bar'
        ? { label, data: series.map(p => p.value), backgroundColor: color, borderColor: color, borderWidth: 0 }
        : { label, data: series.map(p => p.value), borderColor: color, backgroundColor: color + '33', fill: true, tension: 0.3, pointRadius: 2, pointHoverRadius: 4 };
    return {
        type: kind,
        data: { labels: series.map(p => p.day), datasets: [dataset] },
        options: {
            responsive: true, maintainAspectRatio: false, animation,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ' ' + (ctx.dataset.label || '') + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { maximumFractionDigits: 4 }) } }
            },
            scales: {
                x: { ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: 7 }, grid: { color: GRID_LIGHT } },
                y: { beginAtZero: true, ticks: { color: '#888', callback: v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) }, grid: { color: GRID_LIGHT } }
            }
        }
    };
}
