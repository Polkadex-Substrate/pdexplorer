// Governance item pages: one permalink per referendum, public proposal,
// external proposal and council (or Technical Committee) motion.
//
//   /democracy/referendum/<index>
//   /democracy/proposal/<index>
//   /democracy/external/<proposalHash>
//   /council/motion/<motionHash>        (a motion index also resolves)
//   /council/tc-motion/<motionHash>     (Technical Committee; no thread)
//
// Path routes, like /discussions/<id> and /block/<n>: routeTo() matches the
// path, and the query (?post=N) and #discussion ride along untouched.
//
// This file is the shared, import-free part: route parsing, the API path and
// thread id of an item, the vote arithmetic behind the charts, block-time
// estimates and the lifecycle timelines. server.js (lib/gov-detail-api.js)
// builds the timelines; the browser (lib/gov-detail-view.js) renders them.
// Tests: test/gov-detail.test.js.

export const DEFAULT_BLOCK_MS = 12000;

const HASH32 = /^0x[0-9a-f]{64}$/i;
const INDEX = /^\d{1,9}$/;

export function normalizeItemHash(h) {
    const s = String(h == null ? '' : h);
    return HASH32.test(s) ? s.toLowerCase() : null;
}
export function normalizeItemIndex(i) {
    const s = String(i == null ? '' : i);
    return INDEX.test(s) ? String(Number(s)) : null;
}

// "democracy/referendum/12", "/council/motion/0x..?post=3#discussion", ...
// -> { kind, id, collective? } or null.
export function parseGovRoute(target) {
    const path = String(target || '').split(/[?#]/)[0].replace(/^\/+/, '').replace(/\/+$/, '');
    const parts = path.split('/');
    if (parts.length !== 3) return null;
    const [area, type, raw] = parts;
    if (area === 'democracy') {
        if (type === 'referendum' || type === 'proposal') {
            const id = normalizeItemIndex(raw);
            return id === null ? null : { kind: type, id };
        }
        if (type === 'external') {
            const id = normalizeItemHash(raw);
            return id ? { kind: 'external', id } : null;
        }
        return null;
    }
    if (area === 'council' && (type === 'motion' || type === 'tc-motion')) {
        const id = normalizeItemHash(raw) || normalizeItemIndex(raw);
        if (id === null) return null;
        return { kind: 'motion', id, collective: type === 'motion' ? 'council' : 'technicalCommittee' };
    }
    return null;
}

// The query-string links used before these pages existed (emails already
// sent, calendar entries, bookmarks): /democracy?ref=N, /democracy?proposal=N,
// /council?motion=N, /council?tcmotion=N -> the item's page (without the
// leading slash), or null.
export function legacyGovRedirect(path, search) {
    const p = String(path || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (p !== 'democracy' && p !== 'council') return null;
    let q;
    try { q = new URLSearchParams(search || ''); } catch (_) { return null; }
    const get = (k) => normalizeItemIndex(q.get(k));
    if (p === 'democracy') {
        if (get('ref') !== null) return `democracy/referendum/${get('ref')}`;
        if (get('proposal') !== null) return `democracy/proposal/${get('proposal')}`;
        return null;
    }
    if (get('motion') !== null) return `council/motion/${get('motion')}`;
    if (get('tcmotion') !== null) return `council/tc-motion/${get('tcmotion')}`;
    return null;
}

export function isGovDetailRoute(target) {
    return parseGovRoute(target) !== null;
}

// The page path of an item.
export function govItemPath(kind, id, collective = 'council') {
    const enc = encodeURIComponent(String(id));
    if (kind === 'referendum') return `/democracy/referendum/${enc}`;
    if (kind === 'proposal') return `/democracy/proposal/${enc}`;
    if (kind === 'external') return `/democracy/external/${enc}`;
    if (kind === 'motion') return collective === 'technicalCommittee' ? `/council/tc-motion/${enc}` : `/council/motion/${enc}`;
    return '';
}

// The JSON behind a page.
export function govApiPath(route) {
    if (!route) return '';
    const enc = encodeURIComponent(String(route.id));
    if (route.kind === 'referendum') return `/api/democracy/referendum/${enc}`;
    if (route.kind === 'proposal') return `/api/democracy/proposal/${enc}`;
    if (route.kind === 'external') return `/api/democracy/external/${enc}`;
    if (route.kind === 'motion') return route.collective === 'technicalCommittee' ? `/api/technical-committee/motion/${enc}` : `/api/council/motion/${enc}`;
    return '';
}

// The discussion thread an item has (the ids the indexer creates). Technical
// Committee motions have none.
export function govThreadId(kind, id, collective = 'council') {
    if (kind === 'referendum' || kind === 'proposal') return normalizeItemIndex(id) === null ? null : `${kind}-${Number(id)}`;
    if (kind === 'external') { const h = normalizeItemHash(id); return h ? `external-${h}` : null; }
    if (kind === 'motion' && collective === 'council') { const h = normalizeItemHash(id); return h ? `motion-${h}` : null; }
    return null;
}

// The page of the item a thread is about: lifecycle links on an item page
// point at item pages, not thread pages.
export function itemPathForThread(threadId) {
    const m = /^(proposal|referendum|external|motion)-(.+)$/.exec(String(threadId || ''));
    if (!m) return '';
    const path = govItemPath(m[1], m[2]);
    return parseGovRoute(path) ? path : '';
}

// ---- votes -----------------------------------------------------------------

const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };
const nonNeg = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0; };

// Aye vs nay share of the conviction-weighted tally (democracy's tally.ayes /
// tally.nays are already multiplied by conviction). One decimal, the two
// always summing to 100; no votes -> both 0 and empty.
export function ayeNaySplit(ayes, nays) {
    const a = nonNeg(ayes), n = nonNeg(nays), total = a + n;
    if (!total) return { aye: 0, nay: 0, total: 0, empty: true };
    const aye = round(a / total * 100, 1);
    return { aye, nay: round(100 - aye, 1), total, empty: false };
}

// Turnout (the PDEX that voted, before conviction) as a share of the
// electorate (total issuance). Two decimals, capped at 100; null when the
// electorate is unknown.
export function turnoutPercent(turnout, electorate) {
    const e = nonNeg(electorate);
    if (!e) return null;
    return Math.min(100, round(nonNeg(turnout) / e * 100, 2));
}

export const CONVICTION_MULTIPLIER = { None: 0.1, Locked1x: 1, Locked2x: 2, Locked3x: 3, Locked4x: 4, Locked5x: 5, Locked6x: 6 };

// Votes one standard vote adds to the tally: balance x conviction.
export function weightedVotes(balance, conviction) {
    const m = CONVICTION_MULTIPLIER[String(conviction)];
    return m === undefined ? null : round(nonNeg(balance) * m, 4);
}

// Whether the tally passes its threshold right now (democracy's
// adaptive quorum biasing):
//   SimpleMajority        ayes > nays
//   SuperMajorityApprove  nays / sqrt(turnout) < ayes / sqrt(electorate)
//   SuperMajorityAgainst  nays / sqrt(electorate) < ayes / sqrt(turnout)
// 'passing' | 'failing', or null when it cannot be computed.
export function approvalState({ ayes, nays, turnout, electorate, threshold }) {
    const a = nonNeg(ayes), n = nonNeg(nays), t = nonNeg(turnout), e = nonNeg(electorate);
    const th = String(threshold || '');
    if (th === 'SimpleMajority') return a > n ? 'passing' : 'failing';
    if (th !== 'SuperMajorityApprove' && th !== 'SuperMajorityAgainst') return null;
    if (!a) return 'failing';
    if (!t || !e) return null;
    const pass = th === 'SuperMajorityApprove'
        ? n / Math.sqrt(t) < a / Math.sqrt(e)
        : n / Math.sqrt(e) < a / Math.sqrt(t);
    return pass ? 'passing' : 'failing';
}

// A collective motion's progress: ayes towards the threshold, nays towards
// the count that makes the threshold unreachable (seats - threshold + 1).
export function motionProgress({ ayes, nays, threshold, seats }) {
    const a = nonNeg(ayes), n = nonNeg(nays), th = nonNeg(threshold), s = nonNeg(seats);
    const toReject = th && s ? Math.max(1, s - th + 1) : null;
    return {
        ayes: a, nays: n, threshold: th || null, seats: s || null, toReject,
        ayePct: th ? Math.min(100, round(a / th * 100, 1)) : 0,
        nayPct: toReject ? Math.min(100, round(n / toReject * 100, 1)) : 0,
        decided: th && a >= th ? 'approved' : (toReject && n >= toReject ? 'rejected' : null)
    };
}

// ---- time ------------------------------------------------------------------

export function blockEta(block, currentBlock, blockMs = DEFAULT_BLOCK_MS) {
    const b = Number(block), c = Number(currentBlock);
    if (!Number.isFinite(b) || !Number.isFinite(c) || c <= 0 || b < 0) return null;
    const blocks = b - c;
    return { blocks, ms: blocks * (Number(blockMs) > 0 ? Number(blockMs) : DEFAULT_BLOCK_MS), past: blocks <= 0 };
}

export function humanDuration(ms) {
    const m = Math.abs(Number(ms) || 0) / 60000;
    if (m < 90) { const v = Math.max(1, Math.round(m)); return `${v} minute${v === 1 ? '' : 's'}`; }
    const h = m / 60;
    if (h < 48) { const v = Math.round(h); return `${v} hour${v === 1 ? '' : 's'}`; }
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'}`;
}

// "in about 3 days" / "about 2 hours ago" / "" when unknown.
export function etaText(block, currentBlock, blockMs) {
    const e = blockEta(block, currentBlock, blockMs);
    if (!e) return '';
    if (e.blocks === 0) return 'now';
    return e.past ? `about ${humanDuration(e.ms)} ago` : `in about ${humanDuration(e.ms)}`;
}

// The next launch-period boundary after currentBlock: when democracy tables
// the next referendum (from the public queue or the external slot, in turn).
export function nextLaunchBlock(currentBlock, launchPeriod) {
    const c = Number(currentBlock), lp = Number(launchPeriod);
    if (!(c > 0) || !(lp > 0)) return null;
    return c - (c % lp) + lp;
}

// ---- timelines (built by the server, rendered by the page) -------------------
// Each step: { key, label, block, state: 'done'|'current'|'upcoming'|'unknown', note }.

const step = (key, label, block, state, note) => ({ key, label, block: Number.isFinite(Number(block)) && block !== null ? Number(block) : null, state, note: note || '' });

export function referendumTimeline({ status, end, votingPeriod, launchPeriod, delay, currentBlock, enactmentConfirmed }) {
    const out = [];
    const endB = Number(end) > 0 ? Number(end) : null;
    const vp = Number(votingPeriod) > 0 ? Number(votingPeriod) : null;
    const lp = Number(launchPeriod) > 0 ? Number(launchPeriod) : null;
    const cur = Number(currentBlock) || 0;
    // A referendum launched at a launch-period boundary started there and runs
    // one voting period; anything else was fast-tracked (custom period).
    if (endB && vp) {
        const start = endB - vp;
        if (start > 0 && (!lp || start % lp === 0)) out.push(step('start', 'Voting started', start, cur >= start ? 'done' : 'upcoming', lp ? '' : 'estimated from the voting period'));
        else out.push(step('start', 'Voting started', null, 'unknown', 'fast-tracked: the start block is not recorded'));
    }
    const ongoing = status === 'Ongoing';
    if (endB) out.push(step('end', ongoing ? 'Voting ends' : 'Voting ended', endB, cur >= endB ? 'done' : 'current'));
    if (status === 'Passed') out.push(step('outcome', 'Passed', endB, 'done'));
    else if (status === 'NotPassed') out.push(step('outcome', 'Failed (not passed)', endB, 'done'));
    else if (status === 'Cancelled') out.push(step('outcome', 'Cancelled', null, 'done', 'removed from storage before it ended'));
    else if (ongoing) out.push(step('outcome', 'Result', endB, 'upcoming', 'decided at the end of voting'));
    if (ongoing || status === 'Passed') {
        const d = Number(delay);
        const enact = endB && Number.isFinite(d) && d >= 0 && delay !== null && delay !== undefined ? endB + d : null;
        if (!enact) out.push(step('enact', 'Enactment', null, 'unknown', status === 'Passed' ? 'enactment delay not recorded (needs an archive node)' : 'if passed'));
        else if (ongoing) out.push(step('enact', 'Enacts if passed', enact, 'upcoming'));
        else if (enactmentConfirmed) out.push(step('enact', 'Enacted', enact, 'done'));
        else if (cur >= enact) out.push(step('enact', 'Enactment due', enact, 'done', 'dispatch not confirmed by the index'));
        else out.push(step('enact', 'Enacts', enact, 'upcoming'));
    }
    return out;
}

const MOTION_OUTCOME = { executed: 'Executed', approved: 'Approved', disapproved: 'Disapproved', closed: 'Closed', resolved: 'Resolved (left storage)' };
export function motionTimeline({ status, proposedBlock, end, resolvedBlock, currentBlock }) {
    const out = [];
    const cur = Number(currentBlock) || 0;
    out.push(proposedBlock ? step('proposed', 'Proposed', proposedBlock, 'done') : step('proposed', 'Proposed', null, 'unknown', 'proposing block not indexed'));
    const open = !status || status === 'proposed' || status === 'open';
    if (Number(end) > 0) out.push(step('end', open ? 'Voting ends' : 'Voting period ended', end, cur >= Number(end) ? 'done' : 'current'));
    if (open) out.push(step('outcome', 'Closed and decided', null, 'upcoming', 'any member can close it once the vote is decided or has ended'));
    else out.push(step('outcome', MOTION_OUTCOME[status] || 'Closed', resolvedBlock || null, resolvedBlock ? 'done' : 'unknown'));
    return out;
}

export function proposalTimeline({ queued, seconds, nextLaunch, tabledAs }) {
    const out = [step('proposed', 'Proposed', null, 'done')];
    if (Number.isFinite(Number(seconds)) && seconds !== null) out.push(step('seconded', `Seconded ${Number(seconds)} time${Number(seconds) === 1 ? '' : 's'}`, null, 'done'));
    if (tabledAs !== null && tabledAs !== undefined) out.push(step('tabled', `Tabled as referendum #${tabledAs}`, null, 'done'));
    else if (queued) out.push(step('tabled', 'Tabled at the next launch, if it is the most-seconded proposal and the public queue\'s turn', nextLaunch, 'upcoming'));
    else out.push(step('tabled', 'Left the queue (tabled or cleared)', null, 'done'));
    return out;
}

export function externalTimeline({ queued, nextLaunch, launchedAs, proposedByMotion }) {
    const out = [step('proposed', proposedByMotion ? 'Queued by a council motion' : 'Queued as the external proposal', null, 'done')];
    if (launchedAs !== null && launchedAs !== undefined) out.push(step('launch', `Launched as referendum #${launchedAs}`, null, 'done'));
    else if (queued) out.push(step('launch', 'Launches at the next launch period, or earlier by Technical Committee fast-track', nextLaunch, 'upcoming'));
    else out.push(step('launch', 'Left the external slot', null, 'done'));
    return out;
}

// The referendum a closed external / proposal thread says it became, from
// the lifecycle links (thread ids referendum-N).
export function launchedReferendum(links) {
    const later = links && Array.isArray(links.later) ? links.later : [];
    const r = later.find(t => /^referendum-\d+$/.test(String(t && t.id)));
    return r ? Number(String(r.id).slice('referendum-'.length)) : null;
}
