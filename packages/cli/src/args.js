/**
 * Argument parsing.
 *
 * Hand-rolled rather than `parseArgs` because Slick commands mix free text
 * with flags (`slick send general deploy is --broken`) and the parser needs to
 * know which flags take a value to get that right.
 */

import { ValidationError } from '@slick/core';

/**
 * @param {string[]} argv
 * @param {{booleans?: string[], strings?: string[], alias?: Record<string, string>}} [spec]
 */
export function parse(argv, spec = {}) {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const alias = spec.alias ?? {};

  const positionals = [];
  /** @type {Record<string, any>} */
  const flags = {};
  let passthrough = false;

  const canonical = (name) => alias[name] ?? name;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[canonical(body.slice(0, eq))] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith('no-')) {
        const name = canonical(body.slice(3));
        if (booleans.has(name)) {
          flags[name] = false;
          continue;
        }
      }
      const name = canonical(body);
      if (booleans.has(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      if (strings.has(name)) {
        if (next === undefined) throw new ValidationError(`--${body} needs a value.`);
        flags[name] = next;
        i++;
        continue;
      }
      // Unknown flag: take a value if one obviously follows.
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }

    if (token.length > 1 && token.startsWith('-') && !/^-\d/.test(token)) {
      const letters = token.slice(1).split('');
      for (let j = 0; j < letters.length; j++) {
        const name = canonical(letters[j]);
        const isLast = j === letters.length - 1;
        if (strings.has(name) && isLast) {
          const next = argv[i + 1];
          if (next === undefined) throw new ValidationError(`-${letters[j]} needs a value.`);
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }

    positionals.push(token);
  }

  return { _: positionals, flags };
}

/** Flags every command understands. */
export const GLOBAL_SPEC = {
  booleans: ['json', 'help', 'version', 'color', 'quiet', 'plain'],
  strings: ['home', 'remote', 'token', 'as'],
  alias: { h: 'help', j: 'json', v: 'version', q: 'quiet' },
};

/** Merge a command's spec with the global one. */
export function withGlobals(spec = {}) {
  return {
    booleans: [...(GLOBAL_SPEC.booleans ?? []), ...(spec.booleans ?? [])],
    strings: [...(GLOBAL_SPEC.strings ?? []), ...(spec.strings ?? [])],
    alias: { ...GLOBAL_SPEC.alias, ...(spec.alias ?? {}) },
  };
}

/**
 * Read piped stdin. Lets agents do `… | slick send general -`.
 *
 * `timeoutMs` guards the case where we are only *guessing* that input is
 * coming: a parent process can hold a pipe open forever without writing to
 * it, and hanging a CLI on that is much worse than giving up.
 * @param {{timeoutMs?: number}} [opts]
 */
export async function readStdin(opts = {}) {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  const collect = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  })();

  if (!opts.timeoutMs) return collect;
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), opts.timeoutMs);
    timer.unref();
  });
  const result = await Promise.race([collect, timeout]);
  return result ?? Buffer.concat(chunks).toString('utf8');
}

/**
 * Message text comes from the remaining positionals, from `-`, or from a pipe
 * when no words were given at all. Words that are present but blank are a
 * mistake, not an invitation to go looking at stdin.
 * @param {string[]} words
 */
export async function resolveText(words) {
  const joined = words.join(' ').trim();
  if (joined && joined !== '-') return joined;

  const explicit = words.some((word) => word.trim() === '-');
  if (words.length > 0 && !explicit) {
    throw new ValidationError('Message text is empty.', {
      hint: 'Pass some text, or pipe it in and use "-".',
    });
  }

  const piped = (await readStdin(explicit ? {} : { timeoutMs: 1500 })).replace(/\n+$/, '');
  if (piped.trim()) return piped;
  throw new ValidationError('No message text.', {
    hint: 'Pass it as arguments, or pipe it in and use "-".',
  });
}

/** `--meta '{"a":1}'` */
export function parseJsonFlag(value, flagName) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`--${flagName} needs a JSON value.`);
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new ValidationError(`--${flagName} is not valid JSON: ${err.message}`, {
      details: { value },
    });
  }
}
