// Round-2 PARTIAL residuals in script.js: F-044, F-067, F-068, F-117, F-118,
// F-120, F-132.
//
// These exist because a mutation run found them uncovered. Reverting the F-067,
// F-118 and F-120 fixes left the whole suite green — and the audit's own note
// on this cluster is that "F-044, F-117, F-132 have no safety net at all, so
// those changes rest entirely on review". Review is what let each of these stay
// half-fixed through round 1.
//
// script.js is a 15k-line browser bundle with no export surface, so the checks
// that can be behavioural are behavioural (the formatter is lifted out and run)
// and the rest read source. Comments are stripped first: several of these
// assert that a pattern is ABSENT, and the comment explaining why it must be
// absent contains the pattern.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';

const raw = readRepo('script.js', import.meta.url);
const src = stripComments(raw);

// ─────────────────────────────────────────────────────────────────────────────
// F-067 — planck-scale values must not go through Number() before dividing
// ─────────────────────────────────────────────────────────────────────────────

describe('F-067 — formatPDEX converts in BigInt', () => {
    // Lift the real implementations out and run them. The two are a pair:
    // formatPDEX now delegates to formatLivePDEX, so testing the source text
    // alone would not catch the delegation being reverted to arithmetic.
    function bodyOf(name) {
        const i = src.indexOf(`function ${name}(`);
        assert.ok(i !== -1, `${name} not found`);
        const open = src.indexOf('{', i);
        let depth = 0;
        for (let j = open; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
        }
        throw new Error(`unbalanced braces in ${name}`);
    }
    // eslint-disable-next-line no-new-func
    const formatPDEX = new Function(`${bodyOf('formatLivePDEX')}\n${bodyOf('formatPDEX')}\nreturn formatPDEX;`)();

    test('a comma-grouped u128 is parsed, not turned into NaN', () => {
        // The live difference. polkadot.js toHuman() emits exactly this shape,
        // and Number("10,589,...") is NaN — the card would read "NaN PDEX".
        const human = '10,589,041,095,890,410,958,904';
        assert.equal(formatPDEX(human), '10,589,041,095.89');
        assert.ok(!formatPDEX(human).includes('NaN'));
    });

    test('whole tokens stay exact above 2^53 planck', () => {
        // 2^53 planck is only ~9007 PDEX, so every realistic balance is past
        // the point where the integer itself stops being representable.
        assert.equal(formatPDEX('20000000000000000000'), '20,000,000');
        assert.equal(formatPDEX('9007199254740993000000'), '9,007,199,254.74');
    });

    test('ordinary values are unchanged', () => {
        assert.equal(formatPDEX('1000000000000'), '1');
        assert.equal(formatPDEX('1500000000000'), '1.5');
        assert.equal(formatPDEX(0), '0');
    });

    test('the source no longer divides a Number by 10 ** 12 here', () => {
        const i = src.indexOf('function formatPDEX(');
        const body = src.slice(i, src.indexOf('}', i));
        assert.ok(!/Number\(balance\)\s*\/\s*10 \*\* 12/.test(body),
            'formatPDEX is back to Number()/1e12 — that IS F-067');
        assert.match(body, /formatLivePDEX\(balance\)/);
    });

    test('the two cache writers use the BigInt path too', () => {
        // These feed the home-page cache, so a bad value would persist across
        // reloads rather than being corrected on the next fetch.
        assert.ok(!/Number\((totalIssuance|totalStake)\.toString\(\)\)\s*\/\s*1e12/.test(src),
            'a cache writer still parses planck with Number()');
        assert.match(src, /issuancePdex = formatLivePDEX\(totalIssuance\)/);
        assert.match(src, /stakePdex = formatLivePDEX\(totalStake\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-118 — a governance index reaches the chain only if it is digits
// ─────────────────────────────────────────────────────────────────────────────

describe('F-118 — councilMotionClose validates its index', () => {
    const fn = src.slice(src.indexOf('function councilMotionClose('),
                         src.indexOf('function councilMotionClose(') + 2200);

    test('the digit check is present', () => {
        assert.match(fn, /\/\^\\d\+\$\/\.test\(rawIndex\)/,
            'councilMotionClose takes Number(index) unchecked again — that IS F-118');
        assert.ok(!/^\s*const idx = Number\(index\);/m.test(fn),
            'the bare Number(index) is back');
    });

    test('it refuses before the confirm dialog, not after', () => {
        // Otherwise the user is asked to confirm "Close council motion #NaN"
        // and only then told it cannot be done.
        const guardAt = fn.indexOf('Number.isInteger(idx)');
        const confirmAt = fn.indexOf('if (!confirm(');
        assert.ok(guardAt !== -1 && confirmAt !== -1);
        assert.ok(guardAt < confirmAt, 'the index is validated after the confirm prompt');
    });

    test('the guard rejects exactly what a DOM attribute can carry', () => {
        // Reproduces the shipped expression against the values `index` really
        // takes: the attribute is the literal "null"/"undefined" when the
        // backend had no voting record, and Number(null) is 0 — a real index.
        const check = (index) => {
            const rawIndex = String(index == null ? '' : index).trim();
            const idx = /^\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;
            return Number.isInteger(idx) && idx >= 0;
        };
        for (const bad of [null, undefined, '', '   ', 'null', 'undefined', 'NaN', '-1', '1.5', '0x2', 'abc']) {
            assert.equal(check(bad), false, `accepted ${JSON.stringify(bad)}`);
        }
        for (const good of ['0', '7', '12345', 0, 7]) {
            assert.equal(check(good), true, `rejected ${JSON.stringify(good)}`);
        }
    });

    test('the sibling vote path still has its own guard', () => {
        // F-118's round-1 half. Losing it while adding the close guard would be
        // a straight trade, and the vote path is the dangerous one — a wrong
        // index there casts a real vote on motion #0.
        const vote = src.slice(src.indexOf('function councilMotionVote('),
                               src.indexOf('function councilMotionVote(') + 2000);
        assert.match(vote, /\/\^\\d\+\$\/\.test\(/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-120 — clearing local storage must also kill the server session
// ─────────────────────────────────────────────────────────────────────────────

describe('F-120 — the cookies Reset button revokes server-side', () => {
    const fn = src.slice(src.indexOf('function wireCookiesResetButton('),
                         src.indexOf('function wireCookiesResetButton(') + 1800);

    test('it calls revokeDiscussSession', () => {
        assert.match(fn, /revokeDiscussSession\(\)/,
            'the reset button wipes the token locally and leaves the server row alive for 7 days — that IS F-120');
    });

    test('it revokes BEFORE wiping storage', () => {
        // revokeDiscussSession reads the bearer token out of localStorage. Wipe
        // first and there is nothing left to authenticate the logout with, so
        // the call becomes a no-op that looks like a fix.
        const revokeAt = fn.indexOf('revokeDiscussSession()');
        const wipeAt = fn.indexOf('store.removeItem');
        assert.ok(revokeAt !== -1 && wipeAt !== -1);
        assert.ok(revokeAt < wipeAt, 'storage is cleared before the token is used to log out');
    });

    test('it revokes AFTER the confirm, so cancelling changes nothing', () => {
        const confirmAt = fn.indexOf('if (!confirm(');
        assert.ok(confirmAt !== -1 && confirmAt < fn.indexOf('revokeDiscussSession()'));
    });

    test('revokeDiscussSession cannot throw into the reset path', () => {
        // It is called outside the try/catch below it, so it has to be
        // self-guarding — and it is, but that is a property worth pinning
        // rather than re-deriving.
        const rv = src.slice(src.indexOf('function revokeDiscussSession('),
                             src.indexOf('function revokeDiscussSession(') + 1200);
        assert.match(rv, /catch \(e\)/);
        assert.match(rv, /if \(!token\) return;/);
        assert.match(rv, /keepalive: true/, 'the logout must survive the reload that follows it');
        assert.match(rv, /\.catch\(\(\) => \{\}\)/);
    });

    test('disconnectWallet still revokes too', () => {
        const dw = src.slice(src.indexOf('function disconnectWallet('),
                             src.indexOf('function disconnectWallet(') + 600);
        assert.match(dw, /revokeDiscussSession\(\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-044 / F-068 / F-117 / F-132 — the ones the audit noted had no safety net
// ─────────────────────────────────────────────────────────────────────────────

describe('F-044 — no column claims a measured 30-day APY', () => {
    test('the "Now vs Real" duplicate column is gone', () => {
        assert.ok(!/key: 'realApy', label: 'Now vs Real'/.test(src),
            'the duplicate column is back — it renders the same float twice with a slash between it');
    });

    test('nothing in the UI still says "Real APY"', () => {
        assert.ok(!/Real APY/.test(src),
            'a label still promises a realised yield the indexer does not compute');
    });

    test('the remaining column says what the number actually is', () => {
        assert.match(src, /label: 'Est\. APY \(current commission\)'/);
    });
});

describe('F-068 — cached and live home figures are labelled', () => {
    test('both cached cards carry a Cached badge', () => {
        const fn = src.slice(src.indexOf('function paintHomeFromCache('),
                             src.indexOf('function paintHomeFromCache(') + 2000);
        const badges = (fn.match(/badge small">Cached/g) || []).length;
        assert.equal(badges, 2,
            'issuance and in-stake must both be badged — one badged and one not is worse than neither, it implies the unbadged one is live');
    });

    test('both live cards carry a Live badge', () => {
        const fn = src.slice(src.indexOf('async function fetchNetworkStats('),
                             src.indexOf('async function fetchNetworkStats(') + 3000);
        assert.equal((fn.match(/badge small">Live/g) || []).length, 2);
    });
});

describe('F-117 — the address comment matches the code', () => {
    test('there is no dangling reference to a second address field', () => {
        assert.ok(!/Each account is returned with two address fields/.test(raw),
            'the comment still describes a rawAddress field that was removed');
    });

    test('rawAddress is gone from the code', () => {
        assert.ok(!/rawAddress/.test(src), 'the dead field is back');
    });

    test('README no longer documents the removed design', () => {
        // Blockquotes are dropped first. The README explains the correction by
        // QUOTING the old claim, and a naive grep matches that quotation — the
        // same self-match trap that produced test/helpers/source.js for JS
        // comments, in markdown. Asserting on prose means being specific about
        // whose voice the prose is in.
        const readme = readRepo('README.md', import.meta.url)
            .split('\n').filter(l => !l.trim().startsWith('>')).join('\n');
        assert.ok(!/native-prefixed.*kept in memory for `signAndSend`/s.test(readme),
            'README still asserts rawAddress behaviour the code does not have');
        assert.match(readme, /that same form is used for display, URL routing and `signAndSend` alike/);
    });
});

describe('F-132 — the Show More scaffolding is gone', () => {
    test('no display-limit variable survives', () => {
        for (const v of ['blockDisplayLimit', 'txDisplayLimit', 'eventDisplayLimit',
                         'validatorDisplayLimit', 'holderDisplayLimit']) {
            assert.ok(!new RegExp(`\\b${v}\\b`).test(src), `${v} is back`);
        }
    });

    test('no listener is wired to a button that is not in the DOM', () => {
        const html = readRepo('index.html', import.meta.url);
        assert.equal((html.match(/show-more/g) || []).length, 0,
            'a show-more button reappeared in the markup — then the JS should come back with it');
        assert.ok(!/getElementById\('show-more/.test(src),
            'script.js queries a show-more button again');
    });

    test('the dead .sortable listeners are gone but makeTable keeps its own', () => {
        // makeTable adds `sortable` to the headers it renders and binds them
        // via `.table-th.sortable` on its own container. The deleted handlers
        // were document-wide queries that ran once at module load, before any
        // table existed — dead, but they would have clobbered makeTable's sort
        // icons if they ever fired.
        assert.ok(!/document\.querySelectorAll\('\.sortable'\)/.test(src));
        assert.ok(!/document\.querySelectorAll\('\.sortable-(holder|tx)'\)/.test(src));
        assert.match(src, /container\.querySelectorAll\('\.table-th\.sortable'\)/,
            "makeTable's own sort binding was deleted with the dead ones");
    });

    test('the live load-older button is untouched', () => {
        assert.match(src, /getElementById\('load-older-financial-tx-btn'\)/);
        assert.match(src, /addEventListener\('click', loadOlderFinancialTransactions\)/);
    });

    test('sortTransactions survives — it has live callers', () => {
        // Its two siblings were deleted because the dead listeners were their
        // only callers. This one is called from three live paths.
        assert.match(src, /function sortTransactions\(\)/);
        assert.ok((src.match(/sortTransactions\(\)/g) || []).length >= 3);
    });
});
