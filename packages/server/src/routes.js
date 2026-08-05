/**
 * The REST surface.
 *
 * Every handler is a thin translation from HTTP to a `Workspace` call — all
 * of the actual rules live in @slick/core, so the CLI (which calls the core
 * directly) and the desktop app (which calls it through here) can never drift
 * apart.
 */

import { createRouter, query } from './http.js';

/** Returned by handlers that wrote the response themselves. */
export const RAW = Symbol('raw');

const CREATED = (body) => ({ status: 201, body });

export function createRoutes({ ws, hub, version }) {
  const router = createRouter();
  const r = router.add;

  // --------------------------------------------------------- workspace ---

  r('GET /api/health', () => ({
    ok: true,
    version,
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
    channels: ws.channels.list({ includeArchived: q.bool('includeArchived') }),
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

  r('POST /api/agents/sessions/:ref/messages', ({ params, body }) =>
    CREATED(ws.agents.post(params.ref, body))
  );

  r('POST /api/agents/sessions/:ref/end', ({ params }) => ({ session: ws.agents.end(params.ref) }));

  return router;
}

export { query };
