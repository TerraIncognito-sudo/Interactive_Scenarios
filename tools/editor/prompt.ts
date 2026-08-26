/**
 * Turning a row's prompt into what a generator actually receives.
 *
 * A storyboard does not write prompts out in full, and it is right not to. The
 * style that makes forty images look like one film is four hundred characters
 * long, the ship's design bible is another three hundred, and both belong to
 * the production rather than to any one shot. So the document defines them once
 * and every shot refers to them by name:
 *
 *     STYLE. SHIP. Pre-dawn at a working naval jetty in Halifax Harbour…
 *     NEGATIVE.
 *
 * Left unresolved that is worse than useless. `STYLE.` is not a word a model
 * knows; it reads as a stray token and the picture arrives with none of the
 * palette, none of the lens, and a ship that is a different ship in every shot.
 *
 * The reason this is expansion at generate time rather than a paste at import
 * time is the same reason a section has a `style` at all: one edit has to change
 * all of them. Pasting the bible into twenty hull shots means re-tuning it
 * twenty times, and the resolved text is folded into the recipe so editing it
 * marks every shot that uses it stale — which is exactly what it is.
 */

import type { Recipe } from './project.ts';

/**
 * `STYLE.`, `SHIP.`, `NEGATIVE.` — a bare capitalised word and a full stop.
 *
 * The storyboard's own convention, and a narrow one on purpose. Requiring the
 * terminating stop and the capitals keeps it from matching an ordinary word at
 * the start of a sentence, which a looser rule would do to every prompt in the
 * document.
 */
const TOKEN = /\b([A-Z][A-Z0-9_]{2,})\.(?=\s|$)/g;

/**
 * Every name a prompt could be referring to, in the order it first mentions
 * them.
 *
 * A superset on purpose: an all-caps abbreviation ending a sentence — "launched
 * off the RIB." — is indistinguishable from a reference by shape alone. Callers
 * that resolve names against definitions are unaffected, because an
 * abbreviation matches nothing. It is only *reporting* an unresolved name that
 * needs the narrower rule, which is `declaredIn`.
 */
export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((match) => match[1]!))];
}

/**
 * The names a prompt is plainly *invoking* rather than merely containing.
 *
 * The storyboard's convention is a leading run — `STYLE. SHIP. Pre-dawn at a
 * jetty…` — with `NEGATIVE.` appended at the end. That position is what makes
 * an all-caps word a reference instead of an abbreviation, and it is the only
 * place worth complaining about one nothing defines. A warning that fires on
 * "answering nobody on AIS." is a warning people learn to skip, and the one it
 * was written for goes with it.
 */
export function declaredIn(text: string): string[] {
  const declared: string[] = [];
  const leading = /^\s*(?:([A-Z][A-Z0-9_]{2,})\.\s+)/;
  let rest = text;
  for (;;) {
    const match = leading.exec(rest);
    if (!match) break;
    declared.push(match[1]!);
    rest = rest.slice(match[0].length);
  }
  // And the trailing one, which is where a storyboard appends its negative.
  // On a line of its own, which is how the convention writes it — a sentence
  // that merely *ends* on an abbreviation ("...running dark on AIS.") is prose,
  // and every storyboard is full of those.
  const trailing = /(?:^|\n)[ \t]*([A-Z][A-Z0-9_]{2,})\.[ \t]*$/.exec(text);
  if (trailing) declared.push(trailing[1]!);
  return [...new Set(declared)];
}

export type ComposedPrompt = {
  positive: string;
  negative: string;
  /** Tokens that had no definition, left in place and reported. */
  unresolved: string[];
};

/**
 * The positive and negative prompt a generator would be handed for this asset.
 *
 * Pure, and exported, because the author has to be able to *read* it. Every
 * complaint about a prompt this pipeline has produced so far has come down to
 * not being able to see the thing the model was given — and a prompt you cannot
 * read is one you cannot fix.
 */
/*
 * Two names the composer answers itself rather than from `tokens`.
 *
 * `STYLE` is `sections.<name>.style`, which exists for precisely this and is
 * already folded into the recipe hash — a second copy under another name would
 * be a second place to edit. `NEGATIVE` is a marker rather than text: a
 * storyboard says "append NEGATIVE to every prompt" because a person pasting
 * into a web UI has one box, and every generator here has two.
 */
export function composePrompt(recipe: Recipe): ComposedPrompt {
  const unresolved: string[] = [];
  const style = recipe.style.trim();
  const declared = new Set(declaredIn(recipe.prompt));

  let positive = recipe.prompt.replaceAll(TOKEN, (whole, name: string) => {
    if (name === 'NEGATIVE') return '';
    if (name === 'STYLE') return style;
    const defined = recipe.tokens[name];
    if (defined === undefined) {
      // Only where the prompt is plainly invoking it. Left in place either way:
      // a prompt quietly missing its ship reads as one that was always about an
      // empty jetty, and nothing anywhere would say otherwise.
      if (declared.has(name)) unresolved.push(name);
      return whole;
    }
    return defined.trim();
  });

  // A row typed by hand rather than lifted from the storyboard will not carry
  // `STYLE.`, and dropping the style for it is how one frame ends up not
  // matching the film. Prepended rather than refused, because refusing would
  // make the section's style a thing you have to remember to invoke.
  if (style && !TOKEN_MENTIONS_STYLE.test(recipe.prompt)) {
    positive = positive.trim() ? `${style} ${positive.trim()}` : style;
  }

  return {
    positive: tidy(positive),
    negative: tidy(recipe.negative),
    unresolved: [...new Set(unresolved)],
  };
}

const TOKEN_MENTIONS_STYLE = /\bSTYLE\.(?=\s|$)/;

/**
 * Collapses the whitespace expansion leaves behind.
 *
 * A removed `NEGATIVE.` leaves the blank line it sat on, and a style block
 * spliced mid-sentence arrives with its own hand-wrapping. Neither matters to a
 * model, but both matter to the person reading the preview to decide whether
 * the prompt is any good.
 */
function tidy(text: string): string {
  return text.replaceAll(/[ \t]*\n[ \t]*/g, ' ').replaceAll(/\s{2,}/g, ' ').trim();
}
