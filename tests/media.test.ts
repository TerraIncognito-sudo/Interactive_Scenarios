/**
 * Voice-over on a line and a looping clip on a scene.
 *
 * The point of these is the preflight: an author writing a voiced scenario
 * finds out at their desk that a clip is unplayable or that a line's time on
 * screen is still a guess, rather than in front of an audience with a
 * narrator being cut off mid-sentence.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioSchema } from '../shared/scenario/schema.ts';
import { checkScenario } from '../shared/scenario/check.ts';
import { assetsOf, assetReferencesOf } from '../shared/scenario/load.ts';
import { initialState, reduce, sceneMediaOf } from '../shared/engine/engine.ts';

function build(scenes: Record<string, unknown>, lines: unknown[]) {
  return ScenarioSchema.parse({
    id: 'x',
    title: 'X',
    start: 'a',
    characters: { ada: { name: 'Ada' } },
    scenes,
    nodes: [
      { id: 'a', type: 'dialogue', scene: Object.keys(scenes)[0], lines, next: 'z' },
      { id: 'z', type: 'end' },
    ],
  });
}

const stillScene = { room: { background: 'room.jpg' } };
const movingScene = { room: { background: 'room.jpg', video: 'room.mp4' } };

describe('the schema carries media', () => {
  test('a line accepts a voice clip and a scene accepts a video', () => {
    const scenario = build(movingScene, [{ text: 'Hi.', hold: 3, voice: 'line-1.mp3' }]);
    assert.equal(scenario.scenes.room?.video, 'room.mp4');
    assert.equal(scenario.scenes.room?.background, 'room.jpg');

    const node = scenario.nodes[0]!;
    assert.equal(node.type, 'dialogue');
    assert.equal(node.type === 'dialogue' && node.lines[0]?.voice, 'line-1.mp3');
  });

  test('both fields stay optional, so existing scenarios are untouched', () => {
    const scenario = build(stillScene, [{ text: 'Hi.' }]);
    assert.equal(scenario.scenes.room?.video, undefined);
    const node = scenario.nodes[0]!;
    assert.equal(node.type === 'dialogue' && node.lines[0]?.voice, undefined);
  });

  test('a near-miss key is still a loud error rather than a silent no-op', () => {
    // The whole reason these objects are strict: `voiceover:` would otherwise
    // load fine and simply never play.
    assert.throws(() => build(stillScene, [{ text: 'Hi.', voiceover: 'line-1.mp3' }]));
    assert.throws(() => ScenarioSchema.parse({
      id: 'x',
      title: 'X',
      start: 'a',
      scenes: { room: { background: 'room.jpg', movie: 'room.mp4' } },
      nodes: [{ id: 'a', type: 'end' }],
    }));
  });
});

describe('assetsOf', () => {
  test('collects voice clips and scene video alongside everything else', () => {
    const scenario = build(
      { room: { background: 'room.jpg', video: 'room.mp4', music: 'bed.mp3' } },
      [
        { text: 'One.', hold: 2, voice: 'line-1.mp3' },
        { text: 'Two.', hold: 2, voice: 'line-2.mp3', sfx: 'door.mp3' },
      ],
    );

    assert.deepEqual(assetsOf(scenario), [
      'bed.mp3',
      'door.mp3',
      'line-1.mp3',
      'line-2.mp3',
      'room.jpg',
      'room.mp4',
    ]);
  });

  test('the same clip reused across lines is prefetched once', () => {
    const scenario = build(stillScene, [
      { text: 'One.', hold: 2, voice: 'sting.mp3' },
      { text: 'Two.', hold: 2, voice: 'sting.mp3' },
    ]);
    assert.deepEqual(assetsOf(scenario), ['room.jpg', 'sting.mp3']);
  });
});

describe('checkScenario on media', () => {
  test('a fully specified voiced scene passes clean', () => {
    const result = checkScenario(
      build(movingScene, [{ text: 'Hi.', hold: 3, voice: 'line-1.mp3' }]),
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test('a voice clip that is not audio is an error', () => {
    const result = checkScenario(
      build(stillScene, [{ text: 'Hi.', hold: 3, voice: 'line-1.png' }]),
    );
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /line 1 has voice "line-1\.png"/);
    assert.equal(result.errors[0]!.nodeId, 'a');
  });

  test('a scene video that is not a video is an error', () => {
    const result = checkScenario(
      build({ room: { background: 'room.jpg', video: 'room.gif' } }, [{ text: 'Hi.' }]),
    );
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /scene "room" has video "room\.gif"/);
  });

  test('a voiced line with no hold warns, because its length is still a guess', () => {
    const result = checkScenario(build(stillScene, [{ text: 'Hi.', voice: 'line-1.mp3' }]));
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!.message, /voice clip but no hold/);
    assert.equal(result.warnings[0]!.nodeId, 'a');
  });

  test('a video with no poster still warns', () => {
    const result = checkScenario(
      build({ room: { video: 'room.mp4' } }, [{ text: 'Hi.' }]),
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!.message, /no background to use as its poster frame/);
  });

  test('an unheld line without voice is not warned about', () => {
    // The estimate is the intended behaviour for text-only lines; warning on
    // those would bury the one warning that matters.
    const result = checkScenario(build(stillScene, [{ text: 'Hi.' }]));
    assert.deepEqual(result.warnings, []);
  });
});

describe('a node can carry its own shot', () => {
  /**
   * A scene is a place; a shot is a camera setup, and a place gets several.
   * Before this, a second still in one room needed a second scene — which made
   * "scene" stop meaning "place" and would re-trigger its music every beat.
   */
  function shots() {
    return ScenarioSchema.parse({
      id: 'x',
      title: 'X',
      start: 'wide',
      scenes: { room: { background: 'room.jpg', music: 'bed.mp3', ambience: 'hum.mp3' } },
      nodes: [
        { id: 'wide', type: 'dialogue', scene: 'room', lines: [{ text: 'One.' }], next: 'close' },
        {
          id: 'close',
          type: 'dialogue',
          background: 'close.jpg',
          video: 'close.mp4',
          lines: [{ text: 'Two.' }],
          next: 'after',
        },
        { id: 'after', type: 'dialogue', lines: [{ text: 'Three.' }], next: 'z' },
        { id: 'z', type: 'end' },
      ],
    });
  }

  function at(scenario: ReturnType<typeof shots>, nodeId: string) {
    // Started properly rather than hand-built: history is what carries the
    // scene forward, and only entering a node writes to it.
    let state = reduce(scenario, initialState(scenario), { type: 'start' });
    while (state.nodeId !== nodeId) state = reduce(scenario, state, { type: 'advance' });
    return sceneMediaOf(scenario, state);
  }

  test('the node overrides the scene while it plays', () => {
    const scenario = shots();
    assert.equal(at(scenario, 'wide')?.background, 'room.jpg');
    assert.equal(at(scenario, 'close')?.background, 'close.jpg');
    assert.equal(at(scenario, 'close')?.video, 'close.mp4');
  });

  test('the override does not leak into the next node', () => {
    // An override belongs to the node that declared it. Inheriting it forward
    // would make the picture depend on which way the audience voted.
    assert.equal(at(shots(), 'after')?.background, 'room.jpg');
  });

  test('the place keeps its music and ambience through the override', () => {
    const media = at(shots(), 'close');
    assert.equal(media?.id, 'room');
    assert.equal(media?.music, 'bed.mp3');
    assert.equal(media?.ambience, 'hum.mp3');
  });

  test('a node still is an image and a node clip is video', () => {
    const refs = assetReferencesOf(shots());
    const find = (file: string) => refs.find((r) => r.file === file);
    assert.equal(find('close.jpg')?.section, 'images');
    assert.equal(find('close.mp4')?.section, 'video');
    // Origin points at the node, which is what lets the storyboard attach that
    // shot's prompt to it rather than the establishing shot's.
    assert.deepEqual(find('close.jpg')?.origin, { kind: 'background', node: 'close' });
    assert.ok(assetsOf(shots()).includes('close.jpg'), 'prefetched with everything else');
  });

  test('a node clip that is not a video file is an error', () => {
    const bad = ScenarioSchema.parse({
      id: 'x',
      title: 'X',
      start: 'a',
      scenes: { room: { background: 'room.jpg' } },
      nodes: [
        { id: 'a', type: 'dialogue', scene: 'room', video: 'clip.png', lines: [{ text: 'Hi.' }], next: 'z' },
        { id: 'z', type: 'end' },
      ],
    });
    assert.ok(checkScenario(bad).errors.some((e) => e.nodeId === 'a' && /not a video file/.test(e.message)));
  });

  test('a still from one shot under a clip from another is worth saying out loud', () => {
    const mixed = ScenarioSchema.parse({
      id: 'x',
      title: 'X',
      start: 'a',
      scenes: { room: { background: 'room.jpg', video: 'room.mp4' } },
      nodes: [
        { id: 'a', type: 'dialogue', scene: 'room', background: 'close.jpg', lines: [{ text: 'Hi.' }], next: 'z' },
        { id: 'z', type: 'end' },
      ],
    });
    const warnings = checkScenario(mixed).warnings;
    assert.ok(
      warnings.some((w) => w.nodeId === 'a' && /two different shots/.test(w.message)),
      JSON.stringify(warnings),
    );
  });
});
