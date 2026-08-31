// Audit F-164: this probe used to re-implement server.js's identity walk
// (superOf → identityOf → display, with the sub-identity hop). Round 1 added a
// comment telling the next person not to copy it again and left the copy in
// place; the auditors correctly called that not a fix. It now IMPORTS the same
// lib/identity.js that server.js imports, so what this prints is by
// construction what /api/account/:address would report.
//
// That property is the whole value of the probe. It is reached for during an
// incident, to decide whether production is wrong about a name — and a probe
// running its own older copy of the walk answers a question nobody asked. If
// you extend this file, call getOnChainIdentity; do not inline a query.
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

    const validators = await api.query.session.validators();
    const limit = Math.min(10, validators.length);
    console.log(`Found ${validators.length} validators. Checking first ${limit}...`);

    for (let i = 0; i < limit; i++) {
        const addr = validators[i].toString();
        // Unlike production, surface lookup errors loudly: a probe that
        // silently prints "Unknown" for a decode failure is the exact
        // confidently-wrong answer this file exists to avoid.
        const name = await getOnChainIdentity(api, addr, {
            onError: (e, a) => console.error(`  lookup FAILED for ${a}: ${e.message}`)
        });
        console.log(`#${i + 1} ${addr} -> ${name}`);
    }
    process.exit(0);
}

run();
