/**
 * Project routes: opening a project, editing a recipe, picking a take.
 *
 * Split from `server.ts` because the editor now has two jobs that share only a
 * process — editing a scenario's structure, and running the workshop that fills
 * it with art.
 *
 * A project is simply **a folder containing `scenario.yaml`**. That is the same
 * shape the game server already reads, which is what makes shipping a finished
 * scenario a matter of copying the folder: the extra files a project carries —
 * the storyboard, `project.yaml`, the takes — are inert to the loader.
 *
 * `project.yaml` is added when asset work starts, not before. A folder holding
 * only a scenario opens perfectly well; its board simply reports that nothing
 * has been made yet, which is true.
 *
 * A note on writing to `project.yaml`. It is the author's file: hand-tuned
 * prompts, comments recording why a prompt is the way it is. Editing a prompt
 * through the UI must not cost them that, so field edits go through YAML's
 * document API and rewrite one node in place. Parsing to an object and
 * re-serialising would silently strip every comment in the file the first time
 * anyone touched a text box.
 */

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseDocument, Scalar, stringify as stringifyYaml } from 'yaml';
import { parseScenarioSource } from '../../src/scenario/load.ts';
import {
  loadLedger,
  loadProject,
  parseProjectSource,
  pathsOf,
  saveLedger,
  ProjectError,
  ProjectSchema,
  type Project,
  type ProjectPaths,
} from './project.ts';
import { buildOverview, type Overview } from './sections.ts';
import { parseStoryboard, seedRowsFor, type SeedResult } from './storyboard.ts';
import { migrateShotsInto, type ShotMigration } from './shots.ts';
import { wireVoiceInto, type WiredLine } from './wire.ts';
import { looksSynced, within, workspace } from './workspace.ts';

/**
 * A value on its way into `project.yaml`, in the block style a person would
 * have used.
 *
 * An image prompt is several hand-wrapped lines, and YAML's default for one is
 * a folded scalar — which has to pad every original newline with a blank line
 * to survive the round trip. It reads back identically and looks nothing like
 * what was written. A literal block is what the importer already produces and
 * what the rest of the file uses, and this is the file whose prompts the author
 * spends weeks tuning.
 */
function blockValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.includes('\n')) return value;
  const scalar = new Scalar(value);
  scalar.type = Scalar.BLOCK_LITERAL;
  return scalar;
}

/** Asset keys are filenames, never paths. */
const SAFE_ASSET = /^[A-Za-z0-9._-]+$/;

export type OpenProject = {
  name: string;
  project: Project;
  paths: ProjectPaths;
  /** Absent until the project has a project.yaml of its own. */
  projectSource?: string;
  scenarioSource: string;
  storyboardSource?: string;
  overview: Overview;
  problems: { level: 'error' | 'warning'; message: string }[];
};

function requireWorkspace(): string {
  const root = workspace();
  if (!root) throw new ProjectError('No workspace chosen yet');
  return root;
}

/**
 * Resolves a project folder inside the workspace.
 *
 * Containment rather than a name whitelist, so folders with spaces in them —
 * "IS Generated Scenarios" is full of exactly that — work, while `..` still
 * cannot walk out of the workspace.
 */
function projectDir(name: string): string {
  const root = requireWorkspace();
  const dir = resolve(root, name);
  if (!within(root, dir) || dir === resolve(root)) {
    throw new ProjectError(`"${name}" is not a folder inside the workspace`);
  }
  return dir;
}

/** The storyboard, if the folder has one. Any `*storyboard*.md` counts. */
async function detectStoryboard(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const found = entries
    .filter((entry) => /storyboard.*\.md$/i.test(entry) || /\.storyboard\.md$/i.test(entry))
    .sort();
  return found[0];
}

/**
 * What a project looks like before anyone has written a `project.yaml`.
 *
 * `publish: assets` matches the layout the game server expects, so the project
 * folder and a scenario folder are the same thing — copying it across is the
 * whole deployment step.
 */
async function defaultProject(name: string, dir: string): Promise<Project> {
  return ProjectSchema.parse({
    project: name.replaceAll(/[^A-Za-z0-9_-]+/g, '-'),
    title: name,
    scenario: 'scenario.yaml',
    publish: 'assets',
    // Takes are enormous and the workspace may well be inside a synced folder.
    // Keeping them out of it by default is the difference between a working
    // project and a sync client quietly uploading a hundred gigabytes of
    // rejected art. Overridable, and written explicitly when a project file
    // is created so the choice is visible rather than magic.
    generated: looksSynced(dir) ? join(homedir(), 'scenario-takes', name) : 'generated',
    storyboard: await detectStoryboard(dir),
  });
}

export async function listProjects(): Promise<
  { name: string; title: string; ok: boolean; hasProjectFile: boolean; message?: string }[]
> {
  const root = workspace();
  if (!root) return [];

  let entries: string[];
  try {
    entries = await readdir(root, { withFileTypes: true }).then((all) =>
      all.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries.sort()) {
    const dir = join(root, entry);
    // A project is a folder with a scenario in it. Nothing else qualifies, and
    // nothing more is required.
    if (!(await stat(join(dir, 'scenario.yaml')).catch(() => null))) continue;

    const projectFile = join(dir, 'project.yaml');
    const hasProjectFile = Boolean(await stat(projectFile).catch(() => null));

    if (!hasProjectFile) {
      found.push({ name: entry, title: entry, ok: true, hasProjectFile: false });
      continue;
    }

    try {
      const project = await loadProject(projectFile);
      found.push({
        name: entry,
        title: project.title ?? project.project,
        ok: true,
        hasProjectFile: true,
      });
    } catch (err) {
      // A broken project is listed, not hidden. Being unable to open the one
      // file you need in order to fix it would be a poor editor.
      found.push({
        name: entry,
        title: entry,
        ok: false,
        hasProjectFile: true,
        message: err instanceof ProjectError ? err.message : (err as Error).message,
      });
    }
  }
  return found;
}

export async function openProject(name: string): Promise<OpenProject> {
  const dir = projectDir(name);
  const projectFile = join(dir, 'project.yaml');
  const problems: OpenProject['problems'] = [];

  let projectSource: string | undefined;
  let project: Project;
  try {
    projectSource = await readFile(projectFile, 'utf8');
    project = parseProjectSource(projectSource);
  } catch (err) {
    if (err instanceof ProjectError) throw err;
    project = await defaultProject(name, dir);
    problems.push({
      level: 'warning',
      message:
        'No project.yaml yet — prompts and model choices have nowhere to be saved. ' +
        'Set up asset work to create one.',
    });
  }

  const paths = pathsOf(projectFile, project);

  let scenarioSource = '';
  try {
    scenarioSource = await readFile(paths.scenario, 'utf8');
  } catch {
    throw new ProjectError(`No scenario at ${paths.scenario}`);
  }

  const parsed = parseScenarioSource(scenarioSource);
  if (!parsed.ok) {
    // Without a valid scenario there is no manifest, so there are no sections
    // to show. Say why rather than showing six empty lists.
    throw new ProjectError(parsed.message, parsed.problems);
  }

  let storyboardSource: string | undefined;
  if (paths.storyboard) {
    storyboardSource = await readFile(paths.storyboard, 'utf8').catch(() => undefined);
  }

  const { ledger, warning } = await loadLedger(paths.ledger);
  if (warning) problems.push({ level: 'warning', message: warning });

  const overview = await buildOverview(parsed.scenario, project, ledger, paths);

  // Scenario warnings stay on the scenario's own tab, and asset warnings stay
  // on the board. Merging them buries six sections under forty identical lines
  // of "this voiced line has no hold" — a warning that belongs on the one row
  // it is about, which is where `buildOverview` puts it.
  return {
    name,
    project,
    paths,
    projectSource,
    scenarioSource,
    storyboardSource,
    overview,
    problems,
  };
}

/** Temp file plus rename: a crash mid-write must not truncate the original. */
async function writeAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.tmp`;
  await writeFile(temp, contents, 'utf8');
  await rename(temp, file);
}

// ---------------------------------------------------------------------------
// Setting a project up for asset work
// ---------------------------------------------------------------------------

/**
 * Writes the project's first `project.yaml`, seeded from its storyboard.
 *
 * Seeding is additive and happens once. After this the project file owns the
 * prompts, and `syncFromStoryboard` will only ever add rows that are missing —
 * re-reading the storyboard must never overwrite weeks of tuning.
 */
export async function initProject(name: string): Promise<OpenProject> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  if (await stat(file).catch(() => null)) {
    throw new ProjectError('This project already has a project.yaml');
  }

  const project = await defaultProject(name, dir);
  const { rows: assets } = await seedFromStoryboard(dir, project, new Set());

  const document = {
    project: project.project,
    title: project.title,
    ...(project.storyboard ? { storyboard: project.storyboard } : {}),
    scenario: project.scenario,
    publish: project.publish,
    generated: project.generated,
    sections: {
      images: { backend: 'manual', style: '', negative: '' },
      video: { backend: 'manual' },
      voice: { backend: 'manual' },
      sfx: { backend: 'manual' },
      ambience: { backend: 'manual' },
      music: { backend: 'manual' },
    },
    assets,
  };

  const header = looksSynced(dir)
    ? '# generated/ is kept outside this folder on purpose: it is inside a synced\n' +
      '# drive, and takes accumulate to tens of gigabytes.\n'
    : '';

  await writeAtomic(file, header + stringifyYaml(document, { lineWidth: 0 }));
  return openProject(name);
}

/**
 * Rows the storyboard implies, for filenames the project does not have yet.
 *
 * Keyed by what the scenario actually references, never by a name of the
 * editor's own devising. The player opens exactly the filenames in
 * `scenario.yaml`; a prompt written against any other name would belong to a
 * file nothing will ever load, and the two halves of the tool would quietly
 * disagree about what the show is made of.
 */
async function seedFromStoryboard(
  dir: string,
  project: Project,
  existing: Set<string>,
): Promise<{
  rows: Record<string, Record<string, unknown>>;
  fills: { file: string; path: string[]; value: unknown }[];
  unmatched: SeedResult['unmatched'];
}> {
  const nothing = { rows: {}, fills: [], unmatched: [] };
  if (!project.storyboard) return nothing;

  const storyboard = await readFile(join(dir, project.storyboard), 'utf8').catch(() => undefined);
  if (storyboard === undefined) return nothing;

  const scenarioSource = await readFile(pathsOf(join(dir, 'project.yaml'), project).scenario, 'utf8')
    .catch(() => undefined);
  if (scenarioSource === undefined) return nothing;

  const parsed = parseScenarioSource(scenarioSource);
  if (!parsed.ok) return nothing;

  const seeded = seedRowsFor(parsed.scenario, parseStoryboard(storyboard).shots);

  const rows: Record<string, Record<string, unknown>> = {};
  /** Field paths to write onto rows that already exist. */
  const fills: { file: string; path: string[]; value: unknown }[] = [];

  for (const asset of seeded.rows) {
    if (rows[asset.file]) continue;

    const row: Record<string, unknown> = {};
    if (asset.prompt) row.prompt = asset.prompt;
    if (asset.text) row.text = asset.text;
    if (asset.voice) row.voice = asset.voice;
    // Written key by key rather than spread wholesale: an undefined field would
    // serialise as `shot: null`, which reads as "no shot, checked" rather than
    // "never had one".
    const source: Record<string, unknown> = {};
    if (asset.source.shot) source.shot = asset.source.shot;
    if (asset.source.node) source.node = asset.source.node;
    if (asset.source.line !== undefined) source.line = asset.source.line;
    if (Object.keys(source).length > 0) row.source = source;

    if (!existing.has(asset.file)) {
      rows[asset.file] = row;
      continue;
    }

    // The row is already there. Anything the author has written stays exactly
    // as written — but a field that is *absent* is not tuning to protect, and
    // leaving it absent is how a mapping fix arrives on disk and never reaches
    // the board. Fill the holes; touch nothing else.
    const current = project.assets[asset.file];
    if (!current) continue;
    for (const [field, value] of Object.entries(row)) {
      if (field === 'source') continue;
      if (current[field as 'prompt' | 'text' | 'voice'] === undefined) {
        fills.push({ file: asset.file, path: [field], value });
      }
    }
    for (const [key, value] of Object.entries(source)) {
      if (current.source?.[key as 'shot' | 'node' | 'line'] === undefined) {
        fills.push({ file: asset.file, path: ['source', key], value });
      }
    }
  }

  return { rows, fills, unmatched: seeded.unmatched };
}

export type StoryboardSync = {
  added: string[];
  /**
   * Rows that were already there and gained a field they did not have — a
   * delivery note that had nowhere to attach until a mapping was fixed, say.
   * Never a field that already held a value.
   */
  filled: string[];
  /** Already in the project; left exactly as they were. */
  kept: number;
  /**
   * Storyboard prompts with no file in the scenario to attach them to — most
   * often spoken lines that have no `voice:` in the scenario yet. Reported
   * rather than written under an invented filename, which would put a prompt
   * on a file the player is never going to ask for.
   */
  unmatched: SeedResult['unmatched'];
};

/**
 * Re-reads the storyboard, adds rows for anything new, and fills fields that
 * existing rows never had.
 *
 * Strictly additive at the level that matters: no value is ever replaced. Once
 * a prompt has been tuned in the project file, the document that suggested it
 * has no business overwriting it. An empty field is a different thing from a
 * tuned one, though — it is a hole, and refusing to fill holes means a fix to
 * the storyboard's node mapping lands on disk and never reaches the board.
 */
export async function syncFromStoryboard(name: string): Promise<StoryboardSync> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');

  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });
  const project = parseProjectSource(source);
  const existing = new Set(Object.keys(project.assets));

  const { rows, fills, unmatched } = await seedFromStoryboard(dir, project, existing);
  const added = Object.keys(rows).sort();
  const filled = [...new Set(fills.map((fill) => fill.file))].sort();
  if (added.length === 0 && fills.length === 0) {
    return { added, filled, kept: existing.size, unmatched };
  }

  const doc = parseDocument(source);
  for (const [assetFile, row] of Object.entries(rows)) {
    for (const [field, value] of Object.entries(row)) {
      doc.setIn(['assets', assetFile, field], blockValue(value));
    }
  }
  for (const fill of fills) doc.setIn(['assets', fill.file, ...fill.path], blockValue(fill.value));
  await writeAtomic(file, doc.toString());

  return { added, filled, kept: existing.size, unmatched };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export type FieldEdit = {
  file: string;
  field: 'prompt' | 'negative' | 'text' | 'voice' | 'notes' | 'freeze';
  value: string | boolean;
};

/**
 * Rewrites one field of one asset row, preserving every comment and every other
 * line in the file exactly as the author left them.
 */
export async function editAssetField(name: string, edit: FieldEdit): Promise<void> {
  const file = join(projectDir(name), 'project.yaml');
  if (!SAFE_ASSET.test(edit.file)) throw new ProjectError('Bad asset name');

  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });
  const doc = parseDocument(source);

  const path = ['assets', edit.file, edit.field];
  if (edit.value === '' || edit.value === false) {
    doc.deleteIn(path);
  } else {
    // `setIn` creates the intermediate maps when a row does not exist yet,
    // which is what happens the first time an author writes a prompt for an
    // asset the scenario references but the project has never seen.
    doc.setIn(path, blockValue(edit.value));
  }

  const next = doc.toString();
  parseProjectSource(next);
  await writeAtomic(file, next);
}

export async function saveProjectSource(name: string, source: string): Promise<void> {
  parseProjectSource(source);
  await writeAtomic(join(projectDir(name), 'project.yaml'), source);
}

export async function saveScenarioSource(name: string, source: string): Promise<void> {
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  await writeAtomic(pathsOf(file, project).scenario, source);
}

/**
 * Removes recipes for files the scenario no longer references.
 *
 * The project file must never contain an asset the scenario does not ask for:
 * a recipe nothing plays is GPU hours and disk spent on nothing, and it hides
 * real gaps inside a long list. Renaming a file in the scenario leaves its old
 * recipe behind, so the editor has to be able to take one away as well as add
 * one — otherwise the only way to clean up is to hand-edit the file, which is
 * how the two halves start disagreeing.
 *
 * Deliberately a separate, explicit action rather than something sync does on
 * its own. A row can hold an afternoon of tuning, and losing it to a rename
 * nobody meant to make is not a trade the machine gets to choose.
 */
export async function pruneOrphans(name: string): Promise<{ removed: string[] }> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });

  const { overview } = await openProject(name);
  if (overview.orphans.length === 0) return { removed: [] };

  const doc = parseDocument(source);
  for (const orphan of overview.orphans) doc.deleteIn(['assets', orphan]);
  await writeAtomic(file, doc.toString());

  return { removed: [...overview.orphans] };
}

export type ShotWork = Omit<ShotMigration, 'source'> & {
  /** The seeding run that follows, which is the point of the migration. */
  seeded?: StoryboardSync;
};

/**
 * Gives every storyboarded shot its own still and clip.
 *
 * The pipeline's second step, and the one that makes the rest of the board
 * reachable: until a node can carry its own picture, every shot after the
 * first in a given place has a prompt with no filename to hang off, and the
 * board reports it unplaceable. See `shots.ts` for what it will and will not
 * fold.
 *
 * It re-seeds afterwards on purpose. Declaring the filenames and leaving the
 * prompts unattached would be half the job, and the half that is left is the
 * half nobody remembers — the author would be looking at a board that still
 * says the work cannot be placed.
 *
 * The new source is validated before it is written. A migration that would not
 * load is a bug in this editor, and the author's scenario is not where anyone
 * should find out about it.
 */
export async function migrateShots(name: string): Promise<ShotWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const source = await readFile(paths.scenario, 'utf8').catch(() => {
    throw new ProjectError('This project has no scenario.yaml to migrate');
  });
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const storyboard = project.storyboard
    ? await readFile(join(dir, project.storyboard), 'utf8').catch(() => undefined)
    : undefined;
  if (!storyboard) {
    throw new ProjectError('This project has no storyboard to take its shots from');
  }

  const result = migrateShotsInto(source, parsed.scenario, parseStoryboard(storyboard).shots);
  const { source: migrated, ...report } = result;
  if (report.moved.length === 0 && report.folded.length === 0) return report;

  const check = parseScenarioSource(migrated);
  if (!check.ok) {
    throw new ProjectError('Migrating shots would have broken the scenario', check.problems);
  }

  await writeAtomic(paths.scenario, migrated);
  return { ...report, seeded: await syncFromStoryboard(name) };
}

export type VoiceWiring = {
  wired: WiredLine[];
  untouched: number;
};

/**
 * Declares a `voice:` clip on every spoken line that has none.
 *
 * The scenario is the manifest, so nothing exists to generate or track until
 * the scenario says it does — which makes this the first step of the pipeline
 * rather than a chore preceding it. Doing it outside the editor is how a
 * scenario and a project file start disagreeing about what the show is made of.
 *
 * The new source is validated before it is written. A wiring that would not
 * load is a bug in this file, and the author's scenario is not the place to
 * find out about it.
 */
export async function wireVoice(name: string): Promise<VoiceWiring> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const source = await readFile(paths.scenario, 'utf8').catch(() => {
    throw new ProjectError('This project has no scenario.yaml to wire');
  });
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const storyboard = project.storyboard
    ? await readFile(join(dir, project.storyboard), 'utf8').catch(() => undefined)
    : undefined;
  const shots = storyboard ? parseStoryboard(storyboard).shots : [];

  const result = wireVoiceInto(source, parsed.scenario, shots);
  if (result.wired.length === 0) return { wired: [], untouched: result.untouched };

  const check = parseScenarioSource(result.source);
  if (!check.ok) {
    throw new ProjectError('Wiring voice would have broken the scenario', check.problems);
  }

  await writeAtomic(paths.scenario, result.source);
  return { wired: result.wired, untouched: result.untouched };
}

/**
 * The storyboard is a document, not a generated artefact — it is where a
 * project starts and the place its intent is written down, so it is edited
 * here rather than in another window.
 */
export async function saveStoryboardSource(name: string, source: string): Promise<void> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const storyboard = project.storyboard ?? 'storyboard.md';
  await writeAtomic(join(dir, basename(storyboard)), source);
}

/**
 * Records which take of an asset is the one to use.
 *
 * Selection is a pointer, not a copy — nothing is regenerated and nothing is
 * moved. Changing your mind about a take is meant to be free, which is what
 * makes keeping every attempt worth doing in the first place.
 */
export async function selectTake(
  name: string,
  asset: string,
  take: string | null,
): Promise<void> {
  const dir = projectDir(name);
  if (!SAFE_ASSET.test(asset)) throw new ProjectError('Bad asset name');

  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);
  const { ledger } = await loadLedger(paths.ledger);

  const entry = (ledger.assets[asset] ??= { takes: [] });
  if (take === null) delete entry.selected;
  else entry.selected = take;

  await saveLedger(paths.ledger, ledger);
}
