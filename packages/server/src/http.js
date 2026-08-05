/**
 * Minimal HTTP plumbing — body parsing, JSON responses, error mapping and a
 * pattern router. Small enough to read in one sitting, which is the point:
 * the daemon has no third-party dependencies at all.
 */

import { toSlickError } from '@slick/core';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendError(res, err) {
  const slick = toSlickError(err);
  if (slick.status >= 500) console.error('[slick] unhandled:', err);
  sendJson(res, slick.status, slick.toJSON());
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('Request body is not valid JSON');
    err.status = 400;
    throw err;
  }
}

/** `?limit=10&peek=true` -> typed accessors that tolerate absent values. */
export function query(url) {
  const params = url.searchParams;
  return {
    raw: params,
    get: (key, fallback = undefined) => params.get(key) ?? fallback,
    int: (key, fallback = undefined) => {
      const value = params.get(key);
      if (value == null || value === '') return fallback;
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    },
    bool: (key, fallback = false) => {
      const value = params.get(key);
      if (value == null) return fallback;
      return value === '' || value === '1' || value.toLowerCase() === 'true';
    },
  };
}

/**
 * Routes are declared as `METHOD /api/thing/:param`. First match wins.
 */
export function createRouter() {
  /** @type {{method: string, segments: string[], handler: Function}[]} */
  const routes = [];

  function add(spec, handler) {
    const [method, pattern] = spec.split(' ');
    routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
  }

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
        else if (segment !== parts[i]) {
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

/**
 * Loopback services are still reachable from a browser tab on any site, so
 * reject requests whose Host header is not a local address (DNS rebinding).
 */
export function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
