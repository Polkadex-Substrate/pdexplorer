import { resolveElectionsPallet } from './collective-live.js';
import { sameAccount } from './multisig.js';

const who = entry => entry?.who ?? entry?.address ?? (Array.isArray(entry) ? entry[0] : entry);

// Used with both the REST rows (button label only) and chain codecs. Members
// and runners-up are implicit candidates; their withdrawal has different effects.
export function councilRole(data, address) {
    if (!address) return null;
    for (const [list, role] of [['members', 'Member'], ['runnersUp', 'RunnerUp'], ['candidates', 'Candidate']]) {
        if (Array.from(data?.[list] || []).some(e => sameAccount(String(who(e)), address))) return role;
    }
    return null;
}

const network = api => ({ genesis: api.genesisHash.toHex(), specVersion: api.runtimeVersion.specVersion.toString() });
const sameNetwork = (a, b) => a.genesis === b.genesis && a.specVersion === b.specVersion;

export async function readCouncilCandidacy(api, address) {
    let timer;
    try {
        return await Promise.race([
            readAtHead(api, address),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reading your council role timed out. Retry when the node is connected.')), 15000); })
        ]);
    } finally { clearTimeout(timer); }
}

async function readAtHead(api, address) {
    if (!api) throw new Error('The node connection is not ready. Retry when connected.');
    const start = network(api);
    const pallet = resolveElectionsPallet(api);
    if (!pallet || !api.tx[pallet]?.renounceCandidacy) throw new Error('Council candidacy withdrawal is not supported by this runtime.');
    // Read all three sets at one block, so an election cannot make an account
    // appear in two different roles between independent storage requests.
    const hash = await api.rpc.chain.getBlockHash();
    const at = await api.at(hash);
    const q = at.query[pallet];
    if (!q?.members || !q.runnersUp || !q.candidates) throw new Error('Council election data is unavailable. Try again.');
    const [members, runnersUp, candidates] = await Promise.all([q.members(), q.runnersUp(), q.candidates()]);
    if (![members, runnersUp, candidates].every(Array.isArray)) throw new Error('Council election data could not be read. Try again.');
    if (!sameNetwork(start, network(api))) throw new Error('The network or runtime changed. Review the withdrawal again.');
    return { ...start, pallet, address, role: councilRole({ members, runnersUp, candidates }, address), candidateCount: candidates.length };
}

export async function buildCouncilWithdrawal(api, address, reviewed) {
    if (!reviewed?.role || !sameAccount(address, reviewed.address)) throw new Error('Review the withdrawal for the selected account first.');
    const current = await readCouncilCandidacy(api, address);
    if (!sameNetwork(current, reviewed) || !sameNetwork(network(api), reviewed) || current.pallet !== reviewed.pallet) throw new Error('The network or runtime changed. Review the withdrawal again.');
    if (current.role !== reviewed.role) throw new Error('Your council role changed. Review the withdrawal again before signing.');
    // Never upgrade Candidate -> Member silently: Member resigns a seat now.
    // A candidate's witness count is read afresh at build time, not from REST
    // or the earlier review. The chain still checks it at execution time.
    const renouncing = current.role === 'Candidate' ? { Candidate: current.candidateCount } : current.role;
    return api.tx[current.pallet].renounceCandidacy(renouncing);
}
