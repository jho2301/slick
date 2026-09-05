/**
 * Slick web UI.
 *
 * State lives in one store, every change — yours, the CLI's, or an agent's —
 * arrives through the same SSE stream, and the components draw whatever the
 * store holds.
 */

import { Provider } from 'jotai';
import { createRoot } from 'react-dom/client';

import { boot, goTo } from './app/actions.ts';
import { App } from './app/App.tsx';
import { store } from './app/store.ts';
import { bootstrapServiceWorker } from './pwa/sw-bootstrap.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root to mount into');

createRoot(root).render(
  <Provider store={store}>
    <App />
  </Provider>
);

void boot();

// Only against a real build: the dev server serves no worker, and a worker
// from an earlier build must not be allowed to cache the dev server's files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  bootstrapServiceWorker({
    serviceWorker: navigator.serviceWorker,
    window,
    document,
    location,
    onNavigate: goTo,
  });
}
