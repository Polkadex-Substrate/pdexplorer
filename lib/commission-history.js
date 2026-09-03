// Has this validator moved its commission, and which way?
//
// WHY THIS EXISTS — a real nominator complaint, not an audit finding:
//
//   "The validator rewards list is absolutely useless and inaccurate. It's
//    absolutely pointless staking when every validator changes rewards amount
//    to 1 percent the day after you nominate them."
//
// The list showed exactly one commission number: the CURRENT one. So a
// validator that has sat at 1% for forty eras and a validator that dropped to
// 1% yesterday to attract nominations rendered identically, and a validator
// that raised commission to 20% last era looked no different from one that
// never has. Every APY on that page is derived from the current commission
// (F-044), so the whole column inherits the same blind spot: it is a snapshot
// presented where a nominator needs a track record.
//
// Nothing was inaccurate in the sense of "wrong number". It was worse than
// that — the number was right and the IMPRESSION was wrong, which is the kind
// of thing a user can only describe as "useless" because they cannot point at
// the field that lied to them.
//
// We already had the data. `validator_history` UPSERTs one row per (era,
// validator) and never deletes, so it holds every era the indexer has ever
// scanned; audit F-115 made the commission-cross triggers derive from all of it
// rather than a 30-era window. This module turns that history into the two or
// three facts a nominator actually needs before they bond.
//
// Pure functions over already-fetched rows. The SQL lives in db.js.

// Commission moves smaller than this are treated as noise rather than a change.
//
// Substrate stores commission as a Perbill, so a UI value of "1%" is really
// 10,000,000/1e9 and round-tripping through REAL can leave a few
// hundred-thousandths behind. Counting that as a "commission change" would
// slander every honest validator on the list, which is a worse failure than
// missing a genuinely trivial adjustment.
export const COMMISSION_EPSILON = 0.01;   // 0.01 percentage points

// Was this validator actually elected in this era?
//
// `staking.erasValidatorPrefs` is a ValueQuery: asking it about an era in which
// a validator held no slot returns DEFAULT prefs — 0% commission, 0 stake —
// rather than "no answer". The indexer walks the CURRENT validator set back N
// eras, so every recently-elected validator carries a run of
// `{commission: 0, stake: 0}` rows for the eras before it joined. Read as
// history, that is a validator who "ran 0% and then raised", which is a
// fabricated track record for the crime of being new.
//
// Exported because getting this wrong is the repo's most-repeated mistake:
// round 2 fixed it in summarizeCommissionHistory (the validators LIST) and
// round 3 (F-198) found the scorecard and the spike triggers — the DETAIL page,
// where a nominator confirms the choice — still walking the unfiltered rows.
// The two disagreed on the same validator. One predicate, imported by every
// consumer, is the only version of this fix that stays fixed.
//
// Rows arriving WITHOUT a stake field are KEPT: a caller that did not select
// the column should not have its history silently emptied. So the guard tests a
// PRESENT value rather than truthiness.
export function wasElectedInEra(row) {
    if (!row) return false;
    if (row.stake === undefined || row.stake === null) return true;
    return Number(row.stake) > 0;
}

// Summarise one validator's per-era commission history.
//
//   rows — [{ era, commission }] in any order. `commission` is a percentage
//          (0–100), matching what validator_history stores.
//
// Returns:
//   {
//     erasTracked,        how many eras we have, i.e. how much to trust this
//     current,            commission in the newest era we hold
//     min, max,           range over tracked eras
//     changes,            number of era-to-era moves beyond the epsilon
//     raises, cuts,       split by direction
//     lastChange,         { era, from, to } of the most recent move, or null
//     volatility          'stable' | 'moved' | 'volatile' | 'unknown'
//   }
//
// `volatility` is deliberately coarse. A precise number invites false
// precision — the honest signal is "this one has a history of moving", and the
// nominator can open the validator page for the actual series.
export function summarizeCommissionHistory(rows) {
    const series = (Array.isArray(rows) ? rows : [])
        .filter(r => r && isRealNumber(r.era) && isRealNumber(r.commission))
        // Eras the validator was not actually elected in are NOT history.
        //
        // staking.erasValidatorPrefs is a ValueQuery, so querying an era in
        // which this validator held no slot returns default prefs — 0%. The
        // indexer's scan walks the CURRENT validator set back N eras, so a
        // validator that joined recently carries a run of {commission: 0,
        // stake: 0} rows for the eras before it joined. Treated as history that
        // reads as "raised from 0% to 1%", which would badge a brand-new
        // validator RAISED RECENTLY for the crime of being elected.
        //
        // stake > 0 is the discriminator, and it is the same one
        // computeValidatorScorecard uses. Rows arriving WITHOUT a stake field
        // are kept — a caller that did not select the column should not have
        // its history silently emptied — so the guard is `!== 0` on a present
        // value rather than a truthiness test.
        .filter(wasElectedInEra)
        .map(r => ({ era: Number(r.era), commission: Number(r.commission) }))
        .sort((a, b) => a.era - b.era);

    if (series.length === 0) {
        return {
            erasTracked: 0, eraSpan: 0, gaps: 0, current: null, min: null, max: null,
            changes: 0, raises: 0, cuts: 0, lastChange: null, volatility: 'unknown'
        };
    }

    let changes = 0, raises = 0, cuts = 0, lastChange = null;
    let gaps = 0;
    for (let i = 1; i < series.length; i++) {
        const prevEra = series[i - 1].era;
        const era = series[i].era;
        if (era - prevEra > 1) gaps++;
        const prev = series[i - 1].commission;
        const cur = series[i].commission;
        if (Math.abs(cur - prev) < COMMISSION_EPSILON) continue;
        changes++;
        if (cur > prev) raises++; else cuts++;
        // The loop compares consecutive ROWS, which are not always consecutive
        // ERAS — the indexer can miss eras (a per-era query failure is logged
        // and skipped) and a fresh database has a seam between its seeded rows
        // and the eras scanned at boot.
        //
        // So a change is only known to have happened SOMEWHERE in
        // (prevEra, era]. Recording it as "era" alone would let a five-month-old
        // change be dated to the first era after the gap and badged RAISED
        // RECENTLY. `era` stays for display (the earliest era we have EVIDENCE
        // of the new value), and `earliestEra` carries the honest lower bound
        // that raisedRecently must use.
        lastChange = {
            era, from: prev, to: cur,
            earliestEra: prevEra + 1,
            certain: (era - prevEra) === 1
        };
    }

    const values = series.map(s => s.commission);
    return {
        erasTracked: series.length,
        // How many eras the tracked rows SPAN, and how many holes are in them.
        // "60 tracked eras" over a 145-era span is a different claim from 60
        // consecutive eras, and the UI must not present them identically.
        eraSpan: series[series.length - 1].era - series[0].era + 1,
        gaps,
        current: series[series.length - 1].commission,
        min: Math.min(...values),
        max: Math.max(...values),
        changes, raises, cuts, lastChange,
        volatility: classifyVolatility({ erasTracked: series.length, changes, values })
    };
}

// 'unknown' when we do not have enough history to say anything — which is a
// real answer and must not be dressed up as 'stable'. A validator we have
// tracked for two eras has not "been stable"; we just have not been watching.
export function classifyVolatility({ erasTracked, changes, values }) {
    if (!erasTracked || erasTracked < 3) return 'unknown';
    if (changes === 0) return 'stable';
    const spread = Math.max(...values) - Math.min(...values);
    // Two-plus moves, or one move that materially changes the payout.
    if (changes >= 2 || spread >= 5) return 'volatile';
    return 'moved';
}

// Did this validator raise commission recently enough that a nominator who
// bonded before it would be affected?
//
// `withinEras` defaults to 7 — roughly a week on a one-era-per-day chain, and
// close to the "the day after you nominate them" the complaint describes.
export function raisedRecently(summary, currentEra, withinEras = 7) {
    if (!summary || !summary.lastChange) return false;
    if (summary.lastChange.to <= summary.lastChange.from) return false;   // a cut
    if (!isRealNumber(currentEra)) return false;
    // Don't claim recency on a history too thin to classify. A review caught
    // the first version badging RAISED RECENTLY on a two-era history while the
    // very same cell rendered "history not yet indexed" underneath it.
    if (summary.volatility === 'unknown') return false;
    // The EARLIEST era the change could have happened in. Using lastChange.era
    // would date a change that occurred somewhere inside a 40-era gap to the
    // first era after that gap, and badge a months-old raise as recent.
    const bound = isRealNumber(summary.lastChange.earliestEra)
        ? Number(summary.lastChange.earliestEra)
        : Number(summary.lastChange.era);
    return (Number(currentEra) - bound) <= withinEras;
}

// Has the validator's CURRENT on-chain commission already moved away from the
// newest era we have history for?
//
// erasValidatorPrefs is stamped at the start of an era, so a raise made today
// does not appear in history until the next era boundary — roughly 24h on this
// chain. That is precisely the window the complaint describes ("the day after
// you nominate them"), so the feature would otherwise be structurally one era
// late for its own motivating case.
//
// The validators list already carries the live commission (read from current
// prefs) alongside this history. Comparing the two costs nothing and closes
// the gap.
export function pendingRaise(summary, liveCommission) {
    if (!summary || !isRealNumber(liveCommission) || !isRealNumber(summary.current)) return false;
    return (Number(liveCommission) - Number(summary.current)) >= COMMISSION_EPSILON;
}

// Is this a genuine number, as opposed to something Number() will silently
// turn into one?
//
// `Number.isFinite(Number(x))` is the obvious guard and it is WRONG here,
// because Number(null) is 0, Number('') is 0, Number(false) is 0 and Number([])
// is 0. My own tests caught two bugs from exactly that:
//
//   * a history row with `commission: null` — which is what SQLite hands back
//     for a NULL column — passed the filter as 0, so the summary reported a
//     validator dropping to 0% commission and back. On a page nominators use to
//     choose where to stake, inventing a 0% commission is worse than showing
//     nothing.
//
//   * `raisedRecently(summary, null)` returned TRUE, because era 0 minus the
//     change era is negative and negative is "within 7". A missing activeEra
//     would have badged every validator that ever raised commission as having
//     raised it RECENTLY.
//
// Both failures point the same way: toward a confident claim built on absent
// data, which is the thing this whole module exists to stop doing.
function isRealNumber(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return false;
    return Number.isFinite(Number(v));
}

// One short, plain-language sentence for the UI. Returns '' when there is
// nothing worth saying, so the caller can render nothing rather than "no data".
//
// Deliberately states the EVIDENCE ("raised 3× in 30 eras, 1–20%") rather than
// a verdict ("untrustworthy"). We are an explorer: the nominator makes the
// judgement, we make sure they have the facts. Calling a validator bad on a
// page they cannot reply on is not our call to make.
export function describeCommissionHistory(summary) {
    if (!summary || summary.volatility === 'unknown') return '';
    if (summary.volatility === 'stable') {
        return (summary.gaps > 0 && summary.eraSpan > summary.erasTracked)
            ? `unchanged across ${summary.erasTracked} of ${summary.eraSpan} tracked eras`
            : `unchanged across ${summary.erasTracked} tracked eras`;
    }
    const parts = [];
    if (summary.raises) parts.push(`raised ${summary.raises}×`);
    if (summary.cuts) parts.push(`cut ${summary.cuts}×`);
    const range = (summary.min === summary.max)
        ? `${summary.min.toFixed(2)}%`
        : `${summary.min.toFixed(2)}–${summary.max.toFixed(2)}%`;
    // Say "of N" when the tracked eras do not cover their own span. "60 tracked
    // eras" reads as sixty consecutive eras; if they are spread across 145 with
    // holes, the reader is entitled to know before drawing a conclusion.
    const coverage = (summary.gaps > 0 && summary.eraSpan > summary.erasTracked)
        ? `${summary.erasTracked} of ${summary.eraSpan}`
        : `${summary.erasTracked}`;
    return `${parts.join(', ')} in ${coverage} tracked eras · range ${range}`;
}
