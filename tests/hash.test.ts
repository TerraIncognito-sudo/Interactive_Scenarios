/**
 * The recipe hash, pinned on both sides of the change that moved it.
 *
 * A hash is the only thing on the board that says a finished file still answers
 * the row that asked for it. `canonical()` filters `undefined` and nothing
 * else, so every hash ever recorded contains the whole recipe object of the day
 * it was written — and on a voice row that included `negative: ""`,
 * `style: ""`, `refs: []` and `tokens: {}`, none of which a voice clip ever
 * used. Deleting those four moved all 208 hashes across three finished shows at
 * once, voice rows included.
 *
 * So this file pins the arithmetic at both ends and the bridge between them.
 * The fixture is a checked-in project still carrying the old keys — it is the
 * pre-migration artefact, deliberately, and the current strict schema refuses
 * to load it. `legacyHashesFor` must still produce the values recorded against
 * it in the commit before the deletion, and `migrate-recipes` must land every
 * one of them on the value the board computes now.
 *
 * If a literal here changes, that is not a failing test to be updated. The
 * left-hand column is what is written in three ledgers on disk, and the
 * right-hand column is what the board is about to ask for. Moving either
 * without a migration in front of it is the board about to call three finished
 * shows unfinished.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, pathsOf, recipeHash, resolveRecipe } from '../client/app/project.ts';
import { legacyHashesFor, migrateRecipes } from '../client/app/migrate-recipes.ts';
import { parseScenarioSource, type AssetSection } from '../shared/scenario/load.ts';
import { portraitFilesOf } from '../client/app/sprites.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'hash-legacy');

/**
 * One asset per section, with the hash on each side of the deletion.
 *
 * The portrait is not decoration: `portrait` reaches the recipe from the
 * *scenario* rather than from `project.yaml`, so without a sprite here the one
 * field with a scenario-derived value would go untested.
 */
const EXPECTED: [file: string, section: AssetSection, before: string, after: string][] = [
  ['ambience/sea.mp3', 'ambience', '62925880ac7b36d6', '366b5aa77b6fed93'],
  ['images/hero-sheet.png', 'images', 'be105852dd336fe3', '4993b9e814a28491'],
  ['images/jetty.png', 'images', '4850f2eaa39da6da', '515977b2a378bb8f'],
  ['sfx/burst.mp3', 'sfx', '1ac030e68c72fa7f', '809c417353a5d9d4'],
  ['video/approach.mp4', 'video', '4e5cd42d476e8045', 'a4b74ea3545cd014'],
  ['voice/narr-01.mp3', 'voice', 'ba0c1fdcfce65502', 'e032404a37f9c5e2'],
];

/** A throwaway copy, because migrating writes to the project it is given. */
async function copyOfFixture(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'is-hash-')), 'project');
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

describe('the recipe hash is frozen', () => {
  test('the old world still computes what three ledgers have written in them', async () => {
    // The frozen half of `migrate-recipes` is a copy of code that no longer
    // exists anywhere else. Nothing but this says it is still a faithful one.
    const dir = await copyOfFixture();
    const legacy = await legacyHashesFor(
      dir,
      EXPECTED.map(([file]) => file),
    );

    for (const [file, , before] of EXPECTED) {
      assert.equal(legacy[file], before, `${file}: the frozen half has drifted from the old code`);
    }
  });

  test('migrating lands every section on the hash the board now asks for', async () => {
    const dir = await copyOfFixture();
    await migrateRecipes(dir);

    const file = join(dir, 'project.yaml');
    const project = await loadProject(file);
    const paths = pathsOf(file, project);
    const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
    assert.ok(parsed.ok, 'the migrated fixture must load');
    const portraits = portraitFilesOf(parsed.scenario);

    for (const [name, section, , after] of EXPECTED) {
      const hash = recipeHash(
        resolveRecipe(project, section, name, { portrait: portraits.has(name) }),
      );
      assert.equal(hash, after, `${name} hashed to ${hash}, not ${after}`);
    }
  });

  test('every section moved, voice included', () => {
    // The prediction that made the migration necessary. The four deleted fields
    // were empty on a voice row and it moved anyway, because `canonical` hashed
    // them being empty.
    for (const [file, , before, after] of EXPECTED) {
      assert.notEqual(before, after, `${file} did not move, so one of these literals is wrong`);
    }
  });

  test('a portrait hashes differently from the same file that is not one', async () => {
    // Otherwise the portrait row above proves nothing: it would pass whether or
    // not `portrait` reached the recipe at all.
    const dir = await copyOfFixture();
    await migrateRecipes(dir);
    const project = await loadProject(join(dir, 'project.yaml'));
    const file = 'images/hero-sheet.png';

    const asPortrait = recipeHash(resolveRecipe(project, 'images', file, { portrait: true }));
    const asStill = recipeHash(resolveRecipe(project, 'images', file, { portrait: false }));

    assert.notEqual(asPortrait, asStill, 'portrait must be inside the hash');
    assert.equal(asPortrait, '4993b9e814a28491');
  });
});

/**
 * The same claim, against the real shows.
 *
 * The fixture proves the arithmetic; this proves the consequence. It only runs
 * where the author's own projects are — `project.yaml` and `.ledger.json` are
 * gitignored, so on a clean clone there is nothing to count and the test says
 * so rather than passing quietly.
 *
 * **Named, not walked.** It used to read the directory, which quietly made
 * every project the workspace has ever held part of the assertion — and the
 * workspace is this repo's own `scenarios/`, so the first show anybody started
 * failed the census by existing, with a message saying a clip they had not
 * recorded yet was missing. A half-finished project is the ordinary state of a
 * project. What this protects is the three that are done.
 */
const FINISHED: Record<string, number> = {
  'arctic-sentinel': 84,
  'team-union': 57,
  'team-union-video': 67,
};

describe('the finished shows are still finished', () => {
  test('every row of every finished project is ready, and matched by hash', async () => {
    const { loadLedger } = await import('../client/app/project.ts');
    const { buildOverview } = await import('../client/app/sections.ts');

    const root = join(import.meta.dirname, '..', 'scenarios');

    const counted: Record<string, number> = {};
    for (const name of Object.keys(FINISHED)) {
      const file = join(root, name, 'project.yaml');

      // "There is no project here" and "the project here will not load" are
      // different answers and only one of them is fine. Catching both as one
      // made this whole census pass by skipping every project the moment the
      // schema changed under it — which is the exact way a test goes green for
      // the wrong reason that this file exists to prevent.
      const source = await readFile(file, 'utf8').catch(() => undefined);
      if (source === undefined) continue; // a scenario with no editor half; first-contact is one

      const project = await loadProject(file).catch((err: Error) => {
        assert.fail(`${name}/project.yaml exists but will not load: ${err.message}`);
      });

      const paths = pathsOf(file, project);
      const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
      assert.ok(parsed.ok, `${name}: scenario.yaml must load`);

      const { ledger } = await loadLedger(paths.ledger);
      const overview = await buildOverview(parsed.scenario, project, ledger, paths);
      const rows = overview.sections.flatMap((section) => section.assets);
      if (rows.length === 0) continue;

      for (const row of rows) {
        // `frozen` reports ready without matching, deliberately — so assert the
        // hash itself rather than the status, or a freeze would hide a move.
        const selected = row.takes.find((take) => take.id === row.selected);
        assert.equal(
          row.status,
          'ready',
          `${name}/${row.file} is ${row.status}, and it was ready when this test was written`,
        );
        assert.equal(
          selected?.hash,
          row.hash,
          `${name}/${row.file}: the selected take no longer matches its recipe`,
        );
      }
      counted[name] = rows.length;
    }

    if (Object.keys(counted).length === 0) {
      // Not a pass. A clean clone has no projects to count, and saying so is
      // the difference between "nothing to check" and "everything checked out".
      console.log('  (none of the finished shows are here — census skipped)');
      return;
    }

    // Recorded rather than merely summed: a row vanishing is as interesting as
    // one going stale, and a bare total would hide it.
    assert.deepEqual(counted, FINISHED);
  });
});
