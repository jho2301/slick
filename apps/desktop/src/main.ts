/**
 * The desktop shell.
 *
 * Deliberately thin: it makes sure the local daemon is up and then shows the
 * same web UI the browser would. Everything real — storage, the API, the live
 * stream — lives in the daemon, which is what lets the CLI and an agent work
 * against the identical workspace at the same time.
 *
 * Electron runs this file as it stands: the Node it bundles strips types the
 * same way the CLI's does, so there is no build step here either.
 */

import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { errorMessage } from '@slick/core';
import { ensureDaemon, stopDaemon, type StartedDaemon } from '@slick/server/daemon';

const isMac = process.platform === 'darwin';

let win: BrowserWindow | null = null;
let daemon: StartedDaemon | null = null;
/** Set once the quit handler has taken over, so its own `app.quit()` is not intercepted again. */
let stopping = false;

async function start(): Promise<void> {
  try {
    daemon = await ensureDaemon({ home: process.env.SLICK_HOME });
  } catch (err) {
    dialog.showErrorBox(
      'Slick could not start',
      `The local workspace daemon failed to start.\n\n${errorMessage(err)}\n\nTry running "slick doctor" in a terminal.`
    );
    app.quit();
    return;
  }
  createWindow(daemon);
}

/** The daemon's URL with its token, when auth is on — what a browser would need. */
function workspaceUrl(target: StartedDaemon): string {
  return `${target.url}${target.token ? `?token=${encodeURIComponent(target.token)}` : ''}`;
}

function createWindow(target: StartedDaemon): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 460,
    show: false,
    backgroundColor: '#1e1b33',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 18 } : undefined,
    title: 'Slick',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win = window;

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (win === window) win = null;
  });

  // Anything that is not our own UI opens in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(target.url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(target.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void window.loadURL(workspaceUrl(target));

  window.webContents.on('did-fail-load', (_event, code, description) => {
    if (code === -3) return; // aborted by a redirect we caused ourselves
    dialog.showErrorBox('Slick could not load', `${description} (${code})\n\n${target.url}`);
  });
}

function buildMenu(): void {
  const appMenu: MenuItemConstructorOptions[] = isMac ? [{ role: 'appMenu' }] : [];
  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        {
          label: 'Search / Jump to…',
          accelerator: 'CmdOrCtrl+K',
          click: () =>
            win?.webContents.sendInputEvent({
              type: 'keyDown',
              keyCode: 'k',
              modifiers: [isMac ? 'meta' : 'control'],
            }),
        },
        { type: 'separator' },
        {
          label: 'Copy workspace URL',
          click: () => {
            if (daemon) clipboard.writeText(workspaceUrl(daemon));
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Where is my data?',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'Slick',
              message: 'Everything lives in one SQLite file.',
              detail:
                `Workspace: ${daemon?.db ?? '~/.slick/slick.db'}\n` +
                `Daemon:    ${daemon?.url ?? '(not running)'}\n\n` +
                'The `slick` CLI reads and writes the same file, which is how ' +
                'your agents take part in these conversations.',
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

void app.whenReady().then(() => {
  buildMenu();
  void start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && daemon) createWindow(daemon);
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// Leave no orphan behind: if this window started the daemon, it stops it on
// the way out. A daemon someone else started (`slick daemon start`) is left
// alone. Either way the CLI keeps working — it talks to the file directly.
app.on('before-quit', (event) => {
  if (!daemon?.started || stopping) return;
  stopping = true;
  event.preventDefault();
  void stopDaemon({ home: process.env.SLICK_HOME })
    .catch(() => {})
    .then(() => app.quit());
});
