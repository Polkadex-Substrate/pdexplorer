// Guard: the two fixes in lib/tx-extensions.js are load-bearing.
//
// This file deliberately does NOT install them (node --test runs each file in
// its own process, so the prototype wrappers from tx-extensions.test.js are
// not present here). It pins down what the stock @polkadot/types 17.0.2 gets
// wrong on a runtime shaped like Polkadex 392. If one of these starts failing
// after a library upgrade, upstream has fixed that defect: re-run
// tx-extensions.test.js, and only then consider removing the matching wrapper.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { blake2AsHex } from '@polkadot/util-crypto';
import { hexToU8a } from '@polkadot/util';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { compactFromU8a, u8aToHex } from '@polkadot/util';
import { registryFromMetadata, buildSignedV4, buildGeneralV5, remarkCall, sampleAssetId } from './helpers/extrinsic-builders.js';

const IMMORTAL = new Uint8Array([0x00]);
const values = (assetId) => ({
    CheckMortality: IMMORTAL, CheckNonce: 5,
    ChargeAssetTxPayment: { tip: 1000, assetId }, CheckMetadataHash: { mode: 'Disabled' }
});

describe('stock @polkadot/types without lib/tx-extensions.js', () => {
    let registry;
    before(() => { registry = registryFromMetadata(substrateMetadata); });

    test('reads ChargeAssetTxPayment.assetId as Option<MultiLocation>, not the runtime type', () => {
        assert.match(registry.createType('TAssetConversion').toRawType(), /Junctions|MultiLocation|parents/i);
    });

    test('so a v4 extrinsic paying its fee in an asset does not round-trip', () => {
        const hex = buildSignedV4(registry, { values: values(sampleAssetId(registry)), call: remarkCall(registry) });
        let roundTrips = false;
        try { roundTrips = registry.createType('Extrinsic', hex).toHex() === hex; } catch (_) { roundTrips = false; }
        assert.equal(roundTrips, false, 'stock library now handles the asset id: upstream fixed it');
    });

    test('with asset id None the two shapes coincide (why nothing broke before)', () => {
        const hex = buildSignedV4(registry, { values: values(null), call: remarkCall(registry) });
        assert.equal(registry.createType('Extrinsic', hex).toHex(), hex);
    });

    test('re-encodes a v5 General extrinsic wrongly, so its hash is wrong', () => {
        const hex = buildGeneralV5(registry, { values: values(null), call: remarkCall(registry) });
        const ex = registry.createType('Extrinsic', hex);
        assert.equal(ex.method.method, 'remark', 'the decode itself is right');
        assert.notEqual(ex.toHex(), hex, 'stock library now re-encodes General correctly: upstream fixed it');
        assert.notEqual(ex.hash.toHex(), blake2AsHex(hexToU8a(hex)));
    });
});

// lib/tx-extensions.js deliberately never reads a converted extension's
// `implicit` type (deriveExtensionOverrides, and the IMPLICIT table in
// tx-extensions.test.js names the implicit types instead), because 17.0.2's
// v15 -> v16 converter writes `implict:` (metadata/v15/toV16.js), so every
// extension of a v14/v15 runtime (mainnet 373) gets implicit = type 0. If
// either test below fails, upstream fixed the typo: re-check that comment in
// lib/tx-extensions.js and the IMPLICIT workaround in tx-extensions.test.js.
describe('stock @polkadot/types: the `implict` typo in the v15 -> v16 metadata converter', () => {
    const unwrapOpaque = (hex) => {
        const u8a = hexToU8a(hex);
        if (u8a[0] !== 1) return hex;
        const [offset, length] = compactFromU8a(u8a.subarray(1));
        return u8aToHex(u8a.subarray(1 + offset, 1 + offset + length.toNumber()));
    };

    test('the converter source still has the misspelt key (ESM and CJS builds)', () => {
        const files = [
            fileURLToPath(import.meta.resolve('@polkadot/types/metadata/v15/toV16')),
            createRequire(import.meta.url).resolve('@polkadot/types/metadata/v15/toV16')
        ];
        assert.notEqual(files[0], files[1], 'expected separate ESM and CJS files');
        for (const file of files) {
            assert.match(readFileSync(file, 'utf8'), /implict:\s*additionalSigned/, `the \`implict\` typo is gone from ${file}: upstream fixed it`);
        }
    });

    for (const v of ['v14', 'v15']) {
        test(`${v} metadata converted to v16: every implicit is type 0, not the runtime's additionalSigned`, async () => {
            const hex = unwrapOpaque((await import(`@polkadot/types-support/metadata/${v}/substrate-hex`)).default);
            const original = new Metadata(new TypeRegistry(), hex).asV15.extrinsic.signedExtensions;
            const real = original.map(e => e.additionalSigned.toNumber());
            assert.ok(real.some(t => t !== 0), 'fixture sanity: some extension has a non-zero additionalSigned type');
            const converted = registryFromMetadata(hex).metadata.extrinsic.transactionExtensions;
            assert.equal(converted.length, original.length);
            const implicit = [...converted].map(e => e.implicit.toNumber());
            assert.ok(implicit.every(t => t === 0),
                `converted implicit types are ${JSON.stringify(implicit)}, expected all 0 while the typo exists: upstream fixed it`);
            assert.notDeepEqual(implicit, real);
        });
    }
});
