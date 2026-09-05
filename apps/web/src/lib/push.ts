/**
 * Web Push subscription management: ask the browser for permission, hand the
 * service worker the daemon's VAPID key, and tell the daemon the resulting
 * endpoint so it knows where to deliver a notification.
 */

export interface PushApi {
  pushVapidKey(): Promise<string>;
  pushSubscribe(subscription: PushSubscriptionJSON): Promise<unknown>;
  pushUnsubscribe(endpoint: string): Promise<unknown>;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function enablePush(api: PushApi): Promise<PushSubscription> {
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

export async function disablePush(api: PushApi): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.pushUnsubscribe(endpoint).catch(() => {
    /* the daemon will drop it on the next failed send anyway */
  });
}
