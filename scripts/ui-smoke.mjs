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
    const channelCount = await js('document.querySelectorAll(".rail__scroll .chan").length');
    check('channels in the sidebar', channelCount >= 4, `${channelCount} channels`);
    const messageCount = await js('document.querySelectorAll("#messages .msg").length');
    check('messages rendered', messageCount > 0, `${messageCount} rows`);
    check('stream connected', (await js('document.querySelector("#conn-label").textContent')) === 'connected');
    check('no loading class left', !(await js('document.querySelector("#app").classList.contains("is-loading")')));
    check('thread pane starts hidden', !(await visible('#thread')));
    check('palette starts hidden', !(await visible('#palette')));

    console.log('\nnavigating');
    await js('[...document.querySelectorAll(".rail__scroll .chan")].find(b => b.textContent.includes("deploys")).click()');
    await sleep(500);
    check('switched channel', (await js('document.querySelector("#chan-title").textContent')) === '#deploys');
    const deployRows = await js('document.querySelectorAll("#messages .msg").length');
    check('deploys has messages', deployRows > 0, `${deployRows} rows`);
    check(
      'agent messages name the model that answered',
      await js('!!document.querySelector("#messages .msg__model")')
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

      console.log('\nresizing the thread pane');
      check('the split handle is there once a thread is open', await visible('#thread-resizer'));
      // Where a real pointer lands, not where an event can be aimed: the
      // handle is an overlay, and anything painting over it would leave it
      // looking fine and still be impossible to grab.
      const grabbable = await js(`
        (() => {
          const b = document.querySelector('#thread-resizer').getBoundingClientRect();
          const x = b.left + b.width / 2;
          return [80, 300, 600].map(y => {
            const hit = document.elementFromPoint(x, y);
            return hit && hit.id === 'thread-resizer';
          });
        })()
      `);
      check('and a pointer on it hits it at any height', grabbable.every(Boolean), grabbable.join(', '));
      // A real drag, in the events one produces: press on the handle, move the
      // pointer left, let go. Left is wider — the thread is the right column.
      const dragged = await js(`
        (() => {
          const handle = document.querySelector('#thread-resizer');
          const box = handle.getBoundingClientRect();
          const before = document.querySelector('#thread').getBoundingClientRect().width;
          const at = (x) => ({ clientX: x, clientY: box.top + 40, button: 0, bubbles: true });
          handle.dispatchEvent(new PointerEvent('pointerdown', at(box.left + box.width / 2)));
          const lit = handle.classList.contains('is-dragging');
          window.dispatchEvent(new PointerEvent('pointermove', at(box.left + box.width / 2 - 120)));
          const after = document.querySelector('#thread').getBoundingClientRect().width;
          window.dispatchEvent(new PointerEvent('pointerup', at(box.left + box.width / 2 - 120)));
          return { lit, before, after, dragging: handle.classList.contains('is-dragging') };
        })()
      `);
      check('the handle lights up while dragging', dragged.lit);
      check(
        'dragging left widens the thread by what the pointer moved',
        Math.abs(dragged.after - dragged.before - 120) < 2,
        `${Math.round(dragged.before)}px → ${Math.round(dragged.after)}px`
      );
      check('and the drag state is cleaned up on release', !dragged.dragging);
      check(
        'the width is remembered',
        (await js('localStorage.getItem("slick.thread-width")')) === String(Math.round(dragged.after))
      );
      // Past the clamp the channel would be unreadable, so the handle stops.
      const clamped = await js(`
        (() => {
          const handle = document.querySelector('#thread-resizer');
          const box = handle.getBoundingClientRect();
          const at = (x) => ({ clientX: x, clientY: box.top + 40, button: 0, bubbles: true });
          handle.dispatchEvent(new PointerEvent('pointerdown', at(box.left)));
          window.dispatchEvent(new PointerEvent('pointermove', at(-4000)));
          window.dispatchEvent(new PointerEvent('pointerup', at(-4000)));
          return {
            thread: document.querySelector('#thread').getBoundingClientRect().width,
            channel: document.querySelector('#main').getBoundingClientRect().width,
          };
        })()
      `);
      check('a drag past the end leaves the channel readable', clamped.channel >= 420, `${Math.round(clamped.channel)}px`);
      await shoot('02b-thread-wide');
      await js('document.querySelector("#thread-resizer").dispatchEvent(new MouseEvent("dblclick", {bubbles: true}))');
      await sleep(200);
      check(
        'double-click puts it back to the default width',
        Math.abs((await js('document.querySelector("#thread").getBoundingClientRect().width')) - 400) < 1
      );
    }

    console.log('\nthinking steps');
    // Posted the way an agent posts one: the working hangs off the message's
    // own metadata, so the box has to survive every round trip a message does.
    const worked = server.ws.messages.post({
      channel: 'deploys',
      text: 'Rolled the canary back and pinned the previous image.',
      author: { id: 'claude', kind: 'agent', label: 'claude' },
      metadata: {
        _think: {
          t: 'Worked out what took the canary down',
          p: 'done',
          s: [
            {
              id: 't1',
              t: 'Read the deploy log',
              st: 'complete',
              d: ['tail -n 200 deploy.log', '2 restarts'],
              o: 'The image digest changed at 14:02',
            },
            {
              id: 't2',
              t: 'Compared the two images',
              st: 'complete',
              src: [{ u: 'https://example.test/builds/91', t: 'build 91' }],
            },
          ],
        },
      },
    });
    await sleep(1000);
    check('a thinking box is drawn above the answer', await js('!!document.querySelector("#messages .think")'));
    check('it is born collapsed', !(await visible('#messages .think__body')));
    // Collapsed here means a zero-height grid row, not `display: none`. The
    // difference is invisible in a screenshot and is the whole accessibility
    // story: content that is display:none is out of the tree, so a reader
    // would be told the box exists and never told what is in it.
    check(
      'and collapsed still leaves the steps in the accessibility tree',
      await js(`
        (() => {
          const body = document.querySelector('#messages .think__body');
          return getComputedStyle(body).display !== 'none' && body.getBoundingClientRect().height < 1;
        })()
      `)
    );
    check(
      'and the head is a button that says so',
      (await js('document.querySelector("#messages .think__head").getAttribute("aria-expanded")')) === 'false'
    );
    // A thread root is drawn twice while its pane is open, so the id the head
    // points at has to name the surface it was drawn on or the two copies both
    // claim it and `aria-controls` resolves to whichever came first.
    check(
      'and points at a body id scoped to the pane it was drawn in',
      await js(`
        (() => {
          const head = document.querySelector('#messages .think__head');
          const body = document.querySelector('#messages .think__body');
          return head.getAttribute('aria-controls') === body.id && body.id.startsWith('think-timeline-');
        })()
      `)
    );
    await js('document.querySelector("#messages .think__head").click()');
    await sleep(500);
    check('clicking the head opens the steps', await visible('#messages .think__body'));
    check(
      'and says so',
      (await js('document.querySelector("#messages .think__head").getAttribute("aria-expanded")')) === 'true'
    );
    const stepRows = await js('document.querySelectorAll("#messages .think__step").length');
    check('every step rendered', stepRows === 2, `${stepRows} steps`);
    check('the answer itself is still the editable body', await js(`
      (() => {
        const row = document.querySelector('#messages .msg .think').closest('.msg');
        return row.querySelector('.msg__body').textContent.includes('Rolled the canary back');
      })()
    `));
    await shoot('02c-thinking');

    // The regression that matters. A reply bumps the root's reply count, which
    // rebuilds the entire row through patchMessage — and a box whose open flag
    // lived in the node would shut itself here, under a reader mid-sentence.
    server.ws.messages.post({ parentId: worked.id, text: 'Thanks — leaving it pinned.' });
    await sleep(1200);
    check(
      'a write to the same thread rebuilds that row',
      await js(`
        (() => {
          const row = document.querySelector('#messages .msg .think').closest('.msg');
          const chip = row.querySelector('.msg__thread');
          return !!chip && chip.textContent.includes('1 reply');
        })()
      `)
    );
    check('and leaves the box open', await visible('#messages .think__body'));
    check(
      'with its button still saying so',
      (await js('document.querySelector("#messages .think__head").getAttribute("aria-expanded")')) === 'true'
    );

    console.log('\nresponse sections');
    // Posted the way an agent writes a structured reply: one message whose
    // text carries the four labels. Everything below is read off that row
    // alone — earlier smoke messages are still on screen and would answer for
    // it if the selectors were loose.
    const sectioned = server.ws.messages.post({
      channel: 'deploys',
      text: [
        '## Answer',
        'The canary is stable on parrot-anchor-9471.',
        '',
        '## Reasoning summary',
        'The rollback pinned a digest that was already known good.',
        '',
        '## Process',
        '- Pulled the last two image digests',
        '- Diffed the running config',
        '',
        '## Assumptions',
        'The registry mirror is in sync.',
      ].join('\n'),
      author: { id: 'claude', kind: 'agent', label: 'claude' },
    });
    await sleep(1000);
    const ROW = `#messages .msg[data-id="${sectioned.id}"]`;
    check('the sectioned reply rendered', await js(`!!document.querySelector('${ROW}')`));
    const cards = await js(`
      (() => {
        const row = document.querySelector('${ROW}');
        if (!row) return null;
        return [...row.querySelectorAll('.rsec')].map(d => ({
          section: d.dataset.section,
          open: d.hasAttribute('open'),
          title: d.querySelector('.rsec__title').textContent,
        }));
      })()
    `);
    check('exactly three section cards are drawn', cards && cards.length === 3, `${cards ? cards.length : 'no row'} cards`);
    check(
      'reasoning, process and assumptions, in that order',
      cards && cards.map((c) => c.section).join(',') === 'reasoning,process,assumptions',
      cards ? cards.map((c) => c.section).join(',') : ''
    );
    check('and every one of them is born closed', cards && cards.every((c) => !c.open));
    // The answer keeps the row's one editable body, and the labels the parser
    // consumed must not have leaked back into it.
    const body = await js(`
      (() => {
        const row = document.querySelector('${ROW}');
        const bodies = row.querySelectorAll('.msg__body');
        return { count: bodies.length, text: bodies[0] ? bodies[0].textContent : '' };
      })()
    `);
    check('the row still has exactly one editable body', body.count === 1, `${body.count}`);
    check('which holds the answer', body.text.includes('parrot-anchor-9471'));
    check(
      'and none of the section text or labels',
      !/Reasoning summary|Process|Assumptions|registry mirror|image digests/.test(body.text),
      JSON.stringify(body.text.slice(0, 80))
    );
    check(
      'a closed card has no open attribute',
      await js(`(() => {
        const d = document.querySelector('${ROW} .rsec[data-section="process"]');
        return !!d && !d.open && !d.hasAttribute('open');
      })()`)
    );
    await shoot('02d-sections');
    await js(`document.querySelector('${ROW} .rsec[data-section="process"] .rsec__head').click()`);
    await sleep(400);
    check(
      'clicking the process summary opens that card',
      await js(`document.querySelector('${ROW} .rsec[data-section="process"]').hasAttribute('open')`)
    );
    check(
      'and its list is on screen',
      await js(`
        (() => {
          const items = [...document.querySelectorAll('${ROW} .rsec[data-section="process"] .rsec__body li')];
          if (items.length !== 2) return false;
          return items.every(li => li.getBoundingClientRect().height > 0)
            && items[0].textContent.includes('image digests');
        })()
      `)
    );
    check(
      'while the other two stay closed',
      await js(`
        [...document.querySelectorAll('${ROW} .rsec')]
          .filter(d => d.dataset.section !== 'process')
          .every(d => !d.hasAttribute('open'))
      `)
    );
    await shoot('02e-sections-open');

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

    console.log('\ncategories');
    const sections = await js('document.querySelectorAll("#category-sections .rail__section").length');
    check('category sections rendered', sections >= 2, `${sections} sections`);
    check(
      'channels are grouped under their category',
      await js(`
        (() => {
          const section = [...document.querySelectorAll('#category-sections .rail__section')]
            .find(s => s.textContent.includes('Engineering'));
          return !!section && !![...section.querySelectorAll('.chan')].find(c => c.textContent.includes('deploys'));
        })()
      `)
    );
    check(
      'uncategorised channels stay in the bottom bucket',
      await js('[...document.querySelectorAll("#channel-list .chan")].some(c => c.textContent.includes("general"))')
    );
    await shoot('05-categories');

    // Collapse is persisted server-side, so the list really has to disappear.
    await js(`
      [...document.querySelectorAll('#category-sections .rail__heading')]
        .find(h => h.textContent.includes('Product')).click()
    `);
    await sleep(600);
    check(
      'collapsing a category hides its channels',
      await js(`
        (() => {
          const section = [...document.querySelectorAll('#category-sections .rail__section')]
            .find(s => s.textContent.includes('Product'));
          return section.querySelector('.channel-list').hidden === true;
        })()
      `)
    );
    check(
      'collapse survives a reload',
      await js('fetch("/api/categories").then(r => r.json()).then(d => d.categories.some(c => c.collapsed))')
    );

    // Drag #deploys out of Engineering and into the uncategorised bucket, the
    // way a mouse would: dragstart on the row, then dragover/drop on the
    // section. Synthetic DragEvents run the same handlers a real drag does.
    const highlighted = await js(`
      (() => {
        const row = [...document.querySelectorAll('#category-sections .chan')]
          .find(c => c.textContent.includes('deploys'));
        const target = document.querySelector('#channels-section');
        const dataTransfer = new DataTransfer();
        row.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
        const lit = target.classList.contains('is-drop');
        target.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
        return lit;
      })()
    `);
    check('the drop target lights up while dragging', highlighted);
    await sleep(1200);
    check(
      'dropping a channel moves it out of its category',
      await js('[...document.querySelectorAll("#channel-list .chan")].some(c => c.textContent.includes("deploys"))')
    );
    check(
      'and the drag highlight is cleaned up',
      !(await js('!!document.querySelector(".rail__section.is-drop")'))
    );

    // The bucket with no channels in it hides — but it is still the only way
    // back out of a category, so a drag has to be able to find it again.
    const loose = await js('[...document.querySelectorAll("#channel-list .chan__name")].map(n => n.textContent)');
    const [firstCategory] = server.ws.categories.list();
    for (const slug of loose) server.ws.channels.update(slug, { category: firstCategory.id });
    await sleep(1200);
    check('the uncategorised bucket hides when it is empty', !(await visible('#channels-section')), loose.join(', '));
    check(
      'a drag brings the empty bucket back as a target',
      await js(`
        (() => {
          const row = document.querySelector('#category-sections .chan');
          const dataTransfer = new DataTransfer();
          row.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
          const shown = document.querySelector('#channels-section').getBoundingClientRect().height > 0;
          row.dispatchEvent(new DragEvent('dragend', { dataTransfer, bubbles: true }));
          return shown;
        })()
      `)
    );
    check('and it hides again once the drag ends', !(await visible('#channels-section')));
    for (const slug of loose) server.ws.channels.update(slug, { category: null });
    await sleep(1200);
    check('the bucket comes back with its channels', await visible('#channels-section'));

    await js(`
      [...document.querySelectorAll('#category-sections .rail__cog')]
        .find(b => b.title.includes('Engineering')).click()
    `);
    await sleep(400);
    check('the category dialog opened', await js('document.querySelector("#modal").open'));
    check('it can reorder', await js('!!document.querySelector("#field-after")'));
    check('it offers delete without leaving', await js('!document.querySelector("#modal-extra").hidden'));
    await shoot('06-category-edit');
    await js(`
      (() => {
        document.querySelector('#field-name').value = 'Engineering Ops';
        document.querySelector('#field-after').value =
          [...document.querySelectorAll('#field-after option')].at(-1).value;
        document.querySelector('#modal-form').requestSubmit();
      })()
    `);
    await sleep(1000);
    check(
      'renaming and reordering a category takes effect',
      await js(`
        (() => {
          const headings = [...document.querySelectorAll('#category-sections .rail__label')].map(h => h.textContent);
          return headings.join('|') === 'Product|Engineering Ops';
        })()
      `),
      await js('[...document.querySelectorAll("#category-sections .rail__label")].map(h => h.textContent).join(" | ")')
    );

    console.log('\nchannel crud');
    await js('document.querySelector("#btn-settings").click()');
    await sleep(300);
    check('the ☰ menu opens settings', await js('document.querySelector("#settings").open'));
    await js('document.querySelector("#btn-new-channel").click()');
    await sleep(400);
    check('settings steps aside for the create dialog', await js('!document.querySelector("#settings").open'));
    check('create-channel modal opened', await js('document.querySelector("#modal").open'));
    check('the channel dialog offers a category', await js('!!document.querySelector("#field-category")'));
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
    await shoot('07-new-channel');

    console.log('\nthe Hermes panel in the rail');
    // Folded by default, and it fetches on first unfold rather than on boot.
    await js('document.querySelector("#toggle-hermes").click()');
    await sleep(1200);
    check('the rail has a Hermes section', await visible('#hermes-panel'));
    check('with a profile picker', await js('!!document.querySelector("#hermes-profile")'));
    check(
      'and it says what it does and does not change',
      (await js('document.querySelector("#hermes-panel .hermes__scope").textContent')).includes('/model')
    );
    // Whether the provider/model selects are populated depends on a Hermes
    // being installed and importable beside this workspace, which a smoke run
    // cannot assume — so the panel is only required to say why, not to have a
    // catalog. Either way it must not claim a default it does not have.
    const hermesState = await js(`
      (() => {
        const note = document.querySelector('#hermes-panel .hermes__note');
        return JSON.stringify({
          note: note ? note.textContent : null,
          providers: !!document.querySelector('#hermes-provider'),
          current: (document.querySelector('#hermes-panel .hermes__current') || {}).textContent || '',
        });
      })()
    `);
    const hermes = JSON.parse(hermesState);
    check('it either offers a catalog or says why not', hermes.providers || Boolean(hermes.note), hermesState);
    await shoot('07b-hermes-panel');

    console.log('\nagents that cannot answer stay out of the way');
    // A cron automation: a real session with a real history key that nothing
    // watches. Mentioning it would be shouting into a log file.
    server.ws.agents.start({ agentId: 'digest-bot', name: 'digest', channel: 'general' });
    await sleep(1200);

    await js(`
      (() => {
        const input = document.querySelector('#composer-input');
        input.focus();
        input.value = '@';
        input.selectionStart = input.selectionEnd = 1;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
    await sleep(300);
    const offered = await js('[...document.querySelectorAll("#mention-menu-main .what")].map(n => n.textContent).join(" ")');
    check('the mention picker offers the agents that answer', offered.includes('@claude'), offered);
    check('an automation nothing watches is not offered', !offered.includes('@digest-bot'), offered);
    check('and not the ones that only post', !offered.includes('@digest-bot'));
    await js(`
      (() => {
        const input = document.querySelector('#composer-input');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.blur();
      })()
    `);
    await sleep(200);

    console.log('\nediting a message');
    await js('[...document.querySelectorAll(".rail__scroll .chan")].find(b => b.textContent.includes("deploys")).click()');
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

    const shot = await shoot('08-final');
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
