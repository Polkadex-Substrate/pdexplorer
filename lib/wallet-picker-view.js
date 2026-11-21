// The Connect wallet / Switch wallet page (/wallet and /wallet?switch=1).
//
// The page asks HOW to connect before it asks which account. Nothing is asked
// of any wallet until the user clicks its row; then that wallet only is asked,
// and its accounts are the second step. A problem is one line, with one
// action, under the row that caused it. Everything secondary sits behind one
// "More options" line. Switching keeps the 11-11 account list (Current row
// with Disconnect, search) and adds "Use a different wallet".
// Specs: cto-team/plans/2026-11-16-connect-wallet-redesign.md and
// 2026-11-11-switch-wallet-redesign.md.
//
// Views (in-page state, no history entries, so the X still goes back):
//   options    how to connect: one row per extension, the phone, Get one
//   accounts   which account, for one wallet
//   pairing    the phone's QR code (WalletConnect)
//   get        no wallet: install links, or the wallet app cards on a phone
//   apps       phone browser: open this page in a wallet app
//
// Everything the page needs from the app comes in through `deps`, so it runs
// in a happy-dom document under node --test:
//   current, currentSource, lastSource, onMobile, hash
//   getSources()        [{ key, name }] installed extensions; never asks one
//   enableSource(key)   asks that wallet: { status: ok|empty|rejected|missing, accounts }
//   readSource(key)     a wallet chosen before (kept handle, or the remembered one)
//   enabledKeys()       wallets connected earlier this visit
//   select(address, source), disconnect()
//   isSame, isValid, esc, shortAddr, helpHtml, closeHtml, mobileCardsHtml,
//   currentUrl, clipboard, reloadPage, mountMultisig(el, { compact, open })
//   slowMs              when the waiting line becomes the longer hint (3 s)
//   detectRetries, detectDelayMs   late injection at mount (6 x 250 ms)
//   walletConnect       falsy, or the controller (script.js
//                       walletConnectController): connect(panel), cancel(),
//                       disconnect(), isConnected(), peerName()

import { buildPickerShellHtml, buildAccountListHtml, buildOptionRowsHtml, chooseLead, filterAccounts, SEARCH_THRESHOLD, REFRESH_ICON_HTML, PROBLEM_LINES, missingAccountBodyHtml, accountCount, tileHtml } from './wallet-picker.js';
import { buildGetWalletHtml, GET_LEAD, NO_WALLET_LINE } from './wallet-onboarding.js';
import { sourceLabel, PHONE_SOURCE } from './wallet-sources.js';

export const NO_PHONE_ACCOUNT = 'This wallet has no Polkadex account. Add one in the app.';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

export function mountWalletPicker(root, deps) {
    const { current = '', currentSource = '', lastSource = '', onMobile = false, hash = '', getSources = () => [], enableSource,
        readSource = enableSource, enabledKeys = () => [], select, disconnect, isSame, isValid, esc, shortAddr, clipboard,
        slowMs = 3000, detectRetries = 6, detectDelayMs = 250 } = deps;
    const wc = deps.walletConnect || null;
    const switching = !!current;
    root.innerHTML = buildPickerShellHtml({
        mode: switching ? 'switch' : 'connect', helpHtml: deps.helpHtml, closeHtml: deps.closeHtml,
        onMobile, mobileCardsHtml: deps.mobileCardsHtml, currentUrl: deps.currentUrl, esc
    });
    const $ = (id) => root.querySelector('#' + id);
    const doc = root.ownerDocument, win = doc.defaultView;
    const section = root.querySelector('section.wallet-picker');
    const titleEl = $('wallet-picker-title'), back = $('wallet-picker-back'), subEl = $('wallet-picker-sub'), live = $('wallet-picker-live');
    const searchWrap = $('wallet-picker-search-wrap'), search = $('wallet-picker-search');
    const accountsEl = $('wallet-accounts'), optionsEl = $('wallet-picker-options'), pairingEl = $('wallet-picker-pairing'), getEl = $('wallet-picker-get');
    const status = $('wallet-picker-status'), differentWrap = $('wallet-picker-different-wrap');
    const missing = $('wallet-picker-missing'), missingBody = $('wallet-picker-missing-body');
    const divider = root.querySelector('.wallet-picker-divider'), more = $('wallet-picker-more');
    const phoneSection = $('wallet-mobile-section'), footnote = $('wallet-picker-footnote');

    let sources = [];
    const states = {};         // key -> { status: idle|waiting|ok|empty|rejected|missing, accounts, problem, slow, token }
    let view = 'options', activeKey = '';
    const history = [];        // views to go Back to: { view, key, from } (from: the control to refocus)
    let retried = false;       // "Check again" found nothing: say so, offer Reload page
    let seq = 0, pairToken = 0, refreshing = false;
    let viewGen = 0;           // bumped on every view change: an answer asked for one view can tell the user has moved on
    const pending = new Set();
    const alive = () => root.contains(section);
    const track = (p) => { pending.add(p); const done = () => pending.delete(p); p.then(done, done); return p; };
    const say = (text) => { live.textContent = text; };
    const phonePaired = () => !!(wc && typeof wc.isConnected === 'function' && wc.isConnected());
    const peer = () => (wc && typeof wc.peerName === 'function' ? wc.peerName() : '') || '';
    const nameOf = (key) => (key === PHONE_SOURCE ? 'Phone wallet' : ((sources.find(s => s.key === key) || {}).name || sourceLabel(key)));
    const rowSel = (key) => `.wallet-option-row[data-source="${key}"]`;
    const actionSel = (a) => `.wallet-option-row[data-action="${a}"]`;
    const focusSel = (sel) => { const el = sel && root.querySelector(sel); if (el && el.focus) el.focus(); };
    const accountsOf = (key) => (states[key] && states[key].accounts) || [];

    // ── the frame around the views ──
    function subtitle() {
        if (view === 'accounts') return switching ? 'Choose the account you want to use.' : 'Choose an account to open your dashboard.';
        if (view === 'pairing') return onMobile ? 'Open your wallet app to connect.' : 'Scan with your phone.';
        if (view === 'get') return GET_LEAD;
        if (view === 'apps') return 'Use the browser inside Nova Wallet or SubWallet.';
        if (switching) return 'Choose a wallet.';
        return !sources.length && !onMobile ? NO_WALLET_LINE : 'Choose how to connect.';
    }
    function frame() {
        section.setAttribute('data-view', view);
        titleEl.textContent = view === 'get' ? 'Get a wallet' : (switching ? 'Switch wallet' : 'Connect wallet');
        back.hidden = !history.length;
        // The one blue guidance icon: "No wallet found in this browser." (spec 6.2). The text is a constant.
        const sub = subtitle();
        subEl.textContent = sub;
        if (sub === NO_WALLET_LINE) { const i = doc.createElement('i'); i.className = 'bx bx-info-circle'; i.setAttribute('aria-hidden', 'true'); subEl.insertBefore(i, subEl.firstChild); }
        const opts = view === 'options', accs = view === 'accounts';
        accountsEl.hidden = !(accs || (opts && switching));
        optionsEl.hidden = !opts;
        pairingEl.hidden = view !== 'pairing';
        getEl.hidden = view !== 'get';
        if (!accs) { searchWrap.hidden = true; search.value = ''; }
        differentWrap.hidden = !(accs && switching);
        missing.hidden = !accs;
        divider.hidden = !(switching && (opts || accs));
        more.hidden = !(opts || (accs && switching));
        phoneSection.hidden = !(view === 'get' || view === 'apps');
        phoneSection.classList.toggle('is-view', view === 'apps');
        if (view === 'apps' || (view === 'get' && onMobile)) phoneSection.open = true;
        else if (view === 'get') phoneSection.open = false;
        const ways = sources.length > 0 || !!wc;
        footnote.hidden = !((opts && ways) || accs || view === 'pairing');
        status.textContent = '';
    }

    // ── options ──
    // The one line for a problem; a paired phone that shares no account has its own.
    const problemLine = (key, kind) => (key === PHONE_SOURCE && kind === 'empty' ? NO_PHONE_ACCOUNT : PROBLEM_LINES[kind](nameOf(key)));
    function paintOptions() {
        const ps = states[PHONE_SOURCE] || {};
        const phone = wc ? { connected: phonePaired(), peer: peer(), count: accountsOf(PHONE_SOURCE).length,
            problem: ps.problem || '', problemLine: ps.problem ? problemLine(PHONE_SOURCE, ps.problem) : '' } : false;
        optionsEl.innerHTML = buildOptionRowsHtml({ sources, states, onMobile, phone, switching, esc, lead: switching ? null : chooseLead({ sources, phone, lastSource, onMobile }) });
        accountsEl.innerHTML = switching ? buildAccountListHtml({ accounts: [], current, currentSource, isSame, esc, shortAddr }) : '';
    }

    // ── accounts, for one wallet ──
    function paintAccounts() {
        const key = activeKey;
        const accounts = accountsOf(key);
        const many = accounts.length > SEARCH_THRESHOLD;
        searchWrap.hidden = !many;
        const q = many ? search.value : '';
        const head = key === PHONE_SOURCE
            ? { label: `Phone wallet: ${peer() || 'your phone'}`, html: `<span class="wallet-group-actions"><button type="button" class="wallet-wc-disconnect">End connection</button>${REFRESH_ICON_HTML}</span>` }
            : { html: `<span class="wallet-group-actions">${REFRESH_ICON_HTML}</span>` };
        let html = buildAccountListHtml({ accounts, current, currentSource, isSame, esc, shortAddr, query: q, heads: { [key]: head }, primary: !switching });
        if (!accounts.length) {
            // Still asking the remembered wallet: its head (with refresh), and room for the rows.
            html += `<div class="wallet-account-group" data-source="${esc(key)}"><div class="wallet-group-head"><span class="wallet-group-name">${tileHtml(key, esc)}${esc(head.label || nameOf(key))}</span>${head.html}</div><div class="wallet-skel-account" aria-hidden="true"></div></div>`;
        } else if (q.trim() && !filterAccounts(accounts, q, isSame).length) {
            html += `<p class="wallet-picker-nomatch">No account matches "${esc(q.trim())}". <button type="button" class="wallet-picker-clear-link">Clear search</button></p>`;
        }
        accountsEl.innerHTML = html;
        missingBody.innerHTML = missingAccountBodyHtml(key === PHONE_SOURCE ? 'your wallet app' : nameOf(key), esc);
        setRefreshBusy(refreshing);
        if (q.trim()) say(plural(filterAccounts(accounts, q, isSame).length, 'account matches', 'accounts match'));
    }
    function setRefreshBusy(busy) {
        const r = $('wallet-picker-refresh');
        if (!r) return;
        r.disabled = busy;
        r.setAttribute('aria-busy', busy ? 'true' : 'false');
        r.classList.toggle('is-spinning', busy);
    }

    function paintGet() {
        getEl.innerHTML = buildGetWalletHtml({ onMobile, retried });
    }
    function paint() {
        if (view === 'options') paintOptions();
        else if (view === 'accounts') paintAccounts();
        else if (view === 'get') paintGet();
    }
    function show(name, key = '') { view = name; activeKey = key; viewGen++; frame(); paint(); }
    function go(name, key = '', from = null) { history.push({ view, key: activeKey, from }); show(name, key); }
    // A view with no list to land on (get, apps, pairing): focus its Back, so
    // the keyboard is not left on a row that is no longer shown.
    function focusBack() { if (!back.hidden && back.focus) back.focus(); }
    function goBack() {
        if (view === 'pairing') cancelPairing();
        const prev = history.pop();
        if (!prev) return;
        show(prev.view, prev.key);
        focusSel(prev.from);
    }
    const problemState = (status) => { const kind = PROBLEM_LINES[status] ? status : 'rejected'; return { status: kind, accounts: [], problem: kind }; };
    // The wallet answered: its accounts, or one line under its row.
    function landed(key, r, { root = false } = {}) {
        const name = nameOf(key);
        if (r.status === 'ok') {
            states[key] = { status: 'ok', accounts: r.accounts };
            if (root) show('accounts', key); else go('accounts', key, key === PHONE_SOURCE ? actionSel('phone') : rowSel(key));
            if (!root) focusSel('#wallet-accounts .wallet-account-btn');
            say(`${accountCount(r.accounts.length)} found in ${name}.`);
            return;
        }
        const st = problemState(r.status), kind = st.problem;
        states[key] = st;
        if (view === 'options') paintOptions();
        else {
            // Leave the accounts view: back to the options it was opened from,
            // or, when it was the root, the options become the root.
            const top = history[history.length - 1];
            if (top && top.view === 'options') history.pop(); else history.length = 0;
            show('options');
        }
        if (!root) focusSel(key === PHONE_SOURCE ? actionSel('phone') : rowSel(key));
        say(problemLine(key, kind));
    }

    // ── a click on a wallet's row: ask that wallet, and no other ──
    function clearProblems() {
        for (const k of Object.keys(states)) {
            if (!states[k].problem) continue;
            if (states[k].status === 'ok') states[k].problem = null; else delete states[k];
        }
    }
    async function connectRow(key) {
        const st = states[key];
        if (st && st.status === 'waiting') return;
        clearProblems();
        if (st && st.status === 'ok') {   // connected earlier this visit: no new request
            const r = await readSource(key);
            if (alive()) landed(key, r);
            return;
        }
        const token = ++seq;
        states[key] = { status: 'waiting', token };
        paintOptions();
        focusSel(rowSel(key));
        say(`Asking ${nameOf(key)}...`);
        const slow = setTimeout(() => {
            const s = states[key];
            if (!alive() || !s || s.token !== token || s.status !== 'waiting' || view !== 'options') return;
            const had = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(`li[data-source="${key}"]`);
            s.slow = true;
            paintOptions();
            if (had) focusSel(rowSel(key));
        }, slowMs);
        let r;
        try { r = await enableSource(key); } catch (e) { r = { status: 'rejected', accounts: [] }; }
        clearTimeout(slow);
        const s = states[key];
        if (!alive() || !s || s.token !== token) return;   // cancelled meanwhile: a late answer does nothing
        if (view !== 'options') { states[key] = r.status === 'ok' ? { status: 'ok', accounts: r.accounts } : problemState(r.status); return; }
        landed(key, r);
    }
    function cancelRow(key) {
        states[key] = { status: 'idle' };
        paintOptions();
        focusSel(rowSel(key));
        say('');
    }

    // ── Refresh: the shown wallet only ──
    async function refresh() {
        if (refreshing || view !== 'accounts') return;
        const key = activeKey;
        refreshing = true;
        setRefreshBusy(true);
        say(`Asking ${nameOf(key)}...`);
        let r;
        try { r = key === PHONE_SOURCE ? await readSource(key) : await enableSource(key); } catch (e) { r = { status: 'rejected', accounts: [] }; }
        refreshing = false;
        if (!alive() || view !== 'accounts' || activeKey !== key) return;
        if (r.status === 'ok') {
            states[key] = { status: 'ok', accounts: r.accounts };
            paintAccounts();
            say(`${accountCount(r.accounts.length)} found in ${nameOf(key)}.`);
            return;
        }
        landed(key, r, { root: true });
        focusSel(key === PHONE_SOURCE ? actionSel('phone') : rowSel(key));
    }

    // ── the phone (WalletConnect) ──
    async function phoneRow() {
        if (!wc) return;
        clearProblems();
        if (phonePaired()) {
            const r = await readSource(PHONE_SOURCE);
            if (alive()) landed(PHONE_SOURCE, r);
            return;
        }
        go('pairing', '', actionSel('phone'));
        focusBack();
        pair();
    }
    function pair() {
        if (!wc || typeof wc.connect !== 'function') return;
        pairingEl.innerHTML = '<div class="wallet-wc-panel" data-back></div>';
        const panel = pairingEl.querySelector('.wallet-wc-panel');
        const token = ++pairToken;
        Promise.resolve().then(() => wc.connect(panel)).then(
            () => {
                if (token !== pairToken || !alive()) return;
                track(Promise.resolve(readSource(PHONE_SOURCE)).then((r) => {
                    if (token !== pairToken || !alive() || view !== 'pairing') return;
                    if (r.status !== 'ok') { pairFailed(NO_PHONE_ACCOUNT); return; }
                    states[PHONE_SOURCE] = { status: 'ok', accounts: r.accounts };
                    show('accounts', PHONE_SOURCE);   // replaces the pairing view; Back goes to the options
                    focusSel('#wallet-accounts .wallet-account-btn');
                    say(`${accountCount(r.accounts.length)} found in ${nameOf(PHONE_SOURCE)}.`);
                }));
            },
            (e) => {
                if (token !== pairToken || !alive()) return;
                const msg = e && e.message;
                if (!msg || msg === 'Cancelled') { if (view === 'pairing') goBack(); return; }
                pairFailed(/did not share a Polkadex account/i.test(msg) ? NO_PHONE_ACCOUNT : msg);
            }
        );
    }
    function pairFailed(msg) {
        pairingEl.innerHTML = `<div class="wallet-wc-panel" data-back><p class="wc-status wc-error" role="alert">${esc(msg)}</p> <button type="button" class="wallet-wc-retry">Try again</button></div>`;
        say(msg);
    }
    function cancelPairing() {
        ++pairToken;
        if (wc && typeof wc.cancel === 'function') { try { wc.cancel(); } catch (e) { /* already over */ } }
    }
    function endPhone() {
        return track(Promise.resolve().then(() => wc.disconnect()).catch(() => {}).then(() => {
            delete states[PHONE_SOURCE];
            if (!alive()) return;
            history.length = 0;
            show('options');
            focusSel(actionSel('phone'));
        }));
    }

    // ── no wallet ──
    function detect() {
        const next = getSources() || [];
        const changed = next.map(s => s.key).join('|') !== sources.map(s => s.key).join('|');
        sources = next;
        for (const k of Object.keys(states)) if (k !== PHONE_SOURCE && !sources.some(s => s.key === k)) delete states[k];
        return changed;
    }
    function checkAgain() {
        detect();
        if (sources.length) { history.length = 0; show('options'); focusSel('.wallet-option-row'); return; }
        retried = true;
        paintGet();
        focusSel('.wallet-onboarding-note');
    }
    // Rows appear or disappear without a reload when the tab comes back.
    function onWake() {
        if (!alive()) { win.removeEventListener('focus', onWake); doc.removeEventListener('visibilitychange', onWake); return; }
        if (doc.visibilityState === 'hidden') return;
        if (!detect()) return;
        if (view === 'options') { frame(); paintOptions(); }
        else if (view === 'get' && sources.length) { history.length = 0; show('options'); }
    }
    win.addEventListener('focus', onWake);
    doc.addEventListener('visibilitychange', onWake);

    // ── events, delegated so a repaint never loses them. On the section, not
    // the persistent root, so a re-render drops them with the old page. ──
    section.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        const acct = t.closest('.wallet-account-btn[data-address]');
        if (acct && accountsEl.contains(acct)) { select(acct.getAttribute('data-address'), acct.getAttribute('data-source') || ''); return; }
        if (t.closest('#wallet-picker-disconnect')) {
            disconnect();
            const title = root.querySelector('#wallet-picker-title');   // the page re-renders as first connect
            if (title && title.focus) title.focus();
            return;
        }
        const cancel = t.closest('.wallet-option-cancel');
        if (cancel) { cancelRow(cancel.getAttribute('data-source')); return; }
        const retry = t.closest('.wallet-option-retry');
        if (retry) { const k = retry.getAttribute('data-source'); track(k === PHONE_SOURCE ? phoneRow() : connectRow(k)); return; }
        const row = t.closest('.wallet-option-row');
        if (row && optionsEl.contains(row)) {
            const key = row.getAttribute('data-source'), act = row.getAttribute('data-action');
            if (key) track(connectRow(key));
            else if (act === 'phone') track(phoneRow());
            else if (act === 'get') { retried = false; go('get', '', actionSel('get')); focusBack(); }
            else if (act === 'apps') { go('apps', '', actionSel('apps')); focusBack(); }
            return;
        }
        if (t.closest('#wallet-picker-different')) { go('options', '', '#wallet-picker-different'); focusSel('.wallet-option-row'); return; }
        if (t.closest('#wallet-picker-back')) { goBack(); return; }
        if (t.closest('#wallet-picker-refresh') || t.closest('.wallet-picker-refresh-btn')) { track(refresh()); return; }
        if (t.closest('.wallet-wc-disconnect')) { endPhone(); return; }
        if (t.closest('.wallet-wc-retry')) { pair(); return; }
        if (t.closest('.wallet-get-check')) { checkAgain(); return; }
        if (t.closest('.wallet-onboarding-reload')) {
            if (deps.reloadPage) deps.reloadPage(); else win.location.reload();
            return;
        }
        if (t.closest('.wallet-picker-clear-link')) { clearSearch(); return; }
    });
    function clearSearch() {
        search.value = '';
        paintAccounts();
        say('');
        if (search.focus && !searchWrap.hidden) search.focus();
    }
    // Emptied by the shared Clear (lib/input-actions.js) or by hand: the same as clearSearch().
    search.addEventListener('input', () => { if (search.value) paintAccounts(); else clearSearch(); });
    // Escape: clear the search first, then Back if there is one, else close the
    // page. An open "(?)" popover handles its own Escape before this.
    section.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (search.value) { e.preventDefault(); clearSearch(); return; }
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' && e.target !== search && e.target.value) return;   // let a typed address be
        if (history.length) { e.preventDefault(); goBack(); return; }
        const close = root.querySelector('.close-control');
        if (close) { e.preventDefault(); close.click(); }
    });

    // ── View any address ──
    const manualInput = $('wallet-manual-input'), manualErr = $('wallet-manual-error');
    const submitManual = () => {
        const a = (manualInput.value || '').trim();
        if (!isValid(a)) {
            manualErr.textContent = 'That does not look like a valid Polkadex address.';
            manualErr.style.display = 'block';
            return;
        }
        select(a, '');
    };
    $('wallet-manual-btn').addEventListener('click', submitManual);
    manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitManual(); });

    // ── Copy link (phone section); falls back to selecting the text ──
    const copyBtn = $('wallet-copy-btn'), copyInput = $('wallet-copy-url');
    copyBtn.addEventListener('click', async () => {
        try {
            await clipboard.writeText(copyInput.value);
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
        } catch (e) { copyInput.select(); }
    });

    // ── Multisig: collapsed; More options opens by itself only for #multisig ──
    const openMultisig = hash === '#multisig';
    if (openMultisig && more.tagName === 'DETAILS') more.open = true;
    if (deps.mountMultisig) deps.mountMultisig($('wallet-multisig-accounts'), { compact: true, open: openMultisig });

    // ── start: detect (no wallet is asked), then the root view ──
    // Switch mode: the wallet the connected account came from (or the
    // remembered one) is asked silently and its accounts are the root. With no
    // readable wallet (a typed address, a multisig with no remembered signer
    // wallet, a wallet that is gone), the options are the root.
    function rootKey() {
        if (!switching) return '';
        const usable = (k) => !!k && k !== 'multisig' && (k === PHONE_SOURCE ? phonePaired() : sources.some(s => s.key === k));
        if (usable(currentSource)) return currentSource;
        if (usable(lastSource)) return lastSource;
        return '';
    }
    async function start() {
        detect();
        let rk = rootKey();
        show(rk ? 'accounts' : 'options', rk);
        let asked = viewGen;       // the root view this start drew; an answer for it lands there only while it is still shown
        for (let i = 0; !sources.length && i < detectRetries; i++) {
            await wait(detectDelayMs);
            if (!alive()) return;
            if (detect()) { rk = rootKey(); show(rk ? 'accounts' : 'options', rk); asked = viewGen; }
        }
        // Wallets connected earlier this visit read their counts from the kept
        // handle: no request, no popup.
        const kept = (enabledKeys() || []).filter(k => k !== rk && (k === PHONE_SOURCE ? phonePaired() : sources.some(s => s.key === k)));
        if (phonePaired() && rk !== PHONE_SOURCE && !kept.includes(PHONE_SOURCE)) kept.push(PHONE_SOURCE);
        for (const k of kept) {
            const r = await readSource(k);
            if (!alive()) return;
            if (r.status === 'ok') states[k] = { status: 'ok', accounts: r.accounts };
        }
        if (!rk) { if (view === 'options') paintOptions(); return; }
        const name = nameOf(rk);
        if (viewGen === asked) { status.textContent = `Asking ${name}...`; say(`Asking ${name}...`); }
        const slow = setTimeout(() => { if (alive() && view === 'accounts' && !accountsOf(rk).length) status.textContent = `Still waiting. Look for a ${name} popup, or open the extension.`; }, slowMs);
        let r;
        try { r = await readSource(rk); } catch (e) { r = { status: 'rejected', accounts: [] }; }
        clearTimeout(slow);
        if (!alive()) return;
        // The root view still waits on this answer (untouched, or back on it
        // after a detour): draw it there.
        if (viewGen === asked || (view === 'accounts' && activeKey === rk && !history.length)) { landed(rk, r, { root: true }); return; }
        // The user moved on. A click on the row meanwhile owns the answer.
        if (states[rk] && states[rk].status === 'waiting') return;
        if (r.status === 'ok') states[rk] = { status: 'ok', accounts: r.accounts };
        else {
            states[rk] = problemState(r.status);
            // Back must not lead into an accounts view this wallet cannot fill
            // (it would wait forever); the line goes under the wallet's row.
            for (let i = history.length - 1; i >= 0; i--) if (history[i].view === 'accounts' && history[i].key === rk) history.splice(i, 1);
            say(problemLine(rk, states[rk].problem));
        }
        if (view === 'options') {
            const onBack = doc.activeElement === back;
            frame();
            paintOptions();
            if (onBack && back.hidden) focusSel(rowSel(rk));
        }
    }

    const ready = track(start());
    return {
        ready,
        idle: async () => { while (pending.size) await Promise.all(Array.from(pending)); },
        reload: () => (view === 'accounts' ? track(refresh()) : Promise.resolve(onWake())),
        view: () => view,
        root
    };
}
