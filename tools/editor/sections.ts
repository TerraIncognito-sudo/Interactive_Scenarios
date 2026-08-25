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
import {
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
  takes: TakeView[];
  selected?: string;
  /** The file exists at its canonical name in the publish folder. */
  published: boolean;
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

export type OverviewProblem = { level: 'error' | 'warning'; message: string };

export type Overview = {
  sections: SectionView[];
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

/**
 * Per-row warnings derived from the scenario itself.
 *
 * Read straight from the parsed scenario rather than by matching the checker's
 * prose, so a reworded warning cannot quietly stop appearing on the board.
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
      const hash = recipeHash(resolveRecipe(project, section, file));
      const entry = ledger.assets[file];
      const takes = await scanTakes(takesDir(paths, section, file), entry?.takes ?? []);
      const selected = entry?.selected;
      const selectedTake = takes.find((take) => take.id === selected);

      const notes = notesFor(scenario, section, info.origins);

      const base: Omit<AssetView, 'status'> = {
        file,
        section,
        hash,
        frozen: row?.freeze ?? false,
        hasPrompt: Boolean(row?.prompt?.trim() || row?.text?.trim()),
        row: row ?? ({ refs: [], params: {}, freeze: false } as AssetRow),
        origins: info.origins,
        takes,
        selected,
        published: await fileExists(join(paths.publish, file)),
        notes,
      };

      const status = statusOf(base, selectedTake);
      counts[status] += 1;
      totals[status] += 1;
      assets.push({ ...base, status });
    }

    sections.push({ section, model, assets, counts });
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

  return { sections, orphans, counts: totals, problems };
}
