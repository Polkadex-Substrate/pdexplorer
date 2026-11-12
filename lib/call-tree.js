// A decoded call (or event) from @polkadot/types codecs into a plain, typed,
// JSON-safe tree. The pages format it (lib/call-args-format.js); this module
// only describes what is there and keeps what the formatter needs:
//
//   call   { section, method, args: [{ name, type, typeName, node }] }
//   node   { k, v, ...}   k is the kind:
//     num    v decimal string (never a float, never toJSON's hex), t raw type ("Compact<u128>", "Perbill")
//     acct   v SS58 string (the registry's prefix)
//     bool   v boolean         text  v string         hex  v hex string
//     enum   e variant name, v inner node or null
//     none   an Option that is None (a Some is just its inner node)
//     vec / tuple  v [node]    struct  v { field: node }
//     call   v call tree (a nested call, also the inline call inside a Bounded)
//     null   a unit      raw  v text (fallback)      trunc  cut by a limit
//
// typeName is the argument's declared name in the pallet metadata (BalanceOf,
// Balance, AccountIdLookupOf, BlockNumberFor...): the only reliable way to tell
// a balance from any other u128. Nested values carry no typeName.
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

export function codecToNode(v, st = makeState(), depth = 0) {
    if (v === null || v === undefined) return { k: 'none' };
    if (++st.nodes > st.limits.nodes || depth > st.limits.depth) return { k: 'trunc' };
    try {
        if (isCall(v)) return { k: 'call', v: callToTree(v, st, depth + 1) };
        if (isOption(v)) return v.isNone ? { k: 'none' } : codecToNode(v.unwrap(), st, depth);
        if (isEnum(v)) {
            if (v.type === 'Inline' && v.value && typeof v.value.toHex === 'function' && v.registry) {
                try {
                    const inner = v.registry.createType('Call', v.value.toHex());
                    return { k: 'enum', e: 'Inline', v: { k: 'call', v: callToTree(inner, st, depth + 1) } };
                } catch (_) { /* not a call: show the bytes */ }
            }
            return { k: 'enum', e: String(v.type), v: v.isBasic ? null : codecToNode(v.value, st, depth + 1) };
        }
        if (v instanceof Map) {
            const o = Object.create(null);
            for (const [key, val] of v.entries()) o[String(key).replace(/_$/, '')] = codecToNode(val, st, depth + 1);
            return { k: 'struct', v: o };
        }
        if (Array.isArray(v)) {
            const items = Array.from(v).slice(0, st.limits.items).map(x => codecToNode(x, st, depth + 1));
            const out = { k: rawType(v).startsWith('(') ? 'tuple' : 'vec', v: items };
            if (v.length > items.length) out.n = v.length;
            return out;
        }
        const t = rawType(v);
        if (t === 'bool') return { k: 'bool', v: !!v.isTrue };
        if (t === 'AccountId' || t === 'AccountId32' || t === 'AccountId20') return { k: 'acct', v: String(v) };
        if (typeof v.toBigInt === 'function' || typeof v.toBn === 'function') return { k: 'num', t: cut(t, 40), v: String(v) };
        if (t === 'Text') return { k: 'text', v: cut(String(v), st.limits.text) };
        if (typeof v.toHex === 'function') return { k: 'hex', v: cut(v.toHex(), st.limits.text) };
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
    return Array.from(call.args || []).map((a, i) => {
        const typeName = typeNameOf(meta[i]);
        return { name: nameOf(meta[i], i), type: typeName, typeName, node: codecToNode(a, st, depth) };
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
            return { name: name ? name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) : `arg${i}`, type: typeName, typeName, node: codecToNode(d, st, 0) };
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
