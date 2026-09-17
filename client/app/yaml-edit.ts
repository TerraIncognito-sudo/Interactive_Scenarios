/**
 * Editing a scenario by source offset instead of by re-serialising it.
 *
 * Every editor action that writes YAML the author also writes by hand goes
 * through here. Parsing a document to an object and stringifying it back
 * reflows every hand-wrapped folded scalar and drops every comment — and this
 * codebase's scenarios are full of both, including comments recording why a
 * beat is the length it is. The first time anyone clicked a button the diff
 * would be the whole file, and the actual change would be unreviewable.
 *
 * So actions compute offsets from the parsed document and splice text. What
 * they do not touch does not move.
 */

import { isScalar, type Pair, type YAMLMap } from 'yaml';

/** A slice of the source to replace. Omit `end` for a pure insertion. */
export type Edit = { at: number; end?: number; text: string };

/**
 * Applies edits back to front, so an earlier one cannot move a later offset.
 *
 * Overlapping edits are a bug in the caller rather than something to reconcile
 * here — two actions rewriting the same bytes have already disagreed about
 * what the file says.
 */
export function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.end ?? edit.at);
  }
  return out;
}

/** The column the map's keys start at, so an inserted key lines up with them. */
export function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return source.slice(lineStart, offset).replace(/\S/g, ' ');
}

/**
 * Where a new key goes in an existing map.
 *
 * Block maps take a fresh line after the last value; flow maps — `{ who: narr,
 * text: … }`, which is how a short line is often written — take a comma before
 * the brace. Both spellings are valid YAML and both appear in real scenarios,
 * so both have to be handled rather than normalised into one.
 */
export function insertionFor(source: string, map: YAMLMap): { at: number; flow: boolean } {
  const end = map.range?.[2] ?? map.range?.[1] ?? 0;
  if (map.flow) {
    const brace = source.lastIndexOf('}', end);
    // Back up over the whitespace inside the brace so `, voice: x }` reads the
    // way a person would have typed it.
    let at = brace;
    while (at > 0 && /\s/.test(source[at - 1]!)) at -= 1;
    return { at, flow: true };
  }

  // Trailing newlines belong to whatever comes next — a comment, a blank line
  // separating nodes — so the insert goes after the last real character.
  let at = end;
  while (at > 0 && /\s/.test(source[at - 1]!)) at -= 1;
  return { at, flow: false };
}

/** The pair for `key` in a block or flow map, if it has one written out. */
export function pairFor(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((item) => isScalar(item.key) && item.key.value === key) as
    | Pair
    | undefined;
}

/**
 * Where a new key goes when it wants to sit next to one that already exists.
 *
 * `background:` beside `scene:` reads as what it is — this shot's picture, in
 * that place — where the same key appended after `next:` reads as an
 * afterthought. Cosmetic, but the file is the author's to read.
 */
export function insertionAfter(
  source: string,
  map: YAMLMap,
  key: string,
): { at: number; flow: boolean } | undefined {
  const pair = pairFor(map, key);
  if (!pair || !isScalar(pair.value)) return undefined;
  const end = pair.value.range?.[1];
  if (end === undefined) return undefined;
  if (map.flow) return { at: end, flow: true };

  // Past anything else sharing the line — a trailing comment belongs to the key
  // it was written beside, not to the one being inserted under it.
  const newline = source.indexOf('\n', end);
  return { at: newline === -1 ? source.length : newline, flow: false };
}

/**
 * The source a map entry occupies, for removal.
 *
 * The one home for this measurement. Both spellings a real scenario uses have a
 * way of going wrong, and both went wrong before this was one function.
 *
 * A **flow** map needs the comma eaten as well, or `{ a: 1, b: 2 }` with `b`
 * removed becomes `{ a: 1, }` — legal YAML, and a diff that looks like damage.
 *
 * A **block** entry whose value spans lines cannot be measured by its own
 * range: a block sequence's range runs past its last item and into whatever
 * follows, so slicing by it deletes the top of the next key. That is the same
 * over-extension `itemSpans` exists to work around, and it is why removing a
 * dialogue's `lines:` would have taken `next:` with it and left the story
 * pointing nowhere. Indentation is what actually delimits a block value in
 * YAML, so that is what this measures, walking down from the key's own line.
 */
export function spanOfEntry(source: string, parent: YAMLMap, pair: Pair): Edit | undefined {
  const key = pair.key as { range?: [number, number, number] } | undefined;
  const value = pair.value as { range?: [number, number, number] } | undefined;
  const from = key?.range?.[0];
  const to = value?.range?.[1] ?? key?.range?.[1];
  if (from === undefined || to === undefined) return undefined;

  if (parent.flow) {
    let at = from;
    let end = to;
    // Prefer eating a preceding comma; fall back to a following one for the
    // first entry, which has none before it.
    const before = source.lastIndexOf(',', from);
    if (before > (parent.range?.[0] ?? 0)) at = before;
    else {
      const next = source.indexOf(',', to);
      const brace = source.indexOf('}', to);
      if (next !== -1 && (brace === -1 || next < brace)) end = next + 1;
    }
    return { at, end, text: '' };
  }

  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  const column = from - lineStart;
  const firstEnd = source.indexOf('\n', from);
  let end = firstEnd === -1 ? source.length : firstEnd + 1;
  const columnOf = (at: number) => /^[ \t]*/.exec(source.slice(at))![0].length;

  // A block sequence may write its dashes in the key's own column — legal YAML,
  // and it reads as belonging to the key rather than following it. Everything
  // else has to be indented past the key to be part of its value.
  let floor = column;
  for (let probe = end; probe < source.length; ) {
    const lineEnd = source.indexOf('\n', probe);
    const line = source.slice(probe, lineEnd === -1 ? source.length : lineEnd);
    if (line.trim() !== '') {
      if (columnOf(probe) === column && /^-(\s|$)/.test(line.trimStart())) floor = column - 1;
      break;
    }
    probe = lineEnd === -1 ? source.length : lineEnd + 1;
  }

  for (let cursor = end; cursor < source.length; ) {
    const lineEnd = source.indexOf('\n', cursor);
    const stop = lineEnd === -1 ? source.length : lineEnd + 1;
    const line = source.slice(cursor, lineEnd === -1 ? source.length : lineEnd);
    // A blank line belongs to nobody: it neither ends the value nor gets
    // swallowed by it, so only a line proved to be inside moves the end.
    if (line.trim() !== '') {
      if (columnOf(cursor) <= floor) break;
      end = stop;
    }
    cursor = stop;
  }
  return { at: lineStart, end, text: '' };
}
