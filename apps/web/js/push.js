/**
 * Web Push subscription management: ask the browser for permission, hand the
 * service worker the daemon's VAPID key, and tell the daemon the resulting
 * endpoint so it knows where to deliver a notification.
 */

function urlBase64ToUint8Array(base64) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** @param {import('./api.js').Api} api */
export async function enablePush(api) {
  if (!pushSupported()) throw new Error('This browser does not support push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await api.pushVapidKey();
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api.pushSubscribe(subscription.toJSON());
  return subscription;
}

/** @param {import('./api.js').Api} api */
export async function disablePush(api) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.pushUnsubscribe(endpoint).catch(() => {
    /* the daemon will drop it on the next failed send anyway */
  });
}
