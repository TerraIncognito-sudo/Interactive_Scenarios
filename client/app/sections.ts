/**
 * The status board: what the show needs, what exists, and what is out of date.
 *
 * This is the join at the centre of the editor. Four sources, none of which is
 * authoritative on its own:
 *
 *   the scenario   what files the show will actually open        (the manifest)
 *   project.yaml   how each of them is supposed to be made       (the recipe)
 *   .ledger.json   which takes exist and which one is picked     (the history)
 *   the disk       what is really there                          (the truth)
 *
 * A file is only "done" when all four agree. The interesting states are the
 * disagreements, and `stale` is the one that earns its keep — the art exists,
 * but the prompt was edited after it was made. Nothing else in the workshop can
 * see that, and it is exactly how one frame ends up not matching the film.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import {
  ASSET_SECTIONS,
  assetReferencesOf,
  type AssetOrigin,
  type AssetSection,
} from '../../shared/scenario/load.ts';
import type { Scenario } from '../../shared/scenario/schema.ts';
import { asksForBackground } from './prompt.ts';
import { SECTION_DIRECTIONS, expandDirection } from './direction.ts';
import { defaultSizeFor, formatSize, isPortrait, parseSize, readImageInfo } from './size.ts';
import { readDuration } from './duration.ts';
import { extensionOf, misnamed, readFormat, renamedTo } from './format.ts';
import { DEFAULT_GAP, holdMatches, targetHoldFor } from './timing.ts';
import {
  fromProject,
  NARRATION_VOICE,
  recipeHash,
  resolveRecipe,
  takesDir,
  type AssetRow,
  type Ledger,
  type Project,
  type ProjectPaths,
  type SectionModel,
  type Take,
} from './project.ts';

export const ASSET_STATUSES = ['missing', 'unselected', 'unmanaged', 'stale', 'ready'] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

export type TakeView = Take & {
  /** Present in the takes folder but not in the ledger — dropped in by hand. */
  untracked?: boolean;
  /** In the ledger but gone from disk. */
  orphaned?: boolean;
};

export type AssetView = {
  file: string;
  section: AssetSection;
  status: AssetStatus;
  /** Hash of the recipe as it stands right now. */
  hash: string;
  /** True while a frozen asset is deliberately exempt from going stale. */
  frozen: boolean;
  hasPrompt: boolean;
  /**
   * This section's standing instruction, with this row's own facts filled in.
   *
   * The sentence that goes in front of the brief when somebody copies it — the
   * size, the format and whether it is a cutout, resolved here so the board
   * never has to work out what a model should be told. Absent for voice, which
   * has no standing instruction and no brief to put one in front of.
   */
  direction?: string;
  row: AssetRow;
  /** Every place in the scenario that asks for this file. */
  origins: AssetOrigin[];
  /**
   * What this picture is supposed to be, what it suggests if nothing says, and
   * what the selected take on disk actually is.
   *
   * The third one is the point. Art is made in another program and dropped into
   * the takes folder, and that program opens on 1024×1024 because every web UI
   * does. Dropped into a 16:9 show it is letterboxed or cropped through the
   * subject, and nothing else on this board would ever mention it.
   */
  size?: {
    declared?: string;
    suggested?: string;
    /** Read from the selected take's header. Absent for video and for audio. */
    actual?: string;
    /** True when the file on disk is not the size the row asked for. */
    mismatched?: boolean;
    /** True for a portrait, which the display draws as a cutout over the scene. */
    cutout?: boolean;
    /** True when a portrait's file is in a format with no alpha channel to have. */
    flat?: boolean;
  };
  /**
   * What the file on disk really is, against what its name claims.
   *
   * A name is a promise the show relies on: the display asks for the name in
   * `scenario.yaml` and the server picks a content type out of its extension,
   * so PNG bytes called `.jpg` go out labelled `image/jpeg`. Browsers sniff
   * images and get away with it; a `.wav` served as `audio/mpeg` is a silent
   * beat in front of a room. Absent when the format could not be read, which
   * must never produce a complaint — sending somebody to rename a file that was
   * already right is worse than saying nothing.
   */
  format?: {
    /** The format the bytes are, said the way a person would say it. */
    actual: string;
    /** The extension the name currently claims. */
    declared: string;
    /** The name it should have. Present only when the two disagree. */
    rename?: string;
  };
  takes: TakeView[];
  selected?: string;
  /** The file exists at its canonical name in the publish folder. */
  published: boolean;
  /**
   * The take that file was copied from, as recorded when it was published.
   *
   * Absent for a file published before the ledger tracked it, or dropped into
   * the publish folder by hand — which is why `republish` below is only ever
   * claimed when there is a recorded take to disagree with.
   */
  publishedTake?: string;
  /**
   * How long the selected take runs, in seconds.
   *
   * The show never opens an audio file — a beat ends when `hold` says it does
   * — so this is the only place the two facts are ever in the same room.
   * Absent when the format could not be read, which must never produce a
   * warning: sending somebody to re-cut a line that was already right is
   * worse than not telling them.
   */
  seconds?: number;
  /**
   * The `hold` the scenario declares for the line this clip reads.
   *
   * Alongside `seconds` rather than instead of it: either number on its own is
   * trivia, and the pair is the only check there is that a reading fits the
   * beat it was written for.
   */
  hold?: number;
  /**
   * Seconds of room after the clip, from the row or the one-second default.
   *
   * Always present on a measurable voice clip, so the board never has to
   * decide what the default is a second time.
   */
  gap?: number;
  /**
   * What `hold` should be: the clip plus the gap, at one decimal.
   *
   * The pair of this and `hold` is the whole timing check, and having the
   * server compute it means the button that writes it and the row that
   * displays it can never disagree about the arithmetic.
   */
  targetHold?: number;
  /** True when the declared beat already matches. */
  timed?: boolean;
  /**
   * A take that already matches the current recipe but is not the one chosen.
   *
   * Generating deliberately never steals a selection, so a regenerated clip
   * leaves the asset reporting `stale` with the answer already sitting in its
   * own takes folder. Without this the board says re-generate, which makes
   * another one.
   */
  matchingTake?: string;
  /**
   * The audience would hear the selected take if this shipped, and does not.
   *
   * The gap `ready` never covered: a take can match its recipe perfectly and
   * still have been chosen after the last publish, leaving the show playing
   * the previous reading with nothing on the board saying so.
   */
  republish?: boolean;
  /**
   * Warnings about this specific asset, phrased for the row it sits on.
   * A voiced line with no `hold` is the one that matters: nothing on the
   * server opens the clip, so the beat ends when the estimate says it does.
   */
  notes: string[];
};

export type SectionView = {
  section: AssetSection;
  model?: SectionModel;
  /**
   * The standing instruction in front of every brief here, with the default
   * already applied.
   *
   * Resolved server-side so the board never holds a second copy of what a
   * section says when nobody has said anything — a default that lived in the
   * page would be the one that fell behind, and the author would be reading a
   * sentence no test had ever seen. Absent for a section that has no default,
   * which is voice and only voice.
   */
  direction?: string;
  assets: AssetView[];
  counts: Record<AssetStatus, number>;
};

/**
 * A character, and everything needed to give them a voice.
 *
 * The cast comes from the scenario — it is the list of people who speak, and
 * nothing else gets to invent one — joined to the voice settings in
 * `project.yaml`. A character with lines and no reference clip is the state
 * this view exists to make impossible to miss: a cloning model with nothing to
 * clone gives every one of them the same default voice, and it does it
 * silently.
 */
export type CastMember = {
  id: string;
  name: string;
  /** Voice clips in the scenario attributed to them. */
  lines: number;
  /** Of those, how many are ready to play. */
  ready: number;
  reference?: string;
  /** False when `reference` names a file that is not there. */
  referenceExists: boolean;
  /** The model voice cast in this part, for a model that has a palette. */
  preset?: string;
  direction?: string;
  notes?: string;
};

export type OverviewProblem = { level: 'error' | 'warning'; message: string };

/**
 * Disk belonging to an asset the scenario has stopped asking for.
 *
 * Removing a line of dialogue takes its row off the board, which is the whole
 * point of a board built from the scenario — but it does not take the clip out
 * of `assets/` or the six takes out of `generated/`. Those keep playing nothing
 * for as long as the project exists: they are not on the board, so nothing ever
 * mentions them again, and the only way to find them was to compare two folder
 * listings by hand.
 *
 * Deliberately separate from an orphaned *recipe*. A recipe row is an afternoon
 * of tuning and throwing it away is a real loss; this is bytes, and the two do
 * not have to be dealt with at the same time — pruning the row leaves the files
 * exactly here, which is the case that started this.
 */
export type Stray = {
  section: AssetSection;
  /** The published name it had, e.g. `voice/beau-d2-01.mp3`. */
  file: string;
  /** The shipped file is still sitting in the publish folder. */
  published: boolean;
  /** How many take files are still in its generated folder. */
  takes: number;
  /** What the two come to, so the list can say what removing them buys. */
  bytes: number;
};

export type Overview = {
  sections: SectionView[];
  /** Who speaks, and what their voice is set to. Empty when nobody does. */
  cast: CastMember[];
  /**
   * Rows in project.yaml that the scenario no longer references. Generated art
   * nothing plays is wasted GPU time, and a long list of it hides real gaps.
   */
  orphans: string[];
  /**
   * Files left behind by assets the story dropped. See `Stray`.
   *
   * On the overview rather than computed by the command centre, for the same
   * reason everything else there is: one walk, one answer. A second opinion
   * about what is rubbish would be a second opinion nobody could see.
   */
  strays: Stray[];
  counts: Record<AssetStatus, number>;
  problems: OverviewProblem[];
};

function emptyCounts(): Record<AssetStatus, number> {
  return { missing: 0, unselected: 0, unmanaged: 0, stale: 0, ready: 0 };
}

async function fileExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/**
 * Takes as they really are: the ledger's list, reconciled against the folder.
 *
 * Files dropped in by hand are picked up as `untracked` rather than ignored, so
 * the select-and-publish half of the workshop is usable before a single model
 * is installed — you can put art in the folder and pick it.
 */
async function scanTakes(dir: string, recorded: Take[]): Promise<TakeView[]> {
  let present: string[];
  try {
    present = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    present = [];
  }

  const byId = new Map(recorded.map((take) => [take.id, take]));
  const views: TakeView[] = [];

  for (const take of recorded) {
    views.push(present.includes(take.id) ? take : { ...take, orphaned: true });
  }
  for (const name of present.sort()) {
    if (byId.has(name)) continue;
    views.push({
      id: name,
      hash: 'untracked',
      at: '',
      params: {},
      untracked: true,
    });
  }

  return views;
}

function statusOf(
  view: Omit<AssetView, 'status'>,
  selectedTake: TakeView | undefined,
): AssetStatus {
  const usable = view.takes.filter((take) => !take.orphaned);
  if (usable.length === 0) return view.published ? 'unmanaged' : 'missing';
  if (!selectedTake || selectedTake.orphaned) return 'unselected';
  if (selectedTake.untracked) return 'unmanaged';
  // A frozen asset is one everything downstream was matched to. Re-rolling it
  // is the thing freezing exists to prevent, so reporting it stale would be
  // telling the author to do the one thing they have forbidden.
  if (view.frozen) return 'ready';
  return selectedTake.hash === view.hash ? 'ready' : 'stale';
}

/** The beat length the scenario declares for a voice clip's line. */
function holdOf(
  scenario: Scenario,
  section: AssetSection,
  origins: AssetOrigin[],
): number | undefined {
  if (section !== 'voice') return undefined;
  for (const origin of origins) {
    if (origin.kind !== 'voice') continue;
    const node = scenario.nodes.find((n) => n.id === origin.node);
    if (node?.type !== 'dialogue') continue;
    const hold = node.lines[origin.line]?.hold;
    if (hold !== undefined) return hold;
  }
  return undefined;
}
/**
 * Per-row warnings derived from the scenario itself.
 *
 * Read straight from the parsed scenario rather than by matching the checker's
 * prose, so a reworded warning cannot quietly stop appearing on the board.
 *
 * Timing is deliberately not here any more. A beat that disagrees with its clip
 * is a specific job with a button that does it, and it belongs in the group
 * that does it — left as a note it was one line of prose among twenty others,
 * with nothing to press.
 */
function notesFor(
  scenario: Scenario,
  section: AssetSection,
  origins: AssetOrigin[],
): string[] {
  if (section !== 'voice') return [];
  const notes: string[] = [];

  for (const origin of origins) {
    if (origin.kind !== 'voice') continue;
    const node = scenario.nodes.find((n) => n.id === origin.node);
    if (node?.type !== 'dialogue') continue;
    if (node.lines[origin.line]?.hold === undefined) {
      notes.push(
        `${origin.node} line ${origin.line + 1} has no hold — the beat will end on a ` +
          `reading-speed estimate, not on this clip's real length`,
      );
    }
  }

  return notes;
}

/**
 * What the row asks for, against what is on the disk.
 *
 * Measured from the *selected* take rather than the published file: selecting
 * is the moment somebody decides a picture is the one, and being told then that
 * it is the wrong shape is worth far more than being told after it ships.
 */
async function sizeReport(
  paths: ProjectPaths,
  section: AssetSection,
  file: string,
  row: AssetRow | undefined,
  origins: AssetOrigin[],
  selected: string | undefined,
): Promise<AssetView['size']> {
  const suggested = defaultSizeFor(section, origins);
  if (!suggested && !row?.size) return undefined;

  const declared = parseSize(row?.size);
  const report: NonNullable<AssetView['size']> = {
    ...(row?.size ? { declared: row.size } : {}),
    ...(suggested ? { suggested: formatSize(suggested) } : {}),
  };

  // A portrait is a cutout, and the file has to be able to hold one. Stated
  // whether or not anything has been made yet: this is what the author needs to
  // know *before* they go and draw it, not after.
  if (isPortrait(origins)) report.cutout = true;

  // Only stills. A clip's dimensions live several nested atoms deep in its
  // container, and reporting a correct one as the wrong shape would send an
  // author off to re-render something that was already right.
  if (section !== 'images' || !selected) return report;

  const actual = await readImageInfo(join(takesDir(paths, section, file), selected));
  if (!actual) return report;

  report.actual = formatSize(actual);
  if (declared && (declared.width !== actual.width || declared.height !== actual.height)) {
    report.mismatched = true;
  }
  // `undefined` is "this reader could not tell", which is not a fault to report.
  if (report.cutout && actual.alpha === false) report.flat = true;
  return report;
}

/**
 * The speaking cast, joined to its voice settings.
 *
 * Built from the voice rows rather than from `scenario.characters`, because a
 * character can exist without ever speaking — a name on a nameplate in one
 * scene — and offering to record a reference clip for them is offering work
 * that will never be used. A voice named by a row but absent from the cast
 * list is still included: that is a typo, and hiding it would hide the reason
 * a line will not generate.
 */
async function buildCast(
  scenario: Scenario,
  project: Project,
  paths: ProjectPaths,
  voices: AssetView[],
): Promise<CastMember[]> {
  const counted = new Map<string, { lines: number; ready: number }>();
  for (const asset of voices) {
    const who = asset.row.voice;
    if (!who) continue;
    const tally = counted.get(who) ?? { lines: 0, ready: 0 };
    tally.lines += 1;
    if (asset.status === 'ready') tally.ready += 1;
    counted.set(who, tally);
  }

  // Configured but silent voices still appear, so a reference clip set for a
  // character whose lines were all cut is visible rather than mysterious.
  for (const id of Object.keys(project.voices)) {
    if (!counted.has(id)) counted.set(id, { lines: 0, ready: 0 });
  }

  const cast: CastMember[] = [];
  for (const [id, tally] of [...counted].sort(([a], [b]) => a.localeCompare(b))) {
    const voice = project.voices[id];
    const reference = voice?.reference;
    cast.push({
      id,
      // Not a character, so `characters` has no name for it. Saying so beats a
      // row labelled `vo` that an author has to work out from its line count.
      name:
        scenario.characters[id]?.name ??
        (id === NARRATION_VOICE ? 'Narration — no nameplate' : id),
      lines: tally.lines,
      ready: tally.ready,
      reference,
      preset: voice?.preset,
      referenceExists: reference
        ? await fileExists(fromProject(paths.dir, reference))
        : false,
      direction: voice?.direction,
      notes: voice?.notes,
    });
  }
  return cast;
}

/**
 * Every asset name the scenario already asks for, by section.
 *
 * What the Nodes tab offers when somebody clicks into a `background:` box. It
 * is the same `assetReferencesOf` walk the board is built from and not a
 * second one, which is the point: an editor that offered a name the board did
 * not know about would be offering a file nothing will ever generate, and the
 * author would find out in front of a projector.
 *
 * Reuse is the common case and the reason this exists at all — a scene is a
 * place with several shots in it, so the second shot wants the still the first
 * one used, exactly, character for character. Typing it again is how a show
 * ends up with `images/jetty-wide.png` and `images/jetty_wide.png`, one of them
 * on the board and one of them a 404.
 */
export function declaredAssets(scenario: Scenario): Record<AssetSection, string[]> {
  const found = new Map<AssetSection, Set<string>>();
  for (const ref of assetReferencesOf(scenario)) {
    let names = found.get(ref.section);
    if (!names) found.set(ref.section, (names = new Set()));
    names.add(ref.file);
  }
  return Object.fromEntries(
    ASSET_SECTIONS.map((section) => [section, [...(found.get(section) ?? [])].sort()]),
  ) as Record<AssetSection, string[]>;
}

/** Every file under a folder, as posix-ish paths relative to it. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    found.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return found;
}

/**
 * What is on disk for assets nothing references any more.
 *
 * Two folders, and they are found two different ways because only one of them
 * still knows what an asset was called. `generated/<section>/<name>/` carries
 * the section in its own path, so a directory nothing claims is a stray and
 * its section is where it is sitting. The publish folder carries the same
 * thing in the *name* — but only for a project that has been filed by media
 * type, and that is the whole rule here: a file directly in the publish root
 * is left alone, because once the scenario stops naming a file the folder it
 * was filed into is the last record of what kind of thing it is, and a root
 * that also holds a README, a licence or somebody's notes is not a place to
 * guess from.
 *
 * The names come back from the ledger and the recipe rows where either still
 * remembers one, because `generated/voice/beau_d2_01.mp3/` is a mangled
 * directory and `voice/beau-d2-01.mp3` is a line somebody can recognise.
 */
async function findStrays(
  paths: ProjectPaths,
  project: Project,
  ledger: Ledger,
  referenced: Set<string>,
): Promise<Stray[]> {
  const strays = new Map<string, Stray>();
  const note = (section: AssetSection, file: string): Stray => {
    const existing = strays.get(file);
    if (existing) return existing;
    const fresh: Stray = { section, file, published: false, takes: 0, bytes: 0 };
    strays.set(file, fresh);
    return fresh;
  };

  // Names the project still remembers, so a mangled takes directory can be
  // reported as the asset it belonged to rather than as a path.
  const known = [...new Set([...Object.keys(project.assets), ...Object.keys(ledger.assets)])];

  for (const section of ASSET_SECTIONS) {
    // What a live asset's takes folder is called, so everything else in there
    // is not one. Built from the same `takesDir` the generator writes with —
    // a second opinion about that name would delete takes that are in use.
    const claimed = new Set(
      [...referenced].map((file) => basename(takesDir(paths, section, file))),
    );

    let dirs: string[];
    try {
      dirs = (await readdir(join(paths.generated, section), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      dirs = [];
    }

    for (const dir of dirs) {
      if (claimed.has(dir)) continue;
      const name =
        known.find((file) => basename(takesDir(paths, section, file)) === dir) ??
        `${section}/${dir}`;
      const entry = note(section, name);
      for (const take of await listFiles(join(paths.generated, section, dir))) {
        const info = await stat(join(paths.generated, section, dir, take)).catch(() => null);
        entry.takes += 1;
        entry.bytes += info?.size ?? 0;
      }
    }
  }

  const sections = new Set<string>(ASSET_SECTIONS);
  for (const file of await listFiles(paths.publish)) {
    if (referenced.has(file)) continue;
    const [folder] = file.split('/');
    if (!folder || !sections.has(folder)) continue;
    const entry = note(folder as AssetSection, file);
    entry.published = true;
    const info = await stat(join(paths.publish, file)).catch(() => null);
    entry.bytes += info?.size ?? 0;
  }

  return [...strays.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export async function buildOverview(
  scenario: Scenario,
  project: Project,
  ledger: Ledger,
  paths: ProjectPaths,
): Promise<Overview> {
  const references = assetReferencesOf(scenario);

  // Group by file first: one bed can be the ambience of three scenes, and the
  // author needs to make it once, not see it three times.
  const grouped = new Map<string, { section: AssetSection; origins: AssetOrigin[] }>();
  const problems: OverviewProblem[] = [];

  for (const ref of references) {
    const existing = grouped.get(ref.file);
    if (!existing) {
      grouped.set(ref.file, { section: ref.section, origins: [ref.origin] });
      continue;
    }
    existing.origins.push(ref.origin);
    if (existing.section !== ref.section) {
      // Two different schema fields claim the same file. Whichever section it
      // is filed under, one of the two uses will be generated wrong.
      problems.push({
        level: 'error',
        message:
          `"${ref.file}" is referenced as both ${existing.section} and ${ref.section}. ` +
          `Give them separate filenames — they are different work.`,
      });
    }
  }

  const sections: SectionView[] = [];
  const totals = emptyCounts();

  for (const section of ASSET_SECTIONS) {
    const model = project.sections[section];
    // The author's, or the default, or nothing at all for voice. Undefined is
    // what tells the board not to draw the box, so a section that has never
    // needed one does not grow an empty control.
    const direction = model?.direction ?? SECTION_DIRECTIONS[section];
    const assets: AssetView[] = [];
    const counts = emptyCounts();

    const files = [...grouped.entries()]
      .filter(([, info]) => info.section === section)
      .map(([file]) => file)
      .sort();

    for (const file of files) {
      const info = grouped.get(file)!;
      const row = project.assets[file];
      const portrait = isPortrait(info.origins);
      const recipe = resolveRecipe(project, section, file, { portrait });
      const hash = recipeHash(recipe);

      const entry = ledger.assets[file];
      const takes = await scanTakes(takesDir(paths, section, file), entry?.takes ?? []);
      const selected = entry?.selected;
      const selectedTake = takes.find((take) => take.id === selected);

      // Measured from the selected take, like the size is: selecting is the
      // moment somebody decides a reading is the one, and being told then that
      // it overruns its beat is worth far more than being told after it ships.
      // Falls back to the published file for an asset that has no take, which
      // is the only thing a hand-dropped clip could be measured from.
      const audible = section === 'voice' || section === 'sfx' || section === 'ambience' || section === 'music';
      // The selected take where there is one, the published file otherwise —
      // the same order the runtime and the size use, because selecting is the
      // moment somebody decides a file is the one and that is when being told
      // about it is worth most.
      const onHand = selected ? join(takesDir(paths, section, file), selected) : join(paths.publish, file);
      const measurable = audible ? onHand : undefined;
      const seconds = measurable ? await readDuration(measurable) : undefined;

      // Judged against the *asset's* name, not the take's. The take's filename
      // is the pipeline's own business; the asset's is what the show opens and
      // what a content type is picked from, so it is the one that has to be
      // true. A take called `photo.jpg` holding PNG bytes publishes to a name
      // that is now correct, and renaming it would be churn nothing reads.
      const real = await readFormat(onHand);
      const format = real
        ? {
            actual: real.kind,
            declared: extensionOf(file),
            ...(misnamed(file, real) ? { rename: renamedTo(file, real) } : {}),
          }
        : undefined;

      const hold = holdOf(scenario, section, info.origins);
      const notes = notesFor(scenario, section, info.origins);
      // Only for a clip that was actually measured. A beat cannot be checked
      // against a runtime nobody could read, and guessing produces a board that
      // sends people to re-cut lines that were already right.
      const gap = section === 'voice' && seconds !== undefined ? (row?.gap ?? DEFAULT_GAP) : undefined;
      const targetHold = gap !== undefined && seconds !== undefined
        ? targetHoldFor(seconds, gap)
        : undefined;
      const size = await sizeReport(paths, section, file, row, info.origins, entry?.selected);
      // Generating never steals a selection, which is what keeps re-rolling
      // free — but it means a freshly regenerated clip sits there matching the
      // recipe perfectly while the board still reports the old one as stale.
      // Nothing said a newer reading was waiting, so the fix looked like
      // generating it again.
      const fresh = takes.find(
        (take) => !take.orphaned && take.hash === hash && take.id !== selected,
      );

      // Two ways of knowing the shipped file is not the chosen take, and the
      // second one exists because the first cannot see far enough back.
      //
      // The ledger is exact when it has a record. Where it does not — every
      // file published before it started keeping one — the files themselves
      // still disagree: a published clip of a different size than the selected
      // take is certainly not that take. Without this, choosing a newer reading
      // of an already-shipped line moved it to `ready` and asked for nothing,
      // while the room went on hearing the old one.
      //
      // Matching sizes are taken as the same file rather than hashed. Two
      // different readings of one line landing on the same byte count is a
      // coincidence; re-reading ninety published files on every board build to
      // rule it out is a cost paid every time.
      const publishedPath = join(paths.publish, file);
      const shipped = await stat(publishedPath).catch(() => null);
      const onDisk = shipped !== null;

      let republish = false;
      if (onDisk && selected) {
        if (entry?.published) {
          republish = entry.published !== selected;
        } else {
          const take = await stat(join(takesDir(paths, section, file), selected)).catch(() => null);
          republish = take !== null && take.size !== shipped.size;
        }
      }

      const base: Omit<AssetView, 'status'> = {
        file,
        section,
        hash,
        frozen: row?.freeze ?? false,
        hasPrompt: Boolean(row?.prompt?.trim() || row?.text?.trim()),
        row: row ?? ({ params: {}, freeze: false } as AssetRow),
        origins: info.origins,
        ...(size ? { size } : {}),
        ...(format ? { format } : {}),
        takes,
        selected,
        published: onDisk,
        ...(entry?.published ? { publishedTake: entry.published } : {}),
        ...(republish ? { republish: true } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(hold !== undefined ? { hold } : {}),
        ...(gap !== undefined ? { gap } : {}),
        ...(targetHold !== undefined ? { targetHold } : {}),
        ...(targetHold !== undefined && holdMatches(hold, targetHold) ? { timed: true } : {}),
        ...(fresh ? { matchingTake: fresh.id } : {}),
        // Resolved per row rather than per section, because the tokens in it
        // are answered by the row: a portrait's `$size` is 832x1216 where the
        // still beside it is 1920x1080, and `$cutout` has something to say on
        // one of the two. That is the whole reason the section box holds a
        // template instead of the numbers typed out.
        ...(direction
          ? {
              direction: expandDirection(direction, {
                file,
                ...(size?.declared ?? size?.suggested
                  ? { size: size?.declared ?? size?.suggested }
                  : {}),
                ...(size?.cutout ? { cutout: true } : {}),
              }),
            }
          : {}),
        notes,
      };

      const status = statusOf(base, selectedTake);
      counts[status] += 1;
      totals[status] += 1;
      assets.push({ ...base, status });
    }

    sections.push({ section, model, ...(direction ? { direction } : {}), assets, counts });
  }

  const voices = sections.find((view) => view.section === 'voice')?.assets ?? [];
  const cast = await buildCast(scenario, project, paths, voices);

  for (const member of cast) {
    if (member.reference && !member.referenceExists) {
      problems.push({
        level: 'warning',
        message:
          `"${member.id}" points at a reference clip that is not there: ${member.reference}`,
      });
    }
  }

  for (const view of sections) {
    for (const asset of view.assets) {
      if (asset.size?.mismatched) {
        problems.push({
          level: 'warning',
          message:
            `"${asset.file}" is ${asset.size.actual} but the row asks for ${asset.size.declared}. ` +
            `On a 1920×1080 stage that is letterboxed or cropped through the subject.`,
        });
      }
      if (asset.size?.flat) {
        problems.push({
          level: 'warning',
          message:
            `"${asset.file}" has no transparency. A portrait is drawn over the scene with a ` +
            `shadow following its outline, so a filled background arrives as a bust card. ` +
            `Matte it out and save it as a PNG.`,
        });
      }
      // The storyboard writes a character sheet as a *reference* image, and a
      // reference wants a neutral field behind it. The same file is what floats
      // over the harbour. Reported rather than reworded, because a machine that
      // rewrites prose to keep it true eventually rewrites prose that was fine.
      if (asset.size?.cutout && asksForBackground(asset.row.prompt ?? '')) {
        problems.push({
          level: 'warning',
          message:
            `"${asset.file}" is a portrait but its brief asks for a background. ` +
            `A portrait has to be a cutout — the display draws it with a shadow that ` +
            `follows its outline — so a background is the thing that has to go.`,
        });
      }
    }
  }

  const orphans = Object.keys(project.assets)
    .filter((file) => !grouped.has(file))
    .sort();

  const strays = await findStrays(paths, project, ledger, new Set(grouped.keys()));

  for (const file of orphans) {
    problems.push({
      level: 'warning',
      message: `"${file}" has a recipe but nothing in the scenario references it`,
    });
  }

  return { sections, cast, orphans, strays, counts: totals, problems };
}
