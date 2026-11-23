// Chart updates without a replay (CEO report 22 Nov: the staking-rewards bars kept refreshing).
// Pure decisions only: no DOM, no Chart.js. Stub: filled in by the green commit.
export function rewardsSeries(data) { return null; }
export function sameSeries(a, b) { return false; }
export function renderKey(data, filter) { return ''; }
export function planChartUpdate(prev, next, opts) { return { action: 'replace', animation: null, updateMode: 'default' }; }
export function applySeries(chartData, series) { return chartData; }
