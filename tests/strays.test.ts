/**
 * The disk a cut line leaves behind.
 *
 * The board is built from the scenario, which is what keeps it from ever
 * drifting — delete a line of dialogue and its row goes with it. The cost of
 * that is the one thing the board could not tell you: the clip is still in
 * `assets/` and its six takes are still in `generated/`, and because they are
 * not on the board nothing ever mentions them again. A project accumulates
 * them for its whole life and the only way to find them was to compare two
 * folder listings by hand.
 *
 * So most of these are about what must *not* be swept up: a live asset, a file
 * in the publish root that the pipeline never put there, and the recipe row,
 * which is an afternoon of tuning and somebody else's decision.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
  'nodes:',
  '  - id: a',
  '    type: dialogue',
  '    scene: bridge',
  '    lines:',
  '      - who: tran',
  '        text: Contact bearing zero four zero.',
  '        hold: 4',
  '        voice: voice/tran-a-01.mp3',
  '    next: b',
  '  - id: b',
  '    type: end',
  '    text: Done',
  '',
].join('\n');

/**
 * A project holding one live line and one that was cut.
 *
 * `voice/tran-a-02.mp3` is the cut one: the scenario does not mention it, and
 * its clip, its two takes and its ledger entry are all still there — which is
 * exactly the state a real project is left in by an edit to the story.
 */
async function workshop() {
  const root = mkdtempSync(join(tmpdir(), 'is-strays-'));
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
      '  voice/tran-a-01.mp3:',
      '    text: Contact bearing zero four zero.',
      '  voice/tran-a-02.mp3:',
      '    text: A line that was cut.',
      '',
    ].join('\n'),
    'utf8',
  );

  const take = (section: string, folder: string, name: string, body: string) => {
    const at = join(dir, 'generated', section, folder);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, name), body);
  };
  const shipped = (name: string, body: string) => {
    mkdirSync(join(dir, 'assets', name.split('/')[0]!), { recursive: true });
    writeFileSync(join(dir, 'assets', name), body);
  };

  take('voice', 'tran-a-01.mp3', 'aaa-01.mp3', 'the live one');
  take('voice', 'tran-a-02.mp3', 'bbb-01.mp3', 'cut, first reading');
  take('voice', 'tran-a-02.mp3', 'bbb-02.mp3', 'cut, second reading');
  take('images', 'old-bridge.jpg', 'ccc-01.jpg', 'a picture nothing plays');

  shipped('voice/tran-a-01.mp3', 'the live one');
  shipped('voice/tran-a-02.mp3', 'cut, second reading');
  shipped('images/bridge.jpg', 'the live picture');
  // Not the pipeline's. Nothing may ever decide this is rubbish.
  writeFileSync(join(dir, 'assets', 'README.md'), 'Drop finished art in here.');

  writeFileSync(
    join(dir, '.ledger.json'),
    JSON.stringify({
      version: 1,
      assets: {
        'voice/tran-a-01.mp3': {
          selected: 'aaa-01.mp3',
          published: 'aaa-01.mp3',
          takes: [{ id: 'aaa-01.mp3', hash: 'aaa', at: '2026-01-01T00:00:00.000Z', params: {} }],
        },
        'voice/tran-a-02.mp3': {
          selected: 'bbb-02.mp3',
          published: 'bbb-02.mp3',
          takes: [
            { id: 'bbb-01.mp3', hash: 'bbb', at: '2026-01-01T00:00:00.000Z', params: {} },
            { id: 'bbb-02.mp3', hash: 'bbb', at: '2026-01-01T00:01:00.000Z', params: {} },
          ],
        },
        'images/old-bridge.jpg': {
          selected: 'ccc-01.jpg',
          takes: [{ id: 'ccc-01.jpg', hash: 'ccc', at: '2026-01-01T00:00:00.000Z', params: {} }],
        },
      },
    }),
    'utf8',
  );

  process.env.EDITOR_CONFIG_DIR = join(root, '.config');
  const { setWorkspace } = await import('../client/app/workspace.ts');
  const { openProject, discardStrays } = await import('../client/app/projects.ts');
  await setWorkspace(root);

  const ledger = () => JSON.parse(readFileSync(join(dir, '.ledger.json'), 'utf8'));
  const here = (...parts: string[]) => existsSync(join(dir, ...parts));
  const done = () => {
    delete process.env.EDITOR_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dir, openProject, discardStrays, ledger, here, done };
}

describe('finding what the story dropped', () => {
  test('a cut line’s clip and every take of it', async () => {
    const shop = await workshop();
    try {
      const { overview } = await shop.openProject('demo');
      const cut = overview.strays.find((stray) => stray.file === 'voice/tran-a-02.mp3');
      assert.ok(cut, 'the cut line is a stray');
      assert.equal(cut.published, true, 'its clip is still shipped');
      assert.equal(cut.takes, 2, 'and both readings are still in the folder');
      assert.ok(cut.bytes > 0, 'with a size, so the list can say what it buys');
      assert.equal(cut.section, 'voice');
    } finally {
      shop.done();
    }
  });

  test('a takes folder with nothing shipped is still found, under its real name', async () => {
    // `generated/images/old-bridge.jpg/` is a mangled directory. Reporting it
    // as a path rather than as the asset it belonged to is asking somebody to
    // recognise a folder name they have never seen.
    const shop = await workshop();
    try {
      const { overview } = await shop.openProject('demo');
      const picture = overview.strays.find((stray) => stray.file === 'images/old-bridge.jpg');
      assert.ok(picture, 'found');
      assert.equal(picture.published, false);
      assert.equal(picture.takes, 1);
    } finally {
      shop.done();
    }
  });

  test('nothing the scenario still asks for', async () => {
    const shop = await workshop();
    try {
      const { overview } = await shop.openProject('demo');
      const named = overview.strays.map((stray) => stray.file);
      assert.ok(!named.includes('voice/tran-a-01.mp3'), 'the live clip is not rubbish');
      assert.ok(!named.includes('images/bridge.jpg'), 'nor the live picture');
    } finally {
      shop.done();
    }
  });

  test('and nothing sitting loose in the publish folder', async () => {
    // Once the scenario stops naming a file, the folder it was filed into is
    // the last record of what kind of thing it was. The publish root is not
    // that — it is also where a README, a licence or somebody's notes live,
    // and guessing there is how a sweep deletes something it did not make.
    const shop = await workshop();
    try {
      const { overview } = await shop.openProject('demo');
      assert.deepEqual(
        overview.strays.map((stray) => stray.file).filter((file) => !file.includes('/')),
        [],
      );
    } finally {
      shop.done();
    }
  });
});

describe('sweeping it up', () => {
  test('takes the clip, the takes and the ledger entry', async () => {
    const shop = await workshop();
    try {
      const result = await shop.discardStrays('demo', ['voice/tran-a-02.mp3']);

      assert.equal(result.removed.length, 1);
      assert.deepEqual(result.removed[0], {
        file: 'voice/tran-a-02.mp3',
        published: true,
        takes: 2,
        bytes: result.removed[0]!.bytes,
      });
      assert.ok(result.bytes > 0, 'and says what it freed');

      assert.equal(shop.here('assets', 'voice', 'tran-a-02.mp3'), false);
      assert.equal(shop.here('generated', 'voice', 'tran-a-02.mp3'), false);
      assert.equal(
        shop.ledger().assets['voice/tran-a-02.mp3'],
        undefined,
        'a take list pointing at files that are gone is a state nothing can resolve',
      );
    } finally {
      shop.done();
    }
  });

  test('and leaves the live line exactly where it was', async () => {
    const shop = await workshop();
    try {
      await shop.discardStrays('demo');

      assert.equal(shop.here('assets', 'voice', 'tran-a-01.mp3'), true);
      assert.equal(shop.here('generated', 'voice', 'tran-a-01.mp3', 'aaa-01.mp3'), true);
      assert.equal(shop.here('assets', 'images', 'bridge.jpg'), true);
      assert.equal(shop.here('assets', 'README.md'), true, 'not ours to throw away');
      assert.ok(shop.ledger().assets['voice/tran-a-01.mp3'], 'still recorded');
    } finally {
      shop.done();
    }
  });

  test('the recipe stays — a prompt is a different decision', async () => {
    // Pruning throws away tuning and happens in front of the list; this is
    // bytes. Doing both at once would make one of the two silent.
    const shop = await workshop();
    try {
      await shop.discardStrays('demo');
      const source = readFileSync(join(shop.dir, 'project.yaml'), 'utf8');
      assert.match(source, /voice\/tran-a-02\.mp3/);
      assert.match(source, /A line that was cut\./);

      const { overview } = await shop.openProject('demo');
      assert.deepEqual(overview.strays, [], 'nothing left to sweep');
      assert.ok(
        overview.orphans.includes('voice/tran-a-02.mp3'),
        'and the row is still reported as an orphan, which is the other list',
      );
    } finally {
      shop.done();
    }
  });

  test('a name the board does not call a stray is refused, not deleted', async () => {
    // The whole safety argument. The client sends names, never paths, and the
    // server recomputes what is rubbish rather than believing it.
    const shop = await workshop();
    try {
      const result = await shop.discardStrays('demo', [
        'voice/tran-a-01.mp3',
        '../../../etc/passwd',
      ]);

      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.skipped.sort(), ['../../../etc/passwd', 'voice/tran-a-01.mp3']);
      assert.equal(shop.here('assets', 'voice', 'tran-a-01.mp3'), true);
    } finally {
      shop.done();
    }
  });

  test('running it twice is not an error', async () => {
    const shop = await workshop();
    try {
      const first = await shop.discardStrays('demo');
      const second = await shop.discardStrays('demo');
      assert.ok(first.removed.length >= 2);
      assert.deepEqual(second.removed, []);
      assert.equal(second.bytes, 0);
    } finally {
      shop.done();
    }
  });
});
