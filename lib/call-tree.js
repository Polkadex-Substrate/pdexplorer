// A decoded call (or event) from @polkadot/types codecs into a plain, typed,
// JSON-safe tree. The pages format it (lib/call-args-format.js); this module
// only describes what is there and keeps what the formatter needs:
//
//   call   { section, method, args: [{ name, type, typeName, node }] }
//   node   { k, v, ...}   k is the kind:
//     num    v decimal string (never a float, never toJSON's hex), t raw type ("Compact<u128>", "Perbill")
//     acct   v SS58 string (the registry's prefix)
//     bool   v boolean         text  v string
//     hex    v hex string (cut at the text limit), b its full length in bytes
//     enum   e variant name, v inner node or null (a unit variant)
//     none   an Option that is None (a Some is just its inner node)
//     vec / tuple  v [node]    struct  v { field: node }
//     call   v call tree (a nested call, also the inline call inside a Bounded)
//     null   a unit, t 'Null' (the () type)   raw  v text (fallback)   trunc  cut by a limit
//
// typeName is the argument's declared name in the pallet metadata (BalanceOf,
// Balance, AccountIdLookupOf, BlockNumberFor...): the only reliable way to tell
// a balance from any other u128. A value inside a struct or an enum variant
// carries its field's declared name as tn, read from the runtime's type
// registry (VestingInfo.locked: "Balance").
//
// Bounded by depth, node count and text length: the tree is sent in API
// payloads and a hostile nesting or a wasm blob must not grow it.
// Imports nothing; every codec method is feature-detected.

export const TREE_LIMITS = Object.freeze({ depth: 8, nodes: 400, text: 256, items: 64 });

const isCall = (v) => !!v && typeof v === 'object' && typeof v.section === 'string' && typeof v.method === 'string' && !!v.meta && !!v.args;
const isOption = (v) => typeof v.isSome === 'boolean' && typeof v.isNone === 'boolean' && typeof v.unwrap === 'function';
const isEnum = (v) => typeof v.type === 'string' && typeof v.isBasic === 'boolean' && 'value' in v;
const rawType = (v) => { try { return String(v.toRawType()); } catch (_) { return ''; } };
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '...' : s);

function makeState(opts = {}) {
    return { nodes: 0, limits: { ...TREE_LIMITS, ...(opts.limits || {}) } };
}

// The runtime type of a value, from its lookup id, for the declared names of
// struct and variant fields. ty is { id } or { fields } (a variant's own named
// fields); every step is guarded, and no type just means no tn.
function siDef(v, ty) {
    try {
        if (!ty || ty.id === undefined || ty.id === null || !v || !v.registry || !v.registry.lookup) return null;
        return v.registry.lookup.getSiType(ty.id).def;
    } catch (_) { return null; }
}
const fieldName = (f) => { try { return f.typeName && f.typeName.isSome ? cut(String(f.typeName.unwrap()), 80) : null; } catch (_) { return null; } };
const fieldsOf = (v, ty) => {
    if (ty && Array.isArray(ty.fields)) return ty.fields;
    const d = siDef(v, ty);
    return d && d.isComposite ? Array.from(d.asComposite.fields) : null;
};
const withTn = (node, f) => { const tn = f ? fieldName(f) : null; if (tn && node && typeof node === 'object') node.tn = tn; return node; };

// The inner type of an Option, the element type of a Vec or array, the item
// types of a tuple.
function innerTy(v, ty, kind) {
    const d = siDef(v, ty);
    if (!d) return null;
    try {
        if (kind === 'option' && d.isVariant) {
            const some = Array.from(d.asVariant.variants).find(x => String(x.name) === 'Some');
            return some && some.fields.length === 1 ? { id: some.fields[0].type } : null;
        }
        if (kind === 'seq') {
            if (d.isSequence) return { id: d.asSequence.type };
            if (d.isArray) return { id: d.asArray.type };
            if (d.isTuple) return { tuple: Array.from(d.asTuple) };
        }
    } catch (_) { /* untyped */ }
    return null;
}

// The enum variant's fields: one unnamed field types the inner value; named
// fields type the struct the variant holds.
function variantTy(v, ty) {
    const d = siDef(v, ty);
    if (!d || !d.isVariant) return null;
    try {
        const vr = Array.from(d.asVariant.variants).find(x => String(x.name) === String(v.type));
        if (!vr || !vr.fields.length) return null;
        const fields = Array.from(vr.fields);
        if (fields.length === 1 && fields[0].name.isNone) return { id: fields[0].type, field: fields[0] };
        return fields.every(f => f.name.isSome) ? { fields } : null;
    } catch (_) { return null; }
}

export function codecToNode(v, st = makeState(), depth = 0, ty = null) {
    if (v === null || v === undefined) return { k: 'none' };
    if (++st.nodes > st.limits.nodes || depth > st.limits.depth) return { k: 'trunc' };
    try {
        if (isCall(v)) return { k: 'call', v: callToTree(v, st, depth + 1) };
        if (isOption(v)) return v.isNone ? { k: 'none' } : codecToNode(v.unwrap(), st, depth, innerTy(v, ty, 'option'));
        if (isEnum(v)) {
            if (v.type === 'Inline' && v.value && typeof v.value.toHex === 'function' && v.registry) {
                try {
                    const inner = v.registry.createType('Call', v.value.toHex());
                    return { k: 'enum', e: 'Inline', v: { k: 'call', v: callToTree(inner, st, depth + 1) } };
                } catch (_) { /* not a call: show the bytes */ }
            }
            if (v.isBasic || rawType(v.value) === 'Null') return { k: 'enum', e: String(v.type), v: null };
            const vt = variantTy(v, ty);
            return { k: 'enum', e: String(v.type), v: withTn(codecToNode(v.value, st, depth + 1, vt), vt && vt.field) };
        }
        if (v instanceof Map) {
            const fields = fieldsOf(v, ty);
            const typed = fields && fields.length === v.size && fields.every(f => f.name.isSome);
            const o = Object.create(null);
            let i = 0;
            for (const [key, val] of v.entries()) {
                const f = typed ? fields[i] : null;
                o[String(key).replace(/_$/, '')] = withTn(codecToNode(val, st, depth + 1, f ? { id: f.type } : null), f);
                i++;
            }
            return { k: 'struct', v: o };
        }
        if (Array.isArray(v)) {
            const it = innerTy(v, ty, 'seq');
            const items = Array.from(v).slice(0, st.limits.items).map((x, i) =>
                codecToNode(x, st, depth + 1, it && it.tuple ? (it.tuple[i] !== undefined ? { id: it.tuple[i] } : null) : it));
            const out = { k: rawType(v).startsWith('(') ? 'tuple' : 'vec', v: items };
            if (v.length > items.length) out.n = v.length;
            return out;
        }
        const t = rawType(v);
        if (t === 'Null') return { k: 'null', t: 'Null' };
        if (t === 'bool') return { k: 'bool', v: !!v.isTrue };
        if (t === 'AccountId' || t === 'AccountId32' || t === 'AccountId20') return { k: 'acct', v: String(v) };
        if (typeof v.toBigInt === 'function' || typeof v.toBn === 'function') return { k: 'num', t: cut(t, 40), v: String(v) };
        if (t === 'Text') return { k: 'text', v: cut(String(v), st.limits.text) };
        if (typeof v.toHex === 'function') {
            // The byte count comes from the whole value, before the text cut.
            const full = String(v.toHex());
            const out = { k: 'hex', v: cut(full, st.limits.text) };
            if (/^0x[0-9a-fA-F]*$/.test(full) && full.length % 2 === 0) out.b = (full.length - 2) / 2;
            return out;
        }
        return { k: 'raw', v: cut(String(v), st.limits.text) };
    } catch (_) {
        return { k: 'raw', v: '[unprintable]' };
    }
}

const nameOf = (m, i) => (m && m.name ? String(m.name) : `arg${i}`);
const typeNameOf = (m) => {
    try {
        const t = m && m.typeName;
        const s = t && typeof t.isSome === 'boolean' ? (t.isSome ? String(t.unwrap()) : '') : (t ? String(t) : '');
        return s || null;
    } catch (_) { return null; }
};

// [{ name, type, typeName, node }] for each argument of a call.
export function argEntries(call, st = makeState(), depth = 0) {
    const meta = (call.meta && call.meta.args) || [];
    const fields = (call.meta && call.meta.fields) || [];
    return Array.from(call.args || []).map((a, i) => {
        const typeName = typeNameOf(meta[i]);
        return { name: nameOf(meta[i], i), type: typeName, typeName, node: codecToNode(a, st, depth, fields[i] ? { id: fields[i].type } : null) };
    });
}

export function callToTree(call, stOrOpts, depth = 0) {
    if (!call || !isCall(call)) return null;
    const st = stOrOpts && typeof stOrOpts.nodes === 'number' ? stOrOpts : makeState(stOrOpts || {});
    if (depth > st.limits.depth) return { section: String(call.section), method: String(call.method), args: [] };
    return { section: String(call.section), method: String(call.method), args: argEntries(call, st, depth) };
}

// An event as { section, method, args } with the same node kinds; the fields'
// declared names and types come from the event metadata.
export function eventToTree(event, opts = {}) {
    if (!event || !event.meta) return null;
    const st = makeState(opts);
    const fields = Array.from(event.meta.fields || []);
    const data = Array.from(event.data || []);
    return {
        section: String(event.section), method: String(event.method),
        args: data.map((d, i) => {
            const f = fields[i];
            const name = f && f.name && (typeof f.name.isSome === 'boolean' ? (f.name.isSome ? String(f.name.unwrap()) : '') : String(f.name));
            const typeName = typeNameOf(f);
            return { name: name ? name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) : `arg${i}`, type: typeName, typeName, node: codecToNode(d, st, 0, f && f.type !== undefined ? { id: f.type } : null) };
        })
    };
}

// The asset a call or event names: a sibling argument called id / assetId /
// asset / assetKind / currencyId holding a number (or WithId(number)).
export function assetIdOf(siblings) {
    const s = (siblings || []).find(x => /^(id|assetId|asset|assetKind|currencyId)$/i.test(x.name) && x.node);
    if (!s) return null;
    const n = s.node;
    if (n.k === 'num') return n.v;
    if (n.k === 'enum' && n.v && n.v.k === 'num') return n.v.v;
    return null;
}

// Every asset id named anywhere in a call tree (nested calls included), at most `max`.
export function collectAssetIds(call, max = 8, found = new Set()) {
    if (!call || !Array.isArray(call.args) || found.size >= max) return Array.from(found);
    const id = assetIdOf(call.args);
    if (id !== null && /^\d+$/.test(id)) found.add(id);
    const visit = (n) => {
        if (!n) return;
        if (n.k === 'call') collectAssetIds(n.v, max, found);
        else if (n.k === 'enum' && n.v) visit(n.v);
        else if (n.k === 'vec' || n.k === 'tuple') (n.v || []).forEach(visit);
    };
    call.args.forEach(a => visit(a.node));
    return Array.from(found).slice(0, max);
}
