// My Account after a stake (WP4 of design 2026-11-22-stake-card-simple-and-advanced.md, section 6 state 20; UX
// spec 2026-11-22-post-action-refresh-ux.md, sections 0, 2, 5 and 9: balances SWAP, nominations SWAP plus LATER).
//
// After a staking action of the Stake card (staking.bondNominate: a first stake, an addition, a change of validators
// or of where rewards go) is in a block with clean events, the post-action core (lib/post-action.js) tells this
// component. It reads the account from the chain (readStakeFigures, the same fields /api/wallet serves) and changes,
// in place, what My Account shows of it: Total Balance and Total Staked with the neutral wash, the Stake button's
// words (SC-150, SC-151), the My Validators list, and the "Your validators" card (its own re-read, which keeps
// today's "count from the next election" wording). Nothing is remounted, and nothing changes for a transaction that
// failed, was dropped or usurped, never reached a block, or ended without proof (processed, unverified): the core
// tells this component only about an inclusion, and a withdrawal (reorg, or failed after a block) puts back the
// figures the page had before, with the same wash. A read that returns a block older than the inclusion is not drawn.
// This file adds no timer: the core's own poll asks again, and its deadline marks the tile "May be behind" (S14).
//
// While the action is tracked (in a block, and the server's copy has not caught up yet, at most the chain poll
// deadline), tracked(address) gives its block: the card shows SC-141 when it is opened again. adopt(payload) takes
// the server's later copy in place when it differs from the page only in what this file paints (and opens or closes
// Send and Unstake to match it).

import { balanceBreakdown, accountBalances, sendableBalance } from './balance-locks.js';
import { caughtUp, pollDeadlineMs, samePayload } from './freshness.js';
import { STAKE_COPY } from './stake-plan.js';
import { chipHtml, linePanelHtml } from './ui-parts.js';
import { STRINGS } from './refresh-ui.js';

export const STAKE_KEY = 'staking.bondNominate';
// The action bar's gates as script.js draws them (renderWalletDashboard), with today's titles.
const GATES = [
    { id: 'wallet-act-send', key: 'send', on: (d) => sendableBalance(d) > 0, title: 'No transferable balance available.' },
    { id: 'wallet-act-unstake', key: 'unstake', on: (d) => Number((d.staking || {}).activeStaked || 0) > 0, title: 'No active bond to unstake.' }
];
export const STAKE_DOMAINS = Object.freeze(['balance', 'staking.ledger', 'staking.nominations']);

// planck (u128 as text or codec) to a PDEX number, exactly as server.js formatPDEX does for /api/wallet.
export function pdexOf(balance) {
    try {
        const planck = BigInt(String(balance == null ? 0 : balance.toString()));
        return Number(planck / 1000000000000n) + Number(planck % 1000000000000n) / 1e12;
    } catch (e) { return Number(balance) / 1e12; }
}
const some = (o) => (o && typeof o.isSome === 'boolean' ? (o.isSome ? o.unwrap() : null) : o || null);

// The account's balance and stake from the chain, in the shape of /api/wallet's balance and staking blocks (the
// fields the page reads), plus the block the read saw. Throws when a read fails.
export async function readStakeFigures(api, address) {
    const q = api.query;
    const [account, bondedOpt, nominatorsOpt, number] = await Promise.all([q.system.account(address), q.staking.bonded(address),
        q.staking.nominators(address), q.system.number ? q.system.number() : null]);
    const bonded = some(bondedOpt);
    const controller = bonded ? String(bonded) : address;
    const ledger = some(await q.staking.ledger(controller));
    const spendable = balanceBreakdown(accountBalances(account.data, api.consts.balances && api.consts.balances.existentialDeposit));
    const free = pdexOf(account.data.free), reserved = pdexOf(account.data.reserved);
    const totalStaked = ledger ? pdexOf(ledger.total) : 0;
    const nominators = some(nominatorsOpt);
    const targets = nominators ? Array.from(nominators.targets || []).map(t => String(t)) : [];
    return {
        block: number == null ? null : Number(number.toString()),
        balance: { free, reserved, total: free + reserved, transferable: pdexOf(spendable.transferable), transferableAllowDeath: pdexOf(spendable.transferableAllowDeath) },
        staking: { isStaker: totalStaked > 0, isNominator: targets.length > 0, totalStaked, activeStaked: ledger ? pdexOf(ledger.active) : 0,
            activeStakedPlanck: ledger ? String(ledger.active.toString()) : '0',
            unlocking: ledger ? Array.from(ledger.unlocking || []).reduce((t, u) => t + pdexOf(u.value), 0) : 0,
            nominating: targets, ledgerRead: 'ok', controller: bonded ? controller : null }
    };
}

// The page's payload with the figures read from the chain. A validator already named on the page keeps its name.
export function withFigures(data, fig, same = (a, b) => a === b) {
    const old = (data && data.staking) || {};
    const named = (a) => { const v = (old.nominating || []).find(x => same(x.address, a)); return { address: a, name: v ? v.name : null }; };
    const staking = { ...old, ...fig.staking };
    if (Array.isArray(fig.staking.nominating)) staking.nominating = fig.staking.nominating.map(v => (typeof v === 'string' ? named(v) : v));
    return { ...data, balance: { ...(data && data.balance), ...fig.balance }, staking };
}

// My Account's Stake button (SC-150 with no stake, SC-151 with one; a stake that could not be read is not called none).
export function stakeButtonHtml(staking, esc) {
    const st = staking || {};
    const [a, b] = Number(st.totalStaked) > 0 || st.ledgerRead === 'failed' ? ['SC-151', 'SC-151s'] : ['SC-150', 'SC-150s'];
    return `<button class="wallet-action-btn" id="wallet-act-stake"><i class='bx bx-plus-circle'></i>`
        + `<div><strong data-sc="${a}">${esc(STAKE_COPY[a])}</strong><span data-sc="${b}">${esc(STAKE_COPY[b])}</span></div></button>`;
}
const stakedText = (data, pdex, esc) => { const st = (data && data.staking) || {}; return st.ledgerRead === 'failed' ? esc(STAKE_COPY['SC-109']) : `${pdex(st.totalStaked)} PDEX`; };
// The Total Staked tile (a failed ledger read says so, never 0).
export function stakedTileHtml(data, { pdex, esc }) {
    return `<div class="staking-summary-card"><div class="label" id="wallet-staked-label">Total Staked</div><div class="value" id="wallet-staked-value">${stakedText(data, pdex, esc)}</div></div>`;
}
// The My Validators list, today's markup.
export function myValidatorsHtml(nominating, { esc, short }) {
    const list = nominating || [];
    if (!list.length) return '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 8px 0;">This wallet is not nominating any validators.</div>';
    return list.map(v => `
            <a href="/validator/${encodeURIComponent(v.address)}" class="wallet-validator-row item-link">
                <span>${v.name && v.name !== 'Unknown' ? esc(v.name) : short(v.address)}</span>
                <i class='bx bx-chevron-right'></i>
            </a>`).join('');
}
// A /stake shortcut that cannot open the card: SC-120 above the connect chooser, SC-121 in the read-only callout.
export function stakeIntentNoteHtml(id, esc) {
    return linePanelHtml('is-info', 'bx-info-circle', `<span data-sc="${id}">${esc(STAKE_COPY[id])}</span>`, ' id="stake-intent-note"');
}

//   doc       the page            post   the post-action core (subscribe)
//   data      () => the payload My Account shows      setData(payload) makes it the page's payload
//   read      (address) => readStakeFigures(...)      onData(payload, tracked) the card, if open, follows
//   nominations (address) re-reads the "Your validators" card       fmt { pdex, esc, short, usd(total) }
//   actions   { send, unstake }: the handlers of the action bar's Send and Unstake, for a button the server's copy opens
export function createStakeRefresh({ doc, post, data, setData, read, same = (a, b) => a === b, fmt, now = Date.now, onData = () => {}, nominations = null, actions = {} }) {
    const { pdex, esc, short, usd = null } = fmt;
    let last = null;   // { address, block, at, before, applied }
    const bound = new WeakSet();   // action buttons that have their click handler
    const sameAccount = (a, b) => { if (a == null || b == null) return false; try { return a === b || !!same(a, b); } catch (e) { return false; } };
    const mine = (a) => !!last && sameAccount(last.address, a);
    const freshness = (block) => ({ v: 1, chainHead: block, pending: [] });

    function tracked(address) {
        if (!mine(address)) return null;
        const d = data();
        if (now() - last.at >= pollDeadlineMs('staking.ledger', d && d.freshness)) return null;
        if (d && caughtUp('staking.ledger', d.freshness, last.block)) return null;
        return { block: last.block };
    }
    function wash(el) {
        el.classList.remove('is-value-changed');
        void el.offsetWidth;   // restart the one-shot wash (T5)
        el.classList.add('is-value-changed');
    }
    function setText(id, text) {
        const el = doc.getElementById(id);
        if (!el || el.textContent === text) return;
        el.textContent = text;
        wash(el);
    }
    // Only what changed is touched; nodes stay, so focus and scroll stay (U3, U4).
    function paint(next) {
        setText('wallet-staked-value', stakedText(next, pdex, (s) => s));
        const total = next.balance ? next.balance.total : 0;
        setText('wallet-total-value', `${pdex(total)} PDEX`);
        const value = doc.getElementById('wallet-total-value');
        const sub = value && value.parentNode ? value.parentNode.querySelector('.value-usd') : null;
        if (sub && sub.getAttribute('data-pdex-amount') !== String(total)) { sub.setAttribute('data-pdex-amount', String(total)); if (usd) sub.innerHTML = usd(total); }
        const btn = doc.getElementById('wallet-act-stake');
        if (btn) {
            const box = doc.createElement('div');
            box.innerHTML = stakeButtonHtml(next.staking, esc);
            const want = box.querySelector('div');
            const have = btn.querySelector('div');
            if (have && want && have.innerHTML !== want.innerHTML) have.innerHTML = want.innerHTML;
        }
        const list = doc.getElementById('wallet-my-validators');
        const html = myValidatorsHtml(next.staking && next.staking.nominating, { esc, short });
        if (list && list.innerHTML !== html) list.innerHTML = html;
        const count = doc.getElementById('wallet-my-validators-count');
        const n = `${((next.staking && next.staking.nominating) || []).length} nominated`;
        if (count && count.textContent !== n) count.textContent = n;
    }
    // Send and Unstake open or close with the server's copy (a first stake opens Unstake), in place, with today's
    // titles. Only from the server's copy: it arrives after the page cleared any "could not be refreshed" block.
    function gates(next) {
        for (const g of GATES) {
            const b = doc.getElementById(g.id);
            if (!b) continue;
            const on = g.on(next);
            if (on && b.disabled) {
                b.disabled = false;
                b.removeAttribute('title');
                if (!bound.has(b) && typeof actions[g.key] === 'function') b.addEventListener('click', actions[g.key]);
                bound.add(b);
            } else if (!on && !b.disabled) {
                bound.add(b);   // enabled when drawn: it has its handler
                b.disabled = true;
                b.setAttribute('title', g.title);
            }
        }
    }
    // S14 on Total Staked when the core gives up on a read (no timer here: the core's deadline).
    function behind(on) {
        const label = doc.getElementById('wallet-staked-label');
        if (!label) return;
        const mark = label.querySelector('.ui-chip');
        if (on && !mark) label.insertAdjacentHTML('beforeend', chipHtml('is-wait is-bare', 'bx-error', STRINGS.S14, esc));
        else if (!on && mark) mark.remove();
    }
    function take(next) {
        setData(next);
        paint(next);
        try { onData(next, tracked(next.address)); } catch (e) { /* the card follows on its own next open */ }
    }

    function apply(address) {
        const want = last;
        return Promise.resolve().then(() => read(address)).then((fig) => {
            const d = data();
            if (last !== want || !d || !sameAccount(d.address, address)) return null;   // moved on (U13)
            if (fig.block != null && fig.block < want.block) return freshness(fig.block);   // the node is behind the block: asked again
            want.applied = true;
            behind(false);
            take(withFigures(d, fig, same));
            if (nominations) { try { nominations(address); } catch (e) { /* its own card */ } }
            return freshness(fig.block != null ? fig.block : want.block);
        }, () => null);
    }
    function withdraw(d) {
        const was = last;
        last = null;
        behind(false);
        if (was.applied) take(withFigures(d, { balance: was.before.balance || {}, staking: was.before.staking || {} }, same));
        else try { onData(d, null); } catch (e) { /* nothing drawn */ }
    }
    function reload(ctx = {}) {
        const d = data();
        if (!d || !d.address) return null;
        if (ctx.reason === 'account') { last = null; return null; }
        if ((ctx.reason === 'reorg' || ctx.reason === 'failed') && mine(d.address)) { withdraw(d); return null; }
        const included = ctx.reason === 'inBlock' && ctx.info && ctx.info.key === STAKE_KEY && ctx.block != null && Number.isFinite(Number(ctx.block));
        if (included) last = { address: d.address, block: Number(ctx.block), at: now(), before: mine(d.address) && last.before ? last.before : d, applied: false };
        if (included || (ctx.poll && mine(d.address) && !last.applied)) return apply(d.address);
        // Another action's inclusion (a payout, a transfer): this component reads nothing for it, so its poll ends here
        // (the page's own reload draws those).
        return ctx.poll && ctx.block != null && Number.isFinite(Number(ctx.block)) ? freshness(Number(ctx.block)) : null;
    }
    function state(s) {
        if (s === 'could-not-refresh' && last && !last.applied && mine((data() || {}).address)) behind(true);
        else if (s === 'current') behind(false);
    }
    if (post && typeof post.subscribe === 'function') post.subscribe(STAKE_DOMAINS.slice(), { account: () => { const d = data(); return d ? d.address : null; }, reload, state });

    // The server's copy of the page (an R2 poll): with nothing tracked, the same as before (equal: keep the page,
    // take the freshness; different: false, the caller draws it). While a stake is tracked, a copy that differs only
    // in balance and stake, and opens or closes no action, is taken in place.
    function adopt(next) {
        const d = data();
        if (!d || !next || !sameAccount(d.address, next.address)) return false;
        if (samePayload(d, next)) { d.freshness = next.freshness; if (mine(d.address)) try { onData(d, tracked(d.address)); } catch (e) { /* follows later */ } return true; }
        if (!mine(d.address)) return false;
        if (!samePayload({ ...d, balance: next.balance, staking: next.staking }, next)) return false;
        take(next);
        gates(next);
        if (caughtUp('staking.ledger', next.freshness, last.block)) last = null;
        return true;
    }
    return { tracked, adopt, reload, paint };
}
