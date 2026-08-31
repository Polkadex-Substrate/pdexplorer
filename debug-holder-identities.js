// Audit F-164: this probe used to re-implement server.js's identity walk
// (its own superOf + identityOf pair, with a different notion of "has an
// identity" than production's). Round 1 added a comment and left the copy;
// the auditors correctly called that not a fix. It now IMPORTS the same
// lib/identity.js that server.js imports, so "does this holder have a name"
// is answered here exactly as the top-holders table answers it.
//
// The old version was already drifting in a way that mattered: it reported
// `hasId` when EITHER superOf or identityOf was Some, while production only
// shows a name when the walk actually yields a display string. So this probe
// could report "18 of the top 20 have identities" against a UI showing two.
//
// Audit F-100: this probe used to hardcode the PUBLIC production RPC, so
// running it — including by accident, from a dev box — put load on the
// endpoint real wallets sign against. Defaults to a local node now; set
// POLKADEX_WS to aim it somewhere else deliberately.
import { ApiPromise, WsProvider } from '@polkadot/api';
import { getOnChainIdentity } from './lib/identity.js';

async function run() {
    const wsProvider = new WsProvider((process.env.POLKADEX_WS || 'ws://127.0.0.1:9944'));
    const api = await ApiPromise.create({ provider: wsProvider });

    const entries = await api.query.system.account.entries();

    const balances = entries.map(([key, data]) => {
        return {
            address: key.args[0].toString(),
            free: Number(data.data.free) / 10**12,
            reserved: Number(data.data.reserved) / 10**12
        };
    }).sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));

    const topHolders = balances.slice(0, 20);
    console.log("Checking identities for top 20 holders...");

    let foundIdentities = 0;
    for (let i = 0; i < topHolders.length; i++) {
        const addr = topHolders[i].address;
        const name = await getOnChainIdentity(api, addr, {
            onError: (e, a) => console.error(`  lookup FAILED for ${a}: ${e.message}`)
        });
        // "Unknown" is the helper's single sentinel for "no display name",
        // covering both the missing-record and the missing-display cases.
        if (name !== 'Unknown') {
            console.log(`#${i + 1} ${addr} -> ${name}`);
            foundIdentities++;
        }
    }

    console.log(`Found ${foundIdentities} identities out of top 20.`);
    process.exit(0);
}

run();
