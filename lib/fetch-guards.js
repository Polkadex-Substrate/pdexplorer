// Small decisions for scripts/fetch-metadata.mjs, kept import-free so tests
// can load them without a network or a node.

// A pruned node answers state_* calls at an old block with an error such as
// "Api called for an unknown Block: State already discarded for 0x...".
export function isStateUnavailableError(err) {
    const message = typeof err === 'string' ? err : (err && err.message) || '';
    return /state already discarded|unknown ?block/i.test(message);
}

// Whether a target should be fetched. A plain run (no --only) leaves an
// existing history fixture alone; --only always refetches; the current
// runtime target is always fetched.
export function shouldFetchTarget({ isHistoryTarget, onlyFlag, fileExists }) {
    if (isHistoryTarget && !onlyFlag && fileExists) return { fetch: false, reason: 'kept-existing' };
    return { fetch: true, reason: null };
}
