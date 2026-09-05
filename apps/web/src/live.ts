/**
 * The live signals: who is typing, and the answers arriving a token at a time.
 *
 * Both carry timers, which is why they live here rather than in atoms. A
 * "stuck on" with no matching "off" — the agent process died mid-call — must
 * not leave an indicator spinning forever, so every signal is backed by the
 * same five-minute backstop, and what the atoms hold is only a snapshot of
 * what the timers currently believe.
 *
 * A streaming reply is the one thing in the app that changes faster than it
 * is worth drawing. Tokens are folded into the reply as they arrive and the
 * atom for that thread is written once per animation frame — so a reader sees
 * every character, and React sees sixty updates a second at most.
 */

import type { ThinkingEntry, TypingEntry } from '@slick/core';

import { streamingActiveAtom, streamingAtoms, typingAtom } from './atoms.ts';
import { applyChunk, emptyThink } from './lib/thinking.ts';
import { api, store } from './store.ts';
import { forgetThink } from './think-state.ts';
import type { DeltaFrame, StreamingReply } from './types.ts';

// A stuck "on" with no matching "off" (the agent process died mid-call)
// should not leave the indicator spinning forever.
export const TYPING_TIMEOUT_MS = 5 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;

// ---------------------------------------------------------------- typing ---

/** threadId → agentId → the backstop timer that switches it off. */
const typing = new Map<string, Map<string, Timer>>();

function publishTyping(): void {
  const snapshot = new Map<string, readonly string[]>();
  for (const [threadId, agents] of typing) snapshot.set(threadId, [...agents.keys()]);
  store.set(typingAtom, snapshot);
}

/** `off` normally arrives from the agent itself; the timeout is only a backstop for a process that died mid-call. */
export function setTyping(threadId: string, agentId: string, on: boolean): void {
  let entry = typing.get(threadId);
  if (on) {
    if (!entry) {
      entry = new Map();
      typing.set(threadId, entry);
    }
    clearTimeout(entry.get(agentId));
    entry.set(
      agentId,
      setTimeout(() => setTyping(threadId, agentId, false), TYPING_TIMEOUT_MS)
    );
  } else if (entry) {
    clearTimeout(entry.get(agentId));
    entry.delete(agentId);
    if (entry.size === 0) typing.delete(threadId);
  } else {
    return;
  }
  publishTyping();
}

export function typingAgents(threadId: string): readonly string[] {
  return store.get(typingAtom).get(threadId) ?? [];
}

// ------------------------------------------------------------- streaming ---

interface StreamingEntry {
  reply: StreamingReply;
  timer: Timer | null;
  dirty: boolean;
}

const streaming = new Map<string, StreamingEntry>();
let flushScheduled = false;

/** The key the thinking box on an arriving answer keeps its state under. */
export const streamingThinkKey = (threadId: string): string => `streaming-${threadId}`;

/** A fresh object per frame: the entry is mutated in place, and React compares by identity. */
function snapshotReply(reply: StreamingReply): StreamingReply {
  return {
    agentId: reply.agentId,
    text: reply.text,
    at: reply.at,
    think: { ...reply.think, steps: reply.think.steps.map((step) => ({ ...step })) },
  };
}

function flush(): void {
  flushScheduled = false;
  for (const [threadId, entry] of streaming) {
    if (!entry.dirty) continue;
    entry.dirty = false;
    store.set(streamingAtoms(threadId), snapshotReply(entry.reply));
  }
}

/**
 * On the next frame, or the next tick where there are no frames. Whatever has
 * accumulated by then goes out at once.
 */
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

function publishActive(): void {
  store.set(streamingActiveAtom, new Set(streaming.keys()));
}

/** The answer arriving in a thread, as the timers currently hold it. */
export function streamingFor(threadId: string): StreamingReply | null {
  return streaming.get(threadId)?.reply ?? null;
}

/**
 * Start or extend the streaming reply for a thread. The first frame is drawn
 * at once — a bubble has to appear before it can grow — and every one after
 * it waits for the frame clock.
 */
export function touchStreaming(
  threadId: string,
  { agentId, think, text }: { agentId?: string | null; think?: unknown; text?: string | null }
): StreamingReply {
  let entry = streaming.get(threadId);
  const fresh = !entry;
  if (!entry) {
    entry = {
      reply: { agentId: agentId || 'agent', text: '', think: emptyThink(), at: Date.now() },
      timer: null,
      dirty: false,
    };
    streaming.set(threadId, entry);
  }
  const { reply } = entry;
  if (agentId) reply.agentId = agentId;
  if (think) reply.think = applyChunk(reply.think, think);
  if (typeof text === 'string') reply.text += text;
  reply.at = Date.now();
  // Same backstop as typing, for the same reason: the "done" frame is
  // ephemeral, so a producer that dies mid-answer sends nothing at all.
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => clearStreaming(threadId), TYPING_TIMEOUT_MS);

  if (fresh) {
    store.set(streamingAtoms(threadId), snapshotReply(reply));
    publishActive();
  } else {
    entry.dirty = true;
    scheduleFlush();
  }
  return reply;
}

/** The answer landed, or gave up. Either way the placeholder goes. */
export function clearStreaming(threadId: string): void {
  const entry = streaming.get(threadId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  streaming.delete(threadId);
  store.set(streamingAtoms(threadId), null);
  streamingAtoms.remove(threadId);
  forgetThink(streamingThinkKey(threadId));
  publishActive();
}

/**
 * A token, or a handful of them. `done` is the producer saying there is no
 * more coming, which usually arrives a beat after the finished message has
 * already cleared the bubble.
 */
export function applyDelta(frame: DeltaFrame): void {
  const threadId = frame.threadId;
  if (!threadId) return;
  if (frame.done) {
    clearStreaming(threadId);
    return;
  }
  touchStreaming(threadId, { agentId: frame.actor?.id, think: frame.think, text: frame.text });
}

/**
 * Who is working right now, asked rather than waited for.
 *
 * The stream carries typing as a change; a tab that opens in the middle of a
 * reply never saw it, and shows nothing for the rest of the call. So the app
 * asks once on boot and again whenever a dropped stream comes back.
 */
export async function refreshTyping(): Promise<void> {
  let current: TypingEntry[];
  try {
    current = await api.typing();
  } catch {
    return; // an older daemon, or one that is down: keep what we have
  }
  // Only ever adds. Switching an indicator *off* is the event stream's job —
  // a reconnect replays the "off" it missed — and the snapshot cannot see a
  // watcher whose lock lives on another machine, so a gap in it is not proof
  // that nobody is working. What it cannot correct, the timer will.
  for (const entry of current) setTyping(entry.threadId, entry.agentId, true);

  // The scratchpad has exactly the same hole in it, and the same fix. It is
  // asked for separately rather than in parallel because a daemon old enough
  // not to have this route still has the typing one, and losing typing to a
  // 404 on thinking would be a poor trade.
  let scratch: ThinkingEntry[];
  try {
    scratch = await api.thinkingSnapshot();
  } catch {
    return;
  }
  for (const entry of scratch) {
    if (!entry.threadId || !entry.think) continue;
    touchStreaming(entry.threadId, { agentId: entry.agentId, think: entry.think });
  }
}

/** For tests: forget every signal and timer. */
export function resetLive(): void {
  for (const agents of typing.values()) for (const timer of agents.values()) clearTimeout(timer);
  typing.clear();
  publishTyping();
  for (const threadId of [...streaming.keys()]) clearStreaming(threadId);
}
