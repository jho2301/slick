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
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
const { paths } = await import('@slick/core/paths');
const { createServer, newToken, VERSION } = await import('../src/index.js');
const { writeDaemonFile, clearDaemonFile, readDaemonFile, daemonStatus } = await import('../src/daemon.js');

const execFileAsync = promisify(execFile);

/** Reuse the token across restarts so cookies and installed PWAs stay logged in. */
function persistedToken(home) {
  const p = paths(home);
  const saved = existsSync(p.tokenFile) ? readFileSync(p.tokenFile, 'utf8').trim() : '';
  if (saved) return saved;
  const fresh = newToken();
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.tokenFile, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

/**
 * This machine's own Tailscale MagicDNS name, if `tailscaled` is running.
 * Requests bearing this Host header can only reach us over loopback via
 * `tailscale serve`'s local proxy, which forwards traffic that already
 * passed tailnet auth — so it is safe to exempt from the Host-header pin.
 */
async function tailscaleDnsName() {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 1500 });
    const name = JSON.parse(stdout).Self?.DNSName;
    return name ? name.replace(/\.$/, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    'trust-host': { type: 'string', multiple: true },
    'no-tailscale': { type: 'boolean', default: false },
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
  --host <addr>      interface to bind (default 127.0.0.1; also $SLICK_HOST)
  --token <str>      shared token (default: persisted in <home>/token,
                      generated once; also $SLICK_TOKEN)
  --trust-host <name> extra Host header to accept while bound to loopback
                      (repeatable); the machine's Tailscale MagicDNS name
                      is trusted automatically unless --no-tailscale
  --no-tailscale     skip Tailscale MagicDNS auto-detection
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

const token = values['no-auth']
  ? null
  : (values.token ?? process.env.SLICK_TOKEN ?? persistedToken(home));
const host = values.host ?? process.env.SLICK_HOST;
const trustedHosts = [
  ...(values['trust-host'] ?? []),
  ...(values['no-tailscale'] ? [] : [await tailscaleDnsName()]),
].filter(Boolean);
const app = createServer({
  home,
  token,
  host,
  trustedHosts,
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
