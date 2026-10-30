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
import { MIN_LIVE_SPEC, liveRuntimeStatus, liveRuntimeStatusForVersion, followRuntimeVersion, liveRuntimeError, describeLiveRuntime, staleRuntimeMessage } from '../lib/live-runtime.js';
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

    test('browser: the pill follows the node runtime version subscription, not isReady or the provider event', () => {
        const watch = script.slice(script.indexOf('function watchRuntimeVersion'), script.indexOf('function adoptChainApi'));
        assert.match(watch, /followRuntimeVersion\(api, \(version\) => \{ runLiveRuntimeCheck\(api, version\); \}\)/);
        assert.match(watch, /addEventListener\('pagehide', stop/);
        assert.doesNotMatch(script, /isReady\)\.then\(\(\) => runLiveRuntimeCheck/);
        assert.doesNotMatch(script, /watchProviderReconnects/);
        const adopt = script.slice(script.indexOf('function adoptChainApi'), script.indexOf('function markNodeLinkOffline'));
        assert.match(adopt, /watchRuntimeVersion\(api\)/);
        const check = script.slice(script.indexOf('function runLiveRuntimeCheck'), script.indexOf('function setNodeConnectedStatus'));
        assert.match(check, /liveRuntimeStatusForVersion\(version\)/);
        assert.match(check, /=== 'Node out of date'\) setNodeConnectedStatus\(\)/);
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

// ---- the subscription: a node reporting 373, then 392, then 373 -----------

const specValue = (n) => ({ specVersion: { toString: () => String(n), toNumber: () => n } });

// A mock api whose runtime version subscription the test drives by hand.
function subscribableApi({ startSpec = 392 } = {}) {
    const subs = [];
    const api = {
        runtimeVersion: specValue(startSpec),   // never updated: like polkadot.js after a reconnect
        disconnects: 0,
        async disconnect() { this.disconnects++; return 'bye'; },
        rpc: { state: { subscribeRuntimeVersion(cb) {
            assert.equal(this, api.rpc.state, 'must be called as a method of state, not detached');
            const sub = { cb, unsubscribed: 0 };
            subs.push(sub);
            const unsub = () => { sub.unsubscribed++; };
            return Promise.resolve(unsub);
        } } }
    };
    return { api, subs };
}

describe('liveRuntimeStatusForVersion', () => {
    test('reads the spec from the value it is given', () => {
        assert.equal(liveRuntimeStatusForVersion(specValue(373)).status, 'stale');
        assert.equal(liveRuntimeStatusForVersion(specValue(392)).status, 'ok');
        assert.equal(liveRuntimeStatusForVersion(specValue(392)).specVersion, 392);
        for (const v of [null, undefined, {}, specValue('x')]) assert.equal(liveRuntimeStatusForVersion(v).status, 'unknown');
    });
});

describe('followRuntimeVersion', () => {
    const tick = () => new Promise((r) => setImmediate(r));

    test('reports each spec change from the callback value, not from api.runtimeVersion', async () => {
        const { api, subs } = subscribableApi({ startSpec: 392 });
        const seen = [];
        followRuntimeVersion(api, (v, spec) => seen.push([spec, liveRuntimeStatusForVersion(v).status]));
        assert.equal(subs.length, 1);
        subs[0].cb(specValue(392));   // the first value equals what the api reports: no repeat
        subs[0].cb(specValue(373));
        subs[0].cb(specValue(373));   // same spec again: no repeat
        subs[0].cb(specValue(392));
        subs[0].cb(specValue(373));
        assert.deepEqual(seen, [[373, 'stale'], [392, 'ok'], [373, 'stale']]);
        assert.equal(api.runtimeVersion.specVersion.toNumber(), 392, 'api.runtimeVersion stayed stale, as after a reconnect');
    });

    test('set up once per api: a second call returns the same handle and subscribes nothing more', () => {
        const { api, subs } = subscribableApi();
        const h1 = followRuntimeVersion(api, () => {});
        const h2 = followRuntimeVersion(api, () => {});
        assert.equal(h1, h2);
        assert.equal(subs.length, 1);
        const other = subscribableApi();
        followRuntimeVersion(other.api, () => {});
        assert.equal(other.subs.length, 1, 'a different api gets its own');
    });

    test('stop() unsubscribes once, and nothing is reported after it', async () => {
        const { api, subs } = subscribableApi();
        const seen = [];
        const h = followRuntimeVersion(api, (v, spec) => seen.push(spec));
        await tick();
        h.stop(); h.stop();
        assert.equal(subs[0].unsubscribed, 1);
        subs[0].cb(specValue(373));
        assert.deepEqual(seen, []);
    });

    test('stop() before the subscription is confirmed still unsubscribes it', async () => {
        const { api, subs } = subscribableApi();
        const h = followRuntimeVersion(api, () => {});
        h.stop();
        await tick();
        assert.equal(subs[0].unsubscribed, 1);
    });

    test('api.disconnect() is teardown: unsubscribes, and still disconnects the api with its result', async () => {
        const { api, subs } = subscribableApi();
        followRuntimeVersion(api, () => {});
        await tick();
        assert.equal(await api.disconnect(), 'bye');
        assert.equal(api.disconnects, 1);
        assert.equal(subs[0].unsubscribed, 1);
        // Detached (unbound) use still reaches the api.
        const { api: api2 } = subscribableApi();
        followRuntimeVersion(api2, () => {});
        const detached = api2.disconnect;
        assert.equal(await detached(), 'bye');
        assert.equal(api2.disconnects, 1);
    });

    test('never throws: no api, no subscription method, a throwing subscribe, a throwing listener', async () => {
        for (const api of [null, undefined, 5, {}, { rpc: {} }, { rpc: { state: {} } }]) {
            assert.doesNotThrow(() => followRuntimeVersion(api, () => {}).stop());
        }
        const thrower = { rpc: { state: { subscribeRuntimeVersion() { throw new Error('nope'); } } } };
        assert.doesNotThrow(() => followRuntimeVersion(thrower, () => {}).stop());
        const rejecter = { rpc: { state: { subscribeRuntimeVersion() { return Promise.reject(new Error('refused')); } } } };
        followRuntimeVersion(rejecter, () => {});
        await tick();
        const { api, subs } = subscribableApi();
        const seen = [];
        followRuntimeVersion(api, (v, spec) => { seen.push(spec); throw new Error('listener bug'); });
        subs[0].cb(specValue(373));
        subs[0].cb(specValue(392));
        assert.deepEqual(seen, [373, 392], 'the subscription outlives a failing listener');
    });
});

// The REAL script.js pill code, run against stub DOM elements and a mock api
// that reports 373, then 392, then 373.
describe('browser pill follows the node (script.js code, mock api)', () => {
    const raw = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
    const fn = (name, next) => raw.slice(raw.indexOf(`function ${name}(`), raw.indexOf(next));
    const code = [
        fn('runLiveRuntimeCheck', 'function setNodeConnectedStatus'),
        fn('setNodeConnectedStatus', '// Keep the pill true'),
        fn('watchRuntimeVersion', 'function adoptChainApi')
    ].join('\n');

    function harness(api) {
        const pill = { innerText: 'Polkadex Connected', title: '' };
        const dot = { classList: { add() {}, remove() {} }, style: {} };
        const logs = [];
        const con = { log: (l) => logs.push(['log', l]), error: (l) => logs.push(['error', l]), warn: (l) => logs.push(['warn', l]) };
        const win = { addEventListener() {} };
        const make = new Function('networkStatusText', 'statusIndicator', 'console', 'window',
            'liveRuntimeStatus', 'liveRuntimeStatusForVersion', 'describeLiveRuntime', 'followRuntimeVersion',
            code + '\nreturn { runLiveRuntimeCheck, watchRuntimeVersion };');
        const fns = make(pill, dot, con, win, liveRuntimeStatus, liveRuntimeStatusForVersion, describeLiveRuntime, followRuntimeVersion);
        return { pill, logs, ...fns };
    }

    test('373 -> 392 -> 373: the pill text follows, whatever api.runtimeVersion says', async () => {
        const { api, subs } = subscribableApi({ startSpec: 392 });   // api.runtimeVersion stays 392 throughout
        const h = harness(api);
        h.runLiveRuntimeCheck(api);   // adoptChainApi's first check, on 392
        h.watchRuntimeVersion(api);
        assert.equal(h.pill.innerText, 'Polkadex Connected');
        subs[0].cb(specValue(373));
        assert.equal(h.pill.innerText, 'Node out of date');
        assert.match(h.pill.title, /spec 373/);
        subs[0].cb(specValue(392));
        assert.equal(h.pill.innerText, 'Polkadex Connected');
        assert.equal(h.pill.title, '');
        subs[0].cb(specValue(373));
        assert.equal(h.pill.innerText, 'Node out of date');
        assert.deepEqual(h.logs.map(([k]) => k), ['log', 'error', 'log', 'error']);
    });

    test('a node that is 373 from the start: out of date, then cleared when it moves to 392', () => {
        const { api, subs } = subscribableApi({ startSpec: 373 });
        const h = harness(api);
        h.runLiveRuntimeCheck(api);
        h.watchRuntimeVersion(api);
        assert.equal(h.pill.innerText, 'Node out of date');
        subs[0].cb(specValue(373));   // same spec as already shown: nothing repeated
        assert.equal(h.logs.length, 1);
        subs[0].cb(specValue(392));
        assert.equal(h.pill.innerText, 'Polkadex Connected');
    });
});

describe('a real ApiPromise: the subscription follows the provider', () => {
    test('373 then 392 then 373 emitted by the node', async () => {
        const fx = fx392 ? fx392.metadata : substrateMetadata;
        const m = mockProvider({ metadataHex: fx, specVersion: 392 });
        const api = await ApiPromise.create({ provider: m.provider, noInitWarn: true });
        try {
            const seen = [];
            const h = followRuntimeVersion(api, (v, spec) => seen.push(spec));
            await new Promise((r) => setTimeout(r, 20));   // the mock's first emission (392) is no change
            const mine = m.subscriptions.filter((s) => s.method === 'state_subscribeRuntimeVersion').pop();
            for (const spec of [373, 392, 373]) mine.cb(null, { ...m.runtimeVersion, specVersion: spec });
            await new Promise((r) => setTimeout(r, 20));
            assert.deepEqual(seen, [373, 392, 373]);
            h.stop();
        } finally { await api.disconnect(); }
    });
});
