// Discussion board: authors can edit their own posts.
//
// One module for both sides so the rules cannot drift apart. The server route
// calls applyEdit(); the browser calls canEdit / isEdited / renderPostHtml /
// wireEditing. script.js is capped at 15,000 lines by test/help-topics.test.js,
// which is why the UI lives here and not inline there.
//
// Nothing in this file touches a global. Everything environmental (database,
// rate gate, address comparison, escaping, fetch, clock) is passed in, so the
// tests exercise the real code against a real SQLite file and a fake DOM-free
// harness.

import { renderMarkdown } from './discussion-markdown.js';
import { composerHtml, wireComposer } from './discussion-composer.js';

export const MAX_POST_LEN = 4000;

// The server stores post.author as the prefix-88 address the session was created
// with; the browser's own address may be any SS58 prefix. `same` is the caller's
// canonical comparison (isSameAddress in the browser, normalizeAddress equality
// on the server). A comparison that throws counts as "not the same".
function safeSame(same, a, b) {
    if (!a || !b) return false;
    try { return !!same(a, b); } catch (_) { return false; }
}

// Is this post editable by the signed-in address, on this thread, right now?
// Display-only on the client; the server re-checks everything.
export function canEdit(post, thread, address, same) {
    if (!post || !thread || !address) return false;
    if (thread.status === 'closed') return false;
    return safeSame(same, post.author, address);
}

export function isEdited(post) {
    return !!(post && Number.isFinite(Number(post.editedAt)) && Number(post.editedAt) > 0);
}

// Same trim / empty / length rules as the create route.
export function validateContent(raw) {
    const content = (typeof raw === 'string' ? raw : '').trim();
    if (!content) return { error: 'Post content is required.' };
    if (content.length > MAX_POST_LEN) return { error: 'Post is too long (4000 character limit).' };
    return { content };
}

// PATCH /api/discussions/:threadId/posts/:postId, minus Express.
//   ctx: { db, address, threadId, postId, body, same, gate(address) -> {allowed, retryAfterMs}, now }
// Returns { status, json, headers? }. Order matters: cheap authorization and
// validation first, the rate-limit write last, so refused requests cost nothing.
export function applyEdit(ctx) {
    const { db, address, threadId, postId, body, same, gate } = ctx;
    const now = ctx.now ? ctx.now() : Date.now();
    if (!address) return { status: 401, json: { error: 'Sign in with your wallet to edit.' } };
    const thread = db.getThread(threadId);
    if (!thread) return { status: 404, json: { error: 'Discussion thread not found.' } };
    const idText = String(postId == null ? '' : postId);
    const post = /^\d{1,15}$/.test(idText) ? db.getPost(Number(idText)) : null;
    // A post that exists in ANOTHER thread is reported as missing, so the route
    // cannot be used to probe which post ids exist elsewhere.
    if (!post || post.threadId !== thread.id) return { status: 404, json: { error: 'Post not found.' } };
    if (!safeSame(same, post.author, address)) return { status: 403, json: { error: 'You can only edit your own posts.' } };
    if (thread.status === 'closed') return { status: 403, json: { error: 'This discussion is closed.' } };

    const v = validateContent(body && body.content);
    if (v.error) return { status: 400, json: { error: v.error } };

    const respond = () => ({ status: 200, json: { thread: db.getThread(thread.id), posts: db.getPosts(thread.id) } });
    // Saving identical text is a no-op: no edited tag, and it does not spend the
    // author's rate-limit slot.
    if (v.content === post.content) return respond();

    const g = gate(address);
    if (!g.allowed) {
        return {
            status: 429,
            headers: { 'Retry-After': String(Math.ceil((g.retryAfterMs || 0) / 1000) || 1) },
            json: { error: 'You are editing too quickly - please wait a moment.' }
        };
    }
    db.updatePostContent(post.id, v.content, now);
    return respond();
}

// ---- browser side ---------------------------------------------------------

// One post. The content is raw Markdown as stored; renderMarkdown
// (lib/discussion-markdown.js) escapes it and builds only whitelisted tags.
// `esc` is the page's stakingEscapeHtml for everything else interpolated here,
// which is either escaped or a number. `o.md` (optional) is passed to
// renderMarkdown. `actions(p)`, optional, returns trusted HTML for extra buttons (the Copy link button from
// lib/discussion-links.js, which interpolates only the numeric post id).
export function renderPostHtml(p, o) {
    const { esc, shortAddr, fmtDate, editable, actions } = o;
    const name = p.authorName && p.authorName !== 'Unknown' ? p.authorName : shortAddr(p.author);
    const edited = isEdited(p)
        ? ` <span class="discussion-edited-tag" title="${esc('Edited ' + fmtDate(p.editedAt))}" style="color:var(--text-muted);font-size:0.7rem;font-style:italic;">edited</span>`
        : '';
    const btn = editable
        ? ` <button type="button" class="discussion-edit-btn" data-edit-post="${Number(p.id)}" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.75rem;padding:0 4px;"><i class='bx bx-edit-alt'></i> Edit</button>`
        : '';
    return `
            <div class="discussion-post" id="post-${Number(p.id)}" data-post-id="${Number(p.id)}">
                <div class="discussion-post-head">
                    <a href="/account/${encodeURIComponent(p.author)}" class="item-link" style="color:var(--brand-secondary);font-weight:600;">${esc(name)}</a>
                    <span style="color:var(--text-muted);font-size:0.75rem;">${esc(fmtDate(p.createdAt))}${edited}${actions ? actions(p) : ''}${btn}</span>
                </div>
                <div class="discussion-post-body md-body">${renderMarkdown(p.content, o.md)}</div>
            </div>`;
}

export const EMPTY_THREAD_HTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.86rem;">No posts yet - be the first to comment.</div>';

function postsErrorHtml(msg) {
    return `<div class="staking-error discussion-posts-error" style="display:block;margin:16px;">${msg} Reload the page to try again.</div>`;
}

// The whole post list for a thread. "No posts yet" only when the thread really
// has none: if the server counted posts (thread.postCount) but the list is
// empty, or a post fails to render, the reader gets an inline error and the
// console gets the reason, never an empty thread that looks like lost data.
//   o: renderPostHtml options minus `editable`, plus isEditable(post) -> bool.
export function renderPostList(thread, posts, o, log = console) {
    const list = Array.isArray(posts) ? posts : [];
    const reported = Number(thread && thread.postCount) || 0;
    if (list.length) {
        try {
            return list.map(p => renderPostHtml(p, { ...o, editable: !!(o.isEditable && o.isEditable(p)) })).join('');
        } catch (e) {
            log.error('Discussion: could not render the posts of', thread && thread.id, e);
            return postsErrorHtml('These posts could not be displayed.');
        }
    }
    if (reported > 0) {
        log.error('Discussion: thread', thread && thread.id, 'reports', reported, 'posts but the response carried', list.length);
        return postsErrorHtml('This discussion has ' + reported + ' post' + (reported === 1 ? '' : 's') + ' that could not be loaded.');
    }
    return EMPTY_THREAD_HTML;
}

// Attach Edit handlers under `root`. deps: { esc, fetchFn, getSession, clearSession,
// onUpdated(data), threadId, posts }. Returns nothing; all state is in the DOM.
export function wireEditing(root, deps) {
    if (!root) return;
    const byId = new Map((deps.posts || []).map(p => [Number(p.id), p]));
    root.querySelectorAll('[data-edit-post]').forEach(btn => {
        btn.addEventListener('click', () => openEditor(root, btn, byId, deps));
    });
}

function openEditor(root, btn, byId, deps) {
    const id = Number(btn.getAttribute('data-edit-post'));
    const post = byId.get(id);
    const wrap = root.querySelector('.discussion-post[data-post-id="' + id + '"]');
    const body = wrap && wrap.querySelector('.discussion-post-body');
    if (!post || !body || wrap.querySelector('.discussion-edit-form')) return;
    const original = body.innerHTML;
    btn.style.display = 'none';
    body.style.display = 'none';
    const form = document.createElement('div');
    form.className = 'discussion-edit-form';
    form.innerHTML = composerHtml(`<textarea class="discussion-textarea" maxlength="${MAX_POST_LEN}" aria-label="Edit your post"></textarea>`) + `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;">
            <span class="discussion-edit-count" style="color:var(--text-muted);font-size:0.75rem;"></span>
            <span><button type="button" class="staking-download-btn discussion-edit-cancel">Cancel</button>
            <button type="button" class="staking-download-btn discussion-edit-save" style="background:var(--brand-primary);color:#fff;border-color:var(--brand-primary);">Save</button></span>
        </div>
        <div class="staking-error discussion-edit-error" style="display:none;"></div>`;
    wrap.appendChild(form);
    const ta = form.querySelector('textarea');
    const count = form.querySelector('.discussion-edit-count');
    const save = form.querySelector('.discussion-edit-save');
    const cancel = form.querySelector('.discussion-edit-cancel');
    const err = form.querySelector('.discussion-edit-error');
    ta.value = post.content;
    wireComposer(form.querySelector('.md-composer'), { render: src => renderMarkdown(src, deps.md) });
    const upd = () => { count.textContent = ta.value.length + ' / ' + MAX_POST_LEN; };
    upd();
    ta.addEventListener('input', upd);
    const close = () => { form.remove(); body.style.display = ''; btn.style.display = ''; body.innerHTML = original; };
    const fail = m => { err.textContent = m; err.style.display = 'block'; };
    cancel.addEventListener('click', close);
    save.addEventListener('click', async () => {
        const v = validateContent(ta.value);
        if (v.error) { fail(v.error); return; }
        const session = deps.getSession();
        if (!session) { fail('Your session has expired - please sign in again.'); return; }
        save.disabled = true; cancel.disabled = true; ta.disabled = true;
        save.textContent = 'Saving...';
        err.style.display = 'none';
        try {
            // Call unbound: the browser's fetch throws "Illegal invocation" when
            // `this` is not window, and `deps.fetchFn(...)` makes `this` === deps.
            const doFetch = deps.fetchFn;
            const res = await doFetch('/api/discussions/' + encodeURIComponent(deps.threadId) + '/posts/' + id, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
                body: JSON.stringify({ content: v.content })
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 401) { deps.clearSession(); throw new Error('Session expired - please sign in again.'); }
            if (!res.ok || data.error) throw new Error(data.error || 'Failed to save the edit.');
            deps.onUpdated(data);
        } catch (e) {
            fail(e.message);
            save.disabled = false; cancel.disabled = false; ta.disabled = false;
            save.textContent = 'Save';
        }
    });
    ta.focus();
}
