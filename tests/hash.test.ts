/**
 * The recipe hash, pinned.
 *
 * A hash is the only thing on the board that says a finished file still answers
 * the row that asked for it. Every hash in a project's `.ledger.json` was
 * computed from a `Recipe` of one particular shape — and `canonical()` filters
 * `undefined` and nothing else, so `negative: ''`, `style: ''`, `refs: []` and
 * `tokens: {}` sit inside all 208 recorded hashes across the three finished
 * shows, on voice rows as much as image ones.
 *
 * That makes removing a field from `Recipe` a destructive act at a distance:
 * every row goes `stale` at once, and `adoptTakes` only rescues `unmanaged`, so
 * there is no route back short of re-recording ninety clips a project. This
 * file is the tripwire. It is checked in with its own project, because the real
 * `project.yaml` files are gitignored and a test that skips when its data is
 * missing is a test that is green for the wrong reason.
 *
 * If one of these literals changes, that is not a failing test to be updated —
 * it is the board about to call three finished shows unfinished, and the change
 * needs `migrate-recipes` in front of it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProject, pathsOf, resolveRecipe, recipeHash } from '../tools/editor/project.ts';
import { parseScenarioSource } from '../src/scenario/load.ts';
import { portraitFilesOf } from '../tools/editor/sprites.ts';
import type { AssetSection } from '../src/scenario/load.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'hash-legacy', 'project.yaml');

/**
 * One asset per section, and the hash today's code gives it.
 *
 * The portrait is not decoration: `portrait` reaches the recipe from the
 * *scenario* rather than from `project.yaml`, so without a sprite here the one
 * field with a scenario-derived value would go untested.
 */
const EXPECTED: [file: string, section: AssetSection, hash: string][] = [
  ['ambience/sea.mp3', 'ambience', '62925880ac7b36d6'],
  ['images/hero-sheet.png', 'images', 'be105852dd336fe3'],
  ['images/jetty.png', 'images', '4850f2eaa39da6da'],
  ['sfx/burst.mp3', 'sfx', '1ac030e68c72fa7f'],
  ['video/approach.mp4', 'video', '4e5cd42d476e8045'],
  ['voice/narr-01.mp3', 'voice', 'ba0c1fdcfce65502'],
];

async function fixture() {
  const project = await loadProject(FIXTURE);
  const paths = pathsOf(FIXTURE, project);
  const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
  assert.ok(parsed.ok, 'the fixture scenario must load');
  return { project, portraits: portraitFilesOf(parsed.scenario) };
}

describe('the recipe hash is frozen', () => {
  test('every section hashes to the value recorded against it', async () => {
    const { project, portraits } = await fixture();

    for (const [file, section, expected] of EXPECTED) {
      const recipe = resolveRecipe(project, section, file, { portrait: portraits.has(file) });
      assert.equal(
        recipeHash(recipe),
        expected,
        `${file} hashed to ${recipeHash(recipe)}, not ${expected} — every recorded take of it just went stale`,
      );
    }
  });

  test('a portrait hashes differently from the same file that is not one', async () => {
    // Otherwise the portrait row above proves nothing: it would pass whether or
    // not `portrait` reached the recipe at all.
    const { project } = await fixture();
    const file = 'images/hero-sheet.png';

    const asPortrait = recipeHash(resolveRecipe(project, 'images', file, { portrait: true }));
    const asStill = recipeHash(resolveRecipe(project, 'images', file, { portrait: false }));

    assert.notEqual(asPortrait, asStill, 'portrait must be inside the hash');
    assert.equal(asPortrait, 'be105852dd336fe3');
  });

  test('the fields a deletion would remove are really in there', async () => {
    // The census below can only ever run where the real projects are. This is
    // the same claim, proved against the fixture, so it holds on a clean clone:
    // dropping any of these four moves the hash, which is precisely why the
    // migration has to run before they go.
    const { project } = await fixture();
    const base = resolveRecipe(project, 'voice', 'voice/narr-01.mp3', {});

    assert.deepEqual(
      { negative: base.negative, style: base.style, refs: base.refs, tokens: base.tokens },
      { negative: '', style: '', refs: [], tokens: {} },
      'a voice recipe carries these four empty — and they are still hashed',
    );

    for (const field of ['negative', 'style', 'refs', 'tokens'] as const) {
      const without = { ...base };
      delete (without as Record<string, unknown>)[field];
      assert.notEqual(
        recipeHash(without as typeof base),
        recipeHash(base),
        `dropping ${field} changes the hash of a voice row that never used it`,
      );
    }
  });
});

/**
 * The same claim, against the real shows.
 *
 * The fixture proves the arithmetic; this proves the consequence. It only runs
 * where the author's own projects are — `project.yaml` and `.ledger.json` are
 * gitignored, so on a clean clone there is nothing to count and the test says
 * so rather than passing quietly.
 */
describe('the finished shows are still finished', () => {
  test('every row of every real project is ready, and matched by hash', async () => {
    const { readdir } = await import('node:fs/promises');
    const { loadLedger } = await import('../tools/editor/project.ts');
    const { buildOverview } = await import('../tools/editor/sections.ts');

    const root = join(import.meta.dirname, '..', 'scenarios');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

    const counted: Record<string, number> = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(root, entry.name, 'project.yaml');
      const project = await loadProject(file).catch(() => undefined);
      if (!project) continue; // a scenario with no editor half; first-contact is one

      const paths = pathsOf(file, project);
      const parsed = parseScenarioSource(await readFile(paths.scenario, 'utf8'));
      assert.ok(parsed.ok, `${entry.name}: scenario.yaml must load`);

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
          `${entry.name}/${row.file} is ${row.status}, and it was ready when this test was written`,
        );
        assert.equal(
          selected?.hash,
          row.hash,
          `${entry.name}/${row.file}: the selected take no longer matches its recipe`,
        );
      }
      counted[entry.name] = rows.length;
    }

    if (Object.keys(counted).length === 0) {
      // Not a pass. A clean clone has no projects to count, and saying so is
      // the difference between "nothing to check" and "everything checked out".
      console.log('  (no project.yaml under scenarios/ — census skipped)');
      return;
    }

    // Recorded rather than merely summed: a row vanishing is as interesting as
    // one going stale, and a bare total would hide it.
    assert.deepEqual(counted, {
      'arctic-sentinel': 84,
      'team-union': 57,
      'team-union-video': 67,
    });
  });
});
