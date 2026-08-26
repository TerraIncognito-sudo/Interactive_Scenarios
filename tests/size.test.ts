/**
 * How big a picture is supposed to be, and how big it actually is.
 *
 * The failure this guards is the one that comes with making art somewhere else
 * and dropping it in. Every web UI opens on a square, so a still arrives at
 * 1024×1024, lands in a 16:9 show, and is either letterboxed with grey bars or
 * cropped through the subject. The board reports it ready. It is discovered on
 * a projector.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  defaultSizeFor,
  formatSize,
  parseSize,
  readImageSize,
  sizeOf,
  PORTRAIT,
  STAGE,
} from '../tools/editor/size.ts';
import { ScenarioSchema } from '../src/scenario/schema.ts';
import { ProjectSchema, EMPTY_LEDGER, pathsOf, takesDir } from '../tools/editor/project.ts';
import { buildOverview } from '../tools/editor/sections.ts';

/** A real PNG of the given size — header and one IDAT, which is all that is read. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const withType = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    // A real CRC is not needed to read a header, and nothing here decodes.
    crc.writeUInt32BE(0);
    return Buffer.concat([length, withType, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const rows = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG with several segments before the frame header, as a real export has. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(11),
  ]);
  // A fat colour profile, which is exactly what pushes the frame header past
  // any fixed offset a lazier reader would have used.
  const iccLength = 2 + 4000;
  const icc = Buffer.concat([
    Buffer.from([0xff, 0xe2, iccLength >> 8, iccLength & 0xff]),
    Buffer.alloc(4000),
  ]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, icc, sof]);
}

describe('reading a size off a file', () => {
  test('a PNG', () => {
    assert.deepEqual(sizeOf(png(1920, 1080)), { width: 1920, height: 1080 });
  });

  test('a JPEG, past four kilobytes of colour profile', () => {
    // The dimensions sit in a frame header after however many comment and
    // profile segments the encoder wrote. Reading a fixed offset finds noise.
    assert.deepEqual(sizeOf(jpeg(832, 1216)), { width: 832, height: 1216 });
  });

  test('something that is not an image at all', () => {
    assert.equal(sizeOf(Buffer.from('id: x\ntitle: X\n')), undefined);
  });

  test('a file that is not there', async () => {
    assert.equal(await readImageSize(join(tmpdir(), 'nope-there-is-no-such-file.png')), undefined);
  });
});

describe('what size a picture should be', () => {
  const spriteOrigin = { kind: 'sprite', character: 'beau' } as const;
  const sceneOrigin = { kind: 'background', scene: 'halifax' } as const;

  test('a full-frame still is the stage', () => {
    assert.deepEqual(defaultSizeFor('images', [sceneOrigin]), STAGE);
    assert.deepEqual(defaultSizeFor('video', [{ kind: 'video', scene: 'halifax' }]), STAGE);
  });

  test('a portrait is not', () => {
    // The one picture that is not the whole frame: 460 wide on the stage with
    // 740 above the dialogue box. Generated at the nearest standard bucket.
    assert.deepEqual(defaultSizeFor('images', [spriteOrigin]), PORTRAIT);
    assert.ok(PORTRAIT.height > PORTRAIT.width, 'a portrait is taller than it is wide');
  });

  test('audio has no size, and is not asked for one', () => {
    assert.equal(defaultSizeFor('voice', [{ kind: 'voice', node: 'a', line: 0 }]), undefined);
    assert.equal(defaultSizeFor('music', [{ kind: 'music', scene: 'halifax' }]), undefined);
  });

  test('sizes round-trip through the text a person types', () => {
    assert.deepEqual(parseSize('1920x1080'), { width: 1920, height: 1080 });
    assert.deepEqual(parseSize(' 832 × 1216 '), { width: 832, height: 1216 });
    assert.equal(parseSize('big'), undefined);
    assert.equal(parseSize(undefined), undefined);
    assert.equal(formatSize(STAGE), '1920x1080');
  });
});

describe('a picture that is the wrong shape', () => {
  const scenario = ScenarioSchema.parse({
    id: 'x',
    title: 'X',
    start: 'a',
    characters: {},
    scenes: { halifax: { background: 'images/jetty.png' } },
    nodes: [{ id: 'a', type: 'end', text: 'Done' }],
  });

  function project() {
    return ProjectSchema.parse({
      project: 'demo',
      scenario: 'scenario.yaml',
      publish: 'assets',
      generated: 'generated',
      assets: { 'images/jetty.png': { prompt: 'a jetty', size: '1920x1080' } },
    });
  }

  /** Drops a take of the given size in by hand, the way art actually arrives. */
  async function boardWith(width: number, height: number) {
    const root = mkdtempSync(join(tmpdir(), 'is-size-'));
    const proj = project();
    const paths = pathsOf(join(root, 'project.yaml'), proj);
    const takes = takesDir(paths, 'images', 'images/jetty.png');
    mkdirSync(takes, { recursive: true });
    writeFileSync(join(takes, 'abc-01.png'), png(width, height));

    const ledger = structuredClone(EMPTY_LEDGER);
    ledger.assets['images/jetty.png'] = {
      selected: 'abc-01.png',
      takes: [{ id: 'abc-01.png', hash: 'abc', at: '2026-01-01T00:00:00.000Z', params: {} }],
    };

    const overview = await buildOverview(scenario, proj, ledger, paths);
    rmSync(root, { recursive: true, force: true });
    return overview;
  }

  test('the square every web UI opens on is caught', async () => {
    const overview = await boardWith(1024, 1024);
    const asset = overview.sections
      .find((view) => view.section === 'images')!
      .assets.find((entry) => entry.file === 'images/jetty.png')!;

    assert.equal(asset.size?.declared, '1920x1080');
    assert.equal(asset.size?.actual, '1024x1024');
    assert.equal(asset.size?.mismatched, true);
    // On the board as well as on the row: a still that will be letterboxed in
    // front of a room is not a detail of one row.
    assert.match(
      overview.problems.map((problem) => problem.message).join('\n'),
      /is 1024x1024 but the row asks for 1920x1080/,
    );
  });

  test('a picture of the size it says it is says nothing', async () => {
    const overview = await boardWith(1920, 1080);
    const asset = overview.sections
      .find((view) => view.section === 'images')!
      .assets.find((entry) => entry.file === 'images/jetty.png')!;

    assert.equal(asset.size?.actual, '1920x1080');
    assert.equal(asset.size?.mismatched, undefined);
    assert.deepEqual(overview.problems, []);
  });
});
