/**
 * Serves the web UI. The desktop shell loads the very same files over
 * http://127.0.0.1, which is why a browser tab is a perfectly good fallback
 * when Electron is not installed — and why the future mobile client has
 * nothing new to talk to.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord } from '@slick/core';

import { safeDecode } from './http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Where the bundler puts content-hashed files. Their names change when their
 * bytes do, so a browser may keep them for as long as it likes; everything
 * else — the shell, the worker, the manifest — is what points at them and has
 * to be re-asked for every time.
 */
const IMMUTABLE_PREFIX = '/assets/';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Find the UI: an explicit root, `SLICK_WEB_ROOT`, or the built bundle in
 * `packages/server/public` — what `npm run build` makes and `npm install`
 * makes on the way in. A checkout that has never been built serves nothing,
 * and `slick doctor` says so.
 */
export function resolveWebRoot(explicit?: string | null): string | null {
  const candidates = [explicit, process.env.SLICK_WEB_ROOT, resolve(here, '../public')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  return null;
}

/**
 * The manifest, with the token folded into `start_url`.
 *
 * An installed app launches with what the manifest told it and nothing else. A
 * bare `start_url` leaves it relying on a cookie it has no guarantee of — its
 * storage may be a fresh profile, a jar the user cleared, or, on iOS, a
 * home-screen app that was never given Safari's to begin with. Missing that
 * cookie it launches into the 401 page, whose advice is to run `slick app` —
 * which opens a browser, not the app you are standing in. So it carries its own
 * way in.
 *
 * This is not a wider exposure than the manifest already was: it 401s like
 * everything else, so only a caller that could already read the token gets it.
 *
 * @returns JSON, or null if there is no manifest to serve
 */
export function manifestWithToken(webRoot: string | null, token: string | null): string | null {
  if (!webRoot || !token) return null;
  const file = join(resolve(webRoot), 'manifest.webmanifest');
  if (!existsSync(file)) return null;
  try {
    const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(manifest)) return null;
    // Origin-relative, so it keeps working whatever port the daemon came up
    // on, and inside `scope` — a start_url outside it is not installable.
    manifest.start_url = `/?token=${encodeURIComponent(token)}`;
    return JSON.stringify(manifest);
  } catch {
    return null;
  }
}

/**
 * A short digest of every file under the web root.
 *
 * This is what tells an installed app that it is out of date. Its own version
 * number cannot: that is the daemon's, hand-written, and unchanged across the
 * builds a phone actually needs to notice. Size and mtime are enough — the
 * files are read off local disk, and the question is only "is this the same
 * build I already have".
 */
export function buildStamp(webRoot: string | null): string | null {
  if (!webRoot) return null;
  const root = resolve(webRoot);
  if (!existsSync(root)) return null;
  const hash = createHash('sha1');
  // Sorted, so the stamp is a property of the tree and not of the order the
  // filesystem happened to hand it back in.
  for (const entry of readdirSync(root, { recursive: true }).sort()) {
    const file = join(root, String(entry));
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // vanished between the listing and the stat — not part of a build
    }
    if (stat.isDirectory()) continue;
    hash.update(`${String(entry)}:${stat.size}:${Math.round(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex').slice(0, 10);
}

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;

export function createStaticHandler(webRoot: string | null): StaticHandler {
  const root = webRoot ? resolve(webRoot) : null;

  /**
   * @returns true when the request was handled
   */
  return function serve(_req, res, pathname) {
    if (!root) return false;
    const relative = normalize(safeDecode(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, relative === '/' || relative === '\\' ? 'index.html' : relative);
    if (!file.startsWith(root)) return false;

    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      // Single-page app: unknown paths still boot the shell.
      if (extname(relative)) return false;
      file = join(root, 'index.html');
      if (!existsSync(file)) return false;
    }

    const stat = statSync(file);
    const immutable = pathname.startsWith(IMMUTABLE_PREFIX) && file !== join(root, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
    return true;
  };
}
