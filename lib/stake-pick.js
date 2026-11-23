// The automatic validator choice for the Stake PDEX card (design
// 2026-11-22-stake-card-simple-and-advanced.md, section 4). Stub: the exports
// exist so test/stake-pick.test.js fails on behaviour; the rule comes next.

export const PICK_COUNT = 8;
export const PICK_WINDOW = 28;
export const LOW_RETURN_RATIO = 0.75;
export const GATES = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
export const UNHEALTHY = Object.freeze(['inactive', 'commission100', 'blocked', 'no-history', 'low-return', 'slashed']);

const zero = () => Object.fromEntries(GATES.map(g => [g, 0]));
export function medianOf() { return null; }
export function pickValidators() { return { status: 'none', picks: [], median: null, pool: 0, rejected: zero() }; }
export function reviewNominations() { return { rows: [], unhealthy: 0, keep: [] }; }
export function proposeReplacement() { return { offer: false, status: 'none', kept: [], removed: [], added: [], targets: [] }; }
export function returnEstimate() { return { none: 'no-data' }; }
