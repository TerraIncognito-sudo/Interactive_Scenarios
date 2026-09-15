/**
 * Re-stamping the ledger when the shape of a recipe changes.
 *
 * A hash is the only thing on the board that says a finished file still answers
 * the row that asked for it. `canonical()` filters `undefined` and nothing
 * else, so every hash ever recorded contains the *whole* recipe object of the
 * day it was written — empty fields included. On a voice row that means
 * `negative: ""`, `style: ""`, `refs: []` and `tokens: {}` are all inside the
 * hash, none of which a voice clip has ever used.
 *
 * So dropping a field from `Recipe` moves every recorded hash at once. Measured
 * before any of this was written: 208 rows across three finished shows, all
 * `ready`, all matched by hash, none frozen. Every one of them was exposure —
 * and `adoptTakes` only rescues `unmanaged`, so a row pushed to `stale` this
 * way has no route back short of re-recording it.
 *
 * This is the route back. It reads the old world with its own frozen copy of
 * the old code, finds every take whose recorded hash is what the old code would
 * have produced, and rewrites it to what the new code produces. A take matching
 * neither is left exactly where it is and reported: it was stale before this
 * ran and it is stale now, and guessing on the author's behalf is the one thing
 * that would make this dangerous.
 *
 * Everything under "the frozen old world" is a **copy**, never an import. The
 * entire job is to compute what the old code computed, so the new code has to
 * be free to change out from under it. Importing `resolveRecipe` there would
 * quietly make this file agree with whatever `project.ts` says today, which is
 * the one thing it must not do.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isScalar, parseDocument, parse as parseYaml, type Pair, type YAMLMap } from 'yaml';
import { z } from 'zod';
import {
  assetReferencesOf,
  parseScenarioSource,
  type AssetSection,
} from '../../shared/scenario/load.ts';
import { portraitFilesOf } from './sprites.ts';
import {
  loadLedger,
  parseProjectSource,
  ProjectError,
  recipeHash,
  resolveRecipe,
  saveLedger,
  type Project,
} from './project.ts';

export type RecipeMigration = {
  /** Rows whose recorded takes moved from the old hash to the new one. */
  restamped: { file: string; takes: number }[];
  /** Rows already carrying the current hash. The whole report on a no-op run. */
  current: string[];
  /**
   * A row whose **selected** take matches neither hash.
   *
   * Deliberately only the selected one. A row that has been re-rolled keeps
   * every reading it rejected, and those were made under older prompts, so
   * their hashes match nothing and never did — across three finished shows
   * that is eighty-eight takes, all of them ordinary history. Counting those
   * here made a confirm dialog read "eighty-eight takes match neither recipe",
   * which is indistinguishable from damage and would stop anybody pressing the
   * button. What is worth a person's attention is the take a row actually
   * points at, because that is the one that leaves it `stale`.
   */
  unrecognised: { file: string; take: string }[];
  /** Older takes left exactly as they were. Reported as a count, not a list. */
  historical: number;
  /** Keys taken out of project.yaml, in the order they were removed. */
  stripped: string[];
  /**
   * Comments sitting against a key that has just been removed.
   *
   * Reported by line number and never reworded. A machine that rewrites prose
   * to keep it true will eventually rewrite prose that was already true.
   */
  staleComments: { line: number; text: string }[];
};

/** The keys this migration exists to remove. */
export const REMOVED_ROOT_KEYS = ['tokens'] as const;
export const REMOVED_SECTION_KEYS = ['style', 'negative'] as const;
export const REMOVED_ROW_KEYS = ['negative', 'refs'] as const;

// ---------------------------------------------------------------------------
// The frozen old world. Copies. Never imports. See the note at the top.
// ---------------------------------------------------------------------------

const LegacyParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/**
 * Loose on purpose, in both directions.
 *
 * It has to read a `project.yaml` written before the deletion — carrying keys
 * the current strict schema now rejects — and one written after, carrying none
 * of them. `z.object` strips what it does not name, which is exactly the
 * tolerance wanted: this schema knows only the fields that reach a hash.
 */
const LegacySection = z.object({
  backend: z.string().default('manual'),
  file: z.string().optional(),
  style: z.string().optional(),
  negative: z.string().optional(),
  defaults: LegacyParams.default({}),
});

const LegacyRow = z.object({
  prompt: z.string().optional(),
  size: z.string().optional(),
  negative: z.string().optional(),
  refs: z.array(z.object({ file: z.string(), strength: z.number().default(0.35) })).default([]),
  params: LegacyParams.default({}),
  text: z.string().optional(),
  voice: z.string().optional(),
});

const LegacyVoice = z.object({
  reference: z.string().optional(),
  preset: z.string().optional(),
  direction: z.string().optional(),
  params: LegacyParams.default({}),
});

const LegacyProjectSchema = z.object({
  scenario: z.string().default('scenario.yaml'),
  sections: z.record(z.string(), LegacySection).default({}),
  assets: z.record(z.string(), LegacyRow).default({}),
  voices: z.record(z.string(), LegacyVoice).default({}),
  tokens: z.record(z.string(), z.string()).default({}),
});

type LegacyProject = z.infer<typeof LegacyProjectSchema>;

/** A copy of `prompt.ts`'s TOKEN, frozen at the shape the old hashes used. */
const LEGACY_TOKEN = /\b([A-Z][A-Z0-9_]{2,})\.(?=\s|$)/g;

function legacyUsedTokens(project: LegacyProject, prompt: string): Record<string, string> {
  const used: Record<string, string> = {};
  const names = new Set([...prompt.matchAll(LEGACY_TOKEN)].map((match) => match[1]!));
  for (const name of names) {
    const defined = project.tokens[name];
    if (defined !== undefined) used[name] = defined;
  }
  return used;
}

/** A copy of `project.ts`'s `canonical`, frozen. */
function legacyCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${legacyCanonical(v)}`).join(',')}}`;
}

/** A copy of `resolveRecipe` and `recipeHash`, frozen together as one step. */
function legacyHashOf(
  project: LegacyProject,
  section: AssetSection,
  file: string,
  portrait: boolean,
): string {
  const row = project.assets[file] ?? LegacyRow.parse({});
  const model = project.sections[section];
  const voice = row.voice ? project.voices[row.voice] : undefined;

  const recipe = {
    section,
    ...(portrait ? { portrait: true } : {}),
    prompt: row.prompt ?? '',
    negative: row.negative ?? model?.negative ?? '',
    style: model?.style ?? '',
    refs: row.refs,
    size: row.size,
    params: { ...(model?.defaults ?? {}), ...(voice?.params ?? {}), ...row.params },
    text: row.text,
    voice: row.voice,
    reference: voice?.reference,
    preset: voice?.preset,
    direction: voice?.direction,
    tokens: legacyUsedTokens(project, row.prompt ?? ''),
    model: { backend: model?.backend ?? 'manual', file: model?.file },
  };

  return createHash('sha256').update(legacyCanonical(recipe)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

/**
 * Whether this project still has anything for the migration to do.
 *
 * Keyed on the removed keys actually being present rather than on a version
 * number, so a project created after the deletion is never asked to migrate and
 * a restored backup that still carries them always is. The ledger version is a
 * record that the re-stamp happened, not the thing that decides whether it must.
 */
export function needsRecipeMigration(source: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    // Unreadable is a different problem, with its own message elsewhere.
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const project = parsed as Record<string, unknown>;

  const has = (holder: unknown, keys: readonly string[]): boolean => {
    if (!holder || typeof holder !== 'object') return false;
    return keys.some((key) => (holder as Record<string, unknown>)[key] !== undefined);
  };

  if (has(project, REMOVED_ROOT_KEYS)) return true;
  for (const model of Object.values((project.sections ?? {}) as Record<string, unknown>)) {
    if (has(model, REMOVED_SECTION_KEYS)) return true;
  }
  for (const row of Object.values((project.assets ?? {}) as Record<string, unknown>)) {
    if (has(row, REMOVED_ROW_KEYS)) return true;
  }
  return false;
}

/**
 * The same file with the dead keys taken out, for reading only.
 *
 * `openProject` parses with the strict schema, so once these keys leave it an
 * un-migrated `project.yaml` throws — and the board's catch reports "no
 * project.yaml yet" and renders every row as missing, which is a far worse lie
 * than the staleness the migration exists to prevent. Reading through this
 * instead keeps the board truthful about everything *except* the hashes, and
 * `needsRecipeMigration` is what puts the explanation on screen beside it.
 */
export function strippedProjectSource(source: string): string {
  return stripRemovedKeys(source).next;
}

const fromProject = (dir: string, value: string): string =>
  isAbsolute(value) ? resolve(value) : resolve(dir, value);

/**
 * What the old code would have produced for these files, as it stands on disk.
 *
 * Exported because it is the only honest way to seed or check a ledger written
 * before the change: any other route means writing the old arithmetic a second
 * time, and a copy of a copy is a thing that can disagree with the original
 * while both look right.
 */
export async function legacyHashesFor(
  dir: string,
  files: string[],
): Promise<Record<string, string>> {
  const legacy = LegacyProjectSchema.parse(parseYaml(await readFile(join(dir, 'project.yaml'), 'utf8')) ?? {});
  const parsed = parseScenarioSource(await readFile(fromProject(dir, legacy.scenario), 'utf8'));
  if (!parsed.ok) throw new ProjectError('The scenario will not load', parsed.problems);

  const portraits = portraitFilesOf(parsed.scenario);
  const section = new Map<string, AssetSection>();
  for (const ref of assetReferencesOf(parsed.scenario)) {
    if (!section.has(ref.file)) section.set(ref.file, ref.section);
  }

  const out: Record<string, string> = {};
  for (const file of files) {
    const which = section.get(file);
    if (!which) continue;
    out[file] = legacyHashOf(legacy, which, file, portraits.has(file));
  }
  return out;
}

/**
 * Re-stamps a project's ledger, then takes the dead keys out of `project.yaml`.
 *
 * The order is the whole design. Interrupted after the ledger is written it is
 * correct and re-runnable; done the other way round, the values the old hashes
 * were computed from would be gone before anything had used them, and no later
 * run could recover them.
 *
 * Idempotent: a second run finds every take already carrying the current hash
 * and reports the lot as current.
 *
 * `dryRun` computes the whole answer and writes nothing. It is not a
 * convenience — this is a route that rewrites an author's ledger and their
 * project file in one press, and being able to read what it is about to do
 * first is what makes it a button somebody dares use.
 */
export async function migrateRecipes(
  dir: string,
  options: { dryRun?: boolean } = {},
): Promise<RecipeMigration> {
  const file = join(dir, 'project.yaml');
  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });

  const legacy = LegacyProjectSchema.parse(parseYaml(source) ?? {});
  const scenarioFile = fromProject(dir, legacy.scenario);
  const parsed = parseScenarioSource(await readFile(scenarioFile, 'utf8'));
  if (!parsed.ok) {
    throw new ProjectError(
      'The scenario will not load, so there is no recipe to migrate against',
      parsed.problems,
    );
  }
  const portraits = portraitFilesOf(parsed.scenario);

  // The current recipe needs the *current* schema, which a project still
  // carrying the removed keys no longer satisfies. Read it through the stripped
  // source rather than a hand-built object, so this takes exactly the path every
  // other caller takes and cannot drift from it.
  const { next, stripped, staleComments } = stripRemovedKeys(source);
  const current: Project = parseProjectSource(next);

  const section = new Map<string, AssetSection>();
  for (const ref of assetReferencesOf(parsed.scenario)) {
    if (!section.has(ref.file)) section.set(ref.file, ref.section);
  }

  const ledgerFile = join(dir, '.ledger.json');
  const { ledger } = await loadLedger(ledgerFile);

  const restamped: RecipeMigration['restamped'] = [];
  const unchanged: string[] = [];
  const unrecognised: RecipeMigration['unrecognised'] = [];
  let historical = 0;
  let touched = false;

  for (const [asset, entry] of Object.entries(ledger.assets)) {
    const which = section.get(asset);
    // A row the scenario stopped referencing. `pruneOrphans` decides those, in
    // front of its own list; re-stamping one here would be deciding for it.
    if (!which) continue;

    const portrait = portraits.has(asset);
    const before = legacyHashOf(legacy, which, asset, portrait);
    const after = recipeHash(resolveRecipe(current, which, asset, { portrait }));

    let moved = 0;
    for (const take of entry.takes) {
      if (take.hash === after) continue;
      if (take.hash === before) {
        take.hash = after;
        moved += 1;
        touched = true;
        continue;
      }
      // Matches neither. If the row points at it, somebody needs to know --
      // that row is going to read `stale` and no migration can fix it. If it
      // does not, this is a reading that was rejected months ago under a
      // different prompt, and has been matching nothing ever since.
      if (entry.selected === take.id) unrecognised.push({ file: asset, take: take.id });
      else historical += 1;
    }

    if (moved > 0) restamped.push({ file: asset, takes: moved });
    else unchanged.push(asset);
  }

  const report = { restamped, current: unchanged, unrecognised, historical, stripped, staleComments };
  if (options.dryRun) return report;

  if (touched || ledger.version !== 2) {
    // The version is a record that the re-stamp happened, written even on a
    // run that moved nothing — that is what makes a later "already migrated"
    // answer trustworthy rather than a guess from the absence of dead keys.
    ledger.version = 2;
    await saveLedger(ledgerFile, ledger);
  }

  // The ledger first, always. Interrupted here the run is correct and
  // re-runnable; the other way round, the values the old hashes were computed
  // from would be gone before anything had used them.
  if (stripped.length > 0) {
    // Temp file plus rename, like every other write to a project: a crash here
    // must not leave half a project.yaml where the author's file was.
    const temp = `${file}.tmp`;
    await writeFile(temp, next, 'utf8');
    await rename(temp, file);
  }

  return report;
}

/**
 * Takes the dead keys out, through YAML's document API.
 *
 * `project.yaml` is the author's file, full of hand-tuned prompts and comments
 * recording why. Parsing it to an object and re-serialising strips every one of
 * them; deleting from a parsed document leaves everything it did not touch
 * exactly where it was. Returns the source unchanged when there is nothing to
 * remove, so a migrated project is never rewritten for the sake of it.
 */
function stripRemovedKeys(source: string): {
  next: string;
  stripped: string[];
  staleComments: { line: number; text: string }[];
} {
  const doc = parseDocument(source);
  const stripped: string[] = [];
  const staleComments: { line: number; text: string }[] = [];

  const drop = (path: (string | number)[], label: string): void => {
    const parent = doc.getIn(path.slice(0, -1)) as YAMLMap | undefined;
    const key = path[path.length - 1];
    const pair = parent?.items?.find(
      (item) => isScalar(item.key) && item.key.value === key,
    ) as Pair | undefined;
    if (!pair) return;

    // A comment written above a key is about that key, and in YAML's document
    // model it hangs off the *key* node rather than the value — read it off the
    // value and every one of these goes unreported, which is how this was
    // written the first time. Removing the key leaves the prose describing
    // something that is no longer there, so say where it is and leave the words
    // exactly as the author wrote them.
    const attached =
      (isScalar(pair.key) ? pair.key.commentBefore : undefined) ??
      (pair.value as { commentBefore?: string } | undefined)?.commentBefore;
    const comment = attached?.split('\n')[0]?.trim();
    if (comment) {
      const at = source.indexOf(comment);
      staleComments.push({
        line: at === -1 ? 0 : source.slice(0, at).split('\n').length,
        text: comment,
      });
    }

    doc.deleteIn(path);
    stripped.push(label);
  };

  const namesIn = (path: string[]): string[] => {
    const map = doc.getIn(path) as YAMLMap | undefined;
    return (map?.items ?? [])
      .map((item) => (isScalar(item.key) ? item.key.value : undefined))
      .filter((value): value is string => typeof value === 'string');
  };

  for (const key of REMOVED_ROOT_KEYS) drop([key], key);
  for (const name of namesIn(['sections'])) {
    for (const key of REMOVED_SECTION_KEYS) drop(['sections', name, key], `sections.${name}.${key}`);
  }
  for (const name of namesIn(['assets'])) {
    for (const key of REMOVED_ROW_KEYS) drop(['assets', name, key], `assets[${name}].${key}`);
  }

  return { next: stripped.length > 0 ? doc.toString() : source, stripped, staleComments };
}
