import { ValidationError, type ChannelPatch } from '@slick/core';
import { flagOn, flagText } from '../args.ts';
import type { Command } from '../context.ts';
import { workspaceOf } from '../context.ts';
import { ago, channelHeading, json, line, note, ok, style, table } from '../output.ts';

export const channel: Command = {
  name: 'channel',
  aliases: ['channels', 'ch'],
  summary: 'Create, list, rename, archive and delete channels',
  usage: `slick channel <command>

  list                          channels you can post in
  create <name> [options]       make a channel
  show <channel>                topic, purpose and activity
  update <channel> [options]    change name, topic, purpose, slug or category
  archive <channel>             hide it without losing anything
  unarchive <channel>           bring it back
  delete <channel> [--force]    remove it permanently

Options
  --all                         include archived channels in the listing
  --name <text>                 display name
  --topic <text>                one-line topic
  --purpose <text>              what the channel is for
  --rename <slug>               change the #handle
  --category <category>         put it in a sidebar category ("none" to take it out)
  --force                       allow deleting a channel that still has messages

Sidebar sections live in \`slick category\`.`,
  spec: {
    booleans: ['all', 'force'],
    strings: ['name', 'topic', 'purpose', 'rename', 'category'],
  },

  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.argv;
    const ws = workspaceOf(ctx);
    const { flags } = ctx;

    switch (sub) {
      case 'list':
      case 'ls': {
        const channels = await ws.channels.list({ includeArchived: flagOn(flags, 'all') });
        if (ctx.json) return json({ channels });
        if (channels.length === 0) return note('No channels yet. Create one: slick channel create general');
        table(
          channels.map((c) => ({
            channel: `${c.archived ? style.dim('#') : style.bold('#')}${c.archived ? style.dim(c.slug) : c.slug}`,
            category: c.category ? style.dim(c.category.name) : style.dim('—'),
            messages: String(c.messageCount ?? 0),
            active: c.lastMessageAt ? ago(c.lastMessageAt) : style.dim('—'),
            topic: c.archived ? style.yellow('archived') : style.dim(c.topic || ''),
          })),
          [
            { key: 'channel', label: 'channel' },
            { key: 'category', label: 'category' },
            { key: 'messages', label: 'msgs', align: 'right' },
            { key: 'active', label: 'last activity' },
            { key: 'topic', label: 'topic' },
          ]
        );
        return;
      }

      case 'create':
      case 'new':
      case 'add': {
        const name = rest[0] ?? flagText(flags, 'name');
        if (!name) throw new ValidationError('Give the channel a name: slick channel create <name>');
        const category = flagText(flags, 'category');
        const created = await ws.channels.create({
          slug: name,
          name: flagText(flags, 'name'),
          topic: flagText(flags, 'topic'),
          purpose: flagText(flags, 'purpose'),
          category: category === undefined || isClear(category) ? null : category,
        });
        if (ctx.json) return json({ channel: created });
        ok(
          `Created ${style.bold(`#${created.slug}`)}` +
            (created.category ? ` in ${style.bold(created.category.name)}` : '')
        );
        note(`  ${created.id}`);
        return;
      }

      case 'show':
      case 'info': {
        const ref = requireRef(rest[0], 'channel');
        const found = await ws.channels.get(ref);
        if (ctx.json) return json({ channel: found });
        line(channelHeading(found));
        line();
        const rows: [string, string][] = [
          ['id', found.id],
          ['name', found.name],
          ['category', found.category ? found.category.name : style.dim('—')],
          ['purpose', found.purpose || style.dim('—')],
          ['created', `${new Date(found.createdAt).toLocaleString()} by ${found.createdBy}`],
          ['messages', String(found.messageCount ?? 0)],
          ['last activity', found.lastMessageAt ? ago(found.lastMessageAt) : style.dim('never')],
        ];
        if (found.archived) rows.push(['archived', ago(found.archivedAt)]);
        for (const [key, value] of rows) line(`  ${style.dim(key.padEnd(14))}${value}`);
        return;
      }

      case 'update':
      case 'edit': {
        const ref = requireRef(rest[0], 'channel');
        const patch: ChannelPatch = {};
        const name = flagText(flags, 'name');
        const topic = flagText(flags, 'topic');
        const purpose = flagText(flags, 'purpose');
        const rename = flagText(flags, 'rename');
        const category = flagText(flags, 'category');
        if (name !== undefined) patch.name = name;
        if (topic !== undefined) patch.topic = topic;
        if (purpose !== undefined) patch.purpose = purpose;
        if (rename !== undefined) patch.slug = rename;
        if (category !== undefined) patch.category = isClear(category) ? null : category;
        if (Object.keys(patch).length === 0) {
          throw new ValidationError('Nothing to change.', {
            hint: 'Pass --name, --topic, --purpose, --rename or --category.',
          });
        }
        const updated = await ws.channels.update(ref, patch);
        if (ctx.json) return json({ channel: updated });
        ok(`Updated ${style.bold(`#${updated.slug}`)}`);
        return;
      }

      case 'archive': {
        const updated = await ws.channels.archive(requireRef(rest[0], 'channel'));
        if (ctx.json) return json({ channel: updated });
        ok(`Archived #${updated.slug} — nothing was deleted.`);
        return;
      }

      case 'unarchive':
      case 'restore': {
        const updated = await ws.channels.unarchive(requireRef(rest[0], 'channel'));
        if (ctx.json) return json({ channel: updated });
        ok(`#${updated.slug} is back.`);
        return;
      }

      case 'delete':
      case 'rm': {
        const removed = await ws.channels.remove(requireRef(rest[0], 'channel'), {
          force: flagOn(flags, 'force'),
        });
        if (ctx.json) return json({ channel: removed });
        ok(
          `Deleted #${removed.slug}` +
            (removed.deletedMessages ? ` and ${removed.deletedMessages} message(s).` : '.')
        );
        return;
      }

      default:
        throw new ValidationError(`Unknown channel command "${sub}".`, {
          hint: 'Try: list, create, show, update, archive, unarchive, delete',
        });
    }
  },
};

export function requireRef(value: string | undefined, what: string): string {
  if (!value) throw new ValidationError(`Which ${what}?`, { hint: `Pass a ${what} as the next argument.` });
  return value;
}

/**
 * Wherever a category can be named, these all mean "no category" — so both
 * `--category none` here and `slick category move #deploys none` clear it.
 */
const CLEARED = new Set(['none', '-', 'clear', 'null', 'uncategorised', 'uncategorized']);

export const isClear = (value: unknown): boolean =>
  value === undefined || CLEARED.has(String(value).trim().toLowerCase());
