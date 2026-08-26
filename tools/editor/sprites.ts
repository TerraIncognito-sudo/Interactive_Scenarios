/**
 * Giving a character a face.
 *
 * The display has drawn portraits since the beginning — bottom right, over the
 * dialogue box, sliding in when someone speaks, which is the shape every 2D RPG
 * and visual novel has used for thirty years. What it has never had is a
 * picture: `sprite:` is optional on a character, no scenario declared one, and
 * a portrait nothing declares is a portrait nobody notices is missing.
 *
 * A storyboard that plans this writes a **character sheet** — one neutral
 * three-quarter portrait per character, generated first and used as the
 * reference for every later shot so that faces do not drift between scenes.
 * This is what turns those three paragraphs of prose into three files the show
 * will actually open.
 *
 * **Who gets one is the storyboard's decision, not this file's.** Arctic
 * Sentinel has six speaking parts and three sheets: the narrator has no face,
 * the ship is a ship, and the Russian officer is explicitly "heard only over
 * radio; never seen as a face". Wiring a portrait for every character who
 * speaks would invent three faces the document deliberately withheld — and the
 * one for the ship would be a person.
 *
 * **A portrait is a cutout, so it is a PNG.** The display draws it over the
 * scene with a drop shadow that follows its outline, which is the whole reason
 * that shadow is a `drop-shadow` and not a `box-shadow`. Give it a JPEG and the
 * silhouette is a rectangle: a bust card with a hard edge and a shadow around
 * all four sides, sitting on top of a harbour at dawn. That reads as a
 * deliberate frame rather than as a mistake, which is exactly why it would
 * survive to the projector.
 */

import { isMap, isScalar, parseDocument } from 'yaml';
import { assetReferencesOf } from '../../src/scenario/load.ts';
import type { Scenario } from '../../src/scenario/schema.ts';
import { applyEdits, indentOf, insertionAfter, pairFor, type Edit } from './yaml-edit.ts';
import { filed } from './storyboard.ts';
import { isPortrait } from './size.ts';

export type WiredSprite = { character: string; sheet: string; file: string };

export type SpriteWiring = {
  source: string;
  wired: WiredSprite[];
  /** Characters that already had a usable portrait, left exactly as they were. */
  untouched: string[];
  /**
   * Portraits re-pointed from a format that cannot hold a cutout.
   *
   * The rest of the pipeline follows these: recipe rows, ledger entries and
   * published files are all keyed by filename, so a rename that only touched
   * the scenario would orphan an afternoon of prompt tuning.
   */
  moved: { from: string; to: string }[];
  /** Sheets with no character to attach to, and why. */
  skipped: { sheet: string; why: string }[];
};

/**
 * Formats with no alpha channel to have.
 *
 * Narrow on purpose: anything not on this list is left exactly as the author
 * wrote it. A `.webp` portrait may well be a cutout, and re-pointing one to a
 * PNG would be this file overruling a decision it has no evidence about.
 */
const FLAT_FORMATS = new Set(['jpg', 'jpeg', 'bmp']);

/** Every file the scenario shows as somebody's face. */
export function portraitFilesOf(scenario: Scenario): Set<string> {
  return new Set(
    assetReferencesOf(scenario)
      .filter((ref) => isPortrait([ref.origin]))
      .map((ref) => ref.file),
  );
}

/**
 * Which character a sheet labelled `Beaudoin` belongs to.
 *
 * A storyboard names people the way people are named — by surname, by the part
 * they play — and a scenario keys them by a short id. Joining the two is the
 * one guess in this file, so it is made narrowly: the label has to be the id
 * outright, or appear as a whole word in the character's name. `Beaudoin`
 * matches `LCdr Élise Beaudoin`; it does not match `Beaudoin's cabin`, and
 * nothing partial matches at all.
 *
 * Ambiguity is refused rather than resolved. Two characters whose names both
 * contain the label is a document the author has to disambiguate, and picking
 * one would put a face on the wrong person for the length of a show.
 */
function characterFor(scenario: Scenario, label: string): string | { why: string } {
  const wanted = label.toLowerCase();
  const matches: string[] = [];

  for (const [id, character] of Object.entries(scenario.characters)) {
    if (id.toLowerCase() === wanted) return id;
    const words = character.name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    if (words.includes(wanted)) matches.push(id);
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    return { why: `matches ${matches.join(' and ')} — rename one, or state the id` };
  }
  return { why: 'no character in the scenario has that id or that word in their name' };
}

/**
 * Declares a `sprite:` for every character the storyboard drew a sheet for.
 *
 * Pure, so the caller can validate before writing: a scenario that would not
 * load is a bug here, and the author's file is not where anyone should find out
 * about it. Idempotent — a character who already has a portrait keeps the one
 * they have, which is what makes this a button rather than a script.
 */
export function wireSpritesInto(
  source: string,
  scenario: Scenario,
  sheets: Record<string, string>,
): SpriteWiring {
  const doc = parseDocument(source);
  const characters = doc.get('characters');
  if (!isMap(characters)) {
    return { source, wired: [], untouched: [], moved: [], skipped: [] };
  }

  const wired: WiredSprite[] = [];
  const untouched: string[] = [];
  const moved: { from: string; to: string }[] = [];
  const skipped: { sheet: string; why: string }[] = [];
  const edits: Edit[] = [];

  for (const [label, prompt] of Object.entries(sheets)) {
    if (!prompt.trim()) continue;

    const found = characterFor(scenario, label);
    if (typeof found !== 'string') {
      skipped.push({ sheet: label, why: found.why });
      continue;
    }

    const entry = characters.get(found, true);
    if (!isMap(entry)) {
      skipped.push({ sheet: label, why: `"${found}" is not written out as a map to add a key to` });
      continue;
    }

    const already = scenario.characters[found]?.sprite;
    if (already) {
      // Portraits declared before this editor knew a sprite had to be a cutout
      // are pointed at a `.jpg`. Re-point them — but only the ones that are
      // plainly this action's own earlier work, matched by the sheet name it
      // would have written. A portrait the author aimed somewhere else is
      // theirs, and a `.webp` may already be a cutout.
      const swap = repointed(already, found);
      const value = pairFor(entry, 'sprite')?.value;
      if (!swap || !isScalar(value) || !value.range) {
        untouched.push(found);
        continue;
      }
      edits.push({ at: value.range[0], end: value.range[1], text: swap });
      moved.push({ from: already, to: swap });
      wired.push({ character: found, sheet: label, file: swap });
      continue;
    }

    // Beside `name:`, which is the key it belongs with — a portrait and a
    // nameplate are the same fact about how a character appears on screen.
    // Appended after `color:` it would read as an afterthought.
    const at = insertionAfter(source, entry, 'name') ?? insertionAfter(source, entry, 'color');
    if (!at) {
      skipped.push({ sheet: label, why: `"${found}" has no name: to hang a portrait beside` });
      continue;
    }

    const file = sheetName(found);
    const nameKey = pairFor(entry, 'name')?.key;
    const keyAt = isScalar(nameKey) ? nameKey.range?.[0] : undefined;
    const indent = at.flow ? '' : indentOf(source, keyAt ?? at.at);
    edits.push({
      at: at.at,
      text: at.flow ? `, sprite: ${file}` : `\n${indent}sprite: ${file}`,
    });
    wired.push({ character: found, sheet: label, file });
  }

  return { source: applyEdits(source, edits), wired, untouched, moved, skipped };
}

/** `images/beau-sheet.png` — filed by media type, and transparent by extension. */
export function sheetName(character: string): string {
  return filed('images', `${character}-sheet.png`);
}

/**
 * The PNG an already-declared portrait should become, or nothing.
 *
 * Only a file this action would itself have written, in a format that cannot
 * hold a cutout. The folder is kept rather than re-filed: an author who put
 * their portraits somewhere else meant it, and this is not the action that
 * moves things.
 */
function repointed(current: string, character: string): string | undefined {
  const match = /^(.*?)([^/]+)\.([A-Za-z0-9]+)$/.exec(current);
  if (!match) return undefined;
  const [, dir, base, extension] = match;
  if (base !== `${character}-sheet`) return undefined;
  if (!FLAT_FORMATS.has(extension!.toLowerCase())) return undefined;
  return `${dir}${base}.png`;
}
