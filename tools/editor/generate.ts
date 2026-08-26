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
import { dirname, join } from 'node:path';
import { lineDuration, type Scenario } from '../../src/scenario/schema.ts';
import type { AssetSection } from '../../src/scenario/load.ts';
import {
  fromProject,
  NARRATION_VOICE,
  recipeHash,
  resolveRecipe,
  takesDir,
  type Ledger,
  type Project,
  type ProjectPaths,
  type Recipe,
} from './project.ts';
import { modelById, modelStatus } from './models.ts';
import { portraitFilesOf } from './sprites.ts';
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
function checkVoice(recipe: Recipe, file: string, spec: { clones?: boolean; title: string }): void {
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
  if (spec.clones && !recipe.reference) {
    throw new GenerateError(
      `No reference clip for "${recipe.voice}". ${spec.title} clones a voice from a few ` +
        `seconds of speech — choose a clip in the Voices panel, or have one made there ` +
        `from a Kokoro voice. Without it every character reads in the same default voice.`,
    );
  }
  if (!spec.clones && !recipe.preset) {
    throw new GenerateError(
      `No voice chosen for "${recipe.voice}". ${spec.title} has a palette of them — ` +
        `pick one in the Voices panel.`,
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
  // The same derivation the board uses. Two answers here would mean the hash
  // the board shows and the hash a take is filed under disagree, and every
  // asset would read as stale the moment it was made.
  const recipe = resolveRecipe(project, section, file, {
    portrait: portraitFilesOf(scenario).has(file),
  });
  checkVoice(recipe, file, spec);

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
    preset: recipe.preset,
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

/** Enough speech to clone from: long enough to characterise, short enough to stay clean. */
const REFERENCE_WORDS = { min: 25, max: 55 };

/**
 * The character's own words, for a reference clip.
 *
 * Their real lines rather than a pangram, because a reference is copied in
 * register as well as in timbre — a voice sampled reading "the quick brown
 * fox" carries none of the flatness a duty officer reads with. Taken in
 * scenario order and stopped at the first sentence boundary past the minimum,
 * so the clip ends on a full stop instead of mid-clause.
 */
export function referenceTextFor(scenario: Scenario, who: string): string | undefined {
  const said: string[] = [];
  let words = 0;

  for (const node of scenario.nodes) {
    if (node.type !== 'dialogue') continue;
    for (const line of node.lines) {
      // The narration voice speaks the lines nobody is credited with, so its
      // own lines are the ones with no `who:` at all. Matching it by name would
      // find nothing and refuse to record a clip for a voice that has work.
      const speaker = line.who ?? NARRATION_VOICE;
      if (speaker !== who) continue;
      const text = line.text.trim();
      if (!text) continue;
      said.push(text);
      words += text.split(/\s+/).length;
      if (words >= REFERENCE_WORDS.min) return said.join(' ');
    }
  }

  // Everything they say, when they do not say much. Below the minimum a clone
  // is poor, but a poor clone the author can hear beats a refusal they cannot.
  return said.length > 0 ? said.join(' ') : undefined;
}

export type ReferenceClip = {
  voice: string;
  preset: string;
  /** Project-relative, which is how it is written into project.yaml. */
  file: string;
  seconds: number;
  text: string;
};

/**
 * Makes a reference clip for a character, in one of a palette model's voices.
 *
 * This exists because the cloning model's first question — "which recording?"
 * — is one most authors cannot answer. They have a scenario, not a sound
 * booth. A palette model has thirty usable voices and no such question, so it
 * can be used to answer chatterbox's: pick a voice, hear the character's own
 * lines in it, and keep the result as the reference.
 *
 * The preset is recorded next to the reference so the clip can be made again.
 * A wav file in a folder with no note of where it came from is a dead end the
 * first time anyone wants to adjust it.
 */
export async function makeReferenceClip(options: {
  scenario: Scenario;
  paths: ProjectPaths;
  who: string;
  preset: string;
  model: string;
  modelsRoot?: string;
}): Promise<ReferenceClip> {
  const { scenario, paths, who, preset } = options;

  const spec = modelById(options.model);
  if (!spec || spec.section !== 'voice' || spec.clones) {
    throw new GenerateError(
      `"${options.model}" cannot make a reference clip — that needs a model with ` +
        `voices of its own, like Kokoro.`,
    );
  }

  const status = await modelStatus(options.modelsRoot, spec);
  if (!status.installed) {
    throw new GenerateError(
      `${spec.title} is not downloaded yet. Press Download beside it in the model ` +
        `picker, or run \`npm run voice:fetch -- ${spec.id}\`.`,
    );
  }

  const text = referenceTextFor(scenario, who);
  if (!text) {
    throw new GenerateError(
      `"${who}" has no lines in the scenario, so there is nothing to record them saying.`,
    );
  }

  // Beside the scenario, so the clip travels with the show that uses it.
  const relative = `voices/${who}.wav`;
  const target = join(paths.dir, 'voices', `${who}.wav`);
  await mkdir(dirname(target), { recursive: true });

  // WAV, not MP3. This is fed back into a model rather than played to an
  // audience, and there is no reason to make it listen to compression
  // artefacts on the one recording that decides what a character sounds like.
  const result = await speakOrExplain(
    {
      backend: spec.id,
      modelPath: status.local ? status.path : undefined,
      modelsRoot: options.modelsRoot,
    },
    { text: trimToWords(text, REFERENCE_WORDS.max), out: target, preset },
  );

  return { voice: who, preset, file: relative, seconds: result.seconds, text };
}

/** Keeps a reference clip from running long, on a sentence boundary if it can. */
function trimToWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  if (words.length <= max) return text;
  const cut = words.slice(0, max).join(' ');
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > cut.length / 2 ? cut.slice(0, stop + 1) : `${cut}.`;
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
  const to = join(paths.publish, file);
  // The scenario's name may carry a folder — `voice/tran-d5-01.mp3` — and that
  // folder is part of where the show will look for the file, so it is made
  // here rather than expected to exist.
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to).catch((error: unknown) => {
    throw new GenerateError(
      `Could not publish ${file}: ${(error as Error).message}`,
    );
  });

  return { file, from: entry.selected };
}
