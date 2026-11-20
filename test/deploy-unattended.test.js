// deploy.sh must run to the end without anyone at the keyboard.
//
// The operator was stopped twice on every deploy: a gpg "overwrite?" prompt
// (Docker's apt key, because the script wrongly decided Docker was missing) and
// a certificate "replace?" prompt (because the script wrongly decided there was
// no certificate). Both wrong conclusions are now small shell functions in
// tools/deploy-detect.sh and are tested here against a fake root and stub
// commands, not by matching text. A guard scans the scripts for anything that
// can wait for a terminal.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripComments } from './helpers/source.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const LIB = path.join(ROOT, 'tools/deploy-detect.sh');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-unattended-')); });
after(() => {
    // permissions were changed in some cases; make everything removable first
    const walk = (d) => {
        try { fs.chmodSync(d, 0o755); } catch { return; }
        for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(d, e.name));
    };
    walk(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function sandbox() {
    const d = path.join(tmp, `case${++n}`);
    fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(d, 'root'), { recursive: true });
    return d;
}
function stub(dir, name, body) {
    const p = path.join(dir, 'bin', name);
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}
// Run a snippet that has sourced the library. PATH holds ONLY the stub dir, so
// anything the library needs beyond shell builtins would show up as a failure.
function lib(dir, snippet, env = {}) {
    const r = spawnSync('/bin/bash', ['-c', `source "${LIB}"; ${snippet}`], {
        encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: path.join(dir, 'bin'), DETECT_ROOT: path.join(dir, 'root'), ...env },
    });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const mkcert = (dir, domain) => {
    const live = path.join(dir, 'certbot/conf/live', domain);
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'fullchain.pem'), 'CERT\n');
    return path.join(dir, 'certbot/conf/live');
};

describe('docker detection', () => {
    test('found on PATH', () => {
        const d = sandbox(); stub(d, 'docker', 'exit 0');
        const r = lib(d, 'deploy_detect_docker; echo "$?|$DOCKER_DETECT"');
        assert.match(r.out, /^0\|path:/, r.err);
    });
    test('found only by binary path', () => {
        const d = sandbox();
        fs.mkdirSync(path.join(d, 'root/usr/local/bin'), { recursive: true });
        fs.writeFileSync(path.join(d, 'root/usr/local/bin/docker'), '');
        const r = lib(d, 'deploy_detect_docker; echo "$?|$DOCKER_DETECT"');
        assert.equal(r.out, '0|binary:/usr/local/bin/docker', r.err);
    });
    test('found only by the docker.service unit file', () => {
        const d = sandbox();
        fs.mkdirSync(path.join(d, 'root/lib/systemd/system'), { recursive: true });
        fs.writeFileSync(path.join(d, 'root/lib/systemd/system/docker.service'), '');
        const r = lib(d, 'deploy_detect_docker; echo "$?|$DOCKER_DETECT"');
        assert.equal(r.out, '0|unit:/lib/systemd/system/docker.service', r.err);
    });
    test('not found anywhere', () => {
        const d = sandbox();
        const r = lib(d, 'deploy_detect_docker; echo "$?|$DOCKER_DETECT"');
        assert.equal(r.out, '1|none', r.err);
    });
});

describe('certificate detection', () => {
    const detect = (d, dom = 'explorer.test', env = {}) =>
        lib(d, `deploy_detect_cert "${d}/certbot" "${dom}"; echo "$?|$CERT_DETECT"`, env);

    test('found by exact path', () => {
        const d = sandbox(); mkcert(d, 'explorer.test');
        assert.equal(detect(d).out, '0|exact');
    });
    test('found by glob when the live directory has another name', () => {
        const d = sandbox(); mkcert(d, 'other.test');
        assert.equal(detect(d).out, '0|glob');
    });
    test('exact path works where the glob cannot (live/ is search-only)', { skip: isRoot ? 'running as root: permissions do not bite, case skipped' : false }, () => {
        const d = sandbox(); const live = mkcert(d, 'explorer.test');
        fs.chmodSync(live, 0o111);
        // precondition: this is the situation the glob gets wrong
        const g = spawnSync('/bin/bash', ['-c', `compgen -G "${live}/*/fullchain.pem"`], { encoding: 'utf8' });
        assert.notEqual(g.status, 0, 'precondition: the glob should fail on a search-only directory');
        assert.equal(detect(d, 'explorer.test', { DETECT_SUDO: '/nonexistent-sudo' }).out, '0|exact');
    });
    test('unreadable tree, found only through sudo -n', { skip: isRoot ? 'running as root: permissions do not bite, case skipped' : false }, () => {
        const d = sandbox(); const live = mkcert(d, 'explorer.test');
        fs.chmodSync(live, 0o000);
        stub(d, 'sudo', 'exit 0');
        assert.match(detect(d).out, /^0\|sudo-/);
    });
    test('unreadable tree and no sudo: reported as unreadable, not as missing', { skip: isRoot ? 'running as root: permissions do not bite, case skipped' : false }, () => {
        const d = sandbox(); const live = mkcert(d, 'explorer.test');
        fs.chmodSync(live, 0o000);
        const r = detect(d, 'explorer.test', { DETECT_SUDO: '/nonexistent-sudo' });
        assert.equal(r.out, '2|unreadable');
    });
    test('readable empty tree: not found', () => {
        const d = sandbox(); fs.mkdirSync(path.join(d, 'certbot/conf/live'), { recursive: true });
        assert.equal(detect(d, 'explorer.test', { DETECT_SUDO: '/nonexistent-sudo' }).out, '1|none');
    });
    test('no certbot directory at all: not found', () => {
        const d = sandbox();
        assert.equal(detect(d, 'explorer.test', { DETECT_SUDO: '/nonexistent-sudo' }).out, '1|none');
    });
});

describe('sudo state and the summary line', () => {
    test('root, passwordless, password-required, absent', () => {
        const d = sandbox();
        assert.equal(lib(d, 'deploy_sudo_state', { DETECT_EUID: '0' }).out, 'root');
        assert.equal(lib(d, 'deploy_sudo_state', { DETECT_EUID: '1000' }).out, 'absent');
        stub(d, 'sudo', 'exit 0');
        assert.equal(lib(d, 'deploy_sudo_state', { DETECT_EUID: '1000' }).out, 'passwordless');
        stub(d, 'sudo', 'exit 1');
        assert.equal(lib(d, 'deploy_sudo_state', { DETECT_EUID: '1000' }).out, 'password-required');
    });
    test('the summary line is one line carrying the four facts', () => {
        const d = sandbox(); mkcert(d, 'explorer.test'); stub(d, 'docker', 'exit 0');
        const r = lib(d, `DOCKER_STATE=found; deploy_detect_docker; deploy_detect_cert "${d}/certbot" explorer.test; SUDO_STATE=root; deploy_summary_line "${d}/certbot" explorer.test`, { USER: 'someone' });
        assert.equal(r.out.split('\n').length, 1, r.out);
        assert.match(r.out, /^deploy-check: /);
        for (const k of ['user=someone', 'sudo=root', 'docker=installed', 'cert=exact', `domain=explorer.test`, 'certbot_path=']) {
            assert.ok(r.out.includes(k), `missing ${k} in: ${r.out}`);
        }
    });
});

describe('init-letsencrypt.sh as deploy.sh now calls it', () => {
    test('keeps an existing certificate, exits 0, never waits for input', () => {
        const d = sandbox(); mkcert(d, 'explorer.test');
        const pem = path.join(d, 'certbot/conf/live/explorer.test/fullchain.pem');
        const before = fs.statSync(pem);
        fs.writeFileSync(path.join(d, '.env'), `DOMAIN=explorer.test\nLETSENCRYPT_EMAIL=a@example.test\nCERTBOT_PATH=${d}/certbot\n`);
        const r = spawnSync('/bin/bash', [path.join(ROOT, 'init-letsencrypt.sh')], {
            cwd: d, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH, NONINTERACTIVE: '1', FORCE: '0' },
        });
        assert.equal(r.error, undefined, 'it hung or failed to start: ' + r.error);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /keeping it/);
        assert.equal(fs.readFileSync(pem, 'utf8'), 'CERT\n');
        assert.equal(fs.statSync(pem).mtimeMs, before.mtimeMs);
    });
});

describe('certificate replacement needs the flag on this deploy command line', () => {
    // Run init-letsencrypt.sh the way deploy.sh calls it: stdin closed, NONINTERACTIVE=1.
    // docker, sudo and curl are stubs that fail, so nothing can touch the network or docker.
    function run(envFile, extraEnv) {
        const d = sandbox(); mkcert(d, 'explorer.test');
        for (const t of ['sudo', 'docker', 'docker-compose', 'curl']) stub(d, t, 'exit 97');
        fs.mkdirSync(path.join(d, 'certbot/conf'), { recursive: true });
        fs.writeFileSync(path.join(d, 'certbot/conf/options-ssl-nginx.conf'), 'ssl_protocols\n');
        fs.writeFileSync(path.join(d, 'certbot/conf/ssl-dhparams.pem'), 'BEGIN DH PARAMETERS\n');
        const pem = path.join(d, 'certbot/conf/live/explorer.test/fullchain.pem');
        const before = fs.statSync(pem);
        fs.writeFileSync(path.join(d, '.env'), `DOMAIN=explorer.test\nLETSENCRYPT_EMAIL=a@example.test\nCERTBOT_PATH=${d}/certbot\n${envFile}`);
        const r = spawnSync('/bin/bash', [path.join(ROOT, 'init-letsencrypt.sh')], {
            cwd: d, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: `${path.join(d, 'bin')}:/usr/bin:/bin`, NONINTERACTIVE: '1', ...extraEnv },
        });
        assert.equal(r.error, undefined, 'it hung or failed to start: ' + r.error);
        return { r, pem, before };
    }
    function assertKept({ r, pem, before }) {
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /keeping it/);
        assert.equal(fs.readFileSync(pem, 'utf8'), 'CERT\n');
        assert.equal(fs.statSync(pem).mtimeMs, before.mtimeMs);
    }
    test('FORCE=1 in .env does not replace the certificate', () => {
        assertKept(run('FORCE=1\n', { DEPLOY_FORCE_REPLACE_CERT: '0' }));
    });
    test('FORCE=1 in .env with no decision from deploy.sh does not replace it either', () => {
        assertKept(run('FORCE=1\n', {}));
    });
    test('FORCE=1 exported in the shell (or kept by sudo -E) does not replace it', () => {
        assertKept(run('', { FORCE: '1', DEPLOY_FORCE_REPLACE_CERT: '0' }));
    });
    test('.env cannot set the deploy decision itself', () => {
        assertKept(run('FORCE=1\nDEPLOY_FORCE_REPLACE_CERT=1\n', { DEPLOY_FORCE_REPLACE_CERT: '0' }));
    });
    test('the decision from deploy.sh (DEPLOY_FORCE_REPLACE_CERT=1) does go past the keep branch', () => {
        const { r } = run('', { DEPLOY_FORCE_REPLACE_CERT: '1' });
        assert.ok(!/keeping it/.test(r.stdout), r.stdout);
    });
});

describe('deploy.sh wiring', () => {
    const deploy = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
    const code = stripComments(deploy, { line: '#', block: false });

    test('fails at the start, in one clear line, when sudo needs a password', { skip: isRoot ? 'running as root: sudo is not needed' : false }, () => {
        const d = sandbox(); stub(d, 'sudo', 'exit 1');
        const r = spawnSync('/bin/bash', [path.join(ROOT, 'deploy.sh')], {
            encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: `${path.join(d, 'bin')}:/usr/bin:/bin`, DEPLOY_DIR: path.join(d, 'nowhere') },
        });
        assert.equal(r.error, undefined, 'hung: ' + r.error);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /sudo.*password/i);
        assert.ok(!/Detected OS/.test(r.stdout), 'must fail before doing any work');
    });
    test('calls init-letsencrypt.sh only with NONINTERACTIVE=1', () => {
        const calls = code.split('\n').filter(l => /init-letsencrypt\.sh/.test(l) && /\bbash\b/.test(l) && !/echo/.test(l));
        assert.ok(calls.length >= 1);
        for (const l of calls) assert.match(l, /NONINTERACTIVE=1/, l);
    });
    test('stdin is closed unless INTERACTIVE=1, git cannot prompt, pull has no editor', () => {
        assert.match(code, /INTERACTIVE:-0.*!= *"?1"?[\s\S]{0,40}exec <\/dev\/null/);
        assert.match(code, /GIT_TERMINAL_PROMPT=0/);
        assert.match(code, /git pull --no-edit origin main/);
    });
    test('replacement is the --force-replace-cert argument only; FORCE from the environment is never read', () => {
        assert.match(code, /--force-replace-cert\)/);
        assert.ok(!/\$\{?FORCE\b/.test(code), 'deploy.sh must not read FORCE');
        const calls = code.split('\n').filter(l => /init-letsencrypt\.sh/.test(l) && /\bbash\b/.test(l) && !/echo/.test(l));
        for (const l of calls) assert.match(l, /DEPLOY_FORCE_REPLACE_CERT=/, l);
        assert.ok(!calls.some(l => /\bFORCE=/.test(l.replace(/DEPLOY_FORCE_REPLACE_CERT=/g, ''))), 'no FORCE= on the call');
    });
    test('an unknown argument stops the deploy before any work', () => {
        const d = sandbox();
        const r = spawnSync('/bin/bash', [path.join(ROOT, 'deploy.sh'), '--bogus'], {
            encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: `${path.join(d, 'bin')}:/usr/bin:/bin`, DEPLOY_DIR: path.join(d, 'nowhere') },
        });
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.match(r.stdout + r.stderr, /--force-replace-cert/);
    });
    test('RUN_LETSENCRYPT wording does not claim it fetches TLS files when a certificate exists', () => {
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        assert.ok(!/only fetches missing TLS parameter files/.test(readme));
        assert.ok(!/only fetches missing TLS parameter files/.test(deploy));
        assert.ok(!/\| `FORCE=1` \|/.test(readme), 'README switch table still lists FORCE=1 as a switch');
        assert.match(readme, /--force-replace-cert/);
    });
    test('a docker install is conditional on the detection function, not on command -v alone', () => {
        assert.match(code, /if ! deploy_detect_docker/);
        assert.ok(!/if ! command -v docker/.test(code));
    });
});

// ---- the guard --------------------------------------------------------------
// Returns a list of human-readable offences in a shell source.
export function findOffences(src, name = 'script') {
    const out = [];
    const lines = stripComments(src, { line: '#', block: false }).split('\n');
    lines.forEach((l, i) => {
        const at = `${name}: ${l.trim()}`;
        // 1. a read from the terminal. `while read` over a pipe or a file is fine.
        if (/(^\s*|[;&|]\s*|\{\s*|\bthen\s+|\bdo\s+)read\s/.test(l) && !/^\s*while\b/.test(l) && !/(<|\|\s*while)/.test(l)) {
            out.push(`${at}  <- reads from the terminal; an unattended deploy would hang`);
        }
        if (/(^\s*|[;&|]\s*|\bdo\s+)read\s+(-\w*\s+)*-p\b/.test(l)) out.push(`${at}  <- read -p prompt`);
        // 2. gpg --dearmor asks "File exists. Overwrite?" without --batch --yes
        if (/\bgpg\b/.test(l) && /--dearmor/.test(l) && !(/--batch/.test(l) && /--yes/.test(l))) {
            out.push(`${at}  <- gpg --dearmor needs --batch --yes`);
        }
        // 3. package installs/upgrades need the non-interactive settings
        if (/\bapt-get\b[^|]*\b(install|upgrade|dist-upgrade|remove|purge)\b/.test(l) &&
            !(/DEBIAN_FRONTEND=noninteractive/.test(l) && /NEEDRESTART/.test(l) && /force-confold/.test(l))) {
            out.push(`${at}  <- apt-get without DEBIAN_FRONTEND, NEEDRESTART and force-confold`);
        }
        // 4. compose run/exec allocate a TTY unless -T is given; stdin is /dev/null here
        if (!/^\s*(warn|echo|printf)\b/.test(l) && /(\$DC\b|\$\{DC\}|docker[ -]compose)\b[^|;&]*\s(run|exec)\s/.test(l) && !/\s-T\b/.test(l)) {
            out.push(`${at}  <- compose run/exec without -T`);
        }
    });
    return out;
}

describe('guard: nothing in the deploy path can wait for a keyboard', () => {
    for (const f of ['deploy.sh', 'provision-ubuntu.sh', 'tools/deploy-detect.sh', 'tools/align-cert-name.sh', 'tools/fix-cert-perms.sh']) {
        test(f, () => {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            assert.deepEqual(findOffences(src, f), []);
        });
    }
    // init-letsencrypt.sh keeps a terminal prompt for an operator running it by hand;
    // deploy.sh always calls it with NONINTERACTIVE=1, so only the -T rule applies here.
    test('init-letsencrypt.sh: every compose run/exec has -T', () => {
        const src = fs.readFileSync(path.join(ROOT, 'init-letsencrypt.sh'), 'utf8');
        assert.deepEqual(findOffences(src, 'init-letsencrypt.sh').filter(o => /without -T/.test(o)), []);
    });
    test('the apt wrappers carry all three settings', () => {
        const dep = fs.readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
        const prov = fs.readFileSync(path.join(ROOT, 'provision-ubuntu.sh'), 'utf8');
        for (const [name, src, re] of [['deploy.sh', dep, /^apt_noninteractive\(\)[\s\S]*?\n\}/m], ['provision', prov, /^apt_quiet\(\)[\s\S]*?\n\}/m]]) {
            const m = src.match(re);
            assert.ok(m, `${name}: wrapper missing`);
            for (const t of ['DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=', 'NEEDRESTART_SUSPEND=1', 'force-confold']) {
                assert.ok(m[0].includes(t), `${name}: wrapper lacks ${t}`);
            }
        }
    });
    test('the guard itself can fail (each rule on a bad sample)', () => {
        assert.equal(findOffences('read -p "ok? " x\n').length > 0, true);
        assert.equal(findOffences('  read answer\n').length > 0, true);
        assert.equal(findOffences('curl x | sudo gpg --dearmor -o /k\n').length, 1);
        assert.equal(findOffences('sudo apt-get install -y foo\n').length, 1);
        assert.equal(findOffences('sudo apt-get upgrade -y\n').length, 1);
        assert.equal(findOffences('sudo $DC run --rm certbot certonly\n').length, 1);
        assert.equal(findOffences('docker compose exec frontend nginx -s reload\n').length, 1);
        assert.deepEqual(findOffences('sudo $DC run --rm -T certbot certonly\n'), []);
        assert.deepEqual(findOffences('docker compose exec -T frontend nginx\n'), []);
        assert.deepEqual(findOffences('sudo $DC -p x up -d --build\n'), []);
        assert.deepEqual(findOffences('warn "  docker compose exec frontend nginx -s reload"\n'), []);
        // and what it must allow
        assert.deepEqual(findOffences('while IFS= read -r c; do :; done < f\n'), []);
        assert.deepEqual(findOffences('cmd | while read -r n; do :; done\n'), []);
        assert.deepEqual(findOffences('IFS=x read -r a b <<< "$p"\n'), []);
        assert.deepEqual(findOffences('gpg --batch --yes --dearmor -o /k\n'), []);
        assert.deepEqual(findOffences('# read -p "in a comment"\n'), []);
    });
});
