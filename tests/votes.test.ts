import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BallotBox, resolvePoll, variablesFrom } from '../src/engine/votes.ts';
import { PollNodeSchema, type PollNode } from '../src/scenario/schema.ts';

function poll(overrides: Partial<PollNode> = {}): PollNode {
  return PollNodeSchema.parse({
    id: 'p',
    type: 'poll',
    question: 'Which way?',
    options: [
      { key: 'a', label: 'Left', next: 'n1' },
      { key: 'b', label: 'Right', next: 'n2' },
      { key: 'c', label: 'Back', next: 'n3' },
    ],
    default: 'b',
    ...overrides,
  });
}

describe('BallotBox', () => {
  test('counts one vote per device', () => {
    const box = new BallotBox(['a', 'b']);
    box.cast('d1', 'a', 1);
    box.cast('d2', 'a', 2);
    box.cast('d3', 'b', 3);
    assert.deepEqual(box.counts(), { a: 2, b: 1 });
    assert.equal(box.voterCount, 3);
  });

  test('a device changing its mind replaces its earlier vote', () => {
    const box = new BallotBox(['a', 'b']);
    box.cast('d1', 'a', 1);
    box.cast('d1', 'b', 2);
    box.cast('d1', 'a', 3);
    assert.deepEqual(box.counts(), { a: 1, b: 0 });
    assert.equal(box.voterCount, 1);
    assert.equal(box.choiceOf('d1'), 'a');
  });

  test('rejects option keys that are not on the poll', () => {
    const box = new BallotBox(['a', 'b']);
    assert.equal(box.cast('d1', 'zzz', 1), false);
    assert.equal(box.cast('d1', 'a', 1), true);
    assert.deepEqual(box.counts(), { a: 1, b: 0 });
  });

  test('reports a device choice so a reconnecting phone restores its selection', () => {
    const box = new BallotBox(['a', 'b']);
    box.cast('d1', 'b', 1);
    assert.equal(box.choiceOf('d1'), 'b');
    assert.equal(box.choiceOf('unknown'), undefined);
  });
});

describe('resolvePoll', () => {
  test('plurality wins', () => {
    const result = resolvePoll(poll(), { a: 5, b: 3, c: 1 });
    assert.equal(result.winner, 'a');
    assert.equal(result.winnerLabel, 'Left');
    assert.equal(result.total, 9);
    assert.equal(result.usedDefault, false);
    assert.equal(result.usedTiebreak, false);
  });

  test('zero votes falls back to the declared default, never deadlocks', () => {
    for (const tiebreak of ['first', 'random', 'weighted'] as const) {
      const result = resolvePoll(poll({ tiebreak }), { a: 0, b: 0, c: 0 });
      assert.equal(result.winner, 'b', `tiebreak=${tiebreak}`);
      assert.equal(result.usedDefault, true);
      assert.equal(result.total, 0);
    }
  });

  test('tiebreak "first" takes declaration order', () => {
    const result = resolvePoll(poll({ tiebreak: 'first' }), { a: 4, b: 4, c: 1 });
    assert.equal(result.winner, 'a');
    assert.equal(result.usedTiebreak, true);
  });

  test('tiebreak "random" picks among the tied options only', () => {
    // rng near 1 must still land inside the tied set, not off the end.
    const high = resolvePoll(poll({ tiebreak: 'random' }), { a: 0, b: 4, c: 4 }, () => 0.999999);
    assert.ok(['b', 'c'].includes(high.winner));

    const low = resolvePoll(poll({ tiebreak: 'random' }), { a: 0, b: 4, c: 4 }, () => 0);
    assert.equal(low.winner, 'b');
    assert.equal(low.usedTiebreak, true);
  });

  test('tiebreak "weighted" follows vote share', () => {
    const counts = { a: 6, b: 4, c: 0 };
    // roll = 0.1 * 10 = 1 -> inside a's block
    assert.equal(resolvePoll(poll({ tiebreak: 'weighted' }), counts, () => 0.1).winner, 'a');
    // roll = 0.7 * 10 = 7 -> past a (6), inside b's block
    assert.equal(resolvePoll(poll({ tiebreak: 'weighted' }), counts, () => 0.7).winner, 'b');
    // an option with zero votes can never win
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      assert.notEqual(resolvePoll(poll({ tiebreak: 'weighted' }), counts, () => r).winner, 'c');
    }
  });

  test('counts always include every option so charts stay stable', () => {
    const result = resolvePoll(poll(), { a: 2 });
    assert.deepEqual(result.counts, { a: 2, b: 0, c: 0 });
  });

  test('the winner is always a real option key', () => {
    const node = poll({ tiebreak: 'random' });
    const keys = node.options.map((o) => o.key);
    for (let i = 0; i < 200; i++) {
      const result = resolvePoll(node, { a: 3, b: 3, c: 3 }, () => i / 200);
      assert.ok(keys.includes(result.winner));
    }
  });
});

describe('variablesFrom', () => {
  test('expands the documented placeholders', () => {
    const node = poll({ set: { pick: '$winner', label: '$winnerLabel', n: '$total' } });
    const result = resolvePoll(node, { a: 3, b: 1, c: 0 });
    assert.deepEqual(variablesFrom(node, result), {
      pick: 'a',
      label: 'Left',
      n: '4',
    });
  });

  test('passes literals through unchanged', () => {
    const node = poll({ set: { chapter: 'two' } });
    const result = resolvePoll(node, { a: 1 });
    assert.deepEqual(variablesFrom(node, result), { chapter: 'two' });
  });

  test('returns nothing when the node sets nothing', () => {
    const node = poll();
    assert.deepEqual(variablesFrom(node, resolvePoll(node, { a: 1 })), {});
  });
});
