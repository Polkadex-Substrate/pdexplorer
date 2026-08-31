// The round-2 server.js PARTIAL residuals: F-006, F-075, F-077, F-081, F-082,
// F-084, F-085, F-090, F-114, F-136, F-144, F-152.
//
// Most of these had NO test at all — which is how they stayed half-fixed
// through a round. Two of them (F-050, F-155) turned out to be fully closed
// already and are asserted here too, so a later change cannot quietly reopen
// them.
//
// Source-reading where the behaviour lives in an Express handler with no export
// surface; real execution where a pure helper exists. Comments are stripped
// first: several assertions are "this pattern must NOT appear", and the comment
// explaining why contains the pattern.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRepo, stripComments } from './helpers/source.js';

const serverSrc = readRepo('server.js', import.meta.url);
const server = stripComments(serverSrc);
const dbSrc = stripComments(readRepo('db.js', import.meta.url));
const emailSrc = readRepo('email.js', import.meta.url);
const email = stripComments(emailSrc);
const envExample = readRepo('.env.example', import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// F-090 — a subscriber's mailbox must not reach a log line
// ─────────────────────────────────────────────────────────────────────────────

describe('F-090 — email addresses are masked in logs', () => {
    test('neither log line interpolates the raw address', () => {
        // The "(disabled) would send" line fires on EVERY send while
        // EMAIL_PROVIDER=disabled, which is the DEFAULT — so a stock deployment
        // wrote the address of everyone who signed up into journald.
        assert.ok(!/console\.log\(`\[email\] \(disabled\) would send to=\$\{opts\.to\}/.test(email),
            'the disabled-provider line still logs the raw address — that IS F-090');
        assert.ok(!/rate-limited send to \$\{toLower\}/.test(email),
            'the rate-limit line still logs the raw address');
        assert.match(email, /maskEmail\(toLower\)/);
        assert.match(email, /maskEmail\(opts\.to\)/);
    });

    test('the thrown validation error is masked too', () => {
        // server.js logs err.message on the signup path, so leaving the address
        // in the throw would reintroduce the leak through the error path after
        // the log lines were fixed.
        const pre = email.slice(email.indexOf('function preflight('), email.indexOf('function preflight(') + 700);
        assert.match(pre, /maskEmail\(opts\.to\)/);
        assert.ok(!/\\`\$\{opts\.to\}\\`/.test(pre), 'the raw address is still in the thrown message');
    });

    test('the mask is a hash, not a truncation', () => {
        // A truncated address ("me@exa…") is still identifying. Assert the
        // actual mechanism.
        assert.match(email, /createHash\('sha256'\)/);
        assert.match(email, /import \{ createHash \} from 'node:crypto'/);
    });

    test('the plaintext escape hatch exists, defaults off, and is documented', () => {
        // Removing the local-development affordance entirely just pushes people
        // to add their own console.log.
        assert.match(email, /EMAIL_LOG_PLAINTEXT === '1'/);
        assert.match(envExample, /EMAIL_LOG_PLAINTEXT=0/);
        assert.match(envExample, /Never in production/);
    });

    test('the masker survives junk input', () => {
        // Lifted and run, because a throw here would take down the send path it
        // is supposed to be observing.
        const src = emailSrc.slice(emailSrc.indexOf('function maskEmail('));
        const body = src.slice(0, src.indexOf('\n}') + 2);
        // eslint-disable-next-line no-new-func
        const mask = new Function('createHash', 'EMAIL_LOG_PLAINTEXT', `${body}; return maskEmail;`)(
            createHash, false);
        for (const v of [null, undefined, '', 0, {}, []]) {
            assert.doesNotThrow(() => mask(v), `threw on ${JSON.stringify(v)}`);
        }
        assert.equal(mask(''), '(none)');
        assert.match(mask('a@b.c'), /^sha256:[0-9a-f]{12}$/);
        // Case and whitespace must not produce different pseudonyms for one
        // mailbox, or "same recipient again" stops being answerable.
        assert.equal(mask('A@B.C'), mask('  a@b.c  '));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-114 / F-006 — the indexer must not invent data
// ─────────────────────────────────────────────────────────────────────────────

describe('F-114 — no fabricated block timestamps', () => {
    test('getBlockTimestampAt returns null, not Date.now()', () => {
        const fn = server.slice(server.indexOf('async function getBlockTimestampAt('),
                                server.indexOf('async function getBlockTimestampAt(') + 400);
        assert.ok(!/return Date\.now\(\);/.test(fn),
            'an RPC hiccup stamps a 2022 block with today — that IS F-114');
        assert.match(fn, /return null;/);
    });

    test('all three scanners refuse to write a row without a timestamp', () => {
        assert.equal((server.match(/timestamp === null/g) || []).length, 3,
            'expected the transaction, reward and governance scanners to each guard');
        for (const indexer of ['transactions', 'staking_rewards', 'governance']) {
            assert.ok(new RegExp(`recordScanFailure\\('${indexer}', blockNumber,\\s*\\n?\\s*'block timestamp unavailable`).test(server),
                `${indexer} does not queue the height for retry`);
        }
    });

    test('the failure text cannot be mistaken for a transient RPC error', () => {
        // requeueTransientScanFailures resets attempts on rows whose last_error
        // matches an RPC-outage pattern. A message containing one of those
        // words would be requeued forever instead of surfacing as Degraded.
        const patterns = ['rpc', 'websocket', 'disconnected', 'connection dropped',
                          'socket hang up', 'econnrefused', 'econnreset', 'etimedout'];
        for (const msg of ['block timestamp unavailable at this height (F-114)',
                           'events could not be decoded at this height (F-006)']) {
            for (const p of patterns) {
                assert.ok(!msg.toLowerCase().includes(p),
                    `"${msg}" contains the transient marker "${p}" — the amnesty pass would requeue it forever`);
            }
        }
    });
});

describe('F-006 — undecodable events are not a clean scan', () => {
    test('the transaction scanner no longer returns ok:true', () => {
        assert.ok(!/if \(!events\) return \{ blockNumber, transactions: \[\], ok: true \};/.test(server),
            'the tx scanner still calls an undecoded block clean — that IS F-006');
    });

    test('the reward scanner no longer returns ok:true', () => {
        assert.ok(!/if \(!events\) return \{ rewards: \[\], ok: true \};/.test(server),
            'the reward scanner still calls an undecoded block clean');
    });

    test('both queue the height and both honour EVENTS_STRICT', () => {
        for (const indexer of ['transactions', 'staking_rewards']) {
            assert.ok(new RegExp(`recordScanFailure\\('${indexer}', blockNumber,\\s*\\n?\\s*'events could not be decoded`).test(server),
                `${indexer} does not record the undecodable height`);
        }
        // The pruned-node escape hatch has to remain, or a non-archive node
        // fills scan_failures with heights it can never serve.
        assert.match(server, /if \(!EVENTS_STRICT\) return \{ blockNumber, transactions: \[\], ok: true \};/);
        assert.match(server, /if \(!EVENTS_STRICT\) return \{ rewards: \[\], ok: true \};/);
    });

    test('EVENTS_STRICT is declared before every use', () => {
        // It is a module-scope const read only inside functions, so the old
        // ordering worked by accident. Removing the accident.
        const decl = server.indexOf('const EVENTS_STRICT =');
        assert.ok(decl !== -1);
        const uses = [...server.matchAll(/\bEVENTS_STRICT\b/g)].map(m => m.index).filter(i => i !== decl);
        assert.ok(uses.every(i => i > decl), 'EVENTS_STRICT is used above its declaration');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-084 — internal error text must not reach clients
// ─────────────────────────────────────────────────────────────────────────────

describe('F-084 — no internal messages on the wire', () => {
    const fn = server.slice(server.indexOf('function archiveHint('),
                            server.indexOf('function archiveHint(') + 1200);

    test('archiveHint never returns err.message', () => {
        assert.ok(!/return msg;/.test(fn),
            'archiveHint still returns the raw exception — a failed WS dial names our endpoint');
        assert.ok(!/\$\{msg\}/.test(fn), 'the raw message is still interpolated into the response');
    });

    test('it returns a status and a machine-readable code', () => {
        assert.match(fn, /code: 'PRUNED_STATE'/);
        assert.match(fn, /code: 'INTERNAL'/);
        assert.match(fn, /status: 409/);
        assert.match(fn, /status: 500/);
    });

    test('a pruned block is 409, not 500', () => {
        // It is a fact about the request, not a fault on our side. A 500 tells
        // the caller to retry, which will never work.
        const pruned = fn.slice(fn.indexOf('PRUNED_STATE') - 400, fn.indexOf('PRUNED_STATE'));
        assert.match(pruned, /status: 409/);
    });

    test('every call site uses the returned status', () => {
        assert.equal((server.match(/const a = archiveHint\(err, /g) || []).length, 4);
        assert.ok(!/res\.status\(500\)\.json\(\{ error: archiveHint\(/.test(server),
            'a call site still hardcodes 500 and wraps the old string shape');
    });

    test('getValidators no longer publishes the indexer exception on a 200', () => {
        // This shape is served by /api/validators under cacheMedium, so the
        // internal message was going out on a 200 AND being held at the edge.
        const fn2 = dbSrc.slice(dbSrc.indexOf('export function getValidators()'),
                                dbSrc.indexOf('export function getValidators()') + 900);
        assert.ok(!/error: s\.error/.test(fn2),
            'the indexer error is back on a cached 200 — that IS F-084');
        assert.match(fn2, /status: s\.status \?\? 'Initializing'/, 'status must still be published');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-085 / F-136 — say what a number is
// ─────────────────────────────────────────────────────────────────────────────

describe('F-085 — the wallet payload labels its provenance', () => {
    // Scoped to the WALLET route. The account route grew its own
    // `provenance:` block in round 1, and it appears first in the file — a
    // plain indexOf finds that one and passes while the wallet route has
    // nothing, which is exactly the residual under test. Slice from the route
    // registration, not from the field name.
    const walletRoute = (() => {
        const i = server.indexOf("app.get('/api/wallet/:address'");
        assert.ok(i !== -1, 'the wallet route moved — re-point this test');
        return server.slice(i, server.indexOf("app.get('", i + 10));
    })();

    test('it declares which fields are live and which are indexed', () => {
        assert.match(walletRoute, /provenance: \{/,
            'the wallet route has no provenance block — that IS the F-085 residual');
        assert.match(walletRoute, /balance: 'live-rpc'/);
        assert.match(walletRoute, /recentTransactions: 'index'/);
    });

    test('it publishes the index watermarks the lists depend on', () => {
        assert.match(walletRoute, /rowLimit: 10/);
        assert.match(walletRoute, /truncated: true/);
        assert.match(walletRoute, /backfillComplete/);
    });

    test('the account route\'s marker is still unique', () => {
        // test/server-infra.test.js locates that route by its comment header.
        // A second copy anywhere in the file silently moves which route those
        // assertions run against — including a copy inside a comment warning
        // about the collision, which is how this was nearly reintroduced.
        assert.equal((serverSrc.match(/Audit F-085: this payload mixes/g) || []).length, 1);
    });

    test('the wallet route is still no-store', () => {
        // F-083: per-address balances must not be shareable. Adding fields must
        // not have disturbed that.
        const i = server.indexOf("app.get('/api/wallet/:address'");
        assert.match(server.slice(i, i + 900), /no-store/);
    });
});

describe('F-136 — balanceFrozen means frozen', () => {
    test('it is no longer an alias of reserved', () => {
        assert.ok(!/balanceReserved: reserved, balanceFrozen: reserved,/.test(server),
            'frozen is still publishing the reserved value — that IS F-136');
        assert.match(server, /balanceReserved: reserved, balanceFrozen: frozen,/);
    });

    test('frozen is derived from the account data, with a legacy path', () => {
        const i = server.indexOf('const frozen = (() => {');
        assert.ok(i !== -1, 'no frozen derivation');
        const block = server.slice(i, i + 500);
        assert.match(block, /d\.frozen !== undefined/);
        assert.match(block, /miscFrozen/);
        assert.match(block, /Math\.max\(misc, fee\)/,
            'misc/fee frozen OVERLAP — summing them double-counts the lock');
    });

    test('the field was made true rather than deleted', () => {
        // Deleting would render NaN in every cached SPA bundle still carrying
        // the fallback.
        assert.match(server, /balanceFrozen:/);
    });

    test('the SPA fallback is gone', () => {
        // It would now print locks under a "reserved" label — the exact
        // confusion the finding is about.
        const spa = stripComments(readRepo('script.js', import.meta.url));
        assert.ok(!/data\.balanceReserved != null \? data\.balanceReserved : data\.balanceFrozen/.test(spa),
            'the SPA still falls back to balanceFrozen for the reserved row');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-081 / F-077 / F-075 / F-082 / F-144 / F-152
// ─────────────────────────────────────────────────────────────────────────────

describe('F-081 — an empty analytics series is never cached', () => {
    const fn = server.slice(server.indexOf("app.get('/api/analytics/timeseries'"),
                            server.indexOf("app.get('/api/analytics/timeseries'") + 2200);

    test('a truthy-but-empty array no longer counts as a cache hit', () => {
        assert.ok(!/if \(cached && cached\.series\) return res\.json\(cached\);/.test(fn),
            '[] is truthy, so a pre-warmed empty series was served AND pinned at the edge — that IS F-081');
        assert.match(fn, /Array\.isArray\(cached\.series\) && cached\.series\.length/);
    });

    test('cacheMedium only runs on a populated series', () => {
        const cacheAt = fn.indexOf('cacheMedium(res)');
        const guardAt = fn.indexOf('cached.series.length');
        assert.ok(guardAt !== -1 && guardAt < cacheAt,
            'the cache header is set before the emptiness check');
    });

    test('the empty path is explicitly no-store', () => {
        assert.match(fn, /res\.set\('Cache-Control', 'no-store'\)/);
    });

    test('the response distinguishes "nothing happened" from "not indexed yet"', () => {
        assert.match(fn, /indexIncomplete/);
    });
});

describe('F-077 — the caller cannot choose how much work the node does', () => {
    const fn = server.slice(server.indexOf("app.post('/api/rpc/call'"),
                            server.indexOf("app.post('/api/rpc/call'") + 2600);

    test('state_getKeysPaged page size is clamped', () => {
        assert.match(fn, /method === 'state_getKeysPaged'/);
        assert.match(fn, /params\[1\] = RPC_MAX_PAGE/);
        assert.match(server, /const RPC_MAX_PAGE = readPositiveInteger\(process\.env\.RPC_MAX_PAGE, 100\)/);
    });

    test('the clamp is the SECOND parameter', () => {
        // state_getKeysPaged(prefix, count, startKey, at) — clamping params[0]
        // would corrupt the prefix and silently query the wrong tree.
        assert.match(fn, /const asked = Number\(params\[1\]\)/);
    });

    test('the clamp is disclosed, not silent', () => {
        // A client that asked for 5000 and got 100 would read the short page as
        // the end of the prefix and stop.
        assert.match(fn, /pageSizeClamped: true/);
    });

    test('the method is clamped, not removed', () => {
        // /chain-state needs it, and a test elsewhere pins its presence.
        assert.match(server, /'state_getKeysPaged'/);
    });

    test('the knob is documented', () => {
        assert.match(envExample, /RPC_MAX_PAGE=100/);
    });
});

describe('F-075 — cooldowns are cluster-wide, not per worker', () => {
    test('the per-process Maps are gone', () => {
        assert.ok(!/const lastPostAt = new Map\(\)/.test(server),
            'the discussion cooldown is a per-worker Map again — round-robin divides it by WORKERS');
        assert.ok(!/const lastLabelWriteAt = new Map\(\)/.test(server));
    });

    test('both use the shared SQLite counter', () => {
        assert.match(server, /db\.consumeRateLimit\('label-write', signer/);
        assert.match(server, /db\.consumeRateLimit\('discussion-post', address/);
    });

    test('both send Retry-After', () => {
        // A 429 without it tells the client to guess.
        const label = server.slice(server.indexOf("consumeRateLimit('label-write'"),
                                   server.indexOf("consumeRateLimit('label-write'") + 700);
        assert.match(label, /Retry-After/);
        const post = server.slice(server.indexOf("consumeRateLimit('discussion-post'"),
                                  server.indexOf("consumeRateLimit('discussion-post'") + 700);
        assert.match(post, /Retry-After/);
    });
});

describe('F-082 — one SS58 gate, and it answers 400', () => {
    test('the gate exists', () => {
        assert.match(server, /function gateAddressParams\(req, res, \.\.\.names\)/);
    });

    test('the three label sub-routes no longer normalise bare', () => {
        // They sat inside a try whose catch is serverError, so junk in the URL
        // produced a 500 — "we broke" instead of "your request was wrong".
        assert.ok(!/const labelAddress = normalizeAddress\(\(req\.params\.address \|\| ''\)\.trim\(\)\);/.test(server),
            'a label route still normalises without a gate — junk still 500s');
        assert.equal((server.match(/gateAddressParams\(req, res, 'address', 'signer'\)/g) || []).length, 3);
    });

    test('/api/validator/:address is gated too', () => {
        const i = server.indexOf("app.get('/api/validator/:address'");
        const fn = server.slice(i, i + 700);
        assert.match(fn, /gateAddressParams\(req, res, 'address'\)/);
        assert.ok(!/const address = req\.params\.address\.trim\(\);/.test(fn),
            'the raw param still goes into getIdentity and staking.bonded');
    });

    test('the 400 body reuses the existing literal', () => {
        // Clients may already switch on it.
        const fn = server.slice(server.indexOf('function gateAddressParams('),
                                server.indexOf('function gateAddressParams(') + 900);
        assert.match(fn, /'Invalid Polkadex address\.'/);
    });
});

describe('F-144 — the watchdog names the right restart path', () => {
    test('it branches on WORKERS', () => {
        assert.match(server, /const restartPath = WORKERS > 1/,
            'the log still promises a container restart that will not happen when clustered');
        assert.match(server, /refork this worker/);
        assert.match(server, /Docker will restart the container/);
    });
});

describe('F-152 — the documented auth contract matches the handler', () => {
    const ref = readRepo('lib/api-reference.js', import.meta.url);

    test('the docs no longer ask for a nonce in the body', () => {
        // The handler reads only { address, signature }; the nonce comes from
        // db.getChallenge(address). A client sending one is not wrong, but a
        // client that thinks it MUST is stuck.
        assert.ok(!/submit \{ address, signature, nonce \}/.test(ref),
            'the route table still documents a field the server never reads');
        assert.match(ref, /the nonce is NOT sent/);
    });

    test('the TTL is stated, not implied', () => {
        assert.match(ref, /7-day TTL/);
    });

    test('the prose copies agree', () => {
        assert.match(readRepo('README.md', import.meta.url), /7-day TTL/);
        assert.match(readRepo('public/llms.txt', import.meta.url), /7-day TTL/);
    });

    test('the handler really does ignore a body nonce', () => {
        const fn = server.slice(server.indexOf("app.post('/api/auth/verify'"),
                                server.indexOf("app.post('/api/auth/verify'") + 900);
        assert.ok(!/req\.body.*nonce/.test(fn), 'the handler reads a nonce from the body after all — the docs were right');
        assert.match(fn, /db\.getChallenge\(address\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Already closed — pinned so they cannot quietly reopen
// ─────────────────────────────────────────────────────────────────────────────

describe('F-050 / F-155 — closed, and must stay closed', () => {
    test('F-050: every crawler derives status from failure counts', () => {
        assert.ok((server.match(/deriveIndexStatus\(\{/g) || []).length >= 3);
        assert.match(server, /permanentFailures: rewardFailCounts\.permanent/);
    });

    test('F-155: the 503 envelope is one exported constant', () => {
        const ref = readRepo('lib/api-reference.js', import.meta.url);
        assert.match(ref, /export const RPC_NOT_READY = \{/);
        assert.match(server, /RPC_NOT_READY\.error/);
        assert.match(server, /RPC_NOT_READY\.code/);
        assert.ok(!/rpc not connected/.test(server), 'the literal the server never sent is back in the docs');
    });
});
