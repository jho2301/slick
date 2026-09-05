import {
  atBottomAtom,
  channelsAtom,
  currentChannelAtom,
  flashAtom,
  hasMoreAtom,
  jumpVisibleAtom,
  messagesAtom,
  oldestSeqAtom,
  scrollRequestAtom,
} from '../../app/atoms.ts';
import { closeThread, openChannel } from '../../app/navigation.ts';
import { api, store } from '../../app/store.ts';
import { resetThinkState } from '../thinking/think-state.ts';
import { clearUnread } from '../../app/data.ts';
import { LAST_CHANNEL_KEY } from '../../app/preferences.ts';

/**
 * @param opts `reveal: false` loads the channel without bringing it to the
 *   front — how the phone restores the last channel behind the list on boot.
 */
export async function selectChannel(
  ref: string,
  { flash, reveal = true }: { flash?: string; reveal?: boolean } = {}
): Promise<void> {
  const channel = store.get(channelsAtom).find((c) => c.slug === ref || c.id === ref);
  if (!channel) return;
  const previous = store.get(currentChannelAtom);
  store.set(currentChannelAtom, channel);
  clearUnread(channel.id);
  localStorage.setItem(LAST_CHANNEL_KEY, channel.slug);
  closeThread();
  if (reveal) openChannel();
  // Those ids have left the screen for good; keeping their state would only leak.
  if (previous?.id !== channel.id) resetThinkState();
  await loadMessages();
  scrollToBottom(true);
  if (flash) flashMessage(flash);
}

export async function loadMessages(): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel) {
    store.set(messagesAtom, []);
    store.set(hasMoreAtom, false);
    store.set(oldestSeqAtom, null);
    return;
  }
  const result = await api.listMessages(channel.slug, { limit: 60 });
  // The channel may have changed under the request; the answer is for the one asked about.
  if (store.get(currentChannelAtom)?.id !== channel.id) return;
  store.set(messagesAtom, result.messages);
  store.set(hasMoreAtom, result.hasMore);
  store.set(oldestSeqAtom, result.oldestSeq ?? null);
}

/** The sixty messages before what is on screen. Returns whether anything was added. */
export async function loadOlder(): Promise<boolean> {
  const channel = store.get(currentChannelAtom);
  const oldest = store.get(oldestSeqAtom);
  if (!channel || !store.get(hasMoreAtom) || oldest == null) return false;
  const result = await api.listMessages(channel.slug, { limit: 60, before: oldest });
  if (store.get(currentChannelAtom)?.id !== channel.id) return false;
  store.set(messagesAtom, [...result.messages, ...store.get(messagesAtom)]);
  store.set(hasMoreAtom, result.hasMore);
  store.set(oldestSeqAtom, result.oldestSeq ?? oldest);
  return result.messages.length > 0;
}

export function scrollToBottom(force = false): void {
  if (!force && !store.get(atBottomAtom)) return;
  store.set(atBottomAtom, true);
  store.set(jumpVisibleAtom, false);
  store.set(scrollRequestAtom, store.get(scrollRequestAtom) + 1);
}

export function flashMessage(id: string): void {
  store.set(flashAtom, { id, at: Date.now() });
}
