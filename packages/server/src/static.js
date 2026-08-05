/**
 * Serves the web UI. The desktop shell loads the very same files over
 * http://127.0.0.1, which is why a browser tab is a perfectly good fallback
 * when Electron is not installed — and why the future mobile client has
 * nothing new to talk to.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
