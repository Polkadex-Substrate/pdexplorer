import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreStaleBackups } from '../tools/lib/restore-bak.mjs';

test('restoreStaleBackups puts the original back and removes .bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), 'MUTATED');
  fs.writeFileSync(path.join(dir, 'lib', 'a.js.bak'), 'ORIGINAL');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.bak'), 'keep');
  const restored = restoreStaleBackups(dir);
  assert.deepEqual(restored, [path.join(dir, 'lib', 'a.js')]);
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'a.js'), 'utf8'), 'ORIGINAL');
  assert.ok(!fs.existsSync(path.join(dir, 'lib', 'a.js.bak')));
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'x.bak')));
  assert.deepEqual(restoreStaleBackups(dir), []);
});
