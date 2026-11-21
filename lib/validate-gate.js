// The flag for the Validate area (validator status and, in later sprints,
// setup and manage). Off unless FEATURE_FLAGS.validate is true (everyone), or
// per browser: ?validate=1 stores pdex_validate_enabled=1, ?validate=0 removes
// it. The same pattern as lib/walletconnect-gate.js. With it off there is no
// nav entry and /validate renders the not-found page; the API routes stay
// (they are read-only). Tested in test/validator-status.test.js.

export const VALIDATE_FLAG_KEY = 'pdex_validate_enabled';

export function validateEnabled({ flag = false, storage, search = '' }) {
    if (flag) return true;
    let param = null;
    try { param = new URLSearchParams(search || '').get('validate'); } catch (e) { param = null; }
    try {
        if (param === '1') storage.setItem(VALIDATE_FLAG_KEY, '1');
        else if (param === '0') storage.removeItem(VALIDATE_FLAG_KEY);
        return storage.getItem(VALIDATE_FLAG_KEY) === '1';
    } catch (e) {
        return false;   // private mode, full quota: off
    }
}

// The sitemap entries of the Validate area (server.js buildSitemapXml): none
// while FEATURE_FLAGS.validate is off for everyone (a browser's ?validate=1
// does not count); when on, the public node guide and every help article
// behind the flag, and the session keys checker (/validate/keys, no wallet
// needed). The wallet dashboard (/validate) and the wizard (/validate/setup)
// are per wallet and stay out.
export function validateSitemapRoutes(on, topics = []) {
    if (!on) return [];
    return [{ path: '/validate/node', changefreq: 'monthly', priority: '0.6' }, { path: '/validate/keys', changefreq: 'monthly', priority: '0.5' }]
        .concat((topics || []).filter(t => t && t.flag === 'validate').map(t => ({ path: '/help/' + t.slug, changefreq: 'monthly', priority: '0.5' })));
}
