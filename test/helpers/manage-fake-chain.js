// A fake chain for the manage panel (lib/validator-manage-view.js) in the preview generators: the REAL
// spec 393 codecs for the calls (test/fixtures), synthetic state. Shared by test/helpers/preview-validate-manage.mjs
// and tools/preview-scenes.mjs. Never shipped, never run by npm test on its own.
//
// fakeManageApi(stash, keys): stash is the account the ledger and Bonded answer with; keys its next session keys.
// The stash's figures: 48,000 PDEX bonded, 5% commission, era 1210.

import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import { registryFromMetadata, loadFixture } from './extrinsic-builders.js';

const PDEX = 10n ** 12n;
let chain = null;
function codecs() {
    if (!chain) {
        const registry = registryFromMetadata(loadFixture('metadata-testnet-393.json').metadata);
        chain = { registry, ex: decorateExtrinsics(registry, registry.metadata, 15) };
    }
    return chain;
}
const opt = (v) => (v == null ? { isSome: false, isNone: true } : { isSome: true, isNone: false, unwrap: () => v });
const num = (v) => ({ toNumber: () => Number(v), toString: () => String(v), toBigInt: () => BigInt(v) });
const keysCodec = (k) => ({ toJSON: () => ({ grandpa: k.grandpa, babe: k.babe, imOnline: k.im_online, authorityDiscovery: k.authority_discovery, mixnet: k.mixnet, beefy: k.beefy }) });

export function fakeManageApi(stash, keys) {
    const { registry, ex } = codecs();
    const validators = async () => ({ commission: num(50_000_000), blocked: { isTrue: false } });
    validators.size = async () => num(5);
    const tx = new Proxy(ex, { get: (t, sec) => new Proxy(t[sec], { get: (p, m) => (...args) => { const c = p[m](...args); c.paymentInfo = async () => ({ partialFee: num(15_800_000_000n) }); return c; } }) });
    return { registry, tx, runtimeVersion: { specVersion: num(393) },
        consts: { balances: { existentialDeposit: num(PDEX) }, staking: { maxUnlockingChunks: num(32), bondingDuration: num(28), sessionsPerEra: num(6) } },
        query: {
            system: { account: async () => ({ data: { free: num(2_400n * PDEX), reserved: num(48_000n * PDEX), frozen: num(0) } }) },
            staking: { minValidatorBond: async () => num(100n * PDEX), minCommission: async () => num(0), minNominatorBond: async () => num(10n * PDEX), currentEra: async () => opt(num(1210)),
                bonded: async () => opt(stash), ledger: async () => opt({ stash, total: num(48_000n * PDEX), active: num(48_000n * PDEX), unlocking: [] }),
                validators, nominators: async () => opt(null), payee: async () => registry.createType('Option<RewardDestination>', 'Staked') },
            session: { nextKeys: async () => opt(keysCodec(keys)), queuedKeys: async () => [], keyOwner: async () => opt(null) },
            proxy: { proxies: async () => [[], num(0)] }
        } };
}
