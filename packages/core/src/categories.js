/**
 * Channel categories — the sidebar's sections.
 *
 * A category is pure grouping: it owns no messages and holds no rules, so
 * deleting one only leaves its channels uncategorised (the foreign key does
 * that part). Channels point at a category rather than the other way round,
 * which keeps "which category am I in" a single column on the channel and
 * means a channel can only ever be in one place.
 */

import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { newId, ID_PREFIX } from './ids.js';
import { row, rows, transact } from './db.js';
import { EVENT_TYPES, recordEvent } from './events.js';
import { assertSlug, slugify } from './channels.js';

function serialize(record) {
  const c = row(record);
  if (!c) return null;
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    position: Number(c.position),
    collapsed: Boolean(Number(c.collapsed)),
    channelCount: c.channel_count == null ? undefined : Number(c.channel_count),
    createdAt: Number(c.created_at),
    updatedAt: Number(c.updated_at),
    createdBy: c.created_by,
  };
}

export function createCategoryService(ctx) {
  const { db, actor: defaultActor } = ctx;

  /** Resolve `engineering` or `cat_01k…` to a row. Returns null if absent. */
  function find(ref) {
    if (!ref) return null;
    const raw = String(ref).trim();
    const byId = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(raw);
    if (byId) return serialize(byId);
    const bySlug = db.prepare('SELECT * FROM channel_categories WHERE slug = ?').get(slugify(raw));
    return bySlug ? serialize(bySlug) : null;
  }

  function get(ref) {
    const found = find(ref);
    if (!found) {
      throw new NotFoundError(`No category named "${ref}".`, {
        hint: 'Run `slick category list` to see what exists.',
        details: { ref },
      });
    }
    return found;
  }

  /** @param {{withCounts?: boolean}} [opts] */
  function list(opts = {}) {
    const counts =
      opts.withCounts === false
        ? ''
        : `,
                (SELECT COUNT(*) FROM channels ch
                   WHERE ch.category_id = c.id AND ch.archived_at IS NULL) AS channel_count`;
    const sql = `SELECT c.*${counts}
                   FROM channel_categories c
                  ORDER BY c.position ASC, c.slug ASC`;
    return rows(db.prepare(sql).all()).map(serialize);
  }

  /**
   * @param {{name?: string, slug?: string, position?: number, collapsed?: boolean,
   *          actor?: {id: string, kind: string}}} input
   */
  function create(input = {}) {
    const name = String(input.name ?? input.slug ?? '').trim();
    if (!name) {
      throw new ValidationError('Give the category a name.', {
        hint: 'For example: slick category create Engineering',
      });
    }
    const slug = assertSlug(slugify(input.slug ?? name), 'category');
    const actor = input.actor ?? defaultActor;
    return transact(db, () => {
      const existing = db.prepare('SELECT id FROM channel_categories WHERE slug = ?').get(slug);
      if (existing) {
        throw new ConflictError(`Category "${slug}" already exists.`, { details: { slug } });
      }
      const now = Date.now();
      const id = newId(ID_PREFIX.category, now);
      const nextPosition = Number(
        db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM channel_categories').get().p
      );
      db.prepare(
        `INSERT INTO channel_categories (id, slug, name, position, collapsed, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        slug,
        name,
        input.position == null ? nextPosition : Number(input.position),
        input.collapsed ? 1 : 0,
        now,
        now,
        actor.id
      );
      const category = get(id);
      recordEvent(db, {
        type: EVENT_TYPES.categoryCreated,
        actor,
        payload: { category },
        now,
      });
      return category;
    });
  }

  /**
   * @param {string} ref
   * @param {{name?: string, slug?: string, position?: number, collapsed?: boolean,
   *          actor?: {id: string, kind: string}}} patch
   */
  function update(ref, patch = {}) {
    const actor = patch.actor ?? defaultActor;
    return transact(db, () => {
      const current = get(ref);
      const next = {
        slug: current.slug,
        name: current.name,
        position: current.position,
        collapsed: current.collapsed,
      };

      if (patch.slug !== undefined && patch.slug !== null) {
        const slug = assertSlug(slugify(patch.slug), 'category');
        if (slug !== current.slug) {
          const clash = db
            .prepare('SELECT id FROM channel_categories WHERE slug = ? AND id != ?')
            .get(slug, current.id);
          if (clash) throw new ConflictError(`Category "${slug}" already exists.`, { details: { slug } });
        }
        next.slug = slug;
      }
      if (patch.name !== undefined && patch.name !== null) next.name = String(patch.name).trim() || next.slug;
      if (patch.position !== undefined && patch.position !== null) next.position = Number(patch.position);
      if (patch.collapsed !== undefined && patch.collapsed !== null) next.collapsed = Boolean(patch.collapsed);

      const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
      if (changed.length === 0) return current;

      const now = Date.now();
      db.prepare(
        `UPDATE channel_categories SET slug = ?, name = ?, position = ?, collapsed = ?, updated_at = ?
          WHERE id = ?`
      ).run(next.slug, next.name, next.position, next.collapsed ? 1 : 0, now, current.id);

      const category = get(current.id);
      recordEvent(db, {
        type: EVENT_TYPES.categoryUpdated,
        actor,
        payload: { category, changed, previous: Object.fromEntries(changed.map((k) => [k, current[k]])) },
        now,
      });
      return category;
    });
  }

  const setCollapsed = (ref, collapsed, actor) => update(ref, { collapsed, actor });

  /**
   * Drop a category. Its channels stay exactly where they are; they just stop
   * belonging to a section.
   * @param {string} ref
   * @param {{actor?: {id: string, kind: string}}} [opts]
   */
  function remove(ref, opts = {}) {
    const actor = opts.actor ?? defaultActor;
    return transact(db, () => {
      const current = get(ref);
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM channels WHERE category_id = ?')
        .get(current.id);
      const count = Number(n);
      db.prepare('DELETE FROM channel_categories WHERE id = ?').run(current.id);
      recordEvent(db, {
        type: EVENT_TYPES.categoryDeleted,
        actor,
        payload: { category: current, uncategorisedChannels: count },
      });
      return { ...current, deleted: true, uncategorisedChannels: count };
    });
  }

  /**
   * Set the sidebar order. Anything you leave out keeps its relative order
   * behind the categories you named, so `reorder(['inbox'])` just means "put
   * inbox first".
   * @param {string[]} refs
   * @param {{actor?: {id: string, kind: string}}} [opts]
   */
  function reorder(refs, opts = {}) {
    const actor = opts.actor ?? defaultActor;
    return transact(db, () => {
      const wanted = [];
      const seen = new Set();
      for (const ref of refs ?? []) {
        const category = get(ref);
        if (seen.has(category.id)) continue;
        seen.add(category.id);
        wanted.push(category);
      }
      if (wanted.length === 0) {
        throw new ValidationError('Name the categories in the order you want them.', {
          hint: 'For example: slick category reorder engineering design',
        });
      }
      const order = [...wanted, ...list({ withCounts: false }).filter((c) => !seen.has(c.id))];
      const now = Date.now();
      const stmt = db.prepare('UPDATE channel_categories SET position = ?, updated_at = ? WHERE id = ?');
      order.forEach((category, index) => stmt.run(index + 1, now, category.id));

      const categories = list();
      recordEvent(db, {
        type: EVENT_TYPES.categoryReordered,
        actor,
        payload: { categories },
        now,
      });
      return categories;
    });
  }

  return { find, get, list, create, update, setCollapsed, remove, reorder, serialize };
}
