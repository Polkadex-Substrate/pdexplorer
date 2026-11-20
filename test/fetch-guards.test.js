// lib/fetch-guards.js and its wiring in scripts/fetch-metadata.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isStateUnavailableError, shouldFetchTarget } from '../lib/fetch-guards.js';
import { stripComments } from './helpers/source.js';

describe('isStateUnavailableError', () => {
    test('recognises the pruned-state messages, case-insensitively', () => {
        assert.equal(isStateUnavailableError('Client error: Api called for an unknown Block: State already discarded for 0xd2a58c'), true);
        assert.equal(isStateUnavailableError('state already discarded'), true);
        assert.equal(isStateUnavailableError('Api called for an unknown Block'), true);
        assert.equal(isStateUnavailableError('UnknownBlock: State already discarded'), true);
        assert.equal(isStateUnavailableError('UNKNOWNBLOCK'), true);
    });
    test('accepts an Error object as well as a string', () => {
        assert.equal(isStateUnavailableError(new Error('State already discarded for 0x01')), true);
    });
    test('other errors, empty and missing input are not state errors', () => {
        assert.equal(isStateUnavailableError('connection closed'), false);
        assert.equal(isStateUnavailableError('Method not found'), false);
        assert.equal(isStateUnavailableError(''), false);
        assert.equal(isStateUnavailableError(null), false);
        assert.equal(isStateUnavailableError(undefined), false);
    });
});

describe('shouldFetchTarget', () => {
    test('a plain run keeps an existing history fixture', () => {
        assert.deepEqual(shouldFetchTarget({ isHistoryTarget: true, onlyFlag: null, fileExists: true }), { fetch: false, reason: 'kept-existing' });
    });
    test('a plain run fetches the history fixture when it is missing', () => {
        assert.equal(shouldFetchTarget({ isHistoryTarget: true, onlyFlag: null, fileExists: false }).fetch, true);
    });
    test('--only always refetches', () => {
        assert.equal(shouldFetchTarget({ isHistoryTarget: true, onlyFlag: '373', fileExists: true }).fetch, true);
    });
    test('the current-runtime target is never skipped', () => {
        assert.equal(shouldFetchTarget({ isHistoryTarget: false, onlyFlag: null, fileExists: true }).fetch, true);
        assert.equal(shouldFetchTarget({ isHistoryTarget: false, onlyFlag: '392', fileExists: true }).fetch, true);
    });
});

describe('scripts/fetch-metadata.mjs wiring', () => {
    const src = stripComments(readFileSync(new URL('../scripts/fetch-metadata.mjs', import.meta.url), 'utf8'));
    test('uses the guards: the walk stops on pruned state, the history fixture is kept', () => {
        assert.match(src, /from '\.\.\/lib\/fetch-guards\.js'/);
        assert.match(src, /isStateUnavailableError\(/);
        assert.match(src, /scan stopped there/);
        assert.match(src, /shouldFetchTarget\(/);
        assert.match(src, /kept existing/);
        assert.match(src, /pass --only 373 to refetch/);
    });
    test('the kept-existing decision comes before state_getMetadata', () => {
        assert.ok(src.indexOf('shouldFetchTarget(') < src.indexOf("'state_getMetadata'"));
    });
    test('the v5-missing check still runs after the walk', () => {
        assert.ok(src.indexOf('scan stopped there') < src.indexOf('v5MissingMessage('));
    });
});
