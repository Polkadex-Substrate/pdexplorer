// The /validate page in the REAL index.html and script.js (happy-dom, one page
// load per child process: test/helpers/full-page.js). Sprint 1 of the validator
// onboarding design (cto-team/plans/2026-11-17-validator-onboarding-design.md,
// section 7): behind FEATURE_FLAGS.validate, off by default, ?validate=1 per
// browser. With the flag off there is no nav entry and the routes render the
// not-found page; with it on, /validate shows the connected wallet's status
// and /validate/<address> any stash.
//
// Synthetic accounts: 32 bytes of one repeated value. They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeAddress } from '@polkadot/util-crypto';
import { WALLET_KEYS } from '../lib/wallet-session.js';

const RUNNER = fileURLToPath(new URL('./helpers/full-page.js', import.meta.url));
const addr = (n, prefix = 88) => encodeAddress(new Uint8Array(32).fill(n), prefix);
const A = addr(81), B = addr(82);
const remembered = (a, src) => ({ [WALLET_KEYS.address]: a, [WALLET_KEYS.source]: src, [WALLET_KEYS.lastSource]: src, [WALLET_KEYS.lastUsed]: a });
const PARAMS = { specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 }, minValidatorBond: '123000000000000', minCommission: 0, maxValidatorsCount: null };
const STATUS = (a) => ({ address: a, state: 'waiting', headline: 'Waiting. Not elected for era 500.', pill: { word: 'Waiting', tone: 'neutral' }, rows: [], era: {}, session: {}, limits: {} });
const NAV = '#nav-validate';
const API = { '/api/validator/params': PARAMS, [`/api/validator/${A}/status`]: STATUS(A), [`/api/validator/${B}/status`]: STATUS(B) };

function page(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [RUNNER, JSON.stringify({ api: API, probe: [NAV, '#validate-root .validate-headline'], ...scenario })], { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            const line = String(stdout).split('\n').find(l => l.startsWith('RESULT '));
            if (!line) return reject(new Error('the page did not report: ' + (err ? err.message : '') + '\n' + String(stderr).slice(-2000)));
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

describe('flag off (the default)', () => {
    test('/validate is the not-found page, the nav entry stays hidden, nothing is fetched for it', async () => {
        const r = await page({ path: 'validate' });
        assert.equal(r.page, 'not-found');
        assert.deepEqual([r.probe[NAV].count, r.probe[NAV].shown], [1, 0]);
        assert.ok(!r.fetched.some(u => u.includes('/api/validator/params')));
    });
    test('/validate/<address> too', async () => {
        const r = await page({ path: 'validate/' + B });
        assert.equal(r.page, 'not-found');
    });
});

describe('flag on in this browser', () => {
    test('?validate=1 turns it on: the page, the nav entry, and the choice is remembered', async () => {
        const r = await page({ path: 'validate?validate=1' });
        assert.equal(r.page, 'validate');
        assert.equal(r.probe[NAV].shown, 1);
        assert.ok(r.fetched.includes('/api/validator/params'));
    });
    test('remembered (pdex_validate_enabled=1): /validate/<address> shows that stash', async () => {
        const r = await page({ path: 'validate/' + B, seed: { pdex_validate_enabled: '1' } });
        assert.equal(r.page, 'validate');
        assert.ok(r.fetched.includes(`/api/validator/${B}/status`));
        assert.match(r.probe['#validate-root .validate-headline'].text, /Waiting\. Not elected for era 500\./);
    });
    test('a connected wallet: /validate defaults to it', async () => {
        const r = await page({ path: 'validate', seed: { pdex_validate_enabled: '1', ...remembered(A, 'talisman') }, wallets: { talisman: [addr(81, 42)] }, steps: [{ wait: 300 }] });
        assert.equal(r.page, 'validate');
        assert.ok(r.fetched.includes(`/api/validator/${A}/status`), r.fetched.filter(u => u.includes('validator')).join(', '));
    });
    test('?validate=0 turns it off again', async () => {
        const r = await page({ path: 'validate?validate=0', seed: { pdex_validate_enabled: '1' } });
        assert.equal(r.page, 'not-found');
        assert.equal(r.probe[NAV].shown, 0);
    });
});
