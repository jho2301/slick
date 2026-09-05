/**
 * Hermes profiles, and the model defaults each one carries.
 *
 * A Hermes profile is a whole `HERMES_HOME`: one `config.yaml`, one set of
 * credentials, one answer to "which model does this agent run". The default
 * profile *is* `HERMES_HOME` (`~/.hermes` unless the environment says
 * otherwise) and a named profile is `HERMES_HOME/profiles/<name>` — that is
 * Hermes' own layout, not a convention invented here.
 *
 * Two halves, deliberately split:
 *
 *   - *Which profiles exist* is a directory listing, so it is done here, in
 *     Node, and needs nothing installed.
 *   - *What is in one* — the configured provider, the configured model, the
 *     catalog of what could be chosen instead — is Hermes' own business.
 *     Reading `config.yaml` with a hand-rolled parser and writing it back with
 *     a regular expression would corrupt a file full of comments, anchors and
 *     credentials the first time someone used a feature this file had not
 *     heard of. So that half is delegated to `hermes-bridge.py`, which imports
 *     Hermes' sanctioned config helpers and does the load/edit/save through
 *     them.
 *
 * Nothing here is a session setting. `_serveModel` on an agent session is one
 * conversation's override and is untouched by everything below; this is the
 * default the profile hands out when nobody has overridden anything.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NotFoundError,
  ValidationError,
  errorCode,
  errorMessage,
  isRecord,
  type JsonObject,
} from '@slick/core';

/** The environment the daemon was started with, or one a test hands over. */
export type Env = Record<string, string | undefined>;

/**
 * The profile that is `HERMES_HOME` itself. Hermes has no name for it — it is
 * simply the un-profiled installation — so Slick calls it this, and never
 * writes the word into a path.
 */
export const DEFAULT_PROFILE = 'default';

/**
 * A profile name as it may appear in a path segment.
 *
 * This is `_PROFILE_ID_RE` from `hermes_cli/profiles.py`, character for
 * character — no separators, no dots, no spaces, lower case only, 64 max.
 * Copied rather than loosened: a name Slick accepted but Hermes would not is a
 * profile Slick can write and Hermes can never read.
 *
 * Containment is checked separately below, because a rule about characters is
 * a rule about *this* string and says nothing about where a symlink two levels
 * down actually points.
 */
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Names Hermes will not let a profile have.
 *
 * `_RESERVED_NAMES` from `hermes_cli/profiles.py`, plus nothing. Hermes
 * refuses them at creation *and* at use — `validate_profile_name` runs inside
 * `resolve_profile_env`, so `hermes -p test` fails even if the directory
 * exists. A `profiles/test` Slick offered would be a profile Slick can write
 * and Hermes can never start under.
 *
 * `default` is in the list for a second reason: it is Slick's name for
 * `HERMES_HOME` itself, so a `profiles/default` directory would put two
 * different things behind one name.
 */
const RESERVED_PROFILE_NAMES = new Set(['default', 'hermes', 'test', 'tmp', 'root', 'sudo']);

/** The one file a profile is read from and written to. */
const CONFIG_FILE = 'config.yaml';

/**
 * Anything long and unbroken, which is the shape of a token.
 *
 * The same rule as `_SECRETISH` in `hermes-bridge.py`, applied again on this
 * side because the bridge is not the only thing that produces an error
 * message: a spawn that fails, or an interpreter that dies mid-traceback,
 * writes text this process never censored. An error is for the human reading
 * a panel, so a run that could reconstruct a credential is cut out of it.
 */
const SECRETISH = /[A-Za-z0-9_-]{24,}/g;

/**
 * Anything rooted at `/`, `~/` or a drive letter — `_LOCAL_PATH` in
 * `hermes-bridge.py`, applied again on this side for the same reason as
 * `SECRETISH`: the bridge is not the only thing that produces a message. A
 * spawn that fails names the interpreter, and an interpreter that dies
 * mid-traceback prints `File "…/hermes-bridge.py", line 3` — text this process
 * never censored, on its way to a browser. The layout of the daemon's disk is
 * not the browser's business, and a screenshot of a panel is how it stops
 * being private.
 *
 * The lookbehind is what keeps this off the things that merely contain a
 * slash: in `anthropic/claude-sonnet-4.5` and `https://box.invalid/v1` every
 * slash follows a word character or a colon, never a space or a quote, so
 * neither can start a match. A model id and an endpoint are the context that
 * makes a failure readable.
 */
const LOCAL_PATH = /(?<![A-Za-z0-9_:~./\\-])(?:[A-Za-z]:\\[^\s'"]*|~?(?:\/[A-Za-z0-9_.~@%+…-]+)+\/?)/g;

/** The punctuation a path swallowed on its way out of the sentence it sat in. */
const TRAILING = /[.,;:)]+$/;

/** An error message with anything key-shaped taken out of it. */
export function redactSecrets(text: unknown): string {
  return String(text ?? '').replace(SECRETISH, '…');
}

/** An error message with every place on this machine taken out of it. */
export function redactLocalPaths(text: unknown): string {
  return String(text ?? '').replace(LOCAL_PATH, (path: string) => `…${TRAILING.exec(path)?.[0] ?? ''}`);
}

/**
 * The one thing every message a browser will see goes through.
 *
 * Paths first, and the order is load-bearing: a temp directory has a long
 * random segment in it, so a secret pass that ran first would replace that
 * segment with `…` and leave the rest of the path unmatched — a censored path
 * is still a path. Collapsing the path whole takes the token with it, and the
 * secret pass then does its work on what is left.
 */
export function redactForBrowser(text: unknown): string {
  return redactSecrets(redactLocalPaths(text));
}

/** How long the bridge may take before the request gives up on it. */
const BRIDGE_TIMEOUT_MS = 20_000;

/** As much JSON as a catalog of every model on every provider could need. */
const MAX_BRIDGE_OUTPUT = 2_000_000;

const here = dirname(fileURLToPath(import.meta.url));

/** The in-repo bridge. Versioned with the daemon that spawns it. */
export const BRIDGE_SCRIPT = join(here, 'hermes-bridge.py');

/**
 * Where Hermes keeps everything, for a given environment.
 *
 * `HERMES_HOME` wins because that is the switch Hermes itself reads.
 */
export function hermesHome(env: Env = process.env): string {
  const set = String(env.HERMES_HOME ?? '').trim();
  return set ? resolve(set) : join(homedir(), '.hermes');
}

/**
 * The installation every profile hangs off.
 *
 * `HERMES_HOME` may already *be* a profile — Slick's own daemon can have been
 * started under one — and a profile has no `profiles/` of its own, so taking
 * it at face value would offer a list of exactly one. Hermes solves this in
 * `get_default_hermes_root()` by recognising the shape of a profile path and
 * climbing back out of it, and so does this.
 */
export function hermesRoot(env: Env = process.env): string {
  const home = hermesHome(env);
  const parent = dirname(home);
  const name = home.slice(parent.length + 1);
  // Only the exact shape `<root>/profiles/<valid name>` climbs. `<root>/profiles`
  // itself is a directory someone could plausibly have set, and it is not one
  // of the profiles inside it.
  if (basename(parent) === 'profiles' && PROFILE_RE.test(name)) return dirname(parent);
  return home;
}

function badName(name: unknown): ValidationError {
  return new ValidationError(`"${String(name).slice(0, 80)}" is not a valid Hermes profile name.`, {
    hint: 'Lower-case letters, digits, "-" or "_", and not one of Hermes\' reserved names — it is one directory under HERMES_HOME/profiles.',
  });
}

/**
 * The directory a profile's `config.yaml` lives in.
 *
 * Checked twice on purpose. The pattern rejects the obvious escapes before
 * they are ever joined to a path; `resolve` then proves that what came out is
 * still under `home`, which is the check that survives someone widening the
 * pattern later.
 *
 * @param home  HERMES_HOME
 */
export function profileDir(name: unknown, home: string): string {
  const wanted = String(name ?? '');
  if (wanted === DEFAULT_PROFILE) return resolve(home);
  if (!PROFILE_RE.test(wanted) || RESERVED_PROFILE_NAMES.has(wanted)) throw badName(wanted);

  const root = resolve(home);
  const dir = resolve(root, 'profiles', wanted);
  if (dir !== root && !dir.startsWith(root + sep)) throw badName(wanted);
  return dir;
}

/**
 * Is this profile's `config.yaml` a file inside the profile, or a link away?
 *
 * The directory being contained is not enough. `profiles/work/config.yaml` can
 * itself be a symlink — to the installation's own config, to another profile's,
 * to anything the daemon can open — and it is the *file* that a save replaces.
 * A profile whose one editable file is somewhere else is not a profile Slick
 * will offer; a profile that has no config yet is fine, because that is what a
 * freshly created one looks like.
 */
function configContained(dir: string): boolean {
  try {
    return lstatSync(join(dir, CONFIG_FILE)).isFile();
  } catch (err) {
    // Absent is the ordinary case. Anything else — a permission wall, a
    // vanished mount — is a file this process cannot vouch for.
    return errorCode(err) === 'ENOENT';
  }
}

export interface HermesProfile {
  name: string;
  dir: string;
  isDefault: boolean;
  configured: boolean;
}

/**
 * The profiles this installation actually has.
 *
 * The default is `HERMES_HOME` itself and comes first. The named ones are the
 * directories under `profiles/` that are *only* reachable by their own name:
 * a `profiles/x` that resolves anywhere other than `profiles/x` is an alias,
 * and an alias is a second name for a config file that already has one. That
 * matters because these names are writable — `profiles/self -> ..` would let a
 * save aimed at "self" land on the installation's own `config.yaml`.
 *
 * @param home  HERMES_HOME
 */
export function listProfiles(home: string): HermesProfile[] {
  const root = resolve(home);
  const found: HermesProfile[] = [];
  if (configContained(root)) {
    found.push({
      name: DEFAULT_PROFILE,
      dir: root,
      isDefault: true,
      configured: existsSync(join(root, CONFIG_FILE)),
    });
  }

  let realRoot: string;
  let realProfiles: string;
  try {
    realRoot = realpathSync(root);
    realProfiles = realpathSync(join(realRoot, 'profiles'));
  } catch {
    return found; // no profiles directory: the default is the whole list
  }
  // `profiles/` may itself be a link, but not one that leaves the installation.
  if (realProfiles !== join(realRoot, 'profiles') && !realProfiles.startsWith(realRoot + sep)) return found;

  let entries;
  try {
    entries = readdirSync(realProfiles, { withFileTypes: true });
  } catch {
    return found;
  }

  const named: HermesProfile[] = [];
  for (const entry of entries) {
    const name = entry.name;
    let dir: string;
    try {
      dir = profileDir(name, root); // the name rule and the reserved list, once
    } catch {
      continue;
    }
    // `withFileTypes` reports a symlink as a symlink, so ask the filesystem
    // what it points at rather than skipping every linked profile outright —
    // and then insist that what it points at is this profile and nothing else.
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (realpathSync(dir) !== join(realProfiles, name)) continue;
    } catch {
      continue;
    }
    if (!configContained(dir)) continue;
    named.push({ name, dir, isDefault: false, configured: existsSync(join(dir, CONFIG_FILE)) });
  }
  named.sort((a, b) => a.name.localeCompare(b.name));
  return [...found, ...named];
}

/**
 * The profile called `name`, or a 404 that says which names there are.
 *
 * `name` is used exactly as given. It arrives as a path segment from a URL,
 * and `%20` decodes to a string that is not a profile name — trimming it into
 * one would turn `PUT /api/hermes/profiles/%20/model` into a write to the
 * installation's own config. Only an omitted name means "the default".
 */
export function getProfile(name: unknown, home: string): HermesProfile {
  const wanted = name == null ? DEFAULT_PROFILE : String(name);
  const profiles = listProfiles(home);
  const found = profiles.find((profile) => profile.name === wanted);
  if (found) return found;
  // Validate after the lookup so a well-formed name that simply does not exist
  // reads as "no such profile" rather than as a syntax complaint.
  profileDir(wanted, home);
  throw new NotFoundError(`No Hermes profile called "${wanted}".`, {
    hint: `This installation has: ${profiles.map((p) => p.name).join(', ')}.`,
    details: { profiles: profiles.map((p) => p.name) },
  });
}

// ------------------------------------------------------------------ bridge ---

/**
 * The interpreter that can import Hermes.
 *
 * Hermes ships its own virtualenv, and its config helpers are only importable
 * from inside it. `SLICK_HERMES_PYTHON` overrides for an installation that put
 * it somewhere else — and is what the tests point at a throwaway interpreter,
 * so no test ever needs a real Hermes.
 */
export function bridgePython(home: string, env: Env = process.env): string {
  const override = String(env.SLICK_HERMES_PYTHON ?? '').trim();
  if (override) return override;
  const venv = join(resolve(home), 'hermes-agent', 'venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

/**
 * The variables a Python that has to import Hermes genuinely needs.
 *
 * Everything else is dropped, and the omission is the point. A daemon is
 * started with whatever the user's shell had in it, and Hermes reads provider
 * keys straight out of the environment — so a bridge that inherited them would
 * report a profile as logged in on the strength of a credential that belongs
 * to the daemon, or to whichever profile the daemon happens to run under.
 * Which profile is authenticated is a question about a directory on disk, and
 * this is what makes the answer come from there.
 *
 * `SLICK_*` passes through because those are this codebase's own switches
 * (`SLICK_HERMES_PYTHON`, and the test hooks), never a provider's.
 */
const ENV_KEEP = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'SHELL',
  // Where the interpreter itself comes from and how it talks to the world.
  'PYTHONPATH',
  'PYTHONIOENCODING',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  // Windows needs these to load a DLL at all; harmless everywhere else.
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
]);

/**
 * The environment one bridge run gets: this profile, and no one's secrets.
 *
 * @param dir  the profile's HERMES_HOME
 */
export function bridgeEnvironment(dir: string, env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (ENV_KEEP.has(key) || key.startsWith('SLICK_')) out[key] = value;
  }
  // The profile being *edited*, not the one this daemon happens to be running
  // under. The bridge sets the same value again from `--dir` before it imports
  // anything — `get_hermes_home()` reads the environment, so the profile has
  // to be chosen before the first import caches it — but an inherited
  // HERMES_HOME pointing somewhere else would be a trap sitting one refactor
  // away, so it is set here too rather than merely allowed through.
  out.HERMES_HOME = dir;
  // A profile directory is the user's, not a build tree. Nothing Slick spawns
  // should leave `__pycache__` in it.
  out.PYTHONDONTWRITEBYTECODE = '1';
  return out;
}

/** What the bridge prints: a JSON object with `ok`, and a reason when not. */
interface BridgeAnswer extends JsonObject {
  ok?: boolean;
  error?: string | null;
  code?: string | null;
}

/**
 * Run the bridge and read its answer.
 *
 * Never throws for anything the bridge itself reports: a Hermes that is not
 * installed, a profile with no catalog, a config helper that has moved are all
 * *answers* — the UI shows them as "unavailable, and here is why" rather than
 * inventing a provider list. Only a bridge that cannot be started at all, or
 * that prints something that is not JSON, becomes an error here.
 */
function callBridge(
  argv: string[],
  { home, dir, env = process.env, input }: { home: string; dir: string; env?: Env; input?: JsonObject }
): Promise<BridgeAnswer> {
  const python = bridgePython(home, env);
  return new Promise((resolve_) => {
    let child: ChildProcess;
    try {
      child = spawn(python, [BRIDGE_SCRIPT, ...argv], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: bridgeEnvironment(dir, env),
      });
    } catch (err) {
      resolve_({
        ok: false,
        error: redactForBrowser(`could not start "${python}": ${errorMessage(err)}`),
        code: 'bridge_unavailable',
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, BRIDGE_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_BRIDGE_OUTPUT) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8192) stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve_({
        ok: false,
        error: redactForBrowser(`could not start "${python}": ${errorMessage(err)}`),
        code: 'bridge_unavailable',
      });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve_({
          ok: false,
          error: `Hermes did not answer within ${BRIDGE_TIMEOUT_MS / 1000}s.`,
          code: 'bridge_timeout',
        });
        return;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        /* not JSON */
      }
      if (!isRecord(parsed)) {
        // Whatever the interpreter said goes in the message, trimmed: a
        // traceback's last line is usually the whole diagnosis. Redacted on
        // the way, because this is the one path where text the bridge never
        // censored — it died before it could — is on its way to a browser,
        // and a traceback is exactly where an interpolated key turns up.
        const said = redactForBrowser(stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 400);
        resolve_({
          ok: false,
          error: said || 'The Hermes bridge printed nothing a caller could read.',
          code: 'bridge_unreadable',
        });
        return;
      }
      resolve_(parsed);
    });

    if (input !== undefined) child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

export interface EffortChoice {
  value: string;
  label: string;
}

export interface ProfileEfforts {
  /** What this profile sets. */
  effort: string | null;
  efforts: EffortChoice[];
  /** What its configured model actually gets, overrides included. */
  effectiveEffort: string | null;
}

/**
 * The thinking level half of an answer, in the shape the panel reads it.
 *
 * A whitelist with types, like everything else that crosses this boundary: the
 * bridge is trusted to be the bridge, not to have been replaced by a Hermes
 * whose helper returned something else. `effort` is what this profile *sets*
 * and `effectiveEffort` is what its configured model would actually get — a
 * per-model override can make those two different facts, so they are never
 * merged here.
 */
function effortsOf(answer: BridgeAnswer): ProfileEfforts {
  const efforts: EffortChoice[] = [];
  if (Array.isArray(answer.efforts)) {
    for (const entry of answer.efforts) {
      if (!isRecord(entry) || typeof entry.value !== 'string' || !entry.value) continue;
      efforts.push({ value: entry.value, label: String(entry.label ?? entry.value) });
    }
  }
  return {
    effort: typeof answer.effort === 'string' && answer.effort ? answer.effort : null,
    efforts,
    effectiveEffort:
      typeof answer.effectiveEffort === 'string' && answer.effectiveEffort ? answer.effectiveEffort : null,
  };
}

export interface ProfileDefaults {
  provider: string | null;
  model: string | null;
}

function defaultsOf(answer: BridgeAnswer): ProfileDefaults {
  const raw = isRecord(answer.defaults) ? answer.defaults : {};
  return {
    provider: typeof raw.provider === 'string' ? raw.provider : null,
    model: typeof raw.model === 'string' ? raw.model : null,
  };
}

export interface ProfileModel extends ProfileEfforts {
  profile: string;
  dir: string;
  defaults: ProfileDefaults;
  /** The catalog, in whatever shape Hermes reported it. */
  providers: JsonObject[];
  catalogError: string | null;
  active: string | null;
  error: string | null;
  code: string | null;
}

/**
 * What one profile is set to, and what it could be set to instead.
 */
export async function readProfileModel(
  name: unknown,
  home: string,
  env: Env = process.env
): Promise<ProfileModel> {
  const profile = getProfile(name, home);
  const answer = await callBridge(['read', '--dir', profile.dir], { home, dir: profile.dir, env });
  return {
    profile: profile.name,
    dir: profile.dir,
    defaults: defaultsOf(answer),
    providers: Array.isArray(answer.providers) ? answer.providers.filter(isRecord) : [],
    ...effortsOf(answer),
    // A catalog that came back empty for its own reason, with the config still
    // readable. Separate from `error` because the panel can still show what the
    // profile is set to; it just cannot offer anything to change it to.
    catalogError: answer.catalogError ? redactForBrowser(answer.catalogError) : null,
    active: typeof answer.active === 'string' ? answer.active : null,
    error: answer.ok ? null : redactForBrowser(answer.error ?? 'Hermes could not be read.'),
    code: answer.ok ? null : (answer.code ?? 'unavailable'),
  };
}

// ----------------------------------------------------------- account limits ---

/**
 * How long one profile's account limits are reused without asking again.
 *
 * The numbers behind this move in five-hour and weekly windows, so a minute of
 * staleness is invisible; what it buys is that a rail redrawn on every
 * websocket frame, or four browsers on one daemon, is still one request
 * upstream. This is a *shared* cache, deliberately: the answer is about a
 * profile, not about a session.
 */
const USAGE_TTL_MS = 60_000;

/**
 * The soonest a "Refresh" click may actually reach the endpoint again.
 *
 * A refresh is a human saying "I don't believe the cache", so it skips the TTL
 * — but a button is also a thing that gets clicked twice, and the rate limit
 * that matters is upstream's, not this process's. Inside this window a refresh
 * gets the cached answer back, flagged `stale` so the panel can say the number
 * is the one it already had.
 */
const USAGE_REFRESH_MS = 10_000;

export interface UsageWindow {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  detail: string | null;
}

export interface AccountUsage {
  provider: string | null;
  supported: boolean;
  available: boolean;
  title: string;
  plan: string | null;
  source: string | null;
  fetchedAt: string | null;
  windows: UsageWindow[];
  details: string[];
  bankedResets: number | null;
  unavailableReason: string | null;
}

/** The cached half of an answer: what the bridge said, minus who asked. */
export interface UsageAnswer {
  usage: AccountUsage | null;
  note: string | null;
  fetchedAt: string;
  error: string | null;
  code: string | null;
}

export interface ProfileUsage extends UsageAnswer {
  profile: string;
  cached: boolean;
  throttled: boolean;
}

interface UsageCacheEntry {
  at: number;
  answer: UsageAnswer | undefined;
  inFlight?: Promise<UsageAnswer>;
}

/**
 * One entry per profile: `{ at, answer, inFlight }`.
 *
 * `inFlight` is the single-flight half. Two panels asking at once — or a panel
 * asking while a refresh is out — must be one bridge run and one HTTP request,
 * not two; without it the "avoid hammering" rule holds only for requests that
 * happen to be sequential.
 */
const usageCache = new Map<string, UsageCacheEntry>();

/** Test seam: a clock, so a TTL can be tested without waiting a minute. */
let usageNow: () => number = () => Date.now();

/** Drop everything remembered about account limits. For tests, and for logout. */
export function clearUsageCache(): void {
  usageCache.clear();
}

/** @internal Replace the clock the usage cache ages against. */
export function setUsageClock(clock: (() => number) | null | undefined): void {
  usageNow = typeof clock === 'function' ? clock : () => Date.now();
}

/**
 * The account limits behind one profile's configured provider.
 *
 * Only `openai-codex` has any: the bridge asks Hermes' own
 * `agent.account_usage` and every other provider comes back `supported: false`,
 * which the panel draws as "nothing to show here" rather than as a failure.
 *
 * Never throws for anything the account itself reports. A revoked login, an
 * endpoint that answered 500, a Hermes too old to have the module are all
 * answers with a `code` on them, because the panel has to draw *something* and
 * "not signed in" and "could not ask" are different sentences.
 *
 * @param home  HERMES_HOME
 */
export async function readProfileUsage(
  name: unknown,
  home: string,
  env: Env = process.env,
  { refresh = false }: { refresh?: boolean } = {}
): Promise<ProfileUsage> {
  const profile = getProfile(name, home);
  const key = profile.dir;
  const entry = usageCache.get(key);
  const now = usageNow();

  // Someone is already asking. Join them rather than starting a second run —
  // including on a refresh, because two clicks are still one question.
  if (entry?.inFlight) {
    return entry.inFlight.then((answer) => ({
      ...answer,
      profile: profile.name,
      cached: false,
      throttled: false,
    }));
  }

  const age = entry?.answer ? now - entry.at : Infinity;
  const within = refresh ? USAGE_REFRESH_MS : USAGE_TTL_MS;
  if (entry?.answer && age < within) {
    // `throttled` is the honest half: a refresh that was answered from the
    // cache did not ask again, and a panel that said "just now" over it would
    // be claiming a request that never happened.
    return { ...entry.answer, profile: profile.name, cached: true, throttled: refresh };
  }

  const pending = callBridge(['usage', '--dir', profile.dir], { home, dir: profile.dir, env }).then(
    (answer) => {
      const shaped: UsageAnswer = {
        // No `dir`: a path is not the panel's business, and this answer is the
        // one most likely to be screenshotted next to a support question.
        usage: usageOf(answer.usage),
        note: answer.catalogError ? redactForBrowser(answer.catalogError) : null,
        fetchedAt: new Date(usageNow()).toISOString(),
        error: answer.ok ? null : redactForBrowser(answer.error ?? 'Hermes could not read this account.'),
        code: answer.ok ? null : (answer.code ?? 'unavailable'),
      };
      // Cached either way. A failure is worth remembering for the same reason a
      // success is: a profile that is not signed in would otherwise spawn an
      // interpreter on every redraw to be told so again.
      usageCache.set(key, { at: usageNow(), answer: shaped });
      return shaped;
    }
  );

  usageCache.set(key, { at: entry?.at ?? 0, answer: entry?.answer, inFlight: pending });
  try {
    const answer = await pending;
    return { ...answer, profile: profile.name, cached: false, throttled: false };
  } catch (err) {
    // `callBridge` resolves rather than rejects, so this is a bug in the shaping
    // above — but a thrown promise left in the map would wedge the profile.
    usageCache.delete(key);
    throw err;
  }
}

/**
 * The usage block, field by field, with types.
 *
 * A whitelist for the same reason `_defaults_from` is one in the bridge: this
 * is the only payload in the app assembled from an answer a *provider* gave,
 * and "everything the bridge said" is not a contract anybody checked. A field
 * added upstream stays out until it is named here.
 */
function usageOf(usage: unknown): AccountUsage | null {
  if (!isRecord(usage)) return null;
  const percent = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  const text = (value: unknown, max = 200): string | null =>
    typeof value === 'string' && value.trim() ? redactForBrowser(value.trim()).slice(0, max) : null;
  const windows: UsageWindow[] = (Array.isArray(usage.windows) ? usage.windows : [])
    .slice(0, 8)
    .map((window) => {
      const w = isRecord(window) ? window : {};
      return {
        label: text(w.label, 40) ?? 'Limit',
        usedPercent: percent(w.usedPercent),
        remainingPercent: percent(w.remainingPercent),
        resetAt: text(w.resetAt, 40),
        detail: text(w.detail),
      };
    });
  const details = (Array.isArray(usage.details) ? usage.details : [])
    .slice(0, 8)
    .map((line) => text(line, 240))
    .filter((line): line is string => line !== null);
  return {
    provider: text(usage.provider, 64),
    supported: usage.supported === true,
    available: usage.available === true,
    title: text(usage.title, 64) ?? 'Account limits',
    plan: text(usage.plan, 64),
    source: text(usage.source, 64),
    fetchedAt: text(usage.fetchedAt, 40),
    windows,
    details,
    bankedResets:
      typeof usage.bankedResets === 'number' && Number.isFinite(usage.bankedResets) && usage.bankedResets >= 0
        ? Math.floor(usage.bankedResets)
        : null,
    unavailableReason: text(usage.unavailableReason, 240),
  };
}

export interface ProfileModelWrite {
  provider: string | null;
  model: string | null;
  /**
   * Tri-state: `undefined` says nothing, `null` says "leave it alone", `''`
   * clears the level, anything else sets it.
   */
  effort?: string | null;
}

export interface ProfileModelWritten extends ProfileEfforts {
  profile: string;
  dir: string;
  defaults: ProfileDefaults;
  error: string | null;
  code: string | null;
}

/**
 * Set this profile's global provider and model.
 *
 * Both fields go in one call because they are one decision: a provider written
 * without its model leaves the profile pointing at a model that provider does
 * not serve. The bridge writes them together and reads the file back, so the
 * answer is what is now on disk rather than what was asked for.
 */
export async function writeProfileModel(
  name: unknown,
  { provider, model, effort }: ProfileModelWrite,
  home: string,
  env: Env = process.env
): Promise<ProfileModelWritten> {
  const profile = getProfile(name, home);
  const answer = await callBridge(['write', '--dir', profile.dir], {
    home,
    dir: profile.dir,
    env,
    // `effort` is tri-state and `undefined` is one of the three, so it is only
    // put on the wire when the caller had something to say: `null` reaches the
    // bridge as "leave the level alone", `''` as "unset it".
    input: {
      provider: provider ?? null,
      model: model ?? null,
      ...(effort === undefined ? {} : { effort }),
    },
  });
  return {
    profile: profile.name,
    dir: profile.dir,
    defaults: defaultsOf(answer),
    ...effortsOf(answer),
    error: answer.ok ? null : redactForBrowser(answer.error ?? 'Hermes could not be written.'),
    code: answer.ok ? null : (answer.code ?? 'unavailable'),
  };
}
