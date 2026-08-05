#!/usr/bin/env node
/**
 * `slickd` — the Slick daemon entry point.
 *
 * Normally started for you by `slick daemon start` or by the desktop app.
 * Run it directly when you want to watch it: `slickd --foreground`.
 */

// node:sqlite is still flagged experimental; the warning is noise in a CLI.
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message ?? '')) {
    return false;
  }
  return emit.call(this, name, data, ...rest);
};

const { parseArgs } = await import('node:util');
const { paths } = await import('@slick/core/paths');
const { createServer, newToken, VERSION } = await import('../src/index.js');
const { writeDaemonFile, clearDaemonFile, readDaemonFile, daemonStatus } = await import('../src/daemon.js');

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    'web-root': { type: 'string' },
    'no-auth': { type: 'boolean', default: false },
    foreground: { type: 'boolean', short: 'f', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`slickd ${VERSION} — Slick workspace daemon

  --home <dir>       workspace directory (default $SLICK_HOME or ~/.slick)
  --port <n>         port to bind (default 4477, 0 for any free port)
  --host <addr>      interface to bind (default 127.0.0.1)
  --token <str>      shared token (default: generated)
  --web-root <dir>   directory containing the web UI
  --no-auth          disable token auth (loopback only; for tests)
  -f, --foreground   log to stdout instead of running quietly
`);
  process.exit(0);
}

const home = values.home ?? process.env.SLICK_HOME;
const existing = await daemonStatus(home);
if (existing.running) {
  console.error(`slickd is already running on ${existing.url} (pid ${existing.pid})`);
  process.exit(existing.pid === process.pid ? 0 : 3);
}

const token = values['no-auth'] ? null : (values.token ?? process.env.SLICK_TOKEN ?? newToken());
const app = createServer({
  home,
  token,
  host: values.host,
  webRoot: values['web-root'],
});

const requested = values.port != null ? Number(values.port) : Number(process.env.SLICK_PORT ?? 4477);
let bound;
try {
  bound = await app.listen(requested);
} catch (err) {
  if (err.code === 'EADDRINUSE' && requested !== 0) {
    console.error(`port ${requested} is busy, falling back to a free port`);
    bound = await app.listen(0);
  } else {
    throw err;
  }
}

const info = {
  pid: process.pid,
  version: VERSION,
  url: bound.url,
  host: bound.host,
  port: bound.port,
  token,
  home: paths(home).root,
  db: app.ws.file,
  webRoot: app.webRoot,
  startedAt: Date.now(),
};
writeDaemonFile(home, info);

console.log(
  `[${new Date().toISOString()}] slickd ${VERSION} listening on ${bound.url}` +
    ` (db ${app.ws.file}${app.webRoot ? `, ui ${app.webRoot}` : ', no web UI found'})`
);
if (values.foreground) console.log(`open ${bound.url}${token ? `?token=${token}` : ''}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${new Date().toISOString()}] slickd stopping (${signal})`);
  // Only clear the rendezvous file if it still describes us.
  const current = readDaemonFile(home);
  if (current?.pid === process.pid) clearDaemonFile(home);
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (err) => {
  console.error('[slick] fatal:', err);
  shutdown('uncaughtException');
});
