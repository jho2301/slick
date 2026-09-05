/**
 * Agent sessions — the resume mechanism.
 *
 * An agent gets a *history key* (`slk_h1_…`) the first time it joins the
 * workspace. The key is durable and portable: write it down, come back in a
 * new process a week later, hand it to `slick agent resume`, and you get back
 *
 *   1. the private state you saved (whatever JSON you want to remember),
 *   2. how far you had read (a cursor into the global event log), and
 *   3. everything that happened while you were gone.
 *
 * Because the cursor lives in the database rather than in the agent, resuming
 * is exact — no re-reading messages you already handled, no missed messages.
 */

import type { DatabaseSync } from 'node:sqlite';

import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { isRecord } from './guards.ts';
import { newHistoryKey, looksLikeHistoryKey } from './ids.ts';
import { row, rows, transact, type SQLInputValue } from './db.ts';
import { readServeLock, serveStatus } from './serve.ts';
import { THINK_KEY, normalizeThinking } from './thinking.ts';
import {
  CONVERSATION_EVENTS,
  EVENT_TYPES,
  countEvents,
  listEvents,
  maxSeq,
  recordEvent,
  type ListEventsOptions,
} from './events.ts';
import type { ChannelService } from './channels.ts';
import type { MessageService } from './messages.ts';
import type {
  AgentSession,
  Channel,
  EventRecord,
  HydratedEvent,
  JsonObject,
  Message,
  MessageMetadata,
  ModelChoice,
  SessionState,
  ThinkingTrace,
} from './types.ts';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Where a session records the model `slick agent serve` should call for it.
 *
 * It is underscore-prefixed because it is our bookkeeping, not the agent's
 * memory: `serve` keeps those keys out of the prompt, so switching models
 * never looks to the agent like something it wrote has changed.
 */
export const SERVE_MODEL_KEY = '_serveModel';

/** The model set on a session, or null for "whatever the agent defaults to". */
export function readServeModel(state: SessionState | null | undefined): string | null {
  const value = state?.[SERVE_MODEL_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * How hard the agent should think, when it is the kind of agent that can be
 * told. The levels are the agent's own vocabulary — `claude` takes five of
 * them, Hermes eight — so Slick stores whatever was set and lets the binary
 * be the authority, exactly as it does for the model name.
 */
export const SERVE_EFFORT_KEY = '_serveEffort';

/**
 * Which calling convention the watcher on this session uses. It is a launch
 * flag (`serve --adapter`), which the daemon has no way to see — so the
 * watcher writes it down, and everything else can ask the session instead of
 * asking the process.
 */
export const SERVE_ADAPTER_KEY = '_serveAdapter';

/** The adapter a watcher last served this session with, if one has. */
export function readServeAdapter(state: SessionState | null | undefined): string | null {
  const value = state?.[SERVE_ADAPTER_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * How long a "typing on" with no "off" behind it is still believed. A backstop
 * for a watcher that died between the two, not a cadence: the live signal is
 * the event, and this only bounds the snapshot below.
 */
const TYPING_WINDOW_MS = 5 * 60 * 1000;

/** The reasoning effort set on a session, or null for the agent's own default. */
export function readServeEffort(state: SessionState | null | undefined): string | null {
  const value = state?.[SERVE_EFFORT_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The models the agent behind this session says it can run, as `serve` last
 * asked it (`<cmd> --list-models`). It is a cache of someone else's answer,
 * not a rule: a model missing from it is still allowed, because the binary is
 * the authority on that and this list can be a day old.
 */
export const SERVE_MODELS_KEY = '_serveModelChoices';

/** When that list was last fetched, so a watcher re-asks rather than never. */
export const SERVE_MODELS_AT_KEY = '_serveModelsAt';

/** How many we keep. A provider list this long is already a scrolling menu. */
const MAX_CHOICES = 300;

/**
 * Normalise whatever the binary answered into `{id, label, group}` rows.
 * Accepts a bare array of names, or objects with `id`/`name`/`model`, so an
 * agent can answer in the shape that suits it.
 */
export function normalizeModelChoices(input: unknown): ModelChoice[] {
  const list: unknown[] = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.models)
      ? input.models
      : [];
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const rec = isRecord(entry) ? entry : null;
    const id = String(
      (typeof entry === 'string' ? entry : (rec?.id ?? rec?.name ?? rec?.model)) ?? ''
    ).trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const label =
      String(rec?.label ?? rec?.name ?? id)
        .trim()
        .slice(0, 200) || id;
    const group = rec?.group ?? rec?.provider ?? null;
    out.push({ id, label, group: group ? String(group).trim().slice(0, 80) : null });
    if (out.length >= MAX_CHOICES) break;
  }
  return out;
}

/** The choices stored on a session, normalised. Always an array. */
export function readServeModelChoices(state: SessionState | null | undefined): ModelChoice[] {
  return normalizeModelChoices(state?.[SERVE_MODELS_KEY]);
}

function parseState(value: unknown): SessionState {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '{}'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Key-order-independent JSON, so "did this actually change?" has one answer. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
    .join(',')}}`;
}

/**
 * How stale a session's `last_seen_at` may get before an otherwise silent poll
 * refreshes it. Long enough that a 2-second watcher writes 1/15th as often,
 * short enough that "seen 12s ago" is still true when a human reads it.
 */
const SEEN_HEARTBEAT_MS = 30_000;

interface SessionRow {
  key: string;
  agent_id: string;
  name: string | null;
  title: string;
  channel_id: string | null;
  channel_slug?: string | null;
  cursor_seq: number;
  state: string;
  status: string;
  message_count: number;
  resume_count: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

/** The latest row per (session, agent, thread) for a live signal query. */
interface SignalRow {
  seq: number;
  session_key: string | null;
  thread_id: string;
  channel_id: string | null;
  actor_id: string;
  payload: string | null;
  created_at: number;
}

export interface SessionReadOptions {
  agentId?: string;
}

export interface SessionListOptions extends SessionReadOptions {
  includeEnded?: boolean;
  limit?: number;
}

export interface StartSessionInput {
  agentId?: string;
  name?: string | null;
  title?: string;
  channel?: string | null;
  state?: SessionState;
  fromBeginning?: boolean;
  reuse?: boolean;
}

/** What to read for a session: which channel, whose messages, which types. */
export interface ReadFilterOptions {
  includeOwn?: boolean;
  channel?: string | null;
  scope?: 'workspace' | 'session';
  types?: readonly string[] | null;
}

export interface PullOptions extends ReadFilterOptions, SessionReadOptions {
  limit?: number;
  peek?: boolean;
}

export interface PullResult {
  session: AgentSession;
  events: HydratedEvent[];
  previousCursor: number;
  cursor: number;
  hasMore: boolean;
  pending: number;
}

export interface ResumeOptions extends ReadFilterOptions, SessionReadOptions {
  limit?: number;
  contextLimit?: number;
  create?: boolean;
  title?: string;
}

export interface ResumeResult {
  session: AgentSession;
  state: SessionState;
  cursor: number;
  channel: Channel | null;
  context: Message[];
  missed: HydratedEvent[];
  hasMore: boolean;
  pending: number;
}

export interface SessionPatch {
  title?: string | null;
  name?: string | null;
  channel?: string | null;
}

export interface AgentPostInput extends SessionReadOptions {
  channel?: string | null;
  text: string;
  threadId?: string | null;
  metadata?: MessageMetadata | null;
  label?: string;
}

export interface TypingInput extends SessionReadOptions {
  on?: boolean;
  threadId?: string | null;
  channelId?: string | null;
}

export interface TypingEntry {
  threadId: string;
  channelId: string | null;
  agentId: string;
  sessionKey: string | null;
  at: number;
}

export interface ThinkingInput extends SessionReadOptions {
  think?: unknown;
  threadId?: string | null;
  channelId?: string | null;
}

export interface ThinkingEntry extends TypingEntry {
  think: ThinkingTrace;
}

export interface ExternalTypingInput {
  agentId?: string;
  threadId?: string;
  on?: boolean;
}

export interface ExternalThinkingInput {
  agentId?: string;
  threadId?: string;
  think?: unknown;
}

export interface AgentServiceContext {
  db: DatabaseSync;
  home: string | undefined;
  channels: ChannelService;
  messages: MessageService;
}

export function createAgentService(ctx: AgentServiceContext) {
  const { db, channels, messages, home } = ctx;

  function serializeRow(s: SessionRow): AgentSession {
    const state = parseState(s.state);
    // Whether anyone answers for this session, rather than only posts through
    // it. Every caller that offers agents to a human needs this, and none of
    // them can work it out from the row alone.
    const serve = serveStatus({ key: s.key, status: s.status, state }, home);
    return {
      key: s.key,
      agentId: s.agent_id,
      name: s.name,
      title: s.title,
      channelId: s.channel_id,
      channelSlug: s.channel_slug ?? null,
      cursorSeq: Number(s.cursor_seq),
      state,
      status: s.status,
      callable: serve.callable,
      serve,
      messageCount: Number(s.message_count),
      resumeCount: Number(s.resume_count),
      createdAt: Number(s.created_at),
      updatedAt: Number(s.updated_at),
      lastSeenAt: s.last_seen_at == null ? null : Number(s.last_seen_at),
    };
  }

  function serialize(record: unknown): AgentSession | null {
    const s = row<SessionRow>(record);
    return s ? serializeRow(s) : null;
  }

  const SELECT_SESSION = `SELECT s.*, c.slug AS channel_slug
                            FROM agent_sessions s
                            LEFT JOIN channels c ON c.id = s.channel_id`;

  /**
   * Look a session up by history key, or by `name` scoped to an agent.
   */
  function find(ref: string | null | undefined, opts: SessionReadOptions = {}): AgentSession | null {
    if (!ref) return null;
    const raw = String(ref).trim();
    const byKey = db.prepare(`${SELECT_SESSION} WHERE s.key = ?`).get(raw);
    if (byKey) return serialize(byKey);
    if (looksLikeHistoryKey(raw)) return null; // it was a key, it just doesn't exist
    const named = opts.agentId
      ? db.prepare(`${SELECT_SESSION} WHERE s.name = ? AND s.agent_id = ?`).get(raw, opts.agentId)
      : db.prepare(`${SELECT_SESSION} WHERE s.name = ? ORDER BY s.updated_at DESC`).get(raw);
    return named ? serialize(named) : null;
  }

  function get(ref: string | null | undefined, opts: SessionReadOptions = {}): AgentSession {
    const found = find(ref, opts);
    if (!found) {
      throw new NotFoundError(`No agent session for "${ref}".`, {
        code: 'unknown_history_key',
        hint: 'Run `slick agent sessions` to list history keys, or `slick agent start` for a new one.',
        details: { ref },
      });
    }
    return found;
  }

  function list(opts: SessionListOptions = {}): AgentSession[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.agentId) {
      where.push('s.agent_id = ?');
      params.push(opts.agentId);
    }
    if (!opts.includeEnded) where.push("s.status = 'active'");
    const sql = `${SELECT_SESSION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY s.updated_at DESC LIMIT ?`;
    return rows<SessionRow>(db.prepare(sql).all(...params, Math.min(Number(opts.limit ?? 100), 500))).map(
      serializeRow
    );
  }

  /**
   * Mint a new history key.
   */
  function start(input: StartSessionInput = {}): AgentSession & { reused?: boolean } {
    const agentId = String(input.agentId ?? 'agent')
      .trim()
      .toLowerCase();
    if (!NAME_RE.test(agentId)) {
      throw new ValidationError(`"${agentId}" is not a valid agent id.`, {
        hint: 'Use letters, digits, "-", "_" or "." (e.g. claude, reviewer-bot).',
      });
    }
    const name = input.name ? String(input.name).trim() : null;
    if (name && !NAME_RE.test(name)) {
      throw new ValidationError(`"${name}" is not a valid session name.`);
    }

    return transact(db, () => {
      if (name) {
        const existing = find(name, { agentId });
        if (existing) {
          if (input.reuse) return { ...existing, reused: true };
          throw new ConflictError(`Agent "${agentId}" already has a session named "${name}".`, {
            hint: `Resume it with: slick agent resume --name ${name} --agent ${agentId}`,
            details: { key: existing.key, name, agentId },
          });
        }
      }

      const channel = input.channel ? channels.get(input.channel) : null;
      const now = Date.now();
      const key = newHistoryKey();

      // Record the birth of the session first so its own creation event can be
      // the cursor's starting point: a fresh session is exactly caught up and
      // does not immediately owe the agent the whole history of the workspace.
      const birth = recordEvent(db, {
        type: EVENT_TYPES.sessionCreated,
        actor: { id: agentId, kind: 'agent' },
        channelId: channel?.id ?? null,
        sessionKey: key,
        payload: { agentId, name, title: input.title ?? '' },
        now,
      });
      const cursor = input.fromBeginning ? 0 : birth;

      db.prepare(
        `INSERT INTO agent_sessions
           (key, agent_id, name, title, channel_id, cursor_seq, state, status, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(
        key,
        agentId,
        name,
        String(input.title ?? '').trim(),
        channel?.id ?? null,
        cursor,
        JSON.stringify(input.state ?? {}),
        now,
        now,
        now
      );

      return get(key);
    });
  }

  function touch(key: string, patch: Record<string, SQLInputValue> = {}): void {
    const now = Date.now();
    const sets = ['updated_at = ?', 'last_seen_at = ?'];
    const params: SQLInputValue[] = [now, now];
    for (const [column, value] of Object.entries(patch)) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
    params.push(key);
    db.prepare(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE key = ?`).run(...params);
  }

  /** Attach the live message + channel slug so one read gives full context. */
  function hydrateEvent(event: EventRecord): HydratedEvent {
    const enriched: HydratedEvent = { ...event };
    if (event.channelId) {
      const channel = channels.find(event.channelId);
      const snapshot = isRecord(event.payload.channel) ? event.payload.channel : null;
      enriched.channelSlug = channel?.slug ?? (typeof snapshot?.slug === 'string' ? snapshot.slug : null);
    }
    if (event.messageId) {
      const live = messages.find(event.messageId);
      enriched.message = live ?? (event.payload.message as Message | undefined) ?? null;
      // The payload carries a snapshot taken at write time; now that the live
      // row is attached, shipping both just doubles the size of every event.
      if (enriched.payload.message) {
        const { message: _snapshot, ...rest } = enriched.payload;
        enriched.payload = rest;
      }
    }
    return enriched;
  }

  /**
   * A message on its way to another agent, minus the reasoning trace.
   *
   * `hydrateEvent` hands back metadata verbatim, which is right for the
   * browser — `_think` is exactly what the thinking box on a finished message
   * renders from. It is not right for `pull`/`resume`: an agent catching up on
   * a channel would be reading up to 16KB of a neighbour's step-by-step
   * reasoning per reply, in its own context window, for a question it was not
   * asked and cannot act on. `_model` and `_effort` stay — they are a few
   * words each and they say who answered, which is context an agent can use.
   */
  function withoutThink<T extends Message | null | undefined>(message: T): T {
    const metadata = message?.metadata;
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, THINK_KEY)) return message;
    const { [THINK_KEY]: _trace, ...rest } = metadata;
    return { ...message, metadata: rest };
  }

  /** `hydrateEvent` for the agent-facing reads, which is the same thing less that key. */
  function hydrateForAgent(event: EventRecord): HydratedEvent {
    const enriched = hydrateEvent(event);
    return enriched.message ? { ...enriched, message: withoutThink(enriched.message) } : enriched;
  }

  function readOpts(
    session: AgentSession,
    opts: ReadFilterOptions = {}
  ): Pick<ListEventsOptions, 'channelId' | 'types' | 'excludeSessionKey'> {
    const includeOwn = opts.includeOwn ?? false;
    let channelId: string | null = null;
    if (opts.channel) channelId = channels.get(opts.channel).id;
    else if (opts.scope === 'session' && session.channelId) channelId = session.channelId;
    return {
      channelId,
      types: opts.types === null ? null : (opts.types ?? CONVERSATION_EVENTS),
      excludeSessionKey: includeOwn ? null : session.key,
    };
  }

  function pendingCount(session: AgentSession, opts: ReadFilterOptions = {}): number {
    const filters = readOpts(session, opts);
    return countEvents(db, { since: session.cursorSeq, ...filters });
  }

  /**
   * Read new events for a session and (unless `peek`) advance its cursor.
   * This is the loop primitive: call it, handle what comes back, call again.
   *
   * @param ref history key or session name
   */
  function pull(ref: string, opts: PullOptions = {}): PullResult {
    return transact(db, () => {
      const session = get(ref, opts);
      const filters = readOpts(session, opts);
      const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 500);

      const raw = listEvents(db, { since: session.cursorSeq, limit: limit + 1, ...filters });
      const hasMore = raw.length > limit;
      const page = raw.slice(0, limit);
      const nextCursor = page.at(-1)?.seq ?? session.cursorSeq;

      if (!opts.peek && nextCursor !== session.cursorSeq) {
        touch(session.key, { cursor_seq: nextCursor });
      } else {
        touch(session.key);
      }

      const after = opts.peek ? session.cursorSeq : nextCursor;
      return {
        session: { ...get(session.key), cursorSeq: opts.peek ? session.cursorSeq : nextCursor },
        events: page.map(hydrateForAgent),
        previousCursor: session.cursorSeq,
        cursor: after,
        hasMore,
        pending: countEvents(db, { since: after, ...filters }),
      };
    });
  }

  /**
   * Pick up where you left off. Peeks — it never moves the cursor — so an
   * agent can safely call it at the top of every run to re-orient.
   *
   * @param ref history key or session name
   */
  function resume(ref: string, opts: ResumeOptions = {}): ResumeResult {
    return transact(db, () => {
      let session = find(ref, opts);
      // `create` means "make this session if it is missing", which only makes
      // sense for a name. A history key is a specific session that either
      // exists or does not — minting a different key under the same breath
      // would hand back something the caller did not ask for.
      if (!session && opts.create && !looksLikeHistoryKey(ref)) {
        session = start({
          agentId: opts.agentId ?? 'agent',
          name: ref,
          channel: opts.channel,
          title: opts.title,
        });
      }
      if (!session) session = get(ref, opts); // throws with the helpful message

      const filters = readOpts(session, opts);
      const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 500);
      const missed = listEvents(db, { since: session.cursorSeq, limit: limit + 1, ...filters });
      const hasMore = missed.length > limit;

      const contextLimit = Math.min(Math.max(Number(opts.contextLimit ?? 20), 0), 200);
      const channelRef = opts.channel ?? session.channelId;
      let context: Message[] = [];
      const channel = channelRef ? channels.find(channelRef) : null;
      if (channel && contextLimit > 0) {
        context = messages
          .list(channel.id, { limit: contextLimit, includeReplies: true })
          .messages.map((m) => withoutThink(m));
      }

      // `serve` resumes every couple of seconds, and the docs promise resuming
      // is free. Writing a row for a poll that found nothing made an idle
      // watcher the busiest writer in the workspace — 200k rows of "nothing
      // happened". Nothing reads these, so only record an actual catch-up.
      const now = Date.now();
      if (missed.length > 0) {
        db.prepare(
          'UPDATE agent_sessions SET resume_count = resume_count + 1, updated_at = ?, last_seen_at = ? WHERE key = ?'
        ).run(now, now, session.key);
      } else if (now - Number(session.lastSeenAt ?? 0) >= SEEN_HEARTBEAT_MS) {
        // The same promise, for the row itself. A poll that found nothing is
        // not news either, and counting it made `resumed 41000×` mean "up for
        // a day" rather than "caught up forty-one thousand times". What an
        // idle watcher still owes the workspace is a sign of life — and that
        // is a heartbeat, not a write per pass. (Whether it is *watching* is
        // its lock file's answer; this only backs the "last seen" beside it.)
        db.prepare('UPDATE agent_sessions SET last_seen_at = ? WHERE key = ?').run(now, session.key);
      }

      if (missed.length > 0) {
        recordEvent(db, {
          type: EVENT_TYPES.sessionResumed,
          actor: { id: session.agentId, kind: 'agent' },
          channelId: session.channelId,
          sessionKey: session.key,
          payload: { pending: missed.length },
        });
      }

      return {
        session: get(session.key),
        state: session.state,
        cursor: session.cursorSeq,
        channel,
        context,
        missed: missed.slice(0, limit).map(hydrateForAgent),
        hasMore,
        pending: countEvents(db, { since: session.cursorSeq, ...filters }),
      };
    });
  }

  /** Explicitly move the cursor (e.g. "I handled everything up to here"). */
  function ack(
    ref: string,
    seq: number | string | null | undefined,
    opts: SessionReadOptions = {}
  ): AgentSession {
    return transact(db, () => {
      const session = get(ref, opts);
      const target = seq === undefined || seq === null || seq === 'latest' ? maxSeq(db) : Number(seq);
      if (!Number.isFinite(target) || target < 0) {
        throw new ValidationError(`"${seq}" is not a valid cursor position.`);
      }
      touch(session.key, { cursor_seq: target });
      return get(session.key);
    });
  }

  /**
   * The agent's private memory. Anything JSON-serialisable: plans, todo lists,
   * the id of the message it is waiting on. It comes back verbatim on resume.
   */
  function setState(
    ref: string,
    value: unknown,
    opts: SessionReadOptions & { merge?: boolean } = {}
  ): AgentSession {
    return transact(db, () => {
      const session = get(ref, opts);
      if (!isRecord(value)) {
        throw new ValidationError('Session state must be a JSON object.', {
          details: { received: Array.isArray(value) ? 'array' : typeof value },
        });
      }
      const next: SessionState = opts.merge === false ? value : { ...session.state, ...value };
      const changed = stableJson(session.state) !== stableJson(next);
      touch(session.key, { state: JSON.stringify(next) });
      // Re-writing the identical object is what a polling loop does on every
      // pass. That is not a state change and does not belong in the log.
      if (changed) {
        recordEvent(db, {
          type: EVENT_TYPES.sessionUpdated,
          actor: { id: session.agentId, kind: 'agent' },
          sessionKey: session.key,
          payload: { keys: Object.keys(value) },
        });
      }
      return get(session.key);
    });
  }

  /**
   * Choose the model `serve` calls for this session — from the CLI, the app,
   * or anything else that can reach the database. A watcher re-reads it on
   * every pass, so a running one switches without being restarted.
   *
   * @param model  a model name, or null/'' to go back to the default
   */
  function setModel(ref: string, model: unknown, opts: SessionReadOptions = {}): AgentSession {
    if (model !== null && model !== undefined && typeof model !== 'string') {
      throw new ValidationError('A model is a string, or null for the default.', {
        details: { received: typeof model },
      });
    }
    const wanted = (model ?? '').trim();
    // It is spawned as one argv entry, so this is not about injection — a
    // newline or a page of text is simply not a model name, and storing it
    // would only fail later, inside the child, where it is harder to see.
    // eslint-disable-next-line no-control-regex -- the control range is the point
    if (wanted.length > 200 || /[\u0000-\u001f]/.test(wanted)) {
      throw new ValidationError(`"${wanted.slice(0, 40)}…" is not a model name.`, {
        hint: 'Use the name the agent binary expects, e.g. anthropic/claude-sonnet-4.',
      });
    }
    return setState(ref, { [SERVE_MODEL_KEY]: wanted || null }, { ...opts, merge: true });
  }

  /**
   * Choose how hard the agent thinks — the same deal as `setModel`, re-read by
   * a running watcher on every pass.
   *
   * The level is not checked against a list on purpose: `claude` accepts five
   * names and Hermes eight, and a workspace can point an adapter at something
   * with a vocabulary of its own. A level the binary does not know is the
   * binary's complaint to make, in words that fit the binary.
   *
   * @param effort  a level, or null/'' to go back to the default
   */
  function setEffort(ref: string, effort: unknown, opts: SessionReadOptions = {}): AgentSession {
    if (effort !== null && effort !== undefined && typeof effort !== 'string') {
      throw new ValidationError('An effort level is a string, or null for the default.', {
        details: { received: typeof effort },
      });
    }
    const wanted = (effort ?? '').trim();
    // One argv entry and one badge on a message: a level is a short word.
    if (!(wanted === '' || /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(wanted))) {
      throw new ValidationError(`"${wanted.slice(0, 40)}…" is not an effort level.`, {
        hint: 'Use the level the agent expects, e.g. low, medium, high, xhigh, max.',
      });
    }
    return setState(ref, { [SERVE_EFFORT_KEY]: wanted || null }, { ...opts, merge: true });
  }

  /**
   * Record what the agent binary says it can run. Written by `serve` (which
   * is the only thing that knows how to ask it), read by the app so a human
   * picks from a list instead of typing a model name from memory.
   *
   * `null` means "I asked and got no answer": the time is stamped so the next
   * ask waits for the TTL, but any list we already had survives — a provider
   * being briefly unreachable is not a reason to empty the picker. Pass an
   * empty array to actually clear it.
   *
   * @param choices  whatever `<cmd> --list-models` answered, or null
   */
  function setModelChoices(
    ref: string,
    choices: unknown,
    opts: SessionReadOptions & { at?: number } = {}
  ): AgentSession {
    const patch: JsonObject = { [SERVE_MODELS_AT_KEY]: opts.at ?? Date.now() };
    if (choices !== null && choices !== undefined) {
      const normalized = normalizeModelChoices(choices);
      patch[SERVE_MODELS_KEY] = normalized.length > 0 ? normalized : null;
    }
    return setState(ref, patch, { ...opts, merge: true });
  }

  function update(ref: string, patch: SessionPatch, opts: SessionReadOptions = {}): AgentSession {
    return transact(db, () => {
      const session = get(ref, opts);
      const columns: Record<string, SQLInputValue> = {};
      if (patch.title !== undefined) columns.title = String(patch.title ?? '').trim();
      if (patch.name !== undefined) {
        const name = patch.name ? String(patch.name).trim() : null;
        if (name && !NAME_RE.test(name)) throw new ValidationError(`"${name}" is not a valid session name.`);
        if (name) {
          const clash = db
            .prepare('SELECT key FROM agent_sessions WHERE agent_id = ? AND name = ? AND key != ?')
            .get(session.agentId, name, session.key);
          if (clash)
            throw new ConflictError(`Agent "${session.agentId}" already has a session named "${name}".`);
        }
        columns.name = name;
      }
      if (patch.channel !== undefined) {
        columns.channel_id = patch.channel ? channels.get(patch.channel).id : null;
      }
      if (Object.keys(columns).length === 0) return session;
      touch(session.key, columns);
      return get(session.key);
    });
  }

  /**
   * Post as this agent. Stamps the message with the history key so the session
   * can tell its own words apart from everyone else's on the next pull.
   */
  function post(ref: string, input: AgentPostInput): { message: Message; session: AgentSession } {
    return transact(db, () => {
      const session = get(ref, input);
      const channelRef = input.threadId ? undefined : (input.channel ?? session.channelId);
      if (!input.threadId && !channelRef) {
        throw new ValidationError('No channel to post into.', {
          hint: 'Pass a channel, or bind one to the session with `slick agent start --channel`.',
        });
      }
      const message = messages.post({
        channel: channelRef,
        parentId: input.threadId ?? null,
        text: input.text,
        metadata: input.metadata ?? null,
        sessionKey: session.key,
        author: {
          id: session.agentId,
          kind: 'agent',
          label: input.label ?? session.agentId,
        },
      });
      db.prepare(
        'UPDATE agent_sessions SET message_count = message_count + 1, updated_at = ?, last_seen_at = ? WHERE key = ?'
      ).run(Date.now(), Date.now(), session.key);
      return { message, session: get(session.key) };
    });
  }

  /** Reply into a thread as this agent. */
  function reply(ref: string, rootId: string, input: Omit<AgentPostInput, 'threadId'>) {
    return post(ref, { ...input, threadId: rootId });
  }

  /** The latest row an agent wrote about each thread, for one signal type. */
  function latestSignals(type: string, withinMs: number): SignalRow[] {
    // SQLite hands back the row MAX(seq) came from, so each group is the last
    // thing one agent said about one thread. Grouping by the actor as well as
    // the session matters for external rows: their session key is NULL, which
    // SQLite would otherwise collapse into one group per thread — two
    // gateways answering in the same thread would hide each other.
    return rows<SignalRow>(
      db
        .prepare(
          `SELECT MAX(seq) AS seq, session_key, thread_id, channel_id, actor_id, payload, created_at
             FROM events
            WHERE type = ? AND created_at >= ? AND thread_id IS NOT NULL
            GROUP BY session_key, actor_id, thread_id`
        )
        .all(type, Date.now() - withinMs)
    );
  }

  /**
   * Who is typing, right now.
   *
   * `agent.typing` is a *change*, and a tab that opens in the middle of a
   * reply never saw the change — so it shows nothing while an agent works,
   * which looks exactly like an agent that is not working. This is the
   * snapshot a fresh tab, or one coming back from a dropped stream, starts
   * from; the events carry it from there.
   *
   * Two things keep a stale row out of it. The window covers an "on" so old
   * that no reply could still be running, and the lock covers the rest: a
   * watcher killed outright never wrote its "off", but it does not hold its
   * lock any more either, and that is already how the whole workspace decides
   * whether an agent is home.
   *
   * A row with no session key came from outside the workspace — see
   * `externalTyping` — and there is no lock to ask about, so for those the
   * window is the whole answer.
   */
  function typingNow(opts: { withinMs?: number } = {}): TypingEntry[] {
    const withinMs = Math.max(Number(opts.withinMs) || TYPING_WINDOW_MS, 1000);
    const latest = latestSignals(EVENT_TYPES.agentTyping, withinMs);

    const watching = new Map<string, boolean>();
    const out: TypingEntry[] = [];
    for (const record of latest) {
      let on: boolean;
      try {
        const payload: unknown = JSON.parse(record.payload ?? '{}');
        on = isRecord(payload) && Boolean(payload.on);
      } catch {
        on = false; // an unreadable payload is not a reason to claim someone is typing
      }
      if (!on) continue;
      const key = record.session_key;
      if (key) {
        if (!watching.has(key)) watching.set(key, Boolean(readServeLock(key, home)));
        if (!watching.get(key)) continue;
      }
      out.push({
        threadId: record.thread_id,
        channelId: record.channel_id,
        agentId: record.actor_id,
        sessionKey: key ?? null,
        at: Number(record.created_at),
      });
    }
    return out;
  }

  /**
   * An ephemeral "working on it" signal for the UI — not part of the durable
   * conversation, so it never shows up in `pull`/`resume`. The daemon's live
   * stream carries it straight through like any other event.
   */
  function typing(ref: string, input: TypingInput = {}): { ok: true } {
    const session = get(ref, input);
    recordEvent(db, {
      type: EVENT_TYPES.agentTyping,
      actor: { id: session.agentId, kind: 'agent' },
      channelId: input.channelId ?? session.channelId,
      threadId: input.threadId ?? null,
      sessionKey: session.key,
      payload: { on: Boolean(input.on) },
    });
    return { ok: true };
  }

  /**
   * The same signal, from something that is not a session here.
   *
   * A gateway answering in Slick over this API has no history key and holds
   * no `serve` lock — it is another program's process, and Slick has no way
   * to ask whether it is still alive. So its rows carry no session key, and
   * the snapshot trusts them for the length of the window and no longer.
   * That is the honest trade for not being able to check.
   *
   * The thread is resolved rather than believed: the caller hands over a
   * message id and gets its thread, so pointing at a reply lights up the
   * root it belongs to, and the channel comes from the message instead of
   * from whoever asked.
   */
  function externalTyping(input: ExternalTypingInput = {}): { ok: true } {
    const agentId = String(input.agentId ?? '')
      .trim()
      .toLowerCase();
    if (!NAME_RE.test(agentId)) {
      throw new ValidationError(`"${input.agentId ?? ''}" is not a valid agent id.`, {
        hint: 'Use letters, digits, "-", "_" or "." — the name the agent posts under.',
      });
    }
    const threadId = String(input.threadId ?? '').trim();
    const target = threadId ? messages.find(threadId) : null;
    if (!target) {
      throw new NotFoundError(`No message with id "${threadId}".`, {
        hint: 'Typing hangs on a thread, so it needs the id of a message in one.',
        details: { threadId },
      });
    }
    recordEvent(db, {
      type: EVENT_TYPES.agentTyping,
      actor: { id: agentId, kind: 'agent' },
      channelId: target.channelId,
      threadId: target.threadId,
      // No session, so no lock to expire it: see `typingNow`.
      sessionKey: null,
      payload: { on: Boolean(input.on) },
    });
    return { ok: true };
  }

  /**
   * What an agent is thinking about, right now.
   *
   * The same snapshot problem `typingNow` solves, for a richer payload: the
   * blob is a *change* too, and a tab that opens mid-answer never saw it. So
   * this is the same query, the same window and the same lock check — a
   * session-backed row is only believed while its watcher still holds its
   * `serve` lock, and a session-less gateway row is believed for the length
   * of the window and no longer, because there is nothing to ask.
   *
   * One rule is new. A row whose blob has already reached `done` or `error`
   * is left out: that trace belongs to the finished message, where it was
   * written down, and repeating it here would put a second copy of the same
   * reasoning under a reply that is already on screen.
   */
  function thinkingNow(opts: { withinMs?: number } = {}): ThinkingEntry[] {
    const withinMs = Math.max(Number(opts.withinMs) || TYPING_WINDOW_MS, 1000);
    const latest = latestSignals(EVENT_TYPES.agentThinking, withinMs);

    const watching = new Map<string, boolean>();
    const out: ThinkingEntry[] = [];
    for (const record of latest) {
      let think: ThinkingTrace | null;
      try {
        const payload: unknown = JSON.parse(record.payload ?? '{}');
        think = normalizeThinking(isRecord(payload) ? payload.think : null);
      } catch {
        think = null; // an unreadable payload is nothing to show, not an error
      }
      if (!think) continue;
      if (think.p === 'done' || think.p === 'error') continue;
      const key = record.session_key;
      if (key) {
        if (!watching.has(key)) watching.set(key, Boolean(readServeLock(key, home)));
        if (!watching.get(key)) continue;
      }
      out.push({
        threadId: record.thread_id,
        channelId: record.channel_id,
        agentId: record.actor_id,
        sessionKey: key ?? null,
        at: Number(record.created_at),
        think,
      });
    }
    return out;
  }

  /**
   * Has this agent already said exactly this about this thread?
   *
   * The durable tier of the thinking signal exists for one job: `thinkingNow`,
   * the catch-up snapshot a tab takes when it opens mid-answer. What that job
   * needs is the *latest* state per thread, never the history of how it got
   * there — and the producers coalesce on a 120ms timer while a step changes
   * every few seconds, so most flushes repeat the previous one word for word.
   * Each of those repeats carries the whole accumulated blob, into a log that
   * is append-only by design and never pruned, so writing them is a megabyte
   * of permanent record per answered message. Recording only what actually
   * changed brings the row count back to the order of `agent.typing`, which is
   * what this tier was sized for.
   *
   * The comparison is on the serialized payload because that is the byte
   * string the previous row already holds, and both sides are built the same
   * way by `recordEvent`. `ix_events_type` walks seq backwards within
   * `agent.thinking`, and the row being looked for is nearly always the most
   * recent one there, so this stops on its first or second step.
   */
  function thinkingRepeats(what: {
    actorId: string;
    sessionKey: string | null;
    threadId: string | null;
    payload: string;
  }): boolean {
    const last = row<{ payload: string }>(
      db
        .prepare(
          `SELECT payload FROM events
            WHERE type = ? AND actor_id = ? AND session_key IS ? AND thread_id IS ?
            ORDER BY seq DESC LIMIT 1`
        )
        .get(EVENT_TYPES.agentThinking, what.actorId, what.sessionKey, what.threadId)
    );
    return last?.payload === what.payload;
  }

  /**
   * The reasoning trace behind the "working on it", while it is still being
   * worked on. Ephemeral in exactly the way `typing` is — it never joins
   * `CONVERSATION_EVENTS`, so no other agent ever pulls it — and the daemon's
   * live stream carries it straight through.
   *
   * The blob is normalized here rather than trusted, because this is the one
   * place a scratchpad becomes a row in the event log.
   */
  function thinking(ref: string, input: ThinkingInput = {}): { ok: true } {
    const session = get(ref, input);
    const threadId = input.threadId ?? null;
    const payload = { think: normalizeThinking(input.think) };
    // See `thinkingRepeats`: a flush that says what the last one said is not
    // news, and this tier only ever answers "what is it doing *now*".
    const repeat = thinkingRepeats({
      actorId: session.agentId,
      sessionKey: session.key,
      threadId,
      payload: JSON.stringify(payload),
    });
    if (repeat) return { ok: true };
    recordEvent(db, {
      type: EVENT_TYPES.agentThinking,
      actor: { id: session.agentId, kind: 'agent' },
      channelId: input.channelId ?? session.channelId,
      threadId,
      sessionKey: session.key,
      payload,
    });
    return { ok: true };
  }

  /**
   * The same signal from a gateway, which has no session here.
   *
   * Everything `externalTyping` says applies unchanged: no history key, no
   * `serve` lock, nothing Slick can ask about liveness — so the row carries no
   * session key and the snapshot trusts it for the window only. The thread is
   * resolved through the message rather than believed, so a reply id lights up
   * the root it belongs to and the channel comes from the message.
   */
  function externalThinking(input: ExternalThinkingInput = {}): { ok: true } {
    const agentId = String(input.agentId ?? '')
      .trim()
      .toLowerCase();
    if (!NAME_RE.test(agentId)) {
      throw new ValidationError(`"${input.agentId ?? ''}" is not a valid agent id.`, {
        hint: 'Use letters, digits, "-", "_" or "." — the name the agent posts under.',
      });
    }
    const threadId = String(input.threadId ?? '').trim();
    const target = threadId ? messages.find(threadId) : null;
    if (!target) {
      throw new NotFoundError(`No message with id "${threadId}".`, {
        hint: 'Thinking hangs on a thread, so it needs the id of a message in one.',
        details: { threadId },
      });
    }
    const rootId = target.threadId;
    const payload = { think: normalizeThinking(input.think) };
    // The same dedupe as `thinking`, and a gateway needs it more: it has no
    // session, so its rows are keyed on the agent name alone and a chatty
    // producer is otherwise the busiest writer in the workspace.
    const repeat = thinkingRepeats({
      actorId: agentId,
      sessionKey: null,
      threadId: rootId,
      payload: JSON.stringify(payload),
    });
    if (repeat) return { ok: true };
    recordEvent(db, {
      type: EVENT_TYPES.agentThinking,
      actor: { id: agentId, kind: 'agent' },
      channelId: target.channelId,
      threadId: rootId,
      // No session, so no lock to expire it: see `thinkingNow`.
      sessionKey: null,
      payload,
    });
    return { ok: true };
  }

  function end(ref: string, opts: SessionReadOptions = {}): AgentSession {
    return transact(db, () => {
      const session = get(ref, opts);
      touch(session.key, { status: 'ended' });
      recordEvent(db, {
        type: EVENT_TYPES.sessionEnded,
        actor: { id: session.agentId, kind: 'agent' },
        sessionKey: session.key,
        payload: { messageCount: session.messageCount },
      });
      return get(session.key);
    });
  }

  function remove(ref: string, opts: SessionReadOptions = {}): AgentSession & { deleted: true } {
    const session = get(ref, opts);
    db.prepare('DELETE FROM agent_sessions WHERE key = ?').run(session.key);
    return { ...session, deleted: true };
  }

  return {
    find,
    get,
    list,
    start,
    resume,
    pull,
    ack,
    setState,
    setModel,
    setEffort,
    setModelChoices,
    update,
    post,
    reply,
    typing,
    externalTyping,
    typingNow,
    thinking,
    externalThinking,
    thinkingNow,
    end,
    remove,
    pendingCount,
    hydrateEvent,
    serialize,
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
