/**
 * Where Slick keeps its state.
 *
 * Everything lives under one directory so the whole workspace is a single
 * thing to back up, sync, or throw away. `SLICK_HOME` overrides it, which is
 * what the test suite and `--home` use to stay off the real workspace.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function slickHome(override?: string | null): string {
  const raw = override ?? process.env.SLICK_HOME ?? join(homedir(), '.slick');
  return resolve(raw);
}

export interface SlickPaths {
  root: string;
  db: string;
  daemonFile: string;
  daemonLog: string;
  tokenFile: string;
  noAuthFile: string;
  uploads: string;
  adapters: string;
}

export function paths(home?: string | null): SlickPaths {
  const root = slickHome(home);
  return {
    root,
    db: join(root, 'slick.db'),
    daemonFile: join(root, 'daemon.json'),
    daemonLog: join(root, 'daemon.log'),
    tokenFile: join(root, 'token'),
    // Presence of this file turns token auth off permanently for this
    // workspace; see `slickd --no-auth`.
    noAuthFile: join(root, 'no-auth'),
    uploads: join(root, 'files'),
    // One JSON file per agent adapter; see `adapters.ts`.
    adapters: join(root, 'adapters'),
  };
}
