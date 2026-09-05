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
import { errorCode, isRecord, type JsonObject } from '@slick/core';

const here = dirname(fileURLToPath(import.meta.url));
/** The daemon's entry point. A `.js` shim, so the file name never changes. */
export const SLICKD_ENTRY = resolve(here, '../bin/slickd.js');

/** What `slickd` writes down about itself. */
export interface DaemonInfo {
  pid: number;
  version: string;
  url: string;
  host: string;
  port: number;
  token: string | null;
  home: string;
  db: string;
  webRoot: string | null;
  startedAt: number;
}

/** A daemon that answered, or one that only left a file behind. */
export type DaemonStatus =
  | ({ running: true; health: JsonObject } & DaemonInfo)
  | ({ running: false; stale?: boolean } & Partial<DaemonInfo>);

export function readDaemonFile(home?: string | null): DaemonInfo | null {
  const file = paths(home).daemonFile;
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isRecord(parsed) ? (parsed as unknown as DaemonInfo) : null;
  } catch {
    return null;
  }
}

export function writeDaemonFile(home: string | null | undefined, info: DaemonInfo): DaemonInfo {
  const p = paths(home);
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.daemonFile, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  return info;
}

export function clearDaemonFile(home?: string | null): void {
  rmSync(paths(home).daemonFile, { force: true });
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
}

export interface PingTarget {
  url: string;
  token?: string | null;
  timeoutMs?: number;
}

export async function ping(target: PingTarget): Promise<JsonObject | null> {
  try {
    const res = await fetch(`${target.url}/api/health`, {
      headers: target.token ? { authorization: `Bearer ${target.token}` } : {},
      signal: AbortSignal.timeout(target.timeoutMs ?? 1500),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export async function daemonStatus(home?: string | null): Promise<DaemonStatus> {
  const info = readDaemonFile(home);
  if (!info) return { running: false };
  const health = await ping(info);
  if (health) return { running: true, ...info, health };
  const stale = !pidAlive(info.pid);
  return { running: false, stale, ...info };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StartDaemonOptions {
  home?: string | null;
  port?: number;
  host?: string;
  webRoot?: string;
  timeoutMs?: number;
}

export type StartedDaemon = DaemonStatus & { alreadyRunning?: boolean; started?: boolean };

/**
 * Start the daemon in the background and wait until it answers.
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<StartedDaemon> {
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
    if (status.running) return { ...status, started: true, pid: status.pid ?? child.pid ?? 0 };
  }
  throw new Error(
    `The daemon did not come up within ${(opts.timeoutMs ?? 10_000) / 1000}s. See ${p.daemonLog}`
  );
}

export interface StopResult {
  stopped: boolean;
  reason?: string;
  pid?: number;
}

export async function stopDaemon(
  opts: { home?: string | null; timeoutMs?: number } = {}
): Promise<StopResult> {
  const info = readDaemonFile(opts.home);
  if (!info) return { stopped: false, reason: 'not running' };
  if (!pidAlive(info.pid)) {
    clearDaemonFile(opts.home);
    return { stopped: false, reason: 'stale record removed', pid: info.pid };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (err) {
    if (errorCode(err) !== 'ESRCH') throw err;
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
export async function ensureDaemon(opts: StartDaemonOptions = {}): Promise<StartedDaemon> {
  const status = await daemonStatus(opts.home);
  if (status.running) return status;
  return startDaemon(opts);
}
