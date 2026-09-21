/**
 * A beat that ends when a person says so.
 *
 * The whole of a gate is an absence — no duration, so nothing schedules it —
 * and an absence is exactly the kind of thing that gets quietly filled in by
 * a later change. These tests are here to make that loud: if anything ever
 * gives a gate a `durationMs`, the show starts releasing itself in front of an
 * audience and the moderator's button becomes decoration.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, beatOf } from '../shared/engine/engine.ts';
import { ScenarioSchema, isLinear, type Scenario } from '../shared/scenario/schema.ts';

const scenario: Scenario = ScenarioSchema.parse({
  id: 'gate-test',
  title: 'Gate test',
  start: 'open',
  scenes: { room: {} },
  nodes: [
    { id: 'open', type: 'dialogue', scene: 'room', lines: [{ text: 'Before.' }], next: 'held' },
    { id: 'held', type: 'gate', text: 'Waiting.', label: 'Start', next: 'after' },
    { id: 'after', type: 'dialogue', lines: [{ text: 'After.' }], next: 'done' },
    { id: 'done', type: 'end', text: 'Done.' },
  ],
});

/** Walks to the gate the way the show does: start, then one advance. */
function atGate() {
  let state = reduce(scenario, initialState(scenario), { type: 'start' });
  state = reduce(scenario, state, { type: 'advance' });
  assert.equal(state.nodeId, 'held', 'the walk to the gate is the setup, not the assertion');
  return state;
}

describe('a gate', () => {
  test('is a beat with no duration, which is what stops any clock scheduling it', () => {
    const beat = beatOf(scenario, atGate());
    assert.equal(beat.kind, 'gate');
    // Written as a property check rather than a type assertion: the danger is
    // someone adding the field back, and a `kind` check would not notice.
    assert.ok(
      !('durationMs' in beat),
      'a gate that reports a duration is a gate the server will release on its own',
    );
  });

  test('carries the word the author chose for the moderator button', () => {
    const beat = beatOf(scenario, atGate());
    if (beat.kind !== 'gate') throw new Error('expected a gate beat');
    assert.equal(beat.label, 'Start');
    assert.equal(beat.text, 'Waiting.');
  });

  test('leaves on an advance, which only a person can send', () => {
    const released = reduce(scenario, atGate(), { type: 'advance' });
    assert.equal(released.nodeId, 'after');
    assert.equal(released.phase, 'playing');
  });

  test('rests in playing, so back and jump keep working while it holds', () => {
    const state = atGate();
    assert.equal(state.phase, 'playing');
    const back = reduce(scenario, state, { type: 'back' });
    assert.equal(back.nodeId, 'open', 'a moderator who gated too early has to be able to go back');
  });

  test('inherits the scene it was reached in rather than blanking the projector', () => {
    const beat = beatOf(scenario, atGate());
    if (beat.kind !== 'gate') throw new Error('expected a gate beat');
    // The gate declares no scene of its own; the display falls back to the
    // last one, so the picture the room is looking at simply stays up.
    assert.equal(beat.scene, undefined);
  });

  test('is linear: one way out, by next', () => {
    const node = scenario.nodes.find((n) => n.id === 'held');
    assert.ok(node && isLinear(node), 'a gate leaves by a single next, like a pause');
  });

  test('a pause still reports its authored duration, so the two have not been merged', () => {
    const withPause = ScenarioSchema.parse({
      id: 'p',
      title: 'P',
      start: 'hold',
      nodes: [
        { id: 'hold', type: 'pause', duration: 3, next: 'done' },
        { id: 'done', type: 'end' },
      ],
    });
    const beat = beatOf(withPause, reduce(withPause, initialState(withPause), { type: 'start' }));
    assert.equal(beat.kind, 'pause');
    if (beat.kind === 'pause') assert.equal(beat.durationMs, 3000);
  });
});

describe('the gate schema', () => {
  test('requires a next, because a held beat still has to lead somewhere', () => {
    assert.throws(() =>
      ScenarioSchema.parse({
        id: 'x',
        title: 'X',
        start: 'g',
        nodes: [{ id: 'g', type: 'gate' }],
      }),
    );
  });

  test('rejects a duration, so a gate can never be half a pause', () => {
    assert.throws(
      () =>
        ScenarioSchema.parse({
          id: 'x',
          title: 'X',
          start: 'g',
          nodes: [
            { id: 'g', type: 'gate', duration: 5, next: 'e' },
            { id: 'e', type: 'end' },
          ],
        }),
      'strictObject is what makes a stray duration: a loud error instead of a silent no-op',
    );
  });
});
