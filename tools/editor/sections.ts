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
import { join } from 'node:path';
import {
  ASSET_SECTIONS,
  assetReferencesOf,
  type AssetOrigin,
  type AssetSection,
} from '../../src/scenario/load.ts';
import type { Scenario } from '../../src/scenario/schema.ts';
import { asksForBackground, composePrompt } from './prompt.ts';
import { defaultSizeFor, formatSize, isPortrait, parseSize, readImageInfo } from './size.ts';
import { readDuration } from './duration.ts';
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
  row: AssetRow;
  /** Every place in the scenario that asks for this file. */
  origins: AssetOrigin[];
  /**
   * What a generator would actually be handed: the row's prompt with the
   * storyboard's named blocks put back in, and the negative that goes with it.
   *
   * On the board rather than only inside the generator because a prompt nobody
   * can read is a prompt nobody can fix. Every complaint about the art this
   * pipeline produces starts with not being able to see what the model was
   * given — and the row shows `STYLE. SHIP. Pre-dawn at a jetty…`, which is not
   * what any model would receive.
   */
  composed?: { positive: string; negative: string; unresolved: string[] };
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

export type Overview = {
  sections: SectionView[];
  /** Who speaks, and what their voice is set to. Empty when nobody does. */
  cast: CastMember[];
  /**
   * Rows in project.yaml that the scenario no longer references. Generated art
   * nothing plays is wasted GPU time, and a long list of it hides real gaps.
   */
  orphans: string[];
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
      const measurable = audible
        ? selected
          ? join(takesDir(paths, section, file), selected)
          : join(paths.publish, file)
        : undefined;
      const seconds = measurable ? await readDuration(measurable) : undefined;

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
      // Voice has no prompt in this sense — its text is the line — and running
      // a composer over it would offer to expand words in the dialogue.
      const composed = section === 'voice' ? undefined : composePrompt(recipe);

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
        row: row ?? ({ refs: [], params: {}, freeze: false } as AssetRow),
        origins: info.origins,
        ...(composed ? { composed } : {}),
        ...(size ? { size } : {}),
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
        notes,
      };

      const status = statusOf(base, selectedTake);
      counts[status] += 1;
      totals[status] += 1;
      assets.push({ ...base, status });
    }

    sections.push({ section, model, assets, counts });
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

  // A prompt still carrying a name nothing defines reaches the model with
  // `SHIP.` in it, which it reads as a word. The picture comes back without the
  // ship, and nothing else on this board would ever mention it.
  const undefinedTokens = new Map<string, string[]>();
  for (const view of sections) {
    for (const asset of view.assets) {
      for (const name of asset.composed?.unresolved ?? []) {
        const files = undefinedTokens.get(name);
        if (files) files.push(asset.file);
        else undefinedTokens.set(name, [asset.file]);
      }
    }
  }
  for (const [name, files] of [...undefinedTokens].sort(([a], [b]) => a.localeCompare(b))) {
    problems.push({
      level: 'warning',
      message:
        `${files.length} prompt${files.length === 1 ? '' : 's'} refer to "${name}", which ` +
        `nothing defines — the model will read it as a word. Add it under \`tokens:\`, or ` +
        `re-seed from the storyboard if it states one.`,
    });
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
      // over the harbour. Reported rather than reworded: the composed prompt is
      // already asking for the cutout, and two instructions pulling opposite
      // ways is a picture nobody can predict.
      if (asset.size?.cutout && asksForBackground(asset.row.prompt ?? '')) {
        problems.push({
          level: 'warning',
          message:
            `"${asset.file}" is a portrait but its prompt asks for a background. ` +
            `It is composed as a cutout regardless — drop the phrase so the two agree.`,
        });
      }
    }
  }

  const orphans = Object.keys(project.assets)
    .filter((file) => !grouped.has(file))
    .sort();

  for (const file of orphans) {
    problems.push({
      level: 'warning',
      message: `"${file}" has a recipe but nothing in the scenario references it`,
    });
  }

  return { sections, cast, orphans, counts: totals, problems };
}
