/**
 * The board is served raw, so nothing else is checking that it parses.
 *
 * Every other surface in this project goes through a bundler or through `tsc`,
 * either of which refuses a file it cannot read. The board is deliberately not
 * one of those — it is ten thousand lines of vanilla ES modules served
 * straight off disk, because editing a tool somebody uses all day should be
 * one reload rather than a rebuild. The price is that a syntax error in it is
 * a *runtime* fact, discovered by opening the window.
 *
 * That price came due. A `\n` was written into `app.js` as a real newline
 * inside a string literal, which made the module unparseable, which meant the
 * board rendered nothing at all — not a broken tab, the whole window blank
 * with one line in a console nobody had open. It shipped, and the suite stayed
 * green over it, because the suite had no opinion about whether the board was
 * a program.
 *
 * So this is the cheapest possible opinion. It proves nothing about behaviour
 * and is not trying to; it catches the three ways this tool goes completely
 * dark — a file that does not parse, an import that points at nothing, and an
 * id reached for that the markup does not have — each of which is invisible to
 * everything else here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BOARD = join(import.meta.dirname, '..', 'client', 'web', 'board');

describe('the board is a program', () => {
  test('every module parses', async () => {
    const files = (await readdir(BOARD)).filter((name) => name.endsWith('.js'));
    // A guard on the guard: a rename that emptied this folder would otherwise
    // leave a test passing by checking nothing.
    assert.ok(files.length >= 5, `only found ${files.length} board modules`);

    for (const name of files) {
      // `node --check`, because the parser that will load these files is the
      // only one whose opinion matters. Anything in-process would need the
      // module goal arranged by hand, and arranging it wrongly is how a check
      // like this passes a file the browser then refuses.
      assert.doesNotThrow(
        () => execFileSync(process.execPath, ['--check', join(BOARD, name)], { stdio: 'pipe' }),
        `${name} does not parse`,
      );
    }
  });

  test('every module the page loads is actually there', async () => {
    // A broken import path fails exactly as loudly as a syntax error and in
    // the same place: nothing renders. The page names its entry points and the
    // modules name each other, so the whole graph is walked.
    const html = await readFile(join(BOARD, 'index.html'), 'utf8');
    const entries = [...html.matchAll(/src="\.\/([A-Za-z0-9_.-]+\.js)"/g)].map((m) => m[1]!);
    assert.ok(entries.length > 0, 'the page loads no script, so it does nothing');

    const files = new Set(await readdir(BOARD));
    const seen = new Set<string>();
    const queue = [...entries];

    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      assert.ok(files.has(name), `${name} is imported but not in the board folder`);

      const source = await readFile(join(BOARD, name), 'utf8');
      for (const match of source.matchAll(/from '\.\/([A-Za-z0-9_.-]+\.js)'/g)) {
        queue.push(match[1]!);
      }
    }

    assert.ok(seen.has('app.js'), 'app.js is never reached from the page');
  });

  test('every id a module wires at boot is in the markup', async () => {
    // `$('show-play').addEventListener` on a missing element is a TypeError
    // during boot, which takes the rest of that module's wiring down with it —
    // the same blank window as a syntax error, one line further on. Only the
    // ids written as literals are checked, which is most of them and all of
    // the ones wired up before anything has rendered.
    const html = await readFile(join(BOARD, 'index.html'), 'utf8');
    const files = (await readdir(BOARD)).filter((name) => name.endsWith('.js'));

    for (const name of files) {
      const source = await readFile(join(BOARD, name), 'utf8');
      for (const match of source.matchAll(/\$\('([a-z][a-z0-9-]*)'\)/g)) {
        const id = match[1]!;
        assert.ok(
          html.includes(`id="${id}"`),
          `${name} reaches for #${id}, which is not in index.html`,
        );
      }
    }
  });
});
