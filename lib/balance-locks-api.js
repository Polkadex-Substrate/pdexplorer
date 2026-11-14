// GET /api/account/:address/locks: the balance breakdown (total,
// transferable, locked, reserved) and one row per lock, freeze, hold and
// deposit, each with its reason and how to release it. lib/balance-locks.js
// builds the model; lib/balance-locks-chain.js reads the chain.
//
// Cache-Control: the short tier on success, like /api/account/:address (live
// balances, public chain state). ?fresh=1, the panel's re-read after an
// action, is no-store, so the CDN keeps no copy of it. Every request reads the
// chain; there is no in-process cache to skip. 400, 503 and errors are
// no-store: the gate, requireRpc and serverError in server.js already set that.
//
// No imports of server state: server.js passes the api getter and its
// helpers, so test/balance-locks.test.js runs the real handler.

import { readAccountLocks } from './balance-locks-chain.js';
import { describeAccountLocks } from './balance-locks.js';

export const LOCKS_ROUTE = '/api/account/:address/locks';

export function registerBalanceLocksRoute(app, { api, ready, gate, cacheShort, isFresh = () => false, serverError }) {
    app.get(LOCKS_ROUTE, async (req, res) => {
        const g = gate(req, res);
        if (!g) return;
        if (!ready(res)) return;
        try {
            const snap = await readAccountLocks(api(), g.address);
            const model = describeAccountLocks(snap);
            if (isFresh(req.query)) res.set('Cache-Control', 'no-store'); else cacheShort(res);
            res.json({ address: g.address, ...model });
        } catch (err) { serverError(res, err, req.path); }
    });
}
