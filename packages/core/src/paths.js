/**
 * Where Slick keeps its state.
 *
 * Everything lives under one directory so the whole workspace is a single
 * thing to back up, sync, or throw away. `SLICK_HOME` overrides it, which is
 * what the test suite and `--home` use to stay off the real workspace.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** @param {string} [override] */
export function slickHome(override) {
  const raw = override ?? process.env.SLICK_HOME ?? join(homedir(), '.slick');
  return resolve(raw);
}

/** @param {string} [home] */
export function paths(home) {
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
  };
}
