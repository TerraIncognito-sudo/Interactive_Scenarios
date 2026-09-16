/**
 * The show, and the clock that drives it.
 *
 * The Room owns the authoritative story state; the two windows on the far end
 * of the loopback socket are renderers that receive snapshots and send
 * intents. It ran on a public server until this rebuild, and what it lost in
 * moving here is the whole of what that server was for — a room code, two
 * tokens, a database, a registry of other rooms, and an audience it could not
 * trust. What is left is the part that was always the show.
 *
 * The clock stays in Node rather than moving into the projector page, and that
 * is a decision rather than an inheritance. Chrome clamps timers in background
 * and occluded tabs to a second or more and can suspend them outright, and the
 * stage window will routinely be on a second display while the operator works
 * in front of it — so a beat held for 4.2 seconds would last whatever the
 * compositor felt like. The display's own local scheduling survives as what it
 * always should have been: a fallback for a socket that has gone, reconciled
 * against the next snapshot to arrive.
 */

import {
  beatOf,
  initialState,
  openPoll,
  reduce,
  sceneMediaOf,
  type Beat,
  type RunState,
} from '../../../shared/engine/engine.ts';
import { BallotBox, resolvePoll, type Counts, type PollResult } from '../../../shared/engine/votes.ts';
import type { LoadedScenario } from '../../../shared/scenario/load.ts';
import type {
  DisplayLoading,
  PollRecord,
  ShowCommand,
  Snapshot,
  SnapshotBeat,
} from '../../../shared/show/protocol.ts';
import type { PollNode } from '../../../shared/scenario/schema.ts';
import { MAX_SIMULATED_VOTERS } from '../../../shared/show/protocol.ts';
import { VoteLog } from './votes.ts';

type RoomPhase = Snapshot['phase'];

/**
 * A connected surface, kept narrow so Room stays transport-agnostic.
 *
 * Two roles, and there is no third. A phone is not on this socket and cannot
 * be: it talks to the relay, the relay talks to the link, and the link casts
 * into this Room from inside this process. That is what let `playerState` and
 * every `role === 'player'` branch leave — a Room that could still build a
 * phone's view would be a Room that could still send one down a socket bound
 * to loopback, to nobody.
 */
export type Subscriber = {
  role: 'board' | 'display';
  send(message: unknown): void;
};

export class Room {
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
   * its join links follow the request that reached it.
   */
  joinUrl: string | undefined;
  readonly loaded: LoadedScenario;

  state: RunState;
  displayReady = false;
  /**
   * What the display last said about its prefetch.
   *
   * Kept so the board can show a number moving rather than a static
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
  /**
   * Whether the projector window may make a sound.
   *
   * Reported by the display rather than assumed, because only that window
   * knows — autoplay is refused per document, and the answer changes the
   * moment somebody touches it. Reset when the last display goes, since the
   * next window to open is a window nobody has clicked.
   */
  audioUnlocked = false;
  closed = false;

  private box: BallotBox | undefined;
  /**
   * The counts the relay is carrying, while one is.
   *
   * A second place a tally can come from, which needs an argument. The
   * ballots for a live show are in the relay's database and nowhere else —
   * that is what lets forty phones keep voting through a client that has
   * dropped, and forty phones are the part you cannot ask to do it again. So
   * the box is deliberately empty while linked, and this mirrors what the
   * relay says.
   *
   * A *state* rather than a stream of events, and that is the whole reason
   * the wire carries a tally instead of individual votes: one dropped frame
   * in a stream of deltas leaves a bar chart permanently wrong with nothing
   * anywhere saying so, where a lost tally is corrected by the next one.
   */
  private relayTally: { nodeId: string; counts: Counts; voters: number } | undefined;
  /**
   * How many phones the relay has, while there is a relay.
   *
   * Not a subscriber count, because no phone is ever on this Room's socket:
   * they are on the relay, several hops away. Undefined means nobody has told
   * us, which is the unlinked case and correctly reads as zero.
   */
  private relayPlayers: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Wall-clock deadline for the current beat. */
  private beatDeadline = 0;
  /** Milliseconds left when the show was paused. */
  private pausedRemaining = 0;
  private readonly subscribers = new Set<Subscriber>();
  /**
   * The simulated ballots, which outlive the box that holds them.
   *
   * Owned rather than injected: there was an interface here while the same
   * Room ran against SQLite on a public server, and with that gone a seam
   * implying two implementations would imply a choice nobody has.
   */
  private readonly votes = new VoteLog();
  /**
   * Every poll this show has decided, oldest first.
   *
   * On the Room rather than accumulated by whoever is watching, and that is
   * the same rule the tally follows. A board that built this out of the
   * snapshots it happened to see would have a different history depending on
   * when its window was opened, and the one opened halfway through a show is
   * exactly the one somebody opens to find out what has happened so far.
   */
  private readonly decided: PollRecord[] = [];

  constructor(options: { loaded: LoadedScenario }) {
    this.joinCode = undefined;
    this.joinUrl = undefined;
    this.loaded = options.loaded;
    this.state = initialState(options.loaded.scenario);
  }

  /**
   * Builds the ballot box for a poll node and replays anything already cast
   * into it, so opening a poll and stepping back into one take the same path.
   *
   * The replay is what makes Back work: leaving a poll drops the box, and a
   * rehearsal that lost its split every time somebody stepped backwards would
   * be a rehearsal nobody could repeat.
   */
  private rehydrateBox(nodeId: string): void {
    const node = this.loaded.scenario.nodes.find((n) => n.id === nodeId);
    if (node?.type !== 'poll') return;

    this.box = new BallotBox(node.options.map((o) => o.key));
    for (const row of this.votes.votesFor(node.id)) {
      this.box.cast(row.deviceId, row.optionKey, row.at);
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

  /**
   * How many phones are in the room, which only the relay can know.
   *
   * Zero unless something has said otherwise, and that is the honest answer
   * rather than a placeholder: an unlinked show has no audience, and nothing
   * on this socket is ever a phone.
   */
  get playerCount(): number {
    return this.relayPlayers ?? 0;
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
    sub.send(this.snapshot());
    // Presence changed, so the board should hear about it too.
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
        // And the gesture went with the window. The next projector to open is
        // one nobody has touched, so claiming its audio is unlocked would let
        // a show start into silence on exactly the reconnect that caused it.
        this.audioUnlocked = false;
      }
      this.broadcast();
    }
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
      tally: this.tally(),
      // Omitted while empty rather than sent as `[]`, so a show that has not
      // reached a vote yet costs nothing on a wire that carries this on every
      // beat.
      ...(this.decided.length > 0 ? { polls: this.decided } : {}),
      lastResult: this.state.lastPoll
        ? { nodeId: this.state.lastPoll.nodeId, ...this.state.lastPoll.result }
        : undefined,
      serverNow: Date.now(),
      presence: { displays: this.displayCount, players: this.playerCount },
      displayReady: this.displayReady,
      audioUnlocked: this.audioUnlocked,
      ...(this.displayLoading ? { displayLoading: this.displayLoading } : {}),
      ...(this.displayMissing ? { displayMissing: this.displayMissing } : {}),
    };
  }

  private broadcast(): void {
    const snapshot = this.snapshot();
    for (const sub of this.subscribers) sub.send(snapshot);
  }

  /**
   * Sends a snapshot because only the tally moved.
   *
   * It used to be the cheap one — it skipped the phones, and a room of forty
   * would otherwise have been forty `playerState` messages to show a number
   * none of them display. There are no phones on this socket any more, so it
   * is now the same fan-out as `broadcast` and kept only for what its name
   * says at the call sites: this transition did not move the beat.
   */
  private broadcastTally(): void {
    this.broadcast();
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
   * other room on the server mid-show. There is one room per process now, so
   * what it kills is the show rather than everyone's — which is still a show
   * sitting still in front of people. It stalls instead, and the board can
   * rescue it with Skip or a Force.
   */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.onError?.(error, this.state.nodeId);
      for (const sub of this.subscribers) {
        if (sub.role === 'board') {
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

  /** Set by the session so a stall reaches the terminal as well as the board. */
  onError: ((error: unknown, nodeId: string) => void) | undefined;

  private onBeatElapsed(): void {
    this.apply({ type: 'advance' });
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** Applies an engine event, opens polls, reschedules and broadcasts. */
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

    // The relay's counts belong to the poll that was open when they arrived.
    // Carried into the next node they would be last question's answers under
    // this question's labels, which is a bar chart that is wrong and looks
    // right — so they go the moment the poll they describe is not the one on
    // screen. The link republishes on entering a poll, so a fresh set follows.
    if (this.relayTally && this.relayTally.nodeId !== next.nodeId) {
      this.relayTally = undefined;
    }

    this.state = next;
    this.schedule();
    this.broadcast();
  }

  start(): void {
    if (this.state.phase !== 'idle') return;
    this.apply({ type: 'start' });
  }

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------

  /**
   * Puts one ballot in the box, without telling anybody.
   *
   * Split from `castVote` so a batch can be one broadcast rather than one per
   * voter: a simulated room of forty would otherwise rebuild and send forty
   * snapshots, each of which resolves a beat and a scene, to show a tally that
   * was only ever going to be looked at once.
   */
  private recordVote(deviceId: string, optionKey: string): boolean {
    if (this.state.phase !== 'polling' || !this.box) return false;
    const now = Date.now();
    if (!this.box.cast(deviceId, optionKey, now)) return false;

    this.votes.record(this.state.nodeId, deviceId, optionKey, now);
    return true;
  }

  /** The other half of `recordVote`, for a simulated voter being taken away. */
  private withdrawVote(deviceId: string): boolean {
    if (this.state.phase !== 'polling' || !this.box) return false;
    if (!this.box.withdraw(deviceId)) return false;
    this.votes.forget(this.state.nodeId, deviceId);
    return true;
  }

  /** Returns false if voting is not open or the option is not on this poll. */
  castVote(deviceId: string, optionKey: string): boolean {
    if (!this.recordVote(deviceId, optionKey)) return false;
    this.broadcastTally();
    return true;
  }

  /**
   * The one answer to "how did the room vote".
   *
   * Two sources, never both: while a relay is carrying the ballots the box is
   * empty by design, and while it is not there is no relay to ask. Written as
   * one method rather than two reads so the screen and the resolution cannot
   * come from different places — a bar chart that disagrees with the branch
   * the show then takes is the worst failure this system has available.
   */
  private tally(): { counts: Counts; voters: number } | undefined {
    if (this.relayTally) {
      return { counts: this.relayTally.counts, voters: this.relayTally.voters };
    }
    return this.box ? { counts: this.box.counts(), voters: this.box.voterCount } : undefined;
  }

  // -------------------------------------------------------------------------
  // The relay
  //
  // Everything below is set from outside by `client/app/show/link.ts` and by
  // nothing else. None of it is a command: the relay reports a code, a count
  // of phones and a count of votes, and the Room decides what any of that
  // means. That is the one-way design stated in `shared/relay/protocol.ts`,
  // and this is the end of the wire it has to hold at.
  // -------------------------------------------------------------------------

  /**
   * Publishes — or withdraws — the code an audience joins at.
   *
   * A method rather than two assignable fields because setting them has to
   * broadcast: the code's whole job is to be on the lobby screen, and a code
   * the Room knew but had not told anybody is a room nobody can be invited to.
   * Passing `undefined` is unlinking, and it must take the URL with it — a
   * projector still showing a dead code is a room of people typing it in.
   */
  setJoin(code: string | undefined, url?: string): void {
    this.joinCode = code;
    this.joinUrl = code === undefined ? undefined : url;
    if (code === undefined) {
      this.relayPlayers = undefined;
      this.relayTally = undefined;
    }
    this.broadcast();
  }

  /**
   * Takes the relay's counts for a poll.
   *
   * Ignored unless it is about the poll that is actually open. A tally can
   * overtake the show — the operator presses Skip while a vote is in flight —
   * and applying a stale one would put the previous question's answers under
   * this question's labels.
   */
  receiveTally(nodeId: string, counts: Counts, voters: number): void {
    if (this.state.phase !== 'polling' || this.state.nodeId !== nodeId) return;
    const node = this.scenario.nodes.find((n) => n.id === nodeId);
    if (node?.type !== 'poll') return;

    // Zeroes for the options nobody picked, seeded here rather than trusted
    // from the wire, so a tally and a set of recovered ballots reduce to the
    // same shape. An option missing from a bar chart is an option the room
    // reads as not having been offered.
    const seeded: Counts = {};
    for (const option of node.options) seeded[option.key] = counts[option.key] ?? 0;
    this.relayTally = { nodeId, counts: seeded, voters };
    this.broadcastTally();
  }

  /** How many phones the relay is holding. Presence, and nothing more. */
  setRelayPlayers(players: number): void {
    if (this.relayPlayers === players) return;
    this.relayPlayers = players;
    this.broadcast();
  }

  closePoll(result?: PollResult): void {
    if (this.state.phase !== 'polling') return;
    const node = this.scenario.nodes.find((n) => n.id === this.state.nodeId);
    if (node?.type !== 'poll') return;

    // The same answer the board has been showing. Reading the box directly
    // here would resolve a live poll on an empty one, so every real vote in
    // the room would land on the `default:` while the bar chart said otherwise.
    const counts = this.tally()?.counts ?? {};
    const decided = result ?? resolvePoll(node, counts);
    this.remember(node, decided, result !== undefined);
    this.apply({ type: 'pollClosed', result: decided });
  }

  /**
   * Files a decided poll, replacing any earlier decision on the same node.
   *
   * Replacing rather than appending, because stepping back into a poll and
   * running it again is what rehearsing one *is* — three attempts at the
   * harbour vote is the operator finding a split they like, not three things
   * the room decided. What the record holds is the decision that stands.
   *
   * The counts come from the tally rather than from the result: they are what
   * the board was showing, and when a decision was forced they are the only
   * place the room's actual answer survives.
   */
  private remember(node: PollNode, result: PollResult, forced: boolean): void {
    const tally = this.tally();
    const counts: Counts = {};
    for (const option of node.options) counts[option.key] = tally?.counts[option.key] ?? 0;

    const record: PollRecord = {
      nodeId: node.id,
      question: node.question,
      options: node.options.map((option) => ({ key: option.key, label: option.label })),
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      voters: tally?.voters ?? 0,
      winner: result.winner,
      winnerLabel: result.winnerLabel,
      usedDefault: result.usedDefault,
      usedTiebreak: result.usedTiebreak,
      forced,
      ...(this.joinCode !== undefined ? { room: this.joinCode } : {}),
      at: Date.now(),
    };

    const previous = this.decided.findIndex((entry) => entry.nodeId === node.id);
    if (previous >= 0) this.decided.splice(previous, 1);
    this.decided.push(record);
  }

  /** The polls this show has decided, oldest first. */
  get polls(): readonly PollRecord[] {
    return this.decided;
  }

  // -------------------------------------------------------------------------
  // Host commands
  // -------------------------------------------------------------------------

  handleCommand(command: ShowCommand): void {
    switch (command.name) {
      case 'start':
        this.start();
        return;

      case 'pause': {
        if (this.state.phase !== 'playing') return;
        this.pausedRemaining = Math.max(0, this.beatDeadline - Date.now());
        this.clearTimer();
        this.state = reduce(this.scenario, this.state, { type: 'pause' });
        this.broadcast();
        return;
      }

      case 'resume': {
        if (this.state.phase !== 'paused') return;
        this.state = reduce(this.scenario, this.state, { type: 'resume' });
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

      case 'castVotes': {
        // Refused whenever there is a join code, which is precisely "a relay
        // is carrying real votes for this room". The condition is not a second
        // flag that could disagree with the first: a room with a code has
        // phones able to reach it, and a rehearsal control that could add to
        // their tally is a rigged vote waiting for the one evening somebody
        // forgets which mode they are in.
        if (this.joinCode !== undefined) return;
        if (this.state.phase !== 'polling' || !this.box) return;

        // `sim:1`, `sim:2`, … rather than a fresh id each time. `BallotBox`
        // dedupes by device, so casting twice moves simulated voter 1 rather
        // than adding a second one — which is what makes the buttons behave
        // like a room changing its mind instead of a counter going up.
        // Each option owns its own voters, so the counts are independent and
        // the numbers typed into the console are the numbers that come back.
        // The whole range is swept rather than the difference from last time,
        // because that needs no remembered state to be right — and state about
        // a rehearsal is state that can disagree with the tally it describes.
        let changed = false;
        for (let i = 1; i <= MAX_SIMULATED_VOTERS; i++) {
          const device = `sim:${command.optionKey}:${i}`;
          const moved =
            i <= command.count
              ? this.recordVote(device, command.optionKey)
              : this.withdrawVote(device);
          changed = moved || changed;
        }
        if (changed) this.broadcastTally();
        return;
      }

      case 'reset': {
        this.clearTimer();
        this.box = undefined;
        // The record goes with the show it describes. Reset puts the story
        // back to the beginning in front of everyone, so what is left of the
        // last run is a list of answers to questions nobody has been asked
        // yet — and the first poll of the new run would arrive under a heading
        // saying it had already been decided.
        this.decided.length = 0;
        this.state = initialState(this.scenario);
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
    this.broadcast();
  }

  /**
   * Notes how far the display has got.
   *
   * Ignored once ready, because a late report arriving after the last one
   * would put the board back to loading for a projector that is finished.
   */
  noteDisplayProgress(progress: DisplayLoading): void {
    if (this.displayReady) return;
    this.displayLoading = progress;
    this.broadcast();
  }

  /**
   * Notes that the projector window has had the gesture autoplay wants.
   *
   * Both directions, because the answer can go back to false: the window is
   * reloaded, or replaced by a different one. Broadcast only on a change,
   * since the display re-announces this on every reconnect and a snapshot per
   * repeat is a repaint of the board for no news.
   */
  setAudioUnlocked(unlocked: boolean): void {
    if (this.audioUnlocked === unlocked) return;
    this.audioUnlocked = unlocked;
    this.broadcast();
  }

  /** Ends the session for good. The room will not come back after a restart. */
  close(): void {
    this.closed = true;
    this.clearTimer();
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
