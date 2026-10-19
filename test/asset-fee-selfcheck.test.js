// Start-up self-check that the asset-fee extension types come from metadata
// (lib/tx-extensions.js checkAssetFeeExtension). Fakes for every branch, plus
// the real registry built from Substrate's metadata, plus source wiring for
// server.js and script.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { installPolkadotFixes, checkAssetFeeExtension, describeAssetFeeCheck } from '../lib/tx-extensions.js';
import { registryFromMetadata } from './helpers/extrinsic-builders.js';
import { stripComments } from './helpers/source.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

function fakeRegistry({ listed = true, assetId = 'Lookup12', alias = 'Option<NativeOrWithId>', typeRaw = 'Option<NativeOrWithId>', throwOn = null } = {}) {
    return {
        signedExtensions: listed ? ['CheckNonce', 'ChargeAssetTxPayment'] : ['CheckNonce'],
        getSignedExtensionTypes: () => { if (throwOn === 'types') throw new Error('boom'); return { tip: 'Compact<u128>', assetId }; },
        createType: (name) => ({ toRawType: () => (name === 'TAssetConversion' ? alias : typeRaw) })
    };
}
const deriveTo = (assetId) => () => ({
    overrides: assetId ? { ChargeAssetTxPayment: { extrinsic: { tip: 'Compact<u128>', assetId }, payload: {} } } : {},
    assetConversionType: assetId
});

describe('checkAssetFeeExtension with fakes', () => {
    test('metadata type in use: ok', () => {
        const r = checkAssetFeeExtension(fakeRegistry(), { derive: deriveTo('Lookup12') });
        assert.equal(r.ok, true);
        assert.equal(r.status, 'ok');
        assert.equal(r.expected, 'Lookup12');
    });

    test('library table still in use (assetId is Option<MultiLocation>): mismatch, not ok', () => {
        const r = checkAssetFeeExtension(
            fakeRegistry({ assetId: 'Option<MultiLocation>', alias: 'Option<StagingXcmV4Location>' }),
            { derive: deriveTo('Lookup12') });
        assert.equal(r.ok, false);
        assert.equal(r.status, 'mismatch');
        assert.match(r.message, /Option<MultiLocation> but metadata says Lookup12/);
    });

    test('signer alias left on the library type while the extension is right: mismatch', () => {
        const r = checkAssetFeeExtension(
            fakeRegistry({ alias: 'Option<MultiLocation>', typeRaw: 'Option<NativeOrWithId>' }),
            { derive: deriveTo('Lookup12') });
        assert.equal(r.ok, false);
        assert.equal(r.status, 'mismatch');
        assert.match(r.message, /TAssetConversion/);
    });

    test('runtime without ChargeAssetTxPayment: absent, counts as ok', () => {
        const r = checkAssetFeeExtension(fakeRegistry({ listed: false }), { derive: deriveTo(null) });
        assert.equal(r.ok, true);
        assert.equal(r.status, 'absent');
    });

    test('listed in metadata but not derivable: not ok', () => {
        const r = checkAssetFeeExtension(fakeRegistry({ listed: true }), { derive: deriveTo(null) });
        assert.equal(r.ok, false);
        assert.equal(r.status, 'underivable');
    });

    test('a throwing registry never throws out of the check', () => {
        const r = checkAssetFeeExtension(fakeRegistry({ throwOn: 'types' }), { derive: deriveTo('Lookup12') });
        assert.equal(r.ok, false);
        assert.equal(r.status, 'error');
        assert.match(r.message, /boom/);
        const r2 = checkAssetFeeExtension(null);
        assert.equal(r2.ok, false);
        assert.equal(r2.status, 'error');
    });

    test('describeAssetFeeCheck: one line, log when ok and loud when not', () => {
        const ok = describeAssetFeeCheck({ ok: true, status: 'ok', message: 'fine' }, 'server');
        assert.equal(ok.level, 'log');
        const bad = describeAssetFeeCheck({ ok: false, status: 'mismatch', message: 'bad' }, 'browser');
        assert.equal(bad.level, 'loud');
        for (const x of [ok, bad]) assert.doesNotMatch(x.line, /\n/);
        assert.match(bad.line, /browser self-check FAILED \(mismatch\): bad/);
    });
});

describe('checkAssetFeeExtension on a real registry', () => {
    test('Substrate metadata with the fixes installed: ok, resolves to the metadata type', () => {
        const registry = registryFromMetadata(substrateMetadata);
        const r = checkAssetFeeExtension(registry);
        assert.equal(r.status, 'ok', r.message);
        assert.equal(r.ok, true);
        assert.match(r.expected, /^Lookup\d+$/);
        assert.doesNotMatch(r.aliasRaw, /MultiLocation|Junctions/);
    });

    test('the same registry with the override undone is caught', () => {
        const registry = registryFromMetadata(substrateMetadata);
        // Simulate the stock table: point the alias back at the library type.
        registry.register({ TAssetConversion: 'Option<MultiLocation>' });
        const r = checkAssetFeeExtension(registry);
        assert.equal(r.ok, false);
        assert.equal(r.status, 'mismatch');
    });
});

describe('wiring', () => {
    const server = stripComments(readFileSync(new URL('../server.js', import.meta.url), 'utf8'));
    const client = stripComments(readFileSync(new URL('../script.js', import.meta.url), 'utf8'));

    test('server runs the check right after globalApi is assigned, errors loudly, flags /api/version', () => {
        const assign = server.indexOf('globalApi = newApi;');
        const call = server.indexOf('runAssetFeeSelfCheck(newApi);');
        assert.ok(assign > 0 && call > assign && call - assign < 120, 'check must follow the assignment');
        assert.match(server, /console\.error\(line\)/);
        assert.match(server, /assetFeeCheck: assetFeeCheck/);
    });

    test('browser runs the check in adoptChainApi and uses console.warn on failure', () => {
        const fn = client.indexOf('function adoptChainApi(api)');
        const call = client.indexOf('checkAssetFeeExtension(api.registry)');
        assert.ok(fn > 0 && call > fn && call - fn < 600);
        assert.match(client, /else console\.warn\(line\)/);
    });
});
