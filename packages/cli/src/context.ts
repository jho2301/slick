/**
 * What every command is handed, and the shape a command has.
 *
 * `ws` is the workspace the CLI resolved — the SQLite file opened directly, or
 * a daemon over HTTP — and it is `null` for the few commands that never touch
 * one (`daemon`, `serve`, `app`, `doctor`). Everything else reaches it through
 * `workspaceOf`, which is where "this command needs a workspace" is said once.
 */

import { ValidationError } from '@slick/core';

import type { ArgSpec, Flags } from './args.ts';
import type { WorkspaceApi } from './client.ts';

export interface CommandContext {
  ws: WorkspaceApi | null;
  mode: 'local' | 'remote' | 'none';
  home: string | undefined;
  argv: string[];
  flags: Flags;
  json: boolean;
  quiet: boolean;
  version: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  spec: ArgSpec;
  run(ctx: CommandContext): Promise<void>;
}

/** The workspace a command was given, or the error for one that was not. */
export function workspaceOf(ctx: CommandContext): WorkspaceApi {
  if (!ctx.ws) {
    throw new ValidationError('This command needs a workspace.', {
      hint: 'Run it without --remote pointing nowhere, or start the daemon first.',
    });
  }
  return ctx.ws;
}
