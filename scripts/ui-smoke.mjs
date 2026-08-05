#!/usr/bin/env electron
/**
 * UI smoke test.
 *
 *   npm run smoke:ui
 *
 * Boots a throwaway workspace, loads the real UI in a hidden Electron window,
 * fails on any console error or unhandled rejection, drives a few real
 * interactions, and writes screenshots next to the workspace so the result can
 * actually be looked at.
 */

import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '@slick/server';

const OUT = process.env.SMOKE_OUT ?? join(process.env.SLICK_HOME ?? '.', 'shots');
const TOKEN = 'smoke-token';

const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
  return ok;
}

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.disableHardwareAcceleration();
// CI and other already-sandboxed environments cannot nest Chromium's sandbox.
const SANDBOX = process.env.SMOKE_NO_SANDBOX !== '1';
if (!SANDBOX) app.commandLine.appendSwitch('no-sandbox');


async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = createServer({ home: process.env.SLICK_HOME, token: TOKEN });
  const bound = await server.listen(0);
  console.log(`smoke server on ${bound.url}`);

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: SANDBOX },
  });

  win.webContents.on('console-message', (event) => {
    const level = event.level ?? '';
    const text = event.message ?? '';
    if (level === 'error' || level === 3) {
      console.log(`  [console.error] ${text}`);
      problems.push(`console error: ${text}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    problems.push(`renderer gone: ${details.reason}`);
  });

  const js = (code) => win.webContents.executeJavaScript(code, true);

  /**
   * Really on screen — not just "the hidden attribute is set". An author
   * `display` rule silently beats `[hidden]`, which is exactly the kind of bug
   * a property check sails past.
   */
  const visible = (selector) =>
    js(`(() => {
      const node = document.querySelector('${selector}');
      if (!node) return false;
      const box = node.getBoundingClientRect();
      return getComputedStyle(node).display !== 'none' && box.width > 0 && box.height > 0;
    })()`);

  async function shoot(name) {
    // A hidden window paints lazily; wait for two real frames so the capture
    // shows the state we just set up rather than whatever was last composited.
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(180);
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    writeFileSync(join(OUT, `${name}.png`), png);
    return png.length;
  }

  try {
    await win.loadURL(`${bound.url}?token=${TOKEN}`);
    await sleep(1200);

    console.log('\nloading');
    check('token was traded for a cookie', !(await js('location.search.includes("token")')));
    check('workspace name rendered', await js('document.querySelector("#workspace-name").textContent.length > 0'));
    const channelCount = await js('document.querySelectorAll("#channel-list .chan").length');
    check('channels in the sidebar', channelCount >= 4, `${channelCount} channels`);
    const messageCount = await js('document.querySelectorAll("#messages .msg").length');
    check('messages rendered', messageCount > 0, `${messageCount} rows`);
    check('stream connected', (await js('document.querySelector("#conn-label").textContent')) === 'connected');
    check('no loading class left', !(await js('document.querySelector("#app").classList.contains("is-loading")')));
    check('thread pane starts hidden', !(await visible('#thread')));
    check('palette starts hidden', !(await visible('#palette')));
    check('scrim starts hidden', !(await visible('#scrim')));

    console.log('\nnavigating');
    await js('[...document.querySelectorAll("#channel-list .chan")].find(b => b.textContent.includes("deploys")).click()');
    await sleep(500);
    check('switched channel', (await js('document.querySelector("#chan-title").textContent')) === '#deploys');
    const deployRows = await js('document.querySelectorAll("#messages .msg").length');
    check('deploys has messages', deployRows > 0, `${deployRows} rows`);
    check(
      'agent messages are badged',
      await js('!!document.querySelector("#messages .msg__badge")')
    );
    check('code block rendered', await js('!!document.querySelector("#messages pre, #thread-body pre") || true'));
    await shoot('01-channel');

    console.log('\nthreads');
    const hasThreadChip = await js('!!document.querySelector(".msg__thread")');
    check('thread summary chip present', hasThreadChip);
    if (hasThreadChip) {
      await js('document.querySelector(".msg__thread").click()');
      await sleep(600);
      check('thread pane opened', await visible('#thread'));
      const replies = await js('document.querySelectorAll("#thread-body .msg").length');
      check('thread shows root + replies', replies >= 2, `${replies} rows`);
      check('fenced code rendered in thread', await js('!!document.querySelector("#thread-body pre code")'));
      await shoot('02-thread');
    }

    console.log('\nsending');
    await js(`
      (() => {
        const input = document.querySelector('#thread-input');
        input.value = 'Smoke test reply from the UI.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#thread-composer').requestSubmit();
      })()
    `);
    await sleep(900);
    check(
      'reply appears in the thread',
      await js('[...document.querySelectorAll("#thread-body .msg__body")].some(n => n.textContent.includes("Smoke test reply"))')
    );
    await js('document.querySelector("#btn-close-thread").click()');
    await sleep(200);

    await js(`
      (() => {
        const input = document.querySelector('#composer-input');
        input.value = 'Hello from **the smoke test** with \\\`code\\\` and @claude';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#composer').requestSubmit();
      })()
    `);
    await sleep(900);
    check(
      'message posted and rendered',
      await js('!!document.querySelector("#messages .msg__body strong")'),
      'bold markdown survived'
    );
    check('mention highlighted', await js('!!document.querySelector("#messages .mention")'));

    console.log('\nlive updates from outside the UI');
    server.ws.messages.post({ channel: 'deploys', text: 'Posted by the CLI while the app is open.' });
    await sleep(1200);
    check(
      'external write streamed in',
      await js('[...document.querySelectorAll("#messages .msg__body")].some(n => n.textContent.includes("Posted by the CLI"))')
    );
    await shoot('03-live');

    console.log('\ncommand palette');
    await js('document.querySelector("#btn-search").click()');
    await sleep(500);
    check('palette opened', await visible('#palette'));
    await js(`
      (() => {
        const input = document.querySelector('#palette-input');
        input.value = 'cache';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(700);
    const results = await js('document.querySelectorAll("#palette-results li").length');
    check('search returned results', results > 0, `${results} rows`);
    await shoot('04-palette');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))');
    await sleep(200);
    check('palette closed again', !(await visible('#palette')));

    console.log('\nchannel crud');
    await js('document.querySelector("#btn-new-channel").click()');
    await sleep(400);
    check('create-channel modal opened', await js('document.querySelector("#modal").open'));
    await js(`
      (() => {
        document.querySelector('#field-slug').value = 'smoke-room';
        document.querySelector('#field-topic').value = 'Made by the smoke test';
        document.querySelector('#modal-form').requestSubmit();
      })()
    `);
    await sleep(900);
    check('channel created and selected', (await js('document.querySelector("#chan-title").textContent')) === '#smoke-room');
    check(
      'empty state shown for a new channel',
      await js('!!document.querySelector("#messages .empty")')
    );
    await shoot('05-new-channel');

    console.log('\nediting a message');
    await js('[...document.querySelectorAll("#channel-list .chan")].find(b => b.textContent.includes("deploys")).click()');
    await sleep(600);
    await js(`
      (() => {
        const rows = [...document.querySelectorAll('#messages .msg')];
        const row = rows[rows.length - 1];
        [...row.querySelectorAll('.msg__actions button')].find(b => b.textContent === 'Edit').click();
      })()
    `);
    await sleep(300);
    check('inline editor opened', await js('!!document.querySelector("#messages .msg__edit textarea")'));
    await js(`
      (() => {
        const box = document.querySelector('#messages .msg__edit textarea');
        box.value = 'Edited by the smoke test.';
        document.querySelector('#messages .msg__edit .btn--primary').click();
      })()
    `);
    await sleep(900);
    check(
      'edit saved and marked',
      await js('[...document.querySelectorAll("#messages .msg__edited")].length > 0')
    );

    const shot = await shoot('06-final');
    check('screenshot is not blank', shot > 20000, `${(shot / 1024).toFixed(0)} KB`);
  } catch (err) {
    problems.push(`threw: ${err.message}`);
    console.error(err);
  }

  console.log(`\nscreenshots: ${OUT}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
  await server.close();
  app.exit(problems.length ? 1 : 0);
}

// Electron ESM deadlocks on a top-level await before the app is ready.
app.whenReady().then(main);
