// Council motion templates: the calls the explorer builds and wraps in
// <collective>.propose. Empty since runtime 392: the only two templates were
// treasury.approveProposal and rejectProposal, and pallet-treasury 44 removed
// both. A template may only be added if its call is in the metadata;
// test/motion-templates.test.js checks that against the fixture.
//
// Template shape: { key: 'pallet.method', pallet: 'treasury', method: 'spend' }
// (camelCase method as polkadot-js names it).
export const MOTION_TEMPLATES = [];

// Calls that old motions on chain may still carry but the runtime no longer has.
export const REMOVED_CALLS = [
    { pallet: 'treasury', method: 'approveProposal' },
    { pallet: 'treasury', method: 'rejectProposal' }
];

export const REMOVED_CALL_NOTE = 'This call no longer exists on the current runtime; the motion cannot execute.';

const snake = (s) => String(s).replace(/([A-Z]|\d+)/g, '_$1').toLowerCase();
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// A call as the API returns it: { section, method }, either camelCase or snake_case.
export function isRemovedCall(call) {
    if (!call || !call.section || !call.method) return false;
    return REMOVED_CALLS.some(c => c.pallet === String(call.section).toLowerCase() && snake(c.method) === snake(call.method));
}

// index: Map<PalletName, Set<snake_case call name>> built from the metadata.
// Returns the templates whose call is not in it.
export function missingFromMetadata(templates, index) {
    return templates.filter(t => !(index.get(cap(t.pallet)) && index.get(cap(t.pallet)).has(snake(t.method))));
}
