// What the Stake PDEX card signs (design 2026-11-22-stake-card-simple-and-
// advanced.md, sections 9 and 10.1). Stub: the exports exist so the tests
// fail on behaviour; the plan, the amount rules and the builder come next.

export const PLANCK_PER_PDEX = 10n ** 12n;
export const STAKE_FEE_RESERVE_PLANCK = 0n;
export const STAKE_VIEW_KEY = 'pdex_stake_view_v1';
export const STAKE_COPY = Object.freeze({});

export function stakeCopy(id) { throw new Error(`No stake card string ${id}.`); }
export function planckToPdexText() { return ''; }
export function parseAmountPlanck() { return null; }
export function pdexNumberToPlanck() { return 0n; }
export function transferablePlanckOf() { return 0n; }
export function stakeMaxPlanck() { return 0n; }
export function stakeAmountCheck() { return { code: 'ok', planck: null, maxPlanck: 0n, minPlanck: 0n, leftPlanck: null }; }
export function stakeAmountMessage() { return null; }
export function payeeArg() { return null; }
export function planStakeCalls() { return { calls: [], lines: [], primary: null, problems: [] }; }
export function planProblemMessage() { return null; }
export function stakeCalls() { return []; }
export function buildStakeTx(api) { return api.tx.utility.forceBatch([]); }
export function loadStakeView() { return 'simple'; }
export function saveStakeView() { return false; }
