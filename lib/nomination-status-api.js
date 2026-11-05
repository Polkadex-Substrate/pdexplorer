// GET /api/account/:address/staking-status: for a nominator, each nominated
// validator's status this era (active, waiting, chilled, blocked, 100%
// commission, offline, disabled, slashed recently) and the banners ("You are
// earning no rewards this era", "Some of your validators look offline").
// lib/nomination-status-chain.js reads the chain, lib/nomination-status.js
// builds the model. Not a nominator: { nominating: false }.
//
// Cache-Control: the short tier on success, like /api/account/:address/locks
// (live public chain state). 400, 503 and errors are no-store: the gate,
// requireRpc and serverError in server.js already set that.
//
// No imports of server state: server.js passes the api getter, the helpers,
// the incident lookup (db.js getValidatorIncidents) and the identity name
// lookup, so test/nomination-status.test.js runs the real handler.

import { readNominationStatus } from './nomination-status-chain.js';
import { nominationModel } from './nomination-status.js';

export const STAKING_STATUS_ROUTE = '/api/account/:address/staking-status';

export function registerStakingStatusRoute(app, { api, ready, gate, cacheShort, serverError, incidents = null, nameOf = null }) {
    app.get(STAKING_STATUS_ROUTE, async (req, res) => {
        const g = gate(req, res);
        if (!g) return;
        if (!ready(res)) return;
        try {
            const snap = await readNominationStatus(api(), g.address, { incidents, nameOf });
            const model = nominationModel(snap);
            cacheShort(res);
            res.json({ ...model, address: g.address });
        } catch (err) { serverError(res, err, req.path); }
    });
}
