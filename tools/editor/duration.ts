/**
 * How long a clip actually runs.
 *
 * The show does not open a single audio file. A beat ends when the line's
 * `hold` says it does, and nothing on the server ever checks that against the
 * clip — so a `hold` that is a second short cuts the narrator off mid-word, in
 * front of a room, and the only way to find out before then is to sit through
 * every one of them with a stopwatch. The estimates every `hold` starts as are
 * reading-speed guesses; a generated clip is a fact, and the two are routinely
 * a second or two apart.
 *
 * Read from the header rather than by decoding, and only the header — a few
 * kilobytes per file, because this runs over ninety of them every time the
 * board is built. No dependency, for the same reason `size.ts` has none: the
 * editor's job is to read a file the show will play, not to own a codec.
 *
 * Undefined means "could not tell", never zero. A clip whose length cannot be
 * read must not produce a timing warning — being sent to re-cut a line that
 * was already right is worse than not being told.
 */

import { open } from 'node:fs/promises';

/** Enough for an ID3v2 tag of any sane size plus the first frame beyond it. */
const HEADER_BYTES = 64 * 1024;

/** Bitrates in kbps, indexed by the four-bit field. Layer III only. */
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

export async function readDuration(file: string): Promise<number | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const [{ size }, { buffer, bytesRead }] = await Promise.all([
      handle.stat(),
      handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0),
    ]);
    return durationOf(buffer.subarray(0, bytesRead), size);
  } finally {
    await handle.close();
  }
}

/**
 * Seconds, from a file's opening bytes and its total size.
 *
 * `total` is what makes a constant-bitrate MP3 readable at all: its length is
 * the number of bytes divided by the rate, and neither is in the first frame
 * alone.
 */
export function durationOf(bytes: Buffer, total: number): number | undefined {
  return wav(bytes) ?? mp3(bytes, total);
}

/** RIFF/WAVE: the byte rate is declared, so the length is arithmetic. */
function wav(bytes: Buffer): number | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF') return undefined;
  if (bytes.toString('latin1', 8, 12) !== 'WAVE') return undefined;

  let byteRate = 0;
  let at = 12;
  // Chunks are walked rather than assumed in order: a file written by a tool
  // that puts `LIST` before `fmt ` is still a perfectly ordinary wav.
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    // Byte rate, at offset 8 within the chunk body — not the sample rate four
    // bytes ahead of it. Reading the wrong one is off by the frame size, so a
    // 16-bit mono clip comes back at exactly twice its length.
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = bytes.readUInt32LE(at + 16);
    if (id === 'data') return byteRate > 0 ? size / byteRate : undefined;
    // Chunks are word-aligned, and an odd size carries a pad byte.
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** Where the audio starts, stepping over an ID3v2 tag if one is in the way. */
function afterTag(bytes: Buffer): number {
  if (bytes.length < 10) return 0;
  if (bytes.toString('latin1', 0, 3) !== 'ID3') return 0;
  // A syncsafe integer: seven bits per byte, so a size can never contain a
  // false frame sync.
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const footer = bytes[5]! & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

type Frame = {
  at: number;
  version: number;
  channels: number;
  sampleRate: number;
  bitrate: number;
  samplesPerFrame: number;
};

/** The first real frame header at or after `from`. */
function frameAt(bytes: Buffer, from: number): Frame | undefined {
  for (let at = from; at + 4 <= bytes.length; at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) continue;

    const version = (bytes[at + 1]! >> 3) & 0x03;
    const layer = (bytes[at + 1]! >> 1) & 0x03;
    const bitrateIndex = (bytes[at + 2]! >> 4) & 0x0f;
    const rateIndex = (bytes[at + 2]! >> 2) & 0x03;
    const channelMode = (bytes[at + 3]! >> 6) & 0x03;

    // `1` is a reserved version and `0` a reserved layer; both mean this is a
    // false sync inside the audio rather than a header.
    if (version === 1 || layer === 0) continue;
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue;
    // Layer III only, which is every MP3 this pipeline makes or is handed.
    if (layer !== 1) continue;

    const sampleRate = SAMPLE_RATES[version]?.[rateIndex];
    if (!sampleRate) continue;
    const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex]! * 1000;
    if (!bitrate) continue;

    return {
      at,
      version,
      channels: channelMode === 3 ? 1 : 2,
      sampleRate,
      bitrate,
      // MPEG 2 and 2.5 halve the Layer III frame, which halves the length a
      // frame count stands for. Getting this wrong doubles every duration.
      samplesPerFrame: version === 3 ? 1152 : 576,
    };
  }
  return undefined;
}

function mp3(bytes: Buffer, total: number): number | undefined {
  const start = afterTag(bytes);
  const frame = frameAt(bytes, start);
  if (!frame) return undefined;

  // A variable-bitrate file says how many frames it has, and that is the only
  // honest answer for one — dividing its size by the first frame's rate can be
  // out by a factor of two.
  const sideInfo = frame.version === 3 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const tagAt = frame.at + 4 + sideInfo;
  if (tagAt + 12 <= bytes.length) {
    const tag = bytes.toString('latin1', tagAt, tagAt + 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = bytes.readUInt32BE(tagAt + 4);
      if (flags & 0x01) {
        const frames = bytes.readUInt32BE(tagAt + 8);
        if (frames > 0) return (frames * frame.samplesPerFrame) / frame.sampleRate;
      }
    }
  }

  // Constant bitrate, which is what the sidecar writes.
  const audioBytes = total - frame.at;
  if (audioBytes <= 0) return undefined;
  return (audioBytes * 8) / frame.bitrate;
}

/** Seconds as the board shows them: one decimal, never a bare integer. */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}
