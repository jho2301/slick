/**
 * What jsdom lacks and the app leans on, stubbed once for every web test.
 *
 * `<dialog>` is the big one: jsdom draws none, so `showModal`/`close` here
 * keep the `open` attribute and fire the `close` event the way a browser
 * would. `matchMedia` answers "wide" unless a test says otherwise, so the
 * phone's layer stack stays out of the way by default.
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// ---------------------------------------------------------------- dialog ---

const proto = HTMLDialogElement.prototype as HTMLDialogElement & { __stubbed?: boolean };
if (!proto.__stubbed) {
  proto.__stubbed = true;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.show = function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    if (returnValue !== undefined) this.returnValue = returnValue;
    // The event a browser fires once the dialog has gone; queued like the real one.
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  };
  Object.defineProperty(proto, 'open', {
    configurable: true,
    get(this: HTMLDialogElement) {
      return this.hasAttribute('open');
    },
    set(this: HTMLDialogElement, value: boolean) {
      if (value) this.setAttribute('open', '');
      else this.removeAttribute('open');
    },
  });
}

// ------------------------------------------------------------- matchMedia ---

/** Tests flip this to put the app in its phone layout. */
export const viewport = { narrow: false };

window.matchMedia = (query: string): MediaQueryList => {
  const matches = query.includes('max-width') ? viewport.narrow : !viewport.narrow;
  const list: MediaQueryList = {
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
  return list;
};

// ------------------------------------------------------------ CSS.escape ---

if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
  (globalThis as { CSS?: { escape: (v: string) => string } }).CSS = {
    escape: (value: string) => value.replace(/["\\]/g, '\\$&'),
  };
}

// --------------------------------------------------------- EventSource ---

/** The stream, as something a test can push frames into. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emit(frame: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }

  close(): void {
    this.readyState = 2;
  }
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

// ----------------------------------------------------- layout observers ---

if (typeof ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

if (typeof requestAnimationFrame !== 'function') {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16);
}
