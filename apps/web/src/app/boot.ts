import { ApiError } from '../shared/api/api.ts';
import {
  bootErrorAtom,
  categoriesAtom,
  channelsAtom,
  connectionAtom,
  insetTitlebarAtom,
  loadingAtom,
  seqAtom,
  workspaceAtom,
} from './atoms.ts';
import { dispatch } from './events.ts';
import { refreshTyping } from './live.ts';
import { openThread } from './navigation.ts';
import { api, hermes, store } from './store.ts';
import { refreshSessions } from './data.ts';
import { selectChannel } from '../features/messages/channel-state.ts';
import { takeDeepLink } from './deep-links.ts';
import { setRail } from './layout-actions.ts';
import { LAST_CHANNEL_KEY, RAIL_HIDDEN_KEY } from './preferences.ts';

/** How the workspace failed to load, as the empty state's second line (HTML). */
function bootErrorLine(err: unknown): string {
  return err instanceof ApiError && err.status === 401
    ? 'This page needs the daemon token. Open it with <code>slick app</code>.'
    : 'Is the daemon running? Try <code>slick daemon start</code>.';
}

export async function boot(): Promise<void> {
  // The desktop build on macOS floats the traffic lights over the top-left
  // corner, which the header inherits the moment the rail collapses out from
  // under them. Nothing in CSS can see that window, so it is flagged here.
  store.set(
    insetTitlebarAtom,
    navigator.userAgent.includes('Electron') && /Mac/i.test(navigator.platform ?? '')
  );
  setRail(Boolean(localStorage.getItem(RAIL_HIDDEN_KEY)), { remember: false });

  // A reload restores whichever entry was current, but none of the overlays it
  // describes are open any more — reset it so the first back press still counts.
  const state: unknown = history.state;
  if (state && typeof state === 'object' && 'layers' in state) history.replaceState(null, '');

  try {
    const [workspace, channels, categories] = await Promise.all([
      api.workspace(),
      api.listChannels(true),
      api.listCategories(),
    ]);
    store.set(workspaceAtom, workspace);
    store.set(channelsAtom, channels);
    store.set(categoriesAtom, categories);
    store.set(seqAtom, workspace.seq);
  } catch (err) {
    store.set(bootErrorAtom, bootErrorLine(err));
    store.set(connectionAtom, 'closed');
    return;
  }

  await refreshSessions();

  // The limits block below the Hermes section is only allowed to appear once
  // the profile has been read — that read is what says which provider, and so
  // whether there are limits at all. Not awaited: it spawns an interpreter and
  // takes seconds, and nothing on the way to the first channel depends on it.
  if (!hermes.state.loaded && !hermes.state.loading) void hermes.load();

  const deepLink = takeDeepLink();
  const preferred = deepLink?.channel ?? localStorage.getItem(LAST_CHANNEL_KEY);
  const channels = store.get(channelsAtom);
  const target =
    channels.find((c) => c.slug === preferred && !c.archived) ?? channels.find((c) => !c.archived);
  // The phone opens on the list, with the last channel loaded behind it; wide
  // viewports show that channel straight away because nothing covers it.
  // Arriving from a notification is the exception — that tap asked for the
  // message, so reveal it instead of the list.
  if (target) await selectChannel(target.slug, { reveal: Boolean(deepLink) });

  store.set(loadingAtom, false);

  // After the shell is up, so the thread pane opens over a rendered channel.
  if (deepLink?.thread) await openThread(deepLink.thread);

  api.stream({
    since: () => store.get(seqAtom),
    onEvent: dispatch,
    onStatus: (status) => {
      store.set(connectionAtom, status);
      // A stream that just came back may have been away across a whole reply.
      if (status === 'live') void refreshTyping();
    },
  });

  // Keep "last seen 3m ago" honest without a re-render storm. This re-fetches
  // rather than re-rendering because whether a watcher is up is the server's
  // answer, not ours: a `serve` that started or died leaves no event behind.
  setInterval(() => void refreshSessions(), 60_000);
}
