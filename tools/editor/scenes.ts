/**
 * Scenes as structure: add, remove, rename, and edit the four fields.
 *
 * A scene is a place, and until now it was the one part of a scenario with no
 * way into it but the text pane. That mattered more than it looks: `video:` on
 * a scene is how a moving background is declared, and an author who could not
 * see the field put the clip on each node instead — which is legal, which is
 * what the poster-frame warning is for, and which is how one project ended up
 * with the same clip written out six times.
 *
 * Everything here edits by source offset through `yaml-edit.ts`, for the reason
 * written down there: a scenario is full of hand-wrapped prose and comments
 * recording why a beat is the length it is, and re-serialising the document
 * throws all of it away on the first click.
 */

import { isMap, isScalar, parseDocument, type Pair, type YAMLMap } from 'yaml';

import { applyEdits, indentOf, insertionFor, pairFor, spanOfEntry, type Edit } from './yaml-edit.ts';
import { scalarText } from './nodes.ts';

export class SceneEditError extends Error {}

/** The four fields a scene may hold, in the order a scene sheet shows them. */
export const SCENE_FIELDS = ['background', 'video', 'music', 'ambience'] as const;
export type SceneField = (typeof SCENE_FIELDS)[number];

export type SceneEdit = {
  source: string;
  /** Plain sentences about anything the edit did beyond what was asked. */
  notes?: string[];
};

/** The `scenes:` map, or a thrown error naming what was wrong instead. */
function scenesMapOf(source: string): YAMLMap {
  const contents = parseDocument(source).contents;
  if (!isMap(contents)) throw new SceneEditError('scenario.yaml is not a mapping');
  const pair = pairFor(contents, 'scenes');
  if (!pair || !isMap(pair.value)) {
    throw new SceneEditError('This scenario has no scenes: block to edit');
  }
  return pair.value;
}

/** The top-level mapping, which is where `lobby:` lives. */
function rootOf(source: string): YAMLMap {
  const contents = parseDocument(source).contents;
  if (!isMap(contents)) throw new SceneEditError('scenario.yaml is not a mapping');
  return contents;
}

function sceneEntry(map: YAMLMap, id: string): Pair {
  const pair = pairFor(map, id);
  if (!pair) throw new SceneEditError(`There is no scene "${id}"`);
  return pair;
}

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

function checkId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new SceneEditError(
      `"${id}" is not a valid scene id — lowercase letters, digits and underscores, starting with a letter`,
    );
  }
}

/**
 * Sets or clears one field on one scene.
 *
 * `null` clears rather than writing an empty value. A box somebody emptied has
 * to stay distinguishable from a field never set, the same way a cleared `gap`
 * does — `background: ''` is not a picture, it is a scene that paints nothing
 * and claims it meant to.
 */
export function setSceneField(
  source: string,
  id: string,
  field: SceneField,
  value: string | null,
): string {
  const map = scenesMapOf(source);
  const pair = sceneEntry(map, id);
  if (!isMap(pair.value)) throw new SceneEditError(`Scene "${id}" is not a mapping`);
  const scene = pair.value;
  const existing = pairFor(scene, field);

  if (value === null) {
    if (!existing) return source;
    const span = spanOfEntry(source, scene, existing);
    if (!span) throw new SceneEditError(`Could not find "${field}" to remove`);

    // Emptying the last field of a scene written as a block leaves the key with
    // nothing under it, and `deck:` with no value is not an empty scene — it is
    // `null`, which the schema rejects outright. So the value is replaced rather
    // than removed, and the scene stays the empty mapping it is meant to be.
    // A flow map needs none of this: `{ }` is what is left over on its own.
    if (!scene.flow && scene.items.length === 1) {
      const key = pair.key as { range?: [number, number, number] };
      const colon = key.range ? source.indexOf(':', key.range[1]) : -1;
      if (colon !== -1) {
        const text = source.slice(span.at, span.end ?? span.at).endsWith('\n') ? ' { }\n' : ' { }';
        return applyEdits(source, [{ at: colon + 1, end: span.end ?? span.at, text }]);
      }
    }

    return applyEdits(source, [span]);
  }

  if (existing && existing.value && isScalar(existing.value) && existing.value.range) {
    const [from, to] = existing.value.range;
    const text = source.slice(from, to).endsWith('\n')
      ? `${scalarText(value)}\n`
      : scalarText(value);
    return applyEdits(source, [{ at: from, end: to, text }]);
  }

  const spot = insertionFor(source, scene);
  // A scene written inline — `{ background: x }`, which is how most of them are
  // written — takes a comma; one written as a block takes a fresh line under it.
  //
  // Unless it is *empty*. `{ }` has nothing to separate from, so a comma makes
  // `{, video: … }`, which is not YAML at all — the write is refused and the
  // field appears to undo itself. That is every scene the Add button makes, and
  // every `debrief: { }` already sitting in a scenario, so it was the first
  // field of every new place that could not be set.
  if (spot.flow) {
    const separator = scene.items.length === 0 ? ' ' : ', ';
    return applyEdits(source, [
      { at: spot.at, text: `${separator}${field}: ${scalarText(value)}` },
    ]);
  }
  const indent = indentOf(source, scene.range?.[0] ?? spot.at);
  return applyEdits(source, [{ at: spot.at, text: `\n${indent}${field}: ${scalarText(value)}` }]);
}

/** A new, empty scene at the end of the block. */
export function addScene(source: string, id: string): string {
  checkId(id);
  const map = scenesMapOf(source);
  if (pairFor(map, id)) throw new SceneEditError(`There is already a scene called "${id}"`);

  const spot = insertionFor(source, map);
  const indent = indentOf(source, map.range?.[0] ?? spot.at);
  // Born as an empty flow map, which is both what most scenes in a real
  // scenario are written as and what an empty one already looks like
  // (`debrief: { }`). The fields arrive from the sheet.
  return applyEdits(source, [{ at: spot.at, text: `\n${indent}${id}: { }` }]);
}

/** Every node that names a scene, so a removal can say what it would break. */
export function usersOf(source: string, id: string): string[] {
  const contents = parseDocument(source).contents;
  if (!isMap(contents)) return [];
  const nodes = pairFor(contents, 'nodes');
  const items = (nodes?.value as { items?: unknown[] } | undefined)?.items;
  if (!Array.isArray(items)) return [];

  const used: string[] = [];
  for (const item of items) {
    if (!isMap(item)) continue;
    const scene = pairFor(item, 'scene');
    if (!scene || !isScalar(scene.value) || scene.value.value !== id) continue;
    const nodeId = pairFor(item, 'id');
    if (nodeId && isScalar(nodeId.value)) used.push(String(nodeId.value.value));
  }
  return used;
}

/**
 * Removes a scene, refusing while anything still names it.
 *
 * A node whose scene has gone is a load error, so removing one in use would
 * hand back a file the show cannot open. The write would be refused anyway, but
 * with a message about a dangling reference rather than about the button that
 * was pressed — naming the nodes is what makes it something to act on.
 */
export function removeScene(source: string, id: string): SceneEdit {
  const map = scenesMapOf(source);
  const pair = sceneEntry(map, id);

  const used = usersOf(source, id);
  if (used.length > 0) {
    const shown = used.slice(0, 5).join(', ');
    const rest = used.length > 5 ? ` and ${used.length - 5} more` : '';
    throw new SceneEditError(
      `Scene "${id}" is still used by ${used.length} node(s): ${shown}${rest}`,
    );
  }

  const span = spanOfEntry(source, map, pair);
  if (!span) throw new SceneEditError(`Could not find scene "${id}" to remove`);
  const edits: Edit[] = [span];

  // A lobby pointing at a scene that has gone is the same dangling reference,
  // and the one nobody would think to look for: the show still runs, and the
  // hole is on screen only while the room is filling up.
  const notes: string[] = [];
  const root = rootOf(source);
  const lobby = pairFor(root, 'lobby');
  if (lobby && isScalar(lobby.value) && lobby.value.value === id) {
    const lobbySpan = spanOfEntry(source, root, lobby);
    if (lobbySpan) {
      edits.push(lobbySpan);
      notes.push(`The lobby pointed at "${id}", so it now paints nothing.`);
    }
  }

  return { source: applyEdits(source, edits), ...(notes.length > 0 ? { notes } : {}) };
}

/**
 * Renames a scene and every reference to it at once.
 *
 * An id is the only value other lines depend on by name, so this moves the key,
 * every node's `scene:` and the `lobby:` together or not at all — the same
 * reason `renameNode` is its own action rather than an edit to a text box.
 */
export function renameScene(source: string, from: string, to: string): SceneEdit {
  checkId(to);
  if (from === to) return { source };
  const map = scenesMapOf(source);
  const pair = sceneEntry(map, from);
  if (pairFor(map, to)) throw new SceneEditError(`There is already a scene called "${to}"`);

  const key = pair.key as { range?: [number, number, number] };
  if (!key.range) throw new SceneEditError(`Could not locate scene "${from}"`);
  const edits: Edit[] = [{ at: key.range[0], end: key.range[1], text: to }];

  const contents = rootOf(source);
  let moved = 0;
  const nodes = pairFor(contents, 'nodes');
  const items = (nodes?.value as { items?: unknown[] } | undefined)?.items ?? [];
  for (const item of items) {
    if (!isMap(item)) continue;
    const scene = pairFor(item, 'scene');
    if (!scene || !isScalar(scene.value) || scene.value.value !== from) continue;
    const range = scene.value.range;
    if (!range) continue;
    edits.push({ at: range[0], end: range[1], text: to });
    moved += 1;
  }

  const lobby = pairFor(contents, 'lobby');
  if (lobby && isScalar(lobby.value) && lobby.value.value === from && lobby.value.range) {
    const range = lobby.value.range;
    edits.push({ at: range[0], end: range[1], text: to });
  }

  const notes =
    moved > 0 ? [`Repointed ${moved} node${moved === 1 ? '' : 's'} at "${to}".`] : undefined;
  return { source: applyEdits(source, edits), ...(notes ? { notes } : {}) };
}

/**
 * Sets or clears the scenario's `lobby:`.
 *
 * Written next to `start:` when it is new, because the two say the same kind of
 * thing — where the show begins, and what is on the projector until it does.
 */
export function setLobby(source: string, id: string | null): string {
  const root = rootOf(source);
  const existing = pairFor(root, 'lobby');

  if (id === null) {
    if (!existing) return source;
    const span = spanOfEntry(source, root, existing);
    if (!span) throw new SceneEditError('Could not find lobby: to remove');
    return applyEdits(source, [span]);
  }

  const map = scenesMapOf(source);
  if (!pairFor(map, id)) throw new SceneEditError(`There is no scene "${id}" to use as the lobby`);

  if (existing && existing.value && isScalar(existing.value) && existing.value.range) {
    const [at, end] = existing.value.range;
    const text = source.slice(at, end).endsWith('\n') ? `${id}\n` : id;
    return applyEdits(source, [{ at, end, text }]);
  }

  const start = pairFor(root, 'start');
  if (start && isScalar(start.value) && start.value.range) {
    const newline = source.indexOf('\n', start.value.range[1]);
    const at = newline === -1 ? source.length : newline;
    return applyEdits(source, [{ at, text: `\nlobby: ${id}` }]);
  }

  const spot = insertionFor(source, root);
  return applyEdits(source, [{ at: spot.at, text: `\nlobby: ${id}` }]);
}
