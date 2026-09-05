/**
 * The REST surface.
 *
 * Every handler is a thin translation from HTTP to a `Workspace` call — all
 * of the actual rules live in @slick/core, so the CLI (which calls the core
 * directly) and the desktop app (which calls it through here) can never drift
 * apart.
 *
 * A request body is JSON someone sent; the casts on the way into the core are
 * the boundary where it becomes a typed input. The core validates the fields
 * it reads and ignores the rest, which is exactly what it did when the body
 * was untyped — the cast names the shape, it does not vouch for it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  SERVE_MODELS_AT_KEY,
  ValidationError,
  normalizeThinking,
  readServeEffort,
  readServeModel,
  readServeModelChoices,
  type AgentPostInput,
  type CategoryInput,
  type CategoryPatch,
  type ChannelInput,
  type ChannelPatch,
  type ExternalThinkingInput,
  type ExternalTypingInput,
  type JsonObject,
  type MessagePatch,
  type PostMessageInput,
  type PullOptions,
  type ResumeOptions,
  type SessionPatch,
  type StartSessionInput,
  type ThinkingInput,
  type TypingInput,
  type Workspace,
} from '@slick/core';

import { listCommands, runCommand } from '../integrations/commands.ts';
import {
  hermesRoot,
  listProfiles,
  readProfileModel,
  readProfileUsage,
  writeProfileModel,
  type Env,
} from '../integrations/hermes/hermes.ts';
import { createRouter, query, type Query } from './http.ts';
import type { Hub } from '../realtime/hub.ts';
import type { PushService } from '../realtime/push.ts';

/** Returned by handlers that wrote the response themselves. */
export const RAW = Symbol('raw');

/** A handler's answer: JSON to send as 200, a status with a body, or RAW. */
export type RouteResult = unknown;

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  q: Query;
  body: JsonObject;
  url: URL;
  ws: Workspace;
  hub: Hub;
}

export type RouteHandler = (ctx: RouteContext) => RouteResult;

const CREATED = (body: unknown) => ({ status: 201, body });

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

/**
 * A thinking level as it may arrive from a browser — one short word.
 *
 * The same shape `setEffort` in @slick/core accepts and `EFFORT_VALUE` in the
 * bridge enforces, checked a third time here for a different job: the bridge
 * is what must never write rubbish into a config file, and this is what turns
 * "high\nagent: {}" into a 422 with a sentence rather than a JSON `ok: false`
 * the panel would have to read as a save that quietly did nothing.
 */
const EFFORT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

/**
 * What a model write is asking about `agent.reasoning_effort`, tri-state.
 *
 * `undefined` when the body says nothing — the picker saving a provider and a
 * model has no opinion on the level and must not clear one someone else set.
 * `null` when the body says `null` — also no change, for a caller that spells
 * "no opinion" out. `''` when the body says `''` — clear the setting, back to
 * whatever Hermes defaults to. A level otherwise.
 */
function hermesEffort(body: JsonObject): string | null | undefined {
  if (!Object.hasOwn(body, 'effort')) return undefined;
  const wanted = body.effort;
  if (wanted === null) return null;
  if (typeof wanted !== 'string') {
    throw new ValidationError('A thinking level is a word, or null to leave it to Hermes.', {
      details: { received: typeof wanted },
    });
  }
  const level = wanted.trim();
  if (!level) return '';
  if (!EFFORT_RE.test(level)) {
    throw new ValidationError(`"${level.slice(0, 40)}" is not a thinking level.`, {
      hint: 'Use one of the levels Hermes offers — minimal, low, medium, high, xhigh, max, ultra — or none to turn it off.',
    });
  }
  return level;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The JSON someone sent, as the input the core reads it as. See the header. */
const asInput = <T>(body: JsonObject): T => body as unknown as T;

export interface RoutesOptions {
  ws: Workspace;
  hub: Hub;
  push: PushService;
  version: string;
  build?: () => string | null;
  hermesEnv?: Env;
}

export function createRoutes({ ws, hub, push, version, build, hermesEnv = process.env }: RoutesOptions) {
  const router = createRouter<RouteHandler>();
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
    if (typeof body.name === 'string' && body.name) ws.setMeta('workspace.name', body.name);
    return ws.info();
  });

  // ---------------------------------------------------------- channels ---

  r('GET /api/channels', ({ q }) => ({
    channels: ws.channels.list({
      includeArchived: q.bool('includeArchived'),
      category: q.raw.has('category') ? q.get('category') : undefined,
    }),
  }));

  r('POST /api/channels', ({ body }) =>
    CREATED({ channel: ws.channels.create(asInput<ChannelInput>(body)) })
  );

  r('GET /api/channels/:ref', ({ params }) => ({ channel: ws.channels.get(params.ref) }));

  r('PATCH /api/channels/:ref', ({ params, body }) => ({
    channel: ws.channels.update(params.ref ?? '', asInput<ChannelPatch>(body)),
  }));

  r('DELETE /api/channels/:ref', ({ params, q }) => ({
    channel: ws.channels.remove(params.ref ?? '', { force: q.bool('force') }),
  }));

  r('POST /api/channels/:ref/archive', ({ params }) => ({ channel: ws.channels.archive(params.ref ?? '') }));

  r('POST /api/channels/:ref/unarchive', ({ params }) => ({
    channel: ws.channels.unarchive(params.ref ?? ''),
  }));

  r('GET /api/channels/:ref/messages', ({ params, q }) =>
    ws.messages.list(params.ref ?? '', {
      limit: q.int('limit'),
      before: q.get('before'),
      after: q.get('after'),
      includeDeleted: q.bool('includeDeleted'),
      includeReplies: q.bool('includeReplies'),
    })
  );

  r('POST /api/channels/:ref/messages', ({ params, body }) =>
    CREATED({ message: ws.messages.post({ ...asInput<PostMessageInput>(body), channel: params.ref }) })
  );

  // -------------------------------------------------------- categories ---

  r('GET /api/categories', () => ({ categories: ws.categories.list() }));

  r('POST /api/categories', ({ body }) =>
    CREATED({ category: ws.categories.create(asInput<CategoryInput>(body)) })
  );

  // Declared before `:ref` so "reorder" is never read as a category name.
  r('POST /api/categories/reorder', ({ body }) => ({
    categories: ws.categories.reorder((body.order ?? body.categories ?? []) as string[]),
  }));

  r('GET /api/categories/:ref', ({ params }) => ({ category: ws.categories.get(params.ref) }));

  r('PATCH /api/categories/:ref', ({ params, body }) => ({
    category: ws.categories.update(params.ref ?? '', asInput<CategoryPatch>(body)),
  }));

  r('DELETE /api/categories/:ref', ({ params }) => ({ category: ws.categories.remove(params.ref ?? '') }));

  r('GET /api/categories/:ref/channels', ({ params, q }) => ({
    channels: ws.channels.list({ category: params.ref, includeArchived: q.bool('includeArchived') }),
  }));

  // ---------------------------------------------------------- messages ---

  r('GET /api/messages/:id', ({ params }) => ({ message: ws.messages.get(params.id) }));

  r('PATCH /api/messages/:id', ({ params, body }) => ({
    message: ws.messages.update(params.id ?? '', asInput<MessagePatch>(body)),
  }));

  r('DELETE /api/messages/:id', ({ params, q }) => ({
    message: ws.messages.remove(params.id ?? '', { hard: q.bool('hard') }),
  }));

  r('GET /api/messages/:id/thread', ({ params }) => ws.messages.thread(params.id ?? ''));

  r('POST /api/messages/:id/replies', ({ params, body }) =>
    CREATED({ message: ws.messages.reply(params.id ?? '', asInput<PostMessageInput>(body)) })
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

  r('POST /api/agents/sessions', ({ body }) =>
    CREATED({ session: ws.agents.start(asInput<StartSessionInput>(body)) })
  );

  r('GET /api/agents/sessions/:ref', ({ params, q }) => ({
    session: ws.agents.get(params.ref, { agentId: q.get('agent') }),
    pending: ws.agents.pendingCount(ws.agents.get(params.ref, { agentId: q.get('agent') })),
  }));

  r('PATCH /api/agents/sessions/:ref', ({ params, body }) => ({
    session: ws.agents.update(params.ref ?? '', asInput<SessionPatch>(body), {
      agentId: asString(body.agent),
    }),
  }));

  r('DELETE /api/agents/sessions/:ref', ({ params }) => ({ session: ws.agents.remove(params.ref ?? '') }));

  r('POST /api/agents/sessions/:ref/resume', ({ params, body }) =>
    ws.agents.resume(params.ref ?? '', asInput<ResumeOptions>(body))
  );

  r('POST /api/agents/sessions/:ref/pull', ({ params, body }) =>
    ws.agents.pull(params.ref ?? '', asInput<PullOptions>(body))
  );

  r('POST /api/agents/sessions/:ref/ack', ({ params, body }) => ({
    session: ws.agents.ack(params.ref ?? '', body.seq as number | string | null | undefined),
  }));

  r('PUT /api/agents/sessions/:ref/state', ({ params, body }) => ({
    session: ws.agents.setState(params.ref ?? '', body.state ?? {}, { merge: body.merge !== false }),
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
      checkedAt: Number(state[SERVE_MODELS_AT_KEY]) || null,
    };
  });

  r('PUT /api/agents/sessions/:ref/model', ({ params, body }) => {
    const session = ws.agents.setModel(params.ref ?? '', body.model ?? null, {
      agentId: asString(body.agent),
    });
    return { model: readServeModel(session.state), session };
  });

  // How hard it thinks. No choices list beside it: the levels belong to the
  // agent's own vocabulary, so Slick stores a word rather than a menu.
  r('GET /api/agents/sessions/:ref/effort', ({ params, q }) => {
    const { state } = ws.agents.get(params.ref, { agentId: q.get('agent') });
    return { effort: readServeEffort(state) };
  });

  r('PUT /api/agents/sessions/:ref/effort', ({ params, body }) => {
    const session = ws.agents.setEffort(params.ref ?? '', body.effort ?? null, {
      agentId: asString(body.agent),
    });
    return { effort: readServeEffort(session.state), session };
  });

  r('POST /api/agents/sessions/:ref/messages', ({ params, body }) =>
    CREATED(ws.agents.post(params.ref ?? '', asInput<AgentPostInput>(body)))
  );

  r('POST /api/agents/sessions/:ref/typing', ({ params, body }) =>
    ws.agents.typing(params.ref ?? '', asInput<TypingInput>(body))
  );

  // Who is typing *now*. The stream carries changes, and a tab that opened
  // mid-reply missed the one that mattered, so it asks.
  r('GET /api/typing', () => ({ typing: ws.agents.typingNow() }));

  // The same signal from something that is not a session here — a gateway
  // answering over this API rather than through `slick agent serve`. It has
  // no history key to name and no lock to hold, so the snapshot believes it
  // only for as long as its window.
  r('POST /api/typing', ({ body }) => ws.agents.externalTyping(asInput<ExternalTypingInput>(body)));

  // Thinking is typing with a shape to it: the same live signal, carrying the
  // steps the agent is working through rather than a bare on/off. It is a
  // durable event like typing, and like typing it is missing from
  // `CONVERSATION_EVENTS`, so one agent's scratchpad never turns up in
  // another agent's `pull`.
  r('POST /api/agents/sessions/:ref/thinking', ({ params, body }) =>
    ws.agents.thinking(params.ref ?? '', asInput<ThinkingInput>(body))
  );

  // And the same reason for a snapshot: a tab that opened halfway through a
  // long answer saw none of the steps go by.
  r('GET /api/thinking', () => ({ thinking: ws.agents.thinkingNow() }));

  r('POST /api/thinking', ({ body }) => ws.agents.externalThinking(asInput<ExternalThinkingInput>(body)));

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
    const agentId = String(body.agentId ?? '')
      .trim()
      .toLowerCase();
    if (!AGENT_ID_RE.test(agentId)) {
      throw new ValidationError(`"${String(body.agentId ?? '')}" is not a valid agent id.`, {
        hint: 'Use letters, digits, "-", "_" or "." — the name the agent posts under.',
      });
    }
    // Resolved rather than believed, exactly as `externalTyping` does it: an
    // id that names nothing is a 404 the caller can act on, and the channel
    // comes from the message instead of from whoever asked, so nobody can
    // aim a preview at a channel they were never in.
    const { threadId, text, think, done } = body;
    const target = ws.messages.get(String(threadId ?? '').trim());
    if (text != null && typeof text !== 'string') {
      throw new ValidationError('A delta’s "text" is a piece of the answer, so it has to be a string.');
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
      threadId: target.threadId,
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
    listCommands(ws, params.ref ?? '', { force: q.bool('refresh') })
  );

  r('POST /api/agents/sessions/:ref/command', ({ params, body }) =>
    runCommand(ws, params.ref ?? '', { command: body.command, args: body.args })
  );

  r('POST /api/agents/sessions/:ref/end', ({ params }) => ({ session: ws.agents.end(params.ref ?? '') }));

  // ------------------------------------------------------------ hermes ---

  // Hermes' *global* defaults, one profile at a time.
  //
  // A different scope from everything above it, and the difference is the
  // whole point: `/api/agents/sessions/:ref/model` sets what one conversation
  // runs on, and these set what the profile hands out when no conversation has
  // said otherwise. Writing one never touches the other, which is what the
  // panel promises and what the tests hold it to.
  //
  // Nothing here activates a profile, and nothing restarts a gateway. Editing
  // a profile Hermes is not currently running under is a legitimate thing to
  // want, and pretending the change reached a live process would be a lie the
  // next answer would expose.

  r('GET /api/hermes/profiles', () => {
    const root = hermesRoot(hermesEnv);
    return {
      // Deliberately not the directory: the app has no use for a path, and a
      // path in a payload is one screenshot away from being public.
      profiles: listProfiles(root).map(({ name, isDefault, configured }) => ({
        name,
        isDefault,
        configured,
      })),
    };
  });

  r('GET /api/hermes/profiles/:name/model', async ({ params }) => {
    const { dir: _dir, ...rest } = await readProfileModel(params.name, hermesRoot(hermesEnv), hermesEnv);
    return rest;
  });

  // What the account behind this profile has left, from the provider itself.
  //
  // The one Hermes route that goes over the network, so it is the one with a
  // cache in front of it: `readProfileUsage` reuses an answer for a minute and
  // collapses concurrent asks into one request. `?refresh=1` is the human
  // saying they do not believe it, and is itself floored at ten seconds — the
  // rate limit that matters belongs to the provider, not to this process.
  r('GET /api/hermes/profiles/:name/usage', async ({ params, q }) => {
    return readProfileUsage(params.name, hermesRoot(hermesEnv), hermesEnv, { refresh: q.bool('refresh') });
  });

  r('PUT /api/hermes/profiles/:name/model', async ({ params, body }) => {
    // Checked here as well as in the bridge. The bridge is the one that must
    // never write rubbish into a config file; this is the one that gives a
    // browser a 400 with a sentence in it rather than a 200 saying "no".
    const provider = String(body.provider ?? '').trim();
    const model = String(body.model ?? '').trim();
    if (!provider || !model) {
      throw new ValidationError('A Hermes default needs both a provider and a model.', {
        hint: 'They are one setting: a provider without a model leaves the profile pointing at a model it does not serve.',
      });
    }
    const { dir: _dir, ...rest } = await writeProfileModel(
      params.name,
      { provider, model, effort: hermesEffort(body) },
      hermesRoot(hermesEnv),
      hermesEnv
    );
    return rest;
  });

  // -------------------------------------------------------------- push ---

  r('GET /api/push/vapid-public-key', () => ({ publicKey: push.publicKey }));

  r('POST /api/push/subscribe', ({ body }) => push.subscribe(body));

  r('POST /api/push/unsubscribe', ({ body }) => push.unsubscribe(body.endpoint));

  return router;
}

export { query };
