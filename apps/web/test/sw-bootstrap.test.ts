/**
 * Registering the service worker while the page is being torn down.
 *
 * The bootstrap reloads the page when a new worker claims it. Under Electron
 * the document that reload invalidates does not simply stop — a `register()`
 * still in flight rejects with an InvalidStateError, and a `load` handler
 * that started it with no catch lands it as an unhandled rejection. These
 * tests run the bootstrap against a fake `navigator` and pin both halves:
 * nothing is left unhandled on the way out, and a plain browser load still
 * registers and asks for an update.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';

import { bootstrapServiceWorker, type ServiceWorkerBridge } from '../src/sw-bootstrap.ts';

type Listener = (event: { data?: unknown }) => void;

/** Runs the bootstrap against fakes, returning the listeners it hung. */
function boot({ register }: { register: ServiceWorkerBridge['register'] }) {
  const listeners = new Map<string, Map<string, Listener>>();
  const add = (target: string) => (type: string, fn: Listener) => {
    if (!listeners.has(target)) listeners.set(target, new Map());
    listeners.get(target)!.set(type, fn);
  };
  const reloads: boolean[] = [];
  const navigated: [string | null, string | null][] = [];
  const sw: ServiceWorkerBridge = {
    controller: null,
    register,
    getRegistration: () => Promise.resolve(undefined),
    addEventListener: add('sw'),
  };

  bootstrapServiceWorker({
    serviceWorker: sw,
    window: { addEventListener: add('window') },
    document: { addEventListener: add('document'), visibilityState: 'visible' },
    location: { reload: () => reloads.push(true) },
    onNavigate: (channel, thread) => {
      navigated.push([channel, thread]);
      return Promise.resolve();
    },
  });

  return {
    reloads,
    navigated,
    fire: (target: string, type: string, event: { data?: unknown } = {}) =>
      listeners.get(target)?.get(type)?.(event),
    // A worker claiming the page sets `controller` before the event lands; the
    // block reads it back, so a test driving a handover has to move it too.
    setController: (controller: unknown) => {
      sw.controller = controller;
    },
  };
}

/** Everything the process saw go unhandled while `run` was settling. */
async function unhandledDuring(run: () => unknown) {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
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
      register: () => Promise.resolve({ update: () => Promise.reject(new Error('Failed to fetch')) }),
    });

    const unhandled = await unhandledDuring(() => app.fire('window', 'load'));

    assert.deepEqual(unhandled, [], 'the failed update was handled');
  });

  test('a browser load still registers the worker and asks for an update', async () => {
    const calls: string[] = [];
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

    app.fire('window', 'load');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ['/sw.js', 'update'], 'PWA registration is untouched');
  });

  test('once a reload is under way the worker is not registered again', async () => {
    const calls: string[] = [];
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

    app.fire('window', 'load');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [], 'nothing was asked of a document on its way out');
  });

  test('a tapped notification routes the open window in place', () => {
    const app = boot({ register: () => Promise.resolve(undefined) });
    app.fire('sw', 'message', { data: { type: 'navigate', channel: 'deploys', thread: 'msg_1' } });
    app.fire('sw', 'message', { data: { type: 'other' } });
    assert.deepEqual(app.navigated, [['deploys', 'msg_1']]);
  });
});
