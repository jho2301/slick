import { toastsAtom } from './atoms.ts';
import { ApiError } from './api.ts';
import { store } from './store.ts';

let nextId = 0;

export function toast(text: string, kind: '' | 'error' = ''): void {
  const id = ++nextId;
  store.set(toastsAtom, [...store.get(toastsAtom), { id, text, kind, fading: false }]);
  setTimeout(
    () => {
      store.set(
        toastsAtom,
        store.get(toastsAtom).map((t) => (t.id === id ? { ...t, fading: true } : t))
      );
      setTimeout(() => {
        store.set(
          toastsAtom,
          store.get(toastsAtom).filter((t) => t.id !== id)
        );
      }, 260);
    },
    kind === 'error' ? 4200 : 2200
  );
}

/** What went wrong, for a person: the daemon's sentence when it gave one, ours otherwise. */
export function fail(err: unknown, fallback: string): void {
  const message = err instanceof ApiError ? err.message : fallback;
  toast(err instanceof ApiError && err.hint ? `${message} — ${err.hint}` : message, 'error');
  if (!(err instanceof ApiError)) console.error(err);
}
