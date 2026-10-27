// The governance item pages in the browser (URL scheme and vote arithmetic:
// lib/gov-detail.js; JSON: lib/gov-detail-api.js).
//
// One page per referendum, public proposal, external proposal and council or
// Technical Committee motion: the decoded call, proposer, status and lifecycle
// timeline, the vote chart, links to the item's earlier and later stages, a
// Copy link for the page, and the item's discussion board embedded at
// #discussion (rendered by script.js's own thread view, so posting, editing
// and post links behave exactly as on /discussions/<id>).
//
// Live: while the page is open the votes come straight from the browser's node
// link (referendumInfoOf / the collective's voting / depositOf / the connected
// account's votingOf), as the Democracy and Council pages do, and the JSON is
// re-read every 30 s as the fallback. Only the summary is redrawn; the
// discussion board (and a half-written post) is left alone.
//
// Lives here, not in script.js, because script.js is capped at 15,000 lines.
// Every browser native (fetch, timers, clipboard, document) arrives through
// deps and is called unbound. Tests: test/gov-detail.test.js.

import {
    parseGovRoute, govApiPath, govItemPath, itemPathForThread, ayeNaySplit, turnoutPercent, approvalState,
    motionProgress, weightedVotes, etaText, blockEta, DEFAULT_BLOCK_MS
} from './gov-detail.js';
import { renderLifecycleLinks, kindLabel } from './discussion-lifecycle.js';
import { decodeReferendum, decodeDeposit, decodeVoting, planckToPdex } from './democracy-live.js';
import { resolveCollectivePallet, votingToRecord } from './collective-live.js';
import { copyText } from './discussion-links.js';
import { govActionModel, renderGovActions, govItemKey, decodeAccountBalance } from './gov-actions.js';
import { demPendingStage, demPendingSettled } from './democracy-patch.js';
import { pendingSettled } from './tx-status.js';

export const GOV_DETAIL_POLL_MS = 30000;
export const GOV_ROW_CLASS = 'gov-row-clickable';
const COUNCIL_PALLETS = ['council', 'councilCollective', 'generalCouncil'];

const KIND_TEXT = { referendum: 'Referendum', proposal: 'Public proposal', external: 'External proposal' };
const STATUS = {
    Ongoing: ['Ongoing', 'live'], Passed: ['Passed', 'ok'], NotPassed: ['Not passed', 'bad'], Cancelled: ['Cancelled', 'bad'],
    Queued: ['Queued', 'live'], Tabled: ['Tabled', 'ok'], Launched: ['Launched', 'ok'], Gone: ['No longer queued', 'neutral'],
    proposed: ['Open', 'live'], executed: ['Executed', 'ok'], approved: ['Approved', 'ok'], disapproved: ['Disapproved', 'bad'], closed: ['Closed', 'neutral'], resolved: ['Resolved', 'neutral'],
    Unknown: ['Unknown', 'neutral']
};
const TONE_BADGE = { live: 'claimed', ok: 'claimed', bad: 'unclaimed', neutral: 'neutral' };

// ---- list rows -----------------------------------------------------------------

// The first cell of a Democracy / Council row: a real link (keyboard and
// middle-click work), which the delegated row click below follows.
export function govRowLinkHtml(path, label, esc) {
    if (!path) return esc(label);
    return `<a href="${esc(path)}" class="gov-item-link" data-gov-row-link="true">${esc(label)}</a>`;
}

// One delegated listener: a click anywhere on a row (or motion card) follows
// the row's link, unless it landed on something interactive or ended a text
// selection. Modifier clicks open a new tab, like the link itself would.
// deps: { open(href) } for the new-tab case; returns the listener.
export function wireGovRowClicks(doc, deps = {}) {
    const onClick = (e) => {
        if (e.defaultPrevented || (e.button !== undefined && e.button !== 0)) return;
        const t = e.target;
        const row = t && t.closest ? t.closest('.' + GOV_ROW_CLASS) : null;
        if (!row) return;
        if (t.closest('a, button, input, select, textarea, label, summary, details')) return;
        const sel = deps.selection ? String(deps.selection() || '') : '';
        if (sel) return;
        const link = row.querySelector('a[data-gov-row-link]');
        if (!link) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey) { if (deps.open) deps.open(link.getAttribute('href')); return; }
        link.click();
    };
    doc.addEventListener('click', onClick);
    return onClick;
}

// ---- pieces -----------------------------------------------------------------------

// A horizontal bar of segments [{ pct, cls }]: dependency-free SVG, decorative
// (aria-hidden); the numbers are always printed next to it.
export function barSvg(segments) {
    let x = 0;
    const rects = (segments || []).map(s => {
        const w = Math.max(0, Math.min(100 - x, Number(s.pct) || 0));
        const r = w > 0 ? `<rect x="${x}" y="0" width="${w}" height="10" class="${s.cls}"></rect>` : '';
        x += w;
        return r;
    }).join('');
    return `<svg class="gd-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect x="0" y="0" width="100" height="10" class="gd-bar-track"></rect>${rects}</svg>`;
}

const pctText = (p) => (p === null || p === undefined ? '-' : (p > 0 && p < 0.01 ? '<0.01%' : `${p}%`));
const muted = (s) => `<span class="gd-muted">${s}</span>`;

function badge(status, h) {
    const [label, tone] = STATUS[status] || [String(status || 'Unknown'), 'neutral'];
    return `<span class="reward-badge ${TONE_BADGE[tone]}" data-gd-status>${h.esc(label)}</span>`;
}

function blockLink(block, h) {
    if (block === null || block === undefined) return muted('not recorded');
    return `<a href="/block/${Number(block)}" class="item-link">${h.num(block)}</a>`;
}

function account(a, h) {
    if (!a || !a.address) return muted('-');
    const label = a.name || h.shortAddr(a.address);
    return `<a href="/account/${encodeURIComponent(a.address)}" class="item-link">${h.esc(label)}</a>`;
}

function row(label, value) {
    return `<div class="wallet-stat gd-fact"><span>${label}</span><strong>${value}</strong></div>`;
}

// When a block is (or was) reached: the indexer's actual time is not in the
// payload, so past and future both get an estimate from the block time.
function blockWhen(block, d, h) {
    const e = blockEta(block, d.currentBlock, d.blockMs || DEFAULT_BLOCK_MS);
    if (!e) return '';
    const at = (Number(d.now) || Date.now()) + e.ms;
    return `${etaText(block, d.currentBlock, d.blockMs)}${h.fmtDate ? ` (${h.esc(h.fmtDate(at))})` : ''}`;
}

export function renderCall(d, h) {
    const c = d.call;
    if (!c) return `<div class="gd-call">${muted(h.esc(d.callNote || 'The call is not available.'))}</div>`;
    const args = (c.args || []).length
        ? `<div class="table-responsive"><table class="data-table gd-args"><thead><tr><th scope="col">Argument</th><th scope="col">Value</th></tr></thead><tbody>${c.args.map(a =>
            `<tr><td><code>${h.esc(a.name)}</code>${a.type ? ` <span class="gd-muted">${h.esc(a.type)}</span>` : ''}</td><td class="gd-arg-value">${h.esc(a.value)}</td></tr>`).join('')}</tbody></table></div>`
        : '';
    return `<div class="gd-call"><code class="gd-call-name">${h.esc(c.section)}.${h.esc(c.method)}</code>${args}</div>`;
}

export function renderTimeline(steps, d, h) {
    if (!Array.isArray(steps) || !steps.length) return '';
    const items = steps.map(s => {
        const when = s.block !== null && s.block !== undefined ? ` <span class="gd-when">block ${blockLink(s.block, h)}, ${blockWhen(s.block, d, h)}</span>` : '';
        const note = s.note ? `<div class="gd-muted gd-step-note">${h.esc(s.note)}</div>` : '';
        return `<li class="gd-step gd-step-${h.esc(s.state)}"><span class="gd-step-label">${h.esc(s.label)}</span>${when}${note}</li>`;
    }).join('');
    return `<section class="gd-section" aria-labelledby="gd-timeline-h"><h2 id="gd-timeline-h" class="gd-h">Lifecycle</h2><ol class="gd-timeline">${items}</ol></section>`;
}

export function renderReferendumVotes(d, h, live = {}) {
    const t = d.tally || {};
    if (!t.known) return `<section class="gd-section"><h2 class="gd-h">Votes</h2><p class="gd-muted">The tally of this referendum is not indexed (it ended before the indexer recorded it and the node does not serve archive state).</p></section>`;
    const split = ayeNaySplit(t.ayes, t.nays);
    const turnout = turnoutPercent(t.turnout, d.electorate);
    const state = d.status === 'Ongoing' ? approvalState({ ayes: t.ayes, nays: t.nays, turnout: t.turnout, electorate: d.electorate, threshold: d.threshold }) : null;
    const verdict = state ? `<p class="gd-verdict gd-${state}">${state === 'passing' ? 'Passing' : 'Failing'} right now under ${h.esc(d.thresholdLabel || d.threshold)}.</p>` : '';
    const mine = live.myVote ? (() => {
        const v = live.myVote;
        if (v.split) return `<p class="gd-mine">Your vote: split, ${h.pdex(v.ayeBalance)} aye / ${h.pdex(v.nayBalance)} nay PDEX.</p>`;
        const w = weightedVotes(v.balance, v.conviction);
        return `<p class="gd-mine">Your vote: ${v.aye ? 'Aye' : 'Nay'}, ${h.pdex(v.balance)} PDEX at ${h.esc(v.conviction || 'None')}${w !== null ? ` = ${h.pdex(w)} votes` : ''}.</p>`;
    })() : '';
    return `<section class="gd-section" aria-labelledby="gd-votes-h">
        <h2 id="gd-votes-h" class="gd-h">Votes</h2>
        <div class="gd-chart">
            <div class="gd-chart-label"><span>Aye vs nay (conviction-weighted)</span><span>${split.empty ? 'no votes yet' : `${pctText(split.aye)} aye / ${pctText(split.nay)} nay`}</span></div>
            ${barSvg(split.empty ? [] : [{ pct: split.aye, cls: 'gd-aye' }, { pct: split.nay, cls: 'gd-nay' }])}
            <dl class="gd-legend">
                <div><dt><span class="gd-dot gd-aye"></span>Aye</dt><dd data-gd-ayes>${h.pdex(t.ayes || 0)} votes (${pctText(split.aye)})</dd></div>
                <div><dt><span class="gd-dot gd-nay"></span>Nay</dt><dd data-gd-nays>${h.pdex(t.nays || 0)} votes (${pctText(split.nay)})</dd></div>
            </dl>
        </div>
        <div class="gd-chart">
            <div class="gd-chart-label"><span>Turnout of the electorate</span><span>${pctText(turnout)}</span></div>
            ${barSvg(turnout === null ? [] : [{ pct: turnout, cls: 'gd-turnout' }])}
            <dl class="gd-legend"><div><dt><span class="gd-dot gd-turnout"></span>Turnout</dt><dd data-gd-turnout>${h.pdex(t.turnout || 0)} PDEX voted${d.electorate ? ` of ${h.pdex(d.electorate)} PDEX total issuance` : ''}</dd></div></dl>
        </div>
        ${verdict}${mine}
        <p class="gd-muted gd-small">Votes are PDEX multiplied by the voter's conviction (0.1x with no lock, up to 6x). Turnout counts the PDEX behind the votes, without conviction.</p>
    </section>`;
}

function voterList(list, h) {
    if (!Array.isArray(list) || !list.length) return muted('none');
    return `<ul class="gd-voters">${list.map(v => `<li>${account(v, h)}</li>`).join('')}</ul>`;
}

export function renderMotionVotes(d, h) {
    const p = motionProgress({ ayes: d.ayes, nays: d.nays, threshold: d.threshold, seats: d.seats });
    if (d.ayes === null && d.nays === null) return `<section class="gd-section"><h2 class="gd-h">Votes</h2><p class="gd-muted">The vote of this motion is not indexed.</p></section>`;
    const members = Array.isArray(d.members) && d.members.length
        ? `<details class="gd-members"><summary>Members (${d.members.length})</summary><ul class="gd-voters">${d.members.map(m =>
            `<li>${account(m, h)} <span class="gd-vote gd-vote-${m.vote || 'none'}">${m.vote === 'aye' ? 'Aye' : m.vote === 'nay' ? 'Nay' : 'Not voted'}</span></li>`).join('')}</ul></details>`
        : '';
    return `<section class="gd-section" aria-labelledby="gd-votes-h">
        <h2 id="gd-votes-h" class="gd-h">Votes</h2>
        <div class="gd-chart">
            <div class="gd-chart-label"><span>Ayes towards the threshold</span><span data-gd-ayes>${p.ayes} of ${p.threshold === null ? '-' : p.threshold} needed</span></div>
            ${barSvg([{ pct: p.ayePct, cls: 'gd-aye' }])}
        </div>
        <div class="gd-chart">
            <div class="gd-chart-label"><span>Nays towards rejection</span><span data-gd-nays>${p.nays} of ${p.toReject === null ? '-' : p.toReject} to reject</span></div>
            ${barSvg([{ pct: p.nayPct, cls: 'gd-nay' }])}
        </div>
        ${p.decided ? `<p class="gd-verdict gd-${p.decided === 'approved' ? 'passing' : 'failing'}">The vote is decided (${p.decided}); it takes effect when a member closes the motion.</p>` : ''}
        ${d.seats ? `<p class="gd-muted gd-small">${d.seats} seats; threshold ${p.threshold === null ? '-' : p.threshold}.</p>` : ''}
        <div class="gd-voter-cols"><div><h3 class="gd-h3">Aye</h3>${d.ayeVoters ? voterList(d.ayeVoters, h) : muted('voter list not indexed')}</div><div><h3 class="gd-h3">Nay</h3>${d.nayVoters ? voterList(d.nayVoters, h) : muted('voter list not indexed')}</div></div>
        ${members}
    </section>`;
}

function renderFacts(d, h, live) {
    const out = [];
    if (d.kind === 'referendum') {
        out.push(row('Threshold', d.threshold ? h.esc(d.thresholdLabel || d.threshold) : muted('not recorded')));
        if (d.status === 'Ongoing' && d.endBlock) out.push(row('Time remaining', h.esc(etaText(d.endBlock, d.currentBlock, d.blockMs) || '-')));
        out.push(row('Ends at block', blockLink(d.endBlock, h)));
    } else if (d.kind === 'proposal') {
        out.push(row('Proposer', account(d.proposer, h)));
        out.push(row('Seconds', `<span data-gd-seconds>${d.seconds === null ? '-' : h.num(live.seconds !== undefined ? live.seconds : d.seconds)}</span>`));
        out.push(row('Deposit', d.deposit === null ? muted('-') : `${h.pdex(live.deposit !== undefined ? live.deposit : d.deposit)} PDEX`));
        if (d.status === 'Queued' && d.nextLaunch) out.push(row('Next launch', `block ${blockLink(d.nextLaunch, h)}, ${blockWhen(d.nextLaunch, d, h)}`));
        if (d.tabledAs !== null && d.tabledAs !== undefined) out.push(row('Became', `<a href="/democracy/referendum/${Number(d.tabledAs)}" class="item-link">Referendum #${Number(d.tabledAs)}</a>`));
    } else if (d.kind === 'external') {
        out.push(row('Threshold', d.threshold ? h.esc(d.thresholdLabel || d.threshold) : muted('not recorded')));
        if (d.status === 'Queued' && d.nextLaunch) out.push(row('Launches', `at block ${blockLink(d.nextLaunch, h)} (${blockWhen(d.nextLaunch, d, h)}) or by Technical Committee fast-track`));
        if (d.launchedAs !== null && d.launchedAs !== undefined) out.push(row('Became', `<a href="/democracy/referendum/${Number(d.launchedAs)}" class="item-link">Referendum #${Number(d.launchedAs)}</a>`));
        for (const m of d.motions || []) out.push(row('Queued by', `<a href="${h.esc(itemPathForThread(m.id) || '#')}" class="item-link">${h.esc(m.title || m.id)}</a>`));
    } else if (d.kind === 'motion') {
        out.push(row('Proposer', account(d.proposer, h)));
        if (d.status === 'proposed' && d.endBlock) out.push(row('Time remaining', h.esc(etaText(d.endBlock, d.currentBlock, d.blockMs) || '-')));
        out.push(row('Motion hash', `<code class="gd-hash">${h.esc(d.hash)}</code>`));
        if (d.proposalHash) out.push(row('Queues external proposal', `<a href="/democracy/external/${h.esc(d.proposalHash)}" class="item-link">${h.esc(d.proposalHash.slice(0, 10))}...</a>`));
        if ((d.related || []).length) out.push(row('Same call proposed as', d.related.map(r => `#${h.num(r.index)} (${h.esc((STATUS[r.status] || [r.status || 'closed'])[0])})`).join(', ')));
    }
    if (d.proposalHash && d.kind !== 'motion') out.push(row('Proposal hash', `<code class="gd-hash">${h.esc(d.proposalHash)}</code>`));
    return `<div class="wallet-stat-list gd-facts">${out.join('')}</div>`;
}

function sourcesNote(d) {
    if (!d.sources) return '';
    if (!d.sources.chain) return '<p class="gd-muted gd-small">The node is unreachable right now: this page shows the indexer\'s stored history.</p>';
    if (d.sources.archive === false) return '<p class="gd-muted gd-small">Some details of a finished item come from archive state, which the connected node does not serve.</p>';
    return '';
}

// The page above the discussion board. live: { myVote, seconds, deposit, actions }
// where actions is the Actions panel's context (lib/gov-actions.js).
export function renderGovDetailSummary(d, h, live = {}) {
    const kindText = d.kind === 'motion' ? (d.collective === 'technicalCommittee' ? 'Technical Committee motion' : 'Council motion') : KIND_TEXT[d.kind];
    // A motion's page is its index (two motions can share a call hash); the hash form also resolves.
    const path = govItemPath(d.kind, d.kind === 'motion' && d.index !== null && d.index !== undefined ? d.index : d.id, d.collective);
    const back = d.kind === 'motion' ? '<a href="/council" class="item-link">Council</a>' : '<a href="/democracy" class="item-link">Democracy</a>';
    const links = d.thread && d.thread.links
        ? renderLifecycleLinks(d.thread.links, h.esc, itemPathForThread, ['Earlier stages', 'Continued as'])
        : '';
    const votes = d.kind === 'referendum' ? renderReferendumVotes(d, h, live) : d.kind === 'motion' ? renderMotionVotes(d, h) : '';
    return `<div class="list-container glass gd-card">
        <div class="list-header gd-head">
            <div class="gd-head-text">
                <div class="gd-kicker">${back} / ${h.esc(kindText)} ${h.helpIcon ? h.helpIcon('governance-item-pages', 'About this page') : ''}</div>
                <h1 class="gd-title">${h.esc(d.title)}</h1>
            </div>
            <div class="gd-actions">${badge(d.status, h)}
                <button type="button" class="staking-download-btn gd-copy" data-gd-copy="${h.esc(path)}"><i class='bx bx-link' aria-hidden="true"></i> Copy link</button>
                <span class="gd-copy-feedback" role="status" aria-live="polite"></span>
                <a href="#discussion" class="item-link">Discussion${d.thread ? ` (${h.num(d.thread.postCount || 0)})` : ''}</a>
            </div>
        </div>
        <div class="gd-body">
            <section class="gd-section" aria-labelledby="gd-call-h"><h2 id="gd-call-h" class="gd-h">Proposal</h2>${renderCall(d, h)}</section>
            ${renderFacts(d, h, live)}
            ${votes}
            ${renderGovActions(govActionModel(d, { pdex: h.pdex, ...(live.actions || {}) }), h)}
            ${renderTimeline(d.timeline, d, h)}
            ${links ? `<section class="gd-section">${links}</section>` : ''}
            ${sourcesNote(d)}
        </div>
    </div>`;
}

export function renderNotFound(route, message, h) {
    const what = route ? (route.kind === 'motion' ? 'motion' : (KIND_TEXT[route.kind] || 'item').toLowerCase()) : 'item';
    return `<div class="list-container glass gd-card gd-not-found" role="alert">
        <h1 class="gd-title">This ${h.esc(what)} was not found</h1>
        <p>${h.esc(message || 'Nothing on chain or in the index matches this link.')}</p>
        <p><a href="/democracy" class="item-link">Democracy</a> &middot; <a href="/council" class="item-link">Council</a> &middot; <a href="/discussions" class="item-link">Discussions</a></p>
    </div>`;
}

function discussionShell(d, h) {
    if (d.thread) return '<div data-gd-thread>Loading discussion...</div>';
    const why = d.kind === 'motion' && d.collective === 'technicalCommittee'
        ? 'Technical Committee motions have no discussion thread.'
        : (d.threadId && (d.status === 'Ongoing' || d.status === 'Queued' || d.status === 'proposed')
            ? 'The discussion thread opens on the indexer\'s next pass (within a minute or two).'
            : 'There is no discussion thread for this item: it ended before discussion threads were created for it.');
    return `<div class="list-header"><h2>Discussion</h2></div><p class="gd-muted gd-pad">${h.esc(why)}</p>`;
}

// ---- the page controller ------------------------------------------------------------

// deps: {
//   root() -> the page element, h: { esc, num, pdex, shortAddr, fmtDate, helpIcon },
//   fetchFn, loadThread(threadId, el, { focus }) -> Promise, setSeo({ title, description, noindex }),
//   getApi(), toAddress, account(), location() -> { search, hash, origin }, env: { navigator, document },
//   timers: { setInterval, clearInterval, setTimeout, clearTimeout }, visible(), scrollTo(el),
//   same(a, b) address equality across SS58 prefixes,
//   actions: { vote(refIndex, side), second(index, seconds), motionVote(hash, index, aye, collective),
//              motionClose(hash, index, collective) }: the list pages' own functions (lib/gov-actions.js)
// }
// h may also carry connectPrompt() -> the wallet flow's "Connect a wallet" html.
// The fields a storage subscription keeps current.
const LIVE_FIELDS = ['tally', 'ayes', 'nays', 'ayeVoters', 'nayVoters', 'members'];

export function createGovDetailPage(deps) {
    const T = deps.timers || {
        setInterval: (...a) => setInterval(...a), clearInterval: (...a) => clearInterval(...a),
        setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a)
    };
    const visible = deps.visible || (() => true);
    let route = null, data = null, live = {}, token = 0, poll = null, refetch = null, subs = [], liveSeen = false;
    // The status a live subscription saw the item end with, kept over a poll
    // that still says Ongoing (the server is behind by its cache).
    let endedLive = null;
    // Transactions started from an item page, keyed like the list pages
    // (govItemKey), and the items whose action was started but has not
    // reported a stage yet. Both outlive stop(): leaving the page mid-Second and
    // coming back must not offer Second (a second deposit) again. An entry goes
    // only when it settles (in block / finalized and shown on chain, cancelled,
    // or failed; a failure's message is dropped on leaving the page).
    const pending = new Map();
    const clicking = new Set();
    const same = deps.same || ((a, b) => a === b);
    const who = () => (deps.account ? deps.account() || null : null);

    const unsubscribeAll = () => { liveSeen = false; for (const s of subs) { s.dead = true; if (s.unsub) { try { s.unsub(); } catch (_) { /* gone */ } } } subs = []; };
    // A storage subscription whose unsub may arrive after stop().
    // start(cb) makes the query (as a method call on its pallet object).
    const subscribe = (start, cb) => {
        const slot = { dead: false, unsub: null };
        subs.push(slot);
        try {
            Promise.resolve(start((v) => { if (!slot.dead) cb(v); })).then(u => { if (slot.dead) { if (typeof u === 'function') u(); } else slot.unsub = u; }, () => {});
        } catch (_) { /* this runtime has no such item */ }
    };

    function stop() {
        token++;
        if (poll !== null) { T.clearInterval(poll); poll = null; }
        if (refetch !== null) { T.clearTimeout(refetch); refetch = null; }
        unsubscribeAll();
        route = null; data = null; live = {}; endedLive = null;
        for (const [k, p] of Array.from(pending)) if (p && p.error) pending.delete(k);
    }

    const summaryEl = () => { const r = deps.root(); return r ? r.querySelector('[data-gd-summary]') : null; };

    function wireCopy(scope) {
        if (!scope) return;
        scope.querySelectorAll('[data-gd-copy]').forEach(btn => btn.addEventListener('click', async () => {
            const loc = deps.location();
            const url = String(loc.origin || '').replace(/\/+$/, '') + btn.getAttribute('data-gd-copy');
            const fb = btn.nextElementSibling;
            const okCopy = await copyText(url, deps.env);
            if (!fb) return;
            fb.textContent = okCopy ? 'Link copied' : 'Copy this link: ' + url;
        }));
    }

    // Membership: the live member list, else the server's (present while a motion is open).
    const membersOf = () => (Array.isArray(live.members) ? live.members
        : (data && Array.isArray(data.members) ? data.members.map(m => m && m.address).filter(Boolean) : null));
    const actionCtx = () => ({
        account: who(), same, myVote: live.myVote || null, balance: live.balance || null, members: membersOf(),
        deposit: live.deposit, existentialDeposit: live.existentialDeposit,
        pending: data ? pending.get(govItemKey(data)) || null : null, clicking: !!data && clicking.has(govItemKey(data))
    });

    // A vote is done once the chain shows it, a second once it is in a block, a
    // close once the motion is gone (the list pages' own rules).
    function settle() {
        const key = data && govItemKey(data);
        const p = key ? pending.get(key) : null;
        if (!p) return;
        let done;
        if (data.kind === 'motion') {
            const me = who();
            const has = (list) => !!me && Array.isArray(list) && list.some(v => v && same(v.address, me));
            done = pendingSettled(p, data.status === 'proposed' ? { youVoted: has(data.ayeVoters) ? 'aye' : has(data.nayVoters) ? 'nay' : null } : null);
        } else done = demPendingSettled(p, live.myVote || null);
        if (done) pending.delete(key);
    }

    function wireActions(scope) {
        if (!scope) return;
        scope.querySelectorAll('[data-gd-act]').forEach(btn => btn.addEventListener('click', () => act(btn.getAttribute('data-gd-act'))));
    }

    function drawSummary() {
        const el = summaryEl();
        if (!el || !data) return;
        settle();
        el.innerHTML = renderGovDetailSummary(data, deps.h, { ...live, actions: actionCtx() });
        wireCopy(el);
        wireActions(el);
    }

    // A button of the Actions panel. Refuses anything the panel shows disabled,
    // which includes every button while a transaction of this page is in
    // flight: the double-submit guard. Returns whether an action was started.
    function act(name) {
        if (!data) return false;
        const b = govActionModel(data, actionCtx()).buttons.find(x => x.act === name);
        if (!b || !b.enabled) return false;
        const a = deps.actions || {};
        let run;
        if (data.kind === 'referendum') {
            // The vote form (amount, conviction) opens; its Submit guards itself.
            if (typeof a.vote === 'function') a.vote(data.index, name);
            return true;
        }
        if (data.kind === 'proposal') run = typeof a.second === 'function' ? a.second(data.index, live.seconds !== undefined ? live.seconds : data.seconds) : null;
        else if (data.kind === 'motion' && name === 'close') run = typeof a.motionClose === 'function' ? a.motionClose(data.hash, data.index, data.collective) : null;
        else if (data.kind === 'motion') run = typeof a.motionVote === 'function' ? a.motionVote(data.hash, data.index, name === 'aye', data.collective) : null;
        if (!run || typeof run.then !== 'function') return true;
        const key = govItemKey(data);
        clicking.add(key);
        drawSummary();
        // Over (signed, cancelled or refused) whether or not this page is still open.
        const done = () => { if (!clicking.delete(key)) return; if (data && govItemKey(data) === key) drawSummary(); };
        run.then(done, done);
        return true;
    }

    // The onStage of a vote, second or close: script.js hands it to the same
    // submitSignedTx call the list page uses (next to the list's own). Recorded
    // for any item, shown (and the fresh read made) only while this page shows it.
    function stage(key, kind) {
        return (s, m) => {
            clicking.delete(key);
            const inBlock = demPendingStage(pending, key, kind, s, m);
            if (!data || govItemKey(data) !== key) return;
            if (inBlock) load(true, true);
            drawSummary();
        };
    }

    // The connected wallet changed: its vote, balance and seat are someone else's.
    function accountChanged() {
        if (!data) return;
        delete live.myVote; delete live.balance;
        startLive();
        drawSummary();
    }

    function scheduleRefetch(ms) {
        if (refetch !== null) T.clearTimeout(refetch);
        refetch = T.setTimeout(() => { refetch = null; load(true, true); }, ms);
    }

    function startLive() {
        unsubscribeAll();
        const api = deps.getApi ? deps.getApi() : null;
        const q = api && api.query;
        if (!q || !data) return;
        const toAddress = deps.toAddress || ((a) => a);
        delete live.members;
        const me = who();
        // The free balance behind the Actions panel's checks.
        const watchBalance = () => {
            try {
                const ed = api.consts && api.consts.balances && api.consts.balances.existentialDeposit;
                if (ed !== undefined && ed !== null) live.existentialDeposit = planckToPdex(String(ed));
            } catch (_) { /* no such constant: the chain still checks */ }
            if (!me || !q.system || typeof q.system.account !== 'function') return;
            subscribe((cb) => q.system.account(me, cb), (info) => { live.balance = decodeAccountBalance(info); drawSummary(); });
        };
        if (data.kind === 'referendum' && data.status === 'Ongoing' && q.democracy && typeof q.democracy.referendumInfoOf === 'function') {
            subscribe((cb) => q.democracy.referendumInfoOf(data.index, cb), (opt) => {
                const r = decodeReferendum(data.index, opt, { ...(data.tally || {}), tallyKnown: data.tally && data.tally.known ? 1 : 0 });
                if (!r) return;
                if (r.status !== 'Ongoing') {
                    // Ended: the actions close now, not when the server catches up.
                    if (data.status !== r.status) { data.status = r.status; endedLive = r.status; drawSummary(); }
                    scheduleRefetch(8000);
                    return;
                }
                data.tally = { ayes: r.ayes, nays: r.nays, turnout: r.turnout, known: true };
                liveSeen = true;
                drawSummary();
            });
            if (me && typeof q.democracy.votingOf === 'function') {
                subscribe((cb) => q.democracy.votingOf(me, cb), (v) => {
                    const dv = decodeVoting(v);
                    live.myVote = dv && dv.votes ? dv.votes[data.index] || null : null;
                    drawSummary();
                });
            }
            watchBalance();
        } else if (data.kind === 'proposal' && data.status === 'Queued' && q.democracy && typeof q.democracy.depositOf === 'function') {
            subscribe((cb) => q.democracy.depositOf(data.index, cb), (opt) => {
                const dep = decodeDeposit(opt);
                if (!dep) { scheduleRefetch(8000); return; }
                live.seconds = dep.seconds; live.deposit = dep.deposit;
                drawSummary();
            });
            watchBalance();
        } else if (data.kind === 'motion' && data.status === 'proposed') {
            const pallet = data.collective === 'technicalCommittee'
                ? resolveCollectivePallet(api, ['technicalCommittee'])
                : resolveCollectivePallet(api, COUNCIL_PALLETS);
            const qq = pallet ? q[pallet] : null;
            if (!qq || typeof qq.voting !== 'function') return;
            // Membership read live: the seat decides the Aye / Nay / Close buttons.
            if (typeof qq.members === 'function') {
                subscribe((cb) => qq.members(cb), (list) => { live.members = Array.from(list || []).map(a => toAddress(String(a))); drawSummary(); });
            }
            subscribe((cb) => qq.voting(data.hash, cb), (opt) => {
                const rec = votingToRecord(opt, toAddress);
                if (!rec) { scheduleRefetch(8000); return; }   // closed: the server has the outcome shortly
                // The same call re-proposed under a new index: this record is
                // another motion's, so it is not drawn over this one.
                if (data.index !== null && data.index !== undefined && rec.index !== null && Number(rec.index) !== Number(data.index)) { scheduleRefetch(8000); return; }
                const names = new Map((data.members || []).map(m => [toAddress(m.address), m]));
                const who = (a) => ({ address: a, name: names.has(a) ? names.get(a).name : null });
                liveSeen = true;
                data.ayes = rec.ayes.length; data.nays = rec.nays.length; data.threshold = rec.threshold || data.threshold;
                data.ayeVoters = rec.ayes.map(who); data.nayVoters = rec.nays.map(who);
                if (Array.isArray(data.members)) data.members = data.members.map(m => ({ ...m, vote: rec.ayes.includes(toAddress(m.address)) ? 'aye' : rec.nays.includes(toAddress(m.address)) ? 'nay' : null }));
                drawSummary();
            });
        }
    }

    async function load(quiet = false, fresh = false) {
        const my = token;
        const r = route;
        const root = deps.root();
        if (!root || !r) return;
        if (!quiet) root.innerHTML = '<div class="list-container glass gd-card gd-pad gd-muted">Loading...</div>';
        let res, body;
        try {
            const doFetch = deps.fetchFn;   // unbound: "Illegal invocation" otherwise
            res = await doFetch(govApiPath(r) + (fresh ? '?fresh=1' : ''), { cache: 'no-store' });
            body = await res.json();
        } catch (e) {
            if (my !== token) return;
            if (!quiet) root.innerHTML = `<div class="list-container glass gd-card gd-pad" role="alert">Could not load this page: ${deps.h.esc(e && e.message ? e.message : 'network error')}. Try again in a moment.</div>`;
            return;
        }
        if (my !== token) return;
        if (!res.ok) {
            if (quiet) return;
            root.innerHTML = res.status === 404 || res.status === 400 ? renderNotFound(r, body && body.error, deps.h)
                : `<div class="list-container glass gd-card gd-pad" role="alert">${deps.h.esc((body && body.error) || 'Request failed')}</div>`;
            if (deps.setSeo) deps.setSeo({ title: 'Not found - Polkadex Governance', description: 'This governance item was not found.', noindex: true });
            return;
        }
        const first = !data || quiet === false;
        const before = data ? data.status : null;
        const prev = data;
        // Ended live while the server still says Ongoing: keep the ended status.
        if (endedLive && body.status === 'Ongoing') body.status = endedLive;
        else endedLive = null;
        data = body;
        // A live subscription is fresher than the 30 s poll (the server may be
        // behind by its cache): while one has delivered and the status is the
        // same, the poll keeps the live votes instead of overwriting them.
        if (!first && liveSeen && prev && before === body.status) {
            for (const k of LIVE_FIELDS) if (k in prev) data[k] = prev[k];
        }
        if (!first) { drawSummary(); if (before !== data.status) startLive(); return; }
        root.innerHTML = `<div data-gd-summary></div><section id="discussion" class="list-container glass gd-discussion" data-gd-discussion aria-label="Discussion">${discussionShell(data, deps.h)}</section>`;
        drawSummary();
        if (deps.setSeo) deps.setSeo({ title: `${data.title} - Polkadex Governance`, description: `${data.title}: status, votes, lifecycle and discussion on the Polkadex Explorer.`, canonicalPath: govItemPath(data.kind, data.kind === 'motion' && data.index !== null && data.index !== undefined ? data.index : data.id, data.collective) });
        startLive();
        const loc = deps.location();
        const focus = /[?&]post=\d/.test(loc.search || '') || /^#post-\d+$/.test(loc.hash || '');
        const board = root.querySelector('[data-gd-thread]');
        if (board && data.thread && deps.loadThread) await deps.loadThread(data.thread.id, board, { focus });
        if (my !== token) return;
        if (!focus && loc.hash === '#discussion' && deps.scrollTo) deps.scrollTo(root.querySelector('#discussion'));
    }

    function open(target) {
        stop();
        route = parseGovRoute(target);
        const root = deps.root();
        if (!route) { if (root) root.innerHTML = renderNotFound(null, null, deps.h); return; }
        load(false);
        poll = T.setInterval(() => { if (visible()) load(true); }, GOV_DETAIL_POLL_MS);
    }

    return { open, stop, current: () => data, kindLabel: () => (data ? kindLabel(data.kind) : ''), stage, act, accountChanged };
}
