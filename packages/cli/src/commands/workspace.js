import { existsSync, statSync } from 'node:fs';
import { ValidationError } from '@slick/core';
import { paths } from '@slick/core/paths';
import { daemonStatus } from '@slick/server/daemon';
import { resolveWebRoot } from '@slick/server';

import {
  ago,
  json,
  line,
  ndjson,
  note,
  ok,
  renderMessage,
  style,
  table,
  icon,
} from '../output.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const init = {
  name: 'init',
  summary: 'Create the workspace (safe to run twice)',
  usage: `slick init [--name <workspace>] [--user <your name>]`,
  spec: { strings: ['name', 'user'] },
  async run(ctx) {
    const { ws, flags } = ctx;
    if (flags.user) await ws.setUser({ id: slugUser(flags.user), name: flags.user });
    if (flags.name) await ws.setMeta('workspace.name', flags.name);
    const info = await ws.info();
    if (ctx.json) return json(info);
    ok(`Workspace ready at ${style.bold(info.file)}`);
    line();
    note(`  You are ${style.bold(info.user.name)} (@${info.user.id})`);
    note(`  Channels: ${(await ws.channels.list()).map((c) => `#${c.slug}`).join(', ')}`);
    line();
    line('Next:');
    note('  slick send general "hello"        say something');
    note('  slick agent start --agent claude  mint a history key for an AI agent');
    note('  slick app                         open the desktop app');
  },
};

export const status = {
  name: 'status',
  aliases: ['info'],
  summary: 'Workspace summary: channels, activity, agents',
  usage: `slick status`,
  spec: {},
  async run(ctx) {
    const { ws } = ctx;
    const [info, channels, sessions] = await Promise.all([
      ws.info(),
      ws.channels.list(),
      ws.agents.list({}),
    ]);
    if (ctx.json) return json({ ...info, channels, sessions });

    line(`${style.bold(info.name)} ${style.dim(`· ${ctx.mode}`)}`);
    note(`  ${info.file}`);
    line();
    line(
      `  ${style.bold(String(info.counts.channels))} channels   ` +
        `${style.bold(String(info.counts.messages))} messages   ` +
        `${style.bold(String(info.counts.threads))} threads   ` +
        `${style.bold(String(info.counts.agentSessions))} agent sessions`
    );
    line();
    if (channels.length) {
      table(
        channels.map((c) => ({
          channel: `#${c.slug}`,
          messages: String(c.messageCount ?? 0),
          active: c.lastMessageAt ? ago(c.lastMessageAt) : style.dim('—'),
        })),
        [
          { key: 'channel', label: 'channel' },
          { key: 'messages', label: 'msgs', align: 'right' },
          { key: 'active', label: 'last activity' },
        ]
      );
    }
    if (sessions.length) {
      line();
      line(style.dim('agents'));
      for (const session of sessions) {
        line(
          `  ${style.green(session.key)}  ${style.bold(session.agentId)}` +
            `${session.name ? style.cyan(` ${session.name}`) : ''}  ${style.dim(`seen ${ago(session.lastSeenAt)}`)}`
        );
      }
    }
  },
};

export const search = {
  name: 'search',
  aliases: ['find', 's'],
  summary: 'Search messages',
  usage: `slick search <terms…>

  slick search deploy failed          all terms must match
  slick search "exact phrase"
  slick search auth --channel general --limit 5

Options
  --channel <channel>           restrict to one channel
  --author <name>               restrict to one author
  --kind <human|agent|system>   restrict by author kind
  --limit <n>                   how many hits (default 25)`,
  spec: { strings: ['channel', 'author', 'kind', 'limit'] },
  async run(ctx) {
    const query = ctx.argv.join(' ');
    if (!query.trim()) throw new ValidationError('What are you looking for?');
    const result = await ctx.ws.search(query, {
      channel: ctx.flags.channel,
      author: ctx.flags.author,
      kind: ctx.flags.kind,
      limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
    });
    if (ctx.json) return json(result);
    if (result.results.length === 0) return note(`No messages match ${style.bold(query)}.`);
    line(style.dim(`${result.count}${result.hasMore ? '+' : ''} result(s) for ${style.bold(query)}`));
    line();
    for (const message of result.results) {
      line(style.dim(`#${message.channelSlug}`));
      line(renderMessage(message));
      line();
    }
  },
};

export const tail = {
  name: 'tail',
  aliases: ['watch'],
  summary: 'Follow the workspace live',
  usage: `slick tail [--channel <channel>] [--json]

Prints every new message as it lands. Add --json for one JSON object per
line, which is what you want when piping into something else.

Options
  --channel <channel>           only this channel
  --since <seq>                 start from a known point instead of now
  --interval <ms>               poll interval (default 500)
  --all                         include every event type, not just messages`,
  spec: { booleans: ['all'], strings: ['channel', 'since', 'interval'] },
  async run(ctx) {
    const { ws, flags } = ctx;
    const channel = flags.channel ? await ws.channels.get(flags.channel) : null;
    const interval = Math.max(Number(flags.interval ?? 500), 100);
    let cursor = flags.since !== undefined ? Number(flags.since) : await ws.seq();

    const asJson = ctx.json || !process.stdout.isTTY;
    if (!asJson) {
      note(`Tailing ${channel ? `#${channel.slug}` : 'the whole workspace'} from seq ${cursor} — ctrl-c to stop.`);
      line();
    }

    for (;;) {
      const events = await ws.hydratedEvents({
        since: cursor,
        limit: 200,
        channelId: channel?.id ?? null,
      });
      for (const event of events) {
        cursor = Math.max(cursor, event.seq);
        if (!flags.all && !event.message) continue;
        if (asJson) {
          ndjson(event);
        } else if (event.message) {
          const prefix = event.type === 'message.created' ? '' : style.yellow(`(${event.type}) `);
          line(`${style.dim(`#${event.channelSlug}`)} ${prefix}`.trimEnd());
          line(renderMessage(event.message));
          line();
        } else {
          line(`${style.dim('·')} ${style.magenta(event.type)} ${style.dim(`seq ${event.seq}`)}`);
        }
      }
      await sleep(interval);
    }
  },
};

export const doctor = {
  name: 'doctor',
  summary: 'Check that everything is wired up',
  usage: `slick doctor`,
  spec: {},
  async run(ctx) {
    const p = paths(ctx.home);
    const checks = [];
    const add = (label, good, detail) => checks.push({ label, good, detail });

    const major = Number(process.versions.node.split('.')[0]);
    const minor = Number(process.versions.node.split('.')[1]);
    add('node >= 22.5', major > 22 || (major === 22 && minor >= 5), `v${process.versions.node}`);
    add('workspace directory', existsSync(p.root), p.root);
    add(
      'database',
      existsSync(p.db),
      existsSync(p.db) ? `${(statSync(p.db).size / 1024).toFixed(1)} KB` : 'not created yet'
    );

    const web = resolveWebRoot();
    add('web UI files', Boolean(web), web ?? 'not found — the desktop app will not render');

    const daemon = await daemonStatus(ctx.home);
    add(
      'daemon',
      daemon.running,
      daemon.running ? `${daemon.url} (pid ${daemon.pid})` : daemon.stale ? 'stale record' : 'not running'
    );

    let electron = null;
    try {
      electron = (await import('electron')).default;
    } catch {
      /* optional */
    }
    add('electron', Boolean(electron), electron ? 'installed' : 'not installed — `slick app` will use your browser');

    if (ctx.json) return json({ checks, daemon, paths: p });
    for (const check of checks) {
      line(`${check.good ? icon.ok : icon.warn} ${check.label.padEnd(22)} ${style.dim(check.detail)}`);
    }
  },
};

function slugUser(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'you';
}
