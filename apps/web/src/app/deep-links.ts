import { channelsAtom } from './atoms.ts';
import { openThread } from './navigation.ts';
import { store } from './store.ts';
import { selectChannel } from '../features/messages/channel-state.ts';

/**
 * Jump to a channel, and optionally a thread inside it. The one place that
 * knows how a push notification's target becomes screen state.
 */
export async function goTo(
  channel: string | null | undefined,
  thread: string | null | undefined
): Promise<void> {
  if (channel) {
    const target = store.get(channelsAtom).find((c) => c.slug === channel && !c.archived);
    // A notification can outlive its channel. Land on the workspace rather
    // than failing silently — the message body was already in the banner.
    if (target) await selectChannel(target.slug, { reveal: true });
  }
  if (thread) await openThread(thread);
}

/**
 * A cold start from a notification carries its target in the query string.
 * Consume it once and strip it: a later reload should not re-open a thread
 * the user has since left, and the params would outlive the tap that set them.
 */
export function takeDeepLink(): { channel: string | null; thread: string | null } | null {
  const url = new URL(location.href);
  const channel = url.searchParams.get('channel');
  const thread = url.searchParams.get('thread');
  if (!channel && !thread) return null;
  url.searchParams.delete('channel');
  url.searchParams.delete('thread');
  history.replaceState(history.state, '', url);
  return { channel, thread };
}
