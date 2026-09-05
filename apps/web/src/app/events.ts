/**
 * The stream, applied to the store.
 *
 * One frame at a time: a channel frame awaits a refresh, and two of those
 * interleaving used to reconcile the current channel against each other's
 * half-finished state. Deltas skip the queue — they are ephemeral, carry no
 * seq, and a token waiting behind a category refresh is a token the reader
 * watches arrive late.
 */

import type { HydratedEvent, Message } from '@slick/core';

import { bumpUnread, loadMessages, refreshCategories, refreshChannels, refreshSessions } from './actions.ts';
import {
  atBottomAtom,
  channelsAtom,
  currentChannelAtom,
  editingAtom,
  jumpVisibleAtom,
  messagesAtom,
  seqAtom,
  threadAtom,
} from './atoms.ts';
import { shouldRefreshUsageAfter } from '../features/hermes/hermes-panel.ts';
import {
  applyDelta,
  clearStreaming,
  setTyping,
  streamingFor,
  touchStreaming,
  TYPING_TIMEOUT_MS,
} from './live.ts';
import { closeThread } from './navigation.ts';
import { hermes, store } from './store.ts';
import { forgetThink } from '../features/thinking/think-state.ts';
import type { DeltaFrame, LiveFrame, ReadyFrame } from './types.ts';

// A hydrated event's `type` is any string, so the union does not discriminate
// on its own; these two say which of the three a frame is.
const isDelta = (frame: LiveFrame): frame is DeltaFrame => frame.type === 'agent.delta';
const isReady = (frame: LiveFrame): frame is ReadyFrame => frame.type === 'stream.ready';

const queue: LiveFrame[] = [];
let running = false;

/** Hand a frame to the app. Returns once it is queued, not once it is applied. */
export function dispatch(frame: LiveFrame): void {
  if (isDelta(frame)) {
    // Broadcast with no `id:` line and so no seq of its own: a delta is the one
    // frame in the app that was never written down, and there is nothing to
    // resume it from. It is applied here rather than through the queue, so a
    // stray seq on an ephemeral frame can never move the position we would
    // reconnect at, and a token never waits behind a refresh.
    applyDelta(frame);
    return;
  }
  queue.push(frame);
  if (!running) void drain();
}

async function drain(): Promise<void> {
  running = true;
  try {
    while (queue.length > 0) {
      const frame = queue.shift()!;
      try {
        await handleEvent(frame);
      } catch (err) {
        console.error('event failed', err);
      }
    }
  } finally {
    running = false;
  }
}

/** Apply one frame and wait for it — what a test does, and what `dispatch` does in order. */
export async function applyFrame(frame: LiveFrame): Promise<void> {
  if (isDelta(frame)) {
    applyDelta(frame);
    return;
  }
  await handleEvent(frame);
}

const patchMessages = (message: Message) =>
  store.set(
    messagesAtom,
    store.get(messagesAtom).map((m) => (m.id === message.id ? message : m))
  );

/** Replace the root or a reply of the open thread, if the message is in it. */
function patchThread(message: Message): void {
  const thread = store.get(threadAtom);
  if (!thread) return;
  if (thread.root.id === message.id) {
    store.set(threadAtom, { ...thread, root: message });
    return;
  }
  if (thread.replies.some((m) => m.id === message.id)) {
    store.set(threadAtom, {
      ...thread,
      replies: thread.replies.map((m) => (m.id === message.id ? message : m)),
    });
  }
}

async function handleEvent(frame: LiveFrame): Promise<void> {
  if (isReady(frame)) {
    store.set(seqAtom, frame.seq);
    return;
  }
  if (isDelta(frame)) return;
  const event: HydratedEvent = frame;
  store.set(seqAtom, Math.max(store.get(seqAtom), event.seq ?? 0));

  switch (event.type) {
    case 'message.created': {
      const message = event.message;
      if (!message) return;
      // Whatever was streaming into a bubble is now a real message carrying
      // the whole text, so the stand-in goes before the row that replaces it
      // is drawn — but only for the agent that was writing it. A human
      // replying into the thread mid-answer must not wipe the answer.
      const streaming = streamingFor(message.threadId);
      if (streaming?.agentId === message.author.id) clearStreaming(message.threadId);
      const current = store.get(currentChannelAtom);
      if (message.parentId) {
        const thread = store.get(threadAtom);
        if (thread?.root.id === message.parentId && !thread.replies.some((m) => m.id === message.id)) {
          store.set(threadAtom, { ...thread, replies: [...thread.replies, message] });
        }
        // Keep the "N replies" chip on the root message honest.
        const root = store.get(messagesAtom).find((m) => m.id === message.parentId);
        if (root) patchMessages({ ...root, replyCount: root.replyCount + 1, lastReplyAt: message.createdAt });
        if (message.channelId !== current?.id) bumpUnread(message.channelId);
      } else if (message.channelId === current?.id) {
        const messages = store.get(messagesAtom);
        if (!messages.some((m) => m.id === message.id)) {
          const stick = store.get(atBottomAtom);
          store.set(messagesAtom, [...messages, message]);
          // Pinned readers follow on their own; the rest get a way down.
          if (!stick) store.set(jumpVisibleAtom, true);
        }
      } else {
        bumpUnread(message.channelId);
      }
      if (message.author.kind === 'agent') void refreshSessions();
      // A finished agent turn is the one thing in the app that spends the
      // account, so the limits in the rail go stale exactly here. Past the
      // daemon's cache, because the whole point is the number it holds is now
      // one turn old.
      if (shouldRefreshUsageAfter(message, hermes.state.saved.provider)) void hermes.refreshUsage();
      return;
    }

    case 'message.updated': {
      const message = event.message;
      if (!message) return;
      if (store.get(editingAtom)?.id === message.id) return; // do not yank the editor away
      patchMessages(message);
      patchThread(message);
      return;
    }

    case 'message.deleted': {
      const id = event.messageId;
      if (!id) return;
      if (event.payload.hard) {
        store.set(
          messagesAtom,
          store.get(messagesAtom).filter((m) => m.id !== id)
        );
        forgetThink(id);
        const thread = store.get(threadAtom);
        if (thread?.root.id === id) closeThread();
        else if (thread)
          store.set(threadAtom, { ...thread, replies: thread.replies.filter((m) => m.id !== id) });
      } else if (event.message) {
        patchMessages(event.message);
        patchThread(event.message);
      }
      return;
    }

    case 'agent.typing': {
      if (!event.threadId) return;
      // Typing is a change, not a state, and it lives in the same durable log
      // as everything else, so a reconnect replays old ones. An "on" from long
      // enough ago describes a reply that has been finished for hours.
      const on = Boolean(event.payload.on);
      if (on && Date.now() - (event.createdAt ?? 0) > TYPING_TIMEOUT_MS) return;
      setTyping(event.threadId, event.actor.id || 'agent', on);
      return;
    }

    case 'agent.thinking': {
      if (!event.threadId) return;
      // Thinking rows are durable, exactly like typing, so a reconnect replays
      // the ones from an answer that finished hours ago. Same guard, same
      // reason: an old scratchpad describes a message that is already sitting
      // in the transcript with its working attached.
      if (Date.now() - (event.createdAt ?? 0) > TYPING_TIMEOUT_MS) return;
      const think = event.payload.think;
      if (!think) return;
      touchStreaming(event.threadId, { agentId: event.actor.id || 'agent', think });
      return;
    }

    case 'category.created':
    case 'category.updated':
    case 'category.deleted':
    case 'category.reordered': {
      await refreshCategories();
      // A deleted category leaves its channels behind pointing at nothing.
      if (event.type === 'category.deleted') await refreshChannels();
      return;
    }

    case 'channel.created':
    case 'channel.updated':
    case 'channel.archived':
    case 'channel.unarchived':
    case 'channel.deleted': {
      await refreshChannels();
      const current = store.get(currentChannelAtom);
      if (current) {
        const channels = store.get(channelsAtom);
        const still = channels.find((c) => c.id === current.id);
        if (!still) {
          store.set(currentChannelAtom, channels.find((c) => !c.archived) ?? null);
          await loadMessages();
        } else {
          store.set(currentChannelAtom, still);
        }
      }
      return;
    }

    default:
      if (event.type.startsWith('agent.session')) void refreshSessions();
  }
}
