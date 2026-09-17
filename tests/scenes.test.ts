/**
 * Scenes as structure, and the one thing that must survive every edit: the
 * author's own file. These actions run against scenarios full of comments and
 * hand-wrapped prose, so each case here checks what was *not* touched as
 * closely as what was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addScene,
  removeScene,
  renameScene,
  setLobby,
  setSceneField,
  usersOf,
  SceneEditError,
  type SceneField,
} from '../client/app/scenes.ts';
import { parseScenarioSource } from '../shared/scenario/load.ts';

const SOURCE = `id: demo
title: Demo
start: opening

characters:
  narr: { name: Narrator }

scenes:
  # Act A happens here, and this comment is load-bearing to the author.
  harbour: { background: images/jetty.png, ambience: ambience/harbour.mp3 }
  deck:
    background: images/deck.png
  empty: { }

nodes:
  - id: opening
    type: dialogue
    scene: harbour
    lines:
      - who: narr
        text: A line.
    next: second
  - id: second
    type: dialogue
    scene: deck
    lines:
      - who: narr
        text: Another.
    next: done
  - id: done
    type: end
    text: Finished.
`;

/** Every action has to leave a file the show can still open. */
function loads(source: string) {
  const result = parseScenarioSource(source);
  assert.equal(result.ok, true, `scenario did not load: ${JSON.stringify(result)}`);
  return result;
}

test('setting a field on an inline scene keeps it inline', () => {
  const out = setSceneField(SOURCE, 'harbour', 'video', 'video/harbour.mp4');
  assert.match(out, /harbour: \{ background: images\/jetty\.png, ambience: ambience\/harbour\.mp3, video: video\/harbour\.mp4 \}/);
  // A flow map that lost its comma would be `{ a, }` — legal, and a diff that
  // looks like damage.
  assert.doesNotMatch(out, /,\s*\}/);
  assert.ok(out.includes('# Act A happens here'), 'the comment survived');
  loads(out);
});

test('setting a field on a block scene adds a line under it', () => {
  const out = setSceneField(SOURCE, 'deck', 'video', 'video/deck.mp4');
  assert.match(out, /deck:\n    background: images\/deck\.png\n    video: video\/deck\.mp4/);
  loads(out);
});

test('an existing field is replaced rather than duplicated', () => {
  const out = setSceneField(SOURCE, 'deck', 'background', 'images/other.png');
  assert.ok(out.includes('images/other.png'));
  assert.ok(!out.includes('images/deck.png'));
  assert.equal(out.match(/background:/g)?.length, SOURCE.match(/background:/g)?.length);
  loads(out);
});

test('clearing a field removes it, and never leaves an empty value behind', () => {
  const out = setSceneField(SOURCE, 'deck', 'background', null);
  assert.ok(!out.includes('images/deck.png'));
  assert.doesNotMatch(out, /background:\s*\n/);
  loads(out);
});

test('a new scene is born valid and empty', () => {
  const out = addScene(SOURCE, 'wardroom');
  assert.match(out, /wardroom: \{ \}/);
  const parsed = loads(out);
  if (parsed.ok) assert.ok('wardroom' in parsed.scenario.scenes);
});

test('a duplicate id is refused rather than silently merged', () => {
  assert.throws(() => addScene(SOURCE, 'harbour'), SceneEditError);
});

test('an invalid id is refused', () => {
  assert.throws(() => addScene(SOURCE, 'Ward Room'), SceneEditError);
});

test('a scene still in use cannot be removed, and the message names the nodes', () => {
  assert.equal(usersOf(SOURCE, 'harbour').join(','), 'opening');
  assert.throws(
    () => removeScene(SOURCE, 'harbour'),
    (error: Error) => error instanceof SceneEditError && /opening/.test(error.message),
  );
});

test('an unused scene is removed cleanly', () => {
  const result = removeScene(SOURCE, 'empty');
  assert.ok(!result.source.includes('empty:'));
  assert.ok(result.source.includes('harbour:'), 'took only the one it was asked for');
  loads(result.source);
});

test('renaming moves the key and every node that pointed at it', () => {
  const result = renameScene(SOURCE, 'harbour', 'jetty');
  assert.match(result.source, /jetty: \{ background/);
  assert.match(result.source, /scene: jetty/);
  assert.ok(!result.source.includes('scene: harbour'));
  // Reported rather than silent: a rename that repoints two nodes and says
  // nothing is indistinguishable from one that did not work.
  assert.match(result.notes?.[0] ?? '', /1 node/);
  loads(result.source);
});

test('renaming carries the lobby with it', () => {
  const withLobby = setLobby(SOURCE, 'harbour');
  const result = renameScene(withLobby, 'harbour', 'jetty');
  assert.match(result.source, /lobby: jetty/);
  loads(result.source);
});

test('the lobby is written beside start, and only ever names a real scene', () => {
  const out = setLobby(SOURCE, 'harbour');
  assert.match(out, /start: opening\nlobby: harbour/);
  const parsed = loads(out);
  if (parsed.ok) assert.equal(parsed.scenario.lobby, 'harbour');
  assert.throws(() => setLobby(SOURCE, 'nowhere'), SceneEditError);
});

test('setting the lobby twice replaces rather than repeats it', () => {
  const once = setLobby(SOURCE, 'harbour');
  const twice = setLobby(once, 'deck');
  assert.equal(twice.match(/lobby:/g)?.length, 1);
  assert.match(twice, /lobby: deck/);
  loads(twice);
});

test('clearing the lobby removes the key', () => {
  const out = setLobby(setLobby(SOURCE, 'harbour'), null);
  assert.ok(!out.includes('lobby:'));
  loads(out);
});

test('removing the scene the lobby points at clears the lobby and says so', () => {
  const withLobby = setLobby(SOURCE, 'empty');
  const result = removeScene(withLobby, 'empty');
  assert.ok(!result.source.includes('lobby:'), 'no dangling lobby reference left behind');
  assert.match(result.notes?.[0] ?? '', /lobby/i);
  loads(result.source);
});

test('the first field on a brand-new scene lands — an empty flow map takes no comma', () => {
  // The Add button makes `{ }`, which has nothing to separate from, so a comma
  // produced `{, video: … }` — not YAML at all. The write was refused and the
  // field appeared to undo itself, which made the first field of every new
  // place impossible to set.
  const added = addScene(SOURCE, 'preshow');
  const out = setSceneField(added, 'preshow', 'video', 'video/on_patrol.mp4');
  assert.match(out, /preshow: \{ video: video\/on_patrol\.mp4 \}/);
  assert.doesNotMatch(out, /\{\s*,/);
  const parsed = loads(out);
  if (parsed.ok) assert.equal(parsed.scenario.scenes.preshow?.video, 'video/on_patrol.mp4');
});

test('the same holds for a scene already written empty in the file', () => {
  // `debrief: { }` is written by hand in real scenarios, so this is not only a
  // new-scene problem — it was every one of them.
  const out = setSceneField(SOURCE, 'empty', 'background', 'images/x.png');
  assert.match(out, /empty: \{ background: images\/x\.png \}/);
  loads(out);
});

test('every field can be the first one set on an empty scene', () => {
  // Each field's own kind of file: the checker rejects a `video:` that is not a
  // video, so one placeholder for all four would fail for reasons that have
  // nothing to do with what is being tested here.
  const files: Record<SceneField, string> = {
    background: 'images/x.png',
    video: 'video/x.mp4',
    music: 'music/x.mp3',
    ambience: 'ambience/x.mp3',
  };
  for (const [field, file] of Object.entries(files) as [SceneField, string][]) {
    const out = setSceneField(SOURCE, 'empty', field, file);
    assert.match(out, new RegExp(`empty: \{ ${field}: ${file.replace('/', '\/')} \}`), field);
    loads(out);
  }
});

test('a second field on a now-populated scene does take the comma', () => {
  const once = setSceneField(SOURCE, 'empty', 'background', 'images/x.png');
  const twice = setSceneField(once, 'empty', 'video', 'video/y.mp4');
  assert.match(twice, /empty: \{ background: images\/x\.png, video: video\/y\.mp4 \}/);
  loads(twice);
});
