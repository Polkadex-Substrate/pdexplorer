// Audit F-164: this file re-implemented server.js's getOnChainIdentity
// (superOf → identityOf → display, with the sub-identity hop). Two copies
// of that lookup drift, and a probe that disagrees with production is worse
// than no probe — it produces confident wrong answers during an incident.
// These scripts are diagnostic only and nothing in the app imports them;
// if you need the production behaviour, query /api/account/:address or
// export getOnChainIdentity from server.js rather than copying it again.
// Audit F-100: this probe used to hardcode the PUBLIC production RPC, so
// running it — including by accident, from a dev box — put load on the
// endpoint real wallets sign against. Defaults to a local node now; set
// POLKADEX_WS to aim it somewhere else deliberately.
import { ApiPromise, WsProvider } from '@polkadot/api';
import fs from 'fs/promises';

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
        const identity = await api.query.identity.identityOf(addr);
        const superOf = await api.query.identity.superOf(addr);
        
        let hasId = false;
        if (identity.isSome) {
            console.log(`#${i+1} ${addr} has identityOf!`);
            hasId = true;
        }
        if (superOf.isSome) {
            console.log(`#${i+1} ${addr} has superOf!`);
            hasId = true;
        }
        if (hasId) foundIdentities++;
    }
    
    console.log(`Found ${foundIdentities} identities out of top 20.`);
    process.exit(0);
}

run();
