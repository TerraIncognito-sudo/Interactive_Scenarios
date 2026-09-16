import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = (...parts: string[]) => resolve(here, 'server', 'web', ...parts);

export default defineConfig({
  root: web(),
  publicDir: false,
  build: {
    outDir: resolve(here, 'dist', 'client'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        // No root index.html: the relay routes / to the player app, so the
        // landing page is the audience join screen.
        //
        // Three entries, and the list is the relay's whole face. The projector
        // moved to the client and builds through `client/vite.config.ts`; the
        // host console was deleted rather than unrouted, because a page that
        // still builds and no longer works is one somebody opens from a
        // bookmark in front of a room.
        player: web('player', 'index.html'),
        status: web('status', 'index.html'),
        keys: web('keys', 'index.html'),
      },
    },
  },
  server: {
    // `npm run dev` serves the relay on 8880; proxy so the dev server can talk
    // to it without CORS or a second origin. There is no asset route to proxy
    // — the relay serves no scenario media, because it holds no scenario.
    proxy: {
      '/api': { target: 'http://localhost:8880', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8880', ws: true },
    },
  },
});
