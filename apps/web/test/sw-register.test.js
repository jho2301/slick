/**
 * Registering the service worker while the page is being torn down.
 *
 * The bootstrap at the foot of `app.js` reloads the page when a new worker
 * claims it. Under Electron the document that reload invalidates does not
 * simply stop — a `register()` still in flight rejects with an InvalidStateError,
 * and the `load` handler that started it had no catch, so it landed as an
 * unhandled rejection. These tests run that block against a fake `navigator`
 * and pin both halves: nothing is left unhandled on the way out, and a plain
 * browser load still registers and asks for an update.
 *
 * The block is read off the source and evaluated on its own because importing
 * `app.js` boots the whole page.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const start = source.indexOf("if ('serviceWorker' in navigator) {");
assert.ok(start > -1, 'the bootstrap block is still there to test');
const bootstrap = source.slice(start);

/** Runs the bootstrap block against fakes, returning the listeners it hung. */
function boot({ register }) {
  const listeners = new Map();
  const add = (target) => (type, fn) => {
    if (!listeners.has(target)) listeners.set(target, new Map());
    listeners.get(target).set(type, fn);
  };
  const reloads = [];
  const navigator = {
    serviceWorker: { controller: null, register, addEventListener: add('sw') },
  };
  const window = { addEventListener: add('window') };
  const document = { addEventListener: add('document'), visibilityState: 'visible' };
  const location = { reload: () => reloads.push(true) };

  // eslint-disable-next-line no-new-func -- the block under test, in isolation
  new Function('navigator', 'window', 'document', 'location', bootstrap)(
    navigator,
    window,
    document,
    location
  );

  return {
    reloads,
    fire: (target, type, event) => listeners.get(target)?.get(type)?.(event),
    // A worker claiming the page sets `controller` before the event lands; the
    // block reads it back, so a test driving a handover has to move it too.
    setController: (controller) => {
      navigator.serviceWorker.controller = controller;
    },
  };
}

/** Everything the process saw go unhandled while `run` was settling. */
async function unhandledDuring(run) {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    // Node reports an unhandled rejection a turn after the promise settles.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

afterEach(() => process.removeAllListeners('unhandledRejection'));

describe('the service worker bootstrap', () => {
  test('a document invalidated mid-register does not reject unhandled', async () => {
    const invalid = Object.assign(new Error('The document is in an invalid state.'), {
      name: 'InvalidStateError',
    });
    const app = boot({ register: () => Promise.reject(invalid) });

    const unhandled = await unhandledDuring(() => app.fire('window', 'load'));

    assert.deepEqual(unhandled, [], 'the InvalidStateError was handled');
  });

  test('an update that rejects on the way out is handled too', async () => {
    const app = boot({
      register: () =>
        Promise.resolve({ update: () => Promise.reject(new Error('Failed to fetch')) }),
    });

    const unhandled = await unhandledDuring(() => app.fire('window', 'load'));

    assert.deepEqual(unhandled, [], 'the failed update was handled');
  });

  test('a browser load still registers the worker and asks for an update', async () => {
    const calls = [];
    const app = boot({
      register: (url) => {
        calls.push(url);
        return Promise.resolve({
          update: () => {
            calls.push('update');
            return Promise.resolve();
          },
        });
      },
    });

    await app.fire('window', 'load');

    assert.deepEqual(calls, ['./sw.js', 'update'], 'PWA registration is untouched');
  });

  test('once a reload is under way the worker is not registered again', async () => {
    const calls = [];
    const app = boot({
      register: (url) => {
        calls.push(url);
        return Promise.resolve({ update: () => Promise.resolve() });
      },
    });

    // A first install claims the page (no reload), then a later handover does.
    app.setController({});
    app.fire('sw', 'controllerchange');
    app.fire('sw', 'controllerchange');
    assert.equal(app.reloads.length, 1, 'the second handover reloaded the page');

    await app.fire('window', 'load');

    assert.deepEqual(calls, [], 'nothing was asked of a document on its way out');
  });
});
