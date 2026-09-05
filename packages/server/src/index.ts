/**
 * The Slick daemon.
 *
 * Binds to loopback, serves the REST API, the live SSE stream and the web UI
 * from one origin. Authentication is a shared token written to
 * `~/.slick/daemon.json`: the desktop shell passes it once in the URL and
 * thereafter rides an HttpOnly cookie; scripts and the future mobile client
 * use `Authorization: Bearer`.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Workspace, isRecord } from '@slick/core';

import { createRoutes, RAW } from './http/routes.ts';
import { createHub, type Hub } from './realtime/hub.ts';
import { createPushService, type PushService } from './realtime/push.ts';
import { buildStamp, createStaticHandler, manifestWithToken, resolveWebRoot } from './http/static.ts';
import { isLocalHost, parseCookies, query, readJson, sendError, sendJson } from './http/http.ts';
import type { Env } from './integrations/hermes/hermes.ts';

export const VERSION = '0.6.0';
const COOKIE = 'slick_token';
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface ServerOptions {
  workspace?: Workspace;
  home?: string | null;
  file?: string;
  /** `null` turns auth off; absent mints a fresh token. */
  token?: string | null;
  /** `null` serves no UI at all; absent looks for one. */
  webRoot?: string | null;
  host?: string;
  trustedHosts?: string[];
  push?: PushService;
  hermesEnv?: Env;
}

export interface Bound {
  port: number;
  host: string;
  url: string;
}

type AuthResult = { ok: true; from: 'disabled' | 'header' | 'query' | 'cookie' } | { ok: false };

export function createServer(opts: ServerOptions = {}) {
  const ws = opts.workspace ?? Workspace.open({ home: opts.home, file: opts.file });
  const ownsWorkspace = !opts.workspace;
  const host = opts.host ?? '127.0.0.1';
  const trustedHosts = new Set((opts.trustedHosts ?? []).map((h) => h.toLowerCase()));
  const token = opts.token === null ? null : (opts.token ?? newToken());
  const webRoot = opts.webRoot === null ? null : resolveWebRoot(opts.webRoot);
  const push = opts.push ?? createPushService(ws);
  const hub: Hub = createHub(ws, { push });
  const router = createRoutes({
    ws,
    hub,
    push,
    version: VERSION,
    build: () => buildStamp(webRoot),
    // Which Hermes the profile panel edits. One knob, and it is the same one
    // Hermes itself reads, so a daemon started under a profile describes that
    // installation — and a test can hand over a throwaway one.
    hermesEnv: opts.hermesEnv ?? process.env,
  });
  const serveStatic = createStaticHandler(webRoot);

  function authenticate(req: IncomingMessage, url: URL): AuthResult {
    if (!token) return { ok: true, from: 'disabled' };
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), token)) {
      return { ok: true, from: 'header' };
    }
    const fromQuery = url.searchParams.get('token');
    if (fromQuery && safeEqual(fromQuery, token)) return { ok: true, from: 'query' };
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    if (cookie && safeEqual(cookie, token)) return { ok: true, from: 'cookie' };
    return { ok: false };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return sendJson(res, 400, { error: { code: 'bad_request', message: 'Malformed URL' } });
    }

    // Loopback bindings are still reachable from any web page the user has
    // open, so pin the Host header too (defeats DNS rebinding). A reverse
    // proxy that only ever forwards to us over loopback (e.g. `tailscale
    // serve`, which forwards traffic that already passed tailnet auth) can
    // be allow-listed by hostname via `trustedHosts`.
    const requestHost = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host === '127.0.0.1' && !isLocalHost(req.headers.host) && !trustedHosts.has(requestHost)) {
      return sendJson(res, 403, { error: { code: 'forbidden', message: 'Non-local Host header' } });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, last-event-id',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    const auth = authenticate(req, url);
    if (!auth.ok) {
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(UNAUTHORIZED_PAGE);
        return;
      }
      return sendJson(res, 401, {
        error: {
          code: 'unauthorized',
          message: 'Missing or invalid token.',
          hint: 'Read the token from ~/.slick/daemon.json and send it as `Authorization: Bearer <token>`.',
        },
      });
    }
    // First load carries the token in the URL; trade it for a cookie so the
    // token never sits in the address bar afterwards.
    if (auth.from === 'query' && token && !url.pathname.startsWith('/api/')) {
      res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    }
    // Bearer tokens (scripts, mobile) may come cross-origin; cookies may not.
    if (auth.from === 'header') res.setHeader('access-control-allow-origin', '*');

    // Everything from here on decodes what the client sent, so everything from
    // here on is inside the error boundary: a malformed escape in a path is a
    // 400, not an exception on its way to `process.exit`.
    try {
      const route = router.match(req.method, url.pathname);
      if (route) {
        const body = BODY_METHODS.has(req.method ?? '') ? await readJson(req) : {};
        const result = await route.handler({
          req,
          res,
          params: route.params,
          q: query(url),
          body,
          url,
          ws,
          hub,
        });
        if (result === RAW) return;
        // `/api/stream/delta` is the exception, and the only one: `broadcast`
        // already put its frame on every open socket before the handler
        // returned, and it wrote no row for a wake to go looking for. Waking
        // anyway would buy nothing but a `ws.seq()` query against SQLite for
        // every fragment of every streamed answer.
        if (req.method !== 'GET' && url.pathname !== '/api/stream/delta') hub.wake();
        if (isRecord(result) && 'status' in result && 'body' in result && typeof result.status === 'number') {
          return sendJson(res, result.status, result.body);
        }
        return sendJson(res, 200, result ?? { ok: true });
      }

      // `/api/*` is never static: an unknown endpoint must answer with JSON, not
      // with the app shell that the SPA fallback would otherwise hand back.
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, {
          error: { code: 'no_such_route', message: `No route for ${req.method} ${url.pathname}` },
        });
      }

      // Ahead of the static handler, which would serve the file as written: the
      // copy on disk has no token in its `start_url`, and an installed app has
      // nowhere else to get one. See `manifestWithToken`.
      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        const manifest = manifestWithToken(webRoot, token);
        if (manifest) {
          res.writeHead(200, {
            'content-type': 'application/manifest+json',
            'content-length': Buffer.byteLength(manifest),
            'cache-control': 'no-cache',
          });
          res.end(manifest);
          return;
        }
      }

      // The service worker is served as built: the bundler folds the build's
      // own file list into it, so any change to the UI is a change to the
      // worker without the daemon rewriting anything on the way out.
      if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, err);
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // `handle` answers its own errors; this is the last line of defence for
      // a response that failed while being written.
      console.error('[slick] request failed:', err);
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });

  /** @param port 0 picks a free one */
  function listen(port = 0): Promise<Bound> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        resolve({ port: bound, host, url: `http://${host}:${bound}` });
      });
    });
  }

  function close(): Promise<void> {
    hub.close();
    return new Promise((resolve) => {
      server.close(() => {
        if (ownsWorkspace) ws.close();
        resolve();
      });
      server.closeIdleConnections();
    });
  }

  return { server, ws, hub, push, token, webRoot, host, listen, close };
}

export type SlickServer = ReturnType<typeof createServer>;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UNAUTHORIZED_PAGE = `<!doctype html><meta charset="utf-8">
<title>Slick — token required</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.5rem;color:#1d1c1d}
code{background:#f4f4f5;padding:.15em .4em;border-radius:4px;font-size:.9em}</style>
<h1>Slick needs a token</h1>
<p>This workspace is protected by a local token so other pages in your browser cannot read it.</p>
<p>Open it the easy way:</p>
<p><code>slick app</code></p>
<p>…or copy the URL printed by <code>slick daemon status</code>.</p>`;

export { createHub, createPushService, resolveWebRoot };
export type { Hub, PushService, Env };
export type { DaemonInfo, DaemonStatus, RunningDaemon, StoppedDaemon, StartedDaemon } from './daemon.ts';
export type { CommandEntry, CommandList, CommandOutput } from './integrations/commands.ts';
export type {
  AccountUsage,
  HermesProfile,
  ProfileModel,
  ProfileModelWritten,
  ProfileUsage,
  UsageWindow,
  EffortChoice,
} from './integrations/hermes/hermes.ts';
