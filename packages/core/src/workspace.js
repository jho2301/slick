/**
 * The workspace facade — one object that owns the database and exposes every
 * service. The CLI, the HTTP server and the tests all talk to this and only
 * this, which is why the CLI can run against the file directly while the
 * desktop app goes over HTTP without either duplicating domain logic.
 */

import { openDatabase, row, transact } from './db.js';
import { paths } from './paths.js';
import { createCategoryService } from './categories.js';
import { createChannelService } from './channels.js';
import { createMessageService } from './messages.js';
import { createAgentService } from './agents.js';
import { createSearchService } from './search.js';
import { countEvents, listEvents, maxSeq, CONVERSATION_EVENTS, EVENT_TYPES } from './events.js';

const DEFAULT_CHANNELS = [
  { slug: 'general', name: 'general', topic: 'Everything that does not have a home yet' },
  { slug: 'agents', name: 'agents', topic: 'Where your AI agents report in' },
];

export class Workspace {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{file: string, home?: string}} meta
   */
  constructor(db, meta) {
    this.db = db;
    this.file = meta.file;
    this.home = meta.home;

    const user = this.user();
    /** Default author for anything that does not say otherwise. */
    this.actor = { id: user.id, kind: 'human', label: user.name };

    const ctx = { db, actor: this.actor };
    // Categories first: channels resolve `category: 'engineering'` through them.
    this.categories = createCategoryService(ctx);
    ctx.categories = this.categories;
    this.channels = createChannelService(ctx);
    ctx.channels = this.channels;
    this.messages = createMessageService(ctx);
    ctx.messages = this.messages;
    this.agents = createAgentService(ctx);
    this.searchService = createSearchService(ctx);
  }

  /**
   * @param {{home?: string, file?: string, bootstrap?: boolean}} [opts]
   */
  static open(opts = {}) {
    const p = paths(opts.home);
    const file = opts.file ?? p.db;
    const db = openDatabase(file);
    const ws = new Workspace(db, { file, home: p.root });
    if (opts.bootstrap !== false) ws.bootstrap();
    return ws;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------------------------------------------------------------- meta ---

  getMeta(key, fallback = null) {
    const r = row(this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key));
    return r ? r.value : fallback;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
    return value;
  }

  user() {
    return {
      id: this.getMeta('user.id', 'you'),
      name: this.getMeta('user.name', this.getMeta('user.id', 'you')),
    };
  }

  setUser({ id, name }) {
    if (id) {
      this.setMeta('user.id', id);
      this.actor.id = id;
    }
    if (name) {
      this.setMeta('user.name', name);
      this.actor.label = name;
    }
    return this.user();
  }

  /** Idempotent first-run setup: identity + a couple of channels to land in. */
  bootstrap({ user, channels } = {}) {
    return transact(this.db, () => {
      const fresh = this.getMeta('workspace.created_at') == null;
      if (fresh) {
        this.setMeta('workspace.created_at', Date.now());
        this.setMeta('workspace.name', 'Slick');
        this.setMeta('user.id', user?.id ?? process.env.USER ?? 'you');
        this.setMeta('user.name', user?.name ?? process.env.USER ?? 'you');
        // Mutate rather than replace: the services captured this exact object
        // as their default author when they were built.
        const identity = this.user();
        Object.assign(this.actor, { id: identity.id, label: identity.name });
        for (const def of channels ?? DEFAULT_CHANNELS) {
          this.channels.create({ ...def, actor: { id: 'system', kind: 'system' } });
        }
      }
      return { created: fresh, ...this.info() };
    });
  }

  info() {
    const count = (sql, ...params) => Number(row(this.db.prepare(sql).get(...params)).n);
    return {
      name: this.getMeta('workspace.name', 'Slick'),
      file: this.file,
      home: this.home,
      user: this.user(),
      createdAt: Number(this.getMeta('workspace.created_at', 0)) || null,
      seq: maxSeq(this.db),
      counts: {
        channels: count('SELECT COUNT(*) AS n FROM channels WHERE archived_at IS NULL'),
        archivedChannels: count('SELECT COUNT(*) AS n FROM channels WHERE archived_at IS NOT NULL'),
        categories: count('SELECT COUNT(*) AS n FROM channel_categories'),
        messages: count('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL'),
        threads: count(
          'SELECT COUNT(*) AS n FROM messages WHERE parent_id IS NULL AND reply_count > 0 AND deleted_at IS NULL'
        ),
        agentSessions: count("SELECT COUNT(*) AS n FROM agent_sessions WHERE status = 'active'"),
      },
    };
  }

  // -------------------------------------------------------------- events ---

  /** @param {{since?: number, limit?: number, channelId?: string, types?: string[]}} [opts] */
  events(opts = {}) {
    return listEvents(this.db, opts);
  }

  eventCount(opts = {}) {
    return countEvents(this.db, opts);
  }

  seq() {
    return maxSeq(this.db);
  }

  /** Events with their message/channel filled in — what the live UI consumes. */
  hydratedEvents(opts = {}) {
    return this.events(opts).map((event) => this.agents.hydrateEvent(event));
  }

  search(query, opts) {
    return this.searchService.search(query, opts);
  }
}

export { CONVERSATION_EVENTS, EVENT_TYPES, DEFAULT_CHANNELS };
