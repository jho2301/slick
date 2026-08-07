/**
 * Web Push: turns "an agent posted" into a real notification on your phone,
 * through whatever push service your browser uses (FCM, APNs web push, ...).
 *
 * The daemon holds the VAPID keypair and every subscription — both live in
 * the same `meta` table as everything else, so there is nothing new to back
 * up. The browser only ever sees the public key.
 */

import webpush from 'web-push';

const VAPID_SUBJECT = 'mailto:slick@localhost';
const GONE_STATUS_CODES = new Set([404, 410]);

function ensureVapidKeys(ws, webpushImpl) {
  const publicKey = ws.getMeta('push.vapidPublicKey');
  const privateKey = ws.getMeta('push.vapidPrivateKey');
  if (publicKey && privateKey) return { publicKey, privateKey };
  const fresh = webpushImpl.generateVAPIDKeys();
  ws.setMeta('push.vapidPublicKey', fresh.publicKey);
  ws.setMeta('push.vapidPrivateKey', fresh.privateKey);
  return fresh;
}

function readSubscriptions(ws) {
  try {
    const list = JSON.parse(ws.getMeta('push.subscriptions', '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(ws, list) {
  ws.setMeta('push.subscriptions', JSON.stringify(list));
}

/**
 * @param {import('@slick/core').Workspace} ws
 * @param {typeof webpush} [webpushImpl] swappable in tests, so they don't
 *   need a TLS-speaking fake push service to exercise this module's own logic.
 */
export function createPushService(ws, webpushImpl = webpush) {
  const { publicKey, privateKey } = ensureVapidKeys(ws, webpushImpl);
  webpushImpl.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);

  function subscribe(subscription) {
    if (!subscription?.endpoint) throw new Error('A push subscription needs an endpoint.');
    const list = readSubscriptions(ws).filter((s) => s.endpoint !== subscription.endpoint);
    list.push(subscription);
    writeSubscriptions(ws, list);
    return { ok: true };
  }

  function unsubscribe(endpoint) {
    writeSubscriptions(
      ws,
      readSubscriptions(ws).filter((s) => s.endpoint !== endpoint)
    );
    return { ok: true };
  }

  /** @param {{title: string, body: string, url?: string, tag?: string}} payload */
  async function notify(payload) {
    const list = readSubscriptions(ws);
    if (list.length === 0) return;
    const encoded = JSON.stringify(payload);
    const results = await Promise.allSettled(list.map((sub) => webpushImpl.sendNotification(sub, encoded)));

    // A subscription the browser has dropped answers 404/410 forever — stop
    // paying for it on every future message instead of retrying blind.
    const gone = new Set();
    results.forEach((result, i) => {
      if (result.status === 'rejected' && GONE_STATUS_CODES.has(result.reason?.statusCode)) {
        gone.add(list[i].endpoint);
      } else if (result.status === 'rejected') {
        console.error('[slick] push send failed:', result.reason?.message ?? result.reason);
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
