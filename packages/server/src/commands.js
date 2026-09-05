/**
 * Running an agent's own slash commands.
 *
 * Every agent worth talking to has a vocabulary of its own — `/compress`,
 * `/status`, `/reasoning` — and none of it is Slick's. So Slick does not
 * invent commands, model them, or keep a list: it asks the agent's adapter
 * what there is (`commands.list`) and hands one back when a human picks it
 * (`commands.run`).
 *
 * The result never becomes a message. It goes back in the HTTP response to
 * the person who typed it and is drawn as a line only they can see — which is
 * what a command's output is: an answer to one person's question, not
 * something the channel needs to keep. That is also why this lives in the
 * daemon rather than in the watcher: nothing about it belongs in the log.
 */

import { spawn } from 'node:child_process';

import {
  DEFAULT_ADAPTER,
  buildCommandListCall,
  buildCommandRunCall,
  loadAdapter,
  readServeAdapter,
  supportsCommands,
} from '@slick/core';

/** Long enough for a cold interpreter, short enough not to hold a request. */
const LIST_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 60_000;

/** A vocabulary does not change while you are typing into it. */
const LIST_TTL_MS = 10 * 60 * 1000;

/** As much output as is worth showing in a line above the composer. */
const MAX_OUTPUT = 20_000;

/** adapter name -> {at, commands} */
const listCache = new Map();

/**
 * Run one call and collect what it printed. Never throws: a command that will
 * not start is a message to show, not a failed request.
 *
 * @returns {Promise<{ok: boolean, output: string, error: string|null}>}
 */
function run(call, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(call.cmd, call.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: call.cwd ?? undefined,
      });
    } catch (err) {
      resolve({ ok: false, output: '', error: `could not start "${call.cmd}": ${err.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: `could not start "${call.cmd}": ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, output: '', error: `${call.cmd} did not answer within ${Math.round(timeoutMs / 1000)}s` });
        return;
      }
      const text = stdout.trim().slice(0, MAX_OUTPUT);
      const said = stderr.trim().slice(0, MAX_OUTPUT);
      if (code !== 0) resolve({ ok: false, output: text, error: said || `exited with code ${code}` });
      else resolve({ ok: true, output: text || said, error: null });
    });
  });
}

/** The adapter behind a session, as its watcher last recorded it. */
function adapterFor(ws, session) {
  return loadAdapter(readServeAdapter(session.state) ?? DEFAULT_ADAPTER, ws.home);
}

/**
 * One entry as the composer wants it. Anything the agent does not say is
 * simply absent — Slick does not fill in a description it does not have.
 */
function normalizeEntry(raw) {
  if (typeof raw === 'string') return { name: raw, summary: '', args: '', aliases: [], where: 'run' };
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().replace(/^\//, '');
  if (!name || !/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(name)) return null;
  return {
    name,
    summary: String(raw.summary ?? raw.description ?? '').slice(0, 200),
    args: String(raw.args ?? raw.args_hint ?? '').slice(0, 120),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String).slice(0, 8) : [],
    // A picker is a Slick-side adapter affordance. It may be available even
    // when the underlying Hermes command is session-only, because Slick routes
    // the selection through its authorized model endpoint.
    picker: String(raw.picker ?? '').slice(0, 32) || null,
    // What the agent says about running this one here. Anything other than
    // "run" is shown but not offered — the menu tells the truth about it.
    where: String(raw.where ?? 'run').slice(0, 32),
  };
}

/**
 * What this session's agent says it can be asked.
 *
 * @returns {Promise<{commands: Array, error: string|null, checkedAt: number|null}>}
 */
export async function listCommands(ws, ref, { force = false } = {}) {
  const session = ws.agents.get(ref);
  const adapter = adapterFor(ws, session);
  if (!supportsCommands(adapter)) return { commands: [], error: null, checkedAt: null };

  const cached = listCache.get(adapter.name);
  if (!force && cached && Date.now() - cached.at < LIST_TTL_MS) {
    return { commands: cached.commands, error: null, checkedAt: cached.at };
  }

  const call = buildCommandListCall(adapter, adapter.cmd);
  const result = await run(call, LIST_TIMEOUT_MS);
  if (!result.ok) return { commands: cached?.commands ?? [], error: result.error, checkedAt: cached?.at ?? null };

  let parsed;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return { commands: cached?.commands ?? [], error: 'the command list was not JSON', checkedAt: cached?.at ?? null };
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed?.commands ?? []);
  const commands = (Array.isArray(rows) ? rows : []).map(normalizeEntry).filter(Boolean).slice(0, 500);
  listCache.set(adapter.name, { at: Date.now(), commands });
  return { commands, error: null, checkedAt: Date.now() };
}

/**
 * Run one, and hand back what it said.
 *
 * @returns {Promise<{command: string, output: string, error: string|null}>}
 */
export async function runCommand(ws, ref, { command, args = '' } = {}) {
  const session = ws.agents.get(ref);
  const adapter = adapterFor(ws, session);
  const name = String(command ?? '').trim().replace(/^\//, '');
  if (!name) return { command: '', output: '', error: 'No command to run.' };

  const call = buildCommandRunCall(adapter, adapter.cmd, { command: name, args: String(args ?? '') });
  if (!call) {
    return { command: name, output: '', error: `The "${adapter.name}" adapter cannot run commands.` };
  }
  const result = await run(call, RUN_TIMEOUT_MS);
  return { command: name, output: result.output, error: result.error };
}
