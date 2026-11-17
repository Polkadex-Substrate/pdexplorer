// Lazy enable (CEO-approved, 2026-11-16; spec cto-team/plans/2026-11-16-connect-wallet-redesign.md (g)).
//
// Before: getInjectedAccounts called enable() on EVERY installed extension, at
// page load (the auto-pick), at picker mount, at sign time and for the multisig
// signer list, and getWalletSigner looped over every extension for the
// discussion sign-in. A first-time visitor got an authorisation popup over a
// page they had not read, and signing with Polkadot.js could pop Talisman.
//
// Now lib/wallet-sources.js is the only code that calls enable(). A wallet is
// asked only when the user clicked its row, or silently when it is the one
// the user used last (pdex_wallet_last_source, cleared by Disconnect).
//
// Layers:
//   1. lib/wallet-sources.js   pure: detection, the registry, signing order
//   2. lib/wallet-session.js   the remembered source
//   3. script.js               the real functions (helpers/wallet-world.js)
//                              against fake extensions that count enable()
//   4. the guard               no other file may call .enable(
//
// Addresses are synthetic (32 bytes of one repeated value). They belong to no one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAddress, decodeAddress } from '@polkadot/util-crypto';
import { detectSources, createSourceRegistry, signingKeys, findSigner, findEnableCalls, sourceLabel, SOURCE_ORDER, PHONE_SOURCE } from '../lib/wallet-sources.js';
import { createWalletSession, WALLET_KEYS } from '../lib/wallet-session.js';
import { makeProfile, openTab, fakeExtension, settle, addr, A, B } from './helpers/wallet-world.js';
import { memStorage } from './helpers/wallet-world.js';
import { bodyOf } from './helpers/source.js';

const SCRIPT = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const same = (a, b) => { try { return Buffer.from(decodeAddress(a)).equals(Buffer.from(decodeAddress(b))); } catch (e) { return false; } };
const toPdex = (a) => encodeAddress(decodeAddress(a), 88);
const acct = (n, name) => ({ address: addr(n, 42), name });
const provider = (accounts, { reject = false } = {}) => {
    const p = { calls: 0, enable: async (app) => { p.calls++; p.app = app; if (reject) throw new Error('Rejected'); return { accounts: { get: async () => accounts.map(a => ({ ...a })) }, signer: { tag: 'signer', signRaw: async () => ({}) } }; } };
    return p;
};

// ─── 1. lib/wallet-sources.js ───────────────────────────────────────────────

describe('detectSources: which wallets are installed, without asking any of them', () => {
    test('keys with an enable function, in the fixed display order, unknown keys after by name; enable is never called', () => {
        const calls = [];
        const p = (k) => ({ enable: () => { calls.push(k); return Promise.resolve({}); } });
        const injected = { zeta: p('zeta'), talisman: p('talisman'), 'fearless-wallet': p('fearless-wallet'), alpha: p('alpha'), 'polkadot-js': p('polkadot-js'), 'subwallet-js': p('subwallet-js'), broken: { enable: 'no' }, empty: null };
        const got = detectSources(injected);
        assert.deepEqual(got.map(s => s.key), ['polkadot-js', 'talisman', 'subwallet-js', 'fearless-wallet', 'alpha', 'zeta']);
        assert.deepEqual(got.map(s => s.name), ['Polkadot.js', 'Talisman', 'SubWallet', 'Fearless Wallet', 'alpha', 'zeta']);
        assert.deepEqual(calls, [], 'detection asked a wallet');
        assert.deepEqual(SOURCE_ORDER, ['polkadot-js', 'talisman', 'subwallet-js', 'polkagate', 'nova', 'fearless-wallet']);
    });

    test('nothing installed is an empty list; the phone is a separate entry, only when asked for, and never an extension row', () => {
        assert.deepEqual(detectSources(undefined), []);
        assert.deepEqual(detectSources({}), []);
        const withPhone = detectSources({ walletconnect: { enable() {} } }, { phone: true });
        assert.deepEqual(withPhone.map(s => s.key), [PHONE_SOURCE]);
        assert.equal(withPhone[0].phone, true);
        assert.deepEqual(detectSources({ walletconnect: { enable() {} } }), [], 'a paired phone is not listed as an extension');
    });

    test('sourceLabel names the wallets the way the page does', () => {
        assert.equal(sourceLabel('polkadot-js'), 'Polkadot.js');
        assert.equal(sourceLabel('nova'), 'Nova Wallet');
        assert.equal(sourceLabel('multisig'), 'Multisig wallet');
        assert.equal(sourceLabel(''), 'Read-only address');
        assert.equal(sourceLabel('mystery'), 'mystery');
    });
});

describe('createSourceRegistry: the only code that asks a wallet', () => {
    const make = (injected) => createSourceRegistry({ getInjected: () => injected, appName: 'Polkadex Explorer', toAddress: toPdex });

    test('enableSource asks that one wallet only, with the app name, and reports ok with Polkadex-form accounts', async () => {
        const pj = provider([acct(1, 'Alice')]), ta = provider([acct(2, 'Bob')]);
        const reg = make({ 'polkadot-js': pj, talisman: ta });
        const r = await reg.enableSource('polkadot-js');
        assert.equal(r.status, 'ok');
        assert.deepEqual(r.accounts, [{ address: addr(1), name: 'Alice', source: 'polkadot-js' }]);
        assert.equal(pj.calls, 1);
        assert.equal(pj.app, 'Polkadex Explorer');
        assert.equal(ta.calls, 0, 'another wallet was asked');
        assert.deepEqual(reg.enabledKeys(), ['polkadot-js']);
        assert.equal(reg.signer('polkadot-js').tag, 'signer');
        assert.equal(reg.signer('talisman'), null);
    });

    test('refused (enable throws) and shared none (resolves, empty list) are told apart; a missing wallet is "missing"', async () => {
        const reg = make({ 'polkadot-js': provider([], { reject: true }), talisman: provider([]) });
        assert.equal((await reg.enableSource('polkadot-js')).status, 'rejected');
        assert.equal((await reg.enableSource('talisman')).status, 'empty');
        assert.equal((await reg.enableSource('subwallet-js')).status, 'missing');
        assert.deepEqual(reg.enabledKeys(), ['talisman'], 'a refused wallet is not kept');
    });

    test('two calls while one is in flight are one request', async () => {
        const pj = provider([acct(1, 'Alice')]);
        const reg = make({ 'polkadot-js': pj });
        const [a, b] = await Promise.all([reg.enableSource('polkadot-js'), reg.enableSource('polkadot-js')]);
        assert.equal(pj.calls, 1);
        assert.equal(a, b);
    });

    test('read uses the kept handle (no new request); an unasked wallet is asked once; a removed wallet reads "missing"', async () => {
        const pj = provider([acct(1, 'Alice')]);
        const injected = { 'polkadot-js': pj };
        const reg = make(injected);
        await reg.enableSource('polkadot-js');
        const again = await reg.read('polkadot-js');
        assert.equal(again.status, 'ok');
        assert.equal(pj.calls, 1, 'read asked the wallet again');
        delete injected['polkadot-js'];
        assert.equal((await reg.read('polkadot-js')).status, 'missing');
        assert.deepEqual(reg.enabledKeys(), []);
    });

    test('accounts(keys) reads only those keys, in order', async () => {
        const pj = provider([acct(1, 'Alice')]), ta = provider([acct(2, 'Bob')]);
        const reg = make({ 'polkadot-js': pj, talisman: ta });
        const list = await reg.accounts(['talisman']);
        assert.deepEqual(list.map(a => a.source), ['talisman']);
        assert.equal(pj.calls, 0);
    });
});

describe('signingKeys and findSigner: who may be asked to sign', () => {
    test('the account\'s wallet first, then the remembered one, then this visit\'s, then a paired phone; nothing else', () => {
        const present = ['polkadot-js', 'talisman', 'subwallet-js', 'walletconnect'];
        assert.deepEqual(signingKeys({ stored: 'talisman', remembered: 'polkadot-js', enabled: ['subwallet-js', 'talisman'], present }), ['talisman', 'polkadot-js', 'subwallet-js', 'walletconnect']);
        assert.deepEqual(signingKeys({ stored: 'talisman', remembered: '', enabled: [], present: ['polkadot-js', 'talisman'] }), ['talisman'], 'an installed but unchosen wallet is not on the list');
        assert.deepEqual(signingKeys({ stored: 'multisig', remembered: 'talisman', enabled: [], present }), ['talisman', 'walletconnect']);
        assert.deepEqual(signingKeys({ stored: 'nova', remembered: '', enabled: [], present }), ['walletconnect'], 'a wallet that is gone is skipped');
    });

    test('legacy (no wallet recorded at all): every detected wallet, but only when the caller allows it', () => {
        const present = ['polkadot-js', 'talisman'];
        assert.deepEqual(signingKeys({ stored: '', remembered: '', enabled: [], present }), []);
        assert.deepEqual(signingKeys({ stored: '', remembered: '', enabled: [], present, legacy: true }), ['polkadot-js', 'talisman']);
        assert.deepEqual(signingKeys({ stored: '', remembered: 'talisman', enabled: [], present, legacy: true }), ['talisman'], 'a remembered wallet ends the legacy case');
    });

    test('findSigner stops at the first wallet that holds the account; a wallet later in the list is not asked', async () => {
        const pj = provider([acct(1, 'Alice')]), ta = provider([acct(1, 'Alice in Talisman')]);
        const reg = createSourceRegistry({ getInjected: () => ({ 'polkadot-js': pj, talisman: ta }), toAddress: toPdex });
        const f = await findSigner(reg, { keys: ['polkadot-js', 'talisman'], address: addr(1), isSame: same });
        assert.equal(f.key, 'polkadot-js');
        assert.equal(f.account.source, 'polkadot-js');
        assert.equal(ta.calls, 0);
        const none = await findSigner(reg, { keys: ['polkadot-js'], address: addr(9), isSame: same });
        assert.equal(none.account, null);
        assert.equal(none.rejected, false);
    });

    test('findSigner says when every wallet asked refused, and skips a signer without the needed method', async () => {
        const reg = createSourceRegistry({ getInjected: () => ({ 'polkadot-js': provider([], { reject: true }) }), toAddress: toPdex });
        assert.equal((await findSigner(reg, { keys: ['polkadot-js'], address: addr(1), isSame: same })).rejected, true);
        const noRaw = { enable: async () => ({ accounts: { get: async () => [acct(1, 'A')] }, signer: {} }) };
        const reg2 = createSourceRegistry({ getInjected: () => ({ x: noRaw }), toAddress: toPdex });
        assert.equal((await findSigner(reg2, { keys: ['x'], address: addr(1), isSame: same, needs: 'signRaw' })).signer, null);
    });
});

// ─── 2. lib/wallet-session.js: the remembered source ────────────────────────

describe('the remembered wallet (pdex_wallet_last_source)', () => {
    const make = () => { const storage = memStorage(); return { storage, s: createWalletSession({ storage, isValid: (a) => !!a }) }; };

    test('select remembers a real wallet key; a multisig or typed address keeps the signer wallet remembered', () => {
        const { storage, s } = make();
        assert.equal(WALLET_KEYS.lastSource, 'pdex_wallet_last_source');
        s.select('A', 'talisman');
        assert.equal(s.lastSource(), 'talisman');
        s.select('M', 'multisig');
        assert.equal(storage.getItem('pdex_wallet_last_source'), 'talisman');
        s.select('T', '');
        assert.equal(s.lastSource(), 'talisman');
        s.select('A', 'walletconnect');
        assert.equal(s.lastSource(), 'walletconnect');
    });

    test('Disconnect forgets it, so the next visit asks no wallet', () => {
        const { storage, s } = make();
        s.select('A', 'polkadot-js');
        s.disconnect();
        assert.equal(storage.getItem('pdex_wallet_last_source'), null);
        assert.equal(s.lastSource(), '');
    });

    test('rememberSource writes the key alone: no change event, no revoke', () => {
        const storage = memStorage();
        let revokes = 0, changes = 0;
        const s = createWalletSession({ storage, isValid: (a) => !!a, revokeDiscuss: () => revokes++, onChange: () => changes++ });
        s.select('A', '');
        revokes = 0; changes = 0;
        s.rememberSource('talisman');
        assert.equal(s.lastSource(), 'talisman');
        assert.equal(revokes + changes, 0);
        s.rememberSource('multisig');
        assert.equal(s.lastSource(), 'talisman', 'multisig is not a wallet that can be asked');
    });
});

// ─── 3. script.js, the real functions ───────────────────────────────────────

const pj = (...a) => fakeExtension('polkadot-js', a);
const ta = (...a) => fakeExtension('talisman', a);
const counts = (profile) => Object.fromEntries(profile.extensions.map(e => [e.key, e.enableCalls]));
const optionRow = (tab, key) => tab.root.querySelector(`.wallet-option-row[data-source="${key}"]`);

describe('script.js: no wallet is asked on load', () => {
    test('a new visitor on /wallet, /stake and /staking: zero enable calls, the chooser, no account picked for them', async () => {
        for (const path of ['/wallet', '/stake', '/staking']) {
            const profile = makeProfile({ extensions: [pj(acct(1, 'Alice')), ta(acct(2, 'Bob'))] });
            const tab = openTab(profile, { path });
            await tab.visit(path);
            await settle(80);
            assert.deepEqual(counts(profile), { 'polkadot-js': 0, talisman: 0 }, path + ': a wallet was asked on load');
            assert.equal(tab.read('pdex_wallet_address'), null, path + ': an account was picked for a new visitor');
            assert.ok(optionRow(tab, 'polkadot-js') && optionRow(tab, 'talisman'), path + ': one row per installed wallet');
            tab.close();
        }
    });

    test('a returning user: the dashboard restores from storage and asks no wallet', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice')), ta(acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        profile.local.setItem('pdex_wallet_last_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet/' + A });
        await tab.visit('/wallet/' + A);
        assert.deepEqual(counts(profile), { 'polkadot-js': 0, talisman: 0 });
        tab.close();
    });

    test('Switch wallet asks the remembered wallet only, silently', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice'), acct(2, 'Bob')), ta(acct(3, 'Carol'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        profile.local.setItem('pdex_wallet_last_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet', search: '?switch=1' });
        await tab.visit('/wallet?switch=1');
        await settle(40);
        assert.deepEqual(counts(profile), { 'polkadot-js': 1, talisman: 0 });
        assert.equal(tab.accountButtons().length, 1, 'Bob is listed; Alice is the Current row');
        tab.close();
    });

    test('remembered wallet, nothing connected (not disconnected): only that wallet is asked, and the last-used account is restored', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice'), acct(2, 'Bob')), ta(acct(3, 'Carol'))] });
        profile.local.setItem('pdex_wallet_last_source', 'polkadot-js');
        profile.local.setItem('pdex_last_used_wallet_address', B);
        const tab = openTab(profile, { path: '/wallet' });
        await tab.visit('/wallet');
        await settle(80);
        assert.deepEqual(counts(profile), { 'polkadot-js': 1, talisman: 0 });
        assert.equal(tab.read('pdex_wallet_address'), B);
        tab.close();
    });

    test('the auto-pick returns before announcing a restore when nothing is remembered', () => {
        const body = bodyOf(SCRIPT, 'tryAutoSelectFirstWallet');
        const remembered = body.indexOf('walletSession.lastSource()');
        assert.ok(remembered > 0 && remembered < body.indexOf('walletSession.beginRestore()'), 'beginRestore runs before the remembered-wallet check');
    });
});

describe('script.js: a click asks exactly the wallet clicked', () => {
    test('clicking Talisman asks Talisman once, lists its accounts, and picking one remembers Talisman', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice')), ta(acct(2, 'Bob'))] });
        const tab = openTab(profile, { path: '/wallet' });
        await tab.visit('/wallet');
        optionRow(tab, 'talisman').click();
        await settle(40);
        assert.deepEqual(counts(profile), { 'polkadot-js': 0, talisman: 1 });
        const rows = tab.accountButtons();
        assert.equal(rows.length, 1);
        rows[0].click();
        await settle(40);
        assert.equal(tab.read('pdex_wallet_address'), B);
        assert.equal(tab.read('pdex_wallet_source'), 'talisman');
        assert.equal(tab.read('pdex_wallet_last_source'), 'talisman');
        tab.close();
    });

    test('Disconnect clears the remembered wallet; the next visit asks nothing', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        profile.local.setItem('pdex_wallet_last_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet/' + A });
        tab.fn('disconnectWallet')();
        await settle(40);
        assert.equal(tab.read('pdex_wallet_last_source'), null);
        const before = profile.extensions[0].enableCalls;
        const tab2 = openTab(profile, { path: '/wallet' });
        await tab2.visit('/wallet');
        await settle(60);
        assert.equal(profile.extensions[0].enableCalls, before);
        tab.close(); tab2.close();
    });
});

describe('script.js: signing never asks a wallet the user did not choose', () => {
    const api = (tab) => { tab.ctx.globalApi = { registry: {} }; tab.ctx.liveRuntimeError = () => null; };

    test('a transaction for a Polkadot.js account asks Polkadot.js only, even though Talisman holds the same key', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice')), ta(acct(1, 'Alice in Talisman'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet/' + A });
        api(tab);
        const w = await tab.fn('resolveWalletSigner')((m) => { throw new Error(m); });
        assert.equal(w.signer.extKey, 'polkadot-js');
        assert.deepEqual(counts(profile), { 'polkadot-js': 1, talisman: 0 });
        tab.close();
    });

    test('if the chosen wallet no longer holds the account, signing fails with the existing line instead of asking another wallet', async () => {
        const profile = makeProfile({ extensions: [pj(acct(2, 'Bob')), ta(acct(1, 'Alice in Talisman'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet/' + A });
        api(tab);
        let msg = '';
        const w = await tab.fn('resolveWalletSigner')((m) => { msg = m; return null; });
        assert.equal(w, null);
        assert.match(msg, /This account isn't available in your connected wallet/);
        assert.equal(counts(profile).talisman, 0);
        tab.close();
    });

    test('a refused wallet gives the existing authorisation line', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice'))] });
        profile.extensions[0].provider.enable = async () => { profile.extensions[0].enableCalls++; throw new Error('Rejected'); };
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet/' + A });
        api(tab);
        let msg = '';
        await tab.fn('resolveWalletSigner')((m) => { msg = m; return null; });
        assert.equal(msg, 'Wallet extension authorization was rejected.');
        tab.close();
    });

    test('legacy session (stored address, no wallet recorded): the Sign path asks each detected wallet once and remembers the holder', async () => {
        const profile = makeProfile({ extensions: [pj(acct(2, 'Bob')), ta(acct(1, 'Alice'))] });
        profile.local.setItem('pdex_wallet_address', A);
        const tab = openTab(profile, { path: '/wallet/' + A });
        api(tab);
        const w = await tab.fn('resolveWalletSigner')((m) => { throw new Error(m); });
        assert.equal(w.signer.extKey, 'talisman');
        assert.deepEqual(counts(profile), { 'polkadot-js': 1, talisman: 1 });
        assert.equal(tab.read('pdex_wallet_last_source'), 'talisman');
        await tab.fn('resolveWalletSigner')((m) => { throw new Error(m); });
        assert.deepEqual(counts(profile), { 'polkadot-js': 1, talisman: 1 }, 'the second signature went straight to the remembered wallet');
        tab.close();
    });

    test('discussion sign-in asks the connected wallet only; a wallet the user did not choose is never asked', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice')), ta(acct(1, 'Alice in Talisman'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'talisman');
        const tab = openTab(profile, { path: '/discussions' });
        assert.equal((await tab.fn('getWalletSigner')(A)).extKey, 'talisman');
        assert.deepEqual(counts(profile), { 'polkadot-js': 0, talisman: 1 });

        // The connected wallet no longer holds the account: no other wallet is asked.
        // (A session that recorded no wallet at all may ask them on the sign-in
        // click: test/connect-chooser-review.test.js, finding 7.)
        const moved = makeProfile({ extensions: [pj(acct(2, 'Bob')), ta(acct(1, 'Alice in Talisman'))] });
        moved.local.setItem('pdex_wallet_address', A);
        moved.local.setItem('pdex_wallet_source', 'polkadot-js');
        const t2 = openTab(moved, { path: '/discussions' });
        assert.equal(await t2.fn('getWalletSigner')(A), null);
        assert.equal(moved.extensions[1].enableCalls, 0, 'the discussion sign-in asked a wallet nobody chose');
        tab.close(); t2.close();
    });

    test('getInjectedAccounts (multisig signers) reads the wallets in use only', async () => {
        const profile = makeProfile({ extensions: [pj(acct(1, 'Alice')), ta(acct(2, 'Bob'))] });
        profile.local.setItem('pdex_wallet_address', A);
        profile.local.setItem('pdex_wallet_source', 'polkadot-js');
        const tab = openTab(profile, { path: '/wallet/' + A });
        const list = await tab.fn('getInjectedAccounts')({ retries: 1, retryDelayMs: 1 });
        assert.deepEqual(list.map(a => a.source), ['polkadot-js']);
        assert.deepEqual(counts(profile), { 'polkadot-js': 1, talisman: 0 });
        assert.equal(await openTab(makeProfile(), { path: '/wallet' }).fn('getInjectedAccounts')({ retries: 1, retryDelayMs: 1 }), null, 'null still means nothing installed');
        tab.close();
    });

    test('the multisig UI and the picker get their accounts through the registry', () => {
        assert.match(SCRIPT, /accounts: getInjectedAccounts, selected: getStoredWallet/);
        const panel = bodyOf(SCRIPT, 'renderWalletConnectPanel');
        for (const dep of ['getSources: () => detectSources(', 'enableSource: (k) => walletSources.enableSource(k)', 'readSource: (k) => walletSources.read(k)', 'enabledKeys: () => walletSources.enabledKeys()', 'lastSource: walletSession.lastSource()']) {
            assert.ok(panel.includes(dep), dep);
        }
        assert.ok(!/getAccounts: \(\) => getInjectedAccounts\(\)/.test(panel), 'the picker still asks every wallet at mount');
    });
});

// ─── 4. the guard: one file asks wallets ────────────────────────────────────

const ALLOWED = ['lib/wallet-sources.js', 'lib/walletconnect-source.js'];
const browserFiles = () => [
    { file: 'script.js', src: SCRIPT },
    ...readdirSync(new URL('../lib/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => ({ file: 'lib/' + f, src: readFileSync(new URL('../lib/' + f, import.meta.url), 'utf8') }))
];

describe('guard: .enable( is called in lib/wallet-sources.js and nowhere else', () => {
    test('the browser code has no other call', () => {
        const found = findEnableCalls(browserFiles(), { allow: ALLOWED });
        assert.deepEqual(found, [], found.map(f => f.message).join('\n'));
    });

    test('the guard fails, readably, when a call is added elsewhere (comments do not count)', () => {
        const files = [...browserFiles(), { file: 'lib/new-feature.js', src: '// provider.enable() in a comment is fine\nconst a = 1;\nconst ext = await injected[key].enable(\'Polkadex Explorer\');\n' }];
        const found = findEnableCalls(files, { allow: ALLOWED });
        assert.equal(found.length, 1);
        assert.equal(found[0].file, 'lib/new-feature.js');
        assert.equal(found[0].line, 3);
        assert.equal(found[0].message, "lib/new-feature.js:3 calls .enable( outside lib/wallet-sources.js: const ext = await injected[key].enable('Polkadex Explorer');");
    });

    test('the /cookies page documents pdex_wallet_last_source', () => {
        assert.match(HTML, /<code[^>]*>pdex_wallet_last_source<\/code>/);
    });
});
