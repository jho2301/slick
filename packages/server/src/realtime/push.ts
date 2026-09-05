/**
 * Web Push: turns "an agent posted" into a real notification on your phone,
 * through whatever push service your browser uses (FCM, APNs web push, ...).
 *
 * The daemon holds the VAPID keypair and every subscription — both live in
 * the same `meta` table as everything else, so there is nothing new to back
 * up. The browser only ever sees the public key.
 */

import webpush from 'web-push';

import { errorMessage, isRecord, type Workspace } from '@slick/core';

const VAPID_SUBJECT = 'mailto:slick@localhost';
const GONE_STATUS_CODES = new Set([404, 410]);

/** What the browser hands over when it subscribes. */
export interface PushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

/**
 * The slice of `web-push` this module uses — swappable in tests, so they
 * don't need a TLS-speaking fake push service to exercise this module's own
 * logic.
 */
export interface WebPushLike {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: PushSubscription, payload: string): Promise<unknown>;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string | null;
  channel?: string | null;
  thread?: string | null;
}

function ensureVapidKeys(ws: Workspace, webpushImpl: WebPushLike): { publicKey: string; privateKey: string } {
  const publicKey = ws.getMeta('push.vapidPublicKey');
  const privateKey = ws.getMeta('push.vapidPrivateKey');
  if (publicKey && privateKey) return { publicKey, privateKey };
  const fresh = webpushImpl.generateVAPIDKeys();
  ws.setMeta('push.vapidPublicKey', fresh.publicKey);
  ws.setMeta('push.vapidPrivateKey', fresh.privateKey);
  return fresh;
}

function readSubscriptions(ws: Workspace): PushSubscription[] {
  try {
    const list: unknown = JSON.parse(ws.getMeta('push.subscriptions', '[]'));
    return Array.isArray(list) ? (list as PushSubscription[]) : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(ws: Workspace, list: PushSubscription[]): void {
  ws.setMeta('push.subscriptions', JSON.stringify(list));
}

const statusCodeOf = (reason: unknown): number | undefined =>
  isRecord(reason) && typeof reason.statusCode === 'number' ? reason.statusCode : undefined;

export function createPushService(ws: Workspace, webpushImpl: WebPushLike = webpush) {
  const { publicKey, privateKey } = ensureVapidKeys(ws, webpushImpl);
  webpushImpl.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);

  function subscribe(subscription: unknown): { ok: true } {
    if (!isRecord(subscription) || typeof subscription.endpoint !== 'string' || !subscription.endpoint) {
      throw new Error('A push subscription needs an endpoint.');
    }
    const fresh = subscription as unknown as PushSubscription;
    const list = readSubscriptions(ws).filter((s) => s.endpoint !== fresh.endpoint);
    list.push(fresh);
    writeSubscriptions(ws, list);
    return { ok: true };
  }

  function unsubscribe(endpoint: unknown): { ok: true } {
    writeSubscriptions(
      ws,
      readSubscriptions(ws).filter((s) => s.endpoint !== endpoint)
    );
    return { ok: true };
  }

  async function notify(payload: PushPayload): Promise<void> {
    const list = readSubscriptions(ws);
    if (list.length === 0) return;
    const encoded = JSON.stringify(payload);
    const results = await Promise.allSettled(list.map((sub) => webpushImpl.sendNotification(sub, encoded)));

    // A subscription the browser has dropped answers 404/410 forever — stop
    // paying for it on every future message instead of retrying blind.
    const gone = new Set<string>();
    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const status = statusCodeOf(result.reason);
      const endpoint = list[i]?.endpoint;
      if (status !== undefined && GONE_STATUS_CODES.has(status) && endpoint) {
        gone.add(endpoint);
      } else {
        console.error('[slick] push send failed:', errorMessage(result.reason));
      }
    });
    if (gone.size > 0) {
      writeSubscriptions(
        ws,
        readSubscriptions(ws).filter((s) => !gone.has(s.endpoint))
      );
    }
  }

  return { publicKey, subscribe, unsubscribe, notify, list: () => readSubscriptions(ws) };
}

export type PushService = ReturnType<typeof createPushService>;
