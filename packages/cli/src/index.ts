/**
 * CLI entry point: work out which command was asked for, open the right
 * workspace, run it, and turn any error into something a person (or an agent
 * reading `--json`) can act on.
 */

import { SlickError, toSlickError } from '@slick/core';
import { GLOBAL_SPEC, flagOn, flagText, parse, withGlobals } from './args.ts';
import { resolveWorkspace, type ResolvedWorkspace } from './client.ts';
import { COMMANDS, NO_WORKSPACE, findCommand, printCommandHelp, printHelp } from './commands/index.ts';
import { line, setColor, style } from './output.ts';

export const VERSION = '0.6.0';

/** Exit codes worth branching on from a script. */
const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 4,
  conflict: 5,
  unreachable: 6,
};

/**
 * Find the command name without letting a global flag's value be mistaken
 * for it (`slick --home /tmp status` must resolve to `status`).
 */
function splitCommand(argv: string[]): { name: string | null; rest: string[] } {
  const strings = new Set(GLOBAL_SPEC.strings);
  const alias = GLOBAL_SPEC.alias;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--') break;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      if (body.includes('=')) continue;
      if (strings.has(alias[body] ?? body)) i++;
      continue;
    }
    if (token.length > 1 && token.startsWith('-') && !/^-\d/.test(token)) {
      const letters = token.slice(1).split('');
      const last = letters[letters.length - 1] ?? '';
      if (strings.has(alias[last] ?? last)) i++;
      continue;
    }
    return { name: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { name: null, rest: argv };
}

export async function main(argv: string[]): Promise<number> {
  const { name, rest } = splitCommand(argv);
  const command = name ? findCommand(name) : null;

  // Parse with the command's own spec so its value-taking flags behave.
  const { _: positionals, flags } = parse(rest, command ? withGlobals(command.spec) : GLOBAL_SPEC);

  if (flags.color === false || flags.plain) setColor(false);
  if (flags.color === true) setColor(true);

  if (flags.version) {
    line(VERSION);
    return EXIT.ok;
  }
  if (!name || (flags.help && !command)) {
    printHelp();
    return EXIT.ok;
  }
  if (!command) {
    line(`${style.red('✗')} Unknown command ${style.bold(name)}.`);
    const guess = suggest(name);
    if (guess) line(`  Did you mean ${style.bold(guess)}?`);
    line();
    printHelp();
    return EXIT.usage;
  }
  if (flags.help) {
    printCommandHelp(command);
    return EXIT.ok;
  }

  const home = flagText(flags, 'home') ?? process.env.SLICK_HOME;
  let session: ResolvedWorkspace | null = null;
  try {
    const needsWorkspace = !NO_WORKSPACE.has(command.name);
    if (needsWorkspace) {
      session = await resolveWorkspace({
        home,
        remote: flagText(flags, 'remote'),
        token: flagText(flags, 'token'),
      });
    }
    await command.run({
      ws: session?.ws ?? null,
      mode: session?.mode ?? 'none',
      home,
      argv: positionals,
      flags,
      json: flagOn(flags, 'json'),
      quiet: flagOn(flags, 'quiet'),
      version: VERSION,
    });
    return EXIT.ok;
  } catch (err) {
    return report(err, flagOn(flags, 'json'));
  } finally {
    session?.close();
  }
}

function report(err: unknown, asJson: boolean): number {
  const slick = toSlickError(err);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(slick.toJSON(), null, 2)}\n`);
  } else {
    process.stderr.write(`${style.red('✗')} ${slick.message}\n`);
    if (slick.hint) process.stderr.write(`  ${style.dim(slick.hint)}\n`);
    if (!(err instanceof SlickError) && process.env.SLICK_DEBUG) {
      process.stderr.write(`${style.dim(err instanceof Error ? (err.stack ?? '') : '')}\n`);
    }
  }
  switch (slick.code) {
    case 'invalid_request':
      return EXIT.usage;
    case 'not_found':
    case 'unknown_history_key':
      return EXIT.notFound;
    case 'conflict':
      return EXIT.conflict;
    case 'unreachable':
      return EXIT.unreachable;
    default:
      return EXIT.error;
  }
}

/** Cheap edit-distance suggestion so typos are one keystroke from fixed. */
function suggest(input: string): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const command of COMMANDS) {
    for (const candidate of [command.name, ...(command.aliases ?? [])]) {
      const score = distance(input, candidate);
      if (score < bestScore) {
        bestScore = score;
        best = command.name;
      }
    }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: b.length + 1 }, (_, i) => [
    i,
    ...Array<number>(a.length).fill(0),
  ]);
  const at = (i: number, j: number): number => rows[i]?.[j] ?? 0;
  for (let j = 0; j <= a.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      rows[i]![j] = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + (a[j - 1] === b[i - 1] ? 0 : 1)
      );
    }
  }
  return at(b.length, a.length);
}
