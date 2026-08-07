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
import { line, note, ok, style, warn } from '../output.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function plainTranscript(messages) {
  return messages
    .filter((m) => !m.deleted)
    .map((m) => `[${timeFmt.format(m.createdAt)}] ${m.author.label}: ${m.text}`)
    .join('\n');
}

/** What we hand the model: who said what, the recent conversation, its own memory. */
function buildPrompt({ agentId, event, context, state, extra }) {
  const message = event.message;
  const parts = [
    `You are "${agentId}", a participant in a Slick workspace (a small Slack-shaped ` +
      `chat for one person and their AI agents). Someone just wrote a message that ` +
      `addresses you. Reply with only the message you want posted in the thread as ` +
      `your answer — no preamble like "Sure, here's my reply", no meta-commentary ` +
      `about being an AI.`,
  ];
  if (context?.length > 0) {
    parts.push(`Recent conversation in #${event.channelSlug ?? message.channelSlug ?? '?'}:\n${plainTranscript(context)}`);
  }
  if (state && Object.keys(state).length > 0) {
    parts.push(`Your saved state from earlier runs:\n${JSON.stringify(state)}`);
  }
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

  for (;;) {
    const resumed = await ws.agents.resume(ref, { ...readOpts, contextLimit, limit: 200 });
    const created = resumed.missed.filter((e) => e.type === 'message.created' && e.message);
    const targets = all ? created : created.filter((e) => (e.message.mentions ?? []).includes(respondAgentId));

    // A message we failed to answer, and everything after it, stays unread —
    // we would rather retry (and risk a duplicate reply once the trouble
    // clears) than silently skip something nobody ever saw.
    let failedAtSeq = null;

    for (const event of targets) {
      const prompt = buildPrompt({
        agentId: respondAgentId,
        event,
        context: resumed.context,
        state: resumed.state,
        extra: flags.system,
      });

      if (dryRun) {
        line(style.dim(`--- would call ${cmd} for ${event.message.id} ---`));
        line(prompt);
        line();
        continue;
      }

      const result = await callAgent({
        cmd,
        prompt,
        resumeId: claudeSessionId,
        permissionMode: flags['permission-mode'],
        allowedTools: flags['allowed-tools'],
        skipPermissions: Boolean(flags['dangerously-skip-permissions']),
        model: flags.model,
        appendSystemPrompt: flags['append-system-prompt'],
        timeoutMs,
      });

      if (result.sessionId) claudeSessionId = result.sessionId;

      if (result.error) {
        warn(`${cmd} failed on ${event.message.id}: ${result.error}`);
        failedAtSeq = event.seq;
        break;
      }

      const posted = await ws.agents.reply(ref, event.message.threadId, {
        agentId: ctx.agentId,
        text: result.text,
      });
      if (asJson) {
        line(JSON.stringify({ repliedTo: event.message.id, message: posted.message }));
      } else {
        ok(`Replied in thread ${style.dim(posted.message.threadId)}`);
      }
    }

    if (!dryRun) {
      if (claudeSessionId) {
        await ws.agents.setState(ref, { _serveSessionId: claudeSessionId }, { agentId: ctx.agentId, merge: true });
      }
      const safeCount = failedAtSeq == null ? resumed.missed.length : resumed.missed.findIndex((e) => e.seq === failedAtSeq);
      if (safeCount > 0) {
        await ws.agents.pull(ref, { ...readOpts, limit: safeCount });
      }
    }

    if (once) return;
    await sleep(interval);
  }
}

export const SERVE_SPEC = {
  booleans: ['dry-run', 'dangerously-skip-permissions'],
  strings: ['cmd', 'system', 'timeout', 'permission-mode', 'allowed-tools', 'model', 'append-system-prompt'],
};
