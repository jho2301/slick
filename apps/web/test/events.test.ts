/**
 * The stream, applied to the store — without a component in the loop.
 *
 * Every frame the daemon sends is a fact about the workspace; these pin what
 * each one does to the atoms, which is the whole of what the screen draws.
 */

import type { Channel, HydratedEvent, Message, Thread } from '@slick/core';
import assert from 'node:assert/strict';
import { beforeEach, describe, test, vi } from 'vitest';

import {
  atBottomAtom,
  channelsAtom,
  currentChannelAtom,
  editingAtom,
  jumpVisibleAtom,
  messagesAtom,
  seqAtom,
  streamingActiveAtom,
  streamingAtoms,
  threadAtom,
  typingAtom,
  unreadAtom,
} from '../src/app/atoms.ts';
import { applyFrame } from '../src/app/events.ts';
import { resetLive } from '../src/app/live.ts';
import { api, store } from '../src/app/store.ts';

const AT = 1787457959755;

const channel = (slug: string, id = `ch_${slug}`): Channel => ({
  id,
  slug,
  name: slug,
  topic: '',
  purpose: '',
  kind: 'channel',
  categoryId: null,
  category: null,
  position: 0,
  archived: false,
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
  createdBy: 'fano',
  lastMessageAt: null,
});

let seq = 1;
const message = (overrides: Partial<Message> = {}): Message => {
  const id = overrides.id ?? `msg_${seq}`;
  return {
    id,
    channelId: 'ch_general',
    channelSlug: 'general',
    parentId: null,
    threadId: id,
    isThreadRoot: true,
    author: { id: 'fano', kind: 'human', label: 'Fano' },
    text: 'hello',
    mentions: [],
    metadata: null,
    sessionKey: null,
    seq: seq++,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: AT,
    updatedAt: AT,
    editedAt: null,
    deleted: false,
    deletedAt: null,
    ...overrides,
  };
};

const event = (type: string, overrides: Partial<HydratedEvent> = {}): HydratedEvent => ({
  seq: seq++,
  type,
  actor: { id: 'fano', kind: 'human' },
  channelId: null,
  messageId: null,
  threadId: null,
  sessionKey: null,
  payload: {},
  createdAt: Date.now(),
  ...overrides,
});

beforeEach(() => {
  resetLive();
  store.set(channelsAtom, [channel('general'), channel('deploys')]);
  store.set(currentChannelAtom, channel('general'));
  store.set(messagesAtom, []);
  store.set(threadAtom, null);
  store.set(unreadAtom, new Map());
  store.set(editingAtom, null);
  store.set(atBottomAtom, true);
  store.set(jumpVisibleAtom, false);
  store.set(seqAtom, 0);
  vi.spyOn(api, 'agentSessions').mockResolvedValue([]);
});

describe('the seq', () => {
  test('stream.ready sets where the log ends, and every frame after moves it forward', async () => {
    await applyFrame({ type: 'stream.ready', seq: 40, since: null });
    assert.equal(store.get(seqAtom), 40);
    await applyFrame(event('agent.session.updated', { seq: 42 }));
    assert.equal(store.get(seqAtom), 42);
    await applyFrame(event('agent.session.updated', { seq: 41 }));
    assert.equal(store.get(seqAtom), 42, 'never backwards');
  });

  test('a delta carries no seq and moves nothing', async () => {
    store.set(seqAtom, 10);
    await applyFrame({
      type: 'agent.delta',
      threadId: 'msg_x',
      channelId: 'ch_general',
      actor: { id: 'claude', kind: 'agent' },
      text: 'hi',
      done: false,
      at: Date.now(),
    });
    assert.equal(store.get(seqAtom), 10);
  });
});

describe('message.created', () => {
  test('in the current channel it lands in the timeline, once', async () => {
    const m = message();
    await applyFrame(event('message.created', { message: m, channelId: m.channelId, messageId: m.id }));
    await applyFrame(event('message.created', { message: m, channelId: m.channelId, messageId: m.id }));
    assert.deepEqual(
      store.get(messagesAtom).map((x) => x.id),
      [m.id]
    );
    assert.equal(store.get(jumpVisibleAtom), false, 'a reader at the bottom follows');
  });

  test('a reader scrolled up is offered a way down instead of being moved', async () => {
    store.set(atBottomAtom, false);
    const m = message();
    await applyFrame(event('message.created', { message: m, channelId: m.channelId, messageId: m.id }));
    assert.equal(store.get(jumpVisibleAtom), true);
  });

  test('in another channel it counts as unread there', async () => {
    const m = message({ channelId: 'ch_deploys', channelSlug: 'deploys' });
    await applyFrame(event('message.created', { message: m, channelId: m.channelId, messageId: m.id }));
    assert.equal(store.get(messagesAtom).length, 0);
    assert.equal(store.get(unreadAtom).get('ch_deploys'), 1);
  });

  test('a reply bumps its root’s count and joins the open thread', async () => {
    const root = message({ id: 'msg_root' });
    store.set(messagesAtom, [root]);
    const thread: Thread = { root, replies: [], replyCount: 0, channel: channel('general') };
    store.set(threadAtom, thread);
    const reply = message({ id: 'msg_reply', parentId: root.id, threadId: root.id, isThreadRoot: false });
    await applyFrame(
      event('message.created', { message: reply, channelId: reply.channelId, messageId: reply.id })
    );
    assert.equal(store.get(messagesAtom)[0]!.replyCount, 1);
    assert.equal(store.get(messagesAtom)[0]!.lastReplyAt, reply.createdAt);
    assert.deepEqual(
      store.get(threadAtom)!.replies.map((m) => m.id),
      ['msg_reply']
    );
  });

  test('an agent’s finished message clears the answer that was streaming into that thread', async () => {
    const root = message({ id: 'msg_root' });
    store.set(messagesAtom, [root]);
    await applyFrame({
      type: 'agent.delta',
      threadId: root.id,
      channelId: root.channelId,
      actor: { id: 'claude', kind: 'agent' },
      text: 'Working on',
      done: false,
      at: Date.now(),
    });
    assert.ok(store.get(streamingActiveAtom).has(root.id));
    assert.equal(store.get(streamingAtoms(root.id))?.text, 'Working on');

    // A human's reply mid-answer must not wipe the answer…
    const human = message({ id: 'msg_h', parentId: root.id, threadId: root.id, isThreadRoot: false });
    await applyFrame(
      event('message.created', { message: human, channelId: human.channelId, messageId: human.id })
    );
    assert.ok(store.get(streamingActiveAtom).has(root.id));

    // …but the agent's own does.
    const answer = message({
      id: 'msg_a',
      parentId: root.id,
      threadId: root.id,
      isThreadRoot: false,
      author: { id: 'claude', kind: 'agent', label: 'claude' },
    });
    await applyFrame(
      event('message.created', { message: answer, channelId: answer.channelId, messageId: answer.id })
    );
    assert.ok(!store.get(streamingActiveAtom).has(root.id));
    assert.equal(store.get(streamingAtoms(root.id)), null);
  });
});

describe('message.updated and message.deleted', () => {
  test('an edit lands in the timeline and in the open thread', async () => {
    const root = message({ id: 'msg_root', text: 'typo' });
    store.set(messagesAtom, [root]);
    store.set(threadAtom, { root, replies: [], replyCount: 0, channel: channel('general') });
    const fixed = { ...root, text: 'fixed', editedAt: AT + 1 };
    await applyFrame(event('message.updated', { message: fixed, messageId: root.id }));
    assert.equal(store.get(messagesAtom)[0]!.text, 'fixed');
    assert.equal(store.get(threadAtom)!.root.text, 'fixed');
  });

  test('an edit arriving for the row being edited is left alone', async () => {
    const root = message({ id: 'msg_root', text: 'mine' });
    store.set(messagesAtom, [root]);
    store.set(editingAtom, { id: root.id, surface: 'timeline' });
    await applyFrame(event('message.updated', { message: { ...root, text: 'theirs' }, messageId: root.id }));
    assert.equal(store.get(messagesAtom)[0]!.text, 'mine', 'the editor is not yanked away');
  });

  test('a hard delete drops the row and closes the thread it anchored', async () => {
    const root = message({ id: 'msg_root' });
    store.set(messagesAtom, [root]);
    store.set(threadAtom, { root, replies: [], replyCount: 0, channel: channel('general') });
    await applyFrame(event('message.deleted', { messageId: root.id, payload: { hard: true } }));
    assert.deepEqual(store.get(messagesAtom), []);
    assert.equal(store.get(threadAtom), null);
  });

  test('a soft delete keeps the tombstone in place', async () => {
    const root = message({ id: 'msg_root' });
    store.set(messagesAtom, [root]);
    const gone = { ...root, deleted: true, deletedAt: AT + 1 };
    await applyFrame(
      event('message.deleted', { messageId: root.id, message: gone, payload: { hard: false } })
    );
    assert.equal(store.get(messagesAtom)[0]!.deleted, true);
  });
});

describe('the live signals', () => {
  test('typing switches on and off per agent and thread', async () => {
    await applyFrame(
      event('agent.typing', {
        threadId: 'msg_root',
        actor: { id: 'claude', kind: 'agent' },
        payload: { on: true },
      })
    );
    assert.deepEqual([...store.get(typingAtom).get('msg_root')!], ['claude']);
    await applyFrame(
      event('agent.typing', {
        threadId: 'msg_root',
        actor: { id: 'claude', kind: 'agent' },
        payload: { on: false },
      })
    );
    assert.equal(store.get(typingAtom).get('msg_root'), undefined);
  });

  test('a replayed "on" from long ago is ignored', async () => {
    await applyFrame(
      event('agent.typing', {
        threadId: 'msg_root',
        actor: { id: 'claude', kind: 'agent' },
        payload: { on: true },
        createdAt: Date.now() - 10 * 60 * 1000,
      })
    );
    assert.equal(store.get(typingAtom).get('msg_root'), undefined);
  });

  test('thinking opens an answer-in-progress carrying the steps', async () => {
    await applyFrame(
      event('agent.thinking', {
        threadId: 'msg_root',
        actor: { id: 'claude', kind: 'agent' },
        payload: { think: { s: [{ id: 't1', t: 'Reading the log', st: 'in_progress' }] } },
      })
    );
    const reply = store.get(streamingAtoms('msg_root'));
    assert.equal(reply?.agentId, 'claude');
    assert.equal(reply?.think.steps[0]?.title, 'Reading the log');
  });

  test('a delta with done takes the answer-in-progress back', async () => {
    const frame = {
      type: 'agent.delta' as const,
      threadId: 'msg_root',
      channelId: 'ch_general',
      actor: { id: 'claude', kind: 'agent' as const },
      done: false,
      at: Date.now(),
    };
    await applyFrame({ ...frame, text: 'a' });
    assert.ok(store.get(streamingActiveAtom).has('msg_root'));
    await applyFrame({ ...frame, done: true });
    assert.ok(!store.get(streamingActiveAtom).has('msg_root'));
  });
});

describe('channels and categories', () => {
  test('a channel event refreshes the list and keeps the current channel in step', async () => {
    const renamed = { ...channel('general'), topic: 'renamed' };
    vi.spyOn(api, 'listChannels').mockResolvedValue([renamed, channel('deploys')]);
    await applyFrame(event('channel.updated', { channelId: renamed.id }));
    assert.equal(store.get(currentChannelAtom)?.topic, 'renamed');
  });

  test('a deleted current channel falls back to the first live one', async () => {
    vi.spyOn(api, 'listChannels').mockResolvedValue([channel('deploys')]);
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      channel: channel('deploys'),
      messages: [],
      hasMore: false,
      oldestSeq: null,
      newestSeq: null,
    });
    await applyFrame(event('channel.deleted', { channelId: 'ch_general' }));
    assert.equal(store.get(currentChannelAtom)?.slug, 'deploys');
  });

  test('a category event refreshes the categories', async () => {
    const spy = vi.spyOn(api, 'listCategories').mockResolvedValue([]);
    await applyFrame(event('category.updated'));
    assert.equal(spy.mock.calls.length, 1);
  });
});
