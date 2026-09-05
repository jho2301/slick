import { test, describe, beforeAll, beforeEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonObject } from '@slick/core';

import {
  DEFAULT_PROFILE,
  clearUsageCache,
  getProfile,
  hermesRoot,
  listProfiles,
  profileDir,
  readProfileModel,
  readProfileUsage,
  setUsageClock,
  writeProfileModel,
  type Env,
} from '../src/integrations/hermes/hermes.ts';
import { createServer, type SlickServer } from '../src/index.ts';

/** A throwaway HERMES_HOME. Nothing here ever touches the real one. */
function fixtureHome(names: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'slick-hermes-'));
  for (const name of names) mkdirSync(join(home, 'profiles', name), { recursive: true });
  return home;
}

describe('naming a Hermes profile', () => {
  test('the default profile is HERMES_HOME itself, and a named one lives under profiles/', () => {
    const home = fixtureHome();
    try {
      assert.equal(profileDir(DEFAULT_PROFILE, home), home);
      assert.equal(profileDir('work', home), join(home, 'profiles', 'work'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a name that would escape HERMES_HOME is refused rather than resolved', () => {
    const home = fixtureHome();
    try {
      for (const escape of ['..', '../..', 'a/../../b', '/etc', 'work/../../../etc', './..']) {
        assert.throws(
          () => profileDir(escape, home),
          /not a valid Hermes profile name/,
          `"${escape}" must not resolve to a directory`
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Hermes own name rule is the one enforced — no separators, no dots, no spaces', () => {
    const home = fixtureHome();
    try {
      // `_PROFILE_ID_RE` in hermes_cli/profiles.py is ^[a-z0-9][a-z0-9_-]{0,63}$.
      const bad = ['a/b', 'a\b', 'a b', '.hidden', 'a.b', '', '   ', 'x'.repeat(65), '-lead', 'UP'];
      for (const name of bad) {
        assert.throws(() => profileDir(name, home), /not a valid Hermes profile name/, JSON.stringify(name));
      }
      for (const name of ['work', 'a', 'a_b-2', 'x'.repeat(64)]) {
        assert.equal(profileDir(name, home), join(home, 'profiles', name), name);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('which HERMES_HOME the profiles hang off', () => {
  test('a daemon already running under a profile still edits the installation root', () => {
    // `get_default_hermes_root()` in hermes_constants.py does exactly this: a
    // HERMES_HOME of <root>/profiles/<name> is a profile, and <root> is where
    // every profile — including that one — is reachable from.
    assert.equal(hermesRoot({ HERMES_HOME: '/tmp/h/profiles/work' }), '/tmp/h');
    assert.equal(hermesRoot({ HERMES_HOME: '/tmp/h' }), '/tmp/h');
    assert.equal(hermesRoot({ HERMES_HOME: '/tmp/h/profiles' }), '/tmp/h/profiles');
    assert.equal(hermesRoot({ HERMES_HOME: '/tmp/h/profiles/work/' }), '/tmp/h');
  });
});

describe('finding the profiles that exist', () => {
  test('the default is always first, and the named ones follow in name order', () => {
    const home = fixtureHome(['work', 'alpha']);
    try {
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE, 'alpha', 'work']
      );
      assert.equal(listProfiles(home)[0]!.dir, home);
      assert.equal(listProfiles(home)[2]!.dir, join(home, 'profiles', 'work'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a HERMES_HOME with no profiles directory still has its default profile', () => {
    const home = fixtureHome();
    try {
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE]
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile symlinked out of HERMES_HOME is not offered for editing', () => {
    const home = fixtureHome(['work']);
    const outside = mkdtempSync(join(tmpdir(), 'slick-hermes-outside-'));
    try {
      symlinkSync(outside, join(home, 'profiles', 'elsewhere'));
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE, 'work'],
        'a directory that really lives somewhere else is somewhere else'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a profile that is really the installation root under another name is not a profile', () => {
    const home = fixtureHome(['work']);
    try {
      // `profiles/alias -> ..` stays inside HERMES_HOME, so a containment
      // check alone waves it through — and then editing "alias" edits the
      // default profile's own config.yaml under a name that is not `default`.
      symlinkSync(join(home, 'profiles', '..'), join(home, 'profiles', 'alias'));
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE, 'work'],
        'the root has exactly one name here, and it is `default`'
      );
      assert.throws(() => getProfile('alias', home), /No Hermes profile called "alias"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile that is another profile under another name is not offered twice', () => {
    const home = fixtureHome(['work']);
    try {
      symlinkSync(join(home, 'profiles', 'work'), join(home, 'profiles', 'clone'));
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE, 'work'],
        'one directory, one name — an alias would let a save land in a profile nobody named'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('profiles/default is not a second default, and Hermes reserved names are not profiles', () => {
    // `default` is Slick's name for HERMES_HOME itself, and `_RESERVED_NAMES`
    // in hermes_cli/profiles.py refuses the rest outright — `hermes -p test`
    // fails, so a `test` profile Slick offered would be one Hermes cannot run.
    const home = fixtureHome(['default', 'hermes', 'test', 'tmp', 'root', 'sudo', 'work']);
    try {
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE, 'work']
      );
      for (const reserved of ['hermes', 'test', 'tmp', 'root', 'sudo']) {
        assert.throws(() => profileDir(reserved, home), /not a valid Hermes profile name/, reserved);
      }
      assert.equal(getProfile(DEFAULT_PROFILE, home).dir, home, 'the one `default` is still the root');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a config.yaml that is a symlink out of its profile makes that profile unusable', () => {
    const home = fixtureHome(['work']);
    const outside = mkdtempSync(join(tmpdir(), 'slick-hermes-outside-'));
    try {
      writeFileSync(join(outside, 'stolen.yaml'), 'model:\n  default: elsewhere\n');
      symlinkSync(join(outside, 'stolen.yaml'), join(home, 'profiles', 'work', 'config.yaml'));
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        [DEFAULT_PROFILE],
        'the file a save would land in is not inside the profile'
      );
      assert.throws(() => getProfile('work', home), /No Hermes profile called "work"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the default profile is withheld when its own config.yaml points outside', () => {
    const home = fixtureHome(['work']);
    const outside = mkdtempSync(join(tmpdir(), 'slick-hermes-outside-'));
    try {
      writeFileSync(join(outside, 'stolen.yaml'), 'model:\n  default: elsewhere\n');
      symlinkSync(join(outside, 'stolen.yaml'), join(home, 'config.yaml'));
      assert.deepEqual(
        listProfiles(home).map((p) => p.name),
        ['work'],
        'no profile at all is better than one whose saves leave HERMES_HOME'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('naming the profile to read or write', () => {
  test('a blank or padded id is refused rather than quietly meaning `default`', () => {
    const home = fixtureHome(['work']);
    try {
      // Every one of these arrives as `params.name` from a URL. Trimming them
      // into `default` turns `PUT /api/hermes/profiles/%20/model` into a write
      // to the installation's own config.yaml.
      for (const id of ['', ' ', '   ', '\t', ' default', 'default ', ' default ', 'work ', ' work']) {
        assert.throws(() => getProfile(id, home), /not a valid Hermes profile name/, JSON.stringify(id));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an exact valid id still resolves, and a missing one is still a 404', () => {
    const home = fixtureHome(['work']);
    try {
      assert.equal(getProfile(DEFAULT_PROFILE, home).name, DEFAULT_PROFILE);
      assert.equal(getProfile('work', home).dir, join(home, 'profiles', 'work'));
      assert.throws(() => getProfile('ghost', home), /No Hermes profile called "ghost"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------- the bridge ---

/**
 * The bridge runs under the *system* python3 with a stub `hermes_cli` on the
 * path, so no test needs a Hermes installed and none can reach the real one:
 * `SLICK_HERMES_PYTHON` is an interpreter that could not import Hermes if it
 * tried, and `HERMES_HOME` is a directory made for this test.
 */
const STUB = join(import.meta.dirname, 'fixtures', 'hermes-stub');
const bridgeEnv = (extra: Env = {}): Env => ({
  PATH: process.env.PATH,
  SLICK_HERMES_PYTHON: 'python3',
  PYTHONPATH: STUB,
  PYTHONDONTWRITEBYTECODE: '1',
  ...extra,
});

/** A profile whose config already has more in it than Slick knows about. */
function seedConfig(dir: string, config: JsonObject): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

const readConfig = (dir: string): any => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));

/** The catalog as the tests read it: whatever the bridge said, by value. */
interface CatalogProvider {
  value: string;
  custom?: boolean;
  authenticated?: boolean;
  models: { value: string; label: string }[];
}

const providersOf = (answer: { providers: JsonObject[] }): CatalogProvider[] =>
  answer.providers as unknown as CatalogProvider[];

describe('reading a profile through the bridge', () => {
  test('reports the configured provider and model, and the catalog to change them with', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex', key_env: 'SECRET_KEY_NAME' },
        providers: { fano: { base_url: 'https://box/v1' } },
      });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());

      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.profile, DEFAULT_PROFILE);
      assert.deepEqual(answer.defaults, { provider: 'openai-codex', model: 'gpt-6-astra' });

      const providers = providersOf(answer);
      const codex = providers.find((p) => p.value === 'openai-codex')!;
      assert.deepEqual(
        codex.models.map((m) => m.value),
        ['gpt-6-astra', 'gpt-5.6-luna'],
        'exactly the ids Hermes reported, in its order'
      );
      assert.ok(
        providers.some((p) => p.value === 'custom:fano' && p.custom === true),
        'a custom endpoint keeps its custom: slug'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('nothing key-shaped in the config ever reaches the caller', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: {
          default: 'gpt-6-astra',
          provider: 'openai-codex',
          key_env: 'MY_KEY_VAR',
          api_key: 'sk-live-secret',
        },
        providers: { fano: { key_env: 'FANO_KEY', api_key: 'sk-another-secret', base_url: 'https://x/v1' } },
      });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      const wire = JSON.stringify(answer);
      for (const secret of [
        'sk-live-secret',
        'sk-another-secret',
        'MY_KEY_VAR',
        'FANO_KEY',
        'api_key',
        'key_env',
      ]) {
        assert.ok(!wire.includes(secret), `"${secret}" must not be in the payload`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the bare string form of `model:` is read as the model it names', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: 'gpt-6-astra' });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      assert.deepEqual(answer.defaults, { provider: null, model: 'gpt-6-astra' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a Hermes that cannot be imported is said so, not guessed at', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'x' } });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv({ PYTHONPATH: '' }));
      assert.equal(answer.code, 'hermes_unavailable');
      assert.match(answer.error!, /Hermes/);
      assert.deepEqual(answer.providers, [], 'no catalog is better than an invented one');
      assert.deepEqual(answer.defaults, { provider: null, model: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the custom endpoints a profile has configured', () => {
  /** Both shapes Hermes accepts: keyed `providers:` and legacy `custom_providers:`. */
  const CONFIGURED = {
    model: { default: 'gpt-6-astra', provider: 'openai-codex' },
    providers: { fano: { name: 'Fano Box', base_url: 'https://box/v1' } },
    custom_providers: [{ name: 'Old Rig', base_url: 'https://rig/v1' }],
  };

  test('a named custom provider is offered under the exact id Hermes routes it by', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, CONFIGURED);
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      assert.equal(answer.error, null, answer.error ?? '');
      const providers = providersOf(answer);
      const values = providers.map((p) => p.value);

      // `custom_provider_slug` keeps the config *key* as the identity for a
      // keyed entry ("fano", not "fano-box") and the normalised display name
      // for a legacy one. Anything else is an id `model.provider` cannot hold.
      assert.ok(values.includes('custom:fano'), values.join(', '));
      assert.ok(values.includes('custom:old-rig'), values.join(', '));
      for (const value of ['custom:fano', 'custom:old-rig']) {
        assert.equal(providers.find((p) => p.value === value)!.custom, true, value);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the bare `custom` both lists reach for appears exactly once', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, CONFIGURED);
      const values = providersOf(await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv())).map(
        (p) => p.value
      );
      assert.deepEqual(
        values,
        [...new Set(values)],
        'list_available_providers() ends with `custom` and _configured_custom_provider_ids() starts with it'
      );
      assert.equal(values.filter((v) => v === 'custom').length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a configured endpoint gets the models Hermes has for it, and no others', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, CONFIGURED);
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      const byValue = (v: string) => providersOf(answer).find((p) => p.value === v)!;
      assert.deepEqual(
        byValue('custom:fano').models.map((m) => m.value),
        ['local-qwen'],
        'exactly what cached_provider_model_ids() returned'
      );
      assert.deepEqual(
        byValue('custom:old-rig').models,
        [],
        'an endpoint Hermes has no cached models for is offered empty, never guessed at'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile with no custom endpoints gains none', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      const values = providersOf(await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv())).map(
        (p) => p.value
      );
      assert.ok(!values.some((v) => v.startsWith('custom:')), values.join(', '));
      assert.ok(values.includes('custom'), 'the bare one is still Hermes own');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('whose credentials the bridge runs with', () => {
  const SECRET = 'sk-daemon-abcdefghijklmnopqrstuvwxyz';

  test('the daemon own provider credentials do not make a profile look authenticated', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      // The daemon may well have been started with a key in its environment.
      // It is not this profile's key, and a catalog that counts it says
      // "logged in" about a profile that is not.
      const answer = await readProfileModel(
        DEFAULT_PROFILE,
        home,
        bridgeEnv({ STUB_PROVIDER_API_KEY: SECRET })
      );
      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(providersOf(answer).find((p) => p.value === 'anthropic')!.authenticated, false);
      assert.ok(!JSON.stringify(answer).includes(SECRET), 'and it is nowhere on the wire');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('one profile environment cannot make another profile look authenticated', async () => {
    const home = fixtureHome(['work']);
    const work = join(home, 'profiles', 'work');
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      seedConfig(work, { model: { default: 'claude-opus-5', provider: 'anthropic' } });
      // Hermes keeps one `.env` per profile for exactly this reason.
      writeFileSync(join(work, '.env'), `STUB_PROVIDER_API_KEY=${SECRET}\n`);

      const inWork = await readProfileModel('work', home, bridgeEnv());
      const inDefault = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());

      assert.equal(
        providersOf(inWork).find((p) => p.value === 'anthropic')!.authenticated,
        true,
        'its own key counts'
      );
      assert.equal(
        providersOf(inDefault).find((p) => p.value === 'anthropic')!.authenticated,
        false,
        'the profile next door is a different login'
      );
      assert.ok(!JSON.stringify(inWork).includes(SECRET));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('writing a profile through the bridge', () => {
  test('both fields land, and everything else in the file is left alone', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: {
          default: 'gpt-6-astra',
          provider: 'openai-codex',
          key_env: 'SECRET_KEY_NAME',
          context_length: 200000,
        },
        gateway: { platforms: { slick: { enabled: true } } },
      });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        bridgeEnv()
      );

      assert.equal(answer.error, null, answer.error ?? '');
      assert.deepEqual(answer.defaults, { provider: 'anthropic', model: 'claude-sonnet-5' });

      const onDisk = readConfig(home);
      assert.equal(onDisk.model.default, 'claude-sonnet-5');
      assert.equal(onDisk.model.provider, 'anthropic');
      assert.equal(onDisk.model.key_env, 'SECRET_KEY_NAME', 'the credential pointer survives');
      assert.equal(onDisk.model.context_length, 200000);
      assert.deepEqual(onDisk.gateway, { platforms: { slick: { enabled: true } } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('what comes back is what is on disk, read again — not what was asked for', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'a', provider: 'b' } });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-opus-5' },
        home,
        bridgeEnv()
      );
      assert.deepEqual(answer.defaults, readAfterWrite(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the bare string form is upgraded rather than overwritten', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: 'gpt-6-astra' });
      await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        bridgeEnv()
      );
      assert.deepEqual(readConfig(home).model, { default: 'claude-sonnet-5', provider: 'anthropic' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('saving one profile does not touch another', async () => {
    const home = fixtureHome(['work']);
    const work = join(home, 'profiles', 'work');
    try {
      seedConfig(home, { model: { default: 'default-model', provider: 'openai-codex' } });
      seedConfig(work, { model: { default: 'work-model', provider: 'anthropic' } });

      await writeProfileModel('work', { provider: 'custom:fano', model: 'local-qwen' }, home, bridgeEnv());

      assert.deepEqual(readConfig(work).model, { default: 'local-qwen', provider: 'custom:fano' });
      assert.deepEqual(
        readConfig(home).model,
        { default: 'default-model', provider: 'openai-codex' },
        'the profile that was not being edited is untouched'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('switching provider clears the endpoint credentials the old one left behind', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: {
          default: 'local-qwen',
          provider: 'custom:fano',
          base_url: 'https://box/v1',
          api_key: 'sk-endpoint-abcdefghijklmnopqrstuvwxyz',
          api: 'sk-legacy-abcdefghijklmnopqrstuvwxyz',
          api_mode: 'responses',
          key_env: 'SECRET_KEY_NAME',
        },
      });

      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        bridgeEnv()
      );
      assert.equal(answer.error, null, answer.error ?? '');

      // `clear_model_endpoint_credentials` + the base_url drop, which is what
      // hermes_cli/auth.py does on the same switch. A built-in provider
      // resolves its credentials from auth.json and the environment; an inline
      // key left from a custom endpoint is a secret sitting in config.yaml and
      // a contaminated resolution the next time custom is picked.
      const onDisk = readConfig(home).model;
      for (const stale of ['api_key', 'api', 'api_mode', 'base_url']) {
        assert.ok(!(stale in onDisk), `${stale} belonged to the endpoint that was left`);
      }
      assert.equal(onDisk.key_env, 'SECRET_KEY_NAME', 'a pointer to a credential is not a credential');
      assert.equal(onDisk.provider, 'anthropic');
      assert.equal(onDisk.default, 'claude-sonnet-5');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('picking another model on the same provider leaves that endpoint intact', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: {
          default: 'local-qwen',
          provider: 'custom:fano',
          base_url: 'https://box/v1',
          api_key: 'sk-endpoint-abcdefghijklmnopqrstuvwxyz',
          api_mode: 'responses',
        },
      });
      await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'custom:fano', model: 'local-qwen-2' },
        home,
        bridgeEnv()
      );

      const onDisk = readConfig(home).model;
      assert.equal(onDisk.default, 'local-qwen-2');
      assert.equal(onDisk.base_url, 'https://box/v1', 'the endpoint is still the endpoint');
      assert.equal(
        onDisk.api_key,
        'sk-endpoint-abcdefghijklmnopqrstuvwxyz',
        'its key was not switched away from'
      );
      assert.equal(onDisk.api_mode, 'responses');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a config someone else changed between the read and the write is not overwritten', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'a', provider: 'openai-codex' } });
      const writing = writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        bridgeEnv({ SLICK_TEST_LOAD_DELAY_MS: '800' })
      );
      // The bridge has read the file and is holding a copy that is about to be
      // stale. This is the window a whole-document read/modify/write has, and
      // a separate process cannot close it by holding a lock nobody else takes.
      await new Promise((done) => setTimeout(done, 300));
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ ...readConfig(home), note: 'someone else was here' }, null, 2)
      );

      const answer = await writing;
      assert.equal(readConfig(home).note, 'someone else was here', 'the other edit is still on disk');
      assert.equal(answer.code, 'config_conflict', answer.error ?? 'the save should have been refused');
      assert.match(answer.error!, /changed/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a second bridge writer cannot resurrect what the first one cleared', async () => {
    const home = fixtureHome();
    const KEY = 'sk-endpoint-Ab3nQ7zK1mVx9PlR4tYuWs2Dg6Hj8Kc0';
    try {
      seedConfig(home, {
        model: { default: 'local-qwen', provider: 'custom:fano', base_url: 'https://box/v1', api_key: KEY },
        keep_me: { nested: true },
      });

      // Two bridge processes, one file, overlapping windows. The slow one is a
      // same-provider model change, so it *keeps* the endpoint key; the fast
      // one switches provider, so it *clears* it. Serialised, the switch is
      // read by whichever runs second and the file ends up self-consistent.
      // Racing, the slow writer saves a copy it read before the switch and the
      // cleared key comes back — a secret undeleted by a request that had
      // nothing to say about it.
      const slow = writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'custom:fano', model: 'local-qwen-2' },
        home,
        bridgeEnv({ SLICK_TEST_LOAD_DELAY_MS: '800' })
      );
      await new Promise((done) => setTimeout(done, 300));
      const fast = writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        bridgeEnv()
      );

      const answers = await Promise.all([slow, fast]);
      for (const answer of answers) assert.equal(answer.error, null, answer.error ?? '');

      const onDisk = readConfig(home);
      assert.equal(onDisk.model.provider, 'anthropic', 'the writer that went second is the one on disk');
      assert.equal(onDisk.model.default, 'claude-sonnet-5');
      assert.ok(!('api_key' in onDisk.model), 'the endpoint key stayed deleted');
      assert.ok(!('base_url' in onDisk.model), 'and so did the endpoint');
      assert.deepEqual(onDisk.keep_me, { nested: true }, 'and nothing unrelated was dropped');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('concurrent saves of one profile serialise instead of racing', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'a', provider: 'openai-codex' }, keep_me: { nested: true } });
      const env = bridgeEnv({ SLICK_TEST_LOAD_DELAY_MS: '200' });
      const wanted = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5', 'claude-sonnet-4'];

      const answers = await Promise.all(
        wanted.map((model) => writeProfileModel(DEFAULT_PROFILE, { provider: 'anthropic', model }, home, env))
      );

      // Four separate processes, one file. Serialised, every one of them reads
      // a settled config and writes it whole; unserialised, they read the same
      // copy and the losers either clobber or are refused.
      for (const answer of answers) assert.equal(answer.error, null, answer.error ?? '');
      const onDisk = readConfig(home);
      assert.ok(wanted.includes(onDisk.model.default), onDisk.model.default);
      assert.deepEqual(onDisk.keep_me, { nested: true }, 'nothing unrelated was dropped on the way');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a name that is not a profile here is refused before anything is spawned', async () => {
    const home = fixtureHome();
    try {
      await assert.rejects(
        () => writeProfileModel('../../etc', { provider: 'a', model: 'b' }, home, bridgeEnv()),
        /not a valid Hermes profile name/
      );
      await assert.rejects(
        () => writeProfileModel('ghost', { provider: 'a', model: 'b' }, home, bridgeEnv()),
        /No Hermes profile called "ghost"/
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('what a broken bridge is allowed to say', () => {
  /** An interpreter that fails the way a broken install does: loudly, on stderr. */
  function babblingPython(says: string): { path: string; dir: string } {
    const bin = mkdtempSync(join(tmpdir(), 'slick-hermes-python-'));
    const path = join(bin, 'python3');
    writeFileSync(path, `#!/bin/sh\ncat >/dev/null\necho "not json"\necho '${says}' >&2\nexit 1\n`);
    chmodSync(path, 0o755);
    return { path, dir: bin };
  }

  test('a token in a traceback never reaches the browser', async () => {
    const home = fixtureHome();
    const TOKEN = 'sk-live-Ab3nQ7zK1mVx9PlR4tYuWs2Dg6Hj8Kc0';
    const python = babblingPython(`Traceback: OPENAI_API_KEY=${TOKEN} rejected`);
    try {
      seedConfig(home, { model: { default: 'a', provider: 'b' } });
      for (const answer of [
        await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv({ SLICK_HERMES_PYTHON: python.path })),
        await writeProfileModel(
          DEFAULT_PROFILE,
          { provider: 'anthropic', model: 'claude-sonnet-5' },
          home,
          bridgeEnv({ SLICK_HERMES_PYTHON: python.path })
        ),
      ]) {
        // The last lines of a traceback are the diagnosis, so they are worth
        // forwarding — but whatever was interpolated into them is not.
        assert.equal(answer.code, 'bridge_unreadable', answer.error ?? '');
        assert.ok(!JSON.stringify(answer).includes(TOKEN), answer.error ?? '');
        assert.match(answer.error!, /OPENAI_API_KEY/, 'the shape of the failure still survives');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(python.dir, { recursive: true, force: true });
    }
  });
});

describe('what a failure is allowed to say about this machine', () => {
  /**
   * Anything rooted at `/` or `~/` with a directory in it — which is what an
   * exception string leaks when it names a file. Deliberately blind to
   * `anthropic/claude-sonnet-4.5` and `https://box.invalid/v1`: a relative id
   * and a URL are not places on this machine, and redacting them would take
   * the diagnosis out of the diagnosis.
   */
  const LOOKS_LOCAL = /(?<![\w:/])~?\/[A-Za-z0-9_.~+@-]+\/[A-Za-z0-9_.~+@-]*/;

  /**
   * Neither sentence in this answer says where anything is on disk.
   *
   * The two message fields and not the whole payload: `dir` is deliberately an
   * absolute path — it is how the routes above address a profile — and it is
   * destructured away before anything is serialised to a browser. A sentence
   * is the field that has no such boundary to stop at.
   */
  function assertNowhereLocal(
    answer: { catalogError?: string | null; error?: string | null },
    ...forbidden: string[]
  ): void {
    const wire = JSON.stringify({ catalogError: answer.catalogError ?? null, error: answer.error ?? null });
    assert.ok(!LOOKS_LOCAL.test(wire), `a filesystem path reached the caller: ${wire}`);
    for (const path of forbidden) {
      assert.ok(!wire.includes(path), `"${path}" reached the caller: ${wire}`);
    }
  }

  test('a catalog that failed on a file does not say which file, or where', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      const answer = await readProfileModel(
        DEFAULT_PROFILE,
        home,
        bridgeEnv({
          SLICK_TEST_CATALOG_FAIL: `models.json missing: [Errno 2] No such file or directory: '${join(home, 'cache', 'models.json')}'`,
        })
      );

      assert.ok(answer.catalogError, 'the catalog still reports that it failed');
      assertNowhereLocal(answer, home);
      assert.match(answer.catalogError, /No such file or directory/, 'the diagnosis survives the redaction');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a provider id, a model id and an endpoint URL are not mistaken for paths', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      const answer = await readProfileModel(
        DEFAULT_PROFILE,
        home,
        bridgeEnv({
          SLICK_TEST_CATALOG_FAIL:
            'custom:fano at https://box.invalid/v1 has no anthropic/claude-sonnet-4.5, ' +
            `and openai-codex is logged out (from ${join(home, 'cache.json')})`,
        })
      );

      assertNowhereLocal(answer, home);
      for (const keep of [
        'custom:fano',
        'https://box.invalid/v1',
        'anthropic/claude-sonnet-4.5',
        'openai-codex',
      ]) {
        assert.ok(
          answer.catalogError!.includes(keep),
          `"${keep}" is context, not a location: ${answer.catalogError}`
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile .env that cannot be read does not say where it lives', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      // A `.env` that is a directory is the ordinary shape of this: `load_env`
      // opens it, the OS refuses, and the errno string carries the full path.
      mkdirSync(join(home, '.env'));

      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());

      assert.ok(answer.catalogError, 'a profile whose own .env was skipped still says so');
      assertNowhereLocal(answer, home);
      assert.match(answer.catalogError, /\.env/, 'which file it was is still worth saying');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the interpreter that could not import Hermes is not named by its path', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'x' } });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv({ PYTHONPATH: '' }));

      assert.equal(answer.code, 'hermes_unavailable');
      assertNowhereLocal(answer);
      assert.match(answer.error!, /Hermes/, 'the reason is still the reason');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a traceback that names a source file is forwarded without the file', async () => {
    const home = fixtureHome();
    const bin = mkdtempSync(join(tmpdir(), 'slick-hermes-python-'));
    const python = join(bin, 'python3');
    try {
      seedConfig(home, { model: { default: 'a', provider: 'b' } });
      writeFileSync(
        python,
        '#!/bin/sh\ncat >/dev/null\necho "not json"\n' +
          `echo 'File "${join(home, 'hermes-bridge.py')}", line 3, in <module>: ImportError' >&2\nexit 1\n`
      );
      chmodSync(python, 0o755);

      const answer = await readProfileModel(
        DEFAULT_PROFILE,
        home,
        bridgeEnv({ SLICK_HERMES_PYTHON: python })
      );

      assert.equal(answer.code, 'bridge_unreadable', answer.error ?? '');
      assertNowhereLocal(answer, home, bin);
      assert.match(answer.error!, /ImportError/, 'the last line of a traceback is still the diagnosis');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

/** The two fields as the file now has them, for comparing a readback against. */
function readAfterWrite(dir: string): { provider: string | null; model: string | null } {
  const model = readConfig(dir).model ?? {};
  return { provider: model.provider ?? null, model: model.default ?? null };
}

// --------------------------------------------------- the account's limits ---

/**
 * What the account behind a profile has left.
 *
 * The one thing in this file that would otherwise reach the network. It does
 * not: `agent.account_usage` is a stub on `PYTHONPATH` that returns whatever
 * `SLICK_TEST_USAGE` describes, or raises the exception it names, so every
 * branch — signed out, HTTP 401, a timeout, a plan with banked resets — is a
 * fixture. The real module is imported by the bridge under exactly the same
 * name, so what is being tested is the bridge's reading of it.
 */
describe('reading what an account has left', () => {
  /** A profile on the one provider that reports limits. */
  const onCodex = (home: string) =>
    seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });

  /** The environment, with a usage script the stub will act out. */
  const usageEnv = (script: JsonObject, extra: Env = {}) =>
    bridgeEnv({ SLICK_TEST_USAGE: JSON.stringify(script), ...extra });

  const WINDOWS = [
    { label: 'Session', used_percent: 42.5, reset_at: '2026-09-05T17:00:00Z' },
    { label: 'Weekly', used_percent: 88, reset_at: '2026-09-09T00:00:00Z' },
  ];

  beforeEach(() => {
    // The cache is process-wide and deliberately shared between profiles, so a
    // test that did not clear it would be reading the previous test's answer.
    clearUsageCache();
    setUsageClock(null);
  });

  test('the two windows come back as percentages, with the times they reset', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Pro', windows: WINDOWS, details: ['Credits balance: $12.34'] })
      );

      assert.equal(answer.error, null, answer.error ?? '');
      const usage = answer.usage!;
      assert.equal(usage.supported, true);
      assert.equal(usage.available, true);
      assert.equal(usage.plan, 'Pro');
      assert.deepEqual(
        usage.windows.map((w) => [w.label, w.usedPercent, w.remainingPercent]),
        [
          ['Session', 42.5, 57.5],
          ['Weekly', 88, 12],
        ],
        'both halves, computed once, in Hermes own order'
      );
      assert.equal(usage.windows[0]!.resetAt, '2026-09-05T17:00:00Z');
      assert.equal(usage.windows[1]!.resetAt, '2026-09-09T00:00:00Z');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('banked reset credits come back as a number, not only as a sentence', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        // Hermes own phrasing, from `_fetch_codex_account_usage`.
        usageEnv({ windows: WINDOWS, details: ['You have 3 resets banked - use /usage reset to activate'] })
      );
      assert.equal(answer.usage!.bankedResets, 3, 'the panel can badge a count; it cannot badge a paragraph');
      assert.equal(answer.usage!.details.length, 1, 'and what Hermes actually said is still passed through');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an account with no banked resets says nothing rather than zero', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ windows: WINDOWS }));
      assert.equal(answer.usage!.bankedResets, null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a provider with no limits API is unsupported, which is not an error', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'claude-opus-5', provider: 'anthropic' } });
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ windows: WINDOWS }));
      assert.equal(answer.error, null, 'nothing failed — there was nothing to ask');
      assert.equal(answer.code, null);
      assert.equal(answer.usage!.supported, false);
      assert.equal(answer.usage!.provider, 'anthropic');
      assert.deepEqual(answer.usage!.windows, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile with no credentials reads as signed out, not as a failure to fetch', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'auth' }));
      assert.equal(answer.code, 'not_authenticated', 'a login is the fix, and a retry is not');
      assert.match(answer.error!, /sign in/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an empty credential pool is the same answer as no credentials at all', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'pool' }));
      assert.equal(answer.code, 'not_authenticated');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a rejected token is signed out; a broken endpoint is not', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const rejected = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'http:401' }));
      assert.equal(rejected.code, 'not_authenticated');
      assert.match(rejected.error!, /401/);

      clearUsageCache();
      const broken = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'http:500' }));
      assert.equal(broken.code, 'usage_http_error', 'a 500 is worth retrying and a 401 is not');
      assert.match(broken.error!, /500/);

      clearUsageCache();
      const limited = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'http:429' }));
      assert.equal(limited.code, 'usage_rate_limited');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an endpoint that could not be reached says so, and nothing about where', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'timeout' }));
      assert.equal(answer.code, 'usage_unreachable');
      assert.equal(answer.error!.includes('chatgpt.com'), false, 'the URL is not the diagnosis');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('nothing key-shaped in a provider failure ever reaches the caller', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      // The stub raises with a live-looking key in the message, which is what
      // an interpolated credential in a provider error would look like.
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ raise: 'boom' }));
      const wire = JSON.stringify(answer);
      assert.equal(wire.includes('sk-live-'), false, 'a token in an exception is still a token');
      assert.equal(wire.includes(home), false, 'and the profile directory is not the browser business');
      assert.equal(answer.code, 'usage_failed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a Hermes with nothing to say is not the same as one that would not answer', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ none: true }));
      assert.equal(answer.code, 'usage_unavailable');
      assert.equal(answer.usage!.supported, true, 'the provider does report limits — this account had none');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no path on this machine appears anywhere in an answer', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const answer = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Pro', windows: WINDOWS })
      );
      const wire = JSON.stringify(answer);
      assert.equal(wire.includes(home), false);
      assert.equal(wire.includes(homedir()), false);
      assert.equal(Object.hasOwn(answer, 'dir'), false, 'the profile directory is not in the payload at all');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('asking twice inside the cache window is one request upstream', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const first = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Pro', windows: WINDOWS })
      );
      assert.equal(first.cached, false);

      // A different script entirely. If the second call reached the bridge it
      // would come back as "Free", so the plan is the evidence.
      const second = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Free', windows: WINDOWS })
      );
      assert.equal(second.cached, true);
      assert.equal(second.usage!.plan, 'Pro', 'the endpoint was not asked a second time');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a minute later it asks again', async () => {
    const home = fixtureHome();
    let now = Date.parse('2026-09-05T12:00:00Z');
    setUsageClock(() => now);
    try {
      onCodex(home);
      await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ plan: 'Pro', windows: WINDOWS }));
      now += 61_000;
      const later = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Free', windows: WINDOWS })
      );
      assert.equal(later.cached, false);
      assert.equal(later.usage!.plan, 'Free', 'a stale number is worse than a slow one');
    } finally {
      setUsageClock(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a refresh skips the cache, but two clicks in a row do not skip it twice', async () => {
    const home = fixtureHome();
    let now = Date.parse('2026-09-05T12:00:00Z');
    setUsageClock(() => now);
    try {
      onCodex(home);
      await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ plan: 'Pro', windows: WINDOWS }));

      // A click a second after the answer landed. The provider was asked one
      // second ago; asking it again is what the floor exists to prevent.
      now += 1_000;
      const twitch = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Free', windows: WINDOWS }),
        {
          refresh: true,
        }
      );
      assert.equal(twitch.throttled, true, 'the rate limit that matters is the provider own');
      assert.equal(twitch.usage!.plan, 'Pro', 'so a double click is one request, not two');

      // Past the floor, and still inside the minute a plain read would reuse:
      // this is the case a refresh button exists for.
      now += 10_000;
      const asked = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Free', windows: WINDOWS }),
        {
          refresh: true,
        }
      );
      assert.equal(asked.throttled, false, 'a refresh is a human saying they do not believe the cache');
      assert.equal(asked.usage!.plan, 'Free');

      // And a plain read straight after it is answered from what that fetched.
      now += 1_000;
      const plain = await readProfileUsage(
        DEFAULT_PROFILE,
        home,
        usageEnv({ plan: 'Team', windows: WINDOWS })
      );
      assert.equal(plain.cached, true);
      assert.equal(plain.usage!.plan, 'Free');
    } finally {
      setUsageClock(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('two panels asking at once are one interpreter and one request', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      const env = usageEnv({ plan: 'Pro', windows: WINDOWS });
      const [a, b, c] = await Promise.all([
        readProfileUsage(DEFAULT_PROFILE, home, env),
        readProfileUsage(DEFAULT_PROFILE, home, env),
        readProfileUsage(DEFAULT_PROFILE, home, env, { refresh: true }),
      ]);
      // All three resolve from the one in-flight run: the two later callers
      // joined it rather than each spawning a bridge of their own.
      assert.equal(a.usage!.plan, 'Pro');
      assert.deepEqual(b.usage, a.usage);
      assert.deepEqual(c.usage, a.usage);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('each profile has its own account, and its own cache entry', async () => {
    const home = fixtureHome(['work']);
    try {
      onCodex(home);
      seedConfig(join(home, 'profiles', 'work'), {
        model: { default: 'gpt-6-astra', provider: 'openai-codex' },
      });

      const base = await readProfileUsage(DEFAULT_PROFILE, home, usageEnv({ plan: 'Pro', windows: WINDOWS }));
      const work = await readProfileUsage('work', home, usageEnv({ plan: 'Free', windows: WINDOWS }));

      assert.equal(base.usage!.plan, 'Pro');
      assert.equal(work.usage!.plan, 'Free', 'one profile answer is never handed to another');
      assert.equal(work.cached, false);
      assert.equal(work.profile, 'work');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile that does not exist is a 404, not an empty set of limits', async () => {
    const home = fixtureHome();
    try {
      onCodex(home);
      await assert.rejects(
        () => readProfileUsage('ghost', home, usageEnv({ windows: WINDOWS })),
        /No Hermes profile called "ghost"/
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a Hermes too old to have the module reports that, not a broken profile', async () => {
    const home = fixtureHome();
    // The stub package minus `agent/`: `hermes_cli` and `hermes_constants`
    // still import, so the config is perfectly readable and the *only* thing
    // missing is the account-limits module. That is a real installation state
    // — `agent.account_usage` is newer than the config helpers — and it must
    // read as "this Hermes cannot tell you", not as an unreadable profile.
    const overlay = mkdtempSync(join(tmpdir(), 'slick-hermes-old-'));
    try {
      onCodex(home);
      for (const name of ['hermes_cli', 'hermes_constants.py']) {
        symlinkSync(join(STUB, name), join(overlay, name));
      }
      const answer = await readProfileUsage(DEFAULT_PROFILE, home, bridgeEnv({ PYTHONPATH: overlay }));
      assert.equal(answer.code, 'usage_unsupported');
      assert.equal(answer.usage!.available, false);
      assert.equal(
        answer.usage!.supported,
        true,
        'the provider still has limits; this Hermes cannot read them'
      );
    } finally {
      rmSync(overlay, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- the routes ---

describe('the Hermes profile routes', () => {
  const TOKEN = 'hermes-route-token';
  let slickHome: string;
  let hermesHome: string;
  let app: SlickServer;
  let base: string;

  beforeAll(async () => {
    slickHome = mkdtempSync(join(tmpdir(), 'slick-hermes-ws-'));
    hermesHome = fixtureHome(['work']);
    seedConfig(hermesHome, {
      model: { default: 'gpt-6-astra', provider: 'openai-codex', key_env: 'A_SECRET_NAME' },
    });
    seedConfig(join(hermesHome, 'profiles', 'work'), {
      model: { default: 'claude-opus-5', provider: 'anthropic' },
    });
    app = createServer({
      home: slickHome,
      token: TOKEN,
      webRoot: null,
      // Everything about Hermes is derived from this one environment, so a
      // test that hands over a throwaway one cannot reach the real install.
      hermesEnv: bridgeEnv({ HERMES_HOME: hermesHome }),
    });
    base = (await app.listen(0)).url;
  });

  afterAll(async () => {
    await app.close();
    rmSync(slickHome, { recursive: true, force: true });
    rmSync(hermesHome, { recursive: true, force: true });
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    opts: { anonymous?: boolean } = {}
  ): Promise<{ status: number; body: any }> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(opts.anonymous ? {} : { authorization: `Bearer ${TOKEN}` }),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  test('the profiles this installation has are listed, the default first', async () => {
    const res = await call('GET', '/api/hermes/profiles');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.profiles.map((p: { name: string }) => p.name),
      ['default', 'work']
    );
    assert.equal(res.body.profiles[0].isDefault, true);
    assert.ok(!JSON.stringify(res.body).includes(hermesHome), 'a filesystem path is not the app’s business');
  });

  test('a profile reports what it is set to and what it could be set to', async () => {
    const res = await call('GET', '/api/hermes/profiles/work/model');
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null, res.body.error ?? '');
    assert.deepEqual(res.body.defaults, { provider: 'anthropic', model: 'claude-opus-5' });
    assert.ok(res.body.providers.length > 0);
    assert.ok(!JSON.stringify(res.body).includes('A_SECRET_NAME'));
  });

  test('setting one writes that profile and leaves the other alone', async () => {
    const res = await call('PUT', '/api/hermes/profiles/work/model', {
      provider: 'custom:fano',
      model: 'local-qwen',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null, res.body.error ?? '');
    assert.deepEqual(res.body.defaults, { provider: 'custom:fano', model: 'local-qwen' });

    // Read it back over the wire, as a reloaded app would.
    const again = await call('GET', '/api/hermes/profiles/work/model');
    assert.deepEqual(again.body.defaults, { provider: 'custom:fano', model: 'local-qwen' });
    assert.deepEqual(readConfig(hermesHome).model, {
      default: 'gpt-6-astra',
      provider: 'openai-codex',
      key_env: 'A_SECRET_NAME',
    });
  });

  test('a profile-global save leaves every session override exactly as it was', async () => {
    const key = app.ws.agents.start({ agentId: 'hermes', channel: 'general' }).key;
    app.ws.agents.setModel(key, 'openai-codex::gpt-5.6-luna');
    app.ws.agents.setEffort(key, 'high');

    await call('PUT', '/api/hermes/profiles/default/model', {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    const after = app.ws.agents.get(key);
    assert.equal(after.state._serveModel, 'openai-codex::gpt-5.6-luna', 'this chat keeps its own model');
    assert.equal(after.state._serveEffort, 'high');
  });

  test('a name that is not a profile is refused, and a traversal never reaches the disk', async () => {
    assert.equal((await call('GET', '/api/hermes/profiles/ghost/model')).status, 404);
    assert.equal(
      (await call('PUT', '/api/hermes/profiles/ghost/model', { provider: 'a', model: 'b' })).status,
      404
    );
    for (const bad of ['..', '%2e%2e%2f%2e%2e', 'a.b', 'UP']) {
      const res = await call('PUT', `/api/hermes/profiles/${bad}/model`, { provider: 'a', model: 'b' });
      // 422 is this codebase's `invalid_request`; 404 is a well-formed name
      // that names nothing here. Either is a refusal, and neither touched disk.
      assert.ok([404, 422].includes(res.status), `${bad} → ${res.status}`);
    }
  });

  test('a blank profile id in the path does not quietly mean the default profile', async () => {
    const before = readConfig(hermesHome).model;
    for (const blank of ['%20', '%20%20', '%09', '%20default%20']) {
      const res = await call('PUT', `/api/hermes/profiles/${blank}/model`, {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      });
      assert.ok([404, 422].includes(res.status), `${blank} → ${res.status}`);
    }
    assert.deepEqual(readConfig(hermesHome).model, before, 'the installation config was not written');
  });

  test('a profile that is only an alias of the root is not reachable, and nothing outside is written', async () => {
    symlinkSync(join(hermesHome, 'profiles', '..'), join(hermesHome, 'profiles', 'alias'));
    try {
      const before = readConfig(hermesHome).model;
      assert.deepEqual(
        (await call('GET', '/api/hermes/profiles')).body.profiles.map((p: { name: string }) => p.name),
        ['default', 'work']
      );
      const res = await call('PUT', '/api/hermes/profiles/alias/model', {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      });
      assert.equal(res.status, 404);
      assert.deepEqual(readConfig(hermesHome).model, before);
    } finally {
      rmSync(join(hermesHome, 'profiles', 'alias'), { force: true });
    }
  });

  test('an empty provider or model is refused rather than written', async () => {
    const before = readConfig(hermesHome).model;
    for (const body of [{ provider: '', model: 'x' }, { provider: 'anthropic', model: '' }, {}]) {
      const res = await call('PUT', '/api/hermes/profiles/default/model', body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    assert.deepEqual(readConfig(hermesHome).model, before, 'nothing was written');
  });

  test('the level a profile thinks at goes over the wire with the rest of it', async () => {
    const res = await call('PUT', '/api/hermes/profiles/work/model', {
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'xhigh',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.error, null, res.body.error ?? '');
    assert.equal(res.body.effort, 'xhigh');

    const again = await call('GET', '/api/hermes/profiles/work/model');
    assert.equal(again.body.effort, 'xhigh');
    assert.ok(
      again.body.efforts.some((e: { value: string }) => e.value === 'xhigh'),
      'and the levels to change it to came with it'
    );
    assert.equal(
      readConfig(hermesHome).agent,
      undefined,
      'the profile that was written is the only one that moved'
    );
  });

  test('a level that is not a level is refused with a sentence, not a 500', async () => {
    const before = readConfig(join(hermesHome, 'profiles', 'work')).agent;
    const res = await call('PUT', '/api/hermes/profiles/work/model', {
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'high and then some',
    });
    assert.equal(res.status, 422);
    assert.deepEqual(readConfig(join(hermesHome, 'profiles', 'work')).agent, before, 'nothing was written');
  });

  test("what the profile's account has left comes back over the wire", async () => {
    clearUsageCache();
    const res = await call('GET', '/api/hermes/profiles/work/usage');
    assert.equal(res.status, 200);
    // `work` is seeded on anthropic, which has no limits API — so this asserts
    // the honest half: a 200 saying "nothing to show", never a 500.
    assert.equal(res.body.error, null, res.body.error ?? '');
    assert.equal(res.body.usage.supported, false);
    assert.equal(res.body.profile, 'work');
    assert.equal(Object.hasOwn(res.body, 'dir'), false, 'no path on this machine goes to a browser');
    assert.equal(JSON.stringify(res.body).includes(hermesHome), false);
  });

  test('a refresh is a query parameter, and the answer says whether it asked', async () => {
    clearUsageCache();
    const first = await call('GET', '/api/hermes/profiles/work/usage');
    assert.equal(first.body.cached, false);

    const cached = await call('GET', '/api/hermes/profiles/work/usage');
    assert.equal(cached.body.cached, true, 'a redraw is not a request');

    const refreshed = await call('GET', '/api/hermes/profiles/work/usage?refresh=1');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.throttled, true, 'and a click straight after one is not a request either');
  });

  test('limits for a profile that does not exist is a 404 with the names that do', async () => {
    const res = await call('GET', '/api/hermes/profiles/ghost/usage');
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /No Hermes profile called "ghost"/);
  });

  test('none of it answers without a token', async () => {
    const cases: [string, string, unknown][] = [
      ['GET', '/api/hermes/profiles', null],
      ['GET', '/api/hermes/profiles/default/model', null],
      ['PUT', '/api/hermes/profiles/default/model', { provider: 'anthropic', model: 'claude-sonnet-5' }],
      ['GET', '/api/hermes/profiles/default/usage', null],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(method, path, body, { anonymous: true });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, 'unauthorized');
    }
  });
});

// --------------------------------------------------- against a real Hermes ---

/**
 * The stubs above prove the bridge calls the sanctioned helpers and passes
 * their answers through. They cannot prove those helpers do what we think —
 * that `save_config` keeps `key_env`, that `load_config` reads a real
 * `config.yaml` back, that Hermes' own migration does not eat a sibling key.
 * Only a real Hermes can, so this block finds one and uses it against a
 * `HERMES_HOME` made for the test.
 *
 * Skipped, with a reason, when there is no importable Hermes here — the suite
 * has to pass on a machine that has never installed one. Point
 * `SLICK_HERMES_TEST_PYTHON` at an interpreter to force it.
 *
 * No model is ever called: this reads and writes a config file.
 */
function findRealHermes(): string | null {
  const candidates = [
    process.env.SLICK_HERMES_TEST_PYTHON,
    join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python'),
  ].filter((python): python is string => Boolean(python));
  for (const python of candidates) {
    try {
      execFileSync(python, ['-c', 'import hermes_cli.config'], { stdio: 'ignore', timeout: 30_000 });
      return python;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const REAL_PYTHON = findRealHermes();
/** The real-Hermes block, skipped when there is no importable Hermes on this machine. */
const realTest = REAL_PYTHON ? test : test.skip;

describe('a real Hermes, in a HERMES_HOME made for the test', () => {
  /** Only ever a temp dir; the real ~/.hermes is never named here. */
  const realEnv = (): Env => ({
    PATH: process.env.PATH,
    SLICK_HERMES_TEST: '1',
    SLICK_HERMES_PYTHON: REAL_PYTHON ?? undefined,
  });

  const CONFIG = [
    'model:',
    '  default: "probe-model"',
    '  provider: "openai-codex"',
    '  key_env: "PROBE_KEY_NAME"',
    '  context_length: 123456',
    'keep_me:',
    '  nested: true',
    '',
  ].join('\n');

  realTest('a write survives being read back through Hermes itself', async () => {
    const home = fixtureHome();
    try {
      writeFileSync(join(home, 'config.yaml'), CONFIG);

      const saved = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        realEnv()
      );
      assert.equal(saved.error, null, saved.error ?? '');
      assert.deepEqual(saved.defaults, { provider: 'anthropic', model: 'claude-sonnet-5' });

      // A second process, a fresh `load_config()` — which is what the next
      // Hermes to start will do, and the only proof that it stuck.
      const reread = await readProfileModel(DEFAULT_PROFILE, home, realEnv());
      assert.deepEqual(reread.defaults, { provider: 'anthropic', model: 'claude-sonnet-5' });

      const yaml = readFileSync(join(home, 'config.yaml'), 'utf8');
      assert.match(yaml, /PROBE_KEY_NAME/, 'the credential pointer is still in the file');
      assert.match(yaml, /context_length: 123456/);
      assert.match(yaml, /keep_me:/, 'a key Slick has never heard of is still there');
      assert.match(yaml, /claude-sonnet-5/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  realTest('the catalog is Hermes own, with its own provider-qualified ids', async () => {
    const home = fixtureHome();
    try {
      writeFileSync(join(home, 'config.yaml'), CONFIG);
      const read = await readProfileModel(DEFAULT_PROFILE, home, realEnv());
      assert.equal(read.error, null, read.error ?? '');
      assert.deepEqual(read.defaults, { provider: 'openai-codex', model: 'probe-model' });

      // Not asserting *which* providers: that is this machine's credentials,
      // and a test that pins them fails on the next one. What must hold is
      // that ids arrive verbatim — no re-spelling of a `custom:` slug, no
      // splitting a vendor-prefixed model id on its slash.
      for (const provider of providersOf(read)) {
        assert.equal(provider.value, provider.value.trim());
        assert.equal(typeof provider.custom, 'boolean');
        assert.equal(provider.custom, provider.value === 'custom' || provider.value.startsWith('custom:'));
        for (const model of provider.models) assert.equal(model.value, model.label);
      }
      assert.ok(!JSON.stringify(read).includes('PROBE_KEY_NAME'), 'no credential pointer on the wire');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  realTest('a real switch away from a custom endpoint takes its credentials with it', async () => {
    const home = fixtureHome();
    const KEY = 'sk-endpoint-Ab3nQ7zK1mVx9PlR4tYuWs2Dg6Hj8Kc0';
    try {
      writeFileSync(
        join(home, 'config.yaml'),
        [
          'model:',
          '  default: "local-qwen"',
          '  provider: "custom"',
          '  base_url: "https://box.invalid/v1"',
          `  api_key: "${KEY}"`,
          '  api_mode: "responses"',
          '  key_env: "PROBE_KEY_NAME"',
          'keep_me:',
          '  nested: true',
          '',
        ].join('\n')
      );

      const saved = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        home,
        realEnv()
      );
      assert.equal(saved.error, null, saved.error ?? '');

      // Read the file, not the payload: the point is what is left on disk for
      // the next Hermes to start, and Hermes' own writer is what put it there.
      const yaml = readFileSync(join(home, 'config.yaml'), 'utf8');
      assert.ok(!yaml.includes(KEY), 'the old endpoint key is gone from config.yaml');
      assert.ok(!/^\s*base_url:/m.test(yaml), 'and so is the URL it belonged to');
      assert.ok(!/^\s*api_mode:/m.test(yaml));
      assert.match(yaml, /PROBE_KEY_NAME/, 'a pointer to a credential is not a credential');
      assert.match(yaml, /keep_me:/);
      assert.match(yaml, /claude-sonnet-5/);
      assert.ok(!JSON.stringify(saved).includes(KEY));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  realTest('a real config nobody else touched still saves', async () => {
    const home = fixtureHome();
    try {
      writeFileSync(join(home, 'config.yaml'), CONFIG);
      // Twice in a row, through the same lock and the same conflict check —
      // a guard that refuses an uncontended write is a guard that broke the
      // feature.
      for (const model of ['claude-sonnet-5', 'claude-opus-5']) {
        const saved = await writeProfileModel(
          DEFAULT_PROFILE,
          { provider: 'anthropic', model },
          home,
          realEnv()
        );
        assert.equal(saved.error, null, saved.error ?? '');
        assert.equal(saved.defaults.model, model);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  realTest('editing one profile leaves the other profile’s file byte-identical', async () => {
    const home = fixtureHome(['work']);
    const work = join(home, 'profiles', 'work');
    try {
      writeFileSync(join(home, 'config.yaml'), CONFIG);
      writeFileSync(join(work, 'config.yaml'), CONFIG.replace('probe-model', 'work-model'));
      const untouched = readFileSync(join(home, 'config.yaml'), 'utf8');

      await writeProfileModel('work', { provider: 'anthropic', model: 'claude-opus-5' }, home, realEnv());

      assert.equal(
        readFileSync(join(home, 'config.yaml'), 'utf8'),
        untouched,
        'the default profile was not opened'
      );
      assert.match(readFileSync(join(work, 'config.yaml'), 'utf8'), /claude-opus-5/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- the level it thinks at ---

/**
 * `agent.reasoning_effort` is the profile-global counterpart of `model.*`: one
 * key, in the same file, resolved through Hermes' own `resolve_reasoning_config`
 * so a per-model override in `agent.reasoning_overrides` is honoured here
 * exactly as the agent honours it.
 */
describe('the level a profile is set to think at', () => {
  test('the configured level, and the levels Hermes accepts, come back with the rest', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex' },
        agent: { reasoning_effort: 'high', name: 'Hermes' },
      });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());

      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.effort, 'high');
      assert.equal(answer.effectiveEffort, 'high');
      assert.deepEqual(
        answer.efforts.map((e) => e.value),
        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none'],
        'Hermes own vocabulary, in its own order, with "off" last'
      );
      assert.deepEqual(answer.defaults, { provider: 'openai-codex', model: 'gpt-6-astra' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a profile with no level set says so rather than inventing one', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      assert.equal(answer.effort, null);
      assert.equal(answer.effectiveEffort, null, 'unset is the provider default, not a level');
      assert.ok(answer.efforts.length > 0, 'and the levels are still offered');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('thinking turned off is a setting, not an absence', async () => {
    const home = fixtureHome();
    try {
      // What YAML hands Hermes for `reasoning_effort: false` / `off` / `no`.
      seedConfig(home, { model: { default: 'gpt-6-astra' }, agent: { reasoning_effort: false } });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      assert.equal(answer.effort, 'none');
      assert.equal(answer.effectiveEffort, 'none');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a per-model override is reported as what is actually in force', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex' },
        agent: { reasoning_effort: 'low', reasoning_overrides: { 'gpt-6-astra': 'ultra' } },
      });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      assert.equal(answer.effort, 'low', 'the global is what this panel edits');
      assert.equal(answer.effectiveEffort, 'ultra', 'and the override is what this model gets');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a level Hermes does not know is still reported, not swallowed', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra' }, agent: { reasoning_effort: 'turbo' } });
      const answer = await readProfileModel(DEFAULT_PROFILE, home, bridgeEnv());
      assert.equal(answer.effort, 'turbo', 'the panel must be able to say what the file says');
      assert.equal(answer.effectiveEffort, null, 'Hermes resolves nothing from it');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('writing one sets agent.reasoning_effort and leaves the rest of agent: alone', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex', key_env: 'A_SECRET_NAME' },
        agent: { reasoning_effort: 'low', name: 'Hermes', tools: ['shell'] },
      });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-opus-5', effort: 'max' },
        home,
        bridgeEnv()
      );
      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.effort, 'max', 'the readback, not the request echoed');
      assert.deepEqual(answer.defaults, { provider: 'anthropic', model: 'claude-opus-5' });
      assert.deepEqual(readConfig(home).agent, {
        reasoning_effort: 'max',
        name: 'Hermes',
        tools: ['shell'],
      });
      assert.equal(readAfterWrite(home).model, 'claude-opus-5', 'the pair went in the same write');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an empty level clears the key rather than writing an empty one', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex' },
        agent: { reasoning_effort: 'high', name: 'Hermes' },
      });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'openai-codex', model: 'gpt-6-astra', effort: '' },
        home,
        bridgeEnv()
      );
      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.effort, null);
      assert.deepEqual(readConfig(home).agent, { name: 'Hermes' }, 'the key is gone, the section is not');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a write that says nothing about the level leaves it exactly as it was', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex' },
        agent: { reasoning_effort: 'high' },
      });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-opus-5' },
        home,
        bridgeEnv()
      );
      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.effort, 'high');
      assert.equal(readConfig(home).agent.reasoning_effort, 'high');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('an explicit null level leaves it exactly as it was, same as omitting it', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, {
        model: { default: 'gpt-6-astra', provider: 'openai-codex' },
        agent: { reasoning_effort: 'high' },
      });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'anthropic', model: 'claude-opus-5', effort: null },
        home,
        bridgeEnv()
      );
      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.effort, 'high');
      assert.equal(readConfig(home).agent.reasoning_effort, 'high');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('turning thinking off is written as the level Hermes reads back as off', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'openai-codex', model: 'gpt-6-astra', effort: 'none' },
        home,
        bridgeEnv()
      );
      assert.equal(answer.error, null, answer.error ?? '');
      assert.equal(answer.effort, 'none');
      assert.equal(readConfig(home).agent.reasoning_effort, 'none');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a level that is not a word is refused before it reaches a config file', async () => {
    const home = fixtureHome();
    try {
      seedConfig(home, { model: { default: 'gpt-6-astra', provider: 'openai-codex' } });
      const answer = await writeProfileModel(
        DEFAULT_PROFILE,
        { provider: 'openai-codex', model: 'gpt-6-astra', effort: 'high\nagent: {}' },
        home,
        bridgeEnv()
      );
      assert.equal(answer.code, 'bad_request');
      assert.equal(readConfig(home).agent, undefined, 'nothing was written at all');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
