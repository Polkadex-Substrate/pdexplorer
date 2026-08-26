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

async function run() {
    const wsProvider = new WsProvider((process.env.POLKADEX_WS || 'ws://127.0.0.1:9944'));
    const api = await ApiPromise.create({ provider: wsProvider });
    
    const validators = await api.query.session.validators();
    console.log(`Found ${validators.length} validators. Checking first 10...`);
    
    for (let i = 0; i < 10; i++) {
        const addr = validators[i].toString();
        const superOf = await api.query.identity.superOf(addr);
        if (superOf.isSome) {
            const [parentAddress, data] = superOf.unwrap();
            const parentIdentity = await api.query.identity.identityOf(parentAddress);
            console.log("SUPEROF", addr, "Parent:", parentAddress.toString());
            console.log("PARENT IDENTITY:", JSON.stringify(parentIdentity.toHuman(), null, 2));
            console.log("SUB DATA:", JSON.stringify(data.toHuman(), null, 2));
        } else {
            const identity = await api.query.identity.identityOf(addr);
            console.log("IDENTITYOF", addr);
            console.log(JSON.stringify(identity.toHuman(), null, 2));
        }
    }
    process.exit(0);
}

run();
