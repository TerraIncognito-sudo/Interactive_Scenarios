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
import { ASSET_SECTIONS, type AssetSection } from '../../src/scenario/load.ts';

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
  /** `manual` means "no generator wired up yet" — the Phase 1 default. */
  backend: z.enum(['comfyui', 'sidecar', 'manual']).default('manual'),
  /** Folder of weights on this machine. Scanned to populate the model picker. */
  root: z.string().min(1).optional(),
  /** Which file in `root` to use. */
  file: z.string().min(1).optional(),
  /** ComfyUI graph template with substitution points, relative to the project. */
  workflow: z.string().min(1).optional(),
  /**
   * Prepended and appended to every prompt in the section. Living here rather
   * than on each asset is what keeps twenty-six stills looking like one film:
   * one edit changes all of them, and the recipe hash makes all of them stale.
   */
  style: z.string().optional(),
  negative: z.string().optional(),
  defaults: ParamsSchema.prefault({}),
});

export type SectionModel = z.infer<typeof SectionModelSchema>;

/** Built from ASSET_SECTIONS so a new section cannot be added in only one place. */
const sectionShape = Object.fromEntries(
  ASSET_SECTIONS.map((section) => [section, SectionModelSchema.optional()]),
) as Record<AssetSection, z.ZodOptional<typeof SectionModelSchema>>;

export const SectionsSchema = z.strictObject(sectionShape);

export const ReferenceImageSchema = z.strictObject({
  file: z.string().min(1),
  /** How hard to hold the reference. The storyboard's character sheets use 0.35. */
  strength: z.number().min(0).max(1).default(0.35),
});

/** Where this asset came from in the storyboard, for click-through both ways. */
export const SourceRefSchema = z.strictObject({
  shot: z.string().min(1).optional(),
  node: z.string().min(1).optional(),
  line: z.number().int().min(0).optional(),
});

export const AssetRowSchema = z.strictObject({
  prompt: z.string().optional(),
  /** Overrides the section's negative rather than adding to it. */
  negative: z.string().optional(),
  refs: z.array(ReferenceImageSchema).prefault([]),
  params: ParamsSchema.prefault({}),
  /** Voice only: the spoken text, and which configured voice says it. */
  text: z.string().optional(),
  voice: z.string().min(1).optional(),
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
  /** All paths resolve relative to the project file, and may be absolute. */
  storyboard: z.string().min(1).optional(),
  scenario: z.string().min(1),
  publish: z.string().min(1),
  generated: z.string().min(1).default('generated'),
  sections: SectionsSchema.prefault({}),
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
  seed: z.number().optional(),
  at: z.string().min(1),
  ms: z.number().optional(),
  params: ParamsSchema.prefault({}),
});

export type Take = z.infer<typeof TakeSchema>;

export const LedgerEntrySchema = z.strictObject({
  selected: z.string().min(1).optional(),
  takes: z.array(TakeSchema).prefault([]),
});

export const LedgerSchema = z.strictObject({
  version: z.literal(1).default(1),
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
 */
export function takesDir(paths: ProjectPaths, section: AssetSection, file: string): string {
  return join(paths.generated, section, file.replaceAll(/[\\/]/g, '_'));
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
  prompt: string;
  negative: string;
  style: string;
  refs: { file: string; strength: number }[];
  params: Params;
  text?: string;
  voice?: string;
  model: { backend: string; file?: string };
};

export function resolveRecipe(
  project: Project,
  section: AssetSection,
  file: string,
): Recipe {
  const row = project.assets[file] ?? AssetRowSchema.parse({});
  const model = project.sections[section];
  return {
    section,
    prompt: row.prompt ?? '',
    negative: row.negative ?? model?.negative ?? '',
    style: model?.style ?? '',
    refs: row.refs,
    params: { ...(model?.defaults ?? {}), ...row.params },
    text: row.text,
    voice: row.voice,
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
