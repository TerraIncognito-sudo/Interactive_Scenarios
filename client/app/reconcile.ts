/**
 * Keeping the recipes honest when the story changes underneath them.
 *
 * A row in `project.yaml` has two owners and they are not the same person.
 * Most of it is the author's: the prompt, the negative, the size, the tuning
 * parameters, weeks of it. But a few fields are not opinions at all — they are
 * copies of something the scenario already says, and the scenario is the only
 * thing allowed to be right about them.
 *
 * `text` is the one that matters. It is what a voice clip *says*, and it is
 * the scenario's line — the invariant is already written down. Seeding was
 * strictly additive, which is correct for a prompt and silently wrong for this:
 * edit a line of dialogue and the row keeps the words it was seeded with, the
 * recipe hash does not move, the board goes on saying `ready`, and the clip in
 * the show reads the sentence the author deleted. Nothing anywhere reports it.
 * The only way to notice is to listen to ninety clips.
 *
 * So the derived fields are re-derived on every scenario change, and because
 * `text` is in the recipe hash, correcting one marks exactly the clips whose
 * words moved as stale. That is the whole mechanism: the board stops lying,
 * and the re-record list writes itself.
 *
 * Pure, like `sprites.ts` and `shots.ts`: it returns a plan and touches no
 * disk. The caller owns the file.
 */

import { assetReferencesOf } from '../../shared/scenario/load.ts';
import type { Scenario } from '../../shared/scenario/schema.ts';
import type { Project } from './project.ts';
import { seedRowsFor, type StoryboardShot } from './storyboard.ts';

/**
 * The fields the scenario owns outright.
 *
 * Deliberately short. Every name added here is a field the author can no longer
 * hand-tune, so the bar is that the scenario is *definitionally* right about it
 * — `text` is the line being spoken, `voice` is who the scenario says speaks
 * it, and `source.node`/`source.line` are where in the story it sits. A prompt
 * is not on this list and must never be: two people can disagree about how a
 * shot should look, and only one of them has seen the film.
 */
export const DERIVED_PATHS: string[][] = [['text'], ['voice'], ['source', 'node'], ['source', 'line']];

export type RowUpdate = {
  file: string;
  /** Field path within the row, e.g. `['text']` or `['source', 'line']`. */
  path: string[];
  from?: unknown;
  to: unknown;
};

export type ReconcilePlan = {
  /** Assets the scenario now references that the project has no row for. */
  added: Record<string, Record<string, unknown>>;
  /** Derived fields on existing rows that have drifted from the scenario. */
  updates: RowUpdate[];
  /**
   * Rows the project holds that the scenario no longer asks for.
   *
   * Reported and never acted on. A row can hold an afternoon of tuning, and a
   * rename nobody meant to make is not a reason for a machine to spend it —
   * so removal stays a thing a person presses, with the list in front of them.
   */
  orphans: string[];
};

/** Reads a nested value out of a row without minding the holes. */
function at(row: Record<string, unknown> | undefined, path: string[]): unknown {
  let value: unknown = row;
  for (const key of path) {
    if (value === undefined || value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * What would have to change in `project.yaml` for it to agree with the story.
 *
 * The walk is `seedRowsFor` — the same one seeding uses, given the same
 * scenario. Two walks would eventually disagree about which line a clip
 * belongs to, and the disagreement would be invisible: both would look like
 * a full board. With no storyboard it still works, because everything derived
 * here comes from the scenario alone; the storyboard only ever contributed the
 * prompt, which is the author's half.
 */
export function planReconcile(
  scenario: Scenario,
  project: Project,
  shots: StoryboardShot[] = [],
  sheets: Record<string, string> = {},
): ReconcilePlan {
  const seeded = seedRowsFor(scenario, shots, sheets);

  const added: Record<string, Record<string, unknown>> = {};
  const updates: RowUpdate[] = [];

  for (const row of seeded.rows) {
    const current = project.assets[row.file] as Record<string, unknown> | undefined;

    if (!current) {
      // Never seen. Write the whole seeded row — including the author's half,
      // which starts as whatever the storyboard suggested and is theirs from
      // then on.
      const fresh: Record<string, unknown> = {};
      if (row.prompt) fresh.prompt = row.prompt;
      if (row.size) fresh.size = row.size;
      if (row.text) fresh.text = row.text;
      if (row.voice) fresh.voice = row.voice;
      const source: Record<string, unknown> = {};
      if (row.source.shot) source.shot = row.source.shot;
      if (row.source.node) source.node = row.source.node;
      if (row.source.line !== undefined) source.line = row.source.line;
      if (Object.keys(source).length > 0) fresh.source = source;
      added[row.file] = fresh;
      continue;
    }

    // The row exists, so only the derived fields are in play.
    const derived: Record<string, unknown> = {
      text: row.text,
      voice: row.voice,
      'source.node': row.source.node,
      'source.line': row.source.line,
    };

    for (const path of DERIVED_PATHS) {
      const want = derived[path.join('.')];
      if (want === undefined) continue;
      const have = at(current, path);
      if (have === want) continue;
      updates.push({ file: row.file, path, from: have, to: want });
    }
  }

  const referenced = new Set(assetReferencesOf(scenario).map((ref) => ref.file));
  const orphans = Object.keys(project.assets)
    .filter((file) => !referenced.has(file))
    .sort();

  return { added, updates, orphans };
}
