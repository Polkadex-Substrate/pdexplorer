// Writes test/snapshots/wp3-frozen-text.json, the snapshot test/wp3-freeze.test.js compares against: the
// frozen string tables and the text, fields and actions of every WP3 view state (test/helpers/wp3-world.js).
// Run ONCE, on the code before the WP3 restyle, and commit the file; never run it to make a red test pass.
//
//   node --experimental-sqlite test/helpers/wp3-freeze-snapshot.mjs

import { writeFileSync } from 'node:fs';
import { collectTables, collectStates } from './wp3-freeze-collect.js';

const out = new URL('../snapshots/wp3-frozen-text.json', import.meta.url);
const tables = await collectTables();
const states = await collectStates();
writeFileSync(out, JSON.stringify({ tables, states }, null, 1) + '\n');
console.log(`wrote ${Object.keys(tables).length} table strings and ${Object.keys(states).length} states`);
process.exit(0);
