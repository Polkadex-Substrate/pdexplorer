// Audit F-100: this probe used to hardcode the PUBLIC production RPC, so
// running it — including by accident, from a dev box — put load on the
// endpoint real wallets sign against. Defaults to a local node now; set
// POLKADEX_WS to aim it somewhere else deliberately.
const { ApiPromise, WsProvider } = require('@polkadot/api');

async function main() {
    const wsProvider = new WsProvider((process.env.POLKADEX_WS || 'ws://127.0.0.1:9944'));
    const api = await ApiPromise.create({ provider: wsProvider });
    
    console.log("Pallets:");
    console.log(Object.keys(api.query).filter(k => k.includes('elect') || k.includes('council')));
    
    if (api.query.council) {
        console.log("Council members:", await api.query.council.members());
    }
    if (api.query.elections) {
        console.log("Elections:");
        console.log("- members:", await api.query.elections.members());
        console.log("- runnersUp:", await api.query.elections.runnersUp());
        console.log("- candidates:", await api.query.elections.candidates());
    }
    if (api.query.phragmenElection) {
        console.log("Phragmen Election:");
        console.log("- members:", await api.query.phragmenElection.members());
        console.log("- runnersUp:", await api.query.phragmenElection.runnersUp());
        console.log("- candidates:", await api.query.phragmenElection.candidates());
    }
    
    process.exit(0);
}
main().catch(console.error);
