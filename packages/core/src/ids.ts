/**
 * Sortable, collision-resistant identifiers (ULID-shaped).
 *
 * 26 chars of Crockford base32: 10 chars of millisecond timestamp followed by
 * 16 chars of randomness. Lexicographic order matches creation order, which
 * keeps `ORDER BY id` meaningful and makes ids pleasant to eyeball in a CLI.
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase, no i/l/o/u
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(len: number): number[] {
  const out: number[] = [];
  for (const byte of randomBytes(len)) out.push(byte % 32);
  return out;
}

/** Bump the random suffix so ids minted in the same millisecond stay ordered. */
function incrementRandom(chars: number[]): number[] {
  for (let i = chars.length - 1; i >= 0; i--) {
    if ((chars[i] ?? 0) < 31) {
      chars[i] = (chars[i] ?? 0) + 1;
      return chars;
    }
    chars[i] = 0;
  }
  return randomChars(RANDOM_LEN); // astronomically unlikely overflow
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars(RANDOM_LEN);
  }
  return encodeTime(now) + lastRandom.map((c) => ALPHABET.charAt(c)).join('');
}

/**
 * Prefixed id, e.g. `ch_01k2...`. The prefix makes CLI output self-describing
 * and lets us reject "you passed a channel id where a message id goes".
 */
export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${ulid(now)}`;
}

export const ID_PREFIX = Object.freeze({
  channel: 'ch',
  category: 'cat',
  message: 'msg',
  session: 'ses',
});

export function hasPrefix(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(`${prefix}_`);
}

/**
 * Agent history keys are what an agent writes down and carries between runs,
 * so they are shorter than ids and visually distinct.
 * Shape: `slk_h1_<20 base32 chars>`.
 */
export function newHistoryKey(): string {
  const chars = randomChars(20)
    .map((c) => ALPHABET.charAt(c))
    .join('');
  return `slk_h1_${chars}`;
}

const HISTORY_KEY_RE = /^slk_h1_[0-9a-hjkmnp-tv-z]{20}$/;

export function looksLikeHistoryKey(value: unknown): value is string {
  return typeof value === 'string' && HISTORY_KEY_RE.test(value);
}
