import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkScenario, exitsOf } from '../src/scenario/check.ts';
import { ScenarioSchema } from '../src/scenario/schema.ts';

/** Builds a scenario from a node list, with sensible surrounding defaults. */
function build(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return ScenarioSchema.parse({
    id: 'x',
    title: 'X',
    start: 'a',
    characters: { ada: { name: 'Ada' } },
    scenes: { room: {} },
    nodes,
    ...extra,
  });
}

const validNodes = [
  { id: 'a', type: 'dialogue', scene: 'room', lines: [{ who: 'ada', text: 'Hi.' }], next: 'b' },
  {
    id: 'b',
    type: 'poll',
    question: 'Q?',
    options: [
      { key: 'y', label: 'Yes', next: 'c' },
      { key: 'n', label: 'No', next: 'c' },
    ],
    default: 'n',
    set: { pick: '$winner' },
  },
  { id: 'c', type: 'branch', when: [{ if: "pick == 'y'", next: 'd' }], else: 'd' },
  { id: 'd', type: 'end' },
];

describe('exitsOf', () => {
  test('reports every outgoing edge per node type', () => {
    const scenario = build(validNodes);
    const byId = new Map(scenario.nodes.map((n) => [n.id, n]));
    assert.deepEqual(exitsOf(byId.get('a')!), ['b']);
    assert.deepEqual(exitsOf(byId.get('b')!), ['c', 'c']);
    assert.deepEqual(exitsOf(byId.get('c')!), ['d', 'd']);
    assert.deepEqual(exitsOf(byId.get('d')!), []);
  });
});

describe('checkScenario', () => {
  test('a well-formed scenario produces no errors or warnings', () => {
    const result = checkScenario(build(validNodes));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test('catches a dangling next pointer', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'dialogue', lines: [{ text: 'Hi.' }], next: 'nowhere' },
        { id: 'd', type: 'end' },
      ]),
    );
    assert.ok(result.errors.some((e) => e.message.includes('"nowhere"')));
  });

  test('catches a poll whose default is not one of its options', () => {
    const result = checkScenario(
      build([
        {
          id: 'a',
          type: 'poll',
          question: 'Q?',
          options: [
            { key: 'y', label: 'Yes', next: 'd' },
            { key: 'n', label: 'No', next: 'd' },
          ],
          default: 'maybe',
        },
        { id: 'd', type: 'end' },
      ]),
    );
    assert.ok(
      result.errors.some((e) => e.message.includes('nowhere to go')),
      'a zero-vote deadlock must be an error',
    );
  });

  test('catches duplicate node ids', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'dialogue', lines: [{ text: 'One.' }], next: 'a' },
        { id: 'a', type: 'end' },
      ]),
    );
    assert.ok(result.errors.some((e) => e.message.includes('Duplicate node id')));
  });

  test('catches a missing start node', () => {
    const result = checkScenario(build([{ id: 'z', type: 'end' }], { start: 'a' }));
    assert.ok(result.errors.some((e) => e.message.includes('start node')));
  });

  test('catches unknown character and scene references', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'dialogue', scene: 'ghost', lines: [{ who: 'nobody', text: 'Hi.' }], next: 'd' },
        { id: 'd', type: 'end' },
      ]),
    );
    assert.ok(result.errors.some((e) => e.message.includes('unknown scene "ghost"')));
    assert.ok(result.errors.some((e) => e.message.includes('unknown character "nobody"')));
  });

  test('catches a malformed branch condition', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'branch', when: [{ if: "pick = 'y'", next: 'd' }], else: 'd' },
        { id: 'd', type: 'end' },
      ]),
    );
    assert.ok(result.errors.some((e) => e.message.includes('not a valid expression')));
  });

  test('catches an unknown $placeholder in a poll set block', () => {
    const result = checkScenario(
      build([
        {
          id: 'a',
          type: 'poll',
          question: 'Q?',
          options: [
            { key: 'y', label: 'Yes', next: 'd' },
            { key: 'n', label: 'No', next: 'd' },
          ],
          default: 'n',
          set: { pick: '$winnner' },
        },
        { id: 'd', type: 'end' },
      ]),
    );
    assert.ok(result.errors.some((e) => e.message.includes('unknown placeholder')));
  });

  test('warns about a branch reading a variable no poll ever sets', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'branch', when: [{ if: "typo == 'y'", next: 'd' }], else: 'd' },
        { id: 'd', type: 'end' },
      ]),
    );
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some((w) => w.message.includes('"typo"')));
  });

  test('warns about unreachable nodes', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'dialogue', lines: [{ text: 'Hi.' }], next: 'd' },
        { id: 'd', type: 'end' },
        { id: 'orphan', type: 'dialogue', lines: [{ text: 'Alone.' }], next: 'd' },
      ]),
    );
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some((w) => w.nodeId === 'orphan'));
  });

  test('warns when no ending is reachable', () => {
    const result = checkScenario(
      build([
        { id: 'a', type: 'dialogue', lines: [{ text: 'Hi.' }], next: 'b' },
        { id: 'b', type: 'dialogue', lines: [{ text: 'Loop.' }], next: 'a' },
      ]),
    );
    assert.ok(result.warnings.some((w) => w.message.includes('no defined finish')));
  });
});

describe('schema strictness', () => {
  test('rejects an unknown key rather than silently ignoring it', () => {
    // A typo like `nxt:` must be loud at load time, not a dead end on stage.
    const parsed = ScenarioSchema.safeParse({
      id: 'x',
      title: 'X',
      start: 'a',
      nodes: [{ id: 'a', type: 'dialogue', lines: [{ text: 'Hi.' }], nxt: 'b' }],
    });
    assert.equal(parsed.success, false);
  });

  test('requires a default on every poll', () => {
    const parsed = ScenarioSchema.safeParse({
      id: 'x',
      title: 'X',
      start: 'a',
      nodes: [
        {
          id: 'a',
          type: 'poll',
          question: 'Q?',
          options: [
            { key: 'y', label: 'Yes', next: 'a' },
            { key: 'n', label: 'No', next: 'a' },
          ],
        },
      ],
    });
    assert.equal(parsed.success, false);
  });

  test('requires at least two poll options', () => {
    const parsed = ScenarioSchema.safeParse({
      id: 'x',
      title: 'X',
      start: 'a',
      nodes: [
        {
          id: 'a',
          type: 'poll',
          question: 'Q?',
          options: [{ key: 'y', label: 'Yes', next: 'a' }],
          default: 'y',
        },
      ],
    });
    assert.equal(parsed.success, false);
  });

  test('applies documented defaults for omitted settings', () => {
    const scenario = build(validNodes);
    assert.equal(scenario.settings.wordsPerMinute, 160);
    assert.equal(scenario.settings.minLineSeconds, 2);
    assert.equal(scenario.settings.charsPerSecond, 45);
    // poll duration and tiebreak defaults
    const poll = scenario.nodes.find((n) => n.id === 'b');
    assert.equal(poll?.type === 'poll' && poll.duration, 120);
    assert.equal(poll?.type === 'poll' && poll.tiebreak, 'first');
  });
});
