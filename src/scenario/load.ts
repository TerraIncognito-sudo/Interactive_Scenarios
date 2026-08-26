/**
 * Loading scenarios from disk: YAML -> validated Scenario -> graph checks.
 *
 * Nothing downstream of here ever sees an unvalidated scenario.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ScenarioSchema, type Scenario } from './schema.ts';
import { checkScenario, type CheckResult } from './check.ts';

export class ScenarioLoadError extends Error {
  readonly scenarioPath: string;
  readonly problems: string[];

  constructor(message: string, scenarioPath: string, problems: string[] = []) {
    super(message);
    this.name = 'ScenarioLoadError';
    this.scenarioPath = scenarioPath;
    this.problems = problems;
  }
}

export type LoadedScenario = {
  scenario: Scenario;
  /** Absolute path to the scenario folder. */
  dir: string;
  /** Non-fatal problems worth surfacing to the author. */
  warnings: CheckResult['warnings'];
};

function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

export type ParseResult =
  | { ok: true; scenario: Scenario; warnings: CheckResult['warnings'] }
  | { ok: false; message: string; problems: string[] };

/**
 * YAML text to a validated scenario.
 *
 * Split out from file loading so the editor can validate text that is still
 * being typed and has never been saved. Both paths must apply exactly the same
 * rules, or the editor would bless a scenario the server then refuses.
 */
export function parseScenarioSource(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, message: `Invalid YAML: ${(err as Error).message}`, problems: [] };
  }

  const result = ScenarioSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      message: 'Scenario does not match the expected format',
      problems: formatZodError(result.error),
    };
  }

  const scenario = result.data;
  const checks = checkScenario(scenario);
  if (checks.errors.length > 0) {
    return {
      ok: false,
      message: 'Scenario graph is invalid',
      problems: checks.errors.map((e) => `${e.nodeId ? `[${e.nodeId}] ` : ''}${e.message}`),
    };
  }

  return { ok: true, scenario, warnings: checks.warnings };
}

/** Parses and fully validates a single scenario.yaml. */
export async function loadScenarioFile(file: string, dir: string): Promise<LoadedScenario> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new ScenarioLoadError(`Could not read ${file}: ${(err as Error).message}`, file);
  }

  const result = parseScenarioSource(raw);
  if (!result.ok) {
    throw new ScenarioLoadError(result.message, file, result.problems);
  }

  return { scenario: result.scenario, dir, warnings: result.warnings };
}

/** Loads the scenario in a given folder (expects scenario.yaml inside). */
export async function loadScenarioDir(dir: string): Promise<LoadedScenario> {
  return loadScenarioFile(join(dir, 'scenario.yaml'), dir);
}

export type ScenarioLibrary = {
  scenarios: Map<string, LoadedScenario>;
  /** Folders that failed to load, so the server can report them without dying. */
  failures: { dir: string; error: ScenarioLoadError }[];
};

/**
 * Loads every scenario folder under `root`.
 *
 * A broken scenario is collected as a failure rather than thrown, so one bad
 * file cannot stop the server from serving the others.
 */
export async function loadLibrary(root: string): Promise<ScenarioLibrary> {
  const scenarios = new Map<string, LoadedScenario>();
  const failures: ScenarioLibrary['failures'] = [];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { scenarios, failures };
  }

  for (const entry of entries.sort()) {
    const dir = join(root, entry);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;

    try {
      const loaded = await loadScenarioDir(dir);
      if (scenarios.has(loaded.scenario.id)) {
        failures.push({
          dir,
          error: new ScenarioLoadError(
            `Duplicate scenario id "${loaded.scenario.id}"`,
            dir,
            [`Another scenario folder already declares id "${loaded.scenario.id}"`],
          ),
        });
        continue;
      }
      scenarios.set(loaded.scenario.id, loaded);
    } catch (err) {
      if (err instanceof ScenarioLoadError) {
        failures.push({ dir, error: err });
      } else {
        failures.push({
          dir,
          error: new ScenarioLoadError((err as Error).message, dir),
        });
      }
    }
  }

  return { scenarios, failures };
}

/**
 * Production sections an asset can belong to.
 *
 * Not derived from the file extension — an `.mp3` in `voice:` and an `.mp3` in
 * `music:` are different work, made by different models, at different lengths.
 * The schema field that referenced the file is the only thing that knows which,
 * so that is what routes it.
 */
export const ASSET_SECTIONS = ['images', 'video', 'voice', 'sfx', 'ambience', 'music'] as const;

export type AssetSection = (typeof ASSET_SECTIONS)[number];

/** Where in the scenario an asset was referenced, for click-through and prefill. */
export type AssetOrigin =
  | { kind: 'sprite'; character: string }
  | { kind: 'background' | 'video' | 'music' | 'ambience'; scene: string }
  /** A node's own still or clip, overriding the scene's while it plays. */
  | { kind: 'background' | 'video'; node: string }
  | { kind: 'voice' | 'sfx'; node: string; line: number };

export type AssetReference = {
  file: string;
  section: AssetSection;
  origin: AssetOrigin;
};

/**
 * Every reference to an asset, in scenario order, keeping duplicates.
 *
 * `assetsOf` answers "what files must exist"; this answers "and who asked for
 * them", which is what lets the editor route a file to exactly one production
 * section and jump back to the line that needs it. Both come from this single
 * walk on purpose: two walks would eventually disagree, and the one that
 * disagreed silently would be the editor's — showing an author a complete
 * manifest while the display preloaded something else.
 */
export function assetReferencesOf(scenario: Scenario): AssetReference[] {
  const refs: AssetReference[] = [];

  for (const [id, character] of Object.entries(scenario.characters)) {
    if (character.sprite) {
      refs.push({
        file: character.sprite,
        section: 'images',
        origin: { kind: 'sprite', character: id },
      });
    }
  }

  for (const [id, scene] of Object.entries(scenario.scenes)) {
    if (scene.background) {
      refs.push({
        file: scene.background,
        section: 'images',
        origin: { kind: 'background', scene: id },
      });
    }
    if (scene.video) {
      refs.push({ file: scene.video, section: 'video', origin: { kind: 'video', scene: id } });
    }
    if (scene.music) {
      refs.push({ file: scene.music, section: 'music', origin: { kind: 'music', scene: id } });
    }
    if (scene.ambience) {
      refs.push({
        file: scene.ambience,
        section: 'ambience',
        origin: { kind: 'ambience', scene: id },
      });
    }
  }

  for (const node of scenario.nodes) {
    // Every node type can carry its own shot, not just dialogue: a poll frame
    // and an ending card are pictures a storyboard draws separately.
    if (node.background) {
      refs.push({
        file: node.background,
        section: 'images',
        origin: { kind: 'background', node: node.id },
      });
    }
    if (node.video) {
      refs.push({ file: node.video, section: 'video', origin: { kind: 'video', node: node.id } });
    }

    if (node.type !== 'dialogue') continue;
    node.lines.forEach((line, index) => {
      if (line.voice) {
        refs.push({
          file: line.voice,
          section: 'voice',
          origin: { kind: 'voice', node: node.id, line: index },
        });
      }
      if (line.sfx) {
        refs.push({
          file: line.sfx,
          section: 'sfx',
          origin: { kind: 'sfx', node: node.id, line: index },
        });
      }
    });
  }

  return refs;
}

/** Asset paths a scenario expects to exist, for preflight and client prefetch. */
export function assetsOf(scenario: Scenario): string[] {
  return [...new Set(assetReferencesOf(scenario).map((ref) => ref.file))].sort();
}
