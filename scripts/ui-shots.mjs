#!/usr/bin/env electron
/**
 * Screenshot the UI in a few states.
 *
 *   npm run shots
 *
 * Uses Chromium's offscreen renderer, which paints every frame to a bitmap —
 * unlike a merely hidden window, whose captures can be a frame or two stale.
 */

import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '@slick/server';

const OUT = process.env.SHOTS_OUT ?? join(process.env.SLICK_HOME ?? '.', 'shots');
const TOKEN = 'shots-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
if (process.env.SMOKE_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = createServer({ home: process.env.SLICK_HOME, token: TOKEN });
  const bound = await server.listen(0);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: process.env.SMOKE_NO_SANDBOX !== '1',
    },
  });
  win.webContents.setFrameRate(30);

  /** Latest painted frame, kept fresh by the offscreen renderer. */
  let frame = null;
  win.webContents.on('paint', (_event, _dirty, image) => {
    frame = image;
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);

  async function shoot(name) {
    await sleep(700);
    if (!frame) throw new Error('offscreen renderer produced no frames');
    writeFileSync(join(OUT, `${name}.png`), frame.toPNG());
    console.log(`  ${name}.png`);
  }

  await win.loadURL(`${bound.url}?token=${TOKEN}`);
  await sleep(1500);

  await js('[...document.querySelectorAll("#channel-list .chan")].find(b => b.textContent.includes("deploys"))?.click()');
  await shoot('a-channel');

  await js('document.querySelector(".msg__thread")?.click()');
  await shoot('b-thread');

  await js('document.querySelector("#btn-close-thread").click()');
  await js('document.querySelector("#btn-search").click()');
  await js(`
    (() => {
      const input = document.querySelector('#palette-input');
      input.value = 'cache';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await shoot('c-search');

  await js('document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))');
  await js('document.querySelector("#btn-new-channel").click()');
  await shoot('d-modal');

  await js('document.querySelector("#modal-cancel").click()');
  await js('[...document.querySelectorAll("#channel-list .chan")].find(b => b.textContent.includes("general"))?.click()');
  await shoot('e-general');

  console.log(`\nwrote to ${OUT}`);
  await server.close();
  app.exit(0);
}

app.whenReady().then(main);
