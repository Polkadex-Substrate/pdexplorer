// Discussion board: direct links to a single post.
//
// Permalink format: /discussions/<threadId>?post=<postId>
//   - The path is the thread's existing route, so old links keep working.
//   - The post rides in the query string, the same convention as
//     /treasury?proposal=85 and /chain-state?pallet=..: routeTo() strips the
//     query before matching, and the page reads it after it has loaded.
//   - Not a #fragment: the SPA's hashchange listener routes any fragment that
//     is not an element id ON THE PAGE AT THAT MOMENT, and posts arrive async,
//     so a fragment could navigate away before the post exists. #post-<id> is
//     still honoured on load (every post carries that id) for hand-made links.
//
// Lives here, not in script.js, because script.js is capped at 15,000 lines
// (test/help-topics.test.js). Nothing here touches a global: document,
// navigator, timers and the clipboard are passed in, so the tests drive the
// real code with small fakes.

export const LINKED_CLASS = 'discussion-post-linked';

export function postPermalink(origin, threadId, postId) {
    const id = Number(postId);
    if (!threadId || !Number.isInteger(id) || id <= 0) return '';
    return String(origin || '').replace(/\/+$/, '') + '/discussions/' + encodeURIComponent(threadId) + '?post=' + id;
}

// ?post=N wins; #post-N is the fallback. Anything that is not a plain positive
// integer is ignored rather than guessed at.
export function readLinkedPostId(search, hash) {
    let raw = null;
    try { raw = new URLSearchParams(search || '').get('post'); } catch (_) { raw = null; }
    if (raw == null || raw === '') {
        const m = /^#post-(\d+)$/.exec(String(hash || ''));
        raw = m ? m[1] : null;
    }
    if (raw == null || !/^\d{1,15}$/.test(String(raw))) return null;
    const n = Number(raw);
    return n > 0 ? n : null;
}

export function renderCopyLinkButton(post) {
    const id = Number(post && post.id);
    if (!Number.isInteger(id) || id <= 0) return '';
    return ` <button type="button" class="discussion-link-btn" data-copy-post="${id}" title="Copy a direct link to this comment" aria-label="Copy link to this comment" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.75rem;padding:0 4px;"><i class='bx bx-link'></i> Copy link</button><span class="discussion-link-feedback" role="status" aria-live="polite" style="color:var(--success);font-size:0.72rem;"></span>`;
}

// Clipboard API first; the hidden-textarea + execCommand fallback covers http
// origins and older browsers where navigator.clipboard is missing or refuses.
// Resolves true when the text is (as far as the browser says) on the clipboard.
export async function copyText(text, env) {
    const nav = env && env.navigator;
    const doc = env && env.document;
    try {
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
            await nav.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* fall through to the fallback */ }
    if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    let ok = false;
    try { ta.select(); ok = !!doc.execCommand('copy'); } catch (_) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
}

// deps: { threadId, origin, env: { navigator, document }, setTimeout, clearTimeout }
export function wirePermalinks(root, deps) {
    if (!root) return;
    const later = deps.setTimeout || setTimeout;
    const cancel = deps.clearTimeout || clearTimeout;
    root.querySelectorAll('[data-copy-post]').forEach(btn => {
        let timer = null;
        btn.addEventListener('click', async () => {
            const url = postPermalink(deps.origin, deps.threadId, btn.getAttribute('data-copy-post'));
            const fb = btn.nextElementSibling;
            if (!url || !fb) return;
            const ok = await copyText(url, deps.env);
            cancel(timer);
            if (ok) {
                fb.style.color = 'var(--success)';
                fb.textContent = 'Link copied';
                timer = later(() => { fb.textContent = ''; }, 2500);
            } else {
                // Could not reach the clipboard: show the link so it can be copied by hand.
                fb.style.color = 'var(--text-secondary)';
                fb.textContent = 'Copy this link: ' + url;
            }
        });
    });
}

// Scroll to and highlight the linked post. Returns 'none' (no link in the
// URL), 'found', or 'missing'. A missing post (removed, wrong thread, typo)
// gets an inline notice at the top of the thread instead of a silent no-op.
export function focusLinkedPost(root, postId, deps = {}) {
    if (!root || !postId) return 'none';
    const el = root.querySelector('.discussion-post[data-post-id="' + Number(postId) + '"]');
    if (el) {
        el.classList.add(LINKED_CLASS);
        el.setAttribute('tabindex', '-1');
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: deps.smooth ? 'smooth' : 'auto', block: 'center' });
        if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (_) { /* old browsers */ } }
        return 'found';
    }
    const list = root.querySelector('.discussion-posts');
    if (list && deps.document && !root.querySelector('.discussion-link-missing')) {
        const note = deps.document.createElement('div');
        note.className = 'discussion-link-missing';
        note.setAttribute('role', 'status');
        note.textContent = 'The linked comment (#' + Number(postId) + ') is not in this discussion. It may have been removed, or the link may be incomplete.';
        list.insertBefore(note, list.firstChild);
    }
    return 'missing';
}
