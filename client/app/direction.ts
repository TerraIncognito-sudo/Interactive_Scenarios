/**
 * The standing instruction at the top of a section, and the facts a row can
 * fill into it.
 *
 * Every section but voice is made by hand, in another program, by pasting a
 * brief into something. The brief on the row is the shot; the sentence in
 * front of it is the same for all ninety of them — what kind of file to make,
 * how big, what the projector does with it. Typed once per section rather than
 * ninety times, and kept in `project.yaml` because it belongs to this show
 * rather than to this machine.
 *
 * This is `style:` returning, and the difference is the whole of why it may.
 * The old field was *composed* into what a generator received, so the box an
 * author edited was not the text the model got and the board grew a preview to
 * explain the gap. Nothing is composed into anything here: the row's brief is
 * stored exactly as it is typed, the direction is a separate sentence the
 * author can read in full at the top of the section, and the only place the
 * two are ever joined is on the clipboard.
 *
 * It is deliberately **not** in the recipe hash. Everything in it that decides
 * what the picture is — the size, the cutout, the format — is already hashed
 * by way of `size` and `portrait` on the Recipe, so hashing the sentence that
 * says those out loud would double-count them and make a wording change cost a
 * re-make of every row in the section.
 *
 * Note that `direction` also names a *voice's* delivery note (`VoiceSchema`),
 * which is a different thing at a different path and is in the hash. The two
 * must never be folded together: one is how a character sounds, this is how a
 * file is made.
 */

import type { AssetSection } from '../../shared/scenario/load.ts';

/**
 * The facts a row can put into its section's direction.
 *
 * Deliberately facts rather than prose. Each one is read off the row the
 * button was pressed on, so a portrait's `$size` is the portrait's size and a
 * sound effect's is empty — which is the whole reason a typed-in "1920x1080"
 * was the wrong design. Arctic Sentinel's images section holds nine stills at
 * 1920x1080 and four portraits at 832x1216, so a section sentence carrying the
 * number literally would have been a lie on four of its thirteen rows.
 *
 * An empty value is ordinary: `$size` on a music bed has no answer, and the
 * expansion leaves nothing rather than the word "$size", because prose read by
 * a model must never contain the name of a thing that was meant to be filled
 * in. Anything that is not on this list is left exactly as written — a `$` in
 * a sentence is a `$`, and a typo left as `$siz` is visible where a typo
 * silently swallowed is not.
 */
export const DIRECTION_TOKENS = ['size', 'format', 'cutout', 'file'] as const;

export type DirectionToken = (typeof DIRECTION_TOKENS)[number];

/**
 * What a section says before anybody has an opinion about it.
 *
 * A default rather than something written into `project.yaml` at creation, so
 * a project made a year ago gets one too and an author who never touches the
 * box still gets a usable paste. Clearing the box removes the key and comes
 * back here.
 *
 * Voice has none, and that is not an oversight: a voice row's box holds the
 * line itself rather than a brief, its clips are made by the generator this
 * whole group of sections lacks, and the thing that would go in front of a
 * spoken line already exists as the character's delivery note.
 */
export const SECTION_DIRECTIONS: Partial<Record<AssetSection, string>> = {
  images: 'Generate a $size .$format image from the following brief. $cutout',
  video: 'Generate a $size .$format video clip from the following brief.',
  sfx: 'Produce a .$format sound effect from the following brief.',
  // Both beds are mixed under the voice, because the voice is the thing an
  // audience has to follow — so an even bed is a requirement rather than
  // taste, and saying so is the difference between a loop and a track.
  ambience:
    'Produce a seamlessly looping .$format ambience bed from the following brief. ' +
    'It plays under the dialogue, so keep it even and free of sudden events.',
  music:
    'Produce a .$format music bed from the following brief. It plays under the ' +
    'dialogue, so keep it even and leave room for a voice.',
};

/**
 * What `$cutout` says on a row that is somebody's face.
 *
 * Empty on everything else. A portrait is drawn over the scene with a
 * `drop-shadow` that follows the alpha, so one made on a white field arrives
 * as a bust card with a shadow around all four sides — a failure that reads as
 * a deliberate frame, which is exactly why it survives all the way to a
 * projector. The row's own brief is free to say it again; this is the half
 * that is true of every cutout and so belongs where it is not retyped.
 */
export const CUTOUT_DIRECTION =
  'The background must be fully transparent: this is a cutout the stage ' +
  'composites over the scene, not a picture with a backdrop.';

/** The facts one row can answer its section's direction with. */
export type DirectionFacts = {
  /** The filename the scenario declares, which carries the extension. */
  file: string;
  /** What the row asks for, or what its kind defaults to. Absent for audio. */
  size?: string;
  /** True for a portrait, which the stage draws as a cutout over the scene. */
  cutout?: boolean;
};

/**
 * Fills a section's direction in for one row.
 *
 * Done here rather than in the board, and the reason is the reason everything
 * else in this codebase is done once: the sentence a model is handed would
 * otherwise be composed in a page no test can import, and the one that fell
 * behind would be the one nobody was looking at. The board receives the
 * finished text on the row and puts it on the clipboard.
 *
 * A token with nothing to say leaves nothing behind, including the space in
 * front of it — a direction ending "from the following brief. $cutout" must
 * not end in a dangling space on the nine rows out of thirteen that are not
 * cutouts.
 */
export function expandDirection(direction: string, facts: DirectionFacts): string {
  const values: Record<DirectionToken, string> = {
    size: facts.size ?? '',
    format: (facts.file.split('.').pop() ?? '').toUpperCase(),
    cutout: facts.cutout ? CUTOUT_DIRECTION : '',
    file: facts.file,
  };

  const filled = direction.replace(/\$([a-z]+)/g, (whole, name: string) =>
    (DIRECTION_TOKENS as readonly string[]).includes(name) ? values[name as DirectionToken] : whole,
  );

  // Per line, and never touching what a line starts with: a direction written
  // as an indented list keeps its shape, and only the gaps an empty token
  // opened in the middle of a sentence are closed.
  return filled
    .split('\n')
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      return indent + line.slice(indent.length).replace(/[ \t]{2,}/g, ' ').trimEnd();
    })
    .join('\n')
    .trim();
}
