// What is a NEW event, as opposed to one that merely happens to be in the
// database right now?
//
// This module exists because of a specific way the email dispatcher can go
// catastrophically wrong. `dispatchToSubscribers` is idempotent per
// (eventKind, eventId, subscriberId) — the email_dispatches table guarantees a
// given subscriber gets a given event once. That protects against re-sending.
// It does NOT protect against sending the first time for something that
// happened two years ago.
//
// The six dispatchers added for the "all nine preferences actually work"
// change read from tables that hold FULL HISTORY:
//
//     db.getTreasuryProposals()  → every proposal since genesis
//     db.getCouncilMotions()     → every motion since genesis
//     db.getDemocracyReferenda() → every referendum, including decided ones
//
// A dispatcher that loops those and sends "new treasury proposal!" would, on
// the first tick after deploy, mail every confirmed subscriber once per
// historical row. Hundreds of emails per person, all announcing things that
// concluded long ago. That is not a bug you apologise for and move on from —
// it is a spam complaint rate that gets the sending domain blocked, and it is
// unrecoverable because the idempotency table then records them as sent.
//
// Two independent guards, because one is not enough:
//
//   1. WATERMARK. On the first run for an event kind we record where history
//      currently ends and send NOTHING. Only rows above that mark are ever
//      dispatched. This is what makes deploying safe.
//
//   2. FRESHNESS. Even above the watermark, an event whose own timestamp is
//      older than a cutoff is not mailed. This catches the case where the
//      watermark is lost or reset (a wiped kv row, a restored backup, a
//      renamed event kind) — the blast radius becomes "nothing" rather than
//      "everything".
//
// Guard 1 alone fails on a restored backup. Guard 2 alone fails for rows with
// no usable timestamp. Together they degrade to sending nothing, which is the
// correct direction to fail in.

// `Number(null)` is 0 and `Number('')` is 0, and 0 is a legitimate referendum
// index / proposal id. So a row whose id is NULL — which several of these
// tables permit — would otherwise read as a real id 0 and get announced as
// "#0". Every numeric coercion in this module goes through here.
function numericOrNaN(value) {
    if (value === null || value === undefined || value === '') return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}

// A referendum has finished when its status is no longer an open one. Kept
// separate from lib/gov-status.js's isOpenGovStatus because "not open" is not
// quite "decided" — a row with a missing or unrecognised status must not be
// announced as a result.
const TERMINAL_REF_STATUSES = new Set([
    'passed', 'notpassed', 'not passed', 'executed', 'cancelled', 'canceled', 'rejected', 'failed', 'vetoed'
]);

export function isTerminalRefStatus(status) {
    if (status == null) return false;
    return TERMINAL_REF_STATUSES.has(String(status).trim().toLowerCase());
}

// Human wording for a finished referendum, so the email subject doesn't just
// echo a raw chain enum.
export function describeRefOutcome(status) {
    const s = String(status == null ? '' : status).trim().toLowerCase();
    if (s === 'passed' || s === 'executed') return 'passed';
    if (s === 'notpassed' || s === 'not passed' || s === 'rejected' || s === 'failed') return 'did not pass';
    if (s === 'cancelled' || s === 'canceled') return 'was cancelled';
    if (s === 'vetoed') return 'was vetoed';
    return 'was decided';
}

// Is this event recent enough to be worth an email?
//
// `timestamp` may legitimately be absent — several tables allow NULL for rows
// the indexer backfilled without block times. An unknown age is treated as too
// old ON PURPOSE: we would rather stay silent about something real than
// announce something ancient.
export function isFresh(timestamp, nowMs, maxAgeMs) {
    const ts = numericOrNaN(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    if (!Number.isFinite(Number(maxAgeMs)) || Number(maxAgeMs) <= 0) return false;
    const age = Number(nowMs) - ts;
    // A timestamp in the future is a clock-skew or unit mistake (seconds
    // stored where milliseconds were expected). Don't mail on it.
    if (age < 0) return false;
    return age <= Number(maxAgeMs);
}

// A watermark is the wrong shape for "this thing finished".
//
// Referendum rows carry no timestamp at all — only `end_block` — so neither
// guard above applies, and the index order is not the resolution order anyway:
// referendum #7 can be cancelled while #5 is still open. What we need is a
// transition, so we remember which ids have already been announced.
//
// First run adopts every currently-resolved id and announces nothing, for the
// same reason as the watermark: on a fresh database "resolved" describes the
// entire history of the chain.
//
//   seen — array of ids already announced, or null/undefined on first run
//
// Returns { dispatch, nextSeen, firstRun }. `nextSeen` is bounded, keeping the
// highest `remember` ids: the kv row must not grow without limit, and an id
// far below the current maximum cannot resolve again.
export function selectNewlyResolved({
    items, idOf, isResolved, seen, limit = 25, remember = 500
} = {}) {
    const rows = Array.isArray(items) ? items : [];

    const resolvedIds = [];
    for (const item of rows) {
        const id = numericOrNaN(idOf ? idOf(item) : null);
        if (!Number.isFinite(id)) continue;
        if (isResolved && isResolved(item)) resolvedIds.push(id);
    }

    const bound = ids => ids.slice().sort((a, b) => b - a).slice(0, Math.max(1, Number(remember) || 1));

    if (seen === null || seen === undefined || !Array.isArray(seen)) {
        return { dispatch: [], nextSeen: bound(resolvedIds), firstRun: true };
    }

    const known = new Set(seen.map(numericOrNaN).filter(Number.isFinite));
    const fresh = [];
    for (const item of rows) {
        const id = numericOrNaN(idOf ? idOf(item) : null);
        if (!Number.isFinite(id)) continue;
        if (!isResolved || !isResolved(item)) continue;
        if (known.has(id)) continue;
        fresh.push({ item, id });
    }
    fresh.sort((a, b) => a.id - b.id);
    const capped = fresh.slice(0, Math.max(0, Number(limit) || 0));

    // Only the ids actually announced are marked seen. One held back by the
    // cap must still be announced on a later tick.
    return {
        dispatch: capped.map(r => r.item),
        nextSeen: bound([...known, ...capped.map(r => r.id)]),
        firstRun: false
    };
}

// The core decision. Returns the items to dispatch AND the watermark to store.
//
//   items        — rows straight from the database, any order
//   rankOf       — monotonically increasing id for the row (proposal id,
//                  motion index, referendum index). Rows without a finite rank
//                  are skipped entirely.
//   timeOf       — row timestamp in ms, or null/undefined if unknown
//   baseline     — the stored watermark, or null/undefined on first run
//   nowMs        — current time
//   maxAgeMs     — freshness cutoff
//   limit        — hard cap on emails per tick, so a burst (or a bug) cannot
//                  turn into an unbounded send. Older items win, since they
//                  are closest to ageing out.
//
// Returns { dispatch, nextBaseline, firstRun, suppressed }.
export function selectDispatchable({
    items, rankOf, timeOf, baseline, nowMs = Date.now(), maxAgeMs, limit = 25
} = {}) {
    const rows = Array.isArray(items) ? items : [];

    const ranked = [];
    let highest = null;
    for (const item of rows) {
        const rank = numericOrNaN(rankOf ? rankOf(item) : null);
        if (!Number.isFinite(rank)) continue;
        if (highest === null || rank > highest) highest = rank;
        ranked.push({ item, rank });
    }

    const hasBaseline = Number.isFinite(numericOrNaN(baseline));

    // FIRST RUN — adopt the current end of history and send nothing. This is
    // the whole reason the module exists; do not "helpfully" send the newest
    // one, because on a fresh database that is still an arbitrary historical
    // row.
    if (!hasBaseline) {
        return {
            dispatch: [],
            nextBaseline: highest,
            firstRun: true,
            suppressed: ranked.length
        };
    }

    const mark = numericOrNaN(baseline);
    const above = ranked.filter(r => r.rank > mark).sort((a, b) => a.rank - b.rank);
    const fresh = above.filter(r => isFresh(timeOf ? timeOf(r.item) : null, nowMs, maxAgeMs));

    const capped = fresh.slice(0, Math.max(0, Number(limit) || 0));

    // Advance the watermark past everything we CONSIDERED, not just what we
    // sent. An item that was above the mark but too old is a decision, not a
    // backlog — leaving it below the watermark would make us re-evaluate it
    // every tick forever. Items dropped by `limit` stay below the mark so the
    // next tick picks them up.
    // NOTE the `capped.length ?` guard. Without it, a zero limit (or a limit
    // that filtered everything out) indexes capped[-1] and throws on `.rank`
    // — inside the indexer tick, which would take the whole sync down. Caught
    // by test/email-events.test.js, not by reading it.
    const consideredMax = capped.length < fresh.length
        ? (capped.length ? capped[capped.length - 1].rank : mark)
        : (above.length ? above[above.length - 1].rank : mark);

    return {
        dispatch: capped.map(r => r.item),
        nextBaseline: Math.max(mark, Number.isFinite(consideredMax) ? consideredMax : mark),
        firstRun: false,
        suppressed: above.length - capped.length
    };
}
