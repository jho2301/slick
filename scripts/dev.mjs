#!/usr/bin/env node
/**
 * The web app in development: Vite with hot reload, talking to a daemon.
 *
 *   npm run dev                      a throwaway, seeded workspace of its own
 *   SLICK_API_URL=http://127.0.0.1:4477 npm run dev
 *                                    the daemon you are already running
 *
 * The throwaway daemon runs with auth off, on a port of its own, on a
 * workspace under the system temp directory that the demo seed fills; the
 * dev server forwards `/api` to it. Nothing here touches `~/.slick`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let api = process.env.SLICK_API_URL ?? null;
let server = null;

if (!api) {
  const { createServer } = await import('@slick/server');
  const home = process.env.SLICK_DEV_HOME ?? mkdtempSync(join(tmpdir(), 'slick-dev-'));
  execFileSync(process.execPath, [join(root, 'scripts/seed-demo.mjs'), '--home', home], { stdio: 'inherit' });
  server = createServer({ home, token: null });
  const bound = await server.listen(0);
  api = bound.url;
  console.log(`dev daemon on ${api} (workspace ${home})`);
} else {
  console.log(`forwarding /api to ${api}`);
}

const vite = spawn(join(root, 'node_modules/.bin/vite'), [], {
  cwd: join(root, 'apps/web'),
  stdio: 'inherit',
  env: { ...process.env, SLICK_API_URL: api },
});

const stop = async (code) => {
  await server?.close();
  process.exit(code ?? 0);
};
vite.on('exit', (code) => void stop(code));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    vite.kill(signal);
  });
}
