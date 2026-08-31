// Is an analytics timeseries payload actually carrying data?
//
// This exists because of a bug I shipped to production and then found with a
// post-deploy check, and the shape of the mistake is worth recording.
//
// F-081 was: an EMPTY pre-warmed series (`[]`) was served as though it were an
// answer and cached at the edge for the medium TTL, so a fresh or still-
// backfilling deployment drew a flat chart labelled with real dates — "no
// activity on this chain" rather than "not indexed yet". The fix guarded the
// cache-hit branch on the series being non-empty.
//
// I wrote that guard as `Array.isArray(cached.series) && cached.series.length`.
// `db.getDailyAnalytics()` does not return an array. It returns an OBJECT of
// named series:
//
//   { txCount: [...], txVolume: [...], blocks: [...],
//     avgExtrinsics: [...], activeAddresses: [...], treasuryAwarded: [...] }
//
// so the guard was false for every response ever produced. The cache-hit branch
// became unreachable, the pre-warmed KV was never served, and EVERY request
// fell through to the live aggregate — a GROUP BY over `blocks` and
// `transactions` filtered on `timestamp`, on a database whose timestamp indexes
// are deliberately not built above 200k rows. Precisely the cost the pre-warm
// exists to avoid, reintroduced by the fix meant to make it honest.
//
// The unit test agreed with the bug, because I wrote it from the same wrong
// assumption; only hitting the deployed endpoint and reading `cache-control`
// (max-age=5, the fallthrough, rather than max-age=30, the hit) showed it. That
// is the argument for checking a shape against the producer rather than against
// one's memory of it.
//
// So: one shape-agnostic predicate, next to a test that feeds it the REAL
// output of getDailyAnalytics.

// True when `series` contains at least one data point, whatever its shape.
//
// Accepts:
//   an array            → non-empty
//   an object of arrays → at least one member array is non-empty
//
// An object whose every member is `[]` is EMPTY — that is the genuine F-081
// case (pre-warmed before the indexer wrote a row) and must not be treated as
// an answer.
export function hasSeriesData(series) {
    if (!series) return false;
    if (Array.isArray(series)) return series.length > 0;
    if (typeof series !== 'object') return false;
    for (const value of Object.values(series)) {
        if (Array.isArray(value) ? value.length > 0 : false) return true;
    }
    return false;
}
