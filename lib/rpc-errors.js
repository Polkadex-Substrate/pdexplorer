// Which indexer errors mean "the node was unavailable" rather than "this
// block is bad"?
//
// This distinction cost real data. The scanners record a scan failure in their
// catch block and bump an attempt counter; at SCAN_MAX_ATTEMPTS (10) a block is
// abandoned permanently. But a chain RPC disconnect throws in exactly the same
// place as a genuinely undecodable block — so ten unlucky disconnects retired
// three governance blocks forever (472,223 / 473,207 / 473,599, June 2026),
// with last_error values of "rpc not ready (disconnected mid-fetch)" and
// "Cannot read properties of null (reading 'rpc')".
//
// A node being down says nothing about a block. Those attempts must not count.

export const RPC_UNAVAILABLE_PATTERNS = [
    'rpc not ready',
    "reading 'rpc'",            // TypeError: Cannot read properties of null (reading 'rpc')
    'websocket is not connected',
    'disconnected from',
    'connection dropped',
    'socket hang up',
    'econnrefused',
    'econnreset',
    'etimedout'
];

// True when the error describes the transport, not the data.
export function isRpcUnavailableError(err) {
    const msg = String(
        err && err.message ? err.message : (err == null ? '' : err)
    ).toLowerCase();
    if (!msg) return false;
    return RPC_UNAVAILABLE_PATTERNS.some(p => msg.includes(p));
}

// SQL LIKE patterns for retro-actively rescuing rows that were abandoned for
// transport reasons before the fix above existed.
export function rpcUnavailableLikePatterns() {
    return RPC_UNAVAILABLE_PATTERNS.map(p => `%${p}%`);
}
