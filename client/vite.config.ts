/**
 * Builds the stage, and only the stage.
 *
 * The client has two browser surfaces and they are built in opposite ways on
 * purpose. The board is ten thousand lines of vanilla ES modules whose whole
 * framework is `dom.js`, served raw by `app/server.ts`, so editing it is one
 * reload rather than a rebuild — which is what makes a tool somebody uses all
 * day bearable to work on.
 *
 * The stage cannot be. It imports the production engine and runs the same
 * `reduce` the clock does, which is what makes it a fallback when the socket
 * drops rather than a renderer that freezes mid-line. That is TypeScript, and
 * TypeScript in a browser is a bundler.
 *
 * Output lands beside the source rather than in a shared `dist/`: the server
 * that serves it is three directories away and finds it by one relative path,
 * and a build folder that belongs to one page is easier to delete than one
 * that belongs to four.
 */

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, 'web', 'stage'),
  // Relative, because the page is served from `/stage/` rather than from the
  // root. Absolute asset URLs would send the projector to `/assets/…` and give
  // it four 404s and a black screen.
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(here, 'web', 'stage', 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
