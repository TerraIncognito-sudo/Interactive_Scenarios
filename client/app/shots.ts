/**
 * Giving every shot its own picture.
 *
 * A storyboard has far more shots than places: `transit` is three shots of the
 * same ocean, `control_cell` is seven beats in one room. Until a node could
 * carry its own `background:`, only the first shot in each place had anywhere
 * to put its still, and the rest of the prompts — real work, already written —
 * sat on the asset board reported as unplaceable.
 *
 * Authors worked around it the only way the schema allowed, by giving a second
 * camera setup its own scene: `halifax_flank`, `control_cell_checks`. That
 * costs more than duplication. `music:` and `ambience:` hang off the scene and
 * are re-triggered when the scene id changes, so a "scene" that is really a
 * second angle restarts the room's sound halfway through a beat.
 *
 * So this migration does two things at once, because they are the same thing:
 * it moves those stand-in scenes' nodes back into the place the storyboard
 * named and hangs their pictures on the nodes instead, and it gives every
 * other storyboarded shot a picture of its own. What stays on the scene is the
 * establishing shot — the first beat played there, which is what the scene's
 * still has always depicted.
 *
 * It is a button rather than a script because a project that needed a script
 * run over it once is a project the next author finds half-migrated. Running
 * it twice is a no-op: a node that already states its own media is never
 * rewritten, and a node already in the place the storyboard names is already
 * where it belongs.
 */

import { parseDocument, isMap, isSeq, isScalar, type YAMLMap } from 'yaml';
import type { Scenario } from '../../shared/scenario/schema.ts';
import { shotForNode, shotMediaName, shotsByNode, type StoryboardShot } from './storyboard.ts';
import {
  applyEdits,
  indentOf,
  insertionAfter,
  insertionFor,
  pairFor,
  spanOfEntry,
  type Edit,
} from './yaml-edit.ts';

export type ShotMove = {
  node: string;
  /** The storyboard shot this node plays, e.g. `B.2`. */
  shot: string;
  background?: string;
  video?: string;
  /** Set when the node also moved back into the place the storyboard names. */
  scene?: { from: string; to: string };
};

export type ShotMigration = {
  source: string;
  moved: ShotMove[];
  /** Stand-in scenes that existed only to carry a second picture. */
  folded: { scene: string; into: string; nodes: string[] }[];
  /** What it declined to touch, and why, so nothing fails silently. */
  skipped: { what: string; why: string }[];
  /**
   * Comments left naming a scene that is now gone.
   *
   * Reported rather than rewritten. The prose in a scenario is the author's —
   * several comments in a real one record why a beat is the length it is — and
   * a machine that edits prose to keep it true will eventually edit prose that
   * was already true. Pointing at the line is the honest half of the job.
   */
  stale: { line: number; text: string }[];
  /** Nodes that already carried their own picture, left exactly as they were. */
  untouched: number;
};

function empty(source: string): ShotMigration {
  return { source, moved: [], folded: [], skipped: [], stale: [], untouched: 0 };
}

/**
 * Comment lines describing a scene layout the migration has just changed.
 *
 * Two cases, because a note about a stand-in scene is written either way: one
 * that names the scene outright, and one that gestures at it — "the siblings
 * below exist purely to carry a second camera setup" names nothing at all and
 * is no less wrong once the siblings are gone. So every comment inside the
 * `scenes:` block counts while a fold is happening, which over-reports a
 * little and under-reports never.
 */
function staleComments(source: string, gone: string[]): ShotMigration['stale'] {
  if (gone.length === 0) return [];

  // The block runs from just after the `scenes:` key to the end of its last
  // entry, so a note written under the key and above the first scene — the
  // usual place for one — falls inside it.
  const pair = pairFor(parseDocument(source).contents as YAMLMap, 'scenes');
  const from = isScalar(pair?.key) ? (pair.key.range?.[2] ?? -1) : -1;
  const to = (pair?.value as { range?: [number, number, number] } | undefined)?.range?.[1] ?? -1;

  const found: ShotMigration['stale'] = [];
  let offset = 0;
  let line = 0;
  for (const text of source.split('\n')) {
    const at = offset;
    offset += text.length + 1;
    line += 1;
    const hash = text.indexOf('#');
    if (hash < 0) continue;
    const inBlock = from >= 0 && at >= from && at < to;
    if (inBlock || gone.some((scene) => text.slice(hash).includes(scene))) {
      found.push({ line, text: text.trim() });
    }
  }
  return found;
}

/**
 * Decides which of a scene's nodes owns the scene's own picture.
 *
 * The first beat played there that the storyboard describes: a scene's still
 * is its establishing shot, and always was. This is the rule the asset board
 * already uses to attribute a scene's background to a shot, and the two must
 * not diverge — a second rule would eventually hand the prompt to a node whose
 * picture nothing paints.
 */
function establishingNodes(
  scenario: Scenario,
  shotOf: Map<string, StoryboardShot>,
): Map<string, string> {
  const first = new Map<string, string>();
  const fallback = new Map<string, string>();
  for (const node of scenario.nodes) {
    if (!node.scene) continue;
    if (!fallback.has(node.scene)) fallback.set(node.scene, node.id);
    if (shotOf.has(node.id) && !first.has(node.scene)) first.set(node.scene, node.id);
  }
  for (const [scene, id] of fallback) if (!first.has(scene)) first.set(scene, id);
  return first;
}

/**
 * Stand-in scenes: the ones whose every node the storyboard places elsewhere.
 *
 * Deliberately conservative. A scene is only folded when the storyboard is
 * unanimous about where its nodes belong, the destination already exists, and
 * the two agree on `music:` and `ambience:` — because those are the whole
 * reason this matters. Folding a scene whose sound differs would change what
 * the audience hears, which is not a migration but a rewrite.
 */
function planFolds(
  scenario: Scenario,
  shotOf: Map<string, StoryboardShot>,
  skipped: ShotMigration['skipped'],
): Map<string, string> {
  const members = new Map<string, string[]>();
  for (const node of scenario.nodes) {
    if (!node.scene) continue;
    const seen = members.get(node.scene);
    if (seen) seen.push(node.id);
    else members.set(node.scene, [node.id]);
  }

  const folds = new Map<string, string>();
  for (const [id, scene] of Object.entries(scenario.scenes)) {
    const nodes = members.get(id) ?? [];
    if (nodes.length === 0) continue;

    const wanted = new Set<string>();
    let complete = true;
    for (const nodeId of nodes) {
      const place = shotOf.get(nodeId)?.scene;
      if (!place) {
        complete = false;
        break;
      }
      wanted.add(place);
    }
    if (!complete || wanted.size !== 1) continue;

    const target = [...wanted][0]!;
    if (target === id) continue;

    const into = scenario.scenes[target];
    if (!into) {
      skipped.push({
        what: `scene "${id}"`,
        why: `the storyboard plays its shots in "${target}", which this scenario has no scene for`,
      });
      continue;
    }
    if (scene.music !== into.music || scene.ambience !== into.ambience) {
      skipped.push({
        what: `scene "${id}"`,
        why:
          `it carries different music or ambience from "${target}", so folding it ` +
          `would change what the audience hears`,
      });
      continue;
    }
    folds.set(id, target);
  }
  return folds;
}

/**
 * Rewrites a scenario so each storyboarded shot paints its own still and clip,
 * returning the new source rather than writing it.
 *
 * Pure, so the caller can load the result before it touches the author's file.
 */
export function migrateShotsInto(
  source: string,
  scenario: Scenario,
  shots: StoryboardShot[],
): ShotMigration {
  const doc = parseDocument(source);
  const nodesSeq = doc.get('nodes');
  const scenesMap = doc.get('scenes');
  if (!isSeq(nodesSeq)) return empty(source);

  const index = shotsByNode(shots);
  const shotOf = new Map<string, StoryboardShot>();
  for (const node of scenario.nodes) {
    const shot = shotForNode(index, node.id);
    if (shot) shotOf.set(node.id, shot);
  }

  const skipped: ShotMigration['skipped'] = [];
  const folds = planFolds(scenario, shotOf, skipped);
  const establishing = establishingNodes(scenario, shotOf);

  const moved: ShotMove[] = [];
  const edits: Edit[] = [];
  const foldedNodes = new Map<string, string[]>();
  let untouched = 0;

  for (const node of scenario.nodes) {
    const shot = shotOf.get(node.id);
    if (!shot || !node.scene) continue;

    const standIn = folds.get(node.scene);
    const owns = node.background !== undefined || node.video !== undefined;

    // The scene's own picture is this node's picture; there is nothing to move.
    if (!standIn && establishing.get(node.scene) === node.id) continue;
    if (owns && !standIn) {
      untouched += 1;
      continue;
    }

    const item = nodesSeq.items.find(
      (candidate) => isMap(candidate) && candidate.get('id') === node.id,
    );
    if (!isMap(item)) continue;

    const move: ShotMove = { node: node.id, shot: shot.id };

    if (standIn) {
      const pair = pairFor(item, 'scene');
      if (pair && isScalar(pair.value) && pair.value.range) {
        edits.push({ at: pair.value.range[0], end: pair.value.range[1], text: standIn });
        move.scene = { from: node.scene, to: standIn };
        const list = foldedNodes.get(node.scene);
        if (list) list.push(node.id);
        else foldedNodes.set(node.scene, [node.id]);
      }
    }

    if (owns) {
      untouched += 1;
    } else {
      // A folded node keeps the exact filenames its stand-in scene declared.
      // Renaming them would orphan every prompt already written against them,
      // and this has no business touching the author's prompts.
      const from = standIn ? scenario.scenes[node.scene] : undefined;
      const background =
        from?.background ?? (shot.image ? shotMediaName(shot, 'images', 'jpg') : undefined);
      const video = from?.video ?? (shot.motion ? shotMediaName(shot, 'video', 'mp4') : undefined);
      if (background !== undefined) move.background = background;
      if (video !== undefined) move.video = video;

      const parts: string[] = [];
      if (background !== undefined) parts.push(`background: ${background}`);
      if (video !== undefined) parts.push(`video: ${video}`);

      if (parts.length > 0) {
        // Beside `scene:`, where it reads as what it is — this shot's picture,
        // in that place. The end of the map is the fallback, for a node that
        // states no scene of its own and inherits one from the beat before.
        const spot = insertionAfter(source, item, 'scene') ?? insertionFor(source, item);
        const indent = spot.flow ? '' : indentOf(source, item.range?.[0] ?? spot.at);
        edits.push({
          at: spot.at,
          text: spot.flow
            ? parts.map((part) => `, ${part}`).join('')
            : parts.map((part) => `\n${indent}${part}`).join(''),
        });
      }
    }

    if (move.scene || move.background || move.video) moved.push(move);
  }

  // A stand-in scene is removed only once every node it held has moved off it.
  // A half-emptied one would leave the scenario pointing at a background that
  // no longer exists, which is a broken show rather than an unfinished edit.
  const folded: ShotMigration['folded'] = [];
  if (isMap(scenesMap)) {
    for (const [id, into] of folds) {
      const nodes = foldedNodes.get(id) ?? [];
      const held = scenario.nodes.filter((node) => node.scene === id).length;
      if (nodes.length !== held) {
        skipped.push({
          what: `scene "${id}"`,
          why: 'not every node in it could be moved, so it was left in place',
        });
        continue;
      }
      const pair = pairFor(scenesMap, id);
      const span = pair ? spanOfEntry(source, scenesMap, pair) : undefined;
      if (!span) continue;
      edits.push(span);
      folded.push({ scene: id, into, nodes });
    }
  }

  const out = applyEdits(source, edits);
  return {
    source: out,
    moved,
    folded,
    skipped,
    stale: staleComments(
      out,
      folded.map((entry) => entry.scene),
    ),
    untouched,
  };
}
