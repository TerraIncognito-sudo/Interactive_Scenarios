/**
 * A name is a promise about content, and the show believes it.
 *
 * The display asks for the name `scenario.yaml` declares, the server picks a
 * content type out of its extension, and PNG bytes called `.jpg` go out
 * labelled `image/jpeg`. Browsers sniff images and forgive it; a `.wav` served
 * as `audio/mpeg` is a silent beat in front of a room, with nothing in any log.
 *
 * Two things have to hold. It must be certain before it complains — sending
 * somebody to rename a file that was already right is worse than saying
 * nothing, so an unreadable file and a family with several true names both mean
 * silence. And the correction has to move the name *everywhere*, because a
 * half-renamed asset is worse than a misnamed one: the board reports it ready
 * and one scene of the show is black.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatOf, extensionOf, misnamed, renamedTo } from '../tools/editor/format.ts';

/** A PNG header: signature, then an IHDR saying 8×8, truecolour with alpha. */
function png(): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(8, 16);
  bytes.writeUInt32BE(8, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function jpeg(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt16BE(0xffd8, 0);
  bytes.writeUInt16BE(0xffe0, 2);
  bytes.writeUInt16BE(16, 4);
  bytes.write('JFIF', 6, 'latin1');
  return bytes;
}

function wav(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(56, 4);
  bytes.write('WAVE', 8, 'latin1');
  bytes.write('fmt ', 12, 'latin1');
  return bytes;
}

function mp3(): Buffer {
  const bytes = Buffer.alloc(64);
  // MPEG 1 Layer III, 128 kbps, 44.1 kHz — a real frame header, no ID3 tag.
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  bytes[2] = 0x90;
  bytes[3] = 0x00;
  return bytes;
}

describe('what a file is', () => {
  test('the four this pipeline actually produces', async () => {
    assert.equal(formatOf(png())?.kind, 'PNG');
    assert.equal(formatOf(jpeg())?.kind, 'JPEG');
    assert.equal(formatOf(wav())?.kind, 'WAV');
    assert.equal(formatOf(mp3())?.kind, 'MP3');
  });

  test('an ID3 tag is an MP3 without needing a frame', async () => {
    const tagged = Buffer.alloc(64);
    tagged.write('ID3', 0, 'latin1');
    assert.equal(formatOf(tagged)?.kind, 'MP3');
  });

  test('RIFF is two formats and the form four bytes on decides', async () => {
    const webp = Buffer.alloc(64);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8L', 12, 'latin1');
    assert.equal(formatOf(webp)?.kind, 'WebP');
    assert.equal(formatOf(wav())?.kind, 'WAV');
  });

  test('anything it cannot place is silence, not a guess', async () => {
    assert.equal(formatOf(Buffer.alloc(64)), undefined, 'all zeroes');
    assert.equal(formatOf(Buffer.from('hello')), undefined, 'too short to look at');
    assert.equal(formatOf(Buffer.from('a plain text file, quite long')), undefined);
  });

  test('a frame sync is not accepted on eleven set bits alone', async () => {
    // The reason MPEG is checked last and strictly. `ff e0` turns up in
    // arbitrary binary, and every reserved field is a chance to say no.
    const reserved = Buffer.alloc(64);
    reserved[0] = 0xff;
    reserved[1] = 0xe8; // reserved version, reserved layer
    reserved[2] = 0x90;
    assert.equal(formatOf(reserved), undefined);

    const badBitrate = Buffer.alloc(64);
    badBitrate[0] = 0xff;
    badBitrate[1] = 0xfb;
    badBitrate[2] = 0xf0; // the bad bitrate index
    assert.equal(formatOf(badBitrate), undefined);
  });
});

describe('whether the name is a lie', () => {
  test('a PNG called .jpg is', async () => {
    assert.equal(misnamed('images/a.jpg', formatOf(png())), true);
    assert.equal(renamedTo('images/a.jpg', formatOf(png())!), 'images/a.png');
  });

  test('a WAV called .mp3 is', async () => {
    assert.equal(misnamed('voice/a.mp3', formatOf(wav())), true);
    assert.equal(renamedTo('voice/a.mp3', formatOf(wav())!), 'voice/a.wav');
  });

  test('.jpeg is a true name for a JPEG, and so is .jpg', async () => {
    // A family with several real names must never be nagged about. Being
    // technically right here would make the whole group something people skip.
    assert.equal(misnamed('images/a.jpeg', formatOf(jpeg())), false);
    assert.equal(misnamed('images/a.jpg', formatOf(jpeg())), false);
    assert.equal(misnamed('images/a.JPG', formatOf(jpeg())), false, 'case is not a lie');
  });

  test('a file it could not read is never a complaint', async () => {
    assert.equal(misnamed('images/a.jpg', undefined), false);
  });

  test('a name with no extension makes no claim to be wrong about', async () => {
    assert.equal(extensionOf('images/plain'), '');
    assert.equal(misnamed('images/plain', formatOf(png())), false);
    assert.equal(extensionOf('a.folder.name/file'), '', 'the dot is in the folder, not the name');
  });
});

const SCENARIO = [
  'id: demo',
  'title: Demo',
  'start: a',
  'characters:',
  '  tran: { name: PO Tran, sprite: images/tran-sheet.jpg }',
  'scenes:',
  '  # The jetty, shot from the seaward end.',
  '  # Both shots reuse images/jetty.jpg deliberately.',
  '  jetty: { background: images/jetty.jpg }',
  'nodes:',
  '  - id: a',
  '    type: dialogue',
  '    scene: jetty',
  '    background: images/jetty.jpg   # the same picture, named twice',
  '    lines:',
  '      - who: tran',
  '        text: Contact bearing zero four zero.',
  '        hold: 4',
  '    next: b',
  '  - id: b',
  '    type: end',
  '    text: Done',
  '',
].join('\n');

/** A project whose two pictures are both PNGs called `.jpg`. */
async function workshop() {
  const root = mkdtempSync(join(tmpdir(), 'is-format-'));
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
      '  images/jetty.jpg:',
      '    # Weeks of tuning live in a line like this one.',
      '    prompt: Pre-dawn at a working naval jetty.',
      '  images/tran-sheet.jpg:',
      '    prompt: Character sheet, PO Tran.',
      '',
    ].join('\n'),
    'utf8',
  );

  const drop = (where: string[], name: string, bytes: Buffer) => {
    mkdirSync(join(dir, ...where), { recursive: true });
    writeFileSync(join(dir, ...where, name), bytes);
  };
  drop(['generated', 'images', 'jetty.jpg'], 'jetty-01.png', png());
  drop(['generated', 'images', 'tran-sheet.jpg'], 'sheet-01.png', png());
  drop(['assets', 'images'], 'jetty.jpg', png());
  drop(['assets', 'images'], 'tran-sheet.jpg', png());

  writeFileSync(
    join(dir, '.ledger.json'),
    JSON.stringify({
      version: 1,
      assets: {
        'images/jetty.jpg': {
          selected: 'jetty-01.png',
          published: 'jetty-01.png',
          takes: [
            { id: 'jetty-01.png', hash: 'aaa', from: 'by hand', at: '2026-01-01T00:00:00.000Z', params: {} },
          ],
        },
        'images/tran-sheet.jpg': {
          selected: 'sheet-01.png',
          takes: [
            { id: 'sheet-01.png', hash: 'bbb', from: 'by hand', at: '2026-01-01T00:00:00.000Z', params: {} },
          ],
        },
      },
    }),
    'utf8',
  );

  process.env.EDITOR_CONFIG_DIR = join(root, '.config');
  const { setWorkspace } = await import('../tools/editor/workspace.ts');
  const { openProject, renameToFormat } = await import('../tools/editor/projects.ts');
  await setWorkspace(root);

  const read = (...parts: string[]) => readFileSync(join(dir, ...parts), 'utf8');
  const here = (...parts: string[]) => existsSync(join(dir, ...parts));
  const ledger = () => JSON.parse(read('.ledger.json'));
  const done = () => {
    delete process.env.EDITOR_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dir, openProject, renameToFormat, read, here, ledger, done };
}

describe('correcting it', () => {
  test('the board says which files lie and what they should be called', async () => {
    const shop = await workshop();
    try {
      const { overview } = await shop.openProject('demo');
      const jetty = overview.sections
        .flatMap((view) => view.assets)
        .find((asset) => asset.file === 'images/jetty.jpg')!;
      assert.equal(jetty.format?.actual, 'PNG');
      assert.equal(jetty.format?.declared, 'jpg');
      assert.equal(jetty.format?.rename, 'images/jetty.png');
    } finally {
      shop.done();
    }
  });

  test('the name moves everywhere the story says it, including twice in one node', async () => {
    // A half-renamed asset is worse than a misnamed one: the board reports it
    // ready and one shot of the show is a gradient.
    const shop = await workshop();
    try {
      const result = await shop.renameToFormat('demo');
      assert.equal(result.renamed.length, 2);

      const scenario = shop.read('scenario.yaml');
      // Comments stripped: a sentence that happens to name the old file is
      // prose, and prose is reported rather than rewritten. What must not
      // survive is a *reference*.
      const yaml = scenario
        .split('\n')
        .map((line) => (line.includes('#') ? line.slice(0, line.indexOf('#')) : line))
        .join(' ');
      assert.ok(!yaml.includes('images/jetty.jpg'), 'no reference left behind');
      assert.ok(!yaml.includes('images/tran-sheet.jpg'));
      assert.equal(
        yaml.split('images/jetty.png').length - 1,
        2,
        'the scene and the node override both moved',
      );
      assert.match(scenario, /sprite: images\/tran-sheet\.png/);
    } finally {
      shop.done();
    }
  });

  test('the author’s prose survives it', async () => {
    const shop = await workshop();
    try {
      await shop.renameToFormat('demo');
      const scenario = shop.read('scenario.yaml');
      assert.ok(scenario.includes('# The jetty, shot from the seaward end.'));
      assert.ok(scenario.includes('# the same picture, named twice'));

      const project = shop.read('project.yaml');
      assert.ok(
        project.includes('# Weeks of tuning live in a line like this one.'),
        'the recipe is edited by key, not re-serialised',
      );
      assert.match(project, /images\/jetty\.png:/);
      assert.match(project, /Pre-dawn at a working naval jetty\./);
    } finally {
      shop.done();
    }
  });

  test('the published file, the takes folder and the ledger follow', async () => {
    const shop = await workshop();
    try {
      await shop.renameToFormat('demo');

      assert.equal(shop.here('assets', 'images', 'jetty.png'), true);
      assert.equal(shop.here('assets', 'images', 'jetty.jpg'), false);
      assert.equal(shop.here('generated', 'images', 'jetty.png', 'jetty-01.png'), true);
      assert.equal(shop.here('generated', 'images', 'jetty.jpg'), false);

      const ledger = shop.ledger();
      assert.ok(ledger.assets['images/jetty.png'], 'the entry moved');
      assert.equal(ledger.assets['images/jetty.jpg'], undefined);
      assert.equal(ledger.assets['images/jetty.png'].published, 'jetty-01.png');
    } finally {
      shop.done();
    }
  });

  test('nothing is re-encoded — the name follows the bytes', async () => {
    const shop = await workshop();
    try {
      await shop.renameToFormat('demo');
      assert.deepEqual(
        readFileSync(join(shop.dir, 'assets', 'images', 'jetty.png')),
        png(),
        'byte for byte the file that was there',
      );
    } finally {
      shop.done();
    }
  });

  test('the asset comes out ready, and nothing is left complaining', async () => {
    const shop = await workshop();
    try {
      await shop.renameToFormat('demo');
      const { overview, outstanding } = await shop.openProject('demo');
      const assets = overview.sections.flatMap((view) => view.assets);
      assert.deepEqual(
        assets.filter((asset) => asset.format?.rename).map((asset) => asset.file),
        [],
      );
      assert.equal(
        outstanding.groups.some((group) => group.group === 'misnamed'),
        false,
      );
    } finally {
      shop.done();
    }
  });

  test('a comment naming a renamed file is reported, never reworded', async () => {
    const shop = await workshop();
    try {
      const result = await shop.renameToFormat('demo', ['images/jetty.jpg']);
      assert.deepEqual(result.comments, [8], 'the one that names the file, and only that one');
      const after = shop.read('scenario.yaml');
      assert.ok(
        after.includes('# Both shots reuse images/jetty.jpg deliberately.'),
        'now describing a name that no longer exists, and left exactly as written',
      );
      assert.ok(after.includes('# the same picture, named twice'), 'and this one is not flagged');
    } finally {
      shop.done();
    }
  });

  test('a correction that would land on another asset is refused', async () => {
    // `hero.jpg` holding a PNG beside a real `hero.png` is two files that would
    // silently become one.
    const shop = await workshop();
    try {
      writeFileSync(
        join(shop.dir, 'scenario.yaml'),
        SCENARIO.replace(
          '  jetty: { background: images/jetty.jpg }',
          '  jetty: { background: images/jetty.jpg }\n  quay: { background: images/jetty.png }',
        ),
        'utf8',
      );
      mkdirSync(join(shop.dir, 'generated', 'images', 'jetty.png'), { recursive: true });
      writeFileSync(join(shop.dir, 'assets', 'images', 'jetty.png'), png());

      const result = await shop.renameToFormat('demo', ['images/jetty.jpg']);
      assert.deepEqual(result.renamed, []);
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0]!.why, /already a different asset/);
      assert.ok(shop.read('scenario.yaml').includes('images/jetty.jpg'), 'left alone');
    } finally {
      shop.done();
    }
  });

  test('running it twice changes nothing the second time', async () => {
    const shop = await workshop();
    try {
      await shop.renameToFormat('demo');
      const before = shop.read('scenario.yaml');
      const again = await shop.renameToFormat('demo');
      assert.deepEqual(again.renamed, []);
      assert.equal(shop.read('scenario.yaml'), before, 'byte for byte');
    } finally {
      shop.done();
    }
  });
});
