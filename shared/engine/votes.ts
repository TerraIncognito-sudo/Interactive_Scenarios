/**
 * Vote collection and resolution.
 *
 * Pure and deterministic (randomness is injected), so every tie-break rule and
 * the zero-vote path are unit-testable without a server or a socket.
 */

import type { PollNode } from '../scenario/schema.ts';

export type Ballot = {
  /** Opaque per-device token. Not personal data — only used to dedupe. */
  deviceId: string;
  optionKey: string;
  /** ms since epoch, server clock. */
  at: number;
};

export type Counts = Record<string, number>;

export type PollResult = {
  /** Winning option key. Always a valid key on the node. */
  winner: string;
  winnerLabel: string;
  counts: Counts;
  total: number;
  /** True when nobody voted and the node's `default` was used. */
  usedDefault: boolean;
  /** True when the top count was shared and a tie-break rule decided it. */
  usedTiebreak: boolean;
};

export type Rng = () => number;

/**
 * A live ballot box for one poll. Last vote per device wins, so an audience
 * member can change their mind until voting closes.
 */
export class BallotBox {
  private readonly byDevice = new Map<string, Ballot>();
  readonly optionKeys: ReadonlySet<string>;

  constructor(optionKeys: Iterable<string>) {
    this.optionKeys = new Set(optionKeys);
  }

  /** Returns false if the option key is not valid for this poll. */
  cast(deviceId: string, optionKey: string, at: number): boolean {
    if (!this.optionKeys.has(optionKey)) return false;
    this.byDevice.set(deviceId, { deviceId, optionKey, at });
    return true;
  }

  /**
   * Takes a device's ballot back out.
   *
   * No phone sends this — an audience member changes their mind by voting
   * again, and one who puts their phone away is simply somebody who voted.
   * It exists because a *simulated* room has to be a dial rather than a
   * ratchet: rehearsing a poll means trying a split, watching it resolve, and
   * then trying a different one, and without this the only way down from
   * eight votes is to restart the show.
   */
  withdraw(deviceId: string): boolean {
    return this.byDevice.delete(deviceId);
  }

  /** What a given device currently has selected, for restoring on reconnect. */
  choiceOf(deviceId: string): string | undefined {
    return this.byDevice.get(deviceId)?.optionKey;
  }

  get voterCount(): number {
    return this.byDevice.size;
  }

  ballots(): Ballot[] {
    return [...this.byDevice.values()];
  }

  counts(): Counts {
    const counts: Counts = {};
    for (const key of this.optionKeys) counts[key] = 0;
    for (const ballot of this.byDevice.values()) {
      counts[ballot.optionKey] = (counts[ballot.optionKey] ?? 0) + 1;
    }
    return counts;
  }
}

/**
 * Decides a poll.
 *
 * Tie-break modes:
 *   first    — highest count; ties go to the earliest option in declaration order
 *   random   — highest count; ties broken uniformly among the tied options
 *   weighted — every option is a candidate, chosen with probability proportional
 *              to its share of the vote. A 60/40 split genuinely goes the
 *              minority way 40% of the time. Useful when you want the room to
 *              influence the story without dictating it.
 *
 * With zero votes, every mode falls back to the node's required `default`.
 */
export function resolvePoll(node: PollNode, counts: Counts, rng: Rng = Math.random): PollResult {
  const labelOf = (key: string): string =>
    node.options.find((o) => o.key === key)?.label ?? key;

  const total = node.options.reduce((sum, o) => sum + (counts[o.key] ?? 0), 0);

  if (total === 0) {
    return {
      winner: node.default,
      winnerLabel: labelOf(node.default),
      counts: normalize(node, counts),
      total: 0,
      usedDefault: true,
      usedTiebreak: false,
    };
  }

  if (node.tiebreak === 'weighted') {
    let roll = rng() * total;
    let winner = node.options[0]!.key;
    for (const option of node.options) {
      roll -= counts[option.key] ?? 0;
      if (roll < 0) {
        winner = option.key;
        break;
      }
    }
    const top = Math.max(...node.options.map((o) => counts[o.key] ?? 0));
    const tiedCount = node.options.filter((o) => (counts[o.key] ?? 0) === top).length;
    return {
      winner,
      winnerLabel: labelOf(winner),
      counts: normalize(node, counts),
      total,
      usedDefault: false,
      usedTiebreak: tiedCount > 1,
    };
  }

  const top = Math.max(...node.options.map((o) => counts[o.key] ?? 0));
  const tied = node.options.filter((o) => (counts[o.key] ?? 0) === top);

  const winner =
    tied.length === 1 || node.tiebreak === 'first'
      ? tied[0]!.key
      : tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))]!.key;

  return {
    winner,
    winnerLabel: labelOf(winner),
    counts: normalize(node, counts),
    total,
    usedDefault: false,
    usedTiebreak: tied.length > 1,
  };
}

/** Guarantees every option key is present, so clients can render a stable chart. */
function normalize(node: PollNode, counts: Counts): Counts {
  const out: Counts = {};
  for (const option of node.options) out[option.key] = counts[option.key] ?? 0;
  return out;
}

/** Resolves the `set:` block of a poll node into concrete variable values. */
export function variablesFrom(node: PollNode, result: PollResult): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(node.set ?? {})) {
    switch (value) {
      case '$winner':
        vars[name] = result.winner;
        break;
      case '$winnerLabel':
        vars[name] = result.winnerLabel;
        break;
      case '$total':
        vars[name] = String(result.total);
        break;
      default:
        vars[name] = value;
    }
  }
  return vars;
}
