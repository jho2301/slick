/**
 * Message search.
 *
 * Deliberately a plain indexed scan rather than FTS: a single-user workspace
 * is small, substring matching is what people actually expect from a search
 * box ("auth" should find "authentication"), and there is no index to keep in
 * sync on every edit.
 */

import { rows } from './db.js';
import { serializeMessage } from './messages.js';

/** Escape LIKE wildcards so a literal `%` in a query means `%`. */
function likeTerm(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function tokenize(query) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const match of String(query ?? '').matchAll(re)) {
    const term = (match[1] ?? match[2]).trim();
    if (term) terms.push(term);
  }
  return terms;
}

export function createSearchService(ctx) {
  const { db, channels } = ctx;

  /**
   * @param {string} query terms are ANDed; use "quotes" for phrases
   * @param {{channel?: string, limit?: number, author?: string, kind?: string,
   *          includeDeleted?: boolean, threadsOnly?: boolean}} [opts]
   */
  function search(query, opts = {}) {
    const terms = tokenize(query);
    if (terms.length === 0) return { query: '', terms: [], results: [], count: 0 };

    const where = terms.map(() => "m.text LIKE ? ESCAPE '\\'");
    const params = terms.map(likeTerm);

    if (!opts.includeDeleted) where.push('m.deleted_at IS NULL');
    if (opts.channel) {
      where.push('m.channel_id = ?');
      params.push(channels.get(opts.channel).id);
    }
    if (opts.author) {
      where.push('m.author_id = ?');
      params.push(String(opts.author).replace(/^@/, ''));
    }
    if (opts.kind) {
      where.push('m.author_kind = ?');
      params.push(opts.kind);
    }
    if (opts.threadsOnly) where.push('m.parent_id IS NULL');

    const limit = Math.min(Math.max(Number(opts.limit ?? 25), 1), 200);
    const list = rows(
      db
        .prepare(
          `SELECT m.*, c.slug AS channel_slug
             FROM messages m JOIN channels c ON c.id = m.channel_id
            WHERE ${where.join(' AND ')}
            ORDER BY m.seq DESC LIMIT ?`
        )
        .all(...params, limit + 1)
    );

    const hasMore = list.length > limit;
    return {
      query: String(query),
      terms,
      results: list.slice(0, limit).map(serializeMessage),
      count: Math.min(list.length, limit),
      hasMore,
    };
  }

  return { search, tokenize };
}
