// Sprint R3, the effects rows of the wallet actions (design cto-team/plans/2026-11-22-post-action-refresh-design.md,
// section 3 rows 7, 8 and 20): what the block's events PROVE about the identity name and the proxy list.
//   identity.set:   IdentitySet { who = signer } and a display name typed: set identity.name = that name
//   identity.clear: IdentityCleared { who = signer }: set identity.name = null
//   proxy.remove:   ProxyRemoved { delegator = signer, delegatee, proxyType }: remove `${delegate}:${type}`
// No event for this account, an empty display or a failed outcome claims nothing. Dev account addresses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { effectsFor } from '../lib/action-effects.js';
import { ME, OTHER, V1 } from './helpers/payout-events.js';

const ev = (section, method, data = []) => ({ event: { section, method, data } });
const success = ev('system', 'ExtrinsicSuccess');
const OK = { ok: true, tone: 'ok' };
const run = (key, params, events, over = {}) => effectsFor({ key, params, stage: 'inBlock', events, blockNumber: 42, txHash: '0xab', signer: ME, outcome: OK, ...over });

describe('identity.set and identity.clear: the name the block proves', () => {
    test('IdentitySet for the signer with a display name: the name is set at once', () => {
        const eff = run('identity.set', { display: 'Alice Node' }, [ev('identity', 'IdentitySet', [ME]), success]);
        assert.deepEqual(eff.known, [{ account: ME, domain: 'identity', op: 'set', key: 'name', value: 'Alice Node' }]);
        assert.deepEqual(eff.changes, [{ account: ME, domains: ['identity', 'balance'] }]);
    });
    test('no IdentitySet, one for another account, or no display typed: nothing is claimed (the page still re-reads)', () => {
        assert.deepEqual(run('identity.set', { display: 'Alice Node' }, [success]).known, []);
        assert.deepEqual(run('identity.set', { display: 'Alice Node' }, [ev('identity', 'IdentitySet', [OTHER]), success]).known, []);
        assert.deepEqual(run('identity.set', { display: '   ' }, [ev('identity', 'IdentitySet', [ME]), success]).known, []);
        assert.deepEqual(run('identity.set', {}, [ev('identity', 'IdentitySet', [ME]), success]).known, []);
        assert.deepEqual(run('identity.set', { display: 'Alice Node' }, [success]).changes, [{ account: ME, domains: ['identity', 'balance'] }]);
    });
    test('IdentityCleared for the signer: the name is set to none', () => {
        const eff = run('identity.clear', {}, [ev('identity', 'IdentityCleared', [ME, '1000']), success]);
        assert.deepEqual(eff.known, [{ account: ME, domain: 'identity', op: 'set', key: 'name', value: null }]);
        assert.deepEqual(run('identity.clear', {}, [ev('identity', 'IdentityCleared', [OTHER, '1000']), success]).known, []);
    });
    test('a failed outcome or a stage that is not an inclusion: nothing at all', () => {
        assert.equal(run('identity.set', { display: 'Alice Node' }, [ev('identity', 'IdentitySet', [ME])], { outcome: { ok: false } }), null);
        assert.equal(run('identity.clear', {}, [ev('identity', 'IdentityCleared', [ME])], { stage: 'failed' }), null);
    });
});

describe('proxy.remove: the row the block proves gone', () => {
    test('ProxyRemoved naming this delegate and type: that row is removed for the signer', () => {
        const eff = run('proxy.remove', { delegate: V1, type: 'Staking' }, [ev('proxy', 'ProxyRemoved', [ME, V1, 'Staking', 0]), success]);
        assert.deepEqual(eff.known, [{ account: ME, domain: 'proxies', op: 'remove', key: `${V1}:Staking`, value: null }]);
    });
    test('another delegate, another type, another delegator or no event: nothing is claimed', () => {
        assert.deepEqual(run('proxy.remove', { delegate: V1, type: 'Staking' }, [ev('proxy', 'ProxyRemoved', [ME, OTHER, 'Staking', 0]), success]).known, []);
        assert.deepEqual(run('proxy.remove', { delegate: V1, type: 'Staking' }, [ev('proxy', 'ProxyRemoved', [ME, V1, 'Any', 0]), success]).known, []);
        assert.deepEqual(run('proxy.remove', { delegate: V1, type: 'Staking' }, [ev('proxy', 'ProxyRemoved', [OTHER, V1, 'Staking', 0]), success]).known, []);
        assert.deepEqual(run('proxy.remove', { delegate: V1, type: 'Staking' }, [success]).known, []);
    });
    test('proxy.add claims no row (the list re-reads the chain)', () => {
        assert.deepEqual(run('proxy.add', { delegate: V1, type: 'Staking', delay: 0 }, [ev('proxy', 'ProxyAdded', [ME, V1, 'Staking', 0]), success]).known, []);
    });
});
