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
  sceneMediaOf,
  type Beat,
  type RunState,
} from '../shared/engine/engine.ts';
import { BallotBox, resolvePoll, type PollResult } from '../shared/engine/votes.ts';
import type { LoadedScenario } from '../shared/scenario/load.ts';
import type {
  DisplayLoading,
  HostCommand,
  Snapshot,
  SnapshotBeat,
  PlayerState,
} from '../shared/show/protocol.ts';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/show/protocol.ts';
/**
 * What a Room needs from storage, and nothing else.
 *
 * Named as an interface rather than taken as the SQLite `Store` because the
 * same Room now runs in two places with two different reasons to persist. On
 * the public server the answer is a file, because a container restart must not
 * end a live show. In the operator's own process the show *is* the process —
 * it dies with the window that opened it — so a database would be a file left
 * behind on somebody's disk recording which way a rehearsal branched.
 *
 * Deliberately six methods wide. Anything Room could reach for beyond this is
 * something one of the two stores would have to answer dishonestly.
 */
export type RoomStore = {
  saveState(code: string, stateJson: string, now: number): void;
  appendEvent(room: string, kind: string, payload: unknown, at: number): void;
  recordVote(vote: {
    room: string;
    node_id: string;
    device_id: string;
    option_key: string;
    at: number;
  }): void;
  recordPollResult(
    room: string,
    nodeId: string,
    winner: string,
    counts: Record<string, number>,
    total: number,
    usedDefault: boolean,
    at: number,
  ): void;
  /** Votes already cast for a poll, so reopening after a restart is lossless. */
  votesFor(room: string, nodeId: string): { device_id: string; option_key: string; at: number }[];
  closeRoom(code: string, now: number): void;
};

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
  /**
   * This room's own key — for the store, the registry and the log.
   *
   * Not the same thing as the code a phone types, and the two have come apart
   * now that a show can run with no phones at all. See `joinCode`.
   */
  readonly code: string;
  /**
   * The code the audience joins at, while there is one.
   *
   * Undefined is the ordinary state for a show running on the operator's own
   * machine: there is no relay behind it, so there is nothing for anybody to
   * join, and the lobby says so. Inventing a code to fill the gap would put
   * six characters on a projector that no phone in the room can use.
   */
  joinCode: string | undefined;
  /**
   * The address that code is reachable at, when somebody has told us.
   *
   * Set by the link once a relay has opened a room, because only the relay
   * knows what a phone has to type: it is the thing facing the audience, and
   * its join links follow the request that reached it. Left unset by the
   * public server, whose own display is being served from that same address
   * and can build the URL itself.
   */
  joinUrl: string | undefined;
  readonly hostToken: string;
  readonly displayToken: string;
  readonly loaded: LoadedScenario;
  readonly createdAt: number;

  state: RunState;
  displayReady = false;
  /**
   * What the display last said about its prefetch.
   *
   * Kept so the host console can show a number moving rather than a static
   * "loading…", which for the minute or two a show's artwork takes to reach a
   * projector is the difference between waiting and assuming it has hung.
   */
  displayLoading: DisplayLoading | undefined;
  /**
   * What the display said it could not fetch when it reported ready.
   *
   * Kept past readiness, unlike the progress, because it is the one fact that
   * is still true afterwards — and it is the operator's only warning that a
   * shot is going to open black.
   */
  displayMissing: { failed: number; total: number } | undefined;
  lastActivityAt: number;
  closed = false;

  private box: BallotBox | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Wall-clock deadline for the current beat. */
  private beatDeadline = 0;
  /** Milliseconds left when the show was paused. */
  private pausedRemaining = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly store: RoomStore;

  constructor(options: {
    code: string;
    /** Omitted by a local show; the public server passes its own room code. */
    joinCode?: string;
    hostToken: string;
    displayToken: string;
    loaded: LoadedScenario;
    store: RoomStore;
    now: number;
    state?: RunState;
  }) {
    this.code = options.code;
    this.joinCode = options.joinCode;
    this.joinUrl = undefined;
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
      if (sub.role === 'display' && this.displayCount === 0) {
        this.displayReady = false;
        // Whatever it had reached went with it. Leaving the last number up
        // would show a console counting up for a projector that is gone.
        this.displayLoading = undefined;
        this.displayMissing = undefined;
      }
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
          voice: beat.line.voice,
          sfx: beat.line.sfx,
        };
      }
      case 'result':
        // The label is already on the result — `resolvePoll` put it there, and
        // looking the option up again would be a second chance to disagree.
        return {
          kind: 'result',
          nodeId: beat.nodeId,
          pollId: beat.pollId,
          scene: beat.scene,
          durationMs: beat.durationMs,
          ...beat.result,
        };
      case 'pause':
      case 'gate':
      case 'poll':
      case 'end':
      case 'idle':
        return beat;
    }
  }

  snapshot(): Snapshot {
    const beat = beatOf(this.scenario, this.state);
    // Resolved rather than read straight off the scene: the node playing right
    // now may carry its own still and clip.
    const scene = sceneMediaOf(this.scenario, this.state);

    return {
      type: 'snapshot',
      // The join code rather than the room key, and absent when there is none.
      // A surface that showed the key would be showing the operator something
      // no phone can be told.
      ...(this.joinCode !== undefined ? { room: this.joinCode } : {}),
      ...(this.joinUrl !== undefined ? { joinUrl: this.joinUrl } : {}),
      phase: this.phase,
      beat: this.state.beat,
      scenario: {
        id: this.scenario.id,
        title: this.scenario.title,
        description: this.scenario.description,
      },
      beatInfo: this.describeBeat(beat),
      scene,
      tally: this.box
        ? { counts: this.box.counts(), voters: this.box.voterCount }
        : undefined,
      lastResult: this.state.lastPoll
        ? { nodeId: this.state.lastPoll.nodeId, ...this.state.lastPoll.result }
        : undefined,
      serverNow: Date.now(),
      presence: { displays: this.displayCount, players: this.playerCount },
      displayReady: this.displayReady,
      ...(this.displayLoading ? { displayLoading: this.displayLoading } : {}),
      ...(this.displayMissing ? { displayMissing: this.displayMissing } : {}),
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
      this.timer = setTimeout(
        () => this.guard(() => this.closePoll()),
        Math.max(0, endsAt - now),
      );
      return;
    }

    // Infinity rather than a stale number on every path that sets no timer.
    // `pause` reads this to work out how much of the beat was left, so a
    // deadline left over from the previous beat is not merely wrong but
    // dangerous: pausing on a gate and resuming would hand `setTimeout` the
    // remainder of some earlier line and release the gate on its own, which is
    // the one thing a gate exists to make impossible.
    if (this.state.phase !== 'playing' && this.state.phase !== 'revealing') {
      this.beatDeadline = Infinity;
      return;
    }

    const beat = beatOf(this.scenario, this.state);
    // The reveal is here rather than special-cased above because it is an
    // ordinary timed beat: it ends, and the story goes on. Leaving it out is
    // what made the next line's hold run behind the bar chart.
    if (beat.kind !== 'dialogue' && beat.kind !== 'pause' && beat.kind !== 'result') {
      this.beatDeadline = Infinity;
      return;
    }

    this.beatDeadline = now + beat.durationMs;
    this.timer = setTimeout(() => this.guard(() => this.onBeatElapsed()), beat.durationMs);
  }

  /**
   * Runs a clock callback without letting it take the process down.
   *
   * An exception thrown inside setTimeout is uncaught, and an uncaught
   * exception exits Node — so one malformed scenario node could kill every
   * other room on the server mid-show. The room stalls instead, which the host
   * can rescue with skip or an override.
   */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.onError?.(error, this.code, this.state.nodeId);
      for (const sub of this.subscribers) {
        if (sub.role === 'host') {
          sub.send({
            type: 'error',
            code: 'internal',
            message: `The show stalled at "${this.state.nodeId}": ${(error as Error).message}`,
            fatal: false,
          });
        }
      }
    }
  }

  /** Set by the server so stalls reach the log rather than vanishing. */
  onError: ((error: unknown, room: string, nodeId: string) => void) | undefined;

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
    // Keyed on entering the polling phase rather than on the node changing.
    // A vote that leads to another poll now passes through the reveal on that
    // same node — so the node id is already correct by the time the poll opens,
    // and the old test would have left its clock at zero forever.
    if (next.phase === 'polling' && (before.phase !== 'polling' || next.nodeId !== before.nodeId)) {
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
    if (this.state.phase !== 'idle' && this.state.phase !== 'paused' && this.state.phase !== 'finished') {
      this.schedule();
    }
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
        if (!Number.isFinite(remaining)) {
          // Nothing was counting when the pause came in — a gate, most often.
          // Hand it back to schedule() rather than inventing a deadline:
          // setTimeout(Infinity) does not wait forever, it fires on the next
          // tick, which would release a gate the moment anyone un-paused.
          this.schedule();
          this.broadcast();
          return;
        }
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

      case 'continue': {
        // Only ever releases a gate. Guarded rather than aliased to `skip`
        // because a stale console — one whose operator clicked as the beat
        // changed under them — would otherwise cut a line off, and the whole
        // point of a gate is that nothing moves until somebody means it to.
        if (beatOf(this.scenario, this.state).kind !== 'gate') return;
        this.apply({ type: 'advance' });
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

  markDisplayReady(missing?: { failed: number; total: number }): void {
    // The count is taken even on a repeat, since a display that reconnects
    // re-announces and the number is the freshest thing it knows.
    this.displayMissing = missing && missing.failed > 0 ? missing : undefined;
    if (this.displayReady) {
      this.broadcast();
      return;
    }
    this.displayReady = true;
    // Ready and a progress bar at once is two answers to one question.
    this.displayLoading = undefined;
    this.touch();
    this.broadcast();
  }

  /**
   * Notes how far the display has got.
   *
   * Deliberately not a `touch()`: a room whose projector is still downloading
   * is not a room somebody is using, and letting a progress report hold a
   * session open would keep an abandoned one alive for as long as its assets
   * take. Ignored once ready, because a late report arriving after the last
   * one would put the console back to loading.
   */
  noteDisplayProgress(progress: DisplayLoading): void {
    if (this.displayReady) return;
    this.displayLoading = progress;
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
