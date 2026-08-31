// The one on-chain identity lookup.
//
// Audit F-164. There were two implementations of "what is this address
// called?": `getOnChainIdentity` in server.js, and a hand-rolled copy in each
// of the debug probes. Round 1 added comments to the probes saying "don't copy
// this again" and left both copies in place, which is why the finding stayed
// open — a comment does not stop the two from drifting, it only records that
// someone noticed they might.
//
// Drift here is not cosmetic, because the lookup is a two-hop walk over a
// pallet whose storage shape has changed across runtimes:
//
//   1. `identity.superOf(addr)` — if this address is a SUB-identity, the real
//      display name belongs to the parent, and the answer is "Parent / Sub".
//      A reader that skips this hop reports every sub-identity as Unknown,
//      which is how a validator with a perfectly good registered name shows
//      up as an anonymous address in a block list.
//
//   2. `identity.identityOf(addr)` — returns `Option<Registration>` on newer
//      runtimes and a `(Registration, Hash|null)` TUPLE on older ones. After
//      `.toHuman()` that is an object in one case and an ARRAY in the other,
//      so any reader that only handles one shape returns Unknown for the whole
//      chain the day the runtime is upgraded. Both shapes are handled below;
//      that dual handling is the single most copy-prone part of this file.
//
// The failure mode this module prevents is specific and nasty: after a runtime
// identity-pallet change, production would report Unknown while an operator's
// probe — running the older copy of the walk — reported the correct name, or
// vice versa. During an incident the probe is exactly what someone reaches for
// to decide whether production is wrong, so a probe that can disagree with
// production is worse than no probe at all.
//
// Deliberately free of server.js's caching, DISPLAY_NAME_OVERRIDES and express
// context: this module answers only "what does the CHAIN say", takes the api
// handle as an argument, and is therefore importable by a standalone script
// that must not boot an HTTP server. Callers layer their own policy on top.

// Identity `Data` fields come back either as a UTF-8 string or as `0x…` hex
// when the value is not valid UTF-8 for the codec's taste. Decode the hex form
// so a name registered as bytes does not surface to users as `0x506f6c6b`.
// Undecodable input is returned unchanged rather than thrown away — a raw hex
// name is ugly but still identifying; "Unknown" is not.
export function formatIdentityName(rawStr) {
    if (!rawStr) return 'Unknown';
    const s = String(rawStr);
    if (s.startsWith('0x')) {
        try { return Buffer.from(s.slice(2), 'hex').toString('utf8'); } catch (e) { return s; }
    }
    return s;
}

// Pull `info.display.Raw` out of a `.toHuman()`ed identity record, handling
// BOTH pallet storage shapes (see the header). Returns 'Unknown' when there is
// no display name — never null, so callers can compare against one sentinel.
export function displayNameFromHuman(human) {
    if (!human) return 'Unknown';
    if (human.info && human.info.display && human.info.display.Raw) {
        return formatIdentityName(human.info.display.Raw);
    }
    // Older tuple shape: [Registration, Hash|null].
    if (Array.isArray(human) && human[0] && human[0].info
        && human[0].info.display && human[0].info.display.Raw) {
        return formatIdentityName(human[0].info.display.Raw);
    }
    return 'Unknown';
}

// Resolve `address` to a display name using the chain only.
//
//   api      — a connected @polkadot/api handle, or null/mid-reconnect
//   address  — SS58 string or an AccountId
//   onError  — optional (err, address) hook; the default is silence, because
//              the server calls this on every indexed block and a noisy warn
//              per address during an RPC blip drowns the log.
//
// Returns 'Unknown' rather than throwing, for two reasons that are easy to
// undo by accident. First, the api handle is briefly null while the watchdog
// reconnects, and an identity lookup in flight from an HTTP handler must not
// take the request down with it. Second, callers cache the result: a THROWN
// error is visible, whereas a wrongly-cached "Unknown" is a name that silently
// never comes back until restart. So this returns the sentinel, and it is the
// CALLER's job not to cache it (server.js's getIdentity is careful about this).
export async function getOnChainIdentity(api, address, { onError } = {}) {
    const unknown = 'Unknown';
    if (!api || !api.query || !api.query.identity) return unknown;
    try {
        const superOf = api.query.identity.superOf
            ? await api.query.identity.superOf(address)
            : null;
        if (superOf && superOf.isSome) {
            const [parentAddress, data] = superOf.unwrap();
            const parentIdentity = await api.query.identity.identityOf(parentAddress);
            const parentName = displayNameFromHuman(parentIdentity && parentIdentity.toHuman
                ? parentIdentity.toHuman() : null);
            const subDataHuman = data && data.toHuman ? data.toHuman() : null;
            const subName = subDataHuman ? formatIdentityName(subDataHuman.Raw) : unknown;
            return `${parentName} / ${subName}`;
        }
        const identity = await api.query.identity.identityOf(address);
        return displayNameFromHuman(identity && identity.toHuman ? identity.toHuman() : null);
    } catch (e) {
        if (typeof onError === 'function') onError(e, address);
        return unknown;
    }
}
