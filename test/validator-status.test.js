// Validator onboarding, Sprint 1: the read-only validator status dashboard
// (Fable design, cto-team/plans/2026-11-17-validator-onboarding-design.md,
// sections 2.4, 5.1, 5.2, 5.5, 5.7, 6 and 7, Sprint 1).
//
//   lib/validator-status.js        pure: headline state, rows, words, CTA
//   lib/validator-status-chain.js  the chain reads (status, params, key owners)
//   lib/validator-status-api.js    GET /api/validator/params,
//                                  GET /api/validator/:address/status,
//                                  GET /api/session-keys/check
//   lib/validator-status-view.js   the /validate page
//   lib/validate-gate.js           FEATURE_FLAGS.validate and ?validate=1
//
// Runtime facts used (spec 393, polkadot-sdk polkadot-stable2512-3):
// MinValidatorBond, MinCommission and MaxValidatorsCount are storage values set
// by governance, so they are read live; a session is one BABE epoch (1,200
// blocks of 12 s), six sessions make an era; keys set now are used from the
// session after next; exposure is paged at 256 nominators.
//
// Every account is 32 bytes of one repeated value at prefix 88 and belongs to
// no one; every key is synthetic.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Window } from 'happy-dom';
import { encodeAddress } from '@polkadot/util-crypto';
import { deriveHeadline, validatorStatusModel, formatPdex, perbillToPercent, aboutDuration, ctaFor } from '../lib/validator-status.js';
import { readValidatorStatus, readValidatorParams, readKeyOwners, keysToMap } from '../lib/validator-status-chain.js';
import { registerValidatorRoutes, VALIDATOR_PARAMS_ROUTE, VALIDATOR_STATUS_ROUTE, SESSION_KEYS_CHECK_ROUTE, createKeyCheckLimiter } from '../lib/validator-status-api.js';
import { renderValidatorStatus, renderKeysPage, mountValidatePage, mountKeysPage, VALIDATE_STATEMENT } from '../lib/validator-status-view.js';
import { validateEnabled, VALIDATE_FLAG_KEY } from '../lib/validate-gate.js';
import { FEATURE_FLAGS } from '../lib/wallet-links.js';
import { selfManagedRoute } from '../lib/wallet-aware.js';
import { HELP_TOPICS, visibleHelpTopics } from '../lib/help-topics.js';
import { allRoutes, CACHE_TIERS } from '../lib/api-reference.js';
import { EXPECTED_LAYOUT } from '../lib/session-keys.js';
import { escapeHtml } from '../lib/html-escape.js';
import { registryFromMetadata, loadFixture } from './helpers/extrinsic-builders.js';
import { readRepo, stripComments } from './helpers/source.js';

const addr = (n) => encodeAddress(new Uint8Array(32).fill(n), 88);
const STASH = addr(71), CTRL = addr(72), NOM = addr(73), OTHER = addr(74), PROXY = addr(75), V2 = addr(76);
const PDEX = 10n ** 12n;
const rep = (b, n) => b.repeat(n);
const KEYS = { grandpa: '0x' + rep('11', 32), babe: '0x' + rep('22', 32), im_online: '0x' + rep('33', 32), authority_discovery: '0x' + rep('44', 32), mixnet: '0x' + rep('55', 32), beefy: '0x02' + rep('66', 32) };
const NEWKEYS = { grandpa: '0x' + rep('a1', 32), babe: '0x' + rep('b2', 32), im_online: '0x' + rep('77', 32), authority_discovery: '0x' + rep('c3', 32), mixnet: '0x' + rep('d4', 32), beefy: '0x03' + rep('e5', 32) };
const BLOB = '0x' + Object.values(KEYS).map(h => h.slice(2)).join('');
const short = (a) => a.slice(0, 8) + '...' + a.slice(-6);

// ── synthetic snapshots (what readValidatorStatus returns) ──
const snap = (over = {}) => ({
    address: STASH, bonded: true, controller: STASH, ledger: { total: String(500n * PDEX), active: String(500n * PDEX) },
    intent: true, prefs: { commission: 50_000_000, blocked: false },
    nextKeys: KEYS, queuedKeys: KEYS, inQueued: true, inSession: true, sessionValidatorIndex: 3, sessionValidatorCount: 200,
    activeImOnlineKey: KEYS.im_online, disabled: false, imOnline: true, heartbeat: true, blocks: 2,
    activeEra: 500, currentEra: 500, sessionIndex: 3000, sessionProgress: 0.5, epochDuration: 1200, blockTimeMs: 12000, sessionsPerEra: 6, eraStartSession: 2998,
    exposure: { total: String(90_000n * PDEX), own: String(500n * PDEX), nominatorCount: 300, pageCount: 2 }, nextExposure: null,
    points: { points: 1200, rank: 10, of: 200 }, lastEra: { points: 7000, reward: String(37n * PDEX) },
    lastSlashEra: null, incidents: [], identity: { name: 'Alpha', judgements: [] }, proxies: [], bondingDuration: 28,
    ...over
});
const params = (over = {}) => ({
    specVersion: 393, layout: { ok: true, bytes: 193, hexLength: 388 },
    minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, maxValidatorsCount: 250, counterForValidators: 217, validatorCount: 200,
    lowestElectedTotal: String(40_000n * PDEX), medianCommission: 100_000_000, electionPhase: 'Off', ...over
});
const model = (s = {}, p = {}) => validatorStatusModel(snap(s), params(p));
const row = (m, id) => m.rows.find(r => r.id === id);

// ── the headline state, in the design's order (section 2.4) ──
describe('deriveHeadline: one headline state per validator', () => {
    const base = { bonded: true, hasKeys: true, intent: true, inSession: false, inQueued: false, electedNext: false, disabled: false, activeEra: 500, nextSessionIn: 3 * 3600 + 20 * 60 };
    const h = (o) => deriveHeadline({ ...base, ...o });
    const cases = [
        ['not-bonded', { bonded: false, hasKeys: false, intent: false }, 'This account is not a validator stash.', 'Not a validator', 'neutral'],
        ['bonded-no-keys', { hasKeys: false }, 'Bonded. No session keys registered.', 'No keys', 'neutral'],
        ['keys-not-validating', { intent: false }, 'Keys registered. Not asking to validate.', 'Not validating', 'neutral'],
        ['waiting', {}, 'Waiting. Not elected for era 500.', 'Waiting', 'wait'],
        ['elected-next', { inQueued: true }, 'Elected. Starts validating next session, in about 3 h 20 min.', 'Elected', 'positive'],
        ['active', { inSession: true, inQueued: true }, 'Active in era 500.', 'Active', 'positive'],
        ['active-leaving', { inSession: true, intent: false }, 'Active until era 500 ends. Not standing for the next era.', 'Leaving', 'wait'],
        ['disabled', { inSession: true, disabled: true }, 'Disabled for the rest of this era after an offence.', 'Disabled', 'error']
    ];
    for (const [state, o, text, word, tone] of cases) {
        test(`${state}: "${text}"`, () => {
            const r = h(o);
            assert.equal(r.state, state);
            assert.equal(r.text, text);
            assert.deepEqual(r.pill, { word, tone });
        });
    }
    test('elected for the next era (Staking exposure for the current era) without QueuedKeys yet is elected-next', () => {
        assert.equal(h({ electedNext: true }).state, 'elected-next');
    });
    test('a chilled validator still queued for the next session is elected-next, not keys-not-validating', () => {
        assert.equal(h({ inQueued: true, intent: false }).state, 'elected-next');
    });
    // Rewritten for the colour roles (spec 2026-11-21 section 4, replacing "green only for Active"):
    // green for Active and Elected, amber for Waiting and Leaving, red for Disabled, the rest neutral.
    test('pill tones follow the roles: Active and Elected positive, Waiting and Leaving wait, Disabled error, the rest neutral', () => {
        const want = { Active: 'positive', Elected: 'positive', Waiting: 'wait', Leaving: 'wait', Disabled: 'error', 'Not a validator': 'neutral', 'No keys': 'neutral', 'Not validating': 'neutral' };
        for (const [, o] of cases) { const r = h(o); assert.equal(r.pill.tone, want[r.pill.word], r.pill.word); }
    });
});

describe('validatorStatusModel: the rows under the headline', () => {
    test('the model carries the address, state, headline, pill and the live limits', () => {
        const m = model();
        assert.equal(m.address, STASH);
        assert.equal(m.state, 'active');
        assert.equal(m.headline, 'Active in era 500.');
        assert.deepEqual(m.limits, { minValidatorBond: String(123n * PDEX), minCommission: 30_000_000, maxValidatorsCount: 250 });
    });
    test('keys: match, new keys pending (next session or the one after), queued, none', () => {
        assert.equal(row(model(), 'keys').text, 'Registered keys match the keys in use.');
        assert.equal(row(model({ nextKeys: NEWKEYS, queuedKeys: NEWKEYS }), 'keys').text, 'New keys registered. In use from session 3001 (about 2 h).');
        assert.equal(row(model({ nextKeys: NEWKEYS, queuedKeys: KEYS }), 'keys').text, 'New keys registered. In use from session 3002 (about 6 h).');
        assert.equal(row(model({ inSession: false, activeImOnlineKey: null }), 'keys').text, 'Registered keys are queued for session 3001.');
        assert.equal(row(model({ inSession: false, inQueued: false, queuedKeys: null, activeImOnlineKey: null }), 'keys').text, 'Registered. Used once this stash is elected.');
        assert.equal(row(model({ nextKeys: null, queuedKeys: null, inQueued: false, inSession: false }), 'keys').text, 'No session keys registered.');
    });
    test('online this session: heartbeat and blocks (green), nothing seen yet (amber), offline (red), nothing at all', () => {
        assert.deepEqual([row(model(), 'online').text, row(model(), 'online').tone], ['Heartbeat received.', 'positive']);
        assert.deepEqual([row(model({ heartbeat: false, blocks: 4 }), 'online').text, row(model({ heartbeat: false, blocks: 4 }), 'online').tone], ['Authored 4 blocks this session.', 'positive']);
        assert.equal(row(model({ heartbeat: false, blocks: 0, sessionProgress: 0.5 }), 'online').text, 'Nothing seen yet (normal before 85% of the session).');
        const off = row(model({ heartbeat: false, blocks: 0, sessionProgress: 0.9 }), 'online');
        assert.deepEqual([off.text, off.word, off.tone], ['No heartbeat and no block this session.', 'Offline', 'error']);
        assert.equal(row(model({ inSession: false }), 'online').text, 'Not in the active set this session.');
        assert.equal(row(model({ imOnline: false }), 'online').text, 'The explorer cannot tell: this runtime has no imOnline module.');
        assert.equal(row(model({ heartbeat: null, blocks: null }), 'online').text, 'Could not be read.');
        // review finding 3: the heartbeat read failed and no block was seen: unknown, never Offline
        for (const sessionProgress of [0.5, 0.9, 0.99]) {
            const u = row(model({ heartbeat: null, blocks: 0, sessionProgress }), 'online');
            assert.deepEqual([u.word, u.text, u.tone], ['Unknown', 'Could not be read.', 'neutral'], String(sessionProgress));
        }
        assert.equal(row(model({ heartbeat: null, blocks: 3 }), 'online').word, 'Online');
    });
    test('era points and rewards', () => {
        assert.equal(row(model(), 'points').text, 'Era points this era: 1,200 (rank 10 of 200). Last era: 7,000 points, about 37 PDEX in rewards.');
        assert.equal(row(model({ points: null, lastEra: null }), 'points').text, 'No era points this era.');
    });
    test('offences: none, offline reports in the last 7 days, a recent slash (error)', () => {
        assert.equal(row(model(), 'offences').text, 'No offline reports in the last 7 days. No slash.');
        const r = row(model({ incidents: [{ block: 1, kind: 'imOnline.SomeOffline' }, { block: 2, kind: 'imOnline.SomeOffline' }] }), 'offences');
        assert.equal(r.text, '2 offline reports in the last 7 days. No slash.');
        const s = row(model({ lastSlashEra: 490 }), 'offences');
        assert.deepEqual([s.text, s.word, s.tone], ['No offline reports in the last 7 days. Slashed in era 490.', 'Slashed', 'error']);
    });
    test('stake: self, nominators, total, against the lowest elected backing and the live MinValidatorBond', () => {
        assert.equal(row(model(), 'stake').text, 'Self stake: 500 PDEX. Nominator stake: 89,500 PDEX. Total: 90,000 PDEX. Lowest elected backing this era: 40,000 PDEX. Minimum to validate: 123 PDEX.');
        const low = row(model({ ledger: { total: String(100n * PDEX), active: String(100n * PDEX) } }), 'stake');
        assert.match(low.text, /Self stake: 100 PDEX\. Below the minimum to validate \(123 PDEX\)\./);
        assert.equal(low.word, 'Below minimum');
        const wait = row(model({ inSession: false, exposure: null }), 'stake');
        assert.equal(wait.text, 'Self stake: 500 PDEX. Not elected this era, so no exposure. Lowest elected backing this era: 40,000 PDEX. Minimum to validate: 123 PDEX.');
    });
    test('nominators: count and payout pages (256 per page)', () => {
        assert.equal(row(model(), 'nominators').text, '300 nominators, 2 payout pages.');
        assert.equal(row(model({ exposure: { ...snap().exposure, nominatorCount: 1, pageCount: 1 } }), 'nominators').text, '1 nominator, 1 payout page.');
        assert.equal(row(model({ inSession: false, exposure: null }), 'nominators').text, 'Nominations for a waiting validator are not counted here yet.');
    });
    test('a validator in the active set whose exposure could not be read is never "not elected" (review finding 1)', () => {
        const m = model({ exposure: null });
        assert.equal(m.state, 'active');
        const stake = row(m, 'stake'), nom = row(m, 'nominators');
        assert.match(stake.text, /could not be read/);
        assert.match(nom.text, /could not be read/);
        for (const r of [stake, nom]) assert.doesNotMatch(r.text, /Not elected|known once elected|waiting validator/);
        assert.equal(nom.retry, true);
        assert.ok(!row(model(), 'nominators').retry);
        assert.ok(!row(model({ inSession: false, exposure: null }), 'nominators').retry);
    });
    test('commission: value, the live minimum, the median, and the blocked flag', () => {
        assert.equal(row(model(), 'commission').text, '5%. Minimum on Polkadex: 3%. Median of active validators: 10%.');
        assert.match(row(model({ prefs: { commission: 1_000_000_000, blocked: true } }), 'commission').text, /^100%\..*Blocked: accepts no new nominations\.$/);
        assert.equal(row(model({ prefs: null, intent: false }), 'commission').text, 'Not set: this stash is not asking to validate.');
    });
    test('identity: name and judgement, or none', () => {
        assert.equal(row(model(), 'identity').text, 'Alpha. No registrar judgement.');
        assert.equal(row(model({ identity: { name: 'Alpha', judgements: ['Reasonable'] } }), 'identity').text, 'Alpha. Judgement: Reasonable.');
        assert.equal(row(model({ identity: null }), 'identity').text, 'No on-chain identity.');
    });
    test('access: own controller or a legacy controller, and proxies with their type', () => {
        assert.equal(row(model(), 'access').text, 'The stash is its own controller. No proxies.');
        const legacy = row(model({ controller: CTRL, proxies: [{ delegate: PROXY, type: 'Staking' }] }), 'access');
        assert.equal(legacy.text, `Controlled by ${CTRL} (an older setup). Staking proxy: ${PROXY}.`);
    });
    test('not bonded: only the headline and identity, no rows that would be empty', () => {
        const m = model({ bonded: false, controller: null, ledger: null, intent: false, prefs: null, nextKeys: null, queuedKeys: null, inQueued: false, inSession: false, exposure: null, points: null, lastEra: null });
        assert.equal(m.state, 'not-bonded');
        assert.deepEqual(m.rows.map(r => r.id), ['identity']);
    });
    // Rewritten for the colour roles (spec 2026-11-21 section 4): green is live health only (Active, Elected,
    // keys Match, Heartbeat received, Online); "Offences: None" and identity never turn green.
    test('green appears only on live health, whatever the state', () => {
        const variants = [{}, { disabled: true }, { lastSlashEra: 490 }, { heartbeat: false, blocks: 3 }, { inSession: false }, { intent: false }, { bonded: false }];
        for (const v of variants) {
            const m = model(v);
            for (const r of m.rows) if (r.tone === 'positive') assert.ok((r.id === 'online' && ['Heartbeat received', 'Online'].includes(r.word)) || (r.id === 'keys' && r.word === 'Match'), JSON.stringify(v) + ' ' + r.id);
            if (m.pill.tone === 'positive') assert.ok(['Active', 'Elected'].includes(m.pill.word));
        }
    });
    test('era and session countdown', () => {
        const m = model();
        assert.equal(m.session.index, 3000);
        assert.equal(m.session.nextIn, 7200);
        assert.equal(m.era.active, 500);
        assert.equal(m.era.endsIn, (6 - 2 - 0.5) * 14400);
    });
});

describe('formatting helpers', () => {
    test('formatPdex: planck strings, BigInt exact, up to 4 decimals', () => {
        assert.equal(formatPdex(String(100n * PDEX)), '100 PDEX');
        assert.equal(formatPdex('1234567800000000'), '1,234.5678 PDEX');
        assert.equal(formatPdex('1500000000000'), '1.5 PDEX');
        assert.equal(formatPdex(null), 'unknown');
    });
    test('perbillToPercent: integer math', () => {
        assert.deepEqual([perbillToPercent(50_000_000), perbillToPercent(25_000_000), perbillToPercent(1_000_000_000), perbillToPercent(0), perbillToPercent(1_234_567)], ['5%', '2.5%', '100%', '0%', '0.12%']);
    });
    test('aboutDuration', () => {
        assert.deepEqual([aboutDuration(12 * 60), aboutDuration(2 * 3600), aboutDuration(3 * 3600 + 20 * 60), aboutDuration(26 * 3600)], ['about 12 min', 'about 2 h', 'about 3 h 20 min', 'about 1 d 2 h']);
    });
    test('ctaFor: "Connect wallet" when nothing is connected; no primary when nothing is urgent (setup CTAs: Sprint 3)', () => {
        assert.deepEqual(ctaFor('none', { connected: false }), { label: 'Connect wallet', href: '/wallet?returnTo=%2Fvalidate' });
        for (const s of ['waiting', 'active', 'disabled']) assert.equal(ctaFor(s, { connected: true }), null);
    });
});

// ── chain reads against a hand-built api ──
const num = (n) => ({ toNumber: () => Number(n), toString: () => String(n), toBigInt: () => BigInt(n) });
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });
const hexCodec = (h) => ({ toHex: () => h, toString: () => h });

function fakeApi({ bonded = STASH, inSession = true, queued = true, imOnline = true } = {}) {
    const validators = async (a) => ({ commission: num(a === STASH ? 50_000_000 : 0), blocked: { isTrue: false } });
    validators.size = async (a) => num(a === STASH ? 5 : 0);
    const reads = [];
    const api = {
        reads,
        runtimeVersion: { specVersion: num(393) },
        consts: { staking: { bondingDuration: num(28), sessionsPerEra: num(6) }, babe: { epochDuration: num(1200), expectedBlockTime: num(12000) } },
        query: {
            system: { number: async () => num(1_000_000) },
            staking: {
                bonded: async (a) => { reads.push('bonded'); return opt(a === STASH && bonded ? bonded : null); },
                ledger: async (c) => opt({ stash: STASH, total: num(String(600n * PDEX)), active: num(String(500n * PDEX)) }),
                validators,
                activeEra: async () => opt({ index: num(500) }),
                currentEra: async () => opt(num(500)),
                erasStakersOverview: async (era, a) => opt(a === STASH && inSession ? { total: num(String(90_000n * PDEX)), own: num(String(500n * PDEX)), nominatorCount: num(300), pageCount: num(2) } : null),
                erasRewardPoints: async (era) => ({ total: num(Number(era) === 500 ? 9000 : 8000), individual: new Map([[STASH, num(Number(era) === 500 ? 1200 : 7000)], [V2, num(Number(era) === 500 ? 1500 : 1000)]]) }),
                erasValidatorReward: async () => opt(num(String(80n * PDEX))),
                erasStartSessionIndex: async () => opt(num(2998)),
                slashingSpans: async () => opt(null),
                minValidatorBond: async () => num(String(123n * PDEX)),
                minCommission: async () => num(30_000_000),
                maxValidatorsCount: async () => opt(num(250)),
                counterForValidators: async () => num(217),
                validatorCount: async () => num(200),
                chillThreshold: async () => opt(null)
            },
            session: {
                nextKeys: async (a) => opt(a === STASH ? keysCodec(KEYS) : null),
                queuedKeys: async () => (queued ? [[STASH, keysCodec(KEYS)], [V2, keysCodec(NEWKEYS)]] : [[V2, keysCodec(NEWKEYS)]]),
                validators: async () => (inSession ? [V2, STASH] : [V2]),
                currentIndex: async () => num(3000),
                disabledValidators: async () => [],
                keyOwner: async ([typeId, key]) => { reads.push('keyOwner'); return opt(String(key) === KEYS.babe ? OTHER : null); }
            },
            babe: { epochIndex: async () => num(10), genesisSlot: async () => num(1000), currentSlot: async () => num(1000 + 10 * 1200 + 600) },
            proxy: { proxies: async () => [[{ delegate: PROXY, proxyType: { toString: () => 'Staking' }, delay: num(0) }], num(1)] },
            identity: { identityOf: async () => opt(null) }
        }
    };
    if (imOnline) api.query.imOnline = {
        keys: async () => [hexCodec(NEWKEYS.im_online), hexCodec(KEYS.im_online)],
        receivedHeartbeats: async (s, i) => opt(Number(i) === 1 ? { isTrue: true } : null),
        authoredBlocks: async () => num(3)
    };
    return api;
}

describe('readValidatorStatus: the chain reads behind the status', () => {
    test('an active validator: bonded, keys, queued, in the session set, heartbeat, exposure, points, proxies', async () => {
        const s = await readValidatorStatus(fakeApi(), STASH, { nameOf: async () => 'Alpha', incidents: () => [{ block: 999_000, kind: 'imOnline.SomeOffline' }] });
        assert.deepEqual([s.bonded, s.controller, s.intent, s.inSession, s.inQueued, s.disabled], [true, STASH, true, true, true, false]);
        assert.deepEqual(s.ledger, { total: String(600n * PDEX), active: String(500n * PDEX) });
        assert.deepEqual(s.prefs, { commission: 50_000_000, blocked: false });
        assert.deepEqual(s.nextKeys, KEYS);
        assert.deepEqual(s.queuedKeys, KEYS);
        assert.equal(s.activeImOnlineKey, KEYS.im_online);
        assert.deepEqual([s.heartbeat, s.blocks, s.sessionValidatorIndex, s.sessionValidatorCount], [true, 3, 1, 2]);
        assert.deepEqual(s.exposure, { total: String(90_000n * PDEX), own: String(500n * PDEX), nominatorCount: 300, pageCount: 2 });
        assert.deepEqual(s.points, { points: 1200, rank: 2, of: 2 });
        assert.equal(s.lastEra.points, 7000);
        assert.equal(s.lastEra.reward, String(70n * PDEX), '80 PDEX x 7,000 / 8,000 points');
        assert.deepEqual(s.proxies, [{ delegate: PROXY, type: 'Staking' }]);
        assert.deepEqual(s.identity, { name: 'Alpha', judgements: [] });
        assert.equal(s.incidents.length, 1);
        assert.ok(Math.abs(s.sessionProgress - 0.5) < 1e-9);
        assert.deepEqual([s.sessionsPerEra, s.eraStartSession, s.epochDuration, s.blockTimeMs], [6, 2998, 1200, 12000]);
        assert.equal(validatorStatusModel(s, params()).state, 'active');
    });
    test('not bonded: stops after the Bonded read, everything else empty', async () => {
        const api = fakeApi({ bonded: null });
        const s = await readValidatorStatus(api, OTHER);
        assert.equal(s.bonded, false);
        assert.equal(s.ledger, null);
        assert.equal(validatorStatusModel(s, params()).state, 'not-bonded');
    });
    test('waiting: not in the session set, not queued', async () => {
        const s = await readValidatorStatus(fakeApi({ inSession: false, queued: false }), STASH);
        assert.deepEqual([s.inSession, s.inQueued, s.exposure, s.heartbeat], [false, false, null, null]);
        assert.equal(validatorStatusModel(s, params()).state, 'waiting');
    });
    test('a legacy controller: Bonded(stash) is another account, the ledger is read under it', async () => {
        const api = fakeApi({ bonded: CTRL });
        let ledgerFor = null;
        api.query.staking.ledger = async (c) => { ledgerFor = String(c); return opt({ stash: STASH, total: num('1'), active: num('1') }); };
        const s = await readValidatorStatus(api, STASH);
        assert.equal(s.controller, CTRL);
        assert.equal(ledgerFor, CTRL);
    });
    test('slashRead tells a successful read with no record from a failed read; the page text is unchanged', async () => {
        const none = await readValidatorStatus(fakeApi(), STASH);
        assert.deepEqual([none.lastSlashEra, none.slashRead], [null, true]);
        assert.equal(row(validatorStatusModel(none, params()), 'offences').text.endsWith('No slash.'), true);
        const api = fakeApi();
        api.query.staking.slashingSpans = async () => { throw new Error('rpc'); };
        const failed = await readValidatorStatus(api, STASH);
        assert.deepEqual([failed.lastSlashEra, failed.slashRead], [null, false]);
        assert.equal(row(validatorStatusModel(failed, params()), 'offences').text.endsWith('No slash.'), true);
        const api2 = fakeApi();
        api2.query.staking.slashingSpans = async () => opt({ lastNonzeroSlash: num(0) });
        const zero = await readValidatorStatus(api2, STASH);
        assert.deepEqual([zero.lastSlashEra, zero.slashRead], [0, true]);
    });
    test('a failed heartbeat read is unknown (null), never offline', async () => {
        const api = fakeApi();
        api.query.imOnline.receivedHeartbeats = async () => { throw new Error('rpc'); };
        api.query.imOnline.authoredBlocks = async () => { throw new Error('rpc'); };
        const s = await readValidatorStatus(api, STASH);
        assert.deepEqual([s.heartbeat, s.blocks], [null, null]);
    });
});

describe('readValidatorParams: the live governance values, never constants', () => {
    let registry;
    before(() => { registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata); });
    test('MinValidatorBond, MinCommission, MaxValidatorsCount, counts, layout, era, lowest elected backing, median commission', async () => {
        const api = fakeApi();
        api.registry = registry;
        const overview = (a, total) => [{ args: [num(500), a] }, opt({ total: num(String(total)) })];
        api.query.staking.erasStakersOverview.entries = async () => [overview(STASH, 90_000n * PDEX), overview(V2, 40_000n * PDEX)];
        const prefs = (a, c) => [{ args: [num(500), a] }, { commission: num(c) }];
        api.query.staking.erasValidatorPrefs = { entries: async () => [prefs(STASH, 50_000_000), prefs(V2, 100_000_000), prefs(OTHER, 200_000_000)] };
        api.query.electionProviderMultiPhase = { currentPhase: async () => ({ toString: () => 'Off', type: 'Off' }) };
        const p = await readValidatorParams(api);
        assert.equal(p.specVersion, 393);
        assert.equal(p.layout.ok, true);
        assert.equal(p.layout.hexLength, 388);
        assert.equal(p.minValidatorBond, String(123n * PDEX));
        assert.equal(p.minCommission, 30_000_000);
        assert.equal(p.maxValidatorsCount, 250);
        assert.deepEqual([p.counterForValidators, p.validatorCount, p.chillThreshold], [217, 200, null]);
        assert.equal(p.lowestElectedTotal, String(40_000n * PDEX));
        assert.equal(p.electedCount, 2);
        assert.equal(p.medianCommission, 100_000_000);
        assert.equal(p.electionPhase, 'Off');
        assert.deepEqual([p.activeEra, p.currentEra, p.sessionIndex], [500, 500, 3000]);
    });
    test('MaxValidatorsCount unset (OptionQuery None): null, not zero', async () => {
        const api = fakeApi();
        api.query.staking.maxValidatorsCount = async () => opt(null);
        assert.equal((await readValidatorParams(api)).maxValidatorsCount, null);
    });
});

describe('readKeyOwners: Session.KeyOwner per key, QueuedKeys, NextKeys of the stash', () => {
    test('KeyOwner is asked with (KeyTypeId bytes, key) for each of the six keys', async () => {
        const api = fakeApi();
        const asked = [];
        api.query.session.keyOwner = async ([t, k]) => { asked.push([Array.from(t).map(c => String.fromCharCode(c)).join(''), String(k)]); return opt(String(k) === KEYS.babe ? OTHER : null); };
        const keys = EXPECTED_LAYOUT.map(l => ({ ...l, hex: KEYS[l.name] }));
        const r = await readKeyOwners(api, keys, STASH);
        assert.deepEqual(asked.map(a => a[0]), ['gran', 'babe', 'imon', 'audi', 'mixn', 'beef']);
        assert.deepEqual(asked.map(a => a[1]), Object.values(KEYS));
        assert.deepEqual(r.owners, [null, OTHER, null, null, null, null]);
        assert.deepEqual(r.nextKeys, KEYS);
        assert.deepEqual(r.queued.map(q => q.account), [STASH, V2]);
        assert.equal(r.queued[1].keys.im_online, NEWKEYS.im_online);
    });
    test('keysToMap: real SessionKeys codecs from spec 393 metadata, snake_case names', () => {
        const registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        const c = registry.createType('Lookup266', { grandpa: KEYS.grandpa, babe: KEYS.babe, imOnline: KEYS.im_online, authorityDiscovery: KEYS.authority_discovery, mixnet: KEYS.mixnet, beefy: KEYS.beefy });
        assert.deepEqual(keysToMap(c), KEYS);
    });
});

// ── the routes ──
function fakeLayoutRegistry(fields) {
    const types = { 1: { def: { isVariant: true, asVariant: { variants: [{ name: { toString: () => 'set_keys' }, fields: [{ name: { toString: () => 'keys' }, type: 2 }] }] } } },
        2: { def: { isComposite: true, asComposite: { fields: fields.map((f, i) => ({ name: { toString: () => f.name, isSome: true, unwrap: () => ({ toString: () => f.name }) }, type: 100 + i })) } } } };
    fields.forEach((f, i) => { types[100 + i] = { def: { isArray: true, asArray: { len: num(f.bytes), type: 3 } } }; });
    return { metadata: { pallets: [{ name: { toString: () => 'Session' }, calls: { isSome: true, unwrap: () => ({ type: 1 }) } }] }, lookup: { getSiType: (id) => types[Number(id)] } };
}
describe('the routes', () => {
    let server, base, api, ready = true, clock = 1_000_000, allow = true, statusAllow = true;
    const SHORT = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
    const MEDIUM = 'public, max-age=30, s-maxage=60, stale-while-revalidate=120';
    const isAddr = (s) => /^e[1-9A-HJ-NP-Za-km-z]{46,}$/.test(String(s || ''));
    let paramReads = 0;
    function freshApi() {
        const a = fakeApi();
        a.registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        a.query.staking.erasStakersOverview.entries = async () => [[{ args: [num(500), STASH] }, opt({ total: num(String(40_000n * PDEX)) })]];
        a.query.staking.erasValidatorPrefs = { entries: async () => [[{ args: [num(500), STASH] }, { commission: num(50_000_000) }]] };
        const mvb = a.query.staking.minValidatorBond;
        a.query.staking.minValidatorBond = async () => { paramReads++; return mvb(); };
        return a;
    }
    before(async () => {
        api = freshApi();
        const app = express();
        registerValidatorRoutes(app, {
            api: () => api,
            ready: (res) => { if (ready) return true; res.set('Cache-Control', 'no-store'); res.status(503).json({ code: 'RPC_NOT_READY' }); return false; },
            gate: (req, res) => { if (!isAddr(req.params.address)) { res.status(400).json({ error: 'Invalid Polkadex address.' }); return null; } return { address: req.params.address }; },
            parseAddress: (s) => (isAddr(s) ? String(s) : null),
            cacheShort: (res) => res.set('Cache-Control', SHORT),
            cacheMedium: (res) => res.set('Cache-Control', MEDIUM),
            serverError: (res) => { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'Internal error.' }); },
            incidents: () => [], nameOf: async () => null,
            rateOk: () => allow,
            statusRateOk: () => statusAllow,
            now: () => clock
        });
        await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => { if (server) server.close(); });
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };
    test('route constants', () => {
        assert.deepEqual([VALIDATOR_PARAMS_ROUTE, VALIDATOR_STATUS_ROUTE, SESSION_KEYS_CHECK_ROUTE], ['/api/validator/params', '/api/validator/:address/status', '/api/session-keys/check']);
    });
    test('params: 200, Medium tier, the live values; cached 60 s; re-read after', async () => {
        paramReads = 0;
        const r = await get('/api/validator/params');
        assert.equal(r.status, 200);
        assert.equal(r.cache, MEDIUM);
        assert.equal(r.body.minValidatorBond, String(123n * PDEX));
        assert.equal(r.body.minCommission, 30_000_000);
        assert.equal(r.body.maxValidatorsCount, 250);
        assert.equal(r.body.layout.ok, true);
        await get('/api/validator/params');
        assert.equal(paramReads, 1, 'served from the 60 s cache');
        clock += 61_000;
        await get('/api/validator/params');
        assert.equal(paramReads, 2);
    });
    test('params: an RPC blip keeps the last good value (stale: true), as getMinNominatorBondCached does', async () => {
        clock += 61_000;
        const saved = api.query.staking.minValidatorBond;
        api.query.staking.minValidatorBond = async () => { throw new Error('rpc gone'); };
        try {
            const r = await get('/api/validator/params');
            assert.equal(r.status, 200);
            assert.equal(r.body.stale, true);
            assert.equal(r.body.minValidatorBond, String(123n * PDEX));
        } finally { api.query.staking.minValidatorBond = saved; }
    });
    test('status: 200 Short tier, the model with the live limits', async () => {
        const r = await get(`/api/validator/${STASH}/status`);
        assert.equal(r.status, 200);
        assert.equal(r.cache, SHORT);
        assert.equal(r.body.address, STASH);
        assert.equal(r.body.state, 'active');
        assert.equal(r.body.limits.minValidatorBond, String(123n * PDEX));
        assert.ok(Array.isArray(r.body.rows));
    });
    test('status: kept 30 s per address', async () => {
        const before = api.reads.filter(x => x === 'bonded').length;
        await get(`/api/validator/${V2}/status`);
        await get(`/api/validator/${V2}/status`);
        assert.equal(api.reads.filter(x => x === 'bonded').length - before, 1);
        clock += 31_000;
        await get(`/api/validator/${V2}/status`);
        assert.equal(api.reads.filter(x => x === 'bonded').length - before, 2);
    });
    test('status: 400 on a bad address, 503 without the node', async () => {
        assert.equal((await get('/api/validator/nope/status')).status, 400);
        ready = false;
        try { const r = await get(`/api/validator/${OTHER}/status`); assert.equal(r.status, 503); } finally { ready = true; }
    });
    test('status: rate limited per IP like the keys check (429, no-store) and nothing is read from the node', async () => {
        statusAllow = false;
        const before = api.reads.length;
        try {
            const r = await get(`/api/validator/${addr(80)}/status`);
            assert.equal(r.status, 429);
            assert.equal(r.cache, 'no-store');
            assert.equal(r.body.code, 'RATE_LIMITED');
            const hit = await get(`/api/validator/${V2}/status`);
            assert.equal(hit.status, 429, 'a cached address is limited too');
            assert.equal(api.reads.length, before);
        } finally { statusAllow = true; }
    });
    test('status: concurrent requests for one address share a single read of the node (in-flight dedupe)', async () => {
        const a = addr(81);
        const before = api.reads.filter(x => x === 'bonded').length;
        const real = api.query.staking.bonded;   // a slow node, so the three requests overlap
        api.query.staking.bonded = async (x) => { await new Promise(r => setTimeout(r, 80)); return real(x); };
        let rs;
        try { rs = await Promise.all([get(`/api/validator/${a}/status`), get(`/api/validator/${a}/status`), get(`/api/validator/${a}/status`)]); } finally { api.query.staking.bonded = real; }
        assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
        assert.equal(api.reads.filter(x => x === 'bonded').length - before, 1);
    });
    test('status: a failed read is not remembered by the dedupe (the next request reads again)', async () => {
        const a = addr(82);
        const real = api.query.staking.bonded;
        api.query.staking.bonded = async () => { throw new Error('rpc blip'); };
        try { assert.equal((await get(`/api/validator/${a}/status`)).status, 500); } finally { api.query.staking.bonded = real; }
        assert.equal((await get(`/api/validator/${a}/status`)).status, 200);
    });
    test('check: 200 no-store; each key with its result; the babe key registered to another account is a conflict', async () => {
        const r = await get(`/api/session-keys/check?keys=${BLOB}&for=${STASH}`);
        assert.equal(r.status, 200);
        assert.equal(r.cache, 'no-store');
        assert.equal(r.body.conflict, true);
        assert.deepEqual(r.body.rows.map(x => x.result), ['free', 'other', 'free', 'free', 'free', 'free']);
        assert.equal(r.body.rows[1].owner, OTHER);
        assert.equal(r.body.bytes, 193);
        assert.equal(r.body.specVersion, 393);
        assert.ok(!JSON.stringify(r.body).includes(BLOB), 'the blob is not echoed back whole');
    });
    test('check: input validation (missing, a secret phrase, not hex, wrong length, a bad for=, too long)', async () => {
        const cases = [
            ['', 'empty'], ['?keys=bottom%20drive%20obey%20lake%20curtain', 'secret'], [`?keys=0x${'zz'.repeat(193)}`, 'hex'],
            [`?keys=${BLOB.slice(0, -2)}`, 'length'], [`?keys=0x${'ab'.repeat(32)}`, 'single'], [`?keys=${'0x' + 'ab'.repeat(600)}`, 'length']
        ];
        for (const [q, code] of cases) {
            const r = await get('/api/session-keys/check' + q);
            assert.equal(r.status, 400, q);
            assert.equal(r.body.code, code, q);
            assert.equal(r.cache, 'no-store');
        }
        const bad = await get(`/api/session-keys/check?keys=${BLOB}&for=nope`);
        assert.equal(bad.status, 400);
    });
    test('check: a live layout that differs (seven keys) is 409 LAYOUT_MISMATCH and no key is looked up', async () => {
        const saved = api.registry;
        api.registry = fakeLayoutRegistry([...EXPECTED_LAYOUT.slice(0, 4), { name: 'orderbook', bytes: 32 }, ...EXPECTED_LAYOUT.slice(4)]);
        clock += 61_000;
        const before = api.reads.filter(x => x === 'keyOwner').length;
        try {
            const r = await get(`/api/session-keys/check?keys=${BLOB}`);
            assert.equal(r.status, 409);
            assert.equal(r.body.code, 'LAYOUT_MISMATCH');
            assert.match(r.body.error, /session key format is different from what this checker knows/);
            assert.equal(api.reads.filter(x => x === 'keyOwner').length, before);
        } finally { api.registry = saved; clock += 61_000; }
    });
    test('check: rate limited (429, no-store)', async () => {
        allow = false;
        try { const r = await get(`/api/session-keys/check?keys=${BLOB}`); assert.equal(r.status, 429); assert.equal(r.cache, 'no-store'); } finally { allow = true; }
    });
    test('createKeyCheckLimiter: a sliding window per IP, divided across workers', () => {
        let t = 0;
        const lim = createKeyCheckLimiter({ perMinute: 4, workers: 2, now: () => t });
        assert.deepEqual([lim('a'), lim('a'), lim('a'), lim('b')], [true, true, false, true]);
        t += 61_000;
        assert.equal(lim('a'), true);
    });
});

// ── the page ──
function dom() {
    const w = new Window({ url: 'http://localhost/validate' });
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    return { w, el, doc: w.document };
}
const flush = (n = 5) => new Promise(r => setTimeout(r, n));
function deps(over = {}) {
    const urls = [];
    const status = (a) => ({ ...validatorStatusModel(snap({ address: a }), params()), address: a });
    return {
        urls,
        account: { status: 'connected', address: STASH }, urlAddress: '', isSame: (a, b) => a === b,
        fetchJson: async (u) => {
            urls.push(u);
            if (u === '/api/validator/params') return params();
            const m = /^\/api\/validator\/([^/]+)\/status$/.exec(u);
            if (m) return status(decodeURIComponent(m[1]));
            if (u.startsWith('/api/session-keys/check')) return { ok: true, conflict: false, bytes: 193, specVersion: 393, summary: '6 keys, 193 bytes, none registered to another account.', rows: EXPECTED_LAYOUT.map(l => ({ name: l.name, typeId: l.typeId, preview: '11111111...11111111', result: 'free', owner: null, message: 'Not registered to any account.' })) };
            throw new Error('unexpected ' + u);
        },
        helpIcon: () => '', esc: escapeHtml, shortAddr: short, navigate: () => {},
        ...over
    };
}
const primaries = (el) => el.querySelectorAll('.validate-primary').length;

describe('renderValidatorStatus and renderKeysPage', () => {
    test('headline, pill word (state is a word, not colour alone), every row with its label', () => {
        const html = renderValidatorStatus(model(), { esc: escapeHtml });
        assert.match(html, /class="validate-pill is-positive"[^>]*><i class="bx bx-check-circle" aria-hidden="true"><\/i>Active</);
        assert.match(html, /Active in era 500\./);
        for (const l of ['Keys', 'Online this session', 'Era points', 'Offences', 'Stake', 'Nominators', 'Commission', 'Identity', 'Access']) assert.ok(html.includes(`<dt>${l}</dt>`), l);
    });
    test('a row whose text opens with its word shows the word once (the badge)', () => {
        const html = renderValidatorStatus(model(), { esc: escapeHtml });
        assert.match(html, /<span class="validate-word is-positive"><i class="bx bx-pulse" aria-hidden="true"><\/i>Heartbeat received<\/span> <span class="validate-text"><\/span>/);
        const w = renderValidatorStatus(model({ inSession: false, inQueued: false, queuedKeys: null, activeImOnlineKey: null }), { esc: escapeHtml });
        assert.match(w, /<span class="validate-word is-neutral"><i class="bx bx-key" aria-hidden="true"><\/i>Registered<\/span> <span class="validate-text">Used once this stash is elected\.<\/span>/);
    });
    test('chain text is escaped', () => {
        const html = renderValidatorStatus(model({ identity: { name: 'Al<script>', judgements: [] } }), { esc: escapeHtml });
        assert.ok(html.includes('Al&lt;script&gt;'));
        assert.ok(!html.includes('Al<script>'));
    });
    test('the keys checker: the field, labelled, mono, no autocomplete or spellcheck, tied to its message, a polite live region', () => {
        const html = renderKeysPage({ params: params(), esc: escapeHtml });
        const { doc } = dom();
        doc.body.innerHTML = html;
        const ta = doc.querySelector('textarea#validate-keys-input');
        assert.ok(ta);
        assert.equal(doc.querySelector('label[for="validate-keys-input"]').textContent.trim(), 'Session keys (0x, 388 characters)');
        assert.equal(ta.getAttribute('autocomplete'), 'off');
        assert.equal(ta.getAttribute('spellcheck'), 'false');
        assert.equal(ta.getAttribute('aria-describedby'), 'validate-keys-msg');
        assert.equal(doc.getElementById('validate-keys-msg').getAttribute('aria-live'), 'polite');
        assert.match(html, /<h2>Check session keys/);
        assert.match(html, /generated on your own node/);
        assert.ok(html.includes(VALIDATE_STATEMENT));
    });
    test('the 388 in the label comes from the live layout, not a constant', () => {
        const html = renderKeysPage({ params: params({ layout: { ok: true, bytes: 10, hexLength: 22 } }), esc: escapeHtml });
        assert.match(html, /Session keys \(0x, 22 characters\)/);
    });
    test('layout mismatch: the copy and no form', () => {
        const html = renderKeysPage({ params: params({ specVersion: 394, layout: { ok: false, reason: '7 keys' } }), esc: escapeHtml });
        assert.match(html, /session key format is different from what this checker knows\. Use your node&#39;s author_rotateKeys output and the chain&#39;s own validation\./);
        assert.doesNotMatch(html, /<textarea/);
    });
    test('the statement: never asks for a seed, keys come from your own node', () => {
        assert.equal(VALIDATE_STATEMENT, 'The explorer cannot reach, start or check your server. It never asks for a seed, a private key or a keystore file. You run the node; you paste one line of public keys here; you sign with your own wallet.');
    });
});

describe('the status view: live region, focus, table headers, retry on a row (review finding 4)', () => {
    test('the status slot is a polite live region, present before the answer arrives', async () => {
        const { el } = dom();
        let release; const gate = new Promise(r => { release = r; });
        const d = deps(); const real = d.fetchJson;
        d.fetchJson = async (u) => { if (/\/status$/.test(u)) await gate; return real(u); };
        const p = mountValidatePage(el, d); await flush();
        const slot = el.querySelector('#validate-status-slot');
        assert.equal(slot.getAttribute('aria-live'), 'polite');
        release(); await p; await flush();
        assert.equal(el.querySelector('#validate-status-slot').getAttribute('aria-live'), 'polite');
    });
    test('after the status loads the headline takes focus; so it does after a failure', async () => {
        const { el, doc } = dom(); el.setAttribute('id', 'root'); 
        await mountValidatePage(el, deps()); await flush();
        assert.equal(doc.activeElement && doc.activeElement.id, 'validate-headline');
        const { el: e2, doc: d2 } = dom();
        await mountValidatePage(e2, deps({ fetchJson: async (u) => { if (u === '/api/validator/params') return params(); const e = new Error('x'); e.status = 503; throw e; } })); await flush();
        assert.equal(d2.activeElement && d2.activeElement.id, 'validate-headline');
    });
    test('the loading headline is not focused (nothing to read yet)', async () => {
        const { el, doc } = dom();
        let release; const gate = new Promise(r => { release = r; });
        const d = deps(); const real = d.fetchJson;
        d.fetchJson = async (u) => { if (/\/status$/.test(u)) await gate; return real(u); };
        const p = mountValidatePage(el, d); await flush();
        assert.notEqual(doc.activeElement && doc.activeElement.id, 'validate-headline');
        release(); await p;
    });
    test('the keys table: scope="col" on every column header, scope="row" on the key name', async () => {
        const { el, w } = dom(); const d = deps();
        await mountKeysPage(el, d); await flush();
        el.querySelector('#validate-keys-input').value = BLOB;
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush(20);
        const heads = Array.from(el.querySelectorAll('.validate-keys-table thead th'));
        assert.equal(heads.length, 4);
        for (const h of heads) assert.equal(h.getAttribute('scope'), 'col');
        const rowHeads = Array.from(el.querySelectorAll('.validate-keys-table tbody th'));
        assert.equal(rowHeads.length, 6);
        for (const h of rowHeads) assert.equal(h.getAttribute('scope'), 'row');
        assert.match(rowHeads[0].textContent, /grandpa/);
    });
    test('a row that asks for a retry shows a secondary Retry button that reads the status again', async () => {
        const { el, w } = dom();
        let calls = 0;
        const d = deps(); const real = d.fetchJson;
        d.fetchJson = async (u) => {
            if (/^\/api\/validator\/[^/]+\/status$/.test(u)) { calls++; return { ...validatorStatusModel(snap({ address: STASH, exposure: null }), params()), address: STASH }; }
            return real(u);
        };
        await mountValidatePage(el, d); await flush();
        // amended (fidelity review 14): the Retry sits on the tile only, not in "All details".
        const btn = el.querySelector('.validate-tile [data-validate-action="retry"]');
        assert.ok(btn);
        assert.ok(!btn.classList.contains('validate-primary'));
        assert.equal(calls, 1);
        btn.dispatchEvent(new w.Event('click', { cancelable: true })); await flush();
        assert.equal(calls, 2);
    });
});

describe('mountValidatePage: wallet-aware, read-only', () => {
    test('/validate with a wallet connected: the connected account by default, no banner, no primary button', async () => {
        const { el } = dom(); const d = deps();
        await mountValidatePage(el, d); await flush();
        assert.ok(d.urls.includes(`/api/validator/${encodeURIComponent(STASH)}/status`));
        assert.ok(!d.urls.includes('/api/validator/params'), 'the hub no longer reads the key layout: the checker has its own page');
        assert.equal(el.querySelector('.wallet-viewing-note'), null);
        assert.match(el.textContent, /Active in era 500\./);
        assert.equal(primaries(el), 0, 'nothing urgent: zero primary buttons is allowed, two is not');
    });
    test('/validate/<other> with a wallet connected: that stash, with the viewing banner', async () => {
        const { el } = dom(); const d = deps({ urlAddress: V2 });
        await mountValidatePage(el, d); await flush();
        assert.ok(d.urls.includes(`/api/validator/${encodeURIComponent(V2)}/status`));
        assert.ok(!d.urls.includes(`/api/validator/${encodeURIComponent(STASH)}/status`));
        assert.ok(el.querySelector('.wallet-viewing-note'));
    });
    test('/validate/<other> with nothing connected: read only note, no Connect primary in the status view', async () => {
        const { el } = dom(); const d = deps({ urlAddress: V2, account: { status: 'none', address: '' } });
        await mountValidatePage(el, d); await flush();
        assert.ok(el.querySelector('.wallet-viewing-note.is-readonly'));
        assert.ok(primaries(el) <= 1);
    });
    test('/validate with nothing connected: an address lookup and exactly one primary, Connect wallet', async () => {
        const { el } = dom(); const d = deps({ account: { status: 'none', address: '' } });
        await mountValidatePage(el, d); await flush();
        assert.equal(primaries(el), 1);
        assert.equal(el.querySelector('.validate-primary').textContent.trim(), 'Connect wallet');
        assert.ok(el.querySelector('#validate-lookup-input'));
        assert.ok(!d.urls.some(u => /\/status$/.test(u)));
    });
    test('restoring: says it is checking, fetches no status', async () => {
        const { el } = dom(); const d = deps({ account: { status: 'restoring', address: '' } });
        await mountValidatePage(el, d); await flush();
        assert.match(el.textContent, /Checking for a connected wallet/);
        assert.ok(!d.urls.some(u => /\/status$/.test(u)));
    });
    test('loading: skeleton rows and "Reading the chain" before the answer', async () => {
        const { el } = dom();
        let release; const gate = new Promise(r => { release = r; });
        const d = deps(); const real = d.fetchJson;
        d.fetchJson = async (u) => { if (/\/status$/.test(u)) await gate; return real(u); };
        const p = mountValidatePage(el, d); await flush();
        assert.match(el.textContent, /Reading the chain/);
        assert.ok(el.querySelector('.validate-skeleton'));
        release(); await p; await flush();
        assert.doesNotMatch(el.textContent, /Reading the chain/);
    });
    test('RPC down: the design copy and a Retry button that is not primary', async () => {
        const { el } = dom();
        const d = deps({ fetchJson: async () => { const e = new Error('x'); e.status = 503; throw e; } });
        await mountValidatePage(el, d); await flush();
        assert.match(el.textContent, /The explorer cannot reach the chain right now\. Your validator is not affected\./);
        const retry = el.querySelector('[data-validate-action="retry"]');
        assert.ok(retry);
        assert.ok(!retry.classList.contains('validate-primary'));
    });
    test('lookup: a valid address goes to /validate/<address>; anything else is said, not fetched', async () => {
        const { el, w } = dom(); const went = [];
        const d = deps({ account: { status: 'none', address: '' }, navigate: (p) => went.push(p), isAddress: (s) => s === V2 });
        await mountValidatePage(el, d); await flush();
        el.querySelector('#validate-lookup-input').value = 'nope';
        el.querySelector('#validate-lookup-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        assert.deepEqual(went, []);
        assert.match(el.querySelector('#validate-lookup-msg').textContent, /not a Polkadex address/);
        el.querySelector('#validate-lookup-input').value = V2;
        el.querySelector('#validate-lookup-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        assert.deepEqual(went, ['validate/' + V2]);
    });
    test('checker (/validate/keys): a secret phrase is refused in the browser and never sent anywhere', async () => {
        const { el, w } = dom(); const d = deps();
        await mountKeysPage(el, d); await flush();
        el.querySelector('#validate-keys-input').value = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush();
        assert.ok(!d.urls.some(u => u.startsWith('/api/session-keys/check')));
        assert.match(el.querySelector('#validate-keys-msg').textContent, /That looks like a secret phrase/);
    });
    test('checker (/validate/keys): a valid line is checked for the connected wallet and the table shows each key with a text result', async () => {
        const { el, w } = dom(); const d = deps({ getAccount: () => ({ status: 'connected', address: V2 }) });
        await mountKeysPage(el, d); await flush();
        el.querySelector('#validate-keys-input').value = BLOB;
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush(20);
        const u = d.urls.find(x => x.startsWith('/api/session-keys/check'));
        assert.equal(u, `/api/session-keys/check?keys=${BLOB}&for=${encodeURIComponent(V2)}`);
        const rows = el.querySelectorAll('.validate-keys-table tbody tr');
        assert.equal(rows.length, 6);
        assert.match(rows[0].textContent, /grandpa/);
        assert.match(rows[0].textContent, /Not registered/);
        assert.match(el.querySelector('#validate-keys-msg').textContent, /6 keys, 193 bytes, none registered to another account\./);
    });
    test('checker (/validate/keys): a conflict is announced with role="alert" and the address', async () => {
        const { el, w } = dom(); const d = deps();
        const real = d.fetchJson;
        d.fetchJson = async (u) => {
            if (!u.startsWith('/api/session-keys/check')) return real(u);
            d.urls.push(u);
            const rows = EXPECTED_LAYOUT.map((l, i) => ({ name: l.name, typeId: l.typeId, preview: 'x', result: i === 0 ? 'other' : 'free', owner: i === 0 ? OTHER : null,
                message: i === 0 ? `Key 1 (grandpa) is already registered to ${OTHER}. The chain will reject these keys. If you copied a keystore from another node, stop: running two nodes with the same keys is slashed.` : 'Not registered to any account.' }));
            return { ok: true, conflict: true, rows, bytes: 193, summary: rows[0].message };
        };
        await mountKeysPage(el, d); await flush();
        el.querySelector('#validate-keys-input').value = BLOB;
        el.querySelector('#validate-keys-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
        await flush(20);
        const alert = el.querySelector('[role="alert"]');
        assert.ok(alert);
        assert.ok(alert.textContent.includes(OTHER));
        assert.match(alert.textContent, /running two nodes with the same keys is slashed/);
    });
});

describe('the flag (FEATURE_FLAGS.validate, ?validate=1)', () => {
    const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
    test('off by default for everyone', () => assert.equal(FEATURE_FLAGS.validate, false));
    test('?validate=1 opts this browser in (pdex_validate_enabled), ?validate=0 opts out', () => {
        const s = store();
        assert.equal(VALIDATE_FLAG_KEY, 'pdex_validate_enabled');
        assert.equal(validateEnabled({ flag: false, storage: s, search: '' }), false);
        assert.equal(validateEnabled({ flag: false, storage: s, search: '?validate=1' }), true);
        assert.equal(validateEnabled({ flag: false, storage: s, search: '' }), true, 'remembered');
        assert.equal(validateEnabled({ flag: false, storage: s, search: '?validate=0' }), false);
        assert.equal(s.m.size, 0);
        assert.equal(validateEnabled({ flag: true, storage: s, search: '' }), true);
    });
    test('a storage that throws (private mode) is off, not a crash', () => {
        const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
        assert.equal(validateEnabled({ flag: false, storage: bad, search: '?validate=1' }), false);
    });
    test('the validate route manages its own wallet changes (like /staking-rewards)', () => {
        assert.equal(selfManagedRoute('validate'), true);
        assert.equal(selfManagedRoute('validate/' + STASH), true);
        assert.equal(selfManagedRoute('validators'), false);
    });
    test('help topics for the flag are hidden while it is off', () => {
        const flagged = HELP_TOPICS.filter(t => t.flag === 'validate').map(t => t.slug);
        assert.deepEqual(flagged.sort(), ['run-a-validator', 'session-keys', 'validator-manage', 'validator-setup', 'validator-status'], 'Sprint 5 adds validator-manage');
        assert.ok(!visibleHelpTopics(HELP_TOPICS, { validate: false }).some(t => t.flag));
        assert.equal(visibleHelpTopics(HELP_TOPICS, { validate: true }).length, HELP_TOPICS.length);
    });
});

describe('wiring: server, docs, shell, script, brand', () => {
    const server = stripComments(readRepo('server.js', import.meta.url));
    const script = stripComments(readRepo('script.js', import.meta.url));
    const html = readRepo('index.html', import.meta.url);
    test('server.js registers the routes before /api/validator/:address (or "params" would be read as an address)', () => {
        const reg = server.indexOf('registerValidatorRoutes(app,');
        const old = server.indexOf("app.get('/api/validator/:address'");
        assert.ok(reg > 0 && old > 0 && reg < old, 'registerValidatorRoutes must come first');
        assert.match(server, /registerValidatorRoutes\(app, \{[^}]*requireRpc[^}]*cacheShort[^}]*cacheMedium[^}]*serverError[^}]*getValidatorIncidents[^}]*\}\)/s);
        assert.match(server, /import \{ registerValidatorRoutes, createKeyCheckLimiter \} from '\.\/lib\/validator-status-api\.js'/);
    });
    test('documented: API reference (params Medium, status Short, check no shared cache), README, llms.txt', () => {
        for (const p of ['/api/validator/params', '/api/validator/:address/status', '/api/session-keys/check?keys=0x...&for=<address>']) assert.ok(allRoutes().some(r => r.method === 'GET' && r.path === p), p);
        const tier = (r) => CACHE_TIERS.find(t => t.routes.includes(r))?.name;
        assert.deepEqual([tier('/api/validator/params'), tier('/api/validator/:address/status'), tier('/api/session-keys/check')], ['Medium', 'Short', 'No shared cache']);
        for (const f of ['README.md', 'public/llms.txt']) for (const p of ['/api/validator/params', '/api/validator/:address/status', '/api/session-keys/check']) assert.ok(readRepo(f, import.meta.url).includes(p), `${f} ${p}`);
    });
    test('index.html: a hidden sidebar entry under Stake PDEX (bx-server), the page section, the cookie documented', () => {
        assert.match(html, /<a href="\/validate" class="nav-item" data-target="validate" id="nav-validate" hidden><i class='bx bx-server'><\/i> Validate<\/a>/);
        assert.ok(html.indexOf('id="nav-validate"') > html.indexOf('id="nav-stake"'));
        assert.ok(html.indexOf('id="nav-validate"') < html.indexOf('>Governance</div>'));
        assert.match(html, /data-page="validate"/);
        assert.match(html, /<code[^>]*>pdex_validate_enabled<\/code>/);
    });
    test('script.js: the flag gate, the route (not-found when off), self-managed, the help filter, under its 15,000 line ceiling', () => {
        assert.match(script, /validateEnabled\(\{ flag: FEATURE_FLAGS\.validate, storage: localStorage, search: window\.location\.search \}\)/);
        assert.match(script, /target === 'validate' \|\| target\.startsWith\('validate\/'\)/);
        assert.match(script, /mainTarget = VALIDATE_ON \? 'validate' : 'not-found'/);
        assert.match(script, /mountValidatePage\(/);
        assert.match(script, /const SHOWN_HELP_TOPICS = visibleHelpTopics\(HELP_TOPICS, \{ validate: VALIDATE_ON \}\)/);
        assert.ok(!/\bHELP_TOPICS\b/.test(script.slice(script.indexOf('\n', script.indexOf('const HELP_BY_SLUG')))), 'the help centre reads the filtered list');
        assert.match(script, /const HELP_BY_SLUG = Object\.fromEntries\(HELP_TOPICS\.map\(t => \[t\.slug, t\]\)\.filter\(\(\[, t\]\) => SHOWN_HELP_TOPICS\.includes\(t\)\)\)/);
        assert.match(script, /'validate':\s*\{[^}]*noindex: true/);
        assert.ok(readRepo('script.js', import.meta.url).split('\n').length <= 15000);
    });
    test('help articles: no dashes; not in the sitemap while the flag is off', () => {
        for (const slug of ['validator-status', 'session-keys']) {
            const t = HELP_TOPICS.find(x => x.slug === slug);
            assert.ok(t, slug);
            assert.ok(!/[–—]/.test(t.body + t.title), slug);
            assert.doesNotMatch(server, new RegExp(`path: '/help/${slug}'`));
        }
        const keys = HELP_TOPICS.find(x => x.slug === 'session-keys').body;
        for (const w of ['author_rotateKeys', '127.0.0.1', 'never', '193 bytes', 'KeyOwner']) assert.ok(keys.includes(w), w);
    });
    test('no governance limit is a literal in the client (they are storage values, read live)', () => {
        for (const f of ['lib/validator-status.js', 'lib/validator-status-view.js', 'lib/session-keys.js']) {
            const src = stripComments(readRepo(f, import.meta.url));
            assert.doesNotMatch(src, /(minValidatorBond|minCommission|maxValidatorsCount|MinValidatorBond|MinCommission|MaxValidatorsCount)\s*[:=]\s*['"]?\d/, f);
            assert.doesNotMatch(src, /\b100 PDEX\b|100_000_000_000_000|\b250\b/, f);
        }
    });
    // Rewritten for the colour roles (spec 2026-11-21 sections 2.1 and 4, replacing "green only for Active and
    // Heartbeat"): each role colour only where its meaning is; no green, amber, blue or red on an action.
    test('brand: green only on positive and done classes, amber only on wait, warn and caution parts; no accent on any validate button or link', () => {
        const css = readRepo('styles.css', import.meta.url).replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] })).filter(r => /\.validate-/.test(r.sel));
        assert.ok(rules.length > 0, 'the validate styles exist');
        const green = rules.filter(r => /--success|--accent-green|--brand-secondary|#14f195|#00e676/i.test(r.body));
        for (const r of green) assert.match(r.sel, /is-positive|is-done|is-ok|\.ui-/, r.sel);
        const amber = rules.filter(r => /--accent-amber|--warning/.test(r.body));
        for (const r of amber) assert.match(r.sel, /is-wait|is-warn|\.ui-/, r.sel);
        const accent = rules.filter(r => /--error|--accent-(red|green|amber|blue)|#ff4d4d/i.test(r.body));
        for (const r of accent) for (const s of r.sel.split(',')) if (!/\.ui-|is-(error|positive|wait|info|ok|done)|validate-msg|aria-invalid|validate-alert|validate-tile-chip/.test(s)) assert.doesNotMatch(s, /btn|button|primary|secondary|link|:hover|:focus/, s);
        for (const r of rules) assert.doesNotMatch(r.body, /#[0-9a-f]{3,8}\b(?![^;]*var\()/i, `new colour literal in ${r.sel}`);
        const view = stripComments(readRepo('lib/validator-status-view.js', import.meta.url));
        assert.doesNotMatch(view, /style="[^"]*(--success|--brand-secondary|--error|--accent-)/);
    });
});

// Paste and Clear (spec 2026-11-17-input-paste-clear, rows 61 and 62): the lookup box is an
// address, the keys checker a hex textarea; both get the shared buttons as soon as the view
// renders (not a frame later), including after the checker re-renders with the live layout.
// The checker's own "Paste" text button is gone: one paste control per field.
describe('the validate page: Paste and Clear on its text boxes', () => {
    test('the lookup is kind address, the keys checker kind hex', () => {
        const { doc } = dom();
        doc.body.innerHTML = renderKeysPage({ params: params(), esc: escapeHtml });
        assert.equal(doc.querySelector('#validate-keys-input').getAttribute('data-input-kind'), 'hex');
        assert.equal(doc.querySelector('[data-validate-action="paste"]'), null, 'the bespoke Paste button is replaced by the shared one');
    });
    test('both fields are wrapped on mount and the checker again after the params arrive', async () => {
        const { el } = dom();
        let release; const gate = new Promise(r => { release = r; });
        const d = deps(); const real = d.fetchJson;
        d.fetchJson = async (u) => { if (u === '/api/validator/params') await gate; return real(u); };
        mountValidatePage(el, deps());
        const look = el.querySelector('#validate-lookup-input');
        assert.equal(look.getAttribute('data-input-kind'), 'address');
        assert.ok(look.closest('.ia-wrap'), 'lookup wrapped synchronously');
        const { el: kel } = dom();
        const p = mountKeysPage(kel, d);
        assert.ok(kel.querySelector('#validate-keys-input').closest('.ia-wrap'), 'checker wrapped synchronously');
        release(); await p; await flush();
        const ta = kel.querySelector('#validate-keys-input');
        assert.ok(ta.closest('.ia-wrap.ia-wrap-ta'), 'the re-rendered checker is wrapped too');
        assert.ok(ta.closest('#validate-keys-form'), 'still inside its form, so Check keys reads it');
    });
});
