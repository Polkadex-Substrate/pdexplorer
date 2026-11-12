// Guard: the committed runtime-metadata fixtures exist and are what their names
// say. Real-codec suites throw when a fixture is missing (loadFixture), so CI
// cannot pass without them; this single test lists ALL problems at once and
// pins each file's chain and spec, so a rename or a refresh from the wrong
// network is caught here and not by a confusing decode error elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIR, loadFixture } from './helpers/extrinsic-builders.js';

const EXPECTED = [
    { file: 'metadata-mainnet-373.json', network: 'mainnet', specVersion: 373 },
    { file: 'metadata-testnet-393.json', network: 'testnet', specVersion: 393 }
];

test('every metadata fixture the suites read is present and non-empty', () => {
    const problems = EXPECTED.filter(e => !existsSync(join(FIXTURE_DIR, e.file))).map(e => `missing: ${e.file}`);
    assert.deepEqual(problems, [], `fixtures missing from ${FIXTURE_DIR}: ${problems.join(', ')}`);
});

for (const e of EXPECTED) {
    test(`${e.file} is ${e.network} spec ${e.specVersion} with usable metadata`, () => {
        const fx = loadFixture(e.file);
        assert.equal(fx.network, e.network);
        assert.equal(fx.specVersion, e.specVersion);
        assert.match(fx.metadata, /^0x6d657461/, 'state_getMetadata hex starts with the "meta" magic');
        assert.ok(readFileSync(join(FIXTURE_DIR, e.file)).length > 100_000);
    });
}

test('no test names a fixture file that is not in the expected list', () => {
    const dir = new URL('.', import.meta.url).pathname;
    const named = new Set();
    for (const f of readdirSync(dir).filter(n => n.endsWith('.js'))) {
        if (f === 'fixtures.test.js' || f === 'fetch-metadata.test.js') continue;
        for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/metadata-[a-z0-9-]+\.json/g)) named.add(m[0]);
    }
    const known = new Set(EXPECTED.map(e => e.file));
    assert.deepEqual([...named].filter(n => !known.has(n)), []);
});
