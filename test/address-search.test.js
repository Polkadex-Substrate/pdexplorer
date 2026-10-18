// Address search showed Page not found: performSearch passes "/account/<addr>" and
// routeTo only matches "account/<addr>", so navigateTo must drop the slash for both.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, stripComments, bodyOf } from './helpers/source.js';

const src = stripComments(readRepo('script.js', import.meta.url));
const ADDR = 'esoEt6uZ9vs23yW8aqTACLf1tViGpSLZKnhPXt5Nq7vQwHGew';

// Run the real navigateTo with the browser and routeTo stubbed; report the URL and route.
function navigate(target, opts) {
    const seen = {};
    const history = { pushState: (s, t, url) => { seen.url = url; }, replaceState: (s, t, url) => { seen.url = url; } };
    const window = { location: { pathname: '/search', hash: '' } };
    const navigateTo = new Function('window', 'history', 'routeTo',
        `let spaNavDepth = 0; ${bodyOf(src, 'navigateTo')} return navigateTo;`)(window, history, r => { seen.route = r; });
    navigateTo(target, opts);
    return seen;
}

describe('navigateTo gives routeTo the path without the leading slash', () => {
    test('an address search opens the account page', () => {
        assert.deepEqual(navigate(`/account/${ADDR}`, { replace: true }), { url: `/account/${ADDR}`, route: `account/${ADDR}` });
    });

    test('callers that pass no slash route as before', () => {
        assert.equal(navigate(`account/${ADDR}`).route, `account/${ADDR}`);
        assert.equal(navigate('validators').route, 'validators');
        assert.equal(navigate('').route, 'home');
    });
});
