// Which value in the request headers is the actual client, and who wrote it?
//
// Audit F-019. The old rule was `X-Forwarded-For.split(',')[0]` — the leftmost
// hop, which is the one value in the whole chain that nobody verifies. nginx
// APPENDS the real peer (`proxy_add_x_forwarded_for`) rather than replacing the
// header, so a request carrying `X-Forwarded-For: 1.2.3.4` arrives as
// `1.2.3.4, <real client>` and the limiter bucketed on `1.2.3.4`. Send a fresh
// random value per request and every per-IP limit in the process evaporates:
// the 60/min developer API cap, the email-signup cap, and the auth
// challenge/verify gate that fronts signature verification.
//
// The trustworthy value already existed and was never read. nginx.conf runs
// `set_real_ip_from` over Cloudflare's ranges with
// `real_ip_header CF-Connecting-IP`, so `proxy_set_header X-Real-IP
// $remote_addr` carries the true client address — written by our proxy, and a
// client-sent copy is overwritten rather than merged.
//
// Precedence, in descending order of who we trust to have written it:
//   1. x-real-ip     — our nginx. Not forgeable through the proxy.
//   2. RIGHTMOST xff — the hop appended by the proxy nearest us. For a
//                      deployment fronted differently this is the best
//                      available guess, and unlike the leftmost it is not
//                      pure client input.
//   3. socket peer   — a direct, unproxied connection.
//
// Someone who can reach the backend port directly, bypassing nginx, can still
// forge x-real-ip. That is the perimeter's job (F-098 restricts 80/443 to
// Cloudflare and the backend port is not published to the host); this function
// assumes that perimeter rather than substituting for it.

// `headers` is a plain object (req.headers); `socketAddress` is
// req.socket.remoteAddress. Kept free of the request object so it is testable
// without constructing an express req.
export function resolveClientIp(headers, socketAddress) {
    const h = headers || {};

    const realIp = String(h['x-real-ip'] || '').trim();
    if (realIp) return realIp;

    const xff = String(h['x-forwarded-for'] || '').trim();
    if (xff) {
        const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
    }

    const sock = String(socketAddress || '').trim();
    return sock || 'unknown';
}
