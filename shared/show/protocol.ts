/**
 * The wire between the show and the two windows that render it.
 *
 * Both ends are on the operator's own machine: the board they work in and the
 * stage they drag onto the projector. That is why nothing here authenticates
 * anything, and it is a change rather than an omission — this protocol served
 * a public server until the rebuild, and carried a room code, a token per role
 * and a phone's whole view of a poll. All three have gone. The code and the
 * poll moved to `../relay/protocol.ts`, which is the wire that still faces an
 * audience; the tokens proved something nobody is being asked any more.
 *
 * Frames are still Zod-validated, and not as a defence. It is what keeps this
 * socket and the relay's speaking one language, so the stage does not have to
 * know which of the two it is plugged into.
 */

import { z } from 'zod';

/**
 * Two surfaces, and there is no third.
 *
 * `player` left with the phones: a phone talks to the relay, and a `hello`
 * claiming to be one here is a surface that has misunderstood where it is.
 * `host` became `board` because the console stopped being a link handed to
 * somebody with a phone at the back of the room and became a tab in the window
 * the show is authored in — and a role named for a device nobody uses is a
 * role people reason about wrongly.
 */
export const ROLES = ['board', 'display'] as const;
type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Sent once on connect, before anything else is accepted.
 *
 * A role and nothing else. There was a room code here, and a token, and a
 * device id; this process runs one show, opened both windows itself and has no
 * phones, so all three were fields every caller left empty.
 */
const HelloSchema = z.object({
  type: z.literal('hello'),
  role: z.enum(ROLES),
});

/**
 * A phone's frame, on a socket no phone can reach.
 *
 * Kept parseable on purpose. Votes arrive from the relay, through the link,
 * from inside this process — so one appearing here is either a bug or somebody
 * who got to the port, and `client/app/show/ws.ts` refuses it by name. Dropped
 * from the union it would come back as an unrecognised frame, which says
 * nothing about which boundary it crossed.
 */
const CastVoteSchema = z.object({
  type: z.literal('vote'),
  optionKey: z.string().min(1).max(12),
});

/** Display reports that every asset for the scenario has loaded. */
const DisplayReadySchema = z.object({
  type: z.literal('displayReady'),
  /**
   * How many never arrived, and out of how many.
   *
   * A missing decoration must never stop a show, so the display goes ready
   * regardless — but "ready" over eleven assets that 404'd is the same lie as
   * "ready" halfway through the download. This is the operator's one chance to
   * hear about it before the black background is on the wall.
   */
  failed: z.number().int().nonnegative().max(100_000).optional(),
  total: z.number().int().nonnegative().max(100_000).optional(),
});

/**
 * Display reports how far it has got fetching artwork.
 *
 * A show is a few hundred megabytes and a projector on venue wifi takes a
 * minute or two over it. For that minute the host console said "loading…" and
 * nothing else — no number, nothing moving — which is indistinguishable from
 * broken. The only cure is to say what is happening, so the display says it.
 *
 * Bytes are optional because they are only known where the server could stat
 * the file; the count is always real.
 */
const DisplayProgressSchema = z.object({
  type: z.literal('displayProgress'),
  done: z.number().int().nonnegative().max(100_000),
  total: z.number().int().nonnegative().max(100_000),
  /** Assets that errored or ran out of time. The show can still open. */
  failed: z.number().int().nonnegative().max(100_000),
  bytes: z.number().nonnegative().optional(),
  totalBytes: z.number().nonnegative().optional(),
});

/**
 * The projector says whether sound is allowed yet.
 *
 * Its own message rather than a field on `displayReady`, because the two are
 * about unrelated things that happen at unrelated times: readiness is the
 * download finishing, and this is a person having touched the window. Folding
 * one into the other would mean re-announcing a completed download in order to
 * report a click.
 *
 * This exists because merging the two programs created a failure that could
 * not happen before. Autoplay needs a gesture in the *window that plays the
 * sound*, and Start used to be pressed on a host console — a different device
 * — so the projector's own audio gate covered it. Start is now a button in the
 * board window, the stage may never have been clicked, and the first voice
 * line is silent with nothing anywhere saying why.
 */
const DisplayAudioSchema = z.object({
  type: z.literal('displayAudio'),
  unlocked: z.boolean(),
});

/**
 * The most simulated voters one option can hold.
 *
 * A full room is forty phones; anything past a couple of hundred is a stress
 * test of the tally rather than a rehearsal of the show, and this command's
 * job is the show. It is a shared constant because the Room sweeps the whole
 * range on every press to take withdrawn voters back out — so a cap the two
 * ends disagreed about would leave simulated ballots nobody could clear.
 */
export const MAX_SIMULATED_VOTERS = 200;

/**
 * What either window may ask the show to do.
 *
 * Named for the show rather than for a surface. It was `HostCommand` while
 * there was a host console, and the stage has been sending these since it grew
 * a keyboard — so the old name described one of its two senders and implied
 * the other was doing something irregular.
 */
export const ShowCommandSchema = z.object({
  type: z.literal('command'),
  command: z.discriminatedUnion('name', [
    z.object({ name: z.literal('start') }),
    z.object({ name: z.literal('pause') }),
    z.object({ name: z.literal('resume') }),
    z.object({ name: z.literal('back') }),
    z.object({ name: z.literal('skip') }),
    /**
     * Releases a gate. Separate from `skip` even though the engine event is
     * the same one, because the two mean opposite things to the person
     * pressing them: `skip` cuts a beat short, and this is the beat arriving
     * on time. A moderator who has to press "Skip" to begin their own
     * presentation has been handed the wrong button.
     */
    z.object({ name: z.literal('continue') }),
    z.object({ name: z.literal('closePoll') }),
    z.object({ name: z.literal('extendPoll'), seconds: z.number().int().min(5).max(600) }),
    z.object({ name: z.literal('forceBranch'), optionKey: z.string().min(1).max(12) }),
    z.object({ name: z.literal('jump'), nodeId: z.string().min(1).max(64) }),
    z.object({ name: z.literal('reset') }),
    /**
     * Votes nobody cast, for rehearsing a poll at a desk.
     *
     * The difference between this and `forceBranch` is the whole reason both
     * exist. Force hands `closePoll` a decided result, so it never runs
     * `resolvePoll` and never draws a truthful bar chart — it is the override
     * for the night a vote goes wrong. This puts ballots in the box and lets
     * the poll close on its own clock, which is the only one of the two that
     * proves a poll's `default:`, its tie-break and the reveal beat work
     * before an audience is the thing testing them.
     *
     * **`count` is a target, not an increment**: it says how many simulated
     * voters have chosen this option, and pressing it again with a smaller
     * number takes some away. Zero is allowed and means nobody — which is how
     * a rehearsal gets back to an empty poll to watch its `default:` fire.
     *
     * The alternative was one pool of simulated voters shared across the
     * options, so that re-casting moved a voter rather than adding one. That
     * dedupes for free, and it is wrong at the only moment anybody uses this:
     * asking for five Left and two Right hands back three and two, because the
     * two Rights were taken out of the five Lefts. A control whose total is
     * less than the numbers typed into it is a control people stop trusting.
     * So each option owns its own voters and the counts are independent.
     *
     * Refused outright while a relay is linked. Otherwise the rehearsal
     * control stuffs a live ballot, and that will happen exactly once: in
     * front of a room, five minutes after somebody goes live having simulated
     * all afternoon.
     */
    z.object({
      name: z.literal('castVotes'),
      optionKey: z.string().min(1).max(12),
      count: z.number().int().min(0).max(MAX_SIMULATED_VOTERS),
    }),
  ]),
});

const PingSchema = z.object({ type: z.literal('ping') });

const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  CastVoteSchema,
  DisplayReadySchema,
  DisplayProgressSchema,
  DisplayAudioSchema,
  ShowCommandSchema,
  PingSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ShowCommand = z.infer<typeof ShowCommandSchema>['command'];

/**
 * The commands a display may send on its own authority.
 *
 * The projector is a control surface as well as a renderer, because the person
 * standing in front of the room may have no console to reach: one laptop, one
 * screen, the show already on it. Its keyboard is the whole of that surface,
 * so this list is exactly the keys it has and nothing else.
 *
 * What is deliberately absent is what a stray keystroke must never be able to
 * do in front of an audience. `reset` puts the show back to the beginning, and
 * on the board it sits behind a confirm dialog that a key press has no
 * equivalent of. `jump` needs a node id, which the projector has no way to
 * offer and no way to check. Both stay on the board, where there is a pointer
 * and a chance to read the question.
 *
 * This list stopped being a security boundary when both surfaces became
 * windows on one machine, and `isDisplayCommand` went with it — a predicate
 * nothing called, kept alive by the test that called it. What holds the
 * decision up now is `tests/control.test.ts`, which reads every command
 * literal out of the stage and checks it against this array.
 */
export const DISPLAY_COMMANDS = [
  'start',
  'pause',
  'resume',
  'back',
  'skip',
  'continue',
  'forceBranch',
] as const;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * Server messages are typed but not parsed at runtime by clients — the server
 * is the trusted end of this connection, and re-validating its own output on
 * every frame would cost more than it proves.
 */

type PublicScenario = {
  id: string;
  title: string;
  description?: string;
};

export type SnapshotBeat =
  | { kind: 'idle' }
  | {
      kind: 'dialogue';
      nodeId: string;
      lineIndex: number;
      who?: string;
      speaker?: { name: string; color: string; sprite?: string };
      text: string;
      scene?: string;
      durationMs: number;
      voice?: string;
      sfx?: string;
    }
  | { kind: 'pause'; nodeId: string; text?: string; scene?: string; sfx?: string; durationMs: number }
  /**
   * No `durationMs`, because nothing is counting. The board keys its
   * continue button off this kind, so the absence is what the moderator sees.
   */
  | { kind: 'gate'; nodeId: string; text?: string; label?: string; scene?: string; sfx?: string }
  | {
      kind: 'poll';
      nodeId: string;
      question: string;
      prompt?: string;
      options: { key: string; label: string }[];
      scene?: string;
      /** ms since epoch on the server clock; clients correct with `serverNow`. */
      endsAt: number;
    }
  | {
      /**
       * A poll's result, held on screen before the story continues.
       *
       * A beat with a duration rather than a client-side animation, because
       * the server is the clock: while this was a `setTimeout` in the display,
       * the next line's hold was already running behind the bar chart.
       */
      kind: 'result';
      nodeId: string;
      pollId: string;
      winner: string;
      winnerLabel: string;
      counts: Record<string, number>;
      total: number;
      usedDefault: boolean;
      usedTiebreak: boolean;
      scene?: string;
      durationMs: number;
    }
  | { kind: 'end'; nodeId: string; text?: string; scene?: string };

/**
 * One poll, after it was decided.
 *
 * The show's own record of how the room voted. Nothing in the system kept
 * this: `lastPoll` holds the most recent result because a branch may read it,
 * and the moment the next question opens the previous one is gone — so an
 * operator asked afterwards how the vote went had the projector's memory and
 * their own, and a show with six polls in it produced no account of any of
 * them.
 *
 * `counts` is what the board was showing when it closed, not what the decision
 * was made from. Those differ exactly when somebody overrode a vote, and that
 * is the case the record exists for: *the room said 31 to 9 and we went the
 * other way* is the sentence, and a record that quietly showed the forced
 * result as the tally could not say it.
 */
export type PollRecord = {
  nodeId: string;
  question: string;
  options: { key: string; label: string }[];
  /** Every option, zeros included, so a chart drawn from this is stable. */
  counts: Record<string, number>;
  total: number;
  /** Distinct devices, which is not the total once anybody changed their mind. */
  voters: number;
  winner: string;
  winnerLabel: string;
  usedDefault: boolean;
  usedTiebreak: boolean;
  /** The operator decided it, whatever the counts said. */
  forced: boolean;
  /**
   * The room code this was taken in, when there was one.
   *
   * Its absence is what makes a record honest about a rehearsal: simulated
   * ballots and forty phones are not the same evidence, and a file that did
   * not distinguish them would be a file nobody could cite.
   */
  room?: string;
  at: number;
};

/**
 * The complete renderable state. Sent on connect and on every transition, so
 * a client that reloads mid-show resyncs from one message.
 */
export type Snapshot = {
  type: 'snapshot';
  /**
   * The code phones join at, once there is one.
   *
   * Absent is the ordinary state now, not a failure: a show runs start to
   * finish on the operator's machine with no relay behind it, and the lobby
   * has to say so deliberately rather than showing a blank where a code goes.
   */
  room?: string;
  /**
   * The full address a phone opens, when there is one.
   *
   * Sent rather than assembled by the projector, because the projector is on
   * the operator's machine and the room is on a relay somewhere else — a stage
   * that built this out of its own `location.origin` would put a loopback
   * address on a wall and ask forty people to type it in.
   */
  joinUrl?: string;
  phase: 'lobby' | 'running' | 'paused' | 'finished';
  /** Monotonic. A higher beat from the server always wins over local playback. */
  beat: number;
  scenario: PublicScenario;
  beatInfo: SnapshotBeat;
  /** Resolved scene media for the active scene, if any. */
  scene?: {
    id: string;
    background?: string;
    video?: string;
    music?: string;
    ambience?: string;
  };
  /** Live tally while a poll is open. */
  tally?: { counts: Record<string, number>; voters: number };
  /** Revealed once a poll closes, for the display's result animation. */
  /**
   * Every poll this show has decided, oldest first. Absent until the first.
   *
   * On the snapshot rather than fetched, because a board window opened halfway
   * through a show is exactly the one somebody opens to find out what has
   * happened so far — and a history each window accumulated from the messages
   * it happened to see would be a different history in every window.
   *
   * The stage never reads it. It rides here anyway rather than on a route of
   * its own, so there is one channel by which anything learns what the show is
   * doing: a second one is a second thing to keep in step with `apply`.
   */
  polls?: PollRecord[];
  lastResult?: {
    nodeId: string;
    winner: string;
    winnerLabel: string;
    counts: Record<string, number>;
    total: number;
    usedDefault: boolean;
    usedTiebreak: boolean;
  };
  /** Server wall clock at send time, so clients can correct for drift. */
  serverNow: number;
  /** Connected counts, shown on the board. */
  presence: { displays: number; players: number };
  /** Whether the display has finished prefetching assets. */
  displayReady: boolean;
  /**
   * Whether the projector window is allowed to make a sound yet.
   *
   * False until somebody has touched that window, and a show started in that
   * state reads every line in silence. The board keeps Start behind this and
   * says which window needs the click — see `DisplayAudioSchema` for the
   * failure it exists for.
   */
  audioUnlocked: boolean;
  /**
   * How far it has got, while it has not. Absent once it is ready, and absent
   * before the first report — which is itself worth showing as "connected,
   * nothing said yet" rather than as a stalled zero.
   */
  displayLoading?: DisplayLoading;
  /** Assets the display could not fetch, out of how many. Absent when none. */
  displayMissing?: { failed: number; total: number };
};

export type DisplayLoading = {
  done: number;
  total: number;
  failed: number;
  bytes?: number;
  totalBytes?: number;
};

type ServerError = {
  type: 'error';
  code: 'badRoom' | 'badToken' | 'badMessage' | 'rateLimited' | 'roomClosed' | 'internal';
  message: string;
  /** True when the connection is about to close. */
  fatal: boolean;
};

type Pong = { type: 'pong'; serverNow: number };

export type ServerMessage = Snapshot | ServerError | Pong;

/** Safe JSON parse + validate for an inbound frame. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  if (raw.length > 8192) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = ClientMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}
