/**
 * Making one asset, and putting it where the show will look for it.
 *
 * Two actions, kept apart on purpose.
 *
 * **Generate** adds a take. It never replaces one, never overwrites the
 * published file, and never changes what is selected if something already is.
 * Re-rolling a line has to be free, or nobody does it, and then the first
 * acceptable reading of every line is the one that ends up in the show.
 *
 * **Publish** copies the selected take to the canonical filename the scenario
 * declares. That is the only moment a generated file becomes the thing the
 * player will open, and it is a separate decision from having made it — which
 * is what lets a whole act be generated in a session and auditioned before any
 * of it is committed to.
 *
 * The recipe hash is what joins them to the board. A take records the hash of
 * the recipe that produced it, so editing the text, the character's voice or
 * the section's model makes every affected take visibly stale rather than
 * silently wrong.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lineDuration, type Scenario } from '../../src/scenario/schema.ts';
import type { AssetSection } from '../../src/scenario/load.ts';
import {
  fromProject,
  recipeHash,
  resolveRecipe,
  takesDir,
  type Ledger,
  type Project,
  type ProjectPaths,
  type Recipe,
} from './project.ts';
import { modelById, modelStatus } from './models.ts';
import { speak, SidecarError, type SidecarOptions } from './sidecar.ts';

export class GenerateError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'GenerateError';
    this.detail = detail;
  }
}

/** Backends this file knows how to drive. `manual` means "no generator wired up". */
const SIDECAR_BACKENDS = new Set(['sidecar']);

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? '' : file.slice(dot + 1).toLowerCase();
}

/**
 * A take's filename carries the recipe that made it.
 *
 * Not a timestamp, because the question asked of a folder of takes months
 * later is never "which was first" — it is "which of these were made from what
 * the file says now". The board answers that by comparing this hash, and a
 * human can answer it by reading the folder.
 */
async function nextTakeId(dir: string, hash: string, extension: string): Promise<string> {
  const existing = await readdir(dir).catch(() => [] as string[]);
  const prefix = `${hash}-`;
  let highest = 0;
  for (const name of existing) {
    if (!name.startsWith(prefix)) continue;
    const n = Number.parseInt(name.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${prefix}${String(highest + 1).padStart(2, '0')}.${extension}`;
}

/**
 * What the sidecar needs, and what to say when the project cannot supply it.
 *
 * Every failure here is something an author can fix, so each one says what to
 * do rather than what went wrong. A generator that answers "invalid request"
 * to a missing reference clip is a generator people stop using.
 */
function checkVoice(recipe: Recipe, file: string, clones: boolean): void {
  if (!recipe.text?.trim()) {
    throw new GenerateError(
      `${file} has no text to say. Seed it from the storyboard, or type the line ` +
        `into the row.`,
    );
  }
  if (!recipe.voice) {
    throw new GenerateError(
      `${file} does not say which character speaks it, so there is no voice to use. ` +
        `Re-seed from the storyboard to attach it.`,
    );
  }
  if (clones && !recipe.reference) {
    throw new GenerateError(
      `No reference clip for "${recipe.voice}". This model clones a voice from a few ` +
        `seconds of speech — set one in the Voices panel, or every character will ` +
        `sound the same.`,
    );
  }
}

export type GeneratedTake = {
  file: string;
  take: string;
  hash: string;
  seconds: number;
  ms: number;
  /** What the scenario's `hold:` should be for this clip. */
  hold: number;
  /** The line's current hold, when it disagrees with the clip that was just made. */
  holdWas?: number;
  seed: number;
  selected: boolean;
};

/**
 * Generates one asset and records the take.
 *
 * Takes the loaded project rather than a name so the caller keeps ownership of
 * reading and writing the ledger — generating fifty lines must not mean fifty
 * round trips through the project file.
 */
export async function generateAsset(options: {
  scenario: Scenario;
  project: Project;
  paths: ProjectPaths;
  ledger: Ledger;
  section: AssetSection;
  file: string;
  modelsRoot?: string;
}): Promise<GeneratedTake> {
  const { scenario, project, paths, ledger, section, file } = options;

  if (section !== 'voice') {
    throw new GenerateError(
      `Only voice is wired up to a generator so far. ${section} is still made by hand.`,
    );
  }

  const model = project.sections[section];
  if (!model || !SIDECAR_BACKENDS.has(model.backend)) {
    throw new GenerateError(
      `The voice section has no generator. Set its backend to "sidecar" and pick a ` +
        `model — see docs/voice-generation.md.`,
    );
  }

  const spec = model.file ? modelById(model.file) : undefined;
  if (!spec || spec.section !== 'voice') {
    throw new GenerateError(
      `"${model.file ?? '(none)'}" is not a voice model this editor knows how to drive.`,
    );
  }

  const status = await modelStatus(options.modelsRoot, spec);
  const recipe = resolveRecipe(project, section, file);
  checkVoice(recipe, file, spec.clones === true);

  const hash = recipeHash(recipe);
  const dir = takesDir(paths, section, file);
  await mkdir(dir, { recursive: true });

  const extension = extensionOf(file) || 'mp3';
  const take = await nextTakeId(dir, hash, extension);

  // Recorded with the take so a reading can be reproduced exactly. Without it,
  // regenerating after a text edit changes the performance as well as the
  // words and there is no way to hear which is which.
  const seed = Math.floor(Math.random() * 2 ** 31);

  const sidecar: SidecarOptions = {
    backend: spec.id,
    // Only a plain snapshot folder. Weights found in the Hugging Face cache are
    // installed, but their layout is not something a loader can be pointed at —
    // the library resolves those itself from HF_HOME, which the sidecar sets.
    modelPath: status.local ? status.path : undefined,
    modelsRoot: options.modelsRoot,
  };

  const result = await speakOrExplain(sidecar, {
    text: recipe.text!,
    out: join(dir, take),
    reference: recipe.reference ? fromProject(paths.dir, recipe.reference) : undefined,
    seed,
    // The engine's own estimate, so a placeholder clip lasts exactly as long as
    // the beat was budgeted for and a rehearsal runs to the real running time.
    seconds: lineDuration({ text: recipe.text! }, scenario.settings),
    params: recipe.params,
  });

  const entry = (ledger.assets[file] ??= { takes: [] });
  entry.takes.push({
    id: take,
    hash,
    seed,
    at: new Date().toISOString(),
    ms: result.ms,
    params: recipe.params,
  });

  // Selected only when nothing is. A generate that stole the selection would
  // undo a choice somebody made by listening, which is the expensive half.
  const selected = entry.selected === undefined;
  if (selected) entry.selected = take;

  const held = currentHold(scenario, project, file);
  return {
    file,
    take,
    hash,
    seconds: result.seconds,
    ms: result.ms,
    hold: result.hold,
    ...(held !== undefined && held !== result.hold ? { holdWas: held } : {}),
    seed,
    selected,
  };
}

/**
 * The `hold:` the scenario currently gives this clip's line.
 *
 * Reported back when it disagrees with the clip that was just made, because
 * nothing on the server opens the audio file — the beat ends when `hold` says
 * it does, and a clip longer than its hold is a narrator cut off mid-sentence
 * in front of a room.
 */
function currentHold(scenario: Scenario, project: Project, file: string): number | undefined {
  const source = project.assets[file]?.source;
  if (!source?.node || source.line === undefined) return undefined;
  const node = scenario.nodes.find((candidate) => candidate.id === source.node);
  if (node?.type !== 'dialogue') return undefined;
  return node.lines[source.line]?.hold;
}

/**
 * Runs the generator, and keeps the traceback attached to the failure.
 *
 * A model that will not load says why in Python, on stderr, and that sentence
 * is almost always the whole answer — a missing CUDA wheel, a file it cannot
 * open. Reporting "generation failed" and throwing the explanation away turns
 * a two-minute fix into an evening.
 */
async function speakOrExplain(
  options: SidecarOptions,
  request: Parameters<typeof speak>[1],
): ReturnType<typeof speak> {
  try {
    return await speak(options, request);
  } catch (err) {
    if (err instanceof SidecarError) {
      throw new GenerateError(err.message, err.detail);
    }
    throw err;
  }
}

export type Published = { file: string; from: string };

/**
 * Copies the selected take to the name the scenario declares.
 *
 * A copy rather than a move or a link: the takes folder is the record of what
 * was tried, and publishing must not empty it. It is also the only place a
 * generated file takes on the filename the player will ask for, which is why
 * it is a decision and not a side effect of generating.
 */
export async function publishAsset(options: {
  paths: ProjectPaths;
  ledger: Ledger;
  section: AssetSection;
  file: string;
}): Promise<Published> {
  const { paths, ledger, section, file } = options;
  const entry = ledger.assets[file];
  if (!entry?.selected) {
    throw new GenerateError(`Nothing is selected for ${file}, so there is nothing to publish.`);
  }

  const from = join(takesDir(paths, section, file), entry.selected);
  await mkdir(paths.publish, { recursive: true });
  await copyFile(from, join(paths.publish, file)).catch((error: unknown) => {
    throw new GenerateError(
      `Could not publish ${file}: ${(error as Error).message}`,
    );
  });

  return { file, from: entry.selected };
}
