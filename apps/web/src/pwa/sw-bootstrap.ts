/**
 * Registering the service worker, checking it for updates, and reloading when
 * a new one takes over — plus the one message a worker sends the page: a
 * notification was tapped, go here.
 *
 * Written against the handful of globals it touches rather than the real
 * ones, so a test can run the whole handover against fakes.
 */

export interface ServiceWorkerBridge {
  controller: unknown;
  register(url: string): Promise<{ update(): Promise<unknown> } | undefined>;
  getRegistration(): Promise<{ update(): Promise<unknown> } | undefined>;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export interface BootstrapEnvironment {
  serviceWorker: ServiceWorkerBridge | null;
  window: { addEventListener(type: string, listener: () => void): void };
  document: { addEventListener(type: string, listener: () => void): void; visibilityState: string };
  location: { reload(): void };
  /** A notification was tapped while a window was open: route in place. */
  onNavigate: (channel: string | null, thread: string | null) => Promise<void>;
  /** Where the worker lives; the built one is at the root. */
  workerUrl?: string;
}

function readNavigate(data: unknown): { channel: string | null; thread: string | null } | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; channel?: unknown; thread?: unknown };
  if (message.type !== 'navigate') return null;
  return {
    channel: typeof message.channel === 'string' ? message.channel : null,
    thread: typeof message.thread === 'string' ? message.thread : null,
  };
}

export function bootstrapServiceWorker(env: BootstrapEnvironment): void {
  const sw = env.serviceWorker;
  if (!sw) return;
  const workerUrl = env.workerUrl ?? '/sw.js';

  // A notification tapped while a window is already open cannot be delivered
  // by URL without discarding that window's state, so the worker posts the
  // target here instead.
  sw.addEventListener('message', (event) => {
    const target = readNavigate(event.data);
    if (!target) return;
    env
      .onNavigate(target.channel, target.thread)
      .catch((err: unknown) => console.error('notification navigation failed', err));
  });

  // Whether this page is under a worker decides what a handover below means,
  // and the first install claims it mid-flight — so this is read now and kept
  // in step, not re-read from a `controller` that has already moved on by the
  // time the event lands.
  let controlled = Boolean(sw.controller);
  let reloading = false;
  let lastUpdateCheck = 0;

  /**
   * An installed app is resumed far more often than it is launched, and being
   * resumed re-runs nothing — no navigation, no module fetch, and so no update
   * check. Network-first does not save it either: nothing asks the network in
   * the first place. Asking here is what makes a new build land on a phone
   * that is never actually closed; the worker that comes back claims the page
   * and the handover below reloads it.
   */
  const checkForUpdate = () => {
    const now = Date.now();
    if (now - lastUpdateCheck < 60_000) return;
    lastUpdateCheck = now;
    sw.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {
        /* offline, or the daemon is down — the worker we have still serves */
      });
  };

  env.document.addEventListener('visibilitychange', () => {
    if (env.document.visibilityState === 'visible') checkForUpdate();
  });

  // Registration is a promise, and the document it belongs to can stop being a
  // valid one while it is still in flight: the handover below reloads the page,
  // and under Electron `register` then rejects with an InvalidStateError rather
  // than never settling. Skip the call once a reload is on the way, and treat a
  // rejection the same as any other — there is no page left to serve.
  const registerWorker = async () => {
    if (reloading) return;
    try {
      const registration = await sw.register(workerUrl);
      // An installed app is launched, not reloaded, and can sit open for days;
      // asking on the way in is what makes a new worker land the same day.
      await registration?.update();
    } catch {
      /* offline, the daemon is down, or this document is on its way out */
    }
  };

  env.window.addEventListener('load', () => void registerWorker());

  sw.addEventListener('controllerchange', () => {
    // A worker that skipped waiting now owns a page built against the last one.
    // One reload lines the HTML, CSS, and JS back up. Not on a first install,
    // where the handover is to a page that has been served from the network all
    // along and is already current — but every handover after that one counts,
    // including the ones a long-lived app collects without ever reloading.
    const first = !controlled;
    controlled = Boolean(sw.controller);
    if (first || reloading) return;
    reloading = true;
    env.location.reload();
  });
}
