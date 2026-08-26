/**
 * How long a clip runs, read from its header.
 *
 * This number decides whether a line survives to the projector. Nothing on the
 * server opens an audio file — a beat ends when `hold` says it does — so a
 * `hold` a second short cuts the narrator off mid-word in front of a room, and
 * the only way to catch it otherwise is to sit through every clip with a
 * stopwatch.
 *
 * The two ways of getting it wrong are both here. Doubling is the dangerous
 * one: MPEG 2 halves the Layer III frame, and reading a 24 kHz clip as though
 * it were 44.1 kHz reports every line as twice its length, which turns a real
 * warning into noise and a real overrun into silence.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { durationOf, readDuration } from '../tools/editor/duration.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One MPEG frame header, the way the voice sidecar writes them.
 *
 * `version` 3 is MPEG 1, 2 is MPEG 2. Layer III throughout, mono, because that
 * is what a spoken line is.
 */
function frameHeader(options: {
  version: number;
  bitrateIndex: number;
  rateIndex: number;
  mono?: boolean;
}): Buffer {
  const { version, bitrateIndex, rateIndex, mono = true } = options;
  return Buffer.from([
    0xff,
    0xe0 | (version << 3) | (1 << 1), // sync, version, layer III
    (bitrateIndex << 4) | (rateIndex << 2),
    (mono ? 3 : 0) << 6,
  ]);
}

/** An MP3 whose length is declared by a Xing frame count, as a real one is. */
function xingMp3(options: {
  version: number;
  bitrateIndex: number;
  rateIndex: number;
  frames: number;
  id3?: number;
}): Buffer {
  const { version, bitrateIndex, rateIndex, frames, id3 = 0 } = options;
  const tag = id3
    ? Buffer.concat([
        Buffer.from('ID3'),
        Buffer.from([3, 0, 0]),
        // A syncsafe size: seven bits per byte.
        Buffer.from([(id3 >> 21) & 0x7f, (id3 >> 14) & 0x7f, (id3 >> 7) & 0x7f, id3 & 0x7f]),
        Buffer.alloc(id3),
      ])
    : Buffer.alloc(0);

  const header = frameHeader({ version, bitrateIndex, rateIndex });
  // Mono side info: 9 bytes on MPEG 2, 17 on MPEG 1.
  const sideInfo = Buffer.alloc(version === 3 ? 17 : 9);
  const xing = Buffer.alloc(12);
  xing.write('Xing', 0, 'latin1');
  xing.writeUInt32BE(0x0f, 4); // every optional field present
  xing.writeUInt32BE(frames, 8);

  return Buffer.concat([tag, header, sideInfo, xing, Buffer.alloc(2048)]);
}

describe('reading an mp3', () => {
  test('a Xing frame count is the length, and MPEG 2 frames are half-size', async () => {
    // 52 frames of 576 samples at 24 kHz — a real clip from the workshop.
    const bytes = xingMp3({ version: 2, bitrateIndex: 8, rateIndex: 1, frames: 52 });
    const seconds = durationOf(bytes, bytes.length)!;
    assert.ok(Math.abs(seconds - 1.248) < 0.001, `got ${seconds}`);
  });

  test('the same count on MPEG 1 is twice as long, because the frame is', async () => {
    // The doubling bug, pinned. 1152 samples at 44.1 kHz.
    const bytes = xingMp3({ version: 3, bitrateIndex: 5, rateIndex: 0, frames: 52 });
    const seconds = durationOf(bytes, bytes.length)!;
    assert.ok(Math.abs(seconds - (52 * 1152) / 44100) < 0.001, `got ${seconds}`);
  });

  test('an ID3 tag is stepped over rather than read as audio', async () => {
    const bytes = xingMp3({ version: 2, bitrateIndex: 8, rateIndex: 1, frames: 52, id3: 4096 });
    const seconds = durationOf(bytes, bytes.length)!;
    assert.ok(Math.abs(seconds - 1.248) < 0.001, `got ${seconds}`);
  });

  test('a constant-bitrate file with no Xing is measured from its size', async () => {
    // 64 kbps, so 8000 bytes of audio is exactly one second.
    const header = frameHeader({ version: 2, bitrateIndex: 8, rateIndex: 1 });
    const bytes = Buffer.concat([header, Buffer.alloc(8000 - 4)]);
    const seconds = durationOf(bytes, bytes.length)!;
    assert.ok(Math.abs(seconds - 1) < 0.01, `got ${seconds}`);
  });

  test('something that is not audio reads as nothing, never as zero', async () => {
    // A zero would be a clip shorter than every hold, which reports the whole
    // show as comfortably timed.
    assert.equal(durationOf(Buffer.from('not audio at all'), 16), undefined);
    assert.equal(durationOf(Buffer.alloc(0), 0), undefined);
  });
});

describe('reading a wav', () => {
  test('the byte rate declares the length', async () => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + 32000, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28); // byte rate: 16 kHz, 16-bit mono
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(32000, 40); // exactly one second
    assert.equal(durationOf(header, header.length), 1);
  });

  test('chunks before fmt do not throw it off', async () => {
    // A file written by a tool that puts LIST first is still an ordinary wav,
    // and walking the chunks rather than assuming their order is the only way
    // to read one.
    const list = Buffer.alloc(8 + 10);
    list.write('LIST', 0, 'latin1');
    list.writeUInt32LE(10, 4);

    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'latin1');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt32LE(32000, 16);

    const data = Buffer.alloc(8);
    data.write('data', 0, 'latin1');
    data.writeUInt32LE(64000, 4);

    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.write('WAVE', 8, 'latin1');

    const file = Buffer.concat([head, list, fmt, data]);
    assert.equal(durationOf(file, file.length), 2);
  });
});

describe('reading a file', () => {
  test('a missing one is nothing, not a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'is-duration-'));
    try {
      assert.equal(await readDuration(join(dir, 'nope.mp3')), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real file on disk reads the same as its bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'is-duration-'));
    try {
      const bytes = xingMp3({ version: 2, bitrateIndex: 8, rateIndex: 1, frames: 169 });
      const file = join(dir, 'clip.mp3');
      writeFileSync(file, bytes);
      const seconds = (await readDuration(file))!;
      assert.ok(Math.abs(seconds - (169 * 576) / 24000) < 0.001, `got ${seconds}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
