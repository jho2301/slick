import type { Channel } from '@slick/core';
import { categoriesAtom, channelsAtom, currentChannelAtom, sessionsAtom, unreadAtom } from './atoms.ts';
import { api, store } from './store.ts';

export async function refreshChannels(): Promise<void> {
  store.set(channelsAtom, await api.listChannels(true));
}

export async function refreshCategories(): Promise<void> {
  store.set(categoriesAtom, await api.listCategories());
}

export async function refreshSessions(): Promise<void> {
  try {
    store.set(sessionsAtom, await api.agentSessions());
  } catch {
    /* the agent list is decoration; never block the app on it */
  }
}

export function bumpUnread(channelId: string | null | undefined): void {
  if (!channelId || channelId === store.get(currentChannelAtom)?.id) return;
  const unread = new Map(store.get(unreadAtom));
  unread.set(channelId, (unread.get(channelId) ?? 0) + 1);
  store.set(unreadAtom, unread);
}

export function clearUnread(channelId: string): void {
  const unread = store.get(unreadAtom);
  if (!unread.has(channelId)) return;
  const next = new Map(unread);
  next.delete(channelId);
  store.set(unreadAtom, next);
}

/** For the rail: every channel, live or archived, as the list it came in. */
export const channelsOf = (channels: readonly Channel[]) => ({
  active: channels.filter((c) => !c.archived),
  archived: channels.filter((c) => c.archived),
});
