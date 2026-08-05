/**
 * Daemon lifecycle: find it, start it, stop it.
 *
 * `~/.slick/daemon.json` is the rendezvous point — it holds the pid, the port
 * that was actually bound and the shared token. Anything that wants to reach
 * a running workspace (the CLI's `--remote` mode, the Electron shell, a
 * future phone on the same wifi) reads that one file.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '@slick/core/paths';

const here = dirname(fileURLToPath(import.meta.url));
export const SLICKD_ENTRY = resolve(here, '../bin/slickd.js');

export function readDaemonFile(home) {
  const file = paths(home).daemonFile;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeDaemonFile(home, info) {
  const p = paths(home);
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.daemonFile, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  return info;
}

export function clearDaemonFile(home) {
  rmSync(paths(home).daemonFile, { force: true });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** @param {{url: string, token?: string|null, timeoutMs?: number}} target */
export async function ping(target) {
  try {
    const res = await fetch(`${target.url}/api/health`, {
      headers: target.token ? { authorization: `Bearer ${target.token}` } : {},
      signal: AbortSignal.timeout(target.timeoutMs ?? 1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * @param {string} [home]
 * @returns {Promise<{running: boolean, stale?: boolean} & Record<string, any>>}
 */
export async function daemonStatus(home) {
  const info = readDaemonFile(home);
  if (!info) return { running: false };
  const health = await ping(info);
  if (health) return { running: true, ...info, health };
  const stale = !pidAlive(info.pid);
  return { running: false, stale, ...info };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the daemon in the background and wait until it answers.
 * @param {{home?: string, port?: number, host?: string, webRoot?: string, timeoutMs?: number}} [opts]
 */
export async function startDaemon(opts = {}) {
  const home = opts.home;
  const existing = await daemonStatus(home);
  if (existing.running) return { ...existing, alreadyRunning: true };
  if (existing.stale) clearDaemonFile(home);

  const p = paths(home);
  mkdirSync(p.root, { recursive: true });
  const log = openSync(p.daemonLog, 'a');

  const args = [SLICKD_ENTRY];
  if (home) args.push('--home', home);
  if (opts.port != null) args.push('--port', String(opts.port));
  if (opts.host) args.push('--host', opts.host);
  if (opts.webRoot) args.push('--web-root', opts.webRoot);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      // When the launcher is the Electron binary, make it behave as plain node.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    await sleep(120);
    const status = await daemonStatus(home);
    if (status.running) return { ...status, started: true, pid: status.pid ?? child.pid };
  }
  throw new Error(
    `The daemon did not come up within ${(opts.timeoutMs ?? 10_000) / 1000}s. See ${p.daemonLog}`
  );
}

/** @param {{home?: string, timeoutMs?: number}} [opts] */
export async function stopDaemon(opts = {}) {
  const info = readDaemonFile(opts.home);
  if (!info) return { stopped: false, reason: 'not running' };
  if (!pidAlive(info.pid)) {
    clearDaemonFile(opts.home);
    return { stopped: false, reason: 'stale record removed', pid: info.pid };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    await sleep(100);
    if (!pidAlive(info.pid)) break;
  }
  if (pidAlive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGKILL');
    } catch {
      /* it exited between the check and the signal */
    }
  }
  clearDaemonFile(opts.home);
  return { stopped: true, pid: info.pid };
}

/** Status, starting the daemon first if it is not already up. */
export async function ensureDaemon(opts = {}) {
  const status = await daemonStatus(opts.home);
  if (status.running) return status;
  return startDaemon(opts);
}
