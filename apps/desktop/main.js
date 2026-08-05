/**
 * The desktop shell.
 *
 * Deliberately thin: it makes sure the local daemon is up and then shows the
 * same web UI the browser would. Everything real — storage, the API, the live
 * stream — lives in the daemon, which is what lets the CLI and an agent work
 * against the identical workspace at the same time.
 */

import { app, BrowserWindow, Menu, clipboard, dialog, shell } from 'electron';
import { ensureDaemon, stopDaemon } from '@slick/server/daemon';

const isMac = process.platform === 'darwin';

/** @type {BrowserWindow|null} */
let win = null;
/** @type {{url: string, token?: string|null, started?: boolean}|null} */
let daemon = null;

async function start() {
  try {
    daemon = await ensureDaemon({ home: process.env.SLICK_HOME });
  } catch (err) {
    dialog.showErrorBox(
      'Slick could not start',
      `The local workspace daemon failed to start.\n\n${err.message}\n\nTry running "slick doctor" in a terminal.`
    );
    app.quit();
    return;
  }
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
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

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  // Anything that is not our own UI opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(daemon.url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(daemon.url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  const url = `${daemon.url}${daemon.token ? `?token=${encodeURIComponent(daemon.token)}` : ''}`;
  win.loadURL(url);

  win.webContents.on('did-fail-load', (_event, code, description) => {
    if (code === -3) return; // aborted by a redirect we caused ourselves
    dialog.showErrorBox('Slick could not load', `${description} (${code})\n\n${daemon.url}`);
  });
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Search / Jump to…',
          accelerator: 'CmdOrCtrl+K',
          click: () => win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: [isMac ? 'meta' : 'control'] }),
        },
        { type: 'separator' },
        {
          label: 'Copy workspace URL',
          click: () => {
            clipboard.writeText(`${daemon.url}${daemon.token ? `?token=${daemon.token}` : ''}`);
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
            dialog.showMessageBox({
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

app.whenReady().then(() => {
  buildMenu();
  start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && daemon) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// Leave no orphan behind: if this window started the daemon, it stops it on
// the way out. A daemon someone else started (`slick daemon start`) is left
// alone. Either way the CLI keeps working — it talks to the file directly.
app.on('before-quit', async (event) => {
  if (daemon?.started && !app.__slickStopping) {
    app.__slickStopping = true;
    event.preventDefault();
    await stopDaemon({ home: process.env.SLICK_HOME }).catch(() => {});
    app.quit();
  }
});
