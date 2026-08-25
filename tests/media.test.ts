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
import { ScenarioSchema } from '../src/scenario/schema.ts';
import { checkScenario } from '../src/scenario/check.ts';
import { assetsOf } from '../src/scenario/load.ts';

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
