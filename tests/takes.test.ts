/**
 * Throwing a take away.
 *
 * Re-rolling is free, which is what makes it worth doing — and the cost of that
 * is a folder holding nine readings of one line, six rejected on the first
 * listen. What has to stay true while they are cleared out is that the *show*
 * does not change: publishing is the deliberate act that puts a reading in
 * front of an audience, and nothing here may quietly undo one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A project on disk, with a workspace pointed at it.
 *
 * The config location is read when the workspace module is first evaluated, so
 * the import has to happen after the environment is set — and it points at a
 * throwaway folder so the real editor config is never touched.
 */
async function workshop() {
  const root = mkdtempSync(join(tmpdir(), 'is-takes-'));
  const dir = join(root, 'demo');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'scenario.yaml'),
    [
      'id: demo',
      'title: Demo',
      'start: a',
      'characters:',
      '  tran: { name: PO Tran }',
      'scenes:',
      '  bridge: {}',
      'nodes:',
      '  - id: a',
      '    type: dialogue',
      '    scene: bridge',
      '    lines:',
      '      - who: tran',
      '        text: Contact bearing zero four zero.',
      '        voice: voice/tran-a-01.mp3',
      '    next: b',
      '  - id: b',
      '    type: end',
      '    text: Done',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    join(dir, 'project.yaml'),
    ['project: demo', 'scenario: scenario.yaml', 'publish: assets', 'generated: generated', ''].join(
      '\n',
    ),
    'utf8',
  );

  const takes = join(dir, 'generated', 'voice', 'tran-a-01.mp3');
  mkdirSync(takes, { recursive: true });
  writeFileSync(join(takes, 'abc123-01.mp3'), 'take one');
  writeFileSync(join(takes, 'abc123-02.mp3'), 'take two');

  mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'voice', 'tran-a-01.mp3'), 'take two');

  writeFileSync(
    join(dir, '.ledger.json'),
    JSON.stringify({
      version: 1,
      assets: {
        'voice/tran-a-01.mp3': {
          selected: 'abc123-02.mp3',
          takes: [
            { id: 'abc123-01.mp3', hash: 'abc123', at: '2026-01-01T00:00:00.000Z', params: {} },
            { id: 'abc123-02.mp3', hash: 'abc123', at: '2026-01-01T00:01:00.000Z', params: {} },
          ],
        },
      },
    }),
    'utf8',
  );

  process.env.EDITOR_CONFIG_DIR = join(root, '.config');
  const { setWorkspace } = await import('../tools/editor/workspace.ts');
  const { deleteTake, openProject } = await import('../tools/editor/projects.ts');
  await setWorkspace(root);

  const ledger = () => JSON.parse(readFileSync(join(dir, '.ledger.json'), 'utf8'));
  const done = () => {
    delete process.env.EDITOR_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dir, takes, deleteTake, openProject, ledger, done };
}

describe('importing a finished file', () => {
  /** What the route hands `importTake`: the request, which is a stream. */
  const bytes = (content: string) => Readable.from([Buffer.from(content)]);

  test('lands in the takes folder, which it creates', async () => {
    const shop = await workshop();
    try {
      const { importTake } = await import('../tools/editor/projects.ts');
      const result = await importTake(
        'demo',
        { section: 'images', file: 'images/a1-jetty.png', filename: 'jetty-v3-final.png' },
        bytes('a picture'),
      );

      const folder = join(shop.dir, 'generated', 'images', 'a1-jetty.png');
      assert.equal(result.take, 'jetty-v3-final.png', 'the author’s own name is kept');
      assert.equal(readFileSync(join(folder, 'jetty-v3-final.png'), 'utf8'), 'a picture');
      assert.equal(result.bytes, 9);
    } finally {
      shop.done();
    }
  });

  test('a second import of the same name is a second take, not a replacement', async () => {
    // Two attempts called `final.png` is the normal case, and overwriting the
    // first would throw away a reading the author may already have selected.
    const shop = await workshop();
    try {
      const { importTake } = await import('../tools/editor/projects.ts');
      const one = await importTake(
        'demo',
        { section: 'images', file: 'images/a1-jetty.png', filename: 'final.png' },
        bytes('first'),
      );
      const two = await importTake(
        'demo',
        { section: 'images', file: 'images/a1-jetty.png', filename: 'final.png' },
        bytes('second'),
      );

      assert.equal(one.take, 'final.png');
      assert.equal(two.take, 'final-2.png');
      const folder = join(shop.dir, 'generated', 'images', 'a1-jetty.png');
      assert.equal(readFileSync(join(folder, 'final.png'), 'utf8'), 'first');
      assert.equal(readFileSync(join(folder, 'final-2.png'), 'utf8'), 'second');
    } finally {
      shop.done();
    }
  });

  test('the first take is selected, and later ones never steal it', async () => {
    const shop = await workshop();
    try {
      const { importTake } = await import('../tools/editor/projects.ts');
      const first = await importTake(
        'demo',
        { section: 'images', file: 'images/a1-jetty.png', filename: 'one.png' },
        bytes('first'),
      );
      const second = await importTake(
        'demo',
        { section: 'images', file: 'images/a1-jetty.png', filename: 'two.png' },
        bytes('second'),
      );

      assert.equal(first.selected, true, 'an asset with one take and no selection is a false gap');
      assert.equal(second.selected, false);
      assert.equal(shop.ledger().assets['images/a1-jetty.png'].selected, 'one.png');
    } finally {
      shop.done();
    }
  });

  test('a name from a dialog is made into a take id, or refused', async () => {
    const shop = await workshop();
    try {
      const { importTake } = await import('../tools/editor/projects.ts');
      // A path is a filename here — the dialog gives a bare name, but nothing
      // downstream should depend on that being true.
      const result = await importTake(
        'demo',
        { section: 'images', file: 'images/a1-jetty.png', filename: '../../etc/pass wd.png' },
        bytes('x'),
      );
      assert.equal(result.take, 'pass-wd.png');

      await assert.rejects(
        () =>
          importTake(
            'demo',
            { section: 'images', file: 'images/a1-jetty.png', filename: 'notes.txt' },
            bytes('x'),
          ),
        /does not handle/,
      );
    } finally {
      shop.done();
    }
  });

  test('a transfer that fails leaves no half-written take behind', async () => {
    // A truncated file in a takes folder looks exactly like a take, and the
    // author would find out by selecting it and hearing nothing.
    const shop = await workshop();
    try {
      const { importTake } = await import('../tools/editor/projects.ts');
      const broken = new Readable({
        read() {
          this.push(Buffer.from('half a '));
          this.destroy(new Error('network drive went away'));
        },
      });

      await assert.rejects(
        () =>
          importTake(
            'demo',
            { section: 'images', file: 'images/a1-jetty.png', filename: 'half.png' },
            broken,
          ),
        /network drive went away/,
      );

      const folder = join(shop.dir, 'generated', 'images', 'a1-jetty.png');
      assert.deepEqual(readdirSync(folder), [], 'not even the temporary file');
    } finally {
      shop.done();
    }
  });
});

describe('deleting a take', () => {
  test('the file goes, and so does its line in the ledger', async () => {
    const shop = await workshop();
    try {
      await shop.deleteTake('demo', 'voice', 'voice/tran-a-01.mp3', 'abc123-01.mp3');

      assert.equal(existsSync(join(shop.takes, 'abc123-01.mp3')), false);
      const entry = shop.ledger().assets['voice/tran-a-01.mp3'];
      assert.deepEqual(
        entry.takes.map((take: { id: string }) => take.id),
        ['abc123-02.mp3'],
      );
      // Not the one that was chosen, so the choice stands.
      assert.equal(entry.selected, 'abc123-02.mp3');
    } finally {
      shop.done();
    }
  });

  test('deleting the selected take clears the selection rather than moving it', async () => {
    const shop = await workshop();
    try {
      await shop.deleteTake('demo', 'voice', 'voice/tran-a-01.mp3', 'abc123-02.mp3');

      const entry = shop.ledger().assets['voice/tran-a-01.mp3'];
      assert.equal(entry.selected, undefined, 'picking a replacement is the author’s');
      assert.deepEqual(
        entry.takes.map((take: { id: string }) => take.id),
        ['abc123-01.mp3'],
      );
    } finally {
      shop.done();
    }
  });

  test('the published file is never touched', async () => {
    // The one that matters. Publishing is what puts a reading in front of an
    // audience; a delete that also un-shipped a line would be a very quiet way
    // to lose one, and it would not be noticed until the room went silent.
    const shop = await workshop();
    try {
      await shop.deleteTake('demo', 'voice', 'voice/tran-a-01.mp3', 'abc123-02.mp3');
      assert.equal(
        readFileSync(join(shop.dir, 'assets', 'voice', 'tran-a-01.mp3'), 'utf8'),
        'take two',
      );
    } finally {
      shop.done();
    }
  });

  test('a ledger entry whose file is already gone can still be cleared', async () => {
    const shop = await workshop();
    try {
      rmSync(join(shop.takes, 'abc123-01.mp3'));
      await shop.deleteTake('demo', 'voice', 'voice/tran-a-01.mp3', 'abc123-01.mp3');
      assert.deepEqual(
        shop.ledger().assets['voice/tran-a-01.mp3'].takes.map((t: { id: string }) => t.id),
        ['abc123-02.mp3'],
      );
    } finally {
      shop.done();
    }
  });

  test('a take name that is a path is refused', async () => {
    // This string reaches `join()` on the way to an `rm`, and the editor
    // deletes without asking anyone twice.
    const shop = await workshop();
    try {
      for (const bad of ['../../project.yaml', 'a/b.mp3', '..']) {
        await assert.rejects(
          () => shop.deleteTake('demo', 'voice', 'voice/tran-a-01.mp3', bad),
          /Bad take name/,
        );
      }
      await assert.rejects(
        () => shop.deleteTake('demo', 'voice', '../scenario.yaml', 'abc123-01.mp3'),
        /Bad asset name/,
      );
      assert.equal(existsSync(join(shop.dir, 'project.yaml')), true);
    } finally {
      shop.done();
    }
  });

  test('publishing a whole part is a list, and one bad name does not stop it', async () => {
    // What the per-actor Publish button sends: every clip of theirs that has a
    // selection, in one call. A part is ninety lines and the ninetieth failing
    // must not throw away the eighty-nine that worked.
    const shop = await workshop();
    try {
      const { publish } = await import('../tools/editor/projects.ts');
      const result = await publish('demo', {
        section: 'voice',
        files: ['voice/tran-a-01.mp3', 'voice/nothing-selected.mp3'],
      });

      assert.deepEqual(
        result.published.map((entry) => entry.file),
        ['voice/tran-a-01.mp3'],
      );
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0]!.error, /[Nn]othing is selected/);
      assert.equal(
        readFileSync(join(shop.dir, 'assets', 'voice', 'tran-a-01.mp3'), 'utf8'),
        'take two',
      );
    } finally {
      shop.done();
    }
  });

  test('the board reflects it without a reload', async () => {
    const shop = await workshop();
    try {
      await shop.deleteTake('demo', 'voice', 'voice/tran-a-01.mp3', 'abc123-01.mp3');
      const open = await shop.openProject('demo');
      const asset = open.overview.sections
        .find((view) => view.section === 'voice')!
        .assets.find((entry) => entry.file === 'voice/tran-a-01.mp3')!;
      assert.deepEqual(
        asset.takes.map((take) => take.id),
        ['abc123-02.mp3'],
      );
    } finally {
      shop.done();
    }
  });
});
