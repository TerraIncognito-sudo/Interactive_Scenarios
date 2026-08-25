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
import type { AssetSection } from '../../src/scenario/load.ts';

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
  // The schema hangs `background` off the scene, and a storyboard has many more
  // shots than places. The first shot in a scene supplies that scene's still;
  // every later shot's still is reported as unplaceable rather than silently
  // dropped, because those prompts represent real work the author intended.
  const scenes: Record<string, Record<string, string>> = {};
  const sceneClaimed = new Set<string>();

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
    }
  }

  const placed = new Set<string>();
  for (const scene of Object.values(scenes)) {
    for (const file of Object.values(scene)) placed.add(file);
  }

  // --- nodes --------------------------------------------------------------
  const nodes: Record<string, unknown>[] = [];

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
        duration: shot.hold ?? 5,
        next: next ? nodeId(next) : 'debrief',
      });
      return;
    }

    nodes.push({
      id: nodeId(shot),
      type: 'dialogue',
      ...(shot.scene ? { scene: shot.scene } : {}),
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
      why:
        asset.section === 'images' || asset.section === 'video'
          ? `scene "${asset.scene ?? '?'}" already has a ${asset.section === 'images' ? 'background' : 'video'}; ` +
            `the schema allows one per scene, not one per shot`
          : 'nothing in the generated scenario references it',
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
      images: { backend: 'manual', style: '', negative: '' },
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
