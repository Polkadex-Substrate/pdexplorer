// Which wallets the page may ask, and the one place that asks them.
//
// A wallet extension shows an authorisation popup the first time a site calls
// its enable(). The page used to call enable() on every installed extension at
// load, at picker mount, at sign time and for the multisig signer list, so a
// first-time visitor got a popup over a page they had not read, and signing
// with Polkadot.js could pop Talisman. Now this module is the only code that
// calls enable() (a test fails if another file does), and the callers decide
// when that is allowed:
//
//   - a click on a wallet's row on the Connect wallet page (that wallet only);
//   - the wallet the user used last (pdex_wallet_last_source), silently, when
//     it is needed: the Switch wallet page, or a signature;
//   - signing: the wallet the account was picked from, then the remembered
//     one, then the wallets connected this visit, then a paired phone.
//
// Detection (which wallets are installed) only reads window.injectedWeb3.
// Import-free, so it runs under node --test with fake providers.
// Spec: cto-team/plans/2026-11-16-connect-wallet-redesign.md (g).

export const PHONE_SOURCE = 'walletconnect';
export const APP_NAME = 'Polkadex Explorer';

// The display order of the known extensions; unknown keys follow by name.
export const SOURCE_ORDER = ['polkadot-js', 'talisman', 'subwallet-js', 'polkagate', 'nova', 'fearless-wallet'];

// Display names for the keys extensions self-declare on window.injectedWeb3.
const SOURCE_LABELS = {
    'multisig': 'Multisig wallet',
    'polkadot-js': 'Polkadot.js',
    'talisman': 'Talisman',
    'subwallet-js': 'SubWallet',
    'polkagate': 'PolkaGate',
    'nova': 'Nova Wallet',
    'fearless-wallet': 'Fearless Wallet',
    'walletconnect': 'WalletConnect'
};

export function sourceLabel(key) {
    if (!key) return 'Read-only address';
    return SOURCE_LABELS[key] || String(key);
}

// A key a signature can be asked of: not a typed address, not a multisig.
const askable = (k) => !!k && k !== 'multisig';

// The installed extensions, in display order, as [{ key, name }]. Never calls
// enable(). A paired phone sits on the same object (allInjected) but is not an
// extension row; with { phone: true } it is added last, marked phone: true.
export function detectSources(injected, { phone = false } = {}) {
    const all = injected && typeof injected === 'object' ? injected : {};
    const rank = (k) => { const i = SOURCE_ORDER.indexOf(k); return i === -1 ? SOURCE_ORDER.length : i; };
    const keys = Object.keys(all)
        .filter(k => k !== PHONE_SOURCE && all[k] && typeof all[k].enable === 'function')
        .sort((a, b) => rank(a) - rank(b) || (rank(a) === SOURCE_ORDER.length ? sourceLabel(a).localeCompare(sourceLabel(b)) : 0));
    const out = keys.map(key => ({ key, name: sourceLabel(key) }));
    if (phone) out.push({ key: PHONE_SOURCE, name: 'Phone wallet', phone: true });
    return out;
}

// getInjected(): the providers now (extensions plus a paired phone).
// toAddress: the Polkadex form of an address.
export function createSourceRegistry({ getInjected, appName = APP_NAME, toAddress = (a) => a }) {
    const handles = new Map();    // key -> what enable() returned, while usable
    const inflight = new Map();   // key -> the request still waiting on the wallet

    const providerOf = (key) => { const all = getInjected() || {}; return all[key]; };
    async function list(key, ext) {
        const accs = await ext.accounts.get();
        return (accs || []).map(a => ({ address: toAddress(a.address), name: a.name || key, source: key }));
    }
    const result = (accounts) => ({ status: accounts.length ? 'ok' : 'empty', accounts });

    // Ask one wallet. 'rejected': enable threw (the user refused, or closed the
    // popup on a wallet that rejects then). 'empty': it answered and shared no
    // account. 'missing': it is not installed (any more). A second call while
    // one waits is the same request.
    function enableSource(key) {
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            const provider = providerOf(key);
            if (!provider || typeof provider.enable !== 'function') { handles.delete(key); return { status: 'missing', accounts: [] }; }
            let ext;
            try { ext = await provider.enable(appName); } catch (e) { handles.delete(key); return { status: 'rejected', accounts: [], error: e }; }
            if (!ext || !ext.accounts || typeof ext.accounts.get !== 'function') { handles.delete(key); return { status: 'rejected', accounts: [] }; }
            handles.set(key, ext);
            let accounts = [];
            try { accounts = await list(key, ext); } catch (e) { accounts = []; }
            return result(accounts);
        })().finally(() => { inflight.delete(key); });
        inflight.set(key, p);
        return p;
    }

    // Read a wallet the user already connected this visit from its kept handle
    // (no new request); one not asked yet is asked. Callers use this only for
    // a wallet the user chose: the remembered one, or one clicked earlier.
    async function read(key) {
        if (inflight.has(key)) return inflight.get(key);
        const ext = handles.get(key);
        if (!ext) return enableSource(key);
        if (!providerOf(key)) { handles.delete(key); return { status: 'missing', accounts: [] }; }
        try { return result(await list(key, ext)); } catch (e) { return { status: 'empty', accounts: [] }; }
    }

    async function accounts(keys) {
        const out = [];
        for (const key of keys || []) {
            const r = await read(key);
            out.push(...r.accounts);
        }
        return out;
    }

    return {
        enableSource, read, accounts,
        enabledKeys: () => Array.from(handles.keys()),
        isEnabled: (key) => handles.has(key),
        signer: (key) => { const h = handles.get(key); return (h && h.signer) || null; },
        forget: (key) => { handles.delete(key); }
    };
}

// The wallets a signature may be asked of, in order: the one the account was
// picked from (stored), the remembered one, the ones connected this visit,
// then a paired phone. Only keys still installed (present). Never any other
// wallet, except in the legacy case the caller allows: a session that recorded
// no wallet at all (older sessions, or a typed address an extension happens
// to hold) may ask each installed wallet once, on a Sign click only.
export function signingKeys({ stored = '', remembered = '', enabled = [], present = [], legacy = false }) {
    const out = [];
    const add = (k) => { if (askable(k) && present.includes(k) && !out.includes(k)) out.push(k); };
    add(stored);
    add(remembered);
    (enabled || []).forEach(add);
    add(PHONE_SOURCE);
    if (legacy && !askable(stored) && !askable(remembered)) present.forEach(add);
    return out;
}

// Ask the wallets in `keys`, in order, for `address`; stop at the first that
// holds it and has a signer (with `needs`, e.g. 'signRaw', when given).
// rejected: every wallet asked refused.
export async function findSigner(registry, { keys, address, isSame, needs = null }) {
    let refused = 0;
    for (const key of keys || []) {
        const r = await registry.read(key);
        if (r.status === 'rejected') { refused++; continue; }
        const account = (r.accounts || []).find(a => { try { return isSame(a.address, address); } catch (e) { return false; } });
        if (!account) continue;
        const signer = registry.signer(key);
        if (!signer || (needs && typeof signer[needs] !== 'function')) continue;
        return { key, account, signer, rejected: false };
    }
    return { key: null, account: null, signer: null, rejected: refused > 0 && refused === (keys || []).length };
}

// The guard behind "this is the only file that asks a wallet": every
// `.enable(` call in `files` ([{ file, src }]) outside `allow`, with a message
// that names the file, the line and the code. Comment lines do not count.
export function findEnableCalls(files, { allow = [] } = {}) {
    const out = [];
    for (const { file, src } of files || []) {
        if (allow.includes(file)) continue;
        String(src || '').split('\n').forEach((text, i) => {
            const t = text.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
            const code = text.replace(/\/\/.*$/, '');
            if (!/\.enable\(/.test(code)) return;
            out.push({ file, line: i + 1, message: `${file}:${i + 1} calls .enable( outside lib/wallet-sources.js: ${t}` });
        });
    }
    return out;
}
