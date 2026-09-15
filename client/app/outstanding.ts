/**
 * Everything still to do, in one list, ordered by what blocks a show first.
 *
 * The board is organised the way the work is *made* — by section, by
 * character, by row — which is right when you are making it and useless when
 * you are trying to find out whether you are finished. That answer was spread
 * across six collapsed sections, a cast panel and a problems strip, and the
 * only way to get it was to open all of them and hold the total in your head.
 *
 * So this is the other view of the same thing, and it is deliberately *only* a
 * view: every item is derived from the `Overview` the board already built, and
 * nothing here reads the disk, the ledger or the scenario on its own. A second
 * walk would eventually disagree with the board about what is finished, and
 * the disagreement would be silent — both would look like a full list.
 *
 * The ordering is the running order of the pipeline, so working top-down is
 * working in the order the work actually has to happen: make it, choose it,
 * ship it. When every group is empty the show is ready, and that is the whole
 * contract — anything that can leave the project unfinished has to appear
 * here, or the emptiness is a lie.
 */

import type { AssetSection } from '../../shared/scenario/load.ts';
import type { AssetView, Overview } from './sections.ts';

export const OUTSTANDING_GROUPS = [
  'missing',
  'unselected',
  'reselect',
  'stale',
  'republish',
  'publish',
  'unmanaged',
  'cast',
  'timing',
  'misnamed',
  'quality',
  'orphan',
  'discard',
] as const;

export type OutstandingGroup = (typeof OUTSTANDING_GROUPS)[number];

/**
 * What the one button on a group does, in the vocabulary the board already
 * uses. `open` means there is nothing to press — the fix is an edit somebody
 * has to make — and the item is a link to where they make it.
 */
export type OutstandingAction =
  | 'generate'
  | 'use-newest'
  | 'publish'
  | 'adopt'
  | 'prune'
  | 'discard'
  | 'retime'
  | 'retype'
  | 'open';

export type OutstandingItem = {
  group: OutstandingGroup;
  section?: AssetSection;
  file?: string;
  character?: string;
  /** What to show on the line. A filename, or a character's name. */
  label: string;
  /** Why it is here, when the group heading does not already say it. */
  detail?: string;
  /**
   * The three numbers a timing row is edited with.
   *
   * Carried on the item rather than looked up from the board by the client:
   * the list is what the author is reading, and a gap box that had to find its
   * own row first is a gap box that shows the wrong number the moment the two
   * fall a render apart.
   */
  seconds?: number;
  hold?: number;
  gap?: number;
  target?: number;
};

export type OutstandingSection = {
  group: OutstandingGroup;
  label: string;
  hint: string;
  level: 'error' | 'warning' | 'todo';
  action?: OutstandingAction;
  items: OutstandingItem[];
};

export type Outstanding = {
  groups: OutstandingSection[];
  total: number;
};

type GroupSpec = {
  label: string;
  hint: string;
  level: 'error' | 'warning' | 'todo';
  action?: OutstandingAction;
};

const SPECS: Record<OutstandingGroup, GroupSpec> = {
  missing: {
    label: 'Not made yet',
    hint: 'The scenario asks for these and there is no take on disk. The show renders a gradient where they should be.',
    level: 'error',
    action: 'generate',
  },
  unselected: {
    label: 'Waiting on a choice',
    hint: 'Takes exist and none is picked. Nothing publishes until one is.',
    level: 'error',
    action: 'use-newest',
  },
  reselect: {
    label: 'Regenerated, waiting to be chosen',
    hint:
      'A take matching the current recipe is already in the takes folder — generating never ' +
      'steals a selection, so it is sitting there unchosen. Choosing it is all that is left.',
    level: 'error',
    action: 'use-newest',
  },
  stale: {
    label: 'Recipe changed since it was made',
    hint: 'The prompt, the size, the voice or the line itself moved after this take was generated. It no longer matches what the project asks for.',
    level: 'warning',
    action: 'generate',
  },
  republish: {
    label: 'A newer take was chosen',
    hint: 'The published file came from a different take than the one selected now — the audience would still hear the older one.',
    level: 'error',
    action: 'publish',
  },
  publish: {
    label: 'Chosen but never published',
    hint: 'A take is selected and nothing has copied it to the name the player opens.',
    level: 'error',
    action: 'publish',
  },
  unmanaged: {
    label: 'Not reproducible',
    hint:
      'A file is in place and nothing on record says which recipe it answers, so the board ' +
      'cannot tell whether it still matches the prompt. Adopting records it against the ' +
      'recipe as it stands — after that, editing the prompt marks it stale like anything ' +
      'else. It is the normal ending for art made in another program.',
    level: 'todo',
    action: 'adopt',
  },
  cast: {
    label: 'Parts without a voice',
    hint: 'A cloning model with nothing to clone gives every character the same default voice, and it does it silently.',
    level: 'error',
    action: 'open',
  },
  timing: {
    label: 'Beats that do not match their clip',
    hint:
      'Nothing on the server opens an audio file — a beat ends when `hold` says it does. ' +
      'Setting one writes it straight into scenario.yaml. The gap after each clip is a ' +
      'second unless the row says otherwise.',
    level: 'error',
    action: 'retime',
  },
  misnamed: {
    label: 'Named as the wrong kind of file',
    hint:
      'The extension claims one format and the bytes are another. The display asks for the ' +
      'name the scenario declares and the server picks a content type out of it, so a PNG ' +
      'called .jpg is served as image/jpeg — which browsers forgive and audio players do ' +
      'not. Correcting one renames it everywhere: the scenario, the recipe, the takes ' +
      'folder and the published file.',
    level: 'warning',
    action: 'retype',
  },
  quality: {
    label: 'Made, but not right',
    hint: 'These play. They are the wrong shape, the wrong format, or timed off an estimate rather than the clip.',
    level: 'warning',
    action: 'open',
  },
  orphan: {
    label: 'Recipes the story dropped',
    hint: 'The scenario no longer references these, so nothing will ever play them. Removing one throws its prompt away, which is why it is never automatic.',
    level: 'todo',
    action: 'prune',
  },
  discard: {
    label: 'Files nothing plays any more',
    hint:
      'Cutting a line takes its row off the board and leaves its clip in assets/ and its ' +
      'takes in generated/. Nothing mentions them again, so they stay for the life of the ' +
      'project. Removing one deletes the published file and every take of it — the recipe ' +
      'above is a separate thing and stays where it is.',
    level: 'todo',
    action: 'discard',
  },
};

/** Size for a list, not for an audit — one decimal is as precise as it needs. */
function megabytes(bytes: number): string {
  return bytes < 100_000 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** A row's per-asset quality complaints, phrased for a one-line list. */
function qualityOf(asset: AssetView): string[] {
  const found: string[] = [];

  if (asset.size?.mismatched && asset.size.actual && asset.size.declared) {
    found.push(`is ${asset.size.actual} but the row asks for ${asset.size.declared}`);
  }
  if (asset.size?.cutout && asset.size.flat) {
    found.push('is a portrait with no transparency, so it arrives as a bust card');
  }
  if (asset.composed?.unresolved?.length) {
    found.push(
      `prompt refers to ${asset.composed.unresolved.map((name) => `${name}.`).join(' ')} which nothing defines`,
    );
  }
  // Row notes are already written as sentences about this row — the missing
  // `hold` on a voiced line being the one that changes what an audience sees.
  for (const note of asset.notes) found.push(note);

  return found;
}

/**
 * Projects the board into a single ordered list of what is left.
 *
 * Every asset lands in at most one of the first six groups, because they are
 * stages of one pipeline rather than independent complaints — a file that was
 * never made is not also waiting to be published, and listing it twice would
 * make the total meaningless as a measure of how much is left. Quality is the
 * exception and is additive: a clip can be finished, shipped, and still the
 * wrong shape.
 */
export function outstandingOf(overview: Overview): Outstanding {
  const items: Record<OutstandingGroup, OutstandingItem[]> = {
    missing: [],
    unselected: [],
    reselect: [],
    stale: [],
    republish: [],
    publish: [],
    unmanaged: [],
    cast: [],
    timing: [],
    misnamed: [],
    quality: [],
    orphan: [],
    discard: [],
  };

  for (const view of overview.sections) {
    for (const asset of view.assets) {
      const where = { section: asset.section, file: asset.file, label: asset.file };

      // The pipeline stages, first unmet one wins.
      if (asset.status === 'missing') {
        items.missing.push({ group: 'missing', ...where });
      } else if (asset.status === 'unselected') {
        items.unselected.push({
          group: 'unselected',
          ...where,
          detail: `${asset.takes.length} take${asset.takes.length === 1 ? '' : 's'} to choose from`,
        });
      } else if (asset.status === 'stale' && asset.matchingTake) {
        // Ahead of `stale`, because the two ask for opposite things: this one
        // needs a click, and telling somebody to regenerate it makes a third
        // take of a line that already has the right one.
        items.reselect.push({
          group: 'reselect',
          ...where,
          detail: `${asset.matchingTake} matches the recipe`,
        });
      } else if (asset.status === 'stale') {
        items.stale.push({ group: 'stale', ...where });
      } else if (asset.status === 'unmanaged') {
        items.unmanaged.push({ group: 'unmanaged', ...where });
      } else if (asset.republish) {
        items.republish.push({
          group: 'republish',
          ...where,
          detail: `published ${asset.publishedTake}, selected ${asset.selected}`,
        });
      } else if (!asset.published) {
        items.publish.push({ group: 'publish', ...where });
      }

      // Additive, like quality: a clip can be made, chosen, published and
      // still play in a beat that is the wrong length for it.
      if (asset.targetHold !== undefined && !asset.timed) {
        const spare = asset.hold === undefined ? undefined : asset.hold - (asset.seconds ?? 0);
        items.timing.push({
          group: 'timing',
          ...where,
          detail:
            asset.hold === undefined
              ? `no hold — should be ${asset.targetHold}s`
              : spare !== undefined && spare < 0
                ? `holds ${asset.hold}s for a ${asset.seconds!.toFixed(1)}s clip, cutting it off — should be ${asset.targetHold}s`
                : `holds ${asset.hold}s, should be ${asset.targetHold}s`,
          seconds: asset.seconds,
          hold: asset.hold,
          gap: asset.gap,
          target: asset.targetHold,
        });
      }

      // Additive, like quality and timing: a picture can be made, chosen,
      // published, the right shape, and still called something it is not.
      if (asset.format?.rename) {
        items.misnamed.push({
          group: 'misnamed',
          ...where,
          detail: `is ${asset.format.actual} but named .${asset.format.declared} — rename to ${asset.format.rename}`,
        });
      }

      for (const detail of qualityOf(asset)) {
        items.quality.push({ group: 'quality', ...where, detail });
      }
    }
  }

  for (const member of overview.cast) {
    if (member.lines === 0) continue;
    if (!member.reference) {
      items.cast.push({
        group: 'cast',
        character: member.id,
        label: member.name,
        detail: `${member.lines} line${member.lines === 1 ? '' : 's'} and no reference clip`,
      });
    } else if (!member.referenceExists) {
      items.cast.push({
        group: 'cast',
        character: member.id,
        label: member.name,
        detail: `reference clip is not on disk: ${member.reference}`,
      });
    }
  }

  for (const file of overview.orphans) {
    items.orphan.push({ group: 'orphan', file, label: file });
  }

  // Deliberately alongside `orphan` rather than folded into it. The same asset
  // can be in both, in either one alone, or in neither: pruning a recipe leaves
  // the files, and deleting the files leaves the prompt — which is the point of
  // keeping them apart, because one of the two is recoverable work.
  for (const stray of overview.strays) {
    const parts = [];
    if (stray.published) parts.push('the published file');
    if (stray.takes > 0) parts.push(`${stray.takes} take${stray.takes === 1 ? '' : 's'}`);
    items.discard.push({
      group: 'discard',
      section: stray.section,
      file: stray.file,
      label: stray.file,
      detail: `${parts.join(' and ')} · ${megabytes(stray.bytes)}`,
    });
  }

  const groups: OutstandingSection[] = [];
  let total = 0;
  for (const group of OUTSTANDING_GROUPS) {
    if (items[group].length === 0) continue;
    groups.push({ group, ...SPECS[group], items: items[group] });
    total += items[group].length;
  }

  return { groups, total };
}
