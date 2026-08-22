/**
 * The Slick daemon.
 *
 * Binds to loopback, serves the REST API, the live SSE stream and the web UI
 * from one origin. Authentication is a shared token written to
 * `~/.slick/daemon.json`: the desktop shell passes it once in the URL and
 * thereafter rides an HttpOnly cookie; scripts and the future mobile client
 * use `Authorization: Bearer`.
 */

import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Workspace } from '@slick/core';

import { createRoutes, RAW } from './routes.js';
import { createHub } from './hub.js';
import { createPushService } from './push.js';
import { buildStamp, createStaticHandler, manifestWithToken, resolveWebRoot, serviceWorkerWithBuild } from './static.js';
import { isLocalHost, parseCookies, query, readJson, sendError, sendJson } from './http.js';

export const VERSION = '0.1.0';
const COOKIE = 'slick_token';
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function newToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * @param {{
 *   workspace?: Workspace, home?: string, file?: string,
 *   token?: string|null, webRoot?: string|null, host?: string,
 *   trustedHosts?: string[], push?: ReturnType<typeof createPushService>,
 * }} [opts]
 */
export function createServer(opts = {}) {
  const ws = opts.workspace ?? Workspace.open({ home: opts.home, file: opts.file });
  const ownsWorkspace = !opts.workspace;
  const host = opts.host ?? '127.0.0.1';
  const trustedHosts = new Set((opts.trustedHosts ?? []).map((h) => h.toLowerCase()));
  const token = opts.token === null ? null : (opts.token ?? newToken());
  const webRoot = opts.webRoot === null ? null : resolveWebRoot(opts.webRoot);
  const push = opts.push ?? createPushService(ws);
  const hub = createHub(ws, { push });
  const router = createRoutes({ ws, hub, push, version: VERSION, build: () => buildStamp(webRoot) });
  const serveStatic = createStaticHandler(webRoot);

  function authenticate(req, url) {
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

  const server = createHttpServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
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
      return res.end();
    }

    const auth = authenticate(req, url);
    if (!auth.ok) {
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(UNAUTHORIZED_PAGE);
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

    const route = router.match(req.method, url.pathname);
    if (route) {
      try {
        const body = BODY_METHODS.has(req.method) ? await readJson(req) : {};
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
        if (req.method !== 'GET') hub.wake();
        if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
          return sendJson(res, result.status, result.body);
        }
        return sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        if (res.headersSent) return res.end();
        return sendError(res, err);
      }
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
        return res.end(manifest);
      }
    }

    // Also ahead of the static handler: the copy on disk has a placeholder
    // where the build stamp goes. See `serviceWorkerWithBuild`.
    if (req.method === 'GET' && url.pathname === '/sw.js') {
      const source = serviceWorkerWithBuild(webRoot, buildStamp(webRoot));
      if (source !== null) {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': Buffer.byteLength(source),
          'cache-control': 'no-cache',
        });
        return res.end(source);
      }
    }

    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  /** @param {number} [port] 0 picks a free one */
  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const address = server.address();
        resolve({ port: address.port, host, url: `http://${host}:${address.port}` });
      });
    });
  }

  function close() {
    hub.close();
    return new Promise((resolve) => {
      server.close(() => {
        if (ownsWorkspace) ws.close();
        resolve();
      });
      server.closeIdleConnections?.();
    });
  }

  return { server, ws, hub, push, token, webRoot, host, listen, close };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
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
