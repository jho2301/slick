/**
 * Minimal HTTP plumbing — body parsing, JSON responses, error mapping and a
 * pattern router. Small enough to read in one sitting, which is the point:
 * the daemon has no third-party dependencies at all.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { SlickError, toSlickError, isRecord, type JsonObject } from '@slick/core';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | number> = {}
): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  const slick = toSlickError(err);
  if (slick.status >= 500) console.error('[slick] unhandled:', err);
  sendJson(res, slick.status, slick.toJSON());
}

export async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new SlickError('request_too_large', 'Request body too large', { status: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SlickError('bad_request', 'Request body is not valid JSON', { status: 400 });
  }
  return isRecord(parsed) ? parsed : {};
}

/** `?limit=10&peek=true` -> typed accessors that tolerate absent values. */
export interface Query {
  raw: URLSearchParams;
  get(key: string): string | undefined;
  get(key: string, fallback: string): string;
  int(key: string): number | undefined;
  int(key: string, fallback: number): number;
  bool(key: string, fallback?: boolean): boolean;
}

export function query(url: URL): Query {
  const params = url.searchParams;
  function get(key: string): string | undefined;
  function get(key: string, fallback: string): string;
  function get(key: string, fallback?: string): string | undefined {
    return params.get(key) ?? fallback;
  }
  function int(key: string): number | undefined;
  function int(key: string, fallback: number): number;
  function int(key: string, fallback?: number): number | undefined {
    const value = params.get(key);
    if (value == null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return {
    raw: params,
    get,
    int,
    bool: (key, fallback = false) => {
      const value = params.get(key);
      if (value == null) return fallback;
      return value === '' || value === '1' || value.toLowerCase() === 'true';
    },
  };
}

/**
 * `decodeURIComponent` that answers a malformed escape with a 400 rather than
 * a `URIError`. The router and the static handler both decode what a browser
 * sent, and an exception out of either used to escape the request handler
 * entirely — which, for a daemon whose last resort is `process.exit`, meant
 * that `%zz` in a URL was enough to take the whole workspace down.
 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SlickError('bad_request', 'Malformed URL encoding', { status: 400 });
  }
}

export interface RouteMatch<H> {
  handler: H;
  params: Record<string, string>;
}

export interface Route<H> {
  method: string;
  segments: string[];
  handler: H;
}

/**
 * Routes are declared as `METHOD /api/thing/:param`. First match wins.
 */
export function createRouter<H>() {
  const routes: Route<H>[] = [];

  function add(spec: string, handler: H): void {
    const [method = '', pattern = ''] = spec.split(' ');
    routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
  }

  function match(method: string | undefined, pathname: string): RouteMatch<H> | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i] ?? '';
        const part = parts[i] ?? '';
        if (segment.startsWith(':')) params[segment.slice(1)] = safeDecode(part);
        else if (segment !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  return { add, match, routes };
}

export type Router<H> = ReturnType<typeof createRouter<H>>;

/**
 * Loopback services are still reachable from a browser tab on any site, so
 * reject requests whose Host header is not a local address (DNS rebinding).
 */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      /* a cookie this process did not write; ignore it */
    }
  }
  return out;
}
