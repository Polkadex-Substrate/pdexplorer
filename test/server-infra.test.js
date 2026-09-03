// Audit F-063 / F-073 / F-075 / F-076 / F-081 / F-085 / F-087.
//
// The two behavioural modules (lib/rate-limit.js window arithmetic, and the
// response-cache guard's status/size decision) are exercised directly. The rest
// are source contracts, for the usual reason: server.js boots a cluster, opens
// SQLite and dials a chain RPC on import, so it cannot be required from a test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkWindow, perWorkerLimit } from '../lib/rate-limit.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const serverSrc = read('server.js');
const scriptSrc = read('script.js');
const dbSrc     = read('db.js');

// ─────────────────────────────────────────────────────────────────────────────
// F-075 — one advertised cap, not cap × WORKERS
// ─────────────────────────────────────────────────────────────────────────────

describe('checkWindow — the sliding window itself', () => {
    test('allows exactly `limit` hits and refuses the next', () => {
        // An off-by-one here is the difference between advertising 3 and
        // enforcing 4, which is the whole class of bug F-075 is about.
        let hits = [];
        for (let i = 0; i < 3; i++) {
            const r = checkWindow(hits, { now: 1000 + i, windowMs: 1000, limit: 3 });
            assert.equal(r.allowed, true, `hit ${i + 1} of 3 was refused`);
            hits = r.kept;
        }
        const r4 = checkWindow(hits, { now: 1003, windowMs: 1000, limit: 3 });
        assert.equal(r4.allowed, false, 'a 4th hit inside the window was allowed');
    });

    test('hits older than the window do not count', () => {
        const old = [1000, 1001, 1002];
        const r = checkWindow(old, { now: 1000 + 5000, windowMs: 1000, limit: 3 });
        assert.equal(r.allowed, true);
        assert.deepEqual(r.kept, [6000], 'stale timestamps must be pruned, not accumulated');
    });

    test('a refusal reports when a retry can succeed', () => {
        const r = checkWindow([1000, 1100, 1200], { now: 1300, windowMs: 1000, limit: 3 });
        assert.equal(r.allowed, false);
        // Oldest hit is at 1000, so it leaves the window at 2000 — 700ms away.
        assert.equal(r.retryAfterMs, 700);
    });

    test('a refusal does NOT record the refused hit', () => {
        // Otherwise a client hammering the endpoint keeps pushing its own
        // window forward and is locked out far longer than the limit implies.
        const r = checkWindow([1000, 1100, 1200], { now: 1300, windowMs: 1000, limit: 3 });
        assert.equal(r.kept.length, 3);
    });

    test('remaining counts down', () => {
        assert.equal(checkWindow([], { now: 1, windowMs: 1000, limit: 3 }).remaining, 2);
        assert.equal(checkWindow([1], { now: 2, windowMs: 1000, limit: 3 }).remaining, 1);
    });

    test('malformed stored state is treated as empty, not a crash', () => {
        for (const bad of [null, undefined, 'nonsense', 42, {}]) {
            assert.doesNotThrow(() => checkWindow(bad, { now: 1, windowMs: 10, limit: 1 }));
            assert.equal(checkWindow(bad, { now: 1, windowMs: 10, limit: 1 }).allowed, true);
        }
    });
});

describe('perWorkerLimit', () => {
    test('divides the advertised cap across the cluster', () => {
        assert.equal(perWorkerLimit(60, 8), 7);    // 8 × 7 = 56 ≤ 60
        assert.equal(perWorkerLimit(60, 1), 60);
        assert.equal(perWorkerLimit(60, 4), 15);
    });

    test('the aggregate never EXCEEDS the advertised figure', () => {
        // The direction matters: under-permissive is a fairness annoyance,
        // over-permissive is the finding.
        for (let workers = 1; workers <= 16; workers++) {
            for (const cap of [1, 5, 60, 100, 480]) {
                const per = perWorkerLimit(cap, workers);
                if (cap >= workers) {
                    assert.ok(per * workers <= cap,
                        `${workers} × ${per} exceeds the advertised ${cap}`);
                }
            }
        }
    });

    test('never returns 0 — that would close the endpoint entirely', () => {
        assert.equal(perWorkerLimit(1, 8), 1);
        assert.equal(perWorkerLimit(0, 8), 1);
    });

    test('a nonsense worker count degrades to single-process', () => {
        for (const w of [0, -3, NaN, null, undefined, 'four']) {
            assert.equal(perWorkerLimit(60, w), 60);
        }
    });
});

describe('F-075 — the limiters are wired to the right storage', () => {
    test('auth and email signup use the CLUSTER-WIDE counter', () => {
        // These are security controls: nonce overwriting and mail flooding.
        assert.match(serverSrc, /db\.consumeRateLimit\('auth'/,
            'the auth limiter is per-process again — its cap is multiplied by WORKERS');
        assert.match(serverSrc, /db\.consumeRateLimit\('email-signup'/);
        assert.ok(!/const emailSignupAttempts = new Map/.test(serverSrc),
            'the in-process signup Map is back');
    });

    test('auth no longer borrows the developer-API budget', () => {
        const gate = serverSrc.slice(
            serverSrc.indexOf('function authRateGate(req, res)'),
            serverSrc.indexOf('function authRateGate(req, res)') + 900
        );
        assert.ok(!/devApiRateOk/.test(gate),
            'raising DEV_API_RATE_LIMIT_PER_MIN would silently weaken login again');
    });

    test('the developer API divides its cap by the worker count', () => {
        assert.match(serverSrc, /perWorkerLimit\(DEV_API_RATE_LIMIT_PER_MIN, WORKERS\)/);
    });

    test('the shared counter is transactional', () => {
        // Two workers racing the same key must not both see "under the limit".
        const fn = dbSrc.slice(
            dbSrc.indexOf('export function consumeRateLimit'),
            dbSrc.indexOf('export function pruneRateLimits')
        );
        assert.match(fn, /BEGIN IMMEDIATE/);
        assert.match(fn, /ROLLBACK/);
    });

    test('the limiter FAILS OPEN, and can actually REACH the fail-open return', () => {
        // A review catch: the catch block used to run a BARE `db.exec('ROLLBACK')`.
        // The statement most likely to throw here is BEGIN IMMEDIATE itself —
        // it is what waits on the write lock — and at that point no transaction
        // is open, so ROLLBACK throws "cannot rollback - no transaction is
        // active", escapes the catch, and never reaches `return { allowed:
        // true }`. authRateGate has no try/catch, so the auth endpoints 500.
        // The limiter became the outage it exists to prevent, and the old test
        // (a bare /allowed: true/ match on the source) passed the whole time.
        const fn = dbSrc.slice(
            dbSrc.indexOf('export function consumeRateLimit'),
            dbSrc.indexOf('export function pruneRateLimits')
        );
        assert.match(fn, /allowed: true/, 'the catch path must allow the request, not refuse it');
        assert.match(fn, /let began = false/,
            'the rollback must be conditional on a transaction having started');
        assert.match(fn, /if \(began\) \{[\s\S]{0,120}ROLLBACK/,
            'a bare ROLLBACK in the catch throws when BEGIN was what failed');
        assert.match(fn, /try \{ db\.exec\('ROLLBACK'\); \} catch/,
            'even a conditional ROLLBACK must not be able to mask the original error');
        // BEGIN must be INSIDE the try, or its throw is uncatchable here.
        const beginAt = fn.indexOf("db.exec('BEGIN IMMEDIATE')");
        const tryAt = fn.indexOf('try {');
        assert.ok(tryAt !== -1 && tryAt < beginAt,
            'BEGIN IMMEDIATE is outside the try — the most likely throw is unprotected');
    });

    test('a refused request does not write', () => {
        // Otherwise an attacker already over the limit keeps forcing write
        // transactions against a single-writer SQLite file at whatever rate
        // they choose. A limiter must get CHEAPER under abuse.
        const fn = dbSrc.slice(
            dbSrc.indexOf('export function consumeRateLimit'),
            dbSrc.indexOf('export function pruneRateLimits')
        );
        assert.match(fn, /if \(result\.allowed\) \{[\s\S]{0,400}INSERT INTO rate_limits/,
            'the row is written unconditionally — refusals become write amplification');
    });

    test('the prune sweep is actually scheduled', () => {
        // pruneRateLimits was exported and called from NOWHERE, while both the
        // schema comment and its own docstring claimed it ran. One row per
        // (bucket, IP) would accumulate on the production database forever.
        assert.match(serverSrc, /db\.pruneRateLimits\(\)/,
            'nothing calls pruneRateLimits — the table grows without bound');
        assert.match(serverSrc, /setInterval\(sweepRateLimits/,
            'the sweep runs once at boot but is never repeated');
        // Indexer-only: it is a write, and there is one writer.
        const loops = serverSrc.slice(
            serverSrc.indexOf('function startIndexerLoops()'),
            serverSrc.indexOf('function startIndexerLoops()') + 3000
        );
        assert.match(loops, /sweepRateLimits/,
            'the sweep must live on the indexer worker, not every HTTP worker');
    });

    test('the schema has no backticks — SCHEMA is a template literal', () => {
        // Learned the hard way while adding rate_limits: a backtick inside a
        // SQL comment terminates the JS template literal and the file stops
        // parsing.
        const i = dbSrc.indexOf('const SCHEMA = `');
        const j = dbSrc.indexOf('`;', i);
        assert.ok(i !== -1 && j > i);
        assert.equal(dbSrc.slice(i + 16, j).includes('`'), false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-087 / F-076 — the response-cache guard
// ─────────────────────────────────────────────────────────────────────────────

// The middleware's decision, lifted so it can be exercised without Express.
//
// A lifted copy can only ever prove the RULE is right, never that the shipped
// middleware still applies it — a mutation that disabled the real branch left
// every test below passing. So the copy is paired with source assertions that
// pin the actual condition ('the guard still evaluates its condition' and
// 'the size branch is still wired'). Both halves are needed; neither is
// sufficient. This is the same trap a review already caught once in
// test/correctness-tail.test.js, so it is called out rather than repeated.
function shouldStripCache({ status, cacheControl, contentLength, maxBytes = 512 * 1024 }) {
    // Kept in sync with server.js by 'the lifted copy matches the real set'
    // below — a review caught this copy carrying the SAME 304 omission as the
    // original, so every test here exercised the bug and passed.
    const CACHEABLE = new Set([200, 203, 204, 206, 300, 301, 304, 404, 410]);
    const isPublic = cacheControl && /public|max-age|s-maxage/i.test(String(cacheControl));
    if (!isPublic) return false;
    if (!CACHEABLE.has(status)) return true;
    const len = Number(contentLength);
    return Number.isFinite(len) && len > maxBytes;
}

describe('F-087 — an error can never be cached', () => {
    for (const status of [500, 502, 503, 429, 400, 401, 403]) {
        test(`${status} with a public header is downgraded to no-store`, () => {
            assert.equal(shouldStripCache({
                status, cacheControl: 'public, max-age=300, s-maxage=600'
            }), true);
        });
    }

    test('a 200 keeps its cache header', () => {
        assert.equal(shouldStripCache({
            status: 200, cacheControl: 'public, max-age=5, s-maxage=10', contentLength: 1000
        }), false);
    });

    test('a 404 stays cacheable — a missing block is stably missing', () => {
        assert.equal(shouldStripCache({ status: 404, cacheControl: 'public, max-age=300' }), false);
    });

    test('a response that never asked to be cached is left alone', () => {
        assert.equal(shouldStripCache({ status: 500, cacheControl: 'no-store' }), false);
        assert.equal(shouldStripCache({ status: 500, cacheControl: undefined }), false);
    });

    test('the lifted copy matches the real set, member for member', () => {
        // Without this the copy can drift from server.js and every test above
        // silently asserts the wrong rule. That is exactly how the 304 bug
        // survived its own test file.
        const line = serverSrc.split('\n').find(l => l.startsWith('const CACHEABLE_STATUSES'));
        assert.ok(line, 'CACHEABLE_STATUSES is gone');
        const real = JSON.parse(line.slice(line.indexOf('['), line.indexOf(']') + 1));
        const copy = [200, 203, 204, 206, 300, 301, 304, 404, 410];
        assert.deepEqual(real.slice().sort((a, b) => a - b), copy.slice().sort((a, b) => a - b),
            'the middleware and the lifted test copy disagree about what is cacheable');
    });

    test('a 304 keeps its cache header — revalidation must not evict', () => {
        // Express 5 answers conditional requests with 304 automatically and
        // does not clear Cache-Control. Rewriting it to no-store tells the
        // cache to discard an entry it just confirmed is fresh.
        assert.equal(shouldStripCache({
            status: 304, cacheControl: 'public, max-age=300, s-maxage=600'
        }), false);
    });

    test('a 206 keeps its cache header', () => {
        assert.equal(shouldStripCache({
            status: 206, cacheControl: 'public, max-age=300', contentLength: 100
        }), false);
    });

    test('the guard still evaluates its condition', () => {
        // Pins the real branch, not the lifted copy above.
        const mw = serverSrc.slice(
            serverSrc.indexOf('const CACHEABLE_STATUSES'),
            serverSrc.indexOf('app.get(\'/sitemap.xml\'')
        );
        assert.match(mw, /if \(isPublic && !CACHEABLE_STATUSES\.has\(status\)\) \{/,
            'the status branch is short-circuited or gone — a 5xx can be cached again');
        assert.match(mw, /const isPublic = current && \/public\|max-age\|s-maxage\/i\.test\(String\(current\)\)/,
            'the public-header detection changed shape');
        assert.match(mw, /const status = typeof args\[0\] === 'number' \? args\[0\] : res\.statusCode/,
            'the status must be read from writeHead\'s argument or res.statusCode');
    });

    test('the size branch is still wired to the real threshold', () => {
        const mw = serverSrc.slice(
            serverSrc.indexOf('const RESPONSE_CACHE_MAX_BYTES'),
            serverSrc.indexOf('app.get(\'/sitemap.xml\'')
        );
        assert.match(mw, /len > RESPONSE_CACHE_MAX_BYTES/);
        assert.match(mw, /res\.setHeader\('Cache-Control', 'no-store'\)/);
    });

    test('the middleware exists and runs before the routes', () => {
        const mwAt = serverSrc.indexOf('const CACHEABLE_STATUSES');
        const firstRoute = serverSrc.indexOf("app.get('/sitemap.xml'");
        assert.ok(mwAt !== -1, 'the response-cache guard is gone — F-087 is reopened');
        assert.ok(mwAt < firstRoute, 'the guard must be registered before any route');
    });

    test('serverError still sets no-store itself', () => {
        // Belt and braces: the middleware is the backstop, not the only guard.
        const fn = serverSrc.slice(
            serverSrc.indexOf('function serverError(res, err, context)'),
            serverSrc.indexOf('function serverError(res, err, context)') + 1200
        );
        assert.match(fn, /res\.set\('Cache-Control', 'no-store'\)/);
    });
});

describe('F-076 — an oversized 200 is not worth an edge cache entry', () => {
    test('over the threshold, caching is dropped', () => {
        assert.equal(shouldStripCache({
            status: 200, cacheControl: 'public, max-age=300', contentLength: 600 * 1024
        }), true);
    });

    test('at or under the threshold it is kept', () => {
        assert.equal(shouldStripCache({
            status: 200, cacheControl: 'public, max-age=300', contentLength: 512 * 1024
        }), false);
    });

    test('an unknown Content-Length does not strip the header', () => {
        // Chunked/streamed responses have no length. Guessing "probably big"
        // would silently disable caching for whole endpoints.
        for (const len of [undefined, null, '', NaN, 'abc']) {
            assert.equal(shouldStripCache({
                status: 200, cacheControl: 'public, max-age=300', contentLength: len
            }), false);
        }
    });

    test('the body is NOT truncated', () => {
        // Half a JSON document that the client cannot detect is worse than a
        // large one.
        const mw = serverSrc.slice(
            serverSrc.indexOf('const RESPONSE_CACHE_MAX_BYTES'),
            serverSrc.indexOf('const RESPONSE_CACHE_MAX_BYTES') + 2200
        );
        assert.ok(!/\.slice\(0, RESPONSE_CACHE_MAX_BYTES\)/.test(mw));
        assert.match(mw, /X-Response-Size-Warning/, 'the caller should be told why');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-073 — the timeout that could not cancel
// ─────────────────────────────────────────────────────────────────────────────

describe('F-073 — a timed-out RPC cannot take down the shared WebSocket', () => {
    // Start at the finding's header comment, not at the function keyword —
    // the reasoning that must not be lost lives above the signature.
    const fn = serverSrc.slice(
        serverSrc.indexOf('// ─── Audit F-073:'),
        serverSrc.indexOf('async function withRpcBudget')
    );

    test('the abandoned loser is marked handled', () => {
        // Promise.race leaves it unhandled; when it later rejects it reaches
        // process.on('unhandledRejection'), which for a polkadot WS timeout
        // calls rebuildApiOnce() — so one slow dev query could tear down the
        // socket every request and all four indexers share.
        assert.match(fn, /Promise\.resolve\(promise\)\.catch\(/,
            'the abandoned promise can escalate to the global rejection handler again');
    });

    test('the timer is cleared and unref\'d', () => {
        assert.match(fn, /timer\.unref\(\)/);
        assert.match(fn, /clearTimeout\(timer\)/);
    });

    test('the in-flight budget exists and refuses rather than queues', () => {
        // Bound structurally — a fixed +900 slice stopped covering the function
        // once F-073 round 3 grew it, and would have started asserting against
        // whatever followed.
        const at = serverSrc.indexOf('async function withRpcBudget');
        const after = serverSrc.slice(at + 1).search(/\n(async )?function /);
        const budget = after === -1 ? serverSrc.slice(at) : serverSrc.slice(at, at + 1 + after);
        assert.match(budget, /devRpcInflight >= DEV_RPC_MAX_INFLIGHT/);
        assert.match(budget, /statusCode = 503/);

        // The counter must decrement on EVERY exit path or it leaks to a
        // permanent 503. This used to require a literal
        // `finally { devRpcInflight-- }`. F-073 round 3 replaced that with an
        // idempotent release() invoked when the UNDERLYING call settles rather
        // than when the caller stops waiting — the whole point of that round,
        // since releasing at the timeout meant the cap counted waiters instead
        // of bounding work at the node. Assert the property, not the old shape.
        assert.match(budget, /const release = \(\) => \{ if \(!released\) \{ released = true; devRpcInflight--; \} \}/,
            'there is no single idempotent release — the counter can drift');
        // every exit path: synchronous throw, settle, and the leak valve
        assert.match(budget, /catch \(e\) \{[\s\S]{0,400}?release\(\);[\s\S]{0,80}?throw e;/,
            'a synchronous throw from fn() leaks its slot');
        assert.match(budget, /underlying\.then\([\s\S]{0,80}?release\(\);/,
            'the slot is not released when the underlying call settles');
        assert.match(budget, /if \(!released\) \{[\s\S]{0,300}?release\(\);/,
            'there is no leak valve for a promise that never settles');
    });

    test('the expensive endpoints are actually behind it', () => {
        for (const label of ['entriesPaged', 'storage read', 'getBlock']) {
            assert.ok(serverSrc.includes(`withRpcBudget('${label}'`),
                `${label} is not under the in-flight cap`);
        }
    });

    test('a shed request reports 503, not "internal error"', () => {
        const fn2 = serverSrc.slice(
            serverSrc.indexOf('function serverError(res, err, context)'),
            serverSrc.indexOf('function serverError(res, err, context)') + 1200
        );
        assert.match(fn2, /err\.statusCode === 503/);
        assert.match(fn2, /Retry-After/);
    });

    test('the comment does not claim cancellation it cannot deliver', () => {
        assert.match(fn, /no cancellation|cannot|not available/i,
            'be explicit that @polkadot/api 10.13.1 offers no abort — otherwise the next reader stops worrying about the load');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-063 — the WebSocket must not gate the page
// ─────────────────────────────────────────────────────────────────────────────

describe('F-063 — REST boots without the WebSocket', () => {
    const init = scriptSrc.slice(
        scriptSrc.indexOf('async function init() {'),
        scriptSrc.indexOf('// Last known total-issuance value')
    );

    // The CALL, not a mention of it. init() documents why the ordering matters
    // and names ApiPromise.create in prose several lines before invoking it;
    // matching the prose made every ordering assertion below vacuously fail.
    const wsCreateAt = (src) => src.indexOf('ApiPromise.create({');

    test('the REST bootstrap runs BEFORE the handshake', () => {
        const restAt = init.indexOf('bootstrapRecentListsFromRest()');
        const wsAt = wsCreateAt(init);
        assert.ok(restAt !== -1 && wsAt !== -1);
        assert.ok(restAt < wsAt,
            'the REST bootstrap is behind the WS handshake again — that IS F-063');
    });

    for (const call of ['paintHomeFromCache()', 'fetchNetworkInformation()',
                        'startGovernancePolling()', 'startPriceTickerPolling()']) {
        test(`${call} runs before the handshake`, () => {
            const at = init.indexOf(call);
            const wsAt = wsCreateAt(init);
            assert.ok(at !== -1, `${call} is gone`);
            assert.ok(at < wsAt, `${call} still waits on the WebSocket`);
        });
    }

    test('the handshake is RACED, because it never rejects', () => {
        // WsProvider retries forever, so a blocked WSS leaves the promise
        // permanently pending — a try/catch cannot help, and everything after
        // the await (including routing) never ran.
        assert.match(init, /Promise\.race\(\[\s*apiPromise/);
        assert.match(init, /WS_HANDSHAKE_TIMEOUT/);
    });

    test('routing runs whether or not the WS came up', () => {
        const raceAt = init.indexOf('Promise.race');
        const routeAt = init.indexOf('routeTo(readRouteFromLocation())');
        const catchAt = init.indexOf('} catch (error) {');
        assert.ok(routeAt > catchAt, 'routing must be outside the try/catch');
        assert.ok(routeAt > raceAt);
    });

    test('a late connection is still adopted', () => {
        assert.match(init, /apiPromise\.then\(api => adoptChainApi\(api\)\)/);
        const adopt = scriptSrc.slice(
            scriptSrc.indexOf('function adoptChainApi(api)'),
            scriptSrc.indexOf('function adoptChainApi(api)') + 700
        );
        assert.match(adopt, /if \(chainApiAdopted \|\| !api\) return/,
            'adoption must be idempotent — the race and the promise can both fire');
        assert.match(adopt, /subscribeNewBlocks\(globalApi\)/);
    });

    test('the failure message distinguishes "node link" from "explorer broken"', () => {
        assert.match(scriptSrc, /Node link offline/);
        assert.ok(!/networkStatusText\.innerText = "Connection Failed"/.test(scriptSrc));
    });

    test('the REST bootstrap MERGES — it does not assign over live arrays', () => {
        // A review catch, and the sharpest one in this batch: the first version
        // of bootstrapRecentListsFromRest was a verbatim lift of the code it
        // replaced, which did `transactions = ...`. That was safe only where it
        // used to sit — after the handshake, before routeTo(), when nothing
        // else had touched the arrays. Moving it earlier and un-awaiting it
        // made it a THIRD concurrent writer racing subscribeNewBlocks and the
        // paged /transactions view: audit F-017, reintroduced by the fix for
        // F-063.
        const fn = scriptSrc.slice(
            scriptSrc.indexOf('async function bootstrapRecentListsFromRest()'),
            scriptSrc.indexOf('async function init() {')
        );
        assert.ok(fn.length > 0, 'bootstrapRecentListsFromRest is gone');
        assert.ok(!/^\s*transactions\s*=/m.test(fn),
            'the bootstrap assigns to `transactions` again — it must merge (F-017)');
        assert.ok(!/^\s*blocks\s*=/m.test(fn),
            'the bootstrap assigns to `blocks` again — it must merge (F-017)');
        assert.match(fn, /refreshDashboardLists\(\)/,
            'it must delegate to the one implementation that merges, caps and updates transactionCacheMeta');
    });

    test('the delegate it calls really does merge', () => {
        // Guards the delegation above from becoming vacuous if
        // refreshDashboardLists itself regresses.
        const fn = scriptSrc.slice(
            scriptSrc.indexOf('async function refreshDashboardLists()'),
            scriptSrc.indexOf('function activePageName()')
        );
        assert.match(fn, /transactions = mergeRows\(\{/);
        assert.match(fn, /blocks = mergeRows\(\{/);
        assert.match(fn, /cap: TX_ROW_CAP/);
    });

    test('the recent-list refresh interval starts regardless', () => {
        const intervalAt = init.indexOf('setInterval(refreshRecentViews');
        const catchEnd = init.indexOf('}\n    // Runs whether or not the WS came up.');
        assert.ok(intervalAt > catchEnd, 'the poll is inside the try again');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-081 / F-085 — not knowing is not the same as zero
// ─────────────────────────────────────────────────────────────────────────────

describe('F-081 — uncounted is null, and is not cached', () => {
    const route = serverSrc.slice(
        serverSrc.indexOf("app.get('/api/analytics/snapshot'"),
        serverSrc.indexOf("app.get('/api/analytics/snapshot'") + 3500
    );

    test('missing counts are null, not 0', () => {
        assert.match(route, /countsReady \? \(counts\.indexedBlocks \?\? null\) : null/);
        assert.ok(!/indexedBlocks:\s+counts\.indexedBlocks \?\? 0/.test(route),
            '?? 0 is back — an explorer with 12.8M blocks would report 0 again');
    });

    test('an unknown-count response is not cacheable', () => {
        assert.match(route, /if \(countsReady\) cacheMedium\(res\);/);
        assert.match(route, /else res\.set\('Cache-Control', 'no-store'\)/);
    });

    test('the client renders unknown as a dash, not "0"', () => {
        // stakingFormatNumber(null) is "0", which would re-tell the same lie
        // one layer up.
        assert.match(scriptSrc, /function formatCountOrUnknown\(value\)/);
        assert.match(scriptSrc, /if \(value == null\) return '<span[^']*>—<\/span>'/);
        assert.match(scriptSrc, /formatCountOrUnknown\(snapshot\.indexedBlocks\)/);
    });
});

describe('F-085 — the payload says which half is live', () => {
    const route = serverSrc.slice(
        serverSrc.indexOf('// Audit F-085:'),
        serverSrc.indexOf('// Audit F-085:') + 4200
    );

    test('provenance is stated per field group', () => {
        assert.match(route, /provenance: \{/);
        assert.match(route, /balances: 'live-rpc'/);
        assert.match(route, /transactions: 'index'/);
    });

    test('status comes from getSyncState, not a hardcoded Synced', () => {
        assert.match(route, /db\.getSyncState\('chain_index'\)/);
        assert.ok(!/status: 'Synced'\s*\}\);/.test(route),
            "the account payload claims 'Synced' unconditionally again");
    });

    test('a truncated list says so — for BOTH reasons it can be truncated', () => {
        // Otherwise a capped list reads as "this account has no older activity".
        assert.match(route, /truncated: \(txs\.length >= 200\)/);
        assert.match(route, /rowLimit: 200/);
        // The row cap is only half of it: the lists are also bounded below by
        // the backfill floor (F-008). A review caught the first version testing
        // the cap alone.
        assert.match(route, /\|\| !chainState\.backfillComplete/);
        assert.match(route, /oldestScannedBlock: chainState\.oldestScannedBlock/);
    });
});
