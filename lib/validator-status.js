// Validator status: one headline state and the rows under it. Pure:
// lib/validator-status-chain.js reads the chain into the snapshot this takes,
// lib/validator-status-view.js renders the model. Tested in
// test/validator-status.test.js.
//
// Headline state (design section 2.4), by precedence:
//   disabled            in Session.Validators and in Session.DisabledValidators
//   active              in Session.Validators, with a Staking.Validators entry
//   active-leaving      in Session.Validators, no Staking.Validators entry
//   elected-next        in Session.QueuedKeys (or exposed for the planned era)
//   not-bonded          no Staking.Bonded
//   bonded-no-keys      bonded, no Session.NextKeys
//   keys-not-validating keys, no Staking.Validators entry
//   waiting             a Staking.Validators entry, not elected
//
// Colour (BRAND.md): green only for "Active" and "Heartbeat received"; the
// error colour only for Disabled, Slashed (and a duplicated key in the
// checker); everything else neutral. Every state is also a word.
//
// MinValidatorBond, MinCommission and MaxValidatorsCount are storage values
// set by governance. They arrive in `params` from a live read and are never
// written here as numbers.

import { OFFLINE_PROGRESS } from './nomination-status.js';

const PLANCK = 10n ** 12n;
const PERBILL = 1_000_000_000n;
const PAGE_SIZE = 256;   // MaxExposurePageSize on spec 393
const OFFLINE_KINDS = new Set(['imOnline.SomeOffline']);

const big = (x) => { try { return x == null || x === '' ? null : BigInt(String(x)); } catch (e) { return null; } };
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${fmtInt(n)} ${Number(n) === 1 ? one : many}`;

export function formatPdex(planck) {
    const v = big(planck);
    if (v == null) return 'unknown';
    const neg = v < 0n; const a = neg ? -v : v;
    const whole = a / PLANCK;
    const frac = ((a % PLANCK) * 10_000n) / PLANCK;   // 4 decimals, truncated
    const f = frac ? '.' + String(frac).padStart(4, '0').replace(/0+$/, '') : '';
    return `${neg ? '-' : ''}${BigInt(whole).toLocaleString('en-US')}${f} PDEX`;
}

// Perbill to a percent string, integer math, up to 2 decimals.
export function perbillToPercent(perbill) {
    const v = big(perbill);
    if (v == null) return 'unknown';
    const hundredths = (v * 10_000n) / PERBILL;   // percent x 100
    const whole = hundredths / 100n, frac = hundredths % 100n;
    return `${whole}${frac ? '.' + String(frac).padStart(2, '0').replace(/0+$/, '') : ''}%`;
}

export function aboutDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `about ${d} d${h ? ` ${h} h` : ''}`;
    if (h) return `about ${h} h${m ? ` ${m} min` : ''}`;
    return `about ${Math.max(1, m)} min`;
}

const HEADLINES = {
    'not-bonded': { word: 'Not a validator', tone: 'neutral' },
    'bonded-no-keys': { word: 'No keys', tone: 'neutral' },
    'keys-not-validating': { word: 'Not validating', tone: 'neutral' },
    waiting: { word: 'Waiting', tone: 'neutral' },
    'elected-next': { word: 'Elected', tone: 'neutral' },
    active: { word: 'Active', tone: 'positive' },
    'active-leaving': { word: 'Leaving', tone: 'neutral' },
    disabled: { word: 'Disabled', tone: 'error' }
};

// f: { bonded, hasKeys, intent, inSession, inQueued, electedNext, disabled, activeEra, nextSessionIn }
export function deriveHeadline(f) {
    const era = f.activeEra == null ? 'unknown' : f.activeEra;
    let state, text;
    if (f.inSession && f.disabled) { state = 'disabled'; text = 'Disabled for the rest of this era after an offence.'; }
    else if (f.inSession && f.intent === false) { state = 'active-leaving'; text = `Active until era ${era} ends. Not standing for the next era.`; }
    else if (f.inSession) { state = 'active'; text = `Active in era ${era}.`; }
    else if (f.inQueued || f.electedNext) { state = 'elected-next'; text = `Elected. Starts validating next session, in ${aboutDuration(f.nextSessionIn)}.`; }
    else if (!f.bonded) { state = 'not-bonded'; text = 'This account is not a validator stash.'; }
    else if (!f.hasKeys) { state = 'bonded-no-keys'; text = 'Bonded. No session keys registered.'; }
    else if (f.intent === false) { state = 'keys-not-validating'; text = 'Keys registered. Not asking to validate.'; }
    else { state = 'waiting'; text = `Waiting. Not elected for era ${era}.`; }
    return { state, text, pill: { ...HEADLINES[state] } };
}

// Sprint 1 is read-only: no validator actions. The only primary is Connect
// wallet when nothing is connected (design section 5.2).
export function ctaFor(state, { connected = false } = {}) {
    if (!connected) return { label: 'Connect wallet', href: '/wallet?returnTo=%2Fvalidate' };
    return null;
}

const row = (id, label, text, word = '', tone = 'neutral') => ({ id, label, text, word, tone });
const lower = (x) => String(x == null ? '' : x).toLowerCase();

function keysRow(s, t) {
    if (!s.nextKeys) return row('keys', 'Keys', 'No session keys registered.', 'None');
    const next = lower(s.nextKeys.im_online);
    const queued = s.queuedKeys ? lower(s.queuedKeys.im_online) : null;
    if (s.inSession && s.activeImOnlineKey) {
        if (lower(s.activeImOnlineKey) === next) return row('keys', 'Keys', 'Registered keys match the keys in use.', 'Match');
        if (queued === next) return row('keys', 'Keys', `New keys registered. In use from session ${s.sessionIndex + 1} (${aboutDuration(t.nextSessionIn)}).`, 'Pending');
        return row('keys', 'Keys', `New keys registered. In use from session ${s.sessionIndex + 2} (${aboutDuration(t.nextSessionIn + t.sessionSeconds)}).`, 'Pending');
    }
    if (s.inQueued && queued === next) return row('keys', 'Keys', `Registered keys are queued for session ${s.sessionIndex + 1}.`, 'Queued');
    return row('keys', 'Keys', 'Registered. Used once this stash is elected.', 'Registered');
}

function onlineRow(s) {
    const L = 'Online this session';
    if (!s.imOnline) return row('online', L, 'The explorer cannot tell: this runtime has no imOnline module.', 'Unknown');
    if (!s.inSession) return row('online', L, 'Not in the active set this session.', 'Not active');
    if (s.heartbeat === true) return row('online', L, 'Heartbeat received.', 'Heartbeat received', 'positive');
    if (s.heartbeat == null && s.blocks == null) return row('online', L, 'Could not be read.', 'Unknown');
    if (Number(s.blocks) > 0) return row('online', L, `Authored ${plural(s.blocks, 'block', 'blocks')} this session.`, 'Online');
    if (Number(s.sessionProgress) < OFFLINE_PROGRESS) return row('online', L, 'Nothing seen yet (normal before 85% of the session).', 'Not seen yet');
    return row('online', L, 'No heartbeat and no block this session.', 'Offline');
}

function pointsRow(s) {
    const parts = [];
    if (s.points && s.points.points) parts.push(`Era points this era: ${fmtInt(s.points.points)} (rank ${s.points.rank} of ${s.points.of}).`);
    if (s.lastEra && s.lastEra.points) parts.push(`Last era: ${fmtInt(s.lastEra.points)} points${s.lastEra.reward ? `, about ${formatPdex(s.lastEra.reward)} in rewards` : ''}.`);
    return row('points', 'Era points', parts.length ? parts.join(' ') : 'No era points this era.');
}

function offencesRow(s) {
    const n = (s.incidents || []).filter(i => OFFLINE_KINDS.has(i.kind)).length;
    const lookback = Number(s.bondingDuration) || 28;
    const slashed = Number(s.lastSlashEra) > 0 && s.activeEra != null && Number(s.activeEra) - Number(s.lastSlashEra) <= lookback;
    const text = `${n ? `${plural(n, 'offline report', 'offline reports')} in the last 7 days.` : 'No offline reports in the last 7 days.'} ${slashed ? `Slashed in era ${s.lastSlashEra}.` : 'No slash.'}`;
    return slashed ? row('offences', 'Offences', text, 'Slashed', 'error') : row('offences', 'Offences', text, n ? 'Reported offline' : 'None');
}

function stakeRow(s, p) {
    const self = s.ledger ? big(s.ledger.active) : null;
    const min = big(p.minValidatorBond);
    const parts = [`Self stake: ${formatPdex(self)}.`];
    let word = '';
    if (self != null && min != null && self < min) { parts.push(`Below the minimum to validate (${formatPdex(min)}).`); word = 'Below minimum'; }
    if (s.exposure) {
        const total = big(s.exposure.total), own = big(s.exposure.own);
        if (total != null && own != null) parts.push(`Nominator stake: ${formatPdex(total - own)}.`);
        parts.push(`Total: ${formatPdex(total)}.`);
    } else parts.push('Not elected this era, so no exposure.');
    if (p.lowestElectedTotal != null) parts.push(`Lowest elected backing this era: ${formatPdex(p.lowestElectedTotal)}.`);
    if (!word && min != null) parts.push(`Minimum to validate: ${formatPdex(min)}.`);
    return row('stake', 'Stake', parts.join(' '), word);
}

function nominatorsRow(s) {
    if (!s.exposure) return row('nominators', 'Nominators', 'Counted at election: known once elected.');
    const n = Number(s.exposure.nominatorCount) || 0;
    const pages = s.exposure.pageCount != null ? Number(s.exposure.pageCount) : Math.ceil(n / PAGE_SIZE);
    return row('nominators', 'Nominators', `${plural(n, 'nominator', 'nominators')}, ${plural(pages, 'payout page', 'payout pages')}.`);
}

function commissionRow(s, p) {
    if (!s.prefs) return row('commission', 'Commission', 'Not set: this stash is not asking to validate.');
    const parts = [`${perbillToPercent(s.prefs.commission)}.`];
    if (p.minCommission != null) parts.push(`Minimum on Polkadex: ${perbillToPercent(p.minCommission)}.`);
    if (p.medianCommission != null) parts.push(`Median of active validators: ${perbillToPercent(p.medianCommission)}.`);
    if (s.prefs.blocked) parts.push('Blocked: accepts no new nominations.');
    return row('commission', 'Commission', parts.join(' '), s.prefs.blocked ? 'Blocked' : '');
}

function identityRow(s) {
    const id = s.identity;
    if (!id || !id.name || id.name === 'Unknown') return row('identity', 'Identity', 'No on-chain identity.', 'None');
    const j = (id.judgements || []).filter(Boolean);
    return row('identity', 'Identity', `${id.name}. ${j.length ? `Judgement: ${j.join(', ')}.` : 'No registrar judgement.'}`);
}

function accessRow(s) {
    const own = !s.controller || s.controller === s.address;
    const parts = [own ? 'The stash is its own controller.' : `Controlled by ${s.controller} (an older setup).`];
    const proxies = s.proxies || [];
    parts.push(proxies.length ? proxies.map(x => `${x.type} proxy: ${x.delegate}.`).join(' ') : 'No proxies.');
    return row('access', 'Access', parts.join(' '), own ? '' : 'Legacy controller');
}

export function validatorStatusModel(s = {}, p = {}) {
    const sessionSeconds = (Number(s.epochDuration) || 1200) * (Number(s.blockTimeMs) || 12000) / 1000;
    const progress = Number.isFinite(Number(s.sessionProgress)) ? Number(s.sessionProgress) : 0;
    const nextSessionIn = Math.round((1 - progress) * sessionSeconds);
    const intoEra = s.sessionIndex != null && s.eraStartSession != null ? Number(s.sessionIndex) - Number(s.eraStartSession) : null;
    const endsIn = intoEra == null ? null : Math.max(0, ((Number(s.sessionsPerEra) || 6) - intoEra - progress) * sessionSeconds);
    const h = deriveHeadline({ bonded: !!s.bonded, hasKeys: !!s.nextKeys, intent: s.intent, inSession: !!s.inSession, inQueued: !!s.inQueued,
        electedNext: !!s.nextExposure, disabled: !!s.disabled, activeEra: s.activeEra, nextSessionIn });
    const t = { nextSessionIn, sessionSeconds };
    const rows = h.state === 'not-bonded' ? [identityRow(s)] : [
        keysRow(s, t), onlineRow(s), pointsRow(s), offencesRow(s), stakeRow(s, p), nominatorsRow(s), commissionRow(s, p), identityRow(s), accessRow(s)
    ];
    return {
        address: s.address, state: h.state, headline: h.text, pill: h.pill, rows,
        era: { active: s.activeEra ?? null, current: s.currentEra ?? null, endsIn },
        session: { index: s.sessionIndex ?? null, progress, nextIn: nextSessionIn },
        limits: { minValidatorBond: p.minValidatorBond ?? null, minCommission: p.minCommission ?? null, maxValidatorsCount: p.maxValidatorsCount ?? null }
    };
}
