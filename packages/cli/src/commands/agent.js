/**
 * `slick agent …` — everything an AI agent needs to take part in the
 * workspace, including the history key that lets it stop and pick up later.
 *
 * The shape of a typical agent run:
 *
 *   KEY=$(slick agent start --agent claude --channel general -q)   # once, ever
 *   slick agent resume $KEY --json                                 # every run
 *   slick agent pull   $KEY --json                                 # the loop
 *   slick agent post   $KEY "on it"                                # say something
 *   slick agent state set $KEY step=verifying                      # remember why
 */

import { ValidationError, looksLikeHistoryKey } from '@slick/core';
import { parseJsonFlag, resolveText } from '../args.js';
import {
  ago,
  json,
  line,
  ndjson,
  note,
  ok,
  renderMessage,
  renderTranscript,
  style,
  table,
} from '../output.js';
import { requireRef } from './channel.js';
import { serve, SERVE_SPEC } from './agent-serve.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where a history key can come from, in order of explicitness. */
function sessionRef(ctx, positional) {
  if (ctx.flags.key) return String(ctx.flags.key);
  if (positional && looksLikeHistoryKey(positional)) return positional;
  if (ctx.flags.name) return String(ctx.flags.name);
  if (positional) return positional;
  const fromEnv = process.env.SLICK_AGENT_KEY;
  if (fromEnv) return fromEnv;
  throw new ValidationError('Which session?', {
    hint: 'Pass the history key, or --name <session>, or set SLICK_AGENT_KEY.',
  });
}

function agentId(ctx) {
  return ctx.flags.agent ? String(ctx.flags.agent) : process.env.SLICK_AGENT_ID || undefined;
}

function readOptions(ctx) {
  return {
    agentId: agentId(ctx),
    limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
    channel: ctx.flags.channel,
    scope: ctx.flags.scope ?? (ctx.flags['this-channel'] ? 'session' : undefined),
    includeOwn: Boolean(ctx.flags['include-own']),
  };
}

function sessionHeadline(session) {
  const bits = [
    `${style.bold(session.agentId)} ${style.dim('[agent]')}`,
    session.name ? style.cyan(session.name) : null,
    style.dim(session.key),
  ].filter(Boolean);
  return bits.join(style.dim(' · '));
}

function printSessionDetail(session, pending) {
  line(sessionHeadline(session));
  const facts = [
    session.channelSlug ? `#${session.channelSlug}` : 'no default channel',
    `cursor ${session.cursorSeq}`,
    `${session.messageCount} posted`,
    `resumed ${session.resumeCount}×`,
    `last seen ${ago(session.lastSeenAt)}`,
  ];
  if (pending !== undefined) facts.unshift(pending > 0 ? style.yellow(`${pending} unread`) : 'caught up');
  line(style.dim(`  ${facts.join('  ·  ')}`));
}

/** Human-friendly rendering of a batch of events from pull/resume. */
function printEvents(events) {
  const messages = events.filter((e) => e.message).map((e) => e.message);
  if (messages.length > 0) {
    line(renderTranscript(messages));
    line();
  }
  const other = events.filter((e) => !e.message);
  for (const event of other) {
    line(`${style.dim('·')} ${style.magenta(event.type)} ${style.dim(`seq ${event.seq}`)}`);
  }
}

export const agent = {
  name: 'agent',
  aliases: ['a'],
  summary: 'Agent sessions: history keys, catching up, posting',
  usage: `slick agent <command>

  start                         mint a history key for an agent
  sessions                      list history keys and how far each has read
  resume [key|name]             re-orient after a restart (does not consume)
  pull [key|name]               read what is new and mark it read
  post [key] <text…>            post as the agent
  reply [key] <message-id> <text…>
  state [get|set|clear]         the agent's own JSON memory
  ack [key] [seq|latest]        move the read cursor by hand
  watch [key]                   stream new messages as they arrive
  serve [key|name]              call the real agent on new @mentions and post its reply
  end [key]                     close a session
  forget [key]                  delete a session record

Identity
  --agent <id>                  which agent (default $SLICK_AGENT_ID, else "agent")
  --key <slk_h1_…>              the history key   (default $SLICK_AGENT_KEY)
  --name <text>                 a memorable session name instead of the key

Reading
  --limit <n>                   how many events (default 50)
  --peek                        read without moving the cursor
  --include-own                 also return the agent's own messages
  --this-channel                only the session's channel
  --channel <channel>           only this channel

Writing
  --channel <channel>           where to post (default: the session's channel)
  --thread <message-id>         post into a thread
  --meta <json>                 attach structured data

Serving
  --all                         respond to every message, not just @mentions
  --cmd <bin>                   the agent binary to call (default: claude)
  --interval <ms>                poll interval (default 2000)
  --once                         handle one batch and exit
  --context <n>                  messages of context to give the agent (default 20)
  --system <text>                extra instruction appended to every prompt
  --append-system-prompt <text>  passed through to claude
  --dry-run                      print the prompt instead of calling and posting
  --permission-mode <mode>       passed through to claude
  --allowed-tools <tools>        passed through to claude as --allowedTools
  --dangerously-skip-permissions passed through to claude
  --model <name>                 passed through to claude
  --timeout <ms>                 kill the child if it runs this long (default 10m)
  --max-attempts <n>             give up on a message after n failures (default 3)
  --no-lock                      allow a second watcher on the same session key`,
  spec: {
    booleans: [
      'peek',
      'include-own',
      'this-channel',
      'all',
      'create',
      'reuse',
      'from-beginning',
      'replace',
      'once',
      'follow',
      ...SERVE_SPEC.booleans,
    ],
    strings: [
      'agent',
      'key',
      'name',
      'title',
      'channel',
      'limit',
      'thread',
      'meta',
      'scope',
      'interval',
      'context',
      ...SERVE_SPEC.strings,
    ],
  },

  async run(ctx) {
    const [sub = 'sessions', ...rest] = ctx.argv;
    const { ws, flags } = ctx;

    switch (sub) {
      // ------------------------------------------------------------ start ---
      case 'start':
      case 'join': {
        const session = await ws.agents.start({
          agentId: flags.agent ?? process.env.SLICK_AGENT_ID ?? 'agent',
          name: flags.name ?? rest[0] ?? null,
          title: flags.title,
          channel: flags.channel,
          fromBeginning: Boolean(flags['from-beginning']),
          reuse: Boolean(flags.reuse),
        });
        if (ctx.json) return json({ session });
        if (ctx.quiet) return line(session.key);
        ok(`History key for ${style.bold(session.agentId)}${session.reused ? style.dim(' (existing)') : ''}`);
        line();
        line(`  ${style.bold(style.green(session.key))}`);
        line();
        note('  Save it. Hand it back to `slick agent resume <key>` in your next run and');
        note('  you will get your saved state plus everything you missed.');
        if (session.channelSlug) note(`  Default channel: #${session.channelSlug}`);
        return;
      }

      // --------------------------------------------------------- sessions ---
      case 'sessions':
      case 'list':
      case 'ls': {
        const sessions = await ws.agents.list({
          agentId: agentId(ctx),
          includeEnded: Boolean(flags.all),
        });
        if (ctx.json) return json({ sessions });
        if (sessions.length === 0) {
          return note('No agent sessions yet. Create one: slick agent start --agent claude');
        }
        table(
          sessions.map((s) => ({
            key: style.green(s.key),
            agent: s.agentId,
            name: s.name ? style.cyan(s.name) : style.dim('—'),
            channel: s.channelSlug ? `#${s.channelSlug}` : style.dim('—'),
            cursor: String(s.cursorSeq),
            seen: ago(s.lastSeenAt),
            status: s.status === 'active' ? style.dim('active') : style.yellow(s.status),
          })),
          [
            { key: 'key', label: 'history key' },
            { key: 'agent', label: 'agent' },
            { key: 'name', label: 'name' },
            { key: 'channel', label: 'channel' },
            { key: 'cursor', label: 'cursor', align: 'right' },
            { key: 'seen', label: 'last seen' },
            { key: 'status', label: 'status' },
          ]
        );
        return;
      }

      // --------------------------------------------------------- resume ---
      case 'resume':
      case 'whoami': {
        const ref = sessionRef(ctx, rest[0]);
        const result = await ws.agents.resume(ref, {
          ...readOptions(ctx),
          contextLimit: flags.context ? Number(flags.context) : undefined,
          create: Boolean(flags.create),
          title: flags.title,
        });
        if (ctx.json) return json(result);

        printSessionDetail(result.session, result.pending);
        line();
        if (Object.keys(result.state).length > 0) {
          line(style.bold('Saved state'));
          for (const [key, value] of Object.entries(result.state)) {
            line(`  ${style.dim(key)}  ${typeof value === 'string' ? value : JSON.stringify(value)}`);
          }
          line();
        }
        if (result.missed.length > 0) {
          line(style.bold(`Missed while you were away (${result.pending})`));
          line();
          printEvents(result.missed);
          note(`  Mark them read with: slick agent pull ${result.session.key}`);
        } else {
          note('  Nothing new since you last read.');
          if (result.context.length > 0) {
            line();
            line(style.bold(`Recent conversation in #${result.channel?.slug ?? ''}`));
            line();
            line(renderTranscript(result.context.slice(-6)));
          }
        }
        return;
      }

      // ------------------------------------------------------------ pull ---
      case 'pull':
      case 'next': {
        const ref = sessionRef(ctx, rest[0]);
        const result = await ws.agents.pull(ref, { ...readOptions(ctx), peek: Boolean(flags.peek) });
        if (ctx.json) return json(result);
        if (result.events.length === 0) {
          return note(`Nothing new. Cursor at ${result.cursor}.`);
        }
        printEvents(result.events);
        note(
          `  ${result.events.length} event(s) · cursor ${result.previousCursor} → ${result.cursor}` +
            (result.pending > 0 ? ` · ${result.pending} still pending` : '') +
            (flags.peek ? style.yellow(' · peeked, cursor unchanged') : '')
        );
        return;
      }

      // ------------------------------------------------------------ post ---
      case 'post':
      case 'say': {
        const ref = sessionRef(ctx, rest[0]);
        const words = looksLikeHistoryKey(rest[0]) || rest[0] === ctx.flags.name ? rest.slice(1) : rest;
        const result = await ws.agents.post(ref, {
          agentId: agentId(ctx),
          channel: flags.channel,
          threadId: flags.thread ?? null,
          text: await resolveText(words),
          metadata: parseJsonFlag(flags.meta, 'meta') ?? null,
        });
        if (ctx.json) return json(result);
        if (ctx.quiet) return line(result.message.id);
        ok(
          `Posted to ${style.bold(`#${result.message.channelSlug}`)}` +
            (result.message.parentId ? style.dim(` (thread ${result.message.parentId})`) : '')
        );
        note(`  ${result.message.id}`);
        return;
      }

      // ----------------------------------------------------------- reply ---
      case 'reply': {
        const ref = sessionRef(ctx, rest[0]);
        const args = looksLikeHistoryKey(rest[0]) ? rest.slice(1) : rest;
        const rootId = requireRef(flags.thread ?? args[0], 'message id');
        const words = flags.thread ? args : args.slice(1);
        const result = await ws.agents.reply(ref, rootId, {
          agentId: agentId(ctx),
          text: await resolveText(words),
          metadata: parseJsonFlag(flags.meta, 'meta') ?? null,
        });
        if (ctx.json) return json(result);
        if (ctx.quiet) return line(result.message.id);
        ok(`Replied in thread ${style.dim(result.message.threadId)}`);
        note(`  ${result.message.id}`);
        return;
      }

      // ----------------------------------------------------------- state ---
      case 'state': {
        const [action = 'get', ...stateArgs] = rest;
        if (action === 'get' || action === 'show') {
          const ref = sessionRef(ctx, stateArgs[0]);
          const session = await ws.agents.get(ref, { agentId: agentId(ctx) });
          if (ctx.json) return json({ state: session.state, session });
          if (Object.keys(session.state).length === 0) return note('(no saved state)');
          return json(session.state);
        }
        if (action === 'set' || action === 'save' || action === 'put') {
          const first = stateArgs[0];
          const ref = sessionRef(ctx, looksLikeHistoryKey(first) ? first : undefined);
          const pairs = looksLikeHistoryKey(first) ? stateArgs.slice(1) : stateArgs;
          const value = parseStateArgs(pairs);
          const session = await ws.agents.setState(ref, value, {
            agentId: agentId(ctx),
            merge: !flags.replace,
          });
          if (ctx.json) return json({ session });
          ok(flags.replace ? 'State replaced.' : 'State saved.');
          return json(session.state);
        }
        if (action === 'clear') {
          const ref = sessionRef(ctx, stateArgs[0]);
          const session = await ws.agents.setState(ref, {}, { agentId: agentId(ctx), merge: false });
          if (ctx.json) return json({ session });
          return ok('State cleared.');
        }
        throw new ValidationError(`Unknown state command "${action}".`, { hint: 'Try: get, set, clear' });
      }

      // ------------------------------------------------------------- ack ---
      case 'ack': {
        const ref = sessionRef(ctx, rest[0]);
        const target = looksLikeHistoryKey(rest[0]) ? rest[1] : rest[0];
        const session = await ws.agents.ack(ref, target ?? 'latest');
        if (ctx.json) return json({ session });
        return ok(`Cursor moved to ${session.cursorSeq}.`);
      }

      // ----------------------------------------------------------- watch ---
      case 'watch':
      case 'follow': {
        const ref = sessionRef(ctx, rest[0]);
        const interval = Math.max(Number(flags.interval ?? 1000), 200);
        const options = readOptions(ctx);
        const asJson = ctx.json || !process.stdout.isTTY;
        if (!asJson) {
          const session = await ws.agents.get(ref, { agentId: agentId(ctx) });
          note(`Watching as ${session.agentId} — ctrl-c to stop.`);
          line();
        }
        for (;;) {
          const result = await ws.agents.pull(ref, { ...options, peek: Boolean(flags.peek) });
          for (const event of result.events) {
            if (asJson) ndjson(event);
            else if (event.message) line(`${renderMessage(event.message)}\n`);
            else line(`${style.dim('·')} ${style.magenta(event.type)}`);
          }
          if (flags.once) return;
          await sleep(interval);
        }
      }

      // ------------------------------------------------------------ serve ---
      case 'serve': {
        const ref = sessionRef(ctx, rest[0]);
        await serve(ws, ref, { agentId: agentId(ctx), flags, json: ctx.json });
        return;
      }

      // ------------------------------------------------------- end/forget ---
      case 'end':
      case 'close': {
        const session = await ws.agents.end(sessionRef(ctx, rest[0]));
        if (ctx.json) return json({ session });
        return ok(`Session ${session.key} closed after ${session.messageCount} message(s).`);
      }

      case 'forget':
      case 'delete':
      case 'rm': {
        const session = await ws.agents.remove(sessionRef(ctx, rest[0]));
        if (ctx.json) return json({ session });
        return ok(`Forgot ${session.key}. That history key no longer works.`);
      }

      default:
        throw new ValidationError(`Unknown agent command "${sub}".`, {
          hint: 'Try: start, sessions, resume, pull, post, reply, state, ack, watch, serve, end',
        });
    }
  },
};

/** Accepts `'{"a":1}'` or a list of `key=value` pairs. */
function parseStateArgs(args) {
  if (args.length === 0) {
    throw new ValidationError('Nothing to save.', {
      hint: 'slick agent state set step=verifying   or   slick agent state set \'{"step":"verifying"}\'',
    });
  }
  const joined = args.join(' ').trim();
  if (joined.startsWith('{')) return parseJsonFlag(joined, 'state');
  const out = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      throw new ValidationError(`"${arg}" is not key=value.`, {
        hint: 'Use key=value pairs, or pass a single JSON object.',
      });
    }
    const key = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
