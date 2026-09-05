/**
 * Slash-command autocomplete for a composer textarea, as the rules.
 *
 * The vocabulary is the agent's, not Slick's — the list comes from whatever
 * the session's adapter answered — so this module knows only how to filter it
 * and put a name back in the box. Type `/` at the start of a line, get the
 * agent's commands; the menu component does the arrow keys.
 *
 * A command the agent says it cannot run here is still listed. Hiding it would
 * be pretending it does not exist; showing it greyed, with the reason, is the
 * honest version and doubles as the agent's command reference.
 */

/** One of the agent's commands, as `GET …/commands` describes it. Mirrors the daemon's `CommandEntry`. */
export interface CommandEntry {
  name: string;
  summary?: string;
  args?: string;
  aliases?: string[];
  /** A Slick-side picker to open instead of running the command as typed. */
  picker?: string | null;
  /** What the agent says about running this one here; anything but "run" is shown, not offered. */
  where?: string;
}

export interface CommandList {
  commands: CommandEntry[];
  error: string | null;
  checkedAt: number | null;
}

export interface CommandOutput {
  command: string;
  output: string;
  error: string | null;
}

const NAME_RE = /^[a-z0-9._:-]*$/i;

/** A line that is only a slash command — a question for the agent, not a message. */
export const COMMAND_LINE_RE = /^\/[a-z0-9._:-]+/i;

/**
 * Is the caret inside a `/command` at the very start of the box?
 *
 * Only at the start: a slash anywhere else is a path, a fraction, or the
 * middle of a sentence, and a menu that opens over those is a menu in the way.
 */
export function findCommand(value: string, caret: number): { query: string } | null {
  if (!value.startsWith('/')) return null;
  const head = value.slice(1, caret);
  if (!NAME_RE.test(head)) return null; // past the name; the arguments are the agent's business
  return { query: head };
}

/** What running this one would do, for the line under the name. */
const NOTE: Record<string, string> = {
  run: '',
  session: 'needs a live session',
  terminal: 'terminal only',
};

/** Whether picking this one opens something in Slick rather than running as typed. */
export const isInteractive = (item: CommandEntry): boolean => item.picker === 'model';

/** Listed, but greyed: the agent says it cannot run here, and there is no picker to open instead. */
export const isUnavailable = (item: CommandEntry): boolean =>
  Boolean(item.where && item.where !== 'run' && !isInteractive(item));

/** The line under the name: what picking it does, or why it cannot be picked. */
export function commandNote(item: CommandEntry): string {
  if (isInteractive(item)) return 'choose provider and model';
  const where = item.where ?? 'run';
  return NOTE[where] ?? where;
}

/**
 * The commands worth offering for what has been typed so far.
 *
 * Runnable ones first: the list is long, and what you can actually do should
 * not be below what you cannot.
 */
export function commandMatches(all: readonly CommandEntry[], query: string): CommandEntry[] {
  const wanted = query.toLowerCase();
  const matches = (item: CommandEntry) =>
    item.name.toLowerCase().startsWith(wanted) ||
    (item.aliases ?? []).some((alias) => String(alias).toLowerCase().startsWith(wanted));
  return all
    .filter(matches)
    .sort((a, b) => Number((a.where ?? 'run') !== 'run') - Number((b.where ?? 'run') !== 'run'))
    .slice(0, 10);
}

/**
 * The box with just the name and a space: what follows is the command's own
 * arguments, and the hint in the menu already said what they look like.
 */
export function insertCommand(value: string, name: string): { value: string; caret: number } {
  const insert = `/${name} `;
  return {
    value:
      insert +
      value
        .slice(1)
        .replace(/^[a-z0-9._:-]*/i, '')
        .replace(/^ /, ''),
    caret: insert.length,
  };
}
