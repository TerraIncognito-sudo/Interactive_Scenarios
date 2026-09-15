/**
 * Portraits: who gets one, what it is called, and what has to be true of it.
 *
 * The failure behind the transparency half is quiet enough to reach an
 * audience. The display draws a portrait over the scene with a shadow that
 * follows its outline, so a JPEG — which has no outline, only four corners —
 * arrives as a bust card with a hard edge and a shadow around all four sides.
 * It reads as a deliberate frame, which is exactly why nobody questions it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenarioSource } from '../shared/scenario/load.ts';
import {
  portraitFilesOf,
  removeSpriteFrom,
  sheetName,
  SpriteError,
  wireSpritesInto,
} from '../client/app/sprites.ts';
import { asksForBackground, composePrompt } from '../client/app/prompt.ts';
import { ProjectSchema, recipeHash, resolveRecipe } from '../client/app/project.ts';

const SHEETS = {
  Beaudoin: 'STYLE. Character reference sheet, neutral slate background. A woman in her forties.',
  Tran: 'STYLE. Character reference sheet, neutral slate background. A man in his thirties.',
};

function scenarioSource(sprites: Record<string, string> = {}): string {
  const line = (id: string) => (sprites[id] ? `\n    sprite: ${sprites[id]}` : '');
  return [
    'id: demo',
    'title: Demo',
    'start: a',
    'characters:',
    '  beau:',
    '    name: LCdr Élise Beaudoin   # the captain',
    `    color: "#88aaff"${line('beau')}`,
    '  tran:',
    '    name: PO Tran',
    `    color: "#ffcc88"${line('tran')}`,
    '  pf:',
    '    name: HMCS Pathfinder',
    'scenes:',
    '  bridge: {}',
    'nodes:',
    '  - id: a',
    '    type: end',
    '    text: Done',
    '',
  ].join('\n');
}

function parse(source: string) {
  const result = parseScenarioSource(source);
  assert.ok(result.ok, `scenario did not load: ${result.ok ? '' : result.message}`);
  return result.scenario;
}

describe('declaring a portrait', () => {
  test('a sheet becomes a transparent PNG, filed by media type', () => {
    const source = scenarioSource();
    const result = wireSpritesInto(source, parse(source), SHEETS);

    assert.deepEqual(
      result.wired.map((entry) => entry.file),
      ['images/beau-sheet.png', 'images/tran-sheet.png'],
    );
    assert.equal(sheetName('beau'), 'images/beau-sheet.png');
    // And the result is a scenario, not merely a string that looked plausible.
    assert.equal(parse(result.source).characters.beau!.sprite, 'images/beau-sheet.png');
  });

  test('the character sheets are the ones drawn, not the cast list', () => {
    const source = scenarioSource();
    const result = wireSpritesInto(source, parse(source), SHEETS);
    // `pf` is a warship. Wiring every speaking part would give it a face.
    assert.equal(parse(result.source).characters.pf!.sprite, undefined);
  });

  test("the author's own comments and spacing survive", () => {
    const source = scenarioSource();
    const result = wireSpritesInto(source, parse(source), SHEETS);
    assert.match(result.source, /name: LCdr Élise Beaudoin {3}# the captain/);
  });
});

describe('a portrait already pointed at a flat format', () => {
  test('is re-pointed, and the rename is reported so the row can follow', () => {
    const source = scenarioSource({ beau: 'images/beau-sheet.jpg' });
    const result = wireSpritesInto(source, parse(source), SHEETS);

    assert.deepEqual(result.moved, [
      { from: 'images/beau-sheet.jpg', to: 'images/beau-sheet.png' },
    ]);
    assert.equal(parse(result.source).characters.beau!.sprite, 'images/beau-sheet.png');
  });

  test('running it twice changes nothing the second time', () => {
    const source = scenarioSource();
    const once = wireSpritesInto(source, parse(source), SHEETS);
    const twice = wireSpritesInto(once.source, parse(once.source), SHEETS);

    assert.equal(twice.source, once.source);
    assert.deepEqual(twice.moved, []);
    assert.deepEqual(twice.untouched, ['beau', 'tran']);
  });

  test('a file the author aimed somewhere else is left alone', () => {
    // Not this action's own naming, so not this action's to rename. A portrait
    // pointed at art that exists is a decision, and overruling it silently is
    // how an author finds their picture replaced by an empty row.
    const source = scenarioSource({ beau: 'images/elise-painted.jpg' });
    const result = wireSpritesInto(source, parse(source), SHEETS);

    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.untouched, ['beau']);
    assert.equal(parse(result.source).characters.beau!.sprite, 'images/elise-painted.jpg');
  });

  test('a webp is left alone, because it may already be a cutout', () => {
    const source = scenarioSource({ tran: 'images/tran-sheet.webp' });
    const result = wireSpritesInto(source, parse(source), SHEETS);
    assert.deepEqual(result.moved, []);
    assert.deepEqual(result.untouched, ['tran']);
  });
});

describe('what a portrait prompt turns into', () => {
  const wired = (() => {
    const source = scenarioSource();
    return parse(wireSpritesInto(source, parse(source), SHEETS).source);
  })();

  function project(prompt: string) {
    return ProjectSchema.parse({
      project: 'demo',
      scenario: 'scenario.yaml',
      publish: 'assets',
      generated: 'generated',
      sections: { images: { backend: 'manual', style: 'Muted maritime film still.' } },
      assets: { 'images/beau-sheet.png': { prompt } },
    });
  }

  const portraitOf = (prompt: string) =>
    composePrompt(
      resolveRecipe(project(prompt), 'images', 'images/beau-sheet.png', { portrait: true }),
    );

  test('the scenario is what says a file is a face', () => {
    assert.deepEqual([...portraitFilesOf(wired)].sort(), [
      'images/beau-sheet.png',
      'images/tran-sheet.png',
    ]);
  });

  test('the cutout instruction is added, and the background terms with it', () => {
    const composed = portraitOf(SHEETS.Beaudoin);
    assert.match(composed.positive, /isolated on a flat even background/);
    assert.match(composed.positive, /matted onto transparency/i);
    assert.match(composed.negative, /scenery/);
    // The style still leads. A portrait that does not match the film is a
    // portrait that reads as clip art the moment it slides in.
    assert.match(composed.positive, /^Muted maritime film still\./);
  });

  test('a full-frame still gets none of it', () => {
    const jetty = composePrompt(resolveRecipe(project('A jetty at dawn.'), 'images', 'images/x'));
    assert.doesNotMatch(jetty.positive, /matted onto transparency/i);
    assert.doesNotMatch(jetty.negative, /scenery/);
  });

  test('an author who asked in their own words keeps theirs', () => {
    // Otherwise the composed prompt says it twice, in two vocabularies, and the
    // author's edit reads as having done nothing.
    const composed = portraitOf('Bust on a transparent background, hair tied back.');
    assert.equal((composed.positive.match(/transparen/gi) ?? []).length, 1);
  });

  test('the cutout is part of the recipe, not a flourish on the preview', () => {
    // A picture made before this and one made after are different pictures. If
    // the hash could not tell them apart the board would call the old one done.
    const plain = recipeHash(resolveRecipe(project(SHEETS.Beaudoin), 'images', 'images/beau-sheet.png'));
    const cut = recipeHash(
      resolveRecipe(project(SHEETS.Beaudoin), 'images', 'images/beau-sheet.png', {
        portrait: true,
      }),
    );
    assert.notEqual(plain, cut);
  });
});

describe('a prompt that argues with itself', () => {
  test("the storyboard's neutral field is worth one warning", () => {
    assert.equal(asksForBackground(SHEETS.Beaudoin), true);
  });

  test('and saying there is none is not', () => {
    assert.equal(asksForBackground('Bust portrait, no background, even light.'), false);
    assert.equal(asksForBackground('Bust portrait on transparent background.'), false);
    assert.equal(asksForBackground('Bust portrait, three-quarter view.'), false);
  });
});

describe('removing a portrait', () => {
  test('drops the sprite: and leaves the rest of the character alone', () => {
    const source = scenarioSource({ beau: 'images/beau-sheet.png' });
    const result = removeSpriteFrom(source, parse(source), 'beau');
    const scenario = parse(result.source);

    assert.equal(scenario.characters.beau!.sprite, undefined);
    assert.equal(result.file, 'images/beau-sheet.png');
    assert.equal(scenario.characters.beau!.name, 'LCdr Élise Beaudoin');
    assert.equal(scenario.characters.beau!.color, '#88aaff');
    // The comment is the tell that this was a source edit and not a round trip
    // through the object model, which would have dropped it.
    assert.match(result.source, /name: LCdr Élise Beaudoin {3}# the captain/);
  });

  test('takes the whole line, leaving no blank where it was', () => {
    const source = scenarioSource({ beau: 'images/beau-sheet.png' });
    const result = removeSpriteFrom(source, parse(source), 'beau');
    // Byte for byte what the file looked like before the portrait was declared:
    // declaring and removing is a round trip, or every experiment costs a line.
    assert.equal(result.source, scenarioSource());
  });

  test('leaves every other character showing their own face', () => {
    const source = scenarioSource({ beau: 'images/beau-sheet.png', tran: 'images/tran-sheet.png' });
    const result = removeSpriteFrom(source, parse(source), 'beau');
    assert.equal(parse(result.source).characters.tran!.sprite, 'images/tran-sheet.png');
    assert.deepEqual(result.sharedWith, []);
  });

  test('says when the picture is still somebody else’s, so nothing calls it spare', () => {
    // Two parts sharing one portrait: removing one does not take the file out
    // of the show, and reporting it as a stray would be an offer to delete a
    // picture the projector is still opening.
    const shared = 'images/beau-sheet.png';
    const source = scenarioSource({ beau: shared, tran: shared });
    const result = removeSpriteFrom(source, parse(source), 'beau');
    assert.deepEqual(result.sharedWith, ['tran']);
    assert.equal(parse(result.source).characters.tran!.sprite, shared);
  });

  test('handles a character written inline, where a line-wide delete would take everything', () => {
    const source = [
      'id: demo',
      'title: Demo',
      'start: a',
      'characters:',
      '  beau: { name: Beaudoin, sprite: images/beau-sheet.png, color: "#88aaff" }',
      'scenes:',
      '  bridge: {}',
      'nodes:',
      '  - id: a',
      '    type: end',
      '    text: Done',
      '',
    ].join('\n');

    const result = removeSpriteFrom(source, parse(source), 'beau');
    const scenario = parse(result.source);
    assert.equal(scenario.characters.beau!.sprite, undefined);
    assert.equal(scenario.characters.beau!.name, 'Beaudoin');
    assert.equal(scenario.characters.beau!.color, '#88aaff');
    // The comma goes with it, or the map reads `{ name: Beaudoin, , color: … }`.
    assert.ok(!result.source.includes(', ,'));
    assert.match(result.source, /beau: \{ name: Beaudoin, color: "#88aaff" \}/);
  });

  test('removing the first key of an inline map eats the comma after it instead', () => {
    const source = [
      'id: demo',
      'title: Demo',
      'start: a',
      'characters:',
      '  beau: { sprite: images/beau-sheet.png, name: Beaudoin }',
      'scenes:',
      '  bridge: {}',
      'nodes:',
      '  - id: a',
      '    type: end',
      '    text: Done',
      '',
    ].join('\n');

    const result = removeSpriteFrom(source, parse(source), 'beau');
    assert.equal(parse(result.source).characters.beau!.sprite, undefined);
    assert.equal(parse(result.source).characters.beau!.name, 'Beaudoin');
  });

  test('refuses a character with no portrait, and one who does not exist', () => {
    const source = scenarioSource({ beau: 'images/beau-sheet.png' });
    const scenario = parse(source);
    assert.throws(() => removeSpriteFrom(source, scenario, 'tran'), SpriteError);
    assert.throws(() => removeSpriteFrom(source, scenario, 'nobody'), SpriteError);
  });

  test('takes the file off the board, which is what puts it in front of the stray list', () => {
    const source = scenarioSource({ beau: 'images/beau-sheet.png' });
    const before = portraitFilesOf(parse(source));
    const after = portraitFilesOf(parse(removeSpriteFrom(source, parse(source), 'beau').source));

    assert.ok(before.has('images/beau-sheet.png'));
    assert.ok(!after.has('images/beau-sheet.png'));
  });

  test('declaring and removing round-trips, so the button is safe to experiment with', () => {
    const source = scenarioSource();
    const wired = wireSpritesInto(source, parse(source), SHEETS);
    let out = wired.source;
    for (const entry of wired.wired) {
      out = removeSpriteFrom(out, parse(out), entry.character).source;
    }
    assert.equal(out, source);
  });
});
