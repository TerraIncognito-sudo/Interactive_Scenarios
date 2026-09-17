/**
 * What a file actually is, from its opening bytes.
 *
 * A name is a promise about content, and in this pipeline it is a promise the
 * show relies on: the display asks for `images/engagement_drone.jpg`, the
 * server picks a content type out of that extension, and the browser is handed
 * PNG bytes labelled `image/jpeg`. Images survive it because browsers sniff;
 * audio is where it stops being cosmetic, since a `.wav` served as `audio/mpeg`
 * is a beat of silence in front of a room with nothing in any log about it.
 *
 * How it happens is ordinary. Art is made in another program, which saves a
 * PNG; the scenario was written months earlier and said `.jpg`. Nothing between
 * those two facts ever compares them.
 *
 * Header bytes only, no dependency — the same discipline `size.ts` and
 * `duration.ts` keep, and for the same reason. Video *is* handled here, unlike
 * in `size.ts`: a clip's dimensions live several atoms deep and are easy to get
 * wrong, but its container is the first four bytes and is not.
 *
 * Undefined means "could not tell", and must never produce a complaint. Sending
 * somebody to rename a file that was already right is worse than saying nothing.
 */

import { open } from 'node:fs/promises';

/**
 * One format, and every extension that legitimately names it.
 *
 * `names` is what stops this being a nuisance. `.jpg` and `.jpeg` are one
 * format; so are `.mp4`, `.m4a` and `.mov`, which share a container that its
 * own header cannot always tell apart. Complaining inside a family would be
 * complaining about a file that is correctly named.
 */
export type Format = {
  /** What the bytes are, said the way a person would say it. */
  kind: string;
  /** The extension to use when a name has to be corrected. */
  extension: string;
  /** Every extension that is a true name for this format. */
  names: string[];
};

const PNG: Format = { kind: 'PNG', extension: 'png', names: ['png'] };
const JPEG: Format = { kind: 'JPEG', extension: 'jpg', names: ['jpg', 'jpeg'] };
const GIF: Format = { kind: 'GIF', extension: 'gif', names: ['gif'] };
const WEBP: Format = { kind: 'WebP', extension: 'webp', names: ['webp'] };
const MP3: Format = { kind: 'MP3', extension: 'mp3', names: ['mp3'] };
const WAV: Format = { kind: 'WAV', extension: 'wav', names: ['wav', 'wave'] };
const FLAC: Format = { kind: 'FLAC', extension: 'flac', names: ['flac'] };
// One container holding Vorbis, Opus or FLAC, and the three are conventionally
// given three different extensions. Telling them apart means reading the codec
// header inside the first page, which is more than is needed to answer "is this
// the kind of file its name says".
const OGG: Format = { kind: 'Ogg', extension: 'ogg', names: ['ogg', 'oga', 'ogv', 'opus'] };
// ISO base media: MP4, M4A, MOV. The brand in the header distinguishes some of
// them and lies about others — plenty of audio-only files are stamped `isom` —
// so they are one family and a name from anywhere in it is accepted.
const ISOBMFF: Format = { kind: 'MP4', extension: 'mp4', names: ['mp4', 'm4a', 'm4v', 'mov'] };
const MATROSKA: Format = { kind: 'Matroska', extension: 'webm', names: ['webm', 'mkv'] };

/** The extension of a filename, lowercased and without its dot. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (at <= slash + 1) return '';
  return name.slice(at + 1).toLowerCase();
}

/** The same name with its extension replaced. */
export function renamedTo(name: string, format: Format): string {
  const at = name.lastIndexOf('.');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const stem = at > slash + 1 ? name.slice(0, at) : name;
  return `${stem}.${format.extension}`;
}

/** True when the bytes are certainly not the kind of file the name claims. */
export function misnamed(name: string, format: Format | undefined): boolean {
  if (!format) return false;
  const declared = extensionOf(name);
  // A name with no extension at all is not a wrong claim, it is no claim.
  if (declared === '') return false;
  return !format.names.includes(declared);
}

export function formatOf(bytes: Buffer): Format | undefined {
  if (bytes.length < 12) return undefined;

  const ascii = (at: number, length: number) => bytes.subarray(at, at + length).toString('latin1');

  if (bytes.readUInt32BE(0) === 0x89504e47) return PNG;
  if (bytes.readUInt16BE(0) === 0xffd8) return JPEG;
  if (ascii(0, 3) === 'GIF') return GIF;
  if (ascii(0, 4) === 'OggS') return OGG;
  if (ascii(0, 4) === 'fLaC') return FLAC;
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return MATROSKA;

  // RIFF carries both WAV and WebP, and the form is four bytes further in.
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 4);
    if (form === 'WAVE') return WAV;
    if (form === 'WEBP') return WEBP;
    return undefined;
  }

  // An ISO base media file opens with a box whose type is `ftyp`. The size in
  // front of it is not checked: a truncated or unusual first box is still a
  // clear enough signature, and being wrong here only costs a missed rename.
  if (ascii(4, 4) === 'ftyp') return ISOBMFF;

  return mpegAudio(bytes);
}

/**
 * MPEG audio, which has no signature — only a frame sync.
 *
 * Checked last and strictly, because eleven set bits turn up in arbitrary
 * binary often enough to matter: the version, layer and bitrate fields all have
 * reserved values, and a real frame has none of them. An ID3 tag in front is
 * the ordinary case and is a signature in its own right.
 */
function mpegAudio(bytes: Buffer): Format | undefined {
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3') return MP3;

  for (let at = 0; at + 1 < Math.min(bytes.length, 4096); at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) continue;
    const header = bytes[at + 1]!;
    const rest = bytes[at + 2] ?? 0;
    if (((header >> 3) & 0b11) === 1) continue; // reserved version
    if (((header >> 1) & 0b11) === 0) continue; // reserved layer
    if ((rest >> 4) === 0b1111 || (rest >> 4) === 0) continue; // bad or free bitrate
    if (((rest >> 2) & 0b11) === 0b11) continue; // reserved sample rate
    return MP3;
  }
  return undefined;
}

/** Reads just enough of a file to name its format. */
export async function readFormat(file: string): Promise<Format | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
    return formatOf(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
