/**
 * Talking to the daemon.
 *
 * The page is opened once with `?token=…`; the server trades that for an
 * HttpOnly cookie, and we keep a copy in sessionStorage so a manual reload
 * still works. Everything below is the same REST surface the CLI uses.
 */

const TOKEN_KEY = 'slick.token';

function captureToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode — the cookie still carries us */
    }
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.message ?? `Request failed (${status})`);
    this.code = payload?.code ?? 'request_failed';
    this.hint = payload?.hint;
    this.details = payload?.details;
    this.status = status;
  }
}

export class Api {
  constructor() {
    this.token = captureToken();
  }

  async request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) throw new ApiError(payload?.error, res.status);
    return payload;
  }

  get = (path) => this.request('GET', path);
  post = (path, body) => this.request('POST', path, body ?? {});
  patch = (path, body) => this.request('PATCH', path, body ?? {});
  del = (path) => this.request('DELETE', path);

  // --------------------------------------------------------------- data ---

  workspace() {
    return this.get('/api/workspace');
  }

  listChannels(includeArchived = true) {
    return this.get(`/api/channels${includeArchived ? '?includeArchived=1' : ''}`).then((r) => r.channels);
  }

  createChannel(input) {
    return this.post('/api/channels', input).then((r) => r.channel);
  }

  updateChannel(ref, patch) {
    return this.patch(`/api/channels/${encodeURIComponent(ref)}`, patch).then((r) => r.channel);
  }

  archiveChannel(ref, archived) {
    return this.post(`/api/channels/${encodeURIComponent(ref)}/${archived ? 'archive' : 'unarchive'}`).then(
      (r) => r.channel
    );
  }

  deleteChannel(ref, force) {
    return this.del(`/api/channels/${encodeURIComponent(ref)}${force ? '?force=1' : ''}`).then((r) => r.channel);
  }

  listMessages(ref, { limit = 60, before } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', String(before));
    return this.get(`/api/channels/${encodeURIComponent(ref)}/messages?${params}`);
  }

  postMessage(ref, body) {
    return this.post(`/api/channels/${encodeURIComponent(ref)}/messages`, body).then((r) => r.message);
  }

  editMessage(id, body) {
    return this.patch(`/api/messages/${encodeURIComponent(id)}`, body).then((r) => r.message);
  }

  deleteMessage(id, hard = false) {
    return this.del(`/api/messages/${encodeURIComponent(id)}${hard ? '?hard=1' : ''}`).then((r) => r.message);
  }

  thread(id) {
    return this.get(`/api/messages/${encodeURIComponent(id)}/thread`);
  }

  replyTo(id, body) {
    return this.post(`/api/messages/${encodeURIComponent(id)}/replies`, body).then((r) => r.message);
  }

  search(query, opts = {}) {
    const params = new URLSearchParams({ q: query });
    for (const [key, value] of Object.entries(opts)) if (value) params.set(key, String(value));
    return this.get(`/api/search?${params}`);
  }

  agentSessions() {
    return this.get('/api/agents/sessions?includeEnded=1').then((r) => r.sessions);
  }

  /**
   * Live events. Reconnects on its own; `Last-Event-ID` means a dropped
   * connection resumes exactly where it stopped, so nothing is missed. Pass
   * `since` as a function to have manual reconnects resume from wherever the
   * caller has actually got to.
   * @param {{since?: number|(() => number), onEvent: (e: any) => void, onStatus?: (s: string) => void}} opts
   */
  stream({ since, onEvent, onStatus }) {
    const positionNow = () => (typeof since === 'function' ? since() : since);
    let source = null;
    let closed = false;
    let retry = 1000;

    const connect = (from) => {
      if (closed) return;
      const params = new URLSearchParams();
      if (from !== undefined && from !== null) params.set('since', String(from));
      if (this.token) params.set('token', this.token);
      source = new EventSource(`/api/stream?${params}`);

      source.onopen = () => {
        retry = 1000;
        onStatus?.('live');
      };
      source.onmessage = (event) => {
        try {
          onEvent(JSON.parse(event.data));
        } catch {
          /* ignore a malformed frame rather than kill the stream */
        }
      };
      source.onerror = () => {
        onStatus?.('reconnecting');
        // EventSource retries on its own, but only while the server is
        // reachable; if it gave up entirely, rebuild it with backoff.
        if (source.readyState === EventSource.CLOSED && !closed) {
          setTimeout(() => connect(positionNow()), retry);
          retry = Math.min(retry * 2, 15000);
        }
      };
    };

    connect(positionNow());
    return () => {
      closed = true;
      source?.close();
      onStatus?.('closed');
    };
  }
}
