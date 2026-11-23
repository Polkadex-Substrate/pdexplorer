// Session keys: the layout, the parser and the owner check. Pure and
// import-free, so the browser and the server run the same rules.
// Tested in test/session-keys.test.js.
//
// The layout (polkadex-node mainnet runtimes/mainnet/src/lib.rs, spec 393,
// impl_opaque_keys!): grandpa, babe, im_online, authority_discovery, mixnet
// (32 bytes each) and beefy (33 bytes, ecdsa): 193 bytes. The orderbook key is
// commented out with its pallet. The live runtime's layout is read from the
// metadata (layoutFromRegistry) and used in the runtime's own order when each
// key in it is one this table knows (checkLayout); a key it does not know, or a
// layout that cannot be read, switches the checker off rather than let it
// validate against a guess.
//
// The explorer only ever receives public keys. It never calls the node's
// author_* methods: the operator runs author_rotateKeys on their own server.

export const EXPECTED_LAYOUT = Object.freeze([
    { name: 'grandpa', typeId: 'gran', bytes: 32 },
    { name: 'babe', typeId: 'babe', bytes: 32 },
    { name: 'im_online', typeId: 'imon', bytes: 32 },
    { name: 'authority_discovery', typeId: 'audi', bytes: 32 },
    { name: 'mixnet', typeId: 'mixn', bytes: 32 },
    { name: 'beefy', typeId: 'beef', bytes: 33 }
].map(Object.freeze));

// Longest input looked at, in characters. Anything longer is a length failure.
export const MAX_INPUT_CHARS = 1000;

export const layoutTotalBytes = (layout) => (layout || []).reduce((n, k) => n + Number(k.bytes || 0), 0);

const str = (x) => (x == null ? '' : String(x));
function fieldName(f) {
    const n = f && f.name;
    if (n && typeof n.isSome === 'boolean') return n.isSome ? str(n.unwrap()) : '';
    return str(n);
}
// Byte length of a type that is a fixed array of u8, possibly wrapped in
// single-field composites (sp_core's Public types): [u8; N] -> N.
function fixedBytes(lookup, id, depth = 0) {
    if (depth > 6) return null;
    const t = lookup.getSiType(id);
    const def = t && t.def;
    if (!def) return null;
    if (def.isArray) return Number(def.asArray.len.toNumber ? def.asArray.len.toNumber() : def.asArray.len);
    if (def.isComposite && def.asComposite.fields.length === 1) return fixedBytes(lookup, def.asComposite.fields[0].type, depth + 1);
    return null;
}

// The keys argument of session.set_keys as the metadata describes it:
// [{ name, bytes }] in order, or null when it cannot be read.
export function layoutFromRegistry(registry) {
    try {
        if (!registry || !registry.metadata || !registry.lookup) return null;
        const pallet = Array.from(registry.metadata.pallets || []).find(p => str(p.name) === 'Session');
        if (!pallet || !pallet.calls || !pallet.calls.isSome) return null;
        const calls = registry.lookup.getSiType(pallet.calls.unwrap().type);
        if (!calls || !calls.def || !calls.def.isVariant) return null;
        const setKeys = Array.from(calls.def.asVariant.variants).find(v => str(v.name) === 'set_keys');
        if (!setKeys || !setKeys.fields || !setKeys.fields.length) return null;
        const keys = registry.lookup.getSiType(setKeys.fields[0].type);
        if (!keys || !keys.def || !keys.def.isComposite) return null;
        const out = [];
        for (const f of keys.def.asComposite.fields) {
            const bytes = fixedBytes(registry.lookup, f.type);
            if (!(bytes > 0)) return null;
            out.push({ name: fieldName(f), bytes });
        }
        return out.length ? out : null;
    } catch (e) {
        return null;
    }
}

// { ok, layout, bytes, hexLength, reason }. The live layout (read from the
// metadata, in the runtime's own order) is used whenever every key in it is one
// the explorer knows by name AND at the size it knows: the KeyTypeId needed for
// Session.KeyOwner comes from that table, and nothing else is guessed. A key
// with an unknown name or a different size, or a layout that could not be read,
// switches the checker off (ok false, layout null) rather than validate against
// a guess. So a future runtime that reorders, drops or re-adds known keys works
// without a release; one with a key the explorer has never seen does not.
export function checkLayout(live, expected = EXPECTED_LAYOUT) {
    if (!Array.isArray(live) || !live.length) return { ok: false, layout: null, bytes: null, hexLength: null, reason: 'The session key layout could not be read from the runtime metadata.' };
    const bytes = layoutTotalBytes(live);
    const known = new Map(expected.map(k => [k.name, k]));
    const unusable = live.filter(k => !known.has(k.name) || Number(k.bytes) !== known.get(k.name).bytes);
    const dupes = new Set(live.map(k => k.name)).size !== live.length;
    if (unusable.length || dupes) {
        const why = unusable.length
            ? `the explorer does not know ${unusable.map(k => (known.has(k.name) ? `${k.name} at ${k.bytes} bytes` : k.name)).join(', ')}.`
            : 'a key name is repeated.';
        return { ok: false, layout: null, bytes, hexLength: 2 + bytes * 2,
            reason: `The runtime describes ${live.length} keys of ${bytes} bytes (${live.map(k => `${k.name} ${k.bytes}`).join(', ')}); ${why}` };
    }
    return { ok: true, layout: live.map(k => ({ ...known.get(k.name) })), bytes, hexLength: 2 + bytes * 2, reason: '' };
}

// Shown in place of the checker. Said plainly: the format here is not one this
// checker knows (which is not the same as "it changed"). specVersion is kept in
// the signature for callers and is deliberately not in the text.
export function layoutMismatchText(specVersion) {
    return "This network's session key format is different from what this checker knows. Use your node's author_rotateKeys output and the chain's own validation.";
}

export const SECRET_TEXT = 'That looks like a secret phrase. Do not paste it anywhere. Session keys are a single 0x line from your node.';

// Words separated by spaces, at least three of them letters only and one with
// a letter outside a to f: a mnemonic, not a hex line broken in two.
export function looksLikeSecret(input) {
    const t = str(input).trim();
    if (!/\s/.test(t)) return false;
    const words = t.split(/\s+/).map(w => w.replace(/\/\/.*$/, ''));
    const alpha = words.filter(w => /^[a-z]+$/i.test(w));
    return alpha.length >= 3 && alpha.some(w => /[g-z]/i.test(w));
}

const fail = (code, message) => ({ ok: false, code, message });

// The first failure is shown (design section 4.2). On success: { ok, keys:
// [{ name, typeId, bytes, hex }], bytes, warnings }.
export function parseSessionKeys(input, { layout = EXPECTED_LAYOUT, specVersion = null } = {}) {
    const raw = str(input);
    const t = raw.trim();
    if (!t) return fail('empty', 'Paste the session keys line from your node.');
    if (looksLikeSecret(t)) return fail('secret', SECRET_TEXT);
    const total = layoutTotalBytes(layout);
    const spec = specVersion == null ? '' : ` (spec ${specVersion})`;
    const lengthFail = (bytes) => fail('length', `This is ${bytes} bytes. The live runtime${spec} expects ${total}. Run author_rotateKeys on a node that is fully synced.`);
    if (t.length > MAX_INPUT_CHARS) return lengthFail(Math.floor((t.length - 2) / 2));
    if (!t.startsWith('0x')) return fail('prefix', 'Session keys start with 0x.');
    const hex = t.slice(2);
    if (!/^[0-9a-fA-F]*$/.test(hex)) return fail('hex', 'This contains characters that are not hexadecimal.');
    const bytes = Math.floor(hex.length / 2);
    if (hex.length % 2 !== 0 || bytes !== total) {
        if (hex.length === 64) return fail('single', 'This looks like a single key or an account, not the full session keys line.');
        return lengthFail(bytes);
    }
    const lower = hex.toLowerCase();
    const keys = [];
    let at = 0;
    for (const k of layout) {
        const part = lower.slice(at, at + k.bytes * 2);
        at += k.bytes * 2;
        keys.push({ name: k.name, typeId: k.typeId, bytes: k.bytes, hex: '0x' + part });
    }
    const zero = keys.findIndex(k => /^0x0*$/.test(k.hex));
    if (zero >= 0) return fail('zero', `Key ${zero + 1} (${keys[zero].name}) is empty.`);
    const warnings = [];
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            if (keys[i].hex === keys[j].hex) warnings.push(`Keys ${i + 1} (${keys[i].name}) and ${j + 1} (${keys[j].name}) are identical.`);
        }
    }
    return { ok: true, keys, bytes: total, warnings };
}

export function keyPreview(hex) {
    const h = str(hex).replace(/^0x/i, '');
    return h.length <= 16 ? h : `${h.slice(0, 8)}...${h.slice(-8)}`;
}

// keys: parseSessionKeys(..).keys. owners[i]: Session.KeyOwner of keys[i]
// (address or null). queued: Session.QueuedKeys as [{ account, keys: { name:
// hex } }]. nextKeys: Session.NextKeys(stash) as { name: hex } or null.
// result per key: free, own (this stash), other (another account: blocking).
export function classifyKeyOwners(keys, { owners = [], queued = [], stash = '', nextKeys = null, isSame = (a, b) => a === b } = {}) {
    const mine = (a) => !!stash && !!a && isSame(a, stash);
    const rows = keys.map((k, i) => {
        const base = { name: k.name, typeId: k.typeId, preview: keyPreview(k.hex) };
        const owner = owners[i] || null;
        const q = (queued || []).find(e => e && e.keys && str(e.keys[k.name]).toLowerCase() === k.hex && !mine(e.account));
        const other = owner && !mine(owner) ? owner : (q ? str(q.account) : null);
        if (other) {
            return { ...base, result: 'other', owner: other,
                message: `Key ${i + 1} (${k.name}) is already registered to ${other}. The chain will reject these keys. If you copied a keystore from another node, stop: running two nodes with the same keys is slashed.` };
        }
        if (owner) return { ...base, result: 'own', owner, message: 'Registered to this stash.' };
        return { ...base, result: 'free', owner: null, message: 'Not registered to any account.' };
    });
    const sameAsNext = !!nextKeys && keys.every(k => str(nextKeys[k.name]).toLowerCase() === k.hex);
    return { rows, conflict: rows.some(r => r.result === 'other'), sameAsNext };
}

// The line under the table.
export function keyCheckSummary(result, keys) {
    const conflict = result.rows.find(r => r.result === 'other');
    if (conflict) return conflict.message;
    if (result.sameAsNext || (result.rows.length && result.rows.every(r => r.result === 'own'))) return 'These keys are already registered to this stash.';
    return `These ${keys.length} keys are free to register.`;
}
