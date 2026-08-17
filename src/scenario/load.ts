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

/** Asset paths a scenario expects to exist, for preflight and client prefetch. */
export function assetsOf(scenario: Scenario): string[] {
  const assets = new Set<string>();
  for (const character of Object.values(scenario.characters)) {
    if (character.sprite) assets.add(character.sprite);
  }
  for (const scene of Object.values(scenario.scenes)) {
    if (scene.background) assets.add(scene.background);
    if (scene.music) assets.add(scene.music);
    if (scene.ambience) assets.add(scene.ambience);
  }
  for (const node of scenario.nodes) {
    if (node.type === 'dialogue') {
      for (const line of node.lines) {
        if (line.sfx) assets.add(line.sfx);
      }
    }
  }
  return [...assets].sort();
}
