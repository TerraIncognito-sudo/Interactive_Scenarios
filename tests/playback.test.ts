/**
 * Everything the scenario can declare has to reach the room.
 *
 * `music`, `ambience` and `sfx` were in the schema from the beginning. The
 * checker validated them, the board tracked them, the projector downloaded
 * them — and nothing ever opened one. A scenario could declare a harbour bed,
 * the board could report it finished and green, the display could spend
 * bandwidth prefetching it, and the audience heard silence with nothing
 * anywhere saying why. Voice was the only audio that ever played.
 *
 * That is a whole class of failure rather than one bug: a field is easy to add
 * to a schema, and the half that consumes it is in another program. So this
 * reads the display as text and insists every section it could be handed is
 * named there. Crude on purpose — a stricter check would need a DOM, and a
 * check that needs a browser is a check nobody runs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSET_SECTIONS,
  assetReferencesOf,
  assetsOf,
  parseScenarioSource,
} from '../src/scenario/load.ts';
import { beatOf, initialState, reduce } from '../src/engine/engine.ts';

const display = readFileSync(
  join(import.meta.dirname, '..', 'src', 'client', 'display', 'main.ts'),
  'utf8',
);

/** What the display would be handed for each kind of asset. */
const CONSUMED: Record<(typeof ASSET_SECTIONS)[number], RegExp> = {
  images: /backgroundImage/,
  video: /applySceneVideo/,
  voice: /playVoice\(/,
  sfx: /playSfx\(/,
  ambience: /ambience\.play\(/,
  music: /music\.play\(/,
};

describe('the projector opens everything the scenario declares', () => {
  for (const section of ASSET_SECTIONS) {
    test(`${section} is played, not merely downloaded`, () => {
      assert.match(display, CONSUMED[section], `nothing in the display consumes ${section}`);
    });
  }

  test('every section has an entry here, so a new one cannot be forgotten', () => {
    // The guard on the guard. Adding a media kind to the schema without adding
    // it to this table is how the silence happened the first time.
    assert.deepEqual(Object.keys(CONSUMED).sort(), [...ASSET_SECTIONS].sort());
  });
});

describe('a one-shot belongs to its line, a bed to its scene', () => {
  test('the scenario says so, and both are prefetched', () => {
    // The split this playback follows. `sfx` hangs off a line because it fires
    // with one; `ambience` and `music` hang off the scene because they persist
    // across every node played there — restarting the sea on every line would
    // be a stutter every few seconds.
    const parsed = parseScenarioSource(
      [
        'id: x',
        'title: X',
        'start: a',
        'scenes:',
        '  quay: { background: images/quay.jpg, ambience: ambience/harbour.mp3, music: music/pad.mp3 }',
        'nodes:',
        '  - id: a',
        '    type: dialogue',
        '    scene: quay',
        '    lines:',
        '      - { text: Away lines., hold: 3, voice: voice/a.mp3, sfx: sfx/depart.mp3 }',
        '    next: b',
        '  - id: b',
        '    type: end',
        '    text: Done',
        '',
      ].join('\n'),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);

    const refs = assetReferencesOf(parsed.scenario);
    const sfx = refs.find((ref) => ref.file === 'sfx/depart.mp3');
    assert.equal(sfx?.section, 'sfx');
    assert.equal(sfx?.origin.kind, 'sfx', 'a one-shot is filed against the line that fires it');

    const bed = refs.find((ref) => ref.file === 'ambience/harbour.mp3');
    assert.equal(bed?.section, 'ambience');
    assert.ok(bed && 'scene' in bed.origin, 'a bed is filed against the scene it belongs to');
  });
});

describe('a beat with no words in it', () => {
  /**
   * The hole this closed. A `pause` is four seconds of picture and nothing
   * else, and in a storyboard those are exactly the beats written *as* a sound
   * — a weapon firing, a hull impact, a room reacting to something nobody says
   * out loud. An effect could only hang off a line, so such a beat had nowhere
   * to carry audio at all, and the only way to give it any was to make it
   * dialogue, which puts a box on screen that the pause exists to leave off.
   */
  const scenario = () => {
    const parsed = parseScenarioSource(
      [
        'id: x',
        'title: X',
        'start: a',
        'scenes: { deck: { background: images/deck.jpg } }',
        'nodes:',
        '  - id: a',
        '    type: pause',
        '    scene: deck',
        '    duration: 4',
        '    sfx: sfx/ciws.mp3',
        '    next: b',
        '  - id: b',
        '    type: end',
        '    text: Done',
        '',
      ].join('\n'),
    );
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    return parsed.scenario;
  };

  test('the pause carries it, filed against the node rather than a line', () => {
    const ref = assetReferencesOf(scenario()).find((entry) => entry.file === 'sfx/ciws.mp3');
    assert.equal(ref?.section, 'sfx');
    assert.deepEqual(ref?.origin, { kind: 'sfx', node: 'a' });
    assert.ok(ref && !('line' in ref.origin), 'a pause has no lines to index against');
  });

  test('and it is prefetched like everything else', () => {
    // Otherwise the one sound the beat exists for streams in live, over the
    // four seconds it was supposed to fill.
    assert.ok(assetsOf(scenario()).includes('sfx/ciws.mp3'));
  });

  test('the beat the engine produces carries it to the projector', () => {
    const built = scenario();
    // Started, not merely loaded: an unstarted show sits in the lobby, and the
    // lobby's beat is `idle` whatever the first node is.
    const state = reduce(built, initialState(built), { type: 'start' });
    const beat = beatOf(built, state);
    assert.equal(beat.kind, 'pause');
    if (beat.kind === 'pause') {
      assert.equal(beat.sfx, 'sfx/ciws.mp3');
      assert.equal(beat.durationMs, 4000);
    }
  });

  test('the display plays a pause beat’s effect, not only a line’s', () => {
    // The half that would have been easy to leave out: the schema, the walk
    // and the snapshot can all carry it and the room still hears nothing.
    const pauseCase = display.slice(display.indexOf("case 'pause':"));
    assert.match(
      pauseCase.slice(0, pauseCase.indexOf("case 'poll':")),
      /playSfx\(beat\.sfx\)/,
      'the pause branch of renderBeat never opens it',
    );
  });
});

describe('the beds are mixed under the voice', () => {
  test('and the levels are stated where somebody can find them', () => {
    // Not a taste assertion — a check that the numbers exist as named
    // constants rather than being buried inline, since they are the first
    // thing an author will want to change after hearing it in a room.
    for (const name of ['AMBIENCE_VOLUME', 'MUSIC_VOLUME', 'SFX_VOLUME', 'FADE_MS']) {
      assert.match(display, new RegExp(`const ${name} =`), `${name} is a named level`);
    }
    // The voice is the thing an audience has to follow, so nothing may be
    // mixed at or above it.
    for (const [, value] of display.matchAll(/const (?:AMBIENCE|MUSIC|SFX)_VOLUME = ([\d.]+);/g)) {
      assert.ok(Number(value) < 1, `a bed mixed at ${value} would sit on top of the voice`);
    }
  });
});
