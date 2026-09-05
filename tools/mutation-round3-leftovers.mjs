// Mutation harness for the round-2 leftovers closed in round 3.
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const M = [
  ['docker-compose.yml', 'certbot renew --deploy-hook "$$FIXPERMS"', 'certbot renew',
   'F-179 renew no longer restores group-101 readability'],
  ['docker-compose.yml', "chgrp -R 101 /etc/letsencrypt/live", "chgrp -R nginx /etc/letsencrypt/live",
   'F-179 chgrp by NAME resolves against the wrong /etc/group'],
  ['docker-compose.yml', "-name '*.pem' -exec chmod 0640", "-name '*.pem' -exec chmod 0644",
   'F-179 private key becomes world-readable'],
  ['deploy.sh', 'bash ./tools/align-cert-name.sh "$DOMAIN" "$CERTBOT_PATH" ./nginx.conf || true', ':',
   'F-189 deploy.sh stops aligning the cert name'],
  ['tools/align-cert-name.sh', 'ln -sfn "$DOMAIN" "$live_dir/$want"', 'ln -sfn "$live_dir/$DOMAIN" "$live_dir/$want"',
   'F-189 absolute symlink target dangles inside the container'],
  ['tools/align-cert-name.sh', 'if [ -d "$live_dir/$want" ] && [ ! -L "$live_dir/$want" ]; then', 'if false; then',
   'F-189 clobbers a real directory holding a private key'],
  ['tools/migrate-hash-ids.mjs', 'onForkDelete: (heights) => {', 'onForkDeleteDISABLED: (heights) => {',
   'F-182 operator script drops fork-deleted heights again'],
  ['tools/migrate-hash-ids.mjs', 'INSERT INTO scan_failures', 'SELECT 1 -- INSERT INTO scan_failures',
   'F-182 fork-deleted heights are not queued for re-crawl'],
  ['tools/pin-image-digests.sh', 'WRITE=0', 'WRITE=1',
   'F-150 pinner rewrites build files without being asked'],
  // Re-pointed: the --format template changed when empty-RepoDigests handling
  // was added (an image present but never pulled from a registry), so the old
  // exact string stopped existing and this became a SKIP.
  ['tools/pin-image-digests.sh', 'docker image inspect "$tag" --format', 'echo sha256:fake #',
   'F-150 digest no longer read from the daemon'],
];

let survived = 0, skipped = 0;
for (const [file, from, to, label] of M) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(from)) { console.log(`SKIP     ${label}`); skipped++; continue; }
  copyFileSync(file, `${file}.bak`);
  writeFileSync(file, src.replace(from, to));
  let caught = false;
  try { execSync("node --test 'test/**/*.test.js' 2>&1 | grep -q '# fail 0'", { stdio: 'pipe' }); }
  catch { caught = true; }
  copyFileSync(`${file}.bak`, file); rmSync(`${file}.bak`, { force: true });
  if (caught) console.log(`KILLED   ${label}`);
  else { console.log(`SURVIVED ${label}   <-- NOT COVERED`); survived++; }
}
console.log(`\n${M.length} mutants: ${M.length - survived - skipped} killed, ${survived} survived, ${skipped} skipped`);
process.exit(survived ? 1 : 0);
