// Discussion threads across a democracy item's lifecycle.
//
// A governance item changes identity as it moves: a council motion
// (democracy.externalPropose*) puts a call in democracy.nextExternal, which
// later becomes a referendum (launch period or Technical Committee fast-track);
// a public proposal is tabled into a referendum the same way. Each stage has
// its own thread (motion-<hash>, external-<proposalHash>, proposal-<index>,
// referendum-<index>), so when one stage ends its thread closes and the
// conversation needs a pointer to where it continues.
//
// The thread is linked by the democracy PROPOSAL HASH, the one value every
// stage carries: the motion's call argument, the nextExternal entry, the
// publicProps entry and the referendum status all hold the same bounded call,
// whose hash is the same. Each thread stores that hash (discussion_threads.
// proposal_hash) and the links are derived at read time, read-only: posts are
// never moved or copied.
//
// No imports and no DOM: used by server.js (ids, titles, link derivation) and
// by script.js (labels, link blocks, Discuss links). Tests:
// test/discussion-lifecycle.test.js.

export const THREAD_KINDS = ['proposal', 'motion', 'external', 'referendum'];

export const KIND_LABELS = {
    proposal: 'Public Proposal',
    motion: 'Council Motion',
    external: 'External Proposal',
    referendum: 'Referendum'
};

export function kindLabel(kind) {
    return KIND_LABELS[kind] || 'Discussion';
}

// The makeTable select filter on /discussions.
export function kindFilterOptions() {
    return THREAD_KINDS.map(k => ({ value: k, label: KIND_LABELS[k] }));
}

export function isThreadKind(kind) {
    return THREAD_KINDS.includes(kind);
}

// Which earlier stages a thread of each kind continues. A referendum can come
// from an external proposal (and so, one step further back, from the council
// motion that queued it) or from a tabled public proposal.
const PREDECESSORS = {
    proposal: [],
    motion: [],
    external: ['motion'],
    referendum: ['external', 'motion', 'proposal']
};
const ORDER = { motion: 0, proposal: 0, external: 1, referendum: 2 };

const HASH32 = /^0x[0-9a-f]{64}$/;
export function normalizeHash(h) {
    const s = String(h == null ? '' : h).toLowerCase();
    return HASH32.test(s) ? s : null;
}

// A bounded call (codec or its JSON) taken apart:
//   { kind: 'legacy' | 'lookup', hash, len? } | { kind: 'inline', bytes }
//   | { kind: 'hash', hash }   (a bare H256 on older runtimes)
// or null for anything else.
export function boundedParts(value) {
    if (value === null || value === undefined) return null;
    let j = value;
    if (typeof value === 'object' && typeof value.toJSON === 'function') {
        try { j = value.toJSON(); } catch (_) { return null; }
    }
    if (typeof j === 'string') {
        const direct = normalizeHash(j);
        if (direct) return { kind: 'hash', hash: direct };
        try { j = JSON.parse(j); } catch (_) { return null; }
    }
    if (!j || typeof j !== 'object') return null;
    const key = Object.keys(j).find(k => /^(legacy|lookup|inline)$/i.test(k));
    if (!key) return null;
    const kind = key.toLowerCase();
    const v = j[key];
    if (kind === 'inline') return typeof v === 'string' && /^0x([0-9a-f]{2})*$/i.test(v) ? { kind, bytes: v } : null;
    const hash = v && typeof v === 'object' ? normalizeHash(v.hash) : null;
    if (!hash) return null;
    const len = v.len === undefined || v.len === null ? null : Number(v.len);
    return { kind, hash, len: Number.isFinite(len) ? len : null };
}

// The democracy proposal hash of a bounded call:
//   Legacy { hash } / Lookup { hash, len } / a bare H256 -> that hash
//   Inline(bytes) -> blake2_256(bytes), as Bounded::hash() does
// hashBytes(hex) is the blake2-256 hasher, injected so this file stays
// import-free; without it an Inline call yields null.
export function proposalHashOf(value, hashBytes) {
    const b = boundedParts(value);
    if (!b) return null;
    if (b.kind !== 'inline') return b.hash;
    if (typeof hashBytes !== 'function') return null;
    try { return normalizeHash(hashBytes(b.bytes)); } catch (_) { return null; }
}

// The proposal hash a council motion carries, when its call queues an
// external proposal (externalPropose, externalProposeMajority,
// externalProposeDefault). Anything else has none.
export function isExternalProposeCall(section, method) {
    return String(section || '') === 'democracy' && /^externalPropose(Majority|Default)?$/.test(String(method || ''));
}

export function shortHash(h) {
    const s = String(h || '');
    return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

const THRESHOLD_LABELS = {
    SuperMajorityApprove: 'super-majority approve',
    SuperMajorityAgainst: 'super-majority against',
    SimpleMajority: 'simple majority'
};
export function thresholdLabel(t) {
    if (t === null || t === undefined || t === '') return '';
    return THRESHOLD_LABELS[String(t)] || String(t);
}

export const externalThreadId = (hash) => `external-${hash}`;
export const referendumThreadId = (index) => `referendum-${index}`;

// "External proposal: treasury.spend (simple majority)" when the call is
// decoded (a preimage is noted, or the call is inline), else the short hash.
export function externalTitle({ hash, call, threshold }) {
    const t = thresholdLabel(threshold);
    const base = call ? `External proposal: ${call}` : `External proposal ${shortHash(hash)}`;
    return t ? `${base} (${t})` : base;
}

export function referendumTitle({ index, call }) {
    return call ? `Referendum #${index}: ${call}` : `Referendum #${index}`;
}

// lifecycleLinks and earlierBoards share this cap so the "+ N earlier" count and
// the boards drawn under it never disagree.
export const LINKS_MAX = 10;

// Read-only links for one thread. `related` is every thread that shares its
// proposal hash (the caller's query); the result never includes the thread
// itself, and only follows the lifecycle edges above.
export function lifecycleLinks(thread, related) {
    const out = { earlier: [], later: [] };
    if (!thread || !normalizeHash(thread.proposalHash)) return out;
    const pick = (t) => ({ id: t.id, kind: t.kind, title: t.title || t.id, status: t.status, postCount: Number(t.postCount) || 0 });
    const byAge = (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id));
    for (const t of (related || []).slice().sort(byAge)) {
        if (!t || t.id === thread.id || normalizeHash(t.proposalHash) !== normalizeHash(thread.proposalHash)) continue;
        if ((PREDECESSORS[thread.kind] || []).includes(t.kind)) out.earlier.push(pick(t));
        else if ((PREDECESSORS[t.kind] || []).includes(thread.kind) && ORDER[t.kind] > ORDER[thread.kind]) out.later.push(pick(t));
    }
    out.earlier = out.earlier.slice(0, LINKS_MAX);
    out.later = out.later.slice(0, LINKS_MAX);
    return out;
}

// The posts that sit in earlier lifecycle threads of one item (its council
// motion, its external proposal): shown read-only beside the item's own posts,
// never added to them. links: lifecycleLinks() output.
export function earlierPostCount(links) {
    return ((links && links.earlier) || []).reduce((n, t) => n + (Number(t && t.postCount) || 0), 0);
}

// "Discussion (1) + 2 earlier": the header button's text, the one place the
// label is built. own = posts in this item's own thread, earlier = posts in its
// earlier lifecycle threads. The two are never summed: a reader who sees one
// message under "(1)" and two more under "Earlier discussion" has the same
// numbers on screen.
export function discussionLabel(own, earlier) {
    const e = Number(earlier) || 0;
    return `Discussion (${Number(own) || 0})${e > 0 ? ` + ${e} earlier` : ''}`;
}

// Each thread of a /api/discussions list with earlierPostCount: the posts of the
// earlier lifecycle threads that share its proposal hash. `all` is every thread
// (not the filtered list), since the earlier thread may be of another kind;
// null means `threads` already is every thread.
export function withEarlierCounts(threads, all) {
    const byHash = new Map();
    for (const t of all || threads || []) {
        const h = normalizeHash(t && t.proposalHash);
        if (!h) continue;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(t);
    }
    return (threads || []).map(t => {
        const h = normalizeHash(t && t.proposalHash);
        let earlier = 0;
        if (h) { try { earlier = earlierPostCount(lifecycleLinks(t, byHash.get(h) || [])); } catch (_) { earlier = 0; } }
        return { ...t, earlierPostCount: earlier };
    });
}

// The earlier threads' posts for one thread page: [{ thread, posts }], oldest
// stage first, at most `max` threads. getThread(id) / getPosts(id) are the db
// reads; a thread that cannot be read is left out rather than failing the page.
export function earlierBoards(links, getThread, getPosts, max = LINKS_MAX) {
    const out = [];
    for (const l of ((links && links.earlier) || []).slice(0, max)) {
        try {
            const thread = getThread(l.id);
            if (thread) out.push({ thread: { id: thread.id, kind: thread.kind, title: thread.title || thread.id, status: thread.status, postCount: thread.postCount }, posts: getPosts(thread.id) });
        } catch (_) { /* leave this one out */ }
    }
    return out;
}

// The "Earlier discussion" / "Continued in" block on a thread page. esc is
// the shared HTML escaper. hrefOf(threadId) picks the link target: the thread
// page by default; the governance item pages pass the item's own page
// (lib/gov-detail.js itemPathForThread), with headings to match.
const threadHref = (id) => `/discussions/${encodeURIComponent(id)}`;
export function renderLifecycleLinks(links, esc, hrefOf = threadHref, labels = ['Earlier discussion', 'Continued in']) {
    if (!links || typeof esc !== 'function') return '';
    const href = (id) => (typeof hrefOf === 'function' && hrefOf(id)) || threadHref(id);
    const item = (t) => `<li><a href="${esc(href(t.id))}" class="item-link" data-spa-link="true" style="color:var(--brand-secondary);">${esc(t.title || t.id)}</a> <span style="color:var(--text-muted);font-size:0.78rem;">${esc(kindLabel(t.kind))}${t.status === 'closed' ? ', closed' : ''}</span></li>`;
    const group = (label, list) => (Array.isArray(list) && list.length)
        ? `<div class="discussion-lifecycle-group"><div style="color:var(--text-secondary);font-size:0.8rem;font-weight:600;margin-bottom:4px;">${label}</div><ul style="margin:0;padding-left:18px;">${list.map(item).join('')}</ul></div>`
        : '';
    const html = group(labels[0], links.earlier) + group(labels[1], links.later);
    return html ? `<nav class="discussion-lifecycle" aria-label="Related discussions" style="display:flex;flex-wrap:wrap;gap:18px;padding:10px 0 14px;">${html}</nav>` : '';
}

// A "Discuss" link to a thread: its thread page, or (href) the discussion
// board embedded on the item's own page.
export function discussLinkHtml(threadId, label = 'Discuss', href = null) {
    if (!threadId) return '';
    const to = href || `/discussions/${encodeURIComponent(threadId)}`;
    return `<a href="${to}" class="item-link" data-spa-link="true" style="color:var(--brand-secondary);">${label}</a>`;
}

// Democracy page, referenda table: ongoing referenda always get a thread (the
// indexer creates it on its next pass); a finished one links only when the
// server says a thread exists. The link opens the referendum's page at its
// discussion board.
export function referendumDiscussCell(row) {
    if (!row || !Number.isInteger(Number(row.refIndex))) return '';
    const n = Number(row.refIndex);
    if (row.threadId || row.status === 'Ongoing') return discussLinkHtml(row.threadId || referendumThreadId(n), 'Discuss', `/democracy/referendum/${n}#discussion`);
    return '<span style="color:var(--text-muted);">-</span>';
}

// Democracy overview, "External proposal" line: the proposal's page, and its
// discussion board.
export function externalSummaryHtml(ext, esc) {
    if (!ext) return 'None';
    const t = ext.threshold ? ` (${esc(ext.threshold)})` : '';
    const hash = normalizeHash(ext.proposalHash);
    if (!hash) return `Queued${t}`;
    const page = `/democracy/external/${hash}`;
    return `<a href="${page}" class="item-link gov-item-link" data-spa-link="true" style="color:var(--brand-secondary);">Queued${t}</a> &middot; ${discussLinkHtml(externalThreadId(hash), 'Discuss', page + '#discussion')}`;
}
