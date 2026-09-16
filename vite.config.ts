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
        // No root index.html: the server routes / to the player app, so the
        // landing page is the audience join screen rather than the admin one.
        //
        // No display either — the projector moved to the client, which is the
        // whole point of the rebuild, and builds through `client/vite.config.ts`.
        // What is left here is the audience's page and two consoles that the
        // relay is about to replace.
        host: web('host', 'index.html'),
        player: web('player', 'index.html'),
        admin: web('admin', 'index.html'),
      },
    },
  },
  server: {
    // `npm run dev` serves the API on 8880; proxy so the client dev server can
    // talk to it without CORS or a second origin.
    proxy: {
      '/api': { target: 'http://localhost:8880', changeOrigin: true },
      '/scenario-assets': { target: 'http://localhost:8880', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8880', ws: true },
    },
  },
});
