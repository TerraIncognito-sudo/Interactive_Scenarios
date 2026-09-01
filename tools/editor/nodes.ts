/**
 * Editing the story's nodes as structure rather than as text.
 *
 * The Nodes tab is where a scenario is actually built now, so this is what
 * stands behind it: reorder, add, remove, and change any field of any node,
 * all written back into `scenario.yaml` the way every other editor action
 * writes — by source offset, never by re-serialising. The scenarios in this
 * repo are full of comments recording why a beat is the length it is, and a
 * round trip through the YAML object model drops every one of them.
 *
 * Two ideas carry the whole file.
 *
 * **A node is a block of source, and a block moves whole.** `nodeBlocks`
 * carves the `nodes:` sequence into contiguous, non-overlapping spans, one per
 * node, each running from its own leading comments to just before the next
 * node's. Reordering is then a permutation of those spans joined back
 * together: every byte inside a block — comments, hand-wrapped folded scalars,
 * the blank line someone left for breathing room — survives, because nothing
 * ever looks inside it. What changes is the order they are concatenated in.
 *
 * **The spine is spliced, not recomputed.** Dragging a node rewrites at most
 * three `next` pointers, and only where a pointer still agrees with the order
 * it is being moved out of. A poll option or a branch condition is a
 * deliberate jump somebody authored, and so is a `next` that already skips
 * ahead; recomputing every exit from list position would flatten a branching
 * story the first time anyone dragged anything. What cannot be rewired safely
 * is reported instead — see `SpineWarning`.
 */

import { parseDocument, isMap, isSeq, isScalar, stringify, type Pair, type YAMLMap } from 'yaml';
import {
  applyEdits,
  indentOf,
  insertionAfter,
  insertionFor,
  pairFor,
  spanOfEntry,
  type Edit,
} from './yaml-edit.ts';

/** Node types the engine leaves by a single `next`. Mirrors `isLinear`. */
const LINEAR = new Set(['dialogue', 'pause', 'gate']);

/**
 * The scalar fields a brand-new node needs to satisfy the schema.
 *
 * Placeholders on purpose: a new beat should be immediately visible in the
 * list and immediately obviously unfinished, rather than valid-looking and
 * empty. The structural halves — a dialogue's lines, a poll's options — are
 * built in `addNode`, since they depend on where the node landed.
 */
const DEFAULT_FIELDS: Record<string, Record<string, string | number>> = {
  gate: { label: 'Continue' },
  pause: { duration: 3 },
  poll: { question: 'A new question?', duration: 60 },
  end: { text: 'The end.' },
};

/**
 * What each node type may hold, on top of the four keys every node shares.
 *
 * A retype is the only edit that needs this: the schema is a discriminated
 * union of strict objects, so a node that keeps `duration` after becoming a
 * gate is a file that will not load. Written out rather than derived from the
 * Zod schemas because reading a strict object's keys back out is an
 * introspection trick that changes shape with the library, and this list is
 * checked by a test that walks the schemas — if the two ever disagree the test
 * says so, which is the guarantee that matters.
 */
export const BASE_FIELDS = ['id', 'type', 'scene', 'background', 'video'];

export const OWN_FIELDS: Record<string, string[]> = {
  dialogue: ['lines', 'next'],
  poll: ['question', 'prompt', 'duration', 'options', 'default', 'tiebreak', 'set'],
  branch: ['when', 'else'],
  pause: ['duration', 'text', 'sfx', 'next'],
  gate: ['text', 'label', 'sfx', 'next'],
  end: ['text'],
};

export const NODE_TYPES = Object.keys(OWN_FIELDS);

export type NodeBlock = {
  id: string;
  type: string;
  index: number;
  /** Start of this node's span, including any comment lines written above it. */
  start: number;
  /** One past the end: the start of the next node's span. */
  end: number;
  map: YAMLMap;
};

export type SpineWarning = {
  nodeId: string;
  /** What the pointer says now, and was left saying. */
  next: string;
  reason: string;
};

export type NodeEdit = {
  source: string;
  /** `id` → the value its `next` was changed to. */
  rewired: { nodeId: string; from: string; to: string }[];
  warnings: SpineWarning[];
  /**
   * Plain sentences about what the edit did beyond moving pointers.
   *
   * Retyping is the reason these exist: a node keeps only the fields its new
   * type can hold, so becoming a `gate` costs a dialogue its lines. That is
   * what was asked for, but it is not something to find out about later by
   * reading the file — an edit that quietly deletes a paragraph and reports
   * "saved" is the one people stop trusting the editor over.
   */
  notes?: string[];
};

export class NodeEditError extends Error {}

// ---------------------------------------------------------------------------
// Finding the blocks
// ---------------------------------------------------------------------------

/** The `nodes:` sequence, or a thrown error naming what was wrong instead. */
function nodesSeqOf(source: string) {
  const doc = parseDocument(source);
  const seq = doc.get('nodes');
  if (!isSeq(seq) || seq.items.length === 0) {
    throw new NodeEditError('this scenario has no nodes: sequence to edit');
  }
  return seq;
}

/**
 * One contiguous span per node, in file order.
 *
 * The spans tile the sequence with no gaps, which is what makes reordering a
 * pure permutation: concatenating them in any order yields a file with the
 * same bytes in a different sequence. A comment sitting above a node belongs
 * to that node and travels with it — which is the behaviour an author expects
 * and the reason this is not simply `doc.toString()`.
 */
export function nodeBlocks(source: string): NodeBlock[] {
  const seq = nodesSeqOf(source);
  const items = seq.items.filter(isMap) as YAMLMap[];
  if (items.length !== seq.items.length) {
    throw new NodeEditError('every entry under nodes: must be a mapping');
  }

  // Where each item's own text begins, walked back over the comment lines
  // written above it. The walk stops at the previous node's last value so a
  // trailing comment stays with the line it was written beside.
  const starts: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const from = item.range?.[0] ?? 0;
    const dash = source.lastIndexOf('-', from);
    let lineStart = source.lastIndexOf('\n', dash - 1) + 1;

    const floor = i === 0 ? (seq.range?.[0] ?? 0) : (items[i - 1]!.range?.[1] ?? 0);
    for (;;) {
      if (lineStart <= floor) break;
      const prevStart = source.lastIndexOf('\n', lineStart - 2) + 1;
      if (prevStart < floor) break;
      const line = source.slice(prevStart, lineStart);
      if (!/^\s*(#.*)?\r?\n?$/.test(line)) break;
      lineStart = prevStart;
    }
    starts.push(lineStart);
  }

  // The last block runs to the end of its final line. Anything after that is
  // the file's, not the node's — a trailing comment at the bottom of `nodes:`
  // is as likely to be about the document as about the last beat.
  const lastEnd = items[items.length - 1]!.range?.[1] ?? source.length;
  const newline = source.indexOf('\n', lastEnd);
  const tail = newline === -1 ? source.length : newline + 1;

  return items.map((map, i) => {
    const id = map.get('id');
    const type = map.get('type');
    if (typeof id !== 'string') throw new NodeEditError(`node ${i} has no id`);
    return {
      id,
      type: typeof type === 'string' ? type : '',
      index: i,
      start: starts[i]!,
      end: i + 1 < items.length ? starts[i + 1]! : tail,
      map,
    };
  });
}

function blockFor(blocks: NodeBlock[], id: string): NodeBlock {
  const block = blocks.find((b) => b.id === id);
  if (!block) throw new NodeEditError(`no node called "${id}"`);
  return block;
}

// ---------------------------------------------------------------------------
// Writing scalars
// ---------------------------------------------------------------------------

/**
 * A value as YAML, on one line.
 *
 * Deliberately conservative about quoting: a bare word stays bare so the file
 * goes on reading like something a person wrote, and anything that could be
 * mistaken for a number, a boolean or the start of a block scalar gets quoted
 * so it survives the round trip. Newlines force double quotes rather than a
 * block scalar, because a block scalar cannot be spliced into the middle of an
 * existing line and this is only ever used to replace one value in place.
 */
export function scalarText(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  // The library's own serialiser rather than a hand-rolled quoting rule: it
  // knows which schema the loader will read this back with, so it quotes
  // exactly when the value would otherwise come back as some other type and
  // leaves an ordinary word bare. A second opinion here would eventually
  // disagree with the parser, and only in the cases that matter.
  const written = stringify(value).trimEnd();
  return written.includes('\n') ? JSON.stringify(value) : written;
}

/**
 * A long value as a folded block scalar, wrapped the way the file already is.
 *
 * Dialogue in these scenarios is written as `>-` across two or three lines,
 * because a paragraph of narration on one 300-column line is not something
 * anybody can read in a diff. Replacing such a value with a single long line
 * would be technically correct and would quietly un-format the file a line at
 * a time as the author edited it, so an edit that produces a long string puts
 * the fold back.
 */
function foldedText(value: string, indent: string): string {
  const width = Math.max(30, 78 - indent.length);
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return `>-\n${lines.map((l) => indent + l).join('\n')}`;
}

/**
 * Whether a value can survive as a folded scalar.
 *
 * Folding joins its lines with spaces, so any run of whitespace that carries
 * meaning — a newline, a leading or trailing space, a double space — would come
 * back different. Those go out as quoted one-liners instead.
 */
function foldable(value: string): boolean {
  return !/\n/.test(value) && value.trim() === value && !/\s{2}/.test(value);
}

/** Walks a dotted path from a node's map down to the pair that holds it. */
function pairAtPath(map: YAMLMap, path: (string | number)[]) {
  let current: unknown = map;
  for (let i = 0; i < path.length - 1; i++) {
    const step = path[i]!;
    if (isMap(current)) current = current.get(String(step));
    else if (isSeq(current)) current = current.items[Number(step)];
    else return undefined;
  }
  const last = path[path.length - 1]!;
  if (isMap(current)) return { parent: current, pair: pairFor(current, String(last)) };
  return undefined;
}

// ---------------------------------------------------------------------------
// Field edits
// ---------------------------------------------------------------------------

/**
 * Sets, adds or removes one field on one node.
 *
 * `null` removes the key outright, which is how an optional field is cleared:
 * writing an empty string instead would leave `text: ''` in the file, and an
 * empty string is a value the schema rejects rather than an absence.
 *
 * `after` places a brand-new key next to one that already exists, because
 * `background:` beside `scene:` reads as what it is where the same key
 * appended below `next:` reads as an afterthought.
 */
export function setNodeField(
  source: string,
  id: string,
  path: (string | number)[],
  value: string | number | boolean | null,
  after?: string,
): string {
  const block = blockFor(nodeBlocks(source), id);
  const found = pairAtPath(block.map, path);
  if (!found) throw new NodeEditError(`"${path.join('.')}" is not a field of node "${id}"`);
  const { parent, pair } = found;

  if (value === null) {
    if (!pair) return source;
    const span = spanOfPair(source, parent, pair);
    return applyEdits(source, [span]);
  }

  if (pair && pair.value && isScalar(pair.value) && pair.value.range) {
    const [from, to] = pair.value.range;
    // Keep the shape the file is already in. A value written as a fold stays
    // folded, and a plain one that has grown long becomes one — otherwise
    // editing narration slowly turns a readable file into a wall of 300-column
    // lines, one save at a time.
    const existing = source.slice(from, to);
    const wasFolded = /^[>|]/.test(existing);
    const long = typeof value === 'string' && value.length > 78;
    const body =
      typeof value === 'string' && (wasFolded || long) && foldable(value)
        ? foldedText(value, `${indentOf(source, (pair.key as { range?: number[] }).range?.[0] ?? from)}  `)
        : scalarText(value);
    // A block scalar's range runs to the start of the next key, newline
    // included. Dropping that newline welds the following line onto the end of
    // the value — `hold: 7` becomes part of the narration, and the beat it was
    // timing silently reverts to the reading-speed estimate.
    const text = existing.endsWith('\n') ? `${body}\n` : body;
    return applyEdits(source, [{ at: from, end: to, text }]);
  }

  const text = scalarText(value);

  const key = String(path[path.length - 1]);
  const spot =
    (after ? insertionAfter(source, parent, after) : undefined) ?? insertionFor(source, parent);
  const indent = spot.flow ? '' : indentOf(source, parent.range?.[0] ?? spot.at);
  const written = spot.flow ? `, ${key}: ${text}` : `\n${indent}${key}: ${text}`;
  return applyEdits(source, [{ at: spot.at, text: written }]);
}

/**
 * The source a pair occupies, or a thrown error naming what could not be found.
 *
 * The measuring lives in `yaml-edit.ts` with the rest of the offset arithmetic —
 * a second copy would eventually disagree with the first about where a key ends,
 * and the disagreement would be a half-deleted field.
 */
function spanOfPair(source: string, parent: YAMLMap, pair: { key?: unknown; value?: unknown }): Edit {
  const span = spanOfEntry(source, parent, pair as Pair);
  if (!span) throw new NodeEditError('cannot locate that field in the source');
  return span;
}

// ---------------------------------------------------------------------------
// Lists inside a node
// ---------------------------------------------------------------------------

/** The sequence a path names, e.g. `['lines']` or `['options']`. */
function seqAtPath(map: YAMLMap, path: (string | number)[]) {
  let current: unknown = map;
  for (const step of path) {
    if (isMap(current)) current = current.get(String(step));
    else if (isSeq(current)) current = current.items[Number(step)];
    else return undefined;
  }
  return isSeq(current) ? current : undefined;
}

/**
 * One line-aligned span per entry, the same trick `nodeBlocks` uses.
 *
 * A sequence entry's `range` cannot be used for this: for a block mapping it
 * runs past the entry's own last line and into whatever follows, so slicing by
 * it deletes the dash off the next entry and turns a list into a mapping — or
 * appends a new entry below `next:`, outside the list entirely. Both were real,
 * and both look like the YAML writer having gone mad rather than an off-by-one.
 * Dashes and indentation are what actually delimit a block sequence, so those
 * are what this measures.
 */
function itemSpans(source: string, seq: { items: unknown[] }): { start: number; end: number }[] {
  const starts = seq.items.map((item) => {
    const from = (item as { range?: number[] }).range?.[0] ?? 0;
    const dash = source.lastIndexOf('-', from);
    return source.lastIndexOf('\n', dash - 1) + 1;
  });
  if (starts.length === 0) return [];

  const column = (at: number) => /^[ \t]*/.exec(source.slice(at))![0].length;
  const dashColumn = column(starts[0]!);

  // The list ends at the first line indented no further than its dashes: that
  // is the next key of the mapping the list belongs to.
  let end = source.length;
  let cursor = source.indexOf('\n', starts[starts.length - 1]!);
  while (cursor !== -1) {
    const lineStart = cursor + 1;
    if (lineStart >= source.length) break;
    const lineEnd = source.indexOf('\n', lineStart);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (line.trim() !== '' && column(lineStart) <= dashColumn) {
      end = lineStart;
      break;
    }
    cursor = lineEnd;
  }

  return starts.map((start, i) => ({ start, end: i + 1 < starts.length ? starts[i + 1]! : end }));
}

/**
 * Appends an entry to one of a node's lists — a dialogue line, a poll option,
 * a branch condition.
 *
 * The new entry copies the *shape* of the ones already there rather than
 * imposing one: these scenarios write short lines as `- { text: … }` and long
 * ones as a block mapping, and an author who has chosen one does not want the
 * other appearing underneath it.
 */
export function addListItem(
  source: string,
  id: string,
  path: (string | number)[],
  fields: Record<string, string | number>,
): string {
  const block = blockFor(nodeBlocks(source), id);
  const seq = seqAtPath(block.map, path);
  if (!seq || seq.items.length === 0) {
    throw new NodeEditError(`node "${id}" has no ${path.join('.')} to add to`);
  }

  const spans = itemSpans(source, seq);
  const last = seq.items[seq.items.length - 1];
  const lastSpan = spans[spans.length - 1]!;
  const dashIndent = /^[ \t]*/.exec(source.slice(lastSpan.start))![0];
  const flow = isMap(last) && last.flow;

  const entries = Object.entries(fields);
  const text = flow
    ? `${dashIndent}- { ${entries.map(([k, v]) => `${k}: ${scalarText(v)}`).join(', ')} }\n`
    : `${entries
        .map(([k, v], i) => `${i === 0 ? `${dashIndent}- ` : `${dashIndent}  `}${k}: ${scalarText(v)}`)
        .join('\n')}\n`;

  return applyEdits(source, [{ at: lastSpan.end, text }]);
}

/** Removes one entry from a node's list, by index. */
export function removeListItem(
  source: string,
  id: string,
  path: (string | number)[],
  index: number,
): string {
  const block = blockFor(nodeBlocks(source), id);
  const seq = seqAtPath(block.map, path);
  if (!seq) throw new NodeEditError(`node "${id}" has no ${path.join('.')}`);

  const span = itemSpans(source, seq)[index];
  if (!span) throw new NodeEditError(`no entry ${index} in ${path.join('.')}`);
  return applyEdits(source, [{ at: span.start, end: span.end, text: '' }]);
}

/**
 * Moves one entry within a node's list — the same permutation `reorderBlocks`
 * performs on nodes, one level down.
 *
 * The lines of a dialogue node are its running order, and getting them into the
 * right one is ordinary writing: a beat lands better before the reaction than
 * after it, and finding that out means trying it. Doing that by retyping two
 * boxes moves the words but leaves `hold`, `voice` and `sfx` behind with the
 * wrong line — a re-record and a mistimed beat from an edit that looked like
 * nothing. Moving the source instead takes the whole entry, and the spine is
 * not involved at all: lines play in the order they are written, so nothing
 * outside this node can notice.
 */
export function moveListItem(
  source: string,
  id: string,
  path: (string | number)[],
  fromIndex: number,
  toIndex: number,
): string {
  const block = blockFor(nodeBlocks(source), id);
  const seq = seqAtPath(block.map, path);
  if (!seq) throw new NodeEditError(`node "${id}" has no ${path.join('.')}`);

  const spans = itemSpans(source, seq);
  if (!spans[fromIndex]) throw new NodeEditError(`no entry ${fromIndex} in ${path.join('.')}`);
  const target = Math.max(0, Math.min(toIndex, spans.length - 1));
  if (target === fromIndex) return source;

  const order = spans.map((_, i) => i);
  order.splice(fromIndex, 1);
  order.splice(target, 0, fromIndex);

  const at = spans[0]!.start;
  const end = spans[spans.length - 1]!.end;
  const endsWithNewline = source.slice(at, end).endsWith('\n');
  const text = order
    .map((i) => {
      const slice = source.slice(spans[i]!.start, spans[i]!.end);
      // Every entry needs its newline once it is no longer last, or the one
      // after it lands on the same line and the list becomes one long entry.
      return slice.endsWith('\n') ? slice : `${slice}\n`;
    })
    .join('');

  return applyEdits(source, [
    { at, end, text: endsWithNewline ? text : text.replace(/\n$/, '') },
  ]);
}

// ---------------------------------------------------------------------------
// The spine
// ---------------------------------------------------------------------------

/**
 * Rewrites the `next` pointers that were following file order, and only those.
 *
 * `before` and `after` are the node id orders on either side of the change.
 * A linear node whose `next` still names whatever followed it in `before` was
 * riding the spine, so it is moved to whatever follows it in `after`. A `next`
 * that named anything else was somebody deliberately jumping, and is reported
 * rather than rewritten — the alternative is a drag that silently reroutes a
 * story around the node the author actually meant.
 */
export function rewireSpine(source: string, before: string[], after: string[]): NodeEdit {
  const blocks = nodeBlocks(source);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const nextIn = (order: string[], id: string) => order[order.indexOf(id) + 1];

  const edits: Edit[] = [];
  const rewired: NodeEdit['rewired'] = [];
  const warnings: SpineWarning[] = [];

  for (const id of after) {
    const block = byId.get(id);
    if (!block || !LINEAR.has(block.type)) continue;
    // A node that did not exist in `before` has no old spine to have been
    // following, so there is nothing to move and nothing to warn about: its
    // `next` was written a moment ago, deliberately, by whoever added it.
    if (!before.includes(id)) continue;

    const pair = pairFor(block.map, 'next');
    if (!pair || !isScalar(pair.value) || typeof pair.value.value !== 'string') continue;
    const current = pair.value.value;

    const wasFollowing = nextIn(before, id);
    const nowFollowing = nextIn(after, id);

    if (current !== wasFollowing) {
      // Only worth mentioning when the order around it actually changed.
      if (wasFollowing !== nowFollowing) {
        warnings.push({
          nodeId: id,
          next: current,
          reason: 'left alone — its next was already a deliberate jump, not the node below it',
        });
      }
      continue;
    }
    if (nowFollowing === undefined || nowFollowing === current) continue;

    const range = pair.value.range;
    if (!range) continue;
    edits.push({ at: range[0], end: range[1], text: scalarText(nowFollowing) });
    rewired.push({ nodeId: id, from: current, to: nowFollowing });
  }

  return { source: applyEdits(source, edits), rewired, warnings };
}

// ---------------------------------------------------------------------------
// Reorder, add, remove
// ---------------------------------------------------------------------------

/** Replaces the whole `nodes:` region with its blocks in a new order. */
function reorderBlocks(source: string, blocks: NodeBlock[], order: string[]): string {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const from = blocks[0]!.start;
  const to = blocks[blocks.length - 1]!.end;
  const endsWithNewline = source.slice(from, to).endsWith('\n');

  const text = order
    .map((id) => {
      const block = byId.get(id);
      if (!block) throw new NodeEditError(`no node called "${id}"`);
      const slice = source.slice(block.start, block.end);
      // Every block has to end in a newline once it is no longer last, or the
      // node after it would land on the same line.
      return slice.endsWith('\n') ? slice : `${slice}\n`;
    })
    .join('');

  const trimmed = endsWithNewline ? text : text.replace(/\n$/, '');
  return applyEdits(source, [{ at: from, end: to, text: trimmed }]);
}

/**
 * Moves a node to a new position in the presentation.
 *
 * Two passes on purpose: the blocks move first, then the file is re-parsed
 * before the spine is spliced. Offsets computed against the old text mean
 * nothing once the region has been rewritten, and re-reading is cheaper than
 * being clever about which of them survived.
 */
export function moveNode(source: string, id: string, toIndex: number): NodeEdit {
  const blocks = nodeBlocks(source);
  const before = blocks.map((b) => b.id);
  const from = before.indexOf(id);
  if (from === -1) throw new NodeEditError(`no node called "${id}"`);

  const target = Math.max(0, Math.min(toIndex, before.length - 1));
  if (target === from) return { source, rewired: [], warnings: [] };

  const after = [...before];
  after.splice(from, 1);
  after.splice(target, 0, id);

  const moved = reorderBlocks(source, blocks, after);
  return rewireSpine(moved, before, after);
}

/**
 * Removes a node, and mends the chain across the hole it leaves.
 *
 * Whatever pointed at it is pointed at what it pointed at, so deleting a beat
 * in the middle of a presentation does not strand everything after it. Poll
 * options and branch conditions that named it cannot be mended this way — the
 * author chose that target — so they are reported as dangling instead, which
 * is exactly what the checker will say about them a moment later.
 */
export function removeNode(source: string, id: string): NodeEdit {
  const blocks = nodeBlocks(source);
  if (blocks.length === 1) throw new NodeEditError('a scenario needs at least one node');

  const target = blockFor(blocks, id);
  const ownNext = pairFor(target.map, 'next')?.value;
  const successor =
    isScalar(ownNext) && typeof ownNext.value === 'string' ? ownNext.value : undefined;

  const warnings: SpineWarning[] = [];
  const edits: Edit[] = [];

  // Anything naming the removed node is repointed at what it led to, whatever
  // kind of pointer it is: leaving a dangling `next` behind would break the
  // scenario at load time rather than at the author's desk.
  for (const block of blocks) {
    if (block.id === id) continue;
    for (const [path, pair] of pointersOf(block.map)) {
      if (!isScalar(pair.value) || pair.value.value !== id) continue;
      const range = pair.value.range;
      if (!range) continue;
      if (successor) {
        edits.push({ at: range[0], end: range[1], text: scalarText(successor) });
      } else {
        warnings.push({
          nodeId: block.id,
          next: id,
          reason: `${path} pointed at a node with no next of its own — repoint it by hand`,
        });
      }
    }
  }

  // `start:` names a node too, and it lives outside the sequence — so the walk
  // above cannot see it. Removing the opening beat without moving this leaves
  // a file that parses and then fails the graph check with "start node does
  // not exist", which is a confusing way to be told you deleted the first
  // slide.
  const doc = parseDocument(source);
  const startPair = pairFor(doc.contents as YAMLMap, 'start');
  if (startPair && isScalar(startPair.value) && startPair.value.value === id) {
    const range = startPair.value.range;
    const heir = successor ?? blocks.find((b) => b.id !== id)?.id;
    if (range && heir) edits.push({ at: range[0], end: range[1], text: scalarText(heir) });
  }

  edits.push({ at: target.start, end: target.end, text: '' });
  return { source: applyEdits(source, edits), rewired: [], warnings };
}

/**
 * Renames a node, and everything that names it.
 *
 * Never a plain field edit. An id is the only value in the file that other
 * lines depend on by name, so changing it alone turns every pointer at it into
 * a dangling reference — a scenario that will not load, produced by typing in
 * a text box. The rename and the pointers move together or not at all.
 */
export function renameNode(source: string, from: string, to: string): NodeEdit {
  if (from === to) return { source, rewired: [], warnings: [] };
  if (!/^[A-Za-z0-9_-]+$/.test(to)) {
    throw new NodeEditError('an id may contain only letters, numbers, hyphens and underscores');
  }

  const blocks = nodeBlocks(source);
  const target = blockFor(blocks, from);
  if (blocks.some((b) => b.id === to)) {
    throw new NodeEditError(`there is already a node called "${to}"`);
  }

  const edits: Edit[] = [];
  const rewired: NodeEdit['rewired'] = [];

  const idPair = pairFor(target.map, 'id');
  if (idPair && isScalar(idPair.value) && idPair.value.range) {
    edits.push({ at: idPair.value.range[0], end: idPair.value.range[1], text: scalarText(to) });
  }

  for (const block of blocks) {
    for (const [, pair] of pointersOf(block.map)) {
      if (!isScalar(pair.value) || pair.value.value !== from || !pair.value.range) continue;
      edits.push({ at: pair.value.range[0], end: pair.value.range[1], text: scalarText(to) });
      rewired.push({ nodeId: block.id, from, to });
    }
  }

  const doc = parseDocument(source);
  const startPair = pairFor(doc.contents as YAMLMap, 'start');
  if (startPair && isScalar(startPair.value) && startPair.value.value === from) {
    const range = startPair.value.range;
    if (range) edits.push({ at: range[0], end: range[1], text: scalarText(to) });
  }

  return { source: applyEdits(source, edits), rewired, warnings: [] };
}

/** Every pair in a node that names another node, with a readable path. */
function* pointersOf(map: YAMLMap): Generator<[string, { value?: unknown }]> {
  const next = pairFor(map, 'next');
  if (next) yield ['next', next];

  const options = map.get('options');
  if (isSeq(options)) {
    for (const [i, option] of options.items.entries()) {
      if (!isMap(option)) continue;
      const pair = pairFor(option, 'next');
      if (pair) yield [`option ${i + 1}`, pair];
    }
  }

  const when = map.get('when');
  if (isSeq(when)) {
    for (const [i, condition] of when.items.entries()) {
      if (!isMap(condition)) continue;
      const pair = pairFor(condition, 'next');
      if (pair) yield [`condition ${i + 1}`, pair];
    }
  }

  const otherwise = pairFor(map, 'else');
  if (otherwise) yield ['else', otherwise];
}

/**
 * Inserts a new node after `afterId` (or at the top when it is undefined),
 * and threads it into the chain.
 *
 * The block is written from a template rather than serialised from an object,
 * so a new node arrives looking like the ones around it — one key per line, in
 * the order a person writes them.
 */
export function addNode(
  source: string,
  spec: { id: string; type: string; fields?: Record<string, string | number> },
  afterId?: string,
): NodeEdit {
  const blocks = nodeBlocks(source);
  if (blocks.some((b) => b.id === spec.id)) {
    throw new NodeEditError(`there is already a node called "${spec.id}"`);
  }

  const before = blocks.map((b) => b.id);
  const at = afterId ? before.indexOf(afterId) + 1 : 0;
  if (afterId && at === 0) throw new NodeEditError(`no node called "${afterId}"`);

  const successor = before[at];
  const indent = indentOf(source, blocks[0]!.map.range?.[0] ?? 0);
  const dash = indent.slice(0, Math.max(0, indent.length - 2));

  // Defaults live here rather than in the caller so that every way of adding a
  // node produces the same valid one. A poll with no `question` is the case
  // that proved it: the button in the editor happened to supply one, so the
  // gap only showed up the first time anything else called this.
  const fields = { ...(DEFAULT_FIELDS[spec.type] ?? {}), ...(spec.fields ?? {}) };

  const lines = [`${dash}- id: ${spec.id}`, `${indent}type: ${spec.type}`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${indent}${key}: ${scalarText(value)}`);
  }

  // A new node is born valid or not at all.
  //
  // Every type here has structure the schema insists on — a dialogue needs a
  // line, a poll needs two options and a default, a branch needs a condition
  // and an else — and `editNodesIn` refuses to write a file that will not
  // load. Without these the Add button would simply report an error for four
  // of the six types, which is a worse answer than not offering them.
  //
  // Added at the very bottom there is nothing below to point at, so the
  // pointer goes to the show's ending. Self-reference would also load, and
  // would be a beat that repeats itself forever in front of an audience if it
  // ever reached a projector unedited.
  const heir = successor ?? blocks.find((b) => b.type === 'end')?.id;
  const to = heir ? scalarText(heir) : undefined;
  if (spec.type === 'dialogue') {
    lines.push(`${indent}lines:`, `${indent}  - text: A new line.`);
  } else if (spec.type === 'poll') {
    lines.push(
      `${indent}options:`,
      `${indent}  - { key: a, label: One, next: ${to ?? spec.id} }`,
      `${indent}  - { key: b, label: Two, next: ${to ?? spec.id} }`,
      `${indent}default: a`,
    );
  } else if (spec.type === 'branch') {
    lines.push(
      `${indent}when:`,
      `${indent}  - { if: "choice == 'a'", next: ${to ?? spec.id} }`,
      `${indent}else: ${to ?? spec.id}`,
    );
  }

  // A linear node with nowhere to go is a dead end the checker rejects, so a
  // new one points at whatever it was inserted above.
  if (LINEAR.has(spec.type) && to) lines.push(`${indent}next: ${to}`);

  const insertAt = at < blocks.length ? blocks[at]!.start : blocks[blocks.length - 1]!.end;

  // A node's block starts *above* its own leading blank line and comments, so
  // the insertion point already has a blank after it and none before it — drop
  // a node in and it ends up welded to the bottom of the previous one. Both
  // sides are checked rather than assumed, because the first and last
  // positions have a blank on neither side and a doubled gap survives the node
  // being deleted again. Add and delete is something an author does a dozen
  // times working out an order, so a file that gains a blank line each time
  // ends the afternoon with a diff nobody can read.
  const blankAfter = /^[ \t]*\r?\n/.test(source.slice(insertAt));
  const blankBefore = insertAt === 0 || /(^|\n)[ \t]*\r?\n$/.test(source.slice(0, insertAt));
  const block = `${blankBefore ? '' : '\n'}${lines.join('\n')}\n${blankAfter ? '' : '\n'}`;
  const withNode = applyEdits(source, [{ at: insertAt, text: block }]);

  const after = [...before];
  after.splice(at, 0, spec.id);
  const spliced = rewireSpine(withNode, before, after);

  // The node above it now leads here. `rewireSpine` only moves pointers that
  // were already following file order, which is exactly the right rule — but
  // it cannot see a node that did not exist in `before`, so the predecessor is
  // handled by the same walk on the way in.
  return spliced;
}

// ---------------------------------------------------------------------------
// Changing what a node is
// ---------------------------------------------------------------------------

/** Types whose whole content is one screen of words. */
const TEXTUAL = new Set(['pause', 'gate', 'end']);

/**
 * The words, where both shapes hold some and the carry cannot be a guess.
 *
 * A title card is as likely to have been written as a one-line dialogue as as a
 * gate, and realising which it should be is exactly when somebody reaches for
 * the type dropdown. Deleting the sentence on the way through would make the
 * feature something you use once. So a single line's `text` becomes the node's
 * `text` and back — and *only* a single line, because a dialogue of five lines
 * has no one sentence to become, and picking the first would silently discard
 * four while looking like it had worked.
 */
function carriedText(map: YAMLMap, from: string, to: string): string | undefined {
  if (from === 'dialogue' && TEXTUAL.has(to)) {
    const lines = map.get('lines');
    if (!isSeq(lines) || lines.items.length !== 1) return undefined;
    const only = lines.items[0];
    if (!isMap(only)) return undefined;
    const text = only.get('text');
    return typeof text === 'string' ? text : undefined;
  }
  if (TEXTUAL.has(from) && to === 'dialogue') {
    const text = map.get('text');
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

/**
 * Where a node should lead once it needs somewhere to lead and has nothing.
 *
 * Its own `next` first, even though the retype is about to drop it: that value
 * is the author's own answer to this question and is right even when the node
 * was deliberately jumping past the one below it. File order is the fallback,
 * because that is what the spine means, and a pointer it already had beats an
 * ending picked at random.
 */
function heirFor(blocks: NodeBlock[], block: NodeBlock): string | undefined {
  const own = pairFor(block.map, 'next')?.value;
  if (isScalar(own) && typeof own.value === 'string') return own.value;

  const below = blocks[block.index + 1];
  if (below) return below.id;

  for (const [, pair] of pointersOf(block.map)) {
    if (isScalar(pair.value) && typeof pair.value.value === 'string') return pair.value.value;
  }
  return blocks.find((b) => b.type === 'end' && b.id !== block.id)?.id;
}

/**
 * Changes what kind of beat a node is, in place.
 *
 * Not a field edit, for the same reason renaming is not: `type` is the schema's
 * discriminator, so writing it alone leaves a node carrying keys its new type
 * rejects and a file that will not load. The type and the shape move together.
 *
 * Two rules make it survivable. Anything the new type cannot hold is dropped
 * and *reported* — a retype is a real edit with a real cost, and the cost is
 * worth knowing before the author has closed the tab. And anything the new type
 * insists on is supplied, so the node is valid the moment it lands:
 * `editNodesIn` refuses to write a broken file, and a dropdown that answers
 * four of its six choices with an error message is a dropdown nobody uses.
 */
export function retypeNode(source: string, id: string, to: string): NodeEdit {
  const own = OWN_FIELDS[to];
  if (!own) throw new NodeEditError(`there is no node type called "${to}"`);

  const blocks = nodeBlocks(source);
  const block = blockFor(blocks, id);
  const from = block.type;
  if (from === to) return { source, rewired: [], warnings: [] };

  const keep = new Set([...BASE_FIELDS, ...own]);
  const carried = carriedText(block.map, from, to);
  const has = (key: string) => pairFor(block.map, key) !== undefined;

  const edits: Edit[] = [];
  const dropped: string[] = [];
  for (const item of block.map.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string') continue;
    const key = item.key.value;
    if (keep.has(key)) continue;
    edits.push(spanOfPair(source, block.map, item));
    dropped.push(key);
  }

  const typePair = pairFor(block.map, 'type');
  if (!typePair || !isScalar(typePair.value) || !typePair.value.range) {
    throw new NodeEditError(`node "${id}" has no type: to change`);
  }
  edits.push({
    at: typePair.value.range[0],
    end: typePair.value.range[1],
    text: scalarText(to),
  });

  const indent = indentOf(source, block.map.range?.[0] ?? 0);
  const add: string[] = [];
  let heir: string | undefined;
  const leadsTo = () => {
    heir ??= heirFor(blocks, block);
    if (!heir) {
      throw new NodeEditError(
        `nothing for "${id}" to lead to — give it a next: by hand before making it ${to}`,
      );
    }
    return scalarText(heir);
  };

  switch (to) {
    case 'dialogue':
      if (!has('lines')) {
        add.push(`${indent}lines:`, `${indent}  - text: ${scalarText(carried ?? 'A new line.')}`);
      }
      if (!has('next')) add.push(`${indent}next: ${leadsTo()}`);
      break;

    case 'pause':
      if (!has('duration')) add.push(`${indent}duration: 3`);
      if (carried && !has('text')) add.push(`${indent}text: ${scalarText(carried)}`);
      if (!has('next')) add.push(`${indent}next: ${leadsTo()}`);
      break;

    case 'gate':
      if (carried && !has('text')) add.push(`${indent}text: ${scalarText(carried)}`);
      if (!has('label')) add.push(`${indent}label: Continue`);
      if (!has('next')) add.push(`${indent}next: ${leadsTo()}`);
      break;

    case 'end':
      if (carried && !has('text')) add.push(`${indent}text: ${scalarText(carried)}`);
      break;

    case 'poll':
      if (!has('question')) add.push(`${indent}question: A new question?`);
      if (!has('options')) {
        const next = leadsTo();
        add.push(
          `${indent}options:`,
          `${indent}  - { key: a, label: One, next: ${next} }`,
          `${indent}  - { key: b, label: Two, next: ${next} }`,
        );
      }
      // Written beside the options that were just invented, and always `a`: a
      // default naming an option that does not exist is the one way a poll can
      // deadlock a live show, which is why the validator insists on it.
      if (!has('default')) add.push(`${indent}default: a`);
      break;

    case 'branch':
      if (!has('when')) {
        add.push(`${indent}when:`, `${indent}  - { if: "choice == 'a'", next: ${leadsTo()} }`);
      }
      if (!has('else')) add.push(`${indent}else: ${leadsTo()}`);
      break;
  }

  if (add.length > 0) {
    // A node written inline has no lines to insert between. Spreading it over
    // several to make room would reformat something the author chose to keep on
    // one, which is the edit this whole file exists to avoid.
    if (block.map.flow) {
      throw new NodeEditError(
        `"${id}" is written inline — spread it over several lines before changing its type`,
      );
    }
    const spot = insertionAfter(source, block.map, 'type');
    if (!spot) throw new NodeEditError(`cannot find where to write ${to}'s fields in "${id}"`);
    edits.push({ at: spot.at, text: `\n${add.join('\n')}` });
  }

  const notes: string[] = [];
  if (dropped.length > 0) {
    // Named without a pronoun on purpose: half these keys are plural words for
    // one field, so "nowhere to keep it" reads as a typo beside `lines`.
    const fields = dropped.length === 1 ? 'field' : 'fields';
    notes.push(`dropped ${dropped.join(', ')} — a ${to} has no such ${fields}`);
  }
  if (carried) notes.push('kept the words');

  return { source: applyEdits(source, edits), rewired: [], warnings: [], notes };
}
