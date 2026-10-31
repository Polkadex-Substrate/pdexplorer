import { escapeHtml as esc } from './html-escape.js';
import { sameAccount, prepareMultisig, pendingMultisig, recoverMultisigCall } from './multisig.js';
import { discoverMultisigs } from './multisig-discovery.js';

const pdex = value => {
    const n = BigInt(value);
    return `${n / 1000000000000n}.${(n % 1000000000000n).toString().padStart(12, '0').replace(/0+$/, '') || '0'} PDEX`;
};
const errorText = e => e?.message || 'Could not load multisig data. Please retry.';

export function createMultisigUI({ store, storage, api: getApi, accounts: getAccounts, selected, select, submit, refresh, fetchJson }) {
    let reviewGeneration = 0;
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
        if (!api) return Promise.reject(new Error('Waiting for a node connection. Retry when connected.'));
        let cache = discoveryCache.get(api);
        if (!cache) { cache = new Map(); discoveryCache.set(api, cache); }
        const previous = cache.get(address);
        if (previous && (previous.running || (!retry && Date.now() - previous.at < 60000))) return previous.promise;
        const controller = new AbortController();
        const entry = { at: Date.now(), running: true };
        let timer;
        entry.promise = Promise.race([
            discoverMultisigs({ api, address, fetchJson, signal: controller.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => {
                controller.abort(); reject(new Error('Discovery timed out. Retry, or add the multisig manually.'));
            }, 30000); })
        ]).finally(() => { clearTimeout(timer); entry.running = false; }).catch(e => { cache.delete(address); throw e; });
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
        cache.set(address, entry);
        return entry.promise;
    }

    function mountAccounts(el, { address = selected(), relatedOnly = false, retry = false } = {}) {
        if (!el) return;
        const token = {};
        mounts.set(el, token);
        const startSelected = selected(), api = getApi();
        const rows = store.list().filter(m => !relatedOnly || m.signers.some(a => sameAccount(a, address)));
        const canDiscover = !!address && !store.find(address) && !!fetchJson;
        const mounted = () => el.isConnected && mounts.get(el) === token && selected() === startSelected;
        const current = () => mounted() && getApi() === api;
        el.innerHTML = `<section class="multisig-panel">
            <h3>Multisig wallets</h3>
            <p>Select an individual account to find multisigs in its recent indexed activity. Open a wallet below to view its balance, send PDEX, or approve a pending transaction.</p>
            <p class="multisig-discovery-note"><strong>Discovery limits:</strong> Older or unindexed activity, unused wallets, and multisigs where this signer has never participated may still need manual import. Use <strong>Add an existing multisig</strong> below if your wallet is not listed.</p>
            <div class="multisig-discovery-status" role="status">${canDiscover ? 'Looking for multisigs in this account’s recent activity…' : 'Saved wallets are available below. You can also add a wallet manually.'}</div>
            ${canDiscover ? '<button type="button" class="staking-download-btn multisig-discover" disabled>Refresh discovery</button>' : ''}
            <div class="multisig-saved-list"></div>
            <details><summary>Add an existing multisig</summary>
                <form class="multisig-import">
                    <label>Wallet name<input name="name" maxlength="80" placeholder="Team wallet" required></label>
                    <label>Existing multisig address<input name="address" required autocomplete="off" spellcheck="false" placeholder="Paste the multisig wallet address"></label>
                    <label>All signer addresses<textarea name="signers" required rows="4" spellcheck="false" placeholder="One address per line, including your own signer"></textarea></label>
                    <label>Approvals required<input name="threshold" type="number" min="1" max="100" step="1" value="2" required></label>
                    <p>We check that these signers and threshold reproduce your wallet address. No transaction is sent when you add it.</p>
                    <div class="staking-error multisig-error" role="alert"></div>
                    <button class="staking-download-btn" type="submit">Add multisig wallet</button>
                </form>
            </details>
        </section>`;
        const renderRows = discovered => {
            const all = new Map(discovered.map(m => [m.address, m]));
            for (const m of rows) all.set(m.address, m); // Preserve saved names.
            const list = el.querySelector('.multisig-saved-list');
            list.innerHTML = [...all.values()].map(m => `<button type="button" class="wallet-account-btn" data-multisig="${esc(m.address)}"><span class="wallet-account-name">${esc(m.name)} · ${m.threshold}-of-${m.signers.length}</span><span class="wallet-account-addr">${esc(m.address)}${sameAccount(selected(), m.address) ? ' · Selected' : ''}</span><span>Open wallet</span></button>`).join('');
            list.querySelectorAll('[data-multisig]').forEach(btn => btn.addEventListener('click', () => {
                if (!mounted()) return;
                try {
                    const m = store.find(btn.dataset.multisig) || store.save(all.get(btn.dataset.multisig));
                    select(m.address, 'multisig');
                } catch (e) { el.querySelector('.multisig-discovery-status').textContent = errorText(e); }
            }));
        };
        renderRows([]);
        if (canDiscover) {
            const status = el.querySelector('.multisig-discovery-status');
            const button = el.querySelector('.multisig-discover');
            button.addEventListener('click', () => mountAccounts(el, { address, relatedOnly, retry: true }));
            search(api, address, retry).then(result => {
                if (!current()) return;
                renderRows(result.wallets);
                status.textContent = `${result.wallets.length ? `Found ${result.wallets.length} multisig wallet(s).` : 'No multisigs found in the activity checked.'} Checked ${result.scannedEvents} recent indexed events.${result.limited ? ' The search limit was reached.' : ''}${result.unavailableBlocks ? ' Some historical blocks were unavailable or changed.' : ''}`;
            }).catch(e => { if (current()) status.textContent = errorText(e); })
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
            } catch (err) { form.querySelector('[role="alert"]').textContent = errorText(err); }
        });
    }

    async function mountPending(el, multisig) {
        if (!el) return;
        const m = store.find(multisig.address);
        if (!m) return;
        el.innerHTML = `<section class="multisig-panel"><h3>${esc(m.name)} · ${m.threshold}-of-${m.signers.length}</h3>
            <ol class="multisig-steps"><li><strong>Start:</strong> choose <strong>Send PDEX</strong> above, then enter the recipient and amount. Staking and governance actions work with this wallet too.</li><li><strong>Review and sign:</strong> choose your individual signer, check the transaction, and approve in your wallet extension. The signer pays the fee and any refundable multisig deposit.</li><li><strong>Other signers:</strong> open this multisig, then review and approve the pending transaction below. The final required approval executes it.</li></ol>
            <details><summary>Signer addresses</summary><ul>${m.signers.map(a => `<li class="multisig-address">${esc(a)}</li>`).join('')}</ul></details>
            <h4>Pending multisig transactions</h4><button type="button" class="staking-download-btn multisig-refresh">Refresh pending transactions</button>
            <div class="multisig-pending-list" aria-live="polite">Loading pending transactions…</div>
            <details><summary>Start a transaction from encoded call data</summary><textarea class="multisig-new-call" aria-label="Encoded call data" rows="3" spellcheck="false" placeholder="0x…"></textarea><button type="button" class="staking-download-btn multisig-new">Review transaction</button></details></section>`;
        el.querySelector('.multisig-refresh').addEventListener('click', () => mountPending(el, m));
        el.querySelector('.multisig-new').addEventListener('click', () => review({ multisig: m, callHex: el.querySelector('.multisig-new-call').value.trim() }));
        const list = el.querySelector('.multisig-pending-list');
        try {
            const api = getApi();
            if (!api?.query.multisig?.multisigs) throw new Error('Waiting for a node with multisig support. Try Refresh when connected.');
            const entries = await api.query.multisig.multisigs.entries(m.address);
            if (!list.isConnected) return;
            const rows = entries.map(([key, value]) => ({ hash: key.args[1].toHex(), pending: pendingMultisig(value) })).filter(r => r.pending);
            list.innerHTML = rows.length ? rows.map(r => `<div class="multisig-pending-row"><code class="multisig-address">${esc(r.hash)}</code><p>${r.pending.approvals.length} of ${m.threshold} approvals · Started at block ${esc(r.pending.when.height)}</p>
                <details><summary>Approvals and deposit</summary><p>Deposit: ${esc(pdex(r.pending.deposit))} · Paid by ${esc(r.pending.depositor)}</p><ul>${r.pending.approvals.map(a => `<li class="multisig-address">${esc(a)}</li>`).join('')}</ul></details>
                <button type="button" class="staking-download-btn" data-approve="${esc(r.hash)}">Review / approve / execute</button>
                <button type="button" class="staking-download-btn" data-cancel="${esc(r.hash)}">Cancel transaction</button></div>`).join('') : '<p>No pending transactions for this multisig.</p>';
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
        } catch (e) { if (list.isConnected) list.textContent = errorText(e); }
    }

    async function review({ multisig, callHex = '', callHash, mode = 'initiate', onSuccess, onStage }) {
        const modal = document.getElementById('multisig-review-modal');
        const content = document.getElementById('multisig-review-content');
        const generation = ++reviewGeneration;
        const api = getApi();
        const startAddress = selected();
        const current = () => generation === reviewGeneration && modal.style.display !== 'none';
        const assertContext = () => {
            if (!sameAccount(selected(), startAddress) || !sameAccount(startAddress, multisig.address) || getApi() !== api || !store.find(multisig.address)) throw new Error('The selected wallet or network changed. Close this review and select the multisig again.');
        };
        document.querySelectorAll('.modal').forEach(el => { if (el !== modal) el.style.display = 'none'; });
        modal.style.display = 'flex';
        content.innerHTML = '<p>Loading signing accounts…</p>';
        try {
            assertContext();
            if (!api) throw new Error('The blockchain connection is not ready. Try again when connected.');
            const accounts = (await getAccounts() || []).filter(a => multisig.signers.some(s => sameAccount(s, a.address)));
            if (!current()) return;
            if (!accounts.length) throw new Error('No signer is shared by your wallet extension. Connect an individual signer for this multisig and try again.');
            content.innerHTML = `<p><strong>${esc(multisig.name)}</strong> · ${multisig.threshold}-of-${multisig.signers.length}</p><p class="multisig-address">${esc(multisig.address)}</p>
                <label>Sign with<select id="multisig-review-signer">${accounts.map((a, i) => `<option value="${i}">${esc(a.name)} (${esc(a.source)}) · ${esc(a.address)}</option>`).join('')}</select></label>
                ${mode !== 'cancel' ? `<label>Encoded call data<textarea id="multisig-review-call" rows="3" spellcheck="false">${esc(callHex)}</textarea></label><p>Other signers need this complete call data. Ask the proposer to copy it from their review. Its hash must match the pending transaction.</p>` : ''}
                <div id="multisig-review-details"></div><div id="multisig-review-error" class="staking-error" role="alert"></div>
                <button type="button" class="staking-download-btn" id="multisig-review-load">Review details and fee</button>
                <button type="button" class="staking-download-btn" id="multisig-review-sign" disabled>Review before signing</button>`;
            const signerEl = content.querySelector('select');
            const callEl = content.querySelector('textarea');
            const details = content.querySelector('#multisig-review-details');
            const error = content.querySelector('[role="alert"]');
            const sign = content.querySelector('#multisig-review-sign');
            const load = content.querySelector('#multisig-review-load');
            let prepared = null, seq = 0, busy = false;
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
                    const action = p.kind === 'execute' ? 'Execute transaction' : p.kind === 'cancel' ? 'Cancel transaction' : 'Record approval';
                    sign.textContent = action + ' in wallet';
                    details.innerHTML = `<h4>${esc(action)}</h4><p>${p.kind === 'approve' ? 'This records your approval. The underlying transaction will run only after enough signers approve and someone executes it.' : p.kind === 'execute' ? 'This can execute the call from the multisig wallet immediately.' : 'This removes the pending transaction and returns its deposit to the original depositor.'}</p>
                        <p>Estimated signer fee: <strong>${esc(pdex(p.fee))}</strong><br>New refundable signer deposit: <strong>${esc(pdex(p.deposit))}</strong></p><p>The selected individual signer pays the fee and any new deposit. The multisig pays amounts transferred by the underlying call.</p>
                        <p>Network genesis: <code class="multisig-address">${esc(p.genesis)}</code></p>
                        <p>Call hash: <code class="multisig-address">${esc(p.callHash)}</code></p>
                        ${p.call ? `<h4>${esc(p.call.section)}.${esc(p.call.method)}</h4><p>Decoded arguments (amounts are base units unless a unit is shown; 1 PDEX = 1,000,000,000,000 base units):</p><pre>${esc(JSON.stringify(p.call.toHuman(), null, 2))}</pre><button type="button" class="staking-download-btn" id="multisig-copy-call">Copy call data for other signers</button>` : ''}`;
                    const copy = details.querySelector('#multisig-copy-call');
                    if (copy) copy.addEventListener('click', async () => {
                        try { await navigator.clipboard.writeText(p.callHex); copy.textContent = 'Copied call data'; }
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
                try {
                    assertContext();
                    await submit({
                        signingAccount: chosen, multisigHandled: true, expectedWallet: startAddress,
                        buildTx: async () => {
                            assertContext();
                            const fresh = await prepareMultisig(request);
                            assertContext();
                            if (!current()) throw new Error('The multisig review was closed. Nothing was sent.');
                            if (fresh.fingerprint !== approvedReview.fingerprint || BigInt(fresh.fee) > BigInt(approvedReview.fee) * 110n / 100n) throw new Error('Approvals, runtime, or fee changed. Review details again before signing.');
                            if (fresh.callHex) {
                                try { storage.setItem(cacheKey(api, multisig.address, fresh.callHash), JSON.stringify({ hex: fresh.callHex, specVersion: fresh.specVersion })); }
                                catch { /* full calldata remains available to copy from the review */ }
                            }
                            return fresh.tx;
                        },
                        label: 'Multisig transaction', action: { key: 'multisig.transaction', params: { kind: approvedReview.kind } },
                        button: sign, idleText: sign.textContent,
                        onError: text => { error.textContent = text; prepared = null; sign.disabled = true; },
                        onStage: (stage, model) => {
                            if (onStage) onStage(stage, model);
                            if (['finalized', 'failed', 'cancelled', 'unconfirmed', 'waiting', 'stalled'].includes(stage)) { busy = false; load.disabled = false; signerEl.disabled = false; if (callEl) callEl.disabled = false; }
                            if (['unconfirmed', 'waiting', 'stalled'].includes(stage)) {
                                prepared = null; sign.disabled = true;
                                error.textContent = 'Submission is not confirmed. Check its status and refresh pending transactions before signing again.';
                            }
                        },
                        onSuccess: () => {
                            modal.style.display = 'none';
                            if (onSuccess && approvedReview.kind === 'execute') onSuccess();
                            refresh(multisig.address);
                        }
                    });
                } catch (e) { error.textContent = errorText(e); prepared = null; busy = false; }
                finally {
                    // send() resolves after subscription setup, before inclusion.
                    // Keep the review locked until the lifecycle reports a result.
                    if (sign.disabled && !prepared) busy = false;
                    if (!busy) { load.disabled = false; signerEl.disabled = false; if (callEl) callEl.disabled = false; }
                }
            });
            if (callHex || mode === 'cancel') await loadReview();
        } catch (e) { if (current()) content.textContent = errorText(e); }
    }
    return { mountAccounts, mountPending, review };
}
