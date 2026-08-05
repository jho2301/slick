import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '@slick/core';
import { paths } from '@slick/core/paths';
import {
  SLICKD_ENTRY,
  daemonStatus,
  ensureDaemon,
  startDaemon,
  stopDaemon,
} from '@slick/server/daemon';

import { ago, json, line, note, ok, style } from '../output.js';

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(here, '../../../../apps/desktop');

export const daemon = {
  name: 'daemon',
  aliases: ['d'],
  summary: 'Control the background server that the desktop app talks to',
  usage: `slick daemon <command>

  status                        is it running, and where
  start [--port <n>]            start it in the background
  stop                          stop it
  restart                       stop then start
  log [--lines <n>]             tail the daemon log
  url                           print the URL with a token, ready to open`,
  spec: { strings: ['port', 'host', 'lines'] },

  async run(ctx) {
    const [sub = 'status'] = ctx.argv;
    const home = ctx.home;

    switch (sub) {
      case 'status': {
        const info = await daemonStatus(home);
        if (ctx.json) return json(info);
        if (info.running) {
          ok(`Running on ${style.bold(info.url)} ${style.dim(`(pid ${info.pid})`)}`);
          note(`  started ${ago(info.startedAt)} · db ${info.db}`);
          note(`  open   ${info.url}?token=${info.token}`);
        } else if (info.stale) {
          line(`${style.yellow('!')} Not running (stale record for pid ${info.pid} — cleaning up on next start)`);
        } else {
          note('Not running. Start it with: slick daemon start');
        }
        return;
      }

      case 'start': {
        const info = await startDaemon({
          home,
          port: ctx.flags.port ? Number(ctx.flags.port) : undefined,
          host: ctx.flags.host,
        });
        if (ctx.json) return json(info);
        ok(
          info.alreadyRunning
            ? `Already running on ${info.url}`
            : `Started on ${style.bold(info.url)} ${style.dim(`(pid ${info.pid})`)}`
        );
        return;
      }

      case 'stop': {
        const result = await stopDaemon({ home });
        if (ctx.json) return json(result);
        return result.stopped ? ok(`Stopped (pid ${result.pid}).`) : note(`Nothing to stop — ${result.reason}.`);
      }

      case 'restart': {
        await stopDaemon({ home });
        const info = await startDaemon({
          home,
          port: ctx.flags.port ? Number(ctx.flags.port) : undefined,
        });
        if (ctx.json) return json(info);
        return ok(`Restarted on ${style.bold(info.url)}`);
      }

      case 'log':
      case 'logs': {
        const file = paths(home).daemonLog;
        if (!existsSync(file)) return note(`No log yet at ${file}`);
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const count = Number(ctx.flags.lines ?? 40);
        if (ctx.json) return json({ file, lines: lines.slice(-count) });
        for (const entry of lines.slice(-count)) line(entry);
        return;
      }

      case 'url': {
        const info = await daemonStatus(home);
        if (!info.running) throw new ValidationError('The daemon is not running.', { hint: 'slick daemon start' });
        const url = `${info.url}${info.token ? `?token=${info.token}` : ''}`;
        return ctx.json ? json({ url }) : line(url);
      }

      default:
        throw new ValidationError(`Unknown daemon command "${sub}".`, {
          hint: 'Try: status, start, stop, restart, log, url',
        });
    }
  },
};

export const serve = {
  name: 'serve',
  summary: 'Run the server in the foreground (ctrl-c to stop)',
  usage: `slick serve [--port <n>] [--host <addr>]

Handy when you want to watch the log, or to expose the workspace to another
device on your network with --host 0.0.0.0.`,
  spec: { strings: ['port', 'host'] },
  async run(ctx) {
    // Hand over to slickd so there is exactly one implementation of "serve".
    const args = [SLICKD_ENTRY, '--foreground'];
    if (ctx.home) args.push('--home', ctx.home);
    if (ctx.flags.port) args.push('--port', String(ctx.flags.port));
    if (ctx.flags.host) args.push('--host', String(ctx.flags.host));
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    await new Promise((res) => child.on('exit', res));
  },
};

export const app = {
  name: 'app',
  aliases: ['open', 'desktop', 'ui'],
  summary: 'Open the desktop app (falls back to your browser)',
  usage: `slick app [--browser]

Starts the daemon if it is not already running, then opens the UI. With
Electron installed you get the desktop window; otherwise the same interface
opens in your default browser.`,
  spec: { booleans: ['browser'] },
  async run(ctx) {
    const info = await ensureDaemon({ home: ctx.home });
    const url = `${info.url}${info.token ? `?token=${info.token}` : ''}`;

    if (!ctx.flags.browser && existsSync(resolve(DESKTOP_DIR, 'main.js'))) {
      const electron = await loadElectronBinary();
      if (electron) {
        const child = spawn(electron, [DESKTOP_DIR], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, SLICK_URL: info.url, SLICK_TOKEN: info.token ?? '' },
        });
        child.unref();
        if (ctx.json) return json({ opened: 'electron', url: info.url });
        return ok('Opening the desktop app…');
      }
    }

    openInBrowser(url);
    if (ctx.json) return json({ opened: 'browser', url });
    ok(`Opened ${style.bold(info.url)} in your browser.`);
    note('  Install Electron for the desktop window: npm install --workspace @slick/desktop');
  },
};

async function loadElectronBinary() {
  try {
    const mod = await import('electron');
    const bin = mod.default;
    return typeof bin === 'string' && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => line(url));
  child.unref();
}
