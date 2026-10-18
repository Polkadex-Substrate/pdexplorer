// Builds extrinsic bytes straight from a registry's METADATA, independently of
// @polkadot/types' extension table, so a decode test compares the library
// against the runtime's own description of the format rather than against
// itself.
//
//   v4 signed : compact(len) 0x84 address signature explicit(all ext) call
//   v5 general: compact(len) 0x45 extVersion explicit(ext of that version) call
//
// Explicit values per extension identifier; anything not listed must be
// zero-sized (Null / ()) in the metadata or the builder throws.

import { Metadata, TypeRegistry } from '@polkadot/types';
import { compactAddLength, hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function registryFromMetadata(metadataHex) {
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, metadataHex);
    registry.setMetadata(metadata);
    return registry;
}

// Polkadex fixtures written by scripts/fetch-metadata.mjs. null when absent.
export function loadFixture(name) {
    const file = join(FIXTURE_DIR, name);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}

function extensionsFor(registry, version) {
    const ext = registry.metadata.extrinsic;
    const all = [...ext.transactionExtensions];
    if (version === undefined) return all;
    const entry = [...ext.transactionExtensionsByVersion].find(([v]) => v.toNumber() === version);
    if (!entry) throw new Error(`metadata has no transaction extension version ${version}`);
    return entry[1].map(i => all[i.toNumber()]);
}

function siIsZeroSized(registry, id) {
    const { def } = registry.lookup.getSiType(id);
    if (def.isTuple) return def.asTuple.every(t => siIsZeroSized(registry, t));
    if (def.isComposite) return def.asComposite.fields.every(f => siIsZeroSized(registry, f.type));
    return false;
}

// Encodes the explicit bytes of every extension in order, from metadata types.
export function explicitBytes(registry, values, version) {
    const parts = [];
    for (const e of extensionsFor(registry, version)) {
        const name = e.identifier.toString();
        if (name in values) {
            const v = values[name];
            parts.push(v instanceof Uint8Array ? v : registry.createType(registry.createLookupType(e.type), v).toU8a());
        } else if (!siIsZeroSized(registry, e.type)) {
            throw new Error(`builder has no explicit value for non-empty extension ${name}`);
        }
    }
    return u8aConcat(...parts);
}

// system.remark(data) as call bytes, located through the metadata.
export function remarkCall(registry, dataHex = '0x1234') {
    for (const p of registry.metadata.pallets) {
        if (p.name.toString() !== 'System' || p.calls.isNone) continue;
        const variants = registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants;
        const remark = variants.find(v => v.name.toString() === 'remark');
        if (!remark) break;
        return registry.createType('Call', {
            callIndex: [p.index.toNumber(), remark.index.toNumber()],
            args: { remark: dataHex }
        }).toU8a();
    }
    throw new Error('no System.remark in metadata');
}

export const ALICE_PUBLIC = hexToU8a('0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d');

export function buildSignedV4(registry, { values, call, signer = ALICE_PUBLIC, signature }) {
    const sig = signature || u8aConcat(new Uint8Array([0x01]), new Uint8Array(64).fill(7)); // MultiSignature::Sr25519
    const body = u8aConcat(
        new Uint8Array([0x84]),
        new Uint8Array([0x00]), signer,              // MultiAddress::Id
        sig,
        explicitBytes(registry, values),
        call
    );
    return u8aToHex(compactAddLength(body));
}

export function buildGeneralV5(registry, { values, call, extVersion = 0 }) {
    const body = u8aConcat(
        new Uint8Array([0x45, extVersion]),
        explicitBytes(registry, values, extVersion),
        call
    );
    return u8aToHex(compactAddLength(body));
}

// Picks a Some(asset) value that fits the runtime's asset id type, or null if
// the shape is not one we know how to fill (the test then skips that case).
export function sampleAssetId(registry) {
    const ext = [...registry.metadata.extrinsic.transactionExtensions]
        .find(e => e.identifier.toString() === 'ChargeAssetTxPayment');
    if (!ext) return null;
    const { def } = registry.lookup.getSiType(ext.type);
    if (!def.isComposite) return null;
    const field = def.asComposite.fields.find(f => f.name.isSome && f.name.unwrap().toString() === 'asset_id');
    if (!field) return null;
    const opt = registry.lookup.getSiType(field.type);
    const inner = opt.params[0] && opt.params[0].type.isSome ? opt.params[0].type.unwrap() : null;
    if (inner === null) return null;
    const innerDef = registry.lookup.getSiType(inner).def;
    if (innerDef.isPrimitive) return 7;
    if (innerDef.isVariant) {
        const names = innerDef.asVariant.variants.map(v => v.name.toString());
        if (names.includes('WithId')) return { WithId: 7 };
    }
    return null;
}
