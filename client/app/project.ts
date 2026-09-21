/**
 * The project file: what the editor opens, and where everything else lives.
 *
 * A project is deliberately *not* a scenario folder. Model weights are tens of
 * gigabytes, candidate takes are hundreds of files, and neither belongs in the
 * repo or inside a synced OneDrive path. So a project is a folder anywhere on
 * disk that points at the scenario it drives, and the editor follows those
 * pointers outward.
 *
 * Two files, two owners:
 *
 *   project.yaml   the human's. Prompts, model choice, per-asset tuning.
 *   .ledger.json   the machine's. Every take generated, and which one is picked.
 *
 * They are split because the ledger is appended to on every single generation
 * and the project file is edited by hand for weeks. Round-tripping YAML through
 * a program strips comments and reflows formatting, so the program is never
 * allowed to write the file the author owns.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ASSET_SECTIONS, type AssetSection } from '../../shared/scenario/load.ts';

/**
 * Generation parameters vary by model — steps and cfg for a sampler, seconds
 * and loop for an audio bed — so this stays a bag rather than a fixed shape.
 * Scalars only: anything nested is a sign the recipe wants a real field.
 */
export const ParamsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export type Params = z.infer<typeof ParamsSchema>;

export const SectionModelSchema = z.strictObject({
  /**
   * `manual` means the files in this section are made somewhere else and
   * brought in. That is now every section but voice, and permanently so.
   */
  backend: z.enum(['sidecar', 'manual']).default('manual'),
  /** Folder of weights on this machine. Scanned to populate the model picker. */
  root: z.string().min(1).optional(),
  /** Which file in `root` to use. */
  file: z.string().min(1).optional(),
  /**
   * The standing instruction in front of every brief in this section.
   *
   * Never composed into anything and deliberately absent from `Recipe`, so
   * editing it marks nothing stale — see `direction.ts` for why that is the
   * right answer rather than the cheap one. Not to be confused with a voice's
   * `direction`, which is a delivery note and *is* in the hash.
   */
  direction: z.string().optional(),
  defaults: ParamsSchema.prefault({}),
});

export type SectionModel = z.infer<typeof SectionModelSchema>;

/** Built from ASSET_SECTIONS so a new section cannot be added in only one place. */
const sectionShape = Object.fromEntries(
  ASSET_SECTIONS.map((section) => [section, SectionModelSchema.optional()]),
) as Record<AssetSection, z.ZodOptional<typeof SectionModelSchema>>;

export const SectionsSchema = z.strictObject(sectionShape);

/**
 * A character's voice: how every line they speak is produced.
 *
 * Kept here rather than on each line because a cast member is one voice across
 * ninety lines. It is the same argument as a section's `style` — one edit has
 * to change all of them, and all of them have to go stale when it does.
 *
 * The character ids are the scenario's own. Nothing here invents a cast: a
 * voice with no matching character is reported, because it is either a typo or
 * a leftover from a line that was cut.
 */
export const VoiceSchema = z.strictObject({
  /**
   * A few seconds of clean speech for a model that clones. Relative to the
   * project, so the recording travels with the show that uses it.
   */
  reference: z.string().min(1).optional(),
  /**
   * One of the model's own voices, for a model that has a palette instead.
   *
   * Both fields can be set at once, and that is useful rather than confusing:
   * the preset is what made the reference clip, so it records where a cloned
   * voice came from and lets it be made again.
   */
  preset: z.string().min(1).optional(),
  /** Direction, for a model that takes it. "Tired, precise, never raises her voice." */
  direction: z.string().optional(),
  /** Per-voice generation settings, layered over the section's defaults. */
  params: ParamsSchema.prefault({}),
  notes: z.string().optional(),
});

export type Voice = z.infer<typeof VoiceSchema>;

/**
 * The voice of a line with no `who:`.
 *
 * Some lines are narration with no nameplate — a fiction notice, a title card,
 * a line the display shows without attributing to anyone. They still have to be
 * spoken, and they still need a voice, but attributing them to a character to
 * get one would put that character's name on screen under a legal disclaimer.
 *
 * So they are cast like anybody else, under an id that is deliberately not a
 * character. It appears in the cast panel with however many lines it has, and
 * it can be a different voice from the narrator or the same one — that is the
 * author's call, and having somewhere to make it is the point.
 */
export const NARRATION_VOICE = 'vo';

/** Where this asset came from in the storyboard, for click-through both ways. */
export const SourceRefSchema = z.strictObject({
  shot: z.string().min(1).optional(),
  node: z.string().min(1).optional(),
  line: z.number().int().min(0).optional(),
});

export const AssetRowSchema = z.strictObject({
  prompt: z.string().optional(),
  /**
   * `1920x1080`. What this picture is supposed to be, for a still or a clip.
   *
   * Written on the row rather than defaulted invisibly, because art is made in
   * another program and dropped in here — and a still generated at whatever
   * that program opened on lands in a 16:9 show either letterboxed or cropped
   * through the subject, with nothing anywhere saying so. Declared, it is
   * checked against the file.
   */
  size: z
    .string()
    .regex(/^\d{2,5}[x×]\d{2,5}$/, 'a size looks like 1920x1080')
    .optional(),
  params: ParamsSchema.prefault({}),
  /** Voice only: the spoken text, and which configured voice says it. */
  text: z.string().optional(),
  voice: z.string().min(1).optional(),
  /**
   * Voice only: seconds of room after this clip before the beat ends.
   *
   * The beat written into `scenario.yaml` is the clip plus this. A second is
   * the default and is right for most lines; where it is not, it is wrong per
   * line rather than per show — a beat before a poll wants to breathe, and a
   * three-word interruption wants to land on top of what follows.
   *
   * Deliberately absent from `resolveRecipe`, and a test says so. It changes
   * how long a beat lasts and nothing whatever about the audio, so folding it
   * into the hash would mark ninety finished clips stale for a timing edit and
   * make re-timing a show cost a re-record of it.
   */
  gap: z.number().min(0).max(60).optional(),
  notes: z.string().optional(),
  /**
   * Character sheets and ship plates. Everything downstream was matched to
   * them, so they must never quietly re-roll when a shared prompt is edited.
   */
  freeze: z.boolean().default(false),
  source: SourceRefSchema.optional(),
});

export type AssetRow = z.infer<typeof AssetRowSchema>;

/**
 * Note what is *not* here: an asset's section. That is always derived from the
 * schema field that referenced the file, so it cannot drift from the scenario.
 * Recording it here would be a second copy of a fact the scenario already owns.
 */
export const ProjectSchema = z.strictObject({
  project: z.string().min(1),
  title: z.string().min(1).optional(),
  /**
   * The code this project's shows open on the relay under.
   *
   * Here rather than in `scenario.yaml` because it is not content: the story
   * is the same story whatever the room is called, and a scenario that
   * travelled with a room name in it would be a scenario that fought over the
   * name with whoever it was sent to. Here rather than in the machine config
   * because it belongs to *this show* — ARCTIC-SENTINEL is this project's
   * name, and a machine that runs four shows would otherwise open all four
   * under one.
   *
   * What it buys is two things. A code somebody can read out, instead of six
   * characters they have to spell — and a way back in: a named room is
   * re-entered by the key that opened it, so a client that crashed mid-vote
   * goes live again and finds its own room, its own question and its own
   * ballots. A minted code cannot do that, because nothing can ask for it
   * again.
   */
  room: z.string().min(1).optional(),
  /** All paths resolve relative to the project file, and may be absolute. */
  storyboard: z.string().min(1).optional(),
  scenario: z.string().min(1),
  publish: z.string().min(1),
  generated: z.string().min(1).default('generated'),
  sections: SectionsSchema.prefault({}),
  /** Keyed by character id, as `scenario.yaml` spells it. */
  voices: z.record(z.string().min(1), VoiceSchema).prefault({}),
  assets: z.record(z.string().min(1), AssetRowSchema).prefault({}),
});

export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export const TakeSchema = z.strictObject({
  /** Filename within `generated/<section>/<asset>/`. */
  id: z.string().min(1),
  /** Recipe hash at the moment this take was made. Drives staleness. */
  hash: z.string().min(1),
  /**
   * Where a take no generator made came from — a dialog filename, or the
   * published file it was adopted out of.
   *
   * Present exactly when nothing generated it, which is the honest way to
   * record art made in another program: the hash still says which recipe it
   * answers, so editing the prompt marks it stale like anything else, and this
   * says not to expect a seed to reproduce it.
   */
  from: z.string().min(1).optional(),
  seed: z.number().optional(),
  at: z.string().min(1),
  ms: z.number().optional(),
  params: ParamsSchema.prefault({}),
});

export type Take = z.infer<typeof TakeSchema>;

export const LedgerEntrySchema = z.strictObject({
  selected: z.string().min(1).optional(),
  /**
   * The take that was last copied to the published name.
   *
   * Without it nothing can tell a shipped line from a line that was merely
   * chosen: `ready` says the selected take matches the recipe and says nothing
   * about whether anyone ever published it. That gap is why the board could
   * read finished while the show still played the previous reading.
   */
  published: z.string().min(1).optional(),
  takes: z.array(TakeSchema).prefault([]),
});

export const LedgerSchema = z.strictObject({
  /**
   * 1 wrote hashes over the old recipe shape; 2 is after `migrate-recipes` has
   * re-stamped them.
   *
   * A record rather than a gate: what decides whether a project still needs
   * migrating is whether `project.yaml` still carries the removed keys, because
   * that is the question with no false positives — a project created after the
   * deletion has never had them and must never be asked. This says the
   * re-stamp happened, which is the only way a later run can tell "already
   * migrated" from "never had anything to migrate".
   */
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  assets: z.record(z.string().min(1), LedgerEntrySchema).prefault({}),
});

export type Ledger = z.infer<typeof LedgerSchema>;

export const EMPTY_LEDGER: Ledger = { version: 1, assets: {} };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type ProjectPaths = {
  /** Absolute path to project.yaml. */
  file: string;
  dir: string;
  scenario: string;
  publish: string;
  generated: string;
  storyboard?: string;
  ledger: string;
};

/** Resolves a project-relative path, leaving absolute ones alone. */
export function fromProject(projectDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(projectDir, value);
}

export function pathsOf(projectFile: string, project: Project): ProjectPaths {
  const dir = dirname(resolve(projectFile));
  return {
    file: resolve(projectFile),
    dir,
    scenario: fromProject(dir, project.scenario),
    publish: fromProject(dir, project.publish),
    generated: fromProject(dir, project.generated),
    storyboard: project.storyboard ? fromProject(dir, project.storyboard) : undefined,
    ledger: join(dir, '.ledger.json'),
  };
}

/**
 * Directory holding every take of one asset.
 *
 * The asset's filename is used verbatim as the folder name — `station.jpg`
 * becomes `generated/images/station.jpg/`. Dots are legal in directory names,
 * and stripping the extension would collide `hero.png` with `hero.jpg`, which
 * are two different assets a scenario is perfectly entitled to reference.
 *
 * A scenario that files its assets in per-section folders — `voice/tran-d5-01.mp3`
 * — has already said "voice" once, and repeating it as `voice/voice_tran-d5-01.mp3`
 * is noise in the one folder an author opens by hand to hear what was made. The
 * section directory stays regardless of naming, because it is what keeps `a.mp3`
 * in `voice:` from sharing a folder with `a.mp3` in `music:`.
 */
export function takesDir(paths: ProjectPaths, section: AssetSection, file: string): string {
  const inside = file.startsWith(`${section}/`) ? file.slice(section.length + 1) : file;
  return join(paths.generated, section, inside.replaceAll(/[\\/]/g, '_'));
}

// ---------------------------------------------------------------------------
// The recipe, and its hash
// ---------------------------------------------------------------------------

/**
 * Everything that determines what a generator would produce, with section
 * defaults already folded in.
 *
 * Resolved rather than raw on purpose: editing a section's `style` has to make
 * every asset in that section stale, because it genuinely changes all of them.
 */
export type Recipe = {
  section: AssetSection;
  /**
   * A note to whoever makes this file, not something a model is handed.
   *
   * Still in the hash, and that is the point: for art made in another program,
   * a prompt edit going stale is exactly the reminder somebody wants when the
   * shot they drew no longer matches what the row asks for.
   */
  prompt: string;
  params: Params;
  /** In the recipe, so re-sizing a shot marks what was made at the old size stale. */
  size?: string;
  /**
   * Whether this picture is somebody's face, from the scenario rather than the
   * row — a portrait is composed as a cutout, and that changes what is made.
   */
  portrait?: boolean;
  text?: string;
  voice?: string;
  /**
   * The character's voice, folded in rather than referred to.
   *
   * A recipe has to contain everything that decides what comes out, or the
   * hash cannot do its job. Naming the voice and leaving its settings outside
   * would mean re-recording a character's reference clip left every line they
   * speak looking finished.
   */
  reference?: string;
  preset?: string;
  direction?: string;
  model: { backend: string; file?: string };
};

/**
 * `portrait` comes from the scenario, not from `project.yaml`, so it has to be
 * handed in. Every caller has to pass the same answer or the hash means nothing
 * — the board would call a picture finished that the generator would make
 * differently — so there is one derivation of it, `portraitFilesOf`.
 */
export type RecipeContext = { portrait?: boolean };

export function resolveRecipe(
  project: Project,
  section: AssetSection,
  file: string,
  context: RecipeContext = {},
): Recipe {
  const row = project.assets[file] ?? AssetRowSchema.parse({});
  const model = project.sections[section];
  const voice = row.voice ? project.voices[row.voice] : undefined;
  return {
    section,
    ...(context.portrait ? { portrait: true } : {}),
    prompt: row.prompt ?? '',
    size: row.size,
    // Widest first: the section is how this kind of asset is made, the voice is
    // how this character sounds, the row is this one clip. Each may correct the
    // one above it.
    params: { ...(model?.defaults ?? {}), ...(voice?.params ?? {}), ...row.params },
    text: row.text,
    voice: row.voice,
    reference: voice?.reference,
    preset: voice?.preset,
    direction: voice?.direction,
    model: { backend: model?.backend ?? 'manual', file: model?.file },
  };
}

/** Key-order-independent JSON, so a reordered YAML map is not a new recipe. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export function recipeHash(recipe: Recipe): string {
  // Short enough to read in a diff, long enough that a collision is not a
  // realistic way to be shown stale art as fresh.
  return createHash('sha256').update(canonical(recipe)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export class ProjectError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = 'ProjectError';
    this.problems = problems;
  }
}

function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

export function parseProjectSource(raw: string): Project {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ProjectError(`Invalid YAML: ${(err as Error).message}`);
  }

  const result = ProjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectError(
      'project.yaml does not match the expected format',
      formatZodError(result.error),
    );
  }
  return result.data;
}

export async function loadProject(projectFile: string): Promise<Project> {
  let raw: string;
  try {
    raw = await readFile(projectFile, 'utf8');
  } catch (err) {
    throw new ProjectError(`Could not read ${projectFile}: ${(err as Error).message}`);
  }
  return parseProjectSource(raw);
}

/**
 * A missing or corrupt ledger is not fatal.
 *
 * It records which take was picked, not the takes themselves — those are files
 * on disk. Losing it costs you your selections, which is annoying; refusing to
 * open the project would cost you the project.
 */
export async function loadLedger(
  ledgerFile: string,
): Promise<{ ledger: Ledger; warning?: string }> {
  let raw: string;
  try {
    raw = await readFile(ledgerFile, 'utf8');
  } catch {
    return { ledger: structuredClone(EMPTY_LEDGER) };
  }

  try {
    return { ledger: LedgerSchema.parse(JSON.parse(raw)) };
  } catch (err) {
    return {
      ledger: structuredClone(EMPTY_LEDGER),
      warning: `Ledger at ${ledgerFile} is unreadable and was ignored: ${(err as Error).message}`,
    };
  }
}

/** Temp file plus rename: a crash mid-write must not destroy the ledger. */
export async function saveLedger(ledgerFile: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(ledgerFile), { recursive: true });
  const temp = `${ledgerFile}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(temp, ledgerFile);
}
