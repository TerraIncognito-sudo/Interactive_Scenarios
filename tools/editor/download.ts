/**
 * Fetching a model's files into the models root.
 *
 * Some libraries download their own weights; some do not, and leave you reading
 * a README to find two URLs. The ones that do not are handled here, so that
 * "install a model" is one action in the editor rather than a scavenger hunt
 * ending in a Downloads folder.
 *
 * Files land under the name the model spec gives them, in a folder named after
 * the model — `C:\ML Models\voice\kokoro\kokoro-v1.0.onnx`. A person opening
 * that folder in a year can tell what it is. That is worth more than it sounds:
 * the alternative, a cache keyed by hash, is fine for a library and useless to
 * the human who has to decide whether 300 GB of it can be deleted.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { modelById, type ModelSpec } from './models.ts';

export class DownloadError extends Error {}

export type DownloadProgress = {
  file: string;
  received: number;
  total: number;
};

export type DownloadResult = {
  model: string;
  path: string;
  fetched: string[];
  /** Files that were already there at the right size, and were not re-fetched. */
  kept: string[];
  bytes: number;
};

/**
 * True when the file is already there and plausibly complete.
 *
 * Size against the spec's stated megabytes, with a wide tolerance: the point is
 * to catch an interrupted download, not to verify the file. A checksum would be
 * better and is what a spec should carry, but a stated size already separates
 * "300 MB of model" from "4 KB of GitHub error page".
 */
async function looksComplete(path: string, mb: number): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  return info.size > mb * 1024 * 1024 * 0.9;
}

async function fetchOne(
  url: string,
  target: string,
  onProgress?: (received: number, total: number) => void,
): Promise<number> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new DownloadError(`${url} returned ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;

  // Written to a temporary name and renamed at the end, so an interrupted
  // download cannot leave a half file that looks like a whole one.
  const temp = `${target}.part`;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });

  try {
    await pipeline(body, createWriteStream(temp));
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }

  await rename(temp, target);
  return received;
}

/**
 * Downloads everything a model spec names, skipping what is already there.
 *
 * Sequentially, because two large downloads at once finish at the same time as
 * two in a row and make the progress meaningless.
 */
export async function downloadModel(
  id: string,
  root: string | undefined,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<DownloadResult> {
  if (!root) {
    throw new DownloadError('No models folder chosen yet — set one before downloading.');
  }

  const spec: ModelSpec | undefined = modelById(id);
  if (!spec) throw new DownloadError(`Unknown model "${id}"`);
  if (!spec.files?.length) {
    throw new DownloadError(
      `${spec.title} fetches its own weights on first use — there is nothing to download here.`,
    );
  }

  const dir = join(root, spec.folder ?? join('misc', spec.id));
  await mkdir(dir, { recursive: true });

  const fetched: string[] = [];
  const kept: string[] = [];
  let bytes = 0;

  for (const file of spec.files) {
    const target = join(dir, file.name);
    if (await looksComplete(target, file.mb)) {
      kept.push(file.name);
      continue;
    }
    bytes += await fetchOne(file.url, target, (received, total) =>
      onProgress?.({ file: file.name, received, total: total || file.mb * 1024 * 1024 }),
    );
    fetched.push(file.name);
  }

  return { model: spec.id, path: dir, fetched, kept, bytes };
}
