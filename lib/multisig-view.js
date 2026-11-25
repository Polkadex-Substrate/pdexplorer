import { escapeHtml as esc } from './html-escape.js';
import { sameAccount, prepareMultisig, pendingMultisig, recoverMultisigCall } from './multisig.js';
import { discoverMultisigs } from './multisig-discovery.js';
import { helpPopoverHtml, wireHelpPopover } from './help-popover.js';
import { callToTree } from './call-tree.js';
import { renderCallHtml } from './call-args-format.js';
import { icon } from './ui-parts.js';
import { say, REFRESH_UI } from './refresh-ui.js';

const pdex = value => {
    const n = BigInt(value);
    return `${n / 1000000000000n}.${(n % 1000000000000n).toString().padStart(12, '0').replace(/0+$/, '') || '0'} PDEX`;
};
const errorText = e => e?.message || 'Could not load multisig data. Please retry.';
const shortAddress = a => (a && a.length > 16 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a || '');
// A form error: the icon, then the sentence as text (the ui-field-error part, spec 2026-11-25 section 2).
const showError = (node, text) => { if (!node) return; node.innerHTML = icon('bx-error-circle'); node.appendChild(node.ownerDocument.createTextNode(String(text))); };
// The search's state on the Multisig wallets card (spec 2026-11-25, section 3.2): one node for the card's life; a line
// (is-line) for a search state, a block panel for a failure; always an icon and a sentence, never bare grey text.
const STATUS_ICON = { 'is-ok': 'bx-check-circle', 'is-info': 'bx-info-circle', 'is-warn': 'bx-error' };
function setStatus(el, role, text, { line = true, iconName = STATUS_ICON[role] } = {}) {
    if (!el) return;
    el.className = `multisig-discovery-status ui-panel ${role}${line ? ' is-line' : ''}`;
    el.innerHTML = `${icon(iconName)}<span class="ui-panel-body"></span>`;
    el.querySelector('.ui-panel-body').textContent = text;
}
const reducedMotion = (el) => { try { const w = el && el.ownerDocument && el.ownerDocument.defaultView; return !!(w && w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
const FAILED = { timeout: 'That took too long. Check again, or add your wallet below.', 'no-node': 'Not connected to the network yet. Check again in a moment.', other: 'We could not finish checking. Check again, or add your wallet below.' };
const whyMissing = (events) => `We look through this account's recent activity${events != null ? ` (${events} events checked)` : ''}. A multisig that is older, was never used, or that this account has not signed for yet may not appear. Add it below with its signers and number of approvals.`;

// canAskWallets() / askWallets(signers): a session from before the signer
// wallet was remembered finds no signer in the wallets in use. The review then
// offers one button; only its click calls askWallets, which asks the installed
// wallets and remembers the one holding a signer (script.js
// askWalletsForSigners, through lib/wallet-sources.js).
const NO_SIGNER = 'No signer is shared by your wallet extension. Connect an individual signer for this multisig and try again.';
// callGuard(api, call, multisig) -> problems[]: run when the approval being
// built will execute the call (the validator rules of a multisig stash, which
// can change between approvals; lib/validator-delegate-chain.js). A problem
// refuses before the wallet is asked.
// post (R5): the post-action core (lib/post-action.js), or a function returning it. With it, a signed multisig
// transaction reloads only what its block changed: the pending list here (re-read from the chain, its own
// rows settling with S6 or S7), and on execution the inner action's components (lib/action-effects.js row 30);
// without it, refresh(address) remounts the wallet as before.
const HEAD_READ_MS = 1500;   // the pending list's head read, like the server's: a stalled link ends the refresh quietly

export function createMultisigUI({ store, storage, api: getApi, accounts: getAccounts, selected, select, submit, refresh, fetchJson, discover = discoverMultisigs, canAskWallets = () => false, askWallets = null, revision = () => null, callGuard = null, callNote = null,
    post = null, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (id) => clearTimeout(id) }) {
    const core = () => { try { return typeof post === 'function' ? post() : post; } catch (e) { return null; } };
    const settled = new Map();    // callHash -> { kind: 'execute' | 'cancel', block }: this tab's own ends the events confirmed, for the settle word
    const slots = new Map();      // multisig address -> the pending slot last mounted for it
    const watching = new WeakMap();   // pending slot -> its unsubscribe
    const drawn = new WeakMap();      // pending list -> the html last drawn (an equal re-read is a no-op)
    let reviewGeneration = 0;
    let endOpenReview = null;
    const discoveryCache = new WeakMap();
    const mounts = new WeakMap();
    const cacheKey = (api, address, hash) => `pdex_multisig_call:${api.genesisHash.toHex()}:${address}:${hash}`;
    function savedCall(api, address, hash) {
        try {
            const c = JSON.parse(storage.getItem(cacheKey(api, address, hash)) || 'null');
            return c?.specVersion === api.runtimeVersion.specVersion.toString() ? c.hex : '';
        } catch { return ''; }
    }

    function search(api, address, retry) {
        if (!api) return Promise.reject(Object.assign(new Error('Waiting for a node connection. Retry when connected.'), { code: 'no-node' }));
        let cache = discoveryCache.get(api);
        if (!cache) { cache = new Map(); discoveryCache.set(api, cache); }
        const previous = cache.get(address);
        if (previous && (previous.running || (!retry && Date.now() - previous.at < 60000))) return previous.promise;
        const controller = new AbortController();
        const entry = { at: Date.now(), running: true };
        let timer;
        entry.promise = Promise.race([
            discover({ api, address, fetchJson, signal: controller.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => {
                controller.abort(); reject(Object.assign(new Error('Discovery timed out. Retry, or add the multisig manually.'), { code: 'timeout' }));
            }, 30000); })
        ]).finally(() => { clearTimeout(timer); entry.running = false; }).catch(e => { cache.delete(address); throw e; });
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
        cache.set(address, entry);
        return entry.promise;
    }

    function mountAccounts(el, { address = selected(), relatedOnly = false, retry = false, compact = false, open = false } = {}) {
        if (!el) return;
        if (compact) return mountCompact(el, { address, retry, open });
        const token = {};
        mounts.set(el, token);
        const startSelected = selected(), api = getApi();
        const rows = store.list().filter(m => !relatedOnly || m.signers.some(a => sameAccount(a, address)));
        const canDiscover = !!address && !store.find(address) && !!fetchJson;
        const mounted = () => el.isConnected && mounts.get(el) === token && selected() === startSelected;
        const current = () => mounted() && getApi() === api;
        el.innerHTML = `<section class="multisig-panel list-container glass">
            <div class="multisig-head"><h3>Multisig wallets</h3>${canDiscover ? `<button type="button" class="validate-secondary multisig-discover" disabled>${icon('bx-refresh')}Check again</button>` : ''}</div>
            <p class="ui-section-caption">Shared wallets this account can sign for. Open one to see its balance, send PDEX or approve a waiting transaction.</p>
            <div class="multisig-discovery-status" role="status"></div>
            <ul class="multisig-saved-list wallet-account-list" role="list"></ul>
            ${canDiscover ? `<details class="validate-disclosure multisig-why"><summary>Is a wallet missing?</summary><p>${esc(whyMissing(null))}</p></details>` : ''}
            <details class="validate-disclosure multisig-add"><summary>Add a multisig wallet</summary>
                <form class="multisig-import ui-form">
                    <div class="ui-field"><label class="ui-field-label" for="ms-add-name">Wallet name</label><input class="ui-input" id="ms-add-name" name="name" data-input-kind="text" maxlength="80" placeholder="Team wallet" required></div>
                    <div class="ui-field"><label class="ui-field-label" for="ms-add-address">Multisig address</label><input class="ui-input" id="ms-add-address" name="address" data-input-kind="address" required autocomplete="off" spellcheck="false" placeholder="Paste the multisig wallet address"></div>
                    <div class="ui-field"><label class="ui-field-label" for="ms-add-signers">Signer addresses</label><textarea class="ui-input" id="ms-add-signers" name="signers" data-input-kind="address-list" required rows="4" spellcheck="false" aria-describedby="ms-add-signers-hint"></textarea><p class="ui-field-hint" id="ms-add-signers-hint">One per line. Include your own.</p></div>
                    <div class="ui-field"><label class="ui-field-label" for="ms-add-threshold">Approvals needed</label><input class="ui-input is-narrow" id="ms-add-threshold" name="threshold" data-no-input-actions="numeric stepper: the browser arrows already fill this narrow field" type="number" min="1" max="100" step="1" value="2" required></div>
                    <p class="ui-field-hint">We only check that these details match the address. Nothing is sent.</p>
                    <p class="multisig-error ui-field-error" role="alert"></p>
                    <button class="ui-action" type="submit">${icon('bx-plus')}Add wallet</button>
                </form>
            </details>
        </section>`;
        const status = el.querySelector('.multisig-discovery-status');
        if (canDiscover) setStatus(status, 'is-warn', 'Looking for multisig wallets...', { iconName: reducedMotion(el) ? 'bx-time-five' : 'bx-loader-alt bx-spin' });
        else setStatus(status, 'is-info', rows.length ? 'Your saved multisig wallets are listed below.' : 'No multisig wallets saved yet. Add one below.');
        const renderRows = discovered => {
            const all = new Map(discovered.map(m => [m.address, m]));
            for (const m of rows) all.set(m.address, m); // Preserve saved names.
            const list = el.querySelector('.multisig-saved-list');
            list.innerHTML = [...all.values()].map(m => `<li><button type="button" class="wallet-account-btn" data-multisig="${esc(m.address)}" aria-label="${esc(`Open ${m.name}, multisig, ${m.threshold} of ${m.signers.length} approvals`)}">
                <span class="wallet-account-main"><span class="wallet-account-name">${esc(m.name)} <span class="ms-tag">${m.threshold} of ${m.signers.length}</span>${sameAccount(selected(), m.address) ? ` <span class="ui-chip is-neutral">${icon('bx-check')}Selected</span>` : ''}</span><span class="wallet-account-addr">${esc(m.address)}</span></span>
                ${icon('bx-chevron-right')}</button></li>`).join('');
            list.querySelectorAll('[data-multisig]').forEach(btn => btn.addEventListener('click', () => {
                if (!mounted()) return;
                try {
                    const m = store.find(btn.dataset.multisig) || store.save(all.get(btn.dataset.multisig));
                    select(m.address, 'multisig');
                } catch (e) { setStatus(status, 'is-warn', errorText(e), { line: false }); }
            }));
        };
        renderRows([]);
        if (canDiscover) {
            const button = el.querySelector('.multisig-discover');
            const why = el.querySelector('.multisig-why p');
            button.addEventListener('click', () => mountAccounts(el, { address, relatedOnly, retry: true }));
            search(api, address, retry).then(result => {
                if (!current()) return;
                renderRows(result.wallets);
                if (why) why.textContent = whyMissing(result.scannedEvents);
                const n = result.wallets.length;
                if (result.limited || result.unavailableBlocks) setStatus(status, 'is-warn', 'We could not check everything, so a wallet may be missing. Check again, or add it below.');
                else if (n) setStatus(status, 'is-ok', n === 1 ? 'Found 1 multisig wallet.' : `Found ${n} multisig wallets.`);
                else setStatus(status, 'is-info', 'No multisig wallets found for this account. If yours is missing, add it below.');
            }).catch(e => { if (current()) setStatus(status, 'is-warn', FAILED[e && e.code === 'timeout' ? 'timeout' : e && e.code === 'no-node' ? 'no-node' : 'other'], { line: false }); })
                .finally(() => { if (current()) button.disabled = false; });
        }
        const form = el.querySelector('form');
        form.addEventListener('submit', e => {
            e.preventDefault();
            if (!mounted()) return;
            try {
                const values = Object.fromEntries(new FormData(form));
                const m = store.save(values);
                select(m.address, 'multisig');
            } catch (err) { showError(form.querySelector('[role="alert"]'), errorText(err)); }
        });
    }

    // The Switch wallet page's form of the section: one collapsed line under the
    // account list, "Multisig wallets (n)" with a "(?)" for the limits, the
    // search's mechanics out of sight, and the add form behind a link.
    // Discovery itself is unchanged (search above).
    function mountCompact(el, { address, retry, open }) {
        const token = {};
        mounts.set(el, token);
        const startSelected = selected(), api = getApi();
        const connectedIsMultisig = !!address && !!store.find(address);
        const saved = store.list().filter(m => !sameAccount(m.address, startSelected));
        const canDiscover = !!address && !connectedIsMultisig && !!fetchJson;
        const mounted = () => el.isConnected && mounts.get(el) === token && selected() === startSelected;
        const current = () => mounted() && getApi() === api;
        const form = `<form class="multisig-import" hidden>
                <label>Name<input name="name" data-input-kind="text" maxlength="80" placeholder="Team wallet" required></label>
                <label>Multisig address<input name="address" data-input-kind="address" required autocomplete="off" spellcheck="false" placeholder="Paste the wallet's address"></label>
                <label>Signer addresses<textarea name="signers" data-input-kind="address-list" required rows="4" spellcheck="false" placeholder="One per line. Include your own."></textarea></label>
                <label>Approvals needed<input name="threshold" data-no-input-actions="numeric stepper: the browser arrows already fill this narrow field" type="number" min="1" max="100" step="1" value="2" required></label>
                <p class="ms-form-note">We only check that these details match the address. Nothing is sent.</p>
                <p class="multisig-error ui-field-error" role="alert"></p>
                <button class="ui-action" type="submit">${icon('bx-plus')}Add wallet</button>
                <button class="wp-link ms-cancel" type="button">Cancel</button>
            </form>`;
        // Nothing connected and nothing saved: there is nothing to list or look
        // for, so the section is the one link.
        if (!address && !saved.length) {
            el.innerHTML = `<div class="ms-compact-add"><button type="button" class="wp-link ms-add-link">Add a multisig wallet</button>${form}</div>`;
            wireForm(el, mounted, () => {});
            return;
        }
        const pop = helpPopoverHtml({ id: 'ms-help-' + Math.random().toString(36).slice(2, 8), label: 'About multisig wallets', html: '' });
        el.innerHTML = `<div class="ms-compact-wrap"><details class="wallet-picker-disclosure ms-compact"${open ? ' open' : ''}>
                <summary><span class="ms-title">Multisig wallets</span><span class="ms-badge"></span> ${pop.button}</summary>
                <div class="wallet-picker-disclosure-body">
                    <div class="ms-compact-tools">${canDiscover ? `<button type="button" class="wp-icon-btn ms-check-again" aria-label="Check again" title="Check again" disabled><i class='bx bx-refresh' aria-hidden="true"></i></button>` : ''}</div>
                    <p class="ms-status" role="status"></p>
                    <ul class="wallet-account-list ms-rows" role="list"></ul>
                    <p class="ms-add-line"><button type="button" class="wp-link ms-add-link">Add a multisig wallet</button></p>
                    ${form}
                </div>
            </details>${pop.popover}</div>`;
        const details = el.querySelector('details');
        const badge = el.querySelector('.ms-badge'), status = el.querySelector('.ms-status'), list = el.querySelector('.ms-rows');
        const popEl = el.querySelector('.wp-popover');
        wireHelpPopover(el.querySelector('.wp-help-btn'), popEl);
        const about = 'A multisig is a shared wallet that needs approval from several people. ';
        const setAbout = (events) => {
            popEl.textContent = !address
                ? about + 'Connect an account to find yours, or add one by hand.'
                : about + `We find yours from this account's recent activity${events != null ? ` (${events} events checked)` : ''}. Older or never-used multisigs may not appear. If yours is missing, add it by hand.`;
        };
        setAbout(null);
        // state: 'looking' ("(checking...)", no number), 'done' (n, or nothing for 0), 'warn' ("(!)").
        const setBadge = (state, n) => {
            // The count is read as "1 wallet". While looking, words, not a bare spinner glyph.
            badge.innerHTML = state === 'looking' ? ' <span class="ms-checking">(checking...)</span>'
                : state === 'warn' ? ' <span aria-hidden="true">(!)</span><span class="sr-only">, check incomplete</span>'
                : n ? ` <span aria-hidden="true">(${n})</span><span class="sr-only">, ${n} ${n === 1 ? 'wallet' : 'wallets'}</span>` : '';
        };
        const renderRows = (discovered) => {
            const all = new Map(discovered.map(m => [m.address, m]));
            for (const m of saved) all.set(m.address, m); // Preserve saved names.
            const items = [...all.values()].filter(m => !sameAccount(m.address, startSelected));
            list.innerHTML = items.map(m => `<li><button type="button" class="wallet-account-btn" data-multisig="${esc(m.address)}" aria-label="${esc(`Open ${m.name}, multisig, ${m.threshold} of ${m.signers.length} approvals`)}">
                <span class="wallet-account-main"><span class="wallet-account-name">${esc(m.name)} <span class="ms-tag">${m.threshold} of ${m.signers.length}</span></span><span class="wallet-account-addr">${esc(shortAddress(m.address))}</span></span>
                <i class='bx bx-chevron-right' aria-hidden="true"></i></button></li>`).join('');
            el.querySelector('.ms-add-link').textContent = items.length ? 'Not listed? Add a multisig wallet' : 'Add a multisig wallet';
            list.querySelectorAll('[data-multisig]').forEach(btn => btn.addEventListener('click', () => {
                if (!mounted()) return;
                try {
                    const m = store.find(btn.dataset.multisig) || store.save(all.get(btn.dataset.multisig));
                    select(m.address, 'multisig');
                } catch (e) { status.textContent = errorText(e); }
            }));
            return items.length;
        };
        const shown = renderRows([]);
        wireForm(el, mounted, () => { details.open = true; });
        if (!canDiscover) { setBadge('done', shown); if (!shown && address) status.textContent = 'No multisig wallets found for this account.'; return; }
        setBadge('looking');
        status.textContent = 'Looking for multisig wallets...';
        const again = el.querySelector('.ms-check-again');
        again.addEventListener('click', () => mountCompact(el, { address, retry: true, open: true }));
        search(api, address, retry).then(result => {
            if (!current()) return;
            const n = renderRows(result.wallets);
            setAbout(result.scannedEvents);
            const partial = !!(result.limited || result.unavailableBlocks);
            setBadge(partial ? 'warn' : 'done', n);
            status.textContent = partial ? 'We could not check everything, so a wallet may be missing. Try again, or add it by hand.'
                : n ? '' : 'No multisig wallets found for this account.';
        }).catch(e => {
            if (!current()) return;
            setBadge('warn');
            status.textContent = e && e.code === 'timeout' ? 'That took too long. Try again, or add your wallet by hand.'
                : e && e.code === 'no-node' ? 'Not connected to the network yet. Try again in a moment.'
                : 'We could not finish checking. Try again, or add your wallet by hand.';
        }).finally(() => { if (current()) again.disabled = false; });
    }

    // The add form: opened in place by its link, closed by Cancel. Same fields,
    // validation and store.save as the dashboard's form.
    function wireForm(el, mounted, onOpen) {
        const form = el.querySelector('form');
        const link = el.querySelector('.ms-add-link');
        link.addEventListener('click', () => { form.hidden = false; onOpen(); const first = form.querySelector('input'); if (first && first.focus) first.focus(); });
        form.querySelector('.ms-cancel').addEventListener('click', () => { form.hidden = true; if (link.focus) link.focus(); });
        form.addEventListener('submit', e => {
            e.preventDefault();
            if (!mounted()) return;
            try {
                const values = Object.fromEntries(new FormData(form));
                const m = store.save(values);
                select(m.address, 'multisig');
            } catch (err) { showError(form.querySelector('[role="alert"]'), errorText(err)); }
        });
    }

    async function mountPending(el, multisig) {
        if (!el) return;
        const m = store.find(multisig.address);
        if (!m) return;
        slots.set(m.address, el);
        el.innerHTML = `<section class="multisig-panel"><h3>${esc(m.name)} <span class="ms-tag">${m.threshold} of ${m.signers.length}</span></h3>
            <ol class="multisig-steps"><li><strong>Start:</strong> choose <strong>Send PDEX</strong> above, then enter the recipient and amount. Staking and governance actions work with this wallet too.</li><li><strong>Review and sign:</strong> choose your individual signer, check the transaction, and approve in your wallet extension. The signer pays the fee and any refundable multisig deposit.</li><li><strong>Other signers:</strong> open this multisig, then review and approve the pending transaction below. The final required approval executes it.</li></ol>
            <details class="validate-disclosure"><summary>Signer addresses</summary><ul>${m.signers.map(a => `<li class="multisig-address">${esc(a)}</li>`).join('')}</ul></details>
            <div class="multisig-pending-head"><h4>Pending multisig transactions</h4><button type="button" class="validate-secondary multisig-refresh">${icon('bx-refresh')}Refresh list</button></div>
            <div class="multisig-pending-list" aria-live="polite">Loading pending transactions…</div>
            <details class="validate-disclosure"><summary>Start a transaction from encoded call data</summary><div class="multisig-new-form"><div class="ui-field"><label class="ui-field-label" for="multisig-new-call">Encoded call data</label><textarea class="multisig-new-call ui-input" id="multisig-new-call" data-input-kind="hex" rows="3" spellcheck="false" placeholder="0x…"></textarea></div><button type="button" class="ui-action multisig-new">${icon('bx-search-alt')}Review transaction</button></div></details></section>`;
        el.querySelector('.multisig-refresh').addEventListener('click', () => mountPending(el, m));
        el.querySelector('.multisig-new').addEventListener('click', () => review({ multisig: m, callHex: el.querySelector('.multisig-new-call').value.trim() }));
        const list = el.querySelector('.multisig-pending-list');
        watchPending(el, m);
        try {
            const api = getApi();
            if (!api?.query.multisig?.multisigs) throw new Error('Waiting for a node with multisig support. Try Refresh when connected.');
            const entries = await api.query.multisig.multisigs.entries(m.address);
            if (!list.isConnected) return;
            const rows = pendingRows(entries);
            const html = pendingHtml(m, rows);
            list.innerHTML = html;
            drawn.set(list, html);
            wirePending(list, m, api, rows);
        } catch (e) { if (list.isConnected) list.textContent = errorText(e); }
    }

    const EMPTY_PENDING = '<p>No pending transactions for this multisig.</p>';
    const pendingRows = (entries) => entries.map(([key, value]) => ({ hash: key.args[1].toHex(), pending: pendingMultisig(value) })).filter(r => r.pending);
    const pendingHtml = (m, rows) => (rows.length ? rows.map(r => `<div class="multisig-pending-row" data-pending-hash="${esc(r.hash)}"><code class="multisig-address">${esc(r.hash)}</code><p>${r.pending.approvals.length} of ${m.threshold} approvals · Started at block ${esc(r.pending.when.height)}</p>
                <details class="validate-disclosure"><summary>Approvals and deposit</summary><p>Deposit: ${esc(pdex(r.pending.deposit))} · Paid by ${esc(r.pending.depositor)}</p><ul>${r.pending.approvals.map(a => `<li class="multisig-address">${esc(a)}</li>`).join('')}</ul></details>
                <button type="button" class="ui-action" data-approve="${esc(r.hash)}">${icon('bx-check-shield')}Review and approve</button>
                <button type="button" class="validate-text-btn multisig-cancel-btn" data-cancel="${esc(r.hash)}">Cancel transaction</button></div>`).join('') : EMPTY_PENDING);
    function wirePending(list, m, api, rows) {
        list.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', async () => {
            const hash = btn.dataset.approve;
            let callHex = savedCall(api, m.address, hash);
            btn.disabled = true;
            try { if (!callHex) callHex = await recoverMultisigCall(api, rows.find(r => r.hash === hash).pending, hash); }
            catch { /* Pruned blocks and hash-only approvals need a supplied preimage. */ }
            finally { btn.disabled = false; }
            if (list.isConnected) review({ multisig: m, mode: 'approve', callHash: hash, callHex });
        }));
        list.querySelectorAll('[data-cancel]').forEach(btn => btn.addEventListener('click', () => review({ multisig: m, mode: 'cancel', callHash: btn.dataset.cancel })));
    }

    // The inclusion block of a tracked transaction, from its card model (stage text and links carry it).
    const blockOf = (model) => {
        const l = model && Array.isArray(model.links) ? model.links.map(x => /^\/(?:block|tx)\/(\d+)/.exec(String(x && x.href))).find(Boolean) : null;
        const t = l || (model && /#(\d+)/.exec(String(model.stageText || '')));
        const n = t ? Number(t[1]) : NaN;
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    // R5: the pending list follows a multisig transaction of this wallet (the core's 'multisig.pending' for the
    // multisig address): re-read from the chain in place, under the node's head (freshness.chainHead). A first
    // approval changes the row's count (SET); a row this tab executed or cancelled holds its done word for T3,
    // then leaves (SETTLE, S6 or S7). Nothing else on the page is touched. Ends when the slot is replaced.
    function watchPending(el, m) {
        const old = watching.get(el);
        if (old) old();
        const c = core();
        if (!c || typeof c.subscribe !== 'function') return;
        let unsub = null;
        const stop = () => { if (unsub) { const u = unsub; unsub = null; u(); } if (watching.get(el) === stop) watching.delete(el); };
        unsub = c.subscribe('multisig.pending', {
            account: () => (watching.get(el) === stop && el.isConnected && el.querySelector('.multisig-pending-list') ? m.address : (stop(), null)),
            reload: (i) => (i && i.poll ? reloadPending(el, m, i) : null)
        });
        watching.set(el, stop);
    }
    async function reloadPending(el, m, i) {
        const list = el.querySelector('.multisig-pending-list');
        const api = getApi();
        if (!list || !list.isConnected || !api?.query.multisig?.multisigs) return null;
        let head = null;
        let timer = null;
        const read = await Promise.race([
            (async () => { try { const h = await api.rpc.chain.getHeader(); const n = h && h.number ? Number(h.number.toNumber()) : NaN; return { head: Number.isFinite(n) && n > 0 ? n : null }; } catch (e) { return { head: null }; } })(),
            new Promise(res => { timer = setTimer(() => res(null), HEAD_READ_MS); })
        ]);
        if (timer != null) { try { clearTimer(timer); } catch (e) { /* a spent timer */ } }
        if (!read) return null;   // a stalled connection: end quietly, the next trigger retries
        head = read.head;
        let rows;
        try { rows = pendingRows(await api.query.multisig.multisigs.entries(m.address)); } catch (e) { return null; }
        if (!list.isConnected || getApi() !== api) return null;
        const html = pendingHtml(m, rows);
        const children = Array.from(list.children);
        const leaving = [];
        for (const [hash, entry] of Array.from(settled)) {
            if (rows.some(r => r.hash === hash)) continue;
            // An entry is claimed only by the re-read of its own block; a later block's re-read drops it unclaimed.
            if (i.block != null && Number(i.block) !== entry.block) { if (Number(i.block) > entry.block) settled.delete(hash); continue; }
            const old = children.find(n => n.getAttribute && n.getAttribute('data-pending-hash') === hash);
            if (!old) continue;
            settled.delete(hash);
            if (i.block != null) leaving.push({ kind: entry.kind, html: old.outerHTML, index: children.indexOf(old) });
        }
        if (html !== drawn.get(list) || leaving.length) {
            const a = list.ownerDocument && list.ownerDocument.activeElement;
            const focus = a && list.contains(a) && a.getAttribute ? (a.getAttribute('data-approve') ? `[data-approve="${a.getAttribute('data-approve')}"]` : a.getAttribute('data-cancel') ? `[data-cancel="${a.getAttribute('data-cancel')}"]` : null) : null;
            list.innerHTML = html;
            drawn.set(list, html);
            wirePending(list, m, api, rows);
            for (const l of leaving) settleRow(list, l, i.block);
            const back = focus && list.querySelector(focus);
            if (back && typeof back.focus === 'function') back.focus();
        }
        return { chainHead: head };
    }
    function settleRow(list, l, block) {
        const box = list.ownerDocument.createElement('div');
        box.innerHTML = l.html;
        const row = box.firstElementChild;
        if (!row) return;
        row.querySelectorAll('button').forEach(b => b.remove());
        row.insertAdjacentHTML('beforeend', `<span class="ui-chip is-positive">${icon('bx-check')}${esc(say(l.kind === 'cancel' ? 'S7' : 'S6', { n: block }))}</span>`);
        if (!list.querySelector('.multisig-pending-row')) list.innerHTML = '';
        list.insertBefore(row, list.children[l.index] || null);
        setTimer(() => {
            row.remove();
            if (list.isConnected && !list.querySelector('.multisig-pending-row')) { list.innerHTML = EMPTY_PENDING; drawn.set(list, EMPTY_PENDING); }
        }, REFRESH_UI.settleHoldMs);
    }

    // onEnd(outcome, { stage, text }) is called once, when the review is over:
    //   'closed'    closed or replaced with nothing in flight, or the signer
    //               transaction ended without success after the close;
    //   'approved'  an approval was recorded, the call waits for other signers;
    //   'executed'  the call ran (onSuccess runs too).
    // A caller holding its own buttons releases them here: the review reports
    // no stage when it is closed or only records an approval.
    // inner (R5): the action this review was opened for ({ key, params }, script.js submitSignedTx); it travels
    // with the multisig transaction only while the call is the one the review was opened with.
    async function review({ multisig, callHex = '', callHash, mode = 'initiate', onSuccess, onStage, onEnd, inner = null }) {
        const modal = document.getElementById('multisig-review-modal');
        const content = document.getElementById('multisig-review-content');
        const generation = ++reviewGeneration;
        let busy = false, ended = false, watch = null;
        const end = (outcome, text = '') => {
            if (ended) return;
            ended = true;
            if (watch) watch.disconnect();
            if (onEnd) { try { onEnd(outcome, { stage: outcome, text }); } catch (e) { console.warn('[multisig] onEnd', e); } }
        };
        const endIfIdle = () => { if (!busy) end('closed'); };
        if (endOpenReview) endOpenReview();
        endOpenReview = endIfIdle;
        const api = getApi();
        const startAddress = selected();
        const startRevision = revision();   // the wallet session the review opened in (#70)
        const current = () => generation === reviewGeneration && modal.style.display !== 'none';
        const assertContext = () => {
            if (!sameAccount(selected(), startAddress) || !sameAccount(startAddress, multisig.address) || getApi() !== api || !store.find(multisig.address)) throw new Error('The selected wallet or network changed. Close this review and select the multisig again.');
        };
        document.querySelectorAll('.modal').forEach(el => { if (el !== modal) el.style.display = 'none'; });
        modal.style.display = 'flex';
        if (typeof MutationObserver === 'function') {
            watch = new MutationObserver(() => { if (modal.style.display === 'none') endIfIdle(); });
            watch.observe(modal, { attributes: true, attributeFilter: ['style'] });
        }
        content.innerHTML = '<p>Loading signing accounts…</p>';
        try {
            assertContext();
            if (!api) throw new Error('The blockchain connection is not ready. Try again when connected.');
            const signersOf = (list) => (list || []).filter(a => multisig.signers.some(s => sameAccount(s, a.address)));
            const accounts = signersOf(await getAccounts());
            if (!current()) return;
            if (!accounts.length && askWallets && canAskWallets()) { offerAsk(signersOf); return; }
            if (!accounts.length) throw new Error(NO_SIGNER);
            await showSigners(accounts);
        } catch (e) { if (current()) content.textContent = errorText(e); }

        // No wallet is remembered for this session's signers: ask the
        // installed wallets, on this click only.
        function offerAsk(signersOf) {
            content.innerHTML = `<p><strong>${esc(multisig.name)}</strong> <span class="ms-tag">${multisig.threshold} of ${multisig.signers.length}</span></p>
                <p>This browser has not recorded which wallet holds your signer for this multisig. Each installed wallet is asked once, and the one that holds a signer is remembered.</p>
                <button type="button" class="ui-action" id="multisig-review-ask">${icon('bx-search')}Find my signer in my wallets</button>
                <div id="multisig-review-error" class="staking-error" role="alert"></div>`;
            const btn = content.querySelector('#multisig-review-ask');
            const error = content.querySelector('[role="alert"]');
            btn.focus();
            btn.addEventListener('click', async () => {
                if (btn.disabled) return;
                btn.disabled = true;
                error.textContent = '';
                let found = [];
                try { assertContext(); found = signersOf(await askWallets(multisig.signers)); }
                catch (e) { if (current()) { error.textContent = errorText(e); btn.disabled = false; } return; }
                if (!current()) return;
                if (!found.length) { error.textContent = NO_SIGNER; btn.disabled = false; return; }
                try { await showSigners(found); } catch (e) { if (current()) content.textContent = errorText(e); }
            });
        }

        async function showSigners(accounts) {
            content.innerHTML = `<p><strong>${esc(multisig.name)}</strong> <span class="ms-tag">${multisig.threshold} of ${multisig.signers.length}</span></p><p class="multisig-address">${esc(multisig.address)}</p>
                <div class="ui-field"><label class="ui-field-label" for="multisig-review-signer">Sign with</label><select class="ui-input" id="multisig-review-signer">${accounts.map((a, i) => `<option value="${i}">${esc(a.name)} (${esc(a.source)}) · ${esc(a.address)}</option>`).join('')}</select></div>
                ${mode !== 'cancel' ? `<div class="ui-field"><label class="ui-field-label" for="multisig-review-call">Encoded call data</label><textarea class="ui-input" id="multisig-review-call" data-input-kind="hex" rows="3" spellcheck="false">${esc(callHex)}</textarea><p class="ui-field-hint">Other signers need this complete call data. Ask the proposer to copy it from their review. Its hash must match the pending transaction.</p></div>` : ''}
                <div id="multisig-review-details"></div><div id="multisig-review-error" class="staking-error" role="alert"></div>
                <div class="multisig-review-actions"><button type="button" class="validate-secondary" id="multisig-review-load">Review details and fee</button>
                <button type="button" class="validate-primary" id="multisig-review-sign" disabled>Review before signing</button></div>`;
            const signerEl = content.querySelector('select');
            const callEl = content.querySelector('textarea');
            const details = content.querySelector('#multisig-review-details');
            const error = content.querySelector('[role="alert"]');
            const sign = content.querySelector('#multisig-review-sign');
            const load = content.querySelector('#multisig-review-load');
            let prepared = null, seq = 0;
            const invalidate = () => { seq++; prepared = null; sign.disabled = true; details.textContent = ''; error.textContent = ''; };
            signerEl.addEventListener('change', invalidate);
            if (callEl) callEl.addEventListener('input', invalidate);
            signerEl.focus();
            const args = () => ({ api, multisig, signer: accounts[Number(signerEl.value)].address, callHex: callEl?.value.trim(), callHash, mode });
            async function loadReview() {
                invalidate();
                const n = seq;
                load.disabled = true;
                try {
                    assertContext();
                    const p = await prepareMultisig(args());
                    if (!current() || n !== seq) return;
                    assertContext();
                    prepared = p;
                    let note = '';
                    if (callNote && p.call) { try { note = (await callNote(api, p.call, multisig)) || ''; } catch { note = ''; } }
                    if (!current() || n !== seq) return;
                    const action = p.kind === 'execute' ? 'Execute transaction' : p.kind === 'cancel' ? 'Cancel transaction' : 'Record approval';
                    sign.textContent = action + ' in wallet';
                    details.innerHTML = `<h4>${esc(action)}</h4><p>${p.kind === 'approve' ? 'This records your approval. The underlying transaction will run only after enough signers approve and someone executes it.' : p.kind === 'execute' ? 'This can execute the call from the multisig wallet immediately.' : 'This removes the pending transaction and returns its deposit to the original depositor.'}</p>
                        <p>Estimated signer fee: <strong>${esc(pdex(p.fee))}</strong><br>New refundable signer deposit: <strong>${esc(pdex(p.deposit))}</strong></p><p>The selected individual signer pays the fee and any new deposit. The multisig pays amounts transferred by the underlying call.</p>
                        ${note ? `<p class="multisig-note" role="note">${esc(note)}</p>` : ''}
                        <p>Network genesis: <code class="multisig-address">${esc(p.genesis)}</code></p>
                        <p>Call hash: <code class="multisig-address">${esc(p.callHash)}</code></p>
                        ${p.call ? `<h4>Call to run</h4>${renderCallHtml(callToTree(p.call), {})}<button type="button" class="validate-secondary" id="multisig-copy-call">${icon('bx-copy')}<span class="copy-word">Copy call data for other signers</span></button>` : ''}`;
                    const copy = details.querySelector('#multisig-copy-call');
                    if (copy) copy.addEventListener('click', async () => {
                        try { await navigator.clipboard.writeText(p.callHex); const word = copy.querySelector('.copy-word'); if (word) word.textContent = 'Copied call data'; else copy.textContent = 'Copied call data'; }
                        catch { callEl.focus(); callEl.select(); error.textContent = 'Copy the selected call data from the text box.'; }
                    });
                    sign.disabled = false;
                } catch (e) { if (current() && n === seq) error.textContent = errorText(e); }
                finally { if (current()) load.disabled = false; }
            }
            load.addEventListener('click', loadReview);
            sign.addEventListener('click', async () => {
                if (!prepared || busy) return;
                busy = true;
                sign.disabled = true; load.disabled = true; signerEl.disabled = true;
                if (callEl) callEl.disabled = true;
                const approvedReview = prepared;
                const chosen = accounts[Number(signerEl.value)];
                const request = args();
                let lastModel = null;
                const innerAction = inner && typeof inner.key === 'string' && callHex && request.callHex && String(request.callHex).toLowerCase() === String(callHex).toLowerCase()
                    ? { key: inner.key, params: inner.params || {} } : null;
                try {
                    assertContext();
                    await submit({
                        signingAccount: chosen, multisigHandled: true, expectedWallet: startAddress, expectedRevision: startRevision,
                        buildTx: async () => {
                            assertContext();
                            const fresh = await prepareMultisig(request);
                            assertContext();
                            if (!current()) throw new Error('The multisig review was closed. Nothing was sent.');
                            if (fresh.fingerprint !== approvedReview.fingerprint || BigInt(fresh.fee) > BigInt(approvedReview.fee) * 110n / 100n) throw new Error('Approvals, runtime, or fee changed. Review details again before signing.');
                            if (callGuard && fresh.kind === 'execute' && fresh.call) {
                                const problems = await callGuard(api, fresh.call, multisig);
                                assertContext();
                                if (problems && problems.length) throw new Error('The explorer checked this call again before this approval runs it: ' + problems.join(' '));
                            }
                            if (fresh.callHex) {
                                try { storage.setItem(cacheKey(api, multisig.address, fresh.callHash), JSON.stringify({ hex: fresh.callHex, specVersion: fresh.specVersion })); }
                                catch { /* full calldata remains available to copy from the review */ }
                            }
                            return fresh.tx;
                        },
                        label: 'Multisig transaction', action: { key: 'multisig.transaction', params: { kind: approvedReview.kind, threshold: approvedReview.multisig.threshold, multisig: multisig.address, callHash: approvedReview.callHash, ...(innerAction ? { inner: innerAction } : {}) } },
                        button: sign, idleText: sign.textContent,
                        onError: text => { error.textContent = text; prepared = null; sign.disabled = true; },
                        onStage: (stage, model) => {
                            if (stage === 'inBlock' || stage === 'unconfirmed') lastModel = model;
                            if (onStage) onStage(stage, model);
                            if (stage === 'failed' && model && model.outcome && model.outcome.executed === 'err') {
                                // The call ran and failed: the chain removed the pending row. Re-read the list, claim nothing.
                                const slot = slots.get(multisig.address);
                                if (slot && slot.isConnected) reloadPending(slot, multisig, {}).catch(() => {});
                            }
                            if (['finalized', 'failed', 'cancelled', 'unconfirmed', 'waiting', 'stalled'].includes(stage)) {
                                busy = false; load.disabled = false; signerEl.disabled = false; if (callEl) callEl.disabled = false;
                                if (!current()) end('closed');
                            }
                            if (['unconfirmed', 'waiting', 'stalled'].includes(stage)) {
                                prepared = null; sign.disabled = true;
                                error.textContent = 'Submission is not confirmed. Check its status and refresh pending transactions before signing again.';
                            }
                        },
                        onSuccess: () => {
                            const kind = approvedReview.kind;
                            const o = lastModel && lastModel.outcome;
                            const block = blockOf(lastModel);
                            const confirmed = !!o && block != null && (kind === 'execute'
                                ? o.executed === 'ok' || (Number(approvedReview.multisig.threshold) === 1 && o.executed == null && !o.approvalRecorded)
                                : kind === 'cancel' && o.multisigEvent === true && !o.approvalRecorded && o.executed == null);
                            if (confirmed && approvedReview.callHash) {
                                settled.set(approvedReview.callHash, { kind, block });
                                while (settled.size > 20) settled.delete(settled.keys().next().value);
                            }
                            end(kind === 'execute' ? 'executed' : kind === 'approve' ? 'approved' : 'closed',
                                kind === 'approve' ? 'Approval submitted; waiting for the other signers.' : '');
                            modal.style.display = 'none';
                            if (onSuccess && kind === 'execute') onSuccess();
                            // R5: with the core, the block's effects reload what changed; no whole-wallet remount.
                            if (!core()) refresh(multisig.address);
                        }
                    });
                } catch (e) { error.textContent = errorText(e); prepared = null; busy = false; }
                finally {
                    // send() resolves after subscription setup, before inclusion.
                    // Keep the review locked until the lifecycle reports a result.
                    if (sign.disabled && !prepared) busy = false;
                    if (!busy) { load.disabled = false; signerEl.disabled = false; if (callEl) callEl.disabled = false; }
                    if (!busy && !current()) end('closed');
                }
            });
            if (callHex || mode === 'cancel') await loadReview();
        }
    }
    return { mountAccounts, mountPending, review };
}
