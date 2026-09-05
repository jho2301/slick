import { channel } from './channel.ts';
import { category } from './category.ts';
import { message, read, send, thread } from './message.ts';
import { agent } from './agent.ts';
import { doctor, init, search, status, tail } from './workspace.ts';
import { app, daemon, serve } from './daemon.ts';
import { line, note, style } from '../output.ts';
import type { Command } from '../context.ts';

export const COMMANDS: Command[] = [
  init,
  status,
  send,
  read,
  channel,
  category,
  message,
  thread,
  agent,
  search,
  tail,
  app,
  daemon,
  serve,
  doctor,
];

const BY_NAME = new Map<string, Command>();
for (const command of COMMANDS) {
  BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command);
}

export function findCommand(name: string): Command | null {
  return BY_NAME.get(name) ?? null;
}

/** Commands that never need to touch the workspace database. */
export const NO_WORKSPACE = new Set(['daemon', 'serve', 'app', 'doctor']);

const GROUPS: [string, string[]][] = [
  ['Talking', ['send', 'read', 'thread', 'search', 'tail']],
  ['Organising', ['channel', 'category', 'message', 'status', 'init']],
  ['Agents', ['agent']],
  ['Apps', ['app', 'daemon', 'serve', 'doctor']],
];

export function printHelp(): void {
  line(`${style.bold('slick')} ${style.dim('— a Slack-shaped workspace for you and your agents')}`);
  line();
  line(`${style.dim('usage:')} slick <command> [args] [--json]`);
  for (const [heading, names] of GROUPS) {
    line();
    line(style.bold(heading));
    for (const name of names) {
      const command = BY_NAME.get(name);
      if (command) line(`  ${style.cyan(name.padEnd(10))} ${command.summary}`);
    }
  }
  line();
  line(style.bold('Global options'));
  line(`  ${style.dim('--json')}          machine-readable output (what agents should use)`);
  line(`  ${style.dim('--home <dir>')}    use a different workspace directory`);
  line(`  ${style.dim('--remote <url>')}  drive a daemon over HTTP instead of the local file`);
  line(`  ${style.dim('--no-color')}      plain text`);
  line(`  ${style.dim('-q, --quiet')}     print only the essential value`);
  line();
  note('  slick <command> --help   for details on any command');
}

export function printCommandHelp(command: Command): void {
  line(command.usage ?? `slick ${command.name}`);
}
