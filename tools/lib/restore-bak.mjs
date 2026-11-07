// Crash-safety for the mutation harnesses. A harness copies file -> file.bak,
// rewrites file, runs the suite, then copies file.bak back. If the process is
// interrupted in between, file.bak is the only copy of the original.
import { readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git']);

// Restore every <file>.bak under root over <file>, then delete the .bak.
// Returns the list of restored files. Safe to call when nothing is stale.
export function restoreStaleBackups(root = '.') {
  const restored = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); }
      else if (e.name.endsWith('.bak')) {
        const orig = p.slice(0, -4);
        try { copyFileSync(p, orig); rmSync(p, { force: true }); restored.push(orig); } catch { /* keep .bak */ }
      }
    }
  };
  walk(root);
  return restored;
}
