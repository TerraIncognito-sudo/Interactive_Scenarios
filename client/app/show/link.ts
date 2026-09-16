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
  normalizeRoomName,
  parseRelayMessage,
  type RelayToClient,
} from '../../../shared/relay/protocol.ts';
import type { Room, Subscriber } from './room.ts';
import type { Snapshot } from '../../../shared/show/protocol.ts';
import { relayConfig, setRelay } from '../workspace.ts';
import { setProjectRoomName } from '../projects.ts';
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
  /**
   * The code this show asks for, rather than letting the relay mint one.
   *
   * Reported even when nothing is linked, because the box on the Go Live form
   * is prefilled from it: a name that is remembered but invisible is a name
   * somebody types a second, different version of.
   */
  name?: string;
  /**
   * A live room already holds the name, and somebody else's key opened it.
   *
   * Its own flag for the same reason `needsKey` is one: it is a failure with a
   * cure the operator can act on in the next ten seconds, so the form goes
   * back on screen rather than a status pill that retries a name all evening.
   */
  needsName?: boolean;
  /**
   * Something true and worth saying about a link that is otherwise fine.
   *
   * Distinct from `message`, which explains a link that is *not* fine and is
   * only ever shown while retrying or failed. A room that opened under a code
   * the operator did not ask for is live, working, and not what they wanted —
   * and with nowhere to say so, the wrong six characters go on the wall.
   */
  note?: string;
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
  /** What was asked for, kept to compare against what came back. */
  private readonly wantedName: string | undefined;

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
  private note: string | undefined;
  private needsKey = false;
  private needsName = false;
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

  constructor(options: {
    room: Room;
    relayUrl: string;
    key: string;
    title?: string;
    name?: string;
  }) {
    this.room = options.room;
    this.relayUrl = options.relayUrl;
    this.key = options.key;
    this.title = options.title;
    this.wantedName = options.name;
  }

  /** Says something about a link that is working. See `LinkView.note`. */
  setNote(text: string | undefined): void {
    this.note = text;
  }

  view(): LinkView {
    return {
      status: this.status,
      relayUrl: this.relayUrl,
      ...(this.code !== undefined ? { room: this.code } : {}),
      ...(this.joinUrl !== undefined ? { joinUrl: this.joinUrl } : {}),
      ...(this.status === 'live' || this.status === 'retrying' ? { players: this.players } : {}),
      ...(this.message !== undefined ? { message: this.message } : {}),
      ...(this.note !== undefined ? { note: this.note } : {}),
      ...(this.needsKey ? { needsKey: true } : {}),
      ...(this.needsName ? { needsName: true } : {}),
      ...(this.wantedName !== undefined ? { name: this.wantedName } : {}),
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

    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    } catch {
      // `new WebSocket` throws *synchronously* for an address that is not an
      // address, which is the one failure in this file that never reached the
      // board. It happened inside `start()`'s promise executor, so it came
      // back as a rejection rather than as a view — and the rejection left
      // `link` assigned to a link that had never connected, which every later
      // attempt then returned instead of trying. The operator saw a blank
      // refusal, fixed their typo, and saw the same blank refusal.
      //
      // Said plainly rather than by echoing the constructor's complaint about
      // permitted protocols: the address is the thing to look at.
      this.socket = undefined;
      this.setStatus('failed', `Not a relay address: ${this.relayUrl}`);
      this.stopping = true;
      return this.finish();
    }
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
          ...(this.wantedName !== undefined ? { name: this.wantedName } : {}),
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
        this.needsName = false;
        // A relay too old to understand a name parses the frame with the field
        // dropped and mints a code as it always did — which is a room that
        // works, under six characters nobody asked for. Said out loud, because
        // the alternative is the operator writing ARCTIC-SENTINEL on a board
        // while the projector shows KPQ4T7.
        this.note =
          this.wantedName !== undefined && message.room !== this.wantedName
            ? `This relay is too old to name a room — it opened ${message.room} instead. ` +
              `Update the relay, or read out the code on screen.`
            : undefined;
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

    if (code === 'nameTaken') {
      // No retry, like a bad key and for the same reason: a name that belongs
      // to somebody else's live room now belongs to it in eight seconds too,
      // and a reconnect counter would bury the one sentence the operator can
      // do something about.
      this.needsName = true;
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
      role: 'board',
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
  // The project's name, not the machine's: the form is about to offer it, and
  // it is remembered per show rather than per computer.
  const name = currentShow()?.roomName;
  return {
    status: 'off',
    ...(saved ? { relayUrl: saved.url, hasKey: true } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/**
 * Supplies the scheme somebody left off.
 *
 * `interact.scurrycat.ca` is what an operator types, because it is what is
 * written on the relay's own console and in the address bar they copied it
 * from. It is not a URL, and without this it reached `new WebSocket` and threw
 * before any of this file's failure handling had a chance to say so.
 *
 * The relay makes exactly this allowance for `PUBLIC_URL`, for exactly this
 * reason — `normalizePublicUrl` in `server/config.ts`, which this mirrors
 * rather than imports, because the two halves deploy separately and neither
 * may reach into the other.
 *
 * https for a hostname and http for something plainly local, which is not
 * timidity about certificates: the offline fallback is the relay brought up on
 * the operator's own laptop for the night the venue's internet is dead, and
 * that one has no certificate and never will.
 */
function withScheme(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/^(https?|wss?):\/\//i.test(value)) return value;

  const local =
    /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(value) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(value);
  return `${local ? 'http' : 'https'}://${value}`;
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
export async function goLive(
  options: { relayUrl?: string; key?: string; name?: string } = {},
): Promise<LinkView> {
  const show = currentShow();
  if (!show) {
    throw new Error('No show is running. Press Play first, then go live.');
  }
  if (link) return link.view();

  const saved = relayConfig();
  const relayUrl = withScheme(options.relayUrl ?? saved?.url ?? '');
  const key = (options.key ?? saved?.key ?? '').trim();
  if (!relayUrl) throw new Error('No relay address. Enter the address of your relay.');
  if (!key) throw new Error('No relay key. Paste the phrase from the relay console at /keys.');

  // A name submitted with the form wins, including an empty one — clearing
  // the box is a decision ("mint me a code this time"), and a blank that fell
  // back to the remembered name would be a box that cannot be emptied.
  // Unsubmitted, the project's own name stands.
  const asked = options.name !== undefined;
  const name = asked ? normalizeRoomName(options.name ?? '') : show.roomName;

  link = new ShowLink({
    room: show.room,
    relayUrl,
    key,
    title: show.loaded.scenario.title,
    ...(name !== undefined ? { name } : {}),
  });
  let view: LinkView;
  try {
    view = await link.start();
  } catch (error) {
    // `start()` is not supposed to reject — every failure it knows about comes
    // back as a view with a message on it. This is here because the one that
    // did cost an evening: a link left assigned after a throw is returned by
    // every later `goLive` in place of trying, so the operator's fix has no
    // way of reaching the relay. Whatever goes wrong, the process must be able
    // to try again.
    link = undefined;
    throw error;
  }

  if (view.status === 'failed') {
    link.stop();
    link = undefined;
    // Deliberately not remembered. The one thing the operator has to fix must
    // not be the one thing the config keeps handing back to them.
    return view;
  }

  await setRelay(relayUrl, key);

  // Written only now, after a relay actually opened a room under it — the same
  // rule the key follows. A name saved on the way *in* would be a name that
  // outlived the attempt that proved it was refused.
  if (asked) {
    try {
      await setProjectRoomName(show.project, name ?? '');
    } catch (error) {
      // A folder with no `project.yaml` has nowhere to keep this. The show is
      // live under the name regardless, so this is a note on a working link
      // rather than a failure — but it is said, because a box that silently
      // forgets what was typed is one somebody fills in again every week.
      link.setNote((error as Error).message);
    }
  }

  return link.view();
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
