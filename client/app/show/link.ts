/**
 * The wire out to the relay, and the only thing in this process that knows a
 * relay exists.
 *
 * A show runs perfectly well without one. Going live is an *addition* to a
 * show that is already on the projector — the operator presses Play, drags the
 * stage window across, rehearses with simulated votes, and only then asks for
 * a code. So nothing here may take a show down: every failure in this file
 * resolves to a message on the board and a show still running behind it.
 *
 * The connection is outbound, which is the whole reason the split is shaped
 * this way: the machine running the show sits behind a domestic router with
 * nothing forwarded, and the relay is the thing with a hostname. Phones reach
 * the relay; the relay never reaches back.
 *
 * **Nothing the relay says is a command.** It reports a code, a count of
 * phones and a count of votes. Which node those votes belong to, whether the
 * poll is still open, what the winner is and where the story goes next are all
 * decided in `Room`, several files from here, out of a scenario the relay has
 * never seen. If that stops being true, the relay becomes a box on the
 * internet that can drive somebody's presentation.
 */

import { WebSocket } from 'ws';
import {
  PublishPollSchema,
  RELAY_PROTOCOL,
  parseRelayMessage,
  type RelayToClient,
} from '../../../shared/relay/protocol.ts';
import type { Room, Subscriber } from '../../../server/room.ts';
import type { Snapshot } from '../../../shared/show/protocol.ts';
import { relayConfig, setRelay } from '../workspace.ts';
import { currentShow } from './session.ts';

export type LinkStatus = 'off' | 'connecting' | 'live' | 'retrying' | 'failed';

/** What the board shows, and the whole of what anything outside here reads. */
export type LinkView = {
  status: LinkStatus;
  relayUrl?: string;
  room?: string;
  joinUrl?: string;
  players?: number;
  /** Why it is retrying, or why it gave up. Absent while healthy. */
  message?: string;
  /**
   * The relay refused the key. Distinct from every other failure because it
   * is the only one with a cure the operator can act on, and because it is
   * what a revoked key feels like from this end — so the board puts the box
   * back on screen rather than retrying a phrase all evening.
   */
  needsKey?: boolean;
  /**
   * A key is already saved on this machine, so the board offers Go Live rather
   * than a box. The phrase itself deliberately never reaches the page: nothing
   * there needs it, and a secret that is only in a file is a secret that is
   * only in a file.
   */
  hasKey?: boolean;
  since?: number;
};

/** 1s, 2s, 4s, 8s, then every 15. Never gives up while a show is running. */
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const MAX_BACKOFF_MS = 15_000;

class ShowLink {
  private readonly room: Room;
  private readonly relayUrl: string;
  private readonly key: string;
  private readonly title: string | undefined;

  private socket: WebSocket | undefined;
  private subscriber: Subscriber | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;

  /** Set once a room exists. Its presence is what makes a reconnect a resume. */
  private code: string | undefined;
  private token: string | undefined;
  private joinUrl: string | undefined;
  private players = 0;

  private status: LinkStatus = 'off';
  private message: string | undefined;
  private needsKey = false;
  private since = Date.now();
  /** Set while `stop()` is unwinding, so the socket's own close is not a drop. */
  private stopping = false;
  /**
   * Set when the relay has told us our room is gone and a new one is wanted.
   *
   * Without it the reconnect would look exactly like a first attempt that
   * could not reach the relay — which is a failure, not a retry.
   */
  private reopening = false;
  /** Resolves `start()`'s promise exactly once, whichever way the first try goes. */
  private settle: ((view: LinkView) => void) | undefined;

  /** What the relay currently believes is on the phones. See `onSnapshot`. */
  private published: { nodeId: string; endsAt: number; closed: boolean } | undefined;

  constructor(options: { room: Room; relayUrl: string; key: string; title?: string }) {
    this.room = options.room;
    this.relayUrl = options.relayUrl;
    this.key = options.key;
    this.title = options.title;
  }

  view(): LinkView {
    return {
      status: this.status,
      relayUrl: this.relayUrl,
      ...(this.code !== undefined ? { room: this.code } : {}),
      ...(this.joinUrl !== undefined ? { joinUrl: this.joinUrl } : {}),
      ...(this.status === 'live' || this.status === 'retrying' ? { players: this.players } : {}),
      ...(this.message !== undefined ? { message: this.message } : {}),
      ...(this.needsKey ? { needsKey: true } : {}),
      since: this.since,
    };
  }

  // -------------------------------------------------------------------------
  // Connecting
  // -------------------------------------------------------------------------

  /**
   * Opens the room, and resolves when the first attempt has settled.
   *
   * Awaited rather than fire-and-forget because Go Live is a button somebody
   * presses and then looks at: a mistyped key has to come back as a mistyped
   * key while they are still standing there, not as a status pill that changes
   * its mind eight seconds later.
   */
  start(): Promise<LinkView> {
    return new Promise<LinkView>((resolve) => {
      this.settle = resolve;
      this.connect();
    });
  }

  private finish(): void {
    const settle = this.settle;
    this.settle = undefined;
    settle?.(this.view());
  }

  private setStatus(status: LinkStatus, message?: string): void {
    this.status = status;
    this.message = message;
    this.since = Date.now();
  }

  private connect(): void {
    this.setStatus(this.code === undefined ? 'connecting' : 'retrying', this.message);
    const url = `${this.relayUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.socket = socket;

    socket.on('open', () => {
      // Guarded on identity, not on state: a socket the operating system only
      // got round to failing after a newer one was already live would
      // otherwise send its handshake into a room this link had moved on from.
      if (this.socket !== socket) return socket.close();
      if (this.code !== undefined && this.token !== undefined) {
        // **Never `openRoom` here.** The room is still open on the relay with
        // the audience on it; opening another would mint a new code while
        // forty people hold the old one, and it would look fine from the
        // operator's chair.
        this.send({
          type: 'resumeRoom',
          protocol: RELAY_PROTOCOL,
          room: this.code,
          token: this.token,
        });
      } else {
        this.send({
          type: 'openRoom',
          protocol: RELAY_PROTOCOL,
          key: this.key,
          ...(this.title !== undefined ? { title: this.title } : {}),
        });
      }
    });

    socket.on('message', (raw) => {
      if (this.socket !== socket) return;
      const message = parseRelayMessage(raw.toString());
      if (!message) {
        // Validated at this end on purpose: the two halves deploy separately
        // and will be different versions of themselves sooner or later, and a
        // tally that half-parses is a bar chart that lies in front of a room.
        return;
      }
      this.receive(message);
    });

    const dropped = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.stopping || this.status === 'failed') return this.finish();

      // The first attempt does not retry, and that is a rule rather than an
      // omission. Retrying exists to protect a room full of people from a
      // dropped wifi connection; there is no room yet, and a link that kept
      // quietly trying would turn a typo in the relay address into a status
      // pill somebody watches for four minutes.
      if (this.code === undefined && !this.reopening) {
        this.setStatus('failed', `Could not reach the relay at ${this.relayUrl}.`);
        return this.finish();
      }

      this.scheduleRetry();
      this.finish();
    };
    socket.on('close', dropped);
    socket.on('error', dropped);
  }

  private scheduleRetry(): void {
    if (this.retry !== undefined) return;
    const wait = BACKOFF_MS[this.attempt] ?? MAX_BACKOFF_MS;
    this.attempt++;
    this.setStatus(
      'retrying',
      this.code === undefined
        ? 'Could not reach the relay. Trying again.'
        : `Lost the relay. The room is still open and still taking votes — trying again.`,
    );
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, wait);
    this.retry.unref?.();
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  // -------------------------------------------------------------------------
  // What the relay says
  // -------------------------------------------------------------------------

  private receive(message: RelayToClient): void {
    switch (message.type) {
      case 'roomOpened':
      case 'roomResumed': {
        this.attempt = 0;
        this.reopening = false;
        this.code = message.room;
        this.token = message.token;
        this.joinUrl = message.joinUrl;
        this.players = message.players;
        this.setStatus('live');
        this.needsKey = false;
        this.room.setJoin(message.room, message.joinUrl);
        this.room.setRelayPlayers(message.players);
        // Whatever the phones are showing is whatever was there before the
        // socket dropped, which may be a question the show has moved past.
        // Re-derived from the Room rather than remembered, because the Room is
        // the only thing that knows what is on screen right now.
        this.published = message.type === 'roomResumed' && message.open
          ? { nodeId: message.open.nodeId, endsAt: message.open.endsAt, closed: message.open.closed }
          : undefined;

        if (message.type === 'roomResumed' && message.open) {
          // The ballots cast while nothing was listening, which is the entire
          // reason the relay has a database. Reduced to counts here rather
          // than replayed one by one: the relay deduped them by device when it
          // took them, and counting them a second time at this end would be
          // two implementations of one fact with nothing to notice when they
          // stopped agreeing. Sent even when it changes nothing, because the
          // picture on the board has been stale for as long as the link was
          // away and nobody looking at it could tell.
          const counts: Record<string, number> = {};
          const voters = new Set<string>();
          for (const vote of message.open.votes) {
            counts[vote.optionKey] = (counts[vote.optionKey] ?? 0) + 1;
            voters.add(vote.deviceId);
          }
          this.room.receiveTally(message.open.nodeId, counts, voters.size);
        }

        if (!this.subscriber) this.watch();
        else this.onSnapshot(this.room.snapshot());
        this.finish();
        return;
      }

      case 'tally':
        // Counts, never a winner — and the Room is what checks they belong to
        // the poll that is actually open.
        this.room.receiveTally(message.nodeId, message.counts, message.voters);
        return;

      case 'presence':
        this.players = message.players;
        this.room.setRelayPlayers(message.players);
        return;

      case 'error':
        this.onError(message.code, message.message, message.fatal);
        return;

      case 'pong':
        return;
    }
  }

  private onError(code: string, message: string, fatal: boolean): void {
    if (code === 'badKey') {
      // No retry, ever. A key the relay does not know now is a key it will not
      // know in eight seconds, and a link that kept trying would bury the one
      // message the operator can do something about under a reconnect counter.
      this.needsKey = true;
      this.setStatus('failed', message);
      this.stopping = true;
      this.socket?.close();
      return;
    }

    if (code === 'badRoom' || code === 'badToken') {
      // The relay no longer has our room: its data volume went, or the room
      // aged out while the link was away. The old code is dead either way, so
      // a new one is strictly better than none — but the audience is holding
      // the old one, so this has to arrive as news rather than as a recovery
      // nobody mentions.
      const lost = this.code;
      this.code = undefined;
      this.token = undefined;
      this.joinUrl = undefined;
      this.reopening = true;
      this.attempt = 0;
      this.room.setJoin(undefined);
      this.setStatus(
        'retrying',
        `The relay no longer has room ${lost ?? ''}. Opening a new one — the code on the screen is about to change.`,
      );
      this.socket?.close();
      return;
    }

    if (fatal) {
      this.setStatus('failed', message);
      this.stopping = true;
      this.socket?.close();
      return;
    }

    // Non-fatal: the frame was refused, the room is fine. Worth saying,
    // because the one thing it can mean is a poll the phones never got.
    this.message = message;
  }

  // -------------------------------------------------------------------------
  // What the show says
  // -------------------------------------------------------------------------

  /**
   * Watches the Room the way the board does, and publishes what it sees.
   *
   * A subscriber rather than a callback of its own, so there is one mechanism
   * by which anything learns what the show is doing. A second one would be a
   * second thing to keep in step with `apply`, and the one that fell behind
   * would be this — the half nobody is looking at directly.
   */
  private watch(): void {
    const subscriber: Subscriber = {
      role: 'host',
      send: (payload) => {
        const message = payload as { type?: string };
        if (message.type === 'snapshot') this.onSnapshot(payload as Snapshot);
      },
    };
    this.subscriber = subscriber;
    this.room.subscribe(subscriber);
  }

  /**
   * Keeps the phones in step with the beat, from the snapshot alone.
   *
   * Derived rather than driven by hooks inside `Room`, because a poll reaches
   * the projector as a snapshot and the phones have to be showing the same
   * question the wall is. Anything that could put a question on a phone
   * without putting it on the screen would be a way for the two to disagree.
   */
  private onSnapshot(snapshot: Snapshot): void {
    const beat = snapshot.beatInfo;

    if (beat.kind === 'poll') {
      const endsAt = Math.round(beat.endsAt);
      if (this.published?.nodeId === beat.nodeId && !this.published.closed) {
        // Same question, new deadline: the operator added time. Extending
        // rather than republishing keeps a phone's own choice highlighted,
        // which a fresh poll would clear in front of whoever had voted.
        if (this.published.endsAt !== endsAt) {
          this.published = { ...this.published, endsAt };
          this.send({ type: 'extendPoll', nodeId: beat.nodeId, endsAt });
        }
        return;
      }

      const frame = {
        type: 'poll' as const,
        nodeId: beat.nodeId,
        question: beat.question,
        ...(beat.prompt !== undefined ? { prompt: beat.prompt } : {}),
        options: beat.options.map((option) => ({ key: option.key, label: option.label })),
        endsAt,
      };
      // Checked here, against the schema the relay checks it against, because
      // the alternative is an option key three characters too long producing a
      // poll that silently never reaches a single phone. A refusal the relay
      // would answer with `badMessage` becomes a line on the board instead.
      const valid = PublishPollSchema.safeParse(frame);
      if (!valid.success) {
        this.message = `The relay will not carry "${beat.nodeId}": ${valid.error.issues[0]?.message ?? 'bad poll'}`;
        return;
      }
      this.published = { nodeId: beat.nodeId, endsAt, closed: false };
      this.send(frame);
      return;
    }

    if (!this.published) return;

    // The poll is off the wall, and the relay is told in two steps because the
    // two facts are different. Closing says voting is over: the ballots stay,
    // and `closed` is what a client resuming mid-reveal reads to know the
    // question it is looking at has already been answered.
    if (!this.published.closed) {
      this.published = { ...this.published, closed: true };
      this.send({ type: 'closePoll', nodeId: this.published.nodeId });
    }

    // Clearing says the story has moved on, and `RelayRoom.clear` throws the
    // ballots away with the question — so it waits until the result is off the
    // wall. For the whole of the reveal the relay still describes the poll the
    // audience is watching the bar chart for, which is what keeps a resuming
    // link from deciding the phones need a fresh copy of a question they have
    // already answered.
    //
    // What the phones show through the reveal is the relay's own decision and
    // not this file's: a closed poll reaches them as no poll, because a
    // question that can no longer be answered but still counts down is a
    // button people keep pressing.
    if (beat.kind === 'result' && beat.pollId === this.published.nodeId) return;

    this.published = undefined;
    this.send({ type: 'clear' });
  }

  // -------------------------------------------------------------------------
  // Going away
  // -------------------------------------------------------------------------

  /**
   * Drops the socket and lets the reconnect bring it back, room intact.
   *
   * A real control, not a test hook: it is what Reconnect on the board does
   * for a link that has gone quiet without closing. The relay still holds the
   * room, the phones are still on it and still voting, and the cure for a
   * socket that has stopped answering is a new one.
   */
  reconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    if (this.retry !== undefined) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    this.attempt = 0;
    this.connect();
  }

  /**
   * Ends the room for good.
   *
   * `closeRoom` before the socket goes, so the relay stops holding a code
   * nobody is coming back for — a room left open is a code that still answers
   * and a show that is over.
   */
  stop(): void {
    this.stopping = true;
    if (this.retry !== undefined) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    if (this.code !== undefined) this.send({ type: 'closeRoom' });
    this.socket?.close();
    this.socket = undefined;
    if (this.subscriber) {
      this.room.unsubscribe(this.subscriber);
      this.subscriber = undefined;
    }
    this.room.setJoin(undefined);
    this.setStatus('off');
    this.code = undefined;
    this.token = undefined;
    this.joinUrl = undefined;
  }

  /**
   * Lets go because the *process* is stopping.
   *
   * The same distinction `close()` and `shutdown()` draw one layer down, for
   * the same reason: this does not tell the relay the room is over, because it
   * is not — the operator pressed Ctrl-C, and the room is still there to
   * resume if they meant to.
   */
  drop(): void {
    this.stopping = true;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.socket?.terminate();
    this.socket = undefined;
  }
}

// ---------------------------------------------------------------------------
// The one link
// ---------------------------------------------------------------------------

let link: ShowLink | undefined;

export function linkView(): LinkView {
  if (link) return link.view();
  // Unlinked, but not uninformed: the board needs to know whether it is
  // offering a button or a form before anybody presses anything.
  const saved = relayConfig();
  return {
    status: 'off',
    ...(saved ? { relayUrl: saved.url, hasKey: true } : {}),
  };
}

/**
 * Opens a room for the show that is running.
 *
 * With no arguments it uses the relay and key already in the machine config,
 * which is the ordinary case: they are typed once and every later show just
 * links. They live there rather than in `project.yaml` for the same reason the
 * models root does — a project file travels to other machines and is opened a
 * year later, and a key that travelled with it would be a key handed to
 * whoever the folder was sent to.
 */
export async function goLive(options: { relayUrl?: string; key?: string } = {}): Promise<LinkView> {
  const show = currentShow();
  if (!show) {
    throw new Error('No show is running. Press Play first, then go live.');
  }
  if (link) return link.view();

  const saved = relayConfig();
  const relayUrl = (options.relayUrl ?? saved?.url ?? '').trim();
  const key = (options.key ?? saved?.key ?? '').trim();
  if (!relayUrl) throw new Error('No relay address. Enter the address of your relay.');
  if (!key) throw new Error('No relay key. Paste the phrase from the relay console at /keys.');

  link = new ShowLink({ room: show.room, relayUrl, key, title: show.loaded.scenario.title });
  const view = await link.start();

  if (view.status === 'failed') {
    link.stop();
    link = undefined;
    // Deliberately not remembered. The one thing the operator has to fix must
    // not be the one thing the config keeps handing back to them.
    return view;
  }

  await setRelay(relayUrl, key);
  return view;
}

/** Closes the room. The show carries on without one, which is the normal state. */
export async function goOffline(): Promise<LinkView> {
  link?.stop();
  link = undefined;
  return { status: 'off' };
}

/** Drops the socket without ending the room. See `ShowLink.reconnect`. */
export function relinkNow(): LinkView {
  if (!link) return { status: 'off' };
  link.reconnect();
  return link.view();
}

/** The process is stopping. The room stays open on the relay. */
export function dropLink(): void {
  link?.drop();
  link = undefined;
}
