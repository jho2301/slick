/**
 * `slick agent serve` — makes an agent *callable* instead of merely
 * pollable. It watches a session for events that address it (by default,
 * `@mentions`) and for each one spawns the real agent (the `claude` CLI in
 * headless print mode, by default) with the conversation as context, then
 * posts what it says back into the thread.
 *
 * The child process is stateless in *our* eyes — we do not ask it to touch
 * Slick itself. We gather context, hand it a prompt, and post its final
 * answer. Whatever tools it used to get there (or didn't, by default) is
 * between it and its own permission settings.
 *
 * One Slick thread is one child conversation. A thread is where a topic lives
 * here, so it is the unit the agent's own memory should follow: resuming per
 * thread keeps two parallel conversations from reading each other's turns —
 * and keeps one busy channel from growing a single transcript that every
 * thread has to pay for on every turn.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  ConflictError,
  NotFoundError,
  SERVE_MODELS_AT_KEY,
  normalizeModelChoices,
  readServeModel,
  readServeLock,
  serveLockPath,
} from '@slick/core';
import { line, note, ok, style, warn } from '../output.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Longest we will wait between passes once something is going wrong. */
const MAX_BACKOFF_MS = 60_000;

/**
 * How many threads' child sessions we remember. Threads are cheap to start, so
 * an uncapped map would grow the session state forever; forgetting the least
 * recently used one costs that thread nothing but a fresh conversation if it
 * ever wakes up again.
 */
const THREAD_MEMORY = 50;

/** The single bucket every thread shares under `--shared-session`. */
const SHARED_THREAD = '*';

/**
 * How often we re-ask the binary which models it can run. Providers add and
 * retire models on their own schedule, so the answer goes stale — but not
 * within a day, and asking is a whole process spawn.
 */
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

/** Long enough for a provider round-trip, short enough to never hold a reply up. */
const MODELS_TIMEOUT_MS = 20_000;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Errors that mean "the conversation we asked to resume is unusable" rather
 * than "that call failed, try again". Retrying these against the same
 * `--resume` id can never work: the transcript has outgrown the request limit,
 * or it is gone. The cure is a fresh session, not another identical attempt.
 */
const SESSION_FATAL = [
  /request too large/i,
  /conversation cannot continue/i,
  /prompt is too long/i,
  /exceeds? the maximum/i,
  /context (?:window|length) (?:exceeded|too long)/i,
  /no conversation found/i,
  /session .{0,80}? not found/i,
];

const isSessionFatal = (message) => SESSION_FATAL.some((re) => re.test(message ?? ''));

/**
 * One `serve` per history key, per machine. Two watchers sharing a key consume
 * each other's messages — AGENTS.md warns about it — and double every process
 * they spawn, which is how one wedged retry became two hot loops.
 * @returns {() => void} release
 */
function claimSession(home, key) {
  // The path comes from the core because the lock is not private bookkeeping:
  // it is how everything else — the rail, the mention picker — knows this
  // session answers when you talk to it.
  const file = serveLockPath(key, home);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx'); // fails outright if someone holds it
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => {
          release();
          process.exit(signal === 'SIGINT' ? 130 : 143);
        });
      }
      return release;
    } catch (err) {
      // An unwritable home is not a reason to refuse to work.
      if (err.code !== 'EEXIST') return () => {};
      // Same reader the rest of Slick uses to decide whether this session has
      // a watcher, so "someone holds the lock" means one thing everywhere.
      const owner = readServeLock(key, home)?.pid ?? 0;
      if (owner && owner !== process.pid) {
        throw new ConflictError(`Another \`slick agent serve\` (pid ${owner}) is already watching "${key}".`, {
          hint: `Stop it first, or run this one against a different session. Lock: ${file}`,
        });
      }
      // The holder is gone (crash, kill -9). Clear its lock and try again.
      try {
        unlinkSync(file);
      } catch {
        /* raced with another starter; the next attempt settles it */
      }
    }
  }
  return () => {};
}

function plainTranscript(messages) {
  return messages
    .filter((m) => !m.deleted)
    .map((m) => `[${timeFmt.format(m.createdAt)}] ${m.author.label}: ${m.text}`)
    .join('\n');
}

/**
 * The agent's own memory, minus our bookkeeping. `serve` keeps its resume id
 * (and the signature below) in the same bag the human writes to with
 * `slick agent state set`, and neither belongs in a prompt: the model cannot
 * use them, and they would make "has the state changed?" fire on our writes.
 */
function publicState(state) {
  const out = {};
  for (const [key, value] of Object.entries(state ?? {})) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

const stateSignature = (json) => createHash('sha256').update(json).digest('hex').slice(0, 16);

/**
 * Which model the child should run *this pass*. `--model` fixes a default when
 * the watcher starts, but a watcher can stay up for days, and a launch flag
 * cannot be reached once it has. The session's own state can be, from the CLI
 * (`slick agent model`), from the app, or from anything else holding the
 * database — so that is where the answer lives, and it is re-read every pass.
 */

/**
 * The child sessions this watcher is holding, as stored under `_serveThreads`:
 * `threadId → {sessionId, stateSig, at}`. It lives in the database rather than
 * in this process so a restart — or a `--once` cron run — picks every thread
 * back up where it left off instead of starting each one over.
 */
function loadThreads(state) {
  const threads = new Map();
  const stored = state?._serveThreads;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return threads;
  for (const [threadId, entry] of Object.entries(stored)) {
    if (!entry || typeof entry !== 'object') continue;
    threads.set(threadId, {
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      stateSig: typeof entry.stateSig === 'string' ? entry.stateSig : null,
      at: Number(entry.at) || 0,
    });
  }
  return threads;
}

/** Drop the empty and the least recently used entries, in place. */
function prune(threads) {
  for (const [threadId, entry] of threads) {
    if (!entry.sessionId && !entry.stateSig) threads.delete(threadId);
  }
  if (threads.size > THREAD_MEMORY) {
    const stale = [...threads.entries()].sort((a, b) => b[1].at - a[1].at).slice(THREAD_MEMORY);
    for (const [threadId] of stale) threads.delete(threadId);
  }
  return Object.fromEntries(threads);
}

/**
 * The conversation this thread's session should be shown: the thread itself.
 * The channel tail is the right context for a mention that *starts* a thread —
 * it is what orients a brand-new session — but once a thread has a session of
 * its own, other people's other threads are noise inside it.
 *
 * @returns {Promise<Array|null>} null when the caller should use the channel tail
 */
async function threadContext(ws, message, limit) {
  if (limit <= 0 || !message.threadId || message.threadId === message.id) return null;
  try {
    const { root, replies } = await ws.messages.thread(message.threadId);
    const earlier = [root, ...replies].filter((m) => m && !m.deleted && m.seq < message.seq);
    return earlier.length > 0 ? earlier.slice(-limit) : null;
  } catch {
    return null; // context is a nicety — never fail an answer over it
  }
}

/**
 * What we hand the model: the recent conversation, its memory, the message.
 * No standing "you are X, reply with only the post" preamble — every agent
 * behind `--cmd` already knows what it is from its own configuration, and one
 * resumed transcript would otherwise carry a fresh copy per message forever.
 */
function buildPrompt({ event, context, contextLabel, stateJson, extra }) {
  const message = event.message;
  const parts = [];
  if (context?.length > 0) parts.push(`${contextLabel}\n${plainTranscript(context)}`);
  if (stateJson) parts.push(`Your saved state from earlier runs:\n${stateJson}`);
  parts.push(`The message to answer, from ${message.author.label}:\n${message.text}`);
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

/**
 * Spawn the agent binary and collect its reply.
 * @returns {Promise<{text: string, sessionId: string|null, error: string|null}>}
 */
function callAgent({ cmd, prompt, resumeId, permissionMode, allowedTools, skipPermissions, model, appendSystemPrompt, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (resumeId) args.push('--resume', resumeId);
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (allowedTools) args.push('--allowedTools', allowedTools);
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (model) args.push('--model', model);
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ text: '', sessionId: null, error: `could not start "${cmd}": ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        /* not JSON */
      }
      if (parsed && typeof parsed.result === 'string') {
        if (parsed.is_error) {
          resolve({ text: '', sessionId: parsed.session_id ?? null, error: parsed.result || `${cmd} reported an error` });
        } else {
          resolve({ text: parsed.result, sessionId: parsed.session_id ?? null, error: null });
        }
        return;
      }
      if (code !== 0) {
        resolve({ text: '', sessionId: null, error: stderr.trim() || `${cmd} exited with code ${code}` });
        return;
      }
      const text = stdout.trim();
      if (!text) {
        resolve({ text: '', sessionId: null, error: stderr.trim() || `${cmd} produced no output` });
        return;
      }
      resolve({ text, sessionId: null, error: null });
    });
  });
}

/**
 * Ask the agent binary what it can run: `<cmd> --list-models`, answered with
 * JSON. Agents that have never heard of the flag (the `claude` CLI, today)
 * fail or print something else, and that is a fine answer — it just means
 * this session types its model rather than picking it.
 *
 * @returns {Promise<Array|null>} null when the binary did not answer with a list
 */
function askModels(cmd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['--list-models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), MODELS_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', () => {}); // drained so a chatty binary cannot block
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const choices = normalizeModelChoices(JSON.parse(stdout));
        resolve(choices.length > 0 ? choices : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Run the watch-and-respond loop for one session.
 * @param {import('@slick/core').Workspace} ws
 * @param {string} ref
 * @param {{agentId: string|undefined, flags: Record<string, any>}} ctx
 */
export async function serve(ws, ref, ctx) {
  const { flags } = ctx;
  const session = await ws.agents.get(ref, { agentId: ctx.agentId });
  const respondAgentId = ctx.agentId ?? session.agentId;

  const interval = Math.max(Number(flags.interval ?? 2000), 500);
  const once = Boolean(flags.once);
  const all = Boolean(flags.all);
  const dryRun = Boolean(flags['dry-run']);
  const contextLimit = flags.context !== undefined ? Number(flags.context) : 20;
  const cmd = flags.cmd ?? 'claude';
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 10 * 60 * 1000;
  const maxAttempts = Math.max(Number(flags['max-attempts'] ?? 3), 1);
  const shared = Boolean(flags['shared-session']);

  const readOpts = {
    agentId: ctx.agentId,
    channel: flags.channel,
    scope: flags.scope ?? (flags['this-channel'] ? 'session' : undefined),
  };

  const asJson = ctx.json || !process.stdout.isTTY;
  if (!asJson) {
    note(
      `Serving as ${style.bold(respondAgentId)} — ${all ? 'every message' : '@mentions only'}, ` +
        `via \`${cmd}\` — ${shared ? 'one shared conversation' : 'one conversation per thread'}, ctrl-c to stop.`
    );
    line();
  }

  /**
   * One child conversation per thread, and against each the signature of the
   * state that conversation has already been shown — a resumed transcript is
   * still holding the copy we sent it, so re-sending unchanged memory would
   * just be paid for again on every turn.
   */
  const threads = loadThreads(session.state);
  // Before this was per-thread there was a single id for the whole watcher.
  // Which thread it belongs to is unknowable now, so it is only worth keeping
  // when this watcher is deliberately still sharing one conversation.
  const legacyId = session.state?._serveSessionId ?? null;
  if (shared && legacyId && !threads.has(SHARED_THREAD)) {
    threads.set(SHARED_THREAD, {
      sessionId: legacyId,
      stateSig: session.state?._serveStateSig ?? null,
      at: Date.now(),
    });
  }
  let staleKeys = legacyId != null || session.state?._serveStateSig != null;
  /** The model the last pass used, so a change is announced once, not per pass. */
  let activeModel = readServeModel(session.state) ?? flags.model ?? null;
  let threadsChanged = false;
  /** message id → consecutive failed attempts, so one bad message cannot wedge the queue. */
  const failures = new Map();
  let backoff = interval;

  const release = flags['no-lock'] ? () => {} : claimSession(ws.home, session.key);
  try {
    for (;;) {
      const resumed = await ws.agents.resume(ref, { ...readOpts, contextLimit, limit: 200 });
      const created = resumed.missed.filter((e) => e.type === 'message.created' && e.message);
      const targets = all ? created : created.filter((e) => (e.message.mentions ?? []).includes(respondAgentId));

      // A message we failed to answer, and everything after it, stays unread —
      // we would rather retry (and risk a duplicate reply once the trouble
      // clears) than silently skip something nobody ever saw.
      let failedAtSeq = null;

      // Keep the app's model picker stocked. It is the watcher that knows how
      // to reach the binary, so it is the watcher that asks — on the way past,
      // at most once a TTL, and never at the cost of an answer.
      if (!dryRun && Date.now() - Number(resumed.state?.[SERVE_MODELS_AT_KEY] ?? 0) > MODELS_TTL_MS) {
        const choices = await askModels(cmd);
        try {
          // The timestamp is written either way: a binary with no such flag
          // must be asked once a TTL, not once a pass.
          await ws.agents.setModelChoices(ref, choices, { agentId: ctx.agentId });
          if (choices && !asJson) note(`${cmd} offers ${choices.length} model(s)`);
        } catch (err) {
          warn(`Could not save the model list: ${err.message}`);
        }
      }

      // Re-read every pass, so `slick agent model` reaches a running watcher.
      const model = readServeModel(resumed.state) ?? flags.model ?? null;
      if (model !== activeModel) {
        if (!asJson) note(`Model → ${style.bold(model ?? `${cmd} default`)}`);
        activeModel = model;
      }

      const memory = publicState(resumed.state);
      const stateJson = Object.keys(memory).length > 0 ? JSON.stringify(memory) : null;
      const currentSig = stateJson ? stateSignature(stateJson) : null;

      for (const event of targets) {
        const threadKey = shared ? SHARED_THREAD : (event.message.threadId ?? event.message.id);
        const thread = threads.get(threadKey) ?? { sessionId: null, stateSig: null, at: 0 };

        // A fresh session has never seen the agent's memory; a resumed one is
        // still holding the copy we sent it, so it only needs the new value
        // when the human (or the agent) has actually changed something.
        const includeState = (fresh) =>
          Boolean(stateJson) && (fresh || !thread.sessionId || currentSig !== thread.stateSig);
        const inThread = shared ? null : await threadContext(ws, event.message, contextLimit);
        const promptFor = (fresh) =>
          buildPrompt({
            event,
            context: inThread ?? resumed.context,
            contextLabel: inThread
              ? 'Earlier in this thread:'
              : `Recent conversation in #${event.channelSlug ?? event.message.channelSlug ?? '?'}:`,
            stateJson: includeState(fresh) ? stateJson : null,
            extra: flags.system,
          });

        if (dryRun) {
          line(style.dim(`--- would call ${cmd} for ${event.message.id} ---`));
          line(promptFor(false));
          line();
          continue;
        }

        const typingOpts = {
          agentId: ctx.agentId,
          threadId: event.message.threadId,
          channelId: event.message.channelId,
        };
        // A thread can vanish out from under us (the human deletes it, a
        // race with the API, ...) between resume() handing us the event and
        // reply() landing — that must not take the whole watcher down.
        try {
          await ws.agents.typing(ref, { ...typingOpts, on: true });
          let result;
          let sentState = includeState(false);
          try {
            const call = (resumeId, prompt) =>
              callAgent({
                cmd,
                prompt,
                resumeId,
                permissionMode: flags['permission-mode'],
                allowedTools: flags['allowed-tools'],
                skipPermissions: Boolean(flags['dangerously-skip-permissions']),
                model,
                appendSystemPrompt: flags['append-system-prompt'],
                timeoutMs,
              });
            result = await call(thread.sessionId, promptFor(false));

            // A thread's transcript is resumed for every message in it, so it
            // only ever grows. Once it outgrows the request limit every later
            // call fails identically — and because the id is saved, restarting
            // picks the same dead conversation right back up. Retire it and
            // answer from a clean session instead of retrying into the wall.
            if (result.error && thread.sessionId && isSessionFatal(result.error)) {
              warn(`Retiring the resumed ${cmd} session for ${threadKey} — ${result.error}`);
              thread.sessionId = null;
              thread.stateSig = null; // the new transcript starts out knowing nothing
              threads.delete(threadKey);
              // The whole map goes out, so nothing another thread earned
              // earlier in this pass is left waiting to be written.
              await ws.agents.setState(ref, { _serveThreads: prune(threads) }, { agentId: ctx.agentId, merge: true });
              threadsChanged = false;
              sentState = includeState(true);
              result = await call(null, promptFor(true));
            }
          } finally {
            await ws.agents.typing(ref, { ...typingOpts, on: false });
          }

          // Only a session that worked is worth remembering. Saving the id from
          // a failed call is what let the unusable one survive every restart.
          // Likewise, only a call that landed proves the memory got through.
          if (!result.error && result.sessionId) {
            threads.set(threadKey, {
              sessionId: result.sessionId,
              stateSig: sentState ? currentSig : thread.stateSig,
              at: Date.now(),
            });
            threadsChanged = true;
          }

          if (result.error) {
            const attempts = (failures.get(event.message.id) ?? 0) + 1;
            failures.set(event.message.id, attempts);
            warn(`${cmd} failed on ${event.message.id} (${attempts}/${maxAttempts}): ${result.error}`);
            if (attempts < maxAttempts) {
              failedAtSeq = event.seq;
              break;
            }
            // Out of attempts. Holding the cursor here forever hides every
            // message behind this one, so say so in the thread and move on.
            failures.delete(event.message.id);
            try {
              await ws.agents.reply(ref, event.message.threadId, {
                agentId: ctx.agentId,
                text: `⚠️ I could not answer this after ${maxAttempts} attempts. Last error: ${result.error}`,
              });
            } catch (err) {
              warn(`Could not post the failure note for ${event.message.id}: ${err.message}`);
            }
            continue;
          }
          failures.delete(event.message.id);

          const posted = await ws.agents.reply(ref, event.message.threadId, {
            agentId: ctx.agentId,
            text: result.text,
          });
          if (asJson) {
            line(JSON.stringify({ repliedTo: event.message.id, message: posted.message }));
          } else {
            ok(`Replied in thread ${style.dim(posted.message.threadId)}`);
          }
        } catch (err) {
          // A message that has been hard-removed can never be answered — retrying
          // it forever would wedge every mention behind it. Anything else (a
          // transient claude failure, a DB hiccup) keeps the existing
          // retry-and-block behavior in case the trouble clears.
          if (err instanceof NotFoundError) {
            warn(`Skipping ${event.message.id}: ${err.message}`);
            failures.delete(event.message.id);
            continue;
          }
          const attempts = (failures.get(event.message.id) ?? 0) + 1;
          failures.set(event.message.id, attempts);
          warn(`Could not answer ${event.message.id} (${attempts}/${maxAttempts}): ${err.message}`);
          if (attempts >= maxAttempts) {
            failures.delete(event.message.id);
            continue;
          }
          failedAtSeq = event.seq;
          break;
        }
      }

      if (!dryRun) {
        const patch = {};
        if (threadsChanged) patch._serveThreads = prune(threads);
        // The one-session-for-everything bookkeeping this replaced. Nothing
        // reads it any more, so clear it rather than leave a dead id behind
        // that looks like it is still in use.
        if (staleKeys) {
          patch._serveSessionId = null;
          patch._serveStateSig = null;
        }
        if (Object.keys(patch).length > 0) {
          await ws.agents.setState(ref, patch, { agentId: ctx.agentId, merge: true });
          threadsChanged = false;
          staleKeys = false;
        }
        const safeCount = failedAtSeq == null ? resumed.missed.length : resumed.missed.findIndex((e) => e.seq === failedAtSeq);
        if (safeCount > 0) {
          await ws.agents.pull(ref, { ...readOpts, limit: safeCount });
        }
      }

      if (once) return;
      // A pass that got stuck waits longer each time, so a persistent failure
      // settles into a patient watcher rather than a hot loop that spawns a
      // process every couple of seconds.
      backoff = failedAtSeq == null ? interval : Math.min(backoff * 2, MAX_BACKOFF_MS);
      await sleep(backoff);
    }
  } finally {
    release();
  }
}

export const SERVE_SPEC = {
  booleans: ['dry-run', 'dangerously-skip-permissions', 'no-lock', 'shared-session'],
  strings: [
    'cmd',
    'system',
    'timeout',
    'permission-mode',
    'allowed-tools',
    'model',
    'append-system-prompt',
    'max-attempts',
  ],
};
