/**
 * Putting the storyboard's named blocks back into a prompt.
 *
 * A storyboard writes `STYLE. SHIP. Pre-dawn at a working naval jetty…` and
 * defines STYLE and SHIP once, hundreds of characters each, in a section of its
 * own. That is the right way to write it — the style belongs to the production
 * rather than to any one shot — and it is exactly wrong to hand to a model,
 * which reads `STYLE.` as a word and returns a picture with none of the palette
 * and a ship that is a different ship in every frame.
 *
 * The failure these guard is silent in both directions. Unexpanded, the prompt
 * looks fine on the board and the art comes back wrong. Expanded by pasting at
 * import time, one edit to the ship's bible has to be made twenty times, and
 * nineteen of them will be missed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { composePrompt, declaredIn } from '../client/app/prompt.ts';
import { ProjectSchema, recipeHash, resolveRecipe } from '../client/app/project.ts';
import { parseStoryboard } from '../client/app/storyboard.ts';
import { placeTokens } from '../client/app/projects.ts';

const STORYBOARD = [
  '## 3. Visual style',
  '',
  '### 3.1 The style token (prepend to *every* image prompt)',
  '',
  '```',
  'STYLE: cinematic 2.5D animated illustration, muted North Atlantic palette;',
  'strong rim light, deep shadow; no text, no lettering',
  '```',
  '',
  '### 3.2 The negative token',
  '',
  '```',
  'NEGATIVE: text, letters, watermarks, photorealistic faces, extra fingers',
  '```',
  '',
  "**PATHFINDER's design bible** (paste into every hull shot):",
  '',
  '```',
  'SHIP: a 90-metre uncrewed surface combatant — low tumblehome hull,',
  'no bridge windows anywhere, no railings. The absence of a place for a person is the point.',
  '```',
  '',
  '```yaml',
  '# Furniture: a config sample, not a definition.',
  'id: arctic-sentinel',
  '```',
  '',
  '## ACT A',
  '',
  '### Shot A.1 — Cold open',
  '**Hold:** 8 s · **Scene:** `halifax`',
  '',
  '**IMAGE**',
  '```',
  'STYLE. SHIP. Pre-dawn at a working naval jetty, wet concrete.',
  'NEGATIVE.',
  '```',
  '',
  '**MOTION** Slow parallax push toward the bow.',
  '',
].join('\n');

describe('what a storyboard defines once', () => {
  test('the named blocks are read, and the furniture is not', () => {
    const { tokens } = parseStoryboard(STORYBOARD);
    assert.deepEqual(Object.keys(tokens).sort(), ['NEGATIVE', 'SHIP', 'STYLE']);
    assert.match(tokens.STYLE!, /muted North Atlantic palette/);
    assert.match(tokens.SHIP!, /90-metre uncrewed surface combatant/);
    // A storyboard is full of fenced blocks that are examples, tables and
    // config samples. A rule that took all of them would fill the project file
    // with furniture.
    assert.equal(tokens.id, undefined);
  });

  test('the shot keeps its prompt exactly as the author wrote it', () => {
    const shot = parseStoryboard(STORYBOARD).shots[0]!;
    // Not expanded at import. The whole point of a name is that the thing it
    // names can be edited in one place afterwards.
    assert.match(shot.image!, /^STYLE\. SHIP\./);
    assert.match(shot.image!, /NEGATIVE\.$/);
  });

  test('style and negative go to the fields that already mean them', () => {
    const placed = placeTokens(parseStoryboard(STORYBOARD).tokens);
    // Not into `tokens`: a section's `style` and `negative` existed first and
    // are already folded into every recipe in the section. A second copy would
    // be a second place to edit and a second thing to forget.
    assert.match(placed.style!, /North Atlantic/);
    assert.match(placed.negative!, /extra fingers/);
    assert.deepEqual(Object.keys(placed.tokens), ['SHIP']);
  });
});

describe('composing what the model is handed', () => {
  function project(overrides: Record<string, unknown> = {}) {
    return ProjectSchema.parse({
      project: 'demo',
      scenario: 'scenario.yaml',
      publish: 'assets',
      sections: {
        images: {
          backend: 'manual',
          style: 'cinematic 2.5D illustration, muted palette',
          negative: 'text, letters, watermarks',
        },
      },
      tokens: { SHIP: 'a 90-metre uncrewed surface combatant, no bridge windows' },
      assets: {
        'images/a1-jetty.jpg': {
          prompt: 'STYLE. SHIP. Pre-dawn at a working naval jetty.\nNEGATIVE.',
        },
      },
      ...overrides,
    });
  }

  test('every named block is replaced, in the place the author put it', () => {
    const composed = composePrompt(resolveRecipe(project(), 'images', 'images/a1-jetty.jpg'));
    assert.equal(
      composed.positive,
      'cinematic 2.5D illustration, muted palette ' +
        'a 90-metre uncrewed surface combatant, no bridge windows ' +
        'Pre-dawn at a working naval jetty.',
    );
    // `NEGATIVE.` is a marker, not text: a person pasting into a web UI has one
    // box, and every generator here has two.
    assert.ok(!composed.positive.includes('NEGATIVE'));
    assert.equal(composed.negative, 'text, letters, watermarks');
    assert.deepEqual(composed.unresolved, []);
  });

  test('a prompt typed by hand still gets the style', () => {
    // Nobody types `STYLE.`, and a row that loses the style is the one frame
    // that does not match the film.
    const typed = project({
      assets: { 'images/a1-jetty.jpg': { prompt: 'A gull on a bollard.' } },
    });
    const composed = composePrompt(resolveRecipe(typed, 'images', 'images/a1-jetty.jpg'));
    assert.equal(composed.positive, 'cinematic 2.5D illustration, muted palette A gull on a bollard.');
  });

  test('a name nothing defines is left alone and reported', () => {
    const missing = project({ tokens: {} });
    const composed = composePrompt(resolveRecipe(missing, 'images', 'images/a1-jetty.jpg'));
    // Left in rather than deleted: a prompt quietly missing its ship reads as a
    // prompt that was always about an empty jetty, and nothing would say
    // otherwise.
    assert.match(composed.positive, /SHIP\./);
    assert.deepEqual(composed.unresolved, ['SHIP']);
  });

  test('an abbreviation in prose is not reported as a missing name', () => {
    // A storyboard is full of them — RIB, AIS, VHF, ROE — and by shape alone an
    // all-caps word ending a sentence is indistinguishable from a reference.
    // Position is what separates them: the convention puts references in a run
    // at the front. A warning that fires on "answering nobody on AIS." is one
    // people learn to skip, and the warning it was written for goes with it.
    const prose = project({
      tokens: {},
      assets: {
        'images/a1-jetty.jpg': {
          prompt: 'STYLE. A boarding party launches off the RIB. She is running dark on AIS.',
        },
      },
    });
    const composed = composePrompt(resolveRecipe(prose, 'images', 'images/a1-jetty.jpg'));
    assert.deepEqual(composed.unresolved, []);
    // And left in the prompt untouched, because they are words.
    assert.match(composed.positive, /off the RIB./);
    assert.match(composed.positive, /dark on AIS./);
  });

  test('the leading run and the trailing marker are what count', () => {
    assert.deepEqual(declaredIn('STYLE. SHIP. A jetty at low tide.'), ['STYLE', 'SHIP']);
    assert.deepEqual(declaredIn('Wide shot of the ship. Camera low.'), []);
    assert.deepEqual(declaredIn('A jetty at low tide.\nNEGATIVE.'), ['NEGATIVE']);
    assert.deepEqual(declaredIn('Launched off the RIB. Then a cut.'), []);
  });

  test('editing a bible makes every shot that mentions it stale', () => {
    const before = recipeHash(resolveRecipe(project(), 'images', 'images/a1-jetty.jpg'));
    const after = recipeHash(
      resolveRecipe(
        project({ tokens: { SHIP: 'a 90-metre uncrewed combatant, now with railings' } }),
        'images',
        'images/a1-jetty.jpg',
      ),
    );
    // The whole reason the bible is referred to rather than pasted: one edit
    // changes all of them, and all of them have to say so.
    assert.notEqual(before, after);
  });

  test('editing a bible nothing mentions ages nothing', () => {
    const gull = { assets: { 'images/gull.jpg': { prompt: 'STYLE. A gull.' } } };
    const before = recipeHash(resolveRecipe(project(gull), 'images', 'images/gull.jpg'));
    const after = recipeHash(
      resolveRecipe(
        project({ ...gull, tokens: { SHIP: 'something else entirely' } }),
        'images',
        'images/gull.jpg',
      ),
    );
    // Only what a prompt refers to. Folding in every definition the project
    // holds would re-roll forty images because somebody fixed a typo in a
    // bible none of them mention.
    assert.equal(before, after);
  });
});
