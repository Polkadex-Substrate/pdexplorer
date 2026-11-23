// R4 (red): declarations only. The governance and treasury pages after an action.
export const ELECTIONS = 'council.elections';
export const GOV_PAGES = Object.freeze({
    council: Object.freeze(['council.motions', 'council.elections', 'technicalCommittee.motions']),
    democracy: Object.freeze(['democracy']),
    treasury: Object.freeze(['treasury.overview'])
});
export function electionsOverlay(data) { return data; }
export function mergeCouncilFreshness(fc) { return fc || null; }
export async function readCandidacy() { return { ok: false }; }
export function createRefreshIndicator() { return { set() {}, paint() {}, reorg() {}, reset() {} }; }
export function createGovRefresh() { return { overlay: (page, data) => data, paint() {} }; }
