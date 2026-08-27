/**
 * Filing a scenario's assets by media type.
 *
 * A finished show is a few hundred files. Flat, that is a folder where finding
 * the bed for act two means reading ninety voice clips first, and where the
 * only thing telling you what `a4-flank.mp4` is is its extension. Sorted, it is
 * `assets/voice/`, `assets/images/`, `assets/music/` — the same six sections the
 * board already groups the work into, because the section an asset belongs to is
 * a fact the scenario already carries.
 *
 * The folder goes **into the name the scenario declares**, rather than being a
 * layout rule the display works out for itself. That is the difference between
 * an author being able to read `scenario.yaml` and know where a file is, and a
 * convention living in three programs that will eventually disagree — and it
 * keeps flat scenarios working untouched, which matters because every scenario
 * written before this was one.
 *
 * Like every other action here, it edits by source offset so the author's
 * comments and hand-wrapped scalars survive, and running it twice does nothing.
 */

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import {
  assetReferencesOf,
  type AssetOrigin,
  type AssetSection,
} from '../../src/scenario/load.ts';
import type { Scenario } from '../../src/scenario/schema.ts';
import { applyEdits, type Edit } from './yaml-edit.ts';

export type FolderMove = { from: string; to: string; section: AssetSection };

export type FolderSort = {
  source: string;
  moved: FolderMove[];
  /** Already in a folder, and left exactly where the author put them. */
  kept: string[];
  /** Names this cannot file without guessing. Reported rather than guessed at. */
  skipped: { file: string; why: string }[];
};

/**
 * Where in the YAML document a reference was written.
 *
 * Derived from the origin `assetReferencesOf` reports rather than found by a
 * second walk of the scenario. Two walks would eventually disagree about what
 * counts as an asset, and the one that disagreed silently would be this one —
 * renaming five of a scene's six files and leaving the sixth pointing at a
 * name nothing publishes to.
 */
function pathFor(origin: AssetOrigin, nodeAt: Map<string, number>): (string | number)[] | undefined {
  if (origin.kind === 'sprite') return ['characters', origin.character, 'sprite'];
  if ('scene' in origin) return ['scenes', origin.scene, origin.kind];

  const index = nodeAt.get(origin.node);
  if (index === undefined) return undefined;
  if (origin.kind === 'voice' || origin.kind === 'sfx') {
    return ['nodes', index, 'lines', origin.line, origin.kind];
  }
  return ['nodes', index, origin.kind];
}

/** Node id to its position in the document's `nodes:` sequence. */
function nodeIndex(doc: ReturnType<typeof parseDocument>): Map<string, number> {
  const at = new Map<string, number>();
  const nodes = doc.get('nodes');
  if (!isSeq(nodes)) return at;
  nodes.items.forEach((item, index) => {
    if (!isMap(item)) return;
    const id = item.get('id');
    if (typeof id === 'string') at.set(id, index);
  });
  return at;
}

/**
 * Rewrites every flat asset reference as `<section>/<name>`.
 *
 * Pure: the caller validates the result before it goes anywhere near the
 * author's file, and has to move the files on disk to match. A scenario that
 * points at names nothing has published to is a show of missing art, so the
 * two halves are never done separately.
 */
export function sortIntoFolders(source: string, scenario: Scenario): FolderSort {
  const doc = parseDocument(source);
  const nodeAt = nodeIndex(doc);
  const references = assetReferencesOf(scenario);

  // One file can be referenced from six places. It moves once, and every
  // reference to it has to follow — a half-renamed asset is worse than a flat
  // one, because the board reports it ready and one scene of the show is black.
  const sections = new Map<string, Set<AssetSection>>();
  for (const ref of references) {
    let claims = sections.get(ref.file);
    if (!claims) sections.set(ref.file, (claims = new Set()));
    claims.add(ref.section);
  }

  const taken = new Set(references.map((ref) => ref.file));
  const moved: FolderMove[] = [];
  const kept: string[] = [];
  const skipped: { file: string; why: string }[] = [];
  const decided = new Map<string, string>();

  for (const file of [...sections.keys()].sort()) {
    const claims = sections.get(file)!;
    if (file.includes('/')) {
      kept.push(file);
      continue;
    }
    if (claims.size > 1) {
      // Two schema fields want the same file as two different kinds of work.
      // That is already an error on the board; filing it would only pick a
      // winner quietly.
      skipped.push({
        file,
        why: `referenced as both ${[...claims].join(' and ')} — give them separate names first`,
      });
      continue;
    }

    const section = [...claims][0]!;
    const to = `${section}/${file}`;
    if (taken.has(to)) {
      skipped.push({ file, why: `${to} is already a different asset in this scenario` });
      continue;
    }
    decided.set(file, to);
    moved.push({ from: file, to, section });
  }

  return { source: renameReferences(source, scenario, decided), moved, kept, skipped };
}

/**
 * Rewrites every reference to a renamed asset, wherever the scenario names it.
 *
 * Shared, because filing by media type is not the only reason a name changes —
 * correcting an extension that lies about what the file is renames the same
 * asset in the same places, and a second walk of the document would eventually
 * disagree with this one about where an asset can be named. The one that
 * disagreed would rename five of a scene's six references and leave the sixth
 * pointing at a name nothing publishes to.
 *
 * Pure. The caller validates the result and moves the files to match; a
 * scenario pointing at names nothing has moved to is a show of missing art.
 */
export function renameReferences(
  source: string,
  scenario: Scenario,
  decided: Map<string, string>,
): string {
  if (decided.size === 0) return source;
  const doc = parseDocument(source);
  const nodeAt = nodeIndex(doc);

  const edits: Edit[] = [];
  for (const ref of assetReferencesOf(scenario)) {
    const to = decided.get(ref.file);
    if (to === undefined) continue;
    const path = pathFor(ref.origin, nodeAt);
    if (!path) continue;
    const scalar = doc.getIn(path, true);
    // Belt and braces: the value found at that path has to be the name we came
    // here to change. Anything else means the origin and the document have
    // drifted, and rewriting bytes on a guess is how a scenario gets corrupted.
    if (!isScalar(scalar) || scalar.value !== ref.file) continue;
    const [start, end] = scalar.range ?? [];
    if (start === undefined || end === undefined) continue;
    edits.push({ at: start, end, text: to });
  }

  return applyEdits(source, edits);
}

/**
 * The same rename, applied to the `assets:` keys of `project.yaml`.
 *
 * A key edit rather than a document rewrite, for the usual reason: a row can
 * hold an afternoon of prompt tuning and a comment saying why, and both live in
 * the bytes around the key rather than in the parsed value.
 */
export function renameRows(
  source: string,
  // Not `FolderMove[]`: a portrait re-pointed to a PNG is a rename with no
  // change of section, and it needs exactly this.
  moves: { from: string; to: string; section?: AssetSection }[],
): string {
  const doc = parseDocument(source);
  const assets = doc.get('assets');
  if (!isMap(assets)) return source;

  const to = new Map(moves.map((move) => [move.from, move.to]));
  const edits: Edit[] = [];

  for (const item of assets.items) {
    if (!isScalar(item.key)) continue;
    const renamed = to.get(String(item.key.value));
    if (renamed === undefined) continue;
    const [start, end] = item.key.range ?? [];
    if (start === undefined || end === undefined) continue;
    edits.push({ at: start, end, text: renamed });
  }

  return applyEdits(source, edits);
}
