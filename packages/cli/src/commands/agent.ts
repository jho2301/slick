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

import {
  ValidationError,
  adapterDir,
  isRecord,
  listAdapters,
  looksLikeHistoryKey,
  readServeEffort,
  readServeModel,
  readServeModelChoices,
  supportsModelList,
  supportsResume,
  type AgentSession,
  type HydratedEvent,
  type JsonObject,
  type Message,
  type MessageMetadata,
} from '@slick/core';
import { flagNumber, flagOn, flagText, parseJsonFlag, resolveText } from '../args.ts';
import type { Command, CommandContext } from '../context.ts';
import { workspaceOf } from '../context.ts';
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
  warn,
} from '../output.ts';
import { requireRef } from './channel.ts';
import { serve, SERVE_SPEC } from './agent-serve.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a history key can come from, in order of explicitness. */
function sessionRef(ctx: CommandContext, positional: string | undefined): string {
  const key = flagText(ctx.flags, 'key');
  if (key) return key;
  if (positional && looksLikeHistoryKey(positional)) return positional;
  const name = flagText(ctx.flags, 'name');
  if (name) return name;
  if (positional) return positional;
  const fromEnv = process.env.SLICK_AGENT_KEY;
  if (fromEnv) return fromEnv;
  throw new ValidationError('Which session?', {
    hint: 'Pass the history key, or --name <session>, or set SLICK_AGENT_KEY.',
  });
}

function agentId(ctx: CommandContext): string | undefined {
  return flagText(ctx.flags, 'agent') ?? (process.env.SLICK_AGENT_ID || undefined);
}

function readOptions(ctx: CommandContext) {
  const scopeFlag = flagText(ctx.flags, 'scope');
  // Annotated, not asserted: an object literal would widen the literal to
  // `string`, and the services only take the two words.
  const scope: 'session' | 'workspace' | undefined =
    scopeFlag === 'session' || scopeFlag === 'workspace'
      ? scopeFlag
      : flagOn(ctx.flags, 'this-channel')
        ? 'session'
        : undefined;
  return {
    agentId: agentId(ctx),
    limit: flagNumber(ctx.flags, 'limit'),
    channel: flagText(ctx.flags, 'channel'),
    scope,
    includeOwn: flagOn(ctx.flags, 'include-own'),
  };
}

/** `--meta` as the agent service takes it. */
function metadataFlag(ctx: CommandContext): MessageMetadata | null {
  const parsed = parseJsonFlag(ctx.flags.meta, 'meta');
  if (parsed == null) return null;
  if (!isRecord(parsed)) throw new ValidationError('--meta must be a JSON object.');
  return parsed;
}

function sessionHeadline(session: AgentSession): string {
  const bits = [
    `${style.bold(session.agentId)} ${style.dim('[agent]')}`,
    session.name ? style.cyan(session.name) : null,
    style.dim(session.key),
  ].filter((bit): bit is string => Boolean(bit));
  return bits.join(style.dim(' · '));
}

function printSessionDetail(session: AgentSession, pending?: number): void {
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
function printEvents(events: HydratedEvent[]): void {
  const messages = events.map((e) => e.message).filter((m): m is Message => Boolean(m));
  if (messages.length > 0) {
    line(renderTranscript(messages));
    line();
  }
  const other = events.filter((e) => !e.message);
  for (const event of other) {
    line(`${style.dim('·')} ${style.magenta(event.type)} ${style.dim(`seq ${event.seq}`)}`);
  }
}

export const agent: Command = {
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
  model [key] [name]            read or change the model a running serve calls
                                (--list for the ones the agent says it can run)
  effort [key] [level]          read or change how hard it thinks (low…max)
  ack [key] [seq|latest]        move the read cursor by hand
  watch [key]                   stream new messages as they arrive
  serve [key|name]              call the real agent on new @mentions and post its reply
  adapters                      the calling conventions serve knows
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
  --adapter <name>              how to call the binary (default: claude;
                                slick agent adapters lists them)
  --cmd <bin>                   the agent binary to call (default: the adapter's)
  --interval <ms>                poll interval (default 2000)
  --once                         handle one batch and exit
  --context <n>                  messages of context to give the agent (default 20)
  --shared-session               one child conversation for every thread at once,
                                 instead of one per thread
  --system <text>                extra instruction appended to every prompt
  --append-system-prompt <text>  passed through, if the adapter takes one
  --dry-run                      print the prompt instead of calling and posting
  --permission-mode <mode>       passed through, if the adapter takes one
  --allowed-tools <tools>        passed through, if the adapter takes one
  --dangerously-skip-permissions passed through, if the adapter takes one
  --model <name>                 the model to ask for (the launch default;
                                 slick agent model overrides it, live)
  --effort <level>               how hard to think, if the adapter can ask
                                 (slick agent effort overrides it, live)
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
      'clear',
      'list',
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
    const ws = workspaceOf(ctx);
    const { flags } = ctx;

    switch (sub) {
      // ------------------------------------------------------------ start ---
      case 'start':
      case 'join': {
        const session = await ws.agents.start({
          agentId: flagText(flags, 'agent') ?? process.env.SLICK_AGENT_ID ?? 'agent',
          name: flagText(flags, 'name') ?? rest[0] ?? null,
          title: flagText(flags, 'title'),
          channel: flagText(flags, 'channel'),
          fromBeginning: flagOn(flags, 'from-beginning'),
          reuse: flagOn(flags, 'reuse'),
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
          includeEnded: flagOn(flags, 'all'),
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
            // The app hides sessions nobody answers for, so this table is
            // where they stay findable — and where you see why they are gone.
            serve: s.serve.live
              ? style.green('watching')
              : s.serve.served
                ? style.yellow('idle')
                : style.dim('posts only'),
            status: s.status === 'active' ? style.dim('active') : style.yellow(s.status),
          })),
          [
            { key: 'key', label: 'history key' },
            { key: 'agent', label: 'agent' },
            { key: 'name', label: 'name' },
            { key: 'channel', label: 'channel' },
            { key: 'cursor', label: 'cursor', align: 'right' },
            { key: 'seen', label: 'last seen' },
            { key: 'serve', label: 'serve' },
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
          contextLimit: flagNumber(flags, 'context'),
          create: flagOn(flags, 'create'),
          title: flagText(flags, 'title'),
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
        const result = await ws.agents.pull(ref, { ...readOptions(ctx), peek: flagOn(flags, 'peek') });
        if (ctx.json) return json(result);
        if (result.events.length === 0) {
          return note(`Nothing new. Cursor at ${result.cursor}.`);
        }
        printEvents(result.events);
        note(
          `  ${result.events.length} event(s) · cursor ${result.previousCursor} → ${result.cursor}` +
            (result.pending > 0 ? ` · ${result.pending} still pending` : '') +
            (flagOn(flags, 'peek') ? style.yellow(' · peeked, cursor unchanged') : '')
        );
        return;
      }

      // ------------------------------------------------------------ post ---
      case 'post':
      case 'say': {
        const ref = sessionRef(ctx, rest[0]);
        const words =
          looksLikeHistoryKey(rest[0]) || rest[0] === flagText(flags, 'name') ? rest.slice(1) : rest;
        const result = await ws.agents.post(ref, {
          agentId: agentId(ctx),
          channel: flagText(flags, 'channel'),
          threadId: flagText(flags, 'thread') ?? null,
          text: await resolveText(words),
          metadata: metadataFlag(ctx),
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
        const threadFlag = flagText(flags, 'thread');
        const rootId = requireRef(threadFlag ?? args[0], 'message id');
        const words = threadFlag ? args : args.slice(1);
        const result = await ws.agents.reply(ref, rootId, {
          agentId: agentId(ctx),
          text: await resolveText(words),
          metadata: metadataFlag(ctx),
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
            merge: !flagOn(flags, 'replace'),
          });
          if (ctx.json) return json({ session });
          ok(flagOn(flags, 'replace') ? 'State replaced.' : 'State saved.');
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

      // ----------------------------------------------------------- model ---
      // A `serve` watcher can be up for days, so the model it calls cannot
      // live only in its launch flags. It reads this back out of the session
      // on every pass; changing it here lands on the next message answered,
      // with no restart and without disturbing any thread's conversation.
      case 'model': {
        const first = rest[0];
        const named =
          looksLikeHistoryKey(first) || (first !== undefined && first === flagText(flags, 'name'));
        const ref = sessionRef(ctx, named ? first : undefined);
        const wanted = (named ? rest.slice(1) : rest).join(' ').trim();

        // What can this agent run? `serve` asks the binary itself
        // (`<cmd> --list-models`) and leaves the answer on the session.
        if (flagOn(flags, 'list')) {
          const session = await ws.agents.get(ref, { agentId: agentId(ctx) });
          const choices = readServeModelChoices(session.state);
          const model = readServeModel(session.state);
          if (ctx.json) return json({ model, choices });
          if (choices.length === 0) {
            return note('No list — this agent has not told `serve` what it can run. Any name still works.');
          }
          let group: string | null = null;
          for (const choice of choices) {
            if (choice.group !== group) {
              group = choice.group;
              if (group) line(style.dim(group));
            }
            line(
              `  ${choice.id === model ? style.green('●') : ' '} ${choice.label}${style.dim(`  ${choice.id}`)}`
            );
          }
          return;
        }

        if (!wanted && !flagOn(flags, 'clear')) {
          const session = await ws.agents.get(ref, { agentId: agentId(ctx) });
          const model = readServeModel(session.state);
          if (ctx.json) return json({ model, choices: readServeModelChoices(session.state), session });
          if (ctx.quiet) return line(model ?? '');
          if (!model)
            return note('No override — `serve` uses its own --model, or whatever the agent defaults to.');
          return line(model);
        }

        const session = await ws.agents.setModel(ref, flagOn(flags, 'clear') ? null : wanted, {
          agentId: agentId(ctx),
        });
        const model = readServeModel(session.state);
        if (ctx.json) return json({ model, session });
        if (model) ok(`Model set to ${style.bold(model)} — from the next message answered.`);
        else ok('Model override cleared.');
        return;
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
        const interval = Math.max(flagNumber(flags, 'interval') ?? 1000, 200);
        const options = readOptions(ctx);
        const asJson = ctx.json || !process.stdout.isTTY;
        if (!asJson) {
          const session = await ws.agents.get(ref, { agentId: agentId(ctx) });
          note(`Watching as ${session.agentId} — ctrl-c to stop.`);
          line();
        }
        for (;;) {
          const result = await ws.agents.pull(ref, { ...options, peek: flagOn(flags, 'peek') });
          for (const event of result.events) {
            if (asJson) ndjson(event);
            else if (event.message) line(`${renderMessage(event.message)}\n`);
            else line(`${style.dim('·')} ${style.magenta(event.type)}`);
          }
          if (flagOn(flags, 'once')) return;
          await sleep(interval);
        }
      }

      // ------------------------------------------------------------ serve ---
      case 'serve': {
        const ref = sessionRef(ctx, rest[0]);
        await serve(ws, ref, { agentId: agentId(ctx), flags, json: ctx.json });
        return;
      }

      // --------------------------------------------------------- effort ---
      // How hard the agent thinks, when it is the kind that can be told. No
      // `--list`: the levels are the agent's own vocabulary, documented in its
      // own --help, and Slick would only be guessing at them.
      case 'effort':
      case 'reasoning': {
        const first = rest[0];
        const named =
          looksLikeHistoryKey(first) || (first !== undefined && first === flagText(flags, 'name'));
        const ref = sessionRef(ctx, named ? first : undefined);
        const wanted = (named ? rest.slice(1) : rest).join(' ').trim();

        if (!wanted && !flagOn(flags, 'clear')) {
          const session = await ws.agents.get(ref, { agentId: agentId(ctx) });
          const effort = readServeEffort(session.state);
          if (ctx.json) return json({ effort, session });
          if (ctx.quiet) return line(effort ?? '');
          if (!effort) return note('No override — the agent thinks as hard as its own configuration says.');
          return line(effort);
        }

        const session = await ws.agents.setEffort(ref, flagOn(flags, 'clear') ? null : wanted, {
          agentId: agentId(ctx),
        });
        const effort = readServeEffort(session.state);
        if (ctx.json) return json({ effort, session });
        if (effort) ok(`Effort set to ${style.bold(effort)} — from the next message answered.`);
        else ok('Effort override cleared.');
        return;
      }

      // --------------------------------------------------------- adapters ---
      // What `serve --adapter` can be pointed at. A broken manifest is listed
      // with its complaint rather than thrown: one bad file should cost you
      // that adapter, not the ability to see the others.
      case 'adapters':
      case 'adapter': {
        const described = listAdapters(ws.home).map((entry) => ({
          name: entry.name,
          label: entry.label,
          source: entry.source,
          error: entry.error,
          cmd: entry.adapter?.cmd ?? null,
          promptVia: entry.adapter?.promptVia ?? null,
          resume: Boolean(entry.adapter && supportsResume(entry.adapter)),
          listsModels: Boolean(entry.adapter && supportsModelList(entry.adapter)),
          maxMessageLength: entry.adapter?.maxMessageLength ?? null,
        }));
        if (ctx.json) return json({ adapters: described, dir: adapterDir(ws.home) });
        table(
          described.map((a) => ({
            name: a.error ? style.yellow(a.name) : style.green(a.name),
            label: a.label,
            cmd: a.cmd ?? style.dim('--cmd'),
            prompt: a.promptVia ?? style.dim('—'),
            resume: a.resume ? 'yes' : style.dim('no'),
            models: a.listsModels ? 'asks' : style.dim('—'),
            limit: a.maxMessageLength ? String(a.maxMessageLength) : style.dim('—'),
            // The directory is on the footer line; the file name is the news.
            source:
              a.source === 'built-in' ? style.dim('built-in') : (a.source.split('/').at(-1) ?? a.source),
          })),
          [
            { key: 'name', label: 'adapter' },
            { key: 'label', label: 'label' },
            { key: 'cmd', label: 'command' },
            { key: 'prompt', label: 'prompt' },
            { key: 'resume', label: 'resume' },
            { key: 'models', label: 'models' },
            { key: 'limit', label: 'msg limit', align: 'right' },
            { key: 'source', label: 'from' },
          ]
        );
        for (const broken of described.filter((a) => a.error)) warn(`${broken.name}: ${broken.error}`);
        return note(`Add one by writing a JSON file in ${adapterDir(ws.home)}.`);
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
          hint: 'Try: start, sessions, resume, pull, post, reply, state, model, effort, ack, watch, serve, adapters, end',
        });
    }
  },
};

/** Accepts `'{"a":1}'` or a list of `key=value` pairs. */
function parseStateArgs(args: string[]): JsonObject {
  if (args.length === 0) {
    throw new ValidationError('Nothing to save.', {
      hint: 'slick agent state set step=verifying   or   slick agent state set \'{"step":"verifying"}\'',
    });
  }
  const joined = args.join(' ').trim();
  if (joined.startsWith('{')) {
    const parsed = parseJsonFlag(joined, 'state');
    if (!isRecord(parsed)) throw new ValidationError('State must be a JSON object.');
    return parsed;
  }
  const out: JsonObject = {};
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
