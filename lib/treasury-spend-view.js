// The Treasury page's "Propose a spend": the header action and its dialog.
// A council member fills in the spend, reviews the motion decoded from its
// bytes, and signs it through submit (submitSignedTx: fee check, status card).
// The seats are read live when the dialog opens and again at signing; a change
// of account, network, seats or any field voids the review.
// Tests: test/treasury-spend-motion.test.js.
import { escapeHtml as esc } from './html-escape.js';
import { renderCall } from './gov-detail-view.js';
import { sameAccount } from './multisig.js';
import { formatPlanck } from './tx-status.js';
import { PDEX_DECIMALS } from './wallet-safety.js';
import { COUNCIL_SPEND_CAP_TEXT, readCouncilSeats, readHeadNumber, holdsSeat, spendThresholdRange, thresholdWhy, checkSpendForm, validFromTooEarly, buildSpendMotion, decodeSpendMotion } from './treasury-spend.js';

const FIELDS = ['beneficiary', 'amount', 'valid-from', 'threshold'];
const TERMINAL = new Set(['finalized', 'failed', 'cancelled', 'unconfirmed', 'waiting', 'stalled', 'confirmed', 'processed']);
const CHAIN = { readSeats: readCouncilSeats, readHead: readHeadNumber, build: buildSpendMotion, decode: decodeSpendMotion };
const decimalsOf = (api) => Number(api && api.registry && api.registry.chainDecimals && api.registry.chainDecimals[0]) || PDEX_DECIMALS;
// The chain's SS58 prefix from the registry; Polkadex's 88 until the api knows it.
const prefixOf = (api) => { const p = api && api.registry && api.registry.chainSS58; return Number.isInteger(p) ? p : 88; };
const reviewHtml = (d) => `${renderCall({ call: d.motion }, { esc })}<p class="stake-hint">wrapping</p>${renderCall({ call: d.spend }, { esc })}<p class="stake-hint">Motion hash <code>${esc(d.hash)}</code></p>`;

export function createSpendMotionUI({ api: getApi, selected, isMultisig, submit, connectPrompt, document: doc = document, motion = CHAIN }) {
    const get = (id) => doc.getElementById('treasury-spend-' + id);
    const show = (id, on, as = 'block') => { get(id).style.display = on ? as : 'none'; };
    const say = (text) => { get('effect').textContent = text; };
    const setError = (text) => { get('error').textContent = text; show('error', !!text); };
    let slot = null, seat = null, pending = null, generation = 0, reviewed = null, busy = false, edits = 0, checking = null;

    const current = (s) => !!s && sameAccount(selected(), s.address) && getApi() === s.api;
    async function seatFor(address, api) {
        try { const s = await motion.readSeats(api); return { ...s, address, api, member: holdsSeat(s, address) }; }
        catch (e) { return { address, api, error: e.message }; }
    }

    // The header action: usable only by a connected seat holder, else it says why.
    function actionModel() {
        if (!selected()) return { why: 'Connect the wallet of a council member to propose a spend.' };
        if (!getApi()) return { why: 'Waiting for the node connection.' };
        if (!current(seat)) return { why: 'Checking your council seat…' };
        if (seat.error) return { why: `Could not read the council seats: ${seat.error}` };
        return seat.member ? { enabled: true } : { why: 'Only council members can propose a spend; this account holds no council seat.' };
    }
    function renderAction() {
        if (!slot) return;
        const m = actionModel();
        slot.innerHTML = `<button type="button" class="reward-filter-btn" id="treasury-spend-open"${m.enabled ? '' : ' disabled'}><i class='bx bx-plus-circle'></i> Propose a spend</button>`
            + (m.why ? ` <span style="color:var(--text-muted);font-size:0.78rem;">${esc(m.why)}</span>` : '');
    }
    function refresh() {
        renderAction();
        const address = selected(), api = getApi();
        // A failed read is not cached: the next render (a tab switch) reads again.
        if (!slot || !address || !api || (current(seat) && !seat.error) || (pending && sameAccount(pending.address, address) && pending.api === api)) return;
        const p = pending = { address, api };
        seatFor(address, api).then(s => { if (pending === p) pending = null; if (current(s)) { seat = s; renderAction(); } });
    }
    function mount(el) {
        if (el && el !== slot) el.addEventListener('click', () => { if (actionModel().enabled) open(); });
        slot = el || null;
        refresh();
    }

    // One Review motion at a time: the button is disabled and aria-busy while a check runs (it may be
    // waiting on the current block), a second click is ignored, and the guard is released when the check
    // ends either way or the dialog closes. `checking` is the running check's token, so a check that ends
    // after a close and reopen cannot release (or re-enable) the new dialog's button.
    const canCheck = () => !busy && current(seat) && !!seat.member && get('modal').style.display !== 'none';
    function releaseCheck(token) {
        if (token && checking !== token) return;
        checking = null;
        get('check').setAttribute('aria-busy', 'false');
        if (token) get('check').disabled = !canCheck();
    }

    function close() {
        generation++; reviewed = null;
        releaseCheck(null);
        get('modal').style.display = 'none';
        get('sign').disabled = true;
    }
    function accountChanged() { close(); seat = null; refresh(); }
    function dropReview() { reviewed = null; get('sign').disabled = true; show('review', false); show('edit', false); }
    function invalidate() { edits++; dropReview(); setError(''); }

    async function open() {
        const id = ++generation, address = selected(), api = getApi();
        releaseCheck(null);
        get('modal').style.display = 'flex';
        get('account').textContent = address || 'No wallet connected';
        get('cap').textContent = `Up to ${COUNCIL_SPEND_CAP_TEXT} per spend; a larger spend needs a referendum.`;
        get('connect').innerHTML = '';
        for (const f of FIELDS) get(f).value = '';
        invalidate(); show('form', false); get('check').disabled = true;
        if (busy) return say('A motion from this dialog is still being signed. Its status card shows the result.');
        if (!address) { get('connect').innerHTML = connectPrompt(); return say('Connect the wallet of a council member to propose a spend.'); }
        if (!api) return say('The node connection is not ready yet. Try again in a moment.');
        say('Checking your council seat…');
        const s = await seatFor(address, api);
        if (id !== generation || !current(s)) return;
        seat = s; renderAction();
        if (s.error) return say(`Could not read the council seats: ${s.error}`);
        if (!s.member) return say('Only council members can propose a spend; this account holds no council seat.');
        const n = s.members.length, r = spendThresholdRange(n), th = get('threshold');
        say(`This account holds one of the ${n} council seats.`);
        th.value = String(r.min); th.setAttribute('min', r.min); th.setAttribute('max', r.max);
        get('threshold-hint').textContent = thresholdWhy(n);
        show('form', true); get('check').disabled = false;
    }

    // Review motion: the fields checked, the call built and decoded for the reader.
    // The current block is read only when a valid-from block is given.
    async function check() {
        if (checking) return;
        const s = seat, api = getApi(), decimals = decimalsOf(api), id = generation, edit = edits;
        if (busy || !current(s) || !s.member || get('modal').style.display === 'none') return;
        const token = checking = {};
        get('check').disabled = true; get('check').setAttribute('aria-busy', 'true');
        try { await runCheck(s, api, decimals, id, edit); } finally { releaseCheck(token); }
    }
    async function runCheck(s, api, decimals, id, edit) {
        const f = { beneficiary: get('beneficiary').value, amount: get('amount').value, validFrom: get('valid-from').value, threshold: get('threshold').value };
        let head;
        if (String(f.validFrom || '').trim() !== '') {
            try { head = await motion.readHead(api); }
            catch (e) { return setError(`Could not read the current block: ${e.message}`); }
            if (id !== generation || edit !== edits || busy || !current(s) || getApi() !== api) return;
        }
        const c = checkSpendForm(f, { seats: s.members.length, decimals, ss58Prefix: prefixOf(api), head });
        if (!c.ok) return setError(Object.values(c.errors)[0]);
        try {
            const tx = motion.build(api, s.pallet, c.values), d = motion.decode(api, tx, decimals);
            reviewed = { values: c.values, amount: formatPlanck(c.values.planck, decimals, decimals), address: s.address, api, generation,
                pallet: s.pallet, seats: s.members.length, callHex: tx.method.toHex(), hash: d.hash };
            get('review').innerHTML = reviewHtml(d);
            setError(''); show('review', true); show('edit', true, 'inline-block');
            get('sign').disabled = false;
        } catch (e) { setError(e.message); }
    }

    const valid = (r) => !!r && reviewed === r && r.generation === generation && get('modal').style.display !== 'none' && current(r);
    function finish(r) {
        busy = false;
        if (reviewed === r) dropReview();
        get('sign').disabled = !valid(reviewed);
        get('check').disabled = !(current(seat) && seat.member && get('modal').style.display !== 'none') || !!checking;
    }
    async function send() {
        const r = reviewed;
        if (busy || !valid(r)) return;
        busy = true; get('sign').disabled = true; get('check').disabled = true;
        const assertReview = (api) => { if (!valid(r) || api !== r.api) throw new Error('The account, network or review changed. Review the motion again.'); };
        try {
            await submit({
                expectedWallet: r.address,
                buildTx: async (api) => {
                    assertReview(api);
                    const now = await motion.readSeats(api);
                    assertReview(api);
                    if (!holdsSeat(now, r.address)) throw new Error('This account no longer holds a council seat. Nothing was signed.');
                    if (now.pallet !== r.pallet || now.members.length !== r.seats) throw new Error('The council seats changed. Review the motion again.');
                    if (r.values.validFrom !== null) {
                        const head = await motion.readHead(api);
                        assertReview(api);
                        if (r.values.validFrom < head + 1) throw new Error(`${validFromTooEarly(head)} Nothing was signed.`);
                    }
                    const tx = motion.build(api, r.pallet, r.values);
                    if (tx.method.toHex() !== r.callHex) throw new Error('The motion no longer matches the review. Review it again.');
                    return tx;
                },
                label: 'Propose a treasury spend',
                action: { key: 'council.propose', params: { amount: r.amount, beneficiary: r.values.beneficiary, threshold: r.values.threshold, seats: r.seats, hash: r.hash } },
                button: get('sign'), busyText: 'Signing…', idleText: 'Sign & table motion',
                onStage: (stage) => { if (TERMINAL.has(stage)) finish(r); },
                onError: (message) => { if (generation === r.generation) setError(message); finish(r); },
                onSuccess: () => { seat = null; if (generation === r.generation) close(); refresh(); }
            });
        } catch (e) { if (generation === r.generation) setError(e.message); finish(r); }
        finally { if (isMultisig(r.address)) finish(r); }
    }

    for (const f of FIELDS) get(f).addEventListener('input', invalidate);
    get('check').addEventListener('click', check);
    get('edit').addEventListener('click', () => { invalidate(); get('beneficiary').focus(); });
    get('sign').addEventListener('click', send);
    get('close').addEventListener('click', close);
    get('modal').addEventListener('click', (e) => { if (e.target === get('modal')) close(); });
    return { mount, refresh, open, close, accountChanged };
}
