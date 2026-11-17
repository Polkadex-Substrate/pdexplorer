// The chain the democracy buttons read again just before signing: a plain
// democracy state (the shape lib/balance-locks-chain.js reads) served as real
// testnet spec 393 codecs. set() changes it between drawing the panel and
// signing; reads lists every storage read, in order.
import { registryFromMetadata, loadFixture } from './extrinsic-builders.js';

let registry = null;
const types = new Map();
function reg() {
    if (!registry) {
        registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        registry.setChainProperties(registry.createType('ChainProperties', { ss58Format: 88 }));
    }
    return registry;
}
function storage(pallet, item, value) {
    const key = `${pallet}.${item}`;
    if (!types.has(key)) {
        const it = reg().metadata.pallets.find(p => p.name.toString() === pallet).storage.unwrap().items.find(i => i.name.toString() === item);
        const name = reg().createLookupType(it.type.isPlain ? it.type.asPlain : it.type.asMap.value);
        types.set(key, it.modifier.isOptional ? `Option<${name}>` : name);
    }
    return reg().createType(types.get(key), value);
}

const priorLock = (p) => [Number(p.until), BigInt(p.amount)];
const accountVote = (v) => (typeof v.aye === 'boolean'
    ? { Standard: { vote: { aye: v.aye, conviction: v.conviction }, balance: BigInt(v.balance) } }
    : { Split: { aye: BigInt(v.balance), nay: 0n } });
const voting = (d) => (d.delegating
    ? { Delegating: { balance: BigInt(d.balance), target: d.target, conviction: d.conviction, delegations: { votes: 0, capital: 0 }, prior: priorLock(d.prior) } }
    : { Direct: { votes: d.votes.map(v => [v.index, accountVote(v)]), delegations: { votes: 0, capital: 0 }, prior: priorLock(d.prior) } });
// No info: a cancelled referendum.
const info = (r) => (r && r.finished ? { Finished: { approved: r.approved, end: r.end } }
    : r && r.ongoing ? { Ongoing: { end: r.end, threshold: 'SuperMajorityApprove', delay: 0, tally: { ayes: 0, nays: 0, turnout: 0 } } } : null);

export function democracyChain(dem, block, { period = 216000 } = {}) {
    const st = { dem, block };
    const reads = [];
    const read = (what, f) => async (...args) => { reads.push([what, ...args]); return f(...args); };
    return {
        reads,
        set: (change) => Object.assign(st, change),
        consts: { democracy: { voteLockingPeriod: reg().createType('u32', period) } },
        query: {
            system: { number: read('number', () => storage('System', 'Number', st.block)) },
            democracy: {
                votingOf: read('votingOf', () => storage('Democracy', 'VotingOf', voting(st.dem))),
                referendumInfoOf: read('referendumInfoOf', (i) => storage('Democracy', 'ReferendumInfoOf', info((st.dem.referenda || {})[Number(i)])))
            }
        }
    };
}
