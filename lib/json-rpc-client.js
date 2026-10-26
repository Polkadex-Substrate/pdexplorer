// Minimal JSON-RPC over WebSocket for the operator scripts in scripts/.
// Plain JSON-RPC on purpose (no @polkadot/api), so a library bug cannot shape
// what the scripts read. Needs a global WebSocket (Node 22 or newer).

export function rpcClient(url) {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const opened = new Promise((ok, fail) => {
        ws.addEventListener('open', ok, { once: true });
        ws.addEventListener('error', () => fail(new Error(`cannot connect to ${url}`)), { once: true });
    });
    ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.ok(msg.result);
    });
    const call = async (method, params = []) => {
        await opened;
        const id = nextId++;
        return new Promise((ok, fail) => {
            const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method}: timed out`)); }, 60000);
            pending.set(id, { method, ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
            ws.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
        });
    };
    return { call, close: () => ws.close() };
}
