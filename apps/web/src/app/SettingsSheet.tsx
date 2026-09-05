/**
 * The settings sheet: the workspace, the offline copy, new channels and
 * categories, notifications.
 */

import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { closeSettings, createCategory, createChannel } from './actions.ts';
import { settingsOpenAtom, versionAtom, workspaceAtom } from './atoms.ts';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../pwa/push.ts';
import { api, store } from './store.ts';
import { toast } from '../shared/ui/toast.ts';

function SettingRow({ name, hint, action }: { name: string; hint?: string | null; action?: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__name">{name}</div>
        {hint ? <div className="setting__hint">{hint}</div> : null}
      </div>
      {action ?? null}
    </div>
  );
}

/**
 * Which daemon this window is talking to. Asked for once and remembered — the
 * answer cannot change without the page reloading behind a restarted server.
 */
function VersionRow() {
  const version = useAtomValue(versionAtom);
  useEffect(() => {
    if (version) return;
    api
      .health()
      .then((health) => {
        // The build is the half that answers "am I up to date" — the version
        // is hand-written and the same across every build a phone would need
        // to notice. Shown side by side because only one of them is ever wrong.
        const v = health.version ? `v${health.version}` : 'unknown';
        store.set(versionAtom, health.build ? `${v} · ${health.build}` : v);
      })
      .catch(() => store.set(versionAtom, 'unknown'));
  }, [version]);
  return (
    <SettingRow
      name="Version"
      hint="The daemon this window is talking to."
      action={<span className="setting__value">{version ?? '…'}</span>}
    />
  );
}

/**
 * Throw away the offline copy of the app shell and come back on whatever the
 * daemon is serving now.
 *
 * The worker is already network-first, so this is not how a new build normally
 * arrives — it is the way out of the case where it did not: a half-written
 * cache entry, or an installed app that has been sitting on a dead daemon and
 * kept falling back to the same stale shell.
 */
function CacheRow() {
  const [busy, setBusy] = useState(false);
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    return <SettingRow name="Offline copy" hint="This browser keeps none, so there is nothing to refresh." />;
  }
  const refresh = async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      // Ask for a newer worker first: if one is waiting, dropping the caches
      // underneath the old one only to have it rebuild them wastes the trip.
      await registration?.update();
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      toast('Offline copy cleared — reloading');
      // Long enough for the toast to be read, short enough to still feel like
      // the button did it.
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      setBusy(false);
      toast(
        err instanceof Error && err.message ? err.message : 'Could not refresh the offline copy',
        'error'
      );
    }
  };
  return (
    <SettingRow
      name="Offline copy"
      hint="Drop the cached app files and reload from the daemon."
      action={
        <button
          className="btn"
          type="button"
          id="btn-refresh-cache"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    />
  );
}

/** Whether this browser is subscribed, as the worker reports it. */
const subscribed = () =>
  currentSubscription()
    .catch(() => null)
    .then((subscription) => Boolean(subscription) && Notification.permission === 'granted');

function NotificationRow() {
  const [state, setState] = useState<'checking' | 'on' | 'off' | 'busy'>('checking');
  const sync = () => subscribed().then((on) => setState(on ? 'on' : 'off'));
  // The subscription lives in the service worker, so the label lands a tick
  // after the row does.
  useEffect(() => {
    if (!pushSupported()) return;
    let gone = false;
    void subscribed().then((on) => {
      if (!gone) setState(on ? 'on' : 'off');
    });
    return () => {
      gone = true;
    };
  }, []);
  if (!pushSupported())
    return <SettingRow name="Push notifications" hint="This browser cannot receive them." />;
  const toggle = async () => {
    const subscription = await currentSubscription().catch(() => null);
    setState('busy');
    try {
      if (subscription) {
        await disablePush(api);
        toast('Notifications turned off');
      } else {
        await enablePush(api);
        toast('Notifications on — you will get a ping when an agent replies');
      }
    } catch (err) {
      toast(
        err instanceof Error && err.message ? err.message : 'Could not change notification settings',
        'error'
      );
    } finally {
      await sync();
    }
  };
  return (
    <SettingRow
      name="Push notifications"
      hint="Get a ping when an agent replies to you."
      action={
        <button
          className={`btn${state === 'on' ? '' : ' btn--primary'}`}
          type="button"
          id="btn-notifications"
          disabled={state === 'checking' || state === 'busy'}
          onClick={() => void toggle()}
        >
          {state === 'checking' ? 'Checking…' : state === 'on' ? 'Turn off' : 'Enable'}
        </button>
      }
    />
  );
}

/**
 * Creating things opens the shared modal, and two dialogs stacked on top of
 * each other is one Escape away from confusion — so this one steps aside first.
 */
const fromSettings = (action: () => unknown) => () => {
  closeSettings();
  void action();
};

export function SettingsSheet() {
  const open = useAtomValue(settingsOpenAtom);
  const workspace = useAtomValue(workspaceAtom);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      className="modal settings"
      id="settings"
      ref={dialog}
      aria-label="Settings"
      onClose={closeSettings}
      onClick={(event) => {
        // A dialog's backdrop counts as the dialog itself, so a click that lands
        // on no row at all is a click outside the sheet.
        if (event.target === event.currentTarget) closeSettings();
      }}
    >
      <header className="settings__head">
        <h2>Settings</h2>
        <button
          className="icon-btn icon-btn--ghost"
          id="btn-close-settings"
          aria-label="Close settings"
          onClick={closeSettings}
        >
          ✕
        </button>
      </header>
      <div className="settings__body" id="settings-body">
        {open ? (
          <>
            <h3 className="settings__legend">Workspace</h3>
            <SettingRow
              name={workspace?.name ?? 'Slick'}
              hint={workspace ? `Signed in as ${workspace.user.name}` : 'Not connected yet'}
            />
            <VersionRow />
            <CacheRow />
            <h3 className="settings__legend">Channels</h3>
            <SettingRow
              name="New channel"
              hint="A new place to talk, on its own or inside a category."
              action={
                <button
                  className="btn btn--primary"
                  type="button"
                  id="btn-new-channel"
                  onClick={fromSettings(createChannel)}
                >
                  Create
                </button>
              }
            />
            <SettingRow
              name="New category"
              hint="A section in the sidebar. Channels can be dragged in and out of it."
              action={
                <button
                  className="btn"
                  type="button"
                  id="btn-new-category"
                  onClick={fromSettings(() => createCategory())}
                >
                  Create
                </button>
              }
            />
            <h3 className="settings__legend">Notifications</h3>
            <NotificationRow />
          </>
        ) : null}
      </div>
    </dialog>
  );
}
