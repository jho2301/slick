/**
 * The REST surface.
 *
 * Every handler is a thin translation from HTTP to a `Workspace` call — all
 * of the actual rules live in @slick/core, so the CLI (which calls the core
 * directly) and the desktop app (which calls it through here) can never drift
 * apart.
 */

import {
  SERVE_MODELS_AT_KEY,
  ValidationError,
  normalizeThinking,
  readServeEffort,
  readServeModel,
  readServeModelChoices,
} from '@slick/core';

import { listCommands, runCommand } from './commands.js';
import { createRouter, query } from './http.js';

/** Returned by handlers that wrote the response themselves. */
export const RAW = Symbol('raw');

const CREATED = (body) => ({ status: 201, body });

/**
 * The shape @slick/core accepts for an agent id. It is not exported from
 * there, and the delta route needs it: that route never reaches the core, so
 * this is the only place the name is ever checked.
 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * How much answer-so-far one delta may carry.
 *
 * Every other blob in the app is normalized on the way in and has a cap behind
 * it; a delta had neither, and it is the only body that is copied straight onto
 * every open socket at once, so it is the one that could least afford to go
 * without. A fragment is a fragment — the watcher coalesces at 400 characters
 * — so this is roomy by an order of magnitude and still nowhere near the 4MB a
 * request body is otherwise allowed.
 */
const MAX_DELTA_TEXT = 4096;

export function createRoutes({ ws, hub, push, version, build }) {
  const router = createRouter();
  const r = router.add;

  // --------------------------------------------------------- workspace ---

  r('GET /api/health', () => ({
    ok: true,
    version,
    // Which build of the UI this daemon is serving right now. `version` is
    // hand-written and answers a different question — see `buildStamp`.
    build: build?.() ?? null,
    seq: ws.seq(),
    pid: process.pid,
    workspace: ws.getMeta('workspace.name', 'Slick'),
    db: ws.file,
  }));

  r('GET /api/workspace', () => ws.info());

  r('PATCH /api/workspace', ({ body }) => {
    if (body.user) ws.setUser(body.user);
    if (body.name) ws.setMeta('workspace.name', body.name);
    return ws.info();
  });

  // ---------------------------------------------------------- channels ---

  r('GET /api/channels', ({ q }) => ({
    channels: ws.channels.list({
      includeArchived: q.bool('includeArchived'),
      category: q.raw.has('category') ? q.get('category') : undefined,
    }),
  }));

  r('POST /api/channels', ({ body }) => CREATED({ channel: ws.channels.create(body) }));

  r('GET /api/channels/:ref', ({ params }) => ({ channel: ws.channels.get(params.ref) }));

  r('PATCH /api/channels/:ref', ({ params, body }) => ({
    channel: ws.channels.update(params.ref, body),
  }));

  r('DELETE /api/channels/:ref', ({ params, q }) => ({
    channel: ws.channels.remove(params.ref, { force: q.bool('force') }),
  }));

  r('POST /api/channels/:ref/archive', ({ params }) => ({ channel: ws.channels.archive(params.ref) }));

  r('POST /api/channels/:ref/unarchive', ({ params }) => ({ channel: ws.channels.unarchive(params.ref) }));

  r('GET /api/channels/:ref/messages', ({ params, q }) =>
    ws.messages.list(params.ref, {
      limit: q.int('limit'),
      before: q.get('before'),
      after: q.get('after'),
      includeDeleted: q.bool('includeDeleted'),
      includeReplies: q.bool('includeReplies'),
    })
  );

  r('POST /api/channels/:ref/messages', ({ params, body }) =>
    CREATED({ message: ws.messages.post({ ...body, channel: params.ref }) })
  );

  // -------------------------------------------------------- categories ---

  r('GET /api/categories', () => ({ categories: ws.categories.list() }));

  r('POST /api/categories', ({ body }) => CREATED({ category: ws.categories.create(body) }));

  // Declared before `:ref` so "reorder" is never read as a category name.
  r('POST /api/categories/reorder', ({ body }) => ({
    categories: ws.categories.reorder(body.order ?? body.categories ?? []),
  }));

  r('GET /api/categories/:ref', ({ params }) => ({ category: ws.categories.get(params.ref) }));

  r('PATCH /api/categories/:ref', ({ params, body }) => ({
    category: ws.categories.update(params.ref, body),
  }));

  r('DELETE /api/categories/:ref', ({ params }) => ({ category: ws.categories.remove(params.ref) }));

  r('GET /api/categories/:ref/channels', ({ params, q }) => ({
    channels: ws.channels.list({ category: params.ref, includeArchived: q.bool('includeArchived') }),
  }));

  // ---------------------------------------------------------- messages ---

  r('GET /api/messages/:id', ({ params }) => ({ message: ws.messages.get(params.id) }));

  r('PATCH /api/messages/:id', ({ params, body }) => ({
    message: ws.messages.update(params.id, body),
  }));

  r('DELETE /api/messages/:id', ({ params, q }) => ({
    message: ws.messages.remove(params.id, { hard: q.bool('hard') }),
  }));

  r('GET /api/messages/:id/thread', ({ params }) => ws.messages.thread(params.id));

  r('POST /api/messages/:id/replies', ({ params, body }) =>
    CREATED({ message: ws.messages.reply(params.id, body) })
  );

  // ------------------------------------------------------------ search ---

  r('GET /api/search', ({ q }) =>
    ws.search(q.get('q', ''), {
      channel: q.get('channel'),
      author: q.get('author'),
      kind: q.get('kind'),
      limit: q.int('limit'),
    })
  );

  // ------------------------------------------------------------ events ---

  r('GET /api/events', ({ q }) => ({
    seq: ws.seq(),
    events: ws.hydratedEvents({
      since: q.int('since', 0),
      limit: q.int('limit'),
      channelId: q.get('channel') ? ws.channels.get(q.get('channel')).id : null,
    }),
  }));

  r('GET /api/stream', ({ req, res, q }) => {
    hub.subscribe(req, res, {
      since: q.raw.has('since') ? q.int('since') : null,
      channelId: q.get('channel') ? ws.channels.get(q.get('channel')).id : null,
    });
    return RAW;
  });

  // ------------------------------------------------------------ agents ---

  r('GET /api/agents/sessions', ({ q }) => ({
    sessions: ws.agents.list({
      agentId: q.get('agent'),
      includeEnded: q.bool('includeEnded'),
      limit: q.int('limit'),
    }),
  }));

  r('POST /api/agents/sessions', ({ body }) => CREATED({ session: ws.agents.start(body) }));

  r('GET /api/agents/sessions/:ref', ({ params, q }) => ({
    session: ws.agents.get(params.ref, { agentId: q.get('agent') }),
    pending: ws.agents.pendingCount(ws.agents.get(params.ref, { agentId: q.get('agent') })),
  }));

  r('PATCH /api/agents/sessions/:ref', ({ params, body }) => ({
    session: ws.agents.update(params.ref, body, { agentId: body.agent }),
  }));

  r('DELETE /api/agents/sessions/:ref', ({ params }) => ({ session: ws.agents.remove(params.ref) }));

  r('POST /api/agents/sessions/:ref/resume', ({ params, body }) =>
    ws.agents.resume(params.ref, body)
  );

  r('POST /api/agents/sessions/:ref/pull', ({ params, body }) => ws.agents.pull(params.ref, body));

  r('POST /api/agents/sessions/:ref/ack', ({ params, body }) => ({
    session: ws.agents.ack(params.ref, body.seq),
  }));

  r('PUT /api/agents/sessions/:ref/state', ({ params, body }) => ({
    session: ws.agents.setState(params.ref, body.state ?? {}, { merge: body.merge !== false }),
  }));

  // Which model `slick agent serve` calls for this session. A running watcher
  // re-reads it every pass, so this changes the answer without restarting it.
  r('GET /api/agents/sessions/:ref/model', ({ params, q }) => {
    const { state } = ws.agents.get(params.ref, { agentId: q.get('agent') });
    return {
      model: readServeModel(state),
      // What the agent binary last told `serve` it can run, so a human picks
      // from a list instead of remembering model names.
      choices: readServeModelChoices(state),
      checkedAt: Number(state?.[SERVE_MODELS_AT_KEY]) || null,
    };
  });

  r('PUT /api/agents/sessions/:ref/model', ({ params, body }) => {
    const session = ws.agents.setModel(params.ref, body.model ?? null, { agentId: body.agent });
    return { model: readServeModel(session.state), session };
  });

  // How hard it thinks. No choices list beside it: the levels belong to the
  // agent's own vocabulary, so Slick stores a word rather than a menu.
  r('GET /api/agents/sessions/:ref/effort', ({ params, q }) => {
    const { state } = ws.agents.get(params.ref, { agentId: q.get('agent') });
    return { effort: readServeEffort(state) };
  });

  r('PUT /api/agents/sessions/:ref/effort', ({ params, body }) => {
    const session = ws.agents.setEffort(params.ref, body.effort ?? null, { agentId: body.agent });
    return { effort: readServeEffort(session.state), session };
  });

  r('POST /api/agents/sessions/:ref/messages', ({ params, body }) =>
    CREATED(ws.agents.post(params.ref, body))
  );

  r('POST /api/agents/sessions/:ref/typing', ({ params, body }) => ws.agents.typing(params.ref, body));

  // Who is typing *now*. The stream carries changes, and a tab that opened
  // mid-reply missed the one that mattered, so it asks.
  r('GET /api/typing', () => ({ typing: ws.agents.typingNow() }));

  // The same signal from something that is not a session here — a gateway
  // answering over this API rather than through `slick agent serve`. It has
  // no history key to name and no lock to hold, so the snapshot believes it
  // only for as long as its window.
  r('POST /api/typing', ({ body }) => ws.agents.externalTyping(body ?? {}));

  // Thinking is typing with a shape to it: the same live signal, carrying the
  // steps the agent is working through rather than a bare on/off. It is a
  // durable event like typing, and like typing it is missing from
  // `CONVERSATION_EVENTS`, so one agent's scratchpad never turns up in
  // another agent's `pull`.
  r('POST /api/agents/sessions/:ref/thinking', ({ params, body }) => ws.agents.thinking(params.ref, body));

  // And the same reason for a snapshot: a tab that opened halfway through a
  // long answer saw none of the steps go by.
  r('GET /api/thinking', () => ({ thinking: ws.agents.thinkingNow() }));

  r('POST /api/thinking', ({ body }) => ws.agents.externalThinking(body ?? {}));

  // The one route in the app that writes nothing down.
  //
  // A delta is a fragment of an answer that does not exist yet. The next one
  // replaces it a hundred milliseconds later, and the finished message
  // replaces them all a few seconds after that — so a row per fragment would
  // be a permanent record of text that was already stale when it was written.
  // It goes straight to whoever has a stream open and nowhere else. A tab that
  // was not open for it has missed nothing: the message it was a preview of
  // arrives through the log like every other message.
  r('POST /api/stream/delta', ({ body }) => {
    const agentId = String(body?.agentId ?? '').trim().toLowerCase();
    if (!AGENT_ID_RE.test(agentId)) {
      throw new ValidationError(`"${body?.agentId ?? ''}" is not a valid agent id.`, {
        hint: 'Use letters, digits, "-", "_" or "." — the name the agent posts under.',
      });
    }
    // Resolved rather than believed, exactly as `externalTyping` does it: an
    // id that names nothing is a 404 the caller can act on, and the channel
    // comes from the message instead of from whoever asked, so nobody can
    // aim a preview at a channel they were never in.
    const { threadId, text, think, done } = body ?? {};
    const target = ws.messages.get(String(threadId ?? '').trim());
    if (text != null && typeof text !== 'string') {
      throw new ValidationError('A delta\u2019s "text" is a piece of the answer, so it has to be a string.');
    }
    if (typeof text === 'string' && text.length > MAX_DELTA_TEXT) {
      // Refused rather than trimmed. Truncating would put a fragment on screen
      // that the producer believes it sent whole, and the producer is the only
      // party that can fix its own chunking — so it is the one that gets told.
      throw new ValidationError(`A delta is a fragment: "text" is capped at ${MAX_DELTA_TEXT} characters.`, {
        hint: 'Flush more often, or post the finished answer as a message.',
        details: { length: text.length, max: MAX_DELTA_TEXT },
      });
    }
    const frame = {
      type: 'agent.delta',
      // The root the message belongs to, not the id the caller happened to
      // name, because `externalThinking` resolves the same way — a producer
      // answering a reply would otherwise leave a draft under the reply id and
      // a thinking blob under the root, and the browser would clear one of
      // them and hold the other open forever.
      threadId: target.threadId ?? target.id,
      channelId: target.channelId,
      actor: { id: agentId, kind: 'agent' },
      text,
      // The same normalizer `POST /api/thinking` runs, for the same reason:
      // this blob is about to be copied onto every open socket, and the caps
      // in `normalizeThinking` are the only thing that bounds it.
      think: normalizeThinking(think),
      done: Boolean(done),
      at: Date.now(),
    };
    hub.broadcast(frame, { channelId: target.channelId });
    return { ok: true };
  });

  // The agent's own slash commands. Slick keeps no vocabulary of its own: it
  // asks the adapter what there is, and runs one when a human picks it. The
  // output goes back in this response and nowhere else — no message, no event,
  // nothing in the log, because it is one person's answer to one question.
  r('GET /api/agents/sessions/:ref/commands', ({ params, q }) =>
    listCommands(ws, params.ref, { force: q.bool('refresh') })
  );

  r('POST /api/agents/sessions/:ref/command', ({ params, body }) =>
    runCommand(ws, params.ref, { command: body.command, args: body.args })
  );

  r('POST /api/agents/sessions/:ref/end', ({ params }) => ({ session: ws.agents.end(params.ref) }));

  // -------------------------------------------------------------- push ---

  r('GET /api/push/vapid-public-key', () => ({ publicKey: push.publicKey }));

  r('POST /api/push/subscribe', ({ body }) => push.subscribe(body));

  r('POST /api/push/unsubscribe', ({ body }) => push.unsubscribe(body.endpoint));

  return router;
}

export { query };
