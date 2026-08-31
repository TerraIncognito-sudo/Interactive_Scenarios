/**
 * What a scenario reads, writes, and does.
 *
 * Two questions an author actually has, answered without opening a browser or
 * running a show:
 *
 *   1. What goes in and out of each node — which variables it reads, which it
 *      writes, and where control can go from it.
 *   2. How it reacts — given a set of poll outcomes, which path does the story
 *      take and what do the variables end up as.
 *
 * The second one runs the *real* engine rather than a model of it. That is only
 * possible because the engine is pure, and it is the whole reason to keep it
 * that way: a simulation that could drift from production would be worse than
 * no simulation at all.
 */

import { exitsOf } from '../../src/scenario/check.ts';
import { parseExpr, referencedVars } from '../../src/engine/expr.ts';
import {
  lineDuration,
  type PollNode,
  type Scenario,
  type ScenarioNode,
} from '../../src/scenario/schema.ts';
import { beatOf, initialState, reduce, EngineError, type RunState } from '../../src/engine/engine.ts';
import { resolvePoll, variablesFrom } from '../../src/engine/votes.ts';
import type { Value } from '../../src/engine/expr.ts';

export type Exit = {
  to: string;
  /** Why control would take this exit — the condition, or the option label. */
  label: string;
};

export type NodeAnalysis = {
  id: string;
  type: ScenarioNode['type'];
  scene?: string;
  /** A line of the node's content, for recognising it in a list. */
  preview: string;
  /** Variables this node's conditions read. */
  reads: string[];
  /** Variables this node writes, with the expression that produces them. */
  writes: { name: string; value: string }[];
  exits: Exit[];
  /** Nodes that can hand control to this one. */
  enteredFrom: string[];
  reachable: boolean;
  /** Estimated seconds this node occupies. Branches take none by design. */
  seconds: number;
};

export type VariableAnalysis = {
  name: string;
  writtenBy: string[];
  readBy: string[];
};

export type ScenarioAnalysis = {
  id: string;
  title: string;
  start: string;
  nodes: NodeAnalysis[];
  variables: VariableAnalysis[];
  /** Every `end` node, so the set of possible finishes is visible at a glance. */
  endings: string[];
  counts: { nodes: number; polls: number; endings: number; unreachable: number };
};

function previewOf(node: ScenarioNode): string {
  switch (node.type) {
    case 'dialogue':
      return node.lines[0]?.text ?? '';
    case 'poll':
      return node.question;
    case 'branch':
      return node.when.map((w) => w.if).join('  ·  ');
    case 'pause':
      return node.text ?? `${node.duration}s hold`;
    case 'gate':
      return node.text ?? `waits for ${node.label ?? 'the moderator'}`;
    case 'end':
      return node.text ?? '';
  }
}

function secondsOf(node: ScenarioNode, scenario: Scenario): number {
  switch (node.type) {
    case 'dialogue':
      return node.lines.reduce((total, line) => total + lineDuration(line, scenario.settings), 0);
    case 'pause':
    case 'poll':
      return node.duration;
    // Branches are control flow, not content, and never occupy stage time.
    case 'branch':
    case 'end':
      return 0;
    // A gate lasts exactly as long as the moderator lets it, which is not a
    // number this can know. Zero rather than a guess: the running total is
    // billed as "every node laid end to end", and padding it with an invented
    // hold would make the one honest thing about it — that it is a lower
    // bound — quietly false.
    case 'gate':
      return 0;
  }
}

function exitsWithLabels(node: ScenarioNode): Exit[] {
  switch (node.type) {
    case 'dialogue':
    case 'pause':
      return [{ to: node.next, label: 'then' }];
    case 'gate':
      return [{ to: node.next, label: 'on continue' }];
    case 'poll':
      return node.options.map((option) => ({
        to: option.next,
        label: `${option.key} — ${option.label}${option.key === node.default ? ' (default)' : ''}`,
      }));
    case 'branch':
      return [
        ...node.when.map((condition) => ({ to: condition.next, label: `if ${condition.if}` })),
        { to: node.else, label: 'otherwise' },
      ];
    case 'end':
      return [];
  }
}

function readsOf(node: ScenarioNode): string[] {
  if (node.type !== 'branch') return [];
  const names = new Set<string>();
  for (const condition of node.when) {
    try {
      for (const name of referencedVars(parseExpr(condition.if))) names.add(name);
    } catch {
      // A malformed condition is already a load-time error; nothing to add here.
    }
  }
  return [...names].sort();
}

export function analyzeScenario(scenario: Scenario): ScenarioAnalysis {
  const byId = new Map(scenario.nodes.map((node) => [node.id, node]));

  // Reachability, same walk the graph checker does, repeated here so the editor
  // can grey out orphans rather than only warning about them.
  const reachable = new Set<string>();
  const queue = [scenario.start];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = byId.get(id);
    if (node) queue.push(...exitsOf(node));
  }

  const enteredFrom = new Map<string, string[]>();
  for (const node of scenario.nodes) {
    for (const target of exitsOf(node)) {
      const list = enteredFrom.get(target) ?? [];
      if (!list.includes(node.id)) list.push(node.id);
      enteredFrom.set(target, list);
    }
  }

  const nodes: NodeAnalysis[] = scenario.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    scene: node.scene,
    preview: previewOf(node),
    reads: readsOf(node),
    writes:
      node.type === 'poll'
        ? Object.entries(node.set ?? {}).map(([name, value]) => ({ name, value }))
        : [],
    exits: exitsWithLabels(node),
    enteredFrom: enteredFrom.get(node.id) ?? [],
    reachable: reachable.has(node.id),
    seconds: Math.round(secondsOf(node, scenario)),
  }));

  const variables = new Map<string, VariableAnalysis>();
  const variable = (name: string): VariableAnalysis => {
    let entry = variables.get(name);
    if (!entry) {
      entry = { name, writtenBy: [], readBy: [] };
      variables.set(name, entry);
    }
    return entry;
  };
  for (const node of nodes) {
    for (const write of node.writes) variable(write.name).writtenBy.push(node.id);
    for (const name of node.reads) variable(name).readBy.push(node.id);
  }

  const endings = scenario.nodes.filter((n) => n.type === 'end').map((n) => n.id);

  return {
    id: scenario.id,
    title: scenario.title,
    start: scenario.start,
    nodes,
    variables: [...variables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    endings,
    counts: {
      nodes: scenario.nodes.length,
      polls: scenario.nodes.filter((n) => n.type === 'poll').length,
      endings: endings.length,
      unreachable: nodes.filter((n) => !n.reachable).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export type SimStep =
  | {
      kind: 'dialogue';
      nodeId: string;
      lineIndex: number;
      speaker?: string;
      text: string;
      seconds: number;
    }
  | { kind: 'pause'; nodeId: string; text?: string; seconds: number }
  | {
      kind: 'poll';
      nodeId: string;
      question: string;
      options: { key: string; label: string }[];
      chosen: string;
      chosenLabel: string;
      /** True when no choice was supplied and the node's `default` decided it. */
      usedDefault: boolean;
      /** Variables this poll wrote, which is how later branches see the vote. */
      sets: Record<string, string>;
      seconds: number;
    }
  | { kind: 'end'; nodeId: string; text?: string };

export type SimResult = {
  steps: SimStep[];
  /** Node ids entered, branches included, in order. */
  path: string[];
  /** Variables once the run finished. */
  vars: Record<string, Value>;
  /** Total estimated runtime, poll windows included. */
  seconds: number;
  endedAt?: string;
  /** Set when the walk hit its ceiling instead of reaching an end node. */
  truncated: boolean;
  /** An engine failure — a branch cycle, say — reported rather than thrown. */
  error?: string;
};

/** Enough for any sane scenario; a cycle would otherwise run forever. */
const MAX_STEPS = 5000;

/**
 * Walks the whole story with a fixed set of poll outcomes.
 *
 * `choices` maps a poll node id to the option key that wins it. A poll left out
 * is resolved with zero votes, which exercises the `default` path — the one
 * that is hardest to test live and most embarrassing to get wrong.
 */
export function simulate(scenario: Scenario, choices: Record<string, string> = {}): SimResult {
  const steps: SimStep[] = [];
  let seconds = 0;
  let state: RunState = initialState(scenario);

  try {
    state = reduce(scenario, state, { type: 'start' });

    for (let step = 0; step < MAX_STEPS; step++) {
      const beat = beatOf(scenario, state);

      if (beat.kind === 'idle') break;

      if (beat.kind === 'end') {
        steps.push({ kind: 'end', nodeId: beat.nodeId, text: beat.text });
        return {
          steps,
          path: state.history,
          vars: state.vars,
          seconds: Math.round(seconds),
          endedAt: beat.nodeId,
          truncated: false,
        };
      }

      if (beat.kind === 'dialogue') {
        const who = beat.line.who;
        seconds += beat.durationMs / 1000;
        steps.push({
          kind: 'dialogue',
          nodeId: beat.nodeId,
          lineIndex: beat.lineIndex,
          speaker: who ? scenario.characters[who]?.name ?? who : undefined,
          text: beat.line.text,
          seconds: beat.durationMs / 1000,
        });
        state = reduce(scenario, state, { type: 'advance' });
        continue;
      }

      if (beat.kind === 'pause') {
        seconds += beat.durationMs / 1000;
        steps.push({
          kind: 'pause',
          nodeId: beat.nodeId,
          text: beat.text,
          seconds: beat.durationMs / 1000,
        });
        state = reduce(scenario, state, { type: 'advance' });
        continue;
      }

      if (beat.kind === 'result') {
        // The reveal after a vote. Not a step of its own — the poll step
        // already says which option won — but the room really does spend this
        // time looking at it, so it belongs in the runtime. Added to the poll
        // that produced it so the per-step seconds still sum to the total.
        const reveal = beat.durationMs / 1000;
        seconds += reveal;
        const last = steps[steps.length - 1];
        if (last?.kind === 'poll') last.seconds += reveal;
        state = reduce(scenario, state, { type: 'advance' });
        continue;
      }
      // A poll. Resolve it through the real vote logic rather than picking the
      // option directly, so the default and the `set:` block behave exactly as
      // they will on the night.
      const node = scenario.nodes.find((n) => n.id === beat.nodeId) as PollNode;
      const wanted = choices[node.id];
      const valid = wanted !== undefined && node.options.some((o) => o.key === wanted);
      const result = resolvePoll(node, valid ? { [wanted]: 1 } : {});

      seconds += node.duration;
      steps.push({
        kind: 'poll',
        nodeId: node.id,
        question: node.question,
        options: node.options.map((o) => ({ key: o.key, label: o.label })),
        chosen: result.winner,
        chosenLabel: result.winnerLabel,
        usedDefault: result.usedDefault,
        sets: variablesFrom(node, result),
        seconds: node.duration,
      });

      state = reduce(scenario, state, { type: 'pollClosed', result });
    }
  } catch (error) {
    return {
      steps,
      path: [],
      vars: {},
      seconds: Math.round(seconds),
      truncated: false,
      error: error instanceof EngineError ? error.message : String(error),
    };
  }

  return {
    steps,
    path: state.history,
    vars: state.vars,
    seconds: Math.round(seconds),
    truncated: true,
  };
}
