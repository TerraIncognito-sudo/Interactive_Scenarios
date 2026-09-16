/**
 * Handing the projector the files the show is made of.
 *
 * This route and the editor's `/media` route are now the same fact stated
 * once. They were two: the game server served a scenario's `assets/` folder
 * with Fastify, and the editor served takes and published files with its own
 * range-aware reader. Both answered "where does this name live and what should
 * I call the bytes", and CLAUDE.md records the day they disagreed — the game
 * server's asset base stopped one directory short of `assets/`, which made
 * every asset in every scenario a 404, and nothing noticed for months because
 * no scenario had a single asset made yet. The first one would have been a
 * missing picture in front of a room.
 *
 * Two rules from that survive intact and are the whole of this file.
 *
 * The name is the scenario's, verbatim — `voice/tran-d5-01.mp3` — because the
 * display asks for exactly what `scenario.yaml` declares and the editor may
 * never invent a name the player would not open. And the content type comes
 * out of the extension rather than out of the bytes: a `.wav` served as
 * `audio/mpeg` is a silent beat in front of a room with nothing in any log.
 */

import { extname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { assetsOf } from '../../../shared/scenario/load.ts';
import { ProjectError } from '../project.ts';
import { MEDIA_TYPES } from '../projects.ts';
import { within } from '../workspace.ts';
import { currentShow } from './session.ts';

/**
 * Where the display's asset names are rooted.
 *
 * Down to the publish folder itself, and the display joins a name straight out
 * of the scenario onto it. A base one level short makes every asset a 404, and
 * that is not hypothetical — it is the bug this whole file's comment is about.
 */
export const ASSET_BASE = '/project-assets/';

/** Asset names are the scenario's own, which may nest by media type. */
const ASSET_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * Resolves one asset of the running show.
 *
 * Deliberately rooted at the *running* show rather than at a project named in
 * the URL. Nothing should be able to read a folder off this machine by asking
 * for it, and while a show is on the projector there is exactly one folder the
 * display has any business in.
 */
export async function showAsset(name: string): Promise<{ path: string; type: string }> {
  const show = currentShow();
  if (!show) throw new ProjectError('No show is running');

  // `..` is an ordinary name as far as a character class is concerned, which
  // is the trap `safeAsset` was written for. Same check, same reason.
  if (!ASSET_NAME.test(name) || name.split('/').some((part) => part === '.' || part === '..')) {
    throw new ProjectError('Bad asset name');
  }

  const root = resolve(show.paths.publish);
  const file = resolve(join(root, name));
  if (!within(root, file)) throw new ProjectError('Outside the project');

  const type = MEDIA_TYPES[extname(file).toLowerCase()];
  if (!type) throw new ProjectError('Not a media file the show will serve');

  if (!(await stat(file).catch(() => null))?.isFile()) {
    throw new ProjectError('That file is not there');
  }
  return { path: file, type };
}

export type ShowManifest = {
  scenario: unknown;
  assets: string[];
  /** Bytes per asset, absent for art that has not been made. */
  sizes: Record<string, number>;
  assetBase: string;
};

/**
 * Everything the display needs before it can start: the whole story, the list
 * of files, and what each one weighs.
 *
 * The sizes are what let the projector report megabytes rather than a file
 * count — eighty-six is a number nobody can turn into a guess about how long
 * is left, and "18 of 31 MB" is. Missing where the art does not exist, which
 * the display is already built to cope with, because a scenario declaring its
 * media before the media exists is the normal state of a show being made.
 */
export async function showManifest(): Promise<ShowManifest> {
  const show = currentShow();
  if (!show) throw new ProjectError('No show is running');

  const assets = assetsOf(show.loaded.scenario);
  const root = show.paths.publish;

  // Stat in parallel: a show is a few hundred files, and doing them one after
  // another turns milliseconds into a visible pause before the projector has
  // begun downloading anything at all.
  const sizes: Record<string, number> = {};
  await Promise.all(
    assets.map(async (file) => {
      const info = await stat(join(root, file)).catch(() => null);
      if (info?.isFile()) sizes[file] = info.size;
    }),
  );

  return { scenario: show.loaded.scenario, assets, sizes, assetBase: ASSET_BASE };
}
