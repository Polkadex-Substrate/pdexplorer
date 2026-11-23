// Stub for the red commit of the locked balances redesign (WP1): the names the tests import, with no
// behaviour. The model lands in the green commit.
export const LOCK_COPY = Object.freeze({});
export const lockDisplay = () => ({ notes: [], groups: [], summary: null });
export const lockRowState = () => ({});
export const splitStaking = (item) => [item];
export const linkedRows = (rows) => rows || [];
export const lockSummary = () => null;
export const whenText = () => null;
