import { buildCouncilWithdrawal, councilRole, readCouncilCandidacy } from './council-candidacy.js';
import { sameAccount } from './multisig.js';

const ROLE_TEXT = {
    Candidate: 'This removes you from the candidate list. You will not stand in the next election unless you submit candidacy again.',
    RunnerUp: 'This gives up your runner-up position and removes you from future elections until you submit candidacy again.',
    Member: 'This immediately gives up your council seat when the transaction executes. It also withdraws you from future elections until you submit candidacy again. A runner-up may take your seat.'
};
const title = role => role === 'Member' ? 'Leave council' : 'Withdraw candidacy';
const terminal = new Set(['finalized', 'failed', 'cancelled', 'unconfirmed', 'waiting', 'stalled']);

export function createCouncilCandidacyUI({ api: getApi, selected, isMultisig, submit, refresh, connectPrompt, document: doc = document }) {
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
        reviewed = null; ack.checked = false; sign.disabled = true;
        modal.style.display = 'flex';
        get('council-withdraw-title').textContent = 'Withdraw candidacy';
        get('council-withdraw-address').textContent = address || 'No wallet selected';
        get('council-withdraw-effect').textContent = 'Checking your council role…';
        get('council-withdraw-review').style.display = 'none';
        get('council-withdraw-connect').innerHTML = '';
        error.textContent = '';
        retry.disabled = false;
        if (busy) {
            get('council-withdraw-effect').textContent = 'A withdrawal is already in progress.';
            error.textContent = 'Check its transaction status before trying again.';
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
        const multisig = isMultisig(r.address);
        const finish = () => {
            busy = false;
            // submitSignedTx manages its button too. Keep this review expired
            // after any terminal result, including an uncertain inclusion.
            if (reviewed === r) { reviewed = null; sign.disabled = true; retry.disabled = false; }
        };
        try {
            await submit({
                expectedWallet: r.address,
                buildTx: async api => {
                    if (!valid(r) || api !== r.api) throw new Error('The account, network, or review changed. Open the withdrawal again.');
                    const tx = await buildCouncilWithdrawal(api, r.address, r);
                    if (!valid(r) || api !== getApi()) throw new Error('The account, network, or review changed. Open the withdrawal again.');
                    return tx;
                },
                label: title(r.role), action: { key: 'elections.withdraw', params: { role: r.role } },
                button: sign, busyText: 'Signing…', idleText: sign.textContent,
                onStage: stage => { if (terminal.has(stage)) finish(); },
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
