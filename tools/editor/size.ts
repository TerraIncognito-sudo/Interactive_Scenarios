/**
 * How big a picture is supposed to be, and how big it actually is.
 *
 * Until an image generator is wired up, art is made somewhere else and dropped
 * into the takes folder by hand. That workflow has one failure mode and it is
 * silent: a still generated at whatever the tool defaulted to — 1024×1024,
 * because that is what every web UI opens on — lands in a 16:9 show and is
 * either letterboxed with grey bars or cropped through the subject. Nothing
 * says so. The board reports it ready, and it is discovered on a projector.
 *
 * So every picture declares a size, the declaration is part of its recipe, and
 * the file on disk is measured against it.
 *
 * The numbers come from the display's own geometry rather than from taste. The
 * stage is a fixed 1920×1080 surface scaled to fit whatever it is projected on,
 * and a portrait is 460 of those pixels wide with 740 above the dialogue box.
 * Anything else is a guess about a layout that is written down.
 */

import { open } from 'node:fs/promises';
import type { AssetOrigin, AssetSection } from '../../src/scenario/load.ts';

export type Size = { width: number; height: number };

/** `1920x1080`, which is what a person types and what every UI accepts. */
export function parseSize(value: string | undefined): Size | undefined {
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(value?.trim() ?? '');
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function formatSize(size: Size): string {
  return `${size.width}x${size.height}`;
}

/** The display's stage, which every full-frame still and clip fills exactly. */
export const STAGE: Size = { width: 1920, height: 1080 };

/**
 * A character portrait.
 *
 * 460 wide on the stage with 740 of height above the dialogue box — an aspect
 * of 0.62. Generated at 832×1216 rather than at those numbers: it is the
 * nearest standard portrait bucket, both sides divide by 64 for the models that
 * insist on it, and rendering down from twice the size is what keeps an edge
 * clean on a projector.
 */
export const PORTRAIT: Size = { width: 832, height: 1216 };

/**
 * What a picture should be, given where the scenario uses it.
 *
 * Written onto the row rather than applied invisibly at generate time, so the
 * choice is in the file the author reads and can be argued with. A shot that
 * wants a square is a shot that says so.
 */
export function defaultSizeFor(section: AssetSection, origins: AssetOrigin[]): Size | undefined {
  if (section !== 'images' && section !== 'video') return undefined;
  // A sprite is the only picture that is not the whole frame. If a file is used
  // as both a portrait and a background the scenario has bigger problems, and
  // the board already reports that as two sections claiming one name.
  if (origins.some((origin) => origin.kind === 'sprite')) return PORTRAIT;
  return STAGE;
}

/**
 * The real dimensions of an image file, read from its header.
 *
 * Header only — the first few dozen bytes — because this runs for every row on
 * a board that may hold a hundred of them, and decoding a hundred PNGs to learn
 * two numbers each would make opening a project slow enough to notice.
 *
 * Video is deliberately not handled. Its dimensions live in a track header
 * several nested atoms deep, and getting that wrong would report a correct clip
 * as the wrong shape — which is worse than reporting nothing, because the
 * author would go and re-render it.
 */
export async function readImageSize(file: string): Promise<Size | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(32_768), 0, 32_768, 0);
    return sizeOf(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function sizeOf(bytes: Buffer): Size | undefined {
  return png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes);
}

function png(bytes: Buffer): Size | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gif(bytes: Buffer): Size | undefined {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString('latin1') !== 'GIF') return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function webp(bytes: Buffer): Size | undefined {
  if (bytes.length < 30) return undefined;
  if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF') return undefined;
  if (bytes.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined;

  const kind = bytes.subarray(12, 16).toString('latin1');
  // Three container variants, and a file is only ever one of them.
  if (kind === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    return {
      width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  return undefined;
}

/**
 * JPEG, which has to be walked.
 *
 * The dimensions live in a start-of-frame marker that sits after however many
 * comment, colour-profile and thumbnail segments the encoder felt like writing
 * — an Adobe export puts several kilobytes of them first. So the segment chain
 * is followed rather than the header being read at a fixed offset.
 */
function jpeg(bytes: Buffer): Size | undefined {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return undefined;

  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    // SOF0..SOF15, minus the four that are not frame headers at all.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}
