// Which Open Graph card a URL path shows. Import-free apart from the generated
// card map, so the build step, the SPA and the tests all share this one rule.
//
// The rule is the same one nginx applies (nginx.conf, `map $uri
// $og_section_shell`), and test/og-images.test.js checks the two agree:
//
//   /democracy               exact section route   -> democracy card, full shell
//   /democracy/referendum/5  first segment matches -> democracy card, "deep"
//                            shell (no canonical, no og:url: the section's
//                            canonical would tell Google the referendum page
//                            is a duplicate of /democracy)
//   /block/123, /help/x      no section            -> home card (index.html)

import { OG_CARDS, OG_ROUTES } from './og-images.js';

export const OG_ORIGIN = 'https://explorer.polkadex.ee';

// File name of the prefix-fallback shell inside each section directory. The
// leading underscore keeps it out of the SPA's route space.
export const OG_DEEP_SHELL = '_deep.html';

export function normalizeOgPath(pathname) {
    let p = String(pathname || '/').split(/[?#]/)[0];
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+$/, '');
    return p || '/';
}

// { route, deep } for a section path, or null when the home card applies.
export function ogRouteFor(pathname) {
    const path = normalizeOgPath(pathname);
    const exact = OG_ROUTES.find(r => r.path === path);
    if (exact) return { route: exact, deep: false };
    const first = '/' + path.split('/')[1];
    if (first === path || first === '/') return null;
    const section = OG_ROUTES.find(r => r.path === first);
    return section ? { route: section, deep: true } : null;
}

export function ogCardFor(pathname) {
    const m = ogRouteFor(pathname);
    return OG_CARDS[m ? m.route.card : 'home'];
}

export function ogImageUrl(card) {
    return OG_ORIGIN + card.file;
}
