import type { Channel } from '@slick/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { currentChannelAtom, hasMoreAtom, oldestSeqAtom } from '../src/app/atoms.ts';
import { takeDeepLink } from '../src/app/deep-links.ts';
import { api, store } from '../src/app/store.ts';
import { loadMessages, loadOlder } from '../src/features/messages/channel-state.ts';
import { send } from '../src/features/messages/actions.ts';

const channel = (slug: string): Channel => ({
  id: `ch_${slug}`,
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
  createdAt: 0,
  updatedAt: 0,
  createdBy: 'fano',
  lastMessageAt: null,
});

beforeEach(() => {
  store.set(currentChannelAtom, channel('first'));
  store.set(hasMoreAtom, true);
  store.set(oldestSeqAtom, 100);
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

test('a late channel load cannot overwrite the pagination of the newly selected channel', async () => {
  const answer = Promise.withResolvers<Awaited<ReturnType<typeof api.listMessages>>>();
  vi.spyOn(api, 'listMessages').mockReturnValueOnce(answer.promise);
  const pending = loadMessages();
  store.set(currentChannelAtom, channel('second'));
  store.set(oldestSeqAtom, 200);
  answer.resolve({ channel: channel('first'), messages: [], hasMore: false, oldestSeq: 50, newestSeq: 100 });
  await pending;
  expect(store.get(oldestSeqAtom)).toBe(200);
  expect(store.get(hasMoreAtom)).toBe(true);
});

test('a late older-page request is discarded after switching channels', async () => {
  const answer = Promise.withResolvers<Awaited<ReturnType<typeof api.listMessages>>>();
  const list = vi.spyOn(api, 'listMessages').mockReturnValueOnce(answer.promise);
  const pending = loadOlder();
  expect(list).toHaveBeenCalledWith('first', { limit: 60, before: 100 });
  store.set(currentChannelAtom, channel('second'));
  store.set(oldestSeqAtom, 200);
  answer.resolve({ channel: channel('first'), messages: [], hasMore: false, oldestSeq: 50, newestSeq: 100 });
  expect(await pending).toBe(false);
  expect(store.get(oldestSeqAtom)).toBe(200);
  expect(store.get(hasMoreAtom)).toBe(true);
});

test('notification targets are consumed once while unrelated URL and history state survive', () => {
  history.replaceState({ marker: 'keep' }, '', '/?channel=first&thread=msg_1&token=keep#anchor');
  expect(takeDeepLink()).toEqual({ channel: 'first', thread: 'msg_1' });
  expect(takeDeepLink()).toBeNull();
  expect(location.search).toBe('?token=keep');
  expect(location.hash).toBe('#anchor');
  expect(history.state).toEqual({ marker: 'keep' });
});

test('sending ignores blank text and preserves the original text for the selected channel', async () => {
  const post = vi
    .spyOn(api, 'postMessage')
    .mockResolvedValue({} as Awaited<ReturnType<typeof api.postMessage>>);
  await send('   ');
  expect(post).not.toHaveBeenCalled();
  await send('  formatted message\n');
  expect(post).toHaveBeenCalledExactlyOnceWith('first', { text: '  formatted message\n' });
});
