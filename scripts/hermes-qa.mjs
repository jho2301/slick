#!/usr/bin/env node
/**
 * Hands-on check of the Hermes profile panel, end to end, against nothing real.
 *
 *     node scripts/hermes-qa.mjs            # headless: exercises the API
 *     node scripts/hermes-qa.mjs --serve    # leaves a daemon up to click at
 *
 * It builds a throwaway Slick workspace *and* a throwaway HERMES_HOME with two
 * profiles in it, then drives `/api/hermes/*` against them. The real `~/.slick`
 * and the real `~/.hermes` are never opened: `home` is a temp dir and the
 * daemon is handed a `hermesEnv` pointing at another one.
 *
 * With a real Hermes importable it uses it (so the YAML round-trip is the real
 * one). Without, it falls back to the stub package the test suite uses and says
 * so. Either way no model is ever called — this reads and writes a config file.
 *
 * `--serve` prints a URL with a token in it: open that, unfold "Hermes" in the
 * rail, and the two profiles are `default` and `work`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '@slick/server';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STUB = join(REPO, 'packages', 'server', 'test', 'fixtures', 'hermes-stub');
const serveMode = process.argv.includes('--serve');

let problems = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) problems += 1;
};

/** A real Hermes if there is one, else the stub the tests use. */
function pickPython() {
  const real = process.env.SLICK_HERMES_TEST_PYTHON ?? join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');
  if (existsSync(real)) {
    try {
      execFileSync(real, ['-c', 'import hermes_cli.config'], { stdio: 'ignore', timeout: 30_000 });
      return { python: real, real: true, extra: {} };
    } catch {
      /* installed but not importable */
    }
  }
  return { python: 'python3', real: false, extra: { PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1' } };
}

const CONFIG_YAML = [
  'model:',
  '  default: "qa-model"',
  '  provider: "openai-codex"',
  '  key_env: "QA_KEY_POINTER"',
  'qa_untouched_key: "must survive"',
  '',
].join('\n');

const hermesHome = mkdtempSync(join(tmpdir(), 'slick-qa-hermes-'));
const slickHome = mkdtempSync(join(tmpdir(), 'slick-qa-ws-'));
const workDir = join(hermesHome, 'profiles', 'work');
mkdirSync(workDir, { recursive: true });

const { python, real, extra } = pickPython();
// The stub persists JSON; a real Hermes persists YAML. Seed whichever applies.
const configFile = real ? 'config.yaml' : 'config.json';
const seed = real ? CONFIG_YAML : JSON.stringify({ model: { default: 'qa-model', provider: 'openai-codex', key_env: 'QA_KEY_POINTER' }, qa_untouched_key: 'must survive' }, null, 2);
writeFileSync(join(hermesHome, configFile), seed);
writeFileSync(join(workDir, configFile), seed.replace('qa-model', 'qa-work-model'));

const app = createServer({
  home: slickHome,
  hermesEnv: { PATH: process.env.PATH, SLICK_HERMES_PYTHON: python, HERMES_HOME: hermesHome, ...extra },
});
const { url } = await app.listen(0);
const api = (method, path, body) =>
  fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${app.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

console.log(`\nHermes profile panel QA`);
console.log(`  interpreter : ${python} (${real ? 'REAL Hermes' : 'stub — install-free fallback'})`);
console.log(`  HERMES_HOME : ${hermesHome}`);
console.log(`  workspace   : ${slickHome}\n`);

const listed = await api('GET', '/api/hermes/profiles');
check('both profiles are listed, default first', JSON.stringify(listed.body.profiles?.map((p) => p.name)) === '["default","work"]', JSON.stringify(listed.body));

const before = await api('GET', '/api/hermes/profiles/work/model');
check('the work profile reports its own configured model', before.body.defaults?.model === 'qa-work-model', JSON.stringify(before.body.defaults));
check('no credential pointer on the wire', !JSON.stringify(before.body).includes('QA_KEY_POINTER'));
check('a catalog came back, or a reason it did not', (before.body.providers?.length ?? 0) > 0 || Boolean(before.body.error || before.body.catalogError));

const target = before.body.providers?.find((p) => (p.models?.length ?? 0) > 0);
if (target) {
  const wanted = { provider: target.value, model: target.models[0].value };
  const saved = await api('PUT', '/api/hermes/profiles/work/model', wanted);
  check('saving both fields answers with the config read back', saved.body.defaults?.provider === wanted.provider && saved.body.defaults?.model === wanted.model, JSON.stringify(saved.body));

  const again = await api('GET', '/api/hermes/profiles/work/model');
  check('and it survives a reload', again.body.defaults?.model === wanted.model, JSON.stringify(again.body.defaults));

  const untouched = readFileSync(join(hermesHome, configFile), 'utf8');
  check('the other profile was not opened', untouched.includes('qa-model') && !untouched.includes(wanted.model));
  check('a key Slick never heard of survived', readFileSync(join(workDir, configFile), 'utf8').includes('must survive'));
  check('so did the credential pointer', readFileSync(join(workDir, configFile), 'utf8').includes('QA_KEY_POINTER'));
} else {
  console.log('  ..    no provider with models here; skipping the write checks');
}

check('a traversal is refused', [404, 422].includes((await api('PUT', '/api/hermes/profiles/..%2F..%2Fetc/model', { provider: 'a', model: 'b' })).status));
check('a half-set pair is refused', (await api('PUT', '/api/hermes/profiles/work/model', { provider: 'anthropic', model: '' })).status === 422);
check(
  'and none of it answers anonymously',
  (await fetch(`${url}/api/hermes/profiles`)).status === 401
);

console.log(problems === 0 ? '\nAll checks passed.' : `\n${problems} problem(s).`);

if (serveMode) {
  console.log(`\nOpen: ${url}/?token=${app.token}`);
  console.log('Unfold "Hermes" in the rail. Ctrl-C to stop and clean up.\n');
  process.on('SIGINT', async () => {
    await app.close();
    rmSync(slickHome, { recursive: true, force: true });
    rmSync(hermesHome, { recursive: true, force: true });
    process.exit(problems === 0 ? 0 : 1);
  });
} else {
  await app.close();
  rmSync(slickHome, { recursive: true, force: true });
  rmSync(hermesHome, { recursive: true, force: true });
  process.exit(problems === 0 ? 0 : 1);
}
