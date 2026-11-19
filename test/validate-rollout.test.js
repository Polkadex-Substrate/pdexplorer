// Validator onboarding, Sprint 5 rollout items (design 5.1, 5.4 and the
// Sprint 5 plan): the help article for managing a validator through a proxy or
// a multisig, the nav entry and inbound links still behind the flag, the
// sitemap that lists the Validate pages only when the flag is on for
// everyone, the wallet dashboard "Validator" card, the "Add a staking proxy"
// prefill of the existing proxy form, the corrected /api/proxy-types, the
// multisig review's final-approval guard wired in script.js, and the flag
// default still off (the flip is a CEO action).
//
// Synthetic accounts only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import { FEATURE_FLAGS } from '../lib/wallet-links.js';
import { HELP_TOPICS, visibleHelpTopics } from '../lib/help-topics.js';
import { validateSitemapRoutes } from '../lib/validate-gate.js';
import { walletValidatorCard, proxyPrefill, STAKING_PROXY_LIMITS } from '../lib/validator-delegate.js';
import { readWalletValidator } from '../lib/validator-delegate-chain.js';
import { escapeHtml } from '../lib/html-escape.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(151);
const src = (p) => stripComments(readRepo(p, import.meta.url));

describe('the flag', () => {
    test('FEATURE_FLAGS.validate stays false: turning it on for everyone is a CEO action', () => {
        assert.equal(FEATURE_FLAGS.validate, false);
    });
    test('the nav entry and the validators page links are hidden in the shell until the flag shows them', () => {
        const html = readRepo('index.html', import.meta.url);
        assert.match(html, /<a href="\/validate" class="nav-item" data-target="validate" id="nav-validate" hidden>/);
        const links = [...html.matchAll(/<a [^>]*class="item-link validate-flag-link"[^>]*>/g)].map(m => m[0]);
        assert.ok(links.length >= 2);
        for (const l of links) assert.match(l, /\shidden>/, l);
    });
});

describe('help: managing a validator, through a proxy or a multisig', () => {
    const topic = () => HELP_TOPICS.find(t => t.slug === 'validator-manage');
    test('the article exists behind the flag and says what a Staking proxy can and cannot do', () => {
        const t = topic();
        assert.ok(t, 'help topic validator-manage');
        assert.equal(t.flag, 'validate');
        assert.ok(t.body.includes(STAKING_PROXY_LIMITS));
        assert.match(t.body, /proxy\.proxy/);
        assert.match(t.body, /announcement delay/);
        assert.match(t.body, /multisig/i);
        assert.match(t.body, /approv/);
        assert.match(t.body, /checks the validator rules again/);
        assert.doesNotMatch(t.body + t.title, /[\u2013\u2014]/, 'no em or en dashes');
    });
    test('hidden from the help centre while the flag is off, shown when on', () => {
        assert.equal(visibleHelpTopics(HELP_TOPICS, {}).some(t => t.slug === 'validator-manage'), false);
        assert.equal(visibleHelpTopics(HELP_TOPICS, { validate: true }).some(t => t.slug === 'validator-manage'), true);
    });
    test('the setup article no longer says multisig setup is unavailable', () => {
        const t = HELP_TOPICS.find(x => x.slug === 'validator-setup');
        assert.doesNotMatch(t.body, /multisig or through a proxy is not available yet/);
        assert.match(t.body, /multisig/);
    });
});

describe('the sitemap lists the Validate pages only when the flag is on for everyone', () => {
    test('off: nothing; on: the public node guide and every flagged help article', () => {
        assert.deepEqual(validateSitemapRoutes(false, HELP_TOPICS), []);
        const on = validateSitemapRoutes(true, HELP_TOPICS).map(r => r.path);
        assert.ok(on.includes('/validate/node'));
        for (const t of HELP_TOPICS.filter(x => x.flag === 'validate')) assert.ok(on.includes('/help/' + t.slug), t.slug);
        assert.equal(on.includes('/validate'), false, 'the wallet-specific dashboard is not indexed');
        assert.equal(on.includes('/validate/setup'), false, 'the wizard is not indexed');
        for (const r of validateSitemapRoutes(true, HELP_TOPICS)) { assert.ok(r.changefreq); assert.ok(r.priority); }
    });
    test('server.js adds them from FEATURE_FLAGS.validate (the server-side flag, not a browser opt-in)', () => {
        const s = src('server.js');
        assert.match(s, /validateSitemapRoutes\(FEATURE_FLAGS\.validate, HELP_TOPICS\)/);
    });
});

describe('/api/proxy-types reads the runtime enum (it fell back to a list with types this chain does not have)', () => {
    test('server.js uses proxyTypesOf and no longer offers IdentityJudgement or CancelProxy', () => {
        const s = src('server.js');
        const body = s.slice(s.indexOf("app.get('/api/proxy-types'"), s.indexOf("app.get('/api/proxy-types'") + 1200);
        assert.match(body, /proxyTypesOf\(globalApi\)/);
        assert.doesNotMatch(body, /IdentityJudgement|CancelProxy/);
        const sc = src('script.js');
        assert.doesNotMatch(sc, /'IdentityJudgement', 'CancelProxy'/, 'the proxy form no longer falls back to types this chain does not have');
    });
});

describe('the wallet dashboard card (design 5.1): only for an account that validates or has session keys', () => {
    test('nothing for most users; a link to validator status otherwise', () => {
        assert.equal(walletValidatorCard({ validating: false, hasKeys: false, address: STASH }, escapeHtml), '');
        assert.equal(walletValidatorCard(null, escapeHtml), '');
        const v = walletValidatorCard({ validating: true, hasKeys: true, address: STASH }, escapeHtml);
        assert.match(v, /This account validates\./);
        assert.match(v, /href="\/validate"/);
        const k = walletValidatorCard({ validating: false, hasKeys: true, address: STASH }, escapeHtml);
        assert.match(k, /session keys registered/);
        assert.match(k, /href="\/validate"/);
        assert.doesNotMatch(v + k, /validate-primary/, 'a card on the wallet page, not a primary action');
    });
    test('readWalletValidator reads Staking.Validators and Session.NextKeys; a failed read shows nothing', async () => {
        const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
        const api = (validating, keys) => ({ query: { staking: { validators: Object.assign(async () => ({}), { size: async () => ({ toNumber: () => (validating ? 5 : 0) }) }) }, session: { nextKeys: async () => opt(keys ? { toJSON: () => ({}) } : null) } } });
        assert.deepEqual(await readWalletValidator(api(true, true), STASH), { validating: true, hasKeys: true, address: STASH });
        assert.deepEqual(await readWalletValidator(api(false, false), STASH), { validating: false, hasKeys: false, address: STASH });
        assert.equal(await readWalletValidator({ query: {} }, STASH), null);
    });
    test('script.js mounts it on the wallet page only while the flag is on', () => {
        const s = src('script.js');
        assert.match(s, /if \(VALIDATE_ON[^)]*\)[^\n]*readWalletValidator\(/);
        assert.match(s, /walletValidatorCard\(/);
    });
});

describe('"Add a staking proxy" opens the existing proxy form prefilled (design 5.4)', () => {
    test('?proxy=Staking: type Staking, delay 0, the 4.1 limits copy; never NonTransfer or Any', () => {
        assert.deepEqual(proxyPrefill('?proxy=Staking'), { type: 'Staking', delay: 0, note: STAKING_PROXY_LIMITS });
        assert.deepEqual(proxyPrefill('?proxy=staking'), { type: 'Staking', delay: 0, note: STAKING_PROXY_LIMITS });
        for (const q of ['?proxy=Any', '?proxy=NonTransfer', '', '?x=1', null]) assert.equal(proxyPrefill(q), null, String(q));
    });
    test('script.js applies it in renderAddProxyForm', () => {
        const s = src('script.js');
        const body = s.slice(s.indexOf('async function renderAddProxyForm'), s.indexOf('async function renderAddProxyForm') + 4000);
        assert.match(body, /proxyPrefill\(window\.location\.search\)/);
    });
    test('the prefill follows the validate flag (Fable round 1): off, ?proxy=Staking changes nothing', () => {
        const s = src('script.js');
        const body = s.slice(s.indexOf('async function renderAddProxyForm'), s.indexOf('async function renderAddProxyForm') + 4000);
        assert.match(body, /const pre = VALIDATE_ON && proxyPrefill\(window\.location\.search\)/);
    });
});

describe('the wallet Validator card: checked on resolve, styled with brand tokens (Fable round 1)', () => {
    test('a late read for another wallet is dropped: the card is written only when its address is still the wallet shown', () => {
        const s = src('script.js');
        const line = s.split('\n').find(l => l.includes('readWalletValidator(globalApi'));
        assert.ok(line, 'the mount line');
        assert.match(line, /v && isSameAddress\(v\.address, currentWalletData\?\.address\)/);
    });
    test('styles.css styles .wallet-validator-card with brand tokens only', () => {
        const css = readRepo('styles.css', import.meta.url);
        const rules = [...css.matchAll(/\.wallet-validator-card[^{]*\{([^}]*)\}/g)].map(m => m[1]);
        assert.ok(rules.length, 'a rule for the card');
        const all = rules.join(';');
        assert.match(all, /var\(--/);
        assert.doesNotMatch(all, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no literal colours');
    });
});

describe('script.js wiring of the delegated signing', () => {
    test('the multisig review gets the validator guard; the manage and setup deps get the multisig lookups', () => {
        const s = src('script.js');
        assert.match(s, /callGuard: \(api, call, m\) => validatorCallGuard\(api, call, m\.address\)/);
        assert.match(s, /findMultisig: \(a\) => multisigStore\.find\(a\)/);
        assert.match(s, /multisigReview: \(o\) => multisigUI\.review\(o\)/);
    });
});
