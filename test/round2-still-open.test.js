// Round-2 findings the auditors marked STILL OPEN: F-141 (dead exports and
// dead crawlers), F-164 (the identity lookup existed twice), F-093 (the RAM
// recipe over-committed) and F-024 (the cert bootstrap never issued anything).
//
// What these four have in common, and why they need a test file rather than a
// commit: every one of them was "fixed" in round 1 by adding a COMMENT. The
// crawlers got a comment saying they were retired, the probes got a comment
// saying not to copy the lookup, the RAM note got a parenthetical, and the
// cert scripts got warnings. All four survived, because a comment does not
// prevent the thing it describes. So the assertions below are deliberately
// about the CODE — the export surface, the import graph, the exit status —
// and every "must not contain" runs against comment-stripped source, because
// the comments in those files quote the banned strings on purpose.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments, readRepo } from './helpers/source.js';

const db          = readRepo('db.js', import.meta.url);
const serverJs    = readRepo('server.js', import.meta.url);
const identityLib = readRepo('lib/identity.js', import.meta.url);
const debugId     = readRepo('debug-identity.js', import.meta.url);
const debugHold   = readRepo('debug-holder-identities.js', import.meta.url);
const install     = readRepo('INSTALL.md', import.meta.url);
const envExample  = readRepo('.env.example', import.meta.url);
const initLE      = readRepo('init-letsencrypt.sh', import.meta.url);
const provision   = readRepo('provision-ubuntu.sh', import.meta.url);

const dbCode       = stripComments(db);
const serverCode   = stripComments(serverJs);
const debugIdCode  = stripComments(debugId);
const debugHoldCode= stripComments(debugHold);
const initLECode   = stripComments(initLE, { line: '#', block: false });
const provCode     = stripComments(provision, { line: '#', block: false });

describe('F-141 — dead exports and dead crawlers stay deleted', () => {
    // The eight names below had no caller anywhere: not server.js, not
    // email.js, not the .mjs tools, not the tests, and not as a bare internal
    // call inside db.js. That last one is the trap — `replaceValidatorTriggers`
    // looks dead to a `db.<name>` grep and is called bare at the JSON seed
    // import, so it is asserted LIVE further down rather than deleted.
    const DELETED_DB_EXPORTS = [
        'countAddressLabels',
        'countLabelVotes',
        'countPricePoints',          // not countPricePointsBySource, which is live
        'countValidatorHistoryEras',
        'getBlocksMinMax',
        'getSelfLabel',
        'getTopLabelsBulk',
        'requeueScanFailures'        // not requeueTransientScanFailures, which is live
    ];

    for (const name of DELETED_DB_EXPORTS) {
        test(`db.js no longer defines ${name}`, () => {
            assert.ok(
                !new RegExp(`function\\s+${name}\\s*\\(`).test(dbCode),
                `${name} is back in db.js. It had no caller when it was removed under ` +
                `F-141; if you are re-adding it, add the caller in the same commit.`
            );
        });
    }

    test('the deleted names have no call site anywhere in server.js', () => {
        // Deleting an export and leaving a caller is the one way this change
        // could have caused a production 500, so assert the other half too.
        for (const name of DELETED_DB_EXPORTS) {
            assert.ok(
                !serverCode.includes(`${name}(`),
                `server.js calls ${name}(), which db.js no longer exports — this is a ` +
                `guaranteed TypeError at runtime.`
            );
        }
    });

    test('the near-miss neighbours are still live', () => {
        // Each of these differs from a deleted name by a word or two. If a
        // later cleanup pass "tidies" one of them away, the failure is a
        // silent one: countPricePointsBySource backs the price-provider health
        // check, requeueTransientScanFailures runs at indexer startup, and
        // replaceValidatorTriggers is called BARE (no `db.` prefix) from the
        // JSON seed import inside db.js.
        for (const [name, why] of [
            ['countPricePointsBySource', 'server.js price-provider health'],
            ['requeueTransientScanFailures', 'indexer startup rescue path'],
            ['replaceValidatorTriggers', 'bare call from the JSON seed import'],
            ['getTopLabel', 'the single per-address label visibility rule']
        ]) {
            assert.ok(
                new RegExp(`export function ${name}\\s*\\(`).test(dbCode),
                `db.js no longer exports ${name} — still needed for: ${why}`
            );
        }
    });

    test('syncBlocks and syncEvents are gone from server.js', () => {
        // These were the only writers of the sync-state keys 'blocks' and
        // 'events'. Re-arming either one gives the explorer a second indexer
        // racing syncChainIndex for the SQLite write lock.
        assert.ok(!/async function syncBlocks\s*\(/.test(serverCode),
            'syncBlocks() is back. It duplicates syncChainIndex and writes a fossilised ' +
            "setSyncState('blocks', 'Synced') that /api/blocks was repointed away from (F-020).");
        assert.ok(!/async function syncEvents\s*\(/.test(serverCode),
            'syncEvents() is back. Same as syncBlocks, plus it marks undecodable events ' +
            "as status 'success', which F-006 removed.");
    });

    test('the retired crawlers no longer write the dead sync-state keys', () => {
        // The precise damage was the write, not the function. Assert on that,
        // so a re-introduction under a different NAME still fails.
        assert.ok(!/setSyncState\(\s*'blocks'/.test(serverCode),
            "something writes setSyncState('blocks') again — the live key is 'chain_index'.");
        assert.ok(!/setSyncState\(\s*'events'/.test(serverCode),
            "something writes setSyncState('events') again — the live key is 'chain_index'.");
    });

    test('the crawlers\' re-entrancy latches are gone too', () => {
        // A leftover flag is how the next person accidentally resurrects the
        // pattern: they find a plausible latch and wire a new crawler to it.
        assert.ok(!/let isSyncingBlocks\b/.test(serverCode), 'isSyncingBlocks is back');
        assert.ok(!/let isSyncingEvents\b/.test(serverCode), 'isSyncingEvents is back');
    });

    test('the email subscriber row readers are not exported', () => {
        // They hand back confirmation_token and unsubscribe_token — bearer
        // credentials. Internal callers only; a projection is the way to
        // expose subscriber data.
        for (const name of ['getEmailSubscriberByEmail', 'getEmailSubscriberById']) {
            assert.ok(new RegExp(`\\bfunction ${name}\\s*\\(`).test(dbCode),
                `${name} was deleted, not un-exported — subscribe/confirm/unsubscribe need it.`);
            assert.ok(!new RegExp(`export function ${name}\\s*\\(`).test(dbCode),
                `${name} is exported again; it returns the full row including both tokens.`);
        }
    });
});

describe('F-164 — one identity lookup, imported by the probes', () => {
    test('lib/identity.js owns the superOf -> identityOf walk', () => {
        assert.ok(/export async function getOnChainIdentity/.test(identityLib));
        assert.ok(identityLib.includes('identity.superOf'));
        assert.ok(identityLib.includes('identity.identityOf'));
    });

    test('server.js imports the helper instead of defining one', () => {
        assert.ok(/import \{[^}]*getOnChainIdentity[^}]*\} from '\.\/lib\/identity\.js'/.test(serverCode),
            'server.js no longer imports getOnChainIdentity from lib/identity.js');
        assert.ok(!/function getOnChainIdentity\s*\(/.test(serverCode),
            'server.js defines its own getOnChainIdentity again — that is the finding.');
        assert.ok(!/function formatIdentityName\s*\(/.test(serverCode),
            'server.js defines its own formatIdentityName again.');
    });

    for (const [file, code] of [['debug-identity.js', debugIdCode],
                                ['debug-holder-identities.js', debugHoldCode]]) {
        test(`${file} imports the shared helper`, () => {
            assert.ok(/from '\.\/lib\/identity\.js'/.test(code),
                `${file} does not import lib/identity.js`);
        });

        test(`${file} does not query the identity pallet itself`, () => {
            // This is the assertion that actually closes the finding. Round 1
            // left the queries in place under a comment saying not to copy
            // them; comment-stripped source is what is checked here, so that
            // arrangement fails.
            assert.ok(!/identity\.superOf\(/.test(code),
                `${file} calls identity.superOf directly — re-copied the walk.`);
            assert.ok(!/identity\.identityOf\(/.test(code),
                `${file} calls identity.identityOf directly — re-copied the walk.`);
        });
    }

    // Behavioural, not structural: the pallet's two storage shapes are the
    // part that silently breaks on a runtime upgrade, and a probe that handles
    // only one of them is how production and the probe come to disagree.
    const fakeOpt = (some, human) => ({
        isSome: some,
        toHuman: () => human,
        unwrap: () => human
    });

    test('reads the newer Option<Registration> shape', async () => {
        const { getOnChainIdentity } = await import('../lib/identity.js');
        const api = { query: { identity: {
            superOf: async () => ({ isSome: false }),
            identityOf: async () => fakeOpt(true, { info: { display: { Raw: 'Alice' } } })
        } } };
        assert.equal(await getOnChainIdentity(api, 'addr'), 'Alice');
    });

    test('reads the older (Registration, Hash) tuple shape', async () => {
        const { getOnChainIdentity } = await import('../lib/identity.js');
        const api = { query: { identity: {
            superOf: async () => ({ isSome: false }),
            identityOf: async () => fakeOpt(true, [{ info: { display: { Raw: 'Bob' } } }, null])
        } } };
        assert.equal(await getOnChainIdentity(api, 'addr'), 'Bob',
            'the tuple shape returned Unknown — this is the runtime-upgrade break');
    });

    test('resolves a sub-identity through its parent', async () => {
        const { getOnChainIdentity } = await import('../lib/identity.js');
        const api = { query: { identity: {
            superOf: async () => ({
                isSome: true,
                unwrap: () => ['parentAddr', { toHuman: () => ({ Raw: 'node-01' }) }]
            }),
            identityOf: async () => fakeOpt(true, { info: { display: { Raw: 'Validator Co' } } })
        } } };
        assert.equal(await getOnChainIdentity(api, 'addr'), 'Validator Co / node-01');
    });

    test('hex-encoded display names are decoded, not shown as 0x', async () => {
        const { formatIdentityName } = await import('../lib/identity.js');
        assert.equal(formatIdentityName('0x' + Buffer.from('Polkadex').toString('hex')), 'Polkadex');
    });

    test('a null api and a throwing api both return Unknown, not a throw', async () => {
        const { getOnChainIdentity } = await import('../lib/identity.js');
        assert.equal(await getOnChainIdentity(null, 'addr'), 'Unknown');
        const boom = { query: { identity: {
            superOf: async () => { throw new Error('disconnected'); },
            identityOf: async () => { throw new Error('disconnected'); }
        } } };
        let seen = null;
        assert.equal(await getOnChainIdentity(boom, 'addr', { onError: (e) => { seen = e; } }), 'Unknown');
        assert.ok(seen, 'onError was not invoked, so the caller cannot log the failure');
    });
});

describe('F-093 — the SQLite RAM recipe multiplies both knobs by WORKERS', () => {
    const FORMULA = /\(\s*SQLITE_CACHE_MB\s*\+\s*SQLITE_MMAP_MB\s*\)\s*[×x*]\s*WORKERS/;

    test('INSTALL.md states (cache + mmap) x WORKERS', () => {
        assert.match(install, FORMULA,
            'INSTALL.md does not carry the (SQLITE_CACHE_MB + SQLITE_MMAP_MB) × WORKERS formula');
    });

    test('.env.example states (cache + mmap) x WORKERS', () => {
        assert.match(envExample, FORMULA,
            '.env.example does not carry the (SQLITE_CACHE_MB + SQLITE_MMAP_MB) × WORKERS formula');
    });

    test('mmap is derived from a RAM budget, not picked by feel', () => {
        for (const [name, src] of [['INSTALL.md', install], ['.env.example', envExample]]) {
            assert.ok(/SQLITE_MMAP_MB\s*=\s*per_worker_mb\s*-\s*SQLITE_CACHE_MB/.test(src),
                `${name} has no budget -> mmap derivation`);
        }
    });

    // The obvious test here would ban the old `SQLITE_CACHE_MB=512` +
    // `SQLITE_MMAP_MB=4096` pair. It cannot be written that way: both docs
    // now QUOTE that pair while explaining why it was wrong, which is the
    // house style, and neither file has code/comment separation a stripper
    // could use (.env.example is entirely `#` lines; INSTALL.md is prose).
    // Banning the string would either fail on the explanation or force the
    // explanation out — and this suite has already shipped one guard that
    // passed by matching its own comment.
    //
    // So check the ARITHMETIC of the actual recommendation rows instead. That
    // is the property the finding is about, it cannot be satisfied by prose,
    // and it keeps holding when someone rewrites the wording.
    const budgetMb = (gb) => gb * 1024 / 2;   // the half-of-RAM rule both docs state

    test('every .env.example recipe row fits the half-of-RAM budget', () => {
        const rows = [...envExample.matchAll(
            /(\d+)\s*GB\s*\/\s*(\d+)\s*workers:\s*SQLITE_CACHE_MB=(\d+)\s+SQLITE_MMAP_MB=(\d+)/g)];
        assert.ok(rows.length >= 3, 'the sizing table disappeared from .env.example');
        for (const [, gb, workers, cache, mmap] of rows) {
            const total = (Number(cache) + Number(mmap)) * Number(workers);
            assert.ok(total <= budgetMb(Number(gb)),
                `${gb} GB / ${workers} workers asks for ${total} MB, over the ` +
                `${budgetMb(Number(gb))} MB budget the same section promises`);
        }
    });

    test('every INSTALL.md table row fits the half-of-RAM budget', () => {
        const rows = [...install.matchAll(
            /\|\s*(\d+)\s*GB\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/g)];
        assert.ok(rows.length >= 3, 'the sizing table disappeared from INSTALL.md');
        for (const [, gb, workers, cache, mmap] of rows) {
            const total = (Number(cache) + Number(mmap)) * Number(workers);
            assert.ok(total <= budgetMb(Number(gb)),
                `INSTALL.md row "${gb} GB / ${workers} workers" asks for ${total} MB, over ` +
                `the ${budgetMb(Number(gb))} MB budget the same section promises`);
        }
    });

    test('the shipped defaults are inside the formula for a small box', () => {
        // db.js's fallbacks are what an operator who touches nothing gets.
        // 128 + 1024 per worker must stay a number the docs can defend.
        const dbSrc = readRepo('db.js', import.meta.url);
        const cache = Number(/SQLITE_CACHE_MB \|\| '(\d+)'/.exec(dbSrc)?.[1]);
        const mmap  = Number(/SQLITE_MMAP_MB \|\| '(\d+)'/.exec(dbSrc)?.[1]);
        assert.ok(Number.isFinite(cache) && Number.isFinite(mmap),
            'could not read the SQLITE_CACHE_MB / SQLITE_MMAP_MB defaults out of db.js');
        assert.ok(envExample.includes(`SQLITE_CACHE_MB=${cache}`),
            `.env.example does not document the real default cache (${cache} MB)`);
        assert.ok(envExample.includes(`SQLITE_MMAP_MB=${mmap}`),
            `.env.example does not document the real default mmap (${mmap} MB)`);
        // 4 workers is the modest-box case the template calls out.
        assert.ok((cache + mmap) * 4 <= budgetMb(16),
            `the defaults alone (${(cache + mmap) * 4} MB at 4 workers) exceed half of 16 GB`);
    });
});

describe('F-024 — the cert bootstrap issues a real certificate', () => {
    test('init-letsencrypt.sh actually runs certonly', () => {
        // The script was named for Let's Encrypt and never invoked it. This is
        // the finding's own close test.
        assert.match(initLECode, /certbot\s+certonly\b/,
            'init-letsencrypt.sh still never runs certonly');
        assert.match(initLECode, /--webroot/, 'certonly has no challenge method');
    });

    test('a self-signed result is a hard failure, not a success message', () => {
        assert.ok(/is_self_signed\s*\(\)/.test(initLECode),
            'no self-signed detector — "a fullchain.pem exists" was the whole bug');
        // Issuer == subject, checked locally. A file-exists check passes on the
        // placeholder, which is exactly how this shipped for two rounds.
        assert.ok(/-noout\s+-issuer/.test(initLECode) && /-noout\s+-subject/.test(initLECode),
            'the detector does not compare issuer against subject');

        // Scoped to the code AFTER issuance, and bounded. The obvious version
        // of this assertion — /if is_self_signed[\s\S]*exit 1/ over the whole
        // file — SURVIVED a mutation that replaced this very check with a
        // file-exists warning: the greedy match paired the placeholder check
        // near the top with the `exit 1` in the certonly-failure branch, and
        // reported success for a script that had lost the guard entirely.
        const afterIssuance = initLECode.slice(initLECode.indexOf('certonly'));
        assert.ok(/if is_self_signed[\s\S]{0,300}?exit 1/.test(afterIssuance),
            'nothing re-checks for a self-signed cert AFTER certonly and exits non-zero. ' +
            'A file-exists check here is the original bug: the placeholder satisfies it.');
    });

    test('is_self_signed actually distinguishes the two cases', async () => {
        // Structure is not the property; the property is that the detector
        // says yes to a placeholder and no to a CA-issued cert. Run the real
        // shell function against real certificates.
        const { execFileSync } = await import('node:child_process');
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const os = await import('node:os');
        const nodePath = await import('node:path');

        const tmp = mkdtempSync(nodePath.join(os.tmpdir(), 'pdex-cert-'));
        const sh = (script) => execFileSync('bash', ['-c', script], { cwd: tmp, encoding: 'utf8' });

        // Extract the function verbatim from the script under test, so this
        // cannot drift from what actually ships.
        const fnMatch = /is_self_signed\(\) \{[\s\S]*?\n\}/.exec(initLE);
        assert.ok(fnMatch, 'could not extract is_self_signed() from init-letsencrypt.sh');
        writeFileSync(nodePath.join(tmp, 'fn.sh'), fnMatch[0] + '\n');

        try {
            // A placeholder, exactly as the bootstrap writes one.
            sh("openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout ss.key -out ss.pem -subj '/CN=explorer.example' 2>/dev/null");
            // A leaf issued by a separate CA — the shape a real origin cert has.
            sh("openssl req -x509 -nodes -newkey rsa:2048 -days 1 -keyout ca.key -out ca.pem -subj '/CN=Test Origin CA' 2>/dev/null");
            sh("openssl req -new -nodes -newkey rsa:2048 -keyout leaf.key -out leaf.csr -subj '/CN=explorer.example' 2>/dev/null");
            sh("openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -out leaf.pem 2>/dev/null");
        } catch (e) {
            // openssl is a hard dependency of the script itself, so its absence
            // is worth failing on rather than skipping past.
            assert.fail(`openssl unavailable, cannot verify is_self_signed: ${e.message}`);
        }

        const verdict = (pem) =>
            sh(`. ./fn.sh; if is_self_signed ${pem}; then echo SELF; else echo CA; fi`).trim();

        assert.equal(verdict('ss.pem'), 'SELF',
            'the placeholder is NOT detected as self-signed — Full (Strict) would 526 silently');
        assert.equal(verdict('leaf.pem'), 'CA',
            'a CA-issued certificate is misreported as self-signed — every issuance would fail');
        assert.equal(verdict('missing.pem'), 'SELF',
            'an absent cert must count as self-signed; "cannot tell" is not "safe to serve"');
    });

    test('the placeholder path must be asked for by name', () => {
        assert.match(initLECode, /ORIGIN_CERT_MODE:-letsencrypt/,
            'the default mode is not letsencrypt');
        assert.match(initLECode, /self-signed-bootstrap/,
            'there is no named bootstrap mode');
        // The old ending. It reported success for a certificate Cloudflare
        // rejects, and blamed browser warnings — the wrong failure entirely.
        assert.ok(!/Self-Signed Certificate Generated!/.test(initLECode),
            'the script still signs off a placeholder as a generated certificate');
    });

    test('provision asks for the bootstrap mode explicitly', () => {
        // `bash ./…` since F-197: the file is tracked 100644, so the previous
        // `[ -x ./init-letsencrypt.sh ]` gate was false in a fresh checkout and
        // this call never ran at all.
        assert.match(provCode, /ORIGIN_CERT_MODE=self-signed-bootstrap\s+(bash\s+)?\.\/init-letsencrypt\.sh/,
            'provision calls init-letsencrypt.sh without naming the bootstrap mode — with the ' +
            'new default that attempts HTTP-01 during provisioning, which cannot work behind ' +
            'an orange-clouded record.');
    });

    test('`all` refuses to finish on a placeholder for a public domain', () => {
        // Round 1 warned here and continued; that is what kept F-024 open.
        assert.ok(/_domain_is_public\s*\(\)/.test(provCode),
            'no public-domain test — the guard would fire on laptops and staging boxes');
        assert.ok(/_domain_is_public "\$DOMAIN"[\s\S]{0,200}?ALLOW_SELF_SIGNED_ORIGIN/.test(provCode),
            'run_all does not gate on (public domain AND no explicit override)');
        const runAll = provCode.slice(provCode.indexOf('run_all()'));
        const guard = runAll.slice(0, runAll.indexOf('setup_cloudflare_only'));
        assert.ok(/\bdie\b/.test(guard),
            'run_all still only warns when the origin cert is missing');
    });

    test('_domain_is_public draws the line where the guard needs it', async () => {
        // Existence of the function is not the property. Too broad and every
        // laptop provision dies on a guard that is irrelevant there; too narrow
        // and explorer.polkadex.ee slips through, which is the finding. Run the
        // real function.
        const { execFileSync } = await import('node:child_process');
        const fnMatch = /_domain_is_public\(\) \{[\s\S]*?\n\}/.exec(provision);
        assert.ok(fnMatch, 'could not extract _domain_is_public() from provision-ubuntu.sh');

        const verdict = (d) => execFileSync('bash', ['-c',
            `${fnMatch[0]}\nif _domain_is_public "$1"; then echo PUBLIC; else echo PRIVATE; fi`,
            '_', d], { encoding: 'utf8' }).trim();

        for (const d of ['explorer.polkadex.ee', 'polkadex.ee'])
            assert.equal(verdict(d), 'PUBLIC',
                `${d} must be treated as public or the guard never fires in production`);

        for (const d of ['localhost', 'explorer.local', 'box.internal', 'staging.test',
                         'example.com', '192.168.1.10', 'devbox', ''])
            assert.equal(verdict(d), 'PRIVATE',
                `${d} must not trip the guard — a self-signed origin is correct there`);
    });

    test('the override is a named opt-out, not the default', () => {
        assert.match(provCode, /ALLOW_SELF_SIGNED_ORIGIN:-0/,
            'ALLOW_SELF_SIGNED_ORIGIN defaults to something other than off');
    });

    test('a failed issuance restores the placeholder so nginx can still start', () => {
        // The lineage dir has to be removed before certbot will take it over.
        // If issuance then fails and nothing is put back, the box has no cert
        // at all — a 521 instead of a 526, i.e. worse.
        assert.ok(/placeholder_removed/.test(initLECode),
            'nothing tracks whether the placeholder was removed');
        assert.ok(/placeholder_removed:-0.*=.*1[\s\S]{0,300}write_self_signed_placeholder/.test(initLECode),
            'a failed certonly leaves the host with no certificate at all');
    });
});
