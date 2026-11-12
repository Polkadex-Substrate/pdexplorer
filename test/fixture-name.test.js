import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { networkFromGenesis, fixtureFileName, resolveFixtureName } from '../lib/fixture-name.js';

describe('fixture file naming', () => {
    test('metadata-<network>-<spec>.json', () => {
        assert.equal(fixtureFileName('testnet', 393), 'metadata-testnet-393.json');
        assert.equal(fixtureFileName('mainnet', 373), 'metadata-mainnet-373.json');
    });
    test('network comes from the genesis hash, case-insensitively', () => {
        const g = '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c';
        assert.equal(networkFromGenesis(g), 'mainnet');
        assert.equal(networkFromGenesis(g.toUpperCase().replace('0X', '0x')), 'mainnet');
        assert.equal(networkFromGenesis('0xdead'), null);
        assert.equal(networkFromGenesis(undefined), null);
    });
    test('unknown genesis is refused unless a network is given; override wins', () => {
        assert.throws(() => resolveFixtureName({ genesisHash: '0xdead', specVersion: 1 }), /--network/);
        assert.deepEqual(resolveFixtureName({ genesisHash: '0xdead', specVersion: 5, networkOverride: 'devnet' }), { network: 'devnet', file: fixtureFileName('devnet', 5) });
    });
    test('bad names and specs are rejected', () => {
        assert.throws(() => fixtureFileName('../x', 1));
        assert.throws(() => fixtureFileName('mainnet', 0));
        assert.throws(() => fixtureFileName('mainnet', '373'));
    });
    test('every committed fixture is named exactly as the script would name it', () => {
        const dir = new URL('./fixtures/', import.meta.url);
        const files = readdirSync(dir).filter(f => f.endsWith('.json'));
        assert.ok(files.length >= 2);
        for (const f of files) {
            const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
            assert.equal(resolveFixtureName({ genesisHash: j.genesisHash, specVersion: j.specVersion }).file, f);
            assert.equal(j.network, networkFromGenesis(j.genesisHash));
        }
    });
});
