/**
 * Channel CRUD.
 *
 * Channels are addressed by slug everywhere a human types them (`#general`)
 * and by id everywhere a machine stores them, so every lookup accepts either.
 */

import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { newId, ID_PREFIX } from './ids.js';
import { row, rows, transact } from './db.js';
import { EVENT_TYPES, recordEvent } from './events.js';

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Turn free text into a legal slug: "Design Review!" -> "design-review". */
export function slugify(input) {
  const slug = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return slug;
}

export function assertSlug(slug) {
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError(
      `"${slug}" is not a valid channel name. Use 1–64 lowercase letters, digits, "-", "_" or "."`,
      { details: { slug } }
    );
  }
  return slug;
}

function serialize(record) {
  const c = row(record);
  if (!c) return null;
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    topic: c.topic,
    purpose: c.purpose,
    kind: c.kind,
    position: Number(c.position),
    archived: c.archived_at != null,
    archivedAt: c.archived_at == null ? null : Number(c.archived_at),
    createdAt: Number(c.created_at),
    updatedAt: Number(c.updated_at),
    createdBy: c.created_by,
    messageCount: c.message_count == null ? undefined : Number(c.message_count),
    lastMessageAt: c.last_message_at == null ? null : Number(c.last_message_at),
  };
}

export function createChannelService(ctx) {
  const { db, actor: defaultActor } = ctx;

  /** Resolve `#general`, `general` or `ch_01k…` to a row. Returns null if absent. */
  function find(ref) {
    if (!ref) return null;
    const raw = String(ref).trim().replace(/^#/, '');
    const byId = db.prepare('SELECT * FROM channels WHERE id = ?').get(raw);
    if (byId) return serialize(byId);
    const bySlug = db.prepare('SELECT * FROM channels WHERE slug = ?').get(raw.toLowerCase());
    return bySlug ? serialize(bySlug) : null;
  }

  function get(ref) {
    const found = find(ref);
    if (!found) {
      throw new NotFoundError(`No channel named "${ref}".`, {
        hint: 'Run `slick channel list` to see what exists.',
        details: { ref },
      });
    }
    return found;
  }

  /** @param {{includeArchived?: boolean, withStats?: boolean}} [opts] */
  function list(opts = {}) {
    const where = opts.includeArchived ? '1 = 1' : 'c.archived_at IS NULL';
    const sql = opts.withStats === false
      ? `SELECT c.* FROM channels c WHERE ${where} ORDER BY c.position ASC, c.slug ASC`
      : `SELECT c.*,
                (SELECT COUNT(*) FROM messages m
                   WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS message_count,
                (SELECT MAX(m.created_at) FROM messages m
                   WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_message_at
           FROM channels c
          WHERE ${where}
          ORDER BY c.position ASC, c.slug ASC`;
    return rows(db.prepare(sql).all()).map(serialize);
  }

  /**
   * @param {{slug: string, name?: string, topic?: string, purpose?: string,
   *          kind?: string, actor?: {id: string, kind: string}}} input
   */
  function create(input) {
    const slug = assertSlug(slugify(input.slug ?? input.name));
    const actor = input.actor ?? defaultActor;
    return transact(db, () => {
      const existing = db.prepare('SELECT id FROM channels WHERE slug = ?').get(slug);
      if (existing) {
        throw new ConflictError(`Channel #${slug} already exists.`, { details: { slug } });
      }
      const now = Date.now();
      const id = newId(ID_PREFIX.channel, now);
      const nextPosition =
        Number(db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM channels').get().p);
      db.prepare(
        `INSERT INTO channels (id, slug, name, topic, purpose, kind, position, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        slug,
        input.name?.trim() || slug,
        input.topic?.trim() ?? '',
        input.purpose?.trim() ?? '',
        input.kind ?? 'channel',
        nextPosition,
        now,
        now,
        actor.id
      );
      const channel = get(id);
      recordEvent(db, {
        type: EVENT_TYPES.channelCreated,
        actor,
        channelId: id,
        payload: { channel },
        now,
      });
      return channel;
    });
  }

  /**
   * @param {string} ref
   * @param {{slug?: string, name?: string, topic?: string, purpose?: string,
   *          position?: number, actor?: {id: string, kind: string}}} patch
   */
  function update(ref, patch) {
    const actor = patch.actor ?? defaultActor;
    return transact(db, () => {
      const current = get(ref);
      const next = {
        slug: current.slug,
        name: current.name,
        topic: current.topic,
        purpose: current.purpose,
        position: current.position,
      };

      if (patch.slug !== undefined && patch.slug !== null) {
        const slug = assertSlug(slugify(patch.slug));
        if (slug !== current.slug) {
          const clash = db.prepare('SELECT id FROM channels WHERE slug = ? AND id != ?').get(slug, current.id);
          if (clash) throw new ConflictError(`Channel #${slug} already exists.`, { details: { slug } });
        }
        next.slug = slug;
      }
      if (patch.name !== undefined && patch.name !== null) next.name = String(patch.name).trim() || next.slug;
      if (patch.topic !== undefined && patch.topic !== null) next.topic = String(patch.topic).trim();
      if (patch.purpose !== undefined && patch.purpose !== null) next.purpose = String(patch.purpose).trim();
      if (patch.position !== undefined && patch.position !== null) next.position = Number(patch.position);

      const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
      if (changed.length === 0) return current;

      const now = Date.now();
      db.prepare(
        `UPDATE channels SET slug = ?, name = ?, topic = ?, purpose = ?, position = ?, updated_at = ?
          WHERE id = ?`
      ).run(next.slug, next.name, next.topic, next.purpose, next.position, now, current.id);

      const channel = get(current.id);
      recordEvent(db, {
        type: EVENT_TYPES.channelUpdated,
        actor,
        channelId: current.id,
        payload: { channel, changed, previous: Object.fromEntries(changed.map((k) => [k, current[k]])) },
        now,
      });
      return channel;
    });
  }

  function setArchived(ref, archived, actor = defaultActor) {
    return transact(db, () => {
      const current = get(ref);
      if (current.archived === archived) return current;
      const now = Date.now();
      db.prepare('UPDATE channels SET archived_at = ?, updated_at = ? WHERE id = ?').run(
        archived ? now : null,
        now,
        current.id
      );
      const channel = get(current.id);
      recordEvent(db, {
        type: archived ? EVENT_TYPES.channelArchived : EVENT_TYPES.channelUnarchived,
        actor,
        channelId: current.id,
        payload: { channel },
        now,
      });
      return channel;
    });
  }

  const archive = (ref, actor) => setArchived(ref, true, actor);
  const unarchive = (ref, actor) => setArchived(ref, false, actor);

  /**
   * Permanently drop a channel and everything in it. Refuses non-empty
   * channels unless `force` — archiving is almost always what you meant.
   * @param {string} ref
   * @param {{force?: boolean, actor?: {id: string, kind: string}}} [opts]
   */
  function remove(ref, opts = {}) {
    const actor = opts.actor ?? defaultActor;
    return transact(db, () => {
      const current = get(ref);
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(current.id);
      const count = Number(n);
      if (count > 0 && !opts.force) {
        throw new ConflictError(
          `#${current.slug} still holds ${count} message${count === 1 ? '' : 's'}.`,
          {
            hint: 'Archive it instead, or pass force to delete the messages too.',
            details: { channelId: current.id, messageCount: count },
          }
        );
      }
      db.prepare('DELETE FROM channels WHERE id = ?').run(current.id);
      recordEvent(db, {
        type: EVENT_TYPES.channelDeleted,
        actor,
        channelId: current.id,
        payload: { channel: current, deletedMessages: count },
      });
      return { ...current, deleted: true, deletedMessages: count };
    });
  }

  return { find, get, list, create, update, archive, unarchive, remove, serialize };
}
