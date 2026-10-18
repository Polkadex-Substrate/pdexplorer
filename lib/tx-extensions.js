// Transaction extension types taken from the chain's own metadata, per runtime.
//
// Why this exists. @polkadot/api decodes and encodes the explicit part of a
// signed extrinsic (the bytes each transaction extension adds) from a table of
// KNOWN extensions keyed by name, not from the metadata. For most extensions
// the table is right. For ChargeAssetTxPayment it is not right for Polkadex:
// the table says the asset id is `TAssetConversion`, which @polkadot/types
// defines as `Option<MultiLocation>` (the Asset Hub shape), while the Polkadex
// runtime uses pallet_asset_conversion_tx_payment with `NativeOrWithId<u128>`
// (and older runtimes used `NativeOrWithId<u32>`). With the asset id set to
// None both shapes encode as the single byte 0x00, which is why nothing broke
// so far; any extrinsic that pays its fee in an asset is misread by the stock
// library and every field after it lands at the wrong offset.
//
// SkipCheckIfFeeless never appears under its own name. The runtime forwards the
// wrapped extension's IDENTIFIER and TypeInfo, so the metadata lists it as
// "ChargeAssetTxPayment" with ChargeAssetTxPayment's type. It is still handled
// here in case a runtime ever publishes it under its own name.
//
// The fix: for every registry the api creates (the tip registry, and one per
// historical runtime when the explorer calls api.at(blockHash)), read the
// extension's type from THAT registry's metadata and register it as a user
// extension, so 373, 392 and any later runtime each use their own shape.
// polkadot-js exposes no per-registry hook, so installMetadataExtensions wraps
// TypeRegistry.prototype.setSignedExtensions, which setMetadata calls every
// time a registry gets metadata.
//
// No imports: the TypeRegistry class is passed in, so this module loads the
// same way in Node, in the Vite bundle and in the tests.

// Extensions whose explicit fields are taken from metadata instead of the
// library's built-in table.
export const METADATA_DRIVEN_EXTENSIONS = Object.freeze(['ChargeAssetTxPayment', 'SkipCheckIfFeeless']);

const MAX_UNWRAP_DEPTH = 4;

function camelCase(name) {
    return String(name).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// A type that encodes to zero bytes: the unit tuple, an empty composite, or a
// composite of zero-sized fields (PhantomData shows up as the unit tuple).
export function isZeroSized(registry, typeId, depth = 0) {
    if (depth > MAX_UNWRAP_DEPTH) return false;
    const { def } = registry.lookup.getSiType(typeId);
    if (def.isTuple) return def.asTuple.every(t => isZeroSized(registry, t, depth + 1));
    if (def.isComposite) return def.asComposite.fields.every(f => isZeroSized(registry, f.type, depth + 1));
    return false;
}

// The explicit fields of an extension, as { camelName: 'Lookup<id>' } resolved
// in THIS registry, or null when the shape is not a struct of named fields.
// Transparent single-field wrappers are unwrapped.
export function explicitFieldsFromMetadata(registry, typeId) {
    let id = typeId;
    for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth++) {
        const { def } = registry.lookup.getSiType(id);
        if (!def.isComposite) return null;
        const fields = def.asComposite.fields;
        if (fields.length && fields.every(f => f.name.isSome)) {
            const out = {};
            for (const f of fields) {
                if (isZeroSized(registry, f.type)) continue;
                out[camelCase(f.name.unwrap().toString())] = registry.createLookupType(f.type);
            }
            return Object.keys(out).length ? out : null;
        }
        const real = fields.filter(f => !isZeroSized(registry, f.type));
        if (real.length === 1 && real[0].name.isNone) { id = real[0].type; continue; }
        return null;
    }
    return null;
}

// Reads the registry's metadata and returns the user-extension overrides plus
// the type the TAssetConversion alias should point at (the asset id field, an
// Option<...>), or null when the runtime has no ChargeAssetTxPayment.
export function deriveExtensionOverrides(registry) {
    const overrides = {};
    let assetConversionType = null;
    let extrinsic;
    try { extrinsic = registry.metadata.extrinsic; } catch (_) { return { overrides, assetConversionType }; }
    const list = extrinsic && extrinsic.transactionExtensions;
    if (!list) return { overrides, assetConversionType };
    for (const ext of list) {
        const name = ext.identifier.toString();
        if (!METADATA_DRIVEN_EXTENSIONS.includes(name)) continue;
        // Only the explicit part is taken from metadata; the payload part stays
        // {} exactly as in the library's own table, because both extensions
        // have `Implicit = ()` by pallet definition. The metadata's `implicit`
        // field is deliberately NOT consulted: @polkadot/types 17.0.2 converts
        // v14/v15 metadata to v16 with a typo (`implict:`), so on those
        // runtimes (373 serves v14/v15) `implicit` is always type 0, which is
        // AccountId32 there, not the real implicit type.
        const fields = explicitFieldsFromMetadata(registry, ext.type);
        if (!fields) continue;
        overrides[name] = { extrinsic: fields, payload: {} };
        if (fields.assetId && !assetConversionType) assetConversionType = fields.assetId;
    }
    return { overrides, assetConversionType };
}

const INSTALLED = Symbol.for('pdex.metadataExtensions.installed');

// Wraps TypeRegistry.prototype.setSignedExtensions once. Every later call
// (including the one inside setMetadata) merges the metadata-derived overrides
// over whatever user extensions the caller passed. Metadata wins: it is the
// runtime's own statement of its encoding. Idempotent.
export function installMetadataExtensions(TypeRegistry) {
    const proto = TypeRegistry && TypeRegistry.prototype;
    if (!proto || typeof proto.setSignedExtensions !== 'function') {
        throw new Error('installMetadataExtensions: not a TypeRegistry class');
    }
    if (proto[INSTALLED]) return false;
    const original = proto.setSignedExtensions;
    proto.setSignedExtensions = function setSignedExtensionsFromMetadata(signedExtensions, userExtensions, noInitWarn) {
        let merged = userExtensions;
        try {
            const { overrides, assetConversionType } = deriveExtensionOverrides(this);
            if (assetConversionType) {
                // SignerPayload and the signer-side assetId round trip use the
                // TAssetConversion alias directly, so point it at the same type.
                this.register({ TAssetConversion: assetConversionType });
            }
            if (Object.keys(overrides).length) merged = Object.assign({}, userExtensions || {}, overrides);
        } catch (err) {
            // Never let this hook break api start-up; fall back to the library
            // table and say so once per registry.
            if (typeof console !== 'undefined') console.warn('[tx-extensions] metadata-driven extensions not applied:', err && err.message ? err.message : err);
        }
        return original.call(this, signedExtensions, merged, noInitWarn);
    };
    Object.defineProperty(proto, INSTALLED, { value: true });
    return true;
}

const GENERAL_FIX = Symbol.for('pdex.generalExtrinsicEncoding.installed');

// @polkadot/types 17.0.2 re-encodes a v5 General extrinsic wrongly: the outer
// Extrinsic writes its version byte and then the inner GeneralExtrinsic's
// toU8a(), which already carries its own length prefix and version byte. The
// decoded fields are right, but toU8a()/toHex() and therefore `hash` (blake2
// of toU8a) are wrong, so the explorer would store the wrong tx hash for every
// General extrinsic. Signed and bare v4 are unaffected. The fix emits the
// inner encode() (version byte + body) once; if a later library version fixes
// this upstream the output is the same, so the wrapper stays harmless.
export function installGeneralExtrinsicEncodingFix(GenericExtrinsic) {
    const proto = GenericExtrinsic && GenericExtrinsic.prototype;
    if (!proto || typeof proto.toU8aInner !== 'function') {
        throw new Error('installGeneralExtrinsicEncodingFix: not a GenericExtrinsic class');
    }
    if (proto[GENERAL_FIX]) return false;
    const original = proto.toU8aInner;
    proto.toU8aInner = function toU8aInnerGeneralAware() {
        if (typeof this.isGeneral === 'function' && this.isGeneral()
            && this.inner && typeof this.inner.encode === 'function') {
            return [this.inner.encode()];
        }
        return original.call(this);
    };
    Object.defineProperty(proto, GENERAL_FIX, { value: true });
    return true;
}

// Both fixes, for server.js and script.js. Pass the classes from the single
// resolved @polkadot/types copy (package.json pins it).
export function installPolkadotFixes({ TypeRegistry, GenericExtrinsic }) {
    installMetadataExtensions(TypeRegistry);
    installGeneralExtrinsicEncodingFix(GenericExtrinsic);
}

export function isMetadataExtensionsInstalled(TypeRegistry) {
    return !!(TypeRegistry && TypeRegistry.prototype && TypeRegistry.prototype[INSTALLED]);
}
