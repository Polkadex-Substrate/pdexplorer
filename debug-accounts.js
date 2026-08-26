// Audit F-100: this probe used to hardcode the PUBLIC production RPC, so
// running it — including by accident, from a dev box — put load on the
// endpoint real wallets sign against. Defaults to a local node now; set
// POLKADEX_WS to aim it somewhere else deliberately.
import { ApiPromise, WsProvider } from '@polkadot/api';

async function run() {
    const wsProvider = new WsProvider((process.env.POLKADEX_WS || 'ws://127.0.0.1:9944'));
    const api = await ApiPromise.create({ provider: wsProvider });
    
    console.log("Fetching all accounts...");
    const startTime = Date.now();
    const entries = await api.query.system.account.entries();
    console.log(`Fetched ${entries.length} accounts in ${(Date.now() - startTime)/1000} seconds.`);
    
    // Sort top 5 to see
    const balances = entries.map(([key, data]) => {
        return {
            address: key.args[0].toString(),
            free: Number(data.data.free) / 10**12,
            reserved: Number(data.data.reserved) / 10**12
        };
    }).sort((a, b) => (b.free + b.reserved) - (a.free + a.reserved));
    
    console.log("Top 5:", balances.slice(0, 5));
    process.exit(0);
}

run();
