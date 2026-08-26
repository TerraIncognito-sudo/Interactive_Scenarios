/**
 * Filing a scenario's assets by media type.
 *
 * The thing these guard is that the rename happens *everywhere at once*. A
 * scenario pointing at `voice/tran-a-01.mp3` while the recipe row, the ledger
 * and the published file still say `tran-a-01.mp3` is worse than never having
 * sorted anything: the board reports the line ready, and the show is silent on
 * it. So the interesting assertions here are about the four files agreeing,
 * not about the string that came out of the renamer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScenarioSource } from '../src/scenario/load.ts';
import { ScenarioSchema } from '../src/scenario/schema.ts';
import { renameRows, sortIntoFolders } from '../tools/editor/folders.ts';
import { pathsOf, ProjectSchema, takesDir } from '../tools/editor/project.ts';
import { publishAsset } from '../tools/editor/generate.ts';

const SOURCE = [
  '# Why this show is paced the way it is.',
  'id: demo',
  'title: Demo',
  'start: a',
  'characters:',
  '  narr: { name: Narrator }',
  '  tran:',
  '    name: Tran',
  '    sprite: tran.png   # the portrait, kept for the nameplate',
  'scenes:',
  '  halifax:',
  '    background: a1-jetty.jpg',
  '    video: a1-jetty.mp4',
  '    music: cold-open.mp3',
  '    ambience: harbour.mp3',
  'nodes:',
  '  # The cold open.',
  '  - id: a',
  '    type: dialogue',
  '    scene: halifax',
  '    background: a2-flank.jpg',
  '    lines:',
  '      - who: narr',
  '        text: >-',
  '          Zero four hundred, Halifax. The pier is busy the way it always',
  '          is before a ship sails.',
  '        hold: 7',
  '        voice: narr-a-01.mp3',
  '        sfx: gangway.mp3',
  '      - { who: tran, text: Link is good., hold: 2, voice: tran-a-01.mp3 }',
  '    next: z',
  '  - { id: z, type: end }',
  '',
].join('\n');

function sort(source: string) {
  const parsed = parseScenarioSource(source);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return sortIntoFolders(source, parsed.scenario);
}

describe('filing assets by media type', () => {
  test('every kind of reference goes under its own folder', () => {
    const result = sort(SOURCE);
    const parsed = parseScenarioSource(result.source);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    if (!parsed.ok) return;

    const scene = parsed.scenario.scenes.halifax!;
    assert.equal(scene.background, 'images/a1-jetty.jpg');
    assert.equal(scene.video, 'video/a1-jetty.mp4');
    assert.equal(scene.music, 'music/cold-open.mp3');
    assert.equal(scene.ambience, 'ambience/harbour.mp3');

    // A sprite is a picture, and the field it was referenced from is what
    // decides that — never its extension.
    assert.equal(parsed.scenario.characters.tran!.sprite, 'images/tran.png');

    const node = parsed.scenario.nodes[0]!;
    assert.equal(node.type, 'dialogue');
    if (node.type !== 'dialogue') return;
    assert.equal(node.background, 'images/a2-flank.jpg');
    assert.equal(node.lines[0]!.voice, 'voice/narr-a-01.mp3');
    // `.mp3` in `sfx:` and `.mp3` in `music:` are different work by different
    // models, and they land in different folders for the same reason.
    assert.equal(node.lines[0]!.sfx, 'sfx/gangway.mp3');
    assert.equal(node.lines[1]!.voice, 'voice/tran-a-01.mp3');
  });

  test('the author’s comments and line breaks survive it', () => {
    const result = sort(SOURCE);
    assert.match(result.source, /# Why this show is paced/);
    assert.match(result.source, /# The cold open\./);
    assert.match(result.source, /sprite: images\/tran\.png {3}# the portrait/);
    // The folded scalar is still folded, and still wrapped where it was.
    assert.match(result.source, /is before a ship sails\./);
    // A flow map grows a longer value, not a newline.
    assert.match(result.source, /\{ who: tran, .*voice: voice\/tran-a-01\.mp3 \}/);
  });

  test('pressing it twice changes nothing the second time', () => {
    const once = sort(SOURCE);
    const twice = sort(once.source);
    assert.deepEqual(twice.moved, []);
    assert.equal(twice.source, once.source);
    assert.equal(twice.kept.length, once.moved.length);
  });

  test('a file referenced from six places moves in all six', () => {
    // One bed, three scenes. A rename that caught two of them would leave the
    // third silent, and the board would call all three ready.
    const shared = ScenarioSchema.parse({
      id: 'x',
      title: 'X',
      start: 'a',
      characters: {},
      scenes: {
        one: { ambience: 'sea.mp3' },
        two: { ambience: 'sea.mp3' },
        three: { ambience: 'sea.mp3' },
      },
      nodes: [{ id: 'a', type: 'end', text: 'Done' }],
    });
    const text = [
      'id: x',
      'title: X',
      'start: a',
      'characters: {}',
      'scenes:',
      '  one: { ambience: sea.mp3 }',
      '  two: { ambience: sea.mp3 }',
      '  three: { ambience: sea.mp3 }',
      'nodes:',
      '  - { id: a, type: end, text: Done }',
      '',
    ].join('\n');

    const result = sortIntoFolders(text, shared);
    assert.deepEqual(result.moved, [
      { from: 'sea.mp3', to: 'ambience/sea.mp3', section: 'ambience' },
    ]);
    assert.equal(result.source.match(/ambience\/sea\.mp3/g)?.length, 3);
  });

  test('a name two sections both claim is reported, not guessed at', () => {
    const clash = [
      'id: x',
      'title: X',
      'start: a',
      'characters: {}',
      'scenes:',
      '  one: { music: bed.mp3, ambience: bed.mp3 }',
      'nodes:',
      '  - { id: a, type: end, text: Done }',
      '',
    ].join('\n');

    const result = sort(clash);
    assert.deepEqual(result.moved, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.why, /referenced as both/);
    // And nothing was written, because either answer would be wrong for one of
    // the two uses.
    assert.equal(result.source, clash);
  });

  test('a scenario the author already filed by hand is left alone', () => {
    const already = SOURCE.replaceAll('a1-jetty.jpg', 'stills/a1-jetty.jpg');
    const result = sort(already);
    assert.ok(result.kept.includes('stills/a1-jetty.jpg'));
    assert.ok(!result.moved.some((move) => move.from.includes('a1-jetty.jpg')));
    assert.match(result.source, /background: stills\/a1-jetty\.jpg/);
  });

  test('recipe rows follow, keeping their comments', () => {
    const projectYaml = [
      'project: demo',
      'assets:',
      '  # Tuned over an afternoon; do not re-roll.',
      '  a1-jetty.jpg:',
      '    prompt: |-',
      '      Pre-dawn at a working naval jetty.',
      '    freeze: true',
      '  narr-a-01.mp3:',
      '    text: Zero four hundred.',
      '',
    ].join('\n');

    const renamed = renameRows(projectYaml, [
      { from: 'a1-jetty.jpg', to: 'images/a1-jetty.jpg', section: 'images' },
      { from: 'narr-a-01.mp3', to: 'voice/narr-a-01.mp3', section: 'voice' },
    ]);

    assert.match(renamed, /^ {2}images\/a1-jetty\.jpg:$/m);
    assert.match(renamed, /^ {2}voice\/narr-a-01\.mp3:$/m);
    // The row is an afternoon of tuning and a comment recording why.
    assert.match(renamed, /# Tuned over an afternoon/);
    assert.match(renamed, /freeze: true/);
    assert.match(renamed, /prompt: \|-/);
  });
});

describe('what a folder in the name changes downstream', () => {
  function project() {
    return ProjectSchema.parse({
      project: 'demo',
      scenario: 'scenario.yaml',
      publish: 'assets',
      generated: 'generated',
    });
  }

  test('a take folder does not repeat the section it is already in', () => {
    const paths = pathsOf(join('C:', 'p', 'project.yaml'), project());
    // Both spellings land in the same folder, which is what lets a project be
    // filed without losing a single take it has already made.
    assert.equal(
      takesDir(paths, 'voice', 'voice/tran-a-01.mp3'),
      takesDir(paths, 'voice', 'tran-a-01.mp3'),
    );
    // And two sections still keep their own `a.mp3` apart.
    assert.notEqual(takesDir(paths, 'voice', 'a.mp3'), takesDir(paths, 'music', 'a.mp3'));
  });

  test('publishing makes the folder the scenario asked for', async () => {
    const root = mkdtempSync(join(tmpdir(), 'is-folders-'));
    try {
      const paths = pathsOf(join(root, 'project.yaml'), project());
      const takes = takesDir(paths, 'voice', 'voice/tran-a-01.mp3');
      mkdirSync(takes, { recursive: true });
      writeFileSync(join(takes, 'abc-01.mp3'), 'the reading');

      await publishAsset({
        paths,
        ledger: {
          version: 1,
          assets: {
            'voice/tran-a-01.mp3': {
              selected: 'abc-01.mp3',
              takes: [{ id: 'abc-01.mp3', hash: 'abc', at: '', params: {} }],
            },
          },
        },
        section: 'voice',
        file: 'voice/tran-a-01.mp3',
      });

      // Exactly where the scenario says the show will look for it.
      assert.equal(
        readFileSync(join(paths.publish, 'voice', 'tran-a-01.mp3'), 'utf8'),
        'the reading',
      );
      assert.ok(!existsSync(join(paths.publish, 'tran-a-01.mp3')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The action as an author presses it: four files renamed together, in a real
 * project folder, with real takes and a real published clip.
 */
describe('the button that files a whole project', () => {
  /** A project on disk, flat, with one take made and published. */
  function build() {
    const root = mkdtempSync(join(tmpdir(), 'is-sort-'));
    const dir = join(root, 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scenario.yaml'), SOURCE, 'utf8');
    writeFileSync(
      join(dir, 'project.yaml'),
      [
        '# Why this project looks the way it does.',
        'project: demo',
        'scenario: scenario.yaml',
        'publish: assets',
        'generated: generated',
        'sections:',
        '  voice: { backend: manual }',
        'assets:',
        '  # Tuned over an afternoon.',
        '  narr-a-01.mp3:',
        '    text: Zero four hundred.',
        '    voice: narr',
        '  a1-jetty.jpg:',
        '    prompt: Pre-dawn at a working naval jetty.',
        '',
      ].join('\n'),
      'utf8',
    );

    const takes = join(dir, 'generated', 'voice', 'narr-a-01.mp3');
    mkdirSync(takes, { recursive: true });
    writeFileSync(join(takes, 'abc-01.mp3'), 'the reading', 'utf8');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'narr-a-01.mp3'), 'the reading', 'utf8');
    writeFileSync(
      join(dir, '.ledger.json'),
      JSON.stringify({
        version: 1,
        assets: {
          'narr-a-01.mp3': {
            selected: 'abc-01.mp3',
            takes: [
              { id: 'abc-01.mp3', hash: 'abc', at: '2026-01-01T00:00:00.000Z', params: {} },
            ],
          },
        },
      }),
      'utf8',
    );
    return { root, dir };
  }

  test('the scenario, the recipes, the ledger and the published file all follow', async () => {
    const { root, dir } = build();
    try {
      process.env.EDITOR_CONFIG_DIR = join(root, '.config');
      const { setWorkspace } = await import('../tools/editor/workspace.ts');
      const { sortAssets, openProject } = await import('../tools/editor/projects.ts');
      await setWorkspace(root);

      const result = await sortAssets('demo');
      assert.ok(result.moved.length > 0);
      assert.deepEqual(result.skipped, []);

      // The scenario.
      assert.match(readFileSync(join(dir, 'scenario.yaml'), 'utf8'), /voice: voice\/narr-a-01\.mp3/);

      // The recipes, with the comment that explains them.
      const projectYaml = readFileSync(join(dir, 'project.yaml'), 'utf8');
      assert.match(projectYaml, /^ {2}voice\/narr-a-01\.mp3:$/m);
      assert.match(projectYaml, /^ {2}images\/a1-jetty\.jpg:$/m);
      assert.match(projectYaml, /# Tuned over an afternoon\./);
      assert.match(projectYaml, /# Why this project looks the way it does\./);

      // The ledger, so the take that was already chosen is still chosen.
      const ledger = JSON.parse(readFileSync(join(dir, '.ledger.json'), 'utf8'));
      assert.equal(ledger.assets['voice/narr-a-01.mp3']?.selected, 'abc-01.mp3');
      assert.equal(ledger.assets['narr-a-01.mp3'], undefined);

      // The published file, moved into the folder the scenario now names.
      assert.ok(existsSync(join(dir, 'assets', 'voice', 'narr-a-01.mp3')));
      assert.ok(!existsSync(join(dir, 'assets', 'narr-a-01.mp3')));
      assert.deepEqual(result.republished, ['voice/narr-a-01.mp3']);

      // The takes never moved, and the board still finds them. This is the
      // whole reason the section is dropped from a name that carries it: a
      // project's history of attempts survives being filed.
      assert.ok(existsSync(join(dir, 'generated', 'voice', 'narr-a-01.mp3', 'abc-01.mp3')));

      const opened = await openProject('demo');
      const voice = opened.overview.sections.find((s) => s.section === 'voice')!;
      const row = voice.assets.find((a) => a.file === 'voice/narr-a-01.mp3')!;
      assert.equal(row.takes.length, 1);
      assert.equal(row.selected, 'abc-01.mp3');
      assert.equal(row.published, true);
      // And nothing has been orphaned by the rename.
      assert.deepEqual(opened.overview.orphans, []);
    } finally {
      delete process.env.EDITOR_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('pressing it again reports nothing to do', async () => {
    const { root } = build();
    try {
      process.env.EDITOR_CONFIG_DIR = join(root, '.config');
      const { setWorkspace } = await import('../tools/editor/workspace.ts');
      const { sortAssets } = await import('../tools/editor/projects.ts');
      await setWorkspace(root);

      await sortAssets('demo');
      const again = await sortAssets('demo');
      assert.deepEqual(again.moved, []);
      assert.deepEqual(again.republished, []);
    } finally {
      delete process.env.EDITOR_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a take, a published file and a reference clip can all be played', async () => {
    const { root, dir } = build();
    try {
      process.env.EDITOR_CONFIG_DIR = join(root, '.config');
      const { setWorkspace } = await import('../tools/editor/workspace.ts');
      const { resolveMedia } = await import('../tools/editor/projects.ts');
      await setWorkspace(root);

      const take = await resolveMedia('demo', {
        section: 'voice',
        file: 'narr-a-01.mp3',
        take: 'abc-01.mp3',
      });
      assert.equal(take.type, 'audio/mpeg');
      assert.equal(readFileSync(take.path, 'utf8'), 'the reading');

      const published = await resolveMedia('demo', { section: 'voice', file: 'narr-a-01.mp3' });
      assert.equal(published.path, join(dir, 'assets', 'narr-a-01.mp3'));
    } finally {
      delete process.env.EDITOR_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a take name cannot walk out of its folder', async () => {
    const { root, dir } = build();
    try {
      writeFileSync(join(dir, 'secret.mp3'), 'not yours', 'utf8');
      process.env.EDITOR_CONFIG_DIR = join(root, '.config');
      const { setWorkspace } = await import('../tools/editor/workspace.ts');
      const { resolveMedia } = await import('../tools/editor/projects.ts');
      await setWorkspace(root);

      // The editor browses the whole disk on purpose, but that is a picker a
      // person drives. This is a URL, and a URL that dereferences `../..` is a
      // different thing entirely.
      for (const take of ['../../secret.mp3', '..\\secret.mp3', '/etc/passwd']) {
        await assert.rejects(
          () => resolveMedia('demo', { section: 'voice', file: 'narr-a-01.mp3', take }),
          /Bad take name|Outside the project/,
        );
      }
      await assert.rejects(
        () => resolveMedia('demo', { section: 'voice', file: '../../project.yaml' }),
        /Bad asset name/,
      );
      // And nothing but media comes back, whatever the name.
      await assert.rejects(
        () => resolveMedia('demo', { section: 'voice', file: 'project.yaml' }),
        /Not a media file/,
      );
    } finally {
      delete process.env.EDITOR_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('an asset path may nest, but not escape', () => {
  function scenarioWith(background: string) {
    return ScenarioSchema.safeParse({
      id: 'x',
      title: 'X',
      start: 'a',
      characters: {},
      scenes: { one: { background } },
      nodes: [{ id: 'a', type: 'end', text: 'Done' }],
    });
  }

  test('a subfolder is fine', () => {
    assert.equal(scenarioWith('images/a1.jpg').success, true);
  });

  for (const bad of ['../secrets/a.jpg', '/etc/passwd', 'C:/Windows/a.jpg', 'images\\a1.jpg']) {
    test(`"${bad}" is refused at load time`, () => {
      // Every one of these either fails to load in the audience's browser or
      // asks the server for something that was never meant to be served, and
      // both are found out on the night rather than at the desk.
      assert.equal(scenarioWith(bad).success, false);
    });
  }
});
