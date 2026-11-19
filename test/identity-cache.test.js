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
    IDENTITY_TTL_FOUND_MS, IDENTITY_TTL_UNKNOWN_MS, IDENTITY_CACHE_MAX, IDENTITY_MESSAGE, IDENTITY_EVENT_METHODS,
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
        assert.equal(timers.filter(t => !t.cleared).length, 1);
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
        const author = scan.indexOf('getIdentity(globalApi, authorAddr)');
        assert.ok(inval > 0 && author > 0 && inval < author, 'invalidate first so the stored author/signer name is fresh');
    });

    test('the primary runs the relay and every worker listens', () => {
        assert.ok(/startIdentityRelay\(\{\s*cluster\s*\}\)/.test(src));
        assert.ok(/receiveIdentityInvalidations\(/.test(src));
    });
});
