/**
 * Turning a storyboard into a project.
 *
 * This runs once, when a project is created. It writes two files that are then
 * owned by different people: a `scenario.yaml` the author will keep editing,
 * and a `project.yaml` whose asset rows arrive pre-filled with the prompts the
 * storyboard already contains. Retyping twenty-six image prompts is the kind of
 * work that stops a pipeline being used.
 *
 * It is deliberately not clever. Where the storyboard cannot be expressed by
 * the scenario schema, the scaffold says so and leaves the prompt out rather
 * than inventing structure — a report you can act on beats a file you have to
 * unpick.
 */

import { stringify as stringifyYaml } from 'yaml';
import { parseStoryboard, proposeAssets, shotSlug, type StoryboardShot } from './storyboard.ts';
import type { AssetSection } from '../../shared/scenario/load.ts';

export type ScaffoldReport = {
  /** Prompts from the storyboard that today's schema has nowhere to put. */
  unplaceable: { file: string; section: AssetSection; why: string }[];
  warnings: string[];
  counts: { shots: number; scenes: number; characters: number; assets: number };
};

export type Scaffold = {
  scenarioYaml: string;
  projectYaml: string;
  report: ScaffoldReport;
};

/** `narr` -> `Narr`. A placeholder the author will replace with a real name. */
function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replaceAll(/[-_]/g, ' ');
}

function nodeId(shot: StoryboardShot): string {
  return shotSlug(shot.id);
}

export function scaffoldFromStoryboard(
  source: string,
  options: { id: string; title: string },
): Scaffold {
  const { shots, warnings } = parseStoryboard(source);
  const proposed = proposeAssets(shots);
  const unplaceable: ScaffoldReport['unplaceable'] = [];

  // --- characters ---------------------------------------------------------
  const characters: Record<string, { name: string; color: string }> = {};
  for (const shot of shots) {
    for (const line of shot.lines) {
      characters[line.who] ??= { name: titleCase(line.who), color: '#E0E0E0' };
    }
  }

  // --- scenes -------------------------------------------------------------
  //
  // A scene is a place and a node is a shot, so a storyboard's many shots in
  // one room do not need many rooms. The first shot in a scene supplies that
  // scene's still — its establishing picture — and every later shot in the same
  // place carries its own on its node, below.
  const scenes: Record<string, Record<string, string>> = {};
  const sceneClaimed = new Set<string>();
  /** Shots whose picture the scene took, and which therefore need no override. */
  const establishing = new Set<string>();

  for (const shot of shots) {
    if (!shot.scene) continue;
    scenes[shot.scene] ??= {};
    if (!sceneClaimed.has(shot.scene)) {
      const still = proposed.find(
        (asset) => asset.section === 'images' && asset.source.shot === shot.id,
      );
      const clip = proposed.find(
        (asset) => asset.section === 'video' && asset.source.shot === shot.id,
      );
      if (still) scenes[shot.scene]!.background = still.file;
      if (clip) scenes[shot.scene]!.video = clip.file;
      sceneClaimed.add(shot.scene);
      establishing.add(shot.id);
    }
  }

  const placed = new Set<string>();
  for (const scene of Object.values(scenes)) {
    for (const file of Object.values(scene)) placed.add(file);
  }

  // --- nodes --------------------------------------------------------------
  const nodes: Record<string, unknown>[] = [];

  /**
   * A shot's own still and clip, for every shot but its scene's establishing
   * one. Both are optional and independent: a beat that adds motion over the
   * room's picture takes the clip alone, which is a real thing to want and the
   * reason these are not one field.
   */
  function ownMedia(shot: StoryboardShot): Record<string, string> {
    if (establishing.has(shot.id)) return {};
    const media: Record<string, string> = {};
    for (const asset of proposed) {
      if (asset.source.shot !== shot.id) continue;
      if (asset.section === 'images') media.background = asset.file;
      if (asset.section === 'video') media.video = asset.file;
    }
    for (const file of Object.values(media)) placed.add(file);
    return media;
  }

  shots.forEach((shot, index) => {
    const next = shots[index + 1];
    const voices = proposed.filter(
      (asset) => asset.section === 'voice' && asset.source.shot === shot.id,
    );

    const lines = shot.lines.map((line, lineIndex) => {
      const voice = voices.find((asset) => asset.source.line === lineIndex);
      const entry: Record<string, unknown> = { who: line.who, text: line.text };
      // Only when the shot has a single line can its hold be attributed to that
      // line honestly. Otherwise the value is left off: `npm run validate` will
      // flag the voiced line as untimed, which is the correct to-do — the real
      // number comes from the clip's own length once it has been generated.
      if (shot.hold !== undefined && shot.lines.length === 1) entry.hold = shot.hold;
      if (voice) entry.voice = voice.file;
      placed.add(voice?.file ?? '');
      return entry;
    });

    const sfx = proposed.find(
      (asset) => asset.section === 'sfx' && asset.source.shot === shot.id,
    );
    if (sfx && lines.length > 0) {
      (lines[0] as Record<string, unknown>).sfx = sfx.file;
      placed.add(sfx.file);
    }

    if (lines.length === 0) {
      // A shot with no spoken line is a held beat, not dialogue.
      nodes.push({
        id: nodeId(shot),
        type: 'pause',
        ...(shot.scene ? { scene: shot.scene } : {}),
        ...ownMedia(shot),
        duration: shot.hold ?? 5,
        next: next ? nodeId(next) : 'debrief',
      });
      return;
    }

    nodes.push({
      id: nodeId(shot),
      type: 'dialogue',
      ...(shot.scene ? { scene: shot.scene } : {}),
      ...ownMedia(shot),
      lines,
      next: next ? nodeId(next) : 'debrief',
    });
  });

  nodes.push({ id: 'debrief', type: 'end', text: 'Debrief' });

  for (const asset of proposed) {
    if (placed.has(asset.file)) continue;
    unplaceable.push({
      file: asset.file,
      section: asset.section,
      why: 'nothing in the generated scenario references it',
    });
  }

  const scenario = {
    id: options.id,
    title: options.title,
    start: shots.length > 0 ? nodeId(shots[0]!) : 'debrief',
    characters,
    scenes,
    nodes,
  };

  // --- project ------------------------------------------------------------
  const assets: Record<string, Record<string, unknown>> = {};
  for (const asset of proposed) {
    if (!placed.has(asset.file)) continue;
    const row: Record<string, unknown> = {};
    if (asset.prompt) row.prompt = asset.prompt;
    if (asset.text) row.text = asset.text;
    if (asset.voice) row.voice = asset.voice;
    row.source = {
      shot: asset.source.shot,
      ...(asset.source.line !== undefined ? { line: asset.source.line } : {}),
    };
    assets[asset.file] = row;
  }

  const project = {
    project: options.id,
    title: options.title,
    storyboard: 'storyboard.md',
    // Everything a project needs lives inside the project. Nothing here points
    // into the game repo: a scenario is built somewhere else and published
    // somewhere else, and the editor has no stake in either location.
    scenario: 'scenario.yaml',
    publish: 'dist/assets',
    generated: 'generated',
    sections: {
      images: { backend: 'manual' },
      video: { backend: 'manual' },
      voice: { backend: 'manual' },
      sfx: { backend: 'manual' },
      ambience: { backend: 'manual' },
      music: { backend: 'manual' },
    },
    assets,
  };

  return {
    scenarioYaml: stringifyYaml(scenario, { lineWidth: 0 }),
    projectYaml: stringifyYaml(project, { lineWidth: 0 }),
    report: {
      unplaceable,
      warnings,
      counts: {
        shots: shots.length,
        scenes: Object.keys(scenes).length,
        characters: Object.keys(characters).length,
        assets: Object.keys(assets).length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A scenario from nothing
// ---------------------------------------------------------------------------

/**
 * A scenario id out of a folder name.
 *
 * `NEW_PROJECT_NAME` lets a folder be called "My Show", and `idPattern` does
 * not let a scenario be. Two rules, deliberately different — a folder name is
 * for a person reading a file list and an id is referenced by other lines —
 * so the id is derived rather than assumed, or naming a project with a space
 * in it would write a file that will not load.
 */
export function scenarioIdFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  // Every legal folder name starts with a letter or a digit, so this only
  // fires for a name that was entirely punctuation somewhere the folder rule
  // is looser than this one. Better a dull id than an unloadable file.
  return slug === '' ? 'scenario' : slug;
}

/**
 * One of somebody's words, quoted however YAML needs it quoting.
 *
 * `title: Sea State: a rehearsal` is not YAML, and neither is a title starting
 * with a `#`, a `-` or a quote. The rest of this template is ours and can be
 * written out literally; these two values are not, so they go through the
 * serialiser for exactly as long as it takes to make them safe.
 */
function scalar(value: string): string {
  return stringifyYaml(value, { lineWidth: 0 }).trimEnd();
}

/**
 * The file a brand-new project starts life as.
 *
 * Writing one of these by hand meant knowing the shape of a format that is
 * written down in a Zod schema, so the honest first step of "make a new
 * scenario" used to be "go and read `schema.ts`". What comes back instead is a
 * show that already runs: press Play and it plays, and every line of it is
 * meant to be replaced.
 *
 * It declares **no assets**. Declaring a name is what puts a row on the asset
 * board, which is exactly right once somebody knows what picture they want and
 * is a first run that reports one thing missing before they have written a
 * word. A scene with no background renders as a gradient, which is a perfectly
 * good way to write a whole story before any art exists.
 *
 * Written as a string rather than through `stringifyYaml`, unlike the
 * storyboard scaffold beside it. The comments are most of the point — this is
 * the one file in the program whose job is to teach the format — and a
 * serialiser would throw every one of them away.
 */
export function starterScenario(options: { name: string; title?: string }): string {
  const id = scenarioIdFor(options.name);
  // Somebody's words, on one line. A title arrives over HTTP, so it can hold
  // anything at all — and a newline in it would end the comment it is written
  // into and leave the rest of the sentence being read as YAML.
  const title = (options.title ?? options.name).replace(/\s+/g, ' ').trim().slice(0, 120);

  return `# ${title}
#
# A new scenario, and a working one: open the Show tab and press Play and it
# runs. Everything in here is meant to be replaced — it exists so there is
# something on the projector before there is a story, and so the shape of the
# file is in front of you rather than in a schema.
#
# Three things worth knowing before you start deleting:
#
#   - A beat ends when its \`hold\` (in seconds) elapses. Nothing opens the
#     audio file to find out how long it is, so a hold shorter than its clip
#     cuts the line off mid-word. The Assets tab measures the real clips and
#     offers to write these numbers for you.
#   - A scene is a *place*, and several shots can share one. Give a node its
#     own \`background:\` for a new shot in the same room.
#   - Every poll needs a \`default:\`. A vote nobody answers must never be able
#     to stall in front of an audience.
#
# Everything the editor writes back into this file is written in place, so
# these comments survive. They are yours to delete.

id: ${id}
title: ${scalar(title)}
description: One sentence about what the room is going to argue about.

start: title_card

characters:
  narr:
    name: Narrator
    # Quoted, or YAML reads the # as the start of a comment.
    color: '#B0BEC5'

scenes:
  # No background, so this renders as a gradient. Add
  # \`background: images/opening.png\` when you know what you want there —
  # declaring the name is what puts it on the Assets tab to be made.
  opening: {}

nodes:
  # A gate has no clock at all. It waits for the button, which is what lets you
  # talk over a title card for as long as the room needs.
  - id: title_card
    type: gate
    scene: opening
    text: ${scalar(title)}
    label: Start
    next: opening_line

  - id: opening_line
    type: dialogue
    scene: opening
    lines:
      - who: narr
        text: Replace this with the first thing the room hears.
        hold: 4
      - who: narr
        text: One line per beat — the projector shows them one at a time.
        hold: 4
    next: the_question

  - id: the_question
    type: poll
    scene: opening
    question: Replace this with the question the room votes on.
    prompt: There is no right answer. Decide together.
    duration: 60
    options:
      - { key: one, label: The first answer, next: ending_one }
      - { key: two, label: The second answer, next: ending_two }
    default: one
    set:
      # A later \`branch\` node can read this, which is how a vote still matters
      # three scenes on without the script exploding into a tree.
      choice: $winner

  - id: ending_one
    type: end
    scene: opening
    text: The room chose the first answer.

  - id: ending_two
    type: end
    scene: opening
    text: The room chose the second answer.
`;
}
