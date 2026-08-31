/**
 * Referential integrity checks that a Zod schema cannot express.
 *
 * Zod proves each node is individually well-formed; this proves the graph
 * hangs together — every `next` resolves, every poll can always leave, every
 * character and scene referenced actually exists.
 *
 * This is the preflight that turns "the show froze in front of 40 people"
 * into "the CLI printed an error before you left the office".
 */

import { parseExpr, referencedVars, ExprError } from '../engine/expr.ts';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, type Scenario, type ScenarioNode } from './schema.ts';

export type Problem = {
  nodeId?: string;
  message: string;
};

export type CheckResult = {
  errors: Problem[];
  warnings: Problem[];
};

/** Every node id a given node can hand control to. */
export function exitsOf(node: ScenarioNode): string[] {
  switch (node.type) {
    case 'dialogue':
    case 'pause':
    case 'gate':
      return [node.next];
    case 'poll':
      return node.options.map((o) => o.next);
    case 'branch':
      return [...node.when.map((w) => w.next), node.else];
    case 'end':
      return [];
  }
}

const MAGIC_SET_VALUES = new Set(['$winner', '$winnerLabel', '$total']);

export function checkScenario(scenario: Scenario): CheckResult {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];

  const byId = new Map<string, ScenarioNode>();
  for (const node of scenario.nodes) {
    if (byId.has(node.id)) {
      errors.push({ nodeId: node.id, message: `Duplicate node id "${node.id}"` });
      continue;
    }
    byId.set(node.id, node);
  }

  if (!byId.has(scenario.start)) {
    errors.push({ message: `start node "${scenario.start}" does not exist` });
  }

  // Variables any poll can write, used to catch typos in branch conditions.
  const settableVars = new Set<string>();
  for (const node of scenario.nodes) {
    if (node.type === 'poll' && node.set) {
      for (const name of Object.keys(node.set)) settableVars.add(name);
    }
  }

  for (const [id, scene] of Object.entries(scenario.scenes)) {
    if (scene.video !== undefined && !VIDEO_EXTENSIONS.test(scene.video)) {
      errors.push({
        message: `scene "${id}" has video "${scene.video}", which is not a video file`,
      });
    }

    // The still is what paints while the clip decodes. Without one the
    // projector shows black for as long as the first frame takes.
    if (scene.video !== undefined && scene.background === undefined) {
      warnings.push({
        message: `scene "${id}" has video but no background to use as its poster frame`,
      });
    }
  }

  for (const node of scenario.nodes) {
    for (const target of exitsOf(node)) {
      if (!byId.has(target)) {
        errors.push({
          nodeId: node.id,
          message: `points to "${target}", which is not a node in this scenario`,
        });
      }
    }

    if (node.scene !== undefined && !(node.scene in scenario.scenes)) {
      errors.push({ nodeId: node.id, message: `references unknown scene "${node.scene}"` });
    }

    if (node.video !== undefined && !VIDEO_EXTENSIONS.test(node.video)) {
      errors.push({
        nodeId: node.id,
        message: `has video "${node.video}", which is not a video file the display can play`,
      });
    }

    // A node's override is per-field, so it is possible to take the clip from
    // the node and the still from the scene. Sometimes that is exactly right —
    // motion added over the scene's picture — and sometimes it pairs one shot's
    // still with another shot's clip, which only shows up on a projector.
    const sceneOf = node.scene ? scenario.scenes[node.scene] : undefined;
    const still = node.background ?? sceneOf?.background;
    if ((node.background !== undefined || node.video !== undefined) && still === undefined) {
      warnings.push({
        nodeId: node.id,
        message: 'overrides the scene media but nothing supplies a background to paint under it',
      });
    } else if (node.video !== undefined && node.background === undefined && sceneOf?.background) {
      warnings.push({
        nodeId: node.id,
        message:
          `has its own video but takes its poster frame from scene "${node.scene}" — ` +
          `intended if the clip is motion over that still, wrong if it is a different shot`,
      });
    } else if (node.background !== undefined && node.video === undefined && sceneOf?.video) {
      warnings.push({
        nodeId: node.id,
        message:
          `has its own background but plays scene "${node.scene}"'s clip over it — ` +
          `those are two different shots unless the clip is place-wide motion`,
      });
    }

    if (node.type === 'dialogue') {
      node.lines.forEach((line, i) => {
        if (line.who !== undefined && !(line.who in scenario.characters)) {
          errors.push({
            nodeId: node.id,
            message: `line ${i + 1} references unknown character "${line.who}"`,
          });
        }

        if (line.voice !== undefined && !AUDIO_EXTENSIONS.test(line.voice)) {
          errors.push({
            nodeId: node.id,
            message:
              `line ${i + 1} has voice "${line.voice}", which is not an audio file ` +
              `the display can play`,
          });
        }

        // Nothing on the server reads the clip, so the beat ends when the
        // estimate says it does. An unheld voiced line either talks over the
        // next one or sits in silence, and neither is visible until showtime.
        if (line.voice !== undefined && line.hold === undefined) {
          warnings.push({
            nodeId: node.id,
            message:
              `line ${i + 1} has a voice clip but no hold: — its time on screen is a ` +
              `reading-speed estimate that does not know how long the clip runs`,
          });
        }
      });
    }

    if (node.type === 'poll') {
      const keys = new Set<string>();
      for (const option of node.options) {
        if (keys.has(option.key)) {
          errors.push({ nodeId: node.id, message: `duplicate option key "${option.key}"` });
        }
        keys.add(option.key);
      }

      if (!keys.has(node.default)) {
        errors.push({
          nodeId: node.id,
          message:
            `default "${node.default}" is not one of its option keys ` +
            `(${[...keys].join(', ')}) — a poll with no votes would have nowhere to go`,
        });
      }

      for (const [name, value] of Object.entries(node.set ?? {})) {
        if (value.startsWith('$') && !MAGIC_SET_VALUES.has(value)) {
          errors.push({
            nodeId: node.id,
            message:
              `set.${name} uses unknown placeholder "${value}" ` +
              `(expected one of ${[...MAGIC_SET_VALUES].join(', ')})`,
          });
        }
      }
    }

    if (node.type === 'branch') {
      node.when.forEach((condition, i) => {
        try {
          const ast = parseExpr(condition.if);
          for (const name of referencedVars(ast)) {
            if (!settableVars.has(name)) {
              warnings.push({
                nodeId: node.id,
                message:
                  `condition ${i + 1} reads variable "${name}", which no poll ever sets ` +
                  `— it will always be undefined`,
              });
            }
          }
        } catch (err) {
          const detail = err instanceof ExprError ? err.message : String(err);
          errors.push({
            nodeId: node.id,
            message: `condition ${i + 1} ("${condition.if}") is not a valid expression: ${detail}`,
          });
        }
      });
    }
  }

  // Reachability walk from the start node.
  if (byId.has(scenario.start)) {
    const reached = new Set<string>();
    const queue = [scenario.start];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      const node = byId.get(id);
      if (!node) continue;
      for (const target of exitsOf(node)) {
        if (!reached.has(target)) queue.push(target);
      }
    }

    for (const node of scenario.nodes) {
      if (!reached.has(node.id)) {
        warnings.push({ nodeId: node.id, message: `is unreachable from "${scenario.start}"` });
      }
    }

    const reachesAnEnd = [...reached].some((id) => byId.get(id)?.type === 'end');
    if (!reachesAnEnd) {
      warnings.push({
        message: `no "end" node is reachable — the story has no defined finish`,
      });
    }
  }

  return { errors, warnings };
}

/** Formats a check result for terminal output. */
export function formatProblems(result: CheckResult): string {
  const lines: string[] = [];
  for (const e of result.errors) {
    lines.push(`  ERROR  ${e.nodeId ? `[${e.nodeId}] ` : ''}${e.message}`);
  }
  for (const w of result.warnings) {
    lines.push(`  warn   ${w.nodeId ? `[${w.nodeId}] ` : ''}${w.message}`);
  }
  return lines.join('\n');
}
