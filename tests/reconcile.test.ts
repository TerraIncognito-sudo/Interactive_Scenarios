/**
 * Keeping the recipes honest when the story moves.
 *
 * The failure this guards is the quiet one. Editing a line of dialogue used to
 * leave the voice row holding the words it was seeded with: the recipe hash
 * never moved, the board went on saying `ready`, and the clip in the finished
 * show read a sentence that was no longer in the script. Nothing anywhere
 * reported it, and the only way to catch it was to listen to all ninety.
 *
 * So the two halves of the rule are both tested here, and they pull in
 * opposite directions on purpose: the scenario's fields must be overwritten
 * without being asked, and the author's must survive exactly as written.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LINE_ONE = 'Contact bearing zero four zero.';
const LINE_TWO = 'Fuel lines. Weather brief.';

function scenarioWith(lines: { text: string; who?: string; voice: string }[]): string {
  return [
    'id: demo',
    'title: Demo',
    'start: a',
    'characters:',
    '  tran: { name: PO Tran }',
    '  beau: { name: LCdr Beaudoin }',
    'scenes:',
    '  bridge: { background: images/bridge.jpg }',
    'nodes:',
    '  - id: a',
    '    type: dialogue',
    '    scene: bridge',
    '    lines:',
    ...lines.flatMap((line) => [
      `      - ${line.who ? `who: ${line.who}` : 'who: tran'}`,
      `        text: ${line.text}`,
      '        hold: 4',
      `        voice: ${line.voice}`,
    ]),
    '    next: b',
    '  - id: b',
    '    type: end',
    '    text: Done',
    '',
  ].join('\n');
}

/** A project on disk with one node, two spoken lines, and a tuned prompt. */
async function workshop(options: { storyboard?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'is-reconcile-'));
  const dir = join(root, 'demo');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'scenario.yaml'),
    scenarioWith([
      { text: LINE_ONE, voice: 'voice/tran-a-01.mp3' },
      { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
    ]),
    'utf8',
  );

  writeFileSync(
    join(dir, 'project.yaml'),
    [
      '# The author owns this file.',
      'project: demo',
      'scenario: scenario.yaml',
      'publish: assets',
      'generated: generated',
      ...(options.storyboard ? ['storyboard: story.md'] : []),
      'sections:',
      '  voice:',
      '    backend: manual',
      'assets:',
      '  voice/tran-a-01.mp3:',
      `    text: ${LINE_ONE}`,
      '    voice: tran',
      '    # Weeks of tuning live in lines like this one.',
      '    prompt: flat, procedural, no colour in it',
      '    source:',
      '      node: a',
      '      line: 0',
      '  voice/tran-a-02.mp3:',
      `    text: ${LINE_TWO}`,
      '    voice: tran',
      '    source:',
      '      node: a',
      '      line: 1',
      '',
    ].join('\n'),
    'utf8',
  );

  if (options.storyboard) {
    writeFileSync(join(dir, 'story.md'), '# Story\n\n## Shot A.1\n\n**Node:** a\n', 'utf8');
  }

  process.env.EDITOR_CONFIG_DIR = join(root, '.config');
  const { setWorkspace } = await import('../tools/editor/workspace.ts');
  await setWorkspace(root);

  const projects = await import('../tools/editor/projects.ts');
  const readProject = () => readFileSync(join(dir, 'project.yaml'), 'utf8');
  const writeScenario = (source: string) =>
    writeFileSync(join(dir, 'scenario.yaml'), source, 'utf8');

  return {
    root,
    dir,
    ...projects,
    readProject,
    writeScenario,
    done: () => {
      delete process.env.EDITOR_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('what a clip says follows the scenario', () => {
  test('an edited line rewrites the row it is spoken from', async () => {
    const shop = await workshop();
    try {
      const edited = 'Contact bearing zero four zero. Range twelve thousand.';
      shop.writeScenario(
        scenarioWith([
          { text: edited, voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );

      const plan = await shop.reconcileProject('demo');
      assert.deepEqual(
        plan.updates.map((update) => [update.file, update.path.join('.')]),
        [['voice/tran-a-01.mp3', 'text']],
      );
      assert.match(shop.readProject(), /Range twelve thousand/);
    } finally {
      shop.done();
    }
  });

  test('and that makes exactly that clip stale, not the other one', async () => {
    // The point of putting `text` in the recipe hash. Without the rewrite the
    // hash never moves and the board reports a clip as finished while it reads
    // a sentence the author deleted.
    const shop = await workshop();
    try {
      const before = (await shop.openProject('demo')).overview.sections
        .find((section) => section.section === 'voice')!
        .assets.map((asset) => [asset.file, asset.hash] as const);

      shop.writeScenario(
        scenarioWith([
          { text: 'Contact bearing one eight zero.', voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );
      await shop.reconcileProject('demo');

      const after = new Map(
        (await shop.openProject('demo')).overview.sections
          .find((section) => section.section === 'voice')!
          .assets.map((asset) => [asset.file, asset.hash]),
      );

      assert.notEqual(after.get('voice/tran-a-01.mp3'), before[0]![1], 'the line that changed');
      assert.equal(after.get('voice/tran-a-02.mp3'), before[1]![1], 'the line that did not');
    } finally {
      shop.done();
    }
  });

  test('a line moving to another node takes its origin with it', async () => {
    const shop = await workshop();
    try {
      // The first line is deleted, so the second slides up into its index.
      shop.writeScenario(scenarioWith([{ text: LINE_TWO, voice: 'voice/tran-a-02.mp3' }]));
      const plan = await shop.reconcileProject('demo');

      assert.deepEqual(
        plan.updates.map((update) => [update.path.join('.'), update.from, update.to]),
        [['source.line', 1, 0]],
      );
    } finally {
      shop.done();
    }
  });

  test('recasting a line follows the scenario too', async () => {
    const shop = await workshop();
    try {
      shop.writeScenario(
        scenarioWith([
          { text: LINE_ONE, who: 'beau', voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );
      await shop.reconcileProject('demo');
      const project = (await shop.openProject('demo')).project;
      assert.equal(project.assets['voice/tran-a-01.mp3']!.voice, 'beau');
    } finally {
      shop.done();
    }
  });
});

describe('what the author wrote is theirs', () => {
  test('a tuned prompt is never rewritten, even as the line around it changes', async () => {
    const shop = await workshop();
    try {
      shop.writeScenario(
        scenarioWith([
          { text: 'Something else entirely.', voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );
      await shop.reconcileProject('demo');

      const source = shop.readProject();
      assert.match(source, /flat, procedural, no colour in it/, 'the prompt survived');
      assert.match(source, /# The author owns this file\./, 'and so did the comments');
      assert.match(source, /# Weeks of tuning live in lines like this one\./);
    } finally {
      shop.done();
    }
  });

  test('a row the scenario dropped is reported and left alone', async () => {
    // Removing one throws its prompt away, so it stays a thing a person
    // presses with the list in front of them.
    const shop = await workshop();
    try {
      shop.writeScenario(scenarioWith([{ text: LINE_ONE, voice: 'voice/tran-a-01.mp3' }]));
      const plan = await shop.reconcileProject('demo');

      assert.deepEqual(plan.orphans, ['voice/tran-a-02.mp3']);
      assert.match(shop.readProject(), /voice\/tran-a-02\.mp3/, 'still on disk');
    } finally {
      shop.done();
    }
  });
});

describe('assets the story gains', () => {
  test('a newly referenced clip gets a row without a second button', async () => {
    const shop = await workshop();
    try {
      shop.writeScenario(
        scenarioWith([
          { text: LINE_ONE, voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
          { text: 'All stations, bridge.', who: 'beau', voice: 'voice/beau-a-03.mp3' },
        ]),
      );
      const plan = await shop.reconcileProject('demo');

      // The scene's background comes along too: the fixture never gave it a
      // row, and an asset the scenario asks for belongs on the board whether
      // or not anyone has written a prompt for it yet.
      assert.deepEqual(Object.keys(plan.added).sort(), [
        'images/bridge.jpg',
        'voice/beau-a-03.mp3',
      ]);
      const project = (await shop.openProject('demo')).project;
      assert.equal(project.assets['voice/beau-a-03.mp3']!.text, 'All stations, bridge.');
      assert.equal(project.assets['voice/beau-a-03.mp3']!.voice, 'beau');
    } finally {
      shop.done();
    }
  });

  test('a project with no storyboard still stays in sync', async () => {
    // Everything derived comes from the scenario. Seeding needs the document;
    // this must not, or a project without one drifts silently forever.
    const shop = await workshop({ storyboard: false });
    try {
      shop.writeScenario(
        scenarioWith([
          { text: 'Reworded.', voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );
      const plan = await shop.reconcileProject('demo');
      assert.equal(plan.updates.length, 1);
      assert.match(shop.readProject(), /text: Reworded\./);
    } finally {
      shop.done();
    }
  });

  test('running it twice changes nothing the second time', async () => {
    const shop = await workshop();
    try {
      shop.writeScenario(
        scenarioWith([
          { text: 'Once.', voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );
      await shop.reconcileProject('demo');
      const settled = shop.readProject();
      const again = await shop.reconcileProject('demo');

      assert.deepEqual(again.updates, []);
      assert.deepEqual(Object.keys(again.added), []);
      assert.equal(shop.readProject(), settled, 'byte for byte');
    } finally {
      shop.done();
    }
  });
});

describe('saving the scenario is what triggers it', () => {
  test('the recipes follow on the same trip', async () => {
    // The join itself. Every other path into the project goes through an
    // action; this is the one an author uses a hundred times a day.
    const shop = await workshop();
    try {
      const plan = await shop.saveScenarioSource(
        'demo',
        scenarioWith([
          { text: 'Saved and re-derived.', voice: 'voice/tran-a-01.mp3' },
          { text: LINE_TWO, voice: 'voice/tran-a-02.mp3' },
        ]),
      );

      assert.equal(plan.updates.length, 1);
      assert.match(shop.readProject(), /Saved and re-derived\./);
    } finally {
      shop.done();
    }
  });

  test('an invalid scenario is refused and changes no recipe', async () => {
    const shop = await workshop();
    try {
      await assert.rejects(() => shop.saveScenarioSource('demo', 'id: demo\nnodes: []\n'));
      assert.match(shop.readProject(), new RegExp(LINE_ONE.replace(/\./g, '\\.')));
    } finally {
      shop.done();
    }
  });

  test('a scenario folder with no project file is left as one', async () => {
    // Saving a scenario must not be the thing that decides a folder is now an
    // asset project — that is a deliberate act with a button of its own.
    const shop = await workshop();
    try {
      rmSync(join(shop.dir, 'project.yaml'));
      const plan = await shop.saveScenarioSource(
        'demo',
        scenarioWith([{ text: LINE_ONE, voice: 'voice/tran-a-01.mp3' }]),
      );
      assert.deepEqual(plan, { added: {}, updates: [], orphans: [] });
    } finally {
      shop.done();
    }
  });
});
