import { buildCouncilWithdrawal, councilRole, readCouncilCandidacy } from './council-candidacy.js';
import { sameAccount } from './multisig.js';

const ROLE_TEXT = {
    Candidate: 'This removes you from the candidate list. You will not stand in the next election unless you submit candidacy again.',
    RunnerUp: 'This gives up your runner-up position and removes you from future elections until you submit candidacy again.',
    Member: 'This immediately gives up your council seat when the transaction executes. It also withdraws you from future elections until you submit candidacy again. A runner-up may take your seat.'
};
const title = role => role === 'Member' ? 'Leave council' : 'Withdraw candidacy';
// confirmed and processed come from the tracker's chain checks when the
// status updates stopped (lib/tx-submit.js); both end the withdrawal here.
const terminal = new Set(['finalized', 'failed', 'cancelled', 'unconfirmed', 'waiting', 'stalled', 'confirmed', 'processed']);

// The tracker's chain check for a withdrawal: the account no longer holds the
// reviewed council role (and no other). A read error is just "not yet".
export const withdrawalVerdict = (state) => (state && !state.role ? 'applied' : 'pending');

export function createCouncilCandidacyUI({ api: getApi, selected, isMultisig, submit, refresh, connectPrompt, recheck = () => {}, document: doc = document }) {
    const get = id => doc.getElementById(id);
    const modal = get('council-withdraw-modal');
    const sign = get('council-withdraw-sign');
    const retry = get('council-withdraw-retry');
    const ack = get('council-withdraw-ack');
    const error = get('council-withdraw-error');
    let generation = 0, reviewed = null, busy = false;

    function refreshActions(data) {
        get('council-withdraw-btn').textContent = title(councilRole(data, selected()));
    }
    function close() {
        generation++; reviewed = null; modal.style.display = 'none'; sign.disabled = true;
    }
    function accountChanged() { close(); refreshActions(null); }
    function valid(r) {
        return reviewed === r && r.generation === generation && modal.style.display !== 'none'
            && sameAccount(selected(), r.address) && getApi() === r.api;
    }
    function enableSign() { sign.disabled = busy || !reviewed || !valid(reviewed) || (reviewed.role === 'Member' && !ack.checked); }

    async function open() {
        const id = ++generation, address = selected(), api = getApi();
        const current = () => generation === id && modal.style.display !== 'none';
        reviewed = null; ack.checked = false; ack.disabled = false; sign.disabled = true;
        modal.style.display = 'flex';
        get('council-withdraw-title').textContent = 'Withdraw candidacy';
        get('council-withdraw-address').textContent = address || 'No wallet selected';
        get('council-withdraw-effect').textContent = 'Checking your council role…';
        get('council-withdraw-review').style.display = 'none';
        get('council-withdraw-connect').innerHTML = '';
        error.textContent = '';
        retry.disabled = false;
        get('cancel-council-withdraw').textContent = busy ? 'Close' : 'Cancel';
        if (busy) {
            get('council-withdraw-effect').textContent = 'A withdrawal is already in progress. The explorer is checking the chain for its result.';
            error.textContent = 'Check its transaction status before trying again.';
            // The status updates may have stopped (an iPhone that was locked
            // or switched apps): ask the chain now rather than wait.
            try { recheck(); } catch (e) { /* the tracker's own timers still run */ }
            return;
        }
        if (!address) {
            get('council-withdraw-effect').textContent = 'Connect the account whose candidacy you want to withdraw.';
            get('council-withdraw-connect').innerHTML = connectPrompt();
            return;
        }
        retry.disabled = true;
        try {
            const state = await readCouncilCandidacy(api, address);
            if (!current()) return;
            if (!sameAccount(address, selected()) || getApi() !== api) throw new Error('The selected account or network changed. Review again.');
            if (!state.role) {
                get('council-withdraw-effect').textContent = 'This account is not a council candidate, runner-up, or elected member. There is no candidacy to withdraw.';
                return;
            }
            reviewed = { ...state, api, generation: id };
            get('council-withdraw-title').textContent = title(state.role);
            get('council-withdraw-effect').textContent = ROLE_TEXT[state.role];
            get('council-withdraw-review').style.display = 'block';
            get('council-withdraw-ack-label').style.display = state.role === 'Member' ? 'flex' : 'none';
            get('council-withdraw-multisig').style.display = isMultisig(address) ? 'block' : 'none';
            sign.textContent = isMultisig(address) ? 'Review with multisig signers' : `Sign & ${title(state.role).toLowerCase()}`;
            enableSign();
            (state.role === 'Member' ? ack : sign).focus();
        } catch (e) {
            if (current()) { get('council-withdraw-effect').textContent = 'Unable to check your council role.'; error.textContent = e.message; }
        } finally { if (current()) retry.disabled = false; }
    }

    async function send() {
        const r = reviewed;
        if (busy || !r || !valid(r) || (r.role === 'Member' && !ack.checked)) return;
        busy = true; enableSign(); retry.disabled = true;
        get('cancel-council-withdraw').textContent = 'Close';
        const multisig = isMultisig(r.address);
        const assertReview = api => {
            if (!valid(r) || api !== r.api) throw new Error('The account, network, or review changed. Open the withdrawal again.');
            if (r.role === 'Member' && !ack.checked) throw new Error('Your council seat confirmation was cleared. Review the withdrawal again before signing.');
        };
        const finish = () => {
            busy = false;
            // The shared tracker restores its button before calling us, even
            // if this dialog was closed or reopened while it was awaiting the
            // wallet. Reapply the CURRENT review's state after every result.
            if (reviewed === r) reviewed = null;
            enableSign();
            if (!reviewed) retry.disabled = false;
            if (generation !== r.generation && modal.style.display !== 'none' && !reviewed) {
                get('council-withdraw-effect').textContent = 'The earlier request has a status update. Refresh the review to check this account’s current council role.';
            }
        };
        try {
            await submit({
                expectedWallet: r.address,
                buildTx: async api => {
                    assertReview(api);
                    const tx = await buildCouncilWithdrawal(api, r.address, r);
                    assertReview(api);
                    // Once handed to the wallet, cancellation belongs to the
                    // wallet prompt. Do not offer an editable confirmation.
                    ack.disabled = true;
                    return tx;
                },
                label: title(r.role), action: { key: 'elections.withdraw', params: { role: r.role } },
                verify: api => readCouncilCandidacy(api, r.address).then(withdrawalVerdict),
                button: sign, busyText: 'Signing…', idleText: sign.textContent,
                onStage: stage => {
                    if (terminal.has(stage)) finish();
                    else enableSign(); // A retraction can restore the shared button too.
                },
                onError: message => { if (generation === r.generation) error.textContent = message; finish(); },
                onSuccess: () => {
                    if (generation === r.generation) close();
                    refresh();
                }
            });
        } catch (e) { if (generation === r.generation) error.textContent = e.message; finish(); }
        finally {
            // The shared multisig dialog now owns the approval lifecycle;
            // its first approval must never claim that withdrawal executed.
            if (multisig) finish();
        }
    }

    get('council-withdraw-btn').addEventListener('click', open);
    get('close-council-withdraw').addEventListener('click', close);
    get('cancel-council-withdraw').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    retry.addEventListener('click', open);
    ack.addEventListener('change', enableSign);
    sign.addEventListener('click', send);
    return { open, close, accountChanged, refreshActions };
}
