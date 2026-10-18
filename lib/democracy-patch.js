// In-place updates of the Democracy page (browser side, no DOM access except
// patchDemocracyCells, which is handed a root element).
//
// lib/democracy-live.js delivers chain state every block. Redrawing the page
// on each delivery would reset the referenda table's sort, search, paging and
// scroll, so the page is drawn from a frame: a "shape" (tab, filter, which
// referenda or proposals exist and their status) plus the html of each cell
// that can change in place (tallies, turnout, the vote cell, seconds,
// deposit, the Second button). democracyPatchPlan compares two frames: a
// changed shape is a full render (a new referendum, one that ended, a
// proposal tabled); otherwise only the changed cells are replaced.
//
// overlayDemocracy merges the live state over the REST snapshot into row
// objects that stay the same objects across renders (newRowCache), so the
// table, which keeps the rows it was given, sorts on current values.
//
// The vote and Second cells carry the in-flight feedback of the explorer's
// own transactions (demPendingStage / demPendingSettled), the democracy
// counterpart of the council motion cards.

import { pendingChipText, BUTTON_STAGE_TEXT } from './tx-status.js';

const isIndex = (i) => (typeof i === 'number' && Number.isInteger(i) && i >= 0) || (typeof i === 'string' && /^\d+$/.test(i));

export function newRowCache() { return { refs: new Map(), props: new Map() }; }

function rowFor(map, key) {
    let row = map.get(key);
    if (!row) map.set(key, row = {});
    return row;
}
// Refill a cached row in place: its identity is what the table holds.
function refill(row, ...sources) {
    for (const k of Object.keys(row)) delete row[k];
    for (const s of sources) if (s) Object.assign(row, s);
    return row;
}
function prune(map, keep) { for (const k of Array.from(map.keys())) if (!keep.has(k)) map.delete(k); }

const LIVE_REF_FIELDS = ['status', 'endBlock', 'ayes', 'nays', 'turnout', 'tallyKnown', 'cancelled'];
const TALLY_FIELDS = ['ayes', 'nays', 'turnout', 'tallyKnown'];

// rest: the /api/democracy payload. live: the feed state, or null while the
// node link is down (then REST is the truth). cache: newRowCache().
export function overlayDemocracy(rest, live, cache) {
    if (!rest) return null;
    const L = live && live.available !== false ? live : null;
    const liveRefs = (L && L.refs) || {};
    const refs = [];
    const seenRefs = new Set();
    for (const r of Array.isArray(rest.referenda) ? rest.referenda : []) {
        if (!r || seenRefs.has(r.refIndex)) continue;
        seenRefs.add(r.refIndex);
        const lr = liveRefs[r.refIndex];
        let patch = null;
        if (lr) {
            patch = {};
            for (const k of LIVE_REF_FIELDS) if (lr[k] !== undefined) patch[k] = lr[k];
            // A referendum the feed only saw finished has no tally; keep REST's.
            if (!lr.tallyKnown && r.tallyKnown) for (const k of TALLY_FIELDS) delete patch[k];
        }
        refs.push(refill(rowFor(cache.refs, r.refIndex), r, patch));
    }
    for (const lr of Object.values(liveRefs)) {
        if (!lr || seenRefs.has(lr.refIndex)) continue;
        seenRefs.add(lr.refIndex);
        refs.push(refill(rowFor(cache.refs, lr.refIndex), lr));
    }
    prune(cache.refs, seenRefs);

    const restProps = (Array.isArray(rest.publicProposals) ? rest.publicProposals : []).filter(Boolean);
    let props;
    const liveProps = L && Array.isArray(L.props);
    if (liveProps) {
        const byIndex = new Map(restProps.map(p => [Number(p.index), p]));
        props = L.props.map(lp => {
            const dep = L.deposits && L.deposits[lp.index];
            return refill(rowFor(cache.props, lp.index), byIndex.get(lp.index) || { index: lp.index, proposer: lp.proposer, proposal: lp.proposal },
                dep ? { seconds: dep.seconds, deposit: dep.deposit } : null);
        });
    } else props = restProps.map(p => refill(rowFor(cache.props, Number(p.index)), p));
    prune(cache.props, new Set(props.map(p => Number(p.index))));

    const nextProp = props.reduce((m, p) => Math.max(m, (Number(p.index) || 0) + 1), 0);
    return {
        ...rest,
        referenda: refs,
        publicProposals: props,
        activeReferenda: L ? refs.filter(r => r.status === 'Ongoing').length : rest.activeReferenda,
        activeProposals: liveProps ? props.length : rest.activeProposals,
        referendumCount: Math.max(Number(rest.referendumCount) || 0, (L && Number(L.count)) || 0),
        publicPropCount: Math.max(Number(rest.publicPropCount) || 0, nextProp)
    };
}

// h = { pdex(v), num(v), esc(s), pending(key) -> entry|null, myVote(refIndex) -> vote|null }
export function democracyCells(h) {
    const dash = '<span style="color:var(--text-muted);">&mdash;</span>';
    const spin = `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i>`;
    const feedback = (p) => {
        if (!p) return '';
        if (p.error) return `<div class="motion-tx-error" role="alert">${h.esc(p.error)}</div>`;
        const text = p.kind === 'second' ? 'Your second is being recorded' : pendingChipText(p.kind);
        return `<div class="motion-pending-chip">${spin} ${h.esc(text)}</div>`;
    };
    const stageText = (p) => BUTTON_STAGE_TEXT[p.stage] || BUTTON_STAGE_TEXT.signing;

    const voteCell = (row, i) => {
        if (row.status !== 'Ongoing') return dash;
        const p = h.pending('ref:' + i);
        const busy = !!p && !p.error;
        const btn = (side, label, color, border) => {
            const pressed = busy && p.kind === side;
            return `<button type="button" class="referendum-vote-trigger reward-filter-btn" data-ref-index="${i}" data-side="${side}" style="padding:4px 10px;font-size:0.78rem;color:${color};border-color:${border};" title="Vote ${label}"${busy ? ' disabled' : ''}${pressed ? ' aria-busy="true"' : ''}>${pressed ? spin + ' ' + h.esc(stageText(p)) : label}</button>`;
        };
        const mine = h.myVote(Number(i));
        let you = '';
        if (mine && mine.split) you = `You split ${h.pdex(mine.balance)} PDEX`;
        else if (mine) you = `You voted ${mine.aye ? 'Aye' : 'Nay'}${mine.balance ? ` with ${h.pdex(mine.balance)} PDEX` : ''}${mine.conviction ? ` (${h.esc(mine.conviction)})` : ''}`;
        return `<div style="display:flex;gap:4px;white-space:nowrap;">${btn('aye', 'Aye', 'var(--success)', 'rgba(46,204,113,0.4)')}${btn('nay', 'Nay', '#e74c3c', 'rgba(231,76,60,0.4)')}</div>`
            + (you ? `<div class="motion-meta" style="font-size:0.75rem;">${you}</div>` : '') + feedback(p);
    };
    const secondCell = (row, i) => {
        const p = h.pending('prop:' + i);
        const busy = !!p && !p.error;
        return `<button type="button" class="reward-filter-btn democracy-second-btn" data-prop-index="${i}" data-seconds="${Number(row.seconds) || 0}" style="padding:4px 10px;font-size:0.78rem;" title="Second this proposal (locks the same deposit as the proposer)"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? spin + ' ' + h.esc(stageText(p)) : 'Second'}</button>` + feedback(p);
    };

    const PARTS = {
        ref: {
            tally: (row) => (row.tallyKnown ? `${h.pdex(row.ayes)} / ${h.pdex(row.nays)}` : dash),
            turnout: (row) => (row.tallyKnown ? h.pdex(row.turnout) : dash),
            vote: (row, i) => voteCell(row, i)
        },
        prop: {
            seconds: (row) => h.num(row.seconds),
            deposit: (row) => `${h.pdex(row.deposit)} PDEX`,
            action: (row, i) => secondCell(row, i)
        }
    };
    return {
        parts: { ref: Object.keys(PARTS.ref), prop: Object.keys(PARTS.prop) },
        // The cell's html, wrapped so the patcher can find it again.
        cell(kind, row, part) {
            const i = row && (kind === 'ref' ? row.refIndex : row.index);
            const fn = PARTS[kind] && PARTS[kind][part];
            if (!fn || !isIndex(i)) return '';
            return `<span data-dem-cell="${kind}:${Number(i)}:${part}">${fn(row, Number(i))}</span>`;
        }
    };
}

// tab: 'overview' | 'referenda' | 'proposals' | 'statistics'. extra: the
// pill filter or sort key in force, so a change of it is a full render.
export function democracyFrame(tab, d, cells, extra = '') {
    const refs = (d && d.referenda) || [];
    const props = (d && d.publicProposals) || [];
    const refShape = refs.map(r => r.refIndex + ':' + r.status).join(',');
    const head = [tab, String(extra), d ? String(d.status) : ''].join('|');
    const out = { tab, shape: '', cells: {} };
    const add = (kind, row) => { for (const part of cells.parts[kind]) { const html = cells.cell(kind, row, part); if (html) out.cells[`${kind}:${Number(kind === 'ref' ? row.refIndex : row.index)}:${part}`] = html; } };
    if (tab === 'referenda') { out.shape = head + '|' + refShape; refs.forEach(r => add('ref', r)); }
    else if (tab === 'proposals') { out.shape = head + '|' + props.map(p => p.index).join(','); props.forEach(p => add('prop', p)); }
    else if (tab === 'statistics') out.shape = head + '|' + refShape;
    else out.shape = head + '|' + (d ? [d.referendumCount, d.publicPropCount, d.activeReferenda, d.activeProposals, d.currentBlock, d.externalProposal ? 1 : 0].join(',') : '');
    return out;
}

export function democracyPatchPlan(prev, next) {
    if (!prev || !next || prev.shape !== next.shape) return { full: true };
    const changed = Object.keys(next.cells).filter(k => prev.cells[k] !== next.cells[k]);
    return { full: false, changed };
}

// Replace the inner html of the changed cells. A cell that is not in the DOM
// (its row is on another page of the table, or filtered out) is skipped: the
// row object already holds the new values for when it is drawn. Returns the
// number of elements patched.
const KEY = /^(ref|prop):\d+:[a-z]+$/;
export function patchDemocracyCells(root, changed, cells) {
    let n = 0;
    for (const key of changed || []) {
        if (!KEY.test(key)) continue;
        let html = String(cells[key] || '');
        const open = `<span data-dem-cell="${key}">`;
        if (html.startsWith(open) && html.endsWith('</span>')) html = html.slice(open.length, -'</span>'.length);
        for (const el of Array.from(root.querySelectorAll(`[data-dem-cell="${key}"]`))) { el.innerHTML = html; n++; }
    }
    return n;
}

// The row's half of a vote or second in flight, keyed 'ref:N' or 'prop:N'.
// Cancelled, stalled, unconfirmed, waiting and resent clear it; a failure
// keeps its reason until the next attempt. Returns true on In block, when the
// page should ask the server for a fresh copy.
const STAGE_CLEARS = new Set(['cancelled', 'stalled', 'unconfirmed', 'waiting', 'resent']);
export function demPendingStage(map, key, kind, stage, m) {
    if (STAGE_CLEARS.has(stage)) map.delete(key);
    else map.set(key, stage === 'failed' ? { kind, stage, error: (m && m.text) || 'The transaction failed.' } : { kind, stage });
    return stage === 'inBlock';
}

// A vote is settled when it is in a block and the account's voting record
// shows that side (so a change from Nay to Aye is not settled by the old
// Nay), or once Finalized; a second once it is in a block (the seconds count
// updates live).
export function demPendingSettled(p, myVote) {
    if (!p) return true;
    if (p.error) return false;
    if (p.stage === 'finalized') return true;
    const landed = p.stage === 'inBlock';
    if (p.kind === 'second') return landed;
    if (myVote && typeof myVote.aye === 'boolean') return landed && myVote.aye === (p.kind === 'aye');
    return false;
}

// democracy.second(proposal) on current runtimes; older ones also take an
// upper bound on the proposal's current seconds (for the weight).
export function buildSecondTx(api, index, seconds) {
    const f = api && api.tx && api.tx.democracy && api.tx.democracy.second;
    if (typeof f !== 'function') throw new Error('Seconding is not available on this runtime.');
    const n = f.meta && f.meta.args ? f.meta.args.length : 1;
    return n >= 2 ? f(index, (Number(seconds) || 0) + 1) : f(index);
}
