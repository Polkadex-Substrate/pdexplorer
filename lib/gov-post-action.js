// R4: the council, democracy and treasury pages after an action (design cto-team/plans/2026-11-22-post-action-
// refresh-design.md, sections 3 to 5 and 9 "R4"; UX cto-team/plans/2026-11-22-post-action-refresh-ux.md,
// sections 1 to 5 and 9). DOM-light: pure builders, one indicator per page card, and the subscriptions.
//
// Each page subscribes the post-action core (lib/post-action.js) to the domains it draws (GOV_PAGES), for the
// account connected while it is on screen. A poll attempt re-reads the page's own route with ?fresh=1 through
// the page's fetch function (script.js), which redraws what changed and hands back the server's freshness
// (freshness.kv.X: the snapshot's atBlock); the core stops when that reaches the inclusion block. Nothing runs
// on a timer of its own.
//
// What the block proves is drawn at once, in its final form (SET, UX section 9), on top of whatever the server
// returns until the server has caught up (electionsOverlay): a candidacy once the chain predicate agrees
// (readCandidacy: elections.candidates holds the account; the pallet emits no event), a withdrawal from
// Renounced. A member's seat may pass to a runner-up, which the events do not say: the seat lists then wait for
// the server under "Updating" and only the role changes at once.
//
// The indicator (createRefreshIndicator): S1 "Updating" in the card header after T1, kept at least T2; S11 with
// "Reload this section" (S12, S13 while busy, S16 when it still cannot) when the poll gives up; S17 while a
// replaced block's result is withdrawn. One accent per card (U14). It belongs to the account it was raised for:
// another account on screen clears it (U13).

import { STRINGS, REFRESH_UI, say, nounFor } from './refresh-ui.js';
import { linePanelHtml, icon } from './ui-parts.js';
import { caughtUp as caughtUpDefault } from './freshness.js';
import { resolveElectionsPallet } from './collective-live.js';
import { escapeHtml } from './html-escape.js';

export const ELECTIONS = 'council.elections';
export const GOV_PAGES = Object.freeze({
    council: Object.freeze(['council.motions', 'council.elections', 'technicalCommittee.motions']),
    democracy: Object.freeze(['democracy']),
    treasury: Object.freeze(['treasury.overview'])
});
const NAMES = Object.freeze({ council: 'Council', democracy: 'Democracy', treasury: 'Treasury' });
const HOSTS = Object.freeze({
    council: { header: '.council-page-header h2', card: '.council-page .list-container' },
    democracy: { header: '#democracy-content .list-header h2', card: '#democracy-content .list-container' },
    treasury: { header: '#treasury-content .list-header h2', card: '#treasury-content .list-container' }
});
const eq = (a, b) => a === b;

// The proven council role on top of /api/council. entries: the store's 'set' role entries of this account
// that the server has not caught up with; verified: entry id -> { ok, stake } from readCandidacy.
export function electionsOverlay(data, account, entries, { same = eq, verified = new Map() } = {}) {
    if (!data || typeof data !== 'object' || data.error || account == null) return data;
    const mine = (Array.isArray(entries) ? entries : []).filter(e => e && e.op === 'set' && e.key === 'role' && e.account != null && same(e.account, account) && e.value);
    if (!mine.length) return data;
    const e = mine.slice().sort((a, b) => b.savedAt - a.savedAt)[0];
    const v = e.value;
    const isMe = (r) => !!r && r.address != null && same(String(r.address), account);
    const list = (k) => (Array.isArray(data[k]) ? data[k] : []);
    if (v.role === 'Candidate') {
        const ok = verified.get(e.id);
        if (!ok || !ok.ok) return data;
        if (['members', 'runnersUp', 'candidates'].some(k => list(k).some(isMe))) return data;
        return { ...data, candidates: [...list('candidates'), { address: account, stake: ok.stake }] };
    }
    if (v.role === null) {
        const out = { ...data, __myRole: null };
        if (v.from === 'Candidate') out.candidates = list('candidates').filter(r => !isMe(r));
        if (v.from === 'RunnerUp') out.runnersUp = list('runnersUp').filter(r => !isMe(r));
        return out;
    }
    return data;
}

// The council page reads two snapshots; the technical committee's mark comes from its own route.
export function mergeCouncilFreshness(fc, ftc) {
    if (!fc || typeof fc !== 'object') return null;
    const tc = ftc && ftc.kv && typeof ftc.kv === 'object' ? ftc.kv.technicalCommittee : null;
    return { ...fc, kv: { ...(fc.kv && typeof fc.kv === 'object' ? fc.kv : {}), technicalCommittee: tc == null ? null : tc } };
}

// The candidacy predicate, read from the browser's node: is the account in elections.candidates, and with what
// deposit (PDEX, 12 decimals)? A failed read throws: it is not an answer.
export async function readCandidacy(api, account, same = eq) {
    const pallet = resolveElectionsPallet(api);
    const q = pallet && api.query[pallet];
    if (!q || typeof q.candidates !== 'function') return { ok: false };
    const raw = await q.candidates();
    const rows = raw && typeof raw.toJSON === 'function' ? raw.toJSON() : raw;
    for (const row of Array.isArray(rows) ? rows : []) {
        const who = Array.isArray(row) ? row[0] : row && (row.who || row.address);
        if (who == null || !same(String(who), account)) continue;
        const dep = Array.isArray(row) ? row[1] : row.deposit;
        let stake = 0;
        try { stake = Number(BigInt(dep == null ? 0 : dep)) / 1e12; } catch (e) { stake = 0; }
        return { ok: true, stake };
    }
    return { ok: false };
}

// The shared polite region (UX section 4): at most one message per T7, later ones merge.
function announcer(doc, now) {
    let last = { at: -Infinity, text: '' };
    return (text) => {
        if (!text) return;
        let el = doc.getElementById('post-action-live');
        if (!el) {
            el = doc.createElement('div');
            el.id = 'post-action-live'; el.className = 'sr-only';
            el.setAttribute('aria-live', 'polite'); el.setAttribute('aria-atomic', 'true');
            doc.body.appendChild(el);
        }
        const t = now();
        const merge = t - last.at < REFRESH_UI.announceGapMs;
        last = { at: merge ? last.at : t, text: merge ? `${last.text} ${text}` : text };
        el.textContent = last.text;
    };
}
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function createRefreshIndicator({ doc, page, name, hosts, account = () => null, same = eq, check = caughtUpDefault, reload = async () => null,
    now = Date.now, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), announce = announcer(doc, now) }) {
    const ids = { chip: `gov-refresh-chip-${page}`, line: `gov-refresh-line-${page}`, btn: `gov-refresh-reload-${page}` };
    let st = 'current', owner = null, info = null, shownAt = null, t1 = null, t2 = null, noun = null, failedAt = null, busy = false;
    const stop = (t) => { if (t != null) { try { clearTimer(t); } catch (e) { /* gone */ } } };
    const mine = () => owner == null || (account() != null && same(account(), owner));
    function reset() { stop(t1); stop(t2); t1 = t2 = null; st = 'current'; owner = null; info = null; shownAt = null; noun = null; failedAt = null; }

    function lineHtml(kind) {
        if (kind === 'reorg') return linePanelHtml('is-warn', 'bx-error', escapeHtml(say('S17', { payout: noun })), ` id="${ids.line}" data-kind="reorg"`);
        const text = failedAt != null ? say('S16', { 'HH:MM': hhmm(failedAt) }) : STRINGS.S11;
        return linePanelHtml('is-warn', 'bx-error', `<span class="gov-refresh-text">${escapeHtml(text)}</span> <button type="button" class="validate-secondary" id="${ids.btn}">${escapeHtml(STRINGS.S12)}</button>`,
            ` id="${ids.line}" data-kind="cnr"`);
    }
    function paint() {
        if (!mine()) reset();
        const header = doc.querySelector(hosts.header), card = doc.querySelector(hosts.card);
        const kind = noun ? 'reorg' : st === 'cnr' ? 'cnr' : null;   // U14: S17, then S11, then S1
        const chipOn = !kind && ((st === 'updating' && shownAt != null) || t2 != null);
        const chip = doc.getElementById(ids.chip);
        if (chipOn && !chip && header) header.insertAdjacentHTML('beforeend', ` <span class="ui-chip is-wait" id="${ids.chip}">${icon('bx-loader-alt bx-spin')}${escapeHtml(STRINGS.S1)}</span>`);
        if (!chipOn && chip) chip.remove();
        const old = doc.getElementById(ids.line);
        if (old && (!kind || old.getAttribute('data-kind') !== kind)) old.remove();
        if (kind && !doc.getElementById(ids.line) && card) {
            const first = card.firstElementChild;
            if (first && first.classList.contains('list-header')) first.insertAdjacentHTML('afterend', lineHtml(kind));
            else card.insertAdjacentHTML('afterbegin', lineHtml(kind));
            const btn = doc.getElementById(ids.btn);
            if (btn) btn.addEventListener('click', onReload);
        }
        if (kind === 'cnr' && !busy) {
            const text = doc.querySelector(`#${ids.line} .gov-refresh-text`);
            const want = failedAt != null ? say('S16', { 'HH:MM': hhmm(failedAt) }) : STRINGS.S11;
            if (text && text.textContent !== want) text.textContent = want;
        }
    }
    function set(s, i = {}) {
        if (s === 'updating') {
            if (st === 'updating') return;
            st = 'updating'; owner = account(); info = i; failedAt = null;
            stop(t1);
            t1 = setTimer(() => { t1 = null; if (st === 'updating') { shownAt = now(); paint(); } }, REFRESH_UI.showDelayMs);
            return;
        }
        if (s === 'current') {
            stop(t1); t1 = null;
            const was = shownAt;
            st = 'current'; info = null; shownAt = null; failedAt = null;
            if (was != null) {
                if (now() - was >= REFRESH_UI.quietAnnounceMs) announce(say('A3', { 'Section name': name }));
                const left = REFRESH_UI.minVisibleMs - (now() - was);
                if (left > 0) { stop(t2); t2 = setTimer(() => { t2 = null; paint(); }, left); }
            }
            paint();
            return;
        }
        if (s === 'could-not-refresh') {
            stop(t1); t1 = null; stop(t2); t2 = null;
            st = 'cnr'; owner = account(); info = i; shownAt = null;
            announce(say('A4', { 'Section name': name }));
            paint();
        }
    }
    async function onReload() {
        if (busy) return;
        const btn = doc.getElementById(ids.btn);
        busy = true;
        if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.innerHTML = `${icon('bx-loader-alt bx-spin')}${escapeHtml(STRINGS.S13)}`; }
        const started = now();
        let f = null;
        try { f = await reload({ reason: 'user' }); } catch (e) { f = null; }
        const wait = 400 - (now() - started);
        if (wait > 0) await new Promise(r => setTimer(r, wait));
        busy = false;
        const domains = info && Array.isArray(info.gaveUp) && info.gaveUp.length ? info.gaveUp : (info && info.domains) || [];
        const ok = !!f && domains.every(d => { try { return !!check(d, f, info.block); } catch (e) { return false; } });
        if (ok) {
            st = 'current'; info = null; failedAt = null;
            paint();
            announce(say('A5', { 'Section name': name }));
            const h = doc.querySelector(hosts.header);
            if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
            return;
        }
        failedAt = now();
        const b = doc.getElementById(ids.btn);
        if (b) { b.removeAttribute('aria-disabled'); b.textContent = STRINGS.S12; }
        paint();
        if (b) b.focus();
    }
    function reorg(n) {
        const next = n || null;
        if (next && !noun) { if (owner == null) owner = account(); announce(say('A6', { payout: next })); }
        noun = next;
        paint();
    }
    return { set, paint, reorg, reset, state: () => st };
}

// The pages' subscriptions. pages[page](opts) re-reads that page (opts.fresh: ?fresh=1) and resolves to the
// server's freshness (the council page: [council, technical committee]); script.js owns the drawing.
export function createGovRefresh({ doc, post, known, same = eq, selected = () => null, api = () => null, onPage = () => false, pages = {},
    caughtUp = caughtUpDefault, now = Date.now, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), verifyTimeoutMs = 5000 }) {
    const verified = new Map();   // known-result id -> { ok, stake }: the candidacy predicate's definitive answers
    let verifying = null;
    const announce = announcer(doc, now);
    const accountOn = (page) => (onPage(page) ? (selected() || null) : null);
    const ind = {};
    const roleEntries = (account, freshness) => (account == null ? [] : known.list(ELECTIONS, account)
        .filter(e => e.op === 'set' && e.key === 'role' && !(freshness && e.block != null && caughtUp(ELECTIONS, freshness, e.block))));
    const unverified = (account) => roleEntries(account, null).filter(e => e.value && e.value.role === 'Candidate' && !verified.has(e.id));

    // The predicate for every candidacy of the shown account not answered yet; bounded, so a node that does not
    // answer never stalls a poll. Resolves to true when a new answer was recorded.
    function verify() {
        if (verifying) return verifying;
        const account = selected();
        const todo = unverified(account);
        const a = api();
        if (!todo.length || !a || account == null) return Promise.resolve(false);
        let timer = null;
        verifying = Promise.race([
            readCandidacy(a, account, same),
            new Promise((resolve) => { timer = setTimer(() => resolve(null), verifyTimeoutMs); })
        ]).then((r) => {
            if (!r) return false;
            for (const e of todo) verified.set(e.id, r);
            return true;
        }, () => false).finally(() => { if (timer != null) clearTimer(timer); verifying = null; });
        return verifying;
    }
    function reorgNoun(page) {
        if (page !== 'council') return null;
        const account = selected();
        if (account == null) return null;
        const t = now();
        const m = known.list(ELECTIONS, account).filter(e => e.op === 'reorg' && t - e.savedAt < (known.holdMs || 180_000)).sort((a, b) => b.savedAt - a.savedAt)[0];
        return m ? nounFor(m.value) : null;
    }
    function paint(page) { const i = ind[page]; if (!i) return; i.reorg(reorgNoun(page)); i.paint(); }
    async function read(page, opts) {
        const r = await pages[page](opts);
        return Array.isArray(r) ? mergeCouncilFreshness(r[0], r[1]) : (r && typeof r === 'object' ? r : null);
    }
    async function reload(page) {
        if (!onPage(page) || typeof pages[page] !== 'function') { if (ind[page]) ind[page].reset(); return null; }
        if (page === 'council') await verify();
        let f = null;
        try { f = await read(page, { fresh: true }); } catch (e) { f = null; }
        paint(page);
        return f;
    }
    for (const page of Object.keys(GOV_PAGES)) {
        ind[page] = createRefreshIndicator({ doc, page, name: NAMES[page], hosts: HOSTS[page], account: () => accountOn(page), same, check: caughtUp,
            reload: () => reload(page), now, setTimer, clearTimer, announce });
        post.subscribe(GOV_PAGES[page].slice(), {
            account: () => accountOn(page),
            reload: () => reload(page),
            state: (s, info) => { if (onPage(page)) ind[page].set(s, info); }
        });
    }
    return {
        // The council page's data with the proven role applied; a candidacy whose predicate is not read yet is
        // read in the background and the page drawn again when it holds.
        overlay(page, data) {
            if (page !== 'council' || !data || typeof data !== 'object' || data.error) return data;
            const account = selected();
            if (unverified(account).length && api()) {
                verify().then((fresh) => { if (fresh && onPage('council') && typeof pages.council === 'function') pages.council({}); }, () => {});
            }
            const out = electionsOverlay(data, account, roleEntries(account, data.freshness), { same, verified });
            paint('council');
            return out;
        },
        paint
    };
}
