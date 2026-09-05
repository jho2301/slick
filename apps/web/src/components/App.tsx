/**
 * The shell: three columns, four overlays, and the listeners that belong to
 * the whole page rather than to any one of them.
 */

import { useAtomValue } from 'jotai';
import { useEffect } from 'react';

import { clearUnread, closePalette, openPalette, toggleRail } from '../actions.ts';
import {
  channelRevealedAtom,
  currentChannelAtom,
  insetTitlebarAtom,
  loadingAtom,
  modalAtom,
  paletteOpenAtom,
  railHiddenAtom,
  settingsOpenAtom,
  threadAtom,
  unreadAtom,
} from '../atoms.ts';
import { closeChannel, closeThread, syncLayers } from '../navigation.ts';
import { store } from '../store.ts';
import { ChannelView } from './ChannelView.tsx';
import { ModalHost } from './ModalHost.tsx';
import { Palette } from './Palette.tsx';
import { Rail } from './Rail.tsx';
import { SettingsSheet } from './SettingsSheet.tsx';
import { ThreadPane } from './ThreadPane.tsx';
import { ToastHost } from './ToastHost.tsx';

/** `(3) Slick` while there is something unread somewhere else. */
function useUnreadTitle() {
  const unread = useAtomValue(unreadAtom);
  const current = useAtomValue(currentChannelAtom);
  useEffect(() => {
    let total = 0;
    for (const [id, count] of unread) if (id !== current?.id) total += count;
    document.title = total > 0 ? `(${total}) Slick` : 'Slick';
  }, [unread, current]);
}

function useGlobalListeners() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (store.get(paletteOpenAtom)) closePalette();
        else openPalette();
      } else if (meta && event.key.toLowerCase() === 'b') {
        // Bold is the other claim on ⌘B, but the composer is plain text — there
        // is nothing here for it to mark up.
        event.preventDefault();
        toggleRail();
      } else if (event.key === 'Escape') {
        // An open dialog closes itself on Escape; without this the layer behind
        // it would be dismissed by the same keypress.
        if (store.get(modalAtom) || store.get(settingsOpenAtom)) return;
        if (store.get(paletteOpenAtom)) closePalette();
        else if (store.get(threadAtom)) closeThread();
        else closeChannel();
      }
    };
    const onPopState = (event: PopStateEvent) => syncLayers(event.state);
    const onFocus = () => {
      const current = store.get(currentChannelAtom);
      if (current) clearUnread(current.id);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}

export function App() {
  const loading = useAtomValue(loadingAtom);
  const railHidden = useAtomValue(railHiddenAtom);
  const inset = useAtomValue(insetTitlebarAtom);
  const revealed = useAtomValue(channelRevealedAtom);
  const thread = useAtomValue(threadAtom);
  useUnreadTitle();
  useGlobalListeners();

  const className =
    'app' +
    (loading ? ' is-loading' : '') +
    (railHidden ? ' rail-hidden' : '') +
    (inset ? ' is-inset-titlebar' : '') +
    (revealed ? ' with-channel' : '') +
    (thread ? ' with-thread' : '');

  return (
    <>
      <div id="app" className={className}>
        <Rail />
        <ChannelView />
        <ThreadPane />
      </div>
      <ModalHost />
      <SettingsSheet />
      <Palette />
      <ToastHost />
    </>
  );
}
