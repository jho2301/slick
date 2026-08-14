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
/** @type {number[]} */
let lastRandom = [];

function encodeTime(now) {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(len) {
  const bytes = randomBytes(len);
  const out = [];
  for (let i = 0; i < len; i++) out.push(bytes[i] % 32);
  return out;
}

/** Bump the random suffix so ids minted in the same millisecond stay ordered. */
function incrementRandom(chars) {
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] < 31) {
      chars[i] += 1;
      return chars;
    }
    chars[i] = 0;
  }
  return randomChars(RANDOM_LEN); // astronomically unlikely overflow
}

/** @param {number} [now] */
export function ulid(now = Date.now()) {
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars(RANDOM_LEN);
  }
  return encodeTime(now) + lastRandom.map((c) => ALPHABET[c]).join('');
}

/**
 * Prefixed id, e.g. `ch_01k2...`. The prefix makes CLI output self-describing
 * and lets us reject "you passed a channel id where a message id goes".
 * @param {string} prefix
 */
export function newId(prefix, now = Date.now()) {
  return `${prefix}_${ulid(now)}`;
}

export const ID_PREFIX = Object.freeze({
  channel: 'ch',
  category: 'cat',
  message: 'msg',
  session: 'ses',
});

/** @param {string} value @param {string} prefix */
export function hasPrefix(value, prefix) {
  return typeof value === 'string' && value.startsWith(`${prefix}_`);
}

/**
 * Agent history keys are what an agent writes down and carries between runs,
 * so they are shorter than ids and visually distinct.
 * Shape: `slk_h1_<20 base32 chars>`.
 */
export function newHistoryKey() {
  const chars = randomChars(20).map((c) => ALPHABET[c]).join('');
  return `slk_h1_${chars}`;
}

const HISTORY_KEY_RE = /^slk_h1_[0-9a-hjkmnp-tv-z]{20}$/;

/** @param {unknown} value */
export function looksLikeHistoryKey(value) {
  return typeof value === 'string' && HISTORY_KEY_RE.test(value);
}
