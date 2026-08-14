/**
 * Choosing what the CLI talks to.
 *
 * By default it opens the SQLite file directly — no daemon required, so
 * `slick send` works on a bare machine and an agent's commands never fail
 * because a background process was not running. Point it at `--remote` (or
 * SLICK_REMOTE) and it drives a daemon over HTTP instead, which is how you
 * reach a workspace on another machine.
 *
 * Both expose the same shape, so commands never branch on which one they got.
 */

import { SlickError, Workspace } from '@slick/core';
import { readDaemonFile } from '@slick/server/daemon';

class RemoteWorkspace {
  /** @param {{url: string, token?: string|null}} target */
  constructor(target) {
    this.url = target.url.replace(/\/+$/, '');
    this.token = target.token ?? null;
    this.file = `${this.url} (remote)`;
    this.remote = true;

    const call = this.request.bind(this);

    this.categories = {
      list: () => call('GET', '/api/categories').then((r) => r.categories),
      get: (ref) => call('GET', `/api/categories/${enc(ref)}`).then((r) => r.category),
      find: (ref) =>
        call('GET', `/api/categories/${enc(ref)}`)
          .then((r) => r.category)
          .catch(() => null),
      create: (input) => call('POST', '/api/categories', input).then((r) => r.category),
      update: (ref, patch) => call('PATCH', `/api/categories/${enc(ref)}`, patch).then((r) => r.category),
      setCollapsed: (ref, collapsed) =>
        call('PATCH', `/api/categories/${enc(ref)}`, { collapsed }).then((r) => r.category),
      remove: (ref) => call('DELETE', `/api/categories/${enc(ref)}`).then((r) => r.category),
      reorder: (refs) => call('POST', '/api/categories/reorder', { order: refs }).then((r) => r.categories),
    };

    this.channels = {
      list: (opts = {}) => {
        const params = new URLSearchParams();
        if (opts.includeArchived) params.set('includeArchived', '1');
        // An explicit null means "the ones with no category", so it has to
        // survive as an empty value rather than being dropped like undefined.
        if (opts.category !== undefined) params.set('category', opts.category ?? '');
        const query = params.toString();
        return call('GET', `/api/channels${query ? `?${query}` : ''}`).then((r) => r.channels);
      },
      get: (ref) => call('GET', `/api/channels/${enc(ref)}`).then((r) => r.channel),
      find: (ref) =>
        call('GET', `/api/channels/${enc(ref)}`)
          .then((r) => r.channel)
          .catch(() => null),
      create: (input) => call('POST', '/api/channels', input).then((r) => r.channel),
      update: (ref, patch) => call('PATCH', `/api/channels/${enc(ref)}`, patch).then((r) => r.channel),
      archive: (ref) => call('POST', `/api/channels/${enc(ref)}/archive`).then((r) => r.channel),
      unarchive: (ref) => call('POST', `/api/channels/${enc(ref)}/unarchive`).then((r) => r.channel),
      remove: (ref, opts = {}) =>
        call('DELETE', `/api/channels/${enc(ref)}${opts.force ? '?force=1' : ''}`).then((r) => r.channel),
    };

    this.messages = {
      post: ({ channel, channelId, parentId, ...rest }) =>
        parentId
          ? call('POST', `/api/messages/${enc(parentId)}/replies`, rest).then((r) => r.message)
          : call('POST', `/api/channels/${enc(channelId ?? channel)}/messages`, rest).then((r) => r.message),
      reply: (rootId, input) => call('POST', `/api/messages/${enc(rootId)}/replies`, input).then((r) => r.message),
      list: (ref, opts = {}) => call('GET', `/api/channels/${enc(ref)}/messages${qs(opts)}`),
      get: (id) => call('GET', `/api/messages/${enc(id)}`).then((r) => r.message),
      find: (id) =>
        call('GET', `/api/messages/${enc(id)}`)
          .then((r) => r.message)
          .catch(() => null),
      thread: (id) => call('GET', `/api/messages/${enc(id)}/thread`),
      update: (id, patch) => call('PATCH', `/api/messages/${enc(id)}`, patch).then((r) => r.message),
      remove: (id, opts = {}) =>
        call('DELETE', `/api/messages/${enc(id)}${opts.hard ? '?hard=1' : ''}`).then((r) => r.message),
    };

    this.agents = {
      list: (opts = {}) => call('GET', `/api/agents/sessions${qs({ agent: opts.agentId, ...opts })}`).then((r) => r.sessions),
      get: (ref, opts = {}) => call('GET', `/api/agents/sessions/${enc(ref)}${qs(opts)}`).then((r) => r.session),
      start: (input) => call('POST', '/api/agents/sessions', input).then((r) => r.session),
      resume: (ref, opts = {}) => call('POST', `/api/agents/sessions/${enc(ref)}/resume`, opts),
      pull: (ref, opts = {}) => call('POST', `/api/agents/sessions/${enc(ref)}/pull`, opts),
      ack: (ref, seq) => call('POST', `/api/agents/sessions/${enc(ref)}/ack`, { seq }).then((r) => r.session),
      setState: (ref, state, opts = {}) =>
        call('PUT', `/api/agents/sessions/${enc(ref)}/state`, { state, merge: opts.merge !== false }).then(
          (r) => r.session
        ),
      update: (ref, patch) => call('PATCH', `/api/agents/sessions/${enc(ref)}`, patch).then((r) => r.session),
      post: (ref, input) => call('POST', `/api/agents/sessions/${enc(ref)}/messages`, input),
      reply: (ref, rootId, input) =>
        call('POST', `/api/agents/sessions/${enc(ref)}/messages`, { ...input, threadId: rootId }),
      typing: (ref, input) => call('POST', `/api/agents/sessions/${enc(ref)}/typing`, input),
      end: (ref) => call('POST', `/api/agents/sessions/${enc(ref)}/end`).then((r) => r.session),
      remove: (ref) => call('DELETE', `/api/agents/sessions/${enc(ref)}`).then((r) => r.session),
    };
  }

  async request(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new SlickError('unreachable', `Cannot reach ${this.url}: ${err.message}`, {
        status: 503,
        hint: 'Is the daemon running? Try `slick daemon status`.',
      });
    }
    const text = await res.text();
    const payload = text ? safeParse(text) : null;
    if (!res.ok) {
      const e = payload?.error ?? {};
      throw new SlickError(e.code ?? 'request_failed', e.message ?? `${method} ${path} failed (${res.status})`, {
        status: res.status,
        hint: e.hint,
        details: e.details,
      });
    }
    return payload;
  }

  info() {
    return this.request('GET', '/api/workspace');
  }

  async seq() {
    return (await this.request('GET', '/api/health')).seq;
  }

  async user() {
    return (await this.info()).user;
  }

  async setUser(user) {
    return (await this.request('PATCH', '/api/workspace', { user })).user;
  }

  async setMeta(key, value) {
    if (key !== 'workspace.name') {
      throw new SlickError('unsupported', `Cannot set "${key}" on a remote workspace.`, { status: 400 });
    }
    return (await this.request('PATCH', '/api/workspace', { name: value })).name;
  }

  search(query, opts = {}) {
    return this.request('GET', `/api/search${qs({ q: query, ...opts })}`);
  }

  async hydratedEvents(opts = {}) {
    return (await this.request('GET', `/api/events${qs(opts)}`)).events;
  }

  events(opts) {
    return this.hydratedEvents(opts);
  }

  close() {}
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const enc = (value) => encodeURIComponent(String(value));

function qs(opts = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined || value === null || value === false || value === '') continue;
    params.set(key, value === true ? '1' : String(value));
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

/**
 * @param {{home?: string, remote?: string, token?: string}} opts
 * @returns {Promise<{ws: any, mode: 'local'|'remote', close: () => void}>}
 */
export async function resolveWorkspace(opts = {}) {
  const remote = opts.remote ?? process.env.SLICK_REMOTE;
  if (remote) {
    const target = remote === 'daemon' || remote === 'auto' ? readDaemonFile(opts.home) : { url: remote };
    if (!target?.url) {
      throw new SlickError('unreachable', 'No running daemon to connect to.', {
        status: 503,
        hint: 'Start one with `slick daemon start`.',
      });
    }
    const ws = new RemoteWorkspace({
      url: target.url,
      token: opts.token ?? process.env.SLICK_TOKEN ?? target.token ?? null,
    });
    return { ws, mode: 'remote', close: () => ws.close() };
  }

  const ws = Workspace.open({ home: opts.home });
  return { ws, mode: 'local', close: () => ws.close() };
}

export { RemoteWorkspace };
