// The explorer's transaction building and decoding against the REAL runtime
// metadata: mainnet spec 394 (fetched 2026-11-20 from the archive) and, as the
// control, testnet spec 393. Every check here builds or decodes through the
// metadata registry; none greps source text for its verdict (the one source
// scan, the static api.tx inventory, only proves the table below is complete).
//
// A failure here is a finding about the explorer or the runtime. Do not weaken
// a check to make it pass.
//
// What metadata cannot tell us (so nothing here claims it): the ProxyType
// FILTER (which calls each proxy type allows) is runtime code, not metadata;
// token decimals and symbol live in system_properties, not in metadata; whether
// a pallet's Balance IS the native currency is the runtime's Config, only its
// type name is visible; the v14 and v15 blobs cannot list extrinsic version 5
// (v16 does, checked below).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { encodeAddress, blake2AsHex } from '@polkadot/util-crypto';
import { hexToU8a, stringCamelCase } from '@polkadot/util';
import { ApiPromise } from '@polkadot/api';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';
import { mockProvider } from './helpers/mock-provider.js';
import { EXPECTED_LAYOUT, layoutFromRegistry, checkLayout, layoutTotalBytes, parseSessionKeys } from '../lib/session-keys.js';
import { PROXY_FILTER, PROXY_TYPES, proxyTypesOf, proxyTypesProblem, filterPallets, buildProxyCall } from '../lib/validator-delegate.js';
import { ASSET_PALLETS, NATIVE_DECIMALS, isNativeBalanceField } from '../lib/call-args-format.js';
import { PDEX_METADATA_HASH_INPUTS, metadataHashFromV15, metadataV15FromCallResult } from '../lib/metadata-hash.js';
import { buildManageCall } from '../lib/validator-manage.js';
import { FALLBACK_BONDING_DURATION, FALLBACK_SESSIONS_PER_ERA, FALLBACK_SESSION_SECONDS } from '../lib/validator-status.js';
import { setupCalls, buildSetupTx, buildSetupStepCall } from '../lib/validator-setup.js';
import { stepwiseOrder } from '../lib/validator-setup-steps.js';
import { buildSpendMotion } from '../lib/treasury-spend.js';
import { buildSpendTx } from '../lib/treasury-payout.js';
import { buildSecondTx } from '../lib/democracy-patch.js';
import { MIN_LIVE_SPEC } from '../lib/live-runtime.js';
import { DEFAULT_BLOCK_MS } from '../lib/gov-detail.js';
import { DEFAULT_APR_WINDOW } from '../lib/stake-apr.js';
import { buildTransferTx } from '../lib/wallet-safety.js';

const FIXTURES = [
    { file: 'metadata-testnet-393.json', network: 'testnet', spec: 393 },
    { file: 'metadata-mainnet-394.json', network: 'mainnet', spec: 394 }
];

// Made-up accounts (public repo): filler bytes at prefix 88.
const A = encodeAddress(new Uint8Array(32).fill(7), 88);
const B = encodeAddress(new Uint8Array(32).fill(9), 88);
const rep = (b, n) => b.repeat(n);
const BLOB = '0x' + EXPECTED_LAYOUT.map((l, i) => rep(String(i + 1).padStart(2, '0'), l.bytes)).join('');
const HASH = '0x' + rep('ab', 32);
const WEIGHT = { refTime: 1_000_000, proofSize: 1_000 };
const TIMEPOINT = { height: 5, index: 1 };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const snake = (s) => s.replace(/([A-Z]|\d+)/g, '_$1').toLowerCase();

// Every call the explorer builds: pallet, method, the metadata's argument names
// in order, a representative argument set in the shapes the explorer passes
// (its count is the count the explorer passes), and where it is built.
const BOUNDED = { Legacy: { hash: HASH } };
const CALLS = (call) => [
    ['staking', 'bond', ['value', 'payee'], [10n ** 12n, 'Staked'], 'script.js:9395, lib/validator-setup.js:186'],
    ['staking', 'bondExtra', ['maxAdditional'], [5n], 'script.js:9392, lib/validator-manage.js:321'],
    ['staking', 'unbond', ['value'], [5n], 'script.js:9904, lib/validator-manage-chain.js:163'],
    ['staking', 'rebond', ['value'], [5n], 'lib/validator-manage.js:324'],
    ['staking', 'withdrawUnbonded', ['numSlashingSpans'], [0], 'script.js:9842, lib/lock-actions.js:246'],
    ['staking', 'nominate', ['targets'], [[A]], 'script.js:9586'],
    ['staking', 'chill', [], [], 'script.js:9903, lib/validator-manage.js:323'],
    ['staking', 'validate', ['prefs'], [{ commission: 50_000_000, blocked: false }], 'lib/validator-setup.js:189'],
    ['staking', 'setPayee', ['payee'], ['Stash'], 'lib/validator-manage.js:322'],
    ['staking', 'payoutStakers', ['validatorStash', 'era'], [A, 5], 'script.js:9400'],
    ['staking', 'payoutStakersByPage', ['validatorStash', 'era', 'page'], [A, 5, 0], 'script.js:9401'],
    ['staking', 'migrateCurrency', ['stash'], [A], 'lib/lock-actions.js:329'],
    ['session', 'setKeys', ['keys', 'proof'], [BLOB, '0x'], 'lib/validator-setup.js:188, lib/validator-manage.js:320'],
    ['session', 'purgeKeys', [], [], 'not built by the explorer today; listed because the task names it'],
    ['utility', 'batch', ['calls'], [[call]], 'script.js:9384'],
    ['utility', 'batchAll', ['calls'], [[call]], 'script.js:9385, lib/lock-actions.js:192, lib/validator-setup.js:195'],
    ['utility', 'forceBatch', ['calls'], [[call]], 'script.js:9383'],
    ['proxy', 'proxy', ['real', 'forceProxyType', 'call'], [A, 'Staking', call], 'lib/validator-delegate.js:152'],
    ['proxy', 'addProxy', ['delegate', 'proxyType', 'delay'], [A, 'Staking', 0], 'script.js:13410'],
    ['proxy', 'removeProxy', ['delegate', 'proxyType', 'delay'], [A, 'Staking', 0], 'script.js:13341'],
    ['proxy', 'proxyAnnounced', ['delegate', 'real', 'forceProxyType', 'call'], [B, A, 'Staking', call], 'named in the 394 readiness plan; not built today'],
    ['multisig', 'asMulti', ['threshold', 'otherSignatories', 'maybeTimepoint', 'call', 'maxWeight'], [2, [B], null, call, WEIGHT], 'lib/multisig.js:153'],
    ['multisig', 'approveAsMulti', ['threshold', 'otherSignatories', 'maybeTimepoint', 'callHash', 'maxWeight'], [2, [B], TIMEPOINT, HASH, WEIGHT], 'lib/multisig.js:154'],
    ['multisig', 'cancelAsMulti', ['threshold', 'otherSignatories', 'timepoint', 'callHash'], [2, [B], TIMEPOINT, HASH], 'lib/multisig.js:131'],
    ['multisig', 'asMultiThreshold1', ['otherSignatories', 'call'], [[B], call], 'lib/multisig.js:134'],
    ['democracy', 'vote', ['refIndex', 'vote'], [0, { Standard: { vote: { aye: true, conviction: 'Locked1x' }, balance: 5n } }], 'script.js:13129'],
    ['democracy', 'removeVote', ['index'], [0], 'lib/lock-actions.js:271, 298'],
    ['democracy', 'unlock', ['target'], [A], 'lib/lock-actions.js:266, 299'],
    ['democracy', 'delegate', ['to', 'conviction', 'balance'], [A, 'Locked1x', 5n], 'not built today; listed because the task names it'],
    ['democracy', 'undelegate', [], [], 'lib/lock-actions.js:310'],
    ['democracy', 'second', ['proposal'], [0], 'lib/democracy-patch.js:222'],
    ['democracy', 'externalPropose', ['proposal'], [BOUNDED], 'lib/discussion-threads.js:260, server.js:6612, tools/link-motion-threads.mjs:202 (api.tx.democracy[method])'],
    ['democracy', 'externalProposeMajority', ['proposal'], [BOUNDED], 'lib/discussion-threads.js:260, server.js:6612, tools/link-motion-threads.mjs:202 (api.tx.democracy[method])'],
    ['democracy', 'externalProposeDefault', ['proposal'], [BOUNDED], 'lib/discussion-threads.js:260, server.js:6612, tools/link-motion-threads.mjs:202 (api.tx.democracy[method])'],
    ['democracy', 'propose', ['proposal', 'value'], [BOUNDED, 5n], 'not built today; listed because the task names it'],
    ['council', 'propose', ['threshold', 'proposal', 'lengthBound'], [3, call, 10], 'lib/treasury-spend.js:87 (api.tx[pallet])'],
    ['council', 'vote', ['proposal', 'index', 'approve'], [HASH, 0, true], 'script.js:12094'],
    ['council', 'close', ['proposalHash', 'index', 'proposalWeightBound', 'lengthBound'], [HASH, 0, WEIGHT, 10], 'script.js:12156'],
    ['technicalCommittee', 'propose', ['threshold', 'proposal', 'lengthBound'], [2, call, 10], 'lib/treasury-spend.js:87 (api.tx[pallet])'],
    ['technicalCommittee', 'vote', ['proposal', 'index', 'approve'], [HASH, 0, true], 'script.js:12094'],
    ['technicalCommittee', 'close', ['proposalHash', 'index', 'proposalWeightBound', 'lengthBound'], [HASH, 0, WEIGHT, 10], 'script.js:12156'],
    ['treasury', 'spend', ['assetKind', 'amount', 'beneficiary', 'validFrom'], [null, 5n, { Id: A }, null], 'lib/treasury-spend.js:86'],
    ['treasury', 'payout', ['index'], [0], 'lib/treasury-payout.js:113'],
    ['treasury', 'checkStatus', ['index'], [0], 'lib/treasury-payout.js:113'],
    ['balances', 'transferKeepAlive', ['dest', 'value'], [A, 5n], 'lib/wallet-safety.js:132'],
    ['balances', 'transferAllowDeath', ['dest', 'value'], [A, 5n], 'lib/wallet-safety.js:136'],
    ['balances', 'transferAll', ['dest', 'keepAlive'], [A, true], 'not built today; listed because the task names it'],
    ['identity', 'setIdentity', ['info'], [{ display: { Raw: 'x' } }], 'script.js:10188'],
    ['identity', 'clearIdentity', [], [], 'script.js:10214'],
    ['elections', 'submitCandidacy', ['candidateCount'], [3], 'script.js:12537 (council pallet name)'],
    ['elections', 'vote', ['votes', 'value'], [[A], 5n], 'script.js:12576'],
    ['elections', 'renounceCandidacy', ['renouncing'], [{ Candidate: 3 }], 'lib/council-candidacy.js:55'],
    ['elections', 'removeVoter', [], [], 'lib/lock-actions.js:320'],
    ['system', 'remark', ['remark'], ['0x12'], 'static scan (motion-templates inventory)']
];

// Fields that carry an amount, found by walking the call and event types.
const AMOUNT_NAMES = /^(amount|fee|relayer_fee|value|balance|deposit|bond)$/i;
function amountPallets(registry) {
    const found = new Map();   // camelCase pallet -> Set of "kind:Variant.field"
    const mark = (pallet, what) => { if (!found.has(pallet)) found.set(pallet, new Set()); found.get(pallet).add(what); };
    const check = (pallet, what, f) => {
        const tn = f.typeName.isSome ? f.typeName.unwrap().toString() : '';
        const prim = registry.lookup.getTypeDef(f.type).type;
        const nm = f.name.isSome ? f.name.unwrap().toString() : '';
        if (/Balance/.test(tn) || (/^(u128|Compact<u128>|Option<u128>)$/.test(prim) && AMOUNT_NAMES.test(nm))) mark(pallet, what);
    };
    // A nested RuntimeCall (utility, council, scheduler...) holds every pallet's
    // calls; the nested call's own pallet is judged on its own, so stop there.
    const callType = Number(registry.metadata.extrinsic.callType.toString());
    const walk = (pallet, what, typeId, depth) => {
        if (depth > 5 || Number(typeId.toString()) === callType) return;
        const def = registry.lookup.getSiType(typeId).def;
        const fields = def.isComposite ? def.asComposite.fields : def.isVariant ? def.asVariant.variants.flatMap(v => [...v.fields]) : [];
        for (const f of fields) { check(pallet, what, f); walk(pallet, what, f.type, depth + 1); }
        if (def.isSequence) walk(pallet, what, def.asSequence.type, depth + 1);
        if (def.isArray) walk(pallet, what, def.asArray.type, depth + 1);
        if (def.isTuple) for (const t of def.asTuple) walk(pallet, what, t, depth + 1);
        if (def.isCompact) walk(pallet, what, def.asCompact.type, depth + 1);
    };
    for (const p of registry.metadata.pallets) {
        const name = stringCamelCase(p.name.toString());
        for (const [kind, opt] of [['call', p.calls], ['event', p.events]]) {
            if (opt.isNone) continue;
            for (const v of registry.lookup.getSiType(opt.unwrap().type).def.asVariant.variants) {
                for (const f of v.fields) {
                    const what = `${kind}:${v.name}.${f.name.isSome ? f.name.unwrap() : '?'}`;
                    check(name, what, f);
                    walk(name, what, f.type, 1);
                }
            }
        }
    }
    return found;
}
// Pallets whose Balance is the native PDEX by the runtime's Config (reviewed by
// hand against the 394 runtime source; metadata shows only the type name). Every
// other pallet with an amount must be in ASSET_PALLETS.
const NATIVE_AMOUNT_PALLETS = ['indices', 'balances', 'transactionPayment', 'electionProviderMultiPhase', 'staking', 'elections',
    'treasury', 'identity', 'recovery', 'proxy', 'multisig', 'bounties', 'democracy', 'childBounties', 'delegatedStaking', 'safeMode'];
const unclassifiedAmountPallets = (found, native = NATIVE_AMOUNT_PALLETS, asset = ASSET_PALLETS) =>
    [...found.keys()].filter(p => !native.includes(p) && !asset.has(p));

function constant(registry, pallet, name) {
    for (const p of registry.metadata.pallets) {
        if (p.name.toString() !== pallet) continue;
        const c = [...p.constants].find(x => x.name.toString() === name);
        if (c) return registry.createType(registry.createLookupType(c.type), c.value);
    }
    return undefined;
}

// Every JS/MJS source that could build a call: script.js, server.js, other top-level
// *.js/*.mjs, lib/, tools/ (and tools/lib), scripts/. Tests are not scanned.
function sourceFiles() {
    const root = new URL('../', import.meta.url);
    const out = [];
    for (const dir of ['', 'lib/', 'tools/', 'tools/lib/', 'scripts/']) {
        if (!existsSync(new URL(dir || '.', root))) continue;
        for (const f of readdirSync(new URL(dir || '.', root))) {
            if (/\.(js|mjs)$/.test(f) && !/\.min\./.test(f)) out.push(`${dir}${f}`);
        }
    }
    return out;
}

// Static api.tx.<pallet>.<method> names written in the shipped sources.
function staticTxNames(sources = sourceFiles().map(f => [f, readRepo(f, import.meta.url)])) {
    const names = new Set();
    for (const [, raw] of sources) {
        const src = stripComments(raw);
        for (const m of src.matchAll(/[aA]pi\.tx\.([a-zA-Z]+)\.([a-zA-Z0-9]+)/g)) names.add(`${m[1]}.${m[2]}`);
    }
    return names;
}

// Dynamic call construction the static scan cannot see, so the table above is
// maintained by hand for these. Known sites (file: what it builds):
//   script.js                     api.tx[pallet].vote / .close (council, technicalCommittee), api.tx[councilPalletName].submitCandidacy / .vote (elections)
//   lib/council-candidacy.js      api.tx[pallet].renounceCandidacy (elections)
//   lib/lock-actions.js           api.tx[section][method] (utility batch variants), api.tx[sec].removeVoter (elections)
//   lib/treasury-spend.js         api.tx[pallet].propose (council, technicalCommittee)
//   lib/treasury-payout.js        api.tx.treasury[action] (payout, checkStatus)
//   lib/validator-manage.js       const st = api.tx.staking (bondExtra, rebond, chill, setPayee, ...)
//   lib/wallet-safety.js          const t = api.tx.balances (transferKeepAlive, transferAllowDeath)
//   server.js                     globalApi.tx.democracy[method] (externalPropose, externalProposeMajority, externalProposeDefault)
//   tools/link-motion-threads.mjs const d = api.tx.democracy; d[method] (same three external calls)
// If you add a call by one of these forms, add the calls to CALLS. If a NEW file
// uses one of these forms, add the calls to CALLS and then the file to this list.
const KNOWN_DYNAMIC_FILES = new Set(['script.js', 'lib/council-candidacy.js', 'lib/lock-actions.js', 'lib/treasury-spend.js',
    'lib/treasury-payout.js', 'lib/validator-manage.js', 'lib/wallet-safety.js', 'server.js', 'tools/link-motion-threads.mjs']);
const DYNAMIC_ACCESS = /[aA]pi\.tx\[|[aA]pi\.tx\.[a-zA-Z]+\[|=[^=;\n]*[aA]pi\.tx\.[a-zA-Z]+\s*;/;
function unknownDynamicFiles(sources, known = KNOWN_DYNAMIC_FILES) {
    return sources.filter(([f, raw]) => !known.has(f) && DYNAMIC_ACCESS.test(stripComments(raw))).map(([f]) => f);
}

for (const fixture of FIXTURES) {
    describe(`${fixture.network} spec ${fixture.spec} (${fixture.file})`, () => {
        let fx, registry, ex, api, registryV16;
        const decode = (tx) => registry.createType('Call', (tx.method && tx.method.toHex ? tx.method : tx).toHex());
        // A real ApiPromise booted from the fixture (no network): api.tx, api.consts
        // and api.registry are exactly what the explorer's builders receive.
        before(async () => {
            fx = loadFixture(fixture.file);
            const mock = mockProvider({ metadataHex: fx.metadata, specVersion: fx.specVersion, specName: fx.specName, transactionVersion: fx.transactionVersion });
            api = await ApiPromise.create({ provider: mock.provider, noInitWarn: true });
            registry = api.registry;
            ex = api.tx;
            registryV16 = fx.metadataAtVersion && fx.metadataAtVersion['16'] ? registryFromMetadata(fx.metadataAtVersion['16']) : null;
        });

        after(async () => { await api?.disconnect(); });

        test('the fixture is the runtime its name says', () => {
            assert.equal(fx.network, fixture.network);
            assert.equal(fx.specVersion, fixture.spec);
            const v = constant(registry, 'System', 'Version');
            assert.equal(v.specVersion.toNumber(), fixture.spec, 'System.Version.specVersion in the metadata');
            assert.equal(v.transactionVersion.toNumber(), 3, 'transaction version 3');
            assert.equal(fx.transactionVersion, 3);
            assert.equal(v.specName.toString(), fx.specName);
        });

        // ---- (a) static calls ----
        describe('(a) every call the explorer builds, with its arguments', () => {
            test('the table covers every static api.tx.<pallet>.<method> in the sources', () => {
                const inTable = new Set(CALLS(null).map(([p, m]) => `${p}.${m}`));
                const missing = [...staticTxNames()].filter(n => !inTable.has(n));
                assert.deepEqual(missing, [], 'add these to CALLS so they are checked against the metadata');
            });
            test('no new dynamic api.tx access (api.tx[x], api.tx.<pallet>[m], alias = api.tx.<pallet>;) appears outside the known list', () => {
                const sources = sourceFiles().map(f => [f, readRepo(f, import.meta.url)]);
                const unknown = unknownDynamicFiles(sources);
                assert.deepEqual(unknown, [], 'these files build calls the static scan cannot see: add the calls to CALLS, then add each file to KNOWN_DYNAMIC_FILES');
                for (const f of KNOWN_DYNAMIC_FILES) assert.ok(sources.some(([n, raw]) => n === f && DYNAMIC_ACCESS.test(stripComments(raw))), `${f} is on the known list but no longer has a dynamic access: remove it`);
            });
            test('the dynamic-access scan flags a scratch file that is not on the list', () => {
                assert.deepEqual(unknownDynamicFiles([['x.js', 'const st = api.tx.balances;']]), ['x.js']);
                assert.deepEqual(unknownDynamicFiles([['x.js', 'api.tx[p].vote(1)']]), ['x.js']);
                assert.deepEqual(unknownDynamicFiles([['x.js', 'api.tx.democracy[m](b)']]), ['x.js']);
                assert.deepEqual(unknownDynamicFiles([['x.js', '// api.tx[p]\napi.tx.balances.transferAll(1)']]), []);
                assert.deepEqual([...staticTxNames([['x.js', 'globalApi.tx.foo.bar(1)']])], ['foo.bar']);
            });
            test('each call exists with the same argument names and count the explorer passes', () => {
                const problems = [];
                const call = ex.system.remark('0x01').method;
                for (const [pallet, method, names, sample, where] of CALLS(call)) {
                    const fn = ex[pallet] && ex[pallet][method];
                    if (typeof fn !== 'function') { problems.push(`${pallet}.${method} is missing (${where})`); continue; }
                    const got = fn.meta.args.map(a => a.name.toString());
                    if (JSON.stringify(got) !== JSON.stringify(names)) problems.push(`${pallet}.${method} args are [${got}] not [${names}] (${where})`);
                    if (sample.length !== got.length) problems.push(`${pallet}.${method}: the explorer passes ${sample.length} args, runtime takes ${got.length} (${where})`);
                }
                assert.deepEqual(problems, []);
            });
            test('each call builds from the explorer\'s argument shapes and decodes back to the same pallet, method and argument count', () => {
                const call = ex.system.remark('0x01').method;
                for (const [pallet, method, names, sample] of CALLS(call)) {
                    const tx = ex[pallet][method](...sample);
                    const back = decode(tx);
                    assert.equal(`${back.section}.${back.method}`, `${pallet}.${method}`);
                    assert.equal(back.args.length, names.length, `${pallet}.${method}`);
                    assert.equal(registry.createType('Call', back.toHex()).toHex(), tx.method.toHex(), `${pallet}.${method} did not re-encode identically`);
                }
            });
            test('the first two bytes of every built call are the metadata\'s pallet and call index', () => {
                const index = new Map();
                for (const p of registry.metadata.pallets) {
                    if (p.calls.isNone) continue;
                    for (const v of registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants) index.set(`${p.name}.${v.name}`, [p.index.toNumber(), v.index.toNumber()]);
                }
                const call = ex.system.remark('0x01').method;
                for (const [pallet, method, , sample] of CALLS(call)) {
                    const bytes = [...ex[pallet][method](...sample).method.toU8a().subarray(0, 2)];
                    assert.deepEqual(bytes, index.get(`${cap(pallet)}.${snake(method)}`), `${pallet}.${method}`);
                }
            });
            test('the explorer\'s own builders produce calls the runtime decodes', () => {
                const sec = (tx) => { const c = decode(tx); return `${c.section}.${c.method}`; };
                const m = (s) => sec(buildManageCall(api, s));
                assert.equal(m({ kind: 'commission', commission: 50_000_000, blocked: false }), 'staking.validate');
                assert.equal(m({ kind: 'keys', keysHex: BLOB }), 'session.setKeys');
                assert.equal(m({ kind: 'bondExtra', value: '5' }), 'staking.bondExtra');
                assert.equal(m({ kind: 'payee', payee: { kind: 'account', account: A } }), 'staking.setPayee');
                assert.equal(m({ kind: 'payee', payee: { kind: 'staked' } }), 'staking.setPayee');
                assert.equal(m({ kind: 'chill' }), 'staking.chill');
                assert.equal(m({ kind: 'rebond', value: '5' }), 'staking.rebond');
                const steps = [{ kind: 'bond', value: '1000000000000', payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: BLOB },
                    { kind: 'validate', commission: 50_000_000 }];
                assert.deepEqual(setupCalls(api, steps).map(sec), ['staking.bond', 'session.setKeys', 'staking.validate']);
                const batch = decode(buildSetupTx(api, steps));
                assert.equal(`${batch.section}.${batch.method}`, 'utility.batchAll');
                assert.equal(batch.args[0].length, 3);
                assert.equal(sec(buildTransferTx(api, A, '5', true)), 'balances.transferKeepAlive');
                assert.equal(sec(buildTransferTx(api, A, '5', false)), 'balances.transferAllowDeath');
                assert.equal(sec(buildSpendTx(api, 'payout', 3)), 'treasury.payout');
                assert.equal(sec(buildSpendTx(api, 'checkStatus', 3)), 'treasury.checkStatus');
                assert.equal(sec(buildSecondTx(api, 4, 2)), 'democracy.second');
                assert.equal(decode(buildSecondTx(api, 4, 2)).args.length, 1, 'democracy.second takes one argument on this runtime');
                const motion = decode(buildSpendMotion(api, 'council', { threshold: 3, planck: '5000000000000', beneficiary: A, validFrom: null }));
                assert.equal(`${motion.section}.${motion.method}`, 'council.propose');
                assert.equal(`${motion.args[1].section}.${motion.args[1].method}`, 'treasury.spend');
                const px = decode(buildProxyCall(api, A, 'Staking', ex.staking.chill().method));
                assert.equal(`${px.section}.${px.method}`, 'proxy.proxy');
                assert.equal(px.args[1].toString(), 'Staking');
            });
            test('setup in separate steps: session.setKeys, staking.bond, staking.bondExtra, staking.validate as single bare extrinsics, in the stepper order', () => {
                const steps = [{ kind: 'bond', value: '1000000000000', payee: { kind: 'staked' } }, { kind: 'setKeys', keysHex: BLOB },
                    { kind: 'validate', commission: 50_000_000 }, { kind: 'bondExtra', value: '5' }];
                const out = steps.map((s) => {
                    const tx = buildSetupStepCall(api, s);
                    const c = decode(tx);
                    assert.equal(tx.method.toHex(), c.toHex(), `${s.kind} re-encodes identically`);
                    return [`${c.section}.${c.method}`, c.args.length];
                });
                assert.deepEqual(out, [['staking.bond', 2], ['session.setKeys', 2], ['staking.validate', 1], ['staking.bondExtra', 1]]);
                assert.ok(out.every(([n]) => !n.startsWith('utility.')), 'no utility wrapper');
                assert.deepEqual(stepwiseOrder(steps.slice(0, 3)).map(s => s.kind), ['setKeys', 'bond', 'validate']);
                const keys = decode(buildSetupStepCall(api, steps[1]));
                assert.equal(keys.args[0].toU8a().length, 193, 'the 193-byte keys blob a device has to show');
                assert.equal(keys.args[1].toHex(), '0x', 'empty proof');
                assert.equal(constant(registry, 'Session', 'KeyDeposit').toString(), '0', 'Session.KeyDeposit on this runtime');
            });
            test('removed calls stay removed: treasury approveProposal / rejectProposal, balances.transfer', () => {
                assert.equal(ex.treasury.approveProposal, undefined);
                assert.equal(ex.treasury.rejectProposal, undefined);
                assert.equal(ex.balances.transfer, undefined);
            });
        });

        // ---- (b) session keys ----
        describe('(b) session keys', () => {
            test('six keys in the order the explorer expects, 193 bytes, KeyTypeIds as expected', () => {
                const r = checkLayout(layoutFromRegistry(registry));
                assert.equal(r.ok, true, r.reason);
                assert.equal(r.bytes, 193);
                assert.deepEqual(r.layout.map(k => k.name), ['grandpa', 'babe', 'im_online', 'authority_discovery', 'mixnet', 'beefy']);
                assert.deepEqual(r.layout.map(k => k.typeId), ['gran', 'babe', 'imon', 'audi', 'mixn', 'beef']);
                assert.equal(layoutTotalBytes(EXPECTED_LAYOUT), 193);
            });
            test('session.setKeys encodes the keys argument as exactly 193 bytes and a pasted blob parses', () => {
                const arg = ex.session.setKeys.meta.args[0];
                assert.equal(registry.createType(arg.type.toString()).toU8a().length, 193);
                const tx = decode(ex.session.setKeys(BLOB, '0x'));
                assert.equal(tx.args[0].toU8a().length, 193);
                assert.equal(tx.args[0].toHex(), BLOB);
                const parsed = parseSessionKeys(BLOB, { specVersion: fixture.spec });
                assert.notEqual(parsed.ok, false, JSON.stringify(parsed).slice(0, 200));
            });
        });

        // ---- (c) proxy types ----
        describe('(c) proxy types', () => {
            test('variants and order are Any, NonTransfer, Governance, Staking and the explorer accepts them', () => {
                const types = proxyTypesOf(api);
                assert.deepEqual(types, ['Any', 'NonTransfer', 'Governance', 'Staking']);
                assert.deepEqual(types, [...PROXY_TYPES]);
                assert.equal(proxyTypesProblem(types), null);
            });
            test('each variant encodes to its index byte (the order on the wire)', () => {
                const arg = ex.proxy.addProxy.meta.args[1].type.toString();
                PROXY_TYPES.forEach((t, i) => assert.equal(registry.createType(arg, t).toU8a()[0], i, t));
            });
            test('every pallet and call the explorer\'s filter names exists in the metadata (the filter itself is runtime code and is not checkable here)', () => {
                const pallets = new Map();
                for (const p of registry.metadata.pallets) {
                    pallets.set(p.name.toString(), p.calls.isNone ? new Set() : new Set(registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants.map(v => v.name.toString())));
                }
                assert.deepEqual(filterPallets().filter(p => !pallets.has(p)), []);
                const lostCalls = [];
                for (const f of Object.values(PROXY_FILTER)) for (const [p, c] of f.denyCalls || []) if (!pallets.get(p)?.has(c)) lostCalls.push(`${p}.${c}`);
                assert.deepEqual(lostCalls, []);
            });
        });

        // ---- (d) signed extensions and transaction format ----
        describe('(d) signed extensions and transaction format', () => {
            test('the extension list and order the signing path assumes, CheckMetadataHash present', () => {
                assert.deepEqual([...registry.metadata.extrinsic.transactionExtensions].map(e => e.identifier.toString()),
                    ['CheckNonZeroSender', 'CheckSpecVersion', 'CheckTxVersion', 'CheckGenesis', 'CheckMortality', 'CheckNonce', 'CheckWeight',
                        'ChargeAssetTxPayment', 'CheckMetadataHash', 'WeightReclaim']);
            });
            test('CheckMetadataHash has the Disabled and Enabled modes the signer chooses between', () => {
                const e = [...registry.metadata.extrinsic.transactionExtensions].find(x => x.identifier.toString() === 'CheckMetadataHash');
                const t = registry.createType(registry.createLookupType(e.type));
                assert.deepEqual(t.mode.defKeys, ['Disabled', 'Enabled']);
            });
            test('extrinsic versions: v16 metadata lists 4 and 5 (the v14 and v15 blobs cannot say)', () => {
                assert.ok(registryV16, 'the fixture carries metadata v16');
                assert.deepEqual([...registryV16.metadata.extrinsic.versions].map(Number), [4, 5]);
            });
            test('the metadata hash the WalletConnect path sends can be computed from this runtime\'s v15 metadata', async () => {
                const { merkleizeMetadata } = await import('@polkadot-api/merkleize-metadata');
                const raw = fx.metadataAtVersion['15'];
                const bytes = raw.startsWith('0x6d657461') ? hexToU8a(raw) : metadataV15FromCallResult(raw);
                assert.ok(bytes && bytes.length > 1000);
                const hash = metadataHashFromV15(merkleizeMetadata, bytes, { specName: fx.specName, specVersion: fixture.spec });
                assert.match(hash, /^0x[0-9a-f]{64}$/);
                assert.throws(() => metadataHashFromV15(merkleizeMetadata, bytes, { specName: fx.specName, specVersion: fixture.spec + 1 }));
                assert.equal(PDEX_METADATA_HASH_INPUTS.base58Prefix, Number(constant(registry, 'System', 'SS58Prefix').toString()));
                assert.equal(PDEX_METADATA_HASH_INPUTS.decimals, NATIVE_DECIMALS);
            });
        });

        // ---- (e) the non-native amount check ----
        describe('(e) amounts: native PDEX or in the non-native list', () => {
            test('every pallet with an amount in its calls or events is native by review or in ASSET_PALLETS', () => {
                const found = amountPallets(registry);
                assert.ok(found.size > 15, 'the scan found almost nothing; the walk has rotted');
                assert.deepEqual(unclassifiedAmountPallets(found), [], 'add each to ASSET_PALLETS (lib/call-args-format.js) or, if its Balance is PDEX, to NATIVE_AMOUNT_PALLETS here');
            });
            test('the new bridge pallets are detected as carrying amounts and are non-native, so their amounts print as units, never PDEX', () => {
                const found = amountPallets(registry);
                for (const p of ['ismp', 'hyperFungibleToken', ...(fixture.spec >= 394 ? ['ismpParams'] : [])]) {
                    assert.ok(found.has(p), `${p} should carry an amount field in ${fixture.spec}`);
                    assert.ok(ASSET_PALLETS.has(p), p);
                    assert.equal(isNativeBalanceField(p, 'any', 'amount', 'T::Balance', []), false, p);
                }
                assert.equal(found.has('ismpGrandpa'), false, 'ismpGrandpa now carries an amount; classify it');
            });
            test('the check bites: an unlisted pallet with a Balance field is reported', () => {
                const fake = new Map([['balances', new Set(['x'])], ['fooBridge', new Set(['call:send.amount'])]]);
                assert.deepEqual(unclassifiedAmountPallets(fake), ['fooBridge']);
            });
            test('treasury.spend assetKind is the unit type, which is why a treasury amount is PDEX', () => {
                const arg = ex.treasury.spend.meta.args[0];
                assert.equal(registry.createType(arg.type.toString()).toRawType(), 'Null');
            });
        });

        // ---- (f) constants ----
        describe('(f) constants and types the explorer hardcodes or reads', () => {
            const num = (p, n) => Number(constant(registry, p, n).toString());
            test('hardcoded values equal the runtime constants', () => {
                assert.equal(num('System', 'SS58Prefix'), 88, 'SS58 prefix (lib/metadata-hash.js:28, 88 in every address path)');
                assert.equal(num('Staking', 'SessionsPerEra'), FALLBACK_SESSIONS_PER_ERA, 'FALLBACK_SESSIONS_PER_ERA (lib/validator-status.js, used by lib/validator-manage.js)');
                assert.equal(num('Babe', 'EpochDuration') * num('Babe', 'ExpectedBlockTime') / 1000, FALLBACK_SESSION_SECONDS, 'FALLBACK_SESSION_SECONDS (lib/validator-status.js, used by lib/validator-manage.js)');
                assert.equal(num('Babe', 'ExpectedBlockTime'), DEFAULT_BLOCK_MS, 'DEFAULT_BLOCK_MS (lib/gov-detail.js:19, lib/call-args-format.js:27, server.js:738, 5061)');
                assert.equal(num('Staking', 'BondingDuration'), FALLBACK_BONDING_DURATION, 'FALLBACK_BONDING_DURATION (lib/validator-status.js)');
                assert.equal(DEFAULT_APR_WINDOW, 28, 'lib/stake-apr.js:55 (one window of eras = BondingDuration)');
                assert.equal(7 * 7200 * num('Babe', 'ExpectedBlockTime') / 1000, 7 * 86400, 'INCIDENT_WINDOW_BLOCKS is a week (lib/nomination-status-chain.js:37)');
                assert.ok(MIN_LIVE_SPEC <= fixture.spec, 'MIN_LIVE_SPEC must not exceed the live spec or every signer is refused');
            });
            test('values the explorer reads live exist and are numbers (reported)', (t) => {
                const rows = [['Balances', 'ExistentialDeposit'], ['Staking', 'BondingDuration'], ['Staking', 'SessionsPerEra'], ['Staking', 'MaxUnlockingChunks'],
                    ['Staking', 'HistoryDepth'], ['Democracy', 'VoteLockingPeriod'], ['Democracy', 'EnactmentPeriod'], ['Democracy', 'VotingPeriod'],
                    ['Democracy', 'LaunchPeriod'], ['Treasury', 'SpendPeriod'], ['Treasury', 'PayoutPeriod'], ['Proxy', 'MaxProxies'],
                    ['Multisig', 'DepositBase'], ['Multisig', 'DepositFactor'], ['Multisig', 'MaxSignatories'], ['Babe', 'EpochDuration'], ['Babe', 'ExpectedBlockTime']];
                const out = [];
                for (const [p, n] of rows) {
                    const v = constant(registry, p, n);
                    assert.ok(v !== undefined, `${p}.${n} is gone`);
                    assert.match(v.toString(), /^\d+$/, `${p}.${n}`);
                    out.push(`${p}.${n}=${v.toString()}`);
                }
                assert.equal(constant(registry, 'Treasury', 'PalletId').toHex(), '0x70792f7472737279');
                t.diagnostic(out.join(' '));
            });
        });

        // ---- (g) real extrinsics ----
        describe('(g) real extrinsics sampled from the chain', () => {
            test('every sample from this runtime decodes and re-encodes byte-identical', (t) => {
                const samples = (fx.extrinsics || []).filter(s => s.specVersion === undefined || s.specVersion === fixture.spec);
                assert.ok(samples.length > 0);
                if (fixture.spec === 394) {
                    assert.equal(samples.length, 12);
                    assert.ok(samples.every(s => s.format === 'v5-bare'), 'all samples are inherents (v5-bare); no signed extrinsic was in the window');
                }
                const names = [];
                for (const s of samples) {
                    const x = registry.createType('Extrinsic', s.hex);
                    assert.equal(x.toHex(), s.hex, `block ${s.block} #${s.index}`);
                    assert.equal(x.hash.toHex(), blake2AsHex(hexToU8a(s.hex)));
                    if (fixture.spec === 394) assert.equal(x.isSigned, false);
                    assert.ok(x.method.section && x.method.method, `block ${s.block} #${s.index} has no call`);
                    names.push(`${x.method.section}.${x.method.method}`);
                }
                t.diagnostic(`${samples.length} samples: ${[...new Set(names)].join(', ')}`);
            });
        });
    });
}

describe('393 versus 394: what moved (guards the readiness diff; a change here is news)', () => {
    let a, b;
    before(() => {
        a = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        b = registryFromMetadata(loadFixture('metadata-mainnet-394.json').metadata);
    });
    const callsOf = (r) => {
        const out = new Map();
        for (const p of r.metadata.pallets) {
            if (p.calls.isNone) continue;
            for (const v of r.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants) {
                out.set(`${p.name}.${v.name}`, `${p.index}/${v.index}(${v.fields.map(f => `${f.name.unwrap()}:${r.lookup.getTypeDef(f.type).type}`).join(',')})`);
            }
        }
        return out;
    };
    test('same pallets, same indices; every call the explorer uses is identical in index and arguments', () => {
        const pa = new Map(a.metadata.pallets.map(p => [p.name.toString(), p.index.toNumber()]));
        const pb = new Map(b.metadata.pallets.map(p => [p.name.toString(), p.index.toNumber()]));
        assert.deepEqual([...pb].sort(), [...pa].sort());
        const ca = callsOf(a), cb = callsOf(b);
        const used = CALLS(null).map(([p, m]) => `${cap(p)}.${snake(m)}`);
        assert.deepEqual(used.filter(k => !ca.has(k) || !cb.has(k)), [], 'a used call is missing from one runtime');
        assert.deepEqual(used.filter(k => ca.get(k) !== cb.get(k)), []);
    });
    test('the only call differences are the three new IsmpParams setters', () => {
        const ca = callsOf(a), cb = callsOf(b);
        const changed = [...new Set([...ca.keys(), ...cb.keys()])].filter(k => ca.get(k) !== cb.get(k)).sort();
        assert.deepEqual(changed, ['IsmpParams.set_bridge_fee', 'IsmpParams.set_fee_collector', 'IsmpParams.set_max_call_data']);
    });
});
