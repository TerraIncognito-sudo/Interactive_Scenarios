import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  reduce,
  beatOf,
  openPoll,
  activeScene,
  EngineError,
  type RunState,
} from '../src/engine/engine.ts';
import { resolvePoll } from '../src/engine/votes.ts';
import { ScenarioSchema, type Scenario } from '../src/scenario/schema.ts';

/**
 * A compact scenario covering every node type and a branch that reads a
 * variable set by an earlier poll.
 */
const scenario: Scenario = ScenarioSchema.parse({
  id: 'test',
  title: 'Test',
  start: 'open',
  characters: { ada: { name: 'Ada' } },
  scenes: { room: {}, hall: {} },
  nodes: [
    {
      id: 'open',
      type: 'dialogue',
      scene: 'room',
      lines: [
        { who: 'ada', text: 'One.' },
        { who: 'ada', text: 'Two.' },
      ],
      next: 'vote',
    },
    {
      id: 'vote',
      type: 'poll',
      scene: 'hall',
      question: 'Which way?',
      duration: 60,
      options: [
        { key: 'left', label: 'Left', next: 'went_left' },
        { key: 'right', label: 'Right', next: 'went_right' },
      ],
      default: 'right',
      set: { path: '$winner' },
    },
    { id: 'went_left', type: 'dialogue', lines: [{ text: 'Left.' }], next: 'decide' },
    { id: 'went_right', type: 'dialogue', lines: [{ text: 'Right.' }], next: 'decide' },
    {
      id: 'decide',
      type: 'branch',
      when: [{ if: "path == 'left'", next: 'hold' }],
      else: 'finish',
    },
    { id: 'hold', type: 'pause', duration: 3, text: 'Beat.', next: 'finish' },
    { id: 'finish', type: 'end', text: 'Done.' },
  ],
});

function startedState(): RunState {
  return reduce(scenario, initialState(scenario), { type: 'start' });
}

/** Drives a poll to a decision with a given tally. */
function closePollWith(state: RunState, counts: Record<string, number>): RunState {
  const node = scenario.nodes.find((n) => n.id === state.nodeId);
  assert.equal(node?.type, 'poll');
  const result = resolvePoll(node as never, counts);
  return reduce(scenario, state, { type: 'pollClosed', result });
}

describe('engine lifecycle', () => {
  test('starts idle and does nothing until started', () => {
    const state = initialState(scenario);
    assert.equal(state.phase, 'idle');
    assert.deepEqual(beatOf(scenario, state), { kind: 'idle' });
    // advance before start is a no-op rather than an error
    assert.equal(reduce(scenario, state, { type: 'advance' }).phase, 'idle');
  });

  test('start enters the first node', () => {
    const state = startedState();
    assert.equal(state.nodeId, 'open');
    assert.equal(state.phase, 'playing');
    assert.equal(state.lineIndex, 0);
    assert.equal(state.beat, 1);
  });

  test('advance walks lines before leaving the node', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    assert.equal(state.nodeId, 'open');
    assert.equal(state.lineIndex, 1);

    state = reduce(scenario, state, { type: 'advance' });
    assert.equal(state.nodeId, 'vote');
    assert.equal(state.phase, 'polling');
  });

  test('the beat counter only ever increases', () => {
    let state = startedState();
    let last = state.beat;
    for (const event of [{ type: 'advance' }, { type: 'advance' }] as const) {
      state = reduce(scenario, state, event);
      assert.ok(state.beat > last, `beat went ${last} -> ${state.beat}`);
      last = state.beat;
    }
  });
});

describe('polls and branching', () => {
  test('a poll result routes to the matching option and sets variables', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    assert.equal(state.phase, 'polling');

    state = closePollWith(state, { left: 5, right: 1 });
    assert.equal(state.nodeId, 'went_left');
    assert.equal(state.vars.path, 'left');
  });

  test('branch nodes resolve instantly and are never rested on', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    state = closePollWith(state, { left: 5, right: 1 });
    state = reduce(scenario, state, { type: 'advance' }); // leave went_left

    // "decide" is a branch; the engine must land past it, on "hold".
    assert.equal(state.nodeId, 'hold');
    assert.equal(state.phase, 'playing');
    assert.notEqual(beatOf(scenario, state).kind, 'idle');
  });

  test('the other branch path reaches a different node', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    state = closePollWith(state, { left: 1, right: 5 });
    assert.equal(state.nodeId, 'went_right');
    assert.equal(state.vars.path, 'right');

    state = reduce(scenario, state, { type: 'advance' });
    assert.equal(state.nodeId, 'finish');
    assert.equal(state.phase, 'finished');
  });

  test('a poll with zero votes takes the default and the show continues', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    state = closePollWith(state, {});

    assert.equal(state.nodeId, 'went_right'); // default: right
    assert.equal(state.lastPollResult?.usedDefault, true);
    assert.equal(state.phase, 'playing');
  });

  test('every branch path terminates at an end node', () => {
    const tallies: Record<string, number>[] = [{ left: 1 }, { right: 1 }, {}];
    for (const counts of tallies) {
      let state = startedState();
      for (let i = 0; i < 50 && state.phase !== 'finished'; i++) {
        if (state.phase === 'polling') {
          state = closePollWith(state, counts);
        } else {
          state = reduce(scenario, state, { type: 'advance' });
        }
      }
      assert.equal(state.phase, 'finished', `counts=${JSON.stringify(counts)}`);
      assert.equal(state.nodeId, 'finish');
    }
  });

  test('openPoll stamps a deadline from the node duration', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    state = openPoll(scenario, state, 1_000_000);
    assert.equal(state.poll?.endsAt, 1_000_000 + 60_000);

    const beat = beatOf(scenario, state);
    assert.equal(beat.kind, 'poll');
    if (beat.kind === 'poll') {
      assert.equal(beat.endsAt, 1_060_000);
      assert.deepEqual(
        beat.options.map((o) => o.key),
        ['left', 'right'],
      );
    }
  });

  test('extendPoll pushes the deadline out', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    state = openPoll(scenario, state, 1_000_000);
    state = reduce(scenario, state, { type: 'extendPoll', seconds: 30 });
    assert.equal(state.poll?.endsAt, 1_090_000);
  });

  test('advance during a poll is ignored — only closing the poll moves on', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    const before = state;
    assert.deepEqual(reduce(scenario, state, { type: 'advance' }), before);
  });
});

describe('host overrides', () => {
  test('jump moves anywhere, including out of a poll', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    assert.equal(state.phase, 'polling');

    state = reduce(scenario, state, { type: 'jump', nodeId: 'went_right' });
    assert.equal(state.nodeId, 'went_right');
    assert.equal(state.phase, 'playing');
    assert.equal(state.poll, undefined);
  });

  test('jump to an unknown node is a clean error, not a corrupt state', () => {
    const state = startedState();
    assert.throws(() => reduce(scenario, state, { type: 'jump', nodeId: 'nope' }), EngineError);
  });

  test('back returns to the previous node', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' }); // now at 'vote'
    assert.equal(state.nodeId, 'vote');

    state = reduce(scenario, state, { type: 'back' });
    assert.equal(state.nodeId, 'open');
  });

  test('back at the very beginning is a no-op', () => {
    const state = startedState();
    assert.equal(reduce(scenario, state, { type: 'back' }).nodeId, 'open');
  });

  test('pause and resume gate advancing', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'pause' });
    assert.equal(state.phase, 'paused');

    const stalled = reduce(scenario, state, { type: 'advance' });
    assert.equal(stalled.lineIndex, 0, 'paused shows must not advance');

    state = reduce(scenario, state, { type: 'resume' });
    assert.equal(state.phase, 'playing');
    state = reduce(scenario, state, { type: 'advance' });
    assert.equal(state.lineIndex, 1);
  });
});

describe('rendering helpers', () => {
  test('beatOf describes the current line with a duration', () => {
    const beat = beatOf(scenario, startedState());
    assert.equal(beat.kind, 'dialogue');
    if (beat.kind === 'dialogue') {
      assert.equal(beat.line.text, 'One.');
      assert.ok(beat.durationMs >= 2000, 'short lines still get the minimum hold');
    }
  });

  test('a pause beat reports its authored duration', () => {
    let state = startedState();
    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' });
    state = closePollWith(state, { left: 1 });
    state = reduce(scenario, state, { type: 'advance' });

    const beat = beatOf(scenario, state);
    assert.equal(beat.kind, 'pause');
    if (beat.kind === 'pause') {
      assert.equal(beat.durationMs, 3000);
      assert.equal(beat.text, 'Beat.');
    }
  });

  test('scene is sticky until a later node changes it', () => {
    let state = startedState();
    assert.equal(activeScene(scenario, state), 'room');

    state = reduce(scenario, state, { type: 'advance' });
    state = reduce(scenario, state, { type: 'advance' }); // 'vote' declares scene 'hall'
    assert.equal(activeScene(scenario, state), 'hall');

    // 'went_left' declares no scene, so 'hall' persists.
    state = closePollWith(state, { left: 1 });
    assert.equal(activeScene(scenario, state), 'hall');
  });
});

describe('malformed scenarios', () => {
  test('a cycle of branch nodes is reported rather than hanging', () => {
    const looping = ScenarioSchema.parse({
      id: 'loop',
      title: 'Loop',
      start: 'a',
      nodes: [
        { id: 'a', type: 'branch', when: [{ if: 'false', next: 'b' }], else: 'b' },
        { id: 'b', type: 'branch', when: [{ if: 'false', next: 'a' }], else: 'a' },
      ],
    });
    assert.throws(
      () => reduce(looping, initialState(looping), { type: 'start' }),
      /cycle/i,
    );
  });
});
