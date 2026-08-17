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
import type { Scenario, ScenarioNode } from './schema.ts';

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

    if (node.type === 'dialogue') {
      node.lines.forEach((line, i) => {
        if (line.who !== undefined && !(line.who in scenario.characters)) {
          errors.push({
            nodeId: node.id,
            message: `line ${i + 1} references unknown character "${line.who}"`,
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
