/**
 * Messages and threads.
 *
 * A thread is just a message whose `parent_id` points at the root message it
 * replies to — one table, two levels, exactly like Slack. Replying to a reply
 * re-targets the thread root rather than nesting, so threads never go deeper
 * than one level and the UI stays predictable.
 */

import type { DatabaseSync } from 'node:sqlite';

import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId, ID_PREFIX } from './ids.ts';
import { row, rows, transact, type SQLInputValue } from './db.ts';
import { EVENT_TYPES, recordEvent } from './events.ts';
import { THINK_KEY, normalizeThinking } from './thinking.ts';
import type { ChannelService } from './channels.ts';
import type { Author, AuthorKind, Channel, Message, MessageMetadata } from './types.ts';

export const MAX_TEXT_LENGTH = 40_000;
const MENTION_RE = /(?:^|[\s(<[])@([a-z0-9][a-z0-9._-]{0,63})/gi;

/** `@claude fix this` -> ['claude'] */
export function extractMentions(text: unknown): string[] {
  const found = new Set<string>();
  for (const match of String(text ?? '').matchAll(MENTION_RE)) {
    found.add((match[1] ?? '').toLowerCase().replace(/[.]+$/, ''));
  }
  return [...found];
}

/** A fenced code block opener or closer — ``` or ~~~, indented up to three spaces. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** The smallest useful piece — below this, splitting stops making progress. */
const MIN_CHUNK = 200;

/**
 * Break text into pieces that each fit inside one message.
 *
 * A long answer used to be a lost answer: `serve` posts what the agent said,
 * the post is refused for length, and the watcher retries the whole call —
 * three model runs, three refusals, nothing to show for it. Long answers are
 * ordinary, so they are split rather than refused. `post` itself stays strict:
 * a human or an agent calling it directly should hear that the message is too
 * long, not silently have it cut into four.
 *
 * Breaks fall between lines, and a fenced code block that a break lands inside
 * is closed before it and reopened after it, so no piece renders as half a
 * fence. A single line too long for any piece is cut where it falls — better
 * than losing it.
 *
 * @param limit characters per piece; Slick's own cap by default
 * @returns at least one piece, each one postable
 */
export function splitMessageText(text: unknown, limit: number | null = MAX_TEXT_LENGTH): string[] {
  const value = String(text ?? '');
  const cap = Math.min(Math.max(Math.trunc(Number(limit)) || MAX_TEXT_LENGTH, MIN_CHUNK), MAX_TEXT_LENGTH);
  if (value.length <= cap) return [value];

  const closerFor = (fence: string): string => FENCE_RE.exec(fence.trim())?.[1] ?? '';
  /** What a piece must keep back for a fence it will have to close off. */
  const reserve = (fence: string | null): number => (fence ? closerFor(fence).length + 1 : 0);

  const pieces: string[] = [];
  /** The fence line the buffer is inside, as the buffer stands. */
  let open: string | null = null;
  /** What the last break seeded the buffer with, so a lone fence never ships. */
  let carried: string | null = null;
  let buf = '';

  const emit = (fence: string | null) => {
    // Blank lines can pile up into a piece with nothing in it, and a message
    // with nothing in it is refused. Inside a fence the buffer always holds
    // the fence line, so this only ever drops empty space.
    if (buf.trim().length > 0) pieces.push(fence ? `${buf}\n${closerFor(fence)}` : buf);
    carried = fence;
    buf = fence ?? '';
  };

  for (const line of value.split('\n')) {
    // Appending this line can itself open or close a fence, and a break can
    // happen either side of it, so the room kept back is whichever of the two
    // states needs more. Getting this wrong is how a piece ends up over the
    // cap: the closer is appended by `emit`, long after the fit was decided.
    const after: string | null = FENCE_RE.test(line) ? (open ? null : line) : open;
    const keep = Math.max(reserve(open), reserve(after));

    let rest = line;
    for (;;) {
      const free = cap - keep - buf.length - (buf.length ? 1 : 0);
      if (rest.length <= free) {
        buf = buf.length ? `${buf}\n${rest}` : rest;
        break;
      }
      if (buf.length && buf !== carried) {
        // Something worth shipping is here; the line tries again next piece.
        emit(open);
        continue;
      }
      // The piece is empty, or holds nothing but a reopened fence, and the
      // line still does not fit. Cut it where it falls — at least one
      // character, so this always makes progress.
      const cut = Math.max(free, 1);
      buf = buf.length ? `${buf}\n${rest.slice(0, cut)}` : rest.slice(0, cut);
      emit(open);
      rest = rest.slice(cut);
    }
    open = after;
  }
  if (buf.length && buf !== carried) emit(open);
  // Only reachable for text that is nothing but blank lines, which has no
  // pieces to make. Hand it back whole and let the message rules refuse it.
  return pieces.length > 0 ? pieces : [value.slice(0, cap)];
}

/**
 * The one metadata key with a schema.
 *
 * Metadata is otherwise the author's business — whatever JSON was handed in is
 * stringified as-is, and that stays true here: an object with no `_think` in
 * it comes back out as the very same object, so every existing caller writes
 * exactly the bytes it wrote yesterday. `_think` is the exception because it
 * is machine-written, unbounded, and re-sent with the message forever; see
 * `thinking.ts` for why the caps live there and why they clamp instead of
 * throwing. A blob that normalizes to nothing takes the key with it rather
 * than leaving a `null` behind for every reader to test for.
 */
function normalizeMetadata<T extends MessageMetadata | null | undefined>(metadata: T): T {
  if (metadata == null || typeof metadata !== 'object') return metadata;
  if (!Object.prototype.hasOwnProperty.call(metadata, THINK_KEY)) return metadata;
  const think = normalizeThinking(metadata[THINK_KEY]);
  const out: MessageMetadata = { ...metadata };
  if (think) out[THINK_KEY] = think;
  else delete out[THINK_KEY];
  return out as T;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export interface MessageRow {
  id: string;
  channel_id: string;
  channel_slug?: string | null;
  parent_id: string | null;
  author_id: string;
  author_kind: string;
  author_label: string | null;
  text: string;
  mentions: string | null;
  metadata: string | null;
  session_key: string | null;
  seq: number;
  reply_count: number;
  last_reply_at: number | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export function serializeMessageRow(m: MessageRow): Message {
  const deleted = m.deleted_at != null;
  return {
    id: m.id,
    channelId: m.channel_id,
    channelSlug: m.channel_slug ?? undefined,
    parentId: m.parent_id,
    threadId: m.parent_id ?? m.id,
    isThreadRoot: m.parent_id == null,
    author: {
      id: m.author_id,
      kind: m.author_kind as AuthorKind,
      label: m.author_label ?? m.author_id,
    },
    text: m.text,
    mentions: parseJson<string[]>(m.mentions, []),
    metadata: parseJson<MessageMetadata | null>(m.metadata, null),
    sessionKey: m.session_key,
    seq: Number(m.seq),
    replyCount: Number(m.reply_count),
    lastReplyAt: m.last_reply_at == null ? null : Number(m.last_reply_at),
    createdAt: Number(m.created_at),
    updatedAt: Number(m.updated_at),
    editedAt: m.edited_at == null ? null : Number(m.edited_at),
    deleted,
    deletedAt: deleted ? Number(m.deleted_at) : null,
  };
}

export function serializeMessage(record: unknown): Message | null {
  const m = row<MessageRow>(record);
  return m ? serializeMessageRow(m) : null;
}

export interface PostMessageInput {
  channel?: string | null;
  channelId?: string | null;
  text: string;
  parentId?: string | null;
  threadId?: string | null;
  author?: Partial<Author> | null;
  metadata?: MessageMetadata | null;
  sessionKey?: string | null;
}

export interface MessageListOptions {
  limit?: number;
  before?: string | number | null;
  after?: string | number | null;
  includeDeleted?: boolean;
  includeReplies?: boolean;
}

export interface MessagePage {
  channel: Channel;
  messages: Message[];
  hasMore: boolean;
  oldestSeq: number | null;
  newestSeq: number | null;
}

export interface Thread {
  root: Message;
  replies: Message[];
  replyCount: number;
  channel: Channel;
}

export interface MessagePatch {
  text?: string;
  metadata?: MessageMetadata | null;
  author?: Author;
  sessionKey?: string | null;
}

export interface RemoveMessageOptions {
  hard?: boolean;
  author?: Author;
  sessionKey?: string | null;
}

export interface MessageServiceContext {
  db: DatabaseSync;
  actor: Author;
  channels: ChannelService;
}

export function createMessageService(ctx: MessageServiceContext) {
  const { db, channels, actor: defaultActor } = ctx;

  const SELECT_MESSAGE = `SELECT m.*, c.slug AS channel_slug FROM messages m
                            JOIN channels c ON c.id = m.channel_id`;

  function find(id: string | null | undefined): Message | null {
    if (!id) return null;
    const r = db.prepare(`${SELECT_MESSAGE} WHERE m.id = ?`).get(String(id).trim());
    return r ? serializeMessage(r) : null;
  }

  function get(
    id: string | null | undefined,
    { includeDeleted = true }: { includeDeleted?: boolean } = {}
  ): Message {
    const found = find(id);
    if (!found || (!includeDeleted && found.deleted)) {
      throw new NotFoundError(`No message with id "${id}".`, {
        hint: 'Message ids look like msg_01k…; `slick message list <channel>` prints them.',
        details: { id },
      });
    }
    return found;
  }

  function assertText(text: unknown): string {
    const value = String(text ?? '');
    if (value.trim().length === 0) {
      throw new ValidationError('Message text is empty.', { hint: 'Pass some text to send.' });
    }
    if (value.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(`Message is ${value.length} characters; the limit is ${MAX_TEXT_LENGTH}.`);
    }
    return value;
  }

  /** Recompute a root's reply stats from the replies themselves — always correct. */
  function refreshThreadStats(rootId: string | null | undefined): void {
    if (!rootId) return;
    db.prepare(
      `UPDATE messages
          SET reply_count = (SELECT COUNT(*) FROM messages r WHERE r.parent_id = ? AND r.deleted_at IS NULL),
              last_reply_at = (SELECT MAX(r.created_at) FROM messages r WHERE r.parent_id = ? AND r.deleted_at IS NULL)
        WHERE id = ?`
    ).run(rootId, rootId, rootId);
  }

  function post(input: PostMessageInput): Message {
    const text = assertText(input.text);
    const metadata = normalizeMetadata(input.metadata);
    const author: Author = { ...defaultActor, ...(input.author ?? {}) };
    return transact(db, () => {
      const parentRef = input.parentId ?? input.threadId ?? null;
      let parent: Message | null = null;
      if (parentRef) {
        parent = get(parentRef);
        if (parent.deleted) {
          throw new ConflictError('That thread was deleted.', { details: { parentId: parent.id } });
        }
        // Replying to a reply joins its thread instead of nesting deeper.
        if (parent.parentId) parent = get(parent.parentId);
      }

      const channel = parent
        ? channels.get(parent.channelId)
        : channels.get(input.channelId ?? input.channel);

      if (channel.archived) {
        throw new ConflictError(`#${channel.slug} is archived.`, {
          hint: 'Unarchive it first: slick channel unarchive ' + channel.slug,
          details: { channelId: channel.id },
        });
      }

      const now = Date.now();
      const id = newId(ID_PREFIX.message, now);
      const mentions = extractMentions(text);
      const seq = recordEvent(db, {
        type: EVENT_TYPES.messageCreated,
        actor: author,
        channelId: channel.id,
        messageId: id,
        threadId: parent?.id ?? id,
        sessionKey: input.sessionKey ?? null,
        payload: { mentions, isReply: Boolean(parent) },
        now,
      });

      db.prepare(
        `INSERT INTO messages
           (id, channel_id, parent_id, author_id, author_kind, author_label, text, mentions,
            metadata, session_key, seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        channel.id,
        parent?.id ?? null,
        author.id,
        author.kind ?? 'human',
        author.label ?? null,
        text,
        JSON.stringify(mentions),
        metadata == null ? null : JSON.stringify(metadata),
        input.sessionKey ?? null,
        seq,
        now,
        now
      );

      if (parent) refreshThreadStats(parent.id);

      const message = get(id);
      // Backfill the event payload now that the row exists, so a single event
      // read gives an agent the whole message without a second query.
      db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(
        JSON.stringify({ mentions, isReply: Boolean(parent), message }),
        seq
      );
      return message;
    });
  }

  /** Convenience wrapper: reply into the thread of `rootRef`. */
  function reply(rootRef: string, input: Omit<PostMessageInput, 'parentId'>): Message {
    return post({ ...input, parentId: rootRef });
  }

  function resolveCursor(value: string | number | null | undefined): number | null {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return value;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && String(value).trim() !== '' && !String(value).includes('_')) {
      return asNumber;
    }
    return get(value).seq;
  }

  /**
   * Channel timeline: root messages only, oldest → newest.
   */
  function list(channelRef: string, opts: MessageListOptions = {}): MessagePage {
    const channel = channels.get(channelRef);
    const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 500);
    const where = ['m.channel_id = ?'];
    const params: SQLInputValue[] = [channel.id];

    if (!opts.includeReplies) where.push('m.parent_id IS NULL');
    if (!opts.includeDeleted) where.push('m.deleted_at IS NULL');

    const before = resolveCursor(opts.before);
    const after = resolveCursor(opts.after);
    if (before != null) {
      where.push('m.seq < ?');
      params.push(before);
    }
    if (after != null) {
      where.push('m.seq > ?');
      params.push(after);
    }

    // `after` pages forward from a point; everything else shows the newest tail.
    const ascending = after != null && before == null;
    const list_ = rows<MessageRow>(
      db
        .prepare(
          `${SELECT_MESSAGE} WHERE ${where.join(' AND ')} ORDER BY m.seq ${ascending ? 'ASC' : 'DESC'} LIMIT ?`
        )
        .all(...params, limit + 1)
    );

    const hasMore = list_.length > limit;
    const page = list_.slice(0, limit).map(serializeMessageRow);
    if (!ascending) page.reverse();

    return {
      channel,
      messages: page,
      hasMore,
      oldestSeq: page[0]?.seq ?? null,
      newestSeq: page[page.length - 1]?.seq ?? null,
    };
  }

  /**
   * A thread: its root message plus every reply, oldest → newest.
   * Accepts the root id or the id of any reply inside it.
   */
  function thread(ref: string, opts: { includeDeleted?: boolean } = {}): Thread {
    let root = get(ref);
    if (root.parentId) root = get(root.parentId);
    const where = ['m.parent_id = ?'];
    const params: SQLInputValue[] = [root.id];
    if (!opts.includeDeleted) where.push('m.deleted_at IS NULL');
    const replies = rows<MessageRow>(
      db.prepare(`${SELECT_MESSAGE} WHERE ${where.join(' AND ')} ORDER BY m.seq ASC`).all(...params)
    ).map(serializeMessageRow);
    return { root, replies, replyCount: replies.length, channel: channels.get(root.channelId) };
  }

  function update(id: string, patch: MessagePatch): Message {
    return transact(db, () => {
      const current = get(id);
      if (current.deleted) {
        throw new ConflictError('That message was deleted.', { details: { id: current.id } });
      }
      const actor = patch.author ?? defaultActor;
      const now = Date.now();
      const text = patch.text === undefined ? current.text : assertText(patch.text);
      const mentions = extractMentions(text);
      const metadata =
        patch.metadata === undefined
          ? current.metadata
          : patch.metadata === null
            ? null
            : normalizeMetadata({ ...(current.metadata ?? {}), ...patch.metadata });

      const textChanged = text !== current.text;
      const metaChanged = JSON.stringify(metadata ?? null) !== JSON.stringify(current.metadata ?? null);
      if (!textChanged && !metaChanged) return current;

      db.prepare(
        `UPDATE messages SET text = ?, mentions = ?, metadata = ?, updated_at = ?, edited_at = ?
          WHERE id = ?`
      ).run(
        text,
        JSON.stringify(mentions),
        metadata == null ? null : JSON.stringify(metadata),
        now,
        textChanged ? now : current.editedAt,
        current.id
      );

      const message = get(current.id);
      recordEvent(db, {
        type: EVENT_TYPES.messageUpdated,
        actor,
        channelId: current.channelId,
        messageId: current.id,
        threadId: current.threadId,
        sessionKey: patch.sessionKey ?? null,
        payload: { message, previousText: textChanged ? current.text : undefined },
        now,
      });
      return message;
    });
  }

  /**
   * Soft delete leaves a tombstone so surviving replies keep their anchor and
   * the content is gone; `hard` removes the row (and any replies) outright.
   */
  function remove(
    id: string,
    opts: RemoveMessageOptions = {}
  ): Message & { alreadyDeleted?: boolean; hard?: boolean; deletedReplies?: number } {
    return transact(db, () => {
      const current = get(id);
      const actor = opts.author ?? defaultActor;
      const now = Date.now();
      const replyCount = current.isThreadRoot ? current.replyCount : 0;

      if (opts.hard) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(current.id);
      } else {
        if (current.deleted) return { ...current, alreadyDeleted: true };
        db.prepare(
          `UPDATE messages SET text = '', mentions = '[]', metadata = NULL, deleted_at = ?, updated_at = ?
            WHERE id = ?`
        ).run(now, now, current.id);
      }
      if (current.parentId) refreshThreadStats(current.parentId);

      recordEvent(db, {
        type: EVENT_TYPES.messageDeleted,
        actor,
        channelId: current.channelId,
        messageId: current.id,
        threadId: current.threadId,
        sessionKey: opts.sessionKey ?? null,
        payload: { hard: Boolean(opts.hard), deletedReplies: opts.hard ? replyCount : 0 },
        now,
      });

      return opts.hard
        ? { ...current, deleted: true, deletedAt: now, hard: true, deletedReplies: replyCount }
        : get(current.id);
    });
  }

  return { find, get, post, reply, list, thread, update, remove, refreshThreadStats };
}

export type MessageService = ReturnType<typeof createMessageService>;
