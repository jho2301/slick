/**
 * The workspace facade — one object that owns the database and exposes every
 * service. The CLI, the HTTP server and the tests all talk to this and only
 * this, which is why the CLI can run against the file directly while the
 * desktop app goes over HTTP without either duplicating domain logic.
 */

import type { DatabaseSync } from 'node:sqlite';

import { openDatabase, row, transact, type SQLInputValue } from './db.ts';
import { paths } from './paths.ts';
import { createCategoryService, type CategoryService } from './categories.ts';
import { createChannelService, type ChannelInput, type ChannelService } from './channels.ts';
import { createMessageService, type MessageService } from './messages.ts';
import { createAgentService, type AgentService } from './agents.ts';
import { createSearchService, type SearchOptions, type SearchResult, type SearchService } from './search.ts';
import {
  countEvents,
  listEvents,
  maxSeq,
  CONVERSATION_EVENTS,
  EVENT_TYPES,
  type ListEventsOptions,
} from './events.ts';
import type { Author, EventRecord, HydratedEvent } from './types.ts';

const DEFAULT_CHANNELS: ChannelInput[] = [
  { slug: 'general', name: 'general', topic: 'Everything that does not have a home yet' },
  { slug: 'agents', name: 'agents', topic: 'Where your AI agents report in' },
];

export interface WorkspaceUser {
  id: string;
  name: string;
}

export interface WorkspaceInfo {
  name: string;
  file: string;
  home: string | undefined;
  user: WorkspaceUser;
  createdAt: number | null;
  seq: number;
  counts: {
    channels: number;
    archivedChannels: number;
    categories: number;
    messages: number;
    threads: number;
    agentSessions: number;
  };
}

export interface OpenOptions {
  home?: string | null;
  file?: string;
  bootstrap?: boolean;
}

export interface BootstrapOptions {
  user?: { id?: string; name?: string };
  channels?: ChannelInput[];
}

/**
 * What every service is built with. `home` travels with it because services
 * need more than the database to answer some questions — `serve` locks live
 * on disk. The services themselves are added as they are built, in
 * dependency order, so each one can reach the ones before it.
 */
export interface ServiceContext {
  db: DatabaseSync;
  actor: Author;
  home: string | undefined;
  categories: CategoryService;
  channels: ChannelService;
  messages: MessageService;
}

export class Workspace {
  readonly db: DatabaseSync;
  readonly file: string;
  readonly home: string | undefined;
  /** Default author for anything that does not say otherwise. */
  readonly actor: Author;
  readonly categories: CategoryService;
  readonly channels: ChannelService;
  readonly messages: MessageService;
  readonly agents: AgentService;
  readonly searchService: SearchService;

  constructor(db: DatabaseSync, meta: { file: string; home?: string }) {
    this.db = db;
    this.file = meta.file;
    this.home = meta.home;

    const user = this.user();
    this.actor = { id: user.id, kind: 'human', label: user.name };

    // Built up in dependency order: categories first, because channels resolve
    // `category: 'engineering'` through them. The cast is the price of adding
    // the services one at a time; nothing reads a service before it exists.
    const ctx = { db, actor: this.actor, home: this.home } as ServiceContext;
    this.categories = createCategoryService(ctx);
    ctx.categories = this.categories;
    this.channels = createChannelService(ctx);
    ctx.channels = this.channels;
    this.messages = createMessageService(ctx);
    ctx.messages = this.messages;
    this.agents = createAgentService(ctx);
    this.searchService = createSearchService(ctx);
  }

  static open(opts: OpenOptions = {}): Workspace {
    const p = paths(opts.home);
    const file = opts.file ?? p.db;
    const db = openDatabase(file);
    const ws = new Workspace(db, { file, home: p.root });
    if (opts.bootstrap !== false) ws.bootstrap();
    return ws;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------------------------------------------------------------- meta ---

  getMeta(key: string): string | null;
  getMeta(key: string, fallback: string): string;
  getMeta(key: string, fallback: number): string | number;
  getMeta(key: string, fallback: string | number | null = null): string | number | null {
    const r = row<{ value: string }>(this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key));
    return r ? String(r.value) : fallback;
  }

  setMeta<T extends string | number>(key: string, value: T): T {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, String(value));
    return value;
  }

  user(): WorkspaceUser {
    return {
      id: this.getMeta('user.id', 'you'),
      name: this.getMeta('user.name', this.getMeta('user.id', 'you')),
    };
  }

  setUser({ id, name }: { id?: string | null; name?: string | null }): WorkspaceUser {
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
  bootstrap({ user, channels }: BootstrapOptions = {}): WorkspaceInfo & { created: boolean } {
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

  info(): WorkspaceInfo {
    const count = (sql: string, ...params: SQLInputValue[]) =>
      Number(row<{ n: number }>(this.db.prepare(sql).get(...params))?.n ?? 0);
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

  events(opts: ListEventsOptions = {}): EventRecord[] {
    return listEvents(this.db, opts);
  }

  eventCount(opts: ListEventsOptions = {}): number {
    return countEvents(this.db, opts);
  }

  seq(): number {
    return maxSeq(this.db);
  }

  /** Events with their message/channel filled in — what the live UI consumes. */
  hydratedEvents(opts: ListEventsOptions = {}): HydratedEvent[] {
    return this.events(opts).map((event) => this.agents.hydrateEvent(event));
  }

  search(query: unknown, opts?: SearchOptions): SearchResult {
    return this.searchService.search(query, opts);
  }
}

export { CONVERSATION_EVENTS, EVENT_TYPES, DEFAULT_CHANNELS };
