// GET /api/treasury/spends: the approved treasury spends in storage
// (treasury.spends, with treasury.spendCount), read live from the node, newest
// first, each with what can be done with it in the next block (phase, action).
// lib/treasury-payout.js reads and classifies; the Treasury page's Spends tab
// (lib/treasury-payout-view.js) renders it.
//
// Cache-Control: the short tier, like /api/treasury; ?fresh=1 (the page's
// read right after a payout is in a block) is no-store. 503 and errors are
// no-store: requireRpc and serverError in server.js already set that.
//
// No imports of server state: server.js passes the api getter and its
// helpers, so test/treasury-payout.test.js runs the real handler.

import { readSpends } from './treasury-payout.js';

export const SPENDS_ROUTE = '/api/treasury/spends';

export function registerTreasurySpendsRoute(app, { api, ready, cacheShort, isFresh, serverError, normalize = (a) => a }) {
    app.get(SPENDS_ROUTE, async (req, res) => {
        if (!ready(res)) return;
        try {
            const data = await readSpends(api(), { normalize });
            if (isFresh(req.query)) res.set('Cache-Control', 'no-store'); else cacheShort(res);
            res.json(data);
        } catch (err) { serverError(res, err, req.path); }
    });
}
