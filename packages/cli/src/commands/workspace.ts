import { existsSync, statSync } from 'node:fs';
import { ValidationError } from '@slick/core';
import { paths } from '@slick/core/paths';
import { daemonStatus } from '@slick/server/daemon';
import { resolveWebRoot } from '@slick/server';

import { flagNumber, flagOn, flagText } from '../args.ts';
import type { Command } from '../context.ts';
import { workspaceOf } from '../context.ts';
import { ago, json, line, ndjson, note, ok, renderMessage, style, table, icon } from '../output.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const init: Command = {
  name: 'init',
  summary: 'Create the workspace (safe to run twice)',
  usage: `slick init [--name <workspace>] [--user <your name>]`,
  spec: { strings: ['name', 'user'] },
  async run(ctx) {
    const ws = workspaceOf(ctx);
    const user = flagText(ctx.flags, 'user');
    const name = flagText(ctx.flags, 'name');
    if (user) await ws.setUser({ id: slugUser(user), name: user });
    if (name) await ws.setMeta('workspace.name', name);
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

export const status: Command = {
  name: 'status',
  aliases: ['info'],
  summary: 'Workspace summary: channels, activity, agents',
  usage: `slick status`,
  spec: {},
  async run(ctx) {
    const ws = workspaceOf(ctx);
    const [info, channels, sessions] = await Promise.all([ws.info(), ws.channels.list(), ws.agents.list({})]);
    if (ctx.json) return json({ ...info, channels, sessions });

    line(`${style.bold(info.name)} ${style.dim(`· ${ctx.mode}`)}`);
    note(`  ${info.file}`);
    line();
    line(
      `  ${style.bold(String(info.counts.channels))} channels   ` +
        // Only worth a column once the workspace actually uses categories.
        (info.counts.categories ? `${style.bold(String(info.counts.categories))} categories   ` : '') +
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

export const search: Command = {
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
    const result = await workspaceOf(ctx).search(query, {
      channel: flagText(ctx.flags, 'channel'),
      author: flagText(ctx.flags, 'author'),
      kind: flagText(ctx.flags, 'kind'),
      limit: flagNumber(ctx.flags, 'limit'),
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

export const tail: Command = {
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
    const ws = workspaceOf(ctx);
    const { flags } = ctx;
    const channelRef = flagText(flags, 'channel');
    const channel = channelRef ? await ws.channels.get(channelRef) : null;
    const interval = Math.max(flagNumber(flags, 'interval') ?? 500, 100);
    const since = flagNumber(flags, 'since');
    let cursor = since !== undefined ? since : await ws.seq();

    const asJson = ctx.json || !process.stdout.isTTY;
    if (!asJson) {
      note(
        `Tailing ${channel ? `#${channel.slug}` : 'the whole workspace'} from seq ${cursor} — ctrl-c to stop.`
      );
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
        if (!flagOn(flags, 'all') && !event.message) continue;
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

export const doctor: Command = {
  name: 'doctor',
  summary: 'Check that everything is wired up',
  usage: `slick doctor`,
  spec: {},
  async run(ctx) {
    const p = paths(ctx.home);
    const checks: { label: string; good: boolean; detail: string }[] = [];
    const add = (label: string, good: boolean, detail: string) => checks.push({ label, good, detail });

    const [majorText = '0', minorText = '0'] = process.versions.node.split('.');
    const major = Number(majorText);
    const minor = Number(minorText);
    // 22.18 is where Node started stripping types without a flag, which is
    // what runs every package in this repo.
    add('node >= 22.18', major > 22 || (major === 22 && minor >= 18), `v${process.versions.node}`);
    add('workspace directory', existsSync(p.root), p.root);
    add(
      'database',
      existsSync(p.db),
      existsSync(p.db) ? `${(statSync(p.db).size / 1024).toFixed(1)} KB` : 'not created yet'
    );

    const web = resolveWebRoot();
    add('web UI files', Boolean(web), web ?? 'not found — run `npm run build`, or the app will not render');

    const daemon = await daemonStatus(ctx.home);
    add(
      'daemon',
      daemon.running,
      daemon.running ? `${daemon.url} (pid ${daemon.pid})` : daemon.stale ? 'stale record' : 'not running'
    );

    let electron: string | null = null;
    try {
      // Outside Electron the package resolves to the path of its binary.
      const mod = (await import('electron')) as unknown as { default?: unknown };
      electron = typeof mod.default === 'string' ? mod.default : null;
    } catch {
      /* optional */
    }
    add(
      'electron',
      Boolean(electron),
      electron ? 'installed' : 'not installed — `slick app` will use your browser'
    );

    if (ctx.json) return json({ checks, daemon, paths: p });
    for (const check of checks) {
      line(`${check.good ? icon.ok : icon.warn} ${check.label.padEnd(22)} ${style.dim(check.detail)}`);
    }
  },
};

function slugUser(name: string): string {
  return (
    String(name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'you'
  );
}
