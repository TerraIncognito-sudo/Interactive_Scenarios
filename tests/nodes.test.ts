/**
 * Editing nodes as structure, without disturbing anything else in the file.
 *
 * The whole value of this module is what it *doesn't* touch, so most of these
 * tests are about survival: a comment written above a beat is still above that
 * beat after it has been dragged three places, and a poll that deliberately
 * jumps backwards still jumps backwards. Assertions about the reordering
 * itself are the easy half.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  nodeBlocks,
  moveNode,
  removeNode,
  addNode,
  setNodeField,
  addListItem,
  removeListItem,
  renameNode,
  retypeNode,
  moveListItem,
  scalarText,
  BASE_FIELDS,
  OWN_FIELDS,
  NodeEditError,
} from '../tools/editor/nodes.ts';
import { parse as parseYaml } from 'yaml';
import { parseScenarioSource } from '../src/scenario/load.ts';
import {
  BranchNodeSchema,
  DialogueNodeSchema,
  EndNodeSchema,
  GateNodeSchema,
  PauseNodeSchema,
  PollNodeSchema,
  type Scenario,
} from '../src/scenario/schema.ts';

/**
 * Comments in three positions that have all been broken by naive rewrites:
 * above a node, beside a value, and as a paragraph between two nodes.
 */
const source = `id: demo
title: Demo
start: a

nodes:
  # The opening beat. This comment belongs to A.
  - id: a
    type: dialogue
    lines:
      - { text: First }
    next: b

  # Two lines about B,
  # written across two lines.
  - id: b
    type: dialogue
    lines:
      - { text: Second }
    next: c

  - id: c
    type: dialogue
    lines:
      - { text: Third }
    next: d # trailing comment beside a value

  - id: d
    type: end
    text: Done.
`;

const branching = `id: branch-demo
title: Branch demo
start: a

nodes:
  - id: a
    type: dialogue
    lines:
      - { text: First }
    next: vote

  - id: vote
    type: poll
    question: Which?
    duration: 30
    options:
      - { key: back, label: Back, next: a }
      - { key: on, label: Onward, next: late }
    default: back

  - id: middle
    type: dialogue
    lines:
      - { text: Middle }
    next: late

  - id: late
    type: end
    text: Done.
`;

const ids = (yaml: string) => nodeBlocks(yaml).map((b) => b.id);

/** Every operation has to leave a file the real loader still accepts. */
function stillValid(yaml: string): Scenario {
  const result = parseScenarioSource(yaml);
  if (!result.ok) assert.fail(`${result.message}: ${result.problems.join('; ')}`);
  return result.scenario;
}

describe('nodeBlocks', () => {
  test('finds every node, in file order', () => {
    assert.deepEqual(ids(source), ['a', 'b', 'c', 'd']);
  });

  test('tiles the region with no gaps, so reordering can never lose a byte', () => {
    const blocks = nodeBlocks(source);
    for (let i = 1; i < blocks.length; i++) {
      assert.equal(blocks[i]!.start, blocks[i - 1]!.end, 'blocks must be contiguous');
    }
  });

  test('a comment written above a node belongs to that node', () => {
    const blocks = nodeBlocks(source);
    const b = source.slice(blocks[1]!.start, blocks[1]!.end);
    assert.ok(b.includes('Two lines about B'), 'the comment above B travels with B');
    assert.ok(!b.includes('The opening beat'), "and A's comment does not");
  });

  test('a comment beside a value stays with the line it was written on', () => {
    const blocks = nodeBlocks(source);
    const c = source.slice(blocks[2]!.start, blocks[2]!.end);
    assert.ok(c.includes('trailing comment beside a value'));
  });
});

describe('moving a node', () => {
  test('reorders the file and splices the three links around it', () => {
    const { source: out, rewired } = moveNode(source, 'c', 1);
    assert.deepEqual(ids(out), ['a', 'c', 'b', 'd']);

    const scenario = stillValid(out);
    const next = (id: string) => {
      const node = scenario.nodes.find((n) => n.id === id);
      return node && 'next' in node ? node.next : undefined;
    };
    assert.equal(next('a'), 'c', 'a now leads to c');
    assert.equal(next('c'), 'b', 'c now leads to b');
    assert.equal(next('b'), 'd', 'b now leads to d');
    assert.equal(rewired.length, 3);
  });

  test('carries each node comment along with its node', () => {
    const { source: out } = moveNode(source, 'c', 0);
    const blocks = nodeBlocks(out);
    assert.equal(blocks[0]!.id, 'c');
    const b = out.slice(...spanOf(out, 'b'));
    assert.ok(b.includes('Two lines about B'), "B's comment followed B");
    assert.ok(
      out.indexOf('The opening beat') < out.indexOf('- id: a'),
      "A's comment is still directly above A",
    );
  });

  test('leaves poll options and branch targets exactly where they were', () => {
    const { source: out } = moveNode(branching, 'middle', 0);
    const scenario = stillValid(out);
    const poll = scenario.nodes.find((n) => n.id === 'vote');
    assert.ok(poll && poll.type === 'poll');
    if (poll.type === 'poll') {
      assert.deepEqual(
        poll.options.map((o) => o.next),
        ['a', 'late'],
        'a vote that jumps backwards must go on jumping backwards',
      );
    }
  });

  test('leaves a next that was already a deliberate jump, and says so', () => {
    // `a` skips straight over `skipped` to `last`. That pointer disagrees with
    // file order, which is the signal that a person put it there on purpose —
    // so reordering around it must not quietly capture it into the chain.
    const jumping = `id: jump
title: Jump
start: a

nodes:
  - id: a
    type: dialogue
    lines:
      - { text: First }
    next: last

  - id: skipped
    type: dialogue
    lines:
      - { text: Skipped }
    next: last

  - id: last
    type: end
    text: Done.
`;
    const { source: out, warnings, rewired } = moveNode(jumping, 'skipped', 0);
    const scenario = stillValid(out);
    const a = scenario.nodes.find((n) => n.id === 'a');
    assert.ok(a && 'next' in a && a.next === 'last', 'the deliberate jump survives the drag');
    assert.ok(
      !rewired.some((r) => r.nodeId === 'a'),
      'the jumping pointer is not one of the ones that moved',
    );
    assert.ok(
      warnings.some((w) => w.nodeId === 'a'),
      'and the author is told which pointer was left alone',
    );
    // `skipped` is a different case and *should* have moved: its next named
    // the node that followed it in the file, so it was riding the spine.
    assert.ok(rewired.some((r) => r.nodeId === 'skipped' && r.to === 'a'));
  });

  test('moving a node to where it already is changes nothing at all', () => {
    const { source: out } = moveNode(source, 'b', 1);
    assert.equal(out, source);
  });

  test('refuses a node that is not there', () => {
    assert.throws(() => moveNode(source, 'nope', 0), NodeEditError);
  });
});

/** The span of a node's block in a given source, for comment assertions. */
function spanOf(yaml: string, id: string): [number, number] {
  const block = nodeBlocks(yaml).find((b) => b.id === id);
  if (!block) throw new Error(`no ${id}`);
  return [block.start, block.end];
}

describe('editing a field', () => {
  test('replaces a scalar in place and leaves the rest of the file alone', () => {
    const out = setNodeField(source, 'd', ['text'], 'Finished.');
    assert.ok(out.includes('text: Finished.'));
    assert.ok(out.includes('The opening beat'), 'comments elsewhere are untouched');
    assert.equal(stillValid(out).nodes.length, 4);
  });

  test('adds a key that was not there, beside the one asked for', () => {
    const out = setNodeField(source, 'a', ['scene'], 'room', 'type');
    const lines = out.split('\n');
    const typeAt = lines.findIndex((l) => l.includes('- id: a'));
    assert.ok(lines[typeAt + 2]!.includes('scene: room'), 'lands under type, not after next');
  });

  test('null removes the key rather than writing an empty value', () => {
    const withText = setNodeField(source, 'd', ['text'], 'Gone soon.');
    const out = setNodeField(withText, 'd', ['text'], null);
    assert.ok(!out.includes('Gone soon.'));
    assert.ok(!/text:\s*$/m.test(out), "an empty text: would be a value the schema rejects");
    stillValid(out);
  });

  test('reaches into a dialogue line by path', () => {
    const out = setNodeField(source, 'a', ['lines', 0, 'text'], 'Rewritten');
    const scenario = stillValid(out);
    const a = scenario.nodes.find((n) => n.id === 'a');
    assert.ok(a && a.type === 'dialogue' && a.lines[0]!.text === 'Rewritten');
  });

  test('adds a key inside a flow mapping with a comma, not a dangling brace', () => {
    const out = setNodeField(source, 'a', ['lines', 0, 'hold'], 4.5);
    assert.ok(/\{ text: First, hold: 4\.5 \}|\{ text: First, hold: 4\.5\}/.test(out), out);
    const scenario = stillValid(out);
    const a = scenario.nodes.find((n) => n.id === 'a');
    assert.ok(a && a.type === 'dialogue' && a.lines[0]!.hold === 4.5);
  });
});

describe('adding and removing', () => {
  test('a new node is threaded into the chain where it was dropped', () => {
    const { source: out } = addNode(source, { id: 'a2', type: 'gate', fields: { label: 'Start' } }, 'a');
    assert.deepEqual(ids(out), ['a', 'a2', 'b', 'c', 'd']);

    const scenario = stillValid(out);
    const a = scenario.nodes.find((n) => n.id === 'a');
    const gate = scenario.nodes.find((n) => n.id === 'a2');
    assert.ok(a && 'next' in a && a.next === 'a2', 'the beat above now leads into it');
    assert.ok(gate && gate.type === 'gate' && gate.next === 'b', 'and it leads on to what followed');
  });

  test('refuses a duplicate id rather than writing an unloadable file', () => {
    assert.throws(() => addNode(source, { id: 'b', type: 'end' }, 'a'), NodeEditError);
  });

  test('removing a node mends the chain across the hole', () => {
    const { source: out } = removeNode(source, 'c');
    assert.deepEqual(ids(out), ['a', 'b', 'd']);
    const scenario = stillValid(out);
    const b = scenario.nodes.find((n) => n.id === 'b');
    assert.ok(b && 'next' in b && b.next === 'd', 'b skips straight to d');
  });

  test('removing takes the node comment with it and leaves the neighbours', () => {
    const { source: out } = removeNode(source, 'b');
    assert.ok(!out.includes('Two lines about B'));
    assert.ok(out.includes('The opening beat'));
    assert.ok(out.includes('trailing comment beside a value'));
  });

  test('repoints a poll option that named the removed node', () => {
    const { source: out } = removeNode(branching, 'a');
    const scenario = stillValid(out);
    const poll = scenario.nodes.find((n) => n.id === 'vote');
    if (poll?.type === 'poll') {
      assert.equal(poll.options[0]!.next, 'vote', 'the option follows what a led to');
    }
  });

  test('moves start: when the opening beat is the one deleted', () => {
    // Otherwise the file parses and then fails the graph check with "start
    // node does not exist" — a baffling way to be told you deleted slide one.
    const { source: out } = removeNode(branching, 'a');
    const scenario = stillValid(out);
    assert.equal(scenario.start, 'vote', 'the show now starts on what followed');
  });

  test('will not empty the file', () => {
    const single = 'id: x\ntitle: X\nstart: only\nnodes:\n  - id: only\n    type: end\n';
    assert.throws(() => removeNode(single, 'only'), NodeEditError);
  });
});

describe('writing scalars', () => {
  test('leaves an ordinary word bare so the file still reads like prose', () => {
    assert.equal(scalarText('room'), 'room');
    assert.equal(scalarText('Waiting to begin'), 'Waiting to begin');
  });

  test('every value comes back out of the parser as the string that went in', () => {
    // The property that actually matters, rather than "is it quoted": whether
    // `no` needs quotes depends on the YAML schema, and the only opinion worth
    // testing is the parser's own.
    for (const value of ['true', 'no', 'null', '3', '3.5', '-1', 'a: b', '#hash', ' padded ', '']) {
      const parsed = parseYaml(`key: ${scalarText(value)}`) as { key: unknown };
      assert.equal(parsed.key, value, `"${value}" did not survive the round trip`);
    }
  });

  test('never emits a block scalar, which could not be spliced into a line', () => {
    assert.ok(!scalarText('two\nlines').includes('\n'));
  });

  test('numbers stay numbers', () => {
    assert.equal(scalarText(4.5), '4.5');
  });
});

/** The style real scenarios are written in: block mappings and folded scalars. */
const blockStyle = `id: real
title: Real
start: one

characters:
  narr:
    name: Narrator

scenes:
  hall: {}

nodes:
  - id: one
    type: dialogue
    scene: hall
    lines:
      - who: narr
        text: Short line.
        hold: 5.6
        voice: voice/narr-01.mp3
      - who: narr
        text: >-
          A much longer piece of narration that the author wrapped by hand
          across two lines so that it could be read in a diff.
        hold: 7
    next: two

  - id: two
    type: end
    text: Done.
`;

describe('keeping the file readable', () => {
  test('a folded value stays folded when it is edited', () => {
    const long =
      'Replacement narration that is comfortably longer than one line and ought to come back folded across several of them rather than as one very long line.';
    const out = setNodeField(blockStyle, 'one', ['lines', 1, 'text'], long);

    assert.ok(out.includes('text: >-'), 'the fold survived the edit');
    const scenario = stillValid(out);
    const one = scenario.nodes.find((n) => n.id === 'one');
    assert.ok(one && one.type === 'dialogue');
    if (one.type === 'dialogue') {
      assert.equal(one.lines[1]!.text, long, 'and it still says exactly what was typed');
    }
  });

  test('a plain value that has grown long becomes folded rather than enormous', () => {
    const long =
      'This started life as a short line and has been rewritten into something far too long to sit on one line in a file a person has to read.';
    const out = setNodeField(blockStyle, 'one', ['lines', 0, 'text'], long);
    assert.ok(out.includes('text: >-'));
    assert.ok(
      !out.split('\n').some((l) => l.length > 100),
      'no line in the file is left absurdly wide',
    );
    const scenario = stillValid(out);
    const one = scenario.nodes.find((n) => n.id === 'one');
    if (one?.type === 'dialogue') assert.equal(one.lines[0]!.text, long);
  });

  test('a short value stays on one line', () => {
    const out = setNodeField(blockStyle, 'one', ['lines', 0, 'text'], 'Still short.');
    assert.ok(out.includes('text: Still short.'));
  });

  test('editing one line leaves the neighbouring line untouched', () => {
    const out = setNodeField(blockStyle, 'one', ['lines', 0, 'text'], 'Changed.');
    assert.ok(out.includes('voice: voice/narr-01.mp3'));
    assert.ok(out.includes('across two lines so that it could be read in a diff.'));
  });
});

describe('lists inside a node', () => {
  test('a new dialogue line copies the block shape of the ones above it', () => {
    const out = addListItem(blockStyle, 'one', ['lines'], { who: 'narr', text: 'Third.' });
    assert.ok(!out.includes('- { who'), 'block style in, block style out');
    const scenario = stillValid(out);
    const one = scenario.nodes.find((n) => n.id === 'one');
    assert.ok(one && one.type === 'dialogue' && one.lines.length === 3);
    if (one.type === 'dialogue') assert.equal(one.lines[2]!.text, 'Third.');
  });

  test('a new line copies flow shape where that is what the file uses', () => {
    const out = addListItem(source, 'a', ['lines'], { text: 'Second.' });
    assert.ok(/- \{ text: Second\. \}/.test(out), out.slice(0, 400));
    stillValid(out);
  });

  test('removing a line takes exactly that line', () => {
    const out = removeListItem(blockStyle, 'one', ['lines'], 0);
    const scenario = stillValid(out);
    const one = scenario.nodes.find((n) => n.id === 'one');
    assert.ok(one && one.type === 'dialogue' && one.lines.length === 1);
    assert.ok(!out.includes('voice/narr-01.mp3'), 'the removed line took its own fields');
    assert.ok(out.includes('read in a diff'), 'and left the other one alone');
  });

  test('refuses an index that is not there', () => {
    assert.throws(() => removeListItem(blockStyle, 'one', ['lines'], 9), NodeEditError);
  });
});

describe('a new node of every type', () => {
  // The Add button offers six types. Four of them have structure the schema
  // insists on — lines, options, a default, a condition, an else — so a
  // template that only wrote scalars would make four of the six buttons
  // report an error instead of adding anything.
  for (const type of ['dialogue', 'gate', 'pause', 'poll', 'branch', 'end']) {
    test(`${type} is born valid, inserted in the middle`, () => {
      // No fields at all: the template has to be enough on its own.
      const { source: out } = addNode(source, { id: `new_${type}`, type }, 'a');
      const scenario = stillValid(out);
      const added = scenario.nodes.find((n) => n.id === `new_${type}`);
      assert.ok(added, 'the node is there');
      assert.equal(added.type, type);
    });

    test(`${type} is born valid, appended at the end`, () => {
      // Nothing below it to point at, so it has to find the ending itself.
      const { source: out } = addNode(source, { id: `tail_${type}`, type }, 'd');
      stillValid(out);
    });
  }
});

describe('renaming a node', () => {
  test('takes every pointer with it', () => {
    const { source: out, rewired } = renameNode(source, 'c', 'chorus');
    const scenario = stillValid(out);
    assert.ok(scenario.nodes.some((n) => n.id === 'chorus'));
    const b = scenario.nodes.find((n) => n.id === 'b');
    assert.ok(b && 'next' in b && b.next === 'chorus', 'b now points at the new name');
    assert.ok(rewired.some((r) => r.nodeId === 'b'));
  });

  test('moves start: when the opening node is renamed', () => {
    const { source: out } = renameNode(source, 'a', 'opening');
    assert.equal(stillValid(out).start, 'opening');
  });

  test('follows a poll option and a branch else', () => {
    const { source: out } = renameNode(branching, 'late', 'finale');
    const scenario = stillValid(out);
    const poll = scenario.nodes.find((n) => n.id === 'vote');
    if (poll?.type === 'poll') assert.equal(poll.options[1]!.next, 'finale');
  });

  test('refuses a name already in use, and an illegal one', () => {
    assert.throws(() => renameNode(source, 'a', 'b'), NodeEditError);
    assert.throws(() => renameNode(source, 'a', 'not a valid id'), NodeEditError);
  });
});

describe('adding then removing leaves no trace', () => {
  // Add and delete is what an author does a dozen times in an afternoon while
  // working out an order. If each round trip leaves a blank line behind, the
  // file quietly fills with whitespace nobody typed — and the diff of a day's
  // work becomes unreadable for reasons unrelated to the work.
  // `end` is deliberately not in this list. Inserting one mid-file points the
  // beat above it at the new ending, which is what inserting an ending means —
  // and deleting it again cannot put that back, because an end node has no
  // `next` for its predecessor to inherit. `removeNode` says so instead.
  for (const type of ['dialogue', 'gate', 'pause']) {
    test(`a ${type} added mid-file and removed restores the file exactly`, () => {
      const added = addNode(source, { id: 'scratch', type }, 'a').source;
      const back = removeNode(added, 'scratch').source;
      assert.equal(back, source);
    });
  }

  test('and one added at the very end does too', () => {
    const added = addNode(source, { id: 'scratch', type: 'gate' }, 'd').source;
    assert.equal(removeNode(added, 'scratch').source, source);
  });
});

// ---------------------------------------------------------------------------
// Changing what a node is
// ---------------------------------------------------------------------------

/**
 * A dialogue carrying every kind of thing a retype could quietly destroy: a
 * comment above it, a scene, per-line timing, a voice clip, and a folded
 * scalar somebody wrapped by hand.
 */
const rich = `id: rich
title: Rich
start: intro

characters:
  narr:
    name: Narration

scenes:
  dock:
    background: images/jetty.png

nodes:
  # The opening beat. Do not lose me.
  - id: intro
    type: dialogue
    scene: dock
    background: images/jetty.png
    lines:
      - who: narr
        text: >-
          Zero four hundred, Halifax. The pier is busy the way it always is
          before a ship sails.
        hold: 6.2
        voice: voice/narr-01.mp3
      - who: narr
        text: Nobody waves it off.
        hold: 3.1
        voice: voice/narr-02.mp3
    next: hold_here

  - id: hold_here
    type: pause
    duration: 4
    text: A held beat.
    next: done

  - id: done
    type: end
    text: Done.
`;

const oneLiner = `id: one
title: One
start: card

nodes:
  - id: card
    type: dialogue
    lines:
      - { text: Everything that follows is invented. }
    next: done

  - id: done
    type: end
    text: Done.
`;

const nodeById = (scenario: Scenario, id: string) => scenario.nodes.find((n) => n.id === id)!;

describe('retyping a node', () => {
  test('moves the type and the shape together, so the file still loads', () => {
    const { source: out, notes } = retypeNode(rich, 'intro', 'gate');
    const node = nodeById(stillValid(out), 'intro');

    assert.equal(node.type, 'gate');
    assert.ok(!out.includes('voice/narr-01.mp3'), 'a gate has nowhere to keep lines');
    assert.ok(notes!.some((n) => n.includes('lines')), 'and says so rather than doing it quietly');
  });

  test('drops a nested block whole, without eating the key after it', () => {
    // `lines:` is a block sequence, and a sequence's own range runs past its
    // last entry into whatever follows. Removing it by that range took the top
    // of `next:` with it and left the scenario pointing nowhere.
    const { source: out } = retypeNode(rich, 'intro', 'gate');
    assert.match(out, /^ {4}next: hold_here$/m, 'next: survives intact');
    assert.equal(nodeById(stillValid(out), 'intro').type, 'gate');
  });

  test('keeps the scene, the background and the comment above it', () => {
    const { source: out } = retypeNode(rich, 'intro', 'gate');
    assert.ok(out.includes('# The opening beat. Do not lose me.'));
    assert.match(out, /scene: dock/);
    assert.match(out, /background: images\/jetty\.png/);
  });

  test('a single line becomes the words on the card, both ways', () => {
    const { source: out, notes } = retypeNode(oneLiner, 'card', 'gate');
    const node = nodeById(stillValid(out), 'card');
    assert.equal(node.type, 'gate');
    assert.equal('text' in node ? node.text : undefined, 'Everything that follows is invented.');
    assert.ok(notes!.includes('kept the words'));

    const back = retypeNode(out, 'card', 'dialogue');
    const dialogue = nodeById(stillValid(back.source), 'card');
    assert.equal(dialogue.type, 'dialogue');
    assert.equal(
      'lines' in dialogue ? dialogue.lines[0]!.text : undefined,
      'Everything that follows is invented.',
    );
  });

  test('several lines have no one sentence to become, so they are not guessed at', () => {
    const { source: out, notes } = retypeNode(rich, 'intro', 'end');
    const node = nodeById(stillValid(out), 'intro');
    assert.equal(node.type, 'end');
    assert.equal('text' in node ? node.text : undefined, undefined);
    assert.ok(!notes!.includes('kept the words'));
  });

  test('a new poll points its options where the beat already led', () => {
    const { source: out } = retypeNode(rich, 'intro', 'poll');
    const node = nodeById(stillValid(out), 'intro');
    assert.equal(node.type, 'poll');
    if (node.type !== 'poll') return;
    assert.equal(node.options.length, 2);
    for (const option of node.options) assert.equal(option.next, 'hold_here');
    // A default that names no option is the one way a poll can deadlock a room.
    assert.ok(node.options.some((o) => o.key === node.default));
  });

  test('a node that gains a next inherits the beat below it', () => {
    const { source: out } = retypeNode(rich, 'hold_here', 'poll');
    const poll = nodeById(stillValid(out), 'hold_here');
    assert.equal(poll.type, 'poll');

    const back = retypeNode(out, 'hold_here', 'dialogue');
    const node = nodeById(stillValid(back.source), 'hold_here');
    assert.equal('next' in node ? node.next : undefined, 'done');
  });

  test('refuses to make a beat of the last ending, rather than guessing a next', () => {
    // Nothing below it, no pointer of its own and no other ending to fall back
    // on. A self-reference would load and would be a beat that repeats forever
    // in front of a room, so the answer is to say so instead.
    assert.throws(() => retypeNode(rich, 'done', 'gate'), NodeEditError);
  });

  test('refuses a type that does not exist', () => {
    assert.throws(() => retypeNode(rich, 'intro', 'interlude'), NodeEditError);
  });

  test('changing nothing changes nothing', () => {
    assert.equal(retypeNode(rich, 'intro', 'dialogue').source, rich);
  });

  test('every type keeps exactly the fields its schema allows', () => {
    // The claim `retypeNode` rests on: keep a field the new type rejects and
    // the file will not load, drop one it required and the same. This is the
    // only place the two lists are compared, so a field added to the schema
    // and not to OWN_FIELDS is caught here rather than by an author.
    const schemas: Record<string, { shape: Record<string, unknown> }> = {
      dialogue: DialogueNodeSchema,
      poll: PollNodeSchema,
      branch: BranchNodeSchema,
      pause: PauseNodeSchema,
      gate: GateNodeSchema,
      end: EndNodeSchema,
    };
    for (const [type, schema] of Object.entries(schemas)) {
      assert.deepEqual(
        new Set([...BASE_FIELDS, ...OWN_FIELDS[type]!]),
        new Set(Object.keys(schema.shape)),
        `${type} is described differently by the schema and by OWN_FIELDS`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Reordering inside a node
// ---------------------------------------------------------------------------

describe('moving a list entry', () => {
  test('takes the whole entry, not only the words', () => {
    const out = moveListItem(rich, 'intro', ['lines'], 1, 0);
    const node = nodeById(stillValid(out), 'intro');
    if (node.type !== 'dialogue') return assert.fail('intro is a dialogue');

    assert.equal(node.lines[0]!.text, 'Nobody waves it off.');
    // The half that a retype-by-hand gets wrong: the timing and the clip have
    // to travel with the words or the beat reads the wrong line at the wrong
    // length, and nothing anywhere reports it.
    assert.equal(node.lines[0]!.hold, 3.1);
    assert.equal(node.lines[0]!.voice, 'voice/narr-02.mp3');
    assert.equal(node.lines[1]!.voice, 'voice/narr-01.mp3');
  });

  test('a hand-wrapped folded scalar survives the move', () => {
    const out = moveListItem(rich, 'intro', ['lines'], 0, 1);
    assert.ok(out.includes('text: >-'), 'the fold is still a fold');
    assert.ok(out.includes('          before a ship sails.'), 'wrapped exactly as written');
  });

  test('moving there and back restores the file byte for byte', () => {
    const there = moveListItem(rich, 'intro', ['lines'], 0, 1);
    assert.notEqual(there, rich);
    assert.equal(moveListItem(there, 'intro', ['lines'], 1, 0), rich);
  });

  test('leaves everything outside the list alone', () => {
    const out = moveListItem(rich, 'intro', ['lines'], 1, 0);
    assert.ok(out.includes('# The opening beat. Do not lose me.'));
    assert.match(out, /^ {4}next: hold_here$/m);
    assert.deepEqual(ids(out), ['intro', 'hold_here', 'done']);
  });

  test('reorders poll options, which is the order phones show them in', () => {
    const out = moveListItem(branching, 'vote', ['options'], 1, 0);
    const node = nodeById(stillValid(out), 'vote');
    if (node.type !== 'poll') return assert.fail('vote is a poll');
    assert.deepEqual(node.options.map((o) => o.key), ['on', 'back']);
    // Reordering the ballot is not rerouting it.
    assert.equal(node.options.find((o) => o.key === 'on')!.next, 'late');
    assert.equal(node.default, 'back');
  });

  test('moving an entry to where it already is changes nothing', () => {
    assert.equal(moveListItem(rich, 'intro', ['lines'], 1, 1), rich);
  });

  test('refuses an entry that is not there', () => {
    assert.throws(() => moveListItem(rich, 'intro', ['lines'], 7, 0), NodeEditError);
  });
});
