/**
 * How to call an agent.
 *
 * `slick agent serve` spawns a real binary and reads its answer back, and it
 * used to know exactly one calling convention: the `claude` CLI's. Everything
 * else — Hermes, an in-house runner, a two-line shell script — had to be
 * wrapped in a shim that impersonated `claude` down to the shape of its JSON,
 * which is a program to write and keep working for what is really a table of
 * flag names.
 *
 * An adapter is that table written down instead of coded: which arguments
 * carry the prompt, the resumed conversation and the model, where in the
 * output the answer sits, and how long a message the far end will accept. Two
 * built-ins cover the common shapes; a workspace adds its own as JSON in
 * `$SLICK_HOME/adapters/<name>.json`, and that file *is* the installation.
 *
 * Real agents are not quite as tidy as one flag per value, so two escapes are
 * built in — both regex, both optional. An argument group can `match` its
 * value and spread the captures across several flags (`copilot::gpt-5.4`
 * becoming `-m gpt-5.4 --provider copilot`), and a reply field can be found by
 * `pattern` in output that is not JSON (a session id printed on stderr). What
 * neither will ever be is a program: no branching beyond one match, no
 * arithmetic, no reading the agent's own files. An agent whose answer needs
 * that still needs a wrapper, and should have one.
 *
 * Nothing here spawns anything — it builds an argv and reads a reply, so both
 * halves are testable without a child process, and the watcher stays the only
 * place that knows about processes. The one exception is `lookupReported`,
 * a single read-only row out of an agent's own store, kept in its own function
 * for exactly that reason.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { NotFoundError, ValidationError } from './errors.js';
import { paths } from './paths.js';

/**
 * The argument groups an adapter can fill, in the order they are handed to the
 * binary. A group is skipped whole when the value behind it is absent, so an
 * agent that has no `--model` simply leaves that key out and Slick stops
 * asking. `base` is the group with no value — flags that ride on every call.
 */
const ARG_SLOTS = [
  'prompt',
  'base',
  'stream',
  'resume',
  'permissionMode',
  'allowedTools',
  'skipPermissions',
  'model',
  'effort',
  'system',
  'listModels',
];

/** Groups built into the argv, in order. `listModels` is its own call. */
const CALL_SLOTS = ARG_SLOTS.filter((slot) => slot !== 'listModels');

/** Slots whose presence alone is the value — no placeholder to fill. */
const FLAG_SLOTS = new Set(['base', 'stream', 'skipPermissions', 'listModels']);

const PROMPT_VIA = new Set(['arg', 'stdin']);
const REPLY_FORMATS = new Set(['json', 'text']);
const STREAMS = new Set(['stdout', 'stderr', 'both']);
const STREAM_FORMATS = new Set(['jsonl']);

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The `claude` CLI, which is what `serve` has always called. It is spelled out
 * here rather than left in the watcher so that "the default" and "an adapter"
 * are the same kind of thing, and a workspace can retune it by dropping a
 * `claude.json` of its own next to the others.
 */
const CLAUDE = {
  label: 'Claude Code',
  cmd: 'claude',
  promptVia: 'arg',
  args: {
    prompt: ['-p', '{prompt}'],
    base: ['--output-format', 'json'],
    resume: ['--resume', '{session}'],
    permissionMode: ['--permission-mode', '{value}'],
    allowedTools: ['--allowedTools', '{value}'],
    skipPermissions: ['--dangerously-skip-permissions'],
    model: ['--model', '{model}'],
    effort: ['--effort', '{effort}'],
    system: ['--append-system-prompt', '{system}'],
    listModels: ['--list-models'],
  },
  reply: { format: 'json', text: 'result', sessionId: 'session_id', model: 'model', error: 'is_error' },
  installHint: 'npm install -g @anthropic-ai/claude-code',
};

/**
 * Anything that reads a prompt on stdin and prints an answer on stdout. It
 * cannot resume — there is no id to resume — so every message arrives with the
 * full context instead, which is the honest trade for a stateless command.
 */
const PLAIN = {
  label: 'Plain command',
  // No default binary: `--cmd` names it, because there is nothing to guess.
  cmd: null,
  promptVia: 'stdin',
  args: {},
  reply: { format: 'text' },
};

export const DEFAULT_ADAPTER = 'claude';

function fail(message, hint, details) {
  throw new ValidationError(message, { hint, details });
}

// --------------------------------------------------------------- arguments ---

function asStrings(value, what, at) {
  if (!Array.isArray(value) || value.some((part) => typeof part !== 'string')) {
    fail(`${at}: "${what}" must be a list of strings.`, 'For example: ["--model", "{model}"].');
  }
  return value;
}

function compile(source, what, at) {
  try {
    // A sticky or global pattern carries state between calls; nothing here
    // wants that, and `lastIndex` surviving a call is a bug nobody would find.
    return new RegExp(source);
  } catch (err) {
    return fail(`${at}: "${what}" is not a valid pattern: ${err.message}`);
  }
}

/**
 * One argument group, as written or as a match.
 *
 * The plain form is a list. The other form says the value has parts:
 *
 *     "model": {
 *       "match": "^(.+?)::(.+)$",
 *       "args": ["-m", "{2}", "--provider", "{1}"],
 *       "else": ["-m", "{value}"]
 *     }
 *
 * `{1}`, `{2}`, … are the captures. Without `else`, a value that does not
 * match leaves the group out, which is how you say "only this shape counts".
 */
function normalizeArgGroup(slot, raw, at) {
  if (Array.isArray(raw)) return { template: asStrings(raw, `args.${slot}`, at), match: null, alt: null };
  if (!raw || typeof raw !== 'object') {
    fail(`${at}: "args.${slot}" must be a list of strings, or an object with a "match".`);
  }
  if (typeof raw.match !== 'string' || !raw.match) {
    fail(`${at}: "args.${slot}" is an object, so it needs a "match" pattern.`, 'A plain list needs no match.');
  }
  return {
    template: asStrings(raw.args, `args.${slot}.args`, at),
    match: compile(raw.match, `args.${slot}.match`, at),
    alt: raw.else == null ? null : asStrings(raw.else, `args.${slot}.else`, at),
  };
}

const fill = (part, values) =>
  part.replace(/\{(\w+)\}/g, (whole, key) => (values[key] == null ? whole : String(values[key])));

/**
 * The argv for one call.
 *
 * @param {object} adapter
 * @param {{prompt?: string, session?: string|null, model?: string|null, system?: string|null,
 *          permissionMode?: string|null, allowedTools?: string|null, skipPermissions?: boolean}} values
 * @returns {string[]}
 */
export function buildAgentArgs(adapter, values = {}) {
  const of = {
    prompt: adapter.promptVia === 'stdin' ? null : values.prompt,
    resume: values.session,
    permissionMode: values.permissionMode,
    allowedTools: values.allowedTools,
    skipPermissions: values.skipPermissions,
    model: values.model,
    effort: values.effort,
    system: values.system,
    // Not a value to fill in, just the fact that this adapter has a `stream`
    // block: an agent is asked to narrate because we know how to read the
    // narration, so the flag rides along with the reading rather than being a
    // second thing to remember to turn on.
    stream: Boolean(adapter.stream),
  };
  const args = [];
  for (const slot of CALL_SLOTS) {
    const group = adapter.args?.[slot];
    if (!group) continue;
    if (FLAG_SLOTS.has(slot)) {
      if (slot === 'base' || of[slot]) args.push(...group.template);
      continue;
    }
    const value = of[slot];
    if (value == null || value === '' || value === false) continue;

    const bag = { ...values, value };
    let template = group.template;
    if (group.match) {
      const found = group.match.exec(String(value));
      if (found) found.forEach((capture, index) => index > 0 && (bag[index] = capture));
      else if (group.alt) template = group.alt;
      else continue; // the value is not the shape this group is for
    }
    args.push(...template.map((part) => fill(part, bag)));
  }
  return args;
}

// ------------------------------------------------------------------ replies ---

/** `~/x` → `/Users/you/x`; anything else is left as written. */
const expand = (path) => {
  const value = String(path);
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
};

/**
 * A lookup in the agent's own store, for the one thing an agent knows better
 * than it says: which model actually ran.
 *
 *     "model": {
 *       "sqlite": "~/.hermes/state.db",
 *       "query": "SELECT model FROM sessions WHERE id = ?",
 *       "bind": "sessionId"
 *     }
 *
 * One row, one column, read-only, bound to the session id we just read out of
 * the agent's output. It is a lookup and stays one: a single `SELECT` and no
 * semicolons.
 *
 * The answer itself can be looked up too, and sometimes has to be. A console
 * is a display, and an agent whose model streams its reasoning prints that
 * reasoning next to the answer — Hermes does, for some models, having already
 * written the clean final response to its own store. Where an adapter names a
 * lookup for `text` it wins over what was printed, and what was printed is
 * still there when the lookup comes back empty. The session id is the one
 * field that cannot be sourced this way: it is the key the others bind to.
 */
const LOOKUP_FIELDS = new Set(['text', 'model', 'effort']);

function normalizeLookup(raw, name, at) {
  if (!LOOKUP_FIELDS.has(name)) {
    fail(
      `${at}: "reply.${name}" cannot be read from a database.`,
      `Only ${[...LOOKUP_FIELDS].join(' and ')} can — the answer and the session id have to come from what the agent printed.`
    );
  }
  const query = String(raw.query ?? '').trim();
  if (!/^select\s/i.test(query) || query.includes(';')) {
    fail(`${at}: "reply.${name}.query" must be a single SELECT.`, 'For example: SELECT model FROM sessions WHERE id = ?');
  }
  const wants = (query.match(/\?/g) ?? []).length;
  if (wants > 1) fail(`${at}: "reply.${name}.query" may take at most one "?".`);
  const bind = raw.bind ?? (wants ? 'sessionId' : null);
  if (wants && bind !== 'sessionId') {
    fail(`${at}: "reply.${name}.bind" must be "sessionId".`, 'It is the only value read before the lookup runs.');
  }
  // A bind with nothing to bind to throws on every call, and the lookup
  // swallows its own errors — so the field would just never resolve, silently.
  if (!wants && raw.bind) {
    fail(`${at}: "reply.${name}.bind" has no "?" in the query to bind to.`, 'Add the placeholder, or drop the bind.');
  }
  const file = expand(raw.sqlite);
  if (!isAbsolute(file)) fail(`${at}: "reply.${name}.sqlite" must be an absolute path (or start with ~).`);
  return { sqlite: file, query, bind };
}

/**
 * Where one field of the reply is found: a path into JSON, a pattern to look
 * for in output that is not JSON, or a row in the agent's own store. A
 * `pattern` alongside `sqlite` trims what came back — a local model arrives as
 * a filesystem path, and only the file name of it is a model as a human knows
 * it.
 */
function normalizeField(raw, name, format, at) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    if (format !== 'json') {
      fail(
        `${at}: "reply.${name}" names a JSON field, but this reply is ${format}.`,
        'Give it a pattern instead: {"pattern": "session_id: (\\\\S+)", "from": "stderr"}.'
      );
    }
    return { path: raw, pattern: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${at}: "reply.${name}" must be a name or an object.`);

  const lookup = raw.sqlite ? normalizeLookup(raw, name, at) : null;
  if (!lookup && (typeof raw.pattern !== 'string' || !raw.pattern)) {
    fail(`${at}: "reply.${name}" is an object, so it needs a "pattern" or a "sqlite" lookup.`);
  }
  const from = raw.from ?? 'both';
  if (!STREAMS.has(from)) fail(`${at}: "reply.${name}.from" must be ${[...STREAMS].join(', ')}.`);
  const group = raw.group === undefined ? 1 : Number(raw.group);
  if (!Number.isInteger(group) || group < 0) fail(`${at}: "reply.${name}.group" must be a capture number.`);
  return {
    path: null,
    pattern: raw.pattern ? compile(raw.pattern, `reply.${name}.pattern`, at) : null,
    from,
    group,
    lookup,
  };
}

/** `a.b.c` out of a parsed reply; undefined when any step is missing. */
function pluck(value, path) {
  if (!path) return undefined;
  let current = value;
  for (const key of String(path).split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Look for a field in what the process printed.
 *
 * A field with a store behind it is not scraped at all: its pattern is there to
 * trim what the lookup returns, and a trimming pattern turned loose on stdout
 * will happily match the whole answer.
 */
function scan(field, streams) {
  if (!field?.pattern || field.lookup) return null;
  const sources =
    field.from === 'stdout' ? [streams.stdout] : field.from === 'stderr' ? [streams.stderr] : [streams.stdout, streams.stderr];
  for (const source of sources) {
    const found = field.pattern.exec(String(source ?? ''));
    if (!found) continue;
    const captured = (found[field.group] ?? found[0] ?? '').trim();
    if (captured) return captured;
  }
  return null;
}

/**
 * What the binary says it actually answered with, if it says at all. Slick asks
 * for a model, but the child is what resolves an alias, falls back, or ignores
 * us entirely — so a reply that names its own model is the only honest record
 * of which one wrote it. Absent for a binary that does not report one.
 */
function reportedModel(parsed, field) {
  const direct = pluck(parsed, field?.path ?? 'model') ?? parsed?.modelUsed;
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 200);
  // The `claude` CLI reports per-model token usage rather than a name; with one
  // model in it, that key is the answer.
  const usage = parsed?.modelUsage;
  const names = usage && typeof usage === 'object' ? Object.keys(usage) : [];
  return names.length === 1 ? names[0].slice(0, 200) : null;
}

/**
 * Read one call's output the way this adapter says to.
 *
 * A JSON adapter whose output did not parse falls through to the plain-text
 * reading rather than failing: a binary that printed a warning and then the
 * answer has still answered.
 *
 * @returns {{text: string, sessionId: string|null, model: string|null, error: string|null}}
 */
export function parseAgentReply(adapter, { stdout = '', stderr = '', code = 0, cmd = 'the agent' } = {}) {
  const trimmed = String(stdout).trim();
  const said = String(stderr).trim();
  const reply = adapter.reply ?? {};

  if (reply.format === 'json') {
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* not JSON */
    }
    // An answer that comes out of a store is not in this output at all, and
    // guessing at `result` would post the whole envelope as the reply.
    const pending = Boolean(reply.text?.lookup);
    const text = pending ? '' : pluck(parsed, reply.text?.path ?? 'result');
    if (parsed && (pending || typeof text === 'string')) {
      const sessionId = pluck(parsed, reply.sessionId?.path ?? 'session_id');
      const effort = pluck(parsed, reply.effort?.path);
      const answered = {
        sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
        model: reportedModel(parsed, reply.model),
        effort: typeof effort === 'string' && effort.trim() ? effort.trim().slice(0, 40) : null,
      };
      if (reply.error?.path && pluck(parsed, reply.error.path)) {
        return { text: '', ...answered, error: text || `${cmd} reported an error` };
      }
      // An answer nobody can post is a failure, not an answer: saying so puts
      // it in front of the human instead of losing it inside a retry.
      if (!pending && !text.trim()) return { text: '', ...answered, error: said || `${cmd} returned an empty answer` };
      return { text, ...answered, error: null };
    }
  }

  // Plain output. Whatever the adapter can find in it is worth keeping even
  // when the run failed: which conversation died is how the next one avoids it.
  const streams = { stdout, stderr };
  const found = {
    sessionId: scan(reply.sessionId, streams),
    model: scan(reply.model, streams),
    effort: scan(reply.effort, streams),
  };
  // A looked-up answer is not in the output; the caller fills it in, and an
  // empty one is that caller's problem to report rather than ours to guess at.
  const pending = Boolean(reply.text?.lookup);
  const text = pending ? '' : reply.text?.pattern ? scan(reply.text, streams) : trimmed;

  if (code !== 0) return { text: '', ...found, error: said || `${cmd} exited with code ${code}` };
  // An agent that reports failure in its own words while exiting 0 gets to say
  // so, the same way a JSON one does through its error field.
  const reported = scan(reply.error, streams);
  if (reported) return { text: '', ...found, error: reported };
  if (!text && !pending) return { text: '', ...found, error: said || `${cmd} produced no output` };
  return { text, ...found, error: null };
}

// ----------------------------------------------------------------- loading ---

/**
 * The agent's own slash commands, if it has any.
 *
 *     "commands": {
 *       "list": { "cmd": "…/python", "args": ["-c", "…"], "cwd": "…" },
 *       "run":  { "cmd": "…/python", "args": ["-c", "…", "{command}", "{args}"] }
 *     }
 *
 * `list` prints a JSON array of `{name, summary, args, aliases, where}` and is
 * what fills the composer's `/` menu. `run` is handed the command name and the
 * rest of the line and prints whatever the command has to say. Both are the
 * agent's business: Slick neither knows nor invents the vocabulary, it only
 * asks and shows the answer.
 */
function normalizeCommands(raw, at) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${at}: "commands" must be an object.`);
  const part = (name) => {
    const spec = raw[name];
    if (spec == null) return null;
    if (typeof spec !== 'object' || Array.isArray(spec)) fail(`${at}: "commands.${name}" must be an object.`);
    const args = asStrings(spec.args ?? [], `commands.${name}.args`, at);
    if (args.length === 0) fail(`${at}: "commands.${name}.args" cannot be empty.`);
    return {
      cmd: spec.cmd ? String(spec.cmd) : null,
      args,
      cwd: spec.cwd ? expand(String(spec.cwd)) : null,
    };
  };
  const list = part('list');
  const run = part('run');
  if (!list && !run) fail(`${at}: "commands" needs a "list", a "run", or both.`);
  if (run && !run.args.some((arg) => arg.includes('{command}'))) {
    fail(`${at}: "commands.run.args" has no "{command}" placeholder.`, 'Slick has to say which command to run.');
  }
  return { list, run };
}

/**
 * What the agent prints *while* it is still answering.
 *
 * The lookup above reads a reasoning console as a nuisance to be read around:
 * the clean answer is in the store, and whatever the model drew on the way
 * there is in the way. Read forward, a line at a time, that same console is
 * the only thing anyone has that says the agent is alive and what it is busy
 * with — so an adapter that can say where its frames keep their pieces gets to
 * pass them on as they land instead of having them thrown away at `close`.
 *
 *     "stream": {
 *       "format": "jsonl",
 *       "text":       "delta.text",
 *       "reasoning":  "delta.thinking",
 *       "step":       "tool.name",
 *       "stepStatus": "tool.status",
 *       "args": ["--stream-json"]
 *     }
 *
 * One frame per line, each field a dotted path read the same way a JSON reply
 * field is. Every path is optional: an agent that narrates its tools but not
 * its tokens names `step` and nothing else, and is no less streaming for it.
 * `args` is the flag that asks for the narration in the first place, spelled
 * inside the block because asking for it and knowing how to read it are one
 * decision — `buildAgentArgs` spreads it like any other group.
 *
 * None of this is a second way to read the answer. The `reply` block still
 * decides what actually gets posted, out of the whole of what was printed, and
 * an adapter with no `stream` is called and read exactly as it was before.
 */
function normalizeStream(raw, at) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${at}: "stream" must be an object.`);
  const format = raw.format ?? 'jsonl';
  if (!STREAM_FORMATS.has(format)) {
    fail(`${at}: "stream.format" must be ${[...STREAM_FORMATS].join(' or ')}.`, 'One JSON frame per line.');
  }
  const path = (name) => {
    const value = raw[name];
    if (value == null) return null;
    if (typeof value !== 'string' || !value) fail(`${at}: "stream.${name}" must be a field name, like "delta.text".`);
    return value;
  };
  const spec = {
    format,
    text: path('text'),
    reasoning: path('reasoning'),
    step: path('step'),
    stepStatus: path('stepStatus'),
    // A flag group with no value to fill, so it never needs the `match` form —
    // and naming the key the way the manifest spells it keeps the complaint
    // pointing at the line someone has just typed.
    args: raw.args == null ? null : { template: asStrings(raw.args, 'stream.args', at), match: null, alt: null },
  };
  if (!spec.text && !spec.reasoning && !spec.step) {
    fail(
      `${at}: "stream" names no field to read.`,
      'Give it a "text", a "reasoning" or a "step" path — otherwise there is nothing to send on.'
    );
  }
  // The reader rides along with the spec, so that whoever is holding the
  // adapter — the watcher, reading a line it has just seen printed — can read
  // a frame without also being handed the paths it was built from.
  spec.read = (frame) => readFrame(spec, frame);
  return spec;
}

/**
 * One streamed frame, as this adapter describes it.
 *
 * The paths are plucked exactly the way a JSON reply field is, so a frame that
 * is the wrong shape — a heartbeat, a usage summary, the envelope the answer
 * itself finally arrives in — reads as nothing and is skipped, rather than
 * being passed on as an empty flicker.
 *
 * @returns {{text: string|null, reasoning: string|null, step: string|null, stepStatus: string|null}|null}
 */
function readFrame(spec, frame) {
  if (!spec || !frame || typeof frame !== 'object') return null;
  const piece = (path) => {
    const value = pluck(frame, path);
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  };
  const text = piece(spec.text);
  const reasoning = piece(spec.reasoning);
  const step = piece(spec.step);
  if (!text && !reasoning && !step) return null;
  return { text, reasoning, step, stepStatus: piece(spec.stepStatus) };
}

/**
 * Check a manifest and fill in what it left out.
 *
 * Errors here name the file and the key, because the audience is someone who
 * has just hand-written JSON and needs to know which line to fix.
 *
 * @param {any} raw
 * @param {{name: string, source: string}} where
 */
export function normalizeAdapter(raw, { name, source }) {
  const at = source === 'built-in' ? `adapter "${name}"` : source;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${at} is not a JSON object.`, 'An adapter file holds one object: { "cmd": …, "args": { … } }.');
  }

  const rawArgs = raw.args ?? {};
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) fail(`${at}: "args" must be an object.`);
  const args = {};
  for (const [slot, group] of Object.entries(rawArgs)) {
    if (!ARG_SLOTS.includes(slot)) {
      fail(`${at}: unknown argument group "${slot}".`, `Known groups: ${ARG_SLOTS.join(', ')}.`);
    }
    args[slot] = normalizeArgGroup(slot, group, at);
  }

  const promptVia = raw.promptVia ?? 'arg';
  if (!PROMPT_VIA.has(promptVia)) fail(`${at}: "promptVia" must be ${[...PROMPT_VIA].join(' or ')}.`);
  if (promptVia === 'arg' && !(args.prompt?.template ?? []).some((part) => part.includes('{prompt}'))) {
    fail(
      `${at}: nothing carries the prompt.`,
      'Either give "args.prompt" a "{prompt}" placeholder, or set "promptVia": "stdin".'
    );
  }

  const rawReply = raw.reply ?? {};
  const format = rawReply.format ?? 'json';
  if (!REPLY_FORMATS.has(format)) fail(`${at}: "reply.format" must be ${[...REPLY_FORMATS].join(' or ')}.`);
  const reply = {
    format,
    text: normalizeField(rawReply.text ?? (format === 'json' ? 'result' : null), 'text', format, at),
    sessionId: normalizeField(rawReply.sessionId, 'sessionId', format, at),
    model: normalizeField(rawReply.model, 'model', format, at),
    effort: normalizeField(rawReply.effort, 'effort', format, at),
    error: normalizeField(rawReply.error, 'error', format, at),
  };

  // A stream block brings its own argument group with it, and it lands in
  // `args` with the rest so that nothing downstream has to know where it came
  // from.
  //
  // Which is why `args.stream` on its own is refused. Before `stream` existed
  // it was an unknown group and said so; now it validates, is overwritten by
  // nothing, and quietly never fires — the manifest asks the binary to narrate
  // and Slick has no idea how to read what comes back. A flag that does
  // nothing is worse than a flag that is rejected.
  if (rawArgs.stream != null && raw.stream == null) {
    fail(
      `${at}: "args.stream" has no "stream" block to go with it.`,
      'The flag that asks for the narration belongs inside "stream", beside the paths that read it.'
    );
  }
  const stream = normalizeStream(raw.stream, at);
  if (stream?.args) args.stream = stream.args;

  const max = raw.maxMessageLength ?? null;
  if (max !== null && (!Number.isFinite(Number(max)) || Number(max) <= 0)) {
    fail(`${at}: "maxMessageLength" must be a positive number of characters, or null.`);
  }

  return {
    name,
    label: String(raw.label ?? name),
    cmd: raw.cmd ? String(raw.cmd) : null,
    promptVia,
    args,
    reply,
    commands: normalizeCommands(raw.commands, at),
    stream,
    maxMessageLength: max === null ? null : Number(max),
    installHint: raw.installHint ? String(raw.installHint) : null,
    /** Docs for the human; Slick never sends it anywhere on its own. */
    description: raw.description ? String(raw.description) : null,
    source,
  };
}

/** @type {Record<string, ReturnType<typeof normalizeAdapter>>} */
export const BUILT_IN_ADAPTERS = Object.freeze({
  claude: Object.freeze(normalizeAdapter(CLAUDE, { name: 'claude', source: 'built-in' })),
  plain: Object.freeze(normalizeAdapter(PLAIN, { name: 'plain', source: 'built-in' })),
});

/** Where a workspace keeps the adapters it has added. */
export function adapterDir(home) {
  return paths(home).adapters;
}

/** @param {string} name */
export function adapterFile(name, home) {
  return join(adapterDir(home), `${name}.json`);
}

/** Read one manifest off disk, or null if there is no such file. */
function readManifest(name, home) {
  const file = adapterFile(name, home);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`${file} is not valid JSON: ${err.message}`, 'Fix the file, or delete it to fall back to the built-in.');
  }
  return normalizeAdapter(raw, { name, source: file });
}

/**
 * The adapter called `name`.
 *
 * A file always wins over a built-in of the same name, so retuning `claude`
 * for this workspace is a matter of writing `claude.json` — no new name to
 * remember, and no flag to change everywhere it is already typed.
 */
export function loadAdapter(name, home) {
  const wanted = String(name ?? DEFAULT_ADAPTER).trim();
  if (!NAME_RE.test(wanted)) {
    throw new ValidationError(`"${wanted}" is not a valid adapter name.`, {
      hint: 'Use letters, digits, "-", "_" or "." — it is a file name under ~/.slick/adapters.',
    });
  }
  const onDisk = readManifest(wanted, home);
  if (onDisk) return onDisk;
  const builtIn = BUILT_IN_ADAPTERS[wanted];
  if (builtIn) return builtIn;
  throw new NotFoundError(`No agent adapter called "${wanted}".`, {
    hint: `Run \`slick agent adapters\` to see them, or write ${adapterFile(wanted, home)}.`,
    details: { name: wanted, dir: adapterDir(home) },
  });
}

/**
 * Everything this workspace can call, built-ins included.
 *
 * A manifest that does not parse is listed with its complaint rather than
 * thrown: one bad file should cost you that adapter, not the ability to see
 * the others.
 *
 * @returns {Array<{name: string, label: string, source: string, error: string|null, adapter: object|null}>}
 */
export function listAdapters(home) {
  const found = new Map();
  for (const [name, adapter] of Object.entries(BUILT_IN_ADAPTERS)) {
    found.set(name, { name, label: adapter.label, source: 'built-in', error: null, adapter });
  }
  let files = [];
  try {
    files = readdirSync(adapterDir(home));
  } catch {
    /* no adapters directory: the built-ins are the whole list */
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    if (!NAME_RE.test(name)) continue;
    try {
      const adapter = readManifest(name, home);
      found.set(name, { name, label: adapter.label, source: adapter.source, error: null, adapter });
    } catch (err) {
      found.set(name, { name, label: name, source: adapterFile(name, home), error: err.message, adapter: null });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the agent's own records say about the run it just did.
 *
 * `--model` and `--effort` are requests. The agent resolves an alias against
 * its own config, falls back when a provider is unreachable, or was switched
 * by hand since — so for an agent that writes down what it did, the row it
 * wrote is the only honest answer, and a message keeps saying what wrote it
 * long after the setting has moved on.
 *
 * Never throws and never blocks for long: a badge is a nicety, and a locked,
 * missing or restructured database is not a reason to fail an answer that has
 * already been given.
 *
 * @param {object} adapter
 * @param {{sessionId: string|null}} reply
 * @param {'model'|'effort'} [name]
 * @returns {string|null}
 */
export function lookupReported(adapter, reply, name = 'model') {
  const field = adapter.reply?.[name];
  if (!field?.lookup) return null;
  const { sqlite, query, bind } = field.lookup;
  if (bind && !reply?.sessionId) return null;

  let db;
  try {
    db = new DatabaseSync(sqlite, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const row = db.prepare(query).get(...(bind ? [reply.sessionId] : []));
    const value = row ? Object.values(row)[0] : null;
    if (value == null || String(value).trim() === '') return null;
    const found = String(value).trim();
    // The same pattern that trims a scraped field trims a looked-up one: local
    // weights arrive as a path, and the file name is the model's real name.
    const trimmed = field.pattern ? (field.pattern.exec(found)?.[field.group] ?? found) : found;
    // A name is a name; an answer is as long as it is, and the message layer
    // is what decides how much of it fits in one post.
    const capped = name === 'text' ? trimmed : trimmed.slice(0, 200);
    return capped.trim() || null;
  } catch {
    return null; // no store, no row, no such table — no badge
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Would this argument group actually fire for this value?
 *
 * A badge that reports what was asked for has to know the asking happened: a
 * `match`-form group with no `else` drops a value it does not recognise, and
 * then the request never reached the binary at all.
 */
export function slotFires(adapter, slot, value) {
  const group = adapter.args?.[slot];
  if (!group || value == null || value === '' || value === false) return false;
  if (!group.match) return true;
  return Boolean(group.match.test(String(value)) || group.alt);
}

/** Does this agent have slash commands of its own to offer? */
export const supportsCommands = (adapter) => Boolean(adapter.commands?.list);

/**
 * The call that asks an agent for its command vocabulary.
 * @returns {{cmd: string, args: string[], cwd: string|null}|null}
 */
export function buildCommandListCall(adapter, cmd) {
  const spec = adapter.commands?.list;
  return spec ? { cmd: spec.cmd ?? cmd, args: [...spec.args], cwd: spec.cwd } : null;
}

/**
 * The call that runs one of them. `{command}` is the resolved name and
 * `{args}` the rest of the line, each substituted into its own argv entry so
 * nothing is ever re-parsed by a shell.
 *
 * @returns {{cmd: string, args: string[], cwd: string|null}|null}
 */
export function buildCommandRunCall(adapter, cmd, { command, args = '' } = {}) {
  const spec = adapter.commands?.run;
  if (!spec || !command) return null;
  const values = { command: String(command), args: String(args) };
  return {
    cmd: spec.cmd ?? cmd,
    args: spec.args.map((part) => fill(part, values)),
    cwd: spec.cwd,
  };
}

/** Can this adapter be handed a conversation to carry on? */
export const supportsResume = (adapter) => Boolean(adapter.args?.resume);

/** Will this adapter tell us what it can run? */
export const supportsModelList = (adapter) => Boolean(adapter.args?.listModels);

/** The argv that asks the binary what it can run, or null if it cannot be asked. */
export function buildModelListArgs(adapter) {
  return supportsModelList(adapter) ? [...adapter.args.listModels.template] : null;
}
