// The live paths assume runtime spec 392 or later (lib/live-runtime.js) and
// refuse an older node with one readable error. History is not gated: old
// blocks are still decoded with their own runtime (tested in the fixture
// suites, which keep the 373 metadata).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiPromise } from '@polkadot/api';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { MIN_LIVE_SPEC, liveRuntimeStatus, liveRuntimeError, describeLiveRuntime, staleRuntimeMessage } from '../lib/live-runtime.js';
import { installPolkadotFixes } from '../lib/tx-extensions.js';
import { mockProvider } from './helpers/mock-provider.js';
import { loadFixture } from './helpers/extrinsic-builders.js';
import { stripComments } from './helpers/source.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

const fakeApi = (spec) => ({ runtimeVersion: spec === undefined ? undefined : { specVersion: { toString: () => String(spec) } } });

describe('liveRuntimeStatus / liveRuntimeError', () => {
    test('the minimum is 392', () => {
        assert.equal(MIN_LIVE_SPEC, 392);
    });

    test('spec 392 and later are live; nothing to report', () => {
        for (const spec of [392, 393, 400]) {
            const s = liveRuntimeStatus(fakeApi(spec));
            assert.equal(s.ok, true, `spec ${spec}`);
            assert.equal(s.status, 'ok');
            assert.equal(s.specVersion, spec);
            assert.equal(liveRuntimeError(fakeApi(spec)), null);
        }
    });

    test('spec 373 is stale, with one readable message', () => {
        const s = liveRuntimeStatus(fakeApi(373));
        assert.deepEqual({ ok: s.ok, status: s.status, specVersion: s.specVersion, minSpec: s.minSpec },
            { ok: false, status: 'stale', specVersion: 373, minSpec: 392 });
        const msg = liveRuntimeError(fakeApi(373));
        assert.equal(msg, 'The Polkadex node in use reports runtime spec 373, older than spec 392, which mainnet has run since '
            + '29 October 2026. That node is out of date or still syncing. Nothing was signed or sent. Reload the page to '
            + 'reconnect; if this keeps happening, the node needs to catch up.');
        assert.doesNotMatch(msg, /[^\x00-\x7F]/, 'ASCII only, no em or en dashes');
        assert.doesNotMatch(msg, /\n/, 'one line');
    });

    test('391 is stale too (the boundary)', () => {
        assert.equal(liveRuntimeStatus(fakeApi(391)).status, 'stale');
        assert.equal(liveRuntimeStatus(fakeApi(392)).status, 'ok');
    });

    test('no runtime version yet: refused as not ready, not as stale', () => {
        for (const api of [null, undefined, {}, fakeApi(undefined), fakeApi('x'), fakeApi(0)]) {
            const s = liveRuntimeStatus(api);
            assert.equal(s.ok, false);
            assert.equal(s.status, 'unknown');
            assert.match(liveRuntimeError(api), /not ready yet .*Nothing was signed or sent/);
        }
    });

    test('log lines', () => {
        assert.deepEqual(describeLiveRuntime(liveRuntimeStatus(fakeApi(392)), 'server'),
            { level: 'log', line: '[runtime] server live runtime OK (spec 392, minimum 392)' });
        const bad = describeLiveRuntime(liveRuntimeStatus(fakeApi(373)), 'browser');
        assert.equal(bad.level, 'loud');
        assert.equal(bad.line, '[runtime] browser live runtime FAILED (stale): ' + staleRuntimeMessage(373));
    });
});

// A REAL ApiPromise, booted through a mock provider that reports the given
// spec: the check reads what the library actually exposes.
const sources = [{ label: 'Substrate metadata', hex: substrateMetadata }];
const fx392 = loadFixture('metadata-392.json');
if (fx392) sources.push({ label: `Polkadex spec ${fx392.specVersion} (metadata-392.json)`, hex: fx392.metadata });

for (const src of sources) {
    describe(`a real ApiPromise on ${src.label}`, () => {
        for (const [spec, expectOk] of [[373, false], [392, true]]) {
            test(`node reporting spec ${spec}: ${expectOk ? 'live' : 'refused'}`, async () => {
                const m = mockProvider({ metadataHex: src.hex, specVersion: spec });
                const api = await ApiPromise.create({ provider: m.provider, noInitWarn: true });
                try {
                    assert.equal(api.runtimeVersion.specVersion.toNumber(), spec);
                    const err = liveRuntimeError(api);
                    if (expectOk) assert.equal(err, null);
                    else assert.match(err, /reports runtime spec 373, older than spec 392/);
                } finally { await api.disconnect(); }
            });
        }
    });
}

describe('wiring', () => {
    const script = stripComments(readFileSync(new URL('../script.js', import.meta.url), 'utf8'));
    const server = stripComments(readFileSync(new URL('../server.js', import.meta.url), 'utf8'));

    test('browser: signing checks the runtime before the wallet is asked anything', () => {
        const fn = script.slice(script.indexOf('async function resolveWalletSigner'), script.indexOf('async function submitSignedTx'));
        const gate = fn.indexOf('liveRuntimeError(globalApi)');
        assert.ok(gate > 0, 'resolveWalletSigner no longer checks the runtime');
        assert.match(fn, /if \(staleRuntime\) return fail\(staleRuntime\)/);
        assert.ok(gate < fn.indexOf('getInjectedAccounts('), 'the check must come before the wallet extension is touched');
        assert.ok(gate < fn.indexOf('.enable('), 'the check must come before the wallet authorization');
    });

    test('browser: the status pill says when the node is out of date', () => {
        const adopt = script.slice(script.indexOf('function adoptChainApi'), script.indexOf('function markNodeLinkOffline'));
        assert.match(adopt, /runLiveRuntimeCheck\(api\)/);
        assert.match(script, /networkStatusText\.innerText = 'Node out of date'/);
    });

    test('server: checked on connect, re-checked when the spec changes, on /api/version', () => {
        const connect = server.slice(server.indexOf('newApi = await ApiPromise.create'), server.indexOf("globalApi.on('disconnected'"));
        assert.match(connect, /runLiveRuntimeCheck\(newApi\)/);
        assert.match(server, /apiSpecVersion\(globalApi\) !== liveRuntime\.specVersion\)\) runLiveRuntimeCheck\(globalApi\)/);
        const version = server.slice(server.indexOf("app.get('/api/version'"), server.indexOf("app.get('/api/version'") + 3000);
        assert.match(version, /liveRuntime: \(\(\) => \{/);
        assert.match(version, /minSpec: l\.minSpec/);
    });

    test('tools/rpc-health.mjs fails a node below the minimum spec', () => {
        const tool = stripComments(readFileSync(new URL('../tools/rpc-health.mjs', import.meta.url), 'utf8'));
        assert.match(tool, /import \{ MIN_LIVE_SPEC \} from '\.\.\/lib\/live-runtime\.js'/);
        assert.match(tool, /if \(s\.specVersion < MIN_LIVE_SPEC\) fail\(label,/);
    });

    test('signing no longer falls back to the pre-392 balances.transfer', () => {
        const ws = stripComments(readFileSync(new URL('../lib/wallet-safety.js', import.meta.url), 'utf8'));
        assert.doesNotMatch(ws, /t\.transfer\(/);
    });
});
