/**
 * Serves the web UI. The desktop shell loads the very same files over
 * http://127.0.0.1, which is why a browser tab is a perfectly good fallback
 * when Electron is not installed — and why the future mobile client has
 * nothing new to talk to.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
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
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const here = dirname(fileURLToPath(import.meta.url));

/** Find the UI whether we run from the repo, a workspace symlink, or a bundle. */
export function resolveWebRoot(explicit) {
  const candidates = [
    explicit,
    process.env.SLICK_WEB_ROOT,
    resolve(here, '../public'),
    resolve(here, '../../../apps/web'),
    resolve(here, '../../../../apps/web'),
  ].filter(Boolean);
  for (const candidate of candidates) {
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
 * @returns {string|null} JSON, or null if there is no manifest to serve
 */
export function manifestWithToken(webRoot, token) {
  if (!webRoot || !token) return null;
  const file = join(resolve(webRoot), 'manifest.webmanifest');
  if (!existsSync(file)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    // Relative, so it keeps working whatever port the daemon came up on, and
    // stays inside `scope` — a start_url outside it is not installable.
    manifest.start_url = `./?token=${encodeURIComponent(token)}`;
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
export function buildStamp(webRoot) {
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
    hash.update(`${entry}:${stat.size}:${Math.round(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex').slice(0, 10);
}

/**
 * The service worker, with the build stamp folded into it.
 *
 * A worker is only replaced when its own bytes change, so a shell that ships
 * new JS behind an unchanged `sw.js` leaves every installed app on the worker
 * it already has — and a phone that is resumed rather than relaunched can sit
 * on that for weeks. Folding the stamp in makes any change to the UI a change
 * to the worker, which is the one thing browsers do check for on their own.
 *
 * @returns {string|null} the source, or null if there is no worker to serve
 */
export function serviceWorkerWithBuild(webRoot, stamp) {
  if (!webRoot || !stamp) return null;
  const file = join(resolve(webRoot), 'sw.js');
  if (!existsSync(file)) return null;
  try {
    const source = readFileSync(file, 'utf8');
    // Served raw (no daemon in front of it) the placeholder stands, and the
    // worker still works — it just stops noticing builds on its own.
    return source.replace("'__BUILD__'", JSON.stringify(stamp));
  } catch {
    return null;
  }
}

export function createStaticHandler(webRoot) {
  const root = webRoot ? resolve(webRoot) : null;

  /**
   * @returns {boolean} true when the request was handled
   */
  return function serve(req, res, pathname) {
    if (!root) return false;
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
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
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
    return true;
  };
}
