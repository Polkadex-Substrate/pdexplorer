// Names the metadata fixture written by scripts/fetch-metadata.mjs from what
// was actually fetched, never from what the caller hoped to fetch. Import-free
// so tests can load it without a network or a node.

// Genesis hashes of the chains we keep fixtures for.
export const KNOWN_GENESIS = {
    '0x3920bcb4960a1eef5580cd5367ff3f430eef052774f78468852f7b9cb39f8a3c': 'mainnet',
    '0xc8e4ae0edf9fb6ce7432ea680038880d10ed34723e86f3982b1c6be911e35880': 'testnet'
};

export function networkFromGenesis(genesisHash) {
    return KNOWN_GENESIS[String(genesisHash || '').toLowerCase()] || null;
}

// metadata-<network>-<spec>.json
export function fixtureFileName(network, specVersion) {
    if (!/^[a-z][a-z0-9]*$/.test(String(network))) throw new Error(`bad network name: ${JSON.stringify(network)}`);
    if (!Number.isInteger(specVersion) || specVersion < 1) throw new Error(`bad specVersion: ${JSON.stringify(specVersion)}`);
    return `metadata-${network}-${specVersion}.json`;
}

// network override (--network) wins; otherwise the genesis hash decides.
export function resolveFixtureName({ genesisHash, specVersion, networkOverride = null }) {
    const network = networkOverride || networkFromGenesis(genesisHash);
    if (!network) {
        throw new Error(`genesis ${genesisHash} is not a known Polkadex chain, so the fixture cannot be named. Pass --network <name> to name it explicitly. Nothing written.`);
    }
    return { network, file: fixtureFileName(network, specVersion) };
}
