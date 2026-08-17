/**
 * The editor's analysis and simulation.
 *
 * The simulator runs the production engine, so these tests double as proof
 * that an author previewing a branch at their desk sees exactly what a room
 * full of people will see on the night.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeScenario, simulate } from '../tools/editor/analysis.ts';
import { parseScenarioSource } from '../src/scenario/load.ts';

const SOURCE = `
id: memory
title: Memory
start: open

settings:
  wordsPerMinute: 600
  minLineSeconds: 1
  maxLineSeconds: 1

characters:
  ada: { name: Ada }

scenes:
  room: {}

nodes:
  - id: open
    type: dialogue
    scene: room
    lines:
      - { who: ada, text: One }
      - { who: ada, text: Two }
    next: vote_a

  - id: vote_a
    type: poll
    question: Reply or stay silent?
    duration: 60
    options:
      - { key: reply, label: Reply, next: vote_b }
      - { key: silent, label: Stay silent, next: vote_b }
    default: silent
    set:
      approach: $winner

  - id: vote_b
    type: poll
    question: Tell whom?
    duration: 30
    options:
      - { key: everyone, label: Everyone, next: decide }
      - { key: crew, label: The crew, next: decide }
    default: crew
    set:
      disclosure: $winner

  - id: decide
    type: branch
    when:
      - if: approach == 'reply' && disclosure == 'everyone'
        next: ending_open
    else: ending_quiet

  - id: ending_open
    type: end
    text: Open contact.

  - id: ending_quiet
    type: end
    text: A quiet decision.

  - id: orphan
    type: end
    text: Nothing points here.
`;

function load(source = SOURCE) {
  const result = parseScenarioSource(source);
  assert.ok(result.ok, `fixture should parse: ${!result.ok ? result.problems.join('; ') : ''}`);
  return result.scenario;
}

describe('scenario analysis', () => {
  test('reports what each node reads and writes', () => {
    const analysis = analyzeScenario(load());
    const poll = analysis.nodes.find((n) => n.id === 'vote_a')!;
    const branch = analysis.nodes.find((n) => n.id === 'decide')!;

    assert.deepEqual(poll.writes, [{ name: 'approach', value: '$winner' }]);
    assert.deepEqual(poll.reads, []);
    // The branch's inputs are exactly the variables its conditions mention.
    assert.deepEqual(branch.reads, ['approach', 'disclosure']);
  });

  test('labels every exit with the reason it would be taken', () => {
    const analysis = analyzeScenario(load());
    const poll = analysis.nodes.find((n) => n.id === 'vote_a')!;
    const branch = analysis.nodes.find((n) => n.id === 'decide')!;

    // The default is called out, because it is the exit nobody chooses and
    // everybody forgets.
    assert.match(poll.exits.find((e) => e.label.startsWith('silent'))!.label, /\(default\)/);
    assert.equal(branch.exits.at(-1)!.label, 'otherwise');
    assert.equal(branch.exits.at(-1)!.to, 'ending_quiet');
  });

  test('tracks who can enter a node', () => {
    const analysis = analyzeScenario(load());
    const decide = analysis.nodes.find((n) => n.id === 'decide')!;
    assert.deepEqual(decide.enteredFrom, ['vote_b']);
  });

  test('flags a node nothing points at', () => {
    const analysis = analyzeScenario(load());
    assert.equal(analysis.nodes.find((n) => n.id === 'orphan')!.reachable, false);
    assert.equal(analysis.nodes.find((n) => n.id === 'open')!.reachable, true);
    assert.equal(analysis.counts.unreachable, 1);
  });

  test('pairs each variable with the nodes that write and read it', () => {
    const analysis = analyzeScenario(load());
    assert.deepEqual(analysis.variables, [
      { name: 'approach', writtenBy: ['vote_a'], readBy: ['decide'] },
      { name: 'disclosure', writtenBy: ['vote_b'], readBy: ['decide'] },
    ]);
  });

  test('estimates stage time, and gives branches none', () => {
    const analysis = analyzeScenario(load());
    // Two lines at a clamped one second each.
    assert.equal(analysis.nodes.find((n) => n.id === 'open')!.seconds, 2);
    assert.equal(analysis.nodes.find((n) => n.id === 'vote_a')!.seconds, 60);
    assert.equal(analysis.nodes.find((n) => n.id === 'decide')!.seconds, 0);
  });
});

describe('simulating a run', () => {
  test('votes carried across two polls decide the ending', () => {
    const result = simulate(load(), { vote_a: 'reply', vote_b: 'everyone' });

    assert.equal(result.error, undefined);
    assert.equal(result.endedAt, 'ending_open');
    assert.deepEqual(result.vars, { approach: 'reply', disclosure: 'everyone' });
    // The branch is control flow, so it appears in the path but never as a step.
    assert.ok(result.path.includes('decide'));
    assert.equal(result.steps.some((s) => s.nodeId === 'decide'), false);
  });

  test('a different vote reaches a different ending', () => {
    const result = simulate(load(), { vote_a: 'reply', vote_b: 'crew' });
    assert.equal(result.endedAt, 'ending_quiet');
  });

  test('a poll left unvoted resolves through its default', () => {
    // The whole point of the simulator: rehearsing the path a silent room takes.
    const result = simulate(load(), {});

    const polls = result.steps.filter((s) => s.kind === 'poll');
    assert.equal(polls.length, 2);
    assert.deepEqual(
      polls.map((p) => (p.kind === 'poll' ? [p.chosen, p.usedDefault] : [])),
      [
        ['silent', true],
        ['crew', true],
      ],
    );
    assert.equal(result.endedAt, 'ending_quiet');
  });

  test('reports what each poll wrote, which is how a branch sees it later', () => {
    const result = simulate(load(), { vote_a: 'reply' });
    const first = result.steps.find((s) => s.kind === 'poll');
    assert.deepEqual(first?.kind === 'poll' ? first.sets : undefined, { approach: 'reply' });
  });

  test('totals the runtime including poll windows', () => {
    const result = simulate(load(), { vote_a: 'reply', vote_b: 'everyone' });
    // Two seconds of dialogue plus a 60s and a 30s voting window.
    assert.equal(result.seconds, 92);
  });

  test('every dialogue line is its own step, with the speaker resolved', () => {
    const result = simulate(load(), {});
    const lines = result.steps.filter((s) => s.kind === 'dialogue');
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.kind === 'dialogue' ? lines[0].speaker : undefined, 'Ada');
  });

  test('an unknown option key is ignored rather than trusted', () => {
    // The choice comes off a web page, so it cannot be assumed to be valid.
    const result = simulate(load(), { vote_a: 'nonsense' });
    const first = result.steps.find((s) => s.kind === 'poll');
    assert.equal(first?.kind === 'poll' ? first.usedDefault : undefined, true);
  });

  test('a branch cycle is reported, not thrown', () => {
    const cyclic = load(`
id: loop
title: Loop
start: a
nodes:
  - id: a
    type: branch
    when: [{ if: "x == 'y'", next: b }]
    else: b
  - id: b
    type: branch
    when: [{ if: "x == 'y'", next: a }]
    else: a
`);
    const result = simulate(cyclic, {});
    assert.match(result.error ?? '', /cycle/i);
  });
});
