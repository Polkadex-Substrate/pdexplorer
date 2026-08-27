// Tests for lib/commission-history.js.
//
// Not an audit finding — a nominator complaint:
//
//   "The validator rewards list is absolutely useless and inaccurate. It's
//    absolutely pointless staking when every validator changing rewards amount
//    to 1 percent the day after you nominate them. Every single one."
//
// So the central test is the reported SCENARIO, not the function's edges: a
// validator advertising a low commission, attracting a nomination, then raising
// it. The old list rendered that validator identically to one that had never
// moved, because it only ever showed the current number.
//
// The second theme is restraint. It would be easy to make this shout, and two
// tests below deliberately pin that it does not: the epsilon (so float noise in
// a Perbill round-trip cannot accuse an honest validator of "changing
// commission") and the wording (evidence, never a verdict).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import {
    summarizeCommissionHistory, classifyVolatility, raisedRecently,
    describeCommissionHistory, pendingRaise, COMMISSION_EPSILON
} from '../lib/commission-history.js';

// eras: [{ era, commission }]
const hist = (...pairs) => pairs.map(([era, commission]) => ({ era, commission }));

describe('the reported scenario: bait and switch', () => {
    // 1% for ten eras, then 20% — the shape the complaint describes.
    const baitAndSwitch = hist(
        [100, 1], [101, 1], [102, 1], [103, 1], [104, 1],
        [105, 1], [106, 1], [107, 1], [108, 1], [109, 1], [110, 20]
    );

    test('the raise is detected, with its from/to and era', () => {
        const s = summarizeCommissionHistory(baitAndSwitch);
        assert.equal(s.changes, 1);
        assert.equal(s.raises, 1);
        assert.equal(s.cuts, 0);
        assert.deepEqual(s.lastChange,
            { era: 110, from: 1, to: 20, earliestEra: 110, certain: true },
            'consecutive eras: the change era is known exactly');
        assert.equal(s.current, 20);
        assert.equal(s.min, 1);
        assert.equal(s.max, 20);
    });

    test('a 19-point jump is classified volatile, not "moved once"', () => {
        // One change, but a change that guts the nominator's yield. Counting
        // changes alone would file this alongside a 1%→1.5% adjustment.
        const s = summarizeCommissionHistory(baitAndSwitch);
        assert.equal(s.volatility, 'volatile');
    });

    test('it is flagged as raised-recently for the eras that matter', () => {
        const s = summarizeCommissionHistory(baitAndSwitch);
        assert.equal(raisedRecently(s, 110), true, 'same era as the raise');
        assert.equal(raisedRecently(s, 117), true, 'seven eras later — still news');
        assert.equal(raisedRecently(s, 118), false, 'past the window');
    });

    test('the DISTINGUISHING property: a genuinely stable validator looks different', () => {
        // This is the whole point. Before the fix these two rendered
        // identically, because the list showed only the current number.
        const stable = hist([100, 1], [101, 1], [102, 1], [103, 1], [104, 1],
                            [105, 1], [106, 1], [107, 1], [108, 1], [109, 1], [110, 1]);
        const a = summarizeCommissionHistory(stable);
        const b = summarizeCommissionHistory(hist(
            [100, 20], [101, 20], [102, 20], [103, 20], [104, 20],
            [105, 20], [106, 20], [107, 20], [108, 20], [109, 20], [110, 1]
        ));
        // Both currently sit at 1%.
        assert.equal(a.current, 1);
        assert.equal(b.current, 1);
        // But their histories are not the same, and the UI note says so.
        assert.notEqual(a.volatility, b.volatility);
        assert.notEqual(describeCommissionHistory(a), describeCommissionHistory(b));
    });

    test('a CUT is not flagged as a raise', () => {
        // Dropping commission benefits the nominator. Warning about it would
        // train people to ignore the badge.
        const cut = summarizeCommissionHistory(hist([100, 20], [101, 20], [102, 5]));
        assert.equal(cut.cuts, 1);
        assert.equal(cut.raises, 0);
        assert.equal(raisedRecently(cut, 102), false);
    });
});

describe('restraint: float noise must not accuse anyone', () => {
    test('a sub-epsilon wobble is not a change', () => {
        // Commission is a Perbill on chain; through REAL and back, "1%" can
        // arrive as 0.9999999. Counting that would label every validator on
        // the list as having changed commission — a false accusation at scale,
        // and far worse than missing a trivial real adjustment.
        const noisy = hist([1, 1.0], [2, 1.0 + COMMISSION_EPSILON / 2], [3, 1.0], [4, 0.999999]);
        const s = summarizeCommissionHistory(noisy);
        assert.equal(s.changes, 0);
        assert.equal(s.volatility, 'stable');
    });

    test('a change at exactly the epsilon boundary counts', () => {
        const s = summarizeCommissionHistory(hist([1, 1.0], [2, 1.0 + COMMISSION_EPSILON], [3, 1.0 + COMMISSION_EPSILON]));
        assert.equal(s.changes, 1);
    });

    test('a real small change is still reported', () => {
        const s = summarizeCommissionHistory(hist([1, 1], [2, 1], [3, 2]));
        assert.equal(s.changes, 1);
        assert.equal(s.volatility, 'moved', 'one small move is "moved", not "volatile"');
    });
});

describe('restraint: the wording states evidence, not a verdict', () => {
    test('the note is factual and quantified', () => {
        const s = summarizeCommissionHistory(hist([1, 1], [2, 5], [3, 20]));
        const note = describeCommissionHistory(s);
        assert.match(note, /raised 2×/);
        assert.match(note, /3 tracked eras/);
        assert.match(note, /1\.00–20\.00%/);
    });

    test('no judgemental language anywhere in the module', () => {
        // An explorer that editorialises about named operators on a page where
        // they cannot reply is doing something other than reporting — and a
        // validator with one honest raise would be tarred like a serial one.
        const src = readFileSync(new URL('../lib/commission-history.js', import.meta.url), 'utf8');
        const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
        for (const word of ['scam', 'dishonest', 'untrustworthy', 'bad actor',
                            'avoid', 'warning', 'cheat', 'rug']) {
            assert.ok(!new RegExp(word, 'i').test(code),
                `the module renders the word "${word}" — state the evidence, let the nominator judge`);
        }
    });

    test('a stable validator gets a positive-but-bounded statement', () => {
        // "unchanged across N tracked eras" — not "trustworthy". We can vouch
        // for what we observed, not for intent.
        const s = summarizeCommissionHistory(hist([1, 5], [2, 5], [3, 5], [4, 5]));
        assert.equal(describeCommissionHistory(s), 'unchanged across 4 tracked eras');
    });
});

describe('not knowing is its own answer', () => {
    test('too little history is "unknown", never "stable"', () => {
        // A validator we have watched for two eras has not "been stable" —
        // we have not been looking. Claiming stability we did not observe is
        // the same class of lie as F-004's status and F-081's zero counts.
        for (const rows of [[], hist([1, 5]), hist([1, 5], [2, 5])]) {
            assert.equal(summarizeCommissionHistory(rows).volatility, 'unknown');
        }
    });

    test('an unknown history produces NO note, so the UI can stay quiet', () => {
        assert.equal(describeCommissionHistory(summarizeCommissionHistory([])), '');
        assert.equal(describeCommissionHistory(null), '');
    });

    test('a 2-era history never badges RAISED RECENTLY', () => {
        // A review catch: raisedRecently did not consult volatility, so a
        // validator with two indexed eras and a raise between them rendered
        // "RAISED RECENTLY" and "history not yet indexed" in the SAME cell.
        const thin = summarizeCommissionHistory(hist([100, 1], [101, 20]));
        assert.equal(thin.volatility, 'unknown');
        assert.equal(raisedRecently(thin, 101), false,
            'recency claimed on a history too thin to classify');
    });

    test('raisedRecently is false when the era is unknown', () => {
        const s = summarizeCommissionHistory(hist([1, 1], [2, 20]));
        assert.equal(raisedRecently(s, null), false);
        assert.equal(raisedRecently(s, undefined), false);
        assert.equal(raisedRecently(s, 'era-2'), false);
    });
});

describe('summarizeCommissionHistory — mechanics', () => {
    test('rows are sorted by era, whatever order they arrive in', () => {
        // The SQL orders them, but a caller must not have to know that.
        const shuffled = hist([3, 20], [1, 1], [2, 5]);
        const s = summarizeCommissionHistory(shuffled);
        assert.equal(s.current, 20, 'current must be the NEWEST era, not the last row');
        assert.deepEqual(s.lastChange, { era: 3, from: 5, to: 20, earliestEra: 3, certain: true });
    });

    test('gaps in era coverage do not invent changes', () => {
        // The indexer may not have every era. A jump from era 100 to era 140
        // at the same commission is not a change.
        const s = summarizeCommissionHistory(hist([100, 5], [140, 5], [180, 5]));
        assert.equal(s.changes, 0);
        assert.equal(s.erasTracked, 3, 'erasTracked counts rows we HAVE, not the era span');
    });

    test('malformed rows are skipped, not crashed on', () => {
        assert.doesNotThrow(() => summarizeCommissionHistory(null));
        assert.doesNotThrow(() => summarizeCommissionHistory([null, {}, { era: 1 }]));
        const s = summarizeCommissionHistory([{ era: 1, commission: 5 }, { era: 2, commission: null },
                                              { era: 3, commission: 'x' }, { era: 4, commission: 5 }]);
        assert.equal(s.erasTracked, 2);
        assert.equal(s.changes, 0);
    });

    test('classifyVolatility thresholds', () => {
        assert.equal(classifyVolatility({ erasTracked: 2, changes: 0, values: [1, 1] }), 'unknown');
        assert.equal(classifyVolatility({ erasTracked: 30, changes: 0, values: [1] }), 'stable');
        assert.equal(classifyVolatility({ erasTracked: 30, changes: 1, values: [1, 2] }), 'moved');
        assert.equal(classifyVolatility({ erasTracked: 30, changes: 2, values: [1, 2] }), 'volatile');
        assert.equal(classifyVolatility({ erasTracked: 30, changes: 1, values: [1, 6] }), 'volatile',
            'a single 5-point move is material even if it is the only one');
    });
});

describe('the whole path, against a real SQLite database', () => {
    // Everything above tests the pure module. This exercises the actual query
    // db.getCommissionHistoryByValidator runs, against the real
    // validator_history schema, through to the rendered note — because the
    // review found two blockers that no amount of source-regex could see, and
    // one of them (phantom 0% eras) fails on a two-row fixture.
    const { DatabaseSync } = require('node:sqlite');
    const dbSrcLocal = readFileSync(new URL('../db.js', import.meta.url), 'utf8');

    function realDb() {
        const d = new DatabaseSync(':memory:');
        // The genuine schema, lifted from db.js so a column rename breaks this.
        const create = dbSrcLocal.slice(
            dbSrcLocal.indexOf('CREATE TABLE IF NOT EXISTS validator_history'),
            dbSrcLocal.indexOf(');', dbSrcLocal.indexOf('CREATE TABLE IF NOT EXISTS validator_history')) + 2
        );
        assert.ok(create.includes('commission'), 'could not lift the validator_history schema');
        d.exec(create);
        return d;
    }

    // The exact statement db.js issues.
    function readGrouped(d) {
        const sql = dbSrcLocal.slice(
            dbSrcLocal.indexOf("'SELECT address, era, commission, stake FROM validator_history'"),
            dbSrcLocal.indexOf("'SELECT address, era, commission, stake FROM validator_history'") + 200
        );
        assert.ok(sql.length > 0, 'the db.js query changed shape — update this test');
        const rows = d.prepare('SELECT address, era, commission, stake FROM validator_history').all();
        const out = Object.create(null);
        for (const r of rows) (out[r.address] || (out[r.address] = [])).push({
            era: Number(r.era), commission: Number(r.commission), stake: Number(r.stake)
        });
        return out;
    }

    test('a newly-elected validator is NOT accused of raising commission', () => {
        // THE BLOCKER. staking.erasValidatorPrefs is a ValueQuery: querying an
        // era the validator was not elected in returns default prefs, which the
        // indexer stores as commission 0 / stake 0. Read as history that is
        // "raised from 0% to 1%" — a fabricated accusation against a named
        // operator whose only offence was getting elected.
        const d = realDb();
        const ins = d.prepare('INSERT INTO validator_history(era,address,commission,stake,apy) VALUES(?,?,?,?,?)');
        ins.run(100, 'esNEW', 0, 0, 0);     // not elected yet
        ins.run(101, 'esNEW', 0, 0, 0);     // not elected yet
        ins.run(102, 'esNEW', 1, 5000, 22); // elected, 1% commission
        ins.run(103, 'esNEW', 1, 5000, 22);
        ins.run(104, 'esNEW', 1, 5000, 22);

        const s = summarizeCommissionHistory(readGrouped(d)['esNEW']);
        assert.equal(s.changes, 0, 'the phantom 0% eras were counted as a commission change');
        assert.equal(s.raises, 0);
        assert.equal(s.min, 1, 'min must not be the unelected 0%');
        assert.equal(raisedRecently(s, 104), false,
            'a brand-new validator was badged RAISED RECENTLY');
        assert.match(describeCommissionHistory(s), /unchanged/);
    });

    test('the real bait-and-switch still comes through the real query', () => {
        const d = realDb();
        const ins = d.prepare('INSERT INTO validator_history(era,address,commission,stake,apy) VALUES(?,?,?,?,?)');
        for (let e = 100; e <= 109; e++) ins.run(e, 'esBAIT', 1, 9000, 22);
        ins.run(110, 'esBAIT', 20, 9000, 4);

        const s = summarizeCommissionHistory(readGrouped(d)['esBAIT']);
        assert.equal(s.volatility, 'volatile');
        assert.equal(s.raises, 1);
        assert.equal(raisedRecently(s, 110), true);
        assert.match(describeCommissionHistory(s), /raised 1×/);
    });

    test('a steady validator and a just-dropped one are distinguishable end to end', () => {
        const d = realDb();
        const ins = d.prepare('INSERT INTO validator_history(era,address,commission,stake,apy) VALUES(?,?,?,?,?)');
        for (let e = 100; e <= 110; e++) ins.run(e, 'esSTEADY', 1, 9000, 22);
        for (let e = 100; e <= 109; e++) ins.run(e, 'esDROPPED', 20, 9000, 4);
        ins.run(110, 'esDROPPED', 1, 9000, 22);

        const g = readGrouped(d);
        const a = summarizeCommissionHistory(g['esSTEADY']);
        const b = summarizeCommissionHistory(g['esDROPPED']);
        assert.equal(a.current, 1);
        assert.equal(b.current, 1, 'both sit at 1% today — this is the case the old list could not tell apart');
        assert.notEqual(describeCommissionHistory(a), describeCommissionHistory(b));
        assert.equal(a.volatility, 'stable');
        assert.equal(b.volatility, 'volatile');
    });

    test('the query selects stake — without it the phantom-era filter is impossible', () => {
        assert.match(dbSrcLocal, /SELECT address, era, commission, stake FROM validator_history/,
            'stake is no longer selected, so unelected eras cannot be filtered (the blocker returns)');
    });
});

describe('pendingRaise — the raise that has not reached an era boundary', () => {
    test('a live commission above the newest tracked era is flagged', () => {
        // erasValidatorPrefs is stamped at era start, so a raise made today is
        // invisible in history for ~24h — exactly the "day after you nominate
        // them" window. Comparing the live value closes it.
        const s = summarizeCommissionHistory(hist([100, 1], [101, 1], [102, 1]));
        assert.equal(pendingRaise(s, 20), true);
        assert.equal(pendingRaise(s, 1), false);
        assert.equal(pendingRaise(s, 0.5), false, 'a CUT is not a pending raise');
    });

    test('sub-epsilon drift is not a pending raise', () => {
        const s = summarizeCommissionHistory(hist([100, 1], [101, 1], [102, 1]));
        assert.equal(pendingRaise(s, 1 + COMMISSION_EPSILON / 2), false);
    });

    test('missing inputs are false, never true', () => {
        const s = summarizeCommissionHistory(hist([100, 1], [101, 1], [102, 1]));
        for (const v of [null, undefined, '', NaN, 'x']) {
            assert.equal(pendingRaise(s, v), false, `live commission ${JSON.stringify(v)}`);
        }
        assert.equal(pendingRaise(null, 20), false);
        assert.equal(pendingRaise(summarizeCommissionHistory([]), 20), false);
    });
});

describe('gaps in coverage are disclosed, not glossed', () => {
    test('a change across a gap is dated as a RANGE and not badged recent', () => {
        // The loop compares consecutive rows, which are not consecutive eras.
        // Dating a change to the first era after a 40-era hole would badge a
        // months-old raise as recent.
        const s = summarizeCommissionHistory(hist([100, 5], [101, 5], [102, 5], [140, 20]));
        assert.equal(s.lastChange.era, 140);
        assert.equal(s.lastChange.earliestEra, 103, 'the earliest era it could have happened');
        assert.equal(s.lastChange.certain, false);
        assert.equal(raisedRecently(s, 145), false,
            'a change that may be 40 eras old was badged as recent');
    });

    test('consecutive eras ARE certain, and do badge', () => {
        const s = summarizeCommissionHistory(hist([100, 5], [101, 5], [102, 20]));
        assert.equal(s.lastChange.certain, true);
        assert.equal(s.lastChange.earliestEra, 102);
        assert.equal(raisedRecently(s, 103), true);
    });

    test('the note says "N of M" when coverage is sparse', () => {
        const sparse = summarizeCommissionHistory(hist([100, 5], [101, 5], [102, 5], [140, 20]));
        assert.match(describeCommissionHistory(sparse), /4 of 41 tracked eras/);
        const dense = summarizeCommissionHistory(hist([100, 5], [101, 5], [102, 20]));
        assert.match(describeCommissionHistory(dense), /in 3 tracked eras/);
        assert.ok(!/ of /.test(describeCommissionHistory(dense)),
            'dense coverage must not be padded with a redundant span');
    });

    test('eraSpan and gaps are reported', () => {
        const s = summarizeCommissionHistory(hist([100, 5], [140, 5]));
        assert.equal(s.eraSpan, 41);
        assert.equal(s.gaps, 1);
        assert.equal(s.erasTracked, 2);
    });
});

describe('the wiring: the list and the picker both show it', () => {
    const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const scriptSrc = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
    const dbSrc     = readFileSync(new URL('../db.js', import.meta.url), 'utf8');

    test('the validator history sync is on an INTERVAL, not just a boot kick', () => {
        // A review catch, and the deepest one: syncData — which refreshes the
        // validator set, `validators.commission` and every era of
        // validator_history — had only a one-shot setTimeout at boot while
        // every sibling sync had an interval. So the newest era we held froze
        // at boot, while `activeEra` (from network_info) kept advancing. That
        // makes `raisedRecently` compare a fresh era against a stale one, and
        // the badge that answers "they raised it the day after I nominated"
        // stops firing about a week after each deploy and never fires again.
        assert.match(serverSrc, /setInterval\(syncData, VALIDATOR_SYNC_INTERVAL_MS\)/,
            'syncData has no interval — the commission history freezes at boot');
        assert.match(serverSrc, /const VALIDATOR_SYNC_INTERVAL_MS = readPositiveInteger/);
    });

    test('the era window is clamped to the chain HistoryDepth', () => {
        // erasValidatorPrefs is pruned past HistoryDepth and is a ValueQuery,
        // so scanning beyond it reads 0% — and because upsertValidatorHistory
        // is INSERT OR REPLACE, that OVERWRITES true rows with zeros. A genuine
        // history rewrite, triggerable by one env var.
        const fn = serverSrc.slice(
            serverSrc.indexOf('async function syncValidatorHistory'),
            serverSrc.indexOf('async function syncValidatorHistory') + 2200
        );
        assert.match(fn, /historyDepth/,
            'VALIDATOR_HISTORY_ERAS is unclamped; setting it above HistoryDepth rewrites history as 0%');
        assert.match(fn, /const firstEra = Math\.max\(activeEra - depthCap \+ 1, 0\)/,
            'the clamp is computed but not used');
    });

    test('the pending-raise signal is attached and rendered', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.get('/api/validators'"),
            serverSrc.indexOf("app.get('/api/network-info'")
        );
        assert.match(route, /pendingRaise: pendingRaise\(summary, v\.commission\)/,
            'without this the feature is structurally one era behind its own motivating case');
        assert.match(scriptSrc, /h\.pendingRaise/);
        assert.match(scriptSrc, /RAISING NOW/);
    });

    test('the filter exposes volatility AND recency as independent tags', () => {
        // The first version returned a single class with 'raised' checked
        // first, so selecting "Changes often" EXCLUDED validators that change
        // often and had just raised — hiding the worst offenders from the
        // filter built to find them.
        const derive = scriptSrc.slice(
            scriptSrc.indexOf('derive: row => {'),
            scriptSrc.indexOf('format: row => commissionCell(row)')
        );
        assert.match(derive, /const tags = \[h\.volatility\]/,
            'volatility must always be present in the tag set');
        assert.match(derive, /if \(h\.raisedRecently\) tags\.push\('raised'\)/,
            'the recency tag is gone — the "Raised recently" option matches nothing');
        assert.match(derive, /if \(h\.pendingRaise\) tags\.push\('pending'\)/);
        // And applyFilters must actually understand an array.
        assert.match(scriptSrc, /Array\.isArray\(got\)\s*\?\s*got\.some\(t => String\(t\) === String\(val\)\)/,
            'applyFilters does not handle a multi-tag derive, so the extra options are dead');
    });

    test('every filter option value is producible by derive', () => {
        // A dropdown entry that can never match is a control that lies.
        const col = scriptSrc.slice(
            scriptSrc.indexOf("key: 'commission', label: 'Commission'"),
            scriptSrc.indexOf('format: row => commissionCell(row)')
        );
        const offered = [...col.matchAll(/\{ value: '(\w+)'/g)].map(m => m[1]).sort();
        // 'stable' | 'moved' | 'volatile' | 'unknown' from classifyVolatility,
        // plus the two independent tags.
        assert.deepEqual(offered, ['moved', 'pending', 'raised', 'stable', 'unknown', 'volatile']);
        for (const v of ['stable', 'moved', 'volatile', 'unknown']) {
            assert.ok(new RegExp(`'${v}'`).test(
                readFileSync(new URL('../lib/commission-history.js', import.meta.url), 'utf8')),
                `the filter offers '${v}' but classifyVolatility never returns it`);
        }
    });

    test('/api/validators attaches commissionHistory', () => {
        const route = serverSrc.slice(
            serverSrc.indexOf("app.get('/api/validators'"),
            serverSrc.indexOf("app.get('/api/network-info'")
        );
        assert.match(route, /db\.getCommissionHistoryByValidator\(\)/);
        assert.match(route, /summarizeCommissionHistory\(/);
        assert.match(route, /commissionHistory: \{/);
    });

    test('the enrichment cannot break the list itself', () => {
        // The page's job is showing validators. A failure in an extra column
        // must degrade that column, not 500 the endpoint. Checking the message
        // string alone (the first version) proved nothing about WHERE the
        // try/catch sits — assert the enclosure by offset.
        const route = serverSrc.slice(
            serverSrc.indexOf("app.get('/api/validators'"),
            serverSrc.indexOf("app.get('/api/network-info'")
        );
        const tryAt = route.indexOf('try {', route.indexOf('const payload = db.getValidators()'));
        const callAt = route.indexOf('db.getCommissionHistoryByValidator()');
        const catchAt = route.indexOf('commission-history enrichment skipped');
        assert.ok(tryAt !== -1 && callAt !== -1 && catchAt !== -1);
        assert.ok(tryAt < callAt && callAt < catchAt,
            'the enrichment is not enclosed by its own try/catch');
        // And the response is built from `payload` regardless.
        assert.match(route, /res\.json\(payload\)/);
    });

    test('it is derived at read time, not denormalised into the validators table', () => {
        // `validators` is DELETE-and-rebuild every sync, so a cached column
        // would be one more copy of a fact to keep in step — the exact drift
        // shape F-045 and F-109 were about.
        //
        // (An earlier version asserted the ABSENCE of column names that never
        // existed in any revision of db.js, which would have passed against
        // the old code too. Assert the positive instead: the validators table
        // schema is unchanged and the read-time query exists.)
        const schema = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS validators'),
                                   dbSrc.indexOf('CREATE TABLE IF NOT EXISTS holders'));
        assert.equal(schema.split('\n').filter(l => l.includes('commission')).length, 1,
            'the validators table grew a second commission column — that is the denormalisation this avoids');
        // Anchored: an unanchored /export function getCommissionHistoryByValidator/
        // also matches `...ByValidatorX`, so a rename passed the test while the
        // caller silently hit a TypeError swallowed by the enrichment catch.
        assert.match(dbSrc, /export function getCommissionHistoryByValidator\s*\(/);
    });

    test('EVERY db.* call in server.js resolves to a real db.js export', () => {
        // The general form of the bug above, and worth checking across the
        // whole file rather than for one function: db.js is imported as a
        // namespace, so a renamed export produces "db.foo is not a function"
        // at CALL time — which lands inside whichever try/catch happens to be
        // wrapping it, and for the commission enrichment that means the column
        // silently disappears with one warn line nobody reads.
        const exported = new Set(
            [...dbSrc.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1])
        );
        // Re-exports and const arrow exports.
        for (const m of dbSrc.matchAll(/^export (?:const|let) (\w+)/gm)) exported.add(m[1]);
        for (const m of dbSrc.matchAll(/^export \{([^}]+)\}/gm)) {
            for (const name of m[1].split(',')) {
                exported.add(name.trim().split(/\s+as\s+/).pop().trim());
            }
        }
        assert.ok(exported.size > 30, `only found ${exported.size} db.js exports — has the export style changed?`);

        // Comments first: prose like "db.js (the SQLite layer)" matches the
        // call pattern and reported a phantom `db.js` call. A test whose only
        // failure is its own false positive gets deleted, not fixed.
        const code = serverSrc.split('\n')
            .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
            .join('\n');
        const called = new Set(
            [...code.matchAll(/\bdb\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
        );
        const missing = [...called].filter(n => !exported.has(n)).sort();
        assert.deepEqual(missing, [],
            `server.js calls db.* functions that db.js does not export: ${missing.join(', ')}`);
    });

    test('the validators LIST renders it', () => {
        assert.match(scriptSrc, /function commissionCell\(row\)/);
        assert.match(scriptSrc, /format: row => commissionCell\(row\)/);
    });

    test('the NOMINATE picker renders it too', () => {
        // The list is where you browse; the picker is where you commit. The
        // complaint is about what happens after you nominate, so the warning
        // has to be on the screen where that decision is made.
        const picker = scriptSrc.slice(
            scriptSrc.indexOf('const isSelected = stakeSelected.has(v.address)'),
            scriptSrc.indexOf('listEl.querySelectorAll(\'.stake-validator-item\')')
        );
        assert.match(picker, /v\.commissionHistory/,
            'the stake/nominate picker does not show the commission track record');
        assert.match(picker, /raisedRecently/);
    });

    test('the derived-value filter is actually supported by makeTable', () => {
        // The column filters on a DERIVED class while the cell holds a
        // percentage. Without valueOf support in applyFilters the option would
        // be accepted and silently ignored — offering a control that does
        // nothing is worse than not offering it.
        // It must be `derive`, NOT `valueOf`. A review caught the first version
        // using `valueOf`, which is inherited from Object.prototype: the guard
        // `col.filter.valueOf && typeof ... === 'function'` is therefore TRUE
        // for every plain object, so the fallback was unreachable and calling
        // Object.prototype.valueOf with an undefined `this` threw — wedging all
        // twelve pre-existing select filters in this file until a page reload.
        // Comments stripped: the explanation above the fix names the very
        // pattern being searched for.
        const code = scriptSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
        assert.ok(!/col\.filter\.valueOf/.test(code),
            'filter.valueOf collides with Object.prototype.valueOf and breaks every select filter');
        assert.match(scriptSrc, /Object\.prototype\.hasOwnProperty\.call\(col\.filter, 'derive'\)/,
            'the option must be detected by hasOwnProperty, not truthiness');
        assert.match(scriptSrc, /const pick = hasDerive \? col\.filter\.derive : \(row\) => row\[col\.key\]/);
    });

    test('every interpolation in the new cell is escaped', () => {
        const fn = scriptSrc.slice(
            scriptSrc.indexOf('function commissionCell(row)'),
            scriptSrc.indexOf('// One renderer for every dispatch-status badge.')
        );
        const interps = [...fn.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].map(m => m[1].trim());
        const raw = interps.filter(e =>
            !/stakingEscapeHtml|escapeHtml/.test(e) && !/^tone$/.test(e));
        assert.deepEqual(raw, [], `unescaped interpolation in commissionCell: ${raw.join(' | ')}`);
    });
});
