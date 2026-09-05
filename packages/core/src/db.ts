/**
 * Database bootstrap: pragmas, schema migration, and a transaction helper.
 *
 * Uses the built-in `node:sqlite` so the whole product installs with zero
 * native dependencies — the CLI, the daemon and the Electron shell all read
 * the same file without a compile step.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type { SQLInputValue };

export const SCHEMA_VERSION = 2;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: /* sql */ `
      CREATE TABLE meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL
      );

      CREATE TABLE channels (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL,
        name        TEXT NOT NULL,
        topic       TEXT NOT NULL DEFAULT '',
        purpose     TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL DEFAULT 'channel',
        position    INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL DEFAULT 'system'
      );
      CREATE UNIQUE INDEX ux_channels_slug ON channels(slug);

      CREATE TABLE messages (
        id            TEXT PRIMARY KEY,
        channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        parent_id     TEXT REFERENCES messages(id) ON DELETE CASCADE,
        author_id     TEXT NOT NULL,
        author_kind   TEXT NOT NULL DEFAULT 'human',
        author_label  TEXT,
        text          TEXT NOT NULL,
        mentions      TEXT NOT NULL DEFAULT '[]',
        metadata      TEXT,
        session_key   TEXT,
        seq           INTEGER NOT NULL,
        reply_count   INTEGER NOT NULL DEFAULT 0,
        last_reply_at INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        edited_at     INTEGER,
        deleted_at    INTEGER
      );
      CREATE INDEX ix_messages_channel_root ON messages(channel_id, parent_id, seq);
      CREATE INDEX ix_messages_parent ON messages(parent_id, seq);
      CREATE UNIQUE INDEX ux_messages_seq ON messages(seq);

      CREATE TABLE events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT NOT NULL,
        actor_id    TEXT NOT NULL DEFAULT 'system',
        actor_kind  TEXT NOT NULL DEFAULT 'system',
        channel_id  TEXT,
        message_id  TEXT,
        thread_id   TEXT,
        session_key TEXT,
        payload     TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX ix_events_channel ON events(channel_id, seq);
      CREATE INDEX ix_events_type ON events(type, seq);

      CREATE TABLE agent_sessions (
        key           TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        name          TEXT,
        title         TEXT NOT NULL DEFAULT '',
        channel_id    TEXT REFERENCES channels(id) ON DELETE SET NULL,
        cursor_seq    INTEGER NOT NULL DEFAULT 0,
        state         TEXT NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'active',
        message_count INTEGER NOT NULL DEFAULT 0,
        resume_count  INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_seen_at  INTEGER
      );
      CREATE UNIQUE INDEX ux_agent_sessions_name
        ON agent_sessions(agent_id, name) WHERE name IS NOT NULL;
      CREATE INDEX ix_agent_sessions_agent ON agent_sessions(agent_id, updated_at);
    `,
  },
  {
    version: 2,
    sql: /* sql */ `
      CREATE TABLE channel_categories (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL,
        name        TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        collapsed   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL DEFAULT 'system'
      );
      CREATE UNIQUE INDEX ux_channel_categories_slug ON channel_categories(slug);

      -- Deleting a category is a grouping change, not a destructive one: its
      -- channels fall back to uncategorised rather than going away with it.
      ALTER TABLE channels
        ADD COLUMN category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL;
      CREATE INDEX ix_channels_category ON channels(category_id, position);
    `,
  },
];

/**
 * Open (creating if needed) the workspace database.
 * @param file absolute path, or ':memory:'
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets the CLI write while the daemon reads, which is the whole point of
  // having two processes share one file.
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): number {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return SCHEMA_VERSION;
}

/** Connections currently inside `transact`, so nested calls join rather than fail. */
const inTransaction = new WeakSet<DatabaseSync>();

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction
 * rather than failing, so services can compose freely.
 */
export function transact<T>(db: DatabaseSync, fn: () => T): T {
  if (inTransaction.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error is the interesting one */
    }
    throw err;
  } finally {
    inTransaction.delete(db);
  }
}

/**
 * node:sqlite hands back null-prototype rows; normalise for spreads and JSON.
 *
 * The row type is the caller's claim about the schema — the columns a query
 * selects are known where the query is written, not here.
 */
export function row<T extends object>(value: unknown): T | null {
  return value === undefined || value === null ? null : { ...(value as T) };
}

export function rows<T extends object>(list: readonly unknown[]): T[] {
  return list.map((r) => ({ ...(r as T) }));
}
