/**
 * Database bootstrap: pragmas, schema migration, and a transaction helper.
 *
 * Uses the built-in `node:sqlite` so the whole product installs with zero
 * native dependencies — the CLI, the daemon and the Electron shell all read
 * the same file without a compile step.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

const MIGRATIONS = [
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
];

/**
 * Open (creating if needed) the workspace database.
 * @param {string} file absolute path, or ':memory:'
 * @returns {DatabaseSync}
 */
export function openDatabase(file) {
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

/** @param {DatabaseSync} db */
export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version ?? 0);
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

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction
 * rather than failing, so services can compose freely.
 * @template T
 * @param {DatabaseSync & {__inTx?: boolean}} db
 * @param {() => T} fn
 * @returns {T}
 */
export function transact(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
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
    db.__inTx = false;
  }
}

/** node:sqlite hands back null-prototype rows; normalise for spreads and JSON. */
export function row(value) {
  return value === undefined || value === null ? null : { ...value };
}

/** @param {unknown[]} rows */
export function rows(list) {
  return list.map((r) => ({ ...r }));
}
