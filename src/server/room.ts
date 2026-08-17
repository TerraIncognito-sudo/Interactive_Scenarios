/**
 * A live session.
 *
 * The Room owns the authoritative story state and the clock that drives it.
 * Clients are renderers: they receive snapshots and send intents. Nothing a
 * client says is trusted beyond the point where it enters this file.
 */

import { randomBytes } from 'node:crypto';
import {
  beatOf,
  initialState,
  openPoll,
  reduce,
  activeScene,
  type Beat,
  type RunState,
} from '../engine/engine.ts';
import { BallotBox, resolvePoll, type PollResult } from '../engine/votes.ts';
import type { LoadedScenario } from '../scenario/load.ts';
import type { HostCommand, Snapshot, SnapshotBeat, PlayerState } from '../shared/protocol.ts';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/protocol.ts';
import type { Store } from './db.ts';

export function generateRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export type RoomPhase = Snapshot['phase'];

/** A connected socket, kept deliberately narrow so Room stays transport-agnostic. */
export type Subscriber = {
  role: 'host' | 'display' | 'player';
  deviceId?: string;
  send(message: unknown): void;
};

export class Room {
  readonly code: string;
  readonly hostToken: string;
  readonly displayToken: string;
  readonly loaded: LoadedScenario;
  readonly createdAt: number;

  state: RunState;
  displayReady = false;
  lastActivityAt: number;
  closed = false;

  private box: BallotBox | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Wall-clock deadline for the current beat. */
  private beatDeadline = 0;
  /** Milliseconds left when the show was paused. */
  private pausedRemaining = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly store: Store;

  constructor(options: {
    code: string;
    hostToken: string;
    displayToken: string;
    loaded: LoadedScenario;
    store: Store;
    now: number;
    state?: RunState;
  }) {
    this.code = options.code;
    this.hostToken = options.hostToken;
    this.displayToken = options.displayToken;
    this.loaded = options.loaded;
    this.store = options.store;
    this.createdAt = options.now;
    this.lastActivityAt = options.now;
    this.state = options.state ?? initialState(options.loaded.scenario);

    // A room restored from disk mid-poll has state but no ballot box. Without
    // this, it would silently refuse every vote and then resolve to the
    // default, discarding votes already recorded before the restart.
    if (this.state.phase === 'polling') this.rehydrateBox(this.state.nodeId);
  }

  /**
   * Builds the ballot box for a poll node and replays any votes already stored,
   * so opening a poll and recovering one take the same path.
   */
  private rehydrateBox(nodeId: string): void {
    const node = this.loaded.scenario.nodes.find((n) => n.id === nodeId);
    if (node?.type !== 'poll') return;

    this.box = new BallotBox(node.options.map((o) => o.key));
    for (const row of this.store.votesFor(this.code, node.id)) {
      this.box.cast(row.device_id, row.option_key, row.at);
    }
  }

  private get scenario() {
    return this.loaded.scenario;
  }

  get phase(): RoomPhase {
    switch (this.state.phase) {
      case 'idle':
        return 'lobby';
      case 'paused':
        return 'paused';
      case 'finished':
        return 'finished';
      default:
        return 'running';
    }
  }

  get playerCount(): number {
    let count = 0;
    for (const sub of this.subscribers) if (sub.role === 'player') count++;
    return count;
  }

  get displayCount(): number {
    let count = 0;
    for (const sub of this.subscribers) if (sub.role === 'display') count++;
    return count;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  subscribe(sub: Subscriber): void {
    this.subscribers.add(sub);
    this.touch();
    // Players get only their own poll. A snapshot carries dialogue, scene and
    // the pending result, so sending one to a phone would leak the story.
    if (sub.role === 'player') {
      sub.send(this.playerState(sub.deviceId));
    } else {
      sub.send(this.snapshot());
    }
    // Presence changed, so everyone else's host console should update too.
    this.broadcast();
  }

  unsubscribe(sub: Subscriber): void {
    if (this.subscribers.delete(sub)) {
      if (sub.role === 'display' && this.displayCount === 0) this.displayReady = false;
      this.broadcast();
    }
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  private describeBeat(beat: Beat): SnapshotBeat {
    switch (beat.kind) {
      case 'dialogue': {
        const character = beat.line.who ? this.scenario.characters[beat.line.who] : undefined;
        return {
          kind: 'dialogue',
          nodeId: beat.nodeId,
          lineIndex: beat.lineIndex,
          who: beat.line.who,
          speaker: character
            ? { name: character.name, color: character.color, sprite: character.sprite }
            : undefined,
          text: beat.line.text,
          scene: beat.scene,
          durationMs: beat.durationMs,
          sfx: beat.line.sfx,
        };
      }
      case 'pause':
      case 'poll':
      case 'end':
      case 'idle':
        return beat;
    }
  }

  snapshot(): Snapshot {
    const beat = beatOf(this.scenario, this.state);
    const sceneId = activeScene(this.scenario, this.state);
    const scene = sceneId ? this.scenario.scenes[sceneId] : undefined;

    return {
      type: 'snapshot',
      room: this.code,
      phase: this.phase,
      beat: this.state.beat,
      scenario: {
        id: this.scenario.id,
        title: this.scenario.title,
        description: this.scenario.description,
      },
      beatInfo: this.describeBeat(beat),
      scene: sceneId
        ? {
            id: sceneId,
            background: scene?.background,
            music: scene?.music,
            ambience: scene?.ambience,
          }
        : undefined,
      tally: this.box
        ? { counts: this.box.counts(), voters: this.box.voterCount }
        : undefined,
      lastResult: this.state.lastPoll
        ? { nodeId: this.state.lastPoll.nodeId, ...this.state.lastPoll.result }
        : undefined,
      serverNow: Date.now(),
      presence: { displays: this.displayCount, players: this.playerCount },
      displayReady: this.displayReady,
    };
  }

  playerState(deviceId: string | undefined): PlayerState {
    const beat = beatOf(this.scenario, this.state);
    if (beat.kind !== 'poll') {
      return { type: 'playerState', serverNow: Date.now() };
    }
    return {
      type: 'playerState',
      poll: {
        nodeId: beat.nodeId,
        question: beat.question,
        prompt: beat.prompt,
        options: beat.options,
        endsAt: beat.endsAt,
      },
      choice: deviceId ? this.box?.choiceOf(deviceId) : undefined,
      serverNow: Date.now(),
    };
  }

  private broadcast(): void {
    const snapshot = this.snapshot();
    for (const sub of this.subscribers) {
      if (sub.role === 'player') {
        sub.send(this.playerState(sub.deviceId));
      } else {
        sub.send(snapshot);
      }
    }
  }

  /** Cheaper broadcast used while votes stream in: only tallies changed. */
  private broadcastTally(): void {
    const snapshot = this.snapshot();
    for (const sub of this.subscribers) {
      if (sub.role !== 'player') sub.send(snapshot);
    }
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Schedules whatever ends the current beat: the next line, or the close of
   * an open poll. Called after every transition.
   */
  private schedule(): void {
    this.clearTimer();
    if (this.closed) return;

    const now = Date.now();

    if (this.state.phase === 'polling') {
      const endsAt = this.state.poll?.endsAt ?? now;
      this.beatDeadline = endsAt;
      this.timer = setTimeout(() => this.closePoll(), Math.max(0, endsAt - now));
      return;
    }

    if (this.state.phase !== 'playing') return;

    const beat = beatOf(this.scenario, this.state);
    if (beat.kind !== 'dialogue' && beat.kind !== 'pause') return;

    this.beatDeadline = now + beat.durationMs;
    this.timer = setTimeout(() => this.onBeatElapsed(), beat.durationMs);
  }

  private onBeatElapsed(): void {
    this.apply({ type: 'advance' });
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** Applies an engine event, persists, opens polls, reschedules, broadcasts. */
  private apply(event: Parameters<typeof reduce>[2]): void {
    const before = this.state;
    let next = reduce(this.scenario, before, event);

    // Entering a poll node stamps its deadline and opens a fresh ballot box.
    if (next.phase === 'polling' && next.nodeId !== before.nodeId) {
      next = openPoll(this.scenario, next, Date.now());
      this.rehydrateBox(next.nodeId);
    } else if (next.phase !== 'polling') {
      this.box = undefined;
    }

    this.state = next;
    this.touch();
    this.persist(event);
    this.schedule();
    this.broadcast();
  }

  private persist(event: { type: string }): void {
    const now = Date.now();
    this.store.saveState(this.code, JSON.stringify(this.state), now);
    this.store.appendEvent(this.code, event.type, { nodeId: this.state.nodeId }, now);
  }

  start(): void {
    if (this.state.phase !== 'idle') return;
    this.apply({ type: 'start' });
  }

  /** Restores the clock after a process restart. */
  resumeClock(): void {
    if (this.state.phase === 'polling' || this.state.phase === 'playing') this.schedule();
  }

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------

  /** Returns false if voting is not open or the option is not on this poll. */
  castVote(deviceId: string, optionKey: string): boolean {
    if (this.state.phase !== 'polling' || !this.box) return false;
    const now = Date.now();
    if (!this.box.cast(deviceId, optionKey, now)) return false;

    this.store.recordVote({
      room: this.code,
      node_id: this.state.nodeId,
      device_id: deviceId,
      option_key: optionKey,
      at: now,
    });
    this.touch();
    this.broadcastTally();
    return true;
  }

  closePoll(result?: PollResult): void {
    if (this.state.phase !== 'polling') return;
    const node = this.scenario.nodes.find((n) => n.id === this.state.nodeId);
    if (node?.type !== 'poll') return;

    const counts = this.box?.counts() ?? {};
    const decided = result ?? resolvePoll(node, counts);

    this.store.recordPollResult(
      this.code,
      node.id,
      decided.winner,
      decided.counts,
      decided.total,
      decided.usedDefault,
      Date.now(),
    );

    this.apply({ type: 'pollClosed', result: decided });
  }

  // -------------------------------------------------------------------------
  // Host commands
  // -------------------------------------------------------------------------

  handleCommand(command: HostCommand): void {
    switch (command.name) {
      case 'start':
        this.start();
        return;

      case 'pause': {
        if (this.state.phase !== 'playing') return;
        this.pausedRemaining = Math.max(0, this.beatDeadline - Date.now());
        this.clearTimer();
        this.state = reduce(this.scenario, this.state, { type: 'pause' });
        this.touch();
        this.persist({ type: 'pause' });
        this.broadcast();
        return;
      }

      case 'resume': {
        if (this.state.phase !== 'paused') return;
        this.state = reduce(this.scenario, this.state, { type: 'resume' });
        this.touch();
        this.persist({ type: 'resume' });
        // Resume the remainder of the interrupted beat rather than restarting it.
        this.clearTimer();
        const remaining = this.pausedRemaining;
        this.beatDeadline = Date.now() + remaining;
        this.timer = setTimeout(() => this.onBeatElapsed(), remaining);
        this.broadcast();
        return;
      }

      case 'back':
        this.apply({ type: 'back' });
        return;

      case 'skip': {
        // Skipping an open poll closes it on the votes cast so far.
        if (this.state.phase === 'polling') this.closePoll();
        else this.apply({ type: 'advance' });
        return;
      }

      case 'closePoll':
        this.closePoll();
        return;

      case 'extendPoll': {
        if (this.state.phase !== 'polling') return;
        this.state = reduce(this.scenario, this.state, {
          type: 'extendPoll',
          seconds: command.seconds,
        });
        this.touch();
        this.persist({ type: 'extendPoll' });
        this.schedule();
        this.broadcast();
        return;
      }

      case 'forceBranch': {
        // The manual override: decide the poll regardless of the tally.
        if (this.state.phase !== 'polling') return;
        const node = this.scenario.nodes.find((n) => n.id === this.state.nodeId);
        if (node?.type !== 'poll') return;
        const option = node.options.find((o) => o.key === command.optionKey);
        if (!option) return;

        const counts = this.box?.counts() ?? {};
        this.closePoll({
          winner: option.key,
          winnerLabel: option.label,
          counts,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          usedDefault: false,
          usedTiebreak: false,
        });
        return;
      }

      case 'jump':
        this.apply({ type: 'jump', nodeId: command.nodeId });
        return;

      case 'reset': {
        this.clearTimer();
        this.box = undefined;
        this.state = initialState(this.scenario);
        this.touch();
        this.persist({ type: 'reset' });
        this.broadcast();
        return;
      }
    }
  }

  markDisplayReady(): void {
    if (this.displayReady) return;
    this.displayReady = true;
    this.touch();
    this.broadcast();
  }

  /** Ends the session for good. The room will not come back after a restart. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.store.closeRoom(this.code, Date.now());
    for (const sub of this.subscribers) {
      sub.send({ type: 'error', code: 'roomClosed', message: 'This room has closed.', fatal: true });
    }
    this.subscribers.clear();
  }

  /**
   * Releases the room because the *process* is stopping, not because the show
   * is over.
   *
   * The distinction matters: marking the room closed here would mean a
   * container restart or a SIGTERM silently destroyed every live session,
   * which is precisely the failure this system is supposed to absorb. Clients
   * reconnect on their own and the room is restored from disk.
   */
  shutdown(): void {
    this.clearTimer();
    this.subscribers.clear();
  }
}
