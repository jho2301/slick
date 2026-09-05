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
 * The shape is `WorkspaceApi`: the core's own services, with every method
 * allowed to answer through a promise. The local workspace answers at once
 * and satisfies it as it is; the remote one answers over HTTP. Commands
 * `await` everything, which costs a local call nothing.
 */

import {
  SlickError,
  Workspace,
  errorMessage,
  isRecord,
  type AgentService,
  type CategoryService,
  type ChannelService,
  type HydratedEvent,
  type JsonObject,
  type ListEventsOptions,
  type MessageService,
  type SearchOptions,
  type SearchResult,
  type WorkspaceInfo,
  type WorkspaceUser,
} from '@slick/core';
import { readDaemonFile } from '@slick/server/daemon';

export type Maybe<T> = T | Promise<T>;

/** A service as either workspace offers it: same arguments, maybe a promise back. */
type Asyncish<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (...args: A) => Maybe<Awaited<R>> : S[K];
};

export type CategoryApi = Asyncish<
  Pick<CategoryService, 'list' | 'get' | 'find' | 'create' | 'update' | 'setCollapsed' | 'remove' | 'reorder'>
>;
export type ChannelApi = Asyncish<
  Pick<ChannelService, 'list' | 'get' | 'find' | 'create' | 'update' | 'archive' | 'unarchive' | 'remove'>
>;
export type MessageApi = Asyncish<
  Pick<MessageService, 'post' | 'reply' | 'list' | 'get' | 'find' | 'thread' | 'update' | 'remove'>
>;
export type AgentApi = Asyncish<
  Pick<
    AgentService,
    | 'list'
    | 'get'
    | 'start'
    | 'resume'
    | 'pull'
    | 'ack'
    | 'setState'
    | 'setModel'
    | 'setEffort'
    | 'update'
    | 'post'
    | 'reply'
    | 'typing'
    | 'end'
    | 'remove'
  >
>;

/**
 * What a command may do with a workspace, whichever kind it was given.
 *
 * The local `Workspace` satisfies this as it stands. Anything the remote one
 * cannot do over HTTP — `serve`'s bookkeeping, for one — is not in here, and a
 * command that needs it narrows to the local class and says so.
 */
export interface WorkspaceApi {
  readonly file: string;
  readonly home: string | undefined;
  readonly categories: CategoryApi;
  readonly channels: ChannelApi;
  readonly messages: MessageApi;
  readonly agents: AgentApi;
  info(): Maybe<WorkspaceInfo>;
  seq(): Maybe<number>;
  user(): Maybe<WorkspaceUser>;
  setUser(user: { id?: string | null; name?: string | null }): Maybe<WorkspaceUser>;
  setMeta(key: string, value: string): Maybe<string>;
  search(query: unknown, opts?: SearchOptions): Maybe<SearchResult>;
  hydratedEvents(opts?: ListEventsOptions): Maybe<HydratedEvent[]>;
  close(): void;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class RemoteWorkspace implements WorkspaceApi {
  readonly url: string;
  readonly token: string | null;
  readonly file: string;
  readonly home: string | undefined = undefined;
  readonly remote = true as const;
  readonly categories: CategoryApi;
  readonly channels: ChannelApi;
  readonly messages: MessageApi;
  readonly agents: AgentApi;

  constructor(target: { url: string; token?: string | null }) {
    this.url = target.url.replace(/\/+$/, '');
    this.token = target.token ?? null;
    this.file = `${this.url} (remote)`;

    const call = <T = JsonObject>(method: Method, path: string, body?: unknown) =>
      this.request<T>(method, path, body);

    this.categories = {
      list: () =>
        call<{ categories: Awaited<ReturnType<CategoryApi['list']>> }>('GET', '/api/categories').then(
          (r) => r.categories
        ),
      get: (ref) =>
        call<{ category: Awaited<ReturnType<CategoryApi['get']>> }>(
          'GET',
          `/api/categories/${enc(ref)}`
        ).then((r) => r.category),
      find: (ref) =>
        call<{ category: Awaited<ReturnType<CategoryApi['get']>> }>('GET', `/api/categories/${enc(ref)}`)
          .then((r) => r.category)
          .catch(() => null),
      create: (input) =>
        call<{ category: Awaited<ReturnType<CategoryApi['get']>> }>('POST', '/api/categories', input).then(
          (r) => r.category
        ),
      update: (ref, patch) =>
        call<{ category: Awaited<ReturnType<CategoryApi['get']>> }>(
          'PATCH',
          `/api/categories/${enc(ref)}`,
          patch
        ).then((r) => r.category),
      setCollapsed: (ref, collapsed) =>
        call<{ category: Awaited<ReturnType<CategoryApi['get']>> }>('PATCH', `/api/categories/${enc(ref)}`, {
          collapsed,
        }).then((r) => r.category),
      remove: (ref) =>
        call<{ category: Awaited<ReturnType<CategoryApi['remove']>> }>(
          'DELETE',
          `/api/categories/${enc(ref)}`
        ).then((r) => r.category),
      reorder: (refs) =>
        call<{ categories: Awaited<ReturnType<CategoryApi['list']>> }>('POST', '/api/categories/reorder', {
          order: refs,
        }).then((r) => r.categories),
    };

    this.channels = {
      list: (opts = {}) => {
        const params = new URLSearchParams();
        if (opts.includeArchived) params.set('includeArchived', '1');
        // An explicit null means "the ones with no category", so it has to
        // survive as an empty value rather than being dropped like undefined.
        if (opts.category !== undefined) params.set('category', opts.category ? String(opts.category) : '');
        const query = params.toString();
        return call<{ channels: Awaited<ReturnType<ChannelApi['list']>> }>(
          'GET',
          `/api/channels${query ? `?${query}` : ''}`
        ).then((r) => r.channels);
      },
      get: (ref) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['get']>> }>('GET', `/api/channels/${enc(ref)}`).then(
          (r) => r.channel
        ),
      find: (ref) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['get']>> }>('GET', `/api/channels/${enc(ref)}`)
          .then((r) => r.channel)
          .catch(() => null),
      create: (input) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['get']>> }>('POST', '/api/channels', input).then(
          (r) => r.channel
        ),
      update: (ref, patch) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['get']>> }>(
          'PATCH',
          `/api/channels/${enc(ref)}`,
          patch
        ).then((r) => r.channel),
      archive: (ref) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['get']>> }>(
          'POST',
          `/api/channels/${enc(ref)}/archive`
        ).then((r) => r.channel),
      unarchive: (ref) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['get']>> }>(
          'POST',
          `/api/channels/${enc(ref)}/unarchive`
        ).then((r) => r.channel),
      remove: (ref, opts = {}) =>
        call<{ channel: Awaited<ReturnType<ChannelApi['remove']>> }>(
          'DELETE',
          `/api/channels/${enc(ref)}${opts.force ? '?force=1' : ''}`
        ).then((r) => r.channel),
    };

    this.messages = {
      post: ({ channel, channelId, parentId, ...rest }) =>
        parentId
          ? call<{ message: Awaited<ReturnType<MessageApi['get']>> }>(
              'POST',
              `/api/messages/${enc(parentId)}/replies`,
              rest
            ).then((r) => r.message)
          : call<{ message: Awaited<ReturnType<MessageApi['get']>> }>(
              'POST',
              `/api/channels/${enc(channelId ?? channel)}/messages`,
              rest
            ).then((r) => r.message),
      reply: (rootId, input) =>
        call<{ message: Awaited<ReturnType<MessageApi['get']>> }>(
          'POST',
          `/api/messages/${enc(rootId)}/replies`,
          input
        ).then((r) => r.message),
      list: (ref, opts = {}) =>
        call<Awaited<ReturnType<MessageApi['list']>>>('GET', `/api/channels/${enc(ref)}/messages${qs(opts)}`),
      get: (id) =>
        call<{ message: Awaited<ReturnType<MessageApi['get']>> }>('GET', `/api/messages/${enc(id)}`).then(
          (r) => r.message
        ),
      find: (id) =>
        call<{ message: Awaited<ReturnType<MessageApi['get']>> }>('GET', `/api/messages/${enc(id)}`)
          .then((r) => r.message)
          .catch(() => null),
      thread: (id) =>
        call<Awaited<ReturnType<MessageApi['thread']>>>('GET', `/api/messages/${enc(id)}/thread`),
      update: (id, patch) =>
        call<{ message: Awaited<ReturnType<MessageApi['get']>> }>(
          'PATCH',
          `/api/messages/${enc(id)}`,
          patch
        ).then((r) => r.message),
      remove: (id, opts = {}) =>
        call<{ message: Awaited<ReturnType<MessageApi['remove']>> }>(
          'DELETE',
          `/api/messages/${enc(id)}${opts.hard ? '?hard=1' : ''}`
        ).then((r) => r.message),
    };

    type Session = Awaited<ReturnType<AgentApi['get']>>;
    this.agents = {
      list: (opts = {}) =>
        call<{ sessions: Session[] }>(
          'GET',
          `/api/agents/sessions${qs({ agent: opts.agentId, ...opts })}`
        ).then((r) => r.sessions),
      get: (ref, opts = {}) =>
        call<{ session: Session }>('GET', `/api/agents/sessions/${enc(ref)}${qs(opts)}`).then(
          (r) => r.session
        ),
      start: (input) =>
        call<{ session: Session }>('POST', '/api/agents/sessions', input).then((r) => r.session),
      resume: (ref, opts = {}) =>
        call<Awaited<ReturnType<AgentApi['resume']>>>(
          'POST',
          `/api/agents/sessions/${enc(ref)}/resume`,
          opts
        ),
      pull: (ref, opts = {}) =>
        call<Awaited<ReturnType<AgentApi['pull']>>>('POST', `/api/agents/sessions/${enc(ref)}/pull`, opts),
      ack: (ref, seq) =>
        call<{ session: Session }>('POST', `/api/agents/sessions/${enc(ref)}/ack`, { seq }).then(
          (r) => r.session
        ),
      setState: (ref, state, opts = {}) =>
        call<{ session: Session }>('PUT', `/api/agents/sessions/${enc(ref)}/state`, {
          state,
          merge: opts.merge !== false,
        }).then((r) => r.session),
      // The two routes the daemon already had, and the CLI never called: a
      // `slick agent model` against `--remote` used to fall over on a missing
      // method.
      setModel: (ref, model, opts = {}) =>
        call<{ session: Session }>('PUT', `/api/agents/sessions/${enc(ref)}/model`, {
          model,
          agent: opts.agentId,
        }).then((r) => r.session),
      setEffort: (ref, effort, opts = {}) =>
        call<{ session: Session }>('PUT', `/api/agents/sessions/${enc(ref)}/effort`, {
          effort,
          agent: opts.agentId,
        }).then((r) => r.session),
      update: (ref, patch) =>
        call<{ session: Session }>('PATCH', `/api/agents/sessions/${enc(ref)}`, patch).then((r) => r.session),
      post: (ref, input) =>
        call<Awaited<ReturnType<AgentApi['post']>>>(
          'POST',
          `/api/agents/sessions/${enc(ref)}/messages`,
          input
        ),
      reply: (ref, rootId, input) =>
        call<Awaited<ReturnType<AgentApi['post']>>>('POST', `/api/agents/sessions/${enc(ref)}/messages`, {
          ...input,
          threadId: rootId,
        }),
      typing: (ref, input) => call<{ ok: true }>('POST', `/api/agents/sessions/${enc(ref)}/typing`, input),
      end: (ref) =>
        call<{ session: Session }>('POST', `/api/agents/sessions/${enc(ref)}/end`).then((r) => r.session),
      remove: (ref) =>
        call<{ session: Session & { deleted: true } }>('DELETE', `/api/agents/sessions/${enc(ref)}`).then(
          (r) => r.session
        ),
    };
  }

  async request<T = JsonObject>(method: Method, path: string, body?: unknown): Promise<T> {
    let res: Response;
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
      throw new SlickError('unreachable', `Cannot reach ${this.url}: ${errorMessage(err)}`, {
        status: 503,
        hint: 'Is the daemon running? Try `slick daemon status`.',
      });
    }
    const text = await res.text();
    const payload: unknown = text ? safeParse(text) : null;
    if (!res.ok) {
      const e = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      throw new SlickError(
        typeof e.code === 'string' ? e.code : 'request_failed',
        typeof e.message === 'string' ? e.message : `${method} ${path} failed (${res.status})`,
        {
          status: res.status,
          hint: typeof e.hint === 'string' ? e.hint : undefined,
          details: isRecord(e.details) ? e.details : undefined,
        }
      );
    }
    return payload as T;
  }

  info(): Promise<WorkspaceInfo> {
    return this.request<WorkspaceInfo>('GET', '/api/workspace');
  }

  async seq(): Promise<number> {
    return Number((await this.request<{ seq: number }>('GET', '/api/health')).seq);
  }

  async user(): Promise<WorkspaceUser> {
    return (await this.info()).user;
  }

  async setUser(user: { id?: string | null; name?: string | null }): Promise<WorkspaceUser> {
    return (await this.request<WorkspaceInfo>('PATCH', '/api/workspace', { user })).user;
  }

  async setMeta(key: string, value: string): Promise<string> {
    if (key !== 'workspace.name') {
      throw new SlickError('unsupported', `Cannot set "${key}" on a remote workspace.`, { status: 400 });
    }
    return (await this.request<WorkspaceInfo>('PATCH', '/api/workspace', { name: value })).name;
  }

  search(query: unknown, opts: SearchOptions = {}): Promise<SearchResult> {
    return this.request<SearchResult>('GET', `/api/search${qs({ q: query, ...opts })}`);
  }

  async hydratedEvents(opts: ListEventsOptions = {}): Promise<HydratedEvent[]> {
    return (await this.request<{ events: HydratedEvent[] }>('GET', `/api/events${qs(opts)}`)).events;
  }

  close(): void {}
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const enc = (value: unknown): string => encodeURIComponent(String(value));

function qs(opts: object = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined || value === null || value === false || value === '') continue;
    params.set(key, value === true ? '1' : String(value));
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

export interface ResolvedWorkspace {
  ws: WorkspaceApi;
  mode: 'local' | 'remote';
  close: () => void;
}

export async function resolveWorkspace(
  opts: { home?: string; remote?: string; token?: string } = {}
): Promise<ResolvedWorkspace> {
  const remote = opts.remote ?? process.env.SLICK_REMOTE;
  if (remote) {
    const target =
      remote === 'daemon' || remote === 'auto' ? readDaemonFile(opts.home) : { url: remote, token: null };
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
  return await Promise.resolve({ ws, mode: 'local', close: () => ws.close() });
}
