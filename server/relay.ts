/**
 * A room of phones.
 *
 * This is the whole of what the relay understands: a code, the phones holding
 * it, at most one question, and the ballots. There is no beat, no clock and no
 * state machine — the deadline it hands out is the client's own number, passed
 * through untouched, and nothing here fires when it passes.
 *
 * **It decides nothing.** Closing a poll stops the voting and says so; who won
 * depends on the poll's `default:`, its tie-break mode and `resolvePoll`, all
 * of which live in the client. What travels back from here is counts. That is
 * not modesty about scope: it is what lets a compromised relay be an
 * embarrassment rather than somebody else's show being driven from the
 * internet.
 *
 * Transport-agnostic, like the show `Room` it replaces: a subscriber is
 * anything with a `send`, so the tests drive real rooms without a socket.
 */

import type {
  PlayerState,
  RecordedVote,
  RelayToClient,
  RelayToPhone,
} from '../shared/relay/protocol.ts';
import type { Store } from './db.ts';

/** The operator's process. At most one at a time — see `attachClient`. */
export type ClientSink = {
  send(message: RelayToClient): void;
  /** Dropped when a newer client takes the room over. */
  evict(reason: string): void;
};

export type PlayerSink = {
  deviceId: string;
  send(message: RelayToPhone): void;
};

export type OpenPoll = {
  nodeId: string;
  question: string;
  prompt?: string;
  options: { key: string; label: string }[];
  endsAt: number;
  /** Voting is over but the ballots are still here, for a resuming client. */
  closed: boolean;
};

export type RelayRoomOptions = {
  code: string;
  token: string;
  title?: string;
  keyId: string | null;
  store: Store;
  now: number;
  poll?: OpenPoll;
  votes?: RecordedVote[];
};

export class RelayRoom {
  readonly code: string;
  readonly token: string;
  readonly title: string | undefined;
  readonly keyId: string | null;
  readonly createdAt: number;
  lastActivityAt: number;
  closed = false;

  private readonly store: Store;
  private readonly players = new Set<PlayerSink>();
  private client: ClientSink | undefined;
  private poll: OpenPoll | undefined;
  /** deviceId -> what they chose. The tally is derived, never accumulated. */
  private readonly ballots = new Map<string, { optionKey: string; at: number }>();

  constructor(options: RelayRoomOptions) {
    this.code = options.code;
    this.token = options.token;
    this.title = options.title;
    this.keyId = options.keyId;
    this.store = options.store;
    this.createdAt = options.now;
    this.lastActivityAt = options.now;
    this.poll = options.poll;
    for (const vote of options.votes ?? []) {
      this.ballots.set(vote.deviceId, { optionKey: vote.optionKey, at: vote.at });
    }
  }

  get playerCount(): number {
    return this.players.size;
  }

  get hasClient(): boolean {
    return this.client !== undefined;
  }

  /** The poll as a resuming client needs it back, ballots and all. */
  openPoll(): (OpenPoll & { votes: RecordedVote[] }) | undefined {
    if (!this.poll) return undefined;
    return { ...this.poll, votes: this.recordedVotes() };
  }

  private recordedVotes(): RecordedVote[] {
    return [...this.ballots].map(([deviceId, ballot]) => ({
      deviceId,
      optionKey: ballot.optionKey,
      at: ballot.at,
    }));
  }

  private touch(now = Date.now()): void {
    this.lastActivityAt = now;
    this.store.touchRoom(this.code, now);
  }

  // ------------------------------------------------------------- subscribers

  /**
   * Hands the room to a client, dropping whoever held it.
   *
   * Taking over rather than refusing, because the overwhelmingly common reason
   * for a second client is the first one's socket having died without the
   * relay noticing yet — a laptop lid closed, a network that changed. Refusing
   * would lock an operator out of their own room for as long as the heartbeat
   * takes to reap a connection that is already gone, which is precisely the
   * moment they are standing in front of people trying to get back in.
   */
  attachClient(sink: ClientSink): void {
    const previous = this.client;
    this.client = sink;
    previous?.evict('Another client took over this room.');
    this.touch();
  }

  detachClient(sink: ClientSink): void {
    if (this.client === sink) this.client = undefined;
  }

  addPlayer(sink: PlayerSink): void {
    this.players.add(sink);
    sink.send(this.playerStateFor(sink.deviceId));
    this.touch();
    this.broadcastPresence();
  }

  removePlayer(sink: PlayerSink): void {
    if (!this.players.delete(sink)) return;
    this.broadcastPresence();
  }

  // -------------------------------------------------------------------- polls

  publishPoll(poll: OpenPoll): void {
    const now = Date.now();
    this.poll = poll;
    // A different question means different ballots. The old ones stay in the
    // database under their own node id, because a client that resumes onto the
    // previous poll must still find them.
    this.ballots.clear();
    this.store.savePoll({
      room: this.code,
      node_id: poll.nodeId,
      question: poll.question,
      prompt: poll.prompt ?? null,
      options_json: JSON.stringify(poll.options),
      ends_at: poll.endsAt,
      closed: 0,
      at: now,
    });
    this.store.setCurrentPoll(this.code, poll.nodeId, now);
    this.lastActivityAt = now;
    this.broadcastPlayers();
  }

  extendPoll(nodeId: string, endsAt: number): void {
    if (!this.poll || this.poll.nodeId !== nodeId) return;
    this.poll = { ...this.poll, endsAt };
    this.store.extendPoll(this.code, nodeId, endsAt);
    this.touch();
    this.broadcastPlayers();
  }

  /**
   * Voting is over.
   *
   * The poll stays, because the client is about to resolve it and may lose its
   * link while doing so. What phones see is identical to no poll at all — a
   * voter who chose something is shown their own choice, which is the
   * `playerState` with no poll in it that the page already knows how to draw.
   */
  closePoll(nodeId: string): void {
    if (!this.poll || this.poll.nodeId !== nodeId || this.poll.closed) return;
    this.poll = { ...this.poll, closed: true };
    this.store.markPollClosed(this.code, nodeId);
    this.touch();
    this.broadcastPlayers();
  }

  /** The show has moved on. Nothing to vote in, and nothing left to resume to. */
  clear(): void {
    if (!this.poll) return;
    this.poll = undefined;
    this.ballots.clear();
    this.store.setCurrentPoll(this.code, null, Date.now());
    this.touch();
    this.broadcastPlayers();
  }

  // -------------------------------------------------------------------- votes

  /** False when there is nothing open to vote in, or the option is not on it. */
  vote(deviceId: string, optionKey: string): boolean {
    const poll = this.poll;
    if (!poll || poll.closed) return false;
    if (!poll.options.some((option) => option.key === optionKey)) return false;

    const at = Date.now();
    const existing = this.ballots.get(deviceId);
    this.ballots.set(deviceId, { optionKey, at });
    this.store.recordVote({
      room: this.code,
      node_id: poll.nodeId,
      device_id: deviceId,
      option_key: optionKey,
      at,
    });
    this.lastActivityAt = at;

    // A voter confirming the choice they already made is not news for the
    // board, and forty phones re-tapping the same button during a countdown is
    // exactly when the tally should not be re-sent forty times.
    if (existing?.optionKey !== optionKey) this.broadcastTally();
    return true;
  }

  /** Every option, including the ones nobody picked — a bar chart needs zeroes. */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const option of this.poll?.options ?? []) counts[option.key] = 0;
    for (const ballot of this.ballots.values()) {
      if (ballot.optionKey in counts) counts[ballot.optionKey]! += 1;
    }
    return counts;
  }

  // --------------------------------------------------------------- broadcasts

  playerStateFor(deviceId: string): PlayerState {
    const poll = this.poll;
    const choice = this.ballots.get(deviceId)?.optionKey;
    // A closed poll is shown as no poll: the page draws the voter their own
    // choice from what it remembers, and a question that can no longer be
    // answered but still counts down is a button people keep pressing.
    if (!poll || poll.closed) {
      return {
        type: 'playerState',
        ...(choice !== undefined ? { choice } : {}),
        serverNow: Date.now(),
      };
    }
    return {
      type: 'playerState',
      poll: {
        nodeId: poll.nodeId,
        question: poll.question,
        ...(poll.prompt !== undefined ? { prompt: poll.prompt } : {}),
        options: poll.options,
        endsAt: poll.endsAt,
      },
      ...(choice !== undefined ? { choice } : {}),
      serverNow: Date.now(),
    };
  }

  private broadcastPlayers(): void {
    for (const player of this.players) player.send(this.playerStateFor(player.deviceId));
  }

  broadcastTally(): void {
    const poll = this.poll;
    if (!poll) return;
    this.client?.send({
      type: 'tally',
      nodeId: poll.nodeId,
      counts: this.counts(),
      voters: this.ballots.size,
      serverNow: Date.now(),
    });
  }

  private broadcastPresence(): void {
    this.client?.send({ type: 'presence', players: this.players.size, serverNow: Date.now() });
  }

  /**
   * Ends the room for good.
   *
   * The counterpart of the show server's `close()` versus `shutdown()`, one
   * layer down and for the same reason: this one really is over, so it is
   * marked closed and must not come back on the next restart. A process
   * stopping releases its rooms without touching that flag — see
   * `RelayRegistry.shutdownAll`.
   */
  close(reason = 'This room has closed.'): void {
    if (this.closed) return;
    this.closed = true;
    this.store.closeRoom(this.code, Date.now());
    for (const player of this.players) {
      player.send({ type: 'error', code: 'roomClosed', message: reason, fatal: true });
    }
    this.client?.send({ type: 'error', code: 'roomClosed', message: reason, fatal: true });
    this.players.clear();
    this.client = undefined;
  }

  /** Releases the room because the process is stopping. The room is not over. */
  shutdown(): void {
    this.players.clear();
    this.client = undefined;
  }
}
