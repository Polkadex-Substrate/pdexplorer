// A backtick or ${ inside <!-- --> ends or splices the template literal it sits in.
// F-136's note did that and cut every account page off after "balance reserved".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readRepo } from './helpers/source.js';

const jsIn = dir => readdirSync(new URL(`../${dir}`, import.meta.url))
    .filter(f => f.endsWith('.js')).map(f => (dir ? `${dir}/${f}` : f));

test('no HTML comment in our JS holds a backtick or ${', () => {
    const bad = [...jsIn(''), ...jsIn('lib')].flatMap(file =>
        [...readRepo(file, import.meta.url).matchAll(/<!--[\s\S]*?-->/g)]
            .filter(m => /`|\$\{/.test(m[0])).map(m => `${file}: ${m[0].slice(0, 60)}`));
    assert.deepEqual(bad, []);
});
