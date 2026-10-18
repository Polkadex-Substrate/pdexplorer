// The /stake sidebar shortcut.
//
// Nothing here tests a new capability: staking has always been on the wallet
// dashboard (Stake & Nominate, Unstake, Pay out rewards). What was missing was
// a way in that says so — "My Account" does not read as "where I stake", and
// users who went looking found /staking-rewards, which is a read-only history
// page. The shortcut matters on a deadline: from 25 Oct 2026 Nova Wallet
// removes Polkadex from its Staking tab and tells users to manage their stake
// in "Polkadex Explorer", so this is the entry point that audience arrives
// looking for.
//
// script.js is a 15k-line browser bundle with no export surface, so the same
// split the rest of the suite uses applies: maybeRunWalletEntryIntent is small
// and self-contained, so it is lifted out and actually run, and the routing /
// nav wiring around it is asserted as source. Comments are stripped first —
// several of the strings below appear in the comments that explain them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments } from './helpers/source.js';

const html = readRepo('index.html', import.meta.url);
const src = stripComments(readRepo('script.js', import.meta.url));
const llms = readRepo('public/llms.txt', import.meta.url);

// Brace-match a function body out of the bundle, as in spa-partials.test.js.
function bodyOf(name) {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i !== -1, `${name} not found in script.js`);
    const open = src.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const sidebar = html.slice(html.indexOf('<nav class="sidebar-nav">'), html.indexOf('</nav>'));

describe('the sidebar entry', () => {
    test('exists and points at /stake', () => {
        assert.ok(sidebar.includes('href="/stake"'),
            'the shortcut is gone from the sidebar — which is the entire feature');
    });

    test('sits with My Account, not off in another section', () => {
        const account = sidebar.indexOf('id="nav-my-account"');
        const stake = sidebar.indexOf('id="nav-stake"');
        assert.ok(account !== -1 && stake !== -1);
        assert.ok(stake > account,
            'the shortcut moved above My Account — the My Wallet section should read account-first');
        // Nothing but the two anchors between them: a section title appearing
        // in the gap would mean the shortcut had drifted into Governance.
        assert.ok(!sidebar.slice(account, stake).includes('nav-section-title'),
            'a section boundary now separates My Account from the stake shortcut');
    });

    test('has a data-target of its own', () => {
        // Both entries render data-page="wallet". If the shortcut reused
        // data-target="wallet" the two rows would highlight together, which is
        // what the exact-match rule in routeTo exists to prevent.
        assert.match(sidebar, /id="nav-stake"[^>]*data-target="stake"|data-target="stake"[^>]*id="nav-stake"/,
            'the shortcut must carry data-target="stake"');
        const walletTargets = (sidebar.match(/data-target="wallet"/g) || []).length;
        assert.equal(walletTargets, 1,
            'more than one sidebar row claims data-target="wallet" — they will both light up');
    });
});

describe('routeTo resolves the shortcut to the wallet dashboard', () => {
    // From the top of routeTo down to the nav-highlight block: the resolution
    // ladder, without the dispatch that follows it.
    const ladder = src.slice(src.indexOf('function routeTo('), src.indexOf('const exactNav'));

    test('both /stake and /staking are recognised', () => {
        assert.match(ladder, /target === 'stake' \|\| target === 'staking'/,
            "/staking dropped as an alias — it is the word Nova's own announcement uses, " +
            'and without it the obvious guess lands on the 404 pane');
    });

    const branchStart = ladder.indexOf("target === 'stake'");
    const branch = ladder.slice(branchStart, ladder.indexOf('} else if', branchStart));

    test('it renders the wallet page', () => {
        assert.match(branch, /mainTarget = 'wallet'/,
            'the shortcut no longer resolves to a real data-page, so it falls through to not-found');
    });

    test('it arms the stake intent', () => {
        assert.match(branch, /walletEntryIntent = 'stake'/,
            'without the intent the shortcut is just a second link to My Account');
    });

    test('it canonicalizes to /wallet rather than becoming a second indexable URL', () => {
        assert.match(branch, /canonicalOverride = '\/wallet'/,
            'two URLs serving an identical page is the duplicate-content trap F-124 describes');
        assert.match(src, /updateSeoMeta\(mainTarget, \{ canonicalPath: canonicalOverride \|\|/,
            'the canonical override is set but never read, so it does nothing');
    });

    test('it is not in the sitemap, since it is not the canonical URL', () => {
        const server = stripComments(readRepo('server.js', import.meta.url));
        const sitemap = server.slice(server.indexOf('const SITEMAP_STATIC_ROUTES'));
        const routes = sitemap.slice(0, sitemap.indexOf('];'));
        assert.ok(!/'\/stake'/.test(routes),
            'listing a non-canonical alias in the sitemap asks crawlers to index a page that ' +
            'points away from itself');
    });
});

describe('only one sidebar row lights up', () => {
    const block = src.slice(src.indexOf('const exactNav'), src.indexOf('if (typeof sidebar'));

    test('an exact route match wins over the page the route resolves to', () => {
        assert.match(block, /exactNav\s*\?\s*navTarget === target/,
            'the exact-match rule is gone — /stake and /wallet will both show as active');
    });

    test('the mainTarget fallback survives for detail routes', () => {
        // block/123 resolves to block-details, which no sidebar row names, so
        // the fallback is what keeps Blocks highlighted while reading a block.
        assert.match(block, /navTarget === mainTarget \|\| navTarget === target/,
            'the fallback was dropped — detail pages will highlight nothing in the sidebar');
    });
});

describe('the shortcut does not dead-end on the connect panel', () => {
    test('the wallet auto-pick accepts the shortcut routes', () => {
        const body = bodyOf('tryAutoSelectFirstWallet');
        assert.match(body, /here !== 'wallet' && here !== 'stake' && here !== 'staking'/,
            'the auto-pick gate is back to accepting only /wallet. A user with an unlocked ' +
            'extension clicking the shortcut would be stopped on the connect panel, which ' +
            '/wallet itself walks straight past — the shortcut would look broken next to it');
    });
});

describe('the intent does not outlive the trip to the wallet page', () => {
    // The intent is consumed only on a successful live dashboard paint. So a
    // user who opened /stake with no wallet connected, wandered off, and
    // connected later from another page would get the stake modal over a
    // dashboard they never asked to stake from; a live fetch that failed on
    // the first try left it armed the same way. routeTo drops it for any
    // page that is not the wallet.
    const routeTo = bodyOf('routeTo');
    const clearAt = routeTo.indexOf("if (mainTarget !== 'wallet') walletEntryIntent = null;");

    test('routeTo clears the intent for any non-wallet page', () => {
        assert.ok(clearAt !== -1,
            'the clearing line is gone — an armed intent now survives into a later wallet visit');
    });

    test('it clears AFTER the route resolves, so the auto-pick hop keeps it', () => {
        // /stake resolves to the wallet page and then re-enters routeTo as
        // /wallet/<addr> once an account is picked. Clearing at the top of
        // routeTo would wipe the intent on that second entry and the
        // shortcut would silently become a plain link to My Account.
        const armAt = routeTo.indexOf("walletEntryIntent = 'stake'");
        assert.ok(armAt !== -1 && clearAt > armAt,
            'the clear runs before the stake branch arms the intent — the shortcut is dead');
        const walletHop = routeTo.indexOf("target.startsWith('wallet/')");
        assert.ok(walletHop !== -1 && clearAt > walletHop,
            'the clear runs before the wallet/<addr> branch resolves mainTarget');
    });

    test('the resolution ladder itself never clears it', () => {
        // Guards against someone "simplifying" by clearing inside a branch of
        // the ladder, which would reintroduce the bug for whichever branches
        // were missed.
        const ladder = routeTo.slice(0, clearAt);
        assert.equal((ladder.match(/walletEntryIntent = null/g) || []).length, 0,
            'the intent is cleared inside the resolution ladder instead of after it');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// maybeRunWalletEntryIntent — lifted out and run
// ─────────────────────────────────────────────────────────────────────────────

function runIntent(initialIntent, button) {
    const opened = [];
    const doc = { getElementById: id => (id === 'wallet-act-stake' ? button : null) };
    // eslint-disable-next-line no-new-func
    const factory = new Function('document', 'openStakeModal', 'initialIntent', `
        let walletEntryIntent = initialIntent;
        ${bodyOf('maybeRunWalletEntryIntent')}
        return { run: maybeRunWalletEntryIntent, armed: () => walletEntryIntent };
    `);
    const api = factory(doc, () => opened.push('stake'), initialIntent);
    return { ...api, opened };
}

describe('maybeRunWalletEntryIntent', () => {
    test('opens the stake modal when the button is live', () => {
        const h = runIntent('stake', { disabled: false });
        h.run();
        assert.deepEqual(h.opened, ['stake']);
    });

    test('is one-shot — a later repaint does not reopen the modal', () => {
        // The dashboard repaints on its own (price and rewards payloads land
        // separately, and the signing recheck swaps the action bar). An intent
        // that stayed armed would pop the modal over whatever the user had
        // started doing.
        const h = runIntent('stake', { disabled: false });
        h.run();
        h.run();
        h.run();
        assert.deepEqual(h.opened, ['stake'], 'the intent re-fired on a repaint');
        assert.equal(h.armed(), null);
    });

    test('a view-only session gets the dashboard, not a modal', () => {
        // No action bar is rendered when the page has no signing capability
        // (read-only visit, or a mobile WebView that has not injected yet), so
        // the button does not exist.
        const h = runIntent('stake', null);
        h.run();
        assert.deepEqual(h.opened, []);
        assert.equal(h.armed(), null, 'the intent stayed armed and will fire on a later visit');
    });

    test('a disabled button is respected', () => {
        // applyWalletActionBlock() disables the action bar when balances could
        // not be refreshed. Opening a stake modal over numbers we have just
        // told the user not to trust is the one outcome worth avoiding here.
        const h = runIntent('stake', { disabled: true });
        h.run();
        assert.deepEqual(h.opened, []);
        assert.equal(h.armed(), null);
    });

    test('an unrecognised intent is cleared, not left armed', () => {
        const h = runIntent('send', { disabled: false });
        h.run();
        assert.deepEqual(h.opened, []);
        assert.equal(h.armed(), null);
    });

    test('no intent is a no-op', () => {
        const h = runIntent(null, { disabled: false });
        h.run();
        assert.deepEqual(h.opened, []);
    });
});

describe('the intent fires on live data only', () => {
    test('its one call site is after the live payload renders', () => {
        const calls = src.match(/maybeRunWalletEntryIntent\(\);/g) || [];
        assert.equal(calls.length, 1, `expected exactly one call site, found ${calls.length}`);

        const body = bodyOf('fetchWalletDashboard');
        const cachePaint = body.indexOf('renderWalletDashboard(cached.wallet');
        const livePayload = body.indexOf('latestWallet = result.data');
        const call = body.indexOf('maybeRunWalletEntryIntent();');
        assert.ok(cachePaint !== -1 && livePayload !== -1,
            'fetchWalletDashboard no longer has the two paints this ordering depends on');
        assert.ok(call !== -1, 'the call moved out of fetchWalletDashboard');
        assert.ok(call > livePayload,
            'the intent now runs on the cache-first paint. The stake modal reads the ' +
            'available balance and the minimum bond at open time, so it would show the ' +
            'user numbers that are minutes stale and let them bond against them');
    });
});

describe('the route list stays truthful', () => {
    test('llms.txt lists /stake', () => {
        assert.ok(/\/stake(?![a-z-])/.test(llms),
            'the shortcut is undocumented for the AI assistants this file exists for');
    });

    test('it no longer claims /staking does not exist', () => {
        // F-157 was the opposite mistake: the file documented /staking when no
        // such route existed. The alias makes it real, so the correction has to
        // be corrected or the file is wrong in the other direction.
        const f157 = llms.slice(llms.indexOf('Audit F-157'));
        const note = f157.slice(0, f157.indexOf('\n\n'));
        assert.ok(!/Neither route exists/.test(note),
            '/staking resolves now, so "neither route exists" is false');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The welcome tour stays out of the way on /stake
// ─────────────────────────────────────────────────────────────────────────────
//
// A first-time visitor from Nova lands on /stake to do one thing. The tour used
// to open ~800ms after load and sit on top of the Stake & Nominate window,
// which opens a few seconds later underneath it. Found in a simulated Nova
// session on a phone-sized screen.

// Like bodyOf, but starts brace-matching after the parameter list, because
// shouldAutoShowTour takes a destructured object and bodyOf would stop at the
// closing brace of its parameters.
function fnSource(name) {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i !== -1, `${name} not found in script.js`);
    const open = src.indexOf(") {", i) + 2;
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

function liftTourDecision() {
    const decl = src.match(/const TOUR_SKIP_ROUTES = \[[^\]]*\];/);
    assert.ok(decl, 'TOUR_SKIP_ROUTES not found in script.js');
    // eslint-disable-next-line no-new-func
    return new Function(`${decl[0]}\n${fnSource('shouldAutoShowTour')}\nreturn shouldAutoShowTour;`)();
}

describe('shouldAutoShowTour', () => {
    const show = liftTourDecision();

    test('a first visit to an ordinary page still gets the tour', () => {
        assert.equal(show({ forceShow: false, seen: false, landingRoute: 'home' }), true);
        assert.equal(show({ forceShow: false, seen: false, landingRoute: 'wallet' }), true);
    });

    test('a first visit landing on /stake or /staking does not', () => {
        assert.equal(show({ forceShow: false, seen: false, landingRoute: 'stake' }), false);
        assert.equal(show({ forceShow: false, seen: false, landingRoute: 'staking' }), false);
    });

    test('?tour=1 still forces it, even on /stake', () => {
        assert.equal(show({ forceShow: true, seen: false, landingRoute: 'stake' }), true);
        assert.equal(show({ forceShow: true, seen: true, landingRoute: 'home' }), true);
    });

    test('a visitor who has seen it is not shown it again', () => {
        assert.equal(show({ forceShow: false, seen: true, landingRoute: 'home' }), false);
    });
});

describe('the tour reads where the visitor landed, not where they are now', () => {
    const body = bodyOf('wireOnboardingTour');

    test('the landing route is captured before the timer, at load', () => {
        const read = body.indexOf('const landingRoute = readRouteFromLocation()');
        const timer = body.indexOf('setTimeout(');
        assert.ok(read !== -1, 'landingRoute is no longer read from the location');
        assert.ok(timer !== -1);
        assert.ok(read < timer,
            'the landing route is read inside the timer. By then the wallet page may have rewritten ' +
            '/stake to /wallet/<addr>, so the skip would silently stop working');
    });

    test('the auto-show goes through shouldAutoShowTour', () => {
        assert.match(body, /if \(shouldAutoShowTour\(\{ forceShow, seen, landingRoute \}\)\) openOnboardingTour\(\);/,
            'the auto-show condition bypasses shouldAutoShowTour');
    });

    test('skipping does not mark the tour as seen', () => {
        // The skip only defers the tour. Writing the seen flag here would mean a
        // Nova visitor never gets it, even when they later land on the home page.
        const timerBody = body.slice(body.indexOf('setTimeout('));
        const timerEnd = timerBody.indexOf('}, 800)');
        assert.ok(timerEnd !== -1);
        assert.ok(!/setItem\(TOUR_STORAGE_KEY/.test(timerBody.slice(0, timerEnd)),
            'the auto-show timer now writes the seen flag');
    });
});
