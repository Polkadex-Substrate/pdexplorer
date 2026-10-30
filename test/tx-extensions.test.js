// Extrinsic v4 + v5 decoding and v4 signing, with transaction extension types
// taken from metadata (lib/tx-extensions.js). See docs/archive/392-readiness.md.
//
// Two layers:
//   1. Always runs: Substrate's own runtime metadata as shipped inside
//      @polkadot/types-support (metadata v16, extrinsic versions 4 and 5,
//      SkipCheckIfFeeless<ChargeAssetTxPayment> with a NativeOrWithId asset
//      id, CheckMetadataHash, WeightReclaim). It is the same extension family
//      Polkadex 392 runs, so it exercises the same code paths.
//   2. Runs only when the Polkadex fixtures exist (test/fixtures/metadata-373.json,
//      the pre-392 mainnet runtime, kept for HISTORY: old blocks are still
//      decoded with it; metadata-392.json, the current runtime; both written by
//      scripts/fetch-metadata.mjs). Absent fixtures SKIP with a loud message;
//      they never pass silently.
//
// Every expected byte string is built from the METADATA by
// test/helpers/extrinsic-builders.js, not by the library under test.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { TypeRegistry, GenericExtrinsic } from '@polkadot/types';
import { Keyring } from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { compactFromU8a, u8aConcat, u8aToHex, hexToU8a } from '@polkadot/util';
import substrateMetadata from '@polkadot/types-support/metadata/static-substrate';
import {
    installMetadataExtensions, isMetadataExtensionsInstalled, deriveExtensionOverrides,
    installPolkadotFixes, installGeneralExtrinsicEncodingFix
} from '../lib/tx-extensions.js';
import {
    registryFromMetadata, loadFixture, buildSignedV4, buildGeneralV5, explicitBytes,
    remarkCall, sampleAssetId, FIXTURE_DIR
} from './helpers/extrinsic-builders.js';

installPolkadotFixes({ TypeRegistry, GenericExtrinsic });

const IMMORTAL = new Uint8Array([0x00]);

function explicitValues(registry, { assetId = null, nonce = 5, tip = 1000 } = {}) {
    return {
        CheckMortality: IMMORTAL,
        CheckEra: IMMORTAL,
        CheckNonce: nonce,
        ChargeAssetTxPayment: { tip, assetId },
        ChargeTransactionPayment: tip,
        CheckMetadataHash: { mode: 'Disabled' }
    };
}

// The shared assertions, run against any registry.
function assertV4RoundTrip(registry, assetId) {
    const call = remarkCall(registry);
    const hex = buildSignedV4(registry, { values: explicitValues(registry, { assetId }), call });
    const ex = registry.createType('Extrinsic', hex);
    assert.equal(ex.version & 0x3f, 4);
    assert.equal(ex.isSigned, true);
    assert.equal(`${ex.method.section}.${ex.method.method}`, 'system.remark');
    assert.equal(ex.method.args[0].toHex(), '0x1234');
    assert.equal(ex.nonce.toNumber(), 5);
    assert.equal(ex.tip.toString(), '1000');
    if (assetId === null) assert.equal(ex.assetId.isNone, true);
    else assert.deepEqual(ex.assetId.unwrap().toJSON(), registry.createType(registry.createLookupType(
        [...registry.metadata.extrinsic.transactionExtensions].find(e => e.identifier.toString() === 'ChargeAssetTxPayment').type
    ), { tip: 0, assetId }).assetId.unwrap().toJSON());
    assert.equal(ex.toHex(), hex, 'v4 re-encode is not byte-identical to the metadata-built bytes');
    assert.equal(ex.hash.toHex(), blake2AsHex(hexToU8a(hex)), 'v4 hash is not blake2 of the on-chain bytes');
}

function assertGeneralRoundTrip(registry, assetId) {
    const call = remarkCall(registry);
    const hex = buildGeneralV5(registry, { values: explicitValues(registry, { assetId }), call });
    const ex = registry.createType('Extrinsic', hex);
    assert.equal(ex.version & 0x3f, 5);
    assert.equal(typeof ex.isGeneral === 'function' ? ex.isGeneral() : ex.isGeneral, true);
    assert.equal(ex.isSigned, false);
    assert.equal(`${ex.method.section}.${ex.method.method}`, 'system.remark');
    assert.equal(ex.nonce.toNumber(), 5);
    assert.equal(ex.tip.toString(), '1000');
    assert.equal(ex.toHex(), hex, 'v5 General re-encode is not byte-identical to the metadata-built bytes');
    assert.equal(ex.hash.toHex(), blake2AsHex(hexToU8a(hex)), 'v5 General hash is not blake2 of the on-chain bytes');
    assert.equal(ex.encodedLength, hexToU8a(hex).length);
}

async function assertSigningMatchesMetadata(registry, { genesisHash, specVersion, transactionVersion, ss58 = 42 }) {
    await cryptoWaitReady();
    const pair = new Keyring({ type: 'sr25519', ss58Format: ss58 }).addFromUri('//Alice');
    const call = remarkCall(registry);
    const method = registry.createType('Call', call);
    const payload = registry.createType('SignerPayload', {
        address: pair.address,
        blockHash: genesisHash,
        blockNumber: 0,
        era: registry.createType('ExtrinsicEra', IMMORTAL),
        genesisHash,
        method,
        nonce: 5,
        runtimeVersion: { specVersion, transactionVersion },
        signedExtensions: registry.signedExtensions,
        tip: 1000,
        version: 4
    });
    const json = payload.toPayload();
    assert.equal(Number(json.mode || 0), 0, 'CheckMetadataHash mode must stay Disabled (0)');

    // The signing payload: call ++ explicit (from metadata) ++ implicit. The
    // implicit types come from the frame_system / metadata-hash definitions by
    // name, not from metadata: @polkadot/types 17.0.2 drops `implicit` when it
    // converts v14/v15 metadata (a typo, see lib/tx-extensions.js).
    const IMPLICIT = {
        CheckSpecVersion: ['u32', specVersion], CheckTxVersion: ['u32', transactionVersion],
        CheckGenesis: ['H256', genesisHash], CheckMortality: ['H256', genesisHash], CheckEra: ['H256', genesisHash],
        CheckMetadataHash: ['Option<[u8;32]>', null]
    };
    const EMPTY_IMPLICIT = ['CheckNonZeroSender', 'CheckNonce', 'CheckWeight', 'ChargeAssetTxPayment',
        'ChargeTransactionPayment', 'WeightReclaim', 'AuthorizeCall'];
    const implicitParts = [];
    for (const e of registry.metadata.extrinsic.transactionExtensions) {
        const name = e.identifier.toString();
        if (IMPLICIT[name]) implicitParts.push(registry.createType(IMPLICIT[name][0], IMPLICIT[name][1]).toU8a());
        else assert.ok(EMPTY_IMPLICIT.includes(name), `no known implicit part for extension ${name}; extend the table`);
    }
    const expected = u8aConcat(call, explicitBytes(registry, explicitValues(registry)), ...implicitParts);
    const raw = payload.toRaw();
    assert.equal(raw.data, u8aToHex(expected), 'signing payload differs from the metadata-described payload');

    const signature = pair.sign(hexToU8a(raw.data), { withType: true });
    const ex = registry.createType('Extrinsic', { method }, { version: 4 });
    ex.addSignature(pair.address, signature, json);
    const fromMetadata = buildSignedV4(registry, { values: explicitValues(registry), call, signer: pair.publicKey, signature });
    assert.equal(ex.toHex(), fromMetadata, 'signed v4 extrinsic differs from the metadata-described bytes');
    assert.ok(signatureVerify(hexToU8a(raw.data), signature.slice(1), pair.address).isValid);
    const back = registry.createType('Extrinsic', ex.toHex());
    assert.equal(back.signer.toString(), registry.createType('Address', pair.publicKey).toString());
}

describe('lib/tx-extensions: hook installation', () => {
    test('installs once on the shared TypeRegistry and is idempotent', () => {
        assert.equal(isMetadataExtensionsInstalled(TypeRegistry), true);
        assert.equal(installMetadataExtensions(TypeRegistry), false, 'second install must be a no-op');
    });

    test('rejects something that is not a TypeRegistry class', () => {
        assert.throws(() => installMetadataExtensions({}), /not a TypeRegistry/);
        assert.throws(() => installGeneralExtrinsicEncodingFix({}), /not a GenericExtrinsic/);
    });

    test('the General encoding fix is idempotent too', () => {
        assert.equal(installGeneralExtrinsicEncodingFix(GenericExtrinsic), false);
    });

    test('a registry with no metadata yet is left alone (no throw, no overrides)', () => {
        const r = new TypeRegistry();
        assert.deepEqual(deriveExtensionOverrides(r).overrides, {});
        r.setSignedExtensions(['CheckNonce'], undefined, true);
        assert.deepEqual(r.signedExtensions, ['CheckNonce']);
    });
});

describe('Substrate metadata (v16, extrinsic v4 + v5, NativeOrWithId asset id)', () => {
    let registry;
    before(() => { registry = registryFromMetadata(substrateMetadata); });

    test('the fixture really has the shape this suite claims', () => {
        assert.deepEqual([...registry.metadata.extrinsic.versions].map(Number), [4, 5]);
        const ids = registry.signedExtensions;
        for (const id of ['ChargeAssetTxPayment', 'CheckMetadataHash', 'WeightReclaim']) assert.ok(ids.includes(id), id);
        assert.ok(!ids.includes('SkipCheckIfFeeless'), 'SkipCheckIfFeeless is invisible: it forwards the wrapped identifier');
    });

    test('ChargeAssetTxPayment fields come from metadata, not Option<MultiLocation>', () => {
        const { overrides, assetConversionType } = deriveExtensionOverrides(registry);
        assert.deepEqual(Object.keys(overrides), ['ChargeAssetTxPayment']);
        assert.deepEqual(Object.keys(overrides.ChargeAssetTxPayment.extrinsic), ['tip', 'assetId']);
        assert.equal(overrides.ChargeAssetTxPayment.extrinsic.assetId, assetConversionType);
        assert.match(registry.getSignedExtensionTypes().assetId, /^Lookup\d+$/);
        assert.match(registry.createType('TAssetConversion').toRawType(), /NativeOrWithId|Native/i);
        assert.doesNotMatch(registry.createType('TAssetConversion').toRawType(), /MultiLocation|Junctions/);
    });

    test('signed v4, asset id None: decodes and re-encodes byte-identical', () => assertV4RoundTrip(registry, null));
    test('signed v4, asset id Some(WithId): decodes and re-encodes byte-identical', () => assertV4RoundTrip(registry, sampleAssetId(registry)));
    test('general v5, asset id None: decodes and re-encodes byte-identical', () => assertGeneralRoundTrip(registry, null));
    test('general v5, asset id Some(WithId): decodes and re-encodes byte-identical', () => assertGeneralRoundTrip(registry, sampleAssetId(registry)));

    test('v4 signing: payload and signed bytes match the metadata, mode Disabled, signature verifies', async () => {
        await assertSigningMatchesMetadata(registry, {
            genesisHash: '0x' + '11'.repeat(32), specVersion: 268, transactionVersion: 2
        });
    });

    test('a registry built later for another runtime re-derives its own types (historic api.at)', () => {
        const second = registryFromMetadata(substrateMetadata);
        assert.notEqual(second, registry);
        assert.match(second.getSignedExtensionTypes().assetId, /^Lookup\d+$/);
        assertV4RoundTrip(second, sampleAssetId(second));
    });
});

// v14 and v15 metadata go through @polkadot/types' v16 conversion, which is the
// path mainnet 373 takes. Substrate's v14/v15 snapshots carry ChargeAssetTxPayment
// with an Option<u32> asset id: again not the library's Option<MultiLocation>.
function unwrapOpaque(hex) {
    // metadata_at_version returns Option<OpaqueMetadata>: 0x01 ++ compact(len) ++ bytes
    const u8a = hexToU8a(hex);
    if (u8a[0] !== 1) return hex;
    const [offset, length] = compactFromU8a(u8a.subarray(1));
    return u8aToHex(u8a.subarray(1 + offset, 1 + offset + length.toNumber()));
}

for (const v of ['v14', 'v15']) {
    describe(`Substrate metadata ${v} (converted to v16 by the library, like spec 373)`, () => {
        let registry;
        before(async () => {
            const hex = (await import(`@polkadot/types-support/metadata/${v}/substrate-hex`)).default;
            registry = registryFromMetadata(unwrapOpaque(hex));
        });

        test('ChargeAssetTxPayment is still taken from metadata despite the conversion', () => {
            const { overrides } = deriveExtensionOverrides(registry);
            assert.ok(overrides.ChargeAssetTxPayment, 'override missing on converted metadata');
            assert.doesNotMatch(registry.createType('TAssetConversion').toRawType(), /MultiLocation|Junctions|parents/i);
        });
        test('signed v4 with asset id None and Some round-trips', () => {
            assertV4RoundTrip(registry, null);
            assertV4RoundTrip(registry, sampleAssetId(registry));
        });
        test('v4 signing matches the runtime definition, mode Disabled', async () => {
            await assertSigningMatchesMetadata(registry, { genesisHash: '0x' + '22'.repeat(32), specVersion: 1, transactionVersion: 1 });
        });
    });
}

// ---- Polkadex fixtures: present on the CEO's Mac after scripts/fetch-metadata.mjs ----

const FIXTURES = [
    { file: 'metadata-373.json', label: 'historical spec 373', expectV5: false },
    { file: 'metadata-392.json', label: 'current runtime, spec 392 or later', expectV5: true }
];

for (const { file, label, expectV5 } of FIXTURES) {
    const fx = loadFixture(file);
    const skip = fx ? false
        : `FIXTURE MISSING: ${FIXTURE_DIR}/${file} not found. Run "node scripts/fetch-metadata.mjs" on a machine that can reach the RPC. These Polkadex checks are NOT verified until it exists.`;
    if (skip) {
        // A counted SKIP (shows in "# skipped"), plus a loud line on stderr.
        console.warn('\n*** ' + skip + ' ***\n');
        test(`Polkadex ${label} (${file})`, (t) => t.skip(skip));
        continue;
    }

    describe(`Polkadex ${label} (${file})`, () => {
        const sources = [];
        if (fx) {
            sources.push({ tag: 'state_getMetadata', hex: fx.metadata });
            for (const [v, hex] of Object.entries(fx.metadataAtVersion || {})) if (hex) sources.push({ tag: `metadata_at_version(${v})`, hex });
        }
        if (expectV5) {
            // Without the v16 source no Polkadex metadata lists v5, and the
            // General round trip below would never run for this runtime.
            test('the fixture carries metadata v16 (the only version that can list extrinsic v5)', () => {
                assert.ok(fx.metadataAtVersion && fx.metadataAtVersion['16'],
                    `metadataVersions ${JSON.stringify(fx.metadataVersions)}; re-run scripts/fetch-metadata.mjs and check its "metadata v16" line`);
            });
        }
        for (const src of sources) {
            describe(src.tag, () => {
                let registry;
                before(() => {
                    registry = registryFromMetadata(src.hex);
                    registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
                });

                test(`runtime is spec ${fx.specVersion} and lists the expected extensions`, () => {
                    const ids = registry.signedExtensions;
                    for (const id of ['CheckNonZeroSender', 'CheckSpecVersion', 'CheckTxVersion', 'CheckGenesis',
                        'CheckNonce', 'CheckWeight', 'CheckMetadataHash']) assert.ok(ids.includes(id), `${id} missing: ${ids}`);
                    // frame_system::CheckEra is an alias of CheckMortality; the
                    // metadata carries the IDENTIFIER, which is "CheckMortality".
                    assert.ok(ids.includes('CheckMortality') || ids.includes('CheckEra'), `no era extension: ${ids}`);
                    assert.ok(ids.includes('ChargeAssetTxPayment') || ids.includes('ChargeTransactionPayment'), ids.join(','));
                    if (fx.specVersion >= 392) assert.ok(ids.includes('WeightReclaim'), 'spec 392 adds WeightReclaim');
                });

                test('no extension is unknown to the library or the metadata hook', () => {
                    const known = Object.keys(registry.getSignedExtensionTypes()).length + Object.keys(registry.getSignedExtensionExtra()).length;
                    assert.ok(known > 0);
                    const { overrides } = deriveExtensionOverrides(registry);
                    if (registry.signedExtensions.includes('ChargeAssetTxPayment')) {
                        assert.ok(overrides.ChargeAssetTxPayment, 'ChargeAssetTxPayment not taken from metadata');
                    }
                });

                test('signed v4, asset id None', () => assertV4RoundTrip(registry, null));
                test('signed v4, asset id Some', (t) => {
                    const a = sampleAssetId(registry);
                    if (a === null) return t.skip('this runtime has no asset-paid fees');
                    assertV4RoundTrip(registry, a);
                });
                test('general v5 (only where the runtime declares extrinsic v5)', (t) => {
                    const versions = [...registry.metadata.extrinsic.versions].map(Number);
                    // Metadata v14 and v15 have room for ONE extrinsic version and
                    // report 4 even on a runtime that accepts v5 (checked against
                    // the substrate v15 and v16 metadata in @polkadot/types-support:
                    // same runtime, [4] and [4, 5]). Only v16 can list 5. So the
                    // v5 expectation applies to the v16 source alone, and a source
                    // that lists [4] is the expected shape, asserted and PASSED,
                    // not skipped: the gate is "# skipped 0".
                    const m = /^metadata_at_version\((\d+)\)$/.exec(src.tag);
                    const sourceVersion = m ? Number(m[1]) : 14;
                    const runtimeHasV5 = expectV5 || fx.specVersion >= 392;
                    if (runtimeHasV5 && sourceVersion >= 16) assert.ok(versions.includes(5), `spec ${fx.specVersion} v${sourceVersion} metadata lists versions ${versions}`);
                    if (!versions.includes(5)) {
                        assert.deepEqual(versions, [4], `metadata v${sourceVersion} lists extrinsic versions ${versions}`);
                        t.diagnostic(`metadata v${sourceVersion} lists extrinsic versions [4]; v5 round trip runs on the v16 source`);
                        return;
                    }
                    assertGeneralRoundTrip(registry, null);
                    const a = sampleAssetId(registry);
                    if (a !== null) assertGeneralRoundTrip(registry, a);
                });
                test('v4 signing matches the metadata, mode Disabled', async () => {
                    await assertSigningMatchesMetadata(registry, {
                        genesisHash: fx.genesisHash, specVersion: fx.specVersion, transactionVersion: fx.transactionVersion, ss58: 88
                    });
                });
                test('real extrinsics from the chain decode and re-encode byte-identical', (t) => {
                    const samples = (fx.extrinsics || []).filter(s => s.specVersion === undefined || s.specVersion === fx.specVersion);
                    if (!samples.length) return t.skip('fixture has no extrinsic samples');
                    for (const s of samples) {
                        const ex = registry.createType('Extrinsic', s.hex);
                        assert.equal(ex.toHex(), s.hex, `block ${s.block} #${s.index} did not round-trip`);
                        assert.equal(ex.hash.toHex(), blake2AsHex(hexToU8a(s.hex)), `block ${s.block} #${s.index} hash`);
                        assert.ok(ex.method.section, `block ${s.block} #${s.index} has no section`);
                    }
                });
            });
        }
    });
}
