/**
 * The append-only event log.
 *
 * Every mutation lands here with a globally monotonic `seq`. That single
 * number is the backbone of two features: the desktop app's live stream (tail
 * everything after seq N) and agent resume (a history key is really just a
 * durable pointer into this log).
 */

import type { DatabaseSync } from 'node:sqlite';

import { row, rows, type SQLInputValue } from './db.ts';
import type { Author, AuthorKind, EventRecord, JsonObject } from './types.ts';

export const EVENT_TYPES = Object.freeze({
  channelCreated: 'channel.created',
  channelUpdated: 'channel.updated',
  channelArchived: 'channel.archived',
  channelUnarchived: 'channel.unarchived',
  channelDeleted: 'channel.deleted',
  categoryCreated: 'category.created',
  categoryUpdated: 'category.updated',
  categoryDeleted: 'category.deleted',
  categoryReordered: 'category.reordered',
  messageCreated: 'message.created',
  messageUpdated: 'message.updated',
  messageDeleted: 'message.deleted',
  sessionCreated: 'agent.session.created',
  sessionUpdated: 'agent.session.updated',
  sessionResumed: 'agent.session.resumed',
  sessionEnded: 'agent.session.ended',
  agentTyping: 'agent.typing',
  agentThinking: 'agent.thinking',
});

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Events an agent cares about when catching up on a conversation. `category.*`
 * is deliberately absent: rearranging the sidebar is not something an agent
 * should wake up to handle.
 *
 * `agent.thinking` is absent for a sharper reason, and the omission *is* the
 * mechanism rather than a tidiness call. A thinking blob is one agent's
 * scratchpad, mid-answer, and what this list buys is that the *live* signal
 * stays out of the log an agent wakes for: add it here and every watcher in
 * the workspace starts waking up, mid-thought, for someone else's half-formed
 * step list.
 *
 * It is not what keeps the reasoning itself private, and it was never going to
 * be. The finished trace is written down on the message at `metadata._think`,
 * and a message travels wherever `message.created` travels — which is here.
 * `agents.pull` and `agents.resume` strip that one key on their way out, for
 * the same reason this list leaves the event off; the browser, which is who
 * the trace was written for, gets it whole.
 */
export const CONVERSATION_EVENTS: readonly EventType[] = Object.freeze([
  EVENT_TYPES.messageCreated,
  EVENT_TYPES.messageUpdated,
  EVENT_TYPES.messageDeleted,
  EVENT_TYPES.channelCreated,
  EVENT_TYPES.channelUpdated,
  EVENT_TYPES.channelArchived,
  EVENT_TYPES.channelDeleted,
]);

export interface RecordEventInput {
  type: string;
  actor?: Partial<Author> | null;
  channelId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  sessionKey?: string | null;
  payload?: JsonObject;
  now?: number;
}

/** @returns the assigned seq */
export function recordEvent(db: DatabaseSync, input: RecordEventInput): number {
  const now = input.now ?? Date.now();
  const info = db
    .prepare(
      `INSERT INTO events (type, actor_id, actor_kind, channel_id, message_id, thread_id, session_key, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.type,
      input.actor?.id ?? 'system',
      input.actor?.kind ?? 'system',
      input.channelId ?? null,
      input.messageId ?? null,
      input.threadId ?? null,
      input.sessionKey ?? null,
      JSON.stringify(input.payload ?? {}),
      now
    );
  return Number(info.lastInsertRowid);
}

/** Highest seq issued so far; 0 on an empty workspace. */
export function maxSeq(db: DatabaseSync): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get();
  return Number(r?.seq ?? 0);
}

interface EventRow {
  seq: number;
  type: string;
  actor_id: string;
  actor_kind: string;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  session_key: string | null;
  payload: string | null;
  created_at: number;
}

function hydrateRow(e: EventRow): EventRecord {
  let payload: JsonObject;
  try {
    payload = JSON.parse(e.payload ?? '{}') as JsonObject;
  } catch {
    payload = { _unparsed: e.payload };
  }
  return {
    seq: Number(e.seq),
    type: e.type,
    actor: { id: e.actor_id, kind: e.actor_kind as AuthorKind },
    channelId: e.channel_id,
    messageId: e.message_id,
    threadId: e.thread_id,
    sessionKey: e.session_key,
    payload,
    createdAt: Number(e.created_at),
  };
}

function hydrate(record: unknown): EventRecord | null {
  const e = row<EventRow>(record);
  return e ? hydrateRow(e) : null;
}

export interface ListEventsOptions {
  since?: number;
  limit?: number;
  channelId?: string | null;
  types?: readonly string[] | null;
  excludeSessionKey?: string | null;
}

function filters(opts: ListEventsOptions): { where: string[]; params: SQLInputValue[] } {
  const since = Number.isFinite(opts.since) ? Number(opts.since) : 0;
  const where = ['seq > ?'];
  const params: SQLInputValue[] = [since];
  if (opts.channelId) {
    where.push('channel_id = ?');
    params.push(opts.channelId);
  }
  if (opts.types?.length) {
    where.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
    params.push(...opts.types);
  }
  if (opts.excludeSessionKey) {
    where.push('(session_key IS NULL OR session_key != ?)');
    params.push(opts.excludeSessionKey);
  }
  return { where, params };
}

export function listEvents(db: DatabaseSync, opts: ListEventsOptions = {}): EventRecord[] {
  const limit = Math.min(Math.max(Number(opts.limit ?? 200), 1), 1000);
  const { where, params } = filters(opts);
  const list = db
    .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`)
    .all(...params, limit);
  return rows<EventRow>(list).map(hydrateRow);
}

/** Count of events after `since` matching the same filters — used for "unread". */
export function countEvents(db: DatabaseSync, opts: ListEventsOptions = {}): number {
  const { where, params } = filters(opts);
  const r = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(' AND ')}`).get(...params);
  return Number(r?.n ?? 0);
}

export { hydrate as hydrateEvent };
