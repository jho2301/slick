/**
 * Talking to the daemon.
 *
 * The page is opened once with `?token=…`; the server trades that for an
 * HttpOnly cookie, and we keep a copy in sessionStorage so a manual reload
 * still works. Everything below is the same REST surface the CLI uses.
 */

import type {
  AgentSession,
  Category,
  CategoryInput,
  CategoryPatch,
  Channel,
  ChannelInput,
  ChannelPatch,
  Message,
  MessagePage,
  MessagePatch,
  SearchOptions,
  SearchResult,
  Thread,
  ThinkingEntry,
  TypingEntry,
  WorkspaceInfo,
} from '@slick/core';

import type { CommandList, CommandOutput } from './lib/commands.ts';
import type {
  HermesProfileSummary,
  ProfileModelAnswer,
  ProfileModelWrite,
  UsageAnswer,
} from './lib/hermes-types.ts';
import type { ConnectionStatus, LiveFrame } from './types.ts';

const TOKEN_KEY = 'slick.token';

function captureToken(): string | null {
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

/** The daemon's own error envelope, as `sendError` writes it. */
interface ErrorPayload {
  code?: string;
  message?: string;
  hint?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly details: unknown;
  readonly status: number;

  constructor(payload: ErrorPayload | null | undefined, status: number) {
    super(payload?.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.code = payload?.code ?? 'request_failed';
    this.hint = payload?.hint;
    this.details = payload?.details;
    this.status = status;
  }
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  build: string | null;
  seq: number;
  pid: number;
  workspace: string;
  db: string;
}

/** What a composer sends: the text, and nothing about who or where. */
export interface MessageBody {
  text: string;
}

export interface StreamOptions {
  /** Where to resume from; a function is asked again on every reconnect. */
  since?: number | (() => number);
  onEvent: (frame: LiveFrame) => void;
  onStatus?: (status: ConnectionStatus) => void;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const enc = (value: string): string => encodeURIComponent(value);

export class Api {
  readonly token: string | null;

  constructor() {
    this.token = captureToken();
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const envelope = payload && typeof payload === 'object' ? (payload as { error?: ErrorPayload }) : null;
      throw new ApiError(envelope?.error, res.status);
    }
    return payload as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body ?? {});
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body ?? {});
  }
  del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // --------------------------------------------------------------- data ---

  workspace(): Promise<WorkspaceInfo> {
    return this.get('/api/workspace');
  }

  /** Daemon health — the version shown in Settings comes from here. */
  health(): Promise<HealthInfo> {
    return this.get('/api/health');
  }

  listChannels(includeArchived = true): Promise<Channel[]> {
    return this.get<{ channels: Channel[] }>(
      `/api/channels${includeArchived ? '?includeArchived=1' : ''}`
    ).then((r) => r.channels);
  }

  createChannel(input: ChannelInput): Promise<Channel> {
    return this.post<{ channel: Channel }>('/api/channels', input).then((r) => r.channel);
  }

  updateChannel(ref: string, patch: ChannelPatch): Promise<Channel> {
    return this.patch<{ channel: Channel }>(`/api/channels/${enc(ref)}`, patch).then((r) => r.channel);
  }

  archiveChannel(ref: string, archived: boolean): Promise<Channel> {
    return this.post<{ channel: Channel }>(
      `/api/channels/${enc(ref)}/${archived ? 'archive' : 'unarchive'}`
    ).then((r) => r.channel);
  }

  deleteChannel(ref: string, force: boolean): Promise<Channel> {
    return this.del<{ channel: Channel }>(`/api/channels/${enc(ref)}${force ? '?force=1' : ''}`).then(
      (r) => r.channel
    );
  }

  listCategories(): Promise<Category[]> {
    return this.get<{ categories: Category[] }>('/api/categories').then((r) => r.categories);
  }

  createCategory(input: CategoryInput): Promise<Category> {
    return this.post<{ category: Category }>('/api/categories', input).then((r) => r.category);
  }

  updateCategory(ref: string, patch: CategoryPatch): Promise<Category> {
    return this.patch<{ category: Category }>(`/api/categories/${enc(ref)}`, patch).then((r) => r.category);
  }

  deleteCategory(ref: string): Promise<Category> {
    return this.del<{ category: Category }>(`/api/categories/${enc(ref)}`).then((r) => r.category);
  }

  reorderCategories(order: string[]): Promise<Category[]> {
    return this.post<{ categories: Category[] }>('/api/categories/reorder', { order }).then(
      (r) => r.categories
    );
  }

  listMessages(ref: string, { limit = 60, before }: { limit?: number; before?: number | null } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before != null) params.set('before', String(before));
    return this.get<MessagePage>(`/api/channels/${enc(ref)}/messages?${params.toString()}`);
  }

  postMessage(ref: string, body: MessageBody): Promise<Message> {
    return this.post<{ message: Message }>(`/api/channels/${enc(ref)}/messages`, body).then((r) => r.message);
  }

  editMessage(id: string, body: MessagePatch): Promise<Message> {
    return this.patch<{ message: Message }>(`/api/messages/${enc(id)}`, body).then((r) => r.message);
  }

  deleteMessage(id: string, hard = false): Promise<Message> {
    return this.del<{ message: Message }>(`/api/messages/${enc(id)}${hard ? '?hard=1' : ''}`).then(
      (r) => r.message
    );
  }

  thread(id: string): Promise<Thread> {
    return this.get(`/api/messages/${enc(id)}/thread`);
  }

  replyTo(id: string, body: MessageBody): Promise<Message> {
    return this.post<{ message: Message }>(`/api/messages/${enc(id)}/replies`, body).then((r) => r.message);
  }

  search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const params = new URLSearchParams({ q: query });
    for (const [key, value] of Object.entries(opts)) if (value) params.set(key, String(value));
    return this.get(`/api/search?${params.toString()}`);
  }

  agentCommands(ref: string): Promise<CommandList> {
    return this.get(`/api/agents/sessions/${enc(ref)}/commands`);
  }

  runAgentCommand(ref: string, command: string, args: string): Promise<CommandOutput> {
    return this.post(`/api/agents/sessions/${enc(ref)}/command`, { command, args });
  }

  typing(): Promise<TypingEntry[]> {
    return this.get<{ typing?: TypingEntry[] }>('/api/typing').then((r) => r.typing ?? []);
  }

  /**
   * The working an agent has shown so far, for every answer in flight. Same
   * hole as `typing()` covers: a tab that opens in the middle of a reply never
   * saw the steps go up, and the stream only ever carries the change.
   */
  thinkingSnapshot(): Promise<ThinkingEntry[]> {
    return this.get<{ thinking?: ThinkingEntry[] }>('/api/thinking').then((r) => r.thinking ?? []);
  }

  agentSessions(): Promise<AgentSession[]> {
    return this.get<{ sessions: AgentSession[] }>('/api/agents/sessions?includeEnded=1').then(
      (r) => r.sessions
    );
  }

  /**
   * How hard `slick agent serve` should think on this session. Free text: the
   * levels are the adapter's, not ours, and the same watcher re-read applies.
   * @param effort  null (or '') to go back to the default
   */
  setAgentEffort(ref: string, effort: string | null): Promise<string | null> {
    return this.put<{ effort: string | null }>(`/api/agents/sessions/${enc(ref)}/effort`, { effort }).then(
      (r) => r.effort
    );
  }

  /**
   * The model `slick agent serve` should call for this session. A running
   * watcher re-reads it every pass, so this lands without restarting it.
   * @param model  null (or '') to go back to the default
   */
  setAgentModel(ref: string, model: string | null): Promise<string | null> {
    return this.put<{ model: string | null }>(`/api/agents/sessions/${enc(ref)}/model`, { model }).then(
      (r) => r.model
    );
  }

  // ------------------------------------------------------------- hermes ---

  /** The Hermes profiles this installation has. */
  hermesProfiles(): Promise<HermesProfileSummary[]> {
    return this.get<{ profiles?: HermesProfileSummary[] }>('/api/hermes/profiles').then(
      (r) => r.profiles ?? []
    );
  }

  /**
   * One profile's global provider/model default, and the catalog to change it
   * with. Never throws for an unreadable Hermes: `error`/`code` come back in
   * the payload so the panel can say why instead of showing an empty menu.
   */
  hermesProfileModel(name: string): Promise<ProfileModelAnswer> {
    return this.get(`/api/hermes/profiles/${enc(name)}/model`);
  }

  /**
   * Set that default. Both fields go together — a provider without a model
   * leaves the profile pointing at a model that provider does not serve — and
   * what comes back is the config read again, not the request echoed.
   */
  setHermesProfileModel(name: string, wanted: ProfileModelWrite): Promise<ProfileModelAnswer> {
    return this.put(`/api/hermes/profiles/${enc(name)}/model`, wanted);
  }

  /**
   * What the account behind this profile has left — percentages, reset times,
   * banked resets.
   *
   * Only a provider with an account-limits API answers with numbers; the rest
   * come back `supported: false`, which is a fact about the provider and not a
   * failure to fetch. Never throws for what the account itself reports:
   * `error`/`code` ride in the payload so the panel can tell "not signed in"
   * from "could not ask".
   *
   * `refresh` skips the daemon's minute-long cache. The daemon still floors how
   * often a refresh actually reaches the provider, so clicking twice is one
   * request — the rate limit that matters is upstream's.
   */
  hermesProfileUsage(name: string, { refresh = false }: { refresh?: boolean } = {}): Promise<UsageAnswer> {
    const path = `/api/hermes/profiles/${enc(name)}/usage`;
    return this.get(refresh ? `${path}?refresh=1` : path);
  }

  // --------------------------------------------------------------- push ---

  pushVapidKey(): Promise<string> {
    return this.get<{ publicKey: string }>('/api/push/vapid-public-key').then((r) => r.publicKey);
  }

  pushSubscribe(subscription: PushSubscriptionJSON): Promise<unknown> {
    return this.post('/api/push/subscribe', subscription);
  }

  pushUnsubscribe(endpoint: string): Promise<unknown> {
    return this.post('/api/push/unsubscribe', { endpoint });
  }

  // ------------------------------------------------------------- stream ---

  /**
   * Live events. Reconnects on its own; `Last-Event-ID` means a dropped
   * connection resumes exactly where it stopped, so nothing is missed. Pass
   * `since` as a function to have manual reconnects resume from wherever the
   * caller has actually got to.
   *
   * Nothing here knows about ephemeral frames, and nothing needs to: the hub
   * never sets an SSE `event:` field, so a delta arrives on `onmessage` with
   * everything else and is routed by its own `type` like every other frame.
   */
  stream({ since, onEvent, onStatus }: StreamOptions): () => void {
    const positionNow = () => (typeof since === 'function' ? since() : since);
    let source: EventSource | null = null;
    let closed = false;
    let retry = 1000;

    const connect = (from: number | undefined) => {
      if (closed) return;
      const params = new URLSearchParams();
      if (from !== undefined && from !== null) params.set('since', String(from));
      if (this.token) params.set('token', this.token);
      const opened = new EventSource(`/api/stream?${params.toString()}`);
      source = opened;

      opened.onopen = () => {
        retry = 1000;
        onStatus?.('live');
      };
      opened.onmessage = (event: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(event.data) as LiveFrame);
        } catch {
          /* ignore a malformed frame rather than kill the stream */
        }
      };
      opened.onerror = () => {
        onStatus?.('reconnecting');
        // EventSource retries on its own, but only while the server is
        // reachable; if it gave up entirely, rebuild it with backoff.
        if (opened.readyState === EventSource.CLOSED && !closed) {
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
