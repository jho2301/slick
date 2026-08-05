import { ValidationError } from '@slick/core';
import { ago, channelHeading, json, line, note, ok, style, table } from '../output.js';

export const channel = {
  name: 'channel',
  aliases: ['channels', 'ch'],
  summary: 'Create, list, rename, archive and delete channels',
  usage: `slick channel <command>

  list                          channels you can post in
  create <name> [options]       make a channel
  show <channel>                topic, purpose and activity
  update <channel> [options]    change name, topic, purpose or slug
  archive <channel>             hide it without losing anything
  unarchive <channel>           bring it back
  delete <channel> [--force]    remove it permanently

Options
  --all                         include archived channels in the listing
  --name <text>                 display name
  --topic <text>                one-line topic
  --purpose <text>              what the channel is for
  --rename <slug>               change the #handle
  --force                       allow deleting a channel that still has messages`,
  spec: {
    booleans: ['all', 'force'],
    strings: ['name', 'topic', 'purpose', 'rename'],
  },

  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.argv;
    const { ws, flags } = ctx;

    switch (sub) {
      case 'list':
      case 'ls': {
        const channels = await ws.channels.list({ includeArchived: Boolean(flags.all) });
        if (ctx.json) return json({ channels });
        if (channels.length === 0) return note('No channels yet. Create one: slick channel create general');
        table(
          channels.map((c) => ({
            channel: `${c.archived ? style.dim('#') : style.bold('#')}${c.archived ? style.dim(c.slug) : c.slug}`,
            messages: String(c.messageCount ?? 0),
            active: c.lastMessageAt ? ago(c.lastMessageAt) : style.dim('—'),
            topic: c.archived ? style.yellow('archived') : style.dim(c.topic || ''),
          })),
          [
            { key: 'channel', label: 'channel' },
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
        const name = rest[0] ?? flags.name;
        if (!name) throw new ValidationError('Give the channel a name: slick channel create <name>');
        const created = await ws.channels.create({
          slug: name,
          name: flags.name,
          topic: flags.topic,
          purpose: flags.purpose,
        });
        if (ctx.json) return json({ channel: created });
        ok(`Created ${style.bold(`#${created.slug}`)}`);
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
        const rows = [
          ['id', found.id],
          ['name', found.name],
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
        const patch = {};
        if (flags.name !== undefined) patch.name = flags.name;
        if (flags.topic !== undefined) patch.topic = flags.topic;
        if (flags.purpose !== undefined) patch.purpose = flags.purpose;
        if (flags.rename !== undefined) patch.slug = flags.rename;
        if (Object.keys(patch).length === 0) {
          throw new ValidationError('Nothing to change.', {
            hint: 'Pass --name, --topic, --purpose or --rename.',
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
          force: Boolean(flags.force),
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

export function requireRef(value, what) {
  if (!value) throw new ValidationError(`Which ${what}?`, { hint: `Pass a ${what} as the next argument.` });
  return value;
}
