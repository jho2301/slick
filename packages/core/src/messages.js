/**
 * Messages and threads.
 *
 * A thread is just a message whose `parent_id` points at the root message it
 * replies to — one table, two levels, exactly like Slack. Replying to a reply
 * re-targets the thread root rather than nesting, so threads never go deeper
 * than one level and the UI stays predictable.
 */

import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { newId, ID_PREFIX } from './ids.js';
import { row, rows, transact } from './db.js';
import { EVENT_TYPES, recordEvent } from './events.js';

const MAX_TEXT_LENGTH = 40_000;
const MENTION_RE = /(?:^|[\s(<[])@([a-z0-9][a-z0-9._-]{0,63})/gi;

/** `@claude fix this` -> ['claude'] */
export function extractMentions(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(MENTION_RE)) {
    found.add(match[1].toLowerCase().replace(/[.]+$/, ''));
  }
  return [...found];
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function serializeMessage(record) {
  const m = row(record);
  if (!m) return null;
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
      kind: m.author_kind,
      label: m.author_label ?? m.author_id,
    },
    text: m.text,
    mentions: parseJson(m.mentions, []),
    metadata: parseJson(m.metadata, null),
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

export function createMessageService(ctx) {
  const { db, channels, actor: defaultActor } = ctx;

  const SELECT_MESSAGE = `SELECT m.*, c.slug AS channel_slug FROM messages m
                            JOIN channels c ON c.id = m.channel_id`;

  function find(id) {
    if (!id) return null;
    const r = db.prepare(`${SELECT_MESSAGE} WHERE m.id = ?`).get(String(id).trim());
    return r ? serializeMessage(r) : null;
  }

  function get(id, { includeDeleted = true } = {}) {
    const found = find(id);
    if (!found || (!includeDeleted && found.deleted)) {
      throw new NotFoundError(`No message with id "${id}".`, {
        hint: 'Message ids look like msg_01k…; `slick message list <channel>` prints them.',
        details: { id },
      });
    }
    return found;
  }

  function assertText(text) {
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
  function refreshThreadStats(rootId) {
    if (!rootId) return;
    db.prepare(
      `UPDATE messages
          SET reply_count = (SELECT COUNT(*) FROM messages r WHERE r.parent_id = ? AND r.deleted_at IS NULL),
              last_reply_at = (SELECT MAX(r.created_at) FROM messages r WHERE r.parent_id = ? AND r.deleted_at IS NULL)
        WHERE id = ?`
    ).run(rootId, rootId, rootId);
  }

  /**
   * @param {{
   *   channel?: string, channelId?: string, text: string,
   *   parentId?: string|null, threadId?: string|null,
   *   author?: {id: string, kind?: string, label?: string},
   *   metadata?: Record<string, unknown>|null,
   *   sessionKey?: string|null,
   * }} input
   */
  function post(input) {
    const text = assertText(input.text);
    const author = { ...defaultActor, ...(input.author ?? {}) };
    return transact(db, () => {
      const parentRef = input.parentId ?? input.threadId ?? null;
      let parent = null;
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
        input.metadata == null ? null : JSON.stringify(input.metadata),
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
  function reply(rootRef, input) {
    return post({ ...input, parentId: rootRef });
  }

  function resolveCursor(value) {
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
   * @param {string} channelRef
   * @param {{limit?: number, before?: string|number, after?: string|number,
   *          includeDeleted?: boolean, includeReplies?: boolean}} [opts]
   */
  function list(channelRef, opts = {}) {
    const channel = channels.get(channelRef);
    const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 500);
    const where = ['m.channel_id = ?'];
    const params = [channel.id];

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
    const list_ = rows(
      db
        .prepare(
          `${SELECT_MESSAGE} WHERE ${where.join(' AND ')} ORDER BY m.seq ${ascending ? 'ASC' : 'DESC'} LIMIT ?`
        )
        .all(...params, limit + 1)
    );

    const hasMore = list_.length > limit;
    const page = list_.slice(0, limit).map(serializeMessage);
    if (!ascending) page.reverse();

    return {
      channel,
      messages: page,
      hasMore,
      oldestSeq: page.length ? page[0].seq : null,
      newestSeq: page.length ? page[page.length - 1].seq : null,
    };
  }

  /**
   * A thread: its root message plus every reply, oldest → newest.
   * Accepts the root id or the id of any reply inside it.
   */
  function thread(ref, opts = {}) {
    let root = get(ref);
    if (root.parentId) root = get(root.parentId);
    const where = ['m.parent_id = ?'];
    const params = [root.id];
    if (!opts.includeDeleted) where.push('m.deleted_at IS NULL');
    const replies = rows(
      db.prepare(`${SELECT_MESSAGE} WHERE ${where.join(' AND ')} ORDER BY m.seq ASC`).all(...params)
    ).map(serializeMessage);
    return { root, replies, replyCount: replies.length, channel: channels.get(root.channelId) };
  }

  /**
   * @param {string} id
   * @param {{text?: string, metadata?: Record<string, unknown>|null,
   *          author?: {id: string, kind?: string}, sessionKey?: string|null}} patch
   */
  function update(id, patch) {
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
            : { ...(current.metadata ?? {}), ...patch.metadata };

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
   * @param {string} id
   * @param {{hard?: boolean, author?: {id: string, kind?: string}, sessionKey?: string|null}} [opts]
   */
  function remove(id, opts = {}) {
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
