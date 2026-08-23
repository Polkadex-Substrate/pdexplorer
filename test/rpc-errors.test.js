// Regression tests for lib/rpc-errors.js.
//
// These exist because of real, permanent data loss. Three governance blocks
// (472,223 / 473,207 / 473,599) reached attempts=10 and were retired forever
// with last_error "Cannot read properties of null (reading 'rpc')" — a node
// disconnect, not a bad block. Every one of those ten attempts should have
// been free.
//
// The two directions that matter:
//   false negative — a transport error not recognised → attempts burn → a
//                    perfectly good block is abandoned (the outage above)
//   false positive — a genuine decode failure treated as transport → the block
//                    is retried forever and never surfaces as Degraded
// The exact strings observed in production are asserted verbatim.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isRpcUnavailableError, rpcUnavailableLikePatterns, RPC_UNAVAILABLE_PATTERNS } from '../lib/rpc-errors.js';

describe('isRpcUnavailableError — errors observed in production', () => {
    const transport = [
        "Cannot read properties of null (reading 'rpc')",
        'rpc not ready (disconnected mid-fetch)',
        'WebSocket is not connected',
        'disconnected from wss://rpc.polkadex.ee',
        'connection dropped',
        'socket hang up',
        'connect ECONNREFUSED 127.0.0.1:9944',
        'read ECONNRESET',
        'connect ETIMEDOUT'
    ];

    for (const message of transport) {
        test(`treats as transport: ${message}`, () => {
            assert.equal(isRpcUnavailableError(new Error(message)), true);
        });
    }

    test('matches case-insensitively', () => {
        // Substrate, the ws library and Node all capitalise differently.
        assert.equal(isRpcUnavailableError(new Error('RPC NOT READY')), true);
        assert.equal(isRpcUnavailableError(new Error('websocket is not connected')), true);
    });

    test('accepts a bare string as well as an Error', () => {
        assert.equal(isRpcUnavailableError('socket hang up'), true);
    });
});

describe('isRpcUnavailableError — must NOT swallow real data errors', () => {
    const dataErrors = [
        'Unable to decode Vec<EventRecord>: createType(Vec<EventRecord>):: Struct: failed on args',
        'createType(Header):: Expected 32 bytes',
        'Unknown pallet ocex',
        'Block not found',
        'Verification Error: Runtime error',
        'wasm trap: unreachable'
    ];

    for (const message of dataErrors) {
        test(`treats as a data problem: ${message.slice(0, 44)}`, () => {
            // If any of these were classified as transport, the block would be
            // retried indefinitely and never reported as Degraded.
            assert.equal(isRpcUnavailableError(new Error(message)), false);
        });
    }

    test('null, undefined and empty are not transport errors', () => {
        assert.equal(isRpcUnavailableError(null), false);
        assert.equal(isRpcUnavailableError(undefined), false);
        assert.equal(isRpcUnavailableError(''), false);
        assert.equal(isRpcUnavailableError(new Error('')), false);
    });
});

describe('rpcUnavailableLikePatterns — the retro-active rescue query', () => {
    test('wraps every pattern for SQL LIKE', () => {
        const patterns = rpcUnavailableLikePatterns();
        assert.equal(patterns.length, RPC_UNAVAILABLE_PATTERNS.length);
        for (const p of patterns) {
            assert.ok(p.startsWith('%') && p.endsWith('%'), `${p} is not LIKE-wrapped`);
        }
    });

    test('the pattern that would have rescued the three lost blocks is present', () => {
        assert.ok(rpcUnavailableLikePatterns().includes("%reading 'rpc'%"));
    });

    test('patterns are lowercase, matching the lowercasing in isRpcUnavailableError', () => {
        // A mixed-case pattern would work in isRpcUnavailableError (which
        // lowercases the message) but silently fail against last_error rows
        // compared with LOWER() in SQL.
        for (const p of RPC_UNAVAILABLE_PATTERNS) {
            assert.equal(p, p.toLowerCase(), `${p} must be lowercase`);
        }
    });
});
