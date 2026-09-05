/**
 * The shapes only the browser knows about: what the wire's frames look like
 * once they are in the app, and the states a reader sees that never touch the
 * database.
 *
 * Everything that crosses the daemon boundary is `@slick/core`'s type — a
 * message, a channel, a session — imported rather than redeclared.
 */

import type { HydratedEvent, ThinkingTrace } from '@slick/core';

import type { ThinkingView } from '../features/thinking/thinking.ts';

/**
 * Where a message is drawn. A thread root is on screen twice while its pane is
 * open — once in the channel, once at the top of the pane — and the two copies
 * share their state but not their ids.
 */
export type Surface = 'timeline' | 'thread';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

/**
 * An answer arriving a token at a time, before it is a message. Torn down
 * three ways, like the typing indicator it stands in for: the producer says
 * it is done, the message it was building lands, or a backstop timer gives up
 * on a process that died mid-sentence.
 */
export interface StreamingReply {
  agentId: string;
  text: string;
  think: ThinkingView;
  /** When the last piece arrived. */
  at: number;
}

/** The one frame that is in no event log: a fragment of an answer in flight. */
export interface DeltaFrame {
  type: 'agent.delta';
  threadId: string;
  channelId: string;
  actor: { id: string; kind: 'agent' };
  text?: string | null;
  think?: ThinkingTrace | null;
  done: boolean;
  at: number;
}

/** The stream's opening frame: where the log currently ends. */
export interface ReadyFrame {
  type: 'stream.ready';
  seq: number;
  since: number | null;
}

export type LiveFrame = HydratedEvent | DeltaFrame | ReadyFrame;

/** Where a slash command's answer, or an error nobody else needs to see, is drawn. */
export interface EphemeralOutput {
  title: string;
  body: string;
  kind: '' | 'warn';
}
