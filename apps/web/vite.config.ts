import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The daemon the dev server forwards `/api` to. `npm run dev` points this at
 * the throwaway daemon it seeds; set it by hand to work against a live one.
 */
const API = process.env.SLICK_API_URL ?? 'http://127.0.0.1:4477';

export default defineConfig({
  // The daemon serves the build from `/`, whatever port it came up on.
  base: '/',
  plugins: [
    react(),
    VitePWA({
      // Our own worker, with the precache list injected: the shell logic —
      // network-first, push, notification taps — is Slick's, and only the
      // "which files, and which build" half is the bundler's to know.
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      // Registered by hand in `main.tsx`, so nothing is injected into the
      // page and the CSP stays exactly as it was.
      injectRegister: null,
      // The manifest lives in `public/`; the daemon rewrites its `start_url`.
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
        globIgnores: ['**/*.map'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    // Straight into what the daemon serves. Git-ignored; `npm run build`.
    outDir: fileURLToPath(new URL('../../packages/server/public', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
});
