// Audit F-100: this probe used to hardcode the PUBLIC production RPC, so
// running it — including by accident, from a dev box — put load on the
// endpoint real wallets sign against. Defaults to a local node now; set
// POLKADEX_WS to aim it somewhere else deliberately.
import { ApiPromise, WsProvider } from '@polkadot/api';

async function run() {
    const wsProvider = new WsProvider((process.env.POLKADEX_WS || 'ws://127.0.0.1:9944'));
    const api = await ApiPromise.create({ provider: wsProvider });
    
    console.log("Fetching historical transactions...");
    const startTime = Date.now();
    
    let currentHash = await api.rpc.chain.getBlockHash();
    const transactions = [];
    let blocksSearched = 0;
    
    while (transactions.length < 50 && blocksSearched < 1000) {
        const signedBlock = await api.rpc.chain.getBlock(currentHash);
        const blockNumber = signedBlock.block.header.number.toNumber();
        
        let timestamp = Date.now(); // fallback
        
        signedBlock.block.extrinsics.forEach((ex) => {
            // Check for timestamp set extrinsic to get block time
            if (ex.method.section === 'timestamp' && ex.method.method === 'set') {
                timestamp = ex.method.args[0].toNumber();
            }
        });
        
        signedBlock.block.extrinsics.forEach((ex) => {
            if (ex.isSigned) {
                transactions.push({
                    hash: ex.hash.toHex(),
                    from: ex.signer.toString(),
                    to: ex.method.args[0] ? ex.method.args[0].toString() : "System",
                    block: blockNumber,
                    amount: "Tx",
                    timestamp: timestamp
                });
            }
        });
        
        currentHash = signedBlock.block.header.parentHash;
        blocksSearched++;
        
        if (blocksSearched % 50 === 0) {
            console.log(`Searched ${blocksSearched} blocks, found ${transactions.length} transactions...`);
        }
    }
    
    console.log(`Fetched ${transactions.length} transactions by searching ${blocksSearched} blocks in ${(Date.now() - startTime)/1000} seconds.`);
    console.log("Top 3:", transactions.slice(0, 3));
    
    process.exit(0);
}

run();
