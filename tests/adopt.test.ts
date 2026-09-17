/**
 * The way out of "not reproducible".
 *
 * `unmanaged` means there is a file in place and nothing on record says which
 * recipe it answers. For a section with no generator that was every asset in
 * it, permanently: importing a take wrote the bytes and no ledger line, so the
 * row went on reporting `unmanaged` with the file sitting in its own takes
 * folder, selected — and the command centre's advice was to import it, which
 * was the thing that had just been done. Twelve images in a real project were
 * stuck there with no route out at all.
 *
 * So these are about the two ends of it: an import must record what it brought
 * in, and anything already in that state must be recoverable without asking
 * the author to find the file again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCENARIO = [
  'id: demo',
  'title: Demo',
  'start: a',
  'characters:',
  '  tran: { name: PO Tran }',
  'scenes:',
  '  bridge: { background: images/bridge.jpg }',
  '  jetty: { background: images/jetty.jpg }',
  'nodes:',
  '  - id: a',
  '    type: dialogue',
  '    scene: bridge',
  '    lines:',
  '      - who: tran',
  '        text: Contact bearing zero four zero.',
  '        hold: 4',
  '    next: b',
  '  - id: b',
  '    type: end',
  '    scene: jetty',
  '    text: Done',
  '',
].join('\n');

/**
 * A project with two hand-made pictures in the two states that produce
 * `unmanaged`: one with an unrecorded file in its takes folder, and one with
 * nothing but a published file.
 */
async function workshop() {
  const root = mkdtempSync(join(tmpdir(), 'is-adopt-'));
  const dir = join(root, 'demo');
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'scenario.yaml'), SCENARIO, 'utf8');
  writeFileSync(
    join(dir, 'project.yaml'),
    [
      'project: demo',
      'scenario: scenario.yaml',
      'publish: assets',
      'generated: generated',
      'assets:',
      '  images/bridge.jpg:',
      '    prompt: The bridge at dawn.',
      '  images/jetty.jpg:',
      '    prompt: A working naval jetty.',
      '',
    ].join('\n'),
    'utf8',
  );

  // Dropped into the takes folder by hand and chosen, which is what an import
  // used to leave behind.
  mkdirSync(join(dir, 'generated', 'images', 'bridge.jpg'), { recursive: true });
  writeFileSync(join(dir, 'generated', 'images', 'bridge.jpg', 'bridge-final.png'), 'a picture');

  mkdirSync(join(dir, 'assets', 'images'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'images', 'bridge.jpg'), 'a picture');
  // Nothing in a takes folder at all — the file was simply put where the show
  // opens it.
  writeFileSync(join(dir, 'assets', 'images', 'jetty.jpg'), 'the jetty');

  writeFileSync(
    join(dir, '.ledger.json'),
    JSON.stringify({
      version: 1,
      assets: { 'images/bridge.jpg': { selected: 'bridge-final.png', takes: [] } },
    }),
    'utf8',
  );

  process.env.EDITOR_CONFIG_DIR = join(root, '.config');
  const { setWorkspace } = await import('../client/app/workspace.ts');
  const { openProject, adoptTakes, importTake, saveProjectSource } = await import(
    '../client/app/projects.ts'
  );
  await setWorkspace(root);

  const find = async (file: string) => {
    const { overview } = await openProject('demo');
    return overview.sections.flatMap((view) => view.assets).find((a) => a.file === file)!;
  };
  const done = () => {
    delete process.env.EDITOR_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dir, openProject, adoptTakes, importTake, saveProjectSource, find, done };
}

describe('the state it starts in', () => {
  test('a chosen file nothing recorded is unmanaged, both ways round', async () => {
    const shop = await workshop();
    try {
      assert.equal((await shop.find('images/bridge.jpg')).status, 'unmanaged');
      assert.equal((await shop.find('images/jetty.jpg')).status, 'unmanaged');
    } finally {
      shop.done();
    }
  });
});

describe('adopting', () => {
  test('records the take already in the folder, and the row goes ready', async () => {
    const shop = await workshop();
    try {
      const result = await shop.adoptTakes('demo', ['images/bridge.jpg']);

      assert.equal(result.adopted.length, 1);
      assert.equal(result.adopted[0]!.take, 'bridge-final.png');
      assert.equal(result.adopted[0]!.from, 'the takes folder');
      assert.equal(result.adopted[0]!.copied, false, 'nothing was moved');

      const view = await shop.find('images/bridge.jpg');
      assert.equal(view.status, 'ready');
      assert.equal(view.takes[0]!.untracked, undefined, 'it is on record now');
      assert.equal(view.takes[0]!.from, 'the takes folder');
    } finally {
      shop.done();
    }
  });

  test('the hash it records is the recipe’s, so a prompt edit still marks it stale', async () => {
    // The whole reason this writes a hash rather than a flag. An adopted file
    // that could never go stale is a picture that quietly stops matching the
    // row it was drawn for, which is the failure the board exists to catch.
    const shop = await workshop();
    try {
      await shop.adoptTakes('demo', ['images/bridge.jpg']);
      assert.equal((await shop.find('images/bridge.jpg')).status, 'ready');

      await shop.saveProjectSource(
        'demo',
        readFileSync(join(shop.dir, 'project.yaml'), 'utf8').replace(
          'The bridge at dawn.',
          'The bridge at dusk, snow on the rail.',
        ),
      );

      assert.equal((await shop.find('images/bridge.jpg')).status, 'stale');
    } finally {
      shop.done();
    }
  });

  test('with nothing in the takes folder, the published file is copied in', async () => {
    // Adopting a take that does not exist would record a lie. The published
    // file is the only copy there is, so the takes folder gets one — and this
    // is the one case that may claim which take shipped, because it is the
    // copy that just made them the same bytes.
    const shop = await workshop();
    try {
      const result = await shop.adoptTakes('demo', ['images/jetty.jpg']);

      assert.equal(result.adopted.length, 1);
      assert.equal(result.adopted[0]!.copied, true);
      assert.equal(result.adopted[0]!.from, 'the published file');
      assert.equal(
        readFileSync(join(shop.dir, 'generated', 'images', 'jetty.jpg', 'jetty.jpg'), 'utf8'),
        'the jetty',
      );
      assert.equal(
        existsSync(join(shop.dir, 'assets', 'images', 'jetty.jpg')),
        true,
        'a copy, not a move — the show still opens it',
      );

      const view = await shop.find('images/jetty.jpg');
      assert.equal(view.status, 'ready');
      assert.equal(view.republish, undefined, 'and it does not then ask to be re-published');
    } finally {
      shop.done();
    }
  });

  test('several files and none chosen is a different question, and stays one', async () => {
    // The boundary. Adopting takes the *selected* file, because that is the one
    // the author called their answer. A folder with nothing picked reads as
    // `unselected`, and picking one here would be answering on their behalf.
    const shop = await workshop();
    try {
      writeFileSync(join(shop.dir, 'generated', 'images', 'bridge.jpg', 'try-two.png'), 'another');
      writeFileSync(
        join(shop.dir, '.ledger.json'),
        JSON.stringify({ version: 1, assets: {} }),
        'utf8',
      );

      assert.equal((await shop.find('images/bridge.jpg')).status, 'unselected');
      const result = await shop.adoptTakes('demo', ['images/bridge.jpg']);
      assert.deepEqual(result.adopted, []);
      assert.deepEqual(result.skipped, [
        { file: 'images/bridge.jpg', why: 'not waiting to be adopted' },
      ]);
    } finally {
      shop.done();
    }
  });

  test('a name the board is not offering is refused', async () => {
    const shop = await workshop();
    try {
      await shop.adoptTakes('demo');
      const again = await shop.adoptTakes('demo', ['images/bridge.jpg', '../../etc/passwd']);
      assert.deepEqual(again.adopted, []);
      assert.equal(again.skipped.length, 2, 'both — one is done, one is not a thing');
    } finally {
      shop.done();
    }
  });

  test('the whole board at once, and running it twice changes nothing', async () => {
    const shop = await workshop();
    try {
      const first = await shop.adoptTakes('demo');
      assert.equal(first.adopted.length, 2);

      const { overview } = await shop.openProject('demo');
      assert.equal(
        overview.sections.flatMap((v) => v.assets).filter((a) => a.status === 'unmanaged').length,
        0,
        'the group empties, which is what the command centre promises',
      );

      const second = await shop.adoptTakes('demo');
      assert.deepEqual(second.adopted, []);
    } finally {
      shop.done();
    }
  });
});

describe('importing', () => {
  const bytes = (content: string) => Readable.from([Buffer.from(content)]);

  test('records what it brought in, so the row is not unmanaged afterwards', async () => {
    // The bug in one assertion. The import wrote the file and stopped, and the
    // board's advice for the row it produced was to import it.
    const shop = await workshop();
    try {
      rmSync(join(shop.dir, 'assets', 'images', 'jetty.jpg'));
      const result = await shop.importTake(
        'demo',
        { section: 'images', file: 'images/jetty.jpg', filename: 'jetty-v3-final.png' },
        bytes('a picture'),
      );

      assert.equal(result.tracked, true);
      assert.equal(result.selected, true);

      const view = await shop.find('images/jetty.jpg');
      assert.equal(view.status, 'ready');
      assert.equal(view.takes[0]!.from, 'jetty-v3-final.png', 'and says where it came from');
      assert.equal(view.takes[0]!.seed, undefined, 'with no seed, because nothing rolled one');
    } finally {
      shop.done();
    }
  });

  test('a second import is a second take and does not steal the selection', async () => {
    const shop = await workshop();
    try {
      rmSync(join(shop.dir, 'assets', 'images', 'jetty.jpg'));
      await shop.importTake(
        'demo',
        { section: 'images', file: 'images/jetty.jpg', filename: 'one.png' },
        bytes('first'),
      );
      const two = await shop.importTake(
        'demo',
        { section: 'images', file: 'images/jetty.jpg', filename: 'two.png' },
        bytes('second'),
      );

      assert.equal(two.selected, false);
      const view = await shop.find('images/jetty.jpg');
      assert.equal(view.selected, 'one.png');
      assert.equal(view.takes.length, 2);
    } finally {
      shop.done();
    }
  });
});
