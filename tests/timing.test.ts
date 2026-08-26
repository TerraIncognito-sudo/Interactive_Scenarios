/**
 * Writing a beat into the author's own file.
 *
 * The number is arithmetic and the arithmetic is easy. What is not easy is
 * changing eighty numbers inside a document full of hand-wrapped prose and
 * comments — several of which record why a beat is the length it is — without
 * moving a single thing that was not the number.
 *
 * So most of these tests are about what did *not* change.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenarioSource } from '../src/scenario/load.ts';
import { retimeInto, targetHoldFor, holdMatches, round1, DEFAULT_GAP } from '../tools/editor/timing.ts';
import { resolveRecipe, recipeHash, ProjectSchema } from '../tools/editor/project.ts';

const SOURCE = [
  '# Arctic Sentinel',
  '#',
  '# Seven seconds on the last line, because the pause after it is the point.',
  'id: demo',
  'title: Demo',
  'start: a',
  'characters:',
  '  tran: { name: PO Tran }',
  'scenes:',
  '  bridge: {}',
  'nodes:',
  '  - id: a',
  '    type: dialogue',
  '    scene: bridge',
  '    lines:',
  '      - who: tran',
  '        text: >-',
  '          A folded scalar, wrapped by hand across two lines because that is',
  '          how the author wrote it.',
  '        hold: 4          # the clip is about three and a half',
  '        voice: voice/tran-a-01.mp3',
  '      - who: tran',
  '        text: Short one.',
  '        voice: voice/tran-a-02.mp3',
  '      - { who: tran, text: Flow style, hold: 9, voice: voice/tran-a-03.mp3 }',
  '    next: b',
  '  - id: b',
  '    type: end',
  '    text: Done',
  '',
].join('\n');

function scenarioOf(source: string) {
  const parsed = parseScenarioSource(source);
  assert.ok(parsed.ok, 'fixture must load');
  return parsed.scenario;
}

describe('the arithmetic', () => {
  test('a beat is the clip plus the gap, at one decimal', async () => {
    assert.equal(targetHoldFor(4.234, 1), 5.2);
    assert.equal(targetHoldFor(4.25, 1), 5.3);
    assert.equal(targetHoldFor(7.4, 2.5), 9.9);
    assert.equal(targetHoldFor(3), 4, 'a second by default');
    assert.equal(DEFAULT_GAP, 1);
  });

  test('a gap of nothing is allowed, and is not the same as the default', async () => {
    assert.equal(targetHoldFor(4.2, 0), 4.2);
    assert.notEqual(targetHoldFor(4.2, 0), targetHoldFor(4.2));
  });

  test('matching is compared at the precision it is written at', async () => {
    // Without the rounding, 5.8 against 5.800000000000001 is a mismatch no
    // edit can fix, and the board asks for the same change forever.
    assert.equal(holdMatches(5.8, 4.8 + 1), true);
    assert.equal(holdMatches(round1(0.1 + 0.2), 0.3), true);
    assert.equal(holdMatches(undefined, 4), false, 'no hold never matches');
    assert.equal(holdMatches(5, 5.2), false);
  });
});

describe('rewriting the scenario', () => {
  test('replaces the number and leaves the comment beside it alone', async () => {
    const source = SOURCE;
    const result = retimeInto(
      source,
      scenarioOf(source),
      new Map([['voice/tran-a-01.mp3', 4.6]]),
    );

    assert.equal(result.changed.length, 1);
    assert.deepEqual(result.changed[0], {
      node: 'a',
      line: 0,
      file: 'voice/tran-a-01.mp3',
      from: 4,
      to: 4.6,
    });
    assert.match(result.source, /hold: 4\.6 {10}# the clip is about three and a half/);
  });

  test('the author’s prose is byte-for-byte untouched', async () => {
    const result = retimeInto(
      SOURCE,
      scenarioOf(SOURCE),
      new Map([
        ['voice/tran-a-01.mp3', 4.6],
        ['voice/tran-a-03.mp3', 2.2],
      ]),
    );

    for (const line of [
      '# Seven seconds on the last line, because the pause after it is the point.',
      '          A folded scalar, wrapped by hand across two lines because that is',
      '          how the author wrote it.',
    ]) {
      assert.ok(result.source.includes(line), `kept: ${line}`);
    }
    // The only differences are the two numbers.
    const before = SOURCE.split('\n');
    const after = result.source.split('\n');
    assert.equal(before.length, after.length, 'no lines added or removed');
    const moved = before.filter((line, i) => line !== after[i]);
    assert.equal(moved.length, 2, `only two lines changed, got ${moved.length}`);
  });

  test('a flow-style line is edited in place', async () => {
    const result = retimeInto(
      SOURCE,
      scenarioOf(SOURCE),
      new Map([['voice/tran-a-03.mp3', 2.2]]),
    );
    assert.match(result.source, /\{ who: tran, text: Flow style, hold: 2\.2, voice: /);
  });

  test('a line with no hold gets one, written beside its clip', async () => {
    const result = retimeInto(
      SOURCE,
      scenarioOf(SOURCE),
      new Map([['voice/tran-a-02.mp3', 3.1]]),
    );
    assert.equal(result.changed[0]!.from, undefined);
    assert.match(result.source, /voice: voice\/tran-a-02\.mp3\n {8}hold: 3\.1/);
  });

  test('the result still loads, which is what makes it safe to write', async () => {
    const result = retimeInto(
      SOURCE,
      scenarioOf(SOURCE),
      new Map([
        ['voice/tran-a-01.mp3', 4.6],
        ['voice/tran-a-02.mp3', 3.1],
        ['voice/tran-a-03.mp3', 2.2],
      ]),
    );
    const after = parseScenarioSource(result.source);
    assert.ok(after.ok);
    const node = after.scenario.nodes.find((entry) => entry.id === 'a')!;
    assert.deepEqual(
      (node as { lines: { hold?: number }[] }).lines.map((line) => line.hold),
      [4.6, 3.1, 2.2],
    );
  });

  test('a beat that already matches is not rewritten', async () => {
    const result = retimeInto(SOURCE, scenarioOf(SOURCE), new Map([['voice/tran-a-01.mp3', 4]]));
    assert.deepEqual(result.changed, []);
    assert.equal(result.source, SOURCE, 'byte for byte');
    assert.deepEqual(result.skipped, [], 'checked is not skipped');
  });

  test('a clip with no line in the scenario is reported, not invented', async () => {
    const result = retimeInto(
      SOURCE,
      scenarioOf(SOURCE),
      new Map([['voice/does-not-exist.mp3', 5]]),
    );
    assert.deepEqual(result.skipped, ['voice/does-not-exist.mp3']);
    assert.equal(result.source, SOURCE);
  });

  test('running it twice changes nothing the second time', async () => {
    const wanted = new Map([
      ['voice/tran-a-01.mp3', 4.6],
      ['voice/tran-a-02.mp3', 3.1],
    ]);
    const once = retimeInto(SOURCE, scenarioOf(SOURCE), wanted);
    const twice = retimeInto(once.source, scenarioOf(once.source), wanted);
    assert.deepEqual(twice.changed, []);
    assert.equal(twice.source, once.source);
  });
});

describe('the gap is timing, not audio', () => {
  test('changing it does not move the recipe hash', async () => {
    // The whole reason it lives outside `resolveRecipe`. Folded into the hash,
    // re-timing a show would mark every clip in it stale and cost a re-record
    // of ninety readings that were already right.
    const base = ProjectSchema.parse({
      project: 'demo',
      scenario: 'scenario.yaml',
      publish: 'assets',
      generated: 'generated',
      assets: { 'voice/a.mp3': { text: 'Hello.', voice: 'tran' } },
    });
    const withGap = ProjectSchema.parse({
      project: 'demo',
      scenario: 'scenario.yaml',
      publish: 'assets',
      generated: 'generated',
      assets: { 'voice/a.mp3': { text: 'Hello.', voice: 'tran', gap: 2.5 } },
    });

    assert.equal(withGap.assets['voice/a.mp3']!.gap, 2.5, 'it is stored');
    assert.equal(
      recipeHash(resolveRecipe(base, 'voice', 'voice/a.mp3')),
      recipeHash(resolveRecipe(withGap, 'voice', 'voice/a.mp3')),
      'and it is not in the recipe',
    );
  });
});
