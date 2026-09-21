/**
 * Setting each beat to the length of the clip that plays in it.
 *
 * Nothing on the server opens an audio file. A beat ends when `hold` says it
 * does, so the two numbers have to be put in agreement by hand — and until now
 * that meant reading a runtime off the board, doing the addition, and typing
 * it into `scenario.yaml`, eighty times, without transposing any of them.
 *
 * The rule is one number: a clip is followed by a gap, and the beat is the two
 * added together. A second is the default because the last word of a line
 * needs somewhere to land — a beat that ends the instant the audio does sounds
 * clipped even when it is technically complete. Where a second is wrong, the
 * gap is a per-clip field: a beat before a poll wants to breathe, and a
 * three-word interruption wants to land on top of what follows.
 *
 * One decimal place throughout. Clip runtimes are real numbers and rounding a
 * beat to the whole second below it is how a line gets cut off by a rounding
 * decision nobody made.
 */

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Scenario } from '../../shared/scenario/schema.ts';
import { applyEdits, indentOf, insertionAfter, insertionFor, pairFor, type Edit } from './yaml-edit.ts';

/** Seconds of room after the words stop, where a clip says nothing else. */
export const DEFAULT_GAP = 1;

/** Beats are compared and written at this precision, never more. */
export function round1(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}

/** What a line's `hold` should be for the clip that plays in it. */
export function targetHoldFor(seconds: number, gap: number = DEFAULT_GAP): number {
  return round1(seconds + gap);
}

/**
 * Whether a declared beat already matches the clip.
 *
 * Compared at one decimal because that is the precision it is written at;
 * without the rounding, a hold of 5.8 and a target of 5.800000000000001 are a
 * mismatch that no edit can ever fix, and the board would ask for the same
 * change forever.
 */
export function holdMatches(hold: number | undefined, target: number): boolean {
  return hold !== undefined && round1(hold) === round1(target);
}

export type Retimed = {
  node: string;
  line: number;
  file: string;
  from?: number;
  to: number;
};

export type RetimeResult = {
  source: string;
  changed: Retimed[];
  /** Lines whose clip could not be measured, so nothing was written. */
  skipped: string[];
};

/**
 * Rewrites `hold:` on every line whose clip is in `wanted`.
 *
 * Pure, returning the new source rather than writing it, so the caller can
 * validate the result before it touches the author's file — the same rule
 * `wireVoiceInto` follows, for the same reason.
 *
 * By source offset rather than by re-serialising: a scenario is full of
 * hand-wrapped text and comments, several of them recording why a beat is the
 * length it is. Those comments become wrong when the number beside them
 * changes, and they are still not this function's to rewrite.
 */
export function retimeInto(
  source: string,
  scenario: Scenario,
  wanted: Map<string, number>,
): RetimeResult {
  const doc = parseDocument(source);
  const nodes = doc.get('nodes');
  if (!isSeq(nodes)) return { source, changed: [], skipped: [] };

  const changed: Retimed[] = [];
  const edits: Edit[] = [];
  const seen = new Set<string>();

  for (const node of scenario.nodes) {
    if (node.type !== 'dialogue') continue;

    const item = nodes.items.find(
      (candidate) => isMap(candidate) && candidate.get('id') === node.id,
    );
    if (!isMap(item)) continue;
    const lines = item.get('lines');
    if (!isSeq(lines)) continue;

    node.lines.forEach((line, index) => {
      if (!line.voice) return;
      const target = wanted.get(line.voice);
      if (target === undefined) return;

      const map = lines.items[index];
      if (!isMap(map)) return;
      // Recorded before the comparison: a beat that is already right was not
      // skipped, it was checked. Reporting it as skipped would send somebody
      // looking for a line that has nothing wrong with it.
      seen.add(line.voice);
      if (holdMatches(line.hold, target)) return;

      const pair = pairFor(map, 'hold');
      if (pair && isScalar(pair.value) && pair.value.range) {
        // Replace just the number. Anything sharing the line — a comment
        // explaining the beat — is left exactly where it is.
        edits.push({ at: pair.value.range[0], end: pair.value.range[1], text: String(target) });
      } else {
        // No hold written out at all. It goes beside `voice:` where one exists,
        // because the clip and the beat it plays in are one fact.
        const spot = insertionAfter(source, map, 'voice') ?? insertionFor(source, map);
        const indent = spot.flow ? '' : indentOf(source, map.range?.[0] ?? spot.at);
        edits.push({
          at: spot.at,
          text: spot.flow ? `, hold: ${target}` : `\n${indent}hold: ${target}`,
        });
      }

      changed.push({
        node: node.id,
        line: index,
        file: line.voice,
        ...(line.hold !== undefined ? { from: line.hold } : {}),
        to: target,
      });
    });
  }

  const skipped = [...wanted.keys()].filter((file) => !seen.has(file));
  return { source: applyEdits(source, edits), changed, skipped };
}
