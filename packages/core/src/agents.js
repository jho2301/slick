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

import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { newHistoryKey, looksLikeHistoryKey } from './ids.js';
import { row, rows, transact } from './db.js';
import {
  CONVERSATION_EVENTS,
  EVENT_TYPES,
  countEvents,
  listEvents,
  maxSeq,
  recordEvent,
} from './events.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseState(value) {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createAgentService(ctx) {
  const { db, channels, messages } = ctx;

  function serialize(record) {
    const s = row(record);
    if (!s) return null;
    return {
      key: s.key,
      agentId: s.agent_id,
      name: s.name,
      title: s.title,
      channelId: s.channel_id,
      channelSlug: s.channel_slug ?? null,
      cursorSeq: Number(s.cursor_seq),
      state: parseState(s.state),
      status: s.status,
      messageCount: Number(s.message_count),
      resumeCount: Number(s.resume_count),
      createdAt: Number(s.created_at),
      updatedAt: Number(s.updated_at),
      lastSeenAt: s.last_seen_at == null ? null : Number(s.last_seen_at),
    };
  }

  const SELECT_SESSION = `SELECT s.*, c.slug AS channel_slug
                            FROM agent_sessions s
                            LEFT JOIN channels c ON c.id = s.channel_id`;

  /**
   * Look a session up by history key, or by `name` scoped to an agent.
   * @param {string} ref
   * @param {{agentId?: string}} [opts]
   */
  function find(ref, opts = {}) {
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

  function get(ref, opts = {}) {
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

  /** @param {{agentId?: string, includeEnded?: boolean, limit?: number}} [opts] */
  function list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.agentId) {
      where.push('s.agent_id = ?');
      params.push(opts.agentId);
    }
    if (!opts.includeEnded) where.push("s.status = 'active'");
    const sql = `${SELECT_SESSION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY s.updated_at DESC LIMIT ?`;
    return rows(db.prepare(sql).all(...params, Math.min(Number(opts.limit ?? 100), 500))).map(serialize);
  }

  /**
   * Mint a new history key.
   * @param {{agentId?: string, name?: string|null, title?: string,
   *          channel?: string|null, state?: Record<string, unknown>,
   *          fromBeginning?: boolean, reuse?: boolean}} [input]
   */
  function start(input = {}) {
    const agentId = String(input.agentId ?? 'agent').trim().toLowerCase();
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

  function touch(key, patch = {}) {
    const now = Date.now();
    const sets = ['updated_at = ?', 'last_seen_at = ?'];
    const params = [now, now];
    for (const [column, value] of Object.entries(patch)) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
    params.push(key);
    db.prepare(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE key = ?`).run(...params);
  }

  /** Attach the live message + channel slug so one read gives full context. */
  function hydrateEvent(event) {
    const enriched = { ...event };
    if (event.channelId) {
      const channel = channels.find(event.channelId);
      enriched.channelSlug = channel?.slug ?? event.payload?.channel?.slug ?? null;
    }
    if (event.messageId) {
      const live = messages.find(event.messageId);
      enriched.message = live ?? event.payload?.message ?? null;
      // The payload carries a snapshot taken at write time; now that the live
      // row is attached, shipping both just doubles the size of every event.
      if (enriched.payload?.message) {
        const { message: _snapshot, ...rest } = enriched.payload;
        enriched.payload = rest;
      }
    }
    return enriched;
  }

  function readOpts(session, opts = {}) {
    const includeOwn = opts.includeOwn ?? false;
    let channelId = null;
    if (opts.channel) channelId = channels.get(opts.channel).id;
    else if (opts.scope === 'session' && session.channelId) channelId = session.channelId;
    return {
      channelId,
      types: opts.types === null ? null : (opts.types ?? CONVERSATION_EVENTS),
      excludeSessionKey: includeOwn ? null : session.key,
    };
  }

  function pendingCount(session, opts = {}) {
    const filters = readOpts(session, opts);
    return countEvents(db, { since: session.cursorSeq, ...filters });
  }

  /**
   * Read new events for a session and (unless `peek`) advance its cursor.
   * This is the loop primitive: call it, handle what comes back, call again.
   *
   * @param {string} ref history key or session name
   * @param {{limit?: number, peek?: boolean, includeOwn?: boolean, channel?: string,
   *          scope?: 'workspace'|'session', types?: readonly string[]|null,
   *          agentId?: string}} [opts]
   */
  function pull(ref, opts = {}) {
    return transact(db, () => {
      const session = get(ref, opts);
      const filters = readOpts(session, opts);
      const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 500);

      const raw = listEvents(db, { since: session.cursorSeq, limit: limit + 1, ...filters });
      const hasMore = raw.length > limit;
      const page = raw.slice(0, limit);
      const nextCursor = page.length ? page[page.length - 1].seq : session.cursorSeq;

      if (!opts.peek && nextCursor !== session.cursorSeq) {
        touch(session.key, { cursor_seq: nextCursor });
      } else {
        touch(session.key);
      }

      const after = opts.peek ? session.cursorSeq : nextCursor;
      return {
        session: { ...get(session.key), cursorSeq: opts.peek ? session.cursorSeq : nextCursor },
        events: page.map(hydrateEvent),
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
   * @param {string} ref history key or session name
   * @param {{limit?: number, contextLimit?: number, channel?: string,
   *          includeOwn?: boolean, agentId?: string, create?: boolean,
   *          scope?: 'workspace'|'session'}} [opts]
   */
  function resume(ref, opts = {}) {
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
      if (!session) return get(ref, opts); // throws with the helpful message

      const filters = readOpts(session, opts);
      const limit = Math.min(Math.max(Number(opts.limit ?? 50), 1), 500);
      const missed = listEvents(db, { since: session.cursorSeq, limit: limit + 1, ...filters });
      const hasMore = missed.length > limit;

      const contextLimit = Math.min(Math.max(Number(opts.contextLimit ?? 20), 0), 200);
      const channelRef = opts.channel ?? session.channelId;
      let context = [];
      const channel = channelRef ? channels.find(channelRef) : null;
      if (channel && contextLimit > 0) {
        context = messages.list(channel.id, { limit: contextLimit, includeReplies: true }).messages;
      }

      db.prepare(
        'UPDATE agent_sessions SET resume_count = resume_count + 1, updated_at = ?, last_seen_at = ? WHERE key = ?'
      ).run(Date.now(), Date.now(), session.key);

      recordEvent(db, {
        type: EVENT_TYPES.sessionResumed,
        actor: { id: session.agentId, kind: 'agent' },
        channelId: session.channelId,
        sessionKey: session.key,
        payload: { pending: missed.length },
      });

      return {
        session: get(session.key),
        state: session.state,
        cursor: session.cursorSeq,
        channel,
        context,
        missed: missed.slice(0, limit).map(hydrateEvent),
        hasMore,
        pending: countEvents(db, { since: session.cursorSeq, ...filters }),
      };
    });
  }

  /** Explicitly move the cursor (e.g. "I handled everything up to here"). */
  function ack(ref, seq, opts = {}) {
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
   * @param {string} ref
   * @param {Record<string, unknown>} value
   * @param {{merge?: boolean, agentId?: string}} [opts]
   */
  function setState(ref, value, opts = {}) {
    return transact(db, () => {
      const session = get(ref, opts);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('Session state must be a JSON object.', {
          details: { received: Array.isArray(value) ? 'array' : typeof value },
        });
      }
      const next = opts.merge === false ? value : { ...session.state, ...value };
      touch(session.key, { state: JSON.stringify(next) });
      recordEvent(db, {
        type: EVENT_TYPES.sessionUpdated,
        actor: { id: session.agentId, kind: 'agent' },
        sessionKey: session.key,
        payload: { keys: Object.keys(value) },
      });
      return get(session.key);
    });
  }

  function update(ref, patch, opts = {}) {
    return transact(db, () => {
      const session = get(ref, opts);
      const columns = {};
      if (patch.title !== undefined) columns.title = String(patch.title ?? '').trim();
      if (patch.name !== undefined) {
        const name = patch.name ? String(patch.name).trim() : null;
        if (name && !NAME_RE.test(name)) throw new ValidationError(`"${name}" is not a valid session name.`);
        if (name) {
          const clash = db
            .prepare('SELECT key FROM agent_sessions WHERE agent_id = ? AND name = ? AND key != ?')
            .get(session.agentId, name, session.key);
          if (clash) throw new ConflictError(`Agent "${session.agentId}" already has a session named "${name}".`);
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
   * @param {string} ref
   * @param {{channel?: string, text: string, threadId?: string|null,
   *          metadata?: Record<string, unknown>|null, label?: string, agentId?: string}} input
   */
  function post(ref, input) {
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
  function reply(ref, rootId, input) {
    return post(ref, { ...input, threadId: rootId });
  }

  function end(ref, opts = {}) {
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

  function remove(ref, opts = {}) {
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
    update,
    post,
    reply,
    end,
    remove,
    pendingCount,
    hydrateEvent,
    serialize,
  };
}
