/**
 * The story state machine.
 *
 * Deliberately pure: state plus an event in, new state out, with no I/O, no
 * timers and no sockets. Timing lives in the server's clock, which reads
 * `beatOf()` to learn how long the current beat should last and then feeds an
 * `advance` event back in. That split is what makes every branch path testable
 * without a browser, and what would let a visual editor drive the same engine.
 */

import { lineDuration, type Line, type Scenario, type ScenarioNode } from '../scenario/schema.ts';
import { testCondition, type Value } from './expr.ts';
import { variablesFrom, type Counts, type PollResult } from './votes.ts';

export type Phase = 'idle' | 'playing' | 'polling' | 'paused' | 'finished';

export type RunState = {
  nodeId: string;
  /** Index within a dialogue node's lines. */
  lineIndex: number;
  /**
   * Monotonically increasing. The display reconciles against this after a
   * dropout: a higher beat from the server always wins over local playback.
   */
  beat: number;
  phase: Phase;
  vars: Record<string, Value>;
  /** Node ids entered, most recent last. Drives `back` and the journal. */
  history: string[];
  /** Set while phase === 'polling'. */
  poll?: {
    nodeId: string;
    /** ms since epoch, server clock. */
    endsAt: number;
  };
  /**
   * The most recently closed poll, for the display's result reveal. Carries its
   * own node id because by the time this exists the show has already moved on
   * to whichever node the vote selected.
   */
  lastPoll?: { nodeId: string; result: PollResult };
};

export type EngineEvent =
  | { type: 'start' }
  /** The current beat's time has elapsed. */
  | { type: 'advance' }
  | { type: 'pollClosed'; result: PollResult }
  /** Host override: jump anywhere. */
  | { type: 'jump'; nodeId: string }
  | { type: 'back' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Host extends an open poll by some seconds. */
  | { type: 'extendPoll'; seconds: number };

/** What the display should render, and how long it lasts. */
export type Beat =
  | { kind: 'idle' }
  | {
      kind: 'dialogue';
      nodeId: string;
      lineIndex: number;
      line: Line;
      scene?: string;
      durationMs: number;
    }
  | { kind: 'pause'; nodeId: string; text?: string; scene?: string; durationMs: number }
  | {
      kind: 'poll';
      nodeId: string;
      question: string;
      prompt?: string;
      options: { key: string; label: string }[];
      scene?: string;
      endsAt: number;
    }
  | { kind: 'end'; nodeId: string; text?: string; scene?: string };

/** Guards against a scenario whose branch nodes point at each other in a cycle. */
const MAX_INSTANT_HOPS = 100;

export class EngineError extends Error {}

function nodeById(scenario: Scenario, id: string): ScenarioNode {
  const node = scenario.nodes.find((n) => n.id === id);
  if (!node) throw new EngineError(`Scenario "${scenario.id}" has no node "${id}"`);
  return node;
}

export function initialState(scenario: Scenario): RunState {
  return {
    nodeId: scenario.start,
    lineIndex: 0,
    beat: 0,
    phase: 'idle',
    vars: {},
    history: [],
  };
}

/**
 * Moves to a node, transparently resolving any `branch` nodes encountered.
 * Branches are instantaneous by design — they are control flow, not content,
 * and must never occupy stage time.
 */
function enterNode(scenario: Scenario, state: RunState, nodeId: string): RunState {
  let targetId = nodeId;
  const history = [...state.history];

  for (let hop = 0; hop < MAX_INSTANT_HOPS; hop++) {
    const node = nodeById(scenario, targetId);
    history.push(node.id);

    if (node.type === 'branch') {
      let next = node.else;
      for (const condition of node.when) {
        if (testCondition(condition.if, state.vars)) {
          next = condition.next;
          break;
        }
      }
      targetId = next;
      continue;
    }

    const base: RunState = {
      ...state,
      nodeId: node.id,
      lineIndex: 0,
      beat: state.beat + 1,
      history,
    };

    switch (node.type) {
      case 'dialogue':
      case 'pause':
        return { ...base, phase: 'playing', poll: undefined };
      case 'poll':
        return {
          ...base,
          phase: 'polling',
          poll: { nodeId: node.id, endsAt: 0 },
        };
      case 'end':
        return { ...base, phase: 'finished', poll: undefined };
    }
  }

  throw new EngineError(
    `Branch nodes formed a cycle starting at "${nodeId}" (over ${MAX_INSTANT_HOPS} hops)`,
  );
}

export function reduce(scenario: Scenario, state: RunState, event: EngineEvent): RunState {
  switch (event.type) {
    case 'start': {
      if (state.phase !== 'idle') return state;
      return enterNode(scenario, { ...state, history: [] }, scenario.start);
    }

    case 'advance': {
      if (state.phase !== 'playing') return state;
      const node = nodeById(scenario, state.nodeId);

      if (node.type === 'dialogue' && state.lineIndex < node.lines.length - 1) {
        return { ...state, lineIndex: state.lineIndex + 1, beat: state.beat + 1 };
      }
      if (node.type === 'dialogue' || node.type === 'pause') {
        return enterNode(scenario, state, node.next);
      }
      return state;
    }

    case 'pollClosed': {
      if (state.phase !== 'polling') return state;
      const node = nodeById(scenario, state.nodeId);
      if (node.type !== 'poll') return state;

      const option = node.options.find((o) => o.key === event.result.winner);
      if (!option) {
        throw new EngineError(
          `Poll "${node.id}" resolved to unknown option "${event.result.winner}"`,
        );
      }

      const withVars: RunState = {
        ...state,
        vars: { ...state.vars, ...variablesFrom(node, event.result) },
        lastPoll: { nodeId: node.id, result: event.result },
        poll: undefined,
      };
      return enterNode(scenario, withVars, option.next);
    }

    case 'jump': {
      // Host override. Allowed from any phase, including a finished show.
      return enterNode(scenario, state, event.nodeId);
    }

    case 'back': {
      // history ends with the current node, so step back two.
      const previous = state.history[state.history.length - 2];
      if (previous === undefined) return state;
      const trimmed = state.history.slice(0, -2);
      return enterNode(scenario, { ...state, history: trimmed }, previous);
    }

    case 'pause': {
      if (state.phase !== 'playing') return state;
      return { ...state, phase: 'paused' };
    }

    case 'resume': {
      if (state.phase !== 'paused') return state;
      return { ...state, phase: 'playing' };
    }

    case 'extendPoll': {
      if (state.phase !== 'polling' || !state.poll) return state;
      return {
        ...state,
        beat: state.beat + 1,
        poll: { ...state.poll, endsAt: state.poll.endsAt + event.seconds * 1000 },
      };
    }
  }
}

/** Stamps the wall-clock deadline on a poll the moment voting opens. */
export function openPoll(scenario: Scenario, state: RunState, now: number): RunState {
  if (state.phase !== 'polling' || !state.poll) return state;
  const node = nodeById(scenario, state.nodeId);
  if (node.type !== 'poll') return state;
  return { ...state, poll: { ...state.poll, endsAt: now + node.duration * 1000 } };
}

/** What to render right now, and for how long. */
export function beatOf(scenario: Scenario, state: RunState): Beat {
  if (state.phase === 'idle') return { kind: 'idle' };

  const node = nodeById(scenario, state.nodeId);

  switch (node.type) {
    case 'dialogue': {
      const line = node.lines[state.lineIndex];
      if (!line) return { kind: 'idle' };
      return {
        kind: 'dialogue',
        nodeId: node.id,
        lineIndex: state.lineIndex,
        line,
        scene: node.scene,
        durationMs: Math.round(lineDuration(line, scenario.settings) * 1000),
      };
    }
    case 'pause':
      return {
        kind: 'pause',
        nodeId: node.id,
        text: node.text,
        scene: node.scene,
        durationMs: Math.round(node.duration * 1000),
      };
    case 'poll':
      return {
        kind: 'poll',
        nodeId: node.id,
        question: node.question,
        prompt: node.prompt,
        options: node.options.map((o) => ({ key: o.key, label: o.label })),
        scene: node.scene,
        endsAt: state.poll?.endsAt ?? 0,
      };
    case 'end':
      return { kind: 'end', nodeId: node.id, text: node.text, scene: node.scene };
    case 'branch':
      // enterNode never comes to rest on a branch node.
      throw new EngineError(`Engine came to rest on branch node "${node.id}"`);
  }
}

/**
 * The scene in effect, which may have been set by an earlier node — scene is
 * sticky until a later node changes it, so authors need not repeat it.
 */
export function activeScene(scenario: Scenario, state: RunState): string | undefined {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const id = state.history[i]!;
    const node = scenario.nodes.find((n) => n.id === id);
    if (node?.scene) return node.scene;
  }
  return undefined;
}

/** Convenience for tests and the journal: an empty tally for the current poll. */
export function emptyCounts(scenario: Scenario, state: RunState): Counts {
  const node = nodeById(scenario, state.nodeId);
  if (node.type !== 'poll') return {};
  const counts: Counts = {};
  for (const option of node.options) counts[option.key] = 0;
  return counts;
}
