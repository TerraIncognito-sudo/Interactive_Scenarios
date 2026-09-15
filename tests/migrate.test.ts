/**
 * The route back from a recipe shape change.
 *
 * `tests/hash.test.ts` is the tripwire that says the shape has moved. This is
 * the thing you reach for once it has: it finds every take whose recorded hash
 * is what the old code produced and rewrites it to what the new code produces,
 * so three finished shows do not go `stale` in one commit with no way home.
 *
 * What is tested here is mostly what it *refuses* to do. Re-stamping is a claim
 * that a file still answers its row, and a migration that makes that claim too
 * freely is worse than none — it would bless a clip whose line of dialogue had
 * been rewritten, which is the one failure `text`-in-the-hash exists to catch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  legacyHashesFor,
  migrateRecipes,
  needsRecipeMigration,
  REMOVED_ROOT_KEYS,
  REMOVED_SECTION_KEYS,
} from '../client/app/migrate-recipes.ts';

const SCENARIO = `
id: demo
title: Demo
start: open
characters:
  hero:
    name: Hero
    sprite: images/hero.png
scenes:
  room:
    background: images/room.png
nodes:
  - id: open
    type: dialogue
    scene: room
    lines:
      - who: hero
        text: Hello.
        hold: 2
        voice: voice/hero-01.mp3
    next: done
  - id: done
    type: end
`;

const ROWS = ['images/room.png', 'images/hero.png', 'voice/hero-01.mp3'];

/** A project carrying the old shape: a section style and negative, and a SHIP token one row refers to. */
function workshop(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'is-migrate-'));
  const dir = join(root, 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.yaml'), SCENARIO, 'utf8');
  writeFileSync(
    join(dir, 'project.yaml'),
    [
      'project: demo',
      'scenario: scenario.yaml',
      'publish: assets',
      'generated: generated',
      '# The house style, and why it is what it is.',
      'tokens:',
      '  SHIP: a ninety-metre uncrewed hull',
      'sections:',
      '  images:',
      '    backend: manual',
      '    style: painterly, muted palette',
      '    negative: text, logos',
      '  voice:',
      '    backend: sidecar',
      'assets:',
      '  images/room.png:',
      '    prompt: SHIP. The room at dawn.',
      '  images/hero.png:',
      '    prompt: A bust portrait.',
      '  voice/hero-01.mp3:',
      '    text: Hello.',
      '    voice: hero',
      'voices:',
      '  hero:',
      '    preset: bm_fable',
      '',
    ].join('\n'),
    'utf8',
  );
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ledgerOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, '.ledger.json'), 'utf8')) as {
    version: number;
    assets: Record<string, { selected?: string; takes: { id: string; hash: string }[] }>;
  };

function writeLedger(dir: string, hashes: Record<string, string>): void {
  writeFileSync(
    join(dir, '.ledger.json'),
    JSON.stringify(
      {
        version: 1,
        assets: Object.fromEntries(
          Object.entries(hashes).map(([file, hash]) => [
            file,
            { selected: 'take-1', takes: [{ id: 'take-1', hash, at: '2026-01-01T00:00:00.000Z' }] },
          ]),
        ),
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Seeds a ledger the way the old board would have left it.
 *
 * The hashes come from the module's own frozen half rather than from literals,
 * because a literal would only prove that two copies of one arithmetic agree —
 * and the arithmetic is the part that must not be written twice.
 */
async function seeded(dir: string): Promise<void> {
  writeLedger(dir, await legacyHashesFor(dir, ROWS));
}

/**
 * What the board would compute for each row right now, through the live code.
 *
 * This is the assertion that survives the deletion. Which rows a migration
 * moves depends on which fields have been taken out of `Recipe` yet — before
 * the deletion, stripping the file only moves the image rows, and afterwards it
 * moves all of them. Pinning the row list would pass in exactly one of those
 * two worlds. What must be true in both is that when the migration is finished,
 * every take carries the hash the board is about to ask it for.
 */
async function currentHashes(dir: string): Promise<Record<string, string>> {
  const { readFile } = await import('node:fs/promises');
  const { loadProject, pathsOf, resolveRecipe, recipeHash } = await import(
    '../client/app/project.ts'
  );
  const { parseScenarioSource, assetReferencesOf } = await import('../shared/scenario/load.ts');
  const { portraitFilesOf } = await import('../client/app/sprites.ts');

  const file = join(dir, 'project.yaml');
  const project = await loadProject(file);
  const paths = pathsOf(file, project);
  const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
  assert.ok(parsed.ok, 'the fixture scenario must load');
  const portraits = portraitFilesOf(parsed.scenario);

  const out: Record<string, string> = {};
  for (const ref of assetReferencesOf(parsed.scenario)) {
    if (out[ref.file]) continue;
    out[ref.file] = recipeHash(
      resolveRecipe(project, ref.section, ref.file, { portrait: portraits.has(ref.file) }),
    );
  }
  return out;
}

describe('migrating a recipe shape change', () => {
  test('a dry run reports the whole move and writes absolutely nothing', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);
    await seeded(dir);

    const before = readFileSync(join(dir, 'project.yaml'), 'utf8');
    const beforeLedger = ledgerOf(dir);

    const plan = await migrateRecipes(dir, { dryRun: true });
    assert.ok(plan.restamped.length > 0, 'it should say what it would move');
    assert.deepEqual(plan.unrecognised, [], 'and recognise everything it would move');
    assert.ok(plan.stripped.length > 0, 'and say which keys it would remove');

    assert.equal(readFileSync(join(dir, 'project.yaml'), 'utf8'), before, 'file untouched');
    assert.deepEqual(ledgerOf(dir), beforeLedger, 'ledger untouched');
  });

  test('takes stamped with the old hash are re-stamped, and the dead keys go', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);
    await seeded(dir);

    const done = await migrateRecipes(dir);
    assert.deepEqual(done.unrecognised, [], 'every take was recognised');

    // The claim that matters: whatever moved, the ledger now agrees with what
    // the board is about to compute. Nothing is left `stale`.
    const expected = await currentHashes(dir);
    const ledger = ledgerOf(dir);
    for (const row of ROWS) {
      assert.equal(
        ledger.assets[row]!.takes[0]!.hash,
        expected[row],
        `${row} should carry the hash the board will ask for`,
      );
    }

    const after = readFileSync(join(dir, 'project.yaml'), 'utf8');
    for (const key of [...REMOVED_ROOT_KEYS, ...REMOVED_SECTION_KEYS]) {
      assert.doesNotMatch(after, new RegExp(`^\\s*${key}:`, 'm'), `${key} should be gone`);
    }
    assert.equal(ledgerOf(dir).version, 2, 'the re-stamp is recorded');
  });

  test('running it twice changes nothing the second time', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);
    await seeded(dir);

    await migrateRecipes(dir);
    const file = readFileSync(join(dir, 'project.yaml'), 'utf8');
    const ledger = ledgerOf(dir);

    const again = await migrateRecipes(dir);
    assert.deepEqual(again.restamped, [], 'nothing left to move');
    assert.deepEqual(again.stripped, [], 'nothing left to strip');
    assert.equal(again.current.length, ROWS.length, 'all of it reads as current');
    assert.equal(readFileSync(join(dir, 'project.yaml'), 'utf8'), file);
    assert.deepEqual(ledgerOf(dir), ledger);
  });

  test('a take matching neither hash is left alone and reported', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);

    // The important refusal. A clip whose line of dialogue was edited is
    // genuinely stale; blessing it here would ship a reading of a sentence that
    // has been deleted, with nothing anywhere reporting it.
    writeLedger(dir, { 'voice/hero-01.mp3': 'deadbeefdeadbeef' });

    const done = await migrateRecipes(dir);
    assert.deepEqual(done.unrecognised, [{ file: 'voice/hero-01.mp3', take: 'take-1' }]);
    assert.equal(
      ledgerOf(dir).assets['voice/hero-01.mp3']!.takes[0]!.hash,
      'deadbeefdeadbeef',
      'left exactly where it was',
    );
  });

  test('a rejected older take is history, not a problem to report', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);

    // A row that was re-rolled: the selected take matches the old recipe, and
    // the reading rejected months ago under a different prompt matches nothing
    // and never did. Across the three real shows this is eighty-eight takes —
    // counted as `unrecognised` it made the confirm dialog read like damage.
    const legacy = await legacyHashesFor(dir, ROWS);
    writeFileSync(
      join(dir, '.ledger.json'),
      JSON.stringify({
        version: 1,
        assets: {
          'images/room.png': {
            selected: 'take-2',
            takes: [
              { id: 'take-1', hash: 'anolderprompt00', at: '2025-01-01T00:00:00.000Z' },
              { id: 'take-2', hash: legacy['images/room.png'], at: '2026-01-01T00:00:00.000Z' },
            ],
          },
        },
      }),
      'utf8',
    );

    const done = await migrateRecipes(dir);
    assert.deepEqual(done.unrecognised, [], 'the row points at a take that was recognised');
    assert.equal(done.historical, 1, 'and the rejected one is counted, not listed');

    const takes = ledgerOf(dir).assets['images/room.png']!.takes;
    assert.equal(takes[0]!.hash, 'anolderprompt00', 'history is left exactly as it was');
    assert.notEqual(takes[1]!.hash, legacy['images/room.png'], 'the selected one moved');
  });

  test('a row the scenario stopped referencing is left for pruneOrphans', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);
    writeLedger(dir, { 'images/gone.png': 'deadbeefdeadbeef' });

    const done = await migrateRecipes(dir);
    assert.deepEqual(done.restamped, []);
    assert.deepEqual(done.unrecognised, [], 'an orphan is not an unrecognised take');
    assert.equal(ledgerOf(dir).assets['images/gone.png']!.takes[0]!.hash, 'deadbeefdeadbeef');
  });

  test('a comment left describing a key that has gone is reported, never reworded', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);
    await seeded(dir);

    const done = await migrateRecipes(dir);
    assert.ok(
      done.staleComments.some((note) => note.text.includes('The house style')),
      `expected the tokens comment reported, got ${JSON.stringify(done.staleComments)}`,
    );
    assert.ok(
      done.staleComments.every((note) => note.line > 0),
      'a report with no line number is not findable',
    );
  });

  test('the author’s other comments and hand wrapping survive', async (t) => {
    const { dir, cleanup } = workshop();
    t.after(cleanup);
    const file = join(dir, 'project.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'assets:',
        '# Every prompt below was tuned against the real model.\nassets:',
      ),
      'utf8',
    );
    await seeded(dir);

    await migrateRecipes(dir);
    const after = readFileSync(file, 'utf8');
    assert.match(after, /# Every prompt below was tuned against the real model\./);
    assert.match(after, /prompt: SHIP\. The room at dawn\./, 'the prompt itself is untouched');
  });
});

describe('knowing whether a project needs it', () => {
  test('a project carrying any removed key does', () => {
    assert.equal(needsRecipeMigration('tokens:\n  SHIP: a hull\n'), true);
    assert.equal(needsRecipeMigration('sections:\n  images:\n    style: painterly\n'), true);
    assert.equal(needsRecipeMigration('assets:\n  a.png:\n    negative: text\n'), true);
  });

  test('a project born after the deletion never does', () => {
    // The trap a version number would have fallen into: a fresh project has a
    // version-1 ledger by default and nothing whatever to migrate.
    assert.equal(
      needsRecipeMigration('project: demo\nassets:\n  a.png:\n    prompt: a room\n'),
      false,
    );
  });

  test('an unreadable file is somebody else’s error to report', () => {
    assert.equal(needsRecipeMigration('this: is: not: yaml:\n  - ['), false);
  });
});
