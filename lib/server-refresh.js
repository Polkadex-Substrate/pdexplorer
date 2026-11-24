// R6 of the post-action refresh (design cto-team/plans/2026-11-22-post-action-refresh-design.md, sections 3
// rows 31 to 40, 4 "Second tab" and 9 "R6"; UX cto-team/plans/2026-11-22-post-action-refresh-ux.md U5, U10).
// The server actions: account labels (save, delete, vote, report, veto), discussion posts and edits, and the
// discussion sign-in. Once the SERVER confirmed one (its response, never a timer), script.js calls labels(),
// thread() or signedIn(); the core (lib/post-action.js server()) tells this tab's components and leaves a
// notice for the other open tabs, which update silently, for the same account only and only while signed in
// as the address that made it. A failed request calls nothing, so nothing new shows anywhere.
//
// What follows here, in every tab:
//   labels:     the account page's label editor (#account-label-editor, data-address) and every label pill
//               of that address (.address-with-label[data-address]): caches dropped, editor redrawn, pill
//               redrawn or removed. An editor whose field the reader changed is not redrawn (U5); the pills are.
//   discussion: every thread pane drawn for that thread (threadShown registers it), re-read quietly (no
//               "Loading" paint); the pane that drew the server's response itself is skipped; a pane with
//               text being written or an edit open is not redrawn (U5).
//   alerts:     nothing draws a follow's state (the confirmation is by email), so validator-alerts-view only
//               notifies this tab; no notice is written (no browser record of a follow).
// Import-free; the DOM is the document it is given.

// The inline label pill (moved from script.js applyAddressLabelToDom, unchanged): every container that opted
// in via class="address-with-label" data-address="<addr>" gets one pill with the top label.
export function applyAddressLabel(doc, address, top) {
    if (!doc || !address || !top || !top.label) return;
    doc.querySelectorAll(`.address-with-label[data-address="${cssEscape(doc, address)}"]`).forEach(node => {
        const existing = node.querySelector('.addr-label');
        if (existing) existing.remove();
        const tag = doc.createElement('span');
        tag.className = 'addr-label' + (top.isSelf ? '' : ' community');
        tag.textContent = top.label;
        tag.title = top.isSelf
            ? 'Self-set label (signed by the address owner)'
            : 'Community-suggested label · click the address to see other suggestions';
        node.insertBefore(tag, node.firstChild);
    });
}

function cssEscape(doc, s) {
    const css = (doc && doc.defaultView && doc.defaultView.CSS) || (typeof CSS !== 'undefined' ? CSS : null);
    if (css && typeof css.escape === 'function') return css.escape(String(s));
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// deps: { doc, post (the core), session() -> signed-in address or null, same(a, b),
//         labels: { invalidate(a), top(a) -> Promise<{label, signer, isSelf}|null>, editor(a) },
//         threads: { load(id, root, opts) -> Promise } }
export function createServerRefresh({ doc, post, session = () => null, same = (a, b) => a === b, labels = {}, threads = {} } = {}) {
    const safe = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (e) { return undefined; } };
    const eq = (a, b) => a != null && b != null && (a === b || !!safe(same, a, b));
    const shown = new Map();   // thread pane root -> { id, opts }
    const editor = () => doc && doc.getElementById('account-label-editor');
    const pills = (a) => (doc ? Array.from(doc.querySelectorAll(`.address-with-label[data-address="${cssEscape(doc, a)}"]`)) : []);
    const editing = (root) => {
        const input = root && root.querySelector('#account-label-input');
        if (input && input.value !== input.defaultValue) return true;
        const act = doc && doc.activeElement;
        return !!(act && root && root.contains(act) && /^(INPUT|TEXTAREA|SELECT)$/.test(act.tagName));
    };
    const writing = (root) => !!root.querySelector('.discussion-edit-form')
        || Array.from(root.querySelectorAll('textarea')).some(t => String(t.value || '').trim() !== '');
    const editorFor = () => { const el = editor(); return el && el.isConnected && el.dataset.address ? el.dataset.address : null; };

    // own: this tab made the change, so its editor is redrawn as before (the submitted field included); another
    // tab's change never replaces a field the reader changed here (U5).
    async function reloadLabels(a, own) {
        if (!a) return;
        safe(labels.invalidate, a);
        const el = editor();
        if (el && eq(el.dataset.address, a) && (own || !editing(el))) safe(labels.editor, a);
        if (!pills(a).length) return;
        let top = null;
        try { top = await labels.top(a); } catch (e) { top = null; }
        if (top && top.label) applyAddressLabel(doc, a, top);
        else pills(a).forEach(n => { const p = n.querySelector('.addr-label'); if (p) p.remove(); });
    }

    const subs = [];
    if (post && typeof post.subscribe === 'function') {
        subs.push(post.subscribe(['labels'], {
            // hint: the account a notice is for; this component shows it when the editor or a pill draws it.
            account: (hint) => {
                if (hint != null) return (eq(editorFor(), hint) || pills(hint).length) ? hint : null;
                return editorFor();
            },
            reload: ({ account, origin } = {}) => reloadLabels(account != null ? account : editorFor(), origin !== 'other-tab')
        }));
        subs.push(post.subscribe(['discussion'], {
            account: (hint) => {
                for (const [root, s] of Array.from(shown)) if (!root.isConnected) shown.delete(root);
                const ids = Array.from(shown.values()).map(s => s.id);
                if (hint != null) return ids.includes(String(hint)) ? hint : null;
                return ids[0] || null;
            },
            reload: ({ account, info } = {}) => {
                const drawn = info && info.drawn;
                const runs = [];
                for (const [root, s] of Array.from(shown)) {
                    if (!root.isConnected) { shown.delete(root); continue; }
                    if (account != null && s.id !== String(account)) continue;
                    if (root === drawn || writing(root)) continue;
                    runs.push(Promise.resolve(safe(threads.load, s.id, root, { ...s.opts, quiet: true })).catch(() => null));
                }
                return Promise.all(runs).then(() => null);
            }
        }));
    }
    const who = () => { const s = safe(session); return s == null ? null : s; };
    const server = (o) => { if (post && typeof post.server === 'function') safe(() => post.server(o)); };

    return {
        // The server confirmed a label write for this address (save, delete, vote, report, veto).
        labels(address) { if (address) server({ account: address, domains: ['labels'], who: who() }); },
        // The server confirmed a post or an edit in this thread; root already drew its response.
        thread(id, root = null) { if (id != null) server({ account: String(id), domains: ['discussion'], who: who(), info: { drawn: root } }); },
        // A discussion sign-in: the other tabs' label editors offer the form instead of "Sign in". This tab
        // already redraws where it signed in.
        signedIn(address) { if (address) server({ domains: ['labels'], who: address, local: false }); },
        // renderThread drew this thread into root (opts: how to draw it again).
        threadShown(root, id, opts = {}) { if (root && id != null) shown.set(root, { id: String(id), opts: { ...opts, earlier: undefined } }); },
        stop() { subs.forEach(u => safe(u)); }
    };
}
