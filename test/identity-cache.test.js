// Bug: a validator set an on-chain identity but the explorer kept showing
// "Unknown" for the stash. Cause: server.js getIdentity wrote every result,
// including the "Unknown" sentinel, into a Map with no expiry and nothing ever
// removed it, so a stash looked up before its identity existed stayed Unknown
// until the process restarted, and later identity changes never showed either.
//
// These tests drive lib/identity-cache.js with a fake clock, a fake chain
// reader, fake cluster/process objects and a real SQLite file. All addresses
// and names are synthetic.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';
import { getOnChainIdentity } from '../lib/identity.js';
import * as db from '../db.js';
import {
    IDENTITY_TTL_FOUND_MS, IDENTITY_TTL_UNKNOWN_MS, IDENTITY_CACHE_MAX, IDENTITY_STALE_BACKOFF_MS, IDENTITY_MESSAGE, IDENTITY_EVENT_METHODS,
    createIdentityCache, createIdentityResolver, identityEventAccounts, decodeInvalidation,
    createIdentityInvalidator, startIdentityRelay, receiveIdentityInvalidations,
    refreshDerivedNames, createDebouncedRefresher
} from '../lib/identity-cache.js';

const A = 'stash-aaaa', B = 'stash-bbbb', P = 'parent-pppp', S1 = 'sub-1111', S2 = 'sub-2222';
const API = { query: { identity: {} } };

function clock(start = 1_000_000) { const c = { t: start, now: () => c.t, advance(ms) { c.t += ms; } }; return c; }

// A chain reader that answers from a mutable table and counts reads.
function fakeChain(table = {}, parents = {}) {
    const f = { table, parents, reads: 0, fail: false, gate: null,
        async read(api, address, { onParent, onError } = {}) {
            f.reads++;
            if (f.gate) await f.gate;
            if (f.fail) { if (onError) onError(new Error('rpc blip'), address); return 'Unknown'; }
            const key = String(address);
            if (parents[key]) {
                if (onParent) onParent(parents[key]);
                return `${f.table[parents[key]] || 'Unknown'} / ${f.table[key] || 'Unknown'}`;
            }
            return f.table[key] || 'Unknown';
        } };
    return f;
}
function setup(opts = {}, table = {}, parents = {}) {
    const c = clock();
    const chain = fakeChain(table, parents);
    const cache = createIdentityCache({ now: c.now, ...opts });
    const resolver = createIdentityResolver({ cache, readChain: chain.read, overrides: opts.overrides || new Map() });
    return { c, chain, cache, resolver };
}

describe('lifetimes and constants', () => {
    test('negative entries live minutes, positive ones an hour, and the cache is bounded', () => {
        assert.equal(IDENTITY_TTL_UNKNOWN_MS, 5 * 60 * 1000);
        assert.equal(IDENTITY_TTL_FOUND_MS, 60 * 60 * 1000);
        assert.ok(IDENTITY_CACHE_MAX > 0 && IDENTITY_CACHE_MAX <= 20000);
    });

    test('a stash looked up before its identity was set is re-read once the negative entry expires', async () => {
        const { c, chain, resolver } = setup();
        assert.equal(await resolver.getIdentity(API, A), 'Unknown');
        chain.table[A] = 'Synthetic Validator';
        c.advance(IDENTITY_TTL_UNKNOWN_MS - 1000);
        assert.equal(await resolver.getIdentity(API, A), 'Unknown', 'still inside the negative window: served from cache');
        assert.equal(chain.reads, 1);
        c.advance(2000);
        assert.equal(await resolver.getIdentity(API, A), 'Synthetic Validator');
        assert.equal(chain.reads, 2);
    });

    test('a positive entry is served from cache, then refreshed after its TTL (identity changed or cleared)', async () => {
        const { c, chain, resolver } = setup({}, { [A]: 'First Name' });
        assert.equal(await resolver.getIdentity(API, A), 'First Name');
        chain.table[A] = 'Second Name';
        c.advance(IDENTITY_TTL_UNKNOWN_MS + 1000);
        assert.equal(await resolver.getIdentity(API, A), 'First Name', 'a found name outlives the negative window');
        c.advance(IDENTITY_TTL_FOUND_MS);
        assert.equal(await resolver.getIdentity(API, A), 'Second Name');
        delete chain.table[A];
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        assert.equal(await resolver.getIdentity(API, A), 'Unknown');
    });

    test('a failed chain read is not cached at all (an RPC blip must not pin Unknown even for minutes)', async () => {
        const { chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        chain.fail = true;
        assert.equal(await resolver.getIdentity(API, A), 'Unknown');
        chain.fail = false;
        assert.equal(await resolver.getIdentity(API, A), 'Synthetic Validator');
    });

    test('an unusable api returns Unknown without reading or caching', async () => {
        const { chain, cache, resolver } = setup();
        assert.equal(await resolver.getIdentity(null, A), 'Unknown');
        assert.equal(chain.reads, 0);
        assert.equal(cache.size(), 0);
    });

    test('display-name overrides still apply, and a real on-chain name still beats them', async () => {
        const overrides = new Map([[A, 'Pinned Label']]);
        const { c, chain, resolver } = setup({ overrides });
        assert.equal(await resolver.getIdentity(API, A), 'Pinned Label');
        assert.equal(await resolver.getIdentity(API, A), 'Pinned Label');
        assert.equal(chain.reads, 1, 'the override result is cached too, no read per request');
        chain.table[A] = 'On Chain Name';
        c.advance(IDENTITY_TTL_UNKNOWN_MS + 1);
        assert.equal(await resolver.getIdentity(API, A), 'On Chain Name');
    });
});

describe('super / sub identities', () => {
    test('a sub resolves as "Parent / sub"', async () => {
        const { resolver } = setup({}, { [P]: 'Parent Co', [S1]: 'node-1' }, { [S1]: P });
        assert.equal(await resolver.getIdentity(API, S1), 'Parent Co / node-1');
    });

    test('lib/identity.js reports the parent of a sub through onParent, and nothing for a plain account', async () => {
        const some = (v) => ({ isSome: true, unwrap: () => v });
        const human = (h) => ({ toHuman: () => h, isSome: true });
        const api = { query: { identity: {
            superOf: async (a) => (a === S1 ? some([P, { toHuman: () => ({ Raw: 'node-1' }) }]) : { isSome: false }),
            identityOf: async (a) => human({ info: { display: { Raw: a === P ? 'Parent Co' : 'Solo' } } })
        } } };
        const seen = [];
        assert.equal(await getOnChainIdentity(api, S1, { onParent: (p) => seen.push(p) }), 'Parent Co / node-1');
        assert.deepEqual(seen, [P]);
        seen.length = 0;
        assert.equal(await getOnChainIdentity(api, A, { onParent: (p) => seen.push(p) }), 'Solo');
        assert.deepEqual(seen, []);
    });
});

describe('bounded memory and in-flight sharing', () => {
    test('the cache never exceeds its cap and evicts the oldest entry first', () => {
        const c = clock();
        const cache = createIdentityCache({ now: c.now, max: 3 });
        for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) cache.set(k, `name ${k}`);
        assert.equal(cache.size(), 3);
        assert.equal(cache.get('k1'), undefined);
        assert.equal(cache.get('k2'), undefined);
        assert.equal(cache.get('k5'), 'name k5');
    });

    test('evicting or expiring a sub also drops it from the parent index, so the index cannot grow past the cache', () => {
        const c = clock();
        const cache = createIdentityCache({ now: c.now, max: 2 });
        cache.set(S1, 'x / 1', { parent: P });
        cache.set(S2, 'x / 2', { parent: P });
        cache.set(A, 'plain');
        assert.equal(cache.size(), 2);
        assert.ok(cache.indexSize() <= cache.size());
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        cache.get(S2);
        cache.get(A);
        assert.equal(cache.indexSize(), 0);
    });

    test('concurrent misses for one account share a single chain read', async () => {
        const { chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        let release; chain.gate = new Promise(r => { release = r; });
        const calls = [resolver.getIdentity(API, A), resolver.getIdentity(API, A), resolver.getIdentity(API, A)];
        assert.equal(resolver.inflightCount(), 1);
        release();
        assert.deepEqual(await Promise.all(calls), ['Synthetic Validator', 'Synthetic Validator', 'Synthetic Validator']);
        assert.equal(chain.reads, 1);
        assert.equal(resolver.inflightCount(), 0);
    });

    test('the in-flight entry is released when the read fails, so the next call retries', async () => {
        const { chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        chain.fail = true;
        await resolver.getIdentity(API, A);
        assert.equal(resolver.inflightCount(), 0);
        chain.fail = false;
        assert.equal(await resolver.getIdentity(API, A), 'Synthetic Validator');
    });

    test('an invalidation that lands during a read stops that (possibly stale) result being cached', async () => {
        const { chain, cache, resolver } = setup({}, { [A]: 'Old Name' });
        let release; chain.gate = new Promise(r => { release = r; });
        const p = resolver.getIdentity(API, A);
        resolver.invalidate([A]);
        release();
        assert.equal(await p, 'Old Name', 'the caller that asked still gets an answer');
        assert.equal(cache.get(A), undefined, 'but it was not stored');
        chain.gate = null; chain.table[A] = 'New Name';
        assert.equal(await resolver.getIdentity(API, A), 'New Name');
    });
});

describe('invalidation', () => {
    test('invalidate drops the account and returns it', async () => {
        const { chain, resolver } = setup({}, { [A]: 'One' });
        await resolver.getIdentity(API, A);
        chain.table[A] = 'Two';
        assert.deepEqual(resolver.invalidate([A]), [A]);
        assert.equal(await resolver.getIdentity(API, A), 'Two');
    });

    test('invalidating a parent also drops every cached sub and returns them for the derived refresh', async () => {
        const { chain, resolver } = setup({}, { [P]: 'Parent Co', [S1]: 'n1', [S2]: 'n2', [B]: 'Other' }, { [S1]: P, [S2]: P });
        for (const k of [P, S1, S2, B]) await resolver.getIdentity(API, k);
        chain.table[P] = 'Parent Renamed';
        const affected = resolver.invalidate([P]);
        assert.deepEqual([...affected].sort(), [P, S1, S2].sort());
        assert.equal(await resolver.getIdentity(API, S1), 'Parent Renamed / n1');
        assert.equal(await resolver.getIdentity(API, S2), 'Parent Renamed / n2');
        const before = chain.reads;
        assert.equal(await resolver.getIdentity(API, B), 'Other');
        assert.equal(chain.reads, before, 'an unrelated account stays cached');
    });

    test('a sub that moved to a new parent is not left in the old parent index', async () => {
        const { chain, resolver } = setup({}, { [P]: 'Parent Co', [S1]: 'n1', [B]: 'Other Parent' }, { [S1]: P });
        await resolver.getIdentity(API, S1);
        resolver.invalidate([S1]);
        chain.parents[S1] = B;
        await resolver.getIdentity(API, S1);
        assert.deepEqual(resolver.invalidate([P]), [P], 'the old parent no longer owns S1');
        assert.deepEqual([...resolver.invalidate([B])].sort(), [B, S1].sort());
    });
});

describe('which accounts each identity event invalidates', () => {
    const rec = (method, ...data) => ({ event: { section: 'identity', method, data: data.map(d => ({ toString: () => d })) } });
    const accts = (...records) => [...identityEventAccounts(records)].sort();

    test('one account for who-events', () => {
        for (const m of ['IdentitySet', 'IdentityCleared', 'IdentityKilled', 'JudgementRequested', 'JudgementUnrequested', 'JudgementGiven']) {
            assert.deepEqual(accts(rec(m, A, '1')), [A], m);
        }
    });

    test('sub-identity events name both the sub and the main account', () => {
        for (const m of ['SubIdentityAdded', 'SubIdentityRemoved', 'SubIdentityRevoked', 'SubIdentityRenamed']) {
            assert.deepEqual(accts(rec(m, S1, P, '5')), [P, S1].sort(), m);
        }
        assert.deepEqual(accts(rec('SubIdentitiesSet', P, '3', '9')), [P]);
    });

    test('other pallets, other identity events and malformed records are ignored; duplicates collapse', () => {
        assert.deepEqual(accts({ event: { section: 'balances', method: 'IdentitySet', data: [{ toString: () => A }] } }), []);
        assert.deepEqual(accts(rec('RegistrarAdded', '0'), rec('UsernameSet', A, 'x')), []);
        assert.deepEqual(accts(null, {}, { event: null }, rec('IdentitySet')), []);
        assert.deepEqual(accts(rec('IdentitySet', A), rec('IdentityCleared', A, '1'), rec('IdentitySet', B)), [A, B].sort());
    });

    test('every method we watch exists on the 393 Identity pallet', () => {
        const reg = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        const pallet = reg.metadata.pallets.find(p => p.name.toString() === 'Identity');
        const names = new Set(reg.lookup.getSiType(pallet.events.unwrap().type).def.asVariant.variants.map(v => v.name.toString()));
        for (const m of IDENTITY_EVENT_METHODS) assert.ok(names.has(m), `${m} is not an Identity event in 393`);
        for (const m of ['IdentitySet', 'IdentityCleared', 'IdentityKilled', 'JudgementGiven', 'SubIdentityAdded', 'SubIdentitiesSet', 'SubIdentityRemoved', 'SubIdentityRevoked']) {
            assert.ok(IDENTITY_EVENT_METHODS.includes(m), `${m} must be watched`);
        }
    });
});

describe('cluster relay', () => {
    function fakeCluster(ids) {
        const cluster = new EventEmitter();
        cluster.workers = {};
        for (const id of ids) {
            const w = { id, sent: [], isConnected: () => true, send(m) { this.sent.push(m); } };
            cluster.workers[id] = w;
        }
        return cluster;
    }

    test('a worker invalidation is sent to the primary, and the primary forwards it to every OTHER worker', () => {
        const cluster = fakeCluster([1, 2, 3]);
        startIdentityRelay({ cluster });
        const proc = new EventEmitter(); const sentToPrimary = [];
        proc.send = (m) => { sentToPrimary.push(m); return true; }; proc.connected = true;
        const { resolver } = setup();
        const inv = createIdentityInvalidator({ resolver, proc });
        inv.invalidate([A, B]);
        assert.equal(sentToPrimary.length, 1);
        assert.equal(sentToPrimary[0].type, IDENTITY_MESSAGE);
        cluster.emit('message', cluster.workers[1], sentToPrimary[0]);
        assert.equal(cluster.workers[1].sent.length, 0);
        assert.deepEqual(cluster.workers[2].sent[0].accounts, [A, B]);
        assert.deepEqual(cluster.workers[3].sent[0].accounts, [A, B]);
    });

    test('the primary ignores other message types and malformed payloads', () => {
        const cluster = fakeCluster([1, 2]);
        startIdentityRelay({ cluster });
        cluster.emit('message', cluster.workers[1], { type: 'pdex-telemetry' });
        cluster.emit('message', cluster.workers[1], { type: IDENTITY_MESSAGE, v: 1, accounts: 'nope' });
        cluster.emit('message', cluster.workers[1], undefined);
        assert.equal(cluster.workers[2].sent.length, 0);
    });

    test('an HTTP worker that receives the message drops that account and its cached subs, and does not echo it back', async () => {
        const { chain, resolver } = setup({}, { [P]: 'Parent Co', [S1]: 'n1' }, { [S1]: P });
        await resolver.getIdentity(API, S1);
        chain.table[P] = 'Parent Renamed';
        const proc = new EventEmitter(); const echoed = [];
        proc.send = (m) => { echoed.push(m); return true; }; proc.connected = true;
        receiveIdentityInvalidations({ proc, resolver });
        proc.emit('message', { type: IDENTITY_MESSAGE, v: 1, accounts: [P] });
        assert.equal(await resolver.getIdentity(API, S1), 'Parent Renamed / n1');
        assert.equal(echoed.length, 0);
    });

    test('decodeInvalidation checks what crossed the process boundary', () => {
        assert.deepEqual(decodeInvalidation({ type: IDENTITY_MESSAGE, v: 1, accounts: [A] }), [A]);
        assert.equal(decodeInvalidation({ type: IDENTITY_MESSAGE, v: 2, accounts: [A] }), null);
        assert.equal(decodeInvalidation({ type: IDENTITY_MESSAGE, v: 1, accounts: [A, 5] }), null);
        assert.equal(decodeInvalidation({ type: IDENTITY_MESSAGE, v: 1, accounts: new Array(5000).fill('x') }), null);
        assert.equal(decodeInvalidation({ type: 'other', v: 1, accounts: [A] }), null);
        assert.equal(decodeInvalidation(null), null);
    });

    test('single-process mode (no IPC channel) invalidates locally and does not throw', async () => {
        const { chain, resolver } = setup({}, { [A]: 'One' });
        await resolver.getIdentity(API, A);
        chain.table[A] = 'Two';
        const inv = createIdentityInvalidator({ resolver, proc: {} });
        inv.invalidate([A]);
        assert.equal(await resolver.getIdentity(API, A), 'Two');
    });
});

describe('derived caches: the validators list and holders', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
    function freshDb() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-ident-'));
        dirs.push(dir);
        db.initDb(dir, false, { awaitMigrator: false });
        db.replaceValidators([
            { address: A, name: 'Unknown', totalStake: 10, commission: 5, realApy: 1 },
            { address: S1, name: 'Parent Co / n1', totalStake: 9, commission: 5, realApy: 1 },
            { address: B, name: 'Other', totalStake: 8, commission: 5, realApy: 1 }
        ], { totalCount: 3, lastSync: 1, status: 'Synced' });
        db.replaceHolders([{ address: A, rank: 1, name: 'Unknown', balance: 5, share: 1 }], { totalCount: 1, lastSync: 1, status: 'Synced' });
    }
    const targets = () => [db.updateValidatorName, db.updateHolderName];
    const nameOf = (addr) => db.getValidators().validators.find(v => v.address === addr).name;

    test('after IdentitySet the validators list and holders show the new name on the next read, with the payload shape unchanged', async () => {
        freshDb();
        const shapeBefore = Object.keys(db.getValidators().validators[0]).sort();
        const holderShapeBefore = Object.keys(db.getHolders().holders[0]).sort();
        const { chain, resolver } = setup({}, {});
        assert.equal(await resolver.getIdentity(API, A), 'Unknown');
        chain.table[A] = 'Synthetic Validator';
        const affected = resolver.invalidate(identityEventAccounts([{ event: { section: 'identity', method: 'IdentitySet', data: [{ toString: () => A }] } }]));
        const changed = await refreshDerivedNames(affected, { getName: (a) => resolver.getIdentity(API, a), setters: targets() });
        assert.equal(changed, 2);
        assert.equal(nameOf(A), 'Synthetic Validator');
        assert.equal(db.getHolders().holders[0].name, 'Synthetic Validator');
        assert.equal(nameOf(B), 'Other', 'rows of other accounts are untouched');
        assert.deepEqual(Object.keys(db.getValidators().validators[0]).sort(), shapeBefore);
        assert.deepEqual(Object.keys(db.getHolders().holders[0]).sort(), holderShapeBefore);
    });

    test('a changed parent refreshes the stored name of its sub-identity validators too', async () => {
        freshDb();
        const { chain, resolver } = setup({}, { [P]: 'Parent Co', [S1]: 'n1' }, { [S1]: P });
        await resolver.getIdentity(API, S1);
        chain.table[P] = 'Parent Renamed';
        const affected = resolver.invalidate([P]);
        await refreshDerivedNames(affected, { getName: (a) => resolver.getIdentity(API, a), setters: targets() });
        assert.equal(nameOf(S1), 'Parent Renamed / n1');
    });

    test('an identity that was cleared goes back to Unknown in the list', async () => {
        freshDb();
        db.updateValidatorName(B, 'Stale Name');
        const { resolver } = setup({}, {});
        await refreshDerivedNames([B], { getName: (a) => resolver.getIdentity(API, a), setters: targets() });
        assert.equal(nameOf(B), 'Unknown');
    });

    test('a failing name read for one account does not stop the others', async () => {
        freshDb();
        const getName = async (a) => { if (a === A) throw new Error('boom'); return 'Fine Name'; };
        const changed = await refreshDerivedNames([A, B], { getName, setters: targets() });
        assert.equal(changed, 1);
        assert.equal(nameOf(B), 'Fine Name');
    });

    test('the debounced refresher batches bursts into one refresh of the union of accounts', async () => {
        const timers = []; const calls = [];
        const r = createDebouncedRefresher({
            refresh: async (list) => { calls.push([...list].sort()); },
            delayMs: 2000,
            setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
            clearTimer: (t) => { t.cleared = true; }
        });
        r.add([A]); r.add([B, A]);
        assert.equal(timers.filter(t => !t.cleared).length, 2, 'one quiet-period timer and one max-wait timer');
        assert.equal(timers[0].ms, 2000);
        await timers.find(t => !t.cleared).fn();
        assert.deepEqual(calls, [[A, B].sort()]);
        r.add([S1]);
        await timers.filter(t => !t.cleared).pop().fn();
        assert.deepEqual(calls[1], [S1]);
    });
});

describe('wiring in server.js', () => {
    const src = stripComments(readRepo('server.js', import.meta.url));

    test('getIdentity goes through the resolver, no raw never-expiring Map remains', () => {
        assert.ok(!/const identityCache = new Map\(\)/.test(src));
        assert.ok(/createIdentityResolver\(/.test(src));
        assert.match(src, /async function getIdentity\(api, address\) \{\s*return identityResolver\.getIdentity\(api, address\)/);
    });

    test('the block scanner invalidates identity accounts BEFORE it looks up the author and signer names', () => {
        const scan = src.slice(src.indexOf('async function scanSingleBlock'));
        const inval = scan.indexOf('noteIdentityEvents(');
        const author = scan.indexOf('getIdentityForStore(globalApi, authorAddr)');
        assert.ok(inval > 0 && author > 0 && inval < author, 'invalidate first so the stored author/signer name is fresh');
    });

    test('the primary runs the relay and every worker listens', () => {
        assert.ok(/startIdentityRelay\(\{\s*cluster\s*\}\)/.test(src));
        assert.ok(/receiveIdentityInvalidations\(/.test(src));
    });
});

// ---------------------------------------------------------------------------
// Review round 2: read outcomes, stale-while-error, flood-safe debounce, LRU,
// and end-to-end event invalidation.
// ---------------------------------------------------------------------------

describe('three read outcomes: found / none / failed', () => {
    const dirs2 = [];
    after(() => { for (const d of dirs2) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
    function seedDb() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-ident2-'));
        dirs2.push(dir);
        db.initDb(dir, false, { awaitMigrator: false });
        db.replaceValidators([{ address: A, name: 'Stored Good Name', totalStake: 10, commission: 5, realApy: 1 }], { totalCount: 1, lastSync: 1, status: 'Synced' });
        db.replaceHolders([{ address: A, rank: 1, name: 'Stored Good Name', balance: 5, share: 1 }], { totalCount: 1, lastSync: 1, status: 'Synced' });
    }
    const setters = () => [db.updateValidatorName, db.updateHolderName];

    test('resolve reports found, none and failed distinctly', async () => {
        const { chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        assert.deepEqual(await resolver.resolve(API, A), { name: 'Synthetic Validator', status: 'found' });
        assert.deepEqual(await resolver.resolve(API, B), { name: 'Unknown', status: 'none' });
        chain.fail = true;
        assert.deepEqual(await resolver.resolve(API, 'stash-cccc'), { name: 'Unknown', status: 'failed' });
        assert.deepEqual(await resolver.resolve(null, 'stash-dddd'), { name: 'Unknown', status: 'failed' }, 'unusable api is a failed read too');
    });

    test('a failed chain read during the derived refresh keeps the stored name, in both tables', async () => {
        seedDb();
        const { chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        chain.fail = true;
        const changed = await refreshDerivedNames([A], { getName: (a) => resolver.resolve(API, a), setters: setters() });
        assert.equal(changed, 0);
        assert.equal(db.getValidators().validators[0].name, 'Stored Good Name');
        assert.equal(db.getHolders().holders[0].name, 'Stored Good Name');
    });

    test('a confirmed no-identity still overwrites the stored name with Unknown', async () => {
        seedDb();
        const { resolver } = setup({}, {});
        const changed = await refreshDerivedNames([A], { getName: (a) => resolver.resolve(API, a), setters: setters() });
        assert.equal(changed, 2);
        assert.equal(db.getValidators().validators[0].name, 'Unknown');
    });

    test('a plain-string getName (older callers) is still written as before', async () => {
        seedDb();
        const changed = await refreshDerivedNames([A], { getName: async () => 'Plain Name', setters: setters() });
        assert.equal(changed, 2);
    });
});

describe('stale-while-error', () => {
    const BACKOFF = 30 * 1000;

    test('an expired positive entry whose refresh read fails serves the last known name, marked stale', async () => {
        const { c, chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        assert.equal(await resolver.getIdentity(API, A), 'Synthetic Validator');
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        chain.fail = true;
        assert.deepEqual(await resolver.resolve(API, A), { name: 'Synthetic Validator', status: 'stale' });
        assert.equal(await resolver.getIdentity(API, A), 'Synthetic Validator');
    });

    test('while stale it does not hammer the chain: one retry only after the backoff', async () => {
        const { c, chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        await resolver.getIdentity(API, A);
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        chain.fail = true;
        await resolver.getIdentity(API, A);
        const reads = chain.reads;
        c.advance(BACKOFF - 1000);
        await resolver.getIdentity(API, A);
        await resolver.getIdentity(API, A);
        assert.equal(chain.reads, reads, 'inside the backoff: served stale, no read');
        c.advance(2000);
        chain.fail = false; chain.table[A] = 'Renamed Validator';
        assert.equal(await resolver.getIdentity(API, A), 'Renamed Validator');
        assert.equal(chain.reads, reads + 1);
        assert.equal((await resolver.resolve(API, A)).status, 'found');
    });

    test('if the retry succeeds with no identity, the stale name is dropped (identity was cleared)', async () => {
        const { c, chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        await resolver.getIdentity(API, A);
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        chain.fail = true;
        await resolver.getIdentity(API, A);
        c.advance(BACKOFF + 1);
        chain.fail = false; delete chain.table[A];
        assert.deepEqual(await resolver.resolve(API, A), { name: 'Unknown', status: 'none' });
    });

    test('an invalidation removes the last known name too: a failed read after an event is Unknown, not stale', async () => {
        const { c, chain, resolver } = setup({}, { [A]: 'Synthetic Validator' });
        await resolver.getIdentity(API, A);
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        chain.fail = true;
        await resolver.getIdentity(API, A);
        resolver.invalidate([A]);
        assert.deepEqual(await resolver.resolve(API, A), { name: 'Unknown', status: 'failed' });
    });

    test('a failed read with nothing known is Unknown and uncached', async () => {
        const { chain, cache, resolver } = setup({}, {});
        chain.fail = true;
        assert.deepEqual(await resolver.resolve(API, A), { name: 'Unknown', status: 'failed' });
        assert.equal(cache.size(), 0);
    });

    test('the last-known store is bounded by the cache cap', async () => {
        const { c, chain, cache, resolver } = setup({ max: 3 }, {});
        for (let i = 0; i < 6; i++) chain.table[`k${i}`] = `Name ${i}`;
        for (let i = 0; i < 3; i++) await resolver.getIdentity(API, `k${i}`);
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        for (let i = 0; i < 3; i++) cache.get(`k${i}`);
        for (let i = 3; i < 6; i++) await resolver.getIdentity(API, `k${i}`);
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        for (let i = 3; i < 6; i++) cache.get(`k${i}`);
        assert.ok(cache.lastKnownSize() <= 3);
    });
});

describe('debounce max-wait, pending cap, coalescing', () => {
    function rig(opts = {}) {
        const timers = []; const calls = []; const alls = [];
        const r = createDebouncedRefresher({
            refresh: async (list) => { calls.push([...list].sort()); },
            refreshAll: async () => { alls.push(1); },
            setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
            clearTimer: (t) => { t.cleared = true; },
            ...opts
        });
        const live = () => timers.filter(t => !t.cleared);
        return { r, timers, calls, alls, live };
    }

    test('a steady stream cannot defer the refresh forever: a 5 s max-wait timer starts at the first item and is not reset', async () => {
        const { r, timers, calls, live } = rig();
        r.add([A]);
        const maxTimer = timers.find(t => t.ms === 5000);
        assert.ok(maxTimer, 'a max-wait timer of 5000 ms exists');
        for (let i = 0; i < 20; i++) r.add([`s${i}`]);
        assert.equal(maxTimer.cleared, false, 'new arrivals never reset the max-wait');
        assert.equal(timers.filter(t => t.ms === 5000).length, 1);
        await maxTimer.fn();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].length, 21);
        assert.equal(live().length, 0, 'the quiet-period timer is cleared when the max-wait fires');
    });

    test('the quiet-period flush still works and clears the max-wait timer', async () => {
        const { r, timers, calls, live } = rig();
        r.add([A]); r.add([B]);
        const quiet = timers.find(t => t.ms === 2000 && !t.cleared);
        await quiet.fn();
        assert.deepEqual(calls, [[A, B].sort()]);
        assert.equal(live().length, 0);
        r.add([S1]);
        assert.ok(live().some(t => t.ms === 5000), 'a new batch gets a new max-wait');
    });

    test('duplicates coalesce and do not count toward the cap', async () => {
        const { r, calls, alls, live } = rig({ maxPending: 3 });
        for (let i = 0; i < 100; i++) r.add([A, B]);
        await live().find(t => t.ms === 2000).fn();
        assert.deepEqual(calls, [[A, B].sort()]);
        assert.equal(alls.length, 0);
    });

    test('past the pending cap it drops the set and runs one full refresh instead', async () => {
        const { r, calls, alls, live } = rig({ maxPending: 2000 });
        const many = Array.from({ length: 2001 }, (_, i) => `acct-${i}`);
        r.add(many);
        r.add(['one-more']);
        for (const t of live()) await t.fn();
        assert.equal(alls.length, 1, 'exactly one full refresh');
        assert.equal(calls.length, 0, 'no per-account refresh of a huge list');
        r.add([A]);
        await live().find(t => t.ms === 2000).fn();
        assert.deepEqual(calls, [[A]], 'back to normal afterwards');
    });

    test('pending memory is bounded: the set never exceeds the cap', () => {
        const { r } = rig({ maxPending: 10 });
        for (let i = 0; i < 1000; i++) r.add([`x${i}`]);
        assert.ok(r.pendingCount() <= 10);
    });
});

describe('least-recently-used eviction', () => {
    test('a read refreshes recency: the entry evicted is the one not touched longest', () => {
        const c = clock();
        const cache = createIdentityCache({ now: c.now, max: 3 });
        cache.set('k1', 'n1'); cache.set('k2', 'n2'); cache.set('k3', 'n3');
        assert.equal(cache.get('k1'), 'n1');
        cache.set('k4', 'n4');
        assert.equal(cache.get('k2'), undefined, 'k2 was least recently used');
        assert.equal(cache.get('k1'), 'n1');
        assert.equal(cache.get('k3'), 'n3');
    });

    test('a hot validator name survives a flood of one-off public account lookups', async () => {
        const V = 'validator-vvvv';
        const table = { [V]: 'Hot Validator' };
        for (let i = 0; i < 40; i++) table[`pub-${i}`] = `Public ${i}`;
        const { chain, resolver } = setup({ max: 5 }, table);
        await resolver.getIdentity(API, V);
        for (let i = 0; i < 40; i++) {
            await resolver.getIdentity(API, `pub-${i}`);
            if (i % 2 === 0) await resolver.getIdentity(API, V);
        }
        const reads = chain.reads;
        assert.equal(await resolver.getIdentity(API, V), 'Hot Validator');
        assert.equal(chain.reads, reads, 'still cached after the flood');
        assert.equal(chain.reads, 41, 'the validator was read from the chain exactly once');
    });
});

describe('identity events invalidate exactly the right accounts, end to end', () => {
    const rec = (method, ...data) => ({ event: { section: 'identity', method, data: data.map(d => ({ toString: () => d })) } });
    const mk = (table, parents) => {
        const s = setup({}, table, parents);
        const inv = createIdentityInvalidator({ resolver: s.resolver, proc: {} });
        return { ...s, fire: (...records) => inv.invalidate(identityEventAccounts(records)) };
    };
    async function warm(resolver, keys) { for (const k of keys) await resolver.getIdentity(API, k); }

    test('JudgementGiven drops the target only, not the registrar slot or bystanders', async () => {
        const { chain, resolver, fire } = mk({ [A]: 'Target', [B]: 'Bystander', '0': 'RegistrarIndexLooksLikeAnAccount' });
        await warm(resolver, [A, B, '0']);
        chain.table[A] = 'Target Verified';
        assert.deepEqual(fire(rec('JudgementGiven', A, '0')), [A]);
        const before = chain.reads;
        assert.equal(await resolver.getIdentity(API, A), 'Target Verified');
        await resolver.getIdentity(API, B); await resolver.getIdentity(API, '0');
        assert.equal(chain.reads, before + 1, 'only the target was re-read');
    });

    test('JudgementRequested and JudgementUnrequested drop the requesting account', async () => {
        for (const m of ['JudgementRequested', 'JudgementUnrequested']) {
            const { chain, resolver, fire } = mk({ [A]: 'One', [B]: 'Two' });
            await warm(resolver, [A, B]);
            chain.table[A] = 'Changed';
            fire(rec(m, A, '1'));
            assert.equal(await resolver.getIdentity(API, A), 'Changed', m);
            assert.equal(await resolver.getIdentity(API, B), 'Two', m);
        }
    });

    test('SubIdentityRenamed drops the sub, the main account and every other cached sub of that main', async () => {
        const { chain, resolver, fire } = mk({ [P]: 'Parent Co', [S1]: 'one', [S2]: 'two', [B]: 'Other' }, { [S1]: P, [S2]: P });
        await warm(resolver, [P, S1, S2, B]);
        chain.table[S1] = 'one renamed';
        const affected = fire(rec('SubIdentityRenamed', S1, P));
        assert.deepEqual([...affected].sort(), [P, S1, S2].sort());
        assert.equal(await resolver.getIdentity(API, S1), 'Parent Co / one renamed');
        const before = chain.reads;
        await resolver.getIdentity(API, B);
        assert.equal(chain.reads, before, 'the unrelated account stays cached');
    });

    test('SubIdentityRemoved: the removed sub is re-read and no longer shows the parent prefix', async () => {
        const { chain, resolver, fire } = mk({ [P]: 'Parent Co', [S1]: 'one', [S2]: 'two' }, { [S1]: P, [S2]: P });
        await warm(resolver, [P, S1, S2]);
        delete chain.parents[S1]; delete chain.table[S1];
        const affected = fire(rec('SubIdentityRemoved', S1, P, '5'));
        assert.deepEqual([...affected].sort(), [P, S1, S2].sort());
        assert.equal(await resolver.getIdentity(API, S1), 'Unknown');
        assert.equal(await resolver.getIdentity(API, S2), 'Parent Co / two', 'sibling re-read and still named');
    });

    test('SubIdentityRevoked and SubIdentitiesSet drop the main account and its subs', async () => {
        const { resolver, fire } = mk({ [P]: 'Parent Co', [S1]: 'one' }, { [S1]: P });
        await warm(resolver, [P, S1]);
        assert.deepEqual([...fire(rec('SubIdentityRevoked', S1, P, '5'))].sort(), [P, S1].sort());
        await warm(resolver, [P, S1]);
        assert.deepEqual([...fire(rec('SubIdentitiesSet', P, '2', '9'))].sort(), [P, S1].sort());
    });
});

// ---------------------------------------------------------------------------
// Review of the live fix: names that are PERSISTED must never come from a failed
// read. Display callers may keep showing "Unknown"; callers that write a name to
// the database get the read outcome and keep the previous stored name (or store
// nothing, NULL, that a healing pass fills in later).
// ---------------------------------------------------------------------------

import { IDENTITY_READ_TIMEOUT_MS } from '../lib/identity-cache.js';
import { noteUnnamed, healUnnamedNames, HEAL_KEY } from '../lib/identity-heal.js';

describe('A1: resolveForStore tells a stored name from a failed read', () => {
    test('failed is not known; found, none and stale are', async () => {
        const { c, chain, resolver } = setup({}, { [A]: 'Alice' });
        assert.deepEqual(await resolver.resolveForStore(API, A), { name: 'Alice', known: true });
        assert.deepEqual(await resolver.resolveForStore(API, B), { name: 'Unknown', known: true }, 'a confirmed no identity is a fact');
        chain.fail = true;
        const r = await resolver.resolveForStore(API, 'stash-cccc');
        assert.equal(r.known, false);
        // an expired found name served stale after a failed refresh is still the real last-known name
        c.advance(IDENTITY_TTL_FOUND_MS + 1);
        const st = await resolver.resolveForStore(API, A);
        assert.deepEqual(st, { name: 'Alice', known: true });
    });

    test('an unusable api is a failed read', async () => {
        const { resolver } = setup({}, { [A]: 'Alice' });
        assert.equal((await resolver.resolveForStore(null, A)).known, false);
    });
});

describe('A4: an in-flight read times out and is settled as failed', () => {
    test('the timeout is 15 seconds', () => { assert.equal(IDENTITY_READ_TIMEOUT_MS, 15_000); });

    function hung() {
        const timers = [];
        const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
        const clearTimer = (t) => { if (t) t.cleared = true; };
        let release;
        const gate = new Promise(r => { release = r; });
        let reads = 0;
        const readChain = async () => { reads++; await gate; return 'Late Name'; };
        const c = clock();
        const resolver = createIdentityResolver({ cache: createIdentityCache({ now: c.now }), readChain, setTimer, clearTimer });
        return { timers, release, resolver, reads: () => reads, c };
    }

    test('a read that never answers settles as failed, frees the in-flight slot, and a later call reads afresh after the backoff', async () => {
        const h = hung();
        const p = h.resolver.resolve(API, A);
        assert.equal(h.resolver.inflightCount(), 1);
        assert.equal(h.timers.length, 1);
        assert.equal(h.timers[0].ms, IDENTITY_READ_TIMEOUT_MS);
        h.timers[0].fn();
        const r = await p;
        assert.equal(r.status, 'failed');
        assert.equal(h.resolver.inflightCount(), 0);
        h.c.advance(IDENTITY_STALE_BACKOFF_MS + 1);
        const again = h.resolver.resolve(API, A);
        assert.equal(h.reads(), 2, 'after the backoff the next call starts a new read');
        h.release();
        await again;
    });

    test('M6: during the failed backoff after a timeout with no last-known name, a lookup settles as failed at once, with no new read', async () => {
        const h = hung();
        const p = h.resolver.resolve(API, A);
        h.timers[0].fn();
        await p;
        h.c.advance(IDENTITY_STALE_BACKOFF_MS - 1);
        const second = h.resolver.resolve(API, A);
        const reads = h.reads(), timers = h.timers.length;
        h.release();
        const r = await second;
        assert.equal(reads, 1, 'no second read while the backoff runs');
        assert.equal(timers, 1, 'no second 15 s wait');
        assert.equal(r.status, 'failed');
        assert.equal((await h.resolver.resolveForStore(API, A)).known, false, 'still never stored');
    });

    test('the late answer of the abandoned read is not cached', async () => {
        const h = hung();
        const p = h.resolver.resolve(API, A);
        h.timers[0].fn();
        await p;
        h.release();
        await new Promise(r => setImmediate(r));
        h.c.advance(IDENTITY_STALE_BACKOFF_MS + 1);
        const fresh = h.resolver.resolve(API, A);
        assert.equal(h.reads(), 2, 'nothing was cached from the abandoned read');
        await fresh;
    });

    test('a read that answers in time clears its timer', async () => {
        const timers = [];
        const resolver = createIdentityResolver({ cache: createIdentityCache(), readChain: async () => 'Quick', setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
        const r = await resolver.resolve(API, A);
        assert.equal(r.name, 'Quick');
        assert.ok(timers.length === 1 && timers[0].cleared);
    });
});

describe('A1: stored rows written without a name are healed later', () => {
    const dirs = [];
    after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
    function freshDb() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdex-ident-heal-'));
        dirs.push(dir);
        db.initDb(dir, true);
    }
    const blk = (number, authorAddress, authorName) => ({ number, hash: `0xb${number}`, authorAddress, authorName, extrinsicsCount: 1, eventsCount: 1, timestamp: 1000 + number });
    const ev = (n, block, signerAddress, signerName) => ({ hash: `e${n}`, txHash: null, blockHash: `0xb${block}`, block, eventIndex: 0, extrinsicIndex: null, section: 's', method: 'm', data: {}, signerAddress, signerName, timestamp: 1, status: 'success' });
    const nameOfBlock = (n) => db.getRecentBlocks(50).find(b => b.number === n).authorName;
    const nameOfEvent = (n) => db.getRecentEvents(50).find(e => e.hash === `e${n}`).signerName;

    test('a block re-scanned during an RPC blip keeps the stored author name; an absent name reads as Unknown', () => {
        freshDb();
        db.insertBlocks([blk(100, A, 'Alice'), blk(101, A, null)]);
        assert.equal(nameOfBlock(101), 'Unknown');
        db.insertBlocks([blk(100, A, null)]);
        assert.equal(nameOfBlock(100), 'Alice', 'a REPLACE with no name does not erase the stored one');
    });

    test('the healing pass names blocks and events of an account once the read works, and keeps the rest pending', async () => {
        freshDb();
        db.insertBlocks([blk(100, A, null), blk(101, A, null), blk(102, B, null), blk(103, A, 'Kept')]);
        db.insertEvents([ev(1, 100, A, null), ev(2, 102, B, null), ev(3, 101, A, 'Kept2')]);
        noteUnnamed(db, A, 100); noteUnnamed(db, A, 101); noteUnnamed(db, B, 102);
        const answers = { [A]: { name: 'Alice', status: 'found' }, [B]: { status: 'failed', name: 'Unknown' } };
        const out = await healUnnamedNames({ db, resolve: async (a) => answers[a] });
        assert.equal(nameOfBlock(100), 'Alice'); assert.equal(nameOfBlock(101), 'Alice');
        assert.equal(nameOfBlock(103), 'Kept', 'a named block is not touched');
        assert.equal(nameOfEvent(1), 'Alice');
        assert.equal(nameOfEvent(3), 'Kept2');
        assert.equal(nameOfBlock(102), 'Unknown'); assert.equal(nameOfEvent(2), 'Unknown');
        assert.deepEqual(Object.keys(db.getKv(HEAL_KEY)), [B], 'only the failed account stays pending');
        assert.equal(out.pending, 1);
        answers[B] = { name: 'Unknown', status: 'none' };
        await healUnnamedNames({ db, resolve: async (a) => answers[a] });
        assert.deepEqual(Object.keys(db.getKv(HEAL_KEY) || {}), []);
    });

    test('forum posts stored without an author name are healed by address, and read as Unknown meanwhile', async () => {
        freshDb();
        const id = db.createPost({ threadId: 't', author: A, authorName: null, content: 'x' });
        assert.equal(db.getPost(id).authorName, 'Unknown');
        await healUnnamedNames({ db, resolve: async () => ({ name: 'Alice', status: 'found' }) });
        assert.equal(db.getPost(id).authorName, 'Alice');
    });

    test('a validator or holder stored without a name reads as Unknown', () => {
        freshDb();
        db.replaceValidators([{ address: A, name: null, totalStake: 1, commission: 1, realApy: 1 }], { totalCount: 1, lastSync: 1, status: 'Synced' });
        db.replaceHolders([{ address: A, rank: 1, name: null, balance: 1, share: 1 }], { totalCount: 1, lastSync: 1, status: 'Synced' });
        assert.equal(db.getValidators().validators[0].name, 'Unknown');
        assert.equal(db.getHolders().holders[0].name, 'Unknown');
    });
});

describe('A1: every caller that persists a name uses the read outcome (server.js)', () => {
    const src = stripComments(readRepo('server.js', import.meta.url));
    const between = (a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i); assert.ok(j > i, b); return src.slice(i, j); };

    test('the block scanner stores author and signer names from resolveForStore, not getIdentity', () => {
        const scan = between('async function scanSingleBlock', 'async function getBlockTolerant');
        assert.ok(!/getIdentity\(/.test(scan));
        assert.ok(/getIdentityForStore\(globalApi, authorAddr\)/.test(scan) && /getIdentityForStore\(globalApi, signerAddress\)/.test(scan));
        assert.ok(/noteUnnamed\(/.test(scan));
    });
    test('the validator and holder syncs, the forum post and the choice snapshot do not persist a failed read', () => {
        assert.ok(!/getIdentity\(/.test(between('async function syncData()', 'async function syncHolders()')), 'validator sync');
        assert.ok(!/getIdentity\(/.test(between('async function syncHolders()', 'isSyncingHolders = false;')), 'holder sync');
        assert.ok(!/getIdentity\(/.test(between('async function syncValidatorChoice', "db.setKv('validator_choice'")), 'choice snapshot');
        const post = between('let authorName', 'db.createPost(');
        assert.ok(/getIdentityForStore\(/.test(post) && !/getIdentity\(/.test(post), 'forum post');
    });
    test('the healing pass runs in the indexer', () => {
        assert.ok(/healUnnamedNames\(/.test(src));
    });
});
