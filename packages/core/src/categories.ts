/**
 * Channel categories — the sidebar's sections.
 *
 * A category is pure grouping: it owns no messages and holds no rules, so
 * deleting one only leaves its channels uncategorised (the foreign key does
 * that part). Channels point at a category rather than the other way round,
 * which keeps "which category am I in" a single column on the channel and
 * means a channel can only ever be in one place.
 */

import type { DatabaseSync } from 'node:sqlite';

import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId, ID_PREFIX } from './ids.ts';
import { row, rows, transact } from './db.ts';
import { EVENT_TYPES, recordEvent } from './events.ts';
import { assertSlug, slugify } from './channels.ts';
import type { Author, Category } from './types.ts';

interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  position: number;
  collapsed: number;
  channel_count?: number | null;
  created_at: number;
  updated_at: number;
  created_by: string;
}

function serializeRow(c: CategoryRow): Category {
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

function serialize(record: unknown): Category | null {
  const c = row<CategoryRow>(record);
  return c ? serializeRow(c) : null;
}

export interface CategoryInput {
  name?: string;
  slug?: string;
  position?: number;
  collapsed?: boolean;
  actor?: Author;
}

export interface CategoryPatch {
  name?: string | null;
  slug?: string | null;
  position?: number | null;
  collapsed?: boolean | null;
  actor?: Author;
}

export interface CategoryServiceContext {
  db: DatabaseSync;
  actor: Author;
}

/** The fields an update compares, in the order they are reported. */
const EDITABLE = ['slug', 'name', 'position', 'collapsed'] as const;

export function createCategoryService(ctx: CategoryServiceContext) {
  const { db, actor: defaultActor } = ctx;

  /** Resolve `engineering` or `cat_01k…` to a row. Returns null if absent. */
  function find(ref: string | null | undefined): Category | null {
    if (!ref) return null;
    const raw = String(ref).trim();
    const byId = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(raw);
    if (byId) return serialize(byId);
    const bySlug = db.prepare('SELECT * FROM channel_categories WHERE slug = ?').get(slugify(raw));
    return bySlug ? serialize(bySlug) : null;
  }

  function get(ref: string | null | undefined): Category {
    const found = find(ref);
    if (!found) {
      throw new NotFoundError(`No category named "${ref}".`, {
        hint: 'Run `slick category list` to see what exists.',
        details: { ref },
      });
    }
    return found;
  }

  function list(opts: { withCounts?: boolean } = {}): Category[] {
    const counts =
      opts.withCounts === false
        ? ''
        : `,
                (SELECT COUNT(*) FROM channels ch
                   WHERE ch.category_id = c.id AND ch.archived_at IS NULL) AS channel_count`;
    const sql = `SELECT c.*${counts}
                   FROM channel_categories c
                  ORDER BY c.position ASC, c.slug ASC`;
    return rows<CategoryRow>(db.prepare(sql).all()).map(serializeRow);
  }

  function create(input: CategoryInput = {}): Category {
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
        db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM channel_categories').get()?.p ?? 1
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

  function update(ref: string, patch: CategoryPatch = {}): Category {
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
      if (patch.collapsed !== undefined && patch.collapsed !== null)
        next.collapsed = Boolean(patch.collapsed);

      const changed = EDITABLE.filter((k) => next[k] !== current[k]);
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

  const setCollapsed = (ref: string, collapsed: boolean, actor?: Author): Category =>
    update(ref, { collapsed, actor });

  /**
   * Drop a category. Its channels stay exactly where they are; they just stop
   * belonging to a section.
   */
  function remove(ref: string, opts: { actor?: Author } = {}) {
    const actor = opts.actor ?? defaultActor;
    return transact(db, () => {
      const current = get(ref);
      const n = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE category_id = ?').get(current.id)?.n;
      const count = Number(n ?? 0);
      db.prepare('DELETE FROM channel_categories WHERE id = ?').run(current.id);
      recordEvent(db, {
        type: EVENT_TYPES.categoryDeleted,
        actor,
        payload: { category: current, uncategorisedChannels: count },
      });
      return { ...current, deleted: true as const, uncategorisedChannels: count };
    });
  }

  /**
   * Set the sidebar order. Anything you leave out keeps its relative order
   * behind the categories you named, so `reorder(['inbox'])` just means "put
   * inbox first".
   */
  function reorder(refs: readonly string[] | null | undefined, opts: { actor?: Author } = {}): Category[] {
    const actor = opts.actor ?? defaultActor;
    return transact(db, () => {
      const wanted: Category[] = [];
      const seen = new Set<string>();
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

export type CategoryService = ReturnType<typeof createCategoryService>;
