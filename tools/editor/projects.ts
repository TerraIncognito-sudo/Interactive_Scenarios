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

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile, rename, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseDocument, Scalar, stringify as stringifyYaml } from 'yaml';
import { ASSET_SECTIONS, parseScenarioSource, type AssetSection } from '../../src/scenario/load.ts';
import {
  fromProject,
  loadLedger,
  loadProject,
  parseProjectSource,
  pathsOf,
  recipeHash,
  resolveRecipe,
  saveLedger,
  takesDir,
  ProjectError,
  ProjectSchema,
  type Project,
  type ProjectPaths,
} from './project.ts';
import { buildOverview, type Overview } from './sections.ts';
import { outstandingOf, type Outstanding } from './outstanding.ts';
import {
  parseStoryboard,
  seedRowsFor,
  type SeedResult,
  type StoryboardShot,
} from './storyboard.ts';
import { migrateShotsInto, type ShotMigration } from './shots.ts';
import {
  renameReferences,
  renameRows,
  sortIntoFolders,
  type FolderSort,
} from './folders.ts';
import {
  generateAsset,
  makeReferenceClip,
  publishAsset,
  GenerateError,
  type GeneratedTake,
  type Published,
  type ReferenceClip,
} from './generate.ts';
import { wireVoiceInto, type WiredLine } from './wire.ts';
import {
  portraitFilesOf,
  removeSpriteFrom,
  wireSpritesInto,
  type SpriteWiring,
} from './sprites.ts';
import { planReconcile, type ReconcilePlan, type RowUpdate } from './reconcile.ts';
import { retimeInto, type Retimed } from './timing.ts';
import {
  addListItem,
  addNode,
  moveListItem,
  moveNode,
  removeListItem,
  removeNode,
  renameNode,
  retypeNode,
  setNodeField,
  type SpineWarning,
} from './nodes.ts';
import { looksSynced, modelsRoot, within, workspace } from './workspace.ts';

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
const ASSET_SEGMENT = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * A name a project route will act on.
 *
 * Segments may nest, because a scenario files its assets by media type, but
 * every segment has to be an ordinary name — and `..` is an ordinary name as
 * far as a character class is concerned, which is the trap. This string reaches
 * `join()` on the way to a takes folder and a publish path, and the editor
 * writes files without asking anyone.
 */
function safeAsset(name: string): boolean {
  if (!ASSET_SEGMENT.test(name)) return false;
  return name.split('/').every((part) => part !== '.' && part !== '..');
}

/**
 * A take is one file inside one folder, and never a path.
 *
 * The dot is in the character class because a take has an extension — which
 * means `..` matches the pattern, the same trap `safeAsset` has. It reached
 * `join()` on the way to an `rm` before a test went looking for it. The
 * containment check downstream caught it, but a name that is not a name should
 * be refused by the thing whose job that is.
 */
function safeTake(name: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return name !== '.' && name !== '..';
}

export type OpenProject = {
  name: string;
  project: Project;
  paths: ProjectPaths;
  /** Absent until the project has a project.yaml of its own. */
  projectSource?: string;
  scenarioSource: string;
  storyboardSource?: string;
  overview: Overview;
  /** The same board, projected into one ordered list of what is left. */
  outstanding: Outstanding;
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
    // Beside the scenario, on purpose. Everything a project is made of should
    // be in one folder that copies as a unit — that is what makes deploying a
    // show "move this folder" and what makes a project openable a year later.
    // Takes are small for voice and large for video, so the sync warning stays
    // a warning rather than a decision made on the author's behalf.
    generated: 'generated',
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
    outstanding: outstandingOf(overview),
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
  const { rows: assets, placement } = await seedFromStoryboard(dir, project, new Set());

  const document = {
    project: project.project,
    title: project.title,
    ...(project.storyboard ? { storyboard: project.storyboard } : {}),
    scenario: project.scenario,
    publish: project.publish,
    generated: project.generated,
    sections: {
      // The storyboard's own style and negative, if it stated them. A project
      // born with `style: ""` is one where every prompt still says `STYLE.` and
      // nothing anywhere says what STYLE is — which is a word the model reads
      // literally and a film whose frames do not match.
      images: {
        backend: 'manual',
        style: placement.style ?? '',
        negative: placement.negative ?? '',
      },
      video: { backend: 'manual' },
      voice: { backend: 'manual' },
      sfx: { backend: 'manual' },
      ambience: { backend: 'manual' },
      music: { backend: 'manual' },
    },
    ...(Object.keys(placement.tokens).length > 0 ? { tokens: placement.tokens } : {}),
    assets,
  };

  // Said in the file rather than acted on. Where the takes go is the author's
  // call — a project whose parts are scattered across two drives is one nobody
  // can hand to anybody else — but a sync client is going to upload every one
  // of them, and that is worth knowing before there are ten thousand.
  const header = looksSynced(dir)
    ? '# This project is inside a synced drive, so everything under generated/ will\n' +
      '# be uploaded too. Voice takes are small; stills and video are not. Point\n' +
      '# generated: at a path outside the drive if that becomes a problem.\n'
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
  placement: TokenPlacement;
}> {
  const nothing = { rows: {}, fills: [], unmatched: [], placement: { tokens: {} } };
  if (!project.storyboard) return nothing;

  const storyboard = await readFile(join(dir, project.storyboard), 'utf8').catch(() => undefined);
  if (storyboard === undefined) return nothing;

  const scenarioSource = await readFile(pathsOf(join(dir, 'project.yaml'), project).scenario, 'utf8')
    .catch(() => undefined);
  if (scenarioSource === undefined) return nothing;

  const parsed = parseScenarioSource(scenarioSource);
  if (!parsed.ok) return nothing;

  const document = parseStoryboard(storyboard);
  const seeded = seedRowsFor(parsed.scenario, document.shots, document.sheets);
  const placement = placeTokens(document.tokens);

  const rows: Record<string, Record<string, unknown>> = {};
  /** Field paths to write onto rows that already exist. */
  const fills: { file: string; path: string[]; value: unknown }[] = [];

  for (const asset of seeded.rows) {
    if (rows[asset.file]) continue;

    const row: Record<string, unknown> = {};
    if (asset.prompt) row.prompt = asset.prompt;
    if (asset.size) row.size = asset.size;
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

  return { rows, fills, unmatched: seeded.unmatched, placement };
}

/**
 * Routes the storyboard's named blocks to the fields that already mean them.
 *
 * `STYLE` and `NEGATIVE` are a section's `style` and `negative` — those fields
 * exist for exactly this and are already folded into every recipe in the
 * section, so putting the text anywhere else would be a second copy of a fact
 * the schema already holds. Everything else is a bible a prompt refers to by
 * name, and lives in `tokens`.
 *
 * Only images. The storyboard says "prepend to *every* image prompt", and a
 * motion prompt is "slow parallax push toward the bow" — a camera instruction
 * over a still that already carries the palette. Style on it would be four
 * hundred characters of paint applied to a move.
 */
export type TokenPlacement = {
  style?: string;
  negative?: string;
  tokens: Record<string, string>;
};

export function placeTokens(defined: Record<string, string>): TokenPlacement {
  const placement: TokenPlacement = { tokens: {} };
  for (const [name, body] of Object.entries(defined)) {
    if (name === 'STYLE') placement.style = body;
    else if (name === 'NEGATIVE') placement.negative = body;
    else placement.tokens[name] = body;
  }
  return placement;
}

/** Absent, or present and empty. Both are holes; neither is tuning to protect. */
function isHole(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
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
   * Named blocks that reached the project for the first time — the style, the
   * negative, a design bible. Reported because a board whose prompts suddenly
   * grew four hundred characters of palette should say so out loud.
   */
  defined: string[];
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

  const { rows, fills, unmatched, placement } = await seedFromStoryboard(dir, project, existing);
  const added = Object.keys(rows).sort();
  const filled = [...new Set(fills.map((fill) => fill.file))].sort();

  // The style, the negative and the bibles. Filled only where the project has
  // a hole: once an author has tuned a style, the document that suggested it
  // has no business overwriting it.
  const defining: { path: (string | number)[]; value: string; name: string }[] = [];
  if (placement.style && isHole(project.sections.images?.style)) {
    defining.push({ path: ['sections', 'images', 'style'], value: placement.style, name: 'STYLE' });
  }
  if (placement.negative && isHole(project.sections.images?.negative)) {
    defining.push({
      path: ['sections', 'images', 'negative'],
      value: placement.negative,
      name: 'NEGATIVE',
    });
  }
  for (const [name, body] of Object.entries(placement.tokens)) {
    if (isHole(project.tokens[name])) {
      defining.push({ path: ['tokens', name], value: body, name });
    }
  }

  if (added.length === 0 && fills.length === 0 && defining.length === 0) {
    return { added, filled, kept: existing.size, unmatched, defined: [] };
  }

  const doc = parseDocument(source);
  for (const entry of defining) doc.setIn(entry.path, blockValue(entry.value));
  for (const [assetFile, row] of Object.entries(rows)) {
    for (const [field, value] of Object.entries(row)) {
      doc.setIn(['assets', assetFile, field], blockValue(value));
    }
  }
  for (const fill of fills) doc.setIn(['assets', fill.file, ...fill.path], blockValue(fill.value));
  await writeAtomic(file, doc.toString());

  return {
    added,
    filled,
    kept: existing.size,
    unmatched,
    defined: defining.map((entry) => entry.name),
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Stores a path the way the rest of the project file does: relative when it is
 * inside the project, absolute when it is not.
 *
 * The picker deals in absolute paths because the server has to open the file.
 * Writing that straight into `project.yaml` would pin a character's voice to
 * one machine's directory layout, and the folder is meant to be copyable — the
 * reference clip is part of the show, not part of this computer.
 */
function portablePath(dir: string, value: string): string {
  if (!value) return value;
  const resolved = resolve(value);
  if (!within(dir, resolved)) return value;
  // Forward slashes: this file is read on machines that are not this one.
  return relative(dir, resolved).split(sep).join('/');
}

/**
 * Rewrites one field of one character's voice.
 *
 * Separate from `editAssetField` because a voice is not an asset: it produces
 * no file of its own, and it is shared by every line the character speaks.
 * Editing it makes all of those stale at once, which is the whole reason it
 * lives in one place rather than on ninety rows.
 */
export async function editVoiceField(
  name: string,
  edit: { voice: string; field: 'reference' | 'preset' | 'direction' | 'notes'; value: string },
): Promise<void> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  if (!/^[A-Za-z0-9_-]+$/.test(edit.voice)) throw new ProjectError('Bad character id');
  if (edit.field === 'reference') edit = { ...edit, value: portablePath(dir, edit.value) };

  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });
  const doc = parseDocument(source);

  const path = ['voices', edit.voice, edit.field];
  if (edit.value === '') doc.deleteIn(path);
  else doc.setIn(path, blockValue(edit.value));

  const next = doc.toString();
  parseProjectSource(next);
  await writeAtomic(file, next);
}

/**
 * Points a section at a generator.
 *
 * The one edit that changes how everything in a section is made, so it goes
 * through the same document API as everything else — an author's `style` and
 * the comment explaining it survive being handed a model.
 */
export async function editSectionField(
  name: string,
  edit: { section: string; field: 'backend' | 'file' | 'style' | 'negative'; value: string },
): Promise<void> {
  const file = join(projectDir(name), 'project.yaml');
  if (!/^[a-z]+$/.test(edit.section)) throw new ProjectError('Bad section');

  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });
  const doc = parseDocument(source);

  const path = ['sections', edit.section, edit.field];
  if (edit.value === '') doc.deleteIn(path);
  else doc.setIn(path, blockValue(edit.value));

  const next = doc.toString();
  parseProjectSource(next);
  await writeAtomic(file, next);
}

export type FieldEdit = {
  file: string;
  field: 'prompt' | 'negative' | 'size' | 'text' | 'voice' | 'notes' | 'freeze' | 'gap';
  /**
   * A number stays a number. `gap` is arithmetic the board does — written as
   * a string it would load back as one and fail the schema, so the row would
   * silently stop counting the moment anybody set it.
   */
  value: string | number | boolean;
};

/**
 * Rewrites one field of one asset row, preserving every comment and every other
 * line in the file exactly as the author left them.
 */
export async function editAssetField(name: string, edit: FieldEdit): Promise<void> {
  const file = join(projectDir(name), 'project.yaml');
  if (!safeAsset(edit.file)) throw new ProjectError('Bad asset name');

  const source = await readFile(file, 'utf8').catch(() => {
    throw new ProjectError('Set this project up for asset work first');
  });
  const doc = parseDocument(source);

  const path = ['assets', edit.file, edit.field];
  // An empty box means 'back to the default' rather than 'zero': a gap of 0
  // is a real choice somebody might make, and it has to be distinguishable
  // from never having chosen.
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

export async function saveScenarioSource(
  name: string,
  source: string,
): Promise<ReconcilePlan> {
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  await writeAtomic(pathsOf(file, project).scenario, source);

  // The whole point of the tighter join: the recipes follow the story on the
  // same trip, so the board is never a save behind what the show says.
  return reconcileProject(name);
}

// ---------------------------------------------------------------------------
// The Nodes tab
// ---------------------------------------------------------------------------

export type NodeWork = {
  /** Handed back so the source tab can be refreshed without a second read. */
  source: string;
  rewired: { nodeId: string; from: string; to: string }[];
  warnings: SpineWarning[];
  /** What the edit did that no pointer records — see `NodeEdit.notes`. */
  notes: string[];
  reconciled: ReconcilePlan;
};

/**
 * Runs one structural edit over `scenario.yaml` and writes it — but only if
 * the result still loads.
 *
 * The check is the point. These edits are driven by dragging and by text
 * boxes, so the cost of getting one wrong is a file the show cannot open,
 * discovered by whoever next presses play. Refusing to write and saying why
 * keeps a bad edit on the author's screen instead of on disk.
 */
async function editNodesIn(
  name: string,
  what: string,
  edit: (source: string) => {
    source: string;
    rewired?: NodeWork['rewired'];
    warnings?: SpineWarning[];
    notes?: string[];
  },
): Promise<NodeWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const source = await readFile(paths.scenario, 'utf8').catch(() => {
    throw new ProjectError('This project has no scenario.yaml to edit');
  });

  let result;
  try {
    result = edit(source);
  } catch (error) {
    throw new ProjectError(error instanceof Error ? error.message : String(error));
  }

  const check = parseScenarioSource(result.source);
  if (!check.ok) throw new ProjectError(`${what} would have broken the scenario`, check.problems);

  await writeAtomic(paths.scenario, result.source);
  return {
    source: result.source,
    rewired: result.rewired ?? [],
    warnings: result.warnings ?? [],
    notes: result.notes ?? [],
    reconciled: await reconcileProject(name),
  };
}

export function moveScenarioNode(name: string, id: string, toIndex: number): Promise<NodeWork> {
  return editNodesIn(name, 'Moving that node', (source) => moveNode(source, id, toIndex));
}

export function addScenarioNode(
  name: string,
  spec: { id: string; type: string; fields?: Record<string, string | number> },
  afterId?: string,
): Promise<NodeWork> {
  return editNodesIn(name, 'Adding that node', (source) => addNode(source, spec, afterId));
}

export function removeScenarioNode(name: string, id: string): Promise<NodeWork> {
  return editNodesIn(name, 'Removing that node', (source) => removeNode(source, id));
}

export function renameScenarioNode(name: string, from: string, to: string): Promise<NodeWork> {
  return editNodesIn(name, 'Renaming that node', (source) => renameNode(source, from, to));
}

export function retypeScenarioNode(name: string, id: string, to: string): Promise<NodeWork> {
  return editNodesIn(name, 'Changing that node type', (source) => retypeNode(source, id, to));
}

export function moveScenarioListItem(
  name: string,
  id: string,
  path: (string | number)[],
  fromIndex: number,
  toIndex: number,
): Promise<NodeWork> {
  return editNodesIn(name, 'Moving that entry', (source) => ({
    source: moveListItem(source, id, path, fromIndex, toIndex),
  }));
}

export function setScenarioNodeField(
  name: string,
  id: string,
  path: (string | number)[],
  value: string | number | boolean | null,
  after?: string,
): Promise<NodeWork> {
  return editNodesIn(name, 'That edit', (source) => ({
    source: setNodeField(source, id, path, value, after),
  }));
}

export function addScenarioListItem(
  name: string,
  id: string,
  path: (string | number)[],
  fields: Record<string, string | number>,
): Promise<NodeWork> {
  return editNodesIn(name, 'Adding that entry', (source) => ({
    source: addListItem(source, id, path, fields),
  }));
}

export function removeScenarioListItem(
  name: string,
  id: string,
  path: (string | number)[],
  index: number,
): Promise<NodeWork> {
  return editNodesIn(name, 'Removing that entry', (source) => ({
    source: removeListItem(source, id, path, index),
  }));
}

/**
 * Brings `project.yaml` back into agreement with the scenario.
 *
 * Run after every write to `scenario.yaml`, from whichever action made it —
 * this is the join the pipeline was missing. Editing a line of dialogue used
 * to leave the recipe holding the old words: the hash never moved, the board
 * went on saying `ready`, and the clip in the show read a sentence that was no
 * longer in the script. The only way to catch it was to listen to all ninety.
 *
 * Two of the three things it can do are safe and happen here. Derived fields
 * are re-derived, which marks exactly the affected clips stale and turns the
 * re-record list into something the board can show. Newly referenced assets
 * get a row, so declaring a `voice:` or a `sprite:` puts it on the board
 * without a second button.
 *
 * The third — taking a row away — is reported and never done. That stays a
 * thing a person presses.
 */
export async function reconcileProject(name: string): Promise<ReconcilePlan> {
  const nothing: ReconcilePlan = { added: {}, updates: [], orphans: [] };
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');

  // A scenario folder with no project.yaml is not set up for asset work at
  // all, and saving it must not be the thing that decides it should be.
  const source = await readFile(file, 'utf8').catch(() => undefined);
  if (source === undefined) return nothing;
  const project = parseProjectSource(source);

  const scenarioSource = await readFile(pathsOf(file, project).scenario, 'utf8').catch(
    () => undefined,
  );
  if (scenarioSource === undefined) return nothing;
  const parsed = parseScenarioSource(scenarioSource);
  if (!parsed.ok) return nothing;

  // The storyboard is optional here, unlike in seeding. Everything the
  // scenario owns comes from the scenario; the document only ever contributed
  // the author's half, so a project without one still stays in sync.
  let shots: StoryboardShot[] = [];
  let sheets: Record<string, string> = {};
  if (project.storyboard) {
    const document = await readFile(join(dir, project.storyboard), 'utf8').catch(() => undefined);
    if (document !== undefined) {
      const read = parseStoryboard(document);
      shots = read.shots;
      sheets = read.sheets;
    }
  }

  const plan = planReconcile(parsed.scenario, project, shots, sheets);
  if (Object.keys(plan.added).length === 0 && plan.updates.length === 0) return plan;

  const doc = parseDocument(source);
  for (const [assetFile, row] of Object.entries(plan.added)) {
    for (const [field, value] of Object.entries(row)) {
      doc.setIn(['assets', assetFile, field], blockValue(value));
    }
  }
  for (const update of plan.updates) {
    doc.setIn(['assets', update.file, ...update.path], blockValue(update.to));
  }

  const next = doc.toString();
  parseProjectSource(next);
  await writeAtomic(file, next);
  return plan;
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

export type Retyped = {
  from: string;
  to: string;
  section: AssetSection;
  /** What the bytes turned out to be. */
  kind: string;
};

export type RetypeWork = {
  renamed: Retyped[];
  /** Names that cannot be corrected without a decision. */
  skipped: { file: string; why: string }[];
  /** Line numbers where a comment sits beside a name that just changed. */
  comments: number[];
  source: string;
  reconciled?: ReconcilePlan;
};

/**
 * Makes every asset's extension say what the file actually is.
 *
 * A name is a promise the show relies on. The display asks for the name in
 * `scenario.yaml`, the server picks a content type out of its extension, and
 * PNG bytes called `.jpg` go out labelled `image/jpeg`. Browsers sniff images
 * and get away with it; a `.wav` served as `audio/mpeg` is a silent beat in
 * front of a room with nothing in any log about it.
 *
 * The name follows the bytes, never the other way round. Converting the file
 * would mean owning an encoder, which is the one thing `size.ts`, `duration.ts`
 * and `format.ts` all exist by refusing to do — and it would also be the wrong
 * answer: re-encoding a PNG as a JPEG to satisfy a name somebody typed months
 * ago throws away the transparency a portrait needs.
 *
 * A rename here is the same rename filing by media type performs, so it goes
 * through the same two pieces: `renameReferences` for every place the scenario
 * names the file, and `carryRename` for the published file, the recipe row, the
 * takes folder and the ledger entry.
 */
export async function renameToFormat(name: string, files?: string[]): Promise<RetypeWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const { overview } = await openProject(name);
  const asked = files ? new Set(files) : undefined;

  const source = await readFile(paths.scenario, 'utf8');
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  // Every name the scenario already uses, so a correction cannot land on top of
  // a different asset — `hero.jpg` holding a PNG beside a real `hero.png` is
  // two files that would become one.
  const taken = new Set(
    overview.sections.flatMap((view) => view.assets).map((asset) => asset.file),
  );

  const renamed: Retyped[] = [];
  const skipped: { file: string; why: string }[] = [];
  const decided = new Map<string, string>();

  for (const wanted of asked ?? []) {
    const known = overview.sections
      .flatMap((view) => view.assets)
      .find((asset) => asset.file === wanted);
    if (!known?.format?.rename) skipped.push({ file: wanted, why: 'not misnamed' });
  }

  for (const view of overview.sections) {
    for (const asset of view.assets) {
      const to = asset.format?.rename;
      if (!to) continue;
      if (asked && !asked.has(asset.file)) continue;
      if (!safeAsset(asset.file) || !safeAsset(to)) {
        skipped.push({ file: asset.file, why: 'not a name this route will act on' });
        continue;
      }
      if (taken.has(to)) {
        skipped.push({ file: asset.file, why: `${to} is already a different asset` });
        continue;
      }
      taken.add(to);
      decided.set(asset.file, to);
      renamed.push({ from: asset.file, to, section: asset.section, kind: asset.format!.actual });
    }
  }

  if (renamed.length === 0) return { renamed, skipped, comments: [], source };

  const next = renameReferences(source, parsed.scenario, decided);
  // Validated before it reaches the author's file, like every other action that
  // rewrites a scenario.
  const check = parseScenarioSource(next);
  if (!check.ok) {
    throw new ProjectError('Correcting the extensions would have broken the scenario', check.problems);
  }

  // Files first. A failure that is going to happen — a locked file, a full disk
  // — happens before the scenario points at names nothing has moved to.
  await carryRename(file, paths, renamed);
  await writeAtomic(paths.scenario, next);

  return {
    renamed,
    skipped,
    // A sentence beside a name that just changed may now be describing the old
    // one. Reported by line, never reworded: a machine that edits prose to keep
    // it true will eventually edit prose that was already true.
    comments: commentedLines(source, renamed.map((move) => move.from)),
    source: next,
    reconciled: await reconcileProject(name),
  };
}

/** Lines carrying a comment that mentions one of these names. */
function commentedLines(source: string, names: string[]): number[] {
  if (names.length === 0) return [];
  const found: number[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const hash = line.indexOf('#');
    if (hash === -1) return;
    const comment = line.slice(hash);
    if (names.some((name) => comment.includes(name))) found.push(index + 1);
  });
  return found;
}

/**
 * The recipe hash the board would show for this asset, right now.
 *
 * Derived here the same way `buildOverview` and the generator derive it —
 * `portraitFilesOf` and all — because a take filed under a hash the board never
 * computes reads as stale the moment it is made. `undefined` when the scenario
 * will not load, which is a real state: the file can still be copied in, it
 * just cannot be said which recipe it answers.
 */
async function currentHash(
  paths: ProjectPaths,
  project: Project,
  section: AssetSection,
  file: string,
): Promise<string | undefined> {
  const source = await readFile(paths.scenario, 'utf8').catch(() => undefined);
  if (source === undefined) return undefined;
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) return undefined;
  return recipeHash(
    resolveRecipe(project, section, file, {
      portrait: portraitFilesOf(parsed.scenario).has(file),
    }),
  );
}

export type Adopted = {
  file: string;
  take: string;
  /** What it was adopted out of, as it will read on the row. */
  from: string;
  /** True when the take was copied out of the publish folder just now. */
  copied: boolean;
};

export type AdoptWork = {
  adopted: Adopted[];
  /** Assets that need a decision first — several takes and none chosen. */
  skipped: { file: string; why: string }[];
};

/**
 * Brings a file nothing generated into the pipeline.
 *
 * `unmanaged` is the board's name for "there is a file here and no record of
 * where it came from". For a section with no generator that is every asset in
 * it, permanently: importing a take wrote the bytes and nothing else, so the
 * row went on reporting `unmanaged` with the file sitting in its own takes
 * folder, selected — and the command centre told the author to import it,
 * which is the thing they had already done. There was no way out of the state
 * at all.
 *
 * Adopting writes the take into the ledger against the recipe as it stands.
 * That is not a claim that a model made it — `from` says otherwise, and there
 * is no seed — it is the author saying "this file is my answer to this row".
 * Which makes the rest of the board work on it: edit the prompt afterwards and
 * it goes stale like anything else, which is exactly the reminder somebody
 * wants when the shot they drew no longer matches what the row asks for.
 *
 * Copying out of the publish folder is the one case that sets `published` as
 * well, because the copy is where the bytes came from — everywhere else the
 * size comparison in `buildOverview` is left to decide, since guessing that a
 * shipped file is a given take is how the room ends up hearing the old one.
 */
export async function adoptTakes(name: string, files?: string[]): Promise<AdoptWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const { overview } = await openProject(name);
  const asked = files ? new Set(files) : undefined;

  const adopted: Adopted[] = [];
  const skipped: { file: string; why: string }[] = [];
  const { ledger } = await loadLedger(paths.ledger);
  let touched = false;

  const candidates = overview.sections
    .flatMap((view) => view.assets)
    .filter((asset) => asset.status === 'unmanaged');
  const known = new Set(candidates.map((asset) => asset.file));

  for (const wanted of asked ?? []) {
    if (!known.has(wanted)) skipped.push({ file: wanted, why: 'not waiting to be adopted' });
  }

  for (const asset of candidates) {
    if (asked && !asked.has(asset.file)) continue;
    if (!safeAsset(asset.file)) {
      skipped.push({ file: asset.file, why: 'not a name this route will act on' });
      continue;
    }

    const folder = takesDir(paths, asset.section, asset.file);
    if (!within(resolve(paths.generated), resolve(folder))) {
      throw new ProjectError('Outside the project');
    }

    // The *selected* take, and only that one. An asset is only `unmanaged` with
    // takes present when the take it points at is the unrecorded one — a folder
    // of files with none picked reads as `unselected` instead, which is a
    // different question and gets a different answer. Picking one here would be
    // answering it on the author's behalf.
    const chosen = asset.takes.find(
      (take) => take.untracked && !take.orphaned && take.id === asset.selected,
    );

    let id: string;
    let from: string;
    let copied = false;

    if (chosen) {
      id = chosen.id;
      from = 'the takes folder';
    } else if (asset.published) {
      // Nothing in the takes folder, but there is a shipped file. It came from
      // somewhere and this is the only copy of it, so the takes folder gets one
      // — otherwise adopting would record a take that does not exist.
      const source = resolve(join(paths.publish, asset.file));
      if (!within(resolve(paths.publish), source)) throw new ProjectError('Outside the project');
      await mkdir(folder, { recursive: true });
      id = await freeName(folder, basename(asset.file));
      await copyFile(source, join(folder, id));
      from = 'the published file';
      copied = true;
    } else {
      skipped.push({ file: asset.file, why: 'nothing on disk to adopt' });
      continue;
    }

    const hash = await currentHash(paths, project, asset.section, asset.file);
    if (hash === undefined) {
      skipped.push({ file: asset.file, why: 'the scenario will not load, so there is no recipe' });
      continue;
    }

    const entry = (ledger.assets[asset.file] ??= { takes: [] });
    entry.takes.push({ id, hash, from, at: new Date().toISOString(), params: {} });
    entry.selected = id;
    if (copied) entry.published = id;
    touched = true;

    adopted.push({ file: asset.file, take: id, from, copied });
  }

  if (touched) await saveLedger(paths.ledger, ledger);
  return { adopted, skipped };
}

export type Discarded = {
  file: string;
  published: boolean;
  takes: number;
  bytes: number;
};

export type DiscardWork = {
  removed: Discarded[];
  /** What the whole sweep freed, so the report is worth reading. */
  bytes: number;
  /** Names asked for that are not on the stray list. See below. */
  skipped: string[];
};

/**
 * Deletes what is left on disk for assets the scenario stopped asking for.
 *
 * The client sends which files, never which *paths* — the same rule retiming
 * follows, and here it is the whole safety argument. Every candidate is
 * recomputed from `buildOverview`, and a name the board does not already list
 * as a stray is refused rather than acted on. So the worst a caller can do is
 * name something already agreed to be rubbish; it cannot name a path at all.
 * The segment check and the containment check are the two after that, because
 * this string reaches `join()` on the way to a recursive `rm`.
 *
 * The recipe row is left alone on purpose. A prompt is an afternoon of tuning
 * and `pruneOrphans` is where that decision is made, in front of the list —
 * whereas this is bytes, and the two are not the same trade.
 */
export async function discardStrays(name: string, files?: string[]): Promise<DiscardWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const { overview } = await openProject(name);
  const asked = files ? new Set(files) : undefined;
  const known = new Set(overview.strays.map((stray) => stray.file));

  const removed: Discarded[] = [];
  const skipped = [...(asked ?? [])].filter((entry) => !known.has(entry));

  const { ledger } = await loadLedger(paths.ledger);
  let touched = false;

  for (const stray of overview.strays) {
    if (asked && !asked.has(stray.file)) continue;
    if (!safeAsset(stray.file)) {
      skipped.push(stray.file);
      continue;
    }

    if (stray.published) {
      const target = resolve(join(paths.publish, stray.file));
      if (!within(resolve(paths.publish), target)) throw new ProjectError('Outside the project');
      await rm(target, { force: true });
    }

    const folder = resolve(takesDir(paths, stray.section, stray.file));
    if (!within(resolve(paths.generated), folder)) throw new ProjectError('Outside the project');
    await rm(folder, { recursive: true, force: true });

    // The ledger's record of an asset that no longer exists anywhere. Left
    // behind it is a take list pointing at files that are gone, which is what
    // `orphaned` on a take means — a state nothing can ever resolve.
    if (ledger.assets[stray.file]) {
      delete ledger.assets[stray.file];
      touched = true;
    }

    removed.push({
      file: stray.file,
      published: stray.published,
      takes: stray.takes,
      bytes: stray.bytes,
    });
  }

  if (touched) await saveLedger(paths.ledger, ledger);

  return {
    removed,
    bytes: removed.reduce((total, entry) => total + entry.bytes, 0),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Hearing it
// ---------------------------------------------------------------------------

/**
 * Extensions the editor will hand back, and what to call them.
 *
 * An allow-list rather than a lookup with a fallback. This route opens files by
 * a name that came from a browser, and "anything else, as octet-stream" is how
 * a folder picker becomes a way to read the author's whole disk one file at a
 * time.
 */
const MEDIA_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export type MediaRequest = {
  section?: string;
  file?: string;
  /** A take id within the asset's takes folder. Omit for the published file. */
  take?: string;
  /** A character id, for their reference clip. Mutually exclusive with the above. */
  reference?: string;
};

/**
 * Where a file the editor is being asked to play actually lives.
 *
 * Everything about a scenario's assets so far has been text — a name in a
 * manifest, a hash on a board, a status pill. None of that answers the only
 * question that matters about a voice clip, which is what it sounds like. An
 * author who cannot hear a take cannot choose between two of them, and a
 * pipeline whose selection step is guesswork is a pipeline that ships the first
 * reading of every line.
 *
 * Resolved from structured parts rather than from a path, and checked to be
 * under the project after resolving. The editor already browses the whole disk
 * on purpose, but that is a picker a person drives; this is a URL, and a URL
 * that dereferences `../..` is a different thing entirely.
 */
export async function resolveMedia(
  name: string,
  request: MediaRequest,
): Promise<{ path: string; type: string }> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  let target: string;
  let root: string;

  if (request.reference !== undefined) {
    if (!safeAsset(request.reference)) throw new ProjectError('Bad character id');
    const clip = project.voices[request.reference]?.reference;
    if (!clip) throw new ProjectError(`"${request.reference}" has no reference clip`);
    target = fromProject(paths.dir, clip);
    // A reference may be a recording from anywhere on the machine — that is
    // what "use your own" means — so the project is not the boundary here.
    root = resolve(target);
  } else {
    const section = request.section ?? '';
    if (!(ASSET_SECTIONS as readonly string[]).includes(section)) {
      throw new ProjectError('Unknown section');
    }
    if (!request.file || !safeAsset(request.file)) throw new ProjectError('Bad asset name');

    if (request.take) {
      if (!safeTake(request.take)) throw new ProjectError('Bad take name');
      root = takesDir(paths, section as AssetSection, request.file);
      target = join(root, request.take);
    } else {
      root = paths.publish;
      target = join(root, request.file);
    }
  }

  const resolved = resolve(target);
  if (!within(resolve(root), resolved)) throw new ProjectError('Outside the project');

  const type = MEDIA_TYPES[extname(resolved).toLowerCase()];
  if (!type) throw new ProjectError('Not a media file the editor will serve');

  if (!(await stat(resolved).catch(() => null))?.isFile()) {
    throw new ProjectError('That file is not there');
  }
  return { path: resolved, type };
}

export type FolderWork = Omit<FolderSort, 'source'> & {
  /** Published files that followed their name into the new folder. */
  republished: string[];
};

/**
 * Files every asset under a folder named for its media type.
 *
 * The scenario is the manifest, so the folder has to go into the name the
 * scenario declares — anything else would be a layout convention living in the
 * display, the validator and this editor at once, and the first time the three
 * disagreed the show would be missing a scene.
 *
 * Four things move together, and that is the whole reason this is a button:
 * the scenario's references, the recipe rows keyed to them, the ledger's
 * history, and any file already published under the old name. Doing three of
 * the four by hand leaves a board that says ready over art the show cannot
 * open.
 *
 * Takes need no move at all. Their folder is `generated/<section>/<name>`
 * either way — `takesDir` drops the section from a name that already carries
 * it — so a project's entire history of attempts survives being filed.
 */
export async function sortAssets(name: string): Promise<FolderWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const source = await readFile(paths.scenario, 'utf8').catch(() => {
    throw new ProjectError('This project has no scenario.yaml to sort');
  });
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const result = sortIntoFolders(source, parsed.scenario);
  const { source: sorted, ...report } = result;
  if (report.moved.length === 0) return { ...report, republished: [] };

  const check = parseScenarioSource(sorted);
  if (!check.ok) {
    throw new ProjectError('Filing the assets would have broken the scenario', check.problems);
  }

  // The published files first. If this is going to fail — a locked file, a
  // full disk — it should fail before the scenario has been rewritten to point
  // at names nothing has moved to yet.
  const republished: string[] = [];
  for (const move of report.moved) {
    const from = join(paths.publish, move.from);
    if (!(await stat(from).catch(() => null))?.isFile()) continue;
    const to = join(paths.publish, move.to);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    republished.push(move.to);
  }

  await writeAtomic(paths.scenario, sorted);

  // The recipes, by key edit rather than by rewriting the file: a row is an
  // afternoon of prompt tuning and a comment recording why.
  const projectSource = await readFile(file, 'utf8').catch(() => undefined);
  if (projectSource !== undefined) {
    await writeAtomic(file, renameRows(projectSource, report.moved));
  }

  const { ledger } = await loadLedger(paths.ledger);
  let touched = false;
  for (const move of report.moved) {
    const entry = ledger.assets[move.from];
    if (!entry) continue;
    ledger.assets[move.to] = entry;
    delete ledger.assets[move.from];
    touched = true;
  }
  if (touched) await saveLedger(paths.ledger, ledger);

  return { ...report, republished };
}

export type ShotWork = Omit<ShotMigration, 'source'> & {
  /** Recipes brought back into line with the scenario the migration rewrote. */
  reconciled?: ReconcilePlan;
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
  const seeded = await syncFromStoryboard(name);
  return { ...report, seeded, reconciled: await reconcileProject(name) };
}

export type GenerateFailure = {
  file: string;
  error: string;
  /** The generator's own output, when there was any. Usually a Python traceback. */
  detail?: string;
};

/**
 * Generates one asset, or every asset in a section that still needs one.
 *
 * Sequential by design. There is one GPU, and a batch that ran them in
 * parallel would take the same total time while making it impossible to say
 * which line was being worked on — and the first failure would arrive with
 * five others on top of it.
 *
 * A failure on one line does not stop the rest. Ninety lines will contain one
 * with an em dash the model chokes on, and losing the other eighty-nine to it
 * would mean starting again.
 */
export async function generate(
  name: string,
  request: { section: AssetSection; files: string[] },
): Promise<{ made: GeneratedTake[]; failed: GenerateFailure[] }> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file);
  const paths = pathsOf(file, project);

  const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const { ledger } = await loadLedger(paths.ledger);
  const made: GeneratedTake[] = [];
  const failed: GenerateFailure[] = [];

  for (const asset of request.files) {
    if (!safeAsset(asset)) {
      failed.push({ file: asset, error: 'bad asset name' });
      continue;
    }
    try {
      made.push(
        await generateAsset({
          scenario: parsed.scenario,
          project,
          paths,
          ledger,
          section: request.section,
          file: asset,
          modelsRoot: modelsRoot(),
        }),
      );
    } catch (err) {
      failed.push({
        file: asset,
        error: (err as Error).message,
        ...(err instanceof GenerateError && err.detail ? { detail: err.detail } : {}),
      });
    }
  }

  // Saved once, after the batch. The ledger is the machine's file and a
  // hundred rewrites of it during one run is a hundred chances to be
  // interrupted halfway.
  if (made.length > 0) await saveLedger(paths.ledger, ledger);
  return { made, failed };
}

/** Copies the selected take of each asset to the name the scenario declares. */
export async function publish(
  name: string,
  request: { section: AssetSection; files: string[] },
): Promise<{ published: Published[]; failed: GenerateFailure[] }> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file);
  const paths = pathsOf(file, project);
  const { ledger } = await loadLedger(paths.ledger);

  const published: Published[] = [];
  const failed: GenerateFailure[] = [];

  for (const asset of request.files) {
    if (!safeAsset(asset)) {
      failed.push({ file: asset, error: 'bad asset name' });
      continue;
    }
    try {
      published.push(await publishAsset({ paths, ledger, section: request.section, file: asset }));
    } catch (err) {
      failed.push({ file: asset, error: (err as Error).message });
    }
  }

  if (published.length > 0) await saveLedger(paths.ledger, ledger);

  return { published, failed };
}

/**
 * Records a reference clip for a character, in one of a palette model's voices.
 *
 * The answer to a cloning model's first question, which most authors cannot
 * answer: they have a scenario, not a sound booth. Writes the clip into the
 * project and points the character's voice at it, both in one action — a file
 * on disk that nothing references is not a voice, it is litter.
 */
export async function recordReference(
  name: string,
  request: { voice: string; preset: string; model?: string },
): Promise<ReferenceClip> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file);
  const paths = pathsOf(file, project);

  const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const clip = await makeReferenceClip({
    scenario: parsed.scenario,
    paths,
    who: request.voice,
    preset: request.preset,
    model: request.model ?? 'kokoro',
    modelsRoot: modelsRoot(),
  });

  await editVoiceField(name, { voice: request.voice, field: 'reference', value: clip.file });
  // Kept beside it so the clip can be made again. A wav in a folder with no
  // note of where it came from is a dead end the first time anyone wants to
  // adjust it.
  await editVoiceField(name, { voice: request.voice, field: 'preset', value: clip.preset });

  return clip;
}

export type SpriteWork = Omit<SpriteWiring, 'source'> & {
  /** Recipes brought back into line with the scenario the wiring rewrote. */
  reconciled?: ReconcilePlan;
  /** The seeding run that follows, which is what puts the sheet on the board. */
  seeded?: StoryboardSync;
};

/**
 * Gives every character the storyboard drew a sheet for a portrait to show.
 *
 * The display has drawn portraits from the start and no scenario has ever
 * declared one, so the feature has been present and invisible. This is the step
 * that connects them — and like wiring voice it writes to `scenario.yaml`,
 * because the scenario is the manifest and a picture nothing declares is a
 * picture nothing can track.
 *
 * It re-seeds afterwards for the same reason the shot migration does: declaring
 * three filenames and leaving three written prompts unattached is half the job,
 * and the half nobody remembers.
 */
export async function wireSprites(name: string): Promise<SpriteWork> {
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
  if (!storyboard) {
    throw new ProjectError('This project has no storyboard to take its character sheets from');
  }

  const sheets = parseStoryboard(storyboard).sheets;
  if (Object.keys(sheets).length === 0) {
    throw new ProjectError(
      'The storyboard describes no character sheets. A sheet is a bullet like ' +
        '**Beaudoin sheet:** followed by the prompt in backticks.',
    );
  }

  const result = wireSpritesInto(source, parsed.scenario, sheets);
  const { source: wired, ...report } = result;
  if (report.wired.length === 0) return report;

  const check = parseScenarioSource(wired);
  if (!check.ok) {
    throw new ProjectError('Declaring portraits would have broken the scenario', check.problems);
  }

  // A re-pointed portrait is a rename, and everything else in the project is
  // keyed by the filename: the recipe row holding the prompt, the ledger entry
  // holding the takes, the published file the show opens. Rewriting only the
  // scenario would leave the row behind as an orphan and the prompt with it.
  // Sprites are images by definition — `wireSpritesInto` only ever re-points a
  // character sheet — so the section is stated rather than looked up.
  await carryRename(file, paths, report.moved.map((move) => ({ ...move, section: 'images' as const })));

  await writeAtomic(paths.scenario, wired);
  const seeded = await syncFromStoryboard(name);
  return { ...report, seeded, reconciled: await reconcileProject(name) };
}

export type PortraitRemoval = {
  character: string;
  /** The file the scenario has stopped asking for. */
  file: string;
  /** Characters still showing it, so nothing claims the bytes are now spare. */
  sharedWith: string[];
  reconciled: ReconcilePlan;
};

/**
 * Takes a character's face out of the show.
 *
 * `scenario.yaml`, like wiring one in: the scenario is the manifest, and a
 * portrait is in the show exactly as long as a `sprite:` names it. Doing this
 * by hand is what the editor exists to make unnecessary — and the hand edit has
 * a real trap in it, since a `sprite:` inside a flow map is a different
 * deletion from one on its own line.
 *
 * What it deliberately does *not* do is touch the picture. The published PNG
 * and every take stay where they are and become strays, which the board already
 * finds, prices and offers to discard; the recipe row holding the prompt
 * becomes an orphan, which `pruneOrphans` already offers to remove. Both are
 * separate decisions made in front of their own list, because a remove button
 * that also deleted an afternoon of rendering is one nobody dares press.
 */
export async function removePortrait(name: string, character: string): Promise<PortraitRemoval> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const source = await readFile(paths.scenario, 'utf8').catch(() => {
    throw new ProjectError('This project has no scenario.yaml to edit');
  });
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  let removal;
  try {
    removal = removeSpriteFrom(source, parsed.scenario, character);
  } catch (error) {
    throw new ProjectError(error instanceof Error ? error.message : String(error));
  }

  const check = parseScenarioSource(removal.source);
  if (!check.ok) {
    throw new ProjectError('Removing that portrait would have broken the scenario', check.problems);
  }

  await writeAtomic(paths.scenario, removal.source);
  return {
    character,
    file: removal.file,
    sharedWith: removal.sharedWith,
    reconciled: await reconcileProject(name),
  };
}

/**
 * Follows a filename change through the rest of the project.
 *
 * Published file, recipe row, takes folder, ledger entry — in that order, so a
 * failure that is going to happen happens before the scenario has been rewritten
 * to point at a name nothing has moved to yet.
 */
async function carryRename(
  projectFile: string,
  paths: ProjectPaths,
  // The section is here because the takes folder is nested under it. It used
  // to be assumed to be `images`, which was true of the only caller and is not
  // true of correcting a `.wav` named `.mp3`.
  moves: { from: string; to: string; section: AssetSection }[],
): Promise<void> {
  if (moves.length === 0) return;

  for (const move of moves) {
    const from = join(paths.publish, move.from);
    if ((await stat(from).catch(() => null))?.isFile()) {
      await mkdir(dirname(join(paths.publish, move.to)), { recursive: true });
      await rename(from, join(paths.publish, move.to));
    }
  }

  const projectSource = await readFile(projectFile, 'utf8').catch(() => undefined);
  if (projectSource !== undefined) {
    await writeAtomic(projectFile, renameRows(projectSource, moves));
  }

  // Unlike filing by media type, this one really does move takes: the folder is
  // named for the file, and the file's extension is what changed. The takes
  // inside keep their own names — what they are called is the pipeline's own
  // business, and the name that had to be true is the one the show opens.
  for (const move of moves) {
    const fromDir = takesDir(paths, move.section, move.from);
    const toDir = takesDir(paths, move.section, move.to);
    if (fromDir === toDir) continue;
    if (!(await stat(fromDir).catch(() => null))?.isDirectory()) continue;
    if ((await stat(toDir).catch(() => null)) !== null) continue;
    await mkdir(dirname(toDir), { recursive: true });
    await rename(fromDir, toDir);
  }

  const { ledger } = await loadLedger(paths.ledger);
  let touched = false;
  for (const move of moves) {
    const entry = ledger.assets[move.from];
    if (!entry) continue;
    ledger.assets[move.to] = entry;
    delete ledger.assets[move.from];
    touched = true;
  }
  if (touched) await saveLedger(paths.ledger, ledger);
}

export type VoiceWiring = {
  /** Rows added for the clips this just declared. */
  reconciled?: ReconcilePlan;
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
  // Declaring the clip is only half of it: without this the line has a
  // `voice:` the player will open and no row anywhere saying how to make it.
  return {
    wired: result.wired,
    untouched: result.untouched,
    reconciled: await reconcileProject(name),
  };
}

/**
 * The storyboard is a document, not a generated artefact — it is where a
 * project starts and the place its intent is written down, so it is edited
 * here rather than in another window.
 */
export type RetimeWork = {
  changed: Retimed[];
  /** Clips asked for whose line could not be found, so nothing was written. */
  skipped: string[];
  /** The rewritten scenario, for the editor pane to take back. */
  source: string;
  /**
   * Lines whose comment now describes a beat that has changed.
   *
   * Reported, never rewritten. A machine that edits prose to keep it true will
   * eventually edit prose that was already true, and a comment saying why a
   * beat is four seconds is exactly the sentence a person should reread.
   */
  comments: number[];
};

/**
 * Sets each beat to the length of the clip that plays in it.
 *
 * The target comes from the board rather than from the caller: the client
 * sends which clips to retime, never what to, so the number written is the one
 * computed from the runtime the board measured and the gap the row declares.
 * A client that could send the number itself is a client that can write a beat
 * nothing on the board agrees with.
 */
export async function retime(name: string, files?: string[]): Promise<RetimeWork> {
  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const { overview } = await openProject(name);
  const asked = files ? new Set(files) : undefined;

  const wanted = new Map<string, number>();
  for (const view of overview.sections) {
    if (view.section !== 'voice') continue;
    for (const asset of view.assets) {
      if (asset.targetHold === undefined) continue;
      if (asked && !asked.has(asset.file)) continue;
      wanted.set(asset.file, asset.targetHold);
    }
  }

  const source = await readFile(paths.scenario, 'utf8');
  const parsed = parseScenarioSource(source);
  if (!parsed.ok) throw new ProjectError(parsed.message, parsed.problems);

  const result = retimeInto(source, parsed.scenario, wanted);
  if (result.changed.length === 0) {
    return { changed: [], skipped: result.skipped, source, comments: [] };
  }

  // Validated before it reaches the author's file, the same rule every other
  // action that rewrites a scenario follows. A beat is a number in a schema
  // with bounds, and one that fails them must never be written.
  const after = parseScenarioSource(result.source);
  if (!after.ok) throw new ProjectError(after.message, after.problems);

  await writeAtomic(paths.scenario, result.source);

  return {
    changed: result.changed,
    skipped: result.skipped,
    source: result.source,
    comments: commentedBeats(source, result.changed),
  };
}

/**
 * Line numbers where a comment sits beside a beat that just changed.
 *
 * Scenarios in this codebase carry sentences like "seven seconds, because the
 * pause after it is the point". Retiming makes some of those wrong, and the
 * honest thing is to say which ones rather than to quietly reword them.
 */
function commentedBeats(source: string, changed: Retimed[]): number[] {
  if (changed.length === 0) return [];
  const lines = source.split(/\r?\n/);
  const found: number[] = [];
  lines.forEach((text, index) => {
    if (!/^\s*hold:\s*[\d.]+\s*#/.test(text)) return;
    found.push(index + 1);
  });
  return found;
}

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
/**
 * Copies a finished file in from anywhere on the machine, as a take.
 *
 * The workflow for everything the editor cannot generate: art is made in
 * another program and has to get into a folder named after a filename, nested
 * two deep, that the author has to find first. **Copy folder** made that one
 * paste instead of twenty-six; this makes it a file picker.
 *
 * The bytes arrive over the wire rather than the path. The browser's file
 * dialog is the system one and hands the page a `File`, never a path — which
 * is also the safer half of the trade: nothing here opens a location the user
 * typed, so there is no path from this route to a file they did not choose.
 *
 * It lands in the takes folder and is recorded there — see the note by the
 * ledger write below, which is the half that was missing. A first take for an
 * asset with nothing selected is also selected, for the same reason generating
 * does it: an asset with one take and no selection is a row reporting work
 * still to do that has already been done.
 */
export async function importTake(
  name: string,
  request: { section: AssetSection; file: string; filename: string },
  body: Readable,
): Promise<{ take: string; bytes: number; selected: boolean; tracked: boolean }> {
  if (!(ASSET_SECTIONS as readonly string[]).includes(request.section)) {
    throw new ProjectError('Unknown section');
  }
  if (!safeAsset(request.file)) throw new ProjectError('Bad asset name');

  const take = takeNameFrom(request.filename);
  const type = MEDIA_TYPES[extname(take).toLowerCase()];
  if (!type) {
    throw new ProjectError(
      `The editor does not handle "${extname(take) || 'files with no extension'}". ` +
        `It reads ${[...new Set(Object.keys(MEDIA_TYPES))].join(', ')}.`,
    );
  }

  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const folder = takesDir(paths, request.section, request.file);
  await mkdir(folder, { recursive: true });

  // Never over an existing take. A second import of `final.png` is a second
  // attempt, and silently replacing the first would throw away the one the
  // author may have already selected.
  const chosen = await freeName(folder, take);

  // Through a temporary file, so a copy that fails halfway — a full disk, a
  // network drive going away mid-transfer — does not leave a truncated file in
  // the folder looking exactly like a take.
  const temp = join(folder, `.importing-${Date.now()}`);
  let bytes = 0;
  try {
    body.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(body, createWriteStream(temp));
    await rename(temp, join(folder, chosen));
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }

  // Recorded, not merely written. Dropping the bytes in and stopping is what
  // left the whole Images section reporting `unmanaged` for ever: the take was
  // on disk and selected, nothing in the ledger explained it, and the board's
  // advice was to import it — which is what had just happened. A recipe hash
  // here is the author saying this file answers this row, which is the claim
  // they made by choosing it in the dialog.
  //
  // A scenario that will not parse yields no recipe, and the take stays
  // untracked rather than the import failing after the file has landed. Adopt
  // is then still there to record it once the scenario loads.
  const hash = await currentHash(paths, project, request.section, request.file);

  const { ledger } = await loadLedger(paths.ledger);
  const entry = (ledger.assets[request.file] ??= { takes: [] });
  const selected = entry.selected === undefined;
  if (hash !== undefined) {
    entry.takes.push({
      id: chosen,
      hash,
      from: request.filename,
      at: new Date().toISOString(),
      params: {},
    });
  }
  if (selected) entry.selected = chosen;
  if (hash !== undefined || selected) await saveLedger(paths.ledger, ledger);

  return { take: chosen, bytes, selected, tracked: hash !== undefined };
}

/**
 * A filename from a file dialog, made into a take id.
 *
 * The author's own name is kept — `beaudoin-v3-final.png` is what they will
 * look for — but it has to survive `join()` and the take guard, so anything
 * that is not a plain name becomes a dash.
 */
function takeNameFrom(filename: string): string {
  const base = basename(filename.replaceAll('\\', '/')).trim();
  const cleaned = base.replaceAll(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  if (!cleaned || !safeTake(cleaned)) throw new ProjectError('That filename cannot be used');
  return cleaned;
}

/** `shot.png`, then `shot-2.png`, and so on. */
async function freeName(folder: string, wanted: string): Promise<string> {
  const extension = extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  let candidate = wanted;
  for (let n = 2; await stat(join(folder, candidate)).catch(() => null); n += 1) {
    candidate = `${stem}-${n}${extension}`;
  }
  return candidate;
}

/**
 * Throws away one take.
 *
 * Re-rolling is free, which is the point of it — and a folder holding nine
 * readings of one line, six of them rejected on the first listen, is a folder
 * where finding the good one is the work. So the board can delete.
 *
 * The published file is never touched. Publishing is the deliberate act that
 * puts a reading in front of an audience, and a delete that quietly un-shipped
 * a line would be a very quiet way to lose one. If the deleted take was the
 * selected one the selection is cleared rather than moved — picking a
 * replacement is the author's, and guessing would ship a reading nobody chose.
 */
export async function deleteTake(
  name: string,
  section: AssetSection,
  asset: string,
  take: string,
): Promise<void> {
  if (!(ASSET_SECTIONS as readonly string[]).includes(section)) {
    throw new ProjectError('Unknown section');
  }
  if (!safeAsset(asset)) throw new ProjectError('Bad asset name');
  // The same guard the media route uses. This string reaches `join()` on the
  // way to an `rm`, and the editor deletes without asking anyone twice.
  if (!safeTake(take)) throw new ProjectError('Bad take name');

  const dir = projectDir(name);
  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);

  const folder = takesDir(paths, section, asset);
  const target = resolve(join(folder, take));
  if (!within(resolve(folder), target)) throw new ProjectError('Outside the takes folder');

  // `force` because a ledger entry for a file already gone is exactly the case
  // an author is trying to clear, and refusing would leave it unclearable.
  await rm(target, { force: true });

  const { ledger } = await loadLedger(paths.ledger);
  const entry = ledger.assets[asset];
  if (!entry) return;
  entry.takes = entry.takes.filter((recorded) => recorded.id !== take);
  if (entry.selected === take) delete entry.selected;
  await saveLedger(paths.ledger, ledger);
}

export async function selectTake(
  name: string,
  asset: string,
  take: string | null,
): Promise<void> {
  const dir = projectDir(name);
  if (!safeAsset(asset)) throw new ProjectError('Bad asset name');

  const file = join(dir, 'project.yaml');
  const project = await loadProject(file).catch(() => defaultProject(name, dir));
  const paths = pathsOf(file, project);
  const { ledger } = await loadLedger(paths.ledger);

  const entry = (ledger.assets[asset] ??= { takes: [] });
  if (take === null) delete entry.selected;
  else entry.selected = take;

  await saveLedger(paths.ledger, ledger);
}
