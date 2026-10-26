// JSON for the governance item pages (lib/gov-detail.js has the URL scheme):
//
//   GET /api/democracy/referendum/:index
//   GET /api/democracy/proposal/:index
//   GET /api/democracy/external/:hash
//   GET /api/council/motion/:id               (:id = motion hash or index)
//   GET /api/technical-committee/motion/:id
//
// Sources, in this order:
//   - the chain, when the backend's RPC is up: live status and tally, the
//     decoded call (inline, or through a noted preimage), seconds, and for a
//     finished item the state just before it ended (archive nodes only);
//   - the indexer's tables: democracy_referenda (every referendum's status,
//     end block and last tally), collective_motions + collective_motion_events
//     (every motion with its outcome), the democracy_meta / council /
//     technicalCommittee snapshots, and discussion_threads (which also say what
//     a closed proposal or external proposal became).
// So an old, closed item still resolves from stored history with the RPC down;
// an id nothing knows about is a 404.
//
// Cache-Control: found -> the short tier (live tallies, same as /api/democracy);
// ?fresh=1, 400, 404 and errors -> no-store, so an item created a block later
// is never hidden behind a cached "not found" (the 2026-10-22 stale-edge
// incident was exactly that shape).
//
// No imports of server state: server.js passes db, a chain adapter and the
// cache helpers (registerGovDetailRoutes), so test/gov-detail.test.js runs the
// real handlers against an in-memory SQLite and a fake chain.

import {
    normalizeItemHash, normalizeItemIndex, govThreadId, referendumTimeline, motionTimeline, proposalTimeline,
    externalTimeline, nextLaunchBlock, launchedReferendum, DEFAULT_BLOCK_MS
} from './gov-detail.js';
import { lifecycleLinks, referendumTitle, externalTitle, thresholdLabel } from './discussion-lifecycle.js';

const notFound = (error) => ({ status: 404, body: { error } });
const badRequest = (error) => ({ status: 400, body: { error } });
const ok = (body) => ({ status: 200, body });

async function safe(fn, fallback = null) {
    try { const v = await fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; }
}

const callLabel = (call) => (call && call.section && call.method ? `${call.section}.${call.method}` : null);

function threadSummary(db, id) {
    if (!id) return null;
    const t = db.getThread(id);
    if (!t) return null;
    let links = { earlier: [], later: [] };
    try { links = lifecycleLinks(t, t.proposalHash ? db.getThreadsByProposalHash(t.proposalHash) : []); } catch (_) { /* no links */ }
    return { id: t.id, kind: t.kind, title: t.title, status: t.status, closedReason: t.closedReason, postCount: t.postCount, proposalHash: t.proposalHash || null, links };
}

async function chainContext(deps, meta) {
    const chain = deps.chain && deps.chain.ready() ? deps.chain : null;
    const consts = chain ? await safe(() => chain.consts()) : null;
    const head = chain ? await safe(() => chain.currentBlock()) : null;
    return {
        chain,
        consts: consts || {},
        currentBlock: Number(head) > 0 ? Number(head) : (Number(meta.currentBlock) || 0),
        blockMs: consts && Number(consts.blockMs) > 0 ? Number(consts.blockMs) : DEFAULT_BLOCK_MS,
        launchPeriod: (consts && Number(consts.launchPeriod)) || Number(meta.launchPeriod) || 0
    };
}

async function decode(chain, bounded, hash) {
    if (!bounded && !hash) return { call: null, note: null };
    if (!chain) return { call: null, note: 'The call is read from the chain, and the node is unreachable right now.' };
    const r = await safe(() => chain.decodeCall(bounded, hash));
    if (r && r.call) return { call: r.call, note: null };
    return { call: null, note: (r && r.note) || 'The call could not be decoded.' };
}

// Names for a list of addresses: the collective's member list first, then the
// chain's identity lookup (cached in server.js), else none.
async function named(deps, addrs, known = []) {
    const byAddr = new Map((known || []).map(m => [String(m.address), m.name]));
    const chain = deps.chain && deps.chain.ready() ? deps.chain : null;
    const out = [];
    for (const a of (addrs || []).slice(0, 200)) {
        let name = byAddr.get(String(a));
        if (!name && chain && typeof chain.name === 'function') name = await safe(() => chain.name(a));
        out.push({ address: String(a), name: name && name !== 'Unknown' ? String(name) : null });
    }
    return out;
}

// ---- referendum --------------------------------------------------------------

export async function referendumDetail(rawIndex, deps) {
    const id = normalizeItemIndex(rawIndex);
    if (id === null) return badRequest('A referendum index is a whole number.');
    const index = Number(id);
    const { db } = deps;
    const meta = db.getKv('democracy_meta') || {};
    const row = db.getDemocracyReferendum(index);
    const ctx = await chainContext(deps, meta);
    const live = ctx.chain ? await safe(() => ctx.chain.referendum(index)) : null;
    const count = Number(meta.referendumCount);
    const known = !!row || (live && live.state !== 'none') || (Number.isFinite(count) && index < count);
    if (!known) return notFound(`Referendum #${index} was not found. It may not exist yet.`);

    let status = row ? row.status : null;
    if (live && live.state === 'ongoing') status = 'Ongoing';
    else if (live && live.state === 'finished') status = live.approved ? 'Passed' : 'NotPassed';
    else if (live && live.state === 'none') status = 'Cancelled';
    else if (!status) status = 'Unknown';

    const end = (live && live.end) || (row && row.endBlock) || null;
    let tally = live && live.state === 'ongoing'
        ? { ayes: live.ayes, nays: live.nays, turnout: live.turnout, known: true }
        : { ayes: row && row.tallyKnown ? row.ayes : null, nays: row && row.tallyKnown ? row.nays : null, turnout: row && row.tallyKnown ? row.turnout : null, known: !!(row && row.tallyKnown) };
    let threshold = (live && live.threshold) || (row && row.threshold) || null;
    let delay = live && live.state === 'ongoing' ? live.delay : null;
    let bounded = live && live.state === 'ongoing' ? live.bounded : null;
    let proposalHash = live && live.state === 'ongoing' ? live.proposalHash : null;
    let archive = null;
    // Finished: the state one block before the end still holds it Ongoing,
    // with its call, threshold, delay and final tally (archive nodes only).
    if (ctx.chain && status !== 'Ongoing' && Number(end) > 1) {
        const hist = await safe(() => ctx.chain.referendumAt(index, Number(end) - 1));
        archive = !!(hist && hist.state === 'ongoing');
        if (archive) {
            if (!tally.known) tally = { ayes: hist.ayes, nays: hist.nays, turnout: hist.turnout, known: true };
            threshold = threshold || hist.threshold || null;
            delay = hist.delay;
            bounded = hist.bounded;
            proposalHash = hist.proposalHash;
        }
    }
    const thread = threadSummary(db, govThreadId('referendum', index));
    proposalHash = proposalHash || (thread && thread.proposalHash) || null;
    const { call, note } = await decode(ctx.chain, bounded, proposalHash);

    let enactmentConfirmed = false;
    if (status === 'Passed' && Number(end) > 0 && delay !== null && delay !== undefined) {
        enactmentConfirmed = !!safeSync(() => db.hasGovEnactmentEvent(Number(end) + Number(delay)));
    }
    return ok({
        kind: 'referendum', id: String(index), index,
        title: referendumTitle({ index, call: callLabel(call) }),
        status, endBlock: end, delay: delay === undefined ? null : delay,
        threshold, thresholdLabel: thresholdLabel(threshold),
        proposalHash, call, callNote: note,
        tally, electorate: Number(meta.totalIssuance) || null,
        currentBlock: ctx.currentBlock, blockMs: ctx.blockMs, now: Date.now(),
        timeline: referendumTimeline({ status, end, votingPeriod: ctx.consts.votingPeriod, launchPeriod: ctx.launchPeriod, delay, currentBlock: ctx.currentBlock, enactmentConfirmed }),
        threadId: govThreadId('referendum', index), thread,
        sources: { chain: !!ctx.chain, archive }
    });
}

function safeSync(fn) { try { return fn(); } catch (_) { return null; } }

// ---- public proposal -----------------------------------------------------------

export async function proposalDetail(rawIndex, deps) {
    const id = normalizeItemIndex(rawIndex);
    if (id === null) return badRequest('A proposal index is a whole number.');
    const index = Number(id);
    const { db } = deps;
    const meta = db.getKv('democracy_meta') || {};
    const snap = (Array.isArray(meta.publicProposals) ? meta.publicProposals : []).find(p => Number(p.index) === index) || null;
    const ctx = await chainContext(deps, meta);
    const live = ctx.chain ? await safe(() => ctx.chain.publicProp(index)) : null;
    const thread = threadSummary(db, govThreadId('proposal', index));
    const count = Number(meta.publicPropCount);
    const inQueue = live ? !live.absent : !!snap;
    if (!inQueue && !snap && !thread && !(Number.isFinite(count) && index < count)) {
        return notFound(`Public proposal #${index} was not found. It may not exist yet.`);
    }
    const dep = inQueue && ctx.chain ? await safe(() => ctx.chain.deposit(index)) : null;
    const proposer = (snap && snap.proposer) || (live && live.proposer) || null;
    const seconders = dep ? await named(deps, dep.seconders) : [];
    const seconds = dep ? dep.seconders.length : (snap ? Number(snap.seconds) || 0 : null);
    const proposalHash = (live && live.proposalHash) || (thread && thread.proposalHash) || null;
    const { call, note } = await decode(ctx.chain, live && live.bounded, proposalHash);
    const tabledAs = thread ? launchedReferendum(thread.links) : null;
    const nextLaunch = nextLaunchBlock(ctx.currentBlock, ctx.launchPeriod);
    const label = callLabel(call);
    return ok({
        kind: 'proposal', id: String(index), index,
        title: label ? `Public Proposal #${index}: ${label}` : `Public Proposal #${index}`,
        status: inQueue ? 'Queued' : (tabledAs !== null ? 'Tabled' : 'Gone'),
        proposer: proposer ? { address: proposer, name: snap && snap.proposerName && snap.proposerName !== 'Unknown' ? snap.proposerName : null } : null,
        seconds, seconders, deposit: dep ? dep.deposit : (snap ? Number(snap.deposit) || 0 : null),
        proposalHash, call, callNote: note, tabledAs, nextLaunch,
        currentBlock: ctx.currentBlock, blockMs: ctx.blockMs, now: Date.now(),
        timeline: proposalTimeline({ queued: inQueue, seconds, nextLaunch, tabledAs }),
        threadId: govThreadId('proposal', index), thread,
        sources: { chain: !!ctx.chain, archive: null }
    });
}

// ---- external proposal -----------------------------------------------------------

export async function externalDetail(rawHash, deps) {
    const hash = normalizeItemHash(rawHash);
    if (!hash) return badRequest('An external proposal is identified by its 32-byte proposal hash (0x followed by 64 hex digits).');
    const { db } = deps;
    const meta = db.getKv('democracy_meta') || {};
    const ctx = await chainContext(deps, meta);
    const live = ctx.chain ? await safe(() => ctx.chain.nextExternal()) : null;
    const snap = meta.externalProposal && normalizeItemHash(meta.externalProposal.proposalHash) === hash ? meta.externalProposal : null;
    const liveHit = live && !live.absent && normalizeItemHash(live.proposalHash) === hash ? live : null;
    const queued = live ? !!liveHit : !!snap;
    const thread = threadSummary(db, govThreadId('external', hash));
    if (!queued && !thread) return notFound('This external proposal was not found. Only proposals queued since discussion threads began (October 2026) are kept.');
    const threshold = (liveHit && liveHit.threshold) || (snap && snap.threshold) || null;
    const { call, note } = await decode(ctx.chain, liveHit && liveHit.bounded, hash);
    let launchedAs = thread ? launchedReferendum(thread.links) : null;
    if (launchedAs === null && thread && thread.closedReason) {
        const m = /referendum #(\d+)/.exec(thread.closedReason);
        if (m) launchedAs = Number(m[1]);
    }
    const motions = thread ? thread.links.earlier.filter(t => t.kind === 'motion') : [];
    const nextLaunch = nextLaunchBlock(ctx.currentBlock, ctx.launchPeriod);
    return ok({
        kind: 'external', id: hash, proposalHash: hash,
        title: externalTitle({ hash, call: callLabel(call), threshold }),
        status: queued ? 'Queued' : (launchedAs !== null ? 'Launched' : 'Gone'),
        threshold, thresholdLabel: thresholdLabel(threshold),
        call, callNote: note, launchedAs, nextLaunch, motions,
        currentBlock: ctx.currentBlock, blockMs: ctx.blockMs, now: Date.now(),
        timeline: externalTimeline({ queued, nextLaunch, launchedAs, proposedByMotion: motions.length > 0 }),
        threadId: govThreadId('external', hash), thread,
        sources: { chain: !!ctx.chain, archive: null }
    });
}

// ---- council / technical committee motion ------------------------------------------

const COLLECTIVE_LABEL = { council: 'Council Motion', technicalCommittee: 'Technical Committee Motion' };

export async function motionDetail(collective, rawId, deps) {
    if (!COLLECTIVE_LABEL[collective]) return badRequest('Unknown collective.');
    const asHash = normalizeItemHash(rawId);
    const asIndex = asHash ? null : normalizeItemIndex(rawId);
    if (!asHash && asIndex === null) return badRequest('A motion is identified by its call hash (0x followed by 64 hex digits) or its index.');
    const { db } = deps;
    const snap = db.getKv(collective) || {};
    const liveList = Array.isArray(snap.motions) ? snap.motions : [];
    const history = safeSync(() => db.getCollectiveMotions(collective)) || [];
    let hash = asHash;
    if (!hash) {
        const byIndex = liveList.find(m => String(m.index) === asIndex) || history.find(m => String(m.motionIndex) === asIndex);
        hash = byIndex ? normalizeItemHash(byIndex.hash) : null;
    }
    const open = hash ? liveList.find(m => normalizeItemHash(m.hash) === hash) || null : null;
    const rows = hash ? history.filter(m => normalizeItemHash(m.hash) === hash) : [];
    if (!open && !rows.length) return notFound(`${COLLECTIVE_LABEL[collective]} ${asHash ? 'with this hash' : '#' + asIndex} was not found.`);
    // The motion this page is about: the open one, else the one asked for by
    // index, else the newest with this hash. The others are listed as related.
    const wantIndex = open ? open.index : (asIndex !== null ? Number(asIndex) : (rows[0] ? rows[0].motionIndex : null));
    const row = rows.find(m => Number(m.motionIndex) === Number(wantIndex)) || rows[0] || null;
    const status = open ? 'proposed' : (row && row.status) || 'closed';
    const meta = db.getKv('democracy_meta') || {};
    const ctx = await chainContext(deps, { currentBlock: snap.currentBlock || meta.currentBlock, launchPeriod: meta.launchPeriod });
    const members = Array.isArray(snap.members) ? snap.members.map(m => ({ address: String(m.address), name: m.name && m.name !== 'Unknown' ? m.name : null })) : [];

    let call = open && open.section ? { section: open.section, method: open.method, args: (open.args || []).map(a => ({ name: a.name, type: null, value: a.value })) } : null;
    let voting = open ? { index: open.index, threshold: open.threshold, ayes: open.ayes || [], nays: open.nays || [], end: open.end || null } : null;
    let archive = null;
    // Closed: the call and the final vote are gone from storage; the state just
    // before the resolving block still has both (archive nodes only).
    if (!open && ctx.chain && row && Number(row.resolvedBlock) > 1) {
        const hist = await safe(() => ctx.chain.motionAt(collective, hash, Number(row.resolvedBlock) - 1));
        archive = !!(hist && (hist.call || hist.voting));
        if (hist && hist.call) call = hist.call;
        if (hist && hist.voting && (hist.voting.index === undefined || Number(hist.voting.index) === Number(row.motionIndex))) voting = hist.voting;
    }
    if (!call && row && row.section) call = { section: row.section, method: row.method, args: [] };

    const ayeList = voting ? await named(deps, voting.ayes, members) : null;
    const nayList = voting ? await named(deps, voting.nays, members) : null;
    const threshold = (voting && voting.threshold) || (row && row.threshold) || null;
    const ayes = voting ? voting.ayes.length : (row && row.ayes !== null && row.ayes !== undefined ? Number(row.ayes) : null);
    const nays = voting ? voting.nays.length : (row && row.nays !== null && row.nays !== undefined ? Number(row.nays) : null);
    const index = open ? open.index : (row ? row.motionIndex : null);
    const label = callLabel(call);
    const proposalHash = open && open.proposalHash ? open.proposalHash : null;
    const threadId = govThreadId('motion', hash, collective);
    return ok({
        kind: 'motion', collective, id: hash, hash, index,
        title: `${COLLECTIVE_LABEL[collective]}${index !== null && index !== undefined ? ' #' + index : ''}${label ? ': ' + label : ''}`,
        status, call, callNote: call ? null : 'The call is not indexed for this motion.',
        proposer: row && row.proposer ? { address: row.proposer, name: row.proposerName && row.proposerName !== 'Unknown' ? row.proposerName : null } : null,
        threshold, seats: members.length || null, ayes, nays,
        ayeVoters: ayeList, nayVoters: nayList,
        members: voting ? members.map(m => ({ ...m, vote: voting.ayes.map(String).includes(m.address) ? 'aye' : (voting.nays.map(String).includes(m.address) ? 'nay' : null) })) : null,
        endBlock: voting ? voting.end : null, proposedBlock: row ? row.proposedBlock : null, proposedAt: row ? row.proposedAt : null,
        resolvedBlock: row ? row.resolvedBlock : null, resolvedAt: row ? row.resolvedAt : null,
        proposalHash,
        related: rows.filter(m => m !== row).map(m => ({ index: m.motionIndex, status: m.status, resolvedBlock: m.resolvedBlock })).slice(0, 20),
        currentBlock: ctx.currentBlock, blockMs: ctx.blockMs, now: Date.now(),
        timeline: motionTimeline({ status, proposedBlock: row ? row.proposedBlock : null, end: voting ? voting.end : null, resolvedBlock: row ? row.resolvedBlock : null, currentBlock: ctx.currentBlock }),
        threadId, thread: threadSummary(db, threadId),
        sources: { chain: !!ctx.chain, archive }
    });
}

// ---- routes ---------------------------------------------------------------------

// deps: { db, chain, cacheShort(res), isFresh(query), serverError(res, err, ctx) }
export function registerGovDetailRoutes(app, deps) {
    const handle = (build) => async (req, res) => {
        try {
            const r = await build(req);
            if (r.status === 200 && !(deps.isFresh && deps.isFresh(req.query))) deps.cacheShort(res);
            else res.set('Cache-Control', 'no-store');
            res.status(r.status).json(r.body);
        } catch (err) {
            deps.serverError(res, err, req.path);
        }
    };
    app.get('/api/democracy/referendum/:index', handle(req => referendumDetail(req.params.index, deps)));
    app.get('/api/democracy/proposal/:index', handle(req => proposalDetail(req.params.index, deps)));
    app.get('/api/democracy/external/:hash', handle(req => externalDetail(req.params.hash, deps)));
    app.get('/api/council/motion/:id', handle(req => motionDetail('council', req.params.id, deps)));
    app.get('/api/technical-committee/motion/:id', handle(req => motionDetail('technicalCommittee', req.params.id, deps)));
}
