/**
 * Wiring `voice:` onto the lines of a scenario.
 *
 * This is step one of the pipeline and it belongs in the editor, not in a
 * script somebody runs once. A file cannot be generated, tracked, or given a
 * prompt until the scenario declares it — the scenario is the manifest — so
 * "give every spoken line a clip" is an authoring action, and a scenario with
 * ninety-two lines is not one anybody is going to type out by hand.
 *
 * Two things make this harder than writing YAML:
 *
 * The file is the author's. It is full of comments recording why a beat is the
 * length it is, and of folded block scalars hand-wrapped to a column. Parsing
 * to an object and re-serialising reflows every one of those, which buries the
 * change under a hundred lines of rewrapped prose. So edits are computed from
 * the parsed document's source offsets and applied to the text — insertions
 * only, nothing else on the page moves.
 *
 * And a voiced line without a `hold:` is a narrator cut off mid-sentence in
 * front of a room, because nothing on the server opens the audio file. So a
 * clip and a hold are wired together, never separately.
 */

import { parseDocument, isMap, isSeq } from 'yaml';
import { lineDuration, type Scenario } from '../../shared/scenario/schema.ts';
import { filed, shotForNode, shotSlug, shotsByNode, type StoryboardShot } from './storyboard.ts';
import { NARRATION_VOICE } from './project.ts';
import { applyEdits, indentOf, insertionFor, type Edit } from './yaml-edit.ts';

export type WiredLine = {
  node: string;
  /** Index within the node's `lines`, as the asset board reports it. */
  line: number;
  file: string;
  hold: number;
  /** True when the line already had a clip and only the hold was missing. */
  heldOnly?: boolean;
};

export type WireResult = {
  source: string;
  wired: WiredLine[];
  /** Lines that already had both, and were left exactly as they were. */
  untouched: number;
};

/**
 * `a1_jetty` -> `a1`, the shot it plays, so a clip's name says where it belongs.
 *
 * The storyboard's own convention, taken from its engine-mapping section:
 * `tran-d5-01.mp3` is Tran's first line in Shot D.5. A node that maps to no
 * shot falls back to its own id, which is longer but never ambiguous — and
 * naming is the one place guessing is safe, because the scenario is about to
 * declare whatever name comes out of here.
 */
function slugFor(nodeId: string, shots: StoryboardShot[]): string {
  const shot = shotForNode(shotsByNode(shots), nodeId);
  return shot ? shotSlug(shot.id) : nodeId.replaceAll('_', '-');
}

/**
 * The highest `-NN` already used for each speaker-and-shot pair.
 *
 * Read from the scenario rather than counted as we go, so wiring a half-wired
 * scenario continues the numbering instead of colliding with it. Running this
 * twice must be a no-op, which is the difference between a button and a script.
 */
function usedNumbers(scenario: Scenario): Map<string, number> {
  const used = new Map<string, number>();
  for (const node of scenario.nodes) {
    if (node.type !== 'dialogue') continue;
    for (const line of node.lines) {
      if (!line.voice) continue;
      // By basename, so a half-wired scenario continues its numbering whether
      // its clips are filed under `voice/` or sitting flat beside the scenario.
      const match = /^(.*)-(\d+)\.[a-z0-9]+$/i.exec(line.voice.split('/').pop()!);
      if (!match) continue;
      const key = match[1]!;
      const n = Number(match[2]);
      if (n > (used.get(key) ?? 0)) used.set(key, n);
    }
  }
  return used;
}

/**
 * Adds `voice:` and the `hold:` it requires to every spoken line that lacks
 * them, returning the new source rather than writing it.
 *
 * Pure so the caller can validate the result before it touches the author's
 * file: a scenario that would not load is not written.
 */
export function wireVoiceInto(
  source: string,
  scenario: Scenario,
  shots: StoryboardShot[],
): WireResult {
  const doc = parseDocument(source);
  const nodes = doc.get('nodes');
  if (!isSeq(nodes)) return { source, wired: [], untouched: 0 };

  const used = usedNumbers(scenario);
  const wired: WiredLine[] = [];
  const edits: Edit[] = [];
  let untouched = 0;

  for (const node of scenario.nodes) {
    if (node.type !== 'dialogue') continue;

    const item = nodes.items.find(
      (candidate) => isMap(candidate) && candidate.get('id') === node.id,
    );
    if (!isMap(item)) continue;
    const lines = item.get('lines');
    if (!isSeq(lines)) continue;

    const slug = slugFor(node.id, shots);

    node.lines.forEach((line, index) => {
      const map = lines.items[index];
      if (!isMap(map)) return;
      if (line.voice && line.hold !== undefined) {
        untouched += 1;
        return;
      }

      const { at, flow } = insertionFor(source, map);
      const indent = flow ? '' : indentOf(source, map.range?.[0] ?? at);
      const parts: string[] = [];

      const hold = line.hold ?? Math.ceil(lineDuration(line, scenario.settings));
      if (line.hold === undefined) parts.push(`hold: ${hold}`);

      let file = line.voice;
      if (!file) {
        // An unattributed line is narration with no nameplate, and `vo` says
        // that rather than pretending it belongs to the narrator character.
        const key = `${line.who ?? NARRATION_VOICE}-${slug}`;
        const n = (used.get(key) ?? 0) + 1;
        used.set(key, n);
        file = filed('voice', `${key}-${String(n).padStart(2, '0')}.mp3`);
        parts.push(`voice: ${file}`);
      }

      edits.push({
        at,
        text: flow
          ? parts.map((part) => `, ${part}`).join('')
          : parts.map((part) => `\n${indent}${part}`).join(''),
      });
      wired.push({
        node: node.id,
        line: index,
        file,
        hold,
        ...(line.voice ? { heldOnly: true } : {}),
      });
    });
  }

  return { source: applyEdits(source, edits), wired, untouched };
}
