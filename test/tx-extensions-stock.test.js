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
