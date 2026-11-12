// The human-readable form of a decoded call's arguments (lib/call-tree.js makes
// the typed tree; this renders it). Pages that show a call - governance item
// pages, council motion cards, the transaction page, the block decoder, the
// multisig review - all go through renderCallHtml / callSummaryText.
//
// Rules, the part that must stay conservative:
//  * A number is PDEX only when its argument is declared as a balance of the
//    native currency (Balance / BalanceOf, in a pallet whose balance is the
//    native one, or treasury.spend's AssetBalanceOf with the native asset kind).
//    Any other u128 (ids, counts, struct fields) is shown exactly as it is.
//  * Amounts are BigInt arithmetic: 12 decimals, never rounded, trailing zeros
//    trimmed, thousands separators. The exact planck value stays visible in the
//    tooltip and a small muted line.
//  * An asset amount (a balance in an asset pallet) uses the asset's decimals
//    and symbol when the caller knows the asset (ctx.assets[id]), else it is the
//    raw number with "units".
//  * Everything decoded from chain is escaped; nothing is interpolated raw.
//
// ctx (all optional): { decimals = 12, symbol = 'PDEX', head, blockMs, now,
//   fmtDate(ms), nameOf(address) -> label|null, assets: { [id]: { symbol, decimals } } }
// A call may carry its own `assets` (the server resolves the assets it names).
import { escapeHtml as esc } from './html-escape.js';
import { assetIdOf } from './call-tree.js';

export const NATIVE_SYMBOL = 'PDEX';
export const NATIVE_DECIMALS = 12;
const DEFAULT_BLOCK_MS = 12000;
// Pallets whose Balance types are not (or not only) the native currency: asset
// pallets, the asset-conversion pools, the bridges and the orderbook. Their
// amounts are never PDEX. test/call-args-review.test.js checks against the
// 373 and 393 metadata that every pallet whose calls name an asset is here.
export const ASSET_PALLETS = new Set([
    'assets', 'poolAssets', 'assetConversion', 'assetConversionTxPayment', 'assetTxPayment', 'assetRewards', 'assetHandler',
    'ocex', 'thea', 'theaExecutor', 'theaMessageHandler', 'crowdSourceLMP', 'hyperFungibleToken', 'ismp'
]);
// Pallets that keep their own fixed-decimal convention (OCEX scales every
// asset to 12 decimals), so the asset's own decimals would be wrong: raw units.
export const RAW_UNIT_PALLETS = new Set(['ocex']);
const NATIVE_BALANCE = new Set(['Balance', 'BalanceOf', 'CurrencyBalance', 'CurrencyBalanceOf']);
const ASSET_BALANCE = new Set(['AssetBalance', 'AssetBalanceOf']);
const PER_THINGS = { Perbill: 7, Permill: 4, Percent: 0, Perquintill: 16 };

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A whole non-negative number (decimal string, bigint or safe integer) scaled by
// `decimals`, as text: "1,234.5678". null when it is not one.
export function formatPlanck(raw, decimals = NATIVE_DECIMALS) {
    let n;
    if (typeof raw === 'bigint') n = raw;
    else if (typeof raw === 'number') { if (!Number.isSafeInteger(raw)) return null; n = BigInt(raw); }
    else if (typeof raw === 'string' && /^\d+$/.test(raw)) n = BigInt(raw);
    else return null;
    if (n < 0n) return null;
    const s = n.toString();
    if (decimals <= 0) return group(s);
    const padded = s.padStart(decimals + 1, '0');
    const whole = padded.slice(0, padded.length - decimals);
    const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
    return group(whole) + (frac ? '.' + frac : '');
}

export function formatAmount(raw, { decimals = NATIVE_DECIMALS, symbol = NATIVE_SYMBOL } = {}) {
    const t = formatPlanck(raw, decimals);
    return t === null ? null : `${t} ${symbol}`;
}

export function shortHash(hex) {
    const s = String(hex == null ? '' : hex);
    return /^0x[0-9a-fA-F]{20,}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

const shortAddr = (a) => (String(a).length > 12 ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : String(a));

// BalanceOf<T>, T::Balance, <T as Config<I>>::Balance, Compact<..>, Option<..> -> the bare name.
function baseTypeName(t) {
    let s = String(t == null ? '' : t).trim();
    for (let i = 0; i < 4; i++) { const m = /^(?:Option|Compact)<(.+)>$/.exec(s); if (!m) break; s = m[1].trim(); }
    return s.replace(/^<.*?>+::/, '').replace(/^T::/, '').replace(/<.*$/, '');
}

// treasury.spend's asset kind names the native currency when its runtime type
// is the unit () (Polkadex: AssetKind = (), decoded as a Null node) or when it
// is NativeOrWithId's Native variant (Substrate). Anything else, including a
// missing node, is an asset.
const isNativeAssetKind = (node) => !!node && ((node.k === 'null' && (node.t === undefined || node.t === 'Null' || node.t === '()'))
    || (node.k === 'enum' && node.e === 'Native' && !node.v));

// 'native' | 'asset' | null for an argument.
function balanceClass(section, method, typeName, siblings) {
    const base = baseTypeName(typeName);
    if (NATIVE_BALANCE.has(base)) return ASSET_PALLETS.has(section) ? 'asset' : 'native';
    if (ASSET_BALANCE.has(base)) {
        const kind = (siblings || []).find(x => x.name === 'assetKind');
        if (section === 'treasury' && kind) return isNativeAssetKind(kind.node) ? 'native' : 'asset';
        return 'asset';
    }
    return null;
}

export function isNativeBalanceField(section, method, name, typeName, siblings) {
    return balanceClass(section, method, typeName, siblings) === 'native';
}

const isoDate = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const dateOf = (ms, ctx) => (ctx.fmtDate || isoDate)(ms);

// ---- one node as html or text -----------------------------------------------------

function amountParts(raw, cls, scope, ctx) {
    if (cls === 'native') {
        const decimals = ctx.decimals === undefined ? NATIVE_DECIMALS : ctx.decimals, symbol = ctx.symbol || NATIVE_SYMBOL;
        const text = formatAmount(raw, { decimals, symbol });
        return text === null ? null : { text, title: `${raw} planck`, raw: `${raw} planck` };
    }
    const id = RAW_UNIT_PALLETS.has(scope.section) ? null : assetIdOf(scope.siblings);
    const meta = id !== null && ctx.assets ? ctx.assets[id] : null;
    if (meta && Number.isInteger(meta.decimals) && meta.symbol) {
        const text = formatAmount(raw, { decimals: meta.decimals, symbol: String(meta.symbol) });
        return text === null ? null : { text, title: `${raw} units`, raw: `${raw} units` };
    }
    return /^\d+$/.test(raw) ? { text: `${raw} units`, title: null, raw: null } : null;
}

function blockParts(raw, ctx) {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    let when = '';
    if (Number.isFinite(Number(ctx.head))) {
        const at = (Number(ctx.now) || Date.now()) + (n - Number(ctx.head)) * (Number(ctx.blockMs) || DEFAULT_BLOCK_MS);
        when = dateOf(at, ctx);
    }
    return { text: `#${group(raw)}`, when, link: Number.isFinite(Number(ctx.head)) ? n <= Number(ctx.head) : false, n };
}

// The kind of presentation a number gets: { kind, ...parts } or null (raw).
function numberView(node, scope, ctx) {
    const t = baseTypeName(node.t);
    if (Object.prototype.hasOwnProperty.call(PER_THINGS, t)) {
        const p = formatPlanck(node.v, PER_THINGS[t]);
        return p === null ? null : { kind: 'plain', text: `${p}%` };
    }
    if (!scope.typeName) {
        // Inside a struct or variant: only a field declared as the native
        // balance is formatted (VestingInfo.locked); block numbers and others
        // there stay raw (an orml schedule's period is typed BlockNumber but is a length).
        if (node.tn && balanceClass(scope.section, scope.method, node.tn, []) === 'native') {
            const a = amountParts(node.v, 'native', scope, ctx);
            return a ? { kind: 'amount', ...a } : null;
        }
        return null;
    }
    const base = baseTypeName(scope.typeName);
    const cls = balanceClass(scope.section, scope.method, scope.typeName, scope.siblings);
    if (cls) { const a = amountParts(node.v, cls, scope, ctx); return a ? { kind: 'amount', ...a } : null; }
    if (base === 'BlockNumber' || base === 'BlockNumberFor') { const b = blockParts(node.v, ctx); return b ? { kind: 'block', ...b } : null; }
    if (base === 'Moment' && /^\d+$/.test(node.v) && Number.isSafeInteger(Number(node.v))) return { kind: 'plain', text: dateOf(Number(node.v), ctx) };
    return null;
}

function acctHtml(addr, ctx) {
    const label = ctx.nameOf ? ctx.nameOf(addr) : null;
    return `<a href="/account/${esc(encodeURIComponent(addr))}" class="item-link ca-acct" title="${esc(addr)}">${esc(label || shortAddr(addr))}</a>`;
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

function nodeHtml(node, scope, ctx, depth) {
    if (!node) return '';
    switch (node.k) {
        case 'num': {
            const v = numberView(node, scope, ctx);
            if (!v) return `<span class="ca-num">${esc(node.v)}</span>`;
            if (v.kind === 'amount') {
                const tip = v.title ? ` title="${esc(v.title)}"` : '';
                return `<span class="ca-amount"${tip}>${esc(v.text)}</span>${v.raw ? ` <span class="gd-muted ca-raw">(${esc(v.raw)})</span>` : ''}`;
            }
            if (v.kind === 'block') {
                const num = v.link ? `<a href="/block/${v.n}" class="item-link">${esc(v.text)}</a>` : esc(v.text);
                return `<span class="ca-block">${num}${v.when ? ` <span class="gd-muted">(~${esc(v.when)})</span>` : ''}</span>`;
            }
            return `<span class="ca-num" title="${esc(node.v)}">${esc(v.text)}</span>`;
        }
        case 'acct': return acctHtml(node.v, ctx);
        case 'bool': return `<span class="ca-bool">${node.v ? 'Yes' : 'No'}</span>`;
        case 'text': return `<span class="ca-text">${esc(node.v)}</span>`;
        case 'hex': {
            const v = String(node.v);
            if (HASH32.test(v)) return `<span class="ca-hash"><code title="${esc(v)}">${esc(shortHash(v))}</code> <button type="button" class="ca-copy" data-ca-copy="${esc(v)}">Copy</button></span>`;
            if (v.length <= 66) return `<code class="ca-hex" title="${esc(v)}">${esc(v)}</code>`;
            // The count is the full value's (node.b); a value cut before b
            // existed gets no count rather than one made from the cut text.
            const bytes = Number.isSafeInteger(node.b) ? node.b : (/^0x[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0 ? (v.length - 2) / 2 : null);
            return `<code class="ca-hex" title="${esc(v)}">${esc(`${v.slice(0, 18)}…${bytes === null ? '' : ` (${group(String(bytes))} bytes)`}`)}</code>`;
        }
        case 'none': return '<span class="gd-muted">none</span>';
        case 'null': return '<span class="gd-muted">-</span>';
        case 'trunc': return '<span class="gd-muted">…</span>';
        case 'call': return callBlockHtml(node.v, ctx, depth + 1, false);
        case 'enum': {
            if (node.e === 'Id' && node.v && node.v.k === 'acct') return acctHtml(node.v.v, ctx);
            if (node.v && node.v.k === 'call') return `<span class="gd-muted">inline call</span> ${nodeHtml(node.v, scope, ctx, depth)}`;
            const inner = node.v ? `: ${nodeHtml(node.v, { section: scope.section, method: scope.method, siblings: [] }, ctx, depth)}` : '';
            return `<span class="ca-enum">${esc(node.e)}</span>${inner}`;
        }
        case 'vec': case 'tuple': {
            const items = Array.isArray(node.v) ? node.v : [];
            if (!items.length) return '<span class="gd-muted">none</span>';
            const sub = { section: scope.section, method: scope.method, siblings: [] };
            const more = node.n && node.n > items.length ? `<li class="gd-muted">and ${esc(node.n - items.length)} more</li>` : '';
            return `<ol class="ca-list">${items.map(x => `<li>${nodeHtml(x, sub, ctx, depth + 1)}</li>`).join('')}${more}</ol>`;
        }
        case 'struct': {
            const keys = Object.keys(node.v || {});
            if (!keys.length) return '<span class="gd-muted">-</span>';
            const sub = { section: scope.section, method: scope.method, siblings: [] };
            return `<span class="ca-struct">${keys.map(k => `<span class="ca-field"><span class="ca-key">${esc(k)}</span>: ${nodeHtml(node.v[k], sub, ctx, depth + 1)}</span>`).join('; ')}</span>`;
        }
        default: return `<span class="ca-text">${esc(node.v == null ? '' : node.v)}</span>`;
    }
}

function argRowHtml(call, arg, ctx, depth) {
    const value = arg.node
        ? nodeHtml(arg.node, { section: call.section, method: call.method, typeName: arg.typeName || arg.type, siblings: call.args }, ctx, depth)
        : esc(arg.value == null ? '' : arg.value);
    const tn = arg.typeName || arg.type;
    return `<tr><td><code>${esc(arg.name)}</code>${tn ? ` <span class="gd-muted">${esc(tn)}</span>` : ''}</td><td class="gd-arg-value">${value}</td></tr>`;
}

function callBlockHtml(call, ctx, depth, top) {
    if (!call || !call.section) return '';
    const args = Array.isArray(call.args) ? call.args : [];
    const table = args.length
        ? `<div class="table-responsive"><table class="data-table gd-args ca-args"><thead><tr><th scope="col">Argument</th><th scope="col">Value</th></tr></thead><tbody>${args.map(a => argRowHtml(call, a, ctx, depth)).join('')}</tbody></table></div>`
        : '';
    const cls = top ? 'ca-call' : 'ca-call ca-nested';
    return `<div class="${cls}"><code class="gd-call-name ca-name">${esc(call.section)}.${esc(call.method)}</code>${table}</div>`;
}

// The whole call: its name, an argument table, and the raw JSON one click away.
export function renderCallHtml(call, ctx = {}, { raw = true } = {}) {
    if (!call || !call.section || !call.method) return '';
    if (!ctx.assets && call.assets) ctx = { ...ctx, assets: call.assets };
    if (!raw) return callBlockHtml(call, ctx, 0, true);
    return `${callBlockHtml(call, ctx, 0, true)}<details class="ca-raw-view"><summary>Raw JSON</summary><pre class="ca-raw-json">${esc(rawCallJson(call))}</pre></details>`;
}

// ---- raw JSON and one-line summary --------------------------------------------------

const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function rawOf(node) {
    if (!node) return null;
    switch (node.k) {
        case 'none': case 'null': return null;
        case 'trunc': return '...';
        case 'call': return rawCall(node.v);
        case 'enum': return node.v ? { [lower(node.e)]: rawOf(node.v) } : node.e;
        case 'vec': case 'tuple': return (node.v || []).map(rawOf);
        case 'struct': { const o = {}; for (const k of Object.keys(node.v || {})) o[k] = rawOf(node.v[k]); return o; }
        default: return node.v;
    }
}

function rawCall(call) {
    return { section: call.section, method: call.method, args: (call.args || []).map(a => ({ name: a.name, type: a.typeName || a.type || null, value: a.node ? rawOf(a.node) : (a.value == null ? null : a.value) })) };
}

export function rawCallJson(call) {
    return call && call.section ? JSON.stringify(rawCall(call), null, 2) : '';
}

function nodeText(node, scope, ctx) {
    if (node.k === 'num') { const v = numberView(node, scope, ctx); return v ? (v.kind === 'block' ? v.text : v.text) : null; }
    return null;
}

// One line: "treasury.spend: 50,000 PDEX to eAbCd1…wXyZ". Amounts and the first
// account only; a batch or wrapper lists its inner calls. withName false drops
// the leading call name (a title already has it).
export function callSummaryText(call, ctx = {}, { withName = true, maxLen = 200 } = {}) {
    if (!call || !call.section || !call.method) return '';
    if (!ctx.assets && call.assets) ctx = { ...ctx, assets: call.assets };
    const name = `${call.section}.${call.method}`;
    const parts = [];
    let to = null;
    const inner = [];
    for (const a of call.args || []) {
        const n = a.node;
        if (!n) continue;
        const scope = { section: call.section, method: call.method, typeName: a.typeName || a.type, siblings: call.args };
        const cls = n.k === 'num' ? balanceClass(call.section, call.method, scope.typeName, call.args) : null;
        if (cls) { const t = nodeText(n, scope, ctx); if (t) parts.push(t); }
        const acct = n.k === 'acct' ? n.v : (n.k === 'enum' && n.e === 'Id' && n.v && n.v.k === 'acct' ? n.v.v : null);
        if (acct && to === null) to = acct;
        const nodes = n.k === 'call' ? [n] : n.k === 'vec' ? (n.v || []).filter(x => x.k === 'call')
            : n.k === 'enum' && n.v && n.v.k === 'call' ? [n.v] : [];
        for (const c of nodes) inner.push(callSummaryText(c.v, ctx, { maxLen: 120 }));
    }
    const own = parts.join(', ') + (to ? `${parts.length ? ' ' : ''}to ${shortAddr(to)}` : '');
    const innerText = inner.length ? (inner.length > 3 ? `${inner.slice(0, 3).join('; ')}; and ${inner.length - 3} more` : inner.join('; ')) : '';
    const body = [own, innerText].filter(Boolean).join(': ');
    const full = withName ? (body ? `${name}: ${body}` : name) : body;
    return full.length > maxLen ? `${full.slice(0, maxLen - 1)}…` : full;
}

// One delegated listener for the Copy buttons next to shortened hashes.
// deps: { copy(text) -> Promise<boolean> }. Returns the listener.
export function installCallArgCopy(doc, deps = {}) {
    const onClick = async (e) => {
        const b = e && e.target && e.target.closest ? e.target.closest('[data-ca-copy]') : null;
        if (!b) return;
        if (e.preventDefault) e.preventDefault();
        let ok = false;
        try { ok = !!(deps.copy && await deps.copy(b.getAttribute('data-ca-copy'))); } catch (_) { ok = false; }
        b.textContent = ok ? 'Copied' : 'Copy failed';
    };
    doc.addEventListener('click', onClick);
    return onClick;
}
