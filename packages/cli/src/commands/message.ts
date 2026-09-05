import { ValidationError, isRecord, type Author, type MessageMetadata } from '@slick/core';
import { flagNumber, flagOn, flagText, parseJsonFlag, resolveText } from '../args.ts';
import type { Command, CommandContext } from '../context.ts';
import { workspaceOf } from '../context.ts';
import { channelHeading, json, line, note, ok, renderMessage, renderTranscript, style } from '../output.ts';
import { requireRef } from './channel.ts';

/** `--meta` as the message service takes it: an object, or nothing. */
function metadataFlag(ctx: CommandContext): MessageMetadata | null | undefined {
  const parsed = parseJsonFlag(ctx.flags.meta, 'meta');
  if (parsed === undefined) return undefined;
  if (parsed === null) return null;
  if (!isRecord(parsed)) throw new ValidationError('--meta must be a JSON object.');
  return parsed;
}

/**
 * `slick send general hi` names a channel; `slick send --thread msg_x hi`
 * does not, because the thread already knows which channel it lives in. Both
 * spellings are common, so the leading positional is treated as a channel
 * only when it actually resolves to one and text remains after it.
 */
async function splitChannelAndWords(
  ctx: CommandContext,
  rest: string[]
): Promise<{ channel: string | undefined; words: string[] }> {
  if (!ctx.flags.thread) {
    return { channel: requireRef(rest[0], 'channel'), words: rest.slice(1) };
  }
  if (rest.length > 1 && (await workspaceOf(ctx).channels.find(rest[0]))) {
    return { channel: undefined, words: rest.slice(1) };
  }
  return { channel: undefined, words: rest };
}

/** Shared by `slick message post`, `slick send` and `slick thread reply`. */
async function postMessage(
  ctx: CommandContext,
  { channel, parentId, words }: { channel?: string; parentId?: string; words: string[] }
) {
  const text = await resolveText(words);
  const as = flagText(ctx.flags, 'as');
  const author: Author | undefined = as
    ? { id: as.replace(/^@/, ''), kind: flagOn(ctx.flags, 'bot') ? 'agent' : 'human', label: as }
    : undefined;
  return workspaceOf(ctx).messages.post({
    channel,
    parentId: parentId ?? null,
    text,
    author,
    metadata: metadataFlag(ctx) ?? null,
  });
}

export const message: Command = {
  name: 'message',
  aliases: ['msg', 'm'],
  summary: 'Post, read, edit and delete messages',
  usage: `slick message <command>

  post <channel> <text…>        say something  (alias: slick send)
  list <channel>                read a channel  (alias: slick read)
  show <message-id>             one message, with its thread summary
  edit <message-id> <text…>     rewrite a message
  delete <message-id>           remove a message

Options
  --thread <message-id>         post into an existing thread
  --meta <json>                 attach structured data to the message
  --as <name>                   post under a different name
  --bot                         mark --as author as an agent
  --limit <n>                   how many messages to list (default 30)
  --before <id|seq>             page backwards from here
  --after <id|seq>              page forwards from here
  --replies                     include thread replies in the listing
  --deleted                     include deleted messages
  --hard                        delete permanently instead of leaving a tombstone`,
  spec: {
    booleans: ['replies', 'deleted', 'hard', 'bot', 'ids'],
    strings: ['thread', 'meta', 'limit', 'before', 'after'],
  },

  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.argv;
    const ws = workspaceOf(ctx);

    switch (sub) {
      case 'post':
      case 'send': {
        const { channel, words } = await splitChannelAndWords(ctx, rest);
        const created = await postMessage(ctx, {
          channel,
          parentId: flagText(ctx.flags, 'thread'),
          words,
        });
        if (ctx.json) return json({ message: created });
        ok(
          `Posted to ${style.bold(`#${created.channelSlug}`)}` +
            (created.parentId ? style.dim(` (thread ${created.parentId})`) : '')
        );
        note(`  ${created.id}`);
        return;
      }

      case 'list':
      case 'read': {
        const result = await ws.messages.list(requireRef(rest[0], 'channel'), {
          limit: flagNumber(ctx.flags, 'limit') ?? 30,
          before: flagText(ctx.flags, 'before'),
          after: flagText(ctx.flags, 'after'),
          includeReplies: flagOn(ctx.flags, 'replies'),
          includeDeleted: flagOn(ctx.flags, 'deleted'),
        });
        if (ctx.json) return json(result);
        line(channelHeading(result.channel));
        line();
        if (result.messages.length === 0) {
          note('  Nothing here yet.');
          return;
        }
        if (result.hasMore) {
          note(`  … older messages exist — slick read ${result.channel.slug} --before ${result.oldestSeq}`);
          line();
        }
        line(renderTranscript(result.messages, { showId: ctx.flags.ids !== false }));
        return;
      }

      case 'show': {
        const found = await ws.messages.get(requireRef(rest[0], 'message id'));
        if (ctx.json) return json({ message: found });
        line(style.dim(`#${found.channelSlug}`));
        line();
        line(renderMessage(found));
        if (found.replyCount > 0) {
          line();
          note(
            `  ${found.replyCount} repl${found.replyCount === 1 ? 'y' : 'ies'} — slick thread show ${found.id}`
          );
        }
        return;
      }

      case 'edit': {
        const id = requireRef(rest[0], 'message id');
        const updated = await ws.messages.update(id, {
          text: await resolveText(rest.slice(1)),
          metadata: metadataFlag(ctx),
        });
        if (ctx.json) return json({ message: updated });
        ok('Edited.');
        line(renderMessage(updated));
        return;
      }

      case 'delete':
      case 'rm': {
        const removed = await ws.messages.remove(requireRef(rest[0], 'message id'), {
          hard: flagOn(ctx.flags, 'hard'),
        });
        if (ctx.json) return json({ message: removed });
        ok(
          flagOn(ctx.flags, 'hard')
            ? `Deleted ${removed.id} permanently` +
                (removed.deletedReplies
                  ? ` along with ${removed.deletedReplies} repl${removed.deletedReplies === 1 ? 'y' : 'ies'}.`
                  : '.')
            : `Deleted ${removed.id}.`
        );
        return;
      }

      default:
        throw new ValidationError(`Unknown message command "${sub}".`, {
          hint: 'Try: post, list, show, edit, delete',
        });
    }
  },
};

/** `slick send <channel> <text…>` — the command you actually type. */
export const send: Command = {
  name: 'send',
  summary: 'Post a message to a channel',
  usage: `slick send <channel> <text…>

  slick send general Deploy finished
  slick send general --thread msg_01k… Following up
  git log -1 | slick send general -

Options
  --thread <message-id>         reply inside a thread instead
  --meta <json>                 attach structured data
  --as <name> [--bot]           post under a different name`,
  spec: message.spec,
  async run(ctx) {
    return message.run({ ...ctx, argv: ['post', ...ctx.argv] });
  },
};

/** `slick read <channel>` */
export const read: Command = {
  name: 'read',
  summary: 'Read the latest messages in a channel',
  usage: `slick read <channel> [--limit n] [--before seq] [--replies]`,
  spec: message.spec,
  async run(ctx) {
    return message.run({ ...ctx, argv: ['list', ...ctx.argv] });
  },
};

export const thread: Command = {
  name: 'thread',
  aliases: ['t'],
  summary: 'Open a thread or reply to one',
  usage: `slick thread <command>

  show <message-id>             the root message and every reply
  reply <message-id> <text…>    add a reply

Options
  --meta <json>                 attach structured data to the reply
  --as <name> [--bot]           reply under a different name`,
  spec: {
    booleans: ['deleted', 'bot'],
    strings: ['meta'],
  },

  async run(ctx) {
    const [sub = 'show', ...rest] = ctx.argv;
    const ws = workspaceOf(ctx);

    switch (sub) {
      case 'show':
      case 'open': {
        const result = await ws.messages.thread(requireRef(rest[0], 'message id'));
        if (ctx.json) return json(result);
        line(style.dim(`#${result.channel.slug} · thread`));
        line();
        line(renderMessage(result.root));
        line();
        if (result.replies.length === 0) {
          note('  No replies yet.');
          return;
        }
        for (const replyMessage of result.replies) {
          line(renderMessage(replyMessage, { indent: '  ' }));
          line();
        }
        return;
      }

      case 'reply': {
        const created = await postMessage(ctx, {
          parentId: requireRef(rest[0], 'message id'),
          words: rest.slice(1),
        });
        if (ctx.json) return json({ message: created });
        ok(`Replied in thread ${style.dim(created.threadId)}`);
        note(`  ${created.id}`);
        return;
      }

      default:
        throw new ValidationError(`Unknown thread command "${sub}".`, { hint: 'Try: show, reply' });
    }
  },
};
