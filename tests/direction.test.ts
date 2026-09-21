/**
 * The sentence in front of a brief, and the two things it must never become.
 *
 * It must never reach the recipe hash, or tightening a word in it costs a
 * re-make of every row in the section — the failure that made `style:` too
 * expensive to edit and eventually too expensive to keep. And it must never
 * carry a number an author typed, because the number it would carry is the
 * size, and a section holds rows of more than one size: Arctic Sentinel's
 * images are nine stills at 1920x1080 and four faces at 832x1216, so a typed
 * "1920x1080" is wrong on four of thirteen and wrong silently.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CUTOUT_DIRECTION,
  DIRECTION_TOKENS,
  SECTION_DIRECTIONS,
  expandDirection,
} from '../client/app/direction.ts';
import { ProjectSchema, recipeHash, resolveRecipe } from '../client/app/project.ts';
import { ASSET_SECTIONS } from '../shared/scenario/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('what a section says before anybody has an opinion', () => {
  test('every section that is made by hand has a default, and voice has none', () => {
    for (const section of ASSET_SECTIONS) {
      if (section === 'voice') {
        // Not an oversight. A voice row's box holds the line itself rather
        // than a brief, its clips are made by the one generator that exists,
        // and the thing that would go in front of a spoken line is already the
        // character's delivery note.
        assert.equal(SECTION_DIRECTIONS[section], undefined, 'voice has no brief to precede');
        continue;
      }
      assert.ok(
        SECTION_DIRECTIONS[section]?.trim(),
        `${section} is made somewhere else, so it needs something to say`,
      );
    }
  });

  test('no default names a token that does not exist', () => {
    // A `$szie` in a default is a `$szie` on somebody's clipboard, read by a
    // model as those literal characters — and defaults are the copy most
    // people never edit.
    for (const [section, text] of Object.entries(SECTION_DIRECTIONS)) {
      for (const [, name] of text!.matchAll(/\$([a-z]+)/g)) {
        assert.ok(
          (DIRECTION_TOKENS as readonly string[]).includes(name!),
          `${section} uses $${name}, which nothing fills in`,
        );
      }
    }
  });

  test('the audio sections do not ask for a size, because there is not one', () => {
    for (const section of ['sfx', 'ambience', 'music'] as const) {
      assert.doesNotMatch(SECTION_DIRECTIONS[section]!, /\$size/);
    }
  });
});

describe('filling one in for a row', () => {
  test('a still and a portrait in one section get their own size', () => {
    // The whole argument for a token rather than a typed number, in two lines.
    const direction = SECTION_DIRECTIONS.images!;
    const still = expandDirection(direction, { file: 'images/jetty.png', size: '1920x1080' });
    const face = expandDirection(direction, {
      file: 'images/rook.png',
      size: '832x1216',
      cutout: true,
    });

    assert.match(still, /1920x1080 \.PNG/);
    assert.match(face, /832x1216 \.PNG/);
    assert.doesNotMatch(face, /1920x1080/);
  });

  test('only the cutout is told it is a cutout', () => {
    // A portrait made on a white field arrives as a bust card with a shadow
    // round all four sides, which reads as a deliberate frame — so it survives
    // to a projector. The still beside it must not be told to be transparent.
    const direction = SECTION_DIRECTIONS.images!;
    assert.ok(
      expandDirection(direction, { file: 'a.png', size: '832x1216', cutout: true }).includes(
        CUTOUT_DIRECTION,
      ),
    );
    assert.doesNotMatch(
      expandDirection(direction, { file: 'a.png', size: '1920x1080' }),
      /transparent/,
    );
  });

  test('an empty token leaves no gap where it was', () => {
    // `$cutout` is empty on nine rows out of thirteen, and `$size` on every
    // audio row. Left as written, each one ends the sentence with a dangling
    // space or opens a double one in the middle of it.
    const still = expandDirection('Generate a $size image from this. $cutout', {
      file: 'a.png',
      size: '1920x1080',
    });
    assert.equal(still, 'Generate a 1920x1080 image from this.');

    const bed = expandDirection('Produce a $size .$format bed.', { file: 'music/sea.mp3' });
    assert.equal(bed, 'Produce a .MP3 bed.');
  });

  test('a line that was indented stays indented', () => {
    const text = expandDirection('Make this:\n  - $size\n  - .$format', {
      file: 'a.png',
      size: '1920x1080',
    });
    assert.equal(text, 'Make this:\n  - 1920x1080\n  - .PNG');
  });

  test('a word that is not a token is left exactly as written', () => {
    // Prose is prose. A `$` in a sentence is a `$`, and a typo left visible is
    // a typo somebody can see and fix — swallowed, it is a sentence with a
    // hole in it that reads fine.
    assert.equal(
      expandDirection('Budget $5, and mind the $szie.', { file: 'a.png' }),
      'Budget $5, and mind the $szie.',
    );
  });
});

describe('what it must never touch', () => {
  const base = {
    project: 'p',
    scenario: 'scenario.yaml',
    publish: 'dist/assets',
    assets: { 'images/room.png': { prompt: 'a room' } },
  };

  test('editing a section direction marks nothing stale', () => {
    // The reason it may exist at all. Everything in it that decides what the
    // picture is — the size, the cutout, the format — is already in the hash
    // by way of `size` and `portrait`, so hashing the sentence that says those
    // out loud would double-count them and make a wording change cost a
    // re-make of all thirteen rows.
    const without = ProjectSchema.parse({
      ...base,
      sections: { images: { backend: 'manual' } },
    });
    const with_ = ProjectSchema.parse({
      ...base,
      sections: { images: { backend: 'manual', direction: 'Generate a $size .$format image.' } },
    });
    const changed = ProjectSchema.parse({
      ...base,
      sections: { images: { backend: 'manual', direction: 'Something else entirely.' } },
    });

    const hash = recipeHash(resolveRecipe(without, 'images', 'images/room.png'));
    assert.equal(hash, recipeHash(resolveRecipe(with_, 'images', 'images/room.png')));
    assert.equal(hash, recipeHash(resolveRecipe(changed, 'images', 'images/room.png')));
  });

  test('it is not the same field as a voice direction, which is in the hash', () => {
    // Two things called `direction` at two paths. One is how a character
    // sounds and belongs in the hash; this one is how a file is made and does
    // not. Folded together, re-wording a section's sentence would re-record
    // ninety lines.
    const spoken = {
      project: 'p',
      scenario: 'scenario.yaml',
      publish: 'dist/assets',
      assets: { 'voice/a.mp3': { voice: 'rook', text: 'Hello.' } },
    };
    const calm = ProjectSchema.parse({ ...spoken, voices: { rook: { direction: 'calm' } } });
    const urgent = ProjectSchema.parse({ ...spoken, voices: { rook: { direction: 'urgent' } } });
    assert.notEqual(
      recipeHash(resolveRecipe(calm, 'voice', 'voice/a.mp3')),
      recipeHash(resolveRecipe(urgent, 'voice', 'voice/a.mp3')),
    );
  });
});

describe('the board and the token list', () => {
  test('every token is named where somebody would look for it', async () => {
    // Crude on purpose, in the house style: the hint under the box is the only
    // place a token is discoverable, and a token added here and not mentioned
    // there is a feature nobody can find. A check that needs a browser is a
    // check nobody runs.
    const source = await readFile(join(root, 'client/web/board/assets.js'), 'utf8');
    const hint = /direction-hint[\s\S]*?\n {2}\);/.exec(source)?.[0];
    assert.ok(hint, 'the hint under the direction box is still there');
    for (const token of DIRECTION_TOKENS) {
      assert.ok(hint.includes(`$${token}`), `the hint names $${token}`);
    }
  });
});
