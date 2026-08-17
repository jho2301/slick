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
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, NotFoundError, slickHome } from '@slick/core';
import { line, note, ok, style, warn } from '../output.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Longest we will wait between passes once something is going wrong. */
const MAX_BACKOFF_MS = 60_000;

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

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/**
 * One `serve` per history key, per machine. Two watchers sharing a key consume
 * each other's messages — AGENTS.md warns about it — and double every process
 * they spawn, which is how one wedged retry became two hot loops.
 * @returns {() => void} release
 */
function claimSession(home, key) {
  const root = home ?? slickHome();
  const file = join(root, `serve-${key}.lock`);

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
      let owner = 0;
      try {
        owner = Number(readFileSync(file, 'utf8').trim());
      } catch {
        /* vanished under us — loop round and retry the claim */
      }
      if (owner && owner !== process.pid && isAlive(owner)) {
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
 * What we hand the model: the recent conversation, its memory, the message.
 * No standing "you are X, reply with only the post" preamble — every agent
 * behind `--cmd` already knows what it is from its own configuration, and one
 * resumed transcript would otherwise carry a fresh copy per message forever.
 */
function buildPrompt({ event, context, stateJson, extra }) {
  const message = event.message;
  const parts = [];
  if (context?.length > 0) {
    parts.push(`Recent conversation in #${event.channelSlug ?? message.channelSlug ?? '?'}:\n${plainTranscript(context)}`);
  }
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

  const readOpts = {
    agentId: ctx.agentId,
    channel: flags.channel,
    scope: flags.scope ?? (flags['this-channel'] ? 'session' : undefined),
  };

  const asJson = ctx.json || !process.stdout.isTTY;
  if (!asJson) {
    note(
      `Serving as ${style.bold(respondAgentId)} — ${all ? 'every message' : '@mentions only'}, ` +
        `via \`${cmd}\` — ctrl-c to stop.`
    );
    line();
  }

  let claudeSessionId = session.state?._serveSessionId ?? null;
  /**
   * Signature of the state the resumed transcript has already been shown. It
   * lives in the database next to the resume id because the transcript
   * outlives this process: a `--once` run would otherwise re-send the same
   * memory on every invocation.
   */
  let stateSig = session.state?._serveStateSig ?? null;
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

      const memory = publicState(resumed.state);
      const stateJson = Object.keys(memory).length > 0 ? JSON.stringify(memory) : null;
      const currentSig = stateJson ? stateSignature(stateJson) : null;

      for (const event of targets) {
        // A fresh session has never seen the agent's memory; a resumed one is
        // still holding the copy we sent it, so it only needs the new value
        // when the human (or the agent) has actually changed something.
        const includeState = (fresh) => Boolean(stateJson) && (fresh || !claudeSessionId || currentSig !== stateSig);
        const promptFor = (fresh) =>
          buildPrompt({
            event,
            context: resumed.context,
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
                model: flags.model,
                appendSystemPrompt: flags['append-system-prompt'],
                timeoutMs,
              });
            result = await call(claudeSessionId, promptFor(false));

            // One resumed transcript is reused for every message forever, so it
            // only ever grows. Once it outgrows the request limit every later
            // call fails identically — and because the id is saved, restarting
            // picks the same dead conversation right back up. Retire it and
            // answer from a clean session instead of retrying into the wall.
            if (result.error && claudeSessionId && isSessionFatal(result.error)) {
              warn(`Retiring the resumed ${cmd} session — ${result.error}`);
              claudeSessionId = null;
              stateSig = null; // the new transcript starts out knowing nothing
              await ws.agents.setState(
                ref,
                { _serveSessionId: null, _serveStateSig: null },
                { agentId: ctx.agentId, merge: true }
              );
              sentState = includeState(true);
              result = await call(null, promptFor(true));
            }
          } finally {
            await ws.agents.typing(ref, { ...typingOpts, on: false });
          }

          // Only a session that worked is worth remembering. Saving the id from
          // a failed call is what let the unusable one survive every restart.
          if (!result.error && result.sessionId) claudeSessionId = result.sessionId;
          // Likewise: only a call that landed proves the memory got through.
          if (!result.error && sentState) stateSig = currentSig;

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
        if (claudeSessionId) patch._serveSessionId = claudeSessionId;
        if (stateSig) patch._serveStateSig = stateSig;
        if (Object.keys(patch).length > 0) {
          await ws.agents.setState(ref, patch, { agentId: ctx.agentId, merge: true });
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
  booleans: ['dry-run', 'dangerously-skip-permissions', 'no-lock'],
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
