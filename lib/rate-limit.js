// Sliding-window rate limiting, and an honest account of what it can enforce.
//
// Audit F-075. Every limiter in server.js is an in-process `Map` of
// ip -> [timestamps]. The backend runs a Node cluster with WORKERS (up to 8)
// processes, and the OS spreads connections across them, so a limit documented
// and advertised as "60 requests per minute" actually permits up to
// 60 × WORKERS. The documented number is wrong by a factor nobody can see from
// the outside, and it gets worse whenever the host is given more cores.
//
// There are two honest ways out, and which is right depends on the endpoint:
//
//   SHARED COUNTER — correct, costs a SQLite write per request. Right for the
//     low-volume endpoints where the limit is a security control: auth
//     challenge/verify (nonce overwriting, signature-verify CPU), email signup
//     (mail flooding), label writes (spam). These see single-digit requests per
//     second at most, so a write per request is irrelevant.
//
//   PER-PROCESS, DIVIDED — approximate, free. Right for the developer API,
//     where the limit is a fairness/DoS knob rather than a security boundary
//     and a per-request write would itself become the bottleneck the limiter
//     exists to prevent.
//
// What is NOT acceptable is the third option — leaving it per-process and
// undivided while documenting the undivided number. That is the finding.
//
// This module holds the pure window arithmetic. The storage is injected so the
// same logic covers both the in-memory Map and the SQLite table.

// Decide whether a hit is allowed, given the timestamps already recorded.
//
//   hits    — array of previous hit timestamps (ms), any order
//   now     — current time (ms)
//   windowMs, limit
//
// Returns { allowed, remaining, retryAfterMs, kept } where `kept` is the
// pruned timestamp list the caller should store back (with `now` appended when
// allowed).
//
// Pure, so the boundary conditions can be tested directly — an off-by-one here
// is the difference between advertising 60 and enforcing 61.
export function checkWindow(hits, { now = Date.now(), windowMs, limit } = {}) {
    const cutoff = now - windowMs;
    const kept = (Array.isArray(hits) ? hits : []).filter(t => t > cutoff);

    if (kept.length >= limit) {
        // When does the oldest hit fall out of the window? That is the earliest
        // moment a retry can succeed. Telling the caller beats making them poll.
        const oldest = Math.min(...kept);
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: Math.max(0, (oldest + windowMs) - now),
            kept
        };
    }
    kept.push(now);
    return {
        allowed: true,
        remaining: Math.max(0, limit - kept.length),
        retryAfterMs: 0,
        kept
    };
}

// Split an advertised aggregate limit across N workers.
//
// Returns at least 1: a cap of 0 would block the endpoint outright, which is a
// far worse failure than being slightly over-permissive on a machine with more
// cores than the limit has room for. When the division is lossy the aggregate
// lands UNDER the advertised figure rather than over — for a DoS knob that is
// the safe direction, and the caller should log the effective number so the
// discrepancy is visible rather than surprising.
export function perWorkerLimit(advertisedLimit, workers) {
    const n = Math.max(1, Number(workers) || 1);
    return Math.max(1, Math.floor(advertisedLimit / n));
}
