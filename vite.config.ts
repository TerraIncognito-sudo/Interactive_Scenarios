import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const client = (...parts: string[]) => resolve(here, 'src', 'client', ...parts);

export default defineConfig({
  root: client(),
  publicDir: false,
  build: {
    outDir: resolve(here, 'dist', 'client'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        // No root index.html: the server routes / to the player app, so the
        // landing page is the audience join screen rather than the launcher.
        display: client('display', 'index.html'),
        host: client('host', 'index.html'),
        player: client('player', 'index.html'),
        new: client('new', 'index.html'),
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
