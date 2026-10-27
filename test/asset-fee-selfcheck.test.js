// Start-up self-check that the asset-fee extension types come from metadata
// (lib/tx-extensions.js checkAssetFeeExtension). Fakes for every branch, plus
// the real registry built from Substrate's metadata, plus source wiring for
// server.js and script.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TypeRegistry, GenericExtrinsic, Metadata } from '@polkadot/types';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import polkadotMetadata from '@polkadot/types-support/metadata/static-polkadot';
import { installPolkadotFixes, checkAssetFeeExtension, describeAssetFeeCheck, apiSpecVersion, assetFeeCheckIsStale } from '../lib/tx-extensions.js';
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
        assert.match(server, /assetFeeCheck\.specVersion = apiSpecVersion\(api\)/);
    });

    test('server re-runs the check after a runtime upgrade, from /api/version and /api/health', () => {
        const cur = server.indexOf('function currentAssetFeeCheck()');
        assert.ok(cur > 0);
        assert.match(server.slice(cur, cur + 300), /assetFeeCheckIsStale\(globalApi, assetFeeCheck\)\) runAssetFeeSelfCheck\(globalApi\)/);
        const version = server.indexOf("app.get('/api/version'");
        const health = server.indexOf("app.get('/api/health'");
        assert.match(server.slice(version, version + 2500), /const c = currentAssetFeeCheck\(\);\s*return c \? \{ ok: c\.ok, status: c\.status, specVersion: c\.specVersion \} : null;/);
        assert.match(server.slice(health, health + 200), /currentAssetFeeCheck\(\)/);
    });

    test('browser runs the check from adoptChainApi and uses console.warn on failure', () => {
        const helper = client.indexOf('function runAssetFeeSelfCheck(api)');
        const adopt = client.indexOf('function adoptChainApi(api)');
        assert.ok(helper > 0 && helper < adopt);
        assert.match(client.slice(helper, adopt), /checkAssetFeeExtension\(api\.registry\)/);
        assert.match(client.slice(helper, adopt), /else console\.warn\(line\)/);
        assert.match(client.slice(adopt, adopt + 800), /runAssetFeeSelfCheck\(api\)/);
    });
});

describe('re-check after a runtime upgrade', () => {
    const api = (spec) => ({ runtimeVersion: spec === undefined ? undefined : { specVersion: { toString: () => String(spec) } } });

    test('apiSpecVersion reads the codec, null when unknown or junk', () => {
        assert.equal(apiSpecVersion(api(373)), 373);
        assert.equal(apiSpecVersion(api(undefined)), null);
        assert.equal(apiSpecVersion(null), null);
        assert.equal(apiSpecVersion(api('x')), null);
        assert.equal(apiSpecVersion({ get runtimeVersion() { throw new Error('not ready'); } }), null);
    });

    test('stale only when the api moved to another spec', () => {
        assert.equal(assetFeeCheckIsStale(api(373), { ok: true, specVersion: 373 }), false);
        assert.equal(assetFeeCheckIsStale(api(392), { ok: true, specVersion: 373 }), true);
        assert.equal(assetFeeCheckIsStale(api(392), null), false, 'no result yet: the connect path runs it');
        assert.equal(assetFeeCheckIsStale(api(undefined), { ok: true, specVersion: 373 }), false);
        assert.equal(assetFeeCheckIsStale(api(392), { ok: true, specVersion: null }), true, 'a result without a spec is re-run once the spec is known');
    });

    test('the log line names the spec it describes', () => {
        assert.match(describeAssetFeeCheck({ ok: true, status: 'ok', message: 'm', specVersion: 392 }, 'server').line,
            /^\[tx-extensions\] server self-check OK \(ok, spec 392\): m$/);
    });

    test('an in-place metadata swap (what the api does at enactment) is re-checked against the new metadata', () => {
        // Polkadot relay metadata (plain ChargeTransactionPayment: status absent)
        // swapped in place for Substrate's (ChargeAssetTxPayment: status ok),
        // the same registry object, as @polkadot/api 17 does on an upgrade
        // (api/base/Init.js _subscribeUpdates -> _initRegistry -> setMetadata).
        const registry = registryFromMetadata(polkadotMetadata);
        const live = { runtimeVersion: { specVersion: { toString: () => '373' } }, registry };
        let last = { ...checkAssetFeeExtension(registry), specVersion: apiSpecVersion(live) };
        assert.equal(last.status, 'absent');
        live.runtimeVersion = { specVersion: { toString: () => '392' } };
        registry.setMetadata(new Metadata(registry, substrateMetadata));
        assert.equal(assetFeeCheckIsStale(live, last), true);
        last = { ...checkAssetFeeExtension(live.registry), specVersion: apiSpecVersion(live) };
        assert.equal(last.status, 'ok', last.message);
        assert.match(last.expected, /^Lookup\d+$/);
        assert.equal(last.specVersion, 392);
        assert.equal(assetFeeCheckIsStale(live, last), false);
    });
});
