/**
 * What a brief must not ask a portrait for.
 *
 * All that is left of prompt composition, and that is deliberate. This file
 * used to expand `STYLE.` and `SHIP.` into the four hundred characters a
 * storyboard defines once and refers to by name, because a model handed
 * `STYLE.` reads it as a stray token and returns a picture with none of the
 * palette. That machinery is gone with the generators it fed: nothing here
 * hands a prompt to a model any more, so a prompt is a note to whoever makes
 * the picture, and a person reading `STYLE.` knows perfectly well where the
 * style is written down.
 *
 * What survives is the one check that was never about composition. A portrait
 * is a cutout — the display draws it over the scene with a `drop-shadow`, which
 * follows the alpha — and a character sheet is written as a *reference* image,
 * on a neutral field, which is right for a reference and wrong for the file the
 * display floats over a harbour at dawn. A brief asking for a background is
 * asking for the thing that makes the portrait arrive as a bust card with a
 * shadow around all four sides: a failure that reads as a deliberate frame,
 * which is why it would survive all the way to a projector.
 */

/** An author who has already asked for a cutout in their own words keeps theirs. */
const MENTIONS_CUTOUT = /\b(transparent|transparency|cutout|cut-out|alpha channel)\b/i;

/**
 * Whether a portrait's brief is asking for the very thing a cutout removes.
 *
 * Worth one warning; not worth a machine rewriting the sentence, which is how
 * prose that was already true eventually gets rewritten too.
 */
export function asksForBackground(prompt: string): boolean {
  if (MENTIONS_CUTOUT.test(prompt)) return false;
  return /(?<!\bno\s)(?<!\bwithout\s)\b(?:background|backdrop)\b/i.test(prompt);
}
