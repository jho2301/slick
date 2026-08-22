/**
 * Who is actually listening.
 *
 * Two kinds of agent share the `agent_sessions` table, and from the outside
 * they look identical: both have a history key, both post, both keep a
 * cursor. Only one of them answers.
 *
 *   - A *served* agent has `slick agent serve` watching its session. Mention
 *     it and a process wakes up, thinks, and replies in the thread.
 *   - An *automation* — the cron job that posts the morning digest — only
 *     ever writes. Nothing is watching its session, so a mention lands in the
 *     log and is never read by anyone.
 *
 * Offering the second kind in a mention picker is a small lie the UI tells
 * every time, so the difference is computed here, once, from two signals:
 * the lock file a live watcher holds, and the bookkeeping a watcher leaves in
 * the session state (which outlives the process, and so survives a restart).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { slickHome } from './paths.js';

/** Where `slick agent serve` takes its one-watcher-per-key lock. */
export function serveLockPath(key, home) {
  return join(slickHome(home), `serve-${key}.lock`);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to someone else — still alive.
    return err.code === 'EPERM';
  }
};

/**
 * The watcher holding this session right now, if there is one.
 *
 * A lock left behind by a killed process is not a watcher: the pid is checked
 * rather than trusted, so a machine that lost power does not spend the next
 * week claiming its agents are up.
 *
 * @returns {{pid: number}|null}
 */
export function readServeLock(key, home) {
  let raw;
  try {
    raw = readFileSync(serveLockPath(key, home), 'utf8');
  } catch {
    return null; // no lock, no watcher
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return isAlive(pid) ? { pid } : null;
}

/**
 * Keys only `serve` writes. Their presence means a watcher has run for this
 * session at least once, which is what lets an agent stay listed while its
 * watcher is between restarts.
 *
 * `_serveModel` is deliberately absent: a human can set a model from the app
 * on any session, and wanting an agent served is not the same as serving it.
 */
const SERVE_FOOTPRINT = ['_serveThreads', '_serveSessionId', '_serveStateSig', '_serveModelsAt', '_serveModelChoices'];

/** Has a watcher ever attached to this session? */
export function wasEverServed(state) {
  return SERVE_FOOTPRINT.some((key) => state?.[key] != null);
}

/**
 * Whether an @mention of this session can expect an answer.
 *
 * @param {{key: string, status?: string, state?: Record<string, unknown>}} session
 * @param {string} [home]
 * @returns {{live: boolean, pid: number|null, served: boolean, callable: boolean}}
 */
export function serveStatus(session, home) {
  const lock = readServeLock(session.key, home);
  const served = wasEverServed(session.state);
  const active = (session.status ?? 'active') === 'active';
  return {
    live: Boolean(lock),
    pid: lock?.pid ?? null,
    served,
    // An ended session is retired on purpose; it does not matter who once
    // watched it. Otherwise a watcher that is up now, or was up before this
    // reboot, both mean "someone is home".
    callable: active && (Boolean(lock) || served),
  };
}
