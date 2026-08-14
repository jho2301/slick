import { ValidationError } from '@slick/core';
import { ago, json, line, note, ok, pad, style } from '../output.js';
import { isClear, requireRef } from './channel.js';

export const category = {
  name: 'category',
  aliases: ['categories', 'cat'],
  summary: 'Group channels into sidebar sections',
  usage: `slick category <command>

  list                          categories and the channels in them
  create <name>                 make a category
  show <category>               one category and its channels
  update <category> [options]   rename it or change its handle
  move <channel> [category]     put a channel in a category (omit to take it out)
  reorder <category…>           set the sidebar order, first to last
  collapse <category>           fold it up in the sidebar
  expand <category>             unfold it
  delete <category>             remove it; its channels become uncategorised

Options
  --name <text>                 display name
  --rename <slug>               change the handle
  --all                         include archived channels in the listing

A channel belongs to at most one category. Channels in none of them live under
"Channels" at the bottom of the sidebar.`,
  spec: {
    booleans: ['all'],
    strings: ['name', 'rename'],
  },

  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.argv;
    const { ws, flags } = ctx;

    switch (sub) {
      case 'list':
      case 'ls': {
        const [categories, channels] = await Promise.all([
          ws.categories.list(),
          ws.channels.list({ includeArchived: Boolean(flags.all) }),
        ]);
        if (ctx.json) return json({ categories, channels });
        if (categories.length === 0) {
          return note('No categories yet. Create one: slick category create Engineering');
        }
        for (const item of categories) {
          const inside = channels.filter((c) => c.categoryId === item.id);
          line(heading(item, inside.length));
          if (inside.length === 0) note('    (empty)');
          else for (const c of inside) line(`    ${channelLine(c)}`);
          line();
        }
        const loose = channels.filter((c) => !c.categoryId);
        if (loose.length) {
          line(`${style.bold('Channels')} ${style.dim(`· ${loose.length} uncategorised`)}`);
          for (const c of loose) line(`    ${channelLine(c)}`);
        }
        return;
      }

      case 'create':
      case 'new':
      case 'add': {
        const name = rest.join(' ').trim() || flags.name;
        if (!name) throw new ValidationError('Give the category a name: slick category create <name>');
        const created = await ws.categories.create({ name, slug: flags.rename });
        if (ctx.json) return json({ category: created });
        ok(`Created ${style.bold(created.name)} ${style.dim(`(${created.slug})`)}`);
        note(`  Put a channel in it: slick category move <channel> ${created.slug}`);
        return;
      }

      case 'show':
      case 'info': {
        const found = await ws.categories.get(requireRef(rest[0], 'category'));
        const channels = await ws.channels.list({ includeArchived: Boolean(flags.all) });
        const inside = channels.filter((c) => c.categoryId === found.id);
        if (ctx.json) return json({ category: found, channels: inside });
        line(heading(found, inside.length));
        line();
        for (const [key, value] of [
          ['id', found.id],
          ['handle', found.slug],
          ['position', String(found.position)],
          ['collapsed', found.collapsed ? 'yes' : 'no'],
          ['created', `${new Date(found.createdAt).toLocaleString()} by ${found.createdBy}`],
        ]) {
          line(`  ${style.dim(key.padEnd(11))}${value}`);
        }
        line();
        if (inside.length === 0) note('  No channels in it yet.');
        else for (const c of inside) line(`  ${channelLine(c)}`);
        return;
      }

      case 'update':
      case 'edit':
      case 'rename': {
        const ref = requireRef(rest[0], 'category');
        const patch = {};
        // `slick category rename design Design System` reads better than a flag.
        const words = rest.slice(1).join(' ').trim();
        if (words) patch.name = words;
        if (flags.name !== undefined) patch.name = flags.name;
        if (flags.rename !== undefined) patch.slug = flags.rename;
        if (Object.keys(patch).length === 0) {
          throw new ValidationError('Nothing to change.', { hint: 'Pass --name or --rename.' });
        }
        const updated = await ws.categories.update(ref, patch);
        if (ctx.json) return json({ category: updated });
        ok(`Updated ${style.bold(updated.name)} ${style.dim(`(${updated.slug})`)}`);
        return;
      }

      case 'move':
      case 'set': {
        const channelRef = requireRef(rest[0], 'channel');
        const target = rest[1] ?? flags.name;
        const updated = await ws.channels.update(channelRef, {
          category: isClear(target) ? null : target,
        });
        if (ctx.json) return json({ channel: updated });
        ok(
          updated.category
            ? `Moved ${style.bold(`#${updated.slug}`)} into ${style.bold(updated.category.name)}`
            : `Took ${style.bold(`#${updated.slug}`)} out of its category`
        );
        return;
      }

      case 'reorder': {
        if (rest.length === 0) {
          throw new ValidationError('Name the categories in the order you want them.', {
            hint: 'For example: slick category reorder engineering design',
          });
        }
        const categories = await ws.categories.reorder(rest);
        if (ctx.json) return json({ categories });
        ok(`Order: ${categories.map((c) => style.bold(c.name)).join(style.dim(' → '))}`);
        return;
      }

      case 'collapse':
      case 'expand': {
        const ref = requireRef(rest[0], 'category');
        const updated = await ws.categories.update(ref, { collapsed: sub === 'collapse' });
        if (ctx.json) return json({ category: updated });
        ok(`${style.bold(updated.name)} is ${updated.collapsed ? 'collapsed' : 'expanded'}.`);
        return;
      }

      case 'delete':
      case 'rm': {
        const removed = await ws.categories.remove(requireRef(rest[0], 'category'));
        if (ctx.json) return json({ category: removed });
        ok(
          `Deleted ${style.bold(removed.name)}.` +
            (removed.uncategorisedChannels
              ? ` ${removed.uncategorisedChannels} channel(s) are now uncategorised — nothing was lost.`
              : '')
        );
        return;
      }

      default:
        throw new ValidationError(`Unknown category command "${sub}".`, {
          hint: 'Try: list, create, show, update, move, reorder, collapse, expand, delete',
        });
    }
  },
};

function heading(item, count) {
  return (
    `${style.bold(item.name)} ${style.dim(`(${item.slug})`)} ` +
    style.dim(`· ${count} channel${count === 1 ? '' : 's'}${item.collapsed ? ' · collapsed' : ''}`)
  );
}

function channelLine(channel) {
  const name = channel.archived ? style.dim(`#${channel.slug}`) : `#${channel.slug}`;
  const meta = [
    `${channel.messageCount ?? 0} msg`,
    channel.lastMessageAt ? ago(channel.lastMessageAt) : 'quiet',
    channel.archived ? style.yellow('archived') : null,
  ].filter(Boolean);
  return `${pad(name, 24)} ${style.dim(meta.join(' · '))}`;
}
